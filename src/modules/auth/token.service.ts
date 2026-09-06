import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { UserRole } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { AuthConfig } from '../../config/configuration';

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  role: UserRole;
}

export interface RefreshTokenClaims {
  sub: string;
  sid: string;
  /** Rotation family; reuse detection revokes the whole family. */
  fam: string;
  jti: string;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresAt: Date;
  refreshTokenHash: string;
  familyId: string;
  jti: string;
}

/**
 * Token minting.
 *
 * Three separate signing domains (access, refresh, playback) with three
 * separate secrets. Sharing one secret would let a leaked short-lived playback
 * grant be replayed as an access token, which is exactly the escalation the
 * playback design is meant to prevent.
 *
 * Refresh tokens are stored only as SHA-256 hashes. A database dump therefore
 * does not hand an attacker usable sessions.
 */
@Injectable()
export class TokenService {
  private readonly auth: AuthConfig;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.auth = config.getOrThrow<AuthConfig>('auth');
  }

  async issue(params: {
    userId: string;
    sessionId: string;
    role: UserRole;
    familyId?: string;
  }): Promise<IssuedTokens> {
    const familyId = params.familyId ?? randomUUID();
    const jti = randomUUID();

    const accessToken = await this.jwt.signAsync(
      { sub: params.userId, sid: params.sessionId, role: params.role },
      {
        secret: this.auth.accessSecret,
        expiresIn: this.auth.accessTtl,
        issuer: this.auth.issuer,
        audience: this.auth.audience,
      },
    );

    const refreshToken = await this.jwt.signAsync(
      { sub: params.userId, sid: params.sessionId, fam: familyId, jti },
      {
        secret: this.auth.refreshSecret,
        expiresIn: this.auth.refreshTtl,
        issuer: this.auth.issuer,
        audience: this.auth.audience,
      },
    );

    return {
      accessToken,
      refreshToken,
      expiresIn: this.auth.accessTtl,
      refreshExpiresAt: new Date(Date.now() + this.auth.refreshTtl * 1000),
      refreshTokenHash: TokenService.hashToken(refreshToken),
      familyId,
      jti,
    };
  }

  async verifyRefresh(token: string): Promise<RefreshTokenClaims> {
    return this.jwt.verifyAsync<RefreshTokenClaims>(token, {
      secret: this.auth.refreshSecret,
      issuer: this.auth.issuer,
      audience: this.auth.audience,
    });
  }

  /**
   * Signs a short-lived playback grant. Deliberately minimal: it names the
   * exact video, user, device and session it authorizes, so it is useless if
   * copied to another account or device.
   */
  async signPlaybackGrant(payload: {
    ticketId: string;
    userId: string;
    videoId: string;
    courseId: string;
    deviceId: string | null;
    sessionId: string | null;
    maxHeight: number | null;
    ttlSeconds: number;
  }): Promise<string> {
    return this.jwt.signAsync(
      {
        tid: payload.ticketId,
        sub: payload.userId,
        vid: payload.videoId,
        cid: payload.courseId,
        did: payload.deviceId,
        sid: payload.sessionId,
        mh: payload.maxHeight,
      },
      {
        secret: this.auth.playbackSecret,
        expiresIn: payload.ttlSeconds,
        issuer: this.auth.issuer,
        audience: 'edu-playback',
      },
    );
  }

  async verifyPlaybackGrant(token: string): Promise<{
    tid: string;
    sub: string;
    vid: string;
    cid: string;
    did: string | null;
    sid: string | null;
    mh: number | null;
    exp: number;
  }> {
    return this.jwt.verifyAsync(token, {
      secret: this.auth.playbackSecret,
      issuer: this.auth.issuer,
      audience: 'edu-playback',
    });
  }

  static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Opaque, URL-safe random string for codes and forensic tags. */
  static randomToken(bytes = 24): string {
    return randomBytes(bytes).toString('base64url');
  }
}
