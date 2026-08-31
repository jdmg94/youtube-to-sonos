/**
 * `describeCast` reads a *successful* HTTP response and decides whether to tell
 * the user it worked. Two of its three outcomes are 200s that mean something
 * other than "playing", and collapsing them — the obvious simplification —
 * produces the two worst messages this app can show: "cast successfully" over
 * a silent room, and "cast successfully" when the song was actually queued
 * behind the one still playing.
 *
 * `describeVideo` is the smaller half: what the panel shows when yt-dlp
 * resolved the video but named none of it.
 *
 * No JSX: this file is `.ts` so Node can strip its types with no transform.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PlayNextResponse, PlayNowResponse, VideoInfo } from "@/lib/api/types";
import { UNKNOWN_UPLOADER, UNTITLED_VIDEO, describeCast, describeVideo } from "@/lib/stream";

function info(overrides: Partial<VideoInfo> = {}): VideoInfo {
  return {
    id: "abc",
    title: "Rocket Man",
    uploader: "Elton John",
    thumbnail: "https://i.ytimg.com/vi/abc/hqdefault.jpg",
    duration: 281,
    ...overrides,
  };
}

function playedNow(overrides: Partial<PlayNowResponse> = {}): PlayNowResponse {
  return {
    status: "playing",
    device: "Lounge",
    device_ip: "192.168.0.181",
    stream_url: "http://192.168.0.191:5001/media/abc.mp3",
    autoplay: true,
    video_id: "abc",
    title: "Rocket Man",
    started: true,
    queued_next: false,
    ...overrides,
  };
}

function queuedNext(overrides: Partial<PlayNextResponse> = {}): PlayNextResponse {
  return {
    status: "queued",
    device: "Lounge",
    device_ip: "192.168.0.181",
    stream_url: "http://192.168.0.191:5001/media/abc.mp3",
    autoplay: true,
    video_id: "abc",
    title: "Rocket Man",
    queued_next: true,
    queue_position: 4,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe("describeVideo", () => {
  it("passes through what yt-dlp knew", () => {
    const view = describeVideo(info());
    assert.equal(view.title, "Rocket Man");
    assert.equal(view.uploader, "Elton John");
    assert.equal(view.duration, "4:41");
    assert.equal(view.thumbnail, "https://i.ytimg.com/vi/abc/hqdefault.jpg");
  });

  it("names an untitled video rather than showing a blank line", () => {
    assert.equal(describeVideo(info({ title: null })).title, UNTITLED_VIDEO);
    assert.equal(describeVideo(info({ title: "" })).title, UNTITLED_VIDEO);
  });

  it("labels a missing channel", () => {
    assert.equal(describeVideo(info({ uploader: null })).uploader, UNKNOWN_UPLOADER);
    assert.equal(describeVideo(info({ uploader: "" })).uploader, UNKNOWN_UPLOADER);
  });

  it("shows an unknown length as 0:00", () => {
    assert.equal(describeVideo(info({ duration: null })).duration, "0:00");
  });

  it("reports a missing thumbnail as null so the panel can draw a placeholder", () => {
    // Not `""`. An empty `src` makes the browser re-request the page itself.
    assert.equal(describeVideo(info({ thumbnail: null })).thumbnail, null);
    assert.equal(describeVideo(info({ thumbnail: "" })).thumbnail, null);
  });

  it("keeps a title that is merely falsy-looking", () => {
    assert.equal(describeVideo(info({ title: "0" })).title, "0");
  });
});

describe("describeCast", () => {
  it("confirms a track the speaker started playing", () => {
    const outcome = describeCast(playedNow());
    assert.equal(outcome.ok, true);
    assert.equal(outcome.message, "Audio cast successfully to Lounge");
  });

  it("reports a queued track as queued, not as playing", () => {
    // The speaker keeps playing what it had. Saying "cast successfully" here
    // is contradicted by the listener's own ears.
    const outcome = describeCast(queuedNext());
    assert.equal(outcome.ok, true);
    assert.equal(outcome.message, "Queued next on Lounge: Rocket Man");
  });

  it("still names the room when a queued track has no title", () => {
    assert.equal(describeCast(queuedNext({ title: null })).message, "Queued next on Lounge: track");
    assert.equal(describeCast(queuedNext({ title: "" })).message, "Queued next on Lounge: track");
  });

  it("raises a speaker that accepted the track and never started", () => {
    // The request succeeded and the room is silent. This is the only outcome
    // that must not read as success.
    const outcome = describeCast(playedNow({ started: false }));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.message, "Lounge didn't start playing — try again");
  });

  it("does not apply the started check to a queued track", () => {
    // `started` is absent from the queued shape. A check that ran first, or
    // that read `started` off both, would report every play-next as a failure.
    assert.equal(describeCast(queuedNext()).ok, true);
  });

  it("names the speaker that was actually used", () => {
    // `device_ip` is optional on the request, so the backend may have picked
    // the first speaker it found. The message has to say which.
    assert.equal(
      describeCast(playedNow({ device: "Kitchen" })).message,
      "Audio cast successfully to Kitchen",
    );
    assert.equal(
      describeCast(playedNow({ device: "Kitchen", started: false })).message,
      "Kitchen didn't start playing — try again",
    );
    assert.equal(
      describeCast(queuedNext({ device: "Kitchen" })).message,
      "Queued next on Kitchen: Rocket Man",
    );
  });
});
