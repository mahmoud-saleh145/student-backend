import { CourseStatus, EnrollmentMethod, EnrollmentState, UserRole } from '@prisma/client';

import {
  CoursesAdminService,
  PENDING_APPROVAL_SNAPSHOT_KEY,
  pendingApprovalIdsFrom,
} from '../../src/modules/courses/courses.admin.service';

/**
 * Archive -> restore must not approve anyone.
 *
 * Archiving moves ACTIVE and PENDING_APPROVAL rows to ARCHIVED. Restore used
 * to turn every ARCHIVED row with a live (or no) window into ACTIVE, so a
 * request nobody had approved came back as full access. These cases run the
 * real archive/restore code against a small in-memory enrollment table.
 */

const DAY = 24 * 3600 * 1000;
const ADMIN = { id: 'usr_admin', role: UserRole.ADMIN };

type Row = {
  id: string;
  courseId: string;
  state: EnrollmentState;
  method: EnrollmentMethod;
  approvedAt: Date | null;
  accessEndsAt: Date | null;
};

/** Just enough of Prisma's `where` for the queries archive/restore issue. */
function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Record<string, unknown>[]).some((w) => matches(row, w));
    const value = (row as unknown as Record<string, unknown>)[key];
    if (cond === null) return value === null;
    if (cond instanceof Date || typeof cond !== 'object') return value === cond;
    const c = cond as { in?: unknown[]; gt?: Date; lte?: Date };
    if (c.in) return c.in.includes(value);
    if (c.gt) return value instanceof Date && value > c.gt;
    if (c.lte) return value instanceof Date && value <= c.lte;
    throw new Error(`unsupported condition on ${key}`);
  });
}

function build(rows: Row[], legacySnapshot?: Record<string, unknown>) {
  let courseStatus: CourseStatus = CourseStatus.PUBLISHED;
  const archiveRecords: { snapshot: unknown; restoredAt: Date | null; archivedAt: Date }[] = legacySnapshot
    ? [{ snapshot: legacySnapshot, restoredAt: null, archivedAt: new Date() }]
    : [];
  if (legacySnapshot) {
    courseStatus = CourseStatus.ARCHIVED;
  }

  const enrollment = {
    count: jest.fn(async () => rows.length),
    findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      rows.filter((r) => matches(r, where)).map((r) => ({ id: r.id })),
    ),
    updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    }),
  };

  const tx = {
    enrollment,
    payment: { aggregate: jest.fn(async () => ({ _sum: { amount: 0 }, _count: { _all: 0 } })) },
    watchEvent: { count: jest.fn(async () => 0) },
    course: {
      update: jest.fn(async ({ data }: { data: { status: CourseStatus } }) => {
        courseStatus = data.status;
        return {};
      }),
    },
    playbackTicket: { updateMany: jest.fn(async () => ({ count: 0 })) },
    archiveRecord: {
      create: jest.fn(async ({ data }: { data: { snapshot: unknown } }) => {
        archiveRecords.push({ snapshot: data.snapshot, restoredAt: null, archivedAt: new Date() });
        return {};
      }),
      findFirst: jest.fn(async () => {
        const open = archiveRecords.filter((a) => a.restoredAt === null);
        return open.length ? { snapshot: open[open.length - 1].snapshot } : null;
      }),
      updateMany: jest.fn(async () => {
        archiveRecords.forEach((a) => (a.restoredAt = a.restoredAt ?? new Date()));
        return { count: 1 };
      }),
    },
  };

  const prisma = {
    course: {
      findFirst: jest.fn(async () => ({
        id: 'crs_1',
        status: courseStatus,
        lessonCount: 3,
        studentCount: rows.length,
        deletedAt: null,
      })),
    },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const audit = { record: jest.fn(async () => undefined) };

  const service = new CoursesAdminService(
    prisma as never,
    {} as never,
    {} as never,
    audit as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, rows, audit, archiveRecords };
}

const now = Date.now();
const row = (id: string, state: EnrollmentState, extra: Partial<Row> = {}): Row => ({
  id,
  courseId: 'crs_1',
  state,
  method: EnrollmentMethod.CODE,
  approvedAt: null,
  accessEndsAt: null,
  ...extra,
});

function fixture(): Row[] {
  return [
    row('active_lifetime', EnrollmentState.ACTIVE),
    row('active_window', EnrollmentState.ACTIVE, { accessEndsAt: new Date(now + 30 * DAY) }),
    row('active_lapsed', EnrollmentState.ACTIVE, { accessEndsAt: new Date(now - DAY) }),
    row('active_admin_granted', EnrollmentState.ACTIVE, {
      method: EnrollmentMethod.ADMIN_APPROVAL,
      approvedAt: new Date(now - 10 * DAY),
    }),
    row('pending_fresh', EnrollmentState.PENDING_APPROVAL, { method: EnrollmentMethod.ADMIN_APPROVAL }),
    // A student who was approved once, lost access, and asked again: the row
    // keeps the old approval stamp. Only the archive-time record can tell.
    row('pending_rerequest', EnrollmentState.PENDING_APPROVAL, {
      method: EnrollmentMethod.ADMIN_APPROVAL,
      approvedAt: new Date(now - 100 * DAY),
    }),
    row('pending_payment', EnrollmentState.PENDING_PAYMENT, { method: EnrollmentMethod.PAYMENT }),
    row('expired', EnrollmentState.EXPIRED, { accessEndsAt: new Date(now - 5 * DAY) }),
    row('revoked', EnrollmentState.REVOKED),
  ];
}

const stateOf = (rows: Row[]) => Object.fromEntries(rows.map((r) => [r.id, r.state]));

describe('archive -> restore keeps every enrollment state honest', () => {
  it('puts unapproved requests back as requests and approved students back as active', async () => {
    const { service, rows } = build(fixture());

    await service.archive('crs_1', ADMIN, 'term ended');
    expect(stateOf(rows)).toMatchObject({
      active_lifetime: EnrollmentState.ARCHIVED,
      pending_fresh: EnrollmentState.ARCHIVED,
      pending_rerequest: EnrollmentState.ARCHIVED,
      pending_payment: EnrollmentState.PENDING_PAYMENT,
    });

    await service.restore('crs_1', ADMIN);

    expect(stateOf(rows)).toEqual({
      active_lifetime: EnrollmentState.ACTIVE,
      active_window: EnrollmentState.ACTIVE,
      active_lapsed: EnrollmentState.EXPIRED,
      active_admin_granted: EnrollmentState.ACTIVE,
      pending_fresh: EnrollmentState.PENDING_APPROVAL,
      pending_rerequest: EnrollmentState.PENDING_APPROVAL,
      pending_payment: EnrollmentState.PENDING_PAYMENT,
      expired: EnrollmentState.EXPIRED,
      revoked: EnrollmentState.REVOKED,
    });
  });

  it('records the pending ids in the archive record only, not in the audit row or the response', async () => {
    const { service, audit, archiveRecords } = build(fixture());

    const result = await service.archive('crs_1', ADMIN, 'term ended');

    expect(pendingApprovalIdsFrom(archiveRecords[0].snapshot).sort()).toEqual(['pending_fresh', 'pending_rerequest']);
    expect(result.snapshot).not.toHaveProperty(PENDING_APPROVAL_SNAPSHOT_KEY);
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('pending_fresh');
  });

  it('never approves anyone across repeated archive/restore cycles', async () => {
    const { service, rows } = build(fixture());
    for (let i = 0; i < 3; i += 1) {
      await service.archive('crs_1', ADMIN, `cycle ${i}`);
      await service.restore('crs_1', ADMIN);
    }
    expect(stateOf(rows).pending_fresh).toBe(EnrollmentState.PENDING_APPROVAL);
    expect(stateOf(rows).pending_rerequest).toBe(EnrollmentState.PENDING_APPROVAL);
    expect(stateOf(rows).active_lifetime).toBe(EnrollmentState.ACTIVE);
  });

  it('is admin-only on both sides', async () => {
    const { service } = build(fixture());
    const teacher = { id: 'usr_t', role: UserRole.TEACHER };
    await expect(service.archive('crs_1', teacher, 'x')).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
    await expect(service.restore('crs_1', teacher)).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
  });
});

describe('courses archived before the fix (no recorded ids)', () => {
  function legacy(): Row[] {
    // What such an archive left behind: both kinds of row already ARCHIVED.
    return fixture().map((r) =>
      r.state === EnrollmentState.ACTIVE || r.state === EnrollmentState.PENDING_APPROVAL
        ? { ...r, state: EnrollmentState.ARCHIVED }
        : r,
    );
  }

  it('never activates a request that was never approved', async () => {
    const { service, rows } = build(legacy(), { enrollments: 9 });
    await service.restore('crs_1', ADMIN);
    expect(stateOf(rows).pending_fresh).toBe(EnrollmentState.PENDING_APPROVAL);
  });

  it('keeps approved students active', async () => {
    const { service, rows } = build(legacy(), { enrollments: 9 });
    await service.restore('crs_1', ADMIN);
    expect(stateOf(rows)).toMatchObject({
      active_lifetime: EnrollmentState.ACTIVE,
      active_window: EnrollmentState.ACTIVE,
      active_admin_granted: EnrollmentState.ACTIVE,
      active_lapsed: EnrollmentState.EXPIRED,
    });
  });

  it('KNOWN LIMIT: a re-request that kept an old approval stamp cannot be told apart and comes back ACTIVE', async () => {
    // Documented in OWNER_DECISIONS (restore defect). Only archives made
    // before the fix are affected; a read-only SQL check is provided there.
    const { service, rows } = build(legacy(), { enrollments: 9 });
    await service.restore('crs_1', ADMIN);
    expect(stateOf(rows).pending_rerequest).toBe(EnrollmentState.ACTIVE);
  });
});

describe('pendingApprovalIdsFrom', () => {
  it.each([
    [null, []],
    [[], []],
    [{ enrollments: 3 }, []],
    [{ [PENDING_APPROVAL_SNAPSHOT_KEY]: ['a', 2, 'b'] }, ['a', 'b']],
  ])('%p -> %p', (input, expected) => {
    expect(pendingApprovalIdsFrom(input)).toEqual(expected);
  });
});
