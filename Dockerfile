# syntax=docker/dockerfile:1
#
# Mindeck core image — the same core as the desktop app, headless: API
# (HTTP + WebSocket, device pairing) and the web UI on one port. The mobile
# app and browsers connect here. All state lives as files under /data.
#
#   docker build -t mindeck .
#   docker run -p 127.0.0.1:7420:7420 -v mindeck-data:/data mindeck
#   docker exec <container> node out/server/index.cjs pair   # pairing code

# The full image ships python3/make/g++: node-pty has no Linux prebuilds and
# compiles here. Electron itself is not needed.
# Base images are pinned by digest (the multi-arch index of the tag named in
# front of it): a rebuild gets the same bytes. To update, take the new digest of
# the tag (`docker buildx imagetools inspect node:26-bookworm`) — Dependabot
# proposes it (.github/dependabot.yml).
FROM node:26-bookworm@sha256:b7087bc4d973034b30854b378ba107f9fab622b47514cb7e2592e41b8bab8d49 AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --no-audit --no-fund
COPY . .
# Mindeck Cloud for this image (license + sign-in), baked in at build time —
# with it, the image requires a license (no run-time variable turns that off):
#   docker build --build-arg MINDECK_CLOUD_URL=https://api.example.com --build-arg MINDECK_CLOUD_KEY=… .
ARG MINDECK_CLOUD_URL=
ARG MINDECK_CLOUD_KEY=
RUN npm run web:build && npm run server:build && npm prune --omit=dev

FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1
WORKDIR /app
# git for project detection (and the opt-in remote terminal). Overridable,
# e.g. --build-arg APT_PACKAGES= where no Debian mirror is reachable.
ARG APT_PACKAGES="git ca-certificates"
RUN if [ -n "$APT_PACKAGES" ]; then \
      apt-get update && apt-get install -y --no-install-recommends $APT_PACKAGES \
      && rm -rf /var/lib/apt/lists/*; \
    fi \
  && mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/out/server ./out/server
COPY --from=build --chown=node:node /app/out/web ./out/web
USER node
ENV NODE_ENV=production \
  MINDECK_HOME=/data \
  MINDECK_PORT=7420 \
  MINDECK_LAN=1 \
  SHELL=/bin/bash
EXPOSE 7420
VOLUME ["/data"]
# Plain HTTP is fine here: inside the container 127.0.0.1 is the core's own loopback.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:7420/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "out/server/index.cjs"]
