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
| Command | `node dist/src/main.js` | `node dist/src/worker.js` |
| `RUN_WORKERS` | unset | `true` |
| Ports | 3000 | none |
| Disk | minimal | ≥100 GB scratch |

### Migrations

Run `npx prisma migrate deploy` as a **separate step before** the new version
starts — never as part of the application's own startup. Two replicas booting
simultaneously and both running migrations is a race with an unpleasant
resolution.

```bash
# release job, inside the built image
npx prisma migrate deploy
npm run db:gate:prod      # must exit 0 before the new version rolls
# then roll the API, then the worker
```

Two spellings, one gate. `db:gate:prod` runs the compiled
`dist/scripts/migration-gate.js` and is the one that works in the production
image, where dev dependencies were pruned. `db:gate` runs the TypeScript source
through `ts-node` and is for a working copy. Same file, same three outcomes.

`npm run db:gate` applies nothing. It reports whether the database already
matches the migrations in this checkout and exits non-zero when it does not, so
a release that skipped the deploy step stops before the bad version starts
rather than after. Three outcomes:

| Exit | Meaning | Response |
|------|---------|----------|
| 0 | Schema matches this build | Roll |
| 1 | Unapplied migrations | Run `migrate deploy`, re-check, roll |
| 2 | Drift, a failed migration, or the database unreachable | Stop. `migrate deploy` will not fix this — reconcile by hand |

Exit 2 is also what you get when `DATABASE_URL` is missing or the database is
unreachable. The gate fails closed on purpose: "I could not check" is never
reported as "safe to roll". Use `-- --json` to get the same result as a single
object for a pipeline.

The rule is enforced in two places, because documentation alone is not a
control: `main.ts` and `worker.ts` never call a migration function, and the gate
above fails the release. If you are adding a container command that migrates,
stop — that is the one change that makes a rolling deploy unsafe.

Migrations must be backwards-compatible with the version currently running,
because for a few minutes both are live. The expand/contract pattern:

1. **Expand** — add the nullable column, deploy code that writes both.
2. **Backfill** — a job, not a migration.
3. **Contract** — a later release makes it non-null and drops the old column.

A single migration that renames a column will break every request served by the
old replicas during the rollout.

### Manual deployment runbook

Use this when a release is applied by hand rather than through the Pre-Deploy
Command. It exists because that is how this release will be applied, and the
steps that are easy to skip are the ones whose failure is invisible.

Every command below is **yours to run**. OpenCode verified the ones marked
*verified* against a schema-and-data clone of production restored into a local
Postgres 18 container; it did not run any of them against production.

**0. Backup first, and do not skip it.**

Create a Neon branch (instant, copy-on-write, free):

```
Render and Neon are dashboards, so this is done there:
Neon Console → your project → Branches → New branch from `production`
name it pre-<migration-name>-backup
```

Keep it until the release is signed off. It is the only rollback that does not
involve a restore-from-backup.

**1. Confirm the target database and the two connection strings.**

```bash
# The pooled endpoint serves the API.
psql "$DATABASE_URL" -c "select current_database(), current_user;"
# The direct endpoint is what migrations must use.
psql "$DIRECT_URL" -c "select current_database(), current_user;"
```

*Verified:* production answers `neondb | neondb_owner`, PostgreSQL 18.6. If the
first command's host contains `-pooler` and the second does not, they are the
right way round. Never migrate through `DATABASE_URL`.

What matters here is that both point at the **same** database. If they do not,
stop — this is how a migration is applied to the wrong project.

**2. Verify migration history, twice.**

```bash
npx prisma migrate status
```

*Verified:* against the production clone this printed **16 migrations found …
one pending: `20261009000000_academic_system_default_and_college_override`** and
no drift. Two things must be true before continuing:

- no line reading `Drift detected` or `migration history is modified`
- the pending set is **exactly** the migrations this release intends to apply

If either is false, **stop and report** — do not run `migrate deploy` to make a
drift message go away.

### The audited pending set

The second condition is a human check against a list, not a wildcard. For the
2026-10-10 database release it is exactly these two, and nothing else:

```
20261009000000_academic_system_default_and_college_override
20261009120000_gumlet_drm_per_video_provider
```

Both are additive: six nullable columns on `videos`, one nullable column on
`universities`, one nullable column on `faculties`, one partial index and one
trigger. No table, column, row or enum is dropped, and neither rewrites a table.
The academic migration's backfill was dry-run against production on 2026-10-10 and
writes exactly one `faculties.academicSystemOverride` cell; the diagnostic in
`inspect-academic-systems.sql` returns 0 rows for sections 5 and 6.

**A third pending migration means stop and report.** It is not covered by the
audit above, and it is the thing this check exists to catch. When a release
legitimately changes the pending set, amend this list in the same commit as the
migration it authorises — never by relaxing the rule.

> **The release gate reports; `migrate status` decides.** `npm run db:gate` /
> `db:gate:prod` parses both forms Prisma emits — the plain pending list that a
> piped stdout produces under Prisma 6, and the `pending migration` table rows a
> TTY produces — and merges them. It exits **1** and names each pending migration,
> **0** only on a positive up-to-date marker, and **2** for drift, a failed
> migration, or output it does not recognise. It runs Prisma's own JS entry point
> rather than the `npx` shim, so it behaves the same on Windows as elsewhere.
>
> None of that makes it the authority. The gate answers *is the database behind
> this build?* and has no notion of which migrations this release intends to
> apply — the allowlist above is a human judgement it cannot make. `migrate
> status` is the authority on state; the gate is what a pipeline reads to stop.

**3. Apply the pending migration on the direct connection.**

```powershell
$env:DATABASE_URL = "<the DIRECT URL>"   # cmd: set DATABASE_URL=<...>
npx prisma migrate deploy
```

*Verified on the clone:* `Applying migration
20261009000000_academic_system_default_and_college_override` then
`All migrations have been successfully applied.` The migration is entirely
additive — two columns, two `UPDATE`s that together touch **one** faculty, one
partial index, one trigger. No table, column, row or enum is dropped, and no
demo data is inserted. Re-running it is a no-op: every statement is
`IF NOT EXISTS` or `CREATE OR REPLACE`.

Use `migrate deploy`, never `migrate dev` (which can offer a reset on drift) and
never `db push` (which rewrites the schema without recording history).

**4. Confirm the schema changed, exactly once.**

```sql
-- run after deploy, read-only
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'universities'
   AND column_name = 'defaultAcademicSystem';
-- expect exactly one row

SELECT f.name AS college, f."academicSystemOverride" AS override,
       u."defaultAcademicSystem" AS university_default
  FROM faculties f JOIN universities u ON u.id = f."universityId";
```

*Verified on the clone:* `Faculty of Engineering (General)` inherits `YEAR`;
`Faculty of Engineering (Programs)` carries an explicit `LEVEL` override. Both
should match what you saw before the deploy; the only new information is which
college now carries an override.

**5. Run the diagnostic.**

```bash
psql "$DIRECT_URL" -f inspect-academic-systems.sql
```

*Verified on the clone:*

| Section | Expected |
|---|---|
| 5. Ladder/vocabulary mismatches | **0 rows** |
| 6. Students on a rung their college no longer governs | **0 rows** |
| 3. Colleges that override | 1 (the Programs college) |

Sections 5 and 6 returning rows means real students are filed under a rung
their college no longer uses. **Stop and report; do not auto-fix.** Fixing it
means reassigning students, which is a human decision.

**6. Roll the backend, then the worker.**

```
1. migrate deploy          (above)
2. Roll the API            (rolling, health-gated)
3. Roll the worker
```

Worker last, because a new worker may enqueue job shapes an old API cannot
serve, and the reverse is safe. Verify `/api/v1/meta/health/deep`; it reports
`checks.worker: false` once the heartbeat expires, which is the only signal that
a failed Worker is visible at all.

**7. Roll the clients.** Dashboard and student-web before the mobile build is
released, because they talk to the endpoints this migration adds
(`/catalog/academic-systems`, `/catalog/academic-selection`). Student-web has
its own outage path: an older build that still sends `studyType` is accepted and
ignored, so the client rollout order does not gate the backend release.

**8. Smoke tests.** With one account per system:

- [ ] admin: Other data → Academic systems lists universities and colleges, and
      inheriting colleges read *Inherited* rather than *Override*
- [ ] admin: Other data → Years & levels opens a ladder and shows its entries
- [ ] web `/register`: university → college → department changes the final field
      to *Level* or *Academic year*, and only one is ever shown
- [ ] mobile registration: the same flow in the app
- [ ] the student's existing academic year still shows on their profile
- [ ] `/api/v1/meta/health` and `/meta/health/deep`

**9. If the migration fails.**

Everything Prisma does for a migration happens in one transaction, so a failure
rolls the whole file back and no partially-applied state is left behind. Then:

```bash
# How far did it get, if at all?
psql "$DIRECT_URL" -f prod-schema-diagnostic.sql
psql "$DIRECT_URL" -f inspect-academic-systems.sql
# Only after reading both:
npx prisma migrate resolve --rolled-back 20261009000000_academic_system_default_and_college_override
# or, if it actually applied and only the bookkeeping failed:
npx prisma migrate resolve --applied 20261009000000_academic_system_default_and_college_override
```

Pick the one that matches reality — `--rolled-back` if nothing landed, `--applied`
if it did. Guessing here desynchronises the history from the schema, which is
the one failure from which there is no safe automatic escape. Do not run
`prisma migrate reset` against production under any circumstances.

**10. Rolling back.**

Delete the Neon branch only after sign-off. For the database itself, the
rollback is restoring from that branch — there is no down-migration, because this
change only ADDS columns. Removing them once clients depend on them would break
the clients, so a code rollback is not sufficient and the schema rollback is the
real one.



**If the Pre-Deploy Command is empty, deploys advance the code and never the
schema.** `prisma generate` runs in the build (so the generated client knows
the new tables) while the database stays where it was — which surfaces as
`The table public.<name> does not exist in the current database` on the first
request that touches a new model. The failure is in the application, several
steps after the mistake, which is what makes it worth a dashboard field.

The worker service needs no Pre-Deploy Command: the API's release job has
already migrated the one database they share, and a second concurrent
`migrate deploy` is the race this section opens by warning about.

> **Do not use the Pre-Deploy Command as a substitute for the runbook above.**
> `db:gate:prod` correctly reports unapplied migrations, but it cannot tell an
> *audited* pending migration from an *unexpected* one — that judgement is the
> allowlist in step 2, and it is a human's. See the manual runbook.

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

### The background Worker has no endpoint, so it is checked differently

The transcoding Worker calls `createApplicationContext` and opens **no** HTTP
port. Pointing a container healthcheck at a port it does not listen on marks it
`unhealthy` permanently, and an orchestrator that trusts that signal will restart
it in a loop — the Worker then never transcodes anything and never explains why.

The image handles this itself. `scripts/healthcheck.ts` follows the role:

| Role | How it decides |
| --- | --- |
| API (`RUN_WORKERS` unset) | `GET /api/v1/meta/health` |
| Worker (`RUN_WORKERS=true`) | its own `worker:heartbeat` key in Redis |

`RUN_WORKERS` has to be set on the **container**, not merely inside the Worker
process. `src/worker.ts` assigns it for itself before the module graph loads, but
the healthcheck is a separate process that never imports that file, so it cannot
inherit the assignment. A Worker container missing the variable is classified as
the API and asked to probe a port it deliberately does not serve — reporting
`unhealthy` while transcoding normally, which is the worst direction for a health
signal to fail in. Both `docker-compose.yml` and the production Worker service set
it explicitly; do not let it come from a shared `.env`, or the API replicas would
start consuming queues too.

The Worker writes that key once a minute with a 180-second TTL, so a missing key
means "no Worker has checked in for three minutes" — a wedged or dead Worker, and
exactly the state worth restarting. The same key is what `/api/v1/meta/health/deep` reports (`checks.worker`, with
`videoPipeline.worker` carrying the last beat's host and PID), so the container
check and the dashboard can never disagree about whether the Worker is alive.

To check it by hand:

```bash
docker run --rm -e RUN_WORKERS=true -e REDIS_URL=redis://host:6379 \
  -e REDIS_PREFIX=edu <image> node dist/scripts/healthcheck.js
echo $?   # 0 alive, 1 dead or unreachable
```

A Worker that cannot run ffmpeg still reports alive and prints `ffmpeg=false`.
That is deliberate: a missing binary is not fixed by restarting, so failing the
check would only turn a clear diagnosis into a crash loop.

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
