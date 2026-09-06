import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';

/**
 * Rate-limit key resolution.
 *
 * Behind a load balancer `req.ip` is the balancer, so every user shares one
 * bucket. Authenticated requests are therefore keyed by user id, and
 * anonymous ones by the leftmost X-Forwarded-For entry (only trustworthy when
 * TRUST_PROXY is on and the balancer overwrites the header).
 */
@Injectable()
export class ThrottlerProxyGuard extends ThrottlerGuard {
  protected override async getTracker(req: Request): Promise<string> {
    if (req.user?.id) return `user:${req.user.id}`;

    const forwarded = req.header('x-forwarded-for');
    const ip = forwarded ? (forwarded.split(',')[0]?.trim() ?? req.ip) : req.ip;

    // Credential endpoints additionally bucket by the submitted phone so one
    // attacker cannot exhaust the limit for an entire NAT range, and so
    // password spraying against many accounts still trips the limit.
    const phone =
      typeof req.body === 'object' && req.body && 'phone' in req.body
        ? String((req.body as { phone?: unknown }).phone ?? '').slice(0, 20)
        : '';

    return phone ? `ip:${ip}|phone:${phone}` : `ip:${ip ?? 'unknown'}`;
  }
}
