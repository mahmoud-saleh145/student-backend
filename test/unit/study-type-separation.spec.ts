import { UsersService } from '../../src/modules/users/users.service';
import { CatalogService } from '../../src/modules/catalog/catalog.service';
import { CourseAccessService } from '../../src/modules/courses/course-access.service';
import { AcademicStructureKind, StudyType, UserRole } from '@prisma/client';

const selection = {
  universityId: 'u',
  facultyId: 'f',
  departmentId: 'd',
  academicYearId: 'year',
};

function studentService(departmentType: StudyType, rungMatches = true) {
  const prisma = {
    university: { findFirst: jest.fn(async () => ({ id: 'u' })) },
    faculty: { findFirst: jest.fn(async () => ({ id: 'f', universityId: 'u' })) },
    department: {
      findFirst: jest.fn(async () => ({
        id: 'd',
        facultyId: 'f',
        studyType: departmentType,
      })),
    },
    academicYear: {
      findFirst: jest.fn(async (args) =>
        args.where.structureId && !rungMatches ? null : { id: 'year' },
      ),
    },
  };
  const catalog = { resolveAcademicStructure: jest.fn(async () => ({ id: 'ladder' })) };
  return new UsersService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    catalog as never,
  );
}

describe('study type separation', () => {
  it.each([
    [StudyType.GENERAL, StudyType.PROGRAMS],
    [StudyType.PROGRAMS, StudyType.GENERAL],
  ])('rejects a %s student selecting a %s department', async (chosen, department) => {
    await expect(
      studentService(department).assertAcademicSelectionIsCoherent({
        ...selection,
        studyType: chosen,
      }),
    ).rejects.toThrow();
  });

  it.each([StudyType.GENERAL, StudyType.PROGRAMS])(
    'accepts a coherent %s classification',
    async (studyType) => {
      await expect(
        studentService(studyType).assertAcademicSelectionIsCoherent({
          ...selection,
          studyType,
        }),
      ).resolves.toBeUndefined();
    },
  );

  it('rejects a year or level from another branch', async () => {
    await expect(
      studentService(StudyType.GENERAL, false).assertAcademicSelectionIsCoherent({
        ...selection,
        studyType: StudyType.GENERAL,
      }),
    ).rejects.toThrow();
  });

  it('filters department options by study type with separate cache keys', async () => {
    const findMany = jest.fn(async (_args: { where: { studyType?: StudyType } }) => []);
    const remember = jest.fn(async (_key, _ttl, producer) => producer());
    const service = new CatalogService(
      { department: { findMany } } as never,
      { remember } as never,
      {} as never,
    );
    await service.departments('f', StudyType.GENERAL);
    await service.departments('f', StudyType.PROGRAMS);
    expect(findMany.mock.calls[0][0].where.studyType).toBe(StudyType.GENERAL);
    expect(findMany.mock.calls[1][0].where.studyType).toBe(StudyType.PROGRAMS);
    expect(remember.mock.calls[0][0]).not.toBe(remember.mock.calls[1][0]);
  });

  it('denies protected content from another branch despite an existing enrollment', async () => {
    const enrollment = jest.fn();
    const prisma = {
      course: {
        findFirst: jest.fn(async () => ({
          id: 'course',
          status: 'PUBLISHED',
          universityId: 'u',
          facultyId: 'f',
          academicYearId: null,
          departments: [{ departmentId: 'program' }],
        })),
      },
      studentProfile: { findUnique: jest.fn(async () => ({ ...selection })) },
      enrollment: { findUnique: enrollment },
    };
    const service = new CourseAccessService(prisma as never, {} as never, {} as never);
    await expect(
      service.resolve({ userId: 'student', role: UserRole.STUDENT, courseId: 'course' }),
    ).rejects.toThrow();
    expect(enrollment).not.toHaveBeenCalled();
  });
});


describe('department ladder kind', () => {
  it.each([
    [StudyType.GENERAL, AcademicStructureKind.LEVEL],
    [StudyType.PROGRAMS, AcademicStructureKind.YEAR],
  ])('rejects a %s department using %s', async (studyType, kind) => {
    const create = jest.fn();
    const service = new CatalogService({ department: { findUnique: jest.fn(async () => ({ studyType })) }, academicStructure: { create, findFirst: jest.fn(async () => null) } } as never, {} as never, {} as never);
    await expect(service.createAcademicStructure({ departmentId: 'd', kind }, { id: 'admin', role: UserRole.ADMIN })).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
});
