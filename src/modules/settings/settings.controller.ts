import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsObject } from 'class-validator';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminOnly } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/request-context';

import { PlatformSettingsService, SETTING_KEYS } from './platform-settings.service';

class UpdateSettingsDto {
  /**
   * A partial map of `key -> value`. Validation is per-key in the service,
   * because each setting has its own shape and range; a blanket DTO could
   * only check that this is an object.
   */
  @IsObject()
  settings!: Record<string, unknown>;
}

/**
 * Platform settings for the admin dashboard.
 *
 * This sits alongside — not instead of — `PUT /master/settings`, which stays
 * master-only and can write any arbitrary key (minimumAppVersion,
 * maintenanceMode, …). This controller exposes the curated, validated subset
 * the dashboard renders as switches and fields, and admits regular admins,
 * because device limits and contact details are day-to-day operations rather
 * than platform-owner ones.
 *
 * Every value here is enforced server-side at the point of use. The dashboard
 * hides a control when a switch is off; the backend refuses the request
 * regardless of what the dashboard showed.
 */
@ApiTags('admin')
@ApiBearerAuth('access-token')
@Controller('admin/settings')
export class SettingsController {
  constructor(private readonly settings: PlatformSettingsService) {}

  @Get()
  @AdminOnly()
  @ApiOperation({
    summary: 'Read the dashboard-editable platform settings',
    description:
      'Always returns every known key. A key with no stored row reads as its default, which is the behaviour the platform had before settings existed.',
  })
  async read() {
    return {
      keys: SETTING_KEYS,
      settings: await this.settings.getAll(),
    };
  }

  @Put()
  @AdminOnly()
  @ApiOperation({
    summary: 'Update platform settings',
    description:
      'Partial update. Unknown keys and out-of-range values are rejected with per-field messages rather than silently ignored.',
  })
  async update(@Body() dto: UpdateSettingsDto, @CurrentUser() actor: AuthenticatedUser) {
    const settings = await this.settings.update(dto.settings, actor);
    return { keys: SETTING_KEYS, settings };
  }
}
