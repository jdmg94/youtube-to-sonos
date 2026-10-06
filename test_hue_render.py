import unittest
from hue_render import parse_sonos_time, Clock, position_at, sync_clock, hsv_to_rgb, sample, last_beat_index, create_renderer


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


class HsvToRgb(unittest.TestCase):
    def test_pure_red(self):
        self.assertEqual(hsv_to_rgb(0, 1, 1), (255, 0, 0))

    def test_pure_green(self):
        self.assertEqual(hsv_to_rgb(120, 1, 1), (0, 255, 0))

    def test_pure_blue(self):
        self.assertEqual(hsv_to_rgb(240, 1, 1), (0, 0, 255))

    def test_desaturated_is_grey(self):
        self.assertEqual(hsv_to_rgb(180, 0, 0.5), (128, 128, 128))

    def test_wraps_negative_hue(self):
        self.assertEqual(hsv_to_rgb(-60, 1, 1), hsv_to_rgb(300, 1, 1))


class Sample(unittest.TestCase):
    def test_interpolates_between_frames(self):
        values = [0.0, 1.0]
        # At t=0.05 (halfway between frames at 0.1s spacing)
        self.assertAlmostEqual(sample(values, 0.1, 0.05), 0.5)

    def test_clamps_before_start(self):
        self.assertEqual(sample([5.0, 10.0], 0.1, -1.0), 5.0)

    def test_clamps_after_end(self):
        self.assertEqual(sample([5.0, 10.0], 0.1, 10.0), 10.0)

    def test_empty_array_returns_zero(self):
        self.assertEqual(sample([], 0.1, 5.0), 0.0)


class LastBeatIndex(unittest.TestCase):
    def test_before_first_beat(self):
        self.assertEqual(last_beat_index([1.0, 2.0, 3.0], 0.5), -1)

    def test_exactly_on_beat(self):
        self.assertEqual(last_beat_index([1.0, 2.0, 3.0], 2.0), 1)

    def test_between_beats(self):
        self.assertEqual(last_beat_index([1.0, 2.0, 3.0], 2.5), 1)

    def test_after_last_beat(self):
        self.assertEqual(last_beat_index([1.0, 2.0, 3.0], 10.0), 2)

    def test_empty_beats(self):
        self.assertEqual(last_beat_index([], 5.0), -1)


class CreateRenderer(unittest.TestCase):
    def test_creates_renderer_from_analysis(self):
        analysis = {
            'tempo': 120,
            'beats': [0.5, 1.0, 1.5],
            'energy': [0.3, 0.7],
            'brightness': [0.2, 0.8],
            'frame_seconds': 0.1,
        }
        renderer = create_renderer(analysis)
        self.assertIsNotNone(renderer)
        # Should have frame_at method
        frame = renderer.frame_at(0.5)
        self.assertIn('hue', frame)
        self.assertIn('saturation', frame)
        self.assertIn('value', frame)

    def test_normalizes_brightness_range(self):
        analysis = {
            'tempo': 120,
            'beats': [],
            'energy': [0.5],
            'brightness': [0.2, 0.3, 0.4, 0.5, 0.6],  # narrow span
            'frame_seconds': 0.1,
        }
        renderer = create_renderer(analysis)
        # Access brightness_range (stored for debugging)
        self.assertIsNotNone(renderer.brightness_range)


class FrameAt(unittest.TestCase):
    def test_beat_increases_value(self):
        analysis = {
            'tempo': 120,
            'beats': [1.0],
            'energy': [0.5],
            'brightness': [0.5],
            'frame_seconds': 0.1,
        }
        renderer = create_renderer(analysis)
        # Exactly on beat
        on_beat = renderer.frame_at(1.0)
        # Slightly after
        after_beat = renderer.frame_at(1.1)
        # Beat should lift value
        self.assertGreater(on_beat['value'], after_beat['value'])

    def test_quiet_passage_not_black(self):
        analysis = {
            'tempo': 120,
            'beats': [],
            'energy': [0.0],  # silent
            'brightness': [0.5],
            'frame_seconds': 0.1,
        }
        renderer = create_renderer(analysis)
        frame = renderer.frame_at(0.5)
        # MIN_VALUE = 0.15, so should be at least that
        self.assertGreaterEqual(frame['value'], 0.15)
