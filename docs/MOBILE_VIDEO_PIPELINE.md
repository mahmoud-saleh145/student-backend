# Independent mobile video pipeline

The native apps (Android, iOS) play lecture video from this platform's own
AES-128 HLS ladder on R2, served through the API's per-ticket manifests and
the media edge. Nothing on that path touches Gumlet, so mobile playback keeps
working if the Gumlet subscription ends. The student web app is unchanged: it
keeps Gumlet DASH/HLS with Widevine/FairPlay behind the strict DRM gate.

```
upload ─► R2 source ─┬─► video-processing queue ─► Gumlet asset ─► web (DASH + Widevine/FairPlay)
                     └─► mobile-video-processing queue ─► ffmpeg ladder ─► R2 hls/<id>/ ─► mobile (AES-128 HLS)
```

## Data model

| Field | Meaning |
| --- | --- |
| `Video.mobileStatus` | `NONE` → `QUEUED` → `PROCESSING` → `READY` / `FAILED`. Written only by the mobile job and the legacy local transcode. Never touches `Video.status` or any Gumlet field. |
| `Video.mobileError`, `mobileJobId`, `mobileProcessingStartedAt`, `mobileProcessedAt` | Bookkeeping for the dashboard and the recovery sweep. |
| `Video.hlsPrefix`, `masterPlaylistKey`, `isEncrypted`, `encryptionKeyId`, `renditions` | The ladder. Shared with the legacy local pipeline, which produces the same layout. |
| `PlaybackTicket.delivery` | `gumlet` or `hls`: which pipeline the grant was minted for. The manifest and key endpoints serve `hls` grants only. |

Migration: `prisma/migrations/20261108120000_mobile_video_pipeline`. Additive
and metadata-only; every existing video starts `NONE`, every existing ticket is
recorded as `gumlet`.

## How a mobile ticket is decided (`PlaybackService.planDelivery`)

The decision comes from the **bound device row** (`Device.platform` of the
device the session is bound to), never from the `platform` string in the
request body. That string still only picks Widevine vs FairPlay on the Gumlet
path.

| Situation | Result |
| --- | --- |
| No device, a `web` device, `MOBILE_VIDEO_DELIVERY=gumlet`, or a rotation of a Gumlet ticket | Gumlet, behind `assertStrictDrmGate` (unchanged) |
| ACTIVE Android/iOS device, `mobileStatus = READY` with renditions | `hls`: our manifest URL, `drm.scheme = 'none'` |
| ACTIVE mobile device, ladder not ready, `MOBILE_HLS_GUMLET_FALLBACK=true` | Gumlet (the migration window) |
| ACTIVE mobile device, ladder not ready, fallback off (or a rotation of an HLS ticket) | `VIDEO_NOT_READY` ("still being prepared for mobile") |

A rotation keeps the pipeline its original ticket used (`stickyDelivery`), so
a ladder finishing mid-lesson never swaps the source under a playing student.

Every other check in `issueTicket` is unchanged and runs before this:
publication, course and section entitlement, free preview, drip release,
device binding, concurrency, the play allowance, the issuance rate limit.

## What protects the HLS path

- **Manifest, media playlists and the key** are served by the API for a live
  ticket only (`ManifestService.requireLiveTicket`): ACTIVE, unexpired,
  session live, device ACTIVE, `delivery = 'hls'`, ladder READY. Signed URLs
  (`exp` + HMAC) and no caching.
- **Segments** are served by the Cloudflare media edge (`docs/cloudflare-worker.js`)
  from per-viewer signed URLs bound to user, session, device, ticket and the
  granted quality ceiling, and the edge asks the API whether the ticket is
  still live (`TICKET_CHECK=true`). Originals under `uploads/` are refused at
  the edge whatever the signature says.
- **Revocation** is real within one heartbeat (30 s): the heartbeat
  re-authorises, the edge re-checks liveness, playlists are re-fetched.
- **Three-play limit, device binding, watermark, FLAG_SECURE, capture
  response** are all ticket-level or client-level and unchanged.

**This is not DRM.** AES-128 HLS is transport encryption: any client that
holds a live ticket also receives the content key. A modified or compromised
client can therefore save the decrypted stream. Signed URLs, device binding
and FLAG_SECURE raise the cost of casual extraction; they are not equivalent
to Widevine L1 or FairPlay, which the web keeps.

## The mobile job

Queue `mobile-video-processing`, job `mobile-hls`, concurrency 1, 2 attempts
with jittered backoff. `MobileVideoProcessor` → `HlsTranscoder`:

1. check scratch space (source × 2.5 + 512 MB), download the source;
2. `ffprobe` (display dimensions, rotation applied); plan the ladder: tiers are the
   picture's SHORT side, 480/720/1080, nothing above the source, nothing below
   480, a sub-480 source encoded once at its own size, portrait kept portrait
   (`HlsTranscoder.planRenditions`);
3. per rung: `libx264` High 4.1, 8-bit 4:2:0, `veryfast`, CRF 23 with the
   bitrate cap, GOP at the source frame rate, a keyframe forced on every
   segment boundary, AAC stereo 48 kHz; 6 s MPEG-TS segments encrypted with
   the key derived from `HLS_KEY_ROOT`; upload (4 at a time), delete scratch;
4. static master, poster frame, `markMobileReady`.

A database outage leaves the row untouched for the queue retry; a host problem
(no ffmpeg, no scratch) is recorded as retryable; a genuine encode failure is
recorded with ffmpeg's last lines. `recoverStrandedVideos` re-queues a QUEUED
row whose job vanished and fails-then-requeues a PROCESSING row older than 4 h.

Measured on the development PC (ffmpeg 9, all cores): a 75 s 10-bit 1080p30
source → four rungs in 162 s, i.e. about 2.2× real time for the whole ladder.
A 44-minute lecture is therefore about 1.5–2 core-hours; see the hosting note.

## Operations

| Variable | Default | Meaning |
| --- | --- | --- |
| `MOBILE_VIDEO_DELIVERY` | `hls` | `gumlet` keeps every platform on Gumlet (pre-migration behaviour) |
| `MOBILE_HLS_GUMLET_FALLBACK` | `true` | Serve Gumlet to mobile while a video's ladder is not ready |
| `MOBILE_PIPELINE_ENABLED` | `true` | Queue a mobile transcode for every completed upload |
| `TRANSCODE_THREADS` | `0` | ffmpeg thread cap; `0` = every core but one |
| `TRANSCODE_WORK_DIR` | `/tmp/edu-transcode` | Scratch; bind-mount it to a host folder in Docker (see below) |
| `WORKER_QUEUES` | all | Which queues this worker consumes, e.g. `mobile-video-processing` alone |
| `TRANSCODE_MIN_FREE_GB` | `25` | Free space that must REMAIN on the scratch volume after a job takes its budget; below it jobs are deferred and a running encode is killed (see "Disk protection") |
| `TRANSCODE_DISK_CHECK_SECONDS` | `15` | How often a running encode re-checks free space |

### What the worker checks before and after an encode

- **Scratch preflight, three times.** Before the job is even CLAIMED
  (`MobileVideoProcessor` → `HlsTranscoder.preflight`): the volume must hold
  the source plus the largest rung's ceiling (`duration × (maxrate + audio)`,
  +8 % TS overhead, +512 MB; `source × 2.5` when the duration is unknown)
  **plus every other running job's reservation plus `TRANSCODE_MIN_FREE_GB`**.
  If not, the job is *deferred* five minutes (moved back to the delayed set,
  no attempt used, nothing downloaded, row untouched) and the worker logs by
  how much it is short. Inside the run the same check repeats before the
  download and, with the exact duration and the real rungs, after the probe;
  those two failures are `TranscodeEnvironmentError` (retried with backoff).
  A 1080p rung is ≈ 2.5 GB per hour at the ceiling; real lecture content
  lands at 4–6 % of it (measured on the library, 2026-11-09).
- **Verification before upload.** Each rung's playlist must end with
  `#EXT-X-ENDLIST`, every listed segment must exist and be non-empty, the
  summed segment duration must be within 2.5 % (or 3 s) of the source, and a
  stream-copy pass over the encrypted rung must demux and decrypt every
  segment. A failure is a `TranscodeOutputError`; nothing is published.
- **Read-after-write on R2.** The rung's playlist and its first and last
  segments are HEADed after upload and their sizes compared.
- **READY last.** `mobileStatus` becomes READY only after every rung passed
  all of the above, so a half-uploaded ladder is never served (the manifest
  endpoint refuses anything but READY).

### Interruptions (reboot, `docker stop`, a crash)

- SIGTERM kills ffmpeg at once (`HlsTranscoder.onModuleDestroy`); the job
  fails as interrupted and is retried when a worker is back.
- A hard crash leaves the job `active` until its 5-minute lock lapses; the
  stalled check then hands it back to the queue. The maintenance sweep
  (`recoverStrandedMobileVideos`) re-queues anything that slipped through.
- Scratch left behind is removed when the next worker boots
  (`MobileVideoProcessor.onModuleInit`).
- A retry re-runs the whole video and overwrites the same R2 keys; there is no
  partial resume (an hour-long encode is cheaper to redo than to reason about
  half-written segments).
- Progress (`GET /videos/:id/status` → BullMQ job progress) follows ffmpeg's
  own progress stream, so a 2-hour encode moves every few seconds.

### Disk protection (`ScratchGuard`)

The scratch volume on the laptop is the Windows system drive, so a full drive
is not a failed job, it is an unusable machine. Three gates, all in
`src/jobs/processors/scratch-guard.ts`:

1. **Before a job is claimed** — budget + other jobs' reservations + the
   reserve must fit, else the job is deferred (above).
2. **While it runs** — free space is re-read every
   `TRANSCODE_DISK_CHECK_SECONDS`; if it drops below the reserve for any
   reason (someone copies files onto the drive), ffmpeg is killed, the job's
   scratch is removed, the row goes back to QUEUED with the note "Paused for
   disk space", and the job is deferred. The source on R2 is never touched.
3. **Across processes** — each running job records its budget in Redis
   (`transcode:reserve:<host>:<videoId>`, released on completion, 6 h TTL as
   a backstop), so two worker containers on one host do not both pass the
   preflight against the same free bytes.

Cleanup is unconditional: each rung directory is deleted after its upload,
the job directory in `finally`, and anything left under `<workDir>/mobile`
by a crash is removed when the next worker boots. Nothing outside the job's
own directory is ever deleted.

The worker heartbeat (`worker:heartbeat`) now carries `queues`, `scratch`
(path, free, reserve, reservations, safe), `load`, `pause`, `activeJobs`
and `lastDeferral`; `GET /videos/mobile/overview` shows them.

### Pause, resume and the emergency switch

- `POST /videos/mobile/pause` (admin, body `{ reason? }`) sets a persistent
  Redis flag. The encode already running finishes; every job picked up after
  that is deferred a minute at a time until `POST /videos/mobile/resume`.
  The flag survives worker and API restarts. To interrupt the running encode
  as well, stop the container (SIGTERM → "interrupted" → retried later).
- `POST /videos/mobile/delivery` (admin, body `{ mode: 'gumlet' | 'hls' |
  'configured', gumletFallback? }`) is the **emergency routing switch**: a
  persistent override of `MOBILE_VIDEO_DELIVERY` / `MOBILE_HLS_GUMLET_FALLBACK`
  read by the playback planner on every mobile ticket. `gumlet` sends every
  bound mobile device back to Gumlet for every video within one ticket (no
  deploy, no app release); `configured` removes the override. It only picks
  which of the two gated pipelines mints the ticket - entitlement, device
  binding, the play allowance and the ticket chain are identical either way.
  The overview reports `deliveryOverride`.

### New uploads before historical work (`MobileEncodeScheduler`)

Owner rule: a newly uploaded video always goes before historical mobile HLS
work. The original upload queue and the mobile queue are separate BullMQ
queues, so BullMQ priorities cannot order one against the other; the rule is
enforced explicitly when a mobile job is about to start:

- **Historical jobs yield.** A `migration` or `recovery` job is deferred 30 s
  at a time (no attempt used, row untouched) while a fresh upload is
  *waiting* in `video-processing`. An encode that is already running is never
  interrupted; only the next historical job waits. If the original queue
  cannot be read, the job defers rather than start blind.
- **Inside the mobile queue,** `upload` and staff `retry` jobs carry no BullMQ
  priority while `recovery` (5) and `migration` (10) do; BullMQ drains the
  plain wait list first, so a new upload's mobile job always comes before any
  historical one.
- **One encode at a time across every worker process:** a Redis lease
  (`mobile:transcode:slot`, 120 s, renewed every 30 s while encoding) is taken
  before the video is claimed. A second container defers instead of encoding;
  a crashed holder frees the slot within two minutes.
- **No duplicate encodes:** the claim steps aside when another *live* job owns
  the video, and is compare-and-set on the job id it read. A job re-claiming
  its own row after a restart proceeds.
- **Cannot starve:** the original queue's delayed retries, its active job, an
  operator *pause* of the original queue (the two pause controls stay
  independent) and a waiting job older than 3 h (no consumer running) never
  hold mobile work back.

Verified on real BullMQ queues against a local Redis by
`test/unit/mobile-priority-real-queue.spec.ts` (run with
`PRIORITY_TEST_REDIS_URL=redis://localhost:6379`).

### Running the worker on a Windows laptop (Docker Desktop)

Use `deploy/laptop-worker/` (compose file, `.env.worker.example`,
`laptop-worker.ps1`):

- `.\laptop-worker.ps1 preflight` measures free space **from Windows**,
  creates `C:\edu-transcode`, starts a throw-away container with the same
  bind mount, writes a file inside it, checks the file is visible in Windows
  and that free space inside the container matches the Windows figure, deletes
  it and confirms the space came back. Verified 2026-11-09: the mount is a
  `9p`/drvfs mount of `C:\`; a 256 MB file written in the container reduced
  Windows free space by 0.25 GB and the deletion returned it; the WSL2 image
  did not grow. The container reports ≈ 5 GB more free than Windows does, so
  the laptop sets `TRANSCODE_MIN_FREE_GB=30` to keep ≥ 25 GB free in Windows
  terms.
- The compose file bind-mounts the scratch, caps the container
  (`cpus`, `mem_limit`), bounds its logs (5 × 20 MB), uses
  `restart: unless-stopped` and a 30 s stop grace. `TRANSCODE_THREADS=6`
  leaves half the machine to its owner at ≈ 10 % encode-speed cost on lecture
  content (measured: 1.91× at 4 threads, 2.02× at 11).
- Power: disable sleep on AC while a migration runs (`powercfg /change
  standby-timeout-ac 0`). A sleeping laptop is a worker that stopped
  renewing its lock; the job is retried, but nothing is encoded meanwhile.
- Without the bind mount the scratch lives in the container's writable layer
  inside the WSL2 disk image (`docker_data.vhdx`), which grows and does not
  shrink on its own. Never prune Docker or compact the vhdx as part of a
  migration; neither is needed once the mount is in place.

Endpoints (staff): `GET /videos/:id/status` carries `mobile`;
`POST /videos/:id/mobile/retry`. Admin: `GET /videos/mobile/overview`
(counts, remaining, progress %, throughput-based ETA, output bytes, queue
counts, pause, delivery override, the worker's host view, recent failures),
`POST /videos/mobile/migrate?dryRun=true|false&limit=N`,
`POST /videos/mobile/pause`, `POST /videos/mobile/resume`,
`POST /videos/mobile/delivery`.

### Migrating the existing library

1. Deploy the migration, then the API and the worker (same commit).
2. `POST /videos/mobile/migrate?dryRun=true` — read `wouldQueue`,
   `missingSource`, `noSourceKey`. A video with a missing source cannot be
   migrated and is never marked; it needs a re-upload.
3. `POST /videos/mobile/migrate?dryRun=false&limit=50`, repeat until
   `remaining` is 0. The worker processes one video at a time.
4. Watch `GET /videos/mobile/overview`. Mobile devices get the HLS ladder as
   each video becomes READY; until then they get Gumlet (fallback on).
5. When `READY` equals the live total: set `MOBILE_HLS_GUMLET_FALLBACK=false`.
   Mobile no longer depends on Gumlet in any case.

Rollback at any step: `POST /videos/mobile/delivery { mode: 'gumlet' }`
returns every mobile device to Gumlet within one ticket, with no deploy and no
app release; `MOBILE_VIDEO_DELIVERY=gumlet` does the same at the next
restart. The columns and the ladder on R2 are inert either way.

## Hosting the worker

The push, announcement and maintenance consumers need a fraction of a core;
the mobile transcode needs whole cores for an hour at a time. Run them as two
worker processes with `WORKER_QUEUES`, or one process on a host with at least
2 vCPU / 4 GB (`TRANSCODE_THREADS=0` already leaves a core). Scratch: the
source plus ≈ 2.5 GB per hour of 1080p, so 10 GB covers a 2-hour lecture.
The 1 GB free-tier VM considered in the worker audit is enough for the light
consumers only.
