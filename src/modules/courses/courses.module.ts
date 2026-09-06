import { Global, Module } from '@nestjs/common';

import { CourseAccessService } from './course-access.service';
import { CoursesAdminController } from './courses.admin.controller';
import { CoursesAdminService } from './courses.admin.service';
import { CoursesController } from './courses.controller';
import { CoursesService } from './courses.service';

/**
 * Global because CourseAccessService is the single access authority and is
 * needed by playback, lessons, attachments, progress and enrollment. Making
 * each of those import CoursesModule would create a web of circular imports.
 */
@Global()
@Module({
  controllers: [CoursesController, CoursesAdminController],
  providers: [CoursesService, CoursesAdminService, CourseAccessService],
  exports: [CoursesService, CoursesAdminService, CourseAccessService],
})
export class CoursesModule {}
