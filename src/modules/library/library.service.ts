import { Injectable, Logger } from '@nestjs/common';
import {
  type AcademicStructureKind,
  AuditAction,
  ContentStatus,
  LibraryDepartmentScope,
  type Prisma,
  UserRole,
} from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { paginated } from '../../common/types/api-response';
import { PrismaService, notDeleted } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  LIBRARY_PLACEMENT,
  checkAcademicStructure,
  checkYearInLadder,
} from '../catalog/academic-placement';
import { CatalogService } from '../catalog/catalog.service';
import {
  assertObjectKeyInNamespace,
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
  StorageService,
} from '../storage/storage.service';
import { PlatformSettingsService } from '../settings/platform-settings.service';

import {
  LibraryEligibilityService,
  MATERIAL_AUDIENCE_SELECT,
  PUBLISHED_MATERIAL,
  toAudience,
} from './library-eligibility.service';

/**
 * What one student can do with one part right now. Precedence, first match
 * wins:
 *
 *   OWNED        an unrevoked entitlement: read as an owner
 *   PREVIEW      a free sample the student may open right now (the full view
 *                already implies storefront on, in scope and published)
 *   REVOKED      an entitlement exists but was revoked and nothing else is
 *                offered (never ownership, never for sale again)
 *   PURCHASABLE  storefront on, in scope, on sale, priced
 *   UNAVAILABLE  anything else
 *
 * Decision B: revocation and preview eligibility are separate. A revoked
 * entitlement never grants owned access, but it does not take away a free
 * preview the student is otherwise eligible for, so PREVIEW outranks REVOKED.
 * What the student owns is reported on its own, as `ownership`, so a revoked
 * preview part still says it was revoked.
 */
export type LibraryPartAccess = 'OWNED' | 'REVOKED' | 'PREVIEW' | 'PURCHASABLE' | 'UNAVAILABLE';

/**
 * What the student holds for one part, independent of what they can do:
 * an unrevoked entitlement, a revoked one, or none.
 */
export type LibraryPartOwnership = 'OWNED' | 'REVOKED' | 'NONE';
export type LibraryPackageAccess = 'OWNED' | 'PURCHASABLE' | 'UNAVAILABLE';

/**
 * The audience block: written and validated as one unit.
 *
 * The years come as `academicYearIds` (the list) or, from a client that
 * predates the list, as the single `academicYearId`; either one satisfies the
 * "send the whole audience" rule, and the list wins when both are present.
 */
const AUDIENCE_KEYS = [
  'universityId',
  'facultyId',
  'departmentScope',
  'departmentIds',
  'academicYearIds',
] as const;

interface AudienceInput {
  universityId: string | null;
  facultyId: string | null;
  departmentScope: LibraryDepartmentScope;
  departmentIds: string[];
  /** De-duplicated. Empty means "all years". */
  academicYearIds: string[];
}

/**
 * The year/level links as every read loads them: in ladder order, with the
 * structure's kind so a client can label the rung "Year" or "Level".
 */
const MATERIAL_YEARS_SELECT = {
  orderBy: { academicYear: { order: 'asc' as const } },
  select: {
    academicYear: {
      select: {
        id: true,
        name: true,
        nameAr: true,
        order: true,
        structure: { select: { kind: true } },
      },
    },
  },
} as const;

interface MaterialYearLink {
  academicYear: {
    id: string;
    name: string;
    nameAr: string;
    order: number;
    structure: { kind: AcademicStructureKind };
  };
}

export interface AcademicYearRef {
  id: string;
  name: string;
  nameAr: string;
  kind: AcademicStructureKind;
}

/** The rungs a material is filed under, in ladder order. Tolerates a row loaded without the relation. */
function academicYearRefs(links: MaterialYearLink[] | undefined): AcademicYearRef[] {
  return (links ?? []).map((link) => ({
    id: link.academicYear.id,
    name: link.academicYear.name,
    nameAr: link.academicYear.nameAr,
    kind: link.academicYear.structure.kind,
  }));
}

/**
 * The year/level browsing filter.
 *
 * A material filed under the requested rung matches, and so does a material
 * filed under NO rung: "all years" means every year, this one included. The
 * filter can therefore only narrow the eligible list, never surface anything
 * outside it — eligibility is a separate `AND` branch (B7).
 */
export function academicYearFilter(academicYearId: string): Prisma.LibraryMaterialWhereInput {
  return {
    OR: [
      { academicYears: { some: { academicYearId } } },
      { academicYears: { none: {} } },
    ],
  };
}

/**
 * Normalises the two ways a client can send the years into one list.
 *
 * `undefined` for both means "not sent" (an edit that leaves the audience
 * alone); the caller decides what that means. Otherwise the list wins, then
 * the legacy single id, and `null` for the legacy id is an explicit clear.
 */
function academicYearIdsFrom(input: {
  academicYearId?: string | null;
  academicYearIds?: string[];
}): string[] | undefined {
  if (input.academicYearIds !== undefined) return [...new Set(input.academicYearIds)];
  if (input.academicYearId !== undefined) return input.academicYearId ? [input.academicYearId] : [];
  return undefined;
}

/** A published part, as the catalogue would show it. */
const PUBLISHED_PART = {
  ...notDeleted,
  isActive: true,
  status: ContentStatus.PUBLISHED,
} as const;

/**
 * Library structure, and what a student sees of it.
 *
 * The Library is a separate top-level system: nothing here references a course,
 * an enrollment or a section. What a student sees is decided by two independent
 * layers — academic visibility (LibraryEligibilityService, unconditional) and
 * the storefront switch (fail-closed) — and what they can OPEN is decided
 * separately, per part, by entitlement (library-documents.service.ts).
 */
@Injectable()
export class LibraryService {
  private readonly logger = new Logger(LibraryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    // SettingsModule is @Global, so this arrives without a module import and
    // without risking a cycle back into the library.
    private readonly settings: PlatformSettingsService,
    private readonly eligibility: LibraryEligibilityService,
    private readonly catalog: CatalogService,
  ) {}

  /**
   * Holds a submitted document/thumbnail key to the namespace it was issued from.
   *
   * The document key matters most: it is the thing an entitlement check is later
   * performed against, so a key from anywhere but `library/` would let a part
   * point at an object that was never uploaded as part of this material. The
   * thumbnail key feeds an **unsigned** CDN URL, so without this it could name
   * any object in the bucket at all.
   */
  private assertLibraryPartKeys(
    objectKey: string | null | undefined,
    thumbnailKey: string | null | undefined,
    thumbnailNamespace: string,
  ): void {
    if (objectKey) {
      assertObjectKeyInNamespace(
        objectKey,
        StorageService.LIBRARY_DOCUMENT_PREFIX,
        'objectKey',
      );
    }
    if (thumbnailKey) {
      assertObjectKeyInNamespace(thumbnailKey, thumbnailNamespace, 'thumbnailKey');
    }
  }

  /**
   * The image to show for a library part.
   *
   * Three tiers, most specific first: the part's own thumbnail, the
   * material's cover, then the platform default. Resolved HERE, on read,
   * rather than written onto the row.
   */
  private async resolvePartThumbnailUrl(
    partThumbnailKey: string | null,
    materialCoverKey: string | null,
    defaultKey: string | null,
  ): Promise<string | null> {
    const key = partThumbnailKey ?? materialCoverKey ?? defaultKey;
    return key ? this.storage.publicAssetUrl(key) : null;
  }

  // ===========================================================================
  // Student
  // ===========================================================================

  /**
   * Browse the catalogue.
   *
   * Published, active material the student is academically eligible for, and
   * nothing at all while the storefront is off. The academic filter comes from
   * the student's own profile; the client can only NARROW it (year, subject,
   * search). The search `OR` and the eligibility `OR` live in separate `AND`
   * branches, so neither can widen the other.
   */
  async browse(params: {
    page: number;
    pageSize: number;
    q?: string;
    academicYearId?: string;
    subjectId?: string;
    userId: string;
  }) {
    if (!this.eligibility.storefrontEnabled) {
      return paginated([], 0, params.page, params.pageSize);
    }

    const scope = await this.eligibility.scopeFor(params.userId);

    const where: Prisma.LibraryMaterialWhereInput = {
      AND: [
        PUBLISHED_MATERIAL,
        this.eligibility.materialWhere(scope),
        ...(params.academicYearId ? [academicYearFilter(params.academicYearId)] : []),
        ...(params.subjectId ? [{ subjectId: params.subjectId }] : []),
        ...(params.q
          ? [
              {
                OR: [
                  { title: { contains: params.q, mode: 'insensitive' as const } },
                  { titleAr: { contains: params.q } },
                  { description: { contains: params.q, mode: 'insensitive' as const } },
                ],
              },
            ]
          : []),
      ],
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.libraryMaterial.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        select: {
          id: true,
          title: true,
          titleAr: true,
          description: true,
          coverKey: true,
          subject: { select: { id: true, name: true } },
          academicYears: MATERIAL_YEARS_SELECT,
          // Only what a student could actually buy is counted.
          _count: {
            select: {
              packages: { where: { ...notDeleted, isActive: true, status: ContentStatus.PUBLISHED } },
            },
          },
          parts: {
            where: PUBLISHED_PART,
            select: { id: true, price: true },
          },
        },
      }),
      this.prisma.libraryMaterial.count({ where }),
    ]);

    const listedPartIds = rows.flatMap((row) => row.parts.map((p) => p.id));
    const ownedRows = listedPartIds.length
      ? await this.prisma.libraryEntitlement.findMany({
          where: { userId: params.userId, revokedAt: null, libraryPartId: { in: listedPartIds } },
          select: { libraryPartId: true },
        })
      : [];
    const owned = new Set(ownedRows.map((r) => r.libraryPartId));

    const items = await Promise.all(
      rows.map(async (row) => {
        const prices = row.parts.map((p) => Number(p.price));
        const academicYears = academicYearRefs(row.academicYears);
        return {
          id: row.id,
          title: row.title,
          titleAr: row.titleAr,
          description: row.description,
          coverUrl: await this.storage.publicAssetUrl(row.coverKey),
          subject: row.subject,
          // Legacy single rung: the first of the list, for clients that
          // predate `academicYears`. Null means every year.
          academicYear: academicYears[0] ?? null,
          academicYears,
          partCount: row.parts.length,
          packageCount: row._count.packages,
          ownedPartCount: row.parts.filter((p) => owned.has(p.id)).length,
          priceFrom: prices.length ? Math.min(...prices) : null,
          priceTotal: prices.length
            ? Number(prices.reduce((a, b) => a + b, 0).toFixed(2))
            : null,
        };
      }),
    );

    return paginated(items, total, params.page, params.pageSize);
  }

  /**
   * One material.
   *
   *   FULL   in scope and storefront on: every published part with its access
   *          state, and packages.
   *   OWNER  not visible (out of scope, or storefront off) but the student owns
   *          at least one part: the material header and ONLY the owned parts.
   *          No prices, no packages, no counts, nothing purchasable.
   *   404    everything else — and the same 404 for "does not exist",
   *          "unpublished", "out of scope" and "storefront off", so the
   *          response cannot be used to discover a hidden material.
   */
  async materialForStudent(materialId: string, userId: string) {
    const material = await this.prisma.libraryMaterial.findFirst({
      where: { id: materialId, ...PUBLISHED_MATERIAL },
      select: {
        id: true,
        title: true,
        titleAr: true,
        description: true,
        coverKey: true,
        subject: { select: { id: true, name: true } },
        academicYears: MATERIAL_YEARS_SELECT,
        ...MATERIAL_AUDIENCE_SELECT,
      },
    });

    if (!material) throw AppException.notFound('Library material', materialId);

    const scope = await this.eligibility.scopeFor(userId);
    const visible =
      this.eligibility.storefrontEnabled &&
      this.eligibility.isVisible(scope, toAudience(material));

    const academicYears = academicYearRefs(material.academicYears);
    const header = {
      id: material.id,
      title: material.title,
      titleAr: material.titleAr,
      description: material.description,
      coverUrl: await this.storage.publicAssetUrl(material.coverKey),
      subject: material.subject,
      academicYear: academicYears[0] ?? null,
      academicYears,
    };

    if (visible) return this.fullView(material.id, material.coverKey, header, userId);

    if (await this.eligibility.ownsAnyPartOf(userId, material.id)) {
      return this.ownerView(material.id, material.coverKey, header, userId);
    }

    // Identical to the not-found case above, on purpose.
    throw AppException.notFound('Library material', materialId);
  }

  private async fullView(
    materialId: string,
    coverKey: string | null,
    header: Record<string, unknown>,
    userId: string,
  ) {
    const [parts, packages] = await Promise.all([
      this.prisma.libraryPart.findMany({
        where: { materialId, ...PUBLISHED_PART },
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true,
          title: true,
          titleAr: true,
          description: true,
          sortOrder: true,
          price: true,
          currency: true,
          pageCount: true,
          mimeType: true,
          isPreview: true,
          thumbnailKey: true,
        },
      }),
      this.prisma.libraryPackage.findMany({
        where: { materialId, ...notDeleted, isActive: true, status: ContentStatus.PUBLISHED },
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true,
          title: true,
          titleAr: true,
          description: true,
          price: true,
          currency: true,
          items: {
            orderBy: { sortOrder: 'asc' },
            select: { libraryPartId: true },
          },
        },
      }),
    ]);

    const partIds = parts.map((p) => p.id);
    const entitlements = partIds.length
      ? await this.prisma.libraryEntitlement.findMany({
          where: { userId, libraryPartId: { in: partIds } },
          select: { libraryPartId: true, grantedAt: true, revokedAt: true },
        })
      : [];
    const owned = new Map(
      entitlements.filter((e) => e.revokedAt === null).map((e) => [e.libraryPartId, e.grantedAt]),
    );
    const revoked = new Set(
      entitlements.filter((e) => e.revokedAt !== null).map((e) => e.libraryPartId),
    );

    const defaultThumbnailKey = await this.settings.libraryDefaultThumbnailKey();

    const ownershipOf = (partId: string): LibraryPartOwnership =>
      owned.has(partId) ? 'OWNED' : revoked.has(partId) ? 'REVOKED' : 'NONE';

    // Decision B: a revoked entitlement may coexist with preview eligibility.
    // Mirrors LibraryDocumentsService.issueTicket, which mints a preview
    // ticket for a published, in-scope preview part whatever the ownership.
    const accessOf = (part: (typeof parts)[number]): LibraryPartAccess => {
      if (owned.has(part.id)) return 'OWNED';
      if (part.isPreview) return 'PREVIEW';
      if (revoked.has(part.id)) return 'REVOKED';
      if (Number(part.price) > 0) return 'PURCHASABLE';
      return 'UNAVAILABLE';
    };

    const visibleIds = new Set(partIds);

    return {
      ...header,
      view: 'FULL' as const,
      ownsAllParts: partIds.length > 0 && partIds.every((id) => owned.has(id)),
      parts: await Promise.all(
        parts.map(async (part) => {
          const access = accessOf(part);
          return {
            id: part.id,
            title: part.title,
            titleAr: part.titleAr,
            description: part.description,
            sortOrder: part.sortOrder,
            price: Number(part.price),
            currency: part.currency,
            pageCount: part.pageCount,
            mimeType: part.mimeType,
            thumbnailUrl: await this.resolvePartThumbnailUrl(
              part.thumbnailKey,
              coverKey,
              defaultThumbnailKey,
            ),
            access,
            ownership: ownershipOf(part.id),
            ownedSince: owned.get(part.id)?.toISOString() ?? null,
            // Deprecated mirrors of `access`, kept only until the Student Web
            // and Mobile clients read `access` (Phases 3–4). Remove then.
            isPreview: part.isPreview,
            owned: access === 'OWNED' || access === 'PREVIEW',
            purchasable: access === 'PURCHASABLE',
          };
        }),
      ),
      packages: packages.map((pkg) => {
        const items = pkg.items.map((i) => i.libraryPartId);
        // Only this material's published parts are ever named. An item that is
        // not one of them makes the whole package unavailable (decision F5) and
        // its id is not disclosed.
        const included = items.filter((id) => visibleIds.has(id));
        const complete = items.length > 0 && included.length === items.length;
        const anyRevoked = included.some((id) => revoked.has(id));
        const allOwned = complete && included.every((id) => owned.has(id));
        const access: LibraryPackageAccess = allOwned
          ? 'OWNED'
          : complete && !anyRevoked && Number(pkg.price) > 0
            ? 'PURCHASABLE'
            : 'UNAVAILABLE';
        const ownedInPackage = included.filter((id) => owned.has(id)).length;
        return {
          id: pkg.id,
          title: pkg.title,
          titleAr: pkg.titleAr,
          description: pkg.description,
          price: Number(pkg.price),
          currency: pkg.currency,
          partCount: included.length,
          partIds: included,
          partsAlreadyOwned: ownedInPackage,
          access,
          // Deprecated mirror of `access`; see parts above.
          fullyOwned: access === 'OWNED',
        };
      }),
    };
  }

  /**
   * The ownership exception: the material header and the student's own parts.
   *
   * Its own query, so nothing about the parts they do not own — ids, titles,
   * prices, counts — and nothing about packages is ever loaded for this view.
   */
  private async ownerView(
    materialId: string,
    coverKey: string | null,
    header: Record<string, unknown>,
    userId: string,
  ) {
    const owned = await this.prisma.libraryEntitlement.findMany({
      where: {
        userId,
        revokedAt: null,
        part: { materialId, ...PUBLISHED_PART },
      },
      orderBy: { part: { sortOrder: 'asc' } },
      select: {
        grantedAt: true,
        part: {
          select: {
            id: true,
            title: true,
            titleAr: true,
            description: true,
            sortOrder: true,
            pageCount: true,
            mimeType: true,
            thumbnailKey: true,
            isPreview: true,
          },
        },
      },
    });

    const defaultThumbnailKey = await this.settings.libraryDefaultThumbnailKey();

    return {
      ...header,
      view: 'OWNER' as const,
      parts: await Promise.all(
        owned.map(async ({ part, grantedAt }) => ({
          id: part.id,
          title: part.title,
          titleAr: part.titleAr,
          description: part.description,
          sortOrder: part.sortOrder,
          pageCount: part.pageCount,
          mimeType: part.mimeType,
          thumbnailUrl: await this.resolvePartThumbnailUrl(
            part.thumbnailKey,
            coverKey,
            defaultThumbnailKey,
          ),
          access: 'OWNED' as const,
          ownership: 'OWNED' as const,
          ownedSince: grantedAt.toISOString(),
          // Deprecated mirrors of `access`, for the Student Web build that is
          // live today: without them it shows an owner no Read button here.
          // Still no price and nothing purchasable. Remove with the others
          // once the clients read `access` (Phases 3–4).
          isPreview: part.isPreview,
          owned: true,
          purchasable: false,
        })),
      ),
      packages: [] as never[],
    };
  }

  /**
   * Everything the student owns (unrevoked entitlements only, decision G3).
   *
   * Independent of academic scope and of the storefront: an owner keeps their
   * documents whatever happens to the catalogue. Withdrawn material stays
   * listed — they did buy it — marked `WITHDRAWN` rather than vanishing.
   */
  async myLibrary(userId: string, page: number, pageSize: number) {
    const where: Prisma.LibraryEntitlementWhereInput = {
      userId,
      revokedAt: null,
      part: { ...notDeleted },
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.libraryEntitlement.findMany({
        where,
        orderBy: { grantedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          source: true,
          grantedAt: true,
          part: {
            select: {
              id: true,
              title: true,
              titleAr: true,
              pageCount: true,
              mimeType: true,
              status: true,
              material: { select: { id: true, title: true, status: true, deletedAt: true } },
            },
          },
        },
      }),
      this.prisma.libraryEntitlement.count({ where }),
    ]);

    return paginated(
      rows.map((row) => {
        // Mirrors what LibraryDocumentsService.issueTicket refuses for an owner.
        const withdrawn =
          row.part.status === ContentStatus.ARCHIVED ||
          row.part.material.status === ContentStatus.ARCHIVED ||
          row.part.material.deletedAt !== null;
        return {
          entitlementId: row.id,
          partId: row.part.id,
          title: row.part.title,
          titleAr: row.part.titleAr,
          materialId: row.part.material.id,
          materialTitle: row.part.material.title,
          pageCount: row.part.pageCount,
          mimeType: row.part.mimeType,
          source: row.source,
          grantedAt: row.grantedAt.toISOString(),
          status: withdrawn ? ('WITHDRAWN' as const) : ('READABLE' as const),
          // Deprecated mirror of `status`, kept until the clients read
          // `status` (Phases 3–4), so existing owners keep a working list.
          available: !withdrawn,
        };
      }),
      total,
      page,
      pageSize,
    );
  }

  // ===========================================================================
  // Administration
  // ===========================================================================

  async listForAdmin(params: {
    page: number;
    pageSize: number;
    q?: string;
    status?: ContentStatus;
    academicYearId?: string;
    facultyId?: string;
  }) {
    // The search `OR` and the year `OR` live in separate `AND` branches so
    // neither can widen the other.
    const where: Prisma.LibraryMaterialWhereInput = {
      AND: [
        notDeleted,
        ...(params.status ? [{ status: params.status }] : []),
        ...(params.facultyId ? [{ facultyId: params.facultyId }] : []),
        ...(params.academicYearId ? [academicYearFilter(params.academicYearId)] : []),
        ...(params.q
          ? [
              {
                OR: [
                  { title: { contains: params.q, mode: 'insensitive' as const } },
                  { titleAr: { contains: params.q } },
                ],
              },
            ]
          : []),
      ],
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.libraryMaterial.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: {
          subject: { select: { id: true, name: true } },
          faculty: { select: { id: true, name: true, nameAr: true } },
          academicYears: MATERIAL_YEARS_SELECT,
          createdBy: { select: { id: true, fullName: true } },
          _count: { select: { parts: true, packages: true, departments: true } },
        },
      }),
      this.prisma.libraryMaterial.count({ where }),
    ]);

    return paginated(
      rows.map((row) => ({
        id: row.id,
        title: row.title,
        titleAr: row.titleAr,
        status: row.status,
        isActive: row.isActive,
        sortOrder: row.sortOrder,
        subject: row.subject,
        faculty: row.faculty,
        departmentScope: row.departmentScope,
        departmentCount: row._count.departments,
        academicYears: academicYearRefs(row.academicYears),
        hasCover: row.coverKey !== null,
        partCount: row._count.parts,
        packageCount: row._count.packages,
        createdBy: row.createdBy,
        createdAt: row.createdAt.toISOString(),
      })),
      total,
      params.page,
      params.pageSize,
    );
  }

  /** Full detail for the admin editor, including inactive and draft content. */
  async materialForAdmin(materialId: string) {
    const material = await this.prisma.libraryMaterial.findFirst({
      where: { id: materialId, ...notDeleted },
      include: {
        subject: { select: { id: true, name: true } },
        university: { select: { id: true, name: true, nameAr: true } },
        faculty: { select: { id: true, name: true, nameAr: true } },
        academicYears: MATERIAL_YEARS_SELECT,
        departments: {
          orderBy: { createdAt: 'asc' },
          select: {
            department: { select: { id: true, name: true, nameAr: true, studyType: true } },
          },
        },
        parts: {
          where: notDeleted,
          orderBy: { sortOrder: 'asc' },
          include: { _count: { select: { entitlements: true } } },
        },
        packages: {
          where: notDeleted,
          orderBy: { sortOrder: 'asc' },
          include: {
            items: { orderBy: { sortOrder: 'asc' }, select: { libraryPartId: true } },
            _count: { select: { purchases: true } },
          },
        },
      },
    });

    if (!material) throw AppException.notFound('Library material', materialId);

    const adminDefaultThumbnailKey = await this.settings.libraryDefaultThumbnailKey();
    const academicYears = academicYearRefs(material.academicYears);

    return {
      id: material.id,
      title: material.title,
      titleAr: material.titleAr,
      description: material.description,
      status: material.status,
      isActive: material.isActive,
      sortOrder: material.sortOrder,
      universityId: material.universityId,
      facultyId: material.facultyId,
      // Legacy single rung — the first of the list — kept for the dashboard
      // build that is live today. `academicYearIds` is the whole audience.
      academicYearId: academicYears[0]?.id ?? null,
      academicYearIds: academicYears.map((year) => year.id),
      subjectId: material.subjectId,
      departmentScope: material.departmentScope,
      departmentIds: material.departments.map((d) => d.department.id),
      audience: {
        university: material.university,
        faculty: material.faculty,
        departmentScope: material.departmentScope,
        departments: material.departments.map((d) => d.department),
        academicYear: academicYears[0] ?? null,
        academicYears,
      },
      // Never the object key itself; `hasCover` says whether one is set so the
      // editor can offer "Clear" without being told the key.
      hasCover: material.coverKey !== null,
      coverUrl: await this.storage.publicAssetUrl(material.coverKey),
      defaultThumbnailUrl: await this.storage.publicAssetUrl(adminDefaultThumbnailKey),
      parts: await Promise.all(material.parts.map(async (part) => ({
        id: part.id,
        title: part.title,
        titleAr: part.titleAr,
        description: part.description,
        sortOrder: part.sortOrder,
        status: part.status,
        isActive: part.isActive,
        price: Number(part.price),
        currency: part.currency,
        mimeType: part.mimeType,
        sizeBytes: part.sizeBytes === null ? null : Number(part.sizeBytes),
        pageCount: part.pageCount,
        isPreview: part.isPreview,
        // Never the object key.
        hasDocument: !!part.objectKey,
        thumbnailKey: part.thumbnailKey,
        thumbnailUrl: await this.resolvePartThumbnailUrl(
          part.thumbnailKey,
          material.coverKey,
          adminDefaultThumbnailKey,
        ),
        entitlementCount: part._count.entitlements,
        createdAt: part.createdAt.toISOString(),
      }))),
      packages: material.packages.map((pkg) => ({
        id: pkg.id,
        title: pkg.title,
        titleAr: pkg.titleAr,
        description: pkg.description,
        status: pkg.status,
        isActive: pkg.isActive,
        sortOrder: pkg.sortOrder,
        price: Number(pkg.price),
        currency: pkg.currency,
        partIds: pkg.items.map((i) => i.libraryPartId),
        purchaseCount: pkg._count.purchases,
      })),
    };
  }

  // --- audience --------------------------------------------------------------

  /**
   * The whole audience must hold, or nothing is written.
   *
   * University and faculty are required (F5); the faculty belongs to the
   * university; departments belong to the faculty, are active, and never mix
   * General with Programs; FACULTY scope carries no departments and DEPARTMENTS
   * scope carries at least one; every year/level listed is an active rung of
   * the ladder that governs the faculty — or of every selected department.
   */
  private async assertAudience(audience: AudienceInput): Promise<void> {
    const fields: Record<string, string[]> = {};
    if (
      audience.departmentScope === LibraryDepartmentScope.FACULTY &&
      audience.departmentIds.length > 0
    ) {
      fields.departmentIds = ['a faculty-wide material has no department selection'];
    }
    if (
      audience.departmentScope === LibraryDepartmentScope.DEPARTMENTS &&
      audience.departmentIds.length === 0
    ) {
      fields.departmentIds = ['choose at least one department'];
    }
    if (Object.keys(fields).length > 0) throw AppException.validation(fields);

    await checkAcademicStructure(
      this.prisma,
      {
        universityId: audience.universityId,
        facultyId: audience.facultyId,
        departmentIds: audience.departmentIds,
      },
      LIBRARY_PLACEMENT,
    );

    // Each rung on its own, against the same ladder resolution a single rung
    // always had. A refusal is reported on `academicYearIds`, the field the
    // client sent, rather than on the legacy name the shared check uses.
    for (const academicYearId of audience.academicYearIds) {
      try {
        await checkYearInLadder(
          this.prisma,
          this.catalog,
          {
            universityId: audience.universityId,
            facultyId: audience.facultyId,
            departmentIds: audience.departmentIds,
            academicYearId,
          },
          LIBRARY_PLACEMENT,
        );
      } catch (error) {
        const refused = error instanceof AppException ? error.fields?.academicYearId : undefined;
        if (refused) throw AppException.validation({ academicYearIds: refused });
        throw error;
      }
    }
  }

  /**
   * The legacy `academicYearId` column mirrors the FIRST rung of the list, in
   * ladder order, so a reader that predates the join table still sees a year.
   */
  private async firstAcademicYearId(academicYearIds: string[]): Promise<string | null> {
    if (academicYearIds.length === 0) return null;
    if (academicYearIds.length === 1) return academicYearIds[0] ?? null;
    const rungs = await this.prisma.academicYear.findMany({
      where: { id: { in: academicYearIds } },
      select: { id: true, order: true },
      orderBy: [{ order: 'asc' }, { id: 'asc' }],
    });
    return rungs[0]?.id ?? academicYearIds[0] ?? null;
  }

  /**
   * Holds a submitted cover key to the namespace the cover upload route issues,
   * then checks the object is really there and within the image limit.
   *
   * The key feeds a public, unsigned asset URL, so without the namespace check
   * it could name any object in the bucket — a paid document, a video
   * rendition. The existence check is what stops a mistyped or failed upload
   * from being saved as a cover that never renders.
   */
  private async assertCoverKey(
    coverKey: string,
    namespace: string,
    previous: string | null,
  ): Promise<void> {
    assertObjectKeyInNamespace(coverKey, namespace, 'coverKey');
    if (coverKey === previous) return;
    await this.storage.assertUploadWithinLimit({
      bucket: 'media',
      objectKey: coverKey,
      maxBytes: MAX_IMAGE_BYTES,
      field: 'coverKey',
    });
  }

  /**
   * Best-effort removal of a cover the material no longer points at. Only an
   * object in this material's own cover namespace is ever deleted; the row has
   * already moved, so a storage failure here is an orphaned file, never a
   * failed edit.
   */
  private async discardReplacedCover(
    materialId: string,
    previousKey: string | null,
    nextKey: string | null | undefined,
  ): Promise<void> {
    if (!previousKey) return;
    if (nextKey === undefined || nextKey === previousKey) return;
    if (!previousKey.startsWith(StorageService.libraryCoverPrefix(materialId))) return;
    await Promise.resolve(this.storage.deleteObject('media', previousKey)).catch(() => undefined);
  }

  // --- materials -------------------------------------------------------------

  async createMaterial(
    input: {
      title: string;
      titleAr?: string;
      description?: string;
      universityId?: string | null;
      facultyId?: string | null;
      departmentScope?: LibraryDepartmentScope;
      departmentIds?: string[];
      academicYearId?: string | null;
      academicYearIds?: string[];
      subjectId?: string | null;
      coverKey?: string;
    },
    actor: { id: string; role: UserRole },
  ) {
    const audience: AudienceInput = {
      universityId: input.universityId ?? null,
      facultyId: input.facultyId ?? null,
      departmentScope: input.departmentScope ?? LibraryDepartmentScope.FACULTY,
      departmentIds: [...new Set(input.departmentIds ?? [])],
      academicYearIds: academicYearIdsFrom(input) ?? [],
    };
    await this.assertAudience(audience);

    // A cover can only be filed under the library namespace here: the material
    // has no id yet, so the per-material prefix is checked on edit instead.
    if (input.coverKey) {
      await this.assertCoverKey(input.coverKey, StorageService.LIBRARY_THUMBNAIL_ROOT, null);
    }

    const legacyYearId = await this.firstAcademicYearId(audience.academicYearIds);

    const material = await this.prisma.$transaction(async (tx) => {
      const created = await tx.libraryMaterial.create({
        data: {
          title: input.title,
          titleAr: input.titleAr ?? null,
          description: input.description ?? null,
          universityId: audience.universityId,
          facultyId: audience.facultyId,
          departmentScope: audience.departmentScope,
          academicYearId: legacyYearId,
          subjectId: input.subjectId ?? null,
          coverKey: input.coverKey ?? null,
          createdById: actor.id,
        },
      });
      if (audience.departmentIds.length > 0) {
        await tx.libraryMaterialDepartment.createMany({
          data: audience.departmentIds.map((departmentId) => ({
            materialId: created.id,
            facultyId: audience.facultyId!,
            departmentId,
          })),
        });
      }
      if (audience.academicYearIds.length > 0) {
        await tx.libraryMaterialAcademicYear.createMany({
          data: audience.academicYearIds.map((academicYearId) => ({
            materialId: created.id,
            academicYearId,
          })),
        });
      }
      return created;
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.CREATE,
      entity: 'library_material',
      entityId: material.id,
      after: { title: material.title, audience },
    });

    return this.materialForAdmin(material.id);
  }

  async updateMaterial(
    materialId: string,
    input: Partial<{
      title: string;
      titleAr: string | null;
      description: string | null;
      status: ContentStatus;
      isActive: boolean;
      sortOrder: number;
      universityId: string | null;
      facultyId: string | null;
      departmentScope: LibraryDepartmentScope;
      departmentIds: string[];
      academicYearId: string | null;
      academicYearIds: string[];
      subjectId: string | null;
      coverKey: string | null;
    }>,
    actor: { id: string; role: UserRole },
  ) {
    const before = await this.prisma.libraryMaterial.findFirst({
      where: { id: materialId, ...notDeleted },
      include: {
        departments: { select: { departmentId: true } },
        academicYears: { select: { academicYearId: true } },
      },
    });
    if (!before) throw AppException.notFound('Library material', materialId);

    const {
      universityId,
      facultyId,
      departmentScope,
      departmentIds,
      academicYearId,
      academicYearIds,
      ...scalars
    } = input;

    // Atomic audience: touching any part of it means sending all of it, so an
    // edit can never widen or narrow the audience as a side effect. The years
    // count as sent in either spelling.
    const nextYearIds = academicYearIdsFrom({ academicYearId, academicYearIds });
    const sent = (key: (typeof AUDIENCE_KEYS)[number]) =>
      key === 'academicYearIds' ? nextYearIds !== undefined : input[key] !== undefined;
    const touched = AUDIENCE_KEYS.filter(sent);
    if (touched.length > 0 && touched.length < AUDIENCE_KEYS.length) {
      const missing = AUDIENCE_KEYS.filter((key) => !sent(key));
      throw AppException.validation(
        Object.fromEntries(
          missing.map((key) => [key, ['send the whole audience when changing any part of it']]),
        ),
      );
    }

    // The links are the audience; a row with none but a legacy column value —
    // written before the join table, or straight into the table — still means
    // that one year, so publishing re-validates it too.
    const storedYearIds = (before.academicYears ?? []).map((y) => y.academicYearId);
    const beforeAudience: AudienceInput = {
      universityId: before.universityId,
      facultyId: before.facultyId,
      departmentScope: before.departmentScope,
      departmentIds: before.departments.map((d) => d.departmentId),
      academicYearIds:
        storedYearIds.length > 0
          ? storedYearIds
          : before.academicYearId
            ? [before.academicYearId]
            : [],
    };
    const nextAudience: AudienceInput | null =
      touched.length > 0
        ? {
            universityId: universityId ?? null,
            facultyId: facultyId ?? null,
            departmentScope: departmentScope!,
            departmentIds: [...new Set(departmentIds ?? [])],
            academicYearIds: nextYearIds ?? [],
          }
        : null;

    // A new audience is always validated. Publishing (or re-activating) also
    // re-validates the stored one, so a legacy row with an invalid year — two
    // exist — cannot go live until an administrator fixes it.
    const goingLive =
      (scalars.status === ContentStatus.PUBLISHED && before.status !== ContentStatus.PUBLISHED) ||
      (scalars.isActive === true && !before.isActive);
    if (nextAudience) await this.assertAudience(nextAudience);
    else if (goingLive) await this.assertAudience(beforeAudience);

    if (scalars.coverKey) {
      await this.assertCoverKey(
        scalars.coverKey,
        StorageService.libraryThumbnailPrefix(materialId),
        before.coverKey,
      );
    }

    const legacyYearId = nextAudience
      ? await this.firstAcademicYearId(nextAudience.academicYearIds)
      : null;

    await this.prisma.$transaction(async (tx) => {
      if (nextAudience) {
        const keep =
          nextAudience.facultyId === before.facultyId
            ? nextAudience.departmentIds
            : [];
        // Links leave BEFORE the faculty changes: the composite foreign key
        // would otherwise cascade the new faculty into rows whose department
        // belongs to the old one, and refuse.
        await tx.libraryMaterialDepartment.deleteMany({
          where: { materialId, departmentId: { notIn: keep } },
        });
        await tx.libraryMaterialAcademicYear.deleteMany({
          where: { materialId, academicYearId: { notIn: nextAudience.academicYearIds } },
        });
      }

      await tx.libraryMaterial.update({
        where: { id: materialId },
        data: {
          ...scalars,
          ...(nextAudience
            ? {
                universityId: nextAudience.universityId,
                facultyId: nextAudience.facultyId,
                departmentScope: nextAudience.departmentScope,
                academicYearId: legacyYearId,
              }
            : {}),
          // Stamped the first time it goes live, and never rewritten after.
          ...(scalars.status === ContentStatus.PUBLISHED && !before.publishedAt
            ? { publishedAt: new Date() }
            : {}),
        },
      });

      if (nextAudience && nextAudience.departmentIds.length > 0) {
        await tx.libraryMaterialDepartment.createMany({
          data: nextAudience.departmentIds.map((departmentId) => ({
            materialId,
            facultyId: nextAudience.facultyId!,
            departmentId,
          })),
          skipDuplicates: true,
        });
      }
      if (nextAudience && nextAudience.academicYearIds.length > 0) {
        await tx.libraryMaterialAcademicYear.createMany({
          data: nextAudience.academicYearIds.map((yearId) => ({
            materialId,
            academicYearId: yearId,
          })),
          skipDuplicates: true,
        });
      }
    });

    await this.discardReplacedCover(materialId, before.coverKey, scalars.coverKey);

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.UPDATE,
      entity: 'library_material',
      entityId: materialId,
      before: {
        title: before.title,
        status: before.status,
        isActive: before.isActive,
        ...(nextAudience ? { audience: beforeAudience } : {}),
      },
      after: { ...scalars, ...(nextAudience ? { audience: nextAudience } : {}) },
    });

    return this.materialForAdmin(materialId);
  }

  /**
   * Soft-deletes a material.
   *
   * Refused once any of its parts has been sold. Removing it would orphan
   * entitlements people paid for; deactivating hides it and keeps them whole.
   */
  async removeMaterial(materialId: string, actor: { id: string; role: UserRole }) {
    const material = await this.prisma.libraryMaterial.findFirst({
      where: { id: materialId, ...notDeleted },
      select: { id: true, title: true },
    });
    if (!material) throw AppException.notFound('Library material', materialId);

    const sold = await this.prisma.libraryEntitlement.count({
      where: { part: { materialId } },
    });
    if (sold > 0) {
      throw AppException.conflict(
        'Students hold entitlements to parts of this material, so it cannot be deleted. Deactivate it instead — they keep their access.',
        { entitlements: sold },
      );
    }

    await this.prisma.libraryMaterial.update({
      where: { id: materialId },
      data: { deletedAt: new Date(), isActive: false },
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.DELETE,
      entity: 'library_material',
      entityId: materialId,
      before: { title: material.title },
    });

    return { id: materialId, deleted: true };
  }

  // --- parts -----------------------------------------------------------------

  async createPart(
    materialId: string,
    input: {
      title: string;
      titleAr?: string;
      description?: string;
      price: number;
      objectKey: string;
      mimeType?: string;
      sizeBytes?: number;
      pageCount?: number;
      isPreview?: boolean;
      sortOrder?: number;
      thumbnailKey?: string | null;
    },
    actor: { id: string; role: UserRole },
  ) {
    const material = await this.prisma.libraryMaterial.findFirst({
      where: { id: materialId, ...notDeleted },
      select: { id: true },
    });
    if (!material) throw AppException.notFound('Library material', materialId);

    this.assertLibraryPartKeys(input.objectKey, input.thumbnailKey, `thumbnails/library/${materialId}/`);

    // The object's real size, read back from storage: a presigned PUT does not
    // bind the length, so the declared `sizeBytes` is only a claim.
    const sizeBytes = await this.storage.assertUploadWithinLimit({
      bucket: 'library',
      objectKey: input.objectKey,
      maxBytes: MAX_DOCUMENT_BYTES,
      field: 'sizeBytes',
    });

    const part = await this.prisma.$transaction(async (tx) => {
      const last = await tx.libraryPart.findFirst({
        where: { materialId, ...notDeleted },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });

      return tx.libraryPart.create({
        data: {
          materialId,
          title: input.title,
          titleAr: input.titleAr ?? null,
          description: input.description ?? null,
          sortOrder: input.sortOrder ?? (last?.sortOrder ?? 0) + 1,
          price: input.price,
          objectKey: input.objectKey,
          mimeType: input.mimeType ?? null,
          sizeBytes: BigInt(sizeBytes),
          pageCount: input.pageCount ?? null,
          isPreview: input.isPreview ?? false,
          thumbnailKey: input.thumbnailKey ?? null,
          uploadedById: actor.id,
        },
      });
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.CREATE,
      entity: 'library_part',
      entityId: part.id,
      after: { materialId, title: part.title, price: Number(part.price) },
    });

    return this.materialForAdmin(materialId);
  }

  /**
   * Edits a part.
   *
   * The price may change freely: every purchase carries its own frozen price
   * and is untouched by this. Replacing the document of a part people already
   * own is allowed but recorded loudly, because it silently changes what they
   * paid for.
   */
  async updatePart(
    partId: string,
    input: Partial<{
      title: string;
      titleAr: string | null;
      description: string | null;
      price: number;
      status: ContentStatus;
      isActive: boolean;
      isPreview: boolean;
      objectKey: string;
      mimeType: string | null;
      sizeBytes: number | null;
      pageCount: number | null;
      thumbnailKey: string | null;
    }>,
    actor: { id: string; role: UserRole },
  ): Promise<unknown> {
    const part = await this.prisma.libraryPart.findFirst({
      where: { id: partId, ...notDeleted },
    });
    if (!part) throw AppException.notFound('Library part', partId);

    let patch = input;

    this.assertLibraryPartKeys(
      input.objectKey,
      input.thumbnailKey,
      `thumbnails/library/${part.materialId}/`,
    );

    if (input.objectKey && input.objectKey !== part.objectKey) {
      const verifiedSize = await this.storage.assertUploadWithinLimit({
        bucket: 'library',
        objectKey: input.objectKey,
        maxBytes: MAX_DOCUMENT_BYTES,
        field: 'objectKey',
      });

      patch = { ...patch, sizeBytes: verifiedSize };

      const holders = await this.prisma.libraryEntitlement.count({
        where: { libraryPartId: partId, revokedAt: null },
      });
      if (holders > 0) {
        this.logger.warn(
          `library part ${partId} document replaced while ${holders} student(s) hold it`,
        );
      }
    }

    await this.prisma.libraryPart.update({ where: { id: partId }, data: patch });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.UPDATE,
      entity: 'library_part',
      entityId: partId,
      before: {
        title: part.title,
        price: Number(part.price),
        isActive: part.isActive,
        status: part.status,
        documentReplaced: !!input.objectKey && input.objectKey !== part.objectKey,
      },
      after: { ...input, objectKey: input.objectKey ? '«changed»' : undefined },
    });

    return this.materialForAdmin(part.materialId);
  }

  async removePart(partId: string, actor: { id: string; role: UserRole }) {
    const part = await this.prisma.libraryPart.findFirst({
      where: { id: partId, ...notDeleted },
      select: { id: true, title: true, materialId: true },
    });
    if (!part) throw AppException.notFound('Library part', partId);

    const holders = await this.prisma.libraryEntitlement.count({
      where: { libraryPartId: partId },
    });
    if (holders > 0) {
      throw AppException.conflict(
        'Students hold this document and it cannot be deleted. Deactivate it instead — they keep their access.',
        { entitlements: holders },
      );
    }

    const inPackages = await this.prisma.libraryPackageItem.count({
      where: { libraryPartId: partId },
    });
    if (inPackages > 0) {
      throw AppException.conflict(
        'This document is inside a package. Remove it from the package first.',
        { packages: inPackages },
      );
    }

    await this.prisma.libraryPart.update({
      where: { id: partId },
      data: { deletedAt: new Date(), isActive: false },
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.DELETE,
      entity: 'library_part',
      entityId: partId,
      before: { title: part.title },
    });

    return this.materialForAdmin(part.materialId);
  }

  // --- packages --------------------------------------------------------------

  /**
   * Every item must be a (non-deleted) part of the package's own material
   * (decision G4: enforced here and re-checked at purchase, not by the schema).
   */
  private async assertPackageItems(materialId: string, partIds: string[]): Promise<void> {
    const unique = [...new Set(partIds)];
    const parts = await this.prisma.libraryPart.findMany({
      where: { id: { in: unique }, ...notDeleted },
      select: { id: true, materialId: true },
    });

    const found = new Set(parts.map((p) => p.id));
    const missing = unique.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw AppException.validation({
        partIds: [`these documents do not exist: ${missing.join(', ')}`],
      });
    }

    const foreign = parts.filter((p) => p.materialId !== materialId).map((p) => p.id);
    if (foreign.length > 0) {
      throw AppException.validation({
        partIds: [`these documents belong to another material: ${foreign.join(', ')}`],
      });
    }
  }

  async createPackage(
    input: {
      materialId: string;
      title: string;
      titleAr?: string;
      description?: string;
      price: number;
      partIds: string[];
      sortOrder?: number;
    },
    actor: { id: string; role: UserRole },
  ) {
    if (input.partIds.length === 0) {
      throw AppException.validation({
        partIds: ['a package must contain at least one document'],
      });
    }

    const material = await this.prisma.libraryMaterial.findFirst({
      where: { id: input.materialId, ...notDeleted },
      select: { id: true },
    });
    if (!material) throw AppException.notFound('Library material', input.materialId);

    await this.assertPackageItems(input.materialId, input.partIds);

    const pkg = await this.prisma.$transaction(async (tx) => {
      const created = await tx.libraryPackage.create({
        data: {
          materialId: input.materialId,
          title: input.title,
          titleAr: input.titleAr ?? null,
          description: input.description ?? null,
          price: input.price,
          sortOrder: input.sortOrder ?? 0,
        },
      });

      await tx.libraryPackageItem.createMany({
        data: input.partIds.map((libraryPartId, index) => ({
          packageId: created.id,
          libraryPartId,
          sortOrder: index,
        })),
        skipDuplicates: true,
      });

      return created;
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.CREATE,
      entity: 'library_package',
      entityId: pkg.id,
      after: { title: pkg.title, price: Number(pkg.price), parts: input.partIds.length },
    });

    return this.materialForAdmin(pkg.materialId);
  }

  /**
   * Edits a package, optionally replacing its contents.
   *
   * Changing the contents affects only future purchases: entitlements are
   * stored per part, so what anyone already bought is untouched.
   */
  async updatePackage(
    packageId: string,
    input: Partial<{
      title: string;
      titleAr: string | null;
      description: string | null;
      price: number;
      status: ContentStatus;
      isActive: boolean;
      sortOrder: number;
      partIds: string[];
    }>,
    actor: { id: string; role: UserRole },
  ) {
    const pkg = await this.prisma.libraryPackage.findFirst({
      where: { id: packageId, ...notDeleted },
      include: { items: { select: { libraryPartId: true } } },
    });
    if (!pkg) throw AppException.notFound('Library package', packageId);

    if (input.partIds && input.partIds.length === 0) {
      throw AppException.validation({
        partIds: ['a package must contain at least one document'],
      });
    }
    if (input.partIds) await this.assertPackageItems(pkg.materialId, input.partIds);

    const { partIds, ...scalars } = input;

    await this.prisma.$transaction(async (tx) => {
      await tx.libraryPackage.update({ where: { id: packageId }, data: scalars });

      if (partIds) {
        await tx.libraryPackageItem.deleteMany({
          where: { packageId, libraryPartId: { notIn: partIds } },
        });
        await tx.libraryPackageItem.createMany({
          data: partIds.map((libraryPartId, index) => ({
            packageId,
            libraryPartId,
            sortOrder: index,
          })),
          skipDuplicates: true,
        });
      }
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.UPDATE,
      entity: 'library_package',
      entityId: packageId,
      before: {
        title: pkg.title,
        price: Number(pkg.price),
        partIds: pkg.items.map((i) => i.libraryPartId),
      },
      after: input,
    });

    return this.materialForAdmin(pkg.materialId);
  }

  async removePackage(packageId: string, actor: { id: string; role: UserRole }) {
    const pkg = await this.prisma.libraryPackage.findFirst({
      where: { id: packageId, ...notDeleted },
      select: { id: true, title: true, materialId: true, _count: { select: { purchases: true } } },
    });
    if (!pkg) throw AppException.notFound('Library package', packageId);

    if (pkg._count.purchases > 0) {
      throw AppException.conflict(
        'This package has been purchased and cannot be deleted. Deactivate it instead.',
        { purchases: pkg._count.purchases },
      );
    }

    await this.prisma.libraryPackage.update({
      where: { id: packageId },
      data: { deletedAt: new Date(), isActive: false },
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.DELETE,
      entity: 'library_package',
      entityId: packageId,
      before: { title: pkg.title },
    });

    return { id: packageId, deleted: true };
  }

  // --- reporting -------------------------------------------------------------

  /** What the Library has sold. Credits spent, not cash collected. */
  async purchaseReport(params: {
    page: number;
    pageSize: number;
    userId?: string;
    from?: Date;
    to?: Date;
  }) {
    const where: Prisma.LibraryPurchaseWhereInput = {
      ...(params.userId ? { userId: params.userId } : {}),
      ...(params.from || params.to
        ? {
            purchasedAt: {
              ...(params.from ? { gte: params.from } : {}),
              ...(params.to ? { lte: params.to } : {}),
            },
          }
        : {}),
    };

    const [rows, total, totals] = await this.prisma.$transaction([
      this.prisma.libraryPurchase.findMany({
        where,
        orderBy: { purchasedAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: { user: { select: { id: true, fullName: true, phone: true } } },
      }),
      this.prisma.libraryPurchase.count({ where }),
      this.prisma.libraryPurchase.aggregate({
        where,
        _sum: { priceAtPurchase: true },
      }),
    ]);

    const page = paginated(
      rows.map((row) => ({
        id: row.id,
        student: row.user,
        kind: row.kind,
        title: row.titleSnapshot,
        materialTitle: row.materialTitleSnapshot,
        pricePaid: Number(row.priceAtPurchase),
        currency: row.currency,
        partCount: row.partIdsSnapshot.length,
        purchasedAt: row.purchasedAt.toISOString(),
      })),
      total,
      params.page,
      params.pageSize,
    );

    return {
      ...page,
      totals: {
        // Credits spent in the Library. NOT cash income — that was recognised
        // when the credits were bought (recharge_revenue).
        creditsSpent: Number(Number(totals._sum.priceAtPurchase ?? 0).toFixed(2)),
        count: total,
      },
    };
  }
}
