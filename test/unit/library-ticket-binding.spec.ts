import { AccountStatus, ContentStatus, DeviceStatus, LibraryDepartmentScope } from '@prisma/client';

import { AppException } from '../../src/common/errors/app.exception';
import { ErrorCode } from '../../src/common/errors/error-codes';
import { hasValidEdgeSecret } from '../../src/common/security/edge-liveness';
import { PlaybackService } from '../../src/modules/playback/playback.service';

import { allowDrm } from './helpers/drm-doubles';

/**
 * What the liveness route answers about a Library URL.
 *
 * Owned tickets (`lib_`) are held to the exact session and device the URL was
 * signed for. Preview tickets (`libp_`) are held to the exact session, and need
 * no approved device. The route recognises the Worker by a shared secret, and
 * the account-wide answer survives only for the previous Worker, only until
 * EDGE_LIVENESS_ENFORCE is on.
 *
 * Sessions and devices are real in-memory rows, and the double applies the
 * service's `where`, so these tests fail if a filter is dropped.
 */

const USER = 'usr_student';
const SECRET = 's'.repeat(48);
const FUTURE = new Date(Date.now() + 60 * 60 * 1000);

interface SessionRow {
  id: string;
  userId: string;
  deviceId: string | null;
  status: string;
  expiresAt: Date;
  user: { deletedAt: Date | null; status: AccountStatus };
}
interface DeviceRow {
  id: string;
  userId: string;
  status: DeviceStatus;
}

const session = (over: Partial<SessionRow> = {}): SessionRow => ({
  id: 'ses_1',
  userId: USER,
  deviceId: 'dev_1',
  status: 'ACTIVE',
  expiresAt: FUTURE,
  user: { deletedAt: null, status: AccountStatus.ACTIVE },
  ...over,
});
const device = (over: Partial<DeviceRow> = {}): DeviceRow => ({
  id: 'dev_1',
  userId: USER,
  status: DeviceStatus.ACTIVE,
  ...over,
});

const MATERIAL = {
  id: 'mat_1',
  status: ContentStatus.PUBLISHED as ContentStatus,
  isActive: true,
  deletedAt: null as Date | null,
  universityId: 'uni_1',
  facultyId: 'fac_1',
  departmentScope: LibraryDepartmentScope.FACULTY,
  departments: [] as { departmentId: string }[],
};

interface Options {
  sessions?: SessionRow[];
  devices?: DeviceRow[];
  isPreview?: boolean;
  part?: { status?: ContentStatus; isActive?: boolean };
  material?: Partial<typeof MATERIAL>;
  entitlement?: { revokedAt: Date | null } | null;
  scope?: { universityId: string; facultyId: string; departmentId: string } | null;
  storefront?: boolean;
  secret?: string | null;
  enforce?: boolean;
}

function build(o: Options = {}) {
  const sessions = o.sessions ?? [session()];
  const devices = o.devices ?? [device()];
  const sessionFindFirst = jest.fn(
    async ({
      where,
    }: {
      where: {
        id: string;
        userId: string;
        status: string;
        expiresAt: { gt: Date };
        user: { deletedAt: null; status: { notIn: AccountStatus[] } };
      };
    }) =>
      sessions.find(
        (s) =>
          s.id === where.id &&
          s.userId === where.userId &&
          s.status === where.status &&
          s.expiresAt > where.expiresAt.gt &&
          s.user.deletedAt === where.user.deletedAt &&
          !where.user.status.notIn.includes(s.user.status),
      ) ?? null,
  );
  const deviceFindFirst = jest.fn(
    async ({ where }: { where: { id: string; userId: string; status: DeviceStatus } }) =>
      devices.find(
        (d) => d.id === where.id && d.userId === where.userId && d.status === where.status,
      ) ?? null,
  );
  const part = {
    id: 'part_1',
    isPreview: o.isPreview ?? false,
    status: o.part?.status ?? ContentStatus.PUBLISHED,
    isActive: o.part?.isActive ?? true,
    deletedAt: null,
    material: { ...MATERIAL, ...o.material },
  };
  const prisma = {
    libraryPart: { findFirst: jest.fn(async () => part) },
    libraryEntitlement: {
      findUnique: jest.fn(async () =>
        o.entitlement === undefined ? { revokedAt: null } : o.entitlement,
      ),
    },
    studentProfile: {
      findUnique: jest.fn(async () =>
        o.scope === undefined
          ? { universityId: 'uni_1', facultyId: 'fac_1', departmentId: 'dep_1' }
          : o.scope,
      ),
    },
    playbackTicket: { findFirst: jest.fn(async () => null) },
    session: {
      findFirst: sessionFindFirst,
      count: jest.fn(async () => sessions.filter((s) => s.status === 'ACTIVE').length),
    },
    device: {
      findFirst: deviceFindFirst,
      count: jest.fn(async () => devices.filter((d) => d.status === DeviceStatus.ACTIVE).length),
    },
    $transaction: jest.fn(async (operations: readonly unknown[]) => Promise.all(operations)),
  };
  const config = {
    get: (key: string) =>
      key === 'library' ? { storefrontEnabled: o.storefront ?? true } : undefined,
    getOrThrow: (key: string) =>
      key === 'playback'
        ? {
            ticketTtl: 300,
            heartbeatGrace: 90,
            heartbeatInterval: 30,
            edgeLivenessSecret: o.secret === undefined ? SECRET : o.secret,
            edgeLivenessEnforce: o.enforce ?? false,
          }
        : {},
  };
  const service = new PlaybackService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    allowDrm() as never,
    config as never,
  );
  return { service, prisma, deviceFindFirst, sessionFindFirst };
}

const EXACT = { sid: 'ses_1', did: 'dev_1' };
const liveOwned = (o: Options = {}, bound: Record<string, unknown> = EXACT) =>
  build(o).service.ticketLiveness('lib_part_1', USER, bound);
const livePreview = (o: Options = {}, bound: Record<string, unknown> = EXACT) =>
  build({ isPreview: true, entitlement: null, ...o }).service.ticketLiveness('libp_part_1', USER, bound);

const LIVE = { live: true };
const DEAD = { live: false };

describe('owned tickets (lib_) are bound to the exact session and device', () => {
  it('live on the exact session and device', async () => {
    await expect(liveOwned()).resolves.toEqual(LIVE);
  });

  it('dead once that session is revoked', async () => {
    await expect(liveOwned({ sessions: [session({ status: 'REVOKED' })] })).resolves.toEqual(DEAD);
  });

  it('dead once that session has expired, even if still marked active', async () => {
    await expect(
      liveOwned({ sessions: [session({ expiresAt: new Date(Date.now() - 1000) })] }),
    ).resolves.toEqual(DEAD);
  });

  it('another active session does not keep a revoked session\'s URL alive', async () => {
    await expect(
      liveOwned({
        sessions: [session({ status: 'REVOKED' }), session({ id: 'ses_2', status: 'ACTIVE' })],
      }),
    ).resolves.toEqual(DEAD);
  });

  it('a session belonging to another user does not count', async () => {
    await expect(liveOwned({ sessions: [session({ userId: 'usr_other' })] })).resolves.toEqual(DEAD);
  });

  it.each([AccountStatus.DISABLED, AccountStatus.SUSPENDED])(
    'dead when the account is %s',
    async (status) => {
      await expect(
        liveOwned({ sessions: [session({ user: { deletedAt: null, status } })] }),
      ).resolves.toEqual(DEAD);
    },
  );

  it('dead when the account was removed', async () => {
    await expect(
      liveOwned({ sessions: [session({ user: { deletedAt: new Date(), status: AccountStatus.ACTIVE } })] }),
    ).resolves.toEqual(DEAD);
  });

  it.each([DeviceStatus.REVOKED, DeviceStatus.BLOCKED, DeviceStatus.PENDING_APPROVAL])(
    'dead when the device is %s',
    async (status) => {
      await expect(liveOwned({ devices: [device({ status })] })).resolves.toEqual(DEAD);
    },
  );

  it('another approved device does not validate a URL signed for this one', async () => {
    await expect(
      liveOwned({ devices: [device({ status: DeviceStatus.REVOKED }), device({ id: 'dev_2' })] }),
    ).resolves.toEqual(DEAD);
  });

  it('a URL naming a different device than its session is bound to is dead', async () => {
    await expect(
      liveOwned({ devices: [device(), device({ id: 'dev_2' })] }, { sid: 'ses_1', did: 'dev_2' }),
    ).resolves.toEqual(DEAD);
  });

  it('a device belonging to another user does not count', async () => {
    await expect(liveOwned({ devices: [device({ userId: 'usr_other' })] })).resolves.toEqual(DEAD);
  });

  it('a session signed in without a device is held to the device the URL names', async () => {
    const sessions = [session({ deviceId: null })];
    await expect(liveOwned({ sessions })).resolves.toEqual(LIVE);
    await expect(
      liveOwned({ sessions, devices: [device({ status: DeviceStatus.REVOKED })] }),
    ).resolves.toEqual(DEAD);
    await expect(liveOwned({ sessions }, { sid: 'ses_1' })).resolves.toEqual(DEAD);
  });

  it.each<[string, Record<string, unknown>]>([
    ['no identifiers', {}],
    ['no session', { did: 'dev_1' }],
    ['no device', { sid: 'ses_1' }],
    ['null session', { sid: null, did: 'dev_1' }],
    ['empty session', { sid: '', did: 'dev_1' }],
    ['empty device', { sid: 'ses_1', did: '' }],
    ['repeated session parameter', { sid: ['ses_1', 'ses_1'], did: 'dev_1' }],
    ['object session', { sid: { contains: '' }, did: 'dev_1' }],
    ['repeated device parameter', { sid: 'ses_1', did: ['dev_1'] }],
    ['session with illegal characters', { sid: "ses_1' OR 1=1", did: 'dev_1' }],
    ['oversized session', { sid: 'x'.repeat(65), did: 'dev_1' }],
  ])('dead with a missing or malformed identifier: %s', async (_name, bound) => {
    const { service, sessionFindFirst } = build();
    await expect(service.ticketLiveness('lib_part_1', USER, bound)).resolves.toEqual(DEAD);
    // A malformed session id never reaches the database.
    if (!bound.sid || typeof bound.sid !== 'string' || bound.sid !== 'ses_1') {
      expect(sessionFindFirst).not.toHaveBeenCalled();
    }
  });

  it('dead once the entitlement is revoked, whatever the session and device', async () => {
    await expect(liveOwned({ entitlement: { revokedAt: new Date() } })).resolves.toEqual(DEAD);
  });

  it('dead without an entitlement', async () => {
    await expect(liveOwned({ entitlement: null })).resolves.toEqual(DEAD);
  });

  it('a part that is also a preview is not device-bound, but still needs the exact session', async () => {
    const o = { isPreview: true, devices: [] };
    await expect(liveOwned(o, { sid: 'ses_1' })).resolves.toEqual(LIVE);
    await expect(liveOwned({ ...o, sessions: [session({ status: 'REVOKED' })] }, { sid: 'ses_1' })).resolves.toEqual(DEAD);
    await expect(liveOwned(o, {})).resolves.toEqual(DEAD);
  });
});

describe('preview tickets (libp_) need a session, not an approved device', () => {
  it('live on a session with no device at all, without looking one up', async () => {
    const { service, deviceFindFirst } = build({
      isPreview: true,
      entitlement: null,
      sessions: [session({ deviceId: null })],
      devices: [],
    });
    await expect(service.ticketLiveness('libp_part_1', USER, { sid: 'ses_1' })).resolves.toEqual(LIVE);
    expect(deviceFindFirst).not.toHaveBeenCalled();
  });

  it.each([DeviceStatus.PENDING_APPROVAL, DeviceStatus.REVOKED, DeviceStatus.BLOCKED])(
    'live on a session whose device is %s, so nothing to reopen endlessly',
    async (status) => {
      await expect(livePreview({ devices: [device({ status })] })).resolves.toEqual(LIVE);
    },
  );

  it('live beside a revoked entitlement (Decision B)', async () => {
    await expect(livePreview({ entitlement: { revokedAt: new Date() } })).resolves.toEqual(LIVE);
  });

  it.each<[string, Options, Record<string, unknown>?]>([
    ['no session id', {}, { did: 'dev_1' }],
    ['a malformed session id', {}, { sid: ['ses_1'] }],
    ['a revoked session', { sessions: [session({ status: 'REVOKED' })] }],
    ['an expired session', { sessions: [session({ expiresAt: new Date(Date.now() - 1000) })] }],
    ['a disabled account', { sessions: [session({ user: { deletedAt: null, status: AccountStatus.DISABLED } })] }],
    ['another session, active, for the same user', { sessions: [session({ status: 'REVOKED' }), session({ id: 'ses_2' })] }],
    ['an out-of-scope student', { scope: { universityId: 'uni_1', facultyId: 'fac_other', departmentId: 'dep_1' } }],
    ['no academic profile', { scope: null }],
    ['the storefront off', { storefront: false }],
    ['an unpublished part', { part: { status: ContentStatus.HIDDEN } }],
    ['an inactive part', { part: { isActive: false } }],
    ['an unpublished material', { material: { status: ContentStatus.HIDDEN } }],
    ['an inactive material', { material: { isActive: false } }],
    ['a deleted material', { material: { deletedAt: new Date() } }],
    ['a part that is not a preview', { isPreview: false }],
  ])('dead with %s', async (_name, o, bound = EXACT) => {
    await expect(livePreview(o, bound)).resolves.toEqual(DEAD);
  });

  it('a preview ticket never reads paid content: an owner\'s paid part is dead under libp_', async () => {
    await expect(livePreview({ isPreview: false, entitlement: { revokedAt: null } })).resolves.toEqual(DEAD);
  });
});

describe('the edge route recognises the Worker', () => {
  const state = (o: Options, probe: Record<string, unknown>, ticket = 'lib_part_1') =>
    build(o).service.edgeTicketState(ticket, { uid: USER, ...probe });
  const refused = async (p: Promise<unknown>) => {
    const error = await p.then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).code).toBe(ErrorCode.UNAUTHORIZED);
  };

  describe('hasValidEdgeSecret', () => {
    it.each<[string, unknown, string | null]>([
      ['no configured secret', SECRET, null],
      ['empty configured secret', '', ''],
      ['missing header', undefined, SECRET],
      ['empty header', '', SECRET],
      ['wrong header', 'x'.repeat(48), SECRET],
      ['wrong length', SECRET + 'x', SECRET],
      ['repeated header', [SECRET, SECRET], SECRET],
    ])('refuses: %s', (_name, provided, expected) => {
      expect(hasValidEdgeSecret(provided, expected)).toBe(false);
    });

    it('accepts the exact secret', () => {
      expect(hasValidEdgeSecret(SECRET, SECRET)).toBe(true);
    });
  });

  describe('once enforced', () => {
    const enforced = { enforce: true };

    it('a missing secret gets a 401 and no answer', async () => {
      await refused(state(enforced, EXACT));
    });

    it('a wrong secret gets a 401 and no answer', async () => {
      await refused(state(enforced, { ...EXACT, edgeSecret: 'wrong' }));
    });

    it('the previous Worker\'s probe is refused too: no permanent bypass', async () => {
      await refused(state(enforced, {}));
    });

    it('applies to every ticket type', async () => {
      await refused(state(enforced, EXACT, 'libp_part_1'));
      await refused(state(enforced, {}, 'att_a1'));
      await refused(state(enforced, {}, 'ckvideoticket1'));
    });

    it('the correct secret gets the exact-binding answer', async () => {
      await expect(state(enforced, { ...EXACT, edgeSecret: SECRET })).resolves.toEqual(LIVE);
      await expect(
        state({ ...enforced, sessions: [session({ status: 'REVOKED' })] }, { ...EXACT, edgeSecret: SECRET }),
      ).resolves.toEqual(DEAD);
    });
  });

  describe('during the rollout, before enforcement', () => {
    it('the previous Worker (no secret, no identifiers) gets the account-wide answer', async () => {
      await expect(state({}, {})).resolves.toEqual(LIVE);
      await expect(state({ sessions: [] }, {})).resolves.toEqual(DEAD);
      await expect(state({ entitlement: { revokedAt: new Date() } }, {})).resolves.toEqual(DEAD);
    });

    it('the previous Worker keeps a preview working', async () => {
      await expect(state({ isPreview: true, entitlement: null }, {}, 'libp_part_1')).resolves.toEqual(LIVE);
      await expect(state({ isPreview: true, entitlement: null, sessions: [] }, {}, 'libp_part_1')).resolves.toEqual(DEAD);
    });

    it('the allowance does not reach an authenticated probe: missing identifiers are refused', async () => {
      await expect(state({}, { edgeSecret: SECRET })).resolves.toEqual(DEAD);
      await expect(state({ isPreview: true, entitlement: null }, { edgeSecret: SECRET }, 'libp_part_1')).resolves.toEqual(DEAD);
    });

    it('the allowance does not reach a probe naming a session: it is held to it', async () => {
      await expect(
        state({ sessions: [session({ status: 'REVOKED' }), session({ id: 'ses_2' })] }, EXACT),
      ).resolves.toEqual(DEAD);
    });

    it('an empty identifier is the new Worker reading an unbound URL, not the previous Worker', async () => {
      await expect(state({}, { sid: '', did: '' })).resolves.toEqual(DEAD);
    });
  });

  it('a non-string uid is treated as absent', async () => {
    await expect(state({}, { ...EXACT, uid: [USER] })).resolves.toEqual(DEAD);
  });

  it('a video ticket is answered from its own row, unchanged', async () => {
    const { service, prisma } = build();
    await expect(service.edgeTicketState('ckvideoticket1', { uid: USER })).resolves.toEqual(DEAD);
    expect(prisma.playbackTicket.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.session.findFirst).not.toHaveBeenCalled();
  });
});
