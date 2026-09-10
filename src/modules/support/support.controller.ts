import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  SupportTicketCategory,
  SupportTicketPriority,
  SupportTicketStatus,
} from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminOnly, StudentOnly } from '../../common/decorators/roles.decorator';
import { PaginationDto, SearchablePaginationDto } from '../../common/dto/pagination.dto';
import type { AuthenticatedUser } from '../../common/types/request-context';

import { SupportService } from './support.service';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

class CreateTicketDto {
  @IsString() @MinLength(3) @MaxLength(200) @Transform(trim) subject!: string;
  @IsString() @MinLength(3) @MaxLength(4000) @Transform(trim) body!: string;
  @IsOptional() @IsEnum(SupportTicketCategory) category?: SupportTicketCategory;
  @IsOptional() @IsString() @MaxLength(32) courseId?: string;
}

class MessageDto {
  @IsString() @MinLength(1) @MaxLength(4000) @Transform(trim) body!: string;
}

class StaffReplyDto extends MessageDto {
  /** An internal note is stored on the ticket but never shown to the student. */
  @IsOptional() @IsBoolean() isInternal?: boolean;
}

class ListTicketsDto extends SearchablePaginationDto {
  @IsOptional() @IsEnum(SupportTicketStatus) status?: SupportTicketStatus;
  @IsOptional() @IsEnum(SupportTicketPriority) priority?: SupportTicketPriority;
  @IsOptional() @IsEnum(SupportTicketCategory) category?: SupportTicketCategory;
  @IsOptional() @IsString() @MaxLength(32) assignedToId?: string;
}

class UpdateTicketDto {
  @IsOptional() @IsEnum(SupportTicketStatus) status?: SupportTicketStatus;
  @IsOptional() @IsEnum(SupportTicketPriority) priority?: SupportTicketPriority;
  @IsOptional() @IsEnum(SupportTicketCategory) category?: SupportTicketCategory;
  @IsOptional() @IsString() @MaxLength(32) assignedToId?: string | null;
}

/**
 * Student-facing support.
 *
 * Deliberately narrow: create, read your own, reply. There is no delete and no
 * way to address another account's ticket — every query is scoped by the
 * authenticated user id inside the service.
 */
@ApiTags('support')
@ApiBearerAuth('access-token')
@Controller('support')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Post('tickets')
  @StudentOnly()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Open a support ticket' })
  create(@Body() dto: CreateTicketDto, @CurrentUser() user: AuthenticatedUser) {
    return this.support.createTicket({ userId: user.id, ...dto });
  }

  @Get('tickets')
  @StudentOnly()
  @ApiOperation({ summary: 'Your tickets' })
  list(@Query() query: PaginationDto, @CurrentUser() user: AuthenticatedUser) {
    return this.support.listForStudent({
      userId: user.id,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Get('tickets/:id')
  @StudentOnly()
  @ApiOperation({
    summary: 'One of your tickets, with its conversation',
    description: 'Internal staff notes are never included in this response.',
  })
  detail(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.support.detailForStudent(id, user.id);
  }

  @Post('tickets/:id/messages')
  @StudentOnly()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Reply on your ticket',
    description: 'Replying to a resolved ticket reopens it. A closed ticket does not accept replies.',
  })
  reply(
    @Param('id') id: string,
    @Body() dto: MessageDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.support.addStudentMessage({ ticketId: id, userId: user.id, body: dto.body });
  }
}

/**
 * The Support Centre inbox.
 *
 * Admin-only rather than staff-only: tickets routinely contain payment and
 * account details for students a given teacher has nothing to do with.
 */
@ApiTags('admin')
@ApiBearerAuth('access-token')
@Controller('admin/support')
export class SupportAdminController {
  constructor(private readonly support: SupportService) {}

  @Get('counters')
  @AdminOnly()
  @ApiOperation({ summary: 'Inbox counts by status' })
  counters() {
    return this.support.counters();
  }

  @Get('tickets')
  @AdminOnly()
  @ApiOperation({
    summary: 'Browse tickets',
    description:
      'Search matches the reference, the subject, and the student’s name or phone. Sorted with open tickets first, then by most recent activity.',
  })
  list(@Query() query: ListTicketsDto) {
    return this.support.listForStaff({
      page: query.page,
      pageSize: query.pageSize,
      status: query.status,
      priority: query.priority,
      category: query.category,
      assignedToId: query.assignedToId,
      q: query.q,
    });
  }

  @Get('tickets/:id')
  @AdminOnly()
  @ApiOperation({
    summary: 'Full conversation, including internal notes',
    description: 'Opening a ticket clears its unread marker for staff.',
  })
  detail(@Param('id') id: string) {
    return this.support.detailForStaff(id);
  }

  @Post('tickets/:id/reply')
  @AdminOnly()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Reply to a student, or add an internal note',
    description:
      'A reply notifies the student and moves an OPEN ticket to PENDING. An internal note does neither.',
  })
  reply(
    @Param('id') id: string,
    @Body() dto: StaffReplyDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.support.reply({
      ticketId: id,
      body: dto.body,
      isInternal: dto.isInternal,
      actor,
    });
  }

  @Patch('tickets/:id')
  @AdminOnly()
  @ApiOperation({
    summary: 'Change status, priority, category or assignee',
    description:
      'Status is the only lifecycle control there is — tickets and their messages are never deleted.',
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateTicketDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.support.updateTicket(id, dto, actor);
  }
}
