import type { INestApplication } from '@nestjs/common';
import { AuditAction, PrismaClient, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';

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
 * Student passwords are administered, never self-service — end to end.
 *
 * The whole request path: global guards, the validation pipe, the services
 * and a real database. The product rule is that a MASTER or ADMIN sets a
 * student's password after the student contacts support, and nothing else can
 * change it. Every case here is a way that rule could leak through a direct
 * API call even though no screen offers it.
 */

const NEW_PASSWORD = 'Granite7Harbor';

describe('student password administration', () => {
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

  async function staff(role: UserRole) {
    const user = await createUser(prisma, { role, fullName: `Test ${role} Account` });
    return { user, session: await login(app, user.phone, `device-${role}`) };
  }

  const hashOf = async (id: string) =>
    (await prisma.user.findUniqueOrThrow({ where: { id } })).passwordHash;

  const reset = (headers: Record<string, string>, userId: string, body: object) =>
    http(app).put(`${API}/admin/users/${userId}/password`).set(headers).send(body);

  // ---------------------------------------------------------------------------
  // Who may reset
  // ---------------------------------------------------------------------------

  describe('PUT /admin/users/:id/password', () => {
    it('lets MASTER reset a student, with every effect the policy promises', async () => {
      const { user: master, session: masterSession } = await staff(UserRole.MASTER);

      const student = await createUser(prisma);
      const studentSession = await login(app, student.phone, 'student-device');
      await prisma.user.update({
        where: { id: student.id },
        data: { failedLoginCount: 20, lockedUntil: new Date(Date.now() + 10 * 60_000) },
      });

      const response = await reset(masterSession.headers, student.id, {
        newPassword: NEW_PASSWORD,
        note: 'Identity checked by phone call',
      });

      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain(NEW_PASSWORD);
      expect(JSON.stringify(response.body)).not.toContain('$argon2');

      // argon2id, and not the password itself.
      const stored = await hashOf(student.id);
      expect(stored.startsWith('$argon2id$')).toBe(true);

      // Lockout cleared.
      const row = await prisma.user.findUniqueOrThrow({ where: { id: student.id } });
      expect(row.failedLoginCount).toBe(0);
      expect(row.lockedUntil).toBeNull();

      // The student's existing access and refresh tokens are dead.
      const me = await http(app).get(`${API}/auth/me`).set(studentSession.headers);
      expect(me.status).toBe(401);
      const refresh = await http(app)
        .post(`${API}/auth/refresh`)
        .set('X-Device-Id', 'student-device')
        .send({ refreshToken: studentSession.refreshToken });
      expect(refresh.status).toBe(401);
      expect(await prisma.refreshToken.count({ where: { userId: student.id, revokedAt: null } })).toBe(0);
      expect(await prisma.session.count({ where: { userId: student.id, status: 'ACTIVE' } })).toBe(0);

      // Old password refused, new one accepted.
      const old = await http(app)
        .post(`${API}/auth/login`)
        .send({ phone: student.phone, password: TEST_PASSWORD });
      expect(old.status).toBe(401);
      const fresh = await http(app)
        .post(`${API}/auth/login`)
        .set('X-Device-Id', 'student-device')
        .set('X-Device-Platform', 'ios')
        .send({ phone: student.phone, password: NEW_PASSWORD });
      expect(fresh.status).toBe(200);

      // Audited, naming the administrator and the note, without the password.
      const audit = await prisma.auditLog.findFirst({
        where: { action: AuditAction.PASSWORD_RESET, entityId: student.id },
      });
      expect(audit).not.toBeNull();
      expect(audit?.actorId).toBe(master.id);
      expect(audit?.note).toBe('Identity checked by phone call');
      expect(JSON.stringify(audit)).not.toContain(NEW_PASSWORD);
    });

    it('lets ADMIN reset a student', async () => {
      const { user: admin, session } = await staff(UserRole.ADMIN);
      const student = await createUser(prisma);
      const before = await hashOf(student.id);

      const response = await reset(session.headers, student.id, { newPassword: NEW_PASSWORD });

      expect(response.status).toBe(200);
      expect(await hashOf(student.id)).not.toBe(before);
      const audit = await prisma.auditLog.findFirst({
        where: { action: AuditAction.PASSWORD_RESET, entityId: student.id },
      });
      expect(audit?.actorId).toBe(admin.id);
    });

    it('answers a TEACHER 403 and changes nothing', async () => {
      const { session } = await staff(UserRole.TEACHER);
      const student = await createUser(prisma);
      const before = await hashOf(student.id);

      const response = await reset(session.headers, student.id, { newPassword: NEW_PASSWORD });

      expect(response.status).toBe(403);
      expect(errorCode(response.body)).toBe('INSUFFICIENT_ROLE');
      expect(await hashOf(student.id)).toBe(before);
    });

    it('answers a STUDENT 403, for another account and for their own', async () => {
      const student = await createUser(prisma);
      const other = await createUser(prisma);
      const session = await login(app, student.phone);
      const ownBefore = await hashOf(student.id);
      const otherBefore = await hashOf(other.id);

      for (const target of [other.id, student.id]) {
        const response = await reset(session.headers, target, { newPassword: NEW_PASSWORD });
        expect(response.status).toBe(403);
        expect(errorCode(response.body)).toBe('INSUFFICIENT_ROLE');
      }
      expect(await hashOf(student.id)).toBe(ownBefore);
      expect(await hashOf(other.id)).toBe(otherBefore);
    });

    it('refuses to reset the master account, for an ADMIN and for the MASTER', async () => {
      const { user: master, session: masterSession } = await staff(UserRole.MASTER);
      const { session: adminSession } = await staff(UserRole.ADMIN);
      const before = await hashOf(master.id);

      for (const headers of [adminSession.headers, masterSession.headers]) {
        const response = await reset(headers, master.id, { newPassword: NEW_PASSWORD });
        expect(response.status).toBe(403);
        expect(errorCode(response.body)).toBe('CANNOT_MODIFY_MASTER');
      }
      expect(await hashOf(master.id)).toBe(before);
    });

    it.each([
      ['shorter than 8 characters', 'Ab1cdef'],
      ['missing a digit', 'GraniteHarbor'],
      ['an obvious pattern', 'Aa123456'],
      ['all digits', '12345678'],
    ])('rejects a password %s with 422 and changes nothing', async (_label, newPassword) => {
      const { session } = await staff(UserRole.ADMIN);
      const student = await createUser(prisma);
      const before = await hashOf(student.id);

      const response = await reset(session.headers, student.id, { newPassword });

      expect(response.status).toBe(422);
      expect(errorCode(response.body)).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(response.body)).toContain('newPassword');
      expect(JSON.stringify(response.body)).not.toContain(newPassword);
      expect(await hashOf(student.id)).toBe(before);
    });

    it('takes no confirmation field: the dashboard checks it and does not send it', async () => {
      const { session } = await staff(UserRole.ADMIN);
      const student = await createUser(prisma);

      const response = await reset(session.headers, student.id, {
        newPassword: NEW_PASSWORD,
        confirmPassword: NEW_PASSWORD,
      });

      expect(response.status).toBe(422);
    });
  });

  // ---------------------------------------------------------------------------
  // No student self-service
  // ---------------------------------------------------------------------------

  describe('a student has no way to set their own password', () => {
    it('POST /auth/password answers a student 403 and leaves the account alone', async () => {
      const student = await createUser(prisma);
      const session = await login(app, student.phone);
      const before = await hashOf(student.id);

      const response = await http(app)
        .post(`${API}/auth/password`)
        .set(session.headers)
        .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

      expect(response.status).toBe(403);
      expect(errorCode(response.body)).toBe('INSUFFICIENT_ROLE');
      expect(await hashOf(student.id)).toBe(before);

      // Refused without side effects: the session still works.
      const me = await http(app).get(`${API}/auth/me`).set(session.headers);
      expect(me.status).toBe(200);
    });

    it('a wrong current password gets the same 403, so the route cannot test guesses', async () => {
      const student = await createUser(prisma);
      const session = await login(app, student.phone);

      const response = await http(app)
        .post(`${API}/auth/password`)
        .set(session.headers)
        .send({ currentPassword: 'Wrong1Guess', newPassword: NEW_PASSWORD });

      expect(response.status).toBe(403);
    });

    it.each([
      ['PUT', '/profile/password'],
      ['POST', '/profile/password'],
      ['POST', '/auth/forgot-password'],
      ['POST', '/auth/reset-password'],
      ['POST', '/auth/password/reset'],
      ['POST', '/auth/otp'],
      ['POST', '/auth/verify-otp'],
    ])('%s %s does not exist', async (method, path) => {
      const student = await createUser(prisma);
      const session = await login(app, student.phone);
      const before = await hashOf(student.id);

      const agent = http(app);
      const call = method === 'PUT' ? agent.put(`${API}${path}`) : agent.post(`${API}${path}`);
      const response = await call
        .set(session.headers)
        .send({ phone: student.phone, currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

      expect(response.status).toBe(404);
      expect(await hashOf(student.id)).toBe(before);
    });

    it('PATCH /profile cannot carry a password', async () => {
      const student = await createUser(prisma);
      const session = await login(app, student.phone);
      const before = await hashOf(student.id);

      const response = await http(app)
        .patch(`${API}/profile`)
        .set(session.headers)
        .send({ password: NEW_PASSWORD });

      expect(response.status).toBe(422);
      expect(await hashOf(student.id)).toBe(before);
    });
  });

  describe('existing passwords', () => {
    it('one that predates the policy still signs in', async () => {
      const student = await createUser(prisma);
      // 'aaaaaaaa' breaks every new-password rule; set it as an older account
      // would have it, straight into the hash, never through the API.
      const legacy = 'aaaaaaaa';
      await prisma.user.update({
        where: { id: student.id },
        data: {
          passwordHash: await argon2.hash(legacy, {
            type: argon2.argon2id,
            memoryCost: 8192,
            timeCost: 2,
            parallelism: 1,
          }),
        },
      });

      const response = await http(app)
        .post(`${API}/auth/login`)
        .set('X-Device-Id', 'legacy-device')
        .set('X-Device-Platform', 'ios')
        .send({ phone: student.phone, password: legacy });

      expect(response.status).toBe(200);
    });
  });

  describe('staff keep their own self-change', () => {
    it('a TEACHER can still change their own password', async () => {
      const { user, session } = await staff(UserRole.TEACHER);
      const before = await hashOf(user.id);

      const response = await http(app)
        .post(`${API}/auth/password`)
        .set(session.headers)
        .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

      expect(response.status).toBe(200);
      expect(await hashOf(user.id)).not.toBe(before);
    });
  });
});
