import os
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

# Tracks what the radio stream is currently playing. Sonos sees one endless
# "station", so it can't tell us which autoplay track is live — we track it here
# and surface it through /api/now-playing and the SSE stream.
CURRENT_STREAM = {"video_id": None, "title": None, "uploader": None, "thumbnail": None}

def _reset_current_stream():
    CURRENT_STREAM.update({"video_id": None, "title": None, "uploader": None, "thumbnail": None})

def extract_audio(video_id):
    """Return (direct_audio_url, metadata) for a YouTube video id."""
    url = f"https://www.youtube.com/watch?v={video_id}"
    with yt_dlp.YoutubeDL({'format': AUDIO_FORMAT, 'noplaylist': True, 'quiet': True}) as ydl:
        info = ydl.extract_info(url, download=False)
    meta = {
        "video_id": info.get('id', video_id),
        "title": info.get('title'),
        "uploader": info.get('uploader'),
        "thumbnail": info.get('thumbnail'),
    }
    return info['url'], meta

def get_radio_mix(video_id, limit=25):
    """Ordered list of video ids from YouTube's autoplay radio mix (RD<id>).

    This is YouTube's own 'up next' / autoplay sequence for a seed video.
    """
    mix_url = f"https://www.youtube.com/watch?v={video_id}&list=RD{video_id}"
    try:
        with yt_dlp.YoutubeDL({'quiet': True, 'extract_flat': True, 'playlistend': limit}) as ydl:
            info = ydl.extract_info(mix_url, download=False)
        return [e['id'] for e in (info.get('entries') or []) if e.get('id')]
    except Exception as e:
        logger.error(f"Failed to fetch radio mix for {video_id}: {e}")
        return []

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
        ydl_opts = {
            'format': 'bestaudio[acodec=opus]/bestaudio[acodec=vorbis]/bestaudio[ext=m4a]/bestaudio/best',
            'noplaylist': True,
            'quiet': True,
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            return jsonify({
                'title': info.get('title'),
                'duration': info.get('duration'),
                'thumbnail': info.get('thumbnail'),
                'id': info.get('id'),
                'uploader': info.get('uploader')
            })
    except Exception as e:
        logger.error(f"Failed to fetch metadata: {e}")
        return jsonify({"error": str(e)}), 500

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
        # Prefer an unplayed track; fall back to any non-seed track so the button
        # still advances rather than dead-ending once the mix has been exhausted.
        next_id = (next((vid for vid in mix if vid not in exclude), None)
                   or next((vid for vid in mix if vid != video_id), None))
        if not next_id:
            return jsonify({"error": "No autoplay track available"}), 404

        with yt_dlp.YoutubeDL({'format': AUDIO_FORMAT, 'noplaylist': True, 'quiet': True}) as ydl:
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
        logger.error(f"Failed to resolve next autoplay track for {video_id}: {e}")
        return jsonify({"error": str(e)}), 500

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
        with yt_dlp.YoutubeDL({'format': AUDIO_FORMAT, 'noplaylist': True, 'quiet': True}) as ydl:
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
        logger.error(f"Play command failed: {e}")
        return jsonify({"error": str(e)}), 500

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
        played = set()
        queue = [video_id]
        last_played = video_id

        try:
            while queue:
                vid = queue.pop(0)
                if vid in played:
                    continue
                played.add(vid)

                try:
                    direct_url, meta = extract_audio(vid)
                except Exception as e:
                    logger.error(f"Skipping {vid}, audio extract failed: {e}")
                    continue

                CURRENT_STREAM.update(meta)
                last_played = vid
                logger.info(f"Radio now playing: {meta.get('title')} ({vid})")
                yield from transcode_to_mp3(direct_url)

                if not autoplay:
                    break

                # Refill the queue from the most recent track's autoplay mix so
                # the station keeps flowing into fresh, related suggestions.
                if not queue:
                    for nv in get_radio_mix(last_played):
                        if nv not in played:
                            queue.append(nv)
                    if not queue:
                        logger.info(f"Autoplay mix exhausted after {last_played}; ending station.")
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
    app.run(host='0.0.0.0', port=PORT, threaded=True)
