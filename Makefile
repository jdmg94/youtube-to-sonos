.PHONY: build run update-ytdlp docker-update-ytdlp install-quadlet run-local

IMAGE_NAME = youtube-sonos-streamer
PORT ?= 5000

build:
	podman build -t $(IMAGE_NAME) .

run:
	mkdir -p cache
	@test -f cookies.txt || { echo "cookies.txt missing — create it, or drop the -v below and add -e COOKIES_FILE="; exit 1; }
	podman run -it --rm --network=host -e PORT=$(PORT) \
		-v ./cookies.txt:/app/cookies.txt:ro,z \
		-v ./cache:/app/cache:z $(IMAGE_NAME)

# YouTube breaks yt-dlp's extractor constantly, and downloading is entirely
# yt-dlp's job, so this is the first thing to try when downloads start failing.
# The build-arg is what busts the cached yt-dlp layer — a plain rebuild does
# NOT update yt-dlp, it just reuses the layer built the first time.
update-ytdlp:
	podman build --build-arg UPDATE_DATE=$$(date +%s) -t $(IMAGE_NAME) .

# Same thing for Docker Compose users.
docker-update-ytdlp:
	UPDATE_DATE=$$(date +%s) docker compose up -d --build

install-quadlet:
	sudo mkdir -p /etc/containers/systemd
	sudo cp quadlet/youtube-sonos.container /etc/containers/systemd/
	sudo systemctl daemon-reload
	sudo systemctl enable --now youtube-sonos

run-local:
	uv venv && . .venv/bin/activate && uv pip install -r requirements.txt && PORT=$(PORT) python app.py

