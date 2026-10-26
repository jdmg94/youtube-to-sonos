"use client";

import { Waves } from "lucide-react";
import { useState } from "react";

import { ApiError, api } from "@/lib/api/client";
import type { Device } from "@/lib/api/types";
import { useErrorToast } from "@/lib/hooks/use-error-toast";
import { cn } from "@/lib/utils";

export interface CrossfadeToggleProps {
  /** The speaker being controlled. */
  device: Device | null;
  /** Current crossfade state from the now-playing payload. */
  crossfade: boolean | null;
}

/**
 * Crossfade toggle for the speaker.
 *
 * Unlike volume, crossfade IS on the event stream (in the now-playing payload),
 * so this is not optimistic — it renders what it was last told and sends the
 * change. The property is persistent on the speaker itself, so a setting made
 * here survives across stations and even across reboots.
 */
export function CrossfadeToggle({ device, crossfade }: CrossfadeToggleProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useErrorToast(error);

  if (!device || crossfade === null) return null;

  const handleToggle = async () => {
    if (!device || pending) return;

    setPending(true);
    setError(null);

    try {
      await api.setCrossfade({
        device_ip: device.ip,
        crossfade: !crossfade,
      });
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause
          : new ApiError("Could not update crossfade", 0),
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex animate-in flex-col gap-3 rounded-2xl border border-border bg-card px-[1.1rem] py-4 fade-in duration-300">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-[0.95rem] font-semibold">
          <Waves aria-hidden className="size-4 text-brand" />
          Crossfade
        </span>
        <button
          type="button"
          onClick={handleToggle}
          disabled={pending}
          aria-label={
            crossfade
              ? "Desactivar crossfade (transición entre canciones)"
              : "Activar crossfade (transición suave entre canciones)"
          }
          aria-pressed={crossfade}
          className={cn(
            "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 transition-all duration-200",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            crossfade
              ? "border-brand bg-brand"
              : "border-border bg-white/[0.05]",
            pending && "cursor-not-allowed opacity-50",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "pointer-events-none inline-block size-5 transform rounded-full bg-white shadow-lg ring-0 transition duration-200",
              crossfade ? "translate-x-5" : "translate-x-0",
            )}
          />
        </button>
      </div>
      <p className="text-[0.75rem] leading-relaxed text-muted-foreground">
        {crossfade
          ? "Las canciones se mezclan suavemente entre sí (2-3 segundos de solapamiento)."
          : "Las canciones se reproducen una tras otra sin solapamiento."}
      </p>
    </div>
  );
}
