import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type AttachmentKind,
  AuditAction,
  SecurityEventType,
  type UserRole,
} from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthenticatedUser } from '../../common/types/request-context';
import type { PlaybackConfig } from '../../config/configuration';
import { PrismaService, notDeleted } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CourseAccessService } from '../courses/course-access.service';
import { toAttachment } from '../courses/course.serializer';
import { DevicesService } from '../devices/devices.service';
import { SecurityEventService } from '../security/security-event.service';
import { StorageService } from '../storage/storage.service';

/** Matches the mobile app's `AttachmentTicket` type. */
export interface AttachmentTicketResponse {
  attachmentId: string;
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
  watermark: {
    primary: string;
    secondary: string;
    sessionTag: string;
    opacity: number;
    moveIntervalSeconds: number;
  };
}

/**
 * Course materials.
 *
 * Protected attachments follow the same model as video (spec §46/§47): no
 * permanent URL, a short-lived viewer-bound signed link, device binding
 * enforced, and a watermark payload so a leaked PDF screenshot is traceable.
 *
 * The one difference from video: there is no streaming session, so no
 * concurrency slot and no heartbeat. The link simply expires.
 */
@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);
  private readonly cfg: PlaybackConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CourseAccessService,
    private readonly devices: DevicesService,
    private readonly storage: StorageService,
    private readonly security: SecurityEventService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.cfg = config.getOrThrow<PlaybackConfig>('playback');
  }

  // ---------------------------------------------------------------------------
  // Student access
  // ---------------------------------------------------------------------------

  async issueTicket(params: {
    user: AuthenticatedUser;
    attachmentId: string;
    integritySuspect: boolean;
    ip?: string | null;
  }): Promise<AttachmentTicketResponse> {
    const attachment = await this.prisma.attachment.findFirst({
      where: { id: params.attachmentId, ...notDeleted },
      include: { course: { select: { id: true, status: true } } },
    });

    if (!attachment) throw AppException.notFound('Attachment', params.attachmentId);

    await this.access.assertContentAccess({
      userId: params.user.id,
      role: params.user.role,
      courseId: attachment.courseId,
      allowPreview: true,
      isPreviewContent: attachment.isPreview,
    });

    // Protected material is device-bound exactly like video. Un-protected
    // handouts (a syllabus) are not, because they are meant to be shareable.
    if (attachment.isProtected) {
      await this.devices.assertAuthorizedForProtectedContent({
        userId: params.user.id,
        role: params.user.role,
        deviceKey: params.user.deviceKey,
        integritySuspect: params.integritySuspect,
        ip: params.ip,
      });
    }

    const ttl = this.cfg.ticketTtl;
    const expiresAt = new Date(Date.now() + ttl * 1000);

    const bucket = attachment.objectKey.startsWith('attachments/') ? 'uploads' : 'media';

    const url = await this.storage.signMediaUrl({
      objectKey: attachment.objectKey,
      expiresInSeconds: ttl,
      userId: params.user.id,
      sessionId: params.user.sessionId,
      deviceId: params.user.deviceId,
      ticketId: `att_${attachment.id}`,
    });

    const profile = await this.prisma.user.findUniqueOrThrow({
      where: { id: params.user.id },
      select: { fullName: true },
    });

    if (attachment.lessonId) {
      await this.prisma.watchEvent
        .create({
          data: {
            userId: params.user.id,
            lessonId: attachment.lessonId,
            courseId: attachment.courseId,
            type: 'STARTED',
            positionSeconds: 0,
          },
        })
        .catch(() => undefined);
    }

    return {
      attachmentId: attachment.id,
      url,
      headers: {},
      expiresAt: expiresAt.toISOString(),
      watermark: {
        primary: profile.fullName,
        secondary: `ID: ${params.user.id.slice(-8).toUpperCase()}`,
        sessionTag: createHash('sha256')
          .update(`${params.user.id}:${attachment.id}:${randomBytes(8).toString('hex')}`)
          .digest('base64url')
          .slice(0, 16)
          .toUpperCase(),
        opacity: 0.25,
        moveIntervalSeconds: 30,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Authoring
  // ---------------------------------------------------------------------------

  async create(
    input: {
      courseId: string;
      lessonId?: string;
      title: string;
      kind: AttachmentKind;
      objectKey: string;
      mimeType?: string;
      sizeBytes?: number;
      pageCount?: number;
      isProtected?: boolean;
      isDownloadable?: boolean;
      isPreview?: boolean;
      sortOrder?: number;
    },
    actor: { id: string; role: UserRole },
  ) {
    await this.access.assertCanManageCourse(actor.id, actor.role, input.courseId, 'content');

    if (input.lessonId) {
      const lesson = await this.prisma.lesson.findFirst({
        where: { id: input.lessonId, courseId: input.courseId, ...notDeleted },
        select: { id: true },
      });
      if (!lesson) {
        throw AppException.validation({
          lessonId: ['lesson does not belong to this course'],
        });
      }
    }

    const isProtected = input.isProtected ?? true;

    const attachment = await this.prisma.attachment.create({
      data: {
        courseId: input.courseId,
        lessonId: input.lessonId,
        title: input.title.trim(),
        kind: input.kind,
        objectKey: input.objectKey,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes ? BigInt(input.sizeBytes) : null,
        pageCount: input.pageCount,
        isProtected,
        // A protected file is never downloadable — the two flags contradict
        // each other and protection wins.
        isDownloadable: isProtected ? false : (input.isDownloadable ?? true),
        isPreview: input.isPreview ?? false,
        sortOrder: input.sortOrder ?? 0,
        uploadedById: actor.id,
      },
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.CREATE,
      entity: 'attachment',
      entityId: attachment.id,
      after: { courseId: input.courseId, title: attachment.title, isProtected },
    });

    return toAttachment(attachment, true);
  }

  async update(
    attachmentId: string,
    input: {
      title?: string;
      isProtected?: boolean;
      isDownloadable?: boolean;
      isPreview?: boolean;
      sortOrder?: number;
    },
    actor: { id: string; role: UserRole },
  ) {
    const attachment = await this.prisma.attachment.findFirst({
      where: { id: attachmentId, ...notDeleted },
    });
    if (!attachment) throw AppException.notFound('Attachment', attachmentId);

    await this.access.assertCanManageCourse(
      actor.id,
      actor.role,
      attachment.courseId,
      'content',
    );

    const isProtected = input.isProtected ?? attachment.isProtected;

    const updated = await this.prisma.attachment.update({
      where: { id: attachmentId },
      data: {
        title: input.title?.trim(),
        isProtected,
        isDownloadable: isProtected ? false : input.isDownloadable,
        isPreview: input.isPreview,
        sortOrder: input.sortOrder,
      },
    });

    return toAttachment(updated, true);
  }

  async remove(attachmentId: string, actor: { id: string; role: UserRole }) {
    const attachment = await this.prisma.attachment.findFirst({
      where: { id: attachmentId, ...notDeleted },
    });
    if (!attachment) throw AppException.notFound('Attachment', attachmentId);

    await this.access.assertCanManageCourse(
      actor.id,
      actor.role,
      attachment.courseId,
      'content',
    );

    await this.prisma.attachment.update({
      where: { id: attachmentId },
      data: { deletedAt: new Date() },
    });

    const bucket = attachment.objectKey.startsWith('attachments/') ? 'uploads' : 'media';
    await this.storage.deleteObject(bucket, attachment.objectKey).catch(() => undefined);

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.DELETE,
      entity: 'attachment',
      entityId: attachmentId,
    });

    return { ok: true };
  }

  async listForLesson(lessonId: string, userId: string, role: UserRole) {
    const lesson = await this.prisma.lesson.findFirst({
      where: { id: lessonId, ...notDeleted },
      select: { id: true, courseId: true, isPreview: true },
    });
    if (!lesson) throw AppException.notFound('Lesson', lessonId);

    const decision = await this.access.resolve({ userId, role, courseId: lesson.courseId });

    const rows = await this.prisma.attachment.findMany({
      where: { lessonId, ...notDeleted },
      orderBy: { sortOrder: 'asc' },
    });

    return rows.map((a) => toAttachment(a, decision.canAccessContent));
  }
}
