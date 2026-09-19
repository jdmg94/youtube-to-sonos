"use client";

import { Loader2, Pause, Play } from "lucide-react";

import { api } from "@/lib/api/client";
import type { Device, PlaybackState } from "@/lib/api/types";
import { useAction } from "@/lib/hooks/use-action";
import { useErrorToast } from "@/lib/hooks/use-error-toast";
import { useTransportConfirm } from "@/lib/hooks/use-transport-confirm";
import { describeToggle, playbackMode } from "@/lib/now-playing";
import { cn } from "@/lib/utils";

export interface PlayPauseProps {
  /** The speaker being controlled. Nothing renders without one. */
  device: Device | null;
  /** The speaker's own report, straight off the event stream. */
  state: PlaybackState | null | undefined;
  /**
   * `wide` is the card's labelled button; `compact` is the square icon that
   * sits in the player bar, where there is no room for a word.
   */
  variant: "wide" | "compact";
  /** Card only: the ok tint the rest of the row wears while audio is live. */
  live?: boolean;
}

/**
 * The play/pause button, wherever it appears.
 *
 * One component rather than two because the interesting part is not the markup
 * — it is the four-step press sequence, and every step of it is a decision that
 * would have to be re-derived, and could be re-derived differently, in a second
 * copy:
 *
 *  - **Hold before sending.** `useTransportConfirm.hold` snapshots the state the
 *    listener was looking at when they clicked. Taking it after the round trip
 *    would snapshot a world the command has already changed.
 *  - **Send.** `/api/transport`, which moves the speaker and nothing else — the
 *    station keeps prefetching, the Sonos queue is untouched, the Hue stream
 *    stays connected. Stop is the command that ends things, and it lives only
 *    on the card.
 *  - **Release on refusal.** `useAction.run` resolves `undefined` rather than
 *    throwing, and a refused request is the one outcome no frame will ever
 *    describe: the speaker was never told anything, so the wait has to be ended
 *    by hand or the button sits out the full timeout for a command that never
 *    left.
 *  - **Otherwise wait for the stream.** A toggle renders the state it is about
 *    to change, so for up to one poll (`EVENT_POLL_INTERVAL`, 2s) after a press
 *    the frame still says PLAYING and the button still says "Pause". It stays
 *    disabled across that window rather than inviting the second press that
 *    would undo the first.
 *
 * Two of these can be on screen at once — the card inside the player sheet and
 * the compact one in the bar behind it — and they hold independent waits. That
 * is harmless, because the sheet's scrim covers the bar whenever the card is
 * visible, so only one is ever reachable.
 */
export function PlayPause({ device, state, variant, live = false }: PlayPauseProps) {
  const deviceIp = device?.ip;

  const toggle = useAction((action: "play" | "pause") =>
    api.transport({ device_ip: deviceIp, action }),
  );
  const confirm = useTransportConfirm(state);

  useErrorToast(toggle.error);

  const action = describeToggle(playbackMode(state));

  const press = async () => {
    if (!action) return;
    confirm.hold();
    if ((await toggle.run(action.action)) === undefined) confirm.release();
  };

  /*
   * The label stays "Play" when there is nothing to play, rather than going
   * blank or borrowing Stop's word: a disabled control still has to say what it
   * would do, and this one would start the track the card is not showing.
   */
  const label = action?.label ?? "Play";
  const busy = toggle.pending;
  const Icon = busy ? Loader2 : action?.action === "pause" ? Pause : Play;

  return (
    <button
      type="button"
      aria-label={`${label} playback`}
      title={variant === "compact" ? `${label} playback` : undefined}
      onClick={() => void press()}
      disabled={!device || !action || busy || confirm.awaiting}
      className={cn(
        "flex shrink-0 cursor-pointer items-center justify-center rounded-[14px] border transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] disabled:pointer-events-none disabled:opacity-50",
        variant === "wide"
          ? "grow gap-2 px-4 py-[0.6rem] text-[0.9rem] font-semibold hover:-translate-y-0.5 active:translate-y-0"
          : // 44px on touch, the same floor the card's icon buttons keep. The
            // bar is 64px tall and this has to be hittable with a thumb while
            // the rest of the row opens a sheet.
            "size-11",
        live
          ? "border-ok/25 bg-ok/10 text-ok hover:bg-ok/20"
          : "border-border bg-white/[0.08] hover:bg-white/[0.15]",
      )}
    >
      <Icon aria-hidden className={cn("size-4", busy && "animate-spin")} />
      {variant === "wide" && label}
    </button>
  );
}
