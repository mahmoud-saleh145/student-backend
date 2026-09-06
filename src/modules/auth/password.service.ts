import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { AuthConfig } from '../../config/configuration';

/**
 * Password hashing.
 *
 * argon2id at OWASP's recommended floor (19 MiB, t=2, p=1). Bcrypt was
 * rejected because it silently truncates at 72 bytes and has no memory
 * hardness, which matters for a platform whose users pick short passwords.
 */
@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);
  private readonly options: argon2.Options;
  /** Burned when a phone doesn't exist, to keep login timing flat. */
  private readonly decoyHash: Promise<string>;

  constructor(config: ConfigService) {
    const auth = config.getOrThrow<AuthConfig>('auth');

    this.options = {
      type: argon2.argon2id,
      memoryCost: auth.argon.memoryCost,
      timeCost: auth.argon.timeCost,
      parallelism: auth.argon.parallelism,
    };

    this.decoyHash = argon2.hash(randomBytes(32).toString('hex'), this.options);
  }

  async hash(plain: string): Promise<string> {
    return argon2.hash(plain, this.options);
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch (e) {
      // A malformed stored hash must read as "wrong password", not crash.
      this.logger.warn(`password verify failed: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * Spends comparable CPU when the account doesn't exist, so response timing
   * doesn't reveal which phone numbers are registered.
   */
  async burnTiming(candidate: string): Promise<void> {
    try {
      await argon2.verify(await this.decoyHash, candidate);
    } catch {
      /* expected */
    }
  }

  /** True when the stored hash was produced with weaker parameters. */
  needsRehash(hash: string): boolean {
    try {
      return argon2.needsRehash(hash, this.options);
    } catch {
      return false;
    }
  }

  /** Constant-time comparison for non-password secrets (codes, tokens). */
  static safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }
}
