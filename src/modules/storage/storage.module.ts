import { Global, Module } from '@nestjs/common';

import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';

/**
 * Global: almost every domain needs to turn an object key into a URL
 * (thumbnails, avatars, captions), and threading the module import through
 * each one adds noise without adding isolation.
 */
@Global()
@Module({
  controllers: [StorageController],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
