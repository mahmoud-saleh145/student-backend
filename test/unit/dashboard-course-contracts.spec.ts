import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AttachmentKind, ContentStatus, UserRole } from '@prisma/client';
import { firstValueFrom, of } from 'rxjs';

import { ErrorCode } from '../../src/common/errors/error-codes';
import { ResponseInterceptor } from '../../src/common/interceptors/response.interceptor';
import { AnalyticsService } from '../../src/modules/analytics/analytics.service';
import { toAttachment } from '../../src/modules/courses/course.serializer';
import { LessonsService } from '../../src/modules/lessons/lessons.service';

/**
 * Contracts the dashboard's course screen depends on.
 *
 *  - Lecture viewers: the report returns `lesson` and `summary` beside the
 *    paginated `items`/`meta`. The response interceptor used to rebuild `data`
 *    as `{ items, meta }` only, so the dashboard received no `lesson` and
 *    crashed reading `data.lesson.completionRule`.
 *  - Documents: the dashboard reads `isPreview` back to show the Free Sample
 *    state; the serializer never sent it.
 *  - Lecture rename: `PATCH admin/lessons/:id { title }`.
 */

const ADMIN = { id: 'usr_admin', role: UserRole.ADMIN };

function envelope(handlerResult: unknown) {
  const interceptor = new ResponseInterceptor(
    { getAllAndOverride: () => false } as unknown as Reflector,
  );
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ requestId: 'req_1' }) }),
  } as unknown as ExecutionContext;
  const next: CallHandler = { handle: () => of(handlerResult) };
  return firstValueFrom(interceptor.intercept(context, next));
}

describe('response envelope for paginated results', () => {
  const meta = { page: 1, pageSize: 20, total: 0, totalPages: 1, hasNext: false, hasPrevious: false };

  it('keeps a report’s other keys beside items and meta', async () => {
    const body = await envelope({
      lesson: { id: 'les_1', completionRule: { type: 'WATCH_PERCENT', threshold: 90 } },
      summary: { viewers: 0, completed: 0, averagePercent: 0, totalWatchSeconds: 0 },
      items: [],
      meta,
    });

    expect(body).toEqual({
      success: true,
      data: {
        lesson: { id: 'les_1', completionRule: { type: 'WATCH_PERCENT', threshold: 90 } },
        summary: { viewers: 0, completed: 0, averagePercent: 0, totalWatchSeconds: 0 },
        items: [],
        meta,
      },
      meta: { requestId: 'req_1' },
    });
  });

  it('keeps report totals (recharge, part purchases, library) instead of dropping them', async () => {
    const body = (await envelope({ items: [], meta, totals: { revenue: 1200, count: 4 } })) as {
      data: { totals: unknown };
    };
    expect(body.data.totals).toEqual({ revenue: 1200, count: 4 });
  });

  it('leaves a plain paginated list exactly { items, meta }', async () => {
    const body = (await envelope({ items: [{ id: 'a' }], meta })) as { data: unknown };
    expect(body.data).toEqual({ items: [{ id: 'a' }], meta });
  });
});

describe('attachment rows carry their stored flags', () => {
  const row = (isPreview: boolean, isProtected = true, isDownloadable = false) => ({
    id: 'att_1',
    courseId: 'crs_1',
    lessonId: 'les_1',
    sectionId: null,
    title: 'Sheet 1',
    titleAr: null,
    kind: AttachmentKind.PDF,
    objectKey: 'attachments/crs_1/x.pdf',
    mimeType: 'application/pdf',
    sizeBytes: BigInt(10),
    pageCount: null,
    isProtected,
    isDownloadable,
    isPreview,
    sortOrder: 0,
    uploadedById: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    deletedAt: null,
  });

  it('reports a free sample as isPreview: true', () => {
    expect(toAttachment(row(true), true)).toMatchObject({ isPreview: true, locked: false });
  });

  it('reports a protected document as isPreview: false, not undefined', () => {
    const out = toAttachment(row(false), false);
    expect(out.isPreview).toBe(false);
    expect(out).toMatchObject({ isProtected: true, isDownloadable: false, locked: true });
  });

  it('never reports a protected file as downloadable', () => {
    expect(toAttachment(row(false, true, true), true).isDownloadable).toBe(false);
    expect(toAttachment(row(false, false, true), true).isDownloadable).toBe(true);
  });

  it('keeps the keys the student apps already read', () => {
    expect(toAttachment(row(true), true)).toMatchObject({
      protected: true,
      downloadable: false,
      locked: false,
      createdAt: '2026-10-01T00:00:00.000Z',
    });
  });
});

describe('lecture viewers search', () => {
  function build() {
    const calls: { where: unknown }[] = [];
    const prisma = {
      lesson: {
        findFirst: jest.fn(async () => ({
          id: 'les_1',
          title: 'Lecture 1',
          courseId: 'crs_1',
          durationSeconds: 600,
          completionRuleType: null,
          completionThreshold: null,
          video: null,
          course: { id: 'crs_1', title: 'Course', completionRuleType: 'WATCH_PERCENT', completionThreshold: 90 },
        })),
      },
      watchProgress: {
        findMany: jest.fn((args: { where: unknown }) => {
          calls.push(args);
          return [];
        }),
        count: jest.fn(() => 0),
        aggregate: jest.fn(() => ({ _avg: { percent: null }, _sum: { watchedSeconds: null }, _count: { _all: 0 } })),
      },
      $transaction: jest.fn(async (ops: unknown[]) => Promise.all(ops)),
    };
    const access = { assertCanManageCourse: jest.fn(async () => undefined) };
    const service = new AnalyticsService(prisma as never, access as never);
    return { service, calls, access };
  }

  const run = (q?: string) => {
    const ctx = build();
    return ctx.service
      .lessonViewers({ lessonId: 'les_1', actorId: 'usr_admin', role: UserRole.ADMIN, page: 1, pageSize: 20, q })
      .then((result) => ({ ...ctx, result }));
  };

  it('searches a name query by name only (no phone clause that matches everyone)', async () => {
    const { calls } = await run('Ahmed');
    expect(calls[0]!.where).toEqual({
      lessonId: 'les_1',
      user: { OR: [{ fullName: { contains: 'Ahmed', mode: 'insensitive' } }] },
    });
  });

  it('also searches phone digits when the query has them', async () => {
    const { calls } = await run('010 123');
    expect(calls[0]!.where).toEqual({
      lessonId: 'les_1',
      user: {
        OR: [
          { fullName: { contains: '010 123', mode: 'insensitive' } },
          { phone: { contains: '010123' } },
        ],
      },
    });
  });

  it('returns lesson and summary alongside the page, and they survive the envelope', async () => {
    const { result, access } = await run();
    expect(access.assertCanManageCourse).toHaveBeenCalledWith('usr_admin', UserRole.ADMIN, 'crs_1', 'students');

    const body = (await envelope(result)) as {
      data: { lesson: { completionRule: { threshold: number } }; summary: { viewers: number }; items: unknown[] };
    };
    expect(body.data.lesson.completionRule.threshold).toBe(90);
    expect(body.data.summary.viewers).toBe(0);
    expect(body.data.items).toEqual([]);
  });
});

describe('renaming a lecture', () => {
  function build() {
    const stored = {
      id: 'les_1',
      courseId: 'crs_1',
      sectionId: 'sec_1',
      title: 'Old title',
      status: ContentStatus.PUBLISHED,
      isPreview: true,
    };
    const prisma = {
      lesson: {
        findFirst: jest.fn(async () => ({ ...stored })),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          for (const [key, value] of Object.entries(data)) {
            if (value !== undefined) (stored as Record<string, unknown>)[key] = value;
          }
          return { ...stored };
        }),
      },
      playbackTicket: { updateMany: jest.fn() },
    };
    const access = { assertCanManageCourse: jest.fn(async () => undefined) };
    const courses = { recountCourse: jest.fn(async () => undefined) };
    const audit = { record: jest.fn(async () => undefined) };
    const service = new LessonsService(prisma as never, access as never, courses as never, audit as never);
    return { service, prisma, access, stored, audit };
  }

  it('saves a trimmed title on the same lecture and changes nothing else', async () => {
    const { service, prisma, stored, audit } = build();

    const updated = await service.update('les_1', { title: '  New title  ' }, ADMIN);

    expect(updated).toMatchObject({ id: 'les_1', title: 'New title', isPreview: true, status: 'PUBLISHED' });
    const data = prisma.lesson.update.mock.calls[0]![0].data as Record<string, unknown>;
    const written = Object.entries(data).filter(([, value]) => value !== undefined);
    expect(written).toEqual([['title', 'New title']]);
    expect(prisma.playbackTicket.updateMany).not.toHaveBeenCalled();
    expect(stored.isPreview).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: 'lesson',
        entityId: 'les_1',
        before: expect.objectContaining({ title: 'Old title' }),
        after: expect.objectContaining({ title: 'New title' }),
      }),
    );
  });

  it('refuses a blank title and writes nothing', async () => {
    const { service, prisma } = build();

    await expect(service.update('les_1', { title: '   ' }, ADMIN)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
    expect(prisma.lesson.update).not.toHaveBeenCalled();
  });

  it('refuses a caller without content rights on the course', async () => {
    const { service, prisma, access } = build();
    access.assertCanManageCourse.mockRejectedValueOnce(new Error('NOT_COURSE_TEACHER'));

    await expect(
      service.update('les_1', { title: 'New title' }, { id: 'usr_t', role: UserRole.TEACHER }),
    ).rejects.toThrow('NOT_COURSE_TEACHER');
    expect(prisma.lesson.update).not.toHaveBeenCalled();
  });
});
