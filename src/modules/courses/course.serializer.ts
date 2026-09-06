import type {
  Attachment,
  Course,
  CoursePrice,
  CourseSection,
  Lesson,
  Prisma,
  Video,
  WatchProgress,
} from '@prisma/client';

import type { CourseAccess } from './course-access.service';

/**
 * Serialization layer.
 *
 * Every shape here is pinned to the mobile app's `src/types/domain.ts`. The
 * app was built first, so the contract is fixed: field names, nullability and
 * the ISO-string date format all match what its components already read. Any
 * change here is a breaking API change.
 *
 * Two conventions worth stating:
 *  - Dates leave as ISO 8601 strings, never Date objects or epoch numbers.
 *  - Money is `{ amount: number, currency: string }`, with amount as a plain
 *    number because Prisma Decimal does not survive JSON serialization
 *    usefully. Rounding to 2dp happens here, once.
 */

export type CourseWithRelations = Course & {
  teachers: {
    isLead: boolean;
    teacher: {
      id: string;
      fullName: string;
      avatarUrl: string | null;
      teacherProfile: { title: string | null; bio: string | null } | null;
    };
  }[];
  prices?: CoursePrice[];
  university?: { id: string; name: string; nameAr: string } | null;
  academicYear?: { id: string; name: string; nameAr: string } | null;
};

export interface Money {
  amount: number;
  currency: string;
}

export function toMoney(price: CoursePrice | null | undefined): Money | null {
  if (!price) return null;
  return {
    amount: Number(price.amount.toFixed ? price.amount.toFixed(2) : price.amount),
    currency: price.currency,
  };
}

export function decimalToNumber(value: Prisma.Decimal | number | null | undefined): number {
  if (value == null) return 0;
  return typeof value === 'number' ? value : Number(value.toString());
}

export function toTeacher(entry: CourseWithRelations['teachers'][number]) {
  return {
    id: entry.teacher.id,
    fullName: entry.teacher.fullName,
    avatarUrl: entry.teacher.avatarUrl,
    title: entry.teacher.teacherProfile?.title ?? null,
    bio: entry.teacher.teacherProfile?.bio ?? null,
  };
}

/** The lead teacher, or the first assigned one — cards show a single name. */
export function primaryTeacher(course: CourseWithRelations) {
  const lead = course.teachers.find((t) => t.isLead) ?? course.teachers[0];
  return lead
    ? toTeacher(lead)
    : { id: '', fullName: 'Unassigned', avatarUrl: null, title: null, bio: null };
}

export interface CourseProgressDto {
  completedLessons: number;
  totalLessons: number;
  percent: number;
  lastLessonId: string | null;
  lastWatchedAt: string | null;
}

/** Matches the app's `CourseSummary`. */
export function toCourseSummary(params: {
  course: CourseWithRelations;
  currentPrice: CoursePrice | null;
  access: CourseAccess;
  progress: CourseProgressDto | null;
  thumbnailUrl: string | null;
}) {
  const { course, currentPrice, access, progress, thumbnailUrl } = params;

  return {
    id: course.id,
    title: course.title,
    slug: course.slug,
    shortDescription: course.shortDescription,
    thumbnailUrl,
    teacher: primaryTeacher(course),
    // Every assigned teacher, for the detail screen and future co-teaching UI.
    teachers: course.teachers.map(toTeacher),
    status: course.status,
    price: course.isFree ? null : toMoney(currentPrice),
    isFree: course.isFree,
    lessonCount: course.lessonCount,
    sectionCount: course.sectionCount,
    totalDurationSeconds: course.totalDurationSeconds,
    rating:
      course.ratingCount > 0
        ? Math.round((course.ratingSum / course.ratingCount) * 10) / 10
        : null,
    studentCount: course.studentCount,
    university: course.university
      ? { id: course.university.id, name: course.university.name, nameAr: course.university.nameAr }
      : null,
    academicYear: course.academicYear
      ? {
          id: course.academicYear.id,
          name: course.academicYear.name,
          nameAr: course.academicYear.nameAr,
        }
      : null,
    access,
    progress,
    publishedAt: course.publishedAt ? course.publishedAt.toISOString() : null,
  };
}

export type SectionWithLessons = CourseSection & {
  lessons: (Lesson & {
    video: Pick<Video, 'id' | 'status' | 'durationSeconds'> | null;
    _count?: { attachments: number };
  })[];
};

export interface LessonProgressLookup {
  get(lessonId: string): WatchProgress | undefined;
}

/** Matches the app's `WatchProgress`. */
export function toWatchProgress(progress: WatchProgress | undefined | null) {
  if (!progress) return null;
  return {
    lessonId: progress.lessonId,
    positionSeconds: progress.positionSeconds,
    durationSeconds: progress.durationSeconds,
    percent: progress.percent,
    completed: progress.completed,
    lastWatchedAt: progress.lastWatchedAt.toISOString(),
  };
}

/** Matches the app's `LessonSummary`. */
export function toLessonSummary(params: {
  lesson: SectionWithLessons['lessons'][number];
  hasCourseAccess: boolean;
  sectionLocked: boolean;
  progress: WatchProgress | undefined;
}) {
  const { lesson, hasCourseAccess, sectionLocked, progress } = params;

  // A lesson is locked unless the student has course access, or it is an
  // explicit free preview. Locked lessons are still RETURNED, with their
  // titles — the app shows them greyed out so the student can evaluate the
  // course before joining.
  const locked = (!hasCourseAccess || sectionLocked) && !lesson.isPreview;

  return {
    id: lesson.id,
    sectionId: lesson.sectionId,
    courseId: lesson.courseId,
    title: lesson.title,
    kind: lesson.kind,
    order: lesson.sortOrder,
    durationSeconds: lesson.durationSeconds || lesson.video?.durationSeconds || 0,
    isPreview: lesson.isPreview,
    locked,
    attachmentCount: lesson._count?.attachments ?? 0,
    progress: toWatchProgress(progress),
  };
}

/** Matches the app's `CourseSection`. Structure is whatever the DB holds. */
export function toSection(params: {
  section: SectionWithLessons;
  hasCourseAccess: boolean;
  progressByLesson: Map<string, WatchProgress>;
}) {
  const { section, hasCourseAccess, progressByLesson } = params;

  const dripLocked =
    section.unlocksAt !== null && section.unlocksAt.getTime() > Date.now();
  const locked = dripLocked || !hasCourseAccess;

  const lessons = section.lessons.map((lesson) =>
    toLessonSummary({
      lesson,
      hasCourseAccess,
      sectionLocked: dripLocked,
      progress: progressByLesson.get(lesson.id),
    }),
  );

  const completed = lessons.filter((l) => l.progress?.completed).length;

  return {
    id: section.id,
    courseId: section.courseId,
    title: section.title,
    description: section.description,
    order: section.sortOrder,
    lessonCount: lessons.length,
    durationSeconds: lessons.reduce((sum, l) => sum + l.durationSeconds, 0),
    locked,
    unlocksAt: section.unlocksAt ? section.unlocksAt.toISOString() : null,
    progressPercent:
      lessons.length > 0 ? Math.round((completed / lessons.length) * 100) : 0,
    lessons,
  };
}

/** Matches the app's `Attachment`. */
export function toAttachment(attachment: Attachment, hasCourseAccess: boolean) {
  return {
    id: attachment.id,
    lessonId: attachment.lessonId,
    courseId: attachment.courseId,
    title: attachment.title,
    kind: attachment.kind,
    sizeBytes: attachment.sizeBytes ? Number(attachment.sizeBytes) : null,
    pageCount: attachment.pageCount,
    protected: attachment.isProtected,
    downloadable: attachment.isDownloadable && !attachment.isProtected,
    locked: !hasCourseAccess && !attachment.isPreview,
  };
}

/** Matches the app's `CompletionRule`, resolving the lesson→course fallback. */
export function toCompletionRule(
  lesson: Pick<
    Lesson,
    'completionRuleType' | 'completionThreshold' | 'completionRequireContiguous'
  >,
  course: Pick<
    Course,
    'completionRuleType' | 'completionThreshold' | 'completionRequireContiguous'
  >,
) {
  return {
    type: lesson.completionRuleType ?? course.completionRuleType,
    threshold: lesson.completionThreshold ?? course.completionThreshold,
    requireContiguous:
      lesson.completionRequireContiguous ?? course.completionRequireContiguous,
  };
}

/** Course-level progress from the per-lesson rows. */
export function computeCourseProgress(
  totalLessons: number,
  progressRows: WatchProgress[],
): CourseProgressDto | null {
  if (progressRows.length === 0) return null;

  const completed = progressRows.filter((p) => p.completed).length;
  const latest = progressRows.reduce<WatchProgress | null>(
    (acc, row) =>
      !acc || row.lastWatchedAt.getTime() > acc.lastWatchedAt.getTime() ? row : acc,
    null,
  );

  return {
    completedLessons: completed,
    totalLessons,
    percent: totalLessons > 0 ? Math.round((completed / totalLessons) * 100) : 0,
    lastLessonId: latest?.lessonId ?? null,
    lastWatchedAt: latest?.lastWatchedAt.toISOString() ?? null,
  };
}
