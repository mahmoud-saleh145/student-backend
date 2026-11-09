import { AppException } from '../../src/common/errors/app.exception';
import { ErrorCode } from '../../src/common/errors/error-codes';
import { CourseAccessService } from '../../src/modules/courses/course-access.service';
import { PlaybackService } from '../../src/modules/playback/playback.service';

/**
 * The "video stops after about thirty seconds" defect.
 *
 * Issuance authorises a FREE PREVIEW lesson for a student with no enrolment
 * (`assertContentAccess` with `allowPreview`). The heartbeat, which runs every
 * 30 seconds, used to re-check with the bare course decision instead - one
 * rule short of issuance - so the same student was revoked with NOT_ENROLLED
 * on the first beat, and the app told them to join a course they were allowed
 * to watch. Production showed exactly this: Android tickets revoked with
 * "Access lost mid-playback: NOT_ENROLLED" and zero seconds watched.
 *
 * The fix routes the heartbeat through the same function issuance uses. These
 * tests drive that function for real (only `resolve` is stubbed), so the
 * preview exception is exercised, not mocked.
 */

type Decision = {
  state: string;
  canAccessContent: boolean;
  denialCode?: ErrorCode;
};

const NOT_ENROLLED: Decision = {
  state: 'NOT_ENROLLED',
  canAccessContent: false,
  denialCode: ErrorCode.NOT_ENROLLED,
};
const ACTIVE: Decision = { state: 'ACTIVE', canAccessContent: true };

function harness(opts: { decision: Decision | Error; isPreview: boolean; role?: string }) {
  // The real access service with only its data source stubbed, so the
  // preview rule that issuance relies on is the one the heartbeat gets.
  const access = Object.create(CourseAccessService.prototype) as CourseAccessService;
  const mocks = access as unknown as { resolve: jest.Mock; assertSectionAccessible: jest.Mock };
  mocks.resolve = jest.fn(async () => {
    if (opts.decision instanceof Error) throw opts.decision;
    return opts.decision;
  });
  mocks.assertSectionAccessible = jest.fn(async () => undefined);

  const ticket = {
    id: 't_1',
    userId: 'u_1',
    status: 'ACTIVE',
    expiresAt: new Date(Date.now() + 290_000), // far from rotation
    courseId: 'c_1',
    lessonId: 'l_1',
    videoId: 'v_1',
    playId: null,
    deviceId: 'd_1',
    delivery: 'hls',
    revokedReason: null,
    lesson: { sectionId: 's_1', isPreview: opts.isPreview },
    video: { id: 'v_1', renditions: [], captions: [], lesson: null },
  };

  const prisma = {
    playbackTicket: {
      findFirst: jest.fn(async () => ticket),
      update: jest.fn(async () => ticket),
    },
    watchEvent: { create: jest.fn(async () => ({})) },
    videoPlay: { update: jest.fn(async () => ({})) },
  };
  const security = { record: jest.fn(async () => undefined) };
  const config = {
    getOrThrow: (key: string) =>
      key === 'playback'
        ? { heartbeatInterval: 30, heartbeatGrace: 90, ticketTtl: 300, playResumeWindow: 2700 }
        : { drm: { enabled: false }, mobile: { delivery: 'hls', gumletFallback: true } },
    get: () => undefined,
  };

  const service = new PlaybackService(
    prisma as never,
    {} as never,
    access as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    security as never,
    {} as never,
    {} as never,
    config as never,
  );
  const revokeTicket = jest.spyOn(service, 'revokeTicket').mockResolvedValue(undefined);
  const privateApi = service as unknown as {
    releaseStreamSlot: () => Promise<void>;
    touchStreamSlot: () => Promise<void>;
  };
  jest.spyOn(privateApi, 'releaseStreamSlot').mockResolvedValue(undefined);
  jest.spyOn(privateApi, 'touchStreamSlot').mockResolvedValue(undefined);

  const beat = () =>
    service.heartbeat({
      user: {
        id: 'u_1',
        role: (opts.role ?? 'STUDENT') as never,
        phone: '',
        fullName: '',
        sessionId: 's_1',
        deviceId: 'd_1',
        deviceKey: 'k',
        status: 'ACTIVE',
      },
      ticketId: 't_1',
      positionSeconds: 31,
      watchedDeltaSeconds: 30,
    });

  return { beat, access: mocks, prisma, revokeTicket };
}

describe('heartbeat on a free preview lesson', () => {
  it('keeps playing for a student with no enrolment - the regression', async () => {
    const t = harness({ decision: NOT_ENROLLED, isPreview: true });

    await expect(t.beat()).resolves.toEqual({ ok: true, terminate: null });

    expect(t.revokeTicket).not.toHaveBeenCalled();
    expect(t.prisma.playbackTicket.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ watchedSeconds: { increment: 30 } }) }),
    );
    // A preview is never section-scoped, exactly as at issuance.
    expect(t.access.assertSectionAccessible).not.toHaveBeenCalled();
  });

  it('still ends when the course itself is archived (the one preview exception issuance makes too)', async () => {
    const t = harness({
      decision: { state: 'ARCHIVED', canAccessContent: false, denialCode: ErrorCode.COURSE_ARCHIVED },
      isPreview: true,
    });

    await expect(t.beat()).resolves.toEqual({
      ok: false,
      terminate: { reason: ErrorCode.COURSE_ARCHIVED },
    });
    expect(t.revokeTicket).toHaveBeenCalledWith('t_1', 'Access lost mid-playback: ARCHIVED');
  });
});

describe('heartbeat on a protected lesson', () => {
  it('revokes a student who lost their enrolment, with the real reason', async () => {
    const t = harness({ decision: NOT_ENROLLED, isPreview: false });

    await expect(t.beat()).resolves.toEqual({
      ok: false,
      terminate: { reason: ErrorCode.NOT_ENROLLED },
    });
    expect(t.revokeTicket).toHaveBeenCalledWith('t_1', 'Access lost mid-playback: NOT_ENROLLED');
    expect(t.prisma.playbackTicket.update).not.toHaveBeenCalled();
  });

  it('keeps an enrolled student playing and re-checks their section', async () => {
    const t = harness({ decision: ACTIVE, isPreview: false });

    await expect(t.beat()).resolves.toEqual({ ok: true, terminate: null });
    expect(t.access.assertSectionAccessible).toHaveBeenCalledWith({
      userId: 'u_1',
      courseId: 'c_1',
      sectionId: 's_1',
    });
    expect(t.revokeTicket).not.toHaveBeenCalled();
  });

  it('does NOT revoke on a database outage - the beat fails and the ticket survives', async () => {
    const outage = Object.assign(new Error("Can't reach database server"), { code: 'P1001' });
    const t = harness({ decision: outage, isPreview: false });

    await expect(t.beat()).rejects.toThrow(/reach database/);
    expect(t.revokeTicket).not.toHaveBeenCalled();
  });

  it('turns an access refusal into a terminate, never a thrown 4xx', async () => {
    const t = harness({
      decision: { state: 'EXPIRED', canAccessContent: false, denialCode: ErrorCode.ACCESS_EXPIRED },
      isPreview: false,
    });

    const result = await t.beat();
    expect(result.ok).toBe(false);
    expect(result.terminate?.reason).toBe(ErrorCode.ACCESS_EXPIRED);
  });
});

describe('the preview exception is the same one issuance uses', () => {
  it('assertContentAccess grants a preview to a non-enrolled student and refuses the same student elsewhere', async () => {
    const access = Object.create(CourseAccessService.prototype) as CourseAccessService;
    (access as unknown as { resolve: jest.Mock }).resolve = jest.fn(async () => NOT_ENROLLED);

    await expect(
      access.assertContentAccess({
        userId: 'u', role: 'STUDENT' as never, courseId: 'c', allowPreview: true, isPreviewContent: true,
      }),
    ).resolves.toMatchObject({ canAccessContent: true });

    await expect(
      access.assertContentAccess({
        userId: 'u', role: 'STUDENT' as never, courseId: 'c', allowPreview: true, isPreviewContent: false,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_ENROLLED } satisfies Partial<AppException>);
  });
});
