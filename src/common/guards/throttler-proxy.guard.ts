import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';

/**
 * Rate-limit key resolution.
 *
 * Runs AFTER JwtAuthGuard (see AppModule), which is what makes the user-id
 * branch reachable.
 *
 * Authenticated requests are keyed by user id, credential requests by the
 * submitted phone, and other anonymous requests by `req.ip`.
 *
 * `req.ip` is the attribution decided once in RequestContextMiddleware (owner
 * decision D6, common/net/client-ip.ts): the browser address forwarded by the
 * student web server when it presents the shared secret, otherwise the address
 * Express derives from the trusted proxy hops. The raw X-Forwarded-For header
 * is NOT read here: its leftmost entry is whatever the client wrote.
 */
@Injectable()
export class ThrottlerProxyGuard extends ThrottlerGuard {
  protected override async getTracker(req: Request): Promise<string> {
    if (req.user?.id) return `user:${req.user.id}`;

    const ip = req.ip;

    // Credential endpoints bucket by the submitted phone ALONE.
    //
    // An `ip|phone` key let an attacker who could vary the address (the
    // leftmost X-Forwarded-For entry, which this guard used to read) get a
    // fresh bucket for the same account on every request. Keyed by phone, the
    // attempts against one account share one bucket whatever address they
    // claim, and one attacker still cannot exhaust the limit for an entire NAT
    // range. (Formatting is stripped so "010 1234" and
    // "0101234" are the same account.)
    const phone =
      typeof req.body === 'object' && req.body && 'phone' in req.body
        ? String((req.body as { phone?: unknown }).phone ?? '')
            .replace(/[\s()-]/g, '')
            .slice(0, 20)
        : '';

    return phone ? `phone:${phone}` : `ip:${ip ?? 'unknown'}`;
  }
}
