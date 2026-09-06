import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Prisma client wrapper.
 *
 * Two behaviours worth calling out:
 *
 *  1. **Soft-delete is opt-in, not automatic.** A global "always filter
 *     deletedAt" extension is tempting but dangerous here: admin and audit
 *     views legitimately need deleted rows, and a silent global filter makes
 *     "why is this row missing" impossible to debug. Instead `notDeleted` is
 *     an explicit, greppable helper used at each call site.
 *
 *  2. **Slow-query logging.** Anything over 300ms is logged with its SQL in
 *     non-production, which is how N+1s get caught before they reach staging.
 */
@Injectable()
export class PrismaService
  extends PrismaClient<Prisma.PrismaClientOptions, 'query' | 'warn' | 'error'>
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    const isProduction = config.get<string>('app.env') === 'production';

    super({
      datasources: { db: { url: config.getOrThrow<string>('DATABASE_URL') } },
      log: isProduction
        ? [
            { emit: 'event', level: 'warn' },
            { emit: 'event', level: 'error' },
          ]
        : [
            { emit: 'event', level: 'query' },
            { emit: 'event', level: 'warn' },
            { emit: 'event', level: 'error' },
          ],
      errorFormat: isProduction ? 'minimal' : 'pretty',
    });

    if (!isProduction) {
      this.$on('query', (event) => {
        if (event.duration >= 300) {
          this.logger.warn(
            `Slow query ${event.duration}ms: ${event.query.slice(0, 400)}`,
          );
        }
      });
    }

    this.$on('warn', (e) => this.logger.warn(e.message));
    this.$on('error', (e) => this.logger.error(e.message));
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Liveness probe used by the health module. */
  async ping(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Wipes the database. Guarded so it can only ever run against a test
   * database — a mistaken call in development would be bad, in production
   * catastrophic.
   */
  async truncateAllForTests(): Promise<void> {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('truncateAllForTests() is only available with NODE_ENV=test');
    }
    if (!/test/i.test(process.env.DATABASE_URL ?? '')) {
      throw new Error('Refusing to truncate: DATABASE_URL does not look like a test DB');
    }

    const tables = await this.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'
    `;

    const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
    if (list) {
      await this.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    }
  }
}

/** Explicit soft-delete filter, used at every call site that needs it. */
export const notDeleted = { deletedAt: null } as const;

/** Transaction options tuned for the multi-row money paths. */
export const MONEY_TX_OPTIONS: {
  maxWait: number;
  timeout: number;
  isolationLevel: Prisma.TransactionIsolationLevel;
} = {
  maxWait: 5_000,
  timeout: 15_000,
  // Serializable is the right default for enrollment + payment + code
  // redemption: they read-then-write shared counters, and a lost update there
  // means a code redeemed twice or a duplicate enrollment.
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
};

export type PrismaTransaction = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;
