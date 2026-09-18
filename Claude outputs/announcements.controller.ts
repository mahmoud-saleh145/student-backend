import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminOnly } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/request-context';

import { AnnouncementsService } from './announcements.service';
import {
  CreateScheduledAnnouncementDto,
  ListAnnouncementsDto,
  PreviewAudienceDto,
  UpdateScheduledAnnouncementDto,
} from './dto/announcement.dto';

/**
 * Announcement authoring.
 *
 * `@AdminOnly()` throughout. A teacher can already notify their own course's
 * students through the course routes; reaching an arbitrary audience is a
 * platform-wide power and is not delegated.
 *
 * The two legacy endpoints on `NotificationsController` are left in place and
 * still work — they write the same rows, and an announcement created either way
 * is dispatched by the same path.
 */
@ApiTags('admin')
@ApiBearerAuth('access-token')
@Controller('admin/announcements')
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Post('preview')
  @AdminOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'How many people a rule would reach',
    description:
      'Writes nothing and sends nothing. Returns the recipient count, a small sample of names to sanity-check the rule, whether the rule filters on anything at all, and whether it exceeds the send limit. An audience builder without a dry run is how the wrong message reaches everyone.',
  })
  preview(@Body() dto: PreviewAudienceDto) {
    return this.announcements.preview(dto.audience);
  }

  @Get()
  @AdminOnly()
  @ApiOperation({ summary: 'Announcements, newest first' })
  list(@Query() query: ListAnnouncementsDto) {
    return this.announcements.list({
      page: query.page,
      pageSize: query.pageSize,
      status: query.status,
    });
  }

  @Get(':id')
  @AdminOnly()
  @ApiOperation({
    summary: 'One announcement with its dispatch history',
    description:
      'Each dispatch row is one occurrence that was claimed, with how many people it reached and any error. A recurring announcement accumulates one row per send.',
  })
  detail(@Param('id') id: string) {
    return this.announcements.detail(id);
  }

  @Post()
  @AdminOnly()
  @ApiOperation({
    summary: 'Create an announcement, scheduled or immediate',
    description:
      'The audience is stored as a rule and re-evaluated at every send, so a recurring announcement reaches whoever matches on the day it fires. Omit sendAtLocal to save a draft; set sendNow to dispatch inline and get the recipient count back in the response.',
  })
  create(
    @Body() dto: CreateScheduledAnnouncementDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.announcements.create(
      {
        ...dto,
        startsOn: dto.startsOn ? new Date(dto.startsOn) : undefined,
        endsOn: dto.endsOn ? new Date(dto.endsOn) : undefined,
      },
      actor,
    );
  }

  @Patch(':id')
  @AdminOnly()
  @ApiOperation({
    summary: 'Edit an announcement that has not been sent',
    description:
      'Refused once it has sent even once: the text is what people received, and editing it afterwards would make the record disagree with every inbox holding it. Cancel and create a new one instead.',
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateScheduledAnnouncementDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.announcements.update(
      id,
      {
        ...dto,
        startsOn: dto.startsOn ? new Date(dto.startsOn) : undefined,
        endsOn: dto.endsOn ? new Date(dto.endsOn) : undefined,
      },
      actor,
    );
  }

  @Delete(':id')
  @AdminOnly()
  @ApiOperation({
    summary: 'Stop future occurrences',
    description:
      'Notifications already delivered are untouched — they belong to the students who received them. Only the schedule stops.',
  })
  cancel(@Param('id') id: string) {
    return this.announcements.cancel(id);
  }

  @Post(':id/send-now')
  @AdminOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Dispatch an occurrence immediately',
    description:
      'Claims the occurrence first, exactly as the scheduler does, so pressing this twice sends once.',
  })
  sendNow(@Param('id') id: string) {
    return this.announcements.dispatch(id, new Date());
  }
}
