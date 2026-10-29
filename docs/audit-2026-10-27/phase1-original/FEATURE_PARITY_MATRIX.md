# Web / mobile feature parity matrix

Built from `WEB_FEATURE_INVENTORY.md` and `MOBILE_FEATURE_INVENTORY.md`, both derived from code. Both clients call the same backend (`/api/v1`). The web goes through a server-side Next.js proxy with HTTP-only cookies; mobile calls the API directly with bearer tokens held in SecureStore.

**Classification:**

| Code | Meaning |
|---|---|
| R | required on mobile (missing or broken there) |
| E | equivalent already exists |
| W | intentionally web-specific |
| M | intentionally mobile-specific |
| S | shared backend/API issue |
| ? | needs an owner decision (see `OWNER_DECISIONS.md`) |

| Feature | Web | Mobile | Class | Notes and action |
|---|---|---|---|---|
| Sign-in | complete | complete | E | Same endpoint and DTO |
| Registration and academic selection | complete (no study type) | complete locally (no study type); upstream adds study type | **?** D1 | The backend treats study type as optional and legacy |
| Session refresh | partial → **fixed** (12 h idle logout, cross-user generation, global cooldown, any-401 logout) | complete (single-flight, cooldown) | E | Web fixed in the audit; mobile already correct |
| Sign-out | partial → **fixed** (expired token left the server session alive) | complete (voluntary); push token stays bound on a forced logout | S | Backend should deactivate push tokens when a session is revoked (open) |
| Device identity and binding | complete (cookie `edu_did`) | partial (identity regenerated on a SecureStore read failure; reinstall = new device) | M | Platform-specific identity; mobile reinstall behaviour is a product risk (open) |
| Devices page and change request | complete | complete | E | |
| Password help | complete (contact admin) | complete (contact admin) | E | By design, no self-service reset |
| Change password | missing | missing (WhatsApp) | S | The backend has `POST /auth/password`; neither client uses it. It also revokes the *current* session (backend F-18). Open |
| Home feed | complete | complete | E | |
| Catalogue and filters | partial → **fixed** (year filter sent a faculty id as `departmentId`) | complete | E | |
| Search | partial (teacher results open an unfiltered list) | partial (teacher results are dead taps) | S | No teacher filter on `/courses`; fix both clients or add the filter (open, low) |
| Course detail and curriculum | complete | complete | E | |
| Join: free / approval / code / part card | partial (empty join sheet for PAYMENT-only courses) | complete | E | Online payment is disabled platform-wide (`payment.provider` none) |
| Full-course unlock by a section card | **backend bug, fixed** | same | S | `grantAccess` inherited coverage from pending/expired rows |
| My courses | partial → **fixed** (pending enrolments hidden) | complete | E | |
| Lesson page and mark complete | complete (silent errors) | complete | E | |
| Video DRM playback | Shaka (Widevine / FairPlay), Gumlet embed hotfix for iOS web | expo-video (Widevine L1 on Android, FairPlay on iOS) | M | Each platform uses its native DRM stack, which is correct. Do not port the web embed hotfix to mobile |
| Ticket rotation keeps the key system | **backend bug, fixed** (rotation dropped `platform`/`delivery`) | same: iOS broke about 4 min in | S | Fixed server-side; needs a backend deploy |
| FairPlay source content type | n/a | **fixed** (`dash` → `hls` for FairPlay) | R | |
| Server termination honoured | web WIP | **fixed** (rotation overwrote `terminated`; player not paused) | R | |
| Expired heartbeat / ticket | proxy now relays `PLAYBACK_TICKET_EXPIRED` without logging out | re-issue flow on `expired` | S | Heartbeat no longer re-mints expired tickets (backend) |
| Playback tracking / progress | WIP (final flush on unmount, embed records nothing, DRM ignores resume) | complete (offline queue) | R (web) | Web is your uncommitted WIP; findings handed over (web F9–F12) |
| Captions and quality on DRM | n/a | settings exist but have no effect on DRM | S | Gumlet DRM manifests are not filtered by the app; hide the controls or implement via ABR caps (open) |
| Watermark | DOM overlay (deterrence; removable in devtools) | native overlay inside the secure view | M | Web cannot prevent screen capture; Android FLAG_SECURE + Widevine L1 does; iOS is best-effort |
| Screen-capture protection | deterrence only | Android platform-enforced; iOS detection only | M | Never claim absolute protection on web or iOS |
| Attachments viewer | partial → **fixed** (re-issued the ticket on focus, reloading the PDF); eager rendering of every page (open) | partial (iOS PDF navigation filter suspected) | E | |
| Library (browse, quote, wallet purchase, reader) | complete | complete | E | |
| Wallet | partial (totals from page 1 only) | complete | E | Web low-severity issue open |
| Notifications inbox | complete | complete | E | |
| Push notifications | n/a | complete in code; delivery not verifiable | M | |
| Profile and avatar | complete | partial → **fixed** (`sizeBytes: 0` rejected) | R | |
| Support tickets | complete | complete | E | |
| Account deletion | n/a (support) | ticket-only | **?** D5 | Store requirement |
| i18n / RTL | complete | complete | E | |
| `COURSE_NOT_TARGETED` message | translated | **fixed** (was generic "Not permitted") | R | |
| Forced update / maintenance gate | n/a | missing (`/meta/app-config` never read) | R | Recommended before the first store release: a stale build cannot be forced to update otherwise (open; needs UX copy) |
| Analytics | `@vercel/analytics` (**build fixed**) | none | W | |
| Teacher notifications | n/a (dashboard) | n/a | **?** D2 | |

## What was implemented for parity during the audit

| Platform | Fixes |
|---|---|
| Mobile | FairPlay content type; termination and pause handling; avatar size; `COURSE_NOT_TARGETED` |
| Shared backend | Rotation keeps the key system; expired-ticket, device and section checks on heartbeat; section-card coverage |
| Web | Session refresh (four defects); year filter; My Courses; attachment refetch; logout revocation; the build-breaking dependency |

## Deliberately NOT copied across platforms

- **Web Gumlet embed hotfix (iOS Safari):** web-only workaround for FairPlay in Safari. Native iOS uses AVPlayer FairPlay directly.
- **Mobile FLAG_SECURE / secure surface:** no browser equivalent exists; the web keeps deterrence measures.
- **Mobile offline progress queue:** a mobile-specific need; the web is online-only.
