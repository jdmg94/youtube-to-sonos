# Station selection: a fixed orbit around the seed — design

Status: **approved, not yet implemented**
Branch: `refactor-queue-feed`
Date: 2026-09-19

## Goal

A station either wanders off the seed entirely or collapses onto a handful of
artists. Both complaints are about the same mechanism, and four commits have
now tried to tune it without changing it:

* `_reseed_ids`' random second seed — "the main lever against orbiting one
  artist" (its own docstring)
* `STATION_PICK_POOL`, so two stations from one seed diverge
* `build_station_queue` excluding `cooldown_artists` outright rather than
  demoting them (37cbbcc)
* `ANCHOR_REVISIT_PROB`, reseeding from `played_order[0]` (37cbbcc)

All four shipped against a green suite. This design replaces the mechanism.

## Root cause

**The station is a depth-1 Markov chain over its own frontier.**

`_reseed_ids` (`app.py:690`) takes `played_order[-1]` as its primary seed.
`played_order` is appended by `Station.add`, and `_top_up` (`app.py:1757`)
fills until `len(tracks) - index - 1 >= WINDOW_AHEAD`. The primary seed is
therefore `tracks[index + 8]` — a track the listener has not heard, did not
choose, and may skip. Pick N+1 is seeded by pick N. Nothing in the selection
path references the track the listener actually picked.

Three measurements, all taken against the repository's own fixtures.

### 1. The anchor influences 0.77% of picks

`_pick_next` concatenates `entries = mix(seed1) + mix(seed2)`
(`app.py:1654`). `build_station_queue` walks `entries` in order, so `order`
(artist first-appearance) is dominated by seed-1's artists, and the
round-robin emits seed-2's tracks at the back. `_choose` (`app.py:1541`) reads
only `queue[:STATION_PICK_POOL]` — the top 3.

Sweeping all 132 ordered pairs of the 12 captured mixes:

```
seed-2 reached queue[:3] in 3/132 pairs (2.3%)
first position of seed-2: min=1  median=37  max=47
```

A representative pair puts seed-2's first track at **queue position 42** while
`_choose` samples positions 0–2. With `ANCHOR_REVISIT_PROB = 0.34`, the anchor
affects roughly **0.77%** of picks. The mechanism added to stop drift is
structurally unreachable.

`test_long_walk_can_anchor_to_original_seed` passes because it asserts
`_reseed_ids` *returns* the anchor. It never asserts the anchor is reachable.

### 2. Every ladder rung draws from inside the drift

| Rung | Seed source | Points back at the listener's seed? |
|---|---|---|
| 1 | `played_order[-1]` + (window \| anchor) | anchor only, 0.77% effective |
| 2 | `played_order[:-9]` — the walk | no |
| 3 | `seen_unqueued` — mixes *of* the walk | no |
| 4/5 | same `entries`, filters relaxed | no |
| 6 | `_HISTORY.oldest_heard()` | no |

### 3. The test suite cannot observe drift

`test_station.py`'s `_fetch` maps any uncaptured seed to a hash-chosen
arbitrary mix. Instrumenting the 50-pick walk:

```
fetches: 99   captured: 40   hash-fallback (arbitrary mix): 59 (60%)
```

Sixty percent of the walk runs on a graph whose edges were invented by an MD5
hash. The harness destroys the topology it exists to walk, and no test asserts
any relationship between a pick and the seed. This is why four fixes shipped
green.

### How one cause produces two symptoms

* **"Too random"** — an unbiased random walk on YouTube's RD graph. After
  ~20 hops the station is in a different genre and nothing restores it.
* **"One artist's discography"** — the frontier lands in an artist-dense
  cluster, `cooldown_artists` excludes all of its artists, rung 1 returns
  empty, rungs 2 and 3 reseed from *inside the same cluster*, and rung 5 lifts
  the artist cap and drops the cooldown — re-serving exactly the artists the
  cooldown was holding back. The escape hatch feeds the trap.

Which symptom a session shows is a property of local graph density, not of
configuration. That is why tuning constants has not helped.

## What a station is

Settled with the user before design:

* **Fixed orbit.** A station is permanently "songs like the track I picked".
  The seed is the centre and never moves. The walk never becomes the seed.
* **Bounded growth.** When the seed's own mix is exhausted, expand to radius 2
  — the mix of a track drawn from *the seed's mix* — and stop there. Distance
  from the seed is bounded by construction, not by a heuristic.
* **Repeat rather than drift.** When radius 2 is exhausted, relax the filters
  and finally re-serve the least-recently-heard song. A station that loops is
  a better failure than a station that wanders.
* **Skips do not steer.** Selection stops reading playback position entirely.
  A listener-steered model (heard-through as positive signal) is a separate,
  deliberate feature, not a side effect of this one.

## Design

### The anchor

`Station` gains one immutable field. `start_station` (`app.py:1978`) already
has `seed_meta` in scope:

```python
self.anchor = seed_meta['video_id']   # never reassigned
self.expanded = OrderedDict()         # radius-1 ids whose mixes we pulled in
```

`station.expanded` accumulates for the life of the station. It replaces
`station.widen`, which was a rung counter that reset to 0 whenever rung 1
succeeded — so a station in a lean patch kept re-deriving the same widening
from scratch.

### The orbit

`_reseed_ids` is deleted and replaced by a function that never reads
`played_order`:

* **Radius 1** — `get_radio_mix(station.anchor)`. Memoised for `MIX_CACHE_TTL`
  (1h), so a pick in steady state costs **zero** yt-dlp round trips, down from
  two today. That removes the synchronous-resolve pressure inside the station
  loop that `_prefetch_target`'s warmup ramp exists to work around.
* **Radius 2** — only when radius 1 is dry: `get_radio_mix(x)` where `x` is
  drawn at random from radius 1's own ids, minus `station.expanded`.

**The invariant, and the whole point: every candidate is within two hops of
the anchor in YouTube's mix graph, by construction.** No code path can produce
a radius-3 candidate, because nothing is ever seeded by something we played.

Deleted with `_reseed_ids`: `_widen_seed`, `_record_unqueued`,
`station.seen_unqueued`, `station.widen`, `SEEN_UNQUEUED_MAX`,
`ANCHOR_REVISIT_PROB`. `seen_unqueued` in particular becomes meaningless — in
a fixed orbit a song a mix offered but we passed over is *already in*
`entries`, so it needs no separate pool.

### The ladder

Every rung is anchored. At most one synchronous mix fetch per call, preserving
the existing constraint on work done inside the station loop.

| # | Pool | Memories | Cooldown | Cap | Extra fetch |
|---|---|---|---|---|---|
| 1 | radius 1 | station + `_HISTORY` | yes | `MAX_TRACKS_PER_ARTIST` | none |
| 2 | radius 1 + one new radius-2 expansion | station + `_HISTORY` | yes | `MAX_TRACKS_PER_ARTIST` | one |
| 3 | same entries | station only | yes | `MAX_TRACKS_PER_ARTIST` | none |
| 4 | same entries | station only | no | lifted | none |
| 5 | `_reserve_oldest` | — | — | — | none |

Old rungs 2 and 3 are gone; they were the chain. Rungs 3–5 here are the old
4–6 renumbered.

The `entries = radius1 + radius2` concatenation is now **correct** rather than
a latent bug. Measurement 1 mattered because the anchor was seed-2 and
therefore unreachable; with the anchor as seed-1 the same ordering puts it
exactly where `_choose` samples, and radius-2 material becomes reachable
precisely when radius 1 has been filtered out — which is when we want it.

### The randomness budget

Today randomness compounds. `_choose` picks at random, that pick becomes the
next seed, and variance accumulates into drift. That is why
`STATION_PICK_POOL` had to stay at 3 — and a pool of 3 is why sessions felt
narrow until they drifted, then arbitrary.

With the chain removed, **a random pick has no effect on the next candidate
pool at all.** Sampling is i.i.d. from a fixed, on-seed set. So the pool
widens: `STATION_PICK_POOL` 3 → 8. More session-to-session variety, zero added
drift.

"Too random" and "too narrow" were the same dial. After this they are not:
radius bounds how far the station can stray, and `STATION_PICK_POOL` controls
variety within that radius, independently.

### Simplifications that fall out

`refresh_station` re-orders `played_order` so its tail is what survived
(`app.py:2135-2138`). Its stated reason is that the tail is
`_reseed_ids`' primary seed, and a refill built from a track the listener just
discarded would be wrong. With a fixed anchor that reason is gone; delete the
block.

`_pick_next`'s `if not station.played_order: return None` guard becomes
`if not station.anchor`.

### Out of scope

Unchanged: `songs.py` (song identity, the five match rules,
`build_station_queue` itself), `_HISTORY` and its persistence, the download
scheduler and priorities, `_flush_queue` / `_evict` / `_reprioritize`, all
locking (`Station.lock -> _STATE_LOCK -> _Scheduler._cv`),
`remove_from_station` and `_discard_tracks`.

The frontend reads only `exhausted` (`web/src/lib/api/types.ts:192`,
`web/src/lib/queue.ts:353`) and needs no change. `station_payload` keeps its
shape.

## Verification

The corpus is the deliverable that makes the rest testable. Without ground
truth for "how far is this track from the seed", orbit distance cannot be
asserted at all — which is the state four previous fixes shipped in.

### Corpus

A capture script writes `testdata/orbit/<seed>/`: the anchor's RD mix plus the
RD mix of every track in it (~51 fetches per seed). Entries are trimmed to
`id`, `title`, `uploader`, `channel_id`, `duration` — the fields `attribute()`
and `build_station_queue` actually read.

Two seeds: one deliberately inside a dense, mutually-reinforcing cluster (to
reproduce the discography symptom), one with a broad mix.

### `test_orbit.py`

**The fixture fetcher raises rather than falling back.** Today's hash fallback
serves an arbitrary mix for an uncaptured seed, which is how 60% of the
existing walk runs on invented edges. A raise means "the walk asked for a mix
outside the captured orbit" — i.e. it left radius 2 — fails the suite with no
assertion required.

Assertions the corpus makes possible, none of which the current suite can
express. Each is a 50-pick walk:

1. **Radius bound.** Every pick is within radius 2 of the anchor, checked
   against corpus ground truth. This one is absolute — a violation is a
   correctness bug, not a quality regression.
2. **Seed fidelity.** At least 50% of picks come from the anchor's own mix
   (radius 1). Chosen because radius 1 holds ~50 entries against 50 picks, so
   a healthy orbit exhausts radius 1 roughly when the walk ends; a majority
   from radius 1 means the orbit is being spent before it is widened.
3. **Artist concentration.** No artist accounts for more than 12% of picks
   (6 of 50). `MAX_TRACKS_PER_ARTIST` is 2 per build and `ARTIST_COOLDOWN` is
   4, so a well-behaved walk sits far below this; 12% is the level at which a
   listener starts hearing a discography.
4. **Trap resistance.** For the seed captured inside a dense cluster, the
   cluster's share of picks must not exceed twice its share of the orbit's
   distinct songs. A ratio rather than an absolute, because a cluster that is
   genuinely half the orbit *should* be half the picks — being captured means
   over-representation relative to availability.

The three quality thresholds (2–4) are calibrated in step 2 of the sequence:
they are measured against the *current* `app.py` first, and each must fail
there. A threshold the existing code already satisfies is not measuring the
defect, and pinning one would repeat the mistake that let four fixes ship
green.

Calibrating 2–4 against the current code needs a second fetcher, because the
raising one stops the walk at the first out-of-orbit seed — which is assertion
1 failing, and is expected. The calibration fetcher returns `[]` for an
uncaptured seed and records it, so the current code's walk runs to 50 picks
and its concentration and fidelity can be measured. It exists only for
calibration and is not what the committed tests use.

### Regression for the measured defect

A track from a non-primary pool must be reachable by `_choose`, asserted on
**queue position** rather than on what the seeding function returns. This is
the assertion whose absence let a 0.77%-effective anchor pass as a fix.

### Expected fallout, to confirm rather than assume

* `test_diverges_without_the_seed` requires <25% same-position agreement
  between two walks. A fixed orbit makes walks more similar by design; the
  widened `STATION_PICK_POOL` is what should keep it green. If it does not,
  revisit the threshold — not the model.
* Replaying a seed within `HISTORY_TTL` (7d) starts with most of radius 1
  already excluded by `_HISTORY`, so the station jumps to radius 2 almost
  immediately. This is believed acceptable and should be measured once the
  corpus exists.

## Sequence

1. Capture script and corpus (network, run once)
2. `test_orbit.py` against current `app.py` — **must fail**, confirming it
   reproduces what four green suites missed
3. Anchor, orbit, ladder rewrite; delete the chain
4. `STATION_PICK_POOL` 3 → 8
5. `.venv/bin/python -m unittest discover -v`
6. Documentation: `CLAUDE.md` (Station state, the dedupe ladder), `README.md`
   env table, `docker-compose.yml` env stanza
