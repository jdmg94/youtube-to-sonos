"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, api } from "@/lib/api/client";
import type { StationBody } from "@/lib/api/types";
import { describeJump, describeRemove, indexOfTrack, pendingStation } from "@/lib/queue";

/**
 * The queue panel's two writes, made optimistic.
 *
 * The rest of the app is a pure subscriber to `/api/events` — it renders the
 * last frame and never patches it. This hook is the one exception, and it is
 * narrow on purpose: a removal is the only action whose result the listener is
 * *already sure of* before the server answers. Waiting out a round trip and a
 * poll to see a row disappear turned "drop these three songs" into three
 * sequential waits with every other X disabled in between, which is what this
 * replaces.
 *
 * The patch is a subtraction, not an edit: a set of ids the panel hides. It is
 * applied outside the stream by `pendingStation` and reaped as soon as a frame
 * stops listing the id, so the stream stays the only source of truth and the
 * divergence can only ever last as long as one round trip.
 *
 * Two invariants make that safe, and both are the difference between a working
 * queue and one that silently deletes or plays the wrong song:
 *
 * 1. **One write at a time.** Every request goes on a promise chain, so an
 *    index is worked out against a settled world. Two X's clicked from the
 *    same render carry indices computed against the same list, and the first
 *    removal renumbers the second.
 * 2. **Indices are resolved at dispatch, from the id.** A row's index is a
 *    fact about the render it was drawn in; by the time its request leaves,
 *    frames have landed and earlier removals have renumbered the list.
 */

export interface QueueActions {
  /** The station as the panel should draw it — see `pendingStation`. */
  station: StationBody | null;
  /** Play the track with this id, wherever it now sits. */
  jump: (id: string) => void;
  /** Drop it from the queue. The row goes immediately. */
  remove: (id: string) => void;
  /**
   * A jump is on the wire. Unlike a removal there is nothing optimistic to
   * show for it — the speaker either moves or it doesn't — and only one can
   * win, so the rows wait.
   */
  jumpPending: boolean;
  /**
   * The last refusal or failure, for `useErrorToast`. Refusals the client
   * catches itself are `ApiError`s too, so that the panel has one channel to
   * report rather than two.
   */
  error: ApiError | null;
}

const NOTHING: ReadonlySet<string> = new Set();

export function useQueueActions(
  station: StationBody | null,
  deviceIp: string | undefined,
): QueueActions {
  /**
   * Ids whose rows are hidden: clicked, and not yet either confirmed by a
   * frame or put back by a failure. This is what the panel draws against.
   */
  const [hidden, setHidden] = useState<ReadonlySet<string>>(NOTHING);
  const [jumpPending, setJumpPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  /**
   * Ids the *server* has already dropped but a frame has not yet caught up
   * with. A strict subset of `hidden`, and the two are not interchangeable:
   * `hidden` is what to draw, `applied` is what the last frame is wrong about,
   * and only the latter may be subtracted when working out an index to send.
   * Three X's clicked in a row put three ids in `hidden` and none in `applied`
   * — subtracting all three would send the first request two positions short.
   */
  const applied = useRef<Set<string>>(new Set());
  /**
   * `hidden` again, as a ref. A write reads it from a promise callback, which
   * is not a render and cannot see the state.
   */
  const hiddenRef = useRef<ReadonlySet<string>>(NOTHING);

  const hide = useCallback((id: string, on: boolean) => {
    const next = new Set(hiddenRef.current);
    if (on) next.add(id);
    else next.delete(id);
    hiddenRef.current = next;
    setHidden(next);
  }, []);

  // The latest frame and speaker, for the same reason: a queued write is
  // dispatched long after the render that scheduled it.
  const latest = useRef({ station, deviceIp });
  useEffect(() => {
    latest.current = { station, deviceIp };
  });

  /**
   * Reap ids the stream has caught up with — the server's acknowledgement,
   * and the only thing that ends the divergence. Clearing on a frame that
   * omits the id also covers the cases nobody removed anything for: a refresh,
   * a new station, a different speaker.
   */
  useEffect(() => {
    if (hiddenRef.current.size === 0 && applied.current.size === 0) return;
    const live = new Set(station?.tracks.map((track) => track.id) ?? []);
    for (const id of applied.current) if (!live.has(id)) applied.current.delete(id);
    if ([...hiddenRef.current].every((id) => live.has(id))) return;
    const next = new Set([...hiddenRef.current].filter((id) => live.has(id)));
    hiddenRef.current = next;
    setHidden(next);
  }, [station]);

  /**
   * The write queue. `.then(task, task)` rather than a `.catch`: a task never
   * throws, and a chain that could break would strand every write after it.
   */
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = useCallback((task: () => Promise<void>) => {
    chain.current = chain.current.then(task, task);
  }, []);

  /**
   * The list as the server has it right now: the last frame, corrected for the
   * removals it predates. Reads only refs, so it is safe to close over from a
   * write that was queued several renders ago.
   */
  const serverView = useCallback(
    () => pendingStation(latest.current.station, applied.current),
    [],
  );

  const remove = useCallback(
    (id: string) => {
      hide(id, true);
      enqueue(async () => {
        const view = serverView();
        const at = indexOfTrack(view, id);
        if (at < 0) {
          // Something else took it first — a refresh, a rebuilt station. The
          // listener wanted it gone and it is gone; an error would be a lie.
          hide(id, false);
          return;
        }
        const decision = describeRemove(view, at);
        if (!decision.ok) {
          // Reachable in one way that matters: the speaker advanced onto this
          // track while the request was queued. It has to come back on screen.
          hide(id, false);
          setError(new ApiError(decision.message, 409));
          return;
        }
        try {
          await api.removeTrack({
            device_ip: latest.current.deviceIp,
            index: decision.index,
            id,
          });
          applied.current.add(id);
        } catch (cause) {
          hide(id, false);
          setError(asApiError(cause));
        }
      });
    },
    [enqueue, hide, serverView],
  );

  const jump = useCallback(
    (id: string) => {
      setJumpPending(true);
      enqueue(async () => {
        try {
          const view = serverView();
          const decision = describeJump(view, indexOfTrack(view, id));
          if (!decision.ok) {
            setError(new ApiError(decision.message, 409));
            return;
          }
          await api.transport({
            device_ip: latest.current.deviceIp,
            action: "jump",
            index: decision.index,
          });
        } catch (cause) {
          setError(asApiError(cause));
        } finally {
          setJumpPending(false);
        }
      });
    },
    [enqueue, serverView],
  );

  const view = useMemo(() => pendingStation(station, hidden), [station, hidden]);

  return { station: view, jump, remove, jumpPending, error };
}

/** An abort is our own teardown; everything else is worth reporting. */
function asApiError(cause: unknown): ApiError {
  if (cause instanceof ApiError) return cause;
  return new ApiError(cause instanceof Error ? cause.message : "Something went wrong", 0);
}
