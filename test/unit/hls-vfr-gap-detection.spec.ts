import { HlsTranscoder, TranscodeSupersededError } from '../../src/jobs/processors/hls-transcoder';

/**
 * Variable-frame-rate detection for sources whose HEADER hides the gaps.
 *
 * Regression (2026-11-24, Chemistry (B) الحصة الثالثة, video cmvzq9sip): an
 * Android 12 screen recording with r_frame_rate 6/1 and avg_frame_rate 23.58
 * has 236 holes > 2 s between video frames (longest 18.08 s) while the audio
 * runs on. The header rule (`detectVariableFrameRate`) cannot see that shape -
 * the average is ABOVE the nominal - so the source was encoded without the
 * constant-rate / strict-interleave protection and the verifier refused the
 * 480p rung six times ("dimensions not set").
 *
 * The fix: when the header rates disagree but the header rule says "not
 * variable", the worker MEASURES the frame timestamps and uses the protection
 * when a hole of 2 s or more exists. Sources whose rates agree are never
 * scanned and keep their exact encode.
 */

describe('HlsTranscoder.needsFrameGapScan: when the header leaves the question open', () => {
  it('never scans an ordinary constant-rate file (the rates agree, or differ only by rounding)', () => {
    expect(HlsTranscoder.needsFrameGapScan('30/1', '30/1')).toBe(false);
    expect(HlsTranscoder.needsFrameGapScan('30000/1001', '30000/1001')).toBe(false);
    expect(HlsTranscoder.needsFrameGapScan('25/1', '2500/100')).toBe(false);
    expect(HlsTranscoder.needsFrameGapScan('30/1', '30000/1001')).toBe(false); // 30 vs 29.97
    expect(HlsTranscoder.needsFrameGapScan('24/1', '23976/1000')).toBe(false); // 24 vs 23.976
  });

  it('does not scan when the header rule already decided "variable" (the existing path is unchanged)', () => {
    expect(HlsTranscoder.needsFrameGapScan('60/1', '2305/100')).toBe(false);
    expect(HlsTranscoder.needsFrameGapScan('90000/1', '2375/100')).toBe(false);
    expect(HlsTranscoder.needsFrameGapScan('38/1', '2048/100')).toBe(false);
  });

  it('scans the "average above nominal" header shape, including the failing lecture', () => {
    expect(HlsTranscoder.needsFrameGapScan('6/1', '1907451041/80893781')).toBe(true); // cmvzq9sip, 23.58
    expect(HlsTranscoder.needsFrameGapScan('6/1', '2358/100')).toBe(true);
    expect(HlsTranscoder.needsFrameGapScan('15/1', '1904/100')).toBe(true);
    expect(HlsTranscoder.needsFrameGapScan('4/1', '2993/100')).toBe(true);
  });

  it('cannot decide without both rates, or with a nonsense average', () => {
    expect(HlsTranscoder.needsFrameGapScan(undefined, '25/1')).toBe(false);
    expect(HlsTranscoder.needsFrameGapScan('25/1', undefined)).toBe(false);
    expect(HlsTranscoder.needsFrameGapScan('0/0', '25/1')).toBe(false);
    expect(HlsTranscoder.needsFrameGapScan('6/1', '500/1')).toBe(false);
  });

  it('the header rule itself is unchanged for the header-quirk shapes', () => {
    expect(HlsTranscoder.detectVariableFrameRate('6/1', '2358/100')).toBeUndefined();
    expect(HlsTranscoder.detectVariableFrameRate('15/1', '1904/100')).toBeUndefined();
  });
});

describe('HlsTranscoder.longestFrameGapSeconds', () => {
  const cfr = (fps: number, seconds: number) =>
    Array.from({ length: Math.round(fps * seconds) }, (_, i) => (i / fps).toFixed(6)).join('\n');

  it('a constant 30 fps stream has no gap beyond one frame', () => {
    expect(HlsTranscoder.longestFrameGapSeconds(cfr(30, 60))).toBeCloseTo(1 / 30, 5);
  });

  it('finds an 18.08 s hole (the failing lecture) among ordinary frames', () => {
    const lines = ['0', '0.017367', '0.032056', '0.518589', '2.855111', '20.935111', '20.976', '21.01'].join('\n');
    expect(HlsTranscoder.longestFrameGapSeconds(lines)).toBeCloseTo(18.08, 2);
  });

  it('orders packets by time first (B-frames are stored out of presentation order)', () => {
    const lines = ['0.000', '0.133', '0.067', '0.100', '0.033', '0.200', '0.167'].join('\n');
    expect(HlsTranscoder.longestFrameGapSeconds(lines)).toBeCloseTo(0.034, 2);
  });

  it('ignores blank lines, CRLF, "N/A" and trailing commas', () => {
    expect(HlsTranscoder.longestFrameGapSeconds('0.0,\r\nN/A\r\n\r\n1.0,\r\n4.5')).toBeCloseTo(3.5, 5);
  });

  it('is 0 with fewer than two frames', () => {
    expect(HlsTranscoder.longestFrameGapSeconds('')).toBe(0);
    expect(HlsTranscoder.longestFrameGapSeconds('12.5')).toBe(0);
  });
});

describe('HlsTranscoder.frameRateForMeasuredGaps', () => {
  it('a hole under 2 s changes nothing', () => {
    expect(HlsTranscoder.frameRateForMeasuredGaps(0.04, 23.58)).toBeUndefined();
    expect(HlsTranscoder.frameRateForMeasuredGaps(1.99, 23.58)).toBeUndefined();
  });

  it('a hole of 2 s or more: the source average, rounded (cmvzq9sip -> 24 fps)', () => {
    expect(HlsTranscoder.frameRateForMeasuredGaps(2, 23.58)).toBe(24);
    expect(HlsTranscoder.frameRateForMeasuredGaps(18.08, 23.58)).toBe(24);
    expect(HlsTranscoder.frameRateForMeasuredGaps(5, 29.93)).toBe(30);
  });

  it('bounded like the header rule (10..60 fps), and refuses a nonsense average', () => {
    expect(HlsTranscoder.frameRateForMeasuredGaps(5, 3)).toBe(10);
    expect(HlsTranscoder.frameRateForMeasuredGaps(5, 90)).toBe(60);
    expect(HlsTranscoder.frameRateForMeasuredGaps(5, 0)).toBeUndefined();
    expect(HlsTranscoder.frameRateForMeasuredGaps(Number.NaN, 24)).toBeUndefined();
  });
});

describe('probe(): the frame-gap scan inside the real probe path', () => {
  /** A transcoder whose ffprobe is a double: the stream JSON first, then (if asked) packet timestamps. */
  function probing(header: { r: string; avg: string }, pts: string[] | Error | null) {
    const calls: string[][] = [];
    const t = new HlsTranscoder({} as never, { getOrThrow: () => ({ ffprobePath: 'ffprobe', ffmpegPath: 'ffmpeg' }) } as never, {} as never);
    (t as unknown as { exec: unknown }).exec = async (_cmd: string, args: string[], opts?: { onStdoutLine?: (l: string) => void }) => {
      calls.push(args);
      if (args.includes('-show_streams')) {
        return JSON.stringify({
          format: { duration: '2927.48' },
          streams: [
            { codec_type: 'video', codec_name: 'h264', width: 1106, height: 720, r_frame_rate: header.r, avg_frame_rate: header.avg },
            { codec_type: 'audio', codec_name: 'aac' },
          ],
        });
      }
      if (pts instanceof Error) throw pts;
      for (const line of pts ?? []) opts?.onStdoutLine?.(line);
      return '';
    };
    const probe = () => (t as unknown as { probe: (f: string) => Promise<{ outputFrameRate?: number; frameRate: number }> }).probe('/x.mp4');
    return { probe, calls };
  }
  const evenly = (fps: number, n: number) => Array.from({ length: n }, (_, i) => (i / fps).toFixed(6));

  it('REGRESSION cmvzq9sip: header 6/1 vs 23.58 with an 18 s hole -> constant 24 fps (CFR + strict interleave)', async () => {
    const { probe, calls } = probing({ r: '6/1', avg: '1907451041/80893781' }, ['0', '0.017', '0.032', '0.518', '2.855', '20.935', '20.976']);
    const p = await probe();
    expect(p.outputFrameRate).toBe(24);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(expect.arrayContaining(['-select_streams', 'v:0', '-show_entries', 'packet=pts_time']));
    // ...and the encode then uses the existing VFR protection.
    const args = HlsTranscoder.ffmpegArgs({
      sourcePath: '/s', outDir: '/o', height: 480, width: 736, bitrateKbps: 1000, maxrateKbps: 1200, audioKbps: 96,
      segmentSeconds: 6, frameRate: p.frameRate, constantFrameRate: p.outputFrameRate, threads: 2,
    });
    expect(args).toEqual(expect.arrayContaining(['-fps_mode', 'cfr', '-r', '24', '-max_interleave_delta', '0']));
  });

  it('same header shape WITHOUT holes (the evenly recorded library sources) keeps its exact encode', async () => {
    const { probe, calls } = probing({ r: '6/1', avg: '2358/100' }, evenly(23.58, 2000));
    expect((await probe()).outputFrameRate).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it('an ordinary constant-rate source is never scanned (one ffprobe call, as before)', async () => {
    const { probe, calls } = probing({ r: '30/1', avg: '30/1' }, null);
    expect((await probe()).outputFrameRate).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('a header-detected VFR source keeps the header path (no scan, same rate as before)', async () => {
    const { probe, calls } = probing({ r: '60/1', avg: '2305/100' }, null);
    expect((await probe()).outputFrameRate).toBe(23);
    expect(calls).toHaveLength(1);
  });

  it('a failed scan falls back to the header result instead of failing the job', async () => {
    const { probe } = probing({ r: '6/1', avg: '2358/100' }, new Error('ffprobe exited with 1'));
    expect((await probe()).outputFrameRate).toBeUndefined();
  });

  it('a superseded attempt still stops during the scan (not swallowed)', async () => {
    const { probe } = probing({ r: '6/1', avg: '2358/100' }, new TranscodeSupersededError('another attempt owns the video'));
    await expect(probe()).rejects.toBeInstanceOf(TranscodeSupersededError);
  });
});
