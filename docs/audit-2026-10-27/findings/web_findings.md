# Student Web Platform: Findings

Paths are relative to `web/src/` unless they start with `backend/`.

- **CONFIRMED** means the failure follows directly from the code cited on both sides.
- **SUSPECTED** means the code path exists but its impact depends on runtime, device or data I could not reproduce offline.

Severity reflects user impact × likelihood.

---

## High

### F1: The production build cannot compile: `@vercel/analytics` is imported but not a dependency
- **Severity:** High · **CONFIRMED**
- **Web:** `app/layout.tsx:5` `import { Analytics } from "@vercel/analytics/next"`, rendered at `:91`.
- **Evidence:** the package is absent from `package.json` (dependencies and devDependencies), from `package-lock.json` (no `node_modules/@vercel` entry), and from `node_modules/`.
- **Failure:** `next build` / `npm run verify` fails with "Module not found: Can't resolve '@vercel/analytics/next'". `next dev` errors on every page, because the root layout wraps all of them. A reinstall will not add the package, since it is not in the manifest.

### F2: Every session ends after 12h idle, although the refresh token is valid for 30 days
- **Severity:** High · **CONFIRMED**
- **Web:**
  - `lib/session-cookies.ts:25` sets `ACCESS_MAX_AGE_S = 12h` on `edu_at`; `:26` sets the refresh cookie to 30d.
  - `app/api/proxy/[...path]/route.ts:111-125`: when `edu_at` is absent, the proxy returns `401 UNAUTHORIZED 'Not signed in'` immediately. The refresh branch (`:161-`) is only reached when an access token was sent and the backend rejected it.
  - `lib/error-messages.ts:47-48`: any 401 ends the session. `lib/session-end.ts:23-34` posts to logout and redirects.
- **Backend:** `backend/src/config/configuration.ts:37-38` sets the access JWT TTL to 900s and the refresh TTL to 30d.
- **Scenario:**
  1. A student closes the laptop in the evening and opens the site the next morning, more than 12h later.
  2. `edu_at` has expired in the browser; `edu_rt` is still present, so `middleware.ts:18-19` lets the page render.
  3. The first call (`auth/me` from `SessionProvider`) gets a 401 from the proxy without any refresh attempt.
  4. `endSessionIfNeeded` calls `/api/auth/logout` and redirects to `/login?reason=SESSION_EXPIRED`.
- **Effect:** a forced daily re-login, and the backend session is revoked although it was still valid.
- **Fix direction:** if `edu_rt` exists and `edu_at` does not, run the refresh path.

### F3: A sign-in or sign-out by any user discards other users' in-flight refreshes, which can cascade into logouts
- **Severity:** High · **CONFIRMED** (by code; frequency depends on traffic)
- **Web:**
  - `lib/refresh-lock.ts:104-113`: `sessionGeneration` is one module-level counter for the whole Node process.
  - It is bumped by every login (`app/api/auth/login/route.ts:88`), register (`app/api/auth/register/route.ts:62`) and logout (`app/api/auth/logout/route.ts:35`), from any browser.
  - `app/api/proxy/[...path]/route.ts:186` captures the counter before refreshing. `:219-221`: if it changed, the proxy returns `401 SESSION_CHANGED` and does not persist the new tokens, although the backend has already rotated them (`backend/src/modules/auth/auth.service.ts` rotation and reuse logic, `:410-440`).
  - `lib/error-messages.ts:48` treats that 401 as session-ending.
- **Scenario:**
  1. Student A's access token expires. A's proxy request starts `/auth/refresh`, roughly 100–300ms.
  2. Meanwhile student B, on another browser served by the same Node instance, signs in or signs out. Forced logouts call `/api/auth/logout` too.
  3. The generation changes. A gets `401 SESSION_CHANGED`, the rotated tokens are dropped, and A's client forces a logout.
  4. A's forced logout bumps the generation again and kills any refresh in flight for student C, and so on.
- **Effect:** at peak times, around access-token expiry boundaries (every 15 min per user), unrelated students are logged out in a chain. The comment at `refresh-lock.ts:24-29` explicitly says keying must be per user for the in-flight map; the generation counter breaks that guarantee.
- **Fix direction:** key the generation per refresh-token family or per browser, for example with a session-bound nonce cookie.

---

## Medium

### F4: The refresh cooldown and the in-flight reset are process-global
- **Severity:** Medium · **CONFIRMED**
- **Web:**
  - `lib/refresh-lock.ts:69-79`: `refreshBlockedUntil` is global. `noteRefreshFailure()` is called at `proxy route.ts:208` after one user's refresh gets a 5xx, 429 or timeout.
  - `proxy route.ts:167-181`: for the next 30s, every user whose access token expires gets `503 SESSION_REFRESH_UNAVAILABLE` without a refresh being attempted.
  - `lib/refresh-lock.ts:82-85`: `resetRefreshState()` (called on every login, logout and register by any user) runs `inflight.clear()`. That breaks single-flight for every other user's concurrent refresh, so parallel requests for the same token each call `/auth/refresh`. They are then protected only by the backend's 30s reuse grace (`auth.service.ts:421-425`).
- **Scenario:** one slow or failed refresh, for example a transient Redis 503, locks every student with an expired token out of the API for 30s. They see error cards on every page.

### F5: The proxy treats every upstream 401 as access-token expiry
- **Severity:** Medium · mechanism **CONFIRMED**, reachability today **SUSPECTED / low**
- **Web:**
  - `proxy route.ts:157` branches on `status === 401` alone, not on the code.
  - It then rotates the refresh token, retries, and on a second 401 clears all session cookies (`:261-266`).
  - The client also ends the session on any 401 (`lib/error-messages.ts:48`).
- **Backend:** some non-session errors are also 401:
  - `PLAYBACK_TICKET_EXPIRED`, thrown by heartbeat at `backend/src/modules/playback/playback.service.ts:1101` (`error-codes.ts:147`).
  - `INVALID_CREDENTIALS`, thrown by POST `/auth/password` when the current password is wrong (`auth.service.ts:825`, `error-codes.ts:112`).
- **Scenario:**
  - A heartbeat for an unknown or foreign ticket id triggers a refresh, then a retried 401, then cleared cookies: the student is logged out mid-lesson.
  - If password change (§1.6 of the inventory) is ever wired through the proxy, mistyping the current password would log the student out.
- **Fix direction:** refresh only on `SESSION_EXPIRED` or `UNAUTHORIZED`, and pass other 401 codes through.

### F6: Proxy errors lose `errors` (field messages) and `Retry-After`, which disables the iOS ticket fallback
- **Severity:** Medium · **CONFIRMED**
- **Web:**
  - `proxy route.ts:60-67`: `jsonError()` emits only `{success, error:{code,message}, code, message}`. Every non-401 error and every refresh error passes through it (`:121, :158, :197, :259`). Headers are not forwarded.
  - `lib/gumlet-embed.ts:48-55`: `isRejectedDeliveryField()` requires `e.errors.delivery`, so through the proxy it is always false. The fallback at `app/player/[id]/page.tsx:238-240` can never fire.
- **Backend:** the validation filter puts the offending fields in `error.fields`/`errors` (`backend/src/main.ts:115-130`, `all-exceptions.filter.ts:44,52`). `Retry-After` is set on 429s (`all-exceptions.filter.ts:82-92`).
- **Scenario:**
  - The web deploys before a backend that knows `delivery`. Every iOS ticket request returns `422 VALIDATION_ERROR` with no retry, so iOS web playback is down.
  - More generally, field-level validation feedback is lost everywhere except the register and login routes, and rate-limited users get no wait hint.

### F7: The course-list year/level filter is fetched with a faculty id under the `departmentId` parameter
- **Severity:** Medium · **CONFIRMED**
- **Web:**
  - `app/courses/page.tsx:113` calls `useAcademicYears(profile.data?.faculty?.id)`. The comment above it says the scope is meant to be the faculty.
  - `features/api.ts:85-88` always sends that value as `?departmentId=`.
- **Backend:**
  - `catalog.controller.ts:251` passes it through `AcademicScopeQueryDto`.
  - `catalog.service.ts:424-436` runs `department.findUnique({id: <facultyId>})`, gets null, and is left with only the candidates `department:<facultyId>` and `PLATFORM`.
  - The result is the platform-wide ladder, not the faculty's own ladder or override.
- **Scenario:** in a college on the LEVEL system, or one with its own ladder, the filter lists the platform's default years. Choosing one filters by a year id that the college's courses do not use, so the list is empty and the label may say "Academic year" above unrelated rungs.
- **Fix direction:** add a `facultyId` parameter to `catalogApi.academicYears`, or call `academicSelection({facultyId})`.

### F8: Teacher results from search open an unfiltered course list
- **Severity:** Medium · **CONFIRMED**
- **Backend:** `backend/src/modules/search/search.service.ts:256` sets `route: '/courses?teacherId=<id>'`. `ListCoursesDto` supports `teacherId` (`courses/dto/course.dto.ts:33`).
- **Web:**
  - `lib/routes.ts` (`SERVED` contains `/^\/courses(\?.*)?$/`) passes the route through unchanged.
  - `app/courses/page.tsx:76-103` initialises its filters from constants and never reads `useSearchParams`. `CourseFilters.teacherId` (`features/api.ts:68`) is never set anywhere.
- **Scenario:** the student searches a teacher's name, taps the teacher, and sees every course.

### F9: The player's final progress flush on unmount never runs
- **Severity:** Medium · **CONFIRMED** (by React commit ordering)
- **Web:**
  - `app/player/[id]/page.tsx:345-361`: the `useEffect` cleanup reads `activeMedia()` and posts `progress` only if it returns an element.
  - `activeMedia()` → `lib/playback-tracking.ts:50-56` returns null unless `media.isConnected`.
  - React runs passive-effect cleanups after the host nodes have been removed and object refs nulled. So on unmount the legacy `videoRef.current` is null, and the DRM element stored in `drmMediaRef` is detached (`isConnected === false`). The flush is always skipped.
- **Related:** there is no `pagehide`, `visibilitychange` or `beforeunload` handler, and calls do not use `keepalive`/`sendBeacon` (grep shows none). A tab close or reload sends neither the final progress nor `DELETE playback/tickets/:id`. Releasing the stream slot then waits for the backend heartbeat grace (`backend/src/config/configuration.ts:76`, 90s). That last part is **SUSPECTED**: it only matters if the slot limit is reached on reopen.
- **Scenario:** a student watches 25s past the last heartbeat and presses Back. Those seconds and the latest position are lost, so resume and watch-time under-report on every exit that is not `ended`.

### F10: Ticket rotation on the legacy HLS player reloads the source and jumps playback back
- **Severity:** Medium · **CONFIRMED** (legacy AES-128 lessons only)
- **Backend:** `playback.service.ts:1215-1250` rotates when less than `2 × heartbeatInterval` remains. With TTL 300s and interval 30s, that is roughly every 4 minutes. It marks the old ticket RELEASED and returns `{ticket}`.
- **Web:**
  - `planHeartbeatResult` → `adoptTicket: !isDrm` (`lib/playback-tracking.ts:185-191`).
  - `page.tsx:333` calls `setTicket(r.ticket)`.
  - The `[ticket]` effect (`page.tsx:258-291`) destroys hls.js and reloads the new `manifestUrl`. That resets `currentTime` to 0, then `onMeta` seeks to `resumeFrom`.
  - `resumeFrom` is the lesson's saved position from page load (`page.tsx:72`), not the current position.
- **Scenario:** a student 10 minutes into a lesson is thrown back to 0:00, or to the old resume point, every few minutes, with a rebuffer each time.

### F11: The Gumlet embed branch (iOS web) records no heartbeat, no progress and no watch time
- **Severity:** Medium · **CONFIRMED**
- **Web:**
  - When `gumletEmbedSrc(ticket)` is non-null (`page.tsx:424-443`), only a cross-origin `<iframe>` is rendered. `videoRef` and `drmMediaRef` stay null.
  - The heartbeat interval then returns at `page.tsx:299-300` (`if (!media) return;`), so neither heartbeat nor progress is sent. `onEnded` is never called, so autoplay-next and the ended progress are lost too.
- **Backend:** the play shows up as a ticket with no heartbeat, which is the same "no view row" symptom the in-progress change was meant to fix (`page.tsx:173-184`).
- **Scenario:** with `GUMLET_WEB_EMBED_ENABLED=true`, an iPhone student finishes a lesson and it shows as 0% watched. Watch-percent completion rules can never be met on iOS web.

### F12: The DRM player ignores resume position, playback rate and the ±10s buttons, and native fullscreen drops the watermark
- **Severity:** Medium · **CONFIRMED**
- **Web:**
  - `page.tsx:445-451`: `<DrmVideo>` receives neither `resumeFrom` nor `rate`. `DrmVideo.tsx:78-108` has no such props, and `ticket.resumePositionSeconds` (`types/domain.ts:219`; set by the backend at `playback.service.ts:681`) is never used. DRM lessons always start at 0:00, and the Settings playback rate has no effect.
  - `page.tsx:545-557`: the −10s and +10s buttons act on `videoRef.current`, which is null on the DRM and embed branches, so they do nothing.
  - `DrmVideo.tsx:629-634`: `<video controls>` has no `controlsList="nofullscreen"` and no `disablePictureInPicture`. The native fullscreen and PiP buttons take the bare `<video>` out of the container, and the `<Watermark>` overlay (a sibling `div`) is not visible there.
  - The Gumlet iframe (`page.tsx:429-436`) is the same: `allowFullScreen` lets the iframe go fullscreen without the overlay.
  - The legacy branch handles this correctly (`page.tsx:497-499` plus a frame-level fullscreen button at `:535-542`).
- **Impact:** a recording made in fullscreen carries no visible identity mark. The watermark is deterrence only, and this removes it in the most common viewing mode.

### F13: The attachment viewer re-issues its ticket on every window focus
- **Severity:** Medium · **CONFIRMED**
- **Web:**
  - `features/api.ts:321-334` sets `staleTime: 0`, `gcTime: 0` and does not set `refetchOnWindowFocus`. The global default at `app/providers.tsx:31` is `refetchOnWindowFocus: true`.
  - Each refetch returns a new signed `url`. `ViewerBody` passes it to `ProtectedPdf`, whose effect depends on `[url]` (`components/documents/ProtectedPdf.tsx:113`). That clears the canvases, re-downloads and re-renders every page, and resets the scroll position.
- **Backend:** each ticket inserts a `watchEvent STARTED` (`backend/src/modules/attachments/attachments.service.ts:191-203`) and signs a URL.
- **Scenario:** a student alt-tabs to take notes while reading a 60-page PDF. On return the document reloads from page 1, and analytics record a new "open" each time.

### F14: `ProtectedPdf` rasterises every page eagerly at up to 2× DPR
- **Severity:** Medium · **SUSPECTED** (code CONFIRMED; the crash threshold depends on the device)
- **Web:** `components/documents/ProtectedPdf.tsx:81-102` loops over `doc.numPages` and appends one full-resolution canvas per page. A page about 1600×2260 px is roughly 14 MB of bitmap. There is no virtualisation and no release of off-screen canvases.
- **Scenario:** a 150-page library document needs about 2 GB of canvas memory. iOS Safari caps total canvas memory well below that, so later pages render blank or the tab is killed. With range requests on (`lib/pdfjs-document.ts` does not set `disableRange`), a slow device can also outlive the signed URL's TTL mid-document. The viewer then flips to `failed` with earlier pages still on screen.

### F15: My Courses hides PENDING enrolments, and its "All" tab is not all courses
- **Severity:** Low–Medium · **CONFIRMED**
- **Backend:** `backend/src/modules/courses/courses.service.ts:171-189` deliberately returns PENDING_APPROVAL and PENDING_PAYMENT ("the student … needs to find it again").
- **Web:** `app/my-courses/page.tsx:58-63` defines tabs for ACTIVE with progress under 100%, progress at 100%, and EXPIRED/ARCHIVED/REVOKED. The third tab is labelled `web.all` (`:145`). Pending courses match no tab. Filtering is also client-side over the pages loaded so far, so the counts are wrong beyond 20 courses.
- **Scenario:** a student requests approval for a course and it vanishes from My Courses.

---

## Low

### F16: Wallet totals are computed from the first page only, and the balance shows 0 on error
- **Severity:** Low · **CONFIRMED**
- **Web:** `app/wallet/page.tsx:40-48` sums the loaded transactions (20 per page). The backend summary already has `totalRecharged`/`totalSpent` (`backend/src/modules/wallet/wallet.service.ts:154-158`) and they are ignored. `:119` renders `balance ?? 0` when `wallet` errors, with no error state, so a failed request reads as "0 EGP".

### F17: Sign-out with an expired access cookie leaves the backend session and refresh token alive
- **Severity:** Low · **CONFIRMED**
- **Web:** `app/api/auth/logout/route.ts:37-49` calls `/auth/logout` only with `edu_at`, best-effort, with no device header and no refresh first. If the cookie has expired (F2 window), the call is skipped or 401s.
- **Backend:** `auth.controller.ts:86-96` is the only place the session, refresh family, playback slot and push token are revoked.
- **Scenario:** on a shared computer, sign-out clears the cookies but the refresh token stays valid server-side for 30 days. The risk is only real if the token was copied.

### F18: The join sheet is empty for courses sold only by PAYMENT, and choosing a part does nothing
- **Severity:** Low · **CONFIRMED**
- **Web:**
  - `lib/course-access.ts:69-80`: `none` is true only when `enrollmentMethods` is empty, and PAYMENT is never rendered.
  - A course with `enrollmentMethods: ['PAYMENT']` shows the options but no button and no "no methods" text (`app/courses/[id]/page.tsx:763-803`). The same applies to the PENDING_PAYMENT notice's "Join now".
  - The full-course or part `intent` (`:682, :743, :757`) only changes the hint text at `:778`.
- **Backend:** join options set `onlinePayment` from the provider (`course-parts.service.ts:413-415`).

### F19: Mark-complete failures are silent
- **Severity:** Low · **CONFIRMED**
- **Web:** `app/lessons/[id]/page.tsx:174` calls `markComplete.mutate()` with no `onError`, and the page does not render `markComplete.error`.
- **Backend:** `lessons.controller.ts:103-112` can return `409 INVALID_STATE`.
- **Effect:** the button stops spinning and nothing happens.

### F20: An unowned library part shows a "Filter" status badge
- **Severity:** Low · **CONFIRMED**
- **Web:** `app/library/[id]/page.tsx:102` uses `t('web.filter')` (dictionary value "Filter", `i18n/dictionaries.ts:394`) as the status of a part that is not owned and not a preview.

### F21: Search history survives sign-out and is shared between accounts
- **Severity:** Low · **CONFIRMED**
- **Web:** `app/search/page.tsx:18,72-94` keeps `edu-web-recents` in localStorage. Logout (`lib/session-context.tsx:86-99`, `lib/session-end.ts`) does not clear it, so the next user on a shared browser sees the previous student's searches.

### F22: Stale cache after joining or redeeming
- **Severity:** Low · **CONFIRMED** (bounded by the 30s `staleTime`)
- **Web:** `features/api.ts:268-287` (`useEnroll`, `useRedeemCourseCode`) invalidate only `['courses']`. `['home','feed']` (its "My courses" section) and `['lessons','detail',…]` (lessons cached with `locked: true`) are not invalidated. `useMarkLessonComplete` (`:310-320`) does not invalidate the home feed or `courses/mine` progress.

### F23: The player never tells the backend which lecture it is playing
- **Severity:** Low · **SUSPECTED**
- **Web:** `app/lessons/[id]/page.tsx:135` navigates to `/player/${video.id}`. `features/api.ts:306` calls `lessons/by-video/:videoId` without `?lessonId`, and `page.tsx:236` posts the ticket without `lessonId`.
- **Backend:** both endpoints accept the hint (`lessons.controller.ts:87-101`, `playback.controller.ts:66`). Without it they pick heuristically for shared assets (`lessons.service.ts:287-310`, `playback.service.ts:329-360`).
- **Effect:** for a video reused across two courses the student is enrolled in, the title, next-lesson link and progress can attach to the other lecture.

### F24: A refused staff or disabled sign-in still creates a backend session and device binding
- **Severity:** Low · **CONFIRMED**
- **Web:** `app/api/auth/login/route.ts:43-79` and `register/route.ts:29-58` check `role`/`status` only after `/auth/login` has returned tokens. The tokens are discarded and never revoked.
- **Backend:** login binds `x-device-id` (`auth.controller.ts:42-56`).
- **Effect:** orphan sessions, and a web "device" registered on a teacher's account.

### F25: Concurrent requests mint different device ids when `edu_did` is missing
- **Severity:** Low · **SUSPECTED**
- **Web:** `proxy route.ts:95-97,151,252`: each proxied request without `edu_did` generates its own `newDeviceId()` and sets it. A page load fans out about 5–10 requests in parallel, so each carries a different `x-device-id` and the last `Set-Cookie` wins.
- **Effect:** only a browser that has session cookies but no device cookie is affected, for example a session created before `edu_did` existed. Its device id never matches the one bound at sign-in, so protected content fails with `DEVICE_NOT_AUTHORIZED` until the student signs in again.

### F26: Two playback settings are stored but have no effect
- **Severity:** Low · **CONFIRMED**
- **Web:** `store/stores.ts:40-74` persists `preferredQuality` and `dataSaver`. `app/settings/playback/page.tsx` edits them. Nothing reads them: no `maxHeight` is sent to `IssueTicketDto` (`playback.controller.ts:43-49`), and Shaka/hls.js are not configured from them. `rate` only applies to the legacy element (`page.tsx:278`).

---

## Not defects, but worth recording

- **F27 (not-verifiable): test run.** `node --test` gave 340/346 passing. The 6 failures are environmental `ERR_MODULE_NOT_FOUND` (`zod`, `pdfjs-dist/legacy/build/pdf.mjs`, `shaka-player/dist/shaka-player.compiled.d.ts`) caused by an incomplete node_modules. The in-progress tracking code is therefore only partly exercised.
- **F28 (dev only): StrictMode.** `next.config.ts` sets `reactStrictMode: true` and `ProtectedPlayer.loadTicket` (`page.tsx:254-256`) has no once-guard. In dev every player mount issues two tickets, and the first is never released. The library reader guards this (`app/library/reader/[id]/page.tsx:17-24`); the player does not. This can produce `CONCURRENT_STREAM_LIMIT` during local testing.
- **Route guards are presence checks by design.** `middleware.ts` checks only that a cookie exists, and the per-page `status === 'unauthenticated'` redirects are client-only. No data is rendered on the server and every API call is authorised by the backend, so this is not an access-control gap. One side effect: `edu_pf` is an unsigned JSON cookie trusted for the server-rendered header (`lib/session.ts:112-121`). It is HttpOnly, so only its owner can tamper with it, and it carries name and phone.
- **Token storage is sound.** Access and refresh tokens are HttpOnly, SameSite=Lax, Secure in production, and never reach JS or web storage. CSRF is covered by the mandatory custom header on every mutating route. `APP_ORIGIN` is documented in `.env.example` but never read (`lib/config.ts:47`).
- **Browser-side media protection is deterrence, not prevention.**
  - The DOM watermark can be removed in devtools.
  - `copy`/`contextmenu` blocking is trivially bypassed.
  - Signed manifest, licence and media URLs are visible in the network panel and usable until they expire.
  - Desktop Widevine is typically L3 (software).
  - The heartbeat hardcodes `recording:false`.
  - Burnt-in PDF watermarks survive screenshots but not a camera.
  - `sessionTag` is never rendered, so a leak traces to the account, not to the session.
  - The only real enforcement is server-side: entitlement, device binding, short TTLs, concurrency slots and play allowance.
