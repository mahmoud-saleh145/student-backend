import { ContentStatus, DeviceStatus, PlaybackTicketStatus } from '@prisma/client';

import { PlaybackService } from '../../src/modules/playback/playback.service';

/**
 * The edge liveness probe, for library documents.
 *
 * `LibraryDocumentsService.issueTicket` signs a document URL with
 * `tid=lib_<partId>` and creates **no** PlaybackTicket row — the entitlement is
 * the durable record. `ticketLiveness` used to look that id up in
 * `playbackTicket` regardless, always missed, and answered `live: false`, so
 * the media Worker refused every library PDF with `ticket_revoked` while the
 * signature, the expiry and the bucket were all fine.
 *
 * These tests pin both halves: the library branch validates the same rules
 * `issueTicket` applied when it minted the URL, and the video branch is
 * untouched.
 */

const USER_ID = 'usr_student';
const PART_ID = 'lpart_1';
const LIB_TICKET = `lib_${PART_ID}`;

interface Options {
  part?: {
    isPreview?: boolean;
    status?: ContentStatus;
    materialStatus?: ContentStatus;
    materialDeletedAt?: Date | null;
  } | null;
  entitlement?: { revokedAt: Date | null } | null;
  activeSessions?: number;
  activeDevices?: number;
  /** The video branch's row, for the regression test. */
  playbackTicket?: unknown;
}

function build(options: Options = {}) {
  const partRow =
    options.part === null
      ? null
      : {
          id: PART_ID,
          isPreview: options.part?.isPreview ?? false,
          status: options.part?.status ?? ContentStatus.PUBLISHED,
          material: {
            status: options.part?.materialStatus ?? ContentStatus.PUBLISHED,
            deletedAt: options.part?.materialDeletedAt ?? null,
          },
        };

  // Named parameters throughout: a zero-arity `jest.fn(async () => …)` infers
  // an empty parameter tuple, making `mock.calls[0][0]` a type error under
  // `strict`.
  const libraryPartFindFirst = jest.fn(async (_args: { where: unknown; select: unknown }) =>
    partRow,
  );
  const entitlementFindUnique = jest.fn(async (_args: { where: unknown; select: unknown }) =>
    options.entitlement === undefined ? { revokedAt: null } : options.entitlement,
  );
  const playbackTicketFindFirst = jest.fn(
    async (_args: { where: unknown; select: unknown }) => options.playbackTicket ?? null,
  );
  const sessionCount = jest.fn(async (_args: { where: unknown }) =>
    options.activeSessions ?? 1,
  );
  const deviceCount = jest.fn(async (_args: { where: unknown }) => options.activeDevices ?? 1);

  const prisma = {
    libraryPart: { findFirst: libraryPartFindFirst },
    libraryEntitlement: { findUnique: entitlementFindUnique },
    playbackTicket: { findFirst: playbackTicketFindFirst },
    session: { count: sessionCount },
    device: { count: deviceCount },
    $transaction: jest.fn(async (operations: readonly unknown[]) => Promise.all(operations)),
  };

  const config = {
    getOrThrow: (key: string) =>
      key === 'playback'
        ? { ticketTtl: 300, heartbeatGrace: 90, heartbeatInterval: 30 }
        : {},
  };

  const service = new PlaybackService(
    prisma as never,
    {} as never, // redis
    {} as never, // courseAccess
    {} as never, // devices
    {} as never, // security
    {} as never, // storage
    {} as never, // tokens
    {} as never, // manifest
    config as never,
  );

  return { service, prisma, libraryPartFindFirst, playbackTicketFindFirst, entitlementFindUnique };
}

describe('library document tickets', () => {
  it('an entitled student on a live session and device is live', async () => {
    const { service } = build();
    await expect(service.ticketLiveness(LIB_TICKET, USER_ID)).resolves.toEqual({
      live: true,
    });
  });

  it('never consults the playback ticket table for a lib_ id', async () => {
    // The original defect in one assertion: there is no row to find, so asking
    // was guaranteed to answer "revoked".
    const { service, playbackTicketFindFirst, libraryPartFindFirst } = build();

    await service.ticketLiveness(LIB_TICKET, USER_ID);

    expect(playbackTicketFindFirst).not.toHaveBeenCalled();
    const call = libraryPartFindFirst.mock.calls[0];
    if (!call) throw new Error('the library part was never looked up');
    expect((call[0].where as { id: string }).id).toBe(PART_ID);
  });

  it('is not live without an entitlement', async () => {
    const { service } = build({ entitlement: null });
    await expect(service.ticketLiveness(LIB_TICKET, USER_ID)).resolves.toEqual({
      live: false,
    });
  });

  it('is not live once the entitlement is revoked', async () => {
    const { service } = build({ entitlement: { revokedAt: new Date() } });
    await expect(service.ticketLiveness(LIB_TICKET, USER_ID)).resolves.toEqual({
      live: false,
    });
  });

  it('is not live when every session has been revoked', async () => {
    // Signing the student out must kill an already-minted URL; this is the
    // property the edge check exists for.
    const { service } = build({ activeSessions: 0 });
    await expect(service.ticketLiveness(LIB_TICKET, USER_ID)).resolves.toEqual({
      live: false,
    });
  });

  it('is not live when the account has no authorised device', async () => {
    const { service } = build({ activeDevices: 0 });
    await expect(service.ticketLiveness(LIB_TICKET, USER_ID)).resolves.toEqual({
      live: false,
    });
  });

  it('is not live when the material has been withdrawn', async () => {
    const { service } = build({
      part: { materialStatus: ContentStatus.ARCHIVED },
    });
    await expect(service.ticketLiveness(LIB_TICKET, USER_ID)).resolves.toEqual({
      live: false,
    });
  });

  it('is not live when the material has been deleted', async () => {
    const { service } = build({ part: { materialDeletedAt: new Date() } });
    await expect(service.ticketLiveness(LIB_TICKET, USER_ID)).resolves.toEqual({
      live: false,
    });
  });

  it('is not live when the part itself is archived', async () => {
    const { service } = build({ part: { status: ContentStatus.ARCHIVED } });
    await expect(service.ticketLiveness(LIB_TICKET, USER_ID)).resolves.toEqual({
      live: false,
    });
  });

  it('is not live when the part no longer exists', async () => {
    const { service } = build({ part: null });
    await expect(service.ticketLiveness(LIB_TICKET, USER_ID)).resolves.toEqual({
      live: false,
    });
  });

  it('a preview needs no entitlement and is not device-bound', async () => {
    // `issueTicket` skips both checks for a preview, so re-checking must too —
    // the edge must never refuse a grant the issuing path would have allowed.
    const { service, entitlementFindUnique } = build({
      part: { isPreview: true },
      entitlement: null,
      activeDevices: 0,
    });

    await expect(service.ticketLiveness(LIB_TICKET, USER_ID)).resolves.toEqual({
      live: true,
    });
    expect(entitlementFindUnique).not.toHaveBeenCalled();
  });

  it('still refuses a preview once the student is signed out', async () => {
    const { service } = build({ part: { isPreview: true }, activeSessions: 0 });
    await expect(service.ticketLiveness(LIB_TICKET, USER_ID)).resolves.toEqual({
      live: false,
    });
  });
});

describe('video tickets are unchanged', () => {
  const liveTicket = {
    status: PlaybackTicketStatus.ACTIVE,
    expiresAt: new Date(Date.now() + 60_000),
    lastHeartbeatAt: new Date(),
    session: { status: 'ACTIVE' },
    device: { status: DeviceStatus.ACTIVE },
  };

  it('a live video ticket is still live, and reads the ticket row', async () => {
    const { service, playbackTicketFindFirst, libraryPartFindFirst } = build({
      playbackTicket: liveTicket,
    });

    await expect(service.ticketLiveness('tkt_1', USER_ID)).resolves.toEqual({ live: true });
    expect(playbackTicketFindFirst).toHaveBeenCalled();
    // And the library branch is not involved.
    expect(libraryPartFindFirst).not.toHaveBeenCalled();
  });

  it('a revoked video session is still refused', async () => {
    const { service } = build({
      playbackTicket: { ...liveTicket, session: { status: 'REVOKED' } },
    });
    await expect(service.ticketLiveness('tkt_1', USER_ID)).resolves.toEqual({ live: false });
  });

  it('a revoked video device is still refused', async () => {
    const { service } = build({
      playbackTicket: { ...liveTicket, device: { status: DeviceStatus.REVOKED } },
    });
    await expect(service.ticketLiveness('tkt_1', USER_ID)).resolves.toEqual({ live: false });
  });

  it('an expired video ticket is still refused', async () => {
    const { service } = build({
      playbackTicket: { ...liveTicket, expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(service.ticketLiveness('tkt_1', USER_ID)).resolves.toEqual({ live: false });
  });

  it('a missing video ticket is still refused', async () => {
    const { service } = build({ playbackTicket: null });
    await expect(service.ticketLiveness('tkt_1', USER_ID)).resolves.toEqual({ live: false });
  });

  it('a request without a uid is refused whatever the id', async () => {
    const { service } = build();
    await expect(service.ticketLiveness(LIB_TICKET, null)).resolves.toEqual({ live: false });
    await expect(service.ticketLiveness('tkt_1', null)).resolves.toEqual({ live: false });
  });
});
