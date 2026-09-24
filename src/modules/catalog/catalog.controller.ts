import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuditAction } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { AdminOnly } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/request-context';

import { AppException } from '../../common/errors/app.exception';

import { CatalogService, type CatalogEntity } from './catalog.service';

const CATALOG_ENTITIES = ['university', 'faculty', 'department', 'academicYear'] as const;

/**
 * Resolves the `:entity` path segment.
 *
 * Two jobs. First, an unknown value must be refused: the service switches on
 * this union, and a value matching no case used to fall straight through and
 * answer `{ ok: true }` having changed nothing — a deactivation that reported
 * success and did not happen.
 *
 * Second, the plural spellings are accepted. The dashboard sent
 * `catalog/universities/:id` against a switch expecting `university`, which is
 * exactly how that silent no-op was reached in practice. Mapping them here
 * means any client already in the field starts working again, rather than
 * starting to fail.
 */
function parseEntity(value: string): CatalogEntity {
  const plural: Record<string, CatalogEntity> = {
    universities: 'university',
    faculties: 'faculty',
    departments: 'department',
    'academic-years': 'academicYear',
    academicYears: 'academicYear',
  };

  const resolved = plural[value] ?? value;

  if (!CATALOG_ENTITIES.includes(resolved as CatalogEntity)) {
    throw AppException.validation({
      entity: [`must be one of: ${CATALOG_ENTITIES.join(', ')}`],
    });
  }

  return resolved as CatalogEntity;
}

class CreateUniversityDto {
  @IsString() @MaxLength(160) name!: string;
  @IsString() @MaxLength(160) nameAr!: string;
  @IsOptional() @IsString() @MaxLength(32) code?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) sortOrder?: number;
}

class UpdateUniversityDto {
  @IsOptional() @IsString() @MaxLength(160) name?: string;
  @IsOptional() @IsString() @MaxLength(160) nameAr?: string;
  @IsOptional() @IsString() @MaxLength(500) logoUrl?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) sortOrder?: number;
}

class CreateFacultyDto {
  @IsString() @MaxLength(32) universityId!: string;
  @IsString() @MaxLength(160) name!: string;
  @IsString() @MaxLength(160) nameAr!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) sortOrder?: number;
}

class CreateDepartmentDto {
  @IsString() @MaxLength(32) facultyId!: string;
  @IsString() @MaxLength(160) name!: string;
  @IsString() @MaxLength(160) nameAr!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) sortOrder?: number;
}

/**
 * Renaming a college or a department.
 *
 * No parent id: reparenting is not offered here — see
 * `CatalogService.updateFaculty`. The shape is shared by both because the two
 * rows carry the same editable fields.
 */
class UpdateCatalogNodeDto {
  @IsOptional() @IsString() @MaxLength(160) name?: string;
  @IsOptional() @IsString() @MaxLength(160) nameAr?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) sortOrder?: number;
}

class CreateAcademicYearDto {
  @Type(() => Number) @IsInt() @Min(1) order!: number;
  @IsString() @MaxLength(80) name!: string;
  @IsString() @MaxLength(80) nameAr!: string;
}

/**
 * Public catalogue reads + administrative writes.
 *
 * The read paths are public because the registration screen needs them before
 * the student has an account. They expose no personal data.
 */
@ApiTags('catalog')
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('universities')
  @Public()
  @ApiOperation({ summary: 'List universities' })
  universities() {
    return this.catalog.universities();
  }

  @Get('universities/:universityId/faculties')
  @Public()
  @ApiOperation({ summary: 'List faculties of a university' })
  faculties(@Param('universityId') universityId: string) {
    return this.catalog.faculties(universityId);
  }

  @Get('faculties/:facultyId/departments')
  @Public()
  @ApiOperation({ summary: 'List departments of a faculty' })
  departments(@Param('facultyId') facultyId: string) {
    return this.catalog.departments(facultyId);
  }

  @Get('academic-years')
  @Public()
  @ApiOperation({ summary: 'List academic years, ordered' })
  academicYears() {
    return this.catalog.academicYears();
  }

  @Get('tree')
  @AdminOnly()
  @ApiOperation({ summary: 'Whole academic tree (admin dashboards)' })
  tree() {
    return this.catalog.tree();
  }

  // --- writes ----------------------------------------------------------------

  @Post('universities')
  @AdminOnly()
  @Audit({ action: AuditAction.CREATE, entity: 'university' })
  @ApiOperation({ summary: 'Create a university' })
  createUniversity(@Body() dto: CreateUniversityDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.catalog.createUniversity(dto, actor);
  }

  @Patch('universities/:id')
  @AdminOnly()
  @ApiOperation({ summary: 'Update a university' })
  updateUniversity(
    @Param('id') id: string,
    @Body() dto: UpdateUniversityDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.catalog.updateUniversity(id, dto, actor);
  }

  @Post('faculties')
  @AdminOnly()
  @ApiOperation({ summary: 'Create a faculty' })
  createFaculty(@Body() dto: CreateFacultyDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.catalog.createFaculty(dto, actor);
  }

  @Post('departments')
  @AdminOnly()
  @ApiOperation({ summary: 'Create a department' })
  createDepartment(@Body() dto: CreateDepartmentDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.catalog.createDepartment(dto, actor);
  }

  @Patch('faculties/:id')
  @AdminOnly()
  @ApiOperation({
    summary: 'Rename or reorder a college',
    description: 'The parent university cannot be changed here — that is a migration.',
  })
  updateFaculty(
    @Param('id') id: string,
    @Body() dto: UpdateCatalogNodeDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.catalog.updateFaculty(id, dto, actor);
  }

  @Patch('departments/:id')
  @AdminOnly()
  @ApiOperation({
    summary: 'Rename or reorder a department',
    description: 'The parent college cannot be changed here — that is a migration.',
  })
  updateDepartment(
    @Param('id') id: string,
    @Body() dto: UpdateCatalogNodeDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.catalog.updateDepartment(id, dto, actor);
  }

  @Post('academic-years')
  @AdminOnly()
  @ApiOperation({ summary: 'Create an academic year' })
  createAcademicYear(
    @Body() dto: CreateAcademicYearDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.catalog.createAcademicYear(dto, actor);
  }

  @Delete(':entity/:id')
  @AdminOnly()
  @ApiOperation({
    summary: 'Deactivate a catalogue entity',
    description:
      'Soft deactivation only. Students reference these rows, so a hard delete would orphan enrolment records.',
  })
  deactivate(
    @Param('entity') entity: string,
    @Param('id') id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.catalog.deactivate(parseEntity(entity), id, actor);
  }

  @Get(':entity/:id/dependents')
  @AdminOnly()
  @ApiOperation({
    summary: 'What hangs off a catalogue entity',
    description:
      'Read before confirming a deactivation, so the dialog can say what else is affected rather than asking the admin to guess.',
  })
  dependents(@Param('entity') entity: string, @Param('id') id: string) {
    return this.catalog.dependents(parseEntity(entity), id);
  }

  @Post(':entity/:id/reactivate')
  @AdminOnly()
  @ApiOperation({
    summary: 'Put a deactivated catalogue entity back into service',
    description:
      'Clears the soft-delete marker as well as the flag; a row that regained only `isActive` would stay filtered out of every list.',
  })
  reactivate(
    @Param('entity') entity: string,
    @Param('id') id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.catalog.reactivate(parseEntity(entity), id, actor);
  }
}
