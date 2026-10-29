# Student Mobile App — Actual Release Configuration

Derived from `app.config.ts`, `eas.json`, the `.env.*` files, `android/`, `plugins/`, `modules/content-protection/` and `assets/`. There is no `app.json`; `app.config.ts` is the whole config. The `release/*.md` and `docs/*` files were treated as hypotheses and quoted only where marked. No secrets are reproduced: keystore passwords and Firebase API keys were not printed.

## 1. Identity and versioning (`app.config.ts`)

| Key | development | staging | **production** | Source |
|---|---|---|---|---|
| `APP_VARIANT` | development (default when unset) | staging | production | `app.config.ts:11`, `eas.json` profiles |
| name | EduPlatform (Dev) | EduPlatform (Stg) | **Student Center** | `:125-129` |
| slug | edu-platform-mobile | ← | ← | `:146` |
| scheme | eduplatform-dev | eduplatform-stg | **eduplatform** | `:137-141` |
| iOS bundleIdentifier / Android package | com.eduplatform.app.dev | com.eduplatform.app.stg | **com.eduplatform.app** | `:131-135,157,201` |
| version | 1.0.0 (static) | ← | ← | `:147` |
| ios.buildNumber / android.versionCode | "1" / 1 in config | ← | ← | `:158,204` |
| Effective build numbers | — | remote counter (`autoIncrement: true`) | remote counter (`autoIncrement: true`) | `eas.json` `cli.appVersionSource: "remote"`. The real values live on EAS and could not be checked here |
| runtimeVersion | `{ policy: 'appVersion' }` → "1.0.0" | ← | ← | `:321`; also `android/app/src/main/res/values/strings.xml` `expo_runtime_version=1.0.0` |
| OTA updates | `https://u.expo.dev/f5f88e33-01f3-4049-ae16-6c3cd5221f57`, `fallbackToCacheTimeout: 0`, check on launch ALWAYS | ← | channel `production` | `:312-319`, `eas.json`, prebuilt `AndroidManifest.xml` |
| EAS projectId | f5f88e33-01f3-4049-ae16-6c3cd5221f57 (hard-coded fallback) | ← | ← | `:20,323-326` |
| orientation / tablet | `default` / `supportsTablet: true` | ← | ← | `:148,156` |

**OTA risk.** `version` is pinned at 1.0.0 and the runtime is `appVersion`. Every binary therefore shares runtime 1.0.0 unless someone manually bumps `version`. An `eas update` built against new native code would be served to older 1.0.0 binaries. Bump `version` with every native change, or switch to the `fingerprint` policy.

## 2. EAS profiles (`eas.json`)

| Profile | environment | distribution | channel | Android artifact | Inline `env` |
|---|---|---|---|---|---|
| development | development | internal, dev client | development | apk, `:app:assembleDebug` | `EXPO_PUBLIC_API_URL=http://10.0.2.2:3000/api/v1`, mocks false |
| development:device | ← | ← | ← | ← | iOS device build |
| staging | preview | internal | staging | apk | `EXPO_PUBLIC_API_URL=https://student-backend-814y.onrender.com/api/v1` |
| **production** | production | store | production | app-bundle | **`EXPO_PUBLIC_API_URL=https://student-backend-814y.onrender.com/api/v1`**, `EXPO_PUBLIC_ENV=production`, mocks false |
| production:apk | ← | ← | ← | apk | ← |

- Submit config: Android `serviceAccountKeyPath ./credentials/play-service-account.json` (gitignored, so it exists only locally), track `internal`, status `draft`. iOS submit config is empty (`{}`): the ASC app id and Apple team come from interactive or EAS credentials.
- Values **not** in `eas.json` must come from the EAS "production" environment: support phone, WhatsApp and email, `EXPO_PUBLIC_PRIVACY_POLICY_URL`, `EXPO_PUBLIC_TERMS_URL`, `EXPO_PUBLIC_ACCOUNT_DELETION_URL`, and `GOOGLE_SERVICES_JSON`. They are enforced at build time (§3), but their actual values are **not verifiable** from here. The docs (hypothesis) name `https://student-dashoard.vercel.app/{privacy,terms,account-deletion}`; note the spelling "dashoard". Reachability could not be checked (no network).
- **Staging and production use the same API host** (finding F20).
- The production backend is a `*.onrender.com` host. If it is on a plan that sleeps, a cold start can exceed the client's 20 s timeout (`config/env.ts:57`). SUSPECTED, plan not verifiable.

## 3. Production API URL selection: can a prod build point at localhost or staging?

Resolution order in the app: `process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:3000/api/v1'` and `EXPO_PUBLIC_ENV ?? 'development'` (`src/config/env.ts:51-52`). zod checks only that it is a URL (`:19`).

Build-time guard `assertProductionEnv()` (`app.config.ts:34-121`) refuses the build if the URL is missing, not https, or a private/loopback/`example.*` host, if mocks are on, if the support contacts are placeholders, or if any legal URL is missing or not https. But it runs **only when `EXPO_PUBLIC_ENV==='production'` AND `EAS_BUILD==='true'`** (`:35,43`).

| Path to a production artifact | Result |
|---|---|
| `eas build --profile production` | Safe. `eas.json` pins the Render URL and the guard runs on the worker. Cannot be localhost or a placeholder. |
| `eas update --channel production` (OTA) | **Not guarded.** `eas.json` build-profile `env` is not applied to updates. If the publisher does not use the EAS `production` environment (or a local `.env.production`, which does not exist), the bundle is built with `EXPO_PUBLIC_API_URL` unset, so the app talks to `http://10.0.2.2:3000/api/v1` and runs with `env=development`. Every installed production app would pick it up on next launch (check ALWAYS). In a production binary cleartext is not permitted, so the effect is a total outage until a fix is published. Config-level CONFIRMED; whether the team's workflow passes `--environment production` is not verifiable. **Add the same guard to the update/export path, or fail at runtime in `env.ts` when `isProd && !https`.** |
| Local release build from the committed `android/` folder (`./gradlew bundleRelease`, `expo run:android --variant release`) | **Not guarded**, and it would produce a dev-variant artifact (see §4). |
| Staging build | Points at the production backend (F20). |

## 4. `android/` folder

- It exists in the working tree but is **gitignored** (`.gitignore: /android`; `git check-ignore` confirms) and is not tracked. EAS uploads use git rules, so EAS builds run a fresh `expo prebuild` and ignore this folder. That is the intended managed workflow.
- The local folder is a **development-variant prebuild**, not a release project:
  - `namespace` and `applicationId` are `com.eduplatform.app.dev` (`android/app/build.gradle:90-92`), `app_name` is "EduPlatform (Dev)" (`res/values/strings.xml`), the intent-filter scheme is `eduplatform-dev`, and the Kotlin sources live under `java/com/eduplatform/app/dev/`.
  - `versionCode 1`, `versionName "1.0.0"` (`build.gradle:95-96`).
  - **The release buildType is signed with `signingConfigs.debug`** (`build.gradle:112-115`). The only keystore present is `android/app/debug.keystore`, the standard Android debug keystore (passwords not printed). There is no release keystore in the tree: production signing must come from EAS-managed credentials, which could not be checked.
  - `network_security_config.xml` still contains the cleartext `domain-config` for `10.0.2.2/localhost/127.0.0.1`. The plugin drops it only when `APP_VARIANT=production` (`plugins/withSecurityHardening.js:35-46`), so an EAS production prebuild is clean.
  - `minSdk 24 / compileSdk 36 / targetSdk 36`, R8 full mode, minify and shrink on (`gradle.properties`; `app.config.ts:286-295`). New Architecture and Hermes enabled. `reactNativeArchitectures` includes x86 and x86_64, which is fine for an AAB.
- **Manifest (prebuilt).** Permissions: `INTERNET`, `ACCESS_NETWORK_STATE`, `POST_NOTIFICATIONS`, `DETECT_SCREEN_CAPTURE`, `DETECT_SCREEN_RECORDING`, `VIBRATE`. Removed with `tools:node="remove"`: `CAMERA`, `RECORD_AUDIO`, `SYSTEM_ALERT_WINDOW`, `READ_/WRITE_EXTERNAL_STORAGE` (`app.config.ts:211-228`). No media or photo permissions, because the system photo picker is used. Application flags: `allowBackup=false`, `fullBackupContent=false`, `dataExtractionRules` (excludes everything), `usesCleartextTraffic=false`, `networkSecurityConfig` (system CAs only in release). `MainActivity` adds `FLAG_SECURE` in `onCreate` (`MainActivity.kt:20-21`). There is a `<queries>` block for https VIEW intents.
- **Every permission is used.** Notifications → POST_NOTIFICATIONS. Capture and recording callbacks → DETECT_*. These are normal permissions and need no Play declaration.

## 5. `google-services.json`

- It exists in two places, `./google-services.json` and `android/app/google-services.json`. The two are identical and both are **gitignored**.
- Firebase project `student-center-5b266`, a single Android client: **`com.eduplatform.app` only**. Keys are present and were not printed.
- `app.config.ts:202-203` reads `process.env.GOOGLE_SERVICES_JSON ?? './google-services.json'`. Because the file is gitignored, an EAS build has it only if `GOOGLE_SERVICES_JSON` is provided as an EAS file variable. Must-verify: the docs claim the EAS build is valid, which is plausible but not verifiable here.
- **Staging (`com.eduplatform.app.stg`) and dev (`.dev`) builds**: the google-services Gradle plugin fails with "No matching client found for package name" unless a per-variant JSON is supplied. The `apply plugin: 'com.google.gms.google-services'` line is at `android/app/build.gradle:184`. Not a production blocker, but it breaks staging APKs and local dev builds.

## 6. iOS configuration (no `ios/` folder: generated at EAS prebuild)

| Item | Value | Source |
|---|---|---|
| Deployment target | iOS **16.4** | `app.config.ts:296-298` |
| Encryption | `usesNonExemptEncryption: false` (ITSAppUsesNonExemptEncryption = NO) | `:159-163` |
| Privacy manifest | `NSPrivacyTracking=false`, no tracking domains; required-reason APIs FileTimestamp C617.1, UserDefaults CA92.1, SystemBootTime 35F9.1 | `:168-185` |
| Usage strings | only `NSPhotoLibraryUsageDescription` ("Used only if you choose a profile photo from your library."). Camera, microphone and Face ID strings are suppressed through plugin options | `:186-197,254-271` |
| Background modes | `remote-notification`; `audio` explicitly stripped | `:187`, `modules/content-protection/app.plugin.js:97-102` |
| ATS | `NSAllowsArbitraryLoads=false`, `NSAllowsLocalNetworking` only for non-production variants | `plugins/withSecurityHardening.js:151-165` |
| File sharing | `UIFileSharingEnabled=false`, `LSSupportsOpeningDocumentsInPlace=false` | same |
| Custom Info.plist key | `ContentProtectionEnabled=true` (harmless) | `app.plugin.js:103` |
| Entitlements | none declared by hand. `aps-environment` comes from the expo-notifications plugin at prebuild. No associated domains, so the deep links are custom-scheme only (`eduplatform://`). FairPlay needs no entitlement | — |
| Signing / APNs key | EAS-managed; not verifiable | — |

Notes:
- `NSPrivacyCollectedDataTypes` is absent from the app privacy manifest, while the app collects name, phone, a device ID and watch history. The App Store privacy labels must still declare these. Low risk.
- `supportsTablet: true` means iPad screenshots are required and review may run on an iPad.

## 7. Assets

| Asset | Exists | Size |
|---|---|---|
| `assets/images/icon.png` (iOS/app icon) | yes | 1024×1024 RGB, no alpha (✔ App Store) |
| `assets/images/adaptive-icon.png` | yes | 1024×1024 RGBA, background `#FBB150` |
| splash (`expo-splash-screen` image) | `assets/images/logo-mark.png` | 467×512 RGBA, 192 dp, `#FBB150` |
| `assets/images/splash.png` | yes | 1284×2778. Not referenced by the config |
| notification icon | `assets/images/notification-icon.png` | 96×96 RGBA, tint `#D52027` |
| favicon | yes | 96×96 |
| Play listing assets | `release/store-assets/play-icon-512.png` (512×512), `play-feature-graphic-1024x500.png` (1024×500) | ✔ |
| Generated Android launcher and splash resources | present in the prebuilt `android/app/src/main/res/mipmap-*`, `drawable-*` | ✔ |

## 8. Legal, deletion and support surfaces in the app

- **Privacy policy and terms**: `app/settings/about.tsx:19-58` → `support.openLegal()` (`src/services/support.ts:73-84`). The URLs come from `EXPO_PUBLIC_PRIVACY_POLICY_URL` / `EXPO_PUBLIC_TERMS_URL`, which are mandatory for EAS production builds. If missing, the app falls back to contacting support. Privacy is not linked from the auth screens: registration has no privacy or terms link or consent, so a reviewer must find it under Settings → About after signing in. Consider adding the link to register and login.
- **Account deletion**: Settings → Delete account (`app/settings/delete-account.tsx`). It **files a support ticket** ("deleteAccount.ticketSubject") and optionally links the web page `EXPO_PUBLIC_ACCOUNT_DELETION_URL`. The backend has **no** self-service deletion endpoint; only admin `DELETE /admin/users/:id` exists (`backend/src/modules/users/users.controller.ts:168`).
- **Support**: tickets in-app, plus WhatsApp, phone and email (production values from EAS env; the guard rejects the placeholder `+201000000000` and `@example.*`).

## 9. Store-review risk assessment

### Apple App Store — likely blockers
1. **Guideline 3.1.1 / 3.1.3 (payments): High risk.** All paid digital content (recorded courses, course parts and library PDFs) is unlocked by **access codes and recharge cards bought outside the app** and redeemed in-app (`POST /courses/:id/redeem`, `/wallet/redeem`), and by wallet credit. There is no IAP anywhere. 3.1.1 explicitly bars "license keys … or other mechanisms" for unlocking content. 3.1.3(b) multiplatform access applies only if the items are also offered as IAP. The JoinSheet also shows **prices** and tells the student which card to obtain (`features/enrollment/JoinSheet.tsx:25-36,142-148`), which reads as steering to an external purchase. The unused `EnrollSheet.tsx:111-112` (`Linking.openURL(checkoutUrl)`) should be removed from the bundle. The project's own `release/APPLE.md §5.1` (hypothesis) acknowledges this is undecided.
2. **Guideline 2.1 (app completeness): High risk.** Protected playback on iOS is broken after the first ticket rotation (findings F1, CONFIRMED) and possibly from the first frame (F2, SUSPECTED). A reviewer who watches more than about 4 minutes sees "Playback failed". The reviewer also needs a demo account **with a device slot available or pre-approved**, because device binding refuses tickets on an unbound device (`devices.service.ts:300-333`) and the player gives no call-to-action (F14). Cards and credit must be pre-loaded on the demo account.
3. **Guideline 5.1.1(v) (account deletion): Medium risk.** Deletion is initiated in-app but is a support-ticket request processed by staff, with no confirmation of completion. Apple accepts request flows mainly for regulated industries. Implement a real self-service delete (or a deletion request with an automated SLA), backed by an endpoint.
4. **Undocumented iOS API technique: Low-Medium risk.** The secure-text-entry canvas re-parenting (`SecureContentView.swift`) uses no private symbols (it matches class names by string), so it is unlikely to be flagged as private API, but it may break across iOS versions (F24).
5. **Privacy**: no ATT is needed (no tracking). The labels must declare phone, name, device ID, usage data and support content.

### Google Play
1. **Payments policy: Medium risk.** Play allows consuming content bought elsewhere but forbids steering to external payment for digital goods inside the app. The price display and the "get a card" guidance are the exposure. No external payment link is reachable (EnrollSheet is dead code).
2. **Account deletion**: an in-app path exists (ticket) and a web URL is mandatory at build time. This meets the letter of the policy if the web page is live and deletion is actually performed. The page could not be checked.
3. **Data safety**: must declare phone, name, device identifiers (the `X-Device-Id` hash, model, OS), app activity (watch progress), and support messages. Encryption in transit is yes. A deletion request mechanism is yes. Not verifiable here.
4. **Target API**: targetSdk 36 ✔. Permissions are minimal and all justified ✔. FLAG_SECURE app-wide makes the pre-launch report screenshots black; that is cosmetic only.
5. **Widevine L1 (`hardwareSecure: true`)**: devices without L1 cannot play. Expect 1-star reviews and support load on budget devices. Not a policy issue.
6. Push needs FCM v1 credentials uploaded to EAS for Expo Push. Not verifiable.

## 10. Release-blocker checklist (ordered)

1. Fix iOS playback: carry `platform` through rotation (backend `playback.service.ts:1231-1251`) and use `contentType 'hls'` for FairPlay (`ProtectedVideoPlayer.tsx:213`). Then test on a real iPhone. (iOS)
2. Decide the iOS monetisation model before submitting: IAP for the library and courses, or a free "reader-style" app that shows no prices or card guidance, with EnrollSheet removed. (iOS)
3. Guard the OTA/export path against a missing or non-https `EXPO_PUBLIC_API_URL`, and add a runtime fail-closed in `src/config/env.ts` for `isProd`. (both)
4. Implement real account deletion, or at least an automated deletion request with confirmation, on the backend. (both; mandatory for iOS)
5. Prepare demo accounts with pre-approved devices, credit and cards, and add a call-to-action from device errors (F14). (both)
6. Confirm the EAS production environment: legal URLs live, `GOOGLE_SERVICES_JSON` file variable present, FCM v1 and APNs keys configured, and production signing credentials on EAS (the local `android/` folder is debug-signed and dev-package and must never be used for an upload).
7. Give staging its own backend (F20) and a variant-matching `google-services.json` for `.stg`.
8. Bump `version`, or switch `runtimeVersion` to `fingerprint`, before the first OTA after any native change.
