# API integration matrix

Backend: NestJS, every route under `/api/v1/...`. 255 routes across 39 controllers. The full per-endpoint table is in §3 (method, route, auth/roles, request DTO and validation, ownership check, response shape, service, source line). Consumers are in §4 (web), §5 (mobile) and §6 (dashboard).

**Important cross-cutting contract.** The API's `ValidationPipe` uses `whitelist + forbidNonWhitelisted`, so **any extra body or query field is a 422**. New client fields can only ship after the backend that accepts them.

## 1. Contract mismatches found, and what was done

| # | Consumer → endpoint | Mismatch | Status |
|---|---|---|---|
| C1 | Dashboard `GET /admin/courses?sort=createdAt` | The API accepts `newest/oldest/title/students/price`; `createdAt` → 422, so the whole list emptied | **Fixed (dashboard)**: mapped to `newest`/`oldest` in `features/courses/hooks.ts` |
| C2 | Dashboard wallet tabs | A `sort` from one tab carried into tabs whose filter DTO has no `sort` → 422 | **Fixed (dashboard)**: `useTabParam` clears `sort`/`order` on tab change |
| C3 | Dashboard `meta/app-config → teacher.*` | The API never returned the block (confirmed in production) | **Fixed (backend)**: `teacher{canDeleteLectures,canDeleteVideos,canEditVideoUrls,canEditCoursePrices}` added (additive) |
| C4 | Dashboard `DELETE /videos/:id` for a shared asset | The API requires `?lessonId=` (409 otherwise) | **Fixed (dashboard)**: applied your `56ed65c` |
| C5 | Dashboard stats revenue (chart and tiles) | Response shape and field names | Already fixed on dashboard `origin/main` (`17c75ac`, `f5e394d`); your local `main` is 7 behind |
| C6 | Dashboard teacher notifications → `POST /notifications/announcements` (admin-only) | 403 for every teacher | **Open → `OWNER_DECISIONS.md` D2** |
| C7 | Web `GET /catalog/academic-years?departmentId=<facultyId>` | The wrong parameter name returned the platform-wide ladder | **Fixed (web)**: sends `facultyId` |
| C8 | Web proxy: any upstream 401 → refresh / sign-out | `PLAYBACK_TICKET_EXPIRED` and `INVALID_CREDENTIALS` are 401 too | **Fixed (web)**: refresh only on `UNAUTHORIZED`/`SESSION_EXPIRED`; `endsSession` ignores the other two |
| C9 | Web proxy errors drop `errors` (field messages) and `Retry-After` | The iOS ticket fallback can never fire (web F6) | Open (low; touches the WIP player) |
| C10 | Mobile `POST /storage/uploads/avatar {sizeBytes: 0}` | DTO minimum is 1 → 422 | **Fixed (mobile)**: real blob size |
| C11 | Mobile error code `COURSE_NOT_TARGETED` unknown | Generic "Not permitted" | **Fixed (mobile)**: code and translations |
| C12 | `POST /playback/tickets/:id/heartbeat` rotation | Drops `platform`/`delivery`, so iOS FairPlay → Widevine/DASH | **Fixed (backend)**: remembered per ticket in Redis |
| C13 | Heartbeat terminate reasons | Mobile mapped every reason to `PLAYBACK_DENIED` | **Fixed (mobile)**: reissuable codes go to the `expired` phase |
| C14 | `GET /search` teacher results → `/courses?teacherId=` | Neither client supports the filter | Open (low) |
| C15 | Mobile never sends `lessonId` on ticket requests or `/lessons/by-video` | The backend resolves it, but refuses ambiguous shared videos | Open (low; web local `main` has `16f045c` doing this for the web) |
| C16 | Mobile `/meta/app-config` unused | No forced-update gate | Open (`RELEASE_READINESS.md` A6) |

No other path, method, body-field or enum mismatches were found. The web and mobile agents checked every call against its DTO (web: 59 endpoints; mobile: §5).

## 2. End-to-end workflows traced

| Workflow | Path through the system | Result |
|---|---|---|
| Admin publishes a course → student sees it → joins with a section card → plays a lesson | dashboard `PATCH /admin/courses/:id` → `GET /courses` (targeting) → `POST /courses/:id/redeem` → `grantAccess` (section scope) → `POST /playback/videos/:id/ticket` (section gate) → heartbeat | **Defect fixed:** a section card on a PENDING or EXPIRED row unlocked every section. **Defect fixed:** the heartbeat did not re-check section scope. |
| Student plays a long lesson on iPhone | ticket (FairPlay, HLS) → heartbeat every 30 s → rotation before the 300 s TTL | **Defect fixed:** rotation switched to Widevine. **Defect fixed (mobile):** HLS typed as DASH. Needs a real-device test after deploy. |
| Admin revokes access mid-lesson | `POST /enrollments/.../revoke` → next heartbeat `access.resolve` | Works (existing). Section-level revocation now also terminates. |
| Teacher uploads a lecture video and the upload is interrupted | dashboard `uploads/init` → PUT to R2 → `complete` → BullMQ → Gumlet ingest → DRM verification sweep → READY | Your uncommitted backend and dashboard WIP addresses this. Production currently shows **10 videos stuck at UPLOADING**. **Defect fixed:** a teacher could not retry a failed first upload without `editVideoUrls`. |
| Student session over 12 h on the web | browser → `/api/proxy` (no access cookie) → refresh → retry | **Defect fixed:** previously answered 401 → forced sign-out. |
| Many students on the web at once | Next server process shared → refresh generation and cooldown | **Defect fixed:** now per browser. |
| Sign-out (web and dashboard) | BFF → `POST /auth/logout` with an expired token → 401 ignored | **Defect fixed:** refresh once, then revoke. |
| Paid enrollment capture (provider currently `none`) | webhook → `PaymentsService.capture` | **Defect fixed:** capture restores `coversAllSections`. Open: webhook marks processed even when capture fails (payments are off in production). |


## 3. Backend endpoint inventory (from source)

### 1. Cross-cutting behaviour

### Routing
- `main.ts`: `app.setGlobalPrefix(API_PREFIX ?? 'api')` + `enableVersioning({ type: URI, defaultVersion: API_VERSION ?? '1' })`. No controller uses `@Version`/`VERSION_NEUTRAL`, so **every route is `/api/v1/<controller>/<path>`** (including `/api/v1/meta/health`). Swagger at `/api/docs` when not production or `ENABLE_SWAGGER=true`.
- Raw body is retained (`rawBody: true`) for webhook signatures.

### Global guards (app.module.ts:194-196, executed in this order)
> **Changed by the audit:** `JwtAuthGuard` now runs **before** `ThrottlerProxyGuard`, so authenticated requests are throttled per user. Credential attempts are keyed per phone. The order below is the pre-audit one.
1. `ThrottlerProxyGuard` — one Redis-backed throttler (`THROTTLE_LIMIT`/`THROTTLE_TTL`, default 120/60s) wrapped in `ResilientThrottlerStorage` (degrades open on Redis failure). Per-route overrides: `@CredentialThrottle` (10/60s), `@PlaybackThrottle` (60/h), `@CodeThrottle` (10/5min). Tracker = `user:<id>` if `req.user` is set, else first `X-Forwarded-For` value (+ `|phone:` from body). **Because this guard runs before `JwtAuthGuard`, `req.user` is never set here** — see findings F-03.
2. `JwtAuthGuard` — global; routes opt out with `@Public()` (on public routes a present token is still parsed best-effort to personalise).
3. `RolesGuard` — `@Roles/@StaffOnly(MASTER,ADMIN,TEACHER)/@AdminOnly(MASTER,ADMIN)/@MasterOnly/@StudentOnly`; no decorator = any authenticated role. MASTER is not implicit. Fine-grained (course ownership) checks live in services, mainly `CourseAccessService.assertCanManageCourse(userId, role, courseId, capability)` where capability ∈ `content|pricing|publish|students|revenue` maps to `CourseTeacher.canEditContent|canEditPricing|canPublish|canViewStudents|canViewRevenue` (defaults true/false/false/**true**/false). MASTER/ADMIN bypass.
- `AuditInterceptor` is global but only writes for handlers carrying `@Audit(...)`.
- `RequestContextMiddleware` (all routes): request id (`X-Request-Id`, ≤64 chars or UUID), locale from `Accept-Language` (`en|ar`), device headers `X-Device-Id/-Platform/-Model/-Name/-Os/-Integrity`, `X-App-Version/-Build`.

### Authentication / session model
- **Access token**: HS256 JWT (`JWT_ACCESS_SECRET`, iss/aud checked) `{sub, sid, role}`, TTL `JWT_ACCESS_TTL` (900s). On *every* request the guard loads `Session` by `sid` and requires `status=ACTIVE`, `expiresAt>now`, user not deleted / not SUSPENDED/DISABLED, and `iat*1000 >= credentialsChangedAt-1000`. Role is taken from the DB row, not the token. Revocation is therefore immediate (one indexed lookup per request).
- **Refresh token**: separate secret JWT `{sub, sid, fam, jti}`, TTL ≥30 days (env validator forces `JWT_REFRESH_TTL >= 2592000`). Stored only as SHA-256 in `RefreshToken.tokenHash`. Single-use rotation in one interactive transaction (`create successor` + `mark old usedAt/replacedById` + extend `Session.expiresAt`). Unknown hash with valid signature → revoke family. Re-use of a rotated token: within `JWT_REFRESH_REUSE_GRACE_SECONDS` (30s) a *new parallel* token is issued (`reissueFromSuccessor`); after that the whole family + its sessions are revoked. Rotation is not compare-and-set (F-11).
- **Device binding** (students only): at login `DevicesService.resolveOnLogin` registers `X-Device-Id` (first device auto-bound ACTIVE; beyond `deviceLimit` → PENDING_APPROVAL + DeviceChangeRequest). Login is never blocked; protected content (`playback ticket`, protected attachments, paid library docs) calls `assertAuthorizedForProtectedContent`, which looks up `(userId, X-Device-Id header)` — `Session.deviceId` recorded at login is **not** compared (F-08).
- **Revocation paths**: logout (session + its refresh tokens + its tickets + push token for this device key), logout-all, password change (all sessions, *including the current one*), admin `DELETE /sessions/:id`, `POST /sessions/users/:id/revoke-all`, device revoke/approve-change/reset-binding, account suspend/delete, master `POST /master/sessions/revoke-all`. Playback tickets are additionally checked by the media Worker via `GET /api/v1/playback/tickets/:id/state?uid=` (fails open, F-10).
- Passwords: argon2 (`PasswordService`); lockout after 20 failures for 10 minutes (`configuration.ts:63-64`).
- No cookies are used anywhere (bearer only), so CSRF is not applicable. CORS (`main.ts:58-91`): allow-list `CORS_ORIGINS` (+ any `http://localhost:*` when not production), `credentials: true`; requests with no `Origin` always allowed; disallowed origin → callback error.

### Response / error envelope
- Success (`ResponseInterceptor`): `{ success: true, data: <handler result>, meta: { requestId } }`. Paginated results are `data: { items: [...], meta: { page, pageSize, total, totalPages, hasNext, hasPrevious } }`. Handlers with `@RawResponse()` (webhooks, HLS manifests/keys, dev media origin) bypass the envelope.
- Error (`AllExceptionsFilter`): `{ success:false, error:{ code, message, fields?, details? (non-prod only) }, statusCode, code, message, errors?(=fields), requestId, timestamp, path }`. `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`, no implicit conversion) → `422 VALIDATION_ERROR` with `fields{path:[msgs]}`. Prisma `P2002`→409 CONFLICT, `P2003/P2014`→409, `P2025`→404, init/panic→503 MAINTENANCE, anything else 500 `SERVER_ERROR`. `Retry-After` set on 429 when `details.retryAfterSeconds` exists. Clients branch on `code` (see `common/errors/error-codes.ts`).

### 2. Endpoint table (grouped by module)

Legend: **Auth** = route-level decorators (`[...]` = throttle/audit/raw flags). **Ownership** = the check performed in the service (verified by reading the service unless marked "—"). Request field notation: `name!` required, `name?` optional, followed by validators (`str ≤32` = IsString MaxLength 32, `enum X`, `in[...]`, `iso` = ISO-8601, `min/max`). Path params are plain strings (no CUID validation) unless noted.

### analytics

| Method | Route | Auth / roles | Request (DTO: key fields + validation) | Ownership / scope check | Response (inside `data`) | Service call | Src |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/analytics/overview` | MASTER/ADMIN | query: `PeriodDto`: from?(iso), to?(iso) | role gate only (admin scope) | object from `analytics.overview` | `analytics.overview` | analytics.controller.ts:32 |
| GET | `/api/v1/analytics/courses/:courseId` | MASTER/ADMIN/TEACHER | query: `PeriodDto`: from?(iso), to?(iso) | assertCanManageCourse(students); revenue only if canViewRevenue | object from `analytics.course` | `analytics.course` | analytics.controller.ts:46 |
| GET | `/api/v1/analytics/teachers/:teacherId/earnings` | MASTER/ADMIN/TEACHER | query: `PeriodDto`: from?(iso), to?(iso) | controller: TEACHER may only pass own id | object from `analytics.teacherEarnings` | `analytics.teacherEarnings` | analytics.controller.ts:67 |
| GET | `/api/v1/analytics/dashboard` | MASTER/ADMIN | query: `PeriodDto`: from?(iso), to?(iso) | role gate only (admin scope) | object from `analytics.dashboard` | `analytics.dashboard` | analytics.controller.ts:92 |
| GET | `/api/v1/analytics/lessons/:lessonId/students` | MASTER/ADMIN/TEACHER | query: `LessonViewersDto` +SearchablePaginationDto | assertCanManageCourse(students) | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `analytics.lessonViewers` | analytics.controller.ts:106 |
| GET | `/api/v1/analytics/revenue` | MASTER/ADMIN | query: `RevenueSeriesDto` +PeriodDto: courseId?(str ≤32) | role gate only (admin scope) | object from `analytics.revenueSeries` | `analytics.revenueSeries` | analytics.controller.ts:128 |

### attachments

| Method | Route | Auth / roles | Request (DTO: key fields + validation) | Ownership / scope check | Response (inside `data`) | Service call | Src |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/attachments/:id/ticket` | any authenticated | — | assertContentAccess + publish check + assertSectionAccessible + device check if isProtected; signed CDN URL | `{ attachmentId, url (signed CDN), headers, expiresAt, watermark }` | `attachments.issueTicket` | attachments.controller.ts:55 |
| GET | `/api/v1/lessons/:lessonId/attachments` | any authenticated | — | access.resolve only sets `locked` flag; metadata listed to any authenticated user | object from `attachments.listForLesson` | `attachments.listForLesson` | attachments.controller.ts:79 |
| GET | `/api/v1/sections/:sectionId/attachments` | any authenticated | — | same as listForLesson | object from `attachments.listForSection` | `attachments.listForSection` | attachments.controller.ts:87 |
| POST | `/api/v1/attachments` | MASTER/ADMIN/TEACHER | body: `CreateAttachmentDto`: courseId!(str ≤32), lessonId?(str ≤32), sectionId?(str ≤32), title!(str ≥1 ≤200), kind!(enum AttachmentKind), objectKey!(str ≤400), mimeType?(str ≤100), sizeBytes?(int min 0) … | assertCanManageCourse(content); objectKey must be under attachments/<courseId>/ and exist in R2 | object from `attachments.create` | `attachments.create` | attachments.controller.ts:100 |
| PATCH | `/api/v1/attachments/:id` | MASTER/ADMIN/TEACHER | body: `UpdateAttachmentDto`: title?(str ≥1 ≤200), isProtected?(bool), isDownloadable?(bool), isPreview?(bool), sortOrder?(int min 0) | assertCanManageCourse(content) | object from `attachments.update` | `attachments.update` | attachments.controller.ts:111 |
| DELETE | `/api/v1/attachments/:id` | MASTER/ADMIN/TEACHER | — | assertCanManageCourse(content) | object from `attachments.remove` | `attachments.remove` | attachments.controller.ts:122 |

### audit

| Method | Route | Auth / roles | Request (DTO: key fields + validation) | Ownership / scope check | Response (inside `data`) | Service call | Src |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/audit` | MASTER/ADMIN | query: `AuditQueryDto` +SearchablePaginationDto: actorId?(str ≤32), entity?(str ≤64), entityId?(str ≤32), action?(enum AuditAction), from?(iso), to?(iso) | role gate only (admin scope) | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `audit.list` | audit.controller.ts:38 |
| GET | `/api/v1/audit/logins` | MASTER/ADMIN | query: `LoginLogDto` +SearchablePaginationDto: from?(iso), to?(iso) | role gate only (admin scope) | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `audit.loginLog` | audit.controller.ts:59 |
| GET | `/api/v1/audit/:entity/:entityId` | MASTER/ADMIN | — | role gate only (admin scope) | object from `audit.forEntity` | `audit.forEntity` | audit.controller.ts:76 |

### auth

| Method | Route | Auth / roles | Request (DTO: key fields + validation) | Ownership / scope check | Response (inside `data`) | Service call | Src |
|---|---|---|---|---|---|---|---|
| POST | `/api/v1/auth/register` | PUBLIC [CredentialThrottle] | body: `RegisterDto`: fullName!(str ≥5 ≤120 @Matches(NAME_CHARS, ) @Validate(ThreePartNameConstraint)), studyType?(in[GENERAL, PROGRAMS]), phone!(str ≤20 @Matches(/^(?:\+?20\|0020\|0)?1[0125]\d{8}$/, )), password!(str ≤128 @Validate(StrongPasswordConstraint)), universityId!(str ≤32), facultyId!(str ≤32), departmentId!(str ≤32), academicYearId!(str ≤32) … | public | `{ user, accessToken, refreshToken, expiresIn, device{authorized,status,reason} }` | `auth.register` | auth.controller.ts:26 |
| POST | `/api/v1/auth/login` | PUBLIC [CredentialThrottle] | body: `LoginDto`: phone!(str ≤20 @Matches(/^(?:\+?20\|0020\|0)?1[0125]\d{8}$/, )), password!(str ≥1 ≤128) | public | `{ user, accessToken, refreshToken, expiresIn, device{...} }` | `auth.login` | auth.controller.ts:42 |
| POST | `/api/v1/auth/refresh` | PUBLIC | body: `RefreshDto`: refreshToken!(str) | public | `{ user, accessToken, refreshToken, expiresIn, device }` | `auth.refresh` | auth.controller.ts:68 |
| POST | `/api/v1/auth/logout` | any authenticated | — | scoped to caller (user.id) | `{ ok: true }` | `auth.logout` | auth.controller.ts:86 |
| POST | `/api/v1/auth/logout-all` | any authenticated | — | scoped to caller (user.id) | `{ ok, sessions }` | `auth.logoutAll` | auth.controller.ts:98 |
| GET | `/api/v1/auth/me` | any authenticated | — | scoped to caller (user.id) | public user object (id, phone, fullName, role, status, avatarUrl, profile...) | `users.toPublicUser` | auth.controller.ts:106 |
| GET | `/api/v1/auth/session` | any authenticated | — | scoped to caller (user.id) | `{ id,status,createdAt,lastSeenAt,expiresAt,platform,appVersion,device{...,authorized} }` | `auth.describeSession` | auth.controller.ts:116 |
| GET | `/api/v1/auth/sessions` | any authenticated | — | scoped to caller (user.id) | object from `auth.listSessions` | `auth.listSessions` | auth.controller.ts:125 |
| POST | `/api/v1/auth/password` | any authenticated [CredentialThrottle] | body: `ChangePasswordDto`: currentPassword!(str ≥1 ≤128), newPassword!(str ≤128 @Validate(StrongNewPassword)) | scoped to caller (user.id) | `{ ok: true }` (revokes ALL sessions incl. current) | `auth.changePassword` | auth.controller.ts:132 |

### catalog

| Method | Route | Auth / roles | Request (DTO: key fields + validation) | Ownership / scope check | Response (inside `data`) | Service call | Src |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/catalog/universities` | PUBLIC | — | public | object from `catalog.universities` | `catalog.universities` | catalog.controller.ts:225 |
| GET | `/api/v1/catalog/universities/:universityId/faculties` | PUBLIC | — | public | object from `catalog.faculties` | `catalog.faculties` | catalog.controller.ts:232 |
| GET | `/api/v1/catalog/faculties/:facultyId/departments` | PUBLIC | query `studyType` | public | object from `catalog.departments` | `catalog.departments` | catalog.controller.ts:239 |
| GET | `/api/v1/catalog/academic-years` | PUBLIC | query: `AcademicScopeQueryDto`: universityId?(str), facultyId?(str), departmentId?(str) | public | object from `catalog.academicYears` | `catalog.academicYears` | catalog.controller.ts:251 |
| GET | `/api/v1/catalog/academic-selection` | PUBLIC | query: `AcademicScopeQueryDto`: universityId?(str), facultyId?(str), departmentId?(str) | public | object from `catalog.academicSelection` | `catalog.academicSelection` | catalog.controller.ts:262 |
| GET | `/api/v1/catalog/academic-systems` | MASTER/ADMIN | — | role gate only (admin scope) | object from `catalog.academicSystemOverview` | `catalog.academicSystemOverview` | catalog.controller.ts:273 |
| GET | `/api/v1/catalog/academic-structures` | MASTER/ADMIN | — | role gate only (admin scope) | object from `catalog.academicStructures` | `catalog.academicStructures` | catalog.controller.ts:285 |
| POST | `/api/v1/catalog/academic-structures` | MASTER/ADMIN | body: `CreateAcademicStructureDto` +AcademicScopeQueryDto: kind!(enum AcademicStructureKind) | role gate only (admin scope) | object from `catalog.createAcademicStructure` | `catalog.createAcademicStructure` | catalog.controller.ts:292 |
| PATCH | `/api/v1/catalog/academic-structures/:id` | MASTER/ADMIN | body: `UpdateAcademicStructureDto`: kind?(enum AcademicStructureKind), isActive?(bool) | role gate only (admin scope) | object from `catalog.updateAcademicStructure` | `catalog.updateAcademicStructure` | catalog.controller.ts:306 |
| PUT | `/api/v1/catalog/academic-structures/:id/entries` | MASTER/ADMIN | body: `ReplaceStructureEntriesDto`: entries!(arr @ArrayMinSize(1) @ArrayMaxSize(60) @ValidateNested({ each: true })) | role gate only (admin scope) | object from `catalog.replaceStructureEntries` | `catalog.replaceStructureEntries` | catalog.controller.ts:321 |
| PUT | `/api/v1/catalog/academic-structures/:id/faculties` | MASTER/ADMIN | body: `SetStructureFacultiesDto`: facultyIds!(arr @ArrayMaxSize(500) @IsString({ each: true })) | role gate only (admin scope) | object from `catalog.setStructureFacultyOverrides` | `catalog.setStructureFacultyOverrides` | catalog.controller.ts:336 |
| GET | `/api/v1/catalog/tree` | MASTER/ADMIN | — | role gate only (admin scope) | object from `catalog.tree` | `catalog.tree` | catalog.controller.ts:351 |
| POST | `/api/v1/catalog/universities` | MASTER/ADMIN [Audit] | body: `CreateUniversityDto`: name!(str ≤160), nameAr!(str ≤160), code?(str ≤32), sortOrder?(int min 0), defaultAcademicSystem?(enum AcademicStructureKind) | role gate only (admin scope) | object from `catalog.createUniversity` | `catalog.createUniversity` | catalog.controller.ts:360 |
| PATCH | `/api/v1/catalog/universities/:id` | MASTER/ADMIN | body: `UpdateUniversityDto`: name?(str ≤160), nameAr?(str ≤160), logoUrl?(str ≤500), isActive?(bool), sortOrder?(int min 0), defaultAcademicSystem?(enum AcademicStructureKind) | role gate only (admin scope) | object from `catalog.updateUniversity` | `catalog.updateUniversity` | catalog.controller.ts:371 |
| POST | `/api/v1/catalog/faculties` | MASTER/ADMIN | body: `CreateFacultyDto`: universityId!(str ≤32), name!(str ≤160), nameAr!(str ≤160), sortOrder?(int min 0) | role gate only (admin scope) | object from `catalog.createFaculty` | `catalog.createFaculty` | catalog.controller.ts:382 |
| POST | `/api/v1/catalog/departments` | MASTER/ADMIN | body: `CreateDepartmentDto`: studyType?(@IsEnum({ GENERAL: 'GENERAL', PROGRAMS: 'PROGRAMS' })), facultyId!(str ≤32), name!(str ≤160), nameAr!(str ≤160), sortOrder?(int min 0) | role gate only (admin scope) | object from `catalog.createDepartment` | `catalog.createDepartment` | catalog.controller.ts:389 |
| PATCH | `/api/v1/catalog/faculties/:id` | MASTER/ADMIN | body: `UpdateFacultyDto` +UpdateCatalogNodeDto: academicSystemOverride?(@ValidateIf((_object, value) => value !== null) enum AcademicStructureKind) | role gate only (admin scope) | object from `catalog.updateFaculty` | `catalog.updateFaculty` | catalog.controller.ts:399 |
| PUT | `/api/v1/catalog/faculties/:id/academic-system-override` | MASTER/ADMIN | body: untyped object (no class validation) | role gate only (admin scope) | object from `catalog.setFacultyAcademicSystemOverride` | `catalog.setFacultyAcademicSystemOverride` | catalog.controller.ts:419 |
| PATCH | `/api/v1/catalog/departments/:id` | MASTER/ADMIN | body: `UpdateDepartmentDto` +UpdateCatalogNodeDto | role gate only (admin scope) | object from `catalog.updateDepartment` | `catalog.updateDepartment` | catalog.controller.ts:438 |
| POST | `/api/v1/catalog/academic-years` | MASTER/ADMIN | body: `CreateAcademicYearDto`: order!(int min 1), name!(str ≤80), nameAr!(str ≤80), structureId?(str) | role gate only (admin scope) | object from `catalog.createAcademicYear` | `catalog.createAcademicYear` | catalog.controller.ts:452 |
| DELETE | `/api/v1/catalog/:entity/:id` | MASTER/ADMIN | — | role gate only (admin scope) | object from `catalog.deactivate` | `catalog.deactivate` | catalog.controller.ts:462 |
| GET | `/api/v1/catalog/:entity/:id/dependents` | MASTER/ADMIN | — | role gate only (admin scope) | object from `catalog.dependents` | `catalog.dependents` | catalog.controller.ts:477 |
| POST | `/api/v1/catalog/:entity/:id/reactivate` | MASTER/ADMIN | — | role gate only (admin scope) | object from `catalog.reactivate` | `catalog.reactivate` | catalog.controller.ts:488 |

### codes

| Method | Route | Auth / roles | Request (DTO: key fields + validation) | Ownership / scope check | Response (inside `data`) | Service call | Src |
|---|---|---|---|---|---|---|---|
| POST | `/api/v1/codes/validate` | STUDENT [CodeThrottle] | body: `ValidateCodeDto`: code!(str ≥4 ≤40), courseId?(str ≤32) | student; code must not be used by caller | `{ valid, course, targetType, section, teacher, remainingRedemptions, accessDuration*, expiresAt }` | `codes.validate` | codes.controller.ts:202 |
| POST | `/api/v1/admin/codes/generate` | MASTER/ADMIN | body: `GenerateCodesDto`: targetType?(enum CodeTargetType), courseId?(str ≤32), sectionId?(str ≤32), teacherId?(str ≤32), coursePartId?(str ≤32), batchName?(str ≤120), priceAmount?(int min 0 max 1_000_000), currency?(str ≤8) … | role gate only (admin scope) | object from `codes.generateBatch` | `codes.generateBatch` | codes.controller.ts:217 |
| GET | `/api/v1/admin/codes` | MASTER/ADMIN | query: `ListCodesDto` +SearchablePaginationDto: courseId?(str ≤32), sectionId?(str ≤32), teacherId?(str ≤32), coursePartId?(str ≤32), targetType?(enum CodeTargetType), status?(enum CodeStatus), batchId?(str ≤64) | role gate only (admin scope) | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `codes.list` | codes.controller.ts:228 |
| GET | `/api/v1/admin/code-batches` | MASTER/ADMIN | query: `ListBatchesDto` +SearchablePaginationDto: targetType?(enum CodeTargetType) | role gate only (admin scope) | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `codes.listBatches` | codes.controller.ts:246 |
| GET | `/api/v1/admin/code-batches/:batchId/codes` | MASTER/ADMIN | — | role gate only (admin scope) | object from `codes.batchCodes` | `codes.batchCodes` | codes.controller.ts:262 |
| GET | `/api/v1/admin/codes/:id/redemptions` | MASTER/ADMIN | query: `SearchablePaginationDto` +PaginationDto: q?(str ≤120) | role gate only (admin scope) | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `codes.redemptions` | codes.controller.ts:273 |
| POST | `/api/v1/admin/codes/:id/revoke` | MASTER/ADMIN | body: `ReasonDto`: reason!(str ≥3 ≤500) | role gate only (admin scope) | object from `codes.revoke` | `codes.revoke` | codes.controller.ts:280 |
| POST | `/api/v1/admin/recharge-codes/preview` | MASTER/ADMIN | body: `PreviewRechargeDto`: faceValue!(num min 0 max MAX_MONEY_EGP), discountType?(enum DiscountType), discountPercent?(num min 0 max 100), discountAmount?(num min 0 max MAX_MONEY_EGP), count?(int min 1 max 5000) | role gate only (admin scope) | object from `codes.previewRecharge` | `codes.previewRecharge` | codes.controller.ts:297 |
| POST | `/api/v1/admin/recharge-codes/generate` | MASTER/ADMIN | body: `GenerateRechargeDto`: faceValue!(num min 0 max MAX_MONEY_EGP), discountType?(enum DiscountType), discountPercent?(num min 0 max 100), discountAmount?(num min 0 max MAX_MONEY_EGP), count!(int min 1 max 5000), batchName?(str ≤120), expiresAt?(iso), reservedForUserId?(str ≤32) … | role gate only (admin scope) | object from `codes.generateRechargeBatch` | `codes.generateRechargeBatch` | codes.controller.ts:309 |
| GET | `/api/v1/admin/recharge-codes` | MASTER/ADMIN | query: `ListRechargeCodesDto` +SortablePaginationDto: status?(enum CodeStatus), batchId?(str ≤64), redeemedByUserId?(str ≤32), from?(iso), to?(iso) | role gate only (admin scope) | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `codes.listRechargeCodes` | codes.controller.ts:320 |
| GET | `/api/v1/admin/recharge-revenue` | MASTER/ADMIN | query: `RechargeRevenueDto` +SortablePaginationDto: batchId?(str ≤64), userId?(str ≤32), from?(iso), to?(iso) | role gate only (admin scope) | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `codes.rechargeRevenue` | codes.controller.ts:337 |
| POST | `/api/v1/admin/codes/batches/:batchId/revoke` | MASTER/ADMIN | body: `ReasonDto`: reason!(str ≥3 ≤500) | role gate only (admin scope) | object from `codes.revokeBatch` | `codes.revokeBatch` | codes.controller.ts:356 |

### course-parts

| Method | Route | Auth / roles | Request (DTO: key fields + validation) | Ownership / scope check | Response (inside `data`) | Service call | Src |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/courses/:courseId/parts` | STUDENT | — | none beyond role (display only) | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `parts.listForStudent` | course-parts.controller.ts:49 |
| GET | `/api/v1/courses/:courseId/join-options` | STUDENT | — | none beyond role (display only) | object from `parts.joinOptions` | `parts.joinOptions` | course-parts.controller.ts:60 |
| GET | `/api/v1/me/part-purchases` | STUDENT | query: `PaginationDto` | scoped to caller (user.id) | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `purchases.myPurchases` | course-parts.controller.ts:75 |
| GET | `/api/v1/admin/courses/:courseId/parts` | MASTER/ADMIN/TEACHER | — | assertCanManageCourse(content) | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `parts.listForAdmin` | course-parts.controller.ts:104 |
| POST | `/api/v1/admin/courses/:courseId/parts/default` | MASTER/ADMIN/TEACHER | — | assertCanManageCourse(pricing) | object from `parts.createDefaultStructure` | `parts.createDefaultStructure` | course-parts.controller.ts:115 |
| POST | `/api/v1/admin/courses/:courseId/parts` | MASTER/ADMIN/TEACHER | body: `CreateCoursePartDto`: title!(str ≥2 ≤160), titleAr?(str ≤160), description?(str ≤2000), pricingModel!(enum PartPricingModel), pricePercent?(num min 0 max 100), priceAmount?(num min 0 max MAX_MONEY_EGP), sortOrder?(num min 1), sectionIds?(arr @ArrayMaxSize(200) @IsString({ each: true })) … | assertCanManageCourse(pricing) | object from `parts.create` | `parts.create` | course-parts.controller.ts:126 |
| PATCH | `/api/v1/admin/course-parts/:partId` | MASTER/ADMIN/TEACHER | body: `UpdateCoursePartDto`: title?(str ≥2 ≤160), titleAr?(str ≤160), description?(str ≤2000), pricingModel?(enum PartPricingModel), pricePercent?(num min 0 max 100), priceAmount?(num min 0 max MAX_MONEY_EGP), isActive?(bool), status?(enum ContentStatus) … | assertCanManageCourse(pricing) | object from `parts.update` | `parts.update` | course-parts.controller.ts:141 |
| PUT | `/api/v1/admin/course-parts/:partId/sections` | MASTER/ADMIN/TEACHER | body: `SetPartSectionsDto`: sectionIds!(arr @ArrayMaxSize(200) @IsString({ each: true })) | assertCanManageCourse(content) | object from `parts.setSections` | `parts.setSections` | course-parts.controller.ts:156 |
| PUT | `/api/v1/admin/courses/:courseId/parts/order` | MASTER/ADMIN/TEACHER | body: `ReorderPartsDto`: partIds!(arr @ArrayMaxSize(100) @IsString({ each: true })) | assertCanManageCourse(content) | object from `parts.reorder` | `parts.reorder` | course-parts.controller.ts:171 |
| DELETE | `/api/v1/admin/course-parts/:partId` | MASTER/ADMIN/TEACHER | — | assertCanManageCourse(pricing) | object from `parts.remove` | `parts.remove` | course-parts.controller.ts:182 |
| GET | `/api/v1/admin/part-purchases` | MASTER/ADMIN | query: `PartPurchaseReportDto` +SortablePaginationDto: courseId?(str ≤32), coursePartId?(str ≤32), userId?(str ≤32), from?(iso), to?(iso) | role gate only (admin scope) | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `parts.purchaseReport` | course-parts.controller.ts:193 |

### courses

| Method | Route | Auth / roles | Request (DTO: key fields + validation) | Ownership / scope check | Response (inside `data`) | Service call | Src |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/admin/courses` | MASTER/ADMIN/TEACHER | query: `ListStaffCoursesDto` +SearchablePaginationDto: status?(enum CourseStatus), teacherId?(str ≤32), universityId?(str ≤32), facultyId?(str ≤32), academicYearId?(str ≤32), subjectId?(str ≤32), sort?(in[newest, oldest, title, students, price]), order?(in[asc, desc]) | teacher scoped to teacherCourseIds | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `admin.list` | courses.admin.controller.ts:44 |
| GET | `/api/v1/admin/courses/:courseId` | MASTER/ADMIN/TEACHER | — | staffMayViewCourse (teacher must be assigned) | object from `admin.detailForActor` | `admin.detailForActor` | courses.admin.controller.ts:67 |
| POST | `/api/v1/admin/courses` | MASTER/ADMIN [Audit] | body: `CreateCourseDto`: title!(str ≥3 ≤200), titleAr?(str ≤200), shortDescription?(str ≤500), description?(str ≤20000), universityId?(str ≤32), facultyId?(str ≤32), academicYearId?(str ≤32), subjectId?(str ≤32) … | role gate only (admin scope) | object from `admin.create` | `admin.create` | courses.admin.controller.ts:78 |
| PATCH | `/api/v1/admin/courses/:courseId` | MASTER/ADMIN/TEACHER | body: `UpdateCourseDto`: title?(str ≥3 ≤200), titleAr?(str ≤200), shortDescription?(str ≤500), description?(str ≤20000), universityId?(str ≤32), facultyId?(str ≤32), academicYearId?(str ≤32), subjectId?(str ≤32) … | assertCanManageCourse(content) — note: also lets content-only teacher change enrollmentMethods/accessDuration (F-12) | object from `admin.update` | `admin.update` | courses.admin.controller.ts:90 |
| POST | `/api/v1/admin/courses/:courseId/price` | MASTER/ADMIN/TEACHER | body: `ChangePriceDto`: amount!(num min 0 max 1_000_000), currency?(str ≤3), compareAtAmount?(num min 0), reason?(str ≤500) | assertCanManageCourse(pricing)+teacher capability setting | object from `admin.changePrice` | `admin.changePrice` | courses.admin.controller.ts:103 |
| GET | `/api/v1/admin/courses/:courseId/price-history` | MASTER/ADMIN/TEACHER | — | assertCanManageCourse(content) | object from `admin.priceHistory` | `admin.priceHistory` | courses.admin.controller.ts:118 |
| POST | `/api/v1/admin/courses/:courseId/teachers` | MASTER/ADMIN | body: `AssignTeacherDto`: teacherId!(str ≤32), isLead?(bool), revenueSharePercent?(num min 0 max 100), canEditContent?(bool), canEditPricing?(bool), canPublish?(bool), canViewStudents?(bool), canViewRevenue?(bool) | role gate only (admin scope) | object from `admin.assignTeacher` | `admin.assignTeacher` | courses.admin.controller.ts:129 |
| DELETE | `/api/v1/admin/courses/:courseId/teachers/:teacherId` | MASTER/ADMIN | — | role gate only (admin scope) | object from `admin.removeTeacher` | `admin.removeTeacher` | courses.admin.controller.ts:144 |
| POST | `/api/v1/admin/courses/:courseId/publish` | MASTER/ADMIN/TEACHER | — | assertCanManageCourse(publish) | object from `admin.publish` | `admin.publish` | courses.admin.controller.ts:157 |
| POST | `/api/v1/admin/courses/:courseId/unpublish` | MASTER/ADMIN/TEACHER | body: `UnpublishCourseDto`: status!(@IsIn([CourseStatus.DRAFT, CourseStatus.HIDDEN, CourseStatus), reason?(str ≤500) | assertCanManageCourse(publish) | object from `admin.unpublish` | `admin.unpublish` | courses.admin.controller.ts:168 |
| POST | `/api/v1/admin/courses/:courseId/archive` | MASTER/ADMIN | body: `ArchiveCourseDto`: reason!(str ≥3 ≤500) | role gate only (admin scope) | object from `admin.archive` | `admin.archive` | courses.admin.controller.ts:179 |
| POST | `/api/v1/admin/courses/:courseId/restore` | MASTER/ADMIN | — | role gate only (admin scope) | object from `admin.restore` | `admin.restore` | courses.admin.controller.ts:194 |
| DELETE | `/api/v1/admin/courses/:courseId` | MASTER/ADMIN | body: `DeleteCourseDto`: reason!(str ≥3 ≤500) | role gate only (admin scope) | object from `admin.remove` | `admin.remove` | courses.admin.controller.ts:205 |
| GET | `/api/v1/courses` | PUBLIC | query: `ListCoursesDto` +SearchablePaginationDto: universityId?(str ≤32), facultyId?(str ≤32), academicYearId?(str ≤32), teacherId?(str ≤32), free?(bool), sort?(in[newest, popular, priceLow, priceHigh]) | public; personalised if token | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `courses.list` | courses.controller.ts:29 |
| GET | `/api/v1/courses/mine` | any authenticated | query: `PaginationDto` | scoped to caller (user.id) | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `courses.listMine` | courses.controller.ts:54 |
| GET | `/api/v1/courses/:courseId` | PUBLIC | — | public; non-staff blocked unless PUBLISHED/ARCHIVED; any non-student sees unpublished sections | course summary + `description, sections[lessons{locked}], attachments[{locked}], completionRule, access{state,expiresAt,availableMethods}` | `courses.detail` | courses.controller.ts:69 |
| GET | `/api/v1/courses/:courseId/sections` | PUBLIC | — | public; NO course-status check (F-14) | object from `courses.sections` | `courses.sections` | courses.controller.ts:84 |
| GET | `/api/v1/courses/:courseId/progress` | any authenticated | — | own progress only | object from `courses.courseProgress` | `courses.courseProgress` | courses.controller.ts:99 |
| GET | `/api/v1/courses/:courseId/attachments` | PUBLIC | — | public; NO status/publish filter (F-14) | object from `courses.attachments` | `courses.attachments` | courses.controller.ts:106 |

### devices

| Method | Route | Auth / roles | Request (DTO: key fields + validation) | Ownership / scope check | Response (inside `data`) | Service call | Src |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/admin/devices/change-requests` | MASTER/ADMIN | query: `ListChangeRequestsDto` +PaginationDto: status?(enum DeviceChangeStatus) | role gate only (admin scope) | object from `devices.listChangeRequests` | `devices.listChangeRequests` | devices.admin.controller.ts:31 |
| POST | `/api/v1/admin/devices/change-requests/:id/approve` | MASTER/ADMIN | body: `ReviewDto`: note?(str ≤500) | role gate only (admin scope) | object from `devices.approveChange` | `devices.approveChange` | devices.admin.controller.ts:42 |
| POST | `/api/v1/admin/devices/change-requests/:id/reject` | MASTER/ADMIN | body: `ReviewDto`: note?(str ≤500) | role gate only (admin scope) | object from `devices.rejectChange` | `devices.rejectChange` | devices.admin.controller.ts:57 |
| POST | `/api/v1/admin/devices/:deviceId/revoke` | MASTER/ADMIN | body: `RevokeDto`: reason!(str ≥3 ≤500) | role gate only (admin scope) | object from `devices.revokeDevice` | `devices.revokeDevice` | devices.admin.controller.ts:68 |
| POST | `/api/v1/admin/devices/users/:userId/reset-binding` | MASTER/ADMIN | body: `RevokeDto`: reason!(str ≥3 ≤500) | role gate only (admin scope) | object from `devices.resetBinding` | `devices.resetBinding` | devices.admin.controller.ts:82 |
| GET | `/api/v1/devices` | any authenticated | — | scoped to caller (user.id) | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `devices.listForUser` | devices.controller.ts:36 |
| GET | `/api/v1/devices/current` | any authenticated | — | scoped to caller (user.id) | object from `devices.currentDevice` | `devices.currentDevice` | devices.controller.ts:46 |
| POST | `/api/v1/devices/change-request` | STUDENT | body: `RequestDeviceChangeDto`: reason?(str ≤500) | own device (X-Device-Id header) | object from `devices.requestChange` | `devices.requestChange` | devices.controller.ts:52 |

### enrollments

| Method | Route | Auth / roles | Request (DTO: key fields + validation) | Ownership / scope check | Response (inside `data`) | Service call | Src |
|---|---|---|---|---|---|---|---|
| POST | `/api/v1/courses/:courseId/enroll` | STUDENT | body: `JoinCourseDto`: method!(enum EnrollmentMethod) | targeting check; method must be offered | `{ state, courseId, payment{provider,checkoutUrl,reference}\|null, message }` | `enrollments.join` | enrollments.controller.ts:88 |
| POST | `/api/v1/courses/:courseId/redeem` | STUDENT [CodeThrottle] | body: `RedeemCodeDto`: code!(str ≥4 ≤40) | targeting; code scope; see F-02 | `{ state, courseId, payment:null, message }` | `enrollments.redeemCode` | enrollments.controller.ts:119 |
| GET | `/api/v1/admin/enrollments` | MASTER/ADMIN/TEACHER | query: `ListEnrollmentsDto` +SearchablePaginationDto: courseId?(str ≤32), userId?(str ≤32), state?(enum EnrollmentState), sectionId?(str ≤32) | readableCourseIds(students) for teachers | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `enrollments.list` | enrollments.controller.ts:148 |
| POST | `/api/v1/admin/enrollments/grant` | MASTER/ADMIN/TEACHER | body: `GrantAccessDto`: userId!(str ≤32), courseId!(str ≤32), accessDurationDays?(int min 1 max 3650), note?(str ≤500) | assertCanManageCourse(students) — teachers with canViewStudents (default true) can grant (F-06) | object from `enrollments.grantByAdmin` | `enrollments.grantByAdmin` | enrollments.controller.ts:164 |
| POST | `/api/v1/admin/enrollments/:id/reject` | MASTER/ADMIN/TEACHER | body: `ReasonDto`: reason!(str ≥3 ≤500) | assertCanManageCourse(students) | object from `enrollments.rejectRequest` | `enrollments.rejectRequest` | enrollments.controller.ts:175 |
| POST | `/api/v1/admin/enrollments/:id/revoke` | MASTER/ADMIN | body: `RevokeDto`: reason!(str ≥3 ≤500) | service re-checks MASTER/ADMIN | `{ ok, enrollmentId, userId, courseId, state, alreadyRemoved, cancelledPayments, ... }` | `enrollments.revoke` | enrollments.controller.ts:186 |
| POST | `/api/v1/admin/enrollments/:id/extend` | MASTER/ADMIN/TEACHER | body: `ExtendDto`: days!(int min 1 max 3650), note?(str ≤500) | assertCanManageCourse(students) — re-activates REVOKED/PENDING (F-06) | object from `enrollments.extend` | `enrollments.extend` | enrollments.controller.ts:204 |

### health

| Method | Route | Auth / roles | Request (DTO: key fields + validation) | Ownership / scope check | Response (inside `data`) | Service call | Src |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/meta/health` | PUBLIC | — | public | `{ status, database, uptimeSeconds, version, env, timestamp }` (deep: + redis, storage, worker heartbeat, video counts, DRM sweep) | `prisma.ping` | health.controller.ts:54 |
| GET | `/api/v1/meta/health/deep` | PUBLIC | — | public | `{ status, database, uptimeSeconds, version, env, timestamp }` (deep: + redis, storage, worker heartbeat, video counts, DRM sweep) | `prisma.ping, redis.ping, storage.health` | health.controller.ts:74 |

### home

| Method | Route | Auth / roles | Request (DTO: key fields + validation) | Ownership / scope check | Response (inside `data`) | Service call | Src |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/home/feed` | any authenticated | — | scoped to caller (user.id) | object from `home.feed` | `home.feed` | home.controller.ts:15 |

### lessons

| Method | Route | Auth / roles | Request (DTO: key fields + validation) | Ownership / scope check | Response (inside `data`) | Service call | Src |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/lessons/:lessonId` | any authenticated | — | assertContentAccess + section scope + publish + unlocksAt | `{ id, sectionId, courseId, title, kind, isPreview, progress, video{id,availableQualities,captionLanguages,status,reused}, attachments, next/prev ids, completionRule }` | `lessons.detail` | lessons.controller.ts:75 |
| GET | `/api/v1/lessons/by-video/:videoId` | any authenticated | query `lessonId` | delegates to lessons.detail | object from `lessons.byVideoId` | `lessons.byVideoId` | lessons.controller.ts:87 |
| POST | `/api/v1/lessons/:lessonId/complete` | any authenticated | — | assertContentAccess (course-level) | object from `lessons.markComplete` | `lessons.markComplete` | lessons.controller.ts:103 |
| POST | `/api/v1/admin/sections/:sectionId/lessons` | MASTER/ADMIN/TEACHER | body: `CreateLessonDto`: title!(str ≥1 ≤200), titleAr?(str ≤200), description?(str ≤5000), kind?(enum LessonKind), sortOrder?(int min 1), isPreview?(bool), durationSeconds?(int min 0), status?(enum ContentStatus) … | assertCanManageCourse(content) | object from `lessons.create` | `lessons.create` | lessons.controller.ts:116 |
| PATCH | `/api/v1/admin/lessons/:lessonId` | MASTER/ADMIN/TEACHER | body: UpdateLessonDto | assertCanManageCourse(content) | object from `lessons.update` | `lessons.update` | lessons.controller.ts:127 |
| POST | `/api/v1/admin/sections/:sectionId/lessons/reorder` | MASTER/ADMIN/TEACHER | body: `ReorderLessonsDto`: lessonIds!(arr @ArrayMinSize(1) @ArrayMaxSize(500) @IsString({ each: true })) | assertCanManageCourse(content) | object from `lessons.reorder` | `lessons.reorder` | lessons.controller.ts:138 |
| DELETE | `/api/v1/admin/lessons/:lessonId` | MASTER/ADMIN/TEACHER | — | assertCanManageCourse(content)+capability setting | object from `lessons.remove` | `lessons.remove` | lessons.controller.ts:149 |

### library

| Method | Route | Auth / roles | Request (DTO: key fields + validation) | Ownership / scope check | Response (inside `data`) | Service call | Src |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/library/materials` | STUDENT | query: `BrowseLibraryDto` +SearchablePaginationDto: universityId?(str ≤32), facultyId?(str ≤32), academicYearId?(str ≤32), subjectId?(str ≤32) | scoped to caller (user.id) | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `library.browse` | library.controller.ts:58 |
| GET | `/api/v1/library/materials/:materialId` | STUDENT | — | scoped to caller (user.id) | object from `library.materialForStudent` | `library.materialForStudent` | library.controller.ts:78 |
| GET | `/api/v1/library/me` | STUDENT | query: `PaginationDto` | scoped to caller (user.id) | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `library.myLibrary` | library.controller.ts:92 |
| GET | `/api/v1/library/me/purchases` | STUDENT | query: `PaginationDto` | scoped to caller (user.id) | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `purchases.myPurchases` | library.controller.ts:103 |
| POST | `/api/v1/library/quote` | STUDENT | body: `PurchaseLibraryDto`: kind!(enum LibraryPurchaseKind), targetId!(str ≤32) | scoped to caller (user.id) | object from `purchases.quote` | `purchases.quote` | library.controller.ts:113 |
| POST | `/api/v1/library/purchase` | STUDENT | body: `PurchaseLibraryDto`: kind!(enum LibraryPurchaseKind), targetId!(str ≤32) | wallet debit; SERIALIZABLE; idempotencyKey libpart:/libpkg:<target>:<user> | `{ purchaseId, kind, targetId, title, pricePaid, currency, balanceAfter, partsGranted, partsAlreadyOwned, purchasedAt, alreadyPurchased }` | `purchases.purchase` | library.controller.ts:129 |
| POST | `/api/v1/library/parts/:partId/open` | STUDENT | — | LibraryEntitlement (unless isPreview) + device check; DRAFT/inactive parts not blocked | `{ libraryPartId, title, url (signed), mimeType, pageCount, expiresAt, watermark }` | `documents.issueTicket` | library.controller.ts:146 |
| GET | `/api/v1/admin/library/materials` | MASTER/ADMIN | query: `AdminListLibraryDto` +SearchablePaginationDto: status?(enum ContentStatus) | role gate only (admin scope) | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `library.listForAdmin` | library.controller.ts:185 |
| GET | `/api/v1/admin/library/materials/:materialId` | MASTER/ADMIN | — | role gate only (admin scope) | object from `library.materialForAdmin` | `library.materialForAdmin` | library.controller.ts:197 |
| POST | `/api/v1/admin/library/materials` | MASTER/ADMIN | body: `CreateMaterialDto`: title!(str ≥2 ≤200), titleAr?(str ≤200), description?(str ≤4000), universityId?(str ≤32), facultyId?(str ≤32), academicYearId?(str ≤32), subjectId?(str ≤32), coverKey?(str ≤512) | role gate only (admin scope) | object from `library.createMaterial` | `library.createMaterial` | library.controller.ts:208 |
| PATCH | `/api/v1/admin/library/materials/:materialId` | MASTER/ADMIN | body: `UpdateMaterialDto`: title?(str ≥2 ≤200), titleAr?(str ≤200), description?(str ≤4000), status?(enum ContentStatus), isActive?(bool), sortOrder?(int min 0), universityId?(str ≤32), facultyId?(str ≤32) … | role gate only (admin scope) | object from `library.updateMaterial` | `library.updateMaterial` | library.controller.ts:215 |
| DELETE | `/api/v1/admin/library/materials/:materialId` | MASTER/ADMIN | — | role gate only (admin scope) | object from `library.removeMaterial` | `library.removeMaterial` | library.controller.ts:226 |
| POST | `/api/v1/admin/library/materials/:materialId/parts` | MASTER/ADMIN | body: `CreateLibraryPartDto`: title!(str ≥2 ≤200), titleAr?(str ≤200), description?(str ≤4000), price!(num min 0 max MAX_MONEY_EGP), objectKey!(str ≥1 ≤512), mimeType?(str ≤120), sizeBytes?(int min 0), pageCount?(int min 0) … | role gate only (admin scope) | object from `library.createPart` | `library.createPart` | library.controller.ts:240 |
| PATCH | `/api/v1/admin/library/parts/:partId` | MASTER/ADMIN | body: `UpdateLibraryPartDto`: title?(str ≥2 ≤200), titleAr?(str ≤200), description?(str ≤4000), price?(num min 0 max MAX_MONEY_EGP), status?(enum ContentStatus), isActive?(bool), isPreview?(bool), objectKey?(str ≤512) … | role gate only (admin scope) | object from `library.updatePart` | `library.updatePart` | library.controller.ts:255 |
| DELETE | `/api/v1/admin/library/parts/:partId` | MASTER/ADMIN | — | role gate only (admin scope) | object from `library.removePart` | `library.removePart` | library.controller.ts:270 |
| POST | `/api/v1/admin/library/packages` | MASTER/ADMIN | body: `CreateLibraryPackageDto`: materialId?(str ≤32), title!(str ≥2 ≤200), titleAr?(str ≤200), description?(str ≤4000), price!(num min 0 max MAX_MONEY_EGP), partIds!(arr @ArrayMaxSize(200) @IsString({ each: true })), sortOrder?(int min 0) | role gate only (admin scope) | object from `library.createPackage` | `library.createPackage` | library.controller.ts:281 |
| PATCH | `/api/v1/admin/library/packages/:packageId` | MASTER/ADMIN | body: `UpdateLibraryPackageDto`: title?(str ≥2 ≤200), titleAr?(str ≤200), description?(str ≤4000), price?(num min 0 max MAX_MONEY_EGP), status?(enum ContentStatus), isActive?(bool), sortOrder?(int min 0), partIds?(arr @ArrayMaxSize(200) @IsString({ each: true })) | role gate only (admin scope) | object from `library.updatePackage` | `library.updatePackage` | library.controller.ts:295 |
| DELETE | `/api/v1/admin/library/packages/:packageId` | MASTER/ADMIN | — | role gate only (admin scope) | object from `library.removePackage` | `library.removePackage` | library.controller.ts:310 |
| GET | `/api/v1/admin/library/purchases` | MASTER/ADMIN | query: `LibraryPurchaseReportDto` +SearchablePaginationDto: userId?(str ≤32), from?(iso), to?(iso) | role gate only (admin scope) | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `library.purchaseReport` | library.controller.ts:323 |

### master

| Method | Route | Auth / roles | Request (DTO: key fields + validation) | Ownership / scope check | Response (inside `data`) | Service call | Src |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/master/overview` | MASTER | — | — | inline object | `inline` | master.controller.ts:40 |
| GET | `/api/v1/master/settings` | MASTER | — | — | inline object | `inline` | master.controller.ts:77 |
| PUT | `/api/v1/master/settings` | MASTER | body: `SettingDto`: key!(str ≥1 ≤80), value!, description!(str ≤500) | — | object from `audit.record` | `audit.record` | master.controller.ts:84 |
| POST | `/api/v1/master/sessions/revoke-all` | MASTER | — | — | object from `audit.record` | `audit.record` | master.controller.ts:118 |

### meta

| Method | Route | Auth / roles | Request (DTO: key fields + validation) | Ownership / scope check | Response (inside `data`) | Service call | Src |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/meta/app-config` | PUBLIC | headers `x-app-version` | public | object from `platformSettings.deviceLimit` | `platformSettings.deviceLimit, platformSettings.contacts, platformSettings.allowsAcademicYearChange` | meta.controller.ts:30 |

### notifications

| Method | Route | Auth / roles | Request (DTO: key fields + validation) | Ownership / scope check | Response (inside `data`) | Service call | Src |
|---|---|---|---|---|---|---|---|
| POST | `/api/v1/admin/announcements/preview` | MASTER/ADMIN | body: `PreviewAudienceDto`: audience! | role gate only (admin scope) | object from `announcements.preview` | `announcements.preview` | announcements.controller.ts:44 |
| GET | `/api/v1/admin/announcements` | MASTER/ADMIN | query: `ListAnnouncementsDto` +PaginationDto: status?(enum AnnouncementStatus) | role gate only (admin scope) | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `announcements.list` | announcements.controller.ts:56 |
| GET | `/api/v1/admin/announcements/:id` | MASTER/ADMIN | — | role gate only (admin scope) | object from `announcements.detail` | `announcements.detail` | announcements.controller.ts:67 |
| POST | `/api/v1/admin/announcements` | MASTER/ADMIN | body: `CreateScheduledAnnouncementDto` +ScheduleFieldsDto: title!(str ≥3 ≤200), titleAr?(str ≤200), body!(str ≥3 ≤2000), bodyAr?(str ≤2000), route?(str ≤200), sendPush?(bool), audience?, sendNow?(bool) | role gate only (admin scope) | object from `announcements.create` | `announcements.create` | announcements.controller.ts:78 |
| PATCH | `/api/v1/admin/announcements/:id` | MASTER/ADMIN | body: `UpdateScheduledAnnouncementDto` +ScheduleFieldsDto: title?(str ≥3 ≤200), titleAr?(str ≤200), body?(str ≥3 ≤2000), bodyAr?(str ≤2000), route?(str ≤200), sendPush?(bool), audience? | role gate only (admin scope) | object from `announcements.update` | `announcements.update` | announcements.controller.ts:99 |
| DELETE | `/api/v1/admin/announcements/:id` | MASTER/ADMIN | — | role gate only (admin scope) | object from `announcements.cancel` | `announcements.cancel` | announcements.controller.ts:122 |
| POST | `/api/v1/admin/announcements/:id/send-now` | MASTER/ADMIN | — | role gate only (admin scope) | object from `announcements.dispatch` | `announcements.dispatch` | announcements.controller.ts:133 |
| GET | `/api/v1/notifications` | any authenticated | query: `ListNotificationsDto` +PaginationDto: unread?(bool) | scoped to caller (user.id) | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `notifications.listLocalized` | notifications.controller.ts:87 |
| GET | `/api/v1/notifications/unread-count` | any authenticated | — | scoped to caller (user.id) | object from `notifications.unreadCount` | `notifications.unreadCount` | notifications.controller.ts:107 |
| POST | `/api/v1/notifications/:id/read` | any authenticated | — | scoped to caller (user.id) | `{ ok, updated }` | `notifications.markRead` | notifications.controller.ts:116 |
| POST | `/api/v1/notifications/read-all` | any authenticated | — | scoped to caller (user.id) | object from `notifications.markAllRead` | `notifications.markAllRead` | notifications.controller.ts:123 |
| POST | `/api/v1/notifications/devices` | any authenticated | body: `RegisterPushTokenDto`: token!(str ≥10 ≤400), platform!(in[ios, android, web]), provider?(in[expo, fcm, apns]) | scoped to caller (user.id) | object from `notifications.registerPushToken` | `notifications.registerPushToken` | notifications.controller.ts:132 |
| DELETE | `/api/v1/notifications/devices/:token` | any authenticated | — | scoped to caller (user.id) | object from `notifications.unregisterPushToken` | `notifications.unregisterPushToken` | notifications.controller.ts:153 |
| GET | `/api/v1/notifications/preferences` | any authenticated | — | scoped to caller (user.id) | object from `notifications.getPreferences` | `notifications.getPreferences` | notifications.controller.ts:161 |
| PUT | `/api/v1/notifications/preferences` | any authenticated | body: `UpdatePreferencesDto`: newCourse?(bool), newLesson?(bool), announcements?(bool), payments?(bool) | scoped to caller (user.id) | object from `notifications.updatePreferences` | `notifications.updatePreferences` | notifications.controller.ts:167 |
| POST | `/api/v1/notifications/announcements` | MASTER/ADMIN | body: `CreateAnnouncementDto`: title!(str ≥3 ≤200), titleAr?(str ≤200), body!(str ≥3 ≤2000), bodyAr?(str ≤2000), route?(str ≤200), courseId?(str ≤32), universityId?(str ≤32), academicYearId?(str ≤32) … | role gate only (admin scope) | object from `notifications.messageStudent` | `notifications.messageStudent, announcements.createLegacy` | notifications.controller.ts:182 |
| POST | `/api/v1/notifications/announcements/:id/publish` | MASTER/ADMIN | — | role gate only (admin scope) | object from `announcements.publishLegacy` | `announcements.publishLegacy` | notifications.controller.ts:199 |

### payments

| Method | Route | Auth / roles | Request (DTO: key fields + validation) | Ownership / scope check | Response (inside `data`) | Service call | Src |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/payments/mine` | any authenticated | query: `PaginationDto` | own payments | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `payments.listForUser` | payments.controller.ts:106 |
| GET | `/api/v1/admin/payments` | MASTER/ADMIN/TEACHER | query: `ListPaymentsDto` +PaginationDto: courseId?(str ≤32), userId?(str ≤32), status?(enum PaymentStatus), from?(iso), to?(iso) | readableCourseIds(revenue) for teachers | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `payments.listForAdmin` | payments.controller.ts:115 |
| POST | `/api/v1/admin/payments/:id/confirm` | MASTER/ADMIN | body: `ConfirmPaymentDto`: providerReference?(str ≤200), note?(str ≤500) | admin manual capture (AdminOnly) | `{ id, status, amount, currency, paidAt, enrollmentId }` | `payments.capture` | payments.controller.ts:136 |
| GET | `/api/v1/admin/payments/:id/refunds` | MASTER/ADMIN | — | role gate only (admin scope) | object from `refunds.summary` | `refunds.summary` | payments.controller.ts:158 |
| POST | `/api/v1/admin/payments/:id/refund` | MASTER/ADMIN | body: `RefundDto`: type!(in[FULL, PARTIAL]), amount?(str @Matches(/^\d+(\.\d{1,2})?$/, )), reason?(str ≤500), idempotencyKey!(str @Matches(/^[A-Za-z0-9_-]{8,100}$/, )), completion?(in[IMMEDIATE, PENDING]), confirmMoneyReturned?(bool) | role gate only (admin scope) | object from `refunds.refund` | `refunds.refund` | payments.controller.ts:170 |
| POST | `/api/v1/admin/payments/:id/refunds/:refundId/complete` | MASTER/ADMIN | body: `CompleteRefundDto`: confirmMoneyReturned!(bool), reference?(str ≤200), note?(str ≤500) | role gate only (admin scope) | object from `refunds.completeRequest` | `refunds.completeRequest` | payments.controller.ts:193 |
| POST | `/api/v1/admin/payments/:id/refunds/:refundId/fail` | MASTER/ADMIN | body: `FailRefundDto`: reason!(str ≥3 ≤500) | role gate only (admin scope) | object from `refunds.failRequest` | `refunds.failRequest` | payments.controller.ts:211 |
| POST | `/api/v1/payments/webhooks/paymob` | PUBLIC [RawResponse] | body: Record; headers `hmac`; body: untyped object (no class validation); raw body stream | HMAC-SHA512 over Paymob field list | raw `{ ok, deduplicated?\|unresolved? }` | `webhooks.handlePaymob` | payments.controller.ts:231 |
| POST | `/api/v1/payments/webhooks/stripe` | PUBLIC [RawResponse] | body: Record; headers `stripe-signature`; body: untyped object (no class validation); raw body stream | Stripe v1 signature, 300s tolerance | raw `{ ok, deduplicated? }` | `webhooks.handleStripe` | payments.controller.ts:244 |

### playback

| Method | Route | Auth / roles | Request (DTO: key fields + validation) | Ownership / scope check | Response (inside `data`) | Service call | Src |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/playback/manifest/:ticketId/master.m3u8` | PUBLIC [RawResponse] | query: `SignedQueryDto`: exp!(int min 0), sig!(str ≤200), maxHeight?(int min 0) | HMAC sig + live ticket + session/device ACTIVE | raw HLS text | `manifest.masterPlaylist` | manifest.controller.ts:46 |
| GET | `/api/v1/playback/manifest/:ticketId/:height.m3u8` | PUBLIC [RawResponse] | query: `SignedQueryDto`: exp!(int min 0), sig!(str ≤200), maxHeight?(int min 0) | HMAC sig + live ticket | raw HLS text | `manifest.mediaPlaylist` | manifest.controller.ts:70 |
| GET | `/api/v1/playback/keys/:ticketId` | PUBLIC [RawResponse] | query: `SignedQueryDto`: exp!(int min 0), sig!(str ≤200), maxHeight?(int min 0) | HMAC sig + live ticket | raw 16-byte key | `manifest.contentKey` | manifest.controller.ts:95 |
| GET | `/api/v1/playback/media/*key` | PUBLIC [RawResponse] | query `exp`; query `uid`; query `sig`; query `sid`; query `did`; query `tid`; query `mh` | dev-only local origin (404 when CDN configured) | raw object bytes | `storage.verifyMediaSignature, playback.ticketLiveness, storage.getObjectBuffer` | media-origin.controller.ts:79 |
| POST | `/api/v1/playback/videos/:videoId/ticket` | any authenticated [PlaybackThrottle] | body: `IssueTicketDto`: maxHeight?(int min 144 max 2160), platform?(in[ios, android, web]), lessonId?(str ≤32), delivery?(in[embed]) | authorizeLessonForPlayback (access+section+publish+unlock) + device binding + stream slot + play limit + strict DRM gate | `{ ticketId, manifestUrl, playbackHeaders, drm{scheme,licenseUrl,certificateUrl}, embedUrl, watermark{...}, captions[{url signed}], expiresAt, ttlSeconds, resumePositionSeconds, heartbeatIntervalSeconds }` | `playback.issueTicket` | playback.controller.ts:118 |
| POST | `/api/v1/playback/tickets/:ticketId/heartbeat` | any authenticated | body: `HeartbeatDto`: positionSeconds!(int min 0 max 86_400), watchedDeltaSeconds!(int min 0 max 3600), protection? | ticket.userId == caller ONLY; no session/device/section/expiry re-check (F-01) | `{ ok, terminate{reason}\|null, ticket? }` (ticket = rotated PlaybackTicketResponse) | `playback.heartbeat` | playback.controller.ts:162 |
| DELETE | `/api/v1/playback/tickets/:ticketId` | any authenticated | — | ticket.userId == caller | object from `playback.release` | `playback.release` | playback.controller.ts:190 |
| GET | `/api/v1/playback/videos/:videoId/allowance` | any authenticated | — | scoped to caller (user.id) | `{ used, limit, remaining }` | `playback.playAllowance` | playback.controller.ts:219 |
| GET | `/api/v1/playback/tickets/:ticketId/state` | PUBLIC | query `uid` | public; uid query must match ticket owner | `{ live: boolean }` | `playback.ticketLiveness` | playback.controller.ts:232 |
| POST | `/api/v1/playback/security-events` | any authenticated | body: `SecurityEventDto`: threat!(@IsIn([ 'SCREENSHOT', 'RECORDING_STARTED', 'RECORDING_STOPPE), videoId?(str ≤32), courseId?(str ≤32), lessonId?(str ≤32), ticketId?(str ≤32), meta?, occurredAt?(iso) | ticket scoped to caller | object from `playback.recordSecurityEvent` | `playback.recordSecurityEvent` | playback.controller.ts:246 |

### progress

| Method | Route | Auth / roles | Request (DTO: key fields + validation) | Ownership / scope check | Response (inside `data`) | Service call | Src |
|---|---|---|---|---|---|---|---|
| POST | `/api/v1/progress` | any authenticated | body: `ProgressItemDto`: lessonId!(str ≤32), positionSeconds!(int min 0), watchedSeconds!(int min 0) | assertContentAccess (course-level, no section scope) | object from `progress.upsert` | `progress.upsert` | progress.controller.ts:51 |
| POST | `/api/v1/progress/batch` | any authenticated | body: `BatchProgressDto`: items!(arr @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true })) | scoped to caller (user.id) | object from `progress.upsertBatch` | `progress.upsertBatch` | progress.controller.ts:66 |
| GET | `/api/v1/progress/continue-watching` | any authenticated | — | scoped to caller (user.id) | object from `progress.continueWatching` | `progress.continueWatching` | progress.controller.ts:81 |
| GET | `/api/v1/progress/lessons/:lessonId` | any authenticated | — | scoped to caller (user.id) | object from `progress.forLesson` | `progress.forLesson` | progress.controller.ts:91 |
| GET | `/api/v1/progress/courses/:courseId/students` | MASTER/ADMIN/TEACHER | query: `PaginationDto` | assertCanManageCourse(students) | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `progress.courseBreakdown` | progress.controller.ts:97 |

### search

| Method | Route | Auth / roles | Request (DTO: key fields + validation) | Ownership / scope check | Response (inside `data`) | Service call | Src |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/search` | PUBLIC | query: `SearchQueryDto`: q!(str ≥1 ≤120), entity?(in[COURSE, LESSON, TEACHER, ATTACHMENT]) | public | object from `search.search` | `search.search` | search.controller.ts:27 |
| GET | `/api/v1/search/suggestions` | PUBLIC | query: `SuggestQueryDto`: q!(str ≥1 ≤120) | public | object from `search.suggestions` | `search.suggestions` | search.controller.ts:47 |

### sections

| Method | Route | Auth / roles | Request (DTO: key fields + validation) | Ownership / scope check | Response (inside `data`) | Service call | Src |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/admin/courses/:courseId/sections` | MASTER/ADMIN/TEACHER | — | staffMayViewCourse | object from `sections.listForCourse` | `sections.listForCourse` | sections.controller.ts:62 |
| POST | `/api/v1/admin/courses/:courseId/sections` | MASTER/ADMIN/TEACHER | body: `CreateSectionDto`: title!(str ≥1 ≤160), titleAr?(str ≤160), description?(str ≤2000), sortOrder?(int min 1), unlocksAt?(iso), status?(enum ContentStatus) | assertCanManageCourse(content) | object from `sections.create` | `sections.create` | sections.controller.ts:73 |
| PATCH | `/api/v1/admin/sections/:sectionId` | MASTER/ADMIN/TEACHER | body: `UpdateSectionDto`: title?(str ≥1 ≤160), titleAr?(str ≤160), description?(str ≤2000), status?(enum ContentStatus), unlocksAt?(iso) | assertCanManageCourse(content) | object from `sections.update` | `sections.update` | sections.controller.ts:88 |
| POST | `/api/v1/admin/courses/:courseId/sections/reorder` | MASTER/ADMIN/TEACHER | body: `ReorderSectionsDto`: sectionIds!(arr @ArrayMinSize(1) @ArrayMaxSize(200) @IsString({ each: true })) | assertCanManageCourse(content) | object from `sections.reorder` | `sections.reorder` | sections.controller.ts:99 |
| DELETE | `/api/v1/admin/sections/:sectionId` | MASTER/ADMIN/TEACHER | — | assertCanManageCourse(content)+capability | object from `sections.remove` | `sections.remove` | sections.controller.ts:114 |

### security

| Method | Route | Auth / roles | Request (DTO: key fields + validation) | Ownership / scope check | Response (inside `data`) | Service call | Src |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/security-events` | MASTER/ADMIN | query: `SecurityQueryDto` +PaginationDto: userId?(str ≤32), type?(enum SecurityEventType), severity?(enum SecuritySeverity), from?(iso) | role gate only (admin scope) | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `security.list` | security.controller.ts:23 |
| GET | `/api/v1/security-events/risk/:userId` | MASTER/ADMIN | — | role gate only (admin scope) | object from `security.riskScore` | `security.riskScore` | security.controller.ts:37 |

### sessions

| Method | Route | Auth / roles | Request (DTO: key fields + validation) | Ownership / scope check | Response (inside `data`) | Service call | Src |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/sessions/active` | MASTER | query: `ListActiveDto` +PaginationDto: role?(enum UserRole) | — | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `sessions.listActive` | sessions.controller.ts:37 |
| GET | `/api/v1/sessions/users/:userId` | MASTER/ADMIN | query: `PaginationDto` | role gate only (admin scope) | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `sessions.listForUser` | sessions.controller.ts:52 |
| DELETE | `/api/v1/sessions/:id` | MASTER/ADMIN | body: `RevokeDto`: reason!(str ≥3 ≤500) | role gate only (admin scope) | object from `sessions.revoke` | `sessions.revoke` | sessions.controller.ts:67 |
| POST | `/api/v1/sessions/users/:userId/revoke-all` | MASTER/ADMIN | body: `RevokeDto`: reason!(str ≥3 ≤500) | role gate only (admin scope) | object from `sessions.revokeAllForUser` | `sessions.revokeAllForUser` | sessions.controller.ts:82 |
| POST | `/api/v1/sessions/users/:userId/revoke-playback` | MASTER/ADMIN | body: `RevokeDto`: reason!(str ≥3 ≤500) | role gate only (admin scope) | object from `sessions.revokePlaybackForUser` | `sessions.revokePlaybackForUser` | sessions.controller.ts:98 |

### settings

| Method | Route | Auth / roles | Request (DTO: key fields + validation) | Ownership / scope check | Response (inside `data`) | Service call | Src |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/admin/settings` | MASTER/ADMIN | — | role gate only (admin scope) | object from `settings.getAll` | `settings.getAll` | settings.controller.ts:41 |
| PUT | `/api/v1/admin/settings` | MASTER/ADMIN | body: `UpdateSettingsDto`: settings! | role gate only (admin scope) | object from `settings.update` | `settings.update` | settings.controller.ts:55 |

### storage

| Method | Route | Auth / roles | Request (DTO: key fields + validation) | Ownership / scope check | Response (inside `data`) | Service call | Src |
|---|---|---|---|---|---|---|---|
| POST | `/api/v1/storage/uploads/avatar` | any authenticated | body: `PresignAvatarDto`: contentType!(@IsIn(IMAGE_TYPES)), sizeBytes!(int min 1 max 5 * 1024 * 1024) | see row: avatar=own prefix; course-part/library thumbnails: NO course ownership check | `{ uploadUrl, objectKey, expiresIn, requiredHeaders }` | `storage.presignUpload` | storage.controller.ts:188 |
| POST | `/api/v1/storage/uploads/course-thumbnail` | MASTER/ADMIN/TEACHER | — | — | inline object | `inline` | storage.controller.ts:209 |
| POST | `/api/v1/storage/uploads/course-part-thumbnail` | MASTER/ADMIN/TEACHER | body: `PresignCoursePartThumbnailDto`: courseId!(str ≤32), partId!(str ≤32), contentType!(@IsIn(IMAGE_TYPES)), sizeBytes!(int min 1 max 10 * 1024 * 1024) | see row: avatar=own prefix; course-part/library thumbnails: NO course ownership check | `{ uploadUrl, objectKey, expiresIn, requiredHeaders }` | `storage.presignUpload` | storage.controller.ts:218 |
| POST | `/api/v1/storage/uploads/library-part-thumbnail` | MASTER/ADMIN | body: `PresignLibraryPartThumbnailDto`: materialId!(str ≤32), partId!(str ≤32), contentType!(@IsIn(IMAGE_TYPES)), sizeBytes!(int min 1 max 10 * 1024 * 1024) | see row: avatar=own prefix; course-part/library thumbnails: NO course ownership check | `{ uploadUrl, objectKey, expiresIn, requiredHeaders }` | `storage.presignUpload` | storage.controller.ts:235 |
| POST | `/api/v1/storage/uploads/library-default-thumbnail` | MASTER/ADMIN | body: `PresignLibraryDefaultThumbnailDto`: contentType!(@IsIn(IMAGE_TYPES)), sizeBytes!(int min 1 max 10 * 1024 * 1024) | see row: avatar=own prefix; course-part/library thumbnails: NO course ownership check | `{ uploadUrl, objectKey, expiresIn, requiredHeaders }` | `storage.presignUpload` | storage.controller.ts:248 |
| POST | `/api/v1/storage/uploads/attachment` | MASTER/ADMIN/TEACHER | body: `PresignAttachmentDto`: courseId!(str ≤32), filename!(str ≤200 @Matches(/^[\w .()\-؀-ۿ]+\.[A-Za-z0-9]{1,8}$/, )), contentType!(in[...DOC_TYPES, ...IMAGE_TYPES]), sizeBytes!(int min 1 max MAX_ATTACHMENT_BYTES), lessonId?(str ≤32) | assertCanManageCourse(content) | presign `{ uploadUrl, objectKey, ... }` or Cloudinary `{ objectKey, url, sizeBytes }` | `courseAccess.assertCourseExistsAndManageable, storage.presignUpload` | storage.controller.ts:265 |
| POST | `/api/v1/storage/uploads/library-document` | MASTER/ADMIN | body: `PresignLibraryDocumentDto`: filename!(str ≤200 @Matches(/^[\w .()\-؀-ۿ]+\.[A-Za-z0-9]{1,8}$/, )), contentType!(in[...DOC_TYPES, ...IMAGE_TYPES]), sizeBytes!(int min 1 max MAX_LIBRARY_DOCUMENT_BYTES) | see row: avatar=own prefix; course-part/library thumbnails: NO course ownership check | `{ uploadUrl, objectKey, expiresIn, requiredHeaders }` | `storage.presignUpload` | storage.controller.ts:318 |
| POST | `/api/v1/storage/uploads/library-document/content` | MASTER/ADMIN | query: `UploadLibraryDocumentQueryDto`: filename!(str ≤200 @Matches(/^[\w .()\-؀-ۿ]+\.[A-Za-z0-9]{1,8}$/, )), contentType!(in[...DOC_TYPES, ...IMAGE_TYPES]); raw body stream | no course ownership check on attachment/part-thumbnail content uploads (F-15) | `{ objectKey, sizeBytes }` | `storage.putStream` | storage.controller.ts:357 |
| POST | `/api/v1/storage/uploads/course-thumbnail/content` | MASTER/ADMIN/TEACHER | query: `UploadCourseThumbnailQueryDto` +UploadThumbnailQueryDto: courseId!(str ≤32) | assertCanManageCourse(content) | presign `{ uploadUrl, objectKey, ... }` or Cloudinary `{ objectKey, url, sizeBytes }` | `courseAccess.assertCourseExistsAndManageable, cloudinary.uploadCourseThumbnail` | storage.controller.ts:412 |
| POST | `/api/v1/storage/uploads/course-part-thumbnail/content` | MASTER/ADMIN/TEACHER | query: `UploadCoursePartThumbnailQueryDto` +UploadThumbnailQueryDto: courseId!(str ≤32), partId!(str ≤32); raw body stream | no course ownership check on attachment/part-thumbnail content uploads (F-15) | `{ objectKey, sizeBytes }` | `storage.putStream` | storage.controller.ts:458 |
| POST | `/api/v1/storage/uploads/library-part-thumbnail/content` | MASTER/ADMIN | query: `UploadLibraryPartThumbnailQueryDto` +UploadThumbnailQueryDto: materialId!(str ≤32), partId!(str ≤32); raw body stream | no course ownership check on attachment/part-thumbnail content uploads (F-15) | `{ objectKey, sizeBytes }` | `storage.putStream` | storage.controller.ts:486 |
| POST | `/api/v1/storage/uploads/library-default-thumbnail/content` | MASTER/ADMIN | query: `UploadThumbnailQueryDto`: contentType!(@IsIn(IMAGE_TYPES)); raw body stream | no course ownership check on attachment/part-thumbnail content uploads (F-15) | `{ objectKey, sizeBytes }` | `storage.putStream` | storage.controller.ts:511 |
| POST | `/api/v1/storage/uploads/attachment/content` | MASTER/ADMIN/TEACHER | query: `UploadAttachmentQueryDto`: courseId!(str ≤32), filename!(str ≤200 @Matches(/^[\w .()\-؀-ۿ]+\.[A-Za-z0-9]{1,8}$/, )), contentType!(in[...DOC_TYPES, ...IMAGE_TYPES]); raw body stream | no course ownership check on attachment/part-thumbnail content uploads (F-15) | `{ objectKey, sizeBytes }` | `storage.putStream` | storage.controller.ts:538 |

### subjects

| Method | Route | Auth / roles | Request (DTO: key fields + validation) | Ownership / scope check | Response (inside `data`) | Service call | Src |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/subjects` | PUBLIC | query: `ListSubjectsDto`: q?(str ≤120), includeInactive?(bool) | public | inline object | `inline` | subjects.controller.ts:76 |
| GET | `/api/v1/subjects/:id` | MASTER/ADMIN | — | role gate only (admin scope) | inline object | `inline` | subjects.controller.ts:112 |
| POST | `/api/v1/subjects` | MASTER/ADMIN | body: `CreateSubjectDto`: name!(str ≥2 ≤120), nameAr!(str ≥2 ≤120), sortOrder?(int min 0) | role gate only (admin scope) | object from `audit.record` | `audit.record` | subjects.controller.ts:141 |
| PATCH | `/api/v1/subjects/:id` | MASTER/ADMIN | body: `UpdateSubjectDto`: name?(str ≥2 ≤120), nameAr?(str ≥2 ≤120), sortOrder?(int min 0), isActive?(bool) | role gate only (admin scope) | object from `audit.record` | `audit.record` | subjects.controller.ts:166 |
| DELETE | `/api/v1/subjects/:id` | MASTER/ADMIN | — | role gate only (admin scope) | object from `audit.record` | `audit.record` | subjects.controller.ts:199 |

### support

| Method | Route | Auth / roles | Request (DTO: key fields + validation) | Ownership / scope check | Response (inside `data`) | Service call | Src |
|---|---|---|---|---|---|---|---|
| POST | `/api/v1/support/tickets` | STUDENT | body: `CreateTicketDto`: subject!(str ≥3 ≤200), body!(str ≥3 ≤4000), category?(enum SupportTicketCategory), courseId?(str ≤32) | scoped to caller (user.id) | object from `support.createTicket` | `support.createTicket` | support.controller.ts:81 |
| GET | `/api/v1/support/tickets` | STUDENT | query: `PaginationDto` | scoped to caller (user.id) | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `support.listForStudent` | support.controller.ts:89 |
| GET | `/api/v1/support/tickets/:id` | STUDENT | — | where {id,userId} | object from `support.detailForStudent` | `support.detailForStudent` | support.controller.ts:100 |
| POST | `/api/v1/support/tickets/:id/messages` | STUDENT | body: `MessageDto`: body!(str ≥1 ≤4000) | where {id,userId} | object from `support.addStudentMessage` | `support.addStudentMessage` | support.controller.ts:110 |
| GET | `/api/v1/admin/support/counters` | MASTER/ADMIN | — | role gate only (admin scope) | object from `support.counters` | `support.counters` | support.controller.ts:138 |
| GET | `/api/v1/admin/support/tickets` | MASTER/ADMIN | query: `ListTicketsDto` +SearchablePaginationDto: status?(enum SupportTicketStatus), priority?(enum SupportTicketPriority), category?(enum SupportTicketCategory), assignedToId?(str ≤32) | role gate only (admin scope) | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `support.listForStaff` | support.controller.ts:145 |
| GET | `/api/v1/admin/support/tickets/:id` | MASTER/ADMIN | — | role gate only (admin scope) | object from `support.detailForStaff` | `support.detailForStaff` | support.controller.ts:164 |
| POST | `/api/v1/admin/support/tickets/:id/reply` | MASTER/ADMIN | body: `StaffReplyDto` +MessageDto: isInternal?(bool) | role gate only (admin scope) | object from `support.reply` | `support.reply` | support.controller.ts:174 |
| PATCH | `/api/v1/admin/support/tickets/:id` | MASTER/ADMIN | body: `UpdateTicketDto`: status?(enum SupportTicketStatus), priority?(enum SupportTicketPriority), category?(enum SupportTicketCategory), assignedToId?(str ≤32) | role gate only (admin scope) | object from `support.updateTicket` | `support.updateTicket` | support.controller.ts:195 |

### users

| Method | Route | Auth / roles | Request (DTO: key fields + validation) | Ownership / scope check | Response (inside `data`) | Service call | Src |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/profile` | any authenticated | — | scoped to caller (user.id) | public user object (id, phone, fullName, role, status, avatarUrl, profile...) | `users.toPublicUser` | profile.controller.ts:56 |
| PATCH | `/api/v1/profile` | any authenticated | body: `UpdateProfileDto`: fullName?(str ≥5 ≤120), locale?(in[en, ar]), academicYearId?(str ≤32) | scoped to caller (user.id) | object from `users.updateOwnProfile` | `users.updateOwnProfile` | profile.controller.ts:62 |
| PUT | `/api/v1/profile/avatar` | any authenticated | body: `SetAvatarDto`: avatarUrl?(str ≤500) | own; avatarUrl any string ≤500 (no URL/namespace check) | object from `users.setAvatar` | `users.setAvatar` | profile.controller.ts:72 |
| GET | `/api/v1/admin/users` | MASTER/ADMIN | query: `ListUsersDto` +SearchablePaginationDto: role?(enum UserRole), status?(enum AccountStatus), universityId?(str ≤32), academicYearId?(str ≤32) | role gate only (admin scope) | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `users.list` | users.controller.ts:88 |
| GET | `/api/v1/admin/users/teachers` | MASTER/ADMIN | query: `ListTeachersDto` +SearchablePaginationDto: status?(enum AccountStatus) | role gate only (admin scope) | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `users.listTeachersForAdmin` | users.controller.ts:103 |
| GET | `/api/v1/admin/users/:id` | MASTER/ADMIN | — | role gate only (admin scope) | object from `users.findById` | `users.findById` | users.controller.ts:119 |
| POST | `/api/v1/admin/users` | MASTER/ADMIN [Audit] | body: `CreateStaffDto`: phone!(str ≤20 @Matches(/^(?:\+?20\|0020\|0)?1[0125]\d{8}$/, )), password!(str ≥8 ≤128), fullName!(str ≥3 ≤120), role!(in[UserRole.ADMIN, UserRole.TEACHER]), gender?(enum Gender), email?(str ≤160), teacher? | MASTER only may create ADMIN; MASTER never creatable | object from `users.createStaff` | `users.createStaff` | users.controller.ts:126 |
| PATCH | `/api/v1/admin/users/:id` | MASTER/ADMIN | body: `UpdateUserDto`: fullName?(str ≥3 ≤120), status?(enum AccountStatus), gender?(enum Gender), email?(str ≤160), universityId?(str ≤32), facultyId?(str ≤32), departmentId?(str ≤32), academicYearId?(str ≤32) … | assertCanManage: ADMIN cannot touch ADMIN/MASTER; no role field | object from `users.updateByAdmin` | `users.updateByAdmin` | users.controller.ts:138 |
| PUT | `/api/v1/admin/users/:id/password` | MASTER/ADMIN | body: `ResetPasswordDto`: newPassword!(str ≥8 ≤128), note?(str ≤500) | assertCanManage | object from `users.resetPasswordByAdmin` | `users.resetPasswordByAdmin` | users.controller.ts:153 |
| DELETE | `/api/v1/admin/users/:id` | MASTER/ADMIN | body: `DeleteUserDto`: reason!(str ≥3 ≤500) | assertCanManage; not self; not MASTER | object from `users.softDelete` | `users.softDelete` | users.controller.ts:168 |

### videos

| Method | Route | Auth / roles | Request (DTO: key fields + validation) | Ownership / scope check | Response (inside `data`) | Service call | Src |
|---|---|---|---|---|---|---|---|
| POST | `/api/v1/webhooks/gumlet/assets` | PUBLIC | body: GumletWebhookEvent; headers `x-gumlet-signature` | HMAC-SHA256 of raw body (refuses when secret unset) | `{ received, matched, action }` | `webhooks.verifySignature, webhooks.handle` | gumlet-webhook.controller.ts:35 |
| POST | `/api/v1/videos/uploads/init` | MASTER/ADMIN/TEACHER | body: `InitUploadDto`: lessonId!(str ≤32), filename!(str ≤255 @Matches(/^[\w .()\-؀-ۿ]+\.[A-Za-z0-9]{2,5}$/, )), contentType!(str ≤100), sizeBytes!(int min 1 max 8 * 1024 * 1024 * 1024) | assertCanManageCourse(content) | object from `videos.initUpload` | `videos.initUpload` | videos.controller.ts:99 |
| POST | `/api/v1/videos/:videoId/complete` | MASTER/ADMIN/TEACHER | body: `CompleteUploadDto`: sizeBytes?(int min 1 max 8 * 1024 * 1024 * 1024) | assertCanManageCourse(content) | object from `videos.completeUpload` | `videos.completeUpload` | videos.controller.ts:110 |
| GET | `/api/v1/videos/:videoId/status` | MASTER/ADMIN/TEACHER | — | assertCanManageCourse(content) | object from `videos.status` | `videos.status` | videos.controller.ts:134 |
| POST | `/api/v1/videos/:videoId/retry` | MASTER/ADMIN/TEACHER | — | assertCanManageCourse(content) | object from `videos.retryProcessing` | `videos.retryProcessing` | videos.controller.ts:144 |
| POST | `/api/v1/videos/:videoId/captions` | MASTER/ADMIN/TEACHER | body: `AddCaptionDto`: language!(in[en, ar]), label!(str ≤80), objectKey!(str ≤400), isDefault?(bool) | assertCanManageCourse(content); objectKey NOT namespace-checked (F-09) | object from `videos.addCaption` | `videos.addCaption` | videos.controller.ts:151 |
| DELETE | `/api/v1/videos/:videoId/captions/:language` | MASTER/ADMIN/TEACHER | — | assertCanManageCourse(content) | object from `videos.removeCaption` | `videos.removeCaption` | videos.controller.ts:165 |
| DELETE | `/api/v1/videos/:videoId` | MASTER/ADMIN/TEACHER | query: `RemoveVideoQueryDto`: lessonId?(str ≤32) | assertCanManageCourse(content)+capability | object from `videos.remove` | `videos.remove` | videos.controller.ts:176 |
| POST | `/api/v1/videos/:videoId/gumlet/adopt` | MASTER/ADMIN/TEACHER | — | assertCanManageVideo | object from `gumletIngest.adopt` | `gumletIngest.adopt` | videos.controller.ts:197 |
| POST | `/api/v1/videos/:videoId/gumlet/sync` | MASTER/ADMIN/TEACHER | — | assertCanManageVideo | object from `gumletIngest.sync` | `gumletIngest.sync` | videos.controller.ts:213 |
| GET | `/api/v1/videos/:videoId/gumlet/status` | MASTER/ADMIN/TEACHER | — | assertCanManageVideo | object from `gumletIngest.status` | `gumletIngest.status` | videos.controller.ts:225 |
| POST | `/api/v1/videos/:videoId/gumlet/verify` | MASTER/ADMIN/TEACHER | — | assertCanManageVideo | object from `drmVerification.verify` | `drmVerification.verify` | videos.controller.ts:241 |
| POST | `/api/v1/videos/:videoId/gumlet/replace-failed-asset` | MASTER/ADMIN/TEACHER | — | assertCanManageVideo | object from `gumletIngest.replaceFailedAsset` | `gumletIngest.replaceFailedAsset` | videos.controller.ts:276 |
| POST | `/api/v1/videos/reuse/:lessonId` | MASTER/ADMIN/TEACHER | body: `AttachExistingVideoDto`: videoId!(str ≤32) | lesson course manageable AND source video's course manageable | object from `videos.getCourseForLesson` | `videos.getCourseForLesson, videos.assertCanManageCourseContent, lessonVideos.attach` | videos.controller.ts:329 |
| DELETE | `/api/v1/videos/reuse/:lessonId/:videoId` | MASTER/ADMIN/TEACHER | — | assertCanManageCourse(content) on target lesson's course | object from `videos.detach` | `videos.detach` | videos.controller.ts:360 |

### wallet

| Method | Route | Auth / roles | Request (DTO: key fields + validation) | Ownership / scope check | Response (inside `data`) | Service call | Src |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/admin/wallets` | MASTER/ADMIN | query: `ListWalletsDto` +SortablePaginationDto: sort?(@IsIn(['balance', 'totalSpent', 'totalRecharged', 'updatedAt), minBalance?(num min 0 max MAX_MONEY_EGP) | role gate only (admin scope) | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `wallet.listWallets` | admin-wallet.controller.ts:26 |
| GET | `/api/v1/admin/wallet-transactions` | MASTER/ADMIN | query: `AdminListTransactionsDto` +ListTransactionsDto: userId?(str ≤32) | role gate only (admin scope) | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `wallet.transactions` | admin-wallet.controller.ts:44 |
| GET | `/api/v1/admin/wallets/:userId` | MASTER/ADMIN | — | role gate only (admin scope) | `{ balance, currency, totalRecharged, totalSpent, transactionCount, updatedAt }` | `wallet.summary, wallet.transactions` | admin-wallet.controller.ts:67 |
| POST | `/api/v1/admin/wallets/:userId/adjust` | MASTER/ADMIN | body: `AdjustWalletDto`: amount!(num min 0.01 max MAX_MONEY_EGP), direction!(enum WalletTxDirection), reason!(str ≥5 ≤500) | target must be STUDENT; conditional debit | object from `wallet.adjust` | `wallet.adjust` | admin-wallet.controller.ts:78 |
| GET | `/api/v1/admin/wallets/:userId/integrity` | MASTER/ADMIN | — | role gate only (admin scope) | object from `wallet.verifyIntegrity` | `wallet.verifyIntegrity` | admin-wallet.controller.ts:99 |
| GET | `/api/v1/wallet` | STUDENT | — | scoped to caller (user.id) | `{ balance, currency, totalRecharged, totalSpent, transactionCount, updatedAt }` | `wallet.summary` | wallet.controller.ts:26 |
| GET | `/api/v1/wallet/transactions` | STUDENT | query: `ListTransactionsDto` +SortablePaginationDto: type?(enum WalletTxType), direction?(enum WalletTxDirection), source?(enum WalletTxSource), from?(iso), to?(iso) | scoped to caller (user.id) | paginated `{ items[], meta{page,pageSize,total,totalPages,hasNext,hasPrevious} }` | `wallet.transactions` | wallet.controller.ts:37 |
| POST | `/api/v1/wallet/redeem` | STUDENT [CodeThrottle] | body: `RedeemCodeDto`: code!(str ≥4 ≤40) | SERIALIZABLE; unique(codeId,userId); atomic credit | `{ codeId, code, credited, balance, currency, transactionId }` | `wallet.redeemRechargeCode` | wallet.controller.ts:61 |

### 3. Background jobs, queues, timers

BullMQ on Redis (`JobsModule`, prefix `<REDIS_PREFIX>:bull`). Processors are registered only when `RUN_WORKERS=true` (the `worker.ts` entry sets it before importing `AppModule`); the API process only enqueues. `MaintenanceScheduler.onModuleInit` (runs in *every* process, API included) registers repeatable jobs with fixed `jobId`s, so duplicates collapse.

| Queue | Job | Schedule (UTC) | What it does (verified in source) |
|---|---|---|---|
| `maintenance` | `dispatch-announcements` | `ANNOUNCEMENT_SWEEP_CRON` (default every minute) | `AnnouncementsService.dispatchDue(now)` — fans out scheduled/recurring announcements into notifications (dedupe via `AnnouncementDispatch @@unique([announcementId, occurrenceAt])`). |
| `maintenance` | `reclaim-stream-slots` | `*/5 * * * *` | Tickets `ACTIVE` with `lastHeartbeatAt < now-heartbeatGrace` → `EXPIRED` (reason "Heartbeat stopped") and their Redis stream slot (`pb:slots:<userId>`) released (max 500/run). |
| `maintenance` | `expire-playback-tickets` | `*/15 * * * *` | `ACTIVE` tickets past `expiresAt` → `EXPIRED`. |
| `maintenance` | `recover-stranded-videos` | `*/30 * * * *` | `VideosService.recoverStrandedVideos()` — re-enqueue/repair videos stuck in UPLOADING/QUEUED/PROCESSING. |
| `maintenance` | `expire-enrollments` | `15 * * * *` | `ACTIVE` enrollments with `accessEndsAt <= now` → `EXPIRED` (keeps `coversAllSections` and section grants — relevant to F-02). |
| `maintenance` | `expire-codes` | `25 * * * *` | `CodesService.expireLapsedCodes()` — codes past `expiresAt` → `EXPIRED`. |
| `maintenance` | `prune-sessions` | `0 3 * * *` | Deletes refresh tokens expired >30 days and non-ACTIVE sessions expired >30 days (ACTIVE-but-expired sessions are never pruned). |
| `maintenance` | `prune-idempotency` | `10 3 * * *` | Deletes expired `IdempotencyRecord` rows (webhook dedupe keys live 7 days). |
| `maintenance` | `course-expiry-reminders` | `0 7 * * *` | Notifies students whose access ends in 3–4 days (dedupe key `course-expiry:<enrollmentId>:<day>`), max 2000/run. |
| `maintenance` | `refresh-drm-verification` | not scheduled (manual enqueue only) | `DrmVerificationSweepService.sweep()`. |
| `analytics` | `rollup-daily-course-stats` | `30 3 * * *` | Folds one day of `watch_events` into `daily_course_stats` (upsert on `courseId+day`, idempotent). |
| `video-processing` | `transcode`, `cleanup-source` | on upload completion (`VideosService.completeUpload/retryProcessing`) | Download source → ffprobe → AES-128 HLS ladder (keys = HMAC(HLS_KEY_ROOT, videoId)) → upload to R2 → metadata; concurrency 1. (Gumlet ingest path is handled by `gumlet-ingest.service.ts` + webhook.) |
| `push-delivery` | `single` / `bulk` | on notification creation | Expo push; checks preferences at send time (security notifications bypass prefs); deactivates dead tokens. Concurrency 5. |

In-process timers (not BullMQ, run on every API replica):
- `DrmVerificationSchedulerService` (`src/modules/playback/drm-verification-scheduler.service.ts:115`): `setInterval` every `DRM_SWEEP_INTERVAL_SECONDS` (900, 0 disables) re-verifying Gumlet DRM state; last result stored in Redis and shown on `/meta/health/deep`.
- `WorkerHeartbeat` (worker only): writes a Redis heartbeat read by `/meta/health/deep`.

External callbacks: `POST /api/v1/webhooks/gumlet/assets` (HMAC-SHA256 of raw body with `GUMLET_WEBHOOK_SECRET`, refuses when unset, no timestamp/replay window), `POST /api/v1/payments/webhooks/paymob` (HMAC-SHA512 over Paymob's field list), `POST /api/v1/payments/webhooks/stripe` (v1 signature, 300s tolerance). Webhooks dedupe through `IdempotencyRecord`.

Cloudflare media Worker (`docs/cloudflare-worker.js`, deployed by `wrangler.toml`): GET/HEAD only; denies `uploads/` and `*/source/*`; requires `exp`,`uid`,`sig` and verifies `HMAC-SHA256(MEDIA_SIGNING_KEY, key\nexp\nuid\nsid\ndid\ntid\nmh)` (base64url) — identical to `StorageService.computeMediaSignature`; enforces `mh` rendition ceiling; if `TICKET_CHECK=true` and `tid` present, calls `${API_ORIGIN}/api/v1/playback/tickets/:tid/state?uid=` (10s edge cache, **fails open** on timeout/5xx); serves `library/*` from the `LIBRARY` R2 binding else `MEDIA`.

### 4. Prisma models (prisma/schema.prisma) — notable constraints

Postgres, `relationJoins` preview. IDs are cuid. Soft delete via `deletedAt` on most content tables (enforced only in queries via `notDeleted`).

| Area | Model (table) | Notable constraints / semantics |
|---|---|---|
| Identity | `User` (users) | `phone @unique`, `email @unique?`; `role` enum MASTER/ADMIN/TEACHER/STUDENT; `credentialsChangedAt` invalidates older access tokens; `failedLoginCount/lockedUntil`. Soft-delete rewrites phone to `deleted:<phone>:<ts>`. |
| | `StudentProfile` | `userId @unique`; university/faculty/department/year FKs `SetNull`. |
| | `TeacherProfile` | `userId @unique`; `revenueSharePercent Decimal(5,2) default 0`. |
| | `Session` | `deviceId?` (SetNull), `status` ACTIVE/EXPIRED/REVOKED, `expiresAt` (extended on each refresh); `@@index([userId,status])`. |
| | `RefreshToken` | `tokenHash @unique`, `replacedById @unique` (rotation chain), `familyId` indexed; cascade from Session/User. |
| | `Device` | `@@unique([userId, deviceKey])`; status ACTIVE/PENDING_APPROVAL/REVOKED/BLOCKED. `DeviceChangeRequest` status PENDING/APPROVED/REJECTED/CANCELLED. |
| Catalog | `University`, `Faculty @@unique([universityId,name])`, `Department @@unique([facultyId,name])` (+`studyType`), `AcademicStructure` (`scopeKey`; DB has a *partial* unique index `WHERE scopeKey <> 'platform'` not expressible in schema), `AcademicStructureFaculty` (`facultyId @unique`), `AcademicYear @@unique([structureId,order])`, `Subject name @unique`. A DB trigger on `faculties.academicSystemOverride` exists only in migration SQL. |
| Content | `Course` | `slug @unique`; `status` DRAFT/PUBLISHED/SUSPENDED/ARCHIVED/HIDDEN; `enrollmentMethods EnrollmentMethod[]`; `isFree`; access duration (LIFETIME/FIXED_DAYS/UNTIL_DATE); denormalised counters (lessonCount, studentCount…). `CourseDepartment @@id([courseId,departmentId])` drives targeting. |
| | `CourseTeacher` | `@@unique([courseId,teacherId])`; per-assignment capabilities `canEditContent=true, canEditPricing=false, canPublish=false, canViewStudents=true, canViewRevenue=false`; `revenueSharePercent?`. |
| | `CoursePrice` | `@@unique([courseId,version])`, `isCurrent` flag (single current enforced in code only). |
| | `CourseSection` `@@unique([courseId,sortOrder])`, `partId?` (SetNull), `unlocksAt?`; `Lesson @@unique([sectionId,sortOrder])`, `isPreview`. |
| | `Video` | `lessonId String? @unique` (legacy owner; nullable since `20261012120000_shared_video_assets`), `courseId`; Gumlet fields (`gumletAssetId`, `drmProvider`, `drmVerifiedAt`, `drmBlockedReason`…). Shared videos via `LessonVideo @@id([lessonId,videoId])`. `VideoRendition @@unique([videoId,height])`, `CaptionTrack @@unique([videoId,language])` (objectKey free text). |
| | `Attachment` | `courseId` + optional `lessonId`/`sectionId` (code enforces not both), `objectKey`, `isProtected=true`, `isDownloadable=false`, `isPreview=false`. |
| Commerce | `Enrollment` | `@@unique([userId,courseId])`; state PENDING_APPROVAL/PENDING_PAYMENT/ACTIVE/EXPIRED/REVOKED/ARCHIVED; `accessStartsAt/accessEndsAt`; **`coversAllSections Boolean @default(true)`** (schema.prisma:1691) — false means access limited to `EnrollmentSectionGrant` rows (`@@unique([enrollmentId,sectionId])`, source CODE/PAYMENT/ADMIN/PART_PURCHASE). |
| | `Payment` | `idempotencyKey @unique`, status PENDING/AUTHORIZED/PAID/FAILED/CANCELLED/REFUNDED/PARTIALLY_REFUNDED, provider MANUAL/PAYMOB/STRIPE/CODE/FREE, `refundedAmount`; `PaymentTransaction` append-only log; `RevenueLedger` per capture/refund (negative gross for refunds). |
| | `AccessCode` | `code @unique`; `kind` ACCESS/RECHARGE; `targetType` COURSE/SECTION/TEACHER/PART; `maxRedemptions/redemptionCount`; snapshots `grantedSectionIds[]`, `grantedCourseIds[]`; recharge amounts frozen (`faceValue, discount*, actualPaidAmount, creditAmount`). `AccessCodeRedemption @@unique([codeId,userId])`, `walletTransactionId @unique`. `CodeBatch`. |
| | `Wallet` | `userId @unique`, `balance Decimal(12,2)`, `version`; debit is a conditional `UPDATE … WHERE balance >= amount`. `WalletTransaction.idempotencyKey @unique`, balanceBefore/After. `RechargeRevenue.accessCodeId @unique`. |
| | `CoursePart` `@@unique([courseId,sortOrder])`, pricing PERCENTAGE/FIXED; `CoursePartEntitlement @@unique([userId,coursePartId])`, `purchaseId @unique`; `CoursePartPurchase idempotencyKey @unique`, `walletTransactionId @unique`. |
| Library | `LibraryMaterial`, `LibraryPart @@unique([materialId,sortOrder])` (`objectKey`, `price`, `isPreview`), `LibraryPackage`, `LibraryPackageItem @@unique([packageId,libraryPartId])` (part Restrict), `LibraryPurchase idempotencyKey @unique` + `walletTransactionId @unique`, `LibraryEntitlement @@unique([userId,libraryPartId])` (`revokedAt?`). |
| Playback | `PlaybackTicket` | status ACTIVE/EXPIRED/RELEASED/REVOKED; `sessionId?`, `deviceId?`, `playId?`; `rotatedFromId @unique` (each ticket rotates at most once). `VideoPlay @@unique([userId,videoId,attemptNumber])` (play-count limit). `WatchProgress @@unique([userId,lessonId])`, `WatchEvent` (append-only), `DailyCourseStat @@unique([courseId,day])`. |
| Engagement | `Notification dedupeKey @unique?`, `Announcement` (audienceRule JSON, schedule fields), `AnnouncementDispatch @@unique([announcementId,occurrenceAt])`, `PushToken token @unique` (upsert reassigns owner), `NotificationPreference userId @unique`, `SupportTicket reference @unique` + `SupportMessage isInternal`. |
| Ops | `SecurityEvent`, `AuditLog`, `ArchiveRecord`, `PlatformSetting key @id (Json value)`, `IdempotencyRecord key @id`. |

Migrations: 20 directories under `prisma/migrations` (lock: postgresql). Two share the timestamp `20261008120000` (`academic_structure_faculty_overrides`, `engineering_study_types`). Drift vs. `schema.prisma` is listed in findings F-13.

## 4. Student web call sites


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


## 5. Mobile call sites


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


## 6. Dashboard call sites

### Admin/Teacher Dashboard: Route & API Inventory

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
