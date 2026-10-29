import 'reflect-metadata';

import { UserRole } from '@prisma/client';

import { IS_PUBLIC_KEY } from '../../src/common/decorators/public.decorator';
import { ROLES_KEY } from '../../src/common/decorators/roles.decorator';
import { HealthController } from '../../src/modules/health/health.controller';

/**
 * Health endpoint visibility (Phase 6 §6 / D6).
 *
 * Two endpoints, two audiences:
 *   - GET meta/health — public and minimal: a load balancer or uptime monitor
 *     needs a yes/no and nothing else. It must stay @Public.
 *   - GET meta/health/deep — the full dependency report (Redis, storage,
 *     worker heartbeat, video-pipeline counts). That is operational topology,
 *     so it is MASTER-only: ADMIN, TEACHER, STUDENT and anonymous callers all
 *     get the standard authorization refusal from the global guards.
 *
 * These pins read the route metadata the guards read, so a reverted decorator
 * fails here before it reaches a live server.
 */

describe('GET meta/health (shallow)', () => {
  it('is public — monitors must reach it unauthenticated', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, HealthController.prototype.health)).toBe(true);
  });

  it('carries no role restriction', () => {
    expect(Reflect.getMetadata(ROLES_KEY, HealthController.prototype.health)).toBeUndefined();
  });
});

describe('GET meta/health/deep', () => {
  it('is MASTER-only', () => {
    expect(Reflect.getMetadata(ROLES_KEY, HealthController.prototype.deep)).toEqual([
      UserRole.MASTER,
    ]);
  });

  it('is not public — anonymous callers are refused by the auth guard', () => {
    // No @Public marker means the global JwtAuthGuard demands a valid session
    // before the roles guard even runs; with ROLES=[MASTER] every
    // authenticated non-MASTER role is then refused too.
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, HealthController.prototype.deep)).toBeUndefined();
  });
});
