import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ContentStatus,
  SecurityEventType,
  SecuritySeverity,
  UserRole,
} from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthenticatedUser } from '../../common/types/request-context';
import type { PlaybackConfig } from '../../config/configuration';
import { PrismaService, notDeleted } from '../../database/prisma.service';
import { DevicesService } from '../devices/devices.service';
import { SecurityEventService } from '../security/security-event.service';
import { StorageService } from '../storage/storage.service';

export interface LibraryDocumentTicket {
  libraryPartId: string;
  title: string;
  url: string;
  mimeType: string | null;
  pageCount: number | null;
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
 * Opening a library document.
 *
 * ── The shape of the protection, and its honest limits ──────────────────────
 *
 * A part's `objectKey` is never sent to a client and the underlying object is
 * never public. What a student receives is a **short-lived signed URL**, minted
 * only after four checks pass — authenticated, account active, device
 * authorised, entitlement held — and bound to their user, session and device by
 * `StorageService.signMediaUrl`. The same mechanism that already protects
 * course attachments, reused rather than reinvented, so there is one place
 * where protected media is signed and one place to audit.
 *
 * The response also carries a **watermark payload**: the student's name, a
 * short form of their id, and a per-request session tag. The client renders it
 * over the document. The tag is derived from the user, the part and fresh
 * random bytes, so two people looking at the same page carry different marks
 * and a leaked screenshot points somewhere.
 *
 * What this does NOT do, stated plainly rather than implied away: it does not
 * make a screenshot impossible, and it cannot stop a camera pointed at the
 * screen. Nothing can. It makes casual redistribution inconvenient and
 * deliberate redistribution traceable. Capture blocking at the OS level and
 * server-side rendering of a per-student watermarked file are a later phase;
 * neither changes the honest limit above.
 *
 * ── Preview is the one way in without an entitlement ────────────────────────
 *
 * A part flagged `isPreview` is a deliberately free sample and is readable by
 * any authenticated student. Everything else requires a row in
 * `library_entitlements`. There is no third path.
 */
@Injectable()
export class LibraryDocumentsService {
  private readonly logger = new Logger(LibraryDocumentsService.name);
  private readonly cfg: PlaybackConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly devices: DevicesService,
    private readonly storage: StorageService,
    private readonly security: SecurityEventService,
    config: ConfigService,
  ) {
    // Reuses the playback ticket TTL: a document ticket and a video ticket have
    // the same job and the same threat model, and two knobs that must be kept
    // in step are one knob too many.
    this.cfg = config.getOrThrow<PlaybackConfig>('playback');
  }

  async issueTicket(params: {
    libraryPartId: string;
    user: AuthenticatedUser;
    integritySuspect: boolean;
    ip?: string | null;
  }): Promise<LibraryDocumentTicket> {
    const part = await this.prisma.libraryPart.findFirst({
      where: { id: params.libraryPartId, ...notDeleted },
      include: {
        material: {
          select: { title: true, status: true, isActive: true, deletedAt: true },
        },
      },
    });

    if (!part) throw AppException.notFound('Library part', params.libraryPartId);

    // Withdrawn material stops being readable even for someone who bought it,
    // in the same way an archived course stops playing. The entitlement is not
    // revoked and the purchase record stands; only delivery is withheld.
    if (
      part.deletedAt ||
      part.status === ContentStatus.ARCHIVED ||
      part.material.deletedAt ||
      part.material.status === ContentStatus.ARCHIVED
    ) {
      throw new AppException(ErrorCode.COURSE_ARCHIVED, {
        message: 'This material has been withdrawn',
      });
    }

    // Staff read anything; that is what makes review possible. Students go
    // through the entitlement.
    const isStaff = params.user.role !== UserRole.STUDENT;

    if (!isStaff && !part.isPreview) {
      const entitlement = await this.prisma.libraryEntitlement.findUnique({
        where: {
          userId_libraryPartId: {
            userId: params.user.id,
            libraryPartId: part.id,
          },
        },
        select: { id: true, revokedAt: true },
      });

      if (!entitlement || entitlement.revokedAt !== null) {
        // Recorded, because repeated attempts on documents someone does not own
        // is exactly the shape of an account being probed or shared.
        await this.security
          .record({
            userId: params.user.id,
            // The enum's existing value for "asked for something they may not
            // have"; no new event type is needed for documents.
            type: SecurityEventType.UNAUTHORIZED_ACCESS,
            severity: SecuritySeverity.LOW,
            deviceKey: params.user.deviceKey,
            ipAddress: params.ip ?? null,
            message: 'library document requested without an entitlement',
            metadata: { libraryPartId: part.id },
          })
          .catch(() => undefined);

        throw new AppException(ErrorCode.PAYMENT_REQUIRED, {
          message: 'You have not purchased this document',
          details: { libraryPartId: part.id },
        });
      }
    }

    // Device binding, exactly as for protected course attachments. A preview is
    // meant to be openable, so it is not device-bound.
    if (!part.isPreview && !isStaff) {
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

    const url = await this.storage.signMediaUrl({
      objectKey: part.objectKey,
      expiresInSeconds: ttl,
      userId: params.user.id,
      sessionId: params.user.sessionId,
      deviceId: params.user.deviceId,
      ticketId: `lib_${part.id}`,
    });

    const profile = await this.prisma.user.findUniqueOrThrow({
      where: { id: params.user.id },
      select: { fullName: true },
    });

    return {
      libraryPartId: part.id,
      title: part.title,
      url,
      mimeType: part.mimeType,
      pageCount: part.pageCount,
      expiresAt: expiresAt.toISOString(),
      watermark: {
        primary: profile.fullName,
        secondary: `ID: ${params.user.id.slice(-8).toUpperCase()}`,
        // Fresh per request, so two readings by the same student carry
        // different tags and a leak can be placed in time.
        sessionTag: createHash('sha256')
          .update(`${params.user.id}:${part.id}:${randomBytes(8).toString('hex')}`)
          .digest('base64url')
          .slice(0, 16)
          .toUpperCase(),
        opacity: 0.25,
        moveIntervalSeconds: 30,
      },
    };
  }
}
