# Integration and run guide

How to bring the whole system up from a clean machine: PostgreSQL, Redis,
object storage, the API, the worker, and the Expo dev build talking to all of
it.

Two projects, side by side:

```
<workspace>/
├── edu-backend/     NestJS API + worker
└── edu-mobile/      Expo student app
```

Every command below is run from `edu-backend/` unless it says otherwise.

---

## 0. Prerequisites

| Tool | Version | Why |
| --- | --- | --- |
| Node.js | ≥ 20.11 | Both projects |
| PostgreSQL | 16 | Application database |
| Redis | 7 | Rate limits, stream slots, queues |
| ffmpeg + ffprobe | any recent | Transcoding, worker only |
| An S3-compatible store | MinIO or Cloudflare R2 | Video and attachments |
| Expo CLI / EAS CLI | latest | Mobile dev build |
| Android Studio or Xcode | — | To run the dev build |

Docker is **optional**. `docker-compose.yml` still works where a daemon is
available; `scripts/dev-infra.sh` covers the native path.

---

## 1. Infrastructure

### With Docker

```bash
docker compose up -d postgres redis minio
```

### Without Docker

```bash
sudo apt-get install -y postgresql-16 redis-server ffmpeg   # Debian/Ubuntu
./scripts/dev-infra.sh start
```

That creates the cluster if needed, starts PostgreSQL on 5432 and Redis on
6379, and creates the `edu_platform` and `edu_test` databases owned by an `edu`
role. It is idempotent — run it as often as you like.

```bash
./scripts/dev-infra.sh status     # is it up?
./scripts/dev-infra.sh stop
./scripts/dev-infra.sh reset      # destroys the data directory, asks first
```

PostgreSQL refuses to run as root, so the script runs the server as the
`postgres` system user. If your data directory lives elsewhere, override it:
`PGDATA=/your/path ./scripts/dev-infra.sh start`.

**Verify:**

```bash
pg_isready -h 127.0.0.1 -p 5432    # → accepting connections
redis-cli ping                      # → PONG
```

---

## 2. Backend configuration

```bash
cp .env.example .env
```

Generate the five secrets — they must all differ:

```bash
for v in JWT_ACCESS_SECRET JWT_REFRESH_SECRET JWT_PLAYBACK_SECRET \
         HLS_KEY_ROOT MEDIA_SIGNING_KEY; do
  echo "$v=$(openssl rand -base64 48 | tr -d '\n')"
done
```

Paste each over its `CHANGE_ME…` line. The application validates all of this at
boot and refuses to start on a missing, malformed or placeholder value.

For local work the defaults in `.env.example` are already correct for the
infrastructure above:

```bash
DATABASE_URL=postgresql://edu:edu_dev_password@127.0.0.1:5432/edu_platform?schema=public
REDIS_URL=redis://127.0.0.1:6379
PUBLIC_API_URL=http://localhost:3000
MEDIA_CDN_BASE_URL=          # empty locally
MEDIA_LOCAL_ORIGIN=true      # see §6
```

**If you will run the app on an Android emulator or a physical device**, set
`PUBLIC_API_URL` to an address the device can reach, not `localhost`:

```bash
PUBLIC_API_URL=http://10.0.2.2:3000        # Android emulator
PUBLIC_API_URL=http://192.168.1.20:3000    # physical device, your LAN IP
```

This matters more than it looks: `PUBLIC_API_URL` is the host baked into signed
media URLs. Leave it as `localhost` and the phone will fetch the manifest fine
and then fail on every segment.

---

## 3. Schema, seed and the master account

```bash
npm install
npm run db:setup          # prisma generate → migrate deploy → seed
npm run bootstrap:master  # interactive; the ONLY way to create a MASTER
```

`db:setup` creates 39 tables and 24 enum types and loads development data.

The seed creates admin, teacher and student accounts, all with the password
`DevPassword123!`:

| Role | Phone | Notes |
| --- | --- | --- |
| ADMIN | `01000000001` | |
| TEACHER | `01000000002` | Lead on two courses |
| TEACHER | `01000000003` | Co-teacher |
| STUDENT | `01000000010` | One paid enrolment, one expired |
| STUDENT | `01000000011` | No enrolments |

Access codes: `DEVCIRCUIT01` (single use), `DEVBATCH0001` (25 uses),
`DEVEXPIRED01` (expired, must always be rejected).

The seed refuses to run against a database that already contains payments, and
refuses `NODE_ENV=production` unless `ALLOW_PROD_SEED=1` is also set.

**Seeded videos are deliberately in `UPLOADING` state with no storage keys.**
Requesting playback returns `VIDEO_NOT_READY`, which is the correct state
before you upload anything. §6 covers making one playable.

**Verify:**

```bash
psql -h 127.0.0.1 -U edu -d edu_platform -c '\dt' | head
psql -h 127.0.0.1 -U edu -d edu_platform -c \
  "SELECT phone, role FROM users ORDER BY role;"
```

---

## 4. Run the backend

Two processes, deliberately:

```bash
npm run start:dev     # terminal 1 — API on :3000
npm run worker:dev    # terminal 2 — transcoding, push, sweeps
```

They are separate because a 40-minute transcode and a 200 ms API request should
never compete for the same CPU.

**Verify:**

```bash
curl -s localhost:3000/api/v1/meta/health | jq
curl -s localhost:3000/api/v1/meta/health/deep | jq   # db + redis + storage
open http://localhost:3000/api/docs                   # Swagger
```

A quick smoke test of the whole auth path:

```bash
curl -s -X POST localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -H 'X-Device-Id: dev-machine-1' \
  -H 'X-Device-Platform: ios' \
  -d '{"phone":"01000000010","password":"DevPassword123!"}' | jq
```

You should get `{ success: true, data: { user, accessToken, refreshToken, expiresIn, device } }`.

Then browse the catalogue with that token:

```bash
TOKEN=<accessToken from above>
curl -s localhost:3000/api/v1/courses \
  -H "Authorization: Bearer $TOKEN" -H 'X-Device-Id: dev-machine-1' | jq '.data.items[].title'
```

---

## 5. Object storage

The API boots without storage — every non-media flow works — but uploads and
playback need an S3-compatible bucket.

### MinIO, via Docker

```bash
docker compose up -d minio        # console on :9001, API on :9000
```

Then in `.env`:

```bash
R2_ENDPOINT=http://127.0.0.1:9000
R2_ACCESS_KEY_ID=eduminio
R2_SECRET_ACCESS_KEY=eduminio_dev_password
R2_BUCKET_MEDIA=edu-media-dev
R2_BUCKET_UPLOADS=edu-uploads-dev
```

`StorageService` switches to path-style addressing automatically when the
endpoint contains `minio`.

### MinIO, standalone binary

```bash
curl -fsSL https://dl.min.io/server/minio/release/linux-amd64/minio -o /usr/local/bin/minio
chmod +x /usr/local/bin/minio
MINIO_ROOT_USER=eduminio MINIO_ROOT_PASSWORD=eduminio_dev_password \
  minio server /var/lib/minio --console-address :9001 &
mc alias set local http://127.0.0.1:9000 eduminio eduminio_dev_password
mc mb local/edu-media-dev local/edu-uploads-dev
```

### Cloudflare R2

Follow `docs/MANUAL_STEPS.md` step 7. Local development does not need it.

**Verify:** `curl -s localhost:3000/api/v1/meta/health/deep | jq .storage` → `"up"`.

---

## 6. Media delivery — the part that is easy to get wrong

Protected segments are fetched from signed URLs whose HMAC covers the object
key, the expiry **and the viewer** (user, session, device, ticket). Something
has to verify that signature before serving bytes. There are two supported
verifiers:

| | Verifier | When |
| --- | --- | --- |
| Production | Cloudflare Worker at the edge | `MEDIA_CDN_BASE_URL` set |
| Development | This API's own media origin | `MEDIA_LOCAL_ORIGIN=true` |

The local origin (`GET /playback/media/*`) applies the *same* checks the Worker
applies — identical HMAC over the identical canonical string, ticket liveness,
quality ceiling, and a hard refusal of the `uploads/` and `/source/` prefixes.
It is a transport change, not a relaxation.

It exists because the alternative was worse: previously, with no CDN
configured, the backend fell back to a plain presigned S3 URL that was **not**
bound to the viewer — anyone holding the string could replay it — and which a
phone could not reach when the store was a local MinIO anyway.

Rules the code now enforces for you:

- `MEDIA_LOCAL_ORIGIN` defaults on in development, off in production.
- Production **refuses to boot** without `MEDIA_CDN_BASE_URL`, and refuses to
  boot with `MEDIA_LOCAL_ORIGIN=true`. Node must not proxy video at scale.
- With neither configured, `signMediaUrl` throws rather than issuing an unbound
  URL. A playback request that cannot be satisfied securely fails instead of
  degrading quietly.

### Making one video actually playable

```bash
# 1. Sign in as the teacher and start an upload
curl -s -X POST localhost:3000/api/v1/videos/uploads/init \
  -H "Authorization: Bearer $TEACHER_TOKEN" \
  -H 'Content-Type: application/json' -H 'X-Device-Id: dev-machine-1' \
  -d '{"lessonId":"<lessonId>","fileName":"lecture.mp4","sizeBytes":52428800}' | jq

# 2. PUT the file straight at the presigned URL — bytes never touch the API
curl -X PUT --upload-file lecture.mp4 "<uploadUrl from step 1>"

# 3. Tell the API the object landed; this enqueues transcoding
curl -s -X POST localhost:3000/api/v1/videos/<videoId>/complete \
  -H "Authorization: Bearer $TEACHER_TOKEN" -H 'X-Device-Id: dev-machine-1' | jq

# 4. Watch the worker log. Poll until READY:
curl -s localhost:3000/api/v1/videos/<videoId>/status \
  -H "Authorization: Bearer $TEACHER_TOKEN" -H 'X-Device-Id: dev-machine-1' | jq .status
```

The worker builds a 360/480/720/1080 ladder (never upscaling past the source),
encrypts segments with AES-128 using a key derived from `HLS_KEY_ROOT`, and
uploads segments before playlists so a playlist never references a missing
segment.

---

## 7. Mobile configuration

From `edu-mobile/`:

```bash
npm install
cp .env.example .env.development   # if you do not already have one
```

`.env.development` now ships with:

```bash
EXPO_PUBLIC_USE_MOCKS=false
EXPO_PUBLIC_API_URL=http://10.0.2.2:3000/api/v1
```

Set the URL for your target:

| Target | `EXPO_PUBLIC_API_URL` |
| --- | --- |
| Android emulator | `http://10.0.2.2:3000/api/v1` |
| iOS simulator | `http://localhost:3000/api/v1` |
| Physical device | `http://<your-LAN-IP>:3000/api/v1` |

Two things worth knowing:

- **The path must include `/api/v1`.** The backend sets a global prefix and URI
  versioning; `http://host:3000/courses` is a 404.
- **`EXPO_PUBLIC_USE_MOCKS` now defaults to `false` in code as well as in the
  env file.** A missing `.env` used to silently activate the mock layer, which
  looks exactly like a working app that never contacts the server.

Add your LAN IP to the backend's `CORS_ORIGINS` only if you are also opening
the API from a browser; native apps send no `Origin` header and are unaffected.

---

## 8. Build and run the mobile app

**Expo Go will not work.** The content protection is a custom native module
(`modules/content-protection`, Kotlin + Swift), and the app deliberately
*refuses* protected playback when the secure surface is unavailable rather than
degrading. You need a dev build.

### Local dev build

```bash
npx expo prebuild --clean          # generates android/ and ios/

# Android
npx expo run:android

# iOS (macOS only)
cd ios && pod install && cd ..
npx expo run:ios
```

### EAS dev build

```bash
npm install -g eas-cli
eas login
eas init                                   # writes EAS_PROJECT_ID
eas build --profile development --platform android
# install the resulting APK, then:
npx expo start --dev-client
```

The `development` profile in `eas.json` now sets `EXPO_PUBLIC_USE_MOCKS=false`.

**Verify** the app is talking to the real backend: sign in as `01000000010` /
`DevPassword123!` and watch the API log. You should see the request. If the app
shows courses but the log is silent, mocks are still on.

---

## 9. Walking the student flow

1. **Register** — the form needs university → faculty → department → year, all
   fetched from `/catalog/*`. The backend requires a name of three parts or
   more and an Egyptian mobile number.
2. **Log in** — returns tokens plus a `device` block describing the binding.
3. **Browse** — `/courses` shows published courses only. Drafts are invisible.
4. **Open a course** — `access.state` drives the UI: `NOT_ENROLLED`,
   `PENDING_PAYMENT`, `ACTIVE`, `EXPIRED`, `REVOKED`, `ARCHIVED`.
5. **Join** — free courses enrol immediately; paid ones need a payment or a
   code. Try `DEVCIRCUIT01` on Circuit Analysis II.
6. **Open a lesson** — sections come back in the exact configured order, with
   whatever names and counts the course was built with.
7. **Play** — the app posts to `/playback/videos/:videoId/ticket` and gets a
   short-lived ticket with a manifest URL, a server-composed watermark and a
   heartbeat interval. It must call `DELETE /playback/tickets/:id` on teardown
   or the concurrency slot stays held for up to 90 seconds.

### Checks worth running by hand

```bash
# Not enrolled → NOT_ENROLLED
curl -s -X POST localhost:3000/api/v1/playback/videos/$VIDEO/ticket \
  -H "Authorization: Bearer $TOKEN" -H 'X-Device-Id: dev-machine-1' -d '{}' | jq .code

# Wrong device → DEVICE_NOT_AUTHORIZED (and a SecurityEvent row)
curl -s -X POST localhost:3000/api/v1/playback/videos/$VIDEO/ticket \
  -H "Authorization: Bearer $TOKEN" -H 'X-Device-Id: someone-elses-phone' -d '{}' | jq .code

# No device header at all → refused
curl -s -X POST localhost:3000/api/v1/playback/videos/$VIDEO/ticket \
  -H "Authorization: Bearer $TOKEN" -d '{}' | jq .code

# Expire the access window, then retry → ACCESS_EXPIRED
psql -h 127.0.0.1 -U edu -d edu_platform -c \
  "UPDATE enrollments SET \"accessEndsAt\" = now() - interval '1 minute'
   WHERE \"userId\" = (SELECT id FROM users WHERE phone='01000000010');"

# Confirm the security events landed
psql -h 127.0.0.1 -U edu -d edu_platform -c \
  "SELECT type, severity, message FROM security_events ORDER BY \"createdAt\" DESC LIMIT 5;"
```

---

## 10. Tests

```bash
npm test                      # unit; no database needed
DATABASE_URL=postgresql://edu:edu_dev_password@127.0.0.1:5432/edu_test \
  npm run test:e2e            # integration; needs Postgres + Redis
npm run typecheck
```

The integration suite refuses to run unless the database name ends in `_test`,
because it truncates tables.

### Offline verification harness

```bash
npm run verify:offline
```

This runs the project's real business logic **without installing
node_modules**, by compiling the pure modules against small stubs for the two
runtime packages they touch. It was built because the integration environment
had the npm registry blocked, and it remains useful as a fast pre-commit check
and in restricted CI.

It covers 207 assertions across five suites: the full access-decision matrix,
serializer output diffed against the mobile app's TypeScript interfaces, media
URL signing and tamper rejection, the device-header contract, and the student
flow against a live PostgreSQL.

It is **not** a replacement for `npm test` — it cannot exercise HTTP, guards,
interceptors or Prisma query building.

---

## 11. Troubleshooting

**`Invalid environment configuration` at boot.** The message names the
variable. Usually a secret still reading `CHANGE_ME` or shorter than 32 chars.

**App shows data but the API log is silent.** Mocks are on. Check
`EXPO_PUBLIC_USE_MOCKS` in the env file *and* the EAS profile, and remember the
app must be rebuilt for `EXPO_PUBLIC_*` changes to take effect — they are
inlined at build time, not read at runtime.

**Every request 404s.** The base URL is missing `/api/v1`.

**Android emulator cannot reach the API.** Use `10.0.2.2`, not `localhost`.
`localhost` inside the emulator is the emulator.

**Manifest loads, segments 403.** `PUBLIC_API_URL` is not reachable from the
device, or `MEDIA_SIGNING_KEY` differs between the API and the Worker. Check
the response's `x-deny-reason` header.

**`VIDEO_NOT_READY` on every lesson.** The seeded videos have no uploaded
asset. That is correct — see §6.

**`CONCURRENT_STREAM_LIMIT` on one device.** The app did not release its
previous ticket. The slot clears after `PLAYBACK_HEARTBEAT_GRACE` seconds.

**`DEVICE_NOT_AUTHORIZED` on the device that was working.** The `X-Device-Id`
header is missing or changed. It is derived from a Keychain/Keystore value; a
simulator reset regenerates it. Bind the new device or clear the old row.

**PostgreSQL will not start as root.** Expected. `scripts/dev-infra.sh` runs it
as the `postgres` user.

**Transcoding never finishes.** The worker is not running, `RUN_WORKERS` is not
set, ffmpeg is missing, or `TRANSCODE_WORK_DIR` is out of space.
