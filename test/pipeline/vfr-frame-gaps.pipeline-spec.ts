/**
 * Variable-frame-rate sources with long gaps between video frames, encoded for
 * real by ffmpeg.
 *
 * THE PRODUCTION FAILURE (Nov 2026): screen recordings write a frame only when
 * the screen changes, so a static slide can leave 10-20 s with no video frame.
 * During such a gap the video encoder emits nothing until the next real frame,
 * and with ffmpeg's default interleaving the muxer wrote the audio up to 10 s
 * AHEAD of the video: one 4 s HLS segment carried ~10 s of audio, the next
 * none. The output verifier's demuxer then saw only audio in its probe window
 * and refused the rendition ("dimensions not set"); a player seeking into such
 * a stretch would have had pictures and no sound. 3 lectures failed that way;
 * 12 of the library's sources have such gaps.
 *
 * This builds a short source with the same shape (frames for 1 s, then an 18 s
 * gap, audio throughout - like cmv47p15l: 8 frames in its first 30 s, an 18 s
 * gap at t=1), and checks with the REAL probe, argument builder and verifier:
 *   - the probe recognises it as variable-frame-rate;
 *   - encoded the old way, it reproduces both the verifier refusal and the
 *     misplaced audio;
 *   - encoded the new way, every segment carries its own audio and video,
 *     decodes on its own, the encrypted rendition passes the production
 *     verifier, and the streams still line up with the source;
 *   - a constant-frame-rate source is not affected at all.
 *
 * Run with: npx jest -c test/pipeline/jest-pipeline.json vfr-frame-gaps
 * (needs ffmpeg and ffprobe on PATH; skipped otherwise).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HlsTranscoder, type ProbeResult } from '../../src/jobs/processors/hls-transcoder';

const hasTools = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const maybe = hasTools ? describe : describe.skip;

const SEG = 4;
const run = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });

/** The real transcoder, with only what probe/exec/verify read. */
function transcoder() {
  const config = { getOrThrow: () => ({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', segmentSeconds: SEG }) };
  const t = new HlsTranscoder({} as never, config as never, {} as never);
  return t as unknown as {
    probe(path: string): Promise<ProbeResult>;
    verifyRendition(outDir: string, probe: ProbeResult, keyPath?: string): Promise<void>;
  };
}

async function encode(source: string, outDir: string, probe: ProbeResult, opts: { fix: boolean; keyInfo?: string }) {
  await mkdir(outDir, { recursive: true });
  const args = HlsTranscoder.ffmpegArgs({
    sourcePath: source,
    outDir,
    height: 480,
    width: 738,
    bitrateKbps: 900,
    maxrateKbps: 1200,
    audioKbps: 96,
    keyInfoPath: opts.keyInfo,
    segmentSeconds: SEG,
    frameRate: probe.frameRate,
    constantFrameRate: opts.fix ? probe.outputFrameRate : undefined,
    threads: 2,
  }).filter((a, i, all) => !(a === '-progress' || all[i - 1] === '-progress'));
  run('ffmpeg', args);
  const playlist = await readFile(join(outDir, 'index.m3u8'), 'utf8');
  return playlist.split('\n').filter((l) => l.endsWith('.ts'));
}

/** Packet timestamps of one stream of one (unencrypted) file. */
function pts(file: string, sel: string): number[] {
  const out = JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', sel, '-show_entries', 'packet=pts_time', '-of', 'json', file]));
  return ((out.packets ?? []) as { pts_time: string }[]).map((p) => Number(p.pts_time)).filter(Number.isFinite);
}

/** First-to-last packet span of one stream across a whole playlist. */
function span(playlist: string, sel: string): number {
  const t = JSON.parse(run('ffprobe', ['-v', 'error', '-allowed_extensions', 'ALL', '-select_streams', sel, '-show_entries', 'packet=pts_time', '-of', 'json', playlist]))
    .packets.map((p: { pts_time: string }) => Number(p.pts_time));
  return Math.max(...t) - Math.min(...t);
}

async function keyFiles(dir: string) {
  const keyPath = join(dir, 'enc.key');
  await writeFile(keyPath, randomBytes(16));
  const keyInfo = join(dir, 'enc.keyinfo');
  await writeFile(keyInfo, `key-placeholder\n${keyPath}\n${randomBytes(16).toString('hex')}\n`);
  return { keyPath, keyInfo };
}

maybe('variable-frame-rate sources with frame gaps (real ffmpeg)', () => {
  let dir: string;
  let vfrSource: string;
  let cfrSource: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vfr-'));
    vfrSource = join(dir, 'vfr.mp4');
    cfrSource = join(dir, 'cfr.mp4');
    run('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=1106x720:rate=25:duration=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30',
      '-vf', "select='lt(t,1)+gte(t,19)'",
      '-fps_mode', 'vfr',
      '-c:v', 'libx264', '-g', '250', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', vfrSource,
    ]);
    run('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=12',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
      '-c:v', 'libx264', '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', cfrSource,
    ]);
  });

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('the probe recognises the gap recording as variable-frame-rate, and a normal file as not', async () => {
    const t = transcoder();
    expect((await t.probe(vfrSource)).outputFrameRate).toBe(10);
    expect((await t.probe(cfrSource)).outputFrameRate).toBeUndefined();
  });

  it('REPRODUCTION: encoded the old way, audio runs ahead of the gap and the verifier refuses it', async () => {
    const t = transcoder();
    const probe = await t.probe(vfrSource);
    const out = join(dir, 'old');
    const { keyPath, keyInfo } = await keyFiles(join(dir));
    const plainOut = join(dir, 'old-plain');
    const segments = await encode(vfrSource, plainOut, probe, { fix: false });
    const audioPerSegment = segments.map((s) => pts(join(plainOut, s), 'a:0').length);
    expect(Math.min(...audioPerSegment)).toBe(0); // a segment with no audio at all...
    expect(Math.max(...audioPerSegment)).toBeGreaterThan(300); // ...because another holds ~10 s of it

    await encode(vfrSource, out, probe, { fix: false, keyInfo });
    await expect(t.verifyRendition(out, probe, keyPath)).rejects.toThrow(/dimensions not set/);
  });

  it('encoded the new way, every segment carries its own audio and video and decodes on its own', async () => {
    const probe = await transcoder().probe(vfrSource);
    const out = join(dir, 'new');
    const segments = await encode(vfrSource, out, probe, { fix: true });
    expect(segments.length).toBeGreaterThanOrEqual(7);
    for (const s of segments) {
      const v = pts(join(out, s), 'v:0');
      const a = pts(join(out, s), 'a:0');
      expect(v.length).toBeGreaterThan(0);
      expect(a.length).toBeGreaterThan(0);
      // The segment's audio covers the same stretch as its video (≤ 0.5 s apart at both ends).
      expect(Math.abs(Math.min(...a) - Math.min(...v))).toBeLessThan(0.5);
      expect(Math.abs(Math.max(...a) - Math.max(...v))).toBeLessThan(0.5);
      run('ffmpeg', ['-v', 'error', '-xerror', '-i', join(out, s), '-f', 'null', '-']);
    }
    const playlist = join(out, 'index.m3u8');
    expect(Math.abs(span(playlist, 'v:0') - span(playlist, 'a:0'))).toBeLessThan(0.5);
    expect(Math.abs(span(playlist, 'a:0') - probe.durationSeconds)).toBeLessThan(0.5);
  });

  it('the encrypted rendition passes the production verifier and its segments are ciphertext', async () => {
    const t = transcoder();
    const probe = await t.probe(vfrSource);
    const out = join(dir, 'enc');
    const { keyPath, keyInfo } = await keyFiles(join(dir));
    const segments = await encode(vfrSource, out, probe, { fix: true, keyInfo });
    await expect(t.verifyRendition(out, probe, keyPath)).resolves.toBeUndefined();
    const head = (await readFile(join(out, segments[0]))).subarray(0, 189);
    expect(head[0] === 0x47 && head[188] === 0x47).toBe(false);
  });

  it('a constant-frame-rate source is encoded exactly as before', async () => {
    const probe = await transcoder().probe(cfrSource);
    const base = {
      sourcePath: cfrSource, outDir: dir, height: 720, width: 1280, bitrateKbps: 2200, maxrateKbps: 2600,
      audioKbps: 128, segmentSeconds: SEG, frameRate: probe.frameRate, threads: 2,
    };
    expect(HlsTranscoder.ffmpegArgs({ ...base, constantFrameRate: probe.outputFrameRate })).toEqual(HlsTranscoder.ffmpegArgs(base));
  });
});
