import unittest
from hue_render import parse_sonos_time, Clock, position_at, sync_clock


class ParseSonosTime(unittest.TestCase):
    def test_parses_valid_time(self):
        self.assertEqual(parse_sonos_time('0:02:35'), 155.0)
        self.assertEqual(parse_sonos_time('1:30:00'), 5400.0)

    def test_returns_none_for_invalid(self):
        self.assertIsNone(parse_sonos_time('NOT_IMPLEMENTED'))
        self.assertIsNone(parse_sonos_time(''))
        self.assertIsNone(parse_sonos_time(None))


class PositionAt(unittest.TestCase):
    def test_running_clock_advances(self):
        clock = Clock(position=10.0, at_ms=1000.0, running=True)
        # 500ms later = 0.5s
        self.assertAlmostEqual(position_at(clock, 1500.0), 10.5)

    def test_paused_clock_holds(self):
        clock = Clock(position=10.0, at_ms=1000.0, running=False)
        self.assertEqual(position_at(clock, 2000.0), 10.0)


class SyncClock(unittest.TestCase):
    def test_initial_anchor_adds_bias(self):
        clock = sync_clock(None, 10.0, 1000.0, True)
        self.assertEqual(clock.position, 10.5)  # +0.5s bias
        self.assertEqual(clock.at_ms, 1000.0)
        self.assertTrue(clock.running)

    def test_keeps_anchor_within_threshold(self):
        prev = Clock(position=10.5, at_ms=1000.0, running=True)
        # 1s later, speaker reports 11s (predicted 11.5, drift=0.5s < 0.75s threshold)
        clock = sync_clock(prev, 11.0, 2000.0, True)
        self.assertEqual(clock.position, 10.5)  # kept previous
        self.assertEqual(clock.at_ms, 1000.0)

    def test_re_anchors_beyond_threshold(self):
        prev = Clock(position=10.0, at_ms=1000.0, running=True)
        # 2s later, speaker reports 13s (predicted 12, drift=1.5s > 0.75s)
        clock = sync_clock(prev, 13.0, 3000.0, True)
        self.assertEqual(clock.position, 13.5)  # re-anchored
        self.assertEqual(clock.at_ms, 3000.0)

    def test_always_re_anchors_when_paused(self):
        prev = Clock(position=10.0, at_ms=1000.0, running=True)
        clock = sync_clock(prev, 10.0, 1100.0, False)
        self.assertEqual(clock.position, 10.5)
        self.assertFalse(clock.running)
