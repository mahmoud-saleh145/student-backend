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

/**
 * Thumbnails are small and go through this API rather than browser→R2.
 *
 * The presigned route beside these exists too, but a presigned PUT is
 * cross-origin and so needs a CORS policy on the bucket it targets. The
 * uploads bucket has one (the 8 GB video path needs it); the media bucket does
 * not, and adding one to the bucket students read from to save a 200 KB image
 * would be the wrong trade. At this size streaming through the API costs a
 * held socket, not memory.
 */
const MAX_THUMBNAIL_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;

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
class PresignCoursePartThumbnailDto {
  @IsString() @MaxLength(32) courseId!: string;
  @IsString() @MaxLength(32) partId!: string;
  @IsIn(IMAGE_TYPES) contentType!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(10 * 1024 * 1024) sizeBytes!: number;
}
class PresignLibraryPartThumbnailDto {
  @IsString() @MaxLength(32) materialId!: string;
  @IsString() @MaxLength(32) partId!: string;
  @IsIn(IMAGE_TYPES) contentType!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(10 * 1024 * 1024) sizeBytes!: number;
}
class PresignLibraryDefaultThumbnailDto {
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
/** Query shape shared by every streaming thumbnail upload. */
class UploadThumbnailQueryDto {
  @IsIn(IMAGE_TYPES) contentType!: string;
}

class UploadCourseThumbnailQueryDto extends UploadThumbnailQueryDto {
  @IsString() @MaxLength(32) courseId!: string;
}

class UploadCoursePartThumbnailQueryDto extends UploadThumbnailQueryDto {
  @IsString() @MaxLength(32) courseId!: string;
  @IsString() @MaxLength(32) partId!: string;
}

class UploadLibraryPartThumbnailQueryDto extends UploadThumbnailQueryDto {
  @IsString() @MaxLength(32) materialId!: string;
  @IsString() @MaxLength(32) partId!: string;
}

class UploadAttachmentQueryDto {
  @IsString() @MaxLength(32) courseId!: string;
  @IsString() @MaxLength(200)
  @Matches(/^[\w .()\-؀-ۿ]+\.[A-Za-z0-9]{1,8}$/, {
    message: 'filename contains unsupported characters',
  })
  filename!: string;

  @IsIn([...DOC_TYPES, ...IMAGE_TYPES]) contentType!: string;
}

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

  @Post('uploads/course-part-thumbnail')
  @StaffOnly()
  @ApiOperation({
    summary: 'Presign a course-part thumbnail upload',
    description:
      'Returns an object key. Register it with PATCH /admin/courses/:courseId/parts/:partId to make it the part\'s thumbnail.',
  })
  async coursePartThumbnail(@Body() dto: PresignCoursePartThumbnailDto) {
    const ext = extensionFor(dto.contentType);
    return this.storage.presignUpload({
      bucket: 'media',
      objectKey: StorageService.keys.coursePartThumbnail(dto.courseId, dto.partId, ext),
      contentType: dto.contentType,
      expiresIn: 900,
    });
  }

  @Post('uploads/library-part-thumbnail')
  @AdminOnly()
  @ApiOperation({ summary: 'Presign a library-part thumbnail upload' })
  async libraryPartThumbnail(@Body() dto: PresignLibraryPartThumbnailDto) {
    const ext = extensionFor(dto.contentType);
    return this.storage.presignUpload({
      bucket: 'media',
      objectKey: StorageService.keys.libraryPartThumbnail(dto.materialId, dto.partId, ext),
      contentType: dto.contentType,
      expiresIn: 900,
    });
  }

  @Post('uploads/library-default-thumbnail')
  @AdminOnly()
  @ApiOperation({
    summary: 'Presign the library default-thumbnail upload',
    description:
      'The fallback image for library parts that have none of their own. Register it with PUT /settings/library-default-thumbnail. It is never written onto a part row — resolution happens at read time, so an explicitly chosen thumbnail is never overwritten.',
  })
  async libraryDefaultThumbnail(@Body() dto: PresignLibraryDefaultThumbnailDto) {
    const ext = extensionFor(dto.contentType);
    return this.storage.presignUpload({
      bucket: 'media',
      objectKey: StorageService.keys.libraryDefaultThumbnail(ext),
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

  // -------------------------------------------------------------------------
  // Streaming uploads for thumbnails and course material
  //
  // Each of these declares its own size ceiling and requires Content-Length,
  // for the same reason the library document above does: `putStream` streams
  // to storage rather than buffering, and it needs the length up front. A
  // request without one is refused rather than read into memory to measure.
  // -------------------------------------------------------------------------

  @Post('uploads/course-thumbnail/content')
  @StaffOnly()
  @ApiOperation({
    summary: 'Upload a course thumbnail through the API',
    description:
      'Raw request body. Returns the object key to register on the course with ' +
      'POST /admin/courses or PATCH /admin/courses/:courseId. This is the streaming ' +
      'counterpart of the presign route above, and exists for the same reason the other ' +
      'thumbnail routes have one: the media bucket has no CORS policy, so a browser cannot ' +
      'PUT to it directly.',
  })
  async courseThumbnailContent(
    @Query() query: UploadCourseThumbnailQueryDto,
    @Req() req: Request,
  ) {
    const declared = this.requireLength(req, MAX_THUMBNAIL_BYTES);
    const objectKey = StorageService.keys.courseThumbnail(
      query.courseId,
      extensionFor(query.contentType),
    );

    await this.storage.putStream({
      bucket: 'media',
      objectKey,
      body: req,
      contentLength: declared,
      contentType: query.contentType,
    });

    return { objectKey, sizeBytes: declared };
  }

  @Post('uploads/course-part-thumbnail/content')
  @StaffOnly()
  @ApiOperation({
    summary: 'Upload a course-part thumbnail through the API',
    description: 'Raw request body. Returns the object key to set on the part.',
  })
  async coursePartThumbnailContent(
    @Query() query: UploadCoursePartThumbnailQueryDto,
    @Req() req: Request,
  ) {
    const declared = this.requireLength(req, MAX_THUMBNAIL_BYTES);
    const objectKey = StorageService.keys.coursePartThumbnail(
      query.courseId,
      query.partId,
      extensionFor(query.contentType),
    );

    await this.storage.putStream({
      bucket: 'media',
      objectKey,
      body: req,
      contentLength: declared,
      contentType: query.contentType,
    });

    return { objectKey, sizeBytes: declared };
  }

  @Post('uploads/library-part-thumbnail/content')
  @AdminOnly()
  @ApiOperation({ summary: 'Upload a library-part thumbnail through the API' })
  async libraryPartThumbnailContent(
    @Query() query: UploadLibraryPartThumbnailQueryDto,
    @Req() req: Request,
  ) {
    const declared = this.requireLength(req, MAX_THUMBNAIL_BYTES);
    const objectKey = StorageService.keys.libraryPartThumbnail(
      query.materialId,
      query.partId,
      extensionFor(query.contentType),
    );

    await this.storage.putStream({
      bucket: 'media',
      objectKey,
      body: req,
      contentLength: declared,
      contentType: query.contentType,
    });

    return { objectKey, sizeBytes: declared };
  }

  @Post('uploads/library-default-thumbnail/content')
  @AdminOnly()
  @ApiOperation({
    summary: 'Upload the library default thumbnail through the API',
    description:
      'Returns the object key to store in the library.defaultThumbnailKey setting. It is never written onto a part row.',
  })
  async libraryDefaultThumbnailContent(
    @Query() query: UploadThumbnailQueryDto,
    @Req() req: Request,
  ) {
    const declared = this.requireLength(req, MAX_THUMBNAIL_BYTES);
    const objectKey = StorageService.keys.libraryDefaultThumbnail(
      extensionFor(query.contentType),
    );

    await this.storage.putStream({
      bucket: 'media',
      objectKey,
      body: req,
      contentLength: declared,
      contentType: query.contentType,
    });

    return { objectKey, sizeBytes: declared };
  }

  @Post('uploads/attachment/content')
  @StaffOnly()
  @ApiOperation({
    summary: 'Upload course material through the API',
    description:
      'Raw request body. Returns the object key to register with POST /attachments, scoped there to a lecture, a section, or the whole course.',
  })
  async attachmentContent(
    @Query() query: UploadAttachmentQueryDto,
    @Req() req: Request,
  ) {
    if (query.filename.includes('..') || query.filename.includes('/')) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, {
        fields: { filename: ['must not contain path separators'] },
      });
    }

    const declared = this.requireLength(req, MAX_ATTACHMENT_BYTES);
    const objectKey = StorageService.keys.attachment(query.courseId, query.filename);

    await this.storage.putStream({
      bucket: 'uploads',
      objectKey,
      body: req,
      contentLength: declared,
      contentType: query.contentType,
    });

    return { objectKey, sizeBytes: declared };
  }

  /**
   * The Content-Length gate, shared by every streaming upload above.
   *
   * Refusing a request with no declared length is deliberate: the alternative
   * is reading an unbounded body to find out how big it is, which is the
   * memory profile these endpoints exist to avoid.
   */
  private requireLength(req: Request, max: number): number {
    const declared = Number(req.headers['content-length'] ?? 0);

    if (!Number.isFinite(declared) || declared <= 0) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, {
        fields: { body: ['a Content-Length header is required'] },
      });
    }

    if (declared > max) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, {
        fields: { body: [`upload exceeds the ${max} byte limit`] },
      });
    }

    return declared;
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
