import 'reflect-metadata';

import { CodeTargetType, UserRole } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { AppException } from '../../src/common/errors/app.exception';
import { GenerateCodesDto } from '../../src/modules/codes/codes.controller';
import { CodesService } from '../../src/modules/codes/codes.service';

/**
 * The amount collected per access card.
 *
 * Revenue from a card is what was actually collected for it, recorded when it
 * is issued and recognised when it is redeemed. Before this, an access card
 * carried at most a printed "card price" for reporting, and most carried
 * nothing — so a card sale could not be reported at all.
 *
 * The rule: every new access card has exactly one of
 *   - `amountCollected` > 0  → stored in `actualPaidAmount`, revenue on redemption;
 *   - `free: true`           → stored as 0, an activation and never revenue.
 * Neither, or both, is refused — never guessed from a price.
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

describe('GenerateCodesDto: amountCollected and free', () => {
  it.each([
    ['a whole amount', { amountCollected: 600 }],
    ['an amount with piastres', { amountCollected: 149.5 }],
    ['a numeric string from a form', { amountCollected: '600' }],
    ['the explicit free flag', { free: true }],
    ['free: false beside an amount', { free: false, amountCollected: 600 }],
  ])('accepts %s', async (_label, extra) => {
    expect(await errorsFor({ ...BASE, ...extra })).toEqual([]);
  });

  it.each([
    ['zero (a free card must say so)', { amountCollected: 0 }, 'amountCollected'],
    ['a negative amount', { amountCollected: -1 }, 'amountCollected'],
    ['three decimal places', { amountCollected: 10.005 }, 'amountCollected'],
    ['more than the money ceiling', { amountCollected: 1_000_000.01 }, 'amountCollected'],
    ['text', { amountCollected: 'six hundred' }, 'amountCollected'],
    ['a non-boolean free flag', { free: 'yes' }, 'free'],
  ])('refuses %s', async (_label, extra, field) => {
    expect(await errorsFor({ ...BASE, ...extra })).toContain(field);
  });
});

describe('CodesService.generateBatch records the amount collected', () => {
  function build() {
    const batches: Record<string, unknown>[] = [];
    const codes: Record<string, unknown>[] = [];

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
    // The target lookup is covered elsewhere; this suite is about money.
    jest.spyOn(service as never, 'resolveTarget').mockResolvedValue({
      courseId: 'crs_1',
      sectionId: null,
      teacherId: null,
      coursePartId: null,
      name: 'Anatomy I',
      grantedSectionIds: ['sec_1'],
      grantedCourseIds: [],
    } as never);

    return { service, prisma, audit, batches, codes };
  }

  it('stores the amount on every card and on the batch, beside — not instead of — the card price', async () => {
    const { service, audit, batches, codes } = build();

    const result = await service.generateBatch(
      { ...BASE, amountCollected: 600, priceAmount: 1000 },
      ADMIN,
    );

    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ actualPaidAmount: '600.00', priceAmount: 1000 });
    expect(codes).toHaveLength(3);
    for (const code of codes) {
      expect(code).toMatchObject({ actualPaidAmount: '600.00', priceAmount: 1000 });
    }
    expect(result).toMatchObject({ amountCollected: 600, free: false, created: 3 });

    const recorded = (
      audit.record.mock.calls[0] as unknown as [{ after: Record<string, unknown> }]
    )[0];
    expect(recorded.after).toMatchObject({ amountCollected: 600, free: false });
  });

  it('keeps piastres exact', async () => {
    const { service, codes } = build();
    await service.generateBatch({ ...BASE, count: 1, amountCollected: 149.5 }, ADMIN);
    expect(codes[0]).toMatchObject({ actualPaidAmount: '149.50' });
  });

  it('stores a free card as 0, never null', async () => {
    const { service, batches, codes } = build();

    const result = await service.generateBatch({ ...BASE, free: true }, ADMIN);

    expect(batches[0]).toMatchObject({ actualPaidAmount: '0.00' });
    for (const code of codes) expect(code).toMatchObject({ actualPaidAmount: '0.00' });
    expect(result).toMatchObject({ amountCollected: 0, free: true });
  });

  it.each([
    ['neither an amount nor free', {}],
    ['both an amount and free', { free: true, amountCollected: 600 }],
    ['an amount of 0 without free', { amountCollected: 0 }],
    ['free: false and no amount', { free: false }],
    ['three decimal places', { amountCollected: 10.005 }],
  ])('refuses %s, before writing anything', async (_label, extra) => {
    const { service, prisma, audit } = build();

    await expect(
      service.generateBatch({ ...BASE, ...extra }, ADMIN),
    ).rejects.toBeInstanceOf(AppException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('never copies the card price into the amount collected', async () => {
    const { service, prisma } = build();

    // A printed price is not a record of what was collected.
    await expect(
      service.generateBatch({ ...BASE, priceAmount: 1000 }, ADMIN),
    ).rejects.toBeInstanceOf(AppException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
