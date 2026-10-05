import { AccountStatus, NotificationKind, UserRole } from '@prisma/client';

import { NotificationsService } from '../../src/modules/notifications/notifications.service';

/**
 * Messaging one student directly.
 *
 * This route bypasses the audience compiler entirely: it takes a single user id
 * and sends. That makes it the one path where nothing else decides who is
 * reachable, so the eligibility check has to be complete on its own — a guard
 * that filters role and deletion but forgets account status is invisible, and it
 * is exactly the kind of omission that only shows up as a message delivered to
 * somebody the platform had already decided to stop delivering to.
 *
 * Broadcasts get this for free from `compileAudience`; this route does not.
 */

type StoredUser = {
  id: string;
  role: UserRole;
  status: AccountStatus;
  deletedAt: Date | null;
};

const ACTOR = { id: 'tch_1' };

function build(stored: StoredUser | null) {
  // The stub applies the `where` it is handed rather than returning a row on
  // sight. That distinction is the whole test: a fixed literal `where` proves
  // nothing, whereas a stub that honours the query actually rejects the rows the
  // query rejects. Drop `status` from the query and the suspended student is
  // handed straight back — which is precisely the regression being guarded.
  const findFirst = jest.fn(async (args: { where?: Record<string, unknown> }) => {
    if (!stored) return null;
    for (const [field, expected] of Object.entries(args.where ?? {})) {
      if (stored[field as keyof StoredUser] !== expected) return null;
    }
    return { id: stored.id };
  });

  const createMany = jest.fn(async () => ({ count: 1 }));
  const prisma = { user: { findFirst }, notification: { createMany } };

  // `createForMany` is the service's own method, so the send is observed at the
  // Prisma boundary. The push queue is inert: this route is about who is
  // reachable, not about delivery.
  const pushQueue = { add: jest.fn(async () => undefined) };
  const config = { get: () => undefined };

  const service = new NotificationsService(
    prisma as never,
    pushQueue as never,
    config as never,
  );
  return { service, findFirst, createMany, pushQueue };
}

const MESSAGE = { title: 'Lab safety briefing', body: 'Bring your goggles.' };

describe('who can be messaged directly', () => {
  it('delivers to an active student', async () => {
    const { service, createMany } = build({
      id: 'stu_1',
      role: UserRole.STUDENT,
      status: AccountStatus.ACTIVE,
      deletedAt: null,
    });

    const result = await service.messageStudent({ ...MESSAGE, userId: 'stu_1' }, ACTOR);

    expect(result).toMatchObject({ userId: 'stu_1', recipients: 1, sentById: ACTOR.id });
    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          userId: 'stu_1',
          kind: NotificationKind.ANNOUNCEMENT,
          title: MESSAGE.title,
          body: MESSAGE.body,
        }),
      ],
    });
  });

  it('scopes the lookup to an active, undeleted student', async () => {
    // The eligibility rule is the assertion here: every dimension has to be in
    // the query, because this route has no compiler to catch a missing one.
    const { service, findFirst } = build({
      id: 'stu_1',
      role: UserRole.STUDENT,
      status: AccountStatus.ACTIVE,
      deletedAt: null,
    });

    await service.messageStudent({ ...MESSAGE, userId: 'stu_1' }, ACTOR);

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'stu_1',
          role: UserRole.STUDENT,
          status: AccountStatus.ACTIVE,
          deletedAt: null,
        },
      }),
    );
  });

  it.each([AccountStatus.SUSPENDED, AccountStatus.DISABLED, AccountStatus.PENDING])(
    'refuses to message a %s student',
    async (status) => {
      // A suspended account is a decision the platform already made. Reaching
      // it through the one route that skipped the check undoes that decision
      // for as long as someone holds the id.
      const { service, createMany } = build({
        id: 'stu_1',
        role: UserRole.STUDENT,
        status,
        deletedAt: null,
      });

      await expect(
        service.messageStudent({ ...MESSAGE, userId: 'stu_1' }, ACTOR),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      expect(createMany).not.toHaveBeenCalled();
    },
  );

  it('refuses to message a deleted student', async () => {
    const { service, createMany } = build({
      id: 'stu_1',
      role: UserRole.STUDENT,
      status: AccountStatus.ACTIVE,
      deletedAt: new Date(),
    });

    await expect(
      service.messageStudent({ ...MESSAGE, userId: 'stu_1' }, ACTOR),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(createMany).not.toHaveBeenCalled();
  });

  it.each([UserRole.TEACHER, UserRole.ADMIN, UserRole.MASTER])(
    'refuses to message a %s through the student route',
    async (role) => {
      // The route is named for students; ids are not proof of role, and a
      // teacher must not be reachable by calling the student endpoint.
      const { service, createMany } = build({
        id: 'usr_1',
        role,
        status: AccountStatus.ACTIVE,
        deletedAt: null,
      });

      await expect(
        service.messageStudent({ ...MESSAGE, userId: 'usr_1' }, ACTOR),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(createMany).not.toHaveBeenCalled();
    },
  );

  it('refuses an unknown id without sending', async () => {
    const { service, createMany } = build(null);

    await expect(
      service.messageStudent({ ...MESSAGE, userId: 'ghost' }, ACTOR),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(createMany).not.toHaveBeenCalled();
  });

  it('requires a recipient', async () => {
    const { service, createMany } = build(null);

    await expect(service.messageStudent({ ...MESSAGE }, ACTOR)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(createMany).not.toHaveBeenCalled();
  });
});