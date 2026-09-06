/**
 * The Hue subsystem has two states that look like errors and are not, and one
 * that looks fine and is not. Every test here is about telling them apart:
 *
 * A 428 from pairing is the flow working. A stream that stopped by itself is
 * reported by a field nobody reads unless told to, on a response that otherwise
 * looks like "idle". And an entertainment area marked `active` is either the
 * best possible state or an unusable one, depending entirely on whose stream is
 * running.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { HueArea, HueBridge, HueHealth } from "@/lib/api/types";
import {
  AREA_BUSY_NOTE,
  AREA_EMPTY_NOTE,
  LINK_BUTTON_STATUS,
  PAIR_POLL_MS,
  PAIR_WINDOW_MS,
  UNNAMED_AREA,
  UNNAMED_BRIDGE,
  describeArea,
  describeBridge,
  describeHue,
  pairingStep,
  pickArea,
} from "@/lib/hue-bridge";

function health(overrides: Partial<HueHealth> = {}): HueHealth {
  return {
    paired: true,
    bridge_ip: "192.168.1.5",
    bridge_id: "001788fffe1234ab",
    psk_profile: null,
    streaming: false,
    area: null,
    channels: [],
    error: null,
    ...overrides,
  };
}

function area(overrides: Partial<HueArea> = {}): HueArea {
  return {
    id: "area-1",
    name: "Living room",
    status: "inactive",
    channels: [0, 1, 2],
    positions: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe("pairingStep", () => {
  it("keeps waiting while the button has not been pressed", () => {
    // The common case by far: roughly thirty of these per successful pairing.
    // Treating it as a failure is the bug this function exists to prevent.
    assert.equal(pairingStep(LINK_BUTTON_STATUS, 0), "retry");
    assert.equal(pairingStep(LINK_BUTTON_STATUS, PAIR_WINDOW_MS - 1), "retry");
  });

  it("gives up once the window closes", () => {
    assert.equal(pairingStep(LINK_BUTTON_STATUS, PAIR_WINDOW_MS), "expired");
    assert.equal(pairingStep(LINK_BUTTON_STATUS, PAIR_WINDOW_MS * 10), "expired");
  });

  it("stops immediately on anything that is not the link button", () => {
    // A bridge that is unreachable, or refusing, will refuse the next thirty
    // attempts identically. Retrying spends a minute hiding the real message
    // behind a "press the button" prompt that cannot help.
    assert.equal(pairingStep(0, 0), "failed");
    assert.equal(pairingStep(404, 0), "failed");
    assert.equal(pairingStep(500, 0), "failed");
  });

  it("reports a real error as failed even past the deadline", () => {
    // Ordering matters: `expired` says "press it and try again", which is the
    // wrong instruction for a bridge that is not answering at all.
    assert.equal(pairingStep(500, PAIR_WINDOW_MS * 2), "failed");
  });

  it("polls often enough to finish inside the window", () => {
    // A poll interval that did not divide well into the window would spend the
    // user's last few seconds asleep.
    assert.ok(PAIR_WINDOW_MS / PAIR_POLL_MS >= 10);
  });

  it("waits longer than the bridge's own 30-second button window", () => {
    // The bridge's clock starts at the press; ours starts when the user taps
    // Pair, which is before they have stood up.
    assert.ok(PAIR_WINDOW_MS > 30_000);
  });
});

// ---------------------------------------------------------------------------

describe("describeBridge", () => {
  const bridge = (overrides: Partial<HueBridge> = {}): HueBridge => ({
    ip: "192.168.1.5",
    id: "001788fffe1234ab",
    name: "Philips hue",
    source: "mdns",
    ...overrides,
  });

  it("names a bridge that named itself", () => {
    assert.equal(describeBridge(bridge()).label, "Philips hue");
  });

  it("falls back for a bridge that did not", () => {
    // The cloud directory never returns a name, so this is not an edge case.
    assert.equal(describeBridge(bridge({ name: null })).label, UNNAMED_BRIDGE);
    assert.equal(describeBridge(bridge({ name: "" })).label, UNNAMED_BRIDGE);
  });

  it("says which scan found it", () => {
    // "From Philips' directory" means we have never actually seen this bridge —
    // mDNS found nothing and the cloud vouched for the address. That is exactly
    // the row whose pairing fails with a network error, and saying so turns an
    // inexplicable failure into an obvious one.
    assert.match(describeBridge(bridge({ source: "mdns" })).detail, /this network/);
    assert.match(describeBridge(bridge({ source: "cloud" })).detail, /directory/);
  });

  it("always shows the address, which is the part that identifies it", () => {
    for (const source of ["mdns", "cloud"] as const) {
      assert.match(describeBridge(bridge({ source })).detail, /192\.168\.1\.5/);
    }
  });
});

// ---------------------------------------------------------------------------

describe("describeHue", () => {
  it("distinguishes the first read from a failed one", () => {
    // Both have no health. Showing "unavailable" during the opening fetch would
    // report a broken bridge on every page load.
    assert.equal(describeHue(null, true).tone, "loading");
    assert.equal(describeHue(null, false).tone, "error");
  });

  it("asks for setup when nothing is paired", () => {
    const view = describeHue(health({ paired: false }), false);
    assert.equal(view.tone, "setup");
  });

  it("surfaces a stream that stopped on its own", () => {
    // The case that would otherwise be invisible. A bridge idle timeout, a
    // firmware reboot, or another app taking the single stream slot all leave
    // `streaming: false` — identical to never having started — and the lights
    // just stop with the button still offering to start them.
    const view = describeHue(health({ error: "bridge closed the stream" }), false);
    assert.equal(view.tone, "error");
    assert.equal(view.detail, "bridge closed the stream");
  });

  it("prefers a running stream over a stale error from the last one", () => {
    // `health.error` is not cleared by a successful restart, so checking it
    // first would leave the banner reporting a failure while the lights ran.
    const view = describeHue(
      health({ streaming: true, channels: [0, 1], error: "bridge closed the stream" }),
      false,
    );
    assert.equal(view.tone, "live");
  });

  it("counts the lights it is driving, in the right number", () => {
    assert.equal(describeHue(health({ streaming: true, channels: [0] }), false).detail, "1 light");
    assert.equal(
      describeHue(health({ streaming: true, channels: [0, 1, 2] }), false).detail,
      "3 lights",
    );
  });

  it("names the area when streaming and one is known", () => {
    const view = describeHue(health({ streaming: true, channels: [0] }), false, "Living room");
    assert.equal(view.label, "Living room");
    // The bridge reports an area id, not a name, so an unnamed area has to read
    // as something other than a raw uuid.
    assert.notEqual(describeHue(health({ streaming: true, channels: [0] }), false).label, "");
  });

  it("reports a paired idle bridge as ready, with its address", () => {
    const view = describeHue(health(), false);
    assert.equal(view.tone, "ready");
    assert.equal(view.detail, "192.168.1.5");
  });
});

// ---------------------------------------------------------------------------

describe("describeArea", () => {
  it("refuses an area with no lights in it", () => {
    // The backend answers 409 for this, having correctly decided there is no
    // point handshaking to send frames to nothing.
    const view = describeArea(area({ channels: [] }), health());
    assert.equal(view.ready, false);
    assert.equal(view.detail, AREA_EMPTY_NOTE);
  });

  it("refuses an area another app is already streaming to", () => {
    // The bridge permits exactly one stream. Without this the user picks the
    // area, gets a bridge-level error that never mentions the Hue app open on
    // their phone, and concludes this app is broken.
    const view = describeArea(area({ status: "active" }), health({ streaming: false }));
    assert.equal(view.ready, false);
    assert.match(view.detail, new RegExp(AREA_BUSY_NOTE));
  });

  it("treats our own stream as the good state, not as a conflict", () => {
    // Same `status: "active"`, opposite meaning. Reading the field alone is how
    // the running stream ends up greyed out as unavailable.
    const view = describeArea(
      area({ status: "active" }),
      health({ streaming: true, area: "area-1" }),
    );
    assert.equal(view.ready, true);
    assert.equal(view.detail, "3 lights");
  });

  it("does not credit us with a stream running against a different area", () => {
    const view = describeArea(
      area({ id: "area-1", status: "active" }),
      health({ streaming: true, area: "area-2" }),
    );
    assert.equal(view.ready, false);
  });

  it("accepts an idle area with lights", () => {
    assert.equal(describeArea(area(), health()).ready, true);
    assert.equal(describeArea(area(), null).ready, true);
  });

  it("counts lights in the right number", () => {
    assert.equal(describeArea(area({ channels: [0] }), health()).detail, "1 light");
  });

  it("names an area the bridge left unnamed", () => {
    assert.equal(describeArea(area({ name: null }), health()).label, UNNAMED_AREA);
    assert.equal(describeArea(area({ name: "" }), health()).label, UNNAMED_AREA);
  });

  it("reports emptiness ahead of busyness", () => {
    // Both are true of an empty active area, but only one of them is the user's
    // problem to fix.
    const view = describeArea(area({ channels: [], status: "active" }), health());
    assert.equal(view.detail, AREA_EMPTY_NOTE);
  });
});

// ---------------------------------------------------------------------------

describe("pickArea", () => {
  const areas = [area({ id: "a" }), area({ id: "b" })];

  it("honours a saved choice", () => {
    assert.equal(pickArea(areas, "b")?.id, "b");
  });

  it("falls back to the first when the saved one is missing", () => {
    // The caller must not write this back — same rule as `useSpeaker`. An area
    // absent because the bridge is still booting would otherwise permanently
    // overwrite the user's choice.
    assert.equal(pickArea(areas, "gone")?.id, "a");
    assert.equal(pickArea(areas, null)?.id, "a");
  });

  it("has nothing to pick from an empty list", () => {
    assert.equal(pickArea([], "a"), null);
  });
});
