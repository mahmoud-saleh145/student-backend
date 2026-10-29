# Student mobile — feature inventory

> **Phase 2 (2026-10-27):** staging builds that use the production API show a permanent "STAGING build · PRODUCTION data" badge (`components/feedback/StagingBanner.tsx`, D7), and EAS refuses a staging build without `STAGING_USES_PRODUCTION_API=acknowledged`.

> **Post-audit status (2026-10-27).** The inventory below is the code-derived snapshot taken *before* the fixes. These items changed afterwards (finding IDs refer to `findings/mobile_findings.md`):
>
> | Finding | Area | Before | After |
> |---|---|---|---|
> | F1 | iOS playback | broke at the first ticket rotation (backend dropped `platform`) | backend now keeps the key system across rotation; **needs a backend deploy** |
> | F2 | FairPlay source | typed `dash` | typed `hls` |
> | F3 | Server termination | overwritten by the rotation timer | honoured |
> | F4 | Native player after a terminal phase | kept playing behind the error screen | paused |
> | — | Terminate reasons | all shown as a generic denial | reissuable reasons (expired ticket, device, stream limit) go to the re-issue screen |
> | F6 | Avatar upload | `sizeBytes: 0` → 422 | sends the real size |
> | F7 | `COURSE_NOT_TARGETED` | generic "Not permitted" | specific message (en/ar) |
> | — | Release bundles (incl. OTA updates) | could start against a local or plain-HTTP API | refuse to start (`assertReleaseApiUrl`) |
>
> Verification: `tsc --noEmit` clean. Jest: `errors.test.ts` 106/106 and `player-source-drm.test.ts` passed after the changes. The other suites and the new `release-api-url.test.ts` could not finish here, because jest-expo startup exceeded the 3-minute call limit once mount I/O slowed; the guard's logic was verified separately (9/9 cases). **Run `npm test` on Windows before building.**
> Video playback status is now: Android partial (captions and quality are no-ops on DRM); iOS fixed in code, **unverified on a device**.


Snapshot: `mobile` (single commit `3aa14cb "snapshot of user working tree 2026-10-26"`, so uncommitted vs committed cannot be distinguished; everything below is the tree as it stands). Backend: `backend` (NestJS, global prefix `api`, URI version `v1` → base `/api/v1`, `src/main.ts:96-100`). Nothing was run: `node_modules` was still being populated (e.g. `node_modules/expo-video/` was empty), so no `tsc`, `jest` or library-internals checks were possible.

Status legend: **complete** = UI + client call + matching backend route/DTO, no known blocking defect · **partial** = works with a gap or a defect (see `mobile_findings.md`) · **broken** = expected flow fails · **missing-backend** = the client needs a server capability that does not exist · **not-verifiable** = depends on runtime, store or credentials outside the repo.

---

## 1. Cross-cutting plumbing

| Concern | Implementation (file:line) | Status / notes |
|---|---|---|
| HTTP client | `src/api/client.ts` axios instance (`:84-93`), single `request()` (`:386-412`) that unwraps `{data}` and tolerates a bare body | complete. Backend success envelope `{success,data,meta}` (`backend/src/common/interceptors/response.interceptor.ts:35-64`); error envelope carries both the nested `error{}` and the flat `code/message/errors/requestId` that the client parses (`common/filters/all-exceptions.filter.ts:106-123`, `api/errors.ts:118-134`). Paginated `{items,meta{page,pageSize,total,totalPages,hasNext,hasPrevious}}` matches `types/api.ts`. |
| Validation strictness | Backend `ValidationPipe({whitelist, forbidNonWhitelisted})` (`main.ts:105-133`) means any extra body/query key gives a 422 | Every mobile payload and query was checked against its DTO (table §3). The only real mismatch is the avatar `sizeBytes: 0` case. |
| Request headers | `Authorization: Bearer`, `X-Device-Id/-Platform/-Model/-Name(URI-encoded)/-Os/-Integrity`, `X-App-Version/-Build`, `Accept-Language`, `X-Client: mobile`, `X-Request-Id` (`client.ts:95-124`, `services/device.ts:142-154`) | complete. The backend decodes `X-Device-Name` (`common/middleware/request-context.middleware.ts:47-65`). |
| Error normalisation | `api/errors.ts` `KNOWN_CODES` (`:99-116`) + status fallback (`:69-81`); every known code has `errors.*` in en and ar | partial: the backend codes `COURSE_NOT_TARGETED` (student-facing, 403) and some back-office codes are unknown to the client, so the student sees a generic FORBIDDEN (finding F7). |
| Retry policy | Axios retries only idempotent methods on 408/425/5xx, and never on 429 (`client.ts:250-356`). React Query retries only `retryable` codes (`query-client.ts:14-21`) | complete |
| Query cache persistence | `PersistQueryClientProvider` → AsyncStorage `rq-cache-v1`, 24 h, busted by app version. `playback`, `attachments`, `auth`, `wallet` and `support` are excluded (`api/query-client.ts:46-67`) | complete. Caveat: courses, notifications, library and the home feed are persisted **unencrypted** (low risk). |
| Logging | `services/logger.ts`: production minimum level is `warn` | complete |
| Mock backend | `api/mock/*` is `require`d only when `EXPO_PUBLIC_ENV !== 'production'` (`client.ts:37-41`), and `useMocks` is forced off in production (`config/env.ts:104`) | complete |

## 2. Screens / routes (`src/app/**`, expo-router)

| Route | File | Purpose | Backend calls | Status |
|---|---|---|---|---|
| `/` gate | `app/index.tsx` | spinner while loading → `/(tabs)` or `/(auth)/login` | — | complete (but see F12: it can hang on `loading`) |
| root layout | `app/_layout.tsx` | fonts, i18n, `contentProtection.initialize()`, persisted query provider, `Stack.Protected` guard (`:139-162`), notification tap router (`:173-213`) | — | complete |
| `(auth)/_layout` | `app/(auth)/_layout.tsx` | redirects authenticated users to the tabs | — | complete |
| `(auth)/login` | `app/(auth)/login.tsx` | phone + password, server field errors, session-ended banner | POST `/auth/login` | complete |
| `(auth)/register` | `app/(auth)/register.tsx` | 3-step wizard. Academic picker scoped by department/faculty through `academic-selection`; label follows `ladderKind` | GET `/catalog/universities`, `/catalog/universities/:id/faculties`, `/catalog/faculties/:id/departments`, `/catalog/academic-selection?…`; POST `/auth/register` | complete |
| `(auth)/password-help` | `app/(auth)/password-help.tsx` | WhatsApp / phone / email to an admin (no self-service reset, by design) | — | complete |
| `(tabs)/_layout` | `app/(tabs)/_layout.tsx` | tab bar, unread badge polled every 180 s, OS badge sync, `registerPushToken()` once authenticated (`:75`) | GET `/notifications/unread-count`; POST `/notifications/devices` | complete |
| `(tabs)/index` (Home) | `app/(tabs)/index.tsx` | greeting, continue-watching, my courses, new and recommended, announcements, banners derived from announcements (`features/ads/*`, internal `APP_SCREEN` routes only) | GET `/home/feed` | complete |
| `(tabs)/courses` | `app/(tabs)/courses.tsx` | catalogue with sort, free-only, university and year filters, infinite scroll | GET `/courses?sort&free&universityId&academicYearId&page&pageSize`; GET `/catalog/universities`, `/catalog/academic-years` | complete |
| `(tabs)/my-courses` | `app/(tabs)/my-courses.tsx` | joined courses, including expired and archived | GET `/courses/mine` | complete |
| `(tabs)/search` | `app/(tabs)/search.tsx` | debounced search, grouped results, route allow-list | GET `/search?q&entity` | partial: teacher results go nowhere (F8) |
| `(tabs)/notifications` | `app/(tabs)/notifications.tsx` | list, unread filter, mark read (optimistic), mark all, permission rationale card, deep link | GET `/notifications`, POST `/notifications/:id/read`, POST `/notifications/read-all` | complete |
| `(tabs)/profile` | `app/(tabs)/profile.tsx` | account info, edit, devices, settings, security. "Change password" opens WhatsApp (`:91-99`) | — | partial (no in-app password change) |
| `course/[courseId]` | `app/course/[courseId].tsx` | detail, access panel, sections accordion with lazy section documents, parts panel, JoinSheet | GET `/courses/:id`, GET `/courses/:id/parts`, GET `/sections/:id/attachments`, GET `/courses/:id/join-options`, POST `/courses/:id/enroll` (FREE / ADMIN_APPROVAL), POST `/courses/:id/redeem` | complete (COURSE_NOT_TARGETED shown generically, F7) |
| `lesson/[lessonId]` | `app/lesson/[lessonId].tsx` | lesson detail, video poster → `/player/:videoId` (`:82`), manual completion, attachment rows → `/viewer/:id` | GET `/lessons/:id`, POST `/lessons/:id/complete` | complete |
| `player/[videoId]` | `app/player/[videoId].tsx` + `features/video/*` | protected player (full-screen modal, no swipe dismiss) | GET `/lessons/by-video/:videoId` (no `?lessonId`), POST `/playback/videos/:id/ticket`, POST `/playback/tickets/:id/heartbeat`, DELETE `/playback/tickets/:id`, GET `/playback/videos/:id/allowance`, POST `/progress`, POST `/progress/batch`, POST `/playback/security-events` | **Android: partial; iOS: broken** (F1–F5, F15) |
| `viewer/[attachmentId]` | `app/viewer/[attachmentId].tsx` | protected document viewer (pdf.js in a WebView, or the direct URL), watermark | GET `/attachments/:id/ticket` | partial (iOS PDF load suspected to be blocked, F9) |
| `library/index` | `app/library/index.tsx` | balance chip, browse with search, "my library" | GET `/wallet`, GET `/library/materials`, GET `/library/me` | complete |
| `library/[materialId]` | `app/library/[materialId].tsx` | parts and packages, quote → purchase with wallet credit, insufficient-credit → wallet | GET `/library/materials/:id`, POST `/library/quote`, POST `/library/purchase` | complete |
| `library/reader/[partId]` | `app/library/reader/[partId].tsx` | secure reader (pdf.js loaded from cdnjs with SRI, `features/library/pdf-html.ts:25-105`) with a watermark | POST `/library/parts/:id/open` | complete. Needs cdnjs to be reachable at runtime. |
| `wallet/index` | `app/wallet/index.tsx` | balance, transaction history, redeem a recharge card | GET `/wallet`, GET `/wallet/transactions`, POST `/wallet/redeem` | complete |
| `support/index` | `app/support/index.tsx` | ticket list | GET `/support/tickets` | complete |
| `support/new` | `app/support/new.tsx` | create a ticket (category enum matches Prisma; 3–200 / 3–4000 limits mirror the DTO) | POST `/support/tickets` | complete |
| `support/[ticketId]` | `app/support/[ticketId].tsx` | thread and reply | GET `/support/tickets/:id`, POST `/support/tickets/:id/messages` | complete |
| `settings/index` | `app/settings/index.tsx` | hub: language, playback, notifications, library, wallet, security, devices, delete account, support, about | — | complete |
| `settings/language` | `app/settings/language.tsx` | en/ar; RTL flip requires an app reload (`i18n/index.ts:87-98`) | — | complete |
| `settings/playback` | `app/settings/playback.tsx` | rate, quality, data-saver, autoplay-next (MMKV) | — | partial: quality has no effect on DRM streams (F5) |
| `settings/notifications` | `app/settings/notifications.tsx` | OS permission + server preferences (newCourse / newLesson / announcements / payments) | GET/PUT `/notifications/preferences`, POST `/notifications/devices` | complete |
| `settings/security` | `app/settings/security.tsx` | protection-capability read-out (English-only signal labels) | — | complete (informational) |
| `settings/devices` | `app/settings/devices.tsx` | device list, request a device change with a reason | GET `/devices`, POST `/devices/change-request` | complete |
| `settings/delete-account` | `app/settings/delete-account.tsx` | **Phase 2 (D5):** consequences, "What we keep", **current wallet balance (2026-10-28; the button waits for it)**, current password, confirm → scheduled date, then sign-out; optional web link | POST `/auth/account-deletion` | complete (needs the D5 backend) |
| `settings/about` | `app/settings/about.tsx` | version and build, terms and privacy links (env-driven; falls back to support) | — | not-verifiable (the URLs come from EAS env) |
| `profile/edit` | `app/profile/edit.tsx` | full name, avatar change/remove | PATCH `/profile`, POST `/storage/uploads/avatar`, PUT (presigned storage URL), PUT `/profile/avatar` | partial (F6) |
| `+not-found` | `app/+not-found.tsx` | fallback | — | complete |

## 3. API call map (mobile → backend), with contract check

Mobile paths are declared in `src/api/endpoints.ts`; the call-site line is listed. Backend lines point at the route decorator.

| Method + path | Mobile call site | Backend route | DTO / shape check |
|---|---|---|---|
| POST /auth/login | `features/auth/api.ts:81` | `auth/auth.controller.ts:42` | LoginDto `{phone,password}` ✔; response `{user,accessToken,refreshToken,expiresIn,device}`; `device` is ignored by the client |
| POST /auth/register | `features/auth/api.ts:84` | `auth.controller.ts:26` | RegisterDto ✔ (`studyType` and `locale` are optional and not sent) |
| POST /auth/refresh | `api/client.ts:183` (raw axios) | `auth.controller.ts:68` | `{refreshToken}` (IsJWT) ✔; reads `res.data.data` ✔ |
| POST /auth/logout | `features/auth/api.ts:88` | `auth.controller.ts:86` | ✔ |
| GET /auth/me | `features/auth/api.ts:90` | `auth.controller.ts:106` | ✔ |
| GET /auth/session, POST /auth/password, POST /auth/logout-all, GET /auth/sessions | declared (`endpoints.ts:14,20`) / not declared | `auth.controller.ts:116,132,98,125` | **unused by the app** |
| GET /catalog/universities · /universities/:id/faculties · /faculties/:id/departments · /academic-years · /academic-selection | `features/auth/api.ts:95,99,103,107,122` | `catalog/catalog.controller.ts:225,232,239,251,262` | AcademicScopeQueryDto `{universityId?,facultyId?,departmentId?}` ✔; response `{academicSystem,academicYears,ladderKind,ladderMatchesSystem}` ✔ |
| GET /home/feed | `features/courses/api.ts:51` | `home/home.controller.ts:15` | `{continueWatching,myCourses,newCourses,recommended,announcements,stats}` ✔ |
| GET /courses | `features/courses/api.ts:25` | `courses/courses.controller.ts:29` | ListCoursesDto (q, ids, free via toBool, sort enum) ✔ |
| GET /courses/mine | `features/courses/api.ts:32` | `courses.controller.ts:54` | PaginationDto ✔ |
| GET /courses/:id | `features/courses/api.ts:39` | `courses.controller.ts:69` (@Public) | ✔. On @Public routes an expired token is silently treated as anonymous (`common/guards/jwt-auth.guard.ts:65-71`), see F21 |
| GET /courses/:id/sections | `features/courses/api.ts:42` (defined; detail embeds sections) | `courses.controller.ts:84` | ✔ |
| GET /courses/:id/progress, /courses/:id/attachments | declared only | `courses.controller.ts:99,106` | unused |
| POST /courses/:id/enroll | `features/courses/api.ts:45` | `enrollments/enrollments.controller.ts:88` | JoinCourseDto `{method: FREE\|PAYMENT\|CODE\|ADMIN_APPROVAL}` ✔ |
| POST /courses/:id/redeem | `features/courses/api.ts:48` | `enrollments.controller.ts:119` | RedeemCodeDto `{code}` ([A-Za-z0-9-], 4–40) ✔ |
| GET /courses/:id/parts · /courses/:id/join-options · /me/part-purchases | `features/course-parts/api.ts:31,44,50` | `course-parts/course-parts.controller.ts:49,60,75` | ✔ (`/me/part-purchases` has a hook that no screen uses) |
| POST /codes/validate | `features/course-parts/api.ts:64` | `codes/codes.controller.ts:202` | `{code,courseId?}` ✔. The hook `useValidateCode` is unused by any screen |
| GET /wallet · /wallet/transactions · POST /wallet/redeem | `features/wallet/api.ts:31,39,56` | `wallet/wallet.controller.ts:26,37,61` | ListTransactionsDto (direction CREDIT/DEBIT, from/to ISO) ✔; RedeemCodeDto ✔ |
| GET /library/materials · /materials/:id · /me · /me/purchases; POST /quote · /purchase · /parts/:id/open | `features/library/api.ts:45,52,58,65,79,90,103` | `library/library.controller.ts:58,78,92,103,113,129,146` | BrowseLibraryDto ✔; PurchaseLibraryDto `{kind: PART\|PACKAGE, targetId}` ✔; open response `{libraryPartId,title,url,mimeType,pageCount,expiresAt,watermark}` ✔. The purchase-history hook is unused by any screen |
| GET/POST /support/tickets · GET /support/tickets/:id · POST /support/tickets/:id/messages | `features/support/api.ts:31,38,43,47` | `support/support.controller.ts:81,89,100,110` | CreateTicketDto / MessageDto ✔, category enum ✔ |
| POST /storage/uploads/avatar | `features/profile/avatar.ts:114` | `storage/storage.controller.ts:188` | PresignAvatarDto `{contentType, sizeBytes ≥1}`: **the client can send 0** (F6) |
| PUT /profile/avatar · PATCH /profile | `features/profile/avatar.ts:145,150`, `app/profile/edit.tsx:58` | `users/profile.controller.ts:72,62` | SetAvatarDto `{avatarUrl: key\|null}` ✔; UpdateProfileDto `{fullName}` ✔ |
| GET /lessons/:id · /lessons/by-video/:videoId · POST /lessons/:id/complete | `features/lessons/api.ts:7,18,21` | `lessons/lessons.controller.ts:75,87,103` | ✔. `?lessonId=` is never sent (F15) |
| GET /attachments/:id/ticket | `features/lessons/api.ts:28` | `attachments/attachments.controller.ts:55` | response `{attachmentId,url,headers,expiresAt,watermark}` ✔ |
| GET /sections/:id/attachments | `features/lessons/hooks.ts:109` | `attachments.controller.ts:87` | ✔ |
| POST /playback/videos/:id/ticket | `features/video/api.ts:46` | `playback/playback.controller.ts:118` | IssueTicketDto: sends `{platform}` only, no `lessonId` and no `maxHeight` |
| POST /playback/tickets/:id/heartbeat | `features/video/api.ts:71` | `playback.controller.ts:162` | HeartbeatDto: integers are rounded client-side (`usePlaybackTicket.ts:156-163`) ✔ |
| DELETE /playback/tickets/:id | `features/video/api.ts:78` | `playback.controller.ts:190` | ✔ |
| GET /playback/videos/:id/allowance | `features/video/api.ts:64` | `playback.controller.ts:219` | ✔ |
| POST /playback/security-events | `services/content-protection.ts:199` | `playback.controller.ts:246` | SecurityEventDto `{threat enum, videoId?, courseId?, lessonId?, meta?, occurredAt?}` ✔ |
| POST /progress · /progress/batch | `features/video/api.ts:87,91` | `progress/progress.controller.ts:51,66` | integers ✔, batch ≤ 100 (the client caps at 40) ✔ |
| GET /notifications · unread-count · POST :id/read · read-all | `features/notifications/hooks.ts:18,43,81`, `app/(tabs)/_layout.tsx:35` | `notifications/notifications.controller.ts:87,107,116,123` | ✔ (`unread` boolean transform present) |
| POST /notifications/devices · DELETE /notifications/devices/:token | `services/notifications.ts:132,155` | `notifications.controller.ts:132,153` | `{token, platform, provider:'expo'}` ✔. The backend sends through Expo Push (`config/configuration.ts:264-265`) ✔ |
| GET/PUT /notifications/preferences | `app/settings/notifications.tsx:37,42` | `notifications.controller.ts:161,167` | ✔ |
| GET /search | `features/search/hooks.ts:19` | `search/search.controller.ts:27` | ✔ |
| GET /devices · POST /devices/change-request | `features/auth/api.ts:135,137` | `devices/devices.controller.ts:36,52` | ✔ (`reason` optional ≤500) |
| GET /devices/current, /search/suggestions, /meta/health, /meta/app-config, /progress/continue-watching | declared in `endpoints.ts` only | `devices.controller.ts:46`, `search.controller.ts:47`, `health/health.controller.ts:54`, `meta/meta.controller.ts:30`, `progress.controller.ts:81` | **unused**. With no `/meta/app-config` read there is no forced-update or maintenance gate; the backend never emits 426 either. |

## 4. Feature-by-feature status

| # | Feature | Status | Evidence |
|---|---|---|---|
| 1 | Login | complete | `(auth)/login.tsx:41-54` → `AuthProvider.login` (`features/auth/AuthProvider.tsx:172-186`): tokens to SecureStore, user snapshot, invalidates all queries |
| 2 | Registration | complete | wizard with academic selection scoped to the college (`(auth)/register.tsx:116-118`). The DTO mirrors name/phone/password rules on both sides |
| 3 | Forgot password | complete (contact admin only) | `(auth)/password-help.tsx` |
| 4 | Token storage | complete | `expo-secure-store` with `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (`services/secure-storage.ts:17-19`; that option is iOS-only, Android uses Keystore-encrypted prefs). Access and refresh tokens, sessionId and a user snapshot are stored there. An in-memory mirror is kept (`api/token-store.ts:20-61`). Web uses localStorage (not shipped). Read errors become `null` (`secure-storage.ts:42-47`), see F10 |
| 5 | Session restore | complete, with an edge hang | `AuthProvider.tsx:126-168`: hydrate → optimistic snapshot → `/auth/me` revalidate. Offline or 5xx keeps the snapshot. A non-session-ending 401 with no snapshot leaves the status at `loading` (F12) |
| 6 | Token refresh | complete, with caveats | proactive refresh 30 s before `exp` (`client.ts:100-109`, `token-store.ts:70-74`); single-flight promise (`client.ts:130,160-244`); 30 s cooldown on transport errors, 5xx or 429 (`:147-158`); 400/401/403 or SESSION_ENDING → clear tokens and broadcast (`:212-235`); replay once on 401 (`:296-315`). The backend rotates refresh tokens with a 30 s reuse grace (`auth/auth.service.ts:411-438`, `config/configuration.ts:54`). Caveats: F11 (the 401 from PLAYBACK_TICKET_EXPIRED triggers a refresh), F13 (any 403 logs the user out), and an app killed mid-rotation loses its session after the grace window (inherent) |
| 7 | Logout | complete; partial on involuntary end | voluntary: unregister push, then logout, then teardown (`AuthProvider.tsx:203-215`). Involuntary: tokens are cleared before the broadcast, so the push-token DELETE goes out unauthenticated (F16) |
| 8 | Device binding | partial | stable id = SHA-256(random secret in SecureStore : ANDROID_ID or IDFV : model) (`services/device.ts:54-93`), sent on every request. The server enforces at ticket issue (`devices/devices.service.ts:255-330`). The app has a device list and a change request. Gaps: no call-to-action from device errors in the player (F14), the identity is regenerated whenever the secure read fails, and an Android reinstall always counts as a new device (F10) |
| 9 | Catalogue, course detail, sections, section documents | complete | see §2 |
| 10 | Join course (FREE / ADMIN_APPROVAL / access code / part card) | complete | `features/enrollment/JoinSheet.tsx`. Never opens an external checkout. `EnrollSheet.tsx` (dead external-checkout code) was **removed in Phase 2 (D4)** after a reference check; `no-external-checkout.test.ts` keeps checkout out |
| 11 | Course parts | complete (read) | `features/course-parts/PartsPanel.tsx`; part ownership through cards. The "my parts" history hook is unused |
| 12 | Lessons, manual completion | complete | `app/lesson/[lessonId].tsx`, `app/player/[videoId].tsx:70-76` |
| 13 | Video playback (ticket → DRM source → heartbeat → rotation → release) | **Android: partial · iOS: broken** | `features/video/usePlaybackTicket.ts`, `ProtectedVideoPlayer.tsx`. The backend serves Gumlet DRM only (strict gate, no legacy HLS: `playback/playback.service.ts:857-871`). Android gets Widevine + DASH with `hardwareSecure: true` (`:881`). iOS asks for FairPlay (`video/api.ts:50`), but **ticket rotation drops the platform** (F1) and the client labels the iOS HLS manifest as `dash` (F2). Termination at rotation is overwritten (F3), the player is not paused when the grant ends (F4), captions and quality do nothing for DRM (F5) |
| 14 | Play limit (3 plays) | complete | warning banner on the last play (`ProtectedVideoPlayer.tsx:698-720`); enforced server-side (`playback.service.ts:378-379`, `claimPlay`) |
| 15 | Watch progress and offline queue | complete | `features/video/useWatchProgress.ts`: contiguous-delta counting, flush every N s, MMKV `userKv` queue merged per lesson, drained on reconnect through `/progress/batch`. The heartbeat also reports the delta (`usePlaybackTicket.ts:148-163`) |
| 16 | Resume and autoplay-next | complete | `ProtectedVideoPlayer.tsx:339-392`, `player/[videoId].tsx:77-86` |
| 17 | Course and section attachments (PDF and others) | partial | `app/viewer/[attachmentId].tsx`: PDF goes through pdf.js HTML, other types load the signed URL directly. iOS navigation filter suspected (F9) |
| 18 | Library (browse, material, quote, purchase with wallet, reader) | complete | §2. Purchase history UI is missing (hook `useLibraryPurchases` unused) |
| 19 | Wallet (balance, history, recharge-card redeem) | complete | `app/wallet/index.tsx` |
| 20 | Purchases with money / checkout | n/a by design | there is no IAP and no reachable in-app payment. Content is unlocked by offline-bought cards and wallet credit (store-policy risk: see release file) |
| 21 | In-app notifications | complete | list, unread, mark read, badge |
| 22 | Push (expo-notifications → Expo Push → FCM/APNs) | complete in code; delivery **not-verifiable** | permission asked from a rationale card (`(tabs)/notifications.tsx:65-67`, `settings/notifications.tsx:71-73`); token registered after auth (`(tabs)/_layout.tsx:75`); three Android channels (`services/notifications.ts:73-94`); tap routing with an allow-list (`utils/guards.ts:23-30`, `app/_layout.tsx:173-213`). Needs the EAS projectId (present), FCM v1 credentials on EAS and an APNs key: not in the repo |
| 23 | Search | partial | teacher results go nowhere (F8) |
| 24 | Profile view and name edit | complete | `app/profile/edit.tsx` |
| 25 | Avatar | partial | F6 |
| 26 | Change password | **missing (client)** | WhatsApp only (`(tabs)/profile.tsx:91-99`) although `POST /auth/password` exists (`auth.controller.ts:132`) and `changePasswordSchema` exists (`features/auth/schemas.ts:121`). Note: the backend revokes **all** sessions, the current one included (`auth/auth.service.ts:836-856`), despite its comment |
| 27 | Devices screen | complete | §2 |
| 28 | Support tickets | complete | §2 |
| 29 | Account deletion | **complete (Phase 2, D5)** | Request in Settings (password; 30-day cancellation); a pending account's sign-in shows "Cancel deletion and sign in" (`POST /auth/account-deletion/cancel`, then login). The web URL comes from env |
| 30 | i18n / RTL | complete | en and ar bundles at key parity (ar has extra plural forms); device-language detection; RTL through `I18nManager.forceRTL` plus a reload prompt (`i18n/index.ts:87-98`, `settings/language.tsx:34-42`); `Accept-Language` follows the UI and the backend localises notifications |
| 31 | Offline / network | partial | NetInfo wired into React Query `onlineManager` (`query-client.ts:71-83`); `networkMode: offlineFirst` for queries, `online` for mutations; offline banner; persisted cache; progress queue; offline vs unreachable vs timeout distinguished (`errors.ts:139-162`). Mutations simply fail offline, and there is no outbox except for progress |
| 32 | Screen-capture / content protection | Android: complete (platform-backed) · iOS: partial (undocumented technique) | see §5 |
| 33 | Forced update / maintenance mode | **missing** | `/meta/app-config` is never called (§3) |
| 34 | Promotions (banners) | complete | derived from home-feed announcements, internal routes only (`features/ads/api.ts:54-55`) |

## 5. Video, DRM and capture protection: what the platform actually guarantees

| Layer | Android | iOS |
|---|---|---|
| Stream encryption / licence | Gumlet Widevine, DASH, `hardwareSecure: true` (`playback.service.ts:881`). **Guaranteed by the platform**: on Widevine L1 devices the decoded frames stay in a secure path that screenshots, MediaProjection and non-HDCP outputs cannot read. L3-only devices (cheap phones, emulators, some rooted devices) are expected to be refused a hardware-secure licence, so playback fails there. Not verifiable without a device | FairPlay + HLS is selected only on the **first** ticket (`playback.service.ts:888-916`). FairPlay through AVPlayer is excluded by the OS from screenshots, screen recording and AirPlay mirroring (it shows black). **This is the real iOS guarantee**, but it currently holds only until the first rotation (F1) |
| Window protection | `FLAG_SECURE` set in `MainActivity.onCreate` by the config plugin (`modules/content-protection/app.plugin.js:69-95`; present in `android/app/src/main/java/com/eduplatform/app/dev/MainActivity.kt:20-21`) and left on app-wide (`services/content-protection.ts:166-175`). **Guaranteed by the platform** on a non-rooted OS: screenshots are blocked, recordings and casts show black, and the recents thumbnail is blank. It does **not** stop a camera pointed at the screen, nor Xposed/root hooks | **No equivalent public API.** `SecureContentView` re-parents content into the private secure-text-entry canvas of a `UITextField` (`ios/SecureContentView.swift:9-99`). This is undocumented: it can break in any iOS release, and its fallback is `field.subviews.first`, which is not necessarily secure (`:85`). `supportsSecureSurface` is a hard-coded `true` (`ios/ContentProtectionModule.swift:63`) and JS never checks whether the view actually became secure |
| Detection | Screenshot callback on API 34+ and recording callback on API 35+ (`ContentProtectionModule.kt:181-218`, needs `DETECT_SCREEN_CAPTURE` / `DETECT_SCREEN_RECORDING`). A recording that was already running when detection starts is not detected (the return value is ignored, `:215`). External presentation display detection | `userDidTakeScreenshotNotification` fires **after** the screenshot is taken (it is a notification, not a block). `UIScreen.isCaptured` through KVO covers recording and mirroring (`ContentProtectionModule.swift:134-146`) |
| Response | pause the player, show a privacy shield, report to `/playback/security-events`; the heartbeat carries `protection.recording/externalDisplay` and the server revokes on capture (`playback.service.ts:1115-1136`) | same |
| Integrity | heuristic root/emulator/debugger checks block playback locally outside dev (`services/content-protection.ts:108-109`); an `X-Device-Integrity: suspect` header for emulators or non-devices makes the server refuse tickets (`devices.service.ts:290-299`, `blockOnIntegrityFailure` default true). No Play Integrity or DeviceCheck attestation is wired | jailbreak, simulator and debugger heuristics (`ContentProtectionModule.swift:264-300`) |
| Watermark | server-composed name + ID + session tag (`playback.service.ts:668-678`), rendered inside the secure view (`components/Watermark.tsx`) | same |
| PiP / background | `allowsPictureInPicture={false}`, `staysActiveInBackground=false` | the `audio` background mode is stripped (`app.plugin.js:97-102`) |
| Documents | WebView inside `SecureContentView` + FLAG_SECURE: protected by the platform | WKWebView inside the private canvas: not guaranteed |

Bottom line: on Android the screen-capture protection is real (FLAG_SECURE plus Widevine L1). On iOS the only OS-guaranteed protection is FairPlay itself; the secure canvas, the screenshot notice and the recording checks are best-effort deterrents.
