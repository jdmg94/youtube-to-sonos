import os
import re
import json
import time
import socket
import subprocess
import logging
from flask import Flask, jsonify, request, Response, render_template
import soco
import yt_dlp

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = Flask(__name__, template_folder='templates')

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

PORT = int(os.environ.get('PORT', 8080))
STREAM_HOST = os.environ.get('STREAM_HOST') or get_local_ip()

# Shared yt-dlp format selection for audio extraction
AUDIO_FORMAT = 'bestaudio[acodec=opus]/bestaudio[acodec=vorbis]/bestaudio[ext=m4a]/bestaudio/best'

# Optional Netscape-format cookies file for yt-dlp, used to get past YouTube's
# bot / sign-in checks. Defaults to cookies.txt next to app.py; override with
# COOKIES_FILE. When absent, extraction runs without cookies (prior behavior).
COOKIES_FILE = os.environ.get('COOKIES_FILE') or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), 'cookies.txt')

def ydl_opts(**extra):
    """Base yt-dlp options; injects the cookies file when it exists."""
    opts = {'quiet': True, **extra}
    if os.path.exists(COOKIES_FILE):
        opts['cookiefile'] = COOKIES_FILE
    return opts

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


def _yt_error_response(err, context):
    """Log a yt-dlp failure and build the client JSON response for an endpoint.

    Bot-detection / rate-limit blocks get a distinct 429, a `bot_detected` flag,
    and a clear message so they stand out in both the logs and the UI toast;
    everything else keeps the previous generic 500 with the raw message.
    """
    if _is_bot_error(err):
        logger.error(f"YT-DLP BOT DETECTION during {context}: {err}")
        return jsonify({"error": BOT_ERROR_MESSAGE, "bot_detected": True}), 429
    logger.error(f"{context} failed: {err}")
    return jsonify({"error": str(err)}), 500

# Autoplay-station variety tuning (env-overridable, like EVENT_POLL_INTERVAL):
#   MAX_TRACKS_PER_ARTIST — cap on how many tracks one artist may contribute per
#                           queue refill, so no single artist dominates.
#   ARTIST_COOLDOWN       — an artist just heard within this many tracks is
#                           pushed to the back of the next refill.
MAX_TRACKS_PER_ARTIST = int(os.environ.get('MAX_TRACKS_PER_ARTIST', 2))
ARTIST_COOLDOWN = int(os.environ.get('ARTIST_COOLDOWN', 4))

# Tracks what the radio stream is currently playing. Sonos sees one endless
# "station", so it can't tell us which autoplay track is live — we track it here
# and surface it through /api/now-playing and the SSE stream.
CURRENT_STREAM = {"video_id": None, "title": None, "uploader": None, "thumbnail": None, "channel_id": None}

def _reset_current_stream():
    CURRENT_STREAM.update({"video_id": None, "title": None, "uploader": None, "thumbnail": None, "channel_id": None})

def extract_audio(video_id):
    """Return (direct_audio_url, metadata) for a YouTube video id."""
    url = f"https://www.youtube.com/watch?v={video_id}"
    with yt_dlp.YoutubeDL(ydl_opts(format=AUDIO_FORMAT, noplaylist=True)) as ydl:
        info = ydl.extract_info(url, download=False)
    meta = {
        "video_id": info.get('id', video_id),
        "title": info.get('title'),
        "uploader": info.get('uploader'),
        "thumbnail": info.get('thumbnail'),
        "channel_id": info.get('channel_id'),
    }
    return info['url'], meta

def get_radio_mix(video_id, limit=25):
    """Ordered list of track entries from YouTube's autoplay radio mix (RD<id>).

    This is YouTube's own 'up next' / autoplay sequence for a seed video. Each
    entry is a dict with at least 'id', plus 'title'/'channel_id'/'uploader'
    used downstream to keep the station varied (see build_station_queue).
    """
    mix_url = f"https://www.youtube.com/watch?v={video_id}&list=RD{video_id}"
    try:
        with yt_dlp.YoutubeDL(ydl_opts(extract_flat=True, playlistend=limit)) as ydl:
            info = ydl.extract_info(mix_url, download=False)
        return [e for e in (info.get('entries') or []) if e.get('id')]
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

def _reseed_ids(played_order):
    """Pick which recently-played tracks to reseed the autoplay mix from.

    Uses the most recent track plus one from a few steps back, so the candidate
    pool blends 'related to what's playing now' with a slightly different point
    in the walk — this is the main lever against orbiting one artist."""
    if not played_order:
        return []
    seeds = [played_order[-1]]
    if len(played_order) >= 4:
        seeds.append(played_order[-4])
    return seeds

def build_station_queue(seeds, played_ids, played_titles,
                        cooldown_artists=(), max_per_artist=MAX_TRACKS_PER_ARTIST):
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
        for e in get_radio_mix(seed):
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

@app.route('/')
def index():
    return render_template('index.html')

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

@app.route('/api/next', methods=['GET'])
def get_next():
    """Resolve the next autoplay track for a seed video.

    Returns metadata for the first track in the seed's YouTube radio mix that the
    client hasn't already played. This lets the Next button skip forward into the
    autoplay station even when the user is sitting at the end of their history.
    """
    video_id = request.args.get('video_id')
    if not video_id:
        return jsonify({"error": "Missing video_id parameter"}), 400

    # Don't suggest the seed itself or anything already played this session.
    exclude = {video_id}
    exclude.update(v for v in request.args.get('exclude', '').split(',') if v)

    try:
        mix = get_radio_mix(video_id)
        # The seed's own artist tends to lead its radio mix, so repeatedly hitting
        # Next marches down one discography. Identify the seed artist (from its own
        # entry in the mix, if present) and prefer an unplayed track by someone
        # else, before falling back to any unplayed, then any non-seed track.
        seed_entry = next((e for e in mix if e.get('id') == video_id), None)
        seed_artist = _artist_key(seed_entry) if seed_entry else None
        unplayed = [e for e in mix if e.get('id') not in exclude]

        next_id = (
            next((e['id'] for e in unplayed
                  if not seed_artist or _artist_key(e) != seed_artist), None)
            or next((e['id'] for e in unplayed), None)
            or next((e['id'] for e in mix if e.get('id') != video_id), None)
        )
        if not next_id:
            return jsonify({"error": "No autoplay track available"}), 404

        with yt_dlp.YoutubeDL(ydl_opts(format=AUDIO_FORMAT, noplaylist=True)) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={next_id}", download=False)
        return jsonify({
            'url': f"https://youtu.be/{next_id}",
            'id': info.get('id', next_id),
            'title': info.get('title'),
            'duration': info.get('duration'),
            'thumbnail': info.get('thumbnail'),
            'uploader': info.get('uploader'),
        })
    except Exception as e:
        return _yt_error_response(e, f"next-track resolve for {video_id}")

@app.route('/api/play', methods=['POST'])
def play():
    data = request.get_json() or {}
    url = data.get('url')
    device_ip = data.get('device_ip')
    autoplay = data.get('autoplay', True)

    if not url:
        return jsonify({"error": "Missing URL parameter"}), 400

    try:
        # 1. Fetch info to get video ID and Title
        logger.info(f"Preparing to play. Fetching info for: {url} (autoplay={autoplay})")
        with yt_dlp.YoutubeDL(ydl_opts(format=AUDIO_FORMAT, noplaylist=True)) as ydl:
            info = ydl.extract_info(url, download=False)
            video_id = info.get('id')
            title = info.get('title', 'YouTube Stream')

        if not video_id:
            return jsonify({"error": "Could not extract video ID"}), 400

        # 2. Get speaker
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

        # 3. Construct the stream URL pointing back to this Flask server.
        # The autoplay flag tells the stream endpoint whether to chain into the
        # YouTube autoplay mix after the seed video, or stop after one track.
        # A cache-busting token forces Sonos to re-open the station fresh each
        # play (otherwise it may resume a previously-cached radio connection).
        token = int(time.time())
        stream_url = (f"http://{STREAM_HOST}:{PORT}/stream/{video_id}.mp3"
                      f"?autoplay={'1' if autoplay else '0'}&t={token}")
        logger.info(f"Instructing Sonos speaker '{speaker.player_name}' ({device_ip}) to play stream: {stream_url}")

        # 4. Play URL — force_radio treats arbitrary HTTP URLs as audio streams
        speaker.play_uri(stream_url, title=title, force_radio=True)

        return jsonify({
            "status": "playing",
            "device": speaker.player_name,
            "device_ip": device_ip,
            "stream_url": stream_url,
            "autoplay": autoplay,
            "title": title
        })
    except Exception as e:
        return _yt_error_response(e, "play command")

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
        speaker.stop()
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

def _now_playing_payload(speaker):
    """Snapshot of what the speaker is currently playing.

    When the speaker is playing our radio stream, the per-track metadata comes
    from CURRENT_STREAM (the autoplay track we're feeding right now) rather than
    Sonos, which only knows the static station title we set on play.
    """
    transport = speaker.get_current_transport_info()
    track = speaker.get_current_track_info()
    uri = track.get('uri') or ''

    title = track.get('title')
    uploader = track.get('artist')
    album_art = track.get('album_art')
    video_id = None

    is_our_radio = f"{STREAM_HOST}:{PORT}/stream/" in uri
    if is_our_radio and CURRENT_STREAM.get('title'):
        title = CURRENT_STREAM['title']
        uploader = CURRENT_STREAM.get('uploader') or uploader
        album_art = CURRENT_STREAM.get('thumbnail') or album_art
        # The live autoplay track id — lets the client log autoplay advances to
        # its playback history (Sonos only reports the static station, not this).
        video_id = CURRENT_STREAM.get('video_id')

    return {
        "state": transport.get('current_transport_state'),  # PLAYING / PAUSED_PLAYBACK / STOPPED / TRANSITIONING
        "title": title,
        "artist": uploader,
        "album_art": album_art,
        "duration": track.get('duration'),
        "uri": uri,
        "is_radio": is_our_radio,
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
                payload = json.dumps(_now_playing_payload(speaker))
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
            'Cache-Control': 'no-cache',
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

def transcode_to_mp3(direct_url):
    """Yield mp3 chunks transcoded from a direct media URL via ffmpeg."""
    cmd = [
        'ffmpeg',
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-loglevel', 'error',
        '-i', direct_url,
        '-vn',
        '-f', 'mp3',
        '-acodec', 'libmp3lame',
        '-q:a', '0',
        '-ab', '320k',
        '-ac', '2',
        '-ar', '48000',
        'pipe:1'
    ]
    process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        while True:
            data = process.stdout.read(32768)
            if not data:
                break
            yield data
    finally:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


@app.route('/stream/<video_id>.mp3')
def stream(video_id):
    # autoplay=1 (default): after the seed, keep streaming YouTube's autoplay mix
    # as one continuous radio station. autoplay=0: play the single video and stop.
    autoplay = request.args.get('autoplay', '1') != '0'
    logger.info(f"Received stream request for video_id: {video_id} (autoplay={autoplay})")

    def generate():
        played_ids = set()          # every video id we've streamed
        played_titles = set()       # normalized song titles, to reject re-uploads
        played_order = []           # played ids in order, for choosing reseed points
        artist_history = []         # artist key per played track, in order
        queue = [{"id": video_id}]  # entries; the seed starts with just its id

        try:
            while queue:
                entry = queue.pop(0)
                vid = entry.get("id")
                if not vid or vid in played_ids:
                    continue

                try:
                    direct_url, meta = extract_audio(vid)
                except Exception as e:
                    if _is_bot_error(e):
                        # Silent skips here mean a dead station with no user-facing
                        # error, so make the real cause unmissable in the logs.
                        logger.error(f"YT-DLP BOT DETECTION streaming {vid} (seed {video_id}): {e}")
                    else:
                        logger.error(f"Skipping {vid}, audio extract failed: {e}")
                    continue

                # A song only counts as "played" once we can actually stream it,
                # so extraction failures don't poison the anti-repeat filters.
                played_ids.add(vid)
                played_order.append(vid)
                tkey = _title_key(meta.get("title"))
                if tkey:
                    played_titles.add(tkey)
                artist_history.append(_artist_key(meta) or vid)

                CURRENT_STREAM.update(meta)
                logger.info(f"Radio now playing: {meta.get('title')} ({vid})")
                yield from transcode_to_mp3(direct_url)

                if not autoplay:
                    break

                # Refill the queue with a varied selection. Reseed from more than
                # one recent track so the station widens instead of marching down
                # a single artist's discography, and keep recently-heard artists
                # on cooldown so they don't immediately reappear.
                if not queue:
                    seeds = _reseed_ids(played_order)
                    cooldown = artist_history[-ARTIST_COOLDOWN:]
                    queue = build_station_queue(seeds, played_ids, played_titles,
                                                cooldown_artists=cooldown)
                    if not queue:
                        # Nothing new under the artist cap — relax the cap and the
                        # title filter one last time before ending the station.
                        queue = build_station_queue(
                            seeds, played_ids, set(),
                            cooldown_artists=cooldown, max_per_artist=99)
                    if not queue:
                        logger.info(f"Autoplay mix exhausted after {vid}; ending station.")
        except GeneratorExit:
            logger.info(f"Stream client disconnected (seed {video_id})")
        finally:
            _reset_current_stream()
            logger.info(f"Stream generator finished (seed {video_id})")

    return Response(
        generate(),
        mimetype='audio/mpeg',
        headers={
            'Content-Type': 'audio/mpeg',
            'Transfer-Encoding': 'chunked',
            'Cache-Control': 'no-cache',
        }
    )

if __name__ == '__main__':
    logger.info(f"Initializing app on stream host: {STREAM_HOST} (port {PORT})")
    if os.path.exists(COOKIES_FILE):
        logger.info(f"Using yt-dlp cookies file: {COOKIES_FILE}")
    app.run(host='0.0.0.0', port=PORT, threaded=True)
