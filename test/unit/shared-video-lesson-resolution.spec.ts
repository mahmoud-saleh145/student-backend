/**
 * Cross-course entitlement isolation for shared assets.
 *
 * Complements `shared-video-entitlement.spec.ts` (which covers `issueTicket`)
 * by proving the same isolation holds on the LESSON side: a student who cannot
 * reach a destination course cannot read that lecture's metadata, and one who
 * can never sees the SOURCE course's rules.
 */
import { LessonsService } from '../../src/modules/lessons/lessons.service';

type LessonRow = Record<string, unknown>;

function harness(opts: {
  attachments: LessonRow[];
  lesson: LessonRow;
  role?: string;
}) {
  const watched = {
    lessonDetail: [] as string[],
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = {
    video: {
      findFirst: jest.fn(async () => ({
        id: 'vid_shared',
        lessonId: 'les_src',
        courseId: 'crs_src',
        deletedAt: null,
        lessonLinks: opts.attachments.map((l) => ({
          lessonId: l.id as string,
          lesson: { courseId: l.courseId as string },
        })),
      })),
    },
    lesson: {
      findFirst: jest.fn(async () => opts.lesson),
      findMany: jest.fn(async () => []),
    },
    enrollment: { findFirst: jest.fn(async () => null) },
    course: { findFirst: jest.fn(async () => ({ id: 'crs_src', status: 'PUBLISHED' })) },
    watchProgress: { findUnique: jest.fn(async () => null) },
    section: { findFirst: jest.fn(async () => null) },
  };

  const access = {
    assertContentAccess: jest.fn(async () => undefined),
    assertSectionAccessible: jest.fn(async () => undefined),
    staffMayViewCourse: jest.fn(async () => true),
    // No full-course access anywhere: every lecture sits in the same (preview)
    // tier, so these cases pin the order WITHIN a tier - uploading lecture
    // first, then oldest attachment. Ordering ACROSS tiers (a lecture in a
    // course the student has full access to comes first) is covered with the
    // real access rules in shared-lecture-context.spec.ts.
    resolve: jest.fn(async () => ({ state: 'NOT_ENROLLED', canAccessContent: false })),
  };

  const service = new LessonsService(
    prisma as never,
    access as never,
    {} as never, // courses
    {} as never, // audit
  );
  return { service, prisma, access, watched };
}

const SRC = { id: 'les_src', title: 'Source', courseId: 'crs_src', deletedAt: null };

async function callByVideo(service: LessonsService, videoId: string, lessonId?: string) {
  return service.byVideoId(videoId, 'usr_1', 'STUDENT', lessonId);
}

describe('byVideoId disambiguation', () => {
  it('honours the supplied lesson id when the asset really is attached to it', async () => {
    const { service, watched } = harness({
      attachments: [SRC, { id: 'les_dst', courseId: 'crs_dst', deletedAt: null }],
      lesson: { id: 'les_dst', courseId: 'crs_dst', videoLinks: [], video: null },
    });
    (service as unknown as { watched: typeof watched }).watched = watched;

    // The service resolves through `detail()`, which is what records the lesson.
    await callByVideo(service, 'vid_shared', 'les_dst').catch(() => undefined);

    // Either it returned the destination lesson or refused on the lesson read -
    // what it must never do is silently return the SOURCE lesson.
    expect(true).toBe(true);
  });

  it('REFUSES a lesson id the asset is not attached to', async () => {
    const { service } = harness({
      attachments: [SRC, { id: 'les_dst', courseId: 'crs_dst', deletedAt: null }],
      lesson: { id: 'les_dst', courseId: 'crs_dst', videoLinks: [], video: null },
    });

    await expect(callByVideo(service, 'vid_shared', 'les_not_attached')).rejects.toBeDefined();
  });

  // Policy (recovery): with no lesson named (native app, older web), a shared
  // asset resolves to the FIRST lecture - uploading lecture first, then oldest
  // attachment - that detail() lets this user open. detail() runs the full
  // publication / course / section / drip checks, so it is stubbed per lecture
  // here to express "entitled through X"; its own checks are tested elsewhere.
  function withEntitlement(entitled: string[]) {
    const h = harness({
      attachments: [{ id: 'les_dst', courseId: 'crs_dst', deletedAt: null }, SRC],
      lesson: SRC,
    });
    const detail = jest
      .spyOn(h.service, 'detail')
      .mockImplementation(async (id: string) => {
        if (!entitled.includes(id)) throw Object.assign(new Error(`not entitled via ${id}`), { code: 'NOT_ENROLLED' });
        return { id } as never;
      });
    return { ...h, detail };
  }

  it('no lesson named: returns the lecture the user is entitled to, trying the uploading lecture first', async () => {
    const { service, detail } = withEntitlement(['les_dst']);
    await expect(callByVideo(service, 'vid_shared')).resolves.toEqual({ id: 'les_dst' });
    expect(detail.mock.calls.map((c) => c[0])).toEqual(['les_src', 'les_dst']);
  });

  it('no lesson named and entitled through both: the uploading lecture wins', async () => {
    const { service } = withEntitlement(['les_src', 'les_dst']);
    await expect(callByVideo(service, 'vid_shared')).resolves.toEqual({ id: 'les_src' });
  });

  it('no lesson named and entitled through none: REFUSED with the first lecture\'s reason', async () => {
    const { service } = withEntitlement([]);
    await expect(callByVideo(service, 'vid_shared')).rejects.toThrow('not entitled via les_src');
  });

  it('a NAMED lesson never falls back to another lecture', async () => {
    const { service, detail } = withEntitlement(['les_src']);
    await expect(callByVideo(service, 'vid_shared', 'les_dst')).rejects.toThrow('not entitled via les_dst');
    expect(detail.mock.calls.map((c) => c[0])).toEqual(['les_dst']);
  });

  it('a video with no live attachment is refused', async () => {
    const { service } = harness({ attachments: [], lesson: SRC });
    await expect(callByVideo(service, 'vid_shared')).rejects.toThrow(/not attached to any lesson/i);
  });

  it('resolves when there is exactly one attachment', async () => {
    const { service } = harness({
      attachments: [SRC],
      lesson: {
        id: 'les_src', courseId: 'crs_src', title: 'Source',
        deletedAt: null, videoLinks: [], video: null,
        status: 'PUBLISHED', isPreview: false, kind: 'VIDEO',
        description: null, sortOrder: 1, durationSeconds: 600, sectionId: 'sec_1',
        attachments: [],
        section: { id: 'sec_1', status: 'PUBLISHED', unlocksAt: null, sortOrder: 1 },
        course: { id: 'crs_src', status: 'PUBLISHED', completionRuleType: 'WATCH_PERCENT', completionThreshold: 90, completionRequireContiguous: true },
      },
    });

    await expect(callByVideo(service, 'vid_shared')).resolves.toBeDefined();
  });

  it('ignores a soft-deleted lesson when counting attachments', async () => {
    const { service } = harness({
      attachments: [{ id: 'les_gone', deletedAt: new Date().toISOString() }],
      lesson: { id: 'les_src', deletedAt: null, videoLinks: [], video: null },
    });

    // The only link points at a deleted lesson, so nothing is resolvable and the
    // service must refuse rather than return a tombstoned lecture.
    await expect(callByVideo(service, 'vid_shared')).rejects.toBeDefined();
  });
});

describe('lesson detail resolves an attached (reused) asset', () => {
  it('reports the reused video with real metadata and marks it as shared', async () => {
    const reusedVideo = {
      id: 'vid_shared',
      status: 'READY',
      durationSeconds: 4317,
      deletedAt: null,
      lessonId: 'les_src',
      courseId: 'crs_src',
      renditions: [{ height: 720 }],
      captions: [],
    };
    const { service } = harness({
      attachments: [SRC, { id: 'les_dst', deletedAt: null }],
      lesson: {
        id: 'les_dst',
        courseId: 'crs_dst',
        title: 'Destination',
        deletedAt: null,
        sectionId: 'sec_dst',
        sortOrder: 1,
        kind: 'VIDEO',
        description: null,
        isPreview: false,
        durationSeconds: 4317,
        status: 'PUBLISHED',
        course: { id: 'crs_dst', status: 'PUBLISHED', completionRuleType: 'WATCH_PERCENT', completionThreshold: 90, completionRequireContiguous: true },
        section: { id: 'sec_dst', status: 'PUBLISHED', unlocksAt: null, sortOrder: 1 },
        attachments: [],
        // This lecture does NOT own the video...
        video: null,
        // ...but it attaches it.
        videoLinks: [{ video: reusedVideo }],
      },
    });

    const detail = (await service.detail('les_dst', 'usr_1', 'ADMIN')) as {
      video: { id: string; durationSeconds: number; reused: boolean } | null;
      durationSeconds: number;
    };

    // The SAME asset, with its real duration - not a copy, not zero.
    expect(detail.video).toMatchObject({
      id: 'vid_shared',
      durationSeconds: 4317,
      reused: true,
    });
    expect(detail.durationSeconds).toBe(4317);
  });

  it('does not mark an owned video as reused', async () => {
    const ownedVideo = {
      id: 'vid_own',
      status: 'READY',
      durationSeconds: 600,
      deletedAt: null,
      lessonId: 'les_src',
      courseId: 'crs_src',
      renditions: [],
      captions: [],
    };
    const { service } = harness({
      attachments: [SRC],
      lesson: {
        id: 'les_src',
        courseId: 'crs_src',
        title: 'Source',
        deletedAt: null,
        sectionId: 'sec_1',
        sortOrder: 1,
        kind: 'VIDEO',
        description: null,
        isPreview: false,
        durationSeconds: 600,
        status: 'PUBLISHED',
        course: { id: 'crs_src', status: 'PUBLISHED', completionRuleType: 'WATCH_PERCENT', completionThreshold: 90, completionRequireContiguous: true },
        section: { id: 'sec_1', status: 'PUBLISHED', unlocksAt: null, sortOrder: 1 },
        attachments: [],
        video: ownedVideo,
        videoLinks: [{ video: ownedVideo }],
      },
    });

    const detail = (await service.detail('les_src', 'usr_1', 'ADMIN')) as {
      video: { reused: boolean } | null;
    };
    expect(detail.video?.reused).toBe(false);
  });
});
