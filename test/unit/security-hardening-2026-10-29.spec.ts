import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  AccountStatus,
  CourseStatus,
  DeviceStatus,
  EnrollmentMethod,
  SessionStatus,
  UserRole,
} from '@prisma/client';

import { ErrorCode } from '../../src/common/errors/error-codes';
import { AuthService } from '../../src/modules/auth/auth.service';
import { TokenService } from '../../src/modules/auth/token.service';
import { CoursesAdminService, changesCommercialTerms } from '../../src/modules/courses/courses.admin.service';
import { CoursesService } from '../../src/modules/courses/courses.service';
import { DevicesService } from '../../src/modules/devices/devices.service';
import { SessionsService } from '../../src/modules/sessions/sessions.service';

import { cloudinaryDouble } from './cloudinary-double';

/**
 * Regression tests for the backend fixes of 2026-10-29 (audit items F-08,
 * F-12, F-14, F-16 and push tokens surviving a revocation). Each block runs
 * the real service against a small hand-written Prisma stand-in.
 */

// ---------------------------------------------------------------------------
// F-12: refresh rotation is compare-and-set
// ---------------------------------------------------------------------------

describe('F-12 two refreshes with the same token at the same instant', () => {
  const META = {
    ip: '10.0.0.1',
    userAgent: 'jest',
    device: { deviceKey: null, platform: 'android', appVersion: '1.0.0' },
  };

  function harness(options: { raceReads?: boolean } = {}) {
    const now = Date.now();
    // The one stored row both requests resolve to.
    const row: Record<string, unknown> = {
      id: 'rt_1',
      userId: 'usr_1',
      sessionId: 'ses_1',
      familyId: 'fam_1',
      replacedById: null,
      usedAt: null,
      revokedAt: null,
      expiresAt: new Date(now + 20 * 86_400_000),
      createdAt: new Date(now - 86_400_000),
      session: { id: 'ses_1', status: SessionStatus.ACTIVE, deviceId: null },
      user: {
        id: 'usr_1',
        role: UserRole.STUDENT,
        status: AccountStatus.ACTIVE,
        deletedAt: null,
        credentialsChangedAt: new Date(now - 30 * 86_400_000),
      },
    };

    // Both requests must read the row before either rotates it - the race.
    let reads = 0;
    let releaseReads: () => void = () => undefined;
    const bothRead = new Promise<void>((resolve) => (releaseReads = resolve));

    const created: string[] = [];
    const replacedByWrites: unknown[] = [];

    const refreshToken = {
      findUnique: jest.fn(async () => {
        const snapshot = { ...row };
        reads += 1;
        if (options.raceReads) {
          if (reads === 2) releaseReads();
          if (reads <= 2) await bothRead;
        }
        return snapshot;
      }),
      create: jest.fn(async () => {
        const id = `rt_new_${created.length + 1}`;
        created.push(id);
        return { id };
      }),
      // Atomic, like a single UPDATE ... WHERE: JavaScript runs it to completion.
      updateMany: jest.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const w = args.where;
        const matches =
          w.id === row.id &&
          (!('usedAt' in w) || (w.usedAt === null && row.usedAt === null)) &&
          (!('revokedAt' in w) || (w.revokedAt === null && row.revokedAt === null));
        if (!matches) return { count: 0 };
        Object.assign(row, args.data);
        return { count: 1 };
      }),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => {
        replacedByWrites.push(args.data.replacedById);
        Object.assign(row, args.data);
        return { id: row.id };
      }),
      findMany: jest.fn(async () => []),
    };

    const prisma = {
      refreshToken,
      session: { update: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 0 })) },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ refreshToken, session: prisma.session }),
      device: { findUnique: jest.fn(async () => null) },
    };

    const authCfg = {
      accessTtl: 900,
      refreshTtl: 30 * 86_400,
      refreshReuseGraceSeconds: 30,
      issuer: 'edu-platform',
      audience: 'edu-mobile',
      accessSecret: 'a'.repeat(48),
      refreshSecret: 'b'.repeat(48),
      playbackSecret: 'c'.repeat(48),
    };
    const configService = { getOrThrow: () => authCfg } as unknown as ConfigService;
    const tokens = new TokenService(
      new JwtService({ secret: authCfg.refreshSecret, signOptions: { issuer: authCfg.issuer, audience: authCfg.audience } }),
      configService,
    );
    jest.spyOn(tokens, 'verifyRefresh').mockImplementation(async () => ({
      sub: 'usr_1',
      sid: 'ses_1',
      fam: 'fam_1',
      jti: 'jti_1',
    }) as never);
    const security = { record: jest.fn(async () => undefined) };

    const service = new AuthService(
      prisma as never,
      { toPublicUser: jest.fn(async () => ({ id: 'usr_1' })) } as never,
      {} as never,
      tokens,
      {} as never,
      security as never,
      { record: jest.fn(async () => undefined) } as never,
      configService,
    );
    return { service, row, created, replacedByWrites, refreshToken, security };
  }

  it('rotates exactly once; the other request is answered through the grace path', async () => {
    const h = harness({ raceReads: true });

    const [a, b] = await Promise.all([
      h.service.refresh('same-token', META as never),
      h.service.refresh('same-token', META as never),
    ]);

    // Both callers keep a working session...
    expect(a.refreshToken).toBeTruthy();
    expect(b.refreshToken).toBeTruthy();
    // ...but the stored token was rotated once: one successor is linked, and
    // the link was written once (before the fix: twice, the second overwriting).
    expect(h.replacedByWrites).toHaveLength(1);
    expect(h.row.replacedById).toBe(h.replacedByWrites[0]);
    // The loser re-read the row and took the documented grace-window path.
    expect(h.security.record).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('within the reuse grace window') }),
    );
  });

  it('claims the token only while it is unused and unrevoked', async () => {
    const h = harness();
    await h.service.refresh('same-token', META as never);
    expect(h.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'rt_1', usedAt: null, revokedAt: null } }),
    );
  });

  it('a token revoked by a concurrent logout is refused, not rotated', async () => {
    const h = harness();
    // The logout lands between this request's read and its rotation.
    h.refreshToken.updateMany.mockImplementationOnce(async () => {
      h.row.revokedAt = new Date();
      return { count: 0 };
    });
    await expect(h.service.refresh('same-token', META as never)).rejects.toMatchObject({
      code: ErrorCode.SESSION_EXPIRED,
    });
    expect(h.replacedByWrites).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// F-14: public sections / attachments honour course and content status
// ---------------------------------------------------------------------------

describe('F-14 public course outline and documents', () => {
  function build(status: CourseStatus) {
    const attachmentFindMany = jest.fn(async () => []);
    const prisma = {
      course: { findFirst: jest.fn(async () => ({ id: 'crs_1', status, enrollmentMethods: [] })) },
      courseSection: { findMany: jest.fn(async () => []) },
      watchProgress: { findMany: jest.fn(async () => []) },
      attachment: { findMany: attachmentFindMany },
    };
    const access = {
      resolve: jest.fn(async () => ({ canAccessContent: false })),
      allowedSectionIds: jest.fn(async () => null),
    };
    const service = new CoursesService(prisma as never, access as never, {} as never);
    return { service, attachmentFindMany };
  }

  it.each([CourseStatus.DRAFT, CourseStatus.HIDDEN, CourseStatus.SUSPENDED])(
    'a %s course is not listed to anonymous callers or students',
    async (status) => {
      const { service } = build(status);
      for (const role of [undefined, UserRole.STUDENT]) {
        await expect(service.sections({ courseId: 'crs_1', userId: null, role })).rejects.toMatchObject({
          code: ErrorCode.COURSE_NOT_AVAILABLE,
        });
        await expect(service.attachments('crs_1', null, role)).rejects.toMatchObject({
          code: ErrorCode.COURSE_NOT_AVAILABLE,
        });
      }
    },
  );

  it('staff still see an unpublished course', async () => {
    const { service } = build(CourseStatus.DRAFT);
    await expect(service.sections({ courseId: 'crs_1', userId: 't1', role: UserRole.TEACHER })).resolves.toEqual([]);
    await expect(service.attachments('crs_1', 't1', UserRole.TEACHER)).resolves.toEqual([]);
  });

  it.each([CourseStatus.PUBLISHED, CourseStatus.ARCHIVED])('a %s course is listed as before', async (status) => {
    const { service } = build(status);
    await expect(service.sections({ courseId: 'crs_1', userId: null })).resolves.toEqual([]);
    await expect(service.attachments('crs_1', null)).resolves.toEqual([]);
  });

  it('students are not shown documents of unpublished lectures or sections; staff are', async () => {
    const student = build(CourseStatus.PUBLISHED);
    await student.service.attachments('crs_1', 's1', UserRole.STUDENT);
    const studentWhere = JSON.stringify((student.attachmentFindMany.mock.calls[0] as unknown[])[0]);
    expect(studentWhere).toContain('"lesson":{"status":"PUBLISHED","section":{"status":"PUBLISHED"}}');
    expect(studentWhere).toContain('"section":{"status":"PUBLISHED"}');

    const staff = build(CourseStatus.PUBLISHED);
    await staff.service.attachments('crs_1', 'a1', UserRole.ADMIN);
    const staffWhere = JSON.stringify((staff.attachmentFindMany.mock.calls[0] as unknown[])[0]);
    expect(staffWhere).not.toContain('PUBLISHED');
  });
});

// ---------------------------------------------------------------------------
// F-08: the device header must match the device the session signed in on
// ---------------------------------------------------------------------------

describe('F-08 device binding uses the session, not only the header', () => {
  function gate(device: { id: string; status: DeviceStatus } | null) {
    const record = jest.fn(async () => undefined);
    const service = new DevicesService(
      { device: { findUnique: jest.fn(async () => device) } } as never,
      { record } as never,
      {} as never,
      {} as never,
      { getOrThrow: () => ({ blockOnIntegrityFailure: false, autoBindFirst: true }) } as never,
    );
    return { service, record };
  }
  const BASE = { userId: 'stu_1', role: UserRole.STUDENT, deviceKey: 'key-of-phone-A', integritySuspect: false };

  it('refuses a session bound to another device that presents this device id', async () => {
    const { service, record } = gate({ id: 'dev_A', status: DeviceStatus.ACTIVE });
    await expect(
      service.assertAuthorizedForProtectedContent({ ...BASE, sessionDeviceId: 'dev_B_pending' }),
    ).rejects.toMatchObject({ code: ErrorCode.DEVICE_NOT_AUTHORIZED });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('different device than this session') }),
    );
  });

  it('allows the session that signed in on this device', async () => {
    const { service } = gate({ id: 'dev_A', status: DeviceStatus.ACTIVE });
    await expect(
      service.assertAuthorizedForProtectedContent({ ...BASE, sessionDeviceId: 'dev_A' }),
    ).resolves.toEqual({ deviceId: 'dev_A' });
  });

  it('keeps the header-only rule for a session signed in without a device (documented residual)', async () => {
    const { service } = gate({ id: 'dev_A', status: DeviceStatus.ACTIVE });
    await expect(
      service.assertAuthorizedForProtectedContent({ ...BASE, sessionDeviceId: null }),
    ).resolves.toEqual({ deviceId: 'dev_A' });
  });

  it('staff are still not device-bound', async () => {
    const { service } = gate(null);
    await expect(
      service.assertAuthorizedForProtectedContent({ ...BASE, role: UserRole.ADMIN, sessionDeviceId: 'x' }),
    ).resolves.toEqual({ deviceId: null });
  });

  it('every protected-content path passes the session device', () => {
    const root = join(__dirname, '..', '..', 'src', 'modules');
    const sites: Array<[string, number]> = [
      ['playback/playback.service.ts', 2],
      ['attachments/attachments.service.ts', 1],
      ['library/library-documents.service.ts', 1],
    ];
    for (const [file, expected] of sites) {
      const source = readFileSync(join(root, file), 'utf8');
      const calls = source.match(/assertAuthorizedForProtectedContent\(\{[\s\S]*?\}\)/g) ?? [];
      expect(calls).toHaveLength(expected);
      for (const call of calls) expect(call).toMatch(/sessionDeviceId: (params\.)?user\.deviceId/);
    }
  });
});

// ---------------------------------------------------------------------------
// Push tokens die with an administrator's revocation
// ---------------------------------------------------------------------------

describe('push tokens are deactivated when an administrator revokes access', () => {
  const ADMIN = { id: 'adm_1', role: UserRole.ADMIN } as never;

  function sessionsService(session: Record<string, unknown> | null) {
    const pushUpdateMany = jest.fn(async () => ({ count: 1 }));
    const tx = {
      session: {
        update: jest.fn(async () => ({})),
        updateMany: jest.fn(async () => ({ count: 2 })),
        findMany: jest.fn(async () => [{ id: 'ses_1' }, { id: 'ses_2' }]),
      },
      refreshToken: { updateMany: jest.fn(async () => ({ count: 1 })) },
      playbackTicket: { updateMany: jest.fn(async () => ({ count: 0 })) },
      pushToken: { updateMany: pushUpdateMany },
    };
    const prisma = {
      session: { findUnique: jest.fn(async () => session) },
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const service = new SessionsService(prisma as never, { record: jest.fn(async () => undefined) } as never);
    return { service, pushUpdateMany };
  }

  it('revoking one session stops pushes to that session\'s handset', async () => {
    const { service, pushUpdateMany } = sessionsService({
      id: 'ses_1',
      userId: 'stu_1',
      status: SessionStatus.ACTIVE,
      device: { deviceKey: 'key-A' },
    });
    await service.revoke({ sessionId: 'ses_1', actor: ADMIN, reason: 'support' });
    expect(pushUpdateMany).toHaveBeenCalledWith({
      where: { userId: 'stu_1', deviceKey: 'key-A', isActive: true },
      data: { isActive: false },
    });
  });

  it('a session without a bound device leaves other handsets\' pushes alone', async () => {
    const { service, pushUpdateMany } = sessionsService({
      id: 'ses_1',
      userId: 'stu_1',
      status: SessionStatus.ACTIVE,
      device: null,
    });
    await service.revoke({ sessionId: 'ses_1', actor: ADMIN, reason: 'support' });
    expect(pushUpdateMany).not.toHaveBeenCalled();
  });

  it('revoking every session stops every push of that user', async () => {
    const { service, pushUpdateMany } = sessionsService(null);
    await service.revokeAllForUser({ userId: 'stu_1', actor: ADMIN, reason: 'compromised' });
    expect(pushUpdateMany).toHaveBeenCalledWith({
      where: { userId: 'stu_1', isActive: true },
      data: { isActive: false },
    });
  });

  it('revoking a device stops pushes to that device', async () => {
    const pushUpdateMany = jest.fn(async () => ({ count: 1 }));
    const prisma = {
      device: {
        findUnique: jest.fn(async () => ({ id: 'dev_A', userId: 'stu_1', deviceKey: 'key-A', status: DeviceStatus.ACTIVE })),
        update: jest.fn(async () => ({})),
      },
      session: { updateMany: jest.fn(async () => ({ count: 1 })) },
      playbackTicket: { updateMany: jest.fn(async () => ({ count: 0 })) },
      refreshToken: { updateMany: jest.fn(async () => ({ count: 1 })) },
      pushToken: { updateMany: pushUpdateMany },
      $transaction: jest.fn(async (ops: readonly unknown[]) => Promise.all(ops)),
    };
    const service = new DevicesService(
      prisma as never,
      { record: jest.fn(async () => undefined) } as never,
      { record: jest.fn(async () => undefined) } as never,
      {} as never,
      { getOrThrow: () => ({}) } as never,
    );
    await service.revokeDevice('dev_A', { id: 'adm_1', role: UserRole.ADMIN }, 'lost');
    expect(pushUpdateMany).toHaveBeenCalledWith({
      where: { userId: 'stu_1', deviceKey: 'key-A', isActive: true },
      data: { isActive: false },
    });
  });
});

// ---------------------------------------------------------------------------
// F-16: commercial terms need the pricing capability
// ---------------------------------------------------------------------------

describe('F-16 joining methods and access duration are pricing decisions', () => {
  const BEFORE = {
    enrollmentMethods: [EnrollmentMethod.CODE, EnrollmentMethod.ADMIN_APPROVAL],
    accessDurationType: 'FIXED_DAYS',
    accessDurationDays: 120,
    accessEndsAt: null,
  };

  it.each([
    ['a method added', { enrollmentMethods: [EnrollmentMethod.CODE, EnrollmentMethod.ADMIN_APPROVAL, EnrollmentMethod.FREE] }],
    ['a method removed', { enrollmentMethods: [EnrollmentMethod.CODE] }],
    ['the duration type changed', { accessDurationType: 'LIFETIME' }],
    ['the day count changed', { accessDurationDays: 365 }],
    ['an end date set', { accessEndsAt: '2027-01-01T00:00:00.000Z' }],
  ])('%s counts as a change', (_label, input) => {
    expect(changesCommercialTerms(BEFORE, input)).toBe(true);
  });

  it.each([
    ['nothing commercial sent', {}],
    ['the same values resent (the dashboard sends the whole form)', {
      enrollmentMethods: [EnrollmentMethod.ADMIN_APPROVAL, EnrollmentMethod.CODE],
      accessDurationType: 'FIXED_DAYS',
      accessDurationDays: 120,
    }],
  ])('%s is not a change', (_label, input) => {
    expect(changesCommercialTerms(BEFORE, input)).toBe(false);
  });

  function adminService(canPrice: boolean) {
    const before = {
      id: 'crs_1',
      title: 'Anatomy',
      shortDescription: '',
      description: '',
      status: CourseStatus.DRAFT,
      thumbnailKey: null,
      universityId: null,
      facultyId: null,
      academicYearId: null,
      departments: [],
      prices: [],
      teachers: [],
      sections: [],
      university: null,
      faculty: null,
      academicYear: null,
      subject: null,
      _count: { enrollments: 0, attachments: 0 },
      sectionCount: 0,
      lessonCount: 0,
      ...BEFORE,
    };
    const courseUpdate = jest.fn(async () => before);
    const prisma: Record<string, unknown> = {
      course: {
        findFirst: jest.fn(async () => before),
        findUnique: jest.fn(async () => null),
        update: courseUpdate,
        findMany: jest.fn(async () => []),
      },
      faculty: { findFirst: jest.fn(async () => null) },
      department: { findMany: jest.fn(async () => []) },
      courseDepartment: { deleteMany: jest.fn(), createMany: jest.fn() },
    };
    prisma.$transaction = jest.fn(async (arg: unknown) =>
      typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(prisma) : arg,
    );
    const assertCanManageCourse = jest.fn(async (_u: string, _r: UserRole, _c: string, capability: string) => {
      if (capability === 'pricing' && !canPrice) {
        throw Object.assign(new Error('no pricing'), { code: ErrorCode.INSUFFICIENT_ROLE });
      }
    });
    const service = new CoursesAdminService(
      prisma as never,
      { recountCourse: jest.fn(async () => undefined) } as never,
      { assertCanManageCourse } as never,
      { record: jest.fn(async () => undefined) } as never,
      { publicAssetUrl: jest.fn(async () => null), deleteObject: jest.fn() } as never,
      { resolveAcademicStructure: jest.fn(async () => ({ id: 'as_1', kind: 'YEAR' })) } as never,
      cloudinaryDouble(),
    );
    return { service, courseUpdate, assertCanManageCourse };
  }
  const TEACHER = { id: 'tch_1', role: UserRole.TEACHER };

  it('a content-only teacher cannot switch a course to lifetime access', async () => {
    const { service, courseUpdate } = adminService(false);
    await expect(service.update('crs_1', { accessDurationType: 'LIFETIME' }, TEACHER)).rejects.toMatchObject({
      code: ErrorCode.INSUFFICIENT_ROLE,
    });
    expect(courseUpdate).not.toHaveBeenCalled();
  });

  it('a content-only teacher can still save the form with the terms unchanged', async () => {
    const { service, courseUpdate, assertCanManageCourse } = adminService(false);
    await service
      .update('crs_1', { title: 'Anatomy II', enrollmentMethods: BEFORE.enrollmentMethods, accessDurationDays: 120 }, TEACHER)
      .catch(() => undefined);
    expect(courseUpdate).toHaveBeenCalled();
    expect(assertCanManageCourse).not.toHaveBeenCalledWith(TEACHER.id, TEACHER.role, 'crs_1', 'pricing');
  });

  it('a teacher with the pricing capability may change them', async () => {
    const { service, courseUpdate, assertCanManageCourse } = adminService(true);
    await service.update('crs_1', { accessDurationType: 'LIFETIME' }, TEACHER).catch(() => undefined);
    expect(assertCanManageCourse).toHaveBeenCalledWith(TEACHER.id, TEACHER.role, 'crs_1', 'pricing');
    expect(courseUpdate).toHaveBeenCalled();
  });
});
