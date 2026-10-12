import 'reflect-metadata';

import { UserRole } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { AttachmentsService } from 'src/modules/attachments/attachments.service';
import { LibraryService } from 'src/modules/library/library.service';
import { MAX_DOCUMENT_BYTES, StorageService } from 'src/modules/storage/storage.service';

/**
 * REGISTRATION-TIME SIZE VERIFICATION
 * ===================================
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * Both PDF flows upload by PRESIGNED PUT. `presignUpload` signs `host` and
 * nothing else, and R2 does not honour `x-amz-content-length-range` - the
 * comment at storage.service.ts says so. So nothing bound the bytes a client
 * actually uploaded to the `sizeBytes` it declared:
 *
 *     POST /storage/uploads/library-document   { sizeBytes: 1024 }   -> 200
 *     PUT  <presigned URL>                     5 GB of bytes        -> 201
 *     POST /library/materials/:id/parts        { sizeBytes: 1024 }   -> 201
 *
 * The row then records a 5 GB object as 1 KB, and the library serves it. The
 * registration DTO could not catch this: `sizeBytes` there is capped at
 * `@Min(0)`, because the number being checked is the attacker's own.
 *
 * THE FIX
 * -------
 * Size is read back from storage with a HEAD at registration, and that measured
 * number is what gets persisted. These tests drive the REAL services against a
 * fake Prisma and a real `StorageService.assertUploadWithinLimit`, so the
 * bucket, the ordering of the checks, and the persisted value are all the
 * production ones.
 *
 * SCOPE, STATED PLAINLY
 * ---------------------
 * This stops an oversized object being REGISTERED. It does not stop the bytes
 * landing in the bucket: a presigned PUT is spent the moment it is issued, and
 * R2 accepts it up to 5 GB. See the note at the foot of this file.
 */

const MB = 1024 * 1024;
const MAX = MAX_DOCUMENT_BYTES;

/** `objectSize` returns null for BOTH "absent" and "unreachable" - same input. */
const UNAVAILABLE = null;

const LIBRARY_KEY = 'library/2f1c9e4a-1111-4222-8333-444444444444.pdf';
const ATTACHMENT_KEY = 'attachments/crs_1/2f1c9e4a-1111-4222-8333-444444444444.pdf';

// ---------------------------------------------------------------------------
// StorageService.assertUploadWithinLimit - the shared gate
// ---------------------------------------------------------------------------

/**
 * A real StorageService whose HEAD reports `size`, or throws when it is
 * UNAVAILABLE - which is what an unreachable bucket does, and which
 * `objectSize` turns into `null`.
 *
 * Built through the real constructor so `bucketName` resolves from real config,
 * then the S3 client is swapped for a stub. SigV4 never contacts anything, so
 * this exercises production `assertUploadWithinLimit` end to end.
 */
function buildStorage(size: number | typeof UNAVAILABLE): StorageService {
  const cfg = {
    accountId: 'acct-test',
    accessKeyId: 'test-access-key-id',
    secretAccessKey: 'test-secret-access-key',
    region: 'auto',
    endpoint: 'https://acct-test.r2.cloudflarestorage.com',
    forcePathStyle: true,
    buckets: {
      media: 'edu-media-test',
      uploads: 'edu-uploads-test',
      library: 'edu-library-test',
    },
    cdnBaseUrl: 'https://cdn.example.test',
    signingKey: 'signing-key-for-tests',
  };

  const client = {
    send: jest.fn(async () => {
      if (size === UNAVAILABLE) throw new Error('storage unreachable');
      return { ContentLength: size };
    }),
  };

  const svc = new StorageService(
    { getOrThrow: () => cfg } as never,
    {} as never,
  );
  Object.assign(svc, { client });
  return svc;
}

describe('assertUploadWithinLimit', () => {
  it.each([
    ['a small file', 512 * 1024],
    ['25 MB', 25 * MB],
    ['exactly the limit', MAX],
  ])('returns the measured size for %s', async (_label, size) => {
    const storage = buildStorage(size);

    await expect(
      storage.assertUploadWithinLimit({
        bucket: 'library',
        objectKey: LIBRARY_KEY,
        maxBytes: MAX,
      }),
    ).resolves.toBe(size);
  });

  it('refuses one byte over the limit, naming it', async () => {
    const storage = buildStorage(MAX + 1);

    try {
      await storage.assertUploadWithinLimit({
        bucket: 'library',
        objectKey: LIBRARY_KEY,
        maxBytes: MAX,
        field: 'sizeBytes',
      });
      throw new Error('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      const exc = error as AppException;
      expect(exc.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(exc.fields?.sizeBytes?.[0]).toContain(`${MAX} byte limit`);
      // And the message names the ceiling in the units an admin reads.
      expect(exc.message).toContain('200 MB');
    }
  });

  it('refuses rather than registering when the object is unverifiable', async () => {
    // Fails closed. Treating "could not check" as "fine" is the same mistake
    // as trusting the declared size, so it refuses.
    const storage = buildStorage(UNAVAILABLE);

    try {
      await storage.assertUploadWithinLimit({
        bucket: 'library',
        objectKey: LIBRARY_KEY,
        maxBytes: MAX,
      });
      throw new Error('should have refused');
    } catch (error) {
      expect((error as AppException).code).toBe(ErrorCode.UPLOAD_FAILED);
    }
  });

  it('distinguishes missing from oversized, so a client knows whether to retry', async () => {
    const gone = buildStorage(UNAVAILABLE);
    const big = buildStorage(MAX + 1);

    const codeOf = async (storage: StorageService) => {
      try {
        await storage.assertUploadWithinLimit({
          bucket: 'library',
          objectKey: LIBRARY_KEY,
          maxBytes: MAX,
        });
        return null;
      } catch (error) {
        return (error as AppException).code;
      }
    };

    expect(await codeOf(gone)).toBe(ErrorCode.UPLOAD_FAILED);
    expect(await codeOf(big)).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('reads the bucket it is given, never one inferred from the key', async () => {
    // A verification pointed at the wrong bucket would report every legitimate
    // object as missing - the same class of bug as the write/read drift.
    const storage = buildStorage(1024);

    await storage.assertUploadWithinLimit({
      bucket: 'library',
      objectKey: LIBRARY_KEY,
      maxBytes: MAX,
    });

    const sent = (storage as unknown as { client: { send: jest.Mock } }).client.send;
    const command = sent.mock.calls[0]![0] as { input: { Bucket: string; Key: string } };
    expect(command.input.Bucket).toBe('edu-library-test');
    expect(command.input.Key).toBe(LIBRARY_KEY);
  });
});

// ---------------------------------------------------------------------------
// AttachmentsService.create - the Lecture Files registration site
// ---------------------------------------------------------------------------

const ADMIN = { id: 'usr_1', role: UserRole.ADMIN } as const;

function buildAttachments(actual: number | typeof UNAVAILABLE) {
  const prisma = {
    lesson: { findFirst: jest.fn(async () => ({ id: 'les_1' })) },
    courseSection: { findFirst: jest.fn(async () => ({ id: 'sec_1' })) },
    attachment: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => args.data),
    },
  };

  const access = { assertCanManageCourse: jest.fn(async () => undefined) };
  const devices = {};
  const audit = { record: jest.fn(async () => undefined) };
  const security = { record: jest.fn(async () => undefined) };
  const config = { getOrThrow: () => ({ ticketTtl: 300 }) };

  // A real StorageService, so the gate under test is the production one.
  const storage = Object.assign(buildStorage(actual), {
    signMediaUrl: jest.fn(async () => 'https://gate.example/x'),
  });

  const service = new AttachmentsService(
    prisma as never,
    access as never,
    devices as never,
    storage as never,
    security as never,
    audit as never,
    config as never,
  );

  return { service, prisma, storage, access };
}

const attachmentInput = (overrides: Record<string, unknown> = {}) => ({
  courseId: 'crs_1',
  lessonId: 'les_1',
  title: 'Slides',
  kind: 'PDF' as const,
  objectKey: ATTACHMENT_KEY,
  ...overrides,
});

describe('Lecture Files registration', () => {
  it.each([
    ['a small file', 512 * 1024, 512 * 1024],
    ['25 MB', 25 * MB, 25 * MB],
    // Within the limit, so the only thing under test is that the measured
    // value wins - not the refusal, which has its own cases below.
    ['the declared size UNDERSTATES the real one', 1024, 180 * MB],
    ['the declared size OVERSTATES the real one', 150 * MB, 2 * MB],
  ])('persists the measured size, not the declared one: %s', async (_l, declared, actual) => {
    const t = buildAttachments(actual);

    const row = await t.service.create(
      attachmentInput({ sizeBytes: declared }),
      ADMIN as never,
    );

    expect(Number(row.sizeBytes)).toBe(actual);
  });

  it('refuses an oversized object even when the client declared a small one', async () => {
    // The attack end to end: declare 1 KB, upload 5 GB.
    const t = buildAttachments(5 * 1024 * MB);

    await expect(
      t.service.create(attachmentInput({ sizeBytes: 1024 }), ADMIN as never),
    ).rejects.toThrow(AppException);

    expect(t.prisma.attachment.create).not.toHaveBeenCalled();
  });

  it('refuses to register when storage cannot confirm the object', async () => {
    const t = buildAttachments(UNAVAILABLE);

    await expect(
      t.service.create(attachmentInput({ sizeBytes: 1024 }), ADMIN as never),
    ).rejects.toThrow(AppException);

    expect(t.prisma.attachment.create).not.toHaveBeenCalled();
  });

  it('verifies against the media bucket, the one attachments are written to', async () => {
    const t = buildAttachments(1024);

    await t.service.create(attachmentInput({ sizeBytes: 1024 }), ADMIN as never);

    const sent = (t.storage as unknown as { client: { send: jest.Mock } }).client.send;
    const command = sent.mock.calls[0]![0] as { input: { Bucket: string } };
    expect(command.input.Bucket).toBe('edu-media-test');
  });
});

// ---------------------------------------------------------------------------
// LibraryService.createPart / updatePart - the Library registration sites
// ---------------------------------------------------------------------------

function buildLibrary(actual: number | typeof UNAVAILABLE) {
  // `createPart` returns `materialForAdmin(materialId)`, so the material double
  // needs the shape that serializer walks. The point of these tests is what was
  // verified and persisted, not the admin projection, so it is kept minimal but
  // complete enough not to throw on the way out.
  const material = {
    id: 'mat_1',
    title: 'Physics Papers',
    titleAr: null,
    description: null,
    coverKey: null,
    subject: null,
    parts: [],
    packages: [],
  };

  const prisma = {
    libraryMaterial: {
      findFirst: jest.fn(async () => material),
    },
    libraryPart: {
      findFirst: jest.fn(async () => ({ id: 'lp_1', materialId: 'mat_1', objectKey: LIBRARY_KEY })),
      create: jest.fn(async (args: { data: Record<string, unknown> }) => args.data),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => args.data),
    },
    libraryEntitlement: { count: jest.fn(async () => 0) },
  };

  // `createPart` writes through a transaction handle, so the row is captured
  // here rather than on `prisma.libraryPart.create`, which it never reaches.
  const txCreate = jest.fn(async (args: { data: Record<string, unknown> }) => args.data);

  const prismaWithTx = {
    ...prisma,
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        libraryPart: {
          findFirst: jest.fn(async () => ({ sortOrder: 1 })),
          create: txCreate,
        },
      }),
    ),
  };

  const audit = { record: jest.fn(async () => undefined) };
  const settings = { libraryDefaultThumbnailKey: jest.fn(async () => null) };
  const storage = Object.assign(buildStorage(actual), {
    publicAssetUrl: jest.fn(async () => null),
  });

  const service = new LibraryService(
    prismaWithTx as never,
    audit as never,
    storage as never,
    settings as never,
  );

  return { service, prisma: prismaWithTx, storage, txCreate };
}

/** The `sizeBytes` the row was actually created with. */
function createdSize(t: ReturnType<typeof buildLibrary>): number | undefined {
  const create = t.txCreate.mock.calls[0]![0] as { data: { sizeBytes: bigint } };
  return Number(create.data.sizeBytes);
}

const partInput = (overrides: Record<string, unknown> = {}) => ({
  title: 'Paper 1',
  price: 50,
  objectKey: LIBRARY_KEY,
  ...overrides,
});

describe('Library registration', () => {
  it.each([
    ['a small file', 512 * 1024, 512 * 1024],
    ['25 MB', 25 * MB, 25 * MB],
    // Within the limit, so the only thing under test is that the measured
    // value wins - not the refusal, which has its own cases below.
    ['the declared size UNDERSTATES the real one', 1024, 180 * MB],
    ['the declared size OVERSTATES the real one', 150 * MB, 2 * MB],
  ])('persists the measured size, not the declared one: %s', async (_l, declared, actual) => {
    const t = buildLibrary(actual);

    await t.service.createPart('mat_1', partInput({ sizeBytes: declared }), ADMIN as never);

    expect(createdSize(t)).toBe(actual);
  });

  it('verifies against the library bucket', async () => {
    const t = buildLibrary(1024);

    await t.service.createPart('mat_1', partInput({ sizeBytes: 1024 }), ADMIN as never);

    const sent = (t.storage as unknown as { client: { send: jest.Mock } }).client.send;
    const command = sent.mock.calls[0]![0] as { input: { Bucket: string } };
    expect(command.input.Bucket).toBe('edu-library-test');
  });

  it('refuses an oversized document even when the client declared a small one', async () => {
    const t = buildLibrary(5 * 1024 * MB);

    await expect(
      t.service.createPart('mat_1', partInput({ sizeBytes: 1024 }), ADMIN as never),
    ).rejects.toThrow(AppException);

    expect(t.txCreate).not.toHaveBeenCalled();
  });

  it('refuses to register when storage cannot confirm the document', async () => {
    const t = buildLibrary(UNAVAILABLE);

    await expect(
      t.service.createPart('mat_1', partInput({ sizeBytes: 1024 }), ADMIN as never),
    ).rejects.toThrow(AppException);

    expect(t.txCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// updatePart - the route that would otherwise bypass the create-time check
// ---------------------------------------------------------------------------

describe('replacing a Library document', () => {
  // Deliberately NOT the part's current key: `updatePart` only verifies when
  // the key actually CHANGES, and a test using the same key would pass by
  // skipping the very branch it is meant to cover.
  const REPLACEMENT_KEY = 'library/9a8b7c6d-5555-4666-8777-888888888888.pdf';

  it('verifies the replacement before it is written', async () => {
    // Create a valid part, then PATCH an oversized object onto it. Without a
    // check here the create-time verification is simply routed around.
    const t = buildLibrary(5 * 1024 * MB);

    await expect(
      t.service.updatePart('lp_1', { objectKey: REPLACEMENT_KEY }, ADMIN as never),
    ).rejects.toThrow(AppException);

    expect(t.prisma.libraryPart.update).not.toHaveBeenCalled();
  });

  it('persists the measured size of a legitimate replacement', async () => {
    const t = buildLibrary(7 * MB);

    await t.service.updatePart(
      'lp_1',
      { objectKey: REPLACEMENT_KEY, sizeBytes: 1024 },
      ADMIN as never,
    );

    const update = t.prisma.libraryPart.update.mock.calls[0]![0] as {
      data: { sizeBytes: number };
    };
    expect(update.data.sizeBytes).toBe(7 * MB);
  });

  it('leaves a metadata-only edit alone, with no storage round trip', async () => {
    // A price change must not require the object to still be readable.
    const t = buildLibrary(UNAVAILABLE);

    await t.service.updatePart('lp_1', { price: 75 }, ADMIN as never);

    const sent = (t.storage as unknown as { client: { send: jest.Mock } }).client.send;
    expect(sent).not.toHaveBeenCalled();
    expect(t.prisma.libraryPart.update).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Existing protections
// ---------------------------------------------------------------------------

describe('existing protections are intact', () => {
  it('the attachment namespace check still refuses an off-namespace key', async () => {
    const t = buildAttachments(1024);

    await expect(
      t.service.create(
        attachmentInput({ objectKey: 'attachments/crs_OTHER/x.pdf' }),
        ADMIN as never,
      ),
    ).rejects.toThrow(AppException);

    expect(t.prisma.attachment.create).not.toHaveBeenCalled();
  });

  it('course authorization still runs before anything is written', async () => {
    const t = buildAttachments(1024);

    await t.service.create(attachmentInput(), ADMIN as never);

    expect(t.access.assertCanManageCourse).toHaveBeenCalled();
  });

  it('a Library key outside library/ is still refused', async () => {
    const t = buildLibrary(1024);

    await expect(
      t.service.createPart(
        'mat_1',
        partInput({ objectKey: 'attachments/crs_1/x.pdf' }),
        ADMIN as never,
      ),
    ).rejects.toThrow(AppException);
  });

  it('the shared ceiling is still 200 MB', () => {
    expect(MAX_DOCUMENT_BYTES).toBe(200 * 1024 * 1024);
  });

  it('the upload endpoints gate on this same number, not a second literal', () => {
    // Read from source rather than reflect: the controller's constants are
    // module-private, and what matters is that they are ALIASES of this one.
    // A re-spelled `200 * 1024 * 1024` in the controller would compile fine and
    // reintroduce exactly the drift this constant exists to prevent.
    const controller = readFileSync(
      join(__dirname, '../../src/modules/storage/storage.controller.ts'),
      'utf8',
    );

    expect(controller).toContain(
      'const MAX_LIBRARY_DOCUMENT_BYTES = MAX_DOCUMENT_BYTES;',
    );
    expect(controller).toContain('const MAX_ATTACHMENT_BYTES = MAX_DOCUMENT_BYTES;');
    // No remaining inline literal for either document ceiling.
    expect(controller).not.toMatch(/MAX\(\s*200 \* 1024 \* 1024\s*\)/);
  });
});

/*
 * WHAT THIS DOES NOT FIX
 * ----------------------
 * The oversized bytes still reach the bucket. A presigned PUT is spent the
 * moment it is issued and R2 accepts a single PUT up to 5 GB, so between
 * presign and registration an authorised user can occupy storage this code
 * never sees. R2 does not honour `x-amz-content-length-range`, so it cannot be
 * constrained from the signature.
 *
 * Closing that would need a different architecture, not a patch:
 *   - a lifecycle rule on the `library`/`media` prefixes deleting unreferenced
 *     objects after N hours (a storage cost control, not a request-time one), or
 *   - a Cloudflare Worker in front of the PUT that counts bytes.
 *
 * Both are separate changes with real compatibility risk, so neither was made.
 */