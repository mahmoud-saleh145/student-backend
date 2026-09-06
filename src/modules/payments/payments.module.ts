import { Module } from '@nestjs/common';

import { PaymentWebhookService } from './payment-webhook.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService, PaymentWebhookService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
