import { Module } from '@nestjs/common';

import { NewVideoAnnouncerModule } from '../videos/new-video-announcer.module';

import { SectionsController } from './sections.controller';
import { SectionsService } from './sections.service';

@Module({
  // Publishing a section releases the "new video" notifications its lectures
  // were holding back.
  imports: [NewVideoAnnouncerModule],
  controllers: [SectionsController],
  providers: [SectionsService],
  exports: [SectionsService],
})
export class SectionsModule {}
