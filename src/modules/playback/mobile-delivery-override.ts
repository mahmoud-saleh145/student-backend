/**
 * Runtime override of the mobile delivery switch.
 *
 * `MOBILE_VIDEO_DELIVERY` and `MOBILE_HLS_GUMLET_FALLBACK` are environment
 * variables, which means a redeploy (or at least a restart) to change them.
 * During the migration the owner needs a faster lever: if the R2 ladder or the
 * media edge misbehaves for mobile, every bound mobile device must go back to
 * Gumlet within seconds, with no app release and no deploy. That lever is a
 * persistent Redis value written by `POST /videos/mobile/delivery` and read
 * here by the playback planner on every mobile ticket.
 *
 * What it can do: pick which of the two GATED pipelines mints the ticket
 * (Gumlet behind the strict DRM check, or our HLS behind the ticket chain),
 * and whether an unmigrated video may fall back to Gumlet. What it cannot do:
 * skip entitlement, device binding, the play allowance or any other check -
 * those run before the plan is consulted and are identical for both paths.
 */
export const MOBILE_DELIVERY_OVERRIDE_KEY = 'mobile:delivery:override';

/** `devices.platform` values (trimmed, lower-cased) that are a native mobile OS. */
export const MOBILE_DEVICE_PLATFORMS: ReadonlySet<string> = new Set(['android', 'ios']);

export interface MobileDeliveryOverride {
  delivery: 'gumlet' | 'hls';
  /** Only meaningful with delivery 'hls'; undefined keeps the configured value. */
  gumletFallback?: boolean;
  by?: string;
  at?: string;
}

/** Applies an override (if any) to the configured mobile settings. */
export function effectiveMobileDelivery(
  configured: { delivery: 'hls' | 'gumlet'; gumletFallback: boolean },
  override: MobileDeliveryOverride | null | undefined,
): { delivery: 'hls' | 'gumlet'; gumletFallback: boolean; overridden: boolean } {
  if (!override || (override.delivery !== 'gumlet' && override.delivery !== 'hls')) {
    return { ...configured, overridden: false };
  }
  return {
    delivery: override.delivery,
    gumletFallback: typeof override.gumletFallback === 'boolean' ? override.gumletFallback : configured.gumletFallback,
    overridden: true,
  };
}

/**
 * The first native build of each platform that plays the mobile HLS stream
 * properly (MOBILE_HLS_MIN_BUILD_ANDROID / MOBILE_HLS_MIN_BUILD_IOS). null =
 * not configured for that platform.
 */
export interface MobileHlsMinBuilds {
  android: number | null;
  ios: number | null;
}

/**
 * A native build number as a whole number, or null when it is not one. Android
 * reports its versionCode ("12"); an iOS build may be dotted ("1.2.3"), which
 * cannot be compared to a single minimum and is treated as unknown.
 */
export function parseAppBuild(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!/^\d{1,9}$/.test(text)) return null;
  const value = Number(text);
  return value > 0 ? value : null;
}

export type AppBuildStanding =
  /** No minimum is configured for this platform. */
  | 'no-minimum'
  /** A minimum is configured and the build is at or above it. */
  | 'at-or-above'
  /** A minimum is configured and the build is older. */
  | 'below'
  /** A minimum is configured and the build is missing or not a plain number. */
  | 'unknown-build';

/** Where a reported build stands against the configured minimum of its platform. */
export function appBuildStanding(
  platform: string | null | undefined,
  appBuild: string | null | undefined,
  minimums: MobileHlsMinBuilds | null | undefined,
): AppBuildStanding {
  const os = (platform ?? '').trim().toLowerCase();
  const minimum = os === 'android' ? minimums?.android : os === 'ios' ? minimums?.ios : null;
  if (typeof minimum !== 'number' || !(minimum > 0)) return 'no-minimum';
  const build = parseAppBuild(appBuild);
  if (build === null) return 'unknown-build';
  return build >= minimum ? 'at-or-above' : 'below';
}

/**
 * MAY THIS INSTALL BE SERVED THE MOBILE HLS STREAM?
 *
 * An installed build can declare `hls-aes128` and still not play the stream
 * properly: Android versionCode 11 declares it and loses the stream at the
 * first ticket rotation (the fix shipped in 12). Declaring the capability is
 * therefore necessary but, where a minimum build is configured, not enough:
 * an older build - or one that does not say what it is - keeps the Gumlet
 * grant it has always played.
 *
 * With no minimum configured for the platform the declaration alone decides,
 * exactly as before this existed.
 */
export function buildMayPlayMobileHls(
  platform: string | null | undefined,
  appBuild: string | null | undefined,
  minimums: MobileHlsMinBuilds | null | undefined,
): boolean {
  const standing = appBuildStanding(platform, appBuild, minimums);
  return standing === 'no-minimum' || standing === 'at-or-above';
}
