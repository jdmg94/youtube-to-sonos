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
