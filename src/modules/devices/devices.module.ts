import { Module } from '@nestjs/common';

import { DevicesAdminController } from './devices.admin.controller';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';

@Module({
  controllers: [DevicesController, DevicesAdminController],
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
