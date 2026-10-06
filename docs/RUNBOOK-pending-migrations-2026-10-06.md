# Runbook — apply the pending Prisma migrations to production (2026-10-06)

Fixes `GET /api/v1/home/feed` → 500 (`column notifications.dedupeKey does not exist`)
for the web **and** the mobile app. No code change is involved: the code on Render
(commit `d2f8cb2`, which contains `4b70487`) already expects these migrations.

## What will be applied

`prisma migrate deploy` applies, in order, whichever of these are not yet in
`_prisma_migrations` (`20260930000000_…` is already applied — `catalog/academic-years`
answers 200 in production):

| Migration | Change | Destructive? |
|---|---|---|
| `20261004220000_playback_ticket_user_video_index` | `CREATE INDEX IF NOT EXISTS playback_tickets(userId, videoId)` | No |
| `20261005010000_part_purchase_code_many_per_card` | `DROP INDEX IF EXISTS course_part_purchases_accessCodeId_key` (a UNIQUE index) + `CREATE INDEX IF NOT EXISTS …_accessCodeId_idx` | No data touched; removes a uniqueness constraint (intended: one card, many students) |
| `20261006090000_announcement_sweep_and_list_indexes` | Two `CREATE INDEX` on `announcement_dispatches`, `announcements` | No |
| `20261006120000_notification_dedupe_key` | `ALTER TABLE notifications ADD COLUMN "dedupeKey" TEXT` (nullable) + `CREATE UNIQUE INDEX notifications_dedupeKey_key` | No — column is new and NULL everywhere, so the unique index cannot conflict |

Each runs inside Prisma's transaction. The index builds are not `CONCURRENTLY`, so
they take a short write lock on their table — run at a quiet time.

## Target

Neon Postgres — project host `ep-blue-smoke-b1d1nuj1.c-5.eu-central-1.aws.neon.tech`,
database `neondb` (the host in `edu-backend/.env`). **Step 1 confirms this is really
the database Render uses.** Use the **direct** host (no `-pooler`): Prisma Migrate
needs a session-level advisory lock that PgBouncer's transaction mode does not give.

## Commands (Windows PowerShell, from the backend repo)

```powershell
cd C:\Users\mahmoud\Desktop\edu-backend

# 0. The checkout must match what Render runs.
git rev-parse --short HEAD          # expect d2f8cb2

# 1. Render dashboard → student-backend → Environment → copy DATABASE_URL.
#    Confirm its host is ep-blue-smoke-b1d1nuj1-pooler… and database neondb.
#    Paste it below with "-pooler" removed from the host (direct endpoint).
$env:DATABASE_URL = "postgresql://<user>:<password>@ep-blue-smoke-b1d1nuj1.c-5.eu-central-1.aws.neon.tech/neondb?sslmode=require"

# 2. (Recommended) Neon console → Branches → create branch "pre-2026-10-06" from main (instant snapshot).

# 3. Read-only check — lists what is pending. Must NOT mention failed migrations or drift.
npx prisma migrate status

# 4. Apply.
npx prisma migrate deploy

# 5. Verify.
npx prisma migrate status           # "Database schema is up to date!"
Remove-Item Env:DATABASE_URL
```

If step 3 reports a **failed** migration or **drift**, stop — `migrate deploy` will
not fix that; reconcile by hand.

## After

- `https://student-backend-814y.onrender.com/api/v1/meta/health` → `status: ok`
- Signed in (web or app): home loads; `/api/proxy/home/feed` → 200;
  `/api/proxy/notifications` (list) → 200.

## Prevent recurrence — Render pre-deploy command

Nothing in this repo's deploy path runs migrations (`Dockerfile` CMD only starts the
API; there is no `render.yaml`). `docs/DEPLOYMENT.md` says: migrate as a separate
release step, then gate, then roll. On Render that is the **Pre-Deploy Command**
(Settings → Build & Deploy; available on paid instance types). It runs in the newly
built image before the new version receives traffic, and a non-zero exit cancels
the deploy.

1. Environment → add `DIRECT_DATABASE_URL` = the direct (non-`-pooler`) Neon URL.
2. Settings → Build & Deploy → Pre-Deploy Command:

```sh
sh -c 'DATABASE_URL="$DIRECT_DATABASE_URL" npx prisma migrate deploy && DATABASE_URL="$DIRECT_DATABASE_URL" node dist/scripts/migration-gate.js'
```

`migration-gate.js` is `npm run db:gate:prod`; it exits non-zero on pending
migrations, drift or an unreachable database, so a broken release stops before it
serves traffic. The API itself keeps using the pooled `DATABASE_URL`.

If the service is on a free instance (no pre-deploy command), run steps 3–5 above
manually **before** pushing any commit that adds a migration — the API must never
roll ahead of its schema.
