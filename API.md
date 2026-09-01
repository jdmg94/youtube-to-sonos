# HTTP API

The contract between the Flask backend and any client. This is the source of
truth for `web/lib/api/types.ts`; when an endpoint changes, change it here in
the same commit.

Base URL is the Flask server, `http://<host>:<PORT>` (`PORT` defaults to 5001
everywhere — the container, the Makefile, and a bare `python app.py`). The UI
is the one on :5000; nothing here is served from it except through its /api
proxy.

## Conventions

**Errors.** Every failure is `{"error": string}` with a non-2xx status. The
message is meant to be shown to the user verbatim — the yt-dlp failure paths
deliberately return an actionable sentence rather than a raw traceback.

Three yt-dlp failure classes add a boolean flag alongside `error`, because each
one has a different fix and YouTube's own wording points at none of them:

| Flag | Status | Meaning |
| --- | --- | --- |
| `bot_detected` | 429 | Sign-in wall or rate limit. Wait it out. |
| `forbidden` | 502 | googlevideo refused the media URL with 403. Usually a stale extractor. |
| `stale_extractor` | 502 | YouTube refused yt-dlp's player session. Update yt-dlp. |

A client should treat any of the three as "retrying immediately will fail the
same way".

**`device_ip`.** Optional almost everywhere. When omitted the server runs an
SSDP discovery and uses the first speaker it finds, which costs a multicast
scan — clients should send it once they know it. Queue and transport commands
are always applied to the speaker's *group coordinator*, not necessarily the
speaker addressed.

**Time strings.** `duration` and `position` in now-playing come straight from
Sonos as `H:MM:SS` strings. `duration` in track metadata comes from yt-dlp as a
number of seconds. These are different types on purpose; do not unify them
without changing the server.

**Nullability.** Metadata fields sourced from yt-dlp (`title`, `uploader`,
`thumbnail`, `duration`) can be `null` for a track whose tags were not read
before it was enqueued. Clients must render around a missing title.

Now-playing is worse: its fields come from soco's `get_current_track_info()`,
which returns the **empty string** rather than `null` for anything the speaker
did not report, and `uri` is explicitly coerced to `""`. An idle speaker
therefore answers `{"title": "", "artist": "", "album_art": "", "duration":
"0:00:00"}`. `??` does not help here — clients must test truthiness, or they
will render a blank title where they meant to render a placeholder.

---

## `GET /api/health`

Liveness and configuration, cheap enough to poll. Does not touch the network,
so it answers even when SSDP discovery or YouTube is failing — which is what
makes it usable for distinguishing "backend down" from "backend fine, YouTube
angry".

```json
{
  "status": "ok",
  "stream_host": "192.168.1.50",
  "port": 5001,
  "ytdlp_version": "2025.08.11",
  "ytdlp_age_days": 3,
  "ytdlp_stale": false,
  "js_runtimes": ["deno"],
  "cookies": true,
  "stations": 1,
  "cache_dir": "/app/cache"
}
```

`ytdlp_stale` is `ytdlp_age_days > YTDLP_STALE_DAYS` (default 14). It being
`true`, or `js_runtimes` being empty, predicts download failures before the
listener hits one.

`ytdlp_age_days` is `null` when the version string does not parse as a date.

---

## `GET /api/devices`

SSDP multicast scan. Requires host networking; takes a second or two.

**200** — note this is a bare array, unlike every other endpoint. An empty array
means the scan succeeded and found nothing, which is a different situation from
an error.

```json
[{ "name": "Kitchen", "ip": "192.168.1.31" }]
```

**500** `{"error": "..."}` — the scan itself failed.

---

## `GET /api/info?url=<youtube-url>`

Metadata only. Resolves through yt-dlp without downloading.

**200**

```json
{
  "id": "dQw4w9WgXcQ",
  "title": "Never Gonna Give You Up",
  "uploader": "Rick Astley",
  "thumbnail": "https://i.ytimg.com/vi/.../maxresdefault.jpg",
  "duration": 213
}
```

`thumbnail` is a YouTube CDN URL, directly usable by the browser.

**400** missing `url`. **429/502/500** per the yt-dlp error classes above.

---

## `POST /api/play`

Request:

```json
{
  "url": "https://youtu.be/dQw4w9WgXcQ",
  "device_ip": "192.168.1.31",
  "autoplay": true,
  "mode": "now"
}
```

| Field | Default | Notes |
| --- | --- | --- |
| `url` | — | Required. Any YouTube URL form, or a bare 11-char id. |
| `device_ip` | first discovered | |
| `autoplay` | `true` | `false` plays the one track and starts no station, so nothing is queued after it. |
| `mode` | `"auto"` | `"now"` \| `"next"` \| `"auto"`. |

**`mode` semantics.** `"now"` clears the queue and starts a fresh station from
this seed. `"next"` inserts the seed directly after the current track and
downloads it in the background, interrupting nothing. `"auto"` picks `"next"`
whenever the speaker is already playing.

The UI sends `"now"` or `"next"` explicitly and never `"auto"`: a listener
switching the mood wants the station reseeded from the new song, not the new
song appended behind the old one.

`"next"` falls back to the `"now"` path (and returns the `"playing"` shape)
when the speaker has no queue item to sit behind — it is on line-in, TV, or a
radio stream.

**200, played now:**

```json
{
  "status": "playing",
  "started": true,
  "queued_next": false,
  "device": "Kitchen",
  "device_ip": "192.168.1.31",
  "stream_url": "http://192.168.1.50:5001/media/dQw4w9WgXcQ.mp3",
  "autoplay": true,
  "video_id": "dQw4w9WgXcQ",
  "title": "Never Gonna Give You Up"
}
```

`started: false` means the speaker accepted the track but never reached
`PLAYING`. The request did not fail, but the listener is hearing silence — do
not paint a confident "now playing" state on it.

**200, queued next** — `status: "queued"`, `queued_next: true`, plus
`queue_position` (1-based Sonos queue position), no `started`.

**Latency.** The `"now"` path blocks until the seed's first bytes are on disk
(`PLAY_START_TIMEOUT`, 45s worst case) before touching the speaker. This is
deliberate: whatever was playing covers the resolve + transcode window instead
of the speaker going silent. Clients must show a spinner and must not time out
below 60s.

**400** missing `url`, unresolvable video id, or unknown `mode`.
**404** no speakers. **429/502/500** per the yt-dlp error classes.

---

## `POST /api/transport`

```json
{ "device_ip": "192.168.1.31", "action": "next" }
```

| `action` | Extra field |
| --- | --- |
| `next`, `prev`, `play`, `pause` | — |
| `seek` | `position`, `"H:MM:SS"` (default `"0:00:00"`) |
| `jump` | `index`, 0-based index into the station track list |

`jump` also moves the server's cursor immediately and re-prioritizes downloads
around it, rather than waiting up to a poll interval for the station loop to
notice.

**200** `{"status": "ok", "action": "next", "device": "Kitchen"}`

**409** `{"error": "Nothing to skip to"}` — Next on the last track or Prev on
the first. A normal user action, not a server fault; show it as a no-op, not an
error toast.

**400** unknown action. **404** no speakers. **500** otherwise.

---

## `GET /api/station?device_ip=<ip>`

The server's ordered track list and cursor. Authoritative over anything the
client remembers; the speaker advances its own queue independently of any
browser.

```json
{
  "device_ip": "192.168.1.31",
  "index": 2,
  "exhausted": false,
  "tracks": [
    {
      "id": "dQw4w9WgXcQ",
      "title": "Never Gonna Give You Up",
      "uploader": "Rick Astley",
      "thumbnail": "https://i.ytimg.com/vi/.../hqdefault.jpg",
      "duration": 213,
      "cached": "done",
      "queue_pos": 1
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `index` | 0-based cursor into `tracks`. |
| `exhausted` | The station could not find any more unheard tracks. |
| `id` | Video id. Note: `id`, not `video_id` — unlike the now-playing payload. |
| `cached` | `"done"` \| `"running"` \| `"queued"` \| `"failed"` \| `"missing"` |
| `queue_pos` | 1-based Sonos queue position, or `null` if not yet enqueued. |

Only a track with `cached: "done"` and a non-null `queue_pos` can be jumped to.

When no station is running the response is `index: 0`, `tracks: []`,
`exhausted: false` — a 200, not a 404.

---

## `POST /api/station/refresh`

Discards everything queued *after* the playing track and refills it with songs
this station and the process-wide recent memory have not served. The current
track plays on untouched.

Request `{"device_ip": "..."}`. Response is the `/api/station` payload plus:

```json
{ "status": "refreshed", "dropped": 4, "device": "Kitchen" }
```

**404** no speakers, or no station running on this one.
**409** `{"error": "This speaker isn't playing from its queue"}` — the cursor
has drifted, or the speaker is on line-in/TV/radio, so there is no tail to
truncate safely.

---

## `GET /api/now-playing?device_ip=<ip>`

```json
{
  "state": "PLAYING",
  "title": "Never Gonna Give You Up",
  "artist": "Rick Astley",
  "album_art": "http://192.168.1.50:5001/media/dQw4w9WgXcQ.jpg",
  "duration": "0:03:33",
  "position": "0:01:12",
  "playlist_position": 3,
  "station_index": 2,
  "uri": "http://192.168.1.50:5001/media/dQw4w9WgXcQ.mp3",
  "is_radio": true,
  "video_id": "dQw4w9WgXcQ",
  "device": "Kitchen",
  "device_ip": "192.168.1.31"
}
```

| Field | Meaning |
| --- | --- |
| `state` | `PLAYING` \| `PAUSED_PLAYBACK` \| `STOPPED` \| `TRANSITIONING` |
| `playlist_position` | 1-based Sonos queue position. `0` when not playing from the queue. |
| `station_index` | 0-based cursor, or `null` when no station is running. |
| `is_radio` | Legacy key. Now means "this is a track we are serving", i.e. `video_id !== null`. |
| `video_id` | `null` when the speaker is playing something that isn't ours. |

`album_art` is an absolute URL to *this server*, not to YouTube. It is what
Sonos was given in the DIDL metadata. It is browser-reachable as long as
`STREAM_HOST` is the LAN IP, but prefer the station track's `thumbnail`
(YouTube CDN) for UI, since that exists before the track is cached.

**404** no speakers. **500** otherwise.

---

## `GET /api/events?device_ip=<ip>` — SSE

`text/event-stream`. The server polls the speaker every `EVENT_POLL_INTERVAL`
seconds (default 2) and emits a message **only when the payload changes**,
sending a `: keep-alive` comment otherwise. This replaces client-side polling.

Each `data:` frame is the `/api/now-playing` payload plus a `station` key
carrying the `/api/station` payload *without* `device_ip`:

```json
{
  "state": "PLAYING",
  "...": "all now-playing fields",
  "station": { "index": 2, "tracks": [], "exhausted": false }
}
```

A frame may instead be `{"error": "..."}` — the stream stays open (or ends, if
the speaker could not be resolved at all). Clients must tolerate an `error`
frame without treating it as a fatal connection failure.

The stream never ends on its own. Clients reconnect on drop; `EventSource` does
this natively.

Headers set `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`.
Any proxy in front of this must neither buffer nor **compress** it.

`no-transform` is load-bearing. A proxy that gzips this stream holds it in the
compressor's buffer and the client gets nothing at all — the response headers
arrive, `readyState` goes to `OPEN`, and no `message` ever fires, which looks
exactly like a speaker that stopped reporting. Next.js compresses proxied
responses by default and does this whenever the client sends `Accept-Encoding:
gzip`, which every browser does; `Accept-Encoding` is a forbidden header name,
so `EventSource` cannot opt out. The stream must therefore refuse compression
from this end.

`web/scripts/contract-check.ts` asserts the response carries no
`Content-Encoding`. Do not remove that check: nothing else notices, because a
compressed stream is indistinguishable from an idle one until you look at the
headers.

---

## `GET /api/volume?device_ip=<ip>`

`{"volume": 25, "mute": false, "device": "Kitchen", "device_ip": "192.168.1.31"}`

## `POST /api/volume`

`{"device_ip": "...", "volume": 25, "mute": false}` — both `volume` and `mute`
optional; send either or both. `volume` is clamped to 0–100.

Responds with the resulting `{"volume", "mute", "device"}` (no `device_ip`).

Clients should debounce slider input; each call is a UPnP round trip.

---

## `GET /api/downloads`

Scheduler introspection. Without it, "prefetch politely waiting behind an
urgent download" and "scheduler wedged" look identical from outside.

```json
{
  "workers": 2,
  "gate": true,
  "running": { "dQw4w9WgXcQ": 0 },
  "pending": { "abc12345678": 3 },
  "downloads": [
    {
      "id": "dQw4w9WgXcQ",
      "state": "running",
      "bytes": 1048576,
      "attempts": 1,
      "error": null,
      "retry_in": 0,
      "priority": 0
    }
  ]
}
```

`priority` is distance from what the speaker needs: `-1` an open `/media`
socket, `0` the track under the cursor, `N` for N tracks ahead. Lower is more
urgent. `priority` is `null` for a download that is neither running nor pending.

---

## `POST /api/stop`

`{"device_ip": "..."}` → `{"status": "stopped", "device": "Kitchen"}`

Stops the speaker **and tears down the station**, so it stops prefetching from
YouTube. Not a pause — use `POST /api/transport` with `pause` for that.

**404** no speakers. **500** otherwise.

---

# Philips Hue

Lights that follow the music. These live on the Flask side rather than as Next
route handlers for two reasons: the colours come from analysis of audio *this*
process already decoded, and `/api/:path*` is rewritten to Flask in
`beforeFiles`, so a handler at `web/src/app/api/hue/*` would build, typecheck
and lint clean and then 404 through the proxy at runtime.

Credentials live in `CACHE_DIR/hue.json`, mode `0600`. The client key in it is
the shared secret for the light stream — anyone holding it can drive the
lights — so **no endpoint ever returns it.**

Design notes: `docs/superpowers/specs/2026-08-31-hue-support-design.md`.

## `GET /api/hue/health`

```json
{"paired": true, "bridge_ip": "10.0.0.5", "bridge_id": "001788fffe...",
 "psk_profile": ["username", "TLS-PSK-WITH-AES-128-GCM-SHA256"],
 "streaming": true, "area": "<uuid>", "channels": [0, 1, 2], "error": null}
```

Like `/api/health`, **touches no network** — a client must be able to tell
"not paired" from "bridge unreachable" without waiting out a scan. Always 200.

`psk_profile` is which DTLS identity/ciphersuite pair actually completed a
handshake, cached from the last successful start (see `/api/hue/stream`). It is
surfaced because when handshakes start failing after a firmware update it is
the first thing to look at, and it is otherwise buried in the log.

`error` is the reason a *previously running* stream died, which is how a stream
that dropped on its own is distinguished from one never started.

## `GET /api/hue/discover`

`{"bridges": [{"ip": "10.0.0.5", "id": "001788...", "name": null, "source": "mdns"}]}`

mDNS (`_hue._tcp.local`) first, `https://discovery.meethue.com/` as a fallback
— the cloud endpoint needs internet access and tells a third party's NAT about
your bridge, so it is only reached when mDNS finds nothing. mDNS needs
`network_mode: host` for the same reason SSDP does.

Returns `{"bridges": []}` rather than an error when both sources come up empty.

## `POST /api/hue/pair`

`{"ip": "10.0.0.5"}` → `{"paired": true, "ip": "...", "id": "..."}`

`ip` may be omitted to re-pair with the stored bridge.

**428** the link button has not been pressed yet. This is not an error — it is
the several seconds the user spends walking to the bridge. **Poll through it.**

**400** no ip given and none stored. **502** bridge unreachable, or it paired
but returned no client key (a firmware too old for the Entertainment stream —
the message says so, since otherwise this surfaces much later as a DTLS
handshake that never works).

## `GET /api/hue/lights`

`{"lights": [{"id", "name", "archetype", "on", "brightness", "owner"}]}`

## `GET /api/hue/groups`

`{"groups": [{"id", "kind": "room"|"zone", "name", "grouped_light", "children"}]}`

Rooms and zones are separate CLIP v2 resource types with identical shape, and a
UI has no reason to care which is which beyond a label, so they are merged here
rather than making every caller fetch both.

## `GET /api/hue/areas`

`{"areas": [{"id", "name", "status", "channels": [0,1], "positions": {...}}]}`

Entertainment configurations — the only thing that can be streamed to. If this
is empty the user has to create one in the Hue app; nothing here can do it for
them.

All three: **409** not paired. **401** the bridge rejected our application key
(pair again). **502** unreachable.

## `POST /api/hue/stream`

```
{"action": "start", "area": "<id>"}   → {"streaming": true, "area", "channels", "psk_profile"}
{"action": "stop"}                    → {"streaming": false}
{"action": "color", "color": [r,g,b]} → {"streaming": true}
```

`action` defaults to `start`; `area` defaults to the first one. `color` also
accepts a per-channel map, `{"0": [255,0,0], "1": [0,0,255]}` — JSON object
keys are strings, and they are parsed as channel ids.

Colour components out of range are **clamped**: a render loop overshooting to
260 wants the brightest red, not a failed frame. A malformed colour is a
**400**, not a clamp.

Starting opens a DTLS-PSK session on UDP 2100 and a writer thread that sends
one datagram per frame at 25 Hz carrying every channel. The writer *always*
sends the current colour rather than sending on change — the bridge drops a
stream idle for ~10s, and this makes keepalive fall out for free instead of
being a second thing to get right.

The DTLS identity and ciphersuite are **discovered, not hardcoded.** The two
reference implementations disagree — `hue-sync` sends the application key with
AES-128, `hue-entertainment-pykit` sends the `hue-application-id` with AES-256,
and both are in production use — so the first start tries the combinations in
order and persists the winner to `hue.json`. Later starts are a single attempt.
A firmware change that invalidates the cached profile therefore costs one extra
handshake rather than a bug report.

Only one stream exists per process, because the bridge permits exactly one.
Starting on the area already running is a no-op; starting on a different one
tears the first down first.

**409** not paired, no entertainment area exists, the chosen area has no lights
assigned (which would otherwise handshake, stream, and show nothing — a success
indistinguishable from broken hardware), or `color` with no stream running.
**404** no such area. **400** unknown action, missing `color`, or a malformed
one. **502** every PSK profile failed to handshake.

---

## Media endpoints — not for the browser

### `GET|HEAD /media/<video_id>.mp3`
### `GET|HEAD /media/<video_id>.jpg`

**These are fetched by the Sonos speakers, not by the UI.** The URLs are built
absolute as `http://{STREAM_HOST}:{PORT}/media/...` and handed to Sonos in the
queue item's DIDL metadata.

They must never be routed through a frontend proxy. A Next.js rewrite of
`/media/*` would be invisible to Sonos — the speaker uses the absolute URL it
was given — and pointing `STREAM_HOST` at the frontend to "fix" that breaks
playback, because the frontend does not serve the bytes. `STREAM_HOST` must
always be a LAN address the *speakers* can reach.

A complete file is served with `Content-Length` and Range support so the
speaker can seek. An incomplete one is tail-served chunked while the download
continues, which is how a cold start begins in seconds. Requesting an uncached
id triggers a download at priority `-1`.

`404` for an invalid id or, for artwork, one with nothing cached.

---

## Not in the contract

There is **no authentication, no session, no CSRF, and no cookie** anywhere in
this API. It is a LAN service and every endpoint is open to anyone who can
reach the port. Do not expose it to the internet without putting something in
front of it.

CORS is off by default. Set `ALLOW_ORIGINS` (comma-separated, or `*`) to enable
it — only needed when a browser calls this API cross-origin. The `web/`
frontend proxies same-origin instead, so it does not need this.
