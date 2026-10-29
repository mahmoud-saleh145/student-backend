# Admin/Teacher Dashboard: Defects

Scope: `dashboard` (client) against `backend` (server). Paths are relative to `dashboard/src/` and `backend/src/`.
**CONFIRMED** means both sides were read and the failure follows directly from the code. **SUSPECTED** means it is plausible but depends on runtime data or configuration that was not verified.
Backend context that several findings depend on: the global `ValidationPipe` uses `whitelist + forbidNonWhitelisted` (`backend/src/main.ts:105-110`). Any unknown query or body key is answered with **422 VALIDATION_ERROR**.

---

## HIGH

### F1. The Statistics revenue chart never renders. Response shape mismatch. CONFIRMED
- Client: `features/stats/admin-statistics.tsx:57` calls `GET analytics/revenue` and types it as `{points?|series?|items?: {day, amount}[]}` (`:211-215`). `normalizeSeries` (`:222-229`) reads `response.points ?? response.series ?? response.items` and `row.amount`.
- Server: `modules/analytics/analytics.service.ts:282-392` (`revenueSeries`) returns a **bare array** of `{day, gross, net, transactions, codeSales, codeSaleCount, walletTopUps, walletTopUpCount, total}`. There is no wrapper object and no `amount` field. The response interceptor passes arrays through unchanged as `data`.
- Failure: `normalizeSeries([...])` → `[].points` is undefined, so the result is `[]`. The "Revenue" chart always shows "No revenue recorded in this period" whatever the actual revenue. Even if it were unwrapped, `Number(row.amount)` would give 0 on every day.
- Why tests pass: the e2e stub returns `{ points: [] }` (`e2e/stub-api/server.mjs:1372`), which is not the real contract.
- Fix: treat the response as an array and plot `total` (all three revenue sources) or `net`.

### F2. Statistics revenue tiles show only the disabled online-payment ledger, so they read about 0. CONFIRMED
- Client: "Total revenue" = `revenue.netAllTime` (`admin-statistics.tsx:106`). "Revenue in period" = `revenue.netInPeriod ?? grossInPeriod` (`:136`). "Paid purchases" = `purchases.paidPayments` (`:122`). The type `types/domain.ts:672-686` has no `totalAllTime`, `totalInPeriod`, `codeSales*` or `walletTopUps*`.
- Server: `analytics.service.ts:650-678`. `totalAllTime`/`totalInPeriod` hold "money actually collected": code sales + wallet top-ups + online. `grossAllTime`, `netAllTime` and so on are commented as "The revenue ledger alone (online payments), unchanged". The service doc (`~:398-420`) says the online channel "is disabled today, so this is 0".
- Failure: courses are sold offline through access cards, and wallet top-ups go through recharge cards. Administrators see 0 EGP total revenue, 0 revenue in the period and 0 paid purchases while real code-sale and top-up revenue exists. This is a wrong financial headline on the landing screen.
- Fix: show `totalAllTime`/`totalInPeriod`, with `codeSales*`/`walletTopUps*`/`onlinePayments*` as the breakdown, and `purchases.paidCodeSales*` for counts.

### F3. Every teacher notification fails with 403: the UI offers a feature the backend reserves for admins. CONFIRMED
- Client: the teacher nav includes "Notifications" (`components/layout/navigation.ts:642-647`, capability `sendCourseNotifications` granted to TEACHER in `lib/permissions.ts:436-440`). `features/notifications/notification-centre.tsx:63` and the course "Notifications" tab shown to every role (`features/courses/course-detail.tsx:211,234` → `features/courses/hooks.ts:739`) both `POST notifications/announcements`.
- Server: `modules/notifications/notifications.controller.ts:182-183` is `@Post('announcements') @AdminOnly()`. No staff/teacher-scoped notification endpoint exists anywhere (grep found no TEACHER handling in `modules/notifications`).
- Failure: a teacher composes a message, confirms, and gets `403 INSUFFICIENT_ROLE` ("Your role does not allow this action"). The comment at `notification-centre.tsx:30-34` claims teachers go through "the per-course screen where ownership is checked", but that screen calls the same admin-only endpoint. With several courses selected, the loop (`:91-93`) stops on the first 403.
- Why tests pass: the stub has no route for `/notifications/announcements`.
- Fix: either add a `@StaffOnly` course-scoped endpoint on the backend, or remove the teacher nav entry and the teacher Notifications tab.

### F4. Teacher capability switches are always read as OFF: the client reads a field the backend never sends. CONFIRMED
- Client: `features/settings/hooks.ts:70-101` (`useTeacherCapabilities`). For a teacher it reads `GET meta/app-config` → `data.teacher.{canDeleteLectures,canDeleteVideos,canEditVideoUrls,canEditCoursePrices}` and defaults each to `false`.
- Server: `modules/meta/meta.controller.ts:37-110` `appConfig()` returns `environment, minimumAppVersion, maintenanceMode, playback, device, features, support, callerAppVersion`. It has **no `teacher` key**. The real switches are `teacher.*` platform settings (`modules/settings/platform-settings.service.ts:22-25,233`) and are enforced per request (`modules/courses/course-access.service.ts:480-492`).
- Failure: an admin enables "teachers may delete lectures/videos" or "change prices" in Settings, but teachers still never see Delete lecture (`features/courses/course-content-tab.tsx:85`), Delete video (`features/videos/lesson-video-panel.tsx:114,322`) or price editing (`features/courses/course-pricing-tab.tsx:56`). The backend would allow these actions. Teachers can only perform them with a hand-crafted request.
- Why tests pass: the stub's app-config invents a `teacher` block (`e2e/stub-api/server.mjs:2529-2539`).
- Fix: expose the four booleans in `meta/app-config` (or a `@StaffOnly` endpoint), or have the client read the real settings keys.

### F5. Removing a shared (reused) video always fails with 409, which leaves the lecture stuck. CONFIRMED (in-progress `features/videos/*`)
- Client: `features/videos/hooks.ts:255` sends `api.delete('videos/:videoId')` with **no `?lessonId=`**. The panel knows when the video is shared (`lesson-video-panel.tsx:127-128`, `isShared`) and still calls it the same way (`:159`).
- Server: `modules/videos/videos.controller.ts:176-188` takes `?lessonId` ("required when the asset is attached to more than one lecture"). `modules/videos/videos.service.ts:1472-1491` `resolveRemovalTarget` throws `CONFLICT` "This video is used by N lectures. Say which lecture to remove it from." whenever more than one live lecture uses the video and no lessonId is given.
- Failure: on any lecture that plays a reused video, "Delete video" returns 409 every time. "Replace video" is also refused, because `initUpload` throws CONFLICT for a shared video ("Remove it from this lecture before uploading a new one", `videos.service.ts:183-205`). The lecture can neither drop nor replace its video from the dashboard. Also, the success toast ("Its stored files were removed", `lesson-video-panel.tsx:164-167`) is wrong for the detach case the backend performs when other lectures still use the file.
- Fix: `api.delete(\`videos/${videoId}\`, undefined, { query: { lessonId } })` (the panel has `lessonId`), or call `DELETE videos/reuse/:lessonId/:videoId` (`videos.controller.ts:365`). Word the toast by response.

---

## MEDIUM

### F6. Sorting the course list by "Created" breaks the list (422). CONFIRMED
- Client: the `createdAt` column is `sortable: true` (`features/courses/course-list.tsx:145-148`) and is wired to `list.setSort` (`:262`). `useListQuery` sends `sort=createdAt&order=…` (`lib/use-list-query.ts:128`). The same params feed the export (`course-list.tsx:295`).
- Server: `modules/courses/dto/course.dto.ts:58-61` uses `@IsIn(['newest','oldest','title','students','price']) sort`.
- Failure: clicking the "Created" header puts the table into an error state ("Please check the highlighted fields"). The URL keeps `sort=createdAt`, so reloads and shared links stay broken until the user clears it by hand.
- Fix: map the column to `newest`/`oldest`, or give columns a separate `sortKey`.

### F7. Sorting the Student-wallets tab breaks the other three Wallet tabs (422). CONFIRMED
- Client: `WalletsTab` sorts by `balance|totalRecharged|totalSpent` (`features/wallet/wallet-overview.tsx:626-629,641,652,662`, `onSortChange` `:699`). `sort`/`order` are page-global URL keys (`lib/use-list-query.ts:58-59,108`). Changing tab removes only `page` (`components/ui/tabs.tsx:119-129`). The other tabs' `useListQuery` reads the same `sort` and sends it (`wallet-overview.tsx:134,423,751`).
- Server: `ListRechargeCodesDto` (`modules/codes/codes.controller.ts:179`), `RechargeRevenueDto` (`:187`) and `AdminListTransactionsDto`/`ListTransactionsDto` (`modules/wallet/dto/wallet.dto.ts:40,68`) extend `SortablePaginationDto`, which has `q`/`order` but **no `sort`**. With `forbidNonWhitelisted` the request is rejected: "property sort should not exist".
- Failure: Wallet → Student wallets → click "Balance" → switch to Recharge cards, Revenue or Ledger. Each shows an error panel until the URL is edited. The Excel exports on those tabs fail the same way.
- Fix: clear `sort`/`order` on tab change, or namespace list params per tab.

### F8. A deleted course stays in the course list: the invalidation key never matches. CONFIRMED (React Query v5 prefix-match semantics)
- Client: `features/courses/hooks.ts:569` invalidates `queryKeys.courses.list(undefined)`, which is `['courses','list',undefined]`. The list is cached under `['courses','list',{page,pageSize,…}]` (`hooks.ts:76`). Prefix matching compares index 2 (`undefined` against an object) and fails, so nothing is invalidated. Unlike every other course mutation, `useDeleteCourse` does not invalidate `courses.all`.
- Failure: (a) deleting from the list (`course-list.tsx:58-71`) shows the "Course deleted" toast while the row stays visible until the next focus refetch after it goes stale (at least 60 s). (b) Deleting from the detail page and then `router.push('/courses')` (`course-detail.tsx:95-102`) renders the cached, still-fresh list, which includes the deleted course. The e2e test (`e2e/lifecycle-and-deletes.spec.ts:72-98`) does not catch this, because `page.goto` makes a full reload that empties the cache before the delete.
- Fix: invalidate `queryKeys.courses.all` (the detail queries are already removed first, so no 404 flash).

### F9. Sign-out usually does not revoke the server session. CONFIRMED
- Client: the access cookie lives 12 h (`lib/session.ts:48,119`) and is overwritten only when a proxied request hits a 401 and refreshes (`app/api/proxy/[...path]/route.ts:551-560`). `signOut()` (`lib/session.ts:167-177`) posts `/auth/logout` with whatever access token is in the cookie, does not refresh, and swallows the error.
- Server: the access JWT TTL is 900 s (`config/configuration.ts:37`, `.env.example:49`). `POST /auth/logout` is not `@Public` (`modules/auth/auth.controller.ts:86-95`), so an expired JWT gets 401 before `auth.service.ts:683` revokes the session.
- Failure: whenever 15 minutes or more have passed since the last refresh (any idle teacher, or a background tab, since polling stops), "Sign out" clears the browser cookies but leaves the backend Session ACTIVE and its refresh-token family valid for up to 30 days. The session list still shows it, and a copied refresh token keeps working. The same applies to `endSession()` → `/api/auth/logout` and `/api/auth/expired`.
- Fix: in `signOut`, refresh before logout (`attemptRefresh()`), or add a backend logout-by-refresh-token endpoint. Align the access cookie maxAge with `expiresIn`.

### F10. The lecture video panel polls `gumlet/status` every 5 s forever for non-Gumlet videos. CONFIRMED (in-progress)
- Client: `useGumletAssetState(videoId, Boolean(videoId) && !upload.isBusy)` is enabled for every video (`features/videos/lesson-video-panel.tsx:105-108`). `refetchInterval` (`features/videos/hooks.ts:190-200`) stops only when `playable` is true or `gumletStatus` is `errored|failed`. Otherwise it returns 5000.
- Server: `modules/videos/gumlet-ingest.service.ts:1119-1173` returns `playable: drmVerified`, which is `false` for any R2/HLS video (`modules/playback/drm-verification.service.ts:170-200`: `NO_GUMLET_ASSET`, or DRM disabled on the platform) and also `gumletStatus: null`.
- Failure: each open lesson video panel for a legacy, R2 or ready non-DRM video sends `GET videos/:id/gumlet/status` every 5 s while the tab is in the foreground. Each request is a rate-limiter round trip plus an ownership check and DB reads. The codebase explicitly budgets for this cost (`components/layout/shell.tsx:118-131`). The same applies to a Gumlet video stuck in `PENDING_SUBMISSION`.
- Fix: enable only when `detail.drmProvider === 'gumlet'`, and stop on `gumletStatus === null && !assetId`.

### F11. Teachers cannot retry a failed first upload, and are offered "Replace video" that the backend refuses. CONFIRMED (in-progress)
- Client: after any failed attempt the Video row exists (status UPLOADING/FAILED), so the panel shows "Replace video" (`lesson-video-panel.tsx:310`). The upload hook re-calls `videos/uploads/init` on a fresh-signature retry (`features/videos/upload.ts:546`) and on a new pick (`:476`). `canEditVideoUrls` is computed (`settings/hooks.ts:99`) but never used to gate anything.
- Server: `modules/videos/videos.service.ts:212-215`. When `lesson.video` exists and is not deleted (including the UPLOADING row created by the teacher's own first attempt), it calls `assertTeacherCapability(actor.role, 'editVideoUrls')`, which throws 403 FORBIDDEN for teachers while `teacher.canEditVideoUrls` is false, the default (`platform-settings.service.ts:49`).
- Failure: a teacher whose first upload fails (network, a 403 from an expired signature mid-upload, a refused type) or finishes as FAILED gets 403 on every later attempt. Only an admin can upload the lecture's video from then on. The in-loop re-init after a storage 403 fails the same way, which makes the "fresh signature" recovery path useless for teachers.
- Fix (backend): exempt rows with `status ∈ {UPLOADING, FAILED}` and no `sourceSizeBytes` from the `editVideoUrls` check. Client: hide "Replace" for READY videos when `!canEditVideoUrls`, which first needs F4 fixed.

---

## LOW

### F12. Course pickers are hard-capped at 100 courses. CONFIRMED
`GET admin/courses {page:1,pageSize:100}` with no search or pagination: `features/codes/generate-codes-dialog.tsx:104-110`, `features/notifications/notification-centre.tsx:55-59`, `features/announcements/audience-builder.tsx:80`, `features/stats/teacher-home.tsx:28-32`. The backend caps pageSize at 100 (`common/dto/pagination.dto.ts:5`). Above 100 courses, older courses cannot be chosen for code generation, course notifications or audience rules, and the teacher-home totals undercount.

### F13. Code generation: a decimal price gives 422, and the hint misdescribes the field. CONFIRMED
`generate-codes-dialog.tsx:168` sends `Number(price)`, and the input allows decimals (`:443-447`). The backend `GenerateCodesDto.priceAmount` is `@IsInt()` (`modules/codes/codes.controller.ts` `GenerateCodesDto`). The error appears as a generic toast with no field highlight. The hint "For reporting only." (`:440`) is wrong: the backend counts `priceAmount` as code-sale revenue (`analytics.service.ts` dashboard doc, `revenueSeries` cardSales).

### F14. The send-now result union is incomplete. CONFIRMED
`types/commerce.ts` `DispatchResult.skipped` lists only `'already-claimed'`. The backend also returns `'cancelled'` (`modules/notifications/announcements.service.ts:406`) and `'recovered-stale-claim'` (`:558-562`). `announcement-list.tsx:44-58` then shows "Sent to 0 student(s)" for a cancelled or recovered dispatch.

### F15. Dead hook with the wrong contract: `useTeacherEarnings`. CONFIRMED
`features/teachers/hooks.ts:107-117` expects `{totals:{gross,teacher,platform}, courses:[{courseTitle,amount}]}`. The backend `analytics.service.ts:217-266` returns `{period,total,courses:[{courseId,title,earnings,gross,refunded,net,transactions,refunds}]}`. It is unused today, so anyone wiring it up later will get undefined values.

### F16. Missing cache invalidations after mutations. CONFIRMED
- Device approve/reject (`features/students/device-requests.tsx:58-63`) does not invalidate `['stats']`, so `queues.pendingDeviceRequests` goes stale.
- Block/unblock a student (`features/students/hooks.ts:107-111`) invalidates only `students.*`. The course Students tabs (`['courses','students',…]`, which show `user.status`) and Statistics `blockedStudents` stay stale.
- Course archive/restore/publish (`features/courses/hooks.ts:537-541`) do not invalidate `['stats']` (courses by status).
- Approving a device change revokes the student's sessions, but the open student drawer's sessions list (`['students','sessions',id]`) is invalidated only because it shares the `students` prefix. That is correct today, but only by accident of the key layout.

### F17. Pages have no route-level role guard; only the backend enforces access. CONFIRMED (backend enforcement verified)
Teachers can open `/students`, `/teachers`, `/codes`, `/code-batches`, `/part-purchases`, `/library`, `/wallet`, `/support`, `/announcements`, `/logs`, `/settings`, `/other-data`, `/courses/structure` by URL. Every data call on those pages is `@AdminOnly` on the backend (`users.controller.ts:91-175`, `codes.controller.ts`, `library.controller.ts:178+`, `admin-wallet.controller.ts`, `support.controller.ts:134+`, `announcements.controller.ts`, `audit.controller.ts`, `settings.controller.ts`, `catalog.controller.ts:281+`), so the result is 403 error panels, not a data leak. `/admins` gates MASTER client-side only (`features/admins/admin-accounts.tsx:132`). The backend still lets an ADMIN list admins (`users.controller.ts:91`) but refuses admin creation (`users.service.ts:471-475`) and checks `assertCanManage` on password reset and delete. **No UI-only role check was found that the backend fails to enforce** among those checked: course create/assign/archive/delete, enrollment revoke, refunds, staff creation, password reset, user delete, settings and wallet.

### F18. CSRF-able sign-out. CONFIRMED (low impact)
`GET /api/auth/expired` signs out on a plain top-level GET (`app/api/auth/expired/route.ts`), and SameSite=Lax cookies are sent on top-level navigations, so any external link can sign an admin out. `POST /api/auth/logout` skips the `x-dashboard-request` check that the proxy enforces (mitigated by Lax on cross-site POST).

### F19. Raw backend messages shown in the attachment upload error toast. CONFIRMED
`features/courses/attachments-panel.tsx:165` uses `toast.error(error instanceof Error ? error.message : …)`. `ApiError` extends `Error`, so developer-facing backend text such as "Request validation failed" or entity names is shown verbatim. This contradicts the policy in `lib/errors.ts:244-249`.

### F20. Library material edit cannot clear an academic link. SUSPECTED
`features/library/library-dialogs.tsx:92-100` maps an emptied university, faculty, year or subject to `undefined`, so the key is omitted and the old value is kept. The UI appears to clear it while the server keeps it. Not verified whether `UpdateMaterialDto` plus the service would accept `''` or `null` to clear (`modules/library/dto/library.dto.ts:66-78`).

### F21. Backend: course-part thumbnail upload has no course-ownership check. SUSPECTED (low impact)
`modules/storage/storage.controller.ts:464-487` (`coursePartThumbnailContent`) and the presign `:225` take no `actor`, unlike the course thumbnail and attachment routes (`:422-438`, `:272-293`). Any teacher can write objects under another course's `course-parts/<courseId>/<partId>` key. Registering the key on a part still needs ownership via `PATCH admin/course-parts/:id`.

### F22. Upload proxy buffers the whole body in memory. CONFIRMED (low; thumbnails are 10 MB or less now)
`app/api/upload/_shared/stream-upload.ts:91` `request.body.tee()`. The unread second branch buffers the entire upload until the first forward finishes. Only thumbnail routes are still used. `api/upload/attachment` and `api/upload/library-document` are dead, because documents now go direct-to-R2.

---

## Auth token handling and refresh races: verified, no defect beyond F9
- Refresh is deduplicated per refresh token within one Node process (`lib/session.ts:286-298`). Across processes or serverless instances, concurrent 401s present the same refresh token twice. The backend absorbs this with a 30 s reuse grace that reissues into the same family (`modules/auth/auth.service.ts:410-424,540-640`, `JWT_REFRESH_REUSE_GRACE_SECONDS` default 30). Replays outside 30 s revoke the family, and the browser normally holds the new cookie long before then. No logout race was found.
- A transient refresh failure does not delete cookies (`lib/session.ts:356-379`). The proxy answers 503 `SESSION_REFRESH_UNAVAILABLE`, which is not session-ending (`types/api.ts:425-429`). Correct.
- Inefficiency (not a defect): the 12 h access cookie against the 15 min JWT means the first request after each expiry costs three backend calls (401, refresh, retry). The layout's `/auth/me` deliberately does not rotate (`lib/session.ts:195-262`).
