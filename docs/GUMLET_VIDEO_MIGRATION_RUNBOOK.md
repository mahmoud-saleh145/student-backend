# Video migration and shared-asset operations

> **THIS FILE IS A REWRITE, NOT THE ORIGINAL.**
>
> A `docs/GUMLET_VIDEO_MIGRATION_RUNBOOK.md` existed as an untracked, uncommitted
> file in the pre-incident worktree. It was destroyed by the workspace
> file-deletion incident of 2026-10-12 and **could not be recovered**: it is
> absent from every commit, every stash entry and every dangling object, and no
> copy survived on disk.
>
> Nothing below is transcribed from that document. It was written fresh against
> the code that actually exists, so it is accurate — but it is **not** a
> reproduction of what the original said, and any operational detail that was
> only in the original is now lost. Nothing in the repository referenced the
> file by name, so no code or documentation link is broken by this rewrite.

## What this covers

Moving existing videos onto the Gumlet DRM path, and sharing one uploaded video
between several lectures.

## 1. Moving existing videos to Gumlet

### The tool

```
npm run gumlet:migrate:dry-run    # report only, writes nothing
npm run gumlet:migrate:apply      # performs the writes
```

Entry point: `scripts/migrate-videos-to-gumlet.ts`, which delegates to
`GumletMigrationService` (`src/modules/videos/gumlet-migration.service.ts`) for
preflight, planning and execution.

### How decisions are made

All batch decisions live in `src/modules/videos/gumlet-migration.plan.ts`, which
is **pure** — no I/O, no Prisma, no Gumlet calls. A planning bug therefore
produces a wrong *report*, never a partially-migrated database. The rules:

| Situation | Action | Why |
|---|---|---|
| Soft-deleted row | `skip` | Adopting would resurrect removed content |
| `gumletAssetId` already stored | `verify` | **Duplicate-asset guard.** An asset exists at the provider; creating another is the only way to double-bill or double-ingest |
| `drmProvider = 'gumlet'`, no asset id | `skip` | A previous adoption may have created an asset that was never recorded |
| Unrecognised `drmProvider` | `skip` | `resolvePlaybackTarget` treats anything that is not exactly `gumlet` as legacy, so a typo would silently keep serving HLS |
| No `sourceKey` | `skip` | Nothing to hand Gumlet; adopting could create an empty asset |
| `PROCESSING` / `QUEUED` / `UPLOADING` | `skip` | The local worker owns the row and would fight the migration |
| Legacy, not READY, no HLS artefacts | `skip` | A repair, not a migration; switching paths would not make it play |
| Legacy, READY, has source | `adopt` | The ordinary candidate |

### Ordering

`verify` → `adopt` → `replace` → `skip`, ties broken by video id.

Videos that already have an asset go first: they are the cheapest work (no
asset is created, so no billing) and the highest-value verification, because they
prove the integration works without touching a student-visible row. `limit` is
applied **after** ordering, so a resumed run continues where it stopped instead
of re-deciding the batch.

### The two escape hatches

Both are per-call opt-ins and both require a **terminal** provider failure, and
neither is reachable by default:

- `--replace-errored-assets` → `REPLACE_FAILED_GUMLET_ASSET`. For a video still
  on legacy, still READY, whose asset died. `replaceFailedAsset()` re-asserts
  the opt-in, the terminal status, configuration and source presence before
  writing.
- `allowGumletProviderReplacement` → `REPAIR_FAILED_GUMLET_ASSET`. For a video
  already routed to Gumlet that is dark. Without this path there is no supported
  way out: `sync()` re-reads the same dead status forever.

## 2. Strict DRM playback

Playback refuses any video that is not verifiably CENC-encrypted. `drmProvider`
alone proves nothing — it is a routing flag this codebase wrote itself. The
authority is `DrmVerificationService`, and only it may set `drmVerifiedAt`:

- `POST /videos/:id/gumlet/verify` verifies one video.
- `DrmVerificationSweepService` re-verifies every 30 minutes
  (`MAINTENENANCE_JOBS.refreshDrmVerification`).
- Verification is cleared whenever a sync fails, so a video can never stay
  verified after its asset stops being verifiable.

There is deliberately **no** "mark as protected" path. An admin action must never
grant playback the backend has not verified against the provider.

## 3. Refreshing missing durations

Videos migrated to Gumlet may have `durationSeconds = 0`: the provider reports
the length under `input.duration` (float seconds), and an earlier version of the
ingest code discarded it. Playback was unaffected; only the displayed length was
wrong.

```
node scripts/backfill-gumlet-durations.js            # dry run (the default)
node scripts/backfill-gumlet-durations.js --apply
```

Safety properties:

- **Dry run by default.** Nothing is written without `--apply`.
- Writes are **guarded**: the `where` clause repeats every precondition
  (`durationSeconds: 0`, `status: 'READY'`, `deletedAt: null`), so if anything
  changed mid-run the statement matches nothing.
- Only `durationSeconds` and source geometry are ever written. `status`,
  `drmProvider`, `gumletAssetId`, `gumletStatus`, `drmVerifiedAt`, `drmRequested`
  and `drmBlockedReason` are never touched, so the script cannot move a video on
  or off the strict-DRM gate.
- A provider value that is missing, zero, negative or non-numeric is treated as
  **unknown** and the row is left alone. No duration is ever invented.
- No re-upload and no new asset: it performs a read-only `GET` on the asset.
- It then propagates each duration to every **attached** lecture and recounts the
  affected courses, because a reused lecture has no worker of its own and would
  otherwise keep reading 0.

The recount is a pure recomputation copied from `CoursesService.recountCourse`
(PUBLISHED, not soft-deleted), so re-running it is a no-op.

## 4. Sharing one video between lectures

A `Video` row owns the upload, the R2 object, the Gumlet asset id, the DRM state
and the processing status. `lesson_videos` records which lectures attach it.

```
POST   /videos/reuse/:lessonId        { "videoId": "..." }   attach (idempotent)
DELETE /videos/reuse/:lessonId/:videoId                     detach
```

Both are staff-only and authorised against the **destination** course — sharing
an asset into a course requires permission on that course.

Attach creates exactly one attachment row. It does not upload, does not create a
Gumlet asset, does not copy bytes and does not enqueue anything.

Detach, and `DELETE /videos/:videoId`, never destroy an asset while another
lecture still references it. They detach instead, and say so in the response
(`detached: true`).

### Ordering rules

`CourseSection(courseId, sortOrder)` then `Lesson(sectionId, sortOrder)`; the
first lecture of a course is the first non-deleted lesson of its lowest-ordered
non-deleted section. Soft-deleted rows are excluded everywhere.

### Playback

An asset attached to several lectures is still one asset, and authorisation is
evaluated against the lecture the viewer is watching — never the lecture that
uploaded the file. The client sends `lessonId` on
`POST /playback/videos/:videoId/ticket`. The server refuses when the named
lesson is not attached, and refuses rather than guessing when several lectures
share the asset and none is named.