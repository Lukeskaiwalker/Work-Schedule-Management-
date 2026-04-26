# Multi-stage build that produces a single container responsible for:
#   1. Serving the Vite-built SPA static files with proper cache policy
#   2. Reverse-proxying /api/* to the api service
#   3. Rendering a maintenance page when /srv/maintenance/.flag exists
#
# Replaces the older "web (nginx)" + "caddy" two-container split. One image,
# one config dialect (Caddyfile), one TLS termination point (or none, when
# Traefik fronts us in production — see docker-compose.traefik.yml).

# ── Stage 1: build the SPA ──────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

# Copy package manifests first so layer caching survives source-only edits.
COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

# ── Stage 2: caddy serving image ────────────────────────────────────────────
FROM caddy:2.10.2-alpine

# SPA assets at /srv/web — served by Caddy's file_server with a try_files
# fallback so client-side routes (/admin, /time, etc.) resolve to index.html.
COPY --from=builder /app/dist /srv/web

# The Caddyfile is baked into the image so the running config is immutable
# and reviewable in git. Env vars (SMPL_API_UPSTREAM) supply the only
# runtime knobs; maintenance mode is driven by a runtime-mounted flag file.
COPY Caddyfile /etc/caddy/Caddyfile

# /srv/maintenance is bind-mounted from ./infra/maintenance at runtime so
# safe_update.sh can toggle the .flag file (and edit the page) without
# rebuilding. Create the directory here so the mount target exists even
# when no host directory is provided.
RUN mkdir -p /srv/maintenance

EXPOSE 80 443
