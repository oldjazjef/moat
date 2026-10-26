# syntax=docker/dockerfile:1
#
# Moat Cloud: the server (API + dashboard from one origin). Build from the repository root:
#
#   docker build -f deploy/docker/Dockerfile -t moat-cloud:local .
#
# Nothing secret is baked in: no .env, no keys, no database (.dockerignore); the account key and
# the database URL arrive at run time (environment or MOAT_ACCOUNT_KEY_FILE / MOAT_DATABASE_URL_FILE).
#
# Base images are pinned by tag. A digest is not written here because it must be looked up at
# release time (`docker buildx imagetools inspect node:22.23.2-bookworm-slim`); pin it then, with
# the tag kept as a comment (SEC-57).

ARG NODE_VERSION=22.23.2

# ── build: the dashboard and the server, then only what runs ─────────────────────────────────
# The two build stages run on the machine that builds (`$BUILDPLATFORM`), never under QEMU: Node
# aborts under emulation (`uv__io_poll: Assertion errno == EEXIST`, the arm64 release build of
# 26.10.2026). What they produce is plain JavaScript (a webpack bundle, the dashboard, pure-JS
# packages: pg, libsodium as WebAssembly, the Prisma client; SQLite is Node's own), the same for
# every architecture. Only the runtime stage is built per target platform.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS build
ENV CI=true \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    NX_DAEMON=false
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm nx run web:build:cloud \
 && pnpm nx run api:build-cloud \
 && node deploy/docker/stage-cloud.mjs /stage

# ── dependencies: production packages only, in the staged folder ─────────────────────────────
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS deps
RUN corepack enable
WORKDIR /stage
COPY --from=build /stage/package.json /stage/pnpm-workspace.yaml ./
RUN pnpm install --prod --no-frozen-lockfile --ignore-scripts

# ── runtime ──────────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG MOAT_VERSION=0.0.0-dev
ARG MOAT_COMMIT=unknown
LABEL org.opencontainers.image.title="Moat Cloud" \
      org.opencontainers.image.description="Moat Cloud: dashboard and management API from one origin" \
      org.opencontainers.image.source="https://github.com/oldjazjef/moat" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${MOAT_VERSION}" \
      org.opencontainers.image.revision="${MOAT_COMMIT}"
ENV NODE_ENV=production \
    AUTH_MODE=cloud \
    HOST=0.0.0.0 \
    PORT=3000 \
    MOAT_WEB_DIR=/app/web \
    MOAT_DATA_DIR=/data
WORKDIR /app
# Root-owned and read-only for the process: the application cannot change its own code. Only
# /data (SQLite deployments, kept for later use) belongs to the unprivileged user; the root
# file system can be mounted read-only (`read_only: true`), /tmp as tmpfs.
COPY --from=deps --chown=root:root /stage/node_modules ./node_modules
COPY --from=build --chown=root:root /stage/main.js /stage/package.json ./
COPY --from=build --chown=root:root /stage/web ./web
RUN mkdir /data && chown 1000:1000 /data && chmod 700 /data
USER 1000:1000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "main.js"]
