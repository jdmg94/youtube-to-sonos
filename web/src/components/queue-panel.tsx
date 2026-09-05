"use client";

import { ArrowDown, ListMusic, Loader2, Music, Play, RefreshCw, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { api } from "@/lib/api/client";
import type { Device, StationBody } from "@/lib/api/types";
import { useAction } from "@/lib/hooks/use-action";
import { useErrorToast } from "@/lib/hooks/use-error-toast";
import {
  canRefresh,
  describeJump,
  describeQueue,
  describeRefresh,
  describeRemove,
  describeRemoved,
  NO_TRACKS,
  type QueueRow,
} from "@/lib/queue";
import { cn } from "@/lib/utils";

export interface QueuePanelProps {
  device: Device | null;
  station: StationBody | null;
}

/**
 * The station, as the server has it: what has played, what is on, what is next.
 *
 * A mirror of server state with two writes — clicking a row tells the speaker
 * to jump there, and an upcoming row's X drops it. Sonos owns this queue and
 * advances it on its own, so nothing here is patched locally: the list is
 * re-derived from every event frame, and both writes are acknowledged by the
 * next frame rather than by a local edit.
 */
export function QueuePanel({ device, station }: QueuePanelProps) {
  const deviceIp = device?.ip;

  const jump = useAction((index: number) =>
    api.transport({ device_ip: deviceIp, action: "jump", index }),
  );
  const refresh = useAction(async () => {
    const result = await api.refreshStation(deviceIp);
    toast.success(describeRefresh(result.dropped));
    return result;
  });
  const remove = useAction(async (index: number, id: string) => {
    const result = await api.removeTrack({ device_ip: deviceIp, index, id });
    // The server's title, not the row's: the row's is a render old, and the
    // whole point of naming the track is to confirm which one actually went.
    toast.success(describeRemoved(result.title));
    return result;
  });

  /*
   * Which row's X shows the spinner. `remove.pending` is one flag for the whole
   * action, so on its own it would spin every button on the list — and this
   * panel's entire failure mode is the listener not being sure which track a
   * click landed on. Held by video id rather than by index because the station
   * renumbers underneath it. Never cleared: it is only ever read alongside
   * `remove.pending`, and clearing it would need an effect for nothing.
   */
  const [removing, setRemoving] = useState<string | null>(null);

  useErrorToast(jump.error);
  useErrorToast(refresh.error);
  useErrorToast(remove.error);

  const rows = describeQueue(station);

  return (
    <div className="flex flex-1 flex-col">
      <div className="mb-4 flex shrink-0 items-center justify-between">
        <span className="flex items-center gap-2 text-[0.95rem] font-semibold">
          <ListMusic aria-hidden className="size-4 text-gold" />
          Queue
        </span>

        <button
          type="button"
          onClick={() => refresh.run()}
          disabled={!canRefresh(station, !!device, refresh.pending)}
          title="Discard what's queued ahead and fetch a fresh set of songs"
          className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-white/[0.05] px-[0.7rem] py-[0.3rem] text-[0.75rem] font-medium text-muted-foreground transition-all duration-200 hover:border-gold/35 hover:bg-gold/[0.12] hover:text-gold disabled:pointer-events-none disabled:opacity-45"
        >
          {refresh.pending ? (
            <Loader2 aria-hidden className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw aria-hidden className="size-3.5" />
          )}
          Refresh
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="py-4 text-center text-[0.85rem] text-muted-foreground">{NO_TRACKS}</p>
      ) : (
        /*
         * Two different bounding strategies, because the page behaves
         * differently either side of the breakpoint.
         *
         * Below 901px the page scrolls, so an unbounded list of forty tracks
         * would push everything after it out of reach — hence the `60vh` cap
         * and an internal scroll.
         *
         * Above it the page is locked to the viewport and the *sidebar column*
         * is the scroll region, so this list is left to its natural height.
         * Making it a second scroll region there is what collapsed it to zero:
         * as the only flexible child of a fixed-height column it absorbed every
         * pixel the panels above it needed.
         */
        <ul className="thin-scrollbar flex max-h-[60vh] grow flex-col gap-[0.4rem] overflow-y-auto pr-[0.4rem] min-[901px]:max-h-none min-[901px]:overflow-y-visible min-[901px]:pr-0">
          {/* Keyed by station index, not by title: the backfill that fills in a
              track's metadata would otherwise remount the row and drop the
              thumbnail it had already loaded. */}
          {rows.map((row) => (
            <li key={row.index}>
              <QueueItem
                row={row}
                disabled={!device}
                jumpDisabled={jump.pending}
                /*
                 * One removal at a time, and not only to stop a double-click.
                 * Two X's clicked from the same render carry indices computed
                 * against the same list, and the first removal renumbers the
                 * second — the server's id check turns that into a 409 rather
                 * than the wrong song, but a refusal the user has to
                 * understand is worse than a button that waits.
                 */
                removeDisabled={remove.pending}
                removing={remove.pending && removing === row.id}
                onJump={() => {
                  const decision = describeJump(station, row.index);
                  if (!decision.ok) {
                    toast.error(decision.message);
                    return;
                  }
                  void jump.run(decision.index);
                }}
                onRemove={() => {
                  const decision = describeRemove(station, row.index);
                  if (!decision.ok) {
                    toast.error(decision.message);
                    return;
                  }
                  setRemoving(decision.id);
                  void remove.run(decision.index, decision.id);
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One row: a jump button filling it, and an X for the tracks still to come.
 *
 * The row is a `<div>` wrapping two buttons rather than being a button itself,
 * which it has to be — a `<button>` cannot contain a `<button>`, and nesting
 * them produces markup browsers silently re-parse into siblings. The visual
 * chrome (border, background, hover) therefore lives on the wrapper, so the
 * whole row still lights up as one thing including under the X.
 */
function QueueItem({
  row,
  disabled,
  jumpDisabled,
  removeDisabled,
  removing,
  onJump,
  onRemove,
}: {
  row: QueueRow;
  /** No speaker to send anything to. Applies to both buttons. */
  disabled: boolean;
  jumpDisabled: boolean;
  removeDisabled: boolean;
  /** This row is the one being removed — spin its X, not every row's. */
  removing: boolean;
  onJump: () => void;
  onRemove: () => void;
}) {
  const Icon = ROW_ICON[row.status];

  return (
    <div
      className={cn(
        "group flex w-full items-center rounded-xl border transition-all duration-200",
        row.active
          ? "border-ok/30 bg-ok/[0.08]"
          : "border-transparent bg-white/[0.03] hover:bg-white/[0.07]",
        disabled && "opacity-50",
      )}
    >
      {/*
       * A row that can't be jumped to stays enabled. `disabled` here is only
       * "there is no speaker to send this to" or "a jump is already in flight"
       * — a track that is still downloading answers with a reason instead,
       * because a disabled row explains itself through a `title` tooltip that
       * does not exist on a phone, and "the track I tapped did nothing" is the
       * confusion this panel is most likely to cause.
       */}
      <button
        type="button"
        onClick={onJump}
        disabled={disabled || jumpDisabled}
        aria-current={row.active ? "true" : undefined}
        className="flex min-w-0 grow cursor-pointer items-center gap-3 p-2 text-left disabled:pointer-events-none"
      >
        {row.thumbnail ? (
          /*
           * A plain <img>. These are YouTube CDN URLs on hosts that change, and
           * next/image would need every one of them in `remotePatterns` — and
           * would then proxy a 48px thumbnail through the Next server on the way
           * to a LAN client that can already reach YouTube directly.
           */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={row.thumbnail}
            alt=""
            className="size-12 shrink-0 rounded-lg bg-white/[0.05] object-cover"
          />
        ) : (
          <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-white/[0.05] text-muted-foreground">
            <Music aria-hidden className="size-4" />
          </span>
        )}

        <span className="flex min-w-0 grow flex-col gap-[0.1rem]">
          <span className="truncate text-[0.9rem] font-semibold" title={row.title}>
            {row.title}
          </span>
          <span className="flex min-w-0 items-baseline gap-1 text-[0.75rem] text-muted-foreground">
            <span className="truncate">{row.uploader}</span>
            {/*
             * The status is its own element rather than being appended to the
             * uploader, so that truncation eats the channel name and not
             * "downloading…" — in a 300px sidebar a concatenated label loses its
             * tail first, which is the only half that changes.
             */}
            {row.statusLabel && (
              <span className="shrink-0 whitespace-nowrap">· {row.statusLabel}</span>
            )}
          </span>
        </span>

        {/*
         * No blink on the downloading arrow, unlike the original. `fa-fade`
         * animates `opacity`, which outranks the `opacity: 0` that hides this
         * icon until hover — so every still-downloading row showed a pulsing
         * arrow permanently while its neighbours showed nothing, which reads as
         * the only rows with an affordance. The status label says the same thing
         * in words and cannot fight the hover state for it.
         */}
        <Icon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 transition-opacity duration-200 group-hover:opacity-100",
            row.active ? "text-ok opacity-100" : "text-muted-foreground opacity-0",
          )}
        />
      </button>

      {/*
       * Absent, not disabled, on a row that has played or is playing: those can
       * never be removed, and a permanently dead button is a worse answer than
       * no button. Always visible on the rows that can — a hover-only control
       * does not exist on a phone, which is where most of this app is used.
       */}
      {row.removable && (
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled || removeDisabled}
          aria-label={`Remove ${row.title} from the queue`}
          title="Remove from the queue"
          className="mr-2 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors duration-200 hover:bg-destructive/15 hover:text-destructive disabled:pointer-events-none disabled:opacity-40"
        >
          {removing ? (
            <Loader2 aria-hidden className="size-3.5 animate-spin" />
          ) : (
            <X aria-hidden className="size-3.5" />
          )}
        </button>
      )}
    </div>
  );
}

/**
 * The trailing glyph. Hidden until hover except on the current track.
 *
 * It doubles as the affordance and as a second reading of the status: an arrow
 * means the bytes are still coming, a warning means they never will, and a play
 * triangle means clicking will work. `waiting` shares the play triangle with
 * `ready` — a queued track has nothing happening to it yet, and a distinct icon
 * for "nothing is happening" is noise on most of the list.
 */
const ROW_ICON = {
  ready: Play,
  downloading: ArrowDown,
  waiting: Play,
  unavailable: TriangleAlert,
} as const;
