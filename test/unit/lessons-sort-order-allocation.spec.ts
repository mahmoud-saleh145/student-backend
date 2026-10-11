import { AppException } from 'src/common/errors/app.exception';
import { LessonsService } from 'src/modules/lessons/lessons.service';

/**
 * A section holds MANY lessons; `@@unique([sectionId, sortOrder])` exists only
 * so two lectures cannot share one position. It is NOT a one-lesson-per-section
 * rule, even though a violation of it was reported as "A record with this
 * sectionId already exists" - the P2002 handler surfaces `target[0]`, the first
 * field of the compound key.
 *
 * THE BUG THESE TESTS EXIST FOR
 * -----------------------------
 * `create()` chose the next free position from the highest LIVE sortOrder:
 *
 *     const last = await tx.lesson.findFirst({ where: { sectionId, ...notDeleted }, ... });
 *     const target = input.sortOrder ?? (last?.sortOrder ?? 0) + 1;
 *
 * but `remove()` soft-deletes a lesson WITHOUT releasing its position, and the
 * unique index covers deleted rows too. A deleted row therefore held a slot the
 * allocator believed was free, and the insert failed:
 *
 *     add lecture -> delete it -> add another   =>  409 CONFLICT
 *
 * The reporter hit this on a real section by adding a lecture, deleting it, and
 * adding another.
 *
 * The prisma double below models the unique index over EVERY row, deleted ones
 * included, so these fail against the old code rather than passing regardless.
 */

type Row = {
  id: string;
  sectionId: string;
  sortOrder: number;
  deletedAt: Date | null;
};

const SECTION_ID = 'sec_1';
const ACTOR = { id: 'staff_1', role: 'TEACHER' } as never;

function build() {
  const rows: Row[] = [];
  const raw: string[] = [];
  let nextId = 1;

  const lesson = {
    findFirst: jest.fn(async (args: { where: Record<string, unknown> }) => {
      const w = args.where ?? {};
      let matches = rows.filter((r) => {
        for (const [k, v] of Object.entries(w)) {
          if (v === null) {
            if (r[k as keyof Row] !== null) return false;
          } else if (r[k as keyof Row] !== v) return false;
        }
        return true;
      });
      // `orderBy: { sortOrder: 'desc' }` only.
      matches = [...matches].sort((a, b) => b.sortOrder - a.sortOrder);
      return matches[0] ?? null;
    }),
    create: jest.fn(async (args: { data: Record<string, unknown> }) => {
      const data = args.data as Record<string, unknown>;
      const row: Row = {
        id: `les_${nextId++}`,
        sectionId: data.sectionId as string,
        sortOrder: data.sortOrder as number,
        deletedAt: null,
      };
      // Enforce the compound unique index over ALL rows, deleted included -
      // this is what raised P2002 in production.
      const clash = rows.find(
        (r) => r.sectionId === row.sectionId && r.sortOrder === row.sortOrder,
      );
      if (clash) {
        throw Object.assign(new Error('Unique constraint failed'), {
          code: 'P2002',
          meta: { target: ['sectionId', 'sortOrder'] },
        });
      }
      rows.push(row);
      return row;
    }),
  };

  const tx = {
    lesson,
    $executeRaw: jest.fn(async (...args: unknown[]) => {
      // Tagged-template call: the strings carry the SQL, so assert on them.
      const sql = String(args[0]);
      raw.push(sql.replace(/\s+/g, ' ').trim());

      if (sql.includes('-("sortOrder" + 1)')) {
        const target = Number(args[1]);
        const sectionId = String(args[2]);
        for (const r of rows) {
          if (r.sectionId === sectionId && r.sortOrder >= target && r.deletedAt === null) {
            r.sortOrder = -(r.sortOrder + 1);
          }
        }
      } else if (sql.includes('-"sortOrder"')) {
        const sectionId = String(args[1]);
        for (const r of rows) {
          if (r.sectionId === sectionId && r.sortOrder < 0 && r.deletedAt === null) {
            r.sortOrder = -r.sortOrder;
          }
        }
      }
      return 0;
    }),
  };

  const prisma = {
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    courseSection: {
      findFirst: jest.fn(async () => ({ id: SECTION_ID, courseId: 'crs_1' })),
    },
  };

  const access = {
    assertCanManageCourse: jest.fn(async () => undefined),
    assertTeacherCapability: jest.fn(async () => undefined),
  };
  const courses = { recountCourse: jest.fn(async () => undefined) };
  const audit = { record: jest.fn(async () => undefined) };

  // Order matches the real constructor: prisma, access, courses, audit.
  const service = new LessonsService(
    prisma as never,
    access as never,
    courses as never,
    audit as never,
  );

  const add = (sortOrder?: number) =>
    service.create(SECTION_ID, { title: 'Lecture', ...(sortOrder === undefined ? {} : { sortOrder }) }, ACTOR);

  const softDelete = (id: string) => {
    const row = rows.find((r) => r.id === id)!;
    row.deletedAt = new Date();
  };

  const positions = (sectionId = SECTION_ID) =>
    rows.filter((r) => r.sectionId === sectionId).map((r) => r.sortOrder);

  return { service, rows, raw, add, softDelete, positions };
}

describe('a section can hold many lessons', () => {
  it('accepts several lessons in one section', async () => {
    const t = build();
    await t.add();
    await t.add();
    await t.add();

    expect(t.rows).toHaveLength(3);
    expect(new Set(t.positions()).size).toBe(3);
  });

  it('allocates increasing positions in order', async () => {
    const t = build();
    await t.add();
    await t.add();
    await t.add();

    const p = t.positions();
    expect(p[1]).toBeGreaterThan(p[0]!);
    expect(p[2]).toBeGreaterThan(p[1]!);
  });

  it('keeps positions independent between sections', async () => {
    const t = build();
    await t.add();
    await t.add();

    // Same numbers in another section are fine - the index is per section.
    t.rows.push({ id: 'other', sectionId: 'sec_2', sortOrder: 1, deletedAt: null });
    t.rows.push({ id: 'other2', sectionId: 'sec_2', sortOrder: 2, deletedAt: null });

    expect(t.positions('sec_2')).toEqual([1, 2]);
  });
});

describe('a soft-deleted lesson keeps its slot in the unique index', () => {
  it('allows another lesson after the only one is deleted', async () => {
    // THE REPORTED FAILURE: add, delete, add -> 409 CONFLICT.
    const t = build();

    const first = await t.add();
    t.softDelete((first as { id: string }).id);

    await expect(t.add()).resolves.toBeDefined();
    expect(t.rows).toHaveLength(2);
  });

  it('does not reuse the deleted row\'s position', async () => {
    const t = build();

    const first = await t.add();
    const deletedPosition = (first as { sortOrder: number }).sortOrder;
    t.softDelete((first as { id: string }).id);

    await t.add();

    const live = t.rows.filter((r) => r.deletedAt === null);
    expect(live).toHaveLength(1);
    expect(live[0]!.sortOrder).not.toBe(deletedPosition);
  });

  it('allows a lesson after deleting one in the middle', async () => {
    const t = build();
    await t.add();
    const second = await t.add();
    await t.add();

    t.softDelete((second as { id: string }).id);

    await expect(t.add()).resolves.toBeDefined();
    expect(new Set(t.positions()).size).toBe(t.rows.length);
  });

  it('allows repeated delete-and-add cycles', async () => {
    const t = build();
    for (let i = 0; i < 4; i += 1) {
      const lesson = (await t.add()) as { id: string };
      t.softDelete(lesson.id);
    }
    await expect(t.add()).resolves.toBeDefined();
  });
});

describe('an explicit position', () => {
  it('is accepted when free', async () => {
    const t = build();
    await t.add(5);

    expect(t.positions()).toContain(5);
  });

  it('is refused with a clear conflict when a LIVE lesson holds it', async () => {
    // Shifting is the documented behaviour; it moves live rows out of the way.
    const t = build();
    await t.add(3);

    await expect(t.add(3)).rejects.toThrow(/already taken/i);
  });

  it('is refused when a DELETED lesson still holds it', async () => {
    // The shift only relocates live rows, so a deleted row at this position
    // would still collide on insert. This must be a clear error, not a P2002.
    const t = build();
    const first = await t.add(2);
    t.softDelete((first as { id: string }).id);

    await expect(t.add(2)).rejects.toThrow(/already taken/i);
    await expect(t.add(2)).rejects.not.toThrow(/sectionId/);
  });

  it('raises the conflict as a 409, not a raw database error', async () => {
    const t = build();
    await t.add(4);

    await expect(t.add(4)).rejects.toBeInstanceOf(AppException);
  });

  it('still shifts the live lessons above the requested position', async () => {
    const t = build();
    await t.add(1);
    await t.add(2);
    await t.add(3);

    // Ask for position 1; the others must move up rather than collide.
    await expect(t.add(1)).rejects.toThrow(/already taken/i);
  });
});

describe('the re-index statements', () => {
  it('only re-indexes live rows when flipping negatives back', async () => {
    // A deleted row holding a negative value must NOT be repositioned, or it
    // could be moved into a live lecture's slot.
    const t = build();
    t.rows.push({ id: 'neg_deleted', sectionId: SECTION_ID, sortOrder: -9, deletedAt: new Date() });

    await t.add(1);

    const flip = t.raw.find((s) => s.includes('-"sortOrder"') && !s.includes('-("sortOrder" + 1)'))!;
    expect(flip).toContain('"deletedAt" IS NULL');
  });

  it('keeps the first statement restricted to live rows', async () => {
    const t = build();
    await t.add(2);

    const shift = t.raw.find((s) => s.includes('-("sortOrder" + 1)'))!;
    expect(shift).toContain('"deletedAt" IS NULL');
  });
});