import 'source-map-support/register';

import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { AppException } from './common/errors/app.exception';
import { ErrorCode } from './common/errors/error-codes';
import type { AppConfig } from './config/configuration';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    // The raw body is needed to verify payment-provider webhook signatures.
    rawBody: true,
  });

  const config = app.get(ConfigService);
  const cfg = config.getOrThrow<AppConfig>('app');
  const logger = new Logger('Bootstrap');

  // ---------------------------------------------------------------------------
  // Transport hardening
  // ---------------------------------------------------------------------------

  if (cfg.trustProxy) {
    // Only enable behind a balancer that overwrites X-Forwarded-For, otherwise
    // clients can spoof their IP and defeat rate limiting.
    app.set('trust proxy', 1);
  }

  app.use(
    helmet({
      // This API serves JSON and signed redirects, never HTML, so the
      // browser-oriented policies are set conservatively and CSP is off.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: cfg.isProduction
        ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
        : false,
    }),
  );

  app.use(compression());
  app.disable('x-powered-by');

  // ---------------------------------------------------------------------------
  // CORS
  //
  // Native apps send no Origin header, so they are unaffected by this. The
  // allow-list exists for the admin dashboard and local tooling.
  // ---------------------------------------------------------------------------
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (cfg.corsOrigins.includes(origin)) return callback(null, true);
      if (!cfg.isProduction && /^http:\/\/localhost(:\d+)?$/.test(origin)) {
        return callback(null, true);
      }
      callback(new Error(`Origin ${origin} is not allowed by CORS`), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Accept',
      'Accept-Language',
      'X-Request-Id',
      'X-Client',
      'X-Device-Id',
      'X-Device-Platform',
      'X-Device-Model',
      'X-Device-Name',
      'X-Device-Os',
      'X-Device-Integrity',
      'X-App-Version',
      'X-App-Build',
      'Idempotency-Key',
    ],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 86_400,
  });

  // ---------------------------------------------------------------------------
  // Routing: /api/v1/...
  // ---------------------------------------------------------------------------
  app.setGlobalPrefix(cfg.apiPrefix);
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: cfg.apiVersion,
  });

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------
  app.useGlobalPipes(
    new ValidationPipe({
      // Strip unknown properties instead of trusting them — this is what stops
      // a client from setting `role: "MASTER"` on a registration payload.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      stopAtFirstError: false,
      validationError: { target: false, value: false },
      exceptionFactory: (errors) => {
        const fields: Record<string, string[]> = {};
        const walk = (list: typeof errors, prefix = '') => {
          for (const error of list) {
            const path = prefix ? `${prefix}.${error.property}` : error.property;
            const messages = Object.values(error.constraints ?? {});
            if (messages.length) fields[path] = messages;
            if (error.children?.length) walk(error.children, path);
          }
        };
        walk(errors);

        return new AppException(ErrorCode.VALIDATION_ERROR, {
          message: 'Request validation failed',
          fields,
        });
      },
    }),
  );

  // ---------------------------------------------------------------------------
  // Cross-cutting response handling
  // ---------------------------------------------------------------------------
  app.useGlobalInterceptors(new ResponseInterceptor(app.get(Reflector)));
  app.useGlobalFilters(new AllExceptionsFilter(cfg.isProduction));

  // ---------------------------------------------------------------------------
  // OpenAPI
  // ---------------------------------------------------------------------------
  if (!cfg.isProduction || process.env.ENABLE_SWAGGER === 'true') {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('EduPlatform API')
        .setDescription(
          [
            'Backend for the EduPlatform student mobile app and the future admin dashboard.',
            '',
            '**Envelope.** Success: `{ success, data, meta }`. Errors carry both the',
            'nested `error` object and flat `code`/`message`/`errors` fields — see',
            'docs/API_CONTRACT.md for why.',
            '',
            '**Errors.** Clients branch on `code`, never on `message`.',
            '',
            '**Device headers.** Every authenticated request must send `X-Device-Id`;',
            'protected playback is refused without a bound device.',
          ].join('\n'),
        )
        .setVersion('1.0.0')
        .addBearerAuth(
          { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          'access-token',
        )
        .addGlobalParameters({
          name: 'X-Device-Id',
          in: 'header',
          required: false,
          schema: { type: 'string' },
          description: 'Stable device identity used for device binding.',
        })
        .addTag('auth', 'Registration, login, tokens, sessions')
        .addTag('catalog', 'Universities, faculties, departments, academic years')
        .addTag('courses', 'Course discovery and management')
        .addTag('sections', 'Dynamic course structure')
        .addTag('lessons', 'Lessons and completion')
        .addTag('videos', 'Video upload and processing')
        .addTag('playback', 'Protected playback authorization')
        .addTag('enrollments', 'Join course and access management')
        .addTag('payments', 'Payments, revenue, refunds')
        .addTag('codes', 'Access codes')
        .addTag('devices', 'Device binding')
        .addTag('progress', 'Watch progress and analytics events')
        .addTag('notifications', 'Notifications and push')
        .addTag('attachments', 'Protected course materials')
        .addTag('search', 'Search')
        .addTag('analytics', 'Reporting')
        .addTag('audit', 'Audit trail')
        .addTag('admin', 'Administrative operations')
        .addTag('master', 'Platform owner operations')
        .addTag('meta', 'Health and client configuration')
        .build(),
      { operationIdFactory: (_c, method) => method },
    );

    SwaggerModule.setup(`${cfg.apiPrefix}/docs`, app, document, {
      swaggerOptions: { persistAuthorization: true, tagsSorter: 'alpha' },
      customSiteTitle: 'EduPlatform API',
      jsonDocumentUrl: `${cfg.apiPrefix}/docs-json`,
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------
  app.enableShutdownHooks();

  await app.listen(cfg.port, '0.0.0.0');

  logger.log(`API listening on :${cfg.port} (${cfg.env})`);
  logger.log(`Base path  /${cfg.apiPrefix}/v${cfg.apiVersion}`);
  if (!cfg.isProduction) {
    logger.log(`Swagger    http://localhost:${cfg.port}/${cfg.apiPrefix}/docs`);
  }
}

void bootstrap().catch((error) => {
  // The config layer throws here when a required secret is missing. Failing
  // loudly at boot is the intended behaviour.
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', error);
  process.exit(1);
});
