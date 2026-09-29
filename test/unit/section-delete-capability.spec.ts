import { UserRole } from '@prisma/client';

import { AppException } from '../../src/common/errors/app.exception';
import { ErrorCode } from '../../src/common/errors/error-codes';
import { SectionsService } from '../../src/modules/sections/sections.service';

/**
 * Deleting a section deletes the lectures inside it.
 *
 * Which makes it subject to the same platform switch — `teacher.deleteLectures`
 * — that the per-lecture delete has always enforced. It was not, and that was a
 * genuine way around the setting: the dashboard hides the per-lecture button
 * when the switch is off, but the section button was never gated and the
 * section endpoint never re-checked. A teacher could clear a whole section's
 * worth of lectures the product had decided they may not delete.
 *
 * The dashboard's own hiding of controls proves nothing here. These tests go
 * straight at the service, which is the boundary that actually decides.
 */

const SECTION = {
  id: 'sec_1',
  courseId: 'crs_1',
  sortOrder: 1,
  deletedAt: null,
  status: 'PUBLISHED',
};

function build(options: { teacherMayDeleteLectures: boolean; liveLessons: number }) {
  const assertTeacherCapability = jest.fn(async (role: UserRole, capability: string) => {
    if (role !== UserRole.TEACHER) return;
    if (capability === 'deleteLectures' && !options.teacherMayDeleteLectures) {
      throw new AppException(ErrorCode.FORBIDDEN, {
        message: "Teachers are not permitted to perform 'deleteLectures' on this platform",
      });
    }
  });

  const sectionUpdate = jest.fn(async () => SECTION);
  const lessonUpdateMany = jest.fn(async () => ({ count: options.liveLessons }));
  const videoUpdateMany = jest.fn(async () => ({ count: 0 }));
  const ticketUpdateMany = jest.fn(async () => ({ count: 0 }));

  const tx = {
    courseSection: { update: sectionUpdate },
    lesson: { updateMany: lessonUpdateMany },
    video: { updateMany: videoUpdateMany },
    playbackTicket: { updateMany: ticketUpdateMany },
    $executeRaw: jest.fn(async () => 0),
  };

  const prisma = {
    courseSection: { findFirst: jest.fn(async () => SECTION) },
    lesson: { count: jest.fn(async () => options.liveLessons) },
    watchProgress: { count: jest.fn(async () => 0) },
    $transaction: jest.fn(async (fn: (client: unknown) => unknown) => fn(tx)),
  };

  const access = {
    assertCanManageCourse: jest.fn(async () => undefined),
    assertTeacherCapability,
  };

  const service = new SectionsService(
    prisma as never,
    access as never,
    { recountCourse: jest.fn(async () => undefined) } as never,
    { record: jest.fn(async () => undefined) } as never,
  );

  return { service, assertTeacherCapability, sectionUpdate, ticketUpdateMany, videoUpdateMany };
}

const TEACHER = { id: 'usr_teacher', role: UserRole.TEACHER };
const ADMIN = { id: 'usr_admin', role: UserRole.ADMIN };

describe('deleting a section respects the lecture-deletion switch', () => {
  it('refuses a teacher when the platform switch is off and the section has lectures', async () => {
    const { service, sectionUpdate } = build({
      teacherMayDeleteLectures: false,
      liveLessons: 4,
    });

    await expect(service.remove('sec_1', TEACHER)).rejects.toBeInstanceOf(AppException);

    // And nothing was written on the way to the refusal.
    expect(sectionUpdate).not.toHaveBeenCalled();
  });

  it('allows a teacher when the switch is on', async () => {
    const { service, sectionUpdate } = build({
      teacherMayDeleteLectures: true,
      liveLessons: 4,
    });

    await expect(service.remove('sec_1', TEACHER)).resolves.toMatchObject({ ok: true });
    expect(sectionUpdate).toHaveBeenCalled();
  });

  it('does not consult the switch for an empty section', async () => {
    // Nothing is being deleted that the switch governs, so removing an empty
    // section stays available — the check is about lectures, not sections.
    const { service, assertTeacherCapability } = build({
      teacherMayDeleteLectures: false,
      liveLessons: 0,
    });

    await expect(service.remove('sec_1', TEACHER)).resolves.toMatchObject({ ok: true });
    expect(assertTeacherCapability).not.toHaveBeenCalled();
  });

  it('never constrains an admin', async () => {
    const { service, sectionUpdate } = build({
      teacherMayDeleteLectures: false,
      liveLessons: 4,
    });

    await expect(service.remove('sec_1', ADMIN)).resolves.toMatchObject({ ok: true });
    expect(sectionUpdate).toHaveBeenCalled();
  });
});

describe('deleting a section stops its content being streamed', () => {
  it('archives the videos and revokes live playback tickets', async () => {
    // A ticket already issued kept playing until it lapsed, so a student could
    // carry on watching a section that had just been removed. The per-lecture
    // delete always revoked them; this did not.
    const { service, videoUpdateMany, ticketUpdateMany } = build({
      teacherMayDeleteLectures: true,
      liveLessons: 2,
    });

    await service.remove('sec_1', ADMIN);

    expect(videoUpdateMany).toHaveBeenCalled();
    expect(ticketUpdateMany).toHaveBeenCalled();
  });
});
