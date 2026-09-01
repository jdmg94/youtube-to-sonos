"""Philips Hue: discovery, pairing, CLIP v2 REST, and the Entertainment stream.

Imported by app.py, which owns the HTTP surface under /api/hue. Nothing here
imports app.py — call `set_state_path()` once at startup to say where
credentials live, so this module does not have to re-derive CACHE_DIR and drift
from it.

Design notes for the two non-obvious parts:

**The PSK profile is discovered, not hardcoded.** The two reference
implementations disagree about what a bridge wants as its DTLS-PSK identity and
ciphersuite — hue-sync sends the application key with AES-128, and
hue-entertainment-pykit sends the hue-application-id with AES-256 — and both are
in production use. Rather than pick a side, `HueSession` tries the combinations
in order and persists whichever one completed a handshake, so the next start is
a single attempt. spike_hue_dtls.py answers the same question interactively;
this makes the answer a cached fact rather than a constant we could get wrong.

**The writer thread always sends.** The bridge drops a stream that goes silent
for about ten seconds. Rather than bolt a keepalive timer onto a change-driven
sender, the writer emits the current colour state every frame interval, which is
what the protocol expects anyway and makes keepalive fall out for free.
"""

import json
import logging
import os
import socket
import struct
import threading
import time

import requests
import urllib3
from mbedtls.tls import (ClientContext, DTLSConfiguration, HandshakeStep,
                         TLSWrappedSocket, WantReadError, WantWriteError)

logger = logging.getLogger(__name__)

# The bridge presents a self-signed, per-bridge certificate whose CN is the
# bridge id, and requests connects by IP. Verifying it properly means resolving
# the bridge id to the IP purely for TLS's benefit — the DNS monkey-patch
# hue-sync carries. We do what hue-entertainment-pykit does instead and skip
# verification on a LAN-local address, which is why this warning is noise.
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

DEVICETYPE = os.environ.get('HUE_DEVICETYPE', 'youtube-sonos#server')
UDP_PORT = 2100
HTTP_TIMEOUT = float(os.environ.get('HUE_HTTP_TIMEOUT', 10))
DISCOVER_TIMEOUT = float(os.environ.get('HUE_DISCOVER_TIMEOUT', 5))
# 25 Hz. The Entertainment API tolerates up to 50, but every frame is a UDP
# datagram to a small embedded device and 25 is what Philips' own guidance
# recommends; beat-driven colour has nothing to say at 20 ms resolution anyway.
FRAME_HZ = float(os.environ.get('HUE_FRAME_HZ', 25))
FRAME_INTERVAL = 1.0 / FRAME_HZ
HANDSHAKE_TIMEOUT = float(os.environ.get('HUE_HANDSHAKE_TIMEOUT', 5))
# How long to keep polling POST /api while the user walks to the bridge.
PAIR_WINDOW = float(os.environ.get('HUE_PAIR_WINDOW', 60))
PAIR_POLL_INTERVAL = 2.0

# Tried in order; the first that completes a handshake is remembered. Identity
# names refer to keys of the stored credentials.
PSK_PROFILES = [
    # Philips' own Entertainment documentation says the identity is the
    # application key ("username"), which is also what hue-sync sends.
    ('username', 'TLS-PSK-WITH-AES-128-GCM-SHA256'),
    # What hue-entertainment-pykit sends, and it demonstrably works for its
    # users, so a bridge somewhere accepts this.
    ('application_id', 'TLS-PSK-WITH-AES-256-GCM-SHA384'),
    ('username', 'TLS-PSK-WITH-AES-256-GCM-SHA384'),
    ('application_id', 'TLS-PSK-WITH-AES-128-GCM-SHA256'),
]

_STATE_PATH = None
_STATE_LOCK = threading.Lock()


class HueError(Exception):
    """A Hue failure with an HTTP status the API layer can hand straight back."""

    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


class LinkButtonNotPressed(HueError):
    """Pairing is waiting on the physical button. Retryable, not a failure."""

    def __init__(self, message="Press the link button on the bridge"):
        super().__init__(message, status=428)


# --- credential state --------------------------------------------------------

def set_state_path(path):
    """Where credentials live. Called once by app.py with CACHE_DIR/hue.json."""
    global _STATE_PATH
    _STATE_PATH = path


def load_state():
    """The stored bridge credentials, or {}. Never raises."""
    if not _STATE_PATH:
        return {}
    try:
        with open(_STATE_PATH) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def save_state(state):
    """Persist credentials, 0600. The client key is a shared secret for the
    bridge's DTLS stream — anyone holding it can drive the lights."""
    if not _STATE_PATH:
        raise HueError("Hue state path not configured", status=500)
    tmp = _STATE_PATH + '.tmp'
    os.makedirs(os.path.dirname(_STATE_PATH), exist_ok=True)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as fh:
        json.dump(state, fh)
    os.replace(tmp, _STATE_PATH)
    return state


def update_state(**fields):
    with _STATE_LOCK:
        return save_state({**load_state(), **fields})


def is_paired():
    state = load_state()
    return bool(state.get('ip') and state.get('username') and
                state.get('clientkey'))


# --- discovery ---------------------------------------------------------------

def _discover_mdns(timeout):
    """Browse _hue._tcp.local. Needs host networking — multicast does not cross
    a network namespace, which is the same constraint SSDP already puts on this
    container, so nothing new for deployment."""
    from zeroconf import ServiceBrowser, ServiceListener, Zeroconf

    found = {}

    class _Listener(ServiceListener):
        def add_service(self, zc, type_, name):
            info = zc.get_service_info(type_, name, timeout=int(timeout * 1000))
            if not info:
                return
            props = {k.decode(): (v or b'').decode()
                     for k, v in (info.properties or {}).items()
                     if isinstance(k, bytes)}
            for addr in info.parsed_addresses():
                if ':' in addr:          # skip IPv6; the CLIP API is v4-only
                    continue
                found[addr] = {
                    'ip': addr,
                    'id': props.get('bridgeid', '').lower() or None,
                    'name': info.server.rstrip('.') if info.server else None,
                    'source': 'mdns',
                }

        def update_service(self, zc, type_, name):
            pass

        def remove_service(self, zc, type_, name):
            pass

    zc = Zeroconf()
    try:
        ServiceBrowser(zc, '_hue._tcp.local.', _Listener())
        time.sleep(timeout)
    finally:
        zc.close()
    return list(found.values())


def _discover_cloud():
    """Philips' discovery endpoint, which matches on the caller's public IP.
    Only reached when mDNS finds nothing, because it requires internet access
    and tells a stranger's NAT about your bridge."""
    r = requests.get('https://discovery.meethue.com/', timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    return [{'ip': e.get('internalipaddress'), 'id': (e.get('id') or '').lower(),
             'name': None, 'source': 'cloud'}
            for e in r.json() if e.get('internalipaddress')]


def discover(timeout=None):
    """Bridges on the network. mDNS first, cloud as a fallback, never raises
    for a failure of one source alone."""
    timeout = DISCOVER_TIMEOUT if timeout is None else timeout
    bridges = []
    try:
        bridges = _discover_mdns(timeout)
    except Exception as e:
        logger.warning(f"Hue mDNS discovery failed: {e}")
    if bridges:
        return bridges
    try:
        return _discover_cloud()
    except Exception as e:
        logger.warning(f"Hue cloud discovery failed: {e}")
        return []


# --- pairing -----------------------------------------------------------------

def pair(ip, devicetype=None):
    """One attempt at the link-button flow.

    Raises LinkButtonNotPressed (428) rather than failing, so the caller can
    poll while the user walks to the bridge. `generateclientkey` is what
    produces the DTLS pre-shared key; without it the Entertainment stream is
    impossible and the only fix is to pair again.
    """
    try:
        r = requests.post(f"http://{ip}/api",
                          json={'devicetype': devicetype or DEVICETYPE,
                                'generateclientkey': True},
                          timeout=HTTP_TIMEOUT)
        body = r.json()
    except requests.RequestException as e:
        raise HueError(f"Could not reach bridge at {ip}: {e}") from e
    except ValueError as e:
        raise HueError(f"Bridge at {ip} did not return JSON") from e

    if not isinstance(body, list) or not body:
        raise HueError(f"Unexpected pairing response from {ip}: {body!r}")
    entry = body[0]
    if 'success' in entry:
        credentials = entry['success']
        state = {
            'ip': ip,
            'username': credentials['username'],
            # A bridge that ignored generateclientkey leaves this out, and the
            # failure would otherwise surface much later as a DTLS handshake
            # that never works.
            'clientkey': credentials.get('clientkey'),
        }
        if not state['clientkey']:
            raise HueError("Bridge paired but returned no client key; the "
                           "Entertainment stream needs one. Update the bridge "
                           "firmware and pair again.")
        state['application_id'] = _fetch_application_id(ip, state['username'])
        state['id'] = _fetch_bridge_id(ip, state['username'])
        return update_state(**state)

    error = entry.get('error') or {}
    if error.get('type') == 101:
        raise LinkButtonNotPressed()
    raise HueError(f"Pairing rejected: {error.get('description') or error}")


def pair_blocking(ip, window=None, devicetype=None):
    """Poll `pair` for `window` seconds. For a client that would rather hold one
    request open than poll itself."""
    deadline = time.time() + (PAIR_WINDOW if window is None else window)
    while True:
        try:
            return pair(ip, devicetype)
        except LinkButtonNotPressed:
            if time.time() >= deadline:
                raise
            time.sleep(PAIR_POLL_INTERVAL)


def _fetch_application_id(ip, username):
    """The second PSK identity candidate. It arrives in a response *header*, so
    a bridge too old to send it just yields None and PSK_PROFILES skips the
    entries that need it."""
    try:
        r = requests.get(f"https://{ip}/auth/v1",
                         headers={'hue-application-key': username},
                         verify=False, timeout=HTTP_TIMEOUT)
        return r.headers.get('hue-application-id')
    except requests.RequestException as e:
        logger.warning(f"Could not read hue-application-id from {ip}: {e}")
        return None


def _fetch_bridge_id(ip, username):
    try:
        r = requests.get(f"https://{ip}/clip/v2/resource/bridge",
                         headers={'hue-application-key': username},
                         verify=False, timeout=HTTP_TIMEOUT)
        data = (r.json().get('data') or [{}])[0]
        return data.get('bridge_id')
    except (requests.RequestException, ValueError, AttributeError):
        return None


# --- CLIP v2 -----------------------------------------------------------------

class BridgeClient:
    """CLIP v2 REST against one bridge."""

    def __init__(self, ip, username):
        self.ip = ip
        self.username = username
        self._session = requests.Session()
        self._session.headers['hue-application-key'] = username
        self._session.verify = False

    @classmethod
    def from_state(cls):
        state = load_state()
        if not (state.get('ip') and state.get('username')):
            raise HueError("No Hue bridge paired yet", status=409)
        return cls(state['ip'], state['username'])

    def request(self, method, path, **kw):
        url = f"https://{self.ip}/clip/v2/resource/{path}"
        try:
            r = self._session.request(method, url, timeout=HTTP_TIMEOUT, **kw)
        except requests.RequestException as e:
            raise HueError(f"Bridge at {self.ip} unreachable: {e}") from e
        if r.status_code == 401 or r.status_code == 403:
            raise HueError("Bridge rejected our application key; pair again",
                           status=401)
        try:
            body = r.json()
        except ValueError as e:
            raise HueError(f"Bridge returned non-JSON ({r.status_code})") from e
        errors = body.get('errors') if isinstance(body, dict) else None
        if errors:
            raise HueError('; '.join(e.get('description', str(e))
                                     for e in errors))
        if not r.ok:
            raise HueError(f"Bridge returned {r.status_code} for {path}")
        return body

    def get(self, path):
        return self.request('get', path).get('data', [])

    def put(self, path, payload):
        return self.request('put', path, json=payload)

    # -- resources

    def lights(self):
        return [{
            'id': it['id'],
            'name': (it.get('metadata') or {}).get('name'),
            'archetype': (it.get('metadata') or {}).get('archetype'),
            'on': (it.get('on') or {}).get('on'),
            'brightness': (it.get('dimming') or {}).get('brightness'),
            'owner': (it.get('owner') or {}).get('rid'),
        } for it in self.get('light')]

    def groups(self):
        """Rooms and zones, each carrying the grouped_light that controls it.

        Rooms and zones are separate resource types with identical shape, and a
        UI has no reason to care which is which beyond a label — so they are
        merged here rather than making every caller fetch both.
        """
        out = []
        for kind in ('room', 'zone'):
            for it in self.get(kind):
                services = it.get('services') or []
                grouped = next((s['rid'] for s in services
                                if s.get('rtype') == 'grouped_light'), None)
                out.append({
                    'id': it['id'],
                    'kind': kind,
                    'name': (it.get('metadata') or {}).get('name'),
                    'grouped_light': grouped,
                    'children': [c['rid'] for c in (it.get('children') or [])],
                })
        return out

    def areas(self):
        """Entertainment configurations — the only thing that can be streamed to."""
        return [{
            'id': it['id'],
            'name': (it.get('metadata') or {}).get('name'),
            'status': it.get('status'),
            'channels': [c['channel_id'] for c in (it.get('channels') or [])],
            'positions': {c['channel_id']: c.get('position')
                          for c in (it.get('channels') or [])},
        } for it in self.get('entertainment_configuration')]

    def set_area_action(self, area_id, action):
        return self.put(f"entertainment_configuration/{area_id}",
                        {'action': action})


# --- the Entertainment stream ------------------------------------------------

class _RetryingSocket(TLSWrappedSocket):
    """TLSWrappedSocket with ClientHello retransmission.

    DTLS runs on UDP, so the first flight is routinely lost and mbedtls' own
    retransmission timer is slower than a user waiting for lights will tolerate.
    hue-entertainment-pykit had to add exactly this; it is the one piece of that
    library worth borrowing.
    """

    MAX_RETRIES = 3
    RETRY_DELAY = 0.3

    def do_handshake(self, *args):
        retries = 0
        while self._handshake_state is not HandshakeStep.HANDSHAKE_OVER:
            try:
                self._buffer.do_handshake()
            except WantReadError:
                self._buffer.receive_from_network(
                    self._socket.recv(TLSWrappedSocket.CHUNK_SIZE))
            except WantWriteError as exc:
                outgoing = self._buffer.peek_outgoing(
                    TLSWrappedSocket.CHUNK_SIZE)
                self._buffer.consume_outgoing(self._socket.send(outgoing))
                retries += 1
                if retries < self.MAX_RETRIES:
                    time.sleep(self.RETRY_DELAY)
                    self._buffer.consume_outgoing(self._socket.send(outgoing))
                elif retries > self.MAX_RETRIES:
                    raise HueError("DTLS handshake timed out") from exc


def build_frame(area_id, channels, colors, sequence=0):
    """One HueStream v2 datagram carrying every channel.

    `colors` maps channel id to an 8-bit (r, g, b); channels missing from it go
    black. Values are scaled to the full 16-bit range rather than duplicated
    byte-wise as hue-sync does, which is a lossy approximation of the same
    thing.
    """
    message = bytearray(b'HueStream')
    message += bytes([0x02, 0x00])          # protocol version 2.0
    message += bytes([sequence & 0xFF])
    message += b'\x00\x00'                  # reserved
    message += b'\x00'                      # colour space: RGB
    message += b'\x00'                      # reserved
    message += area_id.encode('utf-8')
    for channel in channels:
        r, g, b = colors.get(channel, (0, 0, 0))
        message += struct.pack('>BHHH', channel & 0xFF,
                               r * 257, g * 257, b * 257)
    return bytes(message)


class HueSession:
    """A live Entertainment stream to one area.

    Restartable by design: threads and sockets are owned by `start()`, not by
    `__init__`. hue-entertainment-pykit builds its threads in the constructor,
    so a second `start_stream()` raises and every track change would need a
    fresh object graph.
    """

    def __init__(self, client, area_id, channels):
        self.client = client
        self.area_id = area_id
        self.channels = list(channels)
        self.profile = None

        self._socket = None
        self._thread = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        # Latest-wins, not a queue. A backed-up FIFO plays the light show late,
        # and a late light show is worse than a dropped frame because the error
        # never recovers.
        self._colors = {}
        self._sequence = 0
        self.error = None

    # -- lifecycle

    def is_active(self):
        return self._thread is not None and self._thread.is_alive()

    def start(self):
        if self.is_active():
            return self
        self._stop.clear()
        self.error = None
        self.client.set_area_action(self.area_id, 'start')
        try:
            self._socket, self.profile = self._connect()
        except Exception:
            # Leaving the bridge in "streaming" with nobody streaming locks the
            # area out of normal control until it times out.
            self._safe_area_action('stop')
            raise
        self._thread = threading.Thread(target=self._writer,
                                        name=f"hue-{self.area_id[:8]}",
                                        daemon=True)
        self._thread.start()
        return self

    def stop(self):
        self._stop.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout=2)
        if self._socket is not None:
            try:
                self._socket.close()
            except Exception:
                pass
            self._socket = None
        self._safe_area_action('stop')

    def _safe_area_action(self, action):
        try:
            self.client.set_area_action(self.area_id, action)
        except Exception as e:
            logger.warning(f"Hue area {self.area_id} {action} failed: {e}")

    # -- colour

    def set_color(self, color):
        """Uniform (r, g, b) across the area, or a {channel_id: (r,g,b)} map."""
        if isinstance(color, dict):
            # JSON object keys are always strings, so channel ids arrive as
            # "0", "1". int() on a key that isn't one is the caller's error.
            try:
                channels = {k: int(k) for k in color}
            except (TypeError, ValueError) as e:
                raise HueError(f"Channel ids must be integers, got "
                               f"{list(color)!r}", status=400) from e
            colors = {channels[k]: _clamp_rgb(v) for k, v in color.items()}
        else:
            rgb = _clamp_rgb(color)
            colors = {c: rgb for c in self.channels}
        with self._lock:
            self._colors = colors

    # -- internals

    def _psk_candidates(self):
        """Stored winner first, then the rest. The stored profile is a cache,
        not a constant, so a bridge firmware change that invalidates it costs
        one extra handshake rather than a support ticket."""
        state = load_state()
        profiles = [tuple(p) for p in PSK_PROFILES]
        remembered = state.get('psk_profile')
        if remembered is not None and tuple(remembered) in profiles:
            profiles.remove(tuple(remembered))
            profiles.insert(0, tuple(remembered))
        for identity_key, cipher in profiles:
            identity = state.get(identity_key)
            if identity:
                yield identity_key, identity, cipher, state.get('clientkey')

    def _connect(self):
        last = None
        for identity_key, identity, cipher, clientkey in self._psk_candidates():
            if not clientkey:
                raise HueError("No Hue client key stored; pair again",
                               status=409)
            try:
                sock = self._handshake(identity, clientkey, cipher)
            except Exception as e:
                last = e
                logger.info(f"Hue DTLS handshake failed with "
                            f"{identity_key}/{cipher}: {e}")
                continue
            profile = [identity_key, cipher]
            update_state(psk_profile=profile)
            logger.info(f"Hue DTLS connected using {identity_key}/{cipher}")
            return sock, profile
        raise HueError(f"DTLS handshake failed for every PSK profile: {last}")

    def _handshake(self, identity, clientkey, cipher):
        config = DTLSConfiguration(
            pre_shared_key=(identity, bytes.fromhex(clientkey)),
            ciphers=(cipher,),
        )
        udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        udp.settimeout(HANDSHAKE_TIMEOUT)
        udp.connect((self.client.ip, UDP_PORT))
        buffer = ClientContext(config).wrap_buffers(
            server_hostname=self.client.ip)
        sock = _RetryingSocket(udp, buffer)
        try:
            sock.do_handshake()
        except Exception:
            try:
                sock.close()
            except Exception:
                pass
            raise
        return sock

    def _writer(self):
        """Emit the current colour state every frame interval.

        Always sending — rather than sending on change plus a keepalive timer —
        is both what the protocol expects and how the ~10s idle timeout stops
        being a separate thing to get right.
        """
        # Bound once. `stop()` joins with a timeout and then clears
        # self._socket, so a writer that outlived the join would otherwise
        # raise AttributeError on None — reporting "closed while we were
        # sending" as if it were a bug in this loop. Holding the reference
        # makes it fail as the socket error it actually is.
        sock = self._socket
        next_frame = time.monotonic()
        while not self._stop.is_set():
            with self._lock:
                colors = self._colors
                self._sequence = (self._sequence + 1) & 0xFF
                sequence = self._sequence
            try:
                sock.send(
                    build_frame(self.area_id, self.channels, colors, sequence))
            except Exception as e:
                self.error = str(e)
                logger.error(f"Hue stream to {self.area_id} died: {e}")
                break
            next_frame += FRAME_INTERVAL
            delay = next_frame - time.monotonic()
            if delay < 0:
                # Fell behind (a long GC, a stalled send). Re-anchor instead of
                # spinning to catch up, which would burst datagrams at the
                # bridge for no visual benefit.
                next_frame = time.monotonic()
            else:
                self._stop.wait(delay)


def _clamp_rgb(color):
    """An 8-bit (r, g, b) from client-supplied JSON.

    Raises a 400 rather than letting a bare ValueError escape: colours arrive
    straight off a request body, and "[255, 0]" is the caller's mistake, not
    ours. Out-of-range *numbers* are clamped instead — a render loop
    overshooting to 260 wants the brightest red, not a failed frame.
    """
    try:
        r, g, b = color
        return (max(0, min(255, int(r))),
                max(0, min(255, int(g))),
                max(0, min(255, int(b))))
    except (TypeError, ValueError) as e:
        raise HueError(f"Expected an [r, g, b] colour, got {color!r}",
                       status=400) from e
