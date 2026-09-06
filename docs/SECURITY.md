# Security

The threat this system is actually built against is not a nation-state. It is
a determined student with a rooted phone, a screen recorder, and a group chat
of two hundred classmates who would rather not pay. Every control below is
sized for that adversary, and where a control cannot beat them, this document
says so rather than pretending otherwise.

The governing rule, from the specification and taken literally throughout:

> The mobile application is NOT trusted. Hiding "Watch Video" does NOT secure a
> video.

---

## 1. Passwords

argon2id, at the OWASP floor: 19 MiB memory, `t=2`, `p=1`, configurable upward
via `ARGON_*`.

bcrypt was rejected for two reasons: it silently truncates input at 72 bytes,
and it has no memory hardness, which matters for a user population that picks
short passwords. Memory hardness is what makes GPU cracking expensive, and that
is the realistic attack on a leaked table of Egyptian mobile numbers and
six-character passwords.

Login timing is flattened: when a phone number does not exist, the service
verifies against a decoy hash so the response takes comparable time. Without
that, response latency is an account-enumeration oracle.

Failed attempts increment a counter and lock the account temporarily. The lock
is time-based rather than permanent, because a permanent lock hands any
attacker a denial-of-service tool against any student whose phone number they
know.

---

## 2. Tokens

Three separate signing domains, three separate secrets:

| Token | Secret | Lifetime | Carries |
| --- | --- | --- | --- |
| Access | `JWT_ACCESS_SECRET` | 15 min | `sub`, `sid`, `role` |
| Refresh | `JWT_REFRESH_SECRET` | 30 days | family id, rotation pointer |
| Playback grant | `JWT_PLAYBACK_SECRET` | ticket TTL | ticket, viewer binding |

They are separate so a token from one domain can never be replayed in another.
A media grant that could be presented as a session token would be a complete
authentication bypass, and secret separation is what makes that structurally
impossible rather than merely unlikely.

### Rotation and reuse detection

Every refresh exchanges the token for a new one and marks the old one used.
Presenting a used token means one of two things — a replay, or a theft — and
in both cases the correct response is the same: revoke the entire family.

The consequence is that a thief and the victim are both signed out, and the
victim notices. A system that silently allowed the reuse would let a stolen
token live for thirty days in silence.

### Revocation actually revokes

A JWT is valid until it expires; that is the whole point of the format and also
its problem. So `JwtAuthGuard` performs one indexed lookup per request and
checks three things beyond the signature:

- the session exists and is `ACTIVE`
- the account is `ACTIVE`
- the token was issued after the user's `credentialsChangedAt`

Revocation therefore takes effect within **one request**, not one token
lifetime. The cost is a single indexed read per request, which is the right
trade for being able to cut off a shared account immediately.

---

## 3. Authorization

Three layers, each doing something the others cannot:

1. **`JwtAuthGuard`** — global, so every route is protected unless it carries
   `@Public()`. Forgetting the decorator makes a route unreachable, not open.
2. **`RolesGuard`** — coarse role gate from `@Roles(...)`. `MASTER` is **not**
   implicitly granted; every route lists its roles explicitly, so a reader can
   tell who may call it from the decorator alone.
3. **Service-level resource checks** — "is this teacher assigned to this
   course", "does this student have access". These live in the services because
   they need the resource loaded anyway and a guard would duplicate the query.

`CourseAccessService` is the single authority for content access. There is no
second implementation, which is what stops a new endpoint from quietly
implementing a laxer version of the rules.

### The master account

Exactly one, created only by `scripts/create-master.ts`. Defended three ways:

- the script refuses to run if a non-deleted `MASTER` exists, re-checked inside
  the transaction against a concurrent run;
- `UsersService.create()` rejects `role: MASTER` unconditionally, so no
  administrative endpoint can mint one;
- the registration DTO whitelists its fields, so a client cannot smuggle a role
  through.

There is no create-master endpoint at all. An HTTP route that creates the
platform owner is a privilege-escalation surface that exists forever, however
well it is guarded at first.

---

## 4. Device binding

One authorized device per student, enforced on **protected content** rather
than on login.

That distinction is the whole design. A student who buys a new phone can still
sign in, see their courses, read announcements, and reach the "request a device
change" screen. Refusing the login instead would lock them out of the very
screen that solves their problem, and the support cost of that exceeds the
sharing it prevents.

What the binding actually catches: two people using one account simultaneously
from two handsets. What it does not catch: two people taking turns on one
handset. That is an accepted limit — detecting it would require behavioural
profiling with a false-positive rate that punishes siblings sharing a tablet.

The client-reported integrity signal (`X-Device-Integrity`) is a **hint**. It
is forgeable in both directions by a patched app, so it feeds a security event
and, when `DEVICE_BLOCK_ON_INTEGRITY_FAILURE=true`, blocks protected playback.
Real server-side attestation (Play Integrity, App Attest) is the documented
upgrade; until then the signal is treated as evidence, not proof.

---

## 5. Protected video

### No permanent URL exists

There is no code path in the system that returns a durable media URL. The
source upload is never served to a student at all — it lives under a bucket
prefix that the edge Worker refuses outright, whatever signature accompanies
the request.

### The authorization chain

Eight steps, ordered so the cheapest refusal happens first:

```
authenticated → account active → issuance rate limit → video READY
→ course/lesson access → device authorized → concurrency slot → mint
```

A URL comes into existence only at step 8, and step 8 is unreachable without
steps 3–7. Every refusal is recorded as a security event, because the *pattern*
is the signal: one `DEVICE_MISMATCH` is a student with a new phone; forty in an
hour is a shared account.

### Viewer-bound manifests

A packaged HLS playlist is written once at transcode time and is identical for
every viewer — there is nowhere in it to put a per-viewer signature. So the
manifests are generated per request:

- each segment URI is signed with an HMAC covering
  `objectKey + expiry + user + session + device + ticket + quality ceiling`;
- `EXT-X-KEY` points at this API, so the AES key is handed out only against a
  live ticket;
- renditions above the server-chosen ceiling are omitted, which is stronger
  than asking the player to behave.

A manifest URL copied into a group chat therefore fails at the edge for
everyone else — immediately, not after expiry.

### Keys are derived

```
key = HMAC-SHA256(HLS_KEY_ROOT, "hls-key:" + videoId)[0..16]
```

Both the transcoder and the API derive it, so they always agree, and there is
no key table to leak. Rotating `HLS_KEY_ROOT` invalidates every encrypted asset
in storage — a re-transcode operation, not a configuration change.

### Concurrency

One protected stream per account by default, tracked in Redis with a heartbeat
and a grace period. A second concurrent stream is refused with
`CONCURRENT_STREAM_LIMIT`.

This is one of the more effective anti-sharing controls, because credential
sharing is only useful if two people can watch at once. The grace period exists
so that a crashed app does not lock its owner out for the full ticket TTL.

### What this does not stop

Stated plainly, because a security document that only lists wins is not useful:

- **A camera pointed at the screen.** Nothing stops this. The watermark is the
  answer — it makes the recording attributable, which changes the incentive
  even though it does not prevent the act.
- **A rooted device with a patched player.** AES-128 HLS keys reach the client
  by necessity. Widevine L1 / FairPlay raise this bar considerably and the
  architecture is DRM-ready (`DRM_*` configuration, per-ticket license
  parameters), but until a provider is wired up, a determined rooted device can
  extract content.
- **HDMI capture on an unpatched Android build.** External-display detection is
  client-side and therefore defeatable.

The honest summary: this system makes casual sharing impractical and
deliberate piracy attributable. It does not make content unextractable, and no
system that decrypts on a device the attacker controls can.

---

## 6. The dynamic watermark

Composed **server-side** and returned inside the ticket: student name, a
truncated user id, and an unpredictable per-grant `sessionTag` derived from
`HMAC(userId, videoId, random)`.

Server composition is the point. A patched client cannot substitute another
student's name, so a leaked recording remains attributable to the account that
made it. The client renders the mark and moves it; it never supplies the text.

`PlaybackTicket.watermarkTag` is stored, so a `sessionTag` read off a leaked
recording resolves to exactly one grant: one student, one device, one moment.

---

## 7. Security events

**The system observes and scores. It does not punish.**

Automatic bans on weak heuristics turn a flaky network or a shared family
tablet into a locked-out student. So:

- every event is persisted server-side, where a patched client cannot strip it;
- Redis counters let playback make a *bounded, reversible* decision;
- a risk score is surfaced to humans, who decide on suspensions.

The **only** automatic enforcement in the entire system is: too many capture
attempts within one playback session ends that playback session. The account is
untouched. The student can start a new session immediately, which re-runs the
whole authorization chain.

Every administrative action that overrides this — suspending an account,
revoking a device, ending someone's sessions — is a deliberate human act and is
written to the append-only audit log with the actor's identity.

---

## 8. Input handling

A global `ValidationPipe` with `whitelist: true` and
`forbidNonWhitelisted: true`. Unknown properties are **rejected**, not
stripped-and-ignored, which is what stops `role: "MASTER"` riding along on a
registration payload.

All database access goes through Prisma's parameterised query builder. Three
`$queryRaw` call sites exist for aggregate reporting, and all three compose
`Prisma.sql` fragments — no value is ever interpolated into a template string.
(One of these was a genuine injection risk during development, caught in review
and fixed; it is called out here so the pattern is not reintroduced.)

Money-handling transactions run at Serializable isolation. Code redemption
additionally relies on a `@@unique([codeId, userId])` index, so the guarantee
survives even if the isolation level were lowered by mistake.

---

## 9. Rate limiting

Redis-backed, so the limit is shared across replicas. The in-memory default
gives each replica its own counter, which silently allows N× the configured
limit on the login endpoint — exactly the wrong place for that.

Keying:

- authenticated → user id
- anonymous → leftmost `X-Forwarded-For` (only trustworthy when `TRUST_PROXY`
  is on and the balancer overwrites the header)
- credential endpoints → additionally the submitted phone, so one attacker
  behind a NAT cannot exhaust the limit for an entire building, and password
  spraying across many accounts still trips it

---

## 10. Secrets

Nothing sensitive is in source. `src/config/env.validation.ts` refuses to boot
when a required secret is missing, malformed, or still set to a `CHANGE_ME`
placeholder — failing loudly at startup rather than serving traffic with a
default key.

Five secrets must be distinct: `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
`JWT_PLAYBACK_SECRET`, `HLS_KEY_ROOT`, `MEDIA_SIGNING_KEY`.

Rotation cost, worth knowing before you rotate:

| Secret | Effect of rotating |
| --- | --- |
| `JWT_ACCESS_SECRET` | Everyone re-authenticates within 15 minutes. Cheap. |
| `JWT_REFRESH_SECRET` | Everyone signs in again. Disruptive but safe. |
| `JWT_PLAYBACK_SECRET` | In-flight playback fails; the app requests new tickets. Nearly invisible. |
| `MEDIA_SIGNING_KEY` | Must change in the API **and** the Worker together, or all media 403s. |
| `HLS_KEY_ROOT` | **Every encrypted asset must be re-transcoded.** Not a config change. |

---

## 11. Logging

Structured JSON via pino. Passwords, tokens, hashes and provider secrets are
never logged; the audit service additionally redacts a deny-list of keys before
storing any snapshot, so an audit row cannot itself become a breach vector.

Every response carries `X-Request-Id`, which is the join key between a student's
support screenshot and the server logs.

In production, `AllExceptionsFilter` returns the error code and a human message
and nothing else — no stack trace, no query text, no internal identifiers.

---

## 12. Transport

- HSTS with preload in production
- `helmet` with a conservative header set; CSP is off because this API serves
  JSON and signed redirects, never HTML
- CORS from an explicit allow-list. Native apps send no `Origin` header and are
  unaffected; the list exists for the admin dashboard. Wildcard CORS in
  production is refused at boot.
- TLS terminates at the load balancer; `TRUST_PROXY=true` is required there so
  the real client IP reaches the rate limiter

---

## 13. Reporting a vulnerability

Do not open a public issue. Contact the platform owner directly with the
request id and timestamp if you have one.

If you believe content has been extracted and leaked, the `sessionTag` visible
in the watermark of the leaked recording identifies the exact grant — send that
string, and the audit trail resolves it to one account, device and session.
