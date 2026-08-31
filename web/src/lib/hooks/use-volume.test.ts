/**
 * `useVolume` is the only optimistic state in the app, which means it is the
 * only place where the screen can disagree with the speaker. The interesting
 * failures are all invisible: a debounced write landing on the speaker the
 * user just navigated away from, a mute sent twice for one press, the previous
 * speaker's level shown under the new one's name.
 *
 * Rendered inside `StrictMode` on purpose. React double-invokes state updaters
 * there precisely to expose impure ones, and a side effect smuggled into an
 * updater is the bug this file exists to prevent — outside StrictMode the test
 * would pass with the bug present.
 *
 * No JSX: this file is `.ts` so Node can strip its types with no transform.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ApiError, api } from "@/lib/api/client";
import { useVolume, type VolumeControl } from "@/lib/hooks/use-volume";
import type { VolumeRequest } from "@/lib/api/types";

/** Comfortably past the hook's 150ms debounce. */
const PAST_DEBOUNCE_MS = 300;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let control: VolumeControl;

/** Every `setVolume` body the hook sent, in order. */
let writes: VolumeRequest[] = [];

/** Volume reads, resolved by the test so it controls when the hook is ready. */
let reads: { resolve: () => void; reject: () => void }[] = [];

function stubApi({ volume = 30, mute = false } = {}) {
  mock.method(api, "getVolume", (deviceIp?: string) => {
    return new Promise<never | { volume: number; mute: boolean; device: string; device_ip: string }>(
      (resolve, reject) => {
        reads.push({
          resolve: () =>
            resolve({ volume, mute, device: "Kitchen", device_ip: deviceIp ?? "" }),
          reject: () => reject(new Error("speaker unreachable")),
        });
      },
    );
  });

  mock.method(api, "setVolume", async (body: VolumeRequest) => {
    writes.push(body);
    return { volume: body.volume ?? volume, mute: body.mute ?? mute, device: "Kitchen" };
  });
}

/** Let the pending volume read succeed, and flush the resulting render. */
async function settleRead() {
  const pending = reads;
  reads = [];
  for (const read of pending) read.resolve();
  await act(async () => {
    await Promise.resolve();
  });
}

function Probe({ ip }: { ip: string | null }) {
  control = useVolume(ip);
  return null;
}

function render(ip: string | null) {
  act(() => {
    root!.render(createElement(StrictMode, null, createElement(Probe, { ip })));
  });
}

beforeEach(() => {
  writes = [];
  reads = [];
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
});

// ---------------------------------------------------------------------------

describe("useVolume", () => {
  it("is not ready before the speaker has reported its volume", () => {
    render("10.0.0.1");
    assert.equal(control.ready, false);
    // Not 0-and-ready: a slider parked at zero looks like a real level and
    // invites a drag that would then jump.
    assert.equal(control.volume, 0);
  });

  it("becomes ready with the reported level", async () => {
    render("10.0.0.1");
    await settleRead();
    assert.equal(control.ready, true);
    assert.equal(control.volume, 30);
    assert.equal(control.muted, false);
  });

  it("stays un-ready when the speaker will not report its volume", async () => {
    render("10.0.0.1");
    const pending = reads;
    reads = [];
    for (const read of pending) read.reject();
    await act(async () => {
      await Promise.resolve();
    });
    // A speaker that won't report a volume won't accept one either, so the
    // control must stay hidden rather than offer a slider that snaps back.
    assert.equal(control.ready, false);
  });

  it("opens no volume control at all until a speaker is chosen", () => {
    render(null);
    assert.equal(control.ready, false);
    assert.equal(reads.length, 0, "no speaker means nothing to ask");
  });

  it("moves the slider immediately but writes only after the debounce", async () => {
    render("10.0.0.1");
    await settleRead();

    act(() => control.setVolume(55));
    // The thumb has to track the thumb.
    assert.equal(control.volume, 55);
    assert.equal(writes.length, 0, "a write must not be sent on every pixel");

    await sleep(PAST_DEBOUNCE_MS);
    assert.deepEqual(writes, [{ device_ip: "10.0.0.1", volume: 55 }]);
  });

  it("collapses a drag into a single write carrying the final value", async () => {
    render("10.0.0.1");
    await settleRead();

    for (const value of [40, 45, 50, 60]) act(() => control.setVolume(value));
    assert.equal(control.volume, 60);

    await sleep(PAST_DEBOUNCE_MS);
    assert.equal(writes.length, 1, "a drag is one write, not one per sample");
    assert.equal(writes[0].volume, 60);
  });

  it("clamps and rounds before it shows or sends anything", async () => {
    render("10.0.0.1");
    await settleRead();

    act(() => control.setVolume(140));
    assert.equal(control.volume, 100);
    await sleep(PAST_DEBOUNCE_MS);
    assert.equal(writes.at(-1)?.volume, 100);

    act(() => control.setVolume(-20));
    assert.equal(control.volume, 0);
    await sleep(PAST_DEBOUNCE_MS);
    assert.equal(writes.at(-1)?.volume, 0);

    act(() => control.setVolume(42.6));
    assert.equal(control.volume, 43);
  });

  it("never shows the previous speaker's level under the new speaker", async () => {
    render("10.0.0.1");
    await settleRead();
    assert.equal(control.volume, 30);

    render("10.0.0.2");
    // Synchronously, in the same commit as the prop change. One frame of the
    // old speaker's level is one frame of a lie about which box is loud.
    assert.equal(control.ready, false);
    assert.equal(control.volume, 0);
  });

  it("does not land a pending write on the speaker the user just left", async () => {
    render("10.0.0.1");
    await settleRead();

    act(() => control.setVolume(90));
    // Switch away before the debounce elapses.
    render("10.0.0.2");
    await sleep(PAST_DEBOUNCE_MS);

    assert.deepEqual(writes, [], "the queued write belonged to the old speaker");
  });

  it("does not land a pending write after unmount", async () => {
    render("10.0.0.1");
    await settleRead();

    act(() => control.setVolume(90));
    act(() => root!.unmount());
    root = createRoot(container!); // so afterEach has something to unmount

    await sleep(PAST_DEBOUNCE_MS);
    assert.deepEqual(writes, [], "a closed tab must not change the volume");
  });

  it("sends exactly one mute command per press, immediately", async () => {
    render("10.0.0.1");
    await settleRead();

    act(() => control.toggleMute());

    // Immediate, not debounced: 150ms of delay is audible as exactly the thing
    // the user pressed the button to stop.
    assert.deepEqual(writes, [{ device_ip: "10.0.0.1", mute: true }]);
    assert.equal(control.muted, true);

    // The count is the point. Firing the request from inside a state updater
    // reads identically but sends two, because StrictMode — and any discarded
    // render — invokes updaters more than once.
    await sleep(PAST_DEBOUNCE_MS);
    assert.equal(writes.length, 1, "one press is one command");
  });

  it("unmutes on a second press", async () => {
    render("10.0.0.1");
    await settleRead();
    act(() => control.toggleMute());
    act(() => control.toggleMute());
    assert.equal(control.muted, false);
    assert.deepEqual(writes.at(-1), { device_ip: "10.0.0.1", mute: false });
    assert.equal(writes.length, 2);
  });

  it("ignores a mute press before the speaker has been read", () => {
    render("10.0.0.1");
    act(() => control.toggleMute());
    // Without a known starting state, "toggle" has nothing to invert, and
    // guessing would mute a speaker the user might have wanted unmuted.
    assert.deepEqual(writes, []);
  });

  it("survives a failing write without breaking the slider", async () => {
    render("10.0.0.1");
    await settleRead();
    mock.method(api, "setVolume", async () => {
      throw new Error("speaker refused");
    });

    act(() => control.setVolume(70));
    await sleep(PAST_DEBOUNCE_MS);

    // The optimistic value stands. The alternative — snapping back — fights
    // the user's thumb over a speaker that is probably just briefly busy.
    assert.equal(control.volume, 70);
    act(() => control.setVolume(75));
    assert.equal(control.volume, 75);
  });

  /*
   * The counterpart to the optimism above. The slider and the mute glyph have
   * already moved by the time a write fails, so without a reported error the UI
   * sits there showing a muted speaker that is still playing.
   */
  describe("reporting a refused write", () => {
    /** Make every write fail, from now on. */
    function breakWrites(message = "speaker refused") {
      mock.method(api, "setVolume", async () => {
        throw new ApiError(message, 500);
      });
    }

    it("has nothing to report before anything has failed", async () => {
      render("10.0.0.1");
      await settleRead();
      assert.equal(control.error, null);
    });

    it("reports a refused level change", async () => {
      render("10.0.0.1");
      await settleRead();
      breakWrites();

      act(() => control.setVolume(70));
      await sleep(PAST_DEBOUNCE_MS);

      assert.equal(control.error?.message, "speaker refused");
    });

    it("reports a refused mute", async () => {
      render("10.0.0.1");
      await settleRead();
      breakWrites("cannot mute a grouped speaker");

      await act(async () => {
        control.toggleMute();
        await Promise.resolve();
      });

      assert.equal(control.error?.message, "cannot mute a grouped speaker");
    });

    it("names a network failure rather than surfacing a TypeError", async () => {
      render("10.0.0.1");
      await settleRead();
      mock.method(api, "setVolume", async () => {
        // What `fetch` throws when the box is off. Its message is
        // "Failed to fetch", which tells the listener nothing.
        throw new TypeError("Failed to fetch");
      });

      act(() => control.setVolume(70));
      await sleep(PAST_DEBOUNCE_MS);

      assert.equal(control.error?.message, "Could not reach the speaker");
    });

    it("gives a distinct error object per failure so a repeat still toasts", async () => {
      render("10.0.0.1");
      await settleRead();
      breakWrites();

      act(() => control.setVolume(70));
      await sleep(PAST_DEBOUNCE_MS);
      const first = control.error;

      act(() => control.setVolume(80));
      await sleep(PAST_DEBOUNCE_MS);

      // `useErrorToast` fires on identity change. Reusing one object would
      // silently swallow every failure after the first.
      assert.ok(first);
      assert.notEqual(control.error, first);
    });

    it("does not report the old speaker's failure under the new speaker's name", async () => {
      render("10.0.0.1");
      await settleRead();
      breakWrites();

      // A mute cannot be cancelled — it is sent the instant it is pressed — so
      // it can still be in flight when the user changes rooms. "Kitchen refused
      // the command" shown under Lounge is worse than saying nothing.
      act(() => control.toggleMute());
      render("10.0.0.2");
      await act(async () => {
        await sleep(PAST_DEBOUNCE_MS);
      });

      assert.equal(control.error, null);
    });
  });
});
