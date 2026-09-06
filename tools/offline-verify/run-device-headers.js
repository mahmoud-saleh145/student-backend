/**
 * Executes the REAL RequestContextMiddleware against the exact header set
 * edu-mobile/src/services/device.ts sends.
 *
 * Header-name drift between the two projects is invisible to a typechecker
 * and produces a confusing runtime symptom: every protected request is
 * refused as "unauthorised device" on a device that is in fact bound.
 */
const path = require('path');
const OUT = path.join(__dirname, 'out/src');
const { RequestContextMiddleware } = require(path.join(OUT, 'common/middleware/request-context.middleware.js'));

const mw = new RequestContextMiddleware();

// Exactly what deviceHeaders() produces, including the URL-encoded name.
const SENT = {
  'X-Device-Id': 'opaque-keystore-derived-id',
  'X-Device-Platform': 'ios',
  'X-Device-Model': 'iPhone15,2',
  'X-Device-Name': encodeURIComponent('هاتف يوسف'),
  'X-Device-Os': '17.2',
  'X-App-Version': '1.0.0',
  'X-App-Build': '42',
  'X-Device-Integrity': 'ok',
  'Accept-Language': 'ar',
  'X-Request-Id': 'req-abc',
};

function request(headers) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { header: (n) => lower[n.toLowerCase()], headers: lower };
}

let pass = 0, fail = 0; const fails = [];
const check = (label, a, e) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; fails.push(label); console.log(`  FAIL ${label}\n         expected ${JSON.stringify(e)}\n         actual   ${JSON.stringify(a)}`); }
};

console.log('=== Device header contract (real middleware, real header names) ===\n');

const req = request(SENT);
const res = { setHeader() {} };
mw.use(req, res, () => {});

check('device key read', req.deviceContext.deviceKey, 'opaque-keystore-derived-id');
check('platform read', req.deviceContext.platform, 'ios');
check('model read', req.deviceContext.model, 'iPhone15,2');
check('Arabic device name decoded, not stored percent-encoded',
  req.deviceContext.name, 'هاتف يوسف');
check('os version read', req.deviceContext.osVersion, '17.2');
check('app version read', req.deviceContext.appVersion, '1.0.0');
check('app build read', req.deviceContext.appBuild, '42');
check('integrity "ok" is not suspect', req.deviceContext.integritySuspect, false);
check('locale honoured', req.locale, 'ar');
check('client request id preserved', req.requestId, 'req-abc');

const suspect = request({ ...SENT, 'X-Device-Integrity': 'suspect' });
mw.use(suspect, res, () => {});
check('integrity "suspect" is flagged', suspect.deviceContext.integritySuspect, true);

const bare = request({});
mw.use(bare, res, () => {});
check('absent device headers => nulls, not crashes', bare.deviceContext.deviceKey, null);
check('absent locale defaults to en', bare.locale, 'en');
check('missing request id is generated', typeof bare.requestId === 'string' && bare.requestId.length > 10, true);

const stuffed = request({ ...SENT, 'X-Device-Id': 'x'.repeat(5000) });
mw.use(stuffed, res, () => {});
check('header stuffing truncated', stuffed.deviceContext.deviceKey.length, 256);

const badEncoding = request({ ...SENT, 'X-Device-Name': '%E0%A4%A' });
mw.use(badEncoding, res, () => {});
check('malformed percent-encoding does not throw', typeof badEncoding.deviceContext.name, 'string');

console.log(`\npassed: ${pass}   failed: ${fail}`);
if (fails.length) { console.log('FAILED:'); fails.forEach((f) => console.log('  -', f)); }
process.exit(fail === 0 ? 0 : 1);
