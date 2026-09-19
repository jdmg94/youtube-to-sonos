/**
 * The now-playing card's view model.
 *
 * Kept out of the component because this is where the actual decisions live —
 * what counts as "playing", which of two device names to trust, what to show
 * when Sonos reports a track with no title — and every one of them is a
 * one-line change away from a card that lies about what the speaker is doing.
 * A `.ts` file so Node can run its tests without a JSX transform.
 */
import {
  hasStation,
  present,
  type NowPlaying,
  type PlaybackState,
  type StationBody,
} from "@/lib/api/types";

/**
 * States in which there is a track to show.
 *
 * `TRANSITIONING` belongs here even though nothing is audible during it: Sonos
 * reports it for the second or two between queue items, and treating it as idle
 * blinks the card to "—" on every single track change.
 *
 * `STOPPED` is absent, which is what makes stop and end-of-station land on the
 * idle branch.
 */
const ENGAGED_STATES: readonly PlaybackState[] = [
  "PLAYING",
  "TRANSITIONING",
  "PAUSED_PLAYBACK",
];

/**
 * Shown when the speaker is playing something it could not name.
 *
 * Our own files are tagged, so in practice this is a track whose ID3 write lost
 * a race with playback, or a stream that isn't ours at all. Either way the
 * speaker *is* playing, and a blank line where the title goes reads as a broken
 * card rather than as a nameless track.
 */
export const UNTITLED_TRACK = "Streaming audio";

/** The idle title. An em dash, because an empty string collapses the row. */
export const NO_TRACK = "—";

export type NowPlayingMode = "playing" | "paused" | "idle";

/**
 * The one reading of a `PlaybackState` the whole UI works from.
 *
 * Every control that changes what the speaker is doing needs this answer, and
 * they do not all have a `NowPlaying` frame to hand — the player bar has a view
 * model that deliberately carries strings rather than states. Exported so those
 * callers ask this rather than re-testing `state === "PAUSED_PLAYBACK"` for
 * themselves, which is the shape in which `TRANSITIONING` gets forgotten and a
 * button flickers between queue items.
 */
export function playbackMode(state: PlaybackState | null | undefined): NowPlayingMode {
  if (!state || !ENGAGED_STATES.includes(state)) return "idle";
  return state === "PAUSED_PLAYBACK" ? "paused" : "playing";
}

export interface NowPlayingView {
  mode: NowPlayingMode;
  /** `Now playing · Kitchen`. Carries the room, so it is never just a verb. */
  label: string;
  title: string;
  /**
   * The room, on its own — the same name `label` ends with, for callers that
   * need it as a separate line rather than inside a sentence. `null` when
   * nothing is selected and no frame has named one.
   *
   * Published rather than re-derived by those callers: the precedence below
   * (the frame's own `device` beats the selection) is a rule with a reason, and
   * a second copy of it is a second thing to get wrong.
   */
  device: string | null;
}

/**
 * Turn a now-playing frame into the three strings the card renders.
 *
 * `deviceName` is the *selected* speaker, used only as a fallback. The frame's
 * own `device` wins when there is one: the two agree in steady state, and when
 * they don't it is because the selection just changed and the frame is the one
 * that reflects the speaker actually making noise.
 *
 * The original used the fallback on the idle branch only, so a frame with an
 * empty `device` rendered a bare "Now playing" with no room. Unified here —
 * observably identical whenever the backend fills the field in, which is
 * always, and correct in the case where it doesn't.
 */
export function describeNowPlaying(
  nowPlaying: NowPlaying | null | undefined,
  deviceName: string | null,
): NowPlayingView {
  const named = nowPlaying && present(nowPlaying.device) ? nowPlaying.device : deviceName;
  // `present` also rejects the empty string a `deviceName` of `""` would carry
  // through, so the published field is never a name that renders as nothing.
  const device = present(named) ? named : null;
  const suffix = device ? ` · ${device}` : "";

  const mode = playbackMode(nowPlaying?.state);
  // `playbackMode` already answers "idle" for a missing frame; the second half
  // of this test is what tells the compiler so.
  if (mode === "idle" || !nowPlaying) {
    return { mode: "idle", label: `Idle${suffix}`, title: NO_TRACK, device };
  }

  return {
    mode,
    label: `${mode === "paused" ? "Paused" : "Now playing"}${suffix}`,
    title: trackTitle(nowPlaying.title),
    device,
  };
}

/**
 * `present()` is not enough here. soco reports `""` for an absent title, which
 * `present()` does catch — but Sonos also hands back titles that are nothing
 * but whitespace, and those render as an empty line rather than as a name.
 * Tested on the trimmed string, kept untrimmed for display.
 */
function trackTitle(title: string | null): string {
  return title !== null && title.trim().length > 0 ? title : UNTITLED_TRACK;
}

/** The wide button's two faces. */
export interface ToggleView {
  /** What `/api/transport` is asked to do. */
  action: "play" | "pause";
  /** Its label, and its `aria-label`. */
  label: string;
}

/**
 * What the play/pause button should say and send, or `null` for no button.
 *
 * Deliberately narrower than "the opposite of whatever the speaker is doing":
 * an idle speaker gets **no** action at all. `/api/stop` ends the station — the
 * loop that prefetches, extends and evicts — while leaving the Sonos queue
 * where it is, so a bare `play` afterwards would walk the tracks still sitting
 * in that queue with nothing behind them, then stop dead at the end of a list
 * nothing is extending. That is a worse outcome than a disabled button, and
 * harder to explain: the room plays music, the app just quietly stops being a
 * station. Starting playback is Play now's job, and it is the one path that
 * builds a station to go with it.
 *
 * Keyed on the card's mode rather than on `PlaybackState` so that
 * `TRANSITIONING` is somebody else's problem — `describeNowPlaying` already
 * rules it "playing", and reading the raw state here would flicker the button
 * to Play for the second or two between queue items.
 */
export function describeToggle(mode: NowPlayingMode): ToggleView | null {
  if (mode === "idle") return null;
  return mode === "paused"
    ? { action: "play", label: "Play" }
    : { action: "pause", label: "Pause" };
}

/**
 * Whether Previous is worth offering.
 *
 * The station is the history: the cursor only advances, so anything before it
 * has been heard and can be returned to. At index 0 there is nothing behind,
 * and Sonos answers a `prev` there by restarting the current track — which
 * looks like the button misfired.
 */
export function canGoPrevious(station: StationBody | null | undefined): boolean {
  return hasStation(station) && station.index > 0;
}

/**
 * Whether Next is worth offering.
 *
 * Deliberately not "is there a track after the cursor": the station loop
 * extends itself toward `WINDOW_AHEAD`, so on the last known track the server
 * is already resolving the next one. Requiring a visible successor would grey
 * the button out for exactly as long as it takes to find one, which is when the
 * listener is most likely to press it.
 */
export function canGoNext(station: StationBody | null | undefined): boolean {
  return hasStation(station);
}

/**
 * Artwork for the track under the cursor.
 *
 * Read off the station rather than `nowPlaying.album_art`, which is the URL
 * *Sonos* was handed: it points at the backend on `STREAM_HOST`, an address
 * chosen so the speakers can reach it and never checked against the browser.
 * The station's `thumbnail` is YouTube's own CDN and is also present before
 * the track has been cached, so it is the one that survives a cold start.
 */
export function currentArtwork(station: StationBody | null | undefined): string | null {
  if (!hasStation(station)) return null;
  // `index` is a cursor into a list the server rewrites on every frame, and the
  // two arrive together but are not validated against each other.
  return station.tracks[station.index]?.thumbnail || null;
}

/**
 * The same artwork, but only when there is a track to attach it to.
 *
 * Stopping does not empty the station — the list and its cursor survive, so
 * `currentArtwork` keeps answering with the last song's cover long after the
 * room went quiet, and a cover above "—" claims something is on. The player
 * bar has always dropped the thumbnail on its idle branch for exactly this
 * reason; this is that rule with a name, so the card and the bar cannot decide
 * it differently.
 *
 * Paused keeps the art. A paused track is still loaded and still what Play
 * resumes, and blanking a 169px image on every press would be the loudest
 * thing on the screen.
 */
export function trackArtwork(
  station: StationBody | null | undefined,
  mode: NowPlayingMode,
): string | null {
  return mode === "idle" ? null : currentArtwork(station);
}
