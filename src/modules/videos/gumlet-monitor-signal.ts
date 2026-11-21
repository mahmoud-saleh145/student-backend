/**
 * Process-local signals between the Gumlet ingest and GumletStatusMonitor.
 * A separate module so the two services do not import each other.
 */

/** "An asset was just submitted here: scan soon." */
let pendingHint = false;
/** Whether a status monitor is running in THIS process (see GumletStatusMonitor). */
let monitorActive = false;

export function noteGumletAssetPending(): void {
  pendingHint = true;
}

/** Returns the hint and clears it. */
export function takeGumletPendingHint(): boolean {
  const hinted = pendingHint;
  pendingHint = false;
  return hinted;
}

/** Reads the hint without clearing it. */
export function peekGumletPendingHint(): boolean {
  return pendingHint;
}

/**
 * Set by GumletStatusMonitor when it actually runs in this process. The web job
 * releases its queue slot right after submitting ONLY when this is true;
 * otherwise nothing local would finish the video soon, so the job keeps the
 * previous in-job polling.
 */
export function setGumletMonitorActive(active: boolean): void {
  monitorActive = active;
}

export function isGumletMonitorActive(): boolean {
  return monitorActive;
}
