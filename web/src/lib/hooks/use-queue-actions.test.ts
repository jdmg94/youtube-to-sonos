/**
 * `useQueueActions` is the only place in the app that lets the client's list
 * disagree with the server's, and every bug it can have is silent. The row
 * vanishes on click, so a removal that is sent with the wrong index does not
 * look like a failure — it looks like the queue quietly losing a different
 * song. Same for a jump: the wrong index plays the wrong track and nothing
 * anywhere says so.
 *
 * The tests below are therefore mostly about *what index went on the wire*
 * while the panel and the server disagreed, and about the two things that keep
 * that answer right: writes leave one at a time, and an index is worked out at
 * dispatch rather than at click.
 *
 * No JSX: this file is `.ts` so Node can strip its types with no transform.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ApiError, api } from "@/lib/api/client";
import type {
  StationBody,
  StationRemoveRequest,
  StationRemoveResponse,
  StationTrack,
  TransportRequest,
  TransportResponse,
} from "@/lib/api/types";
import { useQueueActions, type QueueActions } from "@/lib/hooks/use-queue-actions";

const DEVICE = "10.0.0.1";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let actions: QueueActions;

/** Every removal the hook sent, in the order it sent them. */
let removals: StationRemoveRequest[] = [];
/** Every transport call the hook sent. */
let jumps: TransportRequest[] = [];

/** Removals the hook has started and the test has not answered yet. */
let openRemovals: { resolve: () => void; reject: () => void }[] = [];
/** Jumps the hook has started and the test has not answered yet. */
let openJumps: { resolve: () => void }[] = [];

function track(id: string, overrides: Partial<StationTrack> = {}): StationTrack {
  return {
    id,
    title: id.toUpperCase(),
    uploader: "Elton John",
    thumbnail: null,
    duration: 281,
    cached: "done",
    queue_pos: 1,
    ...overrides,
  };
}

function station(ids: string[], index = 0): StationBody {
  return { index, exhausted: false, tracks: ids.map((id) => track(id)) };
}

function Probe({ list, deviceIp }: { list: StationBody | null; deviceIp?: string }) {
  actions = useQueueActions(list, deviceIp);
  return null;
}

/** Render one frame's worth of state. */
function frame(list: StationBody | null, deviceIp: string | undefined = DEVICE) {
  act(() => {
    root!.render(createElement(Probe, { list, deviceIp }));
  });
}

/** Let queued promise callbacks run and flush whatever they rendered. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

/** The ids the panel would draw, in order. */
function visible(): string[] {
  return actions.station?.tracks.map((t) => t.id) ?? [];
}

/** Let the next queued write reach the wire, then answer it successfully. */
async function settleRemovals() {
  await settle();
  const pending = openRemovals;
  openRemovals = [];
  for (const call of pending) call.resolve();
  await settle();
}

/** Let the next queued removal reach the wire, then refuse it with a 409. */
async function refuseRemoval() {
  await settle();
  const call = openRemovals.pop()!;
  await act(async () => {
    call.reject();
    await Promise.resolve();
  });
}

beforeEach(() => {
  removals = [];
  jumps = [];
  openRemovals = [];
  openJumps = [];

  mock.method(api, "removeTrack", (body: StationRemoveRequest) => {
    removals.push(body);
    return new Promise<StationRemoveResponse>((resolve, reject) => {
      openRemovals.push({
        resolve: () =>
          resolve({
            status: "removed",
            removed: body.id,
            title: body.id.toUpperCase(),
            device: "Kitchen",
            device_ip: DEVICE,
            index: 0,
            exhausted: false,
            tracks: [],
          }),
        reject: () => reject(new ApiError("index no longer names that track", 409)),
      });
    });
  });
  mock.method(api, "transport", (body: TransportRequest) => {
    jumps.push(body);
    return new Promise<TransportResponse>((resolve) => {
      openJumps.push({
        resolve: () => resolve({ status: "ok", action: body.action, device: "Kitchen" }),
      });
    });
  });

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root!.unmount());
  container!.remove();
  root = null;
  container = null;
  mock.restoreAll();
});

// ---------------------------------------------------------------------------

describe("useQueueActions", () => {
  it("passes the frame straight through when nothing has been touched", () => {
    const list = station(["a", "b", "c"]);
    frame(list);
    assert.equal(actions.station, list);
  });

  it("drops the row before the server has answered", async () => {
    frame(station(["a", "b", "c"]));
    act(() => actions.remove("b"));
    // The whole point: no await, no spinner, no waiting for a frame.
    assert.deepEqual(visible(), ["a", "c"]);
    await settleRemovals();
  });

  it("takes a second removal while the first is still in flight", async () => {
    frame(station(["a", "b", "c", "d"]));
    act(() => actions.remove("b"));
    act(() => actions.remove("d"));
    assert.deepEqual(visible(), ["a", "c"], "both gone from the list at once");
    // But only one request on the wire: the second's index depends on whether
    // the first landed.
    await settle();
    assert.equal(removals.length, 1);
    await settleRemovals();
    assert.equal(removals.length, 2);
  });

  it("sends the second removal at the index the first one left behind", async () => {
    // The bug this hook exists to avoid. `d` is index 3 in the frame; once `b`
    // is gone the server calls it 2, and the frame saying so is seconds away.
    frame(station(["a", "b", "c", "d"]));
    act(() => actions.remove("b"));
    act(() => actions.remove("d"));
    await settle();
    assert.deepEqual(removals[0], { device_ip: DEVICE, index: 1, id: "b" });
    await settleRemovals();
    assert.deepEqual(removals[1], { device_ip: DEVICE, index: 2, id: "d" });
    await settleRemovals();
  });

  it("keeps counting from the last frame, however stale, until it catches up", async () => {
    // Three removals against a frame that never updates. Each index is the
    // one the server has after the previous removal, not the one on screen.
    frame(station(["a", "b", "c", "d", "e"]));
    act(() => actions.remove("c"));
    act(() => actions.remove("d"));
    act(() => actions.remove("e"));
    await settle();
    await settleRemovals();
    await settleRemovals();
    await settleRemovals();
    assert.deepEqual(
      removals.map((r) => r.index),
      [2, 2, 2],
    );
  });

  it("stops subtracting a removal once the frame confirms it", async () => {
    frame(station(["a", "b", "c", "d"]));
    act(() => actions.remove("b"));
    await settleRemovals();
    // The server has caught up. `d` is index 2 in this frame and index 2 to
    // the server; subtracting `b` again would send 1 and delete `c`.
    frame(station(["a", "c", "d"]));
    act(() => actions.remove("d"));
    await settle();
    assert.deepEqual(removals[1], { device_ip: DEVICE, index: 2, id: "d" });
    await settleRemovals();
  });

  it("puts the row back when the server refuses", async () => {
    frame(station(["a", "b", "c"]));
    act(() => actions.remove("b"));
    assert.deepEqual(visible(), ["a", "c"]);
    await refuseRemoval();
    assert.deepEqual(visible(), ["a", "b", "c"], "back where it was, in order");
    assert.equal(actions.error?.status, 409);
  });

  it("does not count a refused removal against the next one's index", async () => {
    // A rollback that left `b` in the subtracted set would send `d` as 2 and
    // the server would delete `c`.
    frame(station(["a", "b", "c", "d"]));
    act(() => actions.remove("b"));
    await refuseRemoval();

    act(() => actions.remove("d"));
    await settle();
    assert.deepEqual(removals[1], { device_ip: DEVICE, index: 3, id: "d" });
    await settleRemovals();
  });

  it("says nothing when the track it was told to drop has already gone", async () => {
    // A refresh, or the station rebuilding, took it first. The listener asked
    // for it to be gone and it is gone; an error would be a lie.
    frame(station(["a", "b", "c"]));
    act(() => actions.remove("c"));
    frame(station(["a", "b"]));
    await settle();
    assert.deepEqual(removals, []);
    assert.equal(actions.error, null);
  });

  it("puts the row back and explains when the speaker reached it first", async () => {
    // Clicked the X on the next track; the song ended before the request went
    // out. It is the playing track now and must be on screen again.
    frame(station(["a", "b", "c"], 0));
    act(() => actions.remove("b"));
    assert.deepEqual(visible(), ["a", "c"]);
    frame(station(["a", "b", "c"], 1));
    await settle();
    assert.deepEqual(removals, [], "never sent — the server would refuse it too");
    assert.deepEqual(visible(), ["a", "b", "c"]);
    assert.equal(actions.error?.message, "That track is already playing");
  });

  it("forgets everything when the speaker changes", async () => {
    frame(station(["a", "b", "c"]));
    act(() => actions.remove("b"));
    await settleRemovals();
    frame(null, undefined);
    frame(station(["a", "b", "c"]), "10.0.0.9");
    assert.deepEqual(visible(), ["a", "b", "c"]);
  });

  // -------------------------------------------------------------------------

  it("jumps by the index the server has, not the one on screen", async () => {
    // The other half of the same bug. With `b` dropped but not yet confirmed,
    // `d` is row 2 on screen and still index 3 to the server.
    frame(station(["a", "b", "c", "d"]));
    act(() => actions.remove("b"));
    act(() => actions.jump("d"));
    await settle();
    assert.deepEqual(jumps, [], "queued behind the removal, which moves it");
    await settleRemovals();
    assert.deepEqual(jumps[0], { device_ip: DEVICE, action: "jump", index: 2 });
  });

  it("jumps immediately when nothing is pending", async () => {
    frame(station(["a", "b", "c"]));
    act(() => actions.jump("c"));
    await settle();
    assert.deepEqual(jumps[0], { device_ip: DEVICE, action: "jump", index: 2 });
  });

  it("refuses to jump to a track that is still downloading, and says why", async () => {
    const list = station(["a", "b"]);
    list.tracks[1] = track("b", { cached: "running", queue_pos: null });
    frame(list);
    act(() => actions.jump("b"));
    await settle();
    assert.deepEqual(jumps, []);
    assert.equal(actions.error?.message, "That track is still downloading");
  });

  it("reports a jump as pending until it settles", async () => {
    frame(station(["a", "b"]));
    act(() => actions.jump("b"));
    assert.equal(actions.jumpPending, true);
    await settle();
    await act(async () => {
      openJumps.pop()!.resolve();
      await Promise.resolve();
    });
    assert.equal(actions.jumpPending, false);
  });

  it("clears the pending flag when a jump is refused before it is sent", async () => {
    // Nothing was sent, so nothing will settle it. A stuck flag disables every
    // row's jump for the rest of the session.
    frame(station(["a", "b"]));
    act(() => actions.jump("nope"));
    await settle();
    assert.equal(actions.jumpPending, false);
  });
});
