# Layer 1: Base image and system packages (heavy, cached)
FROM fedora:40

# Enable RPM Fusion (free) — provides the full ffmpeg build
RUN dnf install -y "https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm" && \
    dnf install -y --allowerasing python3 python3-pip ffmpeg unzip && \
    dnf clean all

# Install deno — required JS runtime for yt-dlp YouTube extraction
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh


# Set up working directory
WORKDIR /app

# Layer 2: Python requirements (Flask, soco)
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

# Layer 3: yt-dlp (frequently updated, isolated)
# We use a build-arg to force cache invalidation here when updating
ARG UPDATE_DATE=unknown
RUN echo "Update key: ${UPDATE_DATE}" && \
    pip3 install --no-cache-dir --upgrade yt-dlp

# Layer 4: Application code (frequently changed)
COPY templates/ templates/
COPY app.py .

EXPOSE 5000

ENV PORT=5000

CMD ["python3", "app.py"]
