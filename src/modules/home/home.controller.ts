import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser, Locale } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/request-context';

import { HomeService } from './home.service';

@ApiTags('courses')
@ApiBearerAuth('access-token')
@Controller('home')
export class HomeController {
  constructor(private readonly home: HomeService) {}

  @Get('feed')
  @ApiOperation({
    summary: 'Student dashboard in one request',
    description:
      'Continue watching, my courses, new and recommended courses, announcements and counters. One call because six parallel requests from a phone on a slow connection is the worst possible first-launch experience.',
  })
  feed(@CurrentUser() user: AuthenticatedUser, @Locale() locale: 'en' | 'ar') {
    return this.home.feed(user.id, locale);
  }
}
