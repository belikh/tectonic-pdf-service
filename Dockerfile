# syntax=docker/dockerfile:1
# LaTeX to PDF service. Build for Cloudflare Containers, which run linux/amd64:
#   npm run vendor        (copies the Jupiter style, fonts and graphics into ./jupiter)
#   docker build --platform linux/amd64 -t tectonic-pdf-service .
# This Dockerfile has not been built: Docker was not available where it was written. See README.md.

ARG NODE_IMAGE=node:22-slim

# ---- Stage 1: download and verify Tectonic -------------------------------------------------------------------------
FROM --platform=linux/amd64 ${NODE_IMAGE} AS tectonic
ARG TECTONIC_VERSION=0.17.0
# SHA-256 of tectonic-0.17.0-x86_64-unknown-linux-musl.tar.gz, computed from the release download. Re-check it against
# the release page before the first build, and change it together with TECTONIC_VERSION.
ARG TECTONIC_SHA256=8533d07f9ccbd7a65824b9e0459041bca34af1eb33daba48f59215593753a3b7
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    f="tectonic-${TECTONIC_VERSION}-x86_64-unknown-linux-musl.tar.gz"; \
    curl -fsSL -o "/tmp/$f" "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/$f"; \
    echo "${TECTONIC_SHA256}  /tmp/$f" | sha256sum -c -; \
    mkdir /out; tar -xzf "/tmp/$f" -C /out tectonic; \
    /out/tectonic --version

# ---- Stage 2: fill the Tectonic cache -------------------------------------------------------------------------------
# Needs network. The result is a cache of the bundle files and the XeLaTeX format that the Jupiter style uses.
FROM --platform=linux/amd64 ${NODE_IMAGE} AS warm
ARG MIN_CACHE_MB=40
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=tectonic /out/tectonic /usr/local/bin/tectonic
COPY jupiter/ /opt/jupiter/
COPY warmup/ /opt/warmup/
ENV TECTONIC_CACHE_DIR=/opt/tectonic-cache
RUN mkdir -p "$TECTONIC_CACHE_DIR" && sh /opt/warmup/warm.sh /opt/jupiter "${MIN_CACHE_MB}"

# ---- Stage 3: run-time image ----------------------------------------------------------------------------------------
FROM --platform=linux/amd64 ${NODE_IMAGE}
# Unprivileged user. It has no login shell and owns nothing but its home.
RUN groupadd --gid 10001 app && useradd --uid 10001 --gid app --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin app

COPY --from=tectonic /out/tectonic /usr/local/bin/tectonic
# The build fails here when the binary does not run in this base image.
RUN tectonic --version | grep -q "Tectonic 0.17.0"

# Cache and Jupiter files are owned by root and not writable: the service reads them and writes nothing there.
COPY --from=warm /opt/tectonic-cache /opt/tectonic-cache
COPY jupiter/ /opt/jupiter/
RUN chown -R root:root /opt/tectonic-cache /opt/jupiter && chmod -R a-w,a+rX /opt/tectonic-cache /opt/jupiter \
    && test -f /opt/jupiter/jupiter.sty && test -f /opt/jupiter/sgi-text-400.otf \
    && size="$(du -sm /opt/tectonic-cache | cut -f1)" && echo "tectonic cache: ${size} MB" && test "$size" -ge 40

WORKDIR /srv/pdf-service
COPY package.json ./
COPY src/ ./src/

# No secret is built into the image or passed at run time: the Worker's Durable Object does authentication.
ENV NODE_ENV=production \
    PORT=8080 \
    TECTONIC_BIN=/usr/local/bin/tectonic \
    TECTONIC_CACHE_DIR=/opt/tectonic-cache \
    JUPITER_DIR=/opt/jupiter
USER app
EXPOSE 8080
CMD ["node", "src/index.mjs"]
