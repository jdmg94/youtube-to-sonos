"use client";

import { Loader2, Music, SkipBack, SkipForward, Square } from "lucide-react";
import { toast } from "sonner";

import { Equalizer } from "@/components/equalizer";
import { api } from "@/lib/api/client";
import type { Device, NowPlaying, StationBody } from "@/lib/api/types";
import { useAction } from "@/lib/hooks/use-action";
import { useClipped } from "@/lib/hooks/use-clipped";
import { useErrorToast } from "@/lib/hooks/use-error-toast";
import { useTrackChange } from "@/lib/hooks/use-track-change";
import { canGoNext, canGoPrevious, describeNowPlaying, trackArtwork } from "@/lib/now-playing";
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

  /*
   * Keyed on the title, because that is the only thing that changes the answer:
   * the element itself survives every track change, so a measurement taken on
   * mount would describe whichever song was playing when the card appeared.
   */
  const [titleRef, titleClipped] = useClipped<HTMLSpanElement>(view.title);

  if (!device) return null;

  const live = view.mode === "playing";
  const artwork = trackArtwork(station, view.mode);

  return (
    <div
      className={cn(
        "flex animate-in flex-col gap-[0.85rem] rounded-xl border px-[1.1rem] py-4 fade-in duration-300",
        "transition-[background-color,border-color]",
        live ? "border-ok/15 bg-ok/[0.05]" : "border-border bg-white/[0.04]",
      )}
    >
      {/*
       * The cover, and only while there is something to cover. `trackArtwork`
       * already returns null when idle; this drops the whole box rather than
       * rendering an empty one, because a 169px placeholder above "—" is a
       * bigger claim that something is loading than the em dash is that nothing
       * is.
       *
       * Between those two states is the one that matters: engaged with no URL
       * yet. That renders the placeholder at the same height, so the card does
       * not jump by a fifth of its size the moment the station frame lands.
       */}
      {view.mode !== "idle" && <Artwork src={artwork} />}

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
          {/*
           * `title` only when the name is genuinely cut off — a desktop
           * affordance, and only ever that: a native tooltip needs a hover, and
           * a touch screen has none to give. Setting it unconditionally (as
           * this did, justified by phones it never helped) puts a redundant OS
           * tooltip over the artwork a second after the pointer stops on any
           * title short enough to read in full.
           */}
          <span
            ref={titleRef}
            className="truncate text-base font-semibold"
            title={titleClipped ? view.title : undefined}
          >
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
 * The cover, sized 16:9 whatever shape the file is.
 *
 * YouTube's thumbnail is a 16:9 video still for most of the catalogue and a
 * square cover for anything sourced from YouTube Music, and the box cannot
 * change shape between songs without the whole card resizing under the
 * listener's cursor. Cropping the square to fit would cut the top and bottom
 * off the one artwork that is actually album art — so the image is drawn
 * twice: a blurred, over-scaled copy underneath to fill the frame, and the
 * real one `object-contain` on top, never cropped. A 16:9 source covers the
 * backdrop exactly and pays only for a second decode of an image the browser
 * already has cached. `scale-125` is what keeps `blur-2xl`'s 40px radius from
 * fading the edges of the backdrop into the panel.
 *
 * Plain `<img>` rather than `next/image` for the same two reasons the queue
 * rows and the player bar give: these URLs come from CDN hosts that rotate, so
 * every one would have to be listed in `remotePatterns`, and the optimiser
 * would proxy them through the Next server for a browser that can already
 * reach YouTube directly.
 *
 * `alt=""` and not the track title: the title is its own line immediately
 * below, and a screen reader announcing it twice describes a card that does
 * not exist.
 */
function Artwork({ src }: { src: string | null }) {
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-white/[0.05]">
      {src ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt=""
            aria-hidden
            className="absolute inset-0 size-full scale-125 object-cover blur-2xl"
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt="" className="relative size-full object-contain" />
        </>
      ) : (
        <span className="flex size-full items-center justify-center text-muted-foreground">
          <Music aria-hidden className="size-7" />
        </span>
      )}
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
