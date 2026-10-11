import { CoursesService } from 'src/modules/courses/courses.service';

/**
 * What a student sees under "Materials" on a course.
 *
 * THE BUG THIS FILE EXISTS FOR
 * ---------------------------
 * `CoursesService` defined "this course's attachments" two different ways:
 *
 *   - `detail()`          -> `where: { courseId, lessonId: null }`  (course-wide only)
 *   - `attachments()`     -> `where: { courseId }`                 (everything)
 *
 * The student Materials tab is rendered from the COURSE DETAIL payload
 * (`course.attachments` in `student-web/src/app/courses/[id]/page.tsx`), and
 * student-web never calls `GET /courses/:id/attachments`. So the narrower of
 * the two definitions was the one that reached students.
 *
 * A lecture PDF is stored with `lessonId` set. It therefore never appeared in
 * the Materials tab - the instructor uploaded it, the dashboard confirmed
 * "Document added", and the student's course showed "No materials for this
 * lesson." It was only ever reachable by opening that one lecture directly.
 *
 * The prisma double below actually HONOURS `where.lessonId === null` and the
 * requested `orderBy`, so these tests fail against the old query rather than
 * passing regardless of it.
 */

const COURSE = {
  id: 'crs_1',
  status: 'PUBLISHED',
  title: 'Course',
  description: 'desc',
  requirements: [],
  outcomes: [],
  thumbnailKey: null,
  lessonCount: 1,
  enrollmentMethods: [],
  prices: [],
  teachers: [],
  university: null,
  academicYear: null,
  completionRuleType: 'MANUAL',
  completionThreshold: 100,
  completionRequireContiguous: false,
  updatedAt: new Date('2024-01-01T00:00:00.000Z'),
  sections: [
    {
      id: 'sec_1',
      title: 'Section',
      description: null,
      sortOrder: 0,
      status: 'PUBLISHED',
      unlocksAt: null,
      lessons: [
        {
          id: 'les_1',
          sectionId: 'sec_1',
          courseId: 'crs_1',
          title: 'Lecture 1',
          kind: 'VIDEO',
          sortOrder: 0,
          durationSeconds: 0,
          isPreview: false,
          _count: { attachments: 2 },
        },
      ],
    },
  ],
};

/** rows[0] is a lecture PDF, rows[1] a section handout, rows[2] course-wide. */
function row(over: Record<string, unknown>) {
  return {
    id: 'att',
    courseId: 'crs_1',
    lessonId: null,
    sectionId: null,
    title: 't',
    kind: 'PDF',
    objectKey: 'attachments/crs_1/x.pdf',
    mimeType: 'application/pdf',
    sizeBytes: BigInt(10),
    pageCount: 1,
    isProtected: true,
    isDownloadable: false,
    isPreview: false,
    sortOrder: 0,
    deletedAt: null,
    ...over,
  };
}

const ROWS = [
  row({ id: 'att_lecture', lessonId: 'les_1', title: 'Lecture slides.pdf' }),
  row({ id: 'att_section', sectionId: 'sec_1', title: 'Section handout.pdf' }),
  row({ id: 'att_course', title: 'Syllabus.pdf' }),
];

function build(rows: Record<string, unknown>[] = ROWS) {
  const attachmentQueries: Record<string, unknown>[] = [];

  const stubbed = {
    course: { findFirst: jest.fn(async () => COURSE) },
    watchProgress: { findMany: jest.fn(async () => []) },
    attachment: {
      findMany: jest.fn(async (args: Record<string, unknown>) => {
        attachmentQueries.push(args);
        const where = (args.where ?? {}) as {
          courseId?: string;
          lessonId?: string | null;
          deletedAt?: null;
        };
        const orderBy = (args.orderBy ?? {}) as
          | { sortOrder?: string }
          | Array<{ lessonId?: string; sortOrder?: string }>;

        let out = rows.filter(
          (r) =>
            (!where.courseId || r.courseId === where.courseId) &&
            (where.lessonId === undefined || r.lessonId === where.lessonId) &&
            r.deletedAt === null,
        );

        if (Array.isArray(orderBy)) {
          for (const clause of [...orderBy].reverse()) {
            if (clause.lessonId) {
              out = [...out].sort((a, b) =>
                String(a.lessonId ?? '').localeCompare(String(b.lessonId ?? '')),
              );
            } else if (clause.sortOrder) {
              out = [...out].sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder));
            }
          }
        }
        return out;
      }),
    },
  };

  // `detail()` touches models this test does not model. Anything unstubbed
  // answers empty rather than blowing up, so the attachment query under test is
  // the only thing that decides the assertions.
  const prisma = new Proxy(stubbed as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return {
        findMany: async () => [],
        findFirst: async () => null,
        findUnique: async () => null,
        findUniqueOrThrow: async () => null,
        count: async () => 0,
      };
    },
  });

  const access = {
    resolve: jest.fn(async () => ({ canAccessContent: true, hasAccess: true })),
    toCourseAccess: jest.fn(() => ({ hasAccess: true })),
  };
  const storage = { publicAssetUrl: jest.fn(async () => null) };

  const service = new CoursesService(prisma as never, access as never, storage as never);
  return { service, attachmentQueries };
}

const detail = (t: ReturnType<typeof build>) =>
  t.service.detail({ courseId: 'crs_1', userId: 'stu_1', role: 'STUDENT' as never });

describe('the student Materials list', () => {
  it('includes a PDF attached to a lecture', async () => {
    // The regression. A lecture PDF has lessonId set.
    const t = build();
    const result = (await detail(t)) as { attachments: Array<{ id: string }> };

    expect(result.attachments.map((a) => a.id)).toContain('att_lecture');
  });

  it('still includes course-wide documents', async () => {
    const t = build();
    const result = (await detail(t)) as { attachments: Array<{ id: string }> };

    expect(result.attachments.map((a) => a.id)).toContain('att_course');
  });

  it('still includes section handouts', async () => {
    const t = build();
    const result = (await detail(t)) as { attachments: Array<{ id: string }> };

    expect(result.attachments.map((a) => a.id)).toContain('att_section');
  });

  it('agrees with the dedicated course-attachments endpoint', async () => {
    // The two used to disagree: this was course-wide only, that was everything.
    const t = build();
    const viaDetail = (await detail(t)) as { attachments: Array<{ id: string }> };

    const viaEndpoint = (await t.service.attachments('crs_1', 'stu_1')) as Array<{ id: string }>;

    expect([...viaDetail.attachments].map((a) => a.id).sort()).toEqual(
      viaEndpoint.map((a) => a.id).sort(),
    );
  });

  it('never returns another course\'s attachment', async () => {
    const t = build([...ROWS, row({ id: 'att_other', courseId: 'crs_elsewhere' })]);
    const result = (await detail(t)) as { attachments: Array<{ id: string }> };

    expect(result.attachments.map((a) => a.id)).not.toContain('att_other');
  });

  it('never returns a soft-deleted attachment', async () => {
    const t = build([...ROWS, row({ id: 'att_gone', deletedAt: new Date() })]);
    const result = (await detail(t)) as { attachments: Array<{ id: string }> };

    expect(result.attachments.map((a) => a.id)).not.toContain('att_gone');
  });

  it('scopes the query to the course rather than filtering in memory', async () => {
    const t = build();
    await detail(t);

    expect(t.attachmentQueries[0]?.where).toMatchObject({ courseId: 'crs_1', deletedAt: null });
  });
});

describe('access marking', () => {
  it('marks a lecture PDF locked for a student without course access', async () => {
    const t = build();
    (t.service as unknown as { access: { resolve: unknown } }).access.resolve = jest.fn(
      async () => ({ canAccessContent: false, hasAccess: false }),
    );

    const result = (await detail(t)) as {
      attachments: Array<{ id: string; locked: boolean }>;
    };

    const lecture = result.attachments.find((a) => a.id === 'att_lecture');
    expect(lecture?.locked).toBe(true);
  });

  it('leaves a preview document unlocked without course access', async () => {
    const t = build([row({ id: 'att_preview', lessonId: 'les_1', isPreview: true })]);
    (t.service as unknown as { access: { resolve: unknown } }).access.resolve = jest.fn(
      async () => ({ canAccessContent: false, hasAccess: false }),
    );

    const result = (await detail(t)) as {
      attachments: Array<{ id: string; locked: boolean }>;
    };

    expect(result.attachments.find((a) => a.id === 'att_preview')?.locked).toBe(false);
  });
});