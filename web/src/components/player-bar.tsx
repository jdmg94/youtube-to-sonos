"use client";

import { ChevronUp, Music } from "lucide-react";

import { Equalizer } from "@/components/equalizer";
import type { PlayerBarView } from "@/lib/shell";
import { cn } from "@/lib/utils";

/**
 * The phone's playback row, pinned above the tab bar.
 *
 * It replaced a Player *tab*, and the difference that matters is that this
 * never goes away. The old mini player could hide itself whenever the speaker
 * was idle, because the tab it pointed at was still one tap away in the bar
 * below; now this row is the only door to the speaker picker, the volume
 * slider and the transport controls, so hiding it on an idle speaker would
 * strand a phone with no way to start anything. `describePlayerBar` gives it a
 * different sentence to say instead.
 *
 * Deliberately not a control surface. It carries no play/pause and no skip:
 * every one of those would have to be a `<button>` inside the bar, and the bar
 * itself is a button — nested interactive elements are invalid, and the usual
 * fix (a `<div>` with an absolutely-positioned tap target) puts a skip button
 * within a thumb's width of the target on a 4.5rem bar. One tap opens the sheet
 * that has all of them at full size, which is the trade this makes.
 *
 * Hidden above 900px, where the player is a permanent sidebar panel and this
 * would be a second copy of it.
 */
export function PlayerBar({
  view,
  expanded,
  onOpen,
}: {
  view: PlayerBarView;
  /** The sheet this opens is showing, so the row is a redundant summary of it. */
  expanded: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-label={
        view.idle ? `${view.title}. Open the player.` : `${view.subtitle}: ${view.title}. Open the player.`
      }
      className={cn(
        "glass-bar fixed inset-x-0 z-30 flex items-center gap-3 px-4 text-left min-[901px]:hidden",
        // Sits directly on top of the tab bar, which is itself lifted by the
        // home indicator — so this has to clear both or it renders behind it.
        "bottom-[calc(var(--tab-bar)+env(safe-area-inset-bottom))] h-[var(--player-bar)]",
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
        <span
          className={cn(
            "truncate text-[0.9rem] font-semibold",
            // Idle is an invitation, not a track. Dimming it keeps the row from
            // reading as a song called "Nothing playing".
            view.idle && "text-muted-foreground",
          )}
        >
          {view.title}
        </span>
        <span className="truncate text-[0.75rem] text-muted-foreground">{view.subtitle}</span>
      </span>

      {/* Dropped entirely when idle rather than shown at rest: four still bars
          are how this component draws "paused", and reusing them for "nothing
          loaded" would make the two states identical. */}
      {!view.idle && <Equalizer live={view.live} className="h-[15px] w-[21px] shrink-0" />}
      <ChevronUp aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}
