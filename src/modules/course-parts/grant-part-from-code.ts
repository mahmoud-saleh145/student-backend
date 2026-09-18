import { PartEntitlementSource, type Prisma } from '@prisma/client';

import { fromPiastres } from '../wallet/money';

import { loadPartAllocation } from './part-allocation.guard';
import { splitTeacherShare } from './part-pricing';

export interface PartGrantResult {
  entitlementId: string;
  acquisitionId: string | null;
  coursePartId: string;
  partTitle: string;
  /** What the part was worth at redemption, in EGP. */
  valueAtRedemption: number;
  sectionIds: string[];
  /** True when the student already held this part and nothing was written. */
  alreadyHeld: boolean;
}

/**
 * Records that a student has acquired a course part by redeeming its card.
 *
 * ── Why a plain function and not a service ──────────────────────────────────
 *
 * The redemption path lives in `EnrollmentsService`, and `CoursePartsModule`
 * already imports `EnrollmentsModule` in order to grant sections. Injecting a
 * parts *service* back into enrollments would close that loop into a circular
 * dependency. Taking the caller's transaction client as an argument sidesteps
 * it entirely and — more importantly — keeps this write inside the same
 * transaction as the code consumption, so a card can never be burned without
 * the entitlement it paid for, or an entitlement created without the card.
 *
 * ── Money ───────────────────────────────────────────────────────────────────
 *
 * **No wallet is touched.** The wallet is for the Library. A course part is
 * unlocked by a card, and the money changed hands offline when that card was
 * sold — exactly as course-scoped and section-scoped cards already work.
 *
 * No `payment` and no `revenue_ledger` row is written either, which is not an
 * omission: whole-course code redemption has never written one
 * (`EnrollmentsService.redeemCode` returns `payment: null`), and the card's own
 * `priceAmount` is the reporting figure. Doing something different for parts
 * would make two kinds of card account differently for the same event.
 *
 * What IS recorded is the acquisition: which student got which part, what that
 * part was worth at the moment of redemption, which card unlocked it, and how
 * that value splits between teacher and platform. That satisfies the
 * specification's requirement to preserve the historical financial picture of
 * every part a student holds, and it is frozen — a later price change never
 * rewrites it.
 */
export async function grantPartFromCode(
  tx: Prisma.TransactionClient,
  params: {
    userId: string;
    coursePartId: string;
    accessCodeId: string;
    /** Sections frozen onto the card at generation time. */
    sectionIds: string[];
  },
): Promise<PartGrantResult | null> {
  const part = await tx.coursePart.findFirst({
    where: { id: params.coursePartId, deletedAt: null },
    include: {
      course: {
        select: {
          id: true,
          title: true,
          teachers: {
            select: {
              teacherId: true,
              isLead: true,
              revenueSharePercent: true,
              teacher: {
                select: { teacherProfile: { select: { revenueSharePercent: true } } },
              },
            },
          },
        },
      },
    },
  });

  // A card pointing at a part that has since been hard-removed still unlocks
  // its frozen sections through the ordinary grant path; there is simply no
  // part left to record an entitlement against. Returning null rather than
  // throwing keeps the redemption working, which is the right outcome for a
  // student holding a legitimately sold card.
  if (!part) return null;

  const existing = await tx.coursePartEntitlement.findUnique({
    where: {
      userId_coursePartId: { userId: params.userId, coursePartId: params.coursePartId },
    },
    select: { id: true, revokedAt: true },
  });

  if (existing && existing.revokedAt === null) {
    return {
      entitlementId: existing.id,
      acquisitionId: null,
      coursePartId: params.coursePartId,
      partTitle: part.title,
      valueAtRedemption: 0,
      sectionIds: params.sectionIds,
      alreadyHeld: true,
    };
  }

  // What the part was worth at this moment. Computed from the live allocation
  // rather than stored on the part, because a percentage part has no standalone
  // price — it is a share of the course price.
  let pricePiastres = 0;
  let percent: number | null = null;

  const price = await tx.coursePrice.findFirst({
    where: { courseId: part.courseId, isCurrent: true },
    orderBy: { version: 'desc' },
    select: { amount: true },
  });

  if (price) {
    try {
      const allocation = await loadPartAllocation(tx, part.courseId, price.amount.toString());
      const line = allocation?.parts.find((p) => p.id === params.coursePartId);
      if (line) {
        pricePiastres = line.piastres;
        percent = line.percent;
      }
    } catch {
      // A course whose parts no longer add up must not block a student from
      // redeeming a card they already paid for. The entitlement is granted and
      // the recorded value is zero, which is visibly wrong in a report rather
      // than invisibly wrong in an entitlement.
      pricePiastres = 0;
    }
  }

  const lead = part.course.teachers.find((t) => t.isLead) ?? part.course.teachers[0] ?? null;
  const sharePercent =
    lead?.revenueSharePercent?.toString() ??
    lead?.teacher.teacherProfile?.revenueSharePercent?.toString() ??
    null;
  const split = splitTeacherShare(pricePiastres, sharePercent);

  const acquisition = await tx.coursePartPurchase.create({
    data: {
      userId: params.userId,
      courseId: part.courseId,
      coursePartId: params.coursePartId,
      priceAtPurchase: fromPiastres(pricePiastres),
      currency: part.currency,
      pricingModelAtPurchase: part.pricingModel,
      pricePercentAtPurchase: percent,
      coursePriceAtPurchase: price ? price.amount : null,
      partTitleSnapshot: part.title,
      courseTitleSnapshot: part.course.title,
      teacherId: lead?.teacherId ?? null,
      sharePercent: split.percent,
      teacherAmount: fromPiastres(split.teacherPiastres),
      platformAmount: fromPiastres(split.platformPiastres),
      sectionIdsSnapshot: params.sectionIds,
      // No wallet transaction. The CHECK constraint requires exactly one
      // provenance, and for a card that is the card.
      accessCodeId: params.accessCodeId,
      idempotencyKey: `partcode:${params.accessCodeId}:${params.userId}`,
    },
    select: { id: true },
  });

  // A previously revoked entitlement is reinstated rather than duplicated —
  // the unique (userId, coursePartId) index would refuse a second row anyway.
  const entitlement = await tx.coursePartEntitlement.upsert({
    where: {
      userId_coursePartId: { userId: params.userId, coursePartId: params.coursePartId },
    },
    create: {
      userId: params.userId,
      coursePartId: params.coursePartId,
      courseId: part.courseId,
      source: PartEntitlementSource.CODE,
      purchaseId: acquisition.id,
    },
    update: {
      source: PartEntitlementSource.CODE,
      purchaseId: acquisition.id,
      revokedAt: null,
      revokedById: null,
      revokedReason: null,
    },
    select: { id: true },
  });

  return {
    entitlementId: entitlement.id,
    acquisitionId: acquisition.id,
    coursePartId: params.coursePartId,
    partTitle: part.title,
    valueAtRedemption: pricePiastres / 100,
    sectionIds: params.sectionIds,
    alreadyHeld: false,
  };
}
