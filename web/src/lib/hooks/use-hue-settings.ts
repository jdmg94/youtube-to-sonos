"use client";

import { useMemo } from "react";

import { DEFAULT_SETTINGS, type HueSettings, type ResolvedSettings, resolveSettings } from "@/lib/hue";
import { usePersistedState } from "@/lib/hooks/use-persisted-state";

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
  /** Slider positions, 0..100, for the controls to render. */
  settings: HueSettings;
  /** The same three in palette units, for the render loop. */
  resolved: ResolvedSettings;
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

  return {
    settings,
    // Memoised for a stable identity: the render loop reads this every tick and
    // a fresh object each render would churn its effect dependencies.
    resolved: useMemo(() => resolveSettings(settings), [settings]),
    setBrightness,
    setTransition,
    setSpread,
  };
}
