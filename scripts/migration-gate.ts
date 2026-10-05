/* eslint-disable no-console */
/**
 * =============================================================================
 * Migration gate
 * =============================================================================
 *
 * A pre-roll check, not a migration runner.
 *
 * The rule this enforces
 * ----------------------
 * `prisma migrate deploy` runs **once, from the release job, before the new
 * version rolls**. Never from application startup. Two replicas booting at the
 * same moment and both running migrations is a race with an unpleasant
 * resolution, and it is the single most common way a Prisma deployment goes
 * wrong.
 *
 * This script never applies anything. It only answers one question — *is the
 * database at the schema this build expects?* — and exits non-zero when it is
 * not, so a release pipeline can stop before it starts the bad version rather
 * than after.
 *
 * Why a gate rather than documentation
 * ------------------------------------
 * `docs/DEPLOYMENT.md` already states the rule, and it was still the most
 * likely mistake to make. Documentation is read once, at authoring time, by
 * someone who already knows the answer. This runs on every release, by someone
 * who does not.
 *
 * The three outcomes
 * ------------------
 *   exit 0 — database matches the migrations in this checkout. Safe to roll.
 *   exit 1 — unapplied migrations. The release job must run `migrate deploy`
 *            first. Rolling the API now would mean code querying columns that
 *            do not exist yet: a 500 on the first request that touches them.
 *   exit 2 — drift. The database schema no longer matches the migration
 *            history, which means something outside this pipeline changed it.
 *            No automated response is safe; this needs a human.
 *
 * Usage
 * -----
 *   npm run db:gate              # check only
 *   npm run db:gate -- --json    # machine-readable, for a pipeline
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

type Status = 'up-to-date' | 'unapplied' | 'drift' | 'unknown';

interface GateResult {
  status: Status;
  /** Migrations in this checkout that the database has not applied. */
  pending: string[];
  /** Human-readable explanation, safe to log. */
  message: string;
  /** Exit code this result maps to. */
  exitCode: number;
}

const EXIT_OK = 0;
const EXIT_UNAPPLIED = 1;
const EXIT_DRIFT = 2;

/** `prisma migrate status` prints this when the schema history is not intact. */
const DRIFT_MARKERS = [
  'drift detected',
  'migrations have not yet been applied',
  'failed migrations',
  'migration history is modified',
];

/** Runs the Prisma CLI and returns stdout, or null if it could not be run. */
function migrateStatus(): string | null {
  try {
    return execFileSync('npx', ['prisma', 'migrate', 'status'], {
      encoding: 'utf8',
      // Prisma is chatty on stderr even when it succeeds; only status matters.
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
  } catch (error) {
    // A non-zero exit still prints a useful report, so read what we can before
    // deciding this is "unknown".
    const output = `${(error as { stdout?: string }).stdout ?? ''}${
      (error as { stderr?: string }).stderr ?? ''
    }`;
    return output.length > 0 ? output : null;
  }
}

/**
 * Migration names Prisma reports as not yet applied.
 *
 * Prisma's table format is `│ <name> │ <status> │`, and the status column reads
 * `pending migration` for anything unapplied. Matching on the phrase rather than
 * a column index keeps this working if the padding or the columns change.
 */
function pendingFrom(output: string): string[] {
  const pending: string[] = [];

  for (const line of output.split(/\r?\n/)) {
    if (!/pending/i.test(line)) continue;

    const cells = line
      .split('│')
      .map((cell) => cell.trim())
      .filter(Boolean);

    // The migration directory name is the longest cell on a status line.
    const name = cells
      .filter((cell) => /^\d{8,}_[\w-]+$/.test(cell))
      .sort((a, b) => b.length - a.length)[0];

    if (name) pending.push(name);
  }

  return pending;
}

export function evaluate(output: string | null): GateResult {
  if (output === null) {
    return {
      status: 'unknown',
      pending: [],
      message:
        'Could not run `prisma migrate status`. DATABASE_URL may be missing or the ' +
        'database unreachable. Refusing to report the schema as safe.',
      exitCode: EXIT_DRIFT,
    };
  }

  const lowered = output.toLowerCase();

  // Drift is checked first. When the history is inconsistent, "pending" is not
  // a meaningful question — the count cannot be trusted — so it must not be
  // allowed to look like a routine "run deploy first".
  if (DRIFT_MARKERS.some((marker) => lowered.includes(marker.toLowerCase()))) {
    return {
      status: 'drift',
      pending: [],
      message:
        'Database schema does not match the migration history (drift or a failed ' +
        'migration). `migrate deploy` will not resolve this. Inspect ' +
        '`npx prisma migrate status` output and reconcile by hand.',
      exitCode: EXIT_DRIFT,
    };
  }

  const pending = pendingFrom(output);

  if (pending.length > 0) {
    return {
      status: 'unapplied',
      pending,
      message:
        `Database is behind this build by ${pending.length} migration(s). Run ` +
        '`npx prisma migrate deploy` as a separate release step BEFORE rolling ' +
        'this version.',
      exitCode: EXIT_UNAPPLIED,
    };
  }

  return {
    status: 'up-to-date',
    pending: [],
    message: 'Database schema matches this build. Safe to roll.',
    exitCode: EXIT_OK,
  };
}

function main(): void {
  const json = process.argv.includes('--json');

  if (!existsSync(resolve(process.cwd(), 'prisma', 'schema.prisma'))) {
    console.error('No prisma/schema.prisma here. Run this from the backend root.');
    process.exit(EXIT_DRIFT);
  }

  const result = evaluate(migrateStatus());

  if (json) {
    console.log(JSON.stringify(result));
  } else if (result.exitCode === EXIT_OK) {
    console.log(`✓ ${result.message}`);
  } else {
    console.error(`✗ ${result.message}`);
    for (const name of result.pending) console.error(`    pending: ${name}`);
  }

  process.exit(result.exitCode);
}

// Only run when invoked directly, so the evaluation above stays testable.
if (require.main === module) {
  main();
}