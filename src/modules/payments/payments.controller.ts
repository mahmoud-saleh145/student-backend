import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PaymentStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { RawResponse } from '../../common/decorators/raw-response.decorator';
import { AdminOnly, StaffOnly } from '../../common/decorators/roles.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import type { AuthenticatedUser } from '../../common/types/request-context';

import { PaymentsService } from './payments.service';
import { PaymentWebhookService } from './payment-webhook.service';
import { RefundsService } from './refunds.service';

class ListPaymentsDto extends PaginationDto {
  @IsOptional() @IsString() @MaxLength(32) courseId?: string;
  @IsOptional() @IsString() @MaxLength(32) userId?: string;
  @IsOptional() @IsEnum(PaymentStatus) status?: PaymentStatus;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}

class ConfirmPaymentDto {
  @IsOptional() @IsString() @MaxLength(200) providerReference?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class RefundDto {
  @IsIn(['FULL', 'PARTIAL']) type!: 'FULL' | 'PARTIAL';
  /**
   * PARTIAL only. A decimal string with at most two decimals ("150.50"), so
   * the amount never passes through a binary float. A JSON number is accepted
   * and converted to its string form, then parsed exactly into piastres by the
   * service, which rejects anything with more precision.
   */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'number' ? String(value) : value))
  @IsString()
  @Matches(/^\d+(\.\d{1,2})?$/, { message: 'amount must be a positive amount with at most 2 decimal places' })
  amount?: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  /** One id per refund the admin intends; a retry sends the same id. */
  @IsString() @Matches(/^[A-Za-z0-9_-]{8,100}$/, { message: 'idempotencyKey is invalid' })
  idempotencyKey!: string;
  /**
   * IMMEDIATE (default): record the refund as completed now. PENDING: record a
   * request that reserves the amount; complete or fail it later.
   */
  @IsOptional() @IsIn(['IMMEDIATE', 'PENDING']) completion?: 'IMMEDIATE' | 'PENDING';
  /**
   * Must be true for IMMEDIATE: the admin states the money HAS been returned
   * to the student outside the platform. The platform never transfers money.
   */
  @IsOptional() @IsBoolean() confirmMoneyReturned?: boolean;
}

export class CompleteRefundDto {
  /** Must be true: the money has actually been returned to the student. */
  @IsBoolean() confirmMoneyReturned!: boolean;
  /** Optional external reference: bank transfer id, provider refund id. */
  @IsOptional() @IsString() @MaxLength(200) reference?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class FailRefundDto {
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

@ApiTags('payments')
@Controller()
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly webhooks: PaymentWebhookService,
    private readonly refunds: RefundsService,
  ) {}

  // --- student ---------------------------------------------------------------

  @Get('payments/mine')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Your payment history' })
  mine(@CurrentUser() user: AuthenticatedUser, @Query() query: PaginationDto) {
    return this.payments.listForUser(user.id, query.page, query.pageSize);
  }

  // --- administration --------------------------------------------------------

  @Get('admin/payments')
  @StaffOnly()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Browse payments',
    description:
      'Includes period totals. Every amount is the value frozen at purchase time, never recomputed from the course’s current price.',
  })
  list(@Query() query: ListPaymentsDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.payments.listForAdmin({
      actor,
      page: query.page,
      pageSize: query.pageSize,
      courseId: query.courseId,
      userId: query.userId,
      status: query.status,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
  }

  @Post('admin/payments/:id/confirm')
  @AdminOnly()
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm a payment manually',
    description:
      'The offline-money path: bank transfer or cash received at the centre. Activates access and writes the revenue line. Idempotent.',
  })
  confirm(
    @Param('id') id: string,
    @Body() dto: ConfirmPaymentDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.payments.capture({
      paymentId: id,
      providerReference: dto.providerReference,
      actor,
      note: dto.note ?? 'Manual confirmation',
    });
  }

  @Get('admin/payments/:id/refunds')
  @AdminOnly()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Refund summary for a payment',
    description:
      'Paid, refunded, pending and refundable amounts, the refund history, the student, course and enrollment — what the Refund dialog shows.',
  })
  refundSummary(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.refunds.summary(id, actor);
  }

  @Post('admin/payments/:id/refund')
  @AdminOnly()
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Refund a payment (full or partial)',
    description: [
      'Additive: appends a refund transaction and a contra revenue line; the original payment and revenue line are kept.',
      'Every refund immediately revokes the student’s access to the course.',
      'completion=IMMEDIATE (default) records a completed refund and reduces net revenue now; it requires confirmMoneyReturned=true, the administrator’s statement that the money was returned outside the platform.',
      'completion=PENDING records a request that reserves the amount without touching revenue, to be completed or failed later.',
      'The platform never transfers money: no Paymob or Stripe refund API is integrated.',
      'Idempotent per idempotencyKey.',
    ].join(' '),
  })
  refund(
    @Param('id') id: string,
    @Body() dto: RefundDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.refunds.refund(id, dto, actor);
  }

  @Post('admin/payments/:id/refunds/:refundId/complete')
  @AdminOnly()
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete a pending refund (the money has been returned)',
    description:
      'Only now is the amount counted as refunded and net revenue reduced. Requires confirmMoneyReturned=true; an external reference is optional. Recorded as admin-confirmed, never as provider-confirmed. Idempotent.',
  })
  completeRefund(
    @Param('id') id: string,
    @Param('refundId') refundId: string,
    @Body() dto: CompleteRefundDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.refunds.completeRequest(id, refundId, dto, actor);
  }

  @Post('admin/payments/:id/refunds/:refundId/fail')
  @AdminOnly()
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark a pending refund failed (it will not happen)',
    description:
      'Releases the reserved amount. Course access stays revoked; restoring it is a separate grant.',
  })
  failRefund(
    @Param('id') id: string,
    @Param('refundId') refundId: string,
    @Body() dto: FailRefundDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.refunds.failRequest(id, refundId, dto, actor);
  }

  // --- provider webhooks -----------------------------------------------------

  @Post('payments/webhooks/paymob')
  @Public()
  @RawResponse()
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  paymob(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: Record<string, unknown>,
    @Headers('hmac') hmac?: string,
  ) {
    return this.webhooks.handlePaymob(body, hmac ?? '', req.rawBody);
  }

  @Post('payments/webhooks/stripe')
  @Public()
  @RawResponse()
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  stripe(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: Record<string, unknown>,
    @Headers('stripe-signature') signature?: string,
  ) {
    return this.webhooks.handleStripe(body, signature ?? '', req.rawBody);
  }
}
