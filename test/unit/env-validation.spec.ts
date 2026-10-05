// class-validator's decorators read design-time metadata. main.ts pulls this in
// for the app; a unit test that imports the contract directly has to do it too.
import 'reflect-metadata';

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { NodeEnv, validateEnv } from '../../src/config/env.validation';

/**
 * Every variable the code actually reads, with a value that satisfies it.
 *
 * The point of this file is that the env contract in `env.validation.ts` and the
 * `process.env` reads in `src/` cannot drift apart. Undeclared reads are how
 * `QUEUE_DRAIN_DELAY_SECONDS=30s` came to be silently discarded: nothing
 * complained, the operator saw a green deploy, and the setting was simply never
 * applied.
 */
const MINIMAL = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/edu',
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
  JWT_PLAYBACK_SECRET: 'c'.repeat(48),
  MEDIA_SIGNING_KEY: 'd'.repeat(48),
  HLS_KEY_ROOT: 'e'.repeat(48),
};

const validate = (overrides: Record<string, unknown> = {}, env = NodeEnv.Development) =>
  validateEnv({ ...MINIMAL, NODE_ENV: env, ...overrides });

/**
 * A production environment that passes every guard, so each test can break
 * exactly one thing. Without this, CORS_ORIGINS trips first and every later
 * assertion is really just re-testing CORS.
 */
const PROD_BASELINE: Record<string, unknown> = {
  CORS_ORIGINS: 'https://app.example.com',
  R2_ACCESS_KEY_ID: 'r2-key',
  R2_SECRET_ACCESS_KEY: 'r2-secret',
  MEDIA_CDN_BASE_URL: 'https://cdn.example.com',
  PUBLIC_API_URL: 'https://api.example.com',
};

const prod = (overrides: Record<string, unknown> = {}) =>
  validate({ ...PROD_BASELINE, ...overrides }, NodeEnv.Production);

describe('the boot-time environment contract', () => {
  describe('required secrets', () => {
    it('accepts a minimal, honest environment', () => {
      expect(() => validate()).not.toThrow();
    });

    it('refuses to boot without a database URL', () => {
      // The failure has to happen here. A backend that starts and then cannot
      // reach its database looks healthy to the platform's health check.
      expect(() => validateEnv({ ...MINIMAL, DATABASE_URL: undefined })).toThrow(
        /DATABASE_URL/,
      );
    });

    it.each([
      'JWT_ACCESS_SECRET',
      'JWT_REFRESH_SECRET',
      'JWT_PLAYBACK_SECRET',
      'MEDIA_SIGNING_KEY',
      'HLS_KEY_ROOT',
    ])('refuses a short %s', (key) => {
      // Each of these signs something a client can present back to us.
      expect(() => validate({ [key]: 'too-short' })).toThrow(new RegExp(key));
    });
  });

  describe('production only refusals', () => {
    it('accepts a complete, honest production environment', () => {
      expect(() => prod()).not.toThrow();
    });

    it('rejects placeholder secrets', () => {
      expect(() =>
        prod({ JWT_ACCESS_SECRET: 'CHANGE_ME_please_do_not_ship_this_value' }),
      ).toThrow(/placeholder secrets/i);
    });

    it('rejects one secret reused across signing domains', () => {
      // A leaked playback grant would then authenticate as an access token.
      expect(() => prod({ JWT_REFRESH_SECRET: MINIMAL.JWT_ACCESS_SECRET })).toThrow(
        /must all differ/i,
      );
    });

    it('rejects a wildcard CORS allow-list', () => {
      expect(() => prod({ CORS_ORIGINS: '*' })).toThrow(/CORS_ORIGINS/);
    });

    it('rejects missing storage credentials', () => {
      expect(() => prod({ R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '' })).toThrow(/R2/);
    });

    it('rejects serving media through the API process', () => {
      // Video proxied through Node competes with request handling and gets no
      // edge caching, and it degrades quietly rather than loudly.
      expect(() => prod({ MEDIA_LOCAL_ORIGIN: true })).toThrow(/MEDIA_LOCAL_ORIGIN/);
    });

    it('rejects a media deployment with no CDN to verify signed URLs', () => {
      expect(() => prod({ MEDIA_CDN_BASE_URL: '' })).toThrow(/MEDIA_CDN_BASE_URL/);
    });
  });

  describe('values that used to be discarded in silence', () => {
    // Each of these was read through a helper that falls back to a default on
    // anything it cannot parse. The deploy was green and the operator's change
    // was inert; the platform only discovered it via the Redis bill.

    it.each([
      ['QUEUE_DRAIN_DELAY_SECONDS', '30s'],
      ['QUEUE_STALLED_INTERVAL_SECONDS', '1 minute'],
      ['QUEUE_BACKGROUND_DRAIN_DELAY_SECONDS', ''],
      ['QUEUE_BACKGROUND_STALLED_INTERVAL_SECONDS', 'NaN'],
    ])('refuses an unparseable %s', (key, value) => {
      expect(() => validate({ [key]: value })).toThrow(new RegExp(key));
    });

    it.each([
      ['PLAYBACK_MAX_PLAYS_PER_VIDEO', 'lots'],
      ['PLAYBACK_MIN_COUNTED_PLAY_SECONDS', '30s'],
      ['PLAYBACK_PLAY_RESUME_WINDOW', '45min'],
    ])('refuses an unparseable %s', (key, value) => {
      expect(() => validate({ [key]: value })).toThrow(new RegExp(key));
    });

    it('refuses a nonsense queue delay rather than polling Redis every second', () => {
      // 0 would mean "no wait", which is the exact setting the queue tuning file
      // exists to prevent.
      expect(() => validate({ QUEUE_DRAIN_DELAY_SECONDS: 0 })).toThrow(/QUEUE_DRAIN_DELAY_SECONDS/);
    });

    it('refuses a play limit of zero, which would block every student', () => {
      expect(() => validate({ PLAYBACK_MAX_PLAYS_PER_VIDEO: 0 })).toThrow(
        /PLAYBACK_MAX_PLAYS_PER_VIDEO/,
      );
    });

    it('refuses a malformed sweep schedule', () => {
      // An unparseable cron expression is silently dropped by the scheduler,
      // which means the maintenance sweep just never runs.
      expect(() => validate({ ANNOUNCEMENT_SWEEP_CRON: 'every minute please' })).toThrow(
        /ANNOUNCEMENT_SWEEP_CRON/,
      );
    });

    it.each(['0', '1', 'yes', ''])('refuses RUN_WORKERS=%s', (value) => {
      // worker.ts sets exactly 'true'. Anything else that reached jobs.module
      // would be read as false, so a second set of processors might quietly go
      // unregistered — or, worse, be switched on for the API by a stray
      // platform variable and double-execute every job.
      expect(() => validate({ RUN_WORKERS: value })).toThrow(/RUN_WORKERS/);
    });

    it('accepts the two values RUN_WORKERS actually uses', () => {
      expect(() => validate({ RUN_WORKERS: 'true' })).not.toThrow();
      expect(() => validate({ RUN_WORKERS: 'false' })).not.toThrow();
    });

    it('does not let a truthy ENABLE_SWAGGER widen the opt-in', () => {
      // main.ts compares against the exact string 'true'.
      expect(() => validate({ ENABLE_SWAGGER: '1' })).toThrow(/ENABLE_SWAGGER/);
    });
  });

  describe('playback resume window', () => {
    it('refuses a window that cannot outlast a ticket', () => {
      // The window exists to absorb a ticket expiring mid-lesson. At or below
      // the TTL it absorbs nothing, and the student loses one of their counted
      // plays to the expiry — exactly the failure it was meant to prevent.
      expect(() =>
        validate({ PLAYBACK_TICKET_TTL: 300, PLAYBACK_PLAY_RESUME_WINDOW: 300 }),
      ).toThrow(/PLAYBACK_PLAY_RESUME_WINDOW/);
    });

    it('refuses it after both values are raised together into the bad order', () => {
      expect(() =>
        validate({ PLAYBACK_TICKET_TTL: 3600, PLAYBACK_PLAY_RESUME_WINDOW: 600 }),
      ).toThrow(/PLAYBACK_PLAY_RESUME_WINDOW/);
    });

    it('accepts a window comfortably above the TTL', () => {
      expect(() =>
        validate({ PLAYBACK_TICKET_TTL: 300, PLAYBACK_PLAY_RESUME_WINDOW: 2700 }),
      ).not.toThrow();
    });
  });

  describe('defaults', () => {
    // These must stay equal to the fallback each consumer hardcodes. Nest copies
    // validated defaults into process.env, so a mismatch here would silently
    // override a consumer's own default and make the two drift apart for real.

    it.each([
      ['QUEUE_DRAIN_DELAY_SECONDS', 30],
      ['QUEUE_STALLED_INTERVAL_SECONDS', 60],
      ['QUEUE_BACKGROUND_DRAIN_DELAY_SECONDS', 60],
      ['QUEUE_BACKGROUND_STALLED_INTERVAL_SECONDS', 300],
      ['PLAYBACK_MAX_PLAYS_PER_VIDEO', 3],
      ['PLAYBACK_MIN_COUNTED_PLAY_SECONDS', 30],
      ['PLAYBACK_PLAY_RESUME_WINDOW', 45 * 60],
    ])('%s defaults to %s, matching its consumer fallback', (key, expected) => {
      expect(validate()[key as keyof ReturnType<typeof validate>]).toBe(expected);
    });

    it('leaves the sweep on a one-minute cadence by default', () => {
      expect(validate().ANNOUNCEMENT_SWEEP_CRON).toBe('* * * * *');
    });

    it('leaves the worker flag off, so the API never runs processors by default', () => {
      expect(validate().RUN_WORKERS).toBe('false');
    });

    it('leaves swagger opt-in off', () => {
      expect(validate().ENABLE_SWAGGER).toBe('false');
    });
  });

  describe('every environment read is declared', () => {
    // This is the actual P1-9 guarantee. A new `process.env.FOO` that nobody
    // declared cannot be typo-checked, cannot be defaulted in one place, and
    // will not appear in the documented contract — so it fails here instead.

    const SRC = resolve(__dirname, '../../src');

    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) return walk(full);
        return full.endsWith('.ts') ? [full] : [];
      });

    const sources = walk(SRC);

    const readEnvNames = (text: string): string[] => {
      const names: string[] = [];
      const pattern = /process\.env\.([A-Z][A-Z0-9_]+)/g;
      let match: RegExpExecArray | null = pattern.exec(text);
      while (match !== null) {
        names.push(match[1]);
        match = pattern.exec(text);
      }
      return names;
    };

    // Provided by the process, not by us: npm injects the package version, and
    // hosting platforms inject their own external URLs.
    const EXTERNAL = new Set(['npm_package_version', 'RENDER_EXTERNAL_URL']);

    it('finds the source tree', () => {
      expect(sources.length).toBeGreaterThan(50);
    });

    it.each(
      [...new Set(sources.flatMap((file) => readEnvNames(readFileSync(file, 'utf8'))))]
        .filter((name) => !EXTERNAL.has(name))
        .sort()
        .map((name) => [name]),
    )('%s is part of the declared contract', (name) => {
      const contract = readFileSync(join(SRC, 'config/env.validation.ts'), 'utf8');
      const declared = new RegExp(`(?<![.\\w])${name}\\s*[?!]?\\s*[:=]`);

      expect(contract).toMatch(declared);
    });
  });
});