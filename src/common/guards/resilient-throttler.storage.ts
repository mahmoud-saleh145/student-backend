import { Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
// Not re-exported from the package root, so it is imported from the file that
// declares it rather than being restated here and drifting.
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';

/**
 * Rate-limit storage that fails **open**.
 *
 * The rate limiter is a protection, not a dependency. When its backing store
 * cannot answer, the honest choice is to serve the request and say so in the
 * log — not to refuse traffic the platform is perfectly able to handle.
 *
 * The alternative is what actually happened. Upstash returned
 * `ERR max requests limit exceeded` on every command; the storage threw; the
 * guard turned that into a 500; and both clients retry 5xx. So each real
 * request became three, every one of them another Redis command against a
 * quota that was already gone, and the endpoints that broke first were the
 * ones every session must pass through — login and refresh. The limiter took
 * the whole API down to protect it from a load it was not under.
 *
 * Failing open is not a security hole here in any meaningful sense: it applies
 * only while Redis is unreachable, it is loud in the logs, and the thing it
 * stops protecting against — request floods — is bounded by the platform's own
 * infrastructure in the meantime. A brute-force window of a few minutes during
 * a Redis outage is a far smaller risk than every student being unable to sign
 * in for the duration.
 *
 * Errors are logged once per interval rather than per request: a store that is
 * down is down for every request, and ten thousand identical lines is how the
 * log stops being read.
 */
export class ResilientThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger('ThrottlerStorage');
  private lastLoggedAt = 0;
  private suppressed = 0;

  private static readonly LOG_INTERVAL_MS = 60_000;

  constructor(private readonly inner: ThrottlerStorage) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    try {
      return await this.inner.increment(key, ttl, limit, blockDuration, throttlerName);
    } catch (error) {
      this.report(error);

      // Shaped as "first hit in a fresh window": the request proceeds, and
      // nothing downstream has to know the store was unavailable.
      return {
        totalHits: 1,
        timeToExpire: Math.ceil(ttl / 1000),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }

  private report(error: unknown): void {
    const now = Date.now();
    this.suppressed += 1;

    if (now - this.lastLoggedAt < ResilientThrottlerStorage.LOG_INTERVAL_MS) return;

    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(
      `rate-limit store unavailable — requests are being allowed through unthrottled ` +
        `(${this.suppressed} affected in the last minute): ${message}`,
    );

    this.lastLoggedAt = now;
    this.suppressed = 0;
  }
}
