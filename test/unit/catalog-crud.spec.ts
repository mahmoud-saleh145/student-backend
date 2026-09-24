import { CatalogController } from '../../src/modules/catalog/catalog.controller';
import { CatalogService } from '../../src/modules/catalog/catalog.service';

/**
 * Catalogue management: renaming, deactivating and putting back.
 *
 * The bug that prompted this was not a missing button. `DELETE
 * /catalog/:entity/:id` switched on a singular union while the dashboard sent
 * the plural — `catalog/universities/:id` — so the switch matched no case,
 * fell through, and answered `{ ok: true }` having deactivated nothing. The
 * interface faithfully reported a success that never happened.
 *
 * So the cases below are mostly about the seam: what the route accepts, what
 * it refuses, and that a refusal is loud.
 */

const ADMIN = { id: 'usr_admin', role: 'ADMIN' as const };

/** A catalogue row as the service's `findFirst` calls select it. */
interface Row {
  id: string;
  name: string;
}

function build() {
  const rows = {
    university: { update: jest.fn(async () => ({})) },
    // The findFirst return types are annotated so a test can substitute a
    // `null` (row not found) without TypeScript objecting that the mock was
    // inferred as always-present.
    faculty: {
      update: jest.fn(async () => ({})),
      findFirst: jest.fn(async (): Promise<Row | null> => ({ id: 'fac_1', name: 'Medicine' })),
      count: jest.fn(async () => 2),
    },
    department: {
      update: jest.fn(async () => ({})),
      findFirst: jest.fn(async (): Promise<Row | null> => ({ id: 'dep_1', name: 'Anatomy' })),
      count: jest.fn(async () => 5),
    },
    academicYear: { update: jest.fn(async () => ({})) },
    studentProfile: { count: jest.fn(async () => 37) },
  };

  const prisma = { ...rows };
  const service = new CatalogService(
    prisma as never,
    { delByPattern: jest.fn() } as never,
    { record: jest.fn() } as never,
  );

  return { controller: new CatalogController(service), service, prisma };
}

describe('the :entity path segment', () => {
  it.each([
    ['universities', 'university'],
    ['faculties', 'faculty'],
    ['departments', 'department'],
  ])('accepts the plural %s the dashboard sends', async (plural, singular) => {
    const { controller, prisma } = build();

    await controller.deactivate(plural, 'row_1', ADMIN as never);

    // The row was actually touched — this is the assertion the old code would
    // have failed while still returning ok.
    expect(prisma[singular as 'university'].update).toHaveBeenCalledTimes(1);
  });

  it.each([['university'], ['faculty'], ['department'], ['academicYear']])(
    'accepts the singular %s',
    async (entity) => {
      const { controller, prisma } = build();
      await controller.deactivate(entity, 'row_1', ADMIN as never);
      expect(prisma[entity as 'university'].update).toHaveBeenCalledTimes(1);
    },
  );

  it('refuses an unknown entity loudly instead of reporting success', async () => {
    const { controller, prisma } = build();

    // The guard runs before the handler awaits anything, so the throw is
    // synchronous. Caught either way, so the assertion does not depend on
    // where in the call the refusal happens.
    let thrown: unknown;
    try {
      await controller.deactivate('sandwiches', 'row_1', ADMIN as never);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();

    for (const table of ['university', 'faculty', 'department', 'academicYear'] as const) {
      expect(prisma[table].update).not.toHaveBeenCalled();
    }
  });
});

describe('deactivate and reactivate are a matched pair', () => {
  it('deactivating sets both the flag and the soft-delete marker', async () => {
    const { controller, prisma } = build();

    await controller.deactivate('university', 'uni_1', ADMIN as never);

    const args = (prisma.university.update.mock.calls[0] as unknown[])[0] as {
      data: { isActive: boolean; deletedAt: Date | null };
    };
    expect(args.data.isActive).toBe(false);
    expect(args.data.deletedAt).toBeInstanceOf(Date);
  });

  it('reactivating clears the marker as well as the flag', async () => {
    // Clearing only `isActive` would leave the row invisible, because every
    // list query filters on `deletedAt`.
    const { controller, prisma } = build();

    await controller.reactivate('university', 'uni_1', ADMIN as never);

    const args = (prisma.university.update.mock.calls[0] as unknown[])[0] as {
      data: { isActive: boolean; deletedAt: Date | null };
    };
    expect(args.data.isActive).toBe(true);
    expect(args.data.deletedAt).toBeNull();
  });

  it('an academic year has no marker to clear', async () => {
    const { controller, prisma } = build();

    await controller.reactivate('academicYear', 'yr_1', ADMIN as never);

    const args = (prisma.academicYear.update.mock.calls[0] as unknown[])[0] as {
      data: Record<string, unknown>;
    };
    expect(args.data).toEqual({ isActive: true });
  });
});

describe('renaming a college and a department', () => {
  it('renames a faculty', async () => {
    const { controller, prisma } = build();

    await controller.updateFaculty('fac_1', { name: 'Pharmacy' } as never, ADMIN as never);

    expect(prisma.faculty.update).toHaveBeenCalledTimes(1);
  });

  it('renames a department', async () => {
    const { controller, prisma } = build();

    await controller.updateDepartment('dep_1', { name: 'Histology' } as never, ADMIN as never);

    expect(prisma.department.update).toHaveBeenCalledTimes(1);
  });

  it('refuses to rename a row that is not there', async () => {
    const { controller, prisma } = build();
    prisma.faculty.findFirst = jest.fn(async () => null);

    await expect(
      controller.updateFaculty('missing', { name: 'X' } as never, ADMIN as never),
    ).rejects.toBeDefined();

    expect(prisma.faculty.update).not.toHaveBeenCalled();
  });
});

describe('dependents, for the confirmation dialog', () => {
  it('counts colleges and students under a university', async () => {
    const { controller } = build();

    await expect(controller.dependents('university', 'uni_1')).resolves.toEqual({
      children: 2,
      students: 37,
    });
  });

  it('counts only students under a department', async () => {
    const { controller } = build();

    await expect(controller.dependents('department', 'dep_1')).resolves.toEqual({
      children: 0,
      students: 37,
    });
  });
});
