import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminOnly, StaffOnly } from '../../common/decorators/roles.decorator';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthenticatedUser } from '../../common/types/request-context';

import { StorageService } from './storage.service';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const DOC_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

class PresignAvatarDto {
  @IsIn(IMAGE_TYPES) contentType!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(5 * 1024 * 1024) sizeBytes!: number;
}

class PresignCourseThumbnailDto {
  @IsString() @MaxLength(32) courseId!: string;
  @IsIn(IMAGE_TYPES) contentType!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(10 * 1024 * 1024) sizeBytes!: number;
}

/**
 * A library document.
 *
 * Carries no `courseId` because the Library has none: a student may buy here
 * while enrolled in nothing. That is the whole reason this DTO exists rather
 * than reusing `PresignAttachmentDto`, whose `courseId` is required and
 * decides the storage prefix.
 *
 * Exported for `test/unit/storage-library-upload.spec.ts`, which runs the real
 * validation pipe against it rather than restating the rules in a second
 * place where they could drift.
 */
export class PresignLibraryDocumentDto {
  @IsString() @MaxLength(200)
  @Matches(/^[\w .()\-؀-ۿ]+\.[A-Za-z0-9]{1,8}$/, {
    message: 'filename contains unsupported characters',
  })
  filename!: string;

  @IsIn([...DOC_TYPES, ...IMAGE_TYPES]) contentType!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(200 * 1024 * 1024) sizeBytes!: number;
}

class PresignAttachmentDto {
  @IsString() @MaxLength(32) courseId!: string;
  @IsString() @MaxLength(200)
  @Matches(/^[\w .()\-؀-ۿ]+\.[A-Za-z0-9]{1,8}$/, {
    message: 'filename contains unsupported characters',
  })
  filename!: string;

  @IsIn([...DOC_TYPES, ...IMAGE_TYPES]) contentType!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(200 * 1024 * 1024) sizeBytes!: number;
  @IsOptional() @IsString() @MaxLength(32) lessonId?: string;
}

/**
 * Direct-to-storage upload tickets.
 *
 * Bytes never pass through this API: the client PUTs straight to R2 with a
 * presigned URL and then reports the object key back to the owning domain
 * endpoint. That keeps a 2 GB lecture upload from occupying a Node worker,
 * and keeps the API's memory profile flat.
 *
 * The content type is allow-listed here and re-checked on the object after
 * upload, because a presigned URL's Content-Type is client-asserted.
 */
@ApiTags('videos')
@ApiBearerAuth('access-token')
@Controller('storage')
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Post('uploads/avatar')
  @ApiOperation({ summary: 'Presign an avatar upload' })
  async avatar(@CurrentUser() user: AuthenticatedUser, @Body() dto: PresignAvatarDto) {
    const ext = extensionFor(dto.contentType);
    return this.storage.presignUpload({
      bucket: 'media',
      objectKey: StorageService.keys.avatar(user.id, ext),
      contentType: dto.contentType,
      expiresIn: 900,
    });
  }

  @Post('uploads/course-thumbnail')
  @StaffOnly()
  @ApiOperation({ summary: 'Presign a course thumbnail upload' })
  async courseThumbnail(@Body() dto: PresignCourseThumbnailDto) {
    const ext = extensionFor(dto.contentType);
    return this.storage.presignUpload({
      bucket: 'media',
      objectKey: StorageService.keys.courseThumbnail(dto.courseId, ext),
      contentType: dto.contentType,
      expiresIn: 900,
    });
  }

  @Post('uploads/attachment')
  @StaffOnly()
  @ApiOperation({
    summary: 'Presign a course material upload',
    description:
      'Returns an object key. Register it with POST /attachments to make it visible to students.',
  })
  async attachment(@Body() dto: PresignAttachmentDto) {
    if (dto.filename.includes('..') || dto.filename.includes('/')) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, {
        fields: { filename: ['must not contain path separators'] },
      });
    }

    return this.storage.presignUpload({
      bucket: 'uploads',
      objectKey: StorageService.keys.attachment(dto.courseId, dto.filename),
      contentType: dto.contentType,
      expiresIn: 3600,
    });
  }

  @Post('uploads/library-document')
  @AdminOnly()
  @ApiOperation({
    summary: 'Presign a library document upload',
    description:
      'Returns an object key. Register it with POST /admin/library/materials/:id/parts, or PATCH a part to replace its file. The bucket is private and the key is never served to a student — reading is always through a short-lived, viewer-bound signed URL.',
  })
  async libraryDocument(@Body() dto: PresignLibraryDocumentDto) {
    if (dto.filename.includes('..') || dto.filename.includes('/')) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, {
        fields: { filename: ['must not contain path separators'] },
      });
    }

    return this.storage.presignUpload({
      bucket: 'uploads',
      objectKey: StorageService.keys.libraryDocument(dto.filename),
      contentType: dto.contentType,
      expiresIn: 3600,
    });
  }
}

function extensionFor(contentType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
  };
  return map[contentType] ?? '.bin';
}
