import { SectionsService } from '../../src/modules/sections/sections.service';

/**
 * A SOFT-DELETED SECTION STILL HOLDS ITS POSITION IN THE UNIQUE INDEX
 * ===================================================================
 *
 * THE REPORTED FAILURE
 * --------------------
 * Adding a section to a course answered 409 CONFLICT. The course had two
 * sections, at positions 1 and 2, and both had been deleted.
 *
 * WHY
 * ---
 * `course_sections` carries `@@unique([courseId, sortOrder])`, and the index is
 * NOT partial: `CREATE UNIQUE INDEX "course_sections_courseId_sortOrder_key" ON
 * course_sections("courseId","sortOrder")` covers every row, soft-deleted ones
 * included. `remove()` sets `deletedAt` and leaves `sortOrder` alone, while
 * `create()` picked the next position from the highest LIVE one:
 *
 *     const last = await tx.courseSection.findFirst({ where: { courseId, ...notDeleted }, ... });
 *     const target = input.sortOrder ?? (last?.sortOrder ?? 0) + 1;
 *
 * so the new section was given a position a deleted row still occupied, and the
 * insert raised P2002. The same blindness sat in the three other paths that
 * write positions: the explicit-position shift, `reorder()`, and the "close the
 * gap" statement of `remove()` - which moves the next live section onto the row
 * that same call has just soft-deleted.
 *
 * The double below models the unique index over EVERY row of a course and
 * raises the real P2002 shape from whichever statement breaks it, so these
 * tests fail against the old code for that reason rather than passing
 * regardless. It interprets the raw statements the service issues, refuses one
 * it does not recognise, and rolls a transaction back on error, as Prisma does.
 * (Postgres checks the index row by row inside a statement; the double checks
 * once per statement, which is the more lenient of the two.)
 */

type SectionRow = {
  id: string;
  courseId: string;
  title: string;
  sortOrder: number;
  status: string;
  deletedAt: Date | null;
};

const COURSE = 'crs_statics';
const OTHER_COURSE = 'crs_thermo';
const ACTOR = { id: 'usr_master', role: 'MASTER' } as never;

/** The exact shape Prisma raises for `course_sections_courseId_sortOrder_key`. */
function p2002(): never {
  throw Object.assign(
    new Error('Unique constraint failed on the fields: (`courseId`,`sortOrder`)'),
    { code: 'P2002', meta: { target: ['courseId', 'sortOrder'] } },
  );
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(where ?? {})) {
    if (value === undefined) continue;
    if (row[key] !== value) return false;
  }
  return true;
}

/**
 * `live` and `deleted` are the positions the course starts with. A second
 * course is always present, with a live section at 1 and a deleted one at 2, so
 * a statement that forgets its `courseId` shows up as a changed row there.
 */
function build(seed: { live?: number[]; deleted?: number[] } = {}) {
  const rows: SectionRow[] = [];
  const raw: string[] = [];
  let nextId = 1;

  const put = (courseId: string, sortOrder: number, deleted: boolean, id: string) => {
    rows.push({
      id,
      courseId,
      title: id,
      sortOrder,
      status: deleted ? 'ARCHIVED' : 'PUBLISHED',
      deletedAt: deleted ? new Date('2026-11-01T00:00:00Z') : null,
    });
  };

  for (const position of seed.live ?? []) put(COURSE, position, false, `live_${position}`);
  for (const position of seed.deleted ?? []) put(COURSE, position, true, `del_${position}`);
  put(OTHER_COURSE, 1, false, 'other_live_1');
  put(OTHER_COURSE, 2, true, 'other_del_2');

  /** Every statement must leave the compound unique index satisfied. */
  function assertUniquePositions(): void {
    const seen = new Set<string>();
    for (const row of rows) {
      const key = `${row.courseId}|${row.sortOrder}`;
      if (seen.has(key)) p2002();
      seen.add(key);
    }
  }

  const courseSection = {
    findFirst: jest.fn(
      async (args: {
        where: Record<string, unknown>;
        orderBy?: Record<string, 'asc' | 'desc'>;
      }) => {
        let found = rows.filter((row) => matches(row as never, args.where ?? {}));
        const direction = args.orderBy?.sortOrder;
        if (direction === 'desc') found = [...found].sort((a, b) => b.sortOrder - a.sortOrder);
        if (direction === 'asc') found = [...found].sort((a, b) => a.sortOrder - b.sortOrder);
        // A copy, as Prisma returns: the caller must not see later writes.
        return found[0] ? { ...found[0] } : null;
      },
    ),
    findMany: jest.fn(async (args: { where: Record<string, unknown> }) =>
      rows
        .filter((row) => matches(row as never, args.where ?? {}))
        .sort((a, b) => a.sortOrder - b.sortOrder)
        // `listForCourse()` reads the lectures of each section; there are none.
        .map((row) => ({ ...row, lessons: [], _count: { lessons: 0 } })),
    ),
    create: jest.fn(async (args: { data: Record<string, unknown> }) => {
      const row: SectionRow = {
        id: `sec_new_${nextId++}`,
        courseId: String(args.data.courseId),
        title: String(args.data.title ?? ''),
        sortOrder: Number(args.data.sortOrder),
        status: String(args.data.status ?? 'PUBLISHED'),
        deletedAt: null,
      };
      // The index covers deleted rows too - this is what answered 409.
      if (rows.some((r) => r.courseId === row.courseId && r.sortOrder === row.sortOrder)) {
        p2002();
      }
      rows.push(row);
      return { ...row };
    }),
    update: jest.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = rows.find((r) => r.id === args.where.id);
      if (!row) throw new Error('Record to update not found.');
      Object.assign(row, args.data);
      assertUniquePositions();
      return { ...row };
    }),
  };

  const $executeRaw = jest.fn(
    async (chunks: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
      const sql = chunks.join('?').replace(/\s+/g, ' ').trim();
      raw.push(sql);
      let count = 0;

      const parked = /LEAST\(MIN\("sortOrder"\), (-\d+)\) FROM course_sections WHERE "courseId" = \? \) - 1 - "sortOrder"/.exec(
        sql,
      );

      if (
        parked &&
        sql.includes('"deletedAt" IS NOT NULL') &&
        sql.includes('"sortOrder" >= ?') &&
        sql.includes('"sortOrder" <= ?')
      ) {
        // `vacateDeletedPositions()`: deleted rows of one course, in a range.
        // The sub-select reads the course as it was before the statement.
        const [minOf, courseId, from, to] = [
          String(values[0]),
          String(values[1]),
          Number(values[2]),
          Number(values[3]),
        ];
        const lowest = Math.min(...rows.filter((r) => r.courseId === minOf).map((r) => r.sortOrder));
        const floor = Math.min(lowest, Number(parked[1]));
        for (const row of rows) {
          if (
            row.courseId === courseId &&
            row.deletedAt !== null &&
            row.sortOrder >= from &&
            row.sortOrder <= to
          ) {
            row.sortOrder = floor - 1 - row.sortOrder;
            count += 1;
          }
        }
      } else if (sql.includes('SET "sortOrder" = -("sortOrder" + 1) WHERE')) {
        // `create()` at an explicit position, phase 1: live rows at/after it.
        if (!sql.includes('"deletedAt" IS NULL')) throw new Error(`unexpected shift: ${sql}`);
        const [courseId, target] = [String(values[0]), Number(values[1])];
        for (const row of rows) {
          if (row.courseId === courseId && row.sortOrder >= target && row.deletedAt === null) {
            row.sortOrder = -(row.sortOrder + 1);
            count += 1;
          }
        }
      } else if (sql.includes('SET "sortOrder" = -"sortOrder" - 1000 WHERE')) {
        // `reorder()`: park the live sections before renumbering them.
        if (!sql.includes('"deletedAt" IS NULL')) throw new Error(`unexpected park: ${sql}`);
        const courseId = String(values[0]);
        for (const row of rows) {
          if (row.courseId === courseId && row.deletedAt === null) {
            row.sortOrder = -row.sortOrder - 1000;
            count += 1;
          }
        }
      } else if (sql.includes('SET "sortOrder" = -"sortOrder" WHERE')) {
        // `create()` at an explicit position, phase 2: flip negatives back.
        // Applied to exactly the rows the statement names - every negative row
        // of the course unless it says live rows only.
        const liveOnly = sql.includes('"deletedAt" IS NULL');
        const courseId = String(values[0]);
        for (const row of rows) {
          if (row.courseId !== courseId || row.sortOrder >= 0) continue;
          if (liveOnly && row.deletedAt !== null) continue;
          row.sortOrder = -row.sortOrder;
          count += 1;
        }
      } else if (sql.includes('SET "sortOrder" = -("sortOrder" - 1) WHERE')) {
        // `remove()`, phase 1: the live sections after the deleted one go to
        // negative space; the flip above (live rows only) brings them back one
        // position lower.
        if (!sql.includes('"deletedAt" IS NULL')) throw new Error(`unexpected shift: ${sql}`);
        const [courseId, after] = [String(values[0]), Number(values[1])];
        for (const row of rows) {
          if (row.courseId === courseId && row.sortOrder > after && row.deletedAt === null) {
            row.sortOrder = -(row.sortOrder - 1);
            count += 1;
          }
        }
      } else if (sql.includes('SET "sortOrder" = "sortOrder" - 1 WHERE')) {
        // The single-statement gap close. Postgres checks the unique index row
        // by row, so this is applied here in the order that exposes it: highest
        // position first. Moving 3 -> 2 while 2 is still held fails, exactly as
        // it did on Postgres 16 when the rows were stored in that order.
        const [courseId, after] = [String(values[0]), Number(values[1])];
        const moving = rows
          .filter((row) => row.courseId === courseId && row.sortOrder > after && row.deletedAt === null)
          .sort((a, b) => b.sortOrder - a.sortOrder);
        for (const row of moving) {
          row.sortOrder -= 1;
          assertUniquePositions();
          count += 1;
        }
      } else {
        throw new Error(`unhandled raw statement: ${sql}`);
      }

      assertUniquePositions();
      return count;
    },
  );

  const tx = {
    courseSection,
    lesson: {
      updateMany: jest.fn(async () => ({ count: 0 })),
      findMany: jest.fn(async () => []),
    },
    video: {
      findMany: jest.fn(async () => []),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    playbackTicket: { updateMany: jest.fn(async () => ({ count: 0 })) },
    $executeRaw,
  };

  const prisma = {
    courseSection,
    lesson: { count: jest.fn(async () => 0) },
    watchProgress: { count: jest.fn(async () => 0) },
    // Prisma rolls an interactive transaction back when the callback throws.
    $transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => {
      const before = rows.map((r) => ({ ...r }));
      try {
        return await fn(tx);
      } catch (error) {
        rows.splice(0, rows.length, ...before);
        throw error;
      }
    }),
  };

  const access = {
    assertCanManageCourse: jest.fn(async () => undefined),
    assertTeacherCapability: jest.fn(async () => undefined),
    staffMayViewCourse: jest.fn(async () => true),
  };
  const courses = { recountCourse: jest.fn(async () => undefined) };
  const audit = { record: jest.fn(async () => undefined) };

  // The real constructor: prisma, access, courses, audit (announcer optional).
  const service = new SectionsService(
    prisma as never,
    access as never,
    courses as never,
    audit as never,
  );

  const byId = (id: string) => rows.find((r) => r.id === id)!;
  const liveIn = (courseId = COURSE) =>
    rows
      .filter((r) => r.courseId === courseId && r.deletedAt === null)
      .sort((a, b) => a.sortOrder - b.sortOrder);

  return {
    service,
    rows,
    raw,
    byId,
    /** Live sections of the course in order, as `id@position`. */
    live: (courseId = COURSE) => liveIn(courseId).map((r) => `${r.id}@${r.sortOrder}`),
    livePositions: (courseId = COURSE) => liveIn(courseId).map((r) => r.sortOrder),
    liveIds: (courseId = COURSE) => liveIn(courseId).map((r) => r.id),
    positionsIn: (courseId: string) =>
      rows.filter((r) => r.courseId === courseId).map((r) => r.sortOrder),
    add: (sortOrder?: number) =>
      service.create(
        COURSE,
        { title: 'Section', ...(sortOrder === undefined ? {} : { sortOrder }) },
        ACTOR,
      ),
    remove: (id: string) => service.remove(id, ACTOR),
    reorder: (ids: string[]) => service.reorder(COURSE, ids, ACTOR),
  };
}

type Harness = ReturnType<typeof build>;

/** No two rows of a course - deleted or not - may share a position. */
function expectPositionsUnique(t: Harness) {
  for (const courseId of [COURSE, OTHER_COURSE]) {
    const positions = t.positionsIn(courseId);
    expect(new Set(positions).size).toBe(positions.length);
  }
}

/** The other course is never part of any of this. */
function expectOtherCourseUntouched(t: Harness) {
  expect(t.byId('other_live_1')).toMatchObject({ sortOrder: 1, deletedAt: null });
  expect(t.byId('other_del_2').sortOrder).toBe(2);
}

describe('adding a section to a course that has soft-deleted sections', () => {
  it('succeeds when the only sections of the course are deleted ones', async () => {
    // THE REPORTED FAILURE: deleted at 1 and 2, nothing live -> 409 CONFLICT.
    const t = build({ deleted: [1, 2] });

    const created = await t.add();

    expect(created).toMatchObject({ courseId: COURSE, sortOrder: 1, deletedAt: null });
    expect(t.livePositions()).toEqual([1]);
    expectPositionsUnique(t);
    expectOtherCourseUntouched(t);
  });

  it('keeps going: the second and third section land on 2 and 3', async () => {
    const t = build({ deleted: [1, 2] });

    await t.add();
    await t.add();
    await t.add();

    expect(t.livePositions()).toEqual([1, 2, 3]);
    expectPositionsUnique(t);
  });

  it('succeeds when a deleted section sits directly after the last live one', async () => {
    // The state four production courses are in: live 1,2 and a deleted row at 3.
    const t = build({ live: [1, 2], deleted: [3] });

    const created = await t.add();

    expect(created).toMatchObject({ sortOrder: 3 });
    expect(t.live().slice(0, 2)).toEqual(['live_1@1', 'live_2@2']);
    expect(t.livePositions()).toEqual([1, 2, 3]);
    expectPositionsUnique(t);
  });

  it('moves only the deleted row that is in the way, and only off the positive line', async () => {
    const t = build({ live: [1, 2], deleted: [3, 4, 7] });

    await t.add();

    expect(t.byId('del_3').sortOrder).toBeLessThan(0);
    expect(t.byId('del_3')).toMatchObject({ status: 'ARCHIVED' });
    expect(t.byId('del_3').deletedAt).toBeInstanceOf(Date);
    // Not in the way of this request, so not written by it.
    expect(t.byId('del_4').sortOrder).toBe(4);
    expect(t.byId('del_7').sortOrder).toBe(7);
    expectPositionsUnique(t);
    expectOtherCourseUntouched(t);
  });

  it('writes no deleted row at all when none is in the way', async () => {
    const t = build({ live: [1, 2], deleted: [7] });

    const created = await t.add();

    expect(created).toMatchObject({ sortOrder: 3 });
    expect(t.byId('del_7').sortOrder).toBe(7);
    expectPositionsUnique(t);
  });
});

describe('inserting a section at an explicit position', () => {
  it('shifts past a deleted section that sits after the last live one', async () => {
    // Live 1,2 move to 2,3 - and 3 is where the deleted row was.
    const t = build({ live: [1, 2], deleted: [3] });

    const created = await t.add(1);

    expect(created).toMatchObject({ sortOrder: 1 });
    expect(t.live()).toEqual([`${created.id}@1`, 'live_1@2', 'live_2@3']);
    expect(t.byId('del_3').sortOrder).toBeLessThan(0);
    expectPositionsUnique(t);
  });

  it('takes the target position itself from a deleted section', async () => {
    const t = build({ live: [1, 2], deleted: [3] });

    const created = await t.add(3);

    expect(created).toMatchObject({ sortOrder: 3 });
    expect(t.livePositions()).toEqual([1, 2, 3]);
    expectPositionsUnique(t);
  });

  it('takes a target beyond the end from a deleted section', async () => {
    const t = build({ live: [1, 2], deleted: [5] });

    const created = await t.add(5);

    expect(created).toMatchObject({ sortOrder: 5 });
    expect(t.livePositions()).toEqual([1, 2, 5]);
    expectPositionsUnique(t);
  });

  it('leaves a deleted section beyond the shifted block where it is', async () => {
    // Inserting at 2 writes positions 2..4; the deleted row at 6 is not there.
    const t = build({ live: [1, 2, 3], deleted: [4, 6] });

    const created = await t.add(2);

    expect(t.live()).toEqual(['live_1@1', `${created.id}@2`, 'live_2@3', 'live_3@4']);
    expect(t.byId('del_4').sortOrder).toBeLessThan(0);
    expect(t.byId('del_6').sortOrder).toBe(6);
    expectPositionsUnique(t);
  });

  it('does not bring a parked deleted section back when flipping the shifted block', async () => {
    // The flip is the second half of the shift. Unfiltered, it would turn every
    // negative row of the course positive - parked deleted sections included.
    const t = build({ live: [1, 2], deleted: [3] });
    await t.add(); // parks del_3
    const parkedAt = t.byId('del_3').sortOrder;
    expect(parkedAt).toBeLessThan(0);

    await t.add(1);

    expect(t.byId('del_3').sortOrder).toBe(parkedAt);
    expect(t.livePositions()).toEqual([1, 2, 3, 4]);
    expectPositionsUnique(t);
  });
});

describe('a course with no deleted sections keeps exactly the positions it gets today', () => {
  it('appends 1, 2, 3 to an empty course', async () => {
    const t = build();

    const first = await t.add();
    const second = await t.add();
    const third = await t.add();

    expect([first.sortOrder, second.sortOrder, third.sortOrder]).toEqual([1, 2, 3]);
    expect(t.live()).toEqual([`${first.id}@1`, `${second.id}@2`, `${third.id}@3`]);
  });

  it('appends after the highest live position', async () => {
    const t = build({ live: [1, 2, 3] });

    const created = await t.add();

    expect(t.live()).toEqual(['live_1@1', 'live_2@2', 'live_3@3', `${created.id}@4`]);
  });

  it('inserts at an explicit position and shifts the rest up by one', async () => {
    const t = build({ live: [1, 2, 3] });

    const created = await t.add(2);

    expect(t.live()).toEqual(['live_1@1', `${created.id}@2`, 'live_2@3', 'live_3@4']);
  });

  it('accepts an explicit position beyond the end as given', async () => {
    const t = build({ live: [1, 2] });

    const created = await t.add(9);
    const next = await t.add();

    expect(t.live()).toEqual(['live_1@1', 'live_2@2', `${created.id}@9`, `${next.id}@10`]);
  });

  it('reorders to 1..N in the order asked for', async () => {
    const t = build({ live: [1, 2, 3] });

    await t.reorder(['live_3', 'live_1', 'live_2']);

    expect(t.live()).toEqual(['live_3@1', 'live_1@2', 'live_2@3']);
  });

  it('never moves a row of the course to make room: no row is deleted', async () => {
    const t = build({ live: [1, 2, 3] });

    await t.add();
    await t.add(1);
    await t.reorder(t.liveIds());

    // Every row is live and on 1..N - nothing was parked anywhere.
    expect(t.positionsIn(COURSE).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expectOtherCourseUntouched(t);
  });
});

describe('deleting a section', () => {
  it('succeeds when a live section follows it, and closes the gap', async () => {
    // "Close the gap" moved the next live section onto the row just deleted.
    const t = build({ live: [1, 2, 3] });

    const result = await t.remove('live_1');

    expect(result).toEqual({ ok: true, preservedWatchRecords: 0 });
    expect(t.byId('live_1').deletedAt).toBeInstanceOf(Date);
    expect(t.byId('live_1')).toMatchObject({ status: 'ARCHIVED' });
    expect(t.byId('live_1').sortOrder).toBeLessThan(0);
    expect(t.live()).toEqual(['live_2@1', 'live_3@2']);
    expectPositionsUnique(t);
    expectOtherCourseUntouched(t);
  });

  it('gives up the position of the last section too, so the next one can take it', async () => {
    const t = build({ live: [1, 2] });

    await t.remove('live_2');
    const created = await t.add();

    expect(t.byId('live_2').sortOrder).toBeLessThan(0);
    expect(t.live()).toEqual(['live_1@1', `${created.id}@2`]);
    expectPositionsUnique(t);
  });

  it('survives the same position being deleted again and again', async () => {
    // A parking spot derived from the position alone (-position - 1000) is
    // the same spot the second time round.
    const t = build({ live: [1] });

    for (let round = 0; round < 4; round += 1) {
      const created = await t.add();
      expect(created).toMatchObject({ sortOrder: 2 });
      await t.remove(created.id);
      expectPositionsUnique(t);
    }

    expect(t.live()).toEqual(['live_1@1']);
    expect(t.rows.filter((r) => r.courseId === COURSE && r.deletedAt !== null)).toHaveLength(4);
  });

  it('leaves an already-deleted section above the live ones where it is', async () => {
    // Closing the gap writes positions 1..2 here; the deleted row at 4 is not
    // among them.
    const t = build({ live: [1, 2, 3], deleted: [4] });

    await t.remove('live_1');

    expect(t.live()).toEqual(['live_2@1', 'live_3@2']);
    expect(t.byId('del_4').sortOrder).toBe(4);
    expectPositionsUnique(t);
  });

  it('steps past a deleted section sitting between the live ones', async () => {
    // Reachable through an explicit position beyond the end: live 1,2,4 with a
    // deleted row at 3. Closing the gap after 1 moves 4 onto 3.
    const t = build({ live: [1, 2, 4], deleted: [3] });

    await t.remove('live_1');

    expect(t.live()).toEqual(['live_2@1', 'live_4@3']);
    expect(t.byId('del_3').sortOrder).toBeLessThan(0);
    expectPositionsUnique(t);
  });
});

describe('reordering a course that has soft-deleted sections', () => {
  it('renumbers the live sections 1..N after a deletion, as often as asked', async () => {
    const t = build({ live: [1, 2, 3] });
    await t.remove('live_2');

    await t.reorder(['live_3', 'live_1']);
    expect(t.live()).toEqual(['live_3@1', 'live_1@2']);
    expectPositionsUnique(t);

    // Twice: the live sections are parked at -position - 1000 on the way, and
    // a deleted row left at such a value would be hit the second time.
    await t.reorder(['live_1', 'live_3']);
    expect(t.live()).toEqual(['live_1@1', 'live_3@2']);
    expectPositionsUnique(t);
  });

  it('steps past a deleted section holding one of the positions 1..N', async () => {
    const t = build({ live: [1, 2, 4], deleted: [3] });

    await t.reorder(['live_4', 'live_2', 'live_1']);

    expect(t.live()).toEqual(['live_4@1', 'live_2@2', 'live_1@3']);
    expect(t.byId('del_3').sortOrder).toBeLessThan(0);
    expectPositionsUnique(t);
  });

  it('leaves a deleted section above the live ones where it is', async () => {
    const t = build({ live: [1, 2], deleted: [3] });

    await t.reorder(['live_2', 'live_1']);

    expect(t.live()).toEqual(['live_2@1', 'live_1@2']);
    expect(t.byId('del_3').sortOrder).toBe(3);
    expectPositionsUnique(t);
  });
});

describe('positions stay unique and the live ones contiguous through a whole lifecycle', () => {
  it('holds after every single operation', async () => {
    const t = build({ live: [1, 2], deleted: [3, 4] });

    const check = () => {
      expectPositionsUnique(t);
      const live = t.livePositions();
      expect(live).toEqual(live.map((_, index) => index + 1));
      expectOtherCourseUntouched(t);
    };

    const a = await t.add(); // onto the deleted row at 3
    check();
    const b = await t.add(); // onto the deleted row at 4
    check();
    await t.remove('live_1'); // a live section follows
    check();
    const c = await t.add(1); // explicit, shifting everything
    check();
    await t.remove(b.id); // the last one
    check();
    const d = await t.add(); // onto the position just given up
    check();
    await t.remove(d.id); // the same position, deleted a second time
    check();
    await t.reorder([a.id, 'live_2', c.id]);
    check();
    await t.reorder(['live_2', c.id, a.id]);
    check();
    await t.add(2);
    check();

    expect(t.livePositions()).toEqual([1, 2, 3, 4]);
    // Every deleted row of the course ended up off the positive line.
    const deleted = t.rows.filter((r) => r.courseId === COURSE && r.deletedAt !== null);
    expect(deleted).toHaveLength(5);
    for (const row of deleted) expect(row.sortOrder).toBeLessThan(0);
  });

  it('issues raw statements against course_sections only', async () => {
    const t = build({ live: [1, 2], deleted: [3] });

    await t.add();
    await t.add(1);
    await t.remove('live_1');
    await t.reorder(t.liveIds());

    expect(t.raw.length).toBeGreaterThan(0);
    for (const sql of t.raw) expect(sql).toMatch(/^UPDATE course_sections\b/);
    expect(t.raw.join(' ')).not.toMatch(/DELETE FROM|DROP|TRUNCATE/i);
  });
});
