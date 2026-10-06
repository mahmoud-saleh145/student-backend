# Applying the pending migration to production Neon — runbook

**Root cause:** commit `1e69d33` ("upload features", 2026-10-01 00:53 +0300) is pushed and deployed, and it contains both the new Prisma models *and* the migration that creates their tables — but **nothing in the deploy pipeline ever runs `prisma migrate deploy`**. The Dockerfile runs `prisma generate` at build and `node dist/src/main.js` at start. So the Prisma **client** advanced to the new schema while the **database** stayed on `20260924100000_course_departments`.

Run these in order. Steps 1–2 are read-only.

---

## 0. Why you have to run this, not me

This session's egress policy blocks the Neon host, `api.render.com` and `student-backend-814y.onrender.com` (403 at the proxy), and Prisma's Linux `schema-engine` download is also blocked (403 from `binaries.prisma.sh`). So neither the cloud container nor the desktop Linux VM can reach the database or run the migrate CLI. Your Windows machine can do both — that's where `npx prisma generate` succeeded for you.

Run everything below from:

```
cd C:\Users\mahmoud\Desktop\edu-backend
```

---

## 1. Confirm the production DATABASE_URL (do this first)

Open the Render dashboard → the `student-backend` service → **Environment** → `DATABASE_URL`.

Compare its **host** and **database name** against your local `.env`, which currently points at:

```
host = ep-blue-smoke-b1d1nuj1-pooler.c-5.eu-central-1.aws.neon.tech
db   = neondb
```

- **If they match** → your local `.env` targets production, and step 3 will migrate the right database.
- **If they differ** → do **not** run step 3 with the local `.env`. Use Render's value explicitly (step 3 shows how).

This check is the one thing I cannot do for you, and getting it wrong means migrating the wrong database. Don't skip it.

---

## 2. Snapshot, then run the read-only diagnostic

**2a. Create a Neon branch** (instant, copy-on-write, free — this is your rollback):

Neon Console → your project → **Branches** → **New branch** from `production`, name it `pre-20260930-backup`.

**2b. Run the diagnostic.** Paste `prod-schema-diagnostic.sql` into the Neon SQL Editor (production branch), or:

```bat
psql "%DATABASE_URL%" -f prod-schema-diagnostic.sql
```

It is 100% `SELECT` — no DDL, no DML, no locks. It answers three of your questions at once:

| Section | Answers |
|---|---|
| 1–2 | migration history, and which of the 8 repo migrations are pending or failed |
| 3–5 | **every** missing table, column and enum across all 60 models / 808 columns / 41 enums |
| 6 | the specific objects `20260930` creates |
| 7 | which database you're actually connected to |
| 8 | row counts on the tables the migration touches |

**Read section 2 before continuing.** Expected result is `20260930000000_…` PENDING and everything else `applied`. Two cases change the plan:

- **`20260924100000_course_departments` is also PENDING** → fine, `migrate deploy` applies both in order. Nothing extra to do.
- **Any migration shows `*** FAILED / INCOMPLETE ***`** → **stop and tell me.** A half-applied migration must be resolved with `prisma migrate resolve` before `deploy` will run, and the right call depends on how far it got. Do not force it.

---

## 3. Apply only the pending migration(s)

### The pooler problem — read this before running

Your `DATABASE_URL` uses Neon's **`-pooler`** endpoint (PgBouncer). Prisma Migrate takes a session-level **advisory lock** and runs DDL, and over a transaction pooler that either hangs or fails with a confusing error. Use the **direct** endpoint for the migration only — same host without `-pooler`:

```
ep-blue-smoke-b1d1nuj1.c-5.eu-central-1.aws.neon.tech
```

### Run it

In `cmd.exe`, with the direct-host URL (paste your real password; this sets the variable for this shell only, it does not touch `.env`):

```bat
set DATABASE_URL=postgresql://<user>:<password>@ep-blue-smoke-b1d1nuj1.c-5.eu-central-1.aws.neon.tech:5432/neondb?sslmode=require^&channel_binding=require
npx prisma migrate deploy
```

> `^&` is how `cmd.exe` escapes `&`. In PowerShell use `$env:DATABASE_URL = "...&..."` with normal quoting instead.

**`migrate deploy` is the only correct command here.** It applies pending migrations in order and does nothing else. Do **not** use:

- `prisma migrate dev` — can detect "drift" and offer to **reset** (drop everything)
- `prisma migrate reset` — drops and recreates
- `prisma db push` — rewrites the schema to match without recording history, desynchronising `_prisma_migrations`

Expected output:

```
1 migration found in prisma/migrations
Applying migration `20260930000000_academic_structures_attachments_thumbnails_plays`
The following migration have been applied: ...
All migrations have been successfully applied.
```

### Why this is safe on live data

The migration is 223 lines / 33 statements with **zero destructive operations** — no table, column or row is dropped. Prisma runs it in a single transaction, so a failure rolls the whole thing back.

- `academic_years.structureId` uses the three-step **nullable → backfill → NOT NULL** pattern. The backfill is `UPDATE academic_years SET structureId = (platform structure) WHERE structureId IS NULL`, which covers every existing row, so the `SET NOT NULL` cannot fail on populated data.
- The platform structure is seeded with `ON CONFLICT ("scopeKey") DO NOTHING` — idempotent and safe to re-run.
- The only `DROP` is `DROP INDEX IF EXISTS "academic_years_order_key"`, and it runs **after** its replacement `academic_years_structureId_order_key` exists, so there's no window without a uniqueness guarantee.

The one step that a re-run won't undo is the `NOT NULL` promotion — which is why step 2a's branch exists.

---

## 4. `prisma generate`

```bat
npx prisma generate
```

Not strictly required for production — Render already ran it at build time, which is precisely why the deployed client knows about `academicStructure`. Run it locally so your machine's client matches the now-migrated database.

---

## 5. Verify

**5a.** Re-run `prod-schema-diagnostic.sql`. Sections 3, 4, 5 should all return **zero rows**, and section 6 should be `true` for every object **except** `OLD index academic_years_order_key`, which must be `false`.

**5b.** Test the endpoint. No restart should be needed — Prisma doesn't cache the catalog — but if the service is still erroring, restart it in Render to drop stale pooled connections.

```bat
curl -i "https://student-backend-814y.onrender.com/api/v1/catalog/academic-years"
```

Expect `200` with a JSON list. On a fresh database that list contains the single seeded platform structure's entries, so an empty `[]` with `200` is also a pass — the point is that the table now exists.

If it needs auth, add `-H "Authorization: Bearer <token>"`.

---

## 6. Stop this from happening again (the actual fix)

The migration being pending is a symptom. The cause is that **deploys advance the code and never the database**, so this recurs on every future schema change.

**Render → service → Settings → Pre-Deploy Command:**

```
npx prisma migrate deploy
```

Render runs it after the build and before traffic switches, so a failed migration aborts the deploy instead of shipping broken code.

Because Render will use the service's `DATABASE_URL` (the pooler host) for that command, make the direct URL explicit rather than relying on it. Add to `prisma/schema.prisma`:

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}
```

Then add a `DIRECT_URL` environment variable in Render with the non-`-pooler` host. Prisma uses `directUrl` for migrations and `url` for queries — the pooler keeps serving runtime traffic, migrations bypass it.

**I have not made this change.** It's a schema edit plus a Render env var, and you asked me not to commit without being asked. Say the word and I'll apply it, run the backend typecheck and test suite, and hand you the diff.
