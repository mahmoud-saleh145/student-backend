import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NotificationKind } from '@prisma/client';
import type { Job } from 'bullmq';

import type { NotificationConfig } from '../../config/configuration';
import { PrismaService } from '../../database/prisma.service';
import { NotificationsService } from '../../modules/notifications/notifications.service';
import { QUEUE_NAMES, type PushJobData } from '../queue.constants';

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

/**
 * Push delivery.
 *
 * Push is best-effort by design: the notification row is already written and
 * visible in the app's inbox before this job runs, so a failed push loses the
 * buzz, never the message.
 *
 * Three behaviours worth stating:
 *
 *  1. **Preferences are checked here, not at creation.** A student who turns
 *     off "new lessons" between the notification being created and the push
 *     being sent should not get the push. Checking at send time is also the
 *     only place that sees the final recipient list for a fan-out.
 *
 *  2. **Security notifications ignore preferences.** A device-change or
 *     suspicious-login alert must reach the student even if they muted
 *     everything else.
 *
 *  3. **Dead tokens are retired.** Expo reports `DeviceNotRegistered` when the
 *     app is uninstalled; three strikes and the token is deactivated, which
 *     keeps the send list from degrading into mostly-dead entries.
 */
@Processor(QUEUE_NAMES.push, { concurrency: 5 })
export class PushProcessor extends WorkerHost {
  private readonly logger = new Logger(PushProcessor.name);
  private readonly cfg: NotificationConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    config: ConfigService,
  ) {
    super();
    this.cfg = config.getOrThrow<NotificationConfig>('notification');
  }

  async process(job: Job<PushJobData>): Promise<unknown> {
    if (this.cfg.provider === 'none') {
      this.logger.debug('push provider disabled; skipping');
      return { skipped: true };
    }

    return job.data.type === 'single'
      ? this.sendSingle(job.data)
      : this.sendBulk(job.data);
  }

  private async sendSingle(data: Extract<PushJobData, { type: 'single' }>) {
    const notification = await this.prisma.notification.findUnique({
      where: { id: data.notificationId },
      select: {
        id: true,
        title: true,
        titleAr: true,
        body: true,
        bodyAr: true,
        route: true,
        kind: true,
        read: true,
      },
    });

    // Already read in-app before the push went out — don't buzz.
    if (!notification || notification.read) return { skipped: true };

    if (!(await this.allowedByPreferences(data.userId, notification.kind))) {
      return { skipped: 'preference' };
    }

    const user = await this.prisma.user.findUnique({
      where: { id: data.userId },
      select: { locale: true },
    });

    const arabic = user?.locale === 'ar';

    const tokens = await this.notifications.activeTokensFor([data.userId]);
    if (tokens.length === 0) return { skipped: 'no-token' };

    return this.deliver(
      tokens,
      {
        title: arabic && notification.titleAr ? notification.titleAr : notification.title,
        body: arabic && notification.bodyAr ? notification.bodyAr : notification.body,
        route: notification.route,
        notificationId: notification.id,
        kind: notification.kind,
      },
    );
  }

  private async sendBulk(data: Extract<PushJobData, { type: 'bulk' }>) {
    const allowed: string[] = [];

    // Load preferences in one query rather than per user.
    const prefs = await this.prisma.notificationPreference.findMany({
      where: { userId: { in: data.userIds } },
    });
    const prefByUser = new Map(prefs.map((p) => [p.userId, p]));
    const key = NotificationsService.preferenceKeyFor(data.kind);

    for (const userId of data.userIds) {
      if (!key) {
        allowed.push(userId);
        continue;
      }
      const pref = prefByUser.get(userId);
      // Absent preferences default to enabled.
      if (!pref || pref[key]) allowed.push(userId);
    }

    if (allowed.length === 0) return { sent: 0 };

    const tokens = await this.notifications.activeTokensFor(allowed);
    if (tokens.length === 0) return { sent: 0 };

    return this.deliver(tokens, {
      title: data.title,
      body: data.body,
      route: data.route ?? null,
      notificationId: null,
      kind: data.kind,
    });
  }

  private async allowedByPreferences(
    userId: string,
    kind: NotificationKind,
  ): Promise<boolean> {
    const key = NotificationsService.preferenceKeyFor(kind);
    if (!key) return true; // security / admin messages are never suppressed

    const prefs = await this.prisma.notificationPreference.findUnique({
      where: { userId },
    });
    return prefs ? prefs[key] : true;
  }

  private async deliver(
    tokens: { id: string; token: string; userId: string }[],
    payload: {
      title: string;
      body: string;
      route: string | null;
      notificationId: string | null;
      kind: NotificationKind;
    },
  ) {
    let sent = 0;
    let failed = 0;

    // Expo accepts up to 100 messages per request.
    for (let i = 0; i < tokens.length; i += this.cfg.batchSize) {
      const batch = tokens.slice(i, i + this.cfg.batchSize);

      const messages = batch.map((t) => ({
        to: t.token,
        title: payload.title,
        body: payload.body,
        sound: 'default',
        priority: 'high',
        channelId: this.channelFor(payload.kind),
        data: {
          route: payload.route,
          notificationId: payload.notificationId,
          kind: payload.kind,
        },
      }));

      try {
        const response = await fetch(this.cfg.expoApiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'Accept-Encoding': 'gzip, deflate',
            ...(this.cfg.expoAccessToken
              ? { Authorization: `Bearer ${this.cfg.expoAccessToken}` }
              : {}),
          },
          body: JSON.stringify(messages),
          signal: AbortSignal.timeout(15_000),
        });

        if (!response.ok) {
          this.logger.warn(`Expo push returned ${response.status}`);
          failed += batch.length;
          continue;
        }

        const result = (await response.json()) as { data?: ExpoTicket[] };
        const tickets = result.data ?? [];

        for (const [index, ticket] of tickets.entries()) {
          const target = batch[index];
          if (!target) continue;

          if (ticket.status === 'ok') {
            sent += 1;
            continue;
          }

          failed += 1;

          if (ticket.details?.error === 'DeviceNotRegistered') {
            // The app was uninstalled. Retire the token immediately rather
            // than after three strikes.
            await this.prisma.pushToken
              .update({ where: { id: target.id }, data: { isActive: false } })
              .catch(() => undefined);
          } else {
            await this.notifications.markTokenFailed(target.id).catch(() => undefined);
          }
        }
      } catch (e) {
        this.logger.warn(`push batch failed: ${(e as Error).message}`);
        failed += batch.length;
      }
    }

    this.logger.log(`push delivered ${sent}, failed ${failed}`);
    return { sent, failed };
  }

  /** Android notification channels created by the mobile app at startup. */
  private channelFor(kind: NotificationKind): string {
    switch (kind) {
      case 'NEW_LESSON':
      case 'NEW_VIDEO':
      case 'NEW_COURSE':
      case 'NEW_SECTION':
      case 'COURSE_UPDATE':
        return 'content';
      case 'PAYMENT':
      case 'ENROLLMENT':
      case 'SECURITY':
      case 'ADMIN':
        return 'account';
      default:
        return 'default';
    }
  }
}
