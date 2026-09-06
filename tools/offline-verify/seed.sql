-- =============================================================================
-- Integration seed, expressed in SQL.
--
-- Mirrors prisma/seed.ts. Written as SQL because the Prisma CLI could not be
-- installed in this environment (npm registry blocked), and the point is to
-- exercise the REAL schema with realistic data rather than to test Prisma.
--
-- Password hash below is argon2id of "DevPassword123!" — but nothing here
-- verifies passwords, so it is a placeholder shaped like the real thing.
-- =============================================================================

BEGIN;

TRUNCATE TABLE
  users, universities, faculties, departments, academic_years,
  courses, course_sections, lessons, videos, course_teachers, course_prices,
  enrollments, payments, revenue_ledger, access_codes, access_code_redemptions,
  devices, sessions, watch_progress, platform_settings, student_profiles,
  teacher_profiles, attachments
RESTART IDENTITY CASCADE;

-- --- academic structure -------------------------------------------------------
INSERT INTO universities (id,"name","nameAr",code,"isActive","sortOrder","createdAt","updatedAt")
VALUES ('uni_cairo','Cairo University','جامعة القاهرة','CU',true,1,now(),now());

INSERT INTO faculties (id,"universityId","name","nameAr","isActive","sortOrder","createdAt","updatedAt")
VALUES ('fac_eng','uni_cairo','Engineering','الهندسة',true,1,now(),now());

INSERT INTO departments (id,"facultyId","name","nameAr","isActive","sortOrder","createdAt","updatedAt")
VALUES ('dep_cse','fac_eng','Computer Engineering','هندسة الحاسبات',true,1,now(),now());

-- Five years on purpose: an Egyptian engineering degree is five, and nothing
-- in the system may assume four.
INSERT INTO academic_years (id,"order","name","nameAr","isActive","createdAt","updatedAt") VALUES
  ('yr1',1,'First Year','الفرقة الأولى',true,now(),now()),
  ('yr2',2,'Second Year','الفرقة الثانية',true,now(),now()),
  ('yr3',3,'Third Year','الفرقة الثالثة',true,now(),now()),
  ('yr4',4,'Fourth Year','الفرقة الرابعة',true,now(),now()),
  ('yr5',5,'Fifth Year','الفرقة الخامسة',true,now(),now());

-- --- people -------------------------------------------------------------------
INSERT INTO users (id,phone,"passwordHash","fullName",role,status,gender,locale,"credentialsChangedAt","failedLoginCount","createdAt","updatedAt") VALUES
  ('usr_admin','01000000001','$argon2id$v=19$m=8192,t=1,p=1$PLACEHOLDER','Dev Admin Account','ADMIN','ACTIVE','FEMALE','en',now(),0,now(),now()),
  ('usr_teach','01000000002','$argon2id$v=19$m=8192,t=1,p=1$PLACEHOLDER','Dr Hala Abdel Rahman','TEACHER','ACTIVE','FEMALE','ar',now(),0,now(),now()),
  ('usr_stud','01000000010','$argon2id$v=19$m=8192,t=1,p=1$PLACEHOLDER','Youssef Ahmed Mahmoud Salem','STUDENT','ACTIVE','MALE','ar',now(),0,now(),now()),
  ('usr_stud2','01000000011','$argon2id$v=19$m=8192,t=1,p=1$PLACEHOLDER','Nour El Din Sameh Fathy','STUDENT','ACTIVE','MALE','en',now(),0,now(),now());

INSERT INTO teacher_profiles (id,"userId",title,"titleAr",bio,"revenueSharePercent","isPublic","createdAt","updatedAt")
VALUES ('tp1','usr_teach','Professor of Circuit Theory','أستاذ نظرية الدوائر','Seeded',60.00,true,now(),now());

INSERT INTO student_profiles (id,"userId","universityId","facultyId","departmentId","academicYearId","createdAt","updatedAt") VALUES
  ('sp1','usr_stud','uni_cairo','fac_eng','dep_cse','yr2',now(),now()),
  ('sp2','usr_stud2','uni_cairo','fac_eng','dep_cse','yr3',now(),now());

-- --- courses, with three deliberately different section shapes ---------------
INSERT INTO courses
  (id,slug,title,"titleAr","shortDescription",description,status,"universityId","facultyId","academicYearId",
   "enrollmentMethods","isFree","accessDurationType","accessDurationDays",
   "completionRuleType","completionThreshold","completionRequireContiguous",
   requirements,outcomes,"lessonCount","sectionCount","totalDurationSeconds","studentCount",
   "ratingSum","ratingCount","createdById","publishedAt","createdAt","updatedAt")
VALUES
  ('crs_circuits','circuit-analysis-2','Circuit Analysis II','تحليل الدوائر الكهربية ٢',
   'Node, mesh and phasor analysis.','Full AC treatment.','PUBLISHED','uni_cairo','fac_eng','yr2',
   ARRAY['PAYMENT','CODE']::"EnrollmentMethod"[],false,'FIXED_DAYS',180,
   'WATCH_PERCENT',90,true,
   ARRAY['A laptop']::TEXT[],ARRAY['Solve exam questions']::TEXT[],3,3,7200,0,44,10,
   'usr_admin',now(),now(),now()),

  ('crs_free','study-skills','Study Skills','مهارات المذاكرة',
   'Free.','Short free course.','PUBLISHED','uni_cairo','fac_eng',NULL,
   ARRAY['FREE']::"EnrollmentMethod"[],true,'LIFETIME',NULL,
   'WATCH_PERCENT',90,true,
   ARRAY[]::TEXT[],ARRAY[]::TEXT[],1,1,900,0,0,0,
   'usr_admin',now(),now(),now()),

  -- DRAFT: must never appear in the catalogue, and (after the fix) must not
  -- serve content even to a student who was enrolled while it was published.
  ('crs_draft','anatomy-1','Human Anatomy I','التشريح البشري ١',
   'Draft.','Not published.','DRAFT','uni_cairo','fac_eng','yr1',
   ARRAY['PAYMENT']::"EnrollmentMethod"[],false,'FIXED_DAYS',365,
   'WATCH_PERCENT',90,true,
   ARRAY[]::TEXT[],ARRAY[]::TEXT[],1,1,600,0,0,0,
   'usr_admin',NULL,now(),now());

INSERT INTO course_teachers (id,"courseId","teacherId","isLead","canEditContent","canEditPricing","canPublish","canViewStudents","canViewRevenue","createdAt","updatedAt") VALUES
  ('ct1','crs_circuits','usr_teach',true,true,true,true,true,true,now(),now()),
  ('ct2','crs_free','usr_teach',true,true,false,false,true,false,now(),now()),
  ('ct3','crs_draft','usr_teach',true,true,false,false,true,false,now(),now());

-- Version 1 of the price. A later change appends v2 and closes this one.
INSERT INTO course_prices (id,"courseId",amount,currency,version,"isCurrent","effectiveFrom","changedById",reason,"createdAt")
VALUES ('prc_v1','crs_circuits',450.00,'EGP',1,true,now(),'usr_admin','Initial price',now());

-- Midterm-shaped structure (3 sections, uneven).
INSERT INTO course_sections (id,"courseId",title,"titleAr","sortOrder",status,"createdAt","updatedAt") VALUES
  ('sec_pre','crs_circuits','Before Midterm','قبل الميدتيرم',1,'PUBLISHED',now(),now()),
  ('sec_rev','crs_circuits','Midterm Revision','مراجعة الميدتيرم',2,'PUBLISHED',now(),now()),
  ('sec_post','crs_circuits','After Midterm','بعد الميدتيرم',3,'PUBLISHED',now(),now()),
  ('sec_free','crs_free','Everything','كل شيء',1,'PUBLISHED',now(),now()),
  ('sec_draft','crs_draft','Part 1','الجزء الأول',1,'PUBLISHED',now(),now());

INSERT INTO lessons (id,"courseId","sectionId",title,"titleAr",kind,"sortOrder",status,"isPreview","durationSeconds","createdAt","updatedAt") VALUES
  ('les_1','crs_circuits','sec_pre','Sinusoids and phasors','الجيبيات والفيزورات','VIDEO',1,'PUBLISHED',true,1800,now(),now()),
  ('les_2','crs_circuits','sec_rev','Past-paper walkthrough','حل امتحان','VIDEO',1,'PUBLISHED',false,3300,now(),now()),
  ('les_3','crs_circuits','sec_post','Three-phase circuits','الدوائر ثلاثية الأوجه','VIDEO',1,'PUBLISHED',false,2100,now(),now()),
  ('les_free','crs_free','sec_free','Spaced repetition','التكرار المتباعد','VIDEO',1,'PUBLISHED',true,900,now(),now()),
  ('les_draft','crs_draft','sec_draft','Shoulder region','منطقة الكتف','VIDEO',1,'PUBLISHED',false,600,now(),now());

-- Videos: READY with HLS keys, so the playback preconditions are satisfiable.
INSERT INTO videos (id,"lessonId","courseId",status,"hlsPrefix","masterPlaylistKey","durationSeconds","isEncrypted","encryptionKeyId","uploadedById","createdAt","updatedAt") VALUES
  ('vid_1','les_1','crs_circuits','READY','hls/vid_1/','hls/vid_1/master.m3u8',1800,true,'k1','usr_teach',now(),now()),
  ('vid_2','les_2','crs_circuits','READY','hls/vid_2/','hls/vid_2/master.m3u8',3300,true,'k1','usr_teach',now(),now()),
  ('vid_free','les_free','crs_free','READY','hls/vid_free/','hls/vid_free/master.m3u8',900,true,'k1','usr_teach',now(),now()),
  ('vid_draft','les_draft','crs_draft','READY','hls/vid_draft/','hls/vid_draft/master.m3u8',600,true,'k1','usr_teach',now(),now());

-- One video still processing: requesting a ticket must yield VIDEO_NOT_READY.
INSERT INTO videos (id,"lessonId","courseId",status,"durationSeconds","isEncrypted","uploadedById","createdAt","updatedAt")
VALUES ('vid_3','les_3','crs_circuits','PROCESSING',2100,false,'usr_teach',now(),now());

-- --- device binding -----------------------------------------------------------
INSERT INTO devices (id,"userId","deviceKey","name",platform,model,status,"integritySuspect","firstSeenAt","lastSeenAt","approvedAt","createdAt","updatedAt") VALUES
  ('dev_bound','usr_stud','device-key-bound','Student Handset','ios','iPhone15,2','ACTIVE',false,now(),now(),now(),now(),now());

-- --- access codes ---------------------------------------------------------------
INSERT INTO access_codes (id,code,"courseId",status,"maxRedemptions","redemptionCount","accessDurationType","accessDurationDays","expiresAt","issuedById","createdAt","updatedAt") VALUES
  ('cod_single','DEVCIRCUIT01','crs_circuits','ACTIVE',1,0,'FIXED_DAYS',180,now()+interval '90 days','usr_admin',now(),now()),
  ('cod_expired','DEVEXPIRED01','crs_circuits','ACTIVE',1,0,'FIXED_DAYS',180,now()-interval '1 day','usr_admin',now(),now());

INSERT INTO platform_settings (key,value,description,"updatedAt","createdAt") VALUES
  ('platform.minimumAppVersion','"1.0.0"','Minimum client version',now(),now()),
  ('platform.maintenanceMode','false','Maintenance flag',now(),now());

COMMIT;
