import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { WatchEventType } from '@prisma/client';
import type { Job } from 'bullmq';

import { PrismaService } from '../../database/prisma.service';
import { ANALYTICS_JOBS, QUEUE_NAMES, type AnalyticsJobData } from '../queue.constants';

/**
 * Nightly analytics rollup.
 *
 * watch_events grows by millions of rows a term. Dashboards must never scan
 * it, so this job folds one day at a time into daily_course_stats, which every
 * report reads instead.
 *
 * The rollup is idempotent (upsert keyed on course+day), so re-running it for
 * a past day corrects the numbers rather than double-counting.
 */
@Processor(QUEUE_NAMES.analytics, { concurrency: 1 })
export class AnalyticsProcessor extends WorkerHost {
  private readonly logger = new Logger(AnalyticsProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<AnalyticsJobData>): Promise<unknown> {
    if (job.name !== ANALYTICS_JOBS.rollupDaily) return null;

    const day = job.data.day ? new Date(job.data.day) : this.yesterday();
    const dayStart = new Date(
      Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()),
    );
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);

    this.logger.log(`rolling up ${dayStart.toISOString().slice(0, 10)}`);

    // Aggregate in SQL: pulling a day of events into Node would move
    // hundreds of megabytes for a handful of numbers.
    const rows = await this.prisma.$queryRaw<
      {
        courseId: string;
        uniqueViewers: bigint;
        watchSeconds: bigint;
        lessonsStarted: bigint;
        lessonsCompleted: bigint;
      }[]
    >`
      SELECT
        "courseId",
        COUNT(DISTINCT "userId")                                    AS "uniqueViewers",
        COALESCE(SUM("deltaSeconds"), 0)                            AS "watchSeconds",
        COUNT(*) FILTER (WHERE "type" = ${WatchEventType.STARTED}::"WatchEventType")   AS "lessonsStarted",
        COUNT(*) FILTER (WHERE "type" = ${WatchEventType.COMPLETED}::"WatchEventType") AS "lessonsCompleted"
      FROM watch_events
      WHERE "occurredAt" >= ${dayStart} AND "occurredAt" < ${dayEnd}
      GROUP BY "courseId"
    `;

    const enrollmentRows = await this.prisma.$queryRaw<
      { courseId: string; newEnrollments: bigint }[]
    >`
      SELECT "courseId", COUNT(*) AS "newEnrollments"
      FROM enrollments
      WHERE "createdAt" >= ${dayStart} AND "createdAt" < ${dayEnd}
      GROUP BY "courseId"
    `;

    const revenueRows = await this.prisma.$queryRaw<
      { courseId: string; revenue: string; currency: string }[]
    >`
      SELECT "courseId", COALESCE(SUM("grossAmount"), 0)::text AS revenue, MAX(currency) AS currency
      FROM revenue_ledger
      WHERE "recognizedAt" >= ${dayStart} AND "recognizedAt" < ${dayEnd}
      GROUP BY "courseId"
    `;

    const enrollmentsByCourse = new Map(
      enrollmentRows.map((r) => [r.courseId, Number(r.newEnrollments)]),
    );
    const revenueByCourse = new Map(
      revenueRows.map((r) => [r.courseId, { amount: Number(r.revenue), currency: r.currency }]),
    );

    const courseIds = new Set([
      ...rows.map((r) => r.courseId),
      ...enrollmentsByCourse.keys(),
      ...revenueByCourse.keys(),
    ]);

    let written = 0;

    for (const courseId of courseIds) {
      const stat = rows.find((r) => r.courseId === courseId);
      const revenue = revenueByCourse.get(courseId);

      await this.prisma.dailyCourseStat.upsert({
        where: { courseId_day: { courseId, day: dayStart } },
        create: {
          courseId,
          day: dayStart,
          uniqueViewers: Number(stat?.uniqueViewers ?? 0),
          watchSeconds: Number(stat?.watchSeconds ?? 0),
          lessonsStarted: Number(stat?.lessonsStarted ?? 0),
          lessonsCompleted: Number(stat?.lessonsCompleted ?? 0),
          newEnrollments: enrollmentsByCourse.get(courseId) ?? 0,
          revenueAmount: revenue?.amount ?? 0,
          currency: revenue?.currency ?? 'EGP',
        },
        update: {
          uniqueViewers: Number(stat?.uniqueViewers ?? 0),
          watchSeconds: Number(stat?.watchSeconds ?? 0),
          lessonsStarted: Number(stat?.lessonsStarted ?? 0),
          lessonsCompleted: Number(stat?.lessonsCompleted ?? 0),
          newEnrollments: enrollmentsByCourse.get(courseId) ?? 0,
          revenueAmount: revenue?.amount ?? 0,
        },
      });

      written += 1;
    }

    this.logger.log(`rollup wrote ${written} course-day row(s)`);
    return { day: dayStart.toISOString().slice(0, 10), courses: written };
  }

  private yesterday(): Date {
    return new Date(Date.now() - 24 * 3600 * 1000);
  }
}
