/**
 * The shell's view model: which panels a phone shows, and what the mini player
 * says when it does.
 *
 * The app has two layouts and one DOM. Above 900px every panel is on screen at
 * once in two columns; below it the same panels are split across three tabs and
 * only one tab's worth is visible. That split is expressed here as data — a
 * panel-to-tab map — rather than as a second component tree, because two trees
 * would mean two `NowPlayingCard`s subscribing to the same speaker and two
 * `StreamController`s holding two half-typed URLs.
 *
 * A `.ts` file, like the other view models, so Node can test it without a JSX
 * transform.
 */
import { hasStation, type NowPlaying, type StationBody } from "@/lib/api/types";
import { describeNowPlaying } from "@/lib/now-playing";

/**
 * The three phone tabs.
 *
 * Meaningless above the breakpoint — everything is visible there — but the
 * value is still tracked, because the viewport can cross the breakpoint mid
 * session (a rotation, a resized window) and arriving on a tab the user never
 * chose is worse than arriving on the one they left.
 */
export type AppTab = "player" | "queue" | "lights";

/** Source order for the tab bar. Player first: it is where playback lives. */
export const TABS: readonly AppTab[] = ["player", "queue", "lights"];

export const TAB_LABEL: Record<AppTab, string> = {
  player: "Player",
  queue: "Queue",
  lights: "Lights",
};

export const DEFAULT_TAB: AppTab = "player";

/**
 * Whether a value off the wire — here, `localStorage` — is a tab.
 *
 * The tab is persisted, so the stored value survives a release that renames or
 * drops one. Without this guard a stale `"lights"` from an older build renders
 * a phone screen with every panel hidden and no error: the tab bar would
 * highlight nothing and the page would be blank.
 */
export function isAppTab(value: unknown): value is AppTab {
  return typeof value === "string" && (TABS as readonly string[]).includes(value);
}

/**
 * The four sections the shell places, in DOM order.
 *
 * `player` is the speaker picker, the now-playing card and the volume slider
 * together — they are one card on both layouts, so they are one panel here.
 */
export type Panel = "player" | "lights" | "stream" | "queue";

/**
 * Which tab each panel belongs to on a phone.
 *
 * This *is* the information architecture, and it is why it is a constant rather
 * than a chain of conditions in JSX. The entry that is not its own name is the
 * one that needed deciding: `stream` — the paste-a-URL form — is under **Queue**,
 * not Player. Pasting a URL and then looking at what it queued are one task;
 * the transport controls are a different one.
 *
 * The order of the keys is also load-bearing. Both layouts render one DOM in
 * this sequence: on desktop the first two are the sidebar and the last two the
 * main column, and on a phone the column wrappers collapse to `display:
 * contents` so all four become siblings in exactly this order.
 */
export const PANEL_TAB: Record<Panel, AppTab> = {
  player: "player",
  lights: "lights",
  stream: "queue",
  queue: "queue",
};

/**
 * Whether a panel is on screen at phone width.
 *
 * Above the breakpoint this answer is ignored: the layout shows everything, and
 * the components render `hidden` only under a `max-width` variant.
 */
export function panelVisible(panel: Panel, tab: AppTab): boolean {
  return PANEL_TAB[panel] === tab;
}

export interface MiniPlayerView {
  /** Render nothing at all when false — the bar reserves layout space. */
  visible: boolean;
  title: string;
  /** `Now playing · Kitchen`. Reuses the card's label, so the two agree. */
  subtitle: string;
  /** `null` renders the music-note placeholder. */
  thumbnail: string | null;
  /** Audible right now, as opposed to paused. Drives the equalizer. */
  live: boolean;
}

/**
 * The bar that follows the listener off the Player tab.
 *
 * Visible when there is a track *and* the Player tab is not already showing
 * one. Both halves matter: without the first it is an empty bar covering the
 * queue, and without the second it is a duplicate of the card directly above
 * it, stealing a phone screen's worth of space from the thing the user came to
 * look at.
 *
 * Paused counts as a track. A paused speaker is the case where getting back to
 * the transport controls is most urgent, and hiding the one control that takes
 * you there is exactly backwards.
 */
export function describeMiniPlayer(
  tab: AppTab,
  nowPlaying: NowPlaying | null | undefined,
  station: StationBody | null | undefined,
  deviceName: string | null,
): MiniPlayerView {
  const view = describeNowPlaying(nowPlaying, deviceName);
  return {
    visible: view.mode !== "idle" && tab !== "player",
    title: view.title,
    subtitle: view.label,
    thumbnail: currentArtwork(station),
    live: view.mode === "playing",
  };
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
