import { AttachmentKind, UserRole } from '@prisma/client';

import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import { LibraryService } from '../../src/modules/library/library.service';

/**
 * Two things that ship together and are each easy to get subtly wrong.
 *
 * 1. Section-level attachments. The section-entitlement check used to fire
 *    only when an attachment had a `lessonId`. A document scoped straight to
 *    a section has no lesson, so the check would have been skipped entirely
 *    and a student who bought part 1 could have pulled part 2's handout. The
 *    feature and the hole arrived in the same change.
 *
 * 2. The library default thumbnail. The tempting implementation writes the
 *    default onto the part row at publish time. That makes an inherited image
 *    indistinguishable from a chosen one, and the next change of default
 *    either overwrites an Admin's explicit pick or cannot be applied at all.
 *    So resolution happens on read, and these tests pin the precedence.
 */

const ACTOR = { id: 'usr_admin', role: UserRole.ADMIN };

// ---------------------------------------------------------------------------
// Section attachments
// ---------------------------------------------------------------------------

interface AttachOptions {
  attachment?: {
    id: string;
    courseId: string;
    lessonId: string | null;
    sectionId: string | null;
    isPreview: boolean;
    isProtected: boolean;
    objectKey: string;
  } | null;
  lessonSectionId?: string | null;
  /** A section row for create()'s ownership check. */
  section?: { id: string } | null;
  lesson?: { id: string } | null;
}

function buildAttachments(options: AttachOptions = {}) {
  const attachment =
    options.attachment === undefined
      ? {
          id: 'att_1',
          courseId: 'crs_1',
          lessonId: null,
          sectionId: 'sec_2',
          isPreview: false,
          isProtected: true,
          objectKey: 'attachments/crs_1/x.pdf',
        }
      : options.attachment;

  const assertSectionAccessible = jest.fn(
    async (_args: { userId: string; courseId: string; sectionId: string }) => undefined,
  );

  const prisma = {
    attachment: {
      findFirst: jest.fn(async (_args: { where: unknown; include?: unknown }) =>
        attachment ? { ...attachment, course: { id: attachment.courseId, status: 'PUBLISHED' } } : null,
      ),
      create: jest.fn(async (args: { data: Record<string, unknown> }) => ({
        id: 'att_new',
        sizeBytes: null,
        pageCount: null,
        isDownloadable: false,
        deletedAt: null,
        ...args.data,
      })),
      findMany: jest.fn(async (_args: { where: unknown; orderBy: unknown }) => []),
    },
    lesson: {
      findUnique: jest.fn(async (_args: { where: unknown; select: unknown }) =>
        options.lessonSectionId === undefined
          ? { sectionId: 'sec_from_lesson' }
          : options.lessonSectionId === null
            ? null
            : { sectionId: options.lessonSectionId },
      ),
      findFirst: jest.fn(async (_args: { where: unknown; select: unknown }) =>
        options.lesson === undefined ? { id: 'les_1' } : options.lesson,
      ),
    },
    courseSection: {
      findFirst: jest.fn(async (_args: { where: unknown; select: unknown }) =>
        options.section === undefined ? { id: 'sec_1', courseId: 'crs_1' } : options.section,
      ),
    },
    user: {
      findUniqueOrThrow: jest.fn(async (_args: { where: unknown; select: unknown }) => ({
        fullName: 'Test Student',
      })),
    },
    watchEvent: { create: jest.fn(async (_args: unknown) => ({})) },
  };

  const access = {
    assertContentAccess: jest.fn(async (_args: unknown) => ({ canAccessContent: true })),
    assertSectionAccessible,
    assertCanManageCourse: jest.fn(async (..._args: unknown[]) => undefined),
    resolve: jest.fn(async (_args: unknown) => ({ canAccessContent: true })),
  };
  const devices = {
    assertAuthorizedForProtectedContent: jest.fn(async (_args: unknown) => ({
      deviceId: 'dev_1',
    })),
  };
  const storage = {
    signMediaUrl: jest.fn(async (_args: unknown) => 'https://gate.example/x'),
    deleteObject: jest.fn(async (..._args: unknown[]) => undefined),
  };
  const audit = { record: jest.fn(async (_entry: Record<string, unknown>) => undefined) };
  const config = { getOrThrow: () => ({ ticketTtl: 300 }) };

  const security = { record: jest.fn(async (_e: Record<string, unknown>) => undefined) };

  // Order matches the real constructor exactly: prisma, access, devices,
  // storage, security, audit, config.
  const service = new AttachmentsService(
    prisma as never,
    access as never,
    devices as never,
    storage as never,
    security as never,
    audit as never,
    config as never,
  );

  return { service, prisma, access, assertSectionAccessible, audit };
}

const STUDENT = {
  id: 'usr_student',
  role: UserRole.STUDENT,
  sessionId: 'ses_1',
  deviceId: 'dev_1',
  deviceKey: 'dk_1',
} as const;

describe('a section-scoped document is gated by the section entitlement', () => {
  it('checks the section carried on the attachment itself', async () => {
    // The regression this file exists for: no lessonId, so the old code path
    // checked nothing and served the file.
    const { service, assertSectionAccessible } = buildAttachments();

    await service.issueTicket({
      user: STUDENT as never,
      attachmentId: 'att_1',
      integritySuspect: false,
    });

    expect(assertSectionAccessible).toHaveBeenCalledWith(
      expect.objectContaining({ courseId: 'crs_1', sectionId: 'sec_2' }),
    );
  });

  it('still checks the lesson’s section for a lecture-scoped document', async () => {
    const { service, assertSectionAccessible } = buildAttachments({
      attachment: {
        id: 'att_2',
        courseId: 'crs_1',
        lessonId: 'les_1',
        sectionId: null,
        isPreview: false,
        isProtected: true,
        objectKey: 'attachments/crs_1/y.pdf',
      },
      lessonSectionId: 'sec_9',
    });

    await service.issueTicket({
      user: STUDENT as never,
      attachmentId: 'att_2',
      integritySuspect: false,
    });

    expect(assertSectionAccessible).toHaveBeenCalledWith(
      expect.objectContaining({ sectionId: 'sec_9' }),
    );
  });

  it('refuses when the student does not own the section', async () => {
    const { service, assertSectionAccessible } = buildAttachments();
    assertSectionAccessible.mockRejectedValue(new Error('section not covered'));

    await expect(
      service.issueTicket({
        user: STUDENT as never,
        attachmentId: 'att_1',
        integritySuspect: false,
      }),
    ).rejects.toThrow();
  });

  it('leaves course-wide documents ungated by any section', async () => {
    // Both scopes null: the document belongs to the course, not to a section,
    // so there is no section entitlement to consult.
    const { service, assertSectionAccessible } = buildAttachments({
      attachment: {
        id: 'att_3',
        courseId: 'crs_1',
        lessonId: null,
        sectionId: null,
        isPreview: false,
        isProtected: false,
        objectKey: 'attachments/crs_1/syllabus.pdf',
      },
    });

    await service.issueTicket({
      user: STUDENT as never,
      attachmentId: 'att_3',
      integritySuspect: false,
    });

    expect(assertSectionAccessible).not.toHaveBeenCalled();
  });

  it('exempts a preview document, as it always did', async () => {
    const { service, assertSectionAccessible } = buildAttachments({
      attachment: {
        id: 'att_4',
        courseId: 'crs_1',
        lessonId: null,
        sectionId: 'sec_2',
        isPreview: true,
        isProtected: false,
        objectKey: 'attachments/crs_1/sample.pdf',
      },
    });

    await service.issueTicket({
      user: STUDENT as never,
      attachmentId: 'att_4',
      integritySuspect: false,
    });

    expect(assertSectionAccessible).not.toHaveBeenCalled();
  });
});

describe('creating a scoped document', () => {
  it('refuses both scopes at once', async () => {
    const { service } = buildAttachments();
    await expect(
      service.create(
        {
          courseId: 'crs_1',
          lessonId: 'les_1',
          sectionId: 'sec_1',
          title: 'Both',
          kind: AttachmentKind.PDF,
          objectKey: 'k',
        },
        ACTOR,
      ),
    ).rejects.toThrow();
  });

  it('refuses a section from another course', async () => {
    // Without this an Admin on course A could scope a file to a section of
    // course B, and every later access check would consult the wrong course.
    const { service } = buildAttachments({ section: null });
    await expect(
      service.create(
        {
          courseId: 'crs_1',
          sectionId: 'sec_elsewhere',
          title: 'Foreign',
          kind: AttachmentKind.PDF,
          objectKey: 'k',
        },
        ACTOR,
      ),
    ).rejects.toThrow();
  });

  it('persists the section scope and records it in the audit trail', async () => {
    const { service, prisma, audit } = buildAttachments();

    await service.create(
      {
        courseId: 'crs_1',
        sectionId: 'sec_1',
        title: 'Section handout',
        kind: AttachmentKind.PDF,
        objectKey: 'attachments/crs_1/h.pdf',
      },
      ACTOR,
    );

    const call = prisma.attachment.create.mock.calls[0];
    if (!call) throw new Error('attachment.create was never called');
    expect(call[0].data).toMatchObject({ sectionId: 'sec_1', lessonId: undefined });

    const entry = audit.record.mock.calls[0];
    if (!entry) throw new Error('audit.record was never called');
    expect((entry[0] as { after: { sectionId: string | null } }).after.sectionId).toBe('sec_1');
  });
});

// ---------------------------------------------------------------------------
// Library thumbnails
// ---------------------------------------------------------------------------

function buildLibrary(opts: {
  partThumbnailKey: string | null;
  coverKey: string | null;
  defaultKey: string | null;
}) {
  const material = {
    id: 'mat_1',
    title: 'Physics Papers',
    titleAr: null,
    description: null,
    coverKey: opts.coverKey,
    subject: null,
    parts: [
      {
        id: 'lp_1',
        title: 'Part 1',
        titleAr: null,
        description: null,
        sortOrder: 1,
        price: 50,
        currency: 'EGP',
        pageCount: 10,
        mimeType: 'application/pdf',
        isPreview: false,
        thumbnailKey: opts.partThumbnailKey,
      },
    ],
    packages: [],
  };

  const prisma = {
    libraryMaterial: {
      findFirst: jest.fn(async (_args: { where: unknown; select: unknown }) => material),
    },
    libraryEntitlement: {
      findMany: jest.fn(async (_args: { where: unknown; select: unknown }) => []),
    },
  };
  const audit = { record: jest.fn(async (_e: Record<string, unknown>) => undefined) };
  // Echoes the key back, so the assertion is about WHICH key was chosen.
  const storage = {
    publicAssetUrl: jest.fn(async (key: string | null) => (key ? `https://cdn/${key}` : null)),
  };
  const settings = {
    libraryDefaultThumbnailKey: jest.fn(async () => opts.defaultKey),
  };

  const service = new LibraryService(
    prisma as never,
    audit as never,
    storage as never,
    settings as never,
  );

  return { service, settings, storage };
}

describe('library part thumbnail precedence', () => {
  it('prefers the part’s own thumbnail', async () => {
    const { service } = buildLibrary({
      partThumbnailKey: 'thumbnails/library/mat_1/parts/lp_1/own.jpg',
      coverKey: 'covers/mat_1.jpg',
      defaultKey: 'thumbnails/library/_default/d.jpg',
    });

    const out = await service.materialForStudent('mat_1', 'usr_1');
    expect(out.parts[0]?.thumbnailUrl).toBe(
      'https://cdn/thumbnails/library/mat_1/parts/lp_1/own.jpg',
    );
  });

  it('falls back to the material cover when the part has none', async () => {
    const { service } = buildLibrary({
      partThumbnailKey: null,
      coverKey: 'covers/mat_1.jpg',
      defaultKey: 'thumbnails/library/_default/d.jpg',
    });

    const out = await service.materialForStudent('mat_1', 'usr_1');
    expect(out.parts[0]?.thumbnailUrl).toBe('https://cdn/covers/mat_1.jpg');
  });

  it('falls back to the platform default when neither exists', async () => {
    const { service } = buildLibrary({
      partThumbnailKey: null,
      coverKey: null,
      defaultKey: 'thumbnails/library/_default/d.jpg',
    });

    const out = await service.materialForStudent('mat_1', 'usr_1');
    expect(out.parts[0]?.thumbnailUrl).toBe('https://cdn/thumbnails/library/_default/d.jpg');
  });

  it('answers null when nothing is configured anywhere', async () => {
    const { service } = buildLibrary({
      partThumbnailKey: null,
      coverKey: null,
      defaultKey: null,
    });

    const out = await service.materialForStudent('mat_1', 'usr_1');
    expect(out.parts[0]?.thumbnailUrl).toBeNull();
  });

  it('never lets the default displace an explicit choice', async () => {
    // Stated as its own test because it is the requirement, not a side effect:
    // the default is applied on READ, so a part that has its own image is
    // unaffected no matter how the default changes.
    const { service } = buildLibrary({
      partThumbnailKey: 'chosen.jpg',
      coverKey: 'cover.jpg',
      defaultKey: 'default.jpg',
    });

    const out = await service.materialForStudent('mat_1', 'usr_1');
    expect(out.parts[0]?.thumbnailUrl).toBe('https://cdn/chosen.jpg');
  });

  it('reads the default once per material, not once per part', async () => {
    const { service, settings } = buildLibrary({
      partThumbnailKey: null,
      coverKey: null,
      defaultKey: 'd.jpg',
    });

    await service.materialForStudent('mat_1', 'usr_1');
    expect(settings.libraryDefaultThumbnailKey).toHaveBeenCalledTimes(1);
  });
});
