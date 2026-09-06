# YouTube → Sonos Streamer

Stream any YouTube video's audio to a Sonos speaker on your LAN.
Runs as two containers via **Docker Compose**, designed for a Fedora server.
The compose file is portable, so `podman compose` works too, but the Makefile
shells out to `docker` — swap the binary if you run Podman.

---

## Architecture

Songs are **downloaded to a local cache before they play**, and Sonos is given a
real queue of per-track URLs pointing at that cache. YouTube is contacted once
per song instead of once per play, which is what keeps the server off YouTube's
bot radar — and because each queue item is a genuine file, the speaker's own
next / previous / seek controls work.

Two containers, both on the host network:

```
 ┌──────────────┐               ┌──────────────────────┐
 │  Browser     │ ────────────► │  web  :5000          │
 │  (any host   │   the only    │  Next.js             │
 │   on LAN)    │ ◄──────────── │  UI + /api/* proxy   │
 └──────────────┘   origin it   └──────────┼───────────┘
                    ever talks             │ same-origin /api,
                    to                     │ so no CORS
                                           ▼
                                ┌─────────────────────────────────────────┐
                                │  youtube-sonos  :5001                   │
                                │  Flask — JSON only, renders no HTML     │
                                │   ├── /api/devices    → soco SSDP scan  │
                                │   ├── /api/play       → build the queue │
                                │   ├── /api/transport  → next/prev/seek  │
                                │   ├── /api/station    → queue + cache   │
                                │   └── /media/<id>.mp3 → cached file     │
                                │                                         │
                                │   station thread                        │
                                │   ├─ yt-dlp → ffmpeg → cache/<id>.mp3   │
                                │   │    prefetches 8 tracks ahead        │
                                │   └─ evicts outside -8 / +8             │
                                └──────────┼──────────────────────────────┘
                                           │ UPnP AddURIToQueue + Play
                                           ▼
                                    ┌────────────┐
                                    │  Sonos     │ ◄── pulls /media/*.mp3
                                    │  Speaker   │     straight from Flask
                                    └────────────┘     on :5001, not via Next
```

The browser only ever talks to Next; the *speakers* only ever talk to Flask.
That split is why `STREAM_HOST` must stay an address the speakers can reach,
and must never be pointed at the Next server — which serves no audio.

### The cache window

The server keeps an ordered station list and follows the speaker's queue
position. Around the current track it keeps **8 songs behind and 8 ahead** on
disk; anything outside that window is deleted. Metadata sidecars and artwork are
kept forever (they're tiny), so a track that falls out of the window can be
re-queued without asking YouTube for anything but the audio.

A track that isn't cached yet — the very first song, or one you skipped back
past — is served *while it downloads*, so playback still starts in a few
seconds. Its real duration reaches the speaker through the queue metadata, so
the display stays correct either way.

### Why --network=host is required

Sonos discovery uses SSDP — UDP multicast to 239.255.255.250:1900.
Multicast does not cross network-namespace boundaries, so the default bridge
mode (or Podman's slirp4netns) silently drops every discovery packet. With
--network=host the container shares the host's full network stack, so:

- SSDP multicast works identically to a bare-metal process
- Sonos can connect back to the Flask HTTP stream using the host's LAN IP
- No port-forwarding rules or firewall exceptions are needed for discovery

---

## Prerequisites

**Docker with the Compose plugin**, plus `make`. The Makefile invokes `docker`
directly, so on Fedora — where Podman is the pre-installed engine — install
Docker or replace the `docker` calls in the Makefile with `podman`:

```bash
sudo dnf install -y make docker-ce docker-compose-plugin
sudo systemctl enable --now docker
```

`ffmpeg` and `yt-dlp` live inside the container image — no host install needed.

---

## Quick start

```bash
# 1. Clone and enter the project
git clone https://github.com/yourname/youtube-sonos-streamer
cd youtube-sonos-streamer

# 2. Export YouTube cookies to ./cookies.txt (optional but recommended).
#    To run without them, comment the mount out of docker-compose.yml and set
#    COOKIES_FILE: "" — see "Cookies" below. Do NOT skip this step and leave
#    the mount in place; the file must exist before `up`.

# 3. Build and start both containers
make up
# → open http://<server-LAN-IP>:5000 from any browser on your LAN
```

`make logs` follows both, `make down` stops them. They restart on boot
(`restart: unless-stopped`), so there is no separate "install as a service"
step.

**Open :5000, not :5001.** :5000 is the UI. The JSON API moved to :5001 — the
speakers pull audio from it and you can curl it, but a browser pointed there
gets an endpoint listing, not the app.

### The two containers

| | Port | What it is |
|---|---|---|
| `web` | 5000 | Next.js UI. The only thing a browser should open. Proxies `/api/*` to the backend, so there is no CORS and no second origin. Not 3000: that is Next's default and the port most likely to be taken already on a shared box. |
| `youtube-sonos` | 5001 | Flask JSON API + media server. Renders no HTML. Talks to the speakers; the speakers fetch `/media/<id>.mp3` from it directly. |

Both run with `network_mode: host`, for different reasons — the backend
because SSDP multicast does not cross network namespaces, the frontend because
the backend is on the host's network stack and has no bridge address to proxy
to. Neither can be moved to a bridge network without breaking.

`PORT` and `WEB_PORT` move them:

```bash
PORT=5002 WEB_PORT=8080 make up
```

`PORT` feeds both the backend's listener *and* the address compiled into the
UI, so they cannot drift apart.

### Changing the API address needs a rebuild

Next resolves its `/api` proxy rewrite at **build** time and writes the result
into the image. `API_ORIGIN` is therefore a build arg, and setting it on a
running container does nothing whatsoever — silently: the UI still boots and
renders, and only the API calls fail. Always use:

```bash
docker compose up -d --build     # or: make up
```

Compose will not rebuild on a plain `up` when only a build arg has changed.

By default the address is derived from `PORT`, so the two stay in step and you
never set it directly. Override it only to point the UI at a backend that is
**not** the `youtube-sonos` service in this compose file:

```bash
# UI proxying to an API on another host entirely
API_ORIGIN=http://192.168.1.9:5001 docker compose up -d --build
```

An explicit `API_ORIGIN` takes `PORT` out of the loop — after that, changing
`PORT` moves the backend's listener and the UI keeps proxying to the old
address. That is the point when overriding across hosts, and a trap when not.

### Upgrading from the Quadlet install

Earlier versions shipped a systemd Quadlet unit. If it is still installed it
owns port 5000 — now the UI's — and compose will collide with it. Remove it
first:

```bash
sudo systemctl disable --now youtube-sonos
sudo rm /etc/containers/systemd/youtube-sonos.container
sudo systemctl daemon-reload
# rootless variant: systemctl --user disable --now youtube-sonos
#                   rm ~/.config/containers/systemd/youtube-sonos.container
```

The cache in `./cache` is untouched by this and carries over.

### macOS

Compose targets the Linux server. Docker Desktop's host networking is a
VM-side shim, so SSDP multicast never reaches the LAN and no speakers are
found. On a Mac, run the two halves directly instead:

```bash
make run-local               # backend on :5001 — the default, and clear of the
                             # macOS AirPlay Receiver that owns :5000
cd web && pnpm dev           # UI on :3000 (next dev's default, not the
                             # container's :5000 — dev is on your laptop, where
                             # the server's port collision doesn't apply)
```

No `.env.local` is needed: `next.config.ts` already defaults `API_ORIGIN` to
`http://127.0.0.1:5001`. See "Troubleshooting" for why nothing of ours listens
on :5000 on a Mac.

---

## Configuration

All configuration is via environment variables — set them under
`environment:` in docker-compose.yml, or on the `docker run` command line (-e).

`API_ORIGIN` is the exception and is **not** in this table: it is read at
`docker compose build` time, not by the running container, because Next
compiles the proxy target into the image. It defaults to
`http://127.0.0.1:$PORT` and is worth setting only to reach a backend outside
this compose file. See "Changing the API address needs a rebuild" above.

| Variable     | Default  | Purpose                                                   |
|--------------|----------|-----------------------------------------------------------|
| PORT         | 5001     | TCP port Flask listens on. Also feeds the UI's API_ORIGIN |
|              |          | build arg, so compose keeps the two in step.              |
| WEB_PORT     | 5000     | TCP port the Next.js UI listens on — the one to browse to |
| STREAM_HOST  | (auto)   | LAN IP sent to Sonos as stream origin. Set this if your   |
|              |          | server has multiple NICs and auto-detection picks the     |
|              |          | wrong one (e.g. a management or VM bridge interface).     |
| COOKIES_FILE | (unset)  | Unset uses cookies.txt beside app.py when present. A      |
|              |          | path uses that file. Empty string disables cookies        |
|              |          | explicitly (and silences the "no cookies" log line).      |
| YTDLP_PLAYER_CLIENT | (unset) | Force a yt-dlp YouTube player client, e.g. `tv`.   |
|              |          | Unset = yt-dlp's default. Escape hatch for 403s.          |
| CACHE_DIR    | /app/cache | Where downloaded songs live. **Mount this** (see below).|
| CACHE_BITRATE | 192k    | MP3 bitrate for cached audio. ~5.8 MB per 4-minute track. |
| WINDOW_BEHIND | 8       | Songs kept on disk behind the current track.              |
| WINDOW_AHEAD | 8        | Songs downloaded and queued ahead of the current track.   |
| DOWNLOAD_WORKERS | 2    | Concurrent downloads. Raising this hits YouTube harder.   |
| PREFETCH_GATE | 1        | Hold prefetch downloads off the network entirely while    |
|              |          | the track you're waiting on is still downloading. Set 0   |
|              |          | to let prefetch share the uplink with it (old behaviour). |
| PREFETCH_WARMUP_AHEAD | 1 | Lookahead while the current track is still downloading.  |
| PREFETCH_WARMUP_MAX_TICKS | 15 | Station polls before the full window opens anyway.  |
| TOPUP_BATCH  | 2        | Max new tracks resolved per station poll.                 |
| DOWNLOAD_ATTEMPTS | 3   | Resolve+transcode attempts before a track is given up on. |
| DOWNLOAD_RETRY_COOLDOWN | 300 | Seconds before retrying a failed track (doubles    |
|              |          | per attempt, capped by DOWNLOAD_RETRY_COOLDOWN_MAX).      |
| DOWNLOAD_RETRY_MIN | 15 | Floor before a speaker request may retry a failed track.  |
| HTTP_CHUNK_SIZE | 0     | Force yt-dlp onto bounded ranges of this size. 0 lets     |
|              |          | yt-dlp choose. Only try setting it (e.g. 1048576) if      |
|              |          | downloads die partway through.                            |
| YTDLP_STALE_DAYS | 30   | Warn loudly when yt-dlp is older than this.               |
| TRANSCODE_STALL_TIMEOUT | 120 | Kill the download after this long with no bytes. |
| TRANSCODE_TIMEOUT | 1800 | Absolute ffmpeg wall-clock limit per track.              |
| MEDIA_START_TIMEOUT | 120 | Seconds /media waits for a cold download's first bytes.  |
| MIX_CACHE_TTL | 3600    | Seconds to reuse a fetched radio mix before re-fetching.  |
| STATION_POLL_INTERVAL | 2 | Seconds between checks of the speaker's queue position.|
| STATION_IDLE_POLLS | 150 | Idle polls before a stopped station shuts itself down.   |
| MAX_TRACKS_PER_ARTIST | 2 | Cap on tracks one artist contributes per queue refill.  |
| ARTIST_COOLDOWN | 4     | Recently-heard artists pushed to the back of a refill.    |
| STATION_PICK_POOL | 3   | Top candidates the next track is drawn from at random.    |
| RECENT_MAX    | 300      | Tracks remembered process-wide so they aren't re-served.  |
| RECENT_TTL    | 43200    | Seconds a remembered track stays excluded (12h).          |
| EVENT_POLL_INTERVAL | 2 | Seconds between now-playing polls for the SSE stream.     |

### The cache volume

`CACHE_DIR` must be a **writable, persistent** mount, or every restart
re-downloads everything from YouTube. docker-compose.yml binds `./cache`; point
it elsewhere by editing that line:

```yaml
    volumes:
      - /srv/youtube-sonos-cache:/app/cache:z
```

A 17-song window at the default bitrate is roughly 100 MB. The container runs as
root, so a rootless install needs the host directory owned by the mapped UID.

### Finding the right IP

```bash
# List all LAN-facing IPs on the host
ip -4 addr show | grep inet | grep -v 127
```

Then in docker-compose.yml, under the `youtube-sonos` service:

```yaml
    environment:
      STREAM_HOST: 192.168.1.42
```

And apply it:

```bash
make up
```

This one *is* a runtime variable, so a restart is enough — no rebuild. Check it
took with `curl localhost:5001/api/health`, which echoes back the
`stream_host` it will hand to the speakers.

---

## Updating yt-dlp

YouTube's extractor breaks regularly. yt-dlp is isolated in its own image
layer so you can update it without invalidating the heavier ffmpeg/soco layers:

```bash
make update-ytdlp
sudo systemctl restart youtube-sonos
```

---

## Cookies (optional)

Cookies are **optional**. Without them extraction runs unauthenticated, which is
fine most of the time; with them you get past YouTube's sign-in/bot checks. The
cache means each song is fetched once either way.

1. Export cookies for `youtube.com` in **Netscape format** from a logged-in
   browser. Tip: export from an **incognito window**, then close it without
   logging out — otherwise YouTube may rotate the session and invalidate them.
2. Save as `cookies.txt` in the repo root. It is gitignored and excluded from
   the image build context; it reaches the container by read-only mount, never
   baked into the image.

The startup log tells you which state you are in:

```
Using yt-dlp cookies from /app/cookies.txt (staged at /tmp/yt-sonos-cookies.txt)
No cookies file at /app/cookies.txt; extraction will run without cookies.
Cookies disabled (COOKIES_FILE is empty); extraction will run unauthenticated.
```

**The one trap:** the bind-mount source must exist before `docker compose up`.
When it doesn't, Docker and Podman create a root-owned **directory** in its
place, and cookies then vanish silently. Recovering needs
`sudo rm -rf cookies.txt`. The app rejects a non-file path with a loud error
naming the fix, so this shows up at startup rather than as mystery 403s.

To run *without* cookies: comment out the `./cookies.txt` mount **and** set
`COOKIES_FILE: ""`. The empty value is what tells the app the absence is
deliberate, so it stays quiet about it.

Because the mount is read-only, the refreshed cookie jar yt-dlp writes back is
staged to a temp copy and does not persist to the host file — so a session will
eventually expire and need re-exporting.

---

### Why yt-dlp downloads and ffmpeg only transcodes

ffmpeg used to fetch the googlevideo URL itself. It no longer does, because
that put every YouTube quirk on the wrong side of the dependency that actually
gets fixed when YouTube changes.

When yt-dlp is current, the URLs it returns are perfectly fetchable — an
open-ended `Range: bytes=0-` returns the whole file, even with ffmpeg's default
`Lavf/*` User-Agent. When yt-dlp is **stale**, the URLs it manages to produce
can be degraded in ways that are invisible until you try to read them:

* the URL refuses an open-ended `Range: bytes=0-` with **403**, which is exactly
  what ffmpeg's HTTP layer sends on open — while bounded ranges return 206, even
  with no User-Agent at all;
* the URL serves only its **first 1 MiB**, returning 403 past that offset
  permanently (not a rate limit — it does not recover with time).

Both surfaced as an opaque `Server returned 403 Forbidden` from ffmpeg that no
header, cookie, or `-reconnect` setting could fix, and neither had anything to
do with the request identity. Now `yt-dlp` downloads to stdout and ffmpeg
transcodes from `pipe:0`, so failures report yt-dlp's own error — which is
specific enough to act on — and a stale extractor is fixed by updating yt-dlp
rather than by changing this code.

### Updating yt-dlp — the first thing to try

Downloading is now entirely yt-dlp's job, so a stale yt-dlp is the most likely
cause of any download failure. **A plain rebuild does not update it.** yt-dlp
lives in its own image layer keyed on the `UPDATE_DATE` build-arg; while that
stays at its default, every rebuild reuses the layer built the very first time.

```bash
make docker-update-ytdlp                          # or, equivalently:
UPDATE_DATE=$(date +%s) docker compose up -d --build
make update-ytdlp                                 # standalone image, no compose
```

The startup log now reports the version and shouts if it is stale:

```
yt-dlp 2026.08.20; JS runtimes: deno, node
```

### When downloads fail

The resolve log line reports what YouTube handed back:

```
Resolved <id>: format=251 proto=https ua=yes cookie=no cookies=NO
```

Failures surface yt-dlp's own stderr (`yt-dlp failed: ...`), which is far more
specific than ffmpeg's was. To see which player clients still yield a fully
fetchable stream:

```bash
docker compose cp probe.py youtube-sonos:/tmp/probe.py
docker compose exec youtube-sonos python3 /tmp/probe.py dQw4w9WgXcQ
```

It reports, per client, the open-ended status (expect 403), the first KiB, and a
KiB **past the 1 MiB mark** — that last column is the one that matters, and
testing only the first KiB is how you wrongly conclude a URL "works". If a
client is fully fetchable you can pin it with `YTDLP_PLAYER_CLIENT=<name>`, but
normally you should not need to: yt-dlp handles this itself.

---

## REST API

```bash
SERVER=192.168.1.42:5001

# Discover speakers
curl http://$SERVER/api/devices

# Video metadata (fast, no download)
curl "http://$SERVER/api/info?url=https://youtu.be/dQw4w9WgXcQ"

# Play — starts a new station (clearing the speaker's queue), unless the
# speaker is already playing: then the track is inserted right after the
# current one and downloaded in the background, interrupting nothing.
# (omit device_ip to use first discovered speaker)
curl -X POST http://$SERVER/api/play \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://youtu.be/dQw4w9WgXcQ","device_ip":"192.168.1.55"}'

# Force one or the other with "mode": "now" (always restart) or "next"
# (always queue behind the current track) — this is what the UI's two
# buttons send: "Play now" -> now, "Play next" -> next.
curl -X POST http://$SERVER/api/play \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://youtu.be/dQw4w9WgXcQ","mode":"now"}'

# Transport — next | prev | play | pause | seek | jump
curl -X POST http://$SERVER/api/transport \
  -H 'Content-Type: application/json' \
  -d '{"device_ip":"192.168.1.55","action":"next"}'

# The station: ordered track list, current index, per-track cache status
curl "http://$SERVER/api/station?device_ip=192.168.1.55"

# Refresh — throw away everything queued after the playing track and refill
# it with songs this station (and the recent-tracks memory) haven't served.
# The current track keeps playing; answers 409 if the speaker isn't playing
# from its queue.
curl -X POST http://$SERVER/api/station/refresh \
  -H 'Content-Type: application/json' \
  -d '{"device_ip":"192.168.1.55"}'

# Remove — drop one upcoming track and leave the rest of the queue alone.
# "index" is into the list /api/station returns and must be after its
# "index" cursor; "id" is the video id you believe is at that position, and
# is required. The station list can be renumbered by a play-next insert
# between reading it and posting this, so the server checks the pair and
# answers 409 rather than deleting the wrong song.
curl -X POST http://$SERVER/api/station/remove \
  -H 'Content-Type: application/json' \
  -d '{"device_ip":"192.168.1.55","index":5,"id":"dQw4w9WgXcQ"}'

# The download scheduler: what's running, what's queued, at what priority.
# Priority is distance from what the speaker needs: -1 = a speaker is waiting
# on it right now, 0 = the current track, N = N tracks ahead.
curl "http://$SERVER/api/downloads"

# Stop — also tears the station down so it stops prefetching
curl -X POST http://$SERVER/api/stop \
  -H 'Content-Type: application/json' \
  -d '{"device_ip":"192.168.1.55"}'
```

---

## Firewall

```bash
sudo firewall-cmd --permanent --add-port=5000/tcp   # UI, for browsers
sudo firewall-cmd --permanent --add-port=5001/tcp   # API, for the speakers
sudo firewall-cmd --reload
```

Both are needed, and for genuinely different callers. 5000 is the UI you open.
5001 is where the *speakers* fetch audio — the browser never touches it
directly, but leaving it closed means the UI works and playback silently
never starts, because Sonos cannot reach the stream.

---

## SELinux

Running with --network=host, SELinux in Enforcing mode (Fedora default)
requires no extra policy changes.

Host-path volume mounts do need a label, so append :z (shared) or :Z (private)
— both the cookies file and the audio cache already do this in
docker-compose.yml:

```yaml
      - ./cache:/app/cache:z
      - ./cookies.txt:/app/cookies.txt:ro,z
```

The `web` container mounts nothing, so it needs no labels.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "No Sonos devices found" | Confirm speakers are on, same subnet. Test on host: python3 -c "import soco; print(list(soco.discover()))" |
| Sonos errors after a few seconds | DRM-protected or live source. Check `make logs` for ffmpeg errors. |
| Stream URL points to wrong IP | Set STREAM_HOST to the correct LAN interface IP. |
| 403 Forbidden while downloading | Check the log. `GOOGLEVIDEO 403` means the signed media URL was refused — usually stale cookies. Confirm the startup log says `Using yt-dlp cookies from ...`; if it says `COOKIES PATH IS A DIRECTORY`, run `sudo rm -rf cookies.txt` and create a real one. Then `make update-ytdlp`. |
| "COOKIES PATH IS A DIRECTORY" at startup | The bind-mount source didn't exist, so the engine created a root-owned directory. `sudo rm -rf cookies.txt`, then either export a real cookies.txt or comment out the mount. |
| Cache empty after every restart | CACHE_DIR isn't on a persistent mount — see The cache volume. |
| Long gaps between tracks | Downloads aren't keeping up. Check `curl http://$SERVER/api/downloads` and the log for transcode errors, then raise DOWNLOAD_WORKERS. |
| First song slow to start / stutters | The network is saturated. PREFETCH_GATE (on by default) should already give it the whole uplink; confirm with `/api/downloads` that only the seed is `running` while it downloads. |
| Cache directory growing without bound | Eviction only runs while a station is active. Check the log for "Evicted" lines. |
| Port 5000 or 5001 in use | `WEB_PORT=8080 make up` moves the UI, `PORT=5002 make up` moves the API, and rerun firewall-cmd for whichever moved. If an old Quadlet unit is still installed it is probably the squatter on 5000 — see "Upgrading from the Quadlet install". |
| "Scan error: 403 Forbidden" | Something else is answering on the API port. The classic case is macOS ControlCenter (AirPlay Receiver), which owns :5000 and 403s every path it doesn't know — the reason the API sits on :5001 and not :5000. `curl -i localhost:5001/api/health` showing `Server: AirTunes/…` rather than Werkzeug confirms a squatter; move the backend with `PORT=` and rebuild so `API_ORIGIN` follows. |
| UI loads but every action fails | The address baked into the `web` image doesn't match where the API is listening. `API_ORIGIN` is a *build* arg — setting it on the container does nothing. Rebuild: `docker compose up -d --build`. |
| Browser at :5001 shows JSON, not the app | Working as intended — that is the API. The UI is on :5000. |
| UI container exits with `EADDRINUSE` | Something else already holds WEB_PORT. `WEB_PORT=8081 make up`, and rerun firewall-cmd. |

---

## Project structure

```
youtube-sonos-streamer/
├── docker-compose.yml               Both containers — this is the deployment
├── Makefile                         up / down / logs / build / update helpers
├── API.md                           The contract between backend and frontend
│
├── app.py                           Flask JSON API: download cache + Sonos queue control
├── Containerfile                    API image (layered for fast yt-dlp updates)
├── .containerignore                 API build context exclusions — note it drops web/
├── requirements.txt                 Python deps
│
├── web/                             Next.js frontend (App Router, Tailwind, shadcn/ui)
│   ├── Dockerfile                   UI image (multi-stage, standalone output)
│   ├── .dockerignore                Drops .env* — see "Changing the API address"
│   ├── next.config.ts               Proxies /api/* to the Flask backend
│   └── src/
│       ├── app/                     Page shell and layout
│       ├── components/              UI, kept thin over lib/
│       └── lib/                     All decision logic — pure and unit-tested
│
├── cache/                           Downloaded audio (gitignored; bind-mounted)
├── cookies.txt                      yt-dlp session cookies (gitignored; bind-mounted :ro)
└── README.md
```

There is no `templates/` any more, and no `quadlet/`. The UI is `web/`; the
deployment is `docker-compose.yml`.
