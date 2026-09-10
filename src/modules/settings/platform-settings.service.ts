import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, type Prisma, UserRole } from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import type { DeviceConfig } from '../../config/configuration';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';

/**
 * Every setting the dashboard can edit, with the value that reproduces the
 * behaviour the platform had before settings existed.
 *
 * Defaults live here rather than in the database so a missing row is never a
 * behaviour change: `platform_settings` is a sparse overlay, not the source of
 * the schema.
 */
export interface SettingShape {
  'student.deviceLimit': number;
  'student.allowAcademicYearChange': boolean;
  'teacher.canDeleteLectures': boolean;
  'teacher.canDeleteVideos': boolean;
  'teacher.canEditVideoUrls': boolean;
  'teacher.canEditCoursePrices': boolean;
  'contact.phone': string;
  'contact.whatsapp': string;
  'contact.facebook': string;
  'contact.email': string;
}

export const SETTING_DEFAULTS: SettingShape = {
  'student.deviceLimit': 1,
  'student.allowAcademicYearChange': false,
  'teacher.canDeleteLectures': false,
  'teacher.canDeleteVideos': false,
  'teacher.canEditVideoUrls': false,
  'teacher.canEditCoursePrices': false,
  'contact.phone': '',
  'contact.whatsapp': '',
  'contact.facebook': '',
  'contact.email': '',
};

export type SettingKey = keyof SettingShape;

export const SETTING_KEYS = Object.keys(SETTING_DEFAULTS) as SettingKey[];

/** The four teacher capabilities the dashboard exposes as switches. */
export type TeacherCapability =
  | 'deleteLectures'
  | 'deleteVideos'
  | 'editVideoUrls'
  | 'editCoursePrices';

/** The subset of keys whose stored value is a boolean. */
type BooleanSettingKey = {
  [K in SettingKey]: SettingShape[K] extends boolean ? K : never;
}[SettingKey];

const TEACHER_CAPABILITY_KEYS: Record<TeacherCapability, BooleanSettingKey> = {
  deleteLectures: 'teacher.canDeleteLectures',
  deleteVideos: 'teacher.canDeleteVideos',
  editVideoUrls: 'teacher.canEditVideoUrls',
  editCoursePrices: 'teacher.canEditCoursePrices',
};

const SETTING_DESCRIPTIONS: Record<SettingKey, string> = {
  'student.deviceLimit': 'How many devices a student account may bind at once.',
  'student.allowAcademicYearChange':
    'Whether students may change their own academic year from the app.',
  'teacher.canDeleteLectures': 'Whether teachers may delete lectures in their own courses.',
  'teacher.canDeleteVideos': 'Whether teachers may delete videos in their own courses.',
  'teacher.canEditVideoUrls':
    'Whether teachers may replace video sources in their own courses.',
  'teacher.canEditCoursePrices': 'Whether teachers may change the price of their own courses.',
  'contact.phone': 'Public support phone number.',
  'contact.whatsapp': 'Public WhatsApp number.',
  'contact.facebook': 'Public Facebook page URL.',
  'contact.email': 'Public support email address.',
};

/** Guard rails applied server-side, so a bad PUT cannot brick the platform. */
const VALIDATORS: Partial<Record<SettingKey, (value: unknown) => string | null>> = {
  'student.deviceLimit': (value) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 10
      ? null
      : 'must be a whole number between 1 and 10',
  'student.allowAcademicYearChange': booleanCheck,
  'teacher.canDeleteLectures': booleanCheck,
  'teacher.canDeleteVideos': booleanCheck,
  'teacher.canEditVideoUrls': booleanCheck,
  'teacher.canEditCoursePrices': booleanCheck,
  'contact.phone': stringCheck(40),
  'contact.whatsapp': stringCheck(40),
  'contact.facebook': stringCheck(300),
  'contact.email': stringCheck(160),
};

function booleanCheck(value: unknown): string | null {
  return typeof value === 'boolean' ? null : 'must be true or false';
}

function stringCheck(max: number) {
  return (value: unknown): string | null =>
    typeof value === 'string' && value.length <= max
      ? null
      : `must be text of at most ${max} characters`;
}

/**
 * Typed access to `platform_settings`.
 *
 * Read paths run on every protected request (the device limit is checked at
 * login, the teacher switches on every content mutation), so values are held
 * in a short-lived in-process cache. The TTL is deliberately small: an
 * administrator flipping a switch expects it to take effect while they are
 * still looking at the screen, and a few seconds of staleness cannot grant
 * access that the request-time database check would refuse anyway.
 */
@Injectable()
export class PlatformSettingsService {
  private readonly logger = new Logger(PlatformSettingsService.name);
  private static readonly CACHE_TTL_MS = 10_000;

  private cache: Map<string, unknown> | null = null;
  private cachedAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async get<K extends SettingKey>(key: K): Promise<SettingShape[K]> {
    const all = await this.load();
    const stored = all.get(key);
    if (stored === undefined || stored === null) {
      return this.fallback(key);
    }

    // A stored value of the wrong shape is treated as absent rather than
    // trusted: a hand-edited row must not be able to disable a control.
    const invalid = VALIDATORS[key]?.(stored);
    if (invalid) {
      this.logger.warn(`platform setting '${key}' is invalid (${invalid}); using default`);
      return this.fallback(key);
    }

    return stored as SettingShape[K];
  }

  /** Every setting, defaults filled in — what the dashboard's form renders. */
  async getAll(): Promise<Record<SettingKey, unknown>> {
    const entries = await Promise.all(
      SETTING_KEYS.map(async (key) => [key, await this.get(key)] as const),
    );
    return Object.fromEntries(entries) as Record<SettingKey, unknown>;
  }

  /** Devices a student may bind. Falls back to DEVICE_LIMIT_PER_STUDENT. */
  async deviceLimit(): Promise<number> {
    return this.get('student.deviceLimit');
  }

  async allowsAcademicYearChange(): Promise<boolean> {
    return this.get('student.allowAcademicYearChange');
  }

  async teacherMay(capability: TeacherCapability): Promise<boolean> {
    return this.get(TEACHER_CAPABILITY_KEYS[capability]);
  }

  /** Public contact block, surfaced through GET /meta/app-config. */
  async contacts(): Promise<Record<string, string>> {
    const [phone, whatsapp, facebook, email] = await Promise.all([
      this.get('contact.phone'),
      this.get('contact.whatsapp'),
      this.get('contact.facebook'),
      this.get('contact.email'),
    ]);
    return { phone, whatsapp, facebook, email };
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * Applies a partial update. Unknown keys are rejected rather than stored, so
   * `platform_settings` cannot silently accumulate typos that read back as
   * defaults forever.
   */
  async update(
    patch: Record<string, unknown>,
    actor: { id: string; role: UserRole },
  ): Promise<Record<SettingKey, unknown>> {
    const fields: Record<string, string[]> = {};
    const accepted: [SettingKey, unknown][] = [];

    for (const [key, value] of Object.entries(patch)) {
      if (!SETTING_KEYS.includes(key as SettingKey)) {
        fields[key] = ['unknown setting'];
        continue;
      }
      const problem = VALIDATORS[key as SettingKey]?.(value);
      if (problem) {
        fields[key] = [problem];
        continue;
      }
      accepted.push([key as SettingKey, value]);
    }

    if (Object.keys(fields).length > 0) throw AppException.validation(fields);
    if (accepted.length === 0) return this.getAll();

    const before = await this.getAll();

    await this.prisma.$transaction(
      accepted.map(([key, value]) =>
        this.prisma.platformSetting.upsert({
          where: { key },
          create: {
            key,
            value: value as Prisma.InputJsonValue,
            description: SETTING_DESCRIPTIONS[key],
            updatedById: actor.id,
          },
          update: {
            value: value as Prisma.InputJsonValue,
            description: SETTING_DESCRIPTIONS[key],
            updatedById: actor.id,
          },
        }),
      ),
    );

    this.invalidate();
    const after = await this.getAll();

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.SETTINGS_CHANGE,
      entity: 'platform_setting',
      entityId: accepted.map(([key]) => key).join(','),
      before: Object.fromEntries(accepted.map(([key]) => [key, before[key]])),
      after: Object.fromEntries(accepted.map(([key]) => [key, after[key]])),
    });

    return after;
  }

  invalidate(): void {
    this.cache = null;
    this.cachedAt = 0;
  }

  // ---------------------------------------------------------------------------

  private async load(): Promise<Map<string, unknown>> {
    const now = Date.now();
    if (this.cache && now - this.cachedAt < PlatformSettingsService.CACHE_TTL_MS) {
      return this.cache;
    }

    try {
      const rows = await this.prisma.platformSetting.findMany({
        where: { key: { in: SETTING_KEYS } },
        select: { key: true, value: true },
      });
      this.cache = new Map(rows.map((row) => [row.key, row.value as unknown]));
      this.cachedAt = now;
    } catch (error) {
      // A settings read must never take down a request that would otherwise
      // succeed; defaults are always a safe answer because they are the
      // pre-settings behaviour.
      this.logger.error(`failed to read platform settings: ${String(error)}`);
      this.cache = new Map();
      this.cachedAt = now;
    }

    return this.cache;
  }

  private fallback<K extends SettingKey>(key: K): SettingShape[K] {
    if (key === 'student.deviceLimit') {
      // Honour the existing environment variable so an operator who set
      // DEVICE_LIMIT_PER_STUDENT does not silently lose it on upgrade.
      const device = this.config.get<DeviceConfig>('device');
      if (device?.limitPerStudent) {
        return device.limitPerStudent as SettingShape[K];
      }
    }
    return SETTING_DEFAULTS[key];
  }
}
