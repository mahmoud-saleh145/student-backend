import { ContentStatus, UserRole } from '@prisma/client';

import { ErrorCode } from '../../src/common/errors/error-codes';
import { LibraryDocumentsService } from '../../src/modules/library/library-documents.service';

/**
 * Opening a library document.
 *
 * This is the access boundary for paid content, so the tests are mostly about
 * refusal. The rule in one line:
 *
 *     no entitlement, no URL — and the object key never leaves the server.
 *
 * The last part matters as much as the first. Every other check is pointless if
 * the key itself is handed to the client, because the client could then fetch
 * the object directly and forever, rather than through a URL that expires.
 */

const STUDENT = {
  id: 'usr_1',
  role: UserRole.STUDENT,
  phone: '01000000000',
  fullName: 'Mahmoud Saleh',
  sessionId: 'ses_1',
  deviceId: 'dev_1',
  deviceKey: 'key_1',
  status: 'ACTIVE',
};

interface Options {
  entitlement?: { id: string; revokedAt: Date | null } | null;
  isPreview?: boolean;
  partStatus?: ContentStatus;
  materialStatus?: ContentStatus;
  role?: UserRole;
}

function build(options: Options = {}) {
  const part = {
    id: 'lp_1',
    title: 'Part 1 — Before Mid',
    objectKey: 'library/secret-object-key.pdf',
    mimeType: 'application/pdf',
    pageCount: 42,
    isPreview: options.isPreview ?? false,
    status: options.partStatus ?? ContentStatus.PUBLISHED,
    deletedAt: null,
    material: {
      title: 'Physics Revision Papers',
      status: options.materialStatus ?? ContentStatus.PUBLISHED,
      isActive: true,
      deletedAt: null,
    },
  };

  const prisma = {
    libraryPart: { findFirst: jest.fn(async () => part) },
    libraryEntitlement: {
      findUnique: jest.fn(async () => options.entitlement ?? null),
    },
    user: { findUniqueOrThrow: jest.fn(async () => ({ fullName: STUDENT.fullName })) },
  };

  // Typed parameters throughout. `jest.fn(async () => …)` infers its parameter
  // list as `[]`, so `mock.calls[0][0]` is a type error under `strict` — the
  // same trap codes.service.spec.ts documents, and the reason every mock below
  // names its arguments even where the body ignores them.
  const signMediaUrl = jest.fn(
    async (_params: {
      objectKey: string;
      expiresInSeconds: number;
      userId: string;
      sessionId?: string | null;
      deviceId?: string | null;
      ticketId?: string | null;
    }) => 'https://media.example/signed?exp=123&sig=abc',
  );
  const storage = { signMediaUrl };

  const assertAuthorizedForProtectedContent = jest.fn(async () => ({ deviceId: 'dev_1' }));
  const devices = { assertAuthorizedForProtectedContent };

  const record = jest.fn(async (_input: Record<string, unknown>) => undefined);
  const security = { record };

  const config = { getOrThrow: () => ({ ticketTtl: 120 }) };

  const service = new LibraryDocumentsService(
    prisma as never,
    devices as never,
    storage as never,
    security as never,
    config as never,
  );

  return { service, prisma, signMediaUrl, assertAuthorizedForProtectedContent, record };
}

function open(service: LibraryDocumentsService, role: UserRole = UserRole.STUDENT) {
  return service.issueTicket({
    libraryPartId: 'lp_1',
    user: { ...STUDENT, role },
    integritySuspect: false,
    ip: '10.0.0.1',
  });
}

describe('with an entitlement', () => {
  it('issues a signed URL and never the object key', async () => {
    const { service, signMediaUrl } = build({
      entitlement: { id: 'le_1', revokedAt: null },
    });

    const ticket = await open(service);

    expect(ticket.url).toBe('https://media.example/signed?exp=123&sig=abc');
    // The key is what gets signed, and it must not appear in the response.
    expect(signMediaUrl.mock.calls[0][0].objectKey).toBe('library/secret-object-key.pdf');
    expect(JSON.stringify(ticket)).not.toContain('secret-object-key');
  });

  it('binds the URL to the user, session and device', async () => {
    // A URL that works for anyone who gets hold of it is not protection.
    const { service, signMediaUrl } = build({
      entitlement: { id: 'le_1', revokedAt: null },
    });

    await open(service);

    expect(signMediaUrl.mock.calls[0][0]).toMatchObject({
      userId: 'usr_1',
      sessionId: 'ses_1',
      deviceId: 'dev_1',
      expiresInSeconds: 120,
    });
  });

  it('carries a watermark identifying the reader', async () => {
    const { service } = build({ entitlement: { id: 'le_1', revokedAt: null } });

    const ticket = await open(service);

    expect(ticket.watermark.primary).toBe('Mahmoud Saleh');
    expect(ticket.watermark.secondary).toContain('ID: ');
    expect(ticket.watermark.sessionTag).toHaveLength(16);
  });

  it('gives a different session tag every time', async () => {
    // So a leaked screenshot can be placed in time, not merely attributed.
    const { service } = build({ entitlement: { id: 'le_1', revokedAt: null } });

    const first = await open(service);
    const second = await open(service);

    expect(first.watermark.sessionTag).not.toBe(second.watermark.sessionTag);
  });

  it('checks the device before signing', async () => {
    const { service, assertAuthorizedForProtectedContent } = build({
      entitlement: { id: 'le_1', revokedAt: null },
    });

    await open(service);

    expect(assertAuthorizedForProtectedContent).toHaveBeenCalledTimes(1);
  });
});

describe('without an entitlement', () => {
  it('refuses, and signs nothing', async () => {
    const { service, signMediaUrl } = build({ entitlement: null });

    await expect(open(service)).rejects.toMatchObject({
      code: ErrorCode.PAYMENT_REQUIRED,
    });
    expect(signMediaUrl).not.toHaveBeenCalled();
  });

  it('refuses when the entitlement has been revoked', async () => {
    const { service, signMediaUrl } = build({
      entitlement: { id: 'le_1', revokedAt: new Date() },
    });

    await expect(open(service)).rejects.toMatchObject({
      code: ErrorCode.PAYMENT_REQUIRED,
    });
    expect(signMediaUrl).not.toHaveBeenCalled();
  });

  it('records the attempt as a security event', async () => {
    // Repeated attempts on documents someone does not own is the shape of an
    // account being probed or shared.
    const { service, record } = build({ entitlement: null });

    await expect(open(service)).rejects.toThrow();

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({
      userId: 'usr_1',
      metadata: { libraryPartId: 'lp_1' },
    });
  });
});

describe('previews and staff', () => {
  it('opens a preview without any entitlement', async () => {
    // The one documented way in without paying.
    const { service, signMediaUrl } = build({ isPreview: true, entitlement: null });

    const ticket = await open(service);

    expect(ticket.url).toBeTruthy();
    expect(signMediaUrl).toHaveBeenCalledTimes(1);
  });

  it('does not device-bind a preview', async () => {
    const { service, assertAuthorizedForProtectedContent } = build({
      isPreview: true,
      entitlement: null,
    });

    await open(service);

    expect(assertAuthorizedForProtectedContent).not.toHaveBeenCalled();
  });

  it('lets staff read without an entitlement, so review is possible', async () => {
    const { service, prisma } = build({ entitlement: null });

    const ticket = await open(service, UserRole.ADMIN);

    expect(ticket.url).toBeTruthy();
    // Staff skip the entitlement lookup entirely.
    expect(prisma.libraryEntitlement.findUnique).not.toHaveBeenCalled();
  });
});

describe('withdrawn material', () => {
  it('refuses an archived part even to someone who bought it', async () => {
    // The entitlement is not revoked and the purchase stands; only delivery is
    // withheld, exactly as an archived course stops playing.
    const { service, signMediaUrl } = build({
      entitlement: { id: 'le_1', revokedAt: null },
      partStatus: ContentStatus.ARCHIVED,
    });

    await expect(open(service)).rejects.toMatchObject({
      code: ErrorCode.COURSE_ARCHIVED,
    });
    expect(signMediaUrl).not.toHaveBeenCalled();
  });

  it('refuses when the whole material has been archived', async () => {
    const { service, signMediaUrl } = build({
      entitlement: { id: 'le_1', revokedAt: null },
      materialStatus: ContentStatus.ARCHIVED,
    });

    await expect(open(service)).rejects.toMatchObject({
      code: ErrorCode.COURSE_ARCHIVED,
    });
    expect(signMediaUrl).not.toHaveBeenCalled();
  });
});
