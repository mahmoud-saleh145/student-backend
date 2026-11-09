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
