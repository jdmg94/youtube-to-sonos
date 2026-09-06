"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, api } from "@/lib/api/client";

/**
 * Volume is deliberately the one piece of optimistic state in this app.
 *
 * Everything else is owned by the server and pushed over SSE, so the UI only
 * ever renders what it was told. Volume is not on that stream: it is read once
 * per speaker and thereafter the slider is the truth. That inversion is what
 * makes optimism correct here — the value under the user's thumb has to track
 * the thumb, and a round trip per pixel would neither keep up nor be kind to
 * the speaker.
 */

/**
 * Matches the legacy UI. Long enough to collapse a drag into a few writes,
 * short enough that releasing the slider sounds immediate.
 */
const WRITE_DEBOUNCE_MS = 150;

interface Snapshot {
  /** Which speaker these numbers describe. */
  deviceIp: string;
  volume: number;
  muted: boolean;
}

export interface VolumeControl {
  volume: number;
  muted: boolean;
  /**
   * False until this speaker's volume has been read. The legacy UI hides the
   * whole panel until then rather than showing a slider parked at 0, which
   * would look like a real value and invite the user to drag it.
   */
  ready: boolean;
  /**
   * The last write the speaker refused.
   *
   * Needed precisely *because* the rest of this hook is optimistic: the slider
   * and the mute glyph have already moved by the time the request fails, so
   * without this the UI would sit there showing a muted speaker that is still
   * playing. The original had the inverse — a "Speaker muted" toast fired after
   * the response, and nothing at all when the write was refused.
   *
   * It is not cleared on success and does not need to be: it exists to be fed
   * to `useErrorToast`, which fires on identity change, and every failure
   * constructs a fresh `ApiError`.
   */
  error: ApiError | null;
  setVolume: (value: number) => void;
  toggleMute: () => void;
}

export function useVolume(deviceIp: string | null): VolumeControl {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /*
   * Which speaker is selected *now*, readable from a callback that fired
   * against a previous one. A mute is sent the instant it is pressed and
   * cannot be cancelled, so it can still be in flight when the user switches
   * rooms — and "Kitchen refused the command" reported under Lounge's name is
   * worse than saying nothing.
   */
  const activeIp = useRef(deviceIp);
  useEffect(() => {
    activeIp.current = deviceIp;
  }, [deviceIp]);

  const report = useCallback((ip: string, cause: unknown) => {
    if (activeIp.current !== ip) return;
    setError(
      cause instanceof ApiError
        ? cause
        : new ApiError("Could not reach the speaker", 0),
    );
  }, []);

  useEffect(() => {
    if (!deviceIp) return;
    const controller = new AbortController();
    api
      .getVolume(deviceIp, controller.signal)
      .then((state) => {
        if (controller.signal.aborted) return;
        setSnapshot({ deviceIp, volume: state.volume, muted: state.mute });
      })
      .catch(() => {
        // Left un-ready. A speaker that won't report its volume also won't
        // accept a new one, so offering the control would only produce a
        // slider that snaps back.
      });

    return () => {
      controller.abort();
      // Cancel any pending write. It carries the *previous* speaker's value
      // and has closed over the previous `deviceIp`, so letting it fire would
      // change the level on a speaker the user has already navigated away
      // from — and could land after the new speaker's initial read.
      clearTimeout(timer.current);
    };
  }, [deviceIp]);

  useEffect(() => () => clearTimeout(timer.current), []);

  // Anything the caller sees, and anything the callbacks act on, has to be
  // scoped to the speaker currently selected — a snapshot left over from the
  // previous one is not this speaker's volume.
  const current = snapshot && snapshot.deviceIp === deviceIp ? snapshot : null;

  const setVolume = useCallback(
    (value: number) => {
      if (!deviceIp) return;
      const clamped = Math.max(0, Math.min(100, Math.round(value)));
      setSnapshot((prev) =>
        prev && prev.deviceIp === deviceIp ? { ...prev, volume: clamped } : prev,
      );
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        // The response is discarded on success: it carries the number we just
        // sent, and applying it would fight the slider if the user is still
        // dragging. Only the failure is interesting.
        void api
          .setVolume({ device_ip: deviceIp, volume: clamped })
          .catch((cause: unknown) => report(deviceIp, cause));
      }, WRITE_DEBOUNCE_MS);
    },
    [deviceIp, report],
  );

  const toggleMute = useCallback(() => {
    if (!deviceIp || !current) return;
    const muted = !current.muted;
    setSnapshot({ ...current, muted });
    // The request is fired here rather than inside the state updater on
    // purpose: React invokes updaters more than once (StrictMode, and any
    // re-render it decides to discard), so a side effect in there would send
    // the speaker two mute commands for one click.
    //
    // Not debounced either — a mute is one deliberate press, and 150ms of
    // delay is audible as exactly the thing the user pressed it to stop.
    void api
      .setVolume({ device_ip: deviceIp, mute: muted })
      .catch((cause: unknown) => report(deviceIp, cause));
  }, [deviceIp, current, report]);

  return {
    volume: current?.volume ?? 0,
    muted: current?.muted ?? false,
    ready: current !== null,
    error,
    setVolume,
    toggleMute,
  };
}
