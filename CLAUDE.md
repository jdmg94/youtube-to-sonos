# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Plays YouTube audio on Sonos speakers on the LAN. Songs are downloaded and transcoded to a local disk cache ahead of time, and Sonos plays them from a real queue of per-track URLs served by this app.

**Two deployables, one repo:**

* `app.py` — Flask **JSON API and media server**. Renders no HTML at all.
* `web/` — **Next.js frontend** (App Router, TypeScript, Tailwind v4, shadcn/ui). It proxies `/api/*` to the backend via a rewrite in `next.config.ts`, so the browser only ever makes same-origin requests and CORS stays off.

The browser talks only to Next; the *speakers* talk only to Flask, fetching `/media/<id>.mp3` directly over the LAN. That split is why `STREAM_HOST` must stay an address the speakers can reach and must never point at the Next server, which does not serve audio.

## Commands

```bash
# Deployment — both containers, via docker-compose.yml
make up             # build + start API and UI; UI on :5000, API on :5001
make down / logs / ps / restart
make docker-update-ytdlp  # rebuild busting the yt-dlp layer (see below)

# Backend alone
make run-local      # local dev: uv venv + install deps + run app.py
make build / run    # standalone Docker image, --network=host
make update-ytdlp   # rebuild only the yt-dlp layer (fixes YouTube extractor breakage / 403s)

# Frontend (in web/ — pnpm, not npm)
pnpm dev            # dev server, proxying /api to API_ORIGIN
pnpm test           # node --test; the logic in src/lib is fully covered
pnpm typecheck      # next typegen && tsc --noEmit
pnpm lint           # eslint, incl. React Compiler rules
pnpm build          # production build (output: standalone, for Docker)
```

The backend has no linters and one test file:

```bash
.venv/bin/python -m unittest test_hue   # stdlib unittest, no config, no new dependency
```

`test_hue.py` covers only the parts of `hue.py` that can be checked without a bridge — turning bridge JSON into "which lamps" and "what to say to them", and the order `HueSession` does things in. The rest of the backend is untested; DTLS handshakes and SSDP are hardware. Adding a second file means `python -m unittest discover` and nothing else.

The frontend has all four gates above and they are expected to stay green.

Notes on ports:

* `app.py` defaults to `PORT=5001` when run directly, matching what the Makefile and Containerfile set. It must not default to 5000, which is the UI's port — a bare `python app.py` would collide with the UI container.
* `next.config.ts` defaults `API_ORIGIN` to `http://127.0.0.1:5001` to match the container.
* **On macOS, `:5000` is taken by ControlCenter (AirPlay Receiver)**, which answers every path with a bare `403 Forbidden` (`Server: AirTunes/…`). That is why the backend sits on 5001 and not 5000: the proxy forwarded to AirPlay happily and the UI showed "Scan error: 403 Forbidden", which looks like a broken backend rather than a port collision. Nothing of ours wants `:5000` on a Mac — `pnpm dev` serves the UI on `:3000` there — so the defaults now work unchanged on both platforms.

## Deployment

`docker-compose.yml` runs both images. `PORT` (default 5001) and `WEB_PORT` (default 5000 — the UI keeps the address the API used to answer on, since the API is the one no human opens; not Next's own 3000, which is the port most likely to be already claimed on a shared server) move them; `PORT` is interpolated into *both* the backend's env and the UI's `API_ORIGIN` build arg, so the two cannot drift.

**`API_ORIGIN` is a build arg, not a runtime env var, and this is the single easiest thing to get wrong here.** Next evaluates `rewrites()` during `next build` and writes the resolved destination into `.next/routes-manifest.json`, so the backend address is compiled into the image. Setting `API_ORIGIN` on the *running container* does nothing at all — and does it silently: the UI boots, renders, and every `/api` call fails against whatever address was baked. Changing it means `docker compose up -d --build`, because Compose does not rebuild on `up` when only a build arg changed.

It is written `${API_ORIGIN:-http://127.0.0.1:${PORT:-5001}}`: the default derives from `PORT` so the pair cannot drift, and an explicit `API_ORIGIN` opts out of that derivation entirely — which is only correct when the target is a backend *outside* this compose file. Setting it to reach the `youtube-sonos` service just breaks the `PORT` coupling for nothing.

The same mechanism is why `web/.dockerignore` excludes `.env*`. A developer's `.env.local` pointing at a local backend on some other port, left in the build context, ships an image that talks to a port existing only on that laptop.

Both services need `network_mode: host`: the backend because SSDP multicast does not cross network namespaces and the speakers must reach it to pull audio, the frontend because the backend is on the host's stack and has no bridge address or DNS name to proxy to. Under bridge networking `/api/health` reports `stream_host` as the container's own `172.17.x.x` — an address no speaker can fetch from, which is the visible symptom of getting this wrong.

Docker Desktop on macOS cannot do any of this: its host networking is a VM-side shim, so SSDP never reaches the LAN and discovery finds nothing. Develop on macOS with `make run-local` + `pnpm dev`; run compose on the Linux box.

## Architecture

The backend is `app.py` plus two Hue modules: `hue.py` (bridge discovery, pairing, the Entertainment stream) and `analysis.py` (beat and timbre extraction). Neither imports `app.py` — paths and policy are passed in — which is what keeps them testable without standing up Flask. Anything added here must also be listed in the Containerfile's `COPY`; it is not a package, so a forgotten module builds clean and dies at startup. The frontend lives in `web/src`, with all decision logic in `web/src/lib` (pure, unit-tested) and React components kept thin over it.

`API.md` is the contract between them.

### Playback pipeline (the core flow)

1. `POST /api/play` — resolves the seed video (preferring a cache sidecar over a yt-dlp call), starts the download, **waits for the seed's first bytes**, and only then clears the speaker's queue, enqueues the seed with DIDL metadata, and calls `play_from_queue(0)`. No `force_radio` — each queue item is a real track.
   The wait (`_wait_for_first_bytes`, `PLAY_START_TIMEOUT`) is not optional politeness: Sonos opens `/media` the instant it is told to play and hangs up well before our own `MEDIA_START_TIMEOUT` (120s) is up, so a cold seed — yt-dlp resolve, deno, ffmpeg startup — used to leave the speaker parked on the track without playing it, indistinguishable to the listener from "the Play button did nothing". It happens **before `clear_queue`** because playing now is an explicit "Play now" the listener takes while something else is playing: leaving the queue intact through the wait means the old track covers the resolve+transcode window instead of the speaker going silent for it. Worst case the old song plays `PLAY_START_TIMEOUT` (45s) longer, which beats 45s of nothing. `_ensure_playing` then confirms the speaker reached `PLAYING` and nudges it once with a bare `Play` if it didn't, reporting the outcome as `started` so the UI doesn't paint a Now Playing card for silence.
   **`mode: "next"`** takes the other path: `_queue_after_current` inserts the seed directly after the current track (`add_to_queue(position=…)`) at prefetch priority and returns `{"status": "queued", "queued_next": true}` — nothing is cleared, nothing is interrupted, and the track downloads while the current one finishes. It falls back to playing now when `_queue_position` reports 0 — the speaker is on line-in, TV, or a radio stream, so there is no queue item to sit behind. The API's `auto` default picks `next` whenever the speaker is playing, but the UI never sends it: its two buttons are **Play now** (`now`) and **Play next** (`next`), because a listener switching the mood wants suggestions reseeded from the new song, not appended behind the old one.
2. `ensure_cached(video_id, priority=...)` → `_download` on `_SCHED` (see **Download scheduling**) — yt-dlp resolves the direct URL *and its `http_headers`*, ffmpeg transcodes it to `CACHE_DIR/<id>.mp3` (via `.part` + atomic rename) with ID3 tags and embedded cover art, and writes an `<id>.json` sidecar plus an `<id>.jpg` thumbnail.
3. `GET /media/<id>.mp3` — what Sonos actually pulls. A complete file is served with `Content-Length` + Range support (so the speaker can seek); an incomplete one is tail-served chunked while the download continues, which is how a cold start or a jump backwards still begins in seconds.

### Download scheduling

`_Scheduler` (replacing a plain `ThreadPoolExecutor`) dispatches downloads by **priority = distance from what the speaker needs**: `PRIORITY_MEDIA` (-1) for an open `/media` socket, `0` for the track under the cursor, `N` for N tracks ahead. Lower wins.

With `PREFETCH_GATE` on (default), prefetch downloads are held **off the wire entirely** while an urgent (`<= URGENT_PRIORITY_MAX`) download is in flight, so the track the listener is waiting on gets the whole uplink rather than sharing it with the lookahead window. The gate is evaluated at *dispatch* — `_take` peeks the heap head and parks without consuming a worker — which is why a gated job can't deadlock the urgent job it's waiting for. A FIFO executor could do neither this nor re-ordering, which is why it's gone.

`_reprioritize(station)` re-orders queued jobs when the cursor moves (station loop, and `/api/transport` `jump` so the user doesn't wait out a poll). It deliberately **never** calls `ensure_cached` — that would resurrect every evicted track behind the cursor and re-download the back window every tick.

`_top_up` is ramped: while the cursor track is still downloading the lookahead is `PREFETCH_WARMUP_AHEAD` (1) instead of `WINDOW_AHEAD` (8), capped at `TOPUP_BATCH` new tracks per tick, with `PREFETCH_WARMUP_MAX_TICKS` as a hard escape. This matters because resolving a track means yt-dlp round trips *synchronously inside the station loop*.

`end_station` cancels the outgoing station's *queued* jobs so a fresh `/api/play` doesn't compete with prefetches nobody will hear — but it skips ids another live station still lists, and marks what it does cancel via `Download.cancel()` (penalty-free, unlike `finish('failed')`). Leaving them `queued` would be worse than a leak: `_is_active` would report them live forever and stall the other station's `_flush_queue`.

`GET /api/downloads` exposes what's running, what's queued and at what priority — without it, "prefetch politely waiting" and "scheduler wedged" look identical.

Lock discipline: `_Scheduler._cv` is a **leaf**. Nothing held under it may take `_STATE_LOCK` or a `Download.cond`; `_STATE_LOCK -> _Scheduler._cv` is the only legal ordering.

A `Download` is `queued` → `running` → `done`/`failed`. **`ACTIVE_STATES` covers both `queued` and `running`** — treating only `running` as live is the easy way to introduce a silent hang (eviction deleting a pending track, `_flush_queue` racing ahead, `_serve_tail` truncating a stream). `_download` guarantees no path leaves a `Download` stuck `running`: one that does wedges `_flush_queue` permanently and hangs every `/media` reader.

### Why yt-dlp downloads and ffmpeg only transcodes

ffmpeg no longer fetches googlevideo. With a current yt-dlp it could — a fresh
URL serves an open-ended `Range: bytes=0-` fine, even to ffmpeg's default
`Lavf/*` UA. The problem is what happens when yt-dlp goes stale: the URLs it
still manages to produce can refuse open-ended ranges with 403 (exactly what
ffmpeg sends on open, while bounded ranges return 206 with no UA at all), or
serve only their first 1 MiB and 403 permanently past that offset. Both were
observed in the wild; both surfaced as an opaque ffmpeg 403 that no header or
reconnect setting could fix, and neither was about request identity.

So `_ytdlp_source_cmd` runs yt-dlp in a child with the parent's exact
`ydl_opts` (JSON-passed, so cookies / player-client / js-runtime settings can't
drift) writing media to stdout with `logtostderr` on, and `_run_transcode`
pipes that into `ffmpeg -i pipe:0`. This puts every YouTube quirk behind the
one dependency that gets fixed when YouTube changes, and makes failures report
yt-dlp's own error instead of ffmpeg's.

`extract_audio` still resolves each track, but **for metadata only** — its URL
is never fetched. That costs a second extraction per download; worth revisiting
if YouTube request volume becomes a problem.

**A stale yt-dlp is the default suspect for any download failure**, and it hides
well: yt-dlp sits in its own image layer keyed on the `UPDATE_DATE` build-arg,
so an ordinary rebuild reuses the cached layer and silently keeps whatever
version was installed first. `_log_ytdlp_version` prints the version at startup
and shouts past `YTDLP_STALE_DAYS` (14 days — YouTube retires a player dialect
in far less than a month).

Failures are sorted into three classes, because each has a different fix and
YouTube's own wording points at none of them: `_is_bot_error` (sign-in wall /
429 → wait it out), `_is_forbidden_error` (googlevideo 403 on the media URL),
and `_is_player_error` — "The page needs to be reloaded", "not available on this
app", no player response — which means YouTube refused the *session* yt-dlp
opened, i.e. the extractor is out of date. The downloader stops after the second
player error instead of burning all `DOWNLOAD_ATTEMPTS`: the retry re-runs the
same extractor against the same YouTube, so it fails identically, and three
resolves per track is how a stale extractor earns a rate-limit block on top.

Cookies are **optional**: present at `cookies.txt` they are used, absent the app
runs unauthenticated, and `COOKIES_FILE=""` disables them explicitly (which is
what distinguishes a deliberate absence from an accident, so the log can stay
quiet about the former). `_resolve_cookiefile` stages a writable copy, because
the mount is read-only and yt-dlp writes its refreshed jar back — meaning
refreshed cookies do not persist to the host and sessions eventually expire.
Never mount a `cookies.txt` that doesn't exist: Docker/Podman create a
root-owned *directory* in its place and cookies vanish silently, so the resolver
rejects a non-file path with a loud error naming the fix.

### Station state

Nothing is prefetched until the loop has seen the speaker report `PLAYING` (`station.playing_seen`). Resolving the next track is a synchronous yt-dlp round trip and its download wants uplink; both belong to the seed until the listener is actually hearing something.

`Station` (one per speaker IP, in the `STATION` dict) is the authoritative ordered track list plus the cursor. A daemon `_station_loop` thread per station polls the speaker's `playlist_position` — it has to run independently of any browser, since Sonos advances its own queue. Each tick it calls `_reprioritize` (re-order queued downloads around the new cursor), `_top_up` (extend and download toward `WINDOW_AHEAD` tracks, choosing them with the existing `_reseed_ids` / `build_station_queue` variety logic), `_flush_queue` (enqueue finished downloads in order; drop failed ones), and `_evict` (delete cached audio outside `-WINDOW_BEHIND` / `+WINDOW_AHEAD`).

The Sonos queue is deliberately **never trimmed** mid-session — removing items renumbers `playlist_position`. Only files obey the window; stepping back past it re-downloads through `/media`. A play-next *insert* renumbers it too, which is safe only because `Station.add(entry, at=…)` inserts at the same index in `tracks`: index `i < enqueued` is queue position `i + 1`, and that correspondence is what every position calculation assumes.

The one exception is `refresh_station` (`POST /api/station/refresh`), which removes everything *after* the cursor — furthest item first, so each removal can't renumber the ones still to go, and stopping the truncation at the first removal the speaker rejects rather than letting `tracks` shrink past what the queue holds. The playing track's `playlist_position` is untouched by a removal behind it, which is what makes this safe where a general trim isn't. It refuses (409) when `_queue_position` is 0 or the cursor has drifted past `enqueued`.

`Station.lock` serialises the writers that can reorder those lists — the station loop (`_top_up` and `_flush_queue`), a play-next insert on a request thread, and `refresh_station`'s truncation. Without it the insert can shift `tracks` between `_flush_queue`'s lookup and its `add_to_queue`, leaving list and queue off by one for the rest of the session. It is taken **outside** `_STATE_LOCK`: the full order is `Station.lock -> _STATE_LOCK -> _Scheduler._cv`.

### Why the queue used to repeat itself

A station's walk was fully reproducible: `_MIX_CACHE` hands back the identical mix for `MIX_CACHE_TTL`, `build_station_queue` is a pure function of (mix, played sets), `_pick_next` took `queue[0]`, and `_reseed_ids` used fixed offsets — so the same seed rebuilt the same queue, and `Station.played_ids` dying with its station meant a stop-and-play remembered nothing. Three things break that, and all three are needed:

* `_RECENT` (`RECENT_MAX` / `RECENT_TTL`) is a **process-wide** memory of every track any station has served, written in `Station.add` — the single point every track passes through — and read by `_pick_next` as an extra exclusion. It outlives the `Station` objects, which is the whole point.
* `_pick_next` draws from the top `STATION_PICK_POOL` candidates at random, and `_reseed_ids` picks its second seed at random from the last few played.
* `_pick_next` applies its filters as a **ladder** — station sets ∪ recent, then station sets alone, then ids only with the artist cap lifted — so a saturated recent-memory can slow the station but never stall it into `exhausted`.

`refresh_station` deliberately keeps `played_ids` / `played_titles` / `_RECENT` when it drops the tail: those exclusions are exactly why the refill is new. It also passes `refresh=True` down to `get_radio_mix` for the first pick, because a brand-new set of songs cannot come out of the memoised mix.

All shared state (`STATION`, `_DOWNLOADS`, `_INUSE`, `_MIX_CACHE`, `_RECENT`) is guarded by `_STATE_LOCK` and lives in-process, so the app must stay single-process/threaded.

### Now-playing state

Because each queue item is a real tagged file, `_now_playing_payload` reads title/artist/artwork/duration straight from `speaker.get_current_track_info()`. `_video_id_from_uri` recognises our own `/media/<id>.mp3` URIs. `/api/events` (SSE) polls the speaker and emits on payload change, carrying the station list and per-track cache status on the same connection.

### Sonos discovery

`soco.discover()` uses SSDP multicast, which is why the container must run with `--network=host` (multicast doesn't cross network namespaces). `STREAM_HOST` env var overrides auto-detected LAN IP when the host has multiple NICs — Sonos must be able to reach this IP to pull the stream.

### Philips Hue (`hue.py`)

Lights that follow the music. Discovery (mDNS `_hue._tcp.local`, cloud fallback), link-button pairing, CLIP v2 REST, and the Entertainment stream — DTLS-PSK over UDP 2100. `app.py` owns the HTTP surface at `/api/hue/*`; `hue.py` never imports it, taking `set_state_path()` at startup instead so it can't drift from `CACHE_DIR`.

**It lives in Flask, not Next, and that is not arbitrary.** The colours come from analysis of audio this process already decoded, and `/api/:path*` is rewritten to Flask in `beforeFiles` — a handler at `web/src/app/api/hue/*` would build, typecheck and lint clean, then 404 through the proxy at runtime.

**Python 3.12 is forced, not chosen.** `python-mbedtls` (the DTLS-PSK client) ships no wheel past cp312 and librosa 1.0 needs ≥3.12, so 3.12 is the exact intersection — which is why `run-local` passes `--python`, and why a bare `uv venv` grabbing a newer interpreter installs something that fails at import. There is also **no linux/arm64 wheel** for python-mbedtls; an ARM host builds from sdist and needs mbedtls headers.

**The PSK identity is discovered, not hardcoded.** The two reference implementations disagree about what a bridge wants — `hue-sync` sends the application key with AES-128, `hue-entertainment-pykit` sends the `hue-application-id` with AES-256 — and both are in production use, so one of them is riding a leniency. `HueSession` tries `PSK_PROFILES` in order and persists the winner to `hue.json`, making the answer a cached fact rather than a constant we could get wrong. A firmware change costs one extra handshake instead of a bug report. `spike_hue_dtls.py` answers the same question interactively and is deletable once it has.

Two things worth not re-deriving: the writer thread **always sends** rather than sending on change, because the bridge drops a stream idle for ~10s and this makes keepalive fall out of the frame loop for free; and a frame is **one datagram carrying every channel** at full 16-bit colour, where pykit sends one datagram per light and hue-sync duplicates each 8-bit value into both bytes.

`/api/hue/health` deliberately does **not** take `_HUE_LOCK` — starting a stream holds it across an HTTPS PUT and up to four DTLS handshakes, and health blocking behind that would stall the UI exactly while it asks whether the stream came up.

**Stopping restores the room, because the bridge doesn't.** Deactivating an entertainment area hands control back but leaves the lamps wherever the last frame painted them, so `HueSession.start` snapshots the area's lights and `stop` re-applies that snapshot. Two orderings are load-bearing and both fail silently if reversed: the snapshot is taken **before** the area goes live (afterwards the bridge reports the frames we are sending, so the snapshot would record the light show), and the restore is sent **after** deactivating (a light in a streaming area ignores REST, so the PUTs would land on nothing). `test_hue.py` pins both.

It lives in `HueSession.stop()` rather than the endpoint, so every teardown gets it: the dialog's Stop, `/api/stop`, switching areas, and a handshake that fails after the area was activated. `_hue_stop()` in `app.py` is the one place `_HUE_SESSION` is torn down, shared by the stream endpoint and `/api/stop` so the two cannot drift — which is why the stream endpoint's stop branch sits *outside* `with _HUE_LOCK` now, as `_hue_stop` takes that lock itself and it is not reentrant.

Which lamps an area covers takes three list calls to work out: an area lists channels, a channel lists the `entertainment` services feeding it, and an entertainment service and a light are two services of one device. `area_light_ids` does that join and returns **nothing** when the shape is unrecognised — falling back to every light on the bridge would put someone's kitchen back to a state the show never touched.

### Beat analysis (`analysis.py`)

What the lights actually follow. `_ffmpeg_cmd` grows a **second output** writing raw mono PCM (22050 Hz, librosa's own default rate) beside the mp3, and `analysis.py` turns that into an `<id>.beats.json` sidecar served by `/api/hue/analysis/<id>`.

**It rides the transcode instead of getting its own pass.** ffmpeg is already decoding every frame to make the mp3, so a second output costs one more encode of already-decoded audio where a separate pass over the finished file would be a whole second decode. The PCM is headerless — a container would need a seekable output to finalise its header, and this is a pipe-fed transcode the stall watchdog may kill partway through, where headerless PCM truncates harmlessly. It is named `<id>.pcm.part` so the existing startup `*.part` sweep cleans up after a crash without knowing this feature exists.

**It does not run on the download scheduler, and the design doc that said it should was wrong.** That scheduler's `PREFETCH_GATE` reasons about *the wire*; librosa is CPU-bound. An analysis job there would occupy a download worker — starving the downloads it shares a pool with — under a gate that means nothing for it. So: one dedicated worker (librosa is already internally parallel), a bounded queue, and `submit()` **drops** rather than blocks when full, because it is called from a download worker and blocking that stalls the pipeline feeding the speaker. Analysis is submitted only *after* the track is committed and can never fail a download.

**The sidecar carries features, not colours** — energy, brightness, beat times. The palette belongs in the frontend where it is cheap to change and unit testable; baking colours in would mean re-analysing every cached track to adjust a constant. `tempo` is derived from the beat list we publish rather than taken from librosa, whose scalar is quantised onto its estimator's grid and can disagree with its own beats (117.45 against beats 119.99 BPM apart). `_tempo_from_beats` uses the **median to select** which intervals are one beat long and the **mean of those to measure**: beat times are snapped to librosa's 23.2ms frame grid, so a plain median returns a quantised value while a plain mean is hostage to a single missed beat.

Capture is gated by `HUE_ANALYZE` — `auto` (default: on iff a bridge is paired), `1`, `0` — and by `analysis.available()`, since **librosa is optional at runtime**. It drags in numba, llvmlite and scipy; without it nothing is captured and only the lights go dark. That is also why `/api/hue/analysis` answers **404 when no analysis is scheduled** rather than 202: a track cached before pairing will never be analysed, and 202 would have a client poll forever.

`hue.json` sits in `CACHE_DIR` at mode `0600` and is safe there: `cache_scan` only touches `.part`/`.tmp`/`.mp3` and `_evict` only `.mp3`.

### Other endpoints

`/` (JSON index — the frontend moved to `web/`, and this says so rather than 404ing a stale bookmark of the old UI), `/api/health` (liveness + config, touches no network), `/api/devices` (SSDP scan), `/api/downloads` (scheduler introspection), `/api/info` (metadata only), `/api/play` (`mode`: `auto`/`now`/`next`), `/api/transport` (POST: next/prev/play/pause/seek/jump against the speaker's own queue), `/api/station` (ordered list + cursor + per-track cache status), `/api/station/refresh` (POST: discard everything queued after the playing track and refill it with unheard songs — the UI's Refresh button), `/api/stop` (also tears down the station so it stops prefetching), `/api/volume` (GET/POST), `/media/<id>.jpg` (album art — Sonos won't fetch YouTube's CDN). Most endpoints fall back to the first discovered speaker when `device_ip` is omitted. Queue and transport commands always go through `_coordinator()`, since they must target the group coordinator.

**Every response is JSON, including errors.** The 404/405/500 handlers are unconditional — there is no HTML anywhere in this app, so a near-miss like `/aip/health` (the request most likely to be a client typo) answers in the one format the client can parse.

### Cache layout

`CACHE_DIR` (default `/app/cache`, must be a persistent writable mount) holds `<id>.mp3`, `<id>.json` (metadata sidecar) and `<id>.jpg`. Sidecars and artwork are never evicted — they're tiny, and keeping them means a re-listen needs only the audio. `cache_scan()` at startup deletes stray `.part` files and backfills missing sidecars — which is also what cleans up an `<id>.pcm.part` left by a transcode that died mid-analysis, the reason that file is named the way it is. With Hue analysis on it additionally holds `<id>.beats.json`, likewise never evicted (~45 KiB for a five-minute track, and keeping it means a re-listen never re-runs librosa). It also holds `hue.json` (Hue credentials, `0600`) — not audio, but it belongs to the same persistent mount, and it survives because both `cache_scan` and `_evict` match on suffix rather than deleting what they don't recognise.

### Container layering

The Containerfile is deliberately layered so yt-dlp (which breaks often and needs frequent updates) sits in its own layer, invalidated via the `UPDATE_DATE` build-arg — this is what `make update-ytdlp` does. The image also installs deno, required by yt-dlp for YouTube extraction.
