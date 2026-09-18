import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';

/**
 * A student's course-part acquisition history.
 *
 * ── What this service is NOT, and why ───────────────────────────────────────
 *
 * It does not buy anything. An earlier build let a student purchase a course
 * part by debiting wallet credits; that was wrong under the platform's
 * financial rule and has been removed entirely.
 *
 *     The wallet is for the Library. Courses and course parts never touch it.
 *
 * A course part is unlocked by redeeming a part-scoped access card, handled in
 * `EnrollmentsService.redeemCode()` → `grantPartFromCode()`. The money changes
 * hands offline when the card is sold, exactly as it already does for
 * course-scoped and section-scoped cards.
 *
 * So there is no `purchase()` here, no `quote()`, and no `WalletService`
 * dependency. What remains is the read side: the record of which parts a
 * student holds, what each was worth when they got it, and which card
 * unlocked it.
 */
@Injectable()
export class CoursePartPurchaseService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The student's own part acquisitions.
   *
   * `valueAtAcquisition` is the frozen figure recorded at redemption — what the
   * part was worth at that moment. A later change to the course price or the
   * part's share never rewrites it, which is the whole reason it is stored
   * rather than recomputed.
   *
   * It is deliberately NOT called a price paid: the student paid for a card,
   * offline, and that card's face value is a separate figure held on the card
   * itself. Conflating the two would misreport both.
   */
  async myPurchases(userId: string, page: number, pageSize: number) {
    const where = { userId };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.coursePartPurchase.findMany({
        where,
        orderBy: { purchasedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          courseId: true,
          coursePartId: true,
          courseTitleSnapshot: true,
          partTitleSnapshot: true,
          priceAtPurchase: true,
          currency: true,
          purchasedAt: true,
          accessCodeId: true,
        },
      }),
      this.prisma.coursePartPurchase.count({ where }),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        courseId: row.courseId,
        courseTitle: row.courseTitleSnapshot,
        partId: row.coursePartId,
        partTitle: row.partTitleSnapshot,
        valueAtAcquisition: Number(row.priceAtPurchase),
        currency: row.currency,
        // How it was obtained. `CODE` is the only path that writes new rows;
        // `WALLET` rows are history from the withdrawn wallet purchase build.
        acquiredVia: row.accessCodeId ? 'CODE' : 'WALLET',
        acquiredAt: row.purchasedAt.toISOString(),
      })),
      meta: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / Math.max(1, pageSize))),
        hasNext: page * pageSize < total,
        hasPrevious: page > 1,
      },
    };
  }
}
