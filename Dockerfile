# syntax=docker/dockerfile:1

# -----------------------------------------------------------------------------
# base — ffmpeg is required by the transcoding worker, and the API image shares
# it so a single image can run either role.
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg openssl ca-certificates dumb-init \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production

# -----------------------------------------------------------------------------
# deps
# -----------------------------------------------------------------------------
FROM base AS deps
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --include=dev

# -----------------------------------------------------------------------------
# development — hot reload, full dev dependencies
# -----------------------------------------------------------------------------
FROM base AS development
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
EXPOSE 3000
CMD ["npm", "run", "start:dev"]

# -----------------------------------------------------------------------------
# build
# -----------------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build && npm prune --omit=dev

# -----------------------------------------------------------------------------
# production
# -----------------------------------------------------------------------------
FROM base AS production
ENV NODE_ENV=production
RUN groupadd -r app && useradd -r -g app -m app

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/prisma ./prisma
COPY --chown=app:app package.json ./

# The Prisma CLI is a runtime dependency (see package.json) because the release
# gate runs `prisma migrate status` inside this image. `npm prune --omit=dev`
# above would otherwise remove it and `npm run db:gate:prod` would fail with
# "prisma: not found" in exactly the environment the gate exists for.

USER app
EXPOSE 3000

# Role-aware: the API checks its HTTP endpoint, the worker checks its Redis
# heartbeat because it opens no listener. A single HTTP-only check here marked
# the worker permanently unhealthy and restarted it in a loop.
# See scripts/healthcheck.ts.
HEALTHCHECK --interval=30s --timeout=10s --start-period=45s --retries=3 \
  CMD node dist/scripts/healthcheck.js

ENTRYPOINT ["dumb-init", "--"]
# `nest build` emits to dist/src/ (prisma/ and scripts/ are compiled too, so
# the common root is the repository). dist/main.js never existed.
# Run the worker from this same image with: node dist/src/worker.js
CMD ["node", "dist/src/main.js"]
