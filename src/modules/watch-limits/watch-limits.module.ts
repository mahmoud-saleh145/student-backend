import { Module } from '@nestjs/common';

import { WatchLimitsController } from './watch-limits.controller';
import { WatchLimitsService } from './watch-limits.service';

// PrismaService, AuditService and CourseAccessService come from global modules.
@Module({
  controllers: [WatchLimitsController],
  providers: [WatchLimitsService],
})
export class WatchLimitsModule {}
