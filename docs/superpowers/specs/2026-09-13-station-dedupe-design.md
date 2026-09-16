# Station deduplication: song identity, listening history and pool width — design

Status: **approved, not yet implemented**
Branch: `feat-improve-dedup`
Date: 2026-09-13

## Goal

The station repeats itself, and the three mechanisms meant to stop it
(`Station.played_ids` / `played_titles`, the process-wide `_RECENT`, and the
per-build `seen_ids` / `seen_titles`) share one weakness: they compare songs by
a normalized *title string*, computed without reference to who performed it.

Five consequences, all of them live today:

1. **The same song under two uploads is not recognised.** `_title_key`
   (`app.py:621`) claims in its own docstring that "artist stays in the key",
   but that only holds when the uploader puts the artist in the title. An
   auto-generated `Artist - Topic` channel titles the video with the bare song
   name, so `"Dua Lipa - Levitating (Official Video)"` keys as
   `dua lipa levitating` and the Topic upload keys as `levitating`. Both are
   queueable.
2. **Different songs sharing a name are wrongly merged.** The same gap in
   reverse: two artists' `"Alone"` collapse to one key, and `_RECENT` then
   blocks the second across every station for twelve hours.
3. **`_artist_key` (`app.py:609`) prefers `channel_id`**, which flat extraction
   almost always supplies, so the `- Topic` stripping below it is nearly dead
   code. An artist's official channel and their Topic channel are two different
   artists to the cap and the cooldown, making `MAX_TRACKS_PER_ARTIST = 2`
   behave like 4. Third-party re-uploaders defeat it entirely.
4. **Nothing survives a restart.** `_RECENT` is a bare dict (`app.py:491`) and
   `cache_scan` does not restore it, so replaying a seed after a restart
   reproduces a near-identical opening — the exact failure `_RECENT` exists to
   prevent.
5. **The candidate pool is narrower than the exclusions it must feed.**
   `get_radio_mix` takes `limit=25` (`app.py:576`), two seeds per pick, memoized
   an hour. After roughly eighty tracks the ladder in `_pick_next`
   (`app.py:1546`) starts falling to its lower rungs, which is where behaviour
   is worst.

None of this is covered by a test. `build_station_queue`, `_title_key` and
`_artist_key` are pure or near-pure and there is no Python test for any of them,
while `web/src/lib` has roughly 900 lines of coverage for the code that merely
renders their output.

## What "the same song" means here

Settled with the user before design:

* **Any version except covers.** Live, acoustic, remix and sped-up cuts count
  as the same song and are skipped. A cover or remix credited to a *different*
  artist stays eligible.
* **Prefer skipping to repeating.** Where the heuristic is uncertain, match
  aggressively.
* **Prefer the audio upload.** When several uploads of one song are in the
  candidate pool, queue the clean audio one rather than the music video. This
  changes which *file* is downloaded, never which songs are chosen.
* **Widen the input before weakening the guarantee.** When the exclusion set
  eats the pool, fetch mixes from new seeds rather than dropping filters.
* **Seven-day, heard-only memory**, capped, with the newest exclusions never
  evicted first.

Note that "any version except covers" and "fuzzy matching confined to one
artist" are the same statement. The structure in Section 2 is not a performance
compromise that happens to be safe; it is the policy expressed directly.

## Measurements

Two probes against a live `RD` mix informed the design and are worth recording,
because both contradicted an assumption.

**Flat mix entries are richer than assumed.** `uploader` is the clean display
name (`Ed Sheeran`, not `EdSheeranVEVO`), and `channel_id` and `duration` are
always present. So duration is available as corroboration and artist names are
usable as keys.

```
title: "Ed Sheeran - Shape of You (Official Music Video)"  uploader: "Ed Sheeran"  dur: 264
title: "Ellie Goulding - Love Me Like You Do Lyrics (...)"  uploader: "Walker #57"  dur: 273
title: "Wiz Khalifa - See You Again ft. Charlie Puth [Official Video] Furious 7 Soundtrack"  dur: 238
title: "Passenger | Let Her Go (Official Video)"            uploader: "Passenger"   dur: 255
title: "Counting Stars"                                     uploader: "OneRepublic" dur: 284
```

The `Walker #57` row is the artist-attribution failure in miniature: the
performing artist is in the title and the channel is a stranger. That entry
escapes both the artist cap and the cooldown today.

**Widening the mix is nearly free, up to a point.**

```
playlistend=25:   25 entries,  25 unique,  1.0s
playlistend=50:   50 entries,  50 unique,  2.6s
playlistend=100: 100 entries,  73 unique,  3.8s
```

Same number of extractions either way, so no additional bot-radar exposure, on
a call memoized for an hour. Fifty is where the curve bends: an `RD` mix holds
roughly 50–75 distinct tracks and then loops.

That last fact is the central tension. A persistent, aggressive exclusion set
runs against a pool that is fundamentally bounded per seed, which is why
Section 5 spends its effort on *reaching new seeds* rather than on remembering
harder.

## 1. Module boundary

A new `songs.py`, following the `hue.py` / `analysis.py` precedent: it never
imports `app.py`, so it is testable without Flask, SSDP or a speaker. It must be
added to the `Containerfile` `COPY` at line 44 — CLAUDE.md's warning applies
exactly here, a forgotten module builds clean and dies at startup.

`songs.py` owns three things:

* `attribute(entry) -> Song` — turns a flat mix entry or resolved metadata into
  an identity.
* `SongMemory` — the "have we played this" index.
* `build_station_queue(...)` — moved out of `app.py` wholesale. It becomes a
  consumer of the other two, and it is the largest pure function in a 3272-line
  file.

`app.py` keeps everything touching the network, the speaker or the scheduler,
including the `_pick_next` ladder. The ladder is policy about *when* to relax,
and it needs `get_radio_mix`.

### The consolidation

Today there are two parallel anti-repeat mechanisms with duplicated plumbing:
`Station.played_ids` / `played_titles` (per-station, never expires) and
`_RECENT` (process-wide, TTL, capped). They differ only in lifetime and
persistence, not in logic. Both become instances of `SongMemory`:

| Instance        | Lifetime                    | Persisted               | Owner              |
|-----------------|-----------------------------|-------------------------|--------------------|
| station-scoped  | dies with the station, no TTL| no                      | `Station`          |
| process-scoped  | 7 days, capped, heard-only  | `CACHE_DIR/history.json`| module global      |

This deletes `_title_key`, `_artist_key`, `_remember`, `_recent_filters`,
`_RECENT`, `played_ids` and `played_titles`, and replaces the four-set juggling
in `_pick_next` with a list of memories to consult. `played_order` and
`artist_history` stay as they are — they feed reseeding and the cooldown, not
deduplication.

### Record shape

A `Song` is `(artist, tokens, duration, rank)` plus `video_id` and the raw title
for logging. `tokens` is a frozenset of normalized song-title words; `rank` is
the version preference from Section 2. A `SongMemory` entry adds `ids` (every
video id seen for this song), `last_at` and `heard`.

### Persistence location

`history.json` in `CACHE_DIR`, written `.part` + atomic rename like everything
else there. It is safe alongside `cache_scan` (`app.py:1368`), which matches on
`.part` / `.tmp` / `.mp3` suffixes only — the same reason `hue.json` survives
there. The path is a constructor argument rather than `hue.py`'s
`set_state_path()` module global, because there are two instances and the
station-scoped one has no file at all.

## 2. `attribute(entry)`: what a song is

Three outputs, computed in a specific order.

### Artist

The key reverses today's precedence: the *name* is primary and `channel_id` is a
last resort. That inversion is the point — the name is what an official upload,
a Topic upload and a third-party re-upload have in common; the id is precisely
what differs between them.

1. Split the title on ` - `, ` – `, ` | `. If there is a separator, one side is
   the artist.
2. Which side: whichever matches the channel name. `"Ed Sheeran - Shape of You"`
   on channel `Ed Sheeran` confirms left; a reversed `"Let Her Go - Passenger"`
   on channel `Passenger` confirms right. If neither matches — `Walker #57`
   uploading `"Ellie Goulding - Love Me Like You Do"` — take the left, the
   dominant convention, which is also the case where the channel is a stranger
   and the title is the only truth.
3. No separator (`"Counting Stars"` on `OneRepublic`, `"Levitating"` on
   `Dua Lipa - Topic`) → the channel name, stripped of `- Topic` and a trailing
   `VEVO`.
4. Normalize: NFKD fold so `Beyoncé` and `Beyonce` agree, casefold, drop
   punctuation, collapse whitespace, drop a leading `the`.
5. Only if all of that yields nothing: `channel_id`.

Known misfire: two unrelated artists sharing a name merge. The blast radius is
one artist cap plus a possible song merge, which is preferable to the id-first
scheme that splits every artist in two.

### Song tokens

From the non-artist side: drop `[...]` and `(...)` runs, drop `ft.` / `feat.`
and everything after, then drop version qualifier *words* — `official, video,
audio, lyric(s), visualizer, hd, 4k, remaster(ed), mv, live, acoustic, remix,
extended, version, edit, sped, slowed, nightcore, cover, hq`. Fold diacritics,
strip punctuation, split, return a frozenset.

Stripping `live` and `remix` is what implements "any version except covers": a
cover survives because its *artist* differs, not because the word was kept. The
hazard is a song actually titled `"Video Games"` or `"Live Forever"` losing a
word. Two guards: never apply a strip that would empty the token set, and
matching is confined to one artist, so a collision requires the same artist to
have two songs differing only by a qualifier word.

### Version rank

Lower is preferred:

```
0  Topic channel upload            (the album master itself)
1  "Official Audio" / "Lyrics" / "Visualizer"
2  unmarked
3  "Official Video" / "Official Music Video" / "MV"
4  live / session / remix / sped up / nightcore / 8D / cover
```

**Ordering constraint, load-bearing:** rank is computed from the *raw* title,
before qualifier stripping. The words deleted to make two uploads match are
exactly the evidence that tells them apart in quality. This degrades silently to
"rank 2 for everything" if the function is reordered later, so it is pinned by a
test rather than a comment.

Rank is used only at the dedupe collapse, never to reorder distinct songs.

### Duration

Carried on the `Song`, never part of the key. A music video and an album cut
legitimately differ by half a minute (`Shape of You` is 264s as a video against
roughly 233s on the record). Section 3 uses it as corroboration only.

## 3. `SongMemory`: matching, lifetime, persistence

### Match order

Cheapest first, for a candidate `Song` against one memory:

1. `video_id` already present → duplicate.
2. Look up the artist bucket. Empty → not a duplicate. This is the O(1) step
   that keeps fuzzy matching at hash speed.
3. Within the bucket: equal token sets → duplicate. One set contains the other
   and the smaller has ≥2 tokens → duplicate, **with no duration requirement**.
   This is what catches `{see, you, again, furious, 7, soundtrack}` ⊃
   `{see, you, again}` across uploads whose durations legitimately differ.
4. Partial overlap ≥ 0.8 of the smaller set → duplicate **only if** durations
   agree within ~5s.
5. Different artist → never compared.

The ≥2-token floor on containment guards against `{intro}` swallowing
`{intro, to, the, record}`; a single-token subset falls through to rule 4 and
must earn it on duration. Worked examples: `{love, story}` ⊂
`{love, story, taylors}` merges, correctly; `{song, part, 1}` against
`{song, part, 2}` overlaps 0.67, below threshold, and stays distinct.

### Heard versus queued

`add(song, heard=False)` at enqueue time; the station loop marks tracks heard as
the cursor passes them. Unheard entries live ~2h — long enough to honour the
documented contract in `refresh_station` (`app.py:1878`) and
`remove_from_station` (`app.py:1934`) that a discarded track "cannot be handed
straight back", short enough that it stops costing a week of budget for a song
nobody heard. Heard entries live 7 days. **Only heard entries are persisted**,
for the same reason.

Deliberate simplification: cursor-passed counts as heard even if the track was
skipped after three seconds. Distinguishing those needs real play-time tracking
and is not worth it here.

### Cap and eviction

`HISTORY_TTL` 7 days, `HISTORY_MAX` 2000 songs. Prune expired first, then evict
by `last_at` ascending, which is the "newest never evicted first" requirement.
`RECENT_MAX` and `RECENT_TTL` are removed rather than aliased.

A week of *continuous* listening is roughly 2500 tracks, so the cap is
deliberately below the TTL's reach: it is a memory backstop, not the intended
limit. Normal use never approaches it, and the listener who does has the
oldest few hundred songs expire early — which is the correct thing to give up.

### Persistence mechanics

`CACHE_DIR/history.json`, `{"version": N, "songs": [...]}`, `.part` + atomic
rename. Missing or corrupt → start empty, log once, never fail startup, matching
the `hue.json` posture.

The `version` field is the key safety property, not boilerplate. `attribute()`
will be tuned, and an index persisted under an old tokenizer is silently wrong
for a week — the worst failure this design can produce. **Changing `attribute`
semantics bumps the version; a version mismatch discards the file.** That
converts a week-long invisible bug into one cold start.

Writes are debounced: a dirty flag flushed at most once a minute from the
station loop, plus on `end_station` and at `atexit`. A crash loses at most a
minute of history.

### Locking

`SongMemory` takes no lock of its own. The process-scoped instance is guarded by
`_STATE_LOCK` exactly as `_RECENT` is today; the station-scoped one by
`Station.lock`. CLAUDE.md documents the order
`Station.lock -> _STATE_LOCK -> _Scheduler._cv`, and a fourth lock here is an
easy way to violate it by accident. The flush snapshots under the lock and
performs its IO outside it.

### Introspection

A `GET /api/history` listing entries and the video ids collapsed into each, plus
an info log whenever a candidate is rejected by *fuzzy* match (not exact id)
naming both titles. Without this, "why did it skip that song" is unanswerable
and the thresholds in rules 3–4 can never be tuned from real behaviour. This is
the mitigation for a sticky bad merge surviving in a seven-day index.

## 4. Queue building, version preference, pool width

### `build_station_queue` stops fetching

Today it calls `get_radio_mix(seed)` inside its loop (`app.py:708`), which is
the real reason it has never been tested: a pure function with a network call in
the middle. The new signature takes already-fetched entries and a list of
memories to consult; `_pick_next` does the fetching.

Pipeline:

1. **Attribute** every entry.
2. **Collapse** duplicates within the pool, keeping the lowest version rank,
   ties broken by mix order so relevance survives. This replaces `seen_ids` /
   `seen_titles`, reusing `SongMemory` as the accumulator so there is one
   matcher rather than two that can drift.
3. **Exclude** anything matching any supplied memory.
4. **Cap** per artist, **cooldown** artists sorted last (stable),
   **round-robin**. Unchanged in spirit from the current implementation.

Step 2 is where "prefer the audio upload" happens: when a mix offers both
`"Dua Lipa - Levitating (Official Video)"` and the Topic upload, they collapse
and the rank-0 entry is queued and downloaded. The station stores whichever id
won, so nothing downstream cares.

### The seed is exempt

When the user hits Play on a video, that is the video they asked for.
`/api/play` must not quietly swap it for an audio upload. Version preference
applies only to tracks the station chose. It also *cannot* apply: the seed is
not a pool, so there is nothing to compare it against without a search.

### Pool width

`get_radio_mix` gains a `MIX_LIMIT` env var defaulting to 50, per the
measurement above.

Two adjacent fixes while the function is open, both visible in the probe:

* It filters on `e.get('id')` but never dedupes ids, and YouTube repeats entries
  past ~75. Step 2 would absorb this, but the cached list should be clean at the
  source.
* `_MIX_CACHE` (`app.py:490`) is written and never pruned — entries are only
  TTL-checked on read, so the dict grows for the life of the process. It gets
  the same expire-then-cap treatment as the history.

Neither is noticeable today; both are cheap now.

## 5. The `_pick_next` ladder

The current ladder relaxes filters as its only escape. The new one widens the
input first, and only the last three rungs weaken anything.

```
1. seeds = [most recent, random from last 8]       full filters
2. + one older seed from played_order              full filters   (new)
3. + one seed from a song seen but never queued    full filters   (new)
4. station memory only (drop the 7-day memory)
5. artist cap lifted, song filter kept                            (the split)
6. re-serve the least-recently-heard song, mark the station exhausted
```

Rung 3 is the one that escapes a saturated neighbourhood. Rungs 1–2 reseed from
tracks already played, which are by definition inside the exhausted region;
seeding from a song the mixes offered and the station never queued steps into a
part of the graph never fetched. Those candidates are already seen and discarded
today, so the cost is a small per-station set of seen-but-unqueued ids.

That set is bounded at a few hundred entries, oldest dropped first, and the seed
is drawn from it **at random** rather than by mix relevance. The same reasoning
as `STATION_PICK_POOL` applies: taking the most relevant unvisited candidate is
deterministic, so two stations that saturate the same neighbourhood would escape
through the identical door.

**The cost must be budgeted.** Each new seed is a synchronous yt-dlp extraction
inside the station loop — about 2.6s at the new limit — and CLAUDE.md is
explicit that this is why `TOPUP_BATCH` and the warm-up ramp exist. So: **at
most one additional mix fetch per tick**, meaning rungs 2 and 3 escalate across
successive ticks rather than firing together. The natural bound helps, since
rungs 2–6 run only when rung 1 came back empty.

Rung 5 splits the artist cap from the song filter, which today drop together
(`app.py:1570`). Rung 6 replaces the old floor entirely.

### Why rung 6 is not the old floor

The current floor rebuilds the queue with the song filter and artist cap both
off, then picks from the top. That ordering is mix relevance, which tracks
popularity, so it repeats a song heard *recently and often* — the worst
available choice, made silently.

Rung 6 re-serves the least-recently-heard song instead. `SongMemory` already
stores `last_at`, so this is a lookup rather than new machinery: the same cost
and the same never-stalls property, but it picks the one repeat least likely to
be noticed. The song filter is never dropped. The only repeat this design can
produce is a deliberate, oldest-first one.

Three mechanics this needs to be unambiguous about:

* **Which upload.** A memory entry holds every `id` seen for the song; the
  re-serve takes the lowest-ranked one, the same preference Section 4 applies at
  the collapse. A song first heard as a music video comes back as the audio cut
  if one was ever seen.
* **It updates `last_at`.** Otherwise the same song is still the
  least-recently-heard on the next tick and rung 6 serves it repeatedly. Going
  through `Station.add` gives this for free, since that is already the single
  point every track passes through.
* **Only heard entries are eligible.** Re-serving a queued-but-unheard song
  would replay something the listener never got to, which is neither a repeat
  nor a new track — just a bug that looks like one.

Reaching rung 6 means the mixes have genuinely run out of new music in this
neighbourhood. The `exhausted` flag already exists on `Station` and is already
computed; it is surfaced in the `/api/station` payload so the UI can say the
station is replaying earlier tracks. That state is invisible today, which is why
a repeat reads as a bug rather than a limit.

**`exhausted` changes meaning, and `_top_up` must change with it.** Today it is
terminal: `_pick_next` returns `None`, `_top_up` logs once and stops extending
(`app.py:1643`). With rung 6 the station always has something to serve, so
`exhausted` becomes purely informational — a flag the UI reads, not a brake on
the refill. `_pick_next` now returns `None` only when `played_order` is empty,
which means the station has no history to work from at all.

Rejected: stopping the refill and letting the queue run dry. It is the strongest
guarantee, but the music stopping looks like a broken app.

### Injection

`_pick_next` takes its mix fetcher as an argument instead of calling
`get_radio_mix` directly, so the ladder is testable without a network. It is the
same injection that makes `build_station_queue` testable.

## 6. Testing

`test_songs.py`, stdlib unittest. CLAUDE.md already names the consequence: a
second test file means the command becomes `python -m unittest discover` and
nothing else changes.

**Fixtures are real.** The probe output is checked in as a JSON fixture. Every
row in it is a case the current code gets wrong, or gets right by accident;
inventing fixtures would test assumptions rather than YouTube's actual output.

Pinned:

* **`attribute`** — artist from title prefix; the channel-name tiebreak
  choosing the correct side; the `Walker #57` case attributing to Ellie
  Goulding; Topic and `VEVO` stripping; diacritic folding; `ft.` truncation.
* **Rank before stripping** — the ordering constraint from Section 2, which
  degrades silently if the function is reordered.
* **The never-empty guard** — `"Video Games"` keeps a token.
* **`SongMemory`** — each of the five match rules, including the two negative
  cases that define the boundary: `{song, part, 1}` against `{song, part, 2}`
  staying distinct, and a cover by a different artist never matching.
  Heard-versus-queued TTLs, oldest-first eviction, the cap.
* **Persistence** — round trip, corrupt file yields empty, **version mismatch
  discards**.
* **`build_station_queue`** — collapse keeps the lowest rank, ties keep mix
  order, artist cap, cooldown ordering, no back-to-back artist.
* **The ladder** — each rung fires in order against a fake fetcher, and rung 6
  re-serves the least-recently-heard song.

**The test that proves the feature** is a simulated 50-track walk over the
captured fixtures with a seeded RNG, asserting no song repeats and no artist
exceeds the cap. Offline, deterministic, and the regression net for every
threshold in Section 3.

## 7. Rollout

### Tunables

Every threshold named loosely above, in one place. All are env-overridable
constants in the style of the existing block at `app.py:396-449`; the matching
thresholds live in `songs.py` as module constants, since they are properties of
the identity model rather than deployment knobs.

| Name                      | Default | Meaning                                                   |
|---------------------------|---------|-----------------------------------------------------------|
| `HISTORY_TTL`             | 7 days  | How long a heard song stays excluded                       |
| `HISTORY_MAX`             | 2000    | Cap on remembered songs; backstop, not the intended limit  |
| `HISTORY_QUEUED_TTL`      | 2h      | How long a queued-but-unheard song stays excluded          |
| `HISTORY_FLUSH_INTERVAL`  | 60s     | Debounce between disk writes                               |
| `MIX_LIMIT`               | 50      | Entries fetched per radio mix                              |
| `MIX_CACHE_MAX`           | 200     | Cap on `_MIX_CACHE`, evicted oldest-first                  |
| `SEEN_UNQUEUED_MAX`       | 300     | Per-station pool of rung-3 seed candidates                 |
| `MATCH_MIN_SUBSET_TOKENS` | 2       | Containment needs a subset this large to skip the duration check |
| `MATCH_OVERLAP`           | 0.8     | Token overlap (of the smaller set) for a partial match     |
| `MATCH_DURATION_TOLERANCE`| 5s      | Duration agreement required to confirm a partial match     |
| `HISTORY_VERSION`         | 1       | Bumped whenever `attribute()` semantics change             |

`MATCH_OVERLAP` and `MATCH_DURATION_TOLERANCE` are the two values most likely to
need tuning from real behaviour, which is what the fuzzy-rejection log line in
Section 3 exists to supply.

### Mechanical changes

* `Containerfile` line 44 gains `songs.py`.
* `RECENT_MAX` / `RECENT_TTL` are removed; `HISTORY_*`, `MIX_LIMIT`,
  `MIX_CACHE_MAX` and `SEEN_UNQUEUED_MAX` are new.
* No state migration: `_RECENT` is in-memory today, so the first run starts with
  an empty history file.
* `API.md` gains `/api/history` and the `exhausted` flag on `/api/station`.
* CLAUDE.md: the cache-layout section gains `history.json`; the test command
  changes; and **"Why the queue used to repeat itself" must be rewritten** — it
  documents the old three-mechanism design in detail and would otherwise become
  actively misleading.
* Frontend: one change, surfacing `exhausted` so a deliberate repeat reads as
  "replaying earlier tracks" rather than a bug. `web/src/lib/queue.ts` with a
  test alongside the existing ones; nothing else in `web/` is affected.
