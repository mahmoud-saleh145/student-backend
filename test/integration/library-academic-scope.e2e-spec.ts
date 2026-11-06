import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  AcademicStructureKind,
  ContentStatus,
  LibraryDepartmentScope,
  PrismaClient,
  StudyType,
  UserRole,
} from '@prisma/client';

import { LibraryEligibilityService } from '../../src/modules/library/library-eligibility.service';
import { LibraryService } from '../../src/modules/library/library.service';
import { PlaybackService } from '../../src/modules/playback/playback.service';

import { bootstrapTestApp, createUser, resetDatabase, shutdownTestApp } from './helpers';

/**
 * Library academic scope against a REAL migrated Postgres (local, `_test`).
 *
 * A1 — the database itself holds the invariants the migration adds:
 *   * departmentScope defaults to FACULTY;
 *   * a live material always has a university and a faculty (CHECK);
 *   * a department link belongs to the material's own faculty (composite FKs);
 *   * a package always belongs to a material (NOT NULL).
 * B  — the real LibraryService enforces the audience rules end to end.
 */

let app: INestApplication;
let prisma: PrismaClient;
let library: LibraryService;

const ids = {} as Record<string, string>;
const ADMIN = { id: '', role: UserRole.ADMIN };
const bootState: { eligibility?: boolean; playback?: boolean; envValue?: string } = {};

beforeAll(async () => {
  ({ app, prisma } = await bootstrapTestApp());
  await resetDatabase(prisma);
  library = app.get(LibraryService, { strict: false });

  // C2: what the real app wiring produced, recorded BEFORE this suite opens the
  // storefront for its own scenarios. LIBRARY_STOREFRONT_ENABLED is not set in
  // the test environment, so both readers must have booted OFF.
  const eligibility = app.get(LibraryEligibilityService, { strict: false });
  bootState.eligibility = eligibility.storefrontEnabled;
  bootState.playback = app.get(PlaybackService, { strict: false }).libraryStorefrontEnabled;
  bootState.envValue = process.env.LIBRARY_STOREFRONT_ENABLED;

  eligibility.storefrontEnabled = true;

  const uni = await prisma.university.create({ data: { name: 'Mansoura University', nameAr: 'جامعة المنصورة' } });
  const otherUni = await prisma.university.create({ data: { name: 'Delta University', nameAr: 'جامعة الدلتا' } });
  const general = await prisma.faculty.create({
    data: { universityId: uni.id, name: 'Faculty of Engineering (General)', nameAr: 'هندسة عام' },
  });
  const programs = await prisma.faculty.create({
    data: { universityId: uni.id, name: 'Faculty of Engineering (Programs)', nameAr: 'هندسة برامج' },
  });
  const prep = await prisma.department.create({
    data: { facultyId: general.id, name: 'Preparatory year', nameAr: 'اعدادي', studyType: StudyType.GENERAL },
  });
  const civil = await prisma.department.create({
    data: { facultyId: general.id, name: 'Civil', nameAr: 'مدني', studyType: StudyType.GENERAL },
  });
  const cce = await prisma.department.create({
    data: { facultyId: programs.id, name: 'CCE', nameAr: 'اتصالات', studyType: StudyType.PROGRAMS },
  });

  const yearLadder = await prisma.academicStructure.create({
    data: { kind: AcademicStructureKind.YEAR, scopeKey: `faculty:${general.id}`, facultyId: general.id },
  });
  const levelLadder = await prisma.academicStructure.create({
    data: { kind: AcademicStructureKind.LEVEL, scopeKey: `faculty:${programs.id}`, facultyId: programs.id },
  });
  const year1 = await prisma.academicYear.create({
    data: { structureId: yearLadder.id, order: 1, name: 'Preparatory year', nameAr: 'الاعدادية' },
  });
  const level0 = await prisma.academicYear.create({
    data: { structureId: levelLadder.id, order: 1, name: 'Level 000', nameAr: 'مستوى 000' },
  });

  const admin = await createUser(prisma, { role: UserRole.ADMIN });
  ADMIN.id = admin.id;

  const student = async (facultyId: string, departmentId: string, universityId = uni.id) => {
    const user = await createUser(prisma);
    await prisma.studentProfile.create({ data: { userId: user.id, universityId, facultyId, departmentId } });
    return user.id;
  };

  Object.assign(ids, {
    uni: uni.id,
    otherUni: otherUni.id,
    general: general.id,
    programs: programs.id,
    prep: prep.id,
    civil: civil.id,
    cce: cce.id,
    year1: year1.id,
    level0: level0.id,
    prepStudent: await student(general.id, prep.id),
    civilStudent: await student(general.id, civil.id),
    cceStudent: await student(programs.id, cce.id),
  });
});

afterAll(async () => {
  await shutdownTestApp();
});

const browseIds = async (userId: string) =>
  (await library.browse({ page: 1, pageSize: 50, userId })).items.map((m: { id: string }) => m.id);

describe('C2 — the storefront boots OFF through the real configuration wiring', () => {
  it('both readers of LIBRARY_STOREFRONT_ENABLED were OFF at boot with the variable unset', () => {
    expect(bootState.envValue).toBeUndefined();
    expect(bootState.eligibility).toBe(false);
    expect(bootState.playback).toBe(false);
  });
});

describe('A1 — the schema holds the invariants', () => {
  it('departmentScope defaults to FACULTY', async () => {
    const m = await prisma.libraryMaterial.create({
      data: { title: 'Default scope', universityId: ids.uni, facultyId: ids.general },
    });
    expect(m.departmentScope).toBe(LibraryDepartmentScope.FACULTY);
  });

  it('CHECK: a live material without a faculty is refused', async () => {
    await expect(
      prisma.libraryMaterial.create({ data: { title: 'No faculty', universityId: ids.uni } }),
    ).rejects.toThrow();
  });

  it('CHECK: a soft-deleted legacy row without placement is still allowed', async () => {
    await expect(
      prisma.libraryMaterial.create({ data: { title: 'Legacy deleted', deletedAt: new Date() } }),
    ).resolves.toBeTruthy();
  });

  it('composite FK: a department from another faculty cannot be linked', async () => {
    const m = await prisma.libraryMaterial.create({
      data: { title: 'FK test', universityId: ids.uni, facultyId: ids.general },
    });
    await expect(
      prisma.libraryMaterialDepartment.create({
        data: { materialId: m.id, facultyId: ids.general, departmentId: ids.cce },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.libraryMaterialDepartment.create({
        data: { materialId: m.id, facultyId: ids.programs, departmentId: ids.cce },
      }),
    ).rejects.toThrow();
  });

  it('composite FK: a material cannot change faculty while its links point at the old one', async () => {
    const m = await prisma.libraryMaterial.create({
      data: { title: 'Move test', universityId: ids.uni, facultyId: ids.general, departmentScope: LibraryDepartmentScope.DEPARTMENTS },
    });
    await prisma.libraryMaterialDepartment.create({
      data: { materialId: m.id, facultyId: ids.general, departmentId: ids.prep },
    });
    await expect(
      prisma.libraryMaterial.update({ where: { id: m.id }, data: { facultyId: ids.programs } }),
    ).rejects.toThrow();
  });

  it('NOT NULL: a package without a material is refused', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO library_packages (id, title, price, "updatedAt") VALUES ('pkg_orphan', 'Orphan', 10, now())`,
      ),
    ).rejects.toThrow();
  });
});

describe('B — audience rules through the real service', () => {
  it('B1/B3: faculty-wide reaches every department of the faculty and nobody else', async () => {
    const created = (await library.createMaterial(
      { title: 'Mechanica (faculty-wide)', universityId: ids.uni, facultyId: ids.general, academicYearId: ids.year1 },
      ADMIN,
    )) as { id: string };
    await library.updateMaterial(created.id, { status: ContentStatus.PUBLISHED }, ADMIN);

    expect(await browseIds(ids.prepStudent)).toContain(created.id);
    expect(await browseIds(ids.civilStudent)).toContain(created.id);
    expect(await browseIds(ids.cceStudent)).not.toContain(created.id);
  });

  it('B4/B5: department scope reaches only the listed department', async () => {
    const created = (await library.createMaterial(
      {
        title: 'Prep only',
        universityId: ids.uni,
        facultyId: ids.general,
        departmentScope: LibraryDepartmentScope.DEPARTMENTS,
        departmentIds: [ids.prep],
      },
      ADMIN,
    )) as { id: string };
    await library.updateMaterial(created.id, { status: ContentStatus.PUBLISHED }, ADMIN);

    expect(await browseIds(ids.prepStudent)).toContain(created.id);
    expect(await browseIds(ids.civilStudent)).not.toContain(created.id);
  });

  it('B7: year/level filter narrows, never hides from the eligible list', async () => {
    const all = await browseIds(ids.civilStudent);
    const filtered = (await library.browse({ page: 1, pageSize: 50, userId: ids.civilStudent, academicYearId: ids.year1 })).items.map(
      (m: { id: string }) => m.id,
    );
    expect(filtered.every((id: string) => all.includes(id))).toBe(true);
  });

  it('refuses a department from another faculty, mixed scope/links, and a rung from the wrong ladder', async () => {
    await expect(
      library.createMaterial(
        { title: 'x', universityId: ids.uni, facultyId: ids.general, departmentScope: LibraryDepartmentScope.DEPARTMENTS, departmentIds: [ids.cce] },
        ADMIN,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      library.createMaterial(
        { title: 'x', universityId: ids.uni, facultyId: ids.general, departmentScope: LibraryDepartmentScope.FACULTY, departmentIds: [ids.prep] },
        ADMIN,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      library.createMaterial(
        { title: 'x', universityId: ids.uni, facultyId: ids.general, departmentScope: LibraryDepartmentScope.DEPARTMENTS, departmentIds: [] },
        ADMIN,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      library.createMaterial(
        { title: 'x', universityId: ids.uni, facultyId: ids.general, academicYearId: ids.level0 },
        ADMIN,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      library.createMaterial({ title: 'x', universityId: ids.otherUni, facultyId: ids.general }, ADMIN),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('an edit cannot change the audience partially, and a full change replaces links cleanly', async () => {
    const created = (await library.createMaterial(
      { title: 'Mover', universityId: ids.uni, facultyId: ids.general, departmentScope: LibraryDepartmentScope.DEPARTMENTS, departmentIds: [ids.prep] },
      ADMIN,
    )) as { id: string };

    await expect(
      library.updateMaterial(created.id, { facultyId: ids.programs }, ADMIN),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const moved = (await library.updateMaterial(
      created.id,
      {
        universityId: ids.uni,
        facultyId: ids.programs,
        departmentScope: LibraryDepartmentScope.DEPARTMENTS,
        departmentIds: [ids.cce],
        academicYearId: ids.level0,
      },
      ADMIN,
    )) as { facultyId: string; departmentIds: string[] };
    expect(moved.facultyId).toBe(ids.programs);
    expect(moved.departmentIds).toEqual([ids.cce]);
  });

  it('publishing re-validates a stored audience with a rung from the wrong ladder', async () => {
    // A legacy-shaped row: Programs faculty, YEAR rung (two such drafts exist).
    const legacy = await prisma.libraryMaterial.create({
      data: { title: 'Legacy draft', universityId: ids.uni, facultyId: ids.programs, academicYearId: ids.year1 },
    });
    await expect(
      library.updateMaterial(legacy.id, { status: ContentStatus.PUBLISHED }, ADMIN),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('Decision B — revoked ownership vs free preview, against the real database', () => {
  const view = async (userId: string, materialId: string) =>
    (await library.materialForStudent(materialId, userId)) as {
      view: string;
      parts: Array<{ id: string; access: string; ownership: string }>;
    };
  const myPartIds = async (userId: string) =>
    ((await library.myLibrary(userId, 1, 50)) as unknown as { items: Array<{ partId: string }> }).items.map((i) => i.partId);

  let materialId = '';
  let paidId = '';
  let previewId = '';

  beforeAll(async () => {
    const material = await prisma.libraryMaterial.create({
      data: {
        title: 'Decision B material',
        universityId: ids.uni,
        facultyId: ids.general,
        status: ContentStatus.PUBLISHED,
      },
    });
    const paid = await prisma.libraryPart.create({
      data: { materialId: material.id, title: 'Paid part', sortOrder: 1, price: 50, objectKey: 'library/b/paid.pdf' },
    });
    const preview = await prisma.libraryPart.create({
      data: { materialId: material.id, title: 'Preview part', sortOrder: 2, price: 0, isPreview: true, objectKey: 'library/b/preview.pdf' },
    });
    materialId = material.id;
    paidId = paid.id;
    previewId = preview.id;

    const revokedAt = new Date('2026-11-02T00:00:00Z');
    await prisma.libraryEntitlement.createMany({
      data: [
        // In scope, both parts revoked.
        { userId: ids.prepStudent, libraryPartId: paidId, revokedAt },
        { userId: ids.prepStudent, libraryPartId: previewId, revokedAt },
        // In scope, an unrevoked owner of the paid part.
        { userId: ids.civilStudent, libraryPartId: paidId },
        // Out of scope (Programs), only a revoked preview.
        { userId: ids.cceStudent, libraryPartId: previewId, revokedAt },
      ],
    });
  });

  afterEach(() => {
    app.get(LibraryEligibilityService, { strict: false }).storefrontEnabled = true;
  });

  it('B3: a revoked preview part offers the preview and reports the revoked ownership; a revoked paid part offers nothing', async () => {
    const detail = await view(ids.prepStudent, materialId);
    expect(detail.view).toBe('FULL');
    expect(Object.fromEntries(detail.parts.map((p) => [p.id, [p.access, p.ownership]]))).toEqual({
      [paidId]: ['REVOKED', 'REVOKED'],
      [previewId]: ['PREVIEW', 'REVOKED'],
    });
  });

  it('B5: out of scope, having owned the preview part shows nothing (404)', async () => {
    await expect(view(ids.cceStudent, materialId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('B6/B8: storefront off — the revoked student sees nothing, the unrevoked owner keeps the owner view', async () => {
    app.get(LibraryEligibilityService, { strict: false }).storefrontEnabled = false;
    await expect(view(ids.prepStudent, materialId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const owner = await view(ids.civilStudent, materialId);
    expect(owner.view).toBe('OWNER');
    expect(owner.parts.map((p) => [p.id, p.access, p.ownership])).toEqual([[paidId, 'OWNED', 'OWNED']]);
  });

  it('B7: My Library never lists a revoked entitlement, and reading the views restores none', async () => {
    expect(await myPartIds(ids.prepStudent)).toEqual([]);
    expect(await myPartIds(ids.cceStudent)).toEqual([]);
    expect(await myPartIds(ids.civilStudent)).toEqual([paidId]);
    const stillRevoked = await prisma.libraryEntitlement.count({
      where: { userId: ids.prepStudent, libraryPartId: { in: [paidId, previewId] }, revokedAt: { not: null } },
    });
    expect(stillRevoked).toBe(2);
  });
});

/**
 * The binding and the edge secret on real rows, through the real HTTP stack:
 * the auth guard, the throttler and the controller.
 */
describe('liveness against the real database and HTTP stack', () => {
  const SECRET = 'integration-edge-secret-0123456789abcdef';
  const FUTURE = () => new Date(Date.now() + 3600_000);
  let playback: PlaybackService;
  let cfg: { edgeLivenessSecret: string | null; edgeLivenessEnforce: boolean };
  let eligibility: LibraryEligibilityService;
  let materialId = '';
  let paidId = '';
  let previewId = '';
  let student = '';
  let device1 = '';
  let device2 = '';
  let session1 = '';
  let session2 = '';

  const state = (ticket: string, query: Record<string, string>, secret?: string) => {
    const req = request(app.getHttpServer()).get(`/api/v1/playback/tickets/${ticket}/state`).query(query);
    return secret ? req.set('x-edge-secret', secret) : req;
  };
  const liveOf = (res: { body: { data?: { live?: boolean } } }) => res.body.data?.live;

  beforeAll(async () => {
    playback = app.get(PlaybackService, { strict: false });
    eligibility = app.get(LibraryEligibilityService, { strict: false });
    cfg = (playback as unknown as { cfg: typeof cfg }).cfg;
    const material = await prisma.libraryMaterial.create({
      data: { title: 'Binding material', universityId: ids.uni, facultyId: ids.general, status: ContentStatus.PUBLISHED },
    });
    materialId = material.id;
    paidId = (await prisma.libraryPart.create({
      data: { materialId, title: 'Paid', sortOrder: 1, price: 50, objectKey: 'library/bind/paid.pdf' },
    })).id;
    previewId = (await prisma.libraryPart.create({
      data: { materialId, title: 'Preview', sortOrder: 2, price: 0, isPreview: true, objectKey: 'library/bind/preview.pdf' },
    })).id;

    student = (await createUser(prisma, { role: UserRole.STUDENT, phone: '01099000001' })).id;
    await prisma.studentProfile.create({
      data: { userId: student, universityId: ids.uni, facultyId: ids.general, departmentId: ids.prep },
    });
    await prisma.libraryEntitlement.create({ data: { userId: student, libraryPartId: paidId } });
    const device = (key: string, status: 'ACTIVE' | 'PENDING_APPROVAL') =>
      prisma.device.create({ data: { userId: student, deviceKey: key, name: key, platform: 'web', status } });
    device1 = (await device('bind-1', 'ACTIVE')).id;
    device2 = (await device('bind-2', 'ACTIVE')).id;
    const session = (deviceId: string | null) =>
      prisma.session.create({ data: { userId: student, deviceId, expiresAt: FUTURE() } });
    session1 = (await session(device1)).id;
    session2 = (await session(device2)).id;
  });

  afterEach(() => {
    cfg.edgeLivenessSecret = null;
    cfg.edgeLivenessEnforce = false;
    eligibility.storefrontEnabled = true;
    playback.libraryStorefrontEnabled = false;
  });

  describe('owned tickets', () => {
    const owned = () => `lib_${paidId}`;
    const ask = (sid: string, did: string) =>
      playback.ticketLiveness(owned(), student, { sid, did });

    it('live on the exact session and device', async () => {
      await expect(ask(session1, device1)).resolves.toEqual({ live: true });
    });

    it('a URL naming the other approved device of the account is dead', async () => {
      await expect(ask(session1, device2)).resolves.toEqual({ live: false });
    });

    it('dead once its session is revoked, while another session of the student stays active', async () => {
      const temp = await prisma.session.create({ data: { userId: student, deviceId: device1, expiresAt: FUTURE() } });
      await expect(ask(temp.id, device1)).resolves.toEqual({ live: true });
      await prisma.session.update({ where: { id: temp.id }, data: { status: 'REVOKED' } });
      await expect(ask(temp.id, device1)).resolves.toEqual({ live: false });
      await expect(ask(session1, device1)).resolves.toEqual({ live: true });
    });

    it('dead once its session has expired, on the real row', async () => {
      const temp = await prisma.session.create({
        data: { userId: student, deviceId: device1, expiresAt: new Date(Date.now() - 1000) },
      });
      await expect(ask(temp.id, device1)).resolves.toEqual({ live: false });
    });

    it('dead when the account is suspended, on the real row', async () => {
      await prisma.user.update({ where: { id: student }, data: { status: 'SUSPENDED' } });
      try {
        await expect(ask(session1, device1)).resolves.toEqual({ live: false });
      } finally {
        await prisma.user.update({ where: { id: student }, data: { status: 'ACTIVE' } });
      }
    });

    it('dead once its device is not active', async () => {
      await prisma.device.update({ where: { id: device2 }, data: { status: 'REVOKED' } });
      try {
        await expect(ask(session2, device2)).resolves.toEqual({ live: false });
      } finally {
        await prisma.device.update({ where: { id: device2 }, data: { status: 'ACTIVE' } });
      }
    });
  });

  describe('preview tickets', () => {
    const preview = () => `libp_${previewId}`;

    it('live with no approved device: a session bound to a pending one, and a session with none', async () => {
      playback.libraryStorefrontEnabled = true;
      const pending = await prisma.device.create({
        data: { userId: student, deviceKey: 'bind-pending', name: 'p', platform: 'web', status: 'PENDING_APPROVAL' },
      });
      const onPending = await prisma.session.create({ data: { userId: student, deviceId: pending.id, expiresAt: FUTURE() } });
      const noDevice = await prisma.session.create({ data: { userId: student, deviceId: null, expiresAt: FUTURE() } });
      await expect(playback.ticketLiveness(preview(), student, { sid: onPending.id, did: pending.id })).resolves.toEqual({ live: true });
      await expect(playback.ticketLiveness(preview(), student, { sid: noDevice.id })).resolves.toEqual({ live: true });
    });

    it('dead with the storefront off, like every other material', async () => {
      playback.libraryStorefrontEnabled = false;
      await expect(playback.ticketLiveness(preview(), student, { sid: session1 })).resolves.toEqual({ live: false });
    });
  });

  describe('the route', () => {
    const exact = () => ({ uid: student, sid: session1, did: device1 });

    it('before any secret: the previous Worker gets the account-wide answer', async () => {
      const res = await state(`lib_${paidId}`, { uid: student });
      expect(res.status).toBe(200);
      expect(liveOf(res)).toBe(true);
    });

    it('before enforcement: a probe naming the wrong device is held to it', async () => {
      const res = await state(`lib_${paidId}`, { uid: student, sid: session1, did: device2 });
      expect(liveOf(res)).toBe(false);
    });

    it('repeated query parameters are refused, not passed to the database', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/playback/tickets/lib_${paidId}/state`)
        .query(`uid=${student}&sid=${session1}&sid=${session2}&did=${device1}`);
      expect(res.status).toBe(200);
      expect(liveOf(res)).toBe(false);
    });

    it('enforced: no secret and a wrong secret are 401 with no answer; the right secret is answered', async () => {
      cfg.edgeLivenessSecret = SECRET;
      cfg.edgeLivenessEnforce = true;
      const none = await state(`lib_${paidId}`, exact());
      expect(none.status).toBe(401);
      expect(liveOf(none)).toBeUndefined();
      const wrong = await state(`lib_${paidId}`, exact(), 'x'.repeat(40));
      expect(wrong.status).toBe(401);
      const legacy = await state(`lib_${paidId}`, { uid: student });
      expect(legacy.status).toBe(401);
      const right = await state(`lib_${paidId}`, exact(), SECRET);
      expect(right.status).toBe(200);
      expect(liveOf(right)).toBe(true);
    });

    it('an authenticated probe without identifiers is dead, before and after enforcement', async () => {
      cfg.edgeLivenessSecret = SECRET;
      expect(liveOf(await state(`lib_${paidId}`, { uid: student }, SECRET))).toBe(false);
      cfg.edgeLivenessEnforce = true;
      expect(liveOf(await state(`lib_${paidId}`, { uid: student }, SECRET))).toBe(false);
    });
  });

  describe('the old dashboard against the new backend', () => {
    it('its edit (part of an audience) is refused and changes nothing, so the rollout freeze is needed', async () => {
      await expect(
        library.updateMaterial(materialId, { title: 'Changed', universityId: ids.uni, facultyId: ids.general }, ADMIN as never),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      const row = await prisma.libraryMaterial.findUniqueOrThrow({ where: { id: materialId } });
      expect(row.title).toBe('Binding material');
    });

    it('its edit that touches no audience field still works', async () => {
      await library.updateMaterial(materialId, { title: 'Binding material' }, ADMIN as never);
    });
  });
});
