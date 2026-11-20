import { CourseStatus, type Enrollment, EnrollmentState } from '@prisma/client';

import { ErrorCode } from '../../src/common/errors/error-codes';
import {
  type AccessDecision,
  CourseAccessService,
  LISTED_ENROLMENT_STATES,
} from '../../src/modules/courses/course-access.service';
import {
  attachmentSectionId,
  hasDocumentAccess,
  toAttachment,
  toLessonSummary,
} from '../../src/modules/courses/course.serializer';

/**
 * Who may SEE a course page (`mayViewCoursePage`), kept apart from what the
 * page UNLOCKS (`decide()`, section scope, `previewUnlocks`).
 *
 * The page of a HIDDEN course used to be refused to every student, enrolled or
 * not, while "My courses" listed it - see hidden-course-page.e2e-spec.ts for
 * the end-to-end shape. This pins the decision table itself.
 */

const COURSE = { id: 'crs_1', status: CourseStatus.HIDDEN };
const USER_ID = 'usr_1';

function service(enrolmentState: EnrollmentState | null) {
  const findUnique = jest.fn().mockResolvedValue(enrolmentState === null ? null : { state: enrolmentState });
  const prisma = { enrollment: { findUnique } };
  return { svc: new CourseAccessService(prisma as never, null as never, null as never), findUnique };
}

describe('CourseAccessService.mayViewCoursePage', () => {
  const ALL_STATES = Object.values(EnrollmentState);

  it('the listed states are every state except REVOKED', () => {
    expect([...LISTED_ENROLMENT_STATES].sort()).toEqual(ALL_STATES.filter((s) => s !== EnrollmentState.REVOKED).sort());
  });

  describe('HIDDEN', () => {
    it.each(ALL_STATES)('a student with a %s enrolment', async (state) => {
      const { svc } = service(state);
      const visible = await svc.mayViewCoursePage({ userId: USER_ID, isStaff: false, course: COURSE });
      expect(visible).toBe(state !== EnrollmentState.REVOKED);
    });

    it('a student with no enrolment', async () => {
      const { svc } = service(null);
      expect(await svc.mayViewCoursePage({ userId: USER_ID, isStaff: false, course: COURSE })).toBe(false);
    });

    it('a signed-out visitor, without touching the database', async () => {
      const { svc, findUnique } = service(EnrollmentState.ACTIVE);
      expect(await svc.mayViewCoursePage({ userId: null, isStaff: false, course: COURSE })).toBe(false);
      expect(findUnique).not.toHaveBeenCalled();
    });

    it("looks up this student's own enrolment in this course", async () => {
      const { svc, findUnique } = service(EnrollmentState.ACTIVE);
      await svc.mayViewCoursePage({ userId: USER_ID, isStaff: false, course: COURSE });
      expect(findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId_courseId: { userId: USER_ID, courseId: COURSE.id } } }),
      );
    });
  });

  it.each([CourseStatus.DRAFT, CourseStatus.SUSPENDED])('%s: closed to every student, enrolled or not', async (status) => {
    for (const state of [...ALL_STATES, null]) {
      const { svc } = service(state);
      expect(await svc.mayViewCoursePage({ userId: USER_ID, isStaff: false, course: { ...COURSE, status } })).toBe(false);
    }
  });

  it.each([CourseStatus.PUBLISHED, CourseStatus.ARCHIVED])('%s: open to everyone, at no extra query', async (status) => {
    const { svc, findUnique } = service(null);
    expect(await svc.mayViewCoursePage({ userId: null, isStaff: false, course: { ...COURSE, status } })).toBe(true);
    expect(await svc.mayViewCoursePage({ userId: USER_ID, isStaff: false, course: { ...COURSE, status } })).toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it.each(Object.values(CourseStatus))('staff see a %s course (scoping happens in resolve())', async (status) => {
    const { svc, findUnique } = service(null);
    expect(await svc.mayViewCoursePage({ userId: USER_ID, isStaff: true, course: { ...COURSE, status } })).toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe('CourseAccessService.previewUnlocks (the preview rule of assertContentAccess)', () => {
  const { svc } = service(null);
  const decision = (overrides: Partial<AccessDecision>): AccessDecision => ({
    state: 'NOT_ENROLLED',
    canAccessContent: false,
    enrollment: null as Enrollment | null,
    expiresAt: null,
    denialCode: ErrorCode.NOT_ENROLLED,
    courseStatus: CourseStatus.PUBLISHED,
    ...overrides,
  });

  it('open for a PUBLISHED course', () => {
    expect(svc.previewUnlocks(decision({}))).toBe(true);
    expect(svc.previewUnlocks(decision({ state: 'EXPIRED', denialCode: ErrorCode.ACCESS_EXPIRED }))).toBe(true);
  });

  it.each([CourseStatus.HIDDEN, CourseStatus.DRAFT, CourseStatus.SUSPENDED, CourseStatus.ARCHIVED, undefined])(
    'closed for a %s course',
    (courseStatus) => {
      expect(svc.previewUnlocks(decision({ courseStatus }))).toBe(false);
    },
  );

  it('closed for an archived enrolment, and for a paused delivery', () => {
    expect(svc.previewUnlocks(decision({ state: 'ARCHIVED', denialCode: ErrorCode.COURSE_ARCHIVED }))).toBe(false);
    expect(svc.previewUnlocks(decision({ state: 'ACTIVE', denialCode: ErrorCode.COURSE_NOT_AVAILABLE }))).toBe(false);
  });
});

describe('page flags follow the gates', () => {
  it('a document is narrowed to its own section, or its lecture section, like issueTicket', () => {
    expect(attachmentSectionId({ sectionId: 'sec_b' })).toBe('sec_b');
    expect(attachmentSectionId({ sectionId: null, lesson: { sectionId: 'sec_a' } })).toBe('sec_a');
    expect(attachmentSectionId({ sectionId: null, lesson: null })).toBeNull();

    expect(hasDocumentAccess(true, null, 'sec_b')).toBe(true); // whole course
    expect(hasDocumentAccess(true, ['sec_a'], 'sec_a')).toBe(true);
    expect(hasDocumentAccess(true, ['sec_a'], 'sec_b')).toBe(false); // another part
    expect(hasDocumentAccess(true, ['sec_a'], null)).toBe(true); // course-wide material
    expect(hasDocumentAccess(false, null, null)).toBe(false);
  });

  it('a preview is shown open only when previews unlock; the default keeps the old behaviour', () => {
    const doc = { id: 'att_1', isPreview: true, isProtected: false, isDownloadable: true } as never;
    expect(toAttachment(doc, false).locked).toBe(false);
    expect(toAttachment(doc, false, true).locked).toBe(false);
    expect(toAttachment(doc, false, false).locked).toBe(true);
    expect(toAttachment(doc, true, false).locked).toBe(false);

    const lesson = { id: 'les_1', isPreview: true, video: null, durationSeconds: 1 } as never;
    expect(toLessonSummary({ lesson, hasCourseAccess: false, sectionLocked: false, progress: undefined }).locked).toBe(false);
    expect(
      toLessonSummary({ lesson, hasCourseAccess: false, sectionLocked: false, progress: undefined, previewUnlocks: false }).locked,
    ).toBe(true);
  });
});
