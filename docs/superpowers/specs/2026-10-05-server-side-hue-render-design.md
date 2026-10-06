# Server-Side Hue Light Rendering

**Date:** 2026-10-05
**Status:** Approved
**Author:** Claude

## Problem Statement

Currently, Hue light synchronization requires the browser to remain open. The frontend runs a 16 Hz render loop that:
- Fetches analysis data from the backend
- Syncs a clock with Sonos position
- Generates RGB colors from audio features (beats, energy, brightness)
- Sends computed colors to the backend via `POST /api/hue/stream`

This architecture forces users to keep their browser tab open and active. If they close the tab, switch apps, or the tab gets throttled, the lights freeze on the last color sent.

## Goal

Move the entire render loop server-side so lights run autonomously once started. Users should be able to:
1. Start the lights
2. Close the browser entirely
3. Have lights continue following the music until explicitly stopped

Real-time control remains: settings sliders (brightness, transition, spread) should update the running stream immediately without requiring a restart.

## Non-Goals

- Changing the palette/color generation algorithm (port existing logic as-is)
- Multi-user control (single session model remains)
- Persisting light state across server restarts (ephemeral by design)

## Success Criteria

1. Lights run autonomously after browser closes
2. Settings changes (brightness/transition/spread) take effect within 100ms
3. No client-side color computation code remains
4. Preview swatch still shows current colors (via SSE at 1 Hz)
5. Status indicators ("Analyzing...", "Following the beat") work from SSE data
6. All existing hue.test.ts assertions pass when ported to Python

## Architecture Overview

### Current State

```
┌──────────────────┐         ┌──────────────────┐
│ Frontend         │         │ Backend          │
│                  │         │                  │
│ - useHueRender   │────────▶│ HueSession       │
│   • 16 Hz loop   │  POST   │   • DTLS stream  │
│   • generate RGB │  color  │   • 25 Hz writer │
│   • send colors  │         │                  │
└──────────────────┘         └──────────────────┘
     ▲ Must stay open
```

### New State

```
┌──────────────────┐         ┌────────────────────────────────┐
│ Frontend         │         │ Backend                        │
│                  │         │                                │
│ - Control panel  │◀────SSE─│ RenderLoop (16 Hz)             │
│ - Display colors │  1 Hz   │   • query speaker position     │
│ - Send settings  │─POST───▶│   • load analysis from cache   │
│                  │settings │   • sync clock                 │
└──────────────────┘         │   • generate RGB colors        │
                             │   • ease channels              │
     Can close browser       │   • HueSession.set_color()     │
                             │   • publish to SSE             │
                             └────────────────────────────────┘
```

## Component Design

### 1. New Module: `hue_render.py`

Ports all color generation logic from `web/src/lib/hue.ts` to Python. This is a pure translation, not a redesign.

#### Core Functions

**Clock synchronization:**
- `Clock` dataclass: `position`, `at_ms`, `running`
- `parse_sonos_time(time_str) -> float | None`
- `position_at(clock: Clock, now_ms: float) -> float`
- `sync_clock(previous: Clock | None, reported_seconds: float, now_ms: float, playing: bool) -> Clock`

**Palette generation:**
- `hsv_to_rgb(h: float, s: float, v: float) -> Rgb`
- `create_renderer(analysis: dict) -> Renderer`
- `Renderer.frame_at(t: float, options: PaletteOptions) -> Frame`
- `spread_across(frame: Frame, ordered: list[int], spread_deg: float) -> dict[str, Rgb]`
- `ease_channels(prev: dict, target: dict, dt_seconds: float, tau_seconds: float) -> dict[str, Rgb]`

**Constants** (ported exactly):
- `HUE_MIN_DEG = 0`, `HUE_MAX_DEG = 280`
- `MIN_VALUE = 0.15`, `BASE_SATURATION = 0.9`
- `BEAT_DECAY_FRACTION = 0.35`, `BEAT_LIFT = 0.6`, `BEAT_WASH = 0.5`
- `IDLE_COLOR = (60, 45, 30)`
- `COLOR_EPSILON = 3`
- Settings ranges: `BRIGHTNESS_FLOOR = 0.15`, `DECAY_MIN = 0.15`, `DECAY_MAX = 0.95`, `TAU_MIN_SECONDS = 0.05`, `TAU_MAX_SECONDS = 2`

#### RenderLoop Class

```python
class RenderLoop:
    """Autonomous 16 Hz loop that drives lights from speaker position."""

    def __init__(self, session, speaker, cache_dir, settings):
        self.session = session         # HueSession (for set_color, channels)
        self.speaker = speaker         # soco.SoCo instance
        self.cache_dir = cache_dir
        self.settings = settings       # {brightness, transition, spread}
        self._stop = threading.Event()
        self._thread = None
        self.clock = None              # Clock | None
        self.renderer = None           # Renderer | None
        self.current_track = None      # video_id currently loaded
        self.eased = None              # dict[str, Rgb] (float values)
        self.last_tick_ms = None

    def start(self):
        """Spawn the render thread."""
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name='hue-render', daemon=True)
        self._thread.start()

    def stop(self):
        """Signal stop and wait for thread to exit."""
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
            self._thread = None

    def update_settings(self, settings):
        """Update brightness/transition/spread live. Thread-safe."""
        # Settings are read once per tick, no lock needed if we store atomically
        self.settings = settings

    def _run(self):
        """Main loop: tick every 60ms."""
        while not self._stop.is_set():
            try:
                self._tick()
            except Exception as e:
                logger.error(f"Hue render loop error: {e}")
            self._stop.wait(0.060)  # 16.67 Hz ≈ 60ms

    def _tick(self):
        """One render cycle."""
        now_ms = time.monotonic() * 1000

        # Query speaker for current track and position
        try:
            track_info = self.speaker.get_current_track_info()
            video_id = _video_id_from_uri(track_info.get('uri', ''))
            position_str = track_info.get('position', '')
            playing = self.speaker.get_current_transport_info().get('current_transport_state') == 'PLAYING'
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
            frame = self.renderer.frame_at(t, {
                'brightness': resolved['brightness'],
                'beatDecay': resolved['beatDecay'],
                'spreadDeg': resolved['spreadDeg'],
            })
            ordered = order_channels(self.session.channels, self.session.positions or {})
            if ordered:
                target = spread_across(frame, ordered, resolved['spreadDeg'])
            else:
                # Whole-room mode
                target = {'*': hsv_to_rgb(frame.hue, frame.saturation, frame.value)}
        else:
            # Idle: no analysis or no track
            target = {'*': IDLE_COLOR}

        # Ease toward target
        dt = (now_ms - self.last_tick_ms) / 1000 if self.last_tick_ms else float('inf')
        self.last_tick_ms = now_ms
        self.eased = ease_channels(self.eased, target, dt, resolve_settings(self.settings)['tauSeconds'])

        # Round and send
        next_colors = {k: round_rgb(v) for k, v in self.eased.items()}
        if any_differs_enough(next_colors, self.session.last_sent):
            payload = next_colors['*'] if '*' in next_colors else next_colors
            self.session.set_color(payload)
            self.session.last_sent = next_colors

        # Publish for SSE preview (ordered list)
        if '*' in next_colors:
            ordered_colors = [next_colors['*']]
        else:
            ordered = order_channels(self.session.channels, self.session.positions or {})
            ordered_colors = [next_colors[str(ch)] for ch in ordered]
        self.session.set_current_colors(ordered_colors)
```

**Why 16 Hz / 60ms:**
- Matches frontend's `SEND_INTERVAL_MS = 60`
- Fast enough for beat flashes to feel tight (beats arrive within 60ms)
- Slow enough to not burden the backend
- Analysis features are 10 Hz, so this doesn't undersample

### 2. Modified `HueSession` in `hue.py`

Add fields and methods to support the render loop:

```python
class HueSession:
    def __init__(self, client, area_id, channels, positions=None):
        # ...existing fields...
        self.positions = positions     # {str(channel_id): {'x': float, 'y': float, 'z': float}}
        self.render_loop = None        # RenderLoop | None
        self.settings = None           # {brightness, transition, spread} | None
        self.last_sent = None          # dict[str, Rgb] for diff tracking
        self._current_colors = None    # List[Rgb] | None
        self._colors_lock = threading.Lock()

    def start_render_loop(self, speaker, cache_dir, settings):
        """Spawn the autonomous render loop."""
        if self.render_loop is not None:
            self.render_loop.stop()
        self.settings = settings
        self.render_loop = RenderLoop(self, speaker, cache_dir, settings)
        self.render_loop.start()

    def stop_render_loop(self):
        """Stop the render loop gracefully."""
        if self.render_loop is not None:
            self.render_loop.stop()
            self.render_loop = None

    def update_settings(self, settings):
        """Update brightness/transition/spread on a running stream."""
        self.settings = settings
        if self.render_loop:
            self.render_loop.update_settings(settings)

    def get_current_colors(self):
        """Thread-safe read for SSE endpoint. Returns list of RGB tuples."""
        with self._colors_lock:
            return self._current_colors

    def set_current_colors(self, colors):
        """Called by render loop to publish colors for SSE."""
        with self._colors_lock:
            self._current_colors = colors

    def stop(self):
        """Extended to stop render loop before DTLS teardown."""
        self.stop_render_loop()
        # ...existing stop logic (deactivate area, restore lights)...
```

**Lock discipline:**
- `_colors_lock` is a leaf lock (taken alone, never while holding another)
- `last_sent` is only written by render loop thread, so no lock needed
- `settings` updates are atomic dict replacement (thread-safe in Python)

### 3. API Changes

#### Modified `POST /api/hue/stream`

**Start action:**
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

Implementation:
```python
# After DTLS handshake succeeds:
speaker = _get_speaker(data.get('speaker_ip'))  # Helper to find/validate speaker
settings = data.get('settings', DEFAULT_SETTINGS)
session.start_render_loop(speaker, CACHE_DIR, settings)
```

**Stop action:** (unchanged, but now calls `stop_render_loop()` first)

**Color action:** Remove entirely — frontend no longer sends colors

#### New `POST /api/hue/settings`

```python
@app.route('/api/hue/settings', methods=['POST'])
def hue_settings():
    """Update brightness/transition/spread on a running stream."""
    data = request.get_json() or {}
    brightness = data.get('brightness')
    transition = data.get('transition')
    spread = data.get('spread')

    # Validate ranges (0-100)
    if not all(isinstance(v, (int, float)) and 0 <= v <= 100
               for v in [brightness, transition, spread] if v is not None):
        return jsonify({"error": "Settings must be 0-100"}), 400

    with _HUE_LOCK:
        if _HUE_SESSION is None or not _HUE_SESSION.is_active():
            return jsonify({"error": "Not streaming"}), 409

        settings = {
            'brightness': brightness if brightness is not None else _HUE_SESSION.settings['brightness'],
            'transition': transition if transition is not None else _HUE_SESSION.settings['transition'],
            'spread': spread if spread is not None else _HUE_SESSION.settings['spread'],
        }
        _HUE_SESSION.update_settings(settings)
        return jsonify({"settings": settings})
```

#### Modified `GET /api/hue/health`

Add `analysis_status` field:

```python
def _hue_health_payload():
    # ...existing fields...

    # Determine analysis status for current track
    analysis_status = 'idle'
    if paired and _HUE_SESSION and _HUE_SESSION.render_loop:
        video_id = _HUE_SESSION.render_loop.current_track
        if video_id:
            if _HUE_SESSION.render_loop.renderer:
                analysis_status = 'ready'
            else:
                # Check if analysis exists on disk or is queued
                if analysis.load(CACHE_DIR, video_id):
                    analysis_status = 'ready'
                elif analysis.pending() > 0:
                    analysis_status = 'analysing'
                else:
                    analysis_status = 'unavailable'

    return {
        # ...existing fields...
        'analysis_status': analysis_status,
    }
```

#### Modified `GET /api/events` (SSE)

Add `hue_colors` to the payload:

```python
def _now_playing_payload(speaker):
    # ...existing logic...
    return {
        'state': state,
        'position': position,
        # ...other fields...
        'hue_colors': _hue_colors_payload(),  # NEW
    }

def _hue_colors_payload():
    """Current colors being sent to bridge, for preview swatch."""
    if _HUE_SESSION is None or not _HUE_SESSION.is_active():
        return None
    colors = _HUE_SESSION.get_current_colors()
    return colors if colors else None
```

**SSE update rate:** Existing SSE poll rate (~2s) is fine. Frontend will receive colors at that cadence, which is smooth enough for a passive preview.

### 4. Frontend Changes

#### Remove Files
- `web/src/lib/hooks/use-hue-render.ts` (entire file deleted)
- `web/src/lib/hooks/use-hue-render.test.ts` (entire file deleted)

#### Modify `web/src/lib/api/types.ts`

Add to `NowPlaying` interface:
```typescript
export interface NowPlaying {
  // ...existing fields...
  hue_colors: Rgb[] | null;  // From backend render loop
}
```

Add to `HueHealth` interface:
```typescript
export interface HueHealth {
  // ...existing fields...
  analysis_status: 'idle' | 'analysing' | 'ready' | 'unavailable';
}
```

#### Modify `web/src/lib/hooks/use-hue.ts`

**Start stream with settings:**
```typescript
const start = useCallback(async () => {
  if (!area) return;
  setBusy(true);
  setStreamError(null);
  try {
    // Get speaker IP from nowPlaying or devices list
    const speakerIp = /* derive from context */;

    await api.hueStream('start', {
      area: area.id,
      speaker_ip: speakerIp,
      settings: {
        brightness: settings.brightness,
        transition: settings.transition,
        spread: settings.spread,
      },
    });
    await refresh();
  } catch (error) {
    setStreamError(error);
  } finally {
    setBusy(false);
  }
}, [area, settings, refresh]);
```

**No color sending:** Remove any `api.hueColor()` calls.

#### Modify `web/src/lib/hooks/use-hue-settings.ts`

Add live update when streaming:

```typescript
const updateSetting = useCallback(async (key: string, value: number) => {
  setSettings(prev => ({ ...prev, [key]: value }));

  // If streaming, send update to backend immediately
  if (isStreaming) {
    try {
      await api.hueSettings({ [key]: value });
    } catch (error) {
      console.error('Failed to update Hue settings:', error);
    }
  }
}, [isStreaming]);

return {
  settings,
  resolved,
  setBrightness: (v) => updateSetting('brightness', v),
  setTransition: (v) => updateSetting('transition', v),
  setSpread: (v) => updateSetting('spread', v),
};
```

**Note:** `isStreaming` needs to be passed in or derived from context.

#### Modify `web/src/components/lights-panel.tsx`

**Remove:**
- `useHueRender()` call
- `ANALYSIS_NOTE` constant (moved to derive from `analysis_status`)

**Update `LightsPanel`:**
```typescript
export function LightsPanel({ nowPlaying }: LightsPanelProps) {
  const hue = useHue();
  const dials = useHueSettings(hue.streaming);  // Pass streaming state

  const analysisStatus = hue.health?.analysis_status ?? 'idle';
  const hueColors = nowPlaying?.hue_colors ?? null;

  // ...rest unchanged...

  <StreamControls
    hue={hue}
    status={analysisStatus}
    colors={hueColors}  // From SSE, not computed
  />
}
```

**Update `StreamControls`:**
```typescript
const ANALYSIS_NOTE: Record<AnalysisStatus, string> = {
  idle: "Esperando una pista",
  analysing: "Analizando la pista…",
  ready: "Siguiendo el ritmo",
  unavailable: "Sin análisis para esta pista — manteniendo un brillo cálido",
};

function StreamControls({ hue, status, colors }) {
  // ...existing logic, colors now from props (SSE) not computed locally...
}
```

**SwatchStrip stays unchanged** — it's already passive display.

#### Modify `web/src/lib/api/client.ts`

**Add:**
```typescript
export async function hueSettings(
  settings: { brightness?: number; transition?: number; spread?: number },
  signal?: AbortSignal,
) {
  return fetchJson<{ settings: HueSettings }>('/api/hue/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
    signal,
  });
}
```

**Remove:**
```typescript
// DELETE this function entirely
export async function hueColor(...) { ... }
```

**Update:**
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
  return fetchJson<HueStreamResponse>('/api/hue/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...options }),
    signal,
  });
}
```

### 5. Settings Resolution

Port `resolveSettings()` from TypeScript:

```python
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

DEFAULT_SETTINGS = {'brightness': 100, 'transition': 25, 'spread': 15}
```

## Data Flow Examples

### Example 1: Starting the Lights

1. User clicks "Start" in UI (browser on phone)
2. Frontend: `POST /api/hue/stream` with `{action: 'start', area: 'living-room', speaker_ip: '192.168.1.50', settings: {brightness: 100, transition: 25, spread: 15}}`
3. Backend: Starts DTLS stream, creates `HueSession`
4. Backend: Spawns `RenderLoop` thread
5. Loop queries speaker every 60ms, generates colors, sends to lights
6. Loop publishes colors to `_current_colors` for SSE
7. SSE emits `{hue_colors: [[255, 100, 50], ...]}` at ~1 Hz
8. Frontend displays colors in swatch
9. **User closes browser** — loop keeps running server-side
10. **User reopens browser 10 minutes later** — SSE reconnects, swatch shows current colors

### Example 2: Adjusting Brightness Mid-Song

1. Lights are running, user drags brightness slider to 75
2. Frontend: `POST /api/hue/settings {brightness: 75}`
3. Backend: `_HUE_SESSION.update_settings({'brightness': 75, ...})`
4. Render loop: Next tick (within 60ms) reads new settings
5. Render loop: Computes frame with `brightness = 0.15 + 0.85 * 0.75 = 0.7875`
6. Lights dim within one render cycle
7. User sees change in real room and in swatch preview

### Example 3: Track Changes

1. Song A is playing, lights following beat
2. User skips to Song B (via Sonos app or frontend)
3. Render loop: `_tick()` queries speaker, sees new `video_id`
4. Loop: Sets `current_track = video_id_B`, clears `renderer` and `clock`
5. Loop: Calls `analysis.load(cache_dir, video_id_B)`
6. If analysis exists: `renderer = create_renderer(data)`, lights follow new song
7. If analysis pending: `renderer = None`, lights show `IDLE_COLOR` warm white
8. If analysis unavailable: Same as pending, warm white until analysis completes
9. SSE: `analysis_status` updates to "analysing" or "unavailable"
10. Frontend: Shows "Analizando la pista…" or "Sin análisis..."

## Testing Strategy

### Unit Tests (Python)

Port tests from `web/src/lib/hue.test.ts`:

1. **Clock sync:**
   - `test_parse_sonos_time()`: Valid/invalid formats
   - `test_sync_clock()`: Drift threshold, pause/play transitions
   - `test_position_at()`: Running vs paused clocks

2. **Palette:**
   - `test_hsv_to_rgb()`: Edge cases (0°, 360°, out-of-range)
   - `test_create_renderer()`: Brightness normalization, tempo fallback
   - `test_frame_at()`: Beat flashes, energy mapping, arc reduction
   - `test_spread_across()`: Gradient distribution, single-lamp case

3. **Easing:**
   - `test_ease_channels()`: Time constant, channel set changes
   - `test_differs_enough()`: Epsilon threshold

4. **Settings:**
   - `test_resolve_settings()`: Range clamping, geometric/linear scales

### Integration Tests

1. **Render loop lifecycle:**
   - Start loop, verify thread spawns
   - Stop loop, verify graceful shutdown (no orphaned threads)
   - Restart on same area is idempotent

2. **Settings updates:**
   - Update brightness mid-stream, verify next tick uses new value
   - Send invalid settings, verify rejection

3. **Track changes:**
   - Mock speaker returning different `video_id`
   - Verify renderer reloads, clock resets

4. **SSE color publishing:**
   - Verify `get_current_colors()` returns what loop computed
   - Verify thread-safety (no race between render loop and SSE read)

### Manual Testing Checklist

- [ ] Start lights, close browser, lights keep running
- [ ] Reopen browser, swatch shows current colors
- [ ] Adjust brightness slider, lights respond within 100ms
- [ ] Skip tracks, lights follow new song's beat
- [ ] Pause Sonos, lights hold current color (not idle)
- [ ] Stop lights, room restores to pre-stream state
- [ ] Switch entertainment areas, old stream stops cleanly
- [ ] Analysis not ready: lights show warm white, status shows "Analizando..."
- [ ] Tab hidden/throttled: lights continue smoothly (not affected by browser)

## Rollout Plan

### Phase 1: Backend Implementation
1. Create `hue_render.py` with all ported functions
2. Extend `HueSession` with render loop support
3. Add `POST /api/hue/settings` endpoint
4. Modify `/api/hue/stream` to start/stop render loop
5. Add `hue_colors` to SSE payload
6. Add `analysis_status` to `/api/hue/health`
7. Write Python unit tests

### Phase 2: Frontend Migration
1. Remove `use-hue-render.ts` and tests
2. Update API types (`NowPlaying`, `HueHealth`)
3. Modify `lights-panel.tsx` to consume SSE colors
4. Add live settings updates in `use-hue-settings.ts`
5. Update `api.hueStream()` signature
6. Remove `api.hueColor()` function
7. Test in browser

### Phase 3: Validation
1. Run Python unit tests
2. Manual testing checklist
3. Load test: leave lights running for 1+ hour
4. Verify no memory leaks (thread cleanup)

### Phase 4: Cleanup
1. Archive/delete `web/src/lib/hue.ts` (ported to Python)
2. Update API.md documentation
3. Update CLAUDE.md with new architecture

## Open Questions

None — design approved by user.

## Appendices

### A. Files Changed

**New:**
- `hue_render.py` (~500 lines)
- `docs/superpowers/specs/2026-10-05-server-side-hue-render-design.md`

**Modified:**
- `hue.py` (HueSession extensions)
- `app.py` (endpoints: `/api/hue/stream`, `/api/hue/settings`, `/api/hue/health`, `/api/events`)
- `web/src/lib/api/types.ts` (NowPlaying, HueHealth interfaces)
- `web/src/lib/api/client.ts` (hueStream, hueSettings functions)
- `web/src/lib/hooks/use-hue.ts` (start with settings)
- `web/src/lib/hooks/use-hue-settings.ts` (live updates)
- `web/src/components/lights-panel.tsx` (consume SSE colors)

**Deleted:**
- `web/src/lib/hooks/use-hue-render.ts`
- `web/src/lib/hooks/use-hue-render.test.ts`

**Archived** (can delete after validation):
- `web/src/lib/hue.ts` (logic ported to `hue_render.py`)
- `web/src/lib/hue.test.ts`

### B. Compatibility Notes

**Breaking changes:**
- Clients must send `speaker_ip` when starting stream (new required field)
- `POST /api/hue/stream` with `action: "color"` is removed (400 if sent)
- Frontend builds from before this change will fail to start lights (missing speaker_ip)

**Graceful degradation:**
- Old frontend with new backend: Start fails with 400 "missing speaker_ip"
- New frontend with old backend: Start succeeds but lights don't run (no loop)

**Migration:** Deploy backend and frontend together (atomic release).

### C. Performance Characteristics

**Backend:**
- One thread per active stream (16 Hz tick rate)
- Memory: ~50 KB per renderer (beat/energy/brightness arrays)
- CPU: Negligible (palette math is cheap, speaker query is cached by soco)

**Network:**
- SSE bandwidth: ~200 bytes/s (colors array at 1 Hz)
- Settings updates: ~100 bytes per slider change (user-driven, infrequent)
- Speaker queries: Existing soco polling (no new load)

**Scalability:**
- Single-session model unchanged (one bridge, one stream)
- Multi-room: Separate `HueSession` per area (future enhancement)
