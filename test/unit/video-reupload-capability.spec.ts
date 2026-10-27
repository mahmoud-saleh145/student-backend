import { VideoStatus } from '@prisma/client';

import { VideosService } from '../../src/modules/videos/videos.service';

/**
 * Which uploads need the "edit video URLs" teacher switch.
 *
 * The switch governs REPLACING what students stream. A lecture whose first
 * upload failed (row left at UPLOADING/FAILED) has never been streamed, so a
 * retry is still a first upload. Gating it meant a teacher could never retry.
 */
const STOP = new Error('reached provider resolution (past the capability gate)');

function service(videoStatus: VideoStatus | null) {
  const svc = Object.create(VideosService.prototype) as VideosService;
  const assertTeacherCapability = jest.fn(async () => {
    throw Object.assign(new Error('TEACHER_CAPABILITY_DISABLED'), { code: 'FORBIDDEN' });
  });
  Object.assign(svc, {
    prisma: {
      lesson: {
        findFirst: jest.fn(async () => ({
          id: 'les_1',
          courseId: 'crs_1',
          video: videoStatus
            ? { id: 'vid_1', status: videoStatus, deletedAt: null, hlsPrefix: null, drmProvider: 'gumlet', gumletAssetId: null }
            : null,
          videoLinks: videoStatus ? [{ videoId: 'vid_1', video: { deletedAt: null } }] : [],
        })),
      },
      lessonVideo: { count: jest.fn(async () => 0) },
    },
    access: { assertCanManageCourse: jest.fn(async () => undefined), assertTeacherCapability },
    resolveNewVideoProvider: () => {
      throw STOP;
    },
  });
  const init = () =>
    svc.initUpload(
      { lessonId: 'les_1', filename: 'lecture.mp4', contentType: 'video/mp4', sizeBytes: 1024 },
      { id: 'usr_t', role: 'TEACHER' } as never,
    );
  return { init, assertTeacherCapability };
}

describe('initUpload: the "edit video URLs" gate', () => {
  it.each([VideoStatus.UPLOADING, VideoStatus.FAILED, VideoStatus.QUEUED, VideoStatus.PROCESSING])(
    'does not gate a retry over a never-streamed %s video',
    async (status) => {
      const { init, assertTeacherCapability } = service(status);
      await expect(init()).rejects.toBe(STOP);
      expect(assertTeacherCapability).not.toHaveBeenCalled();
    },
  );

  it('does not gate a first upload onto an empty lecture', async () => {
    const { init, assertTeacherCapability } = service(null);
    await expect(init()).rejects.toBe(STOP);
    expect(assertTeacherCapability).not.toHaveBeenCalled();
  });

  it('still gates replacing a READY video that students stream', async () => {
    const { init, assertTeacherCapability } = service(VideoStatus.READY);
    await expect(init()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(assertTeacherCapability).toHaveBeenCalledWith('TEACHER', 'editVideoUrls');
  });
});
