import { AppException } from '../../src/common/errors/app.exception';
import { LessonsService } from '../../src/modules/lessons/lessons.service';

/**
 * DELETING A LECTURE WHOSE VIDEO NEVER FINISHED UPLOADING
 * =======================================================
 *
 * THE REPORTED FAILURE
 * --------------------
 * Nine lectures of the platform are stuck with a video in `UPLOADING`: the
 * presigned PUT never landed, so `sourceSizeBytes`, `processingJobId` and
 * `gumletAssetId` are all NULL and there is no object in either R2 bucket.
 * Deleting those lectures from the dashboard answered 409 CONFLICT
 * "A record with this sectionId already exists" - an error about a UNIQUE
 * index, from an operation that inserts nothing.
 *
 * WHY
 * ---
 * `lessons` carries `@@unique([sectionId, sortOrder])`, and the index is NOT
 * partial: `CREATE UNIQUE INDEX "lessons_sectionId_sortOrder_key" ON
 * lessons("sectionId","sortOrder")` covers every row, soft-deleted ones
 * included. `remove()` sets `deletedAt` first and then ran
 *
 *     UPDATE lessons SET "sortOrder" = "sortOrder" - 1
 *     WHERE "sectionId" = $1 AND "sortOrder" > $2 AND "deletedAt" IS NULL
 *
 * which moves the lecture BELOW the deleted one into the slot the deleted row
 * still occupies. Two rows, one position -> 23505 -> P2002 -> the transaction
 * rolls back -> the delete never happened, and the handler reports
 * `target[0]` ("sectionId") of the compound key as the message.
 *
 * It failed for every lecture that was NOT the last one of its section, which
 * is 8 of the 9 stranded ones. The ninth sits alone in its section. Every
 * lecture deletion that ever succeeded (2026-10-09 .. 2026-10-12) had no live
 * lecture after it, so the statement matched nothing - the bug was invisible
 * until the first mid-section delete.
 *
 * NOTHING TO DO WITH VIDEO STATE
 * ------------------------------
 * The lecture path holds no storage client and no Gumlet client: it never
 * asks whether an asset exists, never lists a prefix, and never makes an HTTP
 * request. The stranded video simply becomes an archived metadata row (watch
 * events reference it) and its bytes are purged by a separate auditable job.
 *
 * The double below models the unique index over EVERY row and raises the real
 * P2002 shape from the raw statement, so these tests fail against the old code
 * rather than passing regardless. Transactions roll back on error, as Prisma's
 * do.
 */

type LessonRow = {
  id: string;
  courseId: string;
  sectionId: string;
  sortOrder: number;
  status: string;
  deletedAt: Date | null;
  title: string;
};

type VideoRow = {
  id: string;
  lessonId: string | null;
  status: string;
  deletedAt: Date | null;
  /** Only rows a video cannot have without an asset are relevant here. */
  gumletAssetId: string | null;
  lessonLinks: Array<{ lessonId: string }>;
};

type TicketRow = {
  id: string;
  videoId: string;
  lessonId: string;
  status: string;
  revokedAt?: Date | null;
  revokedReason?: string | null;
};

const SECTION = 'sec_mechanics';
const OTHER_SECTION = 'sec_drawing';
const COURSE = 'crs_mechanics';
const OTHER_COURSE = 'crs_drawing';
const ACTOR = { id: 'usr_master', role: 'MASTER' } as never;

/** The exact shape Prisma raises for `lessons_sectionId_sortOrder_key`. */
function p2002(): never {
  throw Object.assign(
    new Error('Unique constraint failed on the fields: (`sectionId`,`sortOrder`)'),
    { code: 'P2002', meta: { target: ['sectionId', 'sortOrder'] } },
  );
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(where ?? {})) {
    if (value === undefined) continue;
    if (row[key] !== value) return false;
  }
  return true;
}

function build() {
  const lessons: LessonRow[] = [];
  for (let i = 1; i <= 7; i += 1) {
    lessons.push({
      id: `les_${i}`,
      courseId: COURSE,
      sectionId: SECTION,
      sortOrder: i,
      status: 'DRAFT',
      deletedAt: null,
      title: `Lecture ${i}`,
    });
  }
  lessons.push({
    id: 'les_other',
    courseId: OTHER_COURSE,
    sectionId: OTHER_SECTION,
    sortOrder: 1,
    status: 'PUBLISHED',
    deletedAt: null,
    title: 'Lecture of another course',
  });

  const videos: VideoRow[] = [
    {
      // The stranded row, exactly as production has it: key minted at init,
      // PUT never landed, no job, no asset.
      id: 'vid_stranded',
      lessonId: 'les_5',
      status: 'UPLOADING',
      deletedAt: null,
      gumletAssetId: null,
      lessonLinks: [{ lessonId: 'les_5' }],
    },
    {
      // Owned by the same lecture but attached to a lecture elsewhere:
      // deleting this lecture must NOT archive it.
      id: 'vid_shared',
      lessonId: 'les_5',
      status: 'READY',
      deletedAt: null,
      gumletAssetId: 'asset_shared',
      lessonLinks: [{ lessonId: 'les_5' }, { lessonId: 'les_other' }],
    },
    {
      id: 'vid_ready',
      lessonId: 'les_3',
      status: 'READY',
      deletedAt: null,
      gumletAssetId: 'asset_ready',
      lessonLinks: [{ lessonId: 'les_3' }],
    },
  ];

  const tickets: TicketRow[] = [
    { id: 'tk_5', videoId: 'vid_stranded', lessonId: 'les_5', status: 'ACTIVE' },
    { id: 'tk_3', videoId: 'vid_ready', lessonId: 'les_3', status: 'ACTIVE' },
    { id: 'tk_other', videoId: 'vid_ready', lessonId: 'les_other', status: 'ACTIVE' },
  ];

  const raw: string[] = [];

  /** Every statement must leave the compound unique index satisfied. */
  function assertUniquePositions(): void {
    const seen = new Set<string>();
    for (const row of lessons) {
      const key = `${row.sectionId}|${row.sortOrder}`;
      if (seen.has(key)) p2002();
      seen.add(key);
    }
  }

  const lesson = {
    findFirst: jest.fn(
      async (args: { where: Record<string, unknown>; orderBy?: Record<string, 'asc' | 'desc'> }) => {
        let rows = lessons.filter((row) => matches(row as never, args.where ?? {}));
        const direction = args.orderBy?.sortOrder;
        if (direction === 'desc') rows = [...rows].sort((a, b) => b.sortOrder - a.sortOrder);
        if (direction === 'asc') rows = [...rows].sort((a, b) => a.sortOrder - b.sortOrder);
        return rows[0] ?? null;
      },
    ),
    findMany: jest.fn(async (args: { where: Record<string, unknown> }) =>
      lessons.filter((row) => matches(row as never, args.where ?? {})),
    ),
    update: jest.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = lessons.find((r) => r.id === args.where.id);
      if (!row) throw new Error('Record to update not found.');
      Object.assign(row, args.data);
      return row;
    }),
    updateMany: jest.fn(async () => ({ count: 0 })),
    create: jest.fn(async (args: { data: Record<string, unknown> }) => {
      const data = args.data as Record<string, unknown>;
      const row: LessonRow = {
        id: `les_new_${lessons.length}`,
        courseId: COURSE,
        sectionId: String(data.sectionId),
        sortOrder: Number(data.sortOrder),
        status: String(data.status ?? 'DRAFT'),
        deletedAt: null,
        title: String(data.title ?? ''),
      };
      // The compound unique index covers deleted rows too - this is what made
      // "add lecture -> delete it -> add another" answer 409 in production.
      if (lessons.some((r) => r.sectionId === row.sectionId && r.sortOrder === row.sortOrder)) {
        p2002();
      }
      lessons.push(row);
      return row;
    }),
  };

  const video = {
    findMany: jest.fn(async (args: { where: { lessonId: string } }) =>
      videos
        .filter((v) => v.lessonId === args.where.lessonId)
        .map((v) => ({ id: v.id, lessonLinks: v.lessonLinks })),
    ),
    updateMany: jest.fn(
      async (args: { where: { id: { in: string[] } }; data: Record<string, unknown> }) => {
        let count = 0;
        for (const row of videos) {
          if (args.where.id.in.includes(row.id)) {
            Object.assign(row, args.data);
            count += 1;
          }
        }
        return { count };
      },
    ),
  };

  const playbackTicket = {
    updateMany: jest.fn(
      async (args: { where: { lessonId?: string; status?: string }; data: Record<string, unknown> }) => {
        let count = 0;
        for (const row of tickets) {
          if (args.where.lessonId !== undefined && row.lessonId !== args.where.lessonId) continue;
          if (args.where.status !== undefined && row.status !== args.where.status) continue;
          Object.assign(row, args.data);
          count += 1;
        }
        return { count };
      },
    ),
  };

  const courseSection = {
    findFirst: jest.fn(async () => ({ id: SECTION, courseId: COURSE })),
  };

  const $executeRaw = jest.fn(
    async (chunks: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
      const sql = chunks.join('?').replace(/\s+/g, ' ').trim();
      raw.push(sql);

      if (sql.includes('"sortOrder" = "sortOrder" - 1')) {
        // The shifting statement `remove()` used to run.
        const sectionId = String(values[0]);
        const from = Number(values[1]);
        for (const row of lessons) {
          if (row.sectionId === sectionId && row.sortOrder > from && row.deletedAt === null) {
            row.sortOrder -= 1;
          }
        }
      } else if (
        sql.includes('"sortOrder" = -"sortOrder" - 1000') &&
        sql.includes('"deletedAt" IS NOT NULL')
      ) {
        // Vacating the positions held by deleted lectures.
        const sectionId = String(values[0]);
        for (const row of lessons) {
          if (row.sectionId === sectionId && row.deletedAt !== null && row.sortOrder >= 0) {
            row.sortOrder = -row.sortOrder - 1000;
          }
        }
      } else if (
        sql.includes('"sortOrder" = -"sortOrder" - 1000') &&
        sql.includes('"deletedAt" IS NULL')
      ) {
        // `reorder()`: park the live lectures before renumbering them.
        const sectionId = String(values[0]);
        for (const row of lessons) {
          if (row.sectionId === sectionId && row.deletedAt === null) {
            row.sortOrder = -row.sortOrder - 1000;
          }
        }
      } else {
        throw new Error(`unhandled raw statement: ${sql}`);
      }

      assertUniquePositions();
      return 0;
    },
  );

  const models = { lesson, video, playbackTicket, courseSection };

  const snapshot = () => ({
    lessons: lessons.map((r) => ({ ...r })),
    videos: videos.map((r) => ({ ...r, lessonLinks: [...r.lessonLinks] })),
    tickets: tickets.map((r) => ({ ...r })),
  });
  const restore = (snap: ReturnType<typeof snapshot>) => {
    lessons.splice(0, lessons.length, ...snap.lessons);
    videos.splice(0, videos.length, ...snap.videos);
    tickets.splice(0, tickets.length, ...snap.tickets);
  };

  const tx = { ...models, $executeRaw };

  const prisma = {
    ...models,
    watchProgress: { count: jest.fn(async () => 2) },
    // Prisma rolls an interactive transaction back when the callback throws.
    $transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => {
      const before = snapshot();
      try {
        return await fn(tx);
      } catch (error) {
        restore(before);
        throw error;
      }
    }),
  };

  const access = {
    assertCanManageCourse: jest.fn(async () => undefined),
    assertTeacherCapability: jest.fn(async () => undefined),
  };
  const courses = { recountCourse: jest.fn(async () => undefined) };
  const audit = { record: jest.fn(async () => undefined) };

  // The real constructor: prisma, access, courses, audit.
  const service = new LessonsService(
    prisma as never,
    access as never,
    courses as never,
    audit as never,
  );

  const lessonById = (id: string) => lessons.find((r) => r.id === id);
  const videoById = (id: string) => videos.find((r) => r.id === id);
  const ticketById = (id: string) => tickets.find((r) => r.id === id);
  const liveIn = (sectionId: string) =>
    lessons
      .filter((r) => r.sectionId === sectionId && r.deletedAt === null)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  const positionsIn = (sectionId: string) =>
    lessons.filter((r) => r.sectionId === sectionId).map((r) => r.sortOrder);

  return {
    service,
    prisma,
    access,
    courses,
    audit,
    raw,
    lessonById,
    videoById,
    ticketById,
    liveIn,
    positionsIn,
    remove: (id: string) => service.remove(id, ACTOR),
  };
}

/** No two rows of a section - deleted or not - may share a position. */
function expectPositionsUnique(t: ReturnType<typeof build>) {
  for (const sectionId of [SECTION, OTHER_SECTION]) {
    const positions = t.positionsIn(sectionId);
    expect(new Set(positions).size).toBe(positions.length);
  }
}

describe('deleting a lecture whose video is stuck in UPLOADING', () => {
  it('succeeds even when another lecture follows it in the section', async () => {
    // THE REPORTED FAILURE: mid-section delete -> 409 CONFLICT.
    const t = build();

    const result = await t.remove('les_5');

    expect(result).toEqual({ ok: true, preservedWatchRecords: 2 });
    expect(t.lessonById('les_5')!.deletedAt).toBeInstanceOf(Date);
    expect(t.lessonById('les_5')!.status).toBe('ARCHIVED');
    expectPositionsUnique(t);
  });

  it('keeps every surviving lecture of the section, in its original order', async () => {
    const t = build();

    await t.remove('les_5');

    expect(t.liveIn(SECTION).map((l) => l.id)).toEqual([
      'les_1',
      'les_2',
      'les_3',
      'les_4',
      'les_6',
      'les_7',
    ]);
    expectPositionsUnique(t);
  });

  it('archives the video row without inventing an asset or a job', async () => {
    const t = build();

    await t.remove('les_5');

    const stranded = t.videoById('vid_stranded')!;
    expect(stranded).toMatchObject({
      status: 'ARCHIVED',
      deletedAt: null,
      gumletAssetId: null,
      lessonId: 'les_5',
    });
    // The row is retained - watch events reference it - and the link row with it.
    expect(stranded.lessonLinks).toEqual([{ lessonId: 'les_5' }]);
  });

  it('never calls Gumlet and never touches storage: this path has no such client', async () => {
    const t = build();

    await t.remove('les_5');

    const deps = t.service as unknown as Record<string, unknown>;
    expect(deps.storage).toBeUndefined();
    expect(deps.gumletIngest).toBeUndefined();
    expect(deps.queue).toBeUndefined();
    // Every raw statement this path issues targets `lessons` only.
    expect(t.raw.length).toBeGreaterThan(0);
    for (const sql of t.raw) expect(sql).toMatch(/^UPDATE lessons\b/);
    expect(t.raw.join(' ')).not.toMatch(/videos|storage|gumlet|DELETE FROM|DROP/i);
  });

  it('leaves a video shared with another lecture alone', async () => {
    const t = build();

    await t.remove('les_5');

    expect(t.videoById('vid_shared')).toMatchObject({
      status: 'READY',
      deletedAt: null,
      gumletAssetId: 'asset_shared',
    });
    expect(t.lessonById('les_other')).toMatchObject({ deletedAt: null, status: 'PUBLISHED' });
    expect(t.liveIn(OTHER_SECTION).map((l) => l.id)).toEqual(['les_other']);
    expectPositionsUnique(t);
  });

  it('revokes the playback grant of THIS lecture only', async () => {
    const t = build();

    await t.remove('les_5');

    expect(t.ticketById('tk_5')).toMatchObject({
      status: 'REVOKED',
      revokedReason: 'Lecture deleted',
    });
    expect(t.ticketById('tk_3')!.status).toBe('ACTIVE');
    expect(t.ticketById('tk_other')!.status).toBe('ACTIVE');
  });

  it('records the deletion with the number of watch records kept', async () => {
    const t = build();

    await t.remove('les_5');

    expect(t.audit.record).toHaveBeenCalledWith({
      actorId: 'usr_master',
      actorRole: 'MASTER',
      action: 'DELETE',
      entity: 'lesson',
      entityId: 'les_5',
      note: 'Soft-deleted; 2 watch records preserved',
    });
  });
});

describe('authorisation and repeated deletion', () => {
  it('checks the course before it changes anything', async () => {
    const t = build();
    t.access.assertCanManageCourse.mockRejectedValueOnce(
      new AppException('NOT_COURSE_TEACHER' as never, { message: 'You are not assigned to this course' }),
    );

    await expect(t.remove('les_5')).rejects.toThrow(/not assigned to this course/i);

    expect(t.prisma.$transaction).not.toHaveBeenCalled();
    expect(t.lessonById('les_5')).toMatchObject({ deletedAt: null, status: 'DRAFT' });
    expect(t.videoById('vid_stranded')!.status).toBe('UPLOADING');
  });

  it('still applies the platform-wide delete capability', async () => {
    const t = build();

    await t.remove('les_5');

    expect(t.access.assertTeacherCapability).toHaveBeenCalledWith('MASTER', 'deleteLectures');
  });

  it('refuses a second deletion with a not-found, without writing again', async () => {
    const t = build();

    await t.remove('les_5');
    const writesAfterFirst = t.prisma.$transaction.mock.calls.length;

    await expect(t.remove('les_5')).rejects.toBeInstanceOf(AppException);
    expect(t.prisma.$transaction.mock.calls.length).toBe(writesAfterFirst);
  });
});

describe('the section stays usable after the deletion', () => {
  it('can still be reordered - a deleted lecture no longer holds a live position', async () => {
    const t = build();

    await t.remove('les_5');

    const survivors = t.liveIn(SECTION).map((l) => l.id);
    await t.service.reorder(SECTION, survivors, ACTOR);

    expect(t.liveIn(SECTION).map((l) => l.sortOrder)).toEqual([1, 2, 3, 4, 5, 6]);
    expectPositionsUnique(t);
  });

  it('can take a new lecture afterwards', async () => {
    const t = build();

    await t.remove('les_5');

    const created = await t.service.create(
      SECTION,
      { title: 'Replacement lecture' },
      ACTOR,
    );

    expect(created).toMatchObject({ sectionId: SECTION, sortOrder: expect.any(Number) });
    expectPositionsUnique(t);
  });
});
