import { CodeTargetType, ContentStatus } from '@prisma/client';

import { CourseAccessService } from '../../src/modules/courses/course-access.service';
import { CoursesService } from '../../src/modules/courses/courses.service';

/**
 * A part holder sees what the part contains NOW.
 *
 * THE BUG THIS FILE EXISTS FOR
 * ---------------------------
 * A part card redemption froze the part's section ids onto the enrollment as
 * `enrollment_section_grants` rows. `allowedSectionIds()` read only those rows,
 * so a section an administrator later added to "Part 1 — Before Mid" (a second
 * lecturer's Pre-Mid section, on production: Chemistry (B), 2026-11-02) was
 * invisible to every student who had already bought Part 1: the dashboard
 * showed it inside the part, the entitlement said they owned the part, and the
 * lesson, playback and attachment gates all refused them.
 *
 * `allowedSectionIds()` now unions the frozen grants with the live sections of
 * every part the student holds a live entitlement for. These tests pin that,
 * and pin the second half of the fix: `GET /courses/:id` applies the same scope
 * to its `locked` flags as `GET /courses/:id/sections`, so the outline the apps
 * render agrees with the gates.
 */

describe('allowedSectionIds for a part holder', () => {
  function build(opts: {
    enrollment?: boolean;
    coversAll?: boolean;
    grants?: string[];
    partSections?: string[];
  }) {
    const sectionFindMany = jest.fn(async (_args: unknown) =>
      (opts.partSections ?? []).map((id) => ({ id })),
    );
    const prisma = {
      enrollment: {
        findUnique: jest.fn(async () =>
          opts.enrollment === false
            ? null
            : {
                id: 'enr_1',
                coversAllSections: opts.coversAll ?? false,
                sectionGrants: (opts.grants ?? []).map((sectionId) => ({ sectionId })),
              },
        ),
      },
      courseSection: { findMany: sectionFindMany },
    };
    const service = new CourseAccessService(prisma as never, null as never, null as never);
    // Targeting is a separate rule with its own suite; keep it out of the way.
    service.targetingEnforced = false;
    return { service, sectionFindMany };
  }

  it('unions the frozen grants with the live sections of every part the student holds', async () => {
    const t = build({ grants: ['sec_1'], partSections: ['sec_1', 'sec_3'] });

    const allowed = await t.service.allowedSectionIds('stu_1', 'crs_1');

    // sec_3 was added to the part AFTER the card was redeemed: no grant row,
    // but the student holds the part, so the section is theirs.
    expect(allowed).toEqual(['sec_1', 'sec_3']);
  });

  it('asks only for live, non-archived sections of non-deleted parts held by THIS student', async () => {
    const t = build({ grants: [], partSections: [] });

    await t.service.allowedSectionIds('stu_1', 'crs_1');

    expect(t.sectionFindMany).toHaveBeenCalledTimes(1);
    expect(t.sectionFindMany.mock.calls[0]![0]).toMatchObject({
      where: {
        courseId: 'crs_1',
        deletedAt: null,
        status: { not: ContentStatus.ARCHIVED },
        part: {
          deletedAt: null,
          entitlements: { some: { userId: 'stu_1', revokedAt: null } },
        },
      },
      select: { id: true },
    });
  });

  it('keeps a granted section the student paid for even after it left the part', async () => {
    const t = build({ grants: ['sec_1', 'sec_9'], partSections: ['sec_1', 'sec_3'] });

    const allowed = await t.service.allowedSectionIds('stu_1', 'crs_1');

    // Access is only ever widened: sec_9 stays, nothing is dropped, and a
    // section in both sources appears once.
    expect(allowed).toEqual(['sec_1', 'sec_9', 'sec_3']);
  });

  it('returns the grants alone for a section-card student who holds no part', async () => {
    const t = build({ grants: ['sec_2'], partSections: [] });

    expect(await t.service.allowedSectionIds('stu_1', 'crs_1')).toEqual(['sec_2']);
  });

  it('still returns null for a whole-course enrollment, without touching parts', async () => {
    const t = build({ coversAll: true, grants: [], partSections: ['sec_1'] });

    expect(await t.service.allowedSectionIds('stu_1', 'crs_1')).toBeNull();
    expect(t.sectionFindMany).not.toHaveBeenCalled();
  });

  it('still returns null when the student is not enrolled at all', async () => {
    const t = build({ enrollment: false, partSections: ['sec_1'] });

    expect(await t.service.allowedSectionIds('stu_1', 'crs_1')).toBeNull();
    expect(t.sectionFindMany).not.toHaveBeenCalled();
  });
});

describe('CoursesService.detail applies the section scope to locked flags', () => {
  const lesson = (id: string, sectionId: string) => ({
    id,
    sectionId,
    courseId: 'crs_1',
    title: id,
    kind: 'VIDEO',
    sortOrder: 1,
    durationSeconds: 60,
    isPreview: false,
    video: null,
    _count: { attachments: 0 },
  });

  const section = (id: string, sortOrder: number) => ({
    id,
    courseId: 'crs_1',
    title: id,
    description: null,
    sortOrder,
    status: 'PUBLISHED',
    unlocksAt: null,
    lessons: [lesson(id + '_l1', id)],
  });

  const COURSE = {
    id: 'crs_1',
    title: 'Chemistry (B)',
    slug: 'chem-b',
    shortDescription: null,
    description: 'desc',
    requirements: [],
    outcomes: [],
    status: 'PUBLISHED',
    isFree: false,
    thumbnailKey: null,
    lessonCount: 3,
    sectionCount: 3,
    totalDurationSeconds: 180,
    ratingCount: 0,
    ratingSum: 0,
    studentCount: 0,
    enrollmentMethods: ['CODE'],
    prices: [],
    teachers: [],
    university: null,
    academicYear: null,
    publishedAt: null,
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    completionRuleType: 'MANUAL',
    completionThreshold: 100,
    completionRequireContiguous: false,
  };

  function build(allowed: string[] | null, canAccessContent = true) {
    const prisma = {
      course: { findFirst: jest.fn(async () => COURSE) },
      courseSection: {
        findMany: jest.fn(async () => [
          section('sec_1', 1),
          section('sec_2', 2),
          section('sec_3', 3),
        ]),
      },
      watchProgress: { findMany: jest.fn(async () => []) },
      attachment: { findMany: jest.fn(async () => []) },
    };
    const access = {
      resolve: jest.fn(async () => ({ canAccessContent, state: 'ACTIVE' })),
      toCourseAccess: jest.fn(() => ({ state: 'ACTIVE', availableMethods: [] })),
      allowedSectionIds: jest.fn(async () => allowed),
    };
    const storage = { publicAssetUrl: jest.fn(async () => null) };
    const service = new CoursesService(prisma as never, access as never, storage as never);
    return { service, access };
  }

  type Detail = {
    sections: Array<{ id: string; locked: boolean; lessons: Array<{ locked: boolean }> }>;
  };

  it('locks exactly the sections outside the scope, and their lessons', async () => {
    const t = build(['sec_1', 'sec_3']);

    const result = (await t.service.detail({
      courseId: 'crs_1',
      userId: 'stu_1',
      role: 'STUDENT' as never,
    })) as Detail;

    expect(result.sections.map((s) => [s.id, s.locked])).toEqual([
      ['sec_1', false],
      ['sec_2', true],
      ['sec_3', false],
    ]);
    expect(result.sections.map((s) => s.lessons[0]!.locked)).toEqual([false, true, false]);
    expect(t.access.allowedSectionIds).toHaveBeenCalledWith('stu_1', 'crs_1');
  });

  it('leaves every section open for whole-course access (null scope)', async () => {
    const t = build(null);

    const result = (await t.service.detail({
      courseId: 'crs_1',
      userId: 'stu_1',
      role: 'STUDENT' as never,
    })) as Detail;

    expect(result.sections.every((s) => !s.locked)).toBe(true);
  });

  it('never consults the scope for an anonymous reader, who is locked out anyway', async () => {
    const t = build(['sec_1'], false);

    const result = (await t.service.detail({ courseId: 'crs_1', userId: null })) as Detail;

    expect(t.access.allowedSectionIds).not.toHaveBeenCalled();
    expect(result.sections.every((s) => s.locked)).toBe(true);
  });
});

describe('allowedSectionIds for a whole-course card bought under the old snapshot rule', () => {
  function build(opts: {
    coversAll?: boolean;
    grants?: Array<{ sectionId: string; codeId: string | null }>;
    partSections?: string[];
    /** How many of the grant codes are COURSE cards THIS student redeemed. */
    wholeCourseRedemptions?: number;
  }) {
    const redemptionCount = jest.fn(async (_args: unknown) => opts.wholeCourseRedemptions ?? 0);
    const sectionFindMany = jest.fn(async (_args: unknown) =>
      (opts.partSections ?? []).map((id) => ({ id })),
    );
    const prisma = {
      enrollment: {
        findUnique: jest.fn(async () => ({
          id: 'enr_1',
          coversAllSections: opts.coversAll ?? false,
          sectionGrants: opts.grants ?? [],
        })),
      },
      accessCodeRedemption: { count: redemptionCount },
      courseSection: { findMany: sectionFindMany },
    };
    const service = new CourseAccessService(prisma as never, null as never, null as never);
    service.targetingEnforced = false;
    return { service, redemptionCount, sectionFindMany };
  }

  const courseCardGrants = [
    { sectionId: 'sec_1', codeId: 'code_course' },
    { sectionId: 'sec_2', codeId: 'code_course' },
  ];

  it('treats an enrollment holding grants from a redeemed COURSE card as the whole course', async () => {
    const t = build({ grants: courseCardGrants, wholeCourseRedemptions: 1 });

    expect(await t.service.allowedSectionIds('stu_1', 'crs_1')).toBeNull();
    // Nothing else is consulted once the course is whole.
    expect(t.sectionFindMany).not.toHaveBeenCalled();
  });

  it('binds the card to THIS student, THIS course and the COURSE target type', async () => {
    const t = build({ grants: courseCardGrants, wholeCourseRedemptions: 1 });

    await t.service.allowedSectionIds('stu_1', 'crs_1');

    expect(t.redemptionCount).toHaveBeenCalledTimes(1);
    expect(t.redemptionCount.mock.calls[0]![0]).toEqual({
      where: {
        userId: 'stu_1',
        codeId: { in: ['code_course'] },
        code: {
          targetType: CodeTargetType.COURSE,
          OR: [{ courseId: 'crs_1' }, { courseId: null }],
        },
      },
    });
  });

  it('does not widen access when the student never redeemed the card the grant cites', async () => {
    const t = build({ grants: courseCardGrants, wholeCourseRedemptions: 0 });

    expect(await t.service.allowedSectionIds('stu_1', 'crs_1')).toEqual(['sec_1', 'sec_2']);
  });

  it('never consults cards for grants that carry no code id (admin grants)', async () => {
    const t = build({ grants: [{ sectionId: 'sec_1', codeId: null }] });

    expect(await t.service.allowedSectionIds('stu_1', 'crs_1')).toEqual(['sec_1']);
    expect(t.redemptionCount).not.toHaveBeenCalled();
  });

  it('a section or part card (non-COURSE target) leaves the enrollment restricted', async () => {
    // The double answers 0 because the where clause asks for COURSE cards only;
    // the assertion above pins that clause, this one pins the consequence.
    const t = build({
      grants: [{ sectionId: 'sec_1', codeId: 'code_part' }],
      partSections: ['sec_1', 'sec_3'],
      wholeCourseRedemptions: 0,
    });

    expect(await t.service.allowedSectionIds('stu_1', 'crs_1')).toEqual(['sec_1', 'sec_3']);
  });

  it('holdsWholeCourse agrees with allowedSectionIds for both shapes of whole-course access', async () => {
    expect(await build({ coversAll: true }).service.holdsWholeCourse('stu_1', 'crs_1')).toBe(true);
    expect(
      await build({ grants: courseCardGrants, wholeCourseRedemptions: 1 }).service.holdsWholeCourse('stu_1', 'crs_1'),
    ).toBe(true);
    expect(
      await build({ grants: courseCardGrants, wholeCourseRedemptions: 0 }).service.holdsWholeCourse('stu_1', 'crs_1'),
    ).toBe(false);
  });
});
