import { Module } from '@nestjs/common';

import { MasterController } from './master.controller';

@Module({
  controllers: [MasterController],
})
export class MasterModule {}
