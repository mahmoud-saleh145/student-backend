import { Body, Controller, Get, Patch, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/request-context';

import { UsersService } from './users.service';

class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(5)
  @MaxLength(120)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value,
  )
  fullName?: string;

  @IsOptional()
  @IsIn(['en', 'ar'])
  locale?: string;

  /**
   * Only accepted while the `student.allowAcademicYearChange` platform setting
   * is on; the service refuses it otherwise. Kept out of the other academic
   * fields deliberately — university/faculty/department still stay
   * administrative, because they determine course eligibility.
   */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  academicYearId?: string;
}

class SetAvatarDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  avatarUrl?: string | null;
}

/**
 * Student-facing profile endpoints.
 *
 * Path shapes match the mobile app's `Endpoints.profile` map exactly:
 * GET/PATCH /profile, PUT /profile/avatar, PUT /profile/password.
 */
@ApiTags('auth')
@ApiBearerAuth('access-token')
@Controller('profile')
export class ProfileController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'Get your profile' })
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.users.toPublicUser(user.id);
  }

  @Patch()
  @ApiOperation({
    summary: 'Update your profile',
    description:
      'Display name and locale are always self-editable. Academic year is self-editable only while the student.allowAcademicYearChange setting is on. Phone identifies the account and the remaining academic fields drive course eligibility, so both stay administrative.',
  })
  update(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateProfileDto) {
    return this.users.updateOwnProfile(user.id, dto);
  }

  @Put('avatar')
  @ApiOperation({
    summary: 'Set or clear your avatar',
    description:
      'Takes a storage key previously obtained from POST /storage/uploads/avatar. The API never accepts raw image bytes on this route.',
  })
  avatar(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetAvatarDto) {
    return this.users.setAvatar(user.id, dto.avatarUrl ?? null);
  }
}
