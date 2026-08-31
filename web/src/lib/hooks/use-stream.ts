"use client";

import { useCallback, useRef, useState } from "react";

import { api, type ApiError } from "@/lib/api/client";
import type { PlayResponse, VideoInfo } from "@/lib/api/types";
import { useAction } from "@/lib/hooks/use-action";
import { usePersistedState } from "@/lib/hooks/use-persisted-state";

/**
 * The analyzed track survives a reload. Not a nicety: analysing costs a yt-dlp
 * round trip, and the common shape of using this app is to queue a song, go
 * back to whatever you were doing, and return to the tab later.
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

  /** The last successfully analyzed video, or null before the first one. */
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
 * `analyzed` is only ever written on success. The original set its
 * `selectedVideoUrl` from the input *before* the fetch and hid the info panel
 * for the duration, so a failed analysis left the previous track's card
 * pointing at the new URL — recoverable only because the card was hidden. A
 * pair written atomically means the panel and the buttons cannot disagree, so
 * the panel can stay up through a failure, which is also what the user wants:
 * a typo in the box should not cost them the song they already looked up.
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
    // The box is free for the next URL now; the info panel above it stays put,
    // so what was just sent is still on screen.
    setUrl("");
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
