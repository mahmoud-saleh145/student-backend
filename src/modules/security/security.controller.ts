import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SecurityEventType, SecuritySeverity } from '@prisma/client';
import { IsEnum, IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';

import { AdminOnly } from '../../common/decorators/roles.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';

import { SecurityEventService } from './security-event.service';

class SecurityQueryDto extends PaginationDto {
  @IsOptional() @IsString() @MaxLength(32) userId?: string;
  @IsOptional() @IsEnum(SecurityEventType) type?: SecurityEventType;
  @IsOptional() @IsEnum(SecuritySeverity) severity?: SecuritySeverity;
  @IsOptional() @IsISO8601() from?: string;
}

@ApiTags('audit')
@Controller('security-events')
export class SecurityController {
  constructor(private readonly security: SecurityEventService) {}

  @Get()
  @AdminOnly()
  @ApiOperation({ summary: 'Browse security telemetry' })
  list(@Query() query: SecurityQueryDto) {
    return this.security.list({
      page: query.page,
      pageSize: query.pageSize,
      userId: query.userId,
      type: query.type,
      severity: query.severity,
      from: query.from ? new Date(query.from) : undefined,
    });
  }

  @Get('risk/:userId')
  @AdminOnly()
  @ApiOperation({
    summary: 'Advisory risk score for one account',
    description:
      'Decision support for a human reviewer. The platform never suspends an account on this score alone.',
  })
  risk(@Param('userId') userId: string) {
    return this.security.riskScore(userId);
  }
}
