/**
 * `useEvents` is the only real state machine in the data layer, and every one
 * of its interesting paths — a dropped connection, a speaker switch, an error
 * frame, teardown — is either hard to provoke against a live speaker or silent
 * when it breaks. So it gets a fake `EventSource` to be driven through
 * deterministically.
 *
 * The wire itself is not tested here. `npm run check:contract` does that
 * against the real backend, including the compression trap.
 *
 * No JSX: this file is `.ts` so that Node can strip its types with no
 * transform step, which is what keeps the test toolchain to one dependency.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { EventFrame } from "@/lib/api/types";
import { RETRY_DELAYS_MS, useEvents, type EventsState } from "@/lib/hooks/use-events";

// ---------------------------------------------------------------------------
// A controllable EventSource
// ---------------------------------------------------------------------------

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  readonly url: string;

  // Written out rather than as a constructor parameter property: Node strips
  // types, it does not compile them, and a parameter property is the one bit
  // of TypeScript that emits code rather than erasing.
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  /** Pretend the server sent a `data:` frame. */
  emit(payload: unknown) {
    act(() => {
      this.onmessage?.({ data: JSON.stringify(payload) });
    });
  }

  /** Pretend the server sent something unparseable. */
  emitRaw(data: string) {
    act(() => {
      this.onmessage?.({ data });
    });
  }

  /** Pretend the connection dropped. */
  fail() {
    act(() => {
      this.onerror?.();
    });
  }

  static get latest(): FakeEventSource {
    const last = FakeEventSource.instances.at(-1);
    assert.ok(last, "expected an EventSource to have been opened");
    return last;
  }
}

function frame(overrides: Partial<EventFrame> = {}): EventFrame {
  return {
    state: "PLAYING",
    title: "Song",
    artist: "Artist",
    album_art: "",
    duration: "0:03:00",
    position: "0:00:10",
    playlist_position: 1,
    station_index: 0,
    uri: "http://host/media/abc.mp3",
    is_radio: true,
    video_id: "abc",
    device: "Kitchen",
    device_ip: "10.0.0.1",
    station: { index: 0, exhausted: false, tracks: [] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let state: EventsState;

// ---------------------------------------------------------------------------
// Retry-timer tracking
//
// "No reconnect happens after unmount" is guaranteed twice over — by the
// `cancelled` flag *and* by clearing the timer — so asserting on the outcome
// alone passes even with the `clearTimeout` deleted, which leaves a timer
// holding the closure alive for up to 20s. Watching the timers directly is
// the only way to assert the cleanup rather than its understudy.
//
// Only delays that match the backoff schedule are tracked, so React's own
// scheduling stays out of it.
// ---------------------------------------------------------------------------

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let pendingRetries = new Set<unknown>();

function watchRetryTimers() {
  pendingRetries = new Set();
  globalThis.setTimeout = ((fn: () => void, delay?: number, ...rest: unknown[]) => {
    const id = realSetTimeout(fn, delay, ...rest);
    if (typeof delay === "number" && RETRY_DELAYS_MS.includes(delay)) pendingRetries.add(id);
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: unknown) => {
    pendingRetries.delete(id);
    return realClearTimeout(id as Parameters<typeof clearTimeout>[0]);
  }) as unknown as typeof clearTimeout;
}

function restoreTimers() {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}

function Probe({ ip }: { ip: string | null }) {
  state = useEvents(ip);
  return null;
}

function render(ip: string | null) {
  act(() => {
    root!.render(createElement(Probe, { ip }));
  });
}

beforeEach(() => {
  FakeEventSource.instances = [];
  (globalThis as Record<string, unknown>).EventSource = FakeEventSource;
  watchRetryTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root!.unmount());
  restoreTimers();
  container!.remove();
  root = null;
  container = null;
});

// ---------------------------------------------------------------------------

describe("useEvents", () => {
  it("opens nothing until a speaker is chosen", () => {
    render(null);
    assert.equal(FakeEventSource.instances.length, 0);
    assert.equal(state.status, "idle");
  });

  it("reports connecting before the first frame", () => {
    render("10.0.0.1");
    assert.equal(FakeEventSource.instances.length, 1);
    assert.match(FakeEventSource.latest.url, /device_ip=10\.0\.0\.1/);
    assert.equal(state.status, "connecting");
    assert.equal(state.nowPlaying, null);
  });

  it("publishes a frame's now-playing and station separately", () => {
    render("10.0.0.1");
    FakeEventSource.latest.emit(
      frame({ title: "Sabotage", station: { index: 2, exhausted: false, tracks: [] } }),
    );
    assert.equal(state.status, "live");
    assert.equal(state.nowPlaying?.title, "Sabotage");
    assert.equal(state.station?.index, 2);
    assert.equal(state.error, null);
  });

  it("ignores an unparseable frame without disturbing the last good one", () => {
    render("10.0.0.1");
    FakeEventSource.latest.emit(frame({ title: "Sabotage" }));
    FakeEventSource.latest.emitRaw("{not json");
    assert.equal(state.status, "live");
    assert.equal(state.nowPlaying?.title, "Sabotage");
  });

  it("treats an error frame as non-fatal and keeps the last known state", () => {
    render("10.0.0.1");
    FakeEventSource.latest.emit(frame({ title: "Sabotage" }));
    FakeEventSource.latest.emit({ error: "speaker did not respond" });

    // Still live, still showing the track: a failed poll is usually a blip,
    // and blanking the card on one would make it flicker.
    assert.equal(state.status, "live");
    assert.equal(state.error, "speaker did not respond");
    assert.equal(state.nowPlaying?.title, "Sabotage");
    assert.equal(FakeEventSource.latest.closed, false);
  });

  it("clears the error once a good frame arrives", () => {
    render("10.0.0.1");
    FakeEventSource.latest.emit({ error: "transient" });
    assert.equal(state.error, "transient");
    FakeEventSource.latest.emit(frame());
    assert.equal(state.error, null);
  });

  it("never shows the previous speaker's track under the new speaker", () => {
    render("10.0.0.1");
    FakeEventSource.latest.emit(frame({ title: "Sabotage" }));
    assert.equal(state.nowPlaying?.title, "Sabotage");

    const first = FakeEventSource.latest;
    render("10.0.0.2");

    // Synchronously, in the same commit as the prop change — not one frame
    // later via an effect, which would paint the wrong track.
    assert.equal(state.nowPlaying, null);
    assert.equal(state.station, null);
    assert.equal(state.error, null);
    assert.equal(state.status, "connecting");
    assert.equal(first.closed, true, "the old stream must be closed");
    assert.match(FakeEventSource.latest.url, /device_ip=10\.0\.0\.2/);
  });

  it("goes idle and closes the stream when the speaker is cleared", () => {
    render("10.0.0.1");
    const source = FakeEventSource.latest;
    FakeEventSource.latest.emit(frame());
    render(null);
    assert.equal(state.status, "idle");
    assert.equal(state.nowPlaying, null);
    assert.equal(source.closed, true);
  });

  it("closes the dropped stream itself rather than leaving it to retry", async () => {
    render("10.0.0.1");
    const first = FakeEventSource.latest;
    first.emit(frame({ title: "Sabotage" }));

    first.fail();
    assert.equal(first.closed, true, "a stream we are replacing must not also be retrying");
    assert.equal(state.status, "reconnecting");
    // The card keeps showing the last known track through a reconnect.
    assert.equal(state.nowPlaying?.title, "Sabotage");
    assert.equal(FakeEventSource.instances.length, 1, "reconnect must not be immediate");

    await sleep(RETRY_DELAYS_MS[0] + 250);
    assert.equal(FakeEventSource.instances.length, 2, "should have reconnected");
    assert.match(FakeEventSource.latest.url, /device_ip=10\.0\.0\.1/);
  });

  it("backs off further on a repeated failure", async () => {
    render("10.0.0.1");
    FakeEventSource.latest.fail();
    await sleep(RETRY_DELAYS_MS[0] + 250);
    assert.equal(FakeEventSource.instances.length, 2);

    // Second failure without an intervening good frame: the next attempt must
    // wait longer than the first, or a server that accepts and immediately
    // closes (no speakers found) becomes an SSDP scan every second.
    FakeEventSource.latest.fail();
    await sleep(RETRY_DELAYS_MS[0] + 250);
    assert.equal(
      FakeEventSource.instances.length,
      2,
      "second retry must not fire on the first delay",
    );
    await sleep(RETRY_DELAYS_MS[1] - RETRY_DELAYS_MS[0] + 250);
    assert.equal(FakeEventSource.instances.length, 3);
  });

  it("resets the backoff only after a real frame, not a mere connection", async () => {
    render("10.0.0.1");
    FakeEventSource.latest.fail();
    await sleep(RETRY_DELAYS_MS[0] + 250);
    // A good frame proves the stream actually works.
    FakeEventSource.latest.emit(frame());
    FakeEventSource.latest.fail();
    await sleep(RETRY_DELAYS_MS[0] + 250);
    assert.equal(FakeEventSource.instances.length, 3, "backoff should be back to the shortest");
  });

  it("opens no connection after unmount", async () => {
    render("10.0.0.1");
    FakeEventSource.latest.fail();
    assert.equal(state.status, "reconnecting");

    act(() => root!.unmount());
    root = createRoot(container!); // so afterEach has something to unmount

    await sleep(RETRY_DELAYS_MS[0] + 250);
    assert.equal(
      FakeEventSource.instances.length,
      1,
      "an unmounted hook must not open a connection",
    );
  });

  it("cancels the pending reconnect timer on unmount", () => {
    render("10.0.0.1");
    FakeEventSource.latest.fail();
    assert.equal(pendingRetries.size, 1, "a reconnect should be scheduled");

    act(() => root!.unmount());
    root = createRoot(container!);

    // Not merely "no reconnect happens" — the timer itself must be gone.
    // Otherwise it survives for up to 20s holding the effect's closure, and
    // in a long session that is one leak per speaker change.
    assert.equal(pendingRetries.size, 0, "the reconnect timer must be cleared, not just ignored");
  });

  it("cancels the pending reconnect timer when the speaker changes", () => {
    render("10.0.0.1");
    FakeEventSource.latest.fail();
    assert.equal(pendingRetries.size, 1);

    render("10.0.0.2");
    assert.equal(pendingRetries.size, 0, "a retry for the old speaker must not survive the switch");
  });

  it("has a monotonically increasing backoff schedule", () => {
    for (let i = 1; i < RETRY_DELAYS_MS.length; i += 1) {
      assert.ok(
        RETRY_DELAYS_MS[i] > RETRY_DELAYS_MS[i - 1],
        `delay ${i} must exceed delay ${i - 1}`,
      );
    }
  });
});
