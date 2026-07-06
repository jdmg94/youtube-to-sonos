.PHONY: build run update-ytdlp install-quadlet run-local

IMAGE_NAME = youtube-sonos-streamer
PORT ?= 5000

build:
	podman build -t $(IMAGE_NAME) .

run:
	podman run -it --rm --network=host -e PORT=$(PORT) $(IMAGE_NAME)

update-ytdlp:
	podman build --build-arg UPDATE_DATE=$$(date +%s) -t $(IMAGE_NAME) .

install-quadlet:
	sudo mkdir -p /etc/containers/systemd
	sudo cp quadlet/youtube-sonos.container /etc/containers/systemd/
	sudo systemctl daemon-reload
	sudo systemctl enable --now youtube-sonos

run-local:
	uv venv && . .venv/bin/activate && uv pip install -r requirements.txt && PORT=$(PORT) python app.py

