import type { INestApplication } from '@nestjs/common';
import { AccountStatus, PrismaClient, UserRole } from '@prisma/client';

import {
  API,
  TEST_PASSWORD,
  bootstrapTestApp,
  createUser,
  errorCode,
  http,
  login,
  resetDatabase,
  shutdownTestApp,
} from './helpers';

/**
 * Authentication end to end.
 *
 * The cases that matter are the ones where a plausible implementation is
 * subtly wrong: enumeration through timing or error text, refresh tokens that
 * survive rotation, and sessions that outlive a password change.
 */

describe('auth', () => {
  let app: INestApplication;
  let prisma: PrismaClient;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
  });

  afterAll(async () => {
    await shutdownTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  describe('POST /auth/register', () => {
    /**
     * Exactly the fields RegisterDto declares — no more, no less.
     *
     * `whitelist: true` + `forbidNonWhitelisted: true` means an extra property
     * is a 400, not a silently-ignored field. An earlier draft of this test
     * sent `confirmPassword` (which the DTO does not have, because the mobile
     * app confirms client-side) and omitted the academic ids, and would have
     * failed on both counts.
     */
    let catalog: {
      universityId: string;
      facultyId: string;
      departmentId: string;
      academicYearId: string;
    };

    beforeEach(async () => {
      const university = await prisma.university.create({
        data: { name: 'Cairo University', nameAr: 'جامعة القاهرة', code: 'CU' },
      });
      const faculty = await prisma.faculty.create({
        data: { universityId: university.id, name: 'Engineering', nameAr: 'الهندسة' },
      });
      const department = await prisma.department.create({
        data: { facultyId: faculty.id, name: 'Computer', nameAr: 'حاسبات' },
      });
      const year = await prisma.academicYear.create({
        data: { order: 2, name: 'Second Year', nameAr: 'الفرقة الثانية' },
      });
      catalog = {
        universityId: university.id,
        facultyId: faculty.id,
        departmentId: department.id,
        academicYearId: year.id,
      };
    });

    const base = {
      fullName: 'Youssef Ahmed Mahmoud Salem',
      phone: '01099887766',
      password: TEST_PASSWORD,
      gender: 'MALE',
    };
    const valid = () => ({ ...base, ...catalog });

    it('creates a student and returns tokens', async () => {
      const response = await http(app)
        .post(`${API}/auth/register`)
        .set('X-Device-Id', 'reg-device')
        .send(valid())
        .expect(201);

      const data = response.body.data ?? response.body;
      expect(data.user.role).toBe(UserRole.STUDENT);
      expect(data.accessToken).toBeTruthy();
    });

    it('never returns the password hash', async () => {
      const response = await http(app)
        .post(`${API}/auth/register`)
        .set('X-Device-Id', 'reg-device')
        .send(valid());

      expect(JSON.stringify(response.body)).not.toContain('$argon2');
      expect(JSON.stringify(response.body)).not.toContain('passwordHash');
    });

    it('accepts a four-part name', async () => {
      // Spec §11 requires three-part-or-longer names to work. A naive
      // "first + last" validator breaks the majority of Egyptian legal names.
      await http(app)
        .post(`${API}/auth/register`)
        .set('X-Device-Id', 'reg-device')
        .send({ ...valid(), fullName: 'Youssef Ahmed Mahmoud Salem El-Sayed' })
        .expect(201);
    });

    it('rejects an unknown property outright rather than ignoring it', async () => {
      // The DTO has no `confirmPassword` — the app confirms client-side. An
      // unrecognised field is refused, which is the same mechanism that stops
      // `role: "MASTER"` riding along on a registration.
      const response = await http(app)
        .post(`${API}/auth/register`)
        .set('X-Device-Id', 'reg-device')
        .send({ ...valid(), confirmPassword: TEST_PASSWORD });

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    });

    it('rejects a two-part name', async () => {
      // Egyptian legal names are three parts or more; the DTO enforces it.
      const response = await http(app)
        .post(`${API}/auth/register`)
        .set('X-Device-Id', 'reg-device')
        .send({ ...valid(), fullName: 'Youssef Salem' })
        .expect(422);

      expect(errorCode(response.body)).toBe('VALIDATION_ERROR');
    });

    it('rejects a non-Egyptian phone number', async () => {
      const response = await http(app)
        .post(`${API}/auth/register`)
        .set('X-Device-Id', 'reg-device')
        .send({ ...valid(), phone: '+447700900000' })
        .expect(422);

      expect(errorCode(response.body)).toBe('VALIDATION_ERROR');
    });

    it('rejects a duplicate phone number', async () => {
      await createUser(prisma, { phone: '01099887766' });

      const response = await http(app)
        .post(`${API}/auth/register`)
        .set('X-Device-Id', 'reg-device')
        .send(valid());

      expect(errorCode(response.body)).toBe('PHONE_ALREADY_REGISTERED');
    });

    it('strips an attempt to self-assign a privileged role', async () => {
      // The validation pipe whitelists DTO fields; `role` is not one of them,
      // so this is rejected outright rather than silently ignored.
      const response = await http(app)
        .post(`${API}/auth/register`)
        .set('X-Device-Id', 'reg-device')
        .send({ ...valid(), role: 'MASTER' });

      expect(response.status).toBeGreaterThanOrEqual(400);

      const created = await prisma.user.findUnique({ where: { phone: base.phone } });
      expect(created?.role ?? UserRole.STUDENT).toBe(UserRole.STUDENT);
    });

    it('never creates a MASTER through any registration payload', async () => {
      await http(app)
        .post(`${API}/auth/register`)
        .set('X-Device-Id', 'reg-device')
        .send({ ...valid(), role: UserRole.MASTER });

      const masters = await prisma.user.count({ where: { role: UserRole.MASTER } });
      expect(masters).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------------------

  describe('POST /auth/login', () => {
    it('signs in an active student', async () => {
      const user = await createUser(prisma);
      const session = await login(app, user.phone);
      expect(session.accessToken).toBeTruthy();
    });

    it('returns the same error for a wrong password and an unknown phone', async () => {
      // Distinguishable errors turn the login endpoint into an account
      // enumeration oracle.
      const user = await createUser(prisma);

      const wrongPassword = await http(app)
        .post(`${API}/auth/login`)
        .set('X-Device-Id', 'd1')
        .send({ phone: user.phone, password: 'WrongPassword123!' });

      const unknownPhone = await http(app)
        .post(`${API}/auth/login`)
        .set('X-Device-Id', 'd1')
        .send({ phone: '01055554444', password: TEST_PASSWORD });

      expect(errorCode(wrongPassword.body)).toBe('INVALID_CREDENTIALS');
      expect(errorCode(unknownPhone.body)).toBe('INVALID_CREDENTIALS');
      expect(wrongPassword.status).toBe(unknownPhone.status);
    });

    it('refuses a disabled account with a distinct, actionable code', async () => {
      const user = await createUser(prisma, { status: AccountStatus.DISABLED });

      const response = await http(app)
        .post(`${API}/auth/login`)
        .set('X-Device-Id', 'd1')
        .send({ phone: user.phone, password: TEST_PASSWORD });

      expect(errorCode(response.body)).toBe('ACCOUNT_DISABLED');
    });

    /**
     * Spec §39/§40. A student with a new phone must still be able to sign in,
     * because the "request a device change" screen is behind authentication.
     * Only protected content is refused.
     */
    it('allows login from an unrecognised device', async () => {
      const user = await createUser(prisma);
      await login(app, user.phone, 'device-a');

      const second = await http(app)
        .post(`${API}/auth/login`)
        .set('X-Device-Id', 'device-b')
        .send({ phone: user.phone, password: TEST_PASSWORD });

      expect(second.status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  // Tokens
  // ---------------------------------------------------------------------------

  describe('POST /auth/refresh', () => {
    it('rotates the refresh token', async () => {
      const user = await createUser(prisma);
      const session = await login(app, user.phone);

      const response = await http(app)
        .post(`${API}/auth/refresh`)
        .set('X-Device-Id', 'test-device-key')
        .send({ refreshToken: session.refreshToken })
        .expect(200);

      const data = response.body.data ?? response.body;
      expect(data.refreshToken).not.toBe(session.refreshToken);
    });

    /**
     * Reuse detection. Presenting a refresh token that has already been
     * exchanged means either a replay or a stolen token; either way the whole
     * family is revoked, so the attacker and the victim are both signed out
     * and the victim notices.
     */
    it('revokes the whole family when a rotated token is replayed', async () => {
      const user = await createUser(prisma);
      const session = await login(app, user.phone);

      await http(app)
        .post(`${API}/auth/refresh`)
        .set('X-Device-Id', 'test-device-key')
        .send({ refreshToken: session.refreshToken })
        .expect(200);

      // Replay the original.
      const replay = await http(app)
        .post(`${API}/auth/refresh`)
        .set('X-Device-Id', 'test-device-key')
        .send({ refreshToken: session.refreshToken });

      expect(replay.status).toBe(401);

      const live = await prisma.session.count({
        where: { userId: user.id, status: 'ACTIVE' },
      });
      expect(live).toBe(0);
    });

    it('rejects a syntactically valid but unknown token', async () => {
      const response = await http(app)
        .post(`${API}/auth/refresh`)
        .set('X-Device-Id', 'd1')
        .send({ refreshToken: 'not.a.real.token' });

      expect(response.status).toBe(401);
    });
  });

  describe('access token checks on every request', () => {
    it('rejects a token whose session was revoked', async () => {
      const user = await createUser(prisma);
      const session = await login(app, user.phone);

      await prisma.session.updateMany({
        where: { userId: user.id },
        data: { status: 'REVOKED', revokedAt: new Date() },
      });

      // The token is still cryptographically valid; the session check is what
      // makes revocation take effect within one request.
      const response = await http(app).get(`${API}/profile`).set(session.headers);
      expect(response.status).toBe(401);
    });

    it('rejects a token issued before a password change', async () => {
      const user = await createUser(prisma);
      const session = await login(app, user.phone);

      await prisma.user.update({
        where: { id: user.id },
        data: { credentialsChangedAt: new Date(Date.now() + 1000) },
      });

      const response = await http(app).get(`${API}/profile`).set(session.headers);
      expect(response.status).toBe(401);
    });

    it('rejects a token for an account suspended mid-session', async () => {
      const user = await createUser(prisma);
      const session = await login(app, user.phone);

      await prisma.user.update({
        where: { id: user.id },
        data: { status: AccountStatus.SUSPENDED },
      });

      const response = await http(app).get(`${API}/profile`).set(session.headers);
      expect(response.status).toBeGreaterThanOrEqual(401);
    });
  });

  describe('POST /auth/logout', () => {
    it('ends the session so the access token stops working', async () => {
      const user = await createUser(prisma);
      const session = await login(app, user.phone);

      await http(app).post(`${API}/auth/logout`).set(session.headers).expect(200);

      const after = await http(app).get(`${API}/profile`).set(session.headers);
      expect(after.status).toBe(401);
    });
  });
});
