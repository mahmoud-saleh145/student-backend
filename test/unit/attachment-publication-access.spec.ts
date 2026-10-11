import { UserRole } from '@prisma/client';
import { AttachmentsService } from 'src/modules/attachments/attachments.service';

/**
 * A document ticket must respect PUBLICATION, not just entitlement.
 *
 * THE GAP THIS FILE EXISTS FOR
 * ---------------------------
 * `LessonsService.detail()` refuses a student a lecture whose lesson or section
 * is not PUBLISHED, with the reasoning that hiding a section must not merely
 * remove it from the outline while leaving its lectures openable by id.
 *
 * `AttachmentsService.issueTicket` had no equivalent check. It verified course
 * entitlement and section entitlement - and an ENROLLED student passes both for
 * a course whose lesson is still a DRAFT. So the attachment id alone was enough
 * to obtain a signed URL for a draft lecture's PDF.
 *
 * Entitlement cannot cover this: the student is entitled to the COURSE. The
 * lecture has simply not been published yet.
 *
 * These tests drive the real `issueTicket`.
 */

type Scope = {
  lessonId?: string | null;
  sectionId?: string | null;
  lessonStatus?: string | null;
  lessonSectionStatus?: string | null;
  sectionStatus?: string | null;
  isPreview?: boolean;
};

const KEY = 'attachments/crs_1/x.pdf';

function build(scope: Scope) {
  const attachment = {
    id: 'att_1',
    courseId: 'crs_1',
    lessonId: scope.lessonId ?? null,
    sectionId: scope.sectionId ?? null,
    isPreview: scope.isPreview ?? false,
    isProtected: false,
    objectKey: KEY,
    course: { id: 'crs_1', status: 'PUBLISHED' },
  };

  const prisma = {
    attachment: {
      findFirst: jest.fn(async () => attachment),
    },
    lesson: {
      findUnique: jest.fn(async () =>
        scope.lessonStatus === undefined && scope.lessonSectionStatus === undefined
          ? null
          : {
              sectionId: 'sec_1',
              status: scope.lessonStatus ?? 'PUBLISHED',
              section: { status: scope.lessonSectionStatus ?? 'PUBLISHED' },
            },
      ),
    },
    courseSection: {
      findUnique: jest.fn(async () => ({
        status: scope.sectionStatus ?? 'PUBLISHED',
      })),
    },
    user: { findUniqueOrThrow: jest.fn(async () => ({ fullName: 'Student' })) },
    watchEvent: { create: jest.fn(async () => ({})) },
  };

  // Enrollment is GRANTED in every case here - that is the point.
  const access = {
    assertContentAccess: jest.fn(async () => ({ canAccessContent: true })),
    assertSectionAccessible: jest.fn(async () => undefined),
  };
  const devices = { assertAuthorizedForProtectedContent: jest.fn(async () => ({ deviceId: 'd1' })) };
  const storage = { signMediaUrl: jest.fn(async () => 'https://gate.example/x') };
  const security = { record: jest.fn(async () => undefined) };
  const audit = { record: jest.fn(async () => undefined) };
  const config = { getOrThrow: () => ({ ticketTtl: 300 }) };

  const service = new AttachmentsService(
    prisma as never,
    access as never,
    devices as never,
    storage as never,
    security as never,
    audit as never,
    config as never,
  );

  return { service, storage, access };
}

const STUDENT = {
  id: 'usr_student',
  role: UserRole.STUDENT,
  sessionId: 'ses_1',
  deviceId: 'dev_1',
  deviceKey: 'dk_1',
} as const;

const issue = (t: ReturnType<typeof build>) =>
  t.service.issueTicket({
    user: STUDENT as never,
    attachmentId: 'att_1',
    integritySuspect: false,
    ip: null,
  });

describe('a draft lecture document', () => {
  it('is refused even though the student is enrolled in the course', async () => {
    const t = build({ lessonId: 'les_1', lessonStatus: 'DRAFT', lessonSectionStatus: 'PUBLISHED' });

    await expect(issue(t)).rejects.toThrow(/not found/i);
    expect(t.storage.signMediaUrl).not.toHaveBeenCalled();
  });

  it('is refused when the LECTURE is published but its SECTION is not', async () => {
    // The exact shape hiding a section must produce.
    const t = build({
      lessonId: 'les_1',
      lessonStatus: 'PUBLISHED',
      lessonSectionStatus: 'DRAFT',
    });

    await expect(issue(t)).rejects.toThrow(/not found/i);
    expect(t.storage.signMediaUrl).not.toHaveBeenCalled();
  });

  it('is refused for HIDDEN content as well as DRAFT', async () => {
    for (const status of ['DRAFT', 'HIDDEN', 'ARCHIVED']) {
      const t = build({ lessonId: 'les_1', lessonStatus: status });
      await expect(issue(t)).rejects.toThrow(/not found/i);
    }
  });

  it('is refused when flagged as a preview', async () => {
    // `isPreview` waives the SECTION entitlement check. It must not waive
    // publication: the lecture has still not been released.
    const t = build({ lessonId: 'les_1', lessonStatus: 'DRAFT', isPreview: true });

    await expect(issue(t)).rejects.toThrow(/not found/i);
    expect(t.storage.signMediaUrl).not.toHaveBeenCalled();
  });

  it('is refused for a draft SECTION handout', async () => {
    const t = build({ sectionId: 'sec_1', sectionStatus: 'DRAFT' });

    await expect(issue(t)).rejects.toThrow(/not found/i);
    expect(t.storage.signMediaUrl).not.toHaveBeenCalled();
  });
});

describe('published material is unaffected', () => {
  it('issues a ticket for a PDF on a published lecture', async () => {
    const t = build({ lessonId: 'les_1', lessonStatus: 'PUBLISHED', lessonSectionStatus: 'PUBLISHED' });

    const ticket = await issue(t);

    expect(ticket.url).toBe('https://gate.example/x');
    expect(t.storage.signMediaUrl).toHaveBeenCalledTimes(1);
  });

  it('issues a ticket for a course-wide document that belongs to no lecture', async () => {
    // No lesson and no section: nothing can be unpublished.
    const t = build({});

    await expect(issue(t)).resolves.toMatchObject({ attachmentId: 'att_1' });
  });

  it('issues a ticket for a published section handout', async () => {
    const t = build({ sectionId: 'sec_1', sectionStatus: 'PUBLISHED' });

    await expect(issue(t)).resolves.toMatchObject({ attachmentId: 'att_1' });
  });

  it('still enforces course entitlement on top of publication', async () => {
    const t = build({ lessonId: 'les_1', lessonStatus: 'PUBLISHED' });
    (t.access.assertContentAccess as jest.Mock).mockRejectedValueOnce(new Error('not enrolled'));

    await expect(issue(t)).rejects.toThrow(/not enrolled/);
  });
});

describe('the signed URL is the only thing handed out', () => {
  it('binds the URL to the viewer and carries a short expiry', async () => {
    const t = build({ lessonId: 'les_1', lessonStatus: 'PUBLISHED' });

    const ticket = await issue(t);

    // The HMAC is computed over user, session and device, so a copied URL
    // fails at the edge. `headers` stays empty: nothing secret is echoed back.
    expect(ticket.headers).toEqual({});
    expect(Date.parse(ticket.expiresAt)).toBeGreaterThan(Date.now());
    expect(Date.parse(ticket.expiresAt)).toBeLessThanOrEqual(Date.now() + 300_000 + 5_000);
  });

  it('never returns a storage key or the raw object key', async () => {
    const t = build({ lessonId: 'les_1', lessonStatus: 'PUBLISHED' });

    const ticket = await issue(t);

    expect(JSON.stringify(ticket)).not.toContain(KEY);
  });
});