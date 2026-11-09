import { HlsTranscoder } from '../../src/jobs/processors/hls-transcoder';

/**
 * The pure parts of the shared HLS transcoder: ladder planning and the ffmpeg
 * invocation. These are what the audit of the old worker changed, so each
 * change is pinned here.
 */
describe('HlsTranscoder.planLadder', () => {
  it('never upscales: rungs above the source are dropped', () => {
    expect(HlsTranscoder.planLadder([360, 480, 720, 1080], 720)).toEqual([360, 480, 720]);
  });

  it('always keeps the smallest rung, even for a tiny source', () => {
    expect(HlsTranscoder.planLadder([360, 480, 720, 1080], 240)).toEqual([360]);
  });

  it('keeps the full ladder for a 1080p source and sorts it', () => {
    expect(HlsTranscoder.planLadder([1080, 360, 720, 480], 1080)).toEqual([360, 480, 720, 1080]);
  });

  it('ignores junk and duplicates in the configured ladder', () => {
    expect(HlsTranscoder.planLadder([720, 720, 0, -1, Number.NaN, 360], 1080)).toEqual([360, 720]);
    expect(HlsTranscoder.planLadder([], 1080)).toEqual([360]);
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

  it('keeps the bitrate ladder the manifest service advertises', () => {
    const args = HlsTranscoder.ffmpegArgs(base);
    expect(args[args.indexOf('-b:v') + 1]).toBe('2200k');
    expect(args[args.indexOf('-maxrate') + 1]).toBe('2600k');
    expect(args[args.indexOf('-bufsize') + 1]).toBe('5200k');
    expect(args[args.indexOf('-b:a') + 1]).toBe('128k');
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
