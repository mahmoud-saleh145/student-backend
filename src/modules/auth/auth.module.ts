import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import { DevicesModule } from '../devices/devices.module';
import { UsersModule } from '../users/users.module';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

/**
 * Global because JwtAuthGuard (registered app-wide) needs JwtService, and
 * several domains need PasswordService/TokenService without importing the
 * whole auth surface.
 */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // Per-call secrets are always passed explicitly by TokenService, since
        // this module signs three different token types with three secrets.
        secret: config.getOrThrow<string>('auth.accessSecret'),
        signOptions: {
          issuer: config.getOrThrow<string>('auth.issuer'),
          audience: config.getOrThrow<string>('auth.audience'),
        },
      }),
    }),
    UsersModule,
    DevicesModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, TokenService, PasswordService],
  exports: [AuthService, TokenService, PasswordService, JwtModule],
})
export class AuthModule {}
