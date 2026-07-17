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
# We use a build-arg to force cache invalidation here when updating.
# NOTE: the [default] extra pulls in yt-dlp-ejs — the JS challenge-solver
# scripts YouTube extraction now requires. Without it, signature/n solving
# fails and only storyboard images come back ("Requested format is not
# available"). Deno (installed above) is the JS runtime that runs these.
ARG UPDATE_DATE=unknown
RUN echo "Update key: ${UPDATE_DATE}" && \
    pip3 install --no-cache-dir --upgrade "yt-dlp[default]"

# Layer 4: Application code (frequently changed)
COPY templates/ templates/
COPY app.py .

EXPOSE 5000

ENV PORT=5000

CMD ["python3", "app.py"]
