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

USER app
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/meta/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
# `nest build` emits to dist/src/ (prisma/ and scripts/ are compiled too, so
# the common root is the repository). dist/main.js never existed.
# Run the worker from this same image with: node dist/src/worker.js
CMD ["node", "dist/src/main.js"]
