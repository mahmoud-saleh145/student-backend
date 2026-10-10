/**
 * Runs the REAL backend resolvers against the production data clone.
 *
 * This is the check that matters most and that no unit test can make: that
 * `resolveAcademicSystem` and `resolveAcademicStructure` — the two functions
 * every layer in every app ultimately depends on — agree with what the
 * diagnostic SQL says about the same rows.
 *
 * Usage:
 *   DATABASE_URL=<clone> npx ts-node -r tsconfig-paths/register \
 *     scripts/probe-resolution.ts
 *
 * Read-only: it selects and prints, and writes nothing.
 */
import { PrismaClient } from '@prisma/client';

import { CatalogService } from '../src/modules/catalog/catalog.service';

const prisma = new PrismaClient();

/** Stubs for the collaborators `CatalogService` needs but never calls here. */
const redis = {
  remember: async (_key: string, _ttl: number, producer: () => Promise<unknown>) =>
    producer(),
  delByPattern: async () => 0,
} as never;
const audit = { record: async () => undefined } as never;

async function main() {
  const service = new CatalogService(prisma as never, redis, audit);

  const faculties = await prisma.faculty.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, university: { select: { name: true } } },
    orderBy: { name: 'asc' },
  });

  console.log(
    ['university', 'college', 'SYSTEM', 'source', 'LADDER', 'label', 'agrees'].join(
      ' | ',
    ),
  );
  console.log('-'.repeat(110));

  let mismatches = 0;
  for (const faculty of faculties) {
    const system = await service.resolveAcademicSystem({ facultyId: faculty.id });
    const selection = await service.academicSelection({ facultyId: faculty.id });

    const label = selection.academicYears[0]?.name ?? '(none)';
    if (!selection.ladderMatchesSystem) mismatches += 1;

    console.log(
      [
        faculty.university.name,
        faculty.name,
        system.system,
        system.source,
        selection.ladderKind ?? '(none)',
        label,
        selection.ladderMatchesSystem ? 'yes' : 'NO',
      ].join(' | '),
    );
  }

  // Every student, resolved through their DEPARTMENT the way registration does.
  console.log('\nStudents, resolved through their department:');
  const students = await prisma.studentProfile.findMany({
    select: {
      id: true,
      departmentId: true,
      academicYearId: true,
      department: { select: { name: true, faculty: { select: { name: true } } } },
      academicYear: { select: { name: true } },
    },
  });

  for (const student of students) {
    const system = await service.resolveAcademicSystem({
      departmentId: student.departmentId,
    });
    const structure = await service.resolveAcademicStructure({
      departmentId: student.departmentId,
    });
    const rung = student.academicYearId
      ? await prisma.academicYear.findUnique({
          where: { id: student.academicYearId },
          select: { name: true, structureId: true },
        })
      : null;

    const belongs =
      rung !== null && structure !== null && rung.structureId === structure.id;
    console.log(
      [
        student.department?.faculty.name,
        student.department?.name,
        system.system,
        system.source,
        rung?.name ?? '(none)',
        belongs ? 'on a valid rung' : 'ORPHANED',
      ].join(' | '),
    );
    if (!belongs) mismatches += 1;
  }

  console.log(`\nInconsistencies: ${mismatches}`);
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
