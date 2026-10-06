/**
 * Course targeting enforcement — THE switch.
 *
 * Courses can be filed against a university, faculty, department set and
 * academic year, and `CourseAccessService.isTargetedToStudent` still evaluates
 * that rule exactly as before. What this flag controls is only whether the rule
 * is ENFORCED when a student joins a course, redeems a course card, or a
 * multi-course card reaches other courses (`assertCourseTargeting`).
 *
 * Product decision (2026-10-06): targeting is temporarily NOT enforced. Every
 * student can see and join any published course regardless of university,
 * faculty, department or year. Nothing was removed — the columns, the admin
 * fields, the API response data, the resolver and its tests are all intact.
 *
 * To turn enforcement back on: set this to `true` and redeploy the API. No
 * client or schema change is needed: the web already shows a specific message
 * for the resulting `COURSE_NOT_TARGETED` error, and the mobile app shows its
 * generic "no permission" message for it.
 */
export const COURSE_TARGETING_ENABLED = false;
