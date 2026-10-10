import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes } from 'node:crypto';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { VideoConfig } from '../../config/configuration';

/**
 * Gumlet DRM: license URL signing and asset lifecycle.
 *
 * SECURITY CONTRACT
 *
 *   * This service is the ONLY place the Gumlet sign secret is used. It lives
 *     on the server, is never logged, never returned in a response, and never
 *     placed in a client bundle (the frontend only ever receives the final
 *     short-lived license URL produced by `signLicenseUrl`).
 *   * Every method FAILS CLOSED. Missing configuration or missing asset metadata
 *     produces a 503-style error rather than silently falling back to
 *     unprotected playback. A Gumlet-backed video must never degrade into a
 *     plain HLS stream by accident.
 *
 * WHAT `hardware_secure` ACTUALLY DOES
 *
 *   Per Gumlet's own documentation it gates the SD stream and audio behind
 *   hardware decode. HD/UHD renditions always require hardware decode
 *   regardless of the flag, and because this platform requests >=720p renditions
 *   from Gumlet, HD/UHD mandates Widevine L1 by construction.
 *
 *   This is NOT proof that the client achieved L1. It only constrains what the
 *   server is willing to issue and which renditions exist. The negotiated
 *   security level is not observable from a browser EME surface.
 *
 * WHAT THE WEAPONIZED FALLBACK WOULD LOOK LIKE
 *
 *   `['SW_SECURE_CRYPTO']` in a robustness list silently accepts software
 *   (L3) DRM. The default shipped here is `['HW_SECURE_ALL']` with no
 *   fallback, and `gumletDocDemo` exists only to document the weaker shape.
 */
export interface GumletLicenseBundle {
  licenseUrl: string;
  certificateUrl: string | null;
  manifestUrl: string | null;
  expires: number;
  expiresIso: string;
  /**
   * The exact string that was HMAC'd. Contains no secret - it is the asset
   * path, the expiry, and the hardware_secure flag. Returned for diagnostics
   * and for the asset "JSON Response" panel, and asserted by the signing tests.
   */
  signedString: string;
  hardwareSecure: boolean;
  videoRobustness: string[];
  audioRobustness: string[];
}

export interface GumletAssetStatus {
  assetId: string;
  status: string;
  progress: number;
  playbackUrl: string | null;
  dashPlaybackUrl: string | null;
  error: string | null;
}

const WIDEVINE_LICENSE_BASE = 'https://widevine.gumlet.com/licence';
const FAIRPLAY_LICENSE_BASE = 'https://fairplay.gumlet.com/licence';
const FAIRPLAY_CERT_BASE = 'https://fairplay.gumlet.com/certificate';

@Injectable()
export class GumletDrmService {
  private readonly logger = new Logger(GumletDrmService.name);
  private readonly cfg: VideoConfig['drm']['gumlet'];

  constructor(private readonly config: ConfigService) {
    const videoCfg = this.config.getOrThrow<VideoConfig>('video');
    this.cfg = videoCfg.drm.gumlet;
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  /**
   * True when signing is fully possible. Deliberately narrow: a partial
   * configuration (org id but no secret) is as unusable as none at all and must
   * not be treated as a half-working state.
   */
  isSigningConfigured(): boolean {
    return Boolean(this.cfg.orgId && this.cfg.signSecret);
  }

  /** True when the asset-management API can be called. */
  isAssetApiConfigured(): boolean {
    return Boolean(this.cfg.apiKey && this.cfg.workspaceId);
  }

  /**
   * Fingerprint of the loaded secret, safe to log. Proves WHICH secret is in
   * use without revealing it.
   */
  signSecretFingerprint(): string {
    const secret = this.cfg.signSecret;
    if (!secret) return 'none';
    let bytes: Buffer;
    try {
      bytes = Buffer.from(secret, 'base64');
    } catch {
      return 'undecodable';
    }
    return createHmac('sha256', bytes).update('fingerprint').digest('hex').slice(0, 12);
  }

  // ---------------------------------------------------------------------------
  // License URL signing
  // ---------------------------------------------------------------------------

  /**
   * Mint a short-lived, asset-scoped Widevine/FairPlay license URL.
   *
   * Transcribed from Gumlet's documented reference implementations:
   *   https://docs.gumlet.com/developers/drm/license-server-setup
   *
   *   stringToSign        = /{orgId}/{assetId}
   *   expires             = round(now_ms + lifetime * 1000)   // milliseconds
   *   signedString        = stringToSign + '?' + canonicalQuery
   *   token               = HMAC_SHA1(base64_decode(secret), signedString).hex
   *   licenseUrl          = .../{orgId}/{assetId}?token=..&expires=..[&hardware_secure=true]
   *
   * The Phase 0 harness proves this byte-identical to both Gumlet's JavaScript
   * and PHP examples; `scripts/verify-signing.mjs` in that project is the
   * regression harness and its vectors are mirrored in
   * `src/modules/playback/gumlet-signing.spec.ts`.
   */
  signLicenseUrl(params: {
    assetId: string;
    hardwareSecure?: boolean;
    tokenLifetimeSeconds?: number;
  }): GumletLicenseBundle {
    const { assetId } = params;
    const hardwareSecure = params.hardwareSecure ?? true;
    const lifetime = params.tokenLifetimeSeconds ?? this.cfg.tokenLifetimeSeconds;

    if (!assetId) {
      throw new AppException(ErrorCode.VIDEO_UNAVAILABLE, {
        message: 'Gumlet DRM video is missing its asset ID',
      });
    }
    if (!this.isSigningConfigured()) {
      // Fail closed: never return a usable playback path without signing.
      this.logger.error('Gumlet DRM requested but GUMLET_ORG_ID / GUMLET_SIGN_SECRET are not set');
      throw new AppException(ErrorCode.PLAYBACK_DENIED, {
        message: 'DRM is not configured on this platform',
      });
    }

    const stringToSign = `/${this.cfg.orgId}/${assetId}`;
    const expires = Math.round(Date.now() + lifetime * 1000);

    // Insertion order matters: this exact string is HMAC'd and must match what
    // the license server reconstructs. `token` is NEVER part of it.
    const canonical = new URLSearchParams();
    canonical.set('expires', String(expires));
    if (hardwareSecure) canonical.set('hardware_secure', 'true');
    const signedString = `${stringToSign}?${canonical.toString()}`;

    const secretBytes = Buffer.from(this.cfg.signSecret as string, 'base64');
    if (secretBytes.length === 0) {
      throw new AppException(ErrorCode.PLAYBACK_DENIED, {
        message: 'Gumlet signing secret is not valid base64',
      });
    }

    const token = createHmac('sha1', secretBytes).update(signedString).digest('hex');

    // Request URL puts token first, then preserves the canonical order.
    const runtime = new URLSearchParams();
    runtime.set('token', token);
    runtime.set('expires', String(expires));
    if (hardwareSecure) runtime.set('hardware_secure', 'true');

    return {
      licenseUrl: `${WIDEVINE_LICENSE_BASE}${stringToSign}?${runtime.toString()}`,
      // Gumlet's docs list the prefix as `.../certificate/<ORG_ID>` but the
      // runnable sample prints `.../certificate/<ORG_ID>/`. The sample is the
      // concrete artifact, so that form is used. Untested against a live
      // FairPlay credential - see the "Not yet verified" section of the
      // integration doc.
      certificateUrl: this.cfg.orgId ? `${FAIRPLAY_CERT_BASE}/${this.cfg.orgId}/` : null,
      manifestUrl: null,
      expires,
      expiresIso: new Date(expires).toISOString(),
      signedString,
      hardwareSecure,
      // No fallback. See the class docstring.
      videoRobustness: ['HW_SECURE_ALL'],
      audioRobustness: ['HW_SECURE_ALL'],
    };
  }

  /** Build the FairPlay variant of the same signed token. */
  signFairPlayLicenseUrl(params: { assetId: string; hardwareSecure?: boolean }): string {
    const bundle = this.signLicenseUrl(params);
    return bundle.licenseUrl.replace(WIDEVINE_LICENSE_BASE, FAIRPLAY_LICENSE_BASE);
  }

  /**
   * Manifest URL for a Gumlet-backed video.
   *
   * NOT guessed: the convention is
   *   https://video.gumlet.io/{workspaceId}/{assetId}/main.mpd
   * which is exactly the `dash_playback_url` Gumlet returns from the Asset
   * API (verified against the official Create Asset reference). We prefer the
   * stored value returned by Gumlet and only fall back to this shape when the
   * asset was created by hand.
   */
  dashManifestUrl(params: { assetId: string; workspaceId?: string | null }): string {
    const workspaceId = params.workspaceId ?? this.cfg.workspaceId;
    if (!workspaceId) {
      throw new AppException(ErrorCode.VIDEO_UNAVAILABLE, {
        message: 'Gumlet workspace ID is not configured',
      });
    }
    return `https://video.gumlet.io/${workspaceId}/${params.assetId}/main.mpd`;
  }

  // ---------------------------------------------------------------------------
  // Asset lifecycle (verified against Gumlet's Create Asset reference)
  // ---------------------------------------------------------------------------

  /**
   * Create a Gumlet asset from a source URL.
   *
   * POST https://api.gumlet.com/v1/video/assets
   *   Authorization: Bearer <GUMLET_API_KEY>
   *   { format: "ABR", workspace_id, input, enable_drm, resolution, title, ... }
   *
   * `input` must be a URL Gumlet can fetch - we pass a short-lived presigned
   * R2 URL for the already-uploaded source object.
   */
  async createAsset(params: {
    sourceUrl: string;
    title?: string | null;
    enableDrm?: boolean;
    resolutions?: string[];
    tag?: string[];
  }): Promise<{ assetId: string; status: string; playbackUrl: string | null }> {
    if (!this.isAssetApiConfigured()) {
      throw new AppException(ErrorCode.VIDEO_UNAVAILABLE, {
        message: 'Gumlet asset API is not configured (GUMLET_API_KEY / GUMLET_WORKSPACE_ID)',
      });
    }

    const body: Record<string, unknown> = {
      format: 'ABR',
      workspace_id: this.cfg.workspaceId,
      input: params.sourceUrl,
      enable_drm: params.enableDrm ?? true,
      resolution: (params.resolutions ?? this.cfg.resolutions).join(','),
      // Never expose a downloadable MP4 of a paid lesson.
      mp4_access: false,
    };
    if (params.title) body.title = params.title;
    if (params.tag?.length) body.tag = params.tag;

    const res = await fetch('https://api.gumlet.com/v1/video/assets', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.cfg.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const json = (await res.json().catch(() => null)) as
      | { asset_id?: string; status?: string; output?: { playback_url?: string } }
      | { error?: { code?: string; message?: string } }
      | null;

    if (!res.ok || !json || 'error' in json) {
      const err = (json as { error?: { message?: string } } | null)?.error;
      this.logger.error(`Gumlet createAsset failed (${res.status}): ${err?.message ?? 'unknown'}`);
      throw new AppException(ErrorCode.VIDEO_PROCESSING_FAILED, {
        message: err?.message ?? `Gumlet asset creation failed with HTTP ${res.status}`,
      });
    }

    return {
      assetId: (json as { asset_id: string }).asset_id,
      status: (json as { status?: string }).status ?? 'unknown',
      playbackUrl: (json as { output?: { playback_url?: string } }).output?.playback_url ?? null,
    };
  }

  /**
   * Poll an asset. Uses Gumlet's documented asset endpoint, which is the
   * `status_url` returned at creation time.
   */
  async getAsset(assetId: string): Promise<GumletAssetStatus> {
    if (!this.isAssetApiConfigured()) {
      throw new AppException(ErrorCode.VIDEO_UNAVAILABLE, {
        message: 'Gumlet asset API is not configured',
      });
    }

    const res = await fetch(`https://api.gumlet.com/v1/video/assets/${encodeURIComponent(assetId)}`, {
      headers: { authorization: `Bearer ${this.cfg.apiKey}` },
    });

    const json = (await res.json().catch(() => null)) as
      | { status?: string; progress?: number; output?: { playback_url?: string; dash_playback_url?: string }; error?: { message?: string } }
      | { error?: { message?: string } }
      | null;

    if (!res.ok || !json) {
      throw new AppException(ErrorCode.VIDEO_UNAVAILABLE, {
        message: `Gumlet asset lookup failed with HTTP ${res.status}`,
      });
    }

    if ('error' in json && json.error && Object.keys(json).length === 1) {
      throw new AppException(ErrorCode.VIDEO_UNAVAILABLE, {
        message: json.error.message ?? 'Gumlet asset lookup failed',
      });
    }

    const a = json as {
      status?: string;
      progress?: number;
      output?: { playback_url?: string; dash_playback_url?: string };
      error?: { message?: string };
    };

    return {
      assetId,
      status: a.status ?? 'unknown',
      progress: a.progress ?? 0,
      playbackUrl: a.output?.playback_url ?? null,
      dashPlaybackUrl: a.output?.dash_playback_url ?? null,
      error: a.error?.message ?? null,
    };
  }

  /** A non-forgeable placeholder used by tests and by dry-run validation. */
  static syntheticAssetId(prefix = 'test'): string {
    return `${prefix}${randomBytes(5).toString('hex')}`;
  }

  /**
   * Is an asset finished and usable for DRM playback?
   *
   * Gumlet reports asset status as a free-form string. The observed values on a
   * real asset are `upload-pending`, `queued`, `processing`, `ready`, `errored`,
   * `failed`. Rather than trusting a single string, this accepts the terminal
   * success state and rejects everything else, so a new/unknown status is
   * treated as "not ready" - a fail-closed default. A completed status that we
   * have not seen before therefore blocks playback instead of allowing it.
   */
  isAssetPlayable(status: string): boolean {
    return status === 'ready';
  }

  /**
   * Does the asset's packaging actually include DRM?
   *
   * The Asset API echoes the transformations back. A CENC/cbcs
   * `ContentProtection` entry with a `default_KID` in the DASH manifest is the
   * authoritative signal; this mirrors that as a schema check so a
   * mis-packaged asset (DRM not applied) cannot be marked playable.
   */
  assetHasDrm(manifestText: string): boolean {
    if (!manifestText) return false;
    return /schemeIdUri="urn:mpeg:dash:mp4protection:2011"/.test(manifestText) && /cenc:default_KID="/.test(manifestText);
  }
}