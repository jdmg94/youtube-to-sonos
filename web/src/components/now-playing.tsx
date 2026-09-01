"use client";

import { Loader2, SkipBack, SkipForward, Square } from "lucide-react";
import { toast } from "sonner";

import { Equalizer } from "@/components/equalizer";
import { api } from "@/lib/api/client";
import type { Device, NowPlaying, StationBody } from "@/lib/api/types";
import { useAction } from "@/lib/hooks/use-action";
import { useErrorToast } from "@/lib/hooks/use-error-toast";
import { useTrackChange } from "@/lib/hooks/use-track-change";
import { canGoNext, canGoPrevious, describeNowPlaying } from "@/lib/now-playing";
import { cn } from "@/lib/utils";

export interface NowPlayingCardProps {
  /** The speaker being controlled. Nothing renders without one. */
  device: Device | null;
  nowPlaying: NowPlaying | null;
  station: StationBody | null;
}

/**
 * What the speaker is doing, and the three controls that change it.
 *
 * Everything shown here is read from the event stream and nothing is written
 * back to it. Prev, Next and Stop are commands whose effect arrives a poll
 * later on the same connection — up to `EVENT_POLL_INTERVAL` (2s) — so a press
 * is acknowledged by the button going busy and by a toast, not by the card
 * changing. That lag is the price of having one source of truth: Sonos is
 * advancing this queue on its own schedule, and a card that patched itself
 * would be arguing with the speaker every few seconds over who is right.
 */
export function NowPlayingCard({ device, nowPlaying, station }: NowPlayingCardProps) {
  const deviceIp = device?.ip;

  const transport = useAction((action: "prev" | "next") =>
    api.transport({ device_ip: deviceIp, action }),
  );
  const stop = useAction(async () => {
    const result = await api.stop(deviceIp);
    toast.success(`Playback stopped on ${result.device}`);
    return result;
  });

  useErrorToast(transport.error);
  useErrorToast(stop.error);

  const view = describeNowPlaying(nowPlaying, device?.name ?? null);
  useTrackChange(view.mode, view.title, (title) => toast(`Now playing: ${title}`));

  if (!device) return null;

  const live = view.mode === "playing";

  return (
    <div
      className={cn(
        "flex animate-in flex-col gap-[0.85rem] rounded-xl border px-[1.1rem] py-4 fade-in duration-300",
        "transition-[background-color,border-color]",
        live ? "border-ok/15 bg-ok/[0.05]" : "border-border bg-white/[0.04]",
      )}
    >
      <div className="flex min-w-0 items-center gap-[0.85rem]">
        <span
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-[10px] transition-colors duration-300",
            live ? "bg-ok/[0.12]" : "bg-white/[0.06]",
          )}
        >
          <Equalizer live={live} />
        </span>

        <span className="flex min-w-0 grow flex-col gap-[0.15rem]">
          <span className="text-[0.72rem] font-bold uppercase tracking-[0.06em] text-muted-foreground">
            {view.label}
          </span>
          {/* `title` so a track whose name is wider than a phone can still be
              read, since there is nowhere to expand to. */}
          <span className="truncate text-base font-semibold" title={view.title}>
            {view.title}
          </span>
        </span>
      </div>

      <div className="flex items-center gap-[0.6rem]">
        <NavButton
          label="Previous track"
          icon={SkipBack}
          live={live}
          disabled={!canGoPrevious(station) || transport.pending}
          onClick={() => transport.run("prev")}
        />

        <button
          type="button"
          aria-label="Stop playback"
          onClick={() => stop.run()}
          disabled={stop.pending}
          className="flex grow cursor-pointer items-center justify-center gap-2 rounded-[14px] border border-border bg-white/[0.08] px-4 py-[0.6rem] text-[0.9rem] font-semibold transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] hover:-translate-y-0.5 hover:bg-white/[0.15] active:translate-y-0 disabled:pointer-events-none disabled:opacity-50"
        >
          {stop.pending ? (
            <Loader2 aria-hidden className="size-4 animate-spin" />
          ) : (
            <Square aria-hidden className="size-4" />
          )}
          Stop
        </button>

        <NavButton
          label="Next track"
          icon={SkipForward}
          live={live}
          disabled={!canGoNext(station) || transport.pending}
          onClick={() => transport.run("next")}
        />
      </div>
    </div>
  );
}

/**
 * Prev / Next.
 *
 * 44px on touch and on phones, 38px on a desktop pointer: these sit either side
 * of Stop, and a mis-tap here skips a song rather than doing nothing.
 */
function NavButton({
  label,
  icon: Icon,
  live,
  disabled,
  onClick,
}: {
  label: string;
  icon: typeof SkipBack;
  live: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-[10px] border transition-all duration-200 min-[601px]:size-[38px] pointer-coarse:size-11",
        "disabled:pointer-events-none disabled:opacity-35",
        live
          ? "border-ok/25 bg-ok/10 text-ok hover:-translate-y-px hover:bg-ok/20"
          : "border-border bg-white/[0.06] text-muted-foreground hover:-translate-y-px hover:bg-white/[0.12]",
      )}
    >
      <Icon aria-hidden className="size-[1.05rem]" />
    </button>
  );
}
