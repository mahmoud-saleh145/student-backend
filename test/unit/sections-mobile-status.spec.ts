import { SectionsService } from '../../src/modules/sections/sections.service';

/**
 * The staff curriculum (`GET /admin/courses/:id/sections`) reports each lecture
 * video's web (Gumlet) `status` and mobile (HLS) `mobileStatus` side by side,
 * each read from its own column, for an owned video and for a reused one.
 */

const COURSE = 'course_1';

function service(lessons: unknown[]) {
  const findMany = jest.fn(async () => [
    {
      id: 'sec_1',
      courseId: COURSE,
      title: 'Before midterm',
      sortOrder: 1,
      status: 'PUBLISHED',
      deletedAt: null,
      _count: { lessons: lessons.length },
      lessons,
    },
  ]);
  const prisma = { courseSection: { findMany } };
  const access = { staffMayViewCourse: jest.fn(async () => true) };
  const svc = new SectionsService(prisma as never, access as never, {} as never, {} as never);
  return { svc, findMany };
}

const lesson = (id: string, extra: Record<string, unknown>) => ({
  id,
  sectionId: 'sec_1',
  courseId: COURSE,
  title: id,
  description: null,
  kind: 'VIDEO',
  sortOrder: 1,
  status: 'PUBLISHED',
  isPreview: false,
  durationSeconds: 0,
  deletedAt: null,
  videoLinks: [],
  _count: { attachments: 0 },
  video: null,
  ...extra,
});

const video = (id: string, status: string, mobileStatus: string, extra: Record<string, unknown> = {}) => ({
  id,
  status,
  mobileStatus,
  durationSeconds: 1800,
  deletedAt: null,
  processingError: null,
  updatedAt: new Date('2026-11-23T20:00:00Z'),
  lessonId: 'les_owned',
  ...extra,
});

describe('staff sections list: web and mobile status side by side', () => {
  it('asks the database for mobileStatus on both the owned and the reused video', async () => {
    const { svc, findMany } = service([]);
    await svc.listForCourse(COURSE, { id: 'u_admin', role: 'ADMIN' as never });
    const include = (findMany.mock.calls[0] as unknown as [{ include: { lessons: { include: Record<string, { select: Record<string, unknown> }> } } }])[0]
      .include.lessons.include;
    expect(include.video!.select).toMatchObject({ status: true, mobileStatus: true });
    const linked = include.videoLinks as unknown as { select: { video: { select: Record<string, unknown> } } };
    expect(linked.select.video.select).toMatchObject({ status: true, mobileStatus: true });
  });

  it('an owned video: web FAILED and mobile READY are reported independently', async () => {
    const { svc } = service([lesson('les_owned', { video: video('v1', 'FAILED', 'READY') })]);
    const [section] = await svc.listForCourse(COURSE);
    expect(section!.lessons[0]!.video).toMatchObject({ id: 'v1', status: 'FAILED', mobileStatus: 'READY' });
  });

  it('a reused video carries its own mobileStatus too', async () => {
    const reused = video('v2', 'READY', 'QUEUED', { courseId: 'course_other', lessonId: 'les_other' });
    const { svc } = service([
      lesson('les_here', { videoLinks: [{ lessonId: 'les_other', video: reused }] }),
    ]);
    const [section] = await svc.listForCourse(COURSE);
    expect(section!.lessons[0]!.video).toMatchObject({ id: 'v2', status: 'READY', mobileStatus: 'QUEUED', reused: true });
  });

  it('NONE stays NONE (never inferred from the web status)', async () => {
    const { svc } = service([lesson('les_owned', { video: video('v3', 'READY', 'NONE') })]);
    const [section] = await svc.listForCourse(COURSE);
    expect(section!.lessons[0]!.video).toMatchObject({ status: 'READY', mobileStatus: 'NONE' });
  });
});
