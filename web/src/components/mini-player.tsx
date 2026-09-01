"use client";

import { ChevronUp, Music } from "lucide-react";

import { Equalizer } from "@/components/equalizer";
import type { MiniPlayerView } from "@/lib/shell";
import { cn } from "@/lib/utils";

/**
 * The bar that keeps what's playing on screen after the listener leaves the
 * Player tab.
 *
 * Deliberately not a control surface. It carries no play/pause and no skip:
 * every one of those would have to be a `<button>` inside the bar, and the bar
 * itself is a button — nested interactive elements are invalid, and the usual
 * fix (a `<div>` with an absolutely-positioned tap target) puts a skip button
 * within a thumb's width of the target on a 4.5rem bar. One tap gets you to the
 * card that has all three controls at full size, which is the trade this makes.
 *
 * Hidden above 900px, where the now-playing card is permanently on screen and
 * this would be a second copy of it.
 */
export function MiniPlayer({ view, onOpen }: { view: MiniPlayerView; onOpen: () => void }) {
  // `visible` is decided in `describeMiniPlayer`, not here — the page also has
  // to reserve this bar's height in flow, and both answers have to come from
  // the same place or the spacer outlives the bar.
  if (!view.visible) return null;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${view.subtitle}: ${view.title}. Open the player.`}
      className={cn(
        "glass-bar fixed inset-x-0 z-30 flex items-center gap-3 px-4 text-left min-[901px]:hidden",
        // Sits directly on top of the tab bar, which is itself lifted by the
        // home indicator — so this has to clear both or it renders behind it.
        "bottom-[calc(var(--tab-bar)+env(safe-area-inset-bottom))] h-[var(--mini-player)]",
        "animate-in duration-300 slide-in-from-bottom-4 fade-in",
        "cursor-pointer transition-colors active:bg-white/[0.06]",
      )}
    >
      {view.thumbnail ? (
        // A plain <img>, for the same reason as the queue rows: these are
        // YouTube CDN hosts that rotate, and next/image would proxy a 48px
        // thumbnail through the Next server to reach a client that can already
        // fetch it directly.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={view.thumbnail}
          alt=""
          className="size-12 shrink-0 rounded-lg bg-white/[0.05] object-cover"
        />
      ) : (
        <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-white/[0.05] text-muted-foreground">
          <Music aria-hidden className="size-4" />
        </span>
      )}

      <span className="flex min-w-0 grow flex-col gap-[0.1rem]">
        <span className="truncate text-[0.9rem] font-semibold">{view.title}</span>
        <span className="truncate text-[0.75rem] text-muted-foreground">{view.subtitle}</span>
      </span>

      {/* Both of these are decoration for the same fact — that this is playing
          and that tapping opens it — so they share the row rather than
          competing for it. */}
      <Equalizer live={view.live} className="h-[15px] w-[21px] shrink-0" />
      <ChevronUp aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}
