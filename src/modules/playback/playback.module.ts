import { Module } from '@nestjs/common';

import { DevicesModule } from '../devices/devices.module';
import { ManifestController } from './manifest.controller';
import { ManifestService } from './manifest.service';
import { MediaOriginController } from './media-origin.controller';
import { PlaybackController } from './playback.controller';
import { PlaybackService } from './playback.service';

@Module({
  imports: [DevicesModule],

  // MediaOriginController is registered last so its `playback/media/*`
  // wildcard cannot shadow the specific playback and manifest routes.
  controllers: [PlaybackController, ManifestController, MediaOriginController],
  providers: [PlaybackService, ManifestService],
  exports: [PlaybackService, ManifestService],
})
export class PlaybackModule { }