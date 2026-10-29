import 'reflect-metadata';

import express, { type Request } from 'express';
import request from 'supertest';

import { appConfig } from '../../src/config/configuration';
import { NodeEnv, validateEnv } from '../../src/config/env.validation';

import { ThrottlerProxyGuard } from '../../src/common/guards/throttler-proxy.guard';
import { RequestContextMiddleware } from '../../src/common/middleware/request-context.middleware';
import {
  DIAGNOSTIC_FORWARDED_FOR_SHOWN,
  MAX_TRUST_PROXY_HOPS,
  WEB_CLIENT_IP_HEADER,
  WEB_PROXY_SECRET_HEADER,
  describeClientIpChain,
  expressIpForHops,
} from '../../src/common/net/client-ip';

/**
 * D6 end to end on a real Express stack: `trust proxy` as main.ts sets it,
 * the request middleware, then the throttler's bucket key. What matters is
 * which bucket a request lands in, for every kind of caller:
 *
 *  - anonymous, direct (mobile)       -> ip:<address Express trusts>
 *  - anonymous, via the web server     -> ip:<browser address>, only with the secret
 *  - credential attempt                -> phone:<number>
 *  - signed in                         -> user:<id>
 *
 * and that nothing a client writes into a header moves it to a fresh bucket.
 * These tests pin our model of Express; they say nothing about how many
 * proxies Render really runs (that needs the diagnostic endpoint, D6).
 */

const SECRET = 's'.repeat(48);

function app(hops: number, opts: { secret?: string | null; user?: string } = {}) {
  const a = express();
  a.set('trust proxy', hops);
  a.use(express.json());
  const middleware = new RequestContextMiddleware({
    get: () => ({ webProxySharedSecret: opts.secret === undefined ? SECRET : opts.secret }),
  } as never);
  a.use((req, res, next) => middleware.use(req, res, next));
  const userId = opts.user;
  if (userId) {
    a.use((req, _res, next) => {
      (req as unknown as { user?: unknown }).user = { id: userId };
      next();
    });
  }
  const guard = Object.create(ThrottlerProxyGuard.prototype) as { getTracker(r: Request): Promise<string> };
  a.all('/t', async (req, res) => {
    res.json({ tracker: await guard.getTracker(req), ip: req.ip, chain: describeClientIpChain(req, { trustProxy: true, trustProxyHops: hops }) });
  });
  return a;
}

const tracker = async (a: express.Express, headers: Record<string, string>, body?: unknown) => {
  const r = request(a).post('/t');
  for (const [k, v] of Object.entries(headers)) r.set(k, v);
  const res = await (body ? r.send(body) : r.send());
  return res.body as { tracker: string; ip: string; chain: { ipByHopCount: Record<string, string> } };
};

// A platform with ONE proxy that appends the real client address:
//   client -> proxy (appends client) -> API
// The rightmost entry is the client; anything to its left was written by the client.
const PROXY_ADDED = '197.34.10.20';

describe('anonymous direct traffic (mobile), hop count matching the platform', () => {
  const a = app(1);

  it('is bucketed by the address the trusted proxy added', async () => {
    await expect(tracker(a, { 'x-forwarded-for': PROXY_ADDED })).resolves.toMatchObject({
      tracker: `ip:${PROXY_ADDED}`,
    });
  });

  it('cannot escape its bucket by writing its own X-Forwarded-For entries', async () => {
    const seen = new Set<string>();
    for (const spoof of ['1.1.1.1', '2.2.2.2, 3.3.3.3', '10.0.0.1']) {
      seen.add((await tracker(a, { 'x-forwarded-for': `${spoof}, ${PROXY_ADDED}` })).tracker);
    }
    expect([...seen]).toEqual([`ip:${PROXY_ADDED}`]);
  });

  it('cannot claim a web-proxy address without the secret', async () => {
    const r = await tracker(a, {
      'x-forwarded-for': PROXY_ADDED,
      [WEB_CLIENT_IP_HEADER]: '8.8.8.8',
      [WEB_PROXY_SECRET_HEADER]: 'guess-'.repeat(8),
    });
    expect(r.tracker).toBe(`ip:${PROXY_ADDED}`);
  });
});

describe('what a WRONG hop count does (why D6 needs live evidence)', () => {
  // Platform with TWO proxies: client -> edge (appends client) -> balancer (appends edge) -> API.
  const EDGE = '172.71.0.5';

  it('too few hops: every client lands in the edge proxy bucket (shared, availability risk)', async () => {
    const a = app(1);
    const one = await tracker(a, { 'x-forwarded-for': `${PROXY_ADDED}, ${EDGE}` });
    const two = await tracker(a, { 'x-forwarded-for': `41.0.0.9, ${EDGE}` });
    expect(one.tracker).toBe(`ip:${EDGE}`);
    expect(two.tracker).toBe(one.tracker);
  });

  it('the right count separates clients and still ignores client-written entries', async () => {
    const a = app(2);
    expect((await tracker(a, { 'x-forwarded-for': `${PROXY_ADDED}, ${EDGE}` })).tracker).toBe(`ip:${PROXY_ADDED}`);
    expect((await tracker(a, { 'x-forwarded-for': `6.6.6.6, ${PROXY_ADDED}, ${EDGE}` })).tracker).toBe(`ip:${PROXY_ADDED}`);
  });

  it('too many hops: a client can choose its own bucket (evasion risk)', async () => {
    const a = app(3);
    const r1 = await tracker(a, { 'x-forwarded-for': `6.6.6.6, ${PROXY_ADDED}, ${EDGE}` });
    const r2 = await tracker(a, { 'x-forwarded-for': `7.7.7.7, ${PROXY_ADDED}, ${EDGE}` });
    expect(r1.tracker).toBe('ip:6.6.6.6');
    expect(r2.tracker).not.toBe(r1.tracker);
  });
});

describe('the trusted web server (student web on Vercel)', () => {
  const VERCEL = '18.200.0.1';

  it('with the secret: anonymous browsers are bucketed by their own address', async () => {
    const a = app(1);
    const r1 = await tracker(a, { 'x-forwarded-for': VERCEL, [WEB_CLIENT_IP_HEADER]: '41.33.1.2', [WEB_PROXY_SECRET_HEADER]: SECRET });
    const r2 = await tracker(a, { 'x-forwarded-for': VERCEL, [WEB_CLIENT_IP_HEADER]: '41.33.1.3', [WEB_PROXY_SECRET_HEADER]: SECRET });
    expect(r1.tracker).toBe('ip:41.33.1.2');
    expect(r2.tracker).toBe('ip:41.33.1.3');
  });

  it('without a configured secret: everything from the web server shares its address, as before', async () => {
    const a = app(1, { secret: null });
    const r = await tracker(a, { 'x-forwarded-for': VERCEL, [WEB_CLIENT_IP_HEADER]: '41.33.1.2', [WEB_PROXY_SECRET_HEADER]: SECRET });
    expect(r.tracker).toBe(`ip:${VERCEL}`);
  });

  it('never reveals the secret to the handler', async () => {
    const a = express();
    a.set('trust proxy', 1);
    const middleware = new RequestContextMiddleware({ get: () => ({ webProxySharedSecret: SECRET }) } as never);
    a.use((req, res, next) => middleware.use(req, res, next));
    a.get('/h', (req, res) => res.json(req.headers));
    const res = await request(a).get('/h').set(WEB_PROXY_SECRET_HEADER, SECRET).set(WEB_CLIENT_IP_HEADER, '41.33.1.2');
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });
});

describe('credential and signed-in traffic keep their own keys', () => {
  it('credential attempts are keyed by phone whatever address is claimed', async () => {
    const a = app(1);
    const r1 = await tracker(a, { 'x-forwarded-for': `1.1.1.1, ${PROXY_ADDED}` }, { phone: '010 0123 4567', password: 'x' });
    const r2 = await tracker(a, { 'x-forwarded-for': `9.9.9.9, 41.0.0.1` }, { phone: '01001234567', password: 'y' });
    expect(r1.tracker).toBe('phone:01001234567');
    expect(r2.tracker).toBe(r1.tracker);
  });

  it('signed-in requests are keyed by user, whatever headers they carry', async () => {
    const a = app(1, { user: 'usr_42' });
    const r = await tracker(a, {
      'x-forwarded-for': '6.6.6.6',
      [WEB_CLIENT_IP_HEADER]: '8.8.8.8',
      [WEB_PROXY_SECRET_HEADER]: SECRET,
    });
    expect(r.tracker).toBe('user:usr_42');
  });
});

describe('the proxy-hop diagnostic agrees with Express', () => {
  it.each([1, 2, 3, 4, 5])('hop count %i', async (hops) => {
    const a = app(hops);
    const r = await tracker(a, { 'x-forwarded-for': '10.1.1.1, 10.2.2.2, 10.3.3.3' });
    expect(r.chain.ipByHopCount[String(hops)]).toBe(r.ip);
  });

  it('expressIpForHops reads from the right and stops at the leftmost entry', () => {
    expect(expressIpForHops('127.0.0.1', ['a', 'b', 'c'], 1)).toBe('c');
    expect(expressIpForHops('127.0.0.1', ['a', 'b', 'c'], 3)).toBe('a');
    expect(expressIpForHops('127.0.0.1', ['a', 'b', 'c'], 9)).toBe('a');
    expect(expressIpForHops('127.0.0.1', [], 1)).toBe('127.0.0.1');
  });
});

describe('the diagnostic endpoint', () => {
  it('is MASTER-only and read-only', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ClientIpDiagnosticsController } = require('../../src/modules/diagnostics/client-ip-diagnostics.controller');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ROLES_KEY } = require('../../src/common/decorators/roles.decorator');
    expect(Reflect.getMetadata(ROLES_KEY, ClientIpDiagnosticsController.prototype.clientIp)).toEqual(['MASTER']);
    expect(Reflect.getMetadata('method', ClientIpDiagnosticsController.prototype.clientIp)).toBe(0); // GET
  });

  it('reports only address headers, never the proxy secret', () => {
    const req = {
      headers: {
        'x-forwarded-for': '41.33.1.2, 10.0.0.1',
        [WEB_PROXY_SECRET_HEADER]: SECRET,
        authorization: 'Bearer abc',
        'true-client-ip': '41.33.1.2',
      },
      ip: '10.0.0.1',
      socket: { remoteAddress: '10.9.9.9' },
    } as unknown as Request;
    const report = describeClientIpChain(req, { trustProxy: true, trustProxyHops: 1 });
    const text = JSON.stringify(report);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('Bearer');
    expect(report.forwardedFor).toEqual(['41.33.1.2', '10.0.0.1']);
    expect(report.ipByHopCount).toMatchObject({ '1': '10.0.0.1', '2': '41.33.1.2', '3': '41.33.1.2' });
    expect(report.otherAddressHeaders['true-client-ip']).toBe('41.33.1.2');
  });
});

// ---------------------------------------------------------------------------
// 2026-10-29 diagnostic fixes: long headers, every configurable hop count, and
// the expected-address comparison the verification procedure relies on.
// ---------------------------------------------------------------------------

/** An app that answers with the diagnostic itself, for any configured hop count. */
function diagnosticApp(hops: number) {
  const a = express();
  a.set('trust proxy', hops);
  a.get('/d', (req, res) => {
    res.json({
      ip: req.ip,
      report: describeClientIpChain(
        req,
        { trustProxy: true, trustProxyHops: hops },
        { expectedIp: typeof req.query.expectedIp === 'string' ? req.query.expectedIp : null },
      ),
    });
  });
  return a;
}

type Diagnosed = { ip: string; report: ReturnType<typeof describeClientIpChain> };
const diagnose = async (hops: number, xff: string, expectedIp?: string): Promise<Diagnosed> => {
  const r = request(diagnosticApp(hops)).get('/d');
  if (expectedIp !== undefined) r.query({ expectedIp });
  const res = await r.set('x-forwarded-for', xff);
  return res.body as Diagnosed;
};

describe('diagnostic with a long X-Forwarded-For (previously kept the LEFTMOST 20)', () => {
  // 30 client-written entries, then what a two-proxy platform appends.
  const spoofed = Array.from({ length: 30 }, (_, i) => `6.6.${i}.1`);
  const chain = [...spoofed, PROXY_ADDED, '172.71.0.5'];
  const xff = chain.join(', ');

  it('shows the rightmost entries - the part the platform wrote - and says it truncated', async () => {
    const { report } = await diagnose(2, xff);
    expect(report.forwardedFor).toEqual(chain.slice(-DIAGNOSTIC_FORWARDED_FOR_SHOWN));
    expect(report.forwardedFor.at(-1)).toBe('172.71.0.5');
    expect(report.forwardedFor).toContain(PROXY_ADDED);
    expect(report.forwardedForTotal).toBe(chain.length);
    expect(report.forwardedForTruncated).toBe(true);
  });

  it.each(Array.from({ length: MAX_TRUST_PROXY_HOPS }, (_, i) => i + 1))(
    'agrees with real Express at hop count %i even when the header is longer than what is shown',
    async (hops) => {
      const { ip, report } = await diagnose(hops, xff);
      expect(report.ipByHopCount[String(hops)]).toBe(ip);
    },
  );

  it('does not flag a short header as truncated', async () => {
    const { report } = await diagnose(1, `${PROXY_ADDED}, 10.0.0.1`);
    expect(report.forwardedForTruncated).toBe(false);
    expect(report.forwardedForTotal).toBe(2);
  });
});

describe('diagnostic covers every hop count the API accepts', () => {
  it('reports hop counts 1..MAX_TRUST_PROXY_HOPS', async () => {
    const { report } = await diagnose(1, '10.1.1.1');
    expect(Object.keys(report.ipByHopCount)).toEqual(
      Array.from({ length: MAX_TRUST_PROXY_HOPS }, (_, i) => String(i + 1)),
    );
  });

  it('MAX_TRUST_PROXY_HOPS is exactly what env validation and configuration allow', () => {
    const base = {
      DATABASE_URL: 'postgresql://u:p@localhost:5432/edu',
      JWT_ACCESS_SECRET: 'a'.repeat(48),
      JWT_REFRESH_SECRET: 'b'.repeat(48),
      JWT_PLAYBACK_SECRET: 'c'.repeat(48),
      MEDIA_SIGNING_KEY: 'd'.repeat(48),
      HLS_KEY_ROOT: 'e'.repeat(48),
      NODE_ENV: NodeEnv.Development,
    };
    expect(() => validateEnv({ ...base, TRUST_PROXY_HOPS: String(MAX_TRUST_PROXY_HOPS) })).not.toThrow();
    expect(() => validateEnv({ ...base, TRUST_PROXY_HOPS: String(MAX_TRUST_PROXY_HOPS + 1) })).toThrow(
      /TRUST_PROXY_HOPS/,
    );

    const saved = process.env.TRUST_PROXY_HOPS;
    try {
      process.env.TRUST_PROXY_HOPS = '99';
      expect(appConfig().trustProxyHops).toBe(MAX_TRUST_PROXY_HOPS);
    } finally {
      if (saved === undefined) delete process.env.TRUST_PROXY_HOPS;
      else process.env.TRUST_PROXY_HOPS = saved;
    }
  });
});

describe('expectedIp: the comparison the D6 procedure is built on', () => {
  const MINE = '41.33.7.7';
  const EDGE = '172.71.0.5';

  /** One call through a platform with `platformHops` proxies, optionally with a forged entry. */
  const throughPlatform = (platformHops: number, forged?: string) => {
    const appended = [MINE, ...Array.from({ length: platformHops - 1 }, (_, i) => `172.71.0.${i + 5}`)];
    return [...(forged ? [forged] : []), ...appended].join(', ');
  };

  const fromTwo = Array.from({ length: MAX_TRUST_PROXY_HOPS - 1 }, (_, i) => i + 2);

  it('lists the hop counts that resolve to the expected address', async () => {
    // One plain call cannot decide on its own: with more hops than entries
    // Express falls back to the leftmost entry, so every count from the right
    // one upwards resolves to the caller. That is why the procedure makes a
    // second call with a forged entry.
    const { report } = await diagnose(1, `${MINE}, ${EDGE}`, MINE);
    expect(report.expectedIp).toBe(MINE);
    expect(report.hopCountsMatchingExpected).toEqual(fromTwo);
  });

  it.each([1, 2, 3])(
    'a plain call plus a forged-entry call identify a %i-proxy platform uniquely',
    async (platformHops) => {
      const plain = await diagnose(1, throughPlatform(platformHops), MINE);
      const forged = await diagnose(1, throughPlatform(platformHops, '198.51.100.77'), MINE);
      const both = plain.report.hopCountsMatchingExpected.filter((h) =>
        forged.report.hopCountsMatchingExpected.includes(h),
      );
      expect(both).toEqual([platformHops]);
    },
  );

  it('when the platform discards client-written entries, several counts match and the smallest is the safe one', async () => {
    // Both calls arrive identical: the forged entry never reaches the API.
    const plain = await diagnose(1, throughPlatform(2), MINE);
    const forgedButStripped = await diagnose(1, throughPlatform(2), MINE);
    const both = plain.report.hopCountsMatchingExpected.filter((h) =>
      forgedButStripped.report.hopCountsMatchingExpected.includes(h),
    );
    expect(both.length).toBeGreaterThan(1);
    expect(Math.min(...both)).toBe(2);
  });

  it('ignores an expectedIp that is not one valid address', async () => {
    for (const bad of ['1.2.3.4, 5.6.7.8', 'not-an-ip', '']) {
      const { report } = await diagnose(1, `${MINE}, ${EDGE}`, bad);
      expect(report.expectedIp).toBeNull();
      expect(report.hopCountsMatchingExpected).toEqual([]);
    }
  });

  it('the controller passes expectedIp through and still never reads the secret', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ClientIpDiagnosticsController } = require('../../src/modules/diagnostics/client-ip-diagnostics.controller');
    const controller = new ClientIpDiagnosticsController({
      get: () => ({ trustProxy: true, trustProxyHops: 1, webProxySharedSecret: SECRET }),
    });
    const req = {
      headers: { 'x-forwarded-for': `${MINE}, ${EDGE}`, [WEB_PROXY_SECRET_HEADER]: SECRET },
      ip: EDGE,
      socket: { remoteAddress: '10.9.9.9' },
    } as unknown as Request;
    const report = controller.clientIp(req, MINE);
    expect(report.hopCountsMatchingExpected).toEqual(fromTwo);
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });
});
