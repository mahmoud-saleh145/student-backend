import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { AuthThrottle } from '../../common/decorators/throttle.decorator';
import type { AuthenticatedUser, DeviceContext } from '../../common/types/request-context';
import { UsersService } from '../users/users.service';

import { AuthService, type RequestMeta } from './auth.service';
import { ChangePasswordDto, LoginDto, RefreshDto, RegisterDto } from './dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
  ) {}

  // ---------------------------------------------------------------------------
  // Public
  // ---------------------------------------------------------------------------

  @Post('register')
  @Public()
  @AuthThrottle()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Register a student account',
    description:
      'Creates a STUDENT account and an authenticated session. The role is never read from the request body. There is no OTP step in this product.',
  })
  @ApiResponse({ status: 201, description: '{ user, accessToken, refreshToken, expiresIn }' })
  @ApiResponse({ status: 409, description: 'PHONE_ALREADY_REGISTERED' })
  @ApiResponse({ status: 422, description: 'VALIDATION_ERROR with per-field messages' })
  register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.auth.register(dto, meta(req));
  }

  @Post('login')
  @Public()
  @AuthThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in',
    description:
      'Device binding does not block sign-in — only protected content. The response includes a `device` block describing the binding state.',
  })
  @ApiResponse({ status: 200, description: '{ user, accessToken, refreshToken, expiresIn }' })
  @ApiResponse({ status: 401, description: 'INVALID_CREDENTIALS' })
  @ApiResponse({ status: 403, description: 'ACCOUNT_DISABLED | ACCOUNT_PENDING' })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, meta(req));
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate tokens',
    description:
      'Single-use rotating refresh. Presenting an already-rotated token revokes the entire token family — the standard response to a suspected theft.',
  })
  @ApiResponse({ status: 200, description: '{ accessToken, refreshToken, expiresIn }' })
  @ApiResponse({ status: 401, description: 'SESSION_EXPIRED' })
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.auth.refresh(dto.refreshToken, meta(req));
  }

  // ---------------------------------------------------------------------------
  // Authenticated
  // ---------------------------------------------------------------------------

  @Post('logout')
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign out of the current session',
    description:
      'Revokes this session and its refresh tokens, releases any playback slot it held, and deactivates the push token for this device.',
  })
  logout(@CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.auth.logout(user.id, user.sessionId, meta(req));
  }

  @Post('logout-all')
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign out of every session' })
  logoutAll(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.logoutAll(user.id);
  }

  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Current user',
    description: 'Called on every cold start to revalidate the cached session.',
  })
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.users.toPublicUser(user.id);
  }

  @Get('session')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Describe the current session and its device binding',
  })
  session(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.describeSession(user.id, user.sessionId);
  }

  @Get('sessions')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'List the account’s active sessions' })
  sessions(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.listSessions(user.id);
  }

  @Post('password')
  @ApiBearerAuth('access-token')
  @AuthThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Change your own password',
    description:
      'Requires the current password. Every other session is revoked. Forgotten passwords are reset administratively — see PUT /admin/users/{id}/password.',
  })
  changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ) {
    return this.auth.changePassword(
      user.id,
      dto.currentPassword,
      dto.newPassword,
      meta(req),
    );
  }
}

/** Collects the per-request context the auth service needs. */
function meta(req: Request): RequestMeta {
  return {
    ip: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
    requestId: req.requestId ?? null,
    device: (req.deviceContext ?? emptyDevice()) as DeviceContext,
  };
}

function emptyDevice(): DeviceContext {
  return {
    deviceKey: null,
    platform: null,
    model: null,
    name: null,
    osVersion: null,
    appVersion: null,
    appBuild: null,
    integritySuspect: false,
  };
}
