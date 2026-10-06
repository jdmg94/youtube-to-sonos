"""Server-side Hue light rendering: color generation and autonomous render loop.

Ports palette logic from web/src/lib/hue.ts to run autonomously on the backend.
"""
import re
import math
import threading
import time
import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)

REPORTED_POSITION_BIAS_SECONDS = 0.5
RESYNC_THRESHOLD_SECONDS = 0.75

# Palette constants (ported exactly from web/src/lib/hue.ts)
HUE_MIN_DEG = 0
HUE_MAX_DEG = 280
MIN_VALUE = 0.15
BASE_SATURATION = 0.9
BEAT_DECAY_FRACTION = 0.35
BEAT_LIFT = 0.6
BEAT_WASH = 0.5
MIN_BEAT_PERIOD_SECONDS = 0.05
BRIGHTNESS_TRIM = 0.05
MIN_BRIGHTNESS_SPAN = 0.08
SPREAD_MAX_DEG = HUE_MAX_DEG - HUE_MIN_DEG  # 280
BRIGHTNESS_FLOOR = 0.15
DECAY_MIN = 0.15
DECAY_MAX = 0.95
TAU_MIN_SECONDS = 0.05
TAU_MAX_SECONDS = 2.0
COLOR_EPSILON = 3
IDLE_COLOR = (60, 45, 30)
POSITION_EPSILON = 1e-6
DEFAULT_SETTINGS = {'brightness': 100, 'transition': 25, 'spread': 15}


@dataclass
class Clock:
    """Local estimate of speaker position in track."""
    position: float  # seconds
    at_ms: float     # monotonic time (time.monotonic() * 1000)
    running: bool    # whether position advances with time


def parse_sonos_time(time_str):
    """H:MM:SS to seconds. Returns None for invalid/missing input."""
    if not isinstance(time_str, str):
        return None
    match = re.match(r'^(\d+):([0-5]\d):([0-5]\d)$', time_str)
    if not match:
        return None
    h, m, s = match.groups()
    return int(h) * 3600 + int(m) * 60 + int(s)


def position_at(clock, now_ms):
    """Where the clock says we are, now."""
    if not clock.running:
        return clock.position
    return clock.position + (now_ms - clock.at_ms) / 1000


def sync_clock(previous, reported_seconds, now_ms, playing):
    """Fold reported position into clock, re-anchoring only when drift exceeds threshold."""
    reported = reported_seconds + REPORTED_POSITION_BIAS_SECONDS
    anchor = Clock(position=reported, at_ms=now_ms, running=playing)

    if not playing or previous is None or not previous.running:
        return anchor

    drift = abs(position_at(previous, now_ms) - reported)
    return previous if drift <= RESYNC_THRESHOLD_SECONDS else anchor


def clamp01(value):
    """Clamp value to 0..1."""
    return max(0.0, min(1.0, value))


def hsv_to_rgb(h, s, v):
    """HSV to 8-bit RGB. h in degrees, s/v in 0..1."""
    hue = ((h % 360) + 360) % 360
    chroma = clamp01(v) * clamp01(s)
    x = chroma * (1 - abs(((hue / 60) % 2) - 1))
    m = clamp01(v) - chroma

    if hue < 60:
        r, g, b = chroma, x, 0
    elif hue < 120:
        r, g, b = x, chroma, 0
    elif hue < 180:
        r, g, b = 0, chroma, x
    elif hue < 240:
        r, g, b = 0, x, chroma
    elif hue < 300:
        r, g, b = x, 0, chroma
    else:
        r, g, b = chroma, 0, x

    return (round((r + m) * 255), round((g + m) * 255), round((b + m) * 255))


def sample(values, frame_seconds, t):
    """Linear interpolation into frame_seconds-spaced series, clamped at ends."""
    if not values:
        return 0.0
    if t <= 0 or frame_seconds <= 0:
        return values[0]

    x = t / frame_seconds
    last = len(values) - 1
    if x >= last:
        return values[last]

    i = int(x)
    return values[i] + (values[i + 1] - values[i]) * (x - i)


def last_beat_index(beats, t):
    """Index of last beat at or before t. Binary search, returns -1 before first beat."""
    lo, hi, found = 0, len(beats) - 1, -1
    while lo <= hi:
        mid = (lo + hi) >> 1
        if beats[mid] <= t:
            found = mid
            lo = mid + 1
        else:
            hi = mid - 1
    return found


class Renderer:
    """Per-track palette with brightness normalization."""

    def __init__(self, analysis):
        self.beats = analysis['beats']
        self.energy = analysis['energy']
        self.brightness = analysis['brightness']
        self.frame_seconds = analysis['frame_seconds']
        self.tempo = analysis['tempo']

        # Normalize brightness to arc
        sorted_b = sorted(self.brightness)
        lo = self._quantile(sorted_b, BRIGHTNESS_TRIM)
        hi = self._quantile(sorted_b, 1 - BRIGHTNESS_TRIM)
        if hi - lo < MIN_BRIGHTNESS_SPAN:
            lo, hi = 0.0, 1.0
        self.brightness_range = (lo, hi)
        self._b_lo = lo
        self._b_span = hi - lo

        self._fallback_period = 60 / self.tempo if self.tempo > 0 else 0.5

    @staticmethod
    def _quantile(sorted_values, q):
        """Order statistic with linear interpolation."""
        if not sorted_values:
            return 0.0
        pos = (len(sorted_values) - 1) * q
        i = int(pos)
        next_i = min(i + 1, len(sorted_values) - 1)
        return sorted_values[i] + (sorted_values[next_i] - sorted_values[i]) * (pos - i)

    def frame_at(self, t, options=None):
        """Room color at time t. Returns {hue, saturation, value}."""
        options = options or {}
        brightness_gain = options.get('brightness', 1.0)
        beat_decay = options.get('beatDecay', BEAT_DECAY_FRACTION)
        spread_deg = options.get('spreadDeg', 0.0)

        loudness = clamp01(sample(self.energy, self.frame_seconds, t))
        timbre = clamp01((sample(self.brightness, self.frame_seconds, t) - self._b_lo) / self._b_span) if self._b_span > 0 else 0.5

        # Beat pulse
        i = last_beat_index(self.beats, t)
        if i < 0:
            pulse = 0.0
        else:
            period = self.beats[i] - self.beats[i - 1] if i > 0 else self._fallback_period
            decay = max(period, MIN_BEAT_PERIOD_SECONDS) * beat_decay
            pulse = 2.71828 ** (-(t - self.beats[i]) / decay)  # exp(-x)

        # Arc reduction for spread
        margin = max(0, min(spread_deg, SPREAD_MAX_DEG)) / 2
        low = HUE_MIN_DEG + margin
        high = HUE_MAX_DEG - margin
        hue = low + (high - low) * timbre

        base = MIN_VALUE + (1 - MIN_VALUE) * loudness
        return {
            'hue': hue,
            'saturation': BASE_SATURATION * (1 - pulse * BEAT_WASH),
            'value': clamp01(base + (1 - base) * pulse * BEAT_LIFT) * brightness_gain,
        }


def create_renderer(analysis):
    """Build renderer from analysis sidecar."""
    return Renderer(analysis)


def order_channels(channels, positions):
    """Order channels by physical position (x or y, whichever spans more). Falls back to ID."""
    by_id = sorted(channels)
    if len(by_id) <= 1:
        return by_id

    # Check if all channels have positions
    placed = [positions.get(str(ch)) for ch in by_id]
    if any(p is None for p in placed):
        return by_id

    # Measure span on each axis
    x_vals = [p['x'] for p in placed]
    y_vals = [p['y'] for p in placed]
    span_x = max(x_vals) - min(x_vals)
    span_y = max(y_vals) - min(y_vals)

    if max(span_x, span_y) <= POSITION_EPSILON:
        return by_id

    axis = 'x' if span_x >= span_y else 'y'
    # Sort by axis, ties broken by existing order (stable)
    indexed = [(ch, placed[i][axis]) for i, ch in enumerate(by_id)]
    indexed.sort(key=lambda pair: pair[1])
    return [ch for ch, _ in indexed]


def spread_across(frame, ordered, spread_deg):
    """Fan frame hue across ordered channels. Returns {str(id): (r,g,b)}."""
    colors = {}
    last = len(ordered) - 1
    for i, ch in enumerate(ordered):
        rank = 0.5 if last == 0 else i / last
        hue = frame['hue'] + (rank - 0.5) * spread_deg
        colors[str(ch)] = hsv_to_rgb(hue, frame['saturation'], frame['value'])
    return colors


def ease_toward(prev, target, dt_seconds, tau_seconds):
    """Exponential approach from prev to target. Returns float RGB."""
    if tau_seconds <= 0 or dt_seconds <= 0:
        alpha = 1.0
    else:
        alpha = 1 - math.exp(-dt_seconds / tau_seconds)

    return (
        prev[0] + (target[0] - prev[0]) * alpha,
        prev[1] + (target[1] - prev[1]) * alpha,
        prev[2] + (target[2] - prev[2]) * alpha,
    )


def ease_channels(prev, target, dt_seconds, tau_seconds):
    """Ease across all channels. Target's keys win; new channels ease from IDLE_COLOR."""
    eased = {}
    for key in target:
        prev_color = prev.get(key, IDLE_COLOR) if prev else IDLE_COLOR
        # Convert to float if prev was int (from IDLE_COLOR)
        prev_float = tuple(float(c) for c in prev_color)
        target_float = tuple(float(c) for c in target[key])
        eased[key] = ease_toward(prev_float, target_float, dt_seconds, tau_seconds)
    return eased


def round_rgb(rgb):
    """Float RGB to 8-bit integers."""
    return (round(rgb[0]), round(rgb[1]), round(rgb[2]))


def differs_enough(a, b, epsilon=COLOR_EPSILON):
    """Whether two RGB colors differ by at least epsilon on any channel."""
    return (abs(a[0] - b[0]) >= epsilon or
            abs(a[1] - b[1]) >= epsilon or
            abs(a[2] - b[2]) >= epsilon)


def any_differs_enough(next_colors, last_sent, epsilon=COLOR_EPSILON):
    """Whether any channel in next differs from last, or channel set changed."""
    if last_sent is None:
        return True
    if set(next_colors.keys()) != set(last_sent.keys()):
        return True
    for key in next_colors:
        if differs_enough(next_colors[key], last_sent[key], epsilon):
            return True
    return False


def resolve_settings(settings):
    """Slider positions (0-100) to palette units."""
    brightness = max(0, min(100, settings.get('brightness', 100))) / 100
    transition = max(0, min(100, settings.get('transition', 25))) / 100
    spread = max(0, min(100, settings.get('spread', 15))) / 100

    return {
        'brightness': BRIGHTNESS_FLOOR + (1 - BRIGHTNESS_FLOOR) * brightness,
        'beatDecay': DECAY_MIN + (DECAY_MAX - DECAY_MIN) * transition,
        'spreadDeg': SPREAD_MAX_DEG * spread,
        'tauSeconds': TAU_MIN_SECONDS * (TAU_MAX_SECONDS / TAU_MIN_SECONDS) ** transition,
    }


class RenderLoop:
    """Autonomous 16 Hz render loop that generates colors from speaker position."""

    def __init__(self, session, speaker, cache_dir, settings):
        self.session = session
        self.speaker = speaker
        self.cache_dir = cache_dir
        self.settings = settings
        self._stop = threading.Event()
        self._thread = None
        self.clock = None
        self.renderer = None
        self.current_track = None
        self.eased = None
        self.last_tick_ms = None

    def start(self):
        """Spawn render thread."""
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name='hue-render', daemon=True)
        self._thread.start()

    def stop(self):
        """Signal stop and wait for thread exit."""
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
            self._thread = None

    def update_settings(self, settings):
        """Update brightness/transition/spread live. Thread-safe (atomic replacement)."""
        self.settings = settings

    def _run(self):
        """Main loop: tick every 60ms."""
        while not self._stop.is_set():
            try:
                self._tick()
            except Exception as e:
                logger.error(f"Hue render loop error: {e}")
            self._stop.wait(0.060)  # 16.67 Hz

    def _tick(self):
        """One render cycle: query speaker, generate colors, send."""
        import analysis  # Import here to avoid circular dependency

        now_ms = time.monotonic() * 1000

        # Query speaker
        try:
            track_info = self.speaker.get_current_track_info()
            # Extract video_id from URI (defined in app.py as _video_id_from_uri)
            uri = track_info.get('uri', '')
            # Parse /media/<id>.mp3
            match = re.search(r'/media/([^/]+)\.mp3', uri)
            video_id = match.group(1) if match else None

            position_str = track_info.get('position', '')
            transport = self.speaker.get_current_transport_info()
            playing = transport.get('current_transport_state') == 'PLAYING'
        except Exception as e:
            logger.warning(f"Hue render: could not query speaker: {e}")
            video_id, position_str, playing = None, None, False

        # Load analysis if track changed
        if video_id != self.current_track:
            self.current_track = video_id
            self.renderer = None
            self.clock = None
            if video_id:
                data = analysis.load(self.cache_dir, video_id)
                if data:
                    self.renderer = create_renderer(data)

        # Sync clock
        reported_seconds = parse_sonos_time(position_str)
        if reported_seconds is not None:
            self.clock = sync_clock(self.clock, reported_seconds, now_ms, playing)

        # Compute target colors
        if self.renderer and self.clock:
            resolved = resolve_settings(self.settings)
            t = position_at(self.clock, now_ms)
            frame = self.renderer.frame_at(t, resolved)

            ordered = order_channels(self.session.channels, self.session.positions or {})
            if ordered:
                target = spread_across(frame, ordered, resolved['spreadDeg'])
            else:
                # Whole-room mode
                target = {'*': hsv_to_rgb(frame['hue'], frame['saturation'], frame['value'])}
        else:
            # Idle: no analysis or no track
            target = {'*': IDLE_COLOR}

        # Ease toward target
        dt = (now_ms - self.last_tick_ms) / 1000 if self.last_tick_ms else float('inf')
        self.last_tick_ms = now_ms
        self.eased = ease_channels(self.eased, target, dt, resolve_settings(self.settings)['tauSeconds'])

        # Round and send if changed
        next_colors = {k: round_rgb(v) for k, v in self.eased.items()}
        if any_differs_enough(next_colors, self.session.last_sent):
            payload = next_colors['*'] if '*' in next_colors else next_colors
            self.session.set_color(payload)
            self.session.last_sent = next_colors

        # Publish for SSE preview
        if '*' in next_colors:
            ordered_colors = [next_colors['*']]
        else:
            ordered = order_channels(self.session.channels, self.session.positions or {})
            ordered_colors = [next_colors[str(ch)] for ch in ordered]
        self.session.set_current_colors(ordered_colors)
