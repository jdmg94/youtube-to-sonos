/**
 * Everything here is a claim the palette makes about how the lights *look*,
 * checked through the only observable the renderer has: the colour it returns.
 *
 * That is deliberate. The interesting failures in this module are not crashes —
 * it is total by construction — they are colours that are technically following
 * the music while looking wrong: a track that never leaves green, a beat flash
 * that vanishes in a loud chorus or never switches off at 174 BPM, a clock that
 * fires the same beat twice. None of those throw, none of them show up in a type
 * check, and all of them are one constant away.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BEAT_DECAY_FRACTION,
  COLOR_EPSILON,
  HUE_MAX_DEG,
  HUE_MIN_DEG,
  MIN_VALUE,
  REPORTED_POSITION_BIAS_SECONDS,
  RESYNC_THRESHOLD_SECONDS,
  type Clock,
  createRenderer,
  differsEnough,
  hsvToRgb,
  lastBeatIndex,
  parseSonosTime,
  positionAt,
  sample,
  syncClock,
} from "@/lib/hue";
import type { HueAnalysis, Rgb } from "@/lib/api/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FRAME = 0.1;

/** A sidecar with the shape the backend writes, and whatever features a test needs. */
function analysis(overrides: Partial<HueAnalysis> = {}): HueAnalysis {
  return {
    version: 1,
    duration: 10,
    tempo: 120,
    frame_seconds: FRAME,
    beats: [],
    energy: [0.5, 0.5],
    brightness: [0.5, 0.5],
    ...overrides,
  };
}

/** `count` evenly spaced values from `from` to `to`, inclusive. */
function ramp(from: number, to: number, count: number): number[] {
  return Array.from(
    { length: count },
    (_, i) => from + ((to - from) * i) / (count - 1),
  );
}

/** A metronome starting at zero — the shape librosa's `beats` actually has. */
function beatsAt(bpm: number, count: number): number[] {
  const period = 60 / bpm;
  return Array.from({ length: count }, (_, i) => i * period);
}

const constant = (value: number, count = 64) => Array.from({ length: count }, () => value);

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

describe("parseSonosTime", () => {
  it("reads the format the speaker actually sends", () => {
    assert.equal(parseSonosTime("0:00:00"), 0);
    assert.equal(parseSonosTime("0:00:12"), 12);
    assert.equal(parseSonosTime("0:03:45"), 225);
    assert.equal(parseSonosTime("1:02:03"), 3723);
  });

  it("returns null for every way the speaker declines to answer", () => {
    // Each of these is a real response, and each would become NaN if parsed
    // arithmetically — NaN seconds propagates into the clock, then into every
    // colour, and the lights just stop with nothing logged.
    assert.equal(parseSonosTime(""), null);
    assert.equal(parseSonosTime("NOT_IMPLEMENTED"), null);
    assert.equal(parseSonosTime(null), null);
    assert.equal(parseSonosTime(undefined), null);
  });

  it("rejects malformed time rather than guessing at it", () => {
    assert.equal(parseSonosTime("0:60:00"), null);
    assert.equal(parseSonosTime("0:00:99"), null);
    assert.equal(parseSonosTime("3:45"), null);
    assert.equal(parseSonosTime("0:0:0"), null);
  });
});

describe("positionAt", () => {
  it("advances a running clock with real time", () => {
    const clock: Clock = { position: 10, atMs: 1_000, running: true };
    assert.equal(positionAt(clock, 1_000), 10);
    assert.equal(positionAt(clock, 1_500), 10.5);
    assert.equal(positionAt(clock, 3_000), 12);
  });

  it("holds a paused clock still", () => {
    // Frames arrive about every two seconds. A paused clock that kept counting
    // would walk two seconds into the track between them, flashing beats at a
    // silent speaker, then snap back on the next frame.
    const clock: Clock = { position: 10, atMs: 1_000, running: false };
    assert.equal(positionAt(clock, 1_000), 10);
    assert.equal(positionAt(clock, 60_000), 10);
  });
});

describe("syncClock", () => {
  it("corrects for the speaker truncating to the second", () => {
    const clock = syncClock(null, 12, 1_000, true);
    assert.equal(clock.position, 12 + REPORTED_POSITION_BIAS_SECONDS);
    assert.equal(clock.atMs, 1_000);
    assert.equal(clock.running, true);
  });

  it("carries a well-tracking clock through unchanged", () => {
    // Reference identity, not just equal values: this is the value a React hook
    // stores, and a fresh object every two seconds is a re-render every two
    // seconds for a clock that had not moved.
    const previous: Clock = { position: 10.5, atMs: 0, running: true };
    const next = syncClock(previous, 12, 2_000, true);
    assert.equal(next, previous);
  });

  it("re-anchors once the drift stops being explainable", () => {
    // A seek, a track change, or a queue jump — the position is now unrelated
    // to what we were predicting, and free-running through it would light the
    // wrong part of the song until the error happened to shrink.
    const previous: Clock = { position: 10.5, atMs: 0, running: true };
    const next = syncClock(previous, 90, 2_000, true);
    assert.notEqual(next, previous);
    assert.equal(next.position, 90.5);
    assert.equal(next.atMs, 2_000);
  });

  it("tolerates the full quantisation error without re-anchoring", () => {
    // The load-bearing relationship between the two constants. After the bias
    // the reported position is wrong by at most half a second, so a threshold
    // at or below that would re-anchor on a *perfectly* tracking clock several
    // times a minute — reintroducing exactly the backwards steps the free run
    // exists to avoid.
    assert.ok(
      RESYNC_THRESHOLD_SECONDS > REPORTED_POSITION_BIAS_SECONDS,
      "threshold must exceed the worst residual error after biasing",
    );

    const previous: Clock = { position: 12.5, atMs: 0, running: true };
    // True position 12.999 → the speaker says 12 → we read 12.5, the clock says
    // 12.999. Worst case, and it must not move the anchor.
    const next = syncClock(previous, 12, 499, true);
    assert.equal(next, previous);
  });

  it("always re-anchors on a paused speaker", () => {
    const previous: Clock = { position: 10.5, atMs: 0, running: true };
    const next = syncClock(previous, 12, 2_000, false);
    assert.notEqual(next, previous);
    assert.equal(next.running, false);
  });

  it("re-anchors on resume rather than crediting the paused interval", () => {
    // The clock was parked at 10.5 while the listener took a phone call. It has
    // no idea how long that was, so the stale anchor cannot be extrapolated
    // from — the first playing frame has to win outright.
    const paused: Clock = { position: 10.5, atMs: 0, running: false };
    const next = syncClock(paused, 10, 600_000, true);
    assert.equal(next.position, 10.5);
    assert.equal(next.atMs, 600_000);
    assert.equal(next.running, true);
  });

  it("never produces a clock that renders NaN", () => {
    const clock = syncClock(null, 0, 0, true);
    assert.ok(Number.isFinite(positionAt(clock, 5_000)));
  });
});

// ---------------------------------------------------------------------------
// Series sampling
// ---------------------------------------------------------------------------

describe("sample", () => {
  it("interpolates between frames", () => {
    // The reason the loop can run faster than 10 Hz without the lamp stepping.
    const values = [0, 1];
    assert.equal(sample(values, FRAME, 0.05), 0.5);
    assert.equal(sample(values, FRAME, 0.025), 0.25);
  });

  it("lands exactly on frame boundaries", () => {
    const values = [0, 0.5, 1];
    assert.equal(sample(values, FRAME, 0), 0);
    assert.equal(sample(values, FRAME, 0.1), 0.5);
    assert.equal(sample(values, FRAME, 0.2), 1);
  });

  it("clamps past the end instead of running off the array", () => {
    // The clock legitimately overruns the analysed duration: it free-runs, and
    // the analysis covers the decoded audio rather than the speaker's idea of
    // the track. Reading past the end must hold the last value, not undefined.
    const values = [0, 0.5, 1];
    assert.equal(sample(values, FRAME, 0.3), 1);
    assert.equal(sample(values, FRAME, 9_999), 1);
  });

  it("clamps before the start", () => {
    const values = [0.25, 1];
    assert.equal(sample(values, FRAME, 0), 0.25);
    assert.equal(sample(values, FRAME, -5), 0.25);
  });

  it("survives every degenerate input without returning NaN", () => {
    // A NaN here is the worst outcome available: it reaches hsvToRgb, comes out
    // as three NaNs, and gets POSTed at the bridge as a colour.
    assert.equal(sample([], FRAME, 1), 0);
    assert.equal(sample([0.4], FRAME, 1), 0.4);
    assert.equal(sample([0.4, 0.9], 0, 1), 0.4);
  });

  it("collapses every non-finite time to the first frame", () => {
    // Including +Infinity, which the "clamps past the end" rule would otherwise
    // send to the last frame. Not worth a branch: a non-finite time means the
    // clock is broken rather than late, so there is no frame that is more
    // correct than another and the only requirement is a defined, in-range
    // answer. Pinned because it reads like an oversight otherwise.
    assert.equal(sample([0.4, 0.9], FRAME, NaN), 0.4);
    assert.equal(sample([0.4, 0.9], FRAME, Infinity), 0.4);
    assert.equal(sample([0.4, 0.9], FRAME, -Infinity), 0.4);
  });
});

describe("lastBeatIndex", () => {
  const beats = [1, 2, 3.5, 4];

  it("reports no beat before the first one", () => {
    // -1, not 0: a track with a long intro must not flash on a beat that has
    // not happened, and clamping to 0 would hold a decaying pulse from t=0.
    assert.equal(lastBeatIndex(beats, 0), -1);
    assert.equal(lastBeatIndex(beats, 0.999), -1);
  });

  it("counts a beat from the instant it lands", () => {
    assert.equal(lastBeatIndex(beats, 1), 0);
    assert.equal(lastBeatIndex(beats, 3.5), 2);
  });

  it("holds the previous beat between beats", () => {
    assert.equal(lastBeatIndex(beats, 1.9), 0);
    assert.equal(lastBeatIndex(beats, 3.4), 1);
  });

  it("holds the last beat through the outro", () => {
    assert.equal(lastBeatIndex(beats, 4), 3);
    assert.equal(lastBeatIndex(beats, 600), 3);
  });

  it("answers the same for a time regardless of what was asked before", () => {
    // The property a remembered cursor would break. The clock re-anchors and
    // seeks jump, so t goes backwards; a cursor-based search would quietly stop
    // finding beats for the rest of the song.
    assert.equal(lastBeatIndex(beats, 3.9), 2);
    assert.equal(lastBeatIndex(beats, 1.2), 0);
    assert.equal(lastBeatIndex(beats, 3.9), 2);
  });

  it("handles an empty beat list", () => {
    assert.equal(lastBeatIndex([], 5), -1);
  });
});

// ---------------------------------------------------------------------------
// Colour conversion
// ---------------------------------------------------------------------------

describe("hsvToRgb", () => {
  it("puts the primaries where they belong", () => {
    assert.deepEqual(hsvToRgb(0, 1, 1), [255, 0, 0]);
    assert.deepEqual(hsvToRgb(120, 1, 1), [0, 255, 0]);
    assert.deepEqual(hsvToRgb(240, 1, 1), [0, 0, 255]);
  });

  it("desaturates to grey and darkens to black", () => {
    assert.deepEqual(hsvToRgb(200, 0, 1), [255, 255, 255]);
    assert.deepEqual(hsvToRgb(200, 1, 0), [0, 0, 0]);
  });

  it("wraps the hue circle in both directions", () => {
    assert.deepEqual(hsvToRgb(360, 1, 1), hsvToRgb(0, 1, 1));
    assert.deepEqual(hsvToRgb(-120, 1, 1), hsvToRgb(240, 1, 1));
  });

  it("clamps saturation and value rather than emitting out-of-range bytes", () => {
    // The bridge takes bytes. An over-range value that arrived as 300 would be
    // truncated somewhere downstream into something unrelated.
    assert.deepEqual(hsvToRgb(0, 2, 2), [255, 0, 0]);
    assert.deepEqual(hsvToRgb(0, -1, -1), [0, 0, 0]);
  });

  it("only ever emits whole bytes in range", () => {
    for (let h = 0; h < 360; h += 7) {
      for (const s of [0, 0.33, 0.9, 1]) {
        for (const v of [0, 0.15, 0.62, 1]) {
          for (const c of hsvToRgb(h, s, v)) {
            assert.ok(Number.isInteger(c) && c >= 0 && c <= 255, `${h}/${s}/${v} → ${c}`);
          }
        }
      }
    }
  });
});

describe("the hue arc", () => {
  it("does not wrap, so the extremes cannot collide", () => {
    // The reason the arc stops at 280° instead of using the whole wheel. Mapped
    // onto 0..360, the brightest timbre in a track lands on the same red as the
    // darkest and the palette silently loses its top end.
    assert.ok(HUE_MAX_DEG < 360);
    assert.ok(
      differsEnough(hsvToRgb(HUE_MIN_DEG, 0.9, 1), hsvToRgb(HUE_MAX_DEG, 0.9, 1)),
      "the ends of the arc must be visibly different colours",
    );
  });
});

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

describe("createRenderer: timbre normalisation", () => {
  // A realistic track: the spectral centroid stays inside a fifth of the
  // absolute scale, because almost all produced music does.
  const NARROW = analysis({
    beats: [],
    energy: constant(1, 101),
    brightness: ramp(0.4, 0.6, 101),
    duration: 10.1,
  });

  it("stretches a track's own range across the whole arc", () => {
    const renderer = createRenderer(NARROW);
    const [lo, hi] = renderer.brightnessRange;
    // Trimmed 5th/95th percentiles of the ramp, not its min and max.
    assert.ok(Math.abs(lo - 0.41) < 1e-9, `lo was ${lo}`);
    assert.ok(Math.abs(hi - 0.59) < 1e-9, `hi was ${hi}`);

    const dark = renderer.colorAt(0.5); // brightness 0.41 → bottom of the arc
    const bright = renderer.colorAt(9.5); // brightness 0.59 → top of the arc
    assert.ok(dark[0] > dark[2], `expected a red-dominant low end, got ${dark}`);
    assert.ok(bright[2] > bright[0], `expected a violet-dominant high end, got ${bright}`);
  });

  it("reaches colours the absolute map never would", () => {
    // The failure this normalisation exists to prevent, stated as the contrast:
    // mapped absolutely, this track's entire range is green-to-cyan and the
    // lights look like a fixed colour that occasionally shivers.
    const absoluteLow = hsvToRgb(HUE_MIN_DEG + (HUE_MAX_DEG - HUE_MIN_DEG) * 0.4, 0.9, 1);
    const absoluteHigh = hsvToRgb(HUE_MIN_DEG + (HUE_MAX_DEG - HUE_MIN_DEG) * 0.6, 0.9, 1);
    assert.ok(absoluteLow[1] > absoluteLow[0] && absoluteLow[1] > absoluteLow[2]);
    assert.ok(absoluteHigh[1] > absoluteHigh[0]);

    const renderer = createRenderer(NARROW);
    assert.ok(
      differsEnough(renderer.colorAt(0.5), absoluteLow, 60),
      "the normalised low end should be nowhere near the absolute one",
    );
  });

  it("leaves a single-colour track alone instead of amplifying its noise floor", () => {
    // A drone or a spoken-word recording. Stretching a 0.002-wide band across
    // 280° would swing the room through the rainbow on changes nobody can hear.
    const drone = analysis({
      beats: [],
      energy: constant(1, 101),
      brightness: ramp(0.299, 0.301, 101),
      duration: 10.1,
    });
    const renderer = createRenderer(drone);
    assert.deepEqual(renderer.brightnessRange, [0, 1]);
    assert.ok(
      !differsEnough(renderer.colorAt(0.5), renderer.colorAt(9.5)),
      "a drone should hold one colour",
    );
  });

  it("falls back rather than dividing by a zero span", () => {
    const flat = createRenderer(
      analysis({ beats: [], brightness: constant(0.5), energy: constant(1) }),
    );
    assert.deepEqual(flat.brightnessRange, [0, 1]);
    for (const c of flat.colorAt(1)) assert.ok(Number.isFinite(c));
  });
});

describe("createRenderer: loudness", () => {
  const quiet = createRenderer(
    analysis({ beats: [], energy: constant(0), brightness: constant(0.5) }),
  );
  const loud = createRenderer(
    analysis({ beats: [], energy: constant(1), brightness: constant(0.5) }),
  );

  it("dims silence without switching the lights off", () => {
    // Lights that go out during a quiet intro read as a crash, and the
    // listener's next move is to go and check the app.
    const dark = quiet.colorAt(1);
    assert.ok(Math.max(...dark) > 0, "a silent passage must stay lit");
    assert.ok(
      Math.max(...dark) <= Math.round(MIN_VALUE * 255) + 1,
      `expected a floor near MIN_VALUE, got ${dark}`,
    );
  });

  it("opens up at full energy", () => {
    assert.ok(Math.max(...loud.colorAt(1)) > Math.max(...quiet.colorAt(1)) * 3);
  });
});

describe("createRenderer: the beat flash", () => {
  const TEMPOS = [60, 120, 174];

  function metronome(bpm: number) {
    return createRenderer(
      analysis({
        tempo: bpm,
        beats: beatsAt(bpm, 32),
        energy: constant(0.5),
        brightness: constant(0.5),
        duration: 60,
      }),
    );
  }

  it("looks identical at the same point in the bar at any tempo", () => {
    // What scaling the decay to the local beat period buys, stated exactly: the
    // flash occupies the same share of every bar, so a slow song and a fast one
    // pulse with the same shape rather than one strobing and the other smearing
    // into a constant glow.
    const halfway = TEMPOS.map((bpm) => {
      const period = 60 / bpm;
      return metronome(bpm).colorAt(2 * period + period / 2);
    });
    assert.deepEqual(halfway[1], halfway[0]);
    assert.deepEqual(halfway[2], halfway[0]);
  });

  it("has faded by the next beat at every tempo, so flashes never stack", () => {
    // exp(-1/BEAT_DECAY_FRACTION) is the residual one beat later, and it is a
    // constant precisely because the decay is a fraction of the period.
    const residual = Math.exp(-1 / BEAT_DECAY_FRACTION);
    assert.ok(residual < 0.07, `a beat still at ${residual} would accumulate`);

    for (const bpm of TEMPOS) {
      const period = 60 / bpm;
      const renderer = metronome(bpm);
      const onBeat = renderer.colorAt(2 * period);
      const justBefore = renderer.colorAt(3 * period - 1e-6);
      assert.ok(
        differsEnough(onBeat, justBefore, 40),
        `at ${bpm} BPM the flash had not faded: ${onBeat} vs ${justBefore}`,
      );
    }
  });

  it("decays monotonically between beats", () => {
    const renderer = metronome(120);
    const period = 0.5;
    let previous: Rgb | null = null;
    for (let phase = 0; phase < 1; phase += 0.05) {
      const current = renderer.colorAt(2 * period + phase * period);
      if (previous) {
        for (let c = 0; c < 3; c++) {
          assert.ok(
            current[c] <= previous[c],
            `channel ${c} rose mid-decay at phase ${phase}`,
          );
        }
      }
      previous = current;
    }
  });

  it("stays visible at full loudness", () => {
    // The justification for washing saturation as well as lifting value. At
    // energy 1 the value is already at the ceiling, so a value-only flash would
    // be invisible exactly where the music is most beat-driven.
    const renderer = createRenderer(
      analysis({
        tempo: 120,
        beats: beatsAt(120, 32),
        energy: constant(1),
        brightness: constant(0.5),
        duration: 60,
      }),
    );
    const onBeat = renderer.colorAt(1);
    const offBeat = renderer.colorAt(1.4);
    assert.ok(
      differsEnough(onBeat, offBeat, 40),
      `the beat vanished in a loud passage: ${onBeat} vs ${offBeat}`,
    );
  });

  it("does not flash before the first beat", () => {
    const renderer = createRenderer(
      analysis({ beats: [5], energy: constant(0.5), brightness: constant(0.5), duration: 10 }),
    );
    assert.deepEqual(renderer.colorAt(0), renderer.colorAt(4.9));
    assert.ok(differsEnough(renderer.colorAt(5), renderer.colorAt(4.9), 20));
  });

  it("uses the reported tempo for the very first beat, which has no predecessor", () => {
    const slow = createRenderer(
      analysis({ tempo: 60, beats: [1], energy: constant(0.5), brightness: constant(0.5) }),
    );
    const fast = createRenderer(
      analysis({ tempo: 174, beats: [1], energy: constant(0.5), brightness: constant(0.5) }),
    );
    // A 60 BPM opening beat should still be glowing where a 174 BPM one is done.
    assert.ok(differsEnough(slow.colorAt(1.3), fast.colorAt(1.3), 10));
  });

  it("survives a degenerate sidecar with two beats at one instant", () => {
    // A zero period would make the decay zero and every colour NaN, which the
    // bridge would receive as a black frame with no error anywhere.
    const renderer = createRenderer(
      analysis({ beats: [1, 1, 2], energy: constant(0.5), brightness: constant(0.5) }),
    );
    for (const t of [1, 1.0001, 1.5]) {
      for (const c of renderer.colorAt(t)) {
        assert.ok(Number.isInteger(c) && c >= 0 && c <= 255, `t=${t} → ${c}`);
      }
    }
  });
});

describe("createRenderer: totality", () => {
  it("answers with a valid colour for any time at all", () => {
    // The renderer is driven by a free-running clock reading a sidecar written
    // by a different process. Every one of these is reachable, and there is no
    // sensible way to fail: the lights are already on.
    const renderer = createRenderer(
      analysis({ beats: [1, 2, 3], energy: ramp(0, 1, 32), brightness: ramp(0, 1, 32) }),
    );
    for (const t of [-10, 0, 0.001, 1, 3.2, 1e6, NaN, Infinity, -Infinity]) {
      const rgb = renderer.colorAt(t);
      assert.equal(rgb.length, 3);
      for (const c of rgb) {
        assert.ok(Number.isInteger(c) && c >= 0 && c <= 255, `t=${t} → ${rgb}`);
      }
    }
  });

  it("handles an empty analysis without throwing", () => {
    const renderer = createRenderer(
      analysis({ beats: [], energy: [], brightness: [], duration: 0, tempo: 0 }),
    );
    for (const c of renderer.colorAt(5)) assert.ok(Number.isInteger(c));
  });
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

describe("differsEnough", () => {
  it("suppresses a colour the bridge is already showing", () => {
    // Not an optimisation for its own sake: the backend resends its last
    // setpoint at 25 Hz, so a suppressed colour changes nothing on the lamp and
    // a held note costs no requests at all.
    assert.equal(differsEnough([10, 20, 30], [10, 20, 30]), false);
    assert.equal(differsEnough([10, 20, 30], [11, 21, 31]), false);
  });

  it("passes a change on any single channel", () => {
    const base: Rgb = [10, 20, 30];
    assert.equal(differsEnough(base, [10 + COLOR_EPSILON, 20, 30]), true);
    assert.equal(differsEnough(base, [10, 20 + COLOR_EPSILON, 30]), true);
    assert.equal(differsEnough(base, [10, 20, 30 + COLOR_EPSILON]), true);
  });

  it("is symmetric, so the threshold does not depend on direction", () => {
    assert.equal(differsEnough([10, 20, 30], [40, 20, 30]), true);
    assert.equal(differsEnough([40, 20, 30], [10, 20, 30]), true);
  });

  it("takes the boundary as sending", () => {
    assert.equal(differsEnough([0, 0, 0], [COLOR_EPSILON - 1, 0, 0]), false);
    assert.equal(differsEnough([0, 0, 0], [COLOR_EPSILON, 0, 0]), true);
  });

  it("honours a caller's own threshold", () => {
    assert.equal(differsEnough([0, 0, 0], [10, 0, 0], 20), false);
    assert.equal(differsEnough([0, 0, 0], [30, 0, 0], 20), true);
  });
});
