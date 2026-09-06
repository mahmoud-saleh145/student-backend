/**
 * Executes the REAL StorageService signing/verification pair and the REAL
 * MediaOriginController guard helpers.
 *
 * The S3 client is never contacted: signMediaUrl and verifyMediaSignature are
 * pure crypto over configuration, which is exactly the part that has to be
 * right for a copied URL to fail.
 */
const path = require('path');
const OUT = path.join(__dirname, 'out/src');

const { StorageService } = require(path.join(OUT, 'modules/storage/storage.service.js'));
const { MediaOriginController } = require(path.join(OUT, 'modules/playback/media-origin.controller.js'));

const SIGNING_KEY = 'test-media-signing-key-at-least-32-characters';

process.env.PUBLIC_API_URL = 'http://10.0.2.2:3000';
process.env.API_PREFIX = 'api';
process.env.API_VERSION = '1';

function makeStorage({ cdnBaseUrl = '', localOrigin = true } = {}) {
  return new StorageService({
    getOrThrow: () => ({
      accountId: undefined,
      accessKeyId: '', secretAccessKey: '', region: 'auto', endpoint: undefined,
      buckets: { media: 'edu-media-dev', uploads: 'edu-uploads-dev' },
      cdnBaseUrl, signingKey: SIGNING_KEY, localOrigin, forcePathStyle: true,
    }),
  });
}

let pass = 0, fail = 0;
const fails = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; fails.push(label); console.log(`  FAIL ${label}\n         expected ${JSON.stringify(expected)}\n         actual   ${JSON.stringify(actual)}`); }
}

const VIEWER = {
  objectKey: 'hls/vid_1/720p/seg00042.ts',
  expiresInSeconds: 300,
  userId: 'usr_stud',
  sessionId: 'ses_1',
  deviceId: 'dev_bound',
  ticketId: 'tkt_1',
  maxHeight: 720,
};

function parse(url) {
  const u = new URL(url);
  const q = Object.fromEntries(u.searchParams.entries());
  // Everything after the /playback/media/ (or CDN root) prefix is the key.
  const key = decodeURIComponent(u.pathname.replace(/^.*?\/playback\/media\//, '').replace(/^\/+/, ''));
  return { u, q, key };
}

(async () => {
  console.log('=== Media URL signing and origin verification (real code) ===\n');

  console.log('── local origin (no CDN configured)');
  const local = makeStorage({ cdnBaseUrl: '', localOrigin: true });
  check('reports it serves media itself', local.servesMediaLocally, true);

  const url = await local.signMediaUrl(VIEWER);
  const { u, q, key } = parse(url);

  check('URL points at this API, not at S3', u.host, '10.0.2.2:3000');
  check('URL is under the media origin route', u.pathname.includes('/api/v1/playback/media/'), true);
  check('object key survives round-trip', key, VIEWER.objectKey);
  check('viewer identity is in the query', [q.uid, q.sid, q.did, q.tid], ['usr_stud', 'ses_1', 'dev_bound', 'tkt_1']);
  check('quality ceiling is carried', q.mh, '720');
  check('no AWS presign parameters present', /X-Amz-Signature/.test(url), false);

  const verifyArgs = {
    objectKey: key, expiresAt: Number(q.exp), userId: q.uid,
    sessionId: q.sid, deviceId: q.did, ticketId: q.tid,
    maxHeight: Number(q.mh), signature: q.sig,
  };
  check('the origin accepts its own signature', local.verifyMediaSignature(verifyArgs), true);

  console.log('\n── tamper rejection (this is what makes a copied URL useless)');
  check('different user rejected', local.verifyMediaSignature({ ...verifyArgs, userId: 'usr_other' }), false);
  check('different device rejected', local.verifyMediaSignature({ ...verifyArgs, deviceId: 'dev_other' }), false);
  check('different session rejected', local.verifyMediaSignature({ ...verifyArgs, sessionId: 'ses_other' }), false);
  check('different ticket rejected', local.verifyMediaSignature({ ...verifyArgs, ticketId: 'tkt_other' }), false);
  check('different object key rejected', local.verifyMediaSignature({ ...verifyArgs, objectKey: 'hls/vid_2/720p/seg00042.ts' }), false);
  check('raised quality ceiling rejected', local.verifyMediaSignature({ ...verifyArgs, maxHeight: 1080 }), false);
  check('extended expiry rejected', local.verifyMediaSignature({ ...verifyArgs, expiresAt: verifyArgs.expiresAt + 3600 }), false);
  check('elapsed expiry rejected even with a valid signature', local.verifyMediaSignature({
    ...verifyArgs,
    ...(() => {
      const past = Math.floor(Date.now() / 1000) - 10;
      return { expiresAt: past };
    })(),
  }), false);
  check('mangled signature rejected', local.verifyMediaSignature({ ...verifyArgs, signature: `${q.sig.slice(0, -1)}X` }), false);
  check('empty signature rejected', local.verifyMediaSignature({ ...verifyArgs, signature: '' }), false);

  console.log('\n── a second server with a different key cannot forge one');
  const other = makeStorage({ cdnBaseUrl: '', localOrigin: true });
  other.cfg = { ...other.cfg, signingKey: 'a-completely-different-signing-key-value!!' };
  const forged = await other.signMediaUrl(VIEWER);
  check('forged signature rejected by the real key',
    local.verifyMediaSignature({ ...verifyArgs, signature: parse(forged).q.sig }), false);

  console.log('\n── CDN mode keeps the same contract');
  const cdn = makeStorage({ cdnBaseUrl: 'https://media.example.com/', localOrigin: false });
  check('does not claim to serve media locally', cdn.servesMediaLocally, false);
  const cdnUrl = await cdn.signMediaUrl(VIEWER);
  const cdnParsed = new URL(cdnUrl);
  check('URL points at the CDN', cdnParsed.host, 'media.example.com');
  check('same signature the Worker will recompute',
    cdn.verifyMediaSignature({
      objectKey: VIEWER.objectKey,
      expiresAt: Number(cdnParsed.searchParams.get('exp')),
      userId: 'usr_stud', sessionId: 'ses_1', deviceId: 'dev_bound',
      ticketId: 'tkt_1', maxHeight: 720,
      signature: cdnParsed.searchParams.get('sig'),
    }), true);

  console.log('\n── refuses to degrade when nothing is configured');
  const none = makeStorage({ cdnBaseUrl: '', localOrigin: false });
  let threw = null;
  try { await none.signMediaUrl(VIEWER); } catch (e) { threw = e.code ?? e.message; }
  check('no origin => throws rather than issuing an unbound URL', threw, 'STORAGE_UNAVAILABLE');

  console.log('\n── origin guard helpers');
  check('rendition height parsed', MediaOriginController.renditionHeight('hls/v/720p/s.ts'), 720);
  check('height absent when not in the key', MediaOriginController.renditionHeight('hls/v/master.m3u8'), null);
  check('1080 parsed', MediaOriginController.renditionHeight('hls/v/1080p/s.ts'), 1080);
  check('playlist content type', MediaOriginController.contentTypeFor('a/master.m3u8'), 'application/vnd.apple.mpegurl');
  check('segment content type', MediaOriginController.contentTypeFor('a/seg1.ts'), 'video/mp2t');
  check('unknown type is not guessed', MediaOriginController.contentTypeFor('a/x.bin'), 'application/octet-stream');

  console.log(`\n${'='.repeat(60)}`);
  console.log(`passed: ${pass}   failed: ${fail}`);
  if (fails.length) { console.log('\nFAILED:'); fails.forEach((f) => console.log('  -', f)); }
  process.exit(fail === 0 ? 0 : 1);
})();
