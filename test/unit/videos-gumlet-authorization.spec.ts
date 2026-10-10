import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { ROLES_KEY } from 'src/common/decorators/roles.decorator';
import { VideosController } from 'src/modules/videos/videos.controller';

/**
 * Authorisation on the Gumlet staff endpoints.
 *
 * `@StaffOnly()` already blocks students, but staff is not one permission:
 * a teacher must not be able to ingest, resync or inspect a video belonging to
 * a course they do not manage. These tests pin the ownership check that runs
 * in the controller, including the ordering that keeps a probe of the Gumlet
 * API from being reachable through an unrelated video id.
 *
 * The controller is instantiated directly rather than through the HTTP layer,
 * so Nest's guards are not exercised by these tests; the route metadata is
 * asserted separately below. What is verified here is the controller's own
 * ownership gate, and that no Gumlet call happens before it passes.
 */

const ACTOR = { id: 'staff_1', role: 'TEACHER' } as never;
const OTHER_ACTOR = { id: 'staff_2', role: 'TEACHER' } as never;
const ADMIN = { id: 'admin_1', role: 'ADMIN' } as never;

type GumletRoute = 'gumletAdopt' | 'gumletSync' | 'gumletStatus';

const GUMLET_ROUTES: GumletRoute[] = ['gumletAdopt', 'gumletSync', 'gumletStatus'];

const proto = (method: GumletRoute) =>
  (VideosController.prototype as unknown as Record<GumletRoute, (...a: never[]) => unknown>)[method];

function build(opts: { course?: { courseId: string } | null; allowed?: boolean } = {}) {
  const course = opts.course === undefined ? { courseId: 'course_1' } : opts.course;
  const allowed = opts.allowed ?? true;

  const videos = {
    getCourseForVideo: jest.fn(async () => course),
    assertCanManageCourseContent: jest.fn(async () => {
      if (!allowed) throw new ForbiddenException('Not your course');
    }),
  };

  const gumletIngest = {
    adopt: jest.fn(async () => ({ assetId: 'asset_1', status: 'processing' })),
    sync: jest.fn(async () => ({ assetId: 'asset_1', status: 'ready', playable: true })),
    status: jest.fn(async () => ({
      assetId: 'asset_1',
      gumletStatus: 'ready',
      videoStatus: 'READY',
      error: null,
      playable: true,
    })),
  };

  const controller = new VideosController(videos as never, gumletIngest as never);

  return { controller, videos, gumletIngest };
}

const call = (c: unknown, m: string, videoId: string, actor: unknown) =>
  (c as Record<string, (...a: never[]) => Promise<unknown>>)[m]!(videoId as never, actor as never);

describe('a manager of the course', () => {
  it('may adopt a video onto the Gumlet path', async () => {
    const t = build();

    const result = await call(t.controller, 'gumletAdopt', 'v_1', ACTOR);

    expect(result).toEqual({ assetId: 'asset_1', status: 'processing' });
    expect(t.videos.assertCanManageCourseContent).toHaveBeenCalledWith(
      'staff_1',
      'TEACHER',
      'course_1',
    );
  });

  it('may resync the asset', async () => {
    const t = build();

    const result = await call(t.controller, 'gumletSync', 'v_1', ACTOR);

    expect(result).toEqual({ assetId: 'asset_1', status: 'ready', playable: true });
  });

  it('may read the asset state', async () => {
    const t = build();

    const result = (await call(t.controller, 'gumletStatus', 'v_1', ACTOR)) as {
      playable: boolean;
    };

    expect(result.playable).toBe(true);
  });
});

describe('a staff member outside the course', () => {
  it('is refused by adopt, and no asset is created', async () => {
    const t = build({ allowed: false });

    await expect(call(t.controller, 'gumletAdopt', 'v_1', OTHER_ACTOR)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // The important assertion: the refusal happens before any Gumlet traffic.
    expect(t.gumletIngest.adopt).not.toHaveBeenCalled();
    expect(t.gumletIngest.sync).not.toHaveBeenCalled();
    expect(t.gumletIngest.status).not.toHaveBeenCalled();
  });

  it('is refused by sync', async () => {
    const t = build({ allowed: false });

    await expect(call(t.controller, 'gumletSync', 'v_1', OTHER_ACTOR)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(t.gumletIngest.sync).not.toHaveBeenCalled();
  });

  it('is refused by status, so asset state cannot be probed cross-course', async () => {
    const t = build({ allowed: false });

    await expect(call(t.controller, 'gumletStatus', 'v_1', OTHER_ACTOR)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(t.gumletIngest.status).not.toHaveBeenCalled();
  });
});

describe('a missing video', () => {
  it('reports 404 rather than a permission error', async () => {
    // Leaking "forbidden" for a video that does not exist would confirm its
    // existence to someone outside the course.
    const t = build({ course: null });

    await expect(call(t.controller, 'gumletAdopt', 'v_missing', ACTOR)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(t.videos.assertCanManageCourseContent).not.toHaveBeenCalled();
    expect(t.gumletIngest.adopt).not.toHaveBeenCalled();
  });
});

describe('an administrator', () => {
  it('is checked against the same rule and allowed through', async () => {
    const t = build();

    await call(t.controller, 'gumletSync', 'v_1', ADMIN);

    expect(t.videos.assertCanManageCourseContent).toHaveBeenCalledWith('admin_1', 'ADMIN', 'course_1');
  });
});

describe('endpoint metadata', () => {
  it('every Gumlet route is declared staff-only', () => {
    // Guards are applied by Nest from these decorators; if one were dropped the
    // route would fall through to the default (any authenticated user).
    for (const method of GUMLET_ROUTES) {
      const roles = Reflect.getMetadata(ROLES_KEY, proto(method));
      expect(roles).toEqual([UserRole.MASTER, UserRole.ADMIN, UserRole.TEACHER]);
      // A student must never appear in the list.
      expect(roles).not.toContain(UserRole.STUDENT);
    }
  });

  it('the ownership gate is present on all three routes', () => {
    // Guards a refactor that moves the call into the service without the
    // controller check.
    for (const method of GUMLET_ROUTES) {
      expect(proto(method).toString()).toContain('assertCanManageVideo');
    }
  });
});