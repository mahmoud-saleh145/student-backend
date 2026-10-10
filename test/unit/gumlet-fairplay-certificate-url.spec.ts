import { GumletDrmService } from 'src/modules/playback/gumlet-drm.service';

/**
 * The FairPlay certificate URL, pinned to the form the account actually shows.
 *
 * Gumlet's published material contradicts itself on this one field:
 *
 *   - the prefix declaration reads `.../certificate/<ORG_ID>`
 *   - the runnable JS sample prints `.../certificate/<ORG_ID>/`
 *   - the runnable PHP sample prints `.../certificate/<ORG_ID>/`
 *   - the DRM Credentials page on a real account displays `.../certificate/<ORG_ID>`
 *
 * This service previously emitted the trailing-slash form, chosen from the code
 * samples. The account is the authority for its own organisation - it is the
 * value the provider hands you to use - so the unslashed form is what we emit.
 *
 * The only consumer is FairPlay (Safari / iOS), which cannot be exercised from
 * this environment, so a silent regression here would not surface until a real
 * iPhone playback failed. Hence the test.
 */

const ORG = 'org_test_123456';

function service(orgId: string | null = ORG) {
  const configService = {
    getOrThrow: () => ({
      drm: {
        enabled: true,
        provider: 'gumlet',
        widevineLicenseUrl: null,
        fairplayLicenseUrl: null,
        fairplayCertUrl: null,
        providerToken: null,
        gumlet: {
          apiKey: 'k',
          workspaceId: 'ws',
          orgId,
          // base64 so Buffer.from(...,'base64') yields real bytes
          signSecret: 'c2VjcmV0LWtleS1mb3ItdGVzdGluZy1wdXJwb3Nlcy1vbmx5',
          tokenLifetimeSeconds: 300,
          resolutions: ['720p'],
        },
      },
    }),
  };
  return new GumletDrmService(configService as never);
}

describe('the FairPlay certificate URL', () => {
  it('has NO trailing slash, matching the account display', () => {
    const bundle = service().signLicenseUrl({ assetId: 'asset_1' });

    expect(bundle.certificateUrl).toBe(`https://fairplay.gumlet.com/certificate/${ORG}`);
    expect(bundle.certificateUrl!.endsWith('/')).toBe(false);
  });

  it('points at the certificate host, not the licence host', () => {
    const bundle = service().signLicenseUrl({ assetId: 'asset_1' });

    expect(bundle.certificateUrl).toContain('fairplay.gumlet.com/certificate/');
    expect(bundle.certificateUrl).not.toContain('/licence/');
  });

  it('carries no query string', () => {
    const bundle = service().signLicenseUrl({ assetId: 'asset_1' });

    expect(bundle.certificateUrl).not.toContain('?');
    expect(new URL(bundle.certificateUrl!).search).toBe('');
  });

  it('resolves to a parseable absolute URL', () => {
    const bundle = service().signLicenseUrl({ assetId: 'asset_1' });
    const u = new URL(bundle.certificateUrl!);

    expect(u.protocol).toBe('https:');
    expect(u.pathname).toBe(`/certificate/${ORG}`);
  });

  it('refuses entirely when no organisation is configured', () => {
    // Fail closed, and earlier than the certificate line: `isSigningConfigured`
    // requires BOTH the org id and the secret, so a missing org id never
    // reaches string construction. That is what stops a literal
    // `.../certificate/null` or `.../certificate/undefined` being handed to a
    // player, and it is why this test expects a throw rather than a null URL.
    expect(() => service(null).signLicenseUrl({ assetId: 'asset_1' })).toThrow(
      /not configured/i,
    );
  });

  it('differs from the licence URL host, so the two are never confused', () => {
    const bundle = service().signLicenseUrl({ assetId: 'asset_1' });

    expect(bundle.licenseUrl).toContain('widevine.gumlet.com/licence/');
    expect(bundle.certificateUrl).toContain('fairplay.gumlet.com/certificate/');
  });
});

describe('the licence URLs themselves are unchanged by this fix', () => {
  it('still emits the documented Widevine licence URL', () => {
    const bundle = service().signLicenseUrl({ assetId: 'asset_1' });

    expect(bundle.licenseUrl.startsWith(`https://widevine.gumlet.com/licence/${ORG}/asset_1?`)).toBe(
      true,
    );
    expect(new URL(bundle.licenseUrl).searchParams.get('token')).toBeTruthy();
    expect(new URL(bundle.licenseUrl).searchParams.get('expires')).toBeTruthy();
  });

  it('exposes the FairPlay licence variant on the same asset path', () => {
    // Not asserted as an identical token: signing embeds `expires`, so two
    // calls can legitimately straddle a second boundary and differ. What must
    // hold is the shape - same org/asset path, same parameters, different host.
    const svc = service();
    const widevine = svc.signLicenseUrl({ assetId: 'asset_1' });
    const fairplay = svc.signFairPlayLicenseUrl({ assetId: 'asset_1' });

    expect(fairplay).toContain('fairplay.gumlet.com/licence/');
    expect(new URL(fairplay).pathname).toBe(new URL(widevine.licenseUrl).pathname);
    expect(new URL(fairplay).searchParams.get('token')).toMatch(/^[0-9a-f]{40}$/);
    expect(new URL(fairplay).searchParams.get('expires')).toBeTruthy();
  });
});