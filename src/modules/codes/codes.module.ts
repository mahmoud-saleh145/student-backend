import { Module } from '@nestjs/common';

import { CodesController } from './codes.controller';
import { CodesService } from './codes.service';

@Module({
  controllers: [CodesController],
  providers: [CodesService],
  exports: [CodesService],
})
export class CodesModule {}
