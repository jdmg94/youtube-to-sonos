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

# Artist cap: how many tracks from one artist may appear in one built queue.
# Tunable deployment knob lives in app.py; the default is here so downstream
# calls need not know what app.py's env-var default is.
MAX_TRACKS_PER_ARTIST = 2

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


def _first_artist(left_stripped, channel_folded):
    """Collapse collaboration credits to the first artist.

    Splits on comma and ' x '/' X ' only (never '&', which appears only in
    band names in the real corpus: Chino & Nacho, Earth Wind & Fire, etc).
    Band guards (uploader-independent): if the left side contains '&', it's
    a band name; if the channel name equals the whole left side, it's also
    one artist's name. Either way, keep it whole and don't split.
    """
    left_folded = _fold(left_stripped)
    # Band guard 1: '&' means band name (uploader-independent)
    # Every '&' in the corpus is a band; no genuine collab contains '&'.
    if '&' in left_stripped:
        return left_folded  # It's a band name, keep it whole
    # Band guard: channel matches the whole left side (after folding both)
    if channel_folded and left_folded == channel_folded:
        return left_folded  # It's a band name, keep it whole

    # Split on comma or ' x '/' X ' (case-insensitive)
    # Never split on '&' - all four occurrences in corpus are band names
    parts = re.split(r',\s*|\s+x\s+', left_stripped, flags=re.IGNORECASE)
    if parts and len(parts) > 1:
        # Take first credit and fold it
        return _fold(parts[0])

    # No split happened, return the folded whole thing
    return left_folded


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
        # right. Only the channel can tell us that. Strip bracketed qualifiers
        # and featured artists before comparing, so "UWAIE - Kapo (Video Oficial)"
        # on channel Kapo still reverses.
        right_stripped = _BRACKETS.sub(' ', right)
        right_stripped = _FEAT.sub(' ', right_stripped)
        if channel_folded and _fold(right_stripped) == channel_folded:
            return channel_folded, left
        # Otherwise the left side. This is both the dominant convention and the
        # `Walker #57` case, where the channel is a stranger and the title is
        # the only truth we have. Strip bracketed qualifiers, then collapse
        # collab credits to the first artist.
        left_stripped = _BRACKETS.sub(' ', left)
        artist = _first_artist(left_stripped, channel_folded)
        return _LEADING_THE.sub('', artist), right
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
    duration: float | None
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

    Subset matching is symmetric because which side is "stored" is just which was
    heard first. build_station_queue collapses songs to their best_id — the
    lowest-ranked upload, which is the Topic / Official Audio cut — so memory
    overwhelmingly holds short canonical titles while the variants (live, extended,
    sped up, soundtrack) arrive later carrying the extra tokens. A directional
    check refusing stored ⊂ query is exactly backwards for the common case, and
    refusing it means the station plays the same song twice. Symmetry also makes
    the memory order-independent: find(a) after add(b) must agree with find(b)
    after add(a), or the same pair are duplicates or not depending on which the
    mix offered first.
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


# --- Queue building ----------------------------------------------------------


def build_station_queue(entries, memories, cooldown_artists=(),
                        max_per_artist=MAX_TRACKS_PER_ARTIST, on_reject=None):
    """Turn raw mix entries into a varied, non-repeating queue.

    entries:  iterable of yt-dlp flat-extract dicts, in relevance order.
              The caller has already fetched and concatenated the seed mixes.
    memories: iterable of SongMemory to exclude against, consulted in order.
              Two in production — the station's own and the 7-day history —
              and the ladder's rungs 4 and 5 work by passing fewer of them.
    cooldown_artists: artists that should appear after fresh ones in the queue.
    max_per_artist: cap on tracks from one artist in the built queue.
    on_reject: optional callable(entry, reason) invoked for each candidate
              dropped by a *fuzzy* match ('exact'/'subset'/'overlap', never
              'id'). This is how the rejection log in Task 9 gets its data
              without this function knowing what a logger is.

    Returns a list of entries, each carrying an added 'id' rewritten to the
    best-ranked upload of that song.
    """
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
