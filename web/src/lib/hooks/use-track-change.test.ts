/**
 * `useTrackChange` decides when the app interrupts the user with "Now playing:
 * …". Getting it wrong is not a subtle bug: too eager and every reconnect,
 * every pause and every tab focus throws a toast at someone who is listening to
 * music; too shy and the one moment worth announcing — the station moving on by
 * itself, with nobody touching the app — passes silently.
 *
 * No JSX: this file is `.ts` so Node can strip its types with no transform.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useTrackChange } from "@/lib/hooks/use-track-change";
import type { NowPlayingMode } from "@/lib/now-playing";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/** Every title the hook asked to announce, in order. */
let announced: string[] = [];

function Probe({ mode, title }: { mode: NowPlayingMode; title: string }) {
  useTrackChange(mode, title, (announcedTitle) => announced.push(announcedTitle));
  return null;
}

/**
 * Render one frame's worth of state.
 *
 * `StrictMode` is not decoration here. It double-invokes effects on mount, and
 * a hook that remembers across renders through a ref is exactly the shape that
 * announces twice under it — which is what the user would see in development
 * and, after any future remount, in production too.
 */
function frame(mode: NowPlayingMode, title: string) {
  act(() => {
    root!.render(createElement(StrictMode, null, createElement(Probe, { mode, title })));
  });
}

beforeEach(() => {
  announced = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root!.unmount());
  container!.remove();
  root = null;
  container = null;
});

// ---------------------------------------------------------------------------

describe("useTrackChange", () => {
  it("says nothing about the track that was already playing", () => {
    // The page was opened, or reconnected, on a song already in progress. The
    // user is looking at the card; announcing it tells them nothing.
    frame("playing", "Rocket Man");
    assert.deepEqual(announced, []);
  });

  it("announces the station moving on by itself", () => {
    frame("playing", "Rocket Man");
    frame("playing", "Tiny Dancer");
    assert.deepEqual(announced, ["Tiny Dancer"]);
  });

  it("announces once per track, not once per frame", () => {
    // Frames arrive every two seconds carrying an unchanged title whenever any
    // other field moves — the elapsed position, a cache state in the station.
    frame("playing", "Rocket Man");
    frame("playing", "Tiny Dancer");
    frame("playing", "Tiny Dancer");
    frame("playing", "Tiny Dancer");
    assert.deepEqual(announced, ["Tiny Dancer"]);
  });

  it("says nothing when the listener pauses and resumes", () => {
    // They pressed pause. They know what is loaded.
    frame("playing", "Rocket Man");
    frame("paused", "Rocket Man");
    frame("playing", "Rocket Man");
    assert.deepEqual(announced, []);
  });

  it("announces a track that changed while paused, once it plays", () => {
    // Queueing something and pressing play on the Sonos app. The pause frames
    // are ignored, so the change is noticed when playback resumes.
    frame("playing", "Rocket Man");
    frame("paused", "Rocket Man");
    frame("paused", "Tiny Dancer");
    assert.deepEqual(announced, [], "a paused speaker is not playing anything yet");
    frame("playing", "Tiny Dancer");
    assert.deepEqual(announced, ["Tiny Dancer"]);
  });

  it("forgets across a stop, so the next song is a beginning", () => {
    // The user pressed Stop and then played something new. They chose it; the
    // card already shows it. Announcing it is noise.
    frame("playing", "Rocket Man");
    frame("idle", "—");
    frame("playing", "Tiny Dancer");
    assert.deepEqual(announced, []);
  });

  it("announces again after the first track of a new session", () => {
    // The reset must forget the old title, not disable the hook.
    frame("playing", "Rocket Man");
    frame("idle", "—");
    frame("playing", "Tiny Dancer");
    frame("playing", "Your Song");
    assert.deepEqual(announced, ["Your Song"]);
  });

  it("does not announce the idle placeholder itself", () => {
    frame("playing", "Rocket Man");
    frame("idle", "—");
    assert.deepEqual(announced, []);
  });

  it("announces a return to the same track after a stop", () => {
    // Replaying the song you just stopped is a deliberate act, and the reset
    // means it is treated as a first track — silently.
    frame("playing", "Rocket Man");
    frame("idle", "—");
    frame("playing", "Rocket Man");
    assert.deepEqual(announced, []);
  });

  it("uses the latest callback, not the one from the first render", () => {
    // The callback is an inline arrow closing over component state. Read
    // through a stale ref, this hook would toast with values from whenever the
    // song before last started.
    const sink: string[] = [];
    function Late({ title, into }: { title: string; into: string[] }) {
      useTrackChange("playing", title, (announcedTitle) => into.push(announcedTitle));
      return null;
    }
    act(() => root!.render(createElement(Late, { title: "Rocket Man", into: sink })));
    const replacement: string[] = [];
    act(() => root!.render(createElement(Late, { title: "Tiny Dancer", into: replacement })));
    assert.deepEqual(replacement, ["Tiny Dancer"]);
    assert.deepEqual(sink, []);
  });
});
