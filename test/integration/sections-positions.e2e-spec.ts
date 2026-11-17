/**
 * Section positions against a real PostgreSQL.
 *
 * `course_sections` has a unique index on `(courseId, sortOrder)` that covers
 * soft-deleted rows too. A unit test with a Prisma double cannot tell whether a
 * statement survives that index (it is checked row by row, in whatever order
 * the rows are visited), so everything that writes a position is exercised
 * here through the HTTP API: add, insert at a position, reorder, delete - on
 * courses that have soft-deleted sections, including the shape production data
 * is in (a deleted section still holding a positive position).
 *
 * The concurrency tests assert SAFETY only (no server error, no duplicate
 * position, nothing but a clean conflict for the loser) and print what
 * happened, so the same file can be run against two versions of the service
 * and compared.
 *
 * Two races are deliberately NOT asserted here, because they are older than
 * this file and unchanged by it (measured on the original and the fixed
 * service alike): an insert at an explicit position racing an append can
 * answer the loser 500 instead of 409, and a reorder racing an append can
 * leave the appended section outside 1..N until the next reorder. Neither can
 * produce a duplicate position - the index forbids it.
 */
import type { INestApplication } from '@nestjs/common';
import { ContentStatus, PrismaClient, UserRole } from '@prisma/client';

import {
  API,
  bootstrapTestApp,
  createCourse,
  createUser,
  enroll,
  http,
  login,
  resetDatabase,
  shutdownTestApp,
} from './helpers';

type Row = { id: string; title: string; sortOrder: number; deletedAt: Date | null };

describe('sections: positions and soft-deleted rows', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let headers: Record<string, string>;
  let courseId: string;
  let studentId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
  });

  afterAll(async () => {
    await shutdownTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    const teacher = await createUser(prisma, { role: UserRole.TEACHER });
    const admin = await createUser(prisma, { role: UserRole.ADMIN });
    const student = await createUser(prisma, { role: UserRole.STUDENT });
    // Three sections (positions 1, 2, 3), each with lectures and a video.
    const course = await createCourse(prisma, { teacherId: teacher.id });
    await enroll(prisma, student.id, course.id);
    courseId = course.id;
    studentId = student.id;
    headers = (await login(app, admin.phone, 'admin-device')).headers;
  });

  // --- helpers ---------------------------------------------------------------

  const rows = (): Promise<Row[]> =>
    prisma.courseSection.findMany({
      where: { courseId },
      select: { id: true, title: true, sortOrder: true, deletedAt: true },
      orderBy: { sortOrder: 'asc' },
    });
  const live = async () => (await rows()).filter((r) => r.deletedAt === null);
  const deleted = async () => (await rows()).filter((r) => r.deletedAt !== null);
  const titles = async () => (await live()).map((r) => r.title);

  /** Live sections are 1..N; no two rows of the course share a position; deleted rows hold no live slot. */
  async function expectSound() {
    const all = await rows();
    const liveRows = all.filter((r) => r.deletedAt === null);
    expect(liveRows.map((r) => r.sortOrder)).toEqual(liveRows.map((_, i) => i + 1));
    expect(new Set(all.map((r) => r.sortOrder)).size).toBe(all.length);
  }

  const add = (body: Record<string, unknown>) =>
    http(app).post(`${API}/admin/courses/${courseId}/sections`).set(headers).send(body);
  const remove = (id: string) => http(app).delete(`${API}/admin/sections/${id}`).set(headers);
  const reorder = (sectionIds: string[]) =>
    http(app).post(`${API}/admin/courses/${courseId}/sections/reorder`).set(headers).send({ sectionIds });
  const byTitle = async (title: string) => (await rows()).find((r) => r.title === title)!;

  /** A soft-deleted section left on a positive position: what production rows look like. */
  const legacyDeleted = (sortOrder: number, title = `legacy deleted ${sortOrder}`) =>
    prisma.courseSection.create({
      data: { courseId, title, sortOrder, status: ContentStatus.ARCHIVED, deletedAt: new Date() },
    });

  /** Everything a section write must not touch. */
  async function bystanders() {
    const [lessons, videos, links, enrolments, grants, tickets] = await Promise.all([
      prisma.lesson.findMany({ where: { courseId }, orderBy: { id: 'asc' } }),
      prisma.video.findMany({ where: { courseId }, orderBy: { id: 'asc' } }),
      prisma.lessonVideo.findMany({ where: { lesson: { courseId } }, orderBy: [{ lessonId: 'asc' }, { videoId: 'asc' }] }),
      prisma.enrollment.findMany({ where: { courseId }, orderBy: { id: 'asc' } }),
      prisma.enrollmentSectionGrant.findMany({ orderBy: { id: 'asc' } }),
      prisma.playbackTicket.findMany({ where: { courseId }, orderBy: { id: 'asc' } }),
    ]);
    return JSON.stringify({ lessons, videos, links, enrolments, grants, tickets }, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
  }

  // --- add -------------------------------------------------------------------

  it('adds a section after the last one was deleted (the reported 409)', async () => {
    await remove((await byTitle('After Midterm')).id).expect(200);

    const res = await add({ title: 'Final Revision' });

    expect(res.status).toBe(201);
    expect(await titles()).toEqual(['Before Midterm', 'Midterm Revision', 'Final Revision']);
    await expectSound();
  });

  it('adds a section to a course whose sections were all deleted', async () => {
    for (const title of ['After Midterm', 'Midterm Revision', 'Before Midterm']) {
      await remove((await byTitle(title)).id).expect(200);
    }

    expect((await add({ title: 'Fresh start' })).status).toBe(201);
    expect((await add({ title: 'Second' })).status).toBe(201);

    expect(await titles()).toEqual(['Fresh start', 'Second']);
    await expectSound();
  });

  it('production shape: a deleted section still sits on the next position', async () => {
    await legacyDeleted(4);
    await legacyDeleted(5);
    await legacyDeleted(9);
    const before = await bystanders();

    expect((await add({ title: 'Unit 4' })).status).toBe(201);

    expect(await titles()).toEqual(['Before Midterm', 'Midterm Revision', 'After Midterm', 'Unit 4']);
    // Only the row that was in the way moved; the others are where they were.
    const gone = await deleted();
    expect(gone.find((r) => r.title === 'legacy deleted 4')!.sortOrder).toBeLessThan(0);
    expect(gone.find((r) => r.title === 'legacy deleted 5')!.sortOrder).toBe(5);
    expect(gone.find((r) => r.title === 'legacy deleted 9')!.sortOrder).toBe(9);
    expect(await bystanders()).toBe(before);
    await expectSound();
  });

  it('production shape: every section of the course is a deleted row on a positive position', async () => {
    await prisma.courseSection.updateMany({
      where: { courseId },
      data: { deletedAt: new Date(), status: ContentStatus.ARCHIVED },
    });

    expect((await add({ title: 'Smoke test' })).status).toBe(201);

    expect(await titles()).toEqual(['Smoke test']);
    await expectSound();
  });

  it('a course with no deleted sections gets exactly the positions it always got', async () => {
    const res = await add({ title: 'Unit 4' });

    expect(res.status).toBe(201);
    expect((res.body.data ?? res.body).sortOrder).toBe(4);
    expect(await deleted()).toEqual([]);
    await expectSound();
  });

  // --- insert at a position --------------------------------------------------

  it('inserts at a position while deleted rows sit at and after it', async () => {
    await legacyDeleted(4);
    await legacyDeleted(5);

    expect((await add({ title: 'Introduction', sortOrder: 1 })).status).toBe(201);

    expect(await titles()).toEqual(['Introduction', 'Before Midterm', 'Midterm Revision', 'After Midterm']);
    await expectSound();
  });

  it('inserts in the middle after a deletion, and again', async () => {
    await remove((await byTitle('Midterm Revision')).id).expect(200);

    expect((await add({ title: 'Lab', sortOrder: 2 })).status).toBe(201);
    expect((await add({ title: 'Quiz', sortOrder: 2 })).status).toBe(201);

    expect(await titles()).toEqual(['Before Midterm', 'Quiz', 'Lab', 'After Midterm']);
    await expectSound();
  });

  // --- delete ----------------------------------------------------------------

  it('deletes a section that has live sections after it, and closes the gap', async () => {
    await add({ title: 'Unit 4' }).expect(201);
    await add({ title: 'Unit 5' }).expect(201);

    // The FIRST of five: four live rows must each move down by one.
    expect((await remove((await byTitle('Before Midterm')).id)).status).toBe(200);

    expect(await titles()).toEqual(['Midterm Revision', 'After Midterm', 'Unit 4', 'Unit 5']);
    await expectSound();
  });

  it('closes the gap whatever order the rows are stored in', async () => {
    // Rewrite the rows so the heap holds the highest position first: a single
    // `- 1` over several rows then fails on the unique index.
    await add({ title: 'Unit 4' }).expect(201);
    const ids = (await live()).map((r) => r.id);
    expect((await reorder([...ids].reverse())).status).toBeLessThan(300);
    expect((await reorder(ids)).status).toBeLessThan(300);
    for (const id of [...ids].reverse()) {
      await prisma.courseSection.update({ where: { id }, data: { description: `touched ${id}` } });
    }

    expect((await remove(ids[0])).status).toBe(200);

    expect((await live()).map((r) => r.id)).toEqual(ids.slice(1));
    await expectSound();
  });

  it('archives the deleted section and its lectures, and nothing else', async () => {
    const target = await byTitle('Midterm Revision');
    const others = await prisma.lesson.findMany({
      where: { courseId, sectionId: { not: target.id } },
      orderBy: { id: 'asc' },
    });
    const enrolment = await prisma.enrollment.findMany({ where: { courseId } });

    await remove(target.id).expect(200);

    expect(
      await prisma.lesson.findMany({ where: { courseId, sectionId: { not: target.id } }, orderBy: { id: 'asc' } }),
    ).toEqual(others);
    expect(await prisma.lesson.count({ where: { sectionId: target.id, deletedAt: null } })).toBe(0);
    expect(await prisma.enrollment.findMany({ where: { courseId } })).toEqual(enrolment);
    await expectSound();
  });

  it('the same position can be deleted, reused and deleted again', async () => {
    for (let round = 1; round <= 5; round += 1) {
      expect((await add({ title: `Round ${round}` })).status).toBe(201);
      expect((await remove((await byTitle(`Round ${round}`)).id)).status).toBe(200);
      await expectSound();
    }
    expect(await titles()).toEqual(['Before Midterm', 'Midterm Revision', 'After Midterm']);
    expect((await deleted()).length).toBe(5);
  });

  // --- reorder ---------------------------------------------------------------

  it('reorders after deletions, twice', async () => {
    await remove((await byTitle('Before Midterm')).id).expect(200);
    await add({ title: 'Unit 4' }).expect(201);
    const ids = (await live()).map((r) => r.id);

    expect((await reorder([...ids].reverse())).status).toBeLessThan(300);
    expect((await live()).map((r) => r.id)).toEqual([...ids].reverse());
    expect((await reorder(ids)).status).toBeLessThan(300);

    expect((await live()).map((r) => r.id)).toEqual(ids);
    await expectSound();
  });

  it('reorders while a deleted row sits on one of the positions being written', async () => {
    // Possible only for data written before the fix: a hole at 2 held by a deleted row.
    const second = await byTitle('Midterm Revision');
    await prisma.courseSection.update({
      where: { id: second.id },
      data: { deletedAt: new Date(), status: ContentStatus.ARCHIVED },
    });
    const ids = (await live()).map((r) => r.id);

    expect((await reorder([...ids].reverse())).status).toBeLessThan(300);

    expect((await live()).map((r) => r.id)).toEqual([...ids].reverse());
    await expectSound();
  });

  // --- what a student sees ---------------------------------------------------

  it('leaves lectures, videos, enrolments, grants and tickets untouched by add, insert and reorder', async () => {
    await legacyDeleted(4);
    const before = await bystanders();
    const original = (await live()).map((r) => r.id);

    await add({ title: 'Unit 4' }).expect(201);
    await add({ title: 'Introduction', sortOrder: 1 }).expect(201);
    const ids = (await live()).map((r) => r.id);
    expect((await reorder([...ids].reverse())).status).toBeLessThan(300);

    expect(await bystanders()).toBe(before);
    // The sections that existed keep their relative order within every result.
    expect((await live()).map((r) => r.id).filter((id) => original.includes(id))).toEqual([...original].reverse());
    expect(await prisma.enrollment.count({ where: { courseId, userId: studentId, state: 'ACTIVE' } })).toBe(1);
    await expectSound();
  });

  // --- concurrency -----------------------------------------------------------

  const tally = (statuses: number[]) =>
    Object.entries(statuses.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {}))
      .map(([status, n]) => `${status}x${n}`)
      .join(' ');

  it('concurrent adds to one course: no server error, no duplicate, losers get a conflict', async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < 6; round += 1) {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => add({ title: `c${round}-${i}` }).then((r) => r.status)),
      );
      outcomes.push(tally(results));
      expect(results.every((s) => s === 201 || s === 409)).toBe(true);
      expect(results.filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
      await expectSound();
    }
    console.log(`[concurrency] 8 simultaneous adds, 6 rounds: ${outcomes.join(' | ')}`);
  });

  it('concurrent adds when a deleted row holds the next position', async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < 6; round += 1) {
      const next = (await live()).length + 1;
      await legacyDeleted(next, `blocker ${round}`);
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => add({ title: `d${round}-${i}` }).then((r) => r.status)),
      );
      outcomes.push(tally(results));
      expect(results.every((s) => s === 201 || s === 409)).toBe(true);
      expect(results.filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
      await expectSound();
    }
    console.log(`[concurrency] 8 simultaneous adds behind a deleted row, 6 rounds: ${outcomes.join(' | ')}`);
  });

  it('a delete and two adds at once: each succeeds or conflicts cleanly, and positions stay usable', async () => {
    const outcomes: string[] = [];
    let gaps = 0;
    for (let round = 0; round < 8; round += 1) {
      const ids = (await live()).map((r) => r.id);
      const results = await Promise.all([
        remove(ids[Math.floor(ids.length / 2)]).then((r) => r.status),
        add({ title: `m${round}-a` }).then((r) => r.status),
        add({ title: `m${round}-b` }).then((r) => r.status),
      ]);
      outcomes.push(tally(results));
      // 200 deleted, 201 added, 409 lost the race for a position.
      expect(results.every((s) => [200, 201, 409].includes(s))).toBe(true);
      expect(results[0]).toBe(200);
      const all = await rows();
      expect(new Set(all.map((r) => r.sortOrder)).size).toBe(all.length);
      const liveNow = all.filter((r) => r.deletedAt === null);
      if (liveNow.some((r, i) => r.sortOrder !== i + 1)) {
        // An add that read the last position before the delete closed its gap
        // lands one position too high. One reorder repairs it.
        gaps += 1;
        expect((await reorder(liveNow.map((r) => r.id))).status).toBeLessThan(300);
      }
      await expectSound();
    }
    console.log(
      `[concurrency] delete + 2 adds at once, 8 rounds: ${outcomes.join(' | ')}; rounds that needed a reorder to close a gap: ${gaps}`,
    );
  });
});
