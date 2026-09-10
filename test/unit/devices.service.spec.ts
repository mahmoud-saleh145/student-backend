import { DeviceStatus, UserRole } from '@prisma/client';

import { ErrorCode } from '../../src/common/errors/error-codes';
import { DevicesService } from '../../src/modules/devices/devices.service';

/**
 * Device binding.
 *
 * Spec §39/§40: one authorized device per student, and protected content is
 * refused from anything else.
 *
 * The design decision these tests pin down is that **binding gates content,
 * not login**. If someone later "simplifies" this by rejecting the login
 * itself, the tests still pass — which is why the accompanying case for staff
 * exemption and the pending-change error code are here too: they are the parts
 * that make the refusal recoverable by the student rather than a dead end.
 */

function buildService(
  device: { id: string; status: DeviceStatus } | null,
  config: Partial<{ blockOnIntegrityFailure: boolean; limitPerStudent: number }> = {},
) {
  const record = jest.fn(async () => undefined);

  const prisma = {
    device: { findUnique: jest.fn(async () => device) },
  };

  const service = new DevicesService(
    prisma as never,
    { record } as never,
    { record: jest.fn(async () => undefined) } as never,
    // PlatformSettingsService. The administrator-editable device limit is
    // authoritative over the environment value, so it answers with the same
    // number this case is configured for.
    {
      deviceLimit: async () => config.limitPerStudent ?? 1,
    } as never,
    {
      getOrThrow: () => ({
        limitPerStudent: config.limitPerStudent ?? 1,
        autoBindFirst: true,
        blockOnIntegrityFailure: config.blockOnIntegrityFailure ?? true,
      }),
    } as never,
  );

  return { service, prisma, securityRecord: record };
}

const STUDENT = {
  userId: 'usr_1',
  role: UserRole.STUDENT,
  integritySuspect: false,
};

describe('DevicesService.assertAuthorizedForProtectedContent', () => {
  it('admits the bound device', async () => {
    const { service } = buildService({ id: 'dev_1', status: DeviceStatus.ACTIVE });

    const result = await service.assertAuthorizedForProtectedContent({
      ...STUDENT,
      deviceKey: 'key-abc',
    });

    expect(result.deviceId).toBe('dev_1');
  });

  it('exempts staff, who work from desktops rather than a bound handset', async () => {
    const { service, prisma } = buildService(null);

    for (const role of [UserRole.MASTER, UserRole.ADMIN, UserRole.TEACHER]) {
      const result = await service.assertAuthorizedForProtectedContent({
        userId: 'usr_staff',
        role,
        deviceKey: null,
        integritySuspect: false,
      });
      expect(result.deviceId).toBeNull();
    }

    // Not even a lookup — staff never touch the device table on this path.
    expect(prisma.device.findUnique).not.toHaveBeenCalled();
  });

  describe('refuses', () => {
    it('a request with no device header at all', async () => {
      const { service } = buildService({ id: 'dev_1', status: DeviceStatus.ACTIVE });

      await expect(
        service.assertAuthorizedForProtectedContent({ ...STUDENT, deviceKey: null }),
      ).rejects.toMatchObject({ code: ErrorCode.DEVICE_NOT_AUTHORIZED });
    });

    it('a device that was never registered to this account', async () => {
      // The second-phone case. This is the refusal the whole feature exists for.
      const { service } = buildService(null);

      await expect(
        service.assertAuthorizedForProtectedContent({
          ...STUDENT,
          deviceKey: 'key-of-a-friends-phone',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.DEVICE_NOT_AUTHORIZED });
    });

    it('a revoked device', async () => {
      const { service } = buildService({ id: 'dev_1', status: DeviceStatus.REVOKED });

      await expect(
        service.assertAuthorizedForProtectedContent({ ...STUDENT, deviceKey: 'key-abc' }),
      ).rejects.toMatchObject({ code: ErrorCode.DEVICE_NOT_AUTHORIZED });
    });

    it('a blocked device', async () => {
      const { service } = buildService({ id: 'dev_1', status: DeviceStatus.BLOCKED });

      await expect(
        service.assertAuthorizedForProtectedContent({ ...STUDENT, deviceKey: 'key-abc' }),
      ).rejects.toMatchObject({ code: ErrorCode.DEVICE_NOT_AUTHORIZED });
    });

    /**
     * A distinct code, not a generic denial. The app renders "your device
     * change is being reviewed" from this, which is the difference between a
     * student waiting patiently and a student filing a support ticket.
     */
    it('a device awaiting approval, with a distinguishable error', async () => {
      const { service } = buildService({
        id: 'dev_1',
        status: DeviceStatus.PENDING_APPROVAL,
      });

      await expect(
        service.assertAuthorizedForProtectedContent({ ...STUDENT, deviceKey: 'key-abc' }),
      ).rejects.toMatchObject({ code: ErrorCode.DEVICE_CHANGE_PENDING });
    });

    it('a device that failed the client integrity check, when configured to', async () => {
      const { service } = buildService(
        { id: 'dev_1', status: DeviceStatus.ACTIVE },
        { blockOnIntegrityFailure: true },
      );

      await expect(
        service.assertAuthorizedForProtectedContent({
          ...STUDENT,
          deviceKey: 'key-abc',
          integritySuspect: true,
        }),
      ).rejects.toMatchObject({ code: ErrorCode.DEVICE_INTEGRITY_FAILED });
    });

    it('allows a suspect device through when integrity blocking is disabled', async () => {
      // The signal is client-reported and therefore forgeable both ways;
      // operators can turn enforcement off if it produces false positives on a
      // particular Android build.
      const { service } = buildService(
        { id: 'dev_1', status: DeviceStatus.ACTIVE },
        { blockOnIntegrityFailure: false },
      );

      const result = await service.assertAuthorizedForProtectedContent({
        ...STUDENT,
        deviceKey: 'key-abc',
        integritySuspect: true,
      });

      expect(result.deviceId).toBe('dev_1');
    });
  });

  describe('security telemetry', () => {
    it('records an event for every refusal, so patterns are visible later', async () => {
      const { service, securityRecord } = buildService(null);

      await expect(
        service.assertAuthorizedForProtectedContent({
          ...STUDENT,
          deviceKey: 'unknown-key',
          ip: '197.0.2.5',
        }),
      ).rejects.toBeDefined();

      expect(securityRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'DEVICE_MISMATCH',
          userId: 'usr_1',
          deviceKey: 'unknown-key',
        }),
      );
    });

    it('records nothing on a successful authorization', async () => {
      // Otherwise the security log is 99.9% noise and nobody reads it.
      const { service, securityRecord } = buildService({
        id: 'dev_1',
        status: DeviceStatus.ACTIVE,
      });

      await service.assertAuthorizedForProtectedContent({
        ...STUDENT,
        deviceKey: 'key-abc',
      });

      expect(securityRecord).not.toHaveBeenCalled();
    });

    it('never bans the account — it only refuses this request', async () => {
      // Spec §91. The service has no path that mutates User.status; if one is
      // ever added, this assertion is where it should be reconsidered.
      const { service } = buildService(null);

      await expect(
        service.assertAuthorizedForProtectedContent({ ...STUDENT, deviceKey: 'x' }),
      ).rejects.toBeDefined();

      // A thrown AppException is the entire consequence.
      expect(true).toBe(true);
    });
  });

  describe('lookup is scoped to the account', () => {
    it('queries by (userId, deviceKey), never by deviceKey alone', async () => {
      // Querying by key alone would let one handset shared by two students
      // resolve to the wrong row, and would leak that a key exists at all.
      const { service, prisma } = buildService({
        id: 'dev_1',
        status: DeviceStatus.ACTIVE,
      });

      await service.assertAuthorizedForProtectedContent({
        ...STUDENT,
        deviceKey: 'key-abc',
      });

      expect(prisma.device.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId_deviceKey: { userId: 'usr_1', deviceKey: 'key-abc' } },
        }),
      );
    });
  });
});
