import { Injectable, Logger } from '@nestjs/common';
import {
  ContentStatus,
  type Prisma,
  type UserRole,
  WatchEventType,
} from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { PrismaService, notDeleted } from '../../database/prisma.service';
import { CourseAccessService } from '../courses/course-access.service';
import { toCompletionRule, toWatchProgress } from '../courses/course.serializer';
import { StorageService } from '../storage/storage.service';

export interface ProgressInput {
  lessonId: string;
  positionSeconds: number;
  /** Contiguous seconds actually watched since the last report. */
  watchedSeconds: number;
}

/**
 * Watch progress.
 *
 * The rules that make this trustworthy rather than decorative:
 *
 *  1. **Percent is monotonic.** It is only ever raised. Without this, a
 *     student who reopens a finished lesson and watches ten seconds would see
 *     their progress collapse from 100% to 2%.
 *
 *  2. **Seeking earns nothing.** `watchedSeconds` accumulates only the
 *     contiguous time the client reports, and the server additionally clamps
 *     each report so a client cannot claim an hour of watching in a five
 *     second window. Position and watch time are tracked separately for
 *     exactly this reason.
 *
 *  3. **Completion is decided here, from the course's configured rule.** The
 *     client never asserts completion for watch-based rules (spec §46).
 *
 *  4. **Writes are cheap.** One row per (student, lesson), upserted. Watch
 *     *events* are appended for analytics, but only for meaningful deltas —
 *     never one row per second of playback (spec §44).
 */
@Injectable()
export class ProgressService {
  private readonly logger = new Logger(ProgressService.name);

  /**
   * Ceiling on the watch time a single report may bank.
   *
   * Necessary but not sufficient. A per-report cap only bounds one request: a
   * patched client can call `POST /progress` a thousand times and bank a
   * thousand caps, so on its own this number is not an anti-forgery control. It
   * exists to absorb a buggy client in one gulp rather than in a thousand.
   *
   * The real control is `PlaybackTicket.watchedSeconds` below — watch time is
   * only credited when a heartbeat for this lesson's video has actually recorded
   * it server-side.
   */
  private static readonly MAX_DELTA_SECONDS = 900;

  /**
   * How far behind the server's observed position a report may claim.
   *
   * Resume position and percent are client-reported because the server only
   * sees the player through heartbeats, but percent is an achievement, so it
   * cannot be self-awarded. See `clampToObserved`.
   */
  private static readonly POSITION_TOLERANCE_SECONDS = 120;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CourseAccessService,
    private readonly storage: StorageService,
  ) {}

  // ---------------------------------------------------------------------------
  // Write
  // ---------------------------------------------------------------------------

  async upsert(params: { userId: string; role: UserRole; input: ProgressInput }) {
    const lesson = await this.prisma.lesson.findFirst({
      where: { id: params.input.lessonId, ...notDeleted },
      include: {
        course: {
          select: {
            id: true,
            status: true,
            completionRuleType: true,
            completionThreshold: true,
            completionRequireContiguous: true,
          },
        },
        video: { select: { id: true, durationSeconds: true } },
      },
    });

    if (!lesson) throw AppException.notFound('Lesson', params.input.lessonId);

    // Progress is content access: an expired student cannot keep writing
    // progress, which would otherwise let watch time accrue after access ends.
    await this.access.assertContentAccess({
      userId: params.userId,
      role: params.role,
      courseId: lesson.courseId,
      allowPreview: true,
      isPreviewContent: lesson.isPreview,
    });

    const duration = lesson.durationSeconds || lesson.video?.durationSeconds || 0;

    const existing = await this.prisma.watchProgress.findUnique({
      where: { userId_lessonId: { userId: params.userId, lessonId: lesson.id } },
    });

    // --- what the server can actually vouch for -------------------------------
    //
    // `POST /progress` is reachable by any signed-in student with the lesson id
    // and nothing else — it is not behind the playback ticket. So the numbers in
    // its body are claims, not observations. Clamping them per-report only
    // limits how much a *single* lie buys; a loop of honest-looking reports buys
    // unlimited watch time, and `positionSeconds` can be set straight to the
    // duration to complete any lesson in one call.
    //
    // The server does keep its own record of real viewing: every heartbeat
    // increments `PlaybackTicket.watchedSeconds` and
    // `PlaybackTicket.lastPositionSeconds`, and that increment can only happen on
    // a ticket the server itself issued after the full access chain passed. So
    // watch time is credited from there, never from the request body, and the
    // body's position is only allowed to lead the observed position by a small
    // tolerance.
    //
    // Note the asymmetry that makes this safe: the client is not required to
    // heartbeat for its own progress to be saved, so a genuine student on a
    // flaky connection can always move their resume marker. What they cannot do
    // is move it *far*, or bank watch time with no playback behind it at all.
    const observed = await this.observePlayback(params.userId, lesson.video?.id ?? null);

    // Only the portion of observed watch time not already banked can be claimed,
    // so replaying the same heartbeat window cannot be counted twice.
    const uncreditedObserved = Math.max(
      0,
      observed.watchedSeconds - (existing?.watchedSeconds ?? 0),
    );

    const delta = Math.min(
      this.clamp(params.input.watchedSeconds, 0, ProgressService.MAX_DELTA_SECONDS),
      uncreditedObserved,
    );

    const position = this.clampToObserved(
      params.input.positionSeconds,
      observed.positionSeconds,
      duration || 86_400,
    );

    const watchedSeconds = (existing?.watchedSeconds ?? 0) + delta;
    const rawPercent = duration > 0 ? Math.round((position / duration) * 100) : 0;

    // Monotonic.
    const percent = Math.min(100, Math.max(existing?.percent ?? 0, rawPercent));

    const rule = toCompletionRule(lesson, lesson.course);
    const effectivePercent = rule.requireContiguous
      ? duration > 0
        ? Math.round((watchedSeconds / duration) * 100)
        : 0
      : percent;

    const completed =
      existing?.completed ||
      (rule.type === 'WATCH_FULL'
        ? effectivePercent >= 99
        : rule.type === 'WATCH_PERCENT'
          ? effectivePercent >= rule.threshold
          : false);

    const now = new Date();
    const justCompleted = completed && !existing?.completed;

    const progress = await this.prisma.$transaction(async (tx) => {
      const row = await tx.watchProgress.upsert({
        where: { userId_lessonId: { userId: params.userId, lessonId: lesson.id } },
        create: {
          userId: params.userId,
          lessonId: lesson.id,
          courseId: lesson.courseId,
          positionSeconds: position,
          durationSeconds: duration,
          percent,
          watchedSeconds,
          completed,
          completedAt: completed ? now : null,
          lastWatchedAt: now,
        },
        update: {
          positionSeconds: position,
          durationSeconds: duration || undefined,
          percent,
          watchedSeconds,
          completed,
          completedAt: justCompleted ? now : undefined,
          lastWatchedAt: now,
        },
      });

      if (justCompleted) {
        const completedCount = await tx.watchProgress.count({
          where: { userId: params.userId, courseId: lesson.courseId, completed: true },
        });

        await tx.enrollment.updateMany({
          where: { userId: params.userId, courseId: lesson.courseId },
          data: {
            completedLessons: completedCount,
            lastLessonId: lesson.id,
            lastAccessedAt: now,
          },
        });

        await tx.watchEvent.create({
          data: {
            userId: params.userId,
            lessonId: lesson.id,
            courseId: lesson.courseId,
            videoId: lesson.video?.id,
            type: WatchEventType.COMPLETED,
            positionSeconds: position,
          },
        });
      } else {
        await tx.enrollment.updateMany({
          where: { userId: params.userId, courseId: lesson.courseId },
          data: { lastLessonId: lesson.id, lastAccessedAt: now },
        });
      }

      return row;
    });

    return toWatchProgress(progress);
  }

  /**
   * Offline replay.
   *
   * The app queues failed progress writes in local storage and flushes them as
   * a batch on reconnect. Each item is applied independently so one bad entry
   * (a lesson that was deleted meanwhile) does not discard the whole batch.
   */
  async upsertBatch(params: {
    userId: string;
    role: UserRole;
    items: ProgressInput[];
  }): Promise<{ accepted: number; rejected: number }> {
    let accepted = 0;
    let rejected = 0;

    // De-duplicate by lesson, keeping the furthest position and summed watch
    // time — the client already collapses these, but a retry can duplicate.
    const collapsed = new Map<string, ProgressInput>();
    for (const item of params.items.slice(0, 100)) {
      const previous = collapsed.get(item.lessonId);
      collapsed.set(item.lessonId, {
        lessonId: item.lessonId,
        positionSeconds: Math.max(previous?.positionSeconds ?? 0, item.positionSeconds),
        watchedSeconds: (previous?.watchedSeconds ?? 0) + item.watchedSeconds,
      });
    }

    for (const item of collapsed.values()) {
      try {
        await this.upsert({ userId: params.userId, role: params.role, input: item });
        accepted += 1;
      } catch (e) {
        rejected += 1;
        this.logger.debug(
          `batch progress item rejected (lesson ${item.lessonId}): ${(e as Error).message}`,
        );
      }
    }

    return { accepted, rejected };
  }

  // ---------------------------------------------------------------------------
  // Playback evidence
  // ---------------------------------------------------------------------------

  /**
   * What the server has itself recorded of real viewing for this video.
   *
   * Summing across tickets rather than reading the latest is deliberate: a long
   * lesson rotates its ticket (`rotatedFromId` chains the grants), so the most
   * recent ticket only covers the tail of the session. Revoked and released
   * tickets are included on purpose — that time really was watched, and
   * excluding it would let a student reset the counter by forcing a rotation.
   *
   * `watchProgress.watchedSeconds` is derived from this total and is never
   * reduced, so the sum only ever grows and the uncredited remainder stays
   * meaningful.
   */
  private async observePlayback(
    userId: string,
    videoId: string | null,
  ): Promise<{ watchedSeconds: number; positionSeconds: number }> {
    // A lesson with no video cannot have been watched, so there is nothing to
    // vouch for. Returning zeroes makes that lesson's progress inert rather
    // than throwing, which would break a legitimate report of "opened, watched
    // nothing".
    if (!videoId) return { watchedSeconds: 0, positionSeconds: 0 };

    const rows = await this.prisma.playbackTicket.findMany({
      where: { userId, videoId },
      select: { watchedSeconds: true, lastPositionSeconds: true },
    });

    let watchedSeconds = 0;
    let positionSeconds = 0;

    for (const row of rows) {
      watchedSeconds += this.clamp(row.watchedSeconds, 0, Number.MAX_SAFE_INTEGER);
      positionSeconds = Math.max(positionSeconds, row.lastPositionSeconds);
    }

    return { watchedSeconds, positionSeconds };
  }

  /**
   * Bounds a reported resume position by what has actually been observed.
   *
   * The claim may lead the observed position by a small tolerance, because
   * heartbeat and progress are separate requests and the player legitimately
   * moves between them — rejecting that would drop the marker on every seek.
   * Beyond the tolerance it is a claim with nothing behind it, so it is capped.
   *
   * There is deliberately no "nothing observed, so trust the claim" escape
   * hatch. That would reintroduce the original hole: a student who never takes
   * a playback ticket has no observation, so the fallback would let them claim
   * any position — including the full duration — and complete the lesson. With
   * no observation the ceiling is just the tolerance, so the marker starts at
   * zero and advances on the first real heartbeat.
   *
   * The marker is allowed to move backwards, because the player can. That is safe
   * because percent and completion are monotonic in their own right, so a rewind
   * cannot take back an achievement.
   */
  private clampToObserved(reported: number, observedPosition: number, maxSeconds: number): number {
    const claimed = this.clamp(reported, 0, maxSeconds);

    const ceiling = Math.min(
      maxSeconds,
      Math.max(0, observedPosition) + ProgressService.POSITION_TOLERANCE_SECONDS,
    );

    return Math.min(claimed, ceiling);
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /** Matches the app's `ContinueWatchingItem[]`. */
  async continueWatching(userId: string, limit = 6) {
    const rows = await this.prisma.watchProgress.findMany({
      where: {
        userId,
        completed: false,
        percent: { gt: 0 },
        lesson: { deletedAt: null, status: ContentStatus.PUBLISHED },
      },
      orderBy: { lastWatchedAt: 'desc' },
      take: limit,
      include: {
        lesson: {
          include: {
            video: { select: { id: true, status: true, durationSeconds: true } },
            _count: { select: { attachments: { where: { deletedAt: null } } } },
          },
        },
        course: {
          select: {
            id: true,
            title: true,
            thumbnailKey: true,
            status: true,
            teachers: {
              orderBy: { isLead: 'desc' },
              take: 1,
              select: {
                teacher: {
                  select: {
                    id: true,
                    fullName: true,
                    avatarUrl: true,
                    teacherProfile: { select: { title: true } },
                  },
                },
              },
            },
          },
        },
      },
    });

    // Only surface courses the student can still open — an expired course in
    // "Continue watching" is a dead end.
    const decisions = await this.access.resolveMany(
      userId,
      rows.map((r) => ({
        id: r.courseId,
        status: r.course.status,
        enrollmentMethods: [],
      })),
    );

    const items = [];

    for (const row of rows) {
      const decision = decisions.get(row.courseId);
      if (!decision?.decision.canAccessContent) continue;

      const teacher = row.course.teachers[0]?.teacher;

      items.push({
        lesson: {
          id: row.lesson.id,
          sectionId: row.lesson.sectionId,
          courseId: row.lesson.courseId,
          title: row.lesson.title,
          kind: row.lesson.kind,
          order: row.lesson.sortOrder,
          durationSeconds: row.lesson.durationSeconds || row.lesson.video?.durationSeconds || 0,
          isPreview: row.lesson.isPreview,
          locked: false,
          attachmentCount: row.lesson._count.attachments,
          progress: toWatchProgress(row),
        },
        course: {
          id: row.course.id,
          title: row.course.title,
          thumbnailUrl: await this.storage.publicAssetUrl(row.course.thumbnailKey),
          teacher: teacher
            ? {
                id: teacher.id,
                fullName: teacher.fullName,
                avatarUrl: teacher.avatarUrl,
                title: teacher.teacherProfile?.title ?? null,
                bio: null,
              }
            : { id: '', fullName: 'Unassigned', avatarUrl: null, title: null, bio: null },
        },
        progress: toWatchProgress(row),
      });
    }

    return items;
  }

  async forLesson(userId: string, lessonId: string) {
    const row = await this.prisma.watchProgress.findUnique({
      where: { userId_lessonId: { userId, lessonId } },
    });
    return toWatchProgress(row);
  }

  /** Per-student, per-course breakdown for the teacher dashboard. */
  async courseBreakdown(params: {
    courseId: string;
    actorId: string;
    role: UserRole;
    page: number;
    pageSize: number;
  }) {
    await this.access.assertCanManageCourse(
      params.actorId,
      params.role,
      params.courseId,
      'students',
    );

    const where: Prisma.EnrollmentWhereInput = { courseId: params.courseId };

    const [enrollments, total, lessonCount] = await this.prisma.$transaction([
      this.prisma.enrollment.findMany({
        where,
        orderBy: { lastAccessedAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: { user: { select: { id: true, fullName: true, phone: true } } },
      }),
      this.prisma.enrollment.count({ where }),
      this.prisma.lesson.count({
        where: {
          courseId: params.courseId,
          deletedAt: null,
          status: ContentStatus.PUBLISHED,
        },
      }),
    ]);

    return {
      items: enrollments.map((e) => ({
        student: e.user,
        state: e.state,
        completedLessons: e.completedLessons,
        totalLessons: lessonCount,
        percent: lessonCount > 0 ? Math.round((e.completedLessons / lessonCount) * 100) : 0,
        lastAccessedAt: e.lastAccessedAt?.toISOString() ?? null,
        accessEndsAt: e.accessEndsAt?.toISOString() ?? null,
      })),
      meta: {
        page: params.page,
        pageSize: params.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
        hasNext: params.page * params.pageSize < total,
        hasPrevious: params.page > 1,
      },
    };
  }

  private clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(Math.max(Math.floor(value), min), max);
  }
}
