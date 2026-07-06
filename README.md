# YouTube → Sonos Streamer

Stream any YouTube video's audio to a Sonos speaker on your LAN.
Designed to run as a containerised service on a **Fedora server with Podman**.

---

## Architecture

```
 ┌──────────────┐  YouTube URL  ┌────────────────────────────────────────┐
 │  Browser     │ ────────────► │   Podman container  (--network=host)   │
 │  (any host   │               │                                        │
 │   on LAN)    │               │   Flask                                │
 └──────────────┘               │   ├── /api/devices  → soco SSDP scan  │
                                │   ├── /api/play     → soco UPnP cmd   │
                                │   ├── /api/stop     → soco UPnP cmd   │
                                │   └── /stream/<id>  → MP3 HTTP stream │
                                │          ▲                             │
                                │   yt-dlp │ → ffmpeg → chunked MP3     │
                                └──────────┼─────────────────────────────┘
                                           │ UPnP SetAVTransportURI
                                           ▼
                                    ┌────────────┐
                                    │  Sonos     │ ◄── pulls /stream/*
                                    │  Speaker   │     directly over LAN
                                    └────────────┘
```

### Why --network=host is required

Sonos discovery uses SSDP — UDP multicast to 239.255.255.250:1900.
Multicast does not cross network-namespace boundaries, so Podman's default
bridge/slirp4netns modes silently drop every discovery packet. With
--network=host the container shares the host's full network stack, so:

- SSDP multicast works identically to a bare-metal process
- Sonos can connect back to the Flask HTTP stream using the host's LAN IP
- No port-forwarding rules or firewall exceptions are needed for discovery

---

## Prerequisites

**Podman is pre-installed on Fedora** (Fedora 44 ships with Podman 5.8.x).
If `make` is missing on a minimal server install:

```bash
sudo dnf install -y make
```

`ffmpeg` and `yt-dlp` live inside the container image — no host install needed.

---

## Quick start

```bash
# 1. Clone and enter the project
git clone https://github.com/yourname/youtube-sonos-streamer
cd youtube-sonos-streamer

# 2. Build the image
make build

# 3. Run in the foreground to test
make run
# → open http://<server-LAN-IP>:5000 from any browser on your LAN
```

Press Ctrl-C to stop the test run.

---

## Permanent service via systemd Quadlet

Quadlets are Podman's native systemd integration (Podman >= 4.4, Fedora 38+).
A .container file replaces both a docker-compose.yml and a hand-written
systemd unit.

### System-wide service (runs as root)

```bash
make install-quadlet
# equivalent to:
#   sudo cp quadlet/youtube-sonos.container /etc/containers/systemd/
#   sudo systemctl daemon-reload
#   sudo systemctl enable --now youtube-sonos
```

Check it:

```bash
sudo systemctl status youtube-sonos
journalctl -u youtube-sonos -f
```

### Rootless service (runs as your user)

```bash
mkdir -p ~/.config/containers/systemd
cp quadlet/youtube-sonos.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user enable --now youtube-sonos
```

Note on rootless + --network=host:
Rootless Podman on Fedora supports --network=host but the container still
runs with your UID's privileges. SSDP multicast join (IP_ADD_MEMBERSHIP)
works fine without extra capabilities. If you see "permission denied" on the
multicast socket, switch to the system service install instead.

---

## Configuration

All configuration is via environment variables — set them in the Quadlet file
(Environment=) or on the podman run command line (-e).

| Variable     | Default  | Purpose                                                   |
|--------------|----------|-----------------------------------------------------------|
| PORT         | 5000     | TCP port Flask listens on                                 |
| STREAM_HOST  | (auto)   | LAN IP sent to Sonos as stream origin. Set this if your   |
|              |          | server has multiple NICs and auto-detection picks the     |
|              |          | wrong one (e.g. a management or VM bridge interface).     |

### Finding the right IP

```bash
# List all LAN-facing IPs on the host
ip -4 addr show | grep inet | grep -v 127
```

Then in /etc/containers/systemd/youtube-sonos.container:

```ini
[Container]
Environment=STREAM_HOST=192.168.1.42
```

After editing the Quadlet file:

```bash
sudo systemctl daemon-reload
sudo systemctl restart youtube-sonos
```

---

## Updating yt-dlp

YouTube's extractor breaks regularly. yt-dlp is isolated in its own image
layer so you can update it without invalidating the heavier ffmpeg/soco layers:

```bash
make update-ytdlp
sudo systemctl restart youtube-sonos
```

---

## REST API

```bash
SERVER=192.168.1.42:5000

# Discover speakers
curl http://$SERVER/api/devices

# Video metadata (fast, no download)
curl "http://$SERVER/api/info?url=https://youtu.be/dQw4w9WgXcQ"

# Play (omit device_ip to use first discovered speaker)
curl -X POST http://$SERVER/api/play \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://youtu.be/dQw4w9WgXcQ","device_ip":"192.168.1.55"}'

# Stop
curl -X POST http://$SERVER/api/stop \
  -H 'Content-Type: application/json' \
  -d '{"device_ip":"192.168.1.55"}'
```

---

## Firewall

```bash
sudo firewall-cmd --permanent --add-port=5000/tcp
sudo firewall-cmd --reload
```

Sonos pulls the stream from the server on the same port — one rule covers both UI and audio.

---

## SELinux

Running with --network=host and no host-path volume mounts, SELinux in
Enforcing mode (Fedora default) requires no extra policy changes.

If you add volume mounts later, append :z (shared) or :Z (private) so
SELinux labels the content correctly:

```ini
Volume=/srv/cache:/app/cache:z
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "No Sonos devices found" | Confirm speakers are on, same subnet. Test on host: python3 -c "import soco; print(list(soco.discover()))" |
| Sonos errors after a few seconds | DRM-protected or live source. Check journalctl -u youtube-sonos for ffmpeg errors. |
| Stream URL points to wrong IP | Set STREAM_HOST to the correct LAN interface IP. |
| yt-dlp 403 errors | Run make update-ytdlp |
| Port 5000 in use | Change PORT=8080 in Quadlet and rerun firewall-cmd |
| Rootless multicast denied | Switch to system-wide install (make install-quadlet) |

---

## Project structure

```
youtube-sonos-streamer/
├── Containerfile                    Podman image (layered for fast yt-dlp updates)
├── .containerignore                 Build context exclusions
├── app.py                           Flask app: streaming pipeline + Sonos UPnP control
├── templates/
│   └── index.html                   Single-page web UI
├── requirements.txt                 Python deps
├── quadlet/
│   └── youtube-sonos.container      systemd Quadlet unit file
├── Makefile                         build / run / update / install helpers
└── README.md
```
