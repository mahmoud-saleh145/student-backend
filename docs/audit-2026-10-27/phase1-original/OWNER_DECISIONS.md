# Owner decisions

Only questions that cannot be settled from the code. Each one blocks only its own item; all other work went ahead.

---

## D1. Mobile registration: does the student pick a study type?

- **Issue.** Two incompatible versions of mobile registration exist.
- **Production behaviour (verified for the backend source on `origin/main`).** `RegisterDto.studyType` is **optional and tolerated** (`edu-backend/src/modules/auth/dto/register.dto.ts:60-76`). The comment there states the product rule: the academic system (year vs level) is the college's configuration, not the student's choice. The field is kept only so older app builds keep working.
- **Local behaviour (your uncommitted work, 2026-10-09).**
  - Registration uses `/catalog/academic-selection` (exists on backend `origin/main` since `1fe5f25`, 2026-10-10).
  - **No study type** is collected.
  - Files: `src/app/(auth)/register.tsx` and `src/features/auth/{api,hooks,schemas}.ts`.
- **Upstream behaviour (`origin/main`, youssef-hamed04: `c30964d`, `2d6a890`, `d31f51e`, 2026-10-08/09).**
  - Adds a **required** `studyType: 'GENERAL' | 'PROGRAMS'` to the same files.
  - Filters departments by it, and scopes years by department.
- **Evidence of conflict.** Both sides modify `register.tsx`, `features/auth/api.ts`, `hooks.ts`, `schemas.ts`, `ar.json`, `en.json` and `tsconfig.json`.
- **Consequences.**
  - Either version registers successfully against the current backend.
  - The upstream version asks students to classify themselves, which the backend comment says the product rules out.
  - If a department's `studyType` differs from the student's pick, the backend rejects the registration (`users.service.ts:265`).
- **Alternatives.**
  - (a) Keep the local version and discard the upstream study-type step.
  - (b) Keep upstream.
  - (c) Keep the local academic-selection flow, but use study type only as a department *filter*, never sent.
- **Recommendation: (a).** It matches the backend's documented rule and the web app (the web removed study type for the same reason). It also uses the endpoint built for this.
- **Decision needed.** Which registration flow ships in the first store build? Merge only after this.

## D2. Teachers' "Notifications" in the dashboard

- **Issue.** Teachers see a Notifications menu entry and a per-course Notifications tab (`edu-dashboard/src/components/layout/navigation.ts:179-184`, `src/features/courses/course-notify-tab.tsx`). Both post to `POST /notifications/announcements`, which is `@AdminOnly()` (`edu-backend/src/modules/notifications/notifications.controller.ts:182-183`). Every send by a teacher fails with 403.
- **Inconsistency.** `announcements.controller.ts:30` says "a teacher can already notify their own course's students through the course routes", but **no such route exists** in any controller.
- **Alternatives.**
  - (a) Add a teacher-scoped endpoint: `POST /admin/courses/:id/notify`, checked with `assertCanManageCourse(..., 'students')` and audience fixed to the course's active students.
  - (b) Hide both UI entries for teachers.
- **Recommendation: (a)** if teachers are meant to message their students (the UI was clearly designed for it), otherwise (b). Both are small.
- **Decision needed.** Should teachers be able to push notifications to their own course's students?

## D3. Teachers granting free access (`students` capability)

- **Issue.** Grant and extend access are checked against the *view students* capability, which is on by default (`edu-backend/src/modules/enrollments/enrollments.service.ts:849, 1042`). Any assigned teacher can therefore give full access with no payment, or turn a pending-payment request active. Only an audit row records it.
- **Alternatives.**
  - (a) A dedicated write capability, off by default.
  - (b) Admin-only, like `revoke`.
  - (c) Keep it as is (if teachers are trusted to comp students).
- **Recommendation: (a).**
- **Decision needed.** Are teachers allowed to grant free access?

## D4. iOS distribution and paid content (App Store guideline 3.1.1)

- **Issue.**
  - All paid content is unlocked with cards or codes bought outside the app.
  - The app shows prices, and there is no in-app purchase.
  - Dead code that opens an external checkout ships (`mobile-app-student/src/features/enrollment/EnrollSheet.tsx:111-112`, imported nowhere).
- **Consequences.** A likely App Review rejection under 3.1.1 (digital content must use IAP), unless the app qualifies as a "reader"-style app or the prices are not shown in-app.
- **Alternatives.**
  - (a) iOS build: hide prices and purchase prompts; codes are redeemed only (risky; reviewers often still reject).
  - (b) Add StoreKit IAP for courses.
  - (c) Android first; postpone iOS.
- **Recommendation: (c)** for the first release. In parallel, delete `EnrollSheet.tsx` and decide (a) or (b) with a real App Review consultation.
- **Decision needed.** The iOS commercial model.

## D5. Account deletion

- **Issue.** Google Play and the App Store both require in-app account deletion, or at least an in-app path to initiate it. The app only opens a support ticket (`settings/delete-account.tsx:34-57`), and the backend has no student self-delete route (admin `DELETE /admin/users/:id` only). Play accepts a web deletion URL. Apple guideline 5.1.1(v) expects deletion to be initiated in-app; a ticket-only flow is often rejected.
- **Alternatives.**
  - (a) Add `DELETE /me` that suspends the account and queues deletion (reusing the admin delete path).
  - (b) Keep the ticket flow and the web URL (acceptable for Play if the URL works; weak for Apple).
- **Recommendation: (a)** before the iOS submission; (b) is enough for the Play closed test.
- **Decision needed.** The retention and erasure policy (immediate, or after N days) for (a).

## D6. Rate-limit client address behind Render + Vercel

- **Issue.** Anonymous rate limits key on the left-most `X-Forwarded-For`, which the client controls. The audit removed the practical abuse:
  - sign-in attempts now share one bucket per **phone**;
  - authenticated traffic is keyed per **user** (guard order fixed).

  But anonymous non-credential traffic is still keyed by a spoofable header.
- **Constraint.** The student web calls the API **server-side from Vercel** and does not forward the browser IP. Switching to `req.ip` would therefore put every anonymous web request in Vercel's bucket.
- **Alternatives.**
  - (a) Have the web proxy forward `x-forwarded-for` and send a shared-secret header, and trust XFF only when the secret matches.
  - (b) Use `req.ip` with `TRUST_PROXY` hop count set to Render's, and accept that web anonymous traffic shares a bucket.
  - (c) Leave it.
- **Recommendation: (a).**
- **Decision needed.** Is a web-to-API shared secret acceptable operationally?

## D7. Staging builds point at the production API

- **Issue.** `eas.json` `staging.env.EXPO_PUBLIC_API_URL` = `https://student-backend-814y.onrender.com/api/v1`, the same as production. Internal testers on staging builds create real data and real device bindings.
- **Decision needed.** Is there a staging backend? If not, this is acceptable but must be known.
