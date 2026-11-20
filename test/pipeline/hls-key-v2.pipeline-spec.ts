import { createDecipheriv } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BITRATES, HlsTranscoder } from '../../src/jobs/processors/hls-transcoder';
import { deriveContentKeyV1, deriveContentKeyV2, deriveIvV1 } from '../../src/modules/playback/hls-keys';

/**
 * REAL ffmpeg: encode → verify → decrypt, for the v1 and v2 key schemes, with
 * the worker's own ffmpeg arguments and keyinfo/verification helpers.
 *
 * FFMPEG (env) selects the binary, so the same test runs against the
 * worker image's ffmpeg 5.1.9 as well as a newer local one. Skipped when no
 * ffmpeg is available. Run with:
 *   npx jest --testRegex 'test/pipeline/hls-key-v2\.pipeline-spec\.ts$'
 */
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const hasFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0;
const maybe = hasFfmpeg ? describe : describe.skip;

const ROOT = 'pipeline-test-root-that-is-long-enough-for-hmac';
const VIDEO = 'v_pipeline';
const SEG = 2;

function ffmpeg(args: string[]): void {
  execFileSync(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

function encodeRung(dir: string, source: string, tier: number, keyInfoPath: string, perSegmentIv: boolean): string {
  const outDir = join(dir, `${tier}p`);
  execFileSync(process.platform === 'win32' ? 'cmd' : 'mkdir', process.platform === 'win32' ? ['/c', 'mkdir', outDir] : ['-p', outDir]);
  const rate = BITRATES[tier] ?? BITRATES[480]!;
  const width = Math.round((tier * 16) / 9 / 2) * 2;
  const args = HlsTranscoder.ffmpegArgs({
    sourcePath: source,
    outDir,
    height: tier,
    width,
    bitrateKbps: rate.video,
    maxrateKbps: rate.maxrate,
    audioKbps: rate.audio,
    keyInfoPath,
    perSegmentIv,
    segmentSeconds: SEG,
    frameRate: 25,
    threads: 2,
  }).filter((a) => a !== 'pipe:1' && a !== '-progress');
  ffmpeg(args);
  return outDir;
}

/** The worker's own verification pass: every key line → local key, stream-copy the whole rung. */
function verify(outDir: string, keyPath: string): void {
  const text = readFileSync(join(outDir, 'index.m3u8'), 'utf8');
  copyFileSync(keyPath, join(outDir, 'verify.key'));
  writeFileSync(join(outDir, 'verify.m3u8'), HlsTranscoder.pointKeysAt(text, 'verify.key'));
  ffmpeg([
    '-hide_banner', '-loglevel', 'error', '-nostats', '-xerror',
    '-allowed_extensions', 'ALL', '-protocol_whitelist', 'file,crypto,data',
    '-i', join(outDir, 'verify.m3u8'), '-map', '0', '-c', 'copy', '-f', 'null', '-',
  ]);
}

function seqIv(n: number): Buffer {
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(n, 12);
  return iv;
}

/** Decrypts one segment; a correct KEY yields MPEG-TS (sync byte 0x47 every 188 bytes) and valid padding. */
function decryptsToTs(segment: Buffer, key: Buffer, iv: Buffer): boolean {
  try {
    const d = createDecipheriv('aes-128-cbc', key, iv);
    const plain = Buffer.concat([d.update(segment), d.final()]);
    return plain.length >= 376 && plain[0] === 0x47 && plain[188] === 0x47;
  } catch {
    return false;
  }
}

/**
 * The first plaintext block of a segment. Under CBC a wrong IV corrupts ONLY
 * this block, and only in the bytes where the IVs differ (12-15 for small
 * sequence numbers), so the sync byte alone cannot tell IVs apart: every
 * segment starts with the same SDT packet, so a correct IV reproduces segment
 * 0's first block (bytes 4-15; byte 3 holds a continuity counter).
 */
function firstBlock(segment: Buffer, key: Buffer, iv: Buffer): Buffer {
  const d = createDecipheriv('aes-128-cbc', key, iv);
  d.setAutoPadding(false);
  return d.update(segment.subarray(0, 16)).subarray(4);
}

maybe(`HLS key schemes with real ffmpeg (${FFMPEG})`, () => {
  let dir: string;
  let source: string;
  let version: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'hls-key-v2-'));
    source = join(dir, 'source.mp4');
    version = execFileSync(FFMPEG, ['-version']).toString().split('\n')[0]!;
    ffmpeg([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=9',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=9',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source,
    ]);
  }, 120_000);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('v2: a key per rung, and every segment encrypted with its own IV = its sequence number, declared in the playlist', () => {
    const rungs: Record<number, { outDir: string; key: Buffer; playlist: string }> = {};
    for (const tier of [480, 720]) {
      const keyPath = join(dir, `enc-${tier}.key`);
      const keyInfoPath = join(dir, `enc-${tier}.keyinfo`);
      const key = deriveContentKeyV2(ROOT, VIDEO, tier);
      writeFileSync(keyPath, key);
      writeFileSync(keyInfoPath, HlsTranscoder.keyInfoText(keyPath));
      const outDir = encodeRung(join(dir, 'v2'), source, tier, keyInfoPath, true);
      verify(outDir, keyPath); // the worker's gate passes
      const playlist = readFileSync(join(outDir, 'index.m3u8'), 'utf8');
      rungs[tier] = { outDir, key, playlist };

      const segments = playlist.split('\n').filter((l) => l.endsWith('.ts'));
      expect(segments.length).toBeGreaterThanOrEqual(4);
      // One key line per segment, each declaring that segment's sequence IV.
      const ivs = [...playlist.matchAll(/#EXT-X-KEY:METHOD=AES-128,URI="key-placeholder",IV=0x([0-9a-fA-F]{32})/g)].map((m) => m[1]!.toLowerCase());
      expect(ivs).toEqual(segments.map((_s, n) => seqIv(n).toString('hex')));

      const ref = firstBlock(readFileSync(join(outDir, segments[0]!)), key, seqIv(0));
      segments.forEach((name, n) => {
        const bytes = readFileSync(join(outDir, name));
        expect(decryptsToTs(bytes, key, seqIv(n))).toBe(true);
        expect(firstBlock(bytes, key, seqIv(n)).equals(ref)).toBe(true); // encrypted with IV = n...
        if (n > 0) expect(firstBlock(bytes, key, seqIv(0)).equals(ref)).toBe(false); // ...and not with a fixed IV
      });
    }

    // Keys are separated by rendition: the 480p key does not open the 720p rung...
    expect(() => verify(rungs[720]!.outDir, join(dir, 'enc-480.key'))).toThrow();
    // ...and equal plaintext headers no longer give equal ciphertext across rungs.
    const s480 = readFileSync(join(rungs[480]!.outDir, 'seg_00000.ts')).subarray(0, 16);
    const s720 = readFileSync(join(rungs[720]!.outDir, 'seg_00000.ts')).subarray(0, 16);
    expect(s480.equals(s720)).toBe(false);
    console.log(`[hls-key-v2] ${version}: v2 per-rung keys and sequence IVs verified`);
  }, 300_000);

  it('v1 (unchanged): one key and one fixed IV, written into the playlist; still decrypts', () => {
    const keyPath = join(dir, 'enc.key');
    const keyInfoPath = join(dir, 'enc.keyinfo');
    const key = deriveContentKeyV1(ROOT, VIDEO);
    const iv = deriveIvV1(VIDEO);
    writeFileSync(keyPath, key);
    writeFileSync(keyInfoPath, HlsTranscoder.keyInfoText(keyPath, iv));
    const outDir = encodeRung(join(dir, 'v1'), source, 480, keyInfoPath, false);
    verify(outDir, keyPath);
    const playlist = readFileSync(join(outDir, 'index.m3u8'), 'utf8');
    expect(playlist).toContain(`IV=0x${iv}`);
    const segments = playlist.split('\n').filter((l) => l.endsWith('.ts'));
    for (const name of segments) {
      expect(decryptsToTs(readFileSync(join(outDir, name)), key, Buffer.from(iv, 'hex'))).toBe(true);
    }
  }, 300_000);
});
