import { PlaybackService } from '../../src/modules/playback/playback.service';

/**
 * Segment delivery across a ticket rotation on the HLS pipeline.
 *
 * Every segment URL carries its ticket id and the media edge asks the API
 * whether that ticket is live. A rotation releases the old ticket and hands
 * the player a new manifest, but the native player keeps pulling the segments
 * it already queued from the OLD playlist for a few seconds while the new
 * source initialises. Found in the local end-to-end run: ffmpeg was refused
 * the last segments right after the rotation. The old ticket therefore stays
 * live for a short hand-off window - and only then.
 */
function service(ticket: Record<string, unknown> | null) {
  const prisma = { playbackTicket: { findFirst: jest.fn(async () => ticket) } };
  const config = {
    getOrThrow: (k: string) =>
      k === 'playback' ? { heartbeatInterval: 30, heartbeatGrace: 90 } : { drm: { enabled: false } },
    get: () => undefined,
  };
  return new PlaybackService(
    prisma as never, {} as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, {} as never, {} as never,
    config as never,
  );
}

const base = {
  expiresAt: new Date(Date.now() + 60_000),
  lastHeartbeatAt: new Date(),
  session: { status: 'ACTIVE' },
  device: { status: 'ACTIVE' },
};

describe('ticket liveness around a rotation', () => {
  it('an ACTIVE ticket is live', async () => {
    const s = service({ ...base, status: 'ACTIVE', releasedAt: null, rotatedTo: null });
    await expect(s.ticketLiveness('t_old', 'u_1')).resolves.toEqual({ live: true });
  });

  it('a ticket just RELEASED by a rotation stays live while its successor is ACTIVE', async () => {
    const s = service({
      ...base,
      status: 'RELEASED',
      releasedAt: new Date(Date.now() - 5_000),
      rotatedTo: { status: 'ACTIVE' },
    });
    await expect(s.ticketLiveness('t_old', 'u_1')).resolves.toEqual({ live: true });
  });

  it('the hand-off ends after two heartbeats', async () => {
    const s = service({
      ...base,
      status: 'RELEASED',
      releasedAt: new Date(Date.now() - 61_000),
      rotatedTo: { status: 'ACTIVE' },
    });
    await expect(s.ticketLiveness('t_old', 'u_1')).resolves.toEqual({ live: false });
  });

  it('a RELEASED ticket with no successor (the student closed the player) is not live', async () => {
    const s = service({ ...base, status: 'RELEASED', releasedAt: new Date(), rotatedTo: null });
    await expect(s.ticketLiveness('t_old', 'u_1')).resolves.toEqual({ live: false });
  });

  it('a hand-off dies with its successor', async () => {
    const s = service({
      ...base,
      status: 'RELEASED',
      releasedAt: new Date(),
      rotatedTo: { status: 'REVOKED' },
    });
    await expect(s.ticketLiveness('t_old', 'u_1')).resolves.toEqual({ live: false });
  });

  it('a REVOKED ticket never qualifies, successor or not', async () => {
    const s = service({
      ...base,
      status: 'REVOKED',
      releasedAt: new Date(),
      rotatedTo: { status: 'ACTIVE' },
    });
    await expect(s.ticketLiveness('t_old', 'u_1')).resolves.toEqual({ live: false });
  });

  it('a hand-off still ends with the session or the device', async () => {
    const s = service({
      ...base,
      status: 'RELEASED',
      releasedAt: new Date(),
      rotatedTo: { status: 'ACTIVE' },
      device: { status: 'REVOKED' },
    });
    await expect(s.ticketLiveness('t_old', 'u_1')).resolves.toEqual({ live: false });
  });
});
