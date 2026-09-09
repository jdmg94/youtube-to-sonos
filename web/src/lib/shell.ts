/**
 * The shell's view model: which panels a phone shows, and what the player bar
 * says above them.
 *
 * The app has two layouts and one DOM. Above 900px every panel is on screen at
 * once in two columns; below it the browsing panels are split across two tabs
 * and the player is a sheet that slides over whichever one is showing. That
 * split is expressed here as data — a panel-to-tab map — rather than as a
 * second component tree, because two trees would mean two `NowPlayingCard`s
 * subscribing to the same speaker and two `StreamController`s holding two
 * half-typed URLs.
 *
 * A `.ts` file, like the other view models, so Node can test it without a JSX
 * transform.
 */
import { hasStation, type NowPlaying, type StationBody } from "@/lib/api/types";
import { describeNowPlaying } from "@/lib/now-playing";

/**
 * The two phone tabs.
 *
 * Meaningless above the breakpoint — everything is visible there — but the
 * value is still tracked, because the viewport can cross the breakpoint mid
 * session (a rotation, a resized window) and arriving on a tab the user never
 * chose is worse than arriving on the one they left.
 *
 * There is no `player` here any more: playback is a sheet reachable from every
 * tab, not a place you navigate away from the queue to visit. A phone that
 * still has `"player"` under the storage key is caught by `isAppTab` and lands
 * on `DEFAULT_TAB`.
 */
export type AppTab = "queue" | "lights";

/** Source order for the tab bar. Queue first: it is what the app is for. */
export const TABS: readonly AppTab[] = ["queue", "lights"];

export const TAB_LABEL: Record<AppTab, string> = {
  queue: "Queue",
  lights: "Lights",
};

export const DEFAULT_TAB: AppTab = "queue";

/**
 * Whether a value off the wire — here, `localStorage` — is a tab.
 *
 * The tab is persisted, so the stored value survives a release that renames or
 * drops one, which is exactly what dropping the Player tab did. Without this
 * guard a stale `"player"` from an older build renders a phone screen with
 * every panel hidden and no error: the tab bar would highlight nothing and the
 * page would be blank.
 */
export function isAppTab(value: unknown): value is AppTab {
  return typeof value === "string" && (TABS as readonly string[]).includes(value);
}

/**
 * The three tabbed sections the shell places, in DOM order.
 *
 * The player — speaker picker, now-playing card and volume slider — is
 * deliberately absent. It is one panel on the desktop sidebar and a sheet over
 * everything on a phone, so it belongs to no tab and is never hidden by one.
 */
export type Panel = "lights" | "stream" | "queue";

/**
 * Which tab each panel belongs to on a phone.
 *
 * This *is* the information architecture, and it is why it is a constant rather
 * than a chain of conditions in JSX. The entry that is not its own name is the
 * one that needed deciding: `stream` — the paste-a-URL form — is under
 * **Queue**, because pasting a URL and then looking at what it queued are one
 * task.
 *
 * The order of the keys is also load-bearing. Both layouts render one DOM in
 * this sequence: on desktop `lights` closes the sidebar and the last two are
 * the main column, and on a phone the column wrappers collapse to `display:
 * contents` so all three become siblings in exactly this order.
 */
export const PANEL_TAB: Record<Panel, AppTab> = {
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

/** The bar's title when a speaker is chosen but silent. */
export const NOTHING_PLAYING = "Nothing playing";

/** The bar's title before there is a speaker to play on at all. */
export const NO_SPEAKER = "No speaker selected";

/** The second line under `NO_SPEAKER`. The sheet behind the bar has the picker. */
export const PICK_SPEAKER = "Tap to choose one";

export interface PlayerBarView {
  title: string;
  /** `Now playing · Kitchen` when there is a track, the room alone when not. */
  subtitle: string;
  /** `null` renders the music-note placeholder. */
  thumbnail: string | null;
  /** Audible right now, as opposed to paused. Drives the equalizer. */
  live: boolean;
  /** Nothing to show: the bar is an invitation rather than a status. */
  idle: boolean;
}

/**
 * The bar pinned above the tabs, and the only way into the player sheet.
 *
 * It has no `visible` field because it has no hidden state. The player used to
 * be a tab and this bar the reminder of it, so it could afford to disappear
 * whenever there was nothing to remind you of; now it is the door, and a door
 * that vanishes when the room is empty leaves a phone with no route to the
 * speaker picker, the volume slider, or a paused track's Play button.
 *
 * Idle is a different sentence, not a blank one. `describeNowPlaying`'s own
 * idle title is an em dash sized for a card with a label above it, which on a
 * single tappable row reads as a broken cell — so the two strings below are the
 * bar's own, and the artwork is dropped with them: a stopped station still
 * lists its tracks, and the cursor's thumbnail beside "Nothing playing" claims
 * a song is on.
 *
 * Paused counts as a track. A paused speaker is the case where getting back to
 * the transport controls is most urgent, and the row that takes you there must
 * not be the thing that changes.
 */
export function describePlayerBar(
  nowPlaying: NowPlaying | null | undefined,
  station: StationBody | null | undefined,
  deviceName: string | null,
): PlayerBarView {
  const view = describeNowPlaying(nowPlaying, deviceName);

  if (view.mode === "idle") {
    return {
      title: view.device ? NOTHING_PLAYING : NO_SPEAKER,
      subtitle: view.device ?? PICK_SPEAKER,
      thumbnail: null,
      live: false,
      idle: true,
    };
  }

  return {
    title: view.title,
    subtitle: view.label,
    thumbnail: currentArtwork(station),
    live: view.mode === "playing",
    idle: false,
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
