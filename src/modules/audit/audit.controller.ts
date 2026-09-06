import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuditAction } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';

import { AdminOnly, MasterOnly } from '../../common/decorators/roles.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';

import { AuditService } from './audit.service';

class AuditQueryDto extends PaginationDto {
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

@ApiTags('audit')
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @MasterOnly()
  @ApiOperation({
    summary: 'Browse the audit trail (master only)',
    description:
      'The full trail is master-only because it spans every actor including other admins.',
  })
  list(@Query() query: AuditQueryDto) {
    return this.audit.list({
      page: query.page,
      pageSize: query.pageSize,
      actorId: query.actorId,
      entity: query.entity,
      entityId: query.entityId,
      action: query.action,
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
