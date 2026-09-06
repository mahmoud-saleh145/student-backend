# MANUAL STEPS REQUIRED

Everything in this list needs a human. Each step says **what** to do, **where**,
**why it matters**, **what value** you need, **where the value goes**, and
**how to verify** it worked.

Steps 1–6 get you running locally. Steps 7–14 are for production. Steps 15–17
are optional until you need them.

Nothing here assumes prior knowledge of Cloudflare, Prisma or NestJS.

---

## Step 1 — Install the tools

**What.** Node.js 20.11 or newer, Docker Desktop, and Git.

**Where.** Your machine.

**Why.** The API needs Node 20 for the crypto APIs it uses. Docker runs
PostgreSQL, Redis and a local S3 stand-in so you do not have to install those
three separately.

**What you need.** Nothing but the downloads:
Node from <https://nodejs.org>, Docker from <https://docker.com>.

**Verify.**

```bash
node --version      # v20.11.0 or higher
docker --version
docker compose version
```

If `node --version` prints v18 or lower, the API will fail to start with a
crypto error. Upgrade before continuing.

---

## Step 2 — Start the local infrastructure

**What.** Bring up PostgreSQL, Redis and MinIO.

**Where.** A terminal in the backend project folder.

**Why.** PostgreSQL stores all the data, Redis handles rate limiting and the
job queues, and MinIO pretends to be Cloudflare R2 so you can develop the video
pipeline without a Cloudflare account.

**Do it.**

```bash
docker compose up -d postgres redis minio
```

**Verify.**

```bash
docker compose ps
```

All three should read `running` (postgres and redis should also read
`healthy`). If a port is already taken, something else on your machine is using
5432, 6379 or 9000 — stop it, or change the left-hand side of the port mapping
in `docker-compose.yml`.

---

## Step 3 — Create your environment file and generate secrets

**What.** Copy the template and fill in five secrets.

**Where.** The project root. The file must be named exactly `.env`.

**Why.** The application validates its configuration at startup and **refuses
to boot** if a required secret is missing or still says `CHANGE_ME`. That is
deliberate — a backend running with a default signing key is worse than one
that will not start.

**Do it.**

```bash
cp .env.example .env
```

Then generate the secrets:

```bash
for v in JWT_ACCESS_SECRET JWT_REFRESH_SECRET JWT_PLAYBACK_SECRET \
         HLS_KEY_ROOT MEDIA_SIGNING_KEY; do
  echo "$v=$(openssl rand -base64 48 | tr -d '\n')"
done
```

That prints five lines. Copy each one over the matching `CHANGE_ME…` line in
`.env`.

**They must all be different from each other.** Reusing one value across two
would mean a token minted for one purpose could be replayed as another — for
instance, a short-lived video grant presented as a login session.

What each one protects:

| Variable | Protects |
| --- | --- |
| `JWT_ACCESS_SECRET` | 15-minute session tokens |
| `JWT_REFRESH_SECRET` | 30-day refresh tokens |
| `JWT_PLAYBACK_SECRET` | Short-lived video playback grants |
| `HLS_KEY_ROOT` | The root from which every video's AES key is derived |
| `MEDIA_SIGNING_KEY` | Signatures on media URLs, shared with the edge Worker |

**Verify.** After step 5, `npm run start:dev` should print
`API listening on :3000`. If it exits immediately with a configuration error,
the message names the exact variable that is wrong.

**Never commit `.env`.** It is already in `.gitignore`; leave it there.

---

## Step 4 — Install dependencies

```bash
npm install
```

**Verify.** `ls node_modules/@prisma/client` exists. If `npm install` fails on
`argon2`, you are missing build tools:

- macOS: `xcode-select --install`
- Ubuntu/Debian: `sudo apt-get install -y build-essential python3`
- Windows: use WSL2 rather than native Windows

---

## Step 5 — Create the database schema and demo data

```bash
npm run db:setup
```

That runs three things: `prisma generate` (builds the typed client),
`prisma migrate deploy` (creates 39 tables and 24 enum types), and `seed`
(inserts development data).

**Verify.**

```bash
docker compose exec postgres psql -U edu -d edu_platform -c '\dt' | head -20
```

You should see tables including `users`, `courses`, `payments` and
`playback_tickets`.

The seed prints the development accounts when it finishes. All use the password
`DevPassword123!`:

| Role | Phone |
| --- | --- |
| ADMIN | `01000000001` |
| TEACHER | `01000000002` |
| TEACHER | `01000000003` |
| STUDENT | `01000000010` |
| STUDENT | `01000000011` |

The seed refuses to run if the database already contains payment rows. That is
a guard against seeding over real data, not a bug.

---

## Step 6 — Create the Master account

**What.** Create the single platform-owner account.

**Where.** A terminal in the project folder.

**Why.** There is exactly one Master and it can do everything: manage admins,
read all financial data, change platform settings. Because of that, **no API
endpoint can create one**. The only way is this script, which requires shell
access to a machine that already has the database credentials. That is a real
privilege boundary rather than an asserted one.

The seed deliberately does not create it, so that `npm run db:setup` — which
you might run casually — can never produce a platform owner.

**Do it.**

```bash
npm run bootstrap:master
```

It asks for a phone number (Egyptian format, `01XXXXXXXXX`), a full name, an
optional email, and a password. The password must be at least 16 characters
with upper, lower, digit and symbol, and cannot contain a common word. Typing
is hidden.

**What value you need.** A phone number you control and a password from your
password manager. **Write it down before you type it** — it cannot be
recovered, only rotated.

**Verify.**

```bash
docker compose exec postgres psql -U edu -d edu_platform \
  -c "SELECT id, phone, role, status FROM users WHERE role = 'MASTER';"
```

Exactly one row. Run the script a second time and it refuses — that is the
duplicate protection working.

To change the password later:

```bash
npm run bootstrap:master -- --reset-password
```

That also revokes every existing Master session, so a stolen session cannot
survive the rotation.

---

## Step 7 — Set up Cloudflare R2

**What.** Create the object storage that holds videos, thumbnails and PDFs.

**Where.** <https://dash.cloudflare.com> → R2.

**Why.** Videos never go in PostgreSQL. R2 is used rather than S3 because it
charges nothing for egress, and video egress is the dominant cost of a platform
like this — the difference is thousands of dollars a year at moderate scale.

**Do it.**

1. Sign in to Cloudflare. R2 requires a payment method even on the free tier.
2. **R2 → Create bucket** → name it `edu-media-prod`, location Automatic.
3. Create a second bucket, `edu-uploads-prod`.
4. **Leave public access DISABLED on both.** This is the single most important
   setting on this page. A public bucket makes every other protection in the
   system irrelevant.
5. **R2 → Manage API Tokens → Create API Token.**
   - Permission: **Object Read & Write**
   - Scope: the two buckets above, nothing else
   - TTL: no expiry (rotate manually instead)
6. Copy the three values it shows you **now** — the secret is displayed once.

**What value you need and where it goes.** In `.env`:

```bash
R2_ACCOUNT_ID=<the 32-character hex id in your dashboard URL>
R2_ACCESS_KEY_ID=<from the token screen>
R2_SECRET_ACCESS_KEY=<from the token screen — shown once>
R2_BUCKET_MEDIA=edu-media-prod
R2_BUCKET_UPLOADS=edu-uploads-prod
R2_REGION=auto
```

`R2_ENDPOINT` can stay empty; it is derived from the account id.

**Verify.**

```bash
curl http://localhost:3000/api/v1/meta/health/deep
```

The `storage` entry should read `up`.

Then confirm the bucket is genuinely private:

```bash
curl -I https://<account-id>.r2.cloudflarestorage.com/edu-media-prod/test.txt
```

Must return 401 or 403. **If it returns 200 or 404 with a public-looking
response, stop and fix the bucket's public access setting before going
further.**

---

## Step 8 — Deploy the media edge Worker

**What.** A small Cloudflare Worker that sits in front of the bucket and checks
signatures.

**Where.** Cloudflare Workers, using the `wrangler` CLI.

**Why.** This is what makes a copied video URL useless.

A plain presigned URL is bound to an object and a clock — anyone holding the
string can fetch the bytes. The signature this Worker verifies additionally
covers **who** the URL was minted for: user, session, device and playback
ticket. A student who pastes their manifest URL into a group chat gives their
classmates a link that fails immediately at the edge.

Without this Worker, the API falls back to plain presigned URLs and logs a
warning on every one. That is acceptable in development and **not acceptable in
production**.

**Do it.**

```bash
npm install -g wrangler
wrangler login

npm create cloudflare@latest edu-media-gate
cd edu-media-gate
```

Replace `src/index.js` with the contents of
[`docs/cloudflare-worker.js`](cloudflare-worker.js) from this repository, then
set `wrangler.toml` to:

```toml
name = "edu-media-gate"
main = "src/index.js"
compatibility_date = "2025-01-01"

[[r2_buckets]]
binding = "MEDIA"
bucket_name = "edu-media-prod"

[vars]
API_ORIGIN = "https://api.yourdomain.com"
TICKET_CHECK = "true"
```

Then:

```bash
wrangler secret put MEDIA_SIGNING_KEY
# paste the EXACT same value as MEDIA_SIGNING_KEY in your .env
wrangler deploy
```

Finally, in the Cloudflare dashboard: **Workers → edu-media-gate → Settings →
Domains & Routes → Add custom domain** → `media.yourdomain.com`.

**What value you need and where it goes.** Back in `.env`:

```bash
MEDIA_CDN_BASE_URL=https://media.yourdomain.com/
```

**Verify.**

```bash
curl -I https://media.yourdomain.com/hls/anything/master.m3u8
```

Expect **403** with an `x-deny-reason: unsigned` header. A 200 here means the
Worker is not checking signatures; a 404 means the route is not attached.

Then request a playback ticket from the app and confirm the video plays. If it
403s with `x-deny-reason: bad_signature`, the `MEDIA_SIGNING_KEY` values differ
between the API and the Worker — they must be byte-identical.

---

## Step 9 — Provision production PostgreSQL

**What.** A managed PostgreSQL 16 instance.

**Where.** Neon, Supabase, Railway, AWS RDS, DigitalOcean — any of them work.

**Why.** Managed, not self-hosted, because automated backups and
point-in-time recovery are the difference between a bad hour and a lost
business. This database holds every payment record on the platform.

**What value you need and where it goes.**

```bash
DATABASE_URL=postgresql://user:password@host:5432/dbname?schema=public&sslmode=require&connection_limit=10&pool_timeout=20
```

`connection_limit` is **per process**. Your total is
`API replicas × 10 + worker replicas × 5`, and it must stay comfortably under
the instance's `max_connections`.

**Apply the schema:**

```bash
DATABASE_URL="<production url>" npx prisma migrate deploy
```

Run this as a **separate deployment step, before** the application starts. Two
replicas booting at once and both running migrations is a race you do not want
to debug.

**Do NOT run the seed against production.** It refuses when `NODE_ENV=production`
unless you also set `ALLOW_PROD_SEED=1`, which exists only for a deliberate
staging refresh.

**Verify.**

```bash
DATABASE_URL="<production url>" npx prisma migrate status
```

Should report the database is up to date. Then confirm automated backups are
enabled in your provider's dashboard, and note the retention window.

---

## Step 10 — Provision production Redis

**What.** A managed Redis 7 instance.

**Where.** Upstash, Redis Cloud, Railway, AWS ElastiCache.

**Why.** Three jobs: rate-limit counters shared across API replicas, playback
concurrency slots, and the background job queue.

The "shared across replicas" part matters more than it sounds. Without Redis,
each replica keeps its own counter, so a three-replica deployment silently
allows three times the configured login rate limit.

**What value you need and where it goes.**

```bash
REDIS_URL=rediss://default:password@host:6379
REDIS_PREFIX=edu
```

Note `rediss://` with two s-es for TLS. Enable persistence (AOF) so queued jobs
survive a restart.

**Verify.** `curl https://api.yourdomain.com/api/v1/meta/health/deep` shows
`redis: up`.

---

## Step 11 — Deploy the API and the worker as two services

**What.** Two deployments from the same Docker image.

**Where.** Railway, Render, Fly.io, AWS ECS, or your own Kubernetes.

**Why two.** Transcoding a one-hour lecture takes 20–40 minutes of pegged CPU.
If that runs in the same process as the API, every student request queues
behind it. They also scale on completely different signals: the API on request
rate, the worker on queue depth.

**Configuration.**

| | API service | Worker service |
| --- | --- | --- |
| Command | `node dist/main.js` | `node dist/worker.js` |
| `RUN_WORKERS` | leave unset | `true` |
| Port | 3000 | none |
| CPU / RAM | 1 vCPU / 1 GB | 4 vCPU / 8 GB |
| Disk | minimal | **100 GB** scratch |
| Replicas | 2+ | 1+ |
| Health check | `/api/v1/meta/health` | none |

Both need the identical environment from steps 3, 7, 9 and 10, plus:

```bash
NODE_ENV=production
PUBLIC_API_URL=https://api.yourdomain.com
CORS_ORIGINS=https://admin.yourdomain.com
TRUST_PROXY=true
LOG_PRETTY=false
LOG_LEVEL=info
```

`TRUST_PROXY=true` is required behind a load balancer. Without it every request
appears to come from the balancer's IP, and the rate limiter treats your entire
user base as one client — the first school to have thirty students on one Wi-Fi
network will get everyone throttled.

**Verify.**

```bash
curl https://api.yourdomain.com/api/v1/meta/health
# {"success":true,"data":{"status":"ok",...}}
```

For the worker: upload a video through the API and watch its status move
`QUEUED → PROCESSING → READY`. If it stays `QUEUED`, the worker is not running
or `RUN_WORKERS` is not set.

---

## Step 12 — Point a domain at the API

**What.** DNS and TLS.

**Where.** Your DNS provider.

**Why.** The mobile app pins a base URL, and HTTPS is not optional — the app
transmits bearer tokens on every request.

**Do it.** Create an `A` or `CNAME` record for `api.yourdomain.com` pointing at
your hosting platform, and let the platform issue the certificate (all of the
providers listed above do this automatically).

**Verify.**

```bash
curl -I https://api.yourdomain.com/api/v1/meta/health
```

200, and the response includes a `strict-transport-security` header. If HSTS is
missing, `NODE_ENV` is not set to `production`.

---

## Step 13 — Configure push notifications

**What.** An Expo access token.

**Where.** <https://expo.dev> → your account → Access Tokens.

**Why.** Without it, push sends are unauthenticated and heavily rate-limited by
Expo. Notifications still appear in the app's inbox either way — push is the
buzz, not the message — but they will not reach a backgrounded phone reliably.

**What value you need and where it goes.**

```bash
PUSH_PROVIDER=expo
EXPO_ACCESS_TOKEN=<token from expo.dev>
```

You do **not** need to configure Apple APNs or Google FCM credentials here.
Expo handles both, using the credentials attached to the mobile app's own EAS
project. That is a mobile-side step, not a backend one.

**Verify.** Send an announcement from an admin account and confirm a seeded
student's device receives it. In the worker logs you should see
`push delivered N, failed 0`.

---

## Step 14 — Set up monitoring

**What.** Alerts on the signals that matter.

**Where.** Your hosting platform's built-in monitoring, plus optionally Sentry.

**Why.** The failure modes here are quiet. A stuck transcode queue does not
page anyone; teachers just notice their videos never appear.

Worth alerting on:

| Signal | Threshold |
| --- | --- |
| 5xx rate | > 1% over 5 minutes |
| `video` queue depth | > 20, or rising steadily |
| Failed transcodes | any |
| Worker disk usage | > 80% |
| Database connections | > 80% of max |
| `SecurityEvent` rows with severity `CRITICAL` | any |

For Sentry, add `SENTRY_DSN=<your dsn>` to `.env`.

Do **not** alert on individual `DEVICE_MISMATCH` events. One is a student with
a new phone. Alert on the rate, not the event.

---

## Step 15 — Payment provider (when you are ready to take money)

**What.** Paymob or Stripe credentials.

**Where.** <https://accept.paymob.com> (Egypt) or <https://stripe.com>.

**Why it can wait.** The platform is fully functional with
`PAYMENT_PROVIDER=none`. In that mode an admin confirms each payment manually
after a bank transfer or cash payment, through
`POST /admin/payments/:id/confirm`. Every record — amount, currency, price
version, revenue split — is written exactly as it would be with an automated
provider. Wiring a provider later changes how the money arrives, not how it is
recorded.

**For Paymob:**

```bash
PAYMENT_PROVIDER=paymob
PAYMOB_API_KEY=<Settings → Account Info>
PAYMOB_INTEGRATION_ID=<Developers → Payment Integrations>
PAYMOB_IFRAME_ID=<Developers → iframes>
PAYMOB_HMAC_SECRET=<Settings → Account Info → HMAC>
```

The HMAC secret is what verifies that a webhook actually came from Paymob. A
webhook endpoint that skips this check is an endpoint that lets anyone mark any
payment as paid.

Set the callback URL in the Paymob dashboard to:

```
https://api.yourdomain.com/api/v1/payments/webhooks/paymob
```

**Verify.** Make a real payment of the smallest allowed amount. Then check:

```sql
SELECT id, amount, status, "providerReference" FROM payments ORDER BY "createdAt" DESC LIMIT 1;
SELECT "grossAmount", "teacherAmount", "platformAmount" FROM revenue_ledger ORDER BY "createdAt" DESC LIMIT 1;
```

The payment should read `PAID` with the provider's reference, and exactly one
revenue row should exist. Send the webhook twice (the dashboard has a resend
button) and confirm there is still only one revenue row — that is the
idempotency guard doing its job.

---

## Step 16 — DRM (only if a rights-holder requires it)

**What.** Widevine and FairPlay licence services.

**Where.** A DRM provider — Axinom, EZDRM, BuyDRM.

**Why it can wait.** The current AES-128 HLS encryption, combined with
viewer-bound URLs, device binding and per-user watermarks, is a substantial
barrier. DRM raises it further by moving decryption into hardware the operating
system protects, which is what defeats a rooted device with a patched player.

It is genuinely expensive — a licence service plus per-stream fees — so it is
worth doing when a publisher demands it, not before.

**What value you need and where it goes.**

```bash
DRM_ENABLED=true
DRM_WIDEVINE_LICENSE_URL=<from your provider>
DRM_FAIRPLAY_LICENSE_URL=<from your provider>
DRM_FAIRPLAY_CERT_URL=<from your provider>
DRM_PROVIDER_TOKEN=<from your provider>
```

The backend already returns a populated `drm` block in every playback ticket
once these are set. The transcoding pipeline needs reconfiguring for CENC
packaging, which is a larger change — talk to the provider first.

**Verify.** The `drm.scheme` field in a playback ticket changes from `"none"`
to `"widevine"` or `"fairplay"` depending on the requesting platform.

---

## Step 17 — Search performance (only when it gets slow)

**What.** Apply `prisma/optional/001_search_trigram.sql`.

**Where.** `psql` against the production database, run by someone with
extension-creation rights.

**Why it is not in the normal migrations.** `CREATE EXTENSION` needs privileges
that several managed providers do not grant to the application role. If it ran
as part of `prisma migrate deploy`, a deployment on such a provider would abort
— turning a performance nicety into an outage.

**When.** When `EXPLAIN ANALYZE` on a search query shows a sequential scan
taking more than about 50 ms. Below roughly 50 000 rows this does nothing
useful and costs write throughput.

**Do it.**

```bash
psql "$DATABASE_URL" -f prisma/optional/001_search_trigram.sql
```

**Verify.**

```sql
EXPLAIN ANALYZE SELECT id FROM courses WHERE title ILIKE '%كيميا%';
```

Should now report a `Bitmap Index Scan on courses_title_trgm_idx`.

---

## Quick reference: the checklist

Local development:

- [ ] 1. Node 20+, Docker, Git installed
- [ ] 2. `docker compose up -d postgres redis minio`
- [ ] 3. `.env` created, five secrets generated and distinct
- [ ] 4. `npm install`
- [ ] 5. `npm run db:setup`
- [ ] 6. `npm run bootstrap:master`

Production:

- [ ] 7. R2 buckets created, **public access disabled**, credentials in `.env`
- [ ] 8. Edge Worker deployed, `MEDIA_SIGNING_KEY` matches, unsigned request 403s
- [ ] 9. Managed PostgreSQL, migrations applied, backups on
- [ ] 10. Managed Redis with persistence
- [ ] 11. API and worker deployed as separate services, `TRUST_PROXY=true`
- [ ] 12. Domain and TLS, HSTS header present
- [ ] 13. Expo access token
- [ ] 14. Alerts configured

When needed:

- [ ] 15. Payment provider
- [ ] 16. DRM
- [ ] 17. Trigram indexes

---

## Things that will bite you

Collected from the failure modes that are easy to hit and hard to diagnose.

**Committing `.env`.** Check `git status` before your first commit. If a secret
has ever been committed, rotating it is the only fix — removing the file from
the current tree does not remove it from history.

**Reusing one secret for several variables.** It looks harmless and it breaks
the separation between session tokens and media grants.

**Leaving the R2 bucket public.** Every other control in this system becomes
decoration. Test it with `curl` rather than assuming.

**Running `prisma migrate deploy` from inside the app's startup.** Works with
one replica, corrupts with two.

**Forgetting `TRUST_PROXY=true` in production.** Rate limiting sees one client
and throttles everyone.

**Rotating `HLS_KEY_ROOT`.** This is not a configuration change. Every
encrypted video in storage becomes undecryptable and must be re-transcoded.

**Running the seed against production.** It guards against this, but do not
find out how good the guard is.

**Deploying without the edge Worker.** The API silently falls back to presigned
URLs that are not viewer-bound. Search your logs for
`MEDIA_CDN_BASE_URL is not set` — if it appears in production, protected video
is effectively shareable.
