# Final integration report

Integration and run phase for `edu-mobile` (Expo) and `edu-backend` (NestJS).
Neither project was rebuilt or redesigned.

**The environment blocked the npm registry**, so neither application could be
started. Everything below is split by what that made possible and impossible.
Nothing is claimed as working unless it was executed.

---

## Summary

| | |
| --- | --- |
| Integration defects found | 5 (2 blocking, 3 latent) |
| Fixed in code | 5 |
| Files changed | 11 mobile, 10 backend (+12 harness) |
| Assertions executed against real code | **207, all passing** |
| Could not be executed | HTTP layer, Expo build, real HLS playback |

The single most useful outcome: the migration SQL and the whole access-control
layer went from *written but unverified* to *executed against PostgreSQL 16*,
and that immediately surfaced a real access-control bug.

---

## WORKING

Verified by execution in this environment. Reproduce with
`npm run verify:offline`.

### Database schema — verified against live PostgreSQL 16

`prisma/migrations/20260101000000_init/migration.sql` was hand-generated in the
previous phase and had never been run. It now applies cleanly:

```
tables 39 · enums 24 · foreign keys 71 · indexes 140 · RESTRICT FKs 16
```

A structural comparison of the applied database against `schema.prisma` —
every model, every column, nullability, every enum and its value ordering —
reports **zero drift**. This is the same property `prisma migrate deploy`
checks, arrived at independently.

### Access control — 110 assertions

Every `CourseStatus × EnrollmentState` combination executed through the real
compiled `CourseAccessService.decide()`. Confirmed:

- only `PUBLISHED` and `HIDDEN` courses deliver content, and only to an `ACTIVE`
  enrolment;
- `ARCHIVED` beats everything, including a paid active enrolment;
- a lapsed access window overrides a stale stored `ACTIVE` — the nightly sweep
  is bookkeeping, not the source of truth;
- the window boundary is closed, not open;
- every denial names an error code, so the app can never receive an
  unrenderable 500;
- every returned state is inside the mobile app's `AccessState` union.

### Student flow — 52 assertions against the live database

Real rows from PostgreSQL fed into the real decision logic, covering
registration, login, browsing, course detail, enrolment, code redemption,
lesson access, playback authorization, progress, and the unauthorized paths.
Notable confirmations:

- a duplicate phone, a duplicate enrolment, a duplicate code redemption and a
  duplicate progress row are each rejected **by a database constraint**, not by
  application politeness;
- a course carrying business history cannot be deleted — PostgreSQL refuses on
  the `RESTRICT` foreign key;
- archiving destroys no payments, revenue, enrolments or watch history;
- a price rise leaves the historical payment and its revenue row at the old
  amount while the catalogue shows the new one;
- a serialized course payload contains no storage key, bucket host or `.m3u8`
  reference.

### Media URL signing — 29 assertions

Real `signMediaUrl` / `verifyMediaSignature`. A signed URL is rejected when the
user, device, session, ticket, object key, quality ceiling or expiry is altered
by even one field, and a URL minted with a different signing key is rejected by
the real one. CDN mode and local-origin mode produce the identical signature,
so the edge Worker and the API agree.

### Device header contract — 16 assertions

The real `RequestContextMiddleware` against the exact headers
`edu-mobile/src/services/device.ts` sends. All eight device headers are read
correctly, an Arabic device name survives URL-encoding round-trip, header
stuffing is truncated, and malformed percent-encoding does not throw.

### Endpoint contract

A script extracts every path from the mobile's `Endpoints` map and every route
from the backend's controllers. **47 mobile paths, 133 backend routes, zero
unmatched** — down from one mismatch before this phase.

### Serializer shapes

The real serializers executed and their actual output keys diffed against the
mobile's TypeScript interfaces. `CourseSummary`, `CourseSection`,
`LessonSummary`, `Attachment` and `WatchProgress` all satisfy the contract with
no missing required field.

### Infrastructure

PostgreSQL 16 and Redis 7 running natively (no Docker daemon in this
environment). `scripts/dev-infra.sh` reproduces it and is idempotent —
verified by running it against already-running services.

---

## FIXED

### 1. Enrolled students kept streaming a course withdrawn to DRAFT — *security*

**Found by** executing the access matrix; not visible by reading the code.

`unpublish()` accepts `DRAFT`, `HIDDEN` or `SUSPENDED`. `decide()` withheld
content for `SUSPENDED` and `ARCHIVED` but not `DRAFT` — so pulling a live
course back into authoring left every already-enrolled student with full
access, playback tickets included.

`HIDDEN` allowing access is correct: it means *unlisted*, off the catalogue for
new students, unchanged for existing ones. `DRAFT` means *not fit for
consumption*, and now behaves like `SUSPENDED`: the enrolment stays `ACTIVE`,
delivery is withheld with `COURSE_NOT_AVAILABLE`, and re-publishing needs no
data repair.

`src/modules/courses/course-access.service.ts`, with a regression test and a
test asserting the `HIDDEN` behaviour is deliberate.

### 2. Player route derived a lesson id from a video id — *blocking*

`src/app/player/[videoId].tsx` computed `videoId.replace(/^v-/, '')`. That
convention came from the mock layer. Real video ids and lesson ids are
independent cuids, so **every player screen would have 404'd** against the real
backend. The lesson screen already navigated with a real video id, so the two
disagreed — only the mock made both appear to work.

Fixed by using `GET /lessons/by-video/:videoId`, adding `nextVideoId` /
`previousVideoId` to the lesson payload, and autoplaying only when the next
lesson actually has a video. The mock was updated to serve the same route and
to look videos up by id rather than by name shape, so it exercises the same
code path instead of drifting again.

### 3. No usable media delivery path without Cloudflare — *blocking, and a security trap*

With `MEDIA_CDN_BASE_URL` empty, `signMediaUrl` fell back to a plain presigned
S3 URL. That URL is **not bound to the viewer** — anyone holding the string can
replay it until expiry — and a phone cannot reach a local MinIO anyway. So
local playback did not work, and the configuration where it came closest to
working was the least secure one.

`StorageService.verifyMediaSignature` already existed, documented "so the API
can verify requests itself when the CDN is bypassed", but nothing called it.

Added `MediaOriginController` (`GET /playback/media/*`) applying the same
checks as the edge Worker: identical HMAC over the identical canonical string,
expiry, forbidden `uploads/` and `/source/` prefixes, quality ceiling from the
object key, and ticket liveness. The one intentional difference is the failure
mode — the Worker fails *open* on a network error because it calls a remote
API, whereas this check is a local database read and fails *closed*.

Guard rails, all enforced at boot:

- defaults on in development, off in production;
- production refuses to start without `MEDIA_CDN_BASE_URL`;
- production refuses to start with `MEDIA_LOCAL_ORIGIN=true`;
- with neither configured, `signMediaUrl` throws rather than issuing an unbound
  URL.

This is a transport change, not a relaxation. It is also strictly stronger than
what was there: the removed fallback was the only code path in the system that
issued a URL not bound to a viewer.

### 4. Mocks defaulted ON in code — *latent*

`src/config/env.ts` defaulted `useMocks` to `'true'`. A build with a missing
`.env` silently served fake courses — indistinguishable from a working app. Now
defaults to `false`, so a misconfiguration surfaces as a connection error the
developer sees immediately. `.env.development` and the `eas.json` development
profile were switched to `false` too.

### 5. `/profile/password` did not exist — *latent*

The mobile endpoint map pointed at `/profile/password`; the backend serves
`/auth/password`. Nothing called it yet, so it would have failed the first time
someone wired up the change-password screen. Moved to `Endpoints.auth.changePassword`.

### Also corrected

The previous phase's `auth.e2e-spec.ts` registration test was **wrong**: it
sent `confirmPassword` (not in the DTO, and rejected outright by
`forbidNonWhitelisted`) and omitted the four required academic ids. It would
have failed on first run. Rewritten against the real DTO, with added coverage
for the three-part-name and Egyptian-phone rules.

`docs/MOBILE_CHANGES.md` item R4 claimed device names would display
percent-encoded. That was wrong — the middleware already decodes them, now
proven by an executed test.

---

## REQUIRES MY ACTION

Things only you can do.

### 1. Install dependencies — everything else waits on this

```bash
cd edu-backend && npm install
cd ../edu-mobile && npm install
```

The npm registry returned `403 Forbidden` here for every package, direct and
through the proxy. On a normal network this is one command.

### 2. Start an object store

No S3-compatible store could be installed here. Either:

```bash
docker compose up -d minio
```

or the standalone binary — both covered in `INTEGRATION_AND_RUN.md` §5. Then
set `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.

Until this exists, uploads and playback return storage errors. Everything else
works.

### 3. Upload one real video

The seed deliberately leaves videos in `UPLOADING` with no storage keys, so
playback correctly returns `VIDEO_NOT_READY`. The four-step upload flow is in
`INTEGRATION_AND_RUN.md` §6. You need this to see actual HLS playback.

### 4. Set `PUBLIC_API_URL` to something your device can reach

`localhost` is baked into signed media URLs. On an Android emulator the phone
will load the manifest and then fail every segment. Use `10.0.2.2` for the
emulator, your LAN IP for a physical device.

### 5. Build the dev client

```bash
cd edu-mobile
npx expo prebuild --clean
npx expo run:android          # or run:ios
```

Expo Go will not work — the content protection is a custom native module, and
the app refuses protected playback when the secure surface is unavailable
rather than degrading.

### 6. Create the master account

```bash
npm run bootstrap:master
```

Not created by the seed, deliberately: there is exactly one code path in the
repository that can mint a `MASTER`, and it is not one that runs as part of
`db:setup`.

### 7. Before production

`docs/MANUAL_STEPS.md` steps 7–14, in particular: R2 with public access
**disabled**, the Cloudflare Worker deployed with a matching
`MEDIA_SIGNING_KEY`, and `TRUST_PROXY=true` behind the load balancer.

---

## BLOCKED BY ENVIRONMENT

| Blocker | Consequence | What unblocks it |
| --- | --- | --- |
| **npm registry 403** — direct and via proxy, for every package | Neither app can start. No `npm test`, no `prisma generate`, no Expo build, no HTTP-level testing | `npm install` on a normal network |
| **No Docker daemon** (`/var/run/docker.sock` absent) | `docker-compose.yml` unusable; no MinIO | Docker Desktop, or the native path already scripted |
| **No S3-compatible store** | Upload, transcode and segment delivery untestable | MinIO or R2 |
| **No Android/iOS toolchain or device** | App cannot be built or run | Android Studio / Xcode |

Worked around where possible: PostgreSQL and Redis run natively, and the
offline harness executes the real business logic by compiling against small
stubs for the two runtime packages the pure modules touch.

---

## NOT YET VERIFIED

Stated plainly, because these are the gaps between what was proven and a
running system.

**The HTTP layer.** Guards, interceptors, the validation pipe, the exception
filter, route registration and the response envelope have never handled a
request. Route *paths* are verified by static extraction; route *behaviour* is
not. The most likely residual failure is a Nest wiring issue at boot — a
missing provider in a module's `imports`.

**Every Prisma query.** The harness runs raw SQL that mirrors what services do.
Prisma's own query building, `include` shapes and transaction semantics are
untested. Relation-name typos would surface on first run.

**The Expo app end to end.** No screen has rendered against the real backend.
The player route fix is correct by construction and by the by-video test, but
has not been executed on a device.

**Real HLS playback.** No video has been transcoded, encrypted, uploaded or
played. The *signing and verification* of media URLs is verified; the bytes
moving is not.

**The transcoding pipeline.** ffmpeg is installed here but was never invoked by
the worker, because BullMQ needs node_modules.

**Push, payments, DRM.** Configured off. Untested by design.

**My own test files.** The unit and integration suites are written but have
never run under Jest. Expect a few assertion adjustments on first execution —
one such error (the registration DTO) was found and fixed by reading against
the real DTO, and there may be more of that kind.

**Concurrency under real load.** The one-stream-per-student ceiling is verified
as a data invariant, not under simultaneous requests. The Serializable
isolation on code redemption is likewise verified structurally (unique index
present and enforced) rather than by racing two live transactions through the
API.

---

## Files changed

### Backend — source

| File | Why |
| --- | --- |
| `src/modules/courses/course-access.service.ts` | **Fix 1.** `DRAFT` now withholds content like `SUSPENDED`; `HIDDEN` documented as deliberately unaffected |
| `src/modules/playback/media-origin.controller.ts` | **New. Fix 3.** The Worker's checks in Node, for local media delivery |
| `src/modules/playback/playback.module.ts` | Register the new controller last so its wildcard cannot shadow specific routes |
| `src/modules/storage/storage.service.ts` | **Fix 3.** `signMediaUrl` targets the CDN or the local origin; refuses rather than issuing an unbound presigned URL. Added `servesMediaLocally` and `localOriginBase()` |
| `src/config/configuration.ts` | `storage.localOrigin` flag |
| `src/config/env.validation.ts` | Validate `MEDIA_LOCAL_ORIGIN`; production refuses to boot without a CDN, or with the local origin enabled |
| `src/modules/lessons/lessons.service.ts` | **Fix 2.** Lesson payload carries `nextVideoId` / `previousVideoId`; `orderedLessonIds` → `orderedLessons` |

### Backend — tests, config, tooling

| File | Why |
| --- | --- |
| `test/unit/course-access.spec.ts` | Regression for the `DRAFT` bug; a test asserting `HIDDEN` access is intentional |
| `test/integration/auth.e2e-spec.ts` | Rewritten against the real `RegisterDto`; added name and phone validation coverage |
| `.env` | **New.** Working local configuration with generated distinct secrets |
| `.env.example` | Document `MEDIA_LOCAL_ORIGIN`; correct the stale CDN note |
| `package.json` | `infra:*` and `verify:offline` scripts |
| `.gitignore` | Ignore the harness's compiled output |
| `scripts/dev-infra.sh` | **New.** PostgreSQL + Redis without Docker |
| `tools/offline-verify/**` | **New.** The five-suite harness, its stubs and `verify.sh` |
| `docs/INTEGRATION_AND_RUN.md` | **New.** This system, from a clean machine |
| `docs/FINAL_INTEGRATION_REPORT.md` | **New.** This document |

### Mobile

| File | Why |
| --- | --- |
| `src/app/player/[videoId].tsx` | **Fix 2.** Resolve the lesson by video id instead of string-stripping; autoplay only when the next lesson has a video |
| `src/features/lessons/api.ts` | `byVideo()` |
| `src/features/lessons/hooks.ts` | `useLessonByVideo()`, kept separate from `useLesson` so the two identifiers cannot be conflated again |
| `src/api/endpoints.ts` | Added `lessons.byVideo`; **Fix 5** moved `changePassword` to `/auth/password` |
| `src/api/query-keys.ts` | Cache key for the by-video lookup |
| `src/types/domain.ts` | `nextVideoId` / `previousVideoId` on `LessonDetail` |
| `src/config/env.ts` | **Fix 4.** `useMocks` defaults to `false` |
| `.env.development` | `EXPO_PUBLIC_USE_MOCKS=false` |
| `eas.json` | Development profile no longer builds with mocks on |
| `src/api/mock/index.ts` | Serve `/lessons/by-video/:videoId`; resolve videos by id, not by name shape |
| `src/api/mock/data.ts` | Mock lessons carry adjacent video ids |

---

## What I would do first, given a working network

1. `npm install` in both projects, then `npm run typecheck` in each. The
   shim-based typecheck used here cannot see real library types, so genuine
   type errors may be hiding behind that limitation.
2. `npm test`, then `npm run test:e2e`. Expect assertion adjustments.
3. `npm run start:dev` and walk §9 of the integration guide with curl. Boot
   failures from module wiring surface here.
4. MinIO, then upload one video and watch it transcode.
5. `npx expo run:android` and walk the flow on a device.

The offline harness stays useful after that — it is a fast pre-commit check on
the access matrix and the media signing, and it runs in restricted CI where a
full install is not available.
