"use client";

import { useCallback, useEffect, useState } from "react";

import { ApiError, api } from "@/lib/api/client";
import type { Device } from "@/lib/api/types";

export interface DevicesState {
  devices: Device[];
  loading: boolean;
  error: ApiError | null;
  /** Rescan. The list is not live — Sonos is only found when we go looking. */
  refresh: () => void;
}

/**
 * The speakers on the LAN.
 *
 * `/api/devices` is an SSDP multicast scan, not a lookup: it takes seconds, it
 * is not cached server-side, and it can come back short if a speaker is slow
 * to answer. So this scans once and then only on demand — polling it would put
 * a multicast burst on the user's network every interval to learn nothing. A
 * speaker that appears later is found by pressing refresh.
 */
export function useDevices(): DevicesState {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  // Refresh is a bump rather than a function that fetches, so the scan lives
  // entirely in the effect. That gives cancellation for free: React tears down
  // the previous run before starting the next, so an impatient double-click
  // can't leave two multicast scans racing to set the list.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api
      .devices(controller.signal)
      .then((found) => {
        if (controller.signal.aborted) return;
        setDevices(found);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          cause instanceof ApiError ? cause : new ApiError("Could not scan for speakers", 0),
        );
        // The previous list is left in place on purpose: a failed rescan is no
        // reason to forget speakers we already found and may still be playing.
        setLoading(false);
      });
    return () => controller.abort();
  }, [attempt]);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    setAttempt((n) => n + 1);
  }, []);

  return { devices, loading, error, refresh };
}
