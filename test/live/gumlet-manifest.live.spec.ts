/**
 * LIVE verification against the real Gumlet CDN - NOT part of the unit suite.
 *
 * Run explicitly, and only when you intend to make a network call:
 *   LIVE_GUMLET_MANIFEST_URL=<url> npx jest test/live/gumlet-manifest.live.spec.ts
 *
 * Why this is separated out: every other spec in this repo mocks the provider.
 * The CENC check in `GumletIngestService.sync()` is what stands between "Gumlet
 * says ready" and "this lesson is playable", and it is exactly the kind of
 * string-matching that reads as correct while agreeing with nothing real.
 *
 * The URL is supplied by the operator and points at a public, DRM-encrypted DASH
 * manifest. No credentials are used and nothing is written; a GET of an already
 * public manifest cannot change any account state.
 *
 * It is skipped unless LIVE_GUMLET_MANIFEST_URL is set, so a normal `npx jest`
 * run stays offline and deterministic.
 */

import { GumletDrmService } from 'src/modules/playback/gumlet-drm.service';

const LIVE_URL = process.env.LIVE_GUMLET_MANIFEST_URL;

const describeLive = LIVE_URL ? describe : describe.skip;

describeLive('LIVE: a real Gumlet CENC DASH manifest', () => {
  // Instantiated without touching config: only `assetHasDrm` is exercised, and it
  // is a pure function over the manifest text.
  const gumlet = new GumletDrmService({
    getOrThrow: () => ({ drm: { gumlet: {} } }),
  } as never) as unknown as {
    assetHasDrm: (t: string) => boolean;
  };

  let manifest = '';

  beforeAll(async () => {
    const res = await fetch(LIVE_URL as string, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`manifest fetch failed: HTTP ${res.status}`);
    manifest = await res.text();
  });

  it('is served successfully', () => {
    expect(manifest.length).toBeGreaterThan(0);
  });

  it('is recognised as CENC-encrypted by the production check', () => {
    // This is the assertion that matters. If `assetHasDrm` returned false here,
    // every genuinely DRM-protected lesson would be marked FAILED and refused.
    expect(gumlet.assetHasDrm(manifest)).toBe(true);
  });

  it('contains both signals the check requires', () => {
    expect(manifest).toContain('urn:mpeg:dash:mp4protection:2011');
    expect(manifest).toMatch(/cenc:default_KID="/);
  });

  it('carries a Widevine PSSH, so a browser can find a licence server', () => {
    // The 16-byte Widevine system id inside the PSSH.
    expect(manifest).toMatch(/edef8ba9-?79d6-?4ace-?a3c8-?27dcd51d21ed/i);
  });

  it('offers multiple renditions, as an ABR ladder should', () => {
    const representations = manifest.match(/<Representation\b/g) ?? [];
    expect(representations.length).toBeGreaterThan(1);
  });

  it('rejects an unencrypted manifest, so the check can actually fail', () => {
    // Guards against the check being vacuously true. Strip the encryption
    // markers and it must refuse - this is the fail-closed path that keeps an
    // unencrypted asset from being marked playable.
    const stripped = manifest
      .replace(/schemeIdUri="urn:mpeg:dash:mp4protection:2011"/g, 'schemeIdUri="urn:mpeg:dash:mp4main:2011"')
      .replace(/cenc:default_KID="[^"]*"/g, '');
    expect(gumlet.assetHasDrm(stripped)).toBe(false);
  });
});