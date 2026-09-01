/**
 * The shell's failures are all silent ones: a panel assigned to no tab is a
 * feature that has disappeared, a stale tab in `localStorage` is a blank phone
 * screen, and a mini player that shows on the Player tab is a duplicate of the
 * card above it. None of them throw, so they are pinned here.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { NowPlaying, StationBody, StationTrack } from "@/lib/api/types";
import { NO_TRACK } from "@/lib/now-playing";
import {
  DEFAULT_TAB,
  PANEL_TAB,
  TABS,
  TAB_LABEL,
  currentArtwork,
  describeMiniPlayer,
  isAppTab,
  panelVisible,
  type Panel,
} from "@/lib/shell";

function frame(overrides: Partial<NowPlaying> = {}): NowPlaying {
  return {
    state: "PLAYING",
    title: "Rocket Man",
    artist: "Elton John",
    album_art: "http://10.0.0.9:5000/media/abc123.jpg",
    duration: "0:04:41",
    position: "0:01:12",
    playlist_position: 1,
    station_index: 0,
    uri: "http://10.0.0.9:5000/media/abc123.mp3",
    is_radio: true,
    video_id: "abc123",
    device: "Kitchen",
    device_ip: "10.0.0.1",
    ...overrides,
  };
}

function track(overrides: Partial<StationTrack> = {}): StationTrack {
  return {
    id: "abc123",
    title: "Rocket Man",
    uploader: "Elton John",
    thumbnail: "https://i.ytimg.com/vi/abc123/hq.jpg",
    duration: 281,
    cached: "done",
    queue_pos: 1,
    ...overrides,
  };
}

function station(overrides: Partial<StationBody> = {}): StationBody {
  return { index: 0, exhausted: false, tracks: [track()], ...overrides };
}

const ALL_PANELS: readonly Panel[] = ["player", "lights", "stream", "queue"];

// ---------------------------------------------------------------------------

describe("tabs", () => {
  it("names every tab it lists", () => {
    for (const tab of TABS) {
      assert.ok(TAB_LABEL[tab], `${tab} has no label`);
    }
    assert.equal(Object.keys(TAB_LABEL).length, TABS.length);
  });

  it("opens on a tab that exists", () => {
    // `DEFAULT_TAB` is what a first visit and a corrupt storage entry both land
    // on, so it has to be renderable.
    assert.ok(TABS.includes(DEFAULT_TAB));
  });

  it("rejects anything storage might hand back that isn't a tab", () => {
    // `usePersistedState` JSON-parses whatever is under the key. A release that
    // renamed a tab, another tab of the app, or a user in devtools can all put
    // any of these there.
    for (const junk of [null, undefined, "", "Player", "settings", 0, {}, ["player"]]) {
      assert.equal(isAppTab(junk), false, `${JSON.stringify(junk)} accepted as a tab`);
    }
    for (const tab of TABS) assert.equal(isAppTab(tab), true);
  });
});

describe("PANEL_TAB", () => {
  it("gives every panel a home", () => {
    // A panel missing from this map is a feature the phone can never reach —
    // and it fails by rendering nothing, not by erroring.
    for (const panel of ALL_PANELS) {
      assert.ok(PANEL_TAB[panel], `${panel} is not assigned to a tab`);
    }
  });

  it("leaves no tab empty", () => {
    // A tab with no panels is a bar button that opens a blank screen.
    for (const tab of TABS) {
      const panels = ALL_PANELS.filter((panel) => PANEL_TAB[panel] === tab);
      assert.ok(panels.length > 0, `${tab} has no panels`);
    }
  });

  it("keeps the URL box with the queue it fills", () => {
    // Deliberate, and the one assignment a reader is likely to think is a typo:
    // pasting a link and seeing what it queued are one task.
    assert.equal(PANEL_TAB.stream, PANEL_TAB.queue);
  });

  it("lists the panels in the order both layouts render them", () => {
    // The phone layout is the desktop DOM with the column wrappers collapsed to
    // `display: contents`, so key order here is the stacking order there. A
    // reordering that put Lights between the two Queue panels would interleave
    // two tabs' worth of markup and could not be expressed by hiding panels.
    assert.deepEqual(Object.keys(PANEL_TAB), ["player", "lights", "stream", "queue"]);
  });

  it("groups each tab's panels contiguously", () => {
    // The same constraint, stated as the property that actually matters: a tab
    // whose panels are not adjacent cannot be shown by hiding the others
    // without leaving a gap where the hidden ones were.
    for (const tab of TABS) {
      const indexes = ALL_PANELS.map((panel, i) => (PANEL_TAB[panel] === tab ? i : -1)).filter(
        (i) => i >= 0,
      );
      const span = indexes[indexes.length - 1] - indexes[0] + 1;
      assert.equal(span, indexes.length, `${tab}'s panels are not contiguous`);
    }
  });
});

describe("panelVisible", () => {
  it("shows exactly one tab's panels at a time", () => {
    for (const tab of TABS) {
      const shown = ALL_PANELS.filter((panel) => panelVisible(panel, tab));
      assert.deepEqual(
        shown,
        ALL_PANELS.filter((panel) => PANEL_TAB[panel] === tab),
      );
    }
  });

  it("hides the queue while the player is open, and the reverse", () => {
    assert.equal(panelVisible("queue", "player"), false);
    assert.equal(panelVisible("player", "queue"), false);
  });
});

// ---------------------------------------------------------------------------

describe("describeMiniPlayer", () => {
  it("stays hidden on the Player tab, which already shows the track", () => {
    const mini = describeMiniPlayer("player", frame(), station(), "Kitchen");
    assert.equal(mini.visible, false);
  });

  it("appears on the other tabs while a track is playing", () => {
    for (const tab of ["queue", "lights"] as const) {
      assert.equal(describeMiniPlayer(tab, frame(), station(), "Kitchen").visible, true);
    }
  });

  it("stays hidden when the speaker is idle", () => {
    // An empty bar sitting on top of the queue is worse than no bar.
    const mini = describeMiniPlayer("queue", frame({ state: "STOPPED" }), station(), "Kitchen");
    assert.equal(mini.visible, false);
  });

  it("stays hidden when there is no speaker at all", () => {
    assert.equal(describeMiniPlayer("queue", null, null, null).visible, false);
  });

  it("shows a paused track", () => {
    // Paused is when getting back to the transport controls matters most, so
    // the one control that goes there must not be the thing that disappears.
    const mini = describeMiniPlayer(
      "queue",
      frame({ state: "PAUSED_PLAYBACK" }),
      station(),
      "Kitchen",
    );
    assert.equal(mini.visible, true);
    assert.equal(mini.live, false);
    assert.match(mini.subtitle, /^Paused/);
  });

  it("marks a playing track live", () => {
    const mini = describeMiniPlayer("queue", frame(), station(), "Kitchen");
    assert.equal(mini.live, true);
    assert.equal(mini.title, "Rocket Man");
    assert.equal(mini.subtitle, "Now playing · Kitchen");
  });

  it("never renders the idle placeholder as a title", () => {
    // The bar is hidden when idle, so `NO_TRACK` reaching it would mean the
    // visibility rule and the title came from different states.
    for (const tab of TABS) {
      const mini = describeMiniPlayer(tab, frame({ state: "STOPPED" }), station(), "Kitchen");
      assert.ok(!mini.visible || mini.title !== NO_TRACK);
    }
  });
});

describe("currentArtwork", () => {
  it("prefers the station thumbnail over the speaker's album art", () => {
    // `album_art` points at STREAM_HOST, an address picked for the speakers and
    // never checked against the browser.
    assert.equal(currentArtwork(station()), "https://i.ytimg.com/vi/abc123/hq.jpg");
  });

  it("follows the cursor rather than assuming the first track", () => {
    const two = station({
      index: 1,
      tracks: [track(), track({ id: "second", thumbnail: "https://i.ytimg.com/vi/second/hq.jpg" })],
    });
    assert.equal(currentArtwork(two), "https://i.ytimg.com/vi/second/hq.jpg");
  });

  it("returns null rather than reading past a cursor the frame outran", () => {
    // Cursor and list arrive on the same frame but are not validated against
    // each other, and the list is rewritten wholesale every poll.
    assert.equal(currentArtwork(station({ index: 7 })), null);
  });

  it("treats an empty thumbnail as no thumbnail", () => {
    // A metadata sidecar written from a stream with an empty tag sends `""`,
    // which would render a broken-image icon.
    assert.equal(currentArtwork(station({ tracks: [track({ thumbnail: "" })] })), null);
    assert.equal(currentArtwork(station({ tracks: [track({ thumbnail: null })] })), null);
  });

  it("returns null when there is no station", () => {
    assert.equal(currentArtwork(null), null);
    assert.equal(currentArtwork(station({ tracks: [] })), null);
  });
});
