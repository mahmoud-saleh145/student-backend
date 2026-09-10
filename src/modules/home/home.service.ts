import { Injectable } from '@nestjs/common';
import { EnrollmentState, NotificationKind } from '@prisma/client';

import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { CoursesService } from '../courses/courses.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ProgressService } from '../progress/progress.service';

/**
 * Home feed.
 *
 * One request builds the entire dashboard, because the alternative — six
 * parallel calls from a phone on a slow connection — is the single worst
 * first-launch experience a student can have.
 *
 * The shelves are ordered by what a returning student most likely wants:
 * resume what they were watching, then their courses, then discovery.
 */
@Injectable()
export class HomeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly courses: CoursesService,
    private readonly progress: ProgressService,
    private readonly notifications: NotificationsService,
    private readonly redis: RedisService,
  ) {}

  async feed(userId: string, locale: 'en' | 'ar') {
    const [continueWatching, mine, discovery, announcements, stats] = await Promise.all([
      this.progress.continueWatching(userId, 6),
      this.courses.listMine({ userId, page: 1, pageSize: 10 }),
      this.discovery(userId),
      this.announcements(userId, locale),
      this.stats(userId),
    ]);

    // "Recommended" is anything published the student has not joined, biased
    // toward their academic year. Deliberately not a black-box recommender:
    // with a catalogue this size, relevance comes from the academic filter,
    // and an unexplainable ordering would be worse than a predictable one.
    return {
      continueWatching,
      myCourses: mine.items,
      newCourses: discovery.newest,
      recommended: discovery.recommended,
      announcements,
      stats,
    };
  }

  private async discovery(userId: string) {
    const student = await this.prisma.studentProfile.findUnique({
      where: { userId },
      select: { universityId: true, academicYearId: true, facultyId: true },
    });

    const enrolled = await this.prisma.enrollment.findMany({
      where: { userId },
      select: { courseId: true },
    });
    const excluded = enrolled.map((e) => e.courseId);

    const [newest, recommended] = await Promise.all([
      this.courses.list({
        userId,
        page: 1,
        pageSize: 8,
        filters: { sort: 'newest' },
      }),
      this.courses.list({
        userId,
        page: 1,
        pageSize: 8,
        filters: {
          sort: 'popular',
          universityId: student?.universityId ?? undefined,
          academicYearId: student?.academicYearId ?? undefined,
        },
      }),
    ]);

    const notJoined = (items: unknown[]) =>
      (items as { id: string }[]).filter((c) => !excluded.includes(c.id));

    return {
      newest: notJoined(newest.items).slice(0, 6),
      recommended: notJoined(recommended.items).slice(0, 6),
    };
  }

  private async announcements(userId: string, locale: 'en' | 'ar') {
    const rows = await this.prisma.notification.findMany({
      where: { userId, kind: NotificationKind.ANNOUNCEMENT },
      orderBy: { createdAt: 'desc' },
      take: 3,
    });

    return rows.map((n) => ({
      id: n.id,
      kind: n.kind,
      title: locale === 'ar' && n.titleAr ? n.titleAr : n.title,
      body: locale === 'ar' && n.bodyAr ? n.bodyAr : n.body,
      read: n.read,
      createdAt: n.createdAt.toISOString(),
      route: n.route,
      imageUrl: n.imageUrl,
    }));
  }

  /**
   * Dashboard counters.
   *
   * Cached for two minutes: they are motivational, not transactional, and
   * recomputing three aggregates on every home-screen open is wasteful when
   * the numbers move slowly.
   */
  private async stats(userId: string) {
    return this.redis.remember(`home:stats:${userId}`, 120, async () => {
      const [enrolledCourses, completedLessons, watchAggregate] = await Promise.all([
        this.prisma.enrollment.count({
          where: { userId, state: EnrollmentState.ACTIVE },
        }),
        this.prisma.watchProgress.count({ where: { userId, completed: true } }),
        this.prisma.watchProgress.aggregate({
          where: { userId },
          _sum: { watchedSeconds: true },
        }),
      ]);

      return {
        enrolledCourses,
        completedLessons,
        watchTimeSeconds: watchAggregate._sum.watchedSeconds ?? 0,
        streakDays: await this.streak(userId),
      };
    });
  }

  /**
   * Consecutive days with any watch activity, counting back from today.
   *
   * Computed from distinct dates rather than a stored counter so it self-heals
   * — a missed cron or a backfilled event can never leave a wrong streak
   * frozen in the database.
   */
  private async streak(userId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ day: Date }[]>`
      SELECT DISTINCT DATE("lastWatchedAt") AS day
      FROM watch_progress
      WHERE "userId" = ${userId}
        AND "lastWatchedAt" >= NOW() - INTERVAL '60 days'
      ORDER BY day DESC
    `;

    if (rows.length === 0) return 0;

    const days = rows.map((r) => new Date(r.day).toISOString().slice(0, 10));
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    // A streak stays alive until the end of the following day, so watching at
    // 23:00 and again at 01:00 the next night does not break it.
    if (days[0] !== today && days[0] !== yesterday) return 0;

    let streak = 1;
    for (let i = 1; i < days.length; i += 1) {
      const previous = new Date(`${days[i - 1]}T00:00:00Z`).getTime();
      const current = new Date(`${days[i]}T00:00:00Z`).getTime();
      if (previous - current === 86_400_000) streak += 1;
      else break;
    }

    return streak;
  }
}
