import { Module } from '@nestjs/common';

import { DevicesModule } from '../devices/devices.module';
import { GumletDrmService } from './gumlet-drm.service';
import { DrmVerificationService } from './drm-verification.service';
import { DrmVerificationSweepService } from './drm-verification-sweep.service';
import { DrmVerificationScheduler } from './drm-verification-scheduler.service';
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
  providers: [
    PlaybackService,
    ManifestService,
    GumletDrmService,
    DrmVerificationService,
    // Exported so the maintenance job that renews verification proofs can call
    // the sweep. It is the counterpart to DrmVerificationService: that service
    // decides whether a video is playable, this one decides when to re-ask.
    DrmVerificationSweepService,
    // Runs the sweep in-process under a Redis lock (no queue, no worker).
    DrmVerificationScheduler,
  ],
  exports: [
    PlaybackService,
    ManifestService,
    GumletDrmService,
    DrmVerificationService,
    DrmVerificationSweepService,
  ],
})
export class PlaybackModule { }
