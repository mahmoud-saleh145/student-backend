/**
 * Applies the four requested video-reuse mappings.
 *
 * SAFETY PROPERTIES
 *   * Creates NO video row. Every mapping points at an EXISTING video id, so no
 *     upload happens, no Gumlet asset is created and no bytes are copied.
 *   * Creates NO ingestion job. This script never touches the queue, never calls
 *     Gumlet and never writes to the `videos` table.
 *   * Idempotent. Re-running is a no-op thanks to the composite primary key.
 *   * Verifiable. Every step is checked before and after.
 */
const { PrismaClient } = require('C:/Users/mahmoud/Desktop/edu-backend-drm/node_modules/@prisma/client');
const p = new PrismaClient();

const MAPPINGS = [
  {
    group: 'A',
    sourceCourse: 'cmuztf102001lgi01r2di79fu',
    destCourse: 'cmuynazb7004nfe010ppjmh87',
  },
  {
    group: 'A',
    sourceCourse: 'cmuztf102001lgi01r2di79fu',
    destCourse: 'cmv47rdbc004fbl01v0ctc4nn',
  },
  {
    group: 'B',
    sourceCourse: 'cmuynelr0005jfe010jwnnzdf',
    destCourse: 'cmv4815wl006jbl01drye1nlz',
  },
  {
    group: 'B',
    sourceCourse: 'cmuynelr0005jfe010jwnnzdf',
    destCourse: 'cmuztj03u002lgi01b7ei0b8c',
  },
];

// Platform ordering: first section by (courseId, sortOrder), then first
// non-deleted lesson in it by sortOrder.
async function firstLesson(courseId) {
  const section = await p.courseSection.findFirst({
    where: { courseId, deletedAt: null },
    orderBy: { sortOrder: 'asc' },
    select: { id: true, title: true, sortOrder: true },
  });
  if (!section) return { section: null, lesson: null };

  const lesson = await p.lesson.findFirst({
    where: { sectionId: section.id, deletedAt: null },
    orderBy: { sortOrder: 'asc' },
    select: { id: true, title: true, sortOrder: true, durationSeconds: true },
  });
  return { section, lesson };
}

async function onlyVideo(lessonId) {
  const links = await p.lessonVideo.findMany({
    where: { lessonId, video: { deletedAt: null } },
    select: { video: { select: { id: true, gumletAssetId: true, status: true, durationSeconds: true } } },
  });
  return links.map((l) => l.video);
}

(async () => {
  const videoCountBefore = await p.video.count();
  const gumletBefore = await p.video.findMany({ select: { gumletAssetId: true } });

  const results = [];

  for (const m of MAPPINGS) {
    const src = await firstLesson(m.sourceCourse);
    const dst = await firstLesson(m.destCourse);

    const blocked = [];
    if (!src.lesson) blocked.push('source has no first lesson');
    if (!dst.lesson) blocked.push('destination has no first lesson');
    if (src.lesson && dst.lesson && src.lesson.id === dst.lesson.id) {
      blocked.push('source and destination are the same lecture');
    }

    const srcVideos = src.lesson ? await onlyVideo(src.lesson.id) : [];
    if (src.lesson && srcVideos.length === 0) blocked.push('source lecture has no attached video');
    if (srcVideos.length > 1) blocked.push(`source has ${srcVideos.length} videos (ambiguous)`);

    const dstVideos = dst.lesson ? await onlyVideo(dst.lesson.id) : [];

    // Re-running must be a no-op, and must say so. "Already attached to the very
    // video we would have attached" is success, not a conflict - reporting it as
    // BLOCKED makes a healthy system look broken.
    const alreadyApplied =
      dstVideos.length === 1 &&
      srcVideos.length === 1 &&
      dstVideos[0].id === srcVideos[0].id;

    if (alreadyApplied) {
      results.push({
        ...m,
        status: 'ALREADY_APPLIED',
        srcLesson: src.lesson.id,
        dstLesson: dst.lesson.id,
        videoId: srcVideos[0].id,
        gumletAssetId: srcVideos[0].gumletAssetId,
        assetStatus: srcVideos[0].status,
        assetDuration: srcVideos[0].durationSeconds,
        destAttachmentCount: 1,
      });
      continue;
    }

    if (dstVideos.length > 0) blocked.push('destination already has a video attached');

    if (blocked.length) {
      results.push({ ...m, status: 'BLOCKED', blocked, srcLesson: src.lesson?.id, dstLesson: dst.lesson?.id });
      continue;
    }

    const video = srcVideos[0];

    // The source's OWN association must remain intact after we touch anything.
    const sourceLinkBefore = await p.lessonVideo.findUnique({
      where: { lessonId_videoId: { lessonId: src.lesson.id, videoId: video.id } },
      select: { lessonId: true },
    });

    await p.lessonVideo.upsert({
      where: { lessonId_videoId: { lessonId: dst.lesson.id, videoId: video.id } },
      update: {},
      create: { lessonId: dst.lesson.id, videoId: video.id, sortOrder: 0 },
    });

    // Carry the asset's measured duration onto the destination lecture. A reused
    // lecture has no worker of its own, so this is the only way it learns.
    if (video.durationSeconds > 0) {
      await p.lesson.update({
        where: { id: dst.lesson.id },
        data: { durationSeconds: video.durationSeconds },
      });
    }

    // --- verification -------------------------------------------------------
    const destLinks = await p.lessonVideo.findMany({
      where: { lessonId: dst.lesson.id },
      select: { videoId: true },
    });
    const sourceLinkAfter = await p.lessonVideo.findUnique({
      where: { lessonId_videoId: { lessonId: src.lesson.id, videoId: video.id } },
      select: { lessonId: true },
    });
    const assetAfter = await p.video.findUnique({
      where: { id: video.id },
      select: { gumletAssetId: true, status: true, durationSeconds: true, courseId: true, lessonId: true },
    });

    results.push({
      ...m,
      status: destLinks.length === 1 && sourceLinkAfter ? 'APPLIED' : 'FAILED',
      srcLesson: src.lesson.id,
      dstLesson: dst.lesson.id,
      videoId: video.id,
      gumletAssetId: assetAfter.gumletAssetId,
      assetStatus: assetAfter.status,
      assetDuration: assetAfter.durationSeconds,
      assetCourseId: assetAfter.courseId,
      destAttachmentCount: destLinks.length,
      sourceIntact: Boolean(sourceLinkBefore && sourceLinkAfter),
      sameAsset: assetAfter.gumletAssetId === video.gumletAssetId,
    });
  }

  // Nothing new may have been created.
  const videoCountAfter = await p.video.count();
  const gumletAfter = await p.video.findMany({ select: { gumletAssetId: true } });
  const newAssets = gumletAfter.filter((a) => !gumletBefore.some((b) => b.gumletAssetId === a.gumletAssetId));

  console.log('=== RESULTS ===');
  for (const r of results) {
    console.log(
      'group %s  %s -> %s : %s',
      r.group, r.sourceCourse, r.destCourse, r.status,
    );
    console.log('   source lesson : %s', r.srcLesson);
    console.log('   dest   lesson : %s', r.dstLesson);
    if (r.status === 'BLOCKED') { console.log('   blocked: %s', r.blocked.join('; ')); continue; }
    console.log('   video         : %s  (gumlet asset %s, %s, %ds)', r.videoId, r.gumletAssetId, r.assetStatus, r.assetDuration);
    console.log(
      '   dest attachments=%d  sourceIntact=%s%s',
      r.destAttachmentCount,
      r.sourceIntact,
      r.status === 'ALREADY_APPLIED' ? '  (already applied; nothing changed)' : '',
    );
  }

  console.log('\n=== SAFETY ===');
  console.log('videos before=%d after=%d (delta %d)', videoCountBefore, videoCountAfter, videoCountAfter - videoCountBefore);
  console.log('new Gumlet assets created: %d', newAssets.length);
  if (videoCountAfter !== videoCountBefore) throw new Error('A VIDEO ROW WAS CREATED');
  if (newAssets.length !== 0) throw new Error('A GUMLET ASSET WAS CREATED');
  console.log('OK: no duplicate video row, no duplicate Gumlet asset.');
})().catch((e) => {
  console.log('ERROR: %s', e.stack.split('\n').slice(0, 5).join(' / '));
  process.exitCode = 1;
}).finally(() => p.$disconnect());
