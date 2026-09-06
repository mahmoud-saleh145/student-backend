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

import { CatalogService } from './catalog.service';

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
    @Param('entity') entity: 'university' | 'faculty' | 'department' | 'academicYear',
    @Param('id') id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.catalog.deactivate(entity, id, actor);
  }
}
