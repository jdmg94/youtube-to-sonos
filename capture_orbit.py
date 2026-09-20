"""Capture a seed's radius-2 mix neighbourhood as test fixtures.

    .venv/bin/python capture_orbit.py <seed_id> [<seed_id> ...]

Writes `testdata/orbit/<seed>/<id>.json`, one file per RD mix: `<seed>.json`
is the anchor's own mix (radius 1) and the rest are the mixes of each track in
it (radius 2). That shape is what lets a test answer "how far from the seed is
this track?" — which no existing fixture can, and which is the whole reason
four fixes for station drift shipped against a green suite.

Resumable: an already-captured mix is skipped, so a run interrupted by a
rate-limit can be repeated. Entries are trimmed to the six fields
`songs.attribute` and `version_rank` actually read, which takes the corpus
from tens of MB to hundreds of KB — the rest of yt-dlp's flat output is
thumbnails and URLs no selection code looks at.

This is a developer tool, not part of the app. It is not in the Containerfile
and nothing imports it.
"""
import json
import os
import sys
import time

import app

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'testdata', 'orbit')
# Politeness between fetches. A radius-2 capture is ~51 extractions per seed;
# YouTube's bot heuristics notice that rate without a gap, and a capture that
# earns a block costs far more than the minute this adds.
DELAY = float(os.environ.get('CAPTURE_DELAY', 1.5))
FIELDS = ('id', 'title', 'uploader', 'channel', 'channel_id', 'duration')


def trim(entry):
    """Just the fields selection reads. See songs.attribute / version_rank."""
    return {k: entry.get(k) for k in FIELDS}


def capture(video_id, path):
    """Fetch and store one RD mix. Returns its entries, or [] on failure."""
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    # refresh=True: _MIX_CACHE would otherwise hand back the anchor's mix for a
    # radius-2 seed we just saw listed in it, silently capturing a duplicate.
    entries = app.get_radio_mix(video_id, refresh=True)
    if not entries:
        return []
    trimmed = [trim(e) for e in entries if e.get('id')]
    tmp = path + '.part'
    with open(tmp, 'w') as f:
        json.dump(trimmed, f, indent=1)
    os.replace(tmp, path)      # never leave a half-written fixture behind
    time.sleep(DELAY)
    return trimmed


def capture_orbit(seed):
    """The anchor's mix, then the mix of every track in it."""
    root = os.path.join(OUT, seed)
    os.makedirs(root, exist_ok=True)

    print(f"[{seed}] radius 1 ...")
    radius1 = capture(seed, os.path.join(root, seed + '.json'))
    if not radius1:
        print(f"[{seed}] FAILED: no mix for the anchor itself", file=sys.stderr)
        return

    ids = [e['id'] for e in radius1 if e.get('id') != seed]
    print(f"[{seed}] radius 1 holds {len(radius1)} tracks; "
          f"fetching {len(ids)} radius-2 mixes")
    ok = 0
    for i, vid in enumerate(ids, 1):
        entries = capture(vid, os.path.join(root, vid + '.json'))
        if entries:
            ok += 1
        print(f"[{seed}] {i}/{len(ids)} {vid} "
              f"{'ok' if entries else 'EMPTY'}", flush=True)
    print(f"[{seed}] done: {ok}/{len(ids)} radius-2 mixes captured")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        raise SystemExit(2)
    for s in sys.argv[1:]:
        capture_orbit(s)
