import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminOnly, MasterOnly } from '../../common/decorators/roles.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import type { AuthenticatedUser } from '../../common/types/request-context';

import { SessionsService } from './sessions.service';

class ListActiveDto extends PaginationDto {
  @IsOptional() @IsEnum(UserRole) role?: UserRole;
}

class RevokeDto {
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  reason!: string;
}

/**
 * Staff-facing session control (spec §41, §56).
 *
 * A student's own session list lives at `/auth/sessions`; this controller is
 * for support and security staff acting on someone else's account, so every
 * route here is administrative and every mutation is audited.
 */
@ApiTags('sessions')
@ApiBearerAuth('access-token')
@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get('active')
  @MasterOnly()
  @ApiOperation({
    summary: 'Every currently active session on the platform',
    description:
      'Operational view for the master console. IP addresses are masked to the /24 — enough to spot a jump between countries, not enough to locate a student.',
  })
  active(@Query() query: ListActiveDto) {
    return this.sessions.listActive({
      page: query.page,
      pageSize: query.pageSize,
      role: query.role,
    });
  }

  @Get('users/:userId')
  @AdminOnly()
  @ApiOperation({
    summary: 'Session history for one account',
    description:
      'Includes ended sessions, because "when did this account last work normally" is the first question in a support case.',
  })
  forUser(@Param('userId') userId: string, @Query() query: PaginationDto) {
    return this.sessions.listForUser({
      userId,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Delete(':id')
  @AdminOnly()
  @ApiOperation({
    summary: 'End one session',
    description:
      'Revokes the session, its refresh-token family and any live playback grant bound to it. Idempotent.',
  })
  revoke(
    @Param('id') id: string,
    @Body() dto: RevokeDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.sessions.revoke({ sessionId: id, actor, reason: dto.reason });
  }

  @Post('users/:userId/revoke-all')
  @AdminOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign an account out everywhere',
    description:
      'Used after a credential-sharing report or a password reset. The account itself stays enabled — the student can sign in again immediately.',
  })
  revokeAll(
    @Param('userId') userId: string,
    @Body() dto: RevokeDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.sessions.revokeAllForUser({ userId, actor, reason: dto.reason });
  }

  @Post('users/:userId/revoke-playback')
  @AdminOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Stop all playback for an account without signing it out',
    description:
      'The proportionate response to a capture detection: streaming stops, the login survives. The student can start a new playback request, which re-runs the whole authorization chain.',
  })
  revokePlayback(
    @Param('userId') userId: string,
    @Body() dto: RevokeDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.sessions.revokePlaybackForUser({ userId, actor, reason: dto.reason });
  }
}
