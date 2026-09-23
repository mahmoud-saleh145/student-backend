/**
 * The BullMQ connection derived from REDIS_URL.
 *
 * `JobsModule` does not hand the URL to ioredis — it rebuilds the connection
 * field by field, so anything the URL carries must be carried across
 * explicitly. TLS is the one that bites: `rediss://` is how a managed Redis
 * (Upstash, Redis Cloud) states that it requires an encrypted connection, and
 * dropping it means either a refused handshake or an auth token sent in the
 * clear — while `RedisService`, which passes the URL straight to ioredis,
 * connects fine and hides the asymmetry.
 *
 * These cases call the module's own factory rather than a copy of its logic,
 * because a test that re-implements the derivation would keep passing after
 * the real one regressed.
 */

// The feature modules are irrelevant here and drag in the whole graph.
// These factories are inlined because `jest.mock` calls are hoisted above any
// `const` a helper would live in.
jest.mock('../../src/modules/videos/videos.module', () => ({ VideosModule: class {} }), { virtual: true });
jest.mock('../../src/modules/notifications/notifications.module', () => ({ NotificationsModule: class {} }), { virtual: true });
jest.mock('../../src/modules/enrollments/enrollments.module', () => ({ EnrollmentsModule: class {} }), { virtual: true });
jest.mock('../../src/modules/codes/codes.module', () => ({ CodesModule: class {} }), { virtual: true });
jest.mock('../../src/modules/playback/playback.module', () => ({ PlaybackModule: class {} }), { virtual: true });
jest.mock('../../src/jobs/processors/analytics.processor', () => ({ AnalyticsProcessor: class {} }), { virtual: true });
jest.mock('../../src/jobs/processors/maintenance.processor', () => ({ MaintenanceProcessor: class {} }), { virtual: true });
jest.mock('../../src/jobs/processors/push.processor', () => ({ PushProcessor: class {} }), { virtual: true });
jest.mock('../../src/jobs/processors/video.processor', () => ({ VideoProcessor: class {} }), { virtual: true });
jest.mock('../../src/jobs/schedulers/maintenance.scheduler', () => ({ MaintenanceScheduler: class {} }), { virtual: true });

import { JobsModule } from '../../src/jobs/jobs.module';

interface Connection {
  host: string;
  port: number;
  username?: string;
  password?: string;
  tls?: Record<string, unknown>;
  maxRetriesPerRequest: number | null;
  enableReadyCheck: boolean;
}

/** The real `BullModule.forRootAsync` factory, pulled off the module metadata. */
function bullFactory(): (config: unknown) => { connection: Connection; prefix: string } {
  const imports = (Reflect.getMetadata('imports', JobsModule) ?? []) as {
    providers?: { useFactory?: unknown }[];
  }[];

  for (const imported of imports) {
    const provider = imported?.providers?.find((p) => typeof p?.useFactory === 'function');
    if (provider) {
      return provider.useFactory as (config: unknown) => {
        connection: Connection;
        prefix: string;
      };
    }
  }

  throw new Error('BullModule root factory not found on JobsModule');
}

/** A ConfigService stand-in returning one redis config. */
function configWith(url: string, prefix = 'edu') {
  return { getOrThrow: jest.fn(() => ({ url, prefix })) };
}

function connectionFor(url: string): Connection {
  return bullFactory()(configWith(url)).connection;
}

describe('TLS follows the URL scheme', () => {
  it('enables TLS for rediss://', () => {
    // `{}` means "TLS with default options" to ioredis — the node defaults
    // verify the certificate, so this is not a weakened connection.
    expect(connectionFor('rediss://default:tok@example.upstash.io:6379').tls).toEqual({});
  });

  it('leaves TLS off for plain redis://', () => {
    expect(connectionFor('redis://127.0.0.1:6379').tls).toBeUndefined();
  });
});

describe('everything else the URL carries is unchanged', () => {
  it('keeps host, port and credentials', () => {
    expect(connectionFor('rediss://default:tok@example.upstash.io:6380')).toMatchObject({
      host: 'example.upstash.io',
      port: 6380,
      username: 'default',
      password: 'tok',
    });
  });

  it('defaults the port to 6379 when the URL omits it', () => {
    expect(connectionFor('redis://localhost').port).toBe(6379);
  });

  it('leaves credentials undefined when the URL has none', () => {
    const connection = connectionFor('redis://127.0.0.1:6379');
    expect(connection.username).toBeUndefined();
    expect(connection.password).toBeUndefined();
  });

  it('keeps the BullMQ-required retry and ready-check settings', () => {
    // BullMQ requires `maxRetriesPerRequest: null` specifically; a number here
    // makes it throw at startup.
    expect(connectionFor('rediss://h:6379')).toMatchObject({
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  });

  it('keeps the queue prefix', () => {
    expect(bullFactory()(configWith('redis://h:6379', 'edu')).prefix).toBe('edu:bull');
  });
});
