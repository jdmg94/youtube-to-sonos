"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, api } from "@/lib/api/client";
import type { HueBridge, HueHealth } from "@/lib/api/types";
import { PAIR_POLL_MS, PAIR_TIMEOUT_MESSAGE, pairingStep } from "@/lib/hue-bridge";

export interface HueBridgeState {
  /** Bridge and stream state. `null` until the first read answers. */
  health: HueHealth | null;
  /** The first health read is in flight. */
  loading: boolean;
  error: ApiError | null;
  /** Re-read health. Call after anything that could have changed it. */
  refresh: () => void;

  bridges: HueBridge[];
  scanning: boolean;
  discover: () => void;

  /** A pairing attempt is running: the user should be pressing the link button. */
  pairing: boolean;
  pairError: ApiError | null;
  /** Omit `ip` to re-pair with the bridge already on file. */
  pair: (ip?: string) => void;
  cancelPair: () => void;
}

/**
 * The Hue bridge: is one paired, which ones are on the network, and the link
 * button flow.
 *
 * Health is read once and then only on demand, not polled. `/api/hue/health`
 * is cheap — it touches no network — but there is nothing for a poll to
 * discover: pairing and stream changes are all initiated from here and the
 * response says what happened, and a stream that dies on its own is reported by
 * the very next colour frame failing, which is immediate rather than up to an
 * interval late. A timer here would be a request every few seconds, forever, to
 * learn something we are already told.
 */
export function useHueBridge(): HueBridgeState {
  const [health, setHealth] = useState<HueHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  // Same bump-a-counter trick as `useDevices`: the fetch lives in the effect,
  // so React's teardown cancels a superseded read for free.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api
      .hueHealth(controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setHealth(next);
        setError(null);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof ApiError ? cause : new ApiError("Hue is unavailable", 0));
        setLoading(false);
      });
    return () => controller.abort();
  }, [attempt]);

  const refresh = useCallback(() => setAttempt((n) => n + 1), []);

  // -- Discovery -----------------------------------------------------------

  const [bridges, setBridges] = useState<HueBridge[]>([]);
  const [scanning, setScanning] = useState(false);
  const scan = useRef<AbortController | null>(null);

  const discover = useCallback(() => {
    scan.current?.abort();
    const controller = new AbortController();
    scan.current = controller;
    setScanning(true);
    api
      .hueDiscover(controller.signal)
      .then(({ bridges: found }) => {
        if (controller.signal.aborted) return;
        setBridges(found);
        setScanning(false);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        // The previous list survives a failed rescan, as in `useDevices`: a
        // bridge we found a moment ago is still worth offering.
        setError(cause instanceof ApiError ? cause : new ApiError("Could not scan", 0));
        setScanning(false);
      });
  }, []);

  // -- Pairing -------------------------------------------------------------

  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<ApiError | null>(null);

  // The attempt in flight, and the timer waiting to make the next one. Both,
  // because either can be the thing that is outstanding: aborting the request
  // alone leaves a timer holding this closure alive for a further PAIR_POLL_MS
  // and firing a call into an unmounted component, which happens to be
  // harmless today only because the abort check catches it on the way back.
  const attemptRef = useRef<AbortController | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const stopPairing = useCallback(() => {
    attemptRef.current?.abort();
    attemptRef.current = null;
    clearTimeout(retryRef.current);
    retryRef.current = undefined;
  }, []);

  useEffect(() => stopPairing, [stopPairing]);

  const pair = useCallback(
    (ip?: string) => {
      stopPairing();
      const controller = new AbortController();
      attemptRef.current = controller;
      setPairing(true);
      setPairError(null);

      const startedAt = Date.now();

      /*
       * A recursive timeout rather than an interval: an interval would stack a
       * second attempt on top of one that had not answered yet, and every
       * attempt here is a blocking round trip to the bridge.
       */
      const attemptOnce = () => {
        api
          .huePair(ip, controller.signal)
          .then(() => {
            if (controller.signal.aborted) return;
            setPairing(false);
            // Pairing changes what health says about everything, and the pair
            // response only carries the bridge.
            setAttempt((n) => n + 1);
          })
          .catch((cause: unknown) => {
            if (controller.signal.aborted) return;
            const failure =
              cause instanceof ApiError ? cause : new ApiError("Pairing failed", 0);
            const step = pairingStep(failure.status, Date.now() - startedAt);

            if (step === "retry") {
              retryRef.current = setTimeout(attemptOnce, PAIR_POLL_MS);
              return;
            }
            setPairing(false);
            setPairError(
              step === "expired"
                ? new ApiError(PAIR_TIMEOUT_MESSAGE, failure.status)
                : failure,
            );
          });
      };

      attemptOnce();
    },
    [stopPairing],
  );

  const cancelPair = useCallback(() => {
    stopPairing();
    setPairing(false);
    setPairError(null);
  }, [stopPairing]);

  return {
    health,
    loading,
    error,
    refresh,
    bridges,
    scanning,
    discover,
    pairing,
    pairError,
    pair,
    cancelPair,
  };
}
