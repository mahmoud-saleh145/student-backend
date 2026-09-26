# Running the production video worker on a Windows PC (temporary)

This runs **only the background worker** on your PC, using the existing
production Docker image. Everything else stays where it is:

```
Dashboard (Vercel) → API (Render) → Redis (Upstash) → Worker (this PC, Docker)
                                                     → ffmpeg / ffprobe
                                                     → Cloudflare R2 → Media Worker → Mobile app
                                   → Postgres (Neon)
```

The worker only makes **outgoing** connections (Upstash, Neon, R2). It opens
no port, so nothing on your PC is exposed to the internet.

No code changes are needed for this. The worker entry point
(`dist/src/worker.js`), the Dockerfile and the environment validation already
support it; everything below is runtime configuration.

---

## 0. One-time checks

### 0.1 Docker Desktop

Install Docker Desktop (WSL 2 backend) and start it. In PowerShell:

```powershell
docker version
```

Both `Client` and `Server` must be shown.

### 0.2 The `.env` file supplies the secrets at runtime

The container reads `C:\Users\mahmoud\Desktop\edu-backend\.env` **when it
starts** (`--env-file`). The file is **not** copied into the image:
`.dockerignore` excludes `.env` and `.env.*`. You can check this in step 1.3.

These values must be **identical to the ones on the Render API service**.
Otherwise the worker talks to a different queue or database, or produces
videos the API cannot decrypt.

| Variable | Why it must match Render exactly |
| --- | --- |
| `REDIS_URL` | Same Upstash database, or the worker never sees the API's jobs |
| `REDIS_PREFIX` (`edu`) | Queues and the heartbeat key are named `edu:…`; a different prefix is a different queue |
| `DATABASE_URL` | The worker updates the same `Video` rows the API reads |
| `HLS_KEY_ROOT` | Per-video AES keys are derived from it by both the worker (encrypting) and the API (serving keys). **If it differs, every video the worker processes will not play.** |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Reads the upload, writes the HLS output |
| `R2_BUCKET_UPLOADS` (`edu-uploads`), `R2_BUCKET_MEDIA` (`edu-media`), `R2_BUCKET_LIBRARY` (`edu-library`) | Same buckets as the API and the media Worker |

These are also required, because the worker runs the same startup validation as
the API. It refuses to start without them:

`NODE_ENV=production`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
`JWT_PLAYBACK_SECRET` (three different values of at least 32 characters),
`MEDIA_SIGNING_KEY`, `MEDIA_CDN_BASE_URL`, `CORS_ORIGINS` (not `*`),
`MEDIA_LOCAL_ORIGIN` (not `true`).

These are used as they are: `FFMPEG_PATH=ffmpeg`, `FFPROBE_PATH=ffprobe`,
`TRANSCODE_WORK_DIR=/tmp/edu-transcode` (inside the container),
`HLS_SEGMENT_SECONDS`, `HLS_ENCRYPTION_ENABLED`, `PUSH_PROVIDER` and
`EXPO_ACCESS_TOKEN` (for the push queue).

`RUN_WORKERS` is **not** needed: `dist/src/worker.js` sets it itself.

`PORT` and `PUBLIC_API_URL` are harmless here; the worker does not listen on a
port.

**Format rules for `--env-file`.** Docker does not process the file the way
dotenv does:

- one `KEY=value` per line, no `export`;
- **no quotes** around values (Docker keeps them as part of the value);
- no comments after a value on the same line.

Your current `.env` follows these rules.

---

## 1. Build the image

```powershell
cd C:\Users\mahmoud\Desktop\edu-backend
docker build --target production -t edu-worker:local .
```

The first build takes several minutes: it installs ffmpeg, runs `npm ci`,
`prisma generate` and `nest build`. Later builds reuse the cache.

### 1.1 Check that ffmpeg and ffprobe are in the image

```powershell
docker run --rm --entrypoint ffmpeg edu-worker:local -hide_banner -version
docker run --rm --entrypoint ffprobe edu-worker:local -hide_banner -version
```

### 1.2 Check that the worker entry point exists

```powershell
docker run --rm --entrypoint ls edu-worker:local -l /app/dist/src/worker.js
```

### 1.3 Check that no `.env` was copied into the image

```powershell
docker run --rm --entrypoint sh edu-worker:local -c "ls -A /app; ls /app/.env* 2>/dev/null || echo 'OK: no .env in image'"
```

The last line must be `OK: no .env in image`.

**Never `docker push` this image.** It contains no secrets, but there is no
reason for it to leave your PC.

---

## 2. Start the worker

```powershell
cd C:\Users\mahmoud\Desktop\edu-backend
docker run -d --name edu-worker --hostname edu-worker-pc --env-file .env --no-healthcheck --stop-timeout 3600 --restart on-failure:5 edu-worker:local node dist/src/worker.js
```

- `--env-file .env`: secrets are supplied at start time, not stored in the image.
- `--no-healthcheck`: the Dockerfile's health check calls the API's HTTP port,
  which the worker does not have. Without this flag Docker Desktop would label
  the container "unhealthy". That label is cosmetic, but misleading.
- `--stop-timeout 3600`: `docker stop` waits up to an hour for a running
  transcode to finish instead of killing it after 10 seconds.
- `--restart on-failure:5`: restarts after a crash, up to 5 times. It does
  **not** start by itself after a reboot, so you decide when it runs (see §8
  about Redis usage).
- No `-p`: no port is published.

---

## 3. Watch the logs

```powershell
docker logs -f --tail 200 edu-worker
```

Press Ctrl+C to stop following. This does not stop the worker.

A healthy start includes these lines (timestamps omitted; the order can vary):

```
[RedisService] Redis connected
[PrismaService] Database connected
[WorkerHeartbeat] queue consumers registered in this process; heartbeat started
[MaintenanceScheduler] recurring maintenance jobs registered
[Worker] Worker started — processing video, push, maintenance and analytics queues
```

**Bad signs:**

- `Invalid environment configuration` or `Refusing to start in production…`: a
  variable is missing or wrong. The message names it.
- `ffmpeg=false ffprobe=false`: not expected with this image. Rebuild it.
- `RUN_WORKERS is not "true"`: you started the API entry point
  (`dist/src/main.js`) by mistake. Use the command in §2.

---

## 4. Verify the worker is connected to production Redis

1. The log line `[RedisService] Redis connected` means the connection to
   Upstash succeeded.
2. The heartbeat is the end-to-end proof. The worker writes
   `edu:worker:heartbeat` every 20 seconds (it expires after 60 seconds), and
   the **Render API reads that key from its own Redis**. If the API reports the
   worker (§5), both are using the same Redis database and the same prefix.

---

## 5. Verify the production API sees the worker

The Render free instance may take about a minute to wake up.

```powershell
$h = Invoke-RestMethod https://student-backend-814y.onrender.com/api/v1/meta/health/deep
$h.data.checks
$h.data.videoPipeline.worker
$h.data.videoPipeline.videosByStatus
```

Expected:

- `checks.worker` → `True`
- `videoPipeline.worker.ffmpeg` → `True`, `videoPipeline.worker.ffprobe` → `True`
- `videoPipeline.worker.host` → `edu-worker-pc`
- `videosByStatus.UPLOADING` → `24`. These are the legacy records; nothing
  touches them.

If `checks.worker` is `False` while the log shows `Worker started`, `REDIS_URL`
or `REDIS_PREFIX` in `.env` differs from Render's.

---

## 6. Test a video: QUEUED → PROCESSING → READY

Use a short clip first (30 seconds to 2 minutes, 720p or 1080p MP4).

1. In the dashboard: **Courses → (course) → Content → (lecture) → upload
   video**.
2. The lecture's video panel shows **QUEUED**, then **PROCESSING**, then
   **READY**. It refreshes by itself.
3. In the worker log:
   ```
   [VideoProcessor] transcoding video <videoId> (job transcode:<videoId>:<n>)
   [VideoProcessor] probe <videoId>: 1920x1080 95s h264
   ```
   and, when it is done:
   ```
   [VideoProcessor] video <videoId> ready (<n> renditions)
   ```
4. Run the command from §5 again: `videosByStatus.READY` has gone up by 1, and
   `UPLOADING` is still `24`.

If the panel shows **FAILED**, the panel and the worker log show the reason.
Fix the cause, then press **Retry** in the panel. The stored upload is
reprocessed without uploading again.

### Playback in the mobile app

The lecture must be **Published**, in a visible section, and the test student
must be enrolled. Open the lecture in the app. It should start playing, with
the watermark. Playback does not involve your PC at all: it goes through the
Render API (playlist and key) and the Cloudflare media Worker (segments). The
worker's only role is producing the encrypted HLS in `edu-media`.

---

## 7. Stop the worker safely

```powershell
docker stop edu-worker
```

This sends SIGTERM. The worker removes its heartbeat, stops taking new jobs,
**finishes the transcode in progress** (up to the 3600-second stop timeout) and
exits. While it finishes, `checks.worker` already reads `false`. The container is kept, so you can start it again (§9).

To remove the container completely:

```powershell
docker rm edu-worker
```

If it is killed mid-transcode (`docker stop -t 0`, power loss, PC sleep), the
job's lock expires within 30 minutes. When a worker runs again, BullMQ puts
that job back on the queue and it is reprocessed from the stored upload (two
attempts per video). If that doesn't happen, the maintenance recovery marks it
FAILED with "Processing was interrupted"; press **Retry** in the dashboard.

**Keep the PC awake while a video is PROCESSING** (Settings → System → Power →
Sleep: Never while plugged in).

---

## 8. What happens while the PC is off

- Uploads keep working: the dashboard uploads straight to R2 and the API
  queues the job in Upstash Redis. Jobs are **stored in Redis**, not on your
  PC, so nothing is lost.
- Those videos stay **QUEUED**. The lecture's video panel shows "No video
  worker is running, so this will stay queued", and `checks.worker` is
  `false`.
- When the worker starts again, it processes the waiting videos one at a time,
  oldest first.
- Scheduled jobs (announcement dispatch, stream-slot cleanup, expiries) only
  run while a worker is running. Missed runs are not replayed one by one; the
  next run picks up whatever is due.
- **Upstash quota:** a running worker uses Redis even when idle (about 6,600
  commands per hour, measured with this BullMQ version). The free plan allows
  500,000 per month. Stop the worker when you don't need it, and watch usage
  in the Upstash console.

---

## 9. Restart the worker

| Situation | Command |
| --- | --- |
| Start it again after `docker stop` | `docker start edu-worker` |
| Restart it (graceful) | `docker restart edu-worker` |
| You changed `.env` | `docker stop edu-worker`, `docker rm edu-worker`, then the `docker run` from §2. **`docker start`/`restart` do NOT re-read `.env`**; the variables are fixed when the container is created. |
| You pulled new backend code | `docker stop edu-worker`, `docker rm edu-worker`, the `docker build` from §1, then the `docker run` from §2 |

Check the state at any time:

```powershell
docker ps -a --filter name=edu-worker
```

---

## 10. Security notes

- No port is published; the container only connects outwards.
- Secrets exist only in your `.env` file and in the container's runtime
  environment. `docker inspect edu-worker` shows them, so never paste its
  output anywhere.
- The image contains no `.env` (checked in §1.3). Do not push it to any
  registry.
