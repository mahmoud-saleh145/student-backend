import { AuthService } from '../../src/modules/auth/auth.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { UsersService } from '../../src/modules/users/users.service';

/**
 * Push-token ownership and volume.
 *
 * Two separate problems are covered here.
 *
 * 1. **Registration was unbounded.** Nothing capped how many active tokens one
 *    account could hold, and every send fans out across the whole active set.
 *    One account holding thousands of tokens turns a single announcement into
 *    thousands of Expo messages — billed to us, and throttled by Expo, so the
 *    notifications for everyone else are what suffers.
 *
 * 2. **Revocation was partial.** "Sign out everywhere" revoked every session,
 *    refresh token and playback ticket but left the push tokens live, so a lost
 *    or compromised handset kept receiving announcements after the account had
 *    been locked out. Account deletion had the same gap.
 */

interface Row {
  id: string;
  userId: string;
  token: string;
  platform: string;
  provider: string;
  deviceKey: string | null;
  isActive: boolean;
  lastUsedAt: Date | null;
  failureCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * An in-memory stand-in for the push_tokens table.
 *
 * `updatedAt` advances on every write, the way Prisma's `@updatedAt` does, so
 * "most recently seen" is something the tests can reason about instead of
 * something they have to hope for.
 */
function buildStore() {
  const rows: Row[] = [];
  let seq = 0;
  let clock = 0;

  const tick = () => new Date(1_700_000_000_000 + ++clock * 1_000);

  const matches = (row: Row, where: Record<string, any>): boolean => {
    if (where.userId !== undefined && row.userId !== where.userId) return false;
    if (where.isActive !== undefined && row.isActive !== where.isActive) return false;
    if (where.id !== undefined) {
      const { notIn, in: includes } = where.id;
      if (notIn && notIn.includes(row.id)) return false;
      if (includes && !includes.includes(row.id)) return false;
    }
    return true;
  };

  const pushToken = {
    upsert: jest.fn(async ({ where, create, update }: any) => {
      const existing = rows.find((r) => r.token === where.token);
      if (existing) {
        Object.assign(existing, update, { updatedAt: tick() });
        return existing;
      }
      const row: Row = {
        provider: 'expo',
        deviceKey: null,
        isActive: true,
        lastUsedAt: null,
        failureCount: 0,
        ...create,
        id: `pt_${++seq}`,
        createdAt: tick(),
        updatedAt: tick(),
      };
      rows.push(row);
      return row;
    }),

    findMany: jest.fn(async ({ where, take, select }: any) => {
      const found = rows
        .filter((r) => matches(r, where))
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(0, take ?? undefined);
      return found.map((r) => (select ? { id: r.id } : r));
    }),

    updateMany: jest.fn(async ({ where, data }: any) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    }),
  };

  const prisma = {
    pushToken,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };

  return {
    prisma,
    rows,
    /** Active tokens for one account, most recently seen first. */
    activeFor: (userId: string) =>
      rows
        .filter((r) => r.userId === userId && r.isActive)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .map((r) => r.token),
  };
}

const build = (cap?: number) => {
  const store = buildStore();
  const config = {
    get: (key: string) => (key === 'PUSH_MAX_ACTIVE_TOKENS_PER_USER' ? cap : undefined),
  };
  const service = new NotificationsService(
    store.prisma as never,
    { add: jest.fn() } as never,
    config as never,
  );
  return { ...store, service };
};

const register = (
  service: NotificationsService,
  userId: string,
  token: string,
  deviceKey?: string,
) =>
  service.registerPushToken({
    userId,
    token,
    platform: 'android',
    provider: 'expo',
    deviceKey: deviceKey ?? null,
  });

describe('push token registration', () => {
  it('stores a first token as active and stamps when it was last used', async () => {
    const { service, rows } = build();

    await register(service, 'usr_1', 'ExponentPushToken[aaa]');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: 'usr_1',
      token: 'ExponentPushToken[aaa]',
      isActive: true,
      failureCount: 0,
    });
    expect(rows[0].lastUsedAt).toBeInstanceOf(Date);
  });

  it('re-points a token that moves to another account instead of duplicating it', async () => {
    // A shared handset, or an account switch. Leaving the old owner attached
    // means they keep receiving the new student's notifications.
    const { service, rows, activeFor } = build();

    await register(service, 'usr_1', 'ExponentPushToken[shared]', 'dev_1');
    await register(service, 'usr_2', 'ExponentPushToken[shared]', 'dev_1');

    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe('usr_2');
    expect(activeFor('usr_1')).toEqual([]);
  });

  it('revives a token that had been retired, and clears its failure count', async () => {
    const { service, rows, activeFor } = build(2);

    await register(service, 'usr_1', 'tok_a');
    await register(service, 'usr_1', 'tok_b');
    await register(service, 'usr_1', 'tok_c'); // retires tok_a
    expect(activeFor('usr_1')).toEqual(['tok_c', 'tok_b']);

    rows[0].failureCount = 3;
    await register(service, 'usr_1', 'tok_a');

    expect(rows[0].failureCount).toBe(0);
    expect(rows[0].isActive).toBe(true);
    expect(activeFor('usr_1')).toEqual(['tok_a', 'tok_c']);
  });

  describe('the per-account ceiling', () => {
    it('keeps only the most recently seen tokens once the cap is passed', async () => {
      const { service, activeFor } = build(2);

      for (const token of ['tok_a', 'tok_b', 'tok_c', 'tok_d']) {
        await register(service, 'usr_1', token);
      }

      expect(activeFor('usr_1')).toEqual(['tok_d', 'tok_c']);
    });

    it('honours a configured cap', async () => {
      const { service, activeFor } = build(3);

      for (const token of ['a', 'b', 'c', 'd', 'e']) {
        await register(service, 'usr_1', token);
      }

      expect(activeFor('usr_1')).toHaveLength(3);
      expect(activeFor('usr_1')).not.toContain('a');
      expect(activeFor('usr_1')).not.toContain('b');
    });

    it('falls back to a bounded default when the setting is absent', async () => {
      // A test or a misconfigured module must not get an unbounded set.
      const { service, activeFor } = build(undefined);

      for (let i = 0; i < 12; i += 1) {
        await register(service, 'usr_1', `tok_${i}`);
      }

      expect(activeFor('usr_1')).toHaveLength(8);
    });

    it('repairs an over-cap set left behind, reading no more than the cap', async () => {
      // The realistic bad state: a client registered thousands of tokens while
      // registration was unbounded. Repair has to be cheap even then, so the
      // prune reads only the rows it intends to keep and deactivates by
      // exclusion rather than loading the whole tail.
      const { service, prisma, rows, activeFor } = build(3);

      for (let i = 0; i < 500; i += 1) {
        rows.push({
          id: `legacy_${i}`,
          userId: 'usr_1',
          token: `legacy_${i}`,
          platform: 'android',
          provider: 'expo',
          deviceKey: null,
          isActive: true,
          lastUsedAt: null,
          failureCount: 0,
          createdAt: new Date(1_600_000_000_000 + i),
          updatedAt: new Date(1_600_000_000_000 + i),
        });
      }
      expect(rows.filter((r) => r.isActive)).toHaveLength(500);

      await register(service, 'usr_1', 'fresh_token');

      expect(activeFor('usr_1')).toHaveLength(3);
      expect(activeFor('usr_1')).toContain('fresh_token');

      const pruneRead = prisma.pushToken.findMany.mock.calls.at(-1)?.[0];
      expect(pruneRead.take).toBe(3);
    });

    it('does not retire another account’s tokens', async () => {
      // Pruning is scoped by userId. Without that, one user flooding the
      // endpoint would silently switch off push for everyone.
      const { service, activeFor } = build(1);

      await register(service, 'usr_1', 'a');
      await register(service, 'usr_2', 'b');
      await register(service, 'usr_1', 'c');

      expect(activeFor('usr_1')).toEqual(['c']);
      expect(activeFor('usr_2')).toEqual(['b']);
    });

    it('keeps each device’s token when an account legitimately has several', async () => {
      const { service, activeFor } = build(3);

      await register(service, 'usr_1', 'phone', 'dev_phone');
      await register(service, 'usr_1', 'tablet', 'dev_tablet');

      expect(activeFor('usr_1').sort()).toEqual(['phone', 'tablet']);
    });
  });

  describe('deactivation', () => {
    it('only lets the owner deactivate a token', async () => {
      // Otherwise any authenticated student could mute any other student's
      // notifications by guessing their token.
      const { service, prisma } = build();
      await register(service, 'usr_1', 'tok_1');

      await service.unregisterPushToken('usr_2', 'tok_1');

      expect(prisma.pushToken.updateMany).toHaveBeenCalledWith({
        where: { token: 'tok_1', userId: 'usr_2' },
        data: { isActive: false },
      });
    });
  });
});

describe('signing out everywhere', () => {
  const buildAuth = () => {
    const pushToken = { updateMany: jest.fn(async () => ({ count: 2 })) };
    const session = { updateMany: jest.fn(async () => ({ count: 3 })) };
    const refreshToken = { updateMany: jest.fn(async () => ({ count: 3 })) };
    const playbackTicket = { updateMany: jest.fn(async () => ({ count: 1 })) };

    const prisma = {
      session,
      refreshToken,
      playbackTicket,
      pushToken,
      $transaction: jest.fn(async (ops: unknown[]) =>
        // Prisma resolves the batch to the array of per-operation results, and
        // `logoutAll` destructures the session count out of position 0. A fake
        // that returned the operations themselves would type-check and lie.
        Promise.all(ops),
      ),
    };

    const service = new AuthService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { getOrThrow: () => ({}) } as never,
    );

    return { service, pushToken, session, refreshToken, playbackTicket };
  };

  it('revokes push tokens along with the sessions', async () => {
    // Revoking every session while push delivery stays live is a half
    // revocation: the point of this call is a lost or compromised handset, and
    // that handset is exactly the one still receiving announcements.
    const { service, pushToken } = buildAuth();

    const result = await service.logoutAll('usr_1');

    expect(pushToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'usr_1', isActive: true },
      data: { isActive: false },
    });
    expect(result.sessions).toBe(3);
  });

  it('does not drop any revocation the call already made', async () => {
    // The push addition must be additive. A refactor that replaced the batch
    // instead of extending it would leave sessions alive, which is the more
    // serious half of the bug.
    const { service, session, refreshToken, playbackTicket, pushToken } = buildAuth();

    await service.logoutAll('usr_1', 'Lost handset');

    expect(session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'usr_1', status: 'ACTIVE' },
      }),
    );
    expect(refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'usr_1', revokedAt: null } }),
    );
    expect(playbackTicket.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'usr_1', status: 'ACTIVE' } }),
    );
    expect(pushToken.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe('deleting an account', () => {
  const buildUsers = () => {
    const pushToken = { updateMany: jest.fn(async () => ({ count: 4 })) };
    const session = { updateMany: jest.fn(async () => ({ count: 1 })) };
    const refreshToken = { updateMany: jest.fn(async () => ({ count: 2 })) };
    const playbackTicket = { updateMany: jest.fn(async () => ({ count: 0 })) };

    const prisma = {
      user: {
        findFirst: jest.fn(async () => ({ id: 'usr_1', role: 'STUDENT', phone: '01001234567' })),
        update: jest.fn(async () => ({})),
      },
      courseTeacher: { findMany: jest.fn(async () => []) },
      session,
      refreshToken,
      playbackTicket,
      pushToken,
      $transaction: jest.fn(async (ops: unknown[]) => Promise.all(ops)),
    };

    const audit = { record: jest.fn(async () => undefined) };

    const service = new UsersService(
      prisma as never,
      {} as never, // passwords
      audit as never,
      {} as never, // settings
      {} as never, // catalog
    );

    return { service, audit, pushToken, session, refreshToken, playbackTicket };
  };

  it('revokes push tokens along with the sessions', async () => {
    // New notifications already skip a DISABLED account, but jobs already
    // queued for it would still be delivered. The account is gone; its handsets
    // should stop hearing about new lessons.
    const { service, pushToken } = buildUsers();

    await service.softDelete('usr_1', { id: 'adm_1', role: 'ADMIN' }, 'Left the school');

    expect(pushToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'usr_1', isActive: true },
      data: { isActive: false },
    });
  });

  it('still revokes everything it revoked before', async () => {
    const { service, session, refreshToken, playbackTicket } = buildUsers();

    await service.softDelete('usr_1', { id: 'adm_1', role: 'ADMIN' }, 'Left the school');

    expect(session.updateMany).toHaveBeenCalledTimes(1);
    expect(refreshToken.updateMany).toHaveBeenCalledTimes(1);
    expect(playbackTicket.updateMany).toHaveBeenCalledTimes(1);
  });
});