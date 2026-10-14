import 'reflect-metadata';

import { CodeTargetType, UserRole } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { AppException } from '../../src/common/errors/app.exception';
import { GenerateCodesDto } from '../../src/modules/codes/codes.controller';
import { CodesService } from '../../src/modules/codes/codes.service';

/**
 * The price an access card is issued at.
 *
 * `priceAmount` is the card's price: the revenue figure when the card is first
 * redeemed, 0 for a free card, null when none was given (reported as "not
 * recorded"). It is optional, exactly as it always was, and it never affects
 * redemption. It is taken only from the request — never copied from a course
 * or part catalogue price.
 *
 * `amountCollected` / `free` are deprecated aliases for one release (the
 * dashboard deployed on 2026-10-14 sends them). They map onto `priceAmount`
 * and nothing else: `actualPaidAmount` is never written for an access card.
 */

const ADMIN = { id: 'usr_admin', role: UserRole.ADMIN };
const BASE = { targetType: CodeTargetType.COURSE, courseId: 'crs_1', count: 3 };

/** The same options as the app's global ValidationPipe. */
async function errorsFor(plain: Record<string, unknown>) {
  const instance = plainToInstance(GenerateCodesDto, plain);
  const errors = await validate(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((e) => e.property);
}

describe('GenerateCodesDto: the card price', () => {
  it.each([
    ['a price', { priceAmount: 600 }],
    ['a numeric string from a form', { priceAmount: '600' }],
    ['0, a free card', { priceAmount: 0 }],
    ['no price at all, as before', {}],
    ['the deprecated amountCollected alias', { amountCollected: 149.5 }],
    ['the deprecated free alias', { free: true }],
  ])('accepts %s', async (_label, extra) => {
    expect(await errorsFor({ ...BASE, ...extra })).toEqual([]);
  });

  it.each([
    ['a negative price', { priceAmount: -1 }, 'priceAmount'],
    ['a fractional price (whole EGP, as before)', { priceAmount: 10.5 }, 'priceAmount'],
    ['a price above the ceiling', { priceAmount: 1_000_001 }, 'priceAmount'],
    ['text', { priceAmount: 'six hundred' }, 'priceAmount'],
    ['a non-boolean free flag', { free: 'yes' }, 'free'],
  ])('refuses %s', async (_label, extra, field) => {
    expect(await errorsFor({ ...BASE, ...extra })).toContain(field);
  });
});

describe('CodesService.generateBatch stores the issued price', () => {
  function build(targetType: CodeTargetType = CodeTargetType.COURSE) {
    const batches: Record<string, unknown>[] = [];
    const codes: Record<string, unknown>[] = [];

    // No catalogue model exists on this client: if generation ever read a
    // course or part price to fill in the card's, the test would throw.
    const tx = {
      codeBatch: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          batches.push(data);
          return { id: 'batch_1', name: data.name ?? null };
        }),
      },
      accessCode: {
        createMany: jest.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
          codes.push(...data);
          return { count: data.length };
        }),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const audit = { record: jest.fn(async () => undefined) };

    const service = new CodesService(prisma as never, audit as never, {} as never);
    // Target resolution is covered elsewhere; this suite is about the price.
    jest.spyOn(service as never, 'resolveTarget').mockResolvedValue({
      courseId: targetType === CodeTargetType.TEACHER ? null : 'crs_1',
      sectionId: targetType === CodeTargetType.SECTION ? 'sec_1' : null,
      teacherId: targetType === CodeTargetType.TEACHER ? 'tch_1' : null,
      coursePartId: targetType === CodeTargetType.PART ? 'part_1' : null,
      name: 'Anatomy I',
      grantedSectionIds: ['sec_1'],
      grantedCourseIds: targetType === CodeTargetType.TEACHER ? ['crs_1', 'crs_2'] : [],
    } as never);

    return { service, prisma, audit, batches, codes };
  }

  it('stores the price on every card and on the batch, and in the audit and response', async () => {
    const { service, audit, batches, codes } = build();

    const result = await service.generateBatch({ ...BASE, priceAmount: 600 }, ADMIN);

    expect(batches[0]).toMatchObject({ priceAmount: '600.00' });
    expect(codes).toHaveLength(3);
    for (const code of codes) expect(code).toMatchObject({ priceAmount: '600.00' });
    expect(result).toMatchObject({ priceAmount: 600, created: 3 });

    const recorded = (
      audit.record.mock.calls[0] as unknown as [{ after: Record<string, unknown> }]
    )[0];
    expect(recorded.after).toMatchObject({ priceAmount: 600 });
  });

  it('never writes actualPaidAmount on an access card', async () => {
    const { service, batches, codes } = build();
    await service.generateBatch({ ...BASE, priceAmount: 600 }, ADMIN);
    await service.generateBatch({ ...BASE, amountCollected: 300 }, ADMIN);
    await service.generateBatch({ ...BASE, free: true }, ADMIN);

    for (const row of [...batches, ...codes]) expect(row).not.toHaveProperty('actualPaidAmount');
  });

  it.each([
    CodeTargetType.COURSE,
    CodeTargetType.PART,
    CodeTargetType.SECTION,
    CodeTargetType.TEACHER,
  ])('stores the price the same way for a %s card', async (targetType) => {
    const { service, batches, codes } = build(targetType);
    await service.generateBatch({ ...BASE, targetType, count: 1, priceAmount: 450 }, ADMIN);
    expect(batches[0]).toMatchObject({ targetType, priceAmount: '450.00' });
    expect(codes[0]).toMatchObject({ targetType, priceAmount: '450.00' });
  });

  it('stores a free card as 0, never null', async () => {
    const { service, codes } = build();
    const result = await service.generateBatch({ ...BASE, priceAmount: 0 }, ADMIN);
    for (const code of codes) expect(code).toMatchObject({ priceAmount: '0.00' });
    expect(result).toMatchObject({ priceAmount: 0 });
  });

  it('still issues a card without a price, stored as null (not recorded), as before', async () => {
    const { service, batches, codes } = build();
    const result = await service.generateBatch({ ...BASE }, ADMIN);
    expect(batches[0]).toMatchObject({ priceAmount: null });
    for (const code of codes) expect(code).toMatchObject({ priceAmount: null });
    expect(result).toMatchObject({ priceAmount: null, created: 3 });
  });

  describe('deprecated aliases from the 2026-10-14 dashboard', () => {
    it('maps amountCollected onto priceAmount, piastres exact', async () => {
      const { service, codes } = build();
      await service.generateBatch({ ...BASE, count: 1, amountCollected: 149.5 }, ADMIN);
      expect(codes[0]).toMatchObject({ priceAmount: '149.50' });
    });

    it('maps free: true onto a price of 0', async () => {
      const { service, codes } = build();
      await service.generateBatch({ ...BASE, count: 1, free: true }, ADMIN);
      expect(codes[0]).toMatchObject({ priceAmount: '0.00' });
    });

    it('accepts priceAmount and an agreeing alias together', async () => {
      const { service, codes } = build();
      await service.generateBatch(
        { ...BASE, count: 1, priceAmount: 600, amountCollected: 600 },
        ADMIN,
      );
      await service.generateBatch({ ...BASE, count: 1, priceAmount: 0, free: true }, ADMIN);
      expect(codes.map((c) => c.priceAmount)).toEqual(['600.00', '0.00']);
    });

    it.each([
      ['a price that disagrees with amountCollected', { priceAmount: 600, amountCollected: 300 }],
      ['free together with a price above 0', { free: true, priceAmount: 600 }],
      ['free together with amountCollected', { free: true, amountCollected: 300 }],
    ])('refuses %s, before writing anything', async (_label, extra) => {
      const { service, prisma, audit } = build();

      await expect(
        service.generateBatch({ ...BASE, ...extra }, ADMIN),
      ).rejects.toBeInstanceOf(AppException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });
});
