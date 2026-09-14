"""Fifty-pick walk through the real ladder against captured mixes.

Every test so far checks one rule in isolation. The defect this plan exists to
fix was never in one rule — it was in how three of them composed over a
session. So these tests drive the real `_pick_next` through fifty picks
against fixture mixes and assert the two properties a listener would actually
notice.

This is the test that would have caught the original bug. `_title_key`,
`_artist_key` and `_remember` each passed their own reading; what failed was a
station that played Dua Lipa's "Levitating" from a Topic channel twenty
minutes after playing it from her own.
"""
import hashlib
import json
import logging
import os
import random
import unittest

import app
import songs

FIXTURES = os.path.join(os.path.dirname(__file__), 'testdata', 'mix_walk')
SEED = 'dQw4w9WgXcQ'     # the id the capture script was seeded with

# Load fixtures once at module level for efficiency.
_NAMES = sorted(f[:-5] for f in os.listdir(FIXTURES) if f.endswith('.json'))
_CACHE = {n: json.load(open(os.path.join(FIXTURES, n + '.json'))) for n in _NAMES}


class TestWalk(unittest.TestCase):
    """Fifty picks through the real ladder, against captured mixes."""

    def setUp(self):
        # Guard against network calls: the walk must run from fixtures only.
        def _boom(*a, **k):
            raise AssertionError('the walk must not hit the network')
        self._real_mix = app.get_radio_mix
        app.get_radio_mix = _boom
        self.addCleanup(lambda: setattr(app, 'get_radio_mix', self._real_mix))

        # Isolation: reset the process-wide _HISTORY so tests don't interfere.
        # Ruling A: rebind the name so _pick_next sees the fresh instance.
        self._real_history = app._HISTORY
        self.addCleanup(lambda: setattr(app, '_HISTORY', self._real_history))

    def _fetch(self, seed, refresh=False):
        """A captured mix for `seed`, or a stand-in for an uncaptured one.

        YouTube returns an autoplay mix for virtually every music video, so an
        empty list is the wrong stand-in: it starves the ladder and drives the walk
        onto rung 6 for reasons that are about our fixture set, not about the code.
        The fallback is keyed on a stable hash — hash() is salted per process and
        would break test_deterministic_under_seeded_rng across runs.
        """
        if seed in _CACHE:
            return _CACHE[seed]
        h = int(hashlib.md5(seed.encode()).hexdigest(), 16)
        return _CACHE[_NAMES[h % len(_NAMES)]]

    def _walk(self, n=50, seed=1234, fetch=None):
        # Ruling A: reset _HISTORY at the top of every walk, not only in setUp,
        # because some tests call _walk twice.
        app._HISTORY = songs.SongMemory(ttl=app.HISTORY_TTL,
                                        queued_ttl=app.HISTORY_QUEUED_TTL,
                                        max_songs=app.HISTORY_MAX)
        random.seed(seed)
        # Ruling B: second arg is generation counter, not seed id.
        station = app.Station('10.0.0.1', 0)
        station.add({'id': SEED, 'title': 'Rick Astley - Never Gonna Give You Up',
                     'uploader': 'Rick Astley', 'duration': 213})
        # Ruling D: the seed is what the speaker is playing, so it is heard.
        station.index = 0
        app._mark_heard(station)

        picked = []
        for _ in range(n):
            # Ruling C: capture exhausted and cap_lifted per pick.
            with self.assertLogs(app.logger, level='INFO') as cap:
                app.logger.info('walk-tick')  # assertLogs needs >=1 record
                entry = app._pick_next(station, fetch=fetch or self._fetch)
            if entry is None:
                break
            cap_lifted = any('artist cap lifted' in m for m in cap.output)
            station.add(entry)
            # Advance the cursor BEFORE marking: _mark_heard reads
            # station.tracks[station.index].
            station.index = len(station.tracks) - 1
            app._mark_heard(station)
            picked.append({'entry': entry,
                           'exhausted': station.exhausted,
                           'cap_lifted': cap_lifted})
        return station, picked

    def test_no_song_repeats(self):
        """No two picks share a SongMemory match, while not exhausted.

        This is the whole point of the plan. Rung 6 repeats by design, so we
        only assert over picks made while the station was not exhausted.

        The oracle is independent of the matcher: songs._match implements the
        fuzzy subset/overlap rules, and those are test_songs.py's job. This
        test's job is the identity model composing across a session, so the
        oracle checks exact (artist, tokens) pairs only.
        """
        station, picked = self._walk()
        # Only test picks made while not exhausted (Ruling C).
        non_exhausted = [p for p in picked if not p['exhausted']]
        attributed = [songs.attribute(p['entry']) for p in non_exhausted]
        # Build an independent oracle: exact (artist, tokens) pairs.
        seen = set()
        for song in attributed:
            key = (song.artist, song.tokens)
            self.assertNotIn(
                key, seen,
                f"Song repeated: {song.title!r} by {song.artist!r} "
                f"with tokens {sorted(song.tokens)}"
            )
            seen.add(key)

    def test_no_id_repeats(self):
        """No two picks share a video_id, while not exhausted.

        The weaker version, asserted separately so a failure distinguishes
        "the fuzzy matcher missed one" from "the exact check broke".
        """
        station, picked = self._walk()
        non_exhausted = [p for p in picked if not p['exhausted']]
        ids = [p['entry']['id'] for p in non_exhausted]
        self.assertEqual(len(ids), len(set(ids)), "Duplicate IDs found")

    def test_walk_completes(self):
        """Fifty picks, no None.

        With the rung 6 floor a station with history always returns something,
        so an early stop is a bug in the ladder rather than an exhausted pool.
        """
        station, picked = self._walk()
        self.assertEqual(len(picked), 50)

    def test_no_adjacent_same_artist(self):
        """No two consecutive picks share an artist while not exhausted or cap-lifted.

        Rung 5 lifts the artist cap and drops cooldown_artists, so it can
        legitimately return the same artist twice in a row while exhausted is
        still False. We must exclude cap-lifted picks too (Ruling C).
        """
        station, picked = self._walk()
        for i in range(1, len(picked)):
            prev = picked[i - 1]
            curr = picked[i]
            # Only check when neither pick was exhausted or cap-lifted.
            if prev['exhausted'] or prev['cap_lifted']:
                continue
            if curr['exhausted'] or curr['cap_lifted']:
                continue
            prev_artist = songs.attribute(prev['entry']).artist
            curr_artist = songs.attribute(curr['entry']).artist
            self.assertNotEqual(
                prev_artist, curr_artist,
                f"Adjacent same artist at picks {i-1},{i}: {prev_artist!r}"
            )

    def test_not_exhausted_early(self):
        """station.exhausted is False for the first 25 picks.

        Reaching the repeat floor a quarter of the way into a session means
        the matcher is over-matching.
        """
        station, picked = self._walk()
        for i, p in enumerate(picked[:25]):
            self.assertFalse(
                p['exhausted'],
                f"Station exhausted too early at pick {i}"
            )

    def test_deterministic_under_seeded_rng(self):
        """Two walks with the same random.seed produce identical output.

        This is what makes a failure reproducible; it is not a claim that
        production is deterministic, which Task 7 deliberately prevents.
        """
        station_a, picked_a = self._walk(seed=1234)
        station_b, picked_b = self._walk(seed=1234)
        ids_a = [p['entry']['id'] for p in picked_a]
        ids_b = [p['entry']['id'] for p in picked_b]
        self.assertEqual(ids_a, ids_b)

    def test_diverges_without_the_seed(self):
        """Two walks with different seeds produce different orderings.

        The inverse assertion, and the one that pins defect 5: before this
        plan, two stations from one seed walked identically.

        Set overlap is rejected as a metric (measured at 72-84% over five RNG
        seeds) because it is forced by the fixture pool — 192 distinct songs,
        50 picks — and is a property of the fixtures, not the code. Defect 5
        was that two walks were identical, which is a claim about order.
        """
        station_a, picked_a = self._walk(seed=1234)
        station_b, picked_b = self._walk(seed=5678)
        ids_a = [p['entry']['id'] for p in picked_a]
        ids_b = [p['entry']['id'] for p in picked_b]
        # Assert the walks are not identical.
        self.assertNotEqual(ids_a, ids_b, "Walks are identical")
        # Assert same-position agreement is low (measured max 6%).
        agreement = sum(1 for a, b in zip(ids_a, ids_b) if a == b)
        self.assertLess(
            agreement, 0.25 * len(ids_a),
            f"Walks too similar: {agreement}/{len(ids_a)} same-position matches "
            f"({100*agreement/len(ids_a):.1f}%)"
        )

    def test_empty_mixes_reach_the_floor(self):
        """With a fetcher returning [] for everything, the walk still yields entries.

        Rung 6 re-serves the oldest heard song, and exhausted is True.
        """
        def empty_fetch(seed, refresh=False):
            return []

        station, picked = self._walk(n=5, fetch=empty_fetch)
        # The walk should still produce picks (from rung 6).
        self.assertGreater(len(picked), 0, "Walk yielded nothing with empty mixes")
        # All picks from an empty fetcher should be exhausted.
        for i, p in enumerate(picked):
            self.assertTrue(
                p['exhausted'],
                f"Pick {i} not marked exhausted with empty mixes"
            )


class TestExhaustedFlag(unittest.TestCase):
    """Exhausted flag ownership: _pick_next sets it, _top_up must preserve it.

    The defect this guards against: _pick_next rung 6 (_reserve_oldest) sets
    station.exhausted = True and returns a valid entry (the oldest-first repeat),
    but _top_up then overwrote it with False unconditionally, so the flag only
    ever appeared True when _pick_next returned None — which the rung 6 floor
    made nearly unreachable.
    """

    def setUp(self):
        # Stub ensure_cached to a no-op: _top_up calls it on every entry it gets.
        self._real_ensure = app.ensure_cached
        app.ensure_cached = lambda *a, **k: None
        self.addCleanup(lambda: setattr(app, 'ensure_cached', self._real_ensure))

        # Constrain the loop to one iteration.
        self._real_batch = app.TOPUP_BATCH
        app.TOPUP_BATCH = 1
        self.addCleanup(lambda: setattr(app, 'TOPUP_BATCH', self._real_batch))

    def test_preserves_exhausted_when_pick_next_sets_it(self):
        """_top_up must not overwrite station.exhausted when _pick_next sets it.

        This is rung 6's contract: set exhausted = True, return a valid entry
        (the oldest-first repeat). _top_up's line 1742 used to unconditionally
        reset it to False, breaking the flag.
        """
        # Stub _pick_next to simulate rung 6: set exhausted, return an entry.
        def mock_pick(station, refresh=False, fetch=None):
            station.exhausted = True
            return {'id': 'test_vid', 'title': 'Test Song',
                    'uploader': 'Test Artist', 'duration': 180}

        self._real_pick = app._pick_next
        app._pick_next = mock_pick
        self.addCleanup(lambda: setattr(app, '_pick_next', self._real_pick))

        # Ruling B: second arg is generation counter, not seed id.
        station = app.Station('10.0.0.1', 0)
        station.exhausted = False

        # Call _top_up — it should preserve the exhausted flag _pick_next set.
        app._top_up(station)

        # Assert: station.exhausted must still be True after _top_up.
        self.assertTrue(
            station.exhausted,
            "_top_up overwrote exhausted flag that _pick_next set"
        )


if __name__ == '__main__':
    unittest.main()
