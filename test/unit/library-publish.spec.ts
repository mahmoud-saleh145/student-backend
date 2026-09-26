import { ContentStatus, UserRole } from '@prisma/client';

import { LibraryService } from '../../src/modules/library/library.service';

/**
 * Publishing a library material.
 *
 * A material is created `DRAFT` and every student-facing read requires exactly
 * `PUBLISHED`, so publishing is the switch that decides whether finished,
 * paid-for work is visible at all. These tests pin three things:
 *
 *   1. the status the administrator sent is the status that is written,
 *   2. `publishedAt` is stamped the first time and never rewritten, and
 *   3. the student-facing `where` clauses keep filtering on `PUBLISHED`,
 *      so a draft cannot be reached by guessing its id.
 *
 * (3) is the one that would fail silently. A dashboard publish button makes the
 * first two visible immediately; nobody notices a missing `status` filter until
 * a draft leaks.
 */

const ADMIN = { id: 'usr_admin', role: UserRole.ADMIN };

function build(
  before: {
    status?: ContentStatus;
    publishedAt?: Date | null;
  } = {},
) {
  const material = {
    id: 'mat_1',
    title: 'Physics Revision Papers',
    status: before.status ?? ContentStatus.DRAFT,
    isActive: true,
    publishedAt: before.publishedAt ?? null,
    deletedAt: null,
  };

  // Typed parameters throughout: `jest.fn(async () => …)` infers an empty
  // parameter tuple, so `mock.calls[0][0]` is a type error under `strict`.
  const update = jest.fn(async (_args: { where: unknown; data: Record<string, unknown> }) => ({
    ...material,
  }));
  const findFirst = jest.fn(async (_args: { where: Record<string, unknown> }) => material);

  // `findMany`/`count` are declared here rather than assigned onto the literal
  // later: adding a property to an object literal after the fact is a type
  // error, and these two are what `browse` calls.
  const findMany = jest.fn(async (_args: { where: Record<string, unknown> }) => [] as never[]);
  const count = jest.fn(async (_args: { where: Record<string, unknown> }) => 0);

  // Only the array form is modelled, and deliberately so. Referencing `prisma`
  // from inside its own initialiser — which the callback form needs, to hand
  // the callback a client — makes its type circular (TS7022/TS7024 under
  // `noImplicitAny`). `browse` uses the array form and nothing else under test
  // opens a transaction at all, so a path that did would fail loudly here
  // rather than being quietly accommodated.
  const prisma = {
    libraryMaterial: { findFirst, update, findMany, count },
    $transaction: jest.fn(async (operations: readonly unknown[]) => Promise.all(operations)),
  };

  // The parameter is named even though the body ignores it: a zero-arity
  // `jest.fn(async () => …)` infers an EMPTY parameter tuple, which makes
  // `mock.calls[0][0]` a type error under `strict` — the trap
  // library-documents.spec.ts and codes.service.spec.ts both document.
  const audit = {
    record: jest.fn(async (_entry: Record<string, unknown>) => undefined),
  };
  // `browse` resolves each cover through this; the name matters because a
  // missing method would fail the test for the wrong reason.
  const storage = { publicAssetUrl: jest.fn(async () => null), signMediaUrl: jest.fn() };

  const service = new LibraryService(
    prisma as never,
    audit as never,
    storage as never,
  );

  // `updateMaterial` returns `materialForAdmin`, which re-reads. The second
  // read is not what these assertions are about, so it is answered with the
  // same row rather than a second fixture.
  jest
    .spyOn(service, 'materialForAdmin')
    .mockImplementation(async () => material as never);

  return { service, prisma, audit, material, update, findFirst, findMany, count };
}

/** The `data` object the service handed Prisma. */
function writtenData(update: ReturnType<typeof build>['update']): Record<string, unknown> {
  const call = update.mock.calls[0];
  if (!call) throw new Error('libraryMaterial.update was never called');
  return call[0].data;
}

describe('library material publishing', () => {
  it('persists PUBLISHED and stamps publishedAt the first time', async () => {
    const { service, update } = build({ status: ContentStatus.DRAFT, publishedAt: null });

    await service.updateMaterial('mat_1', { status: ContentStatus.PUBLISHED }, ADMIN);

    const data = writtenData(update);
    expect(data.status).toBe(ContentStatus.PUBLISHED);
    expect(data.publishedAt).toBeInstanceOf(Date);
  });

  it('does not rewrite publishedAt on a later publish', async () => {
    // The first-published date is a business record: re-publishing after a
    // withdrawal must not make the material look newer than it is.
    const firstTime = new Date('2026-01-05T10:00:00.000Z');
    const { service, update } = build({
      status: ContentStatus.DRAFT,
      publishedAt: firstTime,
    });

    await service.updateMaterial('mat_1', { status: ContentStatus.PUBLISHED }, ADMIN);

    expect(writtenData(update)).not.toHaveProperty('publishedAt');
  });

  it('unpublishing writes DRAFT and leaves publishedAt alone', async () => {
    const firstTime = new Date('2026-01-05T10:00:00.000Z');
    const { service, update } = build({
      status: ContentStatus.PUBLISHED,
      publishedAt: firstTime,
    });

    await service.updateMaterial('mat_1', { status: ContentStatus.DRAFT }, ADMIN);

    const data = writtenData(update);
    expect(data.status).toBe(ContentStatus.DRAFT);
    expect(data).not.toHaveProperty('publishedAt');
  });

  it('records the status change in the audit trail', async () => {
    const { service, audit } = build({ status: ContentStatus.DRAFT });

    await service.updateMaterial('mat_1', { status: ContentStatus.PUBLISHED }, ADMIN);

    const call = audit.record.mock.calls[0];
    if (!call) throw new Error('audit.record was never called');

    const entry = call[0] as {
      entity: string;
      before: { status: ContentStatus };
      after: Record<string, unknown>;
    };

    expect(entry.entity).toBe('library_material');
    expect(entry.before.status).toBe(ContentStatus.DRAFT);
    expect(entry.after.status).toBe(ContentStatus.PUBLISHED);
  });

  it('never touches a field the administrator did not send', async () => {
    // The dashboard publishes by PATCHing only `status`. If the service filled
    // in anything else, publishing would quietly overwrite catalogue placement
    // or the title.
    const { service, update } = build({ status: ContentStatus.DRAFT });

    await service.updateMaterial('mat_1', { status: ContentStatus.PUBLISHED }, ADMIN);

    expect(Object.keys(writtenData(update)).sort()).toEqual(['publishedAt', 'status']);
  });
});

describe('student-facing reads filter on PUBLISHED', () => {
  it('browse asks only for published, active material', async () => {
    const { service, findMany } = build();

    await service.browse({ page: 1, pageSize: 20, userId: 'usr_1' });

    // The clause is read off the real call rather than assumed, because this is
    // the filter that stops a draft being listed.
    const call = findMany.mock.calls[0];
    if (!call) throw new Error('libraryMaterial.findMany was never called');

    const where = call[0].where as { status?: ContentStatus; isActive?: boolean };
    expect(where.status).toBe(ContentStatus.PUBLISHED);
    expect(where.isActive).toBe(true);
  });

  it('a direct read of a draft material finds nothing', async () => {
    // Direct access by id is the interesting case: the material is not listed,
    // so the only way to reach it is to already know the id.
    const { service, findFirst } = build({ status: ContentStatus.DRAFT });
    // Emulate the database honouring the clause the service sent: a draft row
    // does not match a `status: PUBLISHED` query, so the read comes back null
    // and the service must turn that into a not-found rather than serving it.
    findFirst.mockImplementation(async () => null as never);

    await expect(service.materialForStudent('mat_1', 'usr_1')).rejects.toThrow();

    const read = findFirst.mock.calls[0];
    if (!read) throw new Error('libraryMaterial.findFirst was never called');

    const where = read[0].where as { status?: ContentStatus; isActive?: boolean };
    expect(where.status).toBe(ContentStatus.PUBLISHED);
    expect(where.isActive).toBe(true);
  });
});
