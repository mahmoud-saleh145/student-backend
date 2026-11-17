import { Module } from '@nestjs/common';

import { NewVideoAnnouncerModule } from '../videos/new-video-announcer.module';

import { LessonsController } from './lessons.controller';
import { LessonsService } from './lessons.service';

@Module({
  // Publishing a lesson releases the "new video" notification its lecture has
  // been holding back while it was a draft.
  imports: [NewVideoAnnouncerModule],
  controllers: [LessonsController],
  providers: [LessonsService],
  exports: [LessonsService],
})
export class LessonsModule {}
