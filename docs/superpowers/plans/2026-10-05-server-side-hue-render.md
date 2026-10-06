# Server-Side Hue Render Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Hue light synchronization from browser to backend so lights run autonomously after browser closes.

**Architecture:** Port color generation logic from TypeScript to Python, add autonomous 16 Hz render loop in backend that queries speaker position, generates colors from audio analysis, and sends to lights via existing DTLS stream. Frontend becomes passive control panel consuming colors via SSE.

**Tech Stack:** Python 3.12 (backend render loop), TypeScript/React (frontend controls), SSE (color preview updates)

**Spec:** `docs/superpowers/specs/2026-10-05-server-side-hue-render-design.md`

## Global Constraints

- Python 3.12 required (librosa and mbedtls constraint from existing code)
- All color generation constants ported exactly from `web/src/lib/hue.ts` (no algorithm changes)
- Settings ranges: brightness/transition/spread all 0-100 (existing UI contract)
- SSE update rate uses existing `/api/events` polling (~2s, not changed)
- Render loop at 16 Hz (60ms interval) matches existing frontend `SEND_INTERVAL_MS`
- Thread cleanup must be graceful (no orphaned threads on stop)

## Review Focus

1. **Stale speaker position after track skip:** Render loop queries speaker once per tick, but soco caches responses. If cache isn't invalidated on track change, clock syncs to wrong position and lights flash wrong beats. Test: mock speaker returning different video_id, verify clock resets.

2. **Settings update during inactive stream:** `POST /api/hue/settings` while no stream active should 409, not silently succeed and confuse user. Test: settings endpoint without active session returns 409.

3. **Thread not joined on stop:** If `RenderLoop.stop()` doesn't wait for thread exit, subsequent start can spawn second thread, doubling network load and showing race behavior. Test: start/stop/start cycle, verify only one thread alive.

4. **Division by zero in tempo fallback:** `_tempo_from_beats()` with empty beats array or zero median interval must not crash. Test: renderer with empty beats array returns valid tempo.

5. **SSE colors read during render tick write:** `get_current_colors()` without lock while render loop writes could return torn list (partial old/new colors). Test: concurrent reads/writes produce valid-length color arrays (verified by thread safety of lock, not by race test).

---

## Task 1: Clock Synchronization Functions

**Files:**
- Create: `hue_render.py`
- Test: `test_hue_render.py`

**Interfaces:**
- Consumes: None (first task)
- Produces:
  - `class Clock` - dataclass with `position: float`, `at_ms: float`, `running: bool`
  - `parse_sonos_time(time_str: str | None) -> float | None` - "H:MM:SS" to seconds
  - `position_at(clock: Clock, now_ms: float) -> float` - current position accounting for elapsed time
  - `sync_clock(previous: Clock | None, reported_seconds: float, now_ms: float, playing: bool) -> Clock` - fold new position into clock, re-anchor if drift exceeds threshold

- [ ] **Step 1: Write test for `parse_sonos_time()`**

Create `test_hue_render.py`:

```python
import unittest
from hue_render import parse_sonos_time

class ParseSonosTime(unittest.TestCase):
    def test_parses_valid_time(self):
        self.assertEqual(parse_sonos_time('0:02:35'), 155.0)
        self.assertEqual(parse_sonos_time('1:30:00'), 5400.0)

    def test_returns_none_for_invalid(self):
        self.assertIsNone(parse_sonos_time('NOT_IMPLEMENTED'))
        self.assertIsNone(parse_sonos_time(''))
        self.assertIsNone(parse_sonos_time(None))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m unittest test_hue_render.ParseSonosTime -v`
Expected: `ModuleNotFoundError: No module named 'hue_render'`

- [ ] **Step 3: Implement `parse_sonos_time()` in `hue_render.py`**

```python
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
```

- [ ] **Step 4: Write test for `position_at()`**

```python
from hue_render import Clock, position_at

class PositionAt(unittest.TestCase):
    def test_running_clock_advances(self):
        clock = Clock(position=10.0, at_ms=1000.0, running=True)
        # 500ms later = 0.5s
        self.assertAlmostEqual(position_at(clock, 1500.0), 10.5)

    def test_paused_clock_holds(self):
        clock = Clock(position=10.0, at_ms=1000.0, running=False)
        self.assertEqual(position_at(clock, 2000.0), 10.0)
```

- [ ] **Step 5: Implement `position_at()`**

```python
def position_at(clock, now_ms):
    """Where the clock says we are, now."""
    if not clock.running:
        return clock.position
    return clock.position + (now_ms - clock.at_ms) / 1000
```

- [ ] **Step 6: Write test for `sync_clock()`**

```python
from hue_render import sync_clock

class SyncClock(unittest.TestCase):
    def test_initial_anchor_adds_bias(self):
        clock = sync_clock(None, 10.0, 1000.0, True)
        self.assertEqual(clock.position, 10.5)  # +0.5s bias
        self.assertEqual(clock.at_ms, 1000.0)
        self.assertTrue(clock.running)

    def test_keeps_anchor_within_threshold(self):
        prev = Clock(position=10.5, at_ms=1000.0, running=True)
        # 1s later, speaker reports 11s (predicted 11.5, drift=0.5s < 0.75s threshold)
        clock = sync_clock(prev, 11.0, 2000.0, True)
        self.assertEqual(clock.position, 10.5)  # kept previous
        self.assertEqual(clock.at_ms, 1000.0)

    def test_re_anchors_beyond_threshold(self):
        prev = Clock(position=10.0, at_ms=1000.0, running=True)
        # 2s later, speaker reports 13s (predicted 12, drift=1.5s > 0.75s)
        clock = sync_clock(prev, 13.0, 3000.0, True)
        self.assertEqual(clock.position, 13.5)  # re-anchored
        self.assertEqual(clock.at_ms, 3000.0)

    def test_always_re_anchors_when_paused(self):
        prev = Clock(position=10.0, at_ms=1000.0, running=True)
        clock = sync_clock(prev, 10.0, 1100.0, False)
        self.assertEqual(clock.position, 10.5)
        self.assertFalse(clock.running)
```

- [ ] **Step 7: Implement `sync_clock()`**

```python
def sync_clock(previous, reported_seconds, now_ms, playing):
    """Fold reported position into clock, re-anchoring only when drift exceeds threshold."""
    reported = reported_seconds + REPORTED_POSITION_BIAS_SECONDS
    anchor = Clock(position=reported, at_ms=now_ms, running=playing)

    if not playing or previous is None or not previous.running:
        return anchor

    drift = abs(position_at(previous, now_ms) - reported)
    return previous if drift <= RESYNC_THRESHOLD_SECONDS else anchor
```

- [ ] **Step 8: Run all clock tests to verify they pass**

Run: `.venv/bin/python -m unittest test_hue_render.ParseSonosTime test_hue_render.PositionAt test_hue_render.SyncClock -v`
Expected: All tests PASS

- [ ] **Step 9: Commit**

```bash
git add hue_render.py test_hue_render.py
git commit -m "feat(hue): add clock sync functions for server-side render

Port clock synchronization from frontend to backend: parse Sonos time,
track position with drift correction, re-anchor on threshold.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Palette Core Functions

**Files:**
- Modify: `hue_render.py`
- Modify: `test_hue_render.py`

**Interfaces:**
- Consumes: None (pure math functions)
- Produces:
  - `hsv_to_rgb(h: float, s: float, v: float) -> tuple[int, int, int]` - HSV to 8-bit RGB
  - `sample(values: list[float], frame_seconds: float, t: float) -> float` - interpolate into analysis series
  - `last_beat_index(beats: list[float], t: float) -> int` - binary search for beat at/before time
  - `clamp01(value: float) -> float` - clamp to 0..1
  - Constants: `HUE_MIN_DEG=0`, `HUE_MAX_DEG=280`, `MIN_VALUE=0.15`, `BASE_SATURATION=0.9`, etc.

- [ ] **Step 1: Add constants to `hue_render.py`**

```python
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
```

- [ ] **Step 2: Write test for `hsv_to_rgb()`**

```python
from hue_render import hsv_to_rgb

class HsvToRgb(unittest.TestCase):
    def test_pure_red(self):
        self.assertEqual(hsv_to_rgb(0, 1, 1), (255, 0, 0))

    def test_pure_green(self):
        self.assertEqual(hsv_to_rgb(120, 1, 1), (0, 255, 0))

    def test_pure_blue(self):
        self.assertEqual(hsv_to_rgb(240, 1, 1), (0, 0, 255))

    def test_desaturated_is_grey(self):
        self.assertEqual(hsv_to_rgb(180, 0, 0.5), (128, 128, 128))

    def test_wraps_negative_hue(self):
        self.assertEqual(hsv_to_rgb(-60, 1, 1), hsv_to_rgb(300, 1, 1))
```

- [ ] **Step 3: Implement `clamp01()` and `hsv_to_rgb()`**

```python
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
```

- [ ] **Step 4: Write test for `sample()`**

```python
from hue_render import sample

class Sample(unittest.TestCase):
    def test_interpolates_between_frames(self):
        values = [0.0, 1.0]
        # At t=0.05 (halfway between frames at 0.1s spacing)
        self.assertAlmostEqual(sample(values, 0.1, 0.05), 0.5)

    def test_clamps_before_start(self):
        self.assertEqual(sample([5.0, 10.0], 0.1, -1.0), 5.0)

    def test_clamps_after_end(self):
        self.assertEqual(sample([5.0, 10.0], 0.1, 10.0), 10.0)

    def test_empty_array_returns_zero(self):
        self.assertEqual(sample([], 0.1, 5.0), 0.0)
```

- [ ] **Step 5: Implement `sample()`**

```python
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
```

- [ ] **Step 6: Write test for `last_beat_index()`**

```python
from hue_render import last_beat_index

class LastBeatIndex(unittest.TestCase):
    def test_before_first_beat(self):
        self.assertEqual(last_beat_index([1.0, 2.0, 3.0], 0.5), -1)

    def test_exactly_on_beat(self):
        self.assertEqual(last_beat_index([1.0, 2.0, 3.0], 2.0), 1)

    def test_between_beats(self):
        self.assertEqual(last_beat_index([1.0, 2.0, 3.0], 2.5), 1)

    def test_after_last_beat(self):
        self.assertEqual(last_beat_index([1.0, 2.0, 3.0], 10.0), 2)

    def test_empty_beats(self):
        self.assertEqual(last_beat_index([], 5.0), -1)
```

- [ ] **Step 7: Implement `last_beat_index()`**

```python
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
```

- [ ] **Step 8: Run palette tests to verify they pass**

Run: `.venv/bin/python -m unittest test_hue_render.HsvToRgb test_hue_render.Sample test_hue_render.LastBeatIndex -v`
Expected: All tests PASS

- [ ] **Step 9: Commit**

```bash
git add hue_render.py test_hue_render.py
git commit -m "feat(hue): add palette core functions (HSV, sampling, beats)

Port color space conversion, series interpolation, and beat searching
from TypeScript. All constants match existing frontend values exactly.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Renderer and Frame Generation

**Files:**
- Modify: `hue_render.py`
- Modify: `test_hue_render.py`

**Interfaces:**
- Consumes:
  - `hsv_to_rgb()`, `sample()`, `last_beat_index()`, `clamp01()` from Task 2
  - Constants from Task 2
- Produces:
  - `class Renderer` - with `frame_at(t: float, options: dict) -> dict` method
  - `create_renderer(analysis: dict) -> Renderer` - build renderer from analysis sidecar
  - `Frame = dict[str, float]` with keys `hue`, `saturation`, `value`

- [ ] **Step 1: Write test for `create_renderer()` with simple analysis**

```python
from hue_render import create_renderer

class CreateRenderer(unittest.TestCase):
    def test_creates_renderer_from_analysis(self):
        analysis = {
            'tempo': 120,
            'beats': [0.5, 1.0, 1.5],
            'energy': [0.3, 0.7],
            'brightness': [0.2, 0.8],
            'frame_seconds': 0.1,
        }
        renderer = create_renderer(analysis)
        self.assertIsNotNone(renderer)
        # Should have frameAt method
        frame = renderer.frame_at(0.5)
        self.assertIn('hue', frame)
        self.assertIn('saturation', frame)
        self.assertIn('value', frame)

    def test_normalizes_brightness_range(self):
        analysis = {
            'tempo': 120,
            'beats': [],
            'energy': [0.5],
            'brightness': [0.2, 0.3, 0.4, 0.5, 0.6],  # narrow span
            'frame_seconds': 0.1,
        }
        renderer = create_renderer(analysis)
        # Access brightness_range (stored for debugging)
        self.assertIsNotNone(renderer.brightness_range)
```

- [ ] **Step 2: Implement `Renderer` class and `create_renderer()`**

```python
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
```

- [ ] **Step 3: Write test for beat flash behavior**

```python
class FrameAt(unittest.TestCase):
    def test_beat_increases_value(self):
        analysis = {
            'tempo': 120,
            'beats': [1.0],
            'energy': [0.5],
            'brightness': [0.5],
            'frame_seconds': 0.1,
        }
        renderer = create_renderer(analysis)
        # Exactly on beat
        on_beat = renderer.frame_at(1.0)
        # Slightly after
        after_beat = renderer.frame_at(1.1)
        # Beat should lift value
        self.assertGreater(on_beat['value'], after_beat['value'])

    def test_quiet_passage_not_black(self):
        analysis = {
            'tempo': 120,
            'beats': [],
            'energy': [0.0],  # silent
            'brightness': [0.5],
            'frame_seconds': 0.1,
        }
        renderer = create_renderer(analysis)
        frame = renderer.frame_at(0.5)
        # MIN_VALUE = 0.15, so should be at least that
        self.assertGreaterEqual(frame['value'], 0.15)
```

- [ ] **Step 4: Run renderer tests to verify they pass**

Run: `.venv/bin/python -m unittest test_hue_render.CreateRenderer test_hue_render.FrameAt -v`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add hue_render.py test_hue_render.py
git commit -m "feat(hue): add renderer and frame generation

Create per-track renderers with brightness normalization, beat pulse
decay, and arc reduction for spread. Ports frameAt logic from frontend.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Channel Ordering and Gradient Spread

**Files:**
- Modify: `hue_render.py`
- Modify: `test_hue_render.py`

**Interfaces:**
- Consumes:
  - `Renderer.frame_at()` from Task 3
  - `hsv_to_rgb()` from Task 2
- Produces:
  - `order_channels(channels: list[int], positions: dict) -> list[int]` - sort by physical position
  - `spread_across(frame: dict, ordered: list[int], spread_deg: float) -> dict[str, tuple]` - gradient across room
  - `POSITION_EPSILON = 1e-6`

- [ ] **Step 1: Write test for `order_channels()`**

```python
from hue_render import order_channels

class OrderChannels(unittest.TestCase):
    def test_orders_by_x_when_wider(self):
        channels = [2, 0, 1]
        positions = {
            '0': {'x': 0.5, 'y': 0.0, 'z': 0.0},
            '1': {'x': 0.0, 'y': 0.1, 'z': 0.0},
            '2': {'x': 1.0, 'y': 0.2, 'z': 0.0},
        }
        self.assertEqual(order_channels(channels, positions), [1, 0, 2])

    def test_orders_by_y_when_taller(self):
        channels = [2, 0, 1]
        positions = {
            '0': {'x': 0.1, 'y': 0.5, 'z': 0.0},
            '1': {'x': 0.0, 'y': 0.0, 'z': 0.0},
            '2': {'x': 0.2, 'y': 1.0, 'z': 0.0},
        }
        self.assertEqual(order_channels(channels, positions), [1, 0, 2])

    def test_falls_back_to_id_when_no_positions(self):
        channels = [3, 1, 2]
        positions = {}
        self.assertEqual(order_channels(channels, positions), [1, 2, 3])

    def test_falls_back_when_position_missing(self):
        channels = [1, 2]
        positions = {'1': {'x': 0.5, 'y': 0.0, 'z': 0.0}}  # 2 missing
        self.assertEqual(order_channels(channels, positions), [1, 2])
```

- [ ] **Step 2: Implement `order_channels()`**

```python
POSITION_EPSILON = 1e-6

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
```

- [ ] **Step 3: Write test for `spread_across()`**

```python
from hue_render import spread_across

class SpreadAcross(unittest.TestCase):
    def test_spreads_hue_across_channels(self):
        frame = {'hue': 140, 'saturation': 0.9, 'value': 0.8}
        ordered = [0, 1, 2]
        spread_deg = 60
        colors = spread_across(frame, ordered, spread_deg)

        # Three channels: -30, 0, +30 from center hue
        self.assertEqual(len(colors), 3)
        # Keys are stringified channel ids
        self.assertIn('0', colors)
        self.assertIn('2', colors)
        # First channel shifted left, last shifted right
        # (exact RGB values depend on HSV conversion, just verify they differ)
        self.assertNotEqual(colors['0'], colors['2'])

    def test_single_channel_at_center(self):
        frame = {'hue': 100, 'saturation': 0.9, 'value': 0.8}
        colors = spread_across(frame, [5], 60)
        # Rank = 0.5 (middle), shift = 0
        from hue_render import hsv_to_rgb
        self.assertEqual(colors['5'], hsv_to_rgb(100, 0.9, 0.8))

    def test_returns_rgb_tuples(self):
        frame = {'hue': 120, 'saturation': 1.0, 'value': 1.0}
        colors = spread_across(frame, [0, 1], 30)
        # Should be 8-bit RGB tuples
        self.assertIsInstance(colors['0'], tuple)
        self.assertEqual(len(colors['0']), 3)
        self.assertTrue(all(0 <= c <= 255 for c in colors['0']))
```

- [ ] **Step 4: Implement `spread_across()`**

```python
def spread_across(frame, ordered, spread_deg):
    """Fan frame hue across ordered channels. Returns {str(id): (r,g,b)}."""
    colors = {}
    last = len(ordered) - 1
    for i, ch in enumerate(ordered):
        rank = 0.5 if last == 0 else i / last
        hue = frame['hue'] + (rank - 0.5) * spread_deg
        colors[str(ch)] = hsv_to_rgb(hue, frame['saturation'], frame['value'])
    return colors
```

- [ ] **Step 5: Run ordering/spread tests to verify they pass**

Run: `.venv/bin/python -m unittest test_hue_render.OrderChannels test_hue_render.SpreadAcross -v`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add hue_render.py test_hue_render.py
git commit -m "feat(hue): add channel ordering and gradient spread

Order lights by physical position (x/y span), spread hue gradient
across room. Falls back to channel ID when positions unavailable.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: Color Easing and Settings Resolution

**Files:**
- Modify: `hue_render.py`
- Modify: `test_hue_render.py`

**Interfaces:**
- Consumes: Constants from Task 2
- Produces:
  - `ease_toward(prev: tuple, target: tuple, dt_seconds: float, tau_seconds: float) -> tuple` - exponential approach (float RGB)
  - `ease_channels(prev: dict | None, target: dict, dt_seconds: float, tau_seconds: float) -> dict` - ease whole room
  - `round_rgb(rgb: tuple) -> tuple` - float to 8-bit
  - `differs_enough(a: tuple, b: tuple, epsilon: int) -> bool` - worth sending?
  - `any_differs_enough(next_colors: dict, last_sent: dict | None, epsilon: int) -> bool` - any channel changed?
  - `resolve_settings(settings: dict) -> dict` - slider positions to palette units
  - `DEFAULT_SETTINGS = {'brightness': 100, 'transition': 25, 'spread': 15}`

- [ ] **Step 1: Write test for `ease_toward()`**

```python
from hue_render import ease_toward

class EaseToward(unittest.TestCase):
    def test_approaches_target_exponentially(self):
        prev = (100.0, 100.0, 100.0)
        target = (200.0, 200.0, 200.0)
        # dt=0.1, tau=0.2 -> alpha ≈ 0.393
        eased = ease_toward(prev, target, 0.1, 0.2)
        # Should move ~39% toward target
        self.assertGreater(eased[0], 100.0)
        self.assertLess(eased[0], 200.0)

    def test_snap_when_dt_equals_infinity(self):
        prev = (100.0, 100.0, 100.0)
        target = (200.0, 200.0, 200.0)
        eased = ease_toward(prev, target, float('inf'), 0.2)
        self.assertEqual(eased, target)

    def test_returns_floats(self):
        eased = ease_toward((100.0, 100.0, 100.0), (150.0, 150.0, 150.0), 0.1, 0.2)
        self.assertIsInstance(eased[0], float)
```

- [ ] **Step 2: Implement easing functions**

```python
import math

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
```

- [ ] **Step 3: Write test for `resolve_settings()`**

```python
from hue_render import resolve_settings, DEFAULT_SETTINGS, BRIGHTNESS_FLOOR, DECAY_MIN, DECAY_MAX, SPREAD_MAX_DEG, TAU_MIN_SECONDS, TAU_MAX_SECONDS

class ResolveSettings(unittest.TestCase):
    def test_default_settings(self):
        resolved = resolve_settings(DEFAULT_SETTINGS)
        self.assertEqual(resolved['brightness'], 1.0)  # 100 -> 1.0
        # transition=25 -> beatDecay between MIN and MAX
        self.assertGreater(resolved['beatDecay'], DECAY_MIN)
        self.assertLess(resolved['beatDecay'], DECAY_MAX)

    def test_brightness_floor(self):
        resolved = resolve_settings({'brightness': 0, 'transition': 50, 'spread': 0})
        self.assertEqual(resolved['brightness'], BRIGHTNESS_FLOOR)

    def test_spread_scales_linearly(self):
        resolved = resolve_settings({'brightness': 100, 'transition': 50, 'spread': 50})
        self.assertAlmostEqual(resolved['spreadDeg'], SPREAD_MAX_DEG * 0.5)

    def test_tau_scales_geometrically(self):
        resolved_min = resolve_settings({'brightness': 100, 'transition': 0, 'spread': 0})
        resolved_max = resolve_settings({'brightness': 100, 'transition': 100, 'spread': 0})
        self.assertAlmostEqual(resolved_min['tauSeconds'], TAU_MIN_SECONDS)
        self.assertAlmostEqual(resolved_max['tauSeconds'], TAU_MAX_SECONDS)
```

- [ ] **Step 4: Implement `resolve_settings()`**

```python
DEFAULT_SETTINGS = {'brightness': 100, 'transition': 25, 'spread': 15}

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
```

- [ ] **Step 5: Run easing/settings tests to verify they pass**

Run: `.venv/bin/python -m unittest test_hue_render.EaseToward test_hue_render.ResolveSettings -v`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add hue_render.py test_hue_render.py
git commit -m "feat(hue): add color easing and settings resolution

Exponential approach for smooth color transitions, epsilon-based change
detection, and slider-to-palette unit conversion.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: RenderLoop Class

**Files:**
- Modify: `hue_render.py`
- Modify: `test_hue_render.py`

**Interfaces:**
- Consumes: All functions from Tasks 1-5
- Produces:
  - `class RenderLoop` with:
    - `__init__(session, speaker, cache_dir, settings)`
    - `start()` - spawn thread
    - `stop()` - graceful shutdown
    - `update_settings(settings)` - live settings update
    - `_run()` - main loop
    - `_tick()` - one render cycle

- [ ] **Step 1: Write test for RenderLoop lifecycle**

```python
from hue_render import RenderLoop
from unittest.mock import Mock
import threading
import time

class RenderLoopLifecycle(unittest.TestCase):
    def test_starts_and_stops_cleanly(self):
        session = Mock()
        session.channels = [0, 1]
        session.positions = {}
        session.set_color = Mock()
        session.set_current_colors = Mock()
        session.last_sent = None

        speaker = Mock()
        speaker.get_current_track_info.return_value = {'uri': '', 'position': '0:00:00'}
        speaker.get_current_transport_info.return_value = {'current_transport_state': 'PAUSED'}

        loop = RenderLoop(session, speaker, '/tmp', {'brightness': 100, 'transition': 25, 'spread': 15})

        # Should not be running yet
        self.assertIsNone(loop._thread)

        loop.start()
        # Thread should spawn
        self.assertIsNotNone(loop._thread)
        self.assertTrue(loop._thread.is_alive())

        # Let it tick at least once
        time.sleep(0.1)

        loop.stop()
        # Thread should exit
        self.assertFalse(loop._thread.is_alive() if loop._thread else True)

    def test_update_settings_while_running(self):
        session = Mock()
        session.channels = [0]
        session.positions = {}
        session.set_color = Mock()
        session.set_current_colors = Mock()
        session.last_sent = None

        speaker = Mock()
        speaker.get_current_track_info.return_value = {'uri': '', 'position': '0:00:00'}
        speaker.get_current_transport_info.return_value = {'current_transport_state': 'PAUSED'}

        loop = RenderLoop(session, speaker, '/tmp', {'brightness': 100, 'transition': 25, 'spread': 15})
        loop.start()

        # Update settings
        new_settings = {'brightness': 50, 'transition': 75, 'spread': 30}
        loop.update_settings(new_settings)

        # Should update immediately (atomic dict replacement)
        self.assertEqual(loop.settings, new_settings)

        loop.stop()
```

- [ ] **Step 2: Implement `RenderLoop` class**

```python
import threading
import time
import logging

logger = logging.getLogger(__name__)

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
            import re
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
```

- [ ] **Step 3: Run RenderLoop tests to verify they pass**

Run: `.venv/bin/python -m unittest test_hue_render.RenderLoopLifecycle -v`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add hue_render.py test_hue_render.py
git commit -m "feat(hue): add autonomous RenderLoop class

16 Hz loop queries speaker position, generates colors from analysis,
eases transitions, and sends to lights. Runs independently of browser.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: Extend HueSession for Render Loop

**Files:**
- Modify: `hue.py`
- Modify: `test_hue.py`

**Interfaces:**
- Consumes: `RenderLoop` from Task 6
- Produces:
  - `HueSession.positions` - channel position dict
  - `HueSession.render_loop` - RenderLoop instance or None
  - `HueSession.settings` - current settings dict
  - `HueSession.last_sent` - last colors sent (for diff)
  - `HueSession._current_colors` - for SSE
  - `HueSession._colors_lock` - threading.Lock
  - `HueSession.start_render_loop(speaker, cache_dir, settings)`
  - `HueSession.stop_render_loop()`
  - `HueSession.update_settings(settings)`
  - `HueSession.get_current_colors()`
  - `HueSession.set_current_colors(colors)`

- [ ] **Step 1: Write test for HueSession render loop integration**

```python
# In test_hue.py
from hue import HueSession
from unittest.mock import Mock

class HueSessionRenderLoop(unittest.TestCase):
    def test_start_render_loop_spawns_thread(self):
        client = Mock()
        session = HueSession(client, 'area-1', [0, 1])

        speaker = Mock()
        speaker.get_current_track_info.return_value = {'uri': '', 'position': '0:00:00'}
        speaker.get_current_transport_info.return_value = {'current_transport_state': 'PAUSED'}

        session.start_render_loop(speaker, '/tmp', {'brightness': 100, 'transition': 25, 'spread': 15})

        self.assertIsNotNone(session.render_loop)
        self.assertIsNotNone(session.render_loop._thread)

        session.stop_render_loop()

    def test_get_set_current_colors_thread_safe(self):
        client = Mock()
        session = HueSession(client, 'area-1', [0, 1])

        # Initially None
        self.assertIsNone(session.get_current_colors())

        # Set colors
        colors = [(255, 0, 0), (0, 255, 0)]
        session.set_current_colors(colors)

        # Read back
        self.assertEqual(session.get_current_colors(), colors)
```

- [ ] **Step 2: Implement HueSession extensions**

```python
# In hue.py, modify HueSession.__init__:
class HueSession:
    def __init__(self, client, area_id, channels, positions=None):
        # ...existing fields...
        self.positions = positions or {}  # {str(channel_id): {'x': float, 'y': float, 'z': float}}
        self.render_loop = None
        self.settings = None
        self.last_sent = None
        self._current_colors = None
        self._colors_lock = threading.Lock()

    def start_render_loop(self, speaker, cache_dir, settings):
        """Spawn autonomous render loop."""
        if self.render_loop is not None:
            self.render_loop.stop()

        import hue_render
        self.settings = settings
        self.render_loop = hue_render.RenderLoop(self, speaker, cache_dir, settings)
        self.render_loop.start()

    def stop_render_loop(self):
        """Stop render loop gracefully."""
        if self.render_loop is not None:
            self.render_loop.stop()
            self.render_loop = None

    def update_settings(self, settings):
        """Update brightness/transition/spread on running stream."""
        self.settings = settings
        if self.render_loop:
            self.render_loop.update_settings(settings)

    def get_current_colors(self):
        """Thread-safe read for SSE. Returns list of RGB tuples or None."""
        with self._colors_lock:
            return self._current_colors

    def set_current_colors(self, colors):
        """Called by render loop to publish colors for SSE."""
        with self._colors_lock:
            self._current_colors = colors

    def stop(self):
        """Extended to stop render loop before DTLS teardown."""
        self.stop_render_loop()
        # ...existing stop logic...
```

- [ ] **Step 3: Run HueSession tests to verify they pass**

Run: `.venv/bin/python -m unittest test_hue.HueSessionRenderLoop -v`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add hue.py test_hue.py
git commit -m "feat(hue): extend HueSession for render loop integration

Add render loop lifecycle methods, thread-safe color storage for SSE,
and graceful shutdown on stop.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: Modify `/api/hue/stream` Endpoint

**Files:**
- Modify: `app.py` (around line 3331)

**Interfaces:**
- Consumes:
  - `HueSession.start_render_loop()` from Task 7
  - `HueSession.stop_render_loop()` from Task 7
- Produces:
  - `POST /api/hue/stream` with `{action: "start", area, speaker_ip, settings}` - starts render loop
  - `POST /api/hue/stream` with `{action: "stop"}` - stops render loop
  - Removes `{action: "color"}` - no longer supported

- [ ] **Step 1: Locate `_get_speaker()` helper or add it**

Check if a speaker lookup helper exists. If not, add near other Hue helpers:

```python
def _get_speaker(speaker_ip=None):
    """Find speaker by IP, or discover first one."""
    if speaker_ip:
        try:
            return soco.SoCo(speaker_ip)
        except Exception as e:
            raise ValueError(f"Could not connect to speaker at {speaker_ip}: {e}")

    # Discover first speaker
    devices = soco.discover(timeout=2)
    if not devices:
        raise ValueError("No Sonos speakers found on network")
    return next(iter(devices))
```

- [ ] **Step 2: Modify `/api/hue/stream` endpoint**

```python
@app.route('/api/hue/stream', methods=['POST'])
def hue_stream():
    """Start or stop the light stream.

    {"action": "start", "area": "<id>", "speaker_ip": "...", "settings": {...}}
    {"action": "stop"}
    """
    global _HUE_SESSION
    data = request.get_json(silent=True) or {}
    action = (data.get('action') or 'start').lower()

    try:
        if action == 'stop':
            _hue_stop()
            return jsonify({"streaming": False})

        if action == 'color':
            # No longer supported - render loop sends colors autonomously
            return jsonify({"error": "Color action removed; use server-side render loop"}), 400

        if action != 'start':
            return jsonify({"error": f"Unknown action {action!r}"}), 400

        with _HUE_LOCK:
            client = hue.BridgeClient.from_state()
            areas = client.areas()
            if not areas:
                return jsonify({"error": "No entertainment area on this bridge"}), 409

            area_id = data.get('area') or areas[0]['id']
            area = next((a for a in areas if a['id'] == area_id), None)
            if area is None:
                return jsonify({"error": f"No such entertainment area {area_id!r}"}), 404
            if not area['channels']:
                return jsonify({"error": f"Area {area.get('name') or area_id} has no lights"}), 409

            # Restarting same area is no-op
            if _HUE_SESSION is not None:
                if _HUE_SESSION.area_id == area_id and _HUE_SESSION.is_active():
                    return jsonify({"streaming": True, "area": area_id,
                                    "channels": _HUE_SESSION.channels,
                                    "psk_profile": _HUE_SESSION.profile})
                _HUE_SESSION.stop()
                _HUE_SESSION = None

            # Get speaker and settings
            speaker_ip = data.get('speaker_ip')
            if not speaker_ip:
                return jsonify({"error": "Missing required field: speaker_ip"}), 400

            speaker = _get_speaker(speaker_ip)
            settings = data.get('settings', hue_render.DEFAULT_SETTINGS)

            # Start DTLS stream
            session = hue.HueSession(client, area_id, area['channels'], area.get('positions', {}))
            session.start()

            # Start render loop
            session.start_render_loop(speaker, CACHE_DIR, settings)

            _HUE_SESSION = session
            return jsonify({"streaming": True, "area": area_id,
                            "channels": session.channels,
                            "psk_profile": session.profile})
    except Exception as e:
        return _hue_error(e)
```

- [ ] **Step 3: Test manually with curl**

Run backend, then:

```bash
# Should fail without speaker_ip
curl -X POST http://localhost:5001/api/hue/stream \
  -H "Content-Type: application/json" \
  -d '{"action": "start", "area": "area-id"}'

# Expected: 400 "Missing required field: speaker_ip"

# Should fail with color action
curl -X POST http://localhost:5001/api/hue/stream \
  -H "Content-Type: application/json" \
  -d '{"action": "color", "color": [255, 0, 0]}'

# Expected: 400 "Color action removed"
```

- [ ] **Step 4: Commit**

```bash
git add app.py
git commit -m "feat(hue): modify stream endpoint to start render loop

Accept speaker_ip and settings on start action, spawn autonomous render
loop. Remove color action (no longer needed).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: Add `/api/hue/settings` Endpoint

**Files:**
- Modify: `app.py`

**Interfaces:**
- Consumes: `HueSession.update_settings()` from Task 7
- Produces: `POST /api/hue/settings {brightness, transition, spread}` - updates live settings

- [ ] **Step 1: Add endpoint after `/api/hue/stream`**

```python
@app.route('/api/hue/settings', methods=['POST'])
def hue_settings():
    """Update brightness/transition/spread on a running stream."""
    data = request.get_json() or {}
    brightness = data.get('brightness')
    transition = data.get('transition')
    spread = data.get('spread')

    # Validate ranges (0-100)
    for name, value in [('brightness', brightness), ('transition', transition), ('spread', spread)]:
        if value is not None and not (isinstance(value, (int, float)) and 0 <= value <= 100):
            return jsonify({"error": f"{name} must be 0-100"}), 400

    with _HUE_LOCK:
        if _HUE_SESSION is None or not _HUE_SESSION.is_active():
            return jsonify({"error": "Not streaming"}), 409

        # Merge with existing settings (allow partial updates)
        current = _HUE_SESSION.settings or hue_render.DEFAULT_SETTINGS
        settings = {
            'brightness': brightness if brightness is not None else current['brightness'],
            'transition': transition if transition is not None else current['transition'],
            'spread': spread if spread is not None else current['spread'],
        }
        _HUE_SESSION.update_settings(settings)
        return jsonify({"settings": settings})
```

- [ ] **Step 2: Test manually with curl**

```bash
# Start stream first (use real area/speaker from your setup)
curl -X POST http://localhost:5001/api/hue/stream \
  -H "Content-Type: application/json" \
  -d '{"action": "start", "area": "area-id", "speaker_ip": "192.168.1.50"}'

# Update brightness
curl -X POST http://localhost:5001/api/hue/settings \
  -H "Content-Type: application/json" \
  -d '{"brightness": 75}'

# Expected: {"settings": {"brightness": 75, "transition": 25, "spread": 15}}

# Try without stream
curl -X POST http://localhost:5001/api/hue/stream \
  -H "Content-Type: application/json" \
  -d '{"action": "stop"}'

curl -X POST http://localhost:5001/api/hue/settings \
  -H "Content-Type: application/json" \
  -d '{"brightness": 50}'

# Expected: 409 "Not streaming"
```

- [ ] **Step 3: Commit**

```bash
git add app.py
git commit -m "feat(hue): add settings endpoint for live updates

Allow brightness/transition/spread adjustments on running stream.
Partial updates merge with existing settings.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 10: Modify `/api/hue/health` and `/api/events`

**Files:**
- Modify: `app.py`

**Interfaces:**
- Consumes:
  - `HueSession.get_current_colors()` from Task 7
  - `HueSession.render_loop.current_track` from Task 6
- Produces:
  - `/api/hue/health` with `analysis_status` field
  - `/api/events` SSE with `hue_colors` in `NowPlaying` payload

- [ ] **Step 1: Add `analysis_status` to `/api/hue/health`**

Find `_hue_health_payload()` (around line 3200) and add:

```python
def _hue_health_payload():
    # ...existing fields...
    paired = is_paired()

    # Determine analysis status
    analysis_status = 'idle'
    if paired and _HUE_SESSION and _HUE_SESSION.render_loop:
        video_id = _HUE_SESSION.render_loop.current_track
        if video_id:
            if _HUE_SESSION.render_loop.renderer:
                analysis_status = 'ready'
            else:
                # Check if analysis exists or is queued
                if analysis.load(CACHE_DIR, video_id):
                    analysis_status = 'ready'
                elif analysis.pending() > 0:
                    analysis_status = 'analysing'
                else:
                    analysis_status = 'unavailable'

    return {
        'paired': paired,
        'streaming': _HUE_SESSION is not None and _HUE_SESSION.is_active() if paired else False,
        'area': _HUE_SESSION.area_id if _HUE_SESSION and _HUE_SESSION.is_active() else None,
        'error': None,  # Populated by caller on exception
        'analysis_status': analysis_status,
    }
```

- [ ] **Step 2: Add `hue_colors` to SSE payload**

Find `_now_playing_payload()` (in `/api/events` route, around line 2800) and add:

```python
def _now_playing_payload(speaker):
    # ...existing logic to build payload...

    # Add Hue colors for preview
    hue_colors = None
    if _HUE_SESSION and _HUE_SESSION.is_active():
        hue_colors = _HUE_SESSION.get_current_colors()

    return {
        'video_id': video_id,
        'state': state,
        'position': position,
        # ...other fields...
        'hue_colors': hue_colors,
    }
```

- [ ] **Step 3: Test SSE manually**

Start stream with lights running, then in another terminal:

```bash
curl -N http://localhost:5001/api/events

# Should see SSE events with hue_colors field:
# data: {"now_playing": {..., "hue_colors": [[255, 100, 50], [200, 80, 40]]}, ...}
```

- [ ] **Step 4: Commit**

```bash
git add app.py
git commit -m "feat(hue): add analysis_status to health, hue_colors to SSE

Expose analysis state for frontend status display, publish current
colors via SSE for passive preview swatch.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 11: Update Frontend API Types

**Files:**
- Modify: `web/src/lib/api/types.ts`

**Interfaces:**
- Consumes: Backend API changes from Tasks 8-10
- Produces:
  - `NowPlaying` interface with `hue_colors` field
  - `HueHealth` interface with `analysis_status` field
  - `AnalysisStatus` type

- [ ] **Step 1: Add `hue_colors` to `NowPlaying` interface**

```typescript
export interface NowPlaying {
  video_id: string | null;
  state: SonosState;
  position: SonosTime;
  title: string | null;
  artist: string | null;
  album: string | null;
  artwork_url: string | null;
  duration: number | null;
  queue_position: number | null;
  hue_colors: Rgb[] | null;  // NEW: from server-side render loop
}
```

- [ ] **Step 2: Add `analysis_status` to `HueHealth` interface**

```typescript
export type AnalysisStatus = 'idle' | 'analysing' | 'ready' | 'unavailable';

export interface HueHealth {
  paired: boolean;
  streaming: boolean;
  area: string | null;
  error: string | null;
  analysis_status: AnalysisStatus;  // NEW
}
```

- [ ] **Step 3: Run typecheck**

Run: `cd web && pnpm typecheck`
Expected: No errors (types match backend)

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/api/types.ts
git commit -m "feat(hue): add hue_colors and analysis_status to API types

Update TypeScript interfaces to match backend SSE payload changes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 12: Update Frontend API Client

**Files:**
- Modify: `web/src/lib/api/client.ts`

**Interfaces:**
- Consumes: Updated types from Task 11
- Produces:
  - `hueStream()` with new signature accepting settings and speaker_ip
  - `hueSettings()` new function for live updates
  - Removes `hueColor()` function

- [ ] **Step 1: Add `hueSettings()` function**

```typescript
export async function hueSettings(
  settings: { brightness?: number; transition?: number; spread?: number },
  signal?: AbortSignal,
) {
  return fetchJson<{ settings: { brightness: number; transition: number; spread: number } }>(
    '/api/hue/settings',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
      signal,
    },
  );
}
```

- [ ] **Step 2: Update `hueStream()` signature**

```typescript
export async function hueStream(
  action: 'start' | 'stop',
  options?: {
    area?: string;
    speaker_ip?: string;
    settings?: { brightness: number; transition: number; spread: number };
  },
  signal?: AbortSignal,
) {
  return fetchJson<{
    streaming: boolean;
    area?: string;
    channels?: number[];
    psk_profile?: string[];
  }>('/api/hue/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...options }),
    signal,
  });
}
```

- [ ] **Step 3: Remove `hueColor()` function**

Delete the entire `hueColor()` function (should be around 10 lines).

- [ ] **Step 4: Run typecheck and lint**

Run: `cd web && pnpm typecheck && pnpm lint`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/api/client.ts
git commit -m "feat(hue): update API client for server-side rendering

Add hueSettings(), update hueStream() signature, remove hueColor().
Frontend no longer sends colors to backend.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 13: Modify `use-hue-settings.ts` for Live Updates

**Files:**
- Modify: `web/src/lib/hooks/use-hue-settings.ts`

**Interfaces:**
- Consumes:
  - `api.hueSettings()` from Task 12
  - `streaming` state from parent
- Produces:
  - `setBrightness/setTransition/setSpread()` that send to backend when streaming

- [ ] **Step 1: Add `streaming` parameter to hook**

```typescript
export function useHueSettings(streaming: boolean): HueSettingsState {
  const [settings, setSettings] = usePersistedState<HueSettings>(
    'hue-settings',
    DEFAULT_SETTINGS,
  );

  const resolved = useMemo(() => resolveSettings(settings), [settings]);

  const updateSetting = useCallback(
    async (key: keyof HueSettings, value: number) => {
      setSettings((prev) => ({ ...prev, [key]: value }));

      // If streaming, send update to backend immediately
      if (streaming) {
        try {
          await api.hueSettings({ [key]: value });
        } catch (error) {
          console.error('Failed to update Hue settings:', error);
          // Don't revert local state - optimistic update
        }
      }
    },
    [streaming, setSettings],
  );

  return {
    settings,
    resolved,
    setBrightness: (v) => updateSetting('brightness', v),
    setTransition: (v) => updateSetting('transition', v),
    setSpread: (v) => updateSetting('spread', v),
  };
}
```

- [ ] **Step 2: Update type definition**

```typescript
export interface HueSettingsState {
  settings: HueSettings;
  resolved: ResolvedSettings;
  setBrightness: (value: number) => void;
  setTransition: (value: number) => void;
  setSpread: (value: number) => void;
}
```

- [ ] **Step 3: Run typecheck**

Run: `cd web && pnpm typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/hooks/use-hue-settings.ts
git commit -m "feat(hue): add live settings updates to use-hue-settings

Send brightness/transition/spread to backend immediately when streaming.
Optimistic update keeps UI responsive.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 14: Modify `use-hue.ts` to Send Settings on Start

**Files:**
- Modify: `web/src/lib/hooks/use-hue.ts`

**Interfaces:**
- Consumes:
  - `api.hueStream()` with new signature from Task 12
  - `useHueSettings()` (needs to be passed in or accessed via context)
- Produces:
  - `start()` method that sends speaker_ip and settings

- [ ] **Step 1: Add speaker IP derivation helper**

```typescript
// At top of file
function getSpeakerIp(nowPlaying: NowPlaying | null, devices: SonosDevice[]): string | null {
  // Try to get from current device in context, or first discovered device
  // This is a simplification - adjust based on your app's architecture
  if (devices.length > 0) {
    return devices[0].ip;
  }
  return null;
}
```

- [ ] **Step 2: Modify `start()` to include settings and speaker_ip**

Find the `start` function and update:

```typescript
const start = useCallback(async () => {
  if (!area) return;
  setBusy(true);
  setStreamError(null);

  try {
    // Get speaker IP - adjust this based on your app's state management
    // You may need to pass devices/nowPlaying from parent or context
    const speakerIp = /* derive from app state */;

    if (!speakerIp) {
      throw new Error('No speaker available');
    }

    await api.hueStream('start', {
      area: area.id,
      speaker_ip: speakerIp,
      settings: {
        brightness: /* from useHueSettings or props */,
        transition: /* from useHueSettings or props */,
        spread: /* from useHueSettings or props */,
      },
    });

    await refresh();
  } catch (error) {
    setStreamError(error instanceof Error ? error : new Error(String(error)));
  } finally {
    setBusy(false);
  }
}, [area, refresh, /* add settings dependencies */]);
```

**Note:** The exact implementation depends on how speaker state and settings are accessed. You may need to:
- Pass `speakerIp` as a prop to `useHue`
- Access settings from a context
- Lift settings to parent component

- [ ] **Step 3: Run typecheck**

Run: `cd web && pnpm typecheck`
Expected: No errors (adjust implementation until it passes)

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/hooks/use-hue.ts
git commit -m "feat(hue): send speaker_ip and settings on stream start

Pass speaker IP and current settings to backend when starting lights.
Backend spawns autonomous render loop.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 15: Modify `lights-panel.tsx` to Consume SSE Colors

**Files:**
- Modify: `web/src/components/lights-panel.tsx`

**Interfaces:**
- Consumes:
  - `nowPlaying.hue_colors` from SSE (Task 11)
  - `hue.health.analysis_status` from health endpoint (Task 11)
- Produces:
  - Updated `LightsPanel` consuming colors from props instead of computing them
  - `SwatchStrip` shows SSE colors
  - Status display uses `analysis_status` from backend

- [ ] **Step 1: Update `LightsPanel` props and logic**

```typescript
export function LightsPanel({ nowPlaying }: LightsPanelProps) {
  const hue = useHue();
  const dials = useHueSettings(hue.streaming);  // Pass streaming state

  const analysisStatus = hue.health?.analysis_status ?? 'idle';
  const hueColors = nowPlaying?.hue_colors ?? null;

  useErrorToast(hue.streamError);

  const paired = hue.health?.paired ?? false;

  return (
    <div className="flex min-h-0 flex-col gap-2.5">
      <StatusHeader hue={hue} paired={paired} />

      {paired ? (
        <>
          <AreaList hue={hue} />
          <LightSettings dials={dials} />
          <StreamControls hue={hue} status={analysisStatus} colors={hueColors} />
        </>
      ) : (
        <BridgeList hue={hue} />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Update `StreamControls` to use backend status**

```typescript
// Update the ANALYSIS_NOTE mapping to use AnalysisStatus type
import type { AnalysisStatus } from "@/lib/api/types";

const ANALYSIS_NOTE: Record<AnalysisStatus, string> = {
  idle: "Esperando una pista",
  analysing: "Analizando la pista…",
  ready: "Siguiendo el ritmo",
  unavailable: "Sin análisis para esta pista — manteniendo un brillo cálido",
};

function StreamControls({
  hue,
  status,
  colors,
}: {
  hue: HueState;
  status: AnalysisStatus;
  colors: Rgb[] | null;
}) {
  const ready = hue.area ? describeArea(hue.area, hue.health).ready : false;

  return (
    <div className="mt-1.5 flex shrink-0 items-center gap-3 border-t border-border pt-4">
      <SwatchStrip colors={colors} streaming={hue.streaming} />

      <span className="min-w-0 flex-1 truncate text-[0.82rem] text-muted-foreground">
        {hue.streaming ? ANALYSIS_NOTE[status] : "Las luces no están siguiendo"}
      </span>

      <Button
        size="lg"
        variant={hue.streaming ? "outline" : "default"}
        onClick={hue.streaming ? hue.stop : hue.start}
        disabled={hue.busy || (!hue.streaming && !ready)}
      >
        {hue.busy && <Loader2 aria-hidden className="animate-spin" />}
        {hue.streaming ? "Detener" : "Iniciar"}
      </Button>
    </div>
  );
}
```

- [ ] **Step 3: SwatchStrip stays unchanged (already passive display)**

Verify `SwatchStrip` just displays colors from props - no changes needed.

- [ ] **Step 4: Run typecheck and lint**

Run: `cd web && pnpm typecheck && pnpm lint`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add web/src/components/lights-panel.tsx
git commit -m "feat(hue): consume SSE colors and status in lights panel

Display colors from backend SSE instead of computing locally. Show
analysis status from health endpoint.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 16: Remove Client-Side Render Hook

**Files:**
- Delete: `web/src/lib/hooks/use-hue-render.ts`
- Delete: `web/src/lib/hooks/use-hue-render.test.ts`

**Interfaces:**
- Consumes: Nothing (cleanup task)
- Produces: Nothing (files deleted)

- [ ] **Step 1: Verify no imports remain**

Search for imports of `use-hue-render`:

```bash
cd web && grep -r "use-hue-render" src/
```

Expected: No matches (all removed in previous tasks)

- [ ] **Step 2: Delete files**

```bash
cd web
rm src/lib/hooks/use-hue-render.ts
rm src/lib/hooks/use-hue-render.test.ts
```

- [ ] **Step 3: Run typecheck and tests**

Run: `cd web && pnpm typecheck && pnpm test`
Expected: All pass, no missing module errors

- [ ] **Step 4: Commit**

```bash
git add -u web/src/lib/hooks/
git commit -m "refactor(hue): remove client-side render hook

Delete use-hue-render and tests - color generation now runs
server-side. Frontend consumes colors via SSE.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 17: Archive Frontend Palette Logic

**Files:**
- Archive (optional): `web/src/lib/hue.ts` and `web/src/lib/hue.test.ts`

**Interfaces:**
- Consumes: Nothing (cleanup task)
- Produces: Nothing (files archived or deleted after validation)

- [ ] **Step 1: Verify no imports remain**

Search for imports from `@/lib/hue`:

```bash
cd web && grep -r "from \"@/lib/hue\"" src/ --exclude-dir=lib
```

Expected: No matches outside of `web/src/lib/` itself

- [ ] **Step 2: Move to archive or delete**

Option A (archive for reference):
```bash
mkdir -p web/src/lib/_archived
git mv web/src/lib/hue.ts web/src/lib/_archived/
git mv web/src/lib/hue.test.ts web/src/lib/_archived/
```

Option B (delete entirely):
```bash
cd web
rm src/lib/hue.ts
rm src/lib/hue.test.ts
```

- [ ] **Step 3: Run typecheck and tests**

Run: `cd web && pnpm typecheck && pnpm test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add -u web/src/lib/
git commit -m "refactor(hue): archive frontend palette logic

Palette generation ported to Python backend (hue_render.py). Keeping
TypeScript version archived for reference during validation.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 18: Integration Testing and Validation

**Files:**
- None (manual testing and verification)

**Interfaces:**
- Consumes: Entire implementation from Tasks 1-17
- Produces: Validated working system

- [ ] **Step 1: Run all Python tests**

```bash
.venv/bin/python -m unittest discover -v
```

Expected: All tests PASS

- [ ] **Step 2: Run all frontend tests**

```bash
cd web && pnpm test
```

Expected: All tests PASS

- [ ] **Step 3: Manual end-to-end test**

1. Start backend: `make run-local` (or `python app.py`)
2. Start frontend: `cd web && pnpm dev`
3. Open browser to `http://localhost:3000`
4. Navigate to Lights tab
5. Start lights (if bridge paired and area configured)
6. Verify swatch shows colors updating
7. Adjust brightness slider - verify lights respond within 100ms
8. Close browser tab
9. Wait 30 seconds
10. Reopen browser - verify lights still running, swatch shows current colors
11. Skip to different song - verify lights follow new beat
12. Stop lights - verify room restores to pre-stream state

- [ ] **Step 4: Check for thread leaks**

```python
# Add temporary diagnostic
import threading
print(f"Active threads: {threading.active_count()}")
print([t.name for t in threading.enumerate()])
```

Start/stop lights multiple times, verify thread count doesn't grow.

- [ ] **Step 5: Load test (optional)**

Leave lights running for 1+ hour, verify:
- No memory leaks (check process RSS)
- No thread accumulation
- Lights still responsive to settings changes
- SSE still publishing colors

- [ ] **Step 6: Document any issues found**

If bugs found, create follow-up tasks. Otherwise, mark validation complete.

- [ ] **Step 7: Commit validation script or notes**

```bash
# If you created test scripts, commit them
git add tests/integration/hue_render_e2e.py  # example
git commit -m "test(hue): add integration test for server-side render

End-to-end validation: start/stop, settings updates, track changes,
browser-independent operation.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 19: Update Documentation

**Files:**
- Modify: `API.md` (update `/api/hue/stream` and add `/api/hue/settings`)
- Modify: `CLAUDE.md` (update architecture notes)

**Interfaces:**
- Consumes: Complete implementation
- Produces: Updated documentation

- [ ] **Step 1: Update `API.md` for Hue endpoints**

Find `/api/hue/stream` section and update:

```markdown
### POST /api/hue/stream

Start or stop the Hue Entertainment stream.

**Start:**
```json
{
  "action": "start",
  "area": "<area_id>",
  "speaker_ip": "192.168.1.50",
  "settings": {
    "brightness": 100,
    "transition": 25,
    "spread": 15
  }
}
```

Spawns autonomous 16 Hz render loop that queries speaker position, generates
colors from audio analysis, and sends to lights. `speaker_ip` is required.
`settings` optional (defaults to 100/25/15).

**Stop:**
```json
{"action": "stop"}
```

Stops render loop and tears down DTLS stream.

**Response:** `{"streaming": bool, "area": string, "channels": number[], "psk_profile": string[]}`

### POST /api/hue/settings

Update brightness/transition/spread on running stream. Changes take effect
within 60ms (next render tick).

**Body:**
```json
{
  "brightness": 0-100,   // optional
  "transition": 0-100,   // optional
  "spread": 0-100        // optional
}
```

Partial updates allowed. Returns 409 if no stream active.

**Response:** `{"settings": {"brightness": number, "transition": number, "spread": number}}`

### GET /api/hue/health

Returns bridge and stream status.

**Response:**
```json
{
  "paired": bool,
  "streaming": bool,
  "area": string | null,
  "error": string | null,
  "analysis_status": "idle" | "analysing" | "ready" | "unavailable"
}
```

`analysis_status` reports whether current track has analysis available for rendering.

### GET /api/events (SSE)

Now-playing payload includes `hue_colors` field:

```json
{
  "now_playing": {
    "video_id": "...",
    "hue_colors": [[255, 100, 50], [200, 80, 40]] | null
  }
}
```

Colors updated at SSE poll rate (~2s). Null when not streaming.
```

- [ ] **Step 2: Add section to `CLAUDE.md` architecture notes**

```markdown
## Hue Light Synchronization

**Server-side autonomous rendering.** The backend runs a 16 Hz loop that queries
the Sonos speaker for position, loads analysis from cache, generates RGB colors
from audio features, and sends them to the Hue bridge via DTLS. The browser is
only a control panel: start/stop, adjust settings, and passively display colors
via SSE.

Key files:
- `hue_render.py` - Palette logic ported from TypeScript: clock sync, HSV
  conversion, renderer, easing
- `hue.py` - `HueSession` extensions for render loop lifecycle
- `app.py` - `/api/hue/stream` (start with settings), `/api/hue/settings` (live
  updates), SSE colors in `/api/events`

The render loop queries `speaker.get_current_track_info()` every 60ms, syncs a
clock with drift correction, loads analysis for new tracks, and generates colors
via the same palette algorithm the frontend used to run. Settings updates
(brightness/transition/spread) take effect on the next tick.

Lights continue running after the browser closes. The frontend consumes
`hue_colors` from SSE for preview display and `analysis_status` from health for
status text.
```

- [ ] **Step 3: Commit documentation updates**

```bash
git add API.md CLAUDE.md
git commit -m "docs: update API and architecture for server-side Hue render

Document new stream/settings endpoints, SSE color payload, and
autonomous render loop architecture.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Final Review Checklist

Before marking implementation complete, verify:

- [ ] All Python tests pass (`.venv/bin/python -m unittest discover -v`)
- [ ] All frontend tests pass (`cd web && pnpm test`)
- [ ] Typecheck passes (`cd web && pnpm typecheck`)
- [ ] Lint passes (`cd web && pnpm lint`)
- [ ] Build succeeds (`cd web && pnpm build`)
- [ ] Manual E2E test passes (start lights, close browser, lights keep running)
- [ ] No thread leaks (start/stop multiple times, thread count stable)
- [ ] Settings updates respond within 100ms
- [ ] Documentation updated (API.md, CLAUDE.md)
- [ ] All commits follow conventional commit format
- [ ] Spec coverage: every requirement in spec has corresponding implementation

**If all checkboxes pass, implementation is complete and ready for review.**
