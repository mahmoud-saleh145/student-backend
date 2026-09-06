import { Controller, Get, Headers } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../../common/decorators/public.decorator';
import type {
  AppConfig,
  DeviceConfig,
  PlaybackConfig,
  VideoConfig,
} from '../../config/configuration';
import { PrismaService } from '../../database/prisma.service';

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
    const device = this.config.getOrThrow<DeviceConfig>('device');
    const video = this.config.getOrThrow<VideoConfig>('video');

    const settings = await this.prisma.platformSetting.findMany({
      where: { key: { in: ['minimumAppVersion', 'maintenanceMode', 'supportContacts'] } },
    });

    const byKey = new Map(settings.map((s) => [s.key, s.value]));

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
        limitPerStudent: device.limitPerStudent,
        // Tells the app whether to refuse protected playback when its native
        // protection module is unavailable.
        requiresSecureSurface: true,
      },

      features: {
        selfServicePasswordReset: false,
        otpRegistration: false,
        codeRedemption: true,
      },

      support: (byKey.get('supportContacts') as Record<string, string>) ?? {},

      // Echoed so a client can confirm the header reached us intact.
      callerAppVersion: appVersion ?? null,
    };
  }
}
