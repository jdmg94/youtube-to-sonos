"use client";

import { useCallback, useRef, useState } from "react";

import { api, type ApiError } from "@/lib/api/client";
import type { PlayResponse, VideoInfo } from "@/lib/api/types";
import { useAction } from "@/lib/hooks/use-action";
import { usePersistedState } from "@/lib/hooks/use-persisted-state";

/**
 * A looked-up but not yet cast track survives a reload. Not a nicety:
 * analysing costs a yt-dlp round trip, and this tab spends most of its life
 * sitting in the background — so the gap between pressing Analyze and pressing
 * Play is measured in however long it takes someone to come back to it, which
 * is plenty of time for a browser restart.
 *
 * Only that gap. Casting clears the entry, so a restored tab offers the song
 * you had not sent yet and never one you already did.
 */
const ANALYZED_KEY = "yts.analyzed";

/** Separate key from the video: the toggle is a preference, not a session. */
const AUTOPLAY_KEY = "yts.autoplay";

export interface AnalyzedVideo {
  /**
   * The URL that produced `info` — and the one the Play buttons send.
   *
   * Stored as a pair with the metadata rather than read back off the input,
   * because the two can disagree: the box is cleared after a cast and can be
   * typed into at any time, and casting whatever happens to be in it would
   * play a URL the panel above is not describing.
   */
  url: string;
  info: VideoInfo;
}

export type CastMode = "now" | "next";

export interface StreamController {
  /** The URL box. Local, not persisted — see `analyze`. */
  url: string;
  setUrl: (url: string) => void;
  /** Whether pressing Analyze would do anything. */
  canAnalyze: boolean;
  analyze: () => void;
  analyzing: boolean;
  analyzeError: ApiError | null;

  /**
   * The video waiting to be cast: null before the first lookup, and null again
   * once one has been cast. It is what the Play buttons hang off, so this is
   * also the answer to "is there anything to play right now".
   */
  analyzed: AnalyzedVideo | null;

  autoplay: boolean;
  setAutoplay: (on: boolean) => void;

  /** Resolves to the response, or `undefined` if it failed or there was nothing to cast. */
  cast: (mode: CastMode) => Promise<PlayResponse | undefined>;
  /** Which of the two Play buttons is busy, or null. */
  casting: CastMode | null;
  castError: ApiError | null;
}

/**
 * Analysing a URL, and casting what came back.
 *
 * Separate from the component so the sequencing can be tested without a DOM
 * assertion: which URL a Play button actually sends, what a failed analysis
 * leaves on screen, and whether the second Play button can fire while the first
 * is in flight are all one edit away from being wrong in a way no screenshot
 * would show.
 *
 * `analyzed` is the one piece of state both halves move, and each moves it
 * only on success: a lookup writes it, a cast clears it. Nothing a failure
 * touches, so a failed lookup and a failed cast both leave the last good
 * track on screen — which is what the user wants, since neither a typo in the
 * box nor an unreachable speaker should cost them the song they looked up.
 *
 * The original set its `selectedVideoUrl` from the input *before* the fetch
 * and hid the info panel for the duration, so a failed analysis left the
 * previous track's card pointing at the new URL — recoverable only because the
 * card was hidden. Writing the URL and its metadata as one pair means the
 * panel and the buttons cannot disagree, so the panel can stay up through a
 * failure instead.
 */
export function useStream(deviceIp: string | undefined): StreamController {
  const [url, setUrl] = useState("");
  const [analyzed, setAnalyzed] = usePersistedState<AnalyzedVideo | null>(ANALYZED_KEY, null);
  const [autoplay, setAutoplay] = usePersistedState<boolean>(AUTOPLAY_KEY, true);

  /**
   * Which button started the in-flight cast.
   *
   * Never cleared, and it does not need to be: it is only ever read while
   * `castAction.pending`, and the next cast overwrites it before pending goes
   * true again. Clearing it in a `finally` would be a second state update per
   * press for a value nobody can observe.
   */
  const [mode, setMode] = useState<CastMode | null>(null);

  /**
   * In-flight latches for the two actions.
   *
   * Refs, not `pending`. `pending` is state, so it is whatever it was when the
   * closure was created: two presses inside one tick — a double-click, a tap
   * that lands twice, an Enter held down — both read `false` and both fire.
   * The disabled buttons hide this in the UI, which is exactly why the hook
   * cannot rely on them: the rule that "Play now" must not race a "Play next"
   * is about the speaker's queue, not about the cursor.
   */
  const analyzing = useRef(false);
  const casting = useRef(false);

  const analyzeAction = useAction(async (raw: string) => {
    const trimmed = raw.trim();
    const info = await api.info(trimmed);
    setAnalyzed({ url: trimmed, info });
    return info;
  });

  const castAction = useAction(async (target: AnalyzedVideo, castMode: CastMode) => {
    const result = await api.play({
      url: target.url,
      device_ip: deviceIp,
      autoplay,
      mode: castMode,
    });
    // The speaker has it, so the panel has nothing left to say: from here the
    // Now Playing card is what describes what is playing, and a panel still
    // showing this track beside it is a second answer to that question — one
    // that stops being true the moment the station advances. Reset both and
    // the controller is back to its one job, the next URL.
    //
    // After the await, so a cast that never reached the speaker leaves the
    // song on screen rather than charging a second yt-dlp round trip to retry
    // it.
    setUrl("");
    setAnalyzed(null);
    return result;
  });

  const trimmed = url.trim();
  const canAnalyze = trimmed.length > 0 && !analyzeAction.pending;

  const { run: runAnalyze } = analyzeAction;
  const analyze = useCallback(() => {
    if (!canAnalyze || analyzing.current) return;
    analyzing.current = true;
    void runAnalyze(url).finally(() => {
      analyzing.current = false;
    });
  }, [canAnalyze, url, runAnalyze]);

  const { run: runCast } = castAction;
  const cast = useCallback(
    async (castMode: CastMode) => {
      if (!analyzed || casting.current) return undefined;
      casting.current = true;
      // Only after the latch is taken, so a refused second press cannot move
      // the spinner onto the button that did not start this cast.
      setMode(castMode);
      try {
        return await runCast(analyzed, castMode);
      } finally {
        casting.current = false;
      }
    },
    [analyzed, runCast],
  );

  return {
    url,
    setUrl,
    canAnalyze,
    analyze,
    analyzing: analyzeAction.pending,
    analyzeError: analyzeAction.error,
    analyzed,
    autoplay,
    setAutoplay,
    cast,
    casting: castAction.pending ? mode : null,
    castError: castAction.error,
  };
}
