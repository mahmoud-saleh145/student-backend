# EduPlatform — Backend

NestJS · TypeScript · PostgreSQL · Prisma · Redis · BullMQ · Cloudflare R2

The API behind the EduPlatform student mobile app and the future admin
dashboard. It owns every business rule in the product: who may see a course,
what a payment recorded, whether a video may play right now, and on which
device.

---

## What this is

A university content platform with four roles (master, admin, teacher,
student), paid and code-based enrolment, and a video pipeline built around one
premise: **the client is not trusted**. Hiding a "Watch" button secures
nothing, so every decision — enrolment, access window, device binding, quality
ceiling, even the watermark text — is made here and never delegated to the app.

Three properties shape most of the code:

**Business history is immutable.** A payment stores the amount charged *and* a
pointer to the price version it was charged at. Changing a course price appends
a new version; it never edits the old one, so revenue can never be recomputed
into a different number. Financial foreign keys are `onDelete: Restrict`, which
means a destructive delete fails at the database, not merely at the API.

**Course structure is data, not schema.** Sections are rows with a sort order.
One course has "Before Midterm / Midterm Revision / After Midterm", another has
five units with a midterm in the middle, a third has four parts. Nothing in the
backend or the app assumes a shape.

**Protected media has no permanent URL.** A playback request runs an
eight-step authorization chain and produces a ticket that expires in minutes.
The HLS manifest is generated per request with segment URLs signed for that
specific viewer, and the AES key is derived — never stored — and handed out
only against a live ticket.

---

## Quick start

```bash
# 1. dependencies
docker compose up -d postgres redis minio

# 2. configuration
cp .env.example .env
#    then fill in the four secrets marked CHANGE_ME (see below)

# 3. schema + demo data
npm install
npm run db:setup           # generate → migrate deploy → seed

# 4. the single platform owner (not created by the seed, deliberately)
npm run bootstrap:master

# 5. run
npm run start:dev          # API on :3000
npm run worker:dev         # background jobs, separate process
```

Then open <http://localhost:3000/api/docs> for Swagger.

Generate the four required secrets with:

```bash
for v in JWT_ACCESS_SECRET JWT_REFRESH_SECRET JWT_PLAYBACK_SECRET HLS_KEY_ROOT MEDIA_SIGNING_KEY; do
  echo "$v=$(openssl rand -base64 48 | tr -d '\n')"
done
```

They must all be different. `JWT_PLAYBACK_SECRET` in particular signs
short-lived media grants; sharing it with the session secret would let a media
grant be replayed as a login.

### Seeded development accounts

Password for all of them: `DevPassword123!`

| Role    | Phone         | Notes                                    |
| ------- | ------------- | ---------------------------------------- |
| ADMIN   | `01000000001` | Full administrative access               |
| TEACHER | `01000000002` | Lead on two courses, may change pricing  |
| TEACHER | `01000000003` | Co-teacher, cannot change pricing        |
| STUDENT | `01000000010` | One paid enrolment, one expired          |
| STUDENT | `01000000011` | No enrolments — the empty-state fixture  |
| MASTER  | —             | `npm run bootstrap:master`               |

Access codes: `DEVCIRCUIT01` (single use), `DEVBATCH0001` (25 uses),
`DEVEXPIRED01` (expired — must always be rejected).

Seeded videos are in `UPLOADING` state with no storage keys, so a playback
request correctly fails with `VIDEO_NOT_READY`. That is intentional: nothing in
the seed should imply a playable asset exists before you upload one.

---

## Layout

```
src/
├── main.ts                  API entry point
├── worker.ts                background-job entry point (same graph, no HTTP)
├── app.module.ts            composition root; global guards live here
│
├── common/                  cross-cutting: guards, filters, decorators, errors
├── config/                  typed configuration + boot-time env validation
├── database/                PrismaService
├── redis/                   RedisService
│
├── modules/
│   ├── auth/                registration, login, token rotation, sessions
│   ├── users/               profiles and administrative user management
│   ├── devices/             device binding and change requests
│   ├── sessions/            staff-facing session control
│   ├── catalog/             universities, faculties, departments, years
│   ├── courses/             courses + the access engine
│   ├── sections/            dynamic course structure
│   ├── lessons/             lessons and completion
│   ├── videos/              upload, processing status, captions
│   ├── playback/            the authorization chain + dynamic HLS manifests
│   ├── attachments/         protected materials
│   ├── enrollments/         join course, grants, revocation
│   ├── payments/            payments, revenue ledger, refunds
│   ├── codes/               access codes
│   ├── progress/            watch progress and watch events
│   ├── notifications/       inbox, preferences, announcements, push
│   ├── home/                the app's home feed
│   ├── search/              search across courses, lessons, teachers
│   ├── analytics/           reporting
│   ├── audit/               append-only administrative trail
│   ├── security/            security-event telemetry
│   ├── storage/             R2 access, presigned uploads, edge signing
│   ├── master/              platform-owner operations
│   └── meta/                health and client configuration
│
└── jobs/                    BullMQ queues, processors and schedulers

prisma/
├── schema.prisma
├── migrations/
├── optional/                DBA-applied performance SQL
└── seed.ts

scripts/create-master.ts     the only path that can create a MASTER
docs/                        architecture, API contract, security, deployment
test/                        unit + integration
```

`AppModule` is worth reading first — the guard order and the
protected-by-default posture are both decided there.

---

## Two processes, one codebase

The API and the worker boot the same module graph. `RUN_WORKERS=true` is what
registers the BullMQ processors, so:

- **API deployment** — leaves it unset. It enqueues jobs, never consumes them.
- **Worker deployment** — sets it. Needs ffmpeg and several GB of scratch disk.

The split exists because a 40-minute 1080p transcode and a 200 ms API request
should never compete for the same CPU, and because the two scale on completely
different signals (queue depth versus request rate).

---

## Commands

| Command                        | What it does                                     |
| ------------------------------ | ------------------------------------------------ |
| `npm run start:dev`            | API with watch mode                              |
| `npm run worker:dev`           | Background worker with watch mode                |
| `npm run build`                | Compile to `dist/`                               |
| `npm run start:prod`           | Run the compiled API                             |
| `npm run worker`               | Run the compiled worker                          |
| `npm run typecheck`            | `tsc --noEmit`                                   |
| `npm run lint`                 | ESLint with `--fix`                              |
| `npm test`                     | Unit tests (no database needed)                  |
| `npm run test:e2e`             | Integration tests (**needs Postgres + Redis**)   |
| `npm run prisma:migrate`       | Create and apply a migration in development      |
| `npm run prisma:deploy`        | Apply migrations (production)                    |
| `npm run seed`                 | Development seed — refuses on a non-empty DB     |
| `npm run bootstrap:master`     | Create or rotate the single master account       |
| `npm run db:setup`             | generate + deploy + seed                         |
| `npm run infra:start`          | PostgreSQL + Redis without Docker                |
| `npm run verify:offline`       | Real business logic, no node_modules required    |

Integration tests refuse to run unless the database name ends in `_test`, since
they truncate tables:

```bash
DATABASE_URL=postgresql://edu:edu@localhost:5432/edu_test npm run test:e2e
```

---

## API shape

Everything lives under `/api/v1`. Success responses are

```json
{ "success": true, "data": { }, "meta": { } }
```

Error responses carry **both** the nested and the flat form:

```json
{
  "success": false,
  "error": { "code": "ACCESS_EXPIRED", "message": "…" },
  "code": "ACCESS_EXPIRED",
  "message": "…",
  "requestId": "…"
}
```

The duplication is deliberate and documented in
[docs/API_CONTRACT.md](docs/API_CONTRACT.md): the mobile app shipped first and
reads the flat fields, the specification asks for the nested object, and both
are populated from the same source values so they cannot disagree.

Clients branch on `code`, never on `message`. Messages are for humans and may
be reworded at any time.

---

## Documentation

| Document | Read it when |
| --- | --- |
| [INTEGRATION_AND_RUN.md](docs/INTEGRATION_AND_RUN.md) | You want to run the whole system, app included |
| [FINAL_INTEGRATION_REPORT.md](docs/FINAL_INTEGRATION_REPORT.md) | You want to know what is verified and what is not |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | You want to know why the pieces are arranged this way |
| [API_CONTRACT.md](docs/API_CONTRACT.md) | You are connecting a client |
| [SECURITY.md](docs/SECURITY.md) | You are touching auth, playback, devices or money |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | You are putting this into production |
| [MANUAL_STEPS.md](docs/MANUAL_STEPS.md) | You are setting it up for the first time |
| [MOBILE_CHANGES.md](docs/MOBILE_CHANGES.md) | You are updating the React Native app to match |

---

## Licence

UNLICENSED — private project.
