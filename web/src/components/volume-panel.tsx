"use client";

import { Sliders, Volume, Volume1, Volume2, VolumeX } from "lucide-react";

import { Slider } from "@/components/ui/slider";
import type { Device } from "@/lib/api/types";
import { useErrorToast } from "@/lib/hooks/use-error-toast";
import { useVolume } from "@/lib/hooks/use-volume";
import { cn } from "@/lib/utils";
import { VOLUME_PRESETS, volumeIcon, type VolumeIcon } from "@/lib/volume";

export interface VolumePanelProps {
  /** The speaker being controlled. Nothing renders without one. */
  device: Device | null;
}

/**
 * The speaker's level and mute.
 *
 * The one panel on this page that does not read from the event stream. Volume
 * isn't on it — it is read once when the speaker is chosen and thereafter this
 * component is the truth, which is why `useVolume` is optimistic and why the
 * only thing that can contradict it is a failed write.
 *
 * Nothing renders until that first read lands. A slider parked at 0 looks like
 * a real value, and the listener who drags it up from there is correcting a
 * number the speaker never reported.
 */
export function VolumePanel({ device }: VolumePanelProps) {
  const { volume, muted, ready, error, setVolume, toggleMute } = useVolume(device?.ip ?? null);

  useErrorToast(error);

  if (!device || !ready) return null;

  const icon = volumeIcon(volume, muted);
  const MuteIcon = MUTE_ICON[icon];

  return (
    <div className="flex animate-in flex-col gap-4 rounded-2xl border border-border bg-card px-[1.1rem] py-4 fade-in duration-300">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-[0.95rem] font-semibold">
          <Sliders aria-hidden className="size-4 text-gold" />
          Volume
        </span>
        {/*
         * The number is not `aria-live`. The slider's own `aria-valuenow`
         * already announces every step to a screen reader, and a live region
         * saying the same thing turns one drag into a stream of duplicate
         * announcements.
         */}
        <span
          aria-hidden
          className="min-w-[3ch] text-right font-display text-[1.1rem] font-semibold text-gold"
        >
          {volume}
        </span>
      </div>

      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={toggleMute}
          aria-label={muted ? "Unmute speaker" : "Mute speaker"}
          /*
           * `aria-pressed` and not a checkbox: this is a toggle button whose
           * label changes with its state, and the pressed state is the only
           * thing distinguishing "muted" from "turned down" to a screen reader
           * — the icon that carries it visually is `aria-hidden`.
           */
          aria-pressed={muted}
          title={muted ? "Unmute" : "Mute"}
          className={cn(
            "flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-[10px] border transition-all duration-200",
            muted
              ? "border-brand/30 bg-brand/[0.08] text-brand"
              : "border-border bg-transparent text-muted-foreground hover:border-white/20 hover:bg-white/[0.08] hover:text-foreground",
          )}
        >
          <MuteIcon aria-hidden className="size-[1.1rem]" />
        </button>

        {/*
         * `h-10` on the wrapper, not on the slider. The track is 6px and the
         * thumb 22px; without a row that tall the thumb overflows into the
         * header above and the presets below, and on a touch screen the
         * grabbable area is the 6px track rather than the 40px row.
         */}
        <div className="flex h-10 grow items-center">
          <Slider
            aria-label="Volume"
            value={[volume]}
            min={0}
            max={100}
            step={1}
            onValueChange={([next]) => setVolume(next)}
            className={cn(
              "[&_[data-slot=slider-track]]:h-1.5 [&_[data-slot=slider-track]]:bg-white/10",
              "[&_[data-slot=slider-range]]:bg-gold",
              // `border-background` rather than the original's hardcoded
              // #1a1f30: the thumb sits on the card, and a literal cut a shade
              // off the surface reads as a ring rather than as a gap.
              "[&_[data-slot=slider-thumb]]:size-[22px] [&_[data-slot=slider-thumb]]:border-[3px] [&_[data-slot=slider-thumb]]:border-background [&_[data-slot=slider-thumb]]:bg-gold",
              "[&_[data-slot=slider-thumb]]:shadow-[0_0_12px_rgba(212,175,55,0.4)] [&_[data-slot=slider-thumb]]:hover:scale-120 [&_[data-slot=slider-thumb]]:hover:shadow-[0_0_18px_rgba(212,175,55,0.6)]",
            )}
          />
        </div>
      </div>

      <div className="flex gap-[0.4rem]">
        {VOLUME_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => setVolume(preset)}
            aria-label={`Set volume to ${preset}`}
            className="flex-1 cursor-pointer rounded-lg border border-border bg-white/[0.05] py-[0.35rem] text-center text-[0.72rem] font-medium text-muted-foreground transition-all duration-200 hover:border-gold/30 hover:bg-gold/[0.12] hover:text-gold"
          >
            {preset}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Four glyphs for four states.
 *
 * `Volume` (no waves) for zero and `VolumeX` for muted are the pair that has to
 * stay distinct — see `volumeIcon`. `Volume1`/`Volume2` are a gauge and nothing
 * depends on which of them is showing.
 */
const MUTE_ICON: Record<VolumeIcon, typeof Volume> = {
  muted: VolumeX,
  off: Volume,
  low: Volume1,
  high: Volume2,
};
