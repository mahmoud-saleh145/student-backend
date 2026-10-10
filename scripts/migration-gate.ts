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
 * The four outcomes
 * -----------------
 *   exit 0 — up to date, on positive evidence. Safe to roll.
 *   exit 1 — unapplied migrations. The release job must run `migrate deploy`
 *            first. Rolling the API now would mean code querying columns that
 *            do not exist yet: a 500 on the first request that touches them.
 *   exit 2 — drift. The schema no longer matches the migration history, which
 *            means something outside this pipeline changed it.
 *   exit 2 — unknown. The check could not be completed, or produced something
 *            this gate could not read. Same code and same response as drift,
 *            because the safe reaction to both is identical: stop and ask a
 *            human.
 *
 * Exit 0 is reachable only through the first. That is the whole point of the
 * fourth case: "I could not find anything wrong" is not the same as "everything
 * is right", and only the first one may be reported as safe.
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

/**
 * `prisma migrate status` prints one of these when the history is not intact.
 *
 * "have not yet been applied" is deliberately NOT here, and never was. It is how
 * Prisma describes PENDING migrations — with two or more it pluralises to
 * "Following migrations have not yet been applied" — and it used to sit in this
 * list, which classified a routine pending state as drift and sent the operator
 * to "reconcile by hand" when the answer was `migrate deploy`.
 *
 * It is not a drift marker, and it is not an up-to-date marker either. It is a
 * declaration that migrations are pending, and the pending names belong to it.
 */
const DRIFT_MARKERS = [
  'drift detected',
  // Singular so it matches "failed migration" and "failed migrations" alike.
  'failed migration',
  'migration history is modified',
];

/**
 * Phrases that only ever appear in a real status report.
 *
 * This is what separates "Prisma ran and told us something" from "Prisma could
 * not run". It matters because `prisma migrate status` exits NON-ZERO in two
 * very different situations: when migrations are pending (a report we must
 * read), and when it failed outright — a missing `DATABASE_URL`, an unreachable
 * database, a blocked engine download. Both land in the same `catch`.
 *
 * Note this is a *report* test, not a health test. An error message that
 * happens to contain "database" is not thereby a report, and a report that says
 * nothing is not thereby healthy.
 */
const REPORT_MARKERS = [
  'pending migration',
  'have not yet been applied',
  'up to date',
  'drift detected',
  'failed migration',
  'migration history',
  'database schema is in sync',
];

/**
 * Runs Prisma and returns its report, or `null` when nothing usable was produced.
 *
 * `null` is the fail-closed answer, and `evaluate` turns it into "unknown",
 * exit 2. DEPLOYMENT.md states the contract: *"The gate fails closed on
 * purpose: 'I could not check' is never reported as 'safe to roll'."*
 *
 * Output that is not recognisable as a report is passed through rather than
 * discarded, so `evaluate` can tell "Prisma would not start" from "Prisma ran
 * and said something this version of the gate does not understand". Both end
 * in a stop; the messages point at different remedies.
 *
 * Historically this returned whatever the failed process had printed, as though
 * it were a report. With the database unreachable, Prisma prints an error that
 * carries neither a drift marker nor a pending row, so it was read as a clean
 * report and answered "up-to-date, safe to roll". The gate meant to catch "the
 * database is behind this build" green-lit exactly that.
 *
 * The rule: a zero exit is trusted; a non-zero exit is trusted only if the
 * output actually looks like a status report, which is what keeps the
 * legitimate pending case (also non-zero) working.
 */
function migrateStatus(): string | null {
  try {
    return spawnPrisma();
  } catch (error) {
    const captured = `${(error as { stdout?: string }).stdout ?? ''}${
      (error as { stderr?: string }).stderr ?? ''
    }`;
    // A report that happens to come with a failure exit (the pending case) is
    // kept; anything else becomes `null`, the fail-closed answer.
    return looksLikeReport(captured) ? captured : null;
  }
}

/**
 * `prisma migrate status`, and nothing else.
 *
 * Runs Prisma's own JavaScript entry point with the current Node binary rather
 * than through `npx`. `npx` is a `.cmd` shim on Windows, and spawning `.cmd`
 * needs `shell: true` since the Node 20.12 / CVE-2024-27980 change that the
 * shipped Node 20 no longer does implicitly — so `execFileSync('npx', …)` failed
 * with ENOENT on Windows, the gate reported "could not run", and every release
 * stopped on a check that had never actually executed.
 *
 * Running the JS entry directly needs no shell, no PATH lookup and no shell
 * quoting of the `?schema=…` argument, and behaves identically on Windows,
 * macOS and Linux. `process.execPath` is the node binary that is running this
 * script, so it works under a version manager too.
 *
 * A `.cmd` fallback is included for the case where `build/index.js` is absent
 * — a pnpm install layout that skips it — so this does not silently regress into
 * the Windows ENOENT it replaced.
 *
 * The decision is made by the exported `prismaCommand`, rather than inline, so
 * the fallback can be tested without touching `node_modules`.
 */
export function prismaCommand(): {
  command: string;
  args: string[];
  shell: boolean;
} {
  const args = ['migrate', 'status'];
  const entry = resolve(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js');

  if (existsSync(entry)) {
    return { command: process.execPath, args: [entry, ...args], shell: false };
  }

  // Windows resolves `prisma.cmd`; elsewhere the bare name. `shell` is needed
  // for the shim on Windows and harmless on POSIX.
  const bin = process.platform === 'win32' ? 'prisma.cmd' : 'prisma';
  const local = resolve(process.cwd(), 'node_modules', '.bin', bin);
  return {
    command: existsSync(local) ? local : bin,
    args,
    shell: process.platform === 'win32',
  };
}

function spawnPrisma(): string {
  const { command, args, shell } = prismaCommand();

  return execFileSync(command, args, {
    encoding: 'utf8',
    shell,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
}

/**
 * Whether output from a failed run still carries a readable status report.
 *
 * It exists to separate "Prisma ran and told us something" from "Prisma could
 * not run". It does NOT establish that the database is clean — that is what
 * `evaluate` decides, and only from a positive up-to-date marker.
 */
export function looksLikeReport(output: string): boolean {
  const lowered = output.toLowerCase();
  return REPORT_MARKERS.some((marker) => lowered.includes(marker));
}

/**
 * A Prisma migration name.
 *
 * `<8+ digits>_<name>` — the migration folder. Anchored so a stray word
 * beginning with digits cannot pass as one, and bounded in length so an
 * unwrapped line from a stack trace or a wrapped path is not picked up as a
 * migration that needs applying. The bound is deliberately generous; it exists
 * to reject non-names, not to police namespace taste.
 */
const MIGRATION_NAME = /^\d{8,}_[\w-]{1,120}$/;

/**
 * The "have not yet been applied" header, and the names listed beneath it.
 *
 * This is Prisma's plain-text format, which is what a piped `execFileSync` gets:
 * stdout is never a TTY, so Prisma 6 omits the status table entirely.
 *
 *   Following migration have not yet been applied:
 *   20261009000000_academic_system_default_and_college_override
 *
 * `count` is `null` when there is no header, which is how `evaluate` tells "no
 * declaration" from "declaration with no parsable names" — the second of which
 * must not be read as "nothing pending".
 */
function pendingHeaderIn(output: string): { declared: boolean; names: string[] } {
  const match = /following\s+migrations?\s+have\s+not\s+yet\s+been\s+applied:?[ \t]*/i.exec(
    output,
  );
  if (!match) return { declared: false, names: [] };

  // The header line's own newline is still ahead of the match, so what follows
  // begins with at least one empty element — sometimes two, when Prisma (or a
  // wrapper) also leaves a blank line before the list. Skip leading blanks: they
  // separate the header from the list and are not the terminator.
  //
  // A blank line AFTER a name is the terminator. Confusing the two is what made
  // the names unreachable, and unreachable names read as "nothing pending".
  const lines = output.slice(match.index + match[0].length).split(/\r?\n/);
  while (lines[0]?.trim() === '') lines.shift();

  // The block runs to the first line that is not itself a migration name. Cut
  // short rather than loose: running it to the end of the document would swallow
  // the "To apply migrations in production…" prose, and a migration invented
  // from prose would make a healthy database look behind.
  const names: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') break;
    if (MIGRATION_NAME.test(line.trim())) {
      names.push(line.trim());
      continue;
    }
    break;
  }

  return { declared: true, names };
}

/** Pending names from Prisma's table rows: `│ <name> │ pending migration │`. */
function pendingRowsIn(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!/pending migration/i.test(line)) continue;
    const name = line
      .split('│')
      .map((cell) => cell.trim())
      .find((cell) => MIGRATION_NAME.test(cell));
    if (name) names.push(name);
  }
  return names;
}

/**
 * Migration names Prisma reports as not yet applied.
 *
 * TWO formats, both real:
 *
 *   1. A plain list, which is what `execFileSync` actually gets. Piped stdout is
 *      never a TTY, so Prisma 6 omits the table and prints only
 *
 *        17 migrations found in prisma/migrations
 *        Following migration have not yet been applied:
 *        20261009000000_academic_system_default_and_college_override
 *
 *      The old parser looked only for the `│` separator, found nothing, and the
 *      gate fell through to "up-to-date, safe to roll" — a release going out
 *      ahead of its schema, from the one control that exists to prevent it.
 *
 *   2. A status table with `pending migration` rows, which is what a TTY gets.
 *      Retained, because the two formats have been observed across Prisma
 *      versions and this repository upgrades Prisma without touching this file.
 *
 * Both are parsed; the results are merged. When both are present the names
 * agree, and `parseReport` checks that rather than trusting it.
 */
export function pendingFrom(output: string): string[] {
  const fromRows = pendingRowsIn(output);
  const fromList = pendingHeaderIn(output).names;

  // Ordered, de-duplicated, stable. De-duplication matters because the two
  // formats name the same migrations; a duplicate would inflate the count in
  // the message and in `pending`.
  return [...new Set([...fromRows, ...fromList])].sort();
}

/** Positive markers that the database is current. Nothing else is accepted. */
const UP_TO_DATE_MARKERS = [
  'database schema is up to date',
  'database schema is in sync',
];

/**
 * What could not be determined reliably.
 *
 * The response to a `--json` consumer and to the exit code are identical to
 * drift's: stop, and get a human. The message differs because the remedy does —
 * drift means reconcile, unknown means work out why the check did not work.
 */
function undetermined(detail: string): GateResult {
  return {
    status: 'unknown',
    pending: [],
    message: `${detail} Refusing to report the schema as safe.`,
    exitCode: EXIT_DRIFT,
  };
}

/**
 * Decides the verdict.
 *
 * The rule is that **only positive evidence can pass**. Three ways in, and the
 * old shape of this function had it wrong in the third:
 *
 *   1. `null` — Prisma could not be run. Fail closed.
 *   2. A report naming pending migrations — exit 1, with the names.
 *   3. A report naming none — and here the old code returned "up-to-date" by
 *      default, on the reasoning that a recognized report with no pending rows
 *      must be current. It was a recognized report with no pending *rows*,
 *      which is not the same thing: the pending list had no rows in the table
 *      the parser read. Absence of a finding is not evidence of health.
 *
 * So `up-to-date` now requires a marker that says so, and anything that is
 * neither that nor an unambiguous pending report is `unknown`.
 */
export function evaluate(output: string | null): GateResult {
  if (output === null) {
    return undetermined(
      'Could not run `prisma migrate status`. DATABASE_URL may be missing or the ' +
        'database unreachable.',
    );
  }

  const lowered = output.toLowerCase();

  // Drift is checked first. When the history is inconsistent, "pending" is not a
  // meaningful question — the count cannot be trusted — so it must not be
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

  // No migrations declared pending. That is only "safe to roll" if the output
  // actually said the schema is current.
  if (UP_TO_DATE_MARKERS.some((marker) => lowered.includes(marker))) {
    return {
      status: 'up-to-date',
      pending: [],
      message: 'Database schema matches this build. Safe to roll.',
      exitCode: EXIT_OK,
    };
  }

  // A pending header whose names could not be parsed — a wrapper that reformats
  // Prisma's output, or a future Prisma that renames the field — must not be
  // read as "nothing pending". It is the same shape as the original bug, where
  // the declaration said pending and the parser found nothing: the parser was
  // wrong, and the answer had been "safe".
  if (pendingHeaderIn(output).declared) {
    return undetermined(
      '`prisma migrate status` reported pending migration(s) but their names ' +
        'could not be read.',
    );
  }

  // Neither. Either Prisma's wording changed, or the output is not a report at
  // all — an error, a partial capture, an upgrade notice. Unknown, not safe:
  // this is the branch the old implementation could not reach, because it had
  // no third option and defaulted to the first one.
  return undetermined(
    '`prisma migrate status` returned output this gate does not recognise as a ' +
      'complete report.',
  );
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