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

    def test_reversed_order_with_bracketed_qualifier_matches_channel(self):
        # Task 14: "UWAIE - Kapo (Video Oficial)" on channel Kapo. The qualifier
        # used to block the channel match, leaving artist='uwaie', tokens={'kapo'}.
        played = {
            'id': 'played_id',
            'title': 'Kapo - UWAIE (Lyrics/Letra)',
            'uploader': 'TUFF Music',
            'duration': 185
        }
        queued = {
            'id': 'queued_id',
            'title': 'UWAIE - Kapo (Video Oficial)',
            'uploader': 'Kapo',
            'duration': 192
        }
        played_song = songs.attribute(played)
        queued_song = songs.attribute(queued)
        # Both should resolve to the same artist and tokens
        self.assertEqual(played_song.artist, 'kapo')
        self.assertEqual(queued_song.artist, 'kapo')
        self.assertEqual(played_song.tokens, frozenset({'uwaie'}))
        self.assertEqual(queued_song.tokens, frozenset({'uwaie'}))

    def test_reversed_order_with_featured_artist_matches_channel(self):
        # Task 14 extension: "UWAIE - Kapo feat. Someone" on channel Kapo
        # should also reverse, proving _FEAT is stripped before comparison.
        song = songs.attribute({
            'id': 'feat_id',
            'title': 'UWAIE - Kapo feat. Someone',
            'uploader': 'Kapo',
            'duration': 192
        })
        self.assertEqual(song.artist, 'kapo')
        self.assertEqual(song.tokens, frozenset({'uwaie'}))

    def test_leading_brackets_stripped_from_left_side(self):
        # Task 14 commit 2: "[Official Video] Kapo - UWAIE" should yield
        # artist='kapo', not artist='official video kapo'.
        song = songs.attribute({
            'id': 'bracket_id',
            'title': '[Official Video] Kapo - UWAIE',
            'uploader': 'Kapo',
            'duration': 192
        })
        self.assertEqual(song.artist, 'kapo')
        self.assertEqual(song.tokens, frozenset({'uwaie'}))

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

    def test_collab_credit_collapses_to_first_artist(self):
        # Task 15: "Beéle, Ovy On The Drums - mi refe" should yield artist='beele'
        # so it matches "Beéle - mi refe" (the solo credit).
        collab = songs.attribute({
            'id': 'collab_id',
            'title': 'Beéle, Ovy On The Drums - mi refe (Video Oficial)',
            'uploader': 'Beéle',
            'duration': 185
        })
        solo = songs.attribute({
            'id': 'solo_id',
            'title': 'Beéle - mi refe (Lyrics/Letra)',
            'uploader': 'Beéle',
            'duration': 185
        })
        self.assertEqual(collab.artist, 'beele')
        self.assertEqual(solo.artist, 'beele')
        self.assertEqual(collab.tokens, solo.tokens)

    def test_collab_and_solo_dedupe_in_memory(self):
        # Task 15: memory-level test. add() collab, find() solo -> hit.
        mem = songs.SongMemory()
        collab = songs.attribute({
            'id': 'collab_id',
            'title': 'Beéle, Ovy On The Drums - mi refe',
            'uploader': 'Beéle',
            'duration': 185
        })
        solo = songs.attribute({
            'id': 'solo_id',
            'title': 'Beéle - mi refe',
            'uploader': 'Beéle',
            'duration': 185
        })
        mem.add(collab, heard=True)
        hit = mem.find(solo)
        self.assertIsNotNone(hit)
        self.assertEqual(hit.reason, 'exact')

    def test_band_with_comma_stays_intact(self):
        # Task 15: Earth, Wind & Fire uploaded by "Earth Wind & Fire" (the
        # band guard). The channel name equals the whole left side, so it
        # must not be split at the comma.
        song = songs.attribute({
            'id': 'ewf_id',
            'title': 'Earth, Wind & Fire - September',
            'uploader': 'Earth Wind & Fire',
            'duration': 215
        })
        self.assertEqual(song.artist, 'earth wind fire')

    def test_band_with_ampersand_never_splits(self):
        # Task 15: Kool & The Gang - all four '&' cases in the real corpus
        # are band names, not collabs, so '&' is never a split point.
        song = songs.attribute({
            'id': 'kool_id',
            'title': 'Kool & The Gang - Celebration',
            'uploader': 'Kool & The Gang',
            'duration': 220
        })
        self.assertEqual(song.artist, 'kool the gang')

    def test_collab_first_artist_is_independent_of_uploader(self):
        # Task 15: "Rema, Selena Gomez" yields 'rema' whether the uploader
        # is Rema, Selena Gomez, or a third-party lyrics channel. The first
        # credit is canonical, not the channel-matching one.
        rema_upload = songs.attribute({
            'id': 'v1',
            'title': 'Rema, Selena Gomez - Calm Down',
            'uploader': 'Rema',
            'duration': 239
        })
        selena_upload = songs.attribute({
            'id': 'v2',
            'title': 'Rema, Selena Gomez - Calm Down',
            'uploader': 'Selena Gomez',
            'duration': 239
        })
        self.assertEqual(rema_upload.artist, 'rema')
        self.assertEqual(selena_upload.artist, 'rema')

    def test_ampersand_band_under_third_party_stays_whole(self):
        # Task 16: "Earth, Wind & Fire" under a third-party channel yields
        # 'earth wind fire', not 'earth'. The '&' signal is uploader-independent.
        third_party = songs.attribute({
            'id': 'third_id',
            'title': 'Earth, Wind & Fire - September',
            'uploader': 'Random Lyrics Channel',
            'duration': 215
        })
        self.assertEqual(third_party.artist, 'earth wind fire')

    def test_ampersand_band_uploader_independence(self):
        # Task 16: same title under own channel and third-party channel yields
        # the same artist value (uploader independence).
        own_channel = songs.attribute({
            'id': 'own_id',
            'title': 'Earth, Wind & Fire - September',
            'uploader': 'Earth Wind & Fire',
            'duration': 215
        })
        third_party = songs.attribute({
            'id': 'third_id',
            'title': 'Earth, Wind & Fire - September',
            'uploader': 'Random Lyrics Channel',
            'duration': 215
        })
        self.assertEqual(own_channel.artist, third_party.artist)
        self.assertEqual(own_channel.artist, 'earth wind fire')

    def test_ampersand_band_third_party_dedupes_in_memory(self):
        # Task 16: memory-level test. add() own-channel upload, find() third-party
        # upload -> hit.
        mem = songs.SongMemory()
        own_channel = songs.attribute({
            'id': 'own_id',
            'title': 'Earth, Wind & Fire - September',
            'uploader': 'Earth Wind & Fire',
            'duration': 215
        })
        third_party = songs.attribute({
            'id': 'third_id',
            'title': 'Earth, Wind & Fire - September',
            'uploader': 'Random Lyrics Channel',
            'duration': 215
        })
        mem.add(own_channel, heard=True)
        hit = mem.find(third_party)
        self.assertIsNotNone(hit)
        self.assertEqual(hit.reason, 'exact')

    def test_ampersand_band_without_comma_stays_whole(self):
        # Task 16: "Kool & The Gang" under a stranger channel stays whole.
        # Guards the '&' rule without the channel guard.
        stranger = songs.attribute({
            'id': 'stranger_id',
            'title': 'Kool & The Gang - Celebration',
            'uploader': 'Some Uploader',
            'duration': 220
        })
        self.assertEqual(stranger.artist, 'kool the gang')

    def test_genuine_collab_still_splits(self):
        # Task 16: a genuine comma collab still collapses to its first artist.
        # Guards against over-reaching: do not let the '&' rule disable comma
        # splitting generally.
        collab = songs.attribute({
            'id': 'collab_id',
            'title': 'Lady Gaga, Bruno Mars - Die With A Smile',
            'uploader': 'Lady Gaga',
            'duration': 261
        })
        self.assertEqual(collab.artist, 'lady gaga')


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
        # that implements "any version except covers": a cover by another artist
        # stays eligible because the artist bucket is empty for that performer.
        self.mem.add(song('ellie goulding', 'love me like you do'))
        self.assertIsNone(self.mem.find(song('boyce avenue', 'love me like you do')))

    def test_rule_3_equal_token_sets_match(self):
        self.mem.add(song('dua lipa', 'levitating', duration=217, vid='v1'))
        hit = self.mem.find(song('dua lipa', 'levitating', duration=203, vid='v2'))
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
        # 2/3 = 0.67, below MATCH_OVERLAP (0.8). Guards the "Part 1 / Part 2"
        # case: two parts of one work are two songs and must stay distinct.
        self.mem.add(song('a', 'song part 1', duration=200))
        self.assertIsNone(self.mem.find(song('a', 'song part 2', duration=200)))

    def test_rule_4_partial_overlap_needs_the_durations_to_agree(self):
        # Partial overlap at the threshold: {one, two, three, four, five} vs
        # {one, two, three, four, six} share 4 tokens, ratio 4/5 = 0.8, just
        # clearing MATCH_OVERLAP so the duration gate is reached. Durations far
        # apart reject the match — without this check, two cuts of different
        # length would collapse.
        self.mem.add(song('a', 'one two three four five', duration=200, vid='v1'))
        self.assertIsNone(self.mem.find(song('a', 'one two three four six', duration=400, vid='v2')))

    def test_containment_matches_a_short_query_against_a_longer_stored_title(self):
        # The query-short direction: stored title has extra tokens, query is
        # shorter. This exercises symmetric subset matching, though it is not
        # the common direction in practice (see the new test below).
        self.mem.add(song('taylor swift', 'love story taylors', duration=235, vid='stored'))
        hit = self.mem.find(song('taylor swift', 'love story', duration=356, vid='query'))
        self.assertEqual(hit.reason, 'subset')

    def test_a_longer_variant_title_matches_the_stored_short_one(self):
        # The common ordering: the canonical upload is heard first, so memory holds
        # the short title and the variant arrives carrying the extra tokens.
        # Durations differ well past MATCH_DURATION_TOLERANCE, so `overlap` cannot
        # rescue this — only symmetric subset matching catches it.
        self.mem.add(song('adele', 'someone like you', duration=285, vid='short'))
        hit = self.mem.find(song('adele', 'someone like you live at the royal albert hall',
                                 duration=330, vid='long'))
        self.assertEqual(hit.reason, 'subset')

    def test_rule_4_partial_overlap_with_agreeing_durations_matches(self):
        # The same token pair, now with durations close enough: the ratio passes
        # and the durations confirm it, so the match is accepted. Without this
        # the overlap rule could be deleted and only negative tests would notice.
        self.mem.add(song('a', 'one two three four five', duration=200, vid='v1'))
        hit = self.mem.find(song('a', 'one two three four six', duration=203, vid='v2'))
        self.assertEqual(hit.reason, 'overlap')

    def test_an_unknown_duration_never_confirms_a_partial_match(self):
        # Corroboration we do not have is not corroboration. Flat entries
        # always carry a duration, so this is the resolved-metadata edge.
        # Partial overlap at the threshold (4/5 = 0.8) clears the ratio gate,
        # but one side has no duration, so the match cannot be confirmed.
        self.mem.add(song('a', 'one two three four five', duration=None, vid='v1'))
        self.assertIsNone(self.mem.find(song('a', 'one two three four six', duration=200, vid='v2')))


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

    def test_reversed_title_with_qualifier_is_matched_in_memory(self):
        # Task 14: memory-level regression. The two Kapo/UWAIE uploads must
        # match despite reversed title order and bracketed qualifiers, and
        # they must match even with different durations (proving the match
        # does not lean on duration corroboration).
        mem = songs.SongMemory()
        played = {
            'id': 'played_id',
            'title': 'Kapo - UWAIE (Lyrics/Letra)',
            'uploader': 'TUFF Music',
            'duration': 185
        }
        queued = {
            'id': 'queued_id',
            'title': 'UWAIE - Kapo (Video Oficial)',
            'uploader': 'Kapo',
            'duration': 192
        }
        mem.add(songs.attribute(played), heard=True)
        hit = mem.find(songs.attribute(queued))
        self.assertIsNotNone(hit)
        self.assertEqual(hit.reason, 'exact')


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


class TestPersistence(unittest.TestCase):
    def test_round_trip_preserves_matching(self):
        # Matching, not just storage, is what has to survive the round trip.
        mem = songs.SongMemory()
        mem.add(songs.attribute(SYN['syn_topic']), heard=True)
        payload = mem.snapshot()
        fresh = songs.SongMemory()
        fresh.restore(payload)
        # A different upload of the same song still hits it
        hit = fresh.find(songs.attribute(SYN['syn_video']))
        self.assertIsNotNone(hit)
        # oldest_heard returns it
        self.assertIsNotNone(fresh.oldest_heard())

    def test_unheard_entries_are_not_persisted(self):
        # The Global Constraint: only heard entries are persisted.
        mem = songs.SongMemory()
        mem.add(song('a', 'heard one'), heard=True)
        mem.add(song('a', 'queued only'), heard=False)
        payload = mem.snapshot()
        self.assertEqual(len(payload['entries']), 1)
        self.assertEqual(payload['entries'][0]['title'], 'a - heard one')

    def test_round_trip_through_disk(self):
        import tempfile
        mem = songs.SongMemory()
        mem.add(song('a', 'one two'), heard=True)
        payload1 = mem.snapshot()
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, 'history.json')
            songs.save_history(path, payload1)
            payload2 = songs.load_history(path)
        self.assertEqual(payload1, payload2)

    def test_missing_file_is_empty(self):
        payload = songs.load_history('/nonexistent/path/history.json')
        self.assertIsNone(payload)
        mem = songs.SongMemory()
        mem.restore(None)
        self.assertEqual(len(mem), 0)

    def test_corrupt_file_is_empty(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, 'corrupt.json')
            with open(path, 'w') as fh:
                fh.write('{not json')
            payload = songs.load_history(path)
        self.assertIsNone(payload)

    def test_version_mismatch_discards(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, 'old.json')
            old_payload = {'version': 0, 'entries': []}
            with open(path, 'w') as fh:
                json.dump(old_payload, fh)
            payload = songs.load_history(path)
        self.assertIsNone(payload)

    def test_restore_prunes_expired(self):
        mem = songs.SongMemory(ttl=7 * 24 * 3600)
        # 8 days old, past the TTL
        payload = {
            'version': songs.HISTORY_VERSION,
            'entries': [{
                'artist': 'a',
                'tokens': ['old'],
                'duration': 200,
                'ids': {'v1': 2},
                'title': 'a - old',
                'last_at': 0.0,
                'heard': True,
            }]
        }
        mem.restore(payload)
        # Restore with current time, 8 days later
        now = 8 * 24 * 3600
        mem.prune(now)
        self.assertEqual(len(mem), 0)

    def test_save_is_atomic(self):
        import tempfile
        mem = songs.SongMemory()
        mem.add(song('a', 'one two'), heard=True)
        payload = mem.snapshot()
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, 'history.json')
            songs.save_history(path, payload)
            # No .part file remains
            self.assertFalse(os.path.exists(f"{path}.part"))
            # Target parses
            loaded = songs.load_history(path)
            self.assertIsNotNone(loaded)

    def test_snapshot_clears_dirty(self):
        mem = songs.SongMemory()
        mem.add(song('a', 'one two'), heard=True)
        self.assertTrue(mem.dirty)
        mem.snapshot()
        self.assertFalse(mem.dirty)


class TestBuildQueue(unittest.TestCase):
    def test_drops_ids_already_in_memory(self):
        # An entry whose id is in a passed memory never appears.
        mem = songs.SongMemory()
        mem.add(song('a', 'one two', vid='v1'))
        entries = [{'id': 'v1', 'title': 'A - One Two', 'uploader': 'A', 'duration': 200}]
        queue = songs.build_station_queue(entries, [mem])
        self.assertEqual(len(queue), 0)

    def test_drops_fuzzy_match_in_memory(self):
        # Memory holds "Dua Lipa - Levitating"; a Topic upload is dropped,
        # and on_reject was called once with reason 'exact'.
        mem = songs.SongMemory()
        mem.add(songs.attribute(SYN['syn_video']))
        entries = [SYN['syn_topic']]
        rejections = []
        queue = songs.build_station_queue(entries, [mem],
                                          on_reject=lambda e, r: rejections.append((e['id'], r)))
        self.assertEqual(len(queue), 0)
        self.assertEqual(len(rejections), 1)
        self.assertEqual(rejections[0], ('syn_topic', 'exact'))

    def test_collapses_versions_within_the_pool(self):
        # A mix containing both "Official Video" and a Topic upload yields ONE entry.
        entries = [SYN['syn_video'], SYN['syn_topic']]
        queue = songs.build_station_queue(entries, [])
        self.assertEqual(len(queue), 1)

    def test_collapsed_entry_uses_the_audio_upload(self):
        # For the video/topic pair, the surviving entry's id is the Topic upload's id,
        # and its position in the result is the position of whichever appeared first
        # in the mix. Rank decides the file; mix order decides the slot.
        entries = [SYN['syn_video'], SYN['syn_topic']]
        queue = songs.build_station_queue(entries, [])
        self.assertEqual(queue[0]['id'], 'syn_topic')

    def test_unmarked_beats_official_video(self):
        # Rank 2 wins over rank 3, so an unmarked upload is preferred to a music video.
        entries = [
            {'id': 'v_unmarked', 'title': 'Artist - Song', 'uploader': 'Artist', 'duration': 200},
            {'id': 'v_video', 'title': 'Artist - Song (Official Music Video)',
             'uploader': 'Artist', 'duration': 200}
        ]
        queue = songs.build_station_queue(entries, [])
        self.assertEqual(len(queue), 1)
        self.assertEqual(queue[0]['id'], 'v_unmarked')

    def test_cover_by_another_artist_survives(self):
        # A different-artist cover of a memorised song is kept. This is the user's
        # "any version except covers" line and it is the one rule that costs recall
        # to honour.
        mem = songs.SongMemory()
        mem.add(songs.attribute(SYN['syn_videogames']))
        entries = [SYN['syn_cover']]
        queue = songs.build_station_queue(entries, [mem])
        self.assertEqual(len(queue), 1)
        self.assertEqual(queue[0]['id'], 'syn_cover')

    def test_artist_cap(self):
        # Five entries from one artist with max_per_artist=2 yield two.
        entries = [
            {'id': f'v{i}', 'title': f'Artist - Song {i}', 'uploader': 'Artist', 'duration': 200}
            for i in range(5)
        ]
        queue = songs.build_station_queue(entries, [], max_per_artist=2)
        self.assertEqual(len(queue), 2)

    def test_no_back_to_back_same_artist(self):
        # With three artists × two tracks, no two adjacent results share an artist.
        entries = []
        for artist in ('A', 'B', 'C'):
            for i in range(2):
                entries.append({
                    'id': f'{artist}{i}', 'title': f'{artist} - Song {i}',
                    'uploader': artist, 'duration': 200
                })
        queue = songs.build_station_queue(entries, [])
        # Extract artists from the queue
        artists = [songs.attribute(e).artist for e in queue]
        # Check no two adjacent artists are the same
        for i in range(len(artists) - 1):
            self.assertNotEqual(artists[i], artists[i + 1])

    def test_cooldown_artists_ordered_last(self):
        # A cooled-down artist's first track appears after every fresh artist's
        # first track, but is not dropped.
        entries = [
            {'id': 'cool1', 'title': 'Cooled - Song 1', 'uploader': 'Cooled', 'duration': 200},
            {'id': 'fresh1', 'title': 'Fresh - Song 1', 'uploader': 'Fresh', 'duration': 200},
            {'id': 'another1', 'title': 'Another - Song 1', 'uploader': 'Another', 'duration': 200},
        ]
        queue = songs.build_station_queue(entries, [], cooldown_artists=['cooled'])
        artists = [songs.attribute(e).artist for e in queue]
        # The cooled artist's first track appears after the fresh artists' first tracks
        first_cooled = next((i for i, a in enumerate(artists) if a == 'cooled'), None)
        self.assertIsNotNone(first_cooled)
        # Both fresh artists appear before the cooled one
        self.assertGreater(first_cooled, 0)
        self.assertEqual(artists[0], 'fresh')
        self.assertEqual(artists[1], 'another')

    def test_unknown_artist_treated_as_unique(self):
        # Two entries with no resolvable artist do not share a bucket and are
        # not capped against each other.
        entries = [
            {'id': 'v1', 'title': 'Song 1', 'channel_id': 'UC001', 'duration': 200},
            {'id': 'v2', 'title': 'Song 2', 'channel_id': 'UC002', 'duration': 200},
        ]
        queue = songs.build_station_queue(entries, [], max_per_artist=1)
        # Both should survive because they have different channel_ids (fallback artist)
        self.assertEqual(len(queue), 2)

    def test_empty_entries_yields_empty(self):
        # No exception, no None.
        queue = songs.build_station_queue([], [])
        self.assertEqual(queue, [])

    def test_no_memories_is_legal(self):
        # memories=() returns the whole collapsed pool; this is rung 5 of the
        # ladder with the artist cap lifted.
        entries = [SYN['syn_video'], SYN['syn_topic']]
        queue = songs.build_station_queue(entries, memories=())
        self.assertEqual(len(queue), 1)

    def test_on_reject_not_called_for_id_matches(self):
        # An exact-id drop is not a fuzzy decision and must not be logged as one,
        # or the log fills with the normal case.
        mem = songs.SongMemory()
        mem.add(song('a', 'one two', vid='v1'))
        entries = [{'id': 'v1', 'title': 'A - One Two', 'uploader': 'A', 'duration': 200}]
        rejections = []
        songs.build_station_queue(entries, [mem],
                                  on_reject=lambda e, r: rejections.append((e['id'], r)))
        self.assertEqual(len(rejections), 0)


if __name__ == '__main__':
    unittest.main()
