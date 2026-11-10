/**
 * A fixed-window, per-client limiter for the public image route, held in this
 * process's memory.
 *
 * Why not the global throttler: that one keeps its counters in Redis, which is
 * right for logins and writes but would cost a Redis round trip for every image
 * a catalogue page loads. Images reach this API only on the direct-origin path
 * (the edge Worker serves them from its cache and reads R2 itself), so this
 * guards a fallback, and a per-instance count is accurate enough for it.
 *
 * Memory is bounded: at most `maxClients` windows are tracked. When the table
 * is full, expired windows are dropped first and then the oldest live ones
 * (Map iteration order is insertion order), so a flood of distinct addresses
 * can only cost a fixed amount of memory — never unbounded growth.
 */
export interface RateDecision {
  allowed: boolean;
  /** Seconds until the client's window resets; meaningful when refused. */
  retryAfterSeconds: number;
  remaining: number;
}

export class PublicAssetRateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxClients: number,
    private readonly now: () => number = Date.now,
  ) {}

  hit(client: string): RateDecision {
    const now = this.now();
    let window = this.windows.get(client);

    if (!window || now - window.start >= this.windowMs) {
      if (window) this.windows.delete(client);
      this.makeRoom(now);
      window = { start: now, count: 0 };
      this.windows.set(client, window);
    }

    window.count += 1;
    const retryAfterSeconds = Math.max(1, Math.ceil((window.start + this.windowMs - now) / 1000));
    return {
      allowed: window.count <= this.limit,
      retryAfterSeconds,
      remaining: Math.max(0, this.limit - window.count),
    };
  }

  /** How many clients are currently tracked (for tests and diagnostics). */
  get size(): number {
    return this.windows.size;
  }

  private makeRoom(now: number): void {
    if (this.windows.size < this.maxClients) return;
    for (const [key, window] of this.windows) {
      if (now - window.start >= this.windowMs) this.windows.delete(key);
    }
    while (this.windows.size >= this.maxClients) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
  }
}

/**
 * Direct-origin policy: 300 image requests per client address per minute.
 *
 * A whole campus or a mobile carrier can sit behind one address, and one
 * catalogue page loads dozens of images; with browsers keeping every image for
 * a year (immutable, versioned keys), 300 a minute is far above ordinary use
 * while still stopping a single client from turning this route into an R2
 * download loop. Up to 10 000 addresses are tracked (~1 MB).
 */
export const PUBLIC_ASSET_ORIGIN_LIMIT = 300;
export const PUBLIC_ASSET_ORIGIN_WINDOW_MS = 60_000;
export const PUBLIC_ASSET_ORIGIN_MAX_CLIENTS = 10_000;
