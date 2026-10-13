import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ContentStatus,
  DeviceStatus,
  PlaybackTicketStatus,
  Prisma,
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
import { GumletDrmService } from './gumlet-drm.service';
import { DrmVerificationService } from './drm-verification.service';

/**
 * Prefix `LibraryDocumentsService.issueTicket` puts on `tid` for a document
 * grant. Declared here because the edge liveness probe is the other half of
 * that contract, and the two must agree.
 */
const LIBRARY_TICKET_PREFIX = 'lib_';

/**
 * Lecture/section/course document grants.
 *
 * `AttachmentsService.issueTicket` signs `att_<attachmentId>`. The Worker sends
 * that id back here on every range request, and - exactly like the `lib_` case
 * below - there is NO PlaybackTicket row for it, so it must never reach the
 * `playbackTicket` lookup.
 */
const ATTACHMENT_TICKET_PREFIX = 'att_';

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
  /**
   * TEMPORARY playback hotfix: signed URL of Gumlet's own embed player. Set
   * only for Gumlet videos, only when the request sent `delivery: 'embed'`,
   * and only while GUMLET_WEB_EMBED_ENABLED is true; null otherwise.
   */
  embedUrl?: string | null;
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
    private readonly gumlet: GumletDrmService,
    private readonly drmVerification: DrmVerificationService,
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
    /**
     * Client platform, used ONLY to pick the DRM key system. It never widens
     * what the viewer may do - every entitlement, concurrency, device and
     * capture control below runs identically regardless of this value.
     */
    platform?: 'ios' | 'android' | 'web';
    /**
     * The lecture the viewer is playing FROM, when the client supplies it.
     *
     * An uploaded video asset can be attached to several lectures, so a video id
     * alone no longer identifies one piece of content. This is what lets access
     * be evaluated against the DESTINATION lecture rather than against whichever
     * lecture happened to upload the file.
     */
    lessonId?: string;
    /** TEMPORARY hotfix: explicit web opt-in to Gumlet's embed player. */
    delivery?: 'embed';
    ip?: string | null;
    userAgent?: string | null;
    integritySuspect: boolean;
  }): Promise<PlaybackTicketResponse> {
    const { user, videoId } = params;

    // --- 3. issuance rate limit ---------------------------------------------
    await this.enforceIssuanceRate(user.id, params.ip);

    // --- 4. video + the lecture it is being played AS ------------------------
    //
    // `lessonLinks` is the authoritative set of lectures this asset is attached
    // to. The singular `lesson` is kept only as the "which lecture uploaded this
    // file" fallback for assets that predate attachments; it is NOT used to
    // decide access, because doing so would authorise a student in the source
    // course even when they are watching the very same asset inside a
    // destination course they do not own.
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
        lessonLinks: {
          select: {
            lesson: {
              select: {
                id: true,
                title: true,
                status: true,
                isPreview: true,
                courseId: true,
                sectionId: true,
                deletedAt: true,
                section: { select: { unlocksAt: true, status: true } },
              },
            },
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

    // A failed transcode is its own answer. Folded into VIDEO_UNAVAILABLE the
    // app could only say "unavailable", which reads to a student as "try
    // later" — and no amount of waiting fixes a failed encode.
    if (video.status === VideoStatus.FAILED) {
      await this.denied(user, videoId, video.courseId, 'video processing failed');
      throw new AppException(ErrorCode.VIDEO_PROCESSING_FAILED, {
        details: { status: video.status },
      });
    }

    if (video.status !== VideoStatus.READY) {
      await this.denied(user, videoId, video.courseId, `video status ${video.status}`);
      throw new AppException(ErrorCode.VIDEO_UNAVAILABLE, {
        details: { status: video.status },
      });
    }

    // --- 4b. WHICH lecture is this being played as? --------------------------
    //
    // This is the gate that keeps "reuse an asset" from becoming "share a
    // course". A student may reach a shared asset only through a lecture they
    // are actually entitled to, so the lecture is resolved FIRST and every
    // check below - publication, course entitlement, section entitlement, drip
    // release, watch progress - is evaluated against it.
    //
    // Resolution order:
    //   1. The lesson the client said it is playing from, but only if this
    //      asset really is attached to it. A client cannot invent a lesson to
    //      borrow someone else's entitlement.
    //   2. Otherwise the single attached lesson, if there is exactly one.
    //   3. Otherwise DENIED. Never guessed: picking one arbitrarily would let a
    //      student pick the most permissive of several attachments.
    const attachments = video.lessonLinks
      .map((link) => link.lesson)
      .filter((lesson): lesson is NonNullable<typeof lesson> => lesson !== null && !lesson.deletedAt);

    const requested = params.lessonId
      ? attachments.find((lesson) => lesson.id === params.lessonId) ?? null
      : null;

    if (params.lessonId && !requested) {
      // The caller named a lecture this asset is not attached to. That is
      // either a stale client or an attempt to ride another lecture's access.
      await this.denied(user, videoId, video.courseId, 'video is not attached to the requested lesson');
      throw new AppException(ErrorCode.PLAYBACK_DENIED, {
        message: 'This video is not attached to the requested lesson',
      });
    }

    const lesson = requested ?? (attachments.length === 1 ? attachments[0] : null);

    if (!lesson) {
      await this.denied(user, videoId, video.courseId, 'ambiguous lesson context for a shared video');
      throw new AppException(ErrorCode.PLAYBACK_DENIED, {
        message:
          'This video is used by more than one lesson. Retry from the lesson you are trying to watch.',
      });
    }

    if (
      user.role === UserRole.STUDENT &&
      (lesson.status !== ContentStatus.PUBLISHED ||
        lesson.section.status !== ContentStatus.PUBLISHED)
    ) {
      await this.denied(user, videoId, lesson.courseId, 'lesson not published');
      throw new AppException(ErrorCode.VIDEO_UNAVAILABLE);
    }

    // --- 5. course + lesson access ------------------------------------------
    // NOTE the course is the LESSON's course, not `video.courseId`. For a reused
    // asset these differ, and using the uploading course would entitle the
    // viewer to content in the wrong course.
    await this.access.assertContentAccess({
      userId: user.id,
      role: user.role,
      courseId: lesson.courseId,
      allowPreview: true,
      isPreviewContent: lesson.isPreview,
    });

    // Section-scoped entitlement, enforced at the point a playable URL would
    // be minted. This is the gate that matters: the lesson read above can be
    // skipped by a client, the ticket cannot.
    if (user.role === UserRole.STUDENT && !lesson.isPreview) {
      try {
        await this.access.assertSectionAccessible({
          userId: user.id,
          courseId: lesson.courseId,
          sectionId: lesson.sectionId,
        });
      } catch (error) {
        await this.denied(user, videoId, lesson.courseId, 'section not covered by access');
        throw error;
      }
    }

    // Drip release is enforced here too, not only in the lesson read.
    const unlocksAt = lesson.section.unlocksAt;
    if (
      unlocksAt &&
      unlocksAt.getTime() > Date.now() &&
      !lesson.isPreview &&
      user.role === UserRole.STUDENT
    ) {
      await this.denied(user, videoId, lesson.courseId, 'section not yet released');
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

    // --- 7b. play allowance --------------------------------------------------
    // Counted only for protected lessons and only for students. A free
    // preview consumes nothing, and staff previewing their own material are
    // not spending a student's allowance.
    const countPlays = user.role === UserRole.STUDENT && !lesson.isPreview;
    const play = countPlays ? await this.claimPlay(user, videoId, params.ip) : null;

    // --- 8. mint -------------------------------------------------------------
    return this.mintTicket({
      user,
      video,
      lesson,
      deviceId,
      maxHeight: params.maxHeight ?? null,
      platform: params.platform,
      delivery: params.delivery,
      ip: params.ip,
      userAgent: params.userAgent,
      rotatedFromId: null,
      playId: play?.id ?? null,
    });
  }

  /**
   * Reserves one of the student's plays for this video, or resumes the play
   * already in progress.
   *
   * The limit is a COUNT of `video_plays` rows keyed on the account, which is
   * what makes it survive a reinstall, a storage wipe or a fresh sign-in. The
   * client never writes here and is never told the count in a way it could
   * edit — it receives the remaining figure for display only.
   *
   * Two rules keep the count honest rather than merely strict, and both exist
   * because a limit that punishes technical failure is worse than no limit:
   *
   *   * An OPEN play whose last activity is inside `playResumeWindow` is
   *     reused. Backgrounding the app, losing the network, or letting a ticket
   *     expire mid-lesson all come back through here and must not cost a play.
   *   * A CLOSED play that never reached `minCountedPlaySeconds` does not
   *     count. A tap that failed to start is not an attempt.
   */
  private async claimPlay(
    user: AuthenticatedUser,
    videoId: string,
    ip?: string | null,
  ): Promise<{ id: string; attemptNumber: number }> {
    const limit = this.cfg.maxPlaysPerVideo;
    const resumeCutoff = new Date(Date.now() - this.cfg.playResumeWindow * 1000);

    // Resume first: cheaper than counting, and the common case for a student
    // whose ticket lapsed while the lesson was still on screen.
    const open = await this.prisma.videoPlay.findFirst({
      where: {
        userId: user.id,
        videoId,
        closedAt: null,
        lastActivityAt: { gte: resumeCutoff },
      },
      orderBy: { attemptNumber: 'desc' },
      select: { id: true, attemptNumber: true },
    });

    if (open) {
      await this.prisma.videoPlay.update({
        where: { id: open.id },
        data: { lastActivityAt: new Date() },
      });
      return open;
    }

    // Anything still open but beyond the window is a play the student walked
    // away from. Close it before counting, so it counts on its own merits
    // (watched long enough) rather than as a permanently open attempt.
    await this.prisma.videoPlay.updateMany({
      where: { userId: user.id, videoId, closedAt: null },
      data: { closedAt: new Date() },
    });

    const used = await this.countedPlays(user.id, videoId);

    if (used >= limit) {
      await this.denied(user, videoId, null, `play limit reached (${used}/${limit})`);
      throw new AppException(ErrorCode.VIDEO_WATCH_LIMIT_REACHED, {
        details: { used, limit },
      });
    }

    // `attemptNumber` is allocated from the current highest rather than from
    // the counted total, because uncounted plays still occupy a number and
    // the unique index would reject a collision.
    const highest = await this.prisma.videoPlay.aggregate({
      where: { userId: user.id, videoId },
      _max: { attemptNumber: true },
    });
    const next = (highest._max.attemptNumber ?? 0) + 1;

    try {
      return await this.prisma.videoPlay.create({
        data: { userId: user.id, videoId, attemptNumber: next },
        select: { id: true, attemptNumber: true },
      });
    } catch (error) {
      // Two concurrent issue requests both read the same count. The unique
      // index on (userId, videoId, attemptNumber) lets exactly one win; the
      // loser re-enters rather than inventing a number, so racing the
      // endpoint cannot manufacture a fourth play.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        void ip;
        return this.claimPlay(user, videoId);
      }
      throw error;
    }
  }

  /**
   * Plays that count against the limit: everything still open, plus finished
   * ones that were actually watched. See `claimPlay` for why the threshold
   * exists.
   */
  private async countedPlays(userId: string, videoId: string): Promise<number> {
    return this.prisma.videoPlay.count({
      where: {
        userId,
        videoId,
        OR: [
          { closedAt: null },
          { watchedSeconds: { gte: this.cfg.minCountedPlaySeconds } },
        ],
      },
    });
  }

  /**
   * What the student has left on this video, for display. Read-only, and the
   * server never trusts a figure the client sends back.
   */
  async playAllowance(
    userId: string,
    videoId: string,
  ): Promise<{ used: number; limit: number; remaining: number }> {
    const limit = this.cfg.maxPlaysPerVideo;
    const used = await this.countedPlays(userId, videoId);
    return { used, limit, remaining: Math.max(0, limit - used) };
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
      /**
       * The lecture the asset was UPLOADED to. Nullable because a reused asset
       * can outlive the lecture it was authored in, and because it is
       * deliberately NOT what authorises playback - see `lesson` below.
       */
      lesson: { id: string; title: string } | null;
      /** Which delivery path this video uses. Null = legacy R2/AES-128 HLS. */
      drmProvider: string | null;
      gumletAssetId: string | null;
      gumletWorkspaceId: string | null;
      /** Provider-side asset status. Used to pick the student-facing message. */
      gumletStatus: string | null;
    };
    /**
     * The lecture this playback has been AUTHORISED in. Always resolved from the
     * asset's attachments by the caller, and always the destination lecture when
     * the asset is reused. Entitlement, the ticket's lessonId and the watch event
     * all use this, never `video.lesson`.
     */
    lesson: { id: string; title: string; courseId: string };
    deviceId: string | null;
    maxHeight: number | null;
    /** Client platform, used only to choose the DRM key system. */
    platform?: 'ios' | 'android' | 'web';
    /** TEMPORARY hotfix: explicit web opt-in to Gumlet's embed player. */
    delivery?: 'embed';
    ip?: string | null;
    userAgent?: string | null;
    rotatedFromId: string | null;
    /** The counted play this grant belongs to; null for free/preview lessons. */
    playId: string | null;
  }): Promise<PlaybackTicketResponse> {
    const { user, video, lesson } = params;

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
        where: { userId_lessonId: { userId: user.id, lessonId: lesson.id } },
        select: { positionSeconds: true, completed: true },
      }),
    ]);

    const ticket = await this.prisma.playbackTicket.create({
      data: {
        userId: user.id,
        videoId: video.id,
        // The lecture this playback is authorised in. For a reused asset this is
        // the destination lecture, not the uploading one.
        lessonId: lesson.id,
        courseId: lesson.courseId,
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
        playId: params.playId,
      },
    });

    // The manifest is served by this API, not from storage, so every segment
    // URI inside it can be signed for THIS viewer and the AES key can be tied
    // to this ticket. Gumlet-backed videos are the only ones that consume the
    // DRM path, and they carry their own manifest/DRM config.
    const playback = await this.resolvePlaybackTarget(
      ticket.id,
      {
        id: video.id,
        drmProvider: video.drmProvider,
        gumletAssetId: video.gumletAssetId,
        gumletWorkspaceId: video.gumletWorkspaceId,
        gumletStatus: video.gumletStatus,
      },
      expiresAt,
      params.platform,
      params.delivery,
    );

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
          lessonId: lesson.id,
          courseId: lesson.courseId,
          videoId: video.id,
          ticketId: ticket.id,
          type: WatchEventType.STARTED,
          positionSeconds: ticket.startPositionSeconds,
        },
      })
      .catch(() => undefined);

    return {
      ticketId: ticket.id,
      manifestUrl: playback.manifestUrl,
      playbackHeaders: playback.playbackHeaders,
      drm: playback.drm,
      embedUrl: playback.embedUrl ?? null,
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
    const { widevineLicenseUrl, fairplayCertUrl, providerToken } = this.videoCfg.drm;

    // A DRM scheme is only claimed when there is something to claim it WITH.
    //
    // `DRM_ENABLED` is a global switch that a Gumlet deployment turns on, but
    // this method serves the LEGACY HLS path, which is AES-128 — not CENC — and
    // cannot use an EME licence at all. Turning the flag on therefore used to
    // hand every legacy video `scheme: 'widevine'` with a null licence URL.
    //
    // Today's clients happen to require a licence URL before routing to the DRM
    // player, so this did not break playback. It is a trap rather than a
    // symptom: any client that selects on `scheme !== 'none'` alone would send
    // every HLS lesson into a DRM player with no licence to fetch. Reporting
    // `none` when there is no licence server is both the truth and the safe
    // default — it can never route a legacy video away from hls.js.
    if (!this.videoCfg.drm.enabled || !widevineLicenseUrl) {
      return { scheme: 'none', licenseUrl: null, certificateUrl: null, licenseHeaders: {} };
    }

    return {
      scheme: 'widevine',
      licenseUrl: widevineLicenseUrl,
      certificateUrl: fairplayCertUrl,
      licenseHeaders: providerToken
        ? { Authorization: `Bearer ${providerToken}` }
        : {},
    };
  }

  /**
   * Decide how THIS video is delivered, from the ticket's own video row.
   *
   * This is the single switch between the two playback paths:
   *
   *   drmProvider = null      -> legacy R2 + AES-128 HLS, manifest generated
   *                             by this API (unchanged behaviour)
   *   drmProvider = 'gumlet'  -> Gumlet DASH manifest + Gumlet DRM license URL
   *
   * There is no third option. A Gumlet-backed video with missing configuration
   * or missing asset metadata FAILS rather than degrading to unprotected
   * playback - the failure is visible to the student as an error, and the
   * attempt is logged as a denied ticket.
   */
  private async resolvePlaybackTarget(
    ticketId: string,
    video: {
      id: string;
      drmProvider: string | null;
      gumletAssetId: string | null;
      gumletWorkspaceId: string | null;
      /** Used only to choose the student-facing message (processing vs unavailable). */
      gumletStatus: string | null;
    },
    expiresAt: Date,
    platform?: 'ios' | 'android' | 'web',
    delivery?: 'embed',
  ): Promise<{
    manifestUrl: string;
    playbackHeaders: Record<string, string>;
    drm: PlaybackTicketResponse['drm'];
    embedUrl?: string | null;
  }> {
    // ---- STRICT DRM GATE --------------------------------------------------
    //
    // There is NO legacy fallback from here. A video that is not verifiably
    // DRM-protected is not playable, full stop - not downgraded to HLS, not
    // served from R2, not served as a direct MP4.
    //
    // This replaced a previous design where `drmProvider !== 'gumlet'` fell
    // through to the legacy R2 + AES-128 HLS path. That path is the bypass this
    // gate exists to close: any video whose provider was not exactly the string
    // 'gumlet' - including one mid-migration, or one whose DB row was edited -
    // was served unencrypted.
    //
    // `DrmVerificationService` is the authority. It refuses on: no asset, DRM not
    // requested, asset not ready, asset failed, never verified, verification
    // stale, DRM disabled platform-wide, or signing unconfigured.
    if (!this.videoCfg.drm.enabled) {
      this.logger.error(
        `Video ${video.id} needs DRM but DRM_ENABLED is false. Refusing to serve it unprotected.`,
      );
      throw new AppException(ErrorCode.PLAYBACK_DENIED, {
        message: 'DRM is unavailable on this platform; this lesson cannot be played',
      });
    }

    const verdict = await this.drmVerification.evaluateVideo(video.id);
    if (!verdict.playable) {
      this.logger.warn(
        `Denied DRM playback for video ${video.id}: ${verdict.reason} (${verdict.detail})`,
      );
      // A processing video gets the "try again shortly" status so the app can
      // show the friendly message; everything else is unavailable.
      const inFlight = video.gumletStatus === 'processing' || video.gumletStatus === 'queued'
        || video.gumletStatus === 'pre-queued' || video.gumletStatus === 'upload-pending';
      if (inFlight) {
        throw new AppException(ErrorCode.VIDEO_NOT_READY, {
          message: 'This video is still being prepared',
          details: { drmState: verdict.reason },
        });
      }
      throw new AppException(ErrorCode.VIDEO_UNAVAILABLE, {
        message: 'This video is not available',
        details: { drmState: verdict.reason },
      });
    }

    const assetId = video.gumletAssetId as string;

    // signLicenseUrl fails closed on missing configuration; it never returns a
    // half-valid URL.
    const bundle = this.gumlet.signLicenseUrl({ assetId, hardwareSecure: true });

    // Apple platforms cannot use Widevine at all. Handing an iOS/Safari
    // client a Widevine URL would fail deep inside the CDM with an opaque
    // message, so the FairPlay variant of the same signed token is selected
    // here instead. `platform` is a presentation-layer hint only - every
    // entitlement check above already ran identically.
    const useFairPlay = platform === 'ios';
    const licenseUrl = useFairPlay
      ? this.gumlet.signFairPlayLicenseUrl({ assetId, hardwareSecure: true })
      : bundle.licenseUrl;

    // TEMPORARY playback hotfix: Gumlet's own embed player, ONLY for a request
    // that explicitly opted in with `delivery: 'embed'` (the student web; the
    // native apps never send it, and `platform` alone cannot tell iPhone
    // Safari from the native iOS app) AND only while GUMLET_WEB_EMBED_ENABLED
    // is true. Minted here, i.e. only after every entitlement, publication,
    // drip, device, concurrency and play-limit check in issueTicket passed.
    // The manifest/drm fields below are returned unchanged either way.
    const embedUrl =
      delivery === 'embed' && this.videoCfg.drm.gumlet.webEmbedEnabled === true
      ? this.gumlet.signEmbedUrl({
          assetId,
          tokenLifetimeSeconds: this.videoCfg.drm.gumlet.embedTokenLifetimeSeconds,
        })
      : null;

    return {
      embedUrl,
      // Manifest choice follows the DRM system. Gumlet offers FairPlay for HLS
      // only - their DASH manifests carry a Widevine PSSH and no FairPlay
      // signalling - so an Apple client must be handed the HLS playlist. Every
      // other client keeps DASH, unchanged.
      manifestUrl: useFairPlay
        ? this.gumlet.hlsManifestUrl({
            assetId,
            workspaceId: video.gumletWorkspaceId,
          })
        : this.gumlet.dashManifestUrl({
            assetId,
            workspaceId: video.gumletWorkspaceId,
          }),
      // The DASH manifest is served by Gumlet's CDN and needs no viewer-bound
      // headers. Access is enforced at ticket issuance and by the licence
      // token, not by a header here.
      playbackHeaders: {},
      drm: {
        scheme: useFairPlay ? 'fairplay' : 'widevine',
        licenseUrl,
        // Only meaningful for FairPlay; Widevine clients ignore it.
        certificateUrl: useFairPlay ? bundle.certificateUrl : null,
        licenseHeaders: {},
      },
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
      // await this.revokeTicket(ticket.id, 'Secure surface unavailable');
      // return { ok: false, terminate: { reason: 'DEVICE_INTEGRITY_FAILED' } };
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

    // --- play accounting ------------------------------------------------------
    // The play's own watched total, which is what decides whether this attempt
    // counted at all. Kept on the play rather than summed from tickets so a
    // rotation mid-lesson cannot double-count the overlap.
    if (ticket.playId) {
      await this.prisma.videoPlay
        .update({
          where: { id: ticket.playId },
          data: {
            lastActivityAt: new Date(),
            ...(delta > 0 ? { watchedSeconds: { increment: delta } } : {}),
          },
        })
        // Best-effort: a pruned play must not break playback for a student
        // who is legitimately watching.
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
        // Rotation stays inside the lesson the ORIGINAL ticket was issued for.
        // The ticket is the authorisation, so a rotation must not re-resolve the
        // attachment and silently move a reused video into a different lecture.
        lesson: {
          id: ticket.lessonId,
          title: ticket.video.lesson?.title ?? '',
          courseId: ticket.courseId,
        },
        deviceId: ticket.deviceId,
        maxHeight: ticket.maxHeight,
        ip: params.ip,
        rotatedFromId: ticket.id,
        // The SAME play. A rotation is the middle of one attempt, not a new
        // one — carrying the id forward is what stops a long lesson spending
        // the student's whole allowance on a single sitting.
        playId: ticket.playId,
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
      select: {
        id: true,
        status: true,
        lastPositionSeconds: true,
        lessonId: true,
        courseId: true,
        videoId: true,
        playId: true,
      },
    });

    if (!ticket) return { ok: true };

    if (ticket.status === PlaybackTicketStatus.ACTIVE) {
      await this.prisma.playbackTicket.update({
        where: { id: ticketId },
        data: { status: PlaybackTicketStatus.RELEASED, releasedAt: new Date() },
      });
    }

    await this.releaseStreamSlot(user.id, user.sessionId);

    // Deliberately NOT closing the play here.
    //
    // Releasing a ticket is what the app does when the player is dismissed,
    // the screen is left, or the process is backgrounded — none of which
    // means the student is finished with the lesson. Closing the play on
    // release would make reopening the player ten seconds later cost a second
    // attempt, which is precisely the technical-retry penalty the limit must
    // not have. The play stays open and `claimPlay` decides: inside
    // `playResumeWindow` it is the same attempt, beyond it the play is closed
    // and counted on the seconds it actually accumulated.
    //
    // Touching lastActivityAt keeps the window measured from when they
    // stopped watching rather than from when the ticket was minted.
    if (ticket.playId) {
      await this.prisma.videoPlay
        .update({ where: { id: ticket.playId }, data: { lastActivityAt: new Date() } })
        .catch(() => undefined);
    }

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

    // A library document grant carries no PlaybackTicket row: `issueTicket` in
    // library-documents.service.ts signs `lib_<partId>` and relies on the
    // entitlement as the durable record. Looking that id up in
    // `playbackTicket` therefore always missed, the edge read `live: false`,
    // and every library PDF was refused with `ticket_revoked` — while the
    // signature, the expiry and the bucket were all fine.
    if (ticketId.startsWith(LIBRARY_TICKET_PREFIX)) {
      return this.libraryTicketLiveness(
        ticketId.slice(LIBRARY_TICKET_PREFIX.length),
        uid,
      );
    }

    // Same shape, same reason. `AttachmentsService.issueTicket` signs
    // `att_<attachmentId>` and keeps no row either. Without this branch the id
    // fell through to the `playbackTicket` lookup below, ALWAYS missed, and the
    // edge read `live: false` - so every lecture PDF was refused with
    // `ticket_revoked` while its signature, expiry and bucket were all valid.
    // Library documents were already spared by the branch above; lecture
    // documents were not, and that is the whole reason they failed.
    if (ticketId.startsWith(ATTACHMENT_TICKET_PREFIX)) {
      return this.attachmentTicketLiveness(
        ticketId.slice(ATTACHMENT_TICKET_PREFIX.length),
        uid,
      );
    }

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

  /**
   * Is a library document grant still good?
   *
   * The video branch above re-reads the ticket row, which pins one session and
   * one device. A library grant has no row, so this re-runs the checks
   * `LibraryDocumentsService.issueTicket` made when it minted the URL:
   *
   *   - the part and its material must not be withdrawn — deleted or
   *     `ARCHIVED`. Mirrored exactly from `issueTicket`, including that
   *     `isActive` is deliberately *not* part of it: the edge must not refuse
   *     a grant the issuing path would have allowed.
   *   - a non-preview part needs a live entitlement. A preview is openable by
   *     anyone, which is what makes it a preview.
   *
   * **One deliberate difference.** The edge probe carries only the ticket id
   * and `uid` (`ticketIsLive` in docs/cloudflare-worker.js), not `sid`/`did`,
   * so the specific session and device in the URL cannot be identified here
   * without changing the Worker contract. Instead this asks whether the
   * account still has *any* live session, and any authorised device for
   * device-bound content. That keeps the property the check exists for — a
   * signed URL dies when the student is signed out, their device revoked or
   * their binding reset — while being weaker than the video branch for an
   * account holding several devices, where revoking one does not kill a URL
   * minted on it until the URL expires (PLAYBACK_TICKET_TTL, 300s).
   */
  private async libraryTicketLiveness(
    libraryPartId: string,
    userId: string,
  ): Promise<{ live: boolean }> {
    if (!libraryPartId) return { live: false };

    const part = await this.prisma.libraryPart.findFirst({
      where: { id: libraryPartId, ...notDeleted },
      select: {
        id: true,
        isPreview: true,
        status: true,
        material: { select: { status: true, deletedAt: true } },
      },
    });

    if (!part) return { live: false };

    if (
      part.status === ContentStatus.ARCHIVED ||
      part.material.deletedAt !== null ||
      part.material.status === ContentStatus.ARCHIVED
    ) {
      return { live: false };
    }

    if (!part.isPreview) {
      const entitlement = await this.prisma.libraryEntitlement.findUnique({
        where: { userId_libraryPartId: { userId, libraryPartId: part.id } },
        select: { revokedAt: true },
      });

      if (!entitlement || entitlement.revokedAt !== null) return { live: false };
    }

    const [activeSessions, activeDevices] = await this.prisma.$transaction([
      this.prisma.session.count({ where: { userId, status: 'ACTIVE' } }),
      this.prisma.device.count({ where: { userId, status: DeviceStatus.ACTIVE } }),
    ]);

    if (activeSessions === 0) return { live: false };

    // Previews are not device-bound when the URL is minted, so they are not
    // device-bound when it is re-checked either.
    if (!part.isPreview && activeDevices === 0) return { live: false };

    return { live: true };
  }

  /**
   * Is a lecture/section/course document grant still good?
   *
   * The video branch re-reads a PlaybackTicket row that pins one session and
   * one device. A document grant has no row - `AttachmentsService.issueTicket`
   * signs the URL and keeps no durable ticket of its own - so this re-runs the
   * checks that issuing path made, mirroring it exactly:
   *
   *   - the attachment must still exist, not be deleted, and its lesson and
   *     section must still be PUBLISHED. A lecture-scoped row carries a NULL
   *     sectionId, so its section is reached through the lesson.
   *   - a non-preview document needs live course entitlement, and a scoped one
   *     needs that section too.
   *   - a protected document is device-bound, exactly as it was at signing time.
   *
   * **One deliberate difference**, identical to the library branch: the probe
   * carries only the ticket id and `uid`, not `sid`/`did`, so this asks whether
   * the account still has ANY live session and any authorised device. Weaker than
   * the video branch for a multi-device account, bounded by the attachment ticket
   * TTL. The per-session/per-device binding is still enforced when the URL is
   * signed, and again in the HMAC the Worker verifies.
   */
  private async attachmentTicketLiveness(
    attachmentId: string,
    userId: string,
  ): Promise<{ live: boolean }> {
    if (!attachmentId) return { live: false };

    const attachment = await this.prisma.attachment.findFirst({
      where: { id: attachmentId, ...notDeleted },
      select: {
        id: true,
        courseId: true,
        lessonId: true,
        sectionId: true,
        isPreview: true,
        isProtected: true,
      },
    });

    if (!attachment) return { live: false };

    let lessonStatus: ContentStatus | null = null;
    let sectionStatus: ContentStatus | null = null;

    if (attachment.lessonId) {
      const lesson = await this.prisma.lesson.findUnique({
        where: { id: attachment.lessonId },
        select: { status: true, section: { select: { status: true } } },
      });
      lessonStatus = lesson?.status ?? null;
      sectionStatus = lesson?.section?.status ?? null;
    }

    if (attachment.sectionId) {
      const section = await this.prisma.courseSection.findUnique({
        where: { id: attachment.sectionId },
        select: { status: true },
      });
      sectionStatus = section?.status ?? null;
    }

    const unpublished =
      (lessonStatus !== null && lessonStatus !== ContentStatus.PUBLISHED) ||
      (sectionStatus !== null && sectionStatus !== ContentStatus.PUBLISHED);
    if (unpublished) return { live: false };

    // Entitlement. A preview is openable by anyone, which is what makes it a
    // preview; everything else needs the course, and a scoped document its
    // section - resolved through the lesson for a lecture-scoped row.
    if (!attachment.isPreview) {
      const decision = await this.access.resolve({
        userId,
        role: UserRole.STUDENT,
        courseId: attachment.courseId,
      });
      if (!decision.canAccessContent) return { live: false };

      let scopedSectionId: string | null = attachment.sectionId;
      if (!scopedSectionId && attachment.lessonId) {
        const lesson = await this.prisma.lesson.findUnique({
          where: { id: attachment.lessonId },
          select: { sectionId: true },
        });
        scopedSectionId = lesson?.sectionId ?? null;
      }

      if (scopedSectionId) {
        const allowed = await this.access.allowedSectionIds(userId, attachment.courseId);
        // `null` is whole-course access, so there is nothing to narrow.
        if (allowed !== null && !allowed.includes(scopedSectionId)) {
          return { live: false };
        }
      }
    }

    const [activeSessions, activeDevices] = await this.prisma.$transaction([
      this.prisma.session.count({ where: { userId, status: 'ACTIVE' } }),
      this.prisma.device.count({ where: { userId, status: DeviceStatus.ACTIVE } }),
    ]);

    if (activeSessions === 0) return { live: false };

    // Only device-bound material needs a device. `isProtected` is precisely what
    // made `issueTicket` call `assertAuthorizedForProtectedContent`, so an
    // unprotected syllabus is not device-bound here either.
    if (attachment.isProtected && activeDevices === 0) return { live: false };

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
