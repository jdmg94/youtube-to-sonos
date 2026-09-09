/**
 * The shell's failures are all silent ones: a panel assigned to no tab is a
 * feature that has disappeared, a stale tab in `localStorage` is a blank phone
 * screen, and a player bar that hides itself is a phone with no way back to the
 * transport controls at all. None of them throw, so they are pinned here.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { NowPlaying, StationBody, StationTrack } from "@/lib/api/types";
import { NO_TRACK } from "@/lib/now-playing";
import {
  DEFAULT_TAB,
  NOTHING_PLAYING,
  NO_SPEAKER,
  PANEL_TAB,
  PICK_SPEAKER,
  TABS,
  TAB_LABEL,
  currentArtwork,
  describePlayerBar,
  isAppTab,
  panelVisible,
  readTab,
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

const ALL_PANELS: readonly Panel[] = ["speaker", "lights", "stream", "queue"];

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
    for (const junk of [null, undefined, "", "Queue", "Settings", 0, {}, ["queue"]]) {
      assert.equal(isAppTab(junk), false, `${JSON.stringify(junk)} accepted as a tab`);
    }
    for (const tab of TABS) assert.equal(isAppTab(tab), true);
  });
});

describe("readTab", () => {
  it("hands back a tab it recognises unchanged", () => {
    for (const tab of TABS) assert.equal(readTab(tab), tab);
  });

  it("falls back rather than returning something unrenderable", () => {
    // Every one of these renders a phone with the bar highlighting nothing over
    // a screen with every panel hidden, and none of them throws on the way.
    for (const junk of [null, undefined, "", "Queue", 0, {}, ["queue"]]) {
      assert.equal(readTab(junk), DEFAULT_TAB, `${JSON.stringify(junk)} did not fall back`);
    }
  });

  it("sends a phone still storing the retired Player tab somewhere real", () => {
    // The player became a sheet rather than moving, so there is no tab that
    // means what `"player"` meant. Landing on the default is the whole fix.
    assert.equal(isAppTab("player"), false);
    assert.equal(readTab("player"), DEFAULT_TAB);
  });

  it("carries a phone left on Lights to the tab that absorbed it", () => {
    // This one is a rename, not a removal: everything the Lights tab showed is
    // still there under Settings. Dropping these installs on Queue would be
    // losing information we have.
    assert.equal(isAppTab("lights"), false, "the old id must not pass the guard");
    assert.equal(readTab("lights"), "settings");
  });

  it("only ever renames onto a tab that exists", () => {
    // The rename table is the one place a typo produces a stored value that
    // passes through `readTab` and then renders nothing.
    for (const old of ["player", "lights"]) {
      assert.ok(TABS.includes(readTab(old)), `${old} maps outside TABS`);
    }
  });
});

describe("PANEL_TAB", () => {
  it("gives every panel a home", () => {
    // A panel missing from this map is a feature the phone can never reach —
    // and it fails by rendering nothing, not by erroring.
    for (const panel of ALL_PANELS) {
      assert.ok(PANEL_TAB[panel], `${panel} is not assigned to a tab`);
    }
    assert.equal(Object.keys(PANEL_TAB).length, ALL_PANELS.length);
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

  it("keeps the speaker picker with the lights", () => {
    // The other deliberate pairing: which speaker and which lamps are both
    // "set this up once", and neither belongs next to a track you are playing.
    assert.equal(PANEL_TAB.speaker, PANEL_TAB.lights);
  });

  it("lists the panels in the order both layouts render them", () => {
    // The phone layout is the desktop DOM with the column wrappers collapsed to
    // `display: contents`, so key order here is the stacking order there. A
    // reordering that put Lights between the two Queue panels would interleave
    // two tabs' worth of markup and could not be expressed by hiding panels.
    assert.deepEqual(Object.keys(PANEL_TAB), ["speaker", "lights", "stream", "queue"]);
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

  it("does not route the player through a tab", () => {
    // The player is a sheet over both layouts' panels, not one of them. An
    // entry here would put it back in the tab bar's rotation and hide it
    // whenever another tab is selected — which is the bug this replaced.
    assert.equal("player" in PANEL_TAB, false);
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

  it("hides the settings while the queue is open, and the reverse", () => {
    assert.equal(panelVisible("queue", "settings"), false);
    assert.equal(panelVisible("lights", "queue"), false);
    assert.equal(panelVisible("speaker", "queue"), false);
  });
});

// ---------------------------------------------------------------------------

describe("describePlayerBar", () => {
  it("describes a playing track", () => {
    const bar = describePlayerBar(frame(), station(), "Kitchen");
    assert.equal(bar.title, "Rocket Man");
    assert.equal(bar.subtitle, "Now playing · Kitchen");
    assert.equal(bar.live, true);
    assert.equal(bar.idle, false);
  });

  it("shows a paused track without the equalizer running", () => {
    const bar = describePlayerBar(frame({ state: "PAUSED_PLAYBACK" }), station(), "Kitchen");
    assert.equal(bar.title, "Rocket Man");
    assert.match(bar.subtitle, /^Paused/);
    assert.equal(bar.live, false);
    assert.equal(bar.idle, false);
  });

  it("names the speaker it would control when nothing is playing", () => {
    // The bar is the only way into the player now, so an idle speaker cannot
    // make it disappear — it becomes the invitation instead of the status.
    const bar = describePlayerBar(frame({ state: "STOPPED" }), station(), "Kitchen");
    assert.equal(bar.idle, true);
    assert.equal(bar.title, NOTHING_PLAYING);
    assert.equal(bar.subtitle, "Kitchen");
    assert.equal(bar.live, false);
  });

  it("asks for a speaker when there is not one yet", () => {
    // First run, and every run where discovery found nothing.
    const bar = describePlayerBar(null, null, null);
    assert.equal(bar.idle, true);
    assert.equal(bar.title, NO_SPEAKER);
    assert.equal(bar.subtitle, PICK_SPEAKER);
    assert.ok(bar.subtitle.length > 0, "an empty second line collapses the row");
  });

  it("points at the tab that actually holds the picker", () => {
    // The picker used to be inside the sheet this bar opens, and the copy said
    // "tap". It is under Settings now, so the sentence names the tab — and it
    // is built from `TAB_LABEL` here so renaming that tab fails this test
    // rather than quietly leaving the bar directing people to a tab that is
    // gone. Nothing else in the app would notice.
    assert.match(PICK_SPEAKER, new RegExp(TAB_LABEL.settings));
  });

  it("never renders the card's idle dash", () => {
    // `NO_TRACK` is an em dash sized for a card with a label above it. On a bar
    // whose whole job is to be tappable it reads as a broken row.
    for (const state of ["PLAYING", "STOPPED"] as const) {
      assert.notEqual(describePlayerBar(frame({ state }), station(), "Kitchen").title, NO_TRACK);
    }
    assert.notEqual(describePlayerBar(null, null, null).title, NO_TRACK);
  });

  it("drops the artwork when nothing is playing", () => {
    // A stopped station still lists its tracks, so the cursor still resolves to
    // a thumbnail — one that would sit next to "Nothing playing" and claim the
    // song is on.
    assert.equal(describePlayerBar(frame({ state: "STOPPED" }), station(), "Kitchen").thumbnail, null);
    assert.equal(
      describePlayerBar(frame(), station(), "Kitchen").thumbnail,
      "https://i.ytimg.com/vi/abc123/hq.jpg",
    );
  });

  it("prefers the speaker the frame came from over the selected one", () => {
    // The two disagree for one stream teardown after the user switches rooms,
    // and the frame is the one describing audible sound.
    const bar = describePlayerBar(frame({ device: "Office" }), station(), "Kitchen");
    assert.equal(bar.subtitle, "Now playing · Office");
    const idle = describePlayerBar(frame({ state: "STOPPED", device: "Office" }), null, "Kitchen");
    assert.equal(idle.subtitle, "Office");
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
