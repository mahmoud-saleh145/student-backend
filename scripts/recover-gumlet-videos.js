/* Operator recovery for a video whose GUMLET asset failed terminally.
 * ---------------------------------------------------------------------------
 *
 * WHAT THIS IS
 *
 * A thin operator wrapper around the platform's OWN recovery method,
 * `VideosService.retryProcessing()` - the exact method behind
 * `POST /videos/:id/retry`, which is what the dashboard's "Try processing again"
 * button calls. It exists for the case where the API deployment cannot be
 * redeployed immediately and the operator needs the recovery NOW.
 *
 * It is deliberately NOT a side channel: it boots the real Nest application
 * graph, so every guard the platform has - the course-ownership check, the
 * "does the source object still exist" check, the "does the account have room"
 * check, the atomic claim that stops two assets being minted - runs exactly as
 * it does in production. There is no way to use this to bypass them.
 *
 * It does not talk to the provider, the database or the queue directly, and it
 * does not mark anything READY. The worker does that, after the provider has
 * actually finished, and only after the DRM check passes.
 *
 * USAGE
 *
 *   node scripts/recover-gumlet-videos.js <envFile> <videoId> [videoId...]
 *
 * <envFile> is a file of `NAME=value` lines. The environment is read from it
 * rather than from the command line so that no credential ends up in a shell
 * history, a process listing or a log. The usual source is the running worker
 * container:
 *
 *   docker inspect <worker> --format '{{range .Config.Env}}{{println .}}{{end}}' > prod.env
 *
 * Run it from the repository root, against a build of the CURRENT source
 * (`npm run build`), so that the recovery uses the same code the deployment
 * will.
 *
 * THE ACTOR
 *
 * The recovery is attributed to the platform's active MASTER account, because
 * the platform's convention is that a write on `videos` names the actor that
 * caused it and the authorisation check is a real one. The audit row therefore
 * names the master account rather than the person who ran this script; that is
 * a deliberate, recorded choice and not an accident.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// --- environment ------------------------------------------------------------
const envFile = process.argv[2];
if (!envFile) {
  console.error('usage: node scripts/recover-gumlet-videos.js <envFile> <videoId>...');
  process.exit(2);
}
for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq <= 0) continue;
  const name = trimmed.slice(0, eq);
  let value = trimmed.slice(eq + 1);
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  process.env[name] = value;
}
// The API and the worker are separate processes; this one only ENQUEUES.
delete process.env.RUN_WORKERS;

const videoIds = process.argv.slice(3);
if (videoIds.length === 0) {
  console.error('no video ids given');
  process.exit(2);
}

// --- boot the real application ----------------------------------------------
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require(path.join(ROOT, 'dist', 'src', 'app.module'));
const { VideosService } = require(path.join(ROOT, 'dist', 'src', 'modules', 'videos', 'videos.service'));
const { PrismaService } = require(path.join(ROOT, 'dist', 'src', 'database', 'prisma.service'));

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: false });

  const videos = app.get(VideosService);
  const prisma = app.get(PrismaService);

  // The actor is a real, active, privileged account: the platform's own
  // convention is that a write on `videos` names its actor, and the
  // authorisation check is a real one that must pass.
  const actorRow = await prisma.user.findFirst({
    where: { role: 'MASTER', status: 'ACTIVE' },
    select: { id: true, role: true },
  });
  if (!actorRow) {
    console.error('no active MASTER account to authorise the recovery with');
    await app.close();
    process.exit(1);
  }
  const actor = { id: actorRow.id, role: actorRow.role };

  const results = [];
  for (const videoId of videoIds) {
    const before = await prisma.video.findUnique({
      where: { id: videoId },
      select: {
        id: true,
        status: true,
        drmProvider: true,
        gumletAssetId: true,
        gumletStatus: true,
        processingError: true,
      },
    });

    try {
      const result = await videos.retryProcessing(videoId, actor);
      const after = await prisma.video.findUnique({
        where: { id: videoId },
        select: {
          id: true,
          status: true,
          gumletAssetId: true,
          gumletStatus: true,
          processingError: true,
          processingJobId: true,
        },
      });
      results.push({
        id: videoId,
        before: { status: before?.status, assetId: before?.gumletAssetId, gumletStatus: before?.gumletStatus },
        ok: true,
        result: { status: result.status, provider: result.provider, recovered: result.recovered, assetId: result.assetId ?? null, jobId: result.jobId },
        after,
      });
    } catch (error) {
      results.push({
        id: videoId,
        before: { status: before?.status, assetId: before?.gumletAssetId, gumletStatus: before?.gumletStatus },
        ok: false,
        error: { code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 400) },
      });
    }
  }

  console.log(JSON.stringify({ actor: { id: actor.id, role: actor.role }, results }, null, 1));

  await app.close();
  process.exit(0);
})().catch(async (error) => {
  console.error('RECOVERY FAILED:', error && error.message);
  process.exit(1);
});
