import { Module } from '@nestjs/common';

import { PaymentWebhookService } from './payment-webhook.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { RefundsService } from './refunds.service';

@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService, PaymentWebhookService, RefundsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
