import { ValidationPipe } from '@nestjs/common';

import { RegisterDto } from '../../src/modules/auth/dto/register.dto';

/**
 * Owner decision D1: students do NOT choose GENERAL / PROGRAMS at registration.
 * The academic system is the college's configuration; `studyType` survives only
 * as an optional legacy field for older app builds.
 *
 * The payload below is exactly what the mobile app's `RegisterPayload`
 * (`mobile-app-student/src/features/auth/api.ts`) sends. The pipe options are
 * the API's own (`main.ts`): whitelist + forbidNonWhitelisted + transform.
 */
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const validate = (value: Record<string, unknown>) =>
  pipe.transform(value, { type: 'body', metatype: RegisterDto });

const mobilePayload = {
  fullName: 'Ahmed Mohamed Ali',
  phone: '01001234567',
  password: 'Str0ngPass',
  universityId: 'uni_1',
  facultyId: 'fac_1',
  departmentId: 'dep_1',
  academicYearId: 'yr_1',
  gender: 'MALE',
};

describe('RegisterDto contract (D1)', () => {
  it('accepts the current mobile payload, which carries no study type', async () => {
    const dto = (await validate(mobilePayload)) as RegisterDto;
    expect(dto.studyType).toBeUndefined();
    expect(dto.departmentId).toBe('dep_1');
  });

  it('still accepts an older client that sends a study type (backward compatibility)', async () => {
    await expect(validate({ ...mobilePayload, studyType: 'PROGRAMS' })).resolves.toBeDefined();
  });

  it('rejects a study type outside the legacy vocabulary', async () => {
    await expect(validate({ ...mobilePayload, studyType: 'ANYTHING' })).rejects.toBeDefined();
  });

  it.each(['universityId', 'facultyId', 'departmentId', 'academicYearId'])(
    'requires %s - the server, not the client, decides the academic system from it',
    async (field) => {
      const { [field]: _omitted, ...rest } = mobilePayload as Record<string, unknown>;
      await expect(validate(rest)).rejects.toBeDefined();
    },
  );

  it('rejects a client-declared academic system', async () => {
    await expect(validate({ ...mobilePayload, academicSystem: 'LEVEL' })).rejects.toBeDefined();
  });
});
