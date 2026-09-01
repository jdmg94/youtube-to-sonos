"use client";

import { cn } from "@/lib/utils";

/**
 * The four-bar "audible" motif, shared by the now-playing card and the mini
 * player.
 *
 * Its own file because both surfaces are on screen in the same session — the
 * card on the Player tab, the bar everywhere else — and a listener switching
 * tabs would see the two animations disagree if each owned its own copy of the
 * delays below.
 */

/**
 * Animation delays, in source order. Not a uniform ramp: 0.25s and 0.5s put
 * bars 2 and 3 a third and two thirds through an 0.8s cycle, and the fourth is
 * pulled back to 0.15s so the row never reads as a wave travelling left to
 * right.
 */
const EQ_DELAYS = ["0s", "0.25s", "0.5s", "0.15s"];

export function Equalizer({ live, className }: { live: boolean; className?: string }) {
  return (
    <span aria-hidden className={cn("flex h-[18px] w-[25px] items-end gap-[3px]", className)}>
      {EQ_DELAYS.map((delay) => (
        <span
          key={delay}
          style={{ animationDelay: delay }}
          className={cn(
            "w-[3px] rounded-[1.5px]",
            // Paused holds the bars at a flat 55%: still four bars, visibly not
            // moving. Hiding them would make "paused" and "nothing selected"
            // look the same in a 40px square.
            live ? "h-full animate-eq-bounce bg-ok" : "h-[55%] bg-muted-foreground",
          )}
        />
      ))}
    </span>
  );
}
