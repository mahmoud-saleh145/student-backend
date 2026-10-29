import { Controller, Get, Query, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { MasterOnly } from '../../common/decorators/roles.decorator';
import { describeClientIpChain } from '../../common/net/client-ip';

/**
 * Owner decision D6 follow-up: the number of proxies Render puts in front of
 * the API (`TRUST_PROXY_HOPS`) is not documented, and guessing it wrong either
 * lumps all anonymous mobile traffic into one rate-limit bucket (too few hops)
 * or lets a client choose its own address (too many).
 *
 * This read-only, MASTER-only endpoint shows how the platform delivered the
 * CALLER'S OWN request, so the hop count can be read off real evidence. It
 * changes nothing and is not used for attribution. Procedure:
 * docs/audit-2026-10-27/OWNER_DECISIONS.md, D6.
 *
 * `?expectedIp=` is the operator's own public address (for example from
 * https://api.ipify.org). It is only compared with the computed candidates; a
 * value that is not a single valid IP address is ignored.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/diagnostics')
export class ClientIpDiagnosticsController {
  constructor(private readonly config: ConfigService) {}

  @Get('client-ip')
  @MasterOnly()
  @ApiOperation({ summary: "How this request's client address reached the API (proxy-hop check)" })
  @ApiQuery({ name: 'expectedIp', required: false, description: 'Your own public IP address, to list the hop counts that resolve to it' })
  clientIp(@Req() req: Request, @Query('expectedIp') expectedIp?: string) {
    const app = this.config.get<{ trustProxy?: boolean; trustProxyHops?: number }>('app') ?? {};
    return describeClientIpChain(
      req,
      {
        trustProxy: app.trustProxy ?? false,
        trustProxyHops: app.trustProxyHops ?? 1,
      },
      { expectedIp: typeof expectedIp === 'string' ? expectedIp : null },
    );
  }
}
