import { Body, Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '../../common/decorators/public.decorator';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';

import {
  GumletWebhookEvent,
  GumletWebhookService,
} from './gumlet-webhook.service';

/**
 * Public endpoint receiving Gumlet asset-lifecycle callbacks.
 *
 * `@Public` because the provider cannot present a user token - it presents a
 * signed body instead, which `GumletWebhookService.verifySignature` checks with a
 * constant-time HMAC comparison before anything is trusted.
 *
 * The signature is verified against `req.rawBody`, not the parsed JSON. Nest is
 * configured with `rawBody: true` in `main.ts` for exactly this reason: JSON
 * re-serialisation changes whitespace and key order, which would break the HMAC.
 *
 * Always answers 200 for a valid signature, including for events it ignores.
 * Returning 5xx would make Gumlet retry an event that will never become
 * actionable, and a permanently failing webhook eventually gets disabled.
 */
@ApiTags('webhooks')
@ApiExcludeController()
@Controller('webhooks')
export class GumletWebhookController {
  constructor(private readonly webhooks: GumletWebhookService) {}

  @Post('gumlet/assets')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Gumlet asset lifecycle events (signed)' })
  async handle(
    @Body() body: GumletWebhookEvent,
    @Headers('x-gumlet-signature') signature: string | undefined,
    @Req() req: Request & { rawBody?: Buffer },
  ): Promise<{ received: true; matched: boolean; action: string }> {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(body ?? {}), 'utf8');

    // Verify BEFORE trusting anything in the body.
    if (!this.webhooks.verifySignature(raw, signature)) {
      throw new AppException(ErrorCode.FORBIDDEN, { message: 'Invalid webhook signature' });
    }

    const result = await this.webhooks.handle(body ?? {});

    return { received: true, matched: result.matched, action: result.action };
  }
}