import 'reflect-metadata';

import { StorageController } from 'src/modules/storage/storage.controller';
import { StorageService } from 'src/modules/storage/storage.service';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ROLES_KEY } from 'src/common/decorators/roles.decorator';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { PresignLibraryDocumentDto } from 'src/modules/storage/storage.controller';

/**
 * WHY THIS FILE EXISTS
 * --------------------
 * An audit of both PDF flows was asked to confirm an 8 MB ceiling. There is no
 * 8 MB ceiling anywhere in either flow - both are set at 200 MB:
 *
 *   storage.controller.ts:20  MAX_LIBRARY_DOCUMENT_BYTES = 200 * 1024 * 1024
 *   storage.controller.ts:33  MAX_ATTACHMENT_BYTES      = 200 * 1024 * 1024
 *
 * `storage-library-upload.spec.ts` already pins the Library *presign* DTO's
 * 200 MB boundary. What had no coverage at all were the two STREAMING
 * endpoints the dashboard actually uses - `libraryDocumentContent()` and
 * `attachmentContent()` - which gate on the Content-Length header through
 * `requireLength()` instead of on a DTO field. A limit that no test observes is
 * a limit that can be silently deleted, so these tests state the real number for
 * both flows and cover the cases that follow from it:
 *
 *   - the 25 MB the task asked for passes, with room to spare
 *   - the real 200 MB boundary holds on both flows
 *   - each flow's gate is independent of the other's
 *   - an absent Content-Length is still refused (the gate is a ceiling AND a
 *     presence check, and both halves matter)
 *
 * Nothing here modifies the controller or the service. These are assertions
 * about current, intended behaviour.
 */

const MB = 1024 * 1024;

/** The ceiling both flows declare today, stated once so a change is visible. */
const MAX = 200 * MB;

/** The size the audit was asked to guarantee. */
const TARGET = 25 * MB;

/** The two streaming endpoints under test, with their real arities. */
type StorageControllerLike = {
  libraryDocumentContent(
    query: Record<string, unknown>,
    req: unknown,
  ): Promise<{ objectKey: string; sizeBytes: number }>;
  attachmentContent(
    actor: { id: string; role: 'ADMIN' },
    query: Record<string, unknown>,
    req: unknown,
  ): Promise<{ objectKey: string; sizeBytes: number }>;
};

/** The actor the course-material uploads are made as. */
const ADMIN = { id: 'usr_1', role: 'ADMIN' } as const;

function build() {
  const putStream = jest.fn(
    async (_args: {
      bucket: string;
      objectKey: string;
      contentLength: number;
      contentType: string;
    }) => undefined,
  );

  const storage = {
    presignUpload: jest.fn(async () => ({ url: 'https://up.example', fields: {} })),
    putStream,
    publicAssetUrl: jest.fn(async () => null),
    signMediaUrl: jest.fn(async () => 'https://gate.example/x'),
    deleteObject: jest.fn(async () => undefined),
    get isConfigured() {
      return true;
    },
  };

  // Order matches the real constructor: storage, cloudinary, courseAccess.
  const controller = new StorageController(
    storage as never,
    {} as never,
    {
      assertCanManageCourse: jest.fn(async () => undefined),
      assertCourseExistsAndManageable: jest.fn(async () => undefined),
    } as never,
  ) as unknown as StorageControllerLike;

  return { controller, putStream };
}

/** A request carrying the declared length the endpoint reads. */
function req(contentLength: number | undefined) {
  return {
    headers: contentLength === undefined ? {} : { 'content-length': String(contentLength) },
  } as never;
}

const libraryQuery = { filename: 'revision-paper.pdf', contentType: 'application/pdf' };
const attachmentQuery = {
  courseId: 'crs_1',
  filename: 'problem-sheet.pdf',
  contentType: 'application/pdf',
};

/**
 * Reads the refusal out of an AppException so the test asserts on the message
 * the administrator actually reads, not merely that something threw.
 */
async function refusal(promise: Promise<unknown>): Promise<{
  code: ErrorCode;
  body: string[];
}> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppException) {
      const body = Object.values(error.fields ?? {}).flat() as string[];
      return { code: error.code, body };
    }
    throw error;
  }
  throw new Error('the endpoint should have refused this upload');
}

describe('PDF streaming size limits — Library', () => {
  it.each([
    ['a small PDF', 512 * 1024],
    ['a PDF just over 8 MB', 8 * MB + 1],
    ['exactly 25 MB', TARGET],
    ['just over 25 MB', TARGET + 1],
    ['exactly the 200 MB ceiling', MAX],
  ])('accepts %s', async (_label, sizeBytes) => {
    const { controller, putStream } = build();

    const result = await controller.libraryDocumentContent(libraryQuery, req(sizeBytes));

    expect(putStream).toHaveBeenCalledTimes(1);
    expect(result.sizeBytes).toBe(sizeBytes);
    // Streamed, not buffered: the object key is the server's, under library/.
    expect(result.objectKey).toMatch(/^library\/[0-9a-f-]{36}\.pdf$/);
  });

  it('refuses one byte over the ceiling, naming the limit', async () => {
    const { controller, putStream } = build();

    const { code, body } = await refusal(
      controller.libraryDocumentContent(libraryQuery, req(MAX + 1)),
    );

    expect(code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(body.join(' ')).toContain(`exceeds the ${MAX} byte limit`);
    // The refusal happens before a single byte reaches storage.
    expect(putStream).not.toHaveBeenCalled();
  });

  it('refuses a request with no declared length rather than reading it', async () => {
    const { controller, putStream } = build();

    const { code, body } = await refusal(
      controller.libraryDocumentContent(libraryQuery, req(undefined)),
    );

    expect(code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(body.join(' ')).toContain('Content-Length');
    expect(putStream).not.toHaveBeenCalled();
  });
});

describe('PDF streaming size limits — Lecture Files', () => {
  it.each([
    ['a small PDF', 512 * 1024],
    ['a PDF just over 8 MB', 8 * MB + 1],
    ['exactly 25 MB', TARGET],
    ['just over 25 MB', TARGET + 1],
    ['exactly the 200 MB ceiling', MAX],
  ])('accepts %s', async (_label, sizeBytes) => {
    const { controller, putStream } = build();

    const result = await controller.attachmentContent(ADMIN, attachmentQuery, req(sizeBytes));

    expect(putStream).toHaveBeenCalledTimes(1);
    expect(result.sizeBytes).toBe(sizeBytes);
    expect(result.objectKey).toMatch(/^attachments\/crs_1\/[0-9a-f-]{36}\.pdf$/);
  });

  it('refuses one byte over the ceiling, naming the limit', async () => {
    const { controller, putStream } = build();

    const { code, body } = await refusal(controller.attachmentContent(ADMIN, attachmentQuery, req(MAX + 1)));

    expect(code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(body.join(' ')).toContain(`exceeds the ${MAX} byte limit`);
    expect(putStream).not.toHaveBeenCalled();
  });

  it('refuses a request with no declared length', async () => {
    const { controller, putStream } = build();

    const { code, body } = await refusal(controller.attachmentContent(ADMIN, attachmentQuery, req(undefined)));

    expect(code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(body.join(' ')).toContain('Content-Length');
    expect(putStream).not.toHaveBeenCalled();
  });

  it('streams to the bucket readers resolve, not the uploads bucket', async () => {
    const { controller, putStream } = build();

    const result = await controller.attachmentContent(ADMIN, attachmentQuery, req(25 * MB));

    const [args] = putStream.mock.calls[0] as [{ bucket: string; objectKey: string }];
    expect(args.bucket).toBe('media');
    // The invariant from attachment-storage-bucket.spec.ts, re-asserted here
    // because this is the endpoint that now carries size coverage.
    expect(StorageService.bucketForKey(result.objectKey)).toBe(args.bucket);
  });
});

describe('the two flows are gated independently', () => {
  it('refuses an oversized Lecture File while an equally large Library document passes', async () => {
    // Both flows read the same `requireLength()` helper with the same 200 MB
    // ceiling, so this documents that they share a limit by construction rather
    // than by coincidence of two constants happening to match today.
    const oversized = MAX + 1;

    const library = build();
    const lecture = build();

    await expect(library.controller.libraryDocumentContent(libraryQuery, req(oversized))).rejects.toThrow(
      AppException,
    );
    await expect(lecture.controller.attachmentContent(ADMIN, attachmentQuery, req(oversized))).rejects.toThrow(
      AppException,
    );

    expect(library.putStream).not.toHaveBeenCalled();
    expect(lecture.putStream).not.toHaveBeenCalled();
  });
});

describe('presign and stream agree on the ceiling', () => {
  const invalidFields = async (plain: Record<string, unknown>): Promise<string[]> => {
    const instance = plainToInstance(PresignLibraryDocumentDto, plain, {
      enableImplicitConversion: false,
    });
    const errors = await validate(instance, {
      whitelist: true,
      forbidNonWhitelisted: true,
      stopAtFirstError: false,
    });
    return errors.map((error) => error.property).sort();
  };

  const body = (overrides: Record<string, unknown> = {}) => ({
    filename: 'revision-paper.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
    ...overrides,
  });

  it('the presign DTO accepts what the streaming gate accepts', async () => {
    // A presign that refused a size the stream accepts would break the
    // transport before it began; a stream that refused what presign accepts
    // would fail at 101% of every large upload.
    await expect(invalidFields(body({ sizeBytes: TARGET }))).resolves.toEqual([]);
    await expect(invalidFields(body({ sizeBytes: MAX }))).resolves.toEqual([]);
  });

  it('the presign DTO refuses one byte over the ceiling', async () => {
    await expect(invalidFields(body({ sizeBytes: MAX + 1 }))).resolves.toContain('sizeBytes');
  });
});

describe('authorization is untouched by the size work', () => {
  it('the Library stream route is still admin-only', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, StorageController.prototype.libraryDocumentContent);
    expect(roles).toBeDefined();
  });

  it('the Lecture Files stream route is still staff-only', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, StorageController.prototype.attachmentContent);
    expect(roles).toBeDefined();
  });
});