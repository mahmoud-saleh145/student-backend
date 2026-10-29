# Student Mobile App — Defects and Risks (evidence-based)

Scope: `mobile` checked against `backend` (read-only, nothing executed; `node_modules` was still being installed, so library internals such as expo-video's iOS handling could not be inspected).

- **CONFIRMED**: the failing code path is visible in source on both sides.
- **SUSPECTED**: the defect depends on platform or library runtime behaviour, or on data, that could not be observed here.

Severity: **Critical** (blocks release or breaks a core flow for many users) · **High** · **Medium** · **Low**.

---

## Playback / DRM

### F1 — iOS playback breaks at the first ticket rotation: the rotated ticket is Widevine + DASH · **High · CONFIRMED** (backend-side code, mobile-visible)
- **Backend.** `backend/src/modules/playback/playback.service.ts:1231-1251`: the heartbeat rotation calls `mintTicket({...})` **without `platform`** (and without `delivery`). `resolvePlaybackTarget` then sets `useFairPlay = platform === 'ios'` → `false` (`:888`), so it returns the Widevine licence and the **DASH** manifest (`:890-934`). The platform is not stored on the ticket row (`:592-612`), so the heartbeat cannot recover it.
- **Mobile.** `features/video/usePlaybackTicket.ts:178-180` adopts `res.ticket`. `ProtectedVideoPlayer.tsx:164-177` then builds `drm.type = 'widevine'`, and the source is rebuilt (`:181-228`) on iOS.
- **Failure scenario.** TTL is 300 s and rotation happens when less than 2 × 30 s remain (`:1216-1218`, `config/configuration.ts:74-75`). About 4 minutes into every iOS lesson the player is handed a Widevine/DASH source that AVPlayer cannot play → `statusChange: error` → "Playback failed" (`ProtectedVideoPlayer.tsx:526-563`). "Reload" issues a fresh FairPlay ticket, which fails again 4 minutes later.
- **Fix.** Persist `platform` (and `delivery`) on `PlaybackTicket` at issue time and pass it into the rotation `mintTicket`, or have the client send `platform` in the heartbeat body (`HeartbeatDto` would need the field).

### F2 — iOS FairPlay source is labelled `contentType: 'dash'` although the manifest is HLS · **High · SUSPECTED**
- **Mobile.** `features/video/ProtectedVideoPlayer.tsx:213`: `contentType: isDrm ? 'dash' : 'hls'`. Every ticket is DRM (strict gate, `playback.service.ts:857-871`), so iOS FairPlay tickets are labelled `dash`.
- **Backend.** For `platform === 'ios'` it returns `gumlet.hlsManifestUrl(...)` (`playback.service.ts:914-918`).
- **Failure scenario.** AVPlayer has no DASH support. If expo-video on iOS honours `contentType` (it is used to decide HLS handling), the FairPlay stream fails from the very first ticket. If it ignores the field, iOS plays until F1 hits. This could not be confirmed because `node_modules/expo-video` was empty.
- `__tests__/player-source-drm.test.ts` mirrors the memo and its FairPlay case (lines ~175-188) never asserts `contentType`, so the bug is pinned in rather than caught.
- **Fix.** `contentType: drm?.type === 'fairplay' ? 'hls' : isDrm ? 'dash' : 'hls'`, or derive it from the manifest extension.

### F3 — A server termination during the rotation heartbeat is overwritten with `ready` · **Medium · CONFIRMED**
- `features/video/usePlaybackTicket.ts:214-217`: `setPhase('refreshing'); void beat().finally(() => setPhase('ready'))`. `beat()` sets `'terminated'` (`:167`) or `'expired'` (`:192`), and the `finally` then forces `'ready'`.
- **Failure scenario.** Suppose the server revokes the grant at the rotation beat: a capture surface was reported (`playback.service.ts:1115-1136`), access was lost (`:1159-1163`) or the ticket was REVOKED (`:1103-1109`). The UI then stays in the playing state and keeps heart-beating a dead ticket. The stop is only honoured at the next 30 s interval beat. The Gumlet CDN does not check our ticket (`playbackHeaders: {}`, `:926`), so frames keep flowing until then.
- **Fix.** In `finally`, set `ready` only when the phase is still `refreshing`, using a functional `setPhase`.

### F4 — The native player keeps its source and is never paused when the grant ends · **Medium · CONFIRMED in code / SUSPECTED effect**
- `ProtectedVideoPlayer.tsx:230` creates the player from `source`, which is derived from `ticket`. On `phase === 'denied' | 'terminated' | 'expired'`, or on `playerFailed` (`:476-563`), the component returns `ErrorState` or `Blocked` with no `<VideoView>`, but nothing calls `player.pause()` and the ticket is not cleared on terminate (`usePlaybackTicket.ts:165-176`).
- **Failure scenario.** After the server terminates or the ticket expires, audio from the already-licensed stream can continue with no surface and no watermark on screen. This depends on expo-video not auto-pausing on view detach, which is SUSPECTED.
- **Fix.** Pause the player and clear the source whenever the phase leaves `ready`/`refreshing`.

### F5 — Captions and quality selection do nothing for DRM videos · **Medium · CONFIRMED**
- Captions and `maxHeight` are applied only on the legacy path, as query parameters (`ProtectedVideoPlayer.tsx:191-204`). There is no legacy path any more (backend strict gate, `playback.service.ts:857-871`).
- `ticket.captions[]` carries signed caption URLs (`playback.service.ts:634-646`) that are never given to expo-video as subtitle tracks.
- `PlayerSettingsSheet` choices only bump `reloadKey` or `activeCaption`, which rebuilds the source (a possible restart mid-lesson) with no visible effect. Students who rely on captions get none.

### F15 — The player never tells the server which lecture it is playing · **Low · CONFIRMED**
- `app/lesson/[lessonId].tsx:82` navigates to `/player/${video.id}` and drops `lessonId`. `features/lessons/api.ts:18` calls `/lessons/by-video/:id` without `?lessonId=`. `features/video/api.ts:46-52` sends `{platform}` only.
- The backend supports `lessonId` on both (`lessons/lessons.controller.ts:98`, `playback.controller.ts:66`) and, without it, picks a lecture heuristically for shared assets (`lessons/lessons.service.ts:286-300`, `playback.service.ts:330-357`).
- **Failure scenario.** A student enrolled in two courses that reuse one asset opens lecture B and may have progress, completion and the play count attributed to lecture A.

### F24 — iOS "secure surface" is a hard-coded claim · **Medium · CONFIRMED in code**
- `modules/content-protection/ios/ContentProtectionModule.swift:63` exports `"supportsSecureSurface": true` as a constant.
- `ios/SecureContentView.swift:85` falls back to `field.subviews.first` when no `*CanvasView` is found, which is not necessarily the secure layer.
- JS gates playback only on the constant (`ProtectedVideoPlayer.tsx:113`, `app/library/reader/[partId].tsx:56,63`, `app/viewer/[attachmentId].tsx`). The per-view `isSecure` is never surfaced. The docstring claim that "JS falls back to refusing playback" (`SecureContentView.swift:26-31`) is false.
- **Failure scenario.** An iOS update changes the UITextField internals: documents, the watermark and the controls render capturable while the app reports them protected. FairPlay video frames stay protected by the OS regardless.

### F23 — Android: a recording that started before detection is not seen · **Low · CONFIRMED**
- `ContentProtectionModule.kt:208-217`: the return value of `addScreenRecordingCallback` (the current state) is discarded. `isBeingRecorded()` only checks for an external display (`:127-131`).
- FLAG_SECURE still blacks the output, so this is a telemetry and UX gap, not a leak.

## Auth / session / refresh

### F11 — Every `PLAYBACK_TICKET_EXPIRED` (HTTP 401) burns a refresh-token rotation · **Low · CONFIRMED**
- `api/client.ts:296` refreshes on **any** 401 that is not anonymous and not already refreshed. The backend maps `PLAYBACK_TICKET_EXPIRED → 401` (`common/errors/error-codes.ts:147`) and throws it from the heartbeat (`playback.service.ts:1101`).
- Each expired-ticket heartbeat therefore rotates the refresh token and replays the call before failing. This adds load on `/auth/refresh` and widens the token-reuse window.
- **Fix.** Skip refresh when `body.code` is not `SESSION_EXPIRED`/`UNAUTHORIZED`.

### F12 — Cold start can hang on the splash spinner · **Low · SUSPECTED**
- `features/auth/AuthProvider.tsx:156`: `if (e instanceof ApiError && e.status === 401) return;` leaves `status` untouched and assumes a session-end broadcast already happened. That only holds for `SESSION_EXPIRED`/`ACCOUNT_DISABLED` (`client.ts:317-321`).
- A 401 with another code after a successful refresh-and-replay (for example `UNAUTHORIZED` "Invalid access token" after an issuer or audience change, `jwt-auth.guard.ts:100-105`) with no cached snapshot leaves `status = 'loading'` forever, and `app/index.tsx` spins indefinitely.

### F13 — Any 403 from `/auth/refresh` signs the user out · **Low · SUSPECTED**
- `api/client.ts:212-217` treats 400, 401 and 403 as definitive, regardless of the body.
- A WAF, CDN or hosting-edge 403 (an HTML page, so no `code`) on the refresh route would clear tokens and log out every active student at once. Tighten this to `SESSION_ENDING` codes, or to 401 with a JSON `code`.

### F16 — On an involuntary session end the push token stays bound to the account · **Medium · CONFIRMED**
- `api/client.ts:225-226` (refresh rejected) and `:317-319` (session-ending code) call `clearTokens()` **before** `broadcastSessionEnded()`. `AuthProvider.teardown` (`:93-97`) then calls `unregisterPushToken()`, which sends the DELETE without `Authorization` and with `skipRefresh` (`services/notifications.ts:155-159`). The backend answers 401 and the token stays active server-side, while the client deletes its local copy (`:162-163`).
- **Failure scenario.** An admin revokes the session, the password is changed, or the account is disabled. The device keeps receiving that account's pushes (course titles, support replies, payment notices) on the login screen until another account registers the same token. Only voluntary logout is handled correctly (`AuthProvider.tsx:203-215`).

### F17 — There is no in-app password change · **Low · CONFIRMED (feature gap)**
- `app/(tabs)/profile.tsx:91-99` opens WhatsApp, although `POST /auth/password` exists (`auth/auth.controller.ts:132`).
- If it is wired up, note that the backend revokes **all** sessions including the caller's (`auth/auth.service.ts:836-856`; the comment at `:839-841` claims otherwise). The client must then expect `SESSION_EXPIRED` on the next request and re-login, or the backend must exempt the current session.

### Refresh race review (no defect beyond the above)
- The single-flight `refreshPromise` (`client.ts:130,160-244`) covers both the proactive path (`:100-109`) and the reactive path (`:296-315`).
- The backend's 30 s reuse grace (`auth.service.ts:411-438`, check at `:423`) absorbs a replayed refresh within the window.
- Residual, inherent risk: the app is killed after the server rotated the token but before `setTokens` persisted it (`client.ts:191`). The next launch presents the old token after the grace period → the family is revoked → forced logout. Low frequency.
- If the SecureStore write in `setTokens` throws, the error lands in the transport-failure branch (`client.ts:200-210`, not an `AxiosError`). Memory holds the new pair, the keychain holds the old one, and the next cold start triggers reuse detection. Low.

## Storage / device binding

### F10 — Device identity is regenerated on any secure-storage read failure; an Android reinstall always means a new device · **Medium · CONFIRMED (code) / product risk**
- `services/secure-storage.ts:42-47` turns read errors into `null`. `services/device.ts:54-62` and `:64-66` then **generate and persist a new secret and device id**.
- An Android Keystore glitch (for example a key invalidated after an OS update or a lock-screen change on some OEMs) or a reinstall (Keystore and prefs wiped; `allowBackup=false`) produces a new `X-Device-Id`. The backend then answers `DEVICE_LIMIT_REACHED` / `DEVICE_CHANGE_PENDING` (`devices/devices.service.ts:225-253,318-333`) until an admin approves. That means a support ticket for every reinstall.
- On iOS the Keychain survives uninstall, so the comment "a reinstall on the same handset produces a new id" (`device.ts:68-70`) is false there.
- The same `null`-on-error path in `hydrateTokens` (`api/token-store.ts:26-35`) shows a signed-in student as signed out for that process. One example is a cold launch while the phone is locked (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`, `secure-storage.ts:18`) from a push.

### Insecure storage review
- Tokens, the device secret and the user snapshot are in SecureStore. ✔
- The React Query cache, persisted unencrypted in AsyncStorage, includes notifications, courses, the home feed and library listings (`api/query-client.ts:46-67`). Low; wallet, support, auth and playback are excluded.
- Web builds store tokens in `localStorage` (`secure-storage.ts:35-41`). Web is not shipped from this repo.

## Contract mismatches

### F6 — Avatar presign fails when the picker reports no file size · **Medium · CONFIRMED contract / SUSPECTED frequency**
- **Mobile.** `features/profile/avatar.ts:92` sends `sizeBytes: asset.fileSize ?? 0` (`:114-117`). `validateAvatar` accepts 0 (`:98-104`).
- **Backend.** `storage/storage.controller.ts:51-54` `PresignAvatarDto` has `@Min(1) sizeBytes`, so the request gets 422 VALIDATION_ERROR and the generic avatar error.
- `ImagePickerAsset.fileSize` is optional and is often absent after `allowsEditing` cropping. Fix: read the size from the fetched blob (`blob.size`, already fetched at `:121`) before presigning.

### F7 — `COURSE_NOT_TARGETED` degrades to a generic "Not permitted" · **Medium · CONFIRMED**
- The backend defines it as student-facing: 403, "update your faculty/department/year" (`common/errors/error-codes.ts:42-51,128`).
- Mobile `KNOWN_CODES` (`api/errors.ts:99-116`) lacks it, so `toApiError` falls back to `FORBIDDEN` (`:122-126`), and there is no `errors.COURSE_NOT_TARGETED` string in either locale. A student trying to join or redeem for a course outside their department is told nothing actionable.

### F8 — Teacher search results are dead taps · **Low · CONFIRMED**
- The backend returns `route: '/courses?teacherId=…'` (`search/search.service.ts:256`).
- The mobile allow-list `^/(course|lesson|player|viewer|settings|profile|search|notifications|library|wallet|support)(/seg)*/?$` (`utils/guards.ts:23-24`) rejects both `courses` and the query string. `app/(tabs)/search.tsx:52` silently does nothing.

### F19 — `CourseStatus` lacks `SUSPENDED` · **Low · CONFIRMED**
- Mobile `types/domain.ts:66` vs Prisma `enum CourseStatus { DRAFT PUBLISHED SUSPENDED ARCHIVED HIDDEN }` (`prisma/schema.prisma:70-76`).
- A suspended course in `/courses/mine` falls into no branch: `canJoin` is false and it is not "archived".

### F21 — Public routes silently ignore an expired token, and the personalised state is cached wrong · **Low-Medium · SUSPECTED**
- On `@Public()` routes the guard swallows token errors (`common/guards/jwt-auth.guard.ts:65-71`), so `GET /courses/:id` and `/courses` answer as anonymous (`access.state = NOT_ENROLLED`).
- Usually the client's proactive refresh prevents this. But while the refresh is cooling down (`client.ts:104-109`, 30 s after a failed refresh), enrolled students see "Join" on their own courses. That result is persisted to AsyncStorage (courses are not in `NEVER_PERSIST`), so it can survive a restart until the next refetch.

## Dead ends / broken flows

### F9 — Attachment PDF viewer navigation filter likely blocks its own HTML on iOS · **Medium · SUSPECTED**
- `app/viewer/[attachmentId].tsx:126-127` allows only `req.url.startsWith(<file URL without query>)`.
- For PDFs the source is `{html, baseUrl: origin}`. react-native-webview on iOS reports the initial load as the `baseUrl`/`about:blank`, and neither starts with the full file path, so the load is cancelled and the page is blank.
- The library reader has the corrected filter (`app/library/reader/[partId].tsx:149-151`: `about:blank || startsWith(origin)`). The two screens diverge, which suggests one was fixed and the other was not.

### F14 — Device errors in the player have no way forward · **Medium · CONFIRMED**
- `components/ui/ErrorState.tsx:64,96` shows a single "Retry", only for `retryable` codes. `DEVICE_NOT_AUTHORIZED`, `DEVICE_LIMIT_REACHED`, `DEVICE_CHANGE_PENDING` and `DEVICE_INTEGRITY_FAILED` are not retryable (`api/errors.ts:37-53`).
- The player passes only `onRetry` plus Close (`ProtectedVideoPlayer.tsx:476-486`). A student on a new phone sees an icon, text and "Close", with no call-to-action to `/settings/devices` or "Request device change", although both exist.

### F18 — Unused, dead or missing pieces · **Info · CONFIRMED**
- `features/enrollment/EnrollSheet.tsx` is imported nowhere but still ships, including `Linking.openURL(result.payment.checkoutUrl)` (`:111-112`). Delete it before iOS review: a reviewer or static scan seeing an external checkout path for digital content is a 3.1.1 flag.
- Hooks with no screen: `useValidateCode` (`features/course-parts/hooks.ts:69-73`), `useMyCourseParts` (`:45`), `useLibraryPurchases` (`features/library/hooks.ts:64`).
- Endpoints declared but never called: `auth.session`, `auth.changePassword`, `devices.current`, `search.suggestions`, `meta.health`, `meta.appConfig`, `progress.continueWatching`, `courses.progress`, `courses.attachments`.
- `/meta/app-config` is never read, so there is **no forced-update or maintenance gate**. The backend never emits 426 either (it is only in the status map, `all-exceptions.filter.ts:207`). With OTA updates on runtime `1.0.0` there is no way to retire a broken binary.
- `EXPO_PUBLIC_ENABLE_DRM` is read only by the mock (`api/mock/index.ts:515`).

### F20 — Staging and production builds share one backend · **Medium · CONFIRMED (config)**
- `eas.json` sets `EXPO_PUBLIC_API_URL=https://student-backend-814y.onrender.com/api/v1` in **both** the `staging` and `production` profiles. Internal testers on staging builds create real accounts, redeem real cards and use real device slots in production.
- `.env.staging` points at the placeholder `https://staging-api.example.com/api/v1`, so local staging runs are broken.

## Summary table

| ID | Sev | Status | Area | One line |
|---|---|---|---|---|
| F1 | High | CONFIRMED | iOS playback | rotation drops `platform`, so iOS gets Widevine/DASH about 4 min in |
| F2 | High | SUSPECTED | iOS playback | FairPlay HLS source labelled `dash` |
| F3 | Medium | CONFIRMED | playback | termination at the rotation beat is overwritten by `ready` |
| F4 | Medium | CONFIRMED/SUSP | playback | player not paused or cleared when the grant ends |
| F5 | Medium | CONFIRMED | playback | captions and quality are no-ops for DRM |
| F6 | Medium | CONFIRMED | profile | avatar `sizeBytes: 0` → 422 |
| F7 | Medium | CONFIRMED | errors | `COURSE_NOT_TARGETED` unknown → generic |
| F8 | Low | CONFIRMED | search | teacher route rejected by the allow-list |
| F9 | Medium | SUSPECTED | attachments | iOS PDF viewer blocks its own load |
| F10 | Medium | CONFIRMED | device | identity regenerates on a read error or an Android reinstall |
| F11 | Low | CONFIRMED | refresh | ticket-expired 401 triggers a token refresh |
| F12 | Low | SUSPECTED | session | bootstrap can hang on `loading` |
| F13 | Low | SUSPECTED | refresh | any 403 on refresh → logout |
| F14 | Medium | CONFIRMED | device UX | no call-to-action from device errors |
| F15 | Low | CONFIRMED | playback | `lessonId` never sent |
| F16 | Medium | CONFIRMED | push/privacy | push token survives involuntary session end |
| F17 | Low | CONFIRMED | auth | no in-app password change; backend revokes the current session |
| F18 | Info | CONFIRMED | hygiene | dead EnrollSheet checkout, unused hooks, no forced update |
| F19 | Low | CONFIRMED | contract | missing `SUSPENDED` status |
| F20 | Medium | CONFIRMED | config | staging = production API |
| F21 | Low-Med | SUSPECTED | contract | expired token on public routes → wrong cached access state |
| F23 | Low | CONFIRMED | protection | Android initial recording state ignored |
| F24 | Medium | CONFIRMED | protection | iOS secure surface hard-coded true, unsafe fallback |
