import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { StorageService } from '../../src/modules/storage/storage.service';
import {
  AUX_WORKER_HEARTBEAT_KEY,
  heartbeatKeyFor,
  MOBILE_WORKER_HEARTBEAT_KEY,
  readMobileWorkerHeartbeat,
  WORKER_HEARTBEAT_KEY,
} from '../../src/jobs/worker-heartbeat';
import { pauseHolds, readPauseState, writePauseState } from '../../src/jobs/processors/scratch-guard';

/**
 * THE SOURCE DOWNLOAD RESUMES INSTEAD OF STARTING OVER
 *
 * The transcode worker reads a several-hundred-megabyte source over a home
 * connection. One dropped read used to fail the job ("aborted", "socket hang
 * up") and the retry began again from byte zero. These tests drive the real
 * `StorageService.downloadToFile` against an S3 client that breaks streams on
 * purpose, and check both the bytes on disk and the requests that were made.
 */

const OBJECT = Buffer.from(Array.from({ length: 10_000 }, (_v, i) => i % 251));

interface Plan {
  /** How many bytes each successive GET delivers before its stream breaks (Infinity = to the end). */
  deliver: number[];
  /** Fail the request itself (before any body) on these attempt numbers. */
  refuse?: number[];
  status?: (attempt: number) => number | undefined;
}

function storageWith(plan: Plan, object = OBJECT) {
  const requests: { Range?: string; IfMatch?: string }[] = [];
  const client = {
    send: jest.fn(async (command: { input: { Range?: string; IfMatch?: string } }) => {
      const attempt = requests.length;
      requests.push({ Range: command.input.Range, IfMatch: command.input.IfMatch });
      const status = plan.status?.(attempt);
      if (status) throw Object.assign(new Error(`HTTP ${status}`), { $metadata: { httpStatusCode: status }, name: status === 404 ? 'NoSuchKey' : 'PreconditionFailed' });
      if (plan.refuse?.includes(attempt)) throw Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' });

      const start = command.input.Range ? Number(/bytes=(\d+)-/.exec(command.input.Range)![1]) : 0;
      const budget = plan.deliver[attempt] ?? Infinity;
      const slice = object.subarray(start, Math.min(object.length, start + budget));
      const breaks = start + slice.length < object.length;
      // The bytes are delivered first and the connection breaks afterwards, as
      // it does on a real link: what arrived before the drop is on disk.
      let sent = false;
      const body = new Readable({
        read() {
          if (sent) return;
          sent = true;
          if (slice.length > 0) this.push(slice);
          if (!breaks) this.push(null);
          else setTimeout(() => this.destroy(new Error('aborted')), 15);
        },
      });
      return {
        Body: body,
        ETag: '"etag-1"',
        ContentLength: object.length - start,
        ...(command.input.Range ? { ContentRange: `bytes ${start}-${object.length - 1}/${object.length}` } : {}),
      };
    }),
  };
  const service = Object.create(StorageService.prototype) as StorageService;
  Object.assign(service, {
    client,
    cfg: { buckets: { uploads: 'edu-uploads', media: 'edu-media', library: 'edu-library' } },
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    assertConfigured: () => undefined,
  });
  return { service, client, requests };
}

describe('StorageService.downloadToFile', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'edu-download-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const fast = { baseDelayMs: 1, maxDelayMs: 2 };

  it('a clean download is one request and a byte-exact file', async () => {
    const t = storageWith({ deliver: [Infinity] });
    const dest = join(dir, 'source.bin');

    await t.service.downloadToFile('uploads', 'source/a.mp4', dest, fast);

    expect(t.requests).toEqual([{ Range: undefined, IfMatch: undefined }]);
    expect((await readFile(dest)).equals(OBJECT)).toBe(true);
  });

  it('resumes from the byte it reached, three times, and the file is byte-exact', async () => {
    const t = storageWith({ deliver: [3000, 2500, 100, Infinity] });
    const dest = join(dir, 'source.bin');

    await t.service.downloadToFile('uploads', 'source/a.mp4', dest, fast);

    expect(t.requests.map((r) => r.Range)).toEqual([undefined, 'bytes=3000-', 'bytes=5500-', 'bytes=5600-']);
    // Every resumed read is pinned to the object it started on.
    expect(t.requests.slice(1).every((r) => r.IfMatch === '"etag-1"')).toBe(true);
    expect((await readFile(dest)).equals(OBJECT)).toBe(true);
  });

  it('survives requests that fail before any byte arrives (DNS drop) between progress', async () => {
    const t = storageWith({ deliver: [4000, 0, 0, Infinity], refuse: [1, 2] });
    const dest = join(dir, 'source.bin');

    await t.service.downloadToFile('uploads', 'source/a.mp4', dest, fast);

    expect(t.requests.map((r) => r.Range)).toEqual([undefined, 'bytes=4000-', 'bytes=4000-', 'bytes=4000-']);
    expect((await readFile(dest)).equals(OBJECT)).toBe(true);
  });

  it('gives up after a bounded number of attempts that deliver nothing', async () => {
    const t = storageWith({ deliver: [1000], refuse: [1, 2, 3, 4, 5, 6, 7, 8] });
    const dest = join(dir, 'source.bin');

    await expect(
      t.service.downloadToFile('uploads', 'source/a.mp4', dest, { ...fast, maxStalledAttempts: 3 }),
    ).rejects.toThrow(/failed after 3 attempts without progress \(1000 of 10000 bytes\)/);
    expect(t.requests).toHaveLength(4);
  });

  it('progress resets the attempt budget, so a long flaky download still completes', async () => {
    // Twelve interruptions, each after some progress: more than the budget of 3
    // in total, never more than one in a row without progress.
    const t = storageWith({ deliver: [...Array.from({ length: 12 }, () => 700), Infinity] });
    const dest = join(dir, 'source.bin');

    await t.service.downloadToFile('uploads', 'source/a.mp4', dest, { ...fast, maxStalledAttempts: 3 });

    expect(t.requests).toHaveLength(13);
    expect((await readFile(dest)).equals(OBJECT)).toBe(true);
  });

  it('does not retry an object that is not there', async () => {
    const t = storageWith({ deliver: [], status: () => 404 });

    await expect(t.service.downloadToFile('uploads', 'source/gone.mp4', join(dir, 'x'), fast)).rejects.toMatchObject({
      name: 'NoSuchKey',
    });
    expect(t.requests).toHaveLength(1);
  });

  it('refuses to stitch two different uploads together when the object changes mid-download', async () => {
    const t = storageWith({ deliver: [3000], status: (attempt) => (attempt === 1 ? 412 : undefined) });

    await expect(t.service.downloadToFile('uploads', 'source/a.mp4', join(dir, 'x'), fast)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
  });

  it('never appends to a file an earlier run left behind', async () => {
    const dest = join(dir, 'source.bin');
    await writeFile(dest, Buffer.alloc(50_000, 7));
    const t = storageWith({ deliver: [Infinity] });

    await t.service.downloadToFile('uploads', 'source/a.mp4', dest, fast);

    expect((await readFile(dest)).equals(OBJECT)).toBe(true);
  });
});

describe('StorageService.objectSizeStrict', () => {
  const service = (send: jest.Mock) => {
    const s = Object.create(StorageService.prototype) as StorageService;
    Object.assign(s, { client: { send }, cfg: { buckets: { uploads: 'edu-uploads' } } });
    return s;
  };

  it('null means the object is definitely absent', async () => {
    const s = service(jest.fn(async () => Promise.reject(Object.assign(new Error('nf'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }))));
    await expect(s.objectSizeStrict('uploads', 'k')).resolves.toBeNull();
  });

  it('a transport failure is thrown, not reported as "missing"', async () => {
    const s = service(jest.fn(async () => Promise.reject(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }))));
    await expect(s.objectSizeStrict('uploads', 'k')).rejects.toThrow('ETIMEDOUT');
  });

  it('returns the stored length', async () => {
    const s = service(jest.fn(async () => ({ ContentLength: 1234 })));
    await expect(s.objectSizeStrict('uploads', 'k')).resolves.toBe(1234);
  });
});

describe('worker heartbeat by role', () => {
  it('one worker for everything keeps the single key it always had', () => {
    expect(heartbeatKeyFor('all')).toBe(WORKER_HEARTBEAT_KEY);
    expect(heartbeatKeyFor(['video-processing', 'push-delivery', 'maintenance', 'analytics'])).toBe(WORKER_HEARTBEAT_KEY);
  });

  it('a dedicated encoder reports under its own key, so it cannot overwrite the light worker', () => {
    expect(heartbeatKeyFor(['mobile-video-processing'])).toBe(MOBILE_WORKER_HEARTBEAT_KEY);
    expect(heartbeatKeyFor(['push-delivery', 'maintenance'])).toBe(AUX_WORKER_HEARTBEAT_KEY);
  });

  const redis = (store: Record<string, unknown>) => ({ getJson: jest.fn(async (key: string) => store[key] ?? null) }) as never;

  it('the mobile worker is the primary one when that consumes the mobile queue', async () => {
    const all = { at: 'now', queues: 'all' };
    await expect(readMobileWorkerHeartbeat(redis({ [WORKER_HEARTBEAT_KEY]: all }))).resolves.toBe(all);
    const legacy = { at: 'now' }; // a heartbeat from before the `queues` field
    await expect(readMobileWorkerHeartbeat(redis({ [WORKER_HEARTBEAT_KEY]: legacy }))).resolves.toBe(legacy);
  });

  it('in the split deployment the light worker being up says nothing about the encoder', async () => {
    const light = { at: 'now', queues: ['video-processing', 'push-delivery', 'maintenance', 'analytics'], ffmpeg: false };
    const encoder = { at: 'now', queues: ['mobile-video-processing'], ffmpeg: true };

    await expect(readMobileWorkerHeartbeat(redis({ [WORKER_HEARTBEAT_KEY]: light }))).resolves.toBeNull();
    await expect(
      readMobileWorkerHeartbeat(redis({ [WORKER_HEARTBEAT_KEY]: light, [MOBILE_WORKER_HEARTBEAT_KEY]: encoder })),
    ).resolves.toBe(encoder);
  });
});

describe('operator pause scope', () => {
  const store = new Map<string, unknown>();
  const redis = {
    getJson: async (key: string) => store.get(key) ?? null,
    setJsonPersistent: async (key: string, value: unknown) => void store.set(key, value),
    del: async (key: string) => void store.delete(key),
  } as never;

  it('a flag written before scopes existed still pauses everything', async () => {
    store.set('mobile:transcode:paused', { reason: 'old', by: 'op', at: 'then' });
    const pause = await readPauseState(redis);
    expect(pause).toMatchObject({ paused: true, scope: 'all' });
    for (const trigger of ['upload', 'retry', 'migration', 'recovery']) expect(pauseHolds(pause, trigger)).toBe(true);
  });

  it('a historical pause holds the backlog and lets uploads and staff retries through', async () => {
    const pause = await writePauseState(redis, true, 'admin_1', 'between batches', 'historical');
    expect(pause).toMatchObject({ paused: true, scope: 'historical', reason: 'between batches' });
    expect(pauseHolds(pause, 'migration')).toBe(true);
    expect(pauseHolds(pause, 'recovery')).toBe(true);
    expect(pauseHolds(pause, 'upload')).toBe(false);
    expect(pauseHolds(pause, 'retry')).toBe(false);
  });

  it('resuming clears it', async () => {
    const pause = await writePauseState(redis, false, 'admin_1');
    expect(pause).toMatchObject({ paused: false, scope: 'all' });
    expect(pauseHolds(pause, 'migration')).toBe(false);
  });
});

describe('HLS output uploads are retried', () => {
  // Imported lazily so this file does not pull the transcoder in for the tests above.
  const load = async () => (await import('../../src/jobs/processors/hls-transcoder')).withOutputRetry;

  it('a dropped connection costs a retry of that one object, not the encode', async () => {
    const withOutputRetry = await load();
    const notes: string[] = [];
    let calls = 0;

    const result = await withOutputRetry(
      'upload of hls/v_1/720p/seg_00042.ts',
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('socket hang up');
        return 'stored';
      },
      { baseDelayMs: 1, onRetry: (m) => notes.push(m) },
    );

    expect(result).toBe('stored');
    expect(calls).toBe(3);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain('seg_00042.ts');
  });

  it('is bounded: a store that keeps refusing fails the job with the real error', async () => {
    const withOutputRetry = await load();
    let calls = 0;

    await expect(
      withOutputRetry(
        'upload',
        async () => {
          calls += 1;
          throw new Error('AccessDenied');
        },
        { attempts: 4, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('AccessDenied');
    expect(calls).toBe(4);
  });
});
