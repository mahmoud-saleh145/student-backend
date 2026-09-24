import { Readable } from 'node:stream';

import { StorageController } from '../../src/modules/storage/storage.controller';
import { StorageService } from '../../src/modules/storage/storage.service';

/**
 * Library documents live in their own bucket, and are read back from it.
 *
 * Two defects made this necessary, and the second was hidden by the first:
 *
 *  1. The presigned upload is a cross-origin browser PUT, so it needs a CORS
 *     policy on the bucket. Without one the preflight fails and no byte moves —
 *     which is all anyone ever saw.
 *  2. Documents were WRITTEN to `uploads` but READ through `signMediaUrl`,
 *     whose origin resolved a hard-coded `media` bucket. Even a successful
 *     upload produced a document that could never be opened.
 *
 * Both sides now derive the bucket from the key prefix, so the write and the
 * read cannot disagree. These cases pin that agreement.
 */

const PDF = 'application/pdf';

const STORAGE_CONFIG = {
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

function buildController() {
  const storage = new StorageService({ getOrThrow: () => STORAGE_CONFIG } as never);
  const putStream = jest
    .spyOn(storage, 'putStream')
    .mockResolvedValue(undefined as never);

  return { controller: new StorageController(storage), putStream };
}

/** A request carrying `bytes` of body, as the controller sees one. */
function request(bytes: number, body = 'x') {
  const stream = Readable.from([Buffer.from(body)]);
  return Object.assign(stream, {
    headers: { 'content-length': String(bytes) },
  });
}

// ---------------------------------------------------------------------------
// Where a key belongs
// ---------------------------------------------------------------------------

describe('StorageService.bucketForKey', () => {
  it('routes library documents to the library bucket', () => {
    expect(StorageService.bucketForKey('library/abc.pdf')).toBe('library');
  });

  it.each([
    ['hls/vid_1/master.m3u8'],
    ['hls/vid_1/720p/seg00001.ts'],
    ['thumbnails/videos/vid_1.jpg'],
    ['avatars/usr_1/abc.png'],
    ['captions/vid_1/en.vtt'],
    ['attachments/crs_1/notes.pdf'],
  ])('leaves %s on media, exactly as before', (key) => {
    // The video delivery path must be untouched by the split.
    expect(StorageService.bucketForKey(key)).toBe('media');
  });

  it('is not fooled by "library" appearing later in a key', () => {
    expect(StorageService.bucketForKey('attachments/crs_1/library-notes.pdf')).toBe('media');
    expect(StorageService.bucketForKey('hls/library/master.m3u8')).toBe('media');
  });
});

// ---------------------------------------------------------------------------
// The proxied upload
// ---------------------------------------------------------------------------

describe('POST /storage/uploads/library-document/content', () => {
  const query = { filename: 'revision.pdf', contentType: PDF };

  it('streams the body into the library bucket under a server-chosen key', async () => {
    const { controller, putStream } = buildController();

    const result = await controller.libraryDocumentContent(
      query as never,
      request(2048) as never,
    );

    expect(putStream).toHaveBeenCalledTimes(1);
    const args = (putStream.mock.calls[0] as unknown[])[0] as {
      bucket: string;
      objectKey: string;
      contentLength: number;
      contentType: string;
    };

    expect(args.bucket).toBe('library');
    expect(args.objectKey).toMatch(/^library\/[0-9a-f-]{36}\.pdf$/);
    expect(args.contentType).toBe(PDF);
    // Read from Content-Length, never from a client-asserted field.
    expect(args.contentLength).toBe(2048);
    expect(result).toEqual({ objectKey: args.objectKey, sizeBytes: 2048 });
  });

  it('never lets the client choose the key', async () => {
    const { controller, putStream } = buildController();

    await controller.libraryDocumentContent(
      { filename: 'notes.pdf', contentType: PDF } as never,
      request(10) as never,
    );
    await controller.libraryDocumentContent(
      { filename: 'notes.pdf', contentType: PDF } as never,
      request(10) as never,
    );

    const keys = putStream.mock.calls.map(
      (call) => ((call as unknown[])[0] as { objectKey: string }).objectKey,
    );
    expect(keys[0]).not.toBe(keys[1]);
  });

  it.each([
    ['a traversal attempt', '../../etc/passwd.pdf'],
    ['a path separator', 'dir/notes.pdf'],
  ])('refuses %s and writes nothing', async (_label, filename) => {
    const { controller, putStream } = buildController();

    await expect(
      controller.libraryDocumentContent(
        { filename, contentType: PDF } as never,
        request(10) as never,
      ),
    ).rejects.toBeDefined();

    expect(putStream).not.toHaveBeenCalled();
  });

  it('requires a Content-Length, because the upload streams', async () => {
    const { controller, putStream } = buildController();
    const noLength = Object.assign(Readable.from([Buffer.from('x')]), { headers: {} });

    await expect(
      controller.libraryDocumentContent(query as never, noLength as never),
    ).rejects.toBeDefined();

    expect(putStream).not.toHaveBeenCalled();
  });

  it('refuses a document over the 200 MB ceiling before reading a byte', async () => {
    const { controller, putStream } = buildController();

    await expect(
      controller.libraryDocumentContent(
        query as never,
        request(200 * 1024 * 1024 + 1) as never,
      ),
    ).rejects.toBeDefined();

    expect(putStream).not.toHaveBeenCalled();
  });

  it('accepts a document exactly at the ceiling', async () => {
    const { controller, putStream } = buildController();

    await controller.libraryDocumentContent(
      query as never,
      request(200 * 1024 * 1024) as never,
    );

    expect(putStream).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The write and the read must agree
// ---------------------------------------------------------------------------

describe('upload and read resolve the same bucket', () => {
  it('a key minted for upload is read back from the bucket it was written to', async () => {
    const { controller, putStream } = buildController();

    await controller.libraryDocumentContent(
      { filename: 'paper.pdf', contentType: PDF } as never,
      request(64) as never,
    );

    const { bucket, objectKey } = (putStream.mock.calls[0] as unknown[])[0] as {
      bucket: string;
      objectKey: string;
    };

    // This is the invariant the old code broke: written to one store, read
    // from another. Both sides now answer from the key alone.
    expect(StorageService.bucketForKey(objectKey)).toBe(bucket);
  });
});
