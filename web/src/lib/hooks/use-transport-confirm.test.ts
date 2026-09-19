/**
 * `useTransportConfirm` is what stops the play/pause button from lying for the
 * two seconds between a press and the frame that confirms it.
 *
 * Every case here is a way that gap can end: the speaker does what it was
 * asked, the speaker does something else, the request is refused, or no frame
 * arrives at all. The last one is the reason the escape hatch exists — without
 * it a dropped stream leaves the only playback control permanently dead, and
 * the only way out is a page reload.
 *
 * No JSX: this file is `.ts` so Node can strip its types with no transform.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { PlaybackState } from "@/lib/api/types";
import {
  CONFIRM_TIMEOUT_MS,
  useTransportConfirm,
  type TransportConfirm,
} from "@/lib/hooks/use-transport-confirm";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/** The hook's return value from the last render. */
let confirm: TransportConfirm | null = null;

function Probe({ state }: { state: PlaybackState | null }) {
  confirm = useTransportConfirm(state);
  return null;
}

/**
 * Render one event frame's worth of state.
 *
 * `StrictMode` because the hook arms a timer in an effect, and a mount effect
 * runs twice under it — a timer that is not cleaned up leaks a second release
 * that fires half a press later.
 */
function frame(state: PlaybackState | null) {
  act(() => {
    root!.render(createElement(StrictMode, null, createElement(Probe, { state })));
  });
}

/** Press the button: the card holds first, then sends the request. */
function hold() {
  act(() => confirm!.hold());
}

beforeEach(() => {
  confirm = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root!.unmount());
  container!.remove();
  root = null;
  container = null;
  mock.timers.reset();
});

// ---------------------------------------------------------------------------

describe("useTransportConfirm", () => {
  it("is idle until something is pressed", () => {
    frame("PLAYING");
    assert.equal(confirm!.awaiting, false);
  });

  it("waits from the moment of the press", () => {
    frame("PLAYING");
    hold();
    assert.equal(confirm!.awaiting, true);
  });

  it("keeps waiting while frames still report the old state", () => {
    // The whole point. Frames arrive every two seconds, and the first one or
    // two after a press predate it — re-enabling the button on those is
    // exactly the double-press this hook exists to prevent.
    frame("PLAYING");
    hold();
    frame("PLAYING");
    frame("PLAYING");
    assert.equal(confirm!.awaiting, true);
  });

  it("releases on the frame that confirms the command", () => {
    frame("PLAYING");
    hold();
    frame("PAUSED_PLAYBACK");
    assert.equal(confirm!.awaiting, false);
  });

  it("releases when the speaker does something else entirely", () => {
    // Stopped from the Sonos app, or the station ran out, while our pause was
    // in flight. The button now describes a different speaker state and there
    // is nothing left to wait for.
    frame("PLAYING");
    hold();
    frame("STOPPED");
    assert.equal(confirm!.awaiting, false);
  });

  it("gives the button straight back when the request is refused", () => {
    // No frame is coming: the speaker was never told anything.
    frame("PLAYING");
    hold();
    act(() => confirm!.release());
    assert.equal(confirm!.awaiting, false);
  });

  it("gives up rather than waiting on a stream that stopped arriving", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    frame("PLAYING");
    hold();
    act(() => mock.timers.tick(CONFIRM_TIMEOUT_MS - 1));
    assert.equal(confirm!.awaiting, true, "released before the window was up");
    act(() => mock.timers.tick(1));
    assert.equal(confirm!.awaiting, false);
  });

  it("measures the window from the press, not from the last frame", () => {
    // Frames land every two seconds. Re-arming the timer on each one would
    // make the window unreachable and the button dead for good.
    mock.timers.enable({ apis: ["setTimeout"] });
    frame("PLAYING");
    hold();
    act(() => mock.timers.tick(CONFIRM_TIMEOUT_MS / 2));
    frame("PLAYING");
    act(() => mock.timers.tick(CONFIRM_TIMEOUT_MS / 2));
    assert.equal(confirm!.awaiting, false);
  });

  it("stays released when the speaker wanders back on its own", () => {
    // Pause, confirmed — and then somebody hits play on the Sonos app. The
    // frame reports PLAYING again, which is the state the finished wait was
    // watching for. Nothing was pressed here, so nothing may be disabled.
    frame("PLAYING");
    hold();
    frame("PAUSED_PLAYBACK");
    frame("PLAYING");
    assert.equal(confirm!.awaiting, false);
  });

  it("arms the next press from wherever the speaker now is", () => {
    // Pause, confirmed, then Play. The second wait must compare against
    // PAUSED_PLAYBACK — held against the first press's PLAYING it would
    // release immediately and re-open the button before anything resumed.
    frame("PLAYING");
    hold();
    frame("PAUSED_PLAYBACK");
    hold();
    frame("PAUSED_PLAYBACK");
    assert.equal(confirm!.awaiting, true);
    frame("PLAYING");
    assert.equal(confirm!.awaiting, false);
  });
});
