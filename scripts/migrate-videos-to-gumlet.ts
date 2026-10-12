/**
 * CLI entry point for migrating existing videos onto Gumlet DRM.
 *
 * SAFETY MODEL
 *
 *   --dry-run (DEFAULT)  reads the database, prints the plan, changes nothing,
 *                        and makes no call to Gumlet. This is the only mode that
 *                        is safe to run at any time.
 *
 *   --apply              performs the migration. Refuses unless BOTH
 *                        --confirm-migration is passed AND the preflight passes.
 *                        The confirm token is deliberately verbose so that
 *                        typing it cannot happen by muscle memory.
 *
 * There is no `--force`. A refusal is a refusal.
 *
 * NOTHING SENSITIVE IS EVER PRINTED
 *
 *   The signing secret, the API key, license tokens and signed ingestion URLs
 *   are never logged. Provider error text is classified into a reason code
 *   before it reaches the report, because Gumlet's error bodies echo the input
 *   URL - which for an ingestion failure IS a signed R2 URL.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';

import { GumletDrmService } from '../src/modules/playback/gumlet-drm.service';
import { StorageService } from '../src/modules/storage/storage.service';
import { CloudinaryService } from '../src/modules/storage/cloudinary.service';
import { PrismaService } from '../src/database/prisma.service';
import { GumletIngestService } from '../src/modules/videos/gumlet-ingest.service';
import {
  GumletMigrationService,
  MigrationReport,
} from '../src/modules/videos/gumlet-migration.service';

const CONFIRM_TOKEN = 'I-HAVE-READ-THE-RUNBOOK';

function parseArgs(argv: string[]) {
  const has = (f: string) => argv.includes(f);
  // Repeatable: --video-id a --video-id b. Restricts the run to those videos.
  const all = (f: string): string[] =>
    argv.reduce<string[]>((acc, arg, i) => (arg === f && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);
  const value = (f: string): string | undefined => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (f: string): number | undefined => {
    const v = value(f);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`${f} must be a positive number, got "${v}"`);
    }
    return Math.floor(n);
  };
  return {
    apply: has('--apply'),
    confirm: value('--confirm-migration'),
    limit: num('--limit'),
    maxAttempts: num('--max-attempts'),
    baseDelayMs: num('--base-delay-ms'),
    json: has('--json'),
    replaceErroredAssets: has('--replace-errored-assets'),
    // Repairing a video that is ALREADY routed to Gumlet but whose asset died.
    // Deliberately a separate flag from --replace-errored-assets.
    repairGumletProvider: has('--repair-gumlet-provider'),
    videoIds: all('--video-id'),
  };
}

function printHuman(report: MigrationReport, preflight: ReturnType<GumletMigrationService['preflight']>): void {
  const p = (s = '') => console.log(s);

  p('===============================================================');
  p(` GUMLET VIDEO MIGRATION - ${report.dryRun ? 'DRY RUN (no changes made)' : 'APPLY'}`);
  p(` ${report.startedAt} -> ${report.finishedAt}`);
  p('===============================================================');
  p('');
  p('PREFLIGHT');
  p(`  storage configured  : ${preflight.storageConfigured}`);
  p(`  asset API configured : ${preflight.assetApiConfigured}`);
  p(`  signing configured   : ${preflight.signingConfigured}`);
  p(`  DRM_ENABLED          : ${preflight.drmEnabled}`);
  // No secret-derived value is printed here, and none is computed. Whether
  // signing is configured is the only fact an operator needs before a run.
  for (const b of preflight.blockers) p(`  BLOCKER: ${b}`);
  for (const w of preflight.warnings) p(`  note   : ${w}`);
  p('');

  p(`rows examined: ${report.totalRows}   actionable: ${report.planned}`);
  p('');
  p('BY CATEGORY');
  for (const [k, v] of Object.entries(report.summary).sort()) p(`  ${k.padEnd(30)} ${v}`);

  if (report.dryRun) {
    p('');
    p('WOULD DO (nothing has been changed)');
    for (const o of report.outcomes) {
      if (o.result === 'SKIPPED') continue;
      p(`  ${o.videoId.padEnd(26)} ${o.action.padEnd(7)} ${o.detail}`);
    }
    p('');
    p('WOULD SKIP');
    for (const o of report.outcomes) {
      if (o.result !== 'SKIPPED') continue;
      p(`  ${o.videoId.padEnd(26)} ${o.detail}`);
    }
    p('');
    p('Re-run with --apply --confirm-migration ' + CONFIRM_TOKEN + ' to perform it.');
    return;
  }

  p('');
  p('RESULT');
  const grouped: Record<string, typeof report.outcomes> = {};
  for (const o of report.outcomes) (grouped[o.result] ??= []).push(o);
  for (const [result, list] of Object.entries(grouped)) {
    p(`  ${result} (${list.length})`);
    for (const o of list) p(`    ${o.videoId.padEnd(26)} ${o.detail}`);
  }

  if (Object.keys(report.failures).length) {
    p('');
    p('FAILURES BY REASON');
    for (const [k, v] of Object.entries(report.failures)) p(`  ${k.padEnd(30)} ${v}`);
    p('  Re-run the same command to retry. Adopted rows are not re-adopted.');
  }

  p('');
  p(`all actionable videos playable: ${report.allPlayable}`);
  p('PENDING rows become playable once Gumlet reports ready AND the manifest is');
  p('confirmed CENC-encrypted. Neither this tool nor any endpoint marks a video');
  p('playable on "ready" alone.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const app = await NestFactory.createApplicationContext(
    // A tiny context: exactly the services the migration needs. Booting the
    // whole AppModule would start workers, schedulers and Redis for a one-shot.
    (await import('./migration.module')).MigrationModule,
    { logger: ['warn', 'error'] },
  );
  const service = app.get(GumletMigrationService);
  const preflight = service.preflight();

  let report: MigrationReport;
  if (args.apply) {
    if (args.confirm !== CONFIRM_TOKEN) {
      console.error(
        `\nREFUSED: --apply requires --confirm-migration "${CONFIRM_TOKEN}".\n` +
          'No changes were made. Run without --apply to see the dry run first.\n',
      );
      await app.close();
      process.exit(2);
    }
    report = await service.run({
      limit: args.limit,
      maxAttempts: args.maxAttempts,
      baseDelayMs: args.baseDelayMs,
      allowAssetReplacement: args.replaceErroredAssets,
      allowGumletProviderReplacement: args.repairGumletProvider,
      onlyVideoIds: args.videoIds,
      onOutcome: (o) =>
        console.log(`  [${o.result}] ${o.videoId} ${o.detail}`),
    });
  } else {
    report = await service.dryRun(args.limit, {
      allowAssetReplacement: args.replaceErroredAssets,
      allowGumletProviderReplacement: args.repairGumletProvider,
      onlyVideoIds: args.videoIds,
    });
  }

  if (args.json) {
    console.log(JSON.stringify({ preflight, report }, null, 2));
  } else {
    printHuman(report, preflight);
  }

  await app.close();
  // Non-zero on a real-run failure so CI or a wrapper can detect it.
  process.exitCode = !report.dryRun && Object.keys(report.failures).length > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error('migration aborted:', error instanceof Error ? error.message : error);
  process.exit(1);
});

// Referenced so the compiler keeps these imports used by the module graph.
void StorageService;
void CloudinaryService;
void PrismaService;
void GumletDrmService;
void GumletIngestService;