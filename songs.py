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
