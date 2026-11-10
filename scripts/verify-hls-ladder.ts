/**
 * Real-ffmpeg verification of the mobile HLS quality ladder.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/verify-hls-ladder.ts [--out <dir>] [--lecture <file.mp4>]
 *
 * Generates short synthetic sources that cover the quality policy (landscape
 * 4K/1080p/720p/480p, below 480p, odd and non-standard dimensions, portrait,
 * rotation metadata, a very low-bitrate source), runs the SAME planning,
 * ffmpeg argument builder and rendition verification the worker uses, and
 * checks each output: dimensions as planned and even, aspect ratio kept,
 * playlist complete, every segment decrypts and demuxes, audio and video
 * start together and last the same, and the static master playlist
 * describes exactly the rungs that exist. With --lecture it also encodes the
 * first 30 s of a real lecture at 1080p and reports SSIM against the source
 * as a readability proxy.
 *
 * Needs ffmpeg/ffprobe on PATH (or FFMPEG_PATH / FFPROBE_PATH). Writes only
 * under --out (default: a temp directory). Exit code 1 on any failure.
 */
import { spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HlsTranscoder, type PlannedRendition, type ProbeResult } from '../src/jobs/processors/hls-transcoder';

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';
const LADDER = [480, 720, 1080];
const CLIP_SECONDS = 6;

const args = process.argv.slice(2);
const argValue = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const OUT = argValue('--out') ?? join(tmpdir(), `hls-ladder-${Date.now()}`);
const LECTURE = argValue('--lecture');
mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}`);
  if (!ok) failures += 1;
};

function run(cmd: string, cmdArgs: string[]): string {
  const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.slice(0, 6).join(' ')}… failed: ${(r.stderr || '').slice(-600)}`);
  return r.stdout;
}

/** Same probe the worker runs (private, reached through the instance). */
const transcoder = new HlsTranscoder(
  {} as never,
  { getOrThrow: () => ({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE, segmentSeconds: 6, transcodeThreads: 0 }) } as never,
  {} as never,
);
const probe = (file: string): Promise<ProbeResult> =>
  (transcoder as unknown as { probe: (f: string) => Promise<ProbeResult> }).probe(file);
const verifyRendition = (outDir: string, p: ProbeResult, keyPath?: string): Promise<void> =>
  (transcoder as unknown as { verifyRendition: (d: string, p: ProbeResult, k?: string) => Promise<void> }).verifyRendition(
    outDir,
    p,
    keyPath,
  );

interface Sample {
  name: string;
  file: string;
  expectTiers: number[];
  expectDims?: Record<number, [number, number]>;
}

function synth(name: string, width: number, height: number, extra: string[] = [], bitrate = '2000k'): string {
  const file = join(OUT, `${name}.mp4`);
  if (!existsSync(file)) {
    run(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=30`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', String(CLIP_SECONDS + 2),
      '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', bitrate, '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-shortest', ...extra, file,
    ]);
  }
  return file;
}

async function encodeAndCheck(sample: Sample): Promise<void> {
  console.log(`\n== ${sample.name}`);
  const p = await probe(sample.file);
  console.log(`   probe: display ${p.width}x${p.height}, rotation ${p.rotation}, ${p.frameRate} fps, ${p.durationSeconds.toFixed(2)} s, ${p.videoCodec}/${p.audioCodec}`);
  const plan = HlsTranscoder.planRenditions(LADDER, p.width, p.height);
  console.log(`   plan: ${plan.map((r) => `${r.tier}p ${r.width}x${r.height}`).join(', ')}`);
  check(JSON.stringify(plan.map((r) => r.tier)) === JSON.stringify(sample.expectTiers), `tiers ${JSON.stringify(sample.expectTiers)}`);
  for (const r of plan) {
    check(r.width % 2 === 0 && r.height % 2 === 0, `${r.tier}p even dimensions ${r.width}x${r.height}`);
    check(Math.abs(r.width / r.height - p.width / p.height) < 0.02, `${r.tier}p keeps the aspect ratio`);
    check(r.width <= p.width && r.height <= p.height, `${r.tier}p never upscales`);
    if (sample.expectDims?.[r.tier]) {
      const [ew, eh] = sample.expectDims[r.tier]!;
      check(r.width === ew && r.height === eh, `${r.tier}p is ${ew}x${eh}`);
    }
  }

  const work = join(OUT, `${sample.name}.work`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const key = createHmac('sha256', randomBytes(32)).update(`hls-key:${sample.name}`).digest().subarray(0, 16);
  const keyPath = join(work, 'enc.key');
  writeFileSync(keyPath, key);
  const keyInfo = join(work, 'enc.keyinfo');
  writeFileSync(keyInfo, `${keyPath.replace(/\\/g, '/')}\n${keyPath}\n${randomBytes(16).toString('hex')}\n`);

  const rendered: { tier: number; width: number; height: number; bitrateKbps: number }[] = [];
  for (const r of plan as PlannedRendition[]) {
    const outDir = join(work, `${r.tier}p`);
    mkdirSync(outDir, { recursive: true });
    const rate = HlsTranscoder.rateForTier(r.tier);
    const ff = HlsTranscoder.ffmpegArgs({
      sourcePath: sample.file,
      outDir,
      height: r.height,
      width: r.width,
      bitrateKbps: rate.video,
      maxrateKbps: rate.maxrate,
      audioKbps: rate.audio,
      keyInfoPath: keyInfo,
      segmentSeconds: 6,
      frameRate: p.frameRate,
      threads: 0,
    });
    // Keep the clips short: -t right after the input.
    const i = ff.indexOf('-i');
    ff.splice(i + 2, 0, '-t', String(CLIP_SECONDS));
    run(FFMPEG, ff);

    // What ffmpeg actually wrote (decrypted through the verify path's key).
    const seg0 = join(outDir, 'seg_00000.ts');
    check(existsSync(seg0) && statSync(seg0).size > 0, `${r.tier}p first segment exists`);
    const dims = run(FFPROBE, [
      '-v', 'error', '-allowed_extensions', 'ALL', '-protocol_whitelist', 'file,crypto,data',
      '-select_streams', 'v:0', '-show_entries', 'stream=width,height,start_time:format=duration', '-of', 'json',
      decryptPlaylist(outDir, keyPath),
    ]);
    const parsed = JSON.parse(dims) as { streams?: { width: number; height: number; start_time?: string }[]; format?: { duration?: string } };
    const v = parsed.streams?.[0];
    check(v?.width === r.width && v?.height === r.height, `${r.tier}p output is ${v?.width}x${v?.height}`);

    const a = JSON.parse(
      run(FFPROBE, [
        '-v', 'error', '-allowed_extensions', 'ALL', '-protocol_whitelist', 'file,crypto,data',
        '-select_streams', 'a:0', '-show_entries', 'stream=start_time,duration', '-of', 'json',
        decryptPlaylist(outDir, keyPath),
      ]),
    ) as { streams?: { start_time?: string; duration?: string }[] };
    const vStart = Number(v?.start_time ?? 0);
    const aStart = Number(a.streams?.[0]?.start_time ?? 0);
    check(Math.abs(vStart - aStart) <= 0.1, `${r.tier}p audio and video start together (Δ ${Math.abs(vStart - aStart).toFixed(3)} s)`);

    try {
      await verifyRendition(outDir, { ...p, durationSeconds: CLIP_SECONDS }, keyPath);
      check(true, `${r.tier}p passes the worker's rendition verification (playlist complete, segments decrypt and demux, duration matches)`);
    } catch (e) {
      check(false, `${r.tier}p verification: ${(e as Error).message}`);
    }
    rendered.push({ tier: r.tier, width: r.width, height: r.height, bitrateKbps: rate.video + rate.audio });
  }

  const master = HlsTranscoder.buildStaticMaster(rendered.map((r) => ({ height: r.height, width: r.width, bitrateKbps: r.bitrateKbps })));
  const refs = master.split('\n').filter((l) => l.endsWith('/index.m3u8'));
  const infos = master.split('\n').filter((l) => l.startsWith('#EXT-X-STREAM-INF'));
  check(refs.length === rendered.length && infos.length === rendered.length, `master lists ${rendered.length} rungs`);
  for (const r of rendered) {
    check(refs.includes(`${r.tier}p/index.m3u8`), `master references ${r.tier}p/index.m3u8`);
    check(infos.some((l) => l.includes(`RESOLUTION=${r.width}x${r.height}`)), `master RESOLUTION ${r.width}x${r.height}`);
  }
  rmSync(work, { recursive: true, force: true });
}

/** A copy of the playlist whose key URI points at the local key, like verifyRendition does. */
function decryptPlaylist(outDir: string, keyPath: string): string {
  const text = readFileSync(join(outDir, 'index.m3u8'), 'utf8').replace(/URI="[^"]*"/, `URI="${keyPath.replace(/\\/g, '/')}"`);
  const p = join(outDir, 'probe.m3u8');
  writeFileSync(p, text);
  return p;
}

async function readability(lecture: string): Promise<void> {
  console.log(`\n== readability proxy on ${lecture}`);
  const p = await probe(lecture);
  const plan = HlsTranscoder.planRenditions(LADDER, p.width, p.height);
  const top = plan[plan.length - 1]!;
  const work = join(OUT, 'lecture.work');
  mkdirSync(work, { recursive: true });
  const rate = HlsTranscoder.rateForTier(top.tier);
  const out = join(work, `top-${top.tier}p.mp4`);
  run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', lecture, '-t', '30', '-an',
    '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '23',
    '-maxrate', `${rate.maxrate}k`, '-bufsize', `${rate.maxrate * 2}k`, '-b:v', `${rate.video}k`,
    '-vf', `scale=${top.width}:${top.height}:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2`,
    out,
  ]);
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', out, '-i', lecture, '-t', '30', '-lavfi', `[0:v][1:v]scale2ref[a][b];[a][b]ssim`, '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /All:([0-9.]+)/.exec(r.stderr);
  const ssim = m ? Number(m[1]) : NaN;
  const kbps = Math.round((statSync(out).size * 8) / 30 / 1000);
  console.log(`   ${top.tier}p ${top.width}x${top.height}: SSIM ${Number.isFinite(ssim) ? ssim.toFixed(4) : 'n/a'} vs source, ${kbps} kbps`);
  check(Number.isFinite(ssim) && ssim >= 0.95, `top rung SSIM ≥ 0.95 (readable slides and code)`);
  rmSync(work, { recursive: true, force: true });
}

(async () => {
  console.log(`ffmpeg: ${run(FFMPEG, ['-version']).split('\n')[0]}`);
  console.log(`out: ${OUT}`);
  const samples: Sample[] = [
    { name: 'landscape-1080p', file: synth('landscape-1080p', 1920, 1080), expectTiers: [480, 720, 1080], expectDims: { 480: [854, 480], 720: [1280, 720], 1080: [1920, 1080] } },
    { name: 'landscape-4k', file: synth('landscape-4k', 3840, 2160), expectTiers: [480, 720, 1080], expectDims: { 1080: [1920, 1080] } },
    { name: 'landscape-720p', file: synth('landscape-720p', 1280, 720), expectTiers: [480, 720] },
    { name: 'landscape-480p', file: synth('landscape-480p', 854, 480), expectTiers: [480] },
    { name: 'below-480p', file: synth('below-480p', 640, 360), expectTiers: [360], expectDims: { 360: [640, 360] } },
    { name: 'odd-dimensions', file: synth('odd-dimensions', 1002, 564), expectTiers: [480] },
    { name: 'nonstandard-1740x1080', file: synth('nonstandard-1740x1080', 1740, 1080), expectTiers: [480, 720, 1080], expectDims: { 720: [1160, 720], 480: [774, 480] } },
    { name: 'portrait-1080x1920', file: synth('portrait-1080x1920', 1080, 1920), expectTiers: [480, 720, 1080], expectDims: { 720: [720, 1280], 480: [480, 854] } },
    { name: 'rotated-metadata', file: rotated(), expectTiers: [480, 720], expectDims: { 720: [720, 1280] } },
    { name: 'low-bitrate-1080p', file: synth('low-bitrate-1080p', 1920, 1080, [], '150k'), expectTiers: [480, 720, 1080] },
  ];
  for (const s of samples) {
    try {
      await encodeAndCheck(s);
    } catch (e) {
      check(false, `${s.name}: ${(e as Error).message}`);
    }
  }
  if (LECTURE) await readability(LECTURE);
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

/** A 1280×720 file stored landscape with a 90° display matrix: players show it as 720×1280. */
function rotated(): string {
  const src = synth('rotated-source', 1280, 720);
  const file = join(OUT, 'rotated-metadata.mp4');
  if (!existsSync(file)) run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-display_rotation', '90', '-i', src, '-c', 'copy', file]);
  return file;
}
