import { Prisma } from '@prisma/client';

/**
 * The one statement of "how many plays has this student used on this video,
 * and how many may they have". Shared by playback (enforcement) and the admin
 * Manage Views screen (display and adjustment) so the two can never disagree.
 *
 * A play COUNTS when it is open, or closed after at least
 * `minCountedPlaySeconds` of watching — the rule that keeps retries, short
 * taps and resumes free. An admin adjustment (`video_play_allowances`) changes
 * two things only, and never deletes history:
 *
 *   * `allowedPlays` — the ceiling for this pair. NULL = the global default.
 *   * `countFrom`    — plays that STARTED before this moment no longer count.
 */

export interface AllowanceRow {
  allowedPlays: number | null;
  countFrom: Date | null;
}

type Db = Prisma.TransactionClient;

export function countedPlaysWhere(
  userId: string,
  videoId: string,
  minCountedSeconds: number,
  countFrom: Date | null,
): Prisma.VideoPlayWhereInput {
  return {
    userId,
    videoId,
    OR: [{ closedAt: null }, { watchedSeconds: { gte: minCountedSeconds } }],
    ...(countFrom ? { startedAt: { gte: countFrom } } : {}),
  };
}

export function effectiveLimit(allowance: AllowanceRow | null, defaultLimit: number): number {
  return allowance?.allowedPlays ?? defaultLimit;
}

/**
 * Serialises everything that reads-then-writes one (student, video) counter:
 * a new play being claimed, and an administrator adjusting it. Transaction
 * scoped, so it is released on commit or rollback and can never leak.
 *
 * Without it, "Set remaining to 2" computed against used = 1 could land
 * between a concurrent claim's count and its insert, and the student would end
 * up with one play fewer (or more) than the administrator chose.
 */
export async function lockPlayCounter(db: Db, userId: string, videoId: string): Promise<void> {
  const key = `video_play:${userId}:${videoId}`;
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

export async function readAllowance(
  db: Db,
  userId: string,
  videoId: string,
): Promise<AllowanceRow | null> {
  return db.videoPlayAllowance.findUnique({
    where: { userId_videoId: { userId, videoId } },
    select: { allowedPlays: true, countFrom: true },
  });
}

export async function countUsedPlays(
  db: Db,
  userId: string,
  videoId: string,
  minCountedSeconds: number,
  allowance: AllowanceRow | null,
): Promise<number> {
  return db.videoPlay.count({
    where: countedPlaysWhere(userId, videoId, minCountedSeconds, allowance?.countFrom ?? null),
  });
}

/** Hard ceiling on a custom limit; mirrored by a CHECK constraint in the table. */
export const MAX_CUSTOM_ALLOWED_PLAYS = 1000;
