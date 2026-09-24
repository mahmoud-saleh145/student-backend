import { Body, Controller, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminOnly, StaffOnly } from '../../common/decorators/roles.decorator';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthenticatedUser } from '../../common/types/request-context';

import type { Request } from 'express';

import { StorageService } from './storage.service';

/** Ceiling for a Library document, shared by both upload transports. */
const MAX_LIBRARY_DOCUMENT_BYTES = 200 * 1024 * 1024;

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
  @Type(() => Number) @IsInt() @Min(1) @Max(MAX_LIBRARY_DOCUMENT_BYTES) sizeBytes!: number;
}

/**
 * The proxied Library upload.
 *
 * Same filename and content-type rules as `PresignLibraryDocumentDto` — the
 * decorators are restated rather than shared because the two carry different
 * size fields: the presign form is *told* the size, whereas here the size is a
 * fact of the request and is read from Content-Length rather than trusted.
 */
export class UploadLibraryDocumentQueryDto {
  @IsString() @MaxLength(200)
  @Matches(/^[\w .()\-؀-ۿ]+\.[A-Za-z0-9]{1,8}$/, {
    message: 'filename contains unsupported characters',
  })
  filename!: string;

  @IsIn([...DOC_TYPES, ...IMAGE_TYPES]) contentType!: string;
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
      // The Library's own bucket, not `uploads`. Reads resolve the bucket from
      // the key prefix (StorageService.bucketForKey), so a `library/…` object
      // written anywhere else cannot be read back.
      bucket: 'library',
      objectKey: StorageService.keys.libraryDocument(dto.filename),
      contentType: dto.contentType,
      expiresIn: 3600,
    });
  }

  /**
   * Uploads a Library document through this API instead of browser→R2.
   *
   * The presigned route above is the cheaper transport and stays available,
   * but it needs a CORS policy on the bucket: that PUT is cross-origin, and
   * without `Access-Control-Allow-Origin` the preflight fails before a byte
   * moves — which is exactly the failure the dashboard was reporting. This
   * route needs no CORS, because the dashboard talks only to its own origin.
   *
   * Bytes are streamed to R2 as they arrive rather than buffered, so a 200 MB
   * document costs a held socket rather than 200 MB of heap. Content-Length is
   * required — it is what lets the upload stream instead of falling back to a
   * multipart upload — and is held to the same ceiling as the presign form.
   */
  @Post('uploads/library-document/content')
  @AdminOnly()
  @ApiOperation({
    summary: 'Upload a library document through the API',
    description:
      'Raw request body. Returns the object key to register with POST /library/materials/:id/parts.',
  })
  async libraryDocumentContent(
    @Query() query: UploadLibraryDocumentQueryDto,
    @Req() req: Request,
  ) {
    if (query.filename.includes('..') || query.filename.includes('/')) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, {
        fields: { filename: ['must not contain path separators'] },
      });
    }

    const declared = Number(req.headers['content-length'] ?? 0);

    if (!Number.isFinite(declared) || declared <= 0) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, {
        fields: { body: ['a Content-Length header is required'] },
      });
    }

    if (declared > MAX_LIBRARY_DOCUMENT_BYTES) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, {
        fields: {
          body: [`document exceeds the ${MAX_LIBRARY_DOCUMENT_BYTES} byte limit`],
        },
      });
    }

    const objectKey = StorageService.keys.libraryDocument(query.filename);

    await this.storage.putStream({
      bucket: 'library',
      objectKey,
      body: req,
      contentLength: declared,
      contentType: query.contentType,
    });

    return { objectKey, sizeBytes: declared };
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
