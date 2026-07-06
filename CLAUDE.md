# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Flask app that streams YouTube audio to Sonos speakers on the LAN. It runs as a Podman container on a Fedora server (systemd Quadlet), but can also run locally.

## Commands

```bash
make run-local      # local dev: uv venv + install deps + run app.py (PORT=5000 default)
make build          # build the Podman image
make run            # run container in foreground with --network=host
make update-ytdlp   # rebuild only the yt-dlp layer (fixes YouTube extractor breakage / 403s)
make install-quadlet  # install as system-wide systemd service (requires sudo)
```

There are no tests or linters configured.

Note: `app.py` defaults to `PORT=8080` when run directly, but the Makefile, Containerfile, and Quadlet all set `PORT=5000`.

## Architecture

Everything lives in two files: `app.py` (backend) and `templates/index.html` (single-page UI with inline CSS/JS, ~2300 lines).

### Streaming pipeline (the core flow)

1. `POST /api/play` — resolves the YouTube video via yt-dlp, picks a Sonos speaker (soco), and tells it to play `http://STREAM_HOST:PORT/stream/<video_id>.mp3?autoplay=...` via UPnP (`play_uri` with `force_radio=True`). The Sonos speaker then pulls the stream directly from this server.
2. `GET /stream/<video_id>.mp3` (app.py:441) — a generator that yt-dlp-extracts the direct audio URL, pipes it through `ffmpeg` to chunked MP3 (`transcode_to_mp3`), and yields it. With `autoplay=1` (default), when a track ends it refills its queue from YouTube's radio mix (`RD<video_id>` playlist via `get_radio_mix`) and keeps streaming as one endless "station".

### Now-playing state

Sonos only sees one endless radio URL, so it can't report which autoplay track is live. The module-level `CURRENT_STREAM` dict (app.py:41) is updated by the stream generator and merged into `/api/now-playing` responses and the `/api/events` SSE stream (server polls the speaker and emits only on state change). This is why the app is single-process/threaded — `CURRENT_STREAM` is shared in-process state.

### Sonos discovery

`soco.discover()` uses SSDP multicast, which is why the container must run with `--network=host` (multicast doesn't cross network namespaces). `STREAM_HOST` env var overrides auto-detected LAN IP when the host has multiple NICs — Sonos must be able to reach this IP to pull the stream.

### Other endpoints

`/api/devices` (SSDP scan), `/api/info` (metadata only), `/api/next` (resolve next autoplay track, excluding already-played ids passed by the client), `/api/stop`, `/api/volume` (GET/POST). Most endpoints fall back to the first discovered speaker when `device_ip` is omitted.

### Container layering

The Containerfile is deliberately layered so yt-dlp (which breaks often and needs frequent updates) sits in its own layer, invalidated via the `UPDATE_DATE` build-arg — this is what `make update-ytdlp` does. The image also installs deno, required by yt-dlp for YouTube extraction.
