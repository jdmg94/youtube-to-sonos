"use client";

import { useEffect, useRef } from "react";

import type { NowPlayingMode } from "@/lib/now-playing";

/**
 * Fires once when the speaker moves to a different track.
 *
 * The station advances on its own — Sonos walks its queue whether or not a
 * browser is watching — so "a new song started" arrives as a changed title on
 * an event frame, with nothing to distinguish it from the same title arriving
 * for the fourth time because some unrelated field moved. This is the only
 * thing in the app holding the previous value needed to tell those apart.
 *
 * Three rules, each of which exists because breaking it produces a specific
 * wrong toast:
 *
 *  - The first track seen is not announced. Otherwise every page load, tab
 *    focus and reconnect announces whatever was already playing.
 *  - Pausing announces nothing, and neither does resuming. The listener paused
 *    it; they know what it is.
 *  - Going idle forgets. A stop ends the session, so the next track is a
 *    beginning rather than a change — and announcing the song you just asked
 *    for by name is noise on top of the "playing" state the card already shows.
 *
 * `onChange` is read through a ref rather than listed as a dependency: callers
 * pass an inline arrow, so depending on it would fire on every render — which
 * is the bug this hook exists to prevent, reintroduced through the back door.
 */
export function useTrackChange(
  mode: NowPlayingMode,
  title: string,
  onChange: (title: string) => void,
): void {
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  /** The last title seen while playing, or `null` for "no session". */
  const seen = useRef<string | null>(null);

  useEffect(() => {
    if (mode === "idle") {
      seen.current = null;
      return;
    }
    if (mode === "paused") return;

    const previous = seen.current;
    seen.current = title;
    if (previous !== null && previous !== title) onChangeRef.current(title);
  }, [mode, title]);
}
