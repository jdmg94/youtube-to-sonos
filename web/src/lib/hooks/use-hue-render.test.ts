/**
 * The render loop is the only code in this app that runs on a timer for its own
 * sake, and every way it can go wrong is silent: the lights simply stop, or
 * freeze, or lag further behind the music the longer the song runs. None of
 * that raises an error, and none of it is visible from the browser — you would
 * need a bridge, a song and a stopwatch. So the loop gets a fake network and is
 * driven through its decisions directly.
 *
 * The palette itself is not re-tested here; `hue.test.ts` owns that. What this
 * file asserts is the wiring: that a colour is sent at all, that an unchanged
 * one is not, that a slow bridge cannot accumulate requests behind it, and that
 * a dead stream is noticed rather than sent to forever.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { HueAnalysis, HueArea, NowPlaying, Rgb } from "@/lib/api/types";
import { IDLE_COLOR } from "@/lib/hue";
import {
  ANALYSIS_POLL_MS,
  MAX_CONSECUTIVE_FAILURES,
  SEND_INTERVAL_MS,
  useHueRender,
  type HueRenderState,
} from "@/lib/hooks/use-hue-render";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function nowPlaying(overrides: Partial<NowPlaying> = {}): NowPlaying {
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
    ...overrides,
  };
}

/**
 * Two beats a second, everything else flat.
 *
 * The flash is what makes the colour move fast enough to observe: its decay is
 * a fraction of the beat period, so consecutive 60ms ticks land visibly apart.
 * A realistic energy envelope would not — at 10 Hz it moves by well under
 * `COLOR_EPSILON` per tick, which is exactly the traffic `differsEnough` exists
 * to suppress and no use at all for watching the loop run.
 */
function analysis(overrides: Partial<HueAnalysis> = {}): HueAnalysis {
  return {
    version: 1,
    duration: 180,
    tempo: 120,
    frame_seconds: 0.1,
    beats: Array.from({ length: 360 }, (_, i) => i * 0.5),
    energy: Array.from({ length: 1800 }, () => 0.5),
    brightness: Array.from({ length: 1800 }, () => 0.5),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A controllable network
// ---------------------------------------------------------------------------

interface Reply {
  status: number;
  body: unknown;
}

const realFetch = globalThis.fetch;

/** What `/api/hue/analysis/<id>` answers next. */
let analysisReply: Reply = { status: 200, body: analysis() };
/** What `/api/hue/stream` answers next. Async so a send can be held open. */
let colorReply: () => Promise<Reply> = async () => ({ status: 200, body: { streaming: true } });

/** The `color` field of every `/api/hue/stream` body, in order. */
type Sent = Rgb | Record<string, Rgb>;

let analysisCalls = 0;
let colorCalls: Sent[] = [];

/** A sent frame as a comparable string, whichever shape it took. */
const shape = (sent: Sent) => JSON.stringify(sent);

/** Narrows to the per-channel shape, failing the test rather than the types. */
function channels(sent: Sent): Record<string, Rgb> {
  assert.ok(!Array.isArray(sent), `expected a channel map, got ${shape(sent)}`);
  return sent;
}

function respond({ status, body }: Reply): Response {
  return {
    ok: status < 400,
    status,
    statusText: "",
    json: async () => body,
  } as unknown as Response;
}

function fakeNetwork() {
  analysisCalls = 0;
  colorCalls = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/hue/analysis/")) {
      analysisCalls += 1;
      return respond(analysisReply);
    }
    if (url.includes("/api/hue/stream")) {
      const body = JSON.parse(String(init?.body)) as { action: string; color: Sent };
      colorCalls.push(body.color);
      return respond(await colorReply());
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Poll-timer tracking
//
// "It stops polling a 404" is guaranteed twice over — by resolving the track
// and by the effect teardown — so asserting on the call count alone passes even
// with the terminating branch removed, as long as the test does not run for a
// full poll interval. Watching the scheduled timers says what was *decided*,
// and says it in a millisecond rather than in three seconds.
// ---------------------------------------------------------------------------

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let pendingPolls = new Set<unknown>();

function watchPollTimers() {
  pendingPolls = new Set();
  globalThis.setTimeout = ((fn: () => void, delay?: number, ...rest: unknown[]) => {
    const id = realSetTimeout(fn, delay, ...rest);
    if (delay === ANALYSIS_POLL_MS) pendingPolls.add(id);
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: unknown) => {
    pendingPolls.delete(id);
    return realClearTimeout(id as Parameters<typeof clearTimeout>[0]);
  }) as unknown as typeof clearTimeout;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let state: HueRenderState;
let lost = 0;

/** An area with `count` lights and no positions — the realistic bridge answer. */
function area(count: number, positions: HueArea["positions"] = {}): HueArea {
  return {
    id: "area-1",
    name: "Living room",
    status: "active",
    channels: Array.from({ length: count }, (_, i) => i),
    positions,
  };
}

interface Props {
  nowPlaying?: NowPlaying | null;
  streaming?: boolean;
  preview?: boolean;
  area?: HueArea | null;
  settings?: Parameters<typeof useHueRender>[0]["settings"];
}

function Probe({
  nowPlaying: track = nowPlaying(),
  streaming = true,
  preview = false,
  area: room = null,
  settings,
}: Props) {
  state = useHueRender({
    nowPlaying: track,
    streaming,
    preview,
    area: room,
    settings,
    onStreamLost: () => {
      lost += 1;
    },
  });
  return null;
}

function render(props: Props = {}) {
  act(() => {
    root!.render(createElement(Probe, props));
  });
}

/**
 * Let real timers fire, with React's queue flushed *between* them.
 *
 * In slices, not one long sleep: `act` holds updates until its scope closes, so
 * a single `await act(() => sleep(400))` runs every interval tick before the
 * state change that resolves the analysis is ever committed — the loop would
 * spend the whole test with no renderer, which is not what a browser does with
 * a promise that settled in the first millisecond.
 */
async function advance(ms: number) {
  const step = 20;
  for (let left = ms; left > 0; left -= step) {
    const slice = Math.min(step, left);
    await act(async () => {
      await sleep(slice);
    });
  }
}

/** Long enough for `n` sends, with slack for scheduling jitter. */
const ticks = (n: number) => SEND_INTERVAL_MS * n + SEND_INTERVAL_MS / 2;

beforeEach(() => {
  analysisReply = { status: 200, body: analysis() };
  colorReply = async () => ({ status: 200, body: { streaming: true } });
  lost = 0;
  fakeNetwork();
  watchPollTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root!.unmount());
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  container!.remove();
  root = null;
  container = null;
});

// ---------------------------------------------------------------------------

describe("useHueRender: analysis", () => {
  it("asks for nothing until the stream is up", async () => {
    // A poll loop per track, for a feature nobody has switched on, is pure
    // cost — and on a station it would be one per song, forever.
    render({ streaming: false });
    await advance(ticks(3));
    assert.equal(analysisCalls, 0);
    assert.equal(colorCalls.length, 0);
    assert.equal(state.status, "idle");
  });

  it("reports idle when the speaker is playing something that isn't ours", async () => {
    render({ nowPlaying: nowPlaying({ video_id: null }) });
    await advance(ticks(2));
    assert.equal(analysisCalls, 0);
    assert.equal(state.status, "idle");
  });

  it("becomes ready once the features arrive", async () => {
    render();
    await advance(ticks(1));
    assert.equal(analysisCalls, 1);
    assert.equal(state.status, "ready");
  });

  it("keeps polling while the backend is still working", async () => {
    analysisReply = { status: 202, body: { status: "pending", queued: 1 } };
    render();
    await advance(ticks(1));
    assert.equal(state.status, "analysing");
    assert.equal(pendingPolls.size, 1);
  });

  it("gives up on a 404, which is final", async () => {
    // The backend answers 404 precisely when nothing is scheduled and nothing
    // will be — a track cached before the bridge was paired, or one whose
    // analysis failed. Polling it is asking for work nobody is doing.
    analysisReply = { status: 404, body: { error: "Not analysed" } };
    render();
    await advance(ticks(1));
    assert.equal(state.status, "unavailable");
    assert.equal(pendingPolls.size, 0);
  });

  it("keeps trying after a failure that says nothing about the analysis", async () => {
    // A 500 or a dropped connection is about the request, not the track.
    // Treating it like a 404 would blank the lights for a song that is sitting
    // analysed on disk.
    analysisReply = { status: 500, body: { error: "boom" } };
    render();
    await advance(ticks(1));
    assert.equal(state.status, "analysing");
    assert.equal(pendingPolls.size, 1);
  });

  it("stops polling when it goes away", async () => {
    analysisReply = { status: 202, body: { status: "pending", queued: 1 } };
    render();
    await advance(ticks(1));
    assert.equal(pendingPolls.size, 1);
    act(() => root!.unmount());
    assert.equal(pendingPolls.size, 0);
  });

  it("does not render one track's beats against another's clock", async () => {
    // Both halves matter: the features are keyed to the track they came from,
    // so a song change cannot leave the previous song's analysis on screen for
    // the frame it takes an effect to notice.
    render();
    await advance(ticks(1));
    assert.equal(state.status, "ready");

    analysisReply = { status: 202, body: { status: "pending", queued: 1 } };
    render({ nowPlaying: nowPlaying({ video_id: "xyz", position: "0:00:00" }) });
    assert.equal(state.status, "analysing");
  });
});

// ---------------------------------------------------------------------------

describe("useHueRender: sending", () => {
  it("sends nothing while the stream is down", async () => {
    render({ streaming: false });
    await advance(ticks(3));
    assert.equal(colorCalls.length, 0);
  });

  it("holds a dim idle colour for a track it cannot render", async () => {
    // Not silence. The backend resends its last setpoint forever, so sending
    // nothing freezes the room on the previous track's final beat flash — which
    // looks like the app crashed rather than like the song ended.
    analysisReply = { status: 404, body: { error: "Not analysed" } };
    render();
    await advance(ticks(2));
    assert.ok(colorCalls.length >= 1);
    assert.deepEqual(colorCalls[0], IDLE_COLOR);
  });

  it("drives the lights from the music once it can", async () => {
    render();
    await advance(ticks(5));
    const sent = colorCalls.filter((color) => shape(color) !== shape(IDLE_COLOR));
    assert.ok(sent.length >= 2, `expected rendered colours, got ${JSON.stringify(colorCalls)}`);
    // Distinct values, not just repeats: the clock has to be advancing between
    // ticks, which is the whole reason the loop runs faster than the SSE feed.
    assert.ok(new Set(sent.map(shape)).size >= 2);
  });

  it("says nothing when there is nothing to say", async () => {
    // A paused speaker freezes the clock, so every tick computes the same
    // colour. The room holds it for free — the backend is still resending at
    // 25 Hz — and a loop that posted it anyway would be 16 requests a second
    // to change nothing.
    //
    // The long warm-up is the easing: the loop starts at the idle colour and
    // approaches the held one asymptotically, so "settled" is a state it
    // arrives at over a second rather than on the second tick.
    render({ nowPlaying: nowPlaying({ state: "PAUSED_PLAYBACK" }) });
    await advance(ticks(25));
    const settled = colorCalls.length;
    await advance(ticks(8));
    assert.equal(colorCalls.length, settled);
  });

  it("skips a tick rather than queueing behind a slow bridge", async () => {
    // These are setpoints, not frames. Stacking them would drive the lights
    // from an ever-growing backlog of colours the song has already passed.
    let release: (() => void) | undefined;
    colorReply = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { status: 200, body: { streaming: true } };
    };

    render();
    await advance(ticks(5));
    assert.equal(colorCalls.length, 1);

    colorReply = async () => ({ status: 200, body: { streaming: true } });
    release?.();
    await advance(ticks(2));
    assert.ok(colorCalls.length > 1);
  });
});

// ---------------------------------------------------------------------------

describe("useHueRender: a stream that dies", () => {
  it("tolerates a single failure", async () => {
    // One failure is a dropped packet or a backend mid-restart. Tearing the
    // stream down for that is worse than the blip it would be hiding.
    let first = true;
    colorReply = async () => {
      if (first) {
        first = false;
        return { status: 503, body: { error: "nope" } };
      }
      return { status: 200, body: { streaming: true } };
    };

    render();
    await advance(ticks(4));
    assert.equal(lost, 0);
    assert.ok(colorCalls.length >= 2);
  });

  it("reports the stream lost once it is clearly gone", async () => {
    colorReply = async () => ({ status: 503, body: { error: "nope" } });
    render();
    await advance(ticks(MAX_CONSECUTIVE_FAILURES + 3));
    assert.equal(lost, 1);
  });

  it("stops sending instead of shouting at a bridge that has gone", async () => {
    // `onStreamLost` re-reads health, and until that answers, a loop still
    // running is a doomed request every 60ms — and a second, third and fourth
    // report of the same loss.
    colorReply = async () => ({ status: 503, body: { error: "nope" } });
    render();
    await advance(ticks(MAX_CONSECUTIVE_FAILURES + 3));
    const sent = colorCalls.length;
    assert.equal(sent, MAX_CONSECUTIVE_FAILURES);

    await advance(ticks(4));
    assert.equal(colorCalls.length, sent);
    assert.equal(lost, 1);
  });
});

// ---------------------------------------------------------------------------

describe("useHueRender: the swatch", () => {
  it("stays dark until someone is looking", async () => {
    // Publishing to React is a re-render of the page. Doing it for a dialog
    // nobody has open is four wasted renders a second for the life of the tab.
    render({ preview: false });
    await advance(ticks(6));
    assert.equal(state.colors, null);
    assert.ok(colorCalls.length >= 1, "the lights are still being driven");
  });

  it("shows what is being sent while the dialog is open", async () => {
    render({ preview: true });
    await advance(ticks(6));
    assert.ok(state.colors, "expected a colour");
    assert.equal(state.colors?.length, 1, "one swatch for a room with no channel list");
  });

  it("shows one swatch per light, in room order", async () => {
    render({ preview: true, area: area(3) });
    await advance(ticks(6));
    assert.equal(state.colors?.length, 3);
  });

  it("goes dark when the stream stops", async () => {
    // The loop stops with the stream, so the last colour it computed would
    // otherwise sit there as a live readout of a bridge nothing is driving.
    render({ preview: true });
    await advance(ticks(6));
    assert.ok(state.colors);
    render({ preview: true, streaming: false });
    assert.equal(state.colors, null);
  });
});

// ---------------------------------------------------------------------------

describe("useHueRender: addressing the room", () => {
  it("sends a bare colour when it has no channel list", async () => {
    // Not an empty map. `build_frame` fills every channel it is not given a
    // colour for with black, so `{}` is not "leave the lights alone" — it is
    // "switch the room off", and it would arrive as a broken feature rather
    // than as a missing area.
    render();
    await advance(ticks(2));
    assert.ok(colorCalls.length >= 1);
    assert.ok(Array.isArray(colorCalls[0]), `expected a bare colour: ${shape(colorCalls[0])}`);
  });

  it("sends a bare colour for an area the bridge lists no channels for", async () => {
    render({ area: area(0) });
    await advance(ticks(2));
    assert.ok(colorCalls.length >= 1);
    assert.ok(Array.isArray(colorCalls[0]), `expected a bare colour: ${shape(colorCalls[0])}`);
  });

  it("addresses each light by id once the area names them", async () => {
    render({ area: area(3) });
    await advance(ticks(4));
    const perChannel = colorCalls.filter((sent) => !Array.isArray(sent));
    assert.ok(perChannel.length >= 1, `never addressed channels: ${JSON.stringify(colorCalls)}`);
    assert.deepEqual(Object.keys(channels(perChannel[0])).sort(), ["0", "1", "2"]);
  });

  it("gives the ends of the room different colours", async () => {
    // The whole point of the spread. Same frame, so any difference between the
    // two ends is the hue offset and nothing else.
    render({ area: area(3), settings: { brightness: 1, beatDecay: 0.35, spreadDeg: 120, tauSeconds: 0.05 } });
    await advance(ticks(4));
    const perChannel = colorCalls.filter((sent) => !Array.isArray(sent)).map(channels);
    assert.ok(perChannel.length >= 1);
    const frame = perChannel[perChannel.length - 1];
    assert.notDeepEqual(frame["0"], frame["2"]);
  });

  it("gives every light the same colour at zero spread", async () => {
    render({ area: area(3), settings: { brightness: 1, beatDecay: 0.35, spreadDeg: 0, tauSeconds: 0.05 } });
    await advance(ticks(4));
    const perChannel = colorCalls.filter((sent) => !Array.isArray(sent)).map(channels);
    assert.ok(perChannel.length >= 1);
    for (const frame of perChannel) {
      assert.deepEqual(frame["0"], frame["1"]);
      assert.deepEqual(frame["1"], frame["2"]);
    }
  });

  it("eases into a track that starts mid-stream instead of cutting to it", async () => {
    /*
     * The transition slider only means anything across a *gap*, and the loop
     * snaps on its first tick by design — so the gap has to be made the way a
     * listener makes one: stream up and idle, then a song starts under it.
     *
     * Paused, so the target is a fixed colour and every difference between
     * consecutive sends is the ease and nothing else.
     */
    const heavy = { brightness: 1, beatDecay: 0.35, spreadDeg: 0, tauSeconds: 2 };
    render({ nowPlaying: null, settings: heavy });
    await advance(ticks(2));
    assert.deepEqual(colorCalls[0], IDLE_COLOR);

    render({ nowPlaying: nowPlaying({ state: "PAUSED_PLAYBACK" }), settings: heavy });
    await advance(ticks(6));

    const sent = colorCalls as Rgb[];
    assert.ok(sent.length >= 3, `too few sends to judge: ${JSON.stringify(sent)}`);
    assert.notDeepEqual(sent[sent.length - 1], IDLE_COLOR, "never left the idle colour");
    // A cut would arrive in one tick and then hold. Still moving several ticks
    // in is what says the loop is crossing the gap rather than jumping it.
    assert.notDeepEqual(
      sent[sent.length - 1],
      sent[sent.length - 2],
      "arrived in one step instead of easing",
    );
  });

  it("creeps rather than stalling when a tick moves less than one step", async () => {
    /*
     * The stall trap, from the outside. A loop that rounded its own state would
     * compute a sub-integer move, round it away, and freeze there — sending
     * nothing ever again, with the room stuck on the idle colour.
     *
     * The time constant here is well past the slider's maximum, deliberately:
     * what makes the trap bite is a per-tick move under half a step, and this
     * is the cheapest way to hold the loop in that condition for a whole test
     * rather than for the last few ticks of a convergence. The arithmetic has
     * to survive any time constant; the slider's range is a product decision
     * that can move without this becoming safe to get wrong.
     */
    const glacial = { brightness: 1, beatDecay: 0.35, spreadDeg: 0, tauSeconds: 60 };
    render({ nowPlaying: null, settings: glacial });
    await advance(ticks(2));
    const early = colorCalls.length;

    render({ nowPlaying: nowPlaying({ state: "PAUSED_PLAYBACK" }), settings: glacial });
    await advance(ticks(30));
    assert.ok(colorCalls.length > early, "the ease stalled instead of creeping");
  });
});
