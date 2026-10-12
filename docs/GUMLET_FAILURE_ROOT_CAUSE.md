# Gumlet Processing Failure — Root Cause Analysis

**Date:** 2026-10-11 23:31 local
**Scope:** read-only investigation. No code, database, or Gumlet asset was modified.

---

## 1. Headline

There are **two different failures**, and the plan upgrade fixed only one of them.

| Failure | Assets | Cause | Status |
|---|---|---|---|
| **A — quota** | 3 | Storage-minutes quota exhausted (was 50/60) | ✅ **Fixed** by the Growth upgrade |
| **B — source fetch** | 6 (all recent) | Gumlet was given the **Cloudflare Worker** URL, which returns **403** for `/source/` | ❌ **Unfixed** |

**Failure B is the one still breaking uploads.** It is not a quota problem and will not
be fixed by the upgrade.

---

## 2. Evidence

### Account state (authoritative, via `GET /v1/org/data`)

```
plan           : growthVideoMay26 ("Growth")
unpaid         : false
storage quota  : 180000 min
storage usage  : 0 min
fairplay creds : true
max proc dur   : 14400
```

Quota is no longer a constraint. Total library duration is **~210 minutes** against
**180,000** available.

### Asset-by-asset input URL

```
6acbecb0…  errored  WORKER URL   cmv48rpmw…  FAILED
6acbeb88…  errored  WORKER URL   cmv491uen…  FAILED
6acbe9bd…  errored  WORKER URL   cmv48einh…  FAILED
6acbe775…  errored  WORKER URL   cmv488lso…  FAILED
6acbe2fe…  errored  WORKER URL   cmv47p15l…  FAILED
6acbe029…  errored  WORKER URL   cmv45oru1…  FAILED
6acbc644…  errored  R2 URL       cmv1jekin…  READY (legacy)
6acbc11b…  errored  R2 URL       cmv2kduwg…  READY (legacy)
6acbc11a…  errored  R2 URL       (orphan)
6acbc013…  ready    R2 URL       cmv1inl46…  READY
```

Every asset whose input was the **Worker** URL failed with:
> *"We had trouble downloading the input video/audio file from the URL or path that is used."*

### Direct reproduction

```
GET  https://edu-media-gate.startuppp3.workers.dev/source/videos/... -> 403 Forbidden
```

The Worker denies `/source/` **by design** — that is a deliberate security rule
(`cloudflare-worker.js`: *"never serve the source upload, whatever the signature says"*).
Gumlet cannot fetch a URL the Worker is supposed to refuse.

### The R2 source itself is perfectly healthy

Signed presigned URL against the private bucket:

```
HEAD (no range)   -> 403 Forbidden     <-- Cloudflare R2 quirk
GET  full         -> 200 OK
GET  range 0-1023 -> 206 Partial Content
```

The object is present and readable over **GET** (what an ingester uses). The 403 on
`HEAD` is an R2 signature-method artifact, **not** a missing object.

### Why the wrong URL was sent

`GumletIngestService.adopt()` calls `presignIngestionUrl()`, which always produces an
**R2** URL. The current `main` (and `origin/main`) contains that fix — commit
`5f3778a "fix(gumlet): hand the transcoder a server-to-source presigned URL"`.

Yet the six most recent assets (21–75 min ago) were created with a Worker URL, while
`main`'s newest commit is from 21:47 — i.e. **after** most of them.

**Conclusion:** the **Render deployment is running build output older than `origin/main`**.
GitHub has the fix; the running service does not. This is a deploy-lag issue, not a code
defect.

---

## 3. Library reconciliation

| Metric | Count |
|---|---|
| Platform videos (live) | 12 (11 live + 1 archived) |
| Gumlet assets in workspace | 10 |
| Assets `ready` | 1 (`cmv1inl46`) |
| Assets `errored` | 9 |
| Orphan assets (no platform video) | **1** — `6acbc11a689a80cf2e474bf5` |
| Videos with duplicate asset refs | **1** — `cmv1jekin` (2 assets) |
| Worker-URL (fetch-failed) assets | 6 |
| Videos on legacy provider | 2 (`cmv1jekin`, `cmv2kduwg`) |
| Videos with no source object | 0 — **all 12 sources are intact** |
| Total library duration | ~210 min (quota 180,000) |

**Good news:** nothing is lost. Every source exists, no video is orphaned, and the quota
is effectively unlimited.

---

## 4. What must change before re-running

1. **Redeploy the backend from `origin/main`** — this alone fixes failure B. Confirm the
   deployed build includes commit `5f3778a`.
2. **Do not** "retry" the six Worker-URL assets. Retrying re-sends the same bad URL; the
   account now has 180,000 minutes free, so those assets should be **replaced**, not
   retried.

---

## 5. Recommended recovery (needs approval — mutates DB)

Since each video already carries a dead `gumletAssetId`, the existing idempotency guard
would make a plain re-run only re-sync the dead assets. Recovery requires clearing the
stale asset id first, then adopting.

Per video, in bounded batches, one at a time:

1. Record current provider/status/asset/lesson/course.
2. Clear `gumletAssetId` / `gumletStatus` / `gumletError`.
3. Re-adopt → new R2-signed asset with `enable_drm: true`.
4. Poll to `READY`, verify CENC, then confirm `drmProvider='gumlet'`.
5. On failure, restore the previous values (legacy HLS still intact).

Nothing is deleted: old errored assets stay at Gumlet, and R2 sources are untouched.

---

## 6. Separating readiness

- **Code readiness:** the ingestion path is correct in `main`.
- **Asset readiness:** only 1 of 12 videos has a working DRM asset. The rest are blocked.
- **Production readiness:** not met. Strict DRM enforcement (phase 4/5 work) is **not yet
  deployed**, so the legacy videos are still playable unprotected.