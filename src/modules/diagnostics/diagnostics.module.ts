import { Module } from '@nestjs/common';

import { ClientIpDiagnosticsController } from './client-ip-diagnostics.controller';

/** Read-only operator diagnostics (MASTER only). */
@Module({ controllers: [ClientIpDiagnosticsController] })
export class DiagnosticsModule {}
