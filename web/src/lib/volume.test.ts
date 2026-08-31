/**
 * The volume icon is the only thing on screen that separates *muted* from
 * *turned all the way down*. Those look identical — silence — and have
 * different fixes, so every boundary here is worth pinning.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LOUD_FROM, VOLUME_PRESETS, volumeIcon } from "@/lib/volume";

describe("volumeIcon", () => {
  it("shows a distinct glyph for silence at zero and silence from mute", () => {
    // The whole point of the function. Collapsing these is how a listener ends
    // up dragging a slider that is already where they want it.
    assert.notEqual(volumeIcon(0, false), volumeIcon(0, true));
    assert.equal(volumeIcon(0, false), "off");
    assert.equal(volumeIcon(0, true), "muted");
  });

  it("reports mute regardless of the level held underneath it", () => {
    // A muted speaker at 90 is not `high`: 90 is what it will return to, not
    // what it is doing, and that is the one genuinely misleading combination.
    assert.equal(volumeIcon(90, true), "muted");
    assert.equal(volumeIcon(1, true), "muted");
  });

  it("switches from one wave to two at the halfway mark", () => {
    assert.equal(volumeIcon(LOUD_FROM - 1, false), "low");
    // Inclusive: 50 is `high`. Arbitrary, but the icon must not have a value
    // it refuses to describe.
    assert.equal(volumeIcon(LOUD_FROM, false), "high");
  });

  it("calls any audible level below the mark low", () => {
    assert.equal(volumeIcon(1, false), "low");
    assert.equal(volumeIcon(49, false), "low");
  });

  it("calls the top of the range high", () => {
    assert.equal(volumeIcon(100, false), "high");
  });
});

describe("VOLUME_PRESETS", () => {
  it("puts its resolution at the quiet end", () => {
    // Not a uniform ramp, deliberately: the difference between 10 and 25 is a
    // conversation you can still have, and 75 to 100 is not.
    assert.deepEqual([...VOLUME_PRESETS], [10, 25, 50, 75, 100]);
  });

  it("only offers levels the speaker will accept", () => {
    for (const preset of VOLUME_PRESETS) {
      assert.ok(preset >= 0 && preset <= 100, `${preset} is outside 0–100`);
      assert.equal(preset, Math.round(preset), `${preset} is not a whole step`);
    }
  });
});
