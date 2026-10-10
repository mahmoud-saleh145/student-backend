import { createHmac } from 'node:crypto';

import { ConfigService } from '@nestjs/config';

import { AppException } from 'src/common/errors/app.exception';
import { GumletDrmService } from 'src/modules/playback/gumlet-drm.service';

/**
 * Regression vectors for the Gumlet signing algorithm.
 *
 * These are the SAME vectors used by the Phase 0 harness
 * (`gumlet-drm-phase0/scripts/verify-signing.mjs`), which asserts byte
 * equality against Gumlet's own JavaScript and PHP reference implementations.
 * Keeping them here means a future refactor cannot silently break signing.
 */
const ORG = 'testorg';
const ASSET = 'testasset';
const SECRET_B64 = 'c2VjcmV0LWtleS1tYXRlcmlhbC1mb3ItdGVzdGluZy1wdXJwb3Nlcy1vbmx5';
const NOW_MS = 1767225600000;
const LIFETIME = 300;

function buildConfig(overrides: Partial<Record<'orgId' | 'signSecret' | 'apiKey' | 'workspaceId' | 'tokenLifetimeSeconds', string | number>> = {}) {
  return {
    video: {
      drm: {
        enabled: true,
        provider: 'gumlet' as const,
        widevineLicenseUrl: null,
        fairplayLicenseUrl: null,
        fairplayCertUrl: null,
        providerToken: null,
        gumlet: {
          apiKey: 'test-api-key',
          workspaceId: 'testworkspace',
          orgId: ORG,
          signSecret: SECRET_B64,
          tokenLifetimeSeconds: LIFETIME,
          resolutions: ['720p', '1080p'],
          ...overrides,
        },
      },
    },
  };
}

function makeService(overrides?: Partial<Record<'orgId' | 'signSecret' | 'apiKey' | 'workspaceId', string>>) {
  const cfg = buildConfig(overrides);
  const configService = { getOrThrow: jest.fn().mockReturnValue(cfg.video) } as unknown as ConfigService;
  return new GumletDrmService(configService);
}

/** Independently reproduce Gumlet's documented reference implementation. */
function referenceToken(nowMs: number, hardwareSecure: boolean): { token: string; signedString: string } {
  const stringToSign = `/${ORG}/${ASSET}`;
  const expires = Math.round(nowMs + LIFETIME * 1000);
  const queryparams = new URLSearchParams();
  queryparams.set('expires', String(expires));
  if (hardwareSecure) queryparams.set('hardware_secure', 'true');
  const signedString = `${stringToSign}?${queryparams.toString()}`;
  const token = createHmac('sha1', Buffer.from(SECRET_B64, 'base64')).update(signedString).digest('hex');
  return { token, signedString };
}

describe('GumletDrmService signing', () => {
  let service: GumletDrmService;

  beforeEach(() => {
    service = makeService();
    jest.useFakeTimers().setSystemTime(new Date(NOW_MS));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('matches the Phase 0 reference implementation with hardware_secure=true', () => {
    const bundle = service.signLicenseUrl({ assetId: ASSET, hardwareSecure: true });
    const ref = referenceToken(NOW_MS, true);

    expect(bundle.signedString ?? buildSigned(bundle)).toBe(ref.signedString);
    expect(tokenFromUrl(bundle.licenseUrl)).toBe(ref.token);
  });

  it('matches the Phase 0 reference implementation with hardware_secure=false', () => {
    const bundle = service.signLicenseUrl({ assetId: ASSET, hardwareSecure: false });
    const ref = referenceToken(NOW_MS, false);

    expect(buildSigned(bundle)).toBe(ref.signedString);
    expect(tokenFromUrl(bundle.licenseUrl)).toBe(ref.token);
  });

  it('changes the token when hardware_secure changes', () => {
    const on = service.signLicenseUrl({ assetId: ASSET, hardwareSecure: true });
    const off = service.signLicenseUrl({ assetId: ASSET, hardwareSecure: false });
    expect(tokenFromUrl(on.licenseUrl)).not.toBe(tokenFromUrl(off.licenseUrl));
  });

  it('omits hardware_secure entirely when false', () => {
    const bundle = service.signLicenseUrl({ assetId: ASSET, hardwareSecure: false });
    expect(bundle.licenseUrl).not.toContain('hardware_secure');
  });

  it('signs the asset path without embedding the token in the signed string', () => {
    const bundle = service.signLicenseUrl({ assetId: ASSET, hardwareSecure: true });
    expect(bundle.signedString.startsWith(`/${ORG}/${ASSET}?`)).toBe(true);
    // The token must not be part of the string that was HMAC'd.
    expect(bundle.signedString).not.toContain('token=');
    const reconstructed = bundle.licenseUrl.split('?')[0];
    expect(reconstructed).toBe(`https://widevine.gumlet.com/licence/${ORG}/${ASSET}`);
  });

  it('expires is milliseconds since epoch', () => {
    const bundle = service.signLicenseUrl({ assetId: ASSET });
    expect(bundle.expires).toBe(NOW_MS + LIFETIME * 1000);
  });

  it('token is 40 hex chars (HMAC-SHA1, 160-bit)', () => {
    const bundle = service.signLicenseUrl({ assetId: ASSET });
    expect(tokenFromUrl(bundle.licenseUrl)).toMatch(/^[0-9a-f]{40}$/);
  });

  it('requests L1 with no software fallback', () => {
    const bundle = service.signLicenseUrl({ assetId: ASSET, hardwareSecure: true });
    expect(bundle.videoRobustness).toEqual(['HW_SECURE_ALL']);
    expect(bundle.audioRobustness).toEqual(['HW_SECURE_ALL']);
  });
});

describe('GumletDrmService fail-closed behaviour', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date(NOW_MS)));
  afterEach(() => jest.useRealTimers());

  it('refuses to sign without an org id', () => {
    const svc = makeService({ orgId: '' });
    expect(() => svc.signLicenseUrl({ assetId: ASSET })).toThrow(AppException);
  });

  it('refuses to sign without a signing secret', () => {
    const svc = makeService({ signSecret: '' });
    expect(() => svc.signLicenseUrl({ assetId: ASSET })).toThrow(AppException);
  });

  it('refuses to sign for an empty asset id', () => {
    const svc = makeService();
    expect(() => svc.signLicenseUrl({ assetId: '' })).toThrow(AppException);
  });

  it('never exposes the sign secret in the bundle it returns', () => {
    const svc = makeService();
    const bundle = svc.signLicenseUrl({ assetId: ASSET });
    const serialised = JSON.stringify(bundle);
    expect(serialised).not.toContain(SECRET_B64);
    expect(serialised).not.toContain('GUMLET_SIGN_SECRET');
  });

  it('reports a fingerprint only, never the secret', () => {
    const svc = makeService();
    const fp = svc.signSecretFingerprint();
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
    expect(fp).not.toContain(SECRET_B64);
  });

  it('dashManifestUrl prefers the stored workspace id', () => {
    const svc = makeService();
    expect(svc.dashManifestUrl({ assetId: ASSET, workspaceId: 'storedws' })).toBe(
      `https://video.gumlet.io/storedws/${ASSET}/main.mpd`,
    );
  });
});

// --- helpers ---------------------------------------------------------------

function tokenFromUrl(url: string): string {
  return new URL(url).searchParams.get('token') ?? '';
}

function buildSigned(bundle: { licenseUrl: string; hardwareSecure: boolean }): string {
  const u = new URL(bundle.licenseUrl);
  // The license URL is .../licence/{org}/{asset}; Gumlet signs only
  // /{org}/{asset}, so strip the prefix before reconstructing.
  const signedPath = u.pathname.replace(/^\/licence(?=\/)/, '');
  const q = new URLSearchParams();
  q.set('expires', u.searchParams.get('expires')!);
  if (bundle.hardwareSecure) q.set('hardware_secure', 'true');
  return signedPath + '?' + q.toString();
}
