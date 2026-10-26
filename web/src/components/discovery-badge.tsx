"use client";

import { cn } from "@/lib/utils";

/**
 * Discovery status badge for the settings page.
 *
 * Discovery is SSDP multicast, which fails in ways the user can actually fix —
 * wrong VLAN, speaker asleep, container without host networking — so "how many
 * speakers can I see" is shown alongside the speaker picker.
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
  if (scanning) return { tone: "scanning", text: "Escaneando…" };
  if (failed) return { tone: "offline", text: "Escaneo fallido" };
  if (count === 0) return { tone: "offline", text: "Sin altavoces" };
  return { tone: "online", text: `${count} altav${count === 1 ? "oz" : "oces"}` };
}

export function DiscoveryBadge({ discovery }: { discovery: DiscoveryStatus }) {
  const { tone, text } = describe(discovery);

  return (
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
  );
}
