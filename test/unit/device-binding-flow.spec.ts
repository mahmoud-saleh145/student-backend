import { DeviceChangeStatus, DeviceStatus, UserRole } from '@prisma/client';

import { DevicesService } from '../../src/modules/devices/devices.service';

/**
 * The device-binding round trip.
 *
 * Two defects made the documented workflow impossible, and both are pinned
 * here because both were invisible from any single layer:
 *
 *   1. A device parked `PENDING_APPROVAL` by `handleUnknownDevice` had no
 *      `DeviceChangeRequest`. The gate told the student a review was under
 *      way; `listChangeRequests` reads a different table, so the dashboard had
 *      nothing to approve. An unapprovable pending state is a dead end.
 *
 *   2. `resetBinding` marked rows REVOKED and kept them. `resolveOnLogin`
 *      finds a device by `(userId, deviceKey)` whatever its status, so the
 *      same handset went down `handleKnownDevice` — which has no path back to
 *      ACTIVE — and could never re-bind. Auto-binding lives only in
 *      `handleUnknownDevice`, reached only when no row exists.
 *
 * The last test is the one that ties the layers together: login and the
 * protected-content gate must look the device up by the same identity, or
 * every other guarantee here is about two different devices.
 */

const STUDENT_ID = 'usr_student';
const DEVICE_KEY = 'dk_phone_one';

type DeviceRow = {
  id: string;
  userId: string;
  deviceKey: string;
  name: string;
  status: DeviceStatus;
};

interface Options {
  /** The row `findUnique` should answer with, or null for an unknown device. */
  existing?: DeviceRow | null;
  /** How many ACTIVE devices the account already has. */
  activeCount?: number;
  deviceLimit?: number;
  autoBindFirst?: boolean;
  pendingRequest?: { id: string; reason: string | null } | null;
}

function build(options: Options = {}) {
  const created: DeviceRow = {
    id: 'dev_new',
    userId: STUDENT_ID,
    deviceKey: DEVICE_KEY,
    name: 'Test phone',
    status: DeviceStatus.ACTIVE,
  };

  // Every mock names its parameters: a zero-arity `jest.fn(async () => …)`
  // infers an empty parameter tuple, which makes `mock.calls[0][0]` a type
  // error under `strict`.
  const findUnique = jest.fn(
    async (_args: { where: { userId_deviceKey: { userId: string; deviceKey: string } } }) =>
      options.existing === undefined ? null : options.existing,
  );
  const deviceCreate = jest.fn(async (args: { data: Record<string, unknown> }) => ({
    ...created,
    status: args.data.status as DeviceStatus,
  }));
  const deviceUpdate = jest.fn(async (_args: { where: unknown; data: unknown }) => created);
  const deviceCount = jest.fn(async (_args: { where: unknown }) => options.activeCount ?? 0);
  const deviceDeleteMany = jest.fn(async (_args: { where: { userId: string } }) => ({
    count: 2,
  }));
  const deviceUpdateMany = jest.fn(async (_args: { where: unknown; data: unknown }) => ({
    count: 0,
  }));

  const requestFindFirst = jest.fn(async (_args: { where: unknown }) =>
    options.pendingRequest ?? null,
  );
  const requestCreate = jest.fn(async (args: { data: Record<string, unknown> }) => ({
    id: 'req_new',
    status: DeviceChangeStatus.PENDING,
    ...args.data,
  }));
  const requestUpdate = jest.fn(async (args: { where: unknown; data: unknown }) => ({
    id: 'req_existing',
    status: DeviceChangeStatus.PENDING,
    ...(args.data as Record<string, unknown>),
  }));
  const requestUpdateMany = jest.fn(async (_args: { where: unknown; data: unknown }) => ({
    count: 1,
  }));

  const sessionUpdateMany = jest.fn(async (_args: { where: unknown; data: unknown }) => ({
    count: 3,
  }));

  // Only the array form is modelled. The callback form would have to hand the
  // callback a client, which means referencing `prisma` inside its own
  // initialiser — a circular type under `noImplicitAny`.
  const prisma = {
    device: {
      findUnique,
      create: deviceCreate,
      update: deviceUpdate,
      count: deviceCount,
      deleteMany: deviceDeleteMany,
      updateMany: deviceUpdateMany,
    },
    deviceChangeRequest: {
      findFirst: requestFindFirst,
      create: requestCreate,
      update: requestUpdate,
      updateMany: requestUpdateMany,
    },
    session: { updateMany: sessionUpdateMany },
    $transaction: jest.fn(async (operations: readonly unknown[]) => Promise.all(operations)),
  };

  const security = { record: jest.fn(async (_event: Record<string, unknown>) => undefined) };
  const audit = { record: jest.fn(async (_entry: Record<string, unknown>) => undefined) };
  const settings = { deviceLimit: jest.fn(async () => options.deviceLimit ?? 1) };
  const config = {
    getOrThrow: () => ({
      autoBindFirst: options.autoBindFirst ?? true,
      blockOnIntegrityFailure: false,
    }),
  };

  const service = new DevicesService(
    prisma as never,
    security as never,
    audit as never,
    settings as never,
    config as never,
  );

  return {
    service,
    findUnique,
    deviceCreate,
    deviceDeleteMany,
    requestCreate,
    requestUpdate,
    requestUpdateMany,
    sessionUpdateMany,
    audit,
  };
}

function deviceContext(deviceKey: string | null = DEVICE_KEY) {
  return {
    deviceKey,
    platform: 'android',
    model: 'Pixel 7',
    name: 'Test phone',
    osVersion: '14',
    appVersion: '1.0.0',
    appBuild: '1',
    integritySuspect: false,
  };
}

const ADMIN = { id: 'usr_admin', role: UserRole.ADMIN };

describe('resetting a binding frees the handset', () => {
  it('deletes the rows rather than leaving them revoked', async () => {
    // Marking them REVOKED is what made the binding permanently stuck: a
    // surviving row sends the next sign-in down `handleKnownDevice`, which
    // never returns a device to ACTIVE.
    const { service, deviceDeleteMany } = build();

    await service.resetBinding(STUDENT_ID, ADMIN, 'student changed phones');

    const call = deviceDeleteMany.mock.calls[0];
    if (!call) throw new Error('device.deleteMany was never called');
    expect(call[0].where.userId).toBe(STUDENT_ID);
  });

  it('cancels any outstanding change request', async () => {
    // A request for a binding that no longer exists is not a decision an
    // administrator can still make, and leaving it pending would have the next
    // sign-in re-point the stale row instead of opening a fresh one.
    const { service, requestUpdateMany } = build();

    await service.resetBinding(STUDENT_ID, ADMIN, 'reset');

    const call = requestUpdateMany.mock.calls[0];
    if (!call) throw new Error('deviceChangeRequest.updateMany was never called');

    const where = call[0].where as { userId: string; status: DeviceChangeStatus };
    const data = call[0].data as { status: DeviceChangeStatus };
    expect(where.status).toBe(DeviceChangeStatus.PENDING);
    expect(data.status).toBe(DeviceChangeStatus.CANCELLED);
  });

  it('revokes the live sessions too', async () => {
    const { service, sessionUpdateMany } = build();
    await service.resetBinding(STUDENT_ID, ADMIN, 'reset');
    expect(sessionUpdateMany).toHaveBeenCalled();
  });

  it('the next sign-in from the same handset binds it ACTIVE', async () => {
    // The row is gone, so this is genuinely an unknown device: it takes the
    // auto-bind path under the ordinary limit rule. This is the exact sequence
    // that used to dead-end.
    const { service, deviceCreate } = build({
      existing: null,
      activeCount: 0,
      deviceLimit: 1,
      autoBindFirst: true,
    });

    const result = await service.resolveOnLogin(
      STUDENT_ID,
      UserRole.STUDENT,
      deviceContext(),
      {},
    );

    expect(result.authorized).toBe(true);
    expect(result.registered).toBe(true);

    const call = deviceCreate.mock.calls[0];
    if (!call) throw new Error('device.create was never called');
    expect(call[0].data.status).toBe(DeviceStatus.ACTIVE);
  });
});

describe('a device over the limit', () => {
  it('is parked pending AND gets a request an admin can see', async () => {
    // The pending status alone was the dead end: the gate reported
    // DEVICE_CHANGE_PENDING while `listChangeRequests` — which reads
    // `deviceChangeRequest` — had nothing to show.
    const { service, deviceCreate, requestCreate } = build({
      existing: null,
      activeCount: 1,
      deviceLimit: 1,
    });

    const result = await service.resolveOnLogin(
      STUDENT_ID,
      UserRole.STUDENT,
      deviceContext('dk_phone_two'),
      {},
    );

    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('limit-reached');

    const device = deviceCreate.mock.calls[0];
    if (!device) throw new Error('device.create was never called');
    expect(device[0].data.status).toBe(DeviceStatus.PENDING_APPROVAL);

    // The part that was missing entirely.
    const request = requestCreate.mock.calls[0];
    if (!request) throw new Error('no change request was created for a pending device');
    expect(request[0].data.userId).toBe(STUDENT_ID);
    expect(request[0].data.requestedDeviceId).toBe('dev_new');
  });

  it('does not pile up duplicate requests for the same student', async () => {
    // The blocked handset keeps signing in and keeps landing here; one row per
    // decision, re-pointed at the newest device.
    const { service, requestCreate, requestUpdate } = build({
      existing: null,
      activeCount: 1,
      deviceLimit: 1,
      pendingRequest: { id: 'req_existing', reason: 'earlier attempt' },
    });

    await service.resolveOnLogin(STUDENT_ID, UserRole.STUDENT, deviceContext('dk_three'), {});

    expect(requestCreate).not.toHaveBeenCalled();
    const call = requestUpdate.mock.calls[0];
    if (!call) throw new Error('the existing request was not re-pointed');
    expect((call[0].data as { requestedDeviceId: string }).requestedDeviceId).toBe('dev_new');
  });
});

describe('the protected-content gate', () => {
  it('refuses a pending device with DEVICE_CHANGE_PENDING', async () => {
    const { service } = build({
      existing: {
        id: 'dev_1',
        userId: STUDENT_ID,
        deviceKey: DEVICE_KEY,
        name: 'Test phone',
        status: DeviceStatus.PENDING_APPROVAL,
      },
    });

    await expect(
      service.assertAuthorizedForProtectedContent({
        userId: STUDENT_ID,
        role: UserRole.STUDENT,
        deviceKey: DEVICE_KEY,
        integritySuspect: false,
      }),
    ).rejects.toMatchObject({ code: 'DEVICE_CHANGE_PENDING' });
  });

  it('lets an approved device through', async () => {
    const { service } = build({
      existing: {
        id: 'dev_1',
        userId: STUDENT_ID,
        deviceKey: DEVICE_KEY,
        name: 'Test phone',
        status: DeviceStatus.ACTIVE,
      },
    });

    await expect(
      service.assertAuthorizedForProtectedContent({
        userId: STUDENT_ID,
        role: UserRole.STUDENT,
        deviceKey: DEVICE_KEY,
        integritySuspect: false,
      }),
    ).resolves.toEqual({ deviceId: 'dev_1' });
  });

  it('identifies the device exactly as login does', async () => {
    // If these two read different identities, every other guarantee here is
    // about two different devices. Both must key on (userId, deviceKey).
    const active: DeviceRow = {
      id: 'dev_1',
      userId: STUDENT_ID,
      deviceKey: DEVICE_KEY,
      name: 'Test phone',
      status: DeviceStatus.ACTIVE,
    };

    const login = build({ existing: active });
    await login.service.resolveOnLogin(
      STUDENT_ID,
      UserRole.STUDENT,
      deviceContext(DEVICE_KEY),
      {},
    );
    const loginCall = login.findUnique.mock.calls[0];
    if (!loginCall) throw new Error('login did not look the device up');

    const gate = build({ existing: active });
    await gate.service.assertAuthorizedForProtectedContent({
      userId: STUDENT_ID,
      role: UserRole.STUDENT,
      deviceKey: DEVICE_KEY,
      integritySuspect: false,
    });
    const gateCall = gate.findUnique.mock.calls[0];
    if (!gateCall) throw new Error('the gate did not look the device up');

    expect(gateCall[0].where.userId_deviceKey).toEqual(loginCall[0].where.userId_deviceKey);
  });
});
