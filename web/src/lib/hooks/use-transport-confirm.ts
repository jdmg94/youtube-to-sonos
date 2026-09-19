"use client";

import { useCallback, useEffect, useState } from "react";

import type { PlaybackState } from "@/lib/api/types";

/**
 * How long a press waits for the stream to agree before giving up.
 *
 * Frames arrive every `EVENT_POLL_INTERVAL` (2s), and a Sonos command that
 * lands takes effect well inside one of them — so this is not a budget for the
 * speaker, it is the escape hatch for the cases where no frame is coming at
 * all: the stream dropped, the browser backgrounded the tab and stopped
 * delivering events, the speaker accepted the command and ignored it. Without
 * one, any of those leaves the only playback control permanently disabled and
 * a page reload the only way out.
 *
 * Exported so the test measures the real window rather than pinning a number
 * that could drift away from it.
 */
export const CONFIRM_TIMEOUT_MS = 5000;

export interface TransportConfirm {
  /** Whether a press is still waiting to be confirmed by the stream. */
  awaiting: boolean;
  /**
   * Start waiting. Called at press time — *before* the request goes out, so
   * the state it compares against is the one the listener was looking at when
   * they clicked, not one a frame may have replaced in the meantime.
   */
  hold: () => void;
  /** Stop waiting, for a request that failed. Nothing is coming. */
  release: () => void;
}

/**
 * Holds a transport button disabled until the event stream agrees it worked.
 *
 * The rest of the card is a pure subscriber to `/api/events`: it renders the
 * last frame and never patches it, because Sonos advances this queue on its
 * own and a card that argued with the speaker would lose. A toggle makes the
 * cost of that visible — for up to one poll after pressing Pause, the frame
 * still says PLAYING, so the button still says "Pause", and a second press
 * resumes the track the listener just paused.
 *
 * So the button waits instead of lying. It goes busy on press and stays
 * disabled, still showing the old label, until a frame reports a state
 * different from the one that was on screen when it was pressed. Three things
 * end that wait, and the second two are why this is a hook rather than a
 * boolean:
 *
 *  - the confirming frame, which is the normal case;
 *  - a frame reporting something else entirely — stopped from the Sonos app,
 *    the station ending — because the button now describes a different world
 *    and has nothing left to wait for;
 *  - `CONFIRM_TIMEOUT_MS`, for when no frame arrives at all.
 *
 * The comparison is against the state at press time rather than against the
 * state the command was meant to produce, which keeps it honest about
 * `TRANSITIONING`: Sonos passes through it on its way to PAUSED_PLAYBACK, and
 * waiting for one specific target would sit through the transition while a
 * card beside it had already moved on.
 */
export function useTransportConfirm(state: PlaybackState | null | undefined): TransportConfirm {
  /**
   * The state on screen when the button was pressed, boxed so that "waiting on
   * a speaker reporting nothing" stays distinguishable from "not waiting".
   */
  const [held, setHeld] = useState<{ from: PlaybackState | null } | null>(null);
  const reported = state ?? null;

  /*
   * Whether to keep waiting is a fact about the current frame, so it is
   * derived here rather than written back by an effect — an effect would
   * render one disabled frame too many after every confirmation, and would be
   * a second copy of the state the stream already holds.
   */
  const awaiting = held !== null && reported === held.from;

  /*
   * Which leaves one thing to clean up: a `held` that has been overtaken stays
   * in state, and if the speaker ever returns to that state on its own — a
   * resume from the Sonos app — it would re-arm a wait nobody asked for. Reset
   * during render, which React finishes before painting, so the button never
   * shows the stale value.
   */
  if (held !== null && !awaiting) setHeld(null);

  const hold = useCallback(() => setHeld({ from: reported }), [reported]);
  const release = useCallback(() => setHeld(null), []);

  useEffect(() => {
    if (!awaiting) return;
    /*
     * Armed once per press, not once per frame: while the wait stands these
     * dependencies are unchanged, so the effect does not re-run and the timer
     * keeps counting from the press. Restarting it on every frame would put
     * the deadline permanently two seconds away and make the escape hatch
     * unreachable — the failure it exists to catch is precisely one where
     * frames keep arriving.
     */
    const timer = setTimeout(() => setHeld(null), CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [awaiting, held]);

  return { awaiting, hold, release };
}
