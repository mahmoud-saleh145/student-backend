import { Injectable, Logger } from '@nestjs/common';
import {
  ContentStatus,
  type Prisma,
  type UserRole,
  WatchEventType,
} from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
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

  /** Anything above this in a single report is a client bug or a forgery. */
  private static readonly MAX_DELTA_SECONDS = 900;

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

    const position = this.clamp(params.input.positionSeconds, 0, duration || 86_400);
    const delta = this.clamp(
      params.input.watchedSeconds,
      0,
      ProgressService.MAX_DELTA_SECONDS,
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
