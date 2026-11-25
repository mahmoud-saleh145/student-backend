import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, ContentStatus, Prisma, UserRole } from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthenticatedUser } from '../../common/types/request-context';
import type { PlaybackConfig } from '../../config/configuration';
import { PrismaService } from '../../database/prisma.service';
import { type AuditEntry, AuditService } from '../audit/audit.service';
import { CourseAccessService } from '../courses/course-access.service';

import {
  type AllowanceRow,
  MAX_CUSTOM_ALLOWED_PLAYS,
  effectiveLimit,
  lockPlayCounter,
} from './watch-limit-rules';

export const WATCH_LIMIT_ACTIONS = ['ADD_PLAYS', 'SET_REMAINING', 'RESET_USED', 'RESTORE_DEFAULT'] as const;
export type WatchLimitAction = (typeof WATCH_LIMIT_ACTIONS)[number];

/**
 *  AVAILABLE         — two or more plays left
 *  NEARLY_EXHAUSTED  — exactly one play left
 *  EXHAUSTED         — none left; the next play is refused
 *  UNLIMITED         — a free preview lecture, never counted
 *  NO_ACCESS         — the student's enrolment does not open this lecture
 */
export type WatchLimitStatus = 'AVAILABLE' | 'NEARLY_EXHAUSTED' | 'EXHAUSTED' | 'UNLIMITED' | 'NO_ACCESS';

/** Largest single "add" or "set remaining" an administrator may apply. */
export const MAX_ADJUSTMENT = 100;
/** Cap on how many per-pair snapshots one audit row carries. */
const AUDIT_PAIR_CAP = 2000;

interface CourseVideo {
  videoId: string;
  lessonId: string;
  title: string;
  titleAr: string | null;
  sectionId: string;
  sectionTitle: string;
  sectionTitleAr: string | null;
  isPreview: boolean;
  published: boolean;
  /** Other live courses this asset is also attached to. */
  sharedCourses: number;
}

interface PairSnapshot {
  allowedPlays: number;
  customLimit: boolean;
  usedPlays: number;
  remainingPlays: number;
  countFrom: string | null;
}

interface PairChange {
  videoId: string;
  changed: boolean;
  before: PairSnapshot;
  after: PairSnapshot;
}

interface CourseTarget {
  userId: string;
  videoId: string;
  plays: number;
  allowedPlays: number | null;
  countFrom: Date | null;
}

interface CourseSummary {
  enrolledStudents: number;
  courseVideos: number;
  sharedVideos: number;
  affectedStudents: number;
  affectedVideos: number;
  affectedPlayRecords: number;
  customLimitsRestored: number;
}

interface Usage {
  used: number;
  lifetime: number;
}

export interface StudentVideoRow {
  videoId: string;
  lessonId: string;
  title: string;
  titleAr: string | null;
  sectionId: string;
  sectionTitle: string;
  sectionTitleAr: string | null;
  isPreview: boolean;
  accessible: boolean;
  defaultLimit: number;
  /** Effective ceiling: the custom limit, or the default. */
  allowedPlays: number;
  customLimit: boolean;
  /** Counted plays inside the current counting window. */
  usedPlays: number;
  remainingPlays: number;
  /** Counted plays ever, including those before an admin reset. Analytics only. */
  lifetimePlays: number;
  countFrom: string | null;
  status: WatchLimitStatus;
  /** Other live courses that use this same video. Non-zero = read-only here. */
  sharedCourses: number;
}

@Injectable()
export class WatchLimitsService {
  private readonly cfg: PlaybackConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CourseAccessService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.cfg = config.getOrThrow<PlaybackConfig>('playback');
  }

  private get defaultLimit(): number {
    return this.cfg.maxPlaysPerVideo;
  }

  private get minSeconds(): number {
    return this.cfg.minCountedPlaySeconds;
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  async studentOverview(courseId: string, userId: string) {
    const course = await this.requireCourse(courseId);
    const student = await this.requireEnrolledStudent(courseId, userId);
    const rows = await this.studentRows(courseId, userId);

    const counted = rows.filter((row) => row.accessible);
    return {
      student: { id: student.id, fullName: student.fullName, phone: student.phone },
      course: { id: course.id, title: course.title, titleAr: course.titleAr },
      defaultLimit: this.defaultLimit,
      summary: {
        totalVideos: rows.length,
        accessibleVideos: counted.length,
        watchedVideos: counted.filter((row) => row.lifetimePlays > 0).length,
        exhaustedVideos: counted.filter((row) => row.status === 'EXHAUSTED').length,
        customLimits: rows.filter((row) => row.customLimit).length,
        sharedVideos: rows.filter((row) => row.sharedCourses > 0).length,
      },
      videos: rows,
    };
  }

  // ---------------------------------------------------------------------------
  // Per-student changes
  // ---------------------------------------------------------------------------

  async applyToVideo(
    actor: AuthenticatedUser,
    courseId: string,
    userId: string,
    videoId: string,
    action: WatchLimitAction,
    amount: number | undefined,
  ) {
    this.validateAmount(action, amount);
    await this.requireCourse(courseId);
    await this.requireEnrolledStudent(courseId, userId);
    const rows = await this.studentRows(courseId, userId);
    const row = rows.find((candidate) => candidate.videoId === videoId);
    if (!row) {
      throw new AppException(ErrorCode.NOT_FOUND, { message: 'This video is not part of this course' });
    }
    this.assertAdjustable(row);

    const changes = await this.applyPairs(actor, userId, [videoId], action, amount, (changes) => ({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.UPDATE,
      entity: 'watch_limit',
      entityId: userId,
      note: `WATCH_LIMIT_${action}`,
      before: { pairs: changes.map((change) => ({ videoId: change.videoId, ...change.before })) },
      after: {
        actionType: `WATCH_LIMIT_${action}`,
        adminId: actor.id,
        studentId: userId,
        courseId,
        videoId,
        amount: amount ?? null,
        affectedRecords: changes.filter((change) => change.changed).length,
        pairs: changes.map((change) => ({ videoId: change.videoId, ...change.after })),
        at: new Date().toISOString(),
      },
    }));

    const updated = (await this.studentRows(courseId, userId)).find((candidate) => candidate.videoId === videoId);
    return { video: updated, affected: changes.filter((change) => change.changed).length };
  }

  async applyToStudent(
    actor: AuthenticatedUser,
    courseId: string,
    userId: string,
    action: WatchLimitAction,
    amount: number | undefined,
  ) {
    this.validateAmount(action, amount);
    await this.requireCourse(courseId);
    await this.requireEnrolledStudent(courseId, userId);
    const rows = await this.studentRows(courseId, userId);
    // Shared videos are never changed in bulk: see sharedElsewhereSql.
    const targets = rows
      .filter((row) => row.accessible && !row.isPreview && row.sharedCourses === 0)
      .map((row) => row.videoId);

    const describe = (changes: PairChange[]): AuditEntry => {
      const affected = changes.filter((change) => change.changed);
      return {
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.UPDATE,
      entity: 'watch_limit',
      entityId: userId,
      note: `WATCH_LIMIT_STUDENT_${action}`,
      before: { pairs: affected.slice(0, AUDIT_PAIR_CAP).map((change) => ({ videoId: change.videoId, ...change.before })) },
      after: {
        actionType: `WATCH_LIMIT_STUDENT_${action}`,
        adminId: actor.id,
        studentId: userId,
        courseId,
        videoId: null,
        amount: amount ?? null,
        targetVideos: targets.length,
        affectedRecords: affected.length,
        pairs: affected.slice(0, AUDIT_PAIR_CAP).map((change) => ({ videoId: change.videoId, ...change.after })),
        truncated: affected.length > AUDIT_PAIR_CAP,
        at: new Date().toISOString(),
      },
      };
    };

    // Nothing to change still leaves a trace of who asked.
    const changes = targets.length
      ? await this.applyPairs(actor, userId, targets, action, amount, describe)
      : (await this.audit.record(describe([])), []);
    return { targetVideos: targets.length, affectedVideos: changes.filter((change) => change.changed).length };
  }

  /**
   * Reads, recomputes and writes every pair under its counter lock, in one
   * transaction. Locks are taken in a fixed order so two bulk requests for the
   * same student cannot deadlock each other.
   */
  private async applyPairs(
    actor: AuthenticatedUser,
    userId: string,
    videoIds: string[],
    action: WatchLimitAction,
    amount: number | undefined,
    describe: (changes: PairChange[]) => AuditEntry,
  ): Promise<PairChange[]> {
    const ordered = [...new Set(videoIds)].sort();
    return this.prisma.$transaction(
      async (tx) => {
        for (const videoId of ordered) await lockPlayCounter(tx, userId, videoId);

        const allowances = new Map(
          (
            await tx.videoPlayAllowance.findMany({
              where: { userId, videoId: { in: ordered } },
              select: { videoId: true, allowedPlays: true, countFrom: true },
            })
          ).map((row) => [row.videoId, { allowedPlays: row.allowedPlays, countFrom: row.countFrom }]),
        );
        const usage = await this.usageFor(tx, userId, ordered);
        const now = new Date();

        const results: PairChange[] = [];

        for (const videoId of ordered) {
          const current: AllowanceRow = allowances.get(videoId) ?? { allowedPlays: null, countFrom: null };
          const used = usage.get(videoId)?.used ?? 0;
          const next = this.nextAllowance(action, amount, current, used, now);
          const nextUsed = next.countFrom !== current.countFrom ? 0 : used;

          const before = this.snapshot(current, used);
          const after = this.snapshot(next, nextUsed);
          const changed =
            before.allowedPlays !== after.allowedPlays ||
            before.customLimit !== after.customLimit ||
            before.usedPlays !== after.usedPlays;

          if (changed) {
            if (next.allowedPlays === null && next.countFrom === null) {
              await tx.videoPlayAllowance.deleteMany({ where: { userId, videoId } });
            } else {
              await tx.videoPlayAllowance.upsert({
                where: { userId_videoId: { userId, videoId } },
                create: { userId, videoId, ...next, updatedById: actor.id },
                update: { ...next, updatedById: actor.id },
              });
            }
          }
          results.push({ videoId, changed, before, after });
        }
        // Same transaction: the change is committed only together with its
        // audit row.
        await this.audit.recordTx(tx, describe(results));
        return results;
      },
      { timeout: 60_000 },
    );
  }

  /**
   * The four actions, stated once.
   *
   *   ADD_PLAYS n       remaining goes up by exactly n. If the student is
   *                     already over a lowered limit the ceiling is first
   *                     raised to what they used, so "add 2" always means two
   *                     more plays, never fewer.
   *   SET_REMAINING n   ceiling = used + n, so exactly n plays are left.
   *   RESET_USED        the counting window restarts now; the ceiling (custom
   *                     or default) is kept. History is not deleted.
   *   RESTORE_DEFAULT   the custom ceiling is dropped; consumption is kept.
   */
  private nextAllowance(
    action: WatchLimitAction,
    amount: number | undefined,
    current: AllowanceRow,
    used: number,
    now: Date,
  ): AllowanceRow {
    const ceiling = effectiveLimit(current, this.defaultLimit);
    let next: AllowanceRow;
    switch (action) {
      case 'ADD_PLAYS':
        next = { allowedPlays: Math.max(ceiling, used) + (amount ?? 0), countFrom: current.countFrom };
        break;
      case 'SET_REMAINING':
        next = { allowedPlays: used + (amount ?? 0), countFrom: current.countFrom };
        break;
      case 'RESET_USED':
        // Idempotent: nothing to restart when nothing is counted.
        next = used > 0 ? { allowedPlays: current.allowedPlays, countFrom: now } : { ...current };
        break;
      case 'RESTORE_DEFAULT':
        next = { allowedPlays: null, countFrom: current.countFrom };
        break;
    }
    // A custom ceiling equal to the default is stored as "default" so a later
    // change of the global setting still reaches this student.
    if (next.allowedPlays === this.defaultLimit) next.allowedPlays = null;
    if (next.allowedPlays !== null && next.allowedPlays > MAX_CUSTOM_ALLOWED_PLAYS) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, {
        message: `A video cannot allow more than ${MAX_CUSTOM_ALLOWED_PLAYS} plays`,
      });
    }
    return next;
  }

  private snapshot(allowance: AllowanceRow, used: number) {
    const allowedPlays = effectiveLimit(allowance, this.defaultLimit);
    return {
      allowedPlays,
      customLimit: allowance.allowedPlays !== null,
      usedPlays: used,
      remainingPlays: Math.max(0, allowedPlays - used),
      countFrom: allowance.countFrom ? allowance.countFrom.toISOString() : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Course-wide reset
  // ---------------------------------------------------------------------------

  async courseResetPreview(courseId: string, restoreDefault: boolean) {
    const course = await this.requireCourse(courseId);
    const preview = await this.courseTargets(this.prisma, courseId, restoreDefault);
    return {
      course: { id: course.id, title: course.title, titleAr: course.titleAr },
      restoreDefault,
      ...preview.summary,
    };
  }

  async resetCourse(actor: AuthenticatedUser, courseId: string, restoreDefault: boolean) {
    const course = await this.requireCourse(courseId);
    const now = new Date();
    // Columns are UTC `timestamp(3)` (Prisma's convention). Passed as a UTC
    // literal so the database session's time zone cannot shift it.
    const stamp = now.toISOString().replace('T', ' ').replace('Z', '');

    const outcome = await this.prisma
      .$transaction(
        async (tx) => {
          const { summary, targets } = await this.courseTargets(tx, courseId, restoreDefault);
          if (targets.length === 0) {
            await this.audit.recordTx(tx, this.courseResetAudit(actor, courseId, restoreDefault, now, summary, targets));
            return { summary, targets };
          }

          // One statement for the whole course. `targets` is recomputed inside
          // the INSERT from the same snapshot (REPEATABLE READ), so what is
          // written is exactly what was counted above.
          await tx.$executeRaw`
            INSERT INTO video_play_allowances ("userId", "videoId", "allowedPlays", "countFrom", "updatedById", "createdAt", "updatedAt")
            SELECT t."userId", t."videoId", NULL,
                   CASE WHEN t.plays > 0 THEN ${stamp}::timestamp(3) ELSE NULL END,
                   ${actor.id}, ${stamp}::timestamp(3), ${stamp}::timestamp(3)
            FROM (${this.courseTargetsSql(courseId, restoreDefault)}) t
            ON CONFLICT ("userId", "videoId") DO UPDATE SET
              "countFrom" = COALESCE(EXCLUDED."countFrom", video_play_allowances."countFrom"),
              "allowedPlays" = CASE WHEN ${restoreDefault} THEN NULL ELSE video_play_allowances."allowedPlays" END,
              "updatedById" = EXCLUDED."updatedById",
              "updatedAt" = EXCLUDED."updatedAt"`;
          await this.audit.recordTx(tx, this.courseResetAudit(actor, courseId, restoreDefault, now, summary, targets));
          return { summary, targets };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000 },
      )
      .catch((error: unknown) => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
          throw new AppException(ErrorCode.CONFLICT, {
            message: 'Another change to these watch limits landed at the same moment. Nothing was changed; please try again.',
          });
        }
        throw error;
      });


    return {
      course: { id: course.id, title: course.title, titleAr: course.titleAr },
      restoreDefault,
      executedAt: now.toISOString(),
      ...outcome.summary,
    };
  }

  private courseResetAudit(
    actor: AuthenticatedUser,
    courseId: string,
    restoreDefault: boolean,
    now: Date,
    summary: CourseSummary,
    targets: CourseTarget[],
  ): AuditEntry {
    return {
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.UPDATE,
      entity: 'watch_limit',
      entityId: courseId,
      note: restoreDefault ? 'WATCH_LIMIT_COURSE_RESET_AND_RESTORE_DEFAULT' : 'WATCH_LIMIT_COURSE_RESET',
      before: {
        pairs: targets.slice(0, AUDIT_PAIR_CAP).map((target) => ({
          studentId: target.userId,
          videoId: target.videoId,
          usedPlays: target.plays,
          customAllowedPlays: target.allowedPlays,
          countFrom: target.countFrom ? target.countFrom.toISOString() : null,
        })),
      },
      after: {
        actionType: restoreDefault ? 'WATCH_LIMIT_COURSE_RESET_AND_RESTORE_DEFAULT' : 'WATCH_LIMIT_COURSE_RESET',
        adminId: actor.id,
        studentId: null,
        courseId,
        videoId: null,
        usedPlays: 0,
        countFrom: now.toISOString(),
        restoreDefault,
        affectedRecords: summary.affectedPlayRecords,
        affectedPairs: targets.length,
        affectedStudents: summary.affectedStudents,
        affectedVideos: summary.affectedVideos,
        truncated: targets.length > AUDIT_PAIR_CAP,
        at: now.toISOString(),
      },
    };
  }

  /**
   * Every (student, video) pair a course-wide reset touches:
   *   - students: anyone with an enrolment row on THIS course, any state;
   *   - videos: assets attached to a live, non-preview lecture of THIS course;
   *   - pairs: those with counted plays in the current window, plus (only when
   *     restoring the default) those carrying a custom limit.
   */
  /**
   * True for a video that is also attached to a live lecture of ANOTHER course.
   * Its play counter is per video, not per course, so any change made from
   * this course would also change what the student has left in the other one.
   * Such videos are excluded from every watch-limit write (release gate,
   * 2026-11-25): a cross-course change must never happen silently.
   */
  private sharedElsewhereSql(courseId: string, videoColumn: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`EXISTS (
      SELECT 1 FROM lesson_videos lvx
      JOIN lessons lx ON lx.id = lvx."lessonId"
      JOIN courses cx ON cx.id = lx."courseId"
      WHERE lvx."videoId" = ${videoColumn} AND lx."courseId" <> ${courseId}
        AND lx."deletedAt" IS NULL AND cx."deletedAt" IS NULL
    )`;
  }

  private courseTargetsSql(courseId: string, restoreDefault: boolean): Prisma.Sql {
    return Prisma.sql`
      WITH cv AS (
        SELECT DISTINCT lv."videoId"
        FROM lesson_videos lv
        JOIN lessons l ON l.id = lv."lessonId"
        JOIN course_sections s ON s.id = l."sectionId"
        JOIN videos v ON v.id = lv."videoId"
        WHERE l."courseId" = ${courseId} AND l."deletedAt" IS NULL AND s."deletedAt" IS NULL
          AND v."deletedAt" IS NULL AND l."isPreview" = false
          AND NOT ${this.sharedElsewhereSql(courseId, Prisma.sql`lv."videoId"`)}
      ),
      st AS (
        SELECT DISTINCT e."userId" FROM enrollments e JOIN users u ON u.id = e."userId"
        WHERE e."courseId" = ${courseId} AND u.role = 'STUDENT'
      ),
      used AS (
        SELECT vp."userId", vp."videoId", count(*)::int AS plays
        FROM video_plays vp
        JOIN cv ON cv."videoId" = vp."videoId"
        JOIN st ON st."userId" = vp."userId"
        LEFT JOIN video_play_allowances a ON a."userId" = vp."userId" AND a."videoId" = vp."videoId"
        WHERE (vp."closedAt" IS NULL OR vp."watchedSeconds" >= ${this.minSeconds})
          AND (a."countFrom" IS NULL OR vp."startedAt" >= a."countFrom")
        GROUP BY vp."userId", vp."videoId"
      ),
      custom AS (
        SELECT a."userId", a."videoId"
        FROM video_play_allowances a
        JOIN cv ON cv."videoId" = a."videoId"
        JOIN st ON st."userId" = a."userId"
        WHERE a."allowedPlays" IS NOT NULL AND ${restoreDefault}
      )
      SELECT COALESCE(u."userId", c."userId") AS "userId",
             COALESCE(u."videoId", c."videoId") AS "videoId",
             COALESCE(u.plays, 0)::int AS plays
      FROM used u FULL OUTER JOIN custom c ON c."userId" = u."userId" AND c."videoId" = u."videoId"`;
  }

  private async courseTargets(
    db: Prisma.TransactionClient,
    courseId: string,
    restoreDefault: boolean,
  ): Promise<{ targets: CourseTarget[]; summary: CourseSummary }> {
    const targets = await db.$queryRaw<CourseTarget[]>`
      SELECT t."userId", t."videoId", t.plays, a."allowedPlays", a."countFrom"
      FROM (${this.courseTargetsSql(courseId, restoreDefault)}) t
      LEFT JOIN video_play_allowances a ON a."userId" = t."userId" AND a."videoId" = t."videoId"
      ORDER BY t."userId", t."videoId"`;

    const [counts] = await db.$queryRaw<Array<{ enrolled: number; videos: number; shared: number }>>`
      WITH cv AS (
        SELECT DISTINCT lv."videoId"
        FROM lesson_videos lv
        JOIN lessons l ON l.id = lv."lessonId"
        JOIN course_sections s ON s.id = l."sectionId"
        JOIN videos v ON v.id = lv."videoId"
        WHERE l."courseId" = ${courseId} AND l."deletedAt" IS NULL AND s."deletedAt" IS NULL
          AND v."deletedAt" IS NULL AND l."isPreview" = false
      )
      SELECT
        (SELECT count(DISTINCT e."userId")::int FROM enrollments e JOIN users u ON u.id = e."userId"
          WHERE e."courseId" = ${courseId} AND u.role = 'STUDENT') AS enrolled,
        (SELECT count(*)::int FROM cv) AS videos,
        (SELECT count(*)::int FROM cv WHERE ${this.sharedElsewhereSql(courseId, Prisma.sql`cv."videoId"`)}) AS shared`;

    return {
      targets,
      summary: {
        enrolledStudents: counts?.enrolled ?? 0,
        courseVideos: counts?.videos ?? 0,
        sharedVideos: counts?.shared ?? 0,
        affectedStudents: new Set(targets.filter((t) => t.plays > 0).map((t) => t.userId)).size,
        affectedVideos: new Set(targets.filter((t) => t.plays > 0).map((t) => t.videoId)).size,
        affectedPlayRecords: targets.reduce((sum, t) => sum + t.plays, 0),
        customLimitsRestored: restoreDefault ? targets.filter((t) => t.allowedPlays !== null).length : 0,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private validateAmount(action: WatchLimitAction, amount: number | undefined) {
    const needsAmount = action === 'ADD_PLAYS' || action === 'SET_REMAINING';
    if (!needsAmount) return;
    const min = action === 'ADD_PLAYS' ? 1 : 0;
    if (amount === undefined || !Number.isInteger(amount) || amount < min || amount > MAX_ADJUSTMENT) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, {
        message: `amount must be a whole number from ${min} to ${MAX_ADJUSTMENT}`,
        fields: { amount: [`must be ${min}–${MAX_ADJUSTMENT}`] },
      });
    }
  }

  private assertAdjustable(row: StudentVideoRow) {
    if (row.isPreview) {
      throw new AppException(ErrorCode.CONFLICT, {
        message: 'Free preview lectures are not counted, so they have no watch limit to change',
      });
    }
    if (!row.accessible) {
      throw new AppException(ErrorCode.CONFLICT, {
        message: "This video is outside the student's access in this course",
      });
    }
    if (row.sharedCourses > 0) {
      throw new AppException(ErrorCode.CONFLICT, {
        message: `This video is also used in ${row.sharedCourses} other course(s). Its play count is shared, so it cannot be changed from one course.`,
        details: { reason: 'SHARED_VIDEO', sharedCourses: row.sharedCourses },
      });
    }
  }

  private async requireCourse(courseId: string) {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, deletedAt: null },
      select: { id: true, title: true, titleAr: true },
    });
    if (!course) throw new AppException(ErrorCode.NOT_FOUND, { message: 'Course not found' });
    return course;
  }

  private async requireEnrolledStudent(courseId: string, userId: string) {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { userId_courseId: { userId, courseId } },
      select: { user: { select: { id: true, fullName: true, phone: true, role: true } } },
    });
    if (!enrollment || enrollment.user.role !== UserRole.STUDENT) {
      throw new AppException(ErrorCode.NOT_FOUND, { message: 'This student is not enrolled in this course' });
    }
    return enrollment.user;
  }

  /** Every video of the course, one row per asset, in curriculum order. */
  private async courseVideos(courseId: string): Promise<CourseVideo[]> {
    const links = await this.prisma.lessonVideo.findMany({
      where: {
        lesson: { courseId, deletedAt: null, section: { deletedAt: null } },
        video: { deletedAt: null },
      },
      select: {
        videoId: true,
        lesson: {
          select: {
            id: true,
            title: true,
            titleAr: true,
            isPreview: true,
            status: true,
            sortOrder: true,
            section: { select: { id: true, title: true, titleAr: true, sortOrder: true, status: true } },
          },
        },
      },
    });

    links.sort(
      (a, b) =>
        a.lesson.section.sortOrder - b.lesson.section.sortOrder || a.lesson.sortOrder - b.lesson.sortOrder,
    );

    // An asset attached to two lectures of the same course is one counter. A
    // non-preview attachment wins, because that is the one that is counted.
    const byVideo = new Map<string, CourseVideo>();
    for (const link of links) {
      const existing = byVideo.get(link.videoId);
      if (existing && (existing.isPreview === false || link.lesson.isPreview)) continue;
      byVideo.set(link.videoId, {
        videoId: link.videoId,
        lessonId: link.lesson.id,
        title: link.lesson.title,
        titleAr: link.lesson.titleAr,
        sectionId: link.lesson.section.id,
        sectionTitle: link.lesson.section.title,
        sectionTitleAr: link.lesson.section.titleAr,
        isPreview: link.lesson.isPreview,
        sharedCourses: 0,
        published:
          link.lesson.status === ContentStatus.PUBLISHED && link.lesson.section.status === ContentStatus.PUBLISHED,
      });
    }
    // Which of these assets are also attached to a live lecture elsewhere.
    const ids = [...byVideo.keys()];
    const elsewhere = ids.length
      ? await this.prisma.$queryRaw<Array<{ videoId: string; courses: number }>>`
          SELECT lv."videoId", count(DISTINCT l."courseId")::int AS courses
          FROM lesson_videos lv
          JOIN lessons l ON l.id = lv."lessonId"
          JOIN courses c ON c.id = l."courseId"
          WHERE lv."videoId" = ANY(${ids}::text[]) AND l."courseId" <> ${courseId}
            AND l."deletedAt" IS NULL AND c."deletedAt" IS NULL
          GROUP BY lv."videoId"`
      : [];
    for (const row of elsewhere) byVideo.get(row.videoId)!.sharedCourses = row.courses;
    return [...byVideo.values()];
  }

  private async usageFor(db: Prisma.TransactionClient, userId: string, videoIds: string[]) {
    if (videoIds.length === 0) return new Map<string, Usage>();
    const rows = await db.$queryRaw<Array<{ videoId: string; used: number; lifetime: number }>>`
      SELECT vp."videoId",
        count(*) FILTER (WHERE (vp."closedAt" IS NULL OR vp."watchedSeconds" >= ${this.minSeconds})
                           AND (a."countFrom" IS NULL OR vp."startedAt" >= a."countFrom"))::int AS used,
        count(*) FILTER (WHERE vp."closedAt" IS NULL OR vp."watchedSeconds" >= ${this.minSeconds})::int AS lifetime
      FROM video_plays vp
      LEFT JOIN video_play_allowances a ON a."userId" = vp."userId" AND a."videoId" = vp."videoId"
      WHERE vp."userId" = ${userId} AND vp."videoId" = ANY(${videoIds}::text[])
      GROUP BY vp."videoId"`;
    return new Map(rows.map((row) => [row.videoId, { used: row.used, lifetime: row.lifetime }]));
  }

  private async studentRows(courseId: string, userId: string): Promise<StudentVideoRow[]> {
    const videos = await this.courseVideos(courseId);
    const ids = videos.map((video) => video.videoId);

    const [decision, coverage, allowances, usage] = await Promise.all([
      this.access.resolve({ userId, role: UserRole.STUDENT, courseId }),
      this.access.sectionCoverage(this.prisma, userId, courseId),
      this.prisma.videoPlayAllowance.findMany({
        where: { userId, videoId: { in: ids } },
        select: { videoId: true, allowedPlays: true, countFrom: true },
      }),
      this.usageFor(this.prisma, userId, ids),
    ]);
    const allowanceByVideo = new Map(allowances.map((row) => [row.videoId, row]));

    return videos.map((video) => {
      const allowance = allowanceByVideo.get(video.videoId) ?? null;
      const allowedPlays = effectiveLimit(allowance, this.defaultLimit);
      const used = usage.get(video.videoId)?.used ?? 0;
      const remaining = Math.max(0, allowedPlays - used);
      const sectionOpen = coverage === null || coverage.includes(video.sectionId);
      const accessible = video.published && (video.isPreview || (decision.canAccessContent && sectionOpen));

      let status: WatchLimitStatus;
      if (!accessible) status = 'NO_ACCESS';
      else if (video.isPreview) status = 'UNLIMITED';
      else if (remaining === 0) status = 'EXHAUSTED';
      else if (remaining === 1) status = 'NEARLY_EXHAUSTED';
      else status = 'AVAILABLE';

      const { published: _published, ...lecture } = video;
      return {
        ...lecture,
        accessible,
        defaultLimit: this.defaultLimit,
        allowedPlays,
        customLimit: allowance?.allowedPlays != null,
        usedPlays: used,
        remainingPlays: remaining,
        lifetimePlays: usage.get(video.videoId)?.lifetime ?? 0,
        countFrom: allowance?.countFrom ? allowance.countFrom.toISOString() : null,
        status,
      };
    });
  }
}
