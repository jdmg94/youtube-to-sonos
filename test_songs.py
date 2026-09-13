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
