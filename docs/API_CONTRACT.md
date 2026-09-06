# API contract

Base URL: `https://<host>/api/v1`
Interactive reference: `GET /api/docs` (Swagger UI), `GET /api/docs-json`.

This document covers the parts a client author needs that Swagger does not
express well: the envelope, the headers, the error codes to branch on, and the
handful of places where this backend and the shipped mobile app had to be
reconciled.

---

## 1. Envelope

### Success

```json
{
  "success": true,
  "data": { },
  "meta": { "requestId": "01JC…" }
}
```

Paginated endpoints put the page under `data`:

```json
{
  "success": true,
  "data": {
    "items": [ ],
    "meta": {
      "page": 1, "pageSize": 20, "total": 137,
      "totalPages": 7, "hasNext": true, "hasPrevious": false
    }
  },
  "meta": { "requestId": "01JC…" }
}
```

### Error — and why it has two shapes

```json
{
  "success": false,
  "error": {
    "code": "ACCESS_EXPIRED",
    "message": "Your access to this course has ended",
    "fields": null,
    "details": { "accessState": "EXPIRED" }
  },

  "statusCode": 403,
  "code": "ACCESS_EXPIRED",
  "message": "Your access to this course has ended",
  "errors": null,
  "requestId": "01JC…",
  "timestamp": "2026-08-21T09:14:02.881Z",
  "path": "/api/v1/courses/abc"
}
```

**The conflict.** The backend specification asks for a nested
`{ success, error: { code, message } }`. The mobile app was built first and its
`toApiError(status, body)` reads `code`, `message`, `errors` and `requestId`
from the **top level** of the body.

**The resolution.** Error bodies carry both. The nested object and the flat
mirror are populated from the same source values in one place
(`src/common/filters/all-exceptions.filter.ts`), so they cannot drift apart.
The cost is a few dozen bytes on error responses only; the benefit is that
neither the spec nor the shipped app had to be broken, and no mobile change is
required to read errors correctly.

If you are writing a new client, prefer the nested `error` object.

### Rules for clients

- **Branch on `code`, never on `message`.** Messages are for humans and get
  reworded.
- An unknown `code` should fall back to a generic message rather than crashing.
- `requestId` is worth surfacing in a support screen; it is the join key into
  the server logs.
- Stack traces never appear in production responses.

---

## 2. Headers

### Sent by the client

| Header | When | Why |
| --- | --- | --- |
| `Authorization: Bearer <access>` | every authenticated request | — |
| `X-Device-Id` | **every** request from the app | device binding; protected content is refused without it |
| `X-Device-Platform` | login and registration | `ios` \| `android` |
| `X-Device-Model`, `X-Device-Name`, `X-Device-Os` | login and registration | shown in the student's device list |
| `X-App-Version`, `X-App-Build` | every request | minimum-version enforcement, diagnostics |
| `X-Device-Integrity` | protected requests | client-reported jailbreak/root/hook signal |
| `Accept-Language: ar` \| `en` | every request | localises notifications and messages |
| `X-Request-Id` | optional | echoed back; use your own correlation id if you have one |
| `Idempotency-Key` | payment initiation | safe retries |

`X-Device-Id` is an opaque value the app generates once and keeps in the
Keychain/Keystore. It is never derived from a hardware identifier, and the
server stores it hashed-by-convention as `Device.deviceKey`.

### Returned

`X-Request-Id` on every response; `Retry-After` on 429.

---

## 3. Authentication

```
POST /auth/register        → { user, tokens, device }
POST /auth/login           → { user, tokens, device }
POST /auth/refresh         → { tokens }
POST /auth/logout          → { ok }
POST /auth/logout-all      → { ok, sessions }
GET  /auth/me              → { user }
GET  /auth/session         → { session, device }
GET  /auth/sessions        → [ { session } ]
POST /auth/password        → { ok }              (change own password)
```

Access tokens last 15 minutes; refresh tokens 30 days and **rotate on every
use**. Presenting a refresh token that has already been exchanged revokes the
entire token family — that is reuse detection, and it means a stolen token
gets both the attacker and the victim signed out, which the victim notices.

Three things are re-checked on **every** authenticated request, not just at
sign-in:

- the session still exists and is `ACTIVE` (covers logout and admin revocation)
- the account is still `ACTIVE` (covers mid-session suspension)
- the token predates no credential change (covers password reset)

So revocation takes effect within one request, not one token lifetime.

**There is no forgot-password flow.** By product decision (spec §13) a student
who forgets their password contacts administration, and a staff member resets
it via `PUT /admin/users/:id/password`. There is no OTP anywhere in the system.

---

## 4. Endpoint map

Paths match the mobile app's `Endpoints` object exactly. Where the app's map
and this backend differ, it is called out.

### Catalogue and profile

```
GET  /catalog/universities                              public
GET  /catalog/universities/:id/faculties                public
GET  /catalog/faculties/:id/departments                 public
GET  /catalog/academic-years                            public

GET   /profile                                          own profile
PATCH /profile                                          update allowed fields
PUT   /profile/avatar                                   presigned upload
```

> **Note.** The app's map lists `POST /profile/password`. The backend exposes
> password change at `POST /auth/password` and keeps `/profile` for profile
> data only. See MOBILE_CHANGES.md.

### Courses

```
GET /home/feed
GET /courses                     ?page&pageSize&q&universityId&facultyId&academicYearId
GET /courses/mine
GET /courses/:id
GET /courses/:id/sections        the dynamic structure, in configured order
GET /courses/:id/progress
GET /courses/:id/attachments
POST /courses/:id/enroll         { method: FREE | PAYMENT | CODE | ADMIN_APPROVAL }
POST /courses/:id/redeem         { code }
```

`GET /courses/:id` includes an `access` object the app renders directly:

```json
{
  "access": {
    "state": "ACTIVE",
    "expiresAt": "2027-02-14T00:00:00.000Z",
    "enrolledAt": "2026-08-18T10:03:11.000Z",
    "availableMethods": ["PAYMENT", "CODE"]
  }
}
```

`state` is one of `NOT_ENROLLED · PENDING_APPROVAL · PENDING_PAYMENT · ACTIVE ·
EXPIRED · REVOKED · ARCHIVED` — the same union the app declares.

**Sections are whatever the course was configured with.** Three sections named
after a midterm, five units, four parts — the client renders the list it
receives and must not assume a count, an ordering convention, or a naming
scheme.

### Lessons and progress

```
GET  /lessons/:id
POST /lessons/:id/complete       manual-completion rules only
POST /progress                   { lessonId, positionSeconds, watchedSeconds }
POST /progress/batch             offline flush, ≤100 lessons
GET  /progress/continue-watching
GET  /progress/lessons/:lessonId
```

Progress percent is **monotonic** — re-watching a finished lesson never lowers
it — and `watchedSeconds` is clamped server-side to 900 per report, so a client
cannot mint watch time.

### Playback

```
POST   /playback/videos/:videoId/ticket     the authorization chain
POST   /playback/tickets/:ticketId/heartbeat
DELETE /playback/tickets/:ticketId          release the concurrency slot
POST   /playback/security-events            client capture/integrity telemetry

GET /playback/manifest/:ticketId/master.m3u8   served to the player
GET /playback/manifest/:ticketId/:height.m3u8
GET /playback/keys/:ticketId                   AES-128 key, live tickets only
GET /playback/tickets/:ticketId/state          edge Worker liveness probe
```

Ticket response:

```json
{
  "ticketId": "tkt_…",
  "manifestUrl": "https://api…/playback/manifest/tkt_…/master.m3u8?…",
  "playbackHeaders": { },
  "drm": { "scheme": "none", "licenseUrl": null, "certificateUrl": null, "licenseHeaders": {} },
  "watermark": {
    "primary": "Youssef Ahmed Mahmoud Salem",
    "secondary": "ID: 4F2A9C11",
    "sessionTag": "K3X9QW7ZP2MN4A6B",
    "opacity": 0.35,
    "moveIntervalSeconds": 7
  },
  "captions": [],
  "expiresAt": "2026-08-21T09:19:02.000Z",
  "ttlSeconds": 300,
  "resumePositionSeconds": 412,
  "streamSessionId": "…",
  "heartbeatIntervalSeconds": 30
}
```

Notes for the player:

- **The watermark text is composed server-side.** The client renders it; it
  does not supply it. That is what preserves the mark's forensic value against
  a patched app.
- **No permanent or direct media URL is ever returned.** No `.mp4`, no bucket
  hostname, no source key. Anything of that shape appearing in a ticket is a
  bug.
- Heartbeats keep the concurrency slot alive and can return
  `{ terminate: { reason } }`, which the player must obey by stopping playback.
- Failing to call `DELETE /playback/tickets/:id` on teardown leaves the slot
  held until the grace period expires, which locks the student out of their own
  next video for up to 90 seconds.

### Attachments

```
GET /attachments/:id/ticket      short-lived signed URL
GET /lessons/:lessonId/attachments
```

### Notifications

```
GET    /notifications                 ?page&pageSize&unread
GET    /notifications/unread-count
POST   /notifications/:id/read
POST   /notifications/read-all
GET    /notifications/preferences
PUT    /notifications/preferences
POST   /notifications/devices         register a push token
DELETE /notifications/devices/:token
```

Notification rows store both languages, so switching the app to Arabic
retranslates existing items. Security and administrative messages ignore
notification preferences — a student must always be told their device binding
changed.

### Search

```
GET /search              ?q&type=course|lesson|teacher&page&pageSize   public
GET /search/suggestions  ?q                                            public
```

### Devices

```
GET  /devices
GET  /devices/current
POST /devices/change-request     { reason }
```

### Meta

```
GET /meta/health         liveness: database only
GET /meta/health/deep    database + Redis + storage
GET /meta/app-config     minimum version, playback params, feature flags
```

`/meta/health` deliberately checks only the database. A liveness probe that
fails on a Redis blip causes a restart loop, turning a partial outage into a
total one. Use `/meta/health/deep` for monitoring, not for orchestration.

### Staff

```
GET/POST/PATCH  /admin/users …            master, admin
PUT             /admin/users/:id/password  password reset on a student's behalf
GET/POST/PATCH  /admin/courses …           master, admin, assigned teachers
POST            /admin/courses/:id/price   append a new price version
GET             /admin/courses/:id/price-history
POST            /admin/courses/:id/publish | /unpublish | /archive | /restore
POST            /admin/courses/:id/teachers
GET/POST        /admin/codes …
GET             /admin/payments            POST …/:id/confirm | /:id/refund
GET/POST        /admin/enrollments …
GET             /analytics/overview | /courses/:id | /revenue | /teachers/:id/earnings
GET             /audit
GET             /sessions/active | /sessions/users/:id      DELETE /sessions/:id
GET             /master/overview | /master/settings         POST /master/sessions/revoke-all
```

---

## 5. Error codes

Grouped by what a client should *do*, which is more useful than grouping by
HTTP status.

### Retry may help

| Code | Status | Meaning |
| --- | --- | --- |
| `RATE_LIMITED` | 429 | Back off; honour `Retry-After` |
| `MAINTENANCE` | 503 | Show the maintenance screen |
| `SERVER_ERROR` | 500 | Retry once, then surface |

### Re-authenticate

| Code | Status | Meaning |
| --- | --- | --- |
| `UNAUTHORIZED` | 401 | Missing or malformed token |
| `SESSION_EXPIRED` | 401 | Refresh, then retry once |
| `INVALID_CREDENTIALS` | 401 | Wrong phone or password |

Only these three ever return 401, precisely so the app's "refresh once, then
sign out" interceptor cannot be triggered by a problem a new token would not
fix.

### Account state

| Code | Status |
| --- | --- |
| `ACCOUNT_DISABLED` | 403 |
| `ACCOUNT_PENDING` | 403 |
| `PHONE_ALREADY_REGISTERED` | 409 |

### Device — recoverable in-app, never a sign-out

| Code | Status | The screen to show |
| --- | --- | --- |
| `DEVICE_NOT_AUTHORIZED` | 403 | "Request a device change" |
| `DEVICE_CHANGE_PENDING` | 403 | "Your request is being reviewed" |
| `DEVICE_LIMIT_REACHED` | 403 | Device list with a change option |
| `DEVICE_INTEGRITY_FAILED` | 403 | "This device cannot play protected content" |

### Access

| Code | Status |
| --- | --- |
| `NOT_ENROLLED` | 403 |
| `ACCESS_EXPIRED` | 403 |
| `ENROLLMENT_PENDING` | 403 |
| `PAYMENT_REQUIRED` | 402 |
| `COURSE_ARCHIVED` | 403 |
| `COURSE_NOT_AVAILABLE` | 403 |
| `ALREADY_ENROLLED` | 409 |

### Codes and payment

| Code | Status |
| --- | --- |
| `INVALID_CODE` | 400 |
| `CODE_ALREADY_USED` | 409 |
| `PAYMENT_FAILED` | 402 |

### Playback

| Code | Status | Meaning |
| --- | --- | --- |
| `VIDEO_NOT_READY` | 409 | Still transcoding — poll `/videos/:id/status` |
| `VIDEO_UNAVAILABLE` | 404 | Missing, failed or withdrawn |
| `PLAYBACK_DENIED` | 403 | Chain refused for a reason not covered above |
| `PLAYBACK_TICKET_EXPIRED` | 410 | Request a new ticket |
| `CONCURRENT_STREAM_LIMIT` | 409 | Already streaming elsewhere |
| `CAPTURE_DETECTED` | 403 | This playback session was ended |

### Authorization

`FORBIDDEN` · `INSUFFICIENT_ROLE` · `NOT_COURSE_TEACHER` · `CANNOT_MODIFY_MASTER` — all 403.

### Validation

`VALIDATION_ERROR` (422) carries per-field messages:

```json
{
  "code": "VALIDATION_ERROR",
  "message": "Request validation failed",
  "errors": { "phone": ["must be a valid Egyptian mobile number"] },
  "error": { "code": "VALIDATION_ERROR", "fields": { "phone": ["…"] } }
}
```

Apply `errors` (or `error.fields`) directly onto form fields; the keys are the
DTO property paths.

---

## 6. Pagination

`?page=1&pageSize=20`. `pageSize` is hard-capped at 100 server-side — a client
asking for 10 000 receives 100, not an error. Offset pagination is used
throughout; the datasets are administrative and bounded, and keyset pagination
would complicate the sort options for no measurable gain at this scale.

---

## 7. Localisation

Send `Accept-Language: ar` or `en`.

The backend returns both variants where a row stores both (`title` /
`titleAr`), so the app can switch language without refetching, and localises
generated strings — notification titles, some messages — by the header. Error
`message` values are English developer strings; the app maps `code` to its own
translated copy rather than displaying `message` directly.

The API is direction-agnostic. RTL is entirely a client concern.

---

## 8. Rate limits

| Endpoint group | Limit |
| --- | --- |
| Default | 120 requests / 60 s |
| `/auth/login`, `/auth/register`, `/auth/refresh` | 10 / 60 s |
| `/courses/:id/redeem`, `/codes/validate` | 10 / 60 s |
| `POST /playback/videos/:id/ticket` | 60 / hour per student |

Authenticated requests are bucketed by user id, anonymous ones by IP, and
credential endpoints additionally by the submitted phone — so one attacker
behind a NAT cannot exhaust the limit for everyone else on that address, and
password spraying across many accounts still trips it.

---

## 9. Compatibility notes

Recorded here so a client author does not rediscover them.

1. **Both error shapes are emitted.** Documented in §1. Do not remove the flat
   mirror while the current mobile build is in the field.
2. **`/profile/password` vs `/auth/password`.** Password change lives under
   `/auth`. The app's endpoint map needs a one-line change.
3. **Video ids are real ids.** The app's player route currently derives a video
   id by stripping a `v-` prefix from a mock identifier. Real ids come from the
   lesson payload's `video.id`.
4. **`DELETE /playback/tickets/:id` is not optional.** It releases the
   concurrency slot.
5. **`X-Device-Id` on every request.** Not only on login. Protected content is
   refused without it, and the refusal is recorded as a security event.
