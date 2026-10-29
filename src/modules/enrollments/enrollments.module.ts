import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { CodesModule } from '../codes/codes.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsModule } from '../payments/payments.module';

import { EnrollmentsController } from './enrollments.controller';
import { EnrollmentsService } from './enrollments.service';

// CatalogModule is imported for one dependency: `EnrollmentsService.transfer`
// validates that the student's academic rung belongs to the destination
// department's ladder through CatalogService, so the check can never disagree
// with the catalog's own precedence rules.
@Module({
  imports: [PaymentsModule, CodesModule, NotificationsModule, CatalogModule],
  controllers: [EnrollmentsController],
  providers: [EnrollmentsService],
  exports: [EnrollmentsService],
})
export class EnrollmentsModule {}
