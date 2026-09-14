/**
 * The queue panel's view model.
 *
 * Same split as `now-playing.ts`: the decisions live here, in a `.ts` file Node
 * can test without a JSX transform, and the component only arranges what this
 * returns. The decisions worth isolating are all about *download state* — which
 * rows can be clicked, and what a row that can't says instead — because getting
 * either wrong is silent. A row wrongly greyed out is a song the listener can
 * never return to; a row wrongly clickable sends the speaker to a queue
 * position that does not exist and it goes quiet.
 */
import { isJumpable, type CacheState, type StationBody, type StationTrack } from "@/lib/api/types";

/** Shown in place of the list when the speaker has no station. */
export const NO_TRACKS = "No tracks queued yet";

/** A track yt-dlp resolved but could not name. */
export const UNTITLED = "Untitled";

/** A track with no channel. Not "Unknown" — every one of these is from YouTube. */
export const UNKNOWN_UPLOADER = "YouTube";

/** Shown when the station has run out of new songs and is replaying old ones. */
export const EXHAUSTED =
  "Out of new songs for this station — replaying ones you've heard, oldest first.";

/**
 * A track's download state, reduced to what the row actually distinguishes.
 *
 * Four cases from five wire values: `queued` and `missing` both mean "the
 * bytes aren't here and nothing is wrong", and the row has nothing different
 * to say about them. They are not the same thing to the *scheduler* — one is
 * pending work and one is no work at all — but this is a queue, not
 * `/api/downloads`.
 */
export type TrackStatus = "ready" | "downloading" | "waiting" | "unavailable";

/**
 * `failed` must read differently from `queued`. A failed track sits in a retry
 * cooldown for minutes, so showing it as merely slow leaves the listener
 * waiting for something that isn't coming.
 *
 * `ready` is blank on purpose: it is the state almost every row is in, and a
 * badge on all of them would be noise that hides the two that matter.
 */
const STATUS_LABEL: Record<TrackStatus, string> = {
  ready: "",
  downloading: "downloading…",
  waiting: "queued",
  unavailable: "unavailable",
};

export function trackStatus(cached: CacheState): TrackStatus {
  switch (cached) {
    case "done":
      return "ready";
    case "running":
      return "downloading";
    case "failed":
      return "unavailable";
    default:
      return "waiting";
  }
}

/**
 * A track's status *as a row* — cache state corrected for whether the speaker
 * can already play it.
 *
 * `trackStatus` alone gets one case backwards. A track that has been enqueued
 * and then had its audio evicted comes back as `missing` while keeping its
 * `queue_pos`, so the cache-only reading is `waiting` → "queued" — on a row
 * that is clickable and plays immediately. The status column's whole job is to
 * say why a row *won't* play, so "queued" on a row that will is the one label
 * that actively misleads. Stepping back to a song from ten minutes ago is a
 * normal thing to do and it is precisely the case that hits this.
 *
 * `running` is deliberately left alone: an enqueued track being re-fetched is
 * genuinely downloading, and saying so explains a slow start without implying
 * the row is dead. `failed` is left alone too — it is the one state where the
 * bytes may never arrive, so the warning outranks the fact that it is enqueued.
 */
export function rowStatus(track: StationTrack): TrackStatus {
  const status = trackStatus(track.cached);
  return status === "waiting" && isJumpable(track) ? "ready" : status;
}

export interface QueueRow {
  /** The station index. Also what `jump` is addressed by. */
  index: number;
  /**
   * The video id. Sent alongside the index on a removal so the server can
   * check that the two still agree — see `describeRemove`.
   */
  id: string;
  title: string;
  uploader: string;
  /** `null` renders the music-note placeholder. */
  thumbnail: string | null;
  status: TrackStatus;
  /** Empty for a ready track. */
  statusLabel: string;
  /** This is the cursor — the track the speaker is on. */
  active: boolean;
  /**
   * Whether clicking will actually move the speaker. The row stays clickable
   * either way — see `describeJump`.
   */
  jumpable: boolean;
  /**
   * Whether this row gets a remove button at all.
   *
   * The opposite treatment to `jumpable`, which leaves the row clickable and
   * answers with a reason. A refusal to jump is temporary and worth
   * explaining — "still downloading" means wait — whereas a row at or behind
   * the cursor can never be removed and there is nothing to wait for. A
   * button that will never work is worse than no button.
   *
   * Note this says nothing about download state: a track that failed or has
   * not started is exactly the one worth dropping.
   */
  removable: boolean;
}

/**
 * One row per station track, in order.
 *
 * Takes the whole station rather than mapping over `tracks`, because `active`
 * is a property of the *list* — it needs the cursor — and a per-track mapper
 * would have to be handed the index and the cursor by every caller anyway.
 */
export function describeQueue(station: StationBody | null | undefined): QueueRow[] {
  if (!station) return [];
  return station.tracks.map((track, index) => describeRow(track, index, station.index));
}

function describeRow(track: StationTrack, index: number, cursor: number): QueueRow {
  const status = rowStatus(track);
  return {
    index,
    id: track.id,
    // `||` and not `??`: the backend sends `null` for an untitled track, but
    // a metadata sidecar written from a stream with an empty tag sends `""`,
    // and an empty string here collapses the row to a blank line.
    title: track.title || UNTITLED,
    uploader: track.uploader || UNKNOWN_UPLOADER,
    thumbnail: track.thumbnail || null,
    status,
    statusLabel: STATUS_LABEL[status],
    active: index === cursor,
    jumpable: isJumpable(track),
    removable: index > cursor,
  };
}

/** The two halves of the panel, each in the order it should be drawn. */
export interface QueueSections {
  /** The playing track, then what follows it, in the order it will play. */
  upcoming: QueueRow[];
  /** What has already played, most recent first. */
  played: QueueRow[];
}

/**
 * The station list cut at the cursor and re-ordered for reading.
 *
 * The station never trims what it has played, so in play order the history
 * accumulates above the cursor and pushes the playing track — and everything
 * the listener actually wants to see — steadily further down. Drawn this way
 * the top of the panel is always "what's on, what's next", however long the
 * session has run.
 *
 * Only `upcoming` keeps play order. Reversing it too would put the immediate
 * next track at the bottom of its block and make the queue read upwards, which
 * is the arrangement this is here to avoid; `played` is reversed because its
 * useful end is the track that just finished, sitting against the divider.
 *
 * Order is the only thing decided here. The rows are the ones `describeQueue`
 * produced, indices and all — those are positions in the *station* list, and a
 * jump or a removal is addressed by id and resolved against that list at
 * dispatch (see `indexOfTrack`), so moving a row on screen cannot desync it.
 */
export function splitQueue(rows: QueueRow[]): QueueSections {
  const cursor = rows.findIndex((row) => row.active);
  // No active row — the cursor has run past the list, which `describeQueue`
  // already renders as "nothing is playing". Calling one of these upcoming
  // would draw a playing track the speaker is not on.
  if (cursor < 0) return { upcoming: [], played: [...rows].reverse() };
  return { upcoming: rows.slice(cursor), played: rows.slice(0, cursor).reverse() };
}

/**
 * The station as the panel should draw it: the last frame minus the tracks
 * already dropped.
 *
 * A removal is optimistic — the row goes on click and the frame confirming it
 * arrives seconds later — so for that gap the panel's list and the server's
 * list differ by exactly `removed`. Subtracting them here, once, is what keeps
 * the two halves of the panel honest: `describeQueue`, `describeJump` and
 * `describeRemove` all read the result instead of the raw frame, so the hidden
 * rows and the indices sent back to the server shift together. The alternative
 * — filtering the rows and leaving the indices alone — is off by one for every
 * track after a dropped one, which plays or deletes the *next* song without a
 * word.
 *
 * Returns the frame itself when there is nothing to subtract. This runs on
 * every render and a fresh object each time would invalidate everything
 * memoised on it.
 */
export function pendingStation(
  station: StationBody | null | undefined,
  removed: ReadonlySet<string>,
): StationBody | null {
  if (!station) return null;
  if (removed.size === 0) return station;

  const tracks: StationTrack[] = [];
  let cursor = station.index;
  station.tracks.forEach((track, i) => {
    if (!removed.has(track.id)) {
      tracks.push(track);
    } else if (i < station.index) {
      // Unreachable through the UI — nothing behind the cursor is removable —
      // but the cursor is an index into this list and a track vanishing ahead
      // of it would otherwise slide it onto the wrong row.
      cursor -= 1;
    }
  });
  return { ...station, index: cursor, tracks };
}

/**
 * Where a track is now, addressed by the id its row was drawn with.
 *
 * Every write is sent by id and resolved to an index at the moment it is
 * dispatched, never by the index the row was rendered with: a frame can land
 * between the click and the request, and a removal renumbers everything after
 * it. `-1` for a track that has gone, which `describeJump` and `describeRemove`
 * both read as "no longer queued" rather than as the last element.
 */
export function indexOfTrack(
  station: StationBody | null | undefined,
  id: string,
): number {
  if (!station) return -1;
  return station.tracks.findIndex((track) => track.id === id);
}

export type JumpDecision =
  | { ok: true; index: number }
  | { ok: false; message: string };

/**
 * What a click on row `index` should do.
 *
 * A row that can't be jumped to is left clickable and answers with a reason,
 * rather than being disabled. A disabled row explains itself only through a
 * `title` tooltip, which does not exist on a phone — and "the track I tapped
 * did nothing" is the exact confusion this is here to prevent. The reason is
 * also the useful half: "still downloading" means wait, "couldn't be
 * downloaded" means don't.
 */
export function describeJump(
  station: StationBody | null | undefined,
  index: number,
): JumpDecision {
  const track = station?.tracks[index];
  // Not reachable from a click on a rendered row, but `index` arrives from a
  // DOM dataset in the harness and from a stale render in the app: the station
  // is replaced wholesale on every SSE frame, so a click can land against a
  // list that has since shrunk.
  if (!track) return { ok: false, message: "That track is no longer queued" };

  if (!isJumpable(track)) {
    return {
      ok: false,
      message:
        track.cached === "failed"
          ? "That track couldn't be downloaded"
          : "That track is still downloading",
    };
  }
  return { ok: true, index };
}

/**
 * Whether Refresh is worth offering.
 *
 * Refresh replaces what is queued *after* the current track, so it needs
 * something queued after the current track. On the last known row there is
 * nothing to discard and the server answers 404.
 *
 * Note this is `> index + 1` on the full track list, not on what has been
 * enqueued: the station loop extends `tracks` before those tracks reach the
 * speaker, and they are exactly what a refresh is for.
 */
export function canRefresh(
  station: StationBody | null | undefined,
  hasDevice: boolean,
  pending: boolean,
): boolean {
  if (!station || !hasDevice || pending) return false;
  return station.tracks.length > station.index + 1;
}

/**
 * The toast after a refresh.
 *
 * Reports what was *replaced*, not what is queued now: the server refills a
 * couple of tracks synchronously and the station loop tops the rest up over the
 * next few seconds, so a count of the new queue would be wrong by the time it
 * is read.
 */
export function describeRefresh(dropped: number): string {
  const plural = dropped === 1 ? "track" : "tracks";
  return `Queue refreshed — ${dropped} ${plural} replaced`;
}

export type RemoveDecision =
  | { ok: true; index: number; id: string }
  | { ok: false; message: string };

/**
 * What a removal at `index` should send.
 *
 * The id travels with the index and is not redundant. The index is a position
 * in a list the server may have changed since — a play-next insert renumbers
 * everything after it — so by the time the request arrives it can name a
 * different song. The server checks the pair and refuses on a mismatch, which
 * turns "the wrong track silently disappeared" into "try again".
 *
 * Called with an index resolved from the row's id at dispatch (see
 * `indexOfTrack`), not with the index the row was rendered with. Both refusals
 * below are therefore reachable even though `removable` gates the button on
 * exactly the second one: the frame can move, and the speaker can advance onto
 * a track while its removal sits in the write queue.
 */
export function describeRemove(
  station: StationBody | null | undefined,
  index: number,
): RemoveDecision {
  const track = index >= 0 ? station?.tracks[index] : undefined;
  if (!track) return { ok: false, message: "That track is no longer queued" };
  // Removing at or behind the cursor renumbers the playing track's own queue
  // position out from under both lists; the server refuses it too.
  if (index <= (station?.index ?? 0)) {
    return { ok: false, message: "That track is already playing" };
  }
  return { ok: true, index, id: track.id };
}

/**
 * The banner for a station that has started repeating itself, or null.
 *
 * `exhausted` no longer means the queue stopped — with the oldest-first floor
 * the station always has something to play — so this is an explanation, not an
 * error. Returning null for the normal case keeps the caller a single
 * conditional render rather than a string comparison.
 */
export function describeExhausted(
  station: StationBody | null | undefined,
): string | null {
  return station?.exhausted ? EXHAUSTED : null;
}

