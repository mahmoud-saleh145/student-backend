# Course parts

Phase 2 of the platform upgrade.

> **Financial rule, corrected 2026-09-18.** The wallet is for the **Library
> only**. Courses and course parts never debit it. A part is unlocked by
> redeeming a part-scoped access card, exactly as course-scoped and
> section-scoped cards already work; the money changes hands offline when the
> card is sold. An earlier build of this phase charged wallet credits for parts
> — that path has been removed entirely.

## The one design decision everything follows from

**A course part is a group of sections.** It is not a new content type and not a
new authorization system.

The existing access model already had partial-course access built in:

- `Enrollment.coversAllSections` (default `true`)
- `EnrollmentSectionGrant` rows for the restricted case
- `CourseAccessService.allowedSectionIds()` → `null` for "everything", an array
  for "only these"
- `assertSectionAccessible()`, enforced in **all three** content paths: the
  lesson read, the playback ticket mint, and the attachment ticket

So acquiring a part writes ordinary `enrollment_section_grants` rows — exactly
what a section-scoped access code already writes — and **nothing in the access
path changed**. No new gate, no second set of rules that could drift out of step with
the first.

`CourseSection.partId` is nullable, so a course with no parts sells and behaves
exactly as it did before this feature existed.

## Entities

### `course_parts`

One sellable slice. Carries title, order, active state, and its price under one
of two models.

### `course_part_entitlements`

What a student owns. `@@unique(userId, coursePartId)` is the double-grant
guarantee — two concurrent redemptions cannot both create the row, and the
loser's whole redemption transaction unwinds with it, card included. Revocation
is additive: the row stays with `revokedAt` set, so the history of what was
owned survives.

### `course_part_purchases`

Immutable record of one part acquisition. Freezes: what the part was worth at
redemption, the pricing model and percentage that produced that figure, the
course price at the time, both titles, the teacher split, and the exact section
ids unlocked.

Provenance is one of two columns, with a CHECK requiring exactly one:

- `accessCodeId` — the live path. The card that unlocked the part.
- `walletTransactionId` — nullable history from the withdrawn wallet build.
  Nothing new is ever written here.

> **Not a cash record.** No `payment` and no `revenue_ledger` row is written,
> which is not an omission: whole-course code redemption has never written one
> either (`EnrollmentsService.redeemCode` returns `payment: null`), and the
> card's own `priceAmount` is the reporting figure. Making parts account
> differently from the other card types would be the error. The admin report
> labels its total `valueAtAcquisition`, never "revenue".

## Pricing

Two models, and **all active parts of one course must use the same one**. A 40%
part plus a 300 EGP part only sums to the total for one particular course price
and would silently stop summing the moment that price changed.

### Percentage

Each part carries a percentage; the active parts must total **exactly 100%**.
The price floats with the course price.

Percentages do not divide cleanly. A 999.99 EGP course split 3 × 33.33% + 0.01%
does not, if each share is rounded independently, sum back to 999.99. So
allocation uses **largest-remainder apportionment**: each part gets the floor of
its exact share, then the leftover piastres go one each to the largest discarded
remainders. The result sums to the course price *exactly*, by construction, and
no part is ever more than a piastre from its true share. Ties break towards the
earlier part, so the same input always produces the same prices.

### Fixed

Each part carries an absolute EGP amount; the active parts must total **exactly
the course price**. Over-allocation charges more than the course is worth;
under-allocation means buying everything still does not buy the course. Both are
refused with the exact shortfall named in EGP, because "invalid pricing" is
useless to an admin trying to fix it.

### Default structure

Option A from the requirements: `POST /admin/courses/:id/parts/default` creates
Part 1 — Before Mid + Revision at **60%** and Part 2 — After Mid + Revision at
**40%**. It refuses if the course already has parts rather than merging into a
260% split nobody intended.

### When the course price changes

A price change is **refused** if it would leave fixed-price parts no longer
summing to the total, with the shortfall named so the admin can adjust the parts
first. Percentage parts always still total 100% and pass untouched. Existing
purchases carry their own frozen price and are unaffected either way.

The check is `assertPriceChangeKeepsAllocationValid`, a plain function rather
than a service method — `CoursesModule` is `@Global`, and a service dependency
there would make the courses and parts modules import each other.

## Acquisition — by card

An admin issues a batch of cards against a part
(`targetType: PART`, `coursePartId`). The part's section ids are **frozen onto
each card at generation**, exactly as a course card freezes its sections: a card
sold in October must not start unlocking a section added to the part in
December, because the buyer did not pay for it.

The student redeems through the existing redemption endpoint. Inside that one
Serializable transaction (`MONEY_TX_OPTIONS`), which already consumed the card:

1. `resolveRedemptionScope` returns the card's frozen section ids
2. `EnrollmentsService.grantAccess()` writes the section grants, tagged with
   `partId`
3. `grantPartFromCode()` writes the acquisition record and the entitlement

**A card can never be burned without the entitlement it bought, nor an
entitlement created without the card** — they share the transaction.

A card whose part has no sections is refused **at generation**, not at
redemption: a card that unlocks nothing is worse than no card, because the
student pays, redeems, and gets an empty part with no error to point at.

### Double-grant protection

- **`@@unique(userId, coursePartId)`** on the entitlement — the real guarantee.
- **`@@unique(codeId, userId)`** on the redemption — already enforced; a student
  cannot redeem the same card twice, ever.
- **Serializable isolation** on the redemption transaction.
- Holding the part already short-circuits the grant and writes nothing.

A revoked entitlement is **reinstated** rather than duplicated — a revoked row
records something withdrawn, not something held.

## "Eventually the complete course"

Buying every part grants every section **that exists now**. `coversAllSections`
stays `false`, so a section added later must be bought. This matches the existing
access-code snapshot philosophy exactly: you get what you paid for. The student
API reports `ownsAllParts: true` so the app can say "complete" without the
backend giving away future content.

A student who already holds the whole course (a pre-parts enrollment, or a
course-wide code) reads as owning every part, so they are never invited to buy
what they already have.

## API

### Student

| Method | Path | Notes |
|---|---|---|
| `GET` | `/courses/:courseId/parts` | Every sellable part, owned or locked. `hasParts: false` = sold whole. |
| `GET` | `/me/part-purchases` | Parts held, at frozen values, with `acquiredVia`. |

**There is no purchase route.** Parts are acquired through the existing code
redemption endpoint. The wallet is never involved in a course.

Locked parts list their section **titles** — that is what makes a part worth
buying — but nothing playable.

### Staff / admin

| Method | Path | Notes |
|---|---|---|
| `GET` | `/admin/courses/:courseId/parts` | Includes inactive parts; reports `allocationError` rather than throwing. |
| `POST` | `/admin/courses/:courseId/parts/default` | The 60/40 structure. |
| `POST` | `/admin/courses/:courseId/parts` | Allocation re-validated before the part is kept. |
| `PATCH` | `/admin/course-parts/:partId` | Price/title free; pricing model locked once sold. |
| `PUT` | `/admin/course-parts/:partId/sections` | Decides what a buyer receives. |
| `PUT` | `/admin/courses/:courseId/parts/order` | Two-phase reorder. |
| `DELETE` | `/admin/course-parts/:partId` | Soft; refused once purchased. |
| `GET` | `/admin/part-purchases` | Acquisition report. Totals labelled `valueAtAcquisition`. |

Part cards are issued through the existing code endpoints with
`targetType: PART` and a `coursePartId`.

Structural routes are `@StaffOnly()` with a per-course capability check inside
the service, so a teacher only touches assigned courses and only with pricing or
content rights. The purchase report is `@AdminOnly()` because it is financial.

## Backward compatibility

- `course_sections.partId` and `enrollment_section_grants.partId` are nullable;
  no existing row is touched or back-filled.
- A course with no parts is unchanged in every respect.
- `EnrollmentsService.grantAccess()` gained two optional parameters, both
  defaulting to the previous behaviour, so every existing caller writes exactly
  the rows it wrote before.
- `EnrollmentMethod` is **not** extended; a part card redeems as
  `EnrollmentMethod.CODE` like any other card.
- `revenue_ledger`, `payments`, the wallet and the whole-course purchase path
  are all untouched.
- `course_part_purchases.walletTransactionId` only lost its NOT NULL. Any row
  from the withdrawn wallet build keeps its value and its foreign key.

## Not built yet

Dashboard and mobile UI for parts. The backend contract is additive, so nothing
currently shipped breaks; the app simply will not show parts until it is updated.
