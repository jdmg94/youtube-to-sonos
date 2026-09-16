"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A pixel of slack.
 *
 * `scrollWidth` and `clientWidth` are both rounded to whole pixels, and they
 * round independently — so a line of text that fits its box exactly can report
 * one pixel of overflow that does not exist. Comparing them strictly puts a
 * tooltip on titles that are entirely on screen, which reads as deliberate and
 * so never gets reported as a bug. One pixel of real clipping hides, at most,
 * part of the ellipsis that replaced it.
 */
const ROUNDING = 1;

/**
 * Whether an element's text is actually being cut off.
 *
 * This exists because CSS cannot say it. `text-overflow: ellipsis` renders the
 * "…" without exposing any selector for "this one is truncated", so the only
 * way to know is to compare the laid-out width against the visible one — which
 * makes a hook the smallest thing that can answer the question.
 *
 * The caller uses it to decide whether to set `title` at all. Setting it
 * unconditionally would be simpler and worse: a native tooltip that repeats a
 * name already fully readable on screen is noise the user cannot turn off, and
 * it appears over the artwork a second after the pointer stops moving.
 *
 * `key` is whatever changing would change the answer — in practice the text
 * itself. The element is reused between songs (only its contents are replaced),
 * so nothing about the DOM prompts a second look; without this the hook would
 * answer forever for whichever track was playing when the card mounted.
 *
 * The resize half is best-effort. `ResizeObserver` is feature-detected because
 * jsdom has none and neither do older browsers, and it catches the container
 * changing width but not a webfont swapping in underneath unchanged text —
 * that case is corrected on the next track, and a tooltip's worth of accuracy
 * does not justify a `document.fonts` dependency.
 */
export function useClipped<T extends HTMLElement>(
  key: unknown,
): [ref: React.RefObject<T | null>, clipped: boolean] {
  const ref = useRef<T>(null);
  const [clipped, setClipped] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const measure = () => setClipped(node.scrollWidth > node.clientWidth + ROUNDING);
    measure();

    if (typeof ResizeObserver === "undefined") return;
    // Safe against the loop this shape usually invites: the only thing the
    // caller does with the result is set `title`, which changes no layout, and
    // `setClipped` bails out when the value is unchanged anyway.
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [key]);

  return [ref, clipped];
}
