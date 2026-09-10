import { Global, Module } from '@nestjs/common';

import { PlatformSettingsService } from './platform-settings.service';
import { SettingsController } from './settings.controller';

/**
 * Global because the settings this holds are consulted deep inside other
 * domains — the device limit during login, the teacher switches on every
 * content mutation — and threading an import through half the module graph to
 * reach a cached key/value read is noise, not architecture.
 */
@Global()
@Module({
  controllers: [SettingsController],
  providers: [PlatformSettingsService],
  exports: [PlatformSettingsService],
})
export class SettingsModule {}
