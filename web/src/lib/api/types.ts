/**
 * Wire types for the Flask API. Mirrors `API.md` — when an endpoint changes,
 * change it there and here in the same commit.
 *
 * These describe what the server *actually sends*, not what would be
 * convenient. Three places where those differ, and where a tidier type would
 * be a lie:
 *
 *  - Station tracks key on `id`; now-playing keys on `video_id`.
 *  - Now-playing `duration`/`position` are `"H:MM:SS"` strings (straight from
 *    Sonos); track-metadata `duration` is a number of seconds (from yt-dlp).
 *  - `/api/devices` returns a bare array. Everything else returns an object.
 */

/** Sonos transport state, as reported by the speaker. */
export type PlaybackState =
  | "PLAYING"
  | "PAUSED_PLAYBACK"
  | "STOPPED"
  | "TRANSITIONING";

/**
 * Download state of a track's audio.
 *
 * `"missing"` is not an error — it means nothing has been asked for yet. Only
 * `"done"` means the bytes are on disk.
 */
export type CacheState = "done" | "running" | "queued" | "failed" | "missing";

/** How `/api/play` should treat a seed relative to what is already playing. */
export type PlayMode = "now" | "next" | "auto";

export type TransportAction = "next" | "prev" | "play" | "pause" | "seek" | "jump";

/** `H:MM:SS`, as Sonos formats it. Not a duration in seconds. */
export type SonosTime = string;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Every failure response. `error` is written to be shown to the user verbatim.
 *
 * The three booleans are yt-dlp failure classes. Any of them means retrying
 * immediately will fail identically, so the UI must not offer a bare "try
 * again" on them.
 */
export interface ApiErrorBody {
  error: string;
  /** 429. Sign-in wall or rate limit — wait it out. */
  bot_detected?: boolean;
  /** 502. googlevideo refused the media URL with 403. */
  forbidden?: boolean;
  /** 502. YouTube refused yt-dlp's player session — yt-dlp needs updating. */
  stale_extractor?: boolean;
}

// ---------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------

export interface Health {
  status: "ok";
  stream_host: string;
  port: number;
  ytdlp_version: string | null;
  /** `null` when the version string does not parse as a date. */
  ytdlp_age_days: number | null;
  /** `ytdlp_age_days > YTDLP_STALE_DAYS`. Predicts download failures. */
  ytdlp_stale: boolean;
  /** Empty means yt-dlp cannot run YouTube's player JS — downloads will fail. */
  js_runtimes: string[];
  cookies: boolean;
  stations: number;
  cache_dir: string;
}

// ---------------------------------------------------------------------------
// GET /api/devices
// ---------------------------------------------------------------------------

export interface Device {
  name: string;
  ip: string;
}

// ---------------------------------------------------------------------------
// GET /api/info
// ---------------------------------------------------------------------------

/**
 * yt-dlp metadata. Every field but `id` can be null for a track whose tags
 * weren't read — the UI must render around a missing title.
 */
export interface VideoInfo {
  id: string;
  title: string | null;
  uploader: string | null;
  /** YouTube CDN URL. Directly usable by the browser. */
  thumbnail: string | null;
  /** Seconds. */
  duration: number | null;
}

// ---------------------------------------------------------------------------
// POST /api/play
// ---------------------------------------------------------------------------

export interface PlayRequest {
  url: string;
  device_ip?: string;
  /** `false` plays one track and starts no station. Default `true`. */
  autoplay?: boolean;
  /** Default `"auto"`. The UI always sends `"now"` or `"next"` explicitly. */
  mode?: PlayMode;
}

interface PlayResponseBase {
  device: string;
  device_ip: string;
  /** Absolute URL on the *backend*, for Sonos. Not for the browser. */
  stream_url: string;
  autoplay: boolean;
  video_id: string;
  title: string | null;
}

export interface PlayNowResponse extends PlayResponseBase {
  status: "playing";
  /**
   * `false` means the speaker accepted the track but never reached PLAYING —
   * the request succeeded and the listener is hearing silence. Do not paint a
   * confident now-playing state on it.
   */
  started: boolean;
  queued_next: false;
}

export interface PlayNextResponse extends PlayResponseBase {
  status: "queued";
  queued_next: true;
  /** 1-based Sonos queue position. */
  queue_position: number;
}

/**
 * Discriminate on `status`. `mode: "next"` returns the *playing* shape when the
 * speaker had no queue item to sit behind (line-in, TV, radio).
 */
export type PlayResponse = PlayNowResponse | PlayNextResponse;

// ---------------------------------------------------------------------------
// POST /api/transport
// ---------------------------------------------------------------------------

export type TransportRequest =
  | { device_ip?: string; action: "next" | "prev" | "play" | "pause" }
  | { device_ip?: string; action: "seek"; position: SonosTime }
  /** `index` is 0-based into the station track list, not the Sonos queue. */
  | { device_ip?: string; action: "jump"; index: number };

export interface TransportResponse {
  status: "ok";
  action: TransportAction;
  device: string;
}

// ---------------------------------------------------------------------------
// GET /api/station
// ---------------------------------------------------------------------------

export interface StationTrack {
  /** Video id. Note: `id` here, `video_id` in now-playing. */
  id: string;
  title: string | null;
  uploader: string | null;
  /** YouTube CDN URL — exists before the track is cached, unlike `album_art`. */
  thumbnail: string | null;
  /** Seconds. */
  duration: number | null;
  cached: CacheState;
  /** 1-based Sonos queue position, or `null` if not yet enqueued. */
  queue_pos: number | null;
}

/** The station payload as it appears inside an SSE frame (no `device_ip`). */
export interface StationBody {
  /** 0-based cursor into `tracks`. */
  index: number;
  /** The station ran out of unheard tracks. */
  exhausted: boolean;
  tracks: StationTrack[];
}

export interface Station extends StationBody {
  device_ip: string;
}

/**
 * Whether a station actually exists.
 *
 * "No station" serialises as `{index: 0, tracks: [], exhausted: false}` — the
 * same `index` a *running* station has while playing its first track. So
 * `index` alone cannot answer this, and code that assumes it can will read
 * `tracks[index]` of an empty list.
 */
export function hasStation(station: StationBody | null | undefined): station is StationBody {
  return !!station && station.tracks.length > 0;
}

export interface StationRefreshResponse extends Station {
  status: "refreshed";
  /** How many queued tracks were discarded. */
  dropped: number;
  device: string;
}

/**
 * Whether the speaker can be told to play this track.
 *
 * The one condition is that the track has been handed to Sonos. Asking it to
 * play a queue position that doesn't exist yet is how you get a silent speaker.
 *
 * This deliberately does *not* also require `cached === "done"`, which it used
 * to. `queue_pos` is `i + 1 if i < station.enqueued else None` — purely
 * positional, and only finished downloads are ever enqueued — so an enqueued
 * track's bytes did reach disk at some point. They may not still be there:
 * `_evict` deletes audio outside the window while the Sonos queue is
 * deliberately never trimmed, so a track a few songs behind the cursor keeps
 * its `queue_pos` and reverts to `missing`. Playing it is supported — the
 * speaker re-requests `/media/<id>.mp3` and the download restarts under an open
 * socket at `PRIORITY_MEDIA` — and that is the whole mechanism by which
 * stepping back past the window works. Requiring `done` here would have greyed
 * out exactly those rows.
 *
 * `failed` needs no special case: a failed download is never enqueued, so it
 * has no `queue_pos` to begin with.
 */
export function isJumpable(track: StationTrack): boolean {
  return track.queue_pos !== null;
}

// ---------------------------------------------------------------------------
// GET /api/now-playing, GET /api/events
// ---------------------------------------------------------------------------

/**
 * Note the string fields: these come from soco's `get_current_track_info()`,
 * which reports the **empty string**, not `null`, for anything the speaker did
 * not give it. An idle speaker answers `title: ""`, `artist: ""`,
 * `album_art: ""`, `duration: "0:00:00"`. `??` will not catch that — use
 * `present()`.
 */
export interface NowPlaying {
  state: PlaybackState;
  title: string | null;
  artist: string | null;
  /**
   * Absolute URL to the *backend* (what Sonos was given in DIDL), not YouTube.
   * Prefer the station track's `thumbnail` for UI: it exists before the track
   * is cached, and it doesn't depend on STREAM_HOST being browser-reachable.
   */
  album_art: string | null;
  duration: SonosTime | null;
  position: SonosTime | null;
  /** 1-based Sonos queue position. `0` when not playing from the queue. */
  playlist_position: number;
  /** 0-based station cursor, or `null` when no station is running. */
  station_index: number | null;
  uri: string | null;
  /** Legacy key. Now means "this is a track we serve", i.e. `video_id !== null`. */
  is_radio: boolean;
  /** `null` when the speaker is playing something that isn't ours. */
  video_id: string | null;
  device: string;
  device_ip: string;
}

/** A `data:` frame from `/api/events`: now-playing plus the station. */
export interface EventFrame extends NowPlaying {
  station: StationBody;
}

/**
 * A frame may be an error instead. The stream usually stays open through one,
 * so this must not be treated as a fatal connection failure.
 */
export type EventMessage = EventFrame | ApiErrorBody;

export function isErrorFrame(msg: EventMessage): msg is ApiErrorBody {
  return "error" in msg;
}

/**
 * Whether a wire string actually carries a value.
 *
 * The API says `string | null` but the speaker-sourced half of it says `""`.
 * Every "is there a title" question has to go through here — `value ?? fallback`
 * happily returns `""` and renders nothing.
 */
export function present(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

/** `"0:00:00"` is Sonos for "no track", not for "a track of length zero". */
export function hasElapsed(time: SonosTime | null | undefined): boolean {
  return present(time) && !/^0+:00:00$/.test(time);
}

// ---------------------------------------------------------------------------
// /api/volume
// ---------------------------------------------------------------------------

export interface VolumeState {
  volume: number;
  mute: boolean;
  device: string;
}

export interface VolumeGetResponse extends VolumeState {
  device_ip: string;
}

/** Send either field or both. `volume` is clamped server-side to 0–100. */
export interface VolumeRequest {
  device_ip?: string;
  volume?: number;
  mute?: boolean;
}

// ---------------------------------------------------------------------------
// GET /api/downloads
// ---------------------------------------------------------------------------

export type DownloadState = "queued" | "running" | "done" | "failed";

export interface DownloadEntry {
  id: string;
  state: DownloadState;
  bytes: number;
  attempts: number;
  error: string | null;
  retry_in: number;
  /**
   * Distance from what the speaker needs: `-1` an open /media socket, `0` the
   * track under the cursor, `N` for N tracks ahead. Lower is more urgent.
   * `null` when the download is neither running nor pending.
   */
  priority: number | null;
}

export interface Downloads {
  workers: number;
  /** Whether prefetch is held off the wire behind urgent downloads. */
  gate: boolean;
  /** video id → priority. */
  running: Record<string, number>;
  /** video id → priority. */
  pending: Record<string, number>;
  downloads: DownloadEntry[];
}

// ---------------------------------------------------------------------------
// POST /api/stop
// ---------------------------------------------------------------------------

export interface StopResponse {
  status: "stopped";
  device: string;
}
