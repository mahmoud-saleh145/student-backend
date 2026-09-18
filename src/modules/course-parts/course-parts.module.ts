import { Module } from '@nestjs/common';

import { EnrollmentsModule } from '../enrollments/enrollments.module';

import { CoursePartPurchaseService } from './course-part-purchase.service';
import {
  CoursePartsAdminController,
  CoursePartsController,
} from './course-parts.controller';
import { CoursePartsService } from './course-parts.service';

/**
 * Course parts: structure, pricing and purchase.
 *
 * **No wallet dependency, deliberately.** The wallet is for the Library; a
 * course part is never bought with credits. Parts are unlocked by redeeming a
 * part-scoped access card, and the money changes hands offline when that card
 * is sold — the same way course-scoped and section-scoped cards already work.
 *
 * `EnrollmentsModule` is imported because the redemption path grants sections
 * through `EnrollmentsService.grantAccess()` rather than writing a parallel
 * authorization model. Nothing in the lesson, playback or attachment gates had
 * to change. The part-entitlement write itself is a plain function
 * (`grantPartFromCode`) called from enrollments, which is what keeps these two
 * modules from importing each other.
 *
 * `CoursesModule` is `@Global`, so the access engine arrives without an import
 * and no cycle is created. The course-price guard is a plain function rather
 * than a service for the same reason: `CoursesAdminService` needs it, and a
 * service dependency there would make the two modules import each other.
 */
@Module({
  imports: [EnrollmentsModule],
  controllers: [CoursePartsController, CoursePartsAdminController],
  providers: [CoursePartsService, CoursePartPurchaseService],
  exports: [CoursePartsService, CoursePartPurchaseService],
})
export class CoursePartsModule {}
