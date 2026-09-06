/**
 * `useSpeaker` decides which speaker every other request in the app is aimed
 * at, from two sources that disagree constantly: a persisted IP that outlives
 * the speaker, and an SSDP scan that routinely comes back short. Getting that
 * reconciliation wrong is not a rendering bug — it silently plays music in the
 * wrong room, or forgets the user's speaker because it was asleep once.
 *
 * The saved IP is seeded through `localStorage`, and "nothing saved" is an
 * explicit stored `null` rather than an absent key — the two are different
 * states here, and only the explicit one distinguishes "the user has no
 * speaker" from "we have not looked yet".
 *
 * No JSX: this file is `.ts` so Node can strip its types with no transform.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ApiError, api } from "@/lib/api/client";
import type { Device } from "@/lib/api/types";
import { useSpeaker, type SpeakerSelection } from "@/lib/hooks/use-speaker";

/** Must match the key in the hook. */
const STORAGE_KEY = "yts.speaker.ip";

const KITCHEN: Device = { name: "Kitchen", ip: "10.0.0.1" };
const OFFICE: Device = { name: "Office", ip: "10.0.0.2" };
const BEDROOM: Device = { name: "Bedroom", ip: "10.0.0.3" };

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let state: SpeakerSelection;

/** Scans the hook has started but the test has not answered yet. */
let scans: { resolve: (found: Device[]) => void; reject: () => void }[] = [];

/** How many times the hook asked the network for speakers. */
let scanCount = 0;

function stubApi() {
  mock.method(api, "devices", () => {
    scanCount += 1;
    return new Promise<Device[]>((resolve, reject) => {
      scans.push({ resolve, reject: () => reject(new ApiError("Discovery failed", 502)) });
    });
  });
}

/** Answer every outstanding scan with `found`, and flush the render. */
async function settleScan(found: Device[]) {
  const pending = scans;
  scans = [];
  for (const scan of pending) scan.resolve(found);
  await act(async () => {
    await Promise.resolve();
  });
}

async function failScan() {
  const pending = scans;
  scans = [];
  for (const scan of pending) scan.reject();
  await act(async () => {
    await Promise.resolve();
  });
}

/** Seed the remembered speaker. `null` means "no prior session". */
function saveSpeaker(ip: string | null) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ip));
}

function Probe() {
  state = useSpeaker();
  return null;
}

function render() {
  act(() => root!.render(createElement(Probe)));
}

beforeEach(() => {
  scans = [];
  scanCount = 0;
  saveSpeaker(null);
  stubApi();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root!.unmount());
  mock.restoreAll();
  container!.remove();
  root = null;
  container = null;
  window.localStorage.clear();
});

// ---------------------------------------------------------------------------

describe("useSpeaker", () => {
  it("controls nothing until a scan has found something", () => {
    render();
    assert.equal(state.selected, null);
    assert.equal(state.loading, true);
  });

  it("falls back to the first speaker found when there is no prior session", async () => {
    render();
    await settleScan([KITCHEN, OFFICE]);
    // Not "leave it null and make them choose": on the common setup there is
    // exactly one speaker, and asking which of one to use is a dialog for
    // nothing.
    assert.deepEqual(state.selected, KITCHEN);
  });

  it("restores the speaker from the previous session", async () => {
    saveSpeaker(OFFICE.ip);
    render();
    // Order is deliberately not the saved speaker's favour — SSDP returns
    // whatever answers first, so position carries no meaning.
    await settleScan([KITCHEN, OFFICE]);
    assert.deepEqual(state.selected, OFFICE);
  });

  it("uses the speaker's current name, not the one it had when it was chosen", async () => {
    saveSpeaker(OFFICE.ip);
    render();
    await settleScan([{ name: "Study", ip: OFFICE.ip }]);
    // Persisting the name alongside the IP would keep showing "Office" for a
    // speaker the user renamed in the Sonos app.
    assert.equal(state.selected?.name, "Study");
  });

  it("falls back when the saved speaker is missing, without forgetting it", async () => {
    saveSpeaker(BEDROOM.ip);
    render();
    await settleScan([KITCHEN]);
    assert.deepEqual(state.selected, KITCHEN, "an absent speaker must not leave the app dead");
    assert.equal(
      window.localStorage.getItem(STORAGE_KEY),
      JSON.stringify(BEDROOM.ip),
      "a speaker that was merely asleep must still be the user's choice",
    );
  });

  it("returns to the saved speaker when it comes back on a later scan", async () => {
    saveSpeaker(BEDROOM.ip);
    render();
    await settleScan([KITCHEN]);
    assert.deepEqual(state.selected, KITCHEN);

    act(() => state.refresh());
    await settleScan([KITCHEN, BEDROOM]);
    // This is the whole reason the fallback is derived rather than written
    // back: a speaker that was off when the page loaded is silently reclaimed
    // once it answers, with nothing for the user to do.
    assert.deepEqual(state.selected, BEDROOM);
  });

  it("remembers a speaker the user picks", async () => {
    render();
    await settleScan([KITCHEN, OFFICE]);

    act(() => state.select(OFFICE));
    assert.deepEqual(state.selected, OFFICE);
    assert.equal(window.localStorage.getItem(STORAGE_KEY), JSON.stringify(OFFICE.ip));
  });

  it("keeps an explicit choice across a rescan that reorders the speakers", async () => {
    render();
    await settleScan([KITCHEN, OFFICE]);
    act(() => state.select(OFFICE));

    act(() => state.refresh());
    await settleScan([OFFICE, KITCHEN]);
    assert.deepEqual(state.selected, OFFICE);

    act(() => state.refresh());
    await settleScan([KITCHEN, OFFICE]);
    // A scan whose order flipped must not move the music to another room.
    assert.deepEqual(state.selected, OFFICE);
  });

  it("scans once on mount and again only when asked", async () => {
    render();
    await settleScan([KITCHEN]);
    assert.equal(scanCount, 1, "discovery is multicast; it must not poll");

    act(() => state.refresh());
    assert.equal(scanCount, 2);
    await settleScan([KITCHEN]);
  });

  it("reports a failed scan and keeps controlling the speaker it had", async () => {
    render();
    await settleScan([KITCHEN, OFFICE]);
    act(() => state.select(OFFICE));

    act(() => state.refresh());
    await failScan();

    assert.ok(state.error, "the header badge has nothing to show without this");
    assert.equal(state.loading, false);
    // A failed rescan is not evidence the speaker went away, and dropping the
    // selection would tear down the SSE connection to a speaker that is very
    // possibly still playing.
    assert.deepEqual(state.selected, OFFICE);
  });
});
