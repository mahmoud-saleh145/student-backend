import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import type { RedisConfig } from '../config/configuration';

/**
 * Redis is used for four distinct jobs, each with its own key namespace:
 *
 *   pb:*     playback concurrency slots and ticket revocation (short TTL)
 *   rl:*     rate-limit counters
 *   cache:*  read-through caches for catalogue data
 *   lock:*   short-lived mutexes around non-transactional critical sections
 *
 * Nothing here is a source of truth. A Redis outage degrades throughput and
 * relaxes concurrency limits, but never grants access that the database would
 * deny — the authorization chain always re-reads Postgres.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly prefix: string;
  readonly client: Redis;

  constructor(config: ConfigService) {
    const cfg = config.getOrThrow<RedisConfig>('redis');
    this.prefix = cfg.prefix;

    this.client = new Redis(cfg.url, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 200, 5_000),
    });

    this.client.on('error', (e) => this.logger.error(`Redis error: ${e.message}`));
    this.client.on('ready', () => this.logger.log('Redis connected'));
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.connect();
    } catch (e) {
      // Do not take the API down. Features that need Redis degrade
      // individually and log; the health endpoint reports it as unhealthy.
      this.logger.error(`Redis unavailable at startup: ${(e as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }

  key(...parts: (string | number)[]): string {
    return [this.prefix, ...parts].join(':');
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  // --- cache helpers ---------------------------------------------------------

  async getJson<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(this.key(key));
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(this.key(key), JSON.stringify(value), 'EX', ttlSeconds);
    } catch (e) {
      this.logger.debug(`cache set failed for ${key}: ${(e as Error).message}`);
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.client.del(...keys.map((k) => this.key(k)));
    } catch {
      /* cache deletion is best effort */
    }
  }

  /** Deletes every key under a prefix using SCAN (never KEYS). */
  async delByPattern(pattern: string): Promise<number> {
    let cursor = '0';
    let removed = 0;
    const match = this.key(pattern);

    try {
      do {
        const [next, found] = await this.client.scan(
          cursor,
          'MATCH',
          match,
          'COUNT',
          200,
        );
        cursor = next;
        if (found.length) {
          removed += await this.client.del(...found);
        }
      } while (cursor !== '0');
    } catch (e) {
      this.logger.debug(`scan delete failed: ${(e as Error).message}`);
    }

    return removed;
  }

  /**
   * Read-through cache. On any Redis failure the loader still runs, so a cache
   * outage is a latency problem, never a correctness one.
   */
  async remember<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
    const hit = await this.getJson<T>(key);
    if (hit !== null) return hit;

    const value = await loader();
    await this.setJson(key, value, ttlSeconds);
    return value;
  }

  // --- counters and locks ----------------------------------------------------

  /** Increments a windowed counter and returns the new value. */
  async incrementWindow(key: string, windowSeconds: number): Promise<number> {
    const full = this.key(key);
    const results = await this.client
      .multi()
      .incr(full)
      .expire(full, windowSeconds, 'NX')
      .exec();

    const value = results?.[0]?.[1];
    return typeof value === 'number' ? value : Number(value ?? 0);
  }

  /** Best-effort mutex. Returns a release function, or null if not acquired. */
  async acquireLock(
    name: string,
    ttlSeconds = 30,
  ): Promise<(() => Promise<void>) | null> {
    const full = this.key('lock', name);
    const token = `${process.pid}-${Date.now()}-${Math.random()}`;

    try {
      const ok = await this.client.set(full, token, 'EX', ttlSeconds, 'NX');
      if (ok !== 'OK') return null;

      return async () => {
        // Only release a lock we still own.
        const script = `
          if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
          else
            return 0
          end`;
        await this.client.eval(script, 1, full, token).catch(() => undefined);
      };
    } catch {
      return null;
    }
  }
}
