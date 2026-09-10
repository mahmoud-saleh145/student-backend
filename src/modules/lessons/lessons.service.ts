import { Injectable, Logger } from '@nestjs/common';
import {
  AuditAction,
  ContentStatus,
  type LessonKind,
  UserRole,
  VideoStatus,
} from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService, notDeleted } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CourseAccessService } from '../courses/course-access.service';
import { CoursesService } from '../courses/courses.service';
import {
  toAttachment,
  toCompletionRule,
  toWatchProgress,
} from '../courses/course.serializer';

/**
 * Lessons.
 *
 * The student-facing `detail()` is the gate that matters here: it enforces
 * access before returning anything, and it returns video METADATA only. There
 * is no field on the response that can be turned into a playable URL — that
 * requires a separate, authorized ticket request.
 */
@Injectable()
export class LessonsService {
  private readonly logger = new Logger(LessonsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CourseAccessService,
    private readonly courses: CoursesService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Student read
  // ---------------------------------------------------------------------------

  async detail(lessonId: string, userId: string, role: UserRole) {
    const lesson = await this.prisma.lesson.findFirst({
      where: { id: lessonId, ...notDeleted },
      include: {
        video: {
          include: {
            renditions: { orderBy: { height: 'asc' } },
            captions: true,
          },
        },
        attachments: { where: notDeleted, orderBy: { sortOrder: 'asc' } },
        course: {
          select: {
            id: true,
            status: true,
            completionRuleType: true,
            completionThreshold: true,
            completionRequireContiguous: true,
          },
        },
        section: { select: { id: true, status: true, unlocksAt: true, sortOrder: true } },
      },
    });

    if (!lesson) throw AppException.notFound('Lesson', lessonId);

    if (
      lesson.status !== ContentStatus.PUBLISHED &&
      role === UserRole.STUDENT
    ) {
      throw AppException.notFound('Lesson', lessonId);
    }

    // Access check. Preview lessons are the documented exception.
    await this.access.assertContentAccess({
      userId,
      role,
      courseId: lesson.courseId,
      allowPreview: true,
      isPreviewContent: lesson.isPreview,
    });

    // Section-scoped entitlement. A student holding only a section code may
    // reach a lesson id in another section by guessing it; this is where that
    // is refused. Preview lessons stay open, as they are everywhere else.
    if (role === UserRole.STUDENT && !lesson.isPreview) {
      await this.access.assertSectionAccessible({
        userId,
        courseId: lesson.courseId,
        sectionId: lesson.sectionId,
      });
    }

    // Drip release is enforced server-side too, not just hidden in the UI.
    if (
      lesson.section.unlocksAt &&
      lesson.section.unlocksAt.getTime() > Date.now() &&
      !lesson.isPreview &&
      role === UserRole.STUDENT
    ) {
      throw new AppException(ErrorCode.NOT_ENROLLED, {
        message: 'This section has not been released yet',
        details: { unlocksAt: lesson.section.unlocksAt.toISOString() },
      });
    }

    const [progress, siblings] = await Promise.all([
      this.prisma.watchProgress.findUnique({
        where: { userId_lessonId: { userId, lessonId } },
      }),
      this.orderedLessons(lesson.courseId),
    ]);

    const index = siblings.findIndex((s) => s.id === lesson.id);

    return {
      id: lesson.id,
      sectionId: lesson.sectionId,
      courseId: lesson.courseId,
      title: lesson.title,
      description: lesson.description,
      kind: lesson.kind,
      order: lesson.sortOrder,
      durationSeconds: lesson.durationSeconds || lesson.video?.durationSeconds || 0,
      isPreview: lesson.isPreview,
      locked: false,
      attachmentCount: lesson.attachments.length,
      progress: toWatchProgress(progress),

      // Metadata only — deliberately no URL. See PlaybackService.
      video: lesson.video
        ? {
            id: lesson.video.id,
            lessonId: lesson.id,
            courseId: lesson.courseId,
            assetId: lesson.video.id,
            durationSeconds: lesson.video.durationSeconds,
            thumbnailUrl: null,
            availableQualities: lesson.video.renditions.map((r) => `${r.height}p`),
            hasCaptions: lesson.video.captions.length > 0,
            captionLanguages: lesson.video.captions.map((c) => c.language),
            status: lesson.video.status,
          }
        : null,

      attachments: lesson.attachments.map((a) => toAttachment(a, true)),
      nextLessonId: index >= 0 ? (siblings[index + 1]?.id ?? null) : null,
      previousLessonId: index > 0 ? (siblings[index - 1]?.id ?? null) : null,
      // The player route is addressed by video id, so it is supplied directly
      // rather than left for the client to derive from the lesson id.
      nextVideoId: index >= 0 ? (siblings[index + 1]?.videoId ?? null) : null,
      previousVideoId: index > 0 ? (siblings[index - 1]?.videoId ?? null) : null,
      completionRule: toCompletionRule(lesson, lesson.course),
    };
  }

  /**
   * Course-wide lesson order, flattened across sections.
   *
   * Needed for prev/next navigation, which crosses section boundaries — the
   * student expects "next" at the end of Unit 1 to open the first lesson of
   * Unit 2, not to dead-end.
   *
   * Each entry carries the lesson's video id as well, because the player route
   * is addressed by video id. Returning only lesson ids would force the client
   * to reconstruct one, and there is no derivable relationship between the two
   * — they are independent identifiers.
   */
  private async orderedLessons(
    courseId: string,
  ): Promise<{ id: string; videoId: string | null }[]> {
    const rows = await this.prisma.lesson.findMany({
      where: { courseId, ...notDeleted, status: ContentStatus.PUBLISHED },
      orderBy: [{ section: { sortOrder: 'asc' } }, { sortOrder: 'asc' }],
      select: { id: true, video: { select: { id: true } } },
    });
    return rows.map((r) => ({ id: r.id, videoId: r.video?.id ?? null }));
  }

  /**
   * Resolves a video id to its lesson.
   *
   * Exists because the mobile player route is entered with a video id but
   * needs lesson metadata (title, completion rule, next lesson). Without it
   * the client would have to guess the lesson id from the video id.
   */
  async byVideoId(videoId: string, userId: string, role: UserRole) {
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, ...notDeleted },
      select: { lessonId: true },
    });
    if (!video) throw AppException.notFound('Video', videoId);
    return this.detail(video.lessonId, userId, role);
  }

  // ---------------------------------------------------------------------------
  // Completion
  // ---------------------------------------------------------------------------

  /**
   * Manual completion.
   *
   * Only honoured for lessons whose rule is MANUAL. For watch-based rules the
   * server decides from recorded progress — accepting a client's claim of
   * completion would make the rule decorative, which is exactly what spec §46
   * warns against.
   */
  async markComplete(lessonId: string, userId: string, role: UserRole) {
    const lesson = await this.prisma.lesson.findFirst({
      where: { id: lessonId, ...notDeleted },
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
      },
    });
    if (!lesson) throw AppException.notFound('Lesson', lessonId);

    await this.access.assertContentAccess({
      userId,
      role,
      courseId: lesson.courseId,
      allowPreview: true,
      isPreviewContent: lesson.isPreview,
    });

    const rule = toCompletionRule(lesson, lesson.course);

    if (rule.type !== 'MANUAL') {
      const existing = await this.prisma.watchProgress.findUnique({
        where: { userId_lessonId: { userId, lessonId } },
      });

      const reached = this.meetsRule(rule, existing);
      if (!reached) {
        throw new AppException(ErrorCode.INVALID_STATE, {
          message:
            'This lesson completes automatically from watch progress; not enough has been watched yet',
          details: {
            rule,
            watchedPercent: existing
              ? rule.requireContiguous
                ? Math.round(
                    (existing.watchedSeconds / Math.max(1, existing.durationSeconds)) * 100,
                  )
                : existing.percent
              : 0,
          },
        });
      }
    }

    const now = new Date();

    const progress = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.watchProgress.upsert({
        where: { userId_lessonId: { userId, lessonId } },
        create: {
          userId,
          lessonId,
          courseId: lesson.courseId,
          positionSeconds: lesson.durationSeconds,
          durationSeconds: lesson.durationSeconds,
          percent: 100,
          watchedSeconds: lesson.durationSeconds,
          completed: true,
          completedAt: now,
        },
        update: { completed: true, completedAt: now, percent: 100, lastWatchedAt: now },
      });

      const completedCount = await tx.watchProgress.count({
        where: { userId, courseId: lesson.courseId, completed: true },
      });

      await tx.enrollment.updateMany({
        where: { userId, courseId: lesson.courseId },
        data: { completedLessons: completedCount, lastLessonId: lessonId, lastAccessedAt: now },
      });

      return updated;
    });

    return toWatchProgress(progress);
  }

  private meetsRule(
    rule: { type: string; threshold: number; requireContiguous: boolean },
    progress: { percent: number; watchedSeconds: number; durationSeconds: number } | null,
  ): boolean {
    if (!progress) return false;

    const effective = rule.requireContiguous
      ? Math.round((progress.watchedSeconds / Math.max(1, progress.durationSeconds)) * 100)
      : progress.percent;

    if (rule.type === 'WATCH_FULL') return effective >= 99;
    return effective >= rule.threshold;
  }

  // ---------------------------------------------------------------------------
  // Authoring
  // ---------------------------------------------------------------------------

  async create(
    sectionId: string,
    input: {
      title: string;
      titleAr?: string;
      description?: string;
      kind?: LessonKind;
      sortOrder?: number;
      isPreview?: boolean;
      durationSeconds?: number;
      status?: ContentStatus;
      completionRuleType?: 'WATCH_PERCENT' | 'WATCH_FULL' | 'MANUAL';
      completionThreshold?: number;
      completionRequireContiguous?: boolean;
    },
    actor: { id: string; role: UserRole },
  ) {
    const section = await this.prisma.courseSection.findFirst({
      where: { id: sectionId, ...notDeleted },
      select: { id: true, courseId: true },
    });
    if (!section) throw AppException.notFound('Section', sectionId);

    await this.access.assertCanManageCourse(actor.id, actor.role, section.courseId, 'content');

    const lesson = await this.prisma.$transaction(async (tx) => {
      const last = await tx.lesson.findFirst({
        where: { sectionId, ...notDeleted },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });

      const target = input.sortOrder ?? (last?.sortOrder ?? 0) + 1;

      if (input.sortOrder !== undefined) {
        await tx.$executeRaw`
          UPDATE lessons SET "sortOrder" = -("sortOrder" + 1)
          WHERE "sectionId" = ${sectionId} AND "sortOrder" >= ${target} AND "deletedAt" IS NULL
        `;
        await tx.$executeRaw`
          UPDATE lessons SET "sortOrder" = -"sortOrder"
          WHERE "sectionId" = ${sectionId} AND "sortOrder" < 0
        `;
      }

      return tx.lesson.create({
        data: {
          courseId: section.courseId,
          sectionId,
          title: input.title.trim(),
          titleAr: input.titleAr?.trim(),
          description: input.description?.trim(),
          kind: input.kind ?? 'VIDEO',
          sortOrder: target,
          isPreview: input.isPreview ?? false,
          durationSeconds: input.durationSeconds ?? 0,
          status: input.status ?? ContentStatus.DRAFT,
          completionRuleType: input.completionRuleType,
          completionThreshold: input.completionThreshold,
          completionRequireContiguous: input.completionRequireContiguous,
        },
      });
    });

    await this.courses.recountCourse(section.courseId);

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.CREATE,
      entity: 'lesson',
      entityId: lesson.id,
      after: { courseId: section.courseId, title: lesson.title },
    });

    return lesson;
  }

  async update(
    lessonId: string,
    input: Record<string, unknown>,
    actor: { id: string; role: UserRole },
  ) {
    const lesson = await this.requireLesson(lessonId);
    await this.access.assertCanManageCourse(actor.id, actor.role, lesson.courseId, 'content');

    const updated = await this.prisma.lesson.update({
      where: { id: lessonId },
      data: {
        title: input.title as string | undefined,
        titleAr: input.titleAr as string | undefined,
        description: input.description as string | undefined,
        kind: input.kind as LessonKind | undefined,
        isPreview: input.isPreview as boolean | undefined,
        status: input.status as ContentStatus | undefined,
        durationSeconds: input.durationSeconds as number | undefined,
        completionRuleType: input.completionRuleType as never,
        completionThreshold: input.completionThreshold as number | undefined,
        completionRequireContiguous: input.completionRequireContiguous as boolean | undefined,
      },
    });

    await this.courses.recountCourse(lesson.courseId);

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.UPDATE,
      entity: 'lesson',
      entityId: lessonId,
      before: { title: lesson.title, status: lesson.status },
      after: { title: updated.title, status: updated.status },
    });

    return updated;
  }

  async reorder(sectionId: string, lessonIds: string[], actor: { id: string; role: UserRole }) {
    const section = await this.prisma.courseSection.findFirst({
      where: { id: sectionId, ...notDeleted },
      select: { courseId: true },
    });
    if (!section) throw AppException.notFound('Section', sectionId);

    await this.access.assertCanManageCourse(actor.id, actor.role, section.courseId, 'content');

    const existing = await this.prisma.lesson.findMany({
      where: { sectionId, ...notDeleted },
      select: { id: true },
    });
    const ids = new Set(existing.map((l) => l.id));

    if (lessonIds.length !== ids.size || !lessonIds.every((id) => ids.has(id))) {
      throw AppException.validation({
        lessonIds: ['must contain exactly the current lesson ids of this section'],
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE lessons SET "sortOrder" = -"sortOrder" - 1000
        WHERE "sectionId" = ${sectionId} AND "deletedAt" IS NULL
      `;
      for (const [index, id] of lessonIds.entries()) {
        await tx.lesson.update({ where: { id }, data: { sortOrder: index + 1 } });
      }
    });

    return { ok: true };
  }

  async remove(lessonId: string, actor: { id: string; role: UserRole }) {
    const lesson = await this.requireLesson(lessonId);
    await this.access.assertCanManageCourse(actor.id, actor.role, lesson.courseId, 'content');
    // Platform-wide switch, on top of the per-course assignment above.
    await this.access.assertTeacherCapability(actor.role, 'deleteLectures');

    const watched = await this.prisma.watchProgress.count({ where: { lessonId } });
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.lesson.update({
        where: { id: lessonId },
        data: { deletedAt: now, status: ContentStatus.ARCHIVED },
      });

      // The video row is retained: watch events reference it, and the object
      // storage cleanup is a separate, auditable job.
      await tx.video.updateMany({
        where: { lessonId },
        data: { status: VideoStatus.ARCHIVED },
      });

      await tx.$executeRaw`
        UPDATE lessons SET "sortOrder" = "sortOrder" - 1
        WHERE "sectionId" = ${lesson.sectionId}
          AND "sortOrder" > ${lesson.sortOrder}
          AND "deletedAt" IS NULL
      `;
    });

    await this.courses.recountCourse(lesson.courseId);

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.DELETE,
      entity: 'lesson',
      entityId: lessonId,
      note: `Soft-deleted; ${watched} watch records preserved`,
    });

    return { ok: true, preservedWatchRecords: watched };
  }

  private async requireLesson(lessonId: string) {
    const lesson = await this.prisma.lesson.findFirst({
      where: { id: lessonId, ...notDeleted },
    });
    if (!lesson) throw AppException.notFound('Lesson', lessonId);
    return lesson;
  }
}
