import {
  beatIsFresh,
  roleFromEnv,
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_TTL_SECONDS,
} from '../../scripts/healthcheck';
import {
  WORKER_HEARTBEAT_KEY as SOURCE_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_TTL_SECONDS as SOURCE_HEARTBEAT_TTL_SECONDS,
} from '../../src/jobs/worker-heartbeat';

/**
 * The container healthcheck.
 *
 * One image serves two roles whose liveness means opposite things. The API is
 * healthy when its HTTP port answers. The worker has no port at all, so the only
 * honest question is whether it has checked in recently. A single HTTP-based
 * check for both roles is exactly what made a deployed worker look broken while
 * it was working fine, and then look healthy after it had stopped.
 *
 * The Redis round trip is not mocked here; the decision that has to be right is
 * which signal is consulted, and how stale is stale.
 */
describe('container healthcheck', () => {
  describe('roleFromEnv', () => {
    it('treats the worker as the worker only when RUN_WORKERS is exactly "true"', () => {
      expect(roleFromEnv({ RUN_WORKERS: 'true' })).toBe('worker');
    });

    it.each([
      ['unset', {}],
      ['empty', { RUN_WORKERS: '' }],
      ['false', { RUN_WORKERS: 'false' }],
      ['capitalised', { RUN_WORKERS: 'TRUE' }],
      ['padded', { RUN_WORKERS: ' true' }],
      ['a different true-ish word', { RUN_WORKERS: '1' }],
    ])('treats %s as the API', (_label, env) => {
      // Stray values mean the API, which serves HTTP and can be probed. The
      // worker registering processors by accident is the worse failure.
      expect(roleFromEnv(env)).toBe('api');
    });
  });

  describe('beatIsFresh', () => {
    const ttl = 180;
    const now = Date.parse('2026-10-04T12:00:00.000Z');

    const beat = (secondsAgo: number) =>
      JSON.stringify({ pid: 1, host: 'worker-1', at: new Date(now - secondsAgo * 1000).toISOString() });

    it('accepts a beat well inside the TTL', () => {
      expect(beatIsFresh(beat(10), ttl, now)).toBe(true);
    });

    it('accepts a beat at the TTL boundary', () => {
      expect(beatIsFresh(beat(ttl), ttl, now)).toBe(true);
    });

    it('rejects a beat past the TTL, which is what a wedged worker looks like', () => {
      expect(beatIsFresh(beat(ttl + 60), ttl, now)).toBe(false);
    });

    it('rejects a missing beat', () => {
      expect(beatIsFresh(null, ttl, now)).toBe(false);
    });

    it('rejects a corrupt payload rather than crashing the check', () => {
      expect(beatIsFresh('{not json', ttl, now)).toBe(false);
    });

    it('rejects a payload with no timestamp, since age is unknowable', () => {
      expect(beatIsFresh(JSON.stringify({ pid: 1 }), ttl, now)).toBe(false);
    });

    it('tolerates a small clock skew instead of reading a live worker as stale', () => {
      expect(beatIsFresh(beat(-30), ttl, now)).toBe(true);
    });
  });

  describe('agreement with the worker heartbeat it reads', () => {
    it('uses the same key the worker writes', () => {
      expect(WORKER_HEARTBEAT_KEY).toBe(SOURCE_HEARTBEAT_KEY);
    });

    it('uses the same TTL the worker expires the key on', () => {
      // Redis expires the key on its own; this TTL is only the staleness rule
      // applied to the payload's `at`. If the two drift, the check either calls a
      // live worker dead or trusts a key Redis should have dropped.
      expect(WORKER_HEARTBEAT_TTL_SECONDS).toBe(SOURCE_HEARTBEAT_TTL_SECONDS);
    });

    it('tolerates a beat as old as the TTL the worker itself uses', () => {
      const nowMs = Date.parse('2026-10-04T12:00:00.000Z');
      const raw = JSON.stringify({ at: new Date(nowMs - WORKER_HEARTBEAT_TTL_SECONDS * 1000).toISOString() });

      expect(beatIsFresh(raw, WORKER_HEARTBEAT_TTL_SECONDS, nowMs)).toBe(true);
    });
  });
});