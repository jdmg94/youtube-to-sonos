"""Find a YouTube player client whose media URL actually fetches, no cookies.

Run INSIDE the app container (it needs yt-dlp + deno):
    docker compose exec youtube-sonos python3 /tmp/probe.py [VIDEO_ID]

For each client it resolves the audio format, then range-requests the first
1 KiB of the signed URL twice: once as ffmpeg's default Lavf UA, once replaying
yt-dlp's own headers. That separates the two failure modes definitively:
Columns: `open` is the open-ended Range ffmpeg sends (expect 403), `head` is
the first KiB, and `deep` is a KiB past the 1 MiB mark. A client whose `head`
passes but `deep` fails hands out URLs that only serve an opening segment —
testing just the head is how you wrongly conclude such a URL "works".
"""
import sys, json, urllib.request, urllib.error, yt_dlp

VIDEO = sys.argv[1] if len(sys.argv) > 1 else 'dQw4w9WgXcQ'
CLIENTS = ['default', 'tv', 'web', 'web_safari', 'web_embedded', 'mweb',
           'android_vr', 'ios']
FMT = 'bestaudio[acodec=opus]/bestaudio[ext=m4a]/bestaudio/best'


def probe_range(url, headers, start, length):
    """Status for one bounded ranged GET."""
    h = dict(headers)
    h['Range'] = f'bytes={start}-{start + length - 1}'
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=h),
                                    timeout=25) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception as e:
        return type(e).__name__


def probe_openended(url, headers):
    """What ffmpeg's HTTP layer does: an open-ended Range."""
    h = dict(headers)
    h['Range'] = 'bytes=0-'
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=h),
                                    timeout=25) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception as e:
        return type(e).__name__


print(f"probing {VIDEO} (no cookies)\n")
print(f"{'client':<14}{'format':<10}{'clen':>10}  {'open':>5}{'head':>6}{'deep':>6}  verdict")
print("-" * 88)
winners = []
for client in CLIENTS:
    opts = {'quiet': True, 'no_warnings': True, 'format': FMT, 'noplaylist': True,
            'js_runtimes': {'deno': {'path': None}, 'node': {'path': None}}}
    if client != 'default':
        opts['extractor_args'] = {'youtube': {'player_client': [client]}}
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f'https://www.youtube.com/watch?v={VIDEO}',
                                    download=False)
    except Exception as e:
        print(f"{client:<14}{('EXTRACT FAIL: ' + str(e)[:60]):<26}")
        continue

    url, hdrs = info.get('url'), dict(info.get('http_headers') or {})
    if not url:
        for c in (info.get('requested_downloads') or []):
            if c.get('url'):
                url, hdrs = c['url'], dict(c.get('http_headers') or {})
                break
    if not url:
        print(f"{client:<14}{'no progressive URL (SABR)':<26}")
        continue

    clen = int(info.get('filesize') or info.get('filesize_approx') or 0)
    # head  = first KiB. deep = a KiB well past the 1 MiB mark, which is where
    # a URL that only serves an opening segment stops working. Testing only the
    # head is how you conclude "it works" about a URL that cannot finish.
    openended = probe_openended(url, hdrs)
    head = probe_range(url, hdrs, 0, 1024)
    deep_off = max(1024 * 1024 + 1, int(clen * 0.75)) if clen else 1024 * 1024 + 1
    deep = probe_range(url, hdrs, deep_off, 1024) if (not clen or deep_off < clen) else head

    if head in (200, 206) and deep in (200, 206):
        verdict = 'FULLY FETCHABLE'
        winners.append(client)
    elif head in (200, 206):
        verdict = f'only serves the opening segment (403 at {deep_off // 1024} KiB)'
    else:
        verdict = 'refused outright'
    print(f"{client:<14}{str(info.get('format_id')):<10}{clen:>10}  "
          f"{str(openended):>5}{str(head):>6}{str(deep):>6}  {verdict}")

print("\n" + "=" * 82)
print("columns: open = open-ended 'Range: bytes=0-' (what ffmpeg sends),")
print("         head = first KiB,  deep = a KiB past the 1 MiB mark\n")
if winners:
    print(f"Fully fetchable via plain ranged GETs: {','.join(winners)}")
else:
    print("No client yields a URL that plain ranged GETs can finish — which is\n"
          "expected, and is why the app has yt-dlp do the downloading rather\n"
          "than handing the URL to ffmpeg. Nothing to change unless downloads\n"
          "are actually failing.")
