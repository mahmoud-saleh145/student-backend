import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsISO8601,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { Request } from 'express';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { PlaybackThrottle } from '../../common/decorators/throttle.decorator';
import type { AuthenticatedUser } from '../../common/types/request-context';

import { PlaybackService } from './playback.service';

class ProtectionStateDto {
  @IsOptional() @IsBoolean() secureSurface?: boolean;
  @IsOptional() @IsBoolean() recording?: boolean;
  @IsOptional() @IsBoolean() externalDisplay?: boolean;
}

class IssueTicketDto {
  /** Server-enforced quality ceiling, mirrored into the signed URL. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(144)
  @Max(2160)
  maxHeight?: number;

  @IsOptional() @IsIn(['ios', 'android', 'web']) platform?: string;
}

class HeartbeatDto {
  @Type(() => Number) @IsInt() @Min(0) @Max(86_400) positionSeconds!: number;
  @Type(() => Number) @IsInt() @Min(0) @Max(3600) watchedDeltaSeconds!: number;
  @IsOptional() @IsObject() protection?: ProtectionStateDto;
}

class SecurityEventDto {
  @IsIn([
    'SCREENSHOT',
    'RECORDING_STARTED',
    'RECORDING_STOPPED',
    'EXTERNAL_DISPLAY',
    'INTEGRITY',
  ])
  threat!: string;

  @IsOptional() @IsString() @MaxLength(32) videoId?: string;
  @IsOptional() @IsString() @MaxLength(32) courseId?: string;
  @IsOptional() @IsString() @MaxLength(32) lessonId?: string;
  @IsOptional() @IsString() @MaxLength(32) ticketId?: string;
  @IsOptional() @IsObject() meta?: Record<string, unknown>;
  @IsOptional() @IsISO8601() occurredAt?: string;
}

/**
 * Protected playback.
 *
 * Paths match the mobile app's `Endpoints.playback` map exactly:
 *   POST   /playback/videos/:videoId/ticket
 *   POST   /playback/tickets/:ticketId/heartbeat
 *   DELETE /playback/tickets/:ticketId
 *   POST   /playback/security-events
 *
 * Nothing on any other route in this API returns a playable media URL.
 */
@ApiTags('playback')
@ApiBearerAuth('access-token')
@Controller('playback')
export class PlaybackController {
  constructor(private readonly playback: PlaybackService) {}

  @Post('videos/:videoId/ticket')
  @PlaybackThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request playback authorization',
    description: [
      'Runs the full chain before issuing anything: rate limit → video READY →',
      'course access → lesson access → drip window → device binding →',
      'concurrency slot. Only then is a short-lived, viewer-bound signed',
      'manifest URL minted.',
      '',
      'The returned URL is bound to user + session + device + ticket, so it',
      'fails at the CDN edge if copied elsewhere, and expires after',
      'PLAYBACK_TICKET_TTL seconds.',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, description: 'PlaybackTicket' })
  @ApiResponse({ status: 403, description: 'PLAYBACK_DENIED | DEVICE_NOT_AUTHORIZED | NOT_ENROLLED' })
  @ApiResponse({ status: 409, description: 'VIDEO_NOT_READY' })
  @ApiResponse({ status: 410, description: 'ACCESS_EXPIRED | COURSE_ARCHIVED' })
  @ApiResponse({ status: 429, description: 'CONCURRENT_STREAM_LIMIT | RATE_LIMITED' })
  issue(
    @Param('videoId') videoId: string,
    @Body() dto: IssueTicketDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.playback.issueTicket({
      user,
      videoId,
      maxHeight: dto.maxHeight ?? null,
      ip: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
      integritySuspect: req.deviceContext?.integritySuspect ?? false,
    });
  }

  @Post('tickets/:ticketId/heartbeat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Keep the playback session alive and report position',
    description: [
      'Re-checks access on every beat, which is what makes revocation real:',
      'an admin revoking an enrollment stops playback within one interval.',
      '',
      'Returns `terminate` when the server wants playback to stop, and a fresh',
      '`ticket` when the grant was rotated ahead of expiry.',
    ].join('\n'),
  })
  heartbeat(
    @Param('ticketId') ticketId: string,
    @Body() dto: HeartbeatDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.playback.heartbeat({
      user,
      ticketId,
      positionSeconds: dto.positionSeconds,
      watchedDeltaSeconds: dto.watchedDeltaSeconds,
      protection: dto.protection,
      ip: req.ip ?? null,
    });
  }

  @Delete('tickets/:ticketId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Release the playback session',
    description:
      'Frees the concurrency slot immediately, so the student is not locked out of their own next video.',
  })
  release(@Param('ticketId') ticketId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.playback.release(user, ticketId);
  }

  /**
   * Edge liveness probe.
   *
   * Called by the Cloudflare Worker in front of the media bucket (see
   * docs/cloudflare-worker.js), not by the app.
   *
   * It is `@Public` because the caller is a Worker holding no user token, and
   * that is safe here for two reasons: the response is a single boolean about
   * a ticket id the caller must already possess, and the `uid` must match the
   * ticket's owner, so the endpoint cannot be used to enumerate anything. A
   * wrong or unknown ticket returns `{ live: false }` rather than a 404, so it
   * leaks nothing about which ids exist.
   *
   * This exists because a valid signature proves *who minted the URL*, not
   * that the grant is still good. Between minting and the next segment
   * request, the session may have been revoked, the device unbound, or a
   * capture detected. The Worker caches this answer for ten seconds.
   */
  @Get('tickets/:ticketId/state')
  @Public()
  @ApiOperation({
    summary: 'Is this playback grant still live? (edge use)',
    description:
      'Consumed by the media edge Worker. Returns { live } only — never ticket contents.',
  })
  ticketState(
    @Param('ticketId') ticketId: string,
    @Query('uid') uid?: string,
  ): Promise<{ live: boolean }> {
    return this.playback.ticketLiveness(ticketId, uid ?? null);
  }

  @Post('security-events')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Report a client-side capture or integrity event',
    description: [
      'Client telemetry, stored server-side where a patched app cannot strip',
      'it. Repeated capture attempts inside one playback session end that',
      'session — a bounded, reversible response. The account is never',
      'automatically restricted on this signal.',
    ].join('\n'),
  })
  securityEvent(
    @Body() dto: SecurityEventDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.playback.recordSecurityEvent({
      user,
      threat: dto.threat,
      videoId: dto.videoId,
      courseId: dto.courseId,
      lessonId: dto.lessonId,
      ticketId: dto.ticketId,
      meta: dto.meta,
      occurredAt: dto.occurredAt,
      ip: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
  }
}
