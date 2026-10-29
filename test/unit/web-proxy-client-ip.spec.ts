import type { Request } from 'express';

import { RequestContextMiddleware } from '../../src/common/middleware/request-context.middleware';
import {
  WEB_CLIENT_IP_HEADER,
  WEB_PROXY_SECRET_HEADER,
  applyClientIp,
  parseForwardedClientIp,
  proxySecretMatches,
  resolveClientIp,
} from '../../src/common/net/client-ip';
import { validateEnv } from '../../src/config/env.validation';

/**
 * Owner decision D6: the student web server forwards the browser's address
 * with a shared secret; the API believes it only with that secret, and never
 * believes X-Forwarded-For as written by a client.
 */

const SECRET = 'a'.repeat(24) + 'Zx9!long-enough-secret';
const VERCEL_EGRESS = '18.200.0.1';

function request(headers: Record<string, string>, ip = VERCEL_EGRESS): Request {
  return { headers: { ...headers }, ip, socket: { remoteAddress: ip } } as unknown as Request;
}

describe('the forwarded address is believed only with the shared secret', () => {
  it('uses the forwarded browser address when the web server presents the secret', () => {
    const req = request({ [WEB_PROXY_SECRET_HEADER]: SECRET, [WEB_CLIENT_IP_HEADER]: '197.34.10.20' });
    expect(resolveClientIp(req, SECRET)).toEqual({ ip: '197.34.10.20', source: 'web-proxy' });
  });

  it.each([
    ['no secret header', {}],
    ['a wrong secret', { [WEB_PROXY_SECRET_HEADER]: SECRET.slice(0, -1) + '?' }],
    ['a prefix of the secret', { [WEB_PROXY_SECRET_HEADER]: SECRET.slice(0, 32) }],
    ['an empty secret', { [WEB_PROXY_SECRET_HEADER]: '' }],
  ])('ignores the forwarded address with %s (direct API traffic)', (_name, extra) => {
    const req = request({ ...extra, [WEB_CLIENT_IP_HEADER]: '1.2.3.4' });
    expect(resolveClientIp(req, SECRET)).toEqual({ ip: VERCEL_EGRESS, source: 'direct' });
  });

  it('believes nothing when the API has no secret configured, even if a caller sends one', () => {
    const req = request({ [WEB_PROXY_SECRET_HEADER]: SECRET, [WEB_CLIENT_IP_HEADER]: '1.2.3.4' });
    expect(resolveClientIp(req, null).source).toBe('direct');
  });

  it('refuses a configured secret that is too short to be one', () => {
    expect(proxySecretMatches('short', 'short')).toBe(false);
  });

  it('never reads X-Forwarded-For itself', () => {
    const req = request({ 'x-forwarded-for': '6.6.6.6, 18.200.0.1' });
    expect(resolveClientIp(req, SECRET)).toEqual({ ip: VERCEL_EGRESS, source: 'direct' });
  });
});

describe('the forwarded value must be one real address', () => {
  it.each([
    ['197.34.10.20', '197.34.10.20'],
    ['2001:db8::1', '2001:db8::1'],
    [' 197.34.10.20 ', '197.34.10.20'],
    ['1.1.1.1, 2.2.2.2', null],
    ['not-an-ip', null],
    ['999.1.1.1', null],
    ['', null],
    [undefined, null],
  ])('%p -> %p', (raw, expected) => {
    expect(parseForwardedClientIp(raw as string | undefined)).toBe(expected);
  });

  it('falls back to the direct address when the secret is right but the value is junk', () => {
    const req = request({ [WEB_PROXY_SECRET_HEADER]: SECRET, [WEB_CLIENT_IP_HEADER]: 'evil, 1.1.1.1' });
    expect(resolveClientIp(req, SECRET)).toEqual({ ip: VERCEL_EGRESS, source: 'direct' });
  });
});

describe('applying the attribution', () => {
  it('sets req.ip for every later reader and strips both headers', () => {
    const req = request({ [WEB_PROXY_SECRET_HEADER]: SECRET, [WEB_CLIENT_IP_HEADER]: '197.34.10.20' });
    applyClientIp(req, SECRET);
    expect(req.ip).toBe('197.34.10.20');
    expect(req.clientIpSource).toBe('web-proxy');
    expect(req.headers).not.toHaveProperty(WEB_PROXY_SECRET_HEADER);
    expect(req.headers).not.toHaveProperty(WEB_CLIENT_IP_HEADER);
  });

  it('strips the headers from a direct caller too, and leaves req.ip alone', () => {
    const req = request({ [WEB_PROXY_SECRET_HEADER]: 'guess', [WEB_CLIENT_IP_HEADER]: '1.2.3.4' });
    applyClientIp(req, SECRET);
    expect(req.ip).toBe(VERCEL_EGRESS);
    expect(req.clientIpSource).toBe('direct');
    expect(req.headers).not.toHaveProperty(WEB_PROXY_SECRET_HEADER);
  });

  it('runs in the request middleware, before guards, with the configured secret', () => {
    const config = { get: () => ({ webProxySharedSecret: SECRET }) };
    const middleware = new RequestContextMiddleware(config as never);
    const req = Object.assign(
      request({ [WEB_PROXY_SECRET_HEADER]: SECRET, [WEB_CLIENT_IP_HEADER]: '197.34.10.20' }),
      { header: (name: string) => (req.headers as Record<string, string>)[name] },
    ) as Request;
    const res = { setHeader: jest.fn() };
    const next = jest.fn();

    middleware.use(req, res as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.ip).toBe('197.34.10.20');
    // The secret is never echoed back.
    expect(JSON.stringify(res.setHeader.mock.calls)).not.toContain(SECRET);
  });
});

describe('environment validation', () => {
  // Same minimal environment as env-validation.spec.ts.
  const base = {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/edu',
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    JWT_PLAYBACK_SECRET: 'c'.repeat(48),
    MEDIA_SIGNING_KEY: 'd'.repeat(48),
    HLS_KEY_ROOT: 'e'.repeat(48),
  };

  it('accepts no secret (feature off) and a long one', () => {
    expect(() => validateEnv(base)).not.toThrow();
    expect(() => validateEnv({ ...base, WEB_PROXY_SHARED_SECRET: SECRET })).not.toThrow();
  });

  it('refuses a short secret at boot rather than running with a guessable one', () => {
    expect(() => validateEnv({ ...base, WEB_PROXY_SHARED_SECRET: 'short-secret' })).toThrow(
      /WEB_PROXY_SHARED_SECRET/,
    );
  });

  it('accepts a proxy hop count and refuses a silly one', () => {
    expect(validateEnv({ ...base, TRUST_PROXY_HOPS: '2' }).TRUST_PROXY_HOPS).toBe(2);
    expect(() => validateEnv({ ...base, TRUST_PROXY_HOPS: '0' })).toThrow(/TRUST_PROXY_HOPS/);
  });
});
