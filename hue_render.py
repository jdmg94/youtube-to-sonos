"""Server-side Hue light rendering: color generation and autonomous render loop.

Ports palette logic from web/src/lib/hue.ts to run autonomously on the backend.
"""
import re
from dataclasses import dataclass

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
