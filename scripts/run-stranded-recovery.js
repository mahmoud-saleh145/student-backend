/* Run the platform's own stranded-video recovery sweep on demand.
 * Read-only with respect to the provider; it mirrors what the maintenance
 * scheduler runs every 30 minutes.
 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const envFile = process.argv[2];
for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq <= 0) continue;
  process.env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
}
delete process.env.RUN_WORKERS;

const { NestFactory } = require('@nestjs/core');
const { AppModule } = require(path.join(ROOT, 'dist', 'src', 'app.module'));
const { VideosService } = require(path.join(ROOT, 'dist', 'src', 'modules', 'videos', 'videos.service'));

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: false });
  const videos = app.get(VideosService);
  const result = await videos.recoverStrandedVideos();
  console.log('SWEEP RESULT: ' + JSON.stringify(result));
  await app.close();
  process.exit(0);
})().catch((e) => { console.error('SWEEP FAILED:', e && e.message); process.exit(1); });
