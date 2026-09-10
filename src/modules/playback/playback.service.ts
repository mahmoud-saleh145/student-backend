import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ContentStatus,
  PlaybackTicketStatus,
  SecurityEventType,
  SecuritySeverity,
  UserRole,
  VideoStatus,
  WatchEventType,
} from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthenticatedUser } from '../../common/types/request-context';
import type { PlaybackConfig, VideoConfig } from '../../config/configuration';
import { PrismaService, notDeleted } from '../../database/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { CourseAccessService } from '../courses/course-access.service';
import { DevicesService } from '../devices/devices.service';
import { SecurityEventService } from '../security/security-event.service';
import { StorageService } from '../storage/storage.service';
import { TokenService } from '../auth/token.service';

import { ManifestService } from './manifest.service';

/** Matches the mobile app's `PlaybackTicket` type exactly. */
export interface PlaybackTicketResponse {
  ticketId: string;
  manifestUrl: string;
  playbackHeaders: Record<string, string>;
  drm: {
    scheme: 'widevine' | 'fairplay' | 'none';
    licenseUrl: string | null;
    certificateUrl: string | null;
    licenseHeaders: Record<string, string>;
  };
  watermark: {
    primary: string;
    secondary: string;
    sessionTag: string;
    opacity: number;
    moveIntervalSeconds: number;
  };
  captions: { language: string; label: string; url: string; isDefault: boolean }[];
  expiresAt: string;
  ttlSeconds: number;
  resumePositionSeconds: number;
  streamSessionId: string;
  heartbeatIntervalSeconds: number;
}

export interface HeartbeatResponse {
  ok: boolean;
  ticket?: PlaybackTicketResponse;
  terminate?: { reason: string } | null;
}

/**
 * Protected playback authorization.
 *
 * This service is the single gate between a student and a playable URL. There
 * is no other code path in the system that produces one.
 *
 * The chain (spec §34/§36/§67), executed in this order because each step is
 * cheaper than the next:
 *
 *   1. authenticated            — the guard already ran
 *   2. account active           — the guard already ran
 *   3. issuance rate limit      — Redis counter, cheapest possible rejection
 *   4. video exists and READY   — one indexed read
 *   5. course/lesson access     — the access engine
 *   6. device authorized        — device binding
 *   7. concurrency slot free    — Redis
 *   8. mint ticket + signed URL — only now is a URL created
 *
 * Every rejection is recorded as a security event, because the *pattern* of
 * rejections is the signal worth having: one DEVICE_MISMATCH is a student with
 * a new phone, forty in an hour is a shared account.
 */
@Injectable()
export class PlaybackService {
  private readonly logger = new Logger(PlaybackService.name);
  private readonly cfg: PlaybackConfig;
  private readonly videoCfg: VideoConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly access: CourseAccessService,
    private readonly devices: DevicesService,
    private readonly storage: StorageService,
    private readonly manifest: ManifestService,
    private readonly tokens: TokenService,
    private readonly security: SecurityEventService,
    config: ConfigService,
  ) {
    this.cfg = config.getOrThrow<PlaybackConfig>('playback');
    this.videoCfg = config.getOrThrow<VideoConfig>('video');
  }

  // ---------------------------------------------------------------------------
  // Ticket issuance
  // ---------------------------------------------------------------------------

  async issueTicket(params: {
    user: AuthenticatedUser;
    videoId: string;
    maxHeight?: number | null;
    ip?: string | null;
    userAgent?: string | null;
    integritySuspect: boolean;
  }): Promise<PlaybackTicketResponse> {
    const { user, videoId } = params;

    // --- 3. issuance rate limit ---------------------------------------------
    await this.enforceIssuanceRate(user.id, params.ip);

    // --- 4. video ------------------------------------------------------------
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, ...notDeleted },
      include: {
        renditions: { orderBy: { height: 'asc' } },
        captions: true,
        lesson: {
          select: {
            id: true,
            title: true,
            status: true,
            isPreview: true,
            courseId: true,
            sectionId: true,
            section: { select: { unlocksAt: true, status: true } },
          },
        },
      },
    });

    if (!video) {
      await this.denied(user, videoId, null, 'video not found');
      throw new AppException(ErrorCode.VIDEO_UNAVAILABLE);
    }

    if (video.status === VideoStatus.PROCESSING || video.status === VideoStatus.QUEUED || video.status === VideoStatus.UPLOADING) {
      throw new AppException(ErrorCode.VIDEO_NOT_READY, {
        details: { status: video.status },
      });
    }

    if (video.status !== VideoStatus.READY) {
      await this.denied(user, videoId, video.courseId, `video status ${video.status}`);
      throw new AppException(ErrorCode.VIDEO_UNAVAILABLE, {
        details: { status: video.status },
      });
    }

    if (video.lesson.status !== ContentStatus.PUBLISHED && user.role === UserRole.STUDENT) {
      await this.denied(user, videoId, video.courseId, 'lesson not published');
      throw new AppException(ErrorCode.VIDEO_UNAVAILABLE);
    }

    // --- 5. course + lesson access ------------------------------------------
    await this.access.assertContentAccess({
      userId: user.id,
      role: user.role,
      courseId: video.courseId,
      allowPreview: true,
      isPreviewContent: video.lesson.isPreview,
    });

    // Section-scoped entitlement, enforced at the point a playable URL would
    // be minted. This is the gate that matters: the lesson read above can be
    // skipped by a client, the ticket cannot.
    if (user.role === UserRole.STUDENT && !video.lesson.isPreview) {
      try {
        await this.access.assertSectionAccessible({
          userId: user.id,
          courseId: video.courseId,
          sectionId: video.lesson.sectionId,
        });
      } catch (error) {
        await this.denied(user, videoId, video.courseId, 'section not covered by access');
        throw error;
      }
    }

    // Drip release is enforced here too, not only in the lesson read.
    const unlocksAt = video.lesson.section.unlocksAt;
    if (
      unlocksAt &&
      unlocksAt.getTime() > Date.now() &&
      !video.lesson.isPreview &&
      user.role === UserRole.STUDENT
    ) {
      await this.denied(user, videoId, video.courseId, 'section not yet released');
      throw new AppException(ErrorCode.PLAYBACK_DENIED, {
        message: 'This section has not been released yet',
      });
    }

    // --- 6. device -----------------------------------------------------------
    const { deviceId } = await this.devices.assertAuthorizedForProtectedContent({
      userId: user.id,
      role: user.role,
      deviceKey: user.deviceKey,
      integritySuspect: params.integritySuspect,
      ip: params.ip,
      userAgent: params.userAgent,
    });

    // --- 7. concurrency ------------------------------------------------------
    await this.acquireStreamSlot(user, video.courseId, videoId, params.ip);

    // --- 8. mint -------------------------------------------------------------
    return this.mintTicket({
      user,
      video,
      deviceId,
      maxHeight: params.maxHeight ?? null,
      ip: params.ip,
      userAgent: params.userAgent,
      rotatedFromId: null,
    });
  }

  private async mintTicket(params: {
    user: AuthenticatedUser;
    video: {
      id: string;
      courseId: string;
      hlsPrefix: string | null;
      masterPlaylistKey: string | null;
      durationSeconds: number;
      renditions: { height: number }[];
      captions: { language: string; label: string; objectKey: string; isDefault: boolean }[];
      lesson: { id: string; title: string };
    };
    deviceId: string | null;
    maxHeight: number | null;
    ip?: string | null;
    userAgent?: string | null;
    rotatedFromId: string | null;
  }): Promise<PlaybackTicketResponse> {
    const { user, video } = params;

    const masterKey =
      video.masterPlaylistKey ?? StorageService.keys.hlsMaster(video.id);

    const ttl = this.cfg.ticketTtl;
    const expiresAt = new Date(Date.now() + ttl * 1000);

    // Forensic tag: unpredictable, tied to this grant, and safe to display.
    const watermarkTag = this.buildWatermarkTag(user.id, video.id);

    const [profile, progress] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { fullName: true },
      }),
      this.prisma.watchProgress.findUnique({
        where: { userId_lessonId: { userId: user.id, lessonId: video.lesson.id } },
        select: { positionSeconds: true, completed: true },
      }),
    ]);

    const ticket = await this.prisma.playbackTicket.create({
      data: {
        userId: user.id,
        videoId: video.id,
        lessonId: video.lesson.id,
        courseId: video.courseId,
        sessionId: user.sessionId,
        deviceId: params.deviceId,
        watermarkTag,
        maxHeight: params.maxHeight,
        expiresAt,
        startPositionSeconds: progress?.completed ? 0 : (progress?.positionSeconds ?? 0),
        lastPositionSeconds: progress?.completed ? 0 : (progress?.positionSeconds ?? 0),
        ipAddress: params.ip ?? null,
        userAgent: params.userAgent?.slice(0, 500) ?? null,
        rotatedFromId: params.rotatedFromId,
      },
    });

    // The manifest is served by this API, not from storage, so every segment
    // URI inside it can be signed for THIS viewer and the AES key can be tied
    // to this ticket. See ManifestService for the full rationale.
    const manifestUrl = this.manifest.buildMasterUrl(ticket.id, expiresAt);
    void masterKey; // packaged master playlist; retained for diagnostics

    const captions = await Promise.all(
      video.captions.map(async (c) => ({
        language: c.language,
        label: c.label,
        url: await this.storage.signMediaUrl({
          objectKey: c.objectKey,
          expiresInSeconds: ttl,
          userId: user.id,
          sessionId: user.sessionId,
          deviceId: params.deviceId,
          ticketId: ticket.id,
        }),
        isDefault: c.isDefault,
      })),
    );

    await this.prisma.watchEvent
      .create({
        data: {
          userId: user.id,
          lessonId: video.lesson.id,
          courseId: video.courseId,
          videoId: video.id,
          ticketId: ticket.id,
          type: WatchEventType.STARTED,
          positionSeconds: ticket.startPositionSeconds,
        },
      })
      .catch(() => undefined);

    return {
      ticketId: ticket.id,
      manifestUrl,
      playbackHeaders: {},
      drm: this.drmBlock(),
      watermark: {
        // Composed server-side. A patched client cannot substitute another
        // student's name, so the mark keeps its forensic value.
        primary: profile.fullName,
        secondary: `ID: ${user.id.slice(-8).toUpperCase()}`,
        sessionTag: watermarkTag,
        opacity: 0.32,
        moveIntervalSeconds: 20,
      },
      captions,
      expiresAt: expiresAt.toISOString(),
      ttlSeconds: ttl,
      resumePositionSeconds: ticket.startPositionSeconds,
      streamSessionId: ticket.id,
      heartbeatIntervalSeconds: this.cfg.heartbeatInterval,
    };
  }

  private drmBlock(): PlaybackTicketResponse['drm'] {
    if (!this.videoCfg.drm.enabled) {
      return { scheme: 'none', licenseUrl: null, certificateUrl: null, licenseHeaders: {} };
    }

    // The client sends its platform; Widevine is returned by default and the
    // FairPlay variant is selected by the caller when the request is from iOS.
    return {
      scheme: 'widevine',
      licenseUrl: this.videoCfg.drm.widevineLicenseUrl,
      certificateUrl: this.videoCfg.drm.fairplayCertUrl,
      licenseHeaders: this.videoCfg.drm.providerToken
        ? { Authorization: `Bearer ${this.videoCfg.drm.providerToken}` }
        : {},
    };
  }

  /**
   * Forensic session tag.
   *
   * A truncated HMAC over user + video + a random nonce. Unpredictable (so it
   * cannot be forged to implicate someone else) yet reversible by us via the
   * stored ticket row, which is what makes a leaked recording traceable.
   */
  private buildWatermarkTag(userId: string, videoId: string): string {
    return createHash('sha256')
      .update(`${userId}:${videoId}:${randomBytes(12).toString('hex')}`)
      .digest('base64url')
      .slice(0, 16)
      .toUpperCase();
  }

  // ---------------------------------------------------------------------------
  // Rate limiting and concurrency
  // ---------------------------------------------------------------------------

  /**
   * Caps ticket issuance per account per hour.
   *
   * This is the single most effective control against bulk scraping: an
   * attacker with valid credentials still cannot walk a 200-lesson course in
   * one session. The limit is generous enough that a student rewatching and
   * seeking never trips it.
   */
  private async enforceIssuanceRate(userId: string, ip?: string | null): Promise<void> {
    const count = await this.redis.incrementWindow(`pb:issue:${userId}`, 3600);

    if (count > this.cfg.ticketsPerHour) {
      await this.security.record({
        type: SecurityEventType.TICKET_ABUSE,
        severity: SecuritySeverity.HIGH,
        userId,
        ipAddress: ip,
        message: `Playback ticket rate exceeded: ${count} in the last hour (limit ${this.cfg.ticketsPerHour})`,
      });

      throw new AppException(ErrorCode.RATE_LIMITED, {
        message: 'Too many playback requests. Please wait before starting another video.',
      });
    }
  }

  /**
   * Concurrency slot.
   *
   * Redis holds the live slot with a TTL slightly longer than the heartbeat
   * interval, so a crashed client's slot frees itself. Postgres holds the
   * durable record. If Redis is unavailable the check degrades open — a
   * streaming-limit bypass is a far smaller problem than an outage that stops
   * every student watching.
   */
  private async acquireStreamSlot(
    user: AuthenticatedUser,
    courseId: string,
    videoId: string,
    ip?: string | null,
  ): Promise<void> {
    const key = `pb:slots:${user.id}`;
    const now = Date.now();
    const graceMs = this.cfg.heartbeatGrace * 1000;

    try {
      // Drop slots whose heartbeat lapsed, then count what's left.
      await this.redis.client.zremrangebyscore(
        this.redis.key(key),
        0,
        now - graceMs,
      );

      const active = await this.redis.client.zcard(this.redis.key(key));

      if (active >= this.cfg.maxConcurrentStreams) {
        // The same session re-requesting (a reload, a rotation) is not a
        // second stream — let it through and refresh its slot.
        const ownScore = await this.redis.client.zscore(
          this.redis.key(key),
          user.sessionId,
        );

        if (ownScore === null) {
          await this.security.record({
            type: SecurityEventType.CONCURRENT_STREAM_BLOCKED,
            userId: user.id,
            courseId,
            videoId,
            sessionId: user.sessionId,
            deviceKey: user.deviceKey,
            ipAddress: ip,
            message: `Concurrent stream limit reached (${active}/${this.cfg.maxConcurrentStreams})`,
          });

          throw new AppException(ErrorCode.CONCURRENT_STREAM_LIMIT);
        }
      }

      await this.redis.client.zadd(this.redis.key(key), now, user.sessionId);
      await this.redis.client.expire(
        this.redis.key(key),
        this.cfg.heartbeatGrace * 4,
      );
    } catch (e) {
      if (e instanceof AppException) throw e;
      this.logger.warn(
        `concurrency check degraded (Redis unavailable): ${(e as Error).message}`,
      );
    }
  }

  private async touchStreamSlot(userId: string, sessionId: string): Promise<void> {
    try {
      await this.redis.client.zadd(this.redis.key(`pb:slots:${userId}`), Date.now(), sessionId);
    } catch {
      /* degraded */
    }
  }

  private async releaseStreamSlot(userId: string, sessionId: string): Promise<void> {
    try {
      await this.redis.client.zrem(this.redis.key(`pb:slots:${userId}`), sessionId);
    } catch {
      /* degraded */
    }
  }

  // ---------------------------------------------------------------------------
  // Heartbeat
  // ---------------------------------------------------------------------------

  /**
   * Keeps a playback session alive, reports position, and lets the server
   * terminate mid-lesson.
   *
   * Re-checking access on every heartbeat is what makes revocation real: an
   * admin who revokes an enrollment stops playback within one heartbeat
   * interval, not when the ticket happens to expire.
   */
  async heartbeat(params: {
    user: AuthenticatedUser;
    ticketId: string;
    positionSeconds: number;
    watchedDeltaSeconds: number;
    protection?: {
      secureSurface?: boolean;
      recording?: boolean;
      externalDisplay?: boolean;
    };
    ip?: string | null;
  }): Promise<HeartbeatResponse> {
    const ticket = await this.prisma.playbackTicket.findFirst({
      where: { id: params.ticketId, userId: params.user.id },
      include: {
        video: {
          include: {
            renditions: true,
            captions: true,
            lesson: { select: { id: true, title: true } },
          },
        },
      },
    });

    if (!ticket) throw new AppException(ErrorCode.PLAYBACK_TICKET_EXPIRED);

    if (ticket.status === PlaybackTicketStatus.REVOKED) {
      await this.releaseStreamSlot(params.user.id, params.user.sessionId);
      return {
        ok: false,
        terminate: { reason: ticket.revokedReason ?? 'Playback authorization revoked' },
      };
    }

    if (ticket.status === PlaybackTicketStatus.RELEASED) {
      return { ok: false, terminate: { reason: 'Playback session already ended' } };
    }

    // --- client-reported capture state --------------------------------------
    if (params.protection?.recording || params.protection?.externalDisplay) {
      await this.security.record({
        type: params.protection.recording
          ? SecurityEventType.RECORDING_STARTED
          : SecurityEventType.EXTERNAL_DISPLAY,
        severity: SecuritySeverity.HIGH,
        userId: params.user.id,
        courseId: ticket.courseId,
        lessonId: ticket.lessonId,
        videoId: ticket.videoId,
        ticketId: ticket.id,
        deviceKey: params.user.deviceKey,
        ipAddress: params.ip,
        message: 'Heartbeat reported an active capture surface',
      });

      await this.revokeTicket(ticket.id, 'Capture surface active during playback');
      await this.releaseStreamSlot(params.user.id, params.user.sessionId);

      return { ok: false, terminate: { reason: 'CAPTURE_DETECTED' } };
    }

    if (params.protection?.secureSurface === false) {
      // The client is telling us it cannot protect the frame. Refusing here is
      // the whole point of the secure-surface contract.
      await this.security.record({
        type: SecurityEventType.INTEGRITY_FAILED,
        severity: SecuritySeverity.HIGH,
        userId: params.user.id,
        ticketId: ticket.id,
        message: 'Client reported no secure surface during playback',
      });
      await this.revokeTicket(ticket.id, 'Secure surface unavailable');
      return { ok: false, terminate: { reason: 'DEVICE_INTEGRITY_FAILED' } };
    }

    // --- live re-authorization ----------------------------------------------
    const decision = await this.access.resolve({
      userId: params.user.id,
      role: params.user.role,
      courseId: ticket.courseId,
    });

    if (!decision.canAccessContent) {
      await this.revokeTicket(ticket.id, `Access lost mid-playback: ${decision.state}`);
      await this.releaseStreamSlot(params.user.id, params.user.sessionId);
      return { ok: false, terminate: { reason: decision.denialCode ?? 'PLAYBACK_DENIED' } };
    }

    // --- record position ------------------------------------------------------
    const position = Math.max(0, Math.floor(params.positionSeconds));
    const delta = Math.max(0, Math.min(Math.floor(params.watchedDeltaSeconds), 600));

    await this.prisma.playbackTicket.update({
      where: { id: ticket.id },
      data: {
        lastHeartbeatAt: new Date(),
        lastPositionSeconds: position,
        watchedSeconds: { increment: delta },
      },
    });

    await this.touchStreamSlot(params.user.id, params.user.sessionId);

    if (delta > 0) {
      await this.prisma.watchEvent
        .create({
          data: {
            userId: params.user.id,
            lessonId: ticket.lessonId,
            courseId: ticket.courseId,
            videoId: ticket.videoId,
            ticketId: ticket.id,
            type: WatchEventType.PROGRESS,
            positionSeconds: position,
            deltaSeconds: delta,
          },
        })
        .catch(() => undefined);
    }

    // --- rotation -------------------------------------------------------------
    // Rotate before the manifest URL lapses so a long lesson never stalls.
    const remainingMs = ticket.expiresAt.getTime() - Date.now();
    const shouldRotate = remainingMs < this.cfg.heartbeatInterval * 2 * 1000;

    if (shouldRotate) {
      await this.prisma.playbackTicket.update({
        where: { id: ticket.id },
        data: { status: PlaybackTicketStatus.RELEASED, releasedAt: new Date() },
      });

      const rotated = await this.mintTicket({
        user: params.user,
        video: ticket.video,
        deviceId: ticket.deviceId,
        maxHeight: ticket.maxHeight,
        ip: params.ip,
        rotatedFromId: ticket.id,
      });

      return { ok: true, ticket: rotated };
    }

    return { ok: true, terminate: null };
  }

  // ---------------------------------------------------------------------------
  // Release / revoke
  // ---------------------------------------------------------------------------

  async release(user: AuthenticatedUser, ticketId: string): Promise<{ ok: true }> {
    const ticket = await this.prisma.playbackTicket.findFirst({
      where: { id: ticketId, userId: user.id },
      select: { id: true, status: true, lastPositionSeconds: true, lessonId: true, courseId: true, videoId: true },
    });

    if (!ticket) return { ok: true };

    if (ticket.status === PlaybackTicketStatus.ACTIVE) {
      await this.prisma.playbackTicket.update({
        where: { id: ticketId },
        data: { status: PlaybackTicketStatus.RELEASED, releasedAt: new Date() },
      });
    }

    await this.releaseStreamSlot(user.id, user.sessionId);

    await this.prisma.watchEvent
      .create({
        data: {
          userId: user.id,
          lessonId: ticket.lessonId,
          courseId: ticket.courseId,
          videoId: ticket.videoId,
          ticketId: ticket.id,
          type: WatchEventType.ENDED,
          positionSeconds: ticket.lastPositionSeconds,
        },
      })
      .catch(() => undefined);

    return { ok: true };
  }

  /**
   * Answers the media edge Worker's "is this grant still live?" probe.
   *
   * Deliberately minimal. It returns one boolean and never an error, because
   * the caller is an unauthenticated edge Worker: a 404 for an unknown ticket
   * would turn this into an existence oracle, and a thrown error would make
   * the Worker's fail-open path indistinguishable from a genuine revocation.
   *
   * `uid` must match the ticket's owner. That is what stops one student's
   * ticket id, lifted from a URL, being used to probe another's.
   */
  async ticketLiveness(ticketId: string, uid: string | null): Promise<{ live: boolean }> {
    if (!ticketId || !uid) return { live: false };

    const ticket = await this.prisma.playbackTicket.findFirst({
      where: { id: ticketId, userId: uid },
      select: {
        status: true,
        expiresAt: true,
        lastHeartbeatAt: true,
        session: { select: { status: true } },
        device: { select: { status: true } },
      },
    });

    if (!ticket) return { live: false };
    if (ticket.status !== PlaybackTicketStatus.ACTIVE) return { live: false };
    if (ticket.expiresAt.getTime() <= Date.now()) return { live: false };

    // A revoked session or device must stop segment delivery even though the
    // ticket row itself has not been touched — this is the case the sweep job
    // has not caught up with yet.
    if (ticket.session && ticket.session.status !== 'ACTIVE') return { live: false };
    if (ticket.device && ticket.device.status !== 'ACTIVE') return { live: false };

    // A player that stopped heart-beating long ago is a closed app or a
    // scraper replaying URLs; either way the grant is stale.
    const staleAfter = (this.cfg.heartbeatGrace + this.cfg.heartbeatInterval) * 1000;
    if (Date.now() - ticket.lastHeartbeatAt.getTime() > staleAfter) {
      return { live: false };
    }

    return { live: true };
  }

  async revokeTicket(ticketId: string, reason: string): Promise<void> {
    await this.prisma.playbackTicket
      .update({
        where: { id: ticketId },
        data: {
          status: PlaybackTicketStatus.REVOKED,
          revokedAt: new Date(),
          revokedReason: reason,
        },
      })
      .catch(() => undefined);
  }

  /** Kills every live grant for a student. Used on suspension and unbind. */
  async revokeAllForUser(userId: string, reason: string): Promise<number> {
    const { count } = await this.prisma.playbackTicket.updateMany({
      where: { userId, status: PlaybackTicketStatus.ACTIVE },
      data: { status: PlaybackTicketStatus.REVOKED, revokedAt: new Date(), revokedReason: reason },
    });

    await this.redis.del(`pb:slots:${userId}`);
    return count;
  }

  // ---------------------------------------------------------------------------
  // Client security events
  // ---------------------------------------------------------------------------

  /**
   * Receives capture/integrity reports from the app.
   *
   * The client is untrusted, so these are treated as *telemetry*, not proof.
   * But they are the only visibility we get into what happens on the device,
   * and storing them server-side means a patched client cannot erase its own
   * trail. Repeated capture attempts within one playback session end that
   * session — a bounded, reversible response, never an account ban.
   */
  async recordSecurityEvent(params: {
    user: AuthenticatedUser;
    threat: string;
    videoId?: string;
    courseId?: string;
    lessonId?: string;
    ticketId?: string;
    meta?: Record<string, unknown>;
    occurredAt?: string;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<{ ok: true; action: 'logged' | 'playback-stopped' }> {
    const typeMap: Record<string, SecurityEventType> = {
      SCREENSHOT: SecurityEventType.SCREENSHOT,
      RECORDING_STARTED: SecurityEventType.RECORDING_STARTED,
      RECORDING_STOPPED: SecurityEventType.RECORDING_STOPPED,
      EXTERNAL_DISPLAY: SecurityEventType.EXTERNAL_DISPLAY,
      INTEGRITY: SecurityEventType.INTEGRITY_FAILED,
    };

    const type = typeMap[params.threat] ?? SecurityEventType.UNAUTHORIZED_ACCESS;

    await this.security.record({
      type,
      userId: params.user.id,
      courseId: params.courseId,
      lessonId: params.lessonId,
      videoId: params.videoId,
      ticketId: params.ticketId,
      deviceKey: params.user.deviceKey,
      sessionId: params.user.sessionId,
      ipAddress: params.ip,
      userAgent: params.userAgent,
      message: `Client reported ${params.threat}`,
      metadata: params.meta ?? null,
    });

    const isCapture =
      type === SecurityEventType.SCREENSHOT ||
      type === SecurityEventType.RECORDING_STARTED ||
      type === SecurityEventType.EXTERNAL_DISPLAY;

    if (!isCapture) return { ok: true, action: 'logged' };

    // Find the live grant this report belongs to.
    const ticket = params.ticketId
      ? await this.prisma.playbackTicket.findFirst({
          where: { id: params.ticketId, userId: params.user.id },
        })
      : await this.prisma.playbackTicket.findFirst({
          where: {
            userId: params.user.id,
            status: PlaybackTicketStatus.ACTIVE,
            ...(params.videoId ? { videoId: params.videoId } : {}),
          },
          orderBy: { issuedAt: 'desc' },
        });

    if (!ticket) return { ok: true, action: 'logged' };

    const attempts = ticket.captureAttempts + 1;

    await this.prisma.playbackTicket.update({
      where: { id: ticket.id },
      data: { captureAttempts: attempts },
    });

    if (attempts >= this.cfg.captureStrikes) {
      await this.revokeTicket(
        ticket.id,
        `Capture attempts reached ${attempts} in one playback session`,
      );
      await this.releaseStreamSlot(params.user.id, params.user.sessionId);

      await this.security.record({
        type: SecurityEventType.TICKET_ABUSE,
        severity: SecuritySeverity.HIGH,
        userId: params.user.id,
        ticketId: ticket.id,
        courseId: ticket.courseId,
        message: `Playback stopped after ${attempts} capture attempts. Account not restricted.`,
      });

      return { ok: true, action: 'playback-stopped' };
    }

    return { ok: true, action: 'logged' };
  }

  // ---------------------------------------------------------------------------
  // Maintenance
  // ---------------------------------------------------------------------------

  /** Marks lapsed tickets EXPIRED and reclaims their slots. */
  async expireLapsedTickets(): Promise<number> {
    const now = new Date();

    const { count } = await this.prisma.playbackTicket.updateMany({
      where: { status: PlaybackTicketStatus.ACTIVE, expiresAt: { lte: now } },
      data: { status: PlaybackTicketStatus.EXPIRED },
    });

    return count;
  }

  /**
   * Reclaims slots whose client stopped heart-beating (app killed, phone died).
   * Without this a crashed session would hold the student's only slot until
   * the ticket expired.
   */
  async reclaimStaleSlots(): Promise<number> {
    const cutoff = new Date(Date.now() - this.cfg.heartbeatGrace * 1000);

    const stale = await this.prisma.playbackTicket.findMany({
      where: { status: PlaybackTicketStatus.ACTIVE, lastHeartbeatAt: { lt: cutoff } },
      select: { id: true, userId: true, sessionId: true },
      take: 500,
    });

    for (const ticket of stale) {
      await this.prisma.playbackTicket.update({
        where: { id: ticket.id },
        data: {
          status: PlaybackTicketStatus.EXPIRED,
          revokedReason: 'Heartbeat stopped',
        },
      });
      if (ticket.sessionId) {
        await this.releaseStreamSlot(ticket.userId, ticket.sessionId);
      }
    }

    return stale.length;
  }

  private async denied(
    user: AuthenticatedUser,
    videoId: string,
    courseId: string | null,
    reason: string,
  ): Promise<void> {
    await this.security.record({
      type: SecurityEventType.TICKET_DENIED,
      userId: user.id,
      videoId,
      courseId,
      deviceKey: user.deviceKey,
      sessionId: user.sessionId,
      message: reason,
    });
  }
}
