import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { AdminOnly, StudentOnly } from '../../common/decorators/roles.decorator';
import { CredentialThrottle } from '../../common/decorators/throttle.decorator';
import type { AuthenticatedUser, DeviceContext } from '../../common/types/request-context';
import type { RequestMeta } from '../auth/auth.service';

import {
  CancelAccountDeletionDto,
  ConfirmSettlementDto,
  RecoverAccountDeletionDto,
  RequestAccountDeletionDto,
} from './account-deletion.dto';
import { AccountDeletionService } from './account-deletion.service';

/**
 * In-app account deletion (owner decision D5; Google Play's account-deletion
 * requirement). See AccountDeletionService for the lifecycle.
 */
@ApiTags('auth')
@Controller('auth/account-deletion')
export class AccountDeletionController {
  constructor(private readonly deletion: AccountDeletionService) {}

  @Post()
  @StudentOnly()
  @CredentialThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Schedule deletion of the signed-in account (30-day cancellation period)',
    description:
      'Requires the current password. Signs the account out everywhere. Idempotent: an open request is returned unchanged.',
  })
  request(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RequestAccountDeletionDto,
    @Req() req: Request,
  ) {
    return this.deletion.request(user, dto.password, meta(req));
  }

  @Post('cancel')
  @Public()
  @CredentialThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a pending account deletion with phone and password' })
  cancel(@Body() dto: CancelAccountDeletionDto, @Req() req: Request) {
    return this.deletion.cancel(dto.phone, dto.password, meta(req));
  }
}

/**
 * Administrator recovery for erasures that stopped after repeated failures.
 * Admin-only, every change audited with a reason, and limited to those
 * requests: a normal pending deletion cannot be touched from here. The list
 * returns ids, timings and the error class only - no name, phone or email.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/account-deletions')
export class AccountDeletionAdminController {
  constructor(private readonly deletion: AccountDeletionService) {}

  @Get('attention')
  @AdminOnly()
  @ApiOperation({ summary: 'Deletion requests whose erasure stopped after repeated failures' })
  attention() {
    return this.deletion.listNeedingAttention();
  }

  @Get('settlements')
  @AdminOnly()
  @ApiOperation({
    summary: 'Deletion requests holding for physical settlement (wallet not empty)',
    description:
      "Unlike the attention list, these rows include the holder's name and phone: nothing has been erased yet, and the administrator must identify the person to settle with. The live wallet balance is the authoritative amount to clear — but not automatically the amount owed: each row carries the lifetime ledger totals by type, and any non-refundable portion (e.g. an administrative goodwill credit) is removed first through the audited wallet adjustment before the remainder is settled here.",
  })
  settlements() {
    return this.deletion.listPendingSettlements();
  }

  @Post(':id/confirm-settlement')
  @AdminOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm that the remaining balance was settled physically outside the app',
    description:
      'The stated amount must equal the current wallet balance — partial settlements are rejected on purpose (remove any non-refundable portion first via the audited wallet adjustment, so every pound ends in one explicit ledger line). Records a REFUND/ADMIN ledger debit with the actor, offline method and reference; refuses a duplicate confirmation; no online refund is performed or implied. Erasure resumes at the next sweep.',
  })
  confirmSettlement(
    @Param('id') id: string,
    @Body() dto: ConfirmSettlementDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.deletion.confirmSettlement(
      id,
      actor,
      { amount: dto.amount, method: dto.method, reference: dto.reference, reason: dto.reason },
      meta(req),
    );
  }

  @Post(':id/retry')
  @AdminOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Re-queue a failed erasure (the holder still wants deletion)' })
  retry(
    @Param('id') id: string,
    @Body() dto: RecoverAccountDeletionDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.deletion.retryFailed(id, actor, dto.reason, meta(req));
  }

  @Post(':id/cancel')
  @AdminOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Cancel a failed erasure at the account holder's confirmed request" })
  cancel(
    @Param('id') id: string,
    @Body() dto: RecoverAccountDeletionDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.deletion.cancelFailed(id, actor, dto.reason, meta(req));
  }
}

function meta(req: Request): RequestMeta {
  return {
    ip: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
    requestId: req.requestId ?? null,
    device: (req.deviceContext ?? {
      deviceKey: null,
      platform: null,
      model: null,
      name: null,
      osVersion: null,
      appVersion: null,
      appBuild: null,
      integritySuspect: false,
    }) as DeviceContext,
  };
}
