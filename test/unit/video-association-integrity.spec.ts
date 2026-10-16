/**
 * Fix 3 - every video row must carry its lesson_videos attachment.
 *
 * Root cause: the live API predates `lesson_videos`, so videos it uploaded
 * after the shared-video migration have no attachment (production: one READY
 * video). The new ticket resolver fails closed on an empty attachment set, so
 * such a lecture is unplayable on the new backend until it is repaired.
 *
 * What the recovery code guarantees, tested here against an in-memory Prisma:
 *   * a new upload writes the video row and its owner attachment in ONE
 *     transaction;
 *   * re-uploading onto a lecture whose video lacks the row HEALS it;
 *   * uploading cannot create a second video on a lecture that plays a
 *     reused asset, and cannot replace a shared asset under other lectures.
 * The ticket-side behaviour for an unattached video is in
 * drm-verify-then-play.spec.ts.
 */
import { VideosService } from '../../src/modules/videos/videos.service';
import { createInMemoryPrisma, type Seed } from './helpers/in-memory-prisma';

type Row = Record<string, unknown>;

const ADMIN = { id: 'adm_1', role: 'ADMIN' } as never;
const UPLOAD = { filename: 'lecture.mp4', contentType: 'video/mp4', sizeBytes: 1234 };

function harness(s: Seed) {
  const db = createInMemoryPrisma(s);
  const txWrites: string[] = [];
  let inTx = false;
  const realTx = db.prisma.$transaction;
  db.prisma.$transaction = async (fn: (tx: unknown) => unknown) => {
    inTx = true;
    try {
      return await realTx(fn);
    } finally {
      inTx = false;
    }
  };
  for (const [model, op] of [
    ['video', 'create'],
    ['video', 'update'],
    ['lessonVideo', 'upsert'],
  ] as const) {
    const target = db.prisma[model] as unknown as Record<string, (a: Row) => Promise<unknown>>;
    const original = target[op];
    target[op] = async (a: Row) => {
      txWrites.push(`${model}.${op}:${inTx ? 'tx' : 'NO-TX'}`);
      return original(a);
    };
  }

  const service = new VideosService(
    db.prisma as never,
    {
      presignUpload: jest.fn(async () => ({ url: 'https://put.example', key: 'k' })),
    } as never,
    { assertCanManageCourse: jest.fn(async () => undefined), assertTeacherCapability: jest.fn(async () => undefined) } as never,
    { recountCourse: jest.fn(async () => undefined) } as never,
    {} as never,
    { record: jest.fn(async () => undefined) } as never,
    { getJson: jest.fn(async () => null) } as never,
    { add: jest.fn(async () => ({ id: 'job' })), getJob: jest.fn(async () => null) } as never,
    {
      getOrThrow: () => ({
        drm: { enabled: true, provider: 'gumlet', gumlet: { apiKey: 'k', workspaceId: 'w', orgId: 'o', signSecret: 's' } },
        ladder: [720],
      }),
    } as never,
    {} as never,
    {} as never, // gumletIngest - only the recovery sweep reads it
  );
  const links = () => db.tables.lessonVideo.map((l) => `${l.lessonId}:${l.videoId}`).sort();
  return { service, db, txWrites, links };
}

const lesson = (id: string, courseId: string): Row => ({ id, courseId, deletedAt: null, durationSeconds: 0 });

describe('a new upload', () => {
  it('creates the video and its owner attachment inside one transaction', async () => {
    const h = harness({ lesson: [lesson('l1', 'c1')] });

    await h.service.initUpload({ lessonId: 'l1', ...UPLOAD }, ADMIN);

    const created = h.db.tables.video[0];
    expect(created).toMatchObject({ lessonId: 'l1', courseId: 'c1', drmProvider: 'gumlet' });
    expect(h.links()).toEqual([`l1:${created.id}`]);
    expect(h.txWrites.slice(0, 2)).toEqual(['video.create:tx', 'lessonVideo.upsert:tx']);
  });
});

describe('a video row an older build created without its attachment', () => {
  it('is healed when that lecture\'s video is replaced', async () => {
    const h = harness({
      lesson: [lesson('l1', 'c1')],
      video: [{ id: 'v_orphan', lessonId: 'l1', courseId: 'c1', status: 'READY', deletedAt: null, drmProvider: 'gumlet' }],
      lessonVideo: [],
    });

    await h.service.initUpload({ lessonId: 'l1', ...UPLOAD }, ADMIN);

    expect(h.db.tables.video).toHaveLength(1);
    expect(h.links()).toEqual(['l1:v_orphan']);
    expect(h.txWrites.slice(0, 2)).toEqual(['video.update:tx', 'lessonVideo.upsert:tx']);
  });
});

describe('uploads never corrupt shared assets', () => {
  const shared: Seed = {
    lesson: [lesson('lS', 'cS'), lesson('lD', 'cD')],
    video: [{ id: 'vS', lessonId: 'lS', courseId: 'cS', status: 'READY', deletedAt: null, drmProvider: 'gumlet', gumletAssetId: 'a1' }],
    lessonVideo: [
      { lessonId: 'lS', videoId: 'vS' },
      { lessonId: 'lD', videoId: 'vS' },
    ],
  };

  it('refuses to replace a shared asset from its origin lecture, leaving the row untouched', async () => {
    const h = harness(structuredClone(shared));
    await expect(h.service.initUpload({ lessonId: 'lS', ...UPLOAD }, ADMIN)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(h.db.tables.video[0]).toMatchObject({ gumletAssetId: 'a1', status: 'READY' });
    expect(h.txWrites).toEqual([]);
  });

  it('refuses to upload a second video onto a lecture that plays a reused asset', async () => {
    const h = harness(structuredClone(shared));
    await expect(h.service.initUpload({ lessonId: 'lD', ...UPLOAD }, ADMIN)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(h.db.tables.video).toHaveLength(1);
    expect(h.links()).toEqual(['lD:vS', 'lS:vS']);
  });

  it('still allows replacing an unshared video', async () => {
    const h = harness({
      lesson: [lesson('l1', 'c1')],
      video: [{ id: 'v1', lessonId: 'l1', courseId: 'c1', status: 'READY', deletedAt: null, drmProvider: 'gumlet', gumletAssetId: 'a9' }],
      lessonVideo: [{ lessonId: 'l1', videoId: 'v1' }],
    });
    await h.service.initUpload({ lessonId: 'l1', ...UPLOAD }, ADMIN);
    expect(h.db.tables.video[0]).toMatchObject({ id: 'v1', status: 'UPLOADING', gumletAssetId: null });
    expect(h.links()).toEqual(['l1:v1']);
  });
});
