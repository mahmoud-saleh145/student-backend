# Library

Phase 3. A separate top-level system: documents sold for wallet credits.

> **This is what the wallet is for.** Library parts and packages are the only
> things credits buy. Courses never debit the wallet — they are sold as access
> cards, offline. Nothing in `src/modules/library/` references a course, an
> enrollment or a section, and that absence is the design rather than an
> oversight.

## Independence, in both directions

A student may buy library material while enrolled in nothing. Owning every
course on the platform grants nothing here. There is no shared table, no shared
entitlement and no code path that crosses between them.

## Entities

| Table | What it is |
|---|---|
| `library_materials` | A publication — "Physics Revision Papers". Sold as its parts, or as packages. |
| `library_parts` | One sellable document, with its own absolute price and its object key. |
| `library_packages` | A bundle of parts at one price, independent of what they cost separately. |
| `library_package_items` | Membership. Editing it never reaches backwards — see below. |
| `library_purchases` | Immutable. Price frozen, membership snapshotted, linked to the ledger entry that paid. |
| `library_entitlements` | What a student may open. **Always per part.** |

## Pricing — deliberately simpler than course parts

Each part carries its own absolute price. There is no whole-material price to
take a percentage of, so there is no allocation to validate and no arithmetic
that can fail to add up. A package is priced independently of its contents,
because a bundle discount is the entire point of a bundle.

The browse response reports `priceTotal` — what the material costs part by part
— which is the number a package price is meant to look good against.

A part priced at **zero is not free**; it is a configuration mistake and the
purchase path refuses it. Free content is published with `isPreview`, which
needs no purchase at all. That keeps every ledger row meaningful.

## Entitlements are always per part

Buying a package writes **one entitlement row per included part**. Two
consequences, both deliberate:

1. The access check is a single indexed lookup, whatever was bought.
2. **The package's membership is frozen by construction.** What a student owns
   is a set of parts, not a pointer to a package someone may edit next month.
   `partIdsSnapshot` on the purchase records the same thing a second time,
   explicitly, for the report.

A package that **partly** overlaps what the student holds is allowed — it is a
bundle at a bundle price, and the quote reports `partsAlreadyOwned` so they see
the overlap before they spend. A package they own **entirely** is refused:
taking credits for nothing is worse than an error.

Withdrawn parts are excluded from what a buyer receives. Selling access to
material that has been taken down would be selling nothing.

## Purchase

One Serializable transaction (`MONEY_TX_OPTIONS`):

1. load the target and re-check it is on sale
2. refuse a zero price and an empty package
3. check the account is active
4. compute what is already owned; refuse if that is everything
5. debit through `WalletService.debit()`
6. write the immutable purchase with its frozen price and membership snapshot
7. write one entitlement per part not already held

**The debit and the entitlements succeed together or neither happens.** The
request carries no amount — the price is read from the database inside the
transaction.

Protection against buying twice: a pre-check, the unique
`(userId, libraryPartId)` entitlement index, Serializable isolation, and an
idempotency key (`libpart:<id>:<userId>` / `libpkg:<id>:<userId>`) on both the
ledger entry and the purchase. A lost race (`P2002`) returns the winning
purchase.

## Accounting

Spending credits is an **allocation** of cash already recognised at recharge
(`recharge_revenue`), not new revenue. No `revenue_ledger` row is written. The
admin report labels its total `creditsSpent`, never "revenue".

Never sum a Library figure with a course figure: they are different systems and
the money entered them by different routes.

## Academic audience and visibility

Every live material is filed to a **university and a faculty** (required; a
`CHECK` constraint holds it in the database) and has a `departmentScope`:

| Scope | Who sees it | Department links |
|---|---|---|
| `FACULTY` (default) | every department of that faculty | none |
| `DEPARTMENTS` | only the linked departments | one or more |

Links live in `library_material_departments`; two composite foreign keys make the
database refuse a department that is not in the material's faculty. General vs
Programs comes from `Department.studyType`, and one material never mixes them.
Year/level (`academicYearId`) is an **optional browsing filter only**, validated
against the ladder that governs the faculty (or each selected department).

Eligibility (`LibraryEligibilityService`) is read from the student's **own
profile** and is **always enforced** — no switch disables it. It fails closed: no
profile, a missing university/faculty on either side, or `DEPARTMENTS` with no
links matches nobody. Clients can only narrow (year, subject, search).

Admin writes validate the audience **as one unit**
(`universityId, facultyId, departmentScope, departmentIds, academicYearId`):
sending any of them means sending all five, so an edit cannot widen or narrow
who sees a material as a side effect. Publishing re-validates the stored one.

### The storefront switch

`LIBRARY_STOREFRONT_ENABLED` — read once at boot (restart to change), parsed
**fail-closed**: only the exact string `true` is ON. While OFF: browse is empty,
non-owners get 404 on detail, quote/purchase/package are refused, preview
tickets are refused and preview liveness is dead. Owners keep `/library/me` and
entitlement-based reading. Turning it off never widens academic access.

### Authorization

| Action | In scope, storefront on | Out of scope, owner | Out of scope, non-owner | Storefront off, owner |
|---|---|---|---|---|
| Browse | published + eligible | not listed | not listed | empty |
| Detail | `view: FULL` | `view: OWNER` | 404 | `view: OWNER` |
| Quote / purchase | allowed if on sale | 403 `LIBRARY_NOT_AVAILABLE` | 404 | 404 |
| Open owned part | `lib_` ticket | `lib_` ticket | — | `lib_` ticket |
| Open preview | `libp_` ticket | 404 | 404 | refused |

* **Owner view** — material header and ONLY the student's unrevoked, published
  parts: no prices, no packages, no counts, nothing purchasable. A revoked
  entitlement is never ownership. Publication still applies.
* **404 is uniform** — missing, unpublished, out of scope and storefront-off all
  answer the same `NOT_FOUND`, so nothing hidden can be discovered.
* **Per-part `access`** — what the student can do now, first match wins:
  `OWNED | PREVIEW | REVOKED | PURCHASABLE | UNAVAILABLE`.
* **Per-part `ownership`** — what the student holds, independent of `access`:
  `OWNED | REVOKED | NONE`. **Decision B:** revocation and preview eligibility
  are separate. A revoked entitlement never grants owned access (`lib_` is
  refused at issue and dies at liveness), but it does not remove a free preview
  the student is otherwise eligible for (storefront on, part and material
  published, in academic scope, session and device valid): such a part answers
  `access: PREVIEW, ownership: REVOKED` and opens with a `libp_` ticket only.
  Having owned a part never stands in for any preview condition.
  (`owned`/`purchasable`/`isPreview`/`fullyOwned`/`available` are deprecated
  mirrors kept until the Student Web and Mobile clients move to `access`.)
* **Packages** belong to exactly one material and are sold **whole or not at
  all**: any unavailable, unpublished, out-of-scope, revoked or foreign item
  refuses the package before any debit.
* **Revoked entitlements** — quote and purchase refuse with
  `LIBRARY_ENTITLEMENT_REVOKED` before any debit; nothing restores one
  automatically.
* The gate runs **before** the idempotent purchase replay and again inside the
  money transaction, before the debit.

## Opening a document

`POST /library/parts/:partId/open` returns a **short-lived signed URL** bound to
the user, session and device, plus the watermark payload the client renders over
the page. There are exactly two ways in, and the ticket type is inside the HMAC:

* **`lib_<partId>` — owned.** An unrevoked entitlement to that exact part; the
  material not withdrawn; device authorised. Scope and the storefront do not
  matter. Edge liveness re-checks the entitlement, the exact session the URL was
  signed for, and, for device-bound content, the exact device. Another active
  session or another approved device does not keep it alive.
* **`libp_<partId>` — preview.** Storefront on, part and material published, the
  student eligible. Edge liveness re-checks all of that
  plus the exact session. **No approved device is needed**, so the device is not
  consulted; revoking a device revokes its sessions, which still ends the URL.

For both, the Worker **fails closed**: an API that is unreachable, times out, or
answers 429, 5xx or anything but a clear boolean proves nothing, so the document
is refused (503 `ticket_unverifiable`). A clear `live: false` is 403
`ticket_revoked`. A clear answer is cached for at most 10 s where the Cache API
works; Cloudflare documents that it has no effect on `*.workers.dev`, where every
fetch probes. Course attachments and video keep their own, unchanged rules.

The Worker authenticates its probes with a shared secret
(`EDGE_LIVENESS_SECRET`, in a header, compared in constant time), which also
exempts it from the per-IP throttle. Once `EDGE_LIVENESS_ENFORCE=true`, anyone
else gets a 401. Rollout order: `docs/runbooks/library-academic-scope-migration.md`.

There is no staff path. A non-owner who could not see the material gets 404;
one who can (in scope, or owning another part) gets 402.

The object key is never sent as a field and never returned by an admin endpoint
(it is the path of the signed URL, which is HMAC-bound and expires), and the
underlying object is never public. This reuses
`StorageService.signMediaUrl` — the same mechanism that already protects course
attachments — so there is one place where protected media is signed.

The watermark carries the student's name, a short form of their id, and a
per-request session tag derived from the user, the part and fresh random bytes.
Two readings by the same student carry different tags, so a leaked screenshot
can be placed in time as well as attributed.

Requests for documents the student does not own are recorded as
`UNAUTHORIZED_ACCESS` security events — repeated attempts are the shape of an
account being probed or shared.

Archived material stops being readable **even for someone who bought it**, in
the same way an archived course stops playing. The entitlement is not revoked
and the purchase stands; only delivery is withheld, and `GET /library/me` flags
the row `status: WITHDRAWN` rather than hiding it.

### The honest limit

This does not make a screenshot impossible, and it cannot stop a camera pointed
at a screen. Nothing can. It makes casual redistribution inconvenient and
deliberate redistribution traceable. OS-level capture blocking and server-side
rendering of a per-student watermarked file are Phase 4; neither changes that
limit.

**Accepted for this release:** the watermark is drawn in the browser, on top of
an unmodified PDF. A technically capable student can obtain the original,
unwatermarked file from network traffic while their signed URL is valid, and a
signed URL works from any device until it expires as long as its ticket stays
live. Server-side watermarking and DRM are out of scope for this release.

## API

### Student (`@StudentOnly()`)

| Method | Path |
|---|---|
| `GET` | `/library/materials` — browse, filtered and paginated |
| `GET` | `/library/materials/:id` — parts and packages, owned or locked |
| `GET` | `/library/me` — everything openable |
| `GET` | `/library/me/purchases` — history at frozen prices |
| `POST` | `/library/quote` — price, balance, shortfall, overlap |
| `POST` | `/library/purchase` — atomic, idempotent |
| `POST` | `/library/parts/:partId/open` — signed URL + watermark |

### Admin (`@AdminOnly()`)

Materials, parts and packages CRUD under `/admin/library/...`, plus
`GET /admin/library/purchases`.

Teachers are deliberately excluded: the Library is a platform-wide catalogue
with its own pricing, not course content delegated to an instructor. There is no
assignment that could scope a teacher's access to it.

Deleting is refused once anyone holds an entitlement — removing it would orphan
something they paid for. Deactivating hides it and keeps them whole.

## Migration

`20260918014216_library` — purely additive. No existing table is altered and no
existing row is touched. Folder named with the real UTC clock, so a
Prisma-generated migration cannot sort into the middle of the sequence.

`20261105120000_library_academic_scope` — additive: the scope enum and column
(constant default, no row rewritten), the department link table with its
composite foreign keys, the placement `CHECK`, and `library_packages.materialId`
NOT NULL (no rows). Applied **before** the backend that reads it is deployed;
see `docs/runbooks/library-academic-scope-migration.md`.

## Not built yet

Dashboard and mobile UI. The mobile Library navigation entry, browse, purchase
and protected viewer are Phase 5 work; the backend contract is additive so
nothing shipped breaks.
