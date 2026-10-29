# Mobile release readiness — Google Play and Apple App Store

**Verdict: not ready to publish. Android goes first (D4); iOS is postponed.**

*Updated 2026-10-27 (Phase 2): owner decisions D1–D7 are implemented. See `OWNER_DECISIONS.md`.*

- **Android:** ready for **internal and closed testing** once a **new** AAB is built from the current source, after the backend containing D5 (account deletion) is deployed. Production needs the Play closed-test period and the owner actions in §2.
- **iOS:** **postponed by owner decision D4.** No StoreKit and no price hiding will be added. The remaining blockers are listed in §3. In-app account deletion (guideline 5.1.1(v)) is no longer one of them.

Nothing was uploaded, submitted or published. No store console was opened in this audit; Play Console facts below come from your own `release/PLAY_AUDIT_2026-10-23.md`, and are marked as such.

## 1. The artifact on disk

| Check | Result | Evidence |
|---|---|---|
| File | `release/builds/StudentCenter-1.0.0-vc7-production.aab`, 84,695,105 bytes | `ls` on the device |
| Type | Android App Bundle (ZIP with `BundleConfig.pb`, `base/manifest/AndroidManifest.xml`, 1,756 entries) | inspected with Python `zipfile` |
| Package | `com.eduplatform.app` | strings in the proto manifest |
| Signed | yes (`META-INF/98EC4F99.SF/.RSA`, the EAS upload key) | zip listing |
| Version | 1.0.0, versionCode 7 | file name; `PLAY_AUDIT` (EAS build `3f2051cb…`) |
| Source | git `61d08d1`, built **2026-10-01** | `PLAY_AUDIT` |
| Contains `expo-updates` | yes, so OTA updates apply to this binary | debug-symbol entries |
| Permissions | INTERNET, ACCESS_NETWORK_STATE, POST_NOTIFICATIONS, DETECT_SCREEN_CAPTURE, DETECT_SCREEN_RECORDING, VIBRATE, WAKE_LOCK, RECEIVE_BOOT_COMPLETED, ACCESS_WIFI_STATE, USE_BIOMETRIC, USE_FINGERPRINT, c2dm RECEIVE, launcher-badge permissions | manifest strings |

**This AAB must not be released.** It predates:
- your uncommitted registration and player work (2026-10-09/10);
- the 3 upstream mobile commits;
- every fix from this audit, including the iOS player fixes, avatar, `COURSE_NOT_TARGETED` and the release URL guard;
- the backend fixes the app relies on.

USE_BIOMETRIC / USE_FINGERPRINT come from a library (probably `expo-local-authentication` or a secure-storage dependency). Check whether biometrics are actually used. If not, remove them from the manifest, so they don't have to be justified in Data safety.

**A new APK or AAB could not be produced here.** No Android SDK is installed, there is no network for Gradle or npm, and no EAS login is available. Build with:

```
eas build --platform android --profile production   # AAB (versionCode auto-increments remotely)
eas build --platform android --profile production:apk   # optional test APK
```

Before building, commit the work you want to ship. EAS builds from Git, and `.gitignore` excludes `android/`.

## 2. Google Play

**Configuration verified in code:**
- `targetSdk 36`, `minSdk 24`, and R8 / shrink enabled.
- The production package is `com.eduplatform.app`.
- The `assertProductionEnv()` build guard runs on EAS builds.
- The production API is `https://student-backend-814y.onrender.com/api/v1`.
- Permissions are minimal, and cleartext traffic is removed for production.

**Fixed in this audit:**
- A **runtime guard** now stops a release bundle (store build or OTA update) from starting against a non-HTTPS or local API URL (`src/config/env.ts` `assertReleaseApiUrl`). Previously, an `eas update` published without the production environment would have pointed every installed app at `http://10.0.2.2:3000`. Logic verified (9 cases). The Jest file (`__tests__/release-api-url.test.ts`) could not finish in this environment.

**Open items (code or config):**

| # | Item | Severity | Action |
|---|---|---|---|
| A1 | Registration conflict with upstream | **Resolved (D1)** | Keep the local academic-selection flow when merging `origin/main`; `registration-no-study-type.test.ts` guards it |
| A2 | `version` pinned at 1.0.0 with `runtimeVersion: appVersion` | Medium | Bump `version` with every native change, or switch to `runtimeVersion: { policy: 'fingerprint' }` |
| A3 | Local `android/` is a **dev** prebuild (`com.eduplatform.app.dev`, debug-signed release type) | Medium | Never upload anything built from it. EAS regenerates it. |
| A4 | `google-services.json` only covers the production package | Low | Staging and dev builds fail Firebase config; add per-variant clients |
| A5 | Staging uses the production API | **Resolved (D7)** | Allowed only with `STAGING_USES_PRODUCTION_API=acknowledged` (set in `eas.json`); the staging app shows a "STAGING · PRODUCTION data" badge. A real staging backend is recommended (`OWNER_DECISIONS.md` D7) |
| A8 | In-app account deletion | **Done (D5)** | Settings → Delete account (password, 30-day cancellation). Needs the backend release **and** its migration before the app build ships |
| A9 | External checkout code in the binary | **Done (D4)** | `EnrollSheet.tsx` removed; `no-external-checkout.test.ts` |
| A6 | No forced-update / maintenance gate (`/meta/app-config` never read) | Medium | Recommended before the first public release. Production `minimumAppVersion` is 1.0.0 today. |
| A7 | Widevine L1 is required (`hardwareSecure: true`) | Info | Budget or L3 devices cannot play; mention in the listing and support FAQ |

**Play Console** (from `release/PLAY_AUDIT_2026-10-23.md`; not re-verified in this audit):
- Personal account. The **12-tester / 14-day closed test is required** before production.
- No AAB has been uploaded yet, and Play App Signing enrols at first upload. Keep the EAS key as the upload key.
- App access: "Restricted" but **no reviewer credentials** have been entered.
- The content rating certificate shows "-": check it.
- The privacy policy URL is live (per that audit).

**Data safety / account deletion:** "Users can request deletion: in the app, and at `https://student-dashoard.vercel.app/account-deletion`". The deletion page text was updated to the new flow. Publish the dashboard only after the backend release (see `IMPLEMENTATION_REPORT.md` §P2.7).

**Owner actions, in order:**
1. Deploy the backend with the D5 migration, then build a new AAB.
2. Upload it to internal testing, then create the closed track.
3. Add reviewer credentials: a demo student with a **pre-approved device**. The device limit is 1 in production.
4. Recruit 12 testers and keep the test running for 14 days.
5. Apply for production.

## 3. Apple App Store

**Configuration verified in code:**
- Bundle ID `com.eduplatform.app` and iOS 16.4.
- `ITSAppUsesNonExemptEncryption = NO`.
- A privacy manifest without tracking.
- Only the photo-library usage string.
- ATS strict in production, and background audio stripped.
- `supportsTablet: true`, so iPad screenshots are needed and review may happen on an iPad.

**Fixed in this audit:**

| Fix | Where | Status |
|---|---|---|
| Ticket rotation now keeps FairPlay. It used to switch to Widevine/DASH about 4 minutes in, so iOS playback failed every time. | Backend `playback.service.ts` | Needs a backend deploy. Unit-tested. |
| The FairPlay HLS source is typed `hls` (was `dash`). | `ProtectedVideoPlayer.tsx` | Unit-tested |
| A server termination is no longer overwritten, and the player pauses. | `usePlaybackTicket.ts`, `ProtectedVideoPlayer.tsx` | Type-checked |

**Not verifiable / open:**

| # | Item | Owner? |
|---|---|---|
| I1 | Apple Developer enrollment: `release/APPLE.md` says "not verified yet" | You |
| I2 | **Guideline 3.1.1:** paid content unlocked by externally bought codes, no IAP. D4 rules out StoreKit and price hiding, so an iOS submission is expected to be rejected until an iOS commercial model is chosen | You (iOS postponed) |
| I3 | ~~Guideline 5.1.1(v): deletion only a support ticket~~ **Resolved by D5**: in-app deletion with a 30-day cancellation | — |
| I4 | Real-device FairPlay playback test after the backend deploy | You (needs an iPhone) |
| I5 | Reviewer demo accounts with approved devices (iPhone and iPad) | You |
| I6 | APNs key and certificates on EAS; App Store Connect app record; privacy nutrition labels (name, phone, device ID, usage data, support content) | You |
| I7 | ~~Dead `EnrollSheet.tsx` with `Linking.openURL(checkoutUrl)`~~ **Removed (D4)** after verifying no references | — |
| I8 | `eas.json` `submit.production.ios` empty (`ascAppId`, `appleTeamId`) | You, when iOS resumes |

**Build and submit commands** (when iOS resumes):

```
eas build -p ios --profile production
eas submit -p ios
```

The `submit.production.ios` block in `eas.json` is empty: add `ascAppId` and `appleTeamId`.

## 3a. Blockers found on 2026-10-28 (before any production release)

| # | Blocker | Status |
|---|---|---|
| R1 | Render proxy hop count unverified (D6). The default may put all anonymous mobile traffic into one rate-limit bucket. | Code kept conservative. A diagnostic endpoint was added; verify after the API deploy, before raising `TRUST_PROXY_HOPS` (`OWNER_DECISIONS.md` D6). |
| R2 | Wallet-balance policy on deletion not decided | The app shows the balance and makes no refund claim; owner and legal questions in D5 |
| R3 | Deletion migration not applied; `prisma migrate status` against production not run | Run `npx prisma migrate status` on Windows (read-only), then `migrate deploy` from the release job |
| R4 | Courses archived before the restore fix may contain ambiguous re-requests | Run the read-only SQL in `OWNER_DECISIONS.md` D3 before restoring any archived course |
| R5 | Native checks not run: `next build`, Playwright, the backend integration suite, the Android build | Run on Windows |
| R6 [2026-10-29] | Desktop backend 6 commits behind `origin/main`; 42 changed files differ from upstream | Integrate on a branch from `origin/main` (`PHASE3_2026-10-29.md` §5) |
| R7 [2026-10-29] | The only AAB (vc7, 23 Oct) predates D4/D5 and all remediation | Rebuild after the backend release; device-test |
| R8 [2026-10-29] | Live dashboard deletion page still shows the old flow; support contacts empty in production | Deploy the dashboard after the backend; fill in the contacts |

## 4. Backend prerequisites for any store build

*Phase 2:* the D5 build calls `POST /auth/account-deletion` and handles `ACCOUNT_DELETION_PENDING`. An app built now and run against a backend **without** D5 gets 404 from Delete account. So deploy the backend (migration first) before shipping the app.


The mobile fixes assume the backend fixes are deployed: heartbeat rotation keeps FairPlay, expired tickets end cleanly, and `COURSE_NOT_TARGETED` is returned as before. Deploy the backend first, and confirm `/api/v1/meta/health/deep` shows the new `apiBuild`. Set `BUILD_COMMIT`, because `apiBuild` is null in production today.
