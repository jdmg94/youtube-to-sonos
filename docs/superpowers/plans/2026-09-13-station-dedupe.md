# Station Deduplication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the title-string deduplication in `app.py` with an artist-bucketed song identity model in a new, fully tested `songs.py`, add a persistent seven-day listening history, and widen the candidate pool so the station stops repeating itself.

**Architecture:** A new `songs.py` (following the `hue.py` / `analysis.py` precedent — it never imports `app.py`) owns three things: `attribute(entry) -> Song` turns a flat mix entry into `(artist, tokens, duration, rank)`; `SongMemory` is an artist-bucketed fuzzy index that replaces both `Station.played_ids`/`played_titles` and the process-wide `_RECENT`; `build_station_queue` moves out of `app.py` and stops fetching, taking already-fetched entries and a list of memories to consult. `app.py` keeps the network, the speaker, the scheduler, and the `_pick_next` ladder — which grows from three rungs to six, widening the seed pool before weakening any filter, and ending in a deliberate oldest-first repeat rather than a stall.

**Tech Stack:** Python 3.12 (forced by `python-mbedtls`/librosa — see CLAUDE.md), stdlib `unittest`, `yt-dlp`, Flask, SoCo. Frontend: Next.js / TypeScript, `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-13-station-dedupe-design.md`

## Global Constraints

- **`songs.py` must never import `app.py`.** Paths and policy are passed in. This is what keeps it testable without Flask, SSDP or a speaker.
- **`songs.py` must be added to the `Containerfile` `COPY` at line 44.** It is not a package: a forgotten module builds clean and dies at startup.
- **Lock order is `Station.lock -> _STATE_LOCK -> _Scheduler._cv`.** `SongMemory` takes no lock of its own. The process-scoped instance is guarded by `_STATE_LOCK`; the station-scoped one by `Station.lock`. Disk IO happens outside the lock, on a snapshot.
- **Version rank is computed from the raw title, before qualifier stripping.** The words deleted to make two uploads match are exactly the evidence that tells them apart in quality. This degrades silently to "rank 2 for everything" if reordered.
- **`HISTORY_VERSION` is bumped whenever `attribute()` semantics change.** An index persisted under an old tokenizer is silently wrong for a week — the worst failure this design can produce. A version mismatch discards the file.
- **Matching thresholds live in `songs.py` as module constants** (properties of the identity model). Deployment knobs live in `app.py` as `os.environ.get` constants in the style of the block at `app.py:396-449`.
- **Only heard entries are persisted.** Queued-but-unheard entries expire in ~2h and never reach disk.
- **At most one additional mix fetch per `_pick_next` call.** Each new seed is a synchronous yt-dlp extraction inside the station loop (~2.6s), which is why `TOPUP_BATCH` and the warm-up ramp exist.

### Tunables (exact defaults)

| Name | Default | Home |
|---|---|---|
| `HISTORY_TTL` | `7 * 24 * 3600` | `app.py`, env-overridable |
| `HISTORY_QUEUED_TTL` | `2 * 3600` | `app.py`, env-overridable |
| `HISTORY_MAX` | `2000` | `app.py`, env-overridable |
| `HISTORY_FLUSH_INTERVAL` | `60` | `app.py`, env-overridable |
| `MIX_LIMIT` | `50` | `app.py`, env-overridable |
| `MIX_CACHE_MAX` | `200` | `app.py`, env-overridable |
| `SEEN_UNQUEUED_MAX` | `300` | `app.py`, env-overridable |
| `MATCH_MIN_SUBSET_TOKENS` | `2` | `songs.py`, module constant |
| `MATCH_OVERLAP` | `0.8` | `songs.py`, module constant |
| `MATCH_DURATION_TOLERANCE` | `5.0` | `songs.py`, module constant |
| `HISTORY_VERSION` | `1` | `songs.py`, module constant |

`RECENT_MAX` and `RECENT_TTL` are **removed**, not aliased.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `songs.py` | `attribute()`, `Song`, `Entry`, `Hit`, `SongMemory`, `build_station_queue`, `load_history`/`save_history`. No Flask, no network, no `app.py` import. |
| `test_songs.py` | Every test for `songs.py`, stdlib `unittest`. Root-level, matching `test_hue.py`. |
| `testdata/mix_probe.json` | Real flat-extraction entries captured from YouTube. The attribution tests run on these. |
| `testdata/mix_synthetic.json` | Labelled constructed entries for boundary cases the probe did not happen to produce (Topic upload, diacritics, `"Video Games"`). |
| `testdata/mix_walk/*.json` | Real mixes keyed by seed id, for the 50-track walk simulation. |

**Modified:**

| Path | Change |
|---|---|
| `app.py:396-417` | Tunables block: drop `RECENT_MAX`/`RECENT_TTL`, add `HISTORY_*`, `SEEN_UNQUEUED_MAX`. |
| `app.py:471` | Add `MIX_LIMIT`, `MIX_CACHE_MAX` beside `MIX_CACHE_TTL`. |
| `app.py:485-491` | Drop `_RECENT`, add `_HISTORY`. |
| `app.py:576-607` | `get_radio_mix`: `limit=MIX_LIMIT`, dedupe ids, prune `_MIX_CACHE`. |
| `app.py:609-731` | Delete `_artist_key`, `_title_key`, `_remember`, `_recent_filters`, `build_station_queue`. |
| `app.py:1494-1543` | `Station`: `memory`, `seen_unqueued`, `widen` replace `played_ids`/`played_titles`. |
| `app.py:1546-1580` | `_pick_next`: six-rung ladder, injected fetcher. |
| `app.py:1629-1661` | `_top_up`: `exhausted` stops being a brake. |
| `app.py:1732-1780` | `_station_loop`: mark heard, flush history. |
| `app.py:1808-1835` | `end_station`: force a history flush. |
| `app.py:~2556` | New `/api/history` endpoint beside `/api/downloads`. |
| `app.py:3268-3272` | Load history at startup, register `atexit` flush. |
| `Containerfile:44` | `COPY app.py hue.py analysis.py songs.py .` |
| `API.md` | `/api/history`; `exhausted` gains its new meaning. |
| `CLAUDE.md` | Cache layout, test command, rewrite "Why the queue used to repeat itself". |
| `web/src/lib/queue.ts` | `describeExhausted()`. |
| `web/src/lib/queue.test.ts` | Tests for it. |
| `web/src/components/queue-panel.tsx` | Render it. |

---

## Task 1: `songs.py` — `attribute()` and the fixtures

**Files:**
- Create: `songs.py`
- Create: `test_songs.py`
- Create: `testdata/mix_probe.json`
- Create: `testdata/mix_synthetic.json`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `Song` — frozen dataclass with fields `video_id: str`, `artist: str`, `tokens: frozenset[str]`, `duration: float | None`, `rank: int`, `title: str`.
  - `attribute(entry: dict) -> Song`. `entry` is a flat yt-dlp mix entry (`id`, `title`, `uploader`/`channel`, `channel_id`, `duration`) or resolved metadata (`video_id` instead of `id`).
  - `version_rank(title: str | None, channel: str | None) -> int` — 0..4, lower preferred.
  - `MATCH_MIN_SUBSET_TOKENS = 2`, `MATCH_OVERLAP = 0.8`, `MATCH_DURATION_TOLERANCE = 5.0`, `HISTORY_VERSION = 1`.

- [ ] **Step 1: Capture the real mix probe**

The attribution tests must run on YouTube's actual output, not on assumptions. Run this from the repo root with the project venv (`make run-local` creates it if absent):

```bash
mkdir -p testdata
.venv/bin/python - <<'PY'
import json, yt_dlp
SEEDS = ["JGwWNGJdvx8", "kJQP7kiw5Fk", "RgKAFK5djSk"]  # Shape of You, Despacito, See You Again
rows = []
for seed in SEEDS:
    url = f"https://www.youtube.com/watch?v={seed}&list=RD{seed}"
    with yt_dlp.YoutubeDL({"quiet": True, "extract_flat": True, "playlistend": 50}) as y:
        info = y.extract_info(url, download=False)
    for e in info.get("entries") or []:
        if not e.get("id"):
            continue
        rows.append({k: e.get(k) for k in
                     ("id", "title", "uploader", "channel", "channel_id", "duration")})
seen, out = set(), []
for r in rows:
    if r["id"] not in seen:
        seen.add(r["id"])
        out.append(r)
json.dump(out, open("testdata/mix_probe.json", "w"), indent=1)
print(len(out), "entries")
PY
```

If YouTube is unreachable, write `testdata/mix_probe.json` with exactly these five rows, which were captured during design and are recorded verbatim in the spec's "Measurements" section. The tests below name these five rows specifically, so they must be present either way:

```json
[
 {"id": "JGwWNGJdvx8", "title": "Ed Sheeran - Shape of You (Official Music Video)",
  "uploader": "Ed Sheeran", "channel": "Ed Sheeran",
  "channel_id": "UC0C-w0YjGpqDXGB8IHb662A", "duration": 264},
 {"id": "AJtDXIazrMo", "title": "Ellie Goulding - Love Me Like You Do Lyrics (from Fifty Shades of Grey)",
  "uploader": "Walker #57", "channel": "Walker #57",
  "channel_id": "UCK7lNBg2nUHNYF3GpNSkJEA", "duration": 273},
 {"id": "RgKAFK5djSk", "title": "Wiz Khalifa - See You Again ft. Charlie Puth [Official Video] Furious 7 Soundtrack",
  "uploader": "Wiz Khalifa", "channel": "Wiz Khalifa",
  "channel_id": "UCLUcYcbQpLuI9jCyaKdGm0w", "duration": 238},
 {"id": "RBumgq5yVrA", "title": "Passenger | Let Her Go (Official Video)",
  "uploader": "Passenger", "channel": "Passenger",
  "channel_id": "UCF-8Qw2vwQJqSFhxLaAaKQg", "duration": 255},
 {"id": "hT_nvWreIhg", "title": "Counting Stars",
  "uploader": "OneRepublic", "channel": "OneRepublic",
  "channel_id": "UCL3T9eUhqtHl5vcexKBjcvw", "duration": 284}
]
```

- [ ] **Step 2: Write the synthetic fixture**

The probe returns official uploads for popular songs, so it does not contain a Topic upload, a diacritic, or a title made of qualifier words. These are constructed, and the file name says so — the spec's "fixtures are real" rule applies to attribution behaviour on YouTube's output, which Step 1 covers.

Write `testdata/mix_synthetic.json`:

```json
[
 {"_why": "Topic channel: bare song title, artist only on the channel. Rank 0.",
  "id": "syn_topic", "title": "Levitating", "uploader": "Dua Lipa - Topic",
  "channel": "Dua Lipa - Topic", "channel_id": "UCtopic001", "duration": 203},
 {"_why": "Official video of the same song. Must attribute to the same artist, rank 3.",
  "id": "syn_video", "title": "Dua Lipa - Levitating (Official Music Video)",
  "uploader": "Dua Lipa", "channel": "Dua Lipa", "channel_id": "UCdualipa", "duration": 217},
 {"_why": "VEVO suffix on the channel; no separator in the title.",
  "id": "syn_vevo", "title": "Halo", "uploader": "BeyonceVEVO",
  "channel": "BeyonceVEVO", "channel_id": "UCvevo001", "duration": 261},
 {"_why": "Same artist, diacritic. Must fold to the same artist key as syn_vevo.",
  "id": "syn_accent", "title": "Beyonc\u00e9 - Irreplaceable", "uploader": "Beyonc\u00e9",
  "channel": "Beyonc\u00e9", "channel_id": "UCaccent001", "duration": 227},
 {"_why": "Reversed title order, confirmed by the channel name.",
  "id": "syn_reversed", "title": "Let Her Go - Passenger", "uploader": "Passenger",
  "channel": "Passenger", "channel_id": "UCF-8Qw2vwQJqSFhxLaAaKQg", "duration": 255},
 {"_why": "Every word is a qualifier except one: the never-empty guard.",
  "id": "syn_videogames", "title": "Lana Del Rey - Video Games",
  "uploader": "Lana Del Rey", "channel": "Lana Del Rey", "channel_id": "UCldr", "duration": 282},
 {"_why": "Live cut of a song: rank 4, and the qualifier is stripped from the tokens.",
  "id": "syn_live", "title": "Lana Del Rey - Video Games (Live at Glastonbury)",
  "uploader": "Lana Del Rey", "channel": "Lana Del Rey", "channel_id": "UCldr", "duration": 299},
 {"_why": "A cover by a different artist. Must never merge with syn_videogames.",
  "id": "syn_cover", "title": "Video Games (Lana Del Rey Cover)",
  "uploader": "Boyce Avenue", "channel": "Boyce Avenue", "channel_id": "UCboyce", "duration": 280}
]
```

- [ ] **Step 3: Write the failing tests**

Create `test_songs.py`:

```python
"""Tests for songs.py — the station's song-identity model.

Every failure this file guards is silent. A song whose artist is misattributed
escapes the cap and the cooldown without anything logging; a rank computed
after qualifier stripping is `2` for every upload, so the "prefer the audio
cut" feature simply stops happening and nothing says so.

Attribution runs on `testdata/mix_probe.json`, which is real yt-dlp output —
inventing those rows would test our assumptions about YouTube rather than
YouTube. `mix_synthetic.json` holds the labelled constructions for the few
shapes the probe did not happen to return.
"""
import json
import os
import unittest

import songs

HERE = os.path.dirname(os.path.abspath(__file__))


def load(name):
    with open(os.path.join(HERE, 'testdata', name)) as fh:
        return {e['id']: e for e in json.load(fh)}


PROBE = load('mix_probe.json')
SYN = load('mix_synthetic.json')


class TestArtist(unittest.TestCase):
    def test_title_prefix_wins_when_the_channel_confirms_it(self):
        song = songs.attribute(PROBE['JGwWNGJdvx8'])
        self.assertEqual(song.artist, 'ed sheeran')
        self.assertEqual(song.tokens, frozenset({'shape', 'of', 'you'}))

    def test_reversed_order_is_read_from_the_channel_name(self):
        # "Let Her Go - Passenger" on channel Passenger. Taking the left side
        # blindly would file the song under an artist called "let her go".
        song = songs.attribute(SYN['syn_reversed'])
        self.assertEqual(song.artist, 'passenger')
        self.assertEqual(song.tokens, frozenset({'let', 'her', 'go'}))

    def test_a_stranger_reuploading_is_attributed_to_the_performer(self):
        # `Walker #57` uploading Ellie Goulding. Today's channel_id-first key
        # files this under Walker #57, so it escapes the cap entirely.
        song = songs.attribute(PROBE['AJtDXIazrMo'])
        self.assertEqual(song.artist, 'ellie goulding')

    def test_no_separator_falls_back_to_the_channel(self):
        song = songs.attribute(PROBE['hT_nvWreIhg'])
        self.assertEqual(song.artist, 'onerepublic')
        self.assertEqual(song.tokens, frozenset({'counting', 'stars'}))

    def test_topic_suffix_is_stripped(self):
        self.assertEqual(songs.attribute(SYN['syn_topic']).artist, 'dua lipa')

    def test_vevo_suffix_is_stripped(self):
        self.assertEqual(songs.attribute(SYN['syn_vevo']).artist, 'beyonce')

    def test_diacritics_fold_onto_the_same_artist(self):
        # The whole point of folding: BeyoncéVEVO and Beyoncé must be one
        # artist, or the cap of 2 behaves like a cap of 4.
        self.assertEqual(songs.attribute(SYN['syn_accent']).artist,
                         songs.attribute(SYN['syn_vevo']).artist)

    def test_the_topic_upload_and_the_official_video_agree(self):
        # Defect 1 from the spec, stated directly.
        self.assertEqual(songs.attribute(SYN['syn_topic']).artist,
                         songs.attribute(SYN['syn_video']).artist)
        self.assertEqual(songs.attribute(SYN['syn_topic']).tokens,
                         songs.attribute(SYN['syn_video']).tokens)

    def test_falls_back_to_the_channel_id_when_there_is_no_name(self):
        song = songs.attribute({'id': 'x', 'title': '', 'channel_id': 'UCzzz'})
        self.assertEqual(song.artist, 'UCzzz')


class TestTokens(unittest.TestCase):
    def test_featured_artists_are_dropped(self):
        # "Wiz Khalifa - See You Again ft. Charlie Puth [Official Video] ..."
        song = songs.attribute(PROBE['RgKAFK5djSk'])
        self.assertEqual(song.artist, 'wiz khalifa')
        self.assertEqual(song.tokens, frozenset({'see', 'you', 'again'}))

    def test_bracketed_runs_are_dropped(self):
        self.assertEqual(songs.attribute(PROBE['RBumgq5yVrA']).tokens,
                         frozenset({'let', 'her', 'go'}))

    def test_version_qualifiers_are_stripped_so_cuts_agree(self):
        # This is "any version except covers": the word `live` is deleted, so
        # the live cut and the studio cut have identical tokens. A cover
        # survives because its *artist* differs, not because a word was kept.
        self.assertEqual(songs.attribute(SYN['syn_live']).tokens,
                         songs.attribute(SYN['syn_videogames']).tokens)

    def test_a_title_made_of_qualifiers_keeps_its_words(self):
        # "Video Games" — `video` is a qualifier. Stripping to nothing would
        # make the song match every other empty-token song by the same artist.
        self.assertTrue(songs.attribute(SYN['syn_videogames']).tokens)

    def test_accepts_resolved_metadata_keyed_video_id(self):
        # Station.add is handed either shape.
        song = songs.attribute({'video_id': 'abc', 'title': 'Ed Sheeran - Perfect',
                                'uploader': 'Ed Sheeran', 'duration': 263})
        self.assertEqual(song.video_id, 'abc')
        self.assertEqual(song.artist, 'ed sheeran')


class TestRank(unittest.TestCase):
    def test_the_scale(self):
        self.assertEqual(songs.version_rank('Levitating', 'Dua Lipa - Topic'), 0)
        self.assertEqual(songs.version_rank('Dua Lipa - Levitating (Official Audio)', 'Dua Lipa'), 1)
        self.assertEqual(songs.version_rank('Dua Lipa - Levitating (Lyrics)', 'Dua Lipa'), 1)
        self.assertEqual(songs.version_rank('Dua Lipa - Levitating', 'Dua Lipa'), 2)
        self.assertEqual(songs.version_rank('Dua Lipa - Levitating (Official Music Video)', 'Dua Lipa'), 3)
        self.assertEqual(songs.version_rank('Dua Lipa - Levitating (Live at the O2)', 'Dua Lipa'), 4)
        self.assertEqual(songs.version_rank('Dua Lipa - Levitating (Sped Up)', 'Dua Lipa'), 4)

    def test_an_alternate_cut_outranks_its_own_video_marking(self):
        # "Live (Official Video)" is a live cut that happens to be a video.
        # Checking the video pattern first would call it rank 3 and let it win
        # a collapse against the studio audio.
        self.assertEqual(
            songs.version_rank('Artist - Song (Live) [Official Video]', 'Artist'), 4)

    def test_rank_is_computed_before_qualifier_stripping(self):
        # The ordering constraint from the spec, pinned because it degrades
        # silently: the words deleted to make two uploads match are exactly
        # the evidence that tells them apart in quality. Reorder the function
        # and every rank becomes 2, with nothing failing except this.
        video = songs.attribute(SYN['syn_video'])
        topic = songs.attribute(SYN['syn_topic'])
        self.assertEqual(video.tokens, topic.tokens, 'precondition: they match')
        self.assertGreater(video.rank, topic.rank)

    def test_the_seed_probe_rows_rank_as_expected(self):
        self.assertEqual(songs.attribute(PROBE['JGwWNGJdvx8']).rank, 3)
        self.assertEqual(songs.attribute(PROBE['hT_nvWreIhg']).rank, 2)


class TestDuration(unittest.TestCase):
    def test_duration_is_carried_but_not_part_of_the_key(self):
        # A music video and an album cut legitimately differ by half a minute.
        video = songs.attribute(SYN['syn_video'])
        topic = songs.attribute(SYN['syn_topic'])
        self.assertEqual(video.duration, 217)
        self.assertEqual(topic.duration, 203)
        self.assertEqual(video.tokens, topic.tokens)

    def test_a_missing_duration_is_none_rather_than_zero(self):
        # Zero would read as "agrees with nothing" in one place and "agrees
        # with a zero-length track" in another.
        self.assertIsNone(songs.attribute({'id': 'x', 'title': 'A - B'}).duration)


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `.venv/bin/python -m unittest test_songs -v`
Expected: `ModuleNotFoundError: No module named 'songs'`

- [ ] **Step 5: Write `songs.py`**

```python
"""Song identity for the autoplay station.

Deliberately free of Flask, SoCo, yt-dlp and `app.py`, for the same reason
`hue.py` and `analysis.py` are: everything here is a pure decision about what
counts as the same song, and those decisions are only checkable if they can be
run without a speaker on the network.

The central claim is that a song is `(artist, tokens)` and that fuzzy matching
is confined to one artist. That is not a performance compromise that happens to
be safe — it is the policy stated directly. "Any version except covers" and
"only compare within an artist" are the same sentence: a live cut matches
because the qualifier word is stripped, and a cover does not because its artist
differs.
"""
import json
import logging
import os
import re
import time
import unicodedata
from collections import namedtuple
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

# --- Matching thresholds -----------------------------------------------------
# Properties of the identity model rather than deployment knobs, so they are
# module constants here instead of env vars in app.py. MATCH_OVERLAP and
# MATCH_DURATION_TOLERANCE are the two most likely to need tuning from real
# behaviour, which is what the fuzzy-rejection log line exists to supply.
MATCH_MIN_SUBSET_TOKENS = 2
MATCH_OVERLAP = 0.8
MATCH_DURATION_TOLERANCE = 5.0

# Bumped whenever `attribute` semantics change. An index persisted under an old
# tokenizer is silently wrong for a week; a version mismatch discards the file
# and converts that into one cold start.
HISTORY_VERSION = 1

# --- Normalization -----------------------------------------------------------

_SEPARATORS = re.compile(r'\s+[-–—|]\s+')
_BRACKETS = re.compile(r'\[[^\]]*\]|\([^)]*\)')
_FEAT = re.compile(r'\b(?:ft|feat|featuring)\.?\s.*$', re.IGNORECASE)
_TOPIC = re.compile(r'\s*[-–]\s*topic\s*$', re.IGNORECASE)
_VEVO = re.compile(r'\s*vevo\s*$', re.IGNORECASE)
_LEADING_THE = re.compile(r'^the\s+')

# Version qualifier *words*, dropped from the song tokens so two uploads of one
# song agree. `live` and `remix` are in here on purpose: that is what makes a
# live cut a duplicate. The risk — a song actually called "Video Games" — is
# held by two guards: never empty the token set, and never compare across
# artists.
_QUALIFIERS = frozenset({
    'official', 'video', 'audio', 'lyric', 'lyrics', 'visualizer', 'visualiser',
    'hd', 'hq', '4k', 'remaster', 'remastered', 'mv', 'live', 'acoustic',
    'remix', 'extended', 'version', 'edit', 'sped', 'slowed', 'nightcore',
    'cover', 'music',
})

# Rank patterns, checked in this order. ALT first: "Song (Live) [Official
# Video]" is a live cut that happens to be a video, and calling it rank 3 would
# let it beat the studio audio at a collapse.
_RANK_ALT = re.compile(
    r'\b(live|session|sessions|remix|sped\s*up|slowed|nightcore|8d|cover|'
    r'acoustic|karaoke|instrumental)\b', re.IGNORECASE)
_RANK_VIDEO = re.compile(
    r'\b(official\s+(music\s+)?video|music\s+video|mv)\b', re.IGNORECASE)
_RANK_AUDIO = re.compile(
    r'\b(official\s+audio|audio|lyrics?|visuali[sz]er)\b', re.IGNORECASE)


def _fold(text):
    """Casefold, strip diacritics and punctuation, collapse whitespace.

    NFKD then dropping combining marks is what makes `Beyoncé` and `Beyonce`
    one artist. Without it the cap of two behaves like a cap of four.
    """
    t = unicodedata.normalize('NFKD', text or '')
    t = ''.join(c for c in t if not unicodedata.combining(c))
    t = t.casefold()
    t = re.sub(r'[^\w\s]', ' ', t)
    return re.sub(r'\s+', ' ', t).strip()


def _channel_name(entry):
    raw = (entry.get('uploader') or entry.get('channel') or '').strip()
    raw = _TOPIC.sub('', raw)
    raw = _VEVO.sub('', raw)
    return _LEADING_THE.sub('', _fold(raw))


def version_rank(title, channel):
    """Version preference, lower is better. Computed from the *raw* title.

        0  Topic channel upload (the album master itself)
        1  Official Audio / Lyrics / Visualizer
        2  unmarked
        3  Official Video / Music Video / MV
        4  live / session / remix / sped up / nightcore / 8D / cover

    Load-bearing ordering: this runs before `_song_tokens` strips qualifier
    words, because those words are the only evidence of which upload is which.
    Reordering it makes every rank 2 and silently disables "prefer the audio
    cut" — `test_rank_is_computed_before_qualifier_stripping` is the guard.
    """
    if _TOPIC.search((channel or '').strip()):
        return 0
    t = title or ''
    if _RANK_ALT.search(t):
        return 4
    if _RANK_VIDEO.search(t):
        return 3
    if _RANK_AUDIO.search(t):
        return 1
    return 2


def _split_title(title, channel_folded):
    """(artist, song-side) from a title, using the channel name as the tiebreak.

    The key reverses the old precedence: the *name* is primary and `channel_id`
    is a last resort. That inversion is the point — the name is what an official
    upload, a Topic upload and a third-party re-upload have in common; the id is
    precisely what differs between them.
    """
    parts = _SEPARATORS.split(title or '', maxsplit=1)
    if len(parts) == 2:
        left, right = parts
        # "Let Her Go - Passenger" on channel Passenger: the artist is on the
        # right. Only the channel can tell us that.
        if channel_folded and _fold(right) == channel_folded:
            return channel_folded, left
        # Otherwise the left side. This is both the dominant convention and the
        # `Walker #57` case, where the channel is a stranger and the title is
        # the only truth we have.
        return _LEADING_THE.sub('', _fold(left)), right
    return channel_folded, title or ''


def _song_tokens(song_side):
    """Normalized words of the song title, qualifiers removed."""
    t = _BRACKETS.sub(' ', song_side or '')
    t = _FEAT.sub(' ', t)
    words = _fold(t).split()
    kept = [w for w in words if w not in _QUALIFIERS]
    # Never empty the set: an empty token set matches every other empty one by
    # the same artist, which is a merge of two unrelated songs.
    return frozenset(kept or words)


@dataclass(frozen=True)
class Song:
    video_id: str
    artist: str
    tokens: frozenset
    duration: float
    rank: int
    title: str


def attribute(entry):
    """Turn a flat mix entry (or resolved metadata) into a `Song`.

    Accepts either shape — `id` from yt-dlp's flat extraction, `video_id` from
    our own metadata — because `Station.add` is handed both.
    """
    vid = entry.get('id') or entry.get('video_id') or ''
    title = entry.get('title') or ''
    channel_raw = entry.get('uploader') or entry.get('channel') or ''
    channel = _channel_name(entry)

    # Rank first: `_song_tokens` deletes the words it reads.
    rank = version_rank(title, channel_raw)

    artist, song_side = _split_title(title, channel)
    if not artist:
        artist = entry.get('channel_id') or ''
    tokens = _song_tokens(song_side)

    duration = entry.get('duration')
    if duration is not None:
        try:
            duration = float(duration)
        except (TypeError, ValueError):
            duration = None

    return Song(video_id=vid, artist=artist, tokens=tokens,
                duration=duration, rank=rank, title=title)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `.venv/bin/python -m unittest test_songs -v`
Expected: PASS, all of `TestArtist`, `TestTokens`, `TestRank`, `TestDuration`.

- [ ] **Step 7: Confirm the existing suite still discovers**

Run: `.venv/bin/python -m unittest discover -v`
Expected: PASS — both `test_hue` and `test_songs`. This is the command CLAUDE.md must document from now on.

- [ ] **Step 8: Commit**

```bash
git add songs.py test_songs.py testdata/
git commit -m "feat(songs): artist-first song attribution with real mix fixtures

The old _title_key computed identity from the title alone, so a Topic
upload and an official video of one song were two songs, and two artists'
'Alone' were one. attribute() reads the artist out of the title with the
channel name as a tiebreak, which is what those uploads have in common."
```

---

## Task 2: `SongMemory` — the five match rules

**Files:**
- Modify: `songs.py` (append)
- Modify: `test_songs.py` (append)

**Interfaces:**
- Consumes: `Song`, `attribute`, `MATCH_*` from Task 1.
- Produces:
  - `Entry` — mutable dataclass: `artist: str`, `tokens: frozenset[str]`, `duration: float | None`, `ids: dict[str, int]` (video_id → rank, insertion-ordered), `title: str`, `last_at: float`, `heard: bool`. Method `best_id() -> str` (lowest rank, ties by first-seen), `as_song() -> Song`.
  - `Hit` — `namedtuple('Hit', 'entry reason')`, `reason` one of `'id'`, `'exact'`, `'subset'`, `'overlap'`. `'id'` is not fuzzy; the other three are.
  - `SongMemory(ttl=None, queued_ttl=None, max_songs=None)`. Methods: `add(song, heard=False, now=None) -> Entry`, `find(song, now=None) -> Hit | None`, `mark_heard(video_id, now=None) -> bool`, `prune(now=None) -> None`, `oldest_heard() -> Entry | None`, `entries() -> list[Entry]` (insertion order), `__len__`. Attribute `dirty: bool`.
  - `None` for any of `ttl`/`queued_ttl`/`max_songs` means "never expire / never cap" — that is how the station-scoped instance is configured.

- [ ] **Step 1: Write the failing tests**

Append to `test_songs.py`, above the `if __name__` block:

```python
def song(artist, words, duration=200, vid=None, rank=2, title=''):
    """A Song built directly, for match tests that are about tokens only."""
    tokens = frozenset(words.split())
    return songs.Song(video_id=vid or f'{artist}:{words}', artist=artist,
                      tokens=tokens, duration=duration, rank=rank,
                      title=title or f'{artist} - {words}')


class TestMatchRules(unittest.TestCase):
    def setUp(self):
        self.mem = songs.SongMemory()

    def test_rule_1_a_known_video_id_is_a_duplicate(self):
        self.mem.add(song('a', 'one two', vid='v1'))
        hit = self.mem.find(song('a', 'totally different', vid='v1'))
        self.assertIsNotNone(hit)
        self.assertEqual(hit.reason, 'id')

    def test_rule_2_an_empty_artist_bucket_is_not_a_duplicate(self):
        # The O(1) step that keeps fuzzy matching at hash speed, and the one
        # that implements "a cover by another artist stays eligible".
        self.mem.add(song('ellie goulding', 'love me like you do'))
        self.assertIsNone(self.mem.find(song('boyce avenue', 'love me like you do')))

    def test_rule_3_equal_token_sets_match(self):
        self.mem.add(song('dua lipa', 'levitating', duration=217))
        hit = self.mem.find(song('dua lipa', 'levitating', duration=203))
        self.assertEqual(hit.reason, 'exact')

    def test_rule_3_containment_ignores_duration(self):
        # "See You Again" against "See You Again Furious 7 Soundtrack" across
        # uploads whose durations legitimately differ. Requiring duration here
        # would leave both queueable.
        self.mem.add(song('wiz khalifa', 'see you again furious 7 soundtrack', duration=238))
        hit = self.mem.find(song('wiz khalifa', 'see you again', duration=180))
        self.assertEqual(hit.reason, 'subset')

    def test_rule_3_needs_two_tokens_to_skip_the_duration_check(self):
        # `{intro}` must not swallow `{intro, to, the, record}` on containment
        # alone. It falls through to rule 4 and has to earn it on duration.
        self.mem.add(song('a', 'intro to the record', duration=200))
        self.assertIsNone(self.mem.find(song('a', 'intro', duration=400)))

    def test_rule_4_a_single_token_subset_can_still_match_on_duration(self):
        self.mem.add(song('a', 'intro to the record', duration=200))
        hit = self.mem.find(song('a', 'intro', duration=202))
        self.assertEqual(hit.reason, 'overlap')

    def test_rule_4_partial_overlap_below_threshold_stays_distinct(self):
        # 2/3 = 0.67. Two parts of one work are two songs.
        self.mem.add(song('a', 'song part 1', duration=200))
        self.assertIsNone(self.mem.find(song('a', 'song part 2', duration=200)))

    def test_rule_4_partial_overlap_needs_the_durations_to_agree(self):
        self.mem.add(song('a', 'one two three four', duration=200))
        self.assertIsNone(self.mem.find(song('a', 'one two three four five', duration=400)))

    def test_containment_merges_a_taylors_version(self):
        self.mem.add(song('taylor swift', 'love story taylors', duration=235))
        hit = self.mem.find(song('taylor swift', 'love story', duration=356))
        self.assertEqual(hit.reason, 'subset')

    def test_an_unknown_duration_never_confirms_a_partial_match(self):
        # Corroboration we do not have is not corroboration. Flat entries
        # always carry a duration, so this is the resolved-metadata edge.
        self.mem.add(song('a', 'one two three four', duration=None))
        self.assertIsNone(self.mem.find(song('a', 'one two three four five', duration=200)))


class TestMemoryBookkeeping(unittest.TestCase):
    def test_a_matched_add_merges_ids_into_one_entry(self):
        mem = songs.SongMemory()
        mem.add(songs.attribute(SYN['syn_video']))
        mem.add(songs.attribute(SYN['syn_topic']))
        self.assertEqual(len(mem), 1)
        self.assertEqual(set(mem.entries()[0].ids), {'syn_video', 'syn_topic'})

    def test_best_id_is_the_lowest_rank_seen(self):
        mem = songs.SongMemory()
        mem.add(songs.attribute(SYN['syn_video']))    # rank 3
        mem.add(songs.attribute(SYN['syn_topic']))    # rank 0
        self.assertEqual(mem.entries()[0].best_id(), 'syn_topic')

    def test_best_id_breaks_ties_by_first_seen(self):
        mem = songs.SongMemory()
        mem.add(song('a', 'one two', vid='first', rank=2))
        mem.add(song('a', 'one two', vid='second', rank=2))
        self.assertEqual(mem.entries()[0].best_id(), 'first')

    def test_an_id_learned_through_a_merge_is_found_by_rule_1(self):
        mem = songs.SongMemory()
        mem.add(songs.attribute(SYN['syn_video']))
        mem.add(songs.attribute(SYN['syn_topic']))
        hit = mem.find(song('somebody else', 'unrelated', vid='syn_topic'))
        self.assertEqual(hit.reason, 'id')

    def test_entries_keep_insertion_order(self):
        mem = songs.SongMemory()
        for w in ('first song', 'second song', 'third song'):
            mem.add(song('a', w))
        self.assertEqual([e.tokens for e in mem.entries()],
                         [frozenset(w.split()) for w in
                          ('first song', 'second song', 'third song')])

    def test_as_song_round_trips_into_find(self):
        # build_station_queue tests a pooled Entry against the history, so an
        # Entry has to be able to become a Song again without drift.
        mem = songs.SongMemory()
        mem.add(songs.attribute(SYN['syn_video']))
        other = songs.SongMemory()
        other.add(songs.attribute(SYN['syn_topic']))
        self.assertIsNotNone(other.find(mem.entries()[0].as_song()))


class TestHeardAndExpiry(unittest.TestCase):
    def test_a_queued_track_expires_on_the_short_ttl(self):
        mem = songs.SongMemory(ttl=1000, queued_ttl=100)
        mem.add(song('a', 'one two'), heard=False, now=0)
        self.assertIsNotNone(mem.find(song('a', 'one two'), now=50))
        self.assertIsNone(mem.find(song('a', 'one two'), now=500))

    def test_a_heard_track_survives_the_short_ttl(self):
        mem = songs.SongMemory(ttl=1000, queued_ttl=100)
        mem.add(song('a', 'one two'), heard=True, now=0)
        self.assertIsNotNone(mem.find(song('a', 'one two'), now=500))
        self.assertIsNone(mem.find(song('a', 'one two'), now=2000))

    def test_marking_heard_promotes_the_entry_and_restamps_it(self):
        mem = songs.SongMemory(ttl=1000, queued_ttl=100)
        mem.add(song('a', 'one two', vid='v1'), heard=False, now=0)
        self.assertTrue(mem.mark_heard('v1', now=50))
        self.assertIsNotNone(mem.find(song('a', 'one two'), now=900))

    def test_marking_an_unknown_id_heard_is_a_no_op(self):
        self.assertFalse(songs.SongMemory().mark_heard('nope'))

    def test_none_ttl_never_expires(self):
        # The station-scoped instance: it dies with its station instead.
        mem = songs.SongMemory()
        mem.add(song('a', 'one two'), now=0)
        self.assertIsNotNone(mem.find(song('a', 'one two'), now=10 ** 9))

    def test_the_cap_evicts_oldest_first(self):
        # "The newest exclusions are never evicted first" — the requirement
        # stated as the property that would be violated.
        mem = songs.SongMemory(ttl=1000, max_songs=2)
        mem.add(song('a', 'oldest'), heard=True, now=0)
        mem.add(song('a', 'middle'), heard=True, now=10)
        mem.add(song('a', 'newest'), heard=True, now=20)
        self.assertEqual(len(mem), 2)
        self.assertIsNone(mem.find(song('a', 'oldest'), now=20))
        self.assertIsNotNone(mem.find(song('a', 'newest'), now=20))

    def test_expiry_runs_before_the_cap(self):
        mem = songs.SongMemory(ttl=100, max_songs=2)
        mem.add(song('a', 'expired'), heard=True, now=0)
        mem.add(song('a', 'fresh one'), heard=True, now=1000)
        mem.add(song('a', 'fresh two'), heard=True, now=1001)
        mem.prune(now=1002)
        self.assertEqual(len(mem), 2)
        self.assertIsNotNone(mem.find(song('a', 'fresh one'), now=1002))

    def test_oldest_heard_ignores_unheard_entries(self):
        # Rung 6 re-serves this. Handing back a queued-but-never-played track
        # would replay something the listener never got to.
        mem = songs.SongMemory()
        mem.add(song('a', 'never played'), heard=False, now=0)
        mem.add(song('a', 'actually heard'), heard=True, now=100)
        self.assertEqual(mem.oldest_heard().tokens, frozenset({'actually', 'heard'}))

    def test_oldest_heard_is_none_when_nothing_was_heard(self):
        self.assertIsNone(songs.SongMemory().oldest_heard())
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/bin/python -m unittest test_songs -v`
Expected: FAIL with `AttributeError: module 'songs' has no attribute 'SongMemory'`

- [ ] **Step 3: Implement `Entry`, `Hit` and `SongMemory`**

Append to `songs.py`:

```python
# --- Memory ------------------------------------------------------------------

Hit = namedtuple('Hit', 'entry reason')
"""Why a candidate was judged a duplicate.

`reason == 'id'` means we had already seen that exact video; the other three
('exact', 'subset', 'overlap') are fuzzy judgements, and they are the ones
worth logging. Without that distinction "why did it skip that song" is
unanswerable and MATCH_OVERLAP can never be tuned from real behaviour.
"""


@dataclass
class Entry:
    artist: str
    tokens: frozenset
    duration: float
    ids: dict = field(default_factory=dict)   # video_id -> rank, insertion-ordered
    title: str = ''
    last_at: float = 0.0
    heard: bool = False

    def best_id(self):
        """The preferred upload of this song: lowest rank, ties by first-seen.

        Dicts keep insertion order, so `min` over the ids returns the earliest
        of an equal-ranked set — which is mix relevance, the tiebreak the
        collapse in build_station_queue wants.
        """
        return min(self.ids, key=lambda v: self.ids[v])

    def as_song(self):
        """This entry as a candidate, so it can be tested against another memory."""
        best = self.best_id()
        return Song(video_id=best, artist=self.artist, tokens=self.tokens,
                    duration=self.duration, rank=self.ids[best], title=self.title)


def _match(a_tokens, a_duration, b_tokens, b_duration):
    """Fuzzy comparison of two same-artist songs. Returns a reason or None.

    Rules 3 and 4 of the match order. The ≥2-token floor on containment is what
    stops `{intro}` swallowing `{intro, to, the, record}`: a one-word subset
    falls through and has to earn the match on duration instead.
    """
    if a_tokens == b_tokens:
        return 'exact'
    small, large = ((a_tokens, b_tokens) if len(a_tokens) <= len(b_tokens)
                    else (b_tokens, a_tokens))
    if not small:
        return None
    if small <= large and len(small) >= MATCH_MIN_SUBSET_TOKENS:
        return 'subset'
    if len(small & large) / len(small) < MATCH_OVERLAP:
        return None
    # Corroboration we do not have is not corroboration.
    if a_duration is None or b_duration is None:
        return None
    if abs(a_duration - b_duration) <= MATCH_DURATION_TOLERANCE:
        return 'overlap'
    return None


class SongMemory:
    """An artist-bucketed index of songs, used as 'have we had this one'.

    One class covers both anti-repeat mechanisms this replaces, which differed
    only in lifetime and persistence: the station-scoped instance takes no TTL
    and no cap (it dies with its station), the process-scoped one takes seven
    days and a cap and is written to disk. `build_station_queue` uses a third,
    throwaway instance as its within-pool accumulator, so there is exactly one
    matcher in the app rather than two that can drift.

    Takes no lock of its own, deliberately. CLAUDE.md fixes the order
    `Station.lock -> _STATE_LOCK -> _Scheduler._cv`, and a fourth lock here is
    an easy way to violate it by accident. Callers hold the right one.
    """

    def __init__(self, ttl=None, queued_ttl=None, max_songs=None):
        self.ttl = ttl                  # None = never expire
        self.queued_ttl = queued_ttl    # None = unheard entries never expire
        self.max_songs = max_songs      # None = uncapped
        self.dirty = False
        self._entries = []              # insertion order; mix relevance
        self._buckets = {}              # artist -> [Entry]
        self._by_id = {}                # video_id -> Entry

    # -- reads ----------------------------------------------------------------

    def _expired(self, entry, now):
        ttl = self.ttl if entry.heard else self.queued_ttl
        return ttl is not None and now - entry.last_at > ttl

    def find(self, song, now=None):
        """Cheapest-first match of `song` against this memory, or None.

        Expired entries are skipped rather than pruned: `find` runs once per
        candidate per rung, and pruning here would make a full rebuild O(n·m).
        `prune` is called from `add` and from the station loop.
        """
        now = time.time() if now is None else now
        entry = self._by_id.get(song.video_id)
        if entry is not None and not self._expired(entry, now):
            return Hit(entry, 'id')
        for other in self._buckets.get(song.artist, ()):
            if self._expired(other, now):
                continue
            reason = _match(song.tokens, song.duration, other.tokens, other.duration)
            if reason:
                return Hit(other, reason)
        return None

    def entries(self, now=None):
        """Live entries in insertion order."""
        now = time.time() if now is None else now
        return [e for e in self._entries if not self._expired(e, now)]

    def oldest_heard(self, now=None):
        """The least-recently-heard song, for the ladder's final rung.

        Only heard entries are eligible: re-serving a queued-but-unheard song
        would replay something the listener never got to, which is neither a
        repeat nor a new track.
        """
        now = time.time() if now is None else now
        live = [e for e in self._entries if e.heard and not self._expired(e, now)]
        return min(live, key=lambda e: e.last_at) if live else None

    def __len__(self):
        return len(self._entries)

    # -- writes ---------------------------------------------------------------

    def add(self, song, heard=False, now=None):
        """Record a song. Merges into an existing entry when it matches one."""
        now = time.time() if now is None else now
        hit = self.find(song, now=now)
        if hit is not None:
            entry = hit.entry
            entry.ids.setdefault(song.video_id, song.rank)
            self._by_id[song.video_id] = entry
            entry.last_at = now
            entry.heard = entry.heard or heard
            self.dirty = True
            return entry
        entry = Entry(artist=song.artist, tokens=song.tokens,
                      duration=song.duration, ids={song.video_id: song.rank},
                      title=song.title, last_at=now, heard=heard)
        self._insert(entry)
        self.prune(now)
        return entry

    def _insert(self, entry):
        """Place a fully-built Entry into all three structures.

        Three of them, because each answers a different question at a different
        cost: `_entries` is the list prune and oldest_heard walk, `_buckets`
        is what makes `find` compare against one artist's songs instead of all
        2000, and `_by_id` is the O(1) exact hit that runs before any fuzzy
        work. They are only consistent if nothing writes one without the
        others, which is why both `add` and `restore` go through here.
        """
        self._entries.append(entry)
        self._buckets.setdefault(entry.artist, []).append(entry)
        for vid in entry.ids:
            self._by_id[vid] = entry
        self.dirty = True

    def mark_heard(self, video_id, now=None):
        """Promote a queued entry to heard. True if anything changed."""
        now = time.time() if now is None else now
        entry = self._by_id.get(video_id)
        if entry is None:
            return False
        entry.heard = True
        entry.last_at = now
        self.dirty = True
        return True

    def prune(self, now=None):
        """Drop expired entries, then evict by `last_at` ascending to the cap.

        Expiry before eviction, so the cap only ever has to deal with entries
        that are still meant to be here. The cap is a memory backstop rather
        than the intended limit — a week of continuous listening is roughly
        2500 tracks against a default of 2000 — so the listener who reaches it
        loses their oldest few hundred songs early, which is the correct thing
        to give up.
        """
        now = time.time() if now is None else now
        live = [e for e in self._entries if not self._expired(e, now)]
        if self.max_songs is not None and len(live) > self.max_songs:
            live.sort(key=lambda e: e.last_at)
            live = live[len(live) - self.max_songs:]
        if len(live) == len(self._entries):
            return
        keep = {id(e) for e in live}
        self._entries = [e for e in self._entries if id(e) in keep]
        self._buckets = {}
        self._by_id = {}
        for entry in self._entries:
            self._buckets.setdefault(entry.artist, []).append(entry)
            for vid in entry.ids:
                self._by_id[vid] = entry
        self.dirty = True
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.venv/bin/python -m unittest test_songs -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add songs.py test_songs.py
git commit -m "feat(songs): SongMemory, one matcher for both anti-repeat sets

Station.played_ids/played_titles and _RECENT differed only in lifetime and
persistence, not in logic. One class with a TTL and a cap covers both, and
build_station_queue reuses it as its within-pool accumulator so there is
one matcher rather than three that can drift apart."
```

---

## Task 3: History persistence

7-day memory only survives a restart if it is written to disk. The spec puts
the file in `CACHE_DIR` beside the sidecars, and requires the write to happen
**outside `_STATE_LOCK`** — a 2000-entry JSON dump under the lock that
`/media` and the scheduler both contend on is a stall the listener hears.

That is why the path is not a `SongMemory` constructor argument, which is a
deviation from the spec's sketch: `snapshot()` produces a plain structure
under the lock, and `save_history(path, payload)` writes it after the lock is
released. The station-scoped memory has no file at all and never calls either.

**Files:**
- `songs.py` — add `HISTORY_VERSION`, `snapshot`, `restore`, `load_history`, `save_history`
- `test_songs.py` — add `TestPersistence`

**Step 1: Write the tests**

- [ ] `test_round_trip_preserves_matching` — add a heard song; snapshot; restore into a fresh `SongMemory`; `find()` still hits it by a *different upload* of the same song, and `oldest_heard()` returns it. Matching, not just storage, is what has to survive the round trip.
- [ ] `test_unheard_entries_are_not_persisted` — add one heard and one queued-only song; the snapshot carries exactly one entry. This is the Global Constraint, and it is the one rule a future `snapshot()` edit is most likely to break by accident.
- [ ] `test_round_trip_through_disk` — `save_history(tmp, m.snapshot())` then `load_history(tmp)` returns an equal payload. Uses `tempfile.TemporaryDirectory`.
- [ ] `test_missing_file_is_empty` — `load_history(nonexistent)` returns `None`, and `restore(None)` leaves the memory empty rather than raising.
- [ ] `test_corrupt_file_is_empty` — write `"{not json"`; `load_history` returns `None` and logs nothing fatal.
- [ ] `test_version_mismatch_discards` — write a payload with `version: 0`; `load_history` returns `None`. A format change must not be read with the current reader's assumptions; discarding costs one session of memory and is the only safe reading.
- [ ] `test_restore_prunes_expired` — snapshot an entry with `last_at` 8 days old, restore, assert `len(m) == 0`. TTL is enforced on read as well as on write, because the process can be down for longer than the TTL.
- [ ] `test_save_is_atomic` — after `save_history`, no `.part` file remains in the directory and the target parses.
- [ ] `test_snapshot_clears_dirty` — `snapshot()` sets `dirty = False`, so the flush loop in Task 8 can use it as its "nothing to write" signal.

**Step 2: Run the tests to verify they fail**

Run: `.venv/bin/python -m unittest test_songs -v`
Expected: FAIL — `AttributeError: 'SongMemory' object has no attribute 'snapshot'`

**Step 3: Implement**

```python
HISTORY_VERSION = 1

# In SongMemory:

    def snapshot(self):
        """The memory as plain JSON-able data, for writing outside the lock.

        Called under whatever lock guards the memory; the returned structure
        shares nothing mutable with it, so the caller can release the lock and
        then spend as long as it likes serialising.

        Clears `dirty` because from here on the on-disk copy is current as of
        this moment — a write that fails leaves the flag down and loses at most
        one interval's worth of history, which is the right trade against
        re-dumping 2000 entries every tick.
        """
        self.prune()
        self.dirty = False
        return {
            'version': HISTORY_VERSION,
            # Heard entries only. A queued-but-never-reached song is excluded
            # for HISTORY_QUEUED_TTL so a *running* station doesn't queue it
            # twice; once the process restarts that station is gone and the
            # song was never played, so carrying the exclusion across would
            # hide a song for two hours for no reason at all.
            'entries': [
                {
                    'artist': e.artist,
                    'tokens': sorted(e.tokens),
                    'duration': e.duration,
                    'ids': dict(e.ids),
                    'title': e.title,
                    'last_at': e.last_at,
                    'heard': True,
                }
                for e in self._entries if e.heard
            ],
        }

    def restore(self, payload):
        """Load a snapshot, dropping anything already expired.

        `None` is a valid argument and means "there was nothing to load" —
        first run, a missing file, a corrupt one, or a version we don't read.
        All four are the same situation to this class and none of them is an
        error worth refusing to start over.
        """
        if not payload:
            return
        now = time.time()
        for raw in payload.get('entries', ()):
            try:
                entry = Entry(
                    artist=raw['artist'],
                    tokens=frozenset(raw['tokens']),
                    duration=raw.get('duration'),
                    ids=dict(raw.get('ids') or {}),
                    title=raw.get('title', ''),
                    last_at=float(raw.get('last_at') or 0.0),
                    heard=bool(raw.get('heard')),
                )
            except (KeyError, TypeError, ValueError):
                continue  # one malformed row must not cost the other 1999
            self._insert(entry)
        self.prune(now)
        self.dirty = False


def load_history(path):
    """The saved memory, or None if there isn't a usable one.

    Every failure mode collapses to None on purpose. A missing file is a first
    run, a corrupt one is a crash mid-write that the atomic rename should have
    prevented, and a version we don't recognise is a downgrade. None of them
    should stop the app starting, and all of them mean the same thing to the
    caller: begin with an empty memory.
    """
    try:
        with open(path, 'r') as fh:
            payload = json.load(fh)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        logger.warning(f"Ignoring unreadable history at {path}: {exc}")
        return None
    if not isinstance(payload, dict) or payload.get('version') != HISTORY_VERSION:
        logger.info(f"Discarding history at {path}: unsupported version")
        return None
    return payload


def save_history(path, payload):
    """Write a snapshot, atomically.

    `.part` + rename, the same discipline the audio cache uses, for the same
    reason: this is written on a timer and at shutdown, so a kill lands mid-
    write eventually. A half-written file would be read back as corrupt and
    silently discarded — losing exactly the history this is here to keep.
    """
    tmp = f"{path}.part"
    try:
        with open(tmp, 'w') as fh:
            json.dump(payload, fh)
        os.replace(tmp, path)
    except OSError as exc:
        logger.warning(f"Could not save history to {path}: {exc}")
        try:
            os.unlink(tmp)
        except OSError:
            pass
```

`restore` goes through `_insert` (Task 2) rather than appending directly: the
three structures are only consistent if every write touches all of them, and a
restore that populated `_entries` alone would leave `find` unable to see any
loaded song — a seven-day memory that silently matched nothing.

**Step 4: Run the tests to verify they pass**

Run: `.venv/bin/python -m unittest test_songs -v`
Expected: PASS

**Step 5: Commit**

```bash
git add songs.py test_songs.py
git commit -m "feat(songs): persist the heard-song memory across restarts

A 7-day memory that dies with the process is a 12-hour memory at best. The
snapshot/save split keeps the JSON dump off the state lock, and every
unreadable-file case collapses to 'start empty' so a bad history can never
stop the app booting."
```
---

## Task 4: `build_station_queue` moves into `songs.py`

Today's version is at `app.py:687-731`. It fetches its own mixes
(`get_radio_mix(seed)` at line 705, inside the loop), which is what makes it
untestable without the network, and it dedupes with `_title_key` /
`_artist_key`, which are the two functions this whole plan exists to delete.

The new one takes entries it is handed and memories it is asked to consult, so
a test is a list of dicts. Fetching moves out to the caller — `_pick_next`,
which in Task 7 needs to control fetching anyway to run the seed ladder.

It also gains the version preference: where today two uploads of one song both
survive as separate candidates, collapsing them through a `SongMemory` leaves
one entry whose `best_id()` is the lowest-ranked upload — the Topic or
"Official Audio" version rather than the music video.

**Files:**
- `songs.py` — add `build_station_queue`
- `test_songs.py` — add `TestBuildQueue`

**Interfaces:**

```python
def build_station_queue(entries, memories, cooldown_artists=(),
                        max_per_artist=MAX_TRACKS_PER_ARTIST, on_reject=None):
    """Turn raw mix entries into a varied, non-repeating queue.

    entries:  iterable of yt-dlp flat-extract dicts, in relevance order.
              The caller has already fetched and concatenated the seed mixes.
    memories: iterable of SongMemory to exclude against, consulted in order.
              Two in production — the station's own and the 7-day history —
              and the ladder's rungs 4 and 5 work by passing fewer of them.
    on_reject: optional callable(entry, reason) invoked for each candidate
              dropped by a *fuzzy* match ('exact'/'subset'/'overlap', never
              'id'). This is how the rejection log in Task 9 gets its data
              without this function knowing what a logger is.

    Returns a list of entries, each carrying an added 'id' rewritten to the
    best-ranked upload of that song.
    """
```

**Step 1: Write the tests**

All fixtures are `testdata/mix_synthetic.json` rows plus inline dicts; nothing
touches the network.

- [ ] `test_drops_ids_already_in_memory` — an entry whose id is in a passed memory never appears.
- [ ] `test_drops_fuzzy_match_in_memory` — memory holds `Dua Lipa - Levitating`; a Topic `Levitating` entry is dropped, and `on_reject` was called once with reason `'exact'`.
- [ ] `test_collapses_versions_within_the_pool` — a mix containing both `Artist - Song (Official Video)` and a Topic `Song` yields **one** entry.
- [ ] `test_collapsed_entry_uses_the_audio_upload` — for that pair, the surviving entry's `id` is the Topic upload's id, and its position in the result is the position of whichever appeared **first** in the mix. Rank decides the file; mix order decides the slot.
- [ ] `test_unmarked_beats_official_video` — rank 2 wins over rank 3, so an unmarked upload is preferred to a music video.
- [ ] `test_cover_by_another_artist_survives` — a different-artist cover of a memorised song is kept. This is the user's "any version except covers" line and it is the one rule that costs recall to honour.
- [ ] `test_artist_cap` — five entries from one artist with `max_per_artist=2` yield two.
- [ ] `test_no_back_to_back_same_artist` — with three artists × two tracks, no two adjacent results share an artist.
- [ ] `test_cooldown_artists_ordered_last` — a cooled-down artist's first track appears after every fresh artist's first track, but is not dropped.
- [ ] `test_unknown_artist_treated_as_unique` — two entries with no resolvable artist do not share a bucket and are not capped against each other.
- [ ] `test_empty_entries_yields_empty` — no exception, no `None`.
- [ ] `test_no_memories_is_legal` — `memories=()` returns the whole collapsed pool; this is rung 5 of the ladder with the artist cap lifted.
- [ ] `test_on_reject_not_called_for_id_matches` — an exact-id drop is not a fuzzy decision and must not be logged as one, or the log fills with the normal case.

**Step 2: Run the tests to verify they fail**

Run: `.venv/bin/python -m unittest test_songs -v`
Expected: FAIL — `ImportError: cannot import name 'build_station_queue'`

**Step 3: Implement**

```python
def build_station_queue(entries, memories, cooldown_artists=(),
                        max_per_artist=MAX_TRACKS_PER_ARTIST, on_reject=None):
    cooldown = {a for a in cooldown_artists if a}
    memories = list(memories)

    # 1. Collapse the pool onto itself.
    #
    # `pool` is a throwaway SongMemory used as an accumulator, which is what
    # makes "two uploads of one song" and "an upload of a song I already
    # played" the same comparison instead of two hand-rolled ones. Its TTL and
    # cap are irrelevant — nothing is ever pruned from it — so it is built with
    # the defaults and discarded.
    pool = SongMemory()
    slots = []            # Entry objects in first-seen order
    for raw in entries:
        song = attribute(raw)
        if not song.video_id:
            continue

        hit = None
        for memory in memories:
            hit = memory.find(song)
            if hit:
                break
        if hit:
            if on_reject and hit.reason != 'id':
                on_reject(raw, hit.reason)
            continue

        seen = pool.find(song)
        if seen is None:
            entry = pool.add(song)
            entry.raw = raw          # keep the dict; the caller enqueues it
            slots.append(entry)
        else:
            # Same song, second upload. `add` merges the id at its rank, so
            # `best_id()` now answers with whichever upload ranks lower. The
            # slot stays where the first one put it.
            pool.add(song)

    # 2. Bucket by artist and cap.
    buckets = {}
    order = []
    for entry in slots:
        akey = entry.artist or entry.best_id()   # unknown artist -> unique
        if akey not in buckets:
            buckets[akey] = []
            order.append(akey)
        if len(buckets[akey]) < max_per_artist:
            buckets[akey].append(entry)

    # 3. Fresh artists before cooled-down ones (stable, so relevance survives).
    order.sort(key=lambda a: a in cooldown)

    # 4. Round-robin -> no artist back to back.
    queue = []
    while any(buckets[a] for a in order):
        for a in order:
            if buckets[a]:
                entry = buckets[a].pop(0)
                out = dict(entry.raw)
                # The one field this function rewrites: play the best upload of
                # the song, not the one the mix happened to list first.
                out['id'] = entry.best_id()
                queue.append(out)
    return queue
```

`Entry.raw` is set here rather than declared on the dataclass: it only exists
for entries living in a pool accumulator, and a `SongMemory` that is persisted
must not carry a yt-dlp dict into `snapshot()`.

**Step 4: Run the tests to verify they pass**

Run: `.venv/bin/python -m unittest test_songs -v`
Expected: PASS

**Step 5: Commit**

```bash
git add songs.py test_songs.py
git commit -m "feat(songs): rebuild the queue builder on song identity

Takes entries and memories instead of fetching its own mixes, which is what
makes it testable, and collapses duplicate uploads through a throwaway
SongMemory so the surviving candidate is the audio master rather than
whichever upload the mix listed first."
```

---

## Task 5: Cut `app.py` over to `songs.py`

The mechanical half of the change: delete the three key functions and the two
sets built on them, give `Station` a memory, and wire the module in. No new
behaviour — the ladder (Task 7) and the heard-marking (Task 8) come after. At
the end of this task the app runs with the new identity logic and the old
3-rung ladder, which is a working state worth having.

The deletions are the point. Leaving `_title_key` in place "just in case"
guarantees a second matcher drifts back into existence.

**Files:**
- `songs.py` — no change
- `app.py` — delete `_artist_key` (609-619), `_title_key` (621-631), `_remember` (633-655), `_recent_filters` (657-668), `build_station_queue` (687-731), `_RECENT` (491); rewrite the tunables block (404-417), `Station.__init__` (1494-1520), `Station.add` (1522-1543), `_pick_next` (1546-1580), `refresh_station` / `remove_from_station` docstrings
- `Containerfile:44` — add `songs.py` to the `COPY`

**Step 1: Add the tunables and the import**

Replace the `RECENT_MAX` / `RECENT_TTL` lines (416-417) with the history
settings, and rewrite the comment block above them (404-412) — it currently
explains `_RECENT` as "process-wide memory of tracks already served", which
stops being true here.

```python
MAX_TRACKS_PER_ARTIST = int(os.environ.get('MAX_TRACKS_PER_ARTIST', 2))
ARTIST_COOLDOWN = int(os.environ.get('ARTIST_COOLDOWN', 4))
STATION_PICK_POOL = max(1, int(os.environ.get('STATION_PICK_POOL', 3)))
# How long a song stays "already heard", and how many are remembered. Seven
# days is the span over which a listener notices a repeat; the cap is what
# stops the file and the match cost growing without bound on a box that never
# restarts. Songs merely *queued* expire much sooner — the station that queued
# them may never reach them, and a track the speaker never played should not
# be excluded tomorrow.
HISTORY_TTL = float(os.environ.get('HISTORY_TTL', 7 * 86400))
HISTORY_MAX = int(os.environ.get('HISTORY_MAX', 2000))
HISTORY_QUEUED_TTL = float(os.environ.get('HISTORY_QUEUED_TTL', 2 * 3600))
# How often the history is written to disk, at most.
HISTORY_FLUSH_INTERVAL = float(os.environ.get('HISTORY_FLUSH_INTERVAL', 60))
# How many songs a station remembers seeing but never queuing, for ladder
# rung 3 — a seed pool that costs nothing to collect and is by construction
# made of songs we have not played.
SEEN_UNQUEUED_MAX = int(os.environ.get('SEEN_UNQUEUED_MAX', 300))
```

Import beside `hue` and `analysis`:

```python
import songs
from songs import SongMemory, attribute, build_station_queue
```

`songs` stays imported as a module too, because Task 9's endpoint reads
`songs.HISTORY_VERSION` and the tests monkeypatch module constants.

`app.py:17` is `from collections import Counter`; it becomes
`from collections import Counter, OrderedDict` for `Station.seen_unqueued`.

**Step 2: Replace `_RECENT` with `_HISTORY`**

```python
# Guards STATION, _DOWNLOADS, _INUSE, _MIX_CACHE and _HISTORY. Reentrant
# because the station loop holds it while calling helpers that take it again.
_STATE_LOCK = threading.RLock()
_DOWNLOADS = {}          # video_id -> Download
_INUSE = Counter()       # video_id -> active /media readers; blocks eviction
_MIX_CACHE = {}          # video_id -> (fetched_at, entries)
# Every song any station has queued or played, for HISTORY_TTL. Outlives the
# Station objects — which is the whole point, since a stop-and-play used to
# reset the memory to nothing — and survives a restart via history.json.
_HISTORY = SongMemory(ttl=HISTORY_TTL, queued_ttl=HISTORY_QUEUED_TTL,
                      max_songs=HISTORY_MAX)
_HISTORY_PATH = os.path.join(CACHE_DIR, 'history.json')
_HISTORY_FLUSHED_AT = 0.0
```

Delete `_artist_key`, `_title_key`, `_remember`, `_recent_filters` and the old
`build_station_queue` outright. Their only callers are `Station.add`,
`_pick_next` and `build_station_queue` itself, all of which are rewritten in
this task — `grep -n '_title_key\|_artist_key\|_remember\|_recent_filters\|_RECENT' app.py` must come back empty when the step is done.

**Step 3: Rewrite `Station`**

```python
class Station:
    def __init__(self, device_ip, seed_id):
        self.device_ip = device_ip
        self.seed_id = seed_id
        self.tracks = []
        self.index = 0
        self.enqueued = 0
        self.lock = threading.RLock()
        # Songs this station has queued, with no TTL and no cap: a session's
        # own queue must never repeat itself however long it runs, which is a
        # stronger rule than the 7-day one and needs its own set.
        self.memory = SongMemory(ttl=None, queued_ttl=None, max_songs=None)
        self.played_order = []       # video_ids in queue order, for reseeding
        self.artist_history = []     # artist keys, most recent last
        # Songs a mix offered that we did not queue — ladder rung 3's seed
        # pool. An OrderedDict used as an ordered set, oldest first.
        self.seen_unqueued = OrderedDict()
        self.widen = 0               # ladder rung to try next; see _pick_next
        self.exhausted = False
        self.idle_polls = 0
        self.ticks = 0
        self.playing_seen = False
        self.stop = threading.Event()
```

`Station.add` loses `played_ids` / `played_titles` / `_remember` and gains the
two memories. It stays the single point every track passes through, which is
why both writes belong here:

```python
    def add(self, entry, at=None):
        vid = entry.get('id')
        if not vid:
            return
        song = attribute(entry)
        self.memory.add(song)
        with _STATE_LOCK:
            _HISTORY.add(song)                 # heard=False: queued, not played
        # A song we queued is no longer a song we passed over.
        self.seen_unqueued.pop(vid, None)
        # (unchanged: the `meta` dict build and its append/insert into
        #  self.tracks, app.py:1522-1532)
        self.played_order.append(vid)
        self.artist_history.append(song.artist or vid)
        return meta
```

`_HISTORY.add` is taken under `_STATE_LOCK` and `Station.lock` is already held
by every caller, which is the documented order `Station.lock -> _STATE_LOCK`.
`self.memory` is guarded by `Station.lock` alone and must not be touched from
anywhere that does not hold it.

**Step 4: Rewrite `_pick_next`'s body (ladder unchanged)**

Keep the existing three rungs; only swap what they call. This isolates the
identity change from the ladder change, so a regression in the next task has
one cause.

```python
def _pick_next(station, refresh=False):
    if not station.played_order:
        return None
    seeds = _reseed_ids(station.played_order)
    entries = []
    for seed in seeds:
        entries.extend(get_radio_mix(seed, refresh=refresh))
    cooldown = station.artist_history[-ARTIST_COOLDOWN:]

    with _STATE_LOCK:
        memories = [station.memory, _HISTORY]
        queue = build_station_queue(entries, memories, cooldown_artists=cooldown,
                                    on_reject=_log_reject)
        if not queue:
            queue = build_station_queue(entries, [station.memory],
                                        cooldown_artists=cooldown)
        if not queue:
            queue = build_station_queue(entries, [station.memory],
                                        max_per_artist=len(entries) or 1)
    if not queue:
        station.exhausted = True
        return None
    return random.choice(queue[:STATION_PICK_POOL])
```

Note rung 3 keeps `station.memory` where the old code dropped the title filter
entirely — that is the spec's split, and it is free to take here.

`_log_reject` is a two-line stub for now (`pass`); Task 9 fills it in.

**Step 5: Fix the docstrings that name deleted things**

`refresh_station` and `remove_from_station` both promise they keep
"`played_ids` / `played_titles` / `_RECENT`". The behaviour is unchanged — they
keep `station.memory` and `_HISTORY` — but the names are gone, and a docstring
naming a symbol that no longer exists is how the next reader concludes the code
is doing something it isn't.

Same for the `CLAUDE.md` section "Why the queue used to repeat itself", which
is rewritten wholesale in Task 12.

**Step 6: Containerfile**

```dockerfile
COPY app.py hue.py analysis.py songs.py .
```

A missing module here builds clean and dies at startup, per the comment
already above that line.

**Step 7: Verify**

```bash
.venv/bin/python -m unittest discover -v       # test_hue + test_songs
.venv/bin/python -c "import app"               # import-time errors
grep -n '_title_key\|_artist_key\|_remember\|_recent_filters\|_RECENT' app.py
```
Expected: tests pass, import clean, grep empty.

Then a manual smoke run — `make run-local`, play a seed, watch the station
extend past 3 tracks in the log. The unit tests cover `songs.py`; nothing
covers `app.py`, so this is the only check that the wiring is right.

**Step 8: Commit**

```bash
git add app.py Containerfile
git commit -m "refactor(station): one song identity, replacing three key functions

_artist_key preferred channel_id, so its Topic-stripping never ran and a
Topic upload and an artist upload were different artists. _title_key ignored
the uploader, so two artists' 'Alone' were one song and blocked each other
globally for 12 hours. Both are gone; Station.memory and _HISTORY answer
'have we played this' with the same matcher build_station_queue uses."
```

---

## Task 6: Widen the candidate pool

`get_radio_mix` defaults to `limit=25` and no caller overrides it, so every
pick chooses from at most 50 entries across two seeds — before the artist cap
takes two-thirds of them. The measurement in the spec says 50 is where the
extra entries are still unique:

```
playlistend=25:   25 entries,  25 unique,  1.0s
playlistend=50:   50 entries,  50 unique,  2.6s
playlistend=100: 100 entries,  73 unique,  3.8s
```

Past 50 YouTube starts repeating itself, so 100 costs 1.2s for 23 duplicates.
This runs synchronously inside the station loop, which is why the number
matters and why the loop's warm-up ramp exists.

Two smaller fixes ride along, both in the same function. `get_radio_mix`
filters entries without an `id` but never dedupes *by* id, so at `limit=50` a
mix that does repeat feeds the same track twice into the pool — harmless today
only because `build_station_queue` deduped downstream. And `_MIX_CACHE` is
written at `app.py:600` and never pruned: one entry per seed video, for the
life of the process, each holding 50 dicts.

**Files:**
- `app.py` — `MIX_LIMIT` / `MIX_CACHE_MAX` constants, `get_radio_mix` (576-607)

**Step 1: Add the constants**

Beside `MIX_CACHE_TTL` at `app.py:471`:

```python
# How many entries to pull from a radio mix. 50 is measured: YouTube serves 50
# unique tracks per mix and starts repeating past that, so 100 costs an extra
# second of station-loop time for ~23 duplicates.
MIX_LIMIT = int(os.environ.get('MIX_LIMIT', 50))
# How many mixes to memoise. _MIX_CACHE is only bounded by how many distinct
# seeds a process sees, which on a box that runs for weeks is unbounded.
MIX_CACHE_MAX = int(os.environ.get('MIX_CACHE_MAX', 200))
```

**Step 2: Rewrite `get_radio_mix`**

```python
def get_radio_mix(video_id, limit=None, refresh=False):
    limit = MIX_LIMIT if limit is None else limit
    # (unchanged: the docstring, the _MIX_CACHE lookup, the mix_url build and
    #  the try/except around ydl.extract_info — app.py:577-596 and 602-607)
    entries = []
    seen = set()
    for e in (info.get('entries') or []):
        vid = e.get('id')
        # YouTube repeats entries past ~50; two copies of one track would
        # occupy two candidate slots and one artist-cap slot.
        if vid and vid not in seen:
            seen.add(vid)
            entries.append(e)
    if entries:
        with _STATE_LOCK:
            _MIX_CACHE[video_id] = (time.time(), entries)
            _prune_mix_cache()
    return entries
```

`limit=None` rather than `limit=MIX_LIMIT` in the signature so an env override
is read at call time, which is what the tests need.

**Step 3: Add `_prune_mix_cache`**

```python
def _prune_mix_cache():
    """Drop expired mixes, then the oldest, until the cache fits.

    Called under _STATE_LOCK, after an insert. Expiry first and eviction second
    because an expired entry is worthless while the oldest live one may still
    be a seed the station is walking — evicting purely by age would throw away
    a useful mix while keeping stale ones.
    """
    now = time.time()
    for vid in [v for v, (at, _) in _MIX_CACHE.items() if now - at >= MIX_CACHE_TTL]:
        _MIX_CACHE.pop(vid, None)
    while len(_MIX_CACHE) > MIX_CACHE_MAX:
        oldest = min(_MIX_CACHE, key=lambda v: _MIX_CACHE[v][0])
        _MIX_CACHE.pop(oldest, None)
```

**Step 4: Verify**

No unit test — this function is the network boundary. Check by hand:

```bash
.venv/bin/python -c "
import app
m = app.get_radio_mix('dQw4w9WgXcQ')
print(len(m), len({e['id'] for e in m}))
"
```
Expected: a count near 50 with no duplicates. If YouTube is rate-limiting, the
function logs and returns `[]` — that is the existing behaviour and not a
failure of this change.

**Step 5: Commit**

```bash
git add app.py
git commit -m "feat(station): 50-entry mixes, deduped, with a bounded cache

25 entries minus the artist cap left the picker choosing from a dozen songs.
50 is where YouTube stops serving unique tracks, so it is the whole usable
pool. _MIX_CACHE now expires and caps instead of growing for the life of the
process."
```

---

## Task 7: The six-rung pick ladder

The behavioural core. Today's ladder relaxes *filters* when it runs dry —
first the 7-day memory, then the artist cap and the song filter together — so
the first thing a starved station does is repeat a song. The spec inverts
that: widen the **seeds** first, because more songs is strictly better than
fewer rules, and only relax filters once three different seed pools have
failed.

```
1. seeds = [most recent, random from last 8]       full filters
2. + one older seed from played_order              full filters   (new)
3. + one seed from a song seen but never queued    full filters   (new)
4. station memory only (drop the 7-day memory)
5. artist cap lifted, song filter kept                            (the split)
6. re-serve the least-recently-heard song, mark the station exhausted
```

Rungs 2 and 3 each cost a yt-dlp round trip (~2.6s), and this runs
synchronously inside the station loop. So a single call attempts **rung 1 plus
exactly one** of them — `station.widen` alternates which — and the next tick
tries the other. This is the Global Constraint "at most one additional mix
fetch per `_pick_next` call", and it is why the ladder is written as straight
line rather than a loop over the rungs: a loop reads more neatly and fetches
twice.

Rung 5 is the split the spec calls for. Today's rung 3 drops the song filter
and the artist cap in one step, which means the cheapest way to relax is also
the one that repeats a song. Lifting the cap alone gives back a much larger
pool — the cap discards two-thirds of a 50-entry mix — while still never
serving a song twice.

Rung 6 is "oldest-first repeat": re-serve the least-recently-heard song rather
than letting the station stop. The old floor picked whatever survived the
filters, which is mix-relevance ordered, which tracks popularity — so the
station's first repeat was its most-played song. Oldest-first is the opposite
and is what the user chose.

**Files:**
- `app.py` — rewrite `_pick_next` (1546-1580), add `_widen_seed`,
  `_record_unqueued`, `_reserve_oldest`, `_log_reject`; `_top_up` (1629-1661)
- `songs.py` — no change

**Interfaces:**

```python
def _pick_next(station, refresh=False, fetch=None):
    """The next track for this station, or None if there is genuinely nothing.

    `fetch` is the mix fetcher, defaulting to get_radio_mix. Injected so the
    walk simulation in Task 10 can drive the whole ladder from fixtures.

    Returns None only when station.played_order is empty — with the oldest-
    first floor at rung 6, a station with any history always has something to
    play. Sets station.exhausted when it had to use that floor.
    """
```

**Step 1: `_pick_next`**

```python
def _pick_next(station, refresh=False, fetch=None):
    fetch = fetch or get_radio_mix
    if not station.played_order:
        return None

    seeds = _reseed_ids(station.played_order)
    cooldown = station.artist_history[-ARTIST_COOLDOWN:]
    entries = []
    for seed in seeds:
        entries.extend(fetch(seed, refresh=refresh))

    # Rung 1: the normal path, no extra fetch.
    with _STATE_LOCK:
        queue = build_station_queue(entries, [station.memory, _HISTORY],
                                    cooldown_artists=cooldown,
                                    on_reject=_log_reject)
    if queue:
        # Back to normal: forget that we ever had to widen, so the next lean
        # patch starts from one fetch again.
        station.widen = 0
        station.exhausted = False
        return _choose(station, queue, entries)

    # Rung 2 or 3 — whichever `station.widen` points at, and only ONE of them.
    # Each is a synchronous yt-dlp extraction (~2.6s) inside the station loop,
    # and the Global Constraint is at most one extra fetch per call. A station
    # that needs both climbs on the next tick, which costs seconds, not the
    # tens of seconds a loop over both rungs would cost every tick.
    rung = 2 + min(station.widen, 1)
    station.widen += 1          # next call tries the other rung
    extra = _widen_seed(station, rung, seeds)
    if extra:
        entries.extend(fetch(extra, refresh=refresh))
        with _STATE_LOCK:
            queue = build_station_queue(entries, [station.memory, _HISTORY],
                                        cooldown_artists=cooldown,
                                        on_reject=_log_reject)
        if queue:
            station.exhausted = False
            return _choose(station, queue, entries)

    # Rung 4: drop the 7-day memory. The station's own list still holds, so
    # this repeats nothing within the session — only something from days ago.
    queue = build_station_queue(entries, [station.memory],
                                cooldown_artists=cooldown)
    if queue:
        station.exhausted = False
        return _choose(station, queue, entries)

    # Rung 5: lift the artist cap, keep the song filter. Two songs by one
    # artist in a row is a much smaller harm than the same song twice.
    queue = build_station_queue(entries, [station.memory],
                                max_per_artist=len(entries) or 1)
    if queue:
        logger.info(f"Station {station.device_ip}: artist cap lifted to refill")
        station.exhausted = False
        return _choose(station, queue, entries)

    # Rung 6: the floor.
    return _reserve_oldest(station)
```

Rungs 4 and 5 do not take `_STATE_LOCK`: they consult `station.memory` only,
which `Station.lock` guards, and the caller already holds it. Rungs 1-3 take it
because `_HISTORY` is in the list. That is the documented order
`Station.lock -> _STATE_LOCK` and it must not be inverted here.

Rung 4 differs from rung 3 in exactly one argument and rung 5 differs from
rung 4 in exactly one more. Keeping them as three literal calls rather than a
loop over argument tuples is deliberate — each rung's comment is the reason it
exists, and a table of arguments has nowhere to put that.

**Step 2: `_choose` and `_record_unqueued`**

```python
def _choose(station, queue, entries):
    """Take one from the top of the pool, and remember what we passed over.

    The pick is random within STATION_PICK_POOL because a deterministic pick
    makes the whole walk reproducible — same seed, same mix, same queue, which
    is defect 5 in the spec.

    Everything else the pool offered is recorded as seen-but-unqueued, which
    costs a dict insert and gives rung 3 a seed pool made entirely of songs
    this station has not played.
    """
    chosen = random.choice(queue[:STATION_PICK_POOL])
    _record_unqueued(station, (e for e in queue if e is not chosen))
    return chosen


def _record_unqueued(station, entries):
    for e in entries:
        vid = e.get('id')
        if not vid:
            continue
        station.seen_unqueued[vid] = None
        station.seen_unqueued.move_to_end(vid)
    while len(station.seen_unqueued) > SEEN_UNQUEUED_MAX:
        station.seen_unqueued.popitem(last=False)
```

`Station.add` already pops from `seen_unqueued` (Task 5, step 3), so a song
that later gets queued leaves the pool without a second pass.

**Step 3: `_widen_seed`**

```python
def _widen_seed(station, rung, used):
    """One more seed id for ladder rung `rung`, or None if there isn't one.

    Rung 2 reaches further back into this station's own walk than _reseed_ids
    does — its window is the last 8 tracks, so a station that has been orbiting
    one sound for an hour is reseeding from inside that orbit. An older track
    is a different neighbourhood and it is one we know the listener accepted.

    Rung 3 leaves the walk entirely: a song some mix offered that we never
    queued. Its mix is by construction adjacent to this station's taste and by
    construction not something we have played.
    """
    if rung == 2:
        pool = [v for v in station.played_order[:-9] if v not in used]
        return random.choice(pool) if pool else None
    if rung == 3:
        pool = [v for v in station.seen_unqueued if v not in used]
        return random.choice(pool) if pool else None
    return None
```

Both draw at random, for the same reason `_reseed_ids` does: a fixed offset
makes the ladder reproducible and two stations from one seed walk together.

**Step 4: `_reserve_oldest`**

```python
def _reserve_oldest(station):
    """The floor: re-serve the song heard longest ago.

    The old floor took whatever survived with every filter off, which is
    mix-relevance order, which tracks popularity — so the first song a starved
    station repeated was its most popular one, the one most likely to be
    recognised as a repeat. Least-recently-heard is the opposite choice and
    the only one that degrades gracefully.

    Returns an entry shaped like a mix entry, because every caller downstream
    (Station.add, _top_up, ensure_cached) expects that shape. The metadata
    comes from the memory, enriched from station.tracks when that id is still
    listed there — the memory keeps a title and an artist but not a thumbnail
    or a duration the UI can show.
    """
    with _STATE_LOCK:
        entry = _HISTORY.oldest_heard()
    if entry is None:
        station.exhausted = True
        return None

    vid = entry.best_id()
    # station.tracks holds *meta* dicts keyed 'video_id' (Station.add builds
    # them), not mix entries keyed 'id'. The return value has to be a mix entry,
    # so this translates rather than copying.
    for track in station.tracks:
        if track.get('video_id') == vid:
            out = {'id': vid, 'title': track.get('title'),
                   'uploader': track.get('uploader'),
                   'thumbnail': track.get('thumbnail'),
                   'channel_id': track.get('channel_id'),
                   'duration': track.get('duration')}
            break
    else:
        out = {'id': vid, 'title': entry.title, 'uploader': entry.artist,
               'duration': entry.duration}

    station.exhausted = True
    logger.info(
        f"Station {station.device_ip}: exhausted, re-serving {entry.title!r} "
        f"last heard {int(time.time() - entry.last_at)}s ago")
    return out
```

`exhausted` stays `True` on this path even though a track was returned. Its
meaning changes from "the station stopped" to "the station is repeating
itself", which is what the frontend surfaces in Task 11 — and it is cleared by
the next successful rung 1-5 pick above.

**Step 5: `_top_up` stops treating `exhausted` as terminal**

`app.py:1647-1651` returns early when `station.exhausted` is set, which was
correct when `exhausted` meant `_pick_next` had given up. Now it means the
last pick was a repeat, and the next one may not be. Delete the early return;
the loop already stops when `_pick_next` returns `None`.

**Step 6: Verify**

The ladder's own test is the walk simulation in Task 10, which is written
next. Here, check the wiring by hand:

```bash
.venv/bin/python -c "import app"
grep -n 'station.exhausted' app.py
```
Expected: import clean; `exhausted` set only in `_reserve_oldest`, cleared in
`_pick_next`, read in `station_payload`.

Then `make run-local` and play a seed — the station should extend normally,
and the log should stay free of "artist cap lifted" and "exhausted" on a
healthy walk. Seeing either on the first few tracks means a memory is
matching far too aggressively, and the fuzzy-rejection log from Task 9 is how
to find out which rule.

**Step 7: Commit**

```bash
git add app.py
git commit -m "feat(station): widen seeds before relaxing filters

The old ladder's first response to a thin pool was to drop the 7-day memory,
so a starved station repeated a song before it had tried asking YouTube a
different question. Now it reaches for an older seed, then for a song it
passed over, and only then relaxes — and its floor re-serves the song heard
longest ago rather than the most popular survivor."
```

---

## Task 8: Mark songs heard, and flush the history

`Station.add` records a song as *queued*. Nothing yet records it as *heard*,
and the distinction is load-bearing in both directions: `HISTORY_QUEUED_TTL`
(2h) expires a song the station queued but the listener never reached, and
`oldest_heard()` — the rung 6 floor — only considers songs that actually
played. Without this task the 7-day memory is a 2-hour memory and the floor
has nothing to draw from.

The station loop already polls the speaker's transport state and queue
position every tick, so it knows which track is under the cursor and whether
the speaker is playing. That is exactly the signal, and it costs no new call.

**Files:**
- `app.py` — `_mark_heard`, `_flush_history`, `_load_history`; `_station_loop`
  (1745-1775), `end_station` (1808-1830), `if __name__` (3268-3272)

**Step 1: `_mark_heard`**

```python
def _mark_heard(station):
    """Record the track under the cursor as actually played.

    Idempotent — called every tick while the speaker is PLAYING, and
    SongMemory.mark_heard is a no-op on a song already marked. That is cheaper
    than tracking which index we last marked, and correct across a jump
    backwards, where the listener really is hearing the track again.

    A track the listener skips through between two polls is never marked, and
    that is the right answer: it was not heard, so it should not be excluded
    for seven days, and it should not be a candidate for the oldest-heard
    floor.
    """
    # station.memory and station.tracks are both guarded by Station.lock, and
    # this is called from the loop *outside* the `with station.lock` block that
    # wraps _top_up — so it takes the lock itself. Order is
    # Station.lock -> _STATE_LOCK, per the Global Constraint; inverting it here
    # deadlocks against _top_up, which holds them in that order.
    with station.lock:
        if not station.tracks or not 0 <= station.index < len(station.tracks):
            return
        vid = station.tracks[station.index]['video_id']
        with _STATE_LOCK:
            station.memory.mark_heard(vid)
            _HISTORY.mark_heard(vid)
```

**Step 2: Call it from `_station_loop`**

In the `if state == 'PLAYING'` branch at `app.py:1757`, which currently only
sets `playing_seen` on the first sighting:

```python
            if state == 'PLAYING':
                if not station.playing_seen:
                    station.playing_seen = True
                    logger.info(f"Playback started on {device_ip}; prefetching ahead")
                _mark_heard(station)
```

This sits *after* the `position > 0` block that updates `station.index`, so it
marks the track the speaker is on now and not the one it was on last tick.

At the end of the tick, after `_evict`, add the debounced flush:

```python
            _flush_history()
```

**Step 3: `_flush_history`**

```python
def _flush_history(force=False):
    """Write the history to disk, at most once per HISTORY_FLUSH_INTERVAL.

    The snapshot is taken under the lock and the write happens outside it. A
    2000-entry json.dump is milliseconds, but _STATE_LOCK is also held by every
    /media range request and every scheduler dispatch, and this runs on a timer
    forever — so it is exactly the kind of small cost that becomes an audible
    stall at the wrong moment.

    `dirty` is the whole debounce: a station that queued nothing this tick has
    nothing to write, and most ticks queue nothing.
    """
    global _HISTORY_FLUSHED_AT
    now = time.time()
    with _STATE_LOCK:
        if not _HISTORY.dirty:
            return
        if not force and now - _HISTORY_FLUSHED_AT < HISTORY_FLUSH_INTERVAL:
            return
        _HISTORY_FLUSHED_AT = now
        payload = _HISTORY.snapshot()
    songs.save_history(_HISTORY_PATH, payload)
```

`snapshot()` clears `dirty` inside the lock, so a concurrent `add` landing
between the snapshot and the write sets it again and is picked up next
interval rather than being lost.

**Step 4: Flush on the way out**

`end_station` is where a session's history is most worth keeping — it fires on
`/api/stop` and on an idle timeout, both of which usually precede the process
sitting untouched. Add a forced flush *after* the `with _STATE_LOCK` block,
not inside it:

```python
    _flush_history(force=True)
```

And register an `atexit` hook beside the other startup wiring, so a `docker
stop` between flushes does not drop the last minute:

```python
atexit.register(lambda: _flush_history(force=True))
```

`atexit` does not run on `SIGKILL`, which is what `docker stop` escalates to
after its grace period — the interval flush is what bounds the loss there, and
that is why it exists as well as this.

**Step 5: Load at startup**

In the `if __name__` block at `app.py:3268`, beside `cache_scan()`:

```python
if __name__ == '__main__':
    logger.info(f"Initializing app on stream host: {STREAM_HOST} (port {PORT})")
    _log_ytdlp_version()
    cache_scan()
    _load_history()
    app.run(host='0.0.0.0', port=PORT, threaded=True)
```

```python
def _load_history():
    payload = songs.load_history(_HISTORY_PATH)
    with _STATE_LOCK:
        _HISTORY.restore(payload)
        count = len(_HISTORY)
    logger.info(f"Loaded {count} remembered songs from {_HISTORY_PATH}")
```

It runs *after* `cache_scan()` and that ordering is not incidental:
`cache_scan` sweeps stray `*.part` files from `CACHE_DIR`, which is where
`save_history` writes `history.json.part`. A crash mid-write leaves that file
behind and the existing sweep cleans it up for free — the same reason
`analysis.py` names its scratch file `<id>.pcm.part`.

**Step 6: Verify**

```bash
.venv/bin/python -m unittest discover -v
.venv/bin/python -c "import app"
```

Then the round trip by hand, which is the only thing that proves the pieces
are connected:

```bash
make run-local        # play a seed, let two or three tracks play, then stop
cat cache/history.json | python3 -m json.tool | head -30
```
Expected: one entry per track that actually played, all `"heard": true` — the
tracks queued ahead are in memory but deliberately never reach disk. Restart
and confirm the startup log reports the loaded count, and that it matches the
number of tracks you let play rather than the number the station queued.

**Step 7: Commit**

```bash
git add app.py
git commit -m "feat(station): mark songs heard, persist the history

Station.add records a song as queued; only the loop knows it was played. The
split matters twice — a queued-never-reached song expires in two hours rather
than seven days, and the exhausted floor re-serves by last-heard, which is
meaningless if nothing is ever marked heard."
```

---

## Task 9: `GET /api/history` and the rejection log

Two observability surfaces, both for the same question: *is the matcher
throwing away songs it shouldn't?*

"Rather skip than repeat" was the user's explicit choice, and the cost of that
choice is false positives — a song wrongly judged a duplicate is silently
never played, and silently is the problem. A fuzzy match is a *judgement*;
an id match is a fact. Logging only the judgements keeps the log readable and
puts exactly the reviewable decisions in it.

`/api/downloads` (`app.py:2556`) exists for the same reason on the scheduler —
without it, "politely waiting" and "wedged" look identical. Without this,
"YouTube's mixes are repetitive today" and "the overlap rule is merging two
different songs" look identical.

**Files:**
- `app.py` — `_log_reject` (fill in the Task 5 stub), `GET /api/history`
- `API.md` — documented in Task 12

**Step 1: `_log_reject`**

```python
def _log_reject(entry, reason):
    """Report a candidate dropped by a fuzzy match — never by an id match.

    An id match is the normal case and logging it would bury this. These three
    are the rules that can be wrong: 'exact' (same token set, different
    upload), 'subset' (one title contained in the other), 'overlap' (80% of
    tokens plus a duration within 5s).
    """
    logger.info(
        f"Dedupe[{reason}] dropped {entry.get('id')} "
        f"{entry.get('title')!r} by {entry.get('uploader') or entry.get('channel')!r}")
```

Passed as `on_reject` by `_pick_next`'s rungs 1-3. Rungs 4-6 do not pass it:
they are already the unusual path and they log their own line.

**Step 2: The endpoint**

```python
@app.route('/api/history')
def history():
    """What the app remembers hearing, newest first.

    Modelled on /api/downloads: read-only, no speaker call, and its purpose is
    to make an invisible decision inspectable. `limit` caps the response
    because HISTORY_MAX is 2000 and the default 100 is enough to answer 'why
    did it skip that song'.
    """
    limit = max(1, min(int(request.args.get('limit', 100)), HISTORY_MAX))
    now = time.time()
    with _STATE_LOCK:
        entries = _HISTORY.entries()
        total = len(_HISTORY)
    entries.sort(key=lambda e: e.last_at, reverse=True)
    return jsonify({
        'total': total,
        'version': songs.HISTORY_VERSION,
        'ttl': HISTORY_TTL,
        'max': HISTORY_MAX,
        'songs': [
            {
                'id': e.best_id(),
                'ids': sorted(e.ids, key=lambda v: e.ids[v]),
                'title': e.title,
                'artist': e.artist,
                'duration': e.duration,
                'heard': e.heard,
                'age': round(now - e.last_at, 1),
            }
            for e in entries[:limit]
        ],
    })
```

`ids` is the list that makes a false positive visible: two genuinely different
songs merged into one entry show up as one row carrying both video ids, and
`title` names only the first. That is the single most useful field here.

`entries()` returns a fresh list built under the lock; the sort happens outside
it because sorting 2000 entries under `_STATE_LOCK` is the thing this endpoint
should not do to the speaker.

**Step 3: Verify**

```bash
curl -s localhost:5001/api/history | python3 -m json.tool | head -40
curl -s 'localhost:5001/api/history?limit=5' | python3 -m json.tool
curl -s 'localhost:5001/api/history?limit=abc'
```
Expected: the first two return sorted songs; the third returns a 400 from the
existing error handling rather than a 500 — if it does not, wrap the `int()`
the way the other endpoints do.

**Step 4: Commit**

```bash
git add app.py
git commit -m "feat(api): expose the song memory and log fuzzy rejections

'Rather skip than repeat' pays for fewer repeats with false positives, and a
false positive is a song that silently never plays. The endpoint's `ids` list
is where two different songs merged into one entry become visible; the log
records only the three rules that can be wrong, never an id match."
```

---

## Task 10: The 50-track walk

Every test so far checks one rule in isolation. The defect this plan exists to
fix was never in one rule — it was in how three of them composed over a
session. So the last test drives the real `_pick_next` through fifty picks
against fixture mixes and asserts the two properties a listener would actually
notice.

This is the test that would have caught the original bug. `_title_key`,
`_artist_key` and `_remember` each passed their own reading; what failed was a
station that played Dua Lipa's "Levitating" from a Topic channel twenty
minutes after playing it from her own.

**Files:**
- `testdata/mix_walk/*.json` — one file per seed id
- `test_station.py` — new; `TestWalk`

**Step 1: Build the fixtures**

Capture real mixes rather than inventing them, because the property under test
is about YouTube's actual overlap between adjacent mixes — invented fixtures
would encode my guess about that and pass trivially.

```bash
.venv/bin/python - <<'EOF'
import json, os, app
os.makedirs('testdata/mix_walk', exist_ok=True)
seeds = ['dQw4w9WgXcQ']           # one seed; the walk discovers the rest
seen = set()
while seeds and len(seen) < 12:
    sid = seeds.pop(0)
    if sid in seen:
        continue
    seen.add(sid)
    mix = app.get_radio_mix(sid)
    json.dump(mix, open(f'testdata/mix_walk/{sid}.json', 'w'), indent=1)
    seeds.extend(e['id'] for e in mix[:6])
print(len(seen), 'mixes')
EOF
```

Twelve mixes is enough for a 50-track walk to run out of rung-1 candidates at
least once, which is the point — a walk that never reaches rung 2 tests half
the ladder.

Commit the fixtures. They are a few hundred KB and they are the only way this
test runs offline; regenerating them on every CI run would make the suite
depend on YouTube, which is the dependency all of this is trying to bound.

**Step 2: Write the test**

```python
FIXTURES = os.path.join(os.path.dirname(__file__), 'testdata', 'mix_walk')
SEED = 'dQw4w9WgXcQ'     # the id the capture script above was seeded with


class TestWalk(unittest.TestCase):
    """Fifty picks through the real ladder, against captured mixes."""

    def _fetch(self, seed, refresh=False):
        # Unknown seed -> empty mix, which is what YouTube does for a video
        # with no autoplay list. The ladder must survive it.
        path = os.path.join(FIXTURES, f'{seed}.json')
        if not os.path.exists(path):
            return []
        with open(path) as fh:
            return json.load(fh)

    def _walk(self, n=50):
        random.seed(1234)          # the walk is random; the test must not be
        station = app.Station('10.0.0.1', SEED)
        station.add({'id': SEED, 'title': 'Rick Astley - Never Gonna Give You Up',
                     'uploader': 'Rick Astley', 'duration': 213})
        picked = []
        for _ in range(n):
            entry = app._pick_next(station, fetch=self._fetch)
            if entry is None:
                break
            station.add(entry)
            # Advance the cursor BEFORE marking: _mark_heard reads
            # station.tracks[station.index], so marking first would record the
            # *previous* track every time and leave the newest one unheard.
            station.index = len(station.tracks) - 1
            app._mark_heard(station)      # simulate the speaker reaching it
            picked.append(entry)
        return station, picked
```

- [ ] `test_no_song_repeats` — attribute every picked entry and assert no two share a `SongMemory` match. This is the whole point of the plan and it is stated as a property, not as a list of expected ids, because the ids depend on the fixtures.
- [ ] `test_no_id_repeats` — the weaker version, asserted separately so a failure distinguishes "the fuzzy matcher missed one" from "the exact check broke".
- [ ] `test_walk_completes` — fifty picks, no `None`. With the rung 6 floor a station with history always returns something, so an early stop is a bug in the ladder rather than an exhausted pool.
- [ ] `test_no_adjacent_same_artist` — no two consecutive picks share an artist while `station.exhausted` is False. Deliberately *not* "no artist exceeds `MAX_TRACKS_PER_ARTIST` across the walk": the cap is per pool, and the round-robin only promises separation between neighbours. Asserting the stronger property would be asserting something the code does not claim, and it would fail for the right reasons.
- [ ] `test_not_exhausted_early` — `station.exhausted` is False for the first 25 picks. Reaching the repeat floor a quarter of the way into a session means the matcher is over-matching.
- [ ] `test_deterministic_under_seeded_rng` — two walks with the same `random.seed` produce identical output. This is what makes a failure reproducible; it is not a claim that production is deterministic, which Task 7 deliberately prevents.
- [ ] `test_diverges_without_the_seed` — two walks with different seeds share fewer than 80% of their picks. The inverse assertion, and the one that pins defect 5: before this plan, two stations from one seed walked identically.
- [ ] `test_empty_mixes_reach_the_floor` — with a fetcher returning `[]` for everything, the walk still yields entries (rung 6) and `exhausted` is True.

**Step 3: Run**

```bash
.venv/bin/python -m unittest test_station -v
```
Expected: PASS, and in under a couple of seconds — no network, no sleep.

If `test_not_exhausted_early` fails, the matcher is too aggressive: run the
walk with `_log_reject` at DEBUG and read which reason dominates. `'overlap'`
dominating means `MATCH_OVERLAP` (0.8) is too low for these titles;
`'subset'` dominating means `MATCH_MIN_SUBSET_TOKENS` (2) is too low and short
titles are swallowing longer ones.

**Step 4: Commit**

```bash
git add testdata/mix_walk test_station.py
git commit -m "test(station): fifty-pick walk over captured mixes

The original defect was not in any one rule — each of _title_key, _artist_key
and _remember read correctly on its own. It was in how they composed across a
session, which is the only place a test can find it."
```

---

## Task 11: Surface `exhausted` in the UI

`station_payload` already returns `"exhausted"` (`app.py:2135-2151`),
`web/src/lib/api/types.ts:192` already declares it, and every station fixture
in the frontend tests already sets it. Nothing reads it.

Its meaning changes in this plan — from "the station gave up" to "the station
is replaying songs you've already heard" — and the second one is worth saying
out loud, because the symptom otherwise is a listener noticing repeats and
concluding the app is broken. It is not broken; it has run out of new songs
for this taste and is degrading the way the user asked it to.

**Files:**
- `web/src/lib/queue.ts` — add `describeExhausted`
- `web/src/lib/queue.test.ts` — add its tests
- `web/src/components/queue-panel.tsx` — render it

**Interfaces:**

```typescript
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
): string | null;
```

**Step 1: Write the tests**

- [ ] `returns null for a healthy station` — `exhausted: false` → `null`.
- [ ] `returns null for no station` — `null` and `undefined` both, since the panel renders before the first SSE frame.
- [ ] `explains a repeating station` — `exhausted: true` → a string mentioning repeats. Assert on the exported constant, not on a literal, so the copy can change without touching the test.

**Step 2: Run to verify they fail**

Run: `cd web && pnpm test`
Expected: FAIL — `describeExhausted is not a function`

**Step 3: Implement**

```typescript
export const EXHAUSTED =
  "Out of new songs for this station — replaying ones you've heard, oldest first.";

export function describeExhausted(
  station: StationBody | null | undefined,
): string | null {
  return station?.exhausted ? EXHAUSTED : null;
}
```

The copy says what the app is doing and why, in that order. "Oldest first" is
in it because it is the difference between a listener thinking the shuffle is
broken and understanding that the station ran out.

**Step 4: Render it**

In `queue-panel.tsx`, above the `upcoming` section — it explains the rows
below it, so it belongs above them, and it sits inside the queue panel rather
than as a global toast because it is a property of this station and it should
persist while true rather than flash once.

**Step 5: Verify**

```bash
cd web && pnpm test && pnpm typecheck && pnpm lint
```
Expected: all three green. All four gates are expected to stay green per
`CLAUDE.md`; `pnpm build` too if anything in the component tree changed shape.

**Step 6: Commit**

```bash
git add web/src/lib/queue.ts web/src/lib/queue.test.ts web/src/components/queue-panel.tsx
git commit -m "feat(web): say when a station has run out of new songs

The backend has reported `exhausted` all along and nothing read it. Now that
it means 'replaying, oldest first' rather than 'stopped', it is the difference
between a listener thinking the app is broken and knowing it ran out."
```

---

## Task 12: Documentation

`CLAUDE.md` currently contains a section called **"Why the queue used to repeat
itself"** that explains `_RECENT`, `_pick_next`'s three-rung ladder and
`played_ids` / `played_titles` in detail. After Task 5 every symbol it names is
gone. A document that confidently describes deleted code is worse than no
document — the next reader trusts it and looks for functions that don't exist.

**Files:**
- `API.md` — `/api/history`, `exhausted`'s new meaning
- `CLAUDE.md` — rewrite "Why the queue used to repeat itself"; cache layout;
  the backend test command

**Step 1: `API.md`**

- [ ] Add `GET /api/history` — the response shape from Task 9, the `limit`
      parameter, and one sentence on what `ids` is for (two video ids on one
      row means the matcher merged them; that is how you spot a false
      positive).
- [ ] Update `/api/station`'s `exhausted` field. It is documented as the
      station having stopped; it now means the station is re-serving songs
      already heard, oldest first, and is still producing tracks. A client
      reading the old meaning would show "nothing is playing" while music
      plays.

**Step 2: `CLAUDE.md` — rewrite the repeat section**

Replace it entirely. The new version should say, in the same register as the
rest of that file — *why*, not *what*:

- Song identity lives in `songs.py` and is `(artist, token set)` with a
  duration corroboration, not a normalized title. The old `_title_key` ignored
  the uploader, so two artists' "Alone" were one song and blocked each other
  globally for 12 hours; `_artist_key` preferred `channel_id`, which made its
  Topic-stripping unreachable, so a Topic upload and an artist upload were
  different artists and the same song played twice.
- Two memories, one matcher. `Station.memory` has no TTL and no cap because a
  session must never repeat itself however long it runs; `_HISTORY` has both
  because it outlives every station and persists to `history.json`.
  `build_station_queue` uses a third, throwaway one as its within-pool
  accumulator — which is what makes "two uploads of one song" and "a song I
  played on Tuesday" the same comparison rather than two that can drift.
- Queued is not heard. A song the station queued but the speaker never reached
  expires in `HISTORY_QUEUED_TTL` (2h); one the loop saw playing lasts
  `HISTORY_TTL` (7d). Only heard songs are candidates for the repeat floor.
- The ladder widens seeds before it relaxes rules, and the order is the point:
  three different seed pools, then the 7-day memory, then the artist cap, and
  only at the floor a repeat — least-recently-heard, because the old floor took
  the best-surviving candidate, which is mix-relevance ordered, which tracks
  popularity, so the first repeat was the most recognisable song in the
  session.
- Randomness is deliberate and load-bearing. `_pick_next` draws from the top
  `STATION_PICK_POOL`, `_reseed_ids` and `_widen_seed` pick at random. A
  reproducible walk means two stations from one seed play the same songs in
  the same order, which was defect 5.

**Step 3: `CLAUDE.md` — the two smaller corrections**

- [ ] **Cache layout.** The section lists `<id>.mp3`, `<id>.json`, `<id>.jpg`,
      `<id>.beats.json` and `hue.json`. Add `history.json` — not audio, never
      evicted, and it survives for the same stated reason `hue.json` does:
      `cache_scan` and `_evict` match on suffix rather than deleting what they
      don't recognise. Note that its `.part` scratch file is swept by the same
      startup sweep, which is why it is named that way.
- [ ] **The test command.** The file says the backend has "one test file" and
      gives `.venv/bin/python -m unittest test_hue`, adding that a second file
      means `discover` and nothing else. There are now three. Change it to
      `.venv/bin/python -m unittest discover -v` and say what each file covers:
      `test_hue` the bridge JSON and `HueSession`'s ordering, `test_songs` the
      matcher and the queue builder, `test_station` the fifty-pick walk.

**Step 4: Verify**

```bash
grep -n '_title_key\|_artist_key\|_RECENT\|played_titles\|played_ids' CLAUDE.md API.md
```
Expected: empty. That grep is the actual check — every one of those names is a
symbol the code no longer has.

**Step 5: Commit**

```bash
git add API.md CLAUDE.md
git commit -m "docs: rewrite the dedupe section for songs.py

Every symbol 'Why the queue used to repeat itself' named is now deleted, and
a document that confidently describes code that isn't there costs more than
no document. Also corrects exhausted's meaning, the cache layout and the
backend test command, which now needs discover."
```

---

## Verification

After every task, in order:

```bash
.venv/bin/python -m unittest discover -v     # test_hue, test_songs, test_station
.venv/bin/python -c "import app"
cd web && pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

The frontend gates are expected green throughout — only Task 11 touches
`web/`, and the `exhausted` field it reads was already in the types and the
fixtures.

The end-to-end check, which no test replaces:

```bash
make run-local
# play a seed; let it run through 8-10 tracks
curl -s localhost:5001/api/history | python3 -m json.tool | head -40
grep 'Dedupe\[' <the app log>
```

Read the rejection lines. Every one is a song the app decided not to play, and
"rather skip than repeat" means some of them will be wrong. A handful of
`exact` rejections is the system working — those are duplicate uploads. A
stream of `overlap` rejections naming songs that are obviously different means
`MATCH_OVERLAP` needs raising, and that is a one-line change because the spec
put all five tunables behind env vars for exactly this.

---

## Spec coverage

Each of the spec's five live defects, and where it dies:

| Spec defect | Task |
|---|---|
| 1. Topic upload and artist upload are different songs | 1 (fold the channel into the artist), 2 (the matcher), 4 (collapse the pool) |
| 2. Two artists' "Alone" are one song | 2 (artist bucketing — a match is only ever sought within one artist) |
| 3. `_artist_key` prefers `channel_id`, so cap and cooldown count double | 5 (deleted) |
| 4. Nothing survives a restart | 3 (snapshot/restore), 8 (flush and load) |
| 5. Pool narrower than the exclusions it feeds | 6 (`MIX_LIMIT` 50, deduped, bounded cache) |
| "None of this is covered by a test" | 1, 2, 3, 4 (unit), 10 (the walk) |

And the design decisions the user made, none of which follow from the defects:

| Decision | Task |
|---|---|
| "Any version except covers" | 2 — a different artist never enters the same bucket, so a cover is never a match |
| "Rather skip than repeat" | 2 (`subset` and `overlap` rules), 9 (the log that makes their false positives visible) |
| "Fetch new seeds" before relaxing | 7 (rungs 2 and 3 precede rungs 4 and 5) |
| "7 days heard, capped" | 3, 8 |
| "Pick the audio version" | 1 (`version_rank`), 4 (`best_id`) |
| "Oldest-first repeat" | 7 (`_reserve_oldest`), 11 (saying so) |
