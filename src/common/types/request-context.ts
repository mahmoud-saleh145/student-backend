import type { UserRole } from '@prisma/client';

/** Identity attached to a request by JwtAuthGuard. */
export interface AuthenticatedUser {
  id: string;
  role: UserRole;
  phone: string;
  fullName: string;
  sessionId: string;
  /** Database Device.id when the request came from a known device. */
  deviceId: string | null;
  /** Raw device key from the X-Device-Id header, present even when unbound. */
  deviceKey: string | null;
  status: string;
}

/** Device descriptor parsed from request headers by DeviceContextMiddleware. */
export interface DeviceContext {
  deviceKey: string | null;
  platform: string | null;
  model: string | null;
  name: string | null;
  osVersion: string | null;
  appVersion: string | null;
  appBuild: string | null;
  integritySuspect: boolean;
}

declare module 'express' {
  interface Request {
    user?: AuthenticatedUser;
    deviceContext?: DeviceContext;
    requestId?: string;
    locale?: 'en' | 'ar';
  }
}

export {};
