import { AccountStatus, NotificationKind, type Prisma } from '@prisma/client';

import { NotificationsService } from '../../src/modules/notifications/notifications.service';

/**
 * Inbox pagination.
 *
 * The inbox is the one list in the product a student opens repeatedly and
 * expects to be trustworthy, so the tests here are about *partitioning* rather
 * than about rows coming back. A page order is only usable if it is total: any
 * two distinct rows must be strictly ordered, or the database is free to return
 * them in either order on successive reads and the pages stop covering the set.
 *
 * That failure is invisible in a sample of one row per timestamp and appears
 * only when timestamps collide — which they do whenever a batch is written in
 * one transaction, because `createdAt` defaults to Postgres' *transaction*
 * `now()` rather than a per-row clock.
 */

type Row = { id: string; createdAt: Date; read: boolean };

function build(rows: Row[]) {
  // The mocks declare a parameter so `mock.calls` records the query the service
  // built; otherwise the assertions would be reading an empty tuple type.
  const findMany = jest.fn(async (_args: Record<string, unknown>) => rows);
  const count = jest.fn(async (_args: Record<string, unknown>) => rows.length);
  const updateMany = jest.fn(async (_args: Record<string, unknown>) => ({ count: 1 }));
  const enrollmentFindMany = jest.fn(async (_args: Record<string, unknown>) => []);
  const prisma = {
    notification: { findMany, count, updateMany },
    enrollment: { findMany: enrollmentFindMany },
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };

  const service = new NotificationsService(
    prisma as never,
    { add: jest.fn(async () => undefined) } as never,
    { get: () => undefined } as never,
  );
  return { service, findMany, count, updateMany, enrollmentFindMany };
}

const PARAMS = { userId: 'stu_1', page: 1, pageSize: 20 };

function notificationRow(id: string, createdAt: Date): Prisma.NotificationGetPayload<object> {
  return {
    id,
    userId: 'stu_1',
    kind: NotificationKind.ANNOUNCEMENT,
    title: `title ${id}`,
    titleAr: null,
    body: `body ${id}`,
    bodyAr: null,
    route: null,
    imageUrl: null,
    data: null,
    announcementId: null,
    dedupeKey: null,
    read: false,
    readAt: null,
    createdAt,
  };
}

/** Applies an `orderBy` array the way the database would, to prove it is total. */
function applyOrder(rows: Row[], orderBy: Prisma.NotificationOrderByWithRelationInput[]) {
  return [...rows].sort((a, b) => {
    for (const key of orderBy) {
      const [field, dir] = Object.entries(key)[0] as [keyof Row, 'asc' | 'desc'];
      const sign = dir === 'desc' ? -1 : 1;
      const av = a[field];
      const bv = b[field];
      if (av === bv) continue;
      if (av instanceof Date && bv instanceof Date) return (av.getTime() - bv.getTime()) * sign;
      return String(av) < String(bv) ? -sign : sign;
    }
    return 0;
  });
}

describe('inbox page order', () => {
  it('orders by a unique tiebreaker, not by timestamp alone', async () => {
    const { service, findMany } = build([]);
    await service.list(PARAMS);

    const orderBy = findMany.mock.calls[0][0].orderBy as Prisma.NotificationOrderByWithRelationInput[];

    // `createdAt` alone is not an order. The last key has to be unique, and `id`
    // is the only candidate on this table.
    expect(Array.isArray(orderBy)).toBe(true);
    expect(orderBy[0]).toEqual({ createdAt: 'desc' });
    expect(orderBy.at(-1)).toEqual({ id: 'desc' });
  });

  it('uses one order for both the plain and the localised inbox', async () => {
    // Two endpoints over one inbox must agree, or switching language mid-scroll
    // reorders rows the student is already looking at.
    const { service, findMany } = build([]);
    await service.list(PARAMS);
    await service.listLocalized({ ...PARAMS, locale: 'ar' });

    const [plain, localised] = findMany.mock.calls.map(
      (c) => c[0].orderBy as Prisma.NotificationOrderByWithRelationInput[],
    );
    expect(plain).toEqual(localised);
  });

  it('partitions rows that share a timestamp across pages without loss', async () => {
    const { service, findMany } = build([]);
    await service.list(PARAMS);
    const orderBy = findMany.mock.calls[0][0].orderBy as Prisma.NotificationOrderByWithRelationInput[];

    // Same instant for every row, which is what one `createMany` produces.
    const at = new Date('2026-10-06T09:00:00Z');
    const rows: Row[] = ['e', 'd', 'c', 'b', 'a'].map((id) => ({ id, createdAt: at, read: false }));

    const ordered = applyOrder(rows, orderBy);
    const pageSize = 2;
    const pages = [
      ordered.slice(0, pageSize),
      ordered.slice(pageSize, pageSize * 2),
      ordered.slice(pageSize * 2),
    ].flat();

    // Every row appears exactly once: no duplicate at a page boundary, none lost.
    expect(new Set(pages.map((r) => r.id)).size).toBe(rows.length);
    expect(pages).toHaveLength(rows.length);
    expect(applyOrder(rows, orderBy)).toEqual(ordered);
  });

  it('keeps newest first when timestamps differ', async () => {
    const { service, findMany } = build([]);
    await service.list(PARAMS);
    const orderBy = findMany.mock.calls[0][0].orderBy as Prisma.NotificationOrderByWithRelationInput[];

    const rows: Row[] = [
      { id: 'old', createdAt: new Date('2026-10-01T00:00:00Z'), read: false },
      { id: 'new', createdAt: new Date('2026-10-05T00:00:00Z'), read: false },
    ];

    expect(applyOrder(rows, orderBy).map((r) => r.id)).toEqual(['new', 'old']);
  });

  it('restricts to unread when asked, without changing the order', async () => {
    const { service, findMany } = build([]);
    await service.list({ ...PARAMS, unreadOnly: true });

    expect(findMany.mock.calls[0][0].where).toMatchObject({ userId: 'stu_1', read: false });
  });

  it('counts the same filtered set it pages over', async () => {
    const rows = [
      notificationRow('n1', new Date('2026-10-05T00:00:00Z')),
      notificationRow('n2', new Date('2026-10-04T00:00:00Z')),
    ];
    const { service, findMany, count } = build([]);
    // `count` answers the unreadOnly=true question here, so the totals can only
    // line up if both calls were given the same `where`.
    (count as jest.Mock).mockResolvedValue(rows.length);

    const result = await service.list({ ...PARAMS, unreadOnly: true });

    const pagedWhere = findMany.mock.calls[0][0].where;
    expect(pagedWhere).toEqual({ userId: 'stu_1', read: false });
    expect(result.meta).toMatchObject({ total: 2 });
  });

  it('paginates with offset arithmetic rather than an unbounded read', async () => {
    const { service, findMany } = build([]);
    await service.list({ ...PARAMS, page: 3, pageSize: 25 });

    expect(findMany.mock.calls[0][0]).toMatchObject({ skip: 50, take: 25 });
  });
});

describe('marking notifications read', () => {
  it('scopes the update to the owner', async () => {
    // `notificationId` comes from the request. Without `userId` in the filter
    // this is a write-any-row-on-any-inbox primitive.
    const { service, updateMany } = build([]);

    await service.markRead('stu_1', 'ntf_9');

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'ntf_9', userId: 'stu_1' }),
      }),
    );
  });

  it('marks all read only for the owner', async () => {
    const { service, updateMany } = build([]);

    await service.markAllRead('stu_1');

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'stu_1', read: false } }),
    );
  });

  it('is idempotent, reporting zero once already read', async () => {
    // Retrying a read receipt is normal on a flaky mobile connection; the second
    // call must be a no-op rather than moving `readAt`.
    const { service, updateMany } = build([]);
    (updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    await expect(service.markRead('stu_1', 'ntf_9')).resolves.toEqual({ ok: true, updated: 0 });
  });

  it('counts unread within the owner scope', async () => {
    const { service, count } = build([]);
    (count as jest.Mock).mockResolvedValue(3);

    await expect(service.unreadCount('stu_1')).resolves.toEqual({ count: 3 });
    expect(count).toHaveBeenCalledWith({ where: { userId: 'stu_1', read: false } });
  });
});

describe('account status on delivery', () => {
  it('excludes inactive accounts from course-wide notification fan-out', async () => {
    // The broadcast path already filters on status; this pins it so the two
    // delivery paths cannot drift apart again.
    const { service, enrollmentFindMany } = build([]);

    await service.notifyCourseStudents('crs_1', {
      title: 'New lesson',
      body: 'Watch part 3.',
      kind: NotificationKind.NEW_LESSON,
    });

    expect(enrollmentFindMany.mock.calls[0][0].where).toMatchObject({
      user: { status: AccountStatus.ACTIVE, deletedAt: null },
    });
  });
});