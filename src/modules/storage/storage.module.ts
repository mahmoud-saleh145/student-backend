import { Global, Module } from '@nestjs/common';

import { CloudinaryService } from './cloudinary.service';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';

/**
 * Global: almost every domain needs to turn an object key into a URL
 * (thumbnails, avatars, captions), and threading the module import through
 * each one adds noise without adding isolation.
 *
 * CloudinaryService is exported for the same reason and is the only way a
 * course thumbnail should reach object storage — the R2 paths are for assets
 * that are private by design.
 */
@Global()
@Module({
  controllers: [StorageController],
  providers: [StorageService, CloudinaryService],
  exports: [StorageService, CloudinaryService],
})
export class StorageModule {}
