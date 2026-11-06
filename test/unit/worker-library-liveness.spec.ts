import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { StorageService } from '../../src/modules/storage/storage.service';

/**
 * The media Worker's Library liveness contract (Phase 1, B1 and section 3 of
 * the plan). The REAL Worker source is evaluated, and every URL it sees is
 * signed by the REAL server signer (`StorageService.signMediaUrl`), so these
 * tests also prove the two sides build the same HMAC canonical string.
 *
 *   lib_   OWNED    fails closed on everything but an explicit live === true
 *   libp_  PREVIEW  fails closed in the same way
 *   other  video/attachment  unchanged, probe URL byte-for-byte as before
 */

const SIGNING_KEY = 'test-signing-key';
const API = 'https://api.test';

function loadWorker(): { fetch(req: Request, env: unknown, ctx: unknown): Promise<Response> } {
  const source = readFileSync(join(process.cwd(), 'docs/cloudflare-worker.js'), 'utf8');
  const commonjs = source.replace('export default {', 'module.exports = {');
  const module = { exports: {} as Record<string, unknown> };
  new Function('module', 'exports', commonjs)(module, module.exports);
  return module.exports as never;
}

/** The server signer, without the S3 client it never needs for signing. */
function signer(): StorageService {
  const storage = Object.create(StorageService.prototype) as StorageService;
  (storage as unknown as { cfg: unknown }).cfg = {
    cdnBaseUrl: 'https://media.test',
    signingKey: SIGNING_KEY,
  };
  return storage;
}

async function sign(params: {
  tid: string;
  uid?: string;
  sid?: string | null;
  did?: string | null;
  ttl?: number;
  objectKey?: string;
}): Promise<string> {
  return signer().signMediaUrl({
    objectKey: params.objectKey ?? 'library/doc.pdf',
    expiresInSeconds: params.ttl ?? 300,
    userId: params.uid ?? 'usr_1',
    sessionId: params.sid === undefined ? 'ses_1' : params.sid,
    deviceId: params.did === undefined ? 'dev_1' : params.did,
    ticketId: params.tid,
  });
}

function bucket() {
  return {
    get: jest.fn(async () => ({
      body: 'PDF-BYTES',
      size: 9,
      httpEtag: '"etag"',
      range: undefined,
      writeHttpMetadata() {},
    })),
  };
}

/** A per-test Cache API stand-in. */
function cacheStub() {
  const store = new Map<string, string>();
  const stub = {
    store,
    match: jest.fn(async (req: Request) => {
      const body = store.get(req.url);
      return body === undefined ? undefined : new Response(body);
    }),
    put: jest.fn(async (req: Request, res: Response) => {
      store.set(req.url, await res.text());
      stub.lastCacheControl = res.headers.get('cache-control');
    }),
    lastCacheControl: null as string | null,
  };
  return stub;
}

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

let cache: ReturnType<typeof cacheStub>;
let apiFetch: jest.Mock<ReturnType<FetchImpl>, Parameters<FetchImpl>>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  cache = cacheStub();
  (globalThis as unknown as { caches: unknown }).caches = { default: cache };
  apiFetch = jest.fn();
  globalThis.fetch = apiFetch as never;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

function env(overrides: Record<string, unknown> = {}) {
  return {
    MEDIA: bucket(),
    LIBRARY: bucket(),
    MEDIA_SIGNING_KEY: SIGNING_KEY,
    TICKET_CHECK: 'true',
    API_ORIGIN: API,
    WEB_ORIGINS: '',
    ...overrides,
  };
}

async function hit(url: string, e = env()) {
  const pending: Promise<unknown>[] = [];
  const res = await loadWorker().fetch(new Request(url), e, {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
  });
  await Promise.all(pending);
  return res;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const LIVE = () => json({ success: true, data: { live: true } });
const DEAD = () => json({ success: true, data: { live: false } });

const LIBRARY_TICKETS = ['lib_part1', 'libp_part1'];
const EDGE_SECRET = 'edge-secret-value-used-only-in-this-test';

describe('Worker — Library preview tickets (libp_) fail closed', () => {
  it('serves only on an explicit live === true (H1: server and Worker signatures agree)', async () => {
    apiFetch.mockImplementation(async () => LIVE());
    const res = await hit(await sign({ tid: 'libp_part1' }));
    expect(res.status).toBe(200);
  });

  it('W1: storefront off (API says live:false) is denied', async () => {
    apiFetch.mockImplementation(async () => DEAD());
    const res = await hit(await sign({ tid: 'libp_part1' }));
    expect(res.status).toBe(403);
    expect(res.headers.get('x-deny-reason')).toBe('ticket_revoked');
  });

  const failures: Array<[string, () => Promise<Response>]> = [
    ['network error', async () => { throw new TypeError('network'); }],
    ['timeout (AbortError)', async () => { throw new DOMException('timeout', 'TimeoutError'); }],
    ['500', async () => json({ error: 'x' }, 500)],
    ['502', async () => new Response('bad gateway', { status: 502 })],
    ['503', async () => json({ error: 'x' }, 503)],
    ['429 from the throttle', async () => json({ error: 'x' }, 429)],
    ['401 from a wrong or missing secret', async () => json({ error: 'x' }, 401)],
    ['302 to an HTML page', async () => new Response(null, { status: 302, headers: { location: '/login' } })],
    ['200 with HTML', async () => new Response('<html>maintenance</html>', { status: 200 })],
    ['200 {}', async () => json({})],
    ['200 live:"true" (string)', async () => json({ live: 'true' })],
    ['200 data.live:null', async () => json({ data: { live: null } })],
    ['204 no body', async () => new Response(null, { status: 204 })],
  ];

  describe.each(LIBRARY_TICKETS)('%s', (tid) => {
    it.each(failures)('W2/W3/W4: %s is denied, as unverifiable, and serves nothing', async (_name, impl) => {
      apiFetch.mockImplementation(impl as never);
      const e = env();
      const res = await hit(await sign({ tid }), e);
      expect(res.status).toBe(503);
      expect(res.headers.get('x-deny-reason')).toBe('ticket_unverifiable');
      expect(e.LIBRARY.get).not.toHaveBeenCalled();
      expect(e.MEDIA.get).not.toHaveBeenCalled();
      // A failed or unclear probe is never cached.
      expect(cache.store.size).toBe(0);
    });

    it('W6: TICKET_CHECK unset is denied without asking the API', async () => {
      const res = await hit(await sign({ tid }), env({ TICKET_CHECK: undefined }));
      expect(res.status).toBe(503);
      expect(res.headers.get('x-deny-reason')).toBe('ticket_unverifiable');
      expect(apiFetch).not.toHaveBeenCalled();
    });

    it('W6: API_ORIGIN missing is denied', async () => {
      const res = await hit(await sign({ tid }), env({ API_ORIGIN: '' }));
      expect(res.status).toBe(503);
      expect(apiFetch).not.toHaveBeenCalled();
    });

    it('a clear live:false is a refusal, not a hiccup', async () => {
      apiFetch.mockImplementation(async () => DEAD());
      const res = await hit(await sign({ tid }));
      expect(res.status).toBe(403);
      expect(res.headers.get('x-deny-reason')).toBe('ticket_revoked');
    });

    it('a clear live:true serves the document, privately', async () => {
      apiFetch.mockImplementation(async () => LIVE());
      const res = await hit(await sign({ tid }));
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toContain('no-store');
    });

    it('an expired URL is refused before any probe', async () => {
      const res = await hit(await sign({ tid, ttl: -10 }));
      expect(res.status).toBe(403);
      expect(res.headers.get('x-deny-reason')).toBe('expired');
      expect(apiFetch).not.toHaveBeenCalled();
    });

    it.each(['uid', 'sid', 'did', 'exp'])('tampering with %s breaks the signature, before any probe', async (field) => {
      const url = new URL(await sign({ tid }));
      url.searchParams.set(field, field === 'exp' ? String(Math.floor(Date.now() / 1000) + 9000) : 'someone_else');
      const res = await hit(url.toString());
      expect(res.status).toBe(403);
      expect(res.headers.get('x-deny-reason')).toBe('bad_signature');
      expect(apiFetch).not.toHaveBeenCalled();
    });

    it('asks about the session and device in the signed URL', async () => {
      apiFetch.mockImplementation(async () => LIVE());
      await hit(await sign({ tid, sid: 'ses_9', did: 'dev_9' }));
      const [url, init] = apiFetch.mock.calls[0];
      expect(url).toBe(`${API}/api/v1/playback/tickets/${tid}/state?uid=usr_1&sid=ses_9&did=dev_9`);
      expect((init as RequestInit).redirect).toBe('manual');
    });
  });

  it('a URL signed with no session asks with an empty one, which the API refuses', async () => {
    apiFetch.mockImplementation(async () => DEAD());
    const res = await hit(await sign({ tid: 'lib_part1', sid: null, did: null }));
    expect(res.status).toBe(403);
    expect(apiFetch.mock.calls[0][0]).toBe(`${API}/api/v1/playback/tickets/lib_part1/state?uid=usr_1&sid=&did=`);
  });

  it('asks the API with the bound session and device, without following redirects', async () => {
    apiFetch.mockImplementation(async () => LIVE());
    await hit(await sign({ tid: 'libp_part1', sid: 'ses_9', did: 'dev_9' }));
    const [url, init] = apiFetch.mock.calls[0];
    expect(url).toBe(`${API}/api/v1/playback/tickets/libp_part1/state?uid=usr_1&sid=ses_9&did=dev_9`);
    expect((init as RequestInit).redirect).toBe('manual');
  });

  it('caches a clear answer for at most 10 seconds', async () => {
    apiFetch.mockImplementation(async () => LIVE());
    await hit(await sign({ tid: 'libp_part1' }));
    expect(cache.lastCacheControl).toBe('max-age=10');
  });
});

describe('Worker — cache isolation (K1–K5)', () => {
  it('K1: the same ticket for another user is a separate probe', async () => {
    apiFetch.mockImplementation(async () => LIVE());
    await hit(await sign({ tid: 'libp_part1', uid: 'usr_1' }));
    await hit(await sign({ tid: 'libp_part1', uid: 'usr_2' }));
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(cache.store.size).toBe(2);
  });

  it('K2: the same ticket and user on another session or device is a separate probe', async () => {
    apiFetch.mockImplementation(async () => LIVE());
    await hit(await sign({ tid: 'lib_part1', sid: 'ses_1', did: 'dev_1' }));
    await hit(await sign({ tid: 'lib_part1', sid: 'ses_2', did: 'dev_1' }));
    await hit(await sign({ tid: 'lib_part1', sid: 'ses_1', did: 'dev_2' }));
    expect(apiFetch).toHaveBeenCalledTimes(3);
    expect(new Set(apiFetch.mock.calls.map((c) => c[0])).size).toBe(3);
  });

  it('K3: a dead answer for one session is not reused for another', async () => {
    apiFetch
      .mockImplementationOnce(async () => DEAD())
      .mockImplementationOnce(async () => LIVE());
    expect((await hit(await sign({ tid: 'libp_part1', sid: 'revoked' }))).status).toBe(403);
    expect((await hit(await sign({ tid: 'libp_part1', sid: 'active' }))).status).toBe(200);
  });

  it('K4: a cached live answer is served from cache for its window', async () => {
    apiFetch.mockImplementation(async () => LIVE());
    const url = await sign({ tid: 'libp_part1' });
    await hit(url);
    apiFetch.mockImplementation(async () => DEAD());
    expect((await hit(url)).status).toBe(200);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('K5: a cached dead answer denies without asking again', async () => {
    apiFetch.mockImplementation(async () => DEAD());
    const url = await sign({ tid: 'lib_part1' });
    await hit(url);
    apiFetch.mockImplementation(async () => LIVE());
    expect((await hit(url)).status).toBe(403);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
});

describe('Worker — the liveness secret', () => {
  const tickets: Array<[string, { tid: string; objectKey?: string }]> = [
    ['owned', { tid: 'lib_part1' }],
    ['preview', { tid: 'libp_part1' }],
    ['attachment', { tid: 'att_a1', objectKey: 'attachments/c1/x.pdf' }],
    ['video', { tid: 'ckvideoticket1', objectKey: 'hls/v1/720p/seg1.ts' }],
  ];

  it.each(tickets)('a %s probe sends it as a header, never in the URL, and follows no redirect', async (_name, t) => {
    apiFetch.mockImplementation(async () => LIVE());
    await hit(await sign(t), env({ EDGE_LIVENESS_SECRET: EDGE_SECRET }));
    const [url, init] = apiFetch.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ 'x-edge-secret': EDGE_SECRET });
    expect((init as RequestInit).redirect).toBe('manual');
    expect(url).not.toContain(EDGE_SECRET);
  });

  it.each(tickets)('a %s probe sends no secret header when none is configured', async (_name, t) => {
    apiFetch.mockImplementation(async () => LIVE());
    await hit(await sign(t));
    const headers = apiFetch.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers).not.toHaveProperty('x-edge-secret');
  });

  it.each(tickets)('a %s URL handed to the client never carries the secret, and neither does the response', async (_name, t) => {
    apiFetch.mockImplementation(async () => LIVE());
    const res = await hit(await sign(t), env({ EDGE_LIVENESS_SECRET: EDGE_SECRET }));
    expect(JSON.stringify([...res.headers.entries()])).not.toContain(EDGE_SECRET);
    expect([...cache.store.keys(), ...cache.store.values()].join()).not.toContain(EDGE_SECRET);
  });

  it('a wrong secret (the API answers 401) refuses an owned document', async () => {
    apiFetch.mockImplementation(async () => json({ error: { code: 'UNAUTHORIZED' } }, 401));
    const e = env({ EDGE_LIVENESS_SECRET: 'wrong' });
    const res = await hit(await sign({ tid: 'lib_part1' }), e);
    expect(res.status).toBe(503);
    expect(e.LIBRARY.get).not.toHaveBeenCalled();
  });
});

describe('Worker — owned Library tickets no longer fail open', () => {
  it('W10′: an owned ticket is refused when the API is unreachable', async () => {
    apiFetch.mockImplementation(async () => {
      throw new TypeError('network');
    });
    expect((await hit(await sign({ tid: 'lib_part1' }))).status).toBe(503);
  });

  it('an owned ticket the API reports dead (e.g. revoked entitlement) is denied', async () => {
    apiFetch.mockImplementation(async () => DEAD());
    const res = await hit(await sign({ tid: 'lib_part1' }));
    expect(res.status).toBe(403);
    expect(res.headers.get('x-deny-reason')).toBe('ticket_revoked');
  });

  it('an owned ticket on a 5xx is refused', async () => {
    apiFetch.mockImplementation(async () => json({}, 503));
    expect((await hit(await sign({ tid: 'lib_part1' }))).status).toBe(503);
  });
});

describe('Worker — video and attachment tickets keep their behaviour', () => {
  it('a video ticket is still served on a 5xx, a 429 and a 401', async () => {
    for (const status of [500, 503, 429, 401]) {
      apiFetch.mockImplementation(async () => json({}, status));
      const url = await sign({ tid: 'ckvideoticket1', objectKey: 'hls/v1/720p/seg1.ts' });
      expect((await hit(url)).status).toBe(200);
    }
  });

  it('an attachment ticket is still served on an outage, and still refused on 403 and 404', async () => {
    const url = await sign({ tid: 'att_a1', objectKey: 'attachments/c1/x.pdf' });
    apiFetch.mockImplementation(async () => {
      throw new TypeError('network');
    });
    expect((await hit(url)).status).toBe(200);
    for (const status of [403, 404]) {
      apiFetch.mockImplementation(async () => json({}, status));
      expect((await hit(url)).status).toBe(403);
    }
  });

  it('W13′: a video ticket probe URL is unchanged (no sid/did), and fails open as before', async () => {
    apiFetch.mockImplementation(async () => {
      throw new TypeError('network');
    });
    const res = await hit(await sign({ tid: 'ckvideoticket1', objectKey: 'hls/v1/720p/seg1.ts' }));
    expect(res.status).toBe(200);
    expect(apiFetch.mock.calls[0][0]).toBe(
      `${API}/api/v1/playback/tickets/ckvideoticket1/state?uid=usr_1`,
    );
  });

  it('an attachment ticket probe URL is unchanged', async () => {
    apiFetch.mockImplementation(async () => LIVE());
    await hit(await sign({ tid: 'att_a1', objectKey: 'attachments/c1/x.pdf' }));
    expect(apiFetch.mock.calls[0][0]).toBe(`${API}/api/v1/playback/tickets/att_a1/state?uid=usr_1`);
  });
});

describe('Worker — ticket type integrity (H2) and expiry (W7)', () => {
  it('W7: an expired URL is refused before any liveness probe', async () => {
    const url = new URL(await sign({ tid: 'libp_part1' }));
    url.searchParams.set('exp', String(Math.floor(Date.now() / 1000) - 1));
    const res = await hit(url.toString());
    expect(res.status).toBe(403);
    expect(res.headers.get('x-deny-reason')).toBe('expired');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('W12: turning a preview ticket into an owned one breaks the signature', async () => {
    const url = new URL(await sign({ tid: 'libp_part1' }));
    url.searchParams.set('tid', 'lib_part1');
    const res = await hit(url.toString());
    expect(res.status).toBe(403);
    expect(res.headers.get('x-deny-reason')).toBe('bad_signature');
  });

  it('turning an owned ticket into a preview one breaks the signature', async () => {
    const url = new URL(await sign({ tid: 'lib_part1' }));
    url.searchParams.set('tid', 'libp_part1');
    expect((await hit(url.toString())).headers.get('x-deny-reason')).toBe('bad_signature');
  });

  it('a newline smuggled into sid cannot re-split the signed fields', async () => {
    const url = new URL(await sign({ tid: 'libp_part1', sid: 'ses_1', did: 'dev_1' }));
    // Move the device into the session field and empty the ticket, which
    // would skip the liveness check if the canonical string still matched.
    url.searchParams.set('sid', 'ses_1\ndev_1');
    url.searchParams.set('did', 'libp_part1');
    url.searchParams.delete('tid');
    expect((await hit(url.toString())).headers.get('x-deny-reason')).toBe('bad_signature');
  });

  it('a second tid parameter does not override the signed one', async () => {
    const url = (await sign({ tid: 'libp_part1' })) + '&tid=lib_part1';
    apiFetch.mockImplementation(async () => LIVE());
    const res = await hit(url);
    // URLSearchParams.get returns the first (signed) value; the probe is for it.
    expect(res.status).toBe(200);
    expect(apiFetch.mock.calls[0][0]).toContain('/tickets/libp_part1/');
  });
});
