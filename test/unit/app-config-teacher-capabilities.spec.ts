import { MetaController } from '../../src/modules/meta/meta.controller';

/**
 * The dashboard decides which controls a teacher sees (delete lecture, delete
 * video, edit video URLs, edit prices) from `meta/app-config → teacher.*`.
 * The block was never returned, so every switch read as OFF and an admin
 * enabling one changed nothing for teachers.
 */
function controller(allowed: Record<string, boolean>) {
  const config = {
    getOrThrow: (key: string) =>
      ({
        app: { env: 'test' },
        playback: { ticketTtl: 300, heartbeatInterval: 30, maxConcurrentStreams: 2 },
        video: { drm: { enabled: true }, ladder: [720] },
      })[key],
  };
  const platformSettings = {
    deviceLimit: jest.fn(async () => 1),
    contacts: jest.fn(async () => ({})),
    allowsAcademicYearChange: jest.fn(async () => false),
    teacherMay: jest.fn(async (capability: string) => allowed[capability] ?? false),
  };
  const prisma = { platformSetting: { findMany: jest.fn(async () => []) } };
  return new MetaController(prisma as never, config as never, platformSettings as never);
}

describe('GET /meta/app-config teacher capabilities', () => {
  it('reports what an administrator currently allows teachers to do', async () => {
    const out = (await controller({ deleteVideos: true, editCoursePrices: true }).appConfig()) as {
      teacher: Record<string, boolean>;
    };
    expect(out.teacher).toEqual({
      canDeleteLectures: false,
      canDeleteVideos: true,
      canEditVideoUrls: false,
      canEditCoursePrices: true,
    });
  });

  it('keeps every existing field, so the change is additive for the mobile app', async () => {
    const out = (await controller({}).appConfig()) as Record<string, unknown>;
    expect(out).toEqual(
      expect.objectContaining({
        minimumAppVersion: '1.0.0',
        maintenanceMode: false,
        playback: expect.any(Object),
        device: expect.any(Object),
        features: expect.any(Object),
      }),
    );
  });
});
