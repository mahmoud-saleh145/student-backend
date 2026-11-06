import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ContentStatus, SecurityEventType, SecuritySeverity } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthenticatedUser } from '../../common/types/request-context';
import type { PlaybackConfig } from '../../config/configuration';
import { PrismaService, notDeleted } from '../../database/prisma.service';
import { DevicesService } from '../devices/devices.service';
import { SecurityEventService } from '../security/security-event.service';
import { StorageService } from '../storage/storage.service';

import {
  LibraryEligibilityService,
  MATERIAL_AUDIENCE_SELECT,
  isPublished,
  toAudience,
} from './library-eligibility.service';

/**
 * `tid` prefixes. The ticket type is inside the HMAC (storage.service.ts
 * `computeMediaSignature`), so it cannot be changed without breaking the
 * signature, and the edge treats the two differently:
 *
 *   lib_   OWNED. Issued only for an unrevoked entitlement to that exact part.
 *          Liveness re-checks the entitlement; existing edge behaviour.
 *   libp_  PREVIEW. Issued only for a published preview the student is
 *          academically eligible for, while the storefront is on. The edge
 *          FAILS CLOSED for it (docs/cloudflare-worker.js).
 */
export const LIBRARY_OWNED_TICKET_PREFIX = 'lib_';
export const LIBRARY_PREVIEW_TICKET_PREFIX = 'libp_';

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
 * A part's `objectKey` is never sent as a field and the bucket is never public.
 * A student receives a **short-lived signed URL**, minted only after the checks
 * below pass and bound to their user, session and device by
 * `StorageService.signMediaUrl` — the one place Library URLs are signed. The
 * response also carries a **watermark payload** the client renders over each
 * page. None of this stops a camera pointed at the screen, or a technically
 * capable student taking the original PDF from network traffic, since the
 * watermark is drawn in the browser (accepted for this release, docs/LIBRARY.md).
 * It makes redistribution inconvenient and traceable.
 *
 * ── Exactly two ways in ─────────────────────────────────────────────────────
 *
 *   OWNED    an unrevoked entitlement to this part. Academic scope and the
 *            storefront do not matter — an owner keeps what they bought. The
 *            part and its material must not be withdrawn (deleted/ARCHIVED),
 *            and the device must be authorised. The URL names that device.
 *   PREVIEW  a free sample: storefront on, part and material published, the
 *            student academically eligible.
 *
 * There is no staff path: the route is student-only, and a ticket is never
 * minted without one of the two checks above.
 *
 * ── Refusals do not disclose hidden material ────────────────────────────────
 *
 * A student who could not see the material gets the same 404 as for a part
 * that does not exist. Only a student who can see it (in scope with the
 * storefront on, or owning another part of it) gets 402 "not purchased".
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
    private readonly eligibility: LibraryEligibilityService,
  ) {
    // Reuses the playback ticket TTL: a document ticket and a video ticket have
    // the same job and the same threat model.
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
          select: {
            id: true,
            title: true,
            status: true,
            isActive: true,
            deletedAt: true,
            ...MATERIAL_AUDIENCE_SELECT,
          },
        },
      },
    });

    if (!part) throw AppException.notFound('Library part', params.libraryPartId);

    const entitlement = await this.prisma.libraryEntitlement.findUnique({
      where: {
        userId_libraryPartId: { userId: params.user.id, libraryPartId: part.id },
      },
      select: { id: true, revokedAt: true },
    });

    // ── OWNED ───────────────────────────────────────────────────────────────
    if (entitlement && entitlement.revokedAt === null) {
      // Withdrawn material stops being readable even for someone who bought
      // it. The entitlement is not revoked and the purchase record stands.
      if (
        part.status === ContentStatus.ARCHIVED ||
        part.material.deletedAt ||
        part.material.status === ContentStatus.ARCHIVED
      ) {
        throw new AppException(ErrorCode.COURSE_ARCHIVED, {
          message: 'This material has been withdrawn',
        });
      }

      // Device binding, exactly as for protected course attachments. A part
      // that is also a preview was never device-bound, and still is not.
      //
      // The URL names the device this check authorised, not the session's: a
      // session signed in without a device header has none of its own, and the
      // edge holds a device-bound URL to the device it names.
      let deviceId = params.user.deviceId;
      if (!part.isPreview) {
        const authorized = await this.devices.assertAuthorizedForProtectedContent({
          userId: params.user.id,
          role: params.user.role,
          deviceKey: params.user.deviceKey,
          sessionDeviceId: params.user.deviceId,
          integritySuspect: params.integritySuspect,
          ip: params.ip,
        });
        deviceId = authorized.deviceId;
      }

      return this.mint(part, params.user, LIBRARY_OWNED_TICKET_PREFIX, deviceId);
    }

    const scope = await this.eligibility.scopeFor(params.user.id);
    const audience = toAudience(part.material);
    const inScopeAndOpen =
      this.eligibility.storefrontEnabled &&
      isPublished(part.material) &&
      this.eligibility.isVisible(scope, audience);

    // ── PREVIEW ─────────────────────────────────────────────────────────────
    // Decision B: deliberately independent of ownership. A revoked entitlement
    // never reaches the OWNED branch above, but it does not take away a free
    // preview the student is otherwise eligible for (storefront on, published,
    // in academic scope). The preview ticket it mints is a separate grant,
    // checked on its own terms by libraryPreviewTicketLiveness. Free previews
    // need no approved device.
    if (part.isPreview && inScopeAndOpen && isPublished(part)) {
      return this.mint(part, params.user, LIBRARY_PREVIEW_TICKET_PREFIX, params.user.deviceId);
    }

    // ── Refused ─────────────────────────────────────────────────────────────
    // Recorded, because repeated attempts on documents someone does not own is
    // exactly the shape of an account being probed or shared.
    await this.security
      .record({
        userId: params.user.id,
        type: SecurityEventType.UNAUTHORIZED_ACCESS,
        severity: SecuritySeverity.LOW,
        deviceKey: params.user.deviceKey,
        ipAddress: params.ip ?? null,
        message: 'library document requested without an entitlement',
        metadata: { libraryPartId: part.id },
      })
      .catch(() => undefined);

    if (entitlement && entitlement.revokedAt !== null) {
      // They held it; saying so discloses nothing they did not know.
      throw new AppException(ErrorCode.LIBRARY_ENTITLEMENT_REVOKED, {
        details: { libraryPartId: part.id },
      });
    }

    const canSeeMaterial =
      (inScopeAndOpen && !part.isPreview) ||
      (await this.eligibility.ownsAnyPartOf(params.user.id, part.material.id));

    if (!canSeeMaterial) {
      // Same answer as a part that does not exist.
      throw AppException.notFound('Library part', params.libraryPartId);
    }

    throw new AppException(ErrorCode.PAYMENT_REQUIRED, {
      message: 'You have not purchased this document',
      details: { libraryPartId: part.id },
    });
  }

  private async mint(
    part: {
      id: string;
      title: string;
      objectKey: string;
      mimeType: string | null;
      pageCount: number | null;
    },
    user: AuthenticatedUser,
    prefix: typeof LIBRARY_OWNED_TICKET_PREFIX | typeof LIBRARY_PREVIEW_TICKET_PREFIX,
    deviceId: string | null,
  ): Promise<LibraryDocumentTicket> {
    const ttl = this.cfg.ticketTtl;
    const expiresAt = new Date(Date.now() + ttl * 1000);

    const url = await this.storage.signMediaUrl({
      objectKey: part.objectKey,
      expiresInSeconds: ttl,
      userId: user.id,
      sessionId: user.sessionId,
      deviceId,
      ticketId: `${prefix}${part.id}`,
    });

    const profile = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
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
        secondary: `ID: ${user.id.slice(-8).toUpperCase()}`,
        // Fresh per request, so two readings by the same student carry
        // different tags and a leak can be placed in time.
        sessionTag: createHash('sha256')
          .update(`${user.id}:${part.id}:${randomBytes(8).toString('hex')}`)
          .digest('base64url')
          .slice(0, 16)
          .toUpperCase(),
        opacity: 0.25,
        moveIntervalSeconds: 30,
      },
    };
  }
}
