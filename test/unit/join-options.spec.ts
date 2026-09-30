import { ContentStatus, EnrollmentMethod, PartPricingModel } from '@prisma/client';

import { CoursePartsService } from '../../src/modules/course-parts/course-parts.service';

/**
 * The JOIN sheet.
 *
 * The student taps JOIN and must see, in one place, what buying the whole
 * course costs versus buying one part, what they already hold, and how they
 * can pay. Three properties matter enough to pin:
 *
 *   1. The whole-course option is ALWAYS offered, even when the course has
 *      parts. A course with parts can still be bought entire, and that is
 *      usually the better deal; hiding it would push students toward the more
 *      expensive path by omission.
 *   2. `methods.wallet` is false. The wallet belongs to the Library and a
 *      course must never debit it. Reported rather than omitted so the app
 *      never infers it.
 *   3. `methods.onlinePayment` follows configuration, not code. It ships off,
 *      and the payment implementation stays intact behind it.
 */

interface Options {
  provider?: string;
  isFree?: boolean;
  coursePriceAmount?: string | null;
  parts?: { id: string; sortOrder: number; pricePercent: string | null }[];
  ownedPartIds?: string[];
  coversAllSections?: boolean;
  /** What the course is configured to accept. */
  enrollmentMethods?: EnrollmentMethod[];
}

function build(options: Options = {}) {
  const parts = (options.parts ?? [
    { id: 'part_1', sortOrder: 1, pricePercent: '60.00' },
    { id: 'part_2', sortOrder: 2, pricePercent: '40.00' },
  ]).map((p) => ({
    id: p.id,
    title: `Part ${p.sortOrder}`,
    titleAr: null,
    description: null,
    sortOrder: p.sortOrder,
    pricingModel: PartPricingModel.PERCENTAGE,
    pricePercent: p.pricePercent === null ? null : { toString: () => p.pricePercent },
    priceAmount: null,
    currency: 'EGP',
    thumbnailKey: null,
    sections: [],
  }));

  const prisma = {
    course: {
      findFirst: jest.fn(async (_args: { where: unknown; select: unknown }) => ({
        id: 'crs_1',
        title: 'Anatomy',
        titleAr: null,
        status: ContentStatus.PUBLISHED,
        isFree: options.isFree ?? false,
        thumbnailKey: null,
        enrollmentMethods:
          options.enrollmentMethods ?? [EnrollmentMethod.CODE, EnrollmentMethod.PAYMENT],
      })),
    },
    coursePart: {
      findMany: jest.fn(async (_args: { where: unknown; orderBy: unknown; select: unknown }) =>
        parts,
      ),
    },
    coursePrice: {
      findFirst: jest.fn(async (_args: unknown) =>
        options.coursePriceAmount === undefined
          ? { amount: { toString: () => '1000.00' } }
          : options.coursePriceAmount === null
            ? null
            : { amount: { toString: () => options.coursePriceAmount } },
      ),
    },
    coursePartEntitlement: {
      findMany: jest.fn(async (_args: { where: unknown; select: unknown }) =>
        (options.ownedPartIds ?? []).map((id) => ({
          coursePartId: id,
          grantedAt: new Date('2026-01-01'),
        })),
      ),
    },
    enrollment: {
      findUnique: jest.fn(async (_args: { where: unknown; select: unknown }) => ({
        coversAllSections: options.coversAllSections ?? false,
        state: 'ACTIVE',
      })),
    },
  };

  const config = {
    get: jest.fn((key: string) =>
      key === 'payment.provider' ? (options.provider ?? 'none') : undefined,
    ),
  };

  // Storage was added for thumbnail URLs. It echoes the key back so an
  // assertion about which image was chosen stays readable.
  const storage = {
    publicAssetUrl: jest.fn(async (key: string | null) => (key ? `https://cdn/${key}` : null)),
  };

  // The access service's real seams, not a hand-rolled copy of its rules:
  // `joinOptions` composes `decide()` + `toCourseAccess()` precisely so the
  // JOIN sheet and the course screen cannot disagree, and stubbing those two
  // is what keeps this test honest about that. PAYMENT is filtered out here
  // the way the real service filters it when no provider is configured.
  const access = {
    decide: jest.fn((_status: unknown, _enrollment: unknown) => ({ state: 'NOT_ENROLLED' })),
    toCourseAccess: jest.fn(
      (
        _decision: unknown,
        configured: EnrollmentMethod[],
        _status: unknown,
      ) => ({
        availableMethods:
          (options.provider ?? 'none') === 'none'
            ? configured.filter((m) => m !== EnrollmentMethod.PAYMENT)
            : configured,
      }),
    ),
  };

  const service = new CoursePartsService(
    prisma as never,
    { record: jest.fn(async (_e: Record<string, unknown>) => undefined) } as never,
    access as never,
    config as never,
    storage as never,
  );

  return { service, prisma, config };
}

describe('the whole-course option', () => {
  it('is offered even when the course has parts', async () => {
    const { service } = build();
    const out = await service.joinOptions('crs_1', 'usr_1');

    expect(out.hasParts).toBe(true);
    expect(out.fullCourse).toMatchObject({ price: 1000, purchasable: true, owned: false });
    expect(out.parts).toHaveLength(2);
  });

  it('is marked owned, not purchasable, once the student holds the course', async () => {
    const { service } = build({ coversAllSections: true });
    const out = await service.joinOptions('crs_1', 'usr_1');

    expect(out.fullCourse).toMatchObject({ owned: true, purchasable: false });
    expect(out.ownsAllParts).toBe(true);
  });

  it('costs nothing for a free course', async () => {
    const { service } = build({ isFree: true });
    const out = await service.joinOptions('crs_1', 'usr_1');

    expect(out.fullCourse).toMatchObject({ price: 0, isFree: true, purchasable: true });
  });

  it('is not purchasable when the course has no current price', async () => {
    // Offering a purchase with no price produces a card the student cannot
    // use, and a support ticket.
    const { service } = build({ coursePriceAmount: null });
    const out = await service.joinOptions('crs_1', 'usr_1');

    expect(out.fullCourse).toMatchObject({ price: null, purchasable: false });
  });
});

describe('per-part options', () => {
  it('carry the allocated price for each part', async () => {
    const { service } = build();
    const out = await service.joinOptions('crs_1', 'usr_1');

    // 60/40 of 1000. The allocation is the existing implementation's, reused
    // rather than reimplemented.
    expect(out.parts.map((p) => p.price)).toEqual([600, 400]);
  });

  it('mark what the student already owns, and why', async () => {
    const { service } = build({ ownedPartIds: ['part_1'] });
    const out = await service.joinOptions('crs_1', 'usr_1');

    expect(out.parts[0]).toMatchObject({
      owned: true,
      ownedVia: 'PART_PURCHASE',
      purchasable: false,
    });
    expect(out.parts[1]).toMatchObject({ owned: false, purchasable: true });
  });

  it('read as owned via the full course when the enrollment covers everything', async () => {
    // Otherwise a student who bought the whole course would be invited to buy
    // parts they already hold.
    const { service } = build({ coversAllSections: true });
    const out = await service.joinOptions('crs_1', 'usr_1');

    expect(out.parts.every((p) => p.owned)).toBe(true);
    expect(out.parts[0]?.ownedVia).toBe('FULL_COURSE');
  });

  it('are absent, without erroring, for a course sold only as a whole', async () => {
    const { service } = build({ parts: [] });
    const out = await service.joinOptions('crs_1', 'usr_1');

    expect(out.hasParts).toBe(false);
    expect(out.parts).toEqual([]);
    expect(out.fullCourse.purchasable).toBe(true);
  });
});

describe('the enrolment methods the sheet may render', () => {
  it('come from the access service, not from this endpoint\u2019s own rules', async () => {
    // The whole reason `joinOptions` composes the access service rather than
    // deciding for itself: two places computing "can this be joined" is two
    // places to disagree.
    const { service } = build({
      enrollmentMethods: [EnrollmentMethod.CODE, EnrollmentMethod.ADMIN_APPROVAL],
    });

    const out = await service.joinOptions('crs_1', 'usr_1');
    expect(out.enrollmentMethods).toEqual([
      EnrollmentMethod.CODE,
      EnrollmentMethod.ADMIN_APPROVAL,
    ]);
  });

  it('exclude PAYMENT while no provider is configured', async () => {
    const { service } = build({
      provider: 'none',
      enrollmentMethods: [EnrollmentMethod.CODE, EnrollmentMethod.PAYMENT],
    });

    const out = await service.joinOptions('crs_1', 'usr_1');
    expect(out.enrollmentMethods).toEqual([EnrollmentMethod.CODE]);
  });

  it('include it again once one is', async () => {
    const { service } = build({
      provider: 'paymob',
      enrollmentMethods: [EnrollmentMethod.CODE, EnrollmentMethod.PAYMENT],
    });

    const out = await service.joinOptions('crs_1', 'usr_1');
    expect(out.enrollmentMethods).toContain(EnrollmentMethod.PAYMENT);
  });

  it('carry FREE for a free course, so one tap can join it', async () => {
    const { service } = build({
      isFree: true,
      enrollmentMethods: [EnrollmentMethod.FREE],
    });

    const out = await service.joinOptions('crs_1', 'usr_1');
    expect(out.enrollmentMethods).toEqual([EnrollmentMethod.FREE]);
    expect(out.fullCourse).toMatchObject({ isFree: true, price: 0 });
  });
});

describe('available mechanisms', () => {
  it('offer the access card and never the wallet', async () => {
    // The wallet is the Library's. A course debiting it would cross the two
    // financial systems the schema keeps apart.
    const { service } = build();
    const out = await service.joinOptions('crs_1', 'usr_1');

    expect(out.methods).toMatchObject({ accessCode: true, wallet: false });
  });

  it('report online payment as off while no provider is configured', async () => {
    const { service } = build({ provider: 'none' });
    const out = await service.joinOptions('crs_1', 'usr_1');

    expect(out.methods.onlinePayment).toBe(false);
  });

  it('report it as on the moment a provider is configured', async () => {
    // The implementation is dormant, not deleted: this flag is the whole
    // switch, so re-enabling it later is configuration rather than code.
    const { service } = build({ provider: 'paymob' });
    const out = await service.joinOptions('crs_1', 'usr_1');

    expect(out.methods.onlinePayment).toBe(true);
  });
});
