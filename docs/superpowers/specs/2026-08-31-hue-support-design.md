# Philips Hue support — design

Status: **approved, not yet implemented**
Branch: `feat-hue-support`
Date: 2026-08-31

## Goal

Discover, pair with, and stream to a Philips Hue bridge, so the lights react to
the music the Sonos speakers are playing. Also list lights, rooms and zones, so
the user can see what the bridge knows about.

Colours are driven by **real audio analysis** of the track we already have on
disk, not by a synthetic pattern. That single decision is what shapes the rest
of this document.

## Where this lives, and why it is not in Next

The original request was Next.js API routes using
[`hue-sync`](https://github.com/jdmg94/hue-sync). It is implemented in the
**Flask backend** instead. Four independent reasons, in descending order of
force:

1. **Real audio analysis lives where the audio is.** The decoded mp3, the
   station cursor, the playback clock, and a writable persistent mount
   (`CACHE_DIR`) are all already in the Flask process. Hosting the light stream
   in Next would put a network hop in the one path where latency is the whole
   product.
2. **`/api/*` is rewritten to Flask in `beforeFiles`.** `web/next.config.ts`
   sends `/api/:path*` to `API_ORIGIN` *before* the filesystem is consulted, so
   a route handler at `web/src/app/api/hue/*` would be **silently shadowed** —
   it would build, typecheck and lint clean, and 404 through the proxy at
   runtime. The config comment says this is deliberate: the backend is
   authoritative for `/api` by construction. Serving Hue from Flask means
   **`next.config.ts` is not touched at all**.
3. **The web container writes nothing to disk** (`web/Dockerfile`, and the
   comment in it says so). Bridge credentials need a persistent mount. Flask
   already has `./cache`.
4. **`hue-sync` does not currently work on this stack.** See the appendix — this
   is a real finding, not a preference.

Consequences for earlier decisions, stated so they are not silent:

| Earlier answer | Now | Why |
|---|---|---|
| Install `hue-sync` from a git URL | dropped | no JS dependency at all |
| New volume on the `web` service | dropped | `./cache` is already mounted on the API |
| Serve Hue under `/hue/*` | `/api/hue/*` | rides the existing rewrite, zero config |

## Dependencies

Added to `requirements.txt`:

```
python-mbedtls>=2.10.1,<3
zeroconf>=0.148.0
librosa>=1.0.0
```

`requests` already arrives transitively via `soco`.

### Python 3.12 is pinned by intersection, not preference

- `python-mbedtls` 2.10.1 ships wheels for `cp38`–`cp312` only. No `cp313`.
- `librosa` 1.0.0 declares `requires_python >=3.12`.

Exactly one version satisfies both. **Fedora 40**, the `Containerfile` base,
ships Python 3.12 — no change needed there.

The local machine is Python 3.14.7, and `Makefile`'s `run-local` currently runs
a bare `uv venv`, which takes whatever `uv` defaults to. That silently gets 3.14
and fails at `import mbedtls`. It becomes:

```make
run-local:
	uv venv --python 3.12 && . .venv/bin/activate && ...
```

### Why we do not depend on `hue-entertainment-pykit`

It was evaluated properly (source read in full at `0.9.4`) and rejected as a
*dependency*. Four disqualifiers, none of them patchable from outside:

1. **No lights or groups.** Its entire public surface is `Discovery`,
   `Entertainment`, `Streaming`. It exposes only *entertainment configurations*
   — there is no `light`, `grouped_light`, `room` or `zone` anywhere in it. Half
   the requirement is simply absent.
2. **Pairing is private and owns its own state.**
   `BridgeRepository._register_app_and_fetch_username_client_key()` is implicit
   inside discovery and persists credentials through its own `FileHandler`
   singleton. There is no link-button flow a UI can drive, and it would mean a
   second credential store competing with `CACHE_DIR`.
3. **One UDP datagram per light.** `StreamingService._send_color_to_light`
   builds and sends a complete HueStream message for a *single* channel. At
   25 Hz across 8 channels that is 200 datagrams/second where the protocol wants
   25. Its `_sequence_id` is also a hardcoded constant that never increments.
4. **Not restartable.** Both worker threads are constructed in `__init__` and
   joined in `stop_stream()`; a second `start_stream()` raises `RuntimeError`.
   Every track change would need a fresh object graph.

It is an excellent *reference*, and we take two things from it:

- `Dtls.PatchedTLSWrappedSocket.do_handshake()` — the ClientHello retry loop
  around `WantReadError`/`WantWriteError`. This is the genuinely fiddly part of
  DTLS-over-UDP with `python-mbedtls`, and it is worth borrowing rather than
  rediscovering.
- `struct.pack(">HHH", r, g, b)` framing, which is more correct than
  `hue-sync`'s trick of duplicating each 8-bit value into both bytes of the
  16-bit field.

## Milestone 0 — the spike (throwaway)

`hue-sync` and `hue-entertainment-pykit` disagree on the two parameters that
decide whether the DTLS handshake completes at all:

| | PSK identity | ciphersuite |
|---|---|---|
| `hue-sync` | `username` (the application key) | `TLS_PSK_WITH_AES_128_GCM_SHA256` |
| `hue-entertainment-pykit` | `hue-application-id` | `TLS-PSK-WITH-AES-256-GCM-SHA384` |

Both libraries are used in the wild, so both may work — or one may be carrying a
bug nobody noticed because the bridge is lenient. **No amount of source reading
settles this.** A scratch script pairs against the real bridge and walks the
four combinations until a light visibly changes colour.

Nothing else merges until this is answered, and the answer is recorded back into
this document. Everything in Milestone 1 assumes it.

## Milestone 1 — `hue.py`

A new module beside `app.py`, structured so `app.py` gains only thin route
handlers.

### Discovery

`zeroconf` browsing `_hue._tcp.local` → fall back to
`https://discovery.meethue.com/` → accept a manually-entered IP. Same shape as
the existing Sonos discovery, and it needs the same `network_mode: host` that
SSDP already forces on us, so deployment does not change.

### Pairing

The Hue link-button flow, made explicit rather than implicit:

1. `POST http://<ip>/api` with `{"devicetype": "...", "generateclientkey": true}`.
2. While the response is `error.type == 101` ("link button not pressed"), keep
   polling on a bounded schedule. This is what lets the UI say *"press the
   button on the bridge"* and succeed a few seconds later, instead of failing
   once and making the user start over.
3. On success, `GET /auth/v1` and read the `hue-application-id` response header.
4. Persist `{ip, id, username, clientkey, application_id}` to
   `CACHE_DIR/hue.json`, mode `0600`.

### REST (CLIP v2)

`https://<ip>/clip/v2/resource/<type>`, header `hue-application-key: <username>`.

The bridge's certificate is self-signed and per-bridge, so verification is off
with the host pinned — the same posture `hue-entertainment-pykit` takes. Note
that `hue-sync`'s global `dns.lookup` monkey-patch exists purely to work around
Node's TLS stack refusing an IP-addressed HTTPS request; Python needs no
equivalent trick.

Resources surfaced: `light`, `grouped_light`, `room`, `zone`,
`entertainment_configuration`.

### `HueSession` — the stream

- `PUT /clip/v2/resource/entertainment_configuration/<id>` with
  `{"action": "start"}`.
- DTLS-PSK handshake on UDP `2100`, using the retry loop borrowed above.
- **One datagram per frame, carrying every channel.** Not one per light.
- **Latest-wins frame slot**, not a FIFO queue. `hue-entertainment-pykit` uses a
  `queue.Queue`, which means a momentarily backed-up writer plays the light show
  *late* — and a light show that is late is worse than one that dropped a frame,
  because the error never recovers.
- Incrementing sequence id.
- 9.5 s keepalive (the bridge drops a silent stream at ~10 s).
- `stop()` that actually sends `{"action": "stop"}`. (`hue-sync`'s does not —
  see the appendix.)
- **Restartable by construction**: threads are owned by `start()`, not by
  `__init__`, so a track change does not need a new object.

### Endpoints

All under `/api/hue/`, all JSON, matching the existing "every response is JSON,
including errors" rule:

| Route | Purpose |
|---|---|
| `GET /api/hue/discover` | mDNS + cloud scan |
| `POST /api/hue/pair` | link-button flow, polled |
| `GET /api/hue/lights` | CLIP v2 `light` |
| `GET /api/hue/groups` | `room` + `zone` + `grouped_light` |
| `GET /api/hue/areas` | `entertainment_configuration` |
| `POST /api/hue/stream` | start/stop the light show |
| `GET /api/hue/health` | paired? streaming? which area? — touches no network |

## Milestone 2 — analysis, produced during the transcode

### Taking the PCM off the decode we already do

`_run_transcode` already runs `yt-dlp | ffmpeg -i pipe:0 → <id>.mp3.part`.
ffmpeg is therefore already decoding the whole track. `_ffmpeg_cmd` gains a
second output:

```
... -f mp3 ... <id>.mp3.part  -map 0:a -f s16le -ar 22050 -ac 1 <id>.pcm.part
```

Two things this buys:

- **No second decode.** `librosa.load` would otherwise pull the mp3 back through
  `soundfile`/`audioread`, decoding the track twice for no reason.
- **No `soundfile` dependency in the hot path.** Raw `s16le` at the exact rate
  and channel count librosa wants is a `np.frombuffer` away.

The `.pcm.part` suffix is deliberate: `cache_scan()` already sweeps `*.part` at
startup, so a crash mid-transcode leaves nothing behind and that function needs
no change.

The transcode stall watchdog measures `os.path.getsize(out_path)` on the *mp3*
`.part`, and `_serve_tail` reads the same file. A second output does not disturb
either.

### The analysis does not gate the download

`_download` still marks the `Download` `done` at the `.part → .mp3` rename.
`/media`, `_flush_queue`, and the listener are unaffected — this is important,
because `ACTIVE_STATES` semantics mean anything that delays completion delays
the speaker.

The librosa pass is a **separate scheduler job at `PRIORITY_ANALYSIS`** — a
large positive number, so under the existing "lower wins" ordering it always
yields to any prefetch, let alone the urgent track. With `PREFETCH_GATE` on it
is also held off the CPU while an urgent download is in flight, for free.

> **Superseded during implementation — this paragraph was wrong.** `_Scheduler`
> has a fixed worker pool, so a low-priority job still *occupies a worker* for
> the whole librosa pass; "always yields" only orders the queue, it does not
> stop analysis from consuming one of the threads downloads share. Worse, the
> free lunch is imaginary: `PREFETCH_GATE` gates **the wire**, and holding a
> CPU-bound job off the network changes nothing about its contention for the
> CPU. The two resources were conflated.
>
> Implemented instead as a **dedicated single worker with its own bounded
> queue** in `analysis.py`. One worker because librosa is already internally
> parallel and a second concurrent pass mostly buys cache contention; bounded
> and **drop-on-full** because `submit()` is called from a download worker,
> where blocking would stall the pipeline feeding the speaker, and because a
> backlog means PCM files accumulating at ~2.6 MB per minute of audio each — a
> missing analysis dims the lights, a full disk stops playback.

**librosa is imported lazily inside that job.** numba's JIT costs seconds on
first call, and this is a single-process threaded Flask app where a module-scope
import would be paid by the first request to touch `app.py` at all.

### Output

`<id>.beats.json`, alongside `<id>.json` and `<id>.jpg`:

- beat times (`librosa.beat.beat_track`)
- onset strength envelope (`librosa.onset.onset_strength`)
- RMS and three band energies at a fixed hop
- tempo

> **Narrowed during implementation.** Shipped as `beats`, `tempo`, and two
> parallel `0..1` tracks — `energy` (RMS) and `brightness` (spectral centroid,
> log-mapped 100 Hz→Nyquist, because pitch is perceived in octaves) — on a
> fixed 10 Hz timeline (`frame_seconds`).
>
> The onset envelope was dropped: `beat_track` already consumes it, and
> publishing both means shipping the input and the conclusion. Three band
> energies became one centroid because the render loop needs a *colour axis*,
> and one number that says "where is the spectral mass" is directly that, where
> three bands would need the client to reduce them to one anyway.
>
> The timeline is 10 Hz rather than librosa's native ~43 Hz: finer than a
> listener can distinguish a light changing at, and the difference between a
> ~45 KiB sidecar and a ~190 KiB one per five-minute track. Energy bins with
> `max` (a transient peaking inside a bin is the entire point) and centroid
> with `mean` (an averaged centroid is a steadier colour than whichever frame
> happened to be brightest) — not interchangeable.
>
> `tempo` is **derived from the published beat list**, not taken from librosa's
> scalar, which is quantised onto its estimator's grid and disagreed with its
> own beats by 2.1% on a synthetic click track. A `tempo` that contradicts the
> `beats` shipped beside it is a trap for the consumer.

Never evicted, same rule as the metadata sidecar and the artwork: it is tiny,
and keeping it means a re-listen needs only the audio back.

### PCM is transient, and optional

- Deleted the moment the analysis finishes, or when the analysis job is dropped.
- **Capture is skipped entirely unless Hue is configured** (`HUE_ANALYZE=auto`,
  meaning "on iff `hue.json` exists"). At ~44 KB/s, an 8-track prefetch window
  would otherwise hold ~100 MB of scratch for every user who has no bridge.

### Cost, stated plainly

`librosa` 1.0.0 pulls `numba`, `llvmlite`, `numpy>=2.1`, `scipy>=1.15`,
`scikit-learn>=1.6` — roughly 300–400 MB on the Fedora image. It goes in its own
`Containerfile` layer so it does not share cache fate with the yt-dlp layer,
which is invalidated deliberately and often via `UPDATE_DATE`.

### Clock sync

`nowPlaying.position` arrives at ~1 s granularity over an SSE poll. The render
loop therefore interpolates from a monotonic clock and **re-anchors on each SSE
payload**, plus a **user-tunable latency offset**. Sonos buffers, and the right
offset depends on the speaker, the group, and the network — it cannot be derived,
only dialled in by ear.

### Mapping

Uniform colour across the whole entertainment area **first**; per-channel
spatial effects second. Per-channel needs the area's channel positions and opens
a much larger design surface. Getting the beat visibly right on one colour is
the thing actually worth proving.

## Milestone 3 — frontend

- `web/src/lib/hooks/use-hue.ts`, mirroring `use-speaker.ts`'s derived-selection
  pattern (`devices.find(...) ?? devices[0] ?? null`) with
  `usePersistedState("yts.hue.bridge")`.
- A pairing dialog modelled on `SpeakerDialog`.
- The render loop driven by the existing `/api/events` SSE connection — no new
  transport.
- All decision logic in `web/src/lib`, pure and unit-tested with `node --test`,
  per the existing convention. `pnpm test`, `typecheck`, `lint` and `build` stay
  green.

## Appendix: why `hue-sync` was not used

Findings from reading the repository source directly (not the README, which
disagrees with it in places).

- **npm is three years stale.** npm `latest` is `0.1.3`, published 2022-08-11.
  The GitHub repo's `main` is `0.1.5`.
- **The published build breaks on modern Node.** `patchDNS` has a
  `getNodeVersion() >= 20` branch that returns
  `callback(null, [{family: 4, address: ip}])`. That branch exists only in the
  newer, unpublished code. The web container runs `node:24-alpine`.
- **`stop()` does not stop anything.** `start()` passes `signal` and
  `cipherSuites` to `dtls.createSocket(...)`, through an
  `as unknown as dtls.Options` cast. The pinned `node-dtls-client@^1.1.1` has
  **no `signal` in its `Options`** and calls the field **`ciphers`, not
  `cipherSuites`**. The cast silences the compiler; both options are dropped at
  runtime. So `abortionController.abort()` closes nothing,
  `socket.on("close", ...)` never fires, and the `{action: "stop"}` PUT is never
  sent — the bridge is left to time the stream out.
- **`start()` never rejects.** It returns
  `new Promise(resolve => this.socket.on("connected", resolve))` with no error
  path, so a failed handshake hangs rather than throwing.
- **`patchDNS` mutates global `dns.lookup` from the constructor**, stacking a
  closure per instance.
- **`transition()` duplicates each 8-bit value into both bytes** of the 16-bit
  colour field, and derives the channel id from array position rather than from
  the entertainment area's declared channels.
- Not a blocker, but checked: `node-aead-crypto` ships napi prebuilds including
  `linux-x64-musl`, so Alpine would not have needed a compiler.

None of this is fatal on its own, and most of it is fixable upstream. Together
with the four reasons at the top of this document, it made Flask the clearly
better home.
