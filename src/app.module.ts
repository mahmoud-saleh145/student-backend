import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';

import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { ResilientThrottlerStorage } from './common/guards/resilient-throttler.storage';
import { ThrottlerProxyGuard } from './common/guards/throttler-proxy.guard';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { ConfigModule } from './config/config.module';
import type { RedisConfig, ThrottleConfig } from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { JobsModule } from './jobs/jobs.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AttachmentsModule } from './modules/attachments/attachments.module';
import { AuditInterceptor } from './modules/audit/audit.interceptor';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { CodesModule } from './modules/codes/codes.module';
import { CoursePartsModule } from './modules/course-parts/course-parts.module';
import { CoursesModule } from './modules/courses/courses.module';
import { DevicesModule } from './modules/devices/devices.module';
import { EnrollmentsModule } from './modules/enrollments/enrollments.module';
import { HomeModule } from './modules/home/home.module';
import { LessonsModule } from './modules/lessons/lessons.module';
import { LibraryModule } from './modules/library/library.module';
import { MasterModule } from './modules/master/master.module';
import { MetaModule } from './modules/meta/meta.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { PlaybackModule } from './modules/playback/playback.module';
import { ProgressModule } from './modules/progress/progress.module';
import { SearchModule } from './modules/search/search.module';
import { SectionsModule } from './modules/sections/sections.module';
import { SecurityModule } from './modules/security/security.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { SettingsModule } from './modules/settings/settings.module';
import { StorageModule } from './modules/storage/storage.module';
import { SubjectsModule } from './modules/subjects/subjects.module';
import { SupportModule } from './modules/support/support.module';
import { UsersModule } from './modules/users/users.module';
import { VideosModule } from './modules/videos/videos.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { RedisModule } from './redis/redis.module';

/**
 * Application root.
 *
 * Composition notes worth knowing before changing anything here:
 *
 * **Guard order matters.** Nest runs `APP_GUARD` providers in declaration
 * order. Throttling runs first so a flood of unauthenticated requests is
 * rejected before it costs a database round-trip in the auth guard. Then
 * authentication, then role authorization — a request must be *identified*
 * before its role can be checked.
 *
 * **Everything is protected by default.** `JwtAuthGuard` is global; a route is
 * only public if it carries `@Public()`. This is the safe direction to fail:
 * forgetting a decorator makes an endpoint unreachable rather than open. (Spec
 * §94: the mobile app is not trusted, so nothing may depend on the client
 * choosing not to call something.)
 *
 * **Rate limiting is Redis-backed in production.** The in-memory storage
 * default gives each replica its own counter, so an N-replica deployment
 * silently allows N× the configured limit — which is exactly wrong for the
 * login endpoint. When Redis is configured the throttler shares state.
 *
 * **`AuditInterceptor` is global but opt-in.** It only writes a row for routes
 * carrying `@Audit(...)`, so read traffic does not generate audit noise while
 * every decorated administrative mutation is recorded without the service
 * having to remember.
 */
@Module({
  imports: [
    // --- infrastructure (all @Global) ---------------------------------------
    ConfigModule,
    DatabaseModule,
    RedisModule,

    // --- rate limiting ------------------------------------------------------
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: async (config: ConfigService) => {
        const throttle = config.getOrThrow<ThrottleConfig>('throttle');
        const redis = config.getOrThrow<RedisConfig>('redis');

        // ONE throttler, not two.
        //
        // There used to be a second named `auth` throttler here, on the theory
        // that credential routes could opt into it with `@Throttle({ auth })`.
        // Nothing ever did — and `ThrottlerGuard` does not wait to be asked: it
        // loops over every configured throttler and applies each one unless a
        // route explicitly skips it by name. So the `auth` bucket was not a
        // stricter option available to login; it was a second ceiling on the
        // entire API, and the lower of the two always won.
        //
        // Two consequences, both live in production:
        //
        //  1. The real global limit was THROTTLE_AUTH_LIMIT (10/min), not
        //     THROTTLE_LIMIT (120/min). A dashboard screen that fires a dozen
        //     queries on load was one page refresh away from 429s.
        //  2. Every single request cost **two** Redis round trips instead of
        //     one, because each throttler increments its own key. On Upstash,
        //     where the bill is per request, that doubled the cost of every
        //     call the platform makes.
        //
        // The tight credential limit still exists — it now lives on the four
        // routes it was written for (see `CREDENTIAL_THROTTLE`), applied to
        // this same throttler so there is still only one key per request.
        const throttlers = [
          { name: 'default', ttl: throttle.ttl * 1000, limit: throttle.limit },
        ];

        // Redis storage is loaded lazily and optionally: local development
        // without Redis still boots, it just counts per-process.
        try {
          const { ThrottlerStorageRedisService } = (await import(
            '@nest-lab/throttler-storage-redis'
          )) as typeof import('@nest-lab/throttler-storage-redis');

          return {
            throttlers,
            // Wrapped so a Redis outage degrades the rate limiter instead of
            // the API. See ResilientThrottlerStorage — an unavailable store
            // used to surface as a 500 on every route, which both clients
            // then retried.
            storage: new ResilientThrottlerStorage(
              new ThrottlerStorageRedisService(redis.url),
            ),
          };
        } catch {
          return { throttlers };
        }
      },
    }),

    // --- cross-cutting domains ----------------------------------------------
    AuditModule,
    SecurityModule,
    SettingsModule,
    StorageModule,

    // --- identity ------------------------------------------------------------
    AuthModule,
    UsersModule,
    DevicesModule,
    SessionsModule,

    // --- academic structure ---------------------------------------------------
    CatalogModule,
    SubjectsModule,

    // --- content --------------------------------------------------------------
    CoursesModule,
    SectionsModule,
    LessonsModule,
    VideosModule,
    AttachmentsModule,
    PlaybackModule,

    // --- commerce -------------------------------------------------------------
    EnrollmentsModule,
    PaymentsModule,
    CodesModule,
    // Registered after CodesModule: recharge codes are generated there and
    // spent here, and keeping the credit ledger in one module means every
    // paid feature debits through the same audited path.
    WalletModule,
    // After WalletModule and EnrollmentsModule, both of which it uses: a part
    // is granted through the ordinary enrollment path, not a parallel one.
    CoursePartsModule,
    // The Library is the one subsystem that spends wallet credits. It is
    // deliberately independent of every course module above it.
    LibraryModule,

    // --- engagement -----------------------------------------------------------
    ProgressModule,
    NotificationsModule,
    SupportModule,
    HomeModule,
    SearchModule,

    // --- back office ----------------------------------------------------------
    AnalyticsModule,
    MasterModule,
    MetaModule,

    // --- async work -----------------------------------------------------------
    JobsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerProxyGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Assigns the request id, parses the device headers and captures the
    // client IP before any guard runs — the auth guard and the security-event
    // recorder both read from that context.
    consumer
      .apply(RequestContextMiddleware)
      .forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}
