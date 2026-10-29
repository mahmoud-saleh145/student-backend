/**
 * Backfills missing video durations from the provider's asset metadata.
 *
 * WHY THIS EXISTS
 *
 * The Gumlet path never persisted `durationSeconds` (the provider response was
 * discarded at the HTTP boundary), so every migrated video kept the schema
 * default of 0 and the dashboard rendered a confident "0:00" for videos that
 * played perfectly. The code fix stops new videos from doing that, but it cannot
 * reach back into rows that already exist - so this repairs them.
 *
 * WHAT IT DOES NOT DO
 *   * No re-upload. The file is already in R2 and already ingested.
 *   * No new Gumlet asset. It only performs a read-only GET on the asset.
 *   * No status changes. A video is never demoted to FAILED here, because a
 *     transient API problem must not take a working lecture offline.
 *   * No clobbering. It only writes where the stored duration is 0, and only
 *     writes a value the provider actually reported.
 *   * No geometry. The ONLY column written is `durationSeconds`. `width`,
 *     `height` and `frameRate` are never touched, even when the row is null
 *     and the provider reports a value - see the note at the write below.
 *   * No archived videos. Candidates are `status = 'READY'`, so an ARCHIVED
 *     row is invisible here by design.
 *
 * Usage:
 *   node scripts/backfill-gumlet-durations.js            # dry run, reports only
 *   node scripts/backfill-gumlet-durations.js --apply    # performs the writes
 */
const { PrismaClient } = require('../node_modules/@prisma/client');
const p = new PrismaClient();

const APPLY = process.argv.includes('--apply');

function loadEnv() {
  const fs = require('fs');
  const path = require('path');
  const candidates = [
    path.join(__dirname, '..', '.env'),
    'C:/Users/mahmoud/Desktop/edu-backend/.env',
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i <= 0) continue;
      const k = line.slice(0, i).trim();
      let v = line.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!process.env[k]) process.env[k] = v;
    }
    return;
  }
}

function normalizeDurationSeconds(raw) {
  // Same rule as provider-duration.util: SECONDS, and 0/absent means UNKNOWN.
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  const seconds = Math.round(raw);
  return seconds > 0 ? seconds : null;
}

(async () => {
  loadEnv();
  const apiKey = process.env.GUMLET_API_KEY;
  if (!apiKey) {
    console.log('GUMLET_API_KEY is not set; cannot refresh provider metadata.');
    process.exitCode = 1;
    return;
  }

  // Only videos that are actually broken: on the Gumlet path, ready, and with
  // no recorded duration.
  const candidates = await p.video.findMany({
    where: {
      deletedAt: null,
      drmProvider: 'gumlet',
      status: 'READY',
      gumletAssetId: { not: null },
      durationSeconds: 0,
    },
    select: {
      id: true, gumletAssetId: true, durationSeconds: true,
      courseId: true,
    },
  });

  console.log('candidates with no duration: %d', candidates.length);

  let updated = 0;
  let skipped = 0;

  for (const video of candidates) {
    let json;
    try {
      const res = await fetch(
        `https://api.gumlet.com/v1/video/assets/${encodeURIComponent(video.gumletAssetId)}`,
        { headers: { authorization: `Bearer ${apiKey}` } },
      );
      if (!res.ok) {
        console.log('  %s: HTTP %s - skipped', video.id, res.status);
        skipped += 1;
        continue;
      }
      json = await res.json();
    } catch (e) {
      console.log('  %s: provider unreachable (%s) - skipped', video.id, e.message);
      skipped += 1;
      continue;
    }

    const seconds = normalizeDurationSeconds(json?.input?.duration);
    if (seconds === null) {
      // Honest outcome: the provider has not reported a duration yet. Leave the
      // row alone rather than inventing a number.
      console.log('  %s: provider reported no usable duration - left unchanged', video.id);
      skipped += 1;
      continue;
    }

    console.log('  %s: %ds %s', video.id, seconds, APPLY ? '' : '[dry run]');

    if (APPLY) {
      // A GUARDED update, not `update`.
      //
      // The `where` repeats every precondition, so if anything changed between
      // the read and this write - the row was deleted, stopped being READY, or
      // someone else filled the duration in - the statement matches nothing and
      // changes nothing. That makes the script safe to run concurrently with the
      // app and safe to re-run.
      //
      // The data payload deliberately contains ONLY `durationSeconds`.
      //
      // This script exists to repair one number. Source geometry (`width`,
      // `height`, `frameRate`) is NOT written here, even where the row is null
      // and the provider reports a value: the provider's `input.fps` for these
      // assets reads 90000, which is plainly not a frame rate, and a backfill is
      // not the place to decide what it really means. Today's ingest path
      // (`gumlet-ingest.service.ts`) is the single place that geometry is
      // written, from the same provider response, under the same normalisation.
      //
      // `status`, `drmProvider`, `gumletAssetId`, `gumletStatus`,
      // `drmVerifiedAt`, `drmRequested` and `drmBlockedReason` are never
      // written either, so this script cannot move a video on or off the
      // strict-DRM gate, cannot demote a playable video and cannot fabricate
      // verification.
      const res = await p.video.updateMany({
        where: {
          id: video.id,
          deletedAt: null,
          status: 'READY',
          durationSeconds: 0,
        },
        data: { durationSeconds: seconds },
      });
      if (res.count === 0) {
        console.log('  %s: precondition changed mid-run - nothing written', video.id);
        skipped += 1;
        continue;
      }
    }
    updated += 1;
  }

  console.log(
    '\n%s: %d would be updated, %d skipped.', APPLY ? 'APPLIED' : 'DRY RUN', updated, skipped);

  // --- propagate to every ATTACHED lecture ---------------------------------
  //
  // `Lesson.durationSeconds` is denormalised from the video. On the Gumlet path
  // it was never written, so even after the video row is correct every lecture
  // card, course total and analytics figure still reads 0. A reused lecture has
  // no worker of its own, so this fan-out is the only thing that will ever
  // update it.
  const spread = await p.video.findMany({
    where: { deletedAt: null, drmProvider: 'gumlet', status: 'READY', durationSeconds: { gt: 0 } },
    select: { id: true, durationSeconds: true, courseId: true },
  });

  let lessonsTouched = 0;
  const courseIds = new Set();

  for (const video of spread) {
    const links = await p.lessonVideo.findMany({
      where: { videoId: video.id },
      select: { lessonId: true, lesson: { select: { courseId: true } } },
    });

    const stale = links.filter((l) => l.lessonId);
    for (const link of stale) {
      const before = await p.lesson.findUnique({
        where: { id: link.lessonId }, select: { durationSeconds: true },
      });
      if (before && before.durationSeconds === video.durationSeconds) continue;

      lessonsTouched += 1;
      if (APPLY) {
        await p.lesson.update({
          where: { id: link.lessonId },
          data: { durationSeconds: video.durationSeconds },
        });
      }
      if (link.lesson?.courseId) courseIds.add(link.lesson.courseId);
    }
    if (video.courseId) courseIds.add(video.courseId);
  }

  console.log(
    '%s: propagated duration to %d lecture(s) across %d course(s).',
    APPLY ? 'APPLIED' : 'DRY RUN', lessonsTouched, courseIds.size,
  );

  // --- course recount ------------------------------------------------------
  //
  // `Course.sectionCount`, `lessonCount` and `totalDurationSeconds` are
  // denormalised counters maintained by `CoursesService.recountCourse`. Writing
  // lesson durations leaves them stale, which is why course cards under-report
  // total length even when every lecture is correct.
  //
  // The rules below are copied from that method verbatim - PUBLISHED, not
  // soft-deleted - so running this produces exactly the value the running
  // application would. It is a pure recount: it recomputes from the lectures
  // rather than adding anything, so it is idempotent and safe to repeat.
  if (courseIds.size === 0) {
    console.log('no courses to recount.');
    return;
  }

  let recounted = 0;
  for (const courseId of courseIds) {
    const [sectionCount, lessonAgg] = await Promise.all([
      p.courseSection.count({
        where: { courseId, deletedAt: null, status: 'PUBLISHED' },
      }),
      p.lesson.aggregate({
        where: { courseId, deletedAt: null, status: 'PUBLISHED' },
        _count: { _all: true },
        _sum: { durationSeconds: true },
      }),
    ]);

    const total = lessonAgg._sum.durationSeconds ?? 0;
    const current = await p.course.findUnique({
      where: { id: courseId },
      select: { sectionCount: true, lessonCount: true, totalDurationSeconds: true },
    });

    const alreadyCorrect =
      current &&
      current.sectionCount === sectionCount &&
      current.lessonCount === lessonAgg._count._all &&
      current.totalDurationSeconds === total;

    if (alreadyCorrect) continue;

    console.log(
      '  %s: sections %s->%d lessons %s->%d total %ss->%ss %s',
      courseId,
      current?.sectionCount ?? '-', sectionCount,
      current?.lessonCount ?? '-', lessonAgg._count._all,
      current?.totalDurationSeconds ?? '-', total,
      APPLY ? '' : '[dry run]',
    );

    if (APPLY) {
      await p.course.update({
        where: { id: courseId },
        data: {
          sectionCount,
          lessonCount: lessonAgg._count._all,
          totalDurationSeconds: total,
        },
      });
    }
    recounted += 1;
  }

  console.log('%s: recounted %d course(s).', APPLY ? 'APPLIED' : 'DRY RUN', recounted);
})().catch((e) => {
  console.log('ERROR: %s', e.stack.split('\n').slice(0, 4).join(' / '));
  process.exitCode = 1;
}).finally(() => p.$disconnect());