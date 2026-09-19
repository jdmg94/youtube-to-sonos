"use client";

import { Music } from "lucide-react";

import { Equalizer } from "@/components/equalizer";
import { PlayPause } from "@/components/play-pause";
import type { Device, NowPlaying } from "@/lib/api/types";
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
 * It carries exactly one control, and the argument that kept it at zero is the
 * reason it is this one. Skip was the problem: a 4.5rem row whose whole surface
 * opens the sheet cannot also hold a tap target that advances the queue, because
 * the mis-tap costs the listener the song they were enjoying and there is no
 * undo — Previous restarts the track rather than returning to it. Play/Pause is
 * the opposite trade. A mis-tap is undone by tapping again, and it is the
 * control wanted most often and least worth a sheet: the phone comes out of a
 * pocket for it and goes back in.
 *
 * So the row is a `<div>` with two siblings rather than a single `<button>` —
 * nested interactive elements are invalid, and this is the honest way out of it
 * rather than an absolutely-positioned tap target floating over a button. The
 * open half takes all the remaining width, so everything that used to be
 * tappable still is. The chevron it used to end with is gone: the bar is now
 * visibly a control surface, which is a better affordance than an arrow, and
 * the 44px button needs the room more than the arrow did.
 *
 * Hidden above 900px, where the player is a permanent sidebar panel and this
 * would be a second copy of it.
 */
export function PlayerBar({
  view,
  device,
  nowPlaying,
  expanded,
  onOpen,
}: {
  view: PlayerBarView;
  /** Passed through to `PlayPause`, which sends the command itself. */
  device: Device | null;
  nowPlaying: NowPlaying | null;
  /** The sheet this opens is showing, so the row is a redundant summary of it. */
  expanded: boolean;
  onOpen: () => void;
}) {
  return (
    <div
      className={cn(
        "glass-bar fixed inset-x-0 z-30 flex items-center gap-3 px-4 min-[901px]:hidden",
        // Sits directly on top of the tab bar, which is itself lifted by the
        // home indicator — so this has to clear both or it renders behind it.
        "bottom-[calc(var(--tab-bar)+env(safe-area-inset-bottom))] h-[var(--player-bar)]",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-haspopup="dialog"
        aria-expanded={expanded}
        aria-label={
          view.idle
            ? `${view.title}. Open the player.`
            : `${view.subtitle}: ${view.title}. Open the player.`
        }
        className={cn(
          "-mx-2 flex min-w-0 grow items-center gap-3 rounded-xl px-2 text-left",
          // The row's full height, so the tap target is the whole strip beside
          // the button and not just the text it encloses.
          "h-full cursor-pointer transition-colors active:bg-white/[0.06]",
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
      </button>

      {/*
       * Untinted, unlike the card's, which wears the ok accent while audio is
       * live. Beside a bar that already says so with the equalizer, a green
       * button would be the loudest thing on a phone screen for information
       * the row has given twice already.
       */}
      <PlayPause device={device} state={nowPlaying?.state} variant="compact" />
    </div>
  );
}
