import 'reflect-metadata';

import { UserRole } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ROLES_KEY } from '../../src/common/decorators/roles.decorator';
import { AppException } from '../../src/common/errors/app.exception';
import { ErrorCode } from '../../src/common/errors/error-codes';
import { RolesGuard } from '../../src/common/guards/roles.guard';
import {
  PresignLibraryDocumentDto,
  StorageController,
} from '../../src/modules/storage/storage.controller';
import { StorageService } from '../../src/modules/storage/storage.service';

/**
 * Presigning a Library document upload.
 *
 * The endpoint hands an administrator a short-lived, write-only signature and
 * a key the *server* chose. Four properties are worth defending, and each one
 * fails differently:
 *
 *   1. The key is `library/<uuid><ext>` — never `attachments/<courseId>/…`.
 *      The Library is independent of courses in both directions, so filing a
 *      paid document under a course prefix would tie its lifetime to a course
 *      it has nothing to do with.
 *   2. The filename cannot steer where the object lands. It contributes an
 *      extension and nothing else.
 *   3. Only an administrator may ask. A teacher with a perfectly valid token
 *      must be refused.
 *   4. What comes back is a signature that expires, against the private
 *      uploads bucket — not a public or permanent URL.
 *
 * `presignUpload()` itself is exercised, not stubbed: SigV4 signing is local
 * and offline, so the test can assert on the real URL rather than on a mock's
 * arguments. Nothing in the service or controller is modified by this file.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Stands in for `configuration.ts`'s `storage` namespace. Credentials are
 * fake; SigV4 never contacts anything, so a signature over made-up keys is
 * just as real a signature.
 */
const STORAGE_CONFIG = {
  accountId: 'acct-test',
  accessKeyId: 'test-access-key-id',
  secretAccessKey: 'test-secret-access-key',
  region: 'auto',
  endpoint: 'https://acct-test.r2.cloudflarestorage.com',
  forcePathStyle: true,
  buckets: { media: 'edu-media-test', uploads: 'edu-uploads-test' },
  cdnBaseUrl: 'https://cdn.example.test',
  signingKey: 'signing-key-for-tests',
};

function buildController(overrides: Partial<typeof STORAGE_CONFIG> = {}) {
  const cfg = { ...STORAGE_CONFIG, ...overrides };
  const config = { getOrThrow: () => cfg };
  const storage = new StorageService(config as never);
  const presignSpy = jest.spyOn(storage, 'presignUpload');

  return { controller: new StorageController(storage), storage, presignSpy };
}

const PDF = 'application/pdf';

function body(overrides: Record<string, unknown> = {}) {
  return {
    filename: 'revision-paper.pdf',
    contentType: PDF,
    sizeBytes: 1024,
    ...overrides,
  };
}

/** Exactly the pipe `main.ts` installs, so a verdict here is the real one. */
async function invalidFields(plain: Record<string, unknown>): Promise<string[]> {
  const instance = plainToInstance(PresignLibraryDocumentDto, plain, {
    enableImplicitConversion: false,
  });

  const errors = await validate(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
    stopAtFirstError: false,
  });

  return errors.map((error) => error.property).sort();
}

const UUID_V4 =
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

// ---------------------------------------------------------------------------
// 1. Key construction
// ---------------------------------------------------------------------------

describe('StorageService.keys.libraryDocument', () => {
  it('files the object under library/<uuid><ext>', () => {
    const key = StorageService.keys.libraryDocument('revision-paper.pdf');

    expect(key).toMatch(new RegExp(`^library/${UUID_V4}\\.pdf$`));
  });

  /**
   * The point of the whole backend change. If this ever passes through
   * `attachment()`, a library document acquires a course's lifetime and
   * disappears when that course's prefix is deleted.
   */
  it.each([
    'revision-paper.pdf',
    'مراجعة الفيزياء.pdf',
    'Summer Notes (2026).docx',
    'sheet.xlsx',
  ])('never uses a course-based attachments prefix for %s', (filename) => {
    const key = StorageService.keys.libraryDocument(filename);

    expect(key.startsWith('library/')).toBe(true);
    expect(key).not.toContain('attachments/');
    expect(key).not.toContain('courses/');
  });

  it.each([
    ['revision-paper.pdf', '.pdf'],
    ['REVISION-PAPER.PDF', '.pdf'],
    ['notes.DocX', '.docx'],
    ['marks.xlsx', '.xlsx'],
    ['cover.PNG', '.png'],
    ['archive.tar.gz', '.gz'],
  ])('keeps %s as a lowercased %s', (filename, ext) => {
    expect(StorageService.keys.libraryDocument(filename).endsWith(ext)).toBe(true);
  });

  it('falls back to .bin when the name carries no extension', () => {
    expect(StorageService.keys.libraryDocument('README')).toMatch(
      new RegExp(`^library/${UUID_V4}\\.bin$`),
    );
  });

  /**
   * The filename is an administrator's, and it may be a student-facing title.
   * Only its extension survives into the key.
   */
  it('puts no part of the filename into the key', () => {
    const key = StorageService.keys.libraryDocument('Answer Key — Final Exam.pdf');

    expect(key).not.toContain('Answer');
    expect(key).not.toContain('Final');
    expect(key).not.toContain(' ');
  });

  it('gives a different key each time, so keys cannot be guessed or collided', () => {
    const keys = new Set(
      Array.from({ length: 50 }, () =>
        StorageService.keys.libraryDocument('same-name.pdf'),
      ),
    );

    expect(keys.size).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// 2. DTO validation
// ---------------------------------------------------------------------------

describe('PresignLibraryDocumentDto', () => {
  it('accepts a well-formed body', async () => {
    expect(await invalidFields(body())).toEqual([]);
  });

  /**
   * The wiring, not just the class: the route's body really is this DTO and
   * not `PresignAttachmentDto`, whose required `courseId` would make the
   * endpoint unusable for a Library that has no course.
   */
  it('is the type the route actually validates against', () => {
    const paramTypes = Reflect.getMetadata(
      'design:paramtypes',
      StorageController.prototype,
      'libraryDocument',
    ) as unknown[];

    expect(paramTypes?.[0]).toBe(PresignLibraryDocumentDto);
  });

  it('needs no courseId, and refuses one that is offered', async () => {
    expect(await invalidFields(body())).toEqual([]);
    // `forbidNonWhitelisted` — the property does not exist on this DTO.
    expect(await invalidFields(body({ courseId: 'course-1' }))).toContain('courseId');
  });

  describe('contentType', () => {
    it.each([
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'image/jpeg',
      'image/png',
      'image/webp',
    ])('allows %s', async (contentType) => {
      expect(await invalidFields(body({ contentType }))).toEqual([]);
    });

    it.each([
      ['text/plain', 'a disguised script is still a script'],
      ['text/html', 'would be served from our own origin'],
      ['application/zip', 'opaque, and nothing reads it in the app'],
      ['application/x-msdownload', 'an executable'],
      ['video/mp4', 'video has its own pipeline'],
      ['', 'absent'],
    ])('refuses %s (%s)', async (contentType) => {
      expect(await invalidFields(body({ contentType }))).toContain('contentType');
    });

    it('refuses a missing contentType', async () => {
      const { contentType: _omitted, ...rest } = body();
      expect(await invalidFields(rest)).toContain('contentType');
    });
  });

  describe('sizeBytes', () => {
    const MAX = 200 * 1024 * 1024;

    it('allows exactly 200 MB', async () => {
      expect(await invalidFields(body({ sizeBytes: MAX }))).toEqual([]);
    });

    it('refuses one byte over 200 MB', async () => {
      expect(await invalidFields(body({ sizeBytes: MAX + 1 }))).toContain('sizeBytes');
    });

    it.each([
      ['zero', 0],
      ['negative', -1],
      ['fractional', 1.5],
    ])('refuses a %s size', async (_label, sizeBytes) => {
      expect(await invalidFields(body({ sizeBytes }))).toContain('sizeBytes');
    });

    it('refuses a missing size', async () => {
      const { sizeBytes: _omitted, ...rest } = body();
      expect(await invalidFields(rest)).toContain('sizeBytes');
    });
  });

  describe('filename', () => {
    it.each([
      ['a plain name', 'notes.pdf'],
      ['spaces and parentheses', 'Summer Notes (2026).docx'],
      ['Arabic', 'مراجعة الفيزياء.pdf'],
      ['a hyphen', 'revision-paper-3.pdf'],
      ['200 characters exactly', `${'a'.repeat(196)}.pdf`],
    ])('accepts %s', async (_label, filename) => {
      expect(await invalidFields(body({ filename }))).toEqual([]);
    });

    it.each([
      ['empty', ''],
      ['no extension', 'README'],
      ['a trailing dot', 'notes.'],
      ['an over-long extension', 'notes.application'],
      ['over 200 characters', `${'a'.repeat(200)}.pdf`],
      ['a null byte', 'notes\u0000.pdf'],
      ['a newline', 'notes\n.pdf'],
    ])('refuses %s', async (_label, filename) => {
      expect(await invalidFields(body({ filename }))).toContain('filename');
    });

    it('refuses a missing filename', async () => {
      const { filename: _omitted, ...rest } = body();
      expect(await invalidFields(rest)).toContain('filename');
    });

    /**
     * Path traversal, refused by the character class itself: neither `/` nor
     * `\` is in it, so these never reach the handler's own guard.
     */
    it.each([
      '../secrets.pdf',
      '../../etc/passwd.pdf',
      'nested/dir/notes.pdf',
      '..\\windows\\notes.pdf',
      '/absolute/notes.pdf',
    ])('refuses the traversal shape %s', async (filename) => {
      expect(await invalidFields(body({ filename }))).toContain('filename');
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Path-traversal guard inside the handler
// ---------------------------------------------------------------------------

describe('POST /storage/uploads/library-document — traversal guard', () => {
  /**
   * `notes..pdf` satisfies the DTO pattern — `.` is a legal filename
   * character — and still contains `..`. The handler's explicit check is the
   * only thing that catches it, which is precisely why it is not redundant
   * with the regex.
   */
  it.each(['notes..pdf', '..pdf', 'a..b.pdf'])(
    'refuses %s even though the pattern admits it',
    async (filename) => {
      const { controller, presignSpy } = buildController();

      await expect(controller.libraryDocument(body({ filename }) as never)).rejects.toThrow(
        AppException,
      );
      expect(presignSpy).not.toHaveBeenCalled();
    },
  );

  it('refuses with VALIDATION_ERROR against the filename field', async () => {
    const { controller } = buildController();

    try {
      await controller.libraryDocument(body({ filename: 'notes..pdf' }) as never);
      throw new Error('the handler should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).code).toBe(ErrorCode.VALIDATION_ERROR);
      expect((error as AppException).fields?.filename).toEqual([
        'must not contain path separators',
      ]);
    }
  });

  it('refuses a separator that somehow bypassed the pipe', async () => {
    // Defence in depth: the handler does not assume the DTO ran.
    const { controller, presignSpy } = buildController();

    await expect(
      controller.libraryDocument(body({ filename: 'dir/notes.pdf' }) as never),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(presignSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Authorization
// ---------------------------------------------------------------------------

describe('@AdminOnly() on the library-document route', () => {
  const rolesOn = (handler: unknown): UserRole[] =>
    Reflect.getMetadata(ROLES_KEY, handler as object) as UserRole[];

  it('declares master and admin, and no one else', () => {
    expect(rolesOn(StorageController.prototype.libraryDocument)).toEqual([
      UserRole.MASTER,
      UserRole.ADMIN,
    ]);
  });

  /**
   * Read through the real guard rather than asserting on metadata alone: the
   * decorator is only a promise, and the guard is what keeps it.
   */
  it.each([
    [UserRole.MASTER, true],
    [UserRole.ADMIN, true],
    [UserRole.TEACHER, false],
    [UserRole.STUDENT, false],
  ])('%s → %s', (role, allowed) => {
    const roles = rolesOn(StorageController.prototype.libraryDocument);

    const context = {
      switchToHttp: () => ({ getRequest: () => ({ user: { id: 'u1', role } }) }),
      getHandler: () => StorageController.prototype.libraryDocument,
      getClass: () => StorageController,
    } as never;

    const reflector = {
      getAllAndOverride: (key: string) => (key === ROLES_KEY ? roles : undefined),
    } as never;

    const guard = new RolesGuard(reflector);

    if (allowed) {
      expect(guard.canActivate(context)).toBe(true);
    } else {
      try {
        guard.canActivate(context);
        throw new Error('the guard should have refused');
      } catch (error) {
        expect(error).toBeInstanceOf(AppException);
        expect((error as AppException).code).toBe(ErrorCode.INSUFFICIENT_ROLE);
      }
    }
  });

  /**
   * The neighbouring course-attachment route was not touched. A teacher owns
   * courses and must keep being able to attach material to them.
   */
  it('leaves the course-attachment route open to staff', () => {
    expect(rolesOn(StorageController.prototype.attachment)).toEqual([
      UserRole.MASTER,
      UserRole.ADMIN,
      UserRole.TEACHER,
    ]);
  });
});

// ---------------------------------------------------------------------------
// 5. Successful presign
// ---------------------------------------------------------------------------

describe('POST /storage/uploads/library-document — success', () => {
  it('returns a key, a URL, an expiry and the headers to replay', async () => {
    const { controller } = buildController();

    const signed = await controller.libraryDocument(body() as never);

    expect(signed).toEqual({
      uploadUrl: expect.stringContaining('https://'),
      objectKey: expect.stringMatching(new RegExp(`^library/${UUID_V4}\\.pdf$`)),
      expiresIn: 3600,
      requiredHeaders: { 'Content-Type': PDF },
    });
  });

  it('signs against the private uploads bucket, not media', async () => {
    const { controller } = buildController();

    const { uploadUrl } = await controller.libraryDocument(body() as never);

    expect(uploadUrl).toContain('edu-uploads-test');
    expect(uploadUrl).not.toContain('edu-media-test');
  });

  it('issues a signature that expires, not a permanent or public URL', async () => {
    const { controller } = buildController();

    const { uploadUrl } = await controller.libraryDocument(body() as never);
    const query = new URL(uploadUrl).searchParams;

    expect(query.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(query.get('X-Amz-Expires')).toBe('3600');
    expect(query.get('X-Amz-Signature')).toBeTruthy();
    // The CDN is the public read path. An upload ticket must never be one.
    expect(uploadUrl).not.toContain('cdn.example.test');
  });

  it('carries the requested content type into the signature and the headers', async () => {
    const { controller } = buildController();

    const signed = await controller.libraryDocument(
      body({ filename: 'cover.png', contentType: 'image/png' }) as never,
    );

    expect(signed.requiredHeaders).toEqual({ 'Content-Type': 'image/png' });
    expect(signed.objectKey.endsWith('.png')).toBe(true);
  });

  it('asks the service for the uploads bucket and the library key', async () => {
    const { controller, presignSpy } = buildController();

    await controller.libraryDocument(body() as never);

    expect(presignSpy).toHaveBeenCalledTimes(1);
    expect(presignSpy.mock.calls[0][0]).toMatchObject({
      bucket: 'uploads',
      contentType: PDF,
      expiresIn: 3600,
    });
    expect(presignSpy.mock.calls[0][0].objectKey.startsWith('library/')).toBe(true);
  });

  it('gives two uploads of the same filename two different keys', async () => {
    const { controller } = buildController();

    const first = await controller.libraryDocument(body() as never);
    const second = await controller.libraryDocument(body() as never);

    expect(first.objectKey).not.toBe(second.objectKey);
  });

  it('refuses rather than pretending when storage is unconfigured', async () => {
    const { controller, presignSpy } = buildController({
      accessKeyId: '',
      secretAccessKey: '',
    });

    await expect(controller.libraryDocument(body() as never)).rejects.toMatchObject({
      code: ErrorCode.STORAGE_UNAVAILABLE,
    });
    expect(presignSpy).toHaveBeenCalledTimes(1);
  });
});
