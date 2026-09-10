import { Injectable, Logger } from '@nestjs/common';
import {
  AuditAction,
  NotificationKind,
  type Prisma,
  SupportTicketCategory,
  SupportTicketPriority,
  SupportTicketStatus,
  UserRole,
} from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { paginated } from '../../common/types/api-response';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';

const STAFF_ROLES: UserRole[] = [UserRole.MASTER, UserRole.ADMIN];

/**
 * Support tickets.
 *
 * Two rules shape everything here:
 *
 *  1. **Nothing is ever destroyed.** Closing or resolving a ticket is a status
 *     change; messages are append-only. A support history is the evidence in
 *     a payment dispute, so there is no delete path at all — not for staff,
 *     not for the student who wrote it.
 *
 *  2. **A student sees their own tickets and nothing else.** Every read is
 *     scoped by `userId` at the query level rather than filtered afterwards,
 *     so an id guessed from another account returns 404, not someone else's
 *     conversation.
 *
 * Internal notes (`isInternal`) are stripped from every student-facing read.
 */
@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Student
  // ---------------------------------------------------------------------------

  async createTicket(params: {
    userId: string;
    subject: string;
    body: string;
    category?: SupportTicketCategory;
    courseId?: string;
  }) {
    const reference = await this.nextReference();

    const ticket = await this.prisma.$transaction(async (tx) => {
      const created = await tx.supportTicket.create({
        data: {
          reference,
          userId: params.userId,
          subject: params.subject.trim(),
          category: params.category ?? SupportTicketCategory.GENERAL,
          courseId: params.courseId ?? null,
          lastMessageAt: new Date(),
          lastMessageBy: params.userId,
          unreadForStaff: 1,
        },
      });

      await tx.supportMessage.create({
        data: {
          ticketId: created.id,
          authorId: params.userId,
          authorRole: UserRole.STUDENT,
          body: params.body.trim(),
        },
      });

      return created;
    });

    return this.detailForStudent(ticket.id, params.userId);
  }

  async listForStudent(params: { userId: string; page: number; pageSize: number }) {
    const where: Prisma.SupportTicketWhereInput = { userId: params.userId };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.supportTicket.findMany({
        where,
        orderBy: { lastMessageAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        select: {
          id: true,
          reference: true,
          subject: true,
          category: true,
          status: true,
          priority: true,
          lastMessageAt: true,
          createdAt: true,
        },
      }),
      this.prisma.supportTicket.count({ where }),
    ]);

    return paginated(
      rows.map((t) => ({
        id: t.id,
        reference: t.reference,
        subject: t.subject,
        category: t.category,
        status: t.status,
        priority: t.priority,
        lastMessageAt: t.lastMessageAt.toISOString(),
        createdAt: t.createdAt.toISOString(),
      })),
      total,
      params.page,
      params.pageSize,
    );
  }

  async detailForStudent(ticketId: string, userId: string) {
    // Scoped by userId in the WHERE clause, so another student's id is simply
    // not found rather than found-and-then-refused.
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { id: ticketId, userId },
      include: {
        messages: {
          where: { isInternal: false },
          orderBy: { createdAt: 'asc' },
          include: { author: { select: { id: true, fullName: true, role: true } } },
        },
      },
    });
    if (!ticket) throw AppException.notFound('Support ticket', ticketId);

    return this.serializeTicket(ticket, { includeInternal: false });
  }

  async addStudentMessage(params: { ticketId: string; userId: string; body: string }) {
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { id: params.ticketId, userId: params.userId },
      select: { id: true, status: true },
    });
    if (!ticket) throw AppException.notFound('Support ticket', params.ticketId);

    if (ticket.status === SupportTicketStatus.CLOSED) {
      throw new AppException(ErrorCode.INVALID_STATE, {
        message: 'This ticket is closed. Please open a new one.',
      });
    }

    await this.prisma.$transaction([
      this.prisma.supportMessage.create({
        data: {
          ticketId: ticket.id,
          authorId: params.userId,
          authorRole: UserRole.STUDENT,
          body: params.body.trim(),
        },
      }),
      this.prisma.supportTicket.update({
        where: { id: ticket.id },
        data: {
          // A reply reopens a resolved ticket: the student is telling us it
          // was not, in fact, resolved.
          status:
            ticket.status === SupportTicketStatus.RESOLVED
              ? SupportTicketStatus.OPEN
              : ticket.status,
          lastMessageAt: new Date(),
          lastMessageBy: params.userId,
          unreadForStaff: { increment: 1 },
          resolvedAt: null,
        },
      }),
    ]);

    return this.detailForStudent(ticket.id, params.userId);
  }

  // ---------------------------------------------------------------------------
  // Staff
  // ---------------------------------------------------------------------------

  async listForStaff(params: {
    page: number;
    pageSize: number;
    status?: SupportTicketStatus;
    priority?: SupportTicketPriority;
    category?: SupportTicketCategory;
    assignedToId?: string;
    q?: string;
  }) {
    const where: Prisma.SupportTicketWhereInput = {
      ...(params.status ? { status: params.status } : {}),
      ...(params.priority ? { priority: params.priority } : {}),
      ...(params.category ? { category: params.category } : {}),
      ...(params.assignedToId ? { assignedToId: params.assignedToId } : {}),
      ...(params.q
        ? {
            OR: [
              { reference: { contains: params.q, mode: 'insensitive' } },
              { subject: { contains: params.q, mode: 'insensitive' } },
              { user: { fullName: { contains: params.q, mode: 'insensitive' } } },
              { user: { phone: { contains: params.q.replace(/\D/g, '') } } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.supportTicket.findMany({
        where,
        orderBy: [{ status: 'asc' }, { lastMessageAt: 'desc' }],
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: {
          user: { select: { id: true, fullName: true, phone: true } },
          assignedTo: { select: { id: true, fullName: true } },
          _count: { select: { messages: true } },
        },
      }),
      this.prisma.supportTicket.count({ where }),
    ]);

    return paginated(
      rows.map((t) => ({
        id: t.id,
        reference: t.reference,
        subject: t.subject,
        category: t.category,
        status: t.status,
        priority: t.priority,
        student: t.user,
        assignedTo: t.assignedTo,
        messageCount: t._count.messages,
        unreadForStaff: t.unreadForStaff,
        lastMessageAt: t.lastMessageAt.toISOString(),
        createdAt: t.createdAt.toISOString(),
      })),
      total,
      params.page,
      params.pageSize,
    );
  }

  async detailForStaff(ticketId: string) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: {
        user: {
          select: { id: true, fullName: true, phone: true, email: true, status: true },
        },
        assignedTo: { select: { id: true, fullName: true } },
        messages: {
          orderBy: { createdAt: 'asc' },
          include: { author: { select: { id: true, fullName: true, role: true } } },
        },
      },
    });
    if (!ticket) throw AppException.notFound('Support ticket', ticketId);

    // Opening a ticket clears the staff unread marker; it is a read receipt,
    // not a state change worth auditing.
    if (ticket.unreadForStaff > 0) {
      await this.prisma.supportTicket
        .update({ where: { id: ticketId }, data: { unreadForStaff: 0 } })
        .catch(() => undefined);
    }

    return {
      ...this.serializeTicket(ticket, { includeInternal: true }),
      student: ticket.user,
      assignedTo: ticket.assignedTo,
    };
  }

  async reply(params: {
    ticketId: string;
    body: string;
    isInternal?: boolean;
    actor: { id: string; role: UserRole };
  }) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: params.ticketId },
      select: { id: true, userId: true, reference: true, subject: true, status: true },
    });
    if (!ticket) throw AppException.notFound('Support ticket', params.ticketId);

    await this.prisma.$transaction([
      this.prisma.supportMessage.create({
        data: {
          ticketId: ticket.id,
          authorId: params.actor.id,
          authorRole: params.actor.role,
          body: params.body.trim(),
          isInternal: params.isInternal ?? false,
        },
      }),
      this.prisma.supportTicket.update({
        where: { id: ticket.id },
        data: {
          // An internal note is not a reply to the student, so it must not
          // move the ticket out of OPEN or reset the unread counter.
          ...(params.isInternal
            ? {}
            : {
                status:
                  ticket.status === SupportTicketStatus.OPEN
                    ? SupportTicketStatus.PENDING
                    : ticket.status,
                lastMessageAt: new Date(),
                lastMessageBy: params.actor.id,
                unreadForStaff: 0,
              }),
        },
      }),
    ]);

    if (!params.isInternal) {
      await this.notifications
        .createForUser({
          userId: ticket.userId,
          kind: NotificationKind.ADMIN,
          title: 'Support replied to your message',
          titleAr: 'تم الرد على رسالتك',
          body: `We answered your ticket ${ticket.reference}: ${ticket.subject}`,
          bodyAr: `تم الرد على تذكرتك ${ticket.reference}: ${ticket.subject}`,
          route: `/support/${ticket.id}`,
        })
        .catch((error: unknown) => {
          // A notification failure must not lose the reply that was written.
          this.logger.warn(`support reply notification failed: ${String(error)}`);
        });
    }

    await this.audit.record({
      actorId: params.actor.id,
      actorRole: params.actor.role,
      action: AuditAction.UPDATE,
      entity: 'support_ticket',
      entityId: ticket.id,
      after: { replied: true, internal: params.isInternal ?? false },
    });

    return this.detailForStaff(ticket.id);
  }

  async updateTicket(
    ticketId: string,
    patch: {
      status?: SupportTicketStatus;
      priority?: SupportTicketPriority;
      category?: SupportTicketCategory;
      assignedToId?: string | null;
    },
    actor: { id: string; role: UserRole },
  ) {
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw AppException.notFound('Support ticket', ticketId);

    if (patch.assignedToId) {
      const assignee = await this.prisma.user.findFirst({
        where: { id: patch.assignedToId, role: { in: STAFF_ROLES }, deletedAt: null },
        select: { id: true },
      });
      if (!assignee) {
        throw AppException.validation({ assignedToId: ['must be an admin account'] });
      }
    }

    const now = new Date();

    const updated = await this.prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.priority ? { priority: patch.priority } : {}),
        ...(patch.category ? { category: patch.category } : {}),
        ...(patch.assignedToId !== undefined ? { assignedToId: patch.assignedToId } : {}),
        ...(patch.status === SupportTicketStatus.RESOLVED ? { resolvedAt: now } : {}),
        ...(patch.status === SupportTicketStatus.CLOSED ? { closedAt: now } : {}),
        ...(patch.status === SupportTicketStatus.OPEN ? { resolvedAt: null, closedAt: null } : {}),
      },
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.UPDATE,
      entity: 'support_ticket',
      entityId: ticketId,
      before: {
        status: ticket.status,
        priority: ticket.priority,
        category: ticket.category,
        assignedToId: ticket.assignedToId,
      },
      after: {
        status: updated.status,
        priority: updated.priority,
        category: updated.category,
        assignedToId: updated.assignedToId,
      },
    });

    return this.detailForStaff(ticketId);
  }

  /** Inbox counters for the dashboard badge. */
  async counters() {
    const [open, pending, resolved, closed, unread] = await this.prisma.$transaction([
      this.prisma.supportTicket.count({ where: { status: SupportTicketStatus.OPEN } }),
      this.prisma.supportTicket.count({ where: { status: SupportTicketStatus.PENDING } }),
      this.prisma.supportTicket.count({ where: { status: SupportTicketStatus.RESOLVED } }),
      this.prisma.supportTicket.count({ where: { status: SupportTicketStatus.CLOSED } }),
      this.prisma.supportTicket.count({ where: { unreadForStaff: { gt: 0 } } }),
    ]);

    return { open, pending, resolved, closed, unread, total: open + pending + resolved + closed };
  }

  // ---------------------------------------------------------------------------

  private serializeTicket(
    ticket: {
      id: string;
      reference: string;
      subject: string;
      category: SupportTicketCategory;
      status: SupportTicketStatus;
      priority: SupportTicketPriority;
      courseId: string | null;
      lastMessageAt: Date;
      createdAt: Date;
      messages: {
        id: string;
        body: string;
        isInternal: boolean;
        authorRole: UserRole;
        createdAt: Date;
        author: { id: string; fullName: string; role: UserRole } | null;
      }[];
    },
    options: { includeInternal: boolean },
  ) {
    return {
      id: ticket.id,
      reference: ticket.reference,
      subject: ticket.subject,
      category: ticket.category,
      status: ticket.status,
      priority: ticket.priority,
      courseId: ticket.courseId,
      lastMessageAt: ticket.lastMessageAt.toISOString(),
      createdAt: ticket.createdAt.toISOString(),
      messages: ticket.messages
        .filter((m) => options.includeInternal || !m.isInternal)
        .map((m) => ({
          id: m.id,
          body: m.body,
          isInternal: m.isInternal,
          authorRole: m.authorRole,
          author: m.author,
          createdAt: m.createdAt.toISOString(),
        })),
    };
  }

  /**
   * Human-facing reference.
   *
   * Derived from the row count rather than a sequence because it is a display
   * label, not an identifier: uniqueness is guaranteed by the unique index,
   * and the retry loop covers the race between two concurrent creates.
   */
  private async nextReference(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const count = await this.prisma.supportTicket.count();
      const candidate = `TK-${String(count + 1 + attempt).padStart(6, '0')}`;
      const clash = await this.prisma.supportTicket.findUnique({
        where: { reference: candidate },
        select: { id: true },
      });
      if (!clash) return candidate;
    }
    return `TK-${Date.now().toString(36).toUpperCase()}`;
  }
}
