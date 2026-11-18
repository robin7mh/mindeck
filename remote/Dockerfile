# syntax=docker/dockerfile:1
#
# The Mindeck server package for Remote-SSH and Dev Containers: the headless
# core (API + web UI), its production node_modules (node-pty built for
# Linux) and Node itself — unpacked on the remote machine and started there by
# the desktop app. bullseye: glibc 2.31, runs on most Linux servers. Its images
# are no longer updated (Debian ended bullseye in August 2026): this one stays
# at Node 26.8 until the bundle builds against an old glibc some other way.
#
#   npm run remote:bundle        → out/remote/mindeck-server-<version>-linux-<arch>.tar.gz

# Pinned by digest, like the main Dockerfile: its node and modules run on the customers' hosts (Dependabot proposes the next one).
FROM node:26-bullseye@sha256:784b1bb050f6bf8ccfdc28d9d07ad07d15ab9d72eee5867f875ba219abec2611 AS build
WORKDIR /app
# patchelf: the node that comes along finds its libatomic next to it (see below).
RUN apt-get update && apt-get install -y --no-install-recommends patchelf && rm -rf /var/lib/apt/lists/*
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --no-audit --no-fund
COPY . .
ARG MINDECK_CLOUD_URL=
ARG MINDECK_CLOUD_KEY=
# The one server build that may follow the desktop's license (MINDECK_LICENSE=follower,
# set by the desktop when it starts it) — see electron/main/services/cloud/config.ts.
ENV MINDECK_FOLLOWER_BUILD=1
RUN npm run web:build && npm run server:build && npm prune --omit=dev \
  # Renderer-only packages: bundled into out/web already.
  && rm -rf node_modules/monaco-editor node_modules/react node_modules/react-dom node_modules/framer-motion \
    node_modules/lucide-react node_modules/@xterm node_modules/d3-force node_modules/marked node_modules/dompurify \
    node_modules/zustand node_modules/qrcode node_modules/@fontsource node_modules/@fontsource-variable \
  && mkdir -p /pkg/out \
  && cp -r out/server out/web /pkg/out/ && cp -r node_modules package.json /pkg/ \
  && cp "$(command -v node)" /pkg/node \
  # Node 26 links libatomic, which minimal hosts and dev containers lack: it comes along in lib/, and
  # node looks there ($ORIGIN) — not LD_LIBRARY_PATH, which every shell it starts would inherit.
  && mkdir -p /pkg/lib && cp -L "$(ldd /pkg/node | awk '/libatomic/ {print $3}')" /pkg/lib/libatomic.so.1 \
  && patchelf --set-rpath '$ORIGIN/lib' /pkg/node \
  && node -p "require('./package.json').version" > /pkg/VERSION

FROM scratch
COPY --from=build /pkg /
