/**
 * Display formatting shared across panels.
 *
 * A `.ts` file so Node can test it without a JSX transform, and separate from
 * the view models because more than one of them formats the same numbers.
 *
 * Only the analyzed-track card uses this today. The queue rows do not: the
 * station carries a `duration` per track, but a length next to a title in a
 * 300px column competes with the download status for the same few characters,
 * and the status is the half that changes. The original showed neither.
 */

import type { SonosTime } from "@/lib/api/types";

/** What a track with no known length shows. Not an error — live streams have one. */
export const NO_DURATION = "0:00";

/**
 * Seconds to `m:ss`, or `h:mm:ss` past an hour.
 *
 * Sonos itself reports `H:MM:SS` and this does not, deliberately: these are
 * song lengths, and "0:03:41" for a three-minute track reads as three *hours*
 * at a glance.
 *
 * Guards where the original didn't. It tested `!seconds`, which is right for
 * `null` and `0` but hands a negative straight through to the arithmetic and
 * renders `-1:-5`; and it never floored, so yt-dlp's occasional fractional
 * duration came out as `4:41.5`. Neither is reachable from a well-behaved
 * backend, which is exactly why neither would have been noticed.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return NO_DURATION;

  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  // Minutes are only zero-padded when an hours field precedes them: `4:41`,
  // but `1:04:41`.
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  return `${hours > 0 ? `${hours}:` : ""}${mm}:${String(secs).padStart(2, "0")}`;
}

/**
 * Parse Sonos time string ("H:MM:SS") to seconds.
 *
 * Sonos reports time as `H:MM:SS` strings in now-playing frames (duration and
 * position). This parses them to seconds for timeline calculations.
 *
 * Returns `null` for:
 * - `null` or `undefined` input
 * - Malformed strings (not matching H:MM:SS format)
 * - `"0:00:00"` (idle speaker — both duration and position are zero)
 *
 * Fractional seconds (e.g., "0:04:41.5") are floored, matching `formatDuration`.
 */
export function parseSonosTime(time: SonosTime | null | undefined): number | null {
  if (!time) return null;

  // Match H:MM:SS format, optional fractional seconds
  const match = /^(\d+):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(time);
  if (!match) return null;

  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = parseInt(match[3], 10);

  const total = hours * 3600 + minutes * 60 + seconds;

  // Idle speaker reports "0:00:00" for both duration and position
  return total === 0 ? null : total;
}
