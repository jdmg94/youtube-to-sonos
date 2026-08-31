// lucide v1 dropped brand marks, so the original's YouTube glyph is gone. This
// is the nearest generic shape — a play triangle in a rounded rect — and it
// keeps the wordmark carrying the meaning, which it already did.
import { SquarePlay } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The one place the app says anything about the network it lives on.
 *
 * Discovery is SSDP multicast, which fails in ways the user can actually fix —
 * wrong VLAN, speaker asleep, container without host networking — so "how many
 * speakers can I see" earns permanent screen space even though nothing else in
 * the header changes.
 */
export interface DiscoveryStatus {
  /** Speakers the last completed scan found. */
  count: number;
  /** A scan is in flight right now. */
  scanning: boolean;
  /** The last scan failed outright, as opposed to finding nothing. */
  failed: boolean;
}

/**
 * Ordered by urgency, not by data flow: "scanning" wins over a stale count so
 * pressing refresh visibly does something, and "failed" wins over "0 speakers"
 * because the two look identical to the user but only one is worth retrying.
 */
function describe({ count, scanning, failed }: DiscoveryStatus): {
  tone: "online" | "scanning" | "offline";
  text: string;
} {
  if (scanning) return { tone: "scanning", text: "Scanning…" };
  if (failed) return { tone: "offline", text: "Scan failed" };
  if (count === 0) return { tone: "offline", text: "No speakers" };
  return { tone: "online", text: `${count} speaker${count === 1 ? "" : "s"}` };
}

export function AppHeader({ discovery }: { discovery: DiscoveryStatus }) {
  const { tone, text } = describe(discovery);

  return (
    <header className="flex w-full max-w-[1200px] shrink-0 items-center justify-between px-4 pt-5 pb-3.5 min-[601px]:px-6 min-[601px]:pt-7 min-[601px]:pb-5">
      <div className="brand-gradient flex items-center gap-3 font-display text-[1.4rem] font-extrabold tracking-[-0.5px] min-[601px]:text-[1.8rem]">
        {/* Not `text-brand`: the icon is inside the gradient-clipped element, so
            it inherits the same red→gold wash as the wordmark. */}
        <SquarePlay aria-hidden className="size-[1.3rem] min-[601px]:size-[1.6rem]" />
        <span>YouTube ➔ Sonos</span>
      </div>

      {/* Polite, not assertive: the count changes on its own every rescan, and
          interrupting a screen reader mid-sentence for it would be hostile. */}
      <div
        aria-live="polite"
        className="flex items-center gap-2 rounded-full border border-border bg-white/5 px-4 py-2 text-[0.85rem] text-muted-foreground backdrop-blur-[10px]"
      >
        <span
          aria-hidden
          className={cn(
            "size-2 rounded-full transition-[background-color,box-shadow] duration-300",
            tone === "online" && "bg-ok shadow-[0_0_10px_var(--ok)]",
            tone === "scanning" && "animate-pulse-dot bg-gold shadow-[0_0_10px_var(--gold)]",
            tone === "offline" && "bg-[#6b7280]",
          )}
        />
        <span>{text}</span>
      </div>
    </header>
  );
}
