import { Controller, Get, Headers } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../../common/decorators/public.decorator';
import type { AppConfig, PlaybackConfig, VideoConfig } from '../../config/configuration';
import { PrismaService } from '../../database/prisma.service';
import { PlatformSettingsService } from '../settings/platform-settings.service';

/**
 * Client configuration.
 *
 * Lets the app learn the platform's operational parameters instead of
 * hardcoding them — heartbeat cadence, ticket TTL, the minimum supported
 * build, support contacts. Changing any of these becomes a server-side change
 * rather than an app-store release.
 *
 * Nothing secret is exposed: these are values the client already needs in
 * order to behave correctly.
 */
@ApiTags('meta')
@Controller('meta')
export class MetaController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly platformSettings: PlatformSettingsService,
  ) {}

  @Get('app-config')
  @Public()
  @ApiOperation({
    summary: 'Runtime configuration for the mobile client',
    description:
      'Poll on launch. Returning a minimumVersion above the caller’s build is how a forced upgrade is signalled; individual endpoints answer 426 APP_UPDATE_REQUIRED once it applies.',
  })
  async appConfig(@Headers('x-app-version') appVersion?: string) {
    const app = this.config.getOrThrow<AppConfig>('app');
    const playback = this.config.getOrThrow<PlaybackConfig>('playback');
    const video = this.config.getOrThrow<VideoConfig>('video');

    const settings = await this.prisma.platformSetting.findMany({
      where: { key: { in: ['minimumAppVersion', 'maintenanceMode', 'supportContacts'] } },
    });

    const byKey = new Map(settings.map((s) => [s.key, s.value]));

    const [deviceLimit, contacts, allowAcademicYearChange] = await Promise.all([
      this.platformSettings.deviceLimit(),
      this.platformSettings.contacts(),
      this.platformSettings.allowsAcademicYearChange(),
    ]);

    return {
      environment: app.env,
      minimumAppVersion: (byKey.get('minimumAppVersion') as string) ?? '1.0.0',
      maintenanceMode: (byKey.get('maintenanceMode') as boolean) ?? false,

      playback: {
        ticketTtlSeconds: playback.ticketTtl,
        heartbeatIntervalSeconds: playback.heartbeatInterval,
        maxConcurrentStreams: playback.maxConcurrentStreams,
        drmEnabled: video.drm.enabled,
        qualityLadder: video.ladder.map((h) => `${h}p`),
      },

      device: {
        // Read through the settings service so the number the app is told
        // matches the number the login path actually enforces.
        limitPerStudent: deviceLimit,
        // Tells the app whether to refuse protected playback when its native
        // protection module is unavailable.
        requiresSecureSurface: true,
      },

      features: {
        selfServicePasswordReset: false,
        otpRegistration: false,
        codeRedemption: true,
        // New capability flags. The shipped app ignores unknown keys, so this
        // is additive; a future build can gate its UI on them.
        academicYearSelfService: allowAcademicYearChange,
        supportTickets: true,
      },

      // `supportContacts` (the original master-only free-form key) still wins
      // when it is set, so nothing an operator configured earlier is lost. The
      // dashboard-managed contact fields fill in whatever it does not cover.
      support: {
        ...contacts,
        ...((byKey.get('supportContacts') as Record<string, string>) ?? {}),
      },

      // Echoed so a client can confirm the header reached us intact.
      callerAppVersion: appVersion ?? null,
    };
  }
}
