// READ-ONLY inventory. No writes, no deletes.
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const out = {};
  const counts = {};
  const models = [
    'user','course','courseSection','lesson','video','attachment','coursePart',
    'subject','university','faculty','department','academicYear',
    'accessCode','codeBatch','accessCodeRedemption','enrollment',
    'payment','revenueLedger','walletTransaction','wallet',
    'libraryMaterial','libraryPart','libraryPackage','libraryEntitlement','libraryPurchase',
    'announcement','notification','supportTicket','auditLog','loginLog',
    'device','session','watchProgress','playbackTicket','platformSetting',
  ];
  for (const m of models) {
    try { counts[m] = await p[m].count(); } catch (e) { counts[m] = `n/a (${e.code ?? 'err'})`; }
  }
  out.counts = counts;

  out.usersByRole = await p.user.groupBy({ by: ['role','status'], _count: true });

  out.users = (await p.user.findMany({
    select: { id:true, phone:true, fullName:true, role:true, status:true, createdAt:true, deletedAt:true },
    orderBy: { createdAt: 'asc' }, take: 200,
  }));

  out.courses = await p.course.findMany({
    select: { id:true, title:true, status:true, createdAt:true, deletedAt:true,
              _count: { select: { enrollments:true, sections:true } } },
    orderBy: { createdAt: 'asc' }, take: 100,
  });

  out.subjects = await p.subject.findMany({ select: { id:true, name:true, isActive:true } , take: 100});

  out.commercialActivity = {
    payments: await p.payment.count(),
    redemptions: await p.accessCodeRedemption.count(),
    revenueRows: await p.revenueLedger.count(),
    walletTx: await p.walletTransaction.count(),
    libraryPurchases: await p.libraryPurchase.count(),
    watchProgress: await p.watchProgress.count(),
    auditRows: await p.auditLog.count(),
  };

  console.log(JSON.stringify(out, null, 1));
  await p.$disconnect();
})().catch(async (e) => { console.error('ERR', e.message); process.exit(1); });
