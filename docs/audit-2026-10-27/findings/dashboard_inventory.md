# Admin/Teacher Dashboard: Route & API Inventory

Snapshot audited: `dashboard` (Next.js 15 App Router, React Query v5), backend `backend` (NestJS, global prefix `/api/v1`).
Paths are relative to `dashboard/src/` (client) and `backend/src/modules/` (server) unless absolute. Backend `file:line` points at the handler.

## 0. Cross-cutting architecture (verified)

| Concern | Where | Notes |
|---|---|---|
| Browser HTTP | `lib/api-client.ts:22-80` | Same-origin only. `api.get/post/put/patch/delete/page` → `/api/proxy/<path>`. Adds `x-dashboard-request: 1` on non-GET. Unwraps `{data}`. On `UNAUTHORIZED / SESSION_EXPIRED / ACCOUNT_DISABLED`, `endSession()` (`:110-132`) POSTs `/api/auth/logout` once, then goes to `/login?reason=…&next=…`. |
| Proxy | `app/api/proxy/[...path]/route.ts:486-586` | Blocks `auth/login|register|refresh|logout`, `playback/`, `media/`, `payments/webhooks/` (`:456-464`). CSRF: header + Origin check on mutations. Attaches the bearer token from an HTTP-only cookie. On a backend 401: one refresh (`attemptRefresh`), one retry. A refresh that fails for a non-definitive reason returns `503 SESSION_REFRESH_UNAVAILABLE`. |
| Server backend client | `lib/backend.ts:277-363` | Sends `x-client: dashboard-web` (the backend never reads it). 20 s timeout. |
| Session | `lib/session.ts` | Cookies: access (maxAge 12 h, `:48`), refresh (30 d), profile (base64 JSON, unsigned). Refresh is serialised per refresh token in a per-process Map (`:286-298`). The backend allows a 30 s reuse grace (`auth.service.ts:417-424`, `configuration.ts:54`). The backend access JWT lives 900 s (`configuration.ts:37`). |
| Edge middleware | `middleware.ts:40-70` | Checks only that a cookie is present. Public: `/login`, `/privacy`, `/terms`, `/account-deletion`, `/contact`. |
| Dashboard layout | `app/(dashboard)/layout.tsx:677-696` | `requireSessionUser()` → `GET /auth/me` (`auth.controller.ts:112`, any authenticated user). If the role is not staff or the account is not ACTIVE, it redirects to `/api/auth/expired?reason=forbidden`. |
| Role model (UI) | `lib/permissions.ts:376-441`, `components/layout/navigation.ts` | MASTER and ADMIN have every capability except `manageAdmins`, which is MASTER only. TEACHER has `manageCourses`, `manageCourseParts` and `sendCourseNotifications`. **This only hides nav entries and buttons. No page or route has a role guard**: any staff role can open any URL, and access is enforced only by the backend `RolesGuard` (`common/guards/roles.guard.ts`) plus service-level course scoping. |
| Backend validation | `backend/src/main.ts:105-125` | `whitelist + forbidNonWhitelisted`. Any query or body key missing from the DTO gives **422 VALIDATION_ERROR**. This matters for the list `sort` parameter (see findings). |
| List state | `lib/use-list-query.ts:124-130` | URL-backed. Always sends `page`, `pageSize`, and `q`, `sort`, `order` plus declared filter keys when set. `sort`/`order` are global URL keys shared by every tab on a page. |
| Query client | `app/providers.tsx:26-67` | staleTime 60 s, gcTime 5 min, refetchOnWindowFocus. No retry on 4xx. Mutations never retry. |

### Next.js route handlers (server)
| Route | File | Calls backend | Notes |
|---|---|---|---|
| `POST /api/auth/login` | `app/api/auth/login/route.ts:31` | `POST /auth/login {phone,password}` (`auth.controller.ts:54`, @Public) via `lib/session.ts:82` | Zod phone check. Refuses STUDENT and non-ACTIVE accounts with a user-facing 403. Sets 3 cookies. |
| `POST /api/auth/logout` | `app/api/auth/logout/route.ts` | `POST /auth/logout` with the stored access token (`session.ts:174`, backend `auth.controller.ts:94`, needs a valid JWT) | No `x-dashboard-request` check. Cookies are cleared whatever happens. |
| `GET /api/auth/expired` | `app/api/auth/expired/route.ts` | same signOut | A GET that signs the user out. Redirects to `/login?reason=`. |
| `GET /api/auth/session` | `app/api/auth/session/route.ts` | none (reads the profile cookie) | Unused by the client code found. |
| `* /api/proxy/[...path]` | see above | any | |
| `POST /api/upload/course-thumbnail` | `app/api/upload/course-thumbnail/route.ts` | `POST /storage/uploads/course-thumbnail/content?courseId&contentType` (`storage.controller.ts:422`, @StaffOnly + course check) | Streams through `_shared/stream-upload.ts`, which tees the body for a 401 retry. |
| `POST /api/upload/course-part-thumbnail` | `.../course-part-thumbnail/route.ts` | `…/course-part-thumbnail/content?courseId&partId&contentType` (`storage.controller.ts:464`, @StaffOnly, **no course-ownership check**) | |
| `POST /api/upload/library-part-thumbnail` | `.../library-part-thumbnail/route.ts` | `…/library-part-thumbnail/content` (`storage.controller.ts:489`, @AdminOnly) | |
| `POST /api/upload/library-default-thumbnail` | `.../library-default-thumbnail/route.ts` | `…/library-default-thumbnail/content` (`storage.controller.ts:518`, @AdminOnly) | |
| `POST /api/upload/attachment` | `.../attachment/route.ts` | `…/attachment/content` (`storage.controller.ts:545`) | **Dead.** The client now presigns and PUTs straight to R2 (`features/uploads/direct-upload.ts`). |
| `POST /api/upload/library-document` | `.../library-document/route.ts` | `…/library-document/content` (`storage.controller.ts:364`) | **Dead.** Same reason (`features/library/upload.ts:163`). |

---

## 1. Pages

Role legend: **Nav** means the role has a nav entry. **URL** means a role without a nav entry can still open the page by typing the URL (true for every page). **BE** is the backend guard that actually decides.

### `/login`: `app/(auth)/login/page.tsx`
Sign-in. If a session cookie exists and no `reason` is given, it redirects to `next`/`/`. Validates `next` against open redirects (`:78-82`). Calls `authApi.login` → `/api/auth/login` (`lib/api-client.ts:160`). Public.

### `/`: Statistics (admin) / Home (teacher): `app/(dashboard)/page.tsx` → `features/stats/home-router.tsx:8-9`
- ADMIN/MASTER see `AdminStatistics` (`features/stats/admin-statistics.tsx`):
  - `GET analytics/dashboard {from,to}` (`admin-statistics.tsx:52`) → `analytics.controller.ts:99` @AdminOnly → `analytics.service.ts:431`.
  - `GET analytics/revenue {from,to}` (`:57`) → `analytics.controller.ts:131` @AdminOnly → `analytics.service.ts:282` (returns a **bare array**; see F1).
- TEACHER sees `TeacherHome` (`features/stats/teacher-home.tsx:28-32`): `GET admin/courses {page:1,pageSize:100}` → `courses.admin.controller.ts:50` @StaffOnly (scoped to assigned courses). Totals are computed in the browser from at most 100 courses.

### `/courses`: course list: `features/courses/course-list.tsx`
Roles: Nav for all three (teacher label "My courses"). Create and Delete are admin-only in the UI (`can('createCourses')`, `isAdmin`).
- `GET admin/courses` with `page,pageSize,q,sort,order,status,universityId,academicYearId,subjectId` (`hooks.ts:77`; export `course-list.tsx:295` via `fetchAllPages`) → `courses.admin.controller.ts:50` @StaffOnly, DTO `courses/dto/course.dto.ts:43-67`. Sortable columns are title, students and **createdAt** (`course-list.tsx:81,121,148`; see F6).
- `POST admin/courses` (CreateCourseDialog → `hooks.ts:490`) `{title,titleAr,shortDescription,teacherIds[1],leadTeacherId,universityId,facultyId,departmentIds,academicYearId,subjectId,isFree,price,enrollmentMethods}` (`create-course-dialog.tsx:144-160`) → `courses.admin.controller.ts:86` @AdminOnly. The thumbnail field is shown disabled on create, on purpose (`create-course-dialog.tsx:98-110`).
- `DELETE admin/courses/:id {reason}` (`hooks.ts:555`) → `courses.admin.controller.ts:212` @AdminOnly.
- Filter options: `GET catalog/universities`, `catalog/academic-years`, `subjects` (`catalog/hooks.ts:35,99,108`) → `catalog.controller.ts:228,258`, `subjects.controller.ts:82` (all @Public).
- The link to `/courses/structure` is admin-only (`course-list.tsx:241-242`).

### `/courses/structure`: academic structure: `features/catalog/structure-manager.tsx`
Roles: admin only (link gated). Teacher URL access gives 403 panels.
- `GET catalog/tree` (`catalog/hooks.ts:126`) → `catalog.controller.ts:354` @AdminOnly
- `GET catalog/academic-systems` (`:204`) → `:281` @AdminOnly
- `POST catalog/universities {name,nameAr,defaultAcademicSystem}` (`:156`) → `:364`
- `PATCH catalog/universities/:id {name,nameAr,defaultAcademicSystem,isActive}` (`:168`) → `:374`
- `POST catalog/faculties {universityId,name,nameAr}` (`:173`) → `:385`
- `PATCH catalog/faculties/:id` (`:295`) → `:406`
- `POST catalog/departments {facultyId,studyType,name,nameAr}` (`:214`) → `:392`
- `PATCH catalog/departments/:id` (`:305`) → `:444`
- `GET catalog/:entity/:id/dependents` (`:328`) → `:484`; `DELETE catalog/:entity/:id` (`:346`) → `:469`; `POST catalog/:entity/:id/reactivate` (`:353`) → `:495` (all @AdminOnly)

### `/courses/[courseId]`: course detail: `features/courses/course-detail.tsx`
Roles: all staff. The header actions (Edit, Publish/Hide/Archive/Restore, Delete) appear only when `isAdmin` (`course-detail.tsx:124`). Tabs: Content, Students, Notifications, Pricing, Parts, and Teachers (admin only, `:217`).
- `GET admin/courses/:id` (`hooks.ts:87`) → `courses.admin.controller.ts:74` @StaffOnly + scope
- `PATCH admin/courses/:id` diff body (`edit-course-dialog.tsx:142-202` → `hooks.ts:495`) → `:93` @StaffOnly
- `POST admin/courses/:id/{publish|unpublish {status:'HIDDEN'}|archive {reason}|restore}` (`hooks.ts:529-536`) → `:164,171,186,201` (publish/unpublish @StaffOnly; archive/restore @AdminOnly)
- `DELETE admin/courses/:id {reason}` (`hooks.ts:555`) → `:212`
- Course image: `/api/upload/course-thumbnail` (`thumbnails/upload.ts:81`)
- **Content tab** (`course-content-tab.tsx`, `attachments-panel.tsx`, `lesson-analytics-drawer.tsx`, `videos/lesson-video-panel.tsx`):
  - `GET admin/courses/:id/sections` (`hooks.ts:100`, polls every 8 s while any video is in flight) → `sections.controller.ts:69` @StaffOnly
  - `POST admin/courses/:id/sections {title,titleAr,description}` (`hooks.ts:635`) → `:80`; `PATCH admin/sections/:id {title,titleAr,description,status}` (`:647`) → `:91`; `DELETE admin/sections/:id` (`:660`) → `:120`
  - `POST admin/sections/:sid/lessons {title,titleAr,description,kind,isPreview,status}` (`hooks.ts:687`) → `lessons.controller.ts:119`; `PATCH admin/lessons/:id {title,description,status,isPreview}` (`:699,714`) → `:130`; `DELETE admin/lessons/:id` (`:722`) → `:155` (all @StaffOnly). Delete is gated in the UI by `isAdmin || canDeleteLectures` (`course-content-tab.tsx:85`; see F4).
  - Attachments: `GET lessons/:id/attachments` (`hooks.ts:347`) → `attachments.controller.ts:81`; `GET sections/:id/attachments` (`:362`) → `:93`; `POST storage/uploads/attachment {courseId,filename,contentType,sizeBytes}` (`attachments-panel.tsx:114`) → `storage.controller.ts:272` @StaffOnly + course check; direct XHR PUT to R2 (`uploads/direct-upload.ts`); `POST attachments {courseId,lessonId|sectionId,title,kind,objectKey,mimeType,sizeBytes,isProtected,isPreview}` (`hooks.ts:401`) → `attachments.controller.ts:107`; `PATCH attachments/:id` (`:412`) → `:114`; `DELETE attachments/:id` (`:416`) → `:125`
  - Lecture viewers: `GET analytics/lessons/:id/students {page,pageSize,q}` (`lesson-analytics-drawer.tsx:99`, export `:303`) → `analytics.controller.ts:113` @StaffOnly
  - Video (`features/videos/hooks.ts`, `upload.ts`) → `videos.controller.ts`, all @StaffOnly:
    - `POST videos/uploads/init {lessonId,filename,contentType,sizeBytes}` (`upload.ts:476`, re-init `:546`) → `:106`
    - PUT to the presigned R2 URL (XHR, `upload.ts` `putToStorage`)
    - `POST videos/:id/complete {sizeBytes?}` (`upload.ts:344` probe, `:572`; `hooks.ts:226` manual "check arrival") → `:126`
    - `GET videos/:id/status` (polls 4 s while UPLOADING/QUEUED/PROCESSING) (`hooks.ts:93`) → `:140`
    - `POST videos/:id/retry` (`hooks.ts:117`) → `:147`
    - `POST videos/:id/gumlet/adopt` (`:145`) → `:208`; `POST …/gumlet/sync` (`:159`) → `:220`; `GET …/gumlet/status` (polls 5 s; see F10) (`:182`) → `:228`
    - `DELETE videos/:id` (**no `?lessonId`**; see F5) (`hooks.ts:255`) → `:176/185`
    - Backend endpoints with no UI: `videos/:id/captions` (POST/DELETE), `videos/:id/gumlet/verify`, `…/gumlet/replace-failed-asset`, `videos/reuse/:lessonId` (attach an existing video), `DELETE videos/reuse/:lessonId/:videoId`.
- **Students tab** (`course-students-tab.tsx`, `refund-dialog.tsx`):
  - `GET admin/enrollments {page,pageSize,q,state,sectionId,courseId}` (`hooks.ts:119`, export `course-students-tab.tsx:404`) → `enrollments.controller.ts:151` @StaffOnly + scope
  - `POST admin/enrollments/:id/revoke {reason,courseId}` (`hooks.ts:159`, admin UI only) → `:196` @AdminOnly
  - Refunds (admin only): `GET admin/payments/:id/refunds` (`hooks.ts:256`) → `payments.controller.ts:166`; `POST admin/payments/:id/refund {type,amount?,reason?,idempotencyKey,completion,confirmMoneyReturned?}` (`:299`) → `:185`; `POST admin/payments/:id/refunds/:rid/complete {confirmMoneyReturned,reference?}` or `/fail {reason}` (`:311`) → `:202,:220` (@AdminOnly)
- **Notifications tab** (`course-notify-tab.tsx` → `hooks.ts:739`): `POST notifications/announcements {courseId,title,body,titleAr,bodyAr,route,publishNow:true}` → `notifications.controller.ts:182` **@AdminOnly**. The tab is offered to teachers (see F3).
- **Pricing tab** (`course-pricing-tab.tsx`): `GET admin/courses/:id/price-history` (`hooks.ts:339`) → `courses.admin.controller.ts:123`; `POST admin/courses/:id/price {amount,currency?,reason?}` (`hooks.ts:628`) → `:110` (@StaffOnly + teacher switch + assignment flag). Editing is gated in the UI by `isAdmin || canEditCoursePrices` (`:56`; see F4).
- **Parts tab** (`course-parts/course-parts-tab.tsx`, `part-dialog.tsx`; all → `course-parts.controller.ts`, @StaffOnly): `GET admin/courses/:id/parts` (`course-parts/hooks.ts:39`) → `:111`; `POST …/parts/default` (`:68`) → `:122`; `POST …/parts` (`:74`) → `:133`; `PATCH admin/course-parts/:pid` (`:83`) → `:148`; `PUT admin/course-parts/:pid/sections {sectionIds}` (`:96`) → `:163`; `PUT admin/courses/:id/parts/order {partIds}` (`:105`) → `:174`; `DELETE admin/course-parts/:pid` (`:118`) → `:189`; thumbnail `/api/upload/course-part-thumbnail`.
- **Teachers tab** (admin only, `course-teachers-tab.tsx`): `GET admin/users/teachers {status:ACTIVE,pageSize:100}` (`teachers/hooks.ts:30`) → `users.controller.ts:110` @AdminOnly; `POST admin/courses/:id/teachers {teacherId,isLead,can*,revenueSharePercent}` (`courses/hooks.ts:607`) → `courses.admin.controller.ts:136` @AdminOnly; `DELETE admin/courses/:id/teachers/:tid` (`:621`) → `:147` @AdminOnly.

### `/students`: `features/students/student-list.tsx` (tabs: Students, Device requests)
Roles: Nav ADMIN/MASTER. Teacher by URL: everything 403s (BE @AdminOnly).
- `GET admin/users {role:STUDENT,page,pageSize,q,universityId,academicYearId}` (`students/hooks.ts:18`, export `student-list.tsx:267`) → `users.controller.ts:91`
- Drawer (`student-drawer.tsx`): `GET admin/users/:id` (`hooks.ts:26`) → `:122`; `GET admin/enrollments {userId,pageSize:100}` (`:35`) → `enrollments.controller.ts:151`; `GET sessions/users/:id` (`:55`) → `sessions.controller.ts:59` @AdminOnly; `GET audit/user/:id` (`:70`) → `audit.controller.ts:83`; `PATCH admin/users/:id {status:SUSPENDED|ACTIVE}` (`:109`) → `users.controller.ts:145`; `POST admin/devices/users/:id/reset-binding {reason}` (`:122`) → `devices.admin.controller.ts:89`; `POST notifications/announcements {userId,title,body,publishNow}` (`:136`) → `notifications.controller.ts:182`; `DELETE admin/users/:id {reason}` (`teachers/hooks.ts:133`) → `users.controller.ts:175`
- Device requests: `GET admin/devices/change-requests {status:PENDING,pageSize:50}` polled every 2 min (`device-requests.tsx:48`) → `devices.admin.controller.ts:34`; `POST …/change-requests/:id/{approve|reject} {}` (`:59`) → `:49,:60`
- Unused hooks: `useUpdateStudent` (`hooks.ts:86`) and `useRevokeDevice` (`:126`). There is no UI to edit a student's profile or revoke a single device.

### `/teachers`: `features/teachers/teacher-list.tsx`
Roles: Nav ADMIN/MASTER. BE @AdminOnly.
- `GET admin/users/teachers {page,pageSize,q,status}` (`teachers/hooks.ts:14`, export `teacher-list.tsx:257`) → `users.controller.ts:110`
- `POST admin/users {fullName,phone,email,password,gender,role:'TEACHER',teacher:{title}}` (`hooks.ts:70`) → `:134`
- `PATCH admin/users/:id {fullName,email,status,gender,teacher:{…}}` (`:86`) → `:145`
- `PUT admin/users/:id/password {newPassword,note}` (`:100`) → `:160`
- `DELETE admin/users/:id {reason}` (`:133`) → `:175`
- Unused: `useTeacherEarnings` (`hooks.ts:107`; wrong response shape, F15). Backend `analytics/teachers/:id/earnings` and `analytics/courses/:id` have no UI.

### `/codes`: access codes: `features/codes/code-list.tsx`
Roles: Nav ADMIN/MASTER. BE @AdminOnly.
- `GET admin/codes {page,pageSize,q,status,targetType,courseId}` (`codes/hooks.ts:12`, export `code-list.tsx:234`) → `codes.controller.ts:231`
- `GET admin/codes/:id/redemptions {page:1,pageSize:50}` (`:21`) → `:276`
- `POST admin/codes/:id/revoke {reason}` (`:122`) → `:287`
- Generate dialog (`generate-codes-dialog.tsx:160-171`): `POST admin/codes/generate {targetType,courseId,sectionId,coursePartId,teacherId,batchName,count,priceAmount,prefix,expiresAt}` (`hooks.ts:102`) → `:224`. Pickers: `GET admin/courses {pageSize:100}` (`:107`), `GET admin/courses/:id/sections` (`:114`), `GET admin/courses/:id/parts`, teacher options.

### `/code-batches`: `features/codes/batch-list.tsx`
- `GET admin/code-batches {page,pageSize,q,targetType}` (`hooks.ts:31`) → `codes.controller.ts:253`
- `GET admin/code-batches/:id/codes` (Excel export, `batch-list.tsx:54`; `hooks.ts:61`) → `:269`
- `POST admin/codes/batches/:id/revoke {reason}` (`hooks.ts:139`) → `:359`

### `/part-purchases`: `features/course-parts/part-purchases.tsx`
Roles: Nav ADMIN/MASTER (`viewPartPurchases`). BE @AdminOnly.
- `GET admin/part-purchases {page,pageSize,q,courseId,coursePartId,userId,from,to}` (`course-parts/hooks.ts:133`, export `part-purchases.tsx:188`) → `course-parts.controller.ts:200`. Response `{items,meta,totals}`.

### `/library` and `/library/[materialId]`: `features/library/library-overview.tsx`, `material-detail.tsx`, `library-dialogs.tsx`
Roles: Nav ADMIN/MASTER. All BE @AdminOnly (`library.controller.ts:178` class).
- `GET admin/library/materials {page,pageSize,q,status}` (`library/hooks.ts:38`) → `:188`
- `GET admin/library/purchases {page,pageSize,q,userId,from,to}` (`:166`, export `library-overview.tsx:297`) → `:330`
- `GET admin/library/materials/:id` (`:47`) → `:204`; `POST …/materials` (`:76`) → `:211`; `PATCH …/materials/:id` (`:82`) → `:218`; `DELETE …/materials/:id` (`:95`) → `:233`
- `POST …/materials/:id/parts {title,titleAr,description,price,objectKey,sizeBytes,pageCount,isPreview}` (`:103`) → `:247`; `PATCH admin/library/parts/:id {…,objectKey?,pageCount?,thumbnailKey?}` (`:113`) → `:262`; `DELETE …/parts/:id` (`:120`) → `:277`
- `POST admin/library/packages` (`:128`) → `:288`; `PATCH …/packages/:id` (`:143`) → `:302`; `DELETE …/packages/:id` (`:149`) → `:316`
- Document upload: `POST storage/uploads/library-document {filename,contentType,sizeBytes}` (`library/upload.ts:163`) → `storage.controller.ts:325`, then a direct PUT. Thumbnails go through `/api/upload/library-part-thumbnail`.

### `/wallet`: `features/wallet/wallet-overview.tsx` (tabs: cards, revenue, wallets, ledger)
Roles: Nav ADMIN/MASTER. BE @AdminOnly.
- `GET admin/recharge-codes {…,status,batchId,from,to}` (`wallet/hooks.ts:109`, export `wallet-overview.tsx:264`) → `codes.controller.ts:323`
- `GET admin/recharge-revenue {…,batchId,userId,from,to}` (`:127`, export `:558`) → `:344`
- `GET admin/wallets {…,sort,order,minBalance}` (default sort `balance`, `wallet-overview.tsx:626-629`) (`hooks.ts:37`) → `admin-wallet.controller.ts:33`
- `GET admin/wallet-transactions {…,type,direction,source,userId,from,to}` (`:45`, export `:880`) → `:51`
- Drawer: `GET admin/wallets/:userId` (`:53`) → `:70`; `GET …/integrity` (`:68`) → `:106`; `POST …/adjust {amount,direction,reason}` (`:91`) → `:85`
- Generate dialog: `POST admin/recharge-codes/preview` (debounced) (`:152`) → `codes.controller.ts:305`; `POST admin/recharge-codes/generate` (`:161`) → `:316`

### `/support`: `features/support/support-centre.tsx`
Roles: Nav ADMIN/MASTER. BE @AdminOnly.
- `GET admin/support/counters` (`:49`; also the sidebar badge every 5 min, `components/layout/shell.tsx:116`) → `support.controller.ts:141`
- `GET admin/support/tickets {page,pageSize,q,status,priority,category}` (`:61`) → `:152`
- `GET admin/support/tickets/:id` (`:268`) → `:170`; `POST …/:id/reply {body,isInternal}` (`:281`) → `:182`; `PATCH …/:id {status|priority}` (`:287`) → `:202`

### `/announcements`: `features/announcements/*`
Roles: Nav ADMIN/MASTER. BE @AdminOnly (`announcements.controller.ts`).
- `GET admin/announcements {page,pageSize,status}` (`hooks.ts:34`) → `:59`; `GET …/:id` (`:42`) → `:74`
- `POST admin/announcements/preview {audience}` (`:61`) → `:52`
- `POST admin/announcements {title,…,audience,frequency,sendAtLocal,…,sendNow}` (`:85`) → `:85`; `PATCH …/:id` (`:100`) → `:106`; `DELETE …/:id` (`:108`) → `:129`; `POST …/:id/send-now` (`:121`) → `:141`
- Audience builder pickers: `admin/courses {pageSize:100}` (`audience-builder.tsx:80`), catalog lists, subjects.

### `/notifications`: notification centre: `features/notifications/notification-centre.tsx`
Roles: **Nav for ADMIN/MASTER and TEACHER** (`navigation.ts:604-608, 642-647`). A teacher gets audience "COURSES" only.
- `GET admin/courses {pageSize:100}` (`:58`) → `courses.admin.controller.ts:50` @StaffOnly
- `POST notifications/announcements {title,body,titleAr,bodyAr,(courseId,route)|(universityId,academicYearId),publishNow:true}` (`:63`, one call per selected course in a sequential loop `:91-93`) → `notifications.controller.ts:182` **@AdminOnly** (F3).

### `/other-data`: `features/catalog/other-data.tsx` (+ `academic-structures.tsx`, `academic-systems-panel.tsx`)
Roles: Nav ADMIN/MASTER. BE @AdminOnly for writes; reads are @Public.
- `GET subjects {includeInactive}` (`catalog/hooks.ts:108`) → `subjects.controller.ts:82`; `POST subjects` (`:359`) → `:144`; `PATCH subjects/:id` (`:370`) → `:169`; `DELETE subjects/:id` (`:374`) → `:206`
- `GET catalog/academic-years` (`:99`) → `catalog.controller.ts:258`; `POST catalog/academic-years {order,name,nameAr,structureId}` (`:224`) → `:455`
- `GET/POST/PATCH catalog/academic-structures`, `PUT …/:id/entries {entries}`, `PUT …/:id/faculties {facultyIds}` (`:241,251,259,272,284`) → `:288,299,313,328,343`
- `GET catalog/academic-systems` (`:204`) → `:281`; `PUT catalog/faculties/:id/academic-system-override {academicSystemOverride}` (`:190`) → `:426`; `PATCH catalog/universities/:id` (`:168`) → `:374`

### `/logs`: `features/logs/logs-view.tsx` (tabs: actions, logins)
Roles: Nav ADMIN/MASTER. BE @AdminOnly.
- `GET audit {page,pageSize,q,entity,action}` (`:69`, export `:184` max 5000) → `audit.controller.ts:45`
- `GET audit/logins {page,pageSize,q}` (`:276`, export `:394`) → `:66`
- `entity`/`action` are declared filter keys but no filter UI sets them.

### `/admins`: `features/admins/admin-accounts.tsx`
Roles: Nav MASTER only (`manageAdmins`). An ADMIN opening the URL sees a client-side "master only" message (`:132`). The list queries still run first (BE allows ADMIN to read `admin/users`).
- `GET admin/users {role:ADMIN,…}` (`:47`) and `{role:MASTER,pageSize:5}` (`:56`) → `users.controller.ts:91`
- `POST admin/users {fullName,phone,email,password,role:'ADMIN'}` (`:232`) → `:134` (the service enforces master-only for ADMIN creation, `users.service.ts:471-475`)
- `PUT admin/users/:id/password` (reset dialog) → `:160` (the service enforces `assertCanManage`)

### `/settings`: `features/settings/settings-page.tsx`
Roles: Nav ADMIN/MASTER. BE @AdminOnly.
- `GET admin/settings` (`settings/hooks.ts:18`) → `settings.controller.ts:48`; `PUT admin/settings {settings:{…}}` (`:29`) → `:62`
- `/api/upload/library-default-thumbnail` for `library.defaultThumbnailKey`
- Not editable from the UI: `wallet.minimumRecharge`, `wallet.maximumRecharge`, `wallet.allowAdminOverrideMinimum` (acknowledged in `types/domain.ts:773-777`).
- `meta/app-config` (`settings/hooks.ts:77`, teacher sessions only) → `meta.controller.ts:37` @Public. Used to derive teacher capabilities (broken, F4).

### Public pages: `app/(public)/{privacy,terms,account-deletion,contact}/page.tsx`
Static legal/support pages for store listings, EN/AR via `?lang=ar`. **No API calls.** Contacts are hard-coded or come from env (`features/public-site/site.ts:31-37`), not from the admin-editable `contact.*` settings.

---

## 2. UI-only / dead / stubbed items
- No mocks or placeholder data in `src/`. No TODO/FIXME markers.
- E2E stub server `e2e/stub-api/server.mjs` differs from the real backend in ways that hide defects: `analytics/revenue` returns `{points:[]}` (`:1372`) where the real one returns an array; `meta/app-config` returns a `teacher` block (`:2529-2539`) the real backend never sends; there is no route for `POST /notifications/announcements`.
- Dead code: `useUpdateStudent`, `useRevokeDevice`, `useTeacherEarnings`, `app/api/upload/attachment`, `app/api/upload/library-document`, `app/api/auth/session`, query keys `students.devices`, `logs.security`, `teachers.detail`, `teachers.earnings`, `courses.analytics`, `subjects.detail`.
- Backend admin capabilities with **no dashboard UI**: enrollment grant/extend/reject (`enrollments.controller.ts:171,178,211`), payments list/confirm (`payments.controller.ts:123,145`), security events (`security.controller.ts`), session revoke/revoke-all/revoke-playback (`sessions.controller.ts:74,90,106`), `master/*`, captions, video reuse/attach, gumlet verify/replace, `analytics/overview`, `analytics/courses/:id`, `progress/courses/:id/students`.
- UI restrictions narrower than the backend allows: teachers cannot edit course details or publish/hide from the UI (`course-detail.tsx:124`), although `PATCH admin/courses/:id` and publish/unpublish are @StaffOnly with assignment flags.
