import { AcademicStructureKind, AuditAction, UserRole } from '@prisma/client';

import { CatalogService } from '../../src/modules/catalog/catalog.service';

/**
 * The audit trail for a college's academic-system override.
 *
 * Both directions — setting an override and clearing it back to inheritance —
 * are mutations of the same field on a live row. The question worth pinning is
 * only WHICH action the codebase records them under, because there is a
 * plausible-looking wrong answer: `RESTORE`.
 *
 * `RESTORE` is taken. In `CatalogService.setActive` it is the partner of
 * `DELETE` and means "row reactivated from soft deletion" (`isActive: true,
 * deletedAt: null`) — and it is already emitted against the SAME `faculty`
 * entity. Recording a cleared override as RESTORE would mean a query for
 * "which colleges were reactivated" also returned every override ever cleared.
 * So: UPDATE, with the direction carried in `note`, exactly as `setActive`
 * distinguishes 'Reactivated' from 'Deactivated (soft)'.
 */

const ACTOR = { id: 'usr_admin', role: UserRole.ADMIN };

/**
 * Minimal service covering `setFacultyAcademicSystemOverride` and its audit.
 *
 * The faculty row is held in one variable and both mocks read it, because the
 * method under test writes the row and then RE-READS it to report the effective
 * system — `faculty.findUnique` after `faculty.update`. Two independent fixtures
 * would return the pre-write state, and the test would then be asserting that
 * the resolver reports the value from before the save.
 */
function build(
  initialOverride: AcademicStructureKind | null,
  universityDefault: AcademicStructureKind,
) {
  /** The row, as the database would hold it. Mutated by the update mock. */
  let stored: AcademicStructureKind | null = initialOverride;

  const prisma = {
    faculty: {
      findFirst: jest.fn(async () => ({
        id: 'f1',
        name: 'Engineering',
        academicSystemOverride: stored,
        university: {
          id: 'u1',
          name: 'Cairo University',
          defaultAcademicSystem: universityDefault,
        },
      })),
      findUnique: jest.fn(async () => ({
        id: 'f1',
        academicSystemOverride: stored,
        university: { id: 'u1', defaultAcademicSystem: universityDefault },
      })),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => {
        stored =
          (args.data.academicSystemOverride as AcademicStructureKind | null) ?? null;
        return { id: 'f1', academicSystemOverride: stored };
      }),
    },
    university: {
      findUnique: jest.fn(async () => ({
        id: 'u1',
        defaultAcademicSystem: universityDefault,
      })),
    },
    department: { findUnique: jest.fn(async () => null) },
    academicStructure: {
      findMany: jest.fn(async () => [
        { id: 'as_1', kind: AcademicStructureKind.YEAR, scopeKey: 'faculty:f1' },
      ]),
    },
    academicStructureFaculty: {
      findUnique: jest.fn(async () => null),
    },
    academicYear: { findMany: jest.fn(async () => []) },
  };

  const redis = {
    remember: jest.fn(
      async (_key: string, _ttl: number, producer: () => Promise<unknown>) => producer(),
    ),
    delByPattern: jest.fn(async () => 0),
  };
  const audit = {
    record: jest.fn(async (_entry: Record<string, unknown>) => undefined),
  };

  const service = new CatalogService(prisma as never, redis as never, audit as never);
  return { service, prisma, audit };
}

/** The audit row, read out of the mock. */
function lastEntry(audit: { record: jest.Mock }) {
  const call = audit.record.mock.calls.at(-1);
  if (!call) throw new Error('audit.record was never called');
  return call[0] as {
    action: AuditAction;
    entity: string;
    entityId: string;
    note: string;
    before: { academicSystemOverride: AcademicStructureKind | null };
    after: { academicSystemOverride: AcademicStructureKind | null };
  };
}

describe('audit trail for a college override', () => {
  it('records SETTING an override as UPDATE on the faculty', async () => {
    const { service, audit } = build(null, AcademicStructureKind.YEAR);

    await service.setFacultyAcademicSystemOverride(
      'f1',
      AcademicStructureKind.LEVEL,
      ACTOR,
    );

    const entry = lastEntry(audit);
    expect(entry.action).toBe(AuditAction.UPDATE);
    expect(entry.entity).toBe('faculty');
    expect(entry.entityId).toBe('f1');
    expect(entry.before.academicSystemOverride).toBeNull();
    expect(entry.after.academicSystemOverride).toBe(AcademicStructureKind.LEVEL);
    expect(entry.note).toBe('College academic system override set');
  });

  it('records CLEARING an override as UPDATE, not RESTORE', async () => {
    // The whole point of this test. RESTORE means "row reactivated" in this
    // codebase (see setActive) and is already emitted for the faculty entity;
    // reusing it here would conflate two unrelated events for an auditor.
    const { service, audit } = build(
      AcademicStructureKind.LEVEL,
      AcademicStructureKind.YEAR,
    );

    await service.setFacultyAcademicSystemOverride('f1', null, ACTOR);

    const entry = lastEntry(audit);
    expect(entry.action).toBe(AuditAction.UPDATE);
    expect(entry.action).not.toBe(AuditAction.RESTORE);
    expect(entry.before.academicSystemOverride).toBe(AcademicStructureKind.LEVEL);
    expect(entry.after.academicSystemOverride).toBeNull();
    // The direction is carried in the note, as setActive does.
    expect(entry.note).toContain('cleared');
  });

  it('returns the effective system, so the UI does not need a second read', async () => {
    // The contract stated in the service docblock. After any save the caller has
    // the resolved system and its source, which is what the row re-renders from
    // — without it the screen would show the stored override and let the reader
    // infer the result, which is the ambiguity this whole change removes.
    const { service } = build(AcademicStructureKind.LEVEL, AcademicStructureKind.YEAR);

    const result = await service.setFacultyAcademicSystemOverride('f1', null, ACTOR);

    expect(result.academicSystemOverride).toBeNull();
    expect(result.academicSystem).toMatchObject({
      system: AcademicStructureKind.YEAR,
      source: 'UNIVERSITY_DEFAULT',
      facultyOverride: null,
      universityDefault: AcademicStructureKind.YEAR,
    });
  });

  it('reports an override as the effective answer once set', async () => {
    const { service } = build(null, AcademicStructureKind.YEAR);

    const result = await service.setFacultyAcademicSystemOverride(
      'f1',
      AcademicStructureKind.LEVEL,
      ACTOR,
    );

    expect(result.academicSystemOverride).toBe(AcademicStructureKind.LEVEL);
    expect(result.academicSystem).toMatchObject({
      system: AcademicStructureKind.LEVEL,
      source: 'COLLEGE_OVERRIDE',
      universityDefault: AcademicStructureKind.YEAR,
    });
  });

  it('refuses to store an override identical to the university default', async () => {
    // Records no decision, but would survive the next change of the default and
    // then mean something nobody chose. Nothing is audited on refusal.
    const { service, audit } = build(null, AcademicStructureKind.YEAR);

    await expect(
      service.setFacultyAcademicSystemOverride('f1', AcademicStructureKind.YEAR, ACTOR),
    ).rejects.toThrow();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
