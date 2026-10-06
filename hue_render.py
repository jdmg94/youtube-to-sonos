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
