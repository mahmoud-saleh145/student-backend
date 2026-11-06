import { APP_GUARD } from '@nestjs/core';

import { ThrottlerProxyGuard } from '../../src/common/guards/throttler-proxy.guard';
import { JwtAuthGuard } from '../../src/common/guards/jwt-auth.guard';

/**
 * Which bucket a request is counted in.
 *
 *  - Authenticated requests are per USER. That only works if the auth guard has
 *    already attached `req.user`, i.e. if it runs first (pinned below).
 *  - Credential attempts are per PHONE, so rotating a spoofed X-Forwarded-For
 *    no longer buys a fresh bucket for the same account.
 */
const tracker = (req: Record<string, unknown>) =>
  (Object.create(ThrottlerProxyGuard.prototype) as { getTracker(r: unknown): Promise<string> })
    .getTracker({ header: (name: string) => (req.headers as Record<string, string> | undefined)?.[name], ...req });

describe('ThrottlerProxyGuard.getTracker', () => {
  it('keys an authenticated request by user id, whatever its address', async () => {
    await expect(tracker({ user: { id: 'usr_1' }, ip: '10.0.0.1' })).resolves.toBe('user:usr_1');
  });

  it('keys credential attempts by phone alone, so a spoofed X-Forwarded-For does not reset the bucket', async () => {
    const a = await tracker({ headers: { 'x-forwarded-for': '1.1.1.1' }, body: { phone: '010 1234 5678' } });
    const b = await tracker({ headers: { 'x-forwarded-for': '2.2.2.2' }, body: { phone: '01012345678' } });
    expect(a).toBe('phone:01012345678');
    expect(b).toBe(a);
  });

  it('keys other anonymous requests by req.ip and never by the client-written X-Forwarded-For (D6)', async () => {
    // req.ip is what RequestContextMiddleware decided: the trusted-hop address,
    // or the browser address the web server forwarded with the shared secret.
    await expect(tracker({ headers: { 'x-forwarded-for': '3.3.3.3, 10.0.0.1' }, ip: '10.0.0.1' })).resolves.toBe(
      'ip:10.0.0.1',
    );
    const a = await tracker({ headers: { 'x-forwarded-for': '4.4.4.4' }, ip: '198.51.100.9' });
    const b = await tracker({ headers: { 'x-forwarded-for': '5.5.5.5' }, ip: '198.51.100.9' });
    expect(b).toBe(a);
  });
});

describe('ThrottlerProxyGuard.shouldSkip: the Worker on the liveness route', () => {
  const SECRET = 'edge-secret-value-used-only-in-this-test';
  const skip = (o: { edgeRoute: boolean; header?: unknown; secret?: string | null }) => {
    const guard = Object.create(ThrottlerProxyGuard.prototype) as Record<string, unknown> & {
      shouldSkip(context: unknown): Promise<boolean>;
    };
    guard.reflector = { getAllAndOverride: () => o.edgeRoute };
    guard.config = { get: () => ({ edgeLivenessSecret: o.secret === undefined ? SECRET : o.secret }) };
    return guard.shouldSkip({
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => ({ headers: { 'x-edge-secret': o.header } }) }),
    });
  };

  it('skips only for the right secret on the marked route', async () => {
    await expect(skip({ edgeRoute: true, header: SECRET })).resolves.toBe(true);
  });

  it.each<[string, Parameters<typeof skip>[0]]>([
    ['no header', { edgeRoute: true }],
    ['a wrong header', { edgeRoute: true, header: 'wrong' }],
    ['no configured secret', { edgeRoute: true, header: SECRET, secret: null }],
    ['the right secret on any other route', { edgeRoute: false, header: SECRET }],
  ])('counts the request with %s', async (_name, o) => {
    await expect(skip(o)).resolves.toBe(false);
  });
});

describe('global guard order', () => {
  it('runs authentication before throttling, so the per-user bucket is reachable', () => {
    // Read the providers straight off the module metadata.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../../src/app.module');
    const providers = (Reflect.getMetadata('providers', AppModule) ?? []) as {
      provide?: unknown;
      useClass?: unknown;
    }[];
    const guards = providers.filter((p) => p.provide === APP_GUARD).map((p) => p.useClass);
    expect(guards.indexOf(JwtAuthGuard)).toBeGreaterThanOrEqual(0);
    expect(guards.indexOf(JwtAuthGuard)).toBeLessThan(guards.indexOf(ThrottlerProxyGuard));
  });
});
