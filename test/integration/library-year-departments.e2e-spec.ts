import { readFileSync } from 'fs';
import { join } from 'path';

import type { INestApplication } from '@nestjs/common';
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

import {
  API,
  bootstrapTestApp,
  createDevice,
  createUser,
  errorCode,
  http,
  login,
  resetDatabase,
  shutdownTestApp,
} from './helpers';

/**
 * Departments chosen per year/level, against a REAL migrated Postgres and the
 * real HTTP stack.
 *
 * The rule under test, from the brief: the year/level is a BROWSING filter
 * only. Who may see a material is decided by faculty and department (the
 * union over its years); under which year a student finds it is decided by
 * the departments listed under THAT year. A student's own registered year is
 * never compared with anything.
 *
 * World (Mansoura University):
 *   Programs faculty, LEVEL ladder 000/100/200/300:
 *     MTE, Mechatronics, Electrical, Mechanical (Programs) + Foundation (General)
 *     + Aerospace (Programs), on its own ladder with only "Level 400 (AER)".
 *   General faculty, YEAR ladder Preparatory/First/Second/Third:
 *     Preparatory, Civil, Electrical (General), Mechanical (General)
 *   Delta University, Science: Physics (for cross-faculty refusals)
 */

let app: INestApplication;
let prisma: PrismaClient;
let library: LibraryService;
let adminHeaders: Record<string, string>;

const ADMIN = { id: '', role: UserRole.ADMIN };
const id = {} as Record<string, string>;

async function student(facultyId: string, departmentId: string, academicYearId: string | null) {
  const user = await createUser(prisma);
  await prisma.studentProfile.create({
    data: { userId: user.id, universityId: id.uni, facultyId, departmentId, academicYearId },
  });
  return user;
}

beforeAll(async () => {
  ({ app, prisma } = await bootstrapTestApp());
  await resetDatabase(prisma);
  library = app.get(LibraryService, { strict: false });
  app.get(LibraryEligibilityService, { strict: false }).storefrontEnabled = true;

  const uni = await prisma.university.create({ data: { name: 'Mansoura University', nameAr: 'جامعة المنصورة' } });
  const delta = await prisma.university.create({ data: { name: 'Delta University', nameAr: 'جامعة الدلتا' } });
  id.uni = uni.id;
  const programs = await prisma.faculty.create({
    data: { universityId: uni.id, name: 'Engineering — Programs', nameAr: 'هندسة برامج' },
  });
  const general = await prisma.faculty.create({
    data: { universityId: uni.id, name: 'Engineering — General', nameAr: 'هندسة عام' },
  });
  const science = await prisma.faculty.create({
    data: { universityId: delta.id, name: 'Science', nameAr: 'علوم' },
  });
  Object.assign(id, { programs: programs.id, general: general.id, science: science.id });

  const dept = async (facultyId: string, name: string, studyType: StudyType) =>
    (await prisma.department.create({ data: { facultyId, name, nameAr: name, studyType } })).id;
  Object.assign(id, {
    mte: await dept(programs.id, 'MTE', StudyType.PROGRAMS),
    mct: await dept(programs.id, 'Mechatronics', StudyType.PROGRAMS),
    elec: await dept(programs.id, 'Electrical', StudyType.PROGRAMS),
    mech: await dept(programs.id, 'Mechanical', StudyType.PROGRAMS),
    aer: await dept(programs.id, 'Aerospace', StudyType.PROGRAMS),
    foundation: await dept(programs.id, 'Foundation', StudyType.GENERAL),
    gPrep: await dept(general.id, 'Preparatory', StudyType.GENERAL),
    gCivil: await dept(general.id, 'Civil', StudyType.GENERAL),
    gElec: await dept(general.id, 'Electrical (General)', StudyType.GENERAL),
    gMech: await dept(general.id, 'Mechanical (General)', StudyType.GENERAL),
    physics: await dept(science.id, 'Physics', StudyType.GENERAL),
  });

  const ladder = async (kind: AcademicStructureKind, scope: { facultyId?: string; departmentId?: string }, names: string[]) => {
    const scopeKey = scope.departmentId ? `department:${scope.departmentId}` : `faculty:${scope.facultyId}`;
    const structure = await prisma.academicStructure.create({ data: { kind, scopeKey, ...scope } });
    const rungs: string[] = [];
    for (const [index, name] of names.entries()) {
      rungs.push(
        (await prisma.academicYear.create({
          data: { structureId: structure.id, order: index + 1, name, nameAr: name },
        })).id,
      );
    }
    return rungs;
  };
  const [l000, l100, l200, l300] = await ladder(AcademicStructureKind.LEVEL, { facultyId: programs.id }, [
    'Level 000', 'Level 100', 'Level 200', 'Level 300',
  ]);
  const [l400aer] = await ladder(AcademicStructureKind.LEVEL, { departmentId: id.aer }, ['Level 400 (AER)']);
  const [prep, first, second, third] = await ladder(AcademicStructureKind.YEAR, { facultyId: general.id }, [
    'Preparatory year', 'First year', 'Second year', 'Third year',
  ]);
  Object.assign(id, { l000, l100, l200, l300, l400aer, prep, first, second, third });

  const admin = await createUser(prisma, { role: UserRole.ADMIN });
  ADMIN.id = admin.id;
  await createDevice(prisma, admin.id, 'admin-device');
  adminHeaders = (await login(app, admin.phone, 'admin-device')).headers;

  // Students, each registered in a year/level that differs from where they
  // are expected to find things, on purpose.
  Object.assign(id, {
    mteAt300: (await student(programs.id, id.mte, l300)).id,
    elecAt000: (await student(programs.id, id.elec, l000)).id,
    mechAt200: (await student(programs.id, id.mech, l200)).id,
    mctAt100: (await student(programs.id, id.mct, l100)).id,
    foundationStudent: (await student(programs.id, id.foundation, l000)).id,
    gCivilAtPrep: (await student(general.id, id.gCivil, prep)).id,
    gMechAtFirst: (await student(general.id, id.gMech, first)).id,
    gPrepAtThird: (await student(general.id, id.gPrep, third)).id,
  });
});

afterAll(async () => {
  await shutdownTestApp();
});

// --- helpers -----------------------------------------------------------------

type Detail = {
  id: string;
  departmentScope: string;
  departmentIds: string[];
  academicYearId: string | null;
  academicYearIds: string[];
  yearScope: string;
  audienceMappings: { academicYearId: string; departmentIds: string[] }[];
  audience: { mappings: { academicYear: { id: string }; departments: { id: string }[] }[] };
};

const programsAudience = (audienceMappings: { academicYearId: string; departmentIds: string[] }[]) => ({
  universityId: id.uni,
  facultyId: id.programs,
  departmentScope: 'DEPARTMENTS',
  yearScope: 'SELECTED_YEARS',
  audienceMappings,
});

async function adminCreate(body: Record<string, unknown>, status = 201) {
  const response = await http(app)
    .post(`${API}/admin/library/materials`)
    .set(adminHeaders)
    .send({ title: `Per-year ${Math.random().toString(36).slice(2, 8)}`, ...body })
    .expect(status);
  return response.body.data ?? response.body;
}

async function adminPatch(materialId: string, body: Record<string, unknown>, status = 200) {
  const response = await http(app)
    .patch(`${API}/admin/library/materials/${materialId}`)
    .set(adminHeaders)
    .send(body)
    .expect(status);
  return response.body.data ?? response.body;
}

async function adminGet(materialId: string): Promise<Detail> {
  const response = await http(app)
    .get(`${API}/admin/library/materials/${materialId}`)
    .set(adminHeaders)
    .expect(200);
  return response.body.data ?? response.body;
}

const publish = (materialId: string) =>
  library.updateMaterial(materialId, { status: ContentStatus.PUBLISHED }, ADMIN);

/** Material ids this student finds, optionally under one browsing year. */
async function finds(userId: string, academicYearId?: string, q?: string): Promise<string[]> {
  const items: string[] = [];
  for (let page = 1; ; page += 1) {
    const result = await library.browse({ page, pageSize: 50, userId, academicYearId, q });
    items.push(...result.items.map((m: { id: string }) => m.id));
    if (result.items.length < 50) return items;
  }
}

const sortedMap = (mappings: { academicYearId: string; departmentIds: string[] }[]) =>
  mappings.map((m) => ({ academicYearId: m.academicYearId, departmentIds: [...m.departmentIds].sort() }));

// --- 1-7: create, persist, edit one year, remove a year ------------------------

describe('departments chosen per year/level, through the admin API', () => {
  let materialId: string;

  it('1-4: create Level 000 -> MTE, add Level 200 -> Electrical + Mechanical, and both persist after a reload', async () => {
    const created = (await adminCreate(
      programsAudience([{ academicYearId: id.l000, departmentIds: [id.mte] }]),
    )) as Detail;
    materialId = created.id;
    expect(created.yearScope).toBe('SELECTED_YEARS');
    expect(created.audienceMappings).toEqual([{ academicYearId: id.l000, departmentIds: [id.mte] }]);

    await adminPatch(
      materialId,
      programsAudience([
        { academicYearId: id.l000, departmentIds: [id.mte] },
        { academicYearId: id.l200, departmentIds: [id.elec, id.mech] },
      ]),
    );

    const reloaded = await adminGet(materialId);
    expect(sortedMap(reloaded.audienceMappings)).toEqual(
      sortedMap([
        { academicYearId: id.l000, departmentIds: [id.mte] },
        { academicYearId: id.l200, departmentIds: [id.elec, id.mech] },
      ]),
    );
    // The union is what the material reaches; the years are its filing.
    expect([...reloaded.departmentIds].sort()).toEqual([id.mte, id.elec, id.mech].sort());
    expect(reloaded.academicYearIds).toEqual([id.l000, id.l200]);
    expect(reloaded.academicYearId).toBe(id.l000);
    expect(reloaded.audience.mappings.map((m) => m.academicYear.id)).toEqual([id.l000, id.l200]);
  });

  it('5-6: editing only Level 000 leaves Level 200 exactly as it was', async () => {
    await adminPatch(
      materialId,
      programsAudience([
        { academicYearId: id.l000, departmentIds: [id.mte, id.mct] },
        { academicYearId: id.l200, departmentIds: [id.elec, id.mech] },
      ]),
    );
    const reloaded = await adminGet(materialId);
    const byYear = Object.fromEntries(reloaded.audienceMappings.map((m) => [m.academicYearId, [...m.departmentIds].sort()]));
    expect(byYear[id.l000]).toEqual([id.mte, id.mct].sort());
    expect(byYear[id.l200]).toEqual([id.elec, id.mech].sort());

    const rows = await prisma.libraryMaterialYearDepartment.findMany({ where: { materialId } });
    expect(rows).toHaveLength(4);
  });

  it('7: removing Level 200 removes its departments, and nothing of Level 000', async () => {
    await adminPatch(materialId, programsAudience([{ academicYearId: id.l000, departmentIds: [id.mte, id.mct] }]));
    const reloaded = await adminGet(materialId);
    expect(sortedMap(reloaded.audienceMappings)).toEqual(sortedMap([{ academicYearId: id.l000, departmentIds: [id.mte, id.mct] }]));
    expect([...reloaded.departmentIds].sort()).toEqual([id.mte, id.mct].sort());
    expect(reloaded.academicYearIds).toEqual([id.l000]);
  });
});

// --- 8-10: refusals ----------------------------------------------------------

describe('refusals, reported beside the year group they concern', () => {
  const fieldsOf = (body: { error?: { fields?: Record<string, string[]> }; fields?: Record<string, string[]> }) =>
    body.error?.fields ?? body.fields ?? {};

  it('8: a General-ladder year on the Programs faculty, and a department-only rung for the wrong department', async () => {
    const wrongLadder = await adminCreate(
      programsAudience([
        { academicYearId: id.l000, departmentIds: [id.mte] },
        { academicYearId: id.first, departmentIds: [id.elec] },
      ]),
      422,
    );
    expect(errorCode(wrongLadder)).toBe('VALIDATION_ERROR');
    expect(Object.keys(fieldsOf(wrongLadder))).toEqual(['audienceMappings.1.academicYearId']);

    // Level 400 belongs to Aerospace's own ladder: right for AER, wrong for MTE.
    await adminCreate(programsAudience([{ academicYearId: id.l400aer, departmentIds: [id.aer] }]));
    const notMte = await adminCreate(
      programsAudience([{ academicYearId: id.l400aer, departmentIds: [id.aer, id.mte] }]),
      422,
    );
    expect(Object.keys(fieldsOf(notMte))).toEqual(['audienceMappings.0.academicYearId']);
  });

  it('9: a department of another faculty is refused beside its group; General and Programs split across groups are refused as a whole', async () => {
    const foreign = await adminCreate(
      programsAudience([
        { academicYearId: id.l000, departmentIds: [id.mte] },
        { academicYearId: id.l100, departmentIds: [id.physics] },
      ]),
      422,
    );
    expect(fieldsOf(foreign)).toEqual({
      'audienceMappings.1.departmentIds': ['one or more departments do not belong to the selected college'],
    });

    const mixed = await adminCreate(
      programsAudience([
        { academicYearId: id.l000, departmentIds: [id.mte] },
        { academicYearId: id.l100, departmentIds: [id.foundation] },
      ]),
      422,
    );
    expect(fieldsOf(mixed)).toEqual({
      audienceMappings: ['General and Programs departments cannot be combined'],
    });
  });

  it('10: the same year twice is refused; a department ticked twice is stored once; the database refuses duplicates and strays', async () => {
    const twice = await adminCreate(
      programsAudience([
        { academicYearId: id.l000, departmentIds: [id.mte] },
        { academicYearId: id.l000, departmentIds: [id.elec] },
      ]),
      422,
    );
    expect(Object.keys(fieldsOf(twice))).toEqual(['audienceMappings.1.academicYearId']);

    const once = (await adminCreate(
      programsAudience([{ academicYearId: id.l000, departmentIds: [id.mte, id.mte] }]),
    )) as Detail;
    expect(once.audienceMappings).toEqual([{ academicYearId: id.l000, departmentIds: [id.mte] }]);

    const row = { materialId: once.id, academicYearId: id.l000, departmentId: id.mte };
    await expect(prisma.libraryMaterialYearDepartment.create({ data: row })).rejects.toThrow();
    // A year the material is not filed under, and a department it does not reach.
    await expect(
      prisma.libraryMaterialYearDepartment.create({ data: { ...row, academicYearId: id.l100 } }),
    ).rejects.toThrow();
    await expect(
      prisma.libraryMaterialYearDepartment.create({ data: { ...row, departmentId: id.elec } }),
    ).rejects.toThrow();
  });

  it('refuses per-year departments on a whole-college material, and a year with no department', async () => {
    const wholeCollege = await adminCreate(
      { ...programsAudience([{ academicYearId: id.l000, departmentIds: [id.mte] }]), departmentScope: 'FACULTY' },
      422,
    );
    expect(Object.keys(fieldsOf(wholeCollege))).toEqual(['audienceMappings']);

    const empty = await adminCreate(
      programsAudience([
        { academicYearId: id.l000, departmentIds: [id.mte] },
        { academicYearId: id.l100, departmentIds: [] },
      ]),
      422,
    );
    expect(Object.keys(fieldsOf(empty))).toEqual(['audienceMappings.1.departmentIds']);
  });
});

// --- 11-16: what students find ------------------------------------------------

describe('what students find (the brief’s table)', () => {
  let material: string;
  let wholeCollegeSelected: string;
  let wholeCollegeAll: string;
  let deptsAllYears: string;

  beforeAll(async () => {
    material = (
      (await library.createMaterial(
        {
          title: 'Level 000 -> MTE, Level 200 -> Electrical',
          universityId: id.uni,
          facultyId: id.programs,
          departmentScope: LibraryDepartmentScope.DEPARTMENTS,
          audienceMappings: [
            { academicYearId: id.l000, departmentIds: [id.mte] },
            { academicYearId: id.l200, departmentIds: [id.elec] },
          ],
        },
        ADMIN,
      )) as { id: string }
    ).id;
    wholeCollegeSelected = (
      (await library.createMaterial(
        { title: 'Whole college, Level 100', universityId: id.uni, facultyId: id.programs, academicYearIds: [id.l100] },
        ADMIN,
      )) as { id: string }
    ).id;
    wholeCollegeAll = (
      (await library.createMaterial(
        { title: 'Whole college, all levels', universityId: id.uni, facultyId: id.programs, yearScope: 'ALL_YEARS' },
        ADMIN,
      )) as { id: string }
    ).id;
    deptsAllYears = (
      (await library.createMaterial(
        {
          title: 'Mechanical, all levels',
          universityId: id.uni,
          facultyId: id.programs,
          departmentScope: LibraryDepartmentScope.DEPARTMENTS,
          departmentIds: [id.mech],
          yearScope: 'ALL_YEARS',
        },
        ADMIN,
      )) as { id: string }
    ).id;
    for (const m of [material, wholeCollegeSelected, wholeCollegeAll, deptsAllYears]) await publish(m);
  });

  it('11-14: MTE / Electrical / Mechanical students under each browsing level, whatever their own level', async () => {
    const table: [string, string | undefined, boolean][] = [
      // student (own level differs on purpose), browsing filter, finds it?
      [id.mteAt300, id.l000, true],
      [id.mteAt300, id.l200, false],
      [id.mteAt300, id.l300, false], // their OWN level does not bring it back
      [id.mteAt300, undefined, true],
      [id.elecAt000, id.l000, false], // their own level is not a reason either
      [id.elecAt000, id.l200, true],
      [id.elecAt000, undefined, true],
      [id.mechAt200, id.l000, false], // not listed anywhere: never eligible
      [id.mechAt200, id.l200, false],
      [id.mechAt200, undefined, false],
    ];
    for (const [userId, year, expected] of table) {
      const found = (await finds(userId, year)).includes(material);
      expect({ userId, year, found }).toEqual({ userId, year, found: expected });
    }
  });

  it('the student read labels only the levels the student finds it under, never another department’s', async () => {
    const asMte = (await library.materialForStudent(material, id.mteAt300)) as unknown as { academicYears: { id: string }[]; academicYear: { id: string } | null };
    expect(asMte.academicYears.map((y) => y.id)).toEqual([id.l000]);
    expect(asMte.academicYear?.id).toBe(id.l000);
    const asElec = (await library.materialForStudent(material, id.elecAt000)) as unknown as { academicYears: { id: string }[] };
    expect(asElec.academicYears.map((y) => y.id)).toEqual([id.l200]);
    await expect(library.materialForStudent(material, id.mechAt200)).rejects.toMatchObject({ status: 404 });
  });

  it('15: entire college, selected levels: every department, under those levels only', async () => {
    for (const userId of [id.mteAt300, id.elecAt000, id.mechAt200, id.foundationStudent]) {
      expect(await finds(userId)).toContain(wholeCollegeSelected);
      expect(await finds(userId, id.l100)).toContain(wholeCollegeSelected);
      expect(await finds(userId, id.l000)).not.toContain(wholeCollegeSelected);
    }
  });

  it('16: all levels: under every level, for whoever is eligible', async () => {
    for (const year of [id.l000, id.l100, id.l200, id.l300, undefined]) {
      expect(await finds(id.elecAt000, year)).toContain(wholeCollegeAll);
      expect(await finds(id.mechAt200, year)).toContain(deptsAllYears);
      expect(await finds(id.mteAt300, year)).not.toContain(deptsAllYears);
    }
  });

  it('a student of another faculty finds nothing here, whatever level they browse', async () => {
    for (const year of [id.l000, id.l200, undefined]) {
      expect(await finds(id.gCivilAtPrep, year)).toEqual(
        expect.not.arrayContaining([material, wholeCollegeSelected, wholeCollegeAll, deptsAllYears]),
      );
    }
  });
});

describe('the General track', () => {
  it('Preparatory -> Preparatory; First -> Civil, Electrical; Second -> Mechanical; Third -> Civil, Mechanical', async () => {
    const created = (await adminCreate({
      universityId: id.uni,
      facultyId: id.general,
      departmentScope: 'DEPARTMENTS',
      yearScope: 'SELECTED_YEARS',
      audienceMappings: [
        { academicYearId: id.prep, departmentIds: [id.gPrep] },
        { academicYearId: id.first, departmentIds: [id.gCivil, id.gElec] },
        { academicYearId: id.second, departmentIds: [id.gMech] },
        { academicYearId: id.third, departmentIds: [id.gCivil, id.gMech] },
      ],
    })) as Detail;
    await publish(created.id);

    const sees = async (userId: string, year?: string) => (await finds(userId, year)).includes(created.id);
    // Civil, registered in the Preparatory year: First and Third, not Preparatory or Second.
    expect(await sees(id.gCivilAtPrep, id.prep)).toBe(false);
    expect(await sees(id.gCivilAtPrep, id.first)).toBe(true);
    expect(await sees(id.gCivilAtPrep, id.second)).toBe(false);
    expect(await sees(id.gCivilAtPrep, id.third)).toBe(true);
    expect(await sees(id.gCivilAtPrep)).toBe(true);
    // Mechanical, registered in First year: Second and Third only.
    expect(await sees(id.gMechAtFirst, id.first)).toBe(false);
    expect(await sees(id.gMechAtFirst, id.second)).toBe(true);
    expect(await sees(id.gMechAtFirst, id.third)).toBe(true);
    // Preparatory, registered in Third year: Preparatory only.
    expect(await sees(id.gPrepAtThird, id.prep)).toBe(true);
    expect(await sees(id.gPrepAtThird, id.third)).toBe(false);
    // A Programs student never, whatever the year.
    expect(await sees(id.mteAt300, id.first)).toBe(false);
    expect(await sees(id.mteAt300)).toBe(false);
  });
});

// --- 17: existing materials keep their audience -----------------------------

describe('17: materials saved before this change keep their effective audience', () => {
  it('the migration backfill writes every (year, department) pair, and every student finds exactly what they found before', async () => {
    // A material written the way the previous release wrote it: department
    // links and year links, no per-year rows.
    const legacy = await prisma.libraryMaterial.create({
      data: {
        title: 'Legacy: Level 000 + Level 100, MTE + Electrical',
        universityId: id.uni,
        facultyId: id.programs,
        departmentScope: LibraryDepartmentScope.DEPARTMENTS,
        academicYearId: id.l000,
        status: ContentStatus.PUBLISHED,
        departments: {
          create: [
            { departmentId: id.mte },
            { departmentId: id.elec },
          ],
        },
        academicYears: { create: [{ academicYearId: id.l000 }, { academicYearId: id.l100 }] },
      },
    });
    const legacyFaculty = await prisma.libraryMaterial.create({
      data: {
        title: 'Legacy: whole college, Level 300',
        universityId: id.uni,
        facultyId: id.programs,
        status: ContentStatus.PUBLISHED,
        academicYears: { create: [{ academicYearId: id.l300 }] },
      },
    });

    // What the previous release showed: eligible, and filed under the year or under none.
    const before = (userDept: string, year: string | undefined, m: 'legacy' | 'faculty') => {
      if (m === 'faculty') return year === undefined || year === id.l300;
      const eligible = [id.mte, id.elec].includes(userDept);
      return eligible && (year === undefined || [id.l000, id.l100].includes(year));
    };

    const sql = readFileSync(
      join(__dirname, '../../prisma/migrations/20261112120000_library_year_departments/migration.sql'),
      'utf8',
    );
    const backfill = sql.slice(sql.indexOf('INSERT INTO "library_material_year_departments"'));
    await prisma.$executeRawUnsafe(backfill);
    // Idempotent: running it again changes nothing.
    await prisma.$executeRawUnsafe(backfill);

    const rows = await prisma.libraryMaterialYearDepartment.findMany({ where: { materialId: legacy.id } });
    expect(rows.map((r) => `${r.academicYearId}/${r.departmentId}`).sort()).toEqual(
      [`${id.l000}/${id.mte}`, `${id.l000}/${id.elec}`, `${id.l100}/${id.mte}`, `${id.l100}/${id.elec}`].sort(),
    );
    expect(await prisma.libraryMaterialYearDepartment.count({ where: { materialId: legacyFaculty.id } })).toBe(0);

    const students: [string, string][] = [
      [id.mteAt300, id.mte],
      [id.elecAt000, id.elec],
      [id.mechAt200, id.mech],
      [id.foundationStudent, id.foundation],
    ];
    for (const [userId, dept] of students) {
      for (const year of [undefined, id.l000, id.l100, id.l200, id.l300]) {
        const found = await finds(userId, year);
        expect({ dept, year, legacy: found.includes(legacy.id) }).toEqual({ dept, year, legacy: before(dept, year, 'legacy') });
        expect({ dept, year, faculty: found.includes(legacyFaculty.id) }).toEqual({
          dept,
          year,
          faculty: before(dept, year, 'faculty'),
        });
      }
    }

    // And the editor reads it back as "the same departments under each year".
    const detail = await adminGet(legacy.id);
    expect(detail.yearScope).toBe('SELECTED_YEARS');
    expect(sortedMap(detail.audienceMappings)).toEqual(
      sortedMap([
        { academicYearId: id.l000, departmentIds: [id.mte, id.elec] },
        { academicYearId: id.l100, departmentIds: [id.mte, id.elec] },
      ]),
    );
  });
});

// --- 18-20: old clients, bypass attempts, pagination ----------------------------

describe('18: clients that predate per-year departments', () => {
  it('the previous dashboard’s payload (departmentIds + academicYearIds + legacy id) still saves, as the same departments every year', async () => {
    const created = (await adminCreate({
      universityId: id.uni,
      facultyId: id.programs,
      departmentScope: 'DEPARTMENTS',
      departmentIds: [id.mte, id.elec],
      academicYearId: id.l100,
      academicYearIds: [id.l100, id.l300],
    })) as Detail;
    expect(sortedMap(created.audienceMappings)).toEqual(
      sortedMap([
        { academicYearId: id.l100, departmentIds: [id.mte, id.elec] },
        { academicYearId: id.l300, departmentIds: [id.mte, id.elec] },
      ]),
    );
    // Every field the previous dashboard reads is still there.
    expect(created).toMatchObject({ academicYearId: id.l100, academicYearIds: [id.l100, id.l300] });
    expect([...created.departmentIds].sort()).toEqual([id.mte, id.elec].sort());
  });

  it('the student list keeps `academicYear` and `academicYears` for the web and mobile apps', async () => {
    const page = await library.browse({ page: 1, pageSize: 50, userId: id.mteAt300 });
    for (const item of page.items as { academicYear: unknown; academicYears: unknown[] }[]) {
      expect(item).toHaveProperty('academicYear');
      expect(Array.isArray(item.academicYears)).toBe(true);
    }
  });
});

describe('19: the student API cannot widen the department scope', () => {
  let civilHeaders: Record<string, string>;
  let mteOnly: string;

  beforeAll(async () => {
    mteOnly = (
      (await library.createMaterial(
        {
          title: 'MTE only, Level 000',
          universityId: id.uni,
          facultyId: id.programs,
          departmentScope: LibraryDepartmentScope.DEPARTMENTS,
          audienceMappings: [{ academicYearId: id.l000, departmentIds: [id.mte] }],
        },
        ADMIN,
      )) as { id: string }
    ).id;
    await publish(mteOnly);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: id.elecAt000 } });
    await createDevice(prisma, user.id, 'elec-device');
    civilHeaders = (await login(app, user.phone, 'elec-device')).headers;
  });

  it('a placement or department in the query is refused, and the browsing year never adds a material', async () => {
    for (const query of [`departmentId=${id.mte}`, `facultyId=${id.programs}`, `universityId=${id.uni}`]) {
      await http(app).get(`${API}/library/materials?${query}`).set(civilHeaders).expect(422);
    }
    const response = await http(app)
      .get(`${API}/library/materials?academicYearId=${id.l000}&pageSize=100`)
      .set(civilHeaders)
      .expect(200);
    const items = (response.body.data ?? response.body).items ?? response.body.data;
    expect((items as { id: string }[]).map((m) => m.id)).not.toContain(mteOnly);
  });

  it('the material itself is the same 404 as a missing one', async () => {
    await http(app).get(`${API}/library/materials/${mteOnly}`).set(civilHeaders).expect(404);
  });
});

describe('20: pagination and search never duplicate a material', () => {
  it('a material listed under many years and departments appears once per page walk, and counts once', async () => {
    const wide = (await library.createMaterial(
      {
        title: 'Wide per-year material zzunique',
        universityId: id.uni,
        facultyId: id.programs,
        departmentScope: LibraryDepartmentScope.DEPARTMENTS,
        audienceMappings: [id.l000, id.l100, id.l200, id.l300].map((academicYearId) => ({
          academicYearId,
          departmentIds: [id.mte, id.mct, id.elec, id.mech],
        })),
      },
      ADMIN,
    )) as { id: string };
    await publish(wide.id);

    for (const year of [undefined, id.l100]) {
      const first = await library.browse({ page: 1, pageSize: 1, userId: id.mteAt300, academicYearId: year });
      const seen: string[] = [];
      for (let page = 1; page <= first.meta.totalPages; page += 1) {
        const result = await library.browse({ page, pageSize: 1, userId: id.mteAt300, academicYearId: year });
        seen.push(...result.items.map((m: { id: string }) => m.id));
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.length).toBe(first.meta.total);
      expect(seen.filter((m) => m === wide.id)).toHaveLength(1);
    }

    const searched = await library.browse({ page: 1, pageSize: 50, userId: id.mteAt300, q: 'zzunique', academicYearId: id.l200 });
    expect(searched.items.map((m: { id: string }) => m.id)).toEqual([wide.id]);
    expect(searched.meta.total).toBe(1);
  });
});
