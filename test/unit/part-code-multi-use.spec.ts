import { ContentStatus, CourseStatus, PartEntitlementSource } from '@prisma/client';

/**
 * Multi-use part cards.
 *
 * A part card is routinely sold as a batch: one code, `maxRedemptions` copies,
 * one redemption per student. The purchase row it produces therefore cannot be
 * one-to-one with the card.
 *
 * It used to be. `course_part_purchases.accessCodeId` carried a UNIQUE index, so
 * the first student's redemption wrote the code onto the purchase row and the
 * second student's insert violated it. Redemption runs in a Serializable
 * transaction together with the code consumption and the access grant, so the
 * abort took the entire redemption with it and surfaced as a 500 — not as
 * anything a student or an admin could act on.
 *
 * The invariant worth enforcing is one purchase per student per card, and that
 * is what `idempotencyKey` (`partcode:<codeId>:<userId>`) does. These tests pin
 * that, and pin the fact that the same student redeeming twice does not buy the
 * part twice.
 */

import { grantPartFromCode } from '../../src/modules/course-parts/grant-part-from-code';

const CODE_ID = 'code_1';

interface Options {
  /** True when this student already holds a live entitlement for the part. */
  alreadyHeld?: boolean;
  /** True when a revoked entitlement exists and should be reinstated. */
  revoked?: boolean;
}

function build(options: Options = {}) {
  const created: Array<Record<string, unknown>> = [];

  // A published, active part inside a published course — i.e. an item that is
  // genuinely for sale. Stated explicitly because `grantPartFromCode` refuses
  // anything that is not, and a fixture that omits the fields is a fixture for
  // a part nobody may buy. The refusal cases have their own suite.
  const part = {
    id: 'part_1',
    courseId: 'crs_1',
    title: 'Cardiovascular system',
    currency: 'EGP',
    pricingModel: 'PERCENT',
    status: ContentStatus.PUBLISHED,
    isActive: true,
    deletedAt: null,
    course: {
      id: 'crs_1',
      title: 'Human Anatomy',
      status: CourseStatus.PUBLISHED,
      deletedAt: null,
      teachers: [
        {
          teacherId: 'tch_1',
          isLead: true,
          revenueSharePercent: null,
          teacher: { teacherProfile: { revenueSharePercent: 60 } },
        },
      ],
    },
  };

  const tx = {
    coursePart: {
      findFirst: jest.fn(async () => part),
    },
    coursePartEntitlement: {
      findUnique: jest.fn(async () => {
        if (options.alreadyHeld) return { id: 'ent_live', revokedAt: null };
        if (options.revoked) return { id: 'ent_old', revokedAt: new Date() };
        return null;
      }),
      upsert: jest.fn(async () => ({ id: 'ent_new' })),
    },
    coursePrice: { findFirst: jest.fn(async () => ({ amount: 1000 })) },
    coursePartPurchase: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { id: `pur_${created.length}` };
      }),
    },
    // The allocation loader is imported by the module under test; the price
    // breakdown is not what these tests are about.
    $queryRawUnsafe: jest.fn(async () => []),
    $queryRaw: jest.fn(async () => []),
  };

  return { tx: tx as never, created, part };
}

const grant = (tx: never, userId: string, sectionIds: string[] = ['sec_1']) =>
  grantPartFromCode(tx, {
    userId,
    coursePartId: 'part_1',
    accessCodeId: CODE_ID,
    sectionIds,
  });

describe('many students, one card', () => {
  it('writes one purchase per student against the same card', async () => {
    // The shape that used to be impossible: two rows, one accessCodeId.
    const first = build();
    const second = build();

    await grant(first.tx, 'usr_a');
    await grant(second.tx, 'usr_b');

    expect(first.created[0]).toMatchObject({
      userId: 'usr_a',
      accessCodeId: CODE_ID,
    });
    expect(second.created[0]).toMatchObject({
      userId: 'usr_b',
      accessCodeId: CODE_ID,
    });
  });

  it('gives each student a distinct idempotency key', async () => {
    // Uniqueness lives here, not on the card: exactly one purchase per student
    // per card, and no limit on how many students the card may serve.
    const a = build();
    const b = build();

    await grant(a.tx, 'usr_a');
    await grant(b.tx, 'usr_b');

    expect(a.created[0].idempotencyKey).toBe(`partcode:${CODE_ID}:usr_a`);
    expect(b.created[0].idempotencyKey).toBe(`partcode:${CODE_ID}:usr_b`);
    expect(a.created[0].idempotencyKey).not.toBe(b.created[0].idempotencyKey);
  });

  it('records the card as the sole provenance', async () => {
    // The CHECK constraint requires exactly one of walletTransactionId /
    // accessCodeId. The wallet is not involved in a card purchase at all, so the
    // column is left out of the insert entirely and defaults to null.
    const { tx, created } = build();

    await grant(tx, 'usr_a');

    expect(created[0].accessCodeId).toBe(CODE_ID);
    expect(created[0]).not.toHaveProperty('walletTransactionId');
  });

  it('carries no wallet transaction for any student', async () => {
    // Explicit because `walletTransactionId` is still `@unique` and still
    // nullable history. Nothing on this path may ever set it, or the second
    // student's insert would collide on that index instead.
    for (const userId of ['usr_a', 'usr_b', 'usr_c']) {
      const { tx, created } = build();
      await grant(tx, userId);
      expect(created[0]).not.toHaveProperty('walletTransactionId');
    }
  });
});

describe('one student, many attempts', () => {
  it('does not write a purchase when the part is already held', async () => {
    const { tx, created } = build({ alreadyHeld: true });

    const result = await grant(tx, 'usr_a');

    expect(result).toMatchObject({ alreadyHeld: true, acquisitionId: null });
    expect(created).toHaveLength(0);
  });

  it('reports the original entitlement rather than minting a new one', async () => {
    const { tx } = build({ alreadyHeld: true });

    const result = await grant(tx, 'usr_a');

    expect(result?.entitlementId).toBe('ent_live');
  });

  it('reinstate a revoked entitlement with a new acquisition', async () => {
    // A revocation frees the part to be granted again. The history is kept, so
    // the student ends up holding one entitlement pointing at the newest
    // purchase rather than two entitlements.
    const { tx, created } = build({ revoked: true });

    const result = await grant(tx, 'usr_a');

    expect(result).toMatchObject({ alreadyHeld: false });
    expect(created).toHaveLength(1);
    expect(created[0].idempotencyKey).toBe(`partcode:${CODE_ID}:usr_a`);
  });
});

describe('what the purchase records', () => {
  it('freezes the teacher and platform split at redemption', async () => {
    // The share percentage can change later; the recorded split cannot, or a
    // report of what was earned becomes a report of what is configured now.
    const { tx, created } = build();

    await grant(tx, 'usr_a');

    expect(created[0]).toMatchObject({ teacherId: 'tch_1' });
    expect(created[0].sharePercent).not.toBeNull();
    expect(created[0].teacherAmount).not.toBeNull();
    expect(created[0].platformAmount).not.toBeNull();
  });

  it('snapshots the titles and sections the card covered', async () => {
    const { tx, created } = build();

    await grant(tx, 'usr_a', ['sec_1', 'sec_2']);

    expect(created[0]).toMatchObject({
      partTitleSnapshot: 'Cardiovascular system',
      courseTitleSnapshot: 'Human Anatomy',
      sectionIdsSnapshot: ['sec_1', 'sec_2'],
    });
  });

  it('records nothing when the part has been hard-deleted', async () => {
    // A card sold against a part that no longer exists still unlocks its frozen
    // sections. There is simply no part left to attach an entitlement to, and a
    // student holding a paid-for card must not be blocked by that.
    const tx = {
      coursePart: { findFirst: jest.fn(async () => null) },
      coursePartEntitlement: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
      },
      coursePrice: { findFirst: jest.fn() },
      coursePartPurchase: { create: jest.fn() },
    };

    await expect(grant(tx as never, 'usr_a')).resolves.toBeNull();
  });
});

describe('entitlement source', () => {
  it('marks the entitlement as code-sourced', async () => {
    const { tx } = build();
    let captured: unknown;

    (
      tx as unknown as {
        coursePartEntitlement: { upsert: (args: unknown) => Promise<unknown> };
      }
    ).coursePartEntitlement.upsert = jest.fn(async (args: unknown) => {
      captured = args;
      return { id: 'ent_new' };
    });

    await grant(tx, 'usr_a');

    expect(captured).toMatchObject({
      create: { source: PartEntitlementSource.CODE },
      update: { source: PartEntitlementSource.CODE, revokedAt: null },
    });
  });
});