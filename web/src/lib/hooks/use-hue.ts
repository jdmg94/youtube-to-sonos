"use client";

import { useCallback, useEffect, useState } from "react";

import { ApiError, api } from "@/lib/api/client";
import type { HueArea, HueBridge, HueHealth } from "@/lib/api/types";
import { pickArea } from "@/lib/hue-bridge";
import { useHueBridge } from "@/lib/hooks/use-hue-bridge";
import { usePersistedState } from "@/lib/hooks/use-persisted-state";

/**
 * Only the id is stored. The name belongs to the bridge and the user may rename
 * the area there; persisting it would show a label the Hue app disagrees with.
 */
const STORAGE_KEY = "yts.hue.area";

export interface HueState {
  health: HueHealth | null;
  loading: boolean;
  error: ApiError | null;
  refresh: () => void;

  bridges: HueBridge[];
  scanning: boolean;
  discover: () => void;
  pairing: boolean;
  pairError: ApiError | null;
  pair: (ip?: string) => void;
  cancelPair: () => void;

  areas: HueArea[];
  areasLoading: boolean;
  /** The area that would be streamed to. Derived, never written back. */
  area: HueArea | null;
  selectArea: (id: string) => void;

  streaming: boolean;
  /** A start or stop is in flight. */
  busy: boolean;
  streamError: ApiError | null;
  start: () => void;
  stop: () => void;
  /**
   * Called by the render loop when pushing a colour fails. The stream is gone —
   * bridge timeout, another app taking the slot — and only a health read can
   * say which, so this re-reads rather than guessing.
   */
  reportStreamLost: () => void;
}

/**
 * Everything the Hue UI needs: which bridge, which area, and whether the lights
 * are being driven.
 *
 * Composed from `useHueBridge` plus the area list, the way `useSpeaker` is
 * composed from `useDevices` plus a persisted choice. Kept as one hook because
 * the three are one decision chain — no bridge means no areas, no area means
 * nothing to stream to — and splitting them across the component tree would
 * mean two copies of `health` that disagree for a render.
 */
export function useHue(): HueState {
  const bridge = useHueBridge();
  const paired = bridge.health?.paired ?? false;

  // -- Areas ---------------------------------------------------------------

  /*
   * Areas belong to a bridge, so they are stored *with* the bridge they came
   * from and matched during render rather than cleared by an effect.
   *
   * Two things fall out of that which a plain list plus a reset would get
   * wrong. Un-pairing empties the list immediately, instead of leaving areas on
   * screen that have no bridge behind them until an effect catches up — the
   * user would pick one and get an unexplained failure from `start`. And
   * switching bridges reports as loading rather than briefly showing the old
   * bridge's areas under the new bridge's name.
   */
  const [fetched, setFetched] = useState<{ bridge: string; areas: HueArea[] } | null>(null);

  const bridgeKey = bridge.health?.bridge_id ?? bridge.health?.bridge_ip ?? "";
  const matched = paired && fetched?.bridge === bridgeKey;
  const areas = matched ? fetched.areas : [];
  const areasLoading = paired && !matched;

  useEffect(() => {
    if (!paired) return;
    const controller = new AbortController();
    api
      .hueAreas(controller.signal)
      .then(({ areas: found }) => {
        if (controller.signal.aborted) return;
        setFetched({ bridge: bridgeKey, areas: found });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        // Recorded as an empty result, not left pending: the dialog says "no
        // areas" either way, and a hook that stayed `areasLoading` forever
        // would spin a placeholder at a bridge that is simply not answering.
        // Deliberately quiet otherwise — `bridge.error` carries the failure,
        // and a toast here would fire again on every health refresh while a
        // bridge reboots.
        setFetched({ bridge: bridgeKey, areas: [] });
      });
    return () => controller.abort();
  }, [paired, bridgeKey]);

  const [savedArea, setSavedArea] = usePersistedState<string | null>(STORAGE_KEY, null);

  /*
   * Prefer the area the bridge says it is *actually* streaming to.
   *
   * The stream can be started by something other than this browser — another
   * tab, a phone, a restart that resumed it — and in that case the saved id is
   * a stale preference while `health.area` is the truth. Showing the preference
   * would put the controls on one area while the lights followed another.
   */
  const live = bridge.health?.streaming ? bridge.health.area : null;
  const area = pickArea(areas, live ?? savedArea);

  const selectArea = useCallback(
    (id: string) => setSavedArea(id),
    [setSavedArea],
  );

  // -- Stream --------------------------------------------------------------

  const [busy, setBusy] = useState(false);
  const [streamError, setStreamError] = useState<ApiError | null>(null);
  const { refresh } = bridge;

  const run = useCallback(
    (call: () => Promise<unknown>) => {
      setBusy(true);
      setStreamError(null);
      call()
        .catch((cause: unknown) => {
          setStreamError(
            cause instanceof ApiError ? cause : new ApiError("The light stream failed", 0),
          );
        })
        .finally(() => {
          setBusy(false);
          // Always, including after a failure: a start that timed out client
          // side may well have succeeded, and the only way to know what the
          // bridge ended up doing is to ask.
          refresh();
        });
    },
    [refresh],
  );

  const start = useCallback(() => {
    if (!area) return;
    run(() => api.hueStartStream(area.id));
  }, [area, run]);

  const stop = useCallback(() => run(() => api.hueStopStream()), [run]);

  return {
    ...bridge,
    areas,
    areasLoading,
    area,
    selectArea,
    streaming: bridge.health?.streaming ?? false,
    busy,
    streamError,
    start,
    stop,
    reportStreamLost: refresh,
  };
}
