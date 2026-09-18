import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  ClientIp,
  CurrentUser,
  DeviceInfo,
} from '../../common/decorators/current-user.decorator';
import { AdminOnly, StudentOnly } from '../../common/decorators/roles.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import type { AuthenticatedUser, DeviceContext } from '../../common/types/request-context';

import {
  AdminListLibraryDto,
  BrowseLibraryDto,
  CreateLibraryPackageDto,
  CreateLibraryPartDto,
  CreateMaterialDto,
  LibraryPurchaseReportDto,
  PurchaseLibraryDto,
  UpdateLibraryPackageDto,
  UpdateLibraryPartDto,
  UpdateMaterialDto,
} from './dto/library.dto';
import { LibraryDocumentsService } from './library-documents.service';
import { LibraryPurchaseService } from './library-purchase.service';
import { LibraryService } from './library.service';

/**
 * The student's Library.
 *
 * Independent of courses in both directions: a student may buy here while
 * enrolled in nothing, and owning every course grants nothing here. Every route
 * is scoped to the authenticated principal, and the purchase route carries no
 * amount — the price is read from the database inside the transaction.
 */
@ApiTags('library')
@ApiBearerAuth('access-token')
@Controller('library')
export class LibraryController {
  constructor(
    private readonly library: LibraryService,
    private readonly purchases: LibraryPurchaseService,
    private readonly documents: LibraryDocumentsService,
  ) {}

  @Get('materials')
  @StudentOnly()
  @ApiOperation({
    summary: 'Browse the library',
    description:
      'Published, active material only. Server-side searched, filtered and paginated. Reports what the whole material would cost part by part, which is the figure a package price is meant to beat.',
  })
  browse(@Query() query: BrowseLibraryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.library.browse({
      page: query.page,
      pageSize: query.pageSize,
      q: query.q,
      universityId: query.universityId,
      facultyId: query.facultyId,
      academicYearId: query.academicYearId,
      subjectId: query.subjectId,
      userId: user.id,
    });
  }

  @Get('materials/:materialId')
  @StudentOnly()
  @ApiOperation({
    summary: 'One material, with parts and packages marked owned or locked',
    description:
      'A locked part shows its title, page count and price — enough to decide — and nothing readable. A package reports how much of it the student already holds, so an overlapping bundle is visible before they spend.',
  })
  material(
    @Param('materialId') materialId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.library.materialForStudent(materialId, user.id);
  }

  @Get('me')
  @StudentOnly()
  @ApiOperation({
    summary: 'Everything the student can open',
    description:
      'Withdrawn material stays listed — they did buy it — but is flagged unavailable rather than silently disappearing.',
  })
  mine(@Query() query: PaginationDto, @CurrentUser() user: AuthenticatedUser) {
    return this.library.myLibrary(user.id, query.page, query.pageSize);
  }

  @Get('me/purchases')
  @StudentOnly()
  @ApiOperation({
    summary: 'Library purchase history',
    description: 'Each row carries the price frozen at purchase.',
  })
  myPurchases(@Query() query: PaginationDto, @CurrentUser() user: AuthenticatedUser) {
    return this.purchases.myPurchases(user.id, query.page, query.pageSize);
  }

  @Post('quote')
  @StudentOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Price an item before buying it',
    description:
      'Read-only, computed by the same path the purchase uses. Reports the balance, any shortfall, and how much of a package is already owned.',
  })
  quote(@Body() dto: PurchaseLibraryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.purchases.quote({
      userId: user.id,
      kind: dto.kind,
      targetId: dto.targetId,
    });
  }

  @Post('purchase')
  @StudentOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Buy a library part or package with wallet credits',
    description:
      'One atomic transaction: the wallet debit and the entitlements succeed together or neither happens. Idempotent — a retry returns the original purchase. Buying a package writes one entitlement per included part, which is what freezes its membership.',
  })
  purchase(@Body() dto: PurchaseLibraryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.purchases.purchase({
      userId: user.id,
      userRole: user.role,
      kind: dto.kind,
      targetId: dto.targetId,
    });
  }

  @Post('parts/:partId/open')
  @StudentOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Open a purchased document',
    description:
      'Returns a short-lived signed URL bound to the user, session and device, plus the watermark payload the client renders over the page. The underlying object is never public and its key is never sent. Requires an entitlement unless the part is a free preview.',
  })
  open(
    @Param('partId') partId: string,
    @CurrentUser() user: AuthenticatedUser,
    @DeviceInfo() device: DeviceContext | null,
    @ClientIp() ip: string | null,
  ) {
    return this.documents.issueTicket({
      libraryPartId: partId,
      user,
      integritySuspect: device?.integritySuspect ?? false,
      ip,
    });
  }
}

/**
 * Library administration.
 *
 * `@AdminOnly()` throughout, deliberately excluding teachers: the Library is a
 * platform-wide catalogue with its own pricing, not course content delegated to
 * an instructor. A teacher has no assignment that could scope access to it.
 */
@ApiTags('admin')
@ApiBearerAuth('access-token')
@Controller('admin/library')
export class LibraryAdminController {
  constructor(
    private readonly library: LibraryService,
    private readonly purchases: LibraryPurchaseService,
  ) {}

  @Get('materials')
  @AdminOnly()
  @ApiOperation({ summary: 'Browse materials, including drafts and inactive ones' })
  list(@Query() query: AdminListLibraryDto) {
    return this.library.listForAdmin({
      page: query.page,
      pageSize: query.pageSize,
      q: query.q,
      status: query.status,
    });
  }

  @Get('materials/:materialId')
  @AdminOnly()
  @ApiOperation({
    summary: 'Full material detail for the editor',
    description:
      'Includes inactive and draft parts and packages. Object keys are never returned — only whether a document is present.',
  })
  detail(@Param('materialId') materialId: string) {
    return this.library.materialForAdmin(materialId);
  }

  @Post('materials')
  @AdminOnly()
  @ApiOperation({ summary: 'Create a material' })
  createMaterial(@Body() dto: CreateMaterialDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.library.createMaterial(dto, actor);
  }

  @Patch('materials/:materialId')
  @AdminOnly()
  @ApiOperation({ summary: 'Edit a material' })
  updateMaterial(
    @Param('materialId') materialId: string,
    @Body() dto: UpdateMaterialDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.library.updateMaterial(materialId, dto, actor);
  }

  @Delete('materials/:materialId')
  @AdminOnly()
  @ApiOperation({
    summary: 'Remove a material',
    description:
      'Soft delete, refused once students hold entitlements to any of its parts — removing it would orphan something they paid for. Deactivate instead.',
  })
  removeMaterial(
    @Param('materialId') materialId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.library.removeMaterial(materialId, actor);
  }

  @Post('materials/:materialId/parts')
  @AdminOnly()
  @ApiOperation({
    summary: 'Add a document to a material',
    description:
      'Takes the object key from a presigned upload, never a public URL. Each part carries its own absolute price.',
  })
  createPart(
    @Param('materialId') materialId: string,
    @Body() dto: CreateLibraryPartDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.library.createPart(materialId, dto, actor);
  }

  @Patch('parts/:partId')
  @AdminOnly()
  @ApiOperation({
    summary: 'Edit a document',
    description:
      'Price changes never affect existing purchases, which carry their own frozen price. Replacing the file of a part students already hold is allowed but logged loudly.',
  })
  updatePart(
    @Param('partId') partId: string,
    @Body() dto: UpdateLibraryPartDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.library.updatePart(partId, dto, actor);
  }

  @Delete('parts/:partId')
  @AdminOnly()
  @ApiOperation({
    summary: 'Remove a document',
    description:
      'Refused once anyone holds it, or while it is inside a package. Deactivate instead.',
  })
  removePart(@Param('partId') partId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.library.removePart(partId, actor);
  }

  @Post('packages')
  @AdminOnly()
  @ApiOperation({
    summary: 'Create a package',
    description:
      'A bundle of documents at one price, independent of what they cost separately — a bundle discount is the point of a bundle.',
  })
  createPackage(
    @Body() dto: CreateLibraryPackageDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.library.createPackage(dto, actor);
  }

  @Patch('packages/:packageId')
  @AdminOnly()
  @ApiOperation({
    summary: 'Edit a package',
    description:
      'Changing the contents affects future purchases only. Everyone who already bought holds entitlements to the parts it contained on that day.',
  })
  updatePackage(
    @Param('packageId') packageId: string,
    @Body() dto: UpdateLibraryPackageDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.library.updatePackage(packageId, dto, actor);
  }

  @Delete('packages/:packageId')
  @AdminOnly()
  @ApiOperation({
    summary: 'Remove a package',
    description: 'Refused once purchased. Deactivate instead.',
  })
  removePackage(
    @Param('packageId') packageId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.library.removePackage(packageId, actor);
  }

  @Get('purchases')
  @AdminOnly()
  @ApiOperation({
    summary: 'Library purchase report',
    description:
      'Totals are labelled `creditsSpent`. Cash was recognised when the credits were bought; adding this to recharge revenue would double-count every pound.',
  })
  report(@Query() query: LibraryPurchaseReportDto) {
    return this.library.purchaseReport({
      page: query.page,
      pageSize: query.pageSize,
      userId: query.userId,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
  }
}
