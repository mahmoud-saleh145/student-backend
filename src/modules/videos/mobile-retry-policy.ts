import type { PauseState } from '../../jobs/processors/scratch-guard';

/**
 * WHO MAY RETRY A MOBILE ENCODE WHILE AN OPERATOR PAUSE IS IN PLACE.
 *
 * A staff retry (`POST /videos/:id/mobile/retry`, the dashboard's "Retry
 * mobile") creates a job with trigger `retry`. A historical hold does not hold
 * that trigger (`pauseHolds`), so without this rule anyone who can manage a
 * course could start an encode in the middle of a controlled backlog run, and
 * a full pause would quietly collect retries that all start the moment it is
 * lifted. The rule follows the same pause flag the operator already drives;
 * nothing has to be switched on or off for it:
 *
 *   - no pause:         unchanged - whoever could retry before still can;
 *   - FULL pause:       nobody (MASTER included). Nothing may be queued behind
 *                       a full stop; lift it or switch to a historical hold;
 *   - HISTORICAL hold:  only MASTER, for approved testing and recovery.
 *
 * The flag is read strictly by the caller: a flag that cannot be read refuses
 * the retry (fail closed) instead of being taken as "not paused".
 */
export type MobileRetryVerdict =
  | { allowed: true }
  | { allowed: false; reason: MobileRetryRefusal };

export type MobileRetryRefusal = 'full-pause' | 'historical-hold' | 'pause-unreadable';

export function mobileRetryVerdict(pause: Pick<PauseState, 'paused' | 'scope'>, role: string): MobileRetryVerdict {
  if (!pause.paused) return { allowed: true };
  if (pause.scope !== 'historical') return { allowed: false, reason: 'full-pause' };
  return role === 'MASTER' ? { allowed: true } : { allowed: false, reason: 'historical-hold' };
}

export const MOBILE_RETRY_REFUSAL_MESSAGE: Record<MobileRetryRefusal, string> = {
  'full-pause':
    'Mobile processing is fully paused by an operator, so no mobile retry can be queued. ' +
    'It becomes possible again when the pause is lifted or changed to a historical hold.',
  'historical-hold':
    'Mobile processing is on a historical hold. Until it is lifted, only the master account can retry a mobile encode.',
  'pause-unreadable':
    'Could not read whether mobile processing is paused, so nothing was queued. Try again in a moment.',
};
