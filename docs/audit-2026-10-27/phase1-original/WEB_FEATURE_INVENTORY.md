# Student web — feature inventory

> **Post-audit status (2026-10-27).** The inventory below is the code-derived snapshot taken *before* the fixes. These items changed afterwards (finding IDs refer to `findings/web_findings.md`):
>
> | Finding | Area | Before | After |
> |---|---|---|---|
> | F1 | Build | `@vercel/analytics` imported but undeclared → a clean build fails | declared in `package.json` and the lockfile (2.0.1, integrity from the installed copy) |
> | F2 | Session refresh | 12 h idle → forced sign-out | refreshes from the 30-day cookie |
> | F3, F4 | Session generation and cooldown | process-global | per browser (device cookie) |
> | F5 | Proxy 401 handling | any 401 → refresh / sign-out | only token 401s |
> | F7 | Catalogue year filter | faculty id sent as `departmentId` | sends `facultyId` |
> | F13 | Attachment viewer | re-issued its ticket on window focus | no longer refetches on focus/reconnect |
> | F15 | My Courses "All" tab | hid pending enrolments | shows every enrolment |
> | F17 | Sign-out with an expired access token | left the server session alive | refreshes once, then revokes |
>
> Verification: `node --test` **369/369 pass**; `tsc --noEmit` clean; ESLint clean on every changed file. `next build` could not run here (Windows-only native binaries).
> Still open (web WIP area): F6, F8–F12, F14, F16, F18–F26.


Scope: `web` (Next.js 15, React 19, TanStack Query 5, zustand), checked against `backend` (NestJS). Features were found by reading the code, not the docs. The snapshot includes in-progress work (player tracking, `DrmVideo`, `curriculum.ts`, `playback-tracking.ts`, `watch-clock.ts`, `courses/page.tsx`, `features/api.ts`).

Paths are relative to `web/src/` unless they start with `backend/`.

Status values: **complete**, **partial**, **broken**, **duplicated**, **missing-backend**, **not-verifiable**. Defects are listed in `web_findings.md` (IDs F1 to F28).

---

## 0. Architecture these features share

| Concern | Implementation | Evidence |
|---|---|---|
| Transport | The browser never calls the backend. Every call goes to the same-origin BFF `/api/proxy/[...path]`, which forwards to `API_BASE_URL` (default `http://localhost:3000/api/v1`). | `lib/api-client.ts:94-150`, `app/api/proxy/[...path]/route.ts:69-280`, `lib/session.ts:22-95` |
| Envelope | Backend success body is `{success, data, meta}`. Paginated results keep `{items, meta}` inside `data` (`backend/src/common/interceptors/response.interceptor.ts:46-57`). The proxy re-wraps to `{success, data, meta}` and the client unwraps `data`. Error bodies carry both a nested `error{code,message,fields}` and flat `code/message/errors`. | `lib/api-client.ts:146-149`, `backend/src/common/filters/all-exceptions.filter.ts:39-56` |
| Error envelope from proxy | `jsonError()` forwards **only** `code` and `message`. Field errors and `Retry-After` are dropped (F6). | `app/api/proxy/[...path]/route.ts:60-67` |
| Token storage | Access token in `edu_at` (HttpOnly, SameSite=Lax, Secure in prod, 12h). Refresh token in `edu_rt` (HttpOnly, 30d). Profile snapshot in `edu_pf` (HttpOnly JSON, unsigned, 30d). Device id in `edu_did` (HttpOnly, 2y). Page scripts can read none of them. | `lib/cookie-names.ts`, `lib/session-cookies.ts:25-115` |
| CSRF | Every non-GET call needs the custom header `x-web-request: 1`. The proxy and all three auth routes enforce it. There is no Origin check, and `APP_ORIGIN` is parsed but never used. | `lib/web-request.ts`, proxy `route.ts:85-89`, `lib/config.ts:47` |
| Refresh | On an upstream 401 the proxy runs a server-side single-flight refresh keyed by refresh token, then retries once. A 30s cooldown follows an inconclusive failure, and a "session generation" counter guards against late writes. Both the cooldown and the counter are process-global, not per user (F3, F4). Backend allows a 30s reuse grace (`backend/src/modules/auth/auth.service.ts:410-425`). | `lib/refresh-lock.ts`, proxy `route.ts:157-279` |
| Client session end | Any query or mutation error with status 401, or code `SESSION_EXPIRED`/`ACCOUNT_DISABLED`, triggers POST `/api/auth/logout` and then a hard navigation to `/login?reason=…&next=…`. | `app/providers.tsx:19-22`, `lib/session-end.ts:22-35`, `lib/error-messages.ts:45-49` |
| Query cache | One QueryClient per browser. Defaults: `staleTime` 30s, retry once except on 4xx, `refetchOnWindowFocus: true`. A language change invalidates every query. Logout does a full reload, which clears the cache. | `app/providers.tsx:19-55` |
| localStorage | `edu-web-language`, `edu-web-theme`, `edu-web-player` (zustand persist), `edu-web-recents` (search history). No tokens or PII except search terms. | `store/stores.ts`, `app/search/page.tsx:18,72-94` |
| Route guard | Edge middleware redirects to `/login?next=` when neither `edu_rt` nor `edu_at` exists. It checks that a cookie is present and nothing else. Pages also redirect client-side when `useSession().status === 'unauthenticated'`. The backend is the only authorisation. Public pages: `/`, `/login`, `/register`, `/password-help`. | `middleware.ts`, `lib/route-guard.ts:10-15` |
| Blocked paths | The proxy refuses `auth/login|register|refresh|logout`, `admin`, `analytics`, `audit`, `sessions`, `master`, staff storage/users/enrollments/courses, notification broadcast, and any path with an `admin` or `students` segment. | `lib/proxy-rules.ts:11-48` |
| Public reads (no session) | Exact GET regexes only: universities, faculties, departments, academic-years, academic-selection. | `lib/proxy-rules.ts:64-86` |
| Headers to backend | `authorization`, `x-client: web`, `x-device-id`, `x-device-platform: web`, `x-app-version`, and `accept-language` (en/ar from the app setting). At sign-in also `x-device-model/os/name`. | `lib/session.ts:37-52`, `lib/web-device.ts` |
| Security headers | `X-Frame-Options: SAMEORIGIN`, CSP `frame-ancestors 'self'` only, `nosniff`, Referrer-Policy, Permissions-Policy. No script-src CSP. | `next.config.ts` |

---

## 1. Features

### 1.1 Sign-in (login)
- **Purpose:** sign in with phone and password. Students only.
- **Files/route:** `/login` → `app/login/page.tsx`; handler `app/api/auth/login/route.ts`; schema `features/schemas.ts` (`loginSchema`, Egyptian phone normalisation).
- **Who:** anonymous visitors. Non-STUDENT roles and non-ACTIVE accounts are refused after the backend has already authenticated them (`login/route.ts:65-79`).
- **API:** browser POST `/api/auth/login` (`login/page.tsx:60`) → BFF POST `/auth/login` with the device headers (`login/route.ts:43-61`) → `backend/.../auth/auth.controller.ts:42` `LoginDto{phone,password}`. Fields match.
- **Persistence:** sets `edu_at`, `edu_rt`, `edu_pf`, and `edu_did` if new (`login/route.ts:94-101`). Bumps the global session generation and resets refresh state (`:88-92`, see F3/F4).
- **Loading/error:** react-hook-form `isSubmitting`. `InlineError` shows a translated code. `?reason=` from a forced logout shows why the last session ended. `?next=` is sanitised by `safeNextPath`.
- **Security:** tokens never reach JS. Login CSRF is blocked by the header requirement. When a staff or disabled account is refused, the backend session and device binding already exist (F24).
- **Status: complete** (with F24).

### 1.2 Registration and academic onboarding
- **Purpose:** three-step sign-up: account, then academic (university → faculty → department → year/level, plus gender), then review.
- **Files/route:** `/register` → `app/register/page.tsx`; `app/api/auth/register/route.ts`; schemas `registerAccountSchema`, `registerAcademicSchema`.
- **Who:** anonymous visitors.
- **API:**
  - GET `catalog/universities` (`features/api.ts:78`) → `catalog.controller.ts:225` (public)
  - GET `catalog/universities/:id/faculties` (`:80`) → `:232`
  - GET `catalog/faculties/:id/departments` (`:82-84`, `studyType` not sent here) → `:239`
  - GET `catalog/academic-selection?departmentId|facultyId|universityId` (`:98-101`) → `:262` `AcademicScopeQueryDto`. Returns `{academicSystem, academicYears, ladderKind, ladderMatchesSystem}` and the year/level label comes from it.
  - POST `/api/auth/register` (`register/page.tsx:233`) → BFF POST `/auth/register` (`register/route.ts:29-40`) → `auth.controller.ts:26` `RegisterDto`. Fields match. `locale` is optional and never sent, so the backend defaults to `'en'`.
- **Persistence:** same cookies as login. Catalog lists are cached for 30 minutes.
- **Loading/error:** each select is driven by its query. Dependent fields reset on parent change, and a year that drops out of the ladder is cleared. `PHONE_ALREADY_REGISTERED` sends the user back to step 0. The register route preserves field errors because it does not go through `jsonError`.
- **Security:** reads run through the proxy's tokenless public allow-list.
- **Status: complete.**

### 1.3 Session refresh / BFF proxy
- **Purpose:** transparent access-token renewal and request forwarding.
- **Files:** `app/api/proxy/[...path]/route.ts`, `lib/refresh-lock.ts`, `lib/session.ts`, `lib/session-cookies.ts`.
- **API:** POST `/auth/refresh {refreshToken}` (server only, `route.ts:311-320`) → `auth.controller.ts:68` `RefreshDto`.
- **Behaviour:**
  - Single-flight per refresh token.
  - One retry with the new access token.
  - A definitive 400/401/403 clears the cookies. 5xx or a timeout returns 503 `SESSION_REFRESH_UNAVAILABLE`, which does not end the session.
  - A 401 on the retry clears the cookies.
  - A successful GET of `auth/me` rewrites `edu_pf`.
- **Status: partial / broken in specific cases.**
  - F2: no refresh when the access cookie is gone, so sessions die after 12h idle.
  - F3: a sign-in or sign-out by any user discards other users' in-flight refreshes.
  - F4: the cooldown and in-flight reset are global.
  - F5: every upstream 401 is treated as token expiry.
  - F6: error fields are dropped.
  - The in-memory lock is single-process by design (`refresh-lock.ts:22-33`). Multi-instance deploys are **not-verifiable**.

### 1.4 Sign-out
- **Files:** `app/api/auth/logout/route.ts`, `lib/session-context.tsx:86-99` (`signOut`), `lib/session-end.ts` (forced).
- **API:** browser POST `/api/auth/logout` → BFF POST `/auth/logout` with the access token only (`logout/route.ts:37-49`) → `auth.controller.ts:86`. This revokes the session, its refresh tokens, its playback slot and its push token.
- **Persistence:** clears `edu_at`, `edu_rt`, `edu_pf`. Keeps `edu_did` on purpose. Search recents are not cleared (F21).
- **Status: partial.** With an expired or missing access cookie the backend call 401s or is skipped. The refresh token stays valid server-side for up to 30 days, and no refresh is attempted first (F17). "Log out all devices" (`POST /auth/logout-all`) is not offered.

### 1.5 Device identity, binding and devices page
- **Purpose:** keep one stable browser id, show authorised devices, and request a device change.
- **Files:** `lib/web-device.ts`, `lib/session-cookies.ts:97-119`, `/settings/devices` → `app/settings/devices/page.tsx`.
- **API:**
  - GET `devices` (`features/api.ts:610`) → `devices.controller.ts:36` (`current` is computed from `x-device-id`)
  - POST `devices/change-request {reason}` (`:617`) → `:52`. The page appends the user agent to the reason (`devices/page.tsx:25`), capped at 500 characters by the backend DTO.
- **Error handling:** `DEVICE_NOT_AUTHORIZED` and `DEVICE_CHANGE_PENDING` are deliberately not session-ending. They show translated messages, and SupportLinks offer WhatsApp/email.
- **Security:** device id is an HttpOnly random UUID. It is not fingerprinting.
- **Status: complete** (F25 is a suspected id race when the cookie is missing).

### 1.6 Password help / password change
- **Password help:** `/password-help` is static guidance plus support channels from `NEXT_PUBLIC_SUPPORT_*`. **complete**.
- **Password change:** `changePasswordSchema` exists (`features/schemas.ts`) but there is no screen and no call. The backend supports POST `/auth/password` (`auth.controller.ts:132`). **missing (web)**. Wiring it through the current proxy would hit F5: a wrong current password returns `INVALID_CREDENTIALS`, which is a 401.

### 1.7 Home dashboard
- **Files/route:** `/home` → `app/home/page.tsx`.
- **API:** GET `home/feed` (`features/api.ts:206`) → `home.controller.ts:15` → `{continueWatching, myCourses, newCourses, recommended, announcements, stats}`. Shape matches `HomeFeed`. Also GET `notifications/unread-count`.
- **Navigation:** announcements and banners route through `toWebRoute()`, which maps mobile `/course/:id` to `/courses/:id`.
- **Loading/error:** skeleton, then `ErrorState` with retry, then empty state.
- **Status: complete.** Not invalidated after enroll or redeem (F22).

### 1.8 Course catalogue (browse, filter, sort)
- **Files/route:** `/courses` → `app/courses/page.tsx` (in progress); `components/courses/CourseCard.tsx`.
- **API:**
  - GET `courses?sort&free&q&academicYearId&page&pageSize` (`features/api.ts:220-224`) → `courses.controller.ts:29` `ListCoursesDto`. Params and the sort enum match.
  - GET `profile` (`:199`)
  - GET `catalog/academic-years?departmentId=<facultyId>` (`courses/page.tsx:113` → `features/api.ts:85-88`). The faculty id is sent under the wrong parameter name (F7).
- **Persistence:** infinite query keyed by filters. Filter state is not in the URL.
- **Loading/error:** skeleton grid, `ErrorState` with retry, empty state, "see all" for the next page. Search is not debounced, so each keystroke is a request.
- **Status: partial.** F7 (year filter list comes from the wrong scope). F8 (`?teacherId=` deep links from search are ignored; `CourseFilters.teacherId` is never set).

### 1.9 Global search
- **Files/route:** `/search` → `app/search/page.tsx`.
- **API:** GET `search?q&entity` (`features/api.ts:546`, needs 2 or more characters, 350ms debounce) → `search.controller.ts:27`. Returns `SearchResultGroup[]`, which matches. Routes are mapped with `toWebRoute`.
- **Persistence:** recent terms in localStorage (F21).
- **Status: partial.** Teacher results open `/courses?teacherId=…` and show an unfiltered list (F8). `search/suggestions` is unused.

### 1.10 Course detail and curriculum (parts → sections → lessons)
- **Files/route:** `/courses/[id]` → `app/courses/[id]/page.tsx`; grouping in `features/curriculum.ts` (in progress, matches sections by id); flags in `lib/course-access.ts`.
- **API:**
  - GET `courses/:id` (`features/api.ts:246`) → `courses.controller.ts:69`
  - GET `courses/:id/parts` (`:264`) → `course-parts.controller.ts:49` (StudentOnly)
- **Loading/error:** skeleton, `ErrorState` with retry. Locked lessons show a toast and open the join sheet.
- **Status: complete.**

### 1.11 Joining: free, admin approval, access code (course or part)
- **Files:** `JoinSheet` in `app/courses/[id]/page.tsx`, `joinSheetActions` in `lib/course-access.ts:69-80`.
- **API:**
  - GET `courses/:id/join-options` (`features/api.ts:254`) → `course-parts.controller.ts:60`. `methods.wallet` is always false and `onlinePayment` follows the provider.
  - POST `courses/:id/enroll {method: FREE|ADMIN_APPROVAL}` (`:272`) → `enrollments.controller.ts:88` `JoinCourseDto` (StudentOnly)
  - POST `courses/:id/redeem {code}` (`:282`) → `enrollments.controller.ts:119` `RedeemCodeDto` (uppercase, 4–40 characters `[A-Za-z0-9-]`)
- **Cache:** both mutations invalidate `['courses']`.
- **Not used:** POST `codes/validate`. `useValidateCode` exists but no screen calls it, so there is no preview of what a code grants.
- **Status: partial.**
  - Online payment is intentionally not rendered. A course whose only method is `PAYMENT` gets an empty sheet with no message (F18).
  - Picking a part ("intent") only changes hint text, because the code determines the target.
  - `EnrollmentResult.payment.checkoutUrl` is never used.
  - Course-part purchase with the wallet is **missing-backend by design**: the backend says courses never debit the wallet.

### 1.12 My courses
- **Files/route:** `/my-courses` → `app/my-courses/page.tsx`.
- **API:** GET `courses/mine?page&pageSize` (`features/api.ts:222`) → `courses.controller.ts:54`. Returns ACTIVE, EXPIRED, ARCHIVED, PENDING_APPROVAL and PENDING_PAYMENT.
- **Status: partial.** Tabs filter client-side over the pages loaded so far. PENDING courses appear in no tab, and the tab labelled "All" only holds expired, archived and revoked courses (F15).

### 1.13 Lesson page (detail, outline, mark complete)
- **Files/route:** `/lessons/[id]` → `app/lessons/[id]/page.tsx`.
- **API:**
  - GET `lessons/:id` (`features/api.ts:298`) → `lessons.controller.ts:75`
  - GET `courses/:courseId` and `courses/:courseId/parts` for the outline
  - POST `lessons/:id/complete` (`:313`) → `lessons.controller.ts:103`, honoured for MANUAL rules only. It returns 409 `INVALID_STATE` otherwise.
- **Video states:** UPLOADING, QUEUED and PROCESSING show "not ready". FAILED and ARCHIVED show a generic error. Otherwise "Watch now" pushes `/player/:videoId`, and the lesson id is not carried (F23).
- **Status: complete,** except that a mark-complete error is silent (F19).

### 1.14 Video player (protected playback)
- **Files/route:** `/player/[id]` (video id) → `app/player/[id]/page.tsx` (in progress); `components/protection/DrmVideo.tsx` (Shaka 4.11.7, in progress); `lib/drm-playback.ts`, `lib/playback-platform.ts`, `lib/gumlet-embed.ts`, `lib/fairplay*.ts`, `lib/drm-diagnostics.ts`.
- **Who:** an entitled student on a bound device. The backend checks entitlement, device binding, concurrency and play allowance.
- **API:**
  - GET `lessons/by-video/:videoId` (`features/api.ts:306`, no `?lessonId`) → `lessons.controller.ts:87`
  - POST `playback/videos/:videoId/ticket {platform: ios|android|web, delivery?: 'embed'}` (`player/[id]/page.tsx:236`) → `playback.controller.ts:118` `IssueTicketDto`. `lessonId` and `maxHeight` are never sent.
  - GET `playback/videos/:videoId/allowance` (`:242`, errors swallowed) → `:219`
  - The media itself is fetched directly by hls.js, Shaka or the iframe, not through the proxy: `ticket.manifestUrl`, `drm.licenseUrl`, `drm.certificateUrl`.
- **Three render branches:**
  1. **Gumlet embed iframe.** Used only when a ticket for an iOS web client carries a valid `https://play.gumlet.io/embed/<id>?token&expires` (`gumlet-embed.ts:57-78`).
  2. **Shaka DRM.** Widevine over DASH, or FairPlay over native HLS on iOS (`drm-playback.ts:37-52`).
  3. **Legacy.** hls.js or native `<video src>` for AES-128 HLS served by `backend/playback/manifest/:ticketId/*`.
- **Loading/error:** "authorizing", then `ErrorState` with retry, which requests a new ticket. DrmVideo shows a fatal overlay with a sanitised stage code and trace, and never falls back to a clear stream.
- **Protection mechanisms:** these are deterrence, not prevention. See 1.16.
- **Status: partial.**
  - F10: the legacy rotation reload jumps playback back.
  - F11: the embed branch has no tracking.
  - F12: the DRM branch ignores resume position and playback rate, ±10s does nothing, and native fullscreen drops the watermark.
  - F23: lessonId is never sent.
  - Real-device DRM (Widevine level, FairPlay on iOS) is **not-verifiable** here.

### 1.15 Playback tracking (heartbeat, progress, rotation, release)
- **Files:** `app/player/[id]/page.tsx:136-361`, `lib/playback-tracking.ts` (new), `lib/watch-clock.ts` (new).
- **API:**
  - POST `playback/tickets/:id/heartbeat {positionSeconds, watchedDeltaSeconds, protection:{recording:false, externalDisplay:false}}` every `max(10, heartbeatIntervalSeconds)` seconds (`page.tsx:293-343`) → `playback.controller.ts:162` `HeartbeatDto`. Fields match. The response `{ok, terminate}` or `{ok, ticket}` (rotation) is handled by `planHeartbeatResult`.
  - POST `progress {lessonId, positionSeconds, watchedSeconds}` (`:339, :357, :464, :514`) → `progress.controller.ts:51` `ProgressItemDto`. Fields match.
  - DELETE `playback/tickets/:id` on unmount (`:348`) → `:190`.
- **Error handling:** every tracking call is fire-and-forget (`.catch(() => {})`). A terminate pauses the media and shows `PLAYBACK_DENIED`.
- **Status: partial.**
  - F9: the final progress flush on unmount never runs.
  - No `pagehide`/`beforeunload` handler, so a tab close releases nothing.
  - F11: the embed branch has no tracking.
  - Unit tests exist (`app/player/playback-tracking*.test.ts`). They could not be fully run because node_modules is incomplete (F27).

### 1.16 Content protection: watermark and anti-copy (deterrence only)
- **Watermark** (`components/protection/Watermark.tsx`): the server-issued `primary` (name) and `secondary` ("ID: xxxxxxxx") are tiled at 9% opacity, plus a moving badge. It is a DOM overlay, so it can be removed in devtools. `sessionTag` from the ticket is never rendered, so a leak traces to the user, not the session.
- **PDF burn-in** (`ProtectedPdf.tsx:100-101`, `lib/pdf-watermark.ts`): a brand image and the identity text are drawn into canvas pixels. It survives screenshots but not re-photography.
- **Anti-copy:** `copy` and `contextmenu` are prevented on the player and viewer pages. The legacy `<video>` has `controlsList="nodownload … nofullscreen"` and `disablePictureInPicture`.
- **DRM (Gumlet Widevine/FairPlay):** licence URLs are signed server-side and short-lived, and the Gumlet secret never reaches the client (`DrmVideo.tsx:55-68`). Desktop Chrome usually negotiates software Widevine (L3). The component states that robustness is requested, not verified.
- **What a browser cannot enforce:**
  - Screenshots and screen recording cannot be blocked. The heartbeat hardcodes `recording:false`.
  - Signed manifest, licence and media URLs are visible in devtools and usable by anyone until they expire, within the bounds of the edge signature.
  - The DRM `<video controls>` and the Gumlet iframe allow native fullscreen, where the overlay watermark is not shown (F12).
  - The settings/security page says this honestly (`app/settings/security/page.tsx`).
- **Status: complete as deterrence. Prevention is not claimable.**

### 1.17 Course attachments viewer (PDF / image)
- **Files/route:** `/viewer/[id]` → `app/viewer/[id]/page.tsx`; `components/documents/ProtectedPdf.tsx` (pdf.js 4.10, worker self-hosted, `disableFontFace`, cmaps and fonts from `/pdfjs/**`, exempted in middleware).
- **API:** GET `attachments/:id/ticket` (`features/api.ts:321-334`, `staleTime:0`, `gcTime:0`, `retry:false`) → `attachments.controller.ts:55`. Returns `{url, headers:{}, expiresAt, watermark}` and logs a `watchEvent STARTED` per ticket. The bytes are then fetched by pdf.js or `<img>` directly from the signed media URL, with no credentials.
- **Behaviour:** the type is decided from the URL extension. Non-PDF and non-image files show an "unsupported" message, on purpose, so the raw file is never handed over.
- **Status: partial.**
  - F13: the ticket is re-issued on every window focus, which re-downloads and re-renders the document and logs a new event.
  - F14: every page is rendered eagerly, so large PDFs can run out of memory.
  - Course-level list endpoints (`courses/:id/attachments`, `lessons/:id/attachments`) are not used; the data comes embedded in course and lesson detail.

### 1.18 Library (materials, packages, purchase with wallet, my library, reader)
- **Files/routes:** `/library` → `app/library/page.tsx` (browse and mine tabs); `/library/[id]` → `app/library/[id]/page.tsx`; `/library/reader/[id]` → `app/library/reader/[id]/page.tsx`.
- **API (all StudentOnly):**
  - GET `library/materials?q&page&pageSize` (`features/api.ts:374-376`) → `library.controller.ts:58`
  - GET `library/materials/:id` (`:408`) → `:78`
  - GET `library/me` (`:391`) → `:92`
  - POST `library/quote {kind: PART|PACKAGE, targetId}` (`:415`) → `:113` `PurchaseLibraryDto`
  - POST `library/purchase` (`:422`, idempotent server-side) → `:129`. Invalidates library and wallet.
  - POST `library/parts/:id/open` (`:436`) → `:146`. Returns a signed URL bound to user, session and device, plus a watermark.
- **Loading/error:** skeletons, `ErrorState` with retry. The quote sheet distinguishes three outcomes: buy, top up, or not purchasable. The reader opens once per mount, guarded by a ref for StrictMode.
- **Unused:** purchase history GET `library/me/purchases`.
- **Status: complete** (F20 is a cosmetic badge label). Browse search is not debounced.

### 1.19 Wallet (balance, history, recharge cards)
- **Files/route:** `/wallet` → `app/wallet/page.tsx`.
- **API:**
  - GET `wallet` (`features/api.ts:339`) → `wallet.controller.ts:26`
  - GET `wallet/transactions?page&pageSize` (`:346-348`) → `:37`
  - POST `wallet/redeem {code}` (`:363`) → `:61`. Invalidates the wallet.
- **Status: partial.** The "total in" and "total out" figures are summed from the transactions loaded so far, ignoring the summary's `totalRecharged`/`totalSpent`. If the summary fails, the balance shows 0 (F16).

### 1.20 Notifications
- **Files/route:** `/notifications` → `app/notifications/page.tsx`; unread badge from `useUnreadCount`, used on home, profile and notifications only.
- **API:**
  - GET `notifications?page&pageSize&unread` (`features/api.ts:445-446`) → `notifications.controller.ts:87`. The `unread` name matches `ListNotificationsDto`.
  - GET `notifications/unread-count` (`:462`, polled every 180s) → `:107`, `{count}`
  - POST `notifications/:id/read` (`:471`, optimistic with rollback) → `:116`
  - POST `notifications/read-all` (`:509`) → `:123`
  - GET/PUT `notifications/preferences` (`:519`, `:526`, optimistic) → `:161`, `:167`
- **Routing:** `toWebRoute` maps backend mobile routes, with a fallback.
- **Status: complete.** Web push (`notifications/devices`) is not implemented, by design.

### 1.21 Profile (view, edit name, avatar)
- **Files/routes:** `/profile` → `app/profile/page.tsx`; `/profile/edit` → `app/profile/edit/page.tsx`; `features/avatar.ts`.
- **API:**
  - GET `profile` (`features/api.ts:199`) → `profile.controller.ts:56`
  - PATCH `profile {fullName}` (`:625`) → `:62`
  - POST `storage/uploads/avatar {contentType, sizeBytes}` (`avatar.ts:36`) → `storage.controller.ts:188`
  - PUT to the presigned `uploadUrl` with `requiredHeaders` (`avatar.ts:47`), directly to object storage
  - PUT `profile/avatar {avatarUrl: objectKey|null}` (`avatar.ts:55,59`) → `profile.controller.ts:72`
- **After success:** `auth/me` is re-read, which rewrites `edu_pf`.
- **Status: complete.** The direct-to-storage PUT depends on bucket CORS: **not-verifiable**. Backend note: `SetAvatarDto` accepts any string up to 500 characters and does not check that the key belongs to the user (backend issue, outside web scope).

### 1.22 Settings
| Page | Function | Status |
|---|---|---|
| `/settings` | Hub with links | complete |
| `/settings/language` | en/ar in localStorage; changes `dir`/`lang` and refetches all queries | complete. Not synced to `profile.locale`. |
| theme | system/light/dark in localStorage, applied before first paint (`layout.tsx` boot script) | complete |
| `/settings/playback` | quality, rate, autoplay next, captions, data saver | **partial**: quality and data saver are stored but never read. Rate only affects the legacy player (F26). |
| `/settings/notifications` | preference toggles (see 1.20) | complete |
| `/settings/security` | static explanation of the web limits | complete |
| `/settings/devices` | see 1.5 | complete |
| `/settings/about` | app version | complete |
| `/settings/delete-account` | opens a support ticket (POST `support/tickets`, GENERAL) | complete. There is no self-service delete endpoint in the backend. |

### 1.23 Support (tickets and contact links)
- **Files/routes:** `/support`, `/support/new`, `/support/[id]`; `components/support/SupportLinks.tsx`, `lib/support.ts` (WhatsApp, phone and email from `NEXT_PUBLIC_*`).
- **API (StudentOnly):**
  - GET `support/tickets?page&pageSize` (`features/api.ts:558`) → `support.controller.ts:89`
  - GET `support/tickets/:id` (`:575`) → `:100`
  - POST `support/tickets {subject, body, category, courseId?}` (`:587`) → `:81` `CreateTicketDto`
  - POST `support/tickets/:id/messages {body}` (`:597`) → `:110`
- **Validation:** client-side lengths mirror the DTO (3–200 and 3–4000). A closed ticket disables reply.
- **Status: complete.**

### 1.24 i18n, RTL and formatting
`i18n/dictionaries.ts` (en/ar), `lib/format.ts`, `lib/locale.ts`. Default language is Arabic. Backend raw messages are never shown; translated keys are used, with a fallback by status (`lib/error-messages.ts`). DrmVideo fatal messages are hard-coded English. **complete**.

### 1.25 Analytics
`app/layout.tsx:5,91` imports and renders `@vercel/analytics/next`. The package is not in `package.json`, `package-lock.json` or `node_modules`. **broken** (F1): `next build` cannot resolve the module.

### 1.26 Dead or duplicated code
- `app/api/auth/session/route.ts`: unused, duplicates `getSessionUser`. **duplicated/unused**
- `ApiError`, `toApiError`, `networkError` and `asApiError` exist twice: `lib/api-client.ts` (client) and `lib/errors.ts` (server). **duplicated**
- The `SessionUser` shape is declared three times (`session.ts`, `session-context.tsx`, `providers.tsx`).
- `types/api.ts` `RequestOptions` (`anonymous`, `skipRefresh`, `retries`, `timeoutMs`) is unused.
- Query keys with no feature behind them: `qk.courses.progress`, `playAllowance`, `myParts`, `qk.progress.continueWatching`, `qk.search.suggestions`, `qk.library.purchases`, `qk.library.document`, `qk.playback.ticket`, `qk.auth.session`.
- `env.example` and `.env.example` are duplicates that differ only in line endings.

### 1.27 Backend student capabilities the web does not use (missing in web)
- POST `/auth/password`
- GET `/auth/sessions`, POST `/auth/logout-all`, GET `/auth/session`
- GET `/devices/current`
- POST `/codes/validate` (hook exists, no screen)
- GET `/me/part-purchases`, GET `/library/me/purchases`, GET `/payments/mine` (no purchase history anywhere)
- GET `/progress/continue-watching` (covered by the home feed), GET `/progress/lessons/:id`, POST `/progress/batch` (no offline queue)
- GET `/search/suggestions`
- POST `/playback/security-events`
- GET `/meta/app-config` (maintenance, minimum version and feature flags are ignored)
- GET `/subjects` (library subject filter)
- POST `/notifications/devices` (web push)

---

## 2. Every endpoint the web calls

"Client" is the file and line that issues the call. All calls go through the proxy unless marked *direct* or *BFF*. Backend paths are under `/api/v1`.

| # | Method | Path (as sent) | Client file:line | Backend handler / DTO | Auth |
|---|---|---|---|---|---|
| 1 | POST | `/api/auth/login` → `/auth/login` (BFF) | `app/login/page.tsx:60`; `app/api/auth/login/route.ts:43-61` | `auth.controller.ts:42` `LoginDto{phone,password}` | public |
| 2 | POST | `/api/auth/register` → `/auth/register` (BFF) | `app/register/page.tsx:233`; `app/api/auth/register/route.ts:29-40` | `auth.controller.ts:26` `RegisterDto` | public |
| 3 | POST | `/api/auth/logout` → `/auth/logout` (BFF) | `lib/session-context.tsx:88`, `lib/session-end.ts:32`; `app/api/auth/logout/route.ts:41-45` | `auth.controller.ts:86` | bearer |
| 4 | POST | `/auth/refresh` (BFF, server only) | `app/api/proxy/[...path]/route.ts:311-320` | `auth.controller.ts:68` `RefreshDto` | public |
| 5 | GET | `/api/auth/session` (local, unused) | — | none (reads `edu_pf`) | — |
| 6 | GET | `auth/me` | `lib/session-context.tsx:57`; `features/api.ts:74` (unused) | `auth.controller.ts:106` | bearer |
| 7 | GET | `catalog/universities` | `features/api.ts:78` | `catalog.controller.ts:225` | public |
| 8 | GET | `catalog/universities/:id/faculties` | `features/api.ts:80` | `catalog.controller.ts:232` | public |
| 9 | GET | `catalog/faculties/:id/departments[?studyType]` | `features/api.ts:82-84` | `catalog.controller.ts:239` | public |
| 10 | GET | `catalog/academic-years[?departmentId]` | `features/api.ts:85-88` (called with a faculty id from `courses/page.tsx:113`, F7) | `catalog.controller.ts:251` `AcademicScopeQueryDto` | public |
| 11 | GET | `catalog/academic-selection?{departmentId\|facultyId\|universityId}` | `features/api.ts:98-101` | `catalog.controller.ts:262` | public |
| 12 | GET | `profile` | `features/api.ts:199` | `profile.controller.ts:56` | bearer |
| 13 | PATCH | `profile {fullName}` | `features/api.ts:625` | `profile.controller.ts:62` `UpdateProfileDto` | bearer |
| 14 | POST | `storage/uploads/avatar {contentType,sizeBytes}` | `features/avatar.ts:36` | `storage.controller.ts:188` `PresignAvatarDto` | bearer |
| 15 | PUT | presigned `uploadUrl` (*direct* to object storage) | `features/avatar.ts:47` | S3/R2 | presigned |
| 16 | PUT | `profile/avatar {avatarUrl}` | `features/avatar.ts:55,59` | `profile.controller.ts:72` `SetAvatarDto` | bearer |
| 17 | GET | `home/feed` | `features/api.ts:206` | `home.controller.ts:15` | bearer |
| 18 | GET | `courses?sort,free,q,academicYearId,page,pageSize` | `features/api.ts:223` | `courses.controller.ts:29` `ListCoursesDto` | public+opt bearer |
| 19 | GET | `courses/mine?page,pageSize` | `features/api.ts:222` | `courses.controller.ts:54` `PaginationDto` | bearer |
| 20 | GET | `courses/:id` | `features/api.ts:246` | `courses.controller.ts:69` | public+opt bearer |
| 21 | GET | `courses/:id/join-options` | `features/api.ts:254` | `course-parts.controller.ts:60` | student |
| 22 | GET | `courses/:id/parts` | `features/api.ts:264` | `course-parts.controller.ts:49` | student |
| 23 | POST | `courses/:id/enroll {method}` | `features/api.ts:272` | `enrollments.controller.ts:88` `JoinCourseDto` | student |
| 24 | POST | `courses/:id/redeem {code}` | `features/api.ts:282` | `enrollments.controller.ts:119` `RedeemCodeDto` | student |
| 25 | POST | `codes/validate {code,courseId?}` (hook never mounted) | `features/api.ts:291` | `codes.controller.ts:202` | student |
| 26 | GET | `lessons/:id` | `features/api.ts:298` | `lessons.controller.ts:75` | bearer |
| 27 | GET | `lessons/by-video/:videoId` (no `?lessonId`) | `features/api.ts:306` | `lessons.controller.ts:87` | bearer |
| 28 | POST | `lessons/:id/complete` | `features/api.ts:313` | `lessons.controller.ts:103` | bearer |
| 29 | GET | `attachments/:id/ticket` | `features/api.ts:328` | `attachments.controller.ts:55` | bearer |
| 30 | GET | signed media URL (*direct*, pdf.js or `<img>`) | `components/documents/ProtectedPdf.tsx:68`; `app/viewer/[id]/page.tsx:60` | media origin / CDN worker (`playback/media-origin.controller.ts:79` in dev) | signed URL |
| 31 | GET | `wallet` | `features/api.ts:339` | `wallet.controller.ts:26` | student |
| 32 | GET | `wallet/transactions?page,pageSize` | `features/api.ts:346-348` | `wallet.controller.ts:37` `ListTransactionsDto` | student |
| 33 | POST | `wallet/redeem {code}` | `features/api.ts:363` | `wallet.controller.ts:61` | student |
| 34 | GET | `library/materials?q,page,pageSize` | `features/api.ts:374-376` | `library.controller.ts:58` `BrowseLibraryDto` | student |
| 35 | GET | `library/me?page,pageSize` | `features/api.ts:391-393` | `library.controller.ts:92` | student |
| 36 | GET | `library/materials/:id` | `features/api.ts:408` | `library.controller.ts:78` | student |
| 37 | POST | `library/quote {kind,targetId}` | `features/api.ts:415` | `library.controller.ts:113` `PurchaseLibraryDto` | student |
| 38 | POST | `library/purchase {kind,targetId}` | `features/api.ts:422` | `library.controller.ts:129` | student |
| 39 | POST | `library/parts/:id/open {}` | `features/api.ts:436` | `library.controller.ts:146` | student |
| 40 | GET | `notifications?page,pageSize,unread` | `features/api.ts:445-446` | `notifications.controller.ts:87` `ListNotificationsDto` | bearer |
| 41 | GET | `notifications/unread-count` | `features/api.ts:462` | `notifications.controller.ts:107` | bearer |
| 42 | POST | `notifications/:id/read` | `features/api.ts:471` | `notifications.controller.ts:116` | bearer |
| 43 | POST | `notifications/read-all` | `features/api.ts:509` | `notifications.controller.ts:123` | bearer |
| 44 | GET | `notifications/preferences` | `features/api.ts:519` | `notifications.controller.ts:161` | bearer |
| 45 | PUT | `notifications/preferences {newCourse,newLesson,announcements,payments}` | `features/api.ts:526` | `notifications.controller.ts:167` `UpdatePreferencesDto` | bearer |
| 46 | GET | `search?q,entity` | `features/api.ts:546` | `search.controller.ts:27` `SearchQueryDto` | public+opt bearer |
| 47 | GET | `support/tickets?page,pageSize` | `features/api.ts:558-560` | `support.controller.ts:89` | student |
| 48 | GET | `support/tickets/:id` | `features/api.ts:575` | `support.controller.ts:100` | student |
| 49 | POST | `support/tickets {subject,body,category,courseId?}` | `features/api.ts:587` (also `settings/delete-account/page.tsx`) | `support.controller.ts:81` `CreateTicketDto` | student |
| 50 | POST | `support/tickets/:id/messages {body}` | `features/api.ts:597` | `support.controller.ts:110` `MessageDto` | student |
| 51 | GET | `devices` | `features/api.ts:610` | `devices.controller.ts:36` | bearer |
| 52 | POST | `devices/change-request {reason}` | `features/api.ts:617` | `devices.controller.ts:52` `RequestDeviceChangeDto` | student |
| 53 | POST | `playback/videos/:videoId/ticket {platform,delivery?}` | `app/player/[id]/page.tsx:236` (retry without `delivery` at `:239`) | `playback.controller.ts:118` `IssueTicketDto` | bearer |
| 54 | GET | `playback/videos/:videoId/allowance` | `app/player/[id]/page.tsx:242` | `playback.controller.ts:219` | bearer |
| 55 | POST | `playback/tickets/:id/heartbeat {positionSeconds,watchedDeltaSeconds,protection}` | `app/player/[id]/page.tsx:313` | `playback.controller.ts:162` `HeartbeatDto` | bearer |
| 56 | DELETE | `playback/tickets/:id` | `app/player/[id]/page.tsx:348` | `playback.controller.ts:190` | bearer |
| 57 | POST | `progress {lessonId,positionSeconds,watchedSeconds}` | `app/player/[id]/page.tsx:339,357,464,514` | `progress.controller.ts:51` `ProgressItemDto` | bearer |
| 58 | GET | `ticket.manifestUrl`, segments, `drm.licenseUrl`, `drm.certificateUrl` (*direct*, Shaka or hls.js) | `components/protection/DrmVideo.tsx:521`; `app/player/[id]/page.tsx:271-277` | Gumlet CDN and licence servers; legacy: `playback/manifest.controller.ts:46,70,95` | signed URL |
| 59 | GET | `https://play.gumlet.io/embed/<id>?token&expires` (*direct*, iframe) | `app/player/[id]/page.tsx:429-436` | Gumlet | signed URL |

**Contract check result:** I compared every proxied path, method, body field, query parameter and enum against the backend DTOs. With `forbidNonWhitelisted: true` and `enableImplicitConversion: false` (`backend/src/main.ts:105-131`), all of them match.

The contract mismatches are semantic, not structural:
- F7: a faculty id is sent as `departmentId`.
- F8: `teacherId` exists in the DTO but is never sent.
- F6: the proxy changes the error envelope.

---

## 3. Verification notes

- `node --test` over `src/**/*.test.ts`: 346 tests, 340 passed, 6 failed. Every failure is `ERR_MODULE_NOT_FOUND`/`ENOENT` for `zod`, `pdfjs-dist/legacy/build/pdf.mjs` and `shaka-player/dist/shaka-player.compiled.d.ts`, because node_modules is incomplete (an install may be in progress). These are **not-verifiable**, not code failures.
- `tsc` and `next build` were not run, to avoid writing `tsconfig.tsbuildinfo`, `.next` and other build artefacts. F1 is established from the manifest and lockfile.
- Real-device DRM, CDN CORS, Gumlet embed behaviour and multi-instance deployment are **not-verifiable** offline.
