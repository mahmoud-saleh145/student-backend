import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccountStatus, AuditAction, Gender, UserRole } from '@prisma/client';
import {
  IsEnum,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminOnly, MasterOnly } from '../../common/decorators/roles.decorator';
import { SearchablePaginationDto } from '../../common/dto/pagination.dto';
import type { AuthenticatedUser } from '../../common/types/request-context';

import { UsersService } from './users.service';

class ListUsersDto extends SearchablePaginationDto {
  @IsOptional() @IsEnum(UserRole) role?: UserRole;
  @IsOptional() @IsEnum(AccountStatus) status?: AccountStatus;
  @IsOptional() @IsString() @MaxLength(32) universityId?: string;
  @IsOptional() @IsString() @MaxLength(32) academicYearId?: string;
}

class TeacherProfileDto {
  @IsOptional() @IsString() @MaxLength(120) title?: string;
  @IsOptional() @IsString() @MaxLength(120) titleAr?: string;
  @IsOptional() @IsString() @MaxLength(2000) bio?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(100) revenueSharePercent?: number;
  @IsOptional() isPublic?: boolean;
}

class CreateStaffDto {
  @IsString() @MaxLength(20)
  @Matches(/^(?:\+?20|0020)?1[0125]\d{8}$/, { message: 'phone must be a valid Egyptian mobile' })
  phone!: string;

  @IsString() @MinLength(8) @MaxLength(128) password!: string;
  @IsString() @MinLength(3) @MaxLength(120) fullName!: string;

  /** MASTER is rejected by the service — it is created out of band only. */
  @IsIn([UserRole.ADMIN, UserRole.TEACHER]) role!: UserRole;

  @IsOptional() @IsEnum(Gender) gender?: Gender;
  @IsOptional() @IsString() @MaxLength(160) email?: string;
  @IsOptional() @IsObject() teacher?: TeacherProfileDto;
}

class UpdateUserDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(120) fullName?: string;
  @IsOptional() @IsEnum(AccountStatus) status?: AccountStatus;
  @IsOptional() @IsEnum(Gender) gender?: Gender;
  @IsOptional() @IsString() @MaxLength(160) email?: string;
  @IsOptional() @IsString() @MaxLength(32) universityId?: string;
  @IsOptional() @IsString() @MaxLength(32) facultyId?: string;
  @IsOptional() @IsString() @MaxLength(32) departmentId?: string;
  @IsOptional() @IsString() @MaxLength(32) academicYearId?: string;
  @IsOptional() @IsObject() teacher?: TeacherProfileDto;
}

class ResetPasswordDto {
  @IsString() @MinLength(8) @MaxLength(128) newPassword!: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

class DeleteUserDto {
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

@ApiTags('admin')
@ApiBearerAuth('access-token')
@Controller('admin/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @AdminOnly()
  @ApiOperation({ summary: 'List users' })
  list(@Query() query: ListUsersDto) {
    return this.users.list({
      page: query.page,
      pageSize: query.pageSize,
      role: query.role,
      status: query.status,
      q: query.q,
      universityId: query.universityId,
      academicYearId: query.academicYearId,
    });
  }

  @Get(':id')
  @AdminOnly()
  @ApiOperation({ summary: 'Get one user' })
  detail(@Param('id') id: string) {
    return this.users.findById(id);
  }

  @Post()
  @AdminOnly()
  @Audit({ action: AuditAction.CREATE, entity: 'user' })
  @ApiOperation({
    summary: 'Create a staff account',
    description:
      'Admins may create teachers. Only the master may create administrators. The master account itself is never created through the API.',
  })
  create(@Body() dto: CreateStaffDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.users.createStaff(dto, actor);
  }

  @Patch(':id')
  @AdminOnly()
  @ApiOperation({
    summary: 'Update a user',
    description:
      'Suspending or disabling an account immediately revokes its sessions, refresh tokens and any active playback grant.',
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.users.updateByAdmin(id, dto, actor);
  }

  @Put(':id/password')
  @AdminOnly()
  @ApiOperation({
    summary: 'Reset a user password',
    description:
      'The platform has no self-service password reset (spec §13). Staff verify identity out of band and set a new password here; every session for that user is revoked.',
  })
  resetPassword(
    @Param('id') id: string,
    @Body() dto: ResetPasswordDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.users.resetPasswordByAdmin(id, dto.newPassword, actor, dto.note);
  }

  @Delete(':id')
  @MasterOnly()
  @ApiOperation({
    summary: 'Soft-delete a user (master only)',
    description:
      'Marks the account deleted and frees the phone number. Financial and audit history is retained — the database forbids a hard delete.',
  })
  remove(
    @Param('id') id: string,
    @Body() dto: DeleteUserDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.users.softDelete(id, actor, dto.reason);
  }
}
