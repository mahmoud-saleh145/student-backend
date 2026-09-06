/* eslint-disable no-console */
/**
 * =============================================================================
 * Development seed
 * =============================================================================
 *
 * Spec §77/§79: seed data for development, and it must not create fake
 * production users by accident.
 *
 * Three guards enforce that:
 *
 *   1. It refuses to run when `NODE_ENV=production` unless `ALLOW_PROD_SEED=1`
 *      is also set — two independent mistakes rather than one.
 *   2. It refuses to run against a database that already contains payments.
 *      An empty-ish dev database is fine to re-seed; one with financial rows
 *      is somebody's real data.
 *   3. Every account it creates is marked in `notes`/`note` fields as seeded,
 *      and all use the same obvious development password.
 *
 * What it does NOT create
 * -----------------------
 * A MASTER account. That is `scripts/create-master.ts`, deliberately, so that
 * there is exactly one code path in the entire repository capable of minting
 * the platform owner — and it is not one that runs as part of `db:setup`.
 *
 * The seed is idempotent: re-running it updates the same rows rather than
 * duplicating them, so `npm run seed` is safe in a loop while developing.
 *
 * Usage
 * -----
 *   npm run seed
 *   npm run db:setup      # generate + migrate + seed
 * =============================================================================
 */

import {
  AccessDurationType,
  AccountStatus,
  AttachmentKind,
  CodeStatus,
  CompletionRuleType,
  ContentStatus,
  CourseStatus,
  EnrollmentMethod,
  EnrollmentState,
  Gender,
  LessonKind,
  NotificationKind,
  PaymentProvider,
  PaymentStatus,
  PrismaClient,
  UserRole,
  VideoStatus,
} from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

/** Obviously-a-development-password. Never valid under the master rules. */
const DEV_PASSWORD = 'DevPassword123!';

const ARGON_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  // Deliberately cheaper than production: the seed hashes a dozen passwords
  // and there is no threat model for a local database.
  memoryCost: 8192,
  timeCost: 1,
  parallelism: 1,
};

// -----------------------------------------------------------------------------
// Guards
// -----------------------------------------------------------------------------

async function assertSafeToSeed(): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PROD_SEED !== '1') {
    throw new Error(
      'Refusing to seed with NODE_ENV=production. If this really is intended, ' +
        'set ALLOW_PROD_SEED=1 as well — but you almost certainly want ' +
        'scripts/create-master.ts instead.',
    );
  }

  const payments = await prisma.payment.count();
  if (payments > 0) {
    throw new Error(
      `Refusing to seed: this database already contains ${payments} payment row(s). ` +
        'Seeding is for empty development databases only.',
    );
  }
}

// -----------------------------------------------------------------------------
// Academic structure
// -----------------------------------------------------------------------------

async function seedAcademicStructure() {
  console.log('  · universities, faculties, departments, academic years');

  const cairo = await prisma.university.upsert({
    where: { code: 'CU' },
    update: {},
    create: {
      code: 'CU',
      name: 'Cairo University',
      nameAr: 'جامعة القاهرة',
      sortOrder: 1,
    },
  });

  const ainShams = await prisma.university.upsert({
    where: { code: 'ASU' },
    update: {},
    create: {
      code: 'ASU',
      name: 'Ain Shams University',
      nameAr: 'جامعة عين شمس',
      sortOrder: 2,
    },
  });

  const engineering = await prisma.faculty.upsert({
    where: { universityId_name: { universityId: cairo.id, name: 'Engineering' } },
    update: {},
    create: {
      universityId: cairo.id,
      name: 'Engineering',
      nameAr: 'الهندسة',
      sortOrder: 1,
    },
  });

  const medicine = await prisma.faculty.upsert({
    where: { universityId_name: { universityId: cairo.id, name: 'Medicine' } },
    update: {},
    create: {
      universityId: cairo.id,
      name: 'Medicine',
      nameAr: 'الطب',
      sortOrder: 2,
    },
  });

  await prisma.faculty.upsert({
    where: { universityId_name: { universityId: ainShams.id, name: 'Science' } },
    update: {},
    create: {
      universityId: ainShams.id,
      name: 'Science',
      nameAr: 'العلوم',
      sortOrder: 1,
    },
  });

  const departments = await Promise.all(
    [
      { facultyId: engineering.id, name: 'Computer Engineering', nameAr: 'هندسة الحاسبات', sortOrder: 1 },
      { facultyId: engineering.id, name: 'Electrical Power', nameAr: 'القوى الكهربية', sortOrder: 2 },
      { facultyId: engineering.id, name: 'Civil Engineering', nameAr: 'الهندسة المدنية', sortOrder: 3 },
      { facultyId: medicine.id, name: 'General Medicine', nameAr: 'الطب العام', sortOrder: 1 },
    ].map((d) =>
      prisma.department.upsert({
        where: { facultyId_name: { facultyId: d.facultyId, name: d.name } },
        update: {},
        create: d,
      }),
    ),
  );

  // Five years, because engineering in Egypt is a five-year degree. The point
  // of the `order` column is precisely that nothing assumes four.
  const years = await Promise.all(
    [
      { order: 1, name: 'First Year', nameAr: 'الفرقة الأولى' },
      { order: 2, name: 'Second Year', nameAr: 'الفرقة الثانية' },
      { order: 3, name: 'Third Year', nameAr: 'الفرقة الثالثة' },
      { order: 4, name: 'Fourth Year', nameAr: 'الفرقة الرابعة' },
      { order: 5, name: 'Fifth Year', nameAr: 'الفرقة الخامسة' },
    ].map((y) =>
      prisma.academicYear.upsert({ where: { order: y.order }, update: {}, create: y }),
    ),
  );

  return { cairo, ainShams, engineering, medicine, departments, years };
}

// -----------------------------------------------------------------------------
// People
// -----------------------------------------------------------------------------

async function seedUsers(structure: Awaited<ReturnType<typeof seedAcademicStructure>>) {
  console.log('  · admin, teachers, students');

  const passwordHash = await argon2.hash(DEV_PASSWORD, ARGON_OPTIONS);

  const admin = await prisma.user.upsert({
    where: { phone: '01000000001' },
    update: { passwordHash },
    create: {
      phone: '01000000001',
      fullName: 'Dev Admin Account',
      role: UserRole.ADMIN,
      status: AccountStatus.ACTIVE,
      passwordHash,
      locale: 'en',
      gender: Gender.FEMALE,
    },
  });

  const teacherA = await prisma.user.upsert({
    where: { phone: '01000000002' },
    update: { passwordHash },
    create: {
      phone: '01000000002',
      fullName: 'Dr Hala Abdel Rahman',
      role: UserRole.TEACHER,
      status: AccountStatus.ACTIVE,
      passwordHash,
      locale: 'ar',
      gender: Gender.FEMALE,
      teacherProfile: {
        create: {
          title: 'Professor of Circuit Theory',
          titleAr: 'أستاذ نظرية الدوائر',
          bio: 'Seeded development teacher.',
          bioAr: 'حساب مدرّس للتطوير.',
          revenueSharePercent: 60,
        },
      },
    },
  });

  const teacherB = await prisma.user.upsert({
    where: { phone: '01000000003' },
    update: { passwordHash },
    create: {
      phone: '01000000003',
      fullName: 'Eng Mostafa Kamal Ibrahim',
      role: UserRole.TEACHER,
      status: AccountStatus.ACTIVE,
      passwordHash,
      locale: 'en',
      gender: Gender.MALE,
      teacherProfile: {
        create: {
          title: 'Teaching Assistant',
          titleAr: 'معيد',
          bio: 'Seeded development co-teacher.',
          revenueSharePercent: 20,
        },
      },
    },
  });

  const [compEng] = structure.departments;

  const student = await prisma.user.upsert({
    where: { phone: '01000000010' },
    update: { passwordHash },
    create: {
      phone: '01000000010',
      // Three-part-or-longer names are a hard requirement (spec §11), so the
      // seed uses one — it is what the registration form must accept.
      fullName: 'Youssef Ahmed Mahmoud Salem',
      role: UserRole.STUDENT,
      status: AccountStatus.ACTIVE,
      passwordHash,
      locale: 'ar',
      gender: Gender.MALE,
      studentProfile: {
        create: {
          universityId: structure.cairo.id,
          facultyId: structure.engineering.id,
          departmentId: compEng?.id ?? null,
          academicYearId: structure.years[1]?.id ?? null,
          notes: 'Seeded development student.',
        },
      },
    },
  });

  const student2 = await prisma.user.upsert({
    where: { phone: '01000000011' },
    update: { passwordHash },
    create: {
      phone: '01000000011',
      fullName: 'Nour El Din Sameh Fathy',
      role: UserRole.STUDENT,
      status: AccountStatus.ACTIVE,
      passwordHash,
      locale: 'en',
      gender: Gender.MALE,
      studentProfile: {
        create: {
          universityId: structure.cairo.id,
          facultyId: structure.engineering.id,
          departmentId: compEng?.id ?? null,
          academicYearId: structure.years[2]?.id ?? null,
          notes: 'Seeded development student (no enrollments).',
        },
      },
    },
  });

  return { admin, teacherA, teacherB, student, student2 };
}

// -----------------------------------------------------------------------------
// Courses
//
// The three courses below exist to prove the dynamic-structure requirement
// (spec §17) rather than to look pretty. They have deliberately *different*
// section shapes:
//
//   • Circuit Analysis — a midterm-shaped course (3 sections)
//   • Data Structures  — a unit-shaped course  (5 sections)
//   • Anatomy          — a part-shaped course  (4 sections)
//
// If any client code assumes "before midterm / after midterm", one of these
// will break it immediately.
// -----------------------------------------------------------------------------

interface SectionSpec {
  title: string;
  titleAr: string;
  lessons: { title: string; titleAr: string; duration: number; preview?: boolean }[];
}

async function seedCourse(params: {
  slug: string;
  title: string;
  titleAr: string;
  shortDescription: string;
  description: string;
  status: CourseStatus;
  price: number | null;
  isFree: boolean;
  enrollmentMethods: EnrollmentMethod[];
  accessDurationType: AccessDurationType;
  accessDurationDays?: number;
  universityId: string;
  facultyId: string;
  academicYearId: string | null;
  teachers: { id: string; isLead: boolean; canEditPricing: boolean }[];
  createdById: string;
  sections: SectionSpec[];
}) {
  const existing = await prisma.course.findUnique({ where: { slug: params.slug } });
  if (existing) {
    console.log(`    – ${params.slug} already present, skipping`);
    return existing;
  }

  const course = await prisma.$transaction(async (tx) => {
    const created = await tx.course.create({
      data: {
        slug: params.slug,
        title: params.title,
        titleAr: params.titleAr,
        shortDescription: params.shortDescription,
        description: params.description,
        status: params.status,
        universityId: params.universityId,
        facultyId: params.facultyId,
        academicYearId: params.academicYearId,
        enrollmentMethods: params.enrollmentMethods,
        isFree: params.isFree,
        accessDurationType: params.accessDurationType,
        accessDurationDays: params.accessDurationDays ?? null,
        completionRuleType: CompletionRuleType.WATCH_PERCENT,
        completionThreshold: 90,
        completionRequireContiguous: true,
        requirements: ['A laptop or tablet', 'Basic secondary-school mathematics'],
        outcomes: [
          'Solve the standard exam question types',
          'Explain the underlying method, not just the answer',
        ],
        createdById: params.createdById,
        publishedAt: params.status === CourseStatus.PUBLISHED ? new Date() : null,
      },
    });

    for (const t of params.teachers) {
      await tx.courseTeacher.create({
        data: {
          courseId: created.id,
          teacherId: t.id,
          isLead: t.isLead,
          canEditContent: true,
          canEditPricing: t.canEditPricing,
          canPublish: t.isLead,
          canViewStudents: true,
          canViewRevenue: t.isLead,
          assignedById: params.createdById,
        },
      });
    }

    // Version 1 of the price. Later changes append version 2, 3 … and close
    // the previous row's effectiveTo — never overwrite (spec §28, §73).
    if (params.price !== null) {
      await tx.coursePrice.create({
        data: {
          courseId: created.id,
          amount: params.price,
          currency: 'EGP',
          version: 1,
          isCurrent: true,
          changedById: params.createdById,
          reason: 'Initial price',
        },
      });
    }

    let lessonCount = 0;
    let totalDuration = 0;

    for (const [index, spec] of params.sections.entries()) {
      const section = await tx.courseSection.create({
        data: {
          courseId: created.id,
          title: spec.title,
          titleAr: spec.titleAr,
          sortOrder: index + 1,
          status: ContentStatus.PUBLISHED,
        },
      });

      for (const [lessonIndex, lessonSpec] of spec.lessons.entries()) {
        const lesson = await tx.lesson.create({
          data: {
            courseId: created.id,
            sectionId: section.id,
            title: lessonSpec.title,
            titleAr: lessonSpec.titleAr,
            kind: LessonKind.VIDEO,
            sortOrder: lessonIndex + 1,
            status: ContentStatus.PUBLISHED,
            isPreview: lessonSpec.preview ?? false,
            durationSeconds: lessonSpec.duration,
          },
        });

        // A video row in UPLOADING state, with no storage keys.
        //
        // This is intentional and important: the seed must never imply that a
        // playable asset exists. Requesting a playback ticket for one of these
        // returns VIDEO_NOT_READY, which is exactly the state a developer
        // should see before they upload anything to R2/MinIO.
        await tx.video.create({
          data: {
            lessonId: lesson.id,
            courseId: created.id,
            status: VideoStatus.UPLOADING,
            durationSeconds: lessonSpec.duration,
            uploadedById: params.teachers[0]?.id ?? params.createdById,
          },
        });

        lessonCount += 1;
        totalDuration += lessonSpec.duration;
      }
    }

    await tx.attachment.create({
      data: {
        courseId: created.id,
        title: 'Course syllabus',
        titleAr: 'محتوى المقرر',
        kind: AttachmentKind.PDF,
        // No object exists at this key — attachment tickets will 404 from
        // storage until a real file is uploaded. Same reasoning as the videos.
        objectKey: `seed/${params.slug}/syllabus.pdf`,
        isProtected: false,
        isPreview: true,
        isDownloadable: true,
        sortOrder: 1,
        uploadedById: params.createdById,
      },
    });

    return tx.course.update({
      where: { id: created.id },
      data: {
        lessonCount,
        sectionCount: params.sections.length,
        totalDurationSeconds: totalDuration,
      },
    });
  });

  console.log(
    `    ✓ ${params.slug} — ${params.sections.length} sections, ${course.lessonCount} lessons`,
  );
  return course;
}

async function seedCourses(
  structure: Awaited<ReturnType<typeof seedAcademicStructure>>,
  users: Awaited<ReturnType<typeof seedUsers>>,
) {
  console.log('  · courses with deliberately different section structures');

  const circuits = await seedCourse({
    slug: 'circuit-analysis-2',
    title: 'Circuit Analysis II',
    titleAr: 'تحليل الدوائر الكهربية ٢',
    shortDescription: 'Node, mesh and phasor analysis with full exam drills.',
    description:
      'A complete treatment of AC circuit analysis, worked exam by exam. Every method is derived before it is applied.',
    status: CourseStatus.PUBLISHED,
    price: 450,
    isFree: false,
    enrollmentMethods: [EnrollmentMethod.PAYMENT, EnrollmentMethod.CODE],
    accessDurationType: AccessDurationType.FIXED_DAYS,
    accessDurationDays: 180,
    universityId: structure.cairo.id,
    facultyId: structure.engineering.id,
    academicYearId: structure.years[1]?.id ?? null,
    createdById: users.admin.id,
    // Two teachers on one course (spec §72).
    teachers: [
      { id: users.teacherA.id, isLead: true, canEditPricing: true },
      { id: users.teacherB.id, isLead: false, canEditPricing: false },
    ],
    // Midterm-shaped: 3 sections.
    sections: [
      {
        title: 'Before Midterm',
        titleAr: 'قبل الميدتيرم',
        lessons: [
          { title: 'Sinusoids and phasors', titleAr: 'الجيبيات والفيزورات', duration: 1820, preview: true },
          { title: 'Impedance and admittance', titleAr: 'المعاوقة والسماحية', duration: 2140 },
          { title: 'Nodal analysis in the frequency domain', titleAr: 'تحليل العقد في نطاق التردد', duration: 2560 },
        ],
      },
      {
        title: 'Midterm Revision',
        titleAr: 'مراجعة الميدتيرم',
        lessons: [
          { title: 'Full past-paper walkthrough 2023', titleAr: 'حل امتحان ٢٠٢٣ كاملاً', duration: 3300 },
          { title: 'Common mistakes and how to avoid them', titleAr: 'أشهر الأخطاء وكيفية تجنبها', duration: 1450 },
        ],
      },
      {
        title: 'After Midterm',
        titleAr: 'بعد الميدتيرم',
        lessons: [
          { title: 'Three-phase circuits', titleAr: 'الدوائر ثلاثية الأوجه', duration: 2890 },
          { title: 'Magnetically coupled circuits', titleAr: 'الدوائر المترابطة مغناطيسياً', duration: 2410 },
          { title: 'Two-port networks', titleAr: 'الشبكات ثنائية المنفذ', duration: 2650 },
        ],
      },
    ],
  });

  const dataStructures = await seedCourse({
    slug: 'data-structures',
    title: 'Data Structures and Algorithms',
    titleAr: 'هياكل البيانات والخوارزميات',
    shortDescription: 'From arrays to graphs, with complexity analysis throughout.',
    description:
      'Builds each structure from its invariants outward, so the complexity result is obvious rather than memorised.',
    status: CourseStatus.PUBLISHED,
    price: 600,
    isFree: false,
    enrollmentMethods: [EnrollmentMethod.PAYMENT, EnrollmentMethod.CODE, EnrollmentMethod.ADMIN_APPROVAL],
    accessDurationType: AccessDurationType.LIFETIME,
    universityId: structure.cairo.id,
    facultyId: structure.engineering.id,
    academicYearId: structure.years[2]?.id ?? null,
    createdById: users.admin.id,
    teachers: [{ id: users.teacherB.id, isLead: true, canEditPricing: true }],
    // Unit-shaped: 5 sections, nothing resembling a midterm split.
    sections: [
      {
        title: 'Unit 1 — Foundations',
        titleAr: 'الوحدة الأولى — الأساسيات',
        lessons: [
          { title: 'Asymptotic notation', titleAr: 'الترميز التقاربي', duration: 1980, preview: true },
          { title: 'Arrays and dynamic arrays', titleAr: 'المصفوفات والمصفوفات الديناميكية', duration: 2200 },
        ],
      },
      {
        title: 'Unit 2 — Linear Structures',
        titleAr: 'الوحدة الثانية — الهياكل الخطية',
        lessons: [
          { title: 'Linked lists', titleAr: 'القوائم المرتبطة', duration: 2450 },
          { title: 'Stacks and queues', titleAr: 'المكدسات والطوابير', duration: 2010 },
        ],
      },
      {
        title: 'Midterm',
        titleAr: 'الميدتيرم',
        lessons: [
          { title: 'Midterm revision session', titleAr: 'جلسة مراجعة الميدتيرم', duration: 3600 },
        ],
      },
      {
        title: 'Unit 3 — Trees and Graphs',
        titleAr: 'الوحدة الثالثة — الأشجار والرسوم',
        lessons: [
          { title: 'Binary search trees', titleAr: 'أشجار البحث الثنائية', duration: 2760 },
          { title: 'Balanced trees', titleAr: 'الأشجار المتوازنة', duration: 3010 },
          { title: 'Graph traversal', titleAr: 'اجتياز الرسوم', duration: 2890 },
        ],
      },
      {
        title: 'Final Revision',
        titleAr: 'المراجعة النهائية',
        lessons: [
          { title: 'Complexity cheat sheet, derived', titleAr: 'ملخص التعقيد مع الاشتقاق', duration: 2300 },
        ],
      },
    ],
  });

  const anatomy = await seedCourse({
    slug: 'human-anatomy-1',
    title: 'Human Anatomy I',
    titleAr: 'التشريح البشري ١',
    shortDescription: 'Upper limb, lower limb, thorax and abdomen.',
    description: 'Regional anatomy taught in the order the practical exams ask for it.',
    status: CourseStatus.DRAFT,
    price: 500,
    isFree: false,
    enrollmentMethods: [EnrollmentMethod.PAYMENT],
    accessDurationType: AccessDurationType.FIXED_DAYS,
    accessDurationDays: 365,
    universityId: structure.cairo.id,
    facultyId: structure.medicine.id,
    academicYearId: structure.years[0]?.id ?? null,
    createdById: users.admin.id,
    teachers: [{ id: users.teacherA.id, isLead: true, canEditPricing: false }],
    // Part-shaped: 4 sections. Also DRAFT, so it must NOT appear in the
    // student catalogue — a useful negative case to test against.
    sections: [
      {
        title: 'Part 1 — Upper Limb',
        titleAr: 'الجزء الأول — الطرف العلوي',
        lessons: [{ title: 'Shoulder region', titleAr: 'منطقة الكتف', duration: 2600 }],
      },
      {
        title: 'Part 2 — Lower Limb',
        titleAr: 'الجزء الثاني — الطرف السفلي',
        lessons: [{ title: 'Gluteal region', titleAr: 'المنطقة الألوية', duration: 2450 }],
      },
      {
        title: 'Part 3 — Thorax',
        titleAr: 'الجزء الثالث — الصدر',
        lessons: [{ title: 'Mediastinum', titleAr: 'المنصف', duration: 2800 }],
      },
      {
        title: 'Part 4 — Abdomen',
        titleAr: 'الجزء الرابع — البطن',
        lessons: [{ title: 'Anterior abdominal wall', titleAr: 'جدار البطن الأمامي', duration: 2350 }],
      },
    ],
  });

  // A free course, so the FREE join path has something to exercise.
  const studySkills = await seedCourse({
    slug: 'study-skills',
    title: 'Study Skills for Engineering Students',
    titleAr: 'مهارات المذاكرة لطلاب الهندسة',
    shortDescription: 'Free. How to revise for a five-hour exam without burning out.',
    description: 'A short free course, used to exercise the free-enrollment path.',
    status: CourseStatus.PUBLISHED,
    price: null,
    isFree: true,
    enrollmentMethods: [EnrollmentMethod.FREE],
    accessDurationType: AccessDurationType.LIFETIME,
    universityId: structure.cairo.id,
    facultyId: structure.engineering.id,
    academicYearId: null,
    createdById: users.admin.id,
    teachers: [{ id: users.teacherB.id, isLead: true, canEditPricing: false }],
    sections: [
      {
        title: 'Everything',
        titleAr: 'كل شيء',
        lessons: [
          { title: 'Spaced repetition, concretely', titleAr: 'التكرار المتباعد عملياً', duration: 900, preview: true },
          { title: 'Building an exam-week schedule', titleAr: 'بناء جدول أسبوع الامتحانات', duration: 1100 },
        ],
      },
    ],
  });

  return { circuits, dataStructures, anatomy, studySkills };
}

// -----------------------------------------------------------------------------
// Commerce
// -----------------------------------------------------------------------------

async function seedCommerce(
  users: Awaited<ReturnType<typeof seedUsers>>,
  courses: Awaited<ReturnType<typeof seedCourses>>,
) {
  console.log('  · enrollment, payment, price history, access codes');

  const price = await prisma.coursePrice.findFirst({
    where: { courseId: courses.circuits.id, isCurrent: true },
  });

  const existing = await prisma.enrollment.findUnique({
    where: { userId_courseId: { userId: users.student.id, courseId: courses.circuits.id } },
  });

  if (!existing && price) {
    await prisma.$transaction(async (tx) => {
      const enrollment = await tx.enrollment.create({
        data: {
          userId: users.student.id,
          courseId: courses.circuits.id,
          state: EnrollmentState.ACTIVE,
          method: EnrollmentMethod.PAYMENT,
          accessStartsAt: new Date(),
          accessEndsAt: new Date(Date.now() + 180 * 86_400_000),
        },
      });

      const payment = await tx.payment.create({
        data: {
          userId: users.student.id,
          courseId: courses.circuits.id,
          enrollmentId: enrollment.id,
          // Both the amount AND the price version are stored. This is the pair
          // that makes historical revenue immune to future price edits.
          coursePriceId: price.id,
          amount: price.amount,
          currency: price.currency,
          status: PaymentStatus.PAID,
          provider: PaymentProvider.MANUAL,
          idempotencyKey: `seed-${enrollment.id}`,
          providerReference: 'SEED-MANUAL-0001',
          paidAt: new Date(),
        },
      });

      await tx.revenueLedger.create({
        data: {
          paymentId: payment.id,
          courseId: courses.circuits.id,
          teacherId: users.teacherA.id,
          courseTitleSnapshot: courses.circuits.title,
          grossAmount: price.amount,
          sharePercent: 60,
          teacherAmount: Number(price.amount) * 0.6,
          platformAmount: Number(price.amount) * 0.4,
          currency: price.currency,
          recognizedAt: new Date(),
        },
      });

      await tx.course.update({
        where: { id: courses.circuits.id },
        data: { studentCount: { increment: 1 } },
      });
    });

    // Now change the price — the whole point of the exercise. The paid row
    // above must still read 450 afterwards.
    await prisma.$transaction(async (tx) => {
      await tx.coursePrice.update({
        where: { id: price.id },
        data: { isCurrent: false, effectiveTo: new Date() },
      });
      await tx.coursePrice.create({
        data: {
          courseId: courses.circuits.id,
          amount: 550,
          currency: 'EGP',
          version: 2,
          isCurrent: true,
          changedById: users.teacherA.id,
          reason: 'Seeded price change — proves historical payments are unaffected',
        },
      });
    });

    console.log('    ✓ paid enrollment at 450 EGP, price then raised to 550 EGP');
  }

  // An expired enrollment, so the expired-access path has a fixture.
  await prisma.enrollment.upsert({
    where: {
      userId_courseId: { userId: users.student.id, courseId: courses.studySkills.id },
    },
    update: {},
    create: {
      userId: users.student.id,
      courseId: courses.studySkills.id,
      state: EnrollmentState.EXPIRED,
      method: EnrollmentMethod.FREE,
      accessStartsAt: new Date(Date.now() - 400 * 86_400_000),
      accessEndsAt: new Date(Date.now() - 30 * 86_400_000),
    },
  });

  // Access codes: one single-use, one multi-use batch, one already expired.
  const codes = [
    {
      code: 'DEVCIRCUIT01',
      courseId: courses.circuits.id,
      maxRedemptions: 1,
      status: CodeStatus.ACTIVE,
      note: 'Seeded single-use code',
      expiresAt: new Date(Date.now() + 90 * 86_400_000),
    },
    {
      code: 'DEVBATCH0001',
      courseId: courses.dataStructures.id,
      maxRedemptions: 25,
      status: CodeStatus.ACTIVE,
      batchId: 'seed-batch-1',
      note: 'Seeded 25-use batch code',
      expiresAt: new Date(Date.now() + 90 * 86_400_000),
    },
    {
      code: 'DEVEXPIRED01',
      courseId: courses.circuits.id,
      maxRedemptions: 1,
      status: CodeStatus.EXPIRED,
      note: 'Seeded expired code — should always be rejected',
      expiresAt: new Date(Date.now() - 86_400_000),
    },
  ];

  for (const c of codes) {
    await prisma.accessCode.upsert({
      where: { code: c.code },
      update: {},
      create: {
        ...c,
        accessDurationType: AccessDurationType.FIXED_DAYS,
        accessDurationDays: 180,
        issuedById: users.admin.id,
      },
    });
  }

  console.log(`    ✓ ${codes.length} access codes`);
}

// -----------------------------------------------------------------------------
// Misc
// -----------------------------------------------------------------------------

async function seedNotificationsAndSettings(
  users: Awaited<ReturnType<typeof seedUsers>>,
  courses: Awaited<ReturnType<typeof seedCourses>>,
) {
  console.log('  · notifications, platform settings');

  const existing = await prisma.notification.count({ where: { userId: users.student.id } });
  if (existing === 0) {
    await prisma.notification.createMany({
      data: [
        {
          userId: users.student.id,
          kind: NotificationKind.ENROLLMENT,
          title: 'You joined Circuit Analysis II',
          titleAr: 'لقد انضممت إلى تحليل الدوائر الكهربية ٢',
          body: 'Your access runs for 180 days. Start with "Sinusoids and phasors".',
          bodyAr: 'صلاحية الوصول ١٨٠ يوماً. ابدأ بدرس «الجيبيات والفيزورات».',
          route: `/course/${courses.circuits.id}`,
          read: false,
        },
        {
          userId: users.student.id,
          kind: NotificationKind.ANNOUNCEMENT,
          title: 'Welcome to the platform',
          titleAr: 'أهلاً بك في المنصة',
          body: 'This is a seeded development notification.',
          bodyAr: 'هذا إشعار تطوير تجريبي.',
          read: true,
          readAt: new Date(),
        },
      ],
    });
  }

  const settings: { key: string; value: unknown; description: string }[] = [
    {
      key: 'platform.minimumAppVersion',
      value: '1.0.0',
      description: 'Clients below this are asked to upgrade before signing in.',
    },
    {
      key: 'platform.maintenanceMode',
      value: false,
      description: 'When true, non-staff requests receive MAINTENANCE_MODE.',
    },
    {
      key: 'platform.supportPhone',
      value: '01000000001',
      description: 'Shown in the app when a student needs a password reset.',
    },
    {
      key: 'playback.maxConcurrentStreams',
      value: 1,
      description: 'Concurrent protected streams allowed per student.',
    },
  ];

  for (const s of settings) {
    await prisma.platformSetting.upsert({
      where: { key: s.key },
      update: {},
      create: {
        key: s.key,
        value: s.value as never,
        description: s.description,
      },
    });
  }
}

// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\nSeeding development data…\n');

  await assertSafeToSeed();

  const structure = await seedAcademicStructure();
  const users = await seedUsers(structure);
  const courses = await seedCourses(structure, users);
  await seedCommerce(users, courses);
  await seedNotificationsAndSettings(users, courses);

  console.log(
    [
      '',
      '─────────────────────────────────────────────',
      ' Development accounts (password for all: ' + DEV_PASSWORD + ')',
      '─────────────────────────────────────────────',
      '  ADMIN    01000000001   Dev Admin Account',
      '  TEACHER  01000000002   Dr Hala Abdel Rahman  (lead, 2 courses)',
      '  TEACHER  01000000003   Eng Mostafa Kamal Ibrahim',
      '  STUDENT  01000000010   Youssef Ahmed Mahmoud Salem  (1 paid enrollment)',
      '  STUDENT  01000000011   Nour El Din Sameh Fathy      (no enrollments)',
      '',
      '  MASTER   — not seeded. Run: npm run bootstrap:master',
      '',
      '  Access codes: DEVCIRCUIT01 (single use), DEVBATCH0001 (25 uses),',
      '                DEVEXPIRED01 (expired — must be rejected)',
      '',
      '  Videos are seeded in UPLOADING state with no storage keys, so',
      '  playback correctly fails with VIDEO_NOT_READY until you upload one.',
      '',
    ].join('\n'),
  );
}

main()
  .catch((error: unknown) => {
    console.error(`\n✗ Seed failed: ${(error as Error).message}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
