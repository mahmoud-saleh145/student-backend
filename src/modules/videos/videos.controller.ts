import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { StaffOnly } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/request-context';

import { VideosService } from './videos.service';

class InitUploadDto {
  @IsString() @MaxLength(32) lessonId!: string;

  @IsString()
  @MaxLength(255)
  @Matches(/^[\w .()\-؀-ۿ]+\.[A-Za-z0-9]{2,5}$/, {
    message: 'filename contains unsupported characters',
  })
  filename!: string;

  @IsString() @MaxLength(100) contentType!: string;

  @Type(() => Number) @IsInt() @Min(1) @Max(8 * 1024 * 1024 * 1024) sizeBytes!: number;
}

class AddCaptionDto {
  @IsIn(['en', 'ar']) language!: string;
  @IsString() @MaxLength(80) label!: string;
  @IsString() @MaxLength(400) objectKey!: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

/**
 * Video upload and processing.
 *
 * Note what is absent: there is no endpoint here that returns a playable URL.
 * Delivery is exclusively through POST /playback/videos/{id}/ticket.
 */
@ApiTags('videos')
@ApiBearerAuth('access-token')
@Controller('videos')
export class VideosController {
  constructor(private readonly videos: VideosService) {}

  @Post('uploads/init')
  @StaffOnly()
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Returns a presigned PUT to the private uploads bucket. Bytes go client→R2 directly; this API never proxies the file.',
  })
  init(@Body() dto: InitUploadDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.videos.initUpload(dto, actor);
  }

  @Post(':videoId/complete')
  @StaffOnly()
  @ApiOperation({
    summary: 'Confirm the upload and queue transcoding',
    description:
      'Verifies the object actually landed in storage before enqueueing, so the queue does not fill with jobs that fail minutes later.',
  })
  complete(@Param('videoId') videoId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.videos.completeUpload(videoId, actor);
  }

  @Get(':videoId/status')
  @StaffOnly()
  @ApiOperation({
    summary: 'Processing status and generated renditions',
    description: 'Poll this while status is QUEUED or PROCESSING.',
  })
  status(@Param('videoId') videoId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.videos.status(videoId, actor);
  }

  @Post(':videoId/retry')
  @StaffOnly()
  @ApiOperation({ summary: 'Re-run transcoding from the stored source' })
  retry(@Param('videoId') videoId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.videos.retryProcessing(videoId, actor);
  }

  @Post(':videoId/captions')
  @StaffOnly()
  @ApiOperation({
    summary: 'Attach a caption track',
    description: 'Takes an object key from POST /storage/uploads/attachment.',
  })
  addCaption(
    @Param('videoId') videoId: string,
    @Body() dto: AddCaptionDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.videos.addCaption(videoId, dto, actor);
  }

  @Delete(':videoId/captions/:language')
  @StaffOnly()
  @ApiOperation({ summary: 'Remove a caption track' })
  removeCaption(
    @Param('videoId') videoId: string,
    @Param('language') language: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.videos.removeCaption(videoId, language, actor);
  }

  @Delete(':videoId')
  @StaffOnly()
  @ApiOperation({
    summary: 'Archive a video and purge its media objects',
    description:
      'The metadata row is retained because watch events reference it; the HLS output and source file are deleted from storage.',
  })
  remove(@Param('videoId') videoId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.videos.remove(videoId, actor);
  }
}
