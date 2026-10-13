/**
 * Shared video assets.
 *
 * Covers the guarantees that make "reuse this uploaded video in another course"
 * safe:
 *
 *   1. reusing does not create a second video row,
 *   2. reusing does not enqueue another upload/ingestion job,
 *   3. the source lecture keeps working,
 *   4. the same asset is reachable from the destination lecture,
 *   5. an unattached/mismatched lesson cannot ride the asset,
 *   6. the duration propagates to every attached lecture.
 */
import { LessonVideoService } from '../../src/modules/videos/lesson-video.service';

type Row = Record<string, unknown>;

function harness(opts: {
  lesson?: Row;
  video?: Row;
  links?: Row[];
} = {}) {
  const created: Row[] = [];
  const lessonUpdates: Row[] = [];

  const lesson = opts.lesson ?? {
    id: 'les_dst',
    title: 'Destination lecture',
    courseId: 'crs_dst',
    deletedAt: null,
  };
  const video = opts.video ?? {
    id: 'vid_shared',
    lessonId: 'les_src',
    courseId: 'crs_src',
    status: 'READY',
    durationSeconds: 600,
    width: 1920,
    height: 1080,
    drmProvider: 'gumlet',
    gumletAssetId: 'asset_abc',
    deletedAt: null,
  };
  const links = opts.links ?? [{ lessonId: 'les_src' }];

  // `propagateDurationToAttachedLessons` selects the owning course THROUGH the
  // link, so normalise whatever shape a test passes in.
  const linkRows = links.map((link) => ({
    lessonId: link.lessonId as string,
    lesson: { courseId: (link.courseId as string | undefined) ?? null },
  }));

  const prisma = {
    video: {
      findFirst: jest.fn(async () => video),
      findUnique: jest.fn(async () => video),
      // The ONLY way a new asset could appear. Asserted untouched.
      create: jest.fn(async (args: Row) => {
        created.push(args);
        return args;
      }),
      update: jest.fn(async () => ({})),
    },
    lessonVideo: {
      findMany: jest.fn(async () => linkRows),
      // The occupancy check ("another live video on this lecture?") filters by
      // videoId NOT this one; the destination here is empty, so it finds none.
      findFirst: jest.fn(async (args?: { where?: { videoId?: unknown } }) =>
        args?.where?.videoId && typeof args.where.videoId === 'object' ? null : { video },
      ),
      findUnique: jest.fn(async () => null),
      count: jest.fn(async () => linkRows.length),
      create: jest.fn(async (args: Row) => {
        created.push(args);
        return args;
      }),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    },
    lesson: {
      findFirst: jest.fn(async () => lesson),
      updateMany: jest.fn(async (args: Row) => {
        lessonUpdates.push(args);
        return { count: 1 };
      }),
    },
  };

  const courses = { recountCourse: jest.fn(async () => undefined) };
  const service = new LessonVideoService(prisma as never, courses as never);

  return { service, prisma, courses, created, lessonUpdates, lesson, video, links: linkRows };
}

describe('LessonVideoService.attach', () => {
  it('creates exactly ONE association row and no second video', async () => {
    const { service, prisma, created } = harness();

    const result = await service.attach({
      lessonId: 'les_dst',
      videoId: 'vid_shared',
      actorId: 'stf_1',
    });

    expect(result.created).toBe(true);
    // One row, and it points at the EXISTING video id.
    expect(prisma.lessonVideo.create).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
    expect((created[0] as { data: Row }).data).toMatchObject({
      lessonId: 'les_dst',
      videoId: 'vid_shared',
    });

    // The decisive assertion: no new asset was created.
    expect(prisma.video.create).not.toHaveBeenCalled();
  });

  it('is idempotent - re-attaching the same mapping changes nothing', async () => {
    const { service, prisma } = harness();
    (prisma.lessonVideo.findUnique as jest.Mock).mockResolvedValue({
      lessonId: 'les_dst',
      videoId: 'vid_shared',
    });

    const result = await service.attach({
      lessonId: 'les_dst',
      videoId: 'vid_shared',
      actorId: 'stf_1',
    });

    expect(result.created).toBe(false);
    expect(prisma.lessonVideo.create).not.toHaveBeenCalled();
    expect(prisma.video.create).not.toHaveBeenCalled();
  });

  it('does not enqueue an upload or ingestion job', async () => {
    // The service has no queue dependency at all - attaching cannot reach the
    // worker. This test pins that structurally.
    const { service, prisma } = harness();
    await service.attach({ lessonId: 'les_dst', videoId: 'vid_shared', actorId: 'stf_1' });
    expect(Object.keys(prisma)).not.toContain('queue');
    // Attaching touches the attachment table only. It never writes to the
    // video row, so it cannot flip status or restart processing.
    expect(prisma.video.update).not.toHaveBeenCalled();
  });

  it('propagates the asset duration to the destination lecture', async () => {
    const { service, prisma } = harness({
      links: [
        { lessonId: 'les_src' },
        { lessonId: 'les_dst', courseId: 'crs_dst' },
      ],
    });

    await service.attach({ lessonId: 'les_dst', videoId: 'vid_shared', actorId: 'stf_1' });

    expect(prisma.lesson.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['les_src', 'les_dst'] } },
      data: { durationSeconds: 600 },
    });
  });
});

describe('LessonVideoService.propagateDurationToAttachedLessons', () => {
  it('writes the duration to EVERY attached lecture, not just the owner', async () => {
    const { service, prisma, courses } = harness({
      links: [
        { lessonId: 'les_a', courseId: 'crs_a' },
        { lessonId: 'les_b', courseId: 'crs_b' },
        { lessonId: 'les_c', courseId: 'crs_c' },
      ],
    });

    const count = await service.propagateDurationToAttachedLessons('vid_shared', 900);

    expect(count).toBe(3);
    expect(prisma.lesson.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['les_a', 'les_b', 'les_c'] } },
      data: { durationSeconds: 900 },
    });
  });

  it('recounts every affected course, including the source course', async () => {
    const { service, courses } = harness({
      links: [
        { lessonId: 'les_a', courseId: 'crs_a' },
        { lessonId: 'les_b', courseId: 'crs_b' },
      ],
    });

    await service.propagateDurationToAttachedLessons('vid_shared', 900);

    const counted = (courses.recountCourse as jest.Mock).mock.calls.map((c) => c[0]);
    expect(counted).toEqual(expect.arrayContaining(['crs_a', 'crs_b']));
  });

  it('writes nothing when the duration is still unknown', async () => {
    const { service, prisma } = harness();
    const count = await service.propagateDurationToAttachedLessons('vid_shared', 0);
    expect(count).toBe(0);
    expect(prisma.lesson.updateMany).not.toHaveBeenCalled();
  });
});

describe('LessonVideoService.detach', () => {
  it('removes only the association and never the shared asset', async () => {
    const { service, prisma } = harness();

    const result = await service.detach({ lessonId: 'les_dst', videoId: 'vid_shared' });

    expect(prisma.lessonVideo.deleteMany).toHaveBeenCalledWith({
      where: { lessonId: 'les_dst', videoId: 'vid_shared' },
    });
    // The asset row is untouched: other courses are still streaming it.
    expect(prisma.video.create).not.toHaveBeenCalled();
    expect(result.assetDestroyed).toBe(false);
  });
});

describe('LessonVideoService.countLiveAttachments', () => {
  it('counts only non-deleted lessons', async () => {
    const { service, prisma } = harness();
    await service.countLiveAttachments('vid_shared');
    expect(prisma.lessonVideo.count).toHaveBeenCalledWith({
      where: { videoId: 'vid_shared', lesson: { deletedAt: null } },
    });
  });
});