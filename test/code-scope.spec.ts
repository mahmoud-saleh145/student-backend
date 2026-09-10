import { CodeTargetType } from '@prisma/client';

import { AppException } from '../src/common/errors/app.exception';
import { ErrorCode } from '../src/common/errors/error-codes';
import { resolveRedemptionScope } from '../src/modules/codes/codes.service';

/**
 * The access-code business rules, exercised directly.
 *
 * These are the rules that decide what a paying student receives, so they are
 * tested against the real function rather than a description of it. The three
 * that matter commercially:
 *
 *   - a course card does not grow to cover sections added after it was sold;
 *   - a teacher card does not grow to cover courses added after it was sold;
 *   - a section card unlocks one section and nothing else.
 *
 * The fourth case is the one that breaks production if it is wrong: codes
 * issued before any of this existed must keep behaving exactly as they did.
 */

type CodeRow = Parameters<typeof resolveRedemptionScope>[0];

const code = (overrides: Partial<CodeRow>): CodeRow => ({
  targetType: CodeTargetType.COURSE,
  courseId: null,
  sectionId: null,
  teacherId: null,
  grantedSectionIds: [],
  grantedCourseIds: [],
  ...overrides,
});

const expectInvalidCode = (run: () => unknown): void => {
  try {
    run();
    throw new Error('expected the code to be rejected, but it was accepted');
  } catch (error) {
    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).code).toBe(ErrorCode.INVALID_CODE);
  }
};

describe('resolveRedemptionScope', () => {
  describe('course codes', () => {
    it('unlocks exactly the sections frozen at generation time', () => {
      const scope = resolveRedemptionScope(
        code({
          targetType: CodeTargetType.COURSE,
          courseId: 'course-1',
          grantedSectionIds: ['sec-pre', 'sec-mid'],
        }),
        'course-1',
      );

      expect(scope.courseIds).toEqual(['course-1']);
      expect(scope.sectionIds).toEqual(['sec-pre', 'sec-mid']);
    });

    it('does not unlock a section created after the code was issued', () => {
      const scope = resolveRedemptionScope(
        code({
          courseId: 'course-1',
          grantedSectionIds: ['sec-pre', 'sec-mid'],
        }),
        'course-1',
      );

      // 'sec-post' was added later; it must not appear.
      expect(scope.sectionIds).not.toContain('sec-post');
    });

    it('refuses a course it was not issued for', () => {
      expectInvalidCode(() =>
        resolveRedemptionScope(code({ courseId: 'course-1' }), 'course-2'),
      );
    });

    it('treats a legacy row with no snapshot as covering the whole course', () => {
      const scope = resolveRedemptionScope(
        code({ courseId: 'course-1', grantedSectionIds: [] }),
        'course-1',
      );

      // null, not [] — "all sections", not "no sections". Getting this wrong
      // would lock every pre-existing student out of what they already bought.
      expect(scope.sectionIds).toBeNull();
    });

    it('lets a global code (no course) be used on any course, fully', () => {
      const scope = resolveRedemptionScope(code({ courseId: null }), 'any-course');

      expect(scope.courseIds).toEqual(['any-course']);
      expect(scope.sectionIds).toBeNull();
    });
  });

  describe('section codes', () => {
    it('unlocks only the named section', () => {
      const scope = resolveRedemptionScope(
        code({
          targetType: CodeTargetType.SECTION,
          courseId: 'course-1',
          sectionId: 'sec-mid',
          grantedSectionIds: ['sec-mid'],
        }),
        'course-1',
      );

      expect(scope.sectionIds).toEqual(['sec-mid']);
      expect(scope.courseIds).toEqual(['course-1']);
    });

    it('refuses a course the section does not belong to', () => {
      expectInvalidCode(() =>
        resolveRedemptionScope(
          code({
            targetType: CodeTargetType.SECTION,
            courseId: 'course-1',
            sectionId: 'sec-mid',
          }),
          'course-2',
        ),
      );
    });

    it('refuses a malformed section code with no section', () => {
      expectInvalidCode(() =>
        resolveRedemptionScope(
          code({ targetType: CodeTargetType.SECTION, courseId: 'course-1' }),
          'course-1',
        ),
      );
    });
  });

  describe('teacher codes', () => {
    it('unlocks every course frozen at generation time, in full', () => {
      const scope = resolveRedemptionScope(
        code({
          targetType: CodeTargetType.TEACHER,
          teacherId: 'teacher-1',
          grantedCourseIds: ['course-1', 'course-2'],
        }),
        'course-1',
      );

      expect(scope.courseIds).toEqual(['course-1', 'course-2']);
      // A teacher card is not section-scoped.
      expect(scope.sectionIds).toBeNull();
    });

    it('does not unlock a course the teacher added after the code was issued', () => {
      expectInvalidCode(() =>
        resolveRedemptionScope(
          code({
            targetType: CodeTargetType.TEACHER,
            teacherId: 'teacher-1',
            grantedCourseIds: ['course-1'],
          }),
          // published after the batch was generated
          'course-9',
        ),
      );
    });
  });
});
