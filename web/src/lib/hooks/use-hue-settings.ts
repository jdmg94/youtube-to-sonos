"use client";

import { useEffect, useMemo, useRef } from "react";

import { api } from "@/lib/api/client";
import type { HueSettings } from "@/lib/api/types";
import { usePersistedState } from "@/lib/hooks/use-persisted-state";

const DEFAULT_SETTINGS: HueSettings = { brightness: 100, transition: 25, spread: 15 };

/**
 * One key per slider rather than one object.
 *
 * Three independent scalars are what they are, and storing them separately
 * means retuning one range later invalidates one key instead of resetting a
 * user's other two dials to the defaults along with it. It also keeps a corrupt
 * or hand-edited entry from taking the whole panel back to stock — a bad
 * `spread` key costs the spread, and `resolveSettings` clamps the rest.
 */
const KEYS = {
  brightness: "yts.hue.brightness",
  transition: "yts.hue.transition",
  spread: "yts.hue.spread",
} as const;

export interface HueSettingsState {
  /** Slider positions, 0..100, sent to the backend as-is. */
  settings: HueSettings;
  setBrightness: (position: number) => void;
  setTransition: (position: number) => void;
  setSpread: (position: number) => void;
}

/**
 * The three light-show dials, persisted.
 *
 * Deliberately separate from `useHue`: nothing here needs a bridge, an area or
 * a live stream, and folding it in would mean the settings panel re-rendered on
 * every health poll. It also means the sliders keep working — and keep saving —
 * while the bridge is unreachable.
 */
export function useHueSettings(): HueSettingsState {
  const [brightness, setBrightness] = usePersistedState<number>(
    KEYS.brightness,
    DEFAULT_SETTINGS.brightness,
  );
  const [transition, setTransition] = usePersistedState<number>(
    KEYS.transition,
    DEFAULT_SETTINGS.transition,
  );
  const [spread, setSpread] = usePersistedState<number>(KEYS.spread, DEFAULT_SETTINGS.spread);

  const settings = useMemo(
    () => ({ brightness, transition, spread }),
    [brightness, transition, spread],
  );

  // Send settings updates to backend when stream is running. Skip the initial
  // mount to avoid racing with the start call that already sends them.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    // Fire and forget: if the stream isn't running the backend ignores it, and
    // a failure here doesn't break the local sliders.
    api.hueUpdateSettings(settings).catch(() => {
      // Silent: the settings are persisted locally, so a dropped update recovers
      // on the next adjustment or the next stream start.
    });
  }, [settings]);

  return {
    // Memoised for a stable identity so the live-update effect doesn't fire on
    // every render, only when an actual slider moves.
    settings,
    setBrightness,
    setTransition,
    setSpread,
  };
}
