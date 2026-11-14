import { HlsTranscoder } from '../../src/jobs/processors/hls-transcoder';

/**
 * The pure parts of the shared HLS transcoder: ladder planning and the ffmpeg
 * invocation. These are what the audit of the old worker changed, so each
 * change is pinned here.
 */
describe('HlsTranscoder.planRenditions (quality policy)', () => {
  const LADDER = [480, 720, 1080];
  const tiers = (r: { tier: number }[]) => r.map((x) => x.tier);

  it('1080p landscape → 1080p, 720p, 480p, aspect kept, never upscaled', () => {
    const plan = HlsTranscoder.planRenditions(LADDER, 1920, 1080);
    expect(plan).toEqual([
      { tier: 480, width: 854, height: 480 },
      { tier: 720, width: 1280, height: 720 },
      { tier: 1080, width: 1920, height: 1080 },
    ]);
  });

  it('720p landscape → 720p, 480p', () => {
    expect(tiers(HlsTranscoder.planRenditions(LADDER, 1280, 720))).toEqual([480, 720]);
  });

  it('480p landscape → 480p only', () => {
    expect(HlsTranscoder.planRenditions(LADDER, 854, 480)).toEqual([{ tier: 480, width: 854, height: 480 }]);
  });

  it('between tiers: a 900-line source gets 720p and 480p, no 900p and no 1080p', () => {
    expect(tiers(HlsTranscoder.planRenditions(LADDER, 1600, 900))).toEqual([480, 720]);
  });

  it('above 1080p (4K) → the same three tiers, nothing larger', () => {
    const plan = HlsTranscoder.planRenditions(LADDER, 3840, 2160);
    expect(tiers(plan)).toEqual([480, 720, 1080]);
    expect(plan[2]).toEqual({ tier: 1080, width: 1920, height: 1080 });
  });

  it('portrait phone recording keeps its orientation: tiers are the SHORT side', () => {
    const plan = HlsTranscoder.planRenditions(LADDER, 1080, 1920);
    expect(plan).toEqual([
      { tier: 480, width: 480, height: 854 },
      { tier: 720, width: 720, height: 1280 },
      { tier: 1080, width: 1080, height: 1920 },
    ]);
  });

  it('portrait 720×1106 → 720p at its own size and a 480p rung, never stretched', () => {
    const plan = HlsTranscoder.planRenditions(LADDER, 720, 1106);
    expect(plan).toEqual([
      { tier: 480, width: 480, height: 738 },
      { tier: 720, width: 720, height: 1106 },
    ]);
    for (const r of plan) expect(Math.abs(r.width / r.height - 720 / 1106)).toBeLessThan(0.01);
  });

  it('non-standard aspect (1740×1080 screen recording) scales the long side with the short one', () => {
    const plan = HlsTranscoder.planRenditions(LADDER, 1740, 1080);
    expect(plan).toEqual([
      { tier: 480, width: 774, height: 480 },
      { tier: 720, width: 1160, height: 720 },
      { tier: 1080, width: 1740, height: 1080 },
    ]);
  });

  it('odd source dimensions produce even outputs at every rung', () => {
    for (const r of HlsTranscoder.planRenditions(LADDER, 1001, 563)) {
      expect(r.width % 2).toBe(0);
      expect(r.height % 2).toBe(0);
    }
    expect(tiers(HlsTranscoder.planRenditions(LADDER, 1001, 563))).toEqual([480]);
  });

  it('below 480p → exactly one rung at the source size (even), no 360p and no upscale', () => {
    expect(HlsTranscoder.planRenditions(LADDER, 640, 360)).toEqual([{ tier: 360, width: 640, height: 360 }]);
    expect(HlsTranscoder.planRenditions(LADDER, 427, 240)).toEqual([{ tier: 240, width: 426, height: 240 }]);
    expect(HlsTranscoder.planRenditions(LADDER, 360, 640)).toEqual([{ tier: 360, width: 360, height: 640 }]);
  });

  it('ignores tiers below 480 in the configured ladder, duplicates and junk', () => {
    expect(tiers(HlsTranscoder.planRenditions([360, 480, 480, 720, 1080, 0, -1, Number.NaN], 1920, 1080))).toEqual([480, 720, 1080]);
    expect(tiers(HlsTranscoder.planRenditions([360, 240], 1920, 1080))).toEqual([1080]); // only the source's own size remains
  });

  it('never returns an empty plan', () => {
    expect(HlsTranscoder.planRenditions([], 2, 2)).toHaveLength(1);
  });
});

describe('HlsTranscoder.rateForTier', () => {
  it('uses the tier profile when one exists, otherwise the nearest profile below it', () => {
    expect(HlsTranscoder.rateForTier(1080).maxrate).toBe(5000);
    expect(HlsTranscoder.rateForTier(720).maxrate).toBe(2600);
    expect(HlsTranscoder.rateForTier(480).maxrate).toBe(1200);
    expect(HlsTranscoder.rateForTier(360).maxrate).toBe(700);
    expect(HlsTranscoder.rateForTier(240).maxrate).toBe(700); // smallest profile
    expect(HlsTranscoder.rateForTier(900).maxrate).toBe(2600); // between 720 and 1080
  });
});

describe('HlsTranscoder.normaliseRotation (display matrix / rotate tag)', () => {
  it('maps every spelling onto 0 / 90 / 180 / 270', () => {
    expect(HlsTranscoder.normaliseRotation(undefined)).toBe(0);
    expect(HlsTranscoder.normaliseRotation('90')).toBe(90);
    expect(HlsTranscoder.normaliseRotation(-90)).toBe(270);
    expect(HlsTranscoder.normaliseRotation(270)).toBe(270);
    expect(HlsTranscoder.normaliseRotation(180)).toBe(180);
    expect(HlsTranscoder.normaliseRotation(-180)).toBe(180);
    expect(HlsTranscoder.normaliseRotation(360)).toBe(0);
    expect(HlsTranscoder.normaliseRotation('junk')).toBe(0);
  });

  it('a 1920×1080 stream rotated 90° is planned as a 1080×1920 portrait source', () => {
    const rotation = HlsTranscoder.normaliseRotation(-90);
    const swapped = rotation === 90 || rotation === 270;
    const plan = HlsTranscoder.planRenditions([480, 720, 1080], swapped ? 1080 : 1920, swapped ? 1920 : 1080);
    expect(plan[2]).toEqual({ tier: 1080, width: 1080, height: 1920 });
  });
});

describe('HlsTranscoder.ffmpegArgs', () => {
  const base = {
    sourcePath: '/w/source.bin',
    outDir: '/w/720p',
    height: 720,
    width: 1280,
    bitrateKbps: 2200,
    maxrateKbps: 2600,
    audioKbps: 128,
    segmentSeconds: 6,
    frameRate: 30,
    threads: 0,
  };

  it('forces 8-bit 4:2:0 H.264 High 4.1, the profile every phone decoder accepts', () => {
    const args = HlsTranscoder.ffmpegArgs(base).join(' ');
    expect(args).toContain('-c:v libx264 -profile:v high -level 4.1 -pix_fmt yuv420p');
  });

  it('maps only the first video and (optional) audio stream, never subtitles or data', () => {
    const args = HlsTranscoder.ffmpegArgs(base).join(' ');
    expect(args).toContain('-map 0:v:0 -map 0:a:0? -sn -dn');
  });

  it('aligns the GOP to the segment length at the SOURCE frame rate', () => {
    const at30 = HlsTranscoder.ffmpegArgs(base);
    expect(at30.slice(at30.indexOf('-g'), at30.indexOf('-g') + 2)).toEqual(['-g', '180']);

    const at25 = HlsTranscoder.ffmpegArgs({ ...base, frameRate: 25 });
    expect(at25[at25.indexOf('-g') + 1]).toBe('150');
    expect(at25[at25.indexOf('-keyint_min') + 1]).toBe('150');
  });

  it('forces a keyframe on every segment boundary regardless of the GOP', () => {
    const args = HlsTranscoder.ffmpegArgs(base);
    expect(args[args.indexOf('-force_key_frames') + 1]).toBe('expr:gte(t,n_forced*6)');
    expect(args[args.indexOf('-hls_time') + 1]).toBe('6');
  });

  it('falls back to 25 fps for an unusable probed rate', () => {
    for (const frameRate of [0, -1, 90000, Number.NaN]) {
      const args = HlsTranscoder.ffmpegArgs({ ...base, frameRate });
      expect(args[args.indexOf('-g') + 1]).toBe('150');
    }
  });

  it('adds a thread cap only when one is configured', () => {
    expect(HlsTranscoder.ffmpegArgs(base)).not.toContain('-threads');
    const capped = HlsTranscoder.ffmpegArgs({ ...base, threads: 2 });
    expect(capped[capped.indexOf('-threads') + 1]).toBe('2');
  });

  it('adds the keyinfo file only when encrypting, and the playlist is always the last argument', () => {
    const plain = HlsTranscoder.ffmpegArgs(base);
    expect(plain).not.toContain('-hls_key_info_file');
    expect(plain[plain.length - 1]).toMatch(/index\.m3u8$/);

    const encrypted = HlsTranscoder.ffmpegArgs({ ...base, keyInfoPath: '/w/enc.keyinfo' });
    expect(encrypted[encrypted.indexOf('-hls_key_info_file') + 1]).toBe('/w/enc.keyinfo');
    expect(encrypted[encrypted.length - 1]).toMatch(/index\.m3u8$/);
  });

  it('an ordinary source gets no frame-rate options at all (its encode is unchanged)', () => {
    const args = HlsTranscoder.ffmpegArgs(base);
    expect(args).not.toContain('-fps_mode');
    expect(args).not.toContain('-r');
    expect(args).not.toContain('-max_interleave_delta');
    expect(HlsTranscoder.ffmpegArgs({ ...base, constantFrameRate: undefined })).toEqual(args);
  });

  it('a variable-frame-rate source is interleaved strictly, so audio cannot run ahead of a frame gap', () => {
    const args = HlsTranscoder.ffmpegArgs({ ...base, constantFrameRate: 21 });
    expect(args[args.indexOf('-max_interleave_delta') + 1]).toBe('0');
    // An output option: before the HLS muxer and its playlist.
    expect(args.indexOf('-max_interleave_delta')).toBeLessThan(args.indexOf('-f'));
  });

  it('a variable-frame-rate source is encoded at a constant rate, GOP following that rate', () => {
    const args = HlsTranscoder.ffmpegArgs({ ...base, frameRate: 20.82, constantFrameRate: 21 });
    expect(args.join(' ')).toContain('-sn -dn -fps_mode cfr -r 21 -c:v libx264');
    expect(args[args.indexOf('-g') + 1]).toBe('126'); // 6 s × 21 fps
    expect(args[args.indexOf('-keyint_min') + 1]).toBe('126');
    expect(args[args.indexOf('-force_key_frames') + 1]).toBe('expr:gte(t,n_forced*6)');
  });

  it('ignores an unusable constant rate rather than passing it to ffmpeg', () => {
    for (const constantFrameRate of [0, -5, 500, Number.NaN]) {
      const args = HlsTranscoder.ffmpegArgs({ ...base, constantFrameRate });
      expect(args).not.toContain('-fps_mode');
      expect(args[args.indexOf('-g') + 1]).toBe('180');
    }
  });

  it('keeps the bitrate ladder the manifest service advertises', () => {
    const args = HlsTranscoder.ffmpegArgs(base);
    expect(args[args.indexOf('-b:v') + 1]).toBe('2200k');
    expect(args[args.indexOf('-maxrate') + 1]).toBe('2600k');
    expect(args[args.indexOf('-bufsize') + 1]).toBe('5200k');
    expect(args[args.indexOf('-b:a') + 1]).toBe('128k');
  });
});

describe('HlsTranscoder.detectVariableFrameRate', () => {
  it('leaves constant-frame-rate sources alone, including the 30 vs 29.97 rounding case', () => {
    expect(HlsTranscoder.detectVariableFrameRate('30/1', '30/1')).toBeUndefined();
    expect(HlsTranscoder.detectVariableFrameRate('30000/1001', '30000/1001')).toBeUndefined();
    expect(HlsTranscoder.detectVariableFrameRate('25/1', '2500/100')).toBeUndefined();
    expect(HlsTranscoder.detectVariableFrameRate('30/1', '30000/1001')).toBeUndefined();
    expect(HlsTranscoder.detectVariableFrameRate('24/1', '23976/1000')).toBeUndefined();
  });

  // The stream headers of the production sources that failed or were flagged
  // (Nov 2026), and the rate each would now be encoded at.
  it.each([
    ['cmv47p15l: nominal 25.83, average 20.82', '155/6', '9195499/441592', 21],
    ['cmv5oikhx: timebase 90000/1, average 24.55', '90000/1', '1051932569/42843297', 25],
    ['cmv72gpjh / cmvzq1r41 shape: timebase 90000/1, average 23.75', '90000/1', '2375/100', 24],
    ['cmv9ju1yz: nominal 38, average 20.48', '38/1', '2048/100', 20],
    ['cmw4ytuiz: nominal 60, average 23.05', '60/1', '2305/100', 23],
    ['cmvsky5bs: nominal 60, average 29.71', '60/1', '2971/100', 30],
  ])('detects %s', (_, r, avg, expected) => {
    expect(HlsTranscoder.detectVariableFrameRate(r, avg)).toBe(expected);
  });

  it('bounds the output rate', () => {
    expect(HlsTranscoder.detectVariableFrameRate('30/1', '3/1')).toBe(10); // a very sparse recording
    expect(HlsTranscoder.detectVariableFrameRate('120/1', '90/1')).toBe(60);
  });

  it('cannot decide without both rates, or with a nonsense average', () => {
    expect(HlsTranscoder.detectVariableFrameRate(undefined, '25/1')).toBeUndefined();
    expect(HlsTranscoder.detectVariableFrameRate('25/1', undefined)).toBeUndefined();
    expect(HlsTranscoder.detectVariableFrameRate('0/0', '25/1')).toBeUndefined();
    expect(HlsTranscoder.detectVariableFrameRate('25/1', '0/0')).toBeUndefined();
    expect(HlsTranscoder.detectVariableFrameRate('90000/1', '90000/1')).toBeUndefined();
  });
});

describe('HlsTranscoder output verification helpers', () => {
  it('reads encoded seconds from ffmpeg progress lines and ignores the rest', () => {
    expect(HlsTranscoder.parseProgressSeconds('out_time_us=90500000')).toBe(90.5);
    expect(HlsTranscoder.parseProgressSeconds('out_time_us=-9223372036854775807')).toBeNull();
    expect(HlsTranscoder.parseProgressSeconds('frame=120')).toBeNull();
    expect(HlsTranscoder.parseProgressSeconds('progress=end')).toBeNull();
  });

  it('inspects a media playlist: segments in order, summed duration, end marker', () => {
    const text = [
      '#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS',
      '#EXT-X-KEY:METHOD=AES-128,URI="key-placeholder",IV=0x0123',
      '#EXTINF:6.000000,', 'seg_00000.ts',
      '#EXTINF:6.000000,', 'seg_00001.ts',
      '#EXTINF:2.520000,', 'seg_00002.ts',
      '#EXT-X-ENDLIST', '',
    ].join('\n');
    expect(HlsTranscoder.inspectMediaPlaylist(text)).toEqual({
      segments: ['seg_00000.ts', 'seg_00001.ts', 'seg_00002.ts'],
      totalSeconds: 14.52,
      complete: true,
    });
  });

  it('flags a playlist ffmpeg never finished (no end marker)', () => {
    const cut = '#EXTM3U\n#EXTINF:6.000000,\nseg_00000.ts\n';
    expect(HlsTranscoder.inspectMediaPlaylist(cut)).toMatchObject({ segments: ['seg_00000.ts'], complete: false });
  });

  it('accepts HLS rounding but rejects a rung that lost real duration', () => {
    expect(HlsTranscoder.durationMatches(2654.52, 2654.4)).toBe(true);
    expect(HlsTranscoder.durationMatches(75.0, 76.9)).toBe(true); // 3 s floor for short clips
    expect(HlsTranscoder.durationMatches(2590, 2654.4)).toBe(true); // -2.4%
    expect(HlsTranscoder.durationMatches(2500, 2654.4)).toBe(false); // -5.8%
    expect(HlsTranscoder.durationMatches(1200, 2654.4)).toBe(false);
  });
});

describe('HlsTranscoder geometry and scratch', () => {
  it('keeps widths even for chroma subsampling', () => {
    expect(HlsTranscoder.evenWidth(1920, 1080, 720)).toBe(1280);
    expect(HlsTranscoder.evenWidth(1366, 768, 360)).toBe(640);
    expect(HlsTranscoder.evenWidth(1, 1, 360) % 2).toBe(0);
  });

  it('budgets scratch as source x2.5 plus a floor when the duration is unknown', () => {
    const oneGb = 1024 ** 3;
    expect(HlsTranscoder.scratchNeeded(oneGb)).toBe(Math.ceil(oneGb * 2.5) + 512 * 1024 * 1024);
    expect(HlsTranscoder.scratchNeeded(oneGb, { durationSeconds: 0 })).toBe(
      Math.ceil(oneGb * 2.5) + 512 * 1024 * 1024,
    );
  });

  it('bounds the largest rung by its maxrate ceiling, not by the source size', () => {
    // 1080p: (5000 + 128) kbps -> 641 kB/s, x1.08 TS overhead, for one hour.
    const hour = HlsTranscoder.largestRungBytes(3600, [360, 480, 720, 1080]);
    expect(hour).toBe(Math.ceil(3600 * ((5128 * 1000) / 8) * 1.08));
    // A 720p-only ladder is far cheaper, and an empty ladder falls back to 720p.
    expect(HlsTranscoder.largestRungBytes(3600, [720])).toBe(Math.ceil(3600 * ((2728 * 1000) / 8) * 1.08));
    expect(HlsTranscoder.largestRungBytes(3600, [])).toBe(HlsTranscoder.largestRungBytes(3600, [720]));
    expect(HlsTranscoder.largestRungBytes(-5, [1080])).toBe(0);
  });

  it('with a known duration budgets source + largest rung + floor (the real peak)', () => {
    // A 2-hour lecture that is only 1.2 GB on disk: x2.5 would reserve 3.5 GB
    // while the 1080p rung alone can reach ~5 GB; a short fat clip the other
    // way round. The duration-aware budget follows the actual peak.
    const twoHours = HlsTranscoder.scratchNeeded(1.2e9, { durationSeconds: 7200, ladder: [360, 480, 720, 1080] });
    expect(twoHours).toBe(1.2e9 + HlsTranscoder.largestRungBytes(7200, [1080]) + 512 * 1024 * 1024);
    expect(twoHours).toBeGreaterThan(HlsTranscoder.scratchNeeded(1.2e9));
    const fatClip = HlsTranscoder.scratchNeeded(2e9, { durationSeconds: 300, ladder: [1080] });
    expect(fatClip).toBeLessThan(HlsTranscoder.scratchNeeded(2e9));
    expect(fatClip).toBe(2e9 + HlsTranscoder.largestRungBytes(300, [1080]) + 512 * 1024 * 1024);
  });

  it('writes a static master that advertises the encoded codec', () => {
    const master = HlsTranscoder.buildStaticMaster([
      { height: 360, width: 640, bitrateKbps: 664 },
      { height: 720, width: 1280, bitrateKbps: 2328 },
    ]);
    expect(master).toContain('#EXT-X-INDEPENDENT-SEGMENTS');
    expect(master).toContain('BANDWIDTH=664000,RESOLUTION=640x360,CODECS="avc1.640029,mp4a.40.2"');
    expect(master).toContain('720p/index.m3u8');
  });
});
