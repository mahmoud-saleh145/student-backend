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
    // Relations the publication filter walks. Prisma resolves them server-side;
    // the double here models them so the student/staff difference is exercised.
    lesson: null as unknown,
    section: null as unknown,
    ...over,
  };
}

/** A published lesson in a published section is the baseline for visibility. */
function published(row_: Record<string, unknown>, lessonId?: string, sectionId?: string) {
  return row({
    ...row_,
    lessonId: lessonId ?? null,
    sectionId: sectionId ?? null,
    lesson: lessonId ? { status: 'PUBLISHED', section: { status: 'PUBLISHED' } } : null,
    section: sectionId ? { status: 'PUBLISHED' } : null,
  });
}

const ROWS = [
  published({ id: 'att_lecture', title: 'Lecture slides.pdf' }, 'les_1'),
  published({ id: 'att_section', title: 'Section handout.pdf' }, undefined, 'sec_1'),
  published({ id: 'att_course', title: 'Syllabus.pdf' }),
];

/**
 * Mirrors the part of the Prisma query the attachments list depends on:
 * `courseId`, `deletedAt: null`, the optional `lessonId` filter and the nested
 * publication rules, plus `orderBy`. Without this the tests would pass whether
 * or not the query was right.
 */
function matches(r: Record<string, unknown>, where: Record<string, unknown>): boolean {
  if (where.courseId && r.courseId !== where.courseId) return false;
  if (where.deletedAt === null && r.deletedAt !== null) return false;
  if ('lessonId' in where && where.lessonId !== undefined && r.lessonId !== where.lessonId) {
    return false;
  }
  if ('sectionId' in where && where.sectionId !== undefined && r.sectionId !== where.sectionId) {
    return false;
  }

  const and = (where.AND ?? []) as Array<Record<string, unknown>>;
  for (const clause of and) {
    const ors = (clause.OR ?? []) as Array<Record<string, unknown>>;
    if (ors.length && !ors.some((o) => matches(r, o))) return false;
  }
  const or = (where.OR ?? []) as Array<Record<string, unknown>> | undefined;
  if (or?.length && !or.some((o) => matches(r, o))) return false;

  if (typeof where.lesson === 'object' && where.lesson !== null) {
    const want = where.lesson as { status: string; section?: { status: string } };
    const lesson = r.lesson as { status: string; section: { status: string } } | null;
    if (!lesson || lesson.status !== want.status) return false;
    // A lecture-scoped row carries a NULL sectionId, so its section is only
    // reachable through the lesson. The query must check it there.
    if (want.section && (!lesson.section || lesson.section.status !== want.section.status)) {
      return false;
    }
  }
  if (typeof where.section === 'object' && where.section !== null) {
    const want = (where.section as { status: string }).status;
    const section = r.section as { status: string } | null;
    if (!section || section.status !== want) return false;
  }
  return true;
}

function build(rows: Record<string, unknown>[] = ROWS) {
  const attachmentQueries: Record<string, unknown>[] = [];

  const stubbed = {
    course: { findFirst: jest.fn(async () => COURSE) },
    watchProgress: { findMany: jest.fn(async () => []) },
    attachment: {
      findMany: jest.fn(async (args: Record<string, unknown>) => {
        attachmentQueries.push(args);
        const where = (args.where ?? {}) as Record<string, unknown>;
        const orderBy = (args.orderBy ?? {}) as
          | { sortOrder?: string }
          | Array<{ lessonId?: string; sortOrder?: string }>;

        let out = rows.filter((r) => matches(r, where));

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
    const t = build([...ROWS, published({ id: 'att_other', courseId: 'crs_elsewhere' }, 'les_1')]);
    const result = (await detail(t)) as { attachments: Array<{ id: string }> };

    expect(result.attachments.map((a) => a.id)).not.toContain('att_other');
  });

  it('never returns a soft-deleted attachment', async () => {
    const t = build([...ROWS, published({ id: 'att_gone', deletedAt: new Date() }, 'les_1')]);
    const result = (await detail(t)) as { attachments: Array<{ id: string }> };

    expect(result.attachments.map((a) => a.id)).not.toContain('att_gone');
  });

  it('scopes the query to the course rather than filtering in memory', async () => {
    const t = build();
    await detail(t);

    expect(t.attachmentQueries[0]?.where).toMatchObject({ courseId: 'crs_1', deletedAt: null });
  });
});

/**
 * Publishing, not entitlement.
 *
 * `loadSections({ includeUnpublished: false })` already hides a draft lecture
 * from the outline, and `issueTicket` refuses its documents. Advertising the
 * document here anyway would leak the title of a lecture the student may not
 * open, then fail on click.
 */
describe('unpublished material stays off the student Materials list', () => {
  function draftLecture() {
    return {
      ...row({ id: 'att_draft', title: 'Draft slides.pdf', lessonId: 'les_draft' }),
      lesson: { status: 'DRAFT', section: { status: 'PUBLISHED' } },
    };
  }

  function draftSection() {
    return {
      ...row({ id: 'att_draftsec', title: 'Draft handout.pdf', sectionId: 'sec_draft' }),
      section: { status: 'DRAFT' },
    };
  }

  it('omits a PDF on a draft lecture', async () => {
    const t = build([...ROWS, draftLecture()]);
    const result = (await detail(t)) as { attachments: Array<{ id: string }> };

    expect(result.attachments.map((a) => a.id)).not.toContain('att_draft');
  });

  it('omits a handout on a draft section', async () => {
    const t = build([...ROWS, draftSection()]);
    const result = (await detail(t)) as { attachments: Array<{ id: string }> };

    expect(result.attachments.map((a) => a.id)).not.toContain('att_draftsec');
  });

  it('omits a PDF whose lesson sits in a draft section', async () => {
    const t = build([
      ...ROWS,
      {
        ...row({ id: 'att_insecdraft', lessonId: 'les_2' }),
        lesson: { status: 'PUBLISHED', section: { status: 'DRAFT' } },
      },
    ]);
    const result = (await detail(t)) as { attachments: Array<{ id: string }> };

    expect(result.attachments.map((a) => a.id)).not.toContain('att_insecdraft');
  });

  it('still shows course-wide documents, which belong to no lecture', async () => {
    const t = build([...ROWS, draftLecture()]);
    const result = (await detail(t)) as { attachments: Array<{ id: string }> };

    expect(result.attachments.map((a) => a.id)).toContain('att_course');
  });

  it('keeps them for staff, who author them', async () => {
    const t = build([...ROWS, draftLecture(), draftSection()]);
    const result = (await t.service.detail({
      courseId: 'crs_1',
      userId: 'staff_1',
      role: 'TEACHER' as never,
    })) as { attachments: Array<{ id: string }> };

    const ids = result.attachments.map((a) => a.id);
    expect(ids).toContain('att_draft');
    expect(ids).toContain('att_draftsec');
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
    const t = build([
      published({ id: 'att_preview', isPreview: true }, 'les_1'),
    ]);
    (t.service as unknown as { access: { resolve: unknown } }).access.resolve = jest.fn(
      async () => ({ canAccessContent: false, hasAccess: false }),
    );

    const result = (await detail(t)) as {
      attachments: Array<{ id: string; locked: boolean }>;
    };

    expect(result.attachments.find((a) => a.id === 'att_preview')?.locked).toBe(false);
  });
});