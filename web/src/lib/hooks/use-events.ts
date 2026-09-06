"use client";

import { useEffect, useState } from "react";

import { api } from "@/lib/api/client";
import {
  isErrorFrame,
  type EventFrame,
  type EventMessage,
  type NowPlaying,
  type StationBody,
} from "@/lib/api/types";

/**
 * The live view of one speaker, pushed from `/api/events`.
 *
 * This is the only source of now-playing and station state in the app. Sonos
 * advances its own queue and the station loop runs server-side without asking
 * anyone, so the client is a subscriber here, never an owner: every action
 * (play, skip, jump) is a write whose result arrives back through this stream.
 * Nothing should optimistically patch what comes out of it.
 */

export type StreamStatus =
  /** No speaker selected — nothing to subscribe to. */
  | "idle"
  /** Opening the stream, or reopening it after a drop. */
  | "connecting"
  /** Frames are arriving. */
  | "live"
  /** Dropped; a reconnect is scheduled. Last known state is still shown. */
  | "reconnecting";

export interface EventsState {
  nowPlaying: NowPlaying | null;
  station: StationBody | null;
  status: StreamStatus;
  /**
   * The last error the *stream* reported, e.g. the speaker stopped answering.
   * Not fatal and not a connection failure — see the error-frame note below.
   */
  error: string | null;
}

interface InternalState extends EventsState {
  /** Which speaker the data above belongs to. */
  deviceIp: string | null;
}

const EMPTY: InternalState = {
  deviceIp: null,
  nowPlaying: null,
  station: null,
  status: "idle",
  error: null,
};

/**
 * Reconnect backoff.
 *
 * We close the stream ourselves on `error` and reopen on this schedule instead
 * of leaving it to `EventSource`, whose built-in retry is a flat ~3s forever.
 * That default is actively harmful here: when no speaker can be resolved the
 * server emits one error frame and *ends the stream*, so a flat retry becomes a
 * connection every 3s, each one running an SSDP multicast scan on the user's
 * LAN, for as long as the tab is open.
 */
export const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000];

/**
 * Subscribe to a speaker's event stream.
 *
 * Pass `null` to subscribe to nothing — which is what the app does until the
 * saved speaker has been read out of `localStorage`, so that a first paint
 * doesn't open a stream against "no device" and trigger a discovery scan.
 */
export function useEvents(deviceIp: string | null): EventsState {
  const [state, setState] = useState<InternalState>(EMPTY);

  useEffect(() => {
    // No reset here, and no `setState` anywhere in this effect body: the
    // render-time guard at the bottom already reports idle/connecting for a
    // speaker the state doesn't belong to, so writing it again would only buy
    // an extra render pass.
    if (!deviceIp) return;

    // `cancelled` rather than just closing the source: a reconnect may be
    // parked in a timer, and React 19's StrictMode runs this effect twice in
    // development, so teardown has to stop work that hasn't started yet.
    let cancelled = false;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    /**
     * Apply a change, dropping anything that belonged to a previous speaker.
     * Without this guard, switching speakers would briefly show the old one's
     * track under the new one's name.
     */
    const apply = (next: Partial<EventsState>) =>
      setState((prev) => ({
        ...(prev.deviceIp === deviceIp ? prev : EMPTY),
        deviceIp,
        ...next,
      }));

    const connect = () => {
      if (cancelled) return;
      const es = new EventSource(api.eventsUrl(deviceIp));
      source = es;

      es.onmessage = (event) => {
        let message: EventMessage;
        try {
          message = JSON.parse(event.data) as EventMessage;
        } catch {
          // A frame we can't parse says nothing about the ones after it.
          return;
        }

        if (isErrorFrame(message)) {
          // Deliberately keeps the last good `nowPlaying`/`station`. A failed
          // speaker poll is usually a blip; blanking the UI on one would make
          // the card flicker every time the speaker is slow to answer. If the
          // server closes after this, `onerror` handles it.
          apply({ status: "live", error: message.error });
          return;
        }

        // A real frame is the only proof the connection is healthy — the
        // server accepts the socket and *then* discovers it can't serve the
        // speaker, so "opened" means nothing on its own.
        attempt = 0;
        const frame = message as EventFrame;
        apply({
          status: "live",
          nowPlaying: frame,
          station: frame.station,
          error: null,
        });
      };

      es.onerror = () => {
        // Fires for a transient drop (readyState CONNECTING) and a hard
        // failure alike. We close in both cases so reconnection is ours, and
        // an unclosed source can't reconnect underneath the scheduled one.
        es.close();
        if (cancelled) return;
        const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
        attempt += 1;
        apply({ status: "reconnecting" });
        timer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      source?.close();
    };
  }, [deviceIp]);

  // Derived during render, not reset in an effect: an effect would let one
  // frame paint with the previous speaker's data still on screen.
  if (state.deviceIp !== deviceIp) {
    return {
      nowPlaying: null,
      station: null,
      status: deviceIp ? "connecting" : "idle",
      error: null,
    };
  }
  return state;
}
