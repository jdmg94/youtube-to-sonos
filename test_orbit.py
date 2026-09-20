"""Does the station stay near the song the listener picked?

Every other station test asks whether the queue repeats itself. None of them
can ask this one, because none has any ground truth for "how far from the seed
is this track" — `test_station.py` fetches a hash-chosen arbitrary mix for any
seed it has not captured, which is 60% of the fetches in its own fifty-pick
walk, so the graph it walks is mostly invented. Four separate fixes for station
drift shipped against that suite, green.

The fixtures here are a real radius-2 capture (`capture_orbit.py`): the
anchor's RD mix, plus the RD mix of every track in it. That is enough to label
any candidate with its distance from the seed, which makes the property
assertable.

The load-bearing detail is `strict_fetch`, which **raises** for an uncaptured
seed rather than substituting something. "The walk asked for a mix outside the
captured orbit" is exactly "the walk left radius 2", so the drift this file
exists to prevent fails the suite without an assertion being written for it.
"""
import collections
import json
import os
import random
import unittest

import app
import songs

ORBIT = os.path.join(os.path.dirname(__file__), 'testdata', 'orbit')
WALK = 50


class OutsideOrbit(AssertionError):
    """The walk asked for the mix of a track we never captured.

    Raised rather than handled: an uncaptured seed is a seed more than two hops
    from the anchor, which is the failure this whole file is about.
    """


class Orbit:
    """One captured seed neighbourhood, and the distances it defines."""

    def __init__(self, seed):
        self.seed = seed
        root = os.path.join(ORBIT, seed)
        self.mixes = {}
        for name in os.listdir(root):
            if name.endswith('.json'):
                with open(os.path.join(root, name)) as f:
                    self.mixes[name[:-5]] = json.load(f)
        self.radius1 = [e['id'] for e in self.mixes[seed] if e.get('id')]
        self.radius1_ids = set(self.radius1)
        self.all_ids = set(self.radius1_ids)
        for vid in self.radius1:
            for e in self.mixes.get(vid, []):
                if e.get('id'):
                    self.all_ids.add(e['id'])

    def radius(self, video_id):
        """1, 2, or None for a track outside the captured orbit."""
        if video_id in self.radius1_ids:
            return 1
        return 2 if video_id in self.all_ids else None

    def core(self, threshold=0.3):
        """Ids appearing in at least `threshold` of the captured mixes.

        This is the operational definition of a "dense, mutually-reinforcing
        cluster" — the thing CLAUDE.md blames for a session orbiting one sound.
        A song listed by a third of the neighbourhood's mixes is one the graph
        keeps pointing back at, and a walk with no restoring force accumulates
        in exactly that set.

        Measured as a share of picks against its share of the orbit, so the
        same assertion is meaningful for a broad seed (small core) and a
        cluster seed (large core) without a per-seed constant.
        """
        counts = collections.Counter()
        for entries in self.mixes.values():
            for vid in {e['id'] for e in entries if e.get('id')}:
                counts[vid] += 1
        need = threshold * len(self.mixes)
        return {v for v, n in counts.items() if n >= need}


def strict_fetch(orbit):
    """A fetcher that refuses to invent an edge. See the module docstring."""
    def fetch(seed, refresh=False):
        if seed not in orbit.mixes:
            raise OutsideOrbit(
                f"the walk asked for the mix of {seed}, which is more than "
                f"two hops from the anchor {orbit.seed}")
        return orbit.mixes[seed]
    return fetch


def calibration_fetch(orbit, missed):
    """Records out-of-orbit seeds instead of raising, and returns nothing.

    Only for measuring the *current* code, which leaves the orbit almost
    immediately: `strict_fetch` would stop that walk at its first pick, which
    proves the radius assertion but leaves the concentration and fidelity
    numbers unmeasured. Not used by any committed assertion.
    """
    def fetch(seed, refresh=False):
        if seed not in orbit.mixes:
            missed.append(seed)
            return []
        return orbit.mixes[seed]
    return fetch


def walk(orbit, fetch, n=WALK, rng=1234):
    """Drive `n` picks through the real ladder. Returns the picked entries."""
    app._HISTORY = songs.SongMemory(ttl=app.HISTORY_TTL,
                                    queued_ttl=app.HISTORY_QUEUED_TTL,
                                    max_songs=app.HISTORY_MAX)
    random.seed(rng)
    station = app.Station('10.0.0.1', 0)
    # The anchor is what this whole design turns on. Set before the seed is
    # added so nothing can read a half-built station.
    station.anchor = orbit.seed
    seed_entry = next(e for e in orbit.mixes[orbit.seed]
                      if e['id'] == orbit.seed)
    station.add(dict(seed_entry))
    station.index = 0
    app._mark_heard(station)

    picked = []
    for _ in range(n):
        entry = app._pick_next(station, fetch=fetch)
        if entry is None:
            break
        station.add(entry)
        station.index = len(station.tracks) - 1
        app._mark_heard(station)
        picked.append(entry)
    return station, picked


class OrbitTestCase(unittest.TestCase):
    """Shared setup: isolate the process-wide history, name the seed."""

    seed = None

    @classmethod
    def setUpClass(cls):
        if cls.seed is None:
            raise unittest.SkipTest('abstract base')
        if not os.path.isdir(os.path.join(ORBIT, cls.seed)):
            raise unittest.SkipTest(
                f'no corpus for {cls.seed}; run capture_orbit.py {cls.seed}')
        cls.orbit = Orbit(cls.seed)

    def setUp(self):
        def boom(*a, **k):
            raise AssertionError('the walk must not hit the network')
        real = app.get_radio_mix
        app.get_radio_mix = boom
        self.addCleanup(lambda: setattr(app, 'get_radio_mix', real))
        real_history = app._HISTORY
        self.addCleanup(lambda: setattr(app, '_HISTORY', real_history))

    # --- the four properties ------------------------------------------------

    def test_never_leaves_the_orbit(self):
        """Assertion 1: every pick is within two hops of the anchor.

        Absolute, not a quality threshold — a candidate at radius 3 means some
        code path seeded a mix from the walk instead of from the seed, which is
        the defect itself rather than a symptom of it.
        """
        station, picked = walk(self.orbit, strict_fetch(self.orbit))
        self.assertEqual(len(picked), WALK, 'the walk stopped early')
        for i, entry in enumerate(picked):
            self.assertIsNotNone(
                self.orbit.radius(entry['id']),
                f"pick {i} ({entry.get('title')!r}) is outside radius 2 of "
                f"the anchor")

    def test_most_picks_come_from_the_seeds_own_mix(self):
        """Assertion 2: at least 70% of the walk is radius 1.

        Not 50%, which was the first guess and is worthless: the old code
        scores 42-52% (broad) and 48-58% (cluster) over 25 RNG seeds, so a
        50% line sits *inside* the baseline spread and would pass or fail on
        the seed rather than on the behaviour.

        70% is above every one of those 50 baseline runs and is what the
        design owes: rung 1 is the anchor's own mix on every call, so radius 2
        should appear only when the anchor's 50 tracks are genuinely spent.
        """
        station, picked = walk(self.orbit, strict_fetch(self.orbit))
        r1 = sum(1 for e in picked if self.orbit.radius(e['id']) == 1)
        self.assertGreaterEqual(
            r1, 0.7 * len(picked),
            f"only {r1}/{len(picked)} picks came from the anchor's own mix")

    def test_no_artist_dominates(self):
        """Assertion 3: no artist exceeds 16% of the walk.

        **This is a guard rail, not a reproduction, and the difference
        matters.** The old code already passes it: 4-6% (broad) and 6-12%
        (cluster) over 25 RNG seeds. It cannot reproduce the reported
        "single artist's discography" because that symptom lives at radius 3
        and beyond, where a walk falls into a cluster and rung 5 lifts the
        artist cap — and a radius-2 fixture cannot contain radius-3
        behaviour. Assertion 4 is what measures that symptom at the level
        this corpus can see.

        So the number here is chosen to sit just above the worst baseline run
        (12%) rather than to fail today. It can only fire if a change makes
        artist concentration *worse* than the code being replaced, which is a
        live risk given the fix raises STATION_PICK_POOL and rewrites when
        the cap comes off.
        """
        station, picked = walk(self.orbit, strict_fetch(self.orbit))
        counts = collections.Counter(songs.attribute(e).artist for e in picked)
        artist, n = counts.most_common(1)[0]
        self.assertLessEqual(
            n, 0.16 * len(picked),
            f"{artist!r} took {n}/{len(picked)} picks: {counts.most_common(5)}")

    def test_the_dense_core_does_not_capture_the_walk(self):
        """Assertion 4: the core's share of picks is at most twice its share
        of the orbit.

        A ratio rather than an absolute: a core that genuinely is half the
        orbit *should* be about half the picks. Capture means
        over-representation relative to what was available, which is what a
        walk with no restoring force produces and what a fixed orbit prevents.

        This is the assertion that reproduces the bug report. Baseline over
        25 RNG seeds is 4.8-6.4x (broad) and 6.0-8.3x (cluster) — the dense
        core is 7-9% of the orbit and takes 52% of the picks, in both
        corpora, on every run. 2x leaves a factor of 2.4 below the *best*
        baseline run, so it is a line about behaviour and not about the seed.
        """
        core = self.orbit.core()
        available = len(core) / len(self.orbit.all_ids)
        station, picked = walk(self.orbit, strict_fetch(self.orbit))
        taken = sum(1 for e in picked if e['id'] in core) / len(picked)
        self.assertLessEqual(
            taken, 2 * available,
            f"the dense core is {available:.0%} of the orbit but took "
            f"{taken:.0%} of the picks")

    # --- the defect that four fixes missed ----------------------------------

    def test_a_non_primary_pool_is_reachable_by_choose(self):
        """A second pool's tracks must be able to win a pick.

        `_choose` samples `queue[:STATION_PICK_POOL]`, and
        `build_station_queue` preserves the order of `entries` — so a pool
        concatenated second lands behind every artist of the first and is
        unreachable. Measured on the old design: a second seed reached the
        sampled window in 3 of 132 mix pairs, putting the anchor's real
        influence near 0.77%.

        This asserts on queue *position*, which is the thing that was broken.
        `test_station.py`'s anchor test asserts the seeding function returns
        the anchor, and passed throughout.
        """
        ids = [v for v in self.orbit.radius1 if v != self.orbit.seed]
        first, second = self.orbit.mixes[ids[0]], self.orbit.mixes[ids[1]]
        first_ids = {e['id'] for e in first}
        only_second = {e['id'] for e in second} - first_ids
        self.assertTrue(only_second, 'fixture mixes are identical')

        queue = songs.build_station_queue(
            list(first) + list(second),
            [songs.SongMemory(ttl=None, queued_ttl=None, max_songs=None)],
            max_per_artist=app.MAX_TRACKS_PER_ARTIST)
        window = queue[:app.STATION_PICK_POOL]
        self.assertTrue(
            any(e['id'] in only_second for e in window),
            f"no track unique to the second pool is within the sampled "
            f"window of {app.STATION_PICK_POOL}; the first unique one is at "
            f"position "
            f"{next(i for i, e in enumerate(queue) if e['id'] in only_second)}")


class TestBroadSeed(OrbitTestCase):
    """A mainstream seed with a wide mix."""
    seed = 'dQw4w9WgXcQ'


class TestClusterSeed(OrbitTestCase):
    """A seed inside a dense, self-reinforcing corner of the mix graph.

    This is the one that reproduces the 'single artist's discography' report.
    """
    seed = 'rcW-QwI7nAc'


del OrbitTestCase      # abstract: unittest would otherwise collect it


if __name__ == '__main__':
    unittest.main()
