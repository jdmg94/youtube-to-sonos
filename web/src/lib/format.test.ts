/**
 * `formatDuration` is the kind of function that looks too small to test right
 * up until a track shows `4:5` instead of `4:05`, or an hour-long DJ set shows
 * `1:1:1`. The padding rules are conditional — minutes are padded only when
 * hours precede them — and every one of the edges below has a wrong
 * implementation that passes the obvious cases.
 *
 * No JSX: this file is `.ts` so Node can strip its types with no transform.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NO_DURATION, formatDuration } from "@/lib/format";

describe("formatDuration", () => {
  it("formats a song as m:ss", () => {
    // 4:41 — Rocket Man, the fixture used throughout these tests.
    assert.equal(formatDuration(281), "4:41");
  });

  it("pads the seconds", () => {
    assert.equal(formatDuration(245), "4:05");
    assert.equal(formatDuration(60), "1:00");
  });

  it("does not pad the minutes below an hour", () => {
    // `04:41` for a four-minute track reads as a stopwatch, not a song length.
    assert.equal(formatDuration(281), "4:41");
    assert.equal(formatDuration(65), "1:05");
  });

  it("shows sub-minute lengths with a zero minute field", () => {
    assert.equal(formatDuration(9), "0:09");
    assert.equal(formatDuration(59), "0:59");
  });

  it("adds an hours field past an hour, and pads the minutes then", () => {
    assert.equal(formatDuration(3600), "1:00:00");
    assert.equal(formatDuration(3661), "1:01:01");
    assert.equal(formatDuration(3599), "59:59", "one second short is not an hour");
  });

  it("keeps counting hours rather than rolling over to days", () => {
    // A ten-hour ambient upload is a real thing on YouTube.
    assert.equal(formatDuration(36000), "10:00:00");
  });

  it("shows an unknown length as 0:00 rather than as blank", () => {
    // A live stream has no duration. The row still needs something in it.
    assert.equal(formatDuration(null), NO_DURATION);
    assert.equal(formatDuration(undefined), NO_DURATION);
    assert.equal(formatDuration(0), NO_DURATION);
  });

  it("floors a fractional duration instead of printing it", () => {
    // yt-dlp reports floats for some extractors. Unfloored this renders
    // `4:41.5`, which is the sort of thing that ships.
    assert.equal(formatDuration(281.5), "4:41");
    assert.equal(formatDuration(59.99), "0:59");
  });

  it("refuses nonsense instead of rendering it", () => {
    // The original's `!seconds` guard passes a negative straight through to
    // the arithmetic, which prints `-1:-5`.
    assert.equal(formatDuration(-5), NO_DURATION);
    assert.equal(formatDuration(Number.NaN), NO_DURATION);
    assert.equal(formatDuration(Number.POSITIVE_INFINITY), NO_DURATION);
  });
});
