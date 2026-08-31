/**
 * The stream controller's view models.
 *
 * Two decisions live here and neither belongs in a component: what an analyzed
 * video looks like when yt-dlp gave us almost nothing, and what a `/api/play`
 * response actually means — which is not obvious, because two of its three
 * outcomes are HTTP 200 with something other than "it's playing" inside.
 */
import { present, type PlayResponse, type VideoInfo } from "@/lib/api/types";
import { formatDuration } from "@/lib/format";

/** Shown for a video yt-dlp resolved but could not name. */
export const UNTITLED_VIDEO = "Untitled";

/**
 * Shown in place of a missing channel. Not "Unknown": the line sits directly
 * under the title in a smaller muted font, and a bare "Unknown" there reads as
 * a failure rather than as the label it is.
 */
export const UNKNOWN_UPLOADER = "YouTube Video";

export interface VideoView {
  title: string;
  uploader: string;
  /** Already formatted. `0:00` when the length is unknown. */
  duration: string;
  /**
   * A YouTube CDN URL, fetched by the *browser* — unlike `/media/<id>.jpg`,
   * which exists because Sonos speakers won't. `null` when there is none, so
   * the panel renders a placeholder instead of a broken image.
   */
  thumbnail: string | null;
}

/**
 * Fill in what `/api/info` left out.
 *
 * Every field but `id` is nullable, and `present()` rather than a falsy check
 * because the backend reports an absent title as `""` about as often as `null`.
 */
export function describeVideo(info: VideoInfo): VideoView {
  return {
    title: present(info.title) ? info.title : UNTITLED_VIDEO,
    uploader: present(info.uploader) ? info.uploader : UNKNOWN_UPLOADER,
    duration: formatDuration(info.duration),
    thumbnail: present(info.thumbnail) ? info.thumbnail : null,
  };
}

export interface CastOutcome {
  /** `false` means tell the user something went wrong, despite the 200. */
  ok: boolean;
  message: string;
}

/**
 * What actually happened, from a response that succeeded.
 *
 * Three outcomes, and only one of them is "the speaker is playing your song":
 *
 *  - `queued_next` — the track was inserted behind what's playing and is
 *    downloading. Nothing audible changed, so saying "casting" would be a lie
 *    the listener could hear.
 *  - `started: false` — the server enqueued the track, sent Play, and the
 *    speaker never reached PLAYING. The request succeeded and the room is
 *    silent. This is the one worth being loud about, because the alternative
 *    is a confident green card over nothing.
 *  - otherwise — playing.
 */
export function describeCast(result: PlayResponse): CastOutcome {
  if (result.queued_next) {
    const what = present(result.title) ? result.title : "track";
    return { ok: true, message: `Queued next on ${result.device}: ${what}` };
  }

  if (!result.started) {
    return { ok: false, message: `${result.device} didn't start playing — try again` };
  }

  return { ok: true, message: `Audio cast successfully to ${result.device}` };
}
