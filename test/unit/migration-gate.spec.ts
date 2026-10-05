import { evaluate } from '../../scripts/migration-gate';

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