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
import type { HueAnalysis, Rgb, SonosTime } from "@/lib/api/types";

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
 * A track's palette, with the per-track normalisation already done.
 *
 * Built once per song rather than per frame: it sorts the whole brightness
 * series, which at 10 Hz over four minutes is 2,400 values — trivial once, and
 * absurd fifteen times a second.
 */
export interface Renderer {
  /** The colour for `t` seconds into the track. Total: any `t` is answerable. */
  colorAt(t: number): Rgb;
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

  function pulseAt(t: number): number {
    const i = lastBeatIndex(beats, t);
    if (i < 0) return 0;
    const period = i > 0 ? beats[i] - beats[i - 1] : fallbackPeriod;
    const decay = Math.max(period, MIN_BEAT_PERIOD_SECONDS) * BEAT_DECAY_FRACTION;
    return Math.exp(-(t - beats[i]) / decay);
  }

  return {
    brightnessRange: [lo, hi] as const,

    colorAt(t: number): Rgb {
      const loudness = clamp01(sample(energy, frameSeconds, t));
      const timbre = clamp01((sample(brightness, frameSeconds, t) - lo) / span);
      const pulse = pulseAt(t);

      const hue = HUE_MIN_DEG + (HUE_MAX_DEG - HUE_MIN_DEG) * timbre;
      const base = MIN_VALUE + (1 - MIN_VALUE) * loudness;

      return hsvToRgb(
        hue,
        BASE_SATURATION * (1 - pulse * BEAT_WASH),
        base + (1 - base) * pulse * BEAT_LIFT,
      );
    },
  };
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
