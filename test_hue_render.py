import unittest
from unittest.mock import Mock
import threading
import time
from hue_render import (
    parse_sonos_time, Clock, position_at, sync_clock, hsv_to_rgb, sample,
    last_beat_index, create_renderer, order_channels, spread_across,
    ease_toward, resolve_settings, DEFAULT_SETTINGS, BRIGHTNESS_FLOOR,
    DECAY_MIN, DECAY_MAX, SPREAD_MAX_DEG, TAU_MIN_SECONDS, TAU_MAX_SECONDS,
    RenderLoop
)


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


class OrderChannels(unittest.TestCase):
    def test_orders_by_x_when_wider(self):
        channels = [2, 0, 1]
        positions = {
            '0': {'x': 0.5, 'y': 0.0, 'z': 0.0},
            '1': {'x': 0.0, 'y': 0.1, 'z': 0.0},
            '2': {'x': 1.0, 'y': 0.2, 'z': 0.0},
        }
        self.assertEqual(order_channels(channels, positions), [1, 0, 2])

    def test_orders_by_y_when_taller(self):
        channels = [2, 0, 1]
        positions = {
            '0': {'x': 0.1, 'y': 0.5, 'z': 0.0},
            '1': {'x': 0.0, 'y': 0.0, 'z': 0.0},
            '2': {'x': 0.2, 'y': 1.0, 'z': 0.0},
        }
        self.assertEqual(order_channels(channels, positions), [1, 0, 2])

    def test_falls_back_to_id_when_no_positions(self):
        channels = [3, 1, 2]
        positions = {}
        self.assertEqual(order_channels(channels, positions), [1, 2, 3])

    def test_falls_back_when_position_missing(self):
        channels = [1, 2]
        positions = {'1': {'x': 0.5, 'y': 0.0, 'z': 0.0}}  # 2 missing
        self.assertEqual(order_channels(channels, positions), [1, 2])


class SpreadAcross(unittest.TestCase):
    def test_spreads_hue_across_channels(self):
        frame = {'hue': 140, 'saturation': 0.9, 'value': 0.8}
        ordered = [0, 1, 2]
        spread_deg = 60
        colors = spread_across(frame, ordered, spread_deg)

        # Three channels: -30, 0, +30 from center hue
        self.assertEqual(len(colors), 3)
        # Keys are stringified channel ids
        self.assertIn('0', colors)
        self.assertIn('2', colors)
        # First channel shifted left, last shifted right
        # (exact RGB values depend on HSV conversion, just verify they differ)
        self.assertNotEqual(colors['0'], colors['2'])

    def test_single_channel_at_center(self):
        frame = {'hue': 100, 'saturation': 0.9, 'value': 0.8}
        colors = spread_across(frame, [5], 60)
        # Rank = 0.5 (middle), shift = 0
        self.assertEqual(colors['5'], hsv_to_rgb(100, 0.9, 0.8))

    def test_returns_rgb_tuples(self):
        frame = {'hue': 120, 'saturation': 1.0, 'value': 1.0}
        colors = spread_across(frame, [0, 1], 30)
        # Should be 8-bit RGB tuples
        self.assertIsInstance(colors['0'], tuple)
        self.assertEqual(len(colors['0']), 3)
        self.assertTrue(all(0 <= c <= 255 for c in colors['0']))


class EaseToward(unittest.TestCase):
    def test_approaches_target_exponentially(self):
        prev = (100.0, 100.0, 100.0)
        target = (200.0, 200.0, 200.0)
        # dt=0.1, tau=0.2 -> alpha ≈ 0.393
        eased = ease_toward(prev, target, 0.1, 0.2)
        # Should move ~39% toward target
        self.assertGreater(eased[0], 100.0)
        self.assertLess(eased[0], 200.0)

    def test_snap_when_dt_equals_infinity(self):
        prev = (100.0, 100.0, 100.0)
        target = (200.0, 200.0, 200.0)
        eased = ease_toward(prev, target, float('inf'), 0.2)
        self.assertEqual(eased, target)

    def test_returns_floats(self):
        eased = ease_toward((100.0, 100.0, 100.0), (150.0, 150.0, 150.0), 0.1, 0.2)
        self.assertIsInstance(eased[0], float)


class ResolveSettings(unittest.TestCase):
    def test_default_settings(self):
        resolved = resolve_settings(DEFAULT_SETTINGS)
        self.assertEqual(resolved['brightness'], 1.0)  # 100 -> 1.0
        # transition=25 -> beatDecay between MIN and MAX
        self.assertGreater(resolved['beatDecay'], DECAY_MIN)
        self.assertLess(resolved['beatDecay'], DECAY_MAX)

    def test_brightness_floor(self):
        resolved = resolve_settings({'brightness': 0, 'transition': 50, 'spread': 0})
        self.assertEqual(resolved['brightness'], BRIGHTNESS_FLOOR)

    def test_spread_scales_linearly(self):
        resolved = resolve_settings({'brightness': 100, 'transition': 50, 'spread': 50})
        self.assertAlmostEqual(resolved['spreadDeg'], SPREAD_MAX_DEG * 0.5)

    def test_tau_scales_geometrically(self):
        resolved_min = resolve_settings({'brightness': 100, 'transition': 0, 'spread': 0})
        resolved_max = resolve_settings({'brightness': 100, 'transition': 100, 'spread': 0})
        self.assertAlmostEqual(resolved_min['tauSeconds'], TAU_MIN_SECONDS)
        self.assertAlmostEqual(resolved_max['tauSeconds'], TAU_MAX_SECONDS)


class RenderLoopLifecycle(unittest.TestCase):
    def test_starts_and_stops_cleanly(self):
        session = Mock()
        session.channels = [0, 1]
        session.positions = {}
        session.set_color = Mock()
        session.set_current_colors = Mock()
        session.last_sent = None

        speaker = Mock()
        speaker.get_current_track_info.return_value = {'uri': '', 'position': '0:00:00'}
        speaker.get_current_transport_info.return_value = {'current_transport_state': 'PAUSED'}

        loop = RenderLoop(session, speaker, '/tmp', {'brightness': 100, 'transition': 25, 'spread': 15})

        # Should not be running yet
        self.assertIsNone(loop._thread)

        loop.start()
        # Thread should spawn
        self.assertIsNotNone(loop._thread)
        self.assertTrue(loop._thread.is_alive())

        # Let it tick at least once
        time.sleep(0.1)

        loop.stop()
        # Thread should be None or dead
        if loop._thread:
            self.assertFalse(loop._thread.is_alive())
        # After stop(), thread is set to None
        else:
            self.assertIsNone(loop._thread)

    def test_update_settings_while_running(self):
        session = Mock()
        session.channels = [0]
        session.positions = {}
        session.set_color = Mock()
        session.set_current_colors = Mock()
        session.last_sent = None

        speaker = Mock()
        speaker.get_current_track_info.return_value = {'uri': '', 'position': '0:00:00'}
        speaker.get_current_transport_info.return_value = {'current_transport_state': 'PAUSED'}

        loop = RenderLoop(session, speaker, '/tmp', {'brightness': 100, 'transition': 25, 'spread': 15})
        loop.start()

        # Update settings
        new_settings = {'brightness': 50, 'transition': 75, 'spread': 30}
        loop.update_settings(new_settings)

        # Should update immediately (atomic dict replacement)
        self.assertEqual(loop.settings, new_settings)

        loop.stop()
