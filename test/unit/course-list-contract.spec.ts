import { UserRole } from '@prisma/client';

import { CoursesAdminService } from '../../src/modules/courses/courses.admin.service';

/**
 * The staff course-LIST response shape.
 *
 * The sibling of `course-detail-contract.spec.ts`, and for the same reason:
 * `list` maps every field by hand, so its response is whatever the mapper
 * happened to remember to copy and the dashboard has to guess at the rest.
 *
 * This one exists because of the Access Code picker. Its label is
 * `Title (Faculty – University – Department)`, and `list` selected the faculty
 * and the university but not the departments — so the third half of that
 * sentence could not be written at all, no matter what the dashboard asked for.
 *
 * Two things are asserted, and deliberately they are different kinds of claim:
 *
 *  - **the query** carries the department include *and its ordering*. Ordering
 *    is SQL's job, and a mapper that re-sorts would fight it, so the guarantee
 *    has to live in the `orderBy`, not in the rows a double happens to return.
 *  - **the mapper** flattens the join rows and preserves their order verbatim,
 *    and reports an empty array when there are none — never `undefined`, which
 *    the picker reads as "no departments" but a reader could easily not.
 */

const ADMIN = { id: 'usr_admin', role: UserRole.ADMIN };

/** A course row shaped the way the `list` query returns one. */
function courseRow(over: Record<string, unknown> = {}) {
  return {
    id: 'crs_1',
    title: 'Anatomy 101',
    slug: 'anatomy-101',
    status: 'PUBLISHED',
    isFree: false,
    thumbnailKey: null,
    studentCount: 12,
    publishedAt: new Date('2026-01-01'),
    archivedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    prices: [{ amount: 250, currency: 'EGP' }],
    teachers: [
      {
        isLead: true,
        teacher: { id: 'usr_t1', fullName: 'Tarek Teacher' },
      },
    ],
    university: { id: 'uni_1', name: 'Cairo University', nameAr: 'جامعة القاهرة' },
    faculty: { id: 'fac_1', name: 'Medicine', nameAr: 'الطب' },
    academicYear: { id: 'yr_1', name: 'First year', nameAr: 'الفرقة الأولى', order: 1 },
    subject: null,
    departments: [] as { department: { id: string; name: string; facultyId: string } }[],
    _count: { enrollments: 12, sections: 3, lessons: 24 },
    ...over,
  };
}

function buildService(rows: Record<string, unknown>[] = [courseRow()]) {
  const findMany = jest.fn(async () => rows);
  const prisma = {
    course: { findMany, count: jest.fn(async () => rows.length) },
    // The list issues its two reads as one array transaction.
    $transaction: jest.fn(async () => [rows, rows.length] as [unknown[], number]),
  };
  const access = { teacherCourseIds: jest.fn(async () => ['crs_1']) };

  const service = new CoursesAdminService(
    prisma as never,
    { recountCourse: jest.fn() } as never,
    access as never,
    { record: jest.fn() } as never,
    { publicAssetUrl: jest.fn(async () => null) } as never,
    {} as never,
    {} as never,
  );

  return { service, prisma, findMany };
}

/** One course from the mapped page. */
type ListedCourse = {
  id: string;
  title: string;
  departments: { id: string; name: string; facultyId: string }[];
};

async function listFirst(
  rows: Record<string, unknown>[],
): Promise<{ course: ListedCourse; include: Record<string, unknown> }> {
  const { service, findMany } = buildService(rows);
  const page = (await service.list({
    actor: ADMIN,
    page: 1,
    pageSize: 100,
  })) as unknown as { items: ListedCourse[] };

  const args = findMany.mock.calls[0] as unknown as [
    { include: Record<string, unknown> },
  ];
  return { course: page.items[0], include: args[0].include };
}

describe('CoursesAdminService.list — departments in the response', () => {
  it('asks for the departments, ordered the way the catalogue orders them', async () => {
    // The Access Code picker prints every department a course is offered to, so
    // the list has to send them — and in a defined order, or the same course
    // reads differently from one request to the next.
    const { include } = await listFirst([courseRow()]);

    expect(include.departments).toEqual({
      orderBy: [{ department: { sortOrder: 'asc' } }, { department: { name: 'asc' } }],
      select: { department: { select: { id: true, name: true, facultyId: true } } },
    });
  });

  it('flattens one department out of its join row', async () => {
    const { course } = await listFirst([
      courseRow({
        departments: [
          { department: { id: 'dep_a', name: 'Human Anatomy', facultyId: 'fac_1' } },
        ],
      }),
    ]);

    // Flattened because a consumer wants the department, not the link table —
    // the same shape `detailForStaff` already returned.
    expect(course.departments).toEqual([
      { id: 'dep_a', name: 'Human Anatomy', facultyId: 'fac_1' },
    ]);
  });

  it('keeps every department of a course offered to several, in the given order', async () => {
    const { course } = await listFirst([
      courseRow({
        departments: [
          { department: { id: 'dep_a', name: 'Human Anatomy', facultyId: 'fac_1' } },
          { department: { id: 'dep_b', name: 'Histology', facultyId: 'fac_1' } },
          { department: { id: 'dep_c', name: 'Topography', facultyId: 'fac_1' } },
        ],
      }),
    ]);

    // Order comes from the `orderBy` above, asserted against the query rather
    // than against these rows — so what is checked here is only that the mapper
    // neither drops a department nor reorders them itself.
    expect(course.departments.map((d) => d.name)).toEqual([
      'Human Anatomy',
      'Histology',
      'Topography',
    ]);
  });

  it('reports an empty list, never undefined, for a course with no department', async () => {
    // The case the label has to survive: a course filed under no department
    // must still read `Title (Faculty – University)` and nothing more.
    const { course } = await listFirst([courseRow({ departments: [] })]);

    expect(course.departments).toEqual([]);
  });

  it('leaves the rest of the row exactly as it was', async () => {
    // The change is additive. Anything that shifted here would move a course
    // row the Courses page, the notification picker and the teacher home all
    // read the same way.
    const { course } = await listFirst([courseRow({ departments: [] })]);

    expect(course).toMatchObject({
      id: 'crs_1',
      title: 'Anatomy 101',
      slug: 'anatomy-101',
      status: 'PUBLISHED',
      studentCount: 12,
    });
  });
});
