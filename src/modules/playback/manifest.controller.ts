import { Controller, Get, Header, Param, Query, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsString, MaxLength, Min } from 'class-validator';
import type { Response } from 'express';

import { Public } from '../../common/decorators/public.decorator';
import { RawResponse } from '../../common/decorators/raw-response.decorator';

import { ManifestService } from './manifest.service';

class SignedQueryDto {
  @Type(() => Number) @IsInt() @Min(0) exp!: number;
  @IsString() @MaxLength(200) sig!: string;

  /** Optional client ceiling; the ticket's ceiling still wins. */
  @Type(() => Number) @IsInt() @Min(0) maxHeight?: number;
}

/**
 * HLS delivery endpoints.
 *
 * @Public because native players cannot reliably attach an Authorization
 * header to manifest, segment and key requests — iOS AVPlayer in particular
 * drops them on sub-requests. Authorization therefore lives in the URL: every
 * one of these is HMAC-signed over the ticket id and an expiry, and every
 * request re-validates that the ticket, session and device are all still live.
 *
 * @RawResponse because a player expects `application/vnd.apple.mpegurl` and
 * raw key bytes, not a JSON envelope.
 */
@ApiTags('playback')
@Controller('playback')
export class ManifestController {
  constructor(private readonly manifest: ManifestService) {}

  @Get('manifest/:ticketId/master.m3u8')
  @Public()
  @RawResponse()
  @Header('Content-Type', 'application/vnd.apple.mpegurl')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, private')
  @ApiOperation({
    summary: 'Master playlist for a playback ticket',
    description:
      'Generated per session. Renditions above the ticket’s granted ceiling are omitted entirely, so a client cannot select a quality it was not authorized for.',
  })
  async master(
    @Param('ticketId') ticketId: string,
    @Query() query: SignedQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return this.manifest.masterPlaylist({
      ticketId,
      exp: query.exp,
      signature: query.sig,
      maxHeight: query.maxHeight,
    });
  }

  @Get('manifest/:ticketId/:height.m3u8')
  @Public()
  @RawResponse()
  @Header('Content-Type', 'application/vnd.apple.mpegurl')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, private')
  @ApiOperation({
    summary: 'Media playlist with per-viewer signed segment URLs',
    description:
      'Every segment URI is signed for this viewer and expires with the ticket. The EXT-X-KEY URI is repointed at this ticket’s key endpoint.',
  })
  async media(
    @Param('ticketId') ticketId: string,
    @Param('height') height: string,
    @Query() query: SignedQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return this.manifest.mediaPlaylist({
      ticketId,
      height: Number.parseInt(height, 10),
      exp: query.exp,
      signature: query.sig,
    });
  }

  @Get('keys/:ticketId')
  @Public()
  @RawResponse()
  @ApiExcludeEndpoint()
  async key(
    @Param('ticketId') ticketId: string,
    @Query() query: SignedQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const key = await this.manifest.contentKey({
      ticketId,
      exp: query.exp,
      signature: query.sig,
    });

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(key.length));
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).send(key);
  }
}
