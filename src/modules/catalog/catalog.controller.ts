import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AcademicStructureKind, AuditAction } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

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

class UpdateDepartmentDto extends UpdateCatalogNodeDto {}

/**
 * Creating a university, including the academic progression system its colleges
 * inherit.
 *
 * The field is named `defaultAcademicSystem` rather than `type` on purpose:
 * "type" was the ambiguous label that made this look like a government/private
 * flag, and the product keeps the two concepts separate.
 */
class CreateUniversityDto {
  @IsString() @MaxLength(160) name!: string;
  @IsString() @MaxLength(160) nameAr!: string;
  @IsOptional() @IsString() @MaxLength(32) code?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) sortOrder?: number;
  @IsOptional()
  @IsEnum(AcademicStructureKind)
  defaultAcademicSystem?: AcademicStructureKind;
}

class UpdateUniversityDto {
  @IsOptional() @IsString() @MaxLength(160) name?: string;
  @IsOptional() @IsString() @MaxLength(160) nameAr?: string;
  @IsOptional() @IsString() @MaxLength(500) logoUrl?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) sortOrder?: number;
  @IsOptional()
  @IsEnum(AcademicStructureKind)
  defaultAcademicSystem?: AcademicStructureKind;
}

/**
 * A college's academic system override.
 *
 * `null` is meaningful and distinct from "field omitted": it clears the
 * override and returns the college to inheritance. The field itself is optional
 * so a caller can leave the setting untouched.
 */
class UpdateFacultyDto extends UpdateCatalogNodeDto {
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsEnum(AcademicStructureKind)
  academicSystemOverride?: AcademicStructureKind | null;
}

class CreateFacultyDto {
  @IsString() @MaxLength(32) universityId!: string;
  @IsString() @MaxLength(160) name!: string;
  @IsString() @MaxLength(160) nameAr!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) sortOrder?: number;
}

class CreateDepartmentDto {
  @IsOptional() @IsEnum({ GENERAL: 'GENERAL', PROGRAMS: 'PROGRAMS' }) studyType?:
    'GENERAL' | 'PROGRAMS';
  @IsString() @MaxLength(32) facultyId!: string;
  @IsString() @MaxLength(160) name!: string;
  @IsString() @MaxLength(160) nameAr!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) sortOrder?: number;
}

class CreateAcademicYearDto {
  @Type(() => Number) @IsInt() @Min(1) order!: number;
  @IsString() @MaxLength(80) name!: string;
  @IsString() @MaxLength(80) nameAr!: string;
  /** Omitted means the platform-wide structure, as before structures existed. */
  @IsOptional() @IsString() structureId?: string;
}

/**
 * Which unit a structure belongs to. At most one may be given; the service
 * rejects more than one, because a structure owned by both a faculty and a
 * department has no representable scope.
 */
class AcademicScopeQueryDto {
  @IsOptional() @IsString() universityId?: string;
  @IsOptional() @IsString() facultyId?: string;
  @IsOptional() @IsString() departmentId?: string;
}

class CreateAcademicStructureDto extends AcademicScopeQueryDto {
  @IsEnum(AcademicStructureKind) kind!: AcademicStructureKind;
}

class UpdateAcademicStructureDto {
  @IsOptional() @IsEnum(AcademicStructureKind) kind?: AcademicStructureKind;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class StructureEntryDto {
  @Type(() => Number) @IsInt() @Min(1) order!: number;
  @IsString() @MaxLength(80) name!: string;
  @IsString() @MaxLength(80) nameAr!: string;
}

/**
 * The whole ladder in one write: how many rungs, and what each is called.
 *
 * The cap is 60 rather than 4 — the count is the Admin's to choose, and the
 * only reason for an upper bound at all is to stop a malformed request
 * creating thousands of rows.
 */
class ReplaceStructureEntriesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => StructureEntryDto)
  entries!: StructureEntryDto[];
}

/**
 * The faculties explicitly pinned to a structure.
 *
 * `ArrayMinSize` is deliberately absent: an empty array is how every override
 * is cleared, handing those faculties back to inheritance.
 */
class SetStructureFacultiesDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  facultyIds!: string[];
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
  departments(
    @Param('facultyId') facultyId: string,
    @Query('studyType') studyType?: 'GENERAL' | 'PROGRAMS',
  ) {
    if (studyType && !['GENERAL', 'PROGRAMS'].includes(studyType))
      throw AppException.validation({ studyType: ['must be GENERAL or PROGRAMS'] });
    return this.catalog.departments(facultyId, studyType);
  }

  @Get('academic-years')
  @Public()
  @ApiOperation({
    summary: 'List academic years or levels, ordered',
    description:
      "With no query parameters this returns the platform-wide list, exactly as before academic structures existed. Passing a university, faculty or department returns that unit's own list, inheriting upwards when it has none of its own. Each entry carries the structure's `kind` so the UI can label the control Year or Level.",
  })
  academicYears(@Query() query: AcademicScopeQueryDto) {
    return this.catalog.academicYears(query);
  }

  @Get('academic-selection')
  @Public()
  @ApiOperation({
    summary: 'The resolved academic system and the matching year/level list',
    description:
      "The single call a registration or onboarding screen needs. `academicSystem` is the college's effective system — the college's override if one is configured, otherwise its university's default — reported with `source` so the UI can say whether it is inherited or an explicit override, and with the entries that match it in `academicYears`. The two cannot disagree because they come from one request. No government/private university classification is accepted or required anywhere in this flow.",
  })
  academicSelection(@Query() query: AcademicScopeQueryDto) {
    return this.catalog.academicSelection(query);
  }

  @Get('academic-systems')
  @AdminOnly()
  @ApiOperation({
    summary:
      'Every university default and college override, with inheritance made explicit',
    description:
      'Each college reports its effective system, whether that value is inherited from its university or is an explicit override, and whether a stored override has gone stale by matching its university default.',
  })
  academicSystemOverview() {
    return this.catalog.academicSystemOverview();
  }

  @Get('academic-structures')
  @AdminOnly()
  @ApiOperation({ summary: 'Every academic structure with its entries' })
  academicStructures() {
    return this.catalog.academicStructures();
  }

  @Post('academic-structures')
  @AdminOnly()
  @ApiOperation({
    summary: 'Create an academic structure for a unit',
    description:
      'One per unit. Omit all three ids for the platform-wide structure that every unit inherits.',
  })
  createAcademicStructure(
    @Body() dto: CreateAcademicStructureDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.catalog.createAcademicStructure(dto, actor);
  }

  @Patch('academic-structures/:id')
  @AdminOnly()
  @ApiOperation({
    summary: 'Switch a structure between Years and Levels, or deactivate it',
    description:
      'Changing `kind` only changes how the rungs are labelled; the rungs themselves, and every student and course filed under them, are untouched.',
  })
  updateAcademicStructure(
    @Param('id') id: string,
    @Body() dto: UpdateAcademicStructureDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.catalog.updateAcademicStructure(id, dto, actor);
  }

  @Put('academic-structures/:id/entries')
  @AdminOnly()
  @ApiOperation({
    summary: "Define a structure's rungs: how many, and their names",
    description:
      'Entries are matched by `order`, so renaming a rung keeps every student and course already filed under it. A rung left out is deactivated rather than deleted, because rows point at it; sending it again reactivates it.',
  })
  replaceStructureEntries(
    @Param('id') id: string,
    @Body() dto: ReplaceStructureEntriesDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.catalog.replaceStructureEntries(id, dto.entries, actor);
  }

  @Put('academic-structures/:id/faculties')
  @AdminOnly()
  @ApiOperation({
    summary: 'Pin specific faculties to this structure, overriding inheritance',
    description:
      "Replaces the whole set. A pinned faculty uses this structure instead of the one it would inherit from its university, and may belong to ANY university — pinning one university's college to another's ladder is supported on purpose. A faculty pinned elsewhere is moved here, because a faculty can only have one structure. Send an empty array to clear every override and return those faculties to inheritance.",
  })
  setStructureFaculties(
    @Param('id') id: string,
    @Body() dto: SetStructureFacultiesDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.catalog.setStructureFacultyOverrides(id, dto.facultyIds, actor);
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
  createUniversity(
    @Body() dto: CreateUniversityDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
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
  createDepartment(
    @Body() dto: CreateDepartmentDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.catalog.createDepartment(dto, actor);
  }

  @Patch('faculties/:id')
  @AdminOnly()
  @ApiOperation({
    summary: 'Rename or reorder a college, or set its academic system override',
    description:
      "The parent university cannot be changed here — that is a migration. `academicSystemOverride` set to YEAR or LEVEL overrides the university's default for this college alone; set it to null to return the college to inheritance; omit it to leave it untouched. Sending a value equal to the university's current default is refused, because it records no decision and would survive the next change of that default.",
  })
  updateFaculty(
    @Param('id') id: string,
    @Body() dto: UpdateFacultyDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.catalog.updateFaculty(id, dto, actor);
  }

  /**
   * The override on its own route as well, for a screen that saves the academic
   * setting separately from the college's name and order. Same service call, so
   * the two routes cannot drift.
   */
  @Put('faculties/:id/academic-system-override')
  @AdminOnly()
  @ApiOperation({
    summary: "Set or clear a college's academic system override",
    description:
      'Send a YEAR or LEVEL value to override the university default for this college, or null to inherit. Independent of government/private ownership: any college of any university may be overridden in either direction.',
  })
  setFacultyAcademicSystemOverride(
    @Param('id') id: string,
    @Body() body: { academicSystemOverride?: AcademicStructureKind | null },
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.catalog.setFacultyAcademicSystemOverride(
      id,
      body.academicSystemOverride ?? null,
      actor,
    );
  }

  @Patch('departments/:id')
  @AdminOnly()
  @ApiOperation({
    summary: 'Rename or reorder a department',
    description: 'The parent college cannot be changed here — that is a migration.',
  })
  updateDepartment(
    @Param('id') id: string,
    @Body() dto: UpdateDepartmentDto,
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
