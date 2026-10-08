import { evaluate, looksLikeReport } from '../../scripts/migration-gate';

/**
 * The migration gate.
 *
 * The rule being enforced is one sentence long — migrate once, from the release
 * job, never at application startup — and it is the most commonly broken rule in
 * a Prisma deployment. Two replicas booting together and both migrating is a
 * race; a replica migrating on boot turns one release into a coin flip.
 *
 * These tests are about the *decision*, because that is the part that has to be
 * right when nobody is reading the docs. The expensive part, actually running
 * Prisma, is deliberately not mocked here.
 */

/** Prisma's real table output, trimmed to the shape that matters. */
function statusReport(pending: string[], opts: { drift?: boolean } = {}) {
  const rows = [
    'The following migration(s) have not yet been applied:',
    ...(opts.drift
      ? ['Your database schema is not in sync with the migration history.',
         '  Drift detected: your database schema is not in sync with your migration history.']
      : []),
    '',
    '┌──────────────────────────────┬─────────────────────┐',
    '│ Migration name               │ Status              │',
    '├──────────────────────────────┼─────────────────────┤',
    '│ 20260918010000_course_parts_and_part_codes │ applied migration │',
    '│ 20261004220000_playback_ticket_user_video_index │ applied migration │',
    ...pending.map(
      (name) => `│ ${name} │ pending migration │`,
    ),
    '└──────────────────────────────┴─────────────────────┘',
  ].join('\n');

  return rows;
}

describe('database matches the build', () => {
  it('passes when nothing is pending', () => {
    const result = evaluate(statusReport([]));

    expect(result.status).toBe('up-to-date');
    expect(result.exitCode).toBe(0);
  });

  it('says so in words a release engineer can act on', () => {
    expect(evaluate(statusReport([])).message).toMatch(/safe to roll/i);
  });
});

describe('database is behind the build', () => {
  const one = ['20261005010000_part_purchase_code_many_per_card'];

  it('fails, because code would query columns that do not exist yet', () => {
    const result = evaluate(statusReport(one));

    expect(result.status).toBe('unapplied');
    expect(result.exitCode).toBe(1);
  });

  it('exposes the pending names as structured data', () => {
    // A bare "it failed" sends the reader back to `migrate status` to find out
    // what to do, which is the step this gate exists to make unnecessary. The
    // one-line message stays short; the names travel in `pending` for the script
    // to print and for `--json` consumers to read.
    const result = evaluate(statusReport(one));

    expect(result.pending).toEqual(one);
  });

  it('counts every unapplied migration, not just the first', () => {
    const two = [
      '20261005010000_part_purchase_code_many_per_card',
      '20261006010000_something_else',
    ];

    const result = evaluate(statusReport(two));

    expect(result.pending).toHaveLength(2);
  });

  it('tells the operator to deploy as a separate step', () => {
    expect(evaluate(statusReport(one)).message).toMatch(
      /separate release step BEFORE rolling/i,
    );
  });

  it('never mistakes an applied migration for a pending one', () => {
    const result = evaluate(statusReport(one));

    expect(result.pending).not.toContain(
      '20260918010000_course_parts_and_part_codes',
    );
    expect(result.pending).not.toContain(
      '20261004220000_playback_ticket_user_video_index',
    );
  });
});

describe('drift', () => {
  const drifted = statusReport([], { drift: true });

  it('is reported as drift, not as a routine pending migration', () => {
    // The distinction matters operationally: "run deploy" does not fix drift,
    // and telling someone to run it wastes a deploy window.
    const result = evaluate(drifted);

    expect(result.status).toBe('drift');
    expect(result.exitCode).toBe(2);
  });

  it('says that deploy will not fix it', () => {
    expect(evaluate(drifted).message).toMatch(/will not resolve this/i);
  });

  it('takes precedence over pending', () => {
    // Both can be true at once, and reporting "pending" then would invite a
    // deploy against a schema nobody can reason about.
    const result = evaluate(
      statusReport(['20261005010000_part_purchase_code_many_per_card'], { drift: true }),
    );

    expect(result.status).toBe('drift');
  });
});

describe('the gate refuses to guess', () => {
  it('fails closed when Prisma could not be run at all', () => {
    // A missing DATABASE_URL is not evidence that the schema is fine. Defaulting
    // to "safe to roll" would turn a configuration mistake into an outage.
    const result = evaluate(null);

    expect(result.status).toBe('unknown');
    expect(result.exitCode).not.toBe(0);
  });

  it('names the likely cause when it cannot check', () => {
    expect(evaluate(null).message).toMatch(/DATABASE_URL/);
  });
});

describe('exit codes are usable by a pipeline', () => {
  // A realistic directory name. The gate matches migration names, so a
  // placeholder like "x_1" would silently test the wrong branch.
  const PENDING = '20261005010000_part_purchase_code_many_per_card';

  it('separates "deploy then continue" from "stop and page someone"', () => {
    // Three codes, not four: drift and an unreachable database share exit 2 on
    // purpose, because a pipeline's response to both is the same — stop and get
    // a human. What must not collapse is pending (exit 1, fixable by rerunning
    // the release) versus everything else.
    const codes = new Set([
      evaluate(statusReport([])).exitCode,
      evaluate(statusReport([PENDING])).exitCode,
      evaluate(statusReport([], { drift: true })).exitCode,
      evaluate(null).exitCode,
    ]);

    expect(codes.size).toBe(3);
    expect(evaluate(statusReport([PENDING])).exitCode).toBe(1);
    expect(evaluate(statusReport([], { drift: true })).exitCode).toBe(2);
    expect(evaluate(null).exitCode).toBe(2);
  });

  it('only ever passes on a clean match', () => {
    const passing = [
      statusReport([]),
      statusReport([], { drift: true }),
      statusReport([PENDING]),
      null,
    ].map((output) => evaluate(output).exitCode === 0);

    expect(passing).toEqual([true, false, false, false]);
  });
});
/**
 * The gate must fail closed when Prisma did not actually run.
 *
 * `prisma migrate status` exits NON-ZERO in two unrelated situations: when
 * migrations are pending (a report to read), and when it could not run at all —
 * no `DATABASE_URL`, an unreachable database, a blocked engine download. Both
 * reach the same `catch`, and the gate used to hand whatever had been printed to
 * `evaluate` as though it were a report. An error message carries no status
 * table, so it parsed as "nothing pending" and the gate answered exit 0,
 * "safe to roll" — from the one control that exists to stop a release going out
 * ahead of its schema.
 *
 * DEPLOYMENT.md states the contract: "The gate fails closed on purpose: 'I
 * could not check' is never reported as 'safe to roll'."
 */
describe('output from a failed run is not mistaken for a report', () => {
  /** Verbatim from a run where the engine download was blocked. */
  const ENGINE_BLOCKED = [
    'warn The configuration property `package.json#prisma` is deprecated and will be removed in Prisma 7.',
    '',
    'Error: Failed to fetch sha256 checksum at',
    'https://binaries.prisma.sh/all_commits/c2990dca/debian-openssl-3.0.x/schema-engine.sha256 - 403 Forbidden',
    '',
    'If you need to ignore this error (e.g. in an offline environment), set the',
    'PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING environment variable to a truthy value.',
  ].join('\n');

  const NO_DATABASE_URL = [
    'Error: Environment variable not found: DATABASE_URL.',
    '  -->  prisma/schema.prisma:33',
  ].join('\n');

  const UNREACHABLE = [
    "Error: P1001: Can't reach database server at `ep-xxxx.eu-central-1.aws.neon.tech:5432`",
    'Please make sure your database server is running at the above address.',
  ].join('\n');

  it.each([
    ['a blocked engine download', ENGINE_BLOCKED],
    ['a missing DATABASE_URL', NO_DATABASE_URL],
    ['an unreachable database', UNREACHABLE],
  ])('does not look like a report: %s', (_label, output) => {
    expect(looksLikeReport(output)).toBe(false);
  });

  it.each([
    ['a blocked engine download', ENGINE_BLOCKED],
    ['a missing DATABASE_URL', NO_DATABASE_URL],
    ['an unreachable database', UNREACHABLE],
  ])('is never "safe to roll": %s', (_label, output) => {
    // Through the real path the gate takes: unreadable output becomes `null`,
    // and `evaluate(null)` is the fail-closed branch.
    const result = evaluate(looksLikeReport(output) ? output : null);

    expect(result.status).toBe('unknown');
    expect(result.exitCode).toBe(2);
    expect(result.message).not.toMatch(/safe to roll/i);
  });

  it('still reads a real report that happens to exit non-zero', () => {
    // The pending case also exits non-zero. Failing closed must not break it,
    // or the gate would stop every release that legitimately needs a deploy.
    const pending = [
      'Following migration have not yet been applied:',
      '20261008120000_academic_structure_faculty_overrides',
      '',
      '│ 20261008120000_academic_structure_faculty_overrides │ pending migration │',
    ].join('\n');

    expect(looksLikeReport(pending)).toBe(true);
    expect(evaluate(pending).status).toBe('unapplied');
    expect(evaluate(pending).exitCode).toBe(1);
  });
});

/**
 * Prisma's own wording for pending migrations, which used to be read as drift.
 *
 * With two or more pending, Prisma pluralises to "Following migrations have not
 * yet been applied". That phrase sat in `DRIFT_MARKERS`, so the routine case
 * this gate exists for was reported as drift — "reconcile by hand" — when the
 * answer is `migrate deploy`. The spec's own fixture says "migration(s)", which
 * is why it never caught this.
 */
describe("Prisma's real pending wording", () => {
  function realReport(names: string[]): string {
    const plural = names.length === 1 ? 'migration' : 'migrations';
    return [
      `Following ${plural} have not yet been applied:`,
      ...names,
      '',
      ...names.map((n) => `│ ${n} │ pending migration │`),
      '',
      'To apply migrations in production run prisma migrate deploy.',
    ].join('\n');
  }

  it('reads one pending migration as unapplied', () => {
    const result = evaluate(realReport(['20261008120000_academic_structure_faculty_overrides']));

    expect(result.status).toBe('unapplied');
    expect(result.exitCode).toBe(1);
  });

  it('reads TWO pending migrations as unapplied, not as drift', () => {
    const result = evaluate(
      realReport([
        '20261007120000_allow_multiple_platform_academic_structures',
        '20261008120000_academic_structure_faculty_overrides',
      ])
    );

    expect(result.status).toBe('unapplied');
    expect(result.exitCode).toBe(1);
    expect(result.pending).toHaveLength(2);
  });

  it('still reports genuine drift as drift', () => {
    const drifted = [
      'Drift detected: your database schema is not in sync with your migration history.',
    ].join('\n');

    expect(evaluate(drifted).status).toBe('drift');
    expect(evaluate(drifted).exitCode).toBe(2);
  });

  it('still reports a failed migration as drift, singular or plural', () => {
    expect(evaluate('The failed migration 20260101_init was found.').status).toBe('drift');
    expect(evaluate('There are failed migrations in the database.').status).toBe('drift');
  });
});
