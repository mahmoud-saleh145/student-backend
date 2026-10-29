# Student Center — architecture, as found in the code (2026-10-26/27)

Everything here was derived from the four repositories and from read-only requests to the public production endpoints. Older docs in the repos were treated as hypotheses.

## 1. Projects

| Project | Folder (Desktop) | Remote | Stack (from `package.json`) | Runs on |
|---|---|---|---|---|
| Backend API + worker | `edu-backend` | `mahmoud-saleh145/student-backend` | NestJS 11, Prisma 6 / Postgres (Neon), BullMQ + ioredis (Upstash), S3 SDK → Cloudflare R2, Gumlet DRM, Cloudinary (course images), argon2, class-validator | API: Render (`student-backend-814y.onrender.com`). Worker: **a Docker container** (`host bcd7e0fe996d` in `/meta/health/deep`). `docs/LOCAL_WORKER_WINDOWS.md` describes running it on a PC. |
| Media edge gate | `edu-backend/docs/cloudflare-worker.js` + `wrangler.toml` | same repo | Cloudflare Worker, R2 bindings `MEDIA`, `LIBRARY` | `edu-media-gate.startuppp3.workers.dev` |
| Admin / teacher dashboard | `edu-dashboard` | `mahmoud-saleh145/student-dashoard` | Next.js 15, React 19, TanStack Query 5, zod 4, Playwright e2e against a stub API | Vercel (`student-dashoard.vercel.app`) |
| Student web | `edu-web/student-web` (+ 5 worktrees) | `mahmoud-saleh145/student-web` | Next.js 15, React 19, TanStack Query 5, Shaka Player 4.11 (Widevine / FairPlay), hls.js, pdf.js 4, zustand | Vercel (`student-web-gray.vercel.app`) |
| Student mobile | `edu-mobile-final/mobile-app-student` | `youssef-hamed04/mobile-app-student` | Expo SDK 57, React Native 0.86, expo-router, expo-video (DRM), axios, TanStack Query, MMKV, SecureStore, a custom native content-protection module | EAS Build → Google Play (draft); iOS not started |

## 2. Data flow

```
Dashboard (Vercel, Next BFF: HTTP-only cookies) ─┐
Student web (Vercel, Next BFF: HTTP-only cookies) ┼──HTTPS /api/v1──► NestJS API (Render) ──► Postgres (Neon)
Mobile app (bearer tokens in SecureStore)        ─┘                     │  ├─► Redis (Upstash): throttling, stream slots, queue
                                                                         │  ├─► R2 (uploads / media / library buckets)
                                                                         │  ├─► Gumlet (DRM packaging, Widevine/FairPlay licences)
                                                                         │  └─► Cloudinary (course thumbnails)
                                                                         ▼
                                                   BullMQ worker (Docker) — transcode / Gumlet ingest / DRM verification sweep
Viewer ──signed URL──► Cloudflare Worker (HMAC check + ticket-liveness probe to the API) ──► R2
Viewer ──DRM licence──► Gumlet licence servers (signed per ticket)
```

- **Both web front ends are BFFs.** The browser never sees a token. `/api/proxy/[...path]` forwards to the API with `Authorization: Bearer`, refreshing server-side.
- **API envelope.**
  - Success: `{ success, data, meta }`.
  - Error: `{ success:false, error{code,message,fields}, code, message, errors, statusCode, requestId }`.
  - Validation uses `whitelist + forbidNonWhitelisted`, so **any unknown body or query field is a 422**. Every additive client field is therefore a deployment-order dependency: the backend ships first.

## 3. Authentication and authorization (backend)

- **Access token:** HS256 JWT, 15 min, `{sub, sid, role}`. Every request reloads the session row, so revocation is immediate.
- **Refresh token:** a separate secret, 30 days or more, stored as SHA-256. It is single-use, rotated, and family-revoked on reuse (with a 30 s grace).
- **Global guards** (order after the audit): `JwtAuthGuard` → `ThrottlerProxyGuard` → `RolesGuard`. Course-level ownership and capability checks live in `CourseAccessService` (`assertCanManageCourse(..., 'content' | 'pricing' | 'students')`).
- **Teacher capabilities** are platform settings (`teacher.canDeleteLectures`, `canDeleteVideos`, `canEditVideoUrls`, `canEditCoursePrices`).
- **Device binding (students):**
  - `X-Device-Id` is registered at login, and the first device is auto-bound.
  - The production limit is **1 device** (`/meta/app-config`).
  - Protected content (tickets, protected attachments, library) requires an ACTIVE device.
- **Playback:**
  - Ticket issuance runs a strict DRM gate, then checks publication, course / section / drip entitlement, device, concurrency (production: **1 stream**), the play allowance and the hourly issuance cap.
  - Heartbeats every 30 s re-check access and rotate the ticket before its 300 s TTL.

## 4. Business rules found in code (not assumed)

- **Enrollment methods:** FREE, ADMIN_APPROVAL, CODE (course cards and section/part cards), PAYMENT (provider `none` in production: online payment is off).
- **Wallet credit** is for the **Library only**. Courses never debit the wallet.
- **Course parts** grant section-scoped access via `enrollment_section_grants`. Whole-course access is `coversAllSections`.
- **Academic system** (year vs level) belongs to the college (faculty override, else university default). Students do not choose it, and `studyType` is legacy and tolerated.
- **Videos are DRM-only** (Gumlet). There is no legacy HLS fallback for students.
- **Media protection:**
  - Android: FLAG_SECURE + Widevine L1, which is platform-enforced.
  - iOS: FairPlay, plus best-effort capture detection.
  - Web: Widevine/FairPlay via Shaka plus a DOM watermark. Screen recording **cannot** be prevented on the web.

## 5. Production evidence collected (read-only, 2026-10-26 21:48 UTC)

| Source | Finding |
|---|---|
| `GET /api/v1/meta/health/deep` | DB, Redis, storage and worker all OK. **`videoPipeline.apiBuild: null`** (the API's commit is not reported). **Worker build `b7ad4c844aea`** = commit `b7ad4c8` on branch `fix/gumlet-failed-asset-recovery`, which is **not merged to `main`**. Videos by status: READY 109, UPLOADING 10, FAILED 1, ARCHIVED 9. The DRM sweep reports 1 video failing verification. |
| `GET /api/v1/meta/app-config` | `minimumAppVersion 1.0.0`; `maxConcurrentStreams 1`; `device.limitPerStudent 1`; **support contacts all empty**; no `teacher` block (confirms dashboard finding F4 in production). |
| `GET /api/v1/courses` | Course thumbnails are Cloudinary URLs (cloud `k0v5mrbm`), so the unsigned-R2-thumbnail finding does not affect course images. The cloud name differs from the one committed in `.env.example`. |

**Implications.**
1. The worker in production runs code that `main` does not contain. If the API runs `main`, the API and worker disagree, which is exactly what `apiBuild` is meant to reveal. Set `BUILD_COMMIT` on the API (or confirm `RENDER_GIT_COMMIT` is exposed) so `apiBuild` stops being null.
2. **Ten videos are stuck at UPLOADING.** That matches the scenario your uncommitted "upload interruption recovery" work fixes. They need either that fix deployed plus a "complete" per video, or cleanup.
3. Support contacts are empty server-side. The "contact an admin" screens fall back to build-time env values (mobile) or may show nothing (web). Fill them in under Dashboard → Settings.

## 6. Repository relationships

- The **backend, dashboard and web** each use `git worktree` folders for parallel branches (listed in `LOCAL_CHANGES_AND_DEPLOYMENT_RISK.md`).
- **Mobile** has a nested, unrelated Git repo at `mobile-app-student/mobile-app/`.
- **Two authors:**
  - `mahmoud-saleh145`: backend, dashboard, web, and the local mobile work.
  - `youssef-hamed04`: the mobile remote, and an earlier dashboard PR.

## 7. Verification environment used for this audit (limitations)

- **No network to npm or GitHub** from either environment, and production was reachable **only** through the built-in browser on your computer, for public GET endpoints.
- **Tests and type checks ran on your computer**, against the installed `node_modules` (Windows-installed, executed by a Linux VM).
- **Next.js production builds could not run:** only the Windows SWC/lightningcss/tailwind-oxide binaries are installed.
- **No Android SDK and no EAS login** were available, so no new APK/AAB could be built.
- **Throughput on the mounted folders dropped sharply mid-session** (a single backend spec went from about 30 s to about 160 s), which limited how much of the backend suite could be re-run (see `IMPLEMENTATION_REPORT.md` §5).
