import { Injectable, Logger } from '@nestjs/common';
import {
  AccountDeletionStatus,
  AccountStatus,
  AuditAction,
  DeviceStatus,
  PlaybackTicketStatus,
  Prisma,
  SessionStatus,
  UserRole,
} from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthenticatedUser } from '../../common/types/request-context';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { AuthService, type RequestMeta } from '../auth/auth.service';
import { PasswordService } from '../auth/password.service';
import { StorageService } from '../storage/storage.service';

/**
 * Owner decision D5: a student can delete their own account from the app.
 *
 *   request  ->  PENDING for 30 days  ->  (cancel ->  CANCELLED)
 *                                     ->  sweep claims it: PROCESSING
 *                                     ->  personal data erased: COMPLETED
 *
 * WHAT "DELETED" MEANS HERE
 * The user row cannot be hard-deleted: payments, wallet ledger, enrollments,
 * redemptions, revenue rows and audit entries reference it with
 * `onDelete: Restrict`, and those are records the business must keep. So the
 * row stays as a pseudonymous anchor and everything that identifies the person
 * is erased or overwritten (see `erase`). What is retained, and why, is listed
 * in docs/audit-2026-10-27/OWNER_DECISIONS.md (D5).
 *
 * RELIABILITY
 * The state lives in `account_deletion_requests`, not in a timer. The hourly
 * sweep (AccountDeletionScheduler) re-reads the table each time, so a restart,
 * a redeploy or a missed run only delays erasure until the next sweep. Every
 * transition is a conditional `updateMany`, and a partial unique index allows
 * at most one PENDING request per user, so concurrent requests, a cancel racing
 * the sweep, or two sweepers cannot double-process an account.
 */

export const DELETION_GRACE_DAYS = 30;
/** Requests per sweep. Small: each erase is one transaction over one account. */
export const DELETION_SWEEP_BATCH = 25;
/**
 * After this many failed erase attempts the request is marked `failedAt` and
 * the sweep stops retrying it. It is then listed for an administrator
 * (`GET /admin/account-deletions/attention`), who can retry it or, on the
 * account holder's confirmed request, cancel it. Nothing was erased: each
 * attempt is one transaction that rolled back.
 */
export const DELETION_MAX_ATTEMPTS = 10;

/** Log marker an alert rule can match. Carries ids only, never personal data. */
export const DELETION_ALERT_MARKER = 'ACCOUNT_DELETION_NEEDS_ATTENTION';

/**
 * What is stored in `lastError` and written to logs: the error's class and
 * Prisma/Node code, never its message. Messages can echo query arguments.
 */
export function describeEraseError(error: unknown): string {
  if (!error || typeof error !== 'object') return 'UnknownError';
  const name = (error as { name?: unknown }).name;
  const code = (error as { code?: unknown }).code;
  const safeName = typeof name === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(name) ? name : 'Error';
  const safeCode = typeof code === 'string' && /^[A-Za-z0-9_]{1,20}$/.test(code) ? `:${code}` : '';
  return `${safeName}${safeCode}`;
}

export const DELETED_USER_NAME = 'Deleted user';
export const REDACTED_TEXT = '[removed at the account holder\'s request]';
/** Not a valid argon2/bcrypt string, so no password can ever verify against it. */
export const UNUSABLE_PASSWORD_HASH = '!account-deleted';

const REVOKE_REASON = 'Account deletion requested';

export interface DeletionRequestView {
  id: string;
  status: AccountDeletionStatus;
  requestedAt: string;
  scheduledFor: string;
  cancellable: boolean;
}

export interface DeletionSweepResult {
  claimed: number;
  completed: number;
  failed: number;
  skipped: number;
  /** Requests stopped after repeated failures, waiting for an administrator. */
  needsAttention?: number;
}

function view(row: {
  id: string;
  status: AccountDeletionStatus;
  requestedAt: Date;
  scheduledFor: Date;
}): DeletionRequestView {
  return {
    id: row.id,
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    scheduledFor: row.scheduledFor.toISOString(),
    cancellable:
      row.status === AccountDeletionStatus.PENDING && row.scheduledFor.getTime() > Date.now(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
  ) || (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002');
}

@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly storage: StorageService,
  ) {}

  // ---------------------------------------------------------------------------
  // Request
  // ---------------------------------------------------------------------------

  /**
   * Schedules deletion of the CALLER's own account. Requires the current
   * password, so an unlocked phone left on a desk is not enough.
   *
   * Idempotent: asking again while a request is open returns that request with
   * its ORIGINAL date (asking twice never moves the date).
   *
   * Every session, refresh token, live playback grant and push token is revoked
   * in the same transaction, so the account is unusable from this moment;
   * signing in again is refused until the deletion is cancelled.
   */
  async request(actor: AuthenticatedUser, password: string, meta: RequestMeta): Promise<DeletionRequestView> {
    if (actor.role !== UserRole.STUDENT) {
      // Staff accounts are managed by an administrator (users.softDelete),
      // which also protects courses from losing their only teacher.
      throw new AppException(ErrorCode.INSUFFICIENT_ROLE, {
        message: 'Staff accounts are deleted by an administrator.',
      });
    }

    const user = await this.prisma.user.findFirst({
      where: { id: actor.id, deletedAt: null },
      select: { id: true, passwordHash: true },
    });
    if (!user) throw AppException.notFound('User', actor.id);

    const valid = await this.passwords.verify(user.passwordHash, password);
    if (!valid) {
      throw new AppException(ErrorCode.INVALID_CREDENTIALS, {
        message: 'The password is incorrect.',
        fields: { password: ['The password is incorrect.'] },
      });
    }

    const open = await this.findOpen(user.id);
    if (open) return view(open);

    const now = new Date();
    const scheduledFor = new Date(now.getTime() + DELETION_GRACE_DAYS * 24 * 3600 * 1000);

    let created: { id: string; status: AccountDeletionStatus; requestedAt: Date; scheduledFor: Date };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const row = await tx.accountDeletionRequest.create({
          data: { userId: user.id, requestedAt: now, scheduledFor, source: 'app' },
          select: { id: true, status: true, requestedAt: true, scheduledFor: true },
        });
        await this.revokeAccessInTx(tx, user.id, now, REVOKE_REASON);
        await this.audit.recordTx(tx, {
          actorId: actor.id,
          actorRole: actor.role,
          action: AuditAction.DELETE,
          entity: 'account_deletion_request',
          entityId: row.id,
          note: `Account deletion requested; scheduled for ${scheduledFor.toISOString()}`,
          ipAddress: meta.ip,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
        });
        return row;
      });
    } catch (error) {
      // A concurrent request from the same account won the partial unique
      // index. That request is the answer.
      if (isUniqueViolation(error)) {
        const winner = await this.findOpen(user.id);
        if (winner) return view(winner);
      }
      throw error;
    }

    await this.redis.del(`pb:slots:${user.id}`);
    return view(created);
  }

  // ---------------------------------------------------------------------------
  // Cancel
  // ---------------------------------------------------------------------------

  /**
   * Cancels a pending deletion. Public: the account's sessions were revoked
   * when deletion was requested and sign-in is refused, so the phone and
   * password are the proof. `AuthService.verifyCredentials` gives this route
   * the same lockout, timing equalisation and failed-attempt accounting as
   * sign-in, and the route carries the credential throttle (keyed by phone).
   *
   * Only a request that is still PENDING and inside its 30 days can be
   * cancelled; the conditional update is what makes a cancel racing the sweep
   * safe - exactly one of them changes the row.
   */
  async cancel(phone: string, password: string, meta: RequestMeta): Promise<{ cancelled: true; requestId: string }> {
    const user = await this.auth.verifyCredentials(phone, password, meta);
    const now = new Date();

    const open = await this.prisma.accountDeletionRequest.findFirst({
      where: { userId: user.id, status: AccountDeletionStatus.PENDING },
      select: { id: true },
    });

    const { count } = open
      ? await this.prisma.accountDeletionRequest.updateMany({
          where: { id: open.id, status: AccountDeletionStatus.PENDING, scheduledFor: { gt: now } },
          data: { status: AccountDeletionStatus.CANCELLED, cancelledAt: now },
        })
      : { count: 0 };

    if (!open || count === 0) {
      const processing = await this.prisma.accountDeletionRequest.findFirst({
        where: { userId: user.id, status: { in: [AccountDeletionStatus.PENDING, AccountDeletionStatus.PROCESSING] } },
        select: { id: true },
      });
      throw new AppException(ErrorCode.INVALID_STATE, {
        // Past its 30 days (or being erased): the app can no longer cancel it.
        // If erasure stopped after repeated failures, an administrator can
        // still cancel it on the holder's confirmed request (cancelFailed).
        message: processing
          ? 'This deletion can no longer be cancelled in the app. Please contact support.'
          : 'There is no pending deletion for this account.',
      });
    }

    await this.audit.record({
      actorId: user.id,
      actorRole: user.role,
      action: AuditAction.UPDATE,
      entity: 'account_deletion_request',
      entityId: open.id,
      note: 'Account deletion cancelled by the account holder',
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    });

    return { cancelled: true, requestId: open.id };
  }

  // ---------------------------------------------------------------------------
  // Sweep (called by AccountDeletionScheduler under a Redis lock)
  // ---------------------------------------------------------------------------

  async sweep(now = new Date()): Promise<DeletionSweepResult> {
    const result: DeletionSweepResult = { claimed: 0, completed: 0, failed: 0, skipped: 0 };

    const due = await this.prisma.accountDeletionRequest.findMany({
      where: {
        // Requests that ran out of attempts wait for an administrator.
        failedAt: null,
        OR: [
          { status: AccountDeletionStatus.PENDING, scheduledFor: { lte: now } },
          // A PROCESSING row is one whose sweep died between the claim and the
          // erase transaction (which is atomic, so nothing half-done is left).
          // Erasure is idempotent, so it is simply run again.
          { status: AccountDeletionStatus.PROCESSING },
        ],
      },
      orderBy: { scheduledFor: 'asc' },
      take: DELETION_SWEEP_BATCH,
      select: { id: true, userId: true, status: true, attempts: true },
    });

    for (const row of due) {
      const attempt = row.attempts + 1;
      if (row.status === AccountDeletionStatus.PENDING) {
        const claim = await this.prisma.accountDeletionRequest.updateMany({
          where: { id: row.id, status: AccountDeletionStatus.PENDING, scheduledFor: { lte: now } },
          data: { status: AccountDeletionStatus.PROCESSING, attempts: { increment: 1 } },
        });
        if (claim.count === 0) {
          // Cancelled (or claimed elsewhere) since it was read.
          result.skipped += 1;
          continue;
        }
      } else {
        await this.prisma.accountDeletionRequest.update({
          where: { id: row.id },
          data: { attempts: { increment: 1 } },
        });
      }
      result.claimed += 1;

      try {
        await this.erase(row.id, row.userId);
        result.completed += 1;
      } catch (error) {
        result.failed += 1;
        const reason = describeEraseError(error);
        const exhausted = attempt >= DELETION_MAX_ATTEMPTS;
        this.logger.error(
          `account erase failed: request=${row.id} attempt=${attempt}/${DELETION_MAX_ATTEMPTS} error=${reason}` +
            (exhausted ? ` ${DELETION_ALERT_MARKER} (retries stopped; administrator action required)` : ''),
        );
        // Back to PENDING. The account stays blocked from sign-in (a pending
        // deletion), nothing was erased, and the date has passed, so the next
        // sweep retries - unless the attempts are used up.
        await this.prisma.accountDeletionRequest
          .updateMany({
            where: { id: row.id, status: AccountDeletionStatus.PROCESSING },
            data: {
              status: AccountDeletionStatus.PENDING,
              lastError: reason,
              ...(exhausted ? { failedAt: new Date() } : {}),
            },
          })
          .catch(() => undefined);
      }
    }

    // A standing signal while anything waits for an administrator, so an alert
    // on the marker keeps firing until someone acts.
    const waiting = await this.prisma.accountDeletionRequest
      .count({ where: { failedAt: { not: null }, status: AccountDeletionStatus.PENDING } })
      .catch(() => 0);
    if (waiting > 0) {
      this.logger.error(`${DELETION_ALERT_MARKER}: ${waiting} account deletion request(s) stopped after repeated failures`);
    }
    result.needsAttention = waiting;

    return result;
  }

  // ---------------------------------------------------------------------------
  // Administrator recovery (failed erasures only)
  // ---------------------------------------------------------------------------

  /** Requests whose erasure stopped after repeated failures. Ids and timings only. */
  async listNeedingAttention() {
    const rows = await this.prisma.accountDeletionRequest.findMany({
      where: { failedAt: { not: null }, status: AccountDeletionStatus.PENDING },
      orderBy: { failedAt: 'asc' },
      take: 100,
      select: {
        id: true,
        userId: true,
        status: true,
        requestedAt: true,
        scheduledFor: true,
        attempts: true,
        failedAt: true,
        lastError: true,
      },
    });
    return rows.map((r) => ({
      ...r,
      requestedAt: r.requestedAt.toISOString(),
      scheduledFor: r.scheduledFor.toISOString(),
      failedAt: r.failedAt?.toISOString() ?? null,
    }));
  }

  /**
   * Re-queues a failed erasure: the account holder still wants deletion and
   * the cause has been fixed. Only a request that stopped after repeated
   * failures qualifies; a normal pending request is untouched.
   */
  async retryFailed(requestId: string, actor: AuthenticatedUser, reason: string, meta: RequestMeta) {
    const { count } = await this.prisma.accountDeletionRequest.updateMany({
      where: { id: requestId, status: AccountDeletionStatus.PENDING, failedAt: { not: null } },
      data: { failedAt: null, attempts: 0, lastError: null },
    });
    if (count === 0) throw this.notRecoverable();
    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.UPDATE,
      entity: 'account_deletion_request',
      entityId: requestId,
      note: `Failed account erasure re-queued by an administrator: ${reason}`,
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    });
    return { id: requestId, requeued: true as const };
  }

  /**
   * Cancels a failed erasure on the account holder's confirmed request. The
   * account was never erased (every attempt rolled back), so cancelling makes
   * it usable again; the holder signs in normally. Explicit, reasoned and
   * audited - never automatic.
   */
  async cancelFailed(requestId: string, actor: AuthenticatedUser, reason: string, meta: RequestMeta) {
    const now = new Date();
    const { count } = await this.prisma.accountDeletionRequest.updateMany({
      where: { id: requestId, status: AccountDeletionStatus.PENDING, failedAt: { not: null } },
      data: { status: AccountDeletionStatus.CANCELLED, cancelledAt: now },
    });
    if (count === 0) throw this.notRecoverable();
    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.UPDATE,
      entity: 'account_deletion_request',
      entityId: requestId,
      note: `Failed account erasure cancelled by an administrator at the holder's request: ${reason}`,
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    });
    return { id: requestId, cancelled: true as const };
  }

  private notRecoverable() {
    return new AppException(ErrorCode.INVALID_STATE, {
      message: 'Only a deletion request whose erasure stopped after repeated failures can be recovered here.',
    });
  }

  /**
   * Erases the person and keeps the records. One transaction: either every
   * step happens and the request is COMPLETED, or none does and the request is
   * retried.
   */
  async erase(requestId: string, userId: string): Promise<void> {
    const now = new Date();

    await this.prisma.$transaction(
      async (tx) => {
        // Re-read inside the transaction: the request must still be claimed
        // for exactly this account, and the account must be a student. A stale
        // or mismatched call can therefore never erase anyone else.
        const current = await tx.accountDeletionRequest.findUnique({
          where: { id: requestId },
          select: { userId: true, status: true },
        });
        if (!current || current.userId !== userId || current.status !== AccountDeletionStatus.PROCESSING) {
          throw Object.assign(new Error('deletion request is not claimed for this account'), {
            name: 'DeletionRequestMismatch',
          });
        }
        const target = await tx.user.findUnique({ where: { id: userId }, select: { role: true } });
        if (!target || target.role !== UserRole.STUDENT) {
          throw Object.assign(new Error('deletion target is not a student account'), {
            name: 'DeletionTargetNotStudent',
          });
        }

        // Identity. The phone becomes a value that can never collide with a
        // real number, which also frees the number for a fresh registration.
        await tx.user.update({
          where: { id: userId },
          data: {
            fullName: DELETED_USER_NAME,
            phone: `deleted:${userId}`,
            email: null,
            avatarUrl: null,
            gender: null,
            passwordHash: UNUSABLE_PASSWORD_HASH,
            credentialsChangedAt: now,
            failedLoginCount: 0,
            lockedUntil: null,
            status: AccountStatus.DISABLED,
            deletedAt: now,
          },
        });
        await tx.studentProfile.updateMany({
          where: { userId },
          data: { studentNumber: null, notes: null },
        });

        // Access: anything a request-time revocation could have missed.
        await this.revokeAccessInTx(tx, userId, now, 'Account deleted');

        // Network and device identifiers.
        await tx.session.updateMany({ where: { userId }, data: { ipAddress: null, userAgent: null } });
        await tx.playbackTicket.updateMany({ where: { userId }, data: { ipAddress: null, userAgent: null } });
        await tx.securityEvent.updateMany({
          where: { userId },
          data: { ipAddress: null, userAgent: null, deviceKey: null, metadata: Prisma.DbNull },
        });
        await tx.accessCodeRedemption.updateMany({ where: { userId }, data: { ipAddress: null, deviceKey: null } });
        const devices = await tx.device.findMany({ where: { userId }, select: { id: true } });
        for (const device of devices) {
          // deviceKey is unique per user, so each row gets its own placeholder.
          await tx.device.update({
            where: { id: device.id },
            data: {
              deviceKey: `deleted:${device.id}`,
              name: 'Deleted device',
              model: null,
              osVersion: null,
              appVersion: null,
              status: DeviceStatus.REVOKED,
              revokedAt: now,
              revokedReason: 'Account deleted',
            },
          });
        }

        // Rows that exist only for the person and carry nothing to keep.
        await tx.deviceChangeRequest.deleteMany({ where: { userId } });
        await tx.pushToken.deleteMany({ where: { userId } });
        await tx.notification.deleteMany({ where: { userId } });
        await tx.notificationPreference.deleteMany({ where: { userId } });

        // Support: the ticket stays (staff workload and audit), what the
        // student wrote does not.
        await tx.supportTicket.updateMany({ where: { userId }, data: { subject: REDACTED_TEXT } });
        await tx.supportMessage.updateMany({ where: { authorId: userId }, data: { body: REDACTED_TEXT } });

        await tx.accountDeletionRequest.update({
          where: { id: requestId },
          data: { status: AccountDeletionStatus.COMPLETED, completedAt: now, lastError: null },
        });

        await this.audit.recordTx(tx, {
          actorId: null,
          actorRole: null,
          action: AuditAction.DELETE,
          entity: 'user',
          entityId: userId,
          note: `Personal data erased at the account holder's request (deletion request ${requestId})`,
        });
      },
      { timeout: 60_000, maxWait: 10_000 },
    );

    // Outside the transaction, best effort: object storage and cache cannot
    // roll back with Postgres, and a leftover avatar file is unreferenced.
    await this.redis.del(`pb:slots:${userId}`);
    if (this.storage.isConfigured) {
      await this.storage
        .deletePrefix('media', `avatars/${userId}/`)
        .catch((error: Error) => this.logger.warn(`avatar cleanup failed for ${userId}: ${error.message}`));
    }
  }

  // ---------------------------------------------------------------------------

  private findOpen(userId: string) {
    // A request that stopped after repeated failures is still PENDING, so it is
    // still "open": asking again returns it rather than creating a second one.
    return this.prisma.accountDeletionRequest.findFirst({
      where: {
        userId,
        status: { in: [AccountDeletionStatus.PENDING, AccountDeletionStatus.PROCESSING] },
      },
      select: { id: true, status: true, requestedAt: true, scheduledFor: true },
    });
  }

  private async revokeAccessInTx(tx: Prisma.TransactionClient, userId: string, now: Date, reason: string) {
    await tx.session.updateMany({
      where: { userId, status: SessionStatus.ACTIVE },
      data: { status: SessionStatus.REVOKED, revokedAt: now, revokedReason: reason },
    });
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now, revokedReason: reason },
    });
    await tx.playbackTicket.updateMany({
      where: { userId, status: PlaybackTicketStatus.ACTIVE },
      data: { status: PlaybackTicketStatus.REVOKED, revokedAt: now, revokedReason: reason },
    });
    // Queued pushes check `isActive`, so nothing more reaches the devices.
    await tx.pushToken.updateMany({ where: { userId, isActive: true }, data: { isActive: false } });
  }
}
