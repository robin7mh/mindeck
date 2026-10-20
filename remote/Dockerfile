# syntax=docker/dockerfile:1
#
# The Mindeck server package for Remote-SSH and Dev Containers: the headless
# core (API + web UI), its production node_modules (node-pty built for
# Linux) and Node itself — unpacked on the remote machine and started there by
# the desktop app. bullseye: glibc 2.31, runs on most Linux servers.
#
#   npm run remote:bundle        → out/remote/mindeck-server-<version>-linux-<arch>.tar.gz

FROM node:22-bullseye AS build
WORKDIR /app
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
  && node -p "require('./package.json').version" > /pkg/VERSION

FROM scratch
COPY --from=build /pkg /
