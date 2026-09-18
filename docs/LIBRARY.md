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

## Opening a document

`POST /library/parts/:partId/open` returns a **short-lived signed URL** bound to
the user, session and device, plus the watermark payload the client renders over
the page. It is minted only after four checks: authenticated, account active,
device authorised, entitlement held.

The object key is never sent to a client, never returned by an admin endpoint,
and the underlying object is never public. This reuses
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
the row `available: false` rather than hiding it.

### The honest limit

This does not make a screenshot impossible, and it cannot stop a camera pointed
at a screen. Nothing can. It makes casual redistribution inconvenient and
deliberate redistribution traceable. OS-level capture blocking and server-side
rendering of a per-student watermarked file are Phase 4; neither changes that
limit.

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

## Not built yet

Dashboard and mobile UI. The mobile Library navigation entry, browse, purchase
and protected viewer are Phase 5 work; the backend contract is additive so
nothing shipped breaks.
