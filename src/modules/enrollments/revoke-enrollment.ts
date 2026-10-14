import { AuditAction, EnrollmentState, PaymentStatus, type Prisma, type UserRole } from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuditService } from '../audit/audit.service';

/**
 * Revokes one student's enrollment in one course, inside the caller's
 * transaction.
 *
 * This is the single place access is withdrawn by an administrator. Both
 * "Remove from course" (`EnrollmentsService.revoke`) and every refund
 * (`RefundsService`) call it, so the two can never disagree about what
 * "revoked" means. A free function rather than a service method because
 * `EnrollmentsService` already depends on `PaymentsService`; injecting the
 * other way round would be a cycle.
 *
 * What it does:
 *
 *  - the enrollment becomes REVOKED. Every access check (lesson gate,
 *    playback ticket and heartbeat, attachment ticket, my-courses, search,
 *    announcements, expiry reminders) reads that state live — there is no
 *    access cache — so access ends at once; ACTIVE playback tickets are revoked
 *    as well;
 *  - the enrollment's section grants are removed and `coversAllSections` is
 *    cleared, so a later re-enrollment starts from what that later purchase
 *    buys. Grant-access only ever widens, so without this a student removed
 *    from a full-course enrollment who later redeemed a one-section card got
 *    the whole course back. The grants are snapshotted into the audit entry,
 *    and what was bought stays on the code redemptions and part purchases;
 *  - the student's live part entitlements on this course are revoked (the
 *    schema's additive revocation — the rows stay);
 *  - PENDING payments on this enrollment are CANCELLED. No money has moved on
 *    a pending payment, and `capture()` sets the enrollment ACTIVE, so leaving
 *    one open would let a late confirmation silently undo the revocation;
 *  - the course's student count is recounted.
 *
 * What it deliberately does NOT do: refund, touch PAID payments or revenue,
 * return a code, or touch watch history, counted plays, the wallet, other
 * courses' enrollments or the account.
 *
 * Refused while a payment on this enrollment is AUTHORIZED: that money is held
 * at a provider and has to be captured or voided there first.
 *
 * Idempotent: an already-REVOKED enrollment is returned unchanged with
 * `alreadyRevoked: true`. The state change is conditional on the state just
 * read, so two concurrent revocations cannot both apply the side effects.
 */
export async function revokeEnrollmentInTx(
  tx: Prisma.TransactionClient,
  audit: Pick<AuditService, 'recordTx'>,
  params: {
    enrollmentId: string;
    actor: { id: string; role: UserRole };
    reason: string;
    /** When set, an enrollment of any other course is answered as not found. */
    expectedCourseId?: string;
    /** Extra context for the audit entry, e.g. the refund that caused this. */
    auditContext?: Record<string, unknown>;
    /** Why live playback stopped, as recorded on the tickets. */
    ticketReason?: string;
  },
) {
  const { enrollmentId, actor, reason } = params;

  const enrollment = await tx.enrollment.findUnique({
    where: { id: enrollmentId },
    include: {
      sectionGrants: {
        select: { sectionId: true, source: true, codeId: true, partId: true, createdAt: true },
      },
    },
  });

  // A course id that does not match is answered exactly like a missing
  // enrollment: the caller asked about this student *in that course*.
  if (!enrollment || (params.expectedCourseId && enrollment.courseId !== params.expectedCourseId)) {
    throw AppException.notFound('Enrollment', enrollmentId);
  }

  const retained = async () => {
    const [paidPayments, codeRedemptions] = await Promise.all([
      tx.payment.count({
        where: {
          enrollmentId,
          status: { in: [PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED] },
        },
      }),
      tx.accessCodeRedemption.count({ where: { enrollmentId } }),
    ]);
    return { paidPayments, codeRedemptions };
  };

  const unchanged = async () => ({
    enrollment,
    alreadyRevoked: true,
    cancelledPayments: 0,
    cancelledPaymentIds: [] as string[],
    revokedPartEntitlements: 0,
    removedSectionGrants: 0,
    revokedPlaybackTickets: 0,
    retained: await retained(),
  });

  if (enrollment.state === EnrollmentState.REVOKED) return unchanged();

  const authorized = await tx.payment.count({
    where: { enrollmentId, status: PaymentStatus.AUTHORIZED },
  });
  if (authorized > 0) {
    throw new AppException(ErrorCode.INVALID_STATE, {
      message:
        'This enrollment has a payment authorised at the provider. Capture or void it before revoking access.',
      details: { enrollmentId, authorizedPayments: authorized },
    });
  }

  const now = new Date();

  const { count } = await tx.enrollment.updateMany({
    where: { id: enrollmentId, state: { not: EnrollmentState.REVOKED } },
    data: {
      state: EnrollmentState.REVOKED,
      revokedAt: now,
      revokedById: actor.id,
      revokedReason: reason,
      coversAllSections: false,
    },
  });
  if (count === 0) return unchanged();

  const removedGrants = await tx.enrollmentSectionGrant.deleteMany({
    where: { enrollmentId },
  });

  const pending = await tx.payment.findMany({
    where: { enrollmentId, status: PaymentStatus.PENDING },
    select: { id: true, amount: true, currency: true },
  });
  if (pending.length > 0) {
    await tx.payment.updateMany({
      where: { id: { in: pending.map((p) => p.id) }, status: PaymentStatus.PENDING },
      data: { status: PaymentStatus.CANCELLED, failureCode: 'ENROLLMENT_REVOKED' },
    });
    await tx.paymentTransaction.createMany({
      data: pending.map((p) => ({
        paymentId: p.id,
        type: 'cancel',
        status: 'enrollment_revoked',
        amount: p.amount,
        currency: p.currency,
      })),
    });
  }

  const parts = await tx.coursePartEntitlement.updateMany({
    where: { userId: enrollment.userId, courseId: enrollment.courseId, revokedAt: null },
    data: { revokedAt: now, revokedById: actor.id, revokedReason: reason },
  });

  const tickets = await tx.playbackTicket.updateMany({
    where: {
      userId: enrollment.userId,
      courseId: enrollment.courseId,
      status: 'ACTIVE',
    },
    data: {
      status: 'REVOKED',
      revokedAt: now,
      revokedReason: params.ticketReason ?? 'Enrollment revoked',
    },
  });

  const studentCount = await tx.enrollment.count({
    where: { courseId: enrollment.courseId, state: EnrollmentState.ACTIVE },
  });
  await tx.course.update({
    where: { id: enrollment.courseId },
    data: { studentCount },
  });

  const outcome = {
    enrollment,
    alreadyRevoked: false,
    cancelledPayments: pending.length,
    cancelledPaymentIds: pending.map((p) => p.id),
    revokedPartEntitlements: parts.count,
    removedSectionGrants: removedGrants.count,
    revokedPlaybackTickets: tickets.count,
    retained: await retained(),
  };

  // In the transaction, so the revocation and its record commit together.
  await audit.recordTx(tx, {
    actorId: actor.id,
    actorRole: actor.role,
    action: AuditAction.ACCESS_REVOKE,
    entity: 'enrollment',
    entityId: enrollmentId,
    before: {
      userId: enrollment.userId,
      courseId: enrollment.courseId,
      state: enrollment.state,
      coversAllSections: enrollment.coversAllSections,
      sectionGrants: enrollment.sectionGrants.map((g) => ({
        ...g,
        createdAt: g.createdAt.toISOString(),
      })),
    },
    after: {
      state: EnrollmentState.REVOKED,
      cancelledPaymentIds: outcome.cancelledPaymentIds,
      revokedPartEntitlements: parts.count,
      revokedPlaybackTickets: tickets.count,
      retained: outcome.retained,
      ...(params.auditContext ?? {}),
    },
    note: reason,
  });

  return outcome;
}
