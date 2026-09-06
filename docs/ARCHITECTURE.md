# Architecture

This document explains why the backend is shaped the way it is. It is written
for someone about to change it, so it spends most of its space on the decisions
that are easy to undo by accident.

---

## 1. The shape of the system

```
   React Native app                     Admin dashboard (future)
          │                                      │
          └──────────────┬───────────────────────┘
                         │  HTTPS, /api/v1
                 ┌───────▼────────┐
                 │  NestJS API    │   guards → validation → services
                 │  (N replicas)  │
                 └───┬────────┬───┘
        Prisma       │        │       BullMQ enqueue
              ┌──────▼──┐  ┌──▼─────┐
              │Postgres │  │ Redis  │  rate limits, stream slots, queues
              └─────────┘  └──┬─────┘
                              │ consume
                       ┌──────▼────────┐
                       │ Worker (M)    │  ffmpeg, push, sweeps, rollups
                       └──────┬────────┘
                              │ S3 API
                       ┌──────▼────────┐
                       │ Cloudflare R2 │  private bucket, no public read
                       └──────┬────────┘
                              │
                       ┌──────▼────────┐
                       │ Edge Worker   │  verifies viewer-bound signatures
                       └───────────────┘
                              │
                          the player
```

The API never streams media bytes. It issues short-lived, viewer-bound
authorization and gets out of the way — which is what lets the media path scale
independently of the request path.

---

## 2. Module organisation

Modules are domains, not layers. `courses/` holds its controller, its
services, its DTOs and its serializer, because the thing that changes together
should live together: adding a field to a course touches one directory.

A few modules are infrastructure rather than domain and are `@Global`:
`ConfigModule`, `DatabaseModule`, `RedisModule`. They are global because
practically everything needs them and threading them through twenty `imports`
arrays adds noise without adding clarity.

### The composition root

`app.module.ts` registers four global providers, and the **order matters**:

```ts
{ provide: APP_GUARD, useClass: ThrottlerProxyGuard },  // 1
{ provide: APP_GUARD, useClass: JwtAuthGuard },         // 2
{ provide: APP_GUARD, useClass: RolesGuard },           // 3
{ provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
```

Throttling first, so a flood of unauthenticated requests is rejected before it
costs a database round-trip in the auth guard. Authentication second — a
request must be identified before its role can be checked. Authorization third.

`JwtAuthGuard` being global means **every route is protected unless it opts
out** with `@Public()`. This is the safe direction to fail: forgetting a
decorator makes an endpoint unreachable rather than open.

---

## 3. The access engine

Every content gate in the system — course detail, lesson detail, playback
ticket, attachment ticket, progress write — resolves access through
`CourseAccessService`. There is no second implementation.

That matters because access has a precedence order, and the naive ordering
produces user-visible bugs:

1. **Course archived** → `ARCHIVED`. Beats everything, including an active paid
   enrolment. Archive means the content is gone for everyone.
2. **Enrolment revoked** → `REVOKED`. An explicit administrative decision
   outranks a still-open access window.
3. **Access window lapsed** → `EXPIRED`.
4. **Stored enrolment state** → as recorded.
5. **No enrolment row** → `NOT_ENROLLED`.

Step 3 is the subtle one. `Enrollment.state` can legitimately still read
`ACTIVE` while `accessEndsAt` is in the past, because the nightly expiry sweep
has not run yet. Trusting the stored column alone would keep serving video for
up to a day after access lapsed. The window is therefore evaluated live on
every request, and the sweep is treated as bookkeeping rather than as the
source of truth.

`decide()` is a pure function — course status in, verdict out — which is why it
carries the densest test in the suite.

---

## 4. Money

### Prices are versioned, never edited

```
CoursePrice v1  450 EGP   isCurrent=false  effectiveTo=2026-03-01
CoursePrice v2  550 EGP   isCurrent=true   effectiveTo=null
```

A `Payment` stores **both** the amount charged and `coursePriceId`. Reporting
reads the payment, never the course. That is the whole mechanism behind "the
old transaction must remain 100 EGP": there is no query anywhere that can join
a historical payment to a current price.

### Revenue is an append-only ledger

`RevenueLedger` gets one row per captured payment, with the course title
snapshotted so reports survive a rename or an archive. Refunds append a
**negative contra row** rather than editing the original. The ledger is
therefore a log, and the balance is a sum over it — which means a refund can
never be confused with a payment that never happened.

### Deletion is prevented at the database

Every foreign key from a financial record to content is `onDelete: Restrict`.
Not "the API has no delete route" — the database itself refuses. An integration
test asserts this by attempting the delete through Prisma directly and
expecting it to fail.

### Money paths run Serializable

Capture, refund and code redemption all use `MONEY_TX_OPTIONS` (Serializable
isolation). The cost is occasional retries under contention; the benefit is
that two simultaneous redemptions of a one-use code cannot both succeed, which
Read Committed does not guarantee.

---

## 5. Protected playback

This is the most involved part of the system, and the part where a small
simplification does the most damage.

### The chain

Ordered cheapest-rejection-first:

1. Authenticated — the guard already ran
2. Account active — the guard already ran
3. **Issuance rate limit** — a Redis counter; the cheapest possible refusal
4. **Video exists and is READY** — one indexed read
5. **Course and lesson access** — the access engine
6. **Device authorized** — device binding
7. **Concurrency slot free** — Redis
8. **Mint ticket and signed URL** — only now does a URL exist

Nothing produces a playable URL except step 8, and step 8 is unreachable
without steps 3–7.

### Why manifests are generated, not served

A packaged HLS playlist is written once, at transcode time, and is byte-identical
for every viewer. There is nowhere in it to put a per-viewer signature.

So the master and media playlists are generated per request:

- every segment URI is rewritten to a URL signed for **this** viewer
  (user + session + device + ticket, all inside the HMAC);
- `EXT-X-KEY` points at this API, so the AES key is handed out only against a
  live ticket;
- renditions above the server-chosen ceiling are simply omitted, which is a
  much stronger control than asking the player to behave.

The cost is one small dynamic response per playlist request. The benefit is
that a copied manifest URL is useless to anyone else, immediately, rather than
after its expiry.

### Keys are derived, not stored

```ts
key = HMAC-SHA256(HLS_KEY_ROOT, "hls-key:" + videoId).subarray(0, 16)
```

The transcoding worker and the API both derive it, so they always agree, and
there is no key table to leak. Rotating `HLS_KEY_ROOT` invalidates every
existing encrypted asset — which is documented as a re-transcode operation, not
a config tweak.

### The edge

A Cloudflare Worker (`docs/cloudflare-worker.js`) sits in front of the private
bucket and verifies the same HMAC. It also asks the API whether the ticket is
still live, cached for ten seconds — because a signature proves who minted the
URL, not that the grant survived the last thirty seconds.

That probe **fails open** on a network error, deliberately: the signature has
already been verified, so failing closed would trade a large availability loss
for a small security gain on an already-authenticated request.

---

## 6. Device binding

One authorized device per student. Two decisions worth preserving:

**Binding gates content, not login.** A student with a new phone can still sign
in, see their courses, read announcements and contact support. Only protected
playback and protected materials are refused. Blocking login outright generates
support tickets from people who cannot reach the "request a device change"
screen — the very screen that would solve their problem.

**The first device auto-binds.** Requiring approval for every registration
makes onboarding unusable. The anti-sharing value comes from the *second*
device being refused, not the first being scrutinised.

Staff are never device-bound; they work from desktops.

---

## 7. Security events

The system **observes and scores**; it does not punish.

Automatic bans on weak heuristics turn a flaky network or a shared family
tablet into a locked-out student, and the support cost of that exceeds the
piracy it prevents. So:

- every event is persisted server-side, where a patched client cannot strip it;
- Redis counters let the playback service make a *bounded, reversible* decision
  — end this playback session;
- a risk score is surfaced to humans, who decide on suspensions.

The only automatic enforcement in the entire system is "too many capture
attempts ends this playback session". The account is untouched. This is spec
§91 taken literally.

---

## 8. Background work

BullMQ over Redis. Four queues: `video`, `push`, `maintenance`, `analytics`.

Scheduled work uses **BullMQ repeatable jobs**, not `@nestjs/schedule`
decorators. A decorator-based cron fires once per replica, so a three-replica
deployment runs every sweep three times. A repeatable job is claimed by exactly
one worker.

The maintenance sweeps (expire enrolments, expire codes, reclaim abandoned
stream slots, prune stale tickets) only ever **change state**. None of them
deletes a business record. That is a rule, not an implementation detail: a
scheduled job that can delete history is a scheduled job that will, eventually,
delete the wrong history.

---

## 9. Search

Indexed `ILIKE '%term%'` rather than PostgreSQL full-text search.

FTS stems whole lexemes per language and needs to know which language a row is
in. This corpus is bilingual Arabic/English, often within one row, titles are
short, and students type partial words — which is precisely where FTS
underperforms a substring match. `pg_trgm` is the documented upgrade path
(`prisma/optional/001_search_trigram.sql`), applied by a DBA when `EXPLAIN`
starts showing sequential scans that matter.

It lives outside `prisma/migrations/` because `CREATE EXTENSION` needs
privileges some managed providers do not grant, and a failed extension creation
must not abort a deployment.

---

## 10. Caching

Redis holds three things and no more:

- **rate-limit counters** — shared across replicas, which the in-memory default
  is not (an N-replica deployment would silently allow N× the login limit);
- **playback stream slots** — the concurrency control;
- **queues**.

Course and catalogue data are *not* cached. Prisma's `relationJoins` preview
keeps the list queries to one round trip, and a cache here would introduce
staleness in exactly the surface — "is this course still published, am I still
enrolled" — where staleness is a correctness bug rather than a latency win.

---

## 11. Where responsibility sits

| Concern | Owner | Not owned by |
| --- | --- | --- |
| May this student see this content? | `CourseAccessService` | any controller |
| Is this device allowed? | `DevicesService` | the playback service |
| What does the watermark say? | `PlaybackService` (server-composed) | the app |
| What did this payment cost? | the `Payment` row | the course's current price |
| Which sections exist? | `CourseSection` rows | any hardcoded template |
| Is the session still valid? | `JwtAuthGuard`, every request | the token's expiry alone |

The right-hand column is the list of shortcuts that would each look like a
simplification and each be a bug.
