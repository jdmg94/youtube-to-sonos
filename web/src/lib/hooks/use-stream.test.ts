/**
 * `useStream` sequences the two slow calls in this app. Its failures are all of
 * the kind that only appear when a human is faster than the network: casting
 * the URL that is in the box rather than the one that was analyzed, both Play
 * buttons firing into a queue one of them is about to clear, a failed analysis
 * leaving the panel describing one song and the buttons pointing at another.
 *
 * Rendered inside `StrictMode`, which double-invokes effects and state
 * updaters — the shape that would expose a double-fired action or an impure
 * updater smuggled into the persisted state.
 *
 * No JSX: this file is `.ts` so Node can strip its types with no transform.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ApiError, api } from "@/lib/api/client";
import type { PlayRequest, PlayResponse, VideoInfo } from "@/lib/api/types";
import { useStream, type StreamController } from "@/lib/hooks/use-stream";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let stream: StreamController;

/** Every URL passed to `/api/info`, in order. */
let lookups: string[] = [];
/** Every body sent to `/api/play`, in order. */
let plays: PlayRequest[] = [];

/** Pending `/api/info` calls, settled by the test so it controls the timing. */
let pendingInfo: { resolve: (info: VideoInfo) => void; reject: (error: Error) => void }[] = [];
/** Pending `/api/play` calls. */
let pendingPlay: { resolve: (result: PlayResponse) => void; reject: (error: Error) => void }[] = [];

function videoInfo(overrides: Partial<VideoInfo> = {}): VideoInfo {
  return {
    id: "abc",
    title: "Rocket Man",
    uploader: "Elton John",
    thumbnail: null,
    duration: 281,
    ...overrides,
  };
}

function playResponse(): PlayResponse {
  return {
    status: "playing",
    device: "Lounge",
    device_ip: "192.168.0.181",
    stream_url: "http://192.168.0.191:5001/media/abc.mp3",
    autoplay: true,
    video_id: "abc",
    title: "Rocket Man",
    started: true,
    queued_next: false,
  };
}

function stubApi() {
  mock.method(api, "info", (url: string) => {
    lookups.push(url);
    return new Promise<VideoInfo>((resolve, reject) => {
      pendingInfo.push({ resolve, reject });
    });
  });

  mock.method(api, "play", (body: PlayRequest) => {
    plays.push(body);
    return new Promise<PlayResponse>((resolve, reject) => {
      pendingPlay.push({ resolve, reject });
    });
  });
}

/** Let every in-flight lookup succeed, and flush the resulting renders. */
async function settleInfo(info: VideoInfo = videoInfo()) {
  const waiting = pendingInfo;
  pendingInfo = [];
  for (const call of waiting) call.resolve(info);
  await flush();
}

async function failInfo(message = "Video unavailable") {
  const waiting = pendingInfo;
  pendingInfo = [];
  for (const call of waiting) call.reject(new ApiError(message, 400));
  await flush();
}

async function settlePlay(result: PlayResponse = playResponse()) {
  const waiting = pendingPlay;
  pendingPlay = [];
  for (const call of waiting) call.resolve(result);
  await flush();
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function Probe({ ip }: { ip: string | undefined }) {
  stream = useStream(ip);
  return null;
}

function render(ip: string | undefined = "192.168.0.181") {
  act(() => {
    root!.render(createElement(StrictMode, null, createElement(Probe, { ip })));
  });
}

/** Type a URL into the box. */
function type(url: string) {
  act(() => stream.setUrl(url));
}

beforeEach(() => {
  lookups = [];
  plays = [];
  pendingInfo = [];
  pendingPlay = [];
  localStorage.clear();
  stubApi();
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

describe("useStream — analyzing", () => {
  it("does nothing with an empty box", () => {
    render();
    assert.equal(stream.canAnalyze, false);
    act(() => stream.analyze());
    assert.deepEqual(lookups, []);
  });

  it("treats whitespace as empty", () => {
    // Otherwise Enter on a box that looks blank spends a yt-dlp round trip
    // failing.
    render();
    type("   ");
    assert.equal(stream.canAnalyze, false);
    act(() => stream.analyze());
    assert.deepEqual(lookups, []);
  });

  it("trims the URL it sends", () => {
    // Pasting from a chat app routinely brings a trailing space with it.
    render();
    type("  https://youtu.be/abc  ");
    assert.equal(stream.canAnalyze, true);
    act(() => stream.analyze());
    assert.deepEqual(lookups, ["https://youtu.be/abc"]);
  });

  it("looks the URL up once, not twice under StrictMode", async () => {
    render();
    type("https://youtu.be/abc");
    act(() => stream.analyze());
    assert.equal(lookups.length, 1);
    await settleInfo();
    assert.equal(lookups.length, 1);
  });

  it("reports itself busy while the lookup is in flight", async () => {
    render();
    type("https://youtu.be/abc");
    assert.equal(stream.analyzing, false);
    act(() => stream.analyze());
    assert.equal(stream.analyzing, true);
    assert.equal(stream.canAnalyze, false, "a second press must not queue a second lookup");
    await settleInfo();
    assert.equal(stream.analyzing, false);
  });

  it("refuses a second lookup while one is running", async () => {
    render();
    type("https://youtu.be/abc");
    act(() => stream.analyze());
    act(() => stream.analyze());
    assert.deepEqual(lookups, ["https://youtu.be/abc"]);
    await settleInfo();
  });

  it("refuses a second lookup fired in the same tick as the first", async () => {
    // Both presses read one render's worth of state, so `analyzing` is still
    // `false` for the second. Held Enter and double-taps land exactly here,
    // and each extra lookup is another yt-dlp round trip.
    render();
    type("https://youtu.be/abc");
    act(() => {
      stream.analyze();
      stream.analyze();
    });
    assert.deepEqual(lookups, ["https://youtu.be/abc"]);
    await settleInfo();
  });

  it("publishes the analyzed video only once the lookup succeeds", async () => {
    render();
    type("https://youtu.be/abc");
    act(() => stream.analyze());
    assert.equal(stream.analyzed, null, "nothing to play until we know what it is");
    await settleInfo();
    assert.deepEqual(stream.analyzed, {
      url: "https://youtu.be/abc",
      info: videoInfo(),
    });
  });

  it("keeps the previous video when a lookup fails", async () => {
    // The panel and the Play buttons are one value, so the panel can stay up
    // through a failure without the buttons pointing somewhere else.
    render();
    type("https://youtu.be/abc");
    act(() => stream.analyze());
    await settleInfo();

    type("https://youtu.be/typo");
    act(() => stream.analyze());
    await failInfo();

    assert.equal(stream.analyzed?.url, "https://youtu.be/abc");
    assert.equal(stream.analyzeError?.message, "Video unavailable");
  });

  it("stores the trimmed URL, not the raw one", async () => {
    // The pair is what the Play buttons send. Trimming only the lookup leaves
    // the cast posting `"  https://youtu.be/abc  "`, which analyzed fine and
    // then fails at the speaker.
    render();
    type("  https://youtu.be/abc  ");
    act(() => stream.analyze());
    await settleInfo();
    assert.equal(stream.analyzed?.url, "https://youtu.be/abc");
  });

  it("leaves the box alone after a lookup, so a typo can be corrected", async () => {
    render();
    type("https://youtu.be/abc");
    act(() => stream.analyze());
    await settleInfo();
    assert.equal(stream.url, "https://youtu.be/abc");
  });

  it("remembers the analyzed video across a remount", async () => {
    render();
    type("https://youtu.be/abc");
    act(() => stream.analyze());
    await settleInfo();

    act(() => root!.unmount());
    root = createRoot(container!);
    render();

    assert.deepEqual(stream.analyzed, { url: "https://youtu.be/abc", info: videoInfo() });
    assert.equal(stream.url, "", "the box is for the next URL, not the last one");
  });
});

describe("useStream — casting", () => {
  /** Analyze `url` and settle it, leaving the hook ready to cast. */
  async function analyzed(url = "https://youtu.be/abc", info?: VideoInfo) {
    type(url);
    act(() => stream.analyze());
    await settleInfo(info);
  }

  it("does nothing without an analyzed video", async () => {
    render();
    let result: PlayResponse | undefined = playResponse();
    await act(async () => {
      result = await stream.cast("now");
    });
    assert.deepEqual(plays, []);
    assert.equal(result, undefined);
    // Silence, not a failure. Without the guard the missing video is a
    // TypeError inside the action, which surfaces as an error toast blaming
    // the speaker for a button the user could not have pressed.
    assert.equal(stream.castError, null);
  });

  it("sends the analyzed URL, not whatever is in the box", async () => {
    // The whole reason the pair is stored. Type a new URL without pressing
    // Analyze and the panel still describes the old one — so that is what the
    // button under the panel has to play.
    render();
    await analyzed("https://youtu.be/abc");
    type("https://youtu.be/different");

    act(() => void stream.cast("now"));
    assert.equal(plays.length, 1);
    assert.equal(plays[0].url, "https://youtu.be/abc");
    await settlePlay();
  });

  it("sends the mode the button asked for", async () => {
    render();
    await analyzed();
    act(() => void stream.cast("next"));
    assert.equal(plays[0].mode, "next");
    await settlePlay();

    act(() => void stream.cast("now"));
    assert.equal(plays[1].mode, "now");
    await settlePlay();
  });

  it("sends the selected speaker", async () => {
    render("192.168.0.99");
    await analyzed();
    act(() => void stream.cast("now"));
    assert.equal(plays[0].device_ip, "192.168.0.99");
    await settlePlay();
  });

  it("sends the current autoplay setting, not the one from mount", async () => {
    // The toggle is read through the action's ref. Frozen at mount, turning
    // autoplay off would silently keep building stations.
    render();
    await analyzed();
    assert.equal(stream.autoplay, true, "autoplay is on by default");

    act(() => stream.setAutoplay(false));
    await flush();
    act(() => void stream.cast("now"));
    assert.equal(plays[0].autoplay, false);
    await settlePlay();
  });

  it("remembers the autoplay setting across a remount", async () => {
    render();
    act(() => stream.setAutoplay(false));

    act(() => root!.unmount());
    root = createRoot(container!);
    render();

    assert.equal(stream.autoplay, false);
  });

  it("reports which button is busy, so only that one spins", async () => {
    render();
    await analyzed();
    assert.equal(stream.casting, null);

    act(() => void stream.cast("next"));
    assert.equal(stream.casting, "next");
    await settlePlay();
    assert.equal(stream.casting, null);
  });

  it("refuses a second cast while one is in flight", async () => {
    // "Play now" clears the queue and rebuilds it. A "Play next" landing
    // mid-flight inserts into a queue that is about to be discarded.
    render();
    await analyzed();
    act(() => void stream.cast("now"));
    act(() => void stream.cast("next"));
    assert.equal(plays.length, 1);
    assert.equal(plays[0].mode, "now");
    await settlePlay();
  });

  it("refuses a second cast fired in the same tick as the first", async () => {
    // The buttons disable themselves, but not until React has re-rendered
    // them. Two presses in one tick both see an idle hook, and this pair in
    // particular rebuilds the station around a track it then discards.
    render();
    await analyzed();
    act(() => {
      void stream.cast("now");
      void stream.cast("next");
    });
    assert.equal(plays.length, 1);
    assert.equal(plays[0].mode, "now");
    await settlePlay();
  });

  it("keeps the spinner on the button that started the cast", async () => {
    // The refused press must not move `casting` onto itself, or "Play next"
    // spins while "Play now" is the request actually in flight.
    render();
    await analyzed();
    act(() => {
      void stream.cast("now");
      void stream.cast("next");
    });
    assert.equal(stream.casting, "now");
    await settlePlay();
  });

  it("allows a second cast once the first has landed", async () => {
    // The latch has to release, or the buttons are dead for the session.
    render();
    await analyzed();
    act(() => void stream.cast("now"));
    await settlePlay();
    act(() => void stream.cast("next"));
    assert.equal(plays.length, 2);
    await settlePlay();
  });

  it("clears the box once the track is away", async () => {
    render();
    await analyzed("https://youtu.be/abc");
    assert.equal(stream.url, "https://youtu.be/abc");

    act(() => void stream.cast("now"));
    assert.equal(stream.url, "https://youtu.be/abc", "not before the server has it");
    await settlePlay();
    assert.equal(stream.url, "");
  });

  it("keeps the analyzed video on screen after casting it", async () => {
    // The box empties; the panel does not. What is playing stays visible.
    render();
    await analyzed("https://youtu.be/abc");
    act(() => void stream.cast("now"));
    await settlePlay();
    assert.equal(stream.analyzed?.url, "https://youtu.be/abc");
  });

  it("hands the response back so the caller can tell the user what happened", async () => {
    render();
    await analyzed();
    let result: PlayResponse | undefined;
    await act(async () => {
      const promise = stream.cast("now");
      await flush();
      await settlePlay();
      result = await promise;
    });
    assert.equal(result?.device, "Lounge");
  });
});
