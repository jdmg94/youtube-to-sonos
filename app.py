import os
import re
import sys
import json
import time
import errno
import socket
import shutil
import urllib.request
import tempfile
import threading
import subprocess
import logging
import heapq
import random
import itertools
from collections import Counter
from flask import Flask, jsonify, request, Response
from werkzeug.exceptions import HTTPException
import soco
import soco.exceptions
from soco.data_structures import DidlMusicTrack, DidlResource
import yt_dlp
import hue
import analysis

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# No `template_folder` and no static folder: this app renders nothing. It serves
# JSON under /api and audio/artwork under /media, and the UI is a separate
# Next.js app that talks to it over HTTP.
app = Flask(__name__)

def get_local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # Use a external address (Google DNS) to determine local interface IP
        s.connect(('8.8.8.8', 1))
        ip = s.getsockname()[0]
    except Exception:
        ip = '127.0.0.1'
    finally:
        s.close()
    return ip

# 5001 matches what the Containerfile, the Makefile and docker-compose.yml all
# set, so a bare `python app.py` lands on the same port as every other way of
# running this. It must NOT be 5000: that is the UI's port, and colliding with
# it would put the Next server and the media server on one address.
PORT = int(os.environ.get('PORT', 5001))
STREAM_HOST = os.environ.get('STREAM_HOST') or get_local_ip()

# --- Cross-origin access ------------------------------------------------------
#
# Off by default, and the frontend does not need it: `web/` proxies /api through
# its own origin, so the browser only ever makes same-origin requests. This is
# the escape hatch for the other cases — a browser calling this API directly, or
# debugging the frontend with the proxy taken out of the picture.
#
# Comma-separated origins, or "*". Note that "*" here is honest rather than
# reckless: there is no auth, session or cookie on this API, so an allowed
# origin gains nothing a direct request to the port doesn't already have.
ALLOW_ORIGINS = [o.strip() for o in
                 os.environ.get('ALLOW_ORIGINS', '').split(',') if o.strip()]


def _cors_origin(request_origin):
    """The Access-Control-Allow-Origin value for this request, or None."""
    if not ALLOW_ORIGINS or not request_origin:
        return None
    if '*' in ALLOW_ORIGINS:
        # Echo rather than literal "*" so the header stays valid if credentials
        # are ever added, and so caches key on the actual origin.
        return request_origin
    return request_origin if request_origin in ALLOW_ORIGINS else None


@app.after_request
def _apply_cors(response):
    if not ALLOW_ORIGINS:
        return response
    # Set on every response, not just allowed ones: the response body is
    # origin-dependent either way, and a cache that missed that could hand an
    # allowed origin's CORS headers to a disallowed one.
    response.headers.add('Vary', 'Origin')
    origin = _cors_origin(request.headers.get('Origin'))
    if origin:
        response.headers['Access-Control-Allow-Origin'] = origin
        response.headers['Access-Control-Allow-Methods'] = 'GET, POST, HEAD, OPTIONS'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
        response.headers['Access-Control-Max-Age'] = '86400'
    return response


# Preflights need no route of their own: Flask answers OPTIONS automatically for
# every rule, and that response passes through _apply_cors like any other.


# Flask's default error pages are HTML. A typed JSON client asking for a
# mistyped endpoint would get an HTML 404 and fail at JSON.parse, reporting
# "Unexpected token '<'" instead of "no such endpoint" — so every error answers
# in JSON, whatever goes wrong.
#
# This used to be scoped to /api and /media, because the app also served an HTML
# page at / and an HTML error alongside it was consistent. That page is now a
# separate Next.js app and this one renders nothing, so the exclusion had no
# remaining purpose except to hand back Werkzeug's HTML for a near miss like
# /aip/health — the request most likely to be a client typo and most in need of
# a parseable answer.
@app.errorhandler(404)
def _json_404(e):
    return jsonify({"error": f"No such endpoint: {request.path}"}), 404


@app.errorhandler(405)
def _json_405(e):
    return jsonify({"error": f"{request.method} not allowed on {request.path}"}), 405


@app.errorhandler(Exception)
def _json_500(e):
    """Last resort for an exception no route caught.

    Every endpoint already catches its own failures; this exists so that the one
    that doesn't returns JSON with the traceback in the log, rather than an HTML
    500 page that tells the client nothing parseable.
    """
    if isinstance(e, HTTPException):
        return e
    logger.exception(f"Unhandled exception on {request.method} {request.path}")
    return jsonify({"error": str(e) or "Internal server error"}), 500

# Shared yt-dlp format selection for audio extraction
AUDIO_FORMAT = 'bestaudio[acodec=opus]/bestaudio[acodec=vorbis]/bestaudio[ext=m4a]/bestaudio/best'

# Optional Netscape-format cookies file for yt-dlp, used to get past YouTube's
# bot / sign-in checks. Defaults to cookies.txt next to app.py; override with
# COOKIES_FILE. When absent, extraction runs without cookies (prior behavior).
# Setting COOKIES_FILE to an empty string disables cookies outright — no probe,
# no warning. Unset falls back to cookies.txt beside app.py, used only if it is
# actually there.
_COOKIES_ENV = os.environ.get('COOKIES_FILE')
COOKIES_DISABLED = _COOKIES_ENV is not None and not _COOKIES_ENV.strip()
COOKIES_SRC = (_COOKIES_ENV or '').strip() or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), 'cookies.txt')


def _resolve_cookiefile():
    """Return a writable cookies path for yt-dlp, or None when unavailable.

    yt-dlp writes the refreshed cookie jar back to `cookiefile` after each
    extraction. The container mounts the cookies file read-only (docker-compose
    `:ro`), so pointing yt-dlp straight at the mount fails with
    `[Errno 30] Read-only file system`. Copy the source once to a writable temp
    path and hand yt-dlp the copy so it can persist refreshed cookies.

    Every failure here is logged at error level and names the fix: cookies
    vanishing silently looks exactly like YouTube getting stricter, and costs
    hours to diagnose from the 403s it causes downstream.
    """
    if COOKIES_DISABLED:
        logger.info("Cookies disabled (COOKIES_FILE is empty); extraction will "
                    "run unauthenticated.")
        return None
    if not os.path.exists(COOKIES_SRC):
        logger.info(f"No cookies file at {COOKIES_SRC}; extraction will run "
                    "without cookies.")
        return None
    if not os.path.isfile(COOKIES_SRC):
        kind = 'DIRECTORY' if os.path.isdir(COOKIES_SRC) else 'SPECIAL FILE'
        logger.error(
            f"COOKIES PATH IS A {kind}, NOT A FILE: {COOKIES_SRC}. This is "
            "almost always a container bind-mount for a cookies.txt that did "
            "not exist, so the runtime created a directory in its place. "
            "Remove it (it may be root-owned: `sudo rm -rf cookies.txt`) and "
            "either remove the mount (recommended if you don't want cookies) "
            "or drop in a real cookies.txt. RUNNING WITHOUT COOKIES.")
        return None
    dst = os.path.join(tempfile.gettempdir(), 'yt-sonos-cookies.txt')
    try:
        shutil.copyfile(COOKIES_SRC, dst)
    except OSError as e:
        logger.error(f"Could not stage a writable cookies copy from "
                     f"{COOKIES_SRC} ({e}); RUNNING WITHOUT COOKIES.")
        return None
    try:
        with open(dst) as fh:
            head = fh.read(4096)
    except OSError:
        head = ''
    if 'youtube.com' not in head:
        logger.warning(f"{COOKIES_SRC} has no youtube.com entries — it may be "
                       "empty or exported for the wrong site.")
    logger.info(f"Using yt-dlp cookies from {COOKIES_SRC} (staged at {dst})")
    return dst


COOKIES_FILE = _resolve_cookiefile()

# Which YouTube player client yt-dlp should ask. Left unset, yt-dlp picks its
# own default, which is usually the best-tested choice — so this is an escape
# hatch, not a default to tune. It matters because clients differ in whether
# they need a PO token: the `web` family generally does, and without one
# YouTube answers the media URL with 403 no matter how faithfully ffmpeg
# replays the request headers. Comma-separated, e.g. "tv" or "default,-web".
YTDLP_PLAYER_CLIENT = os.environ.get('YTDLP_PLAYER_CLIENT', '').strip()


def ydl_opts(**extra):
    """Base yt-dlp options; injects the cookies file when it exists.

    js_runtimes enables both deno (the container's runtime, tried first) and
    node as a fallback so `make run-local` works on hosts without deno. A JS
    runtime is required to run the yt-dlp-ejs challenge solvers — without one,
    YouTube signature/n solving fails and extraction yields no audio formats.
    """
    opts = {
        'quiet': True,
        'js_runtimes': {'deno': {'path': None}, 'node': {'path': None}},
        **extra,
    }
    if COOKIES_FILE:
        opts['cookiefile'] = COOKIES_FILE
    if YTDLP_PLAYER_CLIENT:
        opts.setdefault('extractor_args', {})['youtube'] = {
            'player_client': [c.strip() for c in YTDLP_PLAYER_CLIENT.split(',')
                              if c.strip()]
        }
    return opts

# yt-dlp's age is the single most useful number in the log. Downloading is
# entirely yt-dlp's job now, and YouTube breaks its extractor constantly, so a
# stale copy is the most likely cause of any download failure. It is easy to
# leave one in place for months without noticing: the Containerfile pins yt-dlp
# to its own layer keyed on UPDATE_DATE, so an ordinary rebuild reuses the
# cached layer and silently keeps whatever version was installed first.
# 14 days, not 30: YouTube retires a player dialect within days, and the
# failures it causes ("the page needs to be reloaded", 403s, no formats) all
# read as problems with the video until you check the version.
YTDLP_STALE_DAYS = int(os.environ.get('YTDLP_STALE_DAYS', 14))


def _ytdlp_status():
    """yt-dlp version, age and available JS runtimes.

    The two usual suspects behind any download failure, gathered once for both
    the startup log and /api/health — so the answer to "why is nothing playing"
    is available over HTTP instead of only in a log line printed at boot.
    """
    try:
        version = yt_dlp.version.__version__
    except Exception:
        version = None
    runtimes = [name for name, path in (('deno', shutil.which('deno')),
                                        ('node', shutil.which('node'))) if path]
    age = None
    if version:
        try:
            released = time.strptime(version[:10], '%Y.%m.%d')
            age = (time.time() - time.mktime(released)) / 86400
        except (ValueError, TypeError):
            age = None
    return {
        'version': version,
        'age_days': None if age is None else int(age),
        'stale': age is not None and age > YTDLP_STALE_DAYS,
        'js_runtimes': runtimes,
    }


def _log_ytdlp_version():
    status = _ytdlp_status()
    if not status['version']:
        logger.warning("Could not determine the yt-dlp version")
    else:
        logger.info(f"yt-dlp {status['version']}; JS runtimes: "
                    f"{', '.join(status['js_runtimes']) or 'NONE'}")
    if not status['js_runtimes']:
        logger.error("No deno or node on PATH — yt-dlp cannot run the JS "
                     "challenge solvers and YouTube extraction will fail.")
    if status['stale']:
        logger.error(
            f"yt-dlp is {status['age_days']} days old. This is the usual cause "
            "of 403s and extraction failures. Rebuild the yt-dlp layer — an ordinary "
            "rebuild will NOT do it, you must bust the build-arg:\n"
            "    UPDATE_DATE=$(date +%s) docker compose up -d --build\n"
            "    (standalone image: make update-ytdlp)")


# YouTube's #1 failure mode for this server: it decides the host is a bot and
# blocks extraction (sign-in wall or HTTP 429 rate limit). These are recoverable
# — usually `make update-ytdlp` or waiting out the rate limit — so we detect them
# explicitly and surface a clear, actionable message instead of a raw traceback.
BOT_ERROR_SIGNATURES = (
    "confirm you're not a bot",
    "confirm you’re not a bot",   # curly-apostrophe variant yt-dlp sometimes emits
    "sign in to confirm",
    "http error 429",
    "too many requests",
)
BOT_ERROR_MESSAGE = (
    "YouTube is blocking this server as a bot (sign-in required or rate-limited). "
    "Try `make update-ytdlp`, then wait a few minutes before retrying."
)


def _is_bot_error(err):
    """True if a yt-dlp failure looks like YouTube bot-detection / rate-limiting."""
    msg = str(err).lower()
    return any(sig in msg for sig in BOT_ERROR_SIGNATURES)


# A 403 from googlevideo is a *different* failure from bot detection and needs a
# different fix. It means yt-dlp could not fetch the stream — usually a stale
# extractor rather than anything about our request. A bare "forbidden" is
# deliberately not a signature; it misfires on unrelated OS errors.
FORBIDDEN_ERROR_SIGNATURES = (
    "http error 403",
    "http_error 403",
    "403 forbidden",
    "server returned 403",
    "access denied",
)
FORBIDDEN_ERROR_MESSAGE = (
    "YouTube refused the media stream with HTTP 403. Downloading is yt-dlp's "
    "job, so this usually means a stale extractor: run `make update-ytdlp` and "
    "restart. If it persists, `probe.py` reports which player clients still "
    "hand back a fully fetchable stream."
)


def _is_forbidden_error(err):
    """True if a failure is googlevideo refusing the signed media URL (403)."""
    msg = str(err).lower()
    return any(sig in msg for sig in FORBIDDEN_ERROR_SIGNATURES)


# A third failure class, distinct from both: YouTube accepted the request but
# refused yt-dlp's player session — "The page needs to be reloaded", "not
# available on this app", no player response at all. Nothing about the video or
# our cookies is wrong (the same id extracts fine from a current yt-dlp); the
# extractor is speaking a dialect YouTube has since retired. Left unclassified
# these surfaced as a raw 500 with YouTube's own cryptic wording, which points
# the reader at the video instead of at the fix.
PLAYER_ERROR_SIGNATURES = (
    "the page needs to be reloaded",
    "not available on this app",
    "failed to extract any player response",
    "unable to extract player response",
    "nsig extraction failed",
)
PLAYER_ERROR_MESSAGE = (
    "YouTube rejected yt-dlp's player session (\"the page needs to be "
    "reloaded\"). That means a stale extractor, not a bad video: run "
    "`make update-ytdlp` (Docker: `make docker-update-ytdlp`) and restart. If a "
    "current yt-dlp still fails, `probe.py` reports which player clients still "
    "work — put the winner in YTDLP_PLAYER_CLIENT."
)


def _is_player_error(err):
    """True if YouTube refused yt-dlp's player session rather than the video."""
    msg = str(err).lower()
    return any(sig in msg for sig in PLAYER_ERROR_SIGNATURES)


def _yt_error_response(err, context):
    """Log a yt-dlp failure and build the client JSON response for an endpoint.

    Bot-detection / rate-limit blocks get a distinct 429, a `bot_detected` flag,
    and a clear message so they stand out in both the logs and the UI toast;
    googlevideo 403s get a 502 and a `forbidden` flag, since the fix is a
    different one; a refused player session gets a 502 and a `stale_extractor`
    flag; everything else keeps the previous generic 500 with the raw message.
    """
    if _is_bot_error(err):
        logger.error(f"YT-DLP BOT DETECTION during {context}: {err}")
        return jsonify({"error": BOT_ERROR_MESSAGE, "bot_detected": True}), 429
    if _is_forbidden_error(err):
        logger.error(f"GOOGLEVIDEO 403 during {context}: {err}")
        return jsonify({"error": FORBIDDEN_ERROR_MESSAGE, "forbidden": True}), 502
    if _is_player_error(err):
        logger.error(f"YOUTUBE REFUSED YT-DLP'S PLAYER SESSION during {context}: "
                     f"{err}")
        logger.error(PLAYER_ERROR_MESSAGE)
        return jsonify({"error": PLAYER_ERROR_MESSAGE,
                        "stale_extractor": True}), 502
    logger.error(f"{context} failed: {err}")
    return jsonify({"error": str(err)}), 500

# Autoplay-station variety tuning (env-overridable, like EVENT_POLL_INTERVAL):
#   MAX_TRACKS_PER_ARTIST — cap on how many tracks one artist may contribute per
#                           queue refill, so no single artist dominates.
#   ARTIST_COOLDOWN       — an artist just heard within this many tracks is
#                           pushed to the back of the next refill.
#   STATION_PICK_POOL     — how many of the top candidates the next track is
#                           drawn from at random. 1 is the old behaviour, and it
#                           is why replaying a song rebuilt the identical queue:
#                           the mix is cached, the filters are deterministic, so
#                           always taking the best candidate walks the same path
#                           every time. A small pool keeps relevance (the
#                           round-robin has already spread the artists) while
#                           making two runs from one seed diverge.
#   RECENT_MAX/RECENT_TTL — process-wide memory of tracks already served, so a
#                           new station (or a refresh) doesn't re-suggest what
#                           was just heard. Per-Station sets die with the
#                           station; this is what outlives it.
MAX_TRACKS_PER_ARTIST = int(os.environ.get('MAX_TRACKS_PER_ARTIST', 2))
ARTIST_COOLDOWN = int(os.environ.get('ARTIST_COOLDOWN', 4))
STATION_PICK_POOL = max(1, int(os.environ.get('STATION_PICK_POOL', 3)))
RECENT_MAX = int(os.environ.get('RECENT_MAX', 300))
RECENT_TTL = float(os.environ.get('RECENT_TTL', 12 * 3600))

# --- Local audio cache -------------------------------------------------------
# Songs are downloaded and transcoded to disk ahead of playback, and Sonos pulls
# each track from us as a discrete file. YouTube is contacted once per song
# instead of once per play, which is what keeps this server off YouTube's bot
# radar. CACHE_DIR should be a persistent volume so the cache survives restarts.
CACHE_DIR = os.environ.get('CACHE_DIR') or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), 'cache')
CACHE_BITRATE = os.environ.get('CACHE_BITRATE', '192k')
# Whether to capture PCM during transcode for the Hue beat analysis.
# 'auto' (default) = on iff a bridge is paired; '1'/'0' force it either way.
ANALYZE_MODE = os.environ.get('HUE_ANALYZE', 'auto').strip().lower()
# Sliding window of cached audio around the current track: anything outside
# current-WINDOW_BEHIND .. current+WINDOW_AHEAD is deleted.
WINDOW_BEHIND = int(os.environ.get('WINDOW_BEHIND', 8))
WINDOW_AHEAD = int(os.environ.get('WINDOW_AHEAD', 8))
DOWNLOAD_WORKERS = int(os.environ.get('DOWNLOAD_WORKERS', 2))
# Download scheduling. Priority is distance from what the speaker needs, so
# lower wins: PRIORITY_MEDIA (a speaker with an open socket) < 0 (the track
# under the cursor) < N (N tracks ahead). Anything <= URGENT_PRIORITY_MAX is
# "urgent" and bypasses the gate; with PREFETCH_GATE on, prefetch downloads are
# held off the wire entirely while an urgent one is in flight, so the track the
# listener is waiting on gets the whole uplink instead of sharing it.
PRIORITY_MEDIA = -1
URGENT_PRIORITY_MAX = int(os.environ.get('URGENT_PRIORITY_MAX', 0))
PREFETCH_GATE = os.environ.get('PREFETCH_GATE', '1') not in ('0', 'false', 'no')
# Cold-start ramp: how far ahead to resolve while the cursor track is still
# downloading, how many new tracks may be resolved per station tick, and a hard
# escape so a track that never finishes can't pin the station at one forever.
PREFETCH_WARMUP_AHEAD = int(os.environ.get('PREFETCH_WARMUP_AHEAD', 1))
PREFETCH_WARMUP_MAX_TICKS = int(os.environ.get('PREFETCH_WARMUP_MAX_TICKS', 15))
TOPUP_BATCH = int(os.environ.get('TOPUP_BATCH', 2))
# Retry / backoff. A permanently broken video (deleted, geo-blocked, 403) used
# to be re-resolved on every Sonos retry; hammering YouTube that way is exactly
# what escalates a 403 into a 429.
DOWNLOAD_ATTEMPTS = int(os.environ.get('DOWNLOAD_ATTEMPTS', 3))
FORBIDDEN_RETRY_DELAY = float(os.environ.get('FORBIDDEN_RETRY_DELAY', 2))
DOWNLOAD_RETRY_COOLDOWN = float(os.environ.get('DOWNLOAD_RETRY_COOLDOWN', 300))
DOWNLOAD_RETRY_COOLDOWN_MAX = float(os.environ.get('DOWNLOAD_RETRY_COOLDOWN_MAX', 3600))
DOWNLOAD_RETRY_MIN = float(os.environ.get('DOWNLOAD_RETRY_MIN', 15))
# ffmpeg watchdogs: no byte growth for this long, or this much wall clock in
# total, and the transcode is killed rather than pinning a worker forever.
# Force yt-dlp onto bounded ranged requests of this size. 0 (the default) lets
# yt-dlp choose, which is normally right. Only worth setting if downloads start
# dying partway through — a symptom of YouTube handing back a URL that serves
# only an opening segment, which in practice has meant yt-dlp itself was stale.
HTTP_CHUNK_SIZE = int(os.environ.get('HTTP_CHUNK_SIZE', 0))
TRANSCODE_STALL_TIMEOUT = float(os.environ.get('TRANSCODE_STALL_TIMEOUT', 120))
TRANSCODE_TIMEOUT = float(os.environ.get('TRANSCODE_TIMEOUT', 1800))
# How long /media waits for a cold download to produce its first bytes.
MEDIA_START_TIMEOUT = float(os.environ.get('MEDIA_START_TIMEOUT', 120))
# Radio mixes barely change minute to minute, so memoising them removes 1-2
# YouTube round-trips per track boundary.
MIX_CACHE_TTL = int(os.environ.get('MIX_CACHE_TTL', 3600))
# Bytes a tail-served download must have on disk before we start responding, so
# Sonos sees the ID3v2 header and a few frames rather than an empty body.
TAIL_START_BYTES = int(os.environ.get('TAIL_START_BYTES', 65536))
# How long /api/play waits for those first bytes before telling the speaker to
# play. Sonos opens /media immediately and abandons a response that doesn't
# arrive within its own (much shorter) patience, so the wait has to happen on
# this side of the Play command.
PLAY_START_TIMEOUT = float(os.environ.get('PLAY_START_TIMEOUT', 45))
# How long to watch for the speaker to actually report PLAYING afterwards, and
# how long to wait before nudging it with a bare Play.
PLAY_CONFIRM_TIMEOUT = float(os.environ.get('PLAY_CONFIRM_TIMEOUT', 6))
PLAY_NUDGE_AFTER = float(os.environ.get('PLAY_NUDGE_AFTER', 1.5))

# Guards STATION, _DOWNLOADS, _INUSE, _MIX_CACHE and _RECENT. Reentrant because
# the station loop holds it while calling helpers that take it again.
_STATE_LOCK = threading.RLock()
_DOWNLOADS = {}          # video_id -> Download
_INUSE = Counter()       # video_id -> active /media readers; blocks eviction
_MIX_CACHE = {}          # video_id -> (fetched_at, entries)
_RECENT = {}             # video_id -> (served_at, title_key)

# YouTube ids are 11 chars of [A-Za-z0-9_-], but keep the check loose and just
# reject anything that could escape CACHE_DIR.
_ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,32}$')

def _format_candidates(info):
    """Every dict that might carry the chosen format's url/http_headers.

    Ordered most-authoritative first: the merged top level, then the explicit
    download list, then the matching entry in `formats`.
    """
    yield info
    for candidate in (info.get('requested_downloads') or []):
        yield candidate
    chosen = info.get('format_id')
    for fmt in (info.get('formats') or []):
        if chosen and fmt.get('format_id') == chosen:
            yield fmt


def _select_format(info):
    """(direct_url, http_headers, description) for the format yt-dlp settled on.

    url and headers are sourced *independently*. They usually travel together,
    but not always — and a URL that arrives without its headers is the worst
    case, because ffmpeg then fetches it as `Lavf/<ver>` and googlevideo answers
    403. Falling back through every candidate is what stops a missing header
    dict from silently costing us the whole track.
    """
    url = headers = None
    for candidate in _format_candidates(info):
        if not isinstance(candidate, dict):
            continue
        if not url and candidate.get('url'):
            url = candidate['url']
        if not headers and candidate.get('http_headers'):
            headers = candidate['http_headers']
        if url and headers:
            break

    if not url:
        # yt-dlp returning no progressive URL usually means YouTube handed back
        # a SABR-only response, which needs a PO token rather than a retry.
        raise RuntimeError(
            'yt-dlp returned no direct audio URL (SABR-only response?) — '
            'this usually needs valid cookies or a PO token provider')

    headers = dict(headers or {})
    desc = (f"format={info.get('format_id')} proto={info.get('protocol')} "
            f"ua={'yes' if any(k.lower() == 'user-agent' for k in headers) else 'NO'} "
            f"cookie={'yes' if any(k.lower() == 'cookie' for k in headers) else 'no'}")
    if not any(k.lower() == 'user-agent' for k in headers):
        # Worth shouting about: this is the exact condition that produces a 403
        # that looks like YouTube being strict rather than us being wrong.
        logger.error(
            f"yt-dlp returned no User-Agent for {info.get('id')} ({desc}); "
            "ffmpeg will fetch as Lavf/* and googlevideo will almost certainly "
            "answer 403.")
    return url, headers, desc


def extract_audio(video_id):
    """Return (direct_audio_url, metadata, http_headers) for a YouTube video id.

    Nothing fetches this URL — yt-dlp downloads the stream itself (see
    `_ffmpeg_cmd`). It is resolved here for the metadata, and the url/headers
    come back only so `Resolved …` logging and probe.py can report what YouTube
    handed us when a download fails.
    """
    url = f"https://www.youtube.com/watch?v={video_id}"
    with yt_dlp.YoutubeDL(ydl_opts(format=AUDIO_FORMAT, noplaylist=True)) as ydl:
        info = ydl.extract_info(url, download=False)
    meta = {
        "video_id": info.get('id', video_id),
        "title": info.get('title'),
        "uploader": info.get('uploader'),
        "thumbnail": info.get('thumbnail'),
        "channel_id": info.get('channel_id'),
        "duration": info.get('duration'),
    }
    direct_url, headers, desc = _select_format(info)
    logger.info(f"Resolved {video_id}: {desc} cookies={'yes' if COOKIES_FILE else 'NO'}")
    return direct_url, meta, headers

def get_radio_mix(video_id, limit=25, refresh=False):
    """Ordered list of track entries from YouTube's autoplay radio mix (RD<id>).

    This is YouTube's own 'up next' / autoplay sequence for a seed video. Each
    entry is a dict with at least 'id', plus 'title'/'channel_id'/'uploader'
    used downstream to keep the station varied (see build_station_queue).

    `refresh` skips the memo and re-asks YouTube. The cache is what makes a
    track boundary cheap, but it also means a seed hands back the byte-identical
    mix for MIX_CACHE_TTL — so the one caller who explicitly wants a different
    set of songs (`refresh_station`) has to be able to bypass it.
    """
    with _STATE_LOCK:
        cached = _MIX_CACHE.get(video_id)
        if not refresh and cached and time.time() - cached[0] < MIX_CACHE_TTL:
            return cached[1]

    mix_url = f"https://www.youtube.com/watch?v={video_id}&list=RD{video_id}"
    try:
        with yt_dlp.YoutubeDL(ydl_opts(extract_flat=True, playlistend=limit)) as ydl:
            info = ydl.extract_info(mix_url, download=False)
        entries = [e for e in (info.get('entries') or []) if e.get('id')]
        if entries:
            with _STATE_LOCK:
                _MIX_CACHE[video_id] = (time.time(), entries)
        return entries
    except Exception as e:
        if _is_bot_error(e):
            logger.error(f"YT-DLP BOT DETECTION fetching radio mix for {video_id}: {e}")
        else:
            logger.error(f"Failed to fetch radio mix for {video_id}: {e}")
        return []

def _artist_key(entry):
    """Stable identity for a track's artist, used to prevent one artist from
    dominating the queue. Prefers the YouTube channel id (unique and reliable);
    falls back to the normalized channel/uploader name, stripping the auto-
    generated ' - Topic' suffix so 'Artist' and 'Artist - Topic' collapse."""
    cid = entry.get('channel_id')
    if cid:
        return cid
    name = (entry.get('uploader') or entry.get('channel') or '').strip()
    name = re.sub(r'\s*[-–]\s*topic$', '', name, flags=re.IGNORECASE)
    return name.casefold() or None

def _title_key(title):
    """Normalize a title so re-uploads of the same song collapse to one key
    (e.g. '... (Official Video)' vs '... [4K Remaster]'). Artist stays in the
    key so two different songs that share a name don't wrongly merge."""
    t = (title or '').casefold()
    t = re.sub(r'\[[^\]]*\]', ' ', t)   # [4K Remaster], [Lyrics], ...
    t = re.sub(r'\([^)]*\)', ' ', t)    # (Official Video), (Audio), ...
    t = re.sub(r'\b(official|video|audio|lyrics?|visualizer|hd|4k|remaster(?:ed)?|mv)\b', ' ', t)
    t = re.sub(r'[^\w\s]', ' ', t)
    t = re.sub(r'\s+', ' ', t).strip()
    return t

def _remember(video_id, title):
    """Record a track as recently served, process-wide.

    `Station.played_ids` dies with its station, so without this a stop-and-play
    on the same seed rebuilds the identical queue: the radio mix is still cached
    and nothing remembers that those tracks just played. Entries expire after
    RECENT_TTL and the map is capped at RECENT_MAX, oldest first, so a station
    left running for days can't starve itself of candidates.
    """
    if not video_id:
        return
    with _STATE_LOCK:
        _RECENT[video_id] = (time.time(), _title_key(title))
        if len(_RECENT) > RECENT_MAX:
            cutoff = time.time() - RECENT_TTL
            for vid, (served, _t) in list(_RECENT.items()):
                if served < cutoff:
                    del _RECENT[vid]
            for vid in sorted(_RECENT, key=lambda v: _RECENT[v][0])[
                    :max(0, len(_RECENT) - RECENT_MAX)]:
                del _RECENT[vid]


def _recent_filters():
    """(ids, title_keys) of tracks served recently enough to skip. Prunes as it reads."""
    cutoff = time.time() - RECENT_TTL
    ids, titles = set(), set()
    with _STATE_LOCK:
        for vid, (served, tkey) in list(_RECENT.items()):
            if served < cutoff:
                del _RECENT[vid]
                continue
            ids.add(vid)
            if tkey:
                titles.add(tkey)
    return ids, titles


def _reseed_ids(played_order):
    """Pick which recently-played tracks to reseed the autoplay mix from.

    Uses the most recent track plus one drawn at random from a little further
    back, so the candidate pool blends 'related to what's playing now' with a
    different point in the walk — this is the main lever against orbiting one
    artist. The second seed is random rather than a fixed offset because a fixed
    one makes the whole walk reproducible: same seed, same mix, same queue."""
    if not played_order:
        return []
    seeds = [played_order[-1]]
    window = played_order[-9:-1]
    if window:
        seeds.append(random.choice(window))
    return seeds

def build_station_queue(seeds, played_ids, played_titles,
                        cooldown_artists=(), max_per_artist=MAX_TRACKS_PER_ARTIST,
                        refresh=False):
    """Build a varied autoplay queue from one or more seed radio mixes.

    Drops already-played tracks and re-uploads of already-played songs, caps how
    many tracks any one artist contributes, then round-robins across artists so
    no artist plays back-to-back. Artists heard recently (cooldown_artists) are
    ordered last, so a fresh artist leads the refill. Returns a list of entries.
    """
    cooldown = set(a for a in cooldown_artists if a)

    # 1. Gather candidates across all seed mixes, deduping by id and by song.
    buckets = {}   # artist_key -> [entries], capped at max_per_artist
    order = []     # artist_keys in first-seen (mix relevance) order
    seen_ids = set()
    seen_titles = set()
    for seed in seeds:
        for e in get_radio_mix(seed, refresh=refresh):
            vid = e.get('id')
            if not vid or vid in played_ids or vid in seen_ids:
                continue
            tkey = _title_key(e.get('title'))
            if tkey and (tkey in played_titles or tkey in seen_titles):
                continue
            seen_ids.add(vid)
            if tkey:
                seen_titles.add(tkey)
            akey = _artist_key(e) or vid  # unknown artist -> treat as unique
            if akey not in buckets:
                buckets[akey] = []
                order.append(akey)
            if len(buckets[akey]) < max_per_artist:
                buckets[akey].append(e)

    # 2. Fresh artists before cooled-down ones (stable sort preserves relevance).
    order.sort(key=lambda a: a in cooldown)

    # 3. Round-robin across artists -> interleaved, no back-to-back same artist.
    queue = []
    while any(buckets[a] for a in order):
        for a in order:
            if buckets[a]:
                queue.append(buckets[a].pop(0))
    return queue

# --- Download cache ----------------------------------------------------------

class _Scheduler:
    """Priority-ordered download dispatcher.

    Replaces a plain ThreadPoolExecutor, which could not do either thing this
    needs. A FIFO executor cannot run the track Sonos is waiting on ahead of
    eight prefetches submitted a moment earlier, and a queued Future can never
    be re-ordered when the listener jumps somewhere else.

    Two properties carry the whole design:

    * The gate is evaluated at *dispatch*, not inside the job. `_take` peeks the
      heap head and, if it is prefetch while an urgent download is in flight,
      parks on the condvar holding nothing. A gated job therefore never occupies
      a worker, so it cannot deadlock the urgent job it is waiting for.
    * Re-prioritising is a dict write plus a heap push. An entry is live only
      while `_pending[vid]` still equals the priority it was pushed with —
      equality, not `<=`, so pushing a *worse* priority also supersedes the old
      entry. That is what makes a backwards jump work, where tracks that were
      one-ahead become six-ahead.

    Lock discipline: `_cv` is a LEAF. Nothing held under it may take
    `_STATE_LOCK` or a `Download.cond`. `_STATE_LOCK -> _Scheduler._cv` is the
    only legal ordering.
    """

    def __init__(self, workers, run):
        self._run = run                 # callable(video_id)
        self._cv = threading.Condition()
        self._heap = []                 # [(priority, seq, video_id)], lazily invalidated
        self._pending = {}              # video_id -> authoritative priority (queued, not started)
        self._running = {}              # video_id -> priority of the in-flight job
        self._seq = itertools.count()
        self._gated = False             # whether the gate has been reported as shut
        for i in range(max(1, workers)):
            threading.Thread(target=self._worker, name=f'dl-{i}',
                             daemon=True).start()

    # -- producer side --------------------------------------------------------

    def submit(self, video_id, priority):
        """Queue a download, or move an already-queued one to `priority`."""
        with self._cv:
            if video_id in self._running:
                return              # already on the wire; too late to re-order
            if self._pending.get(video_id) == priority:
                return              # no-op, so a per-poll call can't grow the heap
            self._pending[video_id] = priority
            heapq.heappush(self._heap, (priority, next(self._seq), video_id))
            self._cv.notify_all()

    def reprioritize(self, video_id, priority):
        """Re-order an already-queued item. Never starts new work.

        Deliberately does not fall back to `submit`: resurrecting every track
        behind the cursor would re-download the whole back window on every poll.
        """
        with self._cv:
            if video_id in self._pending and self._pending[video_id] != priority:
                self._pending[video_id] = priority
                heapq.heappush(self._heap, (priority, next(self._seq), video_id))
                self._cv.notify_all()

    def cancel(self, video_id):
        """Drop a queued (not yet started) job. True if it was dropped."""
        with self._cv:
            return self._pending.pop(video_id, None) is not None

    def snapshot(self):
        """(pending, running) copies for /api/downloads."""
        with self._cv:
            return dict(self._pending), dict(self._running)

    # -- consumer side --------------------------------------------------------

    def _urgent_busy(self):
        return any(p <= URGENT_PRIORITY_MAX for p in self._running.values())

    def _take(self):
        """Block until a job may run, then mark it running and return it."""
        with self._cv:
            while True:
                # Discard superseded entries: an id is live only at the exact
                # priority _pending records for it right now.
                while self._heap:
                    priority, _, vid = self._heap[0]
                    if self._pending.get(vid) == priority:
                        break
                    heapq.heappop(self._heap)
                if self._heap:
                    priority, _, vid = self._heap[0]
                    gated = (PREFETCH_GATE and priority > URGENT_PRIORITY_MAX
                             and self._urgent_busy())
                    if not gated:
                        heapq.heappop(self._heap)
                        del self._pending[vid]
                        self._running[vid] = priority
                        self._gated = False
                        return vid, priority
                    if not self._gated:
                        self._gated = True
                        logger.info("Holding prefetch downloads while the "
                                    "current track finishes")
                # Nothing queued, or the head is prefetch and the gate is shut.
                # The timeout is belt-and-braces against a missed notify.
                self._cv.wait(timeout=1.0)

    def _worker(self):
        while True:
            vid, priority = self._take()
            logger.info(f"Downloading {vid} (priority {priority})")
            try:
                self._run(vid)
            except BaseException:
                logger.exception(f"Download worker crashed on {vid}")
            finally:
                with self._cv:
                    self._running.pop(vid, None)
                    self._cv.notify_all()       # may open the gate


# A download that is queued has not started yet but is every bit as "live" as a
# running one: it must not be evicted, must not be enqueued to Sonos, and a
# reader waiting on it must keep waiting. Treating only 'running' as active is
# the easiest way to introduce a silent hang here.
ACTIVE_STATES = ('queued', 'running')


def _is_active(download):
    return download is not None and download.state in ACTIVE_STATES


class Download:
    """Tracks one queued, in-flight or finished transcode into the cache.

    Readers of a partially written file wait on `cond`, which the downloader
    notifies whenever more bytes land or the state changes.
    """

    def __init__(self, video_id, state='queued'):
        self.video_id = video_id
        self.state = state          # 'queued' | 'running' | 'done' | 'failed'
        self.bytes_written = 0
        self.error = None
        self.meta = None
        # Failure bookkeeping, used by ensure_cached to back off instead of
        # re-resolving a permanently broken video on every Sonos retry.
        self.attempts = 0
        self.failed_at = 0.0
        self.retry_after = 0.0
        self.cond = threading.Condition()

    def begin(self):
        """Mark a queued download as started."""
        with self.cond:
            self.state = 'running'
            self.cond.notify_all()

    def cancel(self):
        """Mark a queued download as abandoned, with no retry penalty.

        Distinct from `finish('failed')`: nothing went wrong with the track, we
        simply stopped wanting it, so it must not carry a cooldown. Leaving it
        `queued` instead would be worse than a leak — `_is_active` would report
        it live forever, stalling `_flush_queue` for any other station that
        still lists the same track.
        """
        with self.cond:
            self.state = 'failed'
            self.error = 'cancelled'
            self.retry_after = 0.0
            self.failed_at = 0.0
            self.cond.notify_all()

    def finish(self, state, error=None, meta=None):
        with self.cond:
            self.state = state
            self.error = error
            if meta:
                self.meta = meta
            if state == 'failed':
                self.attempts += 1
                self.failed_at = time.time()
                self.retry_after = self.failed_at + min(
                    DOWNLOAD_RETRY_COOLDOWN * (2 ** (self.attempts - 1)),
                    DOWNLOAD_RETRY_COOLDOWN_MAX)
            self.cond.notify_all()

    def progress(self, size):
        with self.cond:
            if size != self.bytes_written:
                self.bytes_written = size
                self.cond.notify_all()


def valid_video_id(video_id):
    return bool(video_id) and bool(_ID_RE.match(video_id))


def cache_paths(video_id):
    """(mp3, part, sidecar, thumbnail) paths for a video id."""
    base = os.path.join(CACHE_DIR, video_id)
    return base + '.mp3', base + '.mp3.part', base + '.json', base + '.jpg'


def is_cached(video_id):
    mp3, _, _, _ = cache_paths(video_id)
    return os.path.exists(mp3)


def cached_meta(video_id):
    """Metadata sidecar for a video id, or None.

    Sidecars are never evicted, so a track that falls out of the audio window
    can be re-queued (and its title/duration shown) without asking YouTube.
    """
    _, _, sidecar, _ = cache_paths(video_id)
    try:
        with open(sidecar) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _write_sidecar(video_id, meta, size):
    _, _, sidecar, _ = cache_paths(video_id)
    data = dict(meta, video_id=video_id, bytes=size, ts=int(time.time()))
    tmp = sidecar + '.tmp'
    try:
        with open(tmp, 'w') as fh:
            json.dump(data, fh)
        os.replace(tmp, sidecar)
    except OSError as e:
        logger.warning(f"Could not write cache sidecar for {video_id}: {e}")


def _fetch_thumbnail(video_id, url):
    """Cache the track's artwork locally as JPEG. Best-effort — never fatal.

    Sonos players won't reliably fetch album art from an external https host, so
    artwork has to be served from us alongside the audio.

    yt-dlp's `thumbnail` is often a WebP, which neither Sonos nor the ID3 APIC
    frame handles well, so prefer YouTube's canonical i.ytimg JPEG (hqdefault
    always exists) and verify the JPEG magic before keeping whatever we got.
    """
    _, _, _, jpg = cache_paths(video_id)
    if os.path.exists(jpg):
        return jpg

    candidates = [f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"]
    if url and url not in candidates:
        candidates.append(url)

    for candidate in candidates:
        try:
            req = urllib.request.Request(candidate,
                                         headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = resp.read()
        except Exception as e:
            logger.warning(f"Thumbnail fetch failed for {video_id}: {e}")
            continue
        if not data.startswith(b'\xff\xd8\xff'):
            logger.warning(f"Ignoring non-JPEG artwork for {video_id} "
                           f"({candidate})")
            continue
        tmp = jpg + '.tmp'
        try:
            with open(tmp, 'wb') as fh:
                fh.write(data)
            os.replace(tmp, jpg)
            return jpg
        except OSError as e:
            logger.warning(f"Could not store artwork for {video_id}: {e}")
            return None
    return None


def _ffmpeg_cmd(out_path, meta, art_path, pcm_path=None):
    """ffmpeg command that transcodes the audio on stdin into a tagged mp3.

    ffmpeg deliberately does NOT fetch from googlevideo. It could, when YouTube
    is behaving — but when it is not, the URL yt-dlp hands back can be one that
    serves only an opening segment, or refuses the open-ended `Range: bytes=0-`
    that ffmpeg's HTTP layer opens with. Both were observed in the wild, and
    both surfaced as an opaque ffmpeg 403 that no header or reconnect setting
    could fix. Letting yt-dlp fetch puts every YouTube quirk behind the one
    dependency that gets updated when YouTube changes, and makes failures
    report yt-dlp's own error instead.

    Writes ID3v2 tags (and cover art when we have it) so Sonos can read the
    track's title/artist straight out of the file it pulls from us.

    `pcm_path` adds a second output carrying raw mono PCM, for the Hue beat
    analysis. It rides this transcode rather than getting its own pass because
    ffmpeg is already decoding every frame — the extra output costs one more
    encode of already-decoded audio, where a separate pass over the finished
    mp3 would be a whole second decode. Omitted (and so costing nothing) when
    no Hue bridge is paired.
    """
    cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-i', 'pipe:0']
    if art_path:
        cmd += ['-i', art_path, '-map', '0:a', '-map', '1:v',
                '-c:v', 'copy', '-disposition:v', 'attached_pic']
    else:
        cmd += ['-map', '0:a']
    cmd += [
        '-f', 'mp3',
        '-acodec', 'libmp3lame',
        '-b:a', CACHE_BITRATE,
        '-ac', '2',
        '-ar', '44100',
        '-id3v2_version', '3',
        '-metadata', f"title={meta.get('title') or 'Unknown'}",
        '-metadata', f"artist={meta.get('uploader') or 'YouTube'}",
        '-metadata', 'album=YouTube Radio',
        out_path,
    ]
    if pcm_path:
        # A second output, so it must carry its own -map: ffmpeg applies -map
        # to the output that follows it, and the mp3's maps above are already
        # spent. Appended last so that nothing here can reorder or reinterpret
        # the mp3's arguments, which are the ones playback depends on.
        cmd += analysis.pcm_output_args(pcm_path)
    return cmd


# Runs in a helper process so yt-dlp writes the media to stdout while this
# server stays responsive. Options are handed over as JSON so the child uses
# exactly the same cookies / player-client / js-runtime settings as the parent.
_YTDLP_SINK = r"""
import json, sys, yt_dlp
opts = json.loads(sys.argv[1])
opts.update(outtmpl='-', logtostderr=True, noprogress=True, quiet=True,
            no_warnings=True, noplaylist=True)
with yt_dlp.YoutubeDL(opts) as ydl:
    sys.exit(ydl.download([sys.argv[2]]))
"""


def _ytdlp_source_cmd(video_id):
    """Command that streams one track's raw audio to stdout via yt-dlp.

    `http_chunk_size` keeps yt-dlp on bounded ranged requests, which is what
    googlevideo will actually serve.
    """
    opts = ydl_opts(format=AUDIO_FORMAT)
    if HTTP_CHUNK_SIZE:
        opts['http_chunk_size'] = HTTP_CHUNK_SIZE
    return [sys.executable, '-c', _YTDLP_SINK, json.dumps(opts),
            f"https://www.youtube.com/watch?v={video_id}"]


def _drain(proc, sink):
    """Collect a child's stderr without letting its pipe buffer fill and block."""
    def run():
        try:
            sink.append(proc.stderr.read())
        except Exception:
            pass
    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t


def _run_transcode(download, video_id, out_path, meta, art_path, pcm_path=None):
    """yt-dlp streams the source into ffmpeg, which transcodes it to `out_path`.

    Returns (ok, error). Watchdogged on two axes; the stall timer is the
    important one, because a wedged fetch produces no bytes at all and would
    otherwise pin a download worker forever — and, with the prefetch gate, hold
    every other download off the wire with it.

    The watchdog still measures `out_path`, the mp3, even when a PCM side
    output is attached: progress means bytes the speaker can play, and the PCM
    is a by-product nothing waits on.
    """
    source = subprocess.Popen(_ytdlp_source_cmd(video_id),
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        proc = subprocess.Popen(_ffmpeg_cmd(out_path, meta, art_path, pcm_path),
                                stdin=source.stdout, stdout=subprocess.DEVNULL,
                                stderr=subprocess.PIPE)
    except Exception:
        source.kill()
        source.wait()
        raise
    # The child owns the read end now; if we keep it open ffmpeg never sees EOF.
    source.stdout.close()

    src_err, ff_err = [], []
    readers = [_drain(source, src_err), _drain(proc, ff_err)]
    started_at = last_growth = time.time()
    last_size = 0
    timeout_err = None
    try:
        while proc.poll() is None:
            try:
                size = os.path.getsize(out_path)
            except OSError:
                size = last_size
            if size != last_size:
                last_size, last_growth = size, time.time()
                download.progress(size)
            now = time.time()
            if now - last_growth > TRANSCODE_STALL_TIMEOUT:
                timeout_err = f"stalled for {int(TRANSCODE_STALL_TIMEOUT)}s"
                break
            if now - started_at > TRANSCODE_TIMEOUT:
                timeout_err = f"exceeded {int(TRANSCODE_TIMEOUT)}s"
                break
            time.sleep(0.25)
        try:
            download.progress(os.path.getsize(out_path))
        except OSError:
            pass
    finally:
        for p in (proc, source):
            if p.poll() is None:
                p.terminate()
                try:
                    p.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    p.kill()
                    p.wait()
        for t in readers:
            t.join(timeout=2)

    def text(chunks):
        return (chunks[0] if chunks else b'').decode('utf-8', 'replace').strip()

    if timeout_err:
        return False, f"transcode {timeout_err}"
    if source.returncode not in (0, None) and proc.returncode != 0:
        # yt-dlp is the more informative half when both fail.
        return False, f"yt-dlp failed: {text(src_err)[:400]}"
    if proc.returncode != 0:
        return False, text(ff_err) or f"ffmpeg exited {proc.returncode}"
    if source.returncode not in (0, None):
        return False, f"yt-dlp failed: {text(src_err)[:400]}"
    return True, ''


def _analysis_pcm_path(video_id):
    """Where this track's PCM should go, or None to not capture it at all.

    `auto` (the default) means "on iff a Hue bridge is paired". Capturing costs
    ~2.6 MB of disk per minute of audio plus a librosa pass per track, and a
    deployment with no lights in it should pay neither — but one *with* lights
    should not have to find and set an env var to make the feature work.

    Re-analysis is skipped when a current sidecar already exists, so a track
    that falls out of the audio window and is re-downloaded does not re-run
    analysis that is still on disk (sidecars are never evicted).
    """
    if ANALYZE_MODE in ('0', 'false', 'no', 'off'):
        return None
    # Checked even when forced on: HUE_ANALYZE=1 is a request, not a promise
    # that the dependency got installed, and capturing PCM nothing can read
    # would fill the disk one worker failure at a time.
    if not analysis.available():
        return None
    if ANALYZE_MODE == 'auto' and not hue.is_paired():
        return None
    if analysis.load(CACHE_DIR, video_id) is not None:
        return None
    return analysis.analysis_paths(CACHE_DIR, video_id)[0]


def _download_attempts(download, video_id):
    """Resolve and transcode one track, retrying where a retry can help."""
    mp3, part, _, _ = cache_paths(video_id)
    last_error = None
    forbidden_seen = False
    player_error_seen = False

    for attempt in range(1, DOWNLOAD_ATTEMPTS + 1):
        try:
            # Resolved for metadata only — the URL is never fetched by us. See
            # _ffmpeg_cmd for why yt-dlp has to do the actual download.
            _, meta, _ = extract_audio(video_id)
        except Exception as e:
            if _is_bot_error(e):
                logger.error(f"YT-DLP BOT DETECTION downloading {video_id}: {e}")
                download.finish('failed', BOT_ERROR_MESSAGE)
                return
            last_error = str(e)
            logger.error(f"Extract failed for {video_id} (attempt {attempt}): {e}")
            if _is_player_error(e):
                # A retry re-runs the same extractor against the same YouTube,
                # so the second one fails identically — and three resolves in a
                # row for every track is how a stale extractor turns into a
                # rate-limit block on top. Stop and say what actually fixes it.
                if player_error_seen:
                    logger.error(PLAYER_ERROR_MESSAGE)
                    download.finish('failed', PLAYER_ERROR_MESSAGE)
                    return
                player_error_seen = True
            # Same reasoning as the 403 path below: back-to-back re-resolves are
            # what turn a transient failure into a rate-limit block.
            if attempt < DOWNLOAD_ATTEMPTS:
                time.sleep(FORBIDDEN_RETRY_DELAY)
            continue

        art_path = _fetch_thumbnail(video_id, meta.get('thumbnail'))
        pcm = _analysis_pcm_path(video_id)
        ok, err = _run_transcode(download, video_id, part, meta, art_path, pcm)
        if ok and os.path.exists(part) and os.path.getsize(part) > 0:
            size = os.path.getsize(part)
            os.replace(part, mp3)
            _write_sidecar(video_id, meta, size)
            logger.info(f"Cached {video_id} ({size // 1024} KiB) — {meta.get('title')}")
            # After the track is committed, and never in a way that can fail it.
            # Analysis is for the lights; the speaker does not wait on it.
            if pcm:
                analysis.submit(CACHE_DIR, video_id)
            download.finish('done', meta=meta)
            return

        last_error = err or 'download produced no output'
        logger.error(f"Transcode failed for {video_id} (attempt {attempt}): {last_error}")
        _unlink(part)
        if pcm:
            _unlink(pcm)

        if _is_forbidden_error(last_error):
            # A 403 now means yt-dlp itself could not fetch the stream, which a
            # fresh resolve occasionally fixes (a different format or player
            # client wins the second time). A second one is a real refusal —
            # hammering it only earns us a 429, so stop and let the cooldown
            # hold us back.
            if forbidden_seen:
                logger.error(f"Repeated 403 for {video_id}; giving up")
                download.finish('failed', FORBIDDEN_ERROR_MESSAGE)
                return
            forbidden_seen = True
            time.sleep(FORBIDDEN_RETRY_DELAY)

    download.finish('failed',
                    PLAYER_ERROR_MESSAGE if player_error_seen else last_error)


def _download(video_id):
    """Resolve, transcode and cache one track. Runs on a scheduler worker."""
    with _STATE_LOCK:
        download = _DOWNLOADS.get(video_id)
    # Evicted or superseded between submit and dispatch — nothing to do.
    if download is None or download.state != 'queued':
        return
    download.begin()
    try:
        _download_attempts(download, video_id)
    except BaseException as e:
        logger.exception(f"Downloader crashed for {video_id}")
        download.finish('failed', f"internal error: {e}")
        raise
    finally:
        # Absolute guarantee: no path may leave a Download stuck 'running'. One
        # that does wedges _flush_queue (which stops at the first active track,
        # so the station enqueues nothing ever again) and hangs every /media
        # reader parked on `cond`.
        if download.state == 'running':
            download.finish('failed', 'downloader exited without a result')


def _unlink(path):
    try:
        os.unlink(path)
    except OSError as e:
        if e.errno != errno.ENOENT:
            logger.warning(f"Could not remove {path}: {e}")


_SCHED = _Scheduler(DOWNLOAD_WORKERS, lambda vid: _download(vid))


def _cooldown_blocks(download, priority):
    """True if a previously failed download should not be retried yet.

    Prefetch honours the full backoff. An urgent request — a speaker with an
    open socket, or the track under the cursor — only honours a short floor, so
    "the listener jumped back to that track" still retries promptly while
    Sonos's own rapid retries of a failed stream don't turn into a yt-dlp storm.
    """
    if priority <= URGENT_PRIORITY_MAX:
        return time.time() - download.failed_at < DOWNLOAD_RETRY_MIN
    return time.time() < download.retry_after


def ensure_cached(video_id, priority=WINDOW_AHEAD):
    """Return the Download for a track, starting one if needed. Idempotent.

    `priority` is distance from what the speaker needs: PRIORITY_MEDIA for an
    open /media socket, 0 for the track under the cursor, N for N tracks ahead.
    Lower wins. Calling this again for an already-queued track re-orders it
    rather than starting a second download.
    """
    if not valid_video_id(video_id):
        raise ValueError(f"Invalid video id: {video_id!r}")
    with _STATE_LOCK:
        existing = _DOWNLOADS.get(video_id)
        if _is_active(existing):
            _SCHED.submit(video_id, priority)   # no-op once it's on the wire
            return existing
        if is_cached(video_id):
            done = Download(video_id, state='done')
            done.meta = cached_meta(video_id)
            done.bytes_written = os.path.getsize(cache_paths(video_id)[0])
            _DOWNLOADS[video_id] = done
            return done
        attempts = 0
        if existing is not None and existing.state == 'failed':
            if _cooldown_blocks(existing, priority):
                return existing
            attempts = existing.attempts
        download = Download(video_id)           # state='queued'
        download.attempts = attempts
        _DOWNLOADS[video_id] = download
    _SCHED.submit(video_id, priority)
    return download


def cache_status(video_id):
    """'done' | 'queued' | 'running' | 'failed' | 'missing' for the UI/station."""
    with _STATE_LOCK:
        download = _DOWNLOADS.get(video_id)
        if _is_active(download):
            return download.state
    if is_cached(video_id):
        return 'done'
    return download.state if download else 'missing'


def cache_scan():
    """Reconcile CACHE_DIR at startup: drop partials, backfill missing sidecars."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    partials = kept = 0
    for name in os.listdir(CACHE_DIR):
        path = os.path.join(CACHE_DIR, name)
        if name.endswith('.part') or name.endswith('.tmp'):
            _unlink(path)
            partials += 1
        elif name.endswith('.mp3'):
            kept += 1
            video_id = name[:-4]
            if cached_meta(video_id) is None:
                _write_sidecar(video_id, {'title': video_id},
                               os.path.getsize(path))
    logger.info(f"Cache at {CACHE_DIR}: {kept} track(s) ready, "
                f"{partials} partial file(s) cleaned up")

# --- Sonos queue -------------------------------------------------------------

STATION_POLL_INTERVAL = float(os.environ.get('STATION_POLL_INTERVAL', 2))
# Consecutive STOPPED polls before a station shuts itself down, so an idle
# server stops talking to YouTube and the speaker.
STATION_IDLE_POLLS = int(os.environ.get('STATION_IDLE_POLLS', 150))

STATION = {}      # device_ip -> Station
_GENERATION = 0   # bumped on every /api/play so stale station loops exit


def _coordinator(speaker):
    """Queue and transport commands must go to the group coordinator."""
    try:
        return speaker.group.coordinator or speaker
    except Exception:
        return speaker


def media_url(video_id):
    return f"http://{STREAM_HOST}:{PORT}/media/{video_id}.mp3"


def art_url(video_id):
    return f"http://{STREAM_HOST}:{PORT}/media/{video_id}.jpg"


def _hhmmss(seconds):
    try:
        total = int(seconds)
    except (TypeError, ValueError):
        return None
    if total <= 0:
        return None
    return f"{total // 3600}:{(total % 3600) // 60:02d}:{total % 60:02d}"


def didl_for(meta):
    """DIDL-Lite item describing one cached track for the Sonos queue.

    Sonos takes the displayed duration from `res@duration`, not from the
    response's Content-Length — which is what lets a still-downloading track
    show the right length.
    """
    vid = meta.get('video_id')
    _, _, _, jpg = cache_paths(vid)
    resource = DidlResource(
        uri=media_url(vid),
        protocol_info='http-get:*:audio/mpeg:*',
        duration=_hhmmss(meta.get('duration')),
    )
    artist = meta.get('uploader') or 'YouTube'
    extra = {}
    # Only set album art when we actually have the file: DidlObject stringifies
    # whatever it's given, so passing None emits a literal <albumArtURI>None.
    if os.path.exists(jpg):
        extra['album_art_uri'] = art_url(vid)
    return DidlMusicTrack(
        title=meta.get('title') or vid,
        parent_id='Q:0',
        item_id=f"yt-{vid}",
        resources=[resource],
        creator=artist,
        artist=artist,
        album='YouTube Radio',
        **extra,
    )


def enqueue(coordinator, meta, position=0):
    """Add one track to the speaker's queue; returns its 1-based position.

    `position` is 1-based and defaults to 0, which appends. Passing one inserts
    there and pushes everything after it down a slot.
    """
    return coordinator.add_to_queue(didl_for(meta), position=position)


def _queue_position(coordinator):
    """1-based position of the playing track in the speaker's queue, or 0.

    Sonos answers 'NOT_IMPLEMENTED' for some transports, and 0/'' when what is
    playing isn't a queue item at all (line-in, TV, a radio stream) — in which
    case there is no 'after this one' to insert into.
    """
    try:
        return int(coordinator.get_current_track_info().get(
            'playlist_position') or 0)
    except (TypeError, ValueError, AttributeError):
        return 0

# --- Station: the server-side view of what's queued and what's cached --------

class Station:
    """Ordered track list backing one speaker's Sonos queue.

    `tracks` is the authoritative sequence; `enqueued` is how many of them the
    speaker actually has (a track is only enqueued once its download finishes,
    apart from the seed, which is enqueued immediately so playback starts fast).
    Index `i < enqueued` is queue position `i + 1` on the speaker, which is what
    lets a play-next insert put a track in both lists at the same spot.

    `lock` serialises the two writers that can reorder those lists — the station
    loop's `_flush_queue` and a play-next insert from the request thread. It is
    taken *outside* `_STATE_LOCK` (`_flush_queue` reads `cache_status` under it),
    so the order is station.lock -> _STATE_LOCK -> _Scheduler._cv.
    """

    def __init__(self, device_ip, generation):
        self.lock = threading.RLock()
        self.device_ip = device_ip
        self.generation = generation
        self.tracks = []
        self.enqueued = 0
        self.index = 0
        self.played_ids = set()
        self.played_titles = set()
        self.played_order = []
        self.artist_history = []
        self.exhausted = False
        self.idle_polls = 0
        self.ticks = 0
        # Nothing is prefetched until the speaker reports PLAYING: resolving the
        # next track costs yt-dlp round trips (and its download costs uplink)
        # that the seed the listener is waiting on should have to itself.
        self.playing_seen = False

    def add(self, entry, at=None):
        """Add a track and update the anti-repeat filters.

        Accepts either a flat radio-mix entry (keyed 'id') or resolved metadata
        (keyed 'video_id'). Appends by default; `at` inserts at that index (a
        play-next request), which is only safe under `self.lock` because it
        renumbers every track after it in both `tracks` and the Sonos queue.
        """
        vid = entry.get('id') or entry.get('video_id')
        meta = {
            'video_id': vid,
            'title': entry.get('title'),
            'uploader': entry.get('uploader') or entry.get('channel'),
            'thumbnail': entry.get('thumbnail'),
            'channel_id': entry.get('channel_id'),
            'duration': entry.get('duration'),
        }
        if at is None:
            self.tracks.append(meta)
        else:
            self.tracks.insert(at, meta)
        self.played_ids.add(vid)
        self.played_order.append(vid)
        tkey = _title_key(meta['title'])
        if tkey:
            self.played_titles.add(tkey)
        # Every track that ever enters a station passes through here, which
        # makes this the one place the process-wide memory can be kept honest.
        _remember(vid, meta['title'])
        self.artist_history.append(_artist_key(entry) or vid)
        return meta


def _pick_next(station, refresh=False):
    """Next track for the station, excluding anything heard recently.

    Filters are applied as a ladder, loosest constraint dropped first, so a full
    recent-memory can slow the station down but never stall it:

      1. the station's own played sets *plus* the process-wide recent memory;
      2. the station's sets alone (this station has still never repeated);
      3. ids only, artist cap lifted — the last resort before 'exhausted'.

    The result is drawn at random from the top STATION_PICK_POOL candidates
    rather than always taking the best one: build_station_queue is deterministic,
    so `queue[0]` walks an identical path every time a seed comes back around.
    """
    seeds = _reseed_ids(station.played_order)
    if not seeds:
        return None
    cooldown = station.artist_history[-ARTIST_COOLDOWN:]
    recent_ids, recent_titles = _recent_filters()
    queue = build_station_queue(seeds,
                                station.played_ids | recent_ids,
                                station.played_titles | recent_titles,
                                cooldown_artists=cooldown, refresh=refresh)
    if not queue:
        queue = build_station_queue(seeds, station.played_ids,
                                    station.played_titles,
                                    cooldown_artists=cooldown)
    if not queue:
        # Nothing new under the artist cap — relax the cap and the title filter
        # one last time before declaring the station exhausted.
        queue = build_station_queue(seeds, station.played_ids, set(),
                                    cooldown_artists=cooldown, max_per_artist=99)
    if not queue:
        return None
    return random.choice(queue[:STATION_PICK_POOL])


def _prefetch_target(station):
    """How far ahead to resolve on this tick.

    While the track under the cursor is still downloading we keep the lookahead
    tiny. Resolving a track means yt-dlp round trips, and those happen
    synchronously in the station loop, competing with the very download the
    listener is waiting on. The tick bound is a hard escape so a track that
    never finishes — a live stream, a wedged transcode — can't pin the station
    at one track forever.
    """
    station.ticks += 1
    if station.ticks > PREFETCH_WARMUP_MAX_TICKS or not station.tracks:
        return WINDOW_AHEAD
    current = station.tracks[min(station.index, len(station.tracks) - 1)]
    if cache_status(current['video_id']) in ACTIVE_STATES:
        return max(1, PREFETCH_WARMUP_AHEAD)
    return WINDOW_AHEAD


def _track_priority(station, i):
    """Scheduler priority for the track at index `i`. Lower is more urgent.

    Ahead of the cursor, priority is simply the distance. Behind it, the track
    has already been passed, so it sorts *after* the whole lookahead window —
    nearest-behind first, in case the listener presses Prev. Clamping those to 0
    instead would mark every skipped-but-still-queued track as urgent, and on a
    forward jump they'd all bypass the prefetch gate at once, which is the exact
    network flood the gate exists to prevent.
    """
    if i >= station.index:
        return i - station.index
    return WINDOW_AHEAD + (station.index - i)


def _reprioritize(station):
    """Re-order queued downloads around the cursor. Never starts new work.

    Only touches jobs already pending in the scheduler, so it is safe to call
    every poll: going through ensure_cached instead would re-create a Download
    for every evicted track behind the cursor and re-download the whole back
    window on each tick.
    """
    for i, meta in enumerate(station.tracks):
        _SCHED.reprioritize(meta['video_id'], _track_priority(station, i))


def _top_up(station, refresh=False):
    """Keep tracks resolved and downloading ahead of the cursor.

    Capped at TOPUP_BATCH per tick, and ramped by `_prefetch_target`, so a cold
    start doesn't resolve and submit the whole WINDOW_AHEAD in one burst while
    the seed is still trying to stream.

    `refresh` re-asks YouTube for the seed mixes on the *first* pick only — one
    refetch is enough to replace the memoised mix that every later pick then
    reads, and asking again per pick would just spend round trips on data we
    already refreshed a moment ago.
    """
    target = _prefetch_target(station)
    added = 0
    while (len(station.tracks) - station.index - 1 < target
           and added < TOPUP_BATCH):
        entry = _pick_next(station, refresh=refresh and added == 0)
        if not entry:
            if not station.exhausted:
                logger.info(f"Autoplay mix exhausted for {station.device_ip}; "
                            f"{len(station.tracks)} track(s) queued")
                station.exhausted = True
            return
        station.exhausted = False
        meta = station.add(entry)
        added += 1
        try:
            ensure_cached(meta['video_id'],
                          priority=_track_priority(station, len(station.tracks) - 1))
        except ValueError as e:
            logger.warning(f"Skipping unusable track: {e}")
            station.tracks.pop()


def _flush_queue(station, coordinator):
    """Enqueue finished downloads, in order, and drop ones that failed.

    Order matters: a track is only handed to Sonos once every track before it
    is already on the queue, so queue positions stay aligned with `tracks`. The
    lock keeps a concurrent play-next insert from shifting `tracks` between the
    lookup below and the `add_to_queue` that appends it, which would leave the
    two lists off by one for the rest of the session.
    """
    with station.lock:
        _flush_queue_locked(station, coordinator)


def _flush_queue_locked(station, coordinator):
    while station.enqueued < len(station.tracks):
        meta = station.tracks[station.enqueued]
        vid = meta['video_id']
        status = cache_status(vid)
        if status in ACTIVE_STATES:
            return          # preserve ordering; try again next poll
        if status in ('failed', 'missing'):
            if station.enqueued <= station.index:
                # Already reached by playback — leave it alone, the media route
                # will retry the download when Sonos asks for it.
                station.enqueued += 1
                continue
            logger.warning(f"Dropping {vid} from station: download {status}")
            station.tracks.pop(station.enqueued)
            continue
        sidecar = cached_meta(vid)
        if sidecar:
            for key in ('title', 'uploader', 'thumbnail', 'duration', 'channel_id'):
                if sidecar.get(key):
                    meta[key] = sidecar[key]
        try:
            enqueue(coordinator, meta)
        except Exception as e:
            logger.error(f"Failed to enqueue {vid}: {e}")
            return
        station.enqueued += 1


def _evict(station):
    """Delete cached audio outside current-WINDOW_BEHIND .. current+WINDOW_AHEAD."""
    lo = max(0, station.index - WINDOW_BEHIND)
    hi = station.index + WINDOW_AHEAD + 1
    keep = {t['video_id'] for t in station.tracks[lo:hi]}
    try:
        names = os.listdir(CACHE_DIR)
    except OSError:
        return
    for name in names:
        if not name.endswith('.mp3'):
            continue
        vid = name[:-4]
        if vid in keep:
            continue
        with _STATE_LOCK:
            if _INUSE.get(vid):
                continue    # Sonos is reading it right now
            download = _DOWNLOADS.get(vid)
            if _is_active(download):
                continue
            _DOWNLOADS.pop(vid, None)
        _unlink(os.path.join(CACHE_DIR, name))
        logger.info(f"Evicted {vid} from cache (outside the "
                    f"-{WINDOW_BEHIND}/+{WINDOW_AHEAD} window)")


def _station_loop(device_ip, generation):
    """Follow the speaker's queue position; prefetch ahead and evict behind.

    Sonos advances its own queue, so this has to run independently of any
    browser being connected — the SSE stream can't be the driver.
    """
    logger.info(f"Station loop started for {device_ip} (gen {generation})")
    while True:
        with _STATE_LOCK:
            station = STATION.get(device_ip)
        if station is None or station.generation != generation:
            logger.info(f"Station loop for {device_ip} (gen {generation}) exiting")
            return

        try:
            coordinator = _coordinator(soco.SoCo(device_ip))
            state = coordinator.get_current_transport_info().get(
                'current_transport_state')
            # _queue_position swallows the 'NOT_IMPLEMENTED' some transports
            # answer with: parsing that unguarded would raise before
            # _top_up/_flush_queue/_evict ever run, silently killing every tick.
            position = _queue_position(coordinator)
            if position > 0 and station.tracks:
                station.index = min(position - 1, len(station.tracks) - 1)
                _reprioritize(station)

            if state == 'PLAYING' and not station.playing_seen:
                station.playing_seen = True
                logger.info(f"Playback started on {device_ip}; prefetching ahead")

            if state == 'STOPPED':
                station.idle_polls += 1
                if station.idle_polls >= STATION_IDLE_POLLS:
                    logger.info(f"Station on {device_ip} idle; shutting it down")
                    end_station(device_ip)
                    return
            else:
                station.idle_polls = 0
                if station.playing_seen:
                    # Under the station lock like the other writer of `tracks`:
                    # a refresh truncating the list mid-append would leave it
                    # holding tracks the speaker's queue no longer has.
                    with station.lock:
                        _top_up(station)
                _flush_queue(station, coordinator)
                _evict(station)
        except Exception as e:
            logger.warning(f"Station loop error for {device_ip}: {e}")

        time.sleep(STATION_POLL_INTERVAL)


def start_station(device_ip, seed_meta):
    """Replace any station on this speaker with a fresh one seeded by a track.

    The monitor thread is deliberately *not* started here — the caller must
    enqueue the seed and start playback first, then call `run_station`. Starting
    it earlier races the caller: the loop would enqueue an already-cached seed
    that the caller is about to enqueue itself, putting it on the queue twice.
    """
    global _GENERATION
    with _STATE_LOCK:
        _GENERATION += 1
        station = Station(device_ip, _GENERATION)
        station.add(seed_meta)
        STATION[device_ip] = station
    return station


def run_station(station):
    """Start the monitor thread for a station whose seed is already playing."""
    threading.Thread(target=_station_loop,
                     args=(station.device_ip, station.generation),
                     name=f"station-{station.device_ip}", daemon=True).start()


def end_station(device_ip):
    """Tear down a station and drop its not-yet-started downloads.

    Cancelling the backlog matters on restart: without it a fresh /api/play
    competes for the uplink with a queue of prefetches for tracks nobody is
    going to hear. Running downloads are left alone — a /media reader may be
    tail-serving one right now.
    """
    with _STATE_LOCK:
        station = STATION.pop(device_ip, None)
        if station is None:
            return
        # Another speaker may be queued on the same track — radio mixes overlap
        # heavily — and cancelling it out from under that station would stall it.
        wanted = {m['video_id'] for other in STATION.values()
                  for m in other.tracks}
        for meta in station.tracks:
            vid = meta['video_id']
            if vid in wanted:
                continue
            if _SCHED.cancel(vid):
                download = _DOWNLOADS.get(vid)
                if download is not None and download.state == 'queued':
                    download.cancel()


def refresh_station(coordinator, station):
    """Drop everything queued after the playing track and refill it anew.

    Returns how many tracks were discarded, or None when the speaker isn't
    playing from its queue (line-in, TV, a radio stream) and there is therefore
    no tail to replace.

    The playing track is deliberately left alone: a refresh is 'the rest of this
    is stale', not 'stop what you're doing'. That is also what makes trimming
    the Sonos queue safe here, despite the standing rule that it is never
    trimmed mid-session — removing items renumbers `playlist_position`, but only
    for items *after* the removal point, and everything removed here is already
    past the cursor. Items go furthest-first so each removal can't renumber the
    ones still to be removed.

    A removal the speaker rejects stops the truncation right there rather than
    letting `tracks` shrink past what the queue actually holds: an off-by-one
    between the two lists misaligns every position calculation for the rest of
    the session.

    `played_ids` / `played_titles` / `_RECENT` are all left intact, which is
    precisely why the refill is new — the discarded tracks stay excluded.
    """
    with station.lock:
        position = _queue_position(coordinator)
        if position <= 0 or not station.tracks:
            return None
        cursor = min(position - 1, len(station.tracks) - 1)
        if cursor >= station.enqueued:
            # The speaker is past what we ever enqueued: our list and its queue
            # have drifted, and trimming on that assumption would leave items on
            # the queue that `tracks` no longer knows about.
            logger.warning(f"Station on {station.device_ip} is behind the "
                           f"speaker (cursor {cursor}, {station.enqueued} "
                           f"enqueued); not refreshing")
            return None
        station.index = cursor

        keep = cursor + 1
        for i in range(station.enqueued - 1, cursor, -1):
            try:
                coordinator.remove_from_queue(i)
            except Exception as e:
                logger.warning(f"Could not remove queue item {i} on "
                               f"{station.device_ip}: {e}; keeping the rest")
                keep = i + 1
                break

        dropped = station.tracks[keep:]
        del station.tracks[keep:]
        station.enqueued = min(station.enqueued, keep)
        station.exhausted = False

        # Re-order `played_order` so its tail is what actually survived. It is
        # only read by `_reseed_ids`, and its last entry is the primary seed —
        # left alone, the refill would be built out of the radio mix of a track
        # the listener has just thrown away. Discarded ids stay in the list (and
        # in `played_ids`) so they remain excluded.
        survivors = [m['video_id'] for m in station.tracks]
        surviving = set(survivors)
        station.played_order = [v for v in station.played_order
                                if v not in surviving] + survivors

        # Cancel the discarded tracks' pending downloads, with end_station's
        # guards: never touch one another station still lists or a /media reader
        # is on, and cancel (penalty-free) rather than fail them.
        with _STATE_LOCK:
            wanted = {m['video_id'] for other in STATION.values()
                      for m in other.tracks}
            for meta in dropped:
                vid = meta['video_id']
                if vid in wanted or _INUSE.get(vid):
                    continue
                if _SCHED.cancel(vid):
                    download = _DOWNLOADS.get(vid)
                    if download is not None and download.state == 'queued':
                        download.cancel()

        logger.info(f"Refreshing station on {station.device_ip}: dropped "
                    f"{len(dropped)} track(s) after position {cursor + 1}")
        # refresh=True so the seeds' memoised radio mixes are re-fetched: a
        # brand-new set of songs can't come out of the same cached mix.
        _top_up(station, refresh=True)

    _flush_queue(station, coordinator)
    return len(dropped)


PLAYING_STATES = ('PLAYING', 'TRANSITIONING')


def _transport_state(coordinator):
    """'PLAYING' / 'PAUSED_PLAYBACK' / 'STOPPED' / 'TRANSITIONING', or None."""
    try:
        return (coordinator.get_current_transport_info() or {}).get(
            'current_transport_state')
    except Exception as e:
        logger.warning(f"Could not read transport state: {e}")
        return None


def _is_playing(coordinator):
    return _transport_state(coordinator) in PLAYING_STATES


def _wait_for_first_bytes(download, timeout=PLAY_START_TIMEOUT):
    """Wait until a download has enough bytes for /media to answer at once.

    Sonos opens /media the instant it is told to play, and hangs up long before
    our own MEDIA_START_TIMEOUT is up — so a cold seed (yt-dlp resolve, deno,
    ffmpeg startup: tens of seconds) means the speaker abandons the stream and
    sits on the track without playing it, which is exactly what "nothing
    happens until I press play myself" looks like. Waiting here instead puts
    that time under the Play button's spinner, where it costs nothing.
    """
    if download is None:
        return False
    deadline = time.time() + timeout
    with download.cond:
        while (download.state in ACTIVE_STATES
               and download.bytes_written < TAIL_START_BYTES
               and time.time() < deadline):
            download.cond.wait(timeout=0.5)
        ready = (download.bytes_written >= TAIL_START_BYTES
                 or download.state == 'done')
        state, written = download.state, download.bytes_written
    if not ready:
        logger.warning(f"Seed still has {written} byte(s) after {timeout:.0f}s "
                       f"(download {state}); telling the speaker to play anyway")
    return ready


def _ensure_playing(coordinator, timeout=PLAY_CONFIRM_TIMEOUT):
    """Confirm the speaker really started, nudging it once with a bare Play.

    `play_from_queue` sets the transport URI and sends Play in one go, but a
    speaker that was mid-transition (or that just gave up on a stream) can land
    on the track without starting it. TRANSITIONING is left alone — it means the
    speaker is already opening the stream.
    """
    start = time.time()
    nudged = False
    while time.time() - start < timeout:
        state = _transport_state(coordinator)
        if state == 'PLAYING':
            return True
        if (not nudged and state != 'TRANSITIONING'
                and time.time() - start >= PLAY_NUDGE_AFTER):
            nudged = True
            logger.info(f"Speaker is {state} after Play; sending an explicit Play")
            try:
                coordinator.play()
            except Exception as e:
                logger.warning(f"Follow-up Play failed: {e}")
        time.sleep(0.4)
    logger.warning("Speaker never reported PLAYING after the play command")
    return False


def _queue_after_current(coordinator, device_ip, seed):
    """Insert `seed` right after the playing track instead of interrupting it.

    Returns the 1-based queue position it landed at, or None when there is
    nothing to insert after (the speaker isn't playing from its queue), which
    tells the caller to start a fresh station instead.

    The track is queued at priority 1 — one ahead of the cursor, exactly what
    the station loop would give it. The listener isn't waiting on it, so it
    stays behind the prefetch gate, and if the speaker reaches it before the
    download finishes /media tail-serves whatever has landed.

    ensure_cached is deliberately called only once the insert is certain: a
    download started on a path that then falls back to a fresh play would be
    cancelled by `end_station` moments later.
    """
    position = _queue_position(coordinator)
    if position <= 0:
        return None

    video_id = seed['video_id']
    with _STATE_LOCK:
        station = STATION.get(device_ip)
    if station is None or not station.tracks:
        # Nothing of ours is following this queue — a one-shot play, another
        # source, or an app restart. Drop the track in and leave it there.
        ensure_cached(video_id, priority=1)
        return enqueue(coordinator, seed, position=position + 1)

    with station.lock:
        # Re-read the position under the lock: waiting out a `_flush_queue`
        # costs UPnP round trips, and a track boundary crossed in that window
        # would have us insert *behind* what is now playing — where it would
        # sit unheard until the queue wrapped.
        position = _queue_position(coordinator) or position
        cursor = min(position - 1, len(station.tracks) - 1)
        at = cursor + 1
        if at > station.enqueued:
            # Our track list and the speaker's queue have drifted apart;
            # inserting on that assumption would misalign them for good.
            logger.warning(f"Station on {device_ip} is behind the speaker "
                           f"(cursor {cursor}, {station.enqueued} enqueued); "
                           f"starting a fresh station instead")
            return None
        ensure_cached(video_id, priority=1)
        station.index = cursor
        meta = station.add(seed, at=at)
        try:
            slot = enqueue(coordinator, meta, position=at + 1)
        except Exception:
            station.tracks.pop(at)
            raise
        station.enqueued += 1
        # Everything after the insert moved one slot further from the cursor.
        _reprioritize(station)
    return slot


def station_payload(station):
    """Station view for the UI: the ordered list plus per-track cache status."""
    if station is None:
        return {"index": 0, "tracks": [], "exhausted": False}
    tracks = []
    for i, meta in enumerate(station.tracks):
        tracks.append({
            "id": meta['video_id'],
            "title": meta.get('title'),
            "uploader": meta.get('uploader'),
            "thumbnail": meta.get('thumbnail'),
            "duration": meta.get('duration'),
            "cached": cache_status(meta['video_id']),
            "queue_pos": i + 1 if i < station.enqueued else None,
        })
    return {"index": station.index, "tracks": tracks,
            "exhausted": station.exhausted}

@app.route('/')
def index():
    """An index, not a UI. The frontend is a separate Next.js app in `web/`.

    This used to render `templates/index.html`. It answers with JSON instead of
    404 because the people who reach it are almost all arriving on a stale
    bookmark of the old UI, and a bare 404 tells them the server is broken when
    it is running perfectly — the page simply moved to another port. Naming the
    frontend and the endpoints costs one dict and turns that dead end into
    directions.
    """
    return jsonify({
        "service": "youtube-to-sonos",
        "kind": "api",
        "frontend": "Next.js app in web/ — run `pnpm dev` there, or see docker-compose.yml",
        "docs": "API.md",
        # A set, because /api/volume is two rules — GET and POST are registered
        # separately — and listing it twice reads as a bug in the API rather
        # than in the listing.
        "endpoints": sorted({
            str(rule) for rule in app.url_map.iter_rules()
            if str(rule).startswith('/api/')
        }),
    })

@app.route('/api/health', methods=['GET'])
def health():
    """Liveness and configuration. Touches no network, so it answers even when
    SSDP discovery or YouTube is failing.

    That is the point: without it the only way to ask "is the backend up" is
    /api/devices, which runs a multicast scan and takes seconds — so a frontend
    cannot tell "backend down" from "backend fine, no speakers" from "backend
    fine, YouTube angry". Each needs a different message to the listener.
    """
    ytdlp = _ytdlp_status()
    with _STATE_LOCK:
        stations = len(STATION)
    return jsonify({
        "status": "ok",
        "stream_host": STREAM_HOST,
        "port": PORT,
        "ytdlp_version": ytdlp['version'],
        "ytdlp_age_days": ytdlp['age_days'],
        "ytdlp_stale": ytdlp['stale'],
        "js_runtimes": ytdlp['js_runtimes'],
        # The value resolved once at import, not a re-probe: _resolve_cookiefile
        # copies the jar and logs on every call, which a polled endpoint must not do.
        "cookies": bool(COOKIES_FILE),
        "stations": stations,
        "cache_dir": CACHE_DIR,
    })


@app.route('/api/devices', methods=['GET'])
def get_devices():
    try:
        logger.info("Scanning for Sonos devices via SSDP...")
        devices = soco.discover()
        if not devices:
            logger.info("No Sonos devices found.")
            return jsonify([])
        
        device_list = []
        for dev in devices:
            try:
                device_list.append({
                    'name': dev.player_name,
                    'ip': dev.ip_address
                })
            except Exception as e:
                logger.error(f"Error reading device info: {e}")
        
        logger.info(f"Discovered devices: {device_list}")
        return jsonify(device_list)
    except Exception as e:
        logger.error(f"SSDP discovery failed: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/info', methods=['GET'])
def get_info():
    url = request.args.get('url')
    if not url:
        return jsonify({"error": "Missing URL parameter"}), 400
    
    try:
        logger.info(f"Fetching metadata for URL: {url}")
        with yt_dlp.YoutubeDL(ydl_opts(format=AUDIO_FORMAT, noplaylist=True)) as ydl:
            info = ydl.extract_info(url, download=False)
            return jsonify({
                'title': info.get('title'),
                'duration': info.get('duration'),
                'thumbnail': info.get('thumbnail'),
                'id': info.get('id'),
                'uploader': info.get('uploader')
            })
    except Exception as e:
        return _yt_error_response(e, "metadata fetch")

def _video_id_from_url(url):
    """Video id from any YouTube URL form, without calling YouTube."""
    m = re.search(r'(?:v=|youtu\.be/|/shorts/|/embed/)([A-Za-z0-9_-]{11})', url)
    if m:
        return m.group(1)
    return url if valid_video_id(url) and len(url) == 11 else None


def _resolve_seed_meta(url):
    """Metadata for the seed track, preferring the cache over a YouTube call."""
    video_id = _video_id_from_url(url)
    if video_id:
        sidecar = cached_meta(video_id)
        if sidecar and sidecar.get('title'):
            logger.info(f"Seed {video_id} resolved from cache sidecar")
            return sidecar
    with yt_dlp.YoutubeDL(ydl_opts(format=AUDIO_FORMAT, noplaylist=True)) as ydl:
        info = ydl.extract_info(url, download=False)
    return {
        'video_id': info.get('id') or video_id,
        'title': info.get('title'),
        'uploader': info.get('uploader'),
        'thumbnail': info.get('thumbnail'),
        'channel_id': info.get('channel_id'),
        'duration': info.get('duration'),
    }


@app.route('/api/play', methods=['POST'])
def play():
    """Play the seed now, or queue it next if the speaker is already playing.

    Playing now starts the seed download and waits for its first bytes before
    clearing the speaker's queue, so whatever was playing covers the resolve +
    transcode startup instead of the speaker falling silent for it. The seed is
    then served while the rest of it downloads, so playback starts without
    waiting for the whole file, and the station loop fills the queue ahead of
    the cursor with already-downloaded tracks.

    Queueing next instead inserts the seed directly after the current track and
    downloads it in the background, so it plays the moment that track ends and
    nothing is interrupted. `mode` picks: 'now' always restarts, 'next' always
    queues (falling back to 'now' when the speaker has nothing to queue behind),
    and 'auto' — the default for API callers; the UI always sends one of the
    other two — queues next whenever the speaker is already playing.
    """
    data = request.get_json() or {}
    url = data.get('url')
    device_ip = data.get('device_ip')
    autoplay = data.get('autoplay', True)
    mode = (data.get('mode') or 'auto').lower()

    if not url:
        return jsonify({"error": "Missing URL parameter"}), 400
    if mode not in ('auto', 'now', 'next'):
        return jsonify({"error": f"Unknown mode: {mode!r}"}), 400

    try:
        logger.info(f"Preparing to play {url} (autoplay={autoplay}, mode={mode})")
        seed = _resolve_seed_meta(url)
        video_id = seed.get('video_id')
        if not video_id:
            return jsonify({"error": "Could not extract video ID"}), 400

        if not device_ip:
            logger.info("No device_ip specified, discovering first available Sonos device...")
            devices = list(soco.discover() or [])
            if not devices:
                return jsonify({"error": "No Sonos devices discovered on network"}), 404
            speaker = devices[0]
            device_ip = speaker.ip_address
        else:
            logger.info(f"Connecting to Sonos device at IP: {device_ip}")
            speaker = soco.SoCo(device_ip)
        coordinator = _coordinator(speaker)

        # Don't cut off a song that's already playing: queue the new track as
        # the next one instead and let it download while that song finishes.
        if mode == 'next' or (mode == 'auto' and _is_playing(coordinator)):
            slot = _queue_after_current(coordinator, device_ip, seed)
            if slot is not None:
                logger.info(f"Queued '{seed.get('title')}' ({video_id}) next on "
                            f"'{speaker.player_name}' ({device_ip}) at queue "
                            f"position {slot}")
                return jsonify({
                    "status": "queued",
                    "queued_next": True,
                    "queue_position": slot,
                    "device": speaker.player_name,
                    "device_ip": device_ip,
                    "stream_url": media_url(video_id),
                    "autoplay": autoplay,
                    "video_id": video_id,
                    "title": seed.get('title')
                })
            # Nothing playable to queue behind — fall through and start it now.

        # Tear the old station down first: it cancels that station's queued
        # downloads, and doing it after the seed was submitted would cancel the
        # seed itself whenever the listener replays a track the old station had
        # queued ahead.
        end_station(device_ip)
        # Then start the seed download, before touching the speaker, so the
        # first bytes are on their way by the time Sonos asks for them. Priority
        # 0 means the prefetch gate holds every other download off the wire
        # until this one finishes, so the seed gets the whole uplink.
        download = ensure_cached(video_id, priority=0)
        # Wait for the first bytes *before* touching the speaker. Playing now is
        # an explicit user action ("Play now") taken while something else is
        # playing, so the queue is left intact and the old track keeps playing
        # through the resolve + transcode startup: the wait costs a spinner
        # rather than a silent speaker between the two songs.
        _wait_for_first_bytes(download)

        # Only now replace what the speaker is doing: with the first bytes
        # already on disk, its GET of /media is answered immediately instead of
        # hanging on a download that hasn't produced anything yet.
        coordinator.clear_queue()
        try:
            coordinator.play_mode = 'NORMAL'
        except Exception as e:
            logger.warning(f"Could not set play mode: {e}")

        station = start_station(device_ip, seed)
        enqueue(coordinator, station.tracks[0])
        station.enqueued = 1
        coordinator.play_from_queue(0)
        started = _ensure_playing(coordinator)

        if autoplay:
            run_station(station)
        else:
            # One-shot play: no monitor thread, so nothing is queued after it.
            end_station(device_ip)

        logger.info(f"Playing '{seed.get('title')}' ({video_id}) on "
                    f"'{speaker.player_name}' ({device_ip})")
        return jsonify({
            "status": "playing",
            "started": started,
            "queued_next": False,
            "device": speaker.player_name,
            "device_ip": device_ip,
            "stream_url": media_url(video_id),
            "autoplay": autoplay,
            "video_id": video_id,
            "title": seed.get('title')
        })
    except Exception as e:
        return _yt_error_response(e, "play command")


@app.route('/api/transport', methods=['POST'])
def transport():
    """Drive the speaker's own transport: next/prev/pause/play/seek.

    Skipping is now a single UPnP call against the Sonos queue instead of
    re-resolving a track and restarting a stream.
    """
    data = request.get_json() or {}
    device_ip = data.get('device_ip')
    action = (data.get('action') or '').lower()

    try:
        speaker = _resolve_speaker(device_ip)
        if speaker is None:
            return jsonify({"error": "No Sonos devices discovered"}), 404
        coordinator = _coordinator(speaker)

        if action == 'next':
            coordinator.next()
        elif action == 'prev':
            coordinator.previous()
        elif action == 'pause':
            coordinator.pause()
        elif action == 'play':
            coordinator.play()
        elif action == 'seek':
            coordinator.seek(data.get('position') or '0:00:00')
        elif action == 'jump':
            index = int(data.get('index', 0))
            coordinator.play_from_queue(index)
            # Move the cursor now rather than waiting up to a poll interval for
            # the station loop to notice, so the jumped-to track's download is
            # promoted immediately.
            with _STATE_LOCK:
                station = STATION.get(speaker.ip_address)
                if station and station.tracks:
                    station.index = min(index, len(station.tracks) - 1)
                    _reprioritize(station)
        else:
            return jsonify({"error": f"Unknown action: {action!r}"}), 400

        return jsonify({"status": "ok", "action": action,
                        "device": speaker.player_name})
    except soco.exceptions.SoCoUPnPException as e:
        # Hitting Next on the last queued track, or Prev on the first, is a
        # normal user action — not a server error.
        logger.info(f"Transport '{action}' rejected by speaker: {e}")
        return jsonify({"error": "Nothing to skip to"}), 409
    except Exception as e:
        logger.error(f"Transport '{action}' failed: {e}")
        return jsonify({"error": str(e)}), 500


@app.route('/api/station', methods=['GET'])
def station_view():
    """The server's ordered station list, cursor, and per-track cache status."""
    device_ip = request.args.get('device_ip')
    if not device_ip:
        speaker = _resolve_speaker(None)
        device_ip = speaker.ip_address if speaker else None
    with _STATE_LOCK:
        station = STATION.get(device_ip)
    payload = station_payload(station)
    payload['device_ip'] = device_ip
    return jsonify(payload)

@app.route('/api/station/refresh', methods=['POST'])
def station_refresh():
    """Replace everything queued after the playing track with a fresh set.

    The listener's escape hatch from a station that keeps circling the same
    songs: the current track plays on untouched, its tail is discarded, and the
    refill excludes everything this station and the process-wide recent memory
    have already served.
    """
    data = request.get_json() or {}
    device_ip = data.get('device_ip')

    try:
        speaker = _resolve_speaker(device_ip)
        if speaker is None:
            return jsonify({"error": "No Sonos devices discovered"}), 404
        device_ip = speaker.ip_address
        with _STATE_LOCK:
            station = STATION.get(device_ip)
        if station is None:
            return jsonify({"error": "No station is running on this speaker"}), 404

        dropped = refresh_station(_coordinator(speaker), station)
        if dropped is None:
            return jsonify({
                "error": "This speaker isn't playing from its queue"}), 409

        payload = station_payload(station)
        payload.update({"status": "refreshed", "dropped": dropped,
                        "device_ip": device_ip, "device": speaker.player_name})
        return jsonify(payload)
    except Exception as e:
        return _yt_error_response(e, "queue refresh")


@app.route('/api/downloads', methods=['GET'])
def downloads_view():
    """Scheduler introspection: what's running, what's queued, and at what priority.

    Without this the prefetch gate is invisible — "politely waiting for the
    current track" and "wedged" look identical from the outside.
    """
    pending, running = _SCHED.snapshot()
    now = time.time()
    with _STATE_LOCK:
        rows = [{
            'id': vid,
            'state': d.state,
            'bytes': d.bytes_written,
            'attempts': d.attempts,
            'error': d.error,
            'retry_in': max(0, round(d.retry_after - now)),
            'priority': running.get(vid, pending.get(vid)),
        } for vid, d in _DOWNLOADS.items()]
    return jsonify({'workers': DOWNLOAD_WORKERS, 'gate': PREFETCH_GATE,
                    'running': running, 'pending': pending, 'downloads': rows})


@app.route('/api/stop', methods=['POST'])
def stop():
    data = request.get_json() or {}
    device_ip = data.get('device_ip')
    
    try:
        if not device_ip:
            logger.info("No device_ip specified for stop command, searching discovered devices...")
            devices = list(soco.discover() or [])
            if not devices:
                return jsonify({"error": "No Sonos devices discovered"}), 404
            speaker = devices[0]
        else:
            speaker = soco.SoCo(device_ip)
            
        logger.info(f"Stopping playback on speaker '{speaker.player_name}' ({speaker.ip_address})")
        _coordinator(speaker).stop()
        # Tear down the station so it stops prefetching from YouTube.
        end_station(speaker.ip_address)
        # The show is over, so hand the lamps back the way we found them. There
        # is one light stream per process and it is not bound to a speaker, so
        # stopping any speaker ends it — invisible with one bridge and one
        # household, which is the only arrangement the single session supports.
        _hue_stop()
        return jsonify({"status": "stopped", "device": speaker.player_name})
    except Exception as e:
        logger.error(f"Stop command failed: {e}")
        return jsonify({"error": str(e)}), 500

def _resolve_speaker(device_ip):
    """Return a SoCo speaker for the given IP, or the first discovered device."""
    if device_ip:
        return soco.SoCo(device_ip)
    devices = list(soco.discover() or [])
    return devices[0] if devices else None

_MEDIA_URI_RE = re.compile(r'/media/([A-Za-z0-9_-]{1,32})\.mp3')


def _video_id_from_uri(uri):
    """Our video id out of a Sonos track URI, or None if it isn't ours."""
    m = _MEDIA_URI_RE.search(uri or '')
    return m.group(1) if m else None


def _now_playing_payload(speaker):
    """Snapshot of what the speaker is currently playing.

    Each queue item is a real track now, so Sonos reports its own title, artist,
    artwork, duration and position directly — no server-side overlay needed.
    Anything missing (a track enqueued before its tags were read) is filled in
    from the station list.
    """
    coordinator = _coordinator(speaker)
    transport = coordinator.get_current_transport_info()
    track = coordinator.get_current_track_info()
    uri = track.get('uri') or ''

    video_id = _video_id_from_uri(uri)
    is_ours = video_id is not None

    title = track.get('title')
    uploader = track.get('artist')
    album_art = track.get('album_art')
    duration = track.get('duration')

    with _STATE_LOCK:
        station = STATION.get(speaker.ip_address)
        entry = next((t for t in station.tracks if t['video_id'] == video_id),
                     None) if (station and video_id) else None
    if entry:
        title = title or entry.get('title')
        uploader = uploader or entry.get('uploader')
        album_art = album_art or entry.get('thumbnail')

    try:
        playlist_position = int(track.get('playlist_position') or 0)
    except (TypeError, ValueError):
        playlist_position = 0

    return {
        "state": transport.get('current_transport_state'),  # PLAYING / PAUSED_PLAYBACK / STOPPED / TRANSITIONING
        "title": title,
        "artist": uploader,
        "album_art": album_art,
        "duration": duration,
        "position": track.get('position'),
        "playlist_position": playlist_position,
        "station_index": station.index if station else None,
        "uri": uri,
        # Kept under the old key so existing clients keep working; it now means
        # "this is a track we're serving" rather than "this is our radio hack".
        "is_radio": is_ours,
        "video_id": video_id,
        "device": speaker.player_name,
        "device_ip": speaker.ip_address
    }

@app.route('/api/now-playing', methods=['GET'])
def now_playing():
    device_ip = request.args.get('device_ip')
    try:
        speaker = _resolve_speaker(device_ip)
        if speaker is None:
            return jsonify({"error": "No Sonos devices discovered"}), 404
        return jsonify(_now_playing_payload(speaker))
    except Exception as e:
        logger.error(f"Now-playing query failed: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/events', methods=['GET'])
def events():
    """Server-Sent Events stream of now-playing state for one speaker.

    The server polls the speaker on an interval and emits a message only when
    the state changes, with a keep-alive comment in between. This replaces
    client-side polling with a single long-lived connection.
    """
    device_ip = request.args.get('device_ip')
    poll_interval = float(os.environ.get('EVENT_POLL_INTERVAL', 2))

    def event_stream():
        try:
            speaker = _resolve_speaker(device_ip)
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
            return
        if speaker is None:
            yield f"data: {json.dumps({'error': 'No Sonos devices discovered'})}\n\n"
            return

        last = None
        while True:
            try:
                data = _now_playing_payload(speaker)
                # Ship the station list on the same connection so the UI can
                # show what's queued ahead and which tracks are still landing.
                with _STATE_LOCK:
                    station = STATION.get(speaker.ip_address)
                data['station'] = station_payload(station)
                payload = json.dumps(data)
            except Exception as e:
                payload = json.dumps({"error": str(e)})

            if payload != last:
                yield f"data: {payload}\n\n"
                last = payload
            else:
                # Comment line keeps the connection alive through proxies/timeouts
                yield ": keep-alive\n\n"

            time.sleep(poll_interval)

    return Response(
        event_stream(),
        mimetype='text/event-stream',
        headers={
            # `no-transform` is not decoration. A proxy that gzips this stream
            # holds it in the compressor's buffer and the client receives
            # nothing at all — the headers arrive, the bytes never do, and it
            # is indistinguishable from a wedged speaker. Next.js compresses
            # proxied responses by default and does exactly this whenever the
            # browser sends `Accept-Encoding: gzip`, which every browser does
            # and none can be told not to (it is a forbidden header name, so
            # EventSource cannot opt out). The fix has to be here.
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no',  # disable proxy buffering (e.g. nginx)
            'Connection': 'keep-alive',
        }
    )

@app.route('/api/volume', methods=['GET'])
def get_volume():
    device_ip = request.args.get('device_ip')
    try:
        if not device_ip:
            devices = list(soco.discover() or [])
            if not devices:
                return jsonify({"error": "No Sonos devices discovered"}), 404
            speaker = devices[0]
        else:
            speaker = soco.SoCo(device_ip)

        return jsonify({
            "volume": speaker.volume,
            "mute": speaker.mute,
            "device": speaker.player_name,
            "device_ip": speaker.ip_address
        })
    except Exception as e:
        logger.error(f"Get volume failed: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/volume', methods=['POST'])
def set_volume():
    data = request.get_json() or {}
    device_ip = data.get('device_ip')
    volume = data.get('volume')
    mute = data.get('mute')

    try:
        if not device_ip:
            devices = list(soco.discover() or [])
            if not devices:
                return jsonify({"error": "No Sonos devices discovered"}), 404
            speaker = devices[0]
        else:
            speaker = soco.SoCo(device_ip)

        if volume is not None:
            vol = max(0, min(100, int(volume)))
            speaker.volume = vol
            logger.info(f"Set volume to {vol} on '{speaker.player_name}'")

        if mute is not None:
            speaker.mute = bool(mute)
            logger.info(f"Set mute={mute} on '{speaker.player_name}'")

        return jsonify({
            "volume": speaker.volume,
            "mute": speaker.mute,
            "device": speaker.player_name
        })
    except Exception as e:
        logger.error(f"Set volume failed: {e}")
        return jsonify({"error": str(e)}), 500

# --- Philips Hue -------------------------------------------------------------
#
# These live here, in Flask, rather than as Next route handlers, for two
# reasons. The colours are driven by analysis of the audio *this* process has
# already decoded, and putting the DTLS stream behind an HTTP hop would add
# latency to the one path where latency is the entire product. And `/api/:path*`
# is rewritten to this server in `beforeFiles`, so a handler at
# web/src/app/api/hue/* would build, typecheck and lint clean, then 404 through
# the proxy at runtime.
#
# See docs/superpowers/specs/2026-08-31-hue-support-design.md.

hue.set_state_path(os.path.join(CACHE_DIR, 'hue.json'))

# One live stream per process. The bridge allows a single Entertainment stream
# at a time anyway, so a registry keyed by area would only let us build a state
# the hardware rejects.
_HUE_SESSION = None
_HUE_LOCK = threading.Lock()


def _hue_stop():
    """Tear the light stream down if one is up, putting the lamps back.

    Never raises. Both callers are reporting on something else — one on a Stop
    the listener pressed in the Hue dialog, the other on stopping the music —
    and neither should become a 500 because a lamp was unplugged.

    Returns whether there was anything to stop.
    """
    global _HUE_SESSION
    with _HUE_LOCK:
        if _HUE_SESSION is None:
            return False
        try:
            _HUE_SESSION.stop()
        except Exception as e:
            logger.warning(f"Hue stream teardown failed: {e}")
        _HUE_SESSION = None
        return True


def _hue_error(e):
    """Map a HueError onto its own status; anything else is a 500."""
    if isinstance(e, hue.HueError):
        return jsonify({"error": str(e)}), e.status
    logger.exception("Hue request failed")
    return jsonify({"error": str(e)}), 500


@app.route('/api/hue/health', methods=['GET'])
def hue_health():
    """Paired? streaming? which area? Touches no network, for the same reason
    /api/health doesn't: a frontend must be able to tell "not paired" from
    "bridge unreachable" without waiting out a scan."""
    state = hue.load_state()
    # Deliberately *not* under _HUE_LOCK. Starting a stream holds that lock
    # across an HTTPS PUT and up to four DTLS handshakes — tens of seconds —
    # and health blocking behind it would stall the UI at precisely the moment
    # it is asking "did the stream come up?". Reading a module global is atomic
    # and _HUE_SESSION only ever holds None or a fully started session, so
    # there is no half-built object to observe.
    session = _HUE_SESSION
    return jsonify({
        "paired": hue.is_paired(),
        "bridge_ip": state.get('ip'),
        "bridge_id": state.get('id'),
        # Which PSK profile actually worked. Worth surfacing: when handshakes
        # start failing after a firmware update this is the first thing to look
        # at, and it is otherwise buried in the log.
        "psk_profile": state.get('psk_profile'),
        "streaming": bool(session and session.is_active()),
        "area": session.area_id if session else None,
        "channels": session.channels if session else [],
        "error": session.error if session else None,
    })


@app.route('/api/hue/discover', methods=['GET'])
def hue_discover():
    try:
        return jsonify({"bridges": hue.discover()})
    except Exception as e:
        return _hue_error(e)


@app.route('/api/hue/pair', methods=['POST'])
def hue_pair():
    """One attempt at the link-button flow.

    Answers 428 while the button has not been pressed, which is a state the
    client should poll through rather than an error — it is the several seconds
    the user spends walking over to the bridge.
    """
    data = request.get_json(silent=True) or {}
    ip = data.get('ip') or hue.load_state().get('ip')
    if not ip:
        return jsonify({"error": "No bridge ip given and none stored"}), 400
    try:
        state = hue.pair(ip)
    except Exception as e:
        return _hue_error(e)
    # Never echo the client key: it is the shared secret for the light stream,
    # and the UI has no use for it.
    return jsonify({"paired": True, "ip": state.get('ip'),
                    "id": state.get('id')})


@app.route('/api/hue/lights', methods=['GET'])
def hue_lights():
    try:
        return jsonify({"lights": hue.BridgeClient.from_state().lights()})
    except Exception as e:
        return _hue_error(e)


@app.route('/api/hue/groups', methods=['GET'])
def hue_groups():
    try:
        return jsonify({"groups": hue.BridgeClient.from_state().groups()})
    except Exception as e:
        return _hue_error(e)


@app.route('/api/hue/areas', methods=['GET'])
def hue_areas():
    try:
        return jsonify({"areas": hue.BridgeClient.from_state().areas()})
    except Exception as e:
        return _hue_error(e)


@app.route('/api/hue/analysis/<video_id>', methods=['GET'])
def hue_analysis(video_id):
    """Beat and timbre features for a cached track, for the render loop.

    Features, not colours: the palette belongs in the frontend where it is
    cheap to change and unit testable. Baking colours into the sidecar would
    mean re-analysing every cached track to adjust one.

    202 only when analysis is genuinely in flight — a PCM capture on disk, or a
    download still running that will produce one. "Cached" is deliberately not
    enough: a track cached before the bridge was paired, or with HUE_ANALYZE
    off, will never be analysed, and answering 202 for it would have the client
    poll forever for something nobody is working on. That case is a 404 saying
    so, which terminates.
    """
    if not valid_video_id(video_id):
        return jsonify({"error": "Invalid video id"}), 400
    data = analysis.load(CACHE_DIR, video_id)
    if data is not None:
        return jsonify(data)

    pcm = analysis.analysis_paths(CACHE_DIR, video_id)[0]
    if os.path.exists(pcm):
        return jsonify({"status": "pending",
                        "queued": analysis.pending()}), 202

    # A running download only implies analysis if this deployment would
    # actually capture it. Without the gate, a download with librosa missing —
    # or the bridge unpaired — answers 202 for as long as it runs and the
    # client polls something nobody will ever do.
    with _STATE_LOCK:
        downloading = _is_active(_DOWNLOADS.get(video_id))
    if downloading and _analysis_pcm_path(video_id) is not None:
        return jsonify({"status": "pending",
                        "queued": analysis.pending()}), 202

    # _analysis_pcm_path also returns None once a sidecar exists, so a sidecar
    # landing between the load above and here would read as "never scheduled".
    # Re-check before answering 404, which a client is entitled to treat as
    # final. Only on this path, so it costs nothing in the common cases.
    data = analysis.load(CACHE_DIR, video_id)
    if data is not None:
        return jsonify(data)
    return jsonify({"error": "Not analysed, and none is scheduled"}), 404


@app.route('/api/hue/stream', methods=['POST'])
def hue_stream():
    """Start or stop the light stream, or push a colour at a running one.

    {"action": "start", "area": "<id>"} | {"action": "stop"}
              | {"action": "color", "color": [r, g, b]}
    """
    global _HUE_SESSION
    data = request.get_json(silent=True) or {}
    action = (data.get('action') or 'start').lower()

    try:
        # Outside the lock, because _hue_stop takes it itself — it is shared
        # with /api/stop, which has no business knowing this module's lock.
        if action == 'stop':
            _hue_stop()
            return jsonify({"streaming": False})

        with _HUE_LOCK:
            if action == 'color':
                if _HUE_SESSION is None or not _HUE_SESSION.is_active():
                    return jsonify({"error": "Not streaming"}), 409
                # Absent rather than defaulted to black: a body that misspells
                # the key would otherwise blank the lights and report success,
                # which reads as "the stream is broken" rather than "you sent
                # the wrong field".
                if 'color' not in data:
                    return jsonify({"error": "Missing 'color'"}), 400
                _HUE_SESSION.set_color(data['color'])
                return jsonify({"streaming": True})

            if action != 'start':
                return jsonify({"error": f"Unknown action {action!r}"}), 400

            client = hue.BridgeClient.from_state()
            areas = client.areas()
            if not areas:
                return jsonify({"error": "No entertainment area on this "
                                         "bridge. Create one in the Hue "
                                         "app."}), 409
            area_id = data.get('area') or areas[0]['id']
            area = next((a for a in areas if a['id'] == area_id), None)
            if area is None:
                return jsonify({"error": f"No such entertainment area "
                                         f"{area_id!r}"}), 404
            # An area with no channels handshakes, streams, and shows nothing —
            # a success that looks exactly like broken hardware. Say so instead.
            if not area['channels']:
                return jsonify({"error": f"Entertainment area "
                                         f"{area.get('name') or area_id!r} has "
                                         f"no lights assigned to it"}), 409

            # Restarting on the same area is a no-op; switching areas must tear
            # the old stream down first, because the bridge permits exactly one.
            if _HUE_SESSION is not None:
                if (_HUE_SESSION.area_id == area_id
                        and _HUE_SESSION.is_active()):
                    return jsonify({"streaming": True, "area": area_id,
                                    "channels": _HUE_SESSION.channels,
                                    "psk_profile": _HUE_SESSION.profile})
                _HUE_SESSION.stop()
                _HUE_SESSION = None

            session = hue.HueSession(client, area_id, area['channels'])
            session.start()
            _HUE_SESSION = session
            return jsonify({"streaming": True, "area": area_id,
                            "channels": session.channels,
                            "psk_profile": session.profile})
    except Exception as e:
        return _hue_error(e)

# --- Serving cached media to Sonos -------------------------------------------

MEDIA_CHUNK = 32768


def _pin(video_id):
    with _STATE_LOCK:
        _INUSE[video_id] += 1


def _unpin(video_id):
    with _STATE_LOCK:
        _INUSE[video_id] -= 1
        if _INUSE[video_id] <= 0:
            del _INUSE[video_id]


def _parse_range(header, size):
    """Return (start, end) for a single byte range, or None if unsatisfiable.

    Returns (0, size - 1) when there's no usable Range header.
    """
    if not header:
        return 0, size - 1
    m = re.match(r'bytes=(\d*)-(\d*)$', header.strip())
    if not m:
        return 0, size - 1
    first, last = m.group(1), m.group(2)
    if not first and not last:
        return 0, size - 1
    if not first:                       # suffix range: last N bytes
        start, end = max(0, size - int(last)), size - 1
    else:
        start = int(first)
        end = min(int(last), size - 1) if last else size - 1
    if start > end or start >= size:
        return None
    return start, end


def _serve_complete(video_id, path):
    """Serve a fully cached file with Range support so Sonos can seek."""
    size = os.path.getsize(path)
    rng = _parse_range(request.headers.get('Range'), size)
    if rng is None:
        return Response(status=416, headers={'Content-Range': f'bytes */{size}'})
    start, end = rng
    length = end - start + 1
    partial = bool(request.headers.get('Range')) and (start, end) != (0, size - 1)

    headers = {
        'Content-Type': 'audio/mpeg',
        'Accept-Ranges': 'bytes',
        'Content-Length': str(length),
        'Cache-Control': 'no-cache',
    }
    if partial:
        headers['Content-Range'] = f'bytes {start}-{end}/{size}'

    if request.method == 'HEAD':
        return Response(status=206 if partial else 200, headers=headers)

    def generate():
        remaining = length
        with open(path, 'rb') as fh:
            fh.seek(start)
            while remaining > 0:
                data = fh.read(min(MEDIA_CHUNK, remaining))
                if not data:
                    break
                remaining -= len(data)
                yield data

    return Response(generate(), status=206 if partial else 200, headers=headers)


def _serve_tail(video_id, download):
    """Stream a file that is still downloading, following it as it grows.

    Content-Length is unknown here, so Sonos treats this response as an
    open-ended stream. The real duration still reaches the speaker through the
    DIDL metadata we attach when enqueuing, so the UI stays correct.
    """
    mp3, part, _, _ = cache_paths(video_id)

    def _open_when_ready():
        """Open the file being written, waiting for it to appear if need be.

        A download that is still `queued` has no file on disk yet. Callers
        currently only reach here once bytes have landed, but opening eagerly
        makes that an invisible precondition — one missed guard upstream and
        Sonos silently gets an empty stream instead of the track.
        """
        deadline = time.time() + MEDIA_START_TIMEOUT
        while True:
            for path in (part, mp3):
                if os.path.exists(path):
                    return open(path, 'rb')
            with download.cond:
                if download.state not in ACTIVE_STATES or time.time() >= deadline:
                    return None
                download.cond.wait(timeout=1.0)

    def generate():
        try:
            fh = _open_when_ready()
        except OSError as e:
            logger.error(f"Tail-serve could not open {video_id}: {e}")
            return
        if fh is None:
            logger.error(f"Tail-serve found no file for {video_id} "
                         f"(download {download.state})")
            return
        # The downloader renames .part -> .mp3 on completion; the open handle
        # keeps pointing at the same inode, so reading straight through works.
        try:
            while True:
                data = fh.read(MEDIA_CHUNK)
                if data:
                    yield data
                    continue
                with download.cond:
                    if download.state in ACTIVE_STATES:
                        download.cond.wait(timeout=2.0)
                        continue
                # Writer has stopped; drain anything written since the last read.
                data = fh.read(MEDIA_CHUNK)
                if data:
                    yield data
                    continue
                if download.state == 'failed':
                    logger.error(f"Tail-serve ended early for {video_id}: "
                                 f"{download.error}")
                break
        finally:
            fh.close()

    return Response(generate(), status=200, headers={
        'Content-Type': 'audio/mpeg',
        'Accept-Ranges': 'none',
        'Cache-Control': 'no-cache',
    })


@app.route('/media/<video_id>.mp3', methods=['GET', 'HEAD'])
def media_audio(video_id):
    """Serve a cached track, downloading it on demand if it isn't cached yet.

    This is the URL Sonos pulls from for every queue item. A track that has
    fallen outside the cache window (or was never fetched) is downloaded here
    and served while it downloads, so stepping far back in the queue still
    starts within a few seconds.
    """
    if not valid_video_id(video_id):
        return jsonify({"error": "Invalid video id"}), 404

    # Pin first so eviction can't delete the file out from under us, and hand
    # the pin to the response once there is one. `owned` makes every exit path
    # -- including the early error returns -- release it exactly once.
    _pin(video_id)
    owned = True
    try:
        mp3, _, _, _ = cache_paths(video_id)
        if os.path.exists(mp3):
            response = _serve_complete(video_id, mp3)
        else:
            download = ensure_cached(video_id, priority=PRIORITY_MEDIA)
            deadline = time.time() + MEDIA_START_TIMEOUT
            with download.cond:
                while (download.state in ACTIVE_STATES
                       and download.bytes_written < TAIL_START_BYTES
                       and time.time() < deadline):
                    download.cond.wait(timeout=1.0)
                state, started = download.state, download.bytes_written

            if state == 'failed':
                return jsonify({"error": download.error or "Download failed"}), 502
            if state == 'done' and os.path.exists(mp3):
                response = _serve_complete(video_id, mp3)
            elif started == 0:
                return jsonify({"error": "Download did not start in time"}), 504
            else:
                logger.info(f"Serving {video_id} while it downloads "
                            f"({started // 1024} KiB ready)")
                response = _serve_tail(video_id, download)

        # Held until the response is fully sent, so eviction can't delete a
        # file that Sonos is still reading.
        response.call_on_close(lambda: _unpin(video_id))
        owned = False
        return response
    finally:
        if owned:
            _unpin(video_id)


@app.route('/media/<video_id>.jpg', methods=['GET', 'HEAD'])
def media_art(video_id):
    """Album art for a cached track. Sonos won't fetch YouTube's CDN directly."""
    if not valid_video_id(video_id):
        return jsonify({"error": "Invalid video id"}), 404
    _, _, _, jpg = cache_paths(video_id)
    if not os.path.exists(jpg):
        return jsonify({"error": "No artwork cached"}), 404
    with open(jpg, 'rb') as fh:
        data = fh.read()
    return Response(data, headers={
        'Content-Type': 'image/jpeg',
        'Content-Length': str(len(data)),
        'Cache-Control': 'public, max-age=86400',
    })

if __name__ == '__main__':
    logger.info(f"Initializing app on stream host: {STREAM_HOST} (port {PORT})")
    _log_ytdlp_version()
    cache_scan()
    app.run(host='0.0.0.0', port=PORT, threaded=True)
