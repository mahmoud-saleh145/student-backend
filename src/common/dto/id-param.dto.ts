import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';

/** cuid()-shaped identifier. Rejects path traversal and injection attempts. */
const CUID = /^[a-z0-9]{20,32}$/i;

export class IdParamDto {
  @ApiProperty()
  @IsString()
  @MaxLength(32)
  @Matches(CUID, { message: 'id must be a valid identifier' })
  id!: string;
}

export class CourseIdParamDto {
  @ApiProperty()
  @IsString()
  @MaxLength(32)
  @Matches(CUID, { message: 'courseId must be a valid identifier' })
  courseId!: string;
}

export class VideoIdParamDto {
  @ApiProperty()
  @IsString()
  @MaxLength(32)
  @Matches(CUID, { message: 'videoId must be a valid identifier' })
  videoId!: string;
}
