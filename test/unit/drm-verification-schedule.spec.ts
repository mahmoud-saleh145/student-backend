import { MAINTENANCE_JOBS } from '../../src/jobs/queue.constants';
import { MaintenanceScheduler } from '../../src/jobs/schedulers/maintenance.scheduler';

/**
 * The DRM refresh is only real if it is actually REGISTERED. A sweep service
 * that is never scheduled is indistinguishable, from the outside, from one that
 * does not exist - which is exactly how the six-hour expiry came to be
 * unguarded in the first place.
 */

type AddArgs = [name: string, data: unknown, opts: unknown];

function fakeQueue() {
  const add = jest.fn(async (_name: string, _data: unknown, _opts: unknown) => undefined);
  return { add };
}

describe('DRM re-verification scheduling', () => {
  it('has a stable job name so restarts do not accumulate duplicates', () => {
    expect(MAINTENANCE_JOBS.refreshDrmVerification).toBe('refresh-drm-verification');
  });

  it('registers the refresh as a repeatable maintenance job', async () => {
    const maintenance = fakeQueue();
    const analytics = fakeQueue();
    const scheduler = new MaintenanceScheduler(maintenance as never, analytics as never);

    await scheduler.onModuleInit();

    const names = maintenance.add.mock.calls.map((c) => c[0] as string);
    expect(names).toContain(MAINTENANCE_JOBS.refreshDrmVerification);
  });

  it('schedules it inside the sweep refresh margin at the default TTL', async () => {
    const maintenance = fakeQueue();
    const analytics = fakeQueue();
    const scheduler = new MaintenanceScheduler(maintenance as never, analytics as never);
    await scheduler.onModuleInit();

    const call = maintenance.add.mock.calls.find(
      (c) => c[0] === MAINTENANCE_JOBS.refreshDrmVerification,
    ) as AddArgs | undefined;
    const opts = call?.[2] as { repeat: { pattern: string; tz: string }; jobId: string };

    // Every 30 minutes against a 6h TTL with a 2h margin: the proof is renewed
    // roughly every 4 sweeps, so an expiry is never actually reached.
    expect(opts.repeat.pattern).toBe('*/30 * * * *');
    expect(opts.repeat.tz).toBe('UTC');
    // Same id on every boot, so re-registration replaces rather than appends.
    expect(opts.jobId).toBe(`repeat:${MAINTENANCE_JOBS.refreshDrmVerification}`);
  });

  it('keeps every other scheduled job intact', async () => {
    const maintenance = fakeQueue();
    const analytics = fakeQueue();
    const scheduler = new MaintenanceScheduler(maintenance as never, analytics as never);
    await scheduler.onModuleInit();

    const names = maintenance.add.mock.calls.map((c) => c[0] as string);
    expect(names).toEqual(
      expect.arrayContaining([
        MAINTENANCE_JOBS.expireEnrollments,
        MAINTENANCE_JOBS.expireTickets,
        MAINTENANCE_JOBS.reclaimStreamSlots,
        MAINTENANCE_JOBS.dispatchAnnouncements,
        MAINTENANCE_JOBS.recoverStrandedVideos,
        MAINTENANCE_JOBS.refreshDrmVerification,
      ]),
    );
  });
});
