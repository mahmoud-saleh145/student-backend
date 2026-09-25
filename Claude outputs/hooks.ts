'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import type { VideoStatus } from '@/types/domain';

/** Reads and writes for one lecture's video. Every route is `@StaffOnly()`. */

/** Exactly what `VideosService.status` returns. */
export interface VideoStatusDetail {
  id: string;
  lessonId: string;
  courseId: string;
  status: VideoStatus;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  isEncrypted: boolean;
  renditions: {
    height: number;
    width: number;
    bitrateKbps: number;
    sizeBytes: number | null;
  }[];
  captions: { language: string; label: string; isDefault: boolean }[];
  processingError: string | null;
  processingStartedAt: string | null;
  processedAt: string | null;
  sourceSizeBytes: number | null;
}

/** The statuses that will change on their own, so polling is worth the calls. */
const IN_FLIGHT: ReadonlySet<VideoStatus> = new Set<VideoStatus>([
  'UPLOADING',
  'QUEUED',
  'PROCESSING',
]);

const POLL_INTERVAL_MS = 4000;

/**
 * One video's processing state.
 *
 * Polls only while the status can still change. Transcoding is a background
 * job with no push channel to this dashboard, so asking repeatedly is the only
 * way to notice it finished — but `READY` and `FAILED` are terminal, and
 * polling those forever would be a request every four seconds for as long as
 * the tab is open. `refetchIntervalInBackground` is deliberately left off, so a
 * backgrounded tab stops asking.
 */
export function useVideoStatus(videoId: string | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.videos.status(videoId ?? 'none'),
    queryFn: () => api.get<VideoStatusDetail>(`videos/${videoId}/status`),
    enabled: enabled && Boolean(videoId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      // No data yet: the first load is in flight, not a reason to schedule.
      if (!status) return false;
      return IN_FLIGHT.has(status) ? POLL_INTERVAL_MS : false;
    },
  });
}

/**
 * Re-runs transcoding from the stored source.
 *
 * The source file is still in the uploads bucket after a failure, so this does
 * not re-upload anything — which matters when the file is 8 GB. The backend
 * refuses if there is no source (`INVALID_STATE`), and the panel says to
 * re-upload in that case.
 */
export function useRetryVideoProcessing(courseId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (videoId: string) =>
      api.post<{ videoId: string; status: VideoStatus; jobId: string | null }>(
        `videos/${videoId}/retry`,
      ),
    onSuccess: async (_result, videoId) => {
      // Back to QUEUED, which restarts polling.
      await queryClient.invalidateQueries({ queryKey: queryKeys.videos.status(videoId) });
      if (courseId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.courses.all });
      }
    },
  });
}
