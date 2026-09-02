"""Tests for the parts of hue.py that can be checked without a bridge.

The backend has no test suite, and most of hue.py earns that: DTLS handshakes,
UDP writer threads and CLIP round trips are all hardware. Two functions are not.
`area_light_ids` and `restore_payload` exist to turn bridge JSON into the two
things the restore needs — which lamps, and what to say to them — and both are
pure guesses about response shapes I cannot run against a bridge from here.
Guesses that are written down and asserted are reviewable; guesses buried in a
method are not.

Run: .venv/bin/python -m unittest test_hue -v
"""

import unittest

from hue import HueSession, area_light_ids, restore_payload


def light(id, owner, **state):
    """A CLIP v2 light resource, trimmed to the fields either function reads."""
    return {'id': id, 'owner': {'rtype': 'device', 'rid': owner}, **state}


class AreaLightIds(unittest.TestCase):
    """Which lamps an entertainment area covers.

    The bridge does not say. An area lists *channels*, a channel lists the
    `entertainment` services feeding it, and an entertainment service and a
    light are two services of the same device — so the device is the join, and
    it takes three list calls to walk it.
    """

    def test_walks_channel_to_service_to_device_to_light(self):
        area = {'channels': [
            {'channel_id': 0, 'members': [
                {'service': {'rtype': 'entertainment', 'rid': 'ent-a'}}]},
            {'channel_id': 1, 'members': [
                {'service': {'rtype': 'entertainment', 'rid': 'ent-b'}}]},
        ]}
        services = [{'id': 'ent-a', 'owner': {'rtype': 'device', 'rid': 'dev-a'}},
                    {'id': 'ent-b', 'owner': {'rtype': 'device', 'rid': 'dev-b'}}]
        lights = [light('light-a', 'dev-a'), light('light-b', 'dev-b')]

        self.assertEqual(area_light_ids(area, services, lights),
                         ['light-a', 'light-b'])

    def test_counts_a_gradient_strip_once(self):
        """Several channels, one device, one light.

        A gradient strip is the normal case for an entertainment area, and
        restoring it once per channel would fire the same PUT five times.
        """
        area = {'channels': [
            {'channel_id': n, 'members': [
                {'service': {'rtype': 'entertainment', 'rid': 'ent-strip'}}]}
            for n in range(5)]}
        services = [{'id': 'ent-strip',
                     'owner': {'rtype': 'device', 'rid': 'dev-strip'}}]

        self.assertEqual(
            area_light_ids(area, services, [light('light-strip', 'dev-strip')]),
            ['light-strip'])

    def test_ignores_lights_outside_the_area(self):
        # The kitchen is on the same bridge and has nothing to do with the show.
        area = {'channels': [{'channel_id': 0, 'members': [
            {'service': {'rtype': 'entertainment', 'rid': 'ent-a'}}]}]}
        services = [{'id': 'ent-a', 'owner': {'rtype': 'device', 'rid': 'dev-a'}}]
        lights = [light('light-a', 'dev-a'), light('kitchen', 'dev-kitchen')]

        self.assertEqual(area_light_ids(area, services, lights), ['light-a'])

    def test_falls_back_to_light_services_when_channels_carry_no_members(self):
        """Older firmware answers with `light_services` and bare channels.

        Cheap to honour, and the alternative is restoring nothing on a bridge
        that streams perfectly well.
        """
        area = {'channels': [{'channel_id': 0}],
                'light_services': [{'rtype': 'light', 'rid': 'light-a'}]}

        self.assertEqual(area_light_ids(area, [], [light('light-a', 'dev-a')]),
                         ['light-a'])

    def test_names_no_lights_rather_than_guessing(self):
        """An unrecognised shape restores nothing.

        The tempting fallback — every light on the bridge — would put the
        kitchen back to a state the show never touched. Doing nothing is a
        light show that fails to clean up after itself; guessing is an app that
        reaches into other rooms.
        """
        area = {'channels': [{'channel_id': 0, 'members': [
            {'service': {'rtype': 'entertainment', 'rid': 'ent-missing'}}]}]}

        self.assertEqual(area_light_ids(area, [], [light('light-a', 'dev-a')]),
                         [])


class RestorePayload(unittest.TestCase):
    """What to say to one lamp to put it back."""

    def test_a_lamp_that_was_off_is_only_told_to_be_off(self):
        """No colour, no brightness — those would be a flash on the way out.

        The bridge applies a PUT as one state change, but a lamp that the show
        has been driving is *on*, and handing it a colour alongside `on: false`
        is how you get a blink instead of a fade to nothing.
        """
        snapshot = light('l', 'd', on={'on': False},
                         dimming={'brightness': 74.0},
                         color={'xy': {'x': 0.4, 'y': 0.4}})

        self.assertEqual(restore_payload(snapshot), {'on': {'on': False}})

    def test_restores_brightness_and_colour_for_a_lamp_that_was_on(self):
        snapshot = light('l', 'd', on={'on': True},
                         dimming={'brightness': 62.5},
                         color={'xy': {'x': 0.3127, 'y': 0.329}})

        self.assertEqual(restore_payload(snapshot), {
            'on': {'on': True},
            'dimming': {'brightness': 62.5},
            'color': {'xy': {'x': 0.3127, 'y': 0.329}},
        })

    def test_prefers_colour_temperature_when_the_lamp_was_in_that_mode(self):
        """`mirek` is non-null only while the lamp is actually on white.

        The lamp keeps its last xy either way, so sending xy back to a lamp
        that was on warm white is how a restore silently turns the room pink.
        """
        snapshot = light('l', 'd', on={'on': True},
                         dimming={'brightness': 40.0},
                         color={'xy': {'x': 0.6, 'y': 0.3}},
                         color_temperature={'mirek': 366, 'mirek_valid': True})

        payload = restore_payload(snapshot)

        self.assertEqual(payload['color_temperature'], {'mirek': 366})
        self.assertNotIn('color', payload)

    def test_ignores_an_invalid_mirek(self):
        # A colour lamp off white reports the field with a null in it.
        snapshot = light('l', 'd', on={'on': True},
                         color={'xy': {'x': 0.6, 'y': 0.3}},
                         color_temperature={'mirek': None, 'mirek_valid': False})

        payload = restore_payload(snapshot)

        self.assertEqual(payload['color'], {'xy': {'x': 0.6, 'y': 0.3}})
        self.assertNotIn('color_temperature', payload)

    def test_says_nothing_about_what_the_lamp_never_reported(self):
        """A white-only lamp has no colour and a plug has no brightness.

        Sending the keys anyway is a 400 from the bridge for every lamp that
        isn't a full colour bulb.
        """
        self.assertEqual(restore_payload(light('l', 'd', on={'on': True})),
                         {'on': {'on': True}})


class FakeClient:
    """Records the calls a session makes, in order.

    Only the three methods HueSession reaches for. `calls` is the point of the
    class: most of what is worth asserting about a restore is *when* it
    happens relative to deactivating the area.
    """

    def __init__(self, snapshot=None, snapshot_error=None):
        self.calls = []
        self._snapshot = snapshot if snapshot is not None else [
            light('l', 'd', on={'on': True}, dimming={'brightness': 80.0})]
        self._snapshot_error = snapshot_error

    def area_snapshot(self, area_id):
        self.calls.append(('snapshot', area_id))
        if self._snapshot_error:
            raise self._snapshot_error
        return self._snapshot

    def set_area_action(self, area_id, action):
        self.calls.append(('area', action))

    def restore_lights(self, snapshot):
        self.calls.append(('restore', [it['id'] for it in snapshot]))


class OfflineSession(HueSession):
    """A session whose only missing piece is the hardware.

    `_connect` is the single point where this class touches DTLS, so stubbing
    it leaves every ordering decision in start/stop under test.
    """

    connect_error = None

    def _connect(self):
        if self.connect_error:
            raise self.connect_error
        return None, 'stub-profile'


class SessionRestore(unittest.TestCase):

    def session(self, client):
        s = OfflineSession(client, 'area-1', [0, 1])
        # Nothing to join or close; the writer thread is not what is under test.
        s._writer = lambda: None
        return s

    def test_snapshots_the_room_before_the_area_goes_live(self):
        """Order matters and is invisible if you get it wrong.

        Once an area is streaming the bridge reports the frames we are sending,
        so a snapshot taken afterwards records the light show and "restores"
        the room to it.
        """
        client = FakeClient()
        self.session(client).start()

        self.assertEqual(client.calls[:2],
                         [('snapshot', 'area-1'), ('area', 'start')])

    def test_hands_the_area_back_before_putting_the_lamps_back(self):
        """A light in a streaming area ignores REST.

        Restoring first is a no-op that looks exactly like a correct
        implementation from the code, and like a broken one from the sofa.
        """
        client = FakeClient()
        session = self.session(client)
        session.start()
        client.calls.clear()

        session.stop()

        self.assertEqual(client.calls, [('area', 'stop'), ('restore', ['l'])])

    def test_a_second_stop_does_not_reapply_a_stale_room(self):
        # Stop is reachable twice — the dialog's button and /api/stop both call
        # it — and the second one must not resurrect an hours-old snapshot.
        client = FakeClient()
        session = self.session(client)
        session.start()
        session.stop()
        client.calls.clear()

        session.stop()

        self.assertNotIn('restore', [call[0] for call in client.calls])

    def test_runs_the_show_even_when_the_room_cannot_be_read(self):
        """A snapshot is a nicety; the light show is the feature.

        Failing to record the old colours means skipping the restore, not
        refusing to start.
        """
        client = FakeClient(snapshot_error=RuntimeError("bridge busy"))

        self.session(client).start()

        self.assertIn(('area', 'start'), client.calls)

    def test_puts_the_room_back_when_the_handshake_fails(self):
        """Activating an area lights its lamps before a frame is sent.

        So a start that gets as far as the area action and no further has still
        changed the room, and owes it the same restore a clean stop does.
        """
        client = FakeClient()
        session = self.session(client)
        session.connect_error = RuntimeError("no handshake")

        with self.assertRaises(RuntimeError):
            session.start()

        self.assertEqual(client.calls[-2:],
                         [('area', 'stop'), ('restore', ['l'])])


if __name__ == '__main__':
    unittest.main()
