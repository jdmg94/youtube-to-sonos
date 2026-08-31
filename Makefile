# Two deployables: the Flask API (Containerfile, repo root) and the Next.js UI
# (web/Dockerfile). `up` runs both; the single-container targets below build and
# run the API alone, which is still useful for poking at it with curl.
.PHONY: up down logs ps restart build rebuild update-ytdlp docker-update-ytdlp \
        run run-local web-dev web-check

IMAGE_NAME = youtube-sonos-streamer
# The API's port. Also interpolated into the UI's API_ORIGIN build arg by
# docker-compose.yml, so the two cannot drift.
PORT ?= 5000
# The UI's port — the one to open in a browser.
WEB_PORT ?= 3000


# --- compose (the deployment) ------------------------------------------------

# `--build` on purpose. Compose will happily start a stale image when the build
# context has changed, and the failure mode is a UI that looks fine and serves
# last week's bundle.
up:
	mkdir -p cache
	@test -f cookies.txt || { echo "cookies.txt missing — create it (even empty), or comment the mount out of docker-compose.yml and set COOKIES_FILE=\"\". A missing bind source becomes a root-owned *directory*."; exit 1; }
	docker compose up -d --build
	@echo "UI:  http://localhost:$(WEB_PORT)"
	@echo "API: http://localhost:$(PORT)/api/health"

down:
	docker compose down

logs:
	docker compose logs -f

ps:
	docker compose ps

restart:
	docker compose restart

# Force a from-scratch rebuild of both images. For when a cached layer is
# suspected of holding something stale that is not yt-dlp (see below).
rebuild:
	docker compose build --no-cache
	docker compose up -d


# --- yt-dlp ------------------------------------------------------------------
# YouTube breaks yt-dlp's extractor constantly, and downloading is entirely
# yt-dlp's job, so this is the first thing to try when downloads start failing.
# The build-arg is what busts the cached yt-dlp layer — a plain rebuild does
# NOT update yt-dlp, it just reuses the layer built the first time.
docker-update-ytdlp:
	UPDATE_DATE=$$(date +%s) docker compose up -d --build

# Same, for the standalone podman image below.
update-ytdlp:
	podman build --build-arg UPDATE_DATE=$$(date +%s) -t $(IMAGE_NAME) .


# --- API alone (no UI) -------------------------------------------------------

build:
	podman build -t $(IMAGE_NAME) .

run:
	mkdir -p cache
	@test -f cookies.txt || { echo "cookies.txt missing — create it, or drop the -v below and add -e COOKIES_FILE="; exit 1; }
	podman run -it --rm --network=host -e PORT=$(PORT) \
		-v ./cookies.txt:/app/cookies.txt:ro,z \
		-v ./cache:/app/cache:z $(IMAGE_NAME)

# Local dev backend. On macOS pass PORT=5001: ControlCenter (AirPlay Receiver)
# owns :5000 and answers every path with a bare 403, which surfaces in the UI as
# "Scan error: 403 Forbidden" and looks like a broken backend. Point the UI at
# the same port via API_ORIGIN in web/.env.local.
run-local:
	uv venv && . .venv/bin/activate && uv pip install -r requirements.txt && PORT=$(PORT) python app.py


# --- UI dev ------------------------------------------------------------------

web-dev:
	cd web && pnpm install && pnpm dev

# The gates, in the order that fails cheapest first.
web-check:
	cd web && pnpm test && pnpm typecheck && pnpm lint && pnpm build
