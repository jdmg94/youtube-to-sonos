/**
 * The queue's decisions are all about download state, and getting one wrong is
 * silent. A row wrongly greyed out is a song the listener can never return to;
 * a row wrongly clickable sends the speaker to a queue position that does not
 * exist and it goes quiet.
 *
 * The fixtures below use the combinations the backend actually produces —
 * including the one that reads like a contradiction, `queue_pos` set with
 * `cached: "missing"`, which is what an evicted track behind the cursor looks
 * like and is precisely the case a `cached === "done"` check would break.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CacheState, StationBody, StationTrack } from "@/lib/api/types";
import {
  NO_TRACKS,
  UNKNOWN_UPLOADER,
  UNTITLED,
  canRefresh,
  describeJump,
  describeQueue,
  describeRefresh,
  describeRemove,
  describeRemoved,
  rowStatus,
  trackStatus,
} from "@/lib/queue";

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

// ---------------------------------------------------------------------------

describe("trackStatus", () => {
  it("distinguishes a failed download from a slow one", () => {
    // A failed track sits in a retry cooldown for minutes. Reporting it as
    // merely queued leaves the listener waiting for something that isn't
    // coming.
    assert.notEqual(trackStatus("failed"), trackStatus("queued"));
    assert.equal(trackStatus("failed"), "unavailable");
  });

  it("collapses the two states that mean the bytes simply aren't here yet", () => {
    // `queued` is pending work and `missing` is no work at all — a real
    // difference to the scheduler, and nothing the row has anything different
    // to say about.
    assert.equal(trackStatus("queued"), "waiting");
    assert.equal(trackStatus("missing"), "waiting");
  });

  it("maps the two live states to their own labels", () => {
    assert.equal(trackStatus("done"), "ready");
    assert.equal(trackStatus("running"), "downloading");
  });

  it("has an answer for every state the backend can send", () => {
    const states: CacheState[] = ["done", "running", "queued", "failed", "missing"];
    for (const state of states) {
      assert.ok(trackStatus(state), `no status for ${state}`);
    }
  });
});

describe("rowStatus", () => {
  it("does not tell the listener a playable track is queued", () => {
    // The bug this exists to prevent, and the one an in-browser pass found:
    // an evicted-but-enqueued track reads `missing` from the cache, which maps
    // to `waiting` → "queued", on a row that is clickable and starts playing
    // immediately. The status column's only job is to say why a row *won't*
    // play, so that label is the one reading that actively misleads.
    const evicted = track({ cached: "missing", queue_pos: 1 });
    assert.equal(trackStatus(evicted.cached), "waiting");
    assert.equal(rowStatus(evicted), "ready");
  });

  it("still says queued for a track Sonos has never been handed", () => {
    assert.equal(rowStatus(track({ cached: "queued", queue_pos: null })), "waiting");
    assert.equal(rowStatus(track({ cached: "missing", queue_pos: null })), "waiting");
  });

  it("keeps warning about a failed track even once it is enqueued", () => {
    // The one state where the bytes may never arrive. Being in the Sonos queue
    // does not make a track that cannot be downloaded playable.
    assert.equal(rowStatus(track({ cached: "failed", queue_pos: 2 })), "unavailable");
  });

  it("keeps reporting an enqueued track that is being re-fetched as downloading", () => {
    // Not corrected to `ready`: this one explains a slow start, and unlike
    // "queued" it does not imply the row is inert.
    assert.equal(rowStatus(track({ cached: "running", queue_pos: 2 })), "downloading");
  });

  it("leaves a cached track alone", () => {
    assert.equal(rowStatus(track({ cached: "done", queue_pos: 1 })), "ready");
    assert.equal(rowStatus(track({ cached: "done", queue_pos: null })), "ready");
  });
});

describe("describeQueue", () => {
  it("renders nothing rather than throwing when there is no station", () => {
    assert.deepEqual(describeQueue(null), []);
    assert.deepEqual(describeQueue(undefined), []);
    assert.deepEqual(describeQueue(station({ tracks: [] })), []);
  });

  it("keeps station order and carries each track's own index", () => {
    const rows = describeQueue(
      station({ tracks: [track({ id: "a" }), track({ id: "b" }), track({ id: "c" })] }),
    );
    // The index is what `jump` is addressed by, so it must be the position in
    // the station list and not the position in whatever subset was rendered.
    assert.deepEqual(
      rows.map((row) => row.index),
      [0, 1, 2],
    );
  });

  it("marks exactly one row as the cursor", () => {
    const rows = describeQueue(
      station({ index: 1, tracks: [track(), track(), track()] }),
    );
    assert.deepEqual(
      rows.map((row) => row.active),
      [false, true, false],
    );
  });

  it("marks no row active when the cursor has run past the list", () => {
    // Reachable: the station is replaced wholesale on every frame, and a
    // refresh can shrink `tracks` under a cursor that has not moved yet.
    const rows = describeQueue(station({ index: 5, tracks: [track(), track()] }));
    assert.deepEqual(
      rows.map((row) => row.active),
      [false, false],
    );
  });

  it("names a track the backend could not name", () => {
    const rows = describeQueue(
      station({ tracks: [track({ title: null, uploader: null })] }),
    );
    assert.equal(rows[0].title, UNTITLED);
    // Not "Unknown" — every one of these came from YouTube.
    assert.equal(rows[0].uploader, UNKNOWN_UPLOADER);
  });

  it("treats an empty string as no value, not as a value", () => {
    // A sidecar written from a stream with an empty tag sends `""`, and `??`
    // would happily let it through and collapse the row to a blank line.
    const rows = describeQueue(
      station({ tracks: [track({ title: "", uploader: "", thumbnail: "" })] }),
    );
    assert.equal(rows[0].title, UNTITLED);
    assert.equal(rows[0].uploader, UNKNOWN_UPLOADER);
    // `null` and not `""`: the component branches on it to render the
    // placeholder, and an empty `src` makes the browser re-request the page.
    assert.equal(rows[0].thumbnail, null);
  });

  it("labels only the rows that have something to say", () => {
    // `queue_pos: null` on everything after the first is not incidental: the
    // backend enqueues a *prefix* (`i + 1 if i < enqueued else None`) and only
    // ever enqueues finished downloads, so a running/queued/failed track never
    // carries a position. A fixture that gave them one would be describing a
    // station the server cannot produce — and would hide the correction in
    // `rowStatus` below.
    const rows = describeQueue(
      station({
        tracks: [
          track({ cached: "done", queue_pos: 1 }),
          track({ cached: "running", queue_pos: null }),
          track({ cached: "queued", queue_pos: null }),
          track({ cached: "failed", queue_pos: null }),
        ],
      }),
    );
    // Blank for `ready` on purpose: it is the state almost every row is in, and
    // a badge on all of them hides the two that matter.
    assert.equal(rows[0].statusLabel, "");
    assert.equal(rows[1].statusLabel, "downloading…");
    assert.equal(rows[2].statusLabel, "queued");
    assert.equal(rows[3].statusLabel, "unavailable");
  });

  it("calls an enqueued track jumpable even after its audio was evicted", () => {
    // The window moves on but the Sonos queue is never trimmed, so a track a
    // few songs back keeps its `queue_pos` and reverts to `missing`. Playing it
    // re-requests /media and the download restarts — this is the whole
    // mechanism by which stepping back works.
    const rows = describeQueue(
      station({ tracks: [track({ cached: "missing", queue_pos: 1 })] }),
    );
    assert.equal(rows[0].jumpable, true);
    // And says nothing about it. Asserted here and not only against
    // `rowStatus`, because the row is free to call the cache-only mapper
    // instead — which is a mutant that survived until this line existed.
    assert.equal(rows[0].status, "ready");
    assert.equal(rows[0].statusLabel, "");
  });

  it("refuses a track Sonos has never been handed", () => {
    const rows = describeQueue(
      station({ tracks: [track({ cached: "running", queue_pos: null })] }),
    );
    assert.equal(rows[0].jumpable, false);
  });

  it("offers removal only on the rows still to come", () => {
    // The backend refuses anything at or behind the cursor, because a removal
    // renumbers `playlist_position` for everything after it — take out the
    // playing track and the speaker's own position moves under both lists.
    const rows = describeQueue(
      station({ index: 1, tracks: [track(), track(), track()] }),
    );
    assert.equal(rows[0].removable, false, "already played");
    assert.equal(rows[1].removable, false, "playing now");
    assert.equal(rows[2].removable, true, "still to come");
  });

  it("offers removal on a track that has not been downloaded yet", () => {
    // Unlike jumping, removal has nothing to do with the bytes: a track the
    // scheduler has not started is exactly the one worth dropping, and it is
    // not on the Sonos queue at all so nothing needs renumbering.
    const rows = describeQueue(
      station({
        index: 0,
        tracks: [track(), track({ cached: "queued", queue_pos: null })],
      }),
    );
    assert.equal(rows[1].removable, true);
    assert.equal(rows[1].jumpable, false);
  });

  it("offers removal on a track that failed to download", () => {
    // The one row the listener most wants gone.
    const rows = describeQueue(
      station({
        index: 0,
        tracks: [track(), track({ cached: "failed", queue_pos: null })],
      }),
    );
    assert.equal(rows[1].removable, true);
  });

  it("carries each row's id, so a removal can be checked against its index", () => {
    const rows = describeQueue(
      station({ tracks: [track({ id: "aaa" }), track({ id: "bbb" })] }),
    );
    assert.equal(rows[0].id, "aaa");
    assert.equal(rows[1].id, "bbb");
  });
});

describe("describeRemove", () => {
  it("sends the index and the id together", () => {
    // Both, always: the index alone is a position in a list the server may
    // have changed since this frame, and acting on it deletes the wrong song
    // silently.
    const list = station({ index: 0, tracks: [track({ id: "aaa" }), track({ id: "bbb" })] });
    assert.deepEqual(describeRemove(list, 1), { ok: true, index: 1, id: "bbb" });
  });

  it("refuses the playing track", () => {
    const list = station({ index: 1, tracks: [track(), track(), track()] });
    assert.deepEqual(describeRemove(list, 1), {
      ok: false,
      message: "That track is already playing",
    });
  });

  it("refuses a track that has already played", () => {
    const list = station({ index: 2, tracks: [track(), track(), track()] });
    assert.equal(describeRemove(list, 0).ok, false);
  });

  it("refuses an index the station no longer has", () => {
    const decision = describeRemove(station({ tracks: [track()] }), 7);
    assert.deepEqual(decision, { ok: false, message: "That track is no longer queued" });
  });

  it("refuses a negative index", () => {
    assert.equal(describeRemove(station({ tracks: [track()] }), -1).ok, false);
  });

  it("refuses when there is no station at all", () => {
    assert.equal(describeRemove(null, 0).ok, false);
    assert.equal(describeRemove(undefined, 0).ok, false);
  });

  it("agrees with the row it is offered on", () => {
    // The button is rendered from `removable` and the request is built from
    // `describeRemove`. If they ever disagree the listener gets a button that
    // answers with a refusal, which is the exact confusion the always-visible
    // X is meant to avoid.
    const list = station({ index: 1, tracks: [track(), track(), track(), track()] });
    for (const row of describeQueue(list)) {
      assert.equal(row.removable, describeRemove(list, row.index).ok, `row ${row.index}`);
    }
  });
});

describe("describeRemoved", () => {
  it("names the track that went", () => {
    // The row is gone by the time this is read, so the toast is the only thing
    // that can confirm which one — the whole point of naming it.
    assert.equal(describeRemoved("Rocket Man"), "Removed Rocket Man");
  });

  it("falls back to a name for a track the backend could not name", () => {
    // The backend sends `title: null` straight from the station meta, and
    // "Removed null" is what the plain interpolation gives.
    assert.equal(describeRemoved(null), `Removed ${UNTITLED}`);
    assert.equal(describeRemoved(""), `Removed ${UNTITLED}`);
  });
});

describe("describeJump", () => {
  it("passes through the index of a queued track", () => {
    assert.deepEqual(describeJump(station(), 0), { ok: true, index: 0 });
  });

  it("tells the listener to wait for a track that is still downloading", () => {
    const decision = describeJump(
      station({ tracks: [track({ cached: "running", queue_pos: null })] }),
      0,
    );
    assert.deepEqual(decision, { ok: false, message: "That track is still downloading" });
  });

  it("tells the listener not to wait for one that failed", () => {
    // The two messages are the useful half: one means wait, the other means
    // don't.
    const decision = describeJump(
      station({ tracks: [track({ cached: "failed", queue_pos: null })] }),
      0,
    );
    assert.deepEqual(decision, { ok: false, message: "That track couldn't be downloaded" });
  });

  it("refuses an index the station no longer has", () => {
    // A click can land against a list that has since shrunk — the station is
    // replaced wholesale on every SSE frame.
    const decision = describeJump(station({ tracks: [track()] }), 7);
    assert.equal(decision.ok, false);
    assert.equal(decision.ok === false && decision.message, "That track is no longer queued");
  });

  it("refuses when there is no station at all", () => {
    assert.equal(describeJump(null, 0).ok, false);
    assert.equal(describeJump(undefined, 0).ok, false);
  });

  it("never returns an index it was not asked about", () => {
    const list = station({ index: 0, tracks: [track(), track(), track()] });
    const decision = describeJump(list, 2);
    assert.deepEqual(decision, { ok: true, index: 2 });
  });
});

describe("canRefresh", () => {
  it("is offered when something is queued ahead of the cursor", () => {
    assert.equal(canRefresh(station({ index: 0, tracks: [track(), track()] }), true, false), true);
  });

  it("is withheld on the last known track", () => {
    // Refresh replaces what is queued *after* the current track. On the last
    // row there is nothing to discard and the server answers 404.
    assert.equal(canRefresh(station({ index: 1, tracks: [track(), track()] }), true, false), false);
  });

  it("counts the full track list, not what has been enqueued", () => {
    // The station loop extends `tracks` before those tracks reach the speaker,
    // and they are exactly what a refresh is for.
    const ahead = station({
      index: 0,
      tracks: [track(), track({ cached: "queued", queue_pos: null })],
    });
    assert.equal(canRefresh(ahead, true, false), true);
  });

  it("is withheld with no speaker, no station, or a refresh already running", () => {
    const ready = station({ index: 0, tracks: [track(), track()] });
    assert.equal(canRefresh(ready, false, false), false, "nothing to send it to");
    assert.equal(canRefresh(null, true, false), false, "no station");
    assert.equal(canRefresh(ready, true, true), false, "already in flight");
  });

  it("is withheld on an empty station", () => {
    assert.equal(canRefresh(station({ tracks: [] }), true, false), false);
  });
});

describe("describeRefresh", () => {
  it("reports what was replaced, in the right number", () => {
    assert.equal(describeRefresh(1), "Queue refreshed — 1 track replaced");
    assert.equal(describeRefresh(7), "Queue refreshed — 7 tracks replaced");
  });

  it("pluralises zero as a plural", () => {
    // The server can legitimately drop nothing and still succeed. "0 track"
    // is the one the original's "track(s)" was hiding.
    assert.equal(describeRefresh(0), "Queue refreshed — 0 tracks replaced");
  });
});

/*
 * The fallbacks are asserted against their literals here, not just against the
 * constants. Every other test compares `row.uploader` to `UNKNOWN_UPLOADER`,
 * which moves with the source and would let the word change to anything at all
 * without a single failure — a mutation run is what showed that.
 */
describe("the words the user actually reads", () => {
  it("attributes an unnamed channel to YouTube, not to nobody", () => {
    // Not "Unknown": every one of these tracks came from YouTube, and the
    // channel is the only fact in doubt.
    assert.equal(UNKNOWN_UPLOADER, "YouTube");
  });

  it("calls an unnamed track Untitled", () => {
    assert.equal(UNTITLED, "Untitled");
  });

  it("says nothing is queued rather than reporting an error", () => {
    // An empty station is the normal state before the first play, not a
    // failure to load.
    assert.equal(NO_TRACKS, "No tracks queued yet");
  });
});
