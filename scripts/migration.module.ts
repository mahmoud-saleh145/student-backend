import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { configurations } from '../src/config/configuration';
import { PrismaService } from '../src/database/prisma.service';
import { CloudinaryService } from '../src/modules/storage/cloudinary.service';
import { StorageService } from '../src/modules/storage/storage.service';
import { GumletDrmService } from '../src/modules/playback/gumlet-drm.service';
import { DrmVerificationService } from '../src/modules/playback/drm-verification.service';
import { GumletIngestService } from '../src/modules/videos/gumlet-ingest.service';
import { GumletMigrationService } from '../src/modules/videos/gumlet-migration.service';

/**
 * A deliberately small module for the one-shot migration CLI.
 *
 * It provides exactly what `GumletMigrationService` needs and nothing else. The
 * real `AppModule` is NOT imported on purpose: it would start the transcode
 * workers, the maintenance scheduler and the Redis connection, all of which are
 * undesirable for a one-shot operator command and none of which the migration
 * reads from.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: configurations,
      cache: true,
    }),
  ],
  providers: [
    PrismaService,
    CloudinaryService,
    StorageService,
    GumletDrmService,
    DrmVerificationService,
    GumletIngestService,
    GumletMigrationService,
  ],
  exports: [GumletMigrationService],
})
export class MigrationModule {}