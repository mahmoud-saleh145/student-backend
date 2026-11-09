import { selectProcessors } from '../../src/jobs/jobs.module';
import { AnalyticsProcessor } from '../../src/jobs/processors/analytics.processor';
import { MaintenanceProcessor } from '../../src/jobs/processors/maintenance.processor';
import { MobileVideoProcessor } from '../../src/jobs/processors/mobile-video.processor';
import { PushProcessor } from '../../src/jobs/processors/push.processor';
import { VideoProcessor } from '../../src/jobs/processors/video.processor';

/**
 * `WORKER_QUEUES` decides which consumers one worker process registers, so the
 * CPU-bound mobile transcode can live on its own host while push, announcements
 * and maintenance stay on a small always-on one.
 */
describe('selectProcessors', () => {
  it('registers every consumer when nothing is named (the single-host deployment)', () => {
    for (const spec of [undefined, '', '  ']) {
      expect(selectProcessors(spec)).toEqual([
        VideoProcessor,
        MobileVideoProcessor,
        PushProcessor,
        MaintenanceProcessor,
        AnalyticsProcessor,
      ]);
    }
  });

  it('registers only the named queues, in the order given', () => {
    expect(selectProcessors('mobile-video-processing')).toEqual([MobileVideoProcessor]);
    expect(selectProcessors('push-delivery, maintenance ,analytics,video-processing')).toEqual([
      PushProcessor,
      MaintenanceProcessor,
      AnalyticsProcessor,
      VideoProcessor,
    ]);
  });

  it('refuses an unknown queue name at boot rather than running an idle worker', () => {
    expect(() => selectProcessors('push-delivery,mobile')).toThrow(/unknown queue "mobile"/);
  });
});
