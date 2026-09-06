/**
 * Executes the REAL backend serializers and diffs their actual output keys
 * against the mobile app's TypeScript interfaces.
 *
 * This replaces regex-guessing: the serializer is called, and the object it
 * really returns is compared field by field with what the app declares it
 * will read.
 */
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'out/src');

const ser = require(path.join(OUT, 'modules/courses/course.serializer.js'));
const { CourseStatus, EnrollmentState, ContentStatus, LessonKind, VideoStatus } = require('@prisma/client');

// --- parse the mobile's domain.ts -------------------------------------------
const domain = fs.readFileSync('../../../edu-mobile/src/types/domain.ts', 'utf8');

function ifaceBody(name) {
  const re = new RegExp('export interface ' + name + '(?: extends ([\\w<>\'|, ]+))?\\s*\\{');
  const m = domain.match(re);
  if (!m) return null;
  let i = domain.indexOf('{', m.index);
  let depth = 0, j = i;
  while (j < domain.length) {
    if (domain[j] === '{') depth++;
    else if (domain[j] === '}') { depth--; if (depth === 0) break; }
    j++;
  }
  return { parent: m[1] ? m[1].trim() : null, body: domain.slice(i + 1, j) };
}

function fieldsOf(name) {
  const found = ifaceBody(name);
  if (!found) return null;
  let body = found.body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  // strip nested object literals so only top-level members are seen
  let depth = 0, flat = '';
  for (const ch of body) {
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (depth === 0) { flat += ch; continue; }
    if (depth === 0) flat += ch; else flat += ' ';
  }
  const out = {};
  for (const line of flat.split(/[;\n]/)) {
    const fm = line.trim().match(/^(\w+)(\??)\s*:/);
    if (fm) out[fm[1]] = fm[2] === '?';
  }
  if (found.parent) {
    const pf = fieldsOf(found.parent.replace(/\s.*$/, ''));
    if (pf) return { ...pf, ...out };
  }
  return out;
}

// --- realistic Prisma-shaped fixtures ---------------------------------------
const now = new Date();
const D = (n) => ({ toFixed: (p) => n.toFixed(p), toString: () => String(n) });

const course = {
  id: 'crs1', slug: 'circuits-2', title: 'Circuit Analysis II', titleAr: 'تحليل الدوائر',
  shortDescription: 'Phasors and AC analysis', description: 'Long text',
  thumbnailKey: 'img/c.jpg', status: CourseStatus.PUBLISHED,
  isFree: false, lessonCount: 9, sectionCount: 3, totalDurationSeconds: 21000,
  studentCount: 42, ratingSum: 44, ratingCount: 10,
  requirements: ['laptop'], outcomes: ['pass'],
  publishedAt: now, updatedAt: now, createdAt: now, archivedAt: null, deletedAt: null,
  accessDurationType: 'FIXED_DAYS', accessDurationDays: 180, accessEndsAt: null,
  enrollmentMethods: ['PAYMENT', 'CODE'],
  completionRuleType: 'WATCH_PERCENT', completionThreshold: 90, completionRequireContiguous: true,
  teachers: [{
    isLead: true,
    teacher: { id: 't1', fullName: 'Dr Hala Abdel Rahman', avatarUrl: null,
      teacherProfile: { title: 'Professor', bio: 'bio' } },
  }],
  university: { id: 'u1', name: 'Cairo University', nameAr: 'جامعة القاهرة' },
  academicYear: { id: 'y2', name: 'Second Year', nameAr: 'الفرقة الثانية' },
};

const price = { id: 'p1', amount: D(450), currency: 'EGP', version: 1, isCurrent: true };

const access = { state: 'ACTIVE', expiresAt: now.toISOString(), enrolledAt: now.toISOString(), availableMethods: ['PAYMENT', 'CODE'] };
const progress = { completedLessons: 3, totalLessons: 9, percent: 33, lastLessonId: 'les1', lastWatchedAt: now.toISOString() };

const watchProgress = {
  lessonId: 'les1', positionSeconds: 300, durationSeconds: 600, percent: 50,
  completed: false, lastWatchedAt: now, watchedSeconds: 300,
};

// --- run the real serializers -----------------------------------------------
const results = [];

results.push(['CourseSummary', ser.toCourseSummary({
  course, currentPrice: price, access, progress, thumbnailUrl: 'https://cdn/x.jpg',
})]);

results.push(['WatchProgress', ser.toWatchProgress(watchProgress)]);

if (ser.toAttachment) {
  results.push(['Attachment', ser.toAttachment({
    id: 'att1', courseId: 'crs1', lessonId: 'les1', title: 'Syllabus', titleAr: null,
    kind: 'PDF', objectKey: 'k', mimeType: 'application/pdf', sizeBytes: BigInt(1024),
    pageCount: 4, isProtected: true, isDownloadable: false, isPreview: false,
    sortOrder: 1, createdAt: now, updatedAt: now, deletedAt: null,
  }, true)]);
}

if (ser.toLessonSummary) {
  results.push(['LessonSummary', ser.toLessonSummary({
    lesson: {
      id: 'les1', sectionId: 'sec1', courseId: 'crs1', title: 'Phasors', titleAr: null,
      description: null, kind: LessonKind.VIDEO, sortOrder: 1, status: ContentStatus.PUBLISHED,
      isPreview: true, durationSeconds: 600, createdAt: now, updatedAt: now, deletedAt: null,
      completionRuleType: null, completionThreshold: null, completionRequireContiguous: null,
      video: { id: 'vid1', status: VideoStatus.READY, durationSeconds: 600 },
      _count: { attachments: 2 },
    },
    hasCourseAccess: true, sectionLocked: false, progress: watchProgress,
  })]);
}

if (ser.toSection) {
  results.push(['CourseSection', ser.toSection({
    section: {
      id: 'sec1', courseId: 'crs1', title: 'Before Midterm', titleAr: null,
      description: null, sortOrder: 1, status: ContentStatus.PUBLISHED, unlocksAt: null,
      createdAt: now, updatedAt: now, deletedAt: null,
      lessons: [{
        id: 'les1', sectionId: 'sec1', courseId: 'crs1', title: 'Phasors', titleAr: null,
        description: null, kind: LessonKind.VIDEO, sortOrder: 1, status: ContentStatus.PUBLISHED,
        isPreview: true, durationSeconds: 600, createdAt: now, updatedAt: now, deletedAt: null,
        completionRuleType: null, completionThreshold: null, completionRequireContiguous: null,
        video: { id: 'vid1', status: VideoStatus.READY, durationSeconds: 600 },
        _count: { attachments: 0 },
      }],
    },
    hasCourseAccess: true,
    progressByLesson: new Map([['les1', watchProgress]]),
  })]);
}

// --- diff --------------------------------------------------------------------
let problems = 0;
console.log('=== Backend serializer output vs mobile domain types ===\n');

for (const [typeName, value] of results) {
  const expected = fieldsOf(typeName);
  if (!expected) { console.log(`${typeName}: (no such interface in domain.ts) — skipped\n`); continue; }
  const got = new Set(Object.keys(value));
  const missingRequired = Object.entries(expected).filter(([k, opt]) => !opt && !got.has(k)).map(([k]) => k);
  const missingOptional = Object.entries(expected).filter(([k, opt]) => opt && !got.has(k)).map(([k]) => k);
  const extra = [...got].filter((k) => !(k in expected));

  const status = missingRequired.length ? 'MISMATCH' : 'OK';
  if (missingRequired.length) problems++;
  console.log(`${status.padEnd(9)} ${typeName}`);
  if (missingRequired.length) console.log(`          missing REQUIRED: ${missingRequired.join(', ')}`);
  if (missingOptional.length) console.log(`          missing optional: ${missingOptional.join(', ')}`);
  if (extra.length) console.log(`          backend extras  : ${extra.join(', ')}`);
  console.log();
}

console.log(problems === 0
  ? 'All serializers satisfy the mobile contract.'
  : `${problems} type(s) with missing required fields.`);
process.exit(problems === 0 ? 0 : 1);
