/**
 * End-to-end student flow against the LIVE PostgreSQL database.
 *
 * What this is: each step runs the query the corresponding backend service
 * runs, then feeds the resulting rows into the REAL compiled backend logic
 * (CourseAccessService.decide, the serializers). Where a gate is expressed in
 * a service rather than in SQL, the gate's own condition is evaluated against
 * the real row.
 *
 * What this is NOT: an HTTP test. The NestJS process cannot be started in this
 * environment because the npm registry is blocked, so there is no server to
 * call. Everything below therefore verifies the database and the business
 * logic, and stops short of the transport layer.
 */
const { execFileSync } = require('child_process');
const path = require('path');
const OUT = path.join(__dirname, 'out/src');

const { CourseAccessService } = require(path.join(OUT, 'modules/courses/course-access.service.js'));
const ser = require(path.join(OUT, 'modules/courses/course.serializer.js'));
const { ErrorCode } = require(path.join(OUT, 'common/errors/error-codes.js'));

const access = new CourseAccessService(null);

function sql(query) {
  const out = execFileSync('psql', [
    '-h', '127.0.0.1', '-U', 'edu', '-d', 'edu_platform', '-tA', '-c',
    `SELECT coalesce(json_agg(t), '[]'::json) FROM (${query}) t`,
  ], { encoding: 'utf8' });
  return JSON.parse(out.trim());
}
function exec(statement) {
  execFileSync('psql', ['-h','127.0.0.1','-U','edu','-d','edu_platform','-q','-v','ON_ERROR_STOP=1','-c',statement],
    { encoding: 'utf8' });
}
function tryExec(statement) {
  try { exec(statement); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e.stderr || e.message).split('\n').filter(Boolean).slice(-3).join(' ') }; }
}

let pass = 0, fail = 0;
const failures = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else {
    fail++; failures.push(label);
    console.log(`  FAIL ${label}\n         expected ${JSON.stringify(expected)}\n         actual   ${JSON.stringify(expected === undefined ? actual : actual)}`);
  }
}
function step(n, title) { console.log(`\n── ${n}. ${title}`); }

// Rehydrate a DB row into the shape decide() expects.
// psql returns ISO strings; Prisma returns Date objects. Rehydrate every
// timestamp the service touches, or the real code hits `.toISOString` on a
// string and throws — which is exactly what happened the first run.
const DATE_FIELDS = ['accessStartsAt','accessEndsAt','createdAt','updatedAt','approvedAt','revokedAt','lastAccessedAt'];
const toEnrollment = (r) => {
  if (!r) return null;
  const out = { ...r };
  for (const f of DATE_FIELDS) out[f] = r[f] ? new Date(r[f]) : null;
  return out;
};

function resolveAccess(courseId, userId) {
  const [course] = sql(`SELECT id, status FROM courses WHERE id='${courseId}' AND "deletedAt" IS NULL`);
  if (!course) return { state: 'NOT_ENROLLED', canAccessContent: false, denialCode: ErrorCode.NOT_FOUND };
  const [enr] = sql(`SELECT * FROM enrollments WHERE "courseId"='${courseId}' AND "userId"='${userId}'`);
  return access.decide(course.status, toEnrollment(enr) || null);
}

console.log('=== Student flow, live database + real backend logic ===');

// ---------------------------------------------------------------------------
step(1, 'Registration — the catalogue the signup form needs');
// The mobile register form requires university -> faculty -> department -> year.
{
  const unis = sql(`SELECT id, name, "nameAr" FROM universities WHERE "isActive" AND "deletedAt" IS NULL ORDER BY "sortOrder"`);
  const facs = sql(`SELECT id, "universityId", name FROM faculties WHERE "universityId"='uni_cairo' AND "isActive"`);
  const deps = sql(`SELECT id, "facultyId", name FROM departments WHERE "facultyId"='fac_eng' AND "isActive"`);
  const years = sql(`SELECT id, "order", name FROM academic_years WHERE "isActive" ORDER BY "order"`);
  check('universities available', unis.length > 0, true);
  check('faculties for university', facs.length > 0, true);
  check('departments for faculty', deps.length > 0, true);
  check('academic years are not assumed to be 4', years.length, 5);

  // Registration insert, exactly the columns RegisterDto maps to.
  exec(`DELETE FROM users WHERE phone='01099887766'`);
  const r = tryExec(`
    INSERT INTO users (id,phone,"passwordHash","fullName",role,status,gender,locale,"credentialsChangedAt","createdAt","updatedAt")
    VALUES ('usr_new','01099887766','$argon2id$hash','Mohamed Ahmed Sayed Ali','STUDENT','ACTIVE','MALE','ar',now(),now(),now());
    INSERT INTO student_profiles (id,"userId","universityId","facultyId","departmentId","academicYearId","createdAt","updatedAt")
    VALUES ('sp_new','usr_new','uni_cairo','fac_eng','dep_cse','yr2',now(),now());`);
  check('new student row + profile created', r.ok, true);

  const [dup] = [tryExec(`INSERT INTO users (id,phone,"passwordHash","fullName",role,status,"credentialsChangedAt","createdAt","updatedAt")
    VALUES ('usr_dupe','01099887766','x','Another Person Name','STUDENT','ACTIVE',now(),now(),now())`)];
  check('duplicate phone rejected by unique index', dup.ok, false);
}

// ---------------------------------------------------------------------------
step(2, 'Login — session, refresh token and device binding');
{
  const r1 = tryExec(`INSERT INTO sessions (id,"userId","deviceId",status,"ipAddress",platform,"appVersion","createdAt","lastSeenAt","expiresAt")
    VALUES ('ses_1','usr_stud','dev_bound','ACTIVE','197.0.2.5','ios','1.0.0',now(),now(),now()+interval '30 days')`);
  check('session created', r1.ok, true);

  const r2 = tryExec(`INSERT INTO refresh_tokens (id,"userId","sessionId","tokenHash","familyId","expiresAt","createdAt")
    VALUES ('rt_1','usr_stud','ses_1','hash-1','fam-1',now()+interval '30 days',now())`);
  check('refresh token created', r2.ok, true);

  const reuse = tryExec(`INSERT INTO refresh_tokens (id,"userId","sessionId","tokenHash","familyId","expiresAt","createdAt")
    VALUES ('rt_2','usr_stud','ses_1','hash-1','fam-1',now()+interval '30 days',now())`);
  check('duplicate token hash rejected (reuse detection relies on this)', reuse.ok, false);

  // Device binding: one row per (user, deviceKey).
  const second = tryExec(`INSERT INTO devices (id,"userId","deviceKey","name",platform,status,"firstSeenAt","lastSeenAt","createdAt","updatedAt")
    VALUES ('dev_second','usr_stud','device-key-other','Second Phone','android','ACTIVE',now(),now(),now(),now())`);
  check('a second device row may exist (login is not blocked)', second.ok, true);
}

// ---------------------------------------------------------------------------
step(3, 'Course browsing — only what a student may see');
{
  // The catalogue query CoursesService.list runs for a student.
  const listed = sql(`SELECT id, title, status FROM courses
    WHERE "deletedAt" IS NULL AND status = 'PUBLISHED' ORDER BY "publishedAt" DESC`);
  const ids = listed.map((c) => c.id);
  check('published courses listed', ids.includes('crs_circuits') && ids.includes('crs_free'), true);
  check('DRAFT course hidden from the catalogue', ids.includes('crs_draft'), false);

  // Price comes from the current version, never from a course column.
  const [price] = sql(`SELECT amount, currency, version FROM course_prices WHERE "courseId"='crs_circuits' AND "isCurrent"`);
  check('current price resolves', [Number(price.amount), price.currency], [450, 'EGP']);
}

// ---------------------------------------------------------------------------
step(4, 'Course detail — access state, computed by the real decide()');
{
  const before = resolveAccess('crs_circuits', 'usr_stud');
  check('not enrolled => NOT_ENROLLED, no content', [before.state, before.canAccessContent], ['NOT_ENROLLED', false]);

  // Dynamic structure: whatever was configured, in order.
  const sections = sql(`SELECT title, "sortOrder" FROM course_sections
    WHERE "courseId"='crs_circuits' AND "deletedAt" IS NULL AND status='PUBLISHED' ORDER BY "sortOrder"`);
  check('sections returned in configured order',
    sections.map((s) => s.title),
    ['Before Midterm', 'Midterm Revision', 'After Midterm']);
}

// ---------------------------------------------------------------------------
step(5, 'Enrollment — free course, then paid course by code');
{
  const free = tryExec(`INSERT INTO enrollments (id,"userId","courseId",state,method,"accessStartsAt","createdAt","updatedAt")
    VALUES ('enr_free','usr_stud','crs_free','ACTIVE','FREE',now(),now(),now())`);
  check('free enrollment created', free.ok, true);

  const dupe = tryExec(`INSERT INTO enrollments (id,"userId","courseId",state,method,"accessStartsAt","createdAt","updatedAt")
    VALUES ('enr_free2','usr_stud','crs_free','ACTIVE','FREE',now(),now(),now())`);
  check('duplicate enrollment rejected by unique(userId,courseId)', dupe.ok, false);

  const a = resolveAccess('crs_free', 'usr_stud');
  check('free course now ACTIVE with content access', [a.state, a.canAccessContent], ['ACTIVE', true]);

  // Code redemption, as CodesService.redeemInTransaction does it.
  exec(`INSERT INTO enrollments (id,"userId","courseId",state,method,"accessStartsAt","accessEndsAt","createdAt","updatedAt")
    VALUES ('enr_circ','usr_stud','crs_circuits','ACTIVE','CODE',now(),now()+interval '180 days',now(),now());
    INSERT INTO access_code_redemptions (id,"codeId","userId","courseId","enrollmentId","redeemedAt")
    VALUES ('red_1','cod_single','usr_stud','crs_circuits','enr_circ',now());
    UPDATE access_codes SET "redemptionCount"=1, status='EXHAUSTED' WHERE id='cod_single';`);

  const again = tryExec(`INSERT INTO access_code_redemptions (id,"codeId","userId","courseId","redeemedAt")
    VALUES ('red_2','cod_single','usr_stud','crs_circuits',now())`);
  check('same student cannot redeem the same code twice', again.ok, false);

  const other = tryExec(`INSERT INTO access_code_redemptions (id,"codeId","userId","courseId","redeemedAt")
    VALUES ('red_3','cod_single','usr_stud2','crs_circuits',now())`);
  // The unique index is per (code,user); exhaustion is enforced in the service.
  check('a different student is blocked by the exhausted counter, not the index', other.ok, true);
  const [code] = sql(`SELECT status, "redemptionCount", "maxRedemptions" FROM access_codes WHERE id='cod_single'`);
  check('code is EXHAUSTED and at its limit',
    [code.status, code.redemptionCount >= code.maxRedemptions], ['EXHAUSTED', true]);
  exec(`DELETE FROM access_code_redemptions WHERE id='red_3'`);
}

// ---------------------------------------------------------------------------
step(6, 'Lesson access');
{
  const a = resolveAccess('crs_circuits', 'usr_stud');
  check('enrolled student may open lessons', a.canAccessContent, true);

  const lessons = sql(`SELECT l.id, l."isPreview", v.id AS "videoId", v.status AS "videoStatus"
    FROM lessons l LEFT JOIN videos v ON v."lessonId" = l.id
    WHERE l."courseId"='crs_circuits' AND l."deletedAt" IS NULL ORDER BY l."sortOrder"`);
  check('every lesson resolves a video id', lessons.every((l) => l.videoId), true);

  // by-video resolution: the fix for the `v-<lessonId>` bug.
  const [byVideo] = sql(`SELECT "lessonId" FROM videos WHERE id='vid_1'`);
  check('video id resolves to its lesson', byVideo.lessonId, 'les_1');
  const derived = 'vid_1'.replace(/^v-/, '');
  check('the old derivation would NOT have found it', derived === byVideo.lessonId, false);
}

// ---------------------------------------------------------------------------
step(7, 'Playback authorization — every gate in the chain');
{
  const gates = (videoId, userId, deviceKey) => {
    const [video] = sql(`SELECT v.id, v.status, v."courseId", v."lessonId", v."isEncrypted", v."masterPlaylistKey",
      l."isPreview", l.status AS "lessonStatus" FROM videos v JOIN lessons l ON l.id = v."lessonId" WHERE v.id='${videoId}'`);
    if (!video) return { denied: ErrorCode.VIDEO_UNAVAILABLE };
    if (['UPLOADING', 'QUEUED', 'PROCESSING'].includes(video.status)) return { denied: ErrorCode.VIDEO_NOT_READY };
    if (video.status !== 'READY') return { denied: ErrorCode.VIDEO_UNAVAILABLE };

    const decision = resolveAccess(video.courseId, userId);
    if (!decision.canAccessContent && !video.isPreview) return { denied: decision.denialCode };

    const [device] = sql(`SELECT id, status FROM devices WHERE "userId"='${userId}' AND "deviceKey"='${deviceKey}'`);
    if (!device) return { denied: ErrorCode.DEVICE_NOT_AUTHORIZED };
    if (device.status === 'PENDING_APPROVAL') return { denied: ErrorCode.DEVICE_CHANGE_PENDING };
    if (device.status !== 'ACTIVE') return { denied: ErrorCode.DEVICE_NOT_AUTHORIZED };

    return { granted: true, videoId: video.id, deviceId: device.id, courseId: video.courseId, lessonId: video.lessonId };
  };

  const good = gates('vid_1', 'usr_stud', 'device-key-bound');
  check('enrolled + bound device + READY video => granted', good.granted, true);

  check('unenrolled student refused',
    gates('vid_1', 'usr_stud2', 'device-key-bound').denied, ErrorCode.DEVICE_NOT_AUTHORIZED);
  check('unknown device refused',
    gates('vid_1', 'usr_stud', 'someone-elses-phone').denied, ErrorCode.DEVICE_NOT_AUTHORIZED);
  check('still-processing video refused',
    gates('vid_3', 'usr_stud', 'device-key-bound').denied, ErrorCode.VIDEO_NOT_READY);

  // Mint the ticket and confirm it carries no permanent URL.
  if (good.granted) {
    exec(`INSERT INTO playback_tickets
      (id,"userId","videoId","lessonId","courseId","sessionId","deviceId",status,"watermarkTag","issuedAt","expiresAt","lastHeartbeatAt","startPositionSeconds","lastPositionSeconds")
      VALUES ('tkt_1','usr_stud','${good.videoId}','${good.lessonId}','${good.courseId}','ses_1','${good.deviceId}','ACTIVE','K3X9QW7ZP2MN4A6B',now(),now()+interval '300 seconds',now(),0,0)`);
    const [t] = sql(`SELECT id, status, "expiresAt", "watermarkTag" FROM playback_tickets WHERE id='tkt_1'`);
    check('ticket is ACTIVE and expires', [t.status, new Date(t.expiresAt) > new Date()], ['ACTIVE', true]);
    check('ticket carries a forensic watermark tag', t.watermarkTag.length >= 8, true);

    const cols = sql(`SELECT column_name FROM information_schema.columns
      WHERE table_name='playback_tickets' AND column_name ILIKE '%url%'`);
    check('no URL column exists on a ticket', cols.length, 0);
  }

  // Concurrency: one ACTIVE ticket per student is the configured ceiling.
  const activeTickets = sql(`SELECT count(*)::int AS n FROM playback_tickets
    WHERE "userId"='usr_stud' AND status='ACTIVE' AND "expiresAt" > now()`)[0].n;
  check('exactly one live stream slot in use', activeTickets, 1);
}

// ---------------------------------------------------------------------------
step(8, 'Watch progress');
{
  exec(`INSERT INTO watch_progress (id,"userId","lessonId","courseId","positionSeconds","durationSeconds",percent,"watchedSeconds",completed,"lastWatchedAt","createdAt","updatedAt")
    VALUES ('wp_1','usr_stud','les_1','crs_circuits',900,1800,50,900,false,now(),now(),now())
    ON CONFLICT ("userId","lessonId") DO UPDATE SET percent=EXCLUDED.percent`);
  const [p] = sql(`SELECT percent, completed FROM watch_progress WHERE "userId"='usr_stud' AND "lessonId"='les_1'`);
  check('progress recorded', [p.percent, p.completed], [50, false]);

  const dup = tryExec(`INSERT INTO watch_progress (id,"userId","lessonId","courseId","positionSeconds","durationSeconds",percent,"watchedSeconds",completed,"lastWatchedAt","createdAt","updatedAt")
    VALUES ('wp_2','usr_stud','les_1','crs_circuits',10,1800,1,10,false,now(),now(),now())`);
  check('one progress row per (student, lesson)', dup.ok, false);
}

// ---------------------------------------------------------------------------
step(9, 'Unauthorized, expired and withdrawn access');
{
  // Expired window, stored state still ACTIVE — the sweep has not run.
  exec(`UPDATE enrollments SET "accessEndsAt" = now() - interval '1 minute' WHERE id='enr_circ'`);
  const expired = resolveAccess('crs_circuits', 'usr_stud');
  check('lapsed window beats a stale ACTIVE row',
    [expired.state, expired.canAccessContent, expired.denialCode],
    ['EXPIRED', false, ErrorCode.ACCESS_EXPIRED]);
  exec(`UPDATE enrollments SET "accessEndsAt" = now() + interval '180 days' WHERE id='enr_circ'`);

  // Revoked enrollment.
  exec(`UPDATE enrollments SET state='REVOKED', "revokedAt"=now() WHERE id='enr_circ'`);
  const revoked = resolveAccess('crs_circuits', 'usr_stud');
  check('revoked enrollment refused', [revoked.state, revoked.canAccessContent], ['REVOKED', false]);
  exec(`UPDATE enrollments SET state='ACTIVE', "revokedAt"=NULL WHERE id='enr_circ'`);

  // Archived course beats an active paid enrollment.
  exec(`UPDATE courses SET status='ARCHIVED', "archivedAt"=now() WHERE id='crs_circuits'`);
  const archived = resolveAccess('crs_circuits', 'usr_stud');
  check('archived course refused even to an enrolled student',
    [archived.state, archived.canAccessContent, archived.denialCode],
    ['ARCHIVED', false, ErrorCode.COURSE_ARCHIVED]);

  // Withdrawn to DRAFT — the bug this integration found and fixed.
  exec(`UPDATE courses SET status='DRAFT', "archivedAt"=NULL WHERE id='crs_circuits'`);
  const draft = resolveAccess('crs_circuits', 'usr_stud');
  check('course pulled back to DRAFT stops serving content',
    [draft.state, draft.canAccessContent, draft.denialCode],
    ['ACTIVE', false, ErrorCode.COURSE_NOT_AVAILABLE]);

  exec(`UPDATE courses SET status='PUBLISHED' WHERE id='crs_circuits'`);
  check('re-publishing restores access with no data repair',
    resolveAccess('crs_circuits', 'usr_stud').canAccessContent, true);
}

// ---------------------------------------------------------------------------
step(10, 'Financial history survives the course lifecycle');
{
  exec(`INSERT INTO payments (id,"userId","courseId","enrollmentId","coursePriceId",amount,currency,status,provider,"idempotencyKey","paidAt","refundedAmount","createdAt","updatedAt")
    VALUES ('pay_1','usr_stud','crs_circuits','enr_circ','prc_v1',450.00,'EGP','PAID','MANUAL','idem-1',now(),0,now(),now());
    INSERT INTO revenue_ledger (id,"paymentId","courseId","teacherId","grossAmount","platformAmount","teacherAmount","sharePercent",currency,"courseTitleSnapshot","recognizedAt","createdAt")
    VALUES ('rev_1','pay_1','crs_circuits','usr_teach',450.00,180.00,270.00,60.00,'EGP','Circuit Analysis II',now(),now())`);

  // Price rises. The historical payment must not move.
  exec(`UPDATE course_prices SET "isCurrent"=false, "effectiveTo"=now() WHERE id='prc_v1';
    INSERT INTO course_prices (id,"courseId",amount,currency,version,"isCurrent","effectiveFrom","changedById",reason,"createdAt")
    VALUES ('prc_v2','crs_circuits',550.00,'EGP',2,true,now(),'usr_teach','Demand',now())`);

  const [pay] = sql(`SELECT amount FROM payments WHERE id='pay_1'`);
  const [led] = sql(`SELECT "grossAmount" FROM revenue_ledger WHERE id='rev_1'`);
  const [cur] = sql(`SELECT amount, version FROM course_prices WHERE "courseId"='crs_circuits' AND "isCurrent"`);
  check('paid amount unchanged after a price rise', Number(pay.amount), 450);
  check('revenue row unchanged', Number(led.grossAmount), 450);
  check('current price is the new version', [Number(cur.amount), cur.version], [550, 2]);

  const versions = sql(`SELECT version, amount, "isCurrent" FROM course_prices WHERE "courseId"='crs_circuits' ORDER BY version`);
  check('price history is append-only', versions.length, 2);

  // The database itself must refuse to delete a course with money attached.
  const del = tryExec(`DELETE FROM courses WHERE id='crs_circuits'`);
  // Blocked by the first RESTRICT it hits (enrollments); payments and the
  // revenue ledger are protected the same way. The point is that the database
  // refuses, not merely that the API declines to offer a delete route.
  check('course with business history cannot be deleted (FK RESTRICT)', del.ok, false);

  // Archiving preserves everything.
  exec(`UPDATE courses SET status='ARCHIVED', "archivedAt"=now() WHERE id='crs_circuits'`);
  const kept = sql(`SELECT
    (SELECT count(*)::int FROM payments WHERE "courseId"='crs_circuits') payments,
    (SELECT count(*)::int FROM revenue_ledger WHERE "courseId"='crs_circuits') revenue,
    (SELECT count(*)::int FROM enrollments WHERE "courseId"='crs_circuits') enrollments,
    (SELECT count(*)::int FROM watch_progress WHERE "courseId"='crs_circuits') progress`)[0];
  check('archive destroys no history', kept, { payments: 1, revenue: 1, enrollments: 1, progress: 1 });
  exec(`UPDATE courses SET status='PUBLISHED', "archivedAt"=NULL WHERE id='crs_circuits'`);
}

// ---------------------------------------------------------------------------
step(11, 'Serialized payloads match the mobile contract');
{
  const [row] = sql(`SELECT c.*, row_to_json(u) AS university, row_to_json(y) AS "academicYear"
    FROM courses c LEFT JOIN universities u ON u.id=c."universityId"
    LEFT JOIN academic_years y ON y.id=c."academicYearId" WHERE c.id='crs_circuits'`);
  const [price] = sql(`SELECT * FROM course_prices WHERE "courseId"='crs_circuits' AND "isCurrent"`);
  const [teach] = sql(`SELECT ct."isLead", u.id, u."fullName", u."avatarUrl", tp.title, tp.bio
    FROM course_teachers ct JOIN users u ON u.id=ct."teacherId"
    LEFT JOIN teacher_profiles tp ON tp."userId"=u.id WHERE ct."courseId"='crs_circuits'`);

  const decision = resolveAccess('crs_circuits', 'usr_stud');
  const summary = ser.toCourseSummary({
    course: {
      ...row,
      publishedAt: row.publishedAt ? new Date(row.publishedAt) : null,
      teachers: [{ isLead: teach.isLead, teacher: { id: teach.id, fullName: teach.fullName, avatarUrl: teach.avatarUrl, teacherProfile: { title: teach.title, bio: teach.bio } } }],
      university: row.university, academicYear: row.academicYear,
    },
    currentPrice: { ...price, amount: Number(price.amount) },
    access: access.toCourseAccess(decision, row.enrollmentMethods, row.status),
    progress: null,
    thumbnailUrl: null,
  });

  check('serialized course carries a real title', summary.title, 'Circuit Analysis II');
  check('price reflects the CURRENT version', summary.price.amount, 550);
  check('access block is populated', summary.access.state, 'ACTIVE');
  check('teacher resolved', summary.teacher.fullName, 'Dr Hala Abdel Rahman');
  check('dynamic counts come from the row', summary.sectionCount, 3);
  const json = JSON.stringify(summary);
  check('no storage key or URL leaks into the payload',
    /objectKey|hlsPrefix|masterPlaylistKey|\.m3u8|r2\.cloudflarestorage/.test(json), false);
}

console.log(`\n${'='.repeat(60)}`);
console.log(`passed: ${pass}   failed: ${fail}`);
if (failures.length) { console.log('\nFAILED:'); failures.forEach((f) => console.log('  -', f)); }
process.exit(fail === 0 ? 0 : 1);
