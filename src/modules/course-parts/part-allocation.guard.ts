import { ContentStatus, type Prisma } from '@prisma/client';

import { allocatePartPrices, type AllocationResult } from './part-pricing';

/**
 * Loads a course's sellable parts and proves their prices still add up.
 *
 * A plain function rather than a service method on purpose. `CoursesModule` is
 * `@Global` and already provides the access engine to half the platform; if the
 * course-price path had to inject a *service* from the parts module, and the
 * parts module kept using the access engine, the two would import each other.
 * Taking a transaction client as an argument sidesteps that entirely and, as a
 * bonus, lets the check run inside the same transaction as the write it guards.
 *
 * `null` means the course has no sellable parts, which is not a failure — it is
 * what every course that predates this feature looks like, and what a course
 * sold only as a whole looks like.
 */
export async function loadPartAllocation(
  tx: Prisma.TransactionClient,
  courseId: string,
  coursePrice: number | string,
): Promise<AllocationResult | null> {
  const parts = await tx.coursePart.findMany({
    where: {
      courseId,
      deletedAt: null,
      isActive: true,
      status: { not: ContentStatus.ARCHIVED },
    },
    orderBy: { sortOrder: 'asc' },
    select: {
      id: true,
      title: true,
      sortOrder: true,
      pricingModel: true,
      pricePercent: true,
      priceAmount: true,
    },
  });

  if (parts.length === 0) return null;

  return allocatePartPrices(
    parts.map((part) => ({
      id: part.id,
      title: part.title,
      sortOrder: part.sortOrder,
      pricingModel: part.pricingModel,
      pricePercent: part.pricePercent?.toString() ?? null,
      priceAmount: part.priceAmount?.toString() ?? null,
    })),
    coursePrice,
  );
}

/**
 * Refuses a course price change that would leave fixed-price parts no longer
 * summing to the course total.
 *
 * Percentage parts need no check — they float with the price by definition, so
 * they always still add to 100%. Fixed parts do not float, which is the whole
 * point of choosing them, and that means a price change can silently strand
 * them: 300 + 400 + 300 was the course price yesterday and is 50 EGP short of
 * it today. Rather than let a course sit in a state where buying every part
 * does not buy the course, the price change is refused and the admin is told
 * the exact shortfall so they can fix the parts first.
 *
 * Existing purchases are unaffected either way — they carry their own frozen
 * price and never consult this.
 */
export async function assertPriceChangeKeepsAllocationValid(
  tx: Prisma.TransactionClient,
  courseId: string,
  newCoursePrice: number | string,
): Promise<void> {
  // Throws AppException.validation naming the shortfall or excess.
  await loadPartAllocation(tx, courseId, newCoursePrice);
}
