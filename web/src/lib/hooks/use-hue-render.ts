"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { ApiError, api } from "@/lib/api/client";
import {
  isAnalysisPending,
  type HueAnalysis,
  type HueArea,
  type NowPlaying,
  type Rgb,
} from "@/lib/api/types";
import {
  DEFAULT_SETTINGS,
  IDLE_COLOR,
  type Clock,
  type ResolvedSettings,
  createRenderer,
  differsEnough,
  anyDiffersEnough,
  easeChannels,
  hsvToRgb,
  orderChannels,
  parseSonosTime,
  positionAt,
  resolveSettings,
  roundRgb,
  spreadAcross,
  syncClock,
} from "@/lib/hue";

/**
 * The render loop: the only thing in the app that runs on a timer for its own
 * sake.
 *
 * All the judgement lives in `lib/hue.ts`, which is pure and tested. What is
 * left here is the part that cannot be: when to tick, what to do when a send
 * fails, and how to keep a 16 Hz loop from re-rendering the page 16 times a
 * second.
 */

/**
 * How often a colour is computed and possibly sent.
 *
 * The features are sampled at 10 Hz, so this is not about resolving the
 * envelopes — it is about beat onsets. A beat's flash starts at full brightness
 * and decays; landing it up to 60ms late is inaudible against the speaker's own
 * latency, whereas at 10 Hz the flash would arrive up to 100ms after the drum
 * and read as sloppy rather than as tight.
 *
 * The upper bound on cost is one HTTP request per tick, but `differsEnough`
 * means the steady state during a quiet passage is zero.
 */
export const SEND_INTERVAL_MS = 60;

/**
 * How often the computed colour is published to React.
 *
 * Separate from the send rate, and much slower, because this one re-renders the
 * page. The swatch is a readout for a human eye; four updates a second look
 * continuous and cost a twentieth of what publishing every tick would.
 */
export const PREVIEW_INTERVAL_MS = 250;

/** Gap between polls while the backend is still analysing a track. */
export const ANALYSIS_POLL_MS = 3_000;

/**
 * How long to keep polling a track that answers 202.
 *
 * A 202 means a PCM capture exists or a download is running, so the wait is
 * bounded by the download in practice. This is the backstop for the case that
 * is not: a worker that died holding the capture, which would otherwise poll
 * for as long as the song is on screen.
 */
export const ANALYSIS_MAX_WAIT_MS = 180_000;

/**
 * Consecutive failed sends before the stream is declared lost.
 *
 * Not one: a single failure can be a dropped packet or the backend mid-restart,
 * and tearing the stream down for that would be worse than the blip. Not many,
 * either — at this interval five failures is under a second, and every one of
 * them is a second the lights are frozen on a stale setpoint while the app
 * still claims to be driving them.
 */
export const MAX_CONSECUTIVE_FAILURES = 5;

/** Whether the current track has features to render from. */
export type AnalysisStatus =
  /** Nothing to analyse: no track, or the lights are not running. */
  | "idle"
  /** Fetching, or waiting on the backend's queue. */
  | "analysing"
  | "ready"
  /** Nothing will ever analyse this track — a 404, which is final. */
  | "unavailable";

/**
 * The key the eased state uses when the room is addressed as a whole.
 *
 * Not a channel id — it cannot collide with one, since `spreadAcross` keys on
 * stringified integers. Carrying the uniform case as a one-entry map means the
 * loop has one piece of eased state instead of two, and gets the switch between
 * the two addressing modes handled for free: `anyDiffersEnough` sees the key set
 * change and sends, which it must, because the two modes light different lamps.
 */
const WHOLE_ROOM = "*";

export interface HueRenderState {
  status: AnalysisStatus;
  /**
   * The colours being sent, in room order, for the dialog's swatch strip. One
   * entry when the room is addressed as a whole. `null` unless `preview` is on
   * — see `PREVIEW_INTERVAL_MS`.
   */
  colors: Rgb[] | null;
}

interface HueRenderOptions {
  /** The live speaker state. Only `video_id`, `position` and `state` are read. */
  nowPlaying: NowPlaying | null;
  /** Whether the bridge stream is up. The loop runs only while it is. */
  streaming: boolean;
  /** Whether anyone is looking at the swatch. */
  preview: boolean;
  /**
   * The area being streamed to, for its channel list and their positions. The
   * room is addressed as a whole when this is absent or lists no channels —
   * never as an empty channel map, which the backend fills with black.
   */
  area?: HueArea | null;
  /** The user's dials. Defaults to the shipped settings. */
  settings?: ResolvedSettings;
  /**
   * Called after `MAX_CONSECUTIVE_FAILURES` sends fail. The stream is gone and
   * only the backend knows why, so the caller should re-read health rather than
   * assume.
   */
  onStreamLost: () => void;
}

/** The shipped look, for a caller that has no settings to pass. */
const SHIPPED_SETTINGS = resolveSettings(DEFAULT_SETTINGS);

/**
 * Drive the lights from the track the speaker is playing.
 *
 * ## Why `setInterval` and not `requestAnimationFrame`
 *
 * rAF is the right tool for animation and the wrong one here, because a browser
 * stops calling it entirely when the tab is hidden — and a tab playing music
 * through a *speaker* is hidden most of the time. The lights would freeze the
 * moment the listener switched to another tab, which is precisely when they are
 * looking at the room instead of the screen.
 *
 * `setInterval` is throttled in a hidden tab rather than stopped: browsers clamp
 * it to roughly once a second. That is a real degradation — beat flashes are
 * lost and the colour moves in visible steps — but it degrades to "chunky"
 * rather than to "dead", and it recovers the instant the tab is shown. Two
 * things make the chunky version work at all: the backend keeps resending the
 * last setpoint at 25 Hz, so a slow loop is a slow-changing room and not a
 * flickering one, and the clock is anchored to `performance.now()`, which keeps
 * running while hidden — so the first tick after the tab wakes renders the
 * moment the song is *actually* at, not the moment it was at when the tab went
 * away.
 */
export function useHueRender({
  nowPlaying,
  streaming,
  preview,
  area = null,
  settings = SHIPPED_SETTINGS,
  onStreamLost,
}: HueRenderOptions): HueRenderState {
  /*
   * Primitives, extracted once. Every effect below keys on these rather than on
   * `nowPlaying`, which is a fresh object on every SSE frame — keying on the
   * object would re-run the analysis fetch and re-anchor the clock roughly
   * every two seconds regardless of whether anything had changed.
   */
  const videoId = nowPlaying?.video_id ?? null;
  const playing = nowPlaying?.state === "PLAYING";
  const reported = parseSonosTime(nowPlaying?.position);

  // -- Analysis ------------------------------------------------------------

  /*
   * Stored with the track it belongs to and matched during render, the same
   * shape as the areas list in `useHue`. The alternative — clearing on track
   * change from an effect — renders one frame of the *previous* song's beats
   * against the new song's clock, which is a full second of lights flashing to
   * nothing.
   *
   * A resolved-but-absent analysis is `analysis: null`, which is a real answer
   * and not a missing one: it is what makes "we asked and nobody will ever
   * analyse this" distinguishable from "we have not asked yet".
   */
  const [loaded, setLoaded] = useState<{
    videoId: string;
    analysis: HueAnalysis | null;
  } | null>(null);

  const matched = videoId !== null && loaded?.videoId === videoId;
  const analysis = matched ? loaded.analysis : null;

  const status: AnalysisStatus = !streaming || videoId === null
    ? "idle"
    : !matched
      ? "analysing"
      : analysis
        ? "ready"
        : "unavailable";

  useEffect(() => {
    // Gated on `streaming`: analysis is only ever wanted to render from, and a
    // poll loop per track for a feature nobody has switched on is pure cost.
    // Starting the stream runs this immediately, and the usual answer is a
    // sidecar already on disk.
    if (!streaming || !videoId) return;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();

    const poll = () => {
      api
        .hueAnalysis(videoId, controller.signal)
        .then((body) => {
          if (controller.signal.aborted) return;
          if (!isAnalysisPending(body)) {
            setLoaded({ videoId, analysis: body });
            return;
          }
          if (Date.now() - startedAt >= ANALYSIS_MAX_WAIT_MS) {
            setLoaded({ videoId, analysis: null });
            return;
          }
          timer = setTimeout(poll, ANALYSIS_POLL_MS);
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          /*
           * A 404 is the backend saying nothing is scheduled and nothing will
           * be — a track cached before the bridge was paired, or one whose
           * analysis failed. Retrying it polls forever for work nobody is
           * doing, so it resolves the track as unavailable.
           *
           * Anything else — a 500, a dropped connection — says nothing about
           * whether the analysis exists, so it retries on the same schedule as
           * a 202 and inside the same window.
           */
          const code = cause instanceof ApiError ? cause.status : 0;
          if (code === 404 || Date.now() - startedAt >= ANALYSIS_MAX_WAIT_MS) {
            setLoaded({ videoId, analysis: null });
            return;
          }
          timer = setTimeout(poll, ANALYSIS_POLL_MS);
        });
    };

    poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [streaming, videoId]);

  // Sorting a whole track's brightness series, so: once per song, not per tick.
  const renderer = useMemo(() => (analysis ? createRenderer(analysis) : null), [analysis]);

  // -- Clock ---------------------------------------------------------------

  /*
   * A ref, not state: the send loop reads it 16 times a second and nothing
   * renders from it. Held in step by an effect keyed on the *primitives*, so it
   * re-anchors only when the speaker's reported second actually ticks over —
   * which is the correction cadence `syncClock` is written for.
   */
  const clockRef = useRef<Clock | null>(null);
  const clockTrackRef = useRef<string | null>(null);

  useEffect(() => {
    if (videoId === null || reported === null) {
      clockRef.current = null;
      clockTrackRef.current = null;
      return;
    }
    // Never fold a new track's position into the old track's anchor: the two
    // are unrelated timelines and `syncClock` would keep the old one whenever
    // the numbers happened to land within the drift threshold.
    const previous = clockTrackRef.current === videoId ? clockRef.current : null;
    clockRef.current = syncClock(previous, reported, performance.now(), playing);
    clockTrackRef.current = videoId;
  }, [videoId, reported, playing]);

  // -- Sending -------------------------------------------------------------

  const [colors, setColors] = useState<Rgb[] | null>(null);

  /*
   * The order to lay the gradient out in, recomputed only when the area
   * changes. Empty when there is no area, which is what puts the loop into its
   * whole-room mode — an area whose channel list the bridge has not filled in
   * must not become an empty channel map, because the backend's `build_frame`
   * blacks out every lamp it is not given a colour for.
   */
  const ordered = useMemo(
    () => (area ? orderChannels(area.channels, area.positions) : []),
    [area],
  );

  // The `useAction` pattern: the loop reads these through a ref so that a new
  // renderer, a moved slider or a new callback does not tear down and restart
  // the interval, which would reset the failure count, the eased colours and
  // the last-sent frame with it. A slider is dragged, so that matters: rebuilding
  // the loop on every pixel of travel would ease from idle each time and make
  // the room stutter for as long as the drag lasted.
  const latest = useRef({ renderer, preview, ordered, settings, onStreamLost });
  useEffect(() => {
    latest.current = { renderer, preview, ordered, settings, onStreamLost };
  });

  useEffect(() => {
    if (!streaming) return;

    const controller = new AbortController();
    let handle: ReturnType<typeof setInterval> | undefined;
    let inFlight = false;
    let failures = 0;
    /** Sub-integer, so a slow ease creeps across `COLOR_EPSILON` rather than stalling. */
    let eased: Record<string, Rgb> | null = null;
    let lastSent: Record<string, Rgb> | null = null;
    let lastTickMs: number | null = null;
    let lastPreviewMs = -Infinity;

    const tick = () => {
      const {
        renderer: current,
        preview: showing,
        ordered: room,
        settings: dials,
        onStreamLost: lost,
      } = latest.current;
      const nowMs = performance.now();
      const clock = clockRef.current;

      /*
       * Measured, not assumed to be `SEND_INTERVAL_MS`. That is the whole point
       * of easing on a time constant: a hidden tab's interval is clamped to
       * about 1 Hz, and a tick that pretended 16 of them had passed in one
       * would smooth the lights to a crawl exactly where nobody could see why.
       * The first tick has no previous one, so it snaps — a stream that has
       * just started should show the music, not fade up to it.
       */
      const dt = lastTickMs === null ? Infinity : (nowMs - lastTickMs) / 1000;
      lastTickMs = nowMs;

      /*
       * No renderer or no clock is not a reason to send nothing. The backend
       * holds its last setpoint indefinitely, so silence here leaves the room
       * frozen on the previous track's final beat flash — which looks like a
       * crash. `IDLE_COLOR` is the one colour that reads as "off duty".
       */
      let target: Record<string, Rgb>;
      if (current && clock) {
        const frame = current.frameAt(positionAt(clock, nowMs), {
          brightness: dials.brightness,
          beatDecay: dials.beatDecay,
          spreadDeg: dials.spreadDeg,
        });
        target =
          room.length > 0
            ? spreadAcross(frame, room, dials.spreadDeg)
            : { [WHOLE_ROOM]: hsvToRgb(frame.hue, frame.saturation, frame.value) };
      } else {
        // The idle colour goes to the room as a whole even when the channels
        // are known: there is no gradient to draw when there is no music.
        target = { [WHOLE_ROOM]: IDLE_COLOR };
      }

      eased = easeChannels(eased, target, dt, dials.tauSeconds);
      const next: Record<string, Rgb> = {};
      for (const key of Object.keys(eased)) next[key] = roundRgb(eased[key]);

      if (showing && nowMs - lastPreviewMs >= PREVIEW_INTERVAL_MS) {
        lastPreviewMs = nowMs;
        /*
         * Keyed off what the frame *is*, exactly as the payload below is —
         * never off `room.length`. Knowing the channels does not mean
         * addressing them: with an area chosen and no analysis yet, the loop
         * still sends the idle colour to the room as a whole, and a strip built
         * from the channel ids would be a row of `undefined` for the comparison
         * on the next tick to die reading `[0]` off.
         */
        const strip =
          WHOLE_ROOM in next ? [next[WHOLE_ROOM]] : room.map((id) => next[String(id)]);
        // Compared before storing: a held colour would otherwise re-render the
        // page four times a second to say nothing changed.
        setColors((prev) =>
          prev &&
          prev.length === strip.length &&
          prev.every((was, i) => !differsEnough(was, strip[i]))
            ? prev
            : strip,
        );
      }

      // Skipped, never queued. These are setpoints, not frames: the freshest
      // one is the only one worth sending, and stacking requests behind a slow
      // bridge would drive the lights from an ever-growing backlog.
      if (inFlight) return;
      if (!anyDiffersEnough(next, lastSent)) return;

      // A one-entry whole-room frame goes as a bare colour, which is what the
      // backend applies to every channel it knows about — including ones the
      // area gained since the stream started.
      const payload = WHOLE_ROOM in next ? next[WHOLE_ROOM] : next;

      inFlight = true;
      api
        .hueColor(payload, controller.signal)
        .then(() => {
          lastSent = next;
          failures = 0;
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          failures += 1;
          if (failures < MAX_CONSECUTIVE_FAILURES) return;
          // Stop before reporting: `onStreamLost` re-reads health, and until
          // that answers this loop would keep firing doomed requests at a
          // bridge that has already gone.
          clearInterval(handle);
          handle = undefined;
          lost();
        })
        .finally(() => {
          inFlight = false;
        });
    };

    handle = setInterval(tick, SEND_INTERVAL_MS);
    return () => {
      clearInterval(handle);
      // Aborts the send in flight, if any. Dropping a setpoint on teardown is
      // free — the stream it belonged to is being stopped.
      controller.abort();
    };
  }, [streaming]);

  // `streaming` as well as `preview`: the loop stops when the stream does, so
  // the last colours it computed would otherwise sit in the swatch as a live
  // readout of a bridge that is no longer being driven.
  return { status, colors: preview && streaming ? colors : null };
}
