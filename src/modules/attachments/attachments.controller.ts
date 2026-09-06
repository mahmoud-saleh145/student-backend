import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AttachmentKind } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { Request } from 'express';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { StaffOnly } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/request-context';

import { AttachmentsService } from './attachments.service';

class CreateAttachmentDto {
  @IsString() @MaxLength(32) courseId!: string;
  @IsOptional() @IsString() @MaxLength(32) lessonId?: string;
  @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @IsEnum(AttachmentKind) kind!: AttachmentKind;
  @IsString() @MaxLength(400) objectKey!: string;
  @IsOptional() @IsString() @MaxLength(100) mimeType?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) sizeBytes?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) pageCount?: number;
  @IsOptional() @IsBoolean() isProtected?: boolean;
  @IsOptional() @IsBoolean() isDownloadable?: boolean;
  @IsOptional() @IsBoolean() isPreview?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) sortOrder?: number;
}

class UpdateAttachmentDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) title?: string;
  @IsOptional() @IsBoolean() isProtected?: boolean;
  @IsOptional() @IsBoolean() isDownloadable?: boolean;
  @IsOptional() @IsBoolean() isPreview?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) sortOrder?: number;
}

@ApiTags('attachments')
@ApiBearerAuth('access-token')
@Controller()
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get('attachments/:id/ticket')
  @ApiOperation({
    summary: 'Get a short-lived link to a protected material',
    description: [
      'Same model as video: no permanent URL, a viewer-bound signed link that',
      'expires, device binding enforced for protected files, and a watermark',
      'payload so a leaked screenshot is traceable.',
    ].join(' '),
  })
  @ApiResponse({ status: 403, description: 'NOT_ENROLLED | DEVICE_NOT_AUTHORIZED' })
  @ApiResponse({ status: 410, description: 'ACCESS_EXPIRED | COURSE_ARCHIVED' })
  ticket(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.attachments.issueTicket({
      user,
      attachmentId: id,
      integritySuspect: req.deviceContext?.integritySuspect ?? false,
      ip: req.ip ?? null,
    });
  }

  @Get('lessons/:lessonId/attachments')
  @ApiOperation({ summary: 'Materials attached to a lesson' })
  forLesson(@Param('lessonId') lessonId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.attachments.listForLesson(lessonId, user.id, user.role);
  }

  // --- authoring -------------------------------------------------------------

  @Post('attachments')
  @StaffOnly()
  @ApiOperation({
    summary: 'Register an uploaded material',
    description:
      'Takes an object key from POST /storage/uploads/attachment. Setting isProtected forces isDownloadable off — the two contradict each other and protection wins.',
  })
  create(@Body() dto: CreateAttachmentDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.attachments.create(dto, actor);
  }

  @Patch('attachments/:id')
  @StaffOnly()
  @ApiOperation({ summary: 'Update material metadata' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAttachmentDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.attachments.update(id, dto, actor);
  }

  @Delete('attachments/:id')
  @StaffOnly()
  @ApiOperation({ summary: 'Remove a material and delete its object' })
  remove(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.attachments.remove(id, actor);
  }
}
