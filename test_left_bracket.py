#!/usr/bin/env python3
"""Test whether left-side brackets cause an issue"""

import sys
sys.path.insert(0, '/Users/jose.munoz/Documents/youtube to sonos')

from songs import attribute

# Test case from the brief: "[Official Video] Kapo - UWAIE"
entry = {
    'id': 'test_id',
    'title': '[Official Video] Kapo - UWAIE',
    'uploader': 'Kapo',
    'duration': 192
}

song = attribute(entry)
print(f"Title: {entry['title']}")
print(f"Artist: {song.artist!r}")
print(f"Tokens: {song.tokens}")
print()

# Another example: "(Official) Kapo - UWAIE"
entry2 = {
    'id': 'test_id2',
    'title': '(Official) Kapo - UWAIE',
    'uploader': 'Kapo',
    'duration': 192
}

song2 = attribute(entry2)
print(f"Title: {entry2['title']}")
print(f"Artist: {song2.artist!r}")
print(f"Tokens: {song2.tokens}")
