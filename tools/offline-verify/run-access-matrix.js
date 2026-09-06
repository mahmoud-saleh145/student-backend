/**
 * Executes the REAL compiled CourseAccessService.decide() across the full
 * matrix of course states x enrollment states. No mocks of the logic itself —
 * only the Prisma client is stubbed, and decide() never touches it.
 */
const path = require('path');
const OUT = path.join(__dirname, 'out/src');

const { CourseAccessService } = require(path.join(OUT, 'modules/courses/course-access.service.js'));
const { ErrorCode } = require(path.join(OUT, 'common/errors/error-codes.js'));
const { CourseStatus, EnrollmentState } = require('@prisma/client');

const svc = new CourseAccessService(null);
const DAY = 86400000;

function enr(o = {}) {
  return {
    id: 'enr1', userId: 'u1', courseId: 'c1',
    state: EnrollmentState.ACTIVE, method: 'PAYMENT',
    accessStartsAt: new Date(Date.now() - DAY),
    accessEndsAt: null,
    revokedAt: null, completedLessons: 0, lastLessonId: null,
    ...o,
  };
}

let pass = 0, fail = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else { fail++; failures.push(`${label}\n     expected ${JSON.stringify(expected)}\n     actual   ${JSON.stringify(actual)}`); }
}

console.log('=== CourseAccessService.decide() — real code, full matrix ===\n');

// 1. Every (courseStatus x enrollmentState) combination.
const rows = [];
for (const cs of Object.values(CourseStatus)) {
  for (const es of Object.values(EnrollmentState)) {
    const d = svc.decide(cs, enr({ state: es }));
    rows.push([cs, es, d.state, d.canAccessContent, d.denialCode || '-']);
  }
  const dn = svc.decide(cs, null);
  rows.push([cs, '(none)', dn.state, dn.canAccessContent, dn.denialCode || '-']);
}
const w = [10, 18, 18, 7];
console.log('course'.padEnd(w[0]), 'enrollment'.padEnd(w[1]), 'state'.padEnd(w[2]), 'access'.padEnd(w[3]), 'denial');
console.log('-'.repeat(78));
for (const r of rows) {
  console.log(String(r[0]).padEnd(w[0]), String(r[1]).padEnd(w[1]), String(r[2]).padEnd(w[2]), String(r[3]).padEnd(w[3]), r[4]);
}

console.log('\n=== Invariant assertions ===\n');

// A. Only PUBLISHED + ACTIVE enrollment may access content.
for (const cs of Object.values(CourseStatus)) {
  for (const es of Object.values(EnrollmentState)) {
    const d = svc.decide(cs, enr({ state: es }));
    // HIDDEN is "unlisted": off the catalogue, unchanged for enrolled students.
    // DRAFT and SUSPENDED withhold delivery; ARCHIVED withholds everything.
    const deliverable = cs === CourseStatus.PUBLISHED || cs === CourseStatus.HIDDEN;
    const shouldAllow = deliverable && es === EnrollmentState.ACTIVE;
    check(`access(${cs}, ${es})`, d.canAccessContent, shouldAllow);
  }
}

// B. Archive beats everything.
for (const es of Object.values(EnrollmentState)) {
  const d = svc.decide(CourseStatus.ARCHIVED, enr({ state: es }));
  check(`archived beats ${es}`, [d.state, d.canAccessContent], ['ARCHIVED', false]);
}

// C. The live window overrides a stale stored ACTIVE.
{
  const d = svc.decide(CourseStatus.PUBLISHED, enr({
    state: EnrollmentState.ACTIVE, accessEndsAt: new Date(Date.now() - 60000),
  }));
  check('stale ACTIVE + lapsed window => EXPIRED',
    [d.state, d.canAccessContent, d.denialCode],
    ['EXPIRED', false, ErrorCode.ACCESS_EXPIRED]);
}

// D. Boundary: end date 1ms in the past is closed.
{
  const d = svc.decide(CourseStatus.PUBLISHED, enr({ accessEndsAt: new Date(Date.now() - 1) }));
  check('window boundary closed', d.state, 'EXPIRED');
}

// E. Future window => still pending, not active.
{
  const d = svc.decide(CourseStatus.PUBLISHED, enr({ accessStartsAt: new Date(Date.now() + DAY) }));
  check('future start => no access', d.canAccessContent, false);
}

// F. Suspended and draft keep the enrollment but withhold content.
for (const cs of [CourseStatus.SUSPENDED, CourseStatus.DRAFT]) {
  const d = svc.decide(cs, enr());
  check(`${cs} => ACTIVE state, no content`,
    [d.state, d.canAccessContent, d.denialCode],
    ['ACTIVE', false, ErrorCode.COURSE_NOT_AVAILABLE]);
}
// F2. HIDDEN is unlisted, not withheld — enrolled students keep access.
{
  const d = svc.decide(CourseStatus.HIDDEN, enr());
  check('hidden => enrolled student keeps access', d.canAccessContent, true);
}

// G. Every denial names a code (else the app gets an unrenderable 500).
for (const cs of Object.values(CourseStatus)) {
  for (const es of [...Object.values(EnrollmentState), null]) {
    const d = svc.decide(cs, es ? enr({ state: es }) : null);
    if (!d.canAccessContent) check(`denial code present (${cs},${es})`, typeof d.denialCode, 'string');
  }
}

// H. Reported state is always inside the mobile app's AccessState union.
const UNION = ['NOT_ENROLLED','PENDING_APPROVAL','PENDING_PAYMENT','ACTIVE','EXPIRED','REVOKED','ARCHIVED'];
for (const cs of Object.values(CourseStatus)) {
  for (const es of [...Object.values(EnrollmentState), null]) {
    const d = svc.decide(cs, es ? enr({ state: es }) : null);
    check(`state in mobile union (${cs},${es})`, UNION.includes(d.state), true);
  }
}

console.log(`passed: ${pass}   failed: ${fail}`);
if (failures.length) {
  console.log('\nFAILURES:');
  failures.forEach((f) => console.log('  -', f));
}
process.exit(fail === 0 ? 0 : 1);
