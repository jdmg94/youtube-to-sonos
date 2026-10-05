"use client";

import type { SonosTime } from "@/lib/api/types";
import { formatDuration, parseSonosTime } from "@/lib/format";

export interface TimelineProps {
  /** Current playback position from NowPlaying, as "H:MM:SS" */
  position: SonosTime | null;
  /** Total track duration from NowPlaying, as "H:MM:SS" */
  duration: SonosTime | null;
}

/**
 * Display-only timeline showing playback progress.
 *
 * Renders a progress bar with current position and total duration labels.
 * Updates every 2 seconds via the SSE stream — no client-side interpolation,
 * so the displayed position is exactly what Sonos reports.
 *
 * Returns `null` (renders nothing) when:
 * - Either position or duration is null/undefined
 * - Either parses as 0 (idle speaker reports "0:00:00" for both)
 * - Either is malformed
 *
 * This is correct for idle state: showing "0:00 / 0:00" with a full bar
 * would claim playback is happening when it's not.
 */
export function Timeline({ position, duration }: TimelineProps) {
  const positionSeconds = parseSonosTime(position);
  const durationSeconds = parseSonosTime(duration);

  // Render nothing if either time is missing or zero
  if (positionSeconds === null || durationSeconds === null) return null;

  // Cap progress at 100% — during transitions Sonos may report position > duration
  const progress = Math.min((positionSeconds / durationSeconds) * 100, 100);

  return (
    <div className="flex flex-col gap-1.5">
      {/* Progress bar */}
      <div className="h-1 w-full overflow-hidden rounded-full bg-white/[0.1]">
        <div
          className="h-full rounded-full bg-brand transition-[width] duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Time labels */}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{formatDuration(positionSeconds)}</span>
        <span>{formatDuration(durationSeconds)}</span>
      </div>
    </div>
  );
}
