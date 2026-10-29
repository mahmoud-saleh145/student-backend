/**
 * Attachment integrity for the upload, detach and delete paths.
 *
 * The invariant these all protect: the `lesson_videos` table is what
 * `PlaybackService.issueTicket` resolves the authorised lecture from, and one
 * asset can be referenced by several lectures. So:
 *
 *   * every uploaded video must be attached, or the lecture is unplayable;
 *   * removing one lesson's link must never destroy an asset another lesson uses;
 *   * and the existing single-course behaviour must be completely unchanged.
 */
import { VideosService } from '../../src/modules/videos/videos.service';

type Row = Record<string, unknown>;

const ACTOR = { id: 'stf_1', role: 'TEACHER' } as never;

function harness(opts: { liveAttachments?: number; links?: Row[] } = {}) {
  const videoCreates: Row[] = [];
  const videoUpdates: Row[] = [];
  const linkUpserts: Row[] = [];
  const videoUpdateMany: Row[] = [];
  const ticketUpdateMany: Row[] = [];
  const lessonUpdateMany: Row[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = {
    lesson: {
      findFirst: jest.fn(async () => ({
        id: 'l1',
        courseId: 'c1',
        title: 'Lecture 1',
        video: null,
        videoLinks: [],
      })),
      findMany: jest.fn(async () => [{ id: 'l1' }]),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async (args: Row) => {
        lessonUpdateMany.push(args);
        return { count: 1 };
      }),
    },
    video: {
      findFirst: jest.fn(async () => ({
        id: 'vid_1',
        courseId: 'c1',
        lessonId: 'l1',
        hlsPrefix: 'hls/vid_1/',
        sourceKey: 'uploads/vid_1.mp4',
        processingJobId: null,
      })),
      findMany: jest.fn(async () => []),
      create: jest.fn(async (args: Row) => {
        videoCreates.push(args);
        return { id: 'vid_new' };
      }),
      update: jest.fn(async (args: Row) => {
        videoUpdates.push(args);
        return {};
      }),
      updateMany: jest.fn(async (args: Row) => {
        videoUpdateMany.push(args);
        return { count: 1 };
      }),
    },
    lessonVideo: {
      // Answers by query shape: the attachment lookup is by videoId; the
      // "does this lecture still have another video" check is lessonId IN [...].
      findMany: jest.fn(async (args: { where?: { videoId?: unknown } } = {}) =>
        typeof args.where?.videoId === 'string'
          ? (opts.links ?? [{ lessonId: 'l1' }]).map((l) => ({
              lessonId: l.lessonId,
              lesson: { courseId: (l.courseId as string) ?? 'c1', deletedAt: null },
            }))
          : [],
      ),
      findUnique: jest.fn(async () => null),
      count: jest.fn(async () => opts.liveAttachments ?? 1),
      findFirst: jest.fn(async () => ({ lessonId: 'l1' })),
      upsert: jest.fn(async (args: Row) => {
        linkUpserts.push(args);
        return {};
      }),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    },
    playbackTicket: {
      updateMany: jest.fn(async (args: Row) => {
        ticketUpdateMany.push(args);
        return { count: 1 };
      }),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };

  const storage = {
    objectSize: jest.fn(async () => 1234),
    deletePrefix: jest.fn(async () => undefined),
    deleteObject: jest.fn(async () => undefined),
    presignUpload: jest.fn(async () => ({ url: 'https://put.example', key: 'uploads/vid_new.mp4' })),
    exists: jest.fn(async () => true),
  };

  const access = {
    assertCanManageCourse: jest.fn(async () => undefined),
    assertTeacherCapability: jest.fn(async () => undefined),
    staffMayViewCourse: jest.fn(async () => true),
  };

  const lessonVideos = {
    countLiveAttachments: jest.fn(async () => opts.liveAttachments ?? 1),
    propagateDurationToAttachedLessons: jest.fn(async () => 0),
  };

  const service = new VideosService(
    prisma as never,
    storage as never,
    access as never,
    { recountCourse: jest.fn(async () => undefined) } as never,
    {} as never,
    { record: jest.fn() } as never,
    { getJson: jest.fn(async () => null) } as never,
    { add: jest.fn(async () => ({ id: 'job-1' })), getJob: jest.fn(async () => null) } as never,
    { getOrThrow: () => ({ drm: { enabled: true, provider: 'gumlet', gumlet: { apiKey: 'k', workspaceId: 'w', orgId: 'o', signSecret: 's' } }, ladder: [720] }) } as never,
    lessonVideos as never,
    {} as never, // gumletIngest - only the recovery sweep touches it
  );

  return {
    service, prisma, storage, access, lessonVideos,
    videoCreates, videoUpdates, linkUpserts, videoUpdateMany, ticketUpdateMany, lessonUpdateMany,
  };
}

describe('a new upload is attached to its lecture', () => {
  it('creates the lesson_videos row, so the lecture is actually playable', async () => {
    const { service, linkUpserts } = harness();

    await service.initUpload(
      { lessonId: 'l1', filename: 'lecture.mp4', contentType: 'video/mp4', sizeBytes: 1234 },
      ACTOR,
    );

    expect(linkUpserts).toHaveLength(1);
    expect(linkUpserts[0]).toMatchObject({
      where: { lessonId_videoId: { lessonId: 'l1', videoId: 'vid_new' } },
      create: { lessonId: 'l1', videoId: 'vid_new' },
    });
  });

  it('is idempotent - re-initialising an upload does not duplicate the attachment', async () => {
    const { service, linkUpserts } = harness();
    // The upsert form is what guarantees this: no insert when the row exists.
    const args = {
      lessonId: 'l1', filename: 'lecture.mp4', contentType: 'video/mp4', sizeBytes: 1234,
    };
    await service.initUpload(args, ACTOR);
    await service.initUpload(args, ACTOR);
    expect(linkUpserts).toHaveLength(2);
    expect(linkUpserts[0]).toMatchObject({ update: {} });
  });

  it('does not touch any other video rows', async () => {
    const { service, prisma } = harness();
    await service.initUpload(
      { lessonId: 'l1', filename: 'lecture.mp4', contentType: 'video/mp4', sizeBytes: 1234 },
      ACTOR,
    );
    // A fresh upload creates exactly one video and changes no existing one.
    expect(prisma.video.create).toHaveBeenCalledTimes(1);
    expect(prisma.video.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sourceKey: expect.any(String) }),
      }),
    );
  });
});

describe('deleting a video', () => {
  it('behaves EXACTLY as before for an unshared asset', async () => {
    // One attachment: the owning lecture. This is the historical path and must
    // be byte-for-byte unchanged in effect.
    const { service, prisma, storage } = harness({ liveAttachments: 1 });

    const result = await service.remove('vid_1', ACTOR);

    expect(result).toMatchObject({ ok: true, detached: false });
    expect(prisma.video.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deletedAt: expect.any(Date) }) }),
    );
    expect(prisma.playbackTicket.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { videoId: 'vid_1', status: 'ACTIVE' } }),
    );
    expect(storage.deletePrefix).toHaveBeenCalled();
    expect(storage.deleteObject).toHaveBeenCalled();
  });

  it('DETACHES the named lecture instead of destroying when another lesson still uses the asset', async () => {
    const { service, prisma, storage } = harness({
      links: [{ lessonId: 'l1' }, { lessonId: 'l2', courseId: 'c2' }, { lessonId: 'l3', courseId: 'c3' }],
    });

    const result = await service.remove('vid_1', ACTOR, true, 'l2');

    expect(result).toMatchObject({ ok: true, detached: true, remainingAttachments: 2 });
    // The asset row survives (l2 is not the origin, so its pointer is untouched).
    expect(prisma.video.update).not.toHaveBeenCalled();
    // The bytes survive.
    expect(storage.deletePrefix).not.toHaveBeenCalled();
    expect(storage.deleteObject).not.toHaveBeenCalled();
    // Only the detached lecture's live streams are revoked.
    expect(prisma.playbackTicket.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.playbackTicket.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { videoId: 'vid_1', lessonId: 'l2', status: 'ACTIVE' } }),
    );
    // Only that lesson's link is removed.
    expect(prisma.lessonVideo.deleteMany).toHaveBeenCalledWith({
      where: { lessonId: 'l2', videoId: 'vid_1' },
    });
  });

  it('never clears the lesson duration of a lecture that keeps its video', async () => {
    // The asset stays live, so a duration reset here would blank a lecture that
    // still plays perfectly.
    const { service, prisma } = harness({
      links: [{ lessonId: 'l1' }, { lessonId: 'l2', courseId: 'c2' }],
    });
    await service.remove('vid_1', ACTOR, true, 'l1');
    expect(prisma.lesson.updateMany.mock.calls).toEqual([
      [{ where: { id: { in: ['l1'] } }, data: { durationSeconds: 0 } }],
    ]);
  });
});