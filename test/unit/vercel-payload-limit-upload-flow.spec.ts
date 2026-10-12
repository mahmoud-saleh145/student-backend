import 'reflect-metadata';

import { StorageService } from 'src/modules/storage/storage.service';

/**
 * THE VERCEL 4.5 MB FAILURE
 * =========================
 *
 * Documents were POSTed to `/api/upload/attachment` and
 * `/api/upload/library-document`. Both are Vercel Functions, and Vercel refuses
 * a Function request body over 4.5 MB with:
 *
 *     413 FUNCTION_PAYLOAD_TOO_LARGE      content-length: 9265916
 *
 * A 9 MB lecture PDF therefore failed before the API ever saw it. Raising the
 * API's 200 MB limit could not help: the request never arrived.
 *
 * The fix puts the bytes on a presigned PUT straight from the browser, so the
 * only thing crossing a Function is the JSON authorisation and registration
 * calls. This file pins the properties that make that true and that must not
 * silently regress.
 *
 * Scope, stated precisely: this is a LOCAL, STATIC argument about the code
 * paths. It does not prove anything about deployed behaviour — only a real
 * upload against a deployed dashboard can do that.
 */

const MB = 1024 * 1024;
const VERCEL_FUNCTION_BODY_LIMIT = 4.5 * MB;
const MAX = 200 * MB;

/** The exact size from the production incident. */
const THE_FILE_THAT_FAILED = 9_265_916;

function dashboardSource(relative: string): string {
  return readFileSync(join(__dirname, '../../../edu-dashboard', relative), 'utf8');
}

describe('the size that actually failed in production', () => {
  it('is far above the limit it hit', () => {
    // The number in the report, not a guess: 9 265 916 bytes against a
    // 4.5 MB (4 718 592 byte) Function cap.
    expect(THE_FILE_THAT_FAILED).toBeGreaterThan(VERCEL_FUNCTION_BODY_LIMIT);
    expect(VERCEL_FUNCTION_BODY_LIMIT).toBe(4_718_592);
  });

  it('is comfortably inside what the API would have accepted', () => {
    // Which is the whole difficulty: both limits could have been "fixed" and
    // the upload still would not have worked, because the failing one was
    // Vercel's, in front of the API.
    expect(THE_FILE_THAT_FAILED).toBeLessThan(MAX);
  });
});

describe('no PDF bytes are posted to a Vercel Function', () => {
  it.each([
    ['Lecture Files', 'src/features/courses/attachments-panel.tsx'],
    ['Library', 'src/features/library/upload.ts'],
  ])('%s never sends the file through /api/upload', (_label, path) => {
    const source = dashboardSource(path);

    // The shape that failed: a fetch/XHR whose body is the File, aimed at one
    // of the Function routes.
    const sendsFileAsBody = /body:\s*file\b/.test(source);
    const postsFile =
      /request\.send\(file\)/.test(source) || /method:\s*'POST'[\s\S]{0,200}body:\s*file/.test(source);

    expect(sendsFileAsBody).toBe(false);
    expect(postsFile).toBe(false);
  });

  it.each([
    ['Lecture Files', 'src/features/courses/attachments-panel.tsx'],
    ['Library', 'src/features/library/upload.ts'],
  ])('%s uses the direct PUT helper instead', (_label, path) => {
    const source = dashboardSource(path);

    expect(source).toContain('putToStorage');
    // The PUT is a PUT, and it targets the presigned URL from the API.
    expect(source).toContain('signed.objectKey');
  });

  it('the PUT is a PUT, and goes to the URL the API returned', () => {
    const source = dashboardSource('src/features/uploads/direct-upload.ts');

    expect(source).toContain("request.open('PUT', upload.uploadUrl, true)");
  });
});

describe('only JSON crosses the Function', () => {
  it('the authorisation call carries the declared size, not the bytes', () => {
    // `sizeBytes: file.size` is a NUMBER. This is what keeps the Function
    // request small: the size travels, the file does not.
    const attachments = dashboardSource('src/features/courses/attachments-panel.tsx');
    const library = dashboardSource('src/features/library/upload.ts');

    expect(attachments).toContain('sizeBytes: file.size');
    expect(library).toContain('sizeBytes: file.size');
  });

  it('registration sends the key and a size, never the file', () => {
    const attachments = dashboardSource('src/features/courses/attachments-panel.tsx');

    // `create.mutateAsync` is the existing registration hook; it serialises to
    // JSON through the proxy, which is where the file must not appear.
    expect(attachments).toContain('create.mutateAsync');
    expect(attachments).toContain('objectKey: signed.objectKey');
  });
});

describe('the API endpoints the new flow depends on', () => {
  const config = {
    accountId: 'acct-test',
    accessKeyId: 'ak',
    secretAccessKey: 'sk',
    region: 'auto',
    endpoint: 'https://acct.r2.cloudflarestorage.com',
    forcePathStyle: true,
    buckets: { media: 'm', uploads: 'u', library: 'l' },
    cdnBaseUrl: 'https://cdn.test',
    signingKey: 'k',
  };

  it('a presigned PUT is bound to one key and one content type, and expires', async () => {
    const storage = new StorageService({ getOrThrow: () => config } as never, {} as never);

    const signed = await storage.presignUpload({
      bucket: 'media',
      objectKey: StorageService.keys.attachment('crs_1', 'slides.pdf'),
      contentType: 'application/pdf',
      expiresIn: 3600,
    });

    expect(signed.objectKey).toMatch(/^attachments\/crs_1\/[0-9a-f-]{36}\.pdf$/);
    expect(signed.requiredHeaders).toEqual({ 'Content-Type': 'application/pdf' });
    // Scoped to one key and an hour, not a general write credential. The
    // credential is also scoped to exactly `PutObject` and only signs `host` —
    // so the URL is worthless for anything but this one PUT.
    expect(signed.uploadUrl).toContain(signed.objectKey);
    expect(signed.uploadUrl).toContain('X-Amz-Expires=3600');
    expect(signed.uploadUrl).toContain('X-Amz-SignedHeaders=host');
    expect(signed.uploadUrl).toContain('x-id=PutObject');
    expect(signed.expiresIn).toBe(3600);
  });

  it('the object key is the server’s, never the client’s', () => {
    // A client cannot choose a key: a UUID is minted per upload and the
    // filename contributes only an extension.
    const key = StorageService.keys.attachment('crs_1', '../../evil.pdf');

    expect(key).toMatch(/^attachments\/crs_1\/[0-9a-f-]{36}\.pdf$/);
    expect(key).not.toContain('..');
  });

  it('the two flows keep their own buckets', () => {
    expect(StorageService.bucketForKey(StorageService.keys.attachment('crs_1', 'a.pdf'))).toBe('media');
    expect(StorageService.bucketForKey(StorageService.keys.libraryDocument('a.pdf'))).toBe('library');
  });
});

describe('registration still measures what actually landed', () => {
  /**
   * The direct PUT changes who moves the bytes, not who decides whether the
   * object is acceptable. These assertions restate that the size the API
   * persists is read from storage — the full behaviour, including the
   * unattested edge cases, is in `presigned-upload-size-verification.spec.ts`.
   */
  it('AttachmentsService.create verifies against storage, not the request', () => {
    const source = readFileSync(
      join(__dirname, '../../src/modules/attachments/attachments.service.ts'),
      'utf8',
    );

    expect(source).toContain('assertUploadWithinLimit');
    expect(source).toContain("bucket: 'media'");
    // The declared size must not reach the row.
    expect(source).not.toContain('sizeBytes: input.sizeBytes');
  });

  it('LibraryService verifies too, and on a replacement', () => {
    const source = readFileSync(
      join(__dirname, '../../src/modules/library/library.service.ts'),
      'utf8',
    );

    expect(source).toContain("bucket: 'library'");
    // createPart and updatePart each verify.
    expect(source.match(/assertUploadWithinLimit/g)?.length).toBe(2);
  });

  it('a successful PUT alone does not create a document', () => {
    const attachments = dashboardSource('src/features/courses/attachments-panel.tsx');

    // Registration is a separate awaited call AFTER the PUT resolves.
    const putAt = attachments.indexOf('await putToStorage');
    const createAt = attachments.indexOf('await create.mutateAsync');

    expect(putAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(putAt);
  });
});

describe('the dead Function routes', () => {
  it.each([['attachment'], ['library-document']])(
    'the %s route no longer has a caller',
    (route) => {
      // They still exist and still stream, so a future caller could walk back
      // into the 413. This asserts nothing in src/ points at them any more.
      const root = join(__dirname, '../../../edu-dashboard', 'src');
      const callers: string[] = [];

      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (/\.tsx?$/.test(entry.name)) {
            const text = readFileSync(full, 'utf8');
            if (text.includes(`/api/upload/${route}`)) {
              // Comments are fine; only executable references matter.
              const live = text
                .split('\n')
                .some((l) => l.includes(`/api/upload/${route}`) && !/^\s*(\*|\/\/)/.test(l));
              if (live) callers.push(full);
            }
          }
        }
      };

      walk(root);
      expect(callers).toEqual([]);
    },
  );
});

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';