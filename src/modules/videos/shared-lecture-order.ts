/**
 * Candidate order for a SHARED video when the client names no lecture.
 *
 * The native app and older web builds request playback (and lesson details)
 * with a video id only. When that video is attached to several lectures, the
 * server has to pick the lecture the request is "for" - and the pick decides
 * which course the ticket, watch events, progress and completion belong to.
 *
 * Order (deterministic, documented):
 *   1. Lectures in courses where the user has FULL access - an enrolment, or a
 *      staff role - i.e. CourseAccessService.resolve(...).canAccessContent.
 *      These are the user's own courses: the only lectures a request without
 *      context can plausibly be "for".
 *   2. Every other lecture - reachable, if at all, only through the free-
 *      preview rule. Kept as a fallback so preview access is preserved for
 *      users with no enrolment.
 *   Within each tier: the uploading (origin) lecture first, then the oldest
 *   attachment first.
 *
 * This only ORDERS candidates. Each caller still applies its full lesson
 * checks (publication, course access incl. the preview rule, section access,
 * drip release) to every candidate in this order and uses the first that
 * passes, so nothing becomes reachable that the user could not open by naming
 * that lecture. Without tier 1, an origin lecture marked as a free preview in
 * ANOTHER course won every unnamed request - even for a student enrolled only
 * in the destination course - and their progress landed in the wrong course.
 *
 * Callers MUST pass candidates already in attachment order (oldest first).
 */
export async function orderSharedLectureCandidates<T extends { id: string; courseId: string }>(
  candidates: readonly T[],
  originLessonId: string | null,
  hasFullAccess: (courseId: string) => Promise<boolean>,
): Promise<T[]> {
  const access = new Map<string, Promise<boolean>>();
  const full = (courseId: string) => {
    let decision = access.get(courseId);
    if (!decision) {
      // An access lookup that fails is "not full access": the candidate stays
      // in the fallback tier, where its own checks still decide.
      decision = hasFullAccess(courseId).catch(() => false);
      access.set(courseId, decision);
    }
    return decision;
  };

  const originFirst = [
    ...candidates.filter((c) => c.id === originLessonId),
    ...candidates.filter((c) => c.id !== originLessonId),
  ];
  const flags = await Promise.all(originFirst.map((c) => full(c.courseId)));
  return [
    ...originFirst.filter((_c, i) => flags[i]),
    ...originFirst.filter((_c, i) => !flags[i]),
  ];
}
