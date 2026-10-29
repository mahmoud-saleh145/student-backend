# Student Center backend — findings

Scope: `backend` snapshot (one commit, `ee00985`, which folds in uncommitted work). Every finding below was traced in source. "CONFIRMED" = the failing code path was read end to end. "SUSPECTED" = the risk is real in code but depends on something outside the repo (deployment, provider behaviour); the evidence that would settle it is stated. `docs/` was not treated as truth. `docs/cloudflare-worker.js` was treated as source because `wrangler.toml` deploys it (`main =` points at it).

Severity scale: critical = remote, low-effort entitlement or money loss; high = security control defeated or wide outage; medium = real defect with preconditions or limited blast radius; low = hygiene, contract, or defence in depth.

## Summary

| ID | Sev | Category | Title | Status |
|---|---|---|---|---|
| F-01 | high | authz / playback | Heartbeat rotation mints fresh DRM tickets with no device, session, section, concurrency or expiry checks | CONFIRMED |
| F-02 | critical | entitlement | Redeeming any section or part code can grant the whole course (`coversAllSections` defaults to true and is inherited) | CONFIRMED |
| F-03 | high | config / reliability | Rate-limit key is the client-supplied first `X-Forwarded-For` entry, and per-user keys never apply | CONFIRMED |
| F-04 | high | secrets | Cloudinary credentials committed in the tracked `.env.example` | CONFIRMED |
| F-05 | medium | data integrity | A captured payment does not restore full-course scope, so a paying student can end up with partial or no access | CONFIRMED |
| F-06 | medium | authz | The teacher "view students" capability (on by default) lets a teacher grant or extend access, bypassing payment | CONFIRMED |
| F-07 | medium | reliability / payments | Webhook failures are acknowledged and deduplicated, capture ignores amount and currency, and the Paymob checkout URL is a placeholder | CONFIRMED |
| F-08 | medium | authz / device binding | Device binding trusts the `X-Device-Id` header, never compares it with `Session.deviceId`, and first-device auto-bind races | CONFIRMED |
| F-09 | medium | authz / media | A caption `objectKey` is arbitrary text, then signed for viewers (an arbitrary R2 object read primitive) | CONFIRMED |
| F-10 | medium | media | The edge ticket-liveness check fails open | CONFIRMED |
| F-11 | medium | contract | `publicAssetUrl` returns unsigned CDN URLs that the Worker always rejects with 403 | CONFIRMED (repo); deployed Worker not checked |
| F-12 | low-med | session | Refresh rotation is not compare-and-set, so concurrent refreshes fork the token chain | CONFIRMED |
| F-13 | low | migration | Drift between migrations and `schema.prisma`: unmanaged indexes, partial indexes, a trigger, and a duplicate timestamp | CONFIRMED |
| F-14 | low | info leak | Public `GET /courses/:id/sections` and `/attachments` ignore course and lesson status | CONFIRMED |
| F-15 | low | authz | Streaming and presign upload endpoints skip the course-ownership check | CONFIRMED |
| F-16 | low | authz | A teacher with only the `content` capability can change commercial terms (enrollment methods, access duration) | CONFIRMED |
| F-17 | low | auth | Anyone can lock out an account by phone number, and the failure counter loses updates under concurrency | CONFIRMED |
| F-18 | low | contract | Password change revokes the caller's own session, contrary to the API description | CONFIRMED |
| F-19 | low | data hygiene | Attachment delete removes the object from the wrong bucket | CONFIRMED |

---

## F-01 (high) Heartbeat rotation bypasses every playback issuance control

**Category:** authz, IDOR-adjacent, playback bypass. **Status:** CONFIRMED.

**Code path:** `POST /api/v1/playback/tickets/:ticketId/heartbeat` (playback.controller.ts:162) calls `PlaybackService.heartbeat` (src/modules/playback/playback.service.ts:1076-1257).
- L1088-1099: the ticket is loaded by `{ id, userId }` only. There is no check of `ticket.sessionId === user.sessionId`, of `ticket.deviceId` against the caller's device, or of `expiresAt`.
- L1103-1113: only `REVOKED` and `RELEASED` are rejected. An `EXPIRED` ticket falls through. Tickets become EXPIRED through `expireLapsedTickets` (L1712-1721) and through `reclaimStaleSlots` (L1728-1751).
- L1153-1163: the re-check is `access.resolve(...)`, which is course-level only.
- L1217-1251: when `remainingMs < 2*heartbeatInterval` (always true for an expired ticket) the service calls `mintTicket(...)`. That returns a new ACTIVE ticket with fresh Gumlet `manifestUrl`, `drm.licenseUrl` (signed, not bound to the device) and signed caption URLs.

`issueTicket` enforces controls that this path never re-runs:
- `enforceIssuanceRate` (L201)
- `authorizeLessonForPlayback`: publish state, section scope, and `unlocksAt` (L726-779)
- `devices.assertAuthorizedForProtectedContent` (L362)
- `acquireStreamSlot`, the concurrent-stream limit (L372)
- `claimPlay`, the play-count limit (L379)

**Failure scenarios:**
1. **Device-binding bypass via account sharing.** Student A plays on the bound phone and shares the `ticketId` (it is in the response body and in signed URLs as `tid`) with friend B, who is logged into the same account on an unbound device. Login is never blocked by device state. B calls heartbeat every ~30s and receives rotated tickets with working DRM license and manifest URLs. The device check and the one-stream limit never run: `touchStreamSlot` simply adds B's session to the slot set.
2. **Section-scope revocation is ignored.** A student whose access is limited to some sections (part or section code), or whose section grant was removed, keeps rotating tickets for an out-of-scope lesson, because L1153 checks course access only.
3. **Device revoked or binding reset.** Tickets that were already EXPIRED when the admin acted are not touched (revocation only updates `status: ACTIVE`). The student logs in on a pending device and heartbeats an old expired ticket. The minted ticket inherits `ticket.deviceId` of the revoked device (L1242). With Gumlet delivery the manifest service is not involved, so nothing re-checks the device.

**Fix direction:** in heartbeat, require `status === ACTIVE && expiresAt > now`, `ticket.sessionId === user.sessionId`, and a current `assertAuthorizedForProtectedContent`. Re-run `authorizeLessonForPlayback` before rotating, or move rotation behind `issueTicket`.

## F-02 (critical) Section or part codes escalate to full-course access

**Category:** entitlement state transition. **Status:** CONFIRMED.

**Code path:**
- `Enrollment.coversAllSections Boolean @default(true)` (prisma/schema.prisma:1691, and migration `20260907120000_dashboard_admin` L142 `DEFAULT true`).
- `joinWithPayment` (enrollments.service.ts:180-194) and `joinWithApproval` (L235-249) upsert a `PENDING_PAYMENT` or `PENDING_APPROVAL` row without touching `coversAllSections`. A new row is therefore `true`.
- `expireLapsedEnrollments` (L1083-1090) moves ACTIVE to EXPIRED and keeps `coversAllSections=true`.
- `redeemCode` (L294-311) refuses only when `current.state === 'ACTIVE'` and the scope is already full. PENDING_* and EXPIRED pass.
- `grantAccess` (L518-527): `coversAllSections = scope === null || (existing?.coversAllSections ?? false) ? true : false`. A scoped code (`resolveRedemptionScope` returns `sectionIds` for SECTION, PART, and snapshot COURSE codes, codes.service.ts:1379-1427) inherits `true` from the existing row. The row is then set ACTIVE with full coverage.
- `allowedSectionIds` (course-access.service.ts:809) returns `null` (meaning all sections) when `coversAllSections` is true.

**Failure scenario:** a course offers `CODE` plus `ADMIN_APPROVAL` or `PAYMENT`. `join()` does not check whether an online provider is configured, so PAYMENT works through the API even when the UI hides it.
1. The student calls `POST /api/v1/courses/:id/enroll {method:"ADMIN_APPROVAL"}`, creating PENDING_APPROVAL with `coversAllSections=true`.
2. The student redeems the cheapest part or section card with `POST /api/v1/courses/:id/redeem`.
3. The enrollment becomes ACTIVE with `coversAllSections=true`. Lessons, attachments and playback for every section are unlocked.

The same happens with no extra step for any student whose earlier full-course enrollment simply expired.

**Fix direction:** compute coverage only from *current* entitlement: `existing.state === ACTIVE && !lapsed && existing.coversAllSections`. Create pending rows with `coversAllSections=false`, and reset it on expiry.

## F-03 (high) Throttler tracker is client-controlled; per-user limits never apply

**Category:** config, rate limiting, reliability. **Status:** CONFIRMED.

**Code path:** `ThrottlerProxyGuard.getTracker` (src/common/guards/throttler-proxy.guard.ts:16-29):
- L16 returns `user:<id>` only if `req.user` is set. But the guard is the first `APP_GUARD` (app.module.ts:194) and `JwtAuthGuard` (L195) is what sets `req.user`, so this branch is dead.
- L18-19 then uses `req.header('x-forwarded-for').split(',')[0]`. That is the left-most, client-supplied value: proxies append to the header, they do not replace it. It is read regardless of `TRUST_PROXY`.

**Failure scenarios:**
1. **Bypass.** An attacker sends a random `X-Forwarded-For` (and a rotating `phone` for login) on each request. `@CredentialThrottle` (10/min on login, register, password), `@CodeThrottle` and the global 120/min limit no longer apply. Password spraying across accounts is unbounded; only the per-account lockout remains (see F-17).
2. **Shared-NAT outage.** Legitimate clients do not send XFF, so the real client IP is the key for all authenticated traffic. A whole school or carrier CGNAT shares one bucket per route: 120 requests/min globally and `PLAYBACK_TICKETS_PER_HOUR`=60 tickets per hour for `POST /playback/videos/:id/ticket` (throttle.decorator.ts:70-75). Students start receiving 429s at peak.

**Fix direction:** authenticate before throttling (or decode the JWT `sub` inside `getTracker`). Use `req.ip` with `trust proxy` set to the actual hop count, never the raw header.

## F-04 (high) Real-looking Cloudinary credentials committed

**Category:** secrets. **Status:** CONFIRMED that the file is tracked (`git ls-files` lists `.env.example`) and that the values are non-placeholder. Whether they are live was not tested; no network access was used.

- **Path:** `edu-backend/.env.example`, lines 126-128.
- **Keys:** `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY` (15-digit numeric), `CLOUDINARY_API_SECRET` (27-character mixed-case token). The adjacent comment reads "Never commit the secret".
- The values appear in no other tracked file.
- All JWT, `MEDIA_SIGNING_KEY` and `HLS_KEY_ROOT` values in the file are `CHANGE_ME` placeholders. The Neon DB URLs in the runbooks use `<user>:<password>` placeholders.

**Impact:** anyone with repository read access can upload to, overwrite or delete the course-image store (`cloudinary.service.ts` writes course thumbnails).

**Action:** rotate the key in Cloudinary, replace it with placeholders, and purge it from history if the repository is shared.

## F-05 (medium) Payment capture does not restore full-course scope

**Category:** data integrity, entitlement. **Status:** CONFIRMED.

**Code path:** `PaymentsService.capture` (src/modules/payments/payments.service.ts:308-319) updates the enrollment to `state: ACTIVE` and dates only. It does not set `coversAllSections: true` or remove section grants.

**Failure scenarios:**
1. A student had a part-only code (`coversAllSections=false`) that expired. They pay full price: `join(PAYMENT)`, then capture. The enrollment becomes ACTIVE but still limited to the old part's sections.
2. After an admin revoke (`revoke-enrollment.ts:120-134` sets `coversAllSections=false` and deletes grants), the student re-buys with PAYMENT. Capture leaves an ACTIVE enrollment that covers zero sections. The student paid and gets nothing.

**Fix direction:** set `coversAllSections: true` in capture, or route capture through `grantAccess` with `sectionScope: null`.

## F-06 (medium) The `students` (view) capability grants write power over access

**Category:** authz. **Status:** CONFIRMED behaviour; product intent unknown.

**Code path:**
- `POST /api/v1/admin/enrollments/grant` and `/admin/enrollments/:id/extend` are `@StaffOnly` (enrollments.controller.ts:164-165, 204-205).
- The services check `assertCanManageCourse(..., 'students')` (enrollments.service.ts:849, 1042). That maps to `CourseTeacher.canViewStudents`, which defaults to `true` (schema.prisma:1289).
- `grantByAdmin` grants ACTIVE full access (scope null) to any `userId` for up to 3650 days.
- `extend` sets `state: ACTIVE` on any enrollment (L1051-1058), including PENDING_PAYMENT and PENDING_APPROVAL rows, which have `coversAllSections=true` (see F-02).
- No `assertTeacherCapability` gate (platform setting) is applied.

**Failure scenario:** any assigned teacher can give free full access to anyone, or "extend" a pending-payment request into an active enrollment. Payment and the platform's revenue share are bypassed with no admin involvement. Only an audit row records it.

**Fix direction:** gate these routes on a dedicated write capability, or make them admin-only (as `revoke` already is, L999-1003).

## F-07 (medium) Payment webhook and capture are not production-safe

**Category:** reliability, payments. **Status:** CONFIRMED.

1. **Failures are swallowed and deduplicated.** In `payment-webhook.service.ts:106-120` (Paymob) and L171-187 (Stripe), any exception from `capture`/`fail` is only logged. `markProcessed(fingerprint, 'captured')` still runs and the provider receives 200. A transient DB error (serializable retry exhausted, timeout) therefore permanently loses the capture: provider retries are acknowledged as `deduplicated` (L87-89). The student paid; the enrollment stays PENDING_PAYMENT.
2. **No amount or currency check.** `capture` (payments.service.ts:227-361) marks PAID and books revenue from `payment.amount`. It never compares `amount_cents`/`currency` from the signed webhook, so an authorised but under-paid transaction carrying the merchant order id would unlock the course. SUSPECTED exploitability: it depends on how orders and `merchant_order_id` are created at Paymob, and order creation is not implemented here.
3. **Placeholder checkout.** `buildCheckoutUrl` returns `.../iframes/<id>?payment_token=PENDING_<paymentId>` (L203) for Paymob, and `null` for Stripe (L210). There is no real order or payment-key API call, so `PAYMENT_PROVIDER=paymob` yields a non-functional checkout. `PAYMENT_PROVIDER` is only `@IsString()` (env.validation.ts:278); any typo silently becomes MANUAL.

**Fix direction:** only `markProcessed` after a successful capture, and return non-2xx otherwise. Verify amount and currency. Implement provider order creation before enabling a provider.

## F-08 (medium) Device binding is an unauthenticated header

**Category:** authz, device binding. **Status:** CONFIRMED.

**Code path:**
- `assertAuthorizedForProtectedContent` (src/modules/devices/devices.service.ts:265-337) authorises by `(userId, deviceKey)` where `deviceKey` is the raw `X-Device-Id` request header (request-context.middleware.ts:50, copied into the principal at jwt-auth.guard.ts:167).
- The session's `deviceId`, bound at login (auth.service.ts:295-305), is never compared. Any session of the account that sends the bound device's id string passes. The string is visible to anyone who can see the bound device's traffic, and `GET /devices` returns device ids, not keys.
- **Race:** `handleUnknownDevice` (L180-200) counts ACTIVE devices, then creates. Two concurrent first logins with different keys both auto-bind ACTIVE, exceeding `DEVICE_LIMIT_PER_STUDENT`.

**Failure scenario:** account sharing defeats binding by copying one header value. Combined with F-01, sharing the ticket id is not even necessary.

**Fix direction:** for students, require `principal.deviceId` (from the session) and match it against an ACTIVE device. Treat the header only as a hint at login. Do the device count and create in a serializable transaction.

## F-09 (medium) Caption `objectKey` can point at any object, then gets signed

**Category:** authz, media access. **Status:** CONFIRMED (missing validation). Exploitation needs knowledge of a target key.

**Code path:**
- `POST /api/v1/videos/:videoId/captions` (`AddCaptionDto.objectKey: @IsString @MaxLength(400)`) reaches `VideosService.addCaption` (videos.service.ts:1279-1311). It stores `input.objectKey` with no `assertObjectKeyInNamespace`; compare attachments, which call `assertObjectKeyInNamespace` (attachments.service.ts:295).
- On every ticket, `mintTicket` signs each caption key for the viewer (playback.service.ts:633-647).
- The Worker serves any signed key, and picks the LIBRARY bucket for `library/*` (cloudflare-worker.js:170).

**Failure scenario:** a teacher with `content` capability on any course sets a caption key to another course's `attachments/<courseId>/<uuid>.pdf`, to a paid `library/<uuid>.pdf`, or to deterministic keys like `thumbnails/videos/<id>.jpg` or `hls/<id>/...`. They then request a ticket for their own lesson (staff can) and receive a signed URL for that object.

**Fix direction:** require `captions/<videoId>/` and verify the object exists.

## F-10 (medium) Edge ticket-liveness check fails open

**Category:** media access. **Status:** CONFIRMED (Worker source).

**Code path:** `docs/cloudflare-worker.js`:
- `ticketIsLive`: L328-336 `catch { return true; }` on network error or the 2s timeout.
- L339: any non-OK status other than 403 and 404 (500, 502, 429 from the API's own throttler in F-03, 503) is treated as live.
- Positive results are cached 10s.

**Failure scenario:** while the API is slow, down, or rate-limiting the Worker's IP, revoked or released tickets, revoked library entitlements, and revoked attachments keep streaming until each signed URL's `exp` (`PLAYBACK_TICKET_TTL`, default 300s, up to 3600). The Worker's probe is also subject to F-03, since every probe comes from Cloudflare egress IPs.

**Fix direction:** fail closed for non-preview content, or at least on 5xx and 429. Exempt the probe route from throttling.

## F-11 (medium) Unsigned "public" asset URLs are always rejected by the Worker

**Category:** contract. **Status:** CONFIRMED in repo code. Production effect: SUSPECTED until checked against the deployed Worker (a `curl -I` on a returned `thumbnailUrl` would confirm the 403).

**Code path:**
- `StorageService.publicAssetUrl` (storage.service.ts:697-717): when `MEDIA_CDN_BASE_URL` is set (mandatory in production, env.validation.ts:463-468) it returns `new URL(objectKey, cdnBaseUrl)` with **no signature**.
- The Worker denies every request without `sig/exp/uid` (cloudflare-worker.js:127, `x-deny-reason: unsigned`). `wrangler.toml` comments record exactly this 403 being observed.
- **Callers:** course-part thumbnails (course-parts.service.ts:136, 284), library covers and part/default thumbnails (library.service.ts:88, 162, 278, 459, 465), and course thumbnails whenever they are not Cloudinary keys (courses.service.ts:244, 375; search.service.ts:155; progress.service.ts:470). All of these are uploaded to the R2 `media` bucket (storage.controller.ts presign and content routes).

**Failure scenario:** every R2-hosted thumbnail and cover renders as a broken image in production.

## F-12 (low-medium) Refresh rotation is not compare-and-set

**Category:** session, race. **Status:** CONFIRMED.

**Code path:** auth.service.ts:371-511.
- The token row is read outside the transaction (L371).
- Inside the transaction the old row is updated by `id` only (L485-488 `update({ where: { id: stored.id }, data: { usedAt, replacedById } })`), not `where usedAt IS NULL`, under default READ COMMITTED isolation.
- Two concurrent refreshes with the same token both pass the `usedAt` check, both create successors, and both commit. That leaves two live chains in one family; the second `replacedById` overwrites the first.
- Separately, by design, a replay within the 30s grace window (`reissueFromSuccessor`, L541-640) mints a third parallel token without revoking anything. A stolen refresh token used within 30s of the victim's own use is therefore never detected.

**Fix direction:** use `updateMany({ where: { id, usedAt: null } })` and treat `count === 0` as reuse. In the grace path, return the existing successor rather than minting a new one.

## F-13 (low) Migrations vs `schema.prisma` drift

**Category:** migration. **Status:** CONFIRMED by a statement-level comparison of all 20 `migration.sql` files against the schema (tables, columns, nullability, unique and regular indexes, enums). Tables, columns and enums match. Differences:
- `20261012090000_strict_drm_playback/migration.sql:38-39` creates `videos_drmVerifiedAt_idx` and `videos_drmProvider_drmVerifiedAt_idx`. `model Video` declares neither (only `[courseId,status]`, `[status,createdAt]`). The next `prisma migrate dev`/`migrate diff` will emit `DROP INDEX` for both, silently removing the DRM-sweep indexes.
- `20261007120000_allow_multiple_platform_academic_structures` L41-47 replaces the unique `scopeKey` with a partial unique (`WHERE scopeKey <> 'platform'`) plus a plain index. `20261009000000_academic_system_default_and_college_override` L159-161 adds the partial index `faculties_academicSystemOverride_idx` and a trigger (L194-229). None of these are representable in `schema.prisma`, so drift detection will keep proposing to drop or recreate them. They need a documented `--create-only` workflow.
- Two migrations share the timestamp `20261008120000` (`academic_structure_faculty_overrides`, `engineering_study_types`). They currently apply in name order and are independent, but this is fragile.
- `20261008120000_engineering_study_types` wraps itself in an explicit `BEGIN;…COMMIT;`, inconsistent with the others (Prisma does not wrap Postgres migrations itself).

## F-14 (low) Public course endpoints leak unpublished structure

**Category:** info leak. **Status:** CONFIRMED.

- `GET /api/v1/courses/:courseId/sections` (`@Public`): `CoursesService.sections` (courses.service.ts:397-437) has no course-status check. `detail()` blocks DRAFT, HIDDEN and SUSPENDED for non-staff at L284-290, but this route does not. Anonymous callers get section and lesson titles, durations and video ids of DRAFT or HIDDEN courses.
- `GET /api/v1/courses/:courseId/attachments` (`@Public`): `attachments()` (L501-510) lists every non-deleted attachment, including those under unpublished lessons or sections, of any course in any status (metadata only; `locked` flag set).
- Any TEACHER (not just one assigned to the course) gets `includeUnpublished` sections in `detail()` (L280, L300-302).

## F-15 (low) Upload endpoints without a course-ownership check

**Category:** authz. **Status:** CONFIRMED.

- `POST /api/v1/storage/uploads/attachment/content` (storage.controller.ts:538-570) streams into `attachments/<query.courseId>/…` with no `assertCourseExistsAndManageable`. The presign variant (L265-300) does check.
- `uploads/course-part-thumbnail` presign (L218-233) and `/content` (L458-484) have the same gap.

Keys are random UUIDs and the attach/update paths re-validate the namespace against the actor's own course, so there is no overwrite and no attach. The impact is unbounded storage writes (up to the per-request max) into other courses' prefixes, by any teacher.

## F-16 (low) `content` capability can change commercial terms

**Category:** authz. **Status:** CONFIRMED.

`PATCH /api/v1/admin/courses/:id` checks `assertCanManageCourse(..., 'content')` (courses.admin.service.ts:481). It then writes `enrollmentMethods`, `accessDurationType`, `accessDurationDays` and `accessEndsAt` (L544-547). Price changes require `pricing` (L667-668), but a content-only teacher can switch FIXED_DAYS to LIFETIME or add `ADMIN_APPROVAL`/`CODE` methods.

## F-17 (low) Account lockout DoS and lost-update counter

**Category:** auth. **Status:** CONFIRMED.

- `registerFailedAttempt` (auth.service.ts:241-264) locks any account for 10 minutes after 20 failures (configuration.ts:63-64). The account is keyed by phone number, and anyone may submit attempts. With F-03, IP limits do not slow an attacker, so known students can be locked out repeatedly.
- The counter is read (L162-173) and then written as an absolute `next` value. Concurrent bad attempts overwrite each other, so more than 20 guesses fit in a window.

## F-18 (low) Password change logs out the caller

**Category:** contract. **Status:** CONFIRMED.

The API description says "Every other session is revoked" (auth.controller.ts:139). `changePassword` revokes *all* sessions, including the current one (auth.service.ts:846-853), and bumps `credentialsChangedAt`, so the caller's tokens die immediately. Playback tickets are not revoked on password change (unlike logout-all).

## F-19 (low) Attachment delete targets the wrong bucket

**Category:** data hygiene. **Status:** CONFIRMED.

`AttachmentsService.remove` calls `storage.deleteObject('uploads', attachment.objectKey)` (attachments.service.ts:437-439). Attachments are written to and read from the `media` bucket (storage.controller.ts attachment presign and content use `bucket: 'media'`; attachments.service.ts:310 checks size in `media`). Deleted attachments' bytes are never removed, and the call's failure is swallowed.

---

## Lower-confidence / hygiene notes (not counted above)

- **CORS rejection becomes an error, not a missing header.** `main.ts:68` calls `callback(new Error(...))`. With the `cors` middleware this goes to `next(err)` and very likely produces a 500 for disallowed origins rather than a clean CORS failure. SUSPECTED: confirm by a request with a foreign `Origin` against a running instance. No cookies are used, so there is no CSRF exposure. `credentials: true` is harmless but unnecessary.
- **Public deep health.** `GET /api/v1/meta/health/deep` is `@Public` (health.controller.ts:74). It exposes worker heartbeat, per-status video counts, DRM sweep results, and `env`.
- **Free-text avatar.** `PUT /api/v1/profile/avatar` stores any ≤500-character string (`users.service.ts:373-375`). There is no URL scheme or `avatars/<userId>/` namespace check.
- **Library previews of hidden parts.** `LibraryDocumentsService.issueTicket` (library-documents.service.ts:106-121) blocks only ARCHIVED or deleted. DRAFT, HIDDEN or `isActive=false` parts flagged `isPreview` are openable by any student.
- **Untyped body.** `PUT /api/v1/catalog/faculties/:id/academic-system-override` uses an inline body type (catalog.controller.ts:419-430), so `ValidationPipe` skips it (admin-only; bad values surface as Prisma 422).
- **Staging skips production guards.** `NODE_ENV=staging` skips all production secret, CORS and CDN guards in `validateEnv` (env.validation.ts:419); those run only for `production`.
- **Course codes are frozen to a section snapshot.** `resolveRedemptionScope` gives COURSE codes `grantedSectionIds` captured at generation (codes.service.ts:1423-1426). Students who redeem a course code do not get sections added later. This may be intended; it contradicts "course" semantics.
- **Wallet, refunds and code redemption looked sound.** All run under SERIALIZABLE with retry (`MONEY_TX_OPTIONS`), use unique `(codeId,userId)` redemption rows, an atomic conditional debit (`wallet.service.ts:243-251`), and idempotency keys. No double-spend path was found.
