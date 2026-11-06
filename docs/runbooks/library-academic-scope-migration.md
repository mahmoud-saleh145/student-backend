# Runbook — Library academic scope (Phase 1)

Migration `20261105120000_library_academic_scope` and the backend that reads it.

> **Every step below needs its own explicit authorization.** Nothing in this
> document authorizes a production action by itself.

Release order at a glance:

| # | Action | Gate to continue |
|---|---|---|
| 0 | Read-only gates, restore branch, migration rehearsal on a child of it | All pass |
| 1 | Set `EDGE_LIVENESS_SECRET` on Render | Service healthy |
| 2 | Run the migration on production | `db:gate` exits 0, section A unchanged |
| 3 | Freeze Library edits in the dashboard | Admins told |
| 4 | Merge the backend | Browse empty for non-owners, owners read, no 5xx rise |
| 5 | Merge the dashboard immediately, then end the freeze | Edit and publish work on a draft |
| 6 | Set the Worker secret and deploy the Worker | Owned PDF, attachment and video open, no 429s |
| 7 | Merge Student Web | Reader and owner view work |
| 8 | Set `EDGE_LIVENESS_ENFORCE=true` | Unauthenticated probe gets a 401, documents still open |
| 9 | Admin data review and integrity gate | Section B passes |
| 10 | Launch, under separate approval | Monitoring is clean |

Context that shapes the order:

* **Render auto-deploys `main`.** Merging the backend PR deploys it. The new
  backend reads `departmentScope` and `library_material_departments`, so the
  migration must be in production **before** the merge.
* **The old backend works on the expanded schema** (it names its columns,
  never touches the new table, and cannot move a department to another
  faculty). Only writes that would now be invalid fail: a live material without
  a university/faculty (CHECK) and a package without a material (NOT NULL).
* **Vercel auto-deploys `main`** for the dashboard and student web.
* **Every material follows the same rules.** There is no per-material exception.
  Production has no storefront rule today, so from the backend merge until launch
  **no non-owner can browse, open or buy any material, including the two on sale
  today, Mechanica and Microprocessors**. This temporary state is accepted. Owners
  keep reading. At launch, each material reaches the students academically
  eligible for it, and no one else.
* **The new variable is harmless to the code already running.** The old backend
  and the old Worker ignore it, so it is set first.
* **The old Worker keeps working with the new backend** through a rollout
  allowance: a probe with no secret and no `sid`/`did` gets the old account-wide
  answer. `EDGE_LIVENESS_ENFORCE=true` ends it. Do not leave this step undone.
* **The new Worker needs the backend to hold the secret first.** It fails closed
  on a 429, so its probes must already be exempt from the throttle.

## 0. Read-only gates (stop if any fails)

1. Production migration state: `npx prisma migrate status`. Read on 2026-11-06:
   22 of 23 applied, none failed, and **only
   `20261105120000_library_academic_scope` pending**. If anything else is pending
   now, stop and review it: `migrate deploy` applies everything pending.
   `20261012120000_shared_video_assets` has a checksum that differs from the file:
   production applied it from `bac8288`, and `257bca2` later added only comments.
   This is expected. Do not run `migrate dev` against production.
2. Materials (section E): no live material may be missing its placement, or the
   migration fails. Read on 2026-11-06: 0 missing. Mechanica and Microprocessors
   are on sale, and they stop selling to non-owners at step 4 until launch.
3. Run the snapshot (section A) and keep the output.
4. Record the deployed Worker version: `wrangler deployments list --name edu-media-gate`.
5. Look for 429s on `/playback/tickets/*/state` in the Render logs, to compare later.
6. Confirm Render's `DATABASE_URL` host is the database checked above, and that
   `LIBRARY_STOREFRONT_ENABLED` and `EDGE_LIVENESS_ENFORCE` are unset.
7. Restore point: a dedicated Neon branch of production, auto-delete off, with its
   id and creation time recorded. Create a fresh one immediately before the
   production migration. A branch is a copy at that moment: anything written to
   production afterward is not in it, and restoring it would lose that work.
8. Rehearse on a separate child of that branch, so the restore point itself stays
   before the migration, never on production: `migrate status`, `migrate deploy`,
   `db:gate`, then sections A and B. Stop if anything differs.

## 1. Set the backend secret (the running backend ignores it)

On Render, for every service built from this repository:

* `EDGE_LIVENESS_SECRET` = a new value from `openssl rand -hex 32`, kept in a
  password manager, never in Git, a ticket or a chat
* `LIBRARY_STOREFRONT_ENABLED` and `EDGE_LIVENESS_ENFORCE`: **leave unset**

Verify: the service restarted healthy; the Library behaves as before.

## 2. Apply the migration (from the unmerged release commit)

Run in a quiet period, from the head of `feat/library-academic-scope`, over the
direct, non-pooler connection. Rehearsed on an isolated branch on 2026-11-06: only
this migration applied, `db:gate` passed, no drift, data unchanged.

```bash
git checkout <release-commit>
DATABASE_URL=<production> DIRECT_URL=<production> npx prisma migrate deploy
DATABASE_URL=<production> DIRECT_URL=<production> npm run db:gate   # must exit 0
```

Then run section A again: every number must match the snapshot taken just before,
plus the constraint/structure checks in section B must pass.

The migration should roll back as one unit if it fails, but it leaves a failed
record that blocks later deploys. Clearing that needs `prisma migrate resolve`,
which is a production write and needs its own authorization.

## 3. Freeze Library edits in the dashboard

The old dashboard's edit form sends part of the audience, which the new backend
refuses with a validation error. Nothing is written, but admins cannot save.
The freeze lasts until step 5 is verified.

## 4. Merge the backend PR

Render auto-deploys it. Verify, with a dedicated test account, not a real student:

* `GET /api/v1/meta/health` is healthy;
* a student's `GET /library/materials` returns no items, and a material page is
  404 for a non-owner (storefront off);
* each current entitlement holder can open each of their parts (section C);
* no rise in 5xx.

## 5. Merge the dashboard, immediately after, then end the freeze

Never before the backend: the new dashboard's create form is refused by the old
backend. Verify an edit and a publish work on a draft, then end the freeze.

## 6. Deploy the Worker

```bash
wrangler secret put EDGE_LIVENESS_SECRET   # the same value as step 1; the old code ignores it
wrangler deploy                            # from the repository root
```

`wrangler.toml` keeps `workers_dev = true` and `[observability] enabled = true`.
Verify through the real product: an owned PDF and a free preview open; a lecture
attachment and a video play; `ticket_unverifiable` denials stay near zero; no 429s
on the state route.

## 7. Merge Student Web

The old web works against the new backend until this step. Verify the reader,
owner view and full view with test accounts, in English and Arabic.

## 8. End the rollout allowance

Set `EDGE_LIVENESS_ENFORCE=true` on Render (restarts the service). Verify:

```bash
curl -i "https://<api>/api/v1/playback/tickets/lib_x/state?uid=x"   # must be 401
```

and an owned PDF, a preview, an attachment and a video all still open.

## 9. Admin data review, and the integrity gate

* Mechanica: confirm `FACULTY` (Mansoura → Faculty of Engineering (General),
  208 eligible students on 2026-11-06).
* Microprocessors: confirm `FACULTY` (Mansoura → Faculty of Engineering (Programs),
  300 eligible students at the read-only gate on 2026-11-06, and 303 by the
  rehearsal later that day: this grows as students register).
* Two live materials carry a year that is not on their faculty's ladder:
  **Microprocessors** (published) and **"ميكانيكا برامج"** (draft). Choose an entry
  from the faculty's ladder or clear the year. Reading is unaffected, because the
  year is never an eligibility rule, but the new dashboard refuses edits to them
  until this is done. Fix both before launch.
* Other drafts: review as appropriate. Never infer departments from titles.
* Run section B.

## 10. Launch (separate approval)

Set `LIBRARY_STOREFRONT_ENABLED=true` on Render (restarts the service).
Verify with test accounts: Mechanica and Microprocessors are each listed for an
eligible student, and are 404 for a student outside their university or faculty,
like any other material.
Monitor 404 / 403 (`LIBRARY_NOT_AVAILABLE`, `LIBRARY_ENTITLEMENT_REVOKED`)
rates, purchase success, open errors (402/410/device), `UNAUTHORIZED_ACCESS`
security events, and Worker `ticket_revoked` / `ticket_unverifiable` denials.

## Rollback

| Situation | Action |
|---|---|
| Anything suspicious after launch | Unset `LIBRARY_STOREFRONT_ENABLED` (or set anything but `true`), restart. Fails closed; owners keep reading. |
| Owned PDFs refused (503) | The Worker cannot verify: check the API, then the secret on both sides. A wrong secret under enforcement refuses every Library document. Unsetting `EDGE_LIVENESS_ENFORCE` restores service while you look, and video and attachments are not affected. |
| Worker defect | **First** unset `EDGE_LIVENESS_ENFORCE` and restart: the old Worker fails open on the 401 otherwise. Then `wrangler rollback` to the version recorded in 0.4. |
| Backend defect | Unset `EDGE_LIVENESS_ENFORCE`, roll the Worker back, then revert the PR on `main` (auto-deploys the previous backend). The new Worker must not stay in front of the old backend, which throttles its probes. **Reverting reopens the unscoped catalogue**: every published material visible to every student, as production is today. **Keep the schema** — the old backend works with it. Do not run the old image's `db:gate`: it reports the newer migration as drift, which is expected. |
| Dashboard defect | Revert its PR. Library edits then fail again, so restore the freeze. |
| Student Web defect | Revert its PR. The old web works against the new backend. |
| Database restore | Last resort, with its own authorization. Restoring `production` from the restore branch discards everything written after that branch was created, and does not undo a backend, Worker or Vercel deployment. |
| Schema rollback | **Never automatic, never part of an ordinary rollback.** Only if section D shows no audience data exists, or after a separately approved export (section D) and recovery plan. |

## A. Read-only snapshot (before and after each step)

```sql
BEGIN TRANSACTION READ ONLY;
SELECT count(*) AS purchases, sum("priceAtPurchase") AS paid FROM library_purchases;
SELECT count(*) FILTER (WHERE "revokedAt" IS NULL) AS live, count(*) AS total,
       md5(string_agg(id || "userId" || "libraryPartId" || coalesce("revokedAt"::text,''), ',' ORDER BY id)) AS checksum
  FROM library_entitlements;
SELECT source, count(*), sum(amount) FROM wallet_transactions
 WHERE source IN ('LIBRARY_PART','LIBRARY_PACKAGE') GROUP BY source;
SELECT count(*) AS wallets, sum(balance) AS balances FROM wallets;
SELECT count(*) AS materials FROM library_materials;
SELECT count(*) AS parts FROM library_parts;
SELECT count(*) AS packages FROM library_packages;
COMMIT;
```

Read on 2026-11-06: 7 purchases totalling 60, 7 live entitlements of 7 (4 students,
checksum `532dd4e47fd737b8afdb4f7ed45f02af`), 7 Library wallet transactions totalling
60, 223 wallets with balances of 1090, 7 materials (1 soft-deleted), 7 parts
(1 soft-deleted), 0 packages. Production stays live, so a purchase or a wallet top-up
between two snapshots moves these numbers: compare against the snapshot taken
immediately before the step, and explain any difference.

## B. Read-only integrity gate

```sql
BEGIN TRANSACTION READ ONLY;
-- structure present
SELECT conname FROM pg_constraint WHERE conname IN (
  'library_materials_placement_chk',
  'library_material_departments_materialId_facultyId_fkey',
  'library_material_departments_departmentId_facultyId_fkey');
-- DEPARTMENTS with no links / FACULTY with links (both must be 0)
SELECT count(*) FROM library_materials m WHERE m."deletedAt" IS NULL AND m."departmentScope"='DEPARTMENTS'
  AND NOT EXISTS (SELECT 1 FROM library_material_departments d WHERE d."materialId"=m.id);
SELECT count(*) FROM library_materials m WHERE m."departmentScope"='FACULTY'
  AND EXISTS (SELECT 1 FROM library_material_departments d WHERE d."materialId"=m.id);
-- mixed General/Programs links (must be 0)
SELECT count(*) FROM (SELECT d."materialId" FROM library_material_departments d
  JOIN departments x ON x.id=d."departmentId" GROUP BY 1 HAVING count(DISTINCT x."studyType")>1) t;
-- packages with an item from another material (must be 0)
SELECT count(*) FROM library_package_items i JOIN library_packages p ON p.id=i."packageId"
  JOIN library_parts lp ON lp.id=i."libraryPartId" WHERE lp."materialId" <> p."materialId";
-- live materials whose year is not on their faculty's ladder
-- (expected until fixed: Microprocessors and ميكانيكا برامج)
SELECT m.id, m.title, m.status FROM library_materials m
  JOIN academic_years y ON y.id=m."academicYearId"
  LEFT JOIN academic_structure_faculties af ON af."facultyId"=m."facultyId"
 WHERE m."deletedAt" IS NULL AND af."structureId" IS NOT NULL AND y."structureId" <> af."structureId";
-- rows edited between migration and backend deploy (review each)
SELECT id, title, "updatedAt" FROM library_materials WHERE "updatedAt" > '<migration time>';
-- eligible students for each published material (2026-11-06: Mechanica 208, Microprocessors 300 to 303)
SELECT m.title, count(p.id) FROM library_materials m JOIN student_profiles p
  ON p."universityId"=m."universityId" AND p."facultyId"=m."facultyId"
 AND (m."departmentScope"='FACULTY' OR EXISTS (SELECT 1 FROM library_material_departments d
      WHERE d."materialId"=m.id AND d."departmentId"=p."departmentId"))
 WHERE m."deletedAt" IS NULL AND m.status='PUBLISHED' AND m."isActive" GROUP BY m.title;
COMMIT;
```

## C. Owners keep reading

For each live entitlement holder: `POST /library/parts/:id/open` returns a
`lib_` URL, and the Worker serves it. No production write is involved.

## D. Schema rollback (only with separate approval)

1. Check whether audience data exists (read-only):
   ```sql
   SELECT (SELECT count(*) FROM library_material_departments) AS links,
          (SELECT count(*) FROM library_materials WHERE "departmentScope" <> 'FACULTY') AS non_default;
   ```
   Both 0 → no audience data to lose. Otherwise **export first**:
   ```sql
   COPY (SELECT * FROM library_material_departments) TO STDOUT WITH CSV HEADER;
   COPY (SELECT id, "departmentScope" FROM library_materials) TO STDOUT WITH CSV HEADER;
   ```
   and take a Neon branch.
2. Down SQL (documentation only — never run by tooling):
   ```sql
   ALTER TABLE "library_materials" DROP CONSTRAINT "library_materials_placement_chk";
   ALTER TABLE "library_packages" DROP CONSTRAINT "library_packages_materialId_fkey";
   ALTER TABLE "library_packages" ALTER COLUMN "materialId" DROP NOT NULL;
   ALTER TABLE "library_packages" ADD CONSTRAINT "library_packages_materialId_fkey"
     FOREIGN KEY ("materialId") REFERENCES "library_materials"("id") ON DELETE SET NULL ON UPDATE CASCADE;
   DROP TABLE "library_material_departments";
   DROP INDEX "departments_id_facultyId_key";
   DROP INDEX "library_materials_id_facultyId_key";
   ALTER TABLE "library_materials" DROP COLUMN "departmentScope";
   DROP TYPE "LibraryDepartmentScope";
   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261105120000_library_academic_scope';
   ```
3. Recovery: re-apply the migration, then restore every exported row and
   `departmentScope` value, and compare counts and checksums with the export.

## E. Materials before the migration (read-only)

```sql
BEGIN TRANSACTION READ ONLY;
-- must be 0, or the migration's CHECK fails
SELECT count(*) FROM library_materials
 WHERE "deletedAt" IS NULL AND ("universityId" IS NULL OR "facultyId" IS NULL);
-- every published material: step 4 hides these from non-owners until launch
SELECT id, title FROM library_materials
 WHERE "deletedAt" IS NULL AND status='PUBLISHED' AND "isActive";
COMMIT;
```

