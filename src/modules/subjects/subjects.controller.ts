import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuditAction, type Prisma, UserRole } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { AdminOnly } from '../../common/decorators/roles.decorator';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuthenticatedUser } from '../../common/types/request-context';
import { AuditService } from '../audit/audit.service';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

class CreateSubjectDto {
  @IsString() @MinLength(2) @MaxLength(120) @Transform(trim) name!: string;
  @IsString() @MinLength(2) @MaxLength(120) @Transform(trim) nameAr!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) sortOrder?: number;
}

class UpdateSubjectDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) @Transform(trim) name?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) @Transform(trim) nameAr?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) sortOrder?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class ListSubjectsDto {
  @IsOptional() @IsString() @MaxLength(120) @Transform(trim) q?: string;
  @IsOptional() @IsBoolean() includeInactive?: boolean;
}

/**
 * Subjects (categories).
 *
 * An organisational grouping over courses and nothing more: a subject grants
 * no access and gates no content, which is why deactivating one is safe and
 * why courses keep working with `subjectId` null. Deactivation is a flag, not
 * a delete, so a course that referenced a retired subject still resolves.
 */
@ApiTags('admin')
@Controller('subjects')
export class SubjectsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Public()
  @ApiOperation({
    summary: 'List subjects with their course counts',
    description: 'Public because the mobile catalogue can group by subject.',
  })
  async list(@Query() query: ListSubjectsDto) {
    const where: Prisma.SubjectWhereInput = {
      deletedAt: null,
      ...(query.includeInactive ? {} : { isActive: true }),
      ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}),
    };

    const rows = await this.prisma.subject.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        _count: {
          // Archived and deleted courses are excluded so the number an admin
          // sees matches the number of courses they can actually act on.
          select: { courses: { where: { deletedAt: null, status: { not: 'ARCHIVED' } } } },
        },
      },
    });

    return rows.map((s) => ({
      id: s.id,
      name: s.name,
      nameAr: s.nameAr,
      isActive: s.isActive,
      sortOrder: s.sortOrder,
      courseCount: s._count.courses,
      createdAt: s.createdAt.toISOString(),
    }));
  }

  @Get(':id')
  @AdminOnly()
  @ApiOperation({ summary: 'One subject, with its courses' })
  async detail(@Param('id') id: string) {
    const subject = await this.prisma.subject.findFirst({
      where: { id, deletedAt: null },
      include: {
        courses: {
          where: { deletedAt: null },
          select: { id: true, title: true, status: true, studentCount: true },
          orderBy: { createdAt: 'desc' },
          take: 200,
        },
      },
    });
    if (!subject) throw AppException.notFound('Subject', id);

    return {
      id: subject.id,
      name: subject.name,
      nameAr: subject.nameAr,
      isActive: subject.isActive,
      sortOrder: subject.sortOrder,
      courseCount: subject.courses.length,
      courses: subject.courses,
      createdAt: subject.createdAt.toISOString(),
    };
  }

  @Post()
  @AdminOnly()
  @ApiOperation({ summary: 'Create a subject' })
  async create(@Body() dto: CreateSubjectDto, @CurrentUser() actor: AuthenticatedUser) {
    const existing = await this.prisma.subject.findUnique({ where: { name: dto.name } });
    if (existing) {
      throw AppException.validation({ name: ['a subject with this name already exists'] });
    }

    const subject = await this.prisma.subject.create({
      data: { name: dto.name, nameAr: dto.nameAr, sortOrder: dto.sortOrder ?? 0 },
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role as UserRole,
      action: AuditAction.CREATE,
      entity: 'subject',
      entityId: subject.id,
      after: { name: subject.name, nameAr: subject.nameAr },
    });

    return subject;
  }

  @Patch(':id')
  @AdminOnly()
  @ApiOperation({ summary: 'Update a subject' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateSubjectDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const before = await this.prisma.subject.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw AppException.notFound('Subject', id);

    if (dto.name && dto.name !== before.name) {
      const clash = await this.prisma.subject.findUnique({ where: { name: dto.name } });
      if (clash) {
        throw AppException.validation({ name: ['a subject with this name already exists'] });
      }
    }

    const subject = await this.prisma.subject.update({ where: { id }, data: dto });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role as UserRole,
      action: AuditAction.UPDATE,
      entity: 'subject',
      entityId: id,
      before: { name: before.name, nameAr: before.nameAr, isActive: before.isActive },
      after: { name: subject.name, nameAr: subject.nameAr, isActive: subject.isActive },
    });

    return subject;
  }

  @Delete(':id')
  @AdminOnly()
  @ApiOperation({
    summary: 'Deactivate a subject',
    description:
      'Never a hard delete. Courses keep their subjectId, so reactivating restores the grouping intact.',
  })
  async deactivate(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    const subject = await this.prisma.subject.findFirst({ where: { id, deletedAt: null } });
    if (!subject) throw AppException.notFound('Subject', id);

    const updated = await this.prisma.subject.update({
      where: { id },
      data: { isActive: false },
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role as UserRole,
      action: AuditAction.ARCHIVE,
      entity: 'subject',
      entityId: id,
      before: { isActive: true },
      after: { isActive: false },
    });

    return { id: updated.id, isActive: updated.isActive };
  }
}
