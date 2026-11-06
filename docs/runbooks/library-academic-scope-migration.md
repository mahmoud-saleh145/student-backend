# Runbook — Library academic scope (Phase 1)

Migration `20261105120000_library_academic_scope` and the backend that reads it.

> **Every step below needs its own explicit authorization.** Nothing in this
> document authorizes a production action by itself.

Context that shapes the order:

* **Render auto-deploys `main`.** Merging the backend PR deploys it. The new
  backend reads `departmentScope` and `library_material_departments`, so the
  migration must be in production **before** the merge.
* **The old backend works on the expanded schema** (it names its columns,
  never touches the new table, and cannot move a department to another
  faculty). Only writes that would now be invalid fail: a live material without
  a university/faculty (CHECK) and a package without a material (NOT NULL).
* **Vercel auto-deploys `main`** for the dashboard and student web.
* **Every material follows the same rules, Mechanica included.** There is no
  per-material exception. Production has no storefront rule today, so from the
  backend merge until launch **no non-owner can browse, open or buy any material,
  Mechanica included**. Owners keep reading. At launch, each material reaches the
  students academically eligible for it, and no one else.
* **The new variable is harmless to the code already running.** The old backend
  and the old Worker ignore it, so it is set first.
* **The old Worker keeps working with the new backend** through a rollout
  allowance: a probe with no secret and no `sid`/`did` gets the old account-wide
  answer. `EDGE_LIVENESS_ENFORCE=true` ends it. Do not leave this step undone.
* **The new Worker needs the backend to hold the secret first.** It fails closed
  on a 429, so its probes must already be exempt from the throttle.

## 0. Read-only gates (stop if any fails)

1. Production migration state: `npx prisma migrate status`. Note every pending
   migration: `migrate deploy` applies all of them, and the two before this one
   (`20261027120000_account_deletion_requests`, `20261030100000_deletion_settlement`)
   say "not applied" in their own headers. If they are pending, review them too:
   the code on `main` already reads their columns.
2. Materials (section E): no live material may be missing its placement, or the
   migration fails. Know what is on sale today, because it stops selling to
   non-owners at step 4 until launch.
3. Run the snapshot (section A) and keep the output.
4. Record the deployed Worker version: `wrangler deployments list --name edu-media-gate`.
5. Look for 429s on `/playback/tickets/*/state` in the Render logs, to compare later.
6. Restore point: a Neon branch of production (or a recorded point-in-time timestamp).

## 1. Set the backend secret (the running backend ignores it)

On Render, for every service built from this repository:

* `EDGE_LIVENESS_SECRET` = a new value from `openssl rand -hex 32`, kept in a
  password manager, never in Git, a ticket or a chat
* `LIBRARY_STOREFRONT_ENABLED` and `EDGE_LIVENESS_ENFORCE`: **leave unset**

Verify: the service restarted healthy; the Library behaves as before.

## 2. Apply the migration (from the unmerged release commit)

```bash
git checkout <release-commit>
DATABASE_URL=<production> DIRECT_URL=<production> npx prisma migrate deploy
DATABASE_URL=<production> DIRECT_URL=<production> npm run db:gate   # must exit 0
```

Then run section A again: every number must be identical, plus the
constraint/structure checks in section B must pass.

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
  205 eligible students at the last count).
* "ميكانيكا برامج" and "Dsp" (Programs, LEVEL ladder): choose a LEVEL entry or
  clear the year — they carry YEAR rungs and cannot be published as they are.
* Other drafts: review as appropriate. Never infer departments from titles.
* Run section B.

## 10. Launch (separate approval)

Set `LIBRARY_STOREFRONT_ENABLED=true` on Render (restarts the service).
Verify with test accounts: Mechanica is listed for an eligible student, and is
404 for a student outside its university or faculty, like any other material.
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

Expected at the time of writing: 6 purchases, 6 live entitlements (4 students),
7 materials (1 soft-deleted), 6 parts (1 soft-deleted), 0 packages.

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
-- live materials whose year is not on their faculty's ladder (expected: the 2 Programs drafts until fixed)
SELECT m.id, m.title, m.status FROM library_materials m
  JOIN academic_years y ON y.id=m."academicYearId"
  LEFT JOIN academic_structure_faculties af ON af."facultyId"=m."facultyId"
 WHERE m."deletedAt" IS NULL AND af."structureId" IS NOT NULL AND y."structureId" <> af."structureId";
-- rows edited between migration and backend deploy (review each)
SELECT id, title, "updatedAt" FROM library_materials WHERE "updatedAt" > '<migration time>';
-- eligible students for each published material (Mechanica expected: 205 at last count)
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

