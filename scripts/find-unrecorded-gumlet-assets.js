/* READ-ONLY operator report: Gumlet assets that exist but are not recorded on their video.
 * ---------------------------------------------------------------------------
 *
 * For every Gumlet video (drmProvider = 'gumlet') whose row records NO asset and
 * that changed in the last <days> days, asks Gumlet which assets carry the
 * video's tag and whether one of them passes every adoption check (workspace,
 * this video's stored file, size, DRM, not a failed asset). This is the
 * situation of 2026-11-20 (cmwp0i2sx001rho01ap2is9gu): Gumlet created the asset,
 * the database never learned its id.
 *
 * It WRITES NOTHING: no database write, no Gumlet create/delete, no queue
 * change. Recording an asset it reports is done by the worker's recovery sweep
 * (automatically, for rows still PROCESSING) or by a staff "Try again", which
 * now looks the asset up by tag before it would create one.
 *
 * USAGE (from the repository root, against a build of the current source):
 *
 *   npm run build
 *   node scripts/find-unrecorded-gumlet-assets.js <envFile> [days=30]
 *
 * <envFile> holds NAME=value lines (e.g. the worker container's environment).
 * Output: one JSON line per video, no URLs, no credentials.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const envFile = process.argv[2];
if (!envFile) {
  console.error('usage: node scripts/find-unrecorded-gumlet-assets.js <envFile> [days]');
  process.exit(2);
}
for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq <= 0) continue;
  let value = trimmed.slice(eq + 1);
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  process.env[trimmed.slice(0, eq)] = value;
}
// Never start queue consumers from a reporting script.
delete process.env.RUN_WORKERS;
// Never run the background Gumlet status monitor inside an operator script.
process.env.GUMLET_MONITOR_ENABLED = 'false';
const days = Number(process.argv[3] ?? 30);

const { NestFactory } = require('@nestjs/core');
const { AppModule } = require(path.join(ROOT, 'dist', 'src', 'app.module'));
const { GumletIngestService } = require(path.join(ROOT, 'dist', 'src', 'modules', 'videos', 'gumlet-ingest.service'));

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const report = await app.get(GumletIngestService).findUnrecordedAssets({ sinceDays: days });
    for (const row of report) console.log(JSON.stringify(row));
    const adoptable = report.filter((r) => r.adoptable).length;
    console.error(`${report.length} Gumlet video(s) without a recorded asset; ${adoptable} with an adoptable asset at Gumlet`);
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error('report failed:', String(error && error.message).slice(0, 300));
  process.exit(1);
});
