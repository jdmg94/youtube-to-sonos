"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "@/lib/api/client";

export interface ActionState<Args extends unknown[], R> {
  /**
   * Runs the action. Resolves to `undefined` on failure rather than throwing —
   * a rejected promise from an `onClick` handler is an unhandled rejection,
   * and every caller would otherwise wrap the same try/catch. Read `error`.
   */
  run: (...args: Args) => Promise<R | undefined>;
  pending: boolean;
  error: ApiError | null;
  reset: () => void;
}

/**
 * Wraps a one-shot API call with pending/error state.
 *
 * For writes — play, transport, refresh — not for reads. It deliberately keeps
 * no result: every one of these actions has its true outcome delivered by the
 * event stream a moment later, and holding the response as well would give the
 * UI two sources for one fact that disagree during the gap.
 */
export function useAction<Args extends unknown[], R>(
  fn: (...args: Args) => Promise<R>,
): ActionState<Args, R> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  // Callers pass an inline arrow, so `fn` is a new function every render.
  // Reading it through a ref keeps `run` stable, which matters because `run`
  // ends up in the dependency list of effects and memoised children.
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });

  // These calls are slow — a cold `play` can take 45s — so the component may
  // well be gone before the promise settles.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async (...args: Args): Promise<R | undefined> => {
    setPending(true);
    setError(null);
    try {
      const result = await fnRef.current(...args);
      return result;
    } catch (cause) {
      // An abort is our own teardown, not a failure to report.
      if (cause instanceof DOMException && cause.name === "AbortError") return undefined;
      if (mounted.current) {
        setError(
          cause instanceof ApiError
            ? cause
            : new ApiError(cause instanceof Error ? cause.message : "Something went wrong", 0),
        );
      }
      return undefined;
    } finally {
      if (mounted.current) setPending(false);
    }
  }, []);

  const reset = useCallback(() => setError(null), []);

  return { run, pending, error, reset };
}
