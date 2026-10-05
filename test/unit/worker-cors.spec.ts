import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The media Worker is plain JS served to Cloudflare, so it is loaded here as a
 * module rather than imported through the Nest graph.
 */
async function loadWorker(): Promise<{
  fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>;
}> {
  const source = readFileSync(join(process.cwd(), 'docs/cloudflare-worker.js'), 'utf8');
  // Jest runs CommonJS and will not resolve a data: module, so the one ESM
  // construct in the file is rewritten and the rest is evaluated as-is. The
  // Worker's globals — Request, Response, Headers, crypto — are all Node's.
  const commonjs = source.replace('export default {', 'module.exports = {');
  const module = { exports: {} as Record<string, unknown> };
  const factory = new Function('module', 'exports', commonjs);
  factory(module, module.exports);
  return module.exports as never;
}

const ENV = {
  MEDIA: null,
  MEDIA_SIGNING_KEY: 'test-key',
  WEB_ORIGINS: 'https://app.example.com,http://localhost:3002',
};
const CTX = { waitUntil() {} };

async function request(method: string, origin?: string) {
  const worker = await loadWorker();
  return worker.fetch(
    new Request('https://media.test/library/doc.pdf?exp=1&uid=u&sig=s', {
      method,
      headers: origin ? { origin } : {},
    }),
    ENV,
    CTX
  );
}

describe('media Worker — cross-origin reads', () => {
  it('leaves a request without an Origin exactly as it was', async () => {
    // The mobile app, curl and a bare <video> send no Origin. They worked
    // before this allowance existed and must be untouched by it.
    const res = await request('GET');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('cross-origin-resource-policy')).toBeNull();
  });

  it('lets an allowlisted web origin read the response', async () => {
    // Without this, hls.js and pdf.js are blocked by the same-origin policy
    // before the signature is ever checked — web video and documents simply
    // never load.
    const res = await request('GET', 'http://localhost:3002');
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3002');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(res.headers.get('vary')).toContain('Origin');
  });

  it('refuses an origin that is not on the list', async () => {
    const res = await request('GET', 'https://evil.example');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('never echoes a wildcard', async () => {
    for (const origin of ['http://localhost:3002', 'https://app.example.com']) {
      const res = await request('GET', origin);
      expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
    }
  });

  it('answers the preflight that a Range request triggers', async () => {
    const res = await request('OPTIONS', 'http://localhost:3002');
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toContain('range');
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3002');
  });

  it('does not answer a preflight from anywhere else', async () => {
    const res = await request('OPTIONS', 'https://evil.example');
    expect(res.status).toBe(405);
  });

  it('keeps the deny reason readable by the browser', async () => {
    // A blocked web player otherwise reports an opaque network failure instead
    // of the actual reason, which is what made this class of bug so slow to find.
    const res = await request('GET', 'http://localhost:3002');
    expect(res.headers.get('access-control-expose-headers')).toContain('x-deny-reason');
  });
});
