#!/usr/bin/env python3
"""Reproduce the diagnosis from task-14-brief.md"""

import sys
sys.path.insert(0, '/Users/jose.munoz/Documents/youtube to sonos')

from songs import attribute, _fold, _split_title, _BRACKETS

# The two entries from the brief
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

print("=" * 80)
print("DIAGNOSIS 1: Different artist buckets")
print("=" * 80)

played_song = attribute(played)
queued_song = attribute(queued)

print(f"PLAYED : artist={played_song.artist!r}, tokens={played_song.tokens}")
print(f"QUEUED : artist={queued_song.artist!r}, tokens={queued_song.tokens}")
print()

print("=" * 80)
print("DIAGNOSIS 2: Why line 137 fails")
print("=" * 80)

# Simulate what _split_title sees for the queued entry
from songs import _channel_name
channel_folded = _channel_name(queued)
right_side_raw = 'Kapo (Video Oficial)'

print(f"channel_folded      : {channel_folded!r}")
print(f"right side raw      : {right_side_raw!r}")
print(f"_fold(right)        : {_fold(right_side_raw)!r}")
print(f"equality check used : {_fold(right_side_raw) == channel_folded}")

# Show what happens with brackets gone
right_stripped = _BRACKETS.sub(' ', right_side_raw)
print(f"with brackets gone  : {_fold(right_stripped)!r} -> {_fold(right_stripped) == channel_folded}")
print()
