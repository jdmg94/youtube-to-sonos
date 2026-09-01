/**
 * The Hue palette: audio features to a colour, and the clock that decides
 * *which* moment of the track to colour.
 *
 * Pure, and deliberately so. The backend ships `beats`/`energy`/`brightness`
 * and nothing else (see `API.md`, "Features, not colours") precisely so this
 * file can change without re-analysing every cached track — minutes of CPU to
 * adjust one constant. That trade only pays if the mapping is testable, which
 * means no React, no fetch and no clock reading in here: every function below
 * takes the time it should render as an argument.
 *
 * The two halves are independent and fail differently. The palette is a total
 * function of (features, t) and cannot go wrong at runtime. The clock is an
 * estimate — Sonos reports its position to the nearest second, roughly every
 * two seconds — and everything hard about this feature lives there.
 */
import type { ChannelPosition, HueAnalysis, Rgb, SonosTime } from "@/lib/api/types";

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

/**
 * Sonos reports `H:MM:SS` — one-second resolution, truncated. A reported `12`
 * means the true position is somewhere in `[12, 13)`, so anchoring on the bare
 * number is systematically *late* by half a second on average. Adding half a
 * second makes it an unbiased estimate and halves the worst case from a full
 * second to half of one.
 *
 * Half a second is four beats' worth of error at 120 BPM if left uncorrected,
 * which is the difference between lights on the beat and lights on the offbeat.
 */
export const REPORTED_POSITION_BIAS_SECONDS = 0.5;

/**
 * How far the free-running clock may drift from the speaker's own before it is
 * re-anchored.
 *
 * Re-anchoring on every frame is the obvious implementation and the wrong one:
 * the reported position is quantised to a second and arrives on a jittery
 * two-second poll, so it would drag the render time backwards and forwards
 * several times a second — and a step backwards past a beat fires that beat's
 * flash a second time. Free-running between corrections keeps beat spacing
 * smooth; the threshold bounds how wrong that is allowed to get.
 */
export const RESYNC_THRESHOLD_SECONDS = 0.75;

/**
 * A local estimate of where the speaker is in the track.
 *
 * `atMs` is a `performance.now()`-style monotonic reading, not a wall clock: an
 * NTP correction mid-song would otherwise jump the lights.
 */
export interface Clock {
  /** Track position in seconds, true as of `atMs`. */
  position: number;
  atMs: number;
  /** Whether `position` advances with elapsed time. False while paused. */
  running: boolean;
}

/**
 * `H:MM:SS` to seconds. `null` for anything else — Sonos answers
 * `"NOT_IMPLEMENTED"` for a source that cannot report a position, and an idle
 * speaker answers `""`.
 */
export function parseSonosTime(time: SonosTime | null | undefined): number | null {
  if (typeof time !== "string") return null;
  const match = /^(\d+):([0-5]\d):([0-5]\d)$/.exec(time);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/** Where the clock says we are, now. */
export function positionAt(clock: Clock, nowMs: number): number {
  if (!clock.running) return clock.position;
  return clock.position + (nowMs - clock.atMs) / 1000;
}

/**
 * Fold a freshly reported position into the clock.
 *
 * Keeps the existing anchor while it still predicts the speaker to within
 * `RESYNC_THRESHOLD_SECONDS`, so an unchanged song produces a smooth,
 * monotonic render time out of a coarse and jittery input. A paused speaker
 * always re-anchors: there is nothing to predict, and a clock left running
 * would creep forward until the next frame yanked it back.
 */
export function syncClock(
  previous: Clock | null,
  reportedSeconds: number,
  nowMs: number,
  playing: boolean,
): Clock {
  const reported = reportedSeconds + REPORTED_POSITION_BIAS_SECONDS;
  const anchor: Clock = { position: reported, atMs: nowMs, running: playing };
  if (!playing || previous === null || !previous.running) return anchor;

  const drift = Math.abs(positionAt(previous, nowMs) - reported);
  return drift <= RESYNC_THRESHOLD_SECONDS ? previous : anchor;
}

// ---------------------------------------------------------------------------
// The palette
// ---------------------------------------------------------------------------

/**
 * The hue arc, in degrees: bass-heavy timbres at the red end, bright ones at
 * the violet end. Warm-for-low is the ordinary synaesthetic reading and the one
 * every VU meter and spectrum analyser already uses.
 *
 * An *arc*, not the full wheel, because the wheel wraps: mapping 0..1 onto
 * 0..360 puts the brightest timbre back on the same red as the darkest, so the
 * two extremes of a track would light the room identically.
 */
export const HUE_MIN_DEG = 0;
export const HUE_MAX_DEG = 280;

/**
 * How dim a silent passage goes. Not zero: lights that go out during a quiet
 * intro read as a crash, not as atmosphere, and the listener's next move is to
 * go and check the app rather than enjoy the song.
 */
export const MIN_VALUE = 0.15;

/** Held back from full so the lamp's white LEDs contribute and the room stays lit. */
export const BASE_SATURATION = 0.9;

/**
 * Beat flash decay, as a fraction of the *local* beat period.
 *
 * A fixed decay cannot work across tempos: 300ms is a distinct pulse at 90 BPM
 * and a permanently-on light at 174. Scaling to the measured gap between the
 * last two beats makes the flash occupy the same share of every bar, and it
 * follows a tempo change within the track for free. At 0.35 the pulse is down
 * to 6% of its peak by the time the next beat lands, so flashes never stack.
 */
export const BEAT_DECAY_FRACTION = 0.35;

/** Share of the *remaining* headroom to 1.0 that a beat adds to value. */
export const BEAT_LIFT = 0.6;

/**
 * Share of saturation a beat washes out.
 *
 * The flash has to work at every volume, and lifting value alone does not: in a
 * loud passage value is already near 1, so there is nothing left to lift and
 * the beat disappears exactly where the music is most beat-driven. Pulling
 * saturation toward white always has room to move.
 */
export const BEAT_WASH = 0.5;

/**
 * How far the whole room can be spread along the hue arc, in degrees.
 *
 * The arc's full width, so the extreme of the slider is the honest one: the
 * room shows the entire palette at once. It is also the setting at which the
 * arc reduction below leaves the music no room to move, which is a real cost
 * the user can see rather than a limit invented to hide one.
 */
export const SPREAD_MAX_DEG = HUE_MAX_DEG - HUE_MIN_DEG;

/**
 * The dimmest the brightness slider goes, as a fraction of full.
 *
 * Not zero, for the same reason `MIN_VALUE` is not zero — and it has to hold
 * against the *quietest* passage, not the average one, since `MIN_VALUE * this`
 * is what a silent intro renders at. At 0.15 that is still a couple of 8-bit
 * steps above black, so the lamp is visibly on. Anyone who wants the lights off
 * has a Stop button that says so.
 */
export const BRIGHTNESS_FLOOR = 0.15;

/**
 * The ends of the beat-decay range the transition slider sweeps.
 *
 * `DECAY_MIN` is a strobe-ish tick that is gone well before the next beat;
 * `DECAY_MAX` still has a third of the flash left when the next one lands, so
 * the room glows rather than blinks. `BEAT_DECAY_FRACTION` sits exactly at the
 * default slider position, so the shipped look is the one the tests above have
 * always described.
 */
export const DECAY_MIN = 0.15;
export const DECAY_MAX = 0.95;

/**
 * The ends of the colour-slew time constant, in seconds.
 *
 * `TAU_MIN_SECONDS` is short enough that a whole second of `dt` — what a
 * throttled background tab hands the loop — arrives as a snap rather than a
 * fade, which is what "no smoothing" has to mean when the loop cannot promise
 * to run. `TAU_MAX_SECONDS` is a slow wash that ignores beats entirely.
 */
export const TAU_MIN_SECONDS = 0.05;
export const TAU_MAX_SECONDS = 2;

/** Guards the decay against a degenerate sidecar with two beats at one instant. */
const MIN_BEAT_PERIOD_SECONDS = 0.05;

/** Tails trimmed from each end before stretching a track's timbre to the arc. */
const BRIGHTNESS_TRIM = 0.05;

/**
 * The narrowest timbre span still worth stretching.
 *
 * Below this the track is essentially one colour — a spoken word recording, a
 * drone — and stretching its noise floor across 280° of hue would swing the
 * room through the rainbow on changes nobody can hear. Such a track falls back
 * to the absolute map, where its colour simply reports that it is dark.
 */
const MIN_BRIGHTNESS_SPAN = 0.08;

const clamp01 = (value: number) => (value > 1 ? 1 : value < 0 ? 0 : value);

/**
 * Linear interpolation into a `frame_seconds`-spaced series, clamped at both
 * ends.
 *
 * Interpolated rather than indexed because the series is sampled at 10 Hz and
 * read by a loop running several times faster: taking the containing frame
 * whole makes every envelope move in visible 100ms steps, which on a dimming
 * lamp reads as a stutter. Out-of-range times clamp rather than wrap or throw —
 * the clock can legitimately run a little past the analysed duration.
 */
export function sample(values: number[], frameSeconds: number, t: number): number {
  if (values.length === 0) return 0;
  if (!Number.isFinite(t) || t <= 0 || !(frameSeconds > 0)) return values[0];

  const x = t / frameSeconds;
  const last = values.length - 1;
  if (x >= last) return values[last];

  const i = Math.floor(x);
  return values[i] + (values[i + 1] - values[i]) * (x - i);
}

/**
 * Index of the last beat at or before `t`, or `-1` before the first one.
 *
 * Binary search rather than a remembered cursor: the caller's `t` is not
 * guaranteed monotonic (the clock re-anchors, and a seek moves it anywhere),
 * and a cursor that assumed otherwise would silently stop finding beats.
 */
export function lastBeatIndex(beats: number[], t: number): number {
  let lo = 0;
  let hi = beats.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** HSV to 8-bit RGB. `h` in degrees, `s`/`v` in 0..1. */
export function hsvToRgb(h: number, s: number, v: number): Rgb {
  const hue = ((h % 360) + 360) % 360;
  const chroma = clamp01(v) * clamp01(s);
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = clamp01(v) - chroma;

  let rgb: [number, number, number];
  if (hue < 60) rgb = [chroma, x, 0];
  else if (hue < 120) rgb = [x, chroma, 0];
  else if (hue < 180) rgb = [0, chroma, x];
  else if (hue < 240) rgb = [0, x, chroma];
  else if (hue < 300) rgb = [x, 0, chroma];
  else rgb = [chroma, 0, x];

  return rgb.map((c) => Math.round((c + m) * 255)) as Rgb;
}

/**
 * The room's colour for one instant, before it is split across the lights.
 *
 * HSV rather than RGB because the spread is a rotation of `hue`, and recovering
 * a hue from three 8-bit numbers to rotate it would lose the precision the
 * rotation needs — 280° across a handful of lamps is a few degrees each.
 */
export interface Frame {
  /** Degrees, already inside the arc with room for `spreadDeg` on both sides. */
  hue: number;
  saturation: number;
  value: number;
}

/**
 * The user's dials, in the units the palette works in.
 *
 * Every field is optional and defaults to the constant the palette shipped
 * with, so an unparameterised call renders exactly what it rendered before
 * these existed. `resolveSettings` turns slider positions into these.
 */
export interface PaletteOptions {
  /** Multiplies the final value. `BRIGHTNESS_FLOOR`..1. */
  brightness?: number;
  /** Beat flash decay as a fraction of the beat period. See `BEAT_DECAY_FRACTION`. */
  beatDecay?: number;
  /**
   * Total hue spread across the room, in degrees. The palette needs it even
   * though it does not apply it: the base hue has to be computed into an arc
   * narrowed by half a spread at each end, or the outermost lights would be
   * rotated off the arc and wrap into the reds `HUE_MAX_DEG` exists to avoid.
   */
  spreadDeg?: number;
}

/**
 * A track's palette, with the per-track normalisation already done.
 *
 * Built once per song rather than per frame: it sorts the whole brightness
 * series, which at 10 Hz over four minutes is 2,400 values — trivial once, and
 * absurd fifteen times a second.
 */
export interface Renderer {
  /** The room's colour at `t` seconds into the track. Total: any `t` is answerable. */
  frameAt(t: number, options?: PaletteOptions): Frame;
  /** `frameAt` through `hsvToRgb`, for callers with one lamp or none. */
  colorAt(t: number, options?: PaletteOptions): Rgb;
  /** Normalised timbre bounds, for the debug readout. */
  readonly brightnessRange: readonly [number, number];
}

/** Order statistic with linear interpolation, on an already-sorted array. */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const i = Math.floor(pos);
  const next = Math.min(i + 1, sorted.length - 1);
  return sorted[i] + (sorted[next] - sorted[i]) * (pos - i);
}

export function createRenderer(analysis: HueAnalysis): Renderer {
  const { beats, energy, brightness, frame_seconds: frameSeconds } = analysis;

  /*
   * Timbre is stretched to the arc *per track*, not mapped absolutely.
   *
   * `brightness` is an absolute log map of the spectral centroid between 100 Hz
   * and Nyquist, and most produced music lives in a narrow band of it. Mapped
   * straight onto the arc, nearly every song comes out somewhere around green
   * and the palette's ends are never reached — the lights would technically be
   * following the music while looking like a fixed colour. Trimmed percentiles
   * rather than min/max so one cymbal crash cannot define the top of the range.
   */
  const sorted = [...brightness].sort((a, b) => a - b);
  let lo = quantile(sorted, BRIGHTNESS_TRIM);
  let hi = quantile(sorted, 1 - BRIGHTNESS_TRIM);
  // Written as `!(… >= …)` so a NaN from an empty or corrupt series takes the
  // fallback rather than propagating into every colour.
  if (!(hi - lo >= MIN_BRIGHTNESS_SPAN)) {
    lo = 0;
    hi = 1;
  }
  const span = hi - lo;

  const fallbackPeriod = analysis.tempo > 0 ? 60 / analysis.tempo : 0.5;

  function pulseAt(t: number, beatDecay: number): number {
    const i = lastBeatIndex(beats, t);
    if (i < 0) return 0;
    const period = i > 0 ? beats[i] - beats[i - 1] : fallbackPeriod;
    const decay = Math.max(period, MIN_BEAT_PERIOD_SECONDS) * beatDecay;
    return Math.exp(-(t - beats[i]) / decay);
  }

  function frameAt(t: number, options: PaletteOptions = {}): Frame {
    const {
      brightness: gain = 1,
      beatDecay = BEAT_DECAY_FRACTION,
      spreadDeg = 0,
    } = options;

    const loudness = clamp01(sample(energy, frameSeconds, t));
    const timbre = clamp01((sample(brightness, frameSeconds, t) - lo) / span);
    const pulse = pulseAt(t, beatDecay);

    /*
     * The arc reduction.
     *
     * `spreadAcross` rotates the outermost lights by ±spreadDeg/2, so the base
     * hue is computed into an arc with that much shaved off each end. Skip it
     * and the top of the range plus half a spread lands past 280° in the
     * magenta-to-red return, where a bright timbre reads as a dark one — the
     * exact wrap `HUE_MAX_DEG` was chosen to avoid.
     *
     * At the widest setting the two ends meet and the base hue is pinned to the
     * middle of the arc: the room shows the whole palette at once and stops
     * following the music. That is the honest reading of the request, not a
     * bug, and the slider's label is where to argue with it.
     */
    const margin = Math.min(Math.max(spreadDeg, 0), SPREAD_MAX_DEG) / 2;
    const low = HUE_MIN_DEG + margin;
    const high = HUE_MAX_DEG - margin;
    const hue = low + (high - low) * timbre;

    const base = MIN_VALUE + (1 - MIN_VALUE) * loudness;

    return {
      hue,
      saturation: BASE_SATURATION * (1 - pulse * BEAT_WASH),
      // Brightness scales the finished value rather than capping it, so a quiet
      // passage and a chorus stay as far apart in relative terms as they were.
      // Capping would squash the range from the top while MIN_VALUE held the
      // floor, and a dim room would stop following the music altogether.
      value: clamp01(base + (1 - base) * pulse * BEAT_LIFT) * gain,
    };
  }

  return {
    brightnessRange: [lo, hi] as const,
    frameAt,
    colorAt(t: number, options?: PaletteOptions): Rgb {
      const frame = frameAt(t, options);
      return hsvToRgb(frame.hue, frame.saturation, frame.value);
    },
  };
}

// ---------------------------------------------------------------------------
// The spread
// ---------------------------------------------------------------------------

/** Below this the room's lights are, for ordering purposes, in the same place. */
const POSITION_EPSILON = 1e-6;

/**
 * The order to lay the gradient out in: one end of the room to the other.
 *
 * Ordered along whichever of x/y the lights are more spread out on, because a
 * gradient run across a room's narrow axis puts its two extremes a metre apart
 * and reads as no gradient at all. `z` is ignored — lamps sit at roughly one
 * height and a vertical gradient across a 10cm spread is noise.
 *
 * Falls back to ascending channel id whenever the positions cannot answer:
 * nobody configured them (the common case — it is a manual step in the Hue app
 * that most people never take), or one lamp is missing one. All-or-nothing on
 * purpose: a partial ranking would drop the unpositioned lamp at an arbitrary
 * point inside an otherwise meaningful gradient, which looks like a bug, where
 * an arbitrary *whole* order just looks like a room.
 */
export function orderChannels(
  channels: number[],
  positions: Record<string, ChannelPosition | null>,
): number[] {
  const byId = [...channels].sort((a, b) => a - b);
  if (byId.length <= 1) return byId;

  const placed = byId.map((id) => positions[String(id)]);
  if (placed.some((p) => !p)) return byId;
  const known = placed as ChannelPosition[];

  const spanOf = (axis: "x" | "y") => {
    const values = known.map((p) => p[axis]);
    return Math.max(...values) - Math.min(...values);
  };
  const spanX = spanOf("x");
  const spanY = spanOf("y");
  if (!(Math.max(spanX, spanY) > POSITION_EPSILON)) return byId;

  const axis = spanX >= spanY ? "x" : "y";
  return byId
    .map((id, i) => ({ id, along: known[i][axis] }))
    // Ties broken by id, which `byId` already gives us and a stable sort keeps.
    .sort((a, b) => a.along - b.along)
    .map((entry) => entry.id);
}

/**
 * One room colour, fanned out along the hue arc across the ordered lights.
 *
 * The rotation is a *gradient of one mood*, not a different colour per lamp:
 * the ends are `spreadDeg` apart and everything between is interpolated, so the
 * room still reads as one scene with depth rather than as a disco. `frameAt`
 * has already narrowed the arc by `spreadDeg`, so no offset here can wrap.
 *
 * Keys are stringified channel ids because that is what goes over JSON and what
 * the backend's `int(k)` reads back.
 */
export function spreadAcross(
  frame: Frame,
  ordered: number[],
  spreadDeg: number,
): Record<string, Rgb> {
  const colors: Record<string, Rgb> = {};
  const last = ordered.length - 1;
  for (let i = 0; i <= last; i += 1) {
    // A lone light sits at the middle of the gradient, so it gets the room
    // colour unshifted without needing a branch for it.
    const rank = last === 0 ? 0.5 : i / last;
    const hue = frame.hue + (rank - 0.5) * spreadDeg;
    colors[String(ordered[i])] = hsvToRgb(hue, frame.saturation, frame.value);
  }
  return colors;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * Smallest 8-bit step worth an HTTP request.
 *
 * The backend's writer thread resends whatever it last held at 25 Hz, so a
 * colour we do not send is not a dropped frame — it is a setpoint that did not
 * need changing. During a sustained quiet passage that turns a fixed send rate
 * into no traffic at all.
 */
export const COLOR_EPSILON = 3;

/**
 * What to hold when there is nothing to render: no track, or a track nothing
 * ever analysed.
 *
 * Something rather than nothing, because the backend resends its last setpoint
 * forever. Sending no colour does not return the lamps to normal — it freezes
 * the room on whatever half-decayed beat flash the previous track ended on,
 * which looks exactly like the app crashed mid-song. A dim warm white is the
 * one colour that reads as "off duty" rather than as a held frame.
 */
export const IDLE_COLOR: Rgb = [60, 45, 30];

/** Whether a new colour is far enough from the last sent one to be worth sending. */
export function differsEnough(a: Rgb, b: Rgb, epsilon = COLOR_EPSILON): boolean {
  return (
    Math.abs(a[0] - b[0]) >= epsilon ||
    Math.abs(a[1] - b[1]) >= epsilon ||
    Math.abs(a[2] - b[2]) >= epsilon
  );
}

/**
 * The same question for a whole room.
 *
 * All-or-nothing, because the datagram is: one frame carries every channel, so
 * a single lamp needing an update means the whole frame is worth sending. A
 * changed channel *set* counts too — a lamp joining or leaving changes what the
 * frame addresses even when every colour in it is within epsilon, and the
 * backend fills anything unlisted with black.
 */
export function anyDiffersEnough(
  next: Record<string, Rgb>,
  last: Record<string, Rgb> | null,
  epsilon = COLOR_EPSILON,
): boolean {
  if (last === null) return true;
  const keys = Object.keys(next);
  if (keys.length !== Object.keys(last).length) return true;
  for (const key of keys) {
    const before = last[key];
    if (before === undefined) return true;
    if (differsEnough(next[key], before, epsilon)) return true;
  }
  return false;
}

/**
 * One step of an exponential approach from `prev` to `target`.
 *
 * Parameterised by a time constant and the elapsed time rather than by a
 * per-tick fraction, which is the whole reason this is not a one-liner. The
 * send loop is a `setInterval` and a hidden tab throttles it to about 1 Hz — and
 * a tab playing music through a speaker in another room is hidden nearly all of
 * the time. A fixed fraction per tick would smooth a backgrounded tab twenty
 * times harder than a visible one, so the lights would turn sluggish exactly
 * when nobody was looking at the thing that explained why.
 *
 * Returns floats. Rounding here would be the bug: under heavy smoothing a tick
 * can move a channel by less than half a unit, which rounds straight back to
 * where it started and freezes the room on a stale setpoint forever. The caller
 * keeps this state and rounds once, at the point of sending, with `roundRgb`.
 */
export function easeToward(
  prev: Rgb,
  target: Rgb,
  dtSeconds: number,
  tauSeconds: number,
): Rgb {
  const alpha =
    tauSeconds > 0 && dtSeconds > 0 ? 1 - Math.exp(-dtSeconds / tauSeconds) : 1;
  return [
    prev[0] + (target[0] - prev[0]) * alpha,
    prev[1] + (target[1] - prev[1]) * alpha,
    prev[2] + (target[2] - prev[2]) * alpha,
  ];
}

/**
 * `easeToward` across the room, keyed by channel.
 *
 * The target's channel set wins: a lamp that has left the area is dropped
 * rather than carried, and one that has just joined eases up from `IDLE_COLOR`
 * — the colour the room rests at — so it fades in with the others instead of
 * snapping to full or rising out of black.
 */
export function easeChannels(
  prev: Record<string, Rgb> | null,
  target: Record<string, Rgb>,
  dtSeconds: number,
  tauSeconds: number,
): Record<string, Rgb> {
  const next: Record<string, Rgb> = {};
  for (const key of Object.keys(target)) {
    next[key] = easeToward(prev?.[key] ?? IDLE_COLOR, target[key], dtSeconds, tauSeconds);
  }
  return next;
}

/** The eased float state, as the 8-bit triple the bridge is actually sent. */
export function roundRgb(rgb: Rgb): Rgb {
  return [Math.round(rgb[0]), Math.round(rgb[1]), Math.round(rgb[2])];
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * The three sliders, as the UI holds them: 0..100, which is what a slider is
 * and what survives `localStorage` without a migration when the ranges below
 * are retuned.
 */
export interface HueSettings {
  brightness: number;
  /** Drives both the colour slew and the beat decay. See `resolveSettings`. */
  transition: number;
  spread: number;
}

/** The same three, in the units `PaletteOptions` and `easeToward` want. */
export interface ResolvedSettings {
  brightness: number;
  beatDecay: number;
  spreadDeg: number;
  tauSeconds: number;
}

/**
 * Where the sliders start.
 *
 * Full brightness and today's decay, so an existing user sees no change they
 * did not ask for; a narrow spread, so the feature announces itself as depth in
 * the room rather than as a light show someone forgot to turn off.
 */
export const DEFAULT_SETTINGS: HueSettings = { brightness: 100, transition: 25, spread: 15 };

const position = (value: number) =>
  Number.isFinite(value) ? Math.min(Math.max(value, 0), 100) / 100 : 0;

/**
 * Slider positions to palette units.
 *
 * `transition` drives two things at once because they are one perception: a
 * user who slows the colour slew and leaves the beats snapping gets a room that
 * looks like two effects fighting. Slew is geometric between its ends — the
 * felt difference between 0.05s and 0.15s is the same as between 0.7s and 2s,
 * and a linear slider would spend most of its travel in territory nobody wants.
 * Decay is linear, and `BEAT_DECAY_FRACTION` falls exactly on the default.
 *
 * Clamps, because `usePersistedState` hands back whatever parsed out of
 * `localStorage`: a hand-edited or stale key must not produce a negative time
 * constant or a spread that pushes hues off the arc.
 */
export function resolveSettings(settings: HueSettings): ResolvedSettings {
  const brightness = position(settings.brightness);
  const transition = position(settings.transition);
  const spread = position(settings.spread);

  return {
    brightness: BRIGHTNESS_FLOOR + (1 - BRIGHTNESS_FLOOR) * brightness,
    beatDecay: DECAY_MIN + (DECAY_MAX - DECAY_MIN) * transition,
    spreadDeg: SPREAD_MAX_DEG * spread,
    tauSeconds: TAU_MIN_SECONDS * (TAU_MAX_SECONDS / TAU_MIN_SECONDS) ** transition,
  };
}
