'use client';

import { useRef, useState } from 'react';

import { VideoStatusBadge } from '@/components/data/status';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { useRetryVideoProcessing, useVideoStatus } from '@/features/videos/hooks';
import { useVideoUpload, VIDEO_UPLOAD_TYPES } from '@/features/videos/upload';
import { messageFor } from '@/lib/errors';
import { formatBytes, formatDuration } from '@/lib/format';
import type { VideoStatus } from '@/types/domain';

/**
 * The video on one lecture.
 *
 * A lecture's video has a longer life than a form submission: the bytes go up,
 * then a worker transcodes them, and only then can a student play it. This
 * panel follows all of it — choosing, uploading, the API verifying, the queue,
 * processing, and the two terminal states — rather than reporting "uploaded"
 * and leaving the reader to guess why the lecture still will not play.
 *
 * It needs a lesson that already exists, because `videos/uploads/init` takes a
 * `lessonId` — there is nothing to attach a video to before the lecture row is
 * created. That is why the create dialog creates the lecture first and then
 * shows this, instead of collecting a file alongside the title and pretending
 * the two are one step.
 */
export function LessonVideoPanel({
  lessonId,
  courseId,
  existingVideo,
}: {
  lessonId: string;
  courseId?: string;
  existingVideo?: { id: string; status: VideoStatus; durationSeconds: number } | null;
}) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);

  // Set as soon as the upload is handed off, so the panel can follow a video
  // whose `complete` failed just as well as one that succeeded.
  const [startedVideoId, setStartedVideoId] = useState<string | null>(null);

  // `complete` returned QUEUED, and that is true before the first status poll
  // comes back. Without this the panel falls through to "No video on this
  // lecture yet" for the length of one request — right after the reader
  // watched the upload finish, which reads as the upload having been lost.
  const [handedOffStatus, setHandedOffStatus] = useState<VideoStatus | null>(null);

  const upload = useVideoUpload(lessonId, {
    onQueued: (videoId) => {
      setStartedVideoId(videoId);
      setHandedOffStatus('QUEUED');
      toast.success(
        'Upload finished',
        'The lecture is queued for processing. It becomes playable once that finishes.',
      );
    },
  });

  const videoId = upload.videoId ?? startedVideoId ?? existingVideo?.id ?? null;

  // While bytes are moving there is nothing on the server worth asking about,
  // and the row still says UPLOADING. Polling resumes the moment it is queued.
  const status = useVideoStatus(videoId, !upload.isBusy);
  const retry = useRetryVideoProcessing(courseId);

  const detail = status.data;

  // The server's own answer wins as soon as there is one. Before that: the
  // status `complete` just reported, or the one the lecture row already
  // carried — never a bare null while a video demonstrably exists.
  const currentStatus: VideoStatus | null =
    detail?.status ??
    handedOffStatus ??
    (videoId === existingVideo?.id ? (existingVideo?.status ?? null) : null);

  const pick = () => input.current?.click();

  const onChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared so choosing the same file again after a failure still fires.
    event.target.value = '';
    if (file) void upload.upload(file);
  };

  async function runRetry() {
    if (!videoId) return;
    try {
      await retry.mutateAsync(videoId);
      toast.success('Processing restarted', 'The stored file is being transcoded again.');
    } catch (error) {
      toast.error(error, 'Processing could not be restarted');
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <input
        ref={input}
        type="file"
        className="sr-only"
        accept={VIDEO_UPLOAD_TYPES.join(',')}
        onChange={onChange}
        aria-hidden="true"
        tabIndex={-1}
      />

      <div className="rounded-lg border border-border p-3">
        {/* --- nothing here yet, or a finished/failed video to replace --- */}
        {!upload.isBusy && upload.phase !== 'error' ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              {currentStatus ? (
                <div className="flex flex-wrap items-center gap-2">
                  <VideoStatusBadge status={currentStatus} />
                  <p className="min-w-0 truncate text-sm text-foreground">
                    {describe(currentStatus)}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-foreground">No video on this lecture yet.</p>
              )}

              <p className="mt-0.5 text-xs text-muted">
                {currentStatus === 'READY' && detail
                  ? [
                      formatDuration(detail.durationSeconds ?? 0),
                      detail.height ? `${detail.height}p source` : null,
                      detail.renditions.length
                        ? `${detail.renditions.length} rendition${
                            detail.renditions.length === 1 ? '' : 's'
                          }`
                        : null,
                      detail.sourceSizeBytes ? formatBytes(detail.sourceSizeBytes) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : 'MP4, MOV, MKV, WebM or AVI. Up to 8 GB.'}
              </p>
            </div>

            <Button type="button" variant="secondary" size="sm" onClick={pick}>
              {currentStatus ? 'Replace video' : 'Choose video'}
            </Button>
          </div>
        ) : null}

        {/* --- bytes moving, or the API verifying them --- */}
        {upload.isBusy ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <p className="min-w-0 truncate text-sm text-foreground">{upload.fileName}</p>
              {/* No cancel once the bytes are in and the API is verifying:
                  stopping there would leave a Video row that never gets
                  queued, and the PUT has already been paid for. */}
              {upload.phase === 'finishing' ? null : (
                <Button type="button" variant="ghost" size="sm" onClick={upload.cancel}>
                  Cancel
                </Button>
              )}
            </div>

            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-surface-alt"
              role="progressbar"
              aria-valuenow={upload.phase === 'uploading' ? upload.progress : undefined}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Upload progress"
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-200"
                style={{
                  width:
                    upload.phase === 'preparing'
                      ? '4%'
                      : upload.phase === 'finishing'
                        ? '100%'
                        : `${Math.max(upload.progress, 2)}%`,
                }}
              />
            </div>

            <p className="text-xs text-muted" aria-live="polite">
              {upload.phase === 'preparing'
                ? 'Preparing the upload…'
                : upload.phase === 'finishing'
                  ? 'Checking the file arrived…'
                  : `Uploading — ${upload.progress}%${
                      upload.sizeBytes ? ` of ${formatBytes(upload.sizeBytes)}` : ''
                    }`}
            </p>
          </div>
        ) : null}

        {/* --- the upload itself failed --- */}
        {upload.phase === 'error' ? (
          <div className="space-y-2">
            <p role="alert" className="text-sm font-medium text-danger">
              {upload.error}
            </p>
            {upload.fileName ? (
              <p className="truncate text-xs text-muted">{upload.fileName}</p>
            ) : null}
            <Button type="button" variant="secondary" size="sm" onClick={pick}>
              Choose another file
            </Button>
          </div>
        ) : null}
      </div>

      {/* --- what became of it, once the bytes are the server's problem --- */}
      {currentStatus === 'QUEUED' || currentStatus === 'PROCESSING' ? (
        <p className="text-xs text-muted" aria-live="polite">
          {currentStatus === 'QUEUED'
            ? 'Waiting for a transcoding worker. You can close this — processing continues.'
            : 'Transcoding into the qualities students stream. This can take several minutes.'}
        </p>
      ) : null}

      {currentStatus === 'FAILED' ? (
        <div className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2">
          <p role="alert" className="text-sm font-medium text-danger">
            Processing failed
          </p>
          {detail?.processingError ? (
            <p className="mt-0.5 text-xs text-danger">{detail.processingError}</p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              loading={retry.isPending}
              onClick={() => void runRetry()}
            >
              Try processing again
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={pick}>
              Upload a different file
            </Button>
          </div>
          <p className="mt-1.5 text-xs text-muted">
            The uploaded file is still in storage, so retrying does not upload it again.
          </p>
        </div>
      ) : null}

      {status.isError && !upload.isBusy ? (
        <p role="alert" className="text-xs font-medium text-danger">
          {messageFor(status.error)}
        </p>
      ) : null}

      {currentStatus === 'READY' ? (
        <p className="text-xs text-muted">
          <Badge tone="neutral">Protected</Badge> Played only through a signed, per-viewer
          ticket. The dashboard never produces a public or downloadable URL.
        </p>
      ) : null}
    </div>
  );
}

function describe(status: VideoStatus): string {
  switch (status) {
    case 'UPLOADING':
      return 'An upload was started but never finished.';
    case 'QUEUED':
      return 'Queued for processing.';
    case 'PROCESSING':
      return 'Being processed.';
    case 'READY':
      return 'Ready to stream.';
    case 'FAILED':
      return 'Processing failed.';
    case 'ARCHIVED':
      return 'Archived.';
  }
}
