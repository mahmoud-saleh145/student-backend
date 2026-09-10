import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuditAction } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';

import { AdminOnly } from '../../common/decorators/roles.decorator';
import { SearchablePaginationDto } from '../../common/dto/pagination.dto';

import { AuditService } from './audit.service';

class AuditQueryDto extends SearchablePaginationDto {
  @IsOptional() @IsString() @MaxLength(32) actorId?: string;
  @IsOptional() @IsString() @MaxLength(64) entity?: string;
  @IsOptional() @IsString() @MaxLength(32) entityId?: string;
  @IsOptional() @IsEnum(AuditAction) action?: AuditAction;

  @IsOptional()
  @IsISO8601()
  @Transform(({ value }) => value)
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}

class LoginLogDto extends SearchablePaginationDto {
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}

@ApiTags('audit')
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @AdminOnly()
  @ApiOperation({
    summary: 'Browse the administrative action log',
    description:
      'Admins as well as the master, because reviewing who changed what is day-to-day operational work and the dashboard makes it a first-class screen. The log itself remains append-only — there is no write, update or delete path here for anyone.',
  })
  list(@Query() query: AuditQueryDto) {
    return this.audit.list({
      page: query.page,
      pageSize: query.pageSize,
      actorId: query.actorId,
      entity: query.entity,
      entityId: query.entityId,
      action: query.action,
      q: query.q,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
  }

  @Get('logins')
  @AdminOnly()
  @ApiOperation({
    summary: 'Successful student sign-ins',
    description:
      'Read from the security-event stream the auth path already writes, so there is no second log to keep in sync.',
  })
  logins(@Query() query: LoginLogDto) {
    return this.audit.loginLog({
      page: query.page,
      pageSize: query.pageSize,
      q: query.q,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
  }

  @Get(':entity/:entityId')
  @AdminOnly()
  @ApiOperation({
    summary: 'History for one entity',
    description:
      'Scoped to a single record, so admins can answer "who changed this course" without seeing the platform-wide trail.',
  })
  forEntity(@Param('entity') entity: string, @Param('entityId') entityId: string) {
    return this.audit.forEntity(entity, entityId);
  }
}
