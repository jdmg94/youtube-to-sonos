"""Server-side Hue light rendering: color generation and autonomous render loop.

Ports palette logic from web/src/lib/hue.ts to run autonomously on the backend.
"""
import re
from dataclasses import dataclass

REPORTED_POSITION_BIAS_SECONDS = 0.5
RESYNC_THRESHOLD_SECONDS = 0.75


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
