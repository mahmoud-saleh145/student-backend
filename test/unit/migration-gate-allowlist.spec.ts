/**
 * Proves the gate's central safety property for the two-migration release:
 * an UNEXPECTED third pending migration still hard-stops.
 *
 * The gate has no allowlist — by design. It answers "is the database behind this
 * build", and the operator compares the named migrations against the audited
 * list in DEPLOYMENT.md. This checks that the gate does the part it owns.
 */
import { evaluate, pendingFrom } from '../../scripts/migration-gate';

const BASE = [
  'Environment variables loaded from .env',
  'Prisma schema loaded from prisma\\schema.prisma',
  'Datasource "db": PostgreSQL database "neondb", schema "public" at "host"',
  '',
  '17 migrations found in prisma/migrations',
  'Following migrations have not yet been applied:',
];

const AUDITED = [
  '20261009000000_academic_system_default_and_college_override',
  '20261009120000_gumlet_drm_per_video_provider',
];

const report = (names: string[]) => [...BASE, ...names, ''].join('\n');

describe('the two-migration audited release', () => {
  it('names exactly the two audited migrations', () => {
    expect(pendingFrom(report(AUDITED))).toEqual(AUDITED);
  });

  it('stops with exit 1 and names both', () => {
    const r = evaluate(report(AUDITED));
    expect(r.status).toBe('unapplied');
    expect(r.exitCode).toBe(1);
    expect(r.pending).toEqual(AUDITED);
  });

  it('is never reported as safe to roll', () => {
    expect(evaluate(report(AUDITED)).message).not.toMatch(/safe to roll/i);
  });
});

describe('an UNEXPECTED pending migration', () => {
  const SURPRISE = '20261101120000_someone_elses_migration';

  it('is detected alongside the audited two', () => {
    expect(pendingFrom(report([...AUDITED, SURPRISE]))).toContain(SURPRISE);
  });

  it('still hard-stops with exit 1', () => {
    const r = evaluate(report([...AUDITED, SURPRISE]));
    expect(r.exitCode).toBe(1);
    expect(r.status).toBe('unapplied');
  });

  it('is named in the operator-facing message', () => {
    // The gate prints `pending:` lines; if the name is missing the operator
    // cannot tell an unexpected migration from an audited one.
    expect(evaluate(report([...AUDITED, SURPRISE])).pending.join(' ')).toContain(
      SURPRISE,
    );
  });

  it('alone, with nothing else pending, also stops', () => {
    const r = evaluate(report([SURPRISE]));
    expect(r.exitCode).toBe(1);
    expect(r.pending).toEqual([SURPRISE]);
  });
});

describe('the gate has no allowlist by design', () => {
  it('treats an audited migration no differently from an unknown one', () => {
    // This is the property that keeps the DEPLOYMENT.md list a HUMAN check:
    // if the gate ever learned to whitelist these two, the document could
    // silently fall behind the code and stop meaning anything.
    const audited = evaluate(report(AUDITED));
    const unknown = evaluate(report(['20260101000000_something_else']));
    expect(audited.status).toBe(unknown.status);
    expect(audited.exitCode).toBe(unknown.exitCode);
  });

  it('only exit 0 is available on a positive up-to-date marker', () => {
    expect(
      evaluate(
        [
          'Environment variables loaded from .env',
          'Prisma schema loaded from prisma\\schema.prisma',
          'Database schema is up to date',
        ].join('\n'),
      ).exitCode,
    ).toBe(0);
  });
});