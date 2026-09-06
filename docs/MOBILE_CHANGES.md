# REACT NATIVE CHANGES REQUIRED

**None of these are implemented.** The mobile project was not modified while
building the backend, as instructed. This is a report.

Every item names the file, what changes, why, and which backend endpoint or
type it relates to.

The headline is that the list is short. The backend was built to match the
shipped app rather than the other way round — the error envelope carries the
flat fields the app already parses, `/auth/login` returns exactly the
`{ user, accessToken, refreshToken, expiresIn }` shape its `AuthResponse` type
declares, every path in `src/api/endpoints.ts` exists on the server with two
exceptions noted below, and the heartbeat, release and batch-progress payloads
already match their DTOs field for field.

---

## REQUIRED

Without these, the app does not work against the real backend.

---

### R1 — Turn off the mock layer and point at the real API

**File:** `.env` / EAS build profiles (`eas.json`), read by `src/config/env.ts`

**Change:**

```bash
EXPO_PUBLIC_USE_MOCKS=false
EXPO_PUBLIC_API_URL=https://api.yourdomain.com/api/v1
```

**Why:** `src/config/env.ts` defaults `useMocks` to `'true'` and `apiUrl` to
`http://10.0.2.2:3000/api/v1` (the Android emulator's host loopback). Both
defaults are correct for development and wrong for anything else. The mock
layer intercepts before the network, so a build with mocks left on will look
like it works and never touch the server.

**Relates to:** the whole API.

**Watch for:** the base URL must include `/api/v1`. The backend sets a global
prefix and URI versioning, so `https://api.example.com/courses` is a 404 while
`https://api.example.com/api/v1/courses` is correct.

---

### R2 — Stop deriving the lesson id from the video id

**Files:** `src/app/player/[videoId].tsx`, and the navigation call in
`src/app/lesson/[lessonId].tsx`

**Current code:**

```ts
// player/[videoId].tsx
const lessonId = React.useMemo(() => videoId?.replace(/^v-/, '') ?? '', [videoId]);
const lessonQuery = useLesson(lessonId);
…
router.replace(`/player/v-${lesson.nextLessonId}`);
```

**Why it must change:** `v-<lessonId>` is an artefact of the mock layer, where
video ids were synthesised from lesson ids. Real ids are independent cuids —
a video id has no relationship to its lesson's id, so the `replace` produces a
lesson id that does not exist and every player screen 404s.

There is also an existing internal inconsistency: `lesson/[lessonId].tsx`
already navigates with `router.push('/player/' + video.id)` — a *real* video id
— while the player route expects the `v-` form. Only the mock made both work.

**What to change:** the backend added an endpoint specifically for this route,
because the player is entered with a video id but needs the lesson title,
completion rule and next-lesson pointer:

```
GET /lessons/by-video/:videoId
```

So:

```ts
const { videoId } = useLocalSearchParams<{ videoId: string }>();
const lessonQuery = useLessonByVideo(videoId);     // new hook, wraps the endpoint
const lesson = lessonQuery.data;
```

and for the next-lesson navigation, use the video id the payload carries rather
than reconstructing one:

```ts
router.replace(`/player/${lesson.nextVideoId}`);
```

**Also add to `src/api/endpoints.ts`:**

```ts
lessons: {
  detail: (id: string) => `/lessons/${id}`,
  byVideo: (videoId: string) => `/lessons/by-video/${videoId}`,   // new
  complete: (id: string) => `/lessons/${id}/complete`,
},
```

**Relates to:** `LessonsController.byVideo` → `LessonsService.byVideoId`.

---

### R3 — Move the change-password call to `/auth/password`

**File:** `src/api/endpoints.ts`

**Current:**

```ts
profile: {
  …
  changePassword: '/profile/password',
},
```

**Change to:**

```ts
auth: {
  …
  changePassword: '/auth/password',
},
```

**Why:** the backend keeps credential operations under `/auth` and `/profile`
for profile data only, so that everything touching a password sits behind one
set of rate limits and one audit category. `POST /profile/password` returns
404.

**Relates to:** `AuthController.changePassword` (`POST /auth/password`), body
`{ currentPassword, newPassword }`.

---

### R4 — Send `X-Device-Id` on every request, not only at login

**File:** `src/api/client.ts` — already correct; **verify** rather than change

The request interceptor already spreads `deviceHeaders()` onto every request,
which is exactly right. This entry exists so that a future refactor does not
narrow it to the auth calls.

**Why it matters:** the backend refuses protected content when the header is
absent and records a `DEVICE_MISMATCH` security event. A student would see
"this device is not authorised" on a device that *is* authorised, and the
security log would fill with false positives.

**Relates to:** `DevicesService.assertAuthorizedForProtectedContent`.

**One real check needed:** `src/services/device.ts` sends
`'X-Device-Name': encodeURIComponent(d.name)`. That is correct for a name
containing non-ASCII characters (an Arabic device name would otherwise make the
header invalid), but the backend stores the value verbatim, so device names
will display percent-encoded in the student's device list. Either decode
server-side or send an ASCII-safe fallback — trivial either way, but pick one.

---

### R5 — Handle `DEVICE_CHANGE_PENDING` as its own state

**Files:** `src/api/errors.ts` (the `ApiErrorCode` union),
`src/app/settings/devices.tsx`

**Why:** the backend distinguishes "this device is not authorised" from "you
have already asked us to change it and we are reviewing the request". If the
app collapses both into one screen, a student who has already submitted a
request sees the same "request a device change" button and submits again —
which the backend rejects as a duplicate, producing a confusing error.

**Relates to:** `ErrorCode.DEVICE_CHANGE_PENDING`, `POST /devices/change-request`.

---

### R6 — Read the `device` block returned by login

**Files:** `src/features/auth/api.ts` (the `AuthResponse` type),
`src/store/auth.ts`

**Why:** `/auth/login` and `/auth/register` return an additional block:

```json
{
  "user": { },
  "accessToken": "…",
  "refreshToken": "…",
  "expiresIn": 900,
  "device": { "authorized": true, "status": "ACTIVE" }
}
```

The app currently ignores it — harmlessly, since unknown fields are dropped.
But ignoring it means the student discovers their device is unbound only when
they tap a video and get a denial. Reading it at login lets the app show the
device-change screen immediately, on the screen where the student is already
paying attention.

This is listed as required rather than recommended because the alternative —
finding out at the video — is the single most likely source of "the app is
broken" support messages after launch.

**Relates to:** `AuthService.login`, `DeviceResolution`.

---

## RECOMMENDED

Improvements, not blockers. The app works without all of these.

---

### O1 — Surface `requestId` in the error UI

**Files:** `src/api/errors.ts`, the error-state components

`toApiError` already parses `requestId` from the response. Displaying it in
small text on the error screen — or copying it to the clipboard on a long press
— turns "the app didn't work yesterday" into a one-second log lookup.

---

### O2 — Prefer the nested `error` object

**File:** `src/api/errors.ts`

The backend emits both shapes deliberately, and the flat fields are guaranteed
for as long as the current build is in the field. New code should read
`body.error.code` with the flat field as a fallback, so the compatibility
mirror can eventually be retired:

```ts
const code = body?.error?.code ?? body?.code ?? 'UNKNOWN';
```

**Relates to:** `docs/API_CONTRACT.md` §1.

---

### O3 — Show a "being prepared" state instead of an error

**File:** `src/features/video/ProtectedVideoPlayer.tsx`

When a teacher has just uploaded a lesson, a student opening it gets
`VIDEO_NOT_READY` with the processing status in `details`. The lesson payload
also carries `video.status` (`UPLOADING` · `QUEUED` · `PROCESSING` · `READY` ·
`FAILED`), so the player can render "this lesson is being prepared — check back
shortly" and re-fetch the lesson every 30 seconds until it reads `READY`.

Note that `GET /videos/:id/status` is **staff-only** — it exposes rendition and
processing detail a student has no use for. Poll the lesson, not that.

---

### O4 — Use `/meta/app-config` at startup

**File:** `src/app/_layout.tsx`

`GET /meta/app-config` returns:

```json
{
  "minimumAppVersion": "1.0.0",
  "maintenanceMode": false,
  "playback": { "ticketTtlSeconds": 300, "heartbeatIntervalSeconds": 30,
                "maxConcurrentStreams": 1, "drmEnabled": false,
                "qualityLadder": [360, 480, 720, 1080] },
  "device": { "limitPerStudent": 1, "requiresSecureSurface": true },
  "features": { "selfServicePasswordReset": false, "otpRegistration": false,
                "codeRedemption": true },
  "support": { "phone": "…", "whatsapp": "…", "email": "…" }
}
```

Three things this buys: a forced-upgrade prompt without shipping a new build; a
maintenance screen you can turn on from the server; and support contact details
that stop being hardcoded in `EXPO_PUBLIC_SUPPORT_*`.

`playback.ticketTtlSeconds` is also worth adopting in place of the app's own
`EXPO_PUBLIC_PLAYBACK_TICKET_TTL`, so that a server-side change to the ticket
lifetime does not desynchronise the client's rotation timer.

---

### O5 — Register the push token after login, deregister on logout

**File:** `src/features/notifications/`

The endpoints exist (`POST /notifications/devices`,
`DELETE /notifications/devices/:token`) and the app calls them. Two refinements:

- re-register on every cold start, not only on first permission grant — Expo
  tokens rotate on reinstall and OS upgrade, and a stale token silently
  receives nothing;
- the backend re-points a token that already belongs to another account, so
  deregistering on logout is what stops the next person to sign in on a shared
  handset from receiving the previous student's notifications.

---

### O6 — Create the Android notification channels the backend targets

**File:** `src/app/_layout.tsx` or a notifications bootstrap module

The push processor sets `channelId` to one of `content`, `account` or
`default`. If a channel does not exist on the device, Android silently falls
back to the default channel and the student loses the ability to mute course
updates while keeping payment alerts.

```ts
await Notifications.setNotificationChannelAsync('content', { name: 'Course updates', importance: DEFAULT });
await Notifications.setNotificationChannelAsync('account', { name: 'Account & payments', importance: HIGH });
```

**Relates to:** `PushProcessor.channelFor`.

---

### O7 — Show the access state rather than a generic lock

**File:** `src/app/course/[courseId].tsx`

`GET /courses/:id` returns `access.state` as one of `NOT_ENROLLED ·
PENDING_APPROVAL · PENDING_PAYMENT · ACTIVE · EXPIRED · REVOKED · ARCHIVED`,
plus `access.availableMethods`.

The app has the union in its domain types already. Rendering each state
distinctly — "your access ended on 14 Feb, renew", "waiting for admin
approval", "this course has been archived" — replaces a padlock icon that tells
the student nothing about what to do next.

`availableMethods` should also drive the Join Course button: showing "Pay 550
EGP" on a course that only accepts codes wastes a tap and a support message.

---

### O8 — Render server-provided Arabic fields

**Files:** the course, lesson and notification components

Rows carry both variants (`title` / `titleAr`, `body` / `bodyAr`). The app
currently displays the base field. Selecting by the active locale, with the
base field as fallback, means Arabic content appears in Arabic without a
refetch on language switch.

---

### O9 — Read the quality ladder from the manifest

**File:** `src/features/video/ProtectedVideoPlayer.tsx`

The backend may lower the quality ceiling for a given grant (a suspicious
session, or a policy decision) and omits higher renditions from the generated
manifest entirely. A hardcoded quality picker will offer 1080p that is not
present. Build the picker from what the manifest actually advertises.

---

### O10 — Send `Idempotency-Key` when initiating a payment

**File:** `src/features/courses/api.ts`

The backend already de-duplicates open checkouts within an hour, so a double
tap is safe today. An explicit `Idempotency-Key` header makes the guarantee
exact rather than heuristic, and costs one `crypto.randomUUID()`.

---

### O11 — Retire the mock layer's shape assumptions

**File:** `src/api/mock/`

Worth a pass once the app is talking to the real backend: any place where a
mock invented an id format (the `v-` prefix in R2 was one) is a place where a
real response will differ. Keeping the mocks working against real shapes makes
them useful for offline development; letting them drift makes them a source of
bugs like R2.

---

## Confirmed compatible — no change needed

Verified against the shipped app while building the backend:

| Area | Status |
| --- | --- |
| Error parsing (`toApiError` reads flat fields) | Backend emits them |
| `AuthResponse` shape | Exact match, `device` block is additive |
| Token refresh single-flight and rotation | Matches the backend's rotation contract |
| `SESSION_ENDING` code set | Only `SESSION_EXPIRED` and `ACCOUNT_DISABLED` return 401-and-final |
| Playback heartbeat payload | `{ positionSeconds, watchedDeltaSeconds, protection }` — exact |
| `terminate` handling in `usePlaybackTicket` | Backend returns exactly that shape |
| Ticket release on unmount and on background | Correct, and necessary — it frees the concurrency slot |
| Progress payload and offline batch | `{ lessonId, positionSeconds, watchedSeconds }` — exact |
| Enrol / redeem payloads | `{ method }` and `{ code }` — exact |
| Device headers | All eight are read by the backend's request-context middleware |
| Pagination (`{ items, meta }` under `data`) | Matches |
| Watermark rendering | Backend supplies `primary`, `secondary`, `sessionTag`, `opacity`, `moveIntervalSeconds` |
| RTL / language switching | Entirely client-side; the API is direction-agnostic |
| `Accept-Language` | Read and used to localise notifications |

---

## Suggested order

1. R1 (config) — nothing else can be tested without it
2. R2 (video id) — the player is broken until this is done
3. R3 (password path) — one line
4. R5, R6 (device states) — the first thing real students will hit
5. O4 (`app-config`) — unlocks forced upgrades and the maintenance screen before launch
6. O7, O8 (access states, Arabic) — the largest visible quality gain
7. Everything else as convenient

R4 is a verification, not an edit, apart from the device-name encoding detail.
