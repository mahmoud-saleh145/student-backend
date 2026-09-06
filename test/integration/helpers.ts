import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  AccessDurationType,
  AccountStatus,
  ContentStatus,
  CourseStatus,
  DeviceStatus,
  EnrollmentMethod,
  EnrollmentState,
  LessonKind,
  PrismaClient,
  UserRole,
  VideoStatus,
} from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../src/common/interceptors/response.interceptor';

export const TEST_PASSWORD = 'TestPassword123!';

let cached: { app: INestApplication; prisma: PrismaClient } | null = null;

/**
 * Boots the full application once per worker.
 *
 * The whole graph is used deliberately: the point of an integration test here
 * is to exercise the guards, the interceptors and the validation pipe in the
 * same arrangement production uses. Testing a service in isolation would miss
 * exactly the class of bug these tests exist to catch — a route that forgot
 * its `@Roles` decorator, for instance.
 */
export async function bootstrapTestApp() {
  if (cached) return cached;

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: 1 as never, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalInterceptors(new ResponseInterceptor(app.get(Reflector)));
  app.useGlobalFilters(new AllExceptionsFilter(false));

  await app.init();

  const prisma = app.get(PrismaClient, { strict: false }) as PrismaClient;

  cached = { app, prisma };
  return cached;
}

export async function shutdownTestApp() {
  if (!cached) return;
  await cached.app.close();
  cached = null;
}

/**
 * Empties every table in dependency-safe order.
 *
 * `TRUNCATE … CASCADE` on one statement is both faster than per-table deletes
 * and immune to the ordering problem, which matters because the schema is
 * deliberately full of RESTRICT foreign keys.
 */
export async function resetDatabase(prisma: PrismaClient) {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'
  `;

  if (tables.length === 0) return;

  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

let phoneCounter = 0;

function nextPhone(): string {
  phoneCounter += 1;
  return `0100${String(phoneCounter).padStart(7, '0')}`;
}

export async function createUser(
  prisma: PrismaClient,
  overrides: {
    role?: UserRole;
    fullName?: string;
    phone?: string;
    status?: AccountStatus;
  } = {},
) {
  const passwordHash = await argon2.hash(TEST_PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 8192,
    timeCost: 1,
    parallelism: 1,
  });

  return prisma.user.create({
    data: {
      phone: overrides.phone ?? nextPhone(),
      fullName: overrides.fullName ?? 'Test Student Full Name',
      role: overrides.role ?? UserRole.STUDENT,
      status: overrides.status ?? AccountStatus.ACTIVE,
      passwordHash,
      locale: 'en',
    },
  });
}

export async function createDevice(
  prisma: PrismaClient,
  userId: string,
  deviceKey = 'test-device-key',
  status: DeviceStatus = DeviceStatus.ACTIVE,
) {
  return prisma.device.create({
    data: {
      userId,
      deviceKey,
      name: 'Test Handset',
      platform: 'ios',
      model: 'iPhone15,2',
      status,
      approvedAt: status === DeviceStatus.ACTIVE ? new Date() : null,
    },
  });
}

/**
 * A course with a deliberately irregular section structure.
 *
 * The default is three unevenly-sized sections whose names are not "week 1/2/3"
 * — if any query or serializer assumes a regular shape, this fixture surfaces
 * it (spec §17).
 */
export async function createCourse(
  prisma: PrismaClient,
  options: {
    teacherId: string;
    status?: CourseStatus;
    price?: number | null;
    isFree?: boolean;
    accessDurationType?: AccessDurationType;
    accessDurationDays?: number | null;
    sections?: { title: string; lessons: number }[];
    enrollmentMethods?: EnrollmentMethod[];
  },
) {
  const sections = options.sections ?? [
    { title: 'Before Midterm', lessons: 3 },
    { title: 'Midterm Revision', lessons: 1 },
    { title: 'After Midterm', lessons: 2 },
  ];

  const course = await prisma.course.create({
    data: {
      slug: `course-${Math.abs(phoneCounter++)}-${Date.now().toString(36)}`,
      title: 'Integration Test Course',
      shortDescription: 'Fixture',
      status: options.status ?? CourseStatus.PUBLISHED,
      isFree: options.isFree ?? false,
      enrollmentMethods: options.enrollmentMethods ?? [
        EnrollmentMethod.PAYMENT,
        EnrollmentMethod.CODE,
      ],
      accessDurationType: options.accessDurationType ?? AccessDurationType.LIFETIME,
      accessDurationDays: options.accessDurationDays ?? null,
      publishedAt: new Date(),
      teachers: {
        create: {
          teacherId: options.teacherId,
          isLead: true,
          canEditContent: true,
          canEditPricing: true,
          canPublish: true,
        },
      },
      ...(options.price !== null && options.price !== undefined
        ? {
            prices: {
              create: {
                amount: options.price,
                currency: 'EGP',
                version: 1,
                isCurrent: true,
              },
            },
          }
        : {}),
    },
  });

  let lessonCount = 0;

  for (const [index, spec] of sections.entries()) {
    const section = await prisma.courseSection.create({
      data: {
        courseId: course.id,
        title: spec.title,
        sortOrder: index + 1,
        status: ContentStatus.PUBLISHED,
      },
    });

    for (let i = 0; i < spec.lessons; i += 1) {
      const lesson = await prisma.lesson.create({
        data: {
          courseId: course.id,
          sectionId: section.id,
          title: `${spec.title} — lesson ${i + 1}`,
          kind: LessonKind.VIDEO,
          sortOrder: i + 1,
          status: ContentStatus.PUBLISHED,
          durationSeconds: 600,
        },
      });

      await prisma.video.create({
        data: {
          lessonId: lesson.id,
          courseId: course.id,
          status: VideoStatus.READY,
          hlsPrefix: `hls/${lesson.id}/`,
          masterPlaylistKey: `hls/${lesson.id}/master.m3u8`,
          durationSeconds: 600,
          isEncrypted: true,
          encryptionKeyId: 'k1',
        },
      });

      lessonCount += 1;
    }
  }

  return prisma.course.update({
    where: { id: course.id },
    data: { lessonCount, sectionCount: sections.length },
    include: { sections: { include: { lessons: { include: { video: true } } } } },
  });
}

export async function enroll(
  prisma: PrismaClient,
  userId: string,
  courseId: string,
  overrides: Partial<{
    state: EnrollmentState;
    accessEndsAt: Date | null;
    method: EnrollmentMethod;
  }> = {},
) {
  return prisma.enrollment.create({
    data: {
      userId,
      courseId,
      state: overrides.state ?? EnrollmentState.ACTIVE,
      method: overrides.method ?? EnrollmentMethod.PAYMENT,
      accessStartsAt: new Date(Date.now() - 1000),
      accessEndsAt: overrides.accessEndsAt ?? null,
    },
  });
}

// -----------------------------------------------------------------------------
// HTTP
// -----------------------------------------------------------------------------

export const API = '/api/v1';

export function http(app: INestApplication) {
  return request(app.getHttpServer());
}

/** Signs in and returns the tokens plus a pre-built auth header set. */
export async function login(
  app: INestApplication,
  phone: string,
  deviceKey = 'test-device-key',
) {
  const response = await http(app)
    .post(`${API}/auth/login`)
    .set('X-Device-Id', deviceKey)
    .set('X-Device-Platform', 'ios')
    .send({ phone, password: TEST_PASSWORD })
    .expect(200);

  const data = response.body.data ?? response.body;

  return {
    accessToken: data.accessToken as string,
    refreshToken: data.refreshToken as string,
    user: data.user,
    headers: {
      Authorization: `Bearer ${data.accessToken}`,
      'X-Device-Id': deviceKey,
      'X-Device-Platform': 'ios',
    } as Record<string, string>,
  };
}

/** Reads the error code from either envelope shape. */
export function errorCode(body: unknown): string | undefined {
  const b = body as { code?: string; error?: { code?: string } };
  return b.code ?? b.error?.code;
}
