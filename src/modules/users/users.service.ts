import { Injectable, Logger } from '@nestjs/common';
import {
  AccountStatus,
  AuditAction,
  type Gender,
  Prisma,
  SessionStatus,
  UserRole,
} from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { paginated, type Paginated } from '../../common/types/api-response';
import { PrismaService, notDeleted } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PlatformSettingsService } from '../settings/platform-settings.service';
import { PasswordService } from '../auth/password.service';

/** Selection that produces exactly the mobile app's `User` shape. */
const PUBLIC_USER_SELECT = {
  id: true,
  fullName: true,
  phone: true,
  role: true,
  status: true,
  gender: true,
  avatarUrl: true,
  createdAt: true,
  // Added for the admin dashboard. Purely additive: the mobile client reads
  // named fields and ignores anything it does not know about.
  email: true,
  locale: true,
  lastLoginAt: true,
  updatedAt: true,
  studentProfile: {
    select: {
      university: { select: { id: true, name: true, nameAr: true, logoUrl: true } },
      faculty: { select: { id: true, universityId: true, name: true, nameAr: true } },
      department: { select: { id: true, facultyId: true, name: true, nameAr: true } },
      academicYear: { select: { id: true, order: true, name: true, nameAr: true } },
    },
  },
  teacherProfile: {
    select: { title: true, titleAr: true, bio: true, bioAr: true, isPublic: true },
  },
} satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    private readonly settings: PlatformSettingsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Phone normalisation — the account identifier
  // ---------------------------------------------------------------------------

  /**
   * Canonicalises Egyptian mobile numbers to `01XXXXXXXXX`.
   *
   * The mobile app already normalises before sending, but the backend must not
   * depend on that: `+201001234567` and `01001234567` are the same account,
   * and letting both exist would create duplicate registrations that are
   * painful to merge later.
   */
  static normalizePhone(raw: string): string {
    const digits = raw.replace(/[\s()+-]/g, '');
    const stripped = digits.replace(/^(?:0020|20)(?=1[0125]\d{8}$)/, '');
    return stripped.startsWith('0') ? stripped : `0${stripped}`;
  }

  static isValidEgyptianMobile(phone: string): boolean {
    return /^01[0125]\d{8}$/.test(phone);
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async findAuthUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, status: true, phone: true, fullName: true },
    });
    if (!user) throw AppException.notFound('User', userId);
    return user;
  }

  /** The exact `User` object the mobile app expects. */
  async toPublicUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: PUBLIC_USER_SELECT,
    });
    if (!user) throw AppException.notFound('User', userId);
    return UsersService.serializeUser(user);
  }

  static serializeUser(user: {
    id: string;
    fullName: string;
    phone: string;
    role: UserRole;
    status: AccountStatus;
    gender: Gender | null;
    avatarUrl: string | null;
    createdAt: Date;
    email?: string | null;
    locale?: string | null;
    lastLoginAt?: Date | null;
    updatedAt?: Date | null;
    studentProfile?: {
      university: { id: string; name: string; nameAr: string; logoUrl: string | null } | null;
      faculty: { id: string; universityId: string; name: string; nameAr: string } | null;
      department: { id: string; facultyId: string; name: string; nameAr: string } | null;
      academicYear: { id: string; order: number; name: string; nameAr: string } | null;
    } | null;
    teacherProfile?: {
      title: string | null;
      titleAr: string | null;
      bio: string | null;
      bioAr: string | null;
      isPublic: boolean;
    } | null;
  }) {
    return {
      id: user.id,
      fullName: user.fullName,
      phone: user.phone,
      role: user.role,
      status: user.status,
      // The app's type has gender non-optional; default rather than send null.
      gender: user.gender ?? 'MALE',
      avatarUrl: user.avatarUrl,
      university: user.studentProfile?.university ?? null,
      faculty: user.studentProfile?.faculty ?? null,
      department: user.studentProfile?.department ?? null,
      academicYear: user.studentProfile?.academicYear ?? null,
      createdAt: user.createdAt.toISOString(),
      email: user.email ?? null,
      locale: user.locale ?? 'en',
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      updatedAt: user.updatedAt?.toISOString() ?? null,
      ...(user.teacherProfile
        ? {
            teacher: {
              title: user.teacherProfile.title,
              titleAr: user.teacherProfile.titleAr,
              bio: user.teacherProfile.bio,
              bioAr: user.teacherProfile.bioAr,
              isPublic: user.teacherProfile.isPublic,
            },
          }
        : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Academic selection integrity
  // ---------------------------------------------------------------------------

  /**
   * A client can post any ids it likes. This verifies the chain actually hangs
   * together — faculty belongs to the university, department to the faculty —
   * so a student cannot end up filed under a department of another university.
   */
  async assertAcademicSelectionIsCoherent(input: {
    universityId: string;
    facultyId: string;
    departmentId: string;
    academicYearId: string;
  }): Promise<void> {
    const [university, faculty, department, year] = await Promise.all([
      this.prisma.university.findFirst({
        where: { id: input.universityId, isActive: true, ...notDeleted },
        select: { id: true },
      }),
      this.prisma.faculty.findFirst({
        where: { id: input.facultyId, isActive: true, ...notDeleted },
        select: { id: true, universityId: true },
      }),
      this.prisma.department.findFirst({
        where: { id: input.departmentId, isActive: true, ...notDeleted },
        select: { id: true, facultyId: true },
      }),
      this.prisma.academicYear.findFirst({
        where: { id: input.academicYearId, isActive: true },
        select: { id: true },
      }),
    ]);

    const fields: Record<string, string[]> = {};
    if (!university) fields.universityId = ['unknown or inactive university'];
    if (!faculty) fields.facultyId = ['unknown or inactive faculty'];
    if (!department) fields.departmentId = ['unknown or inactive department'];
    if (!year) fields.academicYearId = ['unknown or inactive academic year'];

    if (faculty && university && faculty.universityId !== university.id) {
      fields.facultyId = ['does not belong to the selected university'];
    }
    if (department && faculty && department.facultyId !== faculty.id) {
      fields.departmentId = ['does not belong to the selected faculty'];
    }

    if (Object.keys(fields).length > 0) {
      throw AppException.validation(fields, 'Academic selection is not coherent');
    }
  }

  // ---------------------------------------------------------------------------
  // Profile (self-service)
  // ---------------------------------------------------------------------------

  /**
   * Students may change their display name only. Phone identifies the account
   * and the academic fields determine course eligibility, so both are
   * administrative — the app shows them read-only with a route to support.
   */
  async updateOwnProfile(
    userId: string,
    dto: { fullName?: string; locale?: string; academicYearId?: string },
  ) {
    const data: Prisma.UserUpdateInput = {};

    if (dto.fullName !== undefined) {
      const cleaned = dto.fullName.trim().replace(/\s+/g, ' ');
      if (cleaned.split(' ').filter(Boolean).length < 3) {
        throw AppException.validation({
          fullName: ['must contain at least three parts'],
        });
      }
      data.fullName = cleaned;
    }

    if (dto.locale !== undefined) {
      data.locale = ['en', 'ar'].includes(dto.locale) ? dto.locale : 'en';
    }

    // Changing your own academic year is governed by a platform setting. The
    // check is here, in the service, rather than in the controller: this is
    // the only path a student can reach, and putting it here means no future
    // caller can bypass it by constructing a different DTO.
    if (dto.academicYearId !== undefined) {
      if (!(await this.settings.allowsAcademicYearChange())) {
        throw new AppException(ErrorCode.FORBIDDEN, {
          message: 'Changing your academic year is disabled on this platform',
        });
      }

      const year = await this.prisma.academicYear.findFirst({
        where: { id: dto.academicYearId, isActive: true },
        select: { id: true },
      });
      if (!year) {
        throw AppException.validation({ academicYearId: ['unknown academic year'] });
      }

      await this.prisma.studentProfile.update({
        where: { userId },
        data: { academicYearId: year.id },
      });
    }

    if (Object.keys(data).length === 0) return this.toPublicUser(userId);

    await this.prisma.user.update({ where: { id: userId }, data });
    return this.toPublicUser(userId);
  }

  async setAvatar(userId: string, avatarUrl: string | null) {
    await this.prisma.user.update({ where: { id: userId }, data: { avatarUrl } });
    return this.toPublicUser(userId);
  }

  // ---------------------------------------------------------------------------
  // Administrative user management
  // ---------------------------------------------------------------------------

  async list(params: {
    page: number;
    pageSize: number;
    role?: UserRole;
    status?: AccountStatus;
    q?: string;
    universityId?: string;
    academicYearId?: string;
  }): Promise<Paginated<unknown>> {
    const where: Prisma.UserWhereInput = {
      ...notDeleted,
      ...(params.role ? { role: params.role } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(params.q
        ? {
            OR: [
              { fullName: { contains: params.q, mode: 'insensitive' } },
              { phone: { contains: UsersService.normalizePhone(params.q) } },
            ],
          }
        : {}),
      ...(params.universityId || params.academicYearId
        ? {
            studentProfile: {
              ...(params.universityId ? { universityId: params.universityId } : {}),
              ...(params.academicYearId ? { academicYearId: params.academicYearId } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: PUBLIC_USER_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);

    return paginated(
      rows.map((r) => UsersService.serializeUser(r)),
      total,
      params.page,
      params.pageSize,
    );
  }

  async findById(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, ...notDeleted },
      select: PUBLIC_USER_SELECT,
    });
    if (!user) throw AppException.notFound('User', userId);
    return UsersService.serializeUser(user);
  }

  /**
   * Creates a staff account. Only reachable from admin/master endpoints —
   * the public registration path hardcodes STUDENT.
   */
  async createStaff(
    input: {
      phone: string;
      password: string;
      fullName: string;
      role: UserRole;
      gender?: Gender;
      email?: string;
      teacher?: { title?: string; titleAr?: string; bio?: string; revenueSharePercent?: number };
    },
    actor: { id: string; role: UserRole },
  ) {
    if (input.role === UserRole.MASTER) {
      // The single master is created by an out-of-band script, never through
      // the API. See scripts/create-master.ts.
      throw new AppException(ErrorCode.CANNOT_MODIFY_MASTER, {
        message: 'The master account cannot be created through the API',
      });
    }

    // Only the master may mint admins; admins may only mint teachers.
    if (input.role === UserRole.ADMIN && actor.role !== UserRole.MASTER) {
      throw new AppException(ErrorCode.INSUFFICIENT_ROLE, {
        message: 'Only the master account can create administrators',
      });
    }

    const phone = UsersService.normalizePhone(input.phone);
    if (!UsersService.isValidEgyptianMobile(phone)) {
      throw AppException.validation({ phone: ['invalid mobile number'] });
    }

    const existing = await this.prisma.user.findUnique({ where: { phone } });
    if (existing) throw new AppException(ErrorCode.PHONE_ALREADY_REGISTERED);

    const passwordHash = await this.passwords.hash(input.password);

    const created = await this.prisma.user.create({
      data: {
        phone,
        passwordHash,
        fullName: input.fullName.trim().replace(/\s+/g, ' '),
        role: input.role,
        gender: input.gender,
        email: input.email,
        status: AccountStatus.ACTIVE,
        createdById: actor.id,
        notificationPrefs: { create: {} },
        ...(input.role === UserRole.TEACHER
          ? {
              teacherProfile: {
                create: {
                  title: input.teacher?.title,
                  titleAr: input.teacher?.titleAr,
                  bio: input.teacher?.bio,
                  revenueSharePercent: input.teacher?.revenueSharePercent ?? 0,
                },
              },
            }
          : {}),
      },
      select: PUBLIC_USER_SELECT,
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.CREATE,
      entity: 'user',
      entityId: created.id,
      after: { role: created.role, phone: created.phone },
    });

    return UsersService.serializeUser(created);
  }

  async updateByAdmin(
    userId: string,
    dto: {
      fullName?: string;
      status?: AccountStatus;
      gender?: Gender;
      email?: string;
      universityId?: string;
      facultyId?: string;
      departmentId?: string;
      academicYearId?: string;
      teacher?: { title?: string; bio?: string; revenueSharePercent?: number; isPublic?: boolean };
    },
    actor: { id: string; role: UserRole },
  ) {
    const target = await this.prisma.user.findFirst({
      where: { id: userId, ...notDeleted },
      select: { id: true, role: true, status: true, fullName: true },
    });
    if (!target) throw AppException.notFound('User', userId);

    this.assertCanManage(actor, target.role);

    const updated = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: userId },
        data: {
          fullName: dto.fullName?.trim().replace(/\s+/g, ' '),
          status: dto.status,
          gender: dto.gender,
          email: dto.email,
        },
        select: PUBLIC_USER_SELECT,
      });

      if (
        target.role === UserRole.STUDENT &&
        (dto.universityId || dto.facultyId || dto.departmentId || dto.academicYearId)
      ) {
        await tx.studentProfile.update({
          where: { userId },
          data: {
            universityId: dto.universityId,
            facultyId: dto.facultyId,
            departmentId: dto.departmentId,
            academicYearId: dto.academicYearId,
          },
        });
      }

      if (target.role === UserRole.TEACHER && dto.teacher) {
        await tx.teacherProfile.update({
          where: { userId },
          data: {
            title: dto.teacher.title,
            bio: dto.teacher.bio,
            revenueSharePercent: dto.teacher.revenueSharePercent,
            isPublic: dto.teacher.isPublic,
          },
        });
      }

      // A suspension must take effect now, not when the access token expires.
      if (
        dto.status &&
        (dto.status === AccountStatus.SUSPENDED || dto.status === AccountStatus.DISABLED)
      ) {
        const now = new Date();
        await tx.session.updateMany({
          where: { userId, status: SessionStatus.ACTIVE },
          data: {
            status: SessionStatus.REVOKED,
            revokedAt: now,
            revokedReason: `Account ${dto.status.toLowerCase()}`,
          },
        });
        await tx.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: now, revokedReason: `Account ${dto.status.toLowerCase()}` },
        });
        await tx.playbackTicket.updateMany({
          where: { userId, status: 'ACTIVE' },
          data: { status: 'REVOKED', revokedAt: now, revokedReason: 'Account suspended' },
        });
      }

      return user;
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.UPDATE,
      entity: 'user',
      entityId: userId,
      before: { status: target.status, fullName: target.fullName },
      after: dto,
    });

    return UsersService.serializeUser(updated);
  }

  /**
   * Administrative password reset — the product's only recovery path (spec
   * §13). There is no OTP or emailed link; an authorized staff member verifies
   * identity out of band and sets a new password here.
   */
  async resetPasswordByAdmin(
    userId: string,
    newPassword: string,
    actor: { id: string; role: UserRole },
    note?: string,
  ): Promise<{ ok: true }> {
    const target = await this.prisma.user.findFirst({
      where: { id: userId, ...notDeleted },
      select: { id: true, role: true },
    });
    if (!target) throw AppException.notFound('User', userId);

    this.assertCanManage(actor, target.role);

    const passwordHash = await this.passwords.hash(newPassword);
    const now = new Date();

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          passwordHash,
          credentialsChangedAt: now,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'Administrative password reset' },
      }),
      this.prisma.session.updateMany({
        where: { userId, status: SessionStatus.ACTIVE },
        data: {
          status: SessionStatus.REVOKED,
          revokedAt: now,
          revokedReason: 'Administrative password reset',
        },
      }),
    ]);

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.PASSWORD_RESET,
      entity: 'user',
      entityId: userId,
      note: note ?? 'Administrative reset',
    });

    return { ok: true };
  }

  /**
   * Soft delete. Financial and audit history references this row with
   * onDelete: Restrict, so a hard delete is impossible by design.
   */
  async softDelete(userId: string, actor: { id: string; role: UserRole }, reason: string) {
    const target = await this.prisma.user.findFirst({
      where: { id: userId, ...notDeleted },
      select: { id: true, role: true, phone: true },
    });
    if (!target) throw AppException.notFound('User', userId);

    if (target.role === UserRole.MASTER) {
      throw new AppException(ErrorCode.CANNOT_MODIFY_MASTER);
    }
    this.assertCanManage(actor, target.role);

    const now = new Date();

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          deletedAt: now,
          status: AccountStatus.DISABLED,
          // Free the phone number for re-registration without losing history.
          phone: `deleted:${target.phone}:${now.getTime()}`,
        },
      }),
      this.prisma.session.updateMany({
        where: { userId, status: SessionStatus.ACTIVE },
        data: { status: SessionStatus.REVOKED, revokedAt: now, revokedReason: reason },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now, revokedReason: reason },
      }),
    ]);

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.DELETE,
      entity: 'user',
      entityId: userId,
      note: reason,
    });

    return { ok: true };
  }

  /**
   * Role hierarchy for management operations:
   *   MASTER manages everyone; ADMIN manages teachers and students;
   *   nobody manages the master through the API.
   */
  private assertCanManage(actor: { role: UserRole }, targetRole: UserRole): void {
    if (targetRole === UserRole.MASTER) {
      throw new AppException(ErrorCode.CANNOT_MODIFY_MASTER);
    }
    if (actor.role === UserRole.MASTER) return;
    if (actor.role === UserRole.ADMIN && targetRole !== UserRole.ADMIN) return;

    throw new AppException(ErrorCode.INSUFFICIENT_ROLE, {
      message: `A ${actor.role} may not manage a ${targetRole} account`,
    });
  }

  /** Teacher directory for course assignment UIs. */
  async listTeachers(params: { page: number; pageSize: number; q?: string }) {
    const where: Prisma.UserWhereInput = {
      role: UserRole.TEACHER,
      ...notDeleted,
      status: AccountStatus.ACTIVE,
      ...(params.q ? { fullName: { contains: params.q, mode: 'insensitive' } } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          fullName: true,
          avatarUrl: true,
          teacherProfile: { select: { title: true, titleAr: true, bio: true, bioAr: true } },
        },
        orderBy: { fullName: 'asc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);

    return paginated(
      rows.map((t) => ({
        id: t.id,
        fullName: t.fullName,
        avatarUrl: t.avatarUrl,
        title: t.teacherProfile?.title ?? null,
        bio: t.teacherProfile?.bio ?? null,
      })),
      total,
      params.page,
      params.pageSize,
    );
  }

  /**
   * The Teachers screen.
   *
   * Course and student counts come from the join table and the course
   * counters respectively, so this stays one query per page rather than an
   * N+1 over each teacher's courses.
   */
  async listTeachersForAdmin(params: {
    page: number;
    pageSize: number;
    q?: string;
    status?: AccountStatus;
  }) {
    const where: Prisma.UserWhereInput = {
      role: UserRole.TEACHER,
      ...notDeleted,
      ...(params.status ? { status: params.status } : {}),
      ...(params.q
        ? {
            OR: [
              { fullName: { contains: params.q, mode: 'insensitive' } },
              { phone: { contains: UsersService.normalizePhone(params.q) } },
              { email: { contains: params.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          fullName: true,
          phone: true,
          email: true,
          gender: true,
          status: true,
          avatarUrl: true,
          createdAt: true,
          lastLoginAt: true,
          teacherProfile: {
            select: { title: true, titleAr: true, bio: true, isPublic: true },
          },
          courseTeachers: {
            select: {
              course: {
                select: { id: true, status: true, studentCount: true, deletedAt: true },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);

    return paginated(
      rows.map((t) => {
        const courses = t.courseTeachers
          .map((ct) => ct.course)
          .filter((course) => course.deletedAt === null);

        return {
          id: t.id,
          fullName: t.fullName,
          phone: t.phone,
          email: t.email,
          gender: t.gender ?? 'MALE',
          status: t.status,
          avatarUrl: t.avatarUrl,
          title: t.teacherProfile?.title ?? null,
          bio: t.teacherProfile?.bio ?? null,
          isPublic: t.teacherProfile?.isPublic ?? true,
          courseCount: courses.length,
          publishedCourseCount: courses.filter((c) => c.status === 'PUBLISHED').length,
          // Sum of per-course active enrollments. A student enrolled in two of
          // this teacher's courses counts twice, which is the number a teacher
          // actually means by "how many students do I have".
          studentCount: courses.reduce((sum, c) => sum + c.studentCount, 0),
          lastLoginAt: t.lastLoginAt?.toISOString() ?? null,
          createdAt: t.createdAt.toISOString(),
        };
      }),
      total,
      params.page,
      params.pageSize,
    );
  }
}

export { PUBLIC_USER_SELECT };
