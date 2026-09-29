import { ResilientThrottlerStorage } from '../../src/common/guards/resilient-throttler.storage';

/**
 * The rate limiter must not be able to take the API down.
 *
 * This is the failure that produced the incident: Upstash answered
 * `ERR max requests limit exceeded` to every command, the throttler storage
 * threw, the guard turned that into a 500 — on *every* route, including login
 * and refresh — and both the mobile app and the dashboard retry 5xx. Each real
 * request became three, and all three spent Redis commands on a quota that had
 * already run out.
 */

function storageThatFails(error = new Error('ERR max requests limit exceeded')) {
  return {
    increment: jest.fn(async () => {
      throw error;
    }),
  };
}

describe('rate-limit storage when Redis is unavailable', () => {
  it('lets the request through instead of throwing', async () => {
    const storage = new ResilientThrottlerStorage(storageThatFails());

    const record = await storage.increment('user:1', 60_000, 120, 0, 'default');

    expect(record.isBlocked).toBe(false);
    expect(record.totalHits).toBe(1);
  });

  it('reports a window in seconds, matching what the guard expects', async () => {
    const storage = new ResilientThrottlerStorage(storageThatFails());

    const record = await storage.increment('user:1', 60_000, 120, 0, 'default');

    expect(record.timeToExpire).toBe(60);
    expect(record.timeToBlockExpire).toBe(0);
  });

  it('keeps passing requests through for as long as the store is down', async () => {
    // The point is that the outage is survivable, not merely non-fatal once.
    const storage = new ResilientThrottlerStorage(storageThatFails());

    for (let i = 0; i < 25; i += 1) {
      await expect(storage.increment('user:1', 60_000, 120, 0, 'default')).resolves.toMatchObject(
        { isBlocked: false },
      );
    }
  });

  it('does not log once per failed request', async () => {
    // Ten thousand identical lines is how a log stops being read.
    const storage = new ResilientThrottlerStorage(storageThatFails());
    const logged: string[] = [];
    jest
      .spyOn(
        (storage as unknown as { logger: { error: (m: string) => void } }).logger,
        'error',
      )
      .mockImplementation((message: string) => {
        logged.push(message);
      });

    for (let i = 0; i < 50; i += 1) {
      await storage.increment('user:1', 60_000, 120, 0, 'default');
    }

    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/unthrottled/);
  });

  it('passes a healthy store straight through, untouched', async () => {
    const healthy = {
      increment: jest.fn(async () => ({
        totalHits: 7,
        timeToExpire: 42,
        isBlocked: true,
        timeToBlockExpire: 9,
      })),
    };

    const storage = new ResilientThrottlerStorage(healthy);
    const record = await storage.increment('ip:1.2.3.4', 60_000, 10, 0, 'default');

    // Including `isBlocked` — failing open is strictly a fallback, never a
    // relaxation of a limit the store was able to enforce.
    expect(record).toEqual({
      totalHits: 7,
      timeToExpire: 42,
      isBlocked: true,
      timeToBlockExpire: 9,
    });
    expect(healthy.increment).toHaveBeenCalledWith('ip:1.2.3.4', 60_000, 10, 0, 'default');
  });
});
