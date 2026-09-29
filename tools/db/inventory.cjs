/*
 * READ-ONLY database inventory.
 *
 * Writes nothing and deletes nothing — every call in here is a count, a
 * groupBy or a findMany. Run it before deciding what, if anything, is
 * disposable:
 *
 *     node -r dotenv/config tools/db/inventory.cjs            # human summary
 *     node -r dotenv/config tools/db/inventory.cjs --json     # full JSON
 *
 * It answers the question that has to be settled first: is this database
 * carrying real commercial history, or is it disposable seed data? The
 * "commercial activity" block is the one that decides it. A single payment,
 * code redemption, wallet transaction, library purchase or revenue row means
 * this is not a scratch database, and nothing should be deleted wholesale.
 *
 * `DATABASE_URL` comes from .env, so this reads whichever database the API is
 * pointed at. Check that first if you are unsure which one you are looking at.
 */
const { PrismaClient } = require('@prisma/client');

const SEED_HINTS = [
  /^test[\s._-]/i, /\btest\b/i, /\bdemo\b/i, /\bsample\b/i, /\bdummy\b/i,
  /\bfake\b/i, /\bmock\b/i, /\bseed\b/i, /lorem/i, /example\.com$/i,
  /^aaa|^zzz|^qqq/i, /asdf/i, /1234567/,
];

const looksSeeded = (...values) =>
  values.filter(Boolean).some((v) => SEED_HINTS.some((r) => r.test(String(v))));

const MODELS = [
  'user', 'course', 'courseSection', 'lesson', 'video', 'attachment', 'coursePart',
  'subject', 'university', 'faculty', 'department', 'academicYear',
  'accessCode', 'codeBatch', 'accessCodeRedemption', 'enrollment',
  'payment', 'revenueLedger', 'wallet', 'walletTransaction',
  'libraryMaterial', 'libraryPart', 'libraryPackage', 'libraryEntitlement', 'libraryPurchase',
  'announcement', 'notification', 'supportTicket', 'auditLog', 'loginLog',
  'device', 'session', 'watchProgress', 'playbackTicket', 'platformSetting',
];

async function main() {
  const prisma = new PrismaClient();
  const report = { database: redactedUrl(), counts: {}, commercialActivity: {}, candidates: {} };

  for (const model of MODELS) {
    try {
      report.counts[model] = await prisma[model].count();
    } catch {
      report.counts[model] = 'n/a (no such model in this schema)';
    }
  }

  // The rows that make a database non-disposable. Every one of these is
  // history somebody paid for, watched, or is legally required to keep.
  report.commercialActivity = {
    payments: report.counts.payment,
    codeRedemptions: report.counts.accessCodeRedemption,
    revenueLedgerRows: report.counts.revenueLedger,
    walletTransactions: report.counts.walletTransaction,
    libraryPurchases: report.counts.libraryPurchase,
    libraryEntitlements: report.counts.libraryEntitlement,
    watchProgressRows: report.counts.watchProgress,
    auditLogRows: report.counts.auditLog,
  };

  report.usersByRoleAndStatus = await prisma.user.groupBy({
    by: ['role', 'status'],
    _count: { _all: true },
  });

  // Accounts with no trace of real use. "Candidate" is the operative word:
  // a real student who signed up and never bought anything looks identical.
  const users = await prisma.user.findMany({
    select: {
      id: true, phone: true, fullName: true, role: true, status: true,
      createdAt: true, deletedAt: true,
      _count: {
        select: { enrollments: true, payments: true, sessions: true },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  report.candidates.users = users
    .filter((u) => looksSeeded(u.fullName, u.phone))
    .map((u) => ({
      id: u.id, phone: u.phone, fullName: u.fullName, role: u.role,
      createdAt: u.createdAt, nameOrPhoneLooksSeeded: true,
      enrollments: u._count.enrollments,
      payments: u._count.payments,
      sessions: u._count.sessions,
      safeToRemove: u._count.enrollments === 0 && u._count.payments === 0,
    }));

  const courses = await prisma.course.findMany({
    select: {
      id: true, title: true, status: true, createdAt: true, deletedAt: true,
      _count: { select: { enrollments: true, sections: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  report.candidates.courses = courses
    .filter((c) => looksSeeded(c.title))
    .map((c) => ({
      id: c.id, title: c.title, status: c.status, createdAt: c.createdAt,
      enrollments: c._count.enrollments, sections: c._count.sections,
      safeToRemove: c._count.enrollments === 0,
    }));

  report.allCourses = courses.map((c) => ({
    id: c.id, title: c.title, status: c.status,
    enrollments: c._count.enrollments, deleted: Boolean(c.deletedAt),
  }));

  await prisma.$disconnect();
  return report;
}

function redactedUrl() {
  const raw = process.env.DATABASE_URL ?? '';
  return raw.replace(/\/\/[^@]*@/, '//***:***@');
}

main()
  .then((report) => {
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(`database: ${report.database}\n`);

    console.log('ROW COUNTS');
    for (const [model, count] of Object.entries(report.counts)) {
      console.log(`  ${model.padEnd(24)} ${count}`);
    }

    console.log('\nCOMMERCIAL / HISTORY ROWS  (any non-zero = not a disposable database)');
    let total = 0;
    for (const [label, count] of Object.entries(report.commercialActivity)) {
      if (typeof count === 'number') total += count;
      console.log(`  ${label.padEnd(24)} ${count}`);
    }

    console.log('\nACCOUNTS BY ROLE / STATUS');
    for (const row of report.usersByRoleAndStatus) {
      console.log(`  ${row.role.padEnd(10)} ${row.status.padEnd(12)} ${row._count._all}`);
    }

    console.log(`\nNAME/PHONE LOOKS LIKE TEST DATA — users: ${report.candidates.users.length}, courses: ${report.candidates.courses.length}`);
    for (const u of report.candidates.users) {
      console.log(`  user    ${u.phone.padEnd(14)} ${String(u.fullName).padEnd(28)} enrol=${u.enrollments} pay=${u.payments} ${u.safeToRemove ? '' : '<- HAS HISTORY, keep'}`);
    }
    for (const c of report.candidates.courses) {
      console.log(`  course  ${String(c.title).padEnd(40)} enrol=${c.enrollments} ${c.safeToRemove ? '' : '<- HAS STUDENTS, keep'}`);
    }

    console.log(
      total > 0
        ? '\nVERDICT: this database holds real purchase/watch/audit history. Do NOT bulk delete.'
        : '\nVERDICT: no commercial or watch history found. Cleanup may be reasonable — still review the lists above first.',
    );
  })
  .catch((error) => {
    console.error('inventory failed:', error.message);
    process.exit(1);
  });
