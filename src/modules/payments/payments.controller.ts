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
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
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

class RefundDto {
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0.01) amount?: number;
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

@ApiTags('payments')
@Controller()
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly webhooks: PaymentWebhookService,
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
  list(@Query() query: ListPaymentsDto) {
    return this.payments.listForAdmin({
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

  @Post('admin/payments/:id/refund')
  @AdminOnly()
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Refund a payment',
    description:
      'Additive: appends a refund transaction and a contra revenue line. The original payment keeps its amount, so the record that money was taken survives.',
  })
  refund(
    @Param('id') id: string,
    @Body() dto: RefundDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.payments.refund(id, dto, actor);
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
