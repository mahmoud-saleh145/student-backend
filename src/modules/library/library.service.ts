import { Injectable, Logger } from '@nestjs/common';
import { AuditAction, ContentStatus, type Prisma, UserRole } from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { paginated } from '../../common/types/api-response';
import { PrismaService, notDeleted } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';

/**
 * Library structure, and what a student sees of it.
 *
 * The Library is a separate top-level system, and the separation is real rather
 * than cosmetic: nothing in this file references a course, an enrollment or a
 * section. A student may buy library material while enrolled in nothing, and
 * owning every course on the platform grants nothing here.
 *
 * Pricing is deliberately simpler than course parts. Each part carries its own
 * absolute price, because there is no whole-material price to take a percentage
 * of — so there is no allocation to validate and no arithmetic that can fail to
 * add up. A package is priced independently of its contents, because a bundle
 * discount is the entire point of a bundle.
 */
@Injectable()
export class LibraryService {
  private readonly logger = new Logger(LibraryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  // ===========================================================================
  // Student
  // ===========================================================================

  /**
   * Browse the catalogue.
   *
   * Only published, active material, filtered and paginated server-side. A part
   * row never carries its `objectKey` — the document is reached through a
   * ticket, and leaking the key here would make every other check pointless.
   */
  async browse(params: {
    page: number;
    pageSize: number;
    q?: string;
    universityId?: string;
    facultyId?: string;
    academicYearId?: string;
    subjectId?: string;
    userId: string;
  }) {
    const where: Prisma.LibraryMaterialWhereInput = {
      ...notDeleted,
      isActive: true,
      status: ContentStatus.PUBLISHED,
      ...(params.universityId ? { universityId: params.universityId } : {}),
      ...(params.facultyId ? { facultyId: params.facultyId } : {}),
      ...(params.academicYearId ? { academicYearId: params.academicYearId } : {}),
      ...(params.subjectId ? { subjectId: params.subjectId } : {}),
      ...(params.q
        ? {
            OR: [
              { title: { contains: params.q, mode: 'insensitive' } },
              { titleAr: { contains: params.q } },
              { description: { contains: params.q, mode: 'insensitive' } },
            ],
          }
        : {}),
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
          _count: { select: { parts: true, packages: true } },
          parts: {
            where: { ...notDeleted, isActive: true, status: ContentStatus.PUBLISHED },
            select: { price: true },
          },
        },
      }),
      this.prisma.libraryMaterial.count({ where }),
    ]);

    const items = await Promise.all(
      rows.map(async (row) => {
        const prices = row.parts.map((p) => Number(p.price));
        return {
          id: row.id,
          title: row.title,
          titleAr: row.titleAr,
          description: row.description,
          coverUrl: await this.storage.publicAssetUrl(row.coverKey),
          subject: row.subject,
          partCount: row.parts.length,
          packageCount: row._count.packages,
          // What it would cost to buy the whole thing part by part — the
          // number a package price is meant to look good against.
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
   * One material with its parts and packages, each marked owned or locked.
   *
   * Locked parts show their title, page count and price — enough to decide
   * whether to buy — and nothing that could be read.
   */
  async materialForStudent(materialId: string, userId: string) {
    const material = await this.prisma.libraryMaterial.findFirst({
      where: {
        id: materialId,
        ...notDeleted,
        isActive: true,
        status: ContentStatus.PUBLISHED,
      },
      select: {
        id: true,
        title: true,
        titleAr: true,
        description: true,
        coverKey: true,
        subject: { select: { id: true, name: true } },
        parts: {
          where: { ...notDeleted, isActive: true, status: ContentStatus.PUBLISHED },
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
          },
        },
        packages: {
          where: { ...notDeleted, isActive: true, status: ContentStatus.PUBLISHED },
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
        },
      },
    });

    if (!material) throw AppException.notFound('Library material', materialId);

    const partIds = material.parts.map((p) => p.id);
    const entitlements = await this.prisma.libraryEntitlement.findMany({
      where: { userId, libraryPartId: { in: partIds }, revokedAt: null },
      select: { libraryPartId: true, grantedAt: true },
    });
    const owned = new Map(entitlements.map((e) => [e.libraryPartId, e.grantedAt]));

    return {
      id: material.id,
      title: material.title,
      titleAr: material.titleAr,
      description: material.description,
      coverUrl: await this.storage.publicAssetUrl(material.coverKey),
      subject: material.subject,
      ownsAllParts: partIds.length > 0 && partIds.every((id) => owned.has(id)),
      parts: material.parts.map((part) => ({
        id: part.id,
        title: part.title,
        titleAr: part.titleAr,
        description: part.description,
        sortOrder: part.sortOrder,
        price: Number(part.price),
        currency: part.currency,
        pageCount: part.pageCount,
        mimeType: part.mimeType,
        isPreview: part.isPreview,
        // A preview reads as open because it is; no purchase will ever be
        // required for it.
        owned: part.isPreview || owned.has(part.id),
        ownedSince: owned.get(part.id)?.toISOString() ?? null,
        purchasable: !owned.has(part.id) && !part.isPreview && Number(part.price) > 0,
      })),
      packages: material.packages.map((pkg) => {
        const included = pkg.items.map((i) => i.libraryPartId);
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
          // Surfaced so a student can see a bundle overlaps what they hold
          // before they spend, rather than discovering it afterwards.
          partsAlreadyOwned: ownedInPackage,
          fullyOwned: included.length > 0 && ownedInPackage === included.length,
        };
      }),
    };
  }

  /** Everything the student can currently open. */
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
              material: { select: { id: true, title: true, status: true } },
            },
          },
        },
      }),
      this.prisma.libraryEntitlement.count({ where }),
    ]);

    return paginated(
      rows.map((row) => ({
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
        // Withdrawn material stays in the list — they did buy it — but is
        // marked unreadable rather than silently vanishing.
        available:
          row.part.status !== ContentStatus.ARCHIVED &&
          row.part.material.status !== ContentStatus.ARCHIVED,
      })),
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
  }) {
    const where: Prisma.LibraryMaterialWhereInput = {
      ...notDeleted,
      ...(params.status ? { status: params.status } : {}),
      ...(params.q
        ? {
            OR: [
              { title: { contains: params.q, mode: 'insensitive' } },
              { titleAr: { contains: params.q } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.libraryMaterial.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: {
          subject: { select: { id: true, name: true } },
          createdBy: { select: { id: true, fullName: true } },
          _count: { select: { parts: true, packages: true } },
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
      academicYearId: material.academicYearId,
      subjectId: material.subjectId,
      coverUrl: await this.storage.publicAssetUrl(material.coverKey),
      parts: material.parts.map((part) => ({
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
        // Never the object key. An admin does not need it and an accidental
        // leak into a log or a browser devtools panel is one copy too many.
        hasDocument: !!part.objectKey,
        entitlementCount: part._count.entitlements,
        createdAt: part.createdAt.toISOString(),
      })),
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

  // --- materials -------------------------------------------------------------

  async createMaterial(
    input: {
      title: string;
      titleAr?: string;
      description?: string;
      universityId?: string;
      facultyId?: string;
      academicYearId?: string;
      subjectId?: string;
      coverKey?: string;
    },
    actor: { id: string; role: UserRole },
  ) {
    const material = await this.prisma.libraryMaterial.create({
      data: {
        title: input.title,
        titleAr: input.titleAr ?? null,
        description: input.description ?? null,
        universityId: input.universityId ?? null,
        facultyId: input.facultyId ?? null,
        academicYearId: input.academicYearId ?? null,
        subjectId: input.subjectId ?? null,
        coverKey: input.coverKey ?? null,
        createdById: actor.id,
      },
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.CREATE,
      entity: 'library_material',
      entityId: material.id,
      after: { title: material.title },
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
      academicYearId: string | null;
      subjectId: string | null;
      coverKey: string | null;
    }>,
    actor: { id: string; role: UserRole },
  ) {
    const before = await this.prisma.libraryMaterial.findFirst({
      where: { id: materialId, ...notDeleted },
    });
    if (!before) throw AppException.notFound('Library material', materialId);

    await this.prisma.libraryMaterial.update({
      where: { id: materialId },
      data: {
        ...input,
        // Stamped the first time it goes live, and never rewritten after.
        ...(input.status === ContentStatus.PUBLISHED && !before.publishedAt
          ? { publishedAt: new Date() }
          : {}),
      },
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.UPDATE,
      entity: 'library_material',
      entityId: materialId,
      before: { title: before.title, status: before.status, isActive: before.isActive },
      after: input,
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
    },
    actor: { id: string; role: UserRole },
  ) {
    const material = await this.prisma.libraryMaterial.findFirst({
      where: { id: materialId, ...notDeleted },
      select: { id: true },
    });
    if (!material) throw AppException.notFound('Library material', materialId);

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
          sizeBytes: input.sizeBytes ?? null,
          pageCount: input.pageCount ?? null,
          isPreview: input.isPreview ?? false,
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
    }>,
    actor: { id: string; role: UserRole },
  ) {
    const part = await this.prisma.libraryPart.findFirst({
      where: { id: partId, ...notDeleted },
    });
    if (!part) throw AppException.notFound('Library part', partId);

    if (input.objectKey && input.objectKey !== part.objectKey) {
      const holders = await this.prisma.libraryEntitlement.count({
        where: { libraryPartId: partId, revokedAt: null },
      });
      if (holders > 0) {
        this.logger.warn(
          `library part ${partId} document replaced while ${holders} student(s) hold it`,
        );
      }
    }

    await this.prisma.libraryPart.update({ where: { id: partId }, data: input });

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

  async createPackage(
    input: {
      materialId?: string;
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

    const parts = await this.prisma.libraryPart.findMany({
      where: { id: { in: input.partIds }, ...notDeleted },
      select: { id: true, materialId: true },
    });

    if (parts.length !== input.partIds.length) {
      const found = new Set(parts.map((p) => p.id));
      throw AppException.validation({
        partIds: [
          `these documents do not exist: ${input.partIds.filter((id) => !found.has(id)).join(', ')}`,
        ],
      });
    }

    const pkg = await this.prisma.$transaction(async (tx) => {
      const created = await tx.libraryPackage.create({
        data: {
          // Defaults to the material the parts come from when they all share
          // one, which is the ordinary case; a package spanning materials
          // simply has no single home.
          materialId:
            input.materialId ??
            (new Set(parts.map((p) => p.materialId)).size === 1
              ? parts[0].materialId
              : null),
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

    return pkg.materialId ? this.materialForAdmin(pkg.materialId) : { id: pkg.id };
  }

  /**
   * Edits a package, optionally replacing its contents.
   *
   * Changing the contents affects only future purchases. Everyone who already
   * bought it holds entitlements to the parts it contained on the day they
   * bought — that is the whole reason entitlements are stored per part rather
   * than as a pointer to the package.
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

    return pkg.materialId ? this.materialForAdmin(pkg.materialId) : { id: packageId };
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
        // when the credits were bought (recharge_revenue). Summing the two
        // would count the same money twice.
        creditsSpent: Number(Number(totals._sum.priceAtPurchase ?? 0).toFixed(2)),
        count: total,
      },
    };
  }
}
