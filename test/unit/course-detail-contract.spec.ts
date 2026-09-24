import { UserRole } from '@prisma/client';

import { CoursesAdminService } from '../../src/modules/courses/courses.admin.service';

/**
 * The staff course-detail response shape.
 *
 * `detailForStaff` spreads a Prisma row, which means its response shape is
 * whatever the query happened to select — and the dashboard had guessed at it.
 * Three of those guesses were wrong, and one of them was fatal: reading
 * `data.counts.sections` on a response with no `counts` threw a TypeError
 * during render, so clicking "Open" on a course showed the error boundary
 * instead of the course.
 *
 * These cases pin the fields the dashboard actually reads. They are deliberately
 * about the CONTRACT rather than the values: a future `select` that quietly
 * drops `faculty` should fail here, not in a browser.
 */

const ADMIN = { id: 'usr_admin', role: UserRole.ADMIN };

/** A course row shaped the way the `detailForStaff` query returns one. */
function courseRow(over: Record<string, unknown> = {}) {
  return {
    id: 'crs_1',
    title: 'Anatomy 101',
    status: 'PUBLISHED',
    isFree: false,
    thumbnailKey: null,
    // Denormalised columns maintained by recountCourse.
    sectionCount: 3,
    lessonCount: 24,
    studentCount: 12,
    publishedAt: new Date('2026-01-01'),
    archivedAt: null,
    createdAt: new Date('2026-01-01'),
    university: { id: 'uni_1', name: 'Cairo University' },
    faculty: { id: 'fac_1', name: 'Medicine' },
    academicYear: { id: 'yr_1', name: 'First year' },
    subject: { id: 'subj_1', name: 'Anatomy' },
    _count: { enrollments: 12, attachments: 4 },
    departments: [
      { department: { id: 'dep_a', name: 'Anatomy', facultyId: 'fac_1' } },
      { department: { id: 'dep_b', name: 'Physiology', facultyId: 'fac_1' } },
    ],
    prices: [
      { id: 'p2', version: 2, isCurrent: true, amount: 250, compareAtAmount: null, currency: 'EGP' },
      { id: 'p1', version: 1, isCurrent: false, amount: 200, compareAtAmount: null, currency: 'EGP' },
    ],
    sections: [],
    teachers: [
      {
        teacherId: 'usr_t1',
        isLead: true,
        canEditContent: true,
        canEditPricing: false,
        canPublish: false,
        canViewStudents: true,
        canViewRevenue: true,
        revenueSharePercent: null,
        teacher: { id: 'usr_t1', fullName: 'Tarek Teacher', avatarUrl: null },
      },
    ],
    ...over,
  };
}

function buildService(row: Record<string, unknown> | null = courseRow()) {
  const prisma = { course: { findFirst: jest.fn(async () => row) } };
  const access = { staffMayViewCourse: jest.fn(async () => true) };
  const storage = { publicAssetUrl: jest.fn(async () => null) };

  const service = new CoursesAdminService(
    prisma as never,
    { recountCourse: jest.fn() } as never,
    access as never,
    { record: jest.fn() } as never,
    storage as never,
  );

  return { service, prisma, access };
}

describe('detailForStaff — fields the course page reads', () => {
  it('returns counts, so the page does not crash on data.counts.sections', async () => {
    const { service } = await buildService();
    const detail = (await service.detailForStaff('crs_1')) as {
      counts: { sections: number; lessons: number; enrollments: number; attachments: number };
    };

    // The crash that started this: `counts` must exist and be an object.
    expect(detail.counts).toBeDefined();
    expect(detail.counts).toEqual({
      sections: 3,
      lessons: 24,
      enrollments: 12,
      attachments: 4,
    });
  });

  it('flattens the current price rather than handing over a version history', async () => {
    const { service } = await buildService();
    const detail = (await service.detailForStaff('crs_1')) as {
      price: { amount: number; currency: string } | null;
      prices: { version: number }[];
    };

    // Version 2 is current; version 1 is history and must not be shown as the
    // price. Picking prices[0] by position would be right only by accident.
    expect(detail.price).toEqual({ amount: 250, currency: 'EGP' });
    expect(detail.prices).toHaveLength(2);
  });

  it('falls back to null when a course has no price row at all', async () => {
    const { service } = await buildService(courseRow({ prices: [] }));
    const detail = (await service.detailForStaff('crs_1')) as { price: unknown };

    expect(detail.price).toBeNull();
  });

  it('includes faculty and subject, not only university and year', async () => {
    const { service } = await buildService();
    // Through `unknown`: the real return is a full Prisma row, which does not
    // overlap an index signature of named refs. Only these four are read here.
    const detail = (await service.detailForStaff('crs_1')) as unknown as Record<
      string,
      { name: string } | null
    >;

    expect(detail.university?.name).toBe('Cairo University');
    expect(detail.faculty?.name).toBe('Medicine');
    expect(detail.academicYear?.name).toBe('First year');
    expect(detail.subject?.name).toBe('Anatomy');
  });

  it('flattens departments out of their join rows', async () => {
    // The edit form prefills from these and posts back ids, so it wants the
    // departments themselves rather than the link rows carrying them.
    const { service } = await buildService();
    const detail = (await service.detailForStaff('crs_1')) as {
      departments: { id: string; name: string; facultyId: string }[];
    };

    expect(detail.departments).toEqual([
      { id: 'dep_a', name: 'Anatomy', facultyId: 'fac_1' },
      { id: 'dep_b', name: 'Physiology', facultyId: 'fac_1' },
    ]);
  });

  it('keeps teachers as assignment rows with the account nested', async () => {
    // The Teachers tab needs the per-assignment permission flags, so this
    // endpoint deliberately does NOT flatten to the list endpoint's
    // {id, fullName, isLead} shape. Pinned so the two are not "unified" later.
    const { service } = await buildService();
    const detail = (await service.detailForStaff('crs_1')) as {
      teachers: { teacherId: string; canEditPricing: boolean; teacher: { fullName: string } }[];
    };

    expect(detail.teachers[0]?.teacher.fullName).toBe('Tarek Teacher');
    expect(detail.teachers[0]?.teacherId).toBe('usr_t1');
    expect(detail.teachers[0]?.canEditPricing).toBe(false);
  });
});

describe('detailForActor — the same shape, plus the assignment check', () => {
  it('serves the full record to an admin', async () => {
    const { service } = await buildService();
    const detail = (await service.detailForActor('crs_1', ADMIN)) as { counts: unknown };

    expect(detail.counts).toBeDefined();
  });

  it('never reads the course when the actor may not see it', async () => {
    const { service, prisma } = buildService();
    (service as unknown as { access: { staffMayViewCourse: jest.Mock } }).access
      .staffMayViewCourse.mockResolvedValue(false);

    await expect(
      service.detailForActor('crs_1', { id: 'usr_t', role: UserRole.TEACHER }),
    ).rejects.toBeDefined();

    expect(prisma.course.findFirst).not.toHaveBeenCalled();
  });
});
