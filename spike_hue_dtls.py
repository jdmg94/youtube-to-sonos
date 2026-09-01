#!/usr/bin/env python3
"""THROWAWAY. Milestone 0 of docs/superpowers/specs/2026-08-31-hue-support-design.md.

Settles one question that cannot be answered by reading source: what does a Hue
bridge actually want as the DTLS-PSK identity, and which ciphersuite does it
negotiate?

Two reference implementations disagree, and both are in real use:

    hue-sync (JS)              identity = username (the application key)
                               cipher   = TLS_PSK_WITH_AES_128_GCM_SHA256

    hue-entertainment-pykit    identity = hue-application-id
                               cipher   = TLS-PSK-WITH-AES-256-GCM-SHA384

One of them may simply be carrying a bug the bridge is lenient about. This walks
all four combinations against the real hardware and reports which handshake.

Run it, watch the lights, then delete this file. Nothing imports it.

    make run-local  # once, to build .venv
    .venv/bin/python spike_hue_dtls.py

Environment:
    HUE_BRIDGE_IP     skip discovery
    HUE_APP_KEY       skip pairing (with HUE_CLIENT_KEY)
    HUE_CLIENT_KEY
    HUE_APP_ID        skip the /auth/v1 lookup
"""

import json
import os
import socket
import struct
import sys
import time
import urllib3

import requests
from mbedtls.tls import ClientContext, DTLSConfiguration

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

DEVICETYPE = 'youtube-sonos#spike'
UDP_PORT = 2100


def log(msg):
    print(msg, flush=True)


# --- discovery ---------------------------------------------------------------

def discover_bridge():
    """mDNS first, cloud second. Same order the real module will use."""
    ip = os.environ.get('HUE_BRIDGE_IP')
    if ip:
        log(f"Using HUE_BRIDGE_IP={ip}")
        return ip

    log("Browsing mDNS for _hue._tcp.local (5s)...")
    found = []
    try:
        from zeroconf import ServiceBrowser, ServiceListener, Zeroconf

        class Listener(ServiceListener):
            def add_service(self, zc, type_, name):
                info = zc.get_service_info(type_, name, timeout=2000)
                for addr in (info.parsed_addresses() if info else []):
                    if ':' not in addr:
                        found.append(addr)

            def update_service(self, zc, type_, name):
                pass

            def remove_service(self, zc, type_, name):
                pass

        zc = Zeroconf()
        try:
            ServiceBrowser(zc, '_hue._tcp.local.', Listener())
            time.sleep(5)
        finally:
            zc.close()
    except Exception as e:
        log(f"  mDNS failed: {e}")

    if found:
        log(f"  mDNS found {found}")
        return found[0]

    log("Falling back to https://discovery.meethue.com/ ...")
    r = requests.get('https://discovery.meethue.com/', timeout=10)
    r.raise_for_status()
    entries = r.json()
    if not entries:
        sys.exit("No bridge found. Set HUE_BRIDGE_IP and try again.")
    ip = entries[0]['internalipaddress']
    log(f"  cloud found {ip}")
    return ip


# --- pairing -----------------------------------------------------------------

def pair(ip):
    """The link-button flow. Polls through error 101 rather than failing once."""
    key, clientkey = os.environ.get('HUE_APP_KEY'), os.environ.get('HUE_CLIENT_KEY')
    if key and clientkey:
        log("Using HUE_APP_KEY / HUE_CLIENT_KEY from the environment")
        return key, clientkey

    log("\n>>> PRESS THE LINK BUTTON ON THE BRIDGE NOW <<<\n")
    deadline = time.time() + 60
    while time.time() < deadline:
        r = requests.post(f"http://{ip}/api",
                          json={'devicetype': DEVICETYPE, 'generateclientkey': True},
                          timeout=10)
        body = r.json()[0]
        if 'success' in body:
            s = body['success']
            log(f"Paired. username={s['username']} clientkey={s['clientkey']}")
            log("Re-run with these to skip pairing:")
            log(f"  export HUE_APP_KEY={s['username']}")
            log(f"  export HUE_CLIENT_KEY={s['clientkey']}")
            return s['username'], s['clientkey']
        err = body.get('error', {})
        if err.get('type') != 101:
            sys.exit(f"Pairing failed: {err}")
        time.sleep(2)
    sys.exit("Timed out waiting for the link button.")


def application_id(ip, app_key):
    """The other identity candidate, from a response *header*."""
    app_id = os.environ.get('HUE_APP_ID')
    if app_id:
        return app_id
    r = requests.get(f"https://{ip}/auth/v1",
                     headers={'hue-application-key': app_key},
                     verify=False, timeout=10)
    app_id = r.headers.get('hue-application-id')
    log(f"hue-application-id = {app_id!r}  (status {r.status_code})")
    return app_id


# --- entertainment configuration ---------------------------------------------

def clip(ip, app_key, path, method='get', **kw):
    r = requests.request(method, f"https://{ip}/clip/v2/resource/{path}",
                         headers={'hue-application-key': app_key},
                         verify=False, timeout=10, **kw)
    r.raise_for_status()
    return r.json()


def pick_area(ip, app_key):
    data = clip(ip, app_key, 'entertainment_configuration')['data']
    if not data:
        sys.exit("No entertainment configuration on this bridge. Create one in "
                 "the Hue app (Settings -> Entertainment areas).")
    for area in data:
        log(f"  area {area['id']} {area['metadata']['name']!r} "
            f"channels={len(area.get('channels', []))}")
    return data[0]


# --- the actual question -----------------------------------------------------

def build_frame(area_id, channels, rgb):
    """HueStream v2. One datagram, every channel, 16-bit colour.

    Note the >HHH: hue-sync duplicates each 8-bit value into both bytes, which
    is a lossy approximation of this.
    """
    r, g, b = (v * 257 for v in rgb)          # 8-bit -> full 16-bit range
    msg = (b'HueStream'
           + bytes([0x02, 0x00])              # version 2.0
           + bytes([0x00])                    # sequence id
           + b'\x00\x00'                      # reserved
           + bytes([0x00])                    # colour space: RGB
           + b'\x00'                          # reserved
           + area_id.encode('utf-8'))
    for ch in channels:
        msg += struct.pack('>BHHH', ch, r, g, b)
    return msg


def try_handshake(ip, identity, psk_hex, cipher, label):
    """Returns (ok, detail). Never raises."""
    log(f"\n--- {label}")
    log(f"    identity = {identity!r}")
    log(f"    cipher   = {cipher}")
    sock = None
    try:
        config = DTLSConfiguration(
            pre_shared_key=(identity, bytes.fromhex(psk_hex)),
            ciphers=(cipher,),
        )
        udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        udp.settimeout(5)
        udp.connect((ip, UDP_PORT))
        sock = ClientContext(config).wrap_buffers(server_hostname=ip)
        sock = _wrap(udp, sock)
        started = time.time()
        sock.do_handshake()
        log(f"    HANDSHAKE OK in {time.time() - started:.2f}s")
        return True, sock
    except Exception as e:
        log(f"    failed: {type(e).__name__}: {e}")
        if sock is not None:
            try:
                sock.close()
            except Exception:
                pass
        return False, str(e)


def _wrap(udp, buffer):
    """python-mbedtls's own TLSWrappedSocket, plus the ClientHello retry that
    hue-entertainment-pykit had to add (network/dtls.py:180). Without it the
    first datagram is routinely lost and the handshake never completes."""
    from mbedtls._tls import HandshakeStep, WantReadError, WantWriteError
    from mbedtls.tls import TLSWrappedSocket

    class Retrying(TLSWrappedSocket):
        def do_handshake(self, *args):
            retries = 0
            while self._handshake_state is not HandshakeStep.HANDSHAKE_OVER:
                try:
                    self._buffer.do_handshake()
                except WantReadError:
                    self._buffer.receive_from_network(
                        self._socket.recv(TLSWrappedSocket.CHUNK_SIZE))
                except WantWriteError as exc:
                    out = self._buffer.peek_outgoing(TLSWrappedSocket.CHUNK_SIZE)
                    self._buffer.consume_outgoing(self._socket.send(out))
                    retries += 1
                    if retries < 3:
                        time.sleep(0.3)
                        self._buffer.consume_outgoing(self._socket.send(out))
                    elif retries > 3:
                        raise TimeoutError("max handshake retries") from exc

    return Retrying(udp, buffer)


def flash(sock, area_id, channels):
    """Prove the handshake is not just a handshake: make the lights move."""
    log("    flashing red / green / blue, 2s each...")
    for rgb in ((255, 0, 0), (0, 255, 0), (0, 0, 255)):
        frame = build_frame(area_id, channels, rgb)
        end = time.time() + 2
        while time.time() < end:
            sock.send(frame)
            time.sleep(0.04)          # 25 Hz
    log("    done")


def main():
    ip = discover_bridge()
    app_key, client_key = pair(ip)
    app_id = application_id(ip, app_key)

    area = pick_area(ip, app_key)
    area_id = area['id']
    channels = [c['channel_id'] for c in area.get('channels', [])] or [0]
    log(f"\nUsing area {area_id} ({area['metadata']['name']!r}), "
        f"channels {channels}")

    candidates = [
        (app_key, 'TLS-PSK-WITH-AES-128-GCM-SHA256', 'hue-sync: username + AES128'),
        (app_key, 'TLS-PSK-WITH-AES-256-GCM-SHA384', 'username + AES256'),
        (app_id, 'TLS-PSK-WITH-AES-256-GCM-SHA384', 'pykit: application-id + AES256'),
        (app_id, 'TLS-PSK-WITH-AES-128-GCM-SHA256', 'application-id + AES128'),
    ]

    results = []
    for identity, cipher, label in candidates:
        if not identity:
            log(f"\n--- {label}: SKIPPED (no identity)")
            results.append((label, 'skipped'))
            continue

        clip(ip, app_key, f'entertainment_configuration/{area_id}',
             method='put', json={'action': 'start'})
        time.sleep(0.5)

        ok, sock = try_handshake(ip, identity, client_key, cipher, label)
        if ok:
            try:
                flash(sock, area_id, channels)
                results.append((label, 'OK'))
            finally:
                try:
                    sock.close()
                except Exception:
                    pass
        else:
            results.append((label, 'failed'))

        clip(ip, app_key, f'entertainment_configuration/{area_id}',
             method='put', json={'action': 'stop'})
        time.sleep(1)

    log("\n" + "=" * 60)
    log("VERDICT — record this in the design doc:")
    for label, outcome in results:
        log(f"  {outcome:>8}  {label}")
    log("=" * 60)
    log(json.dumps({'bridge': ip, 'area': area_id, 'channels': channels,
                    'results': dict(results)}, indent=2))


if __name__ == '__main__':
    main()
