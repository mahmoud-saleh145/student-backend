import { Module } from '@nestjs/common';

import { HealthController } from '../health/health.controller';

import { MetaController } from './meta.controller';

@Module({
  controllers: [MetaController, HealthController],
})
export class MetaModule {}
