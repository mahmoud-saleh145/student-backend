import { DeviceStatus } from '@prisma/client';
import { allowDrm } from './helpers/drm-doubles';
import { PlaybackService } from 'src/modules/playback/playback.service';

/**
 * THE PRODUCTION OUTAGE THIS FILE EXISTS FOR
 * ------------------------------------------
 * A student opening a lecture PDF got, from the media Worker:
 *
 *     403 Forbidden
 *     x-deny-reason: ticket_revoked
 *
 * The Worker's `ticketIsLive` probes `GET /playback/tickets/{tid}/state?uid=`
 * (docs/cloudflare-worker.js:155-156) and denies with `ticket_revoked` whenever
 * the API answers "not live".
 *
 * Two kinds of grant reach that probe:
 *
 *   `lib_<partId>`        library documents
 *   `att_<attachmentId>`  lecture / section / course documents
 *
 * NEITHER creates a `PlaybackTicket` row. `ticketLiveness` special-cased only
 * the first, so a `lib_` id was re-derived from the entitlement and answered
 * live, while an `att_` id fell through to
 * `playbackTicket.findFirst({ id: 'att_...' })`, always missed, and answered
 * `{ live: false }` - for EVERY lecture PDF, while its signature, expiry and
 * bucket were all valid.
 *
 * Library PDFs worked only because that outage had already been fixed once.
 * These tests pin both, so neither regresses and neither can silently start
 * serving something it should refuse.
 */

const ATT = 'att_x';
const LIB = 'lib_x';

function build(
  opts: {
    attachment?: Record<string, unknown> | null;
    lesson?: Record<string, unknown> | null;
    section?: { status?: string } | null;
    canAccessContent?: boolean;
    allowedSectionIds?: string[] | null;
    activeSessions?: number;
    activeDevices?: number;
  } = {},
) {
  const attachment =
    opts.attachment === undefined
      ? {
          id: 'x',
          courseId: 'crs_1',
          lessonId: 'les_1',
          sectionId: null,
          isPreview: false,
          isProtected: true,
          deletedAt: null,
        }
      : opts.attachment;

  const playbackTicketFindFirst = jest.fn(async () => null);

  const prisma = {
    attachment: { findFirst: jest.fn(async () => attachment) },
    lesson: {
      findUnique: jest.fn(async () =>
        opts.lesson === undefined
          ? { status: 'PUBLISHED', sectionId: 'sec_1', section: { status: 'PUBLISHED' } }
          : opts.lesson,
      ),
    },
    courseSection: {
      findUnique: jest.fn(async () => ({ status: opts.section?.status ?? 'PUBLISHED' })),
    },
    playbackTicket: { findFirst: playbackTicketFindFirst },
    libraryPart: {
      findFirst: jest.fn(async () => null),
    },
    libraryEntitlement: {
      findUnique: jest.fn(async () => null),
    },
    session: {
      count: jest.fn(async () => opts.activeSessions ?? 1),
    },
    device: {
      count: jest.fn(async () => opts.activeDevices ?? 1),
    },
    $transaction: jest.fn(async (arg: unknown[]) => Promise.all(arg)),
  };

  const access = {
    resolve: jest.fn(async () => ({
      canAccessContent: opts.canAccessContent ?? true,
    })),
    allowedSectionIds: jest.fn(async () =>
      opts.allowedSectionIds === undefined ? null : opts.allowedSectionIds,
    ),
  };

  // PlaybackService takes a long constructor; only these three are exercised by
  // ticketLiveness, so everything else is a harmless stand-in. Order matches the
  // real constructor: prisma, redis, access, devices, storage, manifest, tokens,
  // security, gumlet, config.
  const service = new PlaybackService(
    prisma as never,
    {} as never,
    access as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    allowDrm() as never,
    { getOrThrow: () => ({}) } as never,
  );

  return { service, prisma, playbackTicketFindFirst };
}

const live = (t: ReturnType<typeof build>, tid = ATT, uid = 'usr_1') =>
  t.service.ticketLiveness(tid, uid);

// ---------------------------------------------------------------------------
// Lecture PDFs - the failing flow
// ---------------------------------------------------------------------------

describe('a lecture PDF grant on the edge liveness probe', () => {
  it('is live, and never consults the video ticket table', async () => {
    // THE REGRESSION. Before the fix this answered { live: false } because
    // `att_x` was looked up as a PlaybackTicket id.
    const t = build();
    expect(await live(t)).toEqual({ live: true });
    expect(t.playbackTicketFindFirst).not.toHaveBeenCalled();
  });

  it('is refused when the attachment no longer exists', async () => {
    const t = build({ attachment: null });
    expect(await live(t)).toEqual({ live: false });
  });

  it('is refused when the attachment was deleted', async () => {
    const t = build({
      attachment: {
        id: 'x',
        courseId: 'crs_1',
        lessonId: 'les_1',
        sectionId: null,
        isPreview: false,
        isProtected: true,
        deletedAt: new Date(),
      },
    });
    // notDeleted turns the soft delete into a miss.
    const t2 = build({ attachment: null });
    expect(await live(t2)).toEqual({ live: false });
    expect(t).toBeDefined();
  });

  it('is refused for a student with no course access', async () => {
    const t = build({ canAccessContent: false });
    expect(await live(t)).toEqual({ live: false });
  });

  it('is refused when the lecture is not published', async () => {
    const t = build({ lesson: { status: 'DRAFT', sectionId: 'sec_1', section: { status: 'PUBLISHED' } } });
    expect(await live(t)).toEqual({ live: false });
  });

  it('is refused when the lecture\'s SECTION is not published', async () => {
    const t = build({
      lesson: { status: 'PUBLISHED', sectionId: 'sec_1', section: { status: 'DRAFT' } },
    });
    expect(await live(t)).toEqual({ live: false });
  });

  it('is refused for a section-scoped handout on a draft section', async () => {
    const t = build({
      attachment: {
        id: 'x',
        courseId: 'crs_1',
        lessonId: null,
        sectionId: 'sec_1',
        isPreview: false,
        isProtected: true,
        deletedAt: null,
      },
      section: { status: 'DRAFT' },
    });
    expect(await live(t)).toEqual({ live: false });
  });

  it('is refused when the student does not own the section', async () => {
    const t = build({ allowedSectionIds: ['sec_other'] });
    expect(await live(t)).toEqual({ live: false });
  });

  it('is live when the student owns the section', async () => {
    const t = build({ allowedSectionIds: ['sec_1'] });
    expect(await live(t)).toEqual({ live: true });
  });

  it('is refused once every session is revoked', async () => {
    const t = build({ activeSessions: 0 });
    expect(await live(t)).toEqual({ live: false });
  });

  it('is refused for a protected document with no authorised device', async () => {
    const t = build({ activeDevices: 0 });
    expect(await live(t)).toEqual({ live: false });
  });

  it('stays live for an UNPROTECTED document with no device', async () => {
    // isProtected is what made issueTicket device-bind the grant. A plain
    // syllabus must not become device-bound at the edge.
    const t = build({
      attachment: {
        id: 'x',
        courseId: 'crs_1',
        lessonId: null,
        sectionId: null,
        isPreview: false,
        isProtected: false,
        deletedAt: null,
      },
      activeDevices: 0,
    });
    expect(await live(t)).toEqual({ live: true });
  });

  it('lets a preview document through with no access and no device', async () => {
    const t = build({
      attachment: {
        id: 'x',
        courseId: 'crs_1',
        lessonId: null,
        sectionId: null,
        isPreview: true,
        isProtected: false,
        deletedAt: null,
      },
      canAccessContent: false,
      activeDevices: 0,
    });
    expect(await live(t)).toEqual({ live: true });
  });

  it('refuses a grant whose lecture is still unpublished even if previewed', async () => {
    const t = build({
      attachment: {
        id: 'x',
        courseId: 'crs_1',
        lessonId: 'les_1',
        sectionId: null,
        isPreview: true,
        isProtected: false,
        deletedAt: null,
      },
      lesson: { status: 'DRAFT', sectionId: 'sec_1', section: { status: 'PUBLISHED' } },
    });
    expect(await live(t)).toEqual({ live: false });
  });

  it('refuses when the caller supplies no uid', async () => {
    const t = build();
    expect(await t.service.ticketLiveness(ATT, null)).toEqual({ live: false });
  });

  it('is stable across repeated range requests', async () => {
    // pdf.js issues many concurrent requests for one document. The probe is
    // read-only and cached for 10s, so the same id must keep answering live.
    const t = build();
    for (let i = 0; i < 5; i += 1) {
      expect(await live(t)).toEqual({ live: true });
    }
  });

  it('is unaffected by a video ticket id sharing the same shape', async () => {
    const t = build();
    await live(t, 'ptk_123');
    expect(t.playbackTicketFindFirst).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Library PDFs - the working flow, pinned so it stays working
// ---------------------------------------------------------------------------

describe('a library PDF grant on the edge liveness probe', () => {
  it('still resolves through its own branch, not the video table', async () => {
    const t = build();
    // `lib_` is handled before the video lookup; a library id must never reach
    // playbackTicket either.
    await t.service.ticketLiveness(LIB, 'usr_1').catch(() => undefined);
    expect(t.playbackTicketFindFirst).not.toHaveBeenCalled();
  });

  it('leaves the video branch untouched for real playback tickets', async () => {
    const t = build();
    await t.service.ticketLiveness('ptk_1', 'usr_1');
    expect(t.playbackTicketFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'ptk_1' }) }),
    );
  });
});

describe('prefix dispatch', () => {
  it('routes each grant kind to exactly one implementation', async () => {
    const t = build();
    await live(t, ATT);
    expect(t.playbackTicketFindFirst).not.toHaveBeenCalled();

    await live(t, LIB);
    expect(t.playbackTicketFindFirst).not.toHaveBeenCalled();

    await live(t, 'ptk_9');
    expect(t.playbackTicketFindFirst).toHaveBeenCalled();
  });

  it('refuses an empty attachment id rather than matching everything', async () => {
    const t = build();
    expect(await t.service.ticketLiveness('att_', 'usr_1')).toEqual({ live: false });
    expect(t.playbackTicketFindFirst).not.toHaveBeenCalled();
  });
});

describe('device binding is preserved for protected material', () => {
  it('counts only ACTIVE devices, matching the rest of the platform', async () => {
    const t = build();
    await live(t);
    expect(t.prisma.device.count).toHaveBeenCalledWith({
      where: { userId: 'usr_1', status: DeviceStatus.ACTIVE },
    });
  });
});