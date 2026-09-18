import { PartEntitlementSource, PartPricingModel } from '@prisma/client';

import { grantPartFromCode } from '../../src/modules/course-parts/grant-part-from-code';

/**
 * Acquiring a course part by redeeming its card.
 *
 * ── The rule this file exists to hold ───────────────────────────────────────
 *
 *     The wallet is for the Library. A course part never debits it.
 *
 * An earlier build let a student buy a part with wallet credits. That was wrong
 * under the platform's financial rule and has been removed; the first test here
 * asserts the absence of any wallet interaction, because a regression on that
 * point would be invisible in every other test.
 *
 * What a redemption must still do is record the acquisition honestly: which
 * part, what it was worth at that moment, which card unlocked it, and how that
 * value splits between teacher and platform — all frozen, so a later price
 * change cannot rewrite it.
 */

const COURSE_TEACHERS = [
  {
    teacherId: 'tch_1',
    isLead: true,
    revenueSharePercent: '60',
    teacher: { teacherProfile: { revenueSharePercent: '50' } },
  },
];

/** Two parts, 60/40, on a 1000 EGP course. Part 1 is therefore worth 600. */
const PARTS = [
  {
    id: 'prt_1',
    title: 'Part 1 — Before Mid',
    sortOrder: 1,
    pricingModel: PartPricingModel.PERCENTAGE,
    pricePercent: '60',
    priceAmount: null,
  },
  {
    id: 'prt_2',
    title: 'Part 2 — After Mid',
    sortOrder: 2,
    pricingModel: PartPricingModel.PERCENTAGE,
    pricePercent: '40',
    priceAmount: null,
  },
];

interface Options {
  existingEntitlement?: { id: string; revokedAt: Date | null } | null;
  /** Course has no current price row. */
  unpriced?: boolean;
  /** Parts no longer total 100%, so the allocation throws. */
  brokenAllocation?: boolean;
  /** The part row is gone. */
  missingPart?: boolean;
}

function build(options: Options = {}) {
  const part = {
    ...PARTS[0],
    courseId: 'crs_1',
    currency: 'EGP',
    deletedAt: null,
    course: { id: 'crs_1', title: 'Circuit Analysis II', teachers: COURSE_TEACHERS },
  };

  const acquisitionCreate = jest.fn(
    async ({ data }: { data: Record<string, unknown> }) => ({ id: 'cpp_1', ...data }),
  );
  const entitlementUpsert = jest.fn(
    async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => ({
      id: 'cpe_1',
      ...args.create,
    }),
  );

  const tx = {
    coursePart: {
      findFirst: jest.fn(async () => (options.missingPart ? null : part)),
      findMany: jest.fn(async () =>
        options.brokenAllocation
          ? [{ ...PARTS[0], pricePercent: '60' }, { ...PARTS[1], pricePercent: '10' }]
          : PARTS,
      ),
    },
    coursePrice: {
      findFirst: jest.fn(async () => (options.unpriced ? null : { amount: '1000' })),
    },
    coursePartEntitlement: {
      findUnique: jest.fn(async () => options.existingEntitlement ?? null),
      upsert: entitlementUpsert,
    },
    coursePartPurchase: { create: acquisitionCreate },
  };

  return { tx, acquisitionCreate, entitlementUpsert };
}

const GRANT = {
  userId: 'usr_1',
  coursePartId: 'prt_1',
  accessCodeId: 'cod_1',
  sectionIds: ['sec_1', 'sec_2'],
};

describe('grantPartFromCode — no wallet, ever', () => {
  it('touches no wallet table at all', async () => {
    // The regression guard. If a future change reintroduces a debit, the
    // transaction client would need a wallet table — and it does not have one,
    // so the call would throw rather than silently take a student's credits.
    const { tx } = build();

    await grantPartFromCode(tx as never, GRANT);

    expect(tx).not.toHaveProperty('wallet');
    expect(tx).not.toHaveProperty('walletTransaction');
  });

  it('records the card as the provenance, never a wallet transaction', async () => {
    const { tx, acquisitionCreate } = build();

    await grantPartFromCode(tx as never, GRANT);

    const data = acquisitionCreate.mock.calls[0][0].data;
    expect(data.accessCodeId).toBe('cod_1');
    // The CHECK constraint requires exactly one provenance; this must be absent.
    expect(data.walletTransactionId).toBeUndefined();
  });
});

describe('grantPartFromCode — the acquisition record', () => {
  it('freezes what the part was worth at redemption', async () => {
    const { tx, acquisitionCreate } = build();

    const result = await grantPartFromCode(tx as never, GRANT);

    // 60% of 1000, computed from the live allocation at this moment.
    expect(result?.valueAtRedemption).toBe(600);
    const data = acquisitionCreate.mock.calls[0][0].data;
    expect(data.priceAtPurchase).toBe('600.00');
    expect(data.pricePercentAtPurchase).toBe(60);
    expect(data.coursePriceAtPurchase).toBe('1000');
    expect(data.partTitleSnapshot).toBe('Part 1 — Before Mid');
    expect(data.courseTitleSnapshot).toBe('Circuit Analysis II');
  });

  it('snapshots the sections the card unlocked', async () => {
    const { tx, acquisitionCreate } = build();

    await grantPartFromCode(tx as never, GRANT);

    expect(acquisitionCreate.mock.calls[0][0].data.sectionIdsSnapshot).toEqual([
      'sec_1',
      'sec_2',
    ]);
  });

  it('splits the value so teacher and platform add back exactly', async () => {
    // What the CHECK constraint asserts on every row.
    const { tx, acquisitionCreate } = build();

    await grantPartFromCode(tx as never, GRANT);

    const data = acquisitionCreate.mock.calls[0][0].data;
    // The per-assignment share (60%) wins over the profile default (50%).
    expect(data.sharePercent).toBe(60);
    expect(data.teacherAmount).toBe('360.00');
    expect(data.platformAmount).toBe('240.00');
    expect(Number(data.teacherAmount) + Number(data.platformAmount)).toBe(600);
  });

  it('keys the record to the card and the student', async () => {
    const { tx, acquisitionCreate } = build();

    await grantPartFromCode(tx as never, GRANT);

    expect(acquisitionCreate.mock.calls[0][0].data.idempotencyKey).toBe(
      'partcode:cod_1:usr_1',
    );
  });

  it('marks the entitlement as coming from a code', async () => {
    const { tx, entitlementUpsert } = build();

    await grantPartFromCode(tx as never, GRANT);

    expect(entitlementUpsert.mock.calls[0][0].create.source).toBe(
      PartEntitlementSource.CODE,
    );
  });
});

describe('grantPartFromCode — awkward states', () => {
  it('writes nothing when the student already holds the part', async () => {
    const { tx, acquisitionCreate, entitlementUpsert } = build({
      existingEntitlement: { id: 'cpe_existing', revokedAt: null },
    });

    const result = await grantPartFromCode(tx as never, GRANT);

    expect(result?.alreadyHeld).toBe(true);
    expect(acquisitionCreate).not.toHaveBeenCalled();
    expect(entitlementUpsert).not.toHaveBeenCalled();
  });

  it('reinstates a revoked entitlement rather than duplicating it', async () => {
    // A revoked row records something withdrawn, not something held. The unique
    // (userId, coursePartId) index would refuse a second row anyway.
    const { tx, entitlementUpsert } = build({
      existingEntitlement: { id: 'cpe_old', revokedAt: new Date() },
    });

    await grantPartFromCode(tx as never, GRANT);

    expect(entitlementUpsert).toHaveBeenCalledTimes(1);
    expect(entitlementUpsert.mock.calls[0][0].update.revokedAt).toBeNull();
  });

  it('still grants the part when the course has no price', async () => {
    // The student paid for the card offline. An unpriced course is an
    // authoring gap, and refusing here would punish them for it.
    const { tx, acquisitionCreate } = build({ unpriced: true });

    const result = await grantPartFromCode(tx as never, GRANT);

    expect(result?.alreadyHeld).toBe(false);
    expect(acquisitionCreate.mock.calls[0][0].data.priceAtPurchase).toBe('0.00');
  });

  it('still grants the part when the allocation no longer adds up', async () => {
    // Visibly wrong in a report beats invisibly wrong in an entitlement.
    const { tx, acquisitionCreate } = build({ brokenAllocation: true });

    const result = await grantPartFromCode(tx as never, GRANT);

    expect(result?.alreadyHeld).toBe(false);
    expect(acquisitionCreate.mock.calls[0][0].data.priceAtPurchase).toBe('0.00');
    // The split still balances, which is what the CHECK constraint needs.
    const data = acquisitionCreate.mock.calls[0][0].data;
    expect(Number(data.teacherAmount) + Number(data.platformAmount)).toBe(0);
  });

  it('returns null, without throwing, when the part no longer exists', async () => {
    // The card's frozen sections are still granted by the ordinary path; there
    // is simply no part left to record against. A student holding a card that
    // was legitimately sold must not hit an error.
    const { tx, acquisitionCreate } = build({ missingPart: true });

    const result = await grantPartFromCode(tx as never, GRANT);

    expect(result).toBeNull();
    expect(acquisitionCreate).not.toHaveBeenCalled();
  });
});
