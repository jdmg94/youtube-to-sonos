/**
 * `describeNowPlaying` is the only thing standing between an event frame and
 * the sentence the user reads about their own speaker. Every case here is one
 * the real backend produces: soco's empty strings, the `TRANSITIONING` gap
 * between queue items, a `STOPPED` speaker that still reports its last track's
 * title.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { NowPlaying, PlaybackState, StationBody } from "@/lib/api/types";
import {
  NO_TRACK,
  UNTITLED_TRACK,
  canGoNext,
  canGoPrevious,
  describeNowPlaying,
} from "@/lib/now-playing";

/**
 * A frame shaped like the backend's, not like the type's minimum. The empty
 * strings are what soco actually returns for an unpopulated field, and building
 * the fixture with `null` instead would quietly make every test easier than
 * reality.
 */
function frame(overrides: Partial<NowPlaying> = {}): NowPlaying {
  return {
    state: "PLAYING",
    title: "Rocket Man",
    artist: "Elton John",
    album_art: "",
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

function station(overrides: Partial<StationBody> = {}): StationBody {
  return { index: 0, exhausted: false, tracks: [], ...overrides };
}

/** Enough of a track for the station helpers, which only count them. */
const TRACK = {
  id: "abc123",
  title: "Rocket Man",
  uploader: "Elton John",
  thumbnail: null,
  duration: 281,
  cached: "done",
  queue_pos: 1,
} as const;

// ---------------------------------------------------------------------------

describe("describeNowPlaying", () => {
  it("names the track and the room it is playing in", () => {
    const view = describeNowPlaying(frame(), "Kitchen");
    assert.deepEqual(view, {
      mode: "playing",
      label: "Now playing · Kitchen",
      title: "Rocket Man",
    });
  });

  it("distinguishes paused from playing", () => {
    const view = describeNowPlaying(frame({ state: "PAUSED_PLAYBACK" }), "Kitchen");
    assert.equal(view.mode, "paused");
    assert.equal(view.label, "Paused · Kitchen");
    // The track is still loaded and still what Play would resume, so it stays
    // on screen.
    assert.equal(view.title, "Rocket Man");
  });

  it("holds the track through the gap between queue items", () => {
    // Sonos reports TRANSITIONING for a second or two on every track change.
    // Treating it as idle blinks the card to "—" between every single song.
    const view = describeNowPlaying(frame({ state: "TRANSITIONING" }), "Kitchen");
    assert.equal(view.mode, "playing");
    assert.equal(view.title, "Rocket Man");
  });

  it("goes idle when the speaker stops, whatever it still reports", () => {
    // A stopped speaker keeps answering with the last track's metadata. Showing
    // it would claim music is playing in a silent room.
    const view = describeNowPlaying(frame({ state: "STOPPED" }), "Kitchen");
    assert.deepEqual(view, { mode: "idle", label: "Idle · Kitchen", title: NO_TRACK });
  });

  it("goes idle with no frame at all, and still names the speaker", () => {
    // Before the first frame and during a reconnect. The room name is the one
    // thing we do know, and dropping it makes the card look disconnected from
    // the speaker the user just chose.
    const view = describeNowPlaying(null, "Kitchen");
    assert.deepEqual(view, { mode: "idle", label: "Idle · Kitchen", title: NO_TRACK });
  });

  it("prefers the speaker the frame came from over the selected one", () => {
    // These disagree for exactly one stream-teardown's worth of time after the
    // user switches rooms. The frame is the one describing audible sound.
    const view = describeNowPlaying(frame({ device: "Office" }), "Kitchen");
    assert.equal(view.label, "Now playing · Office");
  });

  it("drops the separator rather than trailing it when no name is known", () => {
    const view = describeNowPlaying(frame({ device: "" }), null);
    assert.equal(view.label, "Now playing", "a dangling ' · ' reads as a truncated string");
  });

  it("names an untitled track rather than leaving the row blank", () => {
    // soco reports "" — not null — for a track Sonos could not tag.
    assert.equal(describeNowPlaying(frame({ title: "" }), "Kitchen").title, UNTITLED_TRACK);
    assert.equal(describeNowPlaying(frame({ title: null }), "Kitchen").title, UNTITLED_TRACK);
    // Whitespace is the case `present()` alone misses: it is a non-empty
    // string that renders as an empty line.
    assert.equal(describeNowPlaying(frame({ title: "   " }), "Kitchen").title, UNTITLED_TRACK);
  });

  it("shows a real title unaltered", () => {
    // Including one that would survive a naive falsy check but not a sloppy
    // trim-and-replace.
    assert.equal(describeNowPlaying(frame({ title: "0" }), "Kitchen").title, "0");
  });

  it("treats every non-engaged state as idle", () => {
    // Guards the state list itself: adding a state to `ENGAGED_STATES` that
    // Sonos uses for silence is how the card starts lying.
    const idle: PlaybackState[] = ["STOPPED"];
    for (const state of idle) {
      assert.equal(describeNowPlaying(frame({ state }), "Kitchen").mode, "idle", state);
    }
    const engaged: PlaybackState[] = ["PLAYING", "TRANSITIONING", "PAUSED_PLAYBACK"];
    for (const state of engaged) {
      assert.notEqual(describeNowPlaying(frame({ state }), "Kitchen").mode, "idle", state);
    }
  });
});

describe("canGoPrevious", () => {
  it("is closed at the start of the station", () => {
    // Sonos answers `prev` at position 1 by restarting the track, which reads
    // as the button having misfired.
    assert.equal(canGoPrevious(station({ tracks: [TRACK] })), false);
  });

  it("opens once something has been played", () => {
    assert.equal(canGoPrevious(station({ index: 1, tracks: [TRACK, TRACK] })), true);
  });

  it("is closed with no station", () => {
    assert.equal(canGoPrevious(null), false);
    assert.equal(canGoPrevious(station()), false);
  });

  it("is closed for an empty station that claims a cursor", () => {
    // "No station" and "playing the first track" both serialise as index 0, but
    // a stale index on an empty list must not enable a command with nothing to
    // go back to.
    assert.equal(canGoPrevious(station({ index: 3, tracks: [] })), false);
  });
});

describe("canGoNext", () => {
  it("stays open on the last known track", () => {
    // The station loop extends itself ahead of the cursor. Requiring a visible
    // successor would grey Next out for precisely as long as the server takes
    // to resolve one — the moment it is most likely to be pressed.
    assert.equal(canGoNext(station({ index: 0, tracks: [TRACK] })), true);
  });

  it("is closed with no station", () => {
    assert.equal(canGoNext(null), false);
    assert.equal(canGoNext(station()), false);
  });

  it("stays open on an exhausted station", () => {
    // Exhausted means no *unheard* track was found, not that the queue is
    // empty — the speaker can still walk what it already has.
    assert.equal(canGoNext(station({ exhausted: true, tracks: [TRACK] })), true);
  });
});
