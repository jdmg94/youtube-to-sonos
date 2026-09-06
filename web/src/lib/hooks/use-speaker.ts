"use client";

import { useCallback } from "react";

import type { ApiError } from "@/lib/api/client";
import type { Device } from "@/lib/api/types";
import { useDevices } from "@/lib/hooks/use-devices";
import { usePersistedState } from "@/lib/hooks/use-persisted-state";

/**
 * Where the chosen speaker is remembered. Only the IP is stored: the name is
 * whatever the speaker calls itself on the current scan, so persisting it would
 * mean showing "Kitchen" for a speaker the user has since renamed to "Office".
 */
const STORAGE_KEY = "yts.speaker.ip";

export interface SpeakerSelection {
  devices: Device[];
  /** A discovery scan is in flight. */
  loading: boolean;
  error: ApiError | null;
  refresh: () => void;
  /** The speaker being controlled, or null when the scan has found none. */
  selected: Device | null;
  select: (device: Device) => void;
}

/**
 * Which speaker this app is controlling.
 *
 * The choice is *derived* from (stored IP, discovered speakers) on every
 * render, not copied into state by an effect. Deriving it is what makes an
 * absent speaker recoverable: if the saved one is missing from a scan we fall
 * back to the first found, but the saved IP is left alone, so when that speaker
 * wakes up the next scan silently returns to it. Writing the fallback back to
 * storage — which is what an effect would naturally do, and what the original
 * UI did do — permanently forgets the user's choice because a speaker happened
 * to be asleep when the page loaded.
 *
 * It also removes the frame where the app has a speaker but hasn't selected it
 * yet. That frame is not cosmetic: everything downstream keys off `deviceIp`,
 * so a null there opens an SSE connection and a volume read that are torn down
 * a moment later.
 */
export function useSpeaker(): SpeakerSelection {
  const { devices, loading, error, refresh } = useDevices();
  const [savedIp, setSavedIp] = usePersistedState<string | null>(STORAGE_KEY, null);

  const selected = devices.find((device) => device.ip === savedIp) ?? devices[0] ?? null;

  const select = useCallback(
    (device: Device) => {
      setSavedIp(device.ip);
    },
    [setSavedIp],
  );

  return { devices, loading, error, refresh, selected, select };
}
