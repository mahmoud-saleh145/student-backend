import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

import type { DeviceContext } from '../types/request-context';

const SUPPORTED_LOCALES = new Set(['en', 'ar']);

/**
 * Parses the cross-cutting request metadata the mobile client sends on every
 * call, so no controller has to read raw headers.
 *
 * Header names match exactly what edu-mobile/src/services/device.ts sends.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header('x-request-id');
    req.requestId = incoming && incoming.length <= 64 ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.requestId);

    req.locale = this.resolveLocale(req.header('accept-language'));
    req.deviceContext = this.parseDevice(req);

    next();
  }

  private resolveLocale(header?: string): 'en' | 'ar' {
    if (!header) return 'en';
    // The app sends a bare code; browsers send a q-weighted list.
    for (const part of header.split(',')) {
      const tag = part.split(';')[0]?.trim().toLowerCase() ?? '';
      const base = tag.split('-')[0] ?? '';
      if (SUPPORTED_LOCALES.has(base)) return base as 'en' | 'ar';
    }
    return 'en';
  }

  private parseDevice(req: Request): DeviceContext {
    const read = (name: string): string | null => {
      const value = req.header(name);
      if (!value) return null;
      // Guard against header stuffing.
      return value.length > 256 ? value.slice(0, 256) : value;
    };

    const rawName = read('x-device-name');

    return {
      deviceKey: read('x-device-id'),
      platform: read('x-device-platform'),
      model: read('x-device-model'),
      // The client URL-encodes the name because it can contain anything.
      name: rawName ? safeDecode(rawName) : null,
      osVersion: read('x-device-os'),
      appVersion: read('x-app-version'),
      appBuild: read('x-app-build'),
      integritySuspect: read('x-device-integrity') === 'suspect',
    };
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
