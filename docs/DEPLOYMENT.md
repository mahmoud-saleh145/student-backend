# Deployment

Development, staging and production are genuinely different here — the Docker
Compose file in the repository root is a local convenience and is **not** a
production topology. This document says what changes between them and why.

---

## 1. The three environments

| | Development | Staging | Production |
| --- | --- | --- | --- |
| Postgres | Compose container | Managed, small | Managed, HA, PITR backups |
| Redis | Compose container | Managed | Managed, persistence on |
| Object storage | MinIO | R2, separate bucket | R2, production bucket |
| Media edge | none (presigned S3 fallback) | Worker, staging route | Worker, production route |
| API replicas | 1 | 1 | ≥2 behind a balancer |
| Worker replicas | 1 | 1 | ≥1, scaled on queue depth |
| Swagger | on | on | off unless `ENABLE_SWAGGER=true` |
| Logs | pretty | JSON | JSON, shipped |
| Seed | yes | optional | **never** |

The single most important difference: in development,
`MEDIA_CDN_BASE_URL` is empty and the storage service falls back to plain S3
presigned URLs. Those URLs are **not viewer-bound**. The service logs a warning
every time it issues one. Production must set the CDN base URL and run the
edge Worker, or the central protection of the whole video design is absent.

---

## 2. Local development

```bash
docker compose up -d postgres redis minio
cp .env.example .env
npm install
npm run db:setup
npm run bootstrap:master
npm run start:dev      # terminal 1
npm run worker:dev     # terminal 2
```

Or run everything in Compose:

```bash
docker compose up --build
```

The `api` and `worker` services mount the source directory, so both hot-reload.
They deliberately run as separate services rather than one process with
`RUN_WORKERS=true`, because that is the topology production uses and local
development should not diverge from it.

MinIO stands in for R2. It speaks the same S3 API; the only difference the code
cares about is path-style addressing, which `StorageService` enables
automatically when the endpoint contains `minio`.

---

## 3. Production topology

```
                    ┌──────────────┐
   clients ────────►│ Load balancer│  TLS terminates here
                    └───┬──────────┘
                        │
              ┌─────────▼─────────┐
              │  API  ×N          │  stateless, RUN_WORKERS unset
              └───┬───────────┬───┘
                  │           │
        ┌─────────▼──┐   ┌────▼──────┐
        │ Postgres   │   │  Redis    │
        │ primary    │   │           │
        │ + replica  │   └────▲──────┘
        └────────────┘        │
                              │ queue
                    ┌─────────┴────────┐
                    │  Worker ×M       │  RUN_WORKERS=true, ffmpeg, scratch disk
                    └─────────┬────────┘
                              │
                    ┌─────────▼────────┐      ┌─────────────────┐
                    │ Cloudflare R2    │◄─────┤  Edge Worker    │◄── players
                    │ (private)        │      │  (signature)    │
                    └──────────────────┘      └─────────────────┘
```

### Sizing, as a starting point

For roughly 5 000 students and 50 courses:

| Component | Start with |
| --- | --- |
| API | 2 × (1 vCPU, 1 GB) |
| Worker | 1 × (4 vCPU, 8 GB, 100 GB disk) |
| Postgres | 2 vCPU, 4 GB, 100 GB SSD |
| Redis | 1 GB |
| R2 | pay per GB; budget ~1.5 GB per hour of 1080p source after transcode |

The worker is the expensive box and the one to scale first. Transcoding a
one-hour 1080p lecture into the four-rung ladder takes roughly 20–40 minutes on
4 vCPUs, and it needs several times the source size in scratch space while it
works.

The API is small because it never touches media bytes.

---

## 4. Required environment

Everything in `.env.example` is documented inline. What is genuinely required
in production:

```bash
NODE_ENV=production
PUBLIC_API_URL=https://api.example.com
CORS_ORIGINS=https://admin.example.com     # never "*"
TRUST_PROXY=true                           # you are behind a balancer

DATABASE_URL=postgresql://…?schema=public&connection_limit=10&pool_timeout=20
REDIS_URL=rediss://…

# five distinct secrets — see below
JWT_ACCESS_SECRET=…
JWT_REFRESH_SECRET=…
JWT_PLAYBACK_SECRET=…
HLS_KEY_ROOT=…
MEDIA_SIGNING_KEY=…

R2_ACCOUNT_ID=…
R2_ACCESS_KEY_ID=…
R2_SECRET_ACCESS_KEY=…
R2_BUCKET_MEDIA=edu-media-prod
R2_BUCKET_UPLOADS=edu-uploads-prod
MEDIA_CDN_BASE_URL=https://media.example.com/

LOG_LEVEL=info
LOG_PRETTY=false
```

Generate the secrets:

```bash
for v in JWT_ACCESS_SECRET JWT_REFRESH_SECRET JWT_PLAYBACK_SECRET \
         HLS_KEY_ROOT MEDIA_SIGNING_KEY; do
  echo "$v=$(openssl rand -base64 48 | tr -d '\n')"
done
```

The application validates all of this at boot and **refuses to start** if a
required value is missing, malformed, or still a `CHANGE_ME` placeholder. A
crash at deploy time is a far better outcome than serving traffic signed with a
default key.

### Connection pooling

`connection_limit` in the URL is per-process. Total connections are
`replicas × connection_limit`, and it must stay below the database's
`max_connections` with headroom for migrations and manual sessions. Two API
replicas at 10 plus one worker at 5 is 25 — comfortable against a default of
100.

If you scale beyond roughly 10 replicas, put PgBouncer in transaction mode in
front and add `?pgbouncer=true` to the URL so Prisma disables prepared
statements.

---

## 5. Deploying

### Build

```bash
docker build --target production -t edu-backend:$(git rev-parse --short HEAD) .
```

One image runs both roles. The worker deployment differs only in its command
and environment:

| | API | Worker |
| --- | --- | --- |
| Command | `node dist/main.js` | `node dist/worker.js` |
| `RUN_WORKERS` | unset | `true` |
| Ports | 3000 | none |
| Disk | minimal | ≥100 GB scratch |

### Migrations

Run `npx prisma migrate deploy` as a **separate step before** the new version
starts — never as part of the application's own startup. Two replicas booting
simultaneously and both running migrations is a race with an unpleasant
resolution.

```bash
# release job
npx prisma migrate deploy
# then roll the API, then the worker
```

Migrations must be backwards-compatible with the version currently running,
because for a few minutes both are live. The expand/contract pattern:

1. **Expand** — add the nullable column, deploy code that writes both.
2. **Backfill** — a job, not a migration.
3. **Contract** — a later release makes it non-null and drops the old column.

A single migration that renames a column will break every request served by the
old replicas during the rollout.

### Order of operations for a release

1. `prisma migrate deploy`
2. Roll the API (rolling, health-gated)
3. Roll the worker
4. Verify `/api/v1/meta/health/deep`

Worker last, because a new worker may enqueue job shapes an old API cannot
serve, and the reverse is safe.

---

## 6. Health checks

| Endpoint | Use for | Checks |
| --- | --- | --- |
| `/api/v1/meta/health` | liveness and readiness probes | database only |
| `/api/v1/meta/health/deep` | monitoring and dashboards | database, Redis, storage |

Point the orchestrator at the **shallow** one. A liveness probe that fails on a
Redis blip restarts every replica at once, turning a partial degradation into a
total outage. Redis being down should degrade rate limiting and queueing, not
take the API offline.

Suggested probe timings: readiness every 10 s with a 3 s timeout; liveness
every 30 s with 3 failures before a restart; start period 20 s.

---

## 7. The media edge Worker

Required in production. Full source and setup in
[`cloudflare-worker.js`](cloudflare-worker.js).

```bash
npm create cloudflare@latest edu-media-gate
# replace src/index.js with docs/cloudflare-worker.js
wrangler secret put MEDIA_SIGNING_KEY   # identical to the API's value
wrangler deploy
```

Bind the R2 bucket as `MEDIA`, set `API_ORIGIN` and `TICKET_CHECK=true`, route
it at `media.example.com`, and set `MEDIA_CDN_BASE_URL=https://media.example.com/`
in the API.

**The bucket must have no public read access.** Verify:

```bash
curl -I https://media.example.com/hls/anything/master.m3u8     # → 403
curl -I https://<account>.r2.cloudflarestorage.com/edu-media-prod/x  # → 401/403
```

If either returns 200, the entire video protection design is bypassed and
nothing else in this document matters.

---

## 8. Backups

| What | How | Target |
| --- | --- | --- |
| Postgres | Managed automated backups + PITR | RPO 5 min, RTO 1 h |
| R2 | Bucket versioning + lifecycle | 30-day retention on deletes |
| Redis | Not backed up | It holds only reconstructible state |

Restore drills belong on the calendar, not in a document. A backup that has
never been restored is a hypothesis.

Nothing in this system deletes financial history, and the FKs make it
impossible at the database level — but that protects against application bugs,
not against `DROP DATABASE`. Keep the backups.

---

## 9. Monitoring

Worth alerting on:

| Signal | Threshold | Because |
| --- | --- | --- |
| 5xx rate | > 1% over 5 min | Something is broken |
| p99 latency | > 2 s | Usually a missing index or pool exhaustion |
| `video` queue depth | > 20 or rising | Worker under-provisioned |
| Failed transcodes | any | Teachers are waiting on those |
| DB connections | > 80% of max | Pool misconfiguration |
| `SecurityEvent` CRITICAL | any | `TOKEN_REUSE` means a stolen token |
| Auth failures | sudden spike | Credential stuffing |
| Disk on worker | > 80% | Transcodes will start failing |

Log every response with its `requestId`; it is the join key between a student's
support screenshot and the trace.

Do **not** alert on individual `DEVICE_MISMATCH` events. One is a student with
a new phone. Alert on the rate.

---

## 10. Scaling notes

**API** — stateless; scale horizontally. Sessions are in Postgres, rate limits
and stream slots in Redis, so nothing is pinned to a replica.

**Worker** — scale on `video` queue depth. Each concurrent transcode wants
2–4 vCPUs and tens of GB of scratch, so scale by adding boxes rather than
raising per-box concurrency.

**Postgres** — the first bottleneck will be catalogue and search reads. In
order: check the indexes exist, then apply
`prisma/optional/001_search_trigram.sql`, then add a read replica and point
analytics at it via `DATABASE_REPLICA_URL`.

**Redis** — one instance handles far more than this workload needs. Keys are
short-lived; memory is not a concern before tens of thousands of concurrent
streams.

---

## 11. Runbook: common incidents

**Videos stuck in PROCESSING.** Check the worker is running and
`RUN_WORKERS=true`, check ffmpeg exists in the image, check scratch disk. Retry
with `POST /videos/:id/retry`.

**Every media request returns 403.** Almost always `MEDIA_SIGNING_KEY`
differing between the API and the Worker. They must be rotated together.

**Students report being signed out repeatedly.** Check whether
`credentialsChangedAt` is being bumped unintentionally, and check for
refresh-token reuse detection firing — the family revoke is deliberate, but a
client bug that replays a refresh token will trigger it constantly.

**`CONCURRENT_STREAM_LIMIT` for a single user on one device.** The app is not
calling `DELETE /playback/tickets/:id` on teardown. The slot clears after the
grace period; the fix is client-side.

**Rate limits triggering for everyone at one school.** They are behind one NAT
and `TRUST_PROXY` is off, so every request looks like it comes from the
balancer. Turn it on, and make sure the balancer overwrites `X-Forwarded-For`
rather than appending to it.
