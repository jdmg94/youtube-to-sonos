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

export interface NowPlayingView {
  mode: NowPlayingMode;
  /** `Now playing · Kitchen`. Carries the room, so it is never just a verb. */
  label: string;
  title: string;
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
  const device = nowPlaying && present(nowPlaying.device) ? nowPlaying.device : deviceName;
  const suffix = present(device) ? ` · ${device}` : "";

  if (!nowPlaying || !ENGAGED_STATES.includes(nowPlaying.state)) {
    return { mode: "idle", label: `Idle${suffix}`, title: NO_TRACK };
  }

  const paused = nowPlaying.state === "PAUSED_PLAYBACK";
  return {
    mode: paused ? "paused" : "playing",
    label: `${paused ? "Paused" : "Now playing"}${suffix}`,
    title: trackTitle(nowPlaying.title),
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
