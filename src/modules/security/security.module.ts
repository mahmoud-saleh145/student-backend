import { Global, Module } from '@nestjs/common';

import { SecurityController } from './security.controller';
import { SecurityEventService } from './security-event.service';

@Global()
@Module({
  controllers: [SecurityController],
  providers: [SecurityEventService],
  exports: [SecurityEventService],
})
export class SecurityModule {}
