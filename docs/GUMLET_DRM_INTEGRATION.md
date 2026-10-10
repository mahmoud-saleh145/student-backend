# Gumlet DRM integration

Production integration of Gumlet DRM into the EduPlatform, layered **on top of** the
existing R2 / AES-128 HLS pipeline. The legacy path is fully preserved; Gumlet is a
per-video opt-in.

> **DRM claims, stated honestly and up front**
>
> * This integration requests **`HW_SECURE_ALL` only**. That is a *request* to the CDM,
>   not evidence of the level achieved.
> * **Widevine L1 is NOT verified.** L1 cannot be observed from a browser — EME exposes no
>   level API. Phase 0 observed black capture in Chrome/Edge on Windows, which is
>   consistent with a hardware path but does not prove L1.
> * **Screen capture cannot be universally prevented.** Browser DRM raises the cost of
>   capture; it does not forbid it. On a device where the platform grants no secure path,
>   capture is possible.
> * AES-128 HLS (the legacy path) and CENC DRM are **not equivalent**. AES-128 is
>   symmetric and transport-decoded; CENC is bound to a device via a licence from a
>   key server. A legacy video is meaningfully less protected.

---

## 1. Environment variables (names only — values are supplied by you)

Add to the **backend** `.env`. Values are never printed, logged or returned to clients.

| Variable | Purpose | Required when |
|---|---|---|
| `DRM_ENABLED` | Master switch for the DRM path. `true` enables `drm` in playback tickets. | any DRM use |
| `DRM_PROVIDER` | `none` or `gumlet`. Selects the DRM implementation. | `DRM_ENABLED=true` |
| `GUMLET_ORG_ID` | Organisation id used in the **license URL path** (`…/licence/<ORG_ID>/…`). | signing |
| `GUMLET_SIGN_SECRET` | Base64 HMAC secret used to sign license URLs. **Server-only.** | signing |
| `GUMLET_API_KEY` | Bearer key for Gumlet's Asset API (create/poll assets). | ingest |
| `GUMLET_WORKSPACE_ID` | Gumlet video workspace id used when creating assets. | ingest |
| `GUMLET_TOKEN_LIFETIME_SECONDS` | License-URL TTL. Default `300`. | optional |
| `GUMLET_RESOLUTIONS` | Renditions requested from Gumlet. Default `720p,1080p`. | optional |

### Which values must exist only on the server

`GUMLET_SIGN_SECRET` and `GUMLET_API_KEY` are **server-only, without exception**.

* They live in the backend process environment and the worker process environment only.
* They must **never** appear in a `NEXT_PUBLIC_*` / `EXPO_PUBLIC_*` variable, since those
  are inlined into client bundles at build time.
* They must never be committed. `.env` is git-ignored; `.env.example` holds names only.
* No client — web, mobile or dashboard — needs any Gumlet configuration. Clients receive
  only the short-lived, asset-scoped `drm.licenseUrl` minted per playback ticket.

The pre-existing generic-DRM variables (`DRM_WIDEVINE_LICENSE_URL`,
`DRM_FAIRPLAY_LICENSE_URL`, `DRM_FAIRPLAY_CERT_URL`, `DRM_PROVIDER_TOKEN`) remain for a
non-Gumlet provider and are unused when `DRM_PROVIDER=gumlet`.

---

## 2. Gumlet account prerequisites

Before any of this works, the Gumlet account must satisfy all of:

1. **The DRM add-on must be enabled** on the workspace. It is a paid add-on on top of any
   video plan; a video-only plan can create assets but cannot encrypt them.
2. **A DRM organisation must exist**, and its id is `GUMLET_ORG_ID`. It appears in every
   license URL path, so it cannot be invented.
3. **A URL-signing secret must be issued**, which is `GUMLET_SIGN_SECRET`. Shown once at
   creation on the DRM Credentials page.
4. **FairPlay credentials** must be provisioned for Safari/iOS. Confirm the `ASK`
   (Application Secret Key) field has a real value — an account showing `-` here will fail
   FairPlay playback even though Widevine works.
5. **An API key** for the Asset API (`GUMLET_API_KEY`) and the **workspace id**
   (`GUMLET_WORKSPACE_ID`).

---

## 3. Database migration

Created, **not executed**:

```
prisma/migrations/20261009120000_gumlet_drm_per_video_provider/migration.sql
```

Adds six nullable columns to `videos` (`drmProvider`, `gumletAssetId`,
`gumletWorkspaceId`, `gumletStatus`, `gumletError`, `gumletUpdatedAt`). All nullable,
no defaults, so every existing row keeps `drmProvider = NULL` = legacy path.

### Safety properties

| Property | Assessment |
|---|---|
| Additive only | No column dropped, renamed or retyped |
| Table rewrite | None. `ADD COLUMN` with no default is metadata-only in PostgreSQL |
| Lock | Short `ACCESS EXCLUSIVE` lock for the catalog update; on a large `videos` table this is near-instant |
| Index added | None, deliberately — `gumlet_asset_id` is only read after the row is loaded by primary key |
| Existing rows | Untouched. `drmProvider` stays `NULL` = legacy playback |
| Rollback | `DROP COLUMN` set in the file footer; fully reversible |

### Deployment ordering (important)

The migration is **backward-compatible**: the old code ignores six unknown nullable
columns. Deploy order may therefore be either, but the safe order is:

1. Apply the migration (`npx prisma migrate deploy`).
2. Deploy the backend/worker.
3. Set the env vars and restart.
4. Adopt videos through the dashboard.

Deploying code first is also safe — Prisma selects named columns, so the code works
against the pre-migration schema for every legacy path. But the *reverse* (migrating back
after deploying code that writes the columns) would error.

### Staging procedure

```bash
# 1. Snapshot first
pg_dump "$DATABASE_URL" -Fc -f gumlet-pre-migration.dump

# 2. Inspect what will run
npx prisma migrate status
npx prisma migrate diff \
  --from-schema-datamodel prisma/schema.prisma \
  --to-schema-datasource prisma/schema.prisma \
  --script        # should be empty for an already-applied migration

# 3. Apply
npx prisma migrate deploy

# 4. Verify
psql "$DATABASE_URL" -c '\d videos' | grep gumlet
psql "$DATABASE_URL" -c \
  "SELECT count(*) FILTER (WHERE \"drmProvider\" IS NOT NULL) AS gumlet,
          count(*) FILTER (WHERE \"drmProvider\" IS NULL) AS legacy FROM videos;"
```

The second query must show `gumlet = 0` immediately after the migration. Any non-zero
value means something adopted a video before you expected it to.

**Rollback:** `npx prisma migrate resolve --rolled-back 20261009120000_gumlet_drm_per_video_provider`
followed by the `DROP COLUMN` statements in the file footer. Safe only while no video has
been adopted — dropping the columns would orphan live Gumlet assets.

---

## 4. Where the provider is decided

Two places, and only two.

### 4.1 Transcoding (the worker)

`VideoProcessor.process()`, immediately after `markProcessing`:

```
markProcessing(videoId)
  → gumletIngest.processFromJob(videoId, sourceKey)   // reads the DB
      handled: true  → return; never touches ffmpeg
      handled: false → fall through to the ffmpeg/HLS path, unchanged
```

`processFromJob` returns `handled: false` for every video whose `drmProvider` is not
`'gumlet'`, so the entire legacy pipeline below the branch — download, probe, transcode,
AES-128 keyinfo, upload, poster, `markReady` — runs exactly as it did before. No R2 object
is read, written or deleted differently.

**The provider is read from the database, not from the job payload.** A replayed, retried or
stale BullMQ job therefore cannot reroute a legacy video onto the Gumlet path, and cannot
route a Gumlet video into local ffmpeg.

A Gumlet video is never reported playable on the strength of the job alone:
`handled` gates the branch, and `playable` is carried separately from the ingest service's
own verification. A Gumlet failure (`errored`/`failed`) does **not** fall through to ffmpeg —
that would produce HLS renditions for a row that says the video is Gumlet-delivered.

### 4.2 Playback (the API)

`PlaybackService.resolvePlaybackTarget()`. See §5.

### 4.3 Upload (replacing a file)

A lecture holds **one** video row, so uploading over an existing video reuses it. For a
Gumlet-backed video, `initUpload` clears `gumletAssetId`, `gumletStatus`, `gumletError` and
`gumletUpdatedAt` while **keeping** `drmProvider`.

This is a correctness requirement, not a tidy-up. `adopt()` treats a present asset id as
"already adopted, just re-sync", so leaving the old id in place would make the worker
re-verify the *previous* recording, mark the lesson READY, and leave students watching the
old content — the new file would never have been ingested.

---

## 5. Playback selection logic

| Video | Payload | Client |
|---|---|---|
| `drmProvider = NULL` (all existing videos) | HLS manifest generated by this API, AES-128 | **hls.js** (legacy) / expo-video HLS (mobile) |
| `drmProvider = 'gumlet'` | DASH manifest + signed Widevine/FairPlay licence | **Shaka** (web) / expo-video DASH (mobile) |

Selection happens in `PlaybackService.resolvePlaybackTarget()`. A Gumlet video with
missing config, missing asset, or `DRM_ENABLED=false` **fails closed** with `PLAYBACK_DENIED`
or `VIDEO_UNAVAILABLE`; it never falls back to an unprotected stream.

### Key-system selection

The ticket request accepts `platform: 'ios' | 'android' | 'web'`. It selects the DRM key
system **only** and grants nothing — every entitlement, concurrency, device-binding,
watermark and capture control runs identically whichever value is sent.

| `platform` | Scheme | License host |
|---|---|---|
| `ios` | `fairplay` (+ certificate URL) | `fairplay.gumlet.com/licence` |
| `android` | `widevine` | `widevine.gumlet.com/licence` |
| `web` | `widevine` | `widevine.gumlet.com/licence` |
| omitted | `widevine` | so older clients keep working |

iOS has no Widevine CDM, so returning a Widevine URL to an iPhone fails inside the CDM with
no usable server-side error. FairPlay is therefore selected explicitly for `ios`.

Robustness is `['HW_SECURE_ALL']` with **no** software fallback, so a CDM that cannot meet
it fails instead of silently downgrading.

---

## 6. Rollback

The rollback is a config/flag change, not a code change:

1. `DRM_ENABLED=false` → all tickets return `drm.scheme: 'none'`. Existing HLS videos play
   exactly as before.
2. To also stop serving a specific Gumlet video, set its `drmProvider` back to NULL. That
   video becomes a legacy video; however its Gumlet asset remains and its media is
   DASH, so it must be re-transcoded to HLS to play again — or simply leave it unpublished
   until a decision is made.
3. **Never rotate `GUMLET_SIGN_SECRET` as a rollback step.** It invalidates every
   outstanding token and breaks nothing on the legacy path for no benefit.

The legacy R2 pipeline is unchanged throughout, so step 1 alone restores today's
behaviour for everything except Gumlet-adopted videos.

---

## 7. Dashboard workflow

All of it is inside the existing lecture video panel (`lesson-video-panel.tsx`). There is no
separate video-management screen and no new permission model.

| State | What the panel shows | What staff can do |
|---|---|---|
| `drmProvider = null` | "Delivered by this platform — R2 + encrypted HLS" | **Move to Gumlet DRM** (only when the video is `READY` or `FAILED`, i.e. the stored file exists) |
| `drmProvider = 'gumlet'`, still processing | "Gumlet is packaging this video" — auto-refreshes every 5 s | **Check Gumlet status** |
| `drmProvider = 'gumlet'`, ready | "Packaged and encrypted — students play it as DRM-protected DASH" | nothing needed |
| `drmProvider = 'gumlet'`, failed | The Gumlet error, as an inline `role="alert"` | **Check Gumlet status** to re-read it |

The panel **auto-polls** `GET /videos/:id/gumlet/status` while the asset is unsettled and
stops once it is playable or has failed. That endpoint is a read of state already mirrored
onto the video row — polling it does not call Gumlet. Pushing fresh provider state into the
row is the sync endpoint's job, and the backend polls on the staff member's behalf.

**Endpoints** (all `@StaffOnly()`, all additionally checked against
`assertCanManageCourseContent` for the video's own course **before** any Gumlet call):

```
POST /videos/:videoId/gumlet/adopt
POST /videos/:videoId/gumlet/sync
GET  /videos/:videoId/gumlet/status
```

The panel deliberately shows only the video id. The Gumlet asset id is an identifier rather
than a credential, but nothing in the UI needs it, and surfacing it invites copy-paste into
support tickets.

**Nothing secret reaches the browser**: no sign secret, no API key, no signed licence URL,
no DASH manifest URL. The dashboard displays state only; playback URLs are issued by
`POST /playback/videos/:id/ticket` to the viewing student.

`adopt()` is idempotent — re-adopting a video that already has an asset re-syncs it rather
than creating a duplicate asset.

---

## 8. Student playback verification

### Web (`edu-web/student-web`)

`/player/[id]` branches on `ticket.drm.scheme`. A Gumlet ticket renders `DrmVideo` (Shaka
Player, bundled via npm — a CDN outage cannot break protected playback); a legacy ticket
renders the unchanged hls.js path.

There is **no** fallback from a failed DRM load to an unprotected source. The lesson shows
an error instead. That is deliberate: silently swapping in a plain stream would defeat the
reason the lesson is DRM-protected.

### Mobile (`edu-mobile-final`)

Expo / React Native, `expo-video`. DRM support is native in the SDK: **Widevine on Android,
FairPlay on iOS**. The `expo-video` config plugin is *not* required for DRM — it only
configures PiP and background playback, both of which this app deliberately disables
because both would move protected frames outside the secure surface.

The player declares `contentType: 'dash'` for a DRM ticket and `'hls'` otherwise. Without
it, `expo-video` falls back to `progressive`, which cannot play a segmented manifest.

---

## 9. What Gumlet enforces vs what we enforce

| Control | Owner |
|---|---|
| AES-128 HLS encryption, derived keys, never stored | **Us (existing)** — `ManifestService.deriveContentKey` |
| Per-viewer signed manifests/segments, rotation | **Us (existing)** — `ManifestService.mediaPlaylist` |
| Live-ticket revalidation per playlist fetch | **Us (existing)** — `ManifestService.requireLiveTicket` |
| Concurrency (1 stream), per-hour issuance cap | **Us (existing)** — `PlaybackService` |
| Play allowance (3/video), capture strikes | **Us (existing)** — `PlaybackService` |
| Mid-playback revocation on heartbeat | **Us (existing)** — `PlaybackService.heartbeat` |
| Auth, enrollment/section/drip entitlement, device binding | **Us (existing)** — `CourseAccessService`, `DevicesService` |
| Watermark | **Us (existing)** — `Watermark` |
| Mobile secure surface (FLAG_SECURE / capture-excluded layer) | **Us (mobile)** — `SecureContentView` |
| Mobile screenshot/recording response | **Us (mobile)** — pauses and raises a shield |
| CENC encryption, hardware-decoded playback | Gumlet |
| Licence issuance requiring the signed token | Gumlet |
| `hardware_secure` gating SD/audio | Gumlet (partial — see below) |
| **Screen-capture blocking** | Gumlet, **only if the platform grants a secure path** — unverified on Windows |

### Known limits

1. **`hardware_secure` does not reject software-only devices outright.** Gumlet's own
   documentation is explicit: it "specifies if SD stream and audio should be allowed only
   on devices with hardware decode", while "HD and UHD streams (720p and above) **always**
   require hardware decode (Widevine Level 1)". So L1 is asserted by the provider for 720p+
   but **not observable from a browser** — EME has no level API. This integration requests
   `720p`+ and refuses a software fallback, which is the strongest client-side control
   available. It is not proof of L1.
2. **The DASH manifest is publicly fetchable** (HTTP 200, no token). Media is encrypted, so
   this is metadata/bandwidth exposure, not a content breach. Gumlet's paywalled
   `Signed URL` feature would gate it; not used here.
3. **License-URL replay window.** The token is asset-scoped, not user-bound. Mitigated by the
   entitlement gate on issuance plus `GUMLET_TOKEN_LIFETIME_SECONDS=300`. Gumlet's
   `playback_duration` and `rental_duration` parameters could close this further and are
   **not currently used** — see §12.
4. **Captions on Gumlet videos** are delivered as URLs; Shaka renders them via
   `addTextTrackAsync`. Untested against a real Gumlet asset in this environment.
5. **Browser support.** hls.js cannot do EME, so any Gumlet video requires a Shaka-capable
   browser. Legacy videos are unaffected.
6. **FairPlay certificate URL form.** Gumlet's docs list the prefix as
   `…/certificate/<ORG_ID>` but the runnable sample prints `…/certificate/<ORG_ID>/`. The
   sample form is used; it is **unverified against a live FairPlay credential**.

---

## 10. Tests

### 10.1 Backend — mocked, no network

| Suite | Tests | What it pins |
|---|---|---|
| `gumlet-signing.spec.ts` | 14 | Signing is byte-identical to Gumlet's documented JS/PHP reference; config fails closed; no secret in the bundle |
| `gumlet-ingest.spec.ts` | 10 | `adopt` is idempotent; no premature `READY`; blocked on an unencrypted manifest; errored asset; unknown status fails closed |
| `gumlet-playback-selection.spec.ts` | 13 | Provider selection and fail-closed behaviour |
| `gumlet-keysystem-selection.spec.ts` | 10 | iOS→FairPlay, Android/Web→Widevine, omitted→Widevine, and that selection never bypasses access control |
| `video-provider-branch.spec.ts` | 13 | The worker's routing decision |
| `videos-gumlet-authorization.spec.ts` | 10 | Staff authorisation on the three endpoints |
| `playback-ticket-platform.spec.ts` | 7 | `platform` validates to exactly 3 values and is actually forwarded to the service |
| `video-source-replacement-gumlet.spec.ts` | 6 | Replacing a Gumlet video's file clears the stale asset and keeps the provider |

Full backend suite: **71 suites / 1294 tests passing, 1 suite skipped** (the live spec).
Live spec (`npm run test:live`): **6/6 pass** — see §11.

### 10.2 Frontends

| Check | Result |
|---|---|
| `student-web` `tsc` / `next lint` / `next build` | clean; `/player/[id]` 392 kB (Shaka bundled, not CDN-loaded) |
| `edu-dashboard` `tsc` / `next lint` | clean |
| mobile `tsc` / `jest` | clean; **16 suites / 296 tests** |
| mobile `eslint` (changed files) | clean — 13 pre-existing React-Compiler errors remain in `ProtectedVideoPlayer.tsx`/`useWatchProgress.ts`, all in code this change did not touch |

**Bundle leak check** on the built `student-web` output, grepping every emitted `.js`:
`GUMLET_SIGN_SECRET`, `GUMLET_API_KEY`, `GUMLET_ORG_ID`, `GUMLET_WORKSPACE_ID`,
`widevine.gumlet.com`, `video.gumlet.io`, `createHmac`, `hardware_secure`, `signSecret`,
`apiKey` — **0 hits each**. The same scan over the mobile source: **0 hits**.

`SW_SECURE_CRYPTO` appears in the student-web bundle twice: both inside Shaka's own
key-system capability table. Our source contains **no** occurrence. This is the vendor's
data, not a fallback we request.

---

## 11. What was verified against live Gumlet, and what was not

### Verified live

`test/live/gumlet-manifest.live.spec.ts` runs the **production** `assetHasDrm` against a
real, public, DRM-encrypted Gumlet DASH manifest. It is excluded from `npx jest` (skipped
unless `LIVE_GUMLET_MANIFEST_URL` is set) so the default suite stays offline, and is run
explicitly with `npm run test:live`. **6/6 pass.**

| Assertion | Result |
|---|---|
| Manifest served successfully | HTTP 200, 4692 bytes |
| `assetHasDrm()` returns **true** on a real encrypted manifest | pass |
| Contains `urn:mpeg:dash:mp4protection:2011` | pass |
| Contains `cenc:default_KID="…"` | pass |
| Carries a Widevine PSSH (system id `edef8ba9-79d6-4ace-a3c8-27dcd51d21ed`) | pass |
| Offers an ABR ladder (5 representations) | pass |
| Returns **false** once the markers are stripped (the check can actually fail) | pass |

This is the single most important correctness result in the integration: that string match
is the only thing standing between "Gumlet reported ready" and "this lesson is marked
playable". It agrees with real provider output, and it can still fail.

### NOT verified — mocked or unexercised

No authenticated call was made. `GUMLET_API_KEY` and `GUMLET_WORKSPACE_ID` are **not set in
the backend `.env`** (only `DRM_ENABLED` is present, set to `false`), so:

- `POST /v1/video/assets` — request shape and response parsing.
- `GET /v1/video/assets/<id>` — status values, `dash_playback_url` shape.
- License issuance: a real Widevine licence has **never** been requested.
- Shaka playback with a real licence in Chrome, Edge or Firefox.
- FairPlay in Safari / iOS, **including whether the certificate URL form works**.
- Whether the device achieves Widevine L1 (not answerable from a browser — needs a CDM
  diagnostic or vendor confirmation).
- Mobile DRM on physical Android (Widevine CDM) and physical iOS (FairPlay). A simulator is
  not evidence.

`DRM_ENABLED` is currently `false`, so **the DRM path is off**: tickets return
`scheme: 'none'` and every video plays over the legacy path.

Nothing here has been deployed or pushed, and the migration has **not** been executed.

---

## 12. Troubleshooting

### Processing

| Symptom | Likely cause | Action |
|---|---|---|
| `Gumlet asset API is not configured` | `GUMLET_API_KEY` / `GUMLET_WORKSPACE_ID` missing | Set both, restart API + worker |
| `Gumlet processing did not finish within the job budget` | Large source exceeded the 20-min budget | Press **Check Gumlet status**; the recovery sweep retries |
| `Source object changed under this job` | Stale BullMQ job | Press **Check Gumlet status** |
| Video stuck `PROCESSING` | Job died without recording | Press **Check Gumlet status**, then retry |

### Authorization

| Symptom | Cause | Action |
|---|---|---|
| 403 on adopt/sync | Staff member outside the course's scope | Expected — ask a course owner or admin |
| 404 on a video id | No such video, or deleted | Check the lecture still has a video |
| `PLAYBACK_DENIED` on a Gumlet video | `DRM_ENABLED=false` or `DRM_PROVIDER≠gumlet` | Fix env, restart |
| `VIDEO_NOT_READY` | Gumlet has not finished, or DRM verification failed | Read `gumletError` in the panel |

### Manifest / licence

| Symptom | Cause | Action |
|---|---|---|
| `ready but NOT encrypted` | Asset packaged without DRM | Recreate the asset; check the DRM add-on is enabled on the workspace |
| Licence request 401/403 | `GUMLET_ORG_ID`/`GUMLET_SIGN_SECRET` mismatch, or secret was rotated | Re-copy both from DRM Credentials; old tokens die on rotation |
| Licence request 404 | Asset id is stale | Re-adopt the video |
| FairPlay fails on iOS | Missing ASK, or wrong certificate URL form | Confirm FairPlay credentials exist; try the alternate certificate form |

### Browser

| Symptom | Meaning | Action |
|---|---|---|
| `REQUESTED_KEY_SYSTEM_CONFIG_UNAVAILABLE` (6001) | Browser has no usable Widevine CDM for the requested robustness | Use a current Chrome/Edge; this is the expected software-only outcome |
| `LICENSE_REQUEST_FAILED` (6002) | Licence server refused | Check org id/secret, and that the token has not expired |
| `LOAD_INTERRUPTED` (7000) | Manifest fetch failed | Check the DASH URL is reachable from the client network |
| Blank page on `/player/[id]` for a legacy video | Unrelated to DRM | Check the video is `READY` and the manifest endpoint returns 200 |

---

## 13. Manual acceptance checklist

Run against a **staging** Gumlet workspace. Each line must be observed, not assumed.

**Backend / migration**

- [ ] `npx prisma validate` → valid
- [ ] `npx prisma migrate deploy` applied the Gumlet migration
- [ ] `SELECT count(*) ... WHERE "drmProvider" IS NOT NULL` → **0** immediately after
- [ ] Full backend suite green

**Legacy regression (do this first — it must pass before touching Gumlet)**

- [ ] An existing video uploads, transcodes and plays in hls.js exactly as before
- [ ] An existing video plays in the mobile app as AES-128 HLS
- [ ] Replacing a legacy video's file re-transcodes correctly

**Gumlet adoption**

- [ ] Adopt a video from the dashboard; panel shows "Gumlet is packaging this video"
- [ ] Panel auto-refreshes without pressing anything
- [ ] Panel ends at "Packaged and encrypted"
- [ ] `gumletAssetId` is set on the row; a second asset was **not** created
- [ ] The source object still exists in R2 (nothing was deleted)
- [ ] Re-adopting the same video does not create a duplicate asset

**Gumlet playback (web)**

- [ ] Chrome: plays; a licence request reaches `widevine.gumlet.com`
- [ ] Edge: plays
- [ ] Firefox: plays, or fails with a named CDM error rather than silence
- [ ] A failed DRM load shows an error — it does **not** fall back to plain video
- [ ] DevTools → Network shows no `GUMLET_SIGN_SECRET` / `GUMLET_API_KEY` in any response

**Gumlet playback (mobile, physical device required)**

- [ ] Android device: plays via Widevine
- [ ] iOS device: requests `fairplay.gumlet.com` and plays
- [ ] Screenshot during playback does not capture frames on Android
- [ ] Recording the screen raises the shield and pauses playback

**Failure paths**

- [ ] A failed asset shows the provider's error and never becomes playable
- [ ] A Gumlet video with `DRM_ENABLED=false` is refused, not downgraded
- [ ] Replacing a Gumlet video's file ingests the **new** file (not the old asset)

**Rollback**

- [ ] With `DRM_ENABLED=false`, legacy videos still play
- [ ] No R2 object was deleted at any point during the exercise