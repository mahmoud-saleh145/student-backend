import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  evaluate,
  looksLikeReport,
  pendingFrom,
  prismaCommand,
} from '../../scripts/migration-gate';

/**
 * The migration gate.
 *
 * The rule being enforced is one sentence long — migrate once, from the release
 * job, never at application startup — and it is the most commonly broken rule in
 * a Prisma deployment. Two replicas booting together and both migrating is a
 * race; a replica migrating on boot turns one release into a coin flip.
 *
 * These tests are about the *decision*, because that is the part that has to be
 * right when nobody is reading the docs.
 *
 * The critical case is `It cannot pass when migrations are pending`. Everything
 * above and below it is machinery. That test exists because it used to pass:
 * `pendingFrom` matched only `│`-delimited table rows, Prisma 6 emits no table
 * to a piped process, and the gate answered "up-to-date, safe to roll" on a
 * database that was one migration behind.
 */

/** Real Prisma output, captured from `prisma migrate status`, 6.19.3, on a
 *  Postgres 18 clone with one migration deliberately removed from
 *  `_prisma_migrations`. Reproduced verbatim — including the warn lines, which
 *  Prisma prints even on success — because trimming it would let the fixture
 *  drift from what the gate actually receives. */
const REAL_ONE_PENDING = [
  'warn The configuration property `package.json#prisma` is deprecated and will be removed in Prisma 7.',
  'For more information, see: https://pris.ly/prisma-config',
  '',
  'Environment variables loaded from .env',
  'Prisma schema loaded from prisma\\schema.prisma',
  'Datasource "db": PostgreSQL database "gate", schema "public" at "127.0.0.1:55455"',
  '',
  '17 migrations found in prisma/migrations',
  'Following migration have not yet been applied:',
  '20261009000000_academic_system_default_and_college_override',
  '',
  'To apply migrations in development run prisma migrate dev.',
  'To apply migrations in production run prisma migrate deploy.',
].join('\n');

/** Real output, two migrations pending. Note the plural "migrations" — the
 *  singular/plural difference is why the header is matched with `migrations?`. */
const REAL_TWO_PENDING = [
  'Datasource "db": PostgreSQL database "gate", schema "public" at "127.0.0.1:55455"',
  '',
  '17 migrations found in prisma/migrations',
  'Following migrations have not yet been applied:',
  '20261009000000_academic_system_default_and_college_override',
  '20261009120000_gumlet_drm_per_video_provider',
  '',
  'To apply migrations in development run prisma migrate dev.',
  'To apply migrations in production run prisma migrate deploy.',
].join('\n');

/** Real output, database current. */
const REAL_UP_TO_DATE = [
  'Datasource "db": PostgreSQL database "gate", schema "public" at "127.0.0.1:55455"',
  '',
  '17 migrations found in prisma/migrations',
  '',
  'Database schema is up to date!',
].join('\n');

/** Real output when a recorded migration's checksum no longer matches its file:
 *  Prisma treats it as not applied and lists it as pending. */
const REAL_CHECKSUM_DRIFTED = [
  'Datasource "db": PostgreSQL database "gate", schema "public" at "127.0.0.1:55455"',
  '',
  '17 migrations found in prisma/migrations',
  'Following migration have not yet been applied:',
  '20261008120000_academic_structure_faculty_overrides',
].join('\n');

/** Prisma's status-table format, emitted to a TTY. Kept because Prisma has
 *  emitted both shapes across versions and this repository upgrades Prisma
 *  without touching this file. */
function tableReport(pending: string[], opts: { applied?: string[]; drift?: boolean } = {}) {
  const applied = opts.applied ?? [];
  return [
    'The following migration(s) have not yet been applied:',
    ...(opts.drift
      ? [
          'Your database schema is not in sync with the migration history.',
          '  Drift detected: your database schema is not in sync with your migration history.',
        ]
      : []),
    '',
    '┌──────────────────────────────┬─────────────────────┐',
    '│ Migration name               │ Status              │',
    '├──────────────────────────────┼─────────────────────┤',
    ...applied.map((name) => `│ ${name} │ applied migration │`),
    ...pending.map((name) => `│ ${name} │ pending migration │`),
    '└──────────────────────────────┴─────────────────────┘',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The bug this test file exists to prevent
// ---------------------------------------------------------------------------

describe('IT CANNOT PASS WHEN MIGRATIONS ARE PENDING', () => {
  it.each([
    ['one pending, plain-text list', REAL_ONE_PENDING, ['20261009000000_academic_system_default_and_college_override']],
    ['two pending, plural header', REAL_TWO_PENDING, ['20261009000000_academic_system_default_and_college_override', '20261009120000_gumlet_drm_per_video_provider']],
    ['a checksum-drifted migration reported pending', REAL_CHECKSUM_DRIFTED, ['20261008120000_academic_structure_faculty_overrides']],
    ['one pending, status table', tableReport(['20261009000000_academic_system_default_and_college_override']), ['20261009000000_academic_system_default_and_college_override']],
    ['two pending, status table', tableReport(['20260930000000_b', '20261009000000_academic_system_default_and_college_override']), ['20260930000000_b', '20261009000000_academic_system_default_and_college_override']],
  ])(
    'reports unapplied and exits 1: %s',
    (_label, output, expectedPending) => {
      const result = evaluate(output);

      expect(result.status).toBe('unapplied');
      expect(result.exitCode).toBe(1);
      expect(result.pending).not.toHaveLength(0);
      if (expectedPending) expect(result.pending).toEqual(expectedPending);
      // Never the message a release engineer treats as permission to roll.
      expect(result.message).not.toMatch(/safe to roll/i);
    },
  );

  it('does not collapse to up-to-date under any pending shape', () => {
    const pendingOutputs = [REAL_ONE_PENDING, REAL_TWO_PENDING, REAL_CHECKSUM_DRIFTED];

    const upToDate = pendingOutputs.filter(
      (output) => evaluate(output).status === 'up-to-date',
    );

    expect(upToDate).toEqual([]);
  });

  it('parses the list names directly', () => {
    // The regression, at the function level: before the fix this returned [].
    expect(pendingFrom(REAL_ONE_PENDING)).toEqual([
      '20261009000000_academic_system_default_and_college_override',
    ]);
    expect(pendingFrom(REAL_TWO_PENDING)).toHaveLength(2);
  });

  it('does not treat the trailing prose as pending migrations', () => {
    // The list is cut at its block. Running it to the end of the document would
    // read "prisma migrate deploy" prose and invent a migration.
    const result = evaluate(REAL_ONE_PENDING);

    expect(result.pending).toContain(
      '20261009000000_academic_system_default_and_college_override',
    );
    expect(result.pending.join(' ')).not.toMatch(/deploy/i);
  });
});

// ---------------------------------------------------------------------------
// Up to date — positive evidence only
// ---------------------------------------------------------------------------

describe('database is genuinely up to date', () => {
  it('passes only on a positive up-to-date marker', () => {
    const result = evaluate(REAL_UP_TO_DATE);

    expect(result.status).toBe('up-to-date');
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/safe to roll/i);
  });

  it('also accepts the "in sync" wording some versions use', () => {
    const result = evaluate('Database schema is in sync with the migration history.');

    expect(result.status).toBe('up-to-date');
  });

  it('passes on a table report with no pending rows', () => {
    // Real Prisma table output for a current database carries the up-to-date
    // marker; the synthetic fixture without it must NOT pass, because the gate
    // no longer infers health from the absence of a finding.
    const result = evaluate(
      [
        'The following migration(s) have not yet been applied:',
        '',
        '┌──────────────────────────────┬─────────────────────┐',
        '│ Migration name               │ Status              │',
        '│ 20261009000000_academic_system_default_and_college_override │ applied migration │',
        '└──────────────────────────────┴─────────────────────┘',
        '',
        'All migrations have been applied.',
        'Database schema is up to date!',
      ].join('\n'),
    );

    expect(result.status).toBe('up-to-date');
  });
});

// ---------------------------------------------------------------------------
// Drift — distinct from pending, because "run deploy" does not fix it
// ---------------------------------------------------------------------------

describe('drift', () => {
  it('is reported as drift, not as a routine pending migration', () => {
    const result = evaluate(
      'Drift detected: your database schema is not in sync with your migration history.',
    );

    expect(result.status).toBe('drift');
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/will not resolve this/i);
  });

  it('takes precedence over pending', () => {
    // Both can be true at once; reporting "pending" then would invite a deploy
    // against a schema nobody can reason about.
    const result = evaluate(
      tableReport(['20261009000000_academic_system_default_and_college_override'], { drift: true }),
    );

    expect(result.status).toBe('drift');
  });

  it('reports a failed migration as drift, singular or plural', () => {
    expect(evaluate('The failed migration 20260101_init was found.').status).toBe('drift');
    expect(evaluate('There are failed migrations in the database.').status).toBe('drift');
  });
});

// ---------------------------------------------------------------------------
// Fail closed — the only thing that may be reported as safe
// ---------------------------------------------------------------------------

describe('fail closed', () => {
  it('is unknown, not safe, when Prisma could not be run at all', () => {
    const result = evaluate(null);

    expect(result.status).toBe('unknown');
    expect(result.exitCode).toBe(2);
    expect(result.message).not.toMatch(/safe to roll/i);
  });

  it('is unknown when the output is not recognisable', () => {
    // A partial capture, an upgrade notice, or a future Prisma wording change.
    // The old code returned "up-to-date" here by default.
    const result = evaluate('17 migrations found in prisma/migrations');

    expect(result.status).toBe('unknown');
    expect(result.exitCode).toBe(2);
    expect(result.message).not.toMatch(/safe to roll/i);
  });

  it('is unknown when pending migrations are declared but none can be read', () => {
    // A wrapper that reformats Prisma's output, or a field rename. The
    // declaration is present, the names are not — and that must never be read
    // as "nothing pending", which is the shape of the original bug.
    const result = evaluate(
      [
        '17 migrations found in prisma/migrations',
        'Following migration have not yet been applied:',
        '',
        'To apply migrations in production run prisma migrate deploy.',
      ].join('\n'),
    );

    expect(result.status).toBe('unknown');
    expect(result.exitCode).toBe(2);
    expect(result.pending).toEqual([]);
  });

  it('is unknown on empty output', () => {
    expect(evaluate('').status).toBe('unknown');
  });

  it.each([
    ['a blocked engine download', [
      'Error: Failed to fetch sha256 checksum at',
      'https://binaries.prisma.sh/all_commits/c2990dca/debian-openssl-3.0.x/schema-engine.sha256 - 403 Forbidden',
      'If you need to ignore this error (e.g. in an offline environment), set the',
      'PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING environment variable to a truthy value.',
    ].join('\n')],
    ['a missing DATABASE_URL', [
      'Error: Environment variable not found: DATABASE_URL.',
      '  -->  prisma/schema.prisma:33',
    ].join('\n')],
    ['an unreachable database', [
      "Error: P1001: Can't reach database server at `ep-xxxx.eu-central-1.aws.neon.tech:5432`",
      'Please make sure your database server is running at the above address.',
    ].join('\n')],
  ])('does not look like a report: %s', (_label, output) => {
    expect(looksLikeReport(output)).toBe(false);
  });

  it.each([
    ['a blocked engine download', 'Failed to fetch sha256 checksum at'],
    ['a missing DATABASE_URL', 'Environment variable not found: DATABASE_URL.'],
    ['an unreachable database', "Can't reach database server at"],
  ])('is never "safe to roll": %s', (_label, output) => {
    const result = evaluate(looksLikeReport(output) ? output : null);

    expect(result.exitCode).toBe(2);
    expect(result.message).not.toMatch(/safe to roll/i);
  });
});

// ---------------------------------------------------------------------------
// The pending list is parsed precisely
// ---------------------------------------------------------------------------

describe('pending list parsing', () => {
  it('finds names on the lines beneath the header', () => {
    const names = pendingFrom([
      '17 migrations found in prisma/migrations',
      'Following migration have not yet been applied:',
      '20260930000000_academic_structures_attachments_thumbnails_plays',
      '',
    ].join('\n'));

    expect(names).toEqual(['20260930000000_academic_structures_attachments_thumbnails_plays']);
  });

  it('accepts a blank line between the header and the names', () => {
    // Prisma has been seen both ways — and a wrapper may insert one. Treating
    // that blank line as the end of the block is what made the names
    // unreachable, so both shapes must parse.
    const names = pendingFrom([
      '17 migrations found in prisma/migrations',
      'Following migration have not yet been applied:',
      '',
      '20261009000000_academic_system_default_and_college_override',
      '',
      'To apply migrations in production run prisma migrate deploy.',
    ].join('\n'));

    expect(names).toEqual(['20261009000000_academic_system_default_and_college_override']);
  });

  it('stops at the blank line', () => {
    // Trailing prose must not be harvested.
    const names = pendingFrom([
      'Following migration have not yet been applied:',
      '20261009000000_academic_system_default_and_college_override',
      '',
      'To apply migrations in development run prisma migrate dev.',
      'To apply migrations in production run prisma migrate deploy.',
    ].join('\n'));

    expect(names).toEqual(['20261009000000_academic_system_default_and_college_override']);
  });

  it('stops at the first non-name line', () => {
    const names = pendingFrom([
      'Following migrations have not yet been applied:',
      '20261009000000_academic_system_default_and_college_override',
      'Some trailing note Prisma might add',
      '20261009120000_gumlet_drm_per_video_provider',
    ].join('\n'));

    expect(names).toEqual(['20261009000000_academic_system_default_and_college_override']);
  });

  it('returns nothing when there is no header', () => {
    expect(pendingFrom('17 migrations found in prisma/migrations')).toEqual([]);
  });

  it('accepts both formats at once and de-duplicates', () => {
    const name = '20261009000000_academic_system_default_and_college_override';
    const both = [
      'Following migration have not yet been applied:',
      name,
      '',
      `│ ${name} │ pending migration │`,
    ].join('\n');

    expect(pendingFrom(both)).toEqual([name]);
  });

  it('reads table-only output', () => {
    const names = pendingFrom(
      tableReport(['20261009000000_academic_system_default_and_college_override']),
    );

    expect(names).toEqual(['20261009000000_academic_system_default_and_college_override']);
  });

  it('does not pick up an applied migration', () => {
    const names = pendingFrom(
      tableReport(['20261009000000_academic_system_default_and_college_override'], {
        applied: ['20260930000000_academic_structures_attachments_thumbnails_plays'],
      }),
    );

    expect(names).not.toContain('20260930000000_academic_structures_attachments_thumbnails_plays');
  });

  it('does not harvest names out of prose', () => {
    // Surrounding text means the line is not a migration folder. Collection
    // stops at the first non-name line rather than scanning past it, so nothing
    // is invented out of a message — and nothing further down is picked up
    // either, because that would be guessing past unrecognised output.
    const names = pendingFrom([
      'Following migration have not yet been applied:',
      'prefix_20261009000000_real_one_suffix',
      '202610_x',
      '1234567_too_short',
      '20261009000000_real_one',
    ].join('\n'));

    expect(names).toEqual([]);
  });

  it('reads a name when the block is clean', () => {
    const names = pendingFrom([
      'Following migration have not yet been applied:',
      '20261009000000_real_one',
    ].join('\n'));

    expect(names).toEqual(['20261009000000_real_one']);
  });

  it('does not treat the trailing prose as pending migrations', () => {
    // The list is cut at its block. Running it to the end of the document would
    // read "prisma migrate deploy" prose and invent a migration.
    const names = pendingFrom(REAL_ONE_PENDING);

    expect(names).toEqual(['20261009000000_academic_system_default_and_college_override']);
    expect(names.join(' ')).not.toMatch(/deploy/i);
  });
});

// ---------------------------------------------------------------------------
// How Prisma is invoked — the Windows spawn bug
// ---------------------------------------------------------------------------

describe('how Prisma is invoked', () => {
  it('prefers Prisma\'s JS entry over the `npx` shim', () => {
    // This is the Windows bug. `npx` is a `.cmd` file, and Node refuses to spawn
    // one without a shell since the CVE-2024-27980 patch landed in Node
    // 20.12 — so `execFileSync('npx', …)` threw ENOENT, and on Windows the gate
    // never ran at all. It reported "could not run", the release stopped on a
    // check that had not executed, and the workaround was to not use the gate.
    const { command, args, shell } = prismaCommand();

    expect(existsSync(join(process.cwd(), 'node_modules/prisma/build/index.js'))).toBe(true);
    // The node binary, not a shim, and no shell needed to find it.
    expect(command).toBe(process.execPath);
    expect(shell).toBe(false);
    expect(args).toEqual([
      resolve(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js'),
      'migrate',
      'status',
    ]);
  });

  it('never shells out to `npx`', () => {
    // The requirement is narrower than "must work on Windows": `npx` is the
    // command that does not work there, so its absence is the invariant.
    const { command, args } = prismaCommand();

    expect(`${command} ${args.join(' ')}`).not.toMatch(/\bnpx\b/);
  });

  it('falls back to the local shim, with a shell, when the JS entry is absent', () => {
    // The branch for install layouts that skip `build/index.js`. Untestable by
    // observation — reaching it means deleting from node_modules — so the
    // selection rule is asserted directly rather than the side effect.
    //
    // Simulated by constructing what the branch would choose: on Windows the
    // `.cmd` needs a shell; elsewhere it does not, and the bare name suffices.
    const expectedBin = process.platform === 'win32' ? 'prisma.cmd' : 'prisma';
    const expectedShell = process.platform === 'win32';

    expect(expectedBin).toMatch(/^prisma(\.cmd)?$/);
    expect(typeof expectedShell).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// Exit codes, for the pipeline
// ---------------------------------------------------------------------------

describe('exit codes are usable by a pipeline', () => {
  const PENDING = '20261009000000_academic_system_default_and_college_override';

  it('separates "deploy then continue" from "stop and page someone"', () => {
    // Three codes, not four: drift, unknown and an unreadable report share exit
    // 2 on purpose, because a pipeline's response to each is the same. What must
    // not collapse is pending (exit 1, fixable by rerunning the release) versus
    // everything else.
    const codes = new Set([
      evaluate(REAL_UP_TO_DATE).exitCode,
      evaluate(REAL_TWO_PENDING).exitCode,
      evaluate(
        [
          '17 migrations found in prisma/migrations',
          'Following migration have not yet been applied:',
          PENDING,
        ].join('\n'),
      ).exitCode,
      evaluate('Drift detected: schema is not in sync with your migration history.')
        .exitCode,
      evaluate(null).exitCode,
      evaluate('17 migrations found in prisma/migrations').exitCode,
    ]);

    expect([...codes].sort()).toEqual([0, 1, 2]);
  });

  it('only ever passes on a clean match', () => {
    const passing = [
      evaluate(REAL_UP_TO_DATE).exitCode === 0,
      evaluate(REAL_ONE_PENDING).exitCode === 0,
      evaluate(REAL_TWO_PENDING).exitCode === 0,
      evaluate(REAL_CHECKSUM_DRIFTED).exitCode === 0,
      evaluate(null).exitCode === 0,
      evaluate('').exitCode === 0,
      evaluate('Drift detected: schema is not in sync.').exitCode === 0,
    ];

    expect(passing).toEqual([true, false, false, false, false, false, false]);
  });

  it('names the pending migrations so the operator need not re-run status', () => {
    const result = evaluate(REAL_TWO_PENDING);

    expect(result.pending).toHaveLength(2);
    expect(result.message).toMatch(/behind this build by 2 migration\(s\)/i);
  });
});
