import { Injectable } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';

import { PrismaService, notDeleted } from '../../database/prisma.service';
import { CourseAccessService } from '../courses/course-access.service';

/**
 * Reporting.
 *
 * Every money figure comes from `revenue_ledger`, never from a course's
 * current price. That is the whole point of the ledger: a course repriced
 * from 100 to 150 must still report its historical sales at 100 (spec §28).
 *
 * Time-series reads hit `daily_course_stats`, the nightly rollup, rather than
 * scanning `watch_events` — which grows by millions of rows a term.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CourseAccessService,
  ) { }

  /** Platform-wide numbers for the master/admin dashboard. */
  async overview(params: { from?: Date; to?: Date }) {
    const from = params.from ?? new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const to = params.to ?? new Date();

    const [
      students,
      activeStudents,
      teachers,
      publishedCourses,
      enrollments,
      revenue,
      refunds,
      watchAggregate,
    ] = await this.prisma.$transaction([
      this.prisma.user.count({ where: { role: UserRole.STUDENT, ...notDeleted } }),
      this.prisma.user.count({
        where: {
          role: UserRole.STUDENT,
          ...notDeleted,
          sessions: { some: { lastSeenAt: { gte: from } } },
        },
      }),
      this.prisma.user.count({ where: { role: UserRole.TEACHER, ...notDeleted } }),
      this.prisma.course.count({ where: { status: 'PUBLISHED', ...notDeleted } }),
      this.prisma.enrollment.count({
        where: { createdAt: { gte: from, lte: to } },
      }),
      this.prisma.revenueLedger.aggregate({
        where: { recognizedAt: { gte: from, lte: to }, grossAmount: { gt: 0 } },
        _sum: { grossAmount: true, platformAmount: true, teacherAmount: true },
        _count: { _all: true },
      }),
      this.prisma.revenueLedger.aggregate({
        where: { recognizedAt: { gte: from, lte: to }, grossAmount: { lt: 0 } },
        _sum: { grossAmount: true },
      }),
      this.prisma.dailyCourseStat.aggregate({
        where: { day: { gte: from, lte: to } },
        _sum: { watchSeconds: true, uniqueViewers: true },
      }),
    ]);

    const gross = Number(revenue._sum.grossAmount ?? 0);
    const refunded = Math.abs(Number(refunds._sum.grossAmount ?? 0));

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      users: { students, activeStudents, teachers },
      catalogue: { publishedCourses },
      enrollments,
      revenue: {
        gross,
        refunded,
        net: Math.round((gross - refunded) * 100) / 100,
        platform: Number(revenue._sum.platformAmount ?? 0),
        teachers: Number(revenue._sum.teacherAmount ?? 0),
        transactions: revenue._count._all,
      },
      engagement: {
        watchSeconds: watchAggregate._sum.watchSeconds ?? 0,
        viewerDays: watchAggregate._sum.uniqueViewers ?? 0,
      },
    };
  }

  /** One course's numbers. Teachers see only their own courses. */
  async course(params: {
    courseId: string;
    actorId: string;
    role: UserRole;
    from?: Date;
    to?: Date;
  }) {
    await this.access.assertCanManageCourse(
      params.actorId,
      params.role,
      params.courseId,
      'students',
    );

    const from = params.from ?? new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const to = params.to ?? new Date();

    const canSeeRevenue =
      params.role === UserRole.MASTER || params.role === UserRole.ADMIN
        ? true
        : await this.teacherMaySeeRevenue(params.actorId, params.courseId);

    const [course, enrollmentsByState, daily, completion] = await this.prisma.$transaction([
      this.prisma.course.findUnique({
        where: { id: params.courseId },
        select: { id: true, title: true, lessonCount: true, studentCount: true },
      }),
      this.prisma.enrollment.groupBy({
        by: ['state'],
        where: { courseId: params.courseId },
        _count: { _all: true },
        orderBy: { state: 'asc' },
      }),
      this.prisma.dailyCourseStat.findMany({
        where: { courseId: params.courseId, day: { gte: from, lte: to } },
        orderBy: { day: 'asc' },
      }),
      this.prisma.watchProgress.aggregate({
        where: { courseId: params.courseId },
        _avg: { percent: true },
        _count: { _all: true },
      }),
    ]);

    const revenue = canSeeRevenue
      ? await this.prisma.revenueLedger.aggregate({
        where: { courseId: params.courseId, recognizedAt: { gte: from, lte: to } },
        _sum: { grossAmount: true, teacherAmount: true, platformAmount: true },
        _count: { _all: true },
      })
      : null;

    return {
      course,
      period: { from: from.toISOString(), to: to.toISOString() },
      enrollments: Object.fromEntries(
        enrollmentsByState.map((row) => [
          row.state,
          typeof row._count === 'object' && row._count !== null
            ? row._count._all ?? 0
            : 0,
        ]),
      ),
      engagement: {
        averageProgressPercent: Math.round(completion._avg.percent ?? 0),
        trackedLessons: completion._count._all,
        daily: daily.map((d) => ({
          day: d.day.toISOString().slice(0, 10),
          uniqueViewers: d.uniqueViewers,
          watchSeconds: d.watchSeconds,
          lessonsStarted: d.lessonsStarted,
          lessonsCompleted: d.lessonsCompleted,
          newEnrollments: d.newEnrollments,
        })),
      },
      revenue: revenue
        ? {
          gross: Number(revenue._sum.grossAmount ?? 0),
          teacher: Number(revenue._sum.teacherAmount ?? 0),
          platform: Number(revenue._sum.platformAmount ?? 0),
          transactions: revenue._count._all,
        }
        : null,
    };
  }

  private async teacherMaySeeRevenue(teacherId: string, courseId: string): Promise<boolean> {
    const assignment = await this.prisma.courseTeacher.findUnique({
      where: { courseId_teacherId: { courseId, teacherId } },
      select: { canViewRevenue: true },
    });
    return assignment?.canViewRevenue ?? false;
  }

  /** A teacher's earnings across every course they are paid on. */
  async teacherEarnings(params: { teacherId: string; from?: Date; to?: Date }) {
    const from = params.from ?? new Date(Date.now() - 365 * 24 * 3600 * 1000);
    const to = params.to ?? new Date();

    const rows = await this.prisma.revenueLedger.groupBy({
      by: ['courseId', 'courseTitleSnapshot'],
      where: { teacherId: params.teacherId, recognizedAt: { gte: from, lte: to } },
      _sum: { teacherAmount: true, grossAmount: true },
      _count: { _all: true },
    });

    const total = rows.reduce((sum, r) => sum + Number(r._sum.teacherAmount ?? 0), 0);

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      total: Math.round(total * 100) / 100,
      // The snapshot title is used so an archived or renamed course still
      // reads correctly in an earnings statement.
      courses: rows.map((r) => ({
        courseId: r.courseId,
        title: r.courseTitleSnapshot,
        earnings: Number(r._sum.teacherAmount ?? 0),
        gross: Number(r._sum.grossAmount ?? 0),
        transactions: r._count._all,
      })),
    };
  }

  /** Revenue by day for charting. */
  async revenueSeries(params: { from: Date; to: Date; courseId?: string }) {
    // Composed with Prisma.sql fragments rather than string interpolation:
    // splicing `courseId` into the template directly would be an injection
    // hole, and Prisma cannot parameterise a conditional clause on its own.
    const courseFilter = params.courseId
      ? Prisma.sql`AND "courseId" = ${params.courseId}`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<
      { day: Date; gross: string; net: string; transactions: bigint }[]
    >(Prisma.sql`
      SELECT
        DATE("recognizedAt")                                                   AS day,
        COALESCE(SUM("grossAmount") FILTER (WHERE "grossAmount" > 0), 0)::text AS gross,
        COALESCE(SUM("grossAmount"), 0)::text                                  AS net,
        COUNT(*)                                                               AS transactions
      FROM revenue_ledger
      WHERE "recognizedAt" >= ${params.from}
        AND "recognizedAt" <= ${params.to}
        ${courseFilter}
      GROUP BY DATE("recognizedAt")
      ORDER BY day ASC
    `);

    return rows.map((r) => ({
      day: new Date(r.day).toISOString().slice(0, 10),
      gross: Number(r.gross),
      net: Number(r.net),
      transactions: Number(r.transactions),
    }));
  }
}
