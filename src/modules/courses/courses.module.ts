import { Global, Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';

import { CourseAccessService } from './course-access.service';
import { CoursesAdminController } from './courses.admin.controller';
import { CoursesAdminService } from './courses.admin.service';
import { CoursesController } from './courses.controller';
import { CoursesService } from './courses.service';

/**
 * Global because CourseAccessService is the single access authority and is
 * needed by playback, lessons, attachments, progress and enrollment. Making
 * each of those import CoursesModule would create a web of circular imports.
 *
 * CatalogModule is imported for one dependency: CoursesAdminService resolves a
 * course's academic ladder through CatalogService rather than re-deriving the
 * department -> faculty -> university -> platform precedence, so the two can
 * never disagree about which list governs a unit.
 */
@Global()
@Module({
  imports: [CatalogModule],
  controllers: [CoursesController, CoursesAdminController],
  providers: [CoursesService, CoursesAdminService, CourseAccessService],
  exports: [CoursesService, CoursesAdminService, CourseAccessService],
})
export class CoursesModule {}
