'use client';

import { useCallback, useRef, useState } from 'react';

import { api } from '@/lib/api-client';
import { ApiError, messageFor } from '@/lib/errors';

/**
 * Uploading a lecture video.
 *
 * Three steps, and the middle one deliberately does not touch this application:
 *
 *   1. `POST videos/uploads/init`        — creates the Video row, returns a
 *                                          presigned PUT into the private
 *                                          uploads bucket
 *   2. `PUT <uploadUrl>`                 — browser → R2, direct
 *   3. `POST videos/:videoId/complete`   — the API checks the object actually
 *                                          landed, then queues transcoding
 *
 * **Why not through our own origin, when the library document upload is?** A
 * library document is capped at 200 MB; a lecture is capped at 8 GB. Proxying
 * that would hold a socket open on the Next server and on the API behind it for
 * the length of the upload, and one slow uploader would occupy a worker for
 * minutes. `videos.service.ts` says the same thing from the other side: "A 2 GB
 * lecture streamed through Node would pin a worker for minutes and cap
 * concurrent uploads at one per process."
 *
 * The cost of going direct is a CORS policy on the uploads bucket — see
 * `docs/r2-cors.md`. Without it the PUT fails at the preflight, before a byte
 * moves, and `onerror` below is what the person sees.
 *
 * **The file is never read into memory.** `XMLHttpRequest.send(file)` hands the
 * browser a `File`, which it streams from disk. Nothing here calls
 * `arrayBuffer()`, `text()` or `FileReader`, and an 8 GB lecture costs this tab
 * no more than a small one.
 *
 * **The presigned URL is signed over the Content-Type.** The PUT must send
 * exactly the header `init` returned, and must send nothing else — an extra
 * header (`x-dashboard-request`, say) is not part of the signature and R2 will
 * refuse the request. That is also why this is the one place in the dashboard
 * that does not go through `api-client`.
 */

/** Exactly the set `ALLOWED_VIDEO_TYPES` enforces in `videos.service.ts`. */
export const VIDEO_UPLOAD_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/x-matroska',
  'video/webm',
  'video/x-msvideo',
] as const;

/** `MAX_SOURCE_BYTES` in `videos.service.ts`. */
export const VIDEO_UPLOAD_MAX_BYTES = 8 * 1024 * 1024 * 1024;

/** The backend's `@Matches` on `filename`, copied rather than approximated. */
const FILENAME_PATTERN = /^[\w .()\-؀-ۿ]+\.[A-Za-z0-9]{2,5}$/;

/** What `POST videos/uploads/init` replies with. */
interface InitResponse {
  videoId: string;
  uploadUrl: string;
  objectKey: string;
  expiresIn: number;
  requiredHeaders: Record<string, string>;
  completeUrl: string;
}

/** What `POST videos/:videoId/complete` replies with. */
interface CompleteResponse {
  videoId: string;
  status: string;
  jobId: string | null;
}

export type VideoUploadPhase =
  | 'idle'
  /** Asking the API for a signature. */
  | 'preparing'
  /** Bytes moving, browser → R2. */
  | 'uploading'
  /** Told the API the object landed; it is verifying and enqueueing. */
  | 'finishing'
  /** Handed off. From here the Video row's own status takes over. */
  | 'queued'
  | 'error';

export interface VideoUploadState {
  phase: VideoUploadPhase;
  /** 0–100, from bytes actually sent rather than an animation. */
  progress: number;
  fileName: string | null;
  sizeBytes: number | null;
  /** Set from `init`, so the status panel can poll even if `complete` fails. */
  videoId: string | null;
  error: string | null;
}

const IDLE: VideoUploadState = {
  phase: 'idle',
  progress: 0,
  fileName: null,
  sizeBytes: null,
  videoId: null,
  error: null,
};

/**
 * Rejects what the server would reject, before spending an 8 GB round trip on
 * it. Returns a message rather than throwing: every one of these is something
 * the person fixes by choosing a different file.
 */
export function validateVideoFile(file: File): string | null {
  if (!VIDEO_UPLOAD_TYPES.includes(file.type as (typeof VIDEO_UPLOAD_TYPES)[number])) {
    return 'That file type is not accepted. Use MP4, MOV, MKV, WebM or AVI.';
  }

  if (file.size > VIDEO_UPLOAD_MAX_BYTES) {
    return 'That file is larger than the 8 GB limit.';
  }

  if (file.size === 0) {
    return 'That file is empty.';
  }

  if (file.name.includes('..') || file.name.includes('/') || file.name.includes('\\')) {
    return 'The file name cannot contain path separators.';
  }

  if (!FILENAME_PATTERN.test(file.name)) {
    return 'The file name contains characters the server will not accept. Rename it and try again.';
  }

  return null;
}

/**
 * The direct PUT.
 *
 * `XMLHttpRequest` rather than `fetch` for one reason: upload progress. `fetch`
 * gives no way to observe bytes sent, and a multi-gigabyte upload with no
 * feedback is indistinguishable from a hung tab.
 */
function putToStorage(
  file: File,
  init: InitResponse,
  onProgress: (percent: number) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', init.uploadUrl, true);

    // Only the headers the signature covers. Anything extra invalidates it.
    for (const [name, value] of Object.entries(init.requiredHeaders)) {
      request.setRequestHeader(name, value);
    }

    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };

    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        resolve();
        return;
      }

      // R2 answers with an XML error document. Showing it verbatim would be
      // noise, so the status carries the meaning and the common causes are
      // named instead.
      reject(
        new Error(
          request.status === 403
            ? 'Storage refused the upload. The signature may have expired — try again.'
            : `Storage refused the upload (${request.status}).`,
        ),
      );
    };

    // A failed CORS preflight arrives here with no status at all, which is the
    // single most likely cause, so it is named.
    request.onerror = () =>
      reject(
        new Error(
          'The upload could not reach storage. Check the connection, or the bucket’s CORS rule for this site.',
        ),
      );
    request.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    request.ontimeout = () => reject(new Error('The upload timed out.'));

    signal.addEventListener('abort', () => request.abort(), { once: true });

    // The browser streams the File from disk. It is never held in JS memory.
    request.send(file);
  });
}

export interface UseVideoUploadResult extends VideoUploadState {
  /** Resolves to the video id once processing is queued, else null. */
  upload: (file: File) => Promise<string | null>;
  cancel: () => void;
  reset: () => void;
  isBusy: boolean;
}

export function useVideoUpload(
  lessonId: string,
  options: { onQueued?: (videoId: string) => void } = {},
): UseVideoUploadResult {
  const [state, setState] = useState<VideoUploadState>(IDLE);
  const controller = useRef<AbortController | null>(null);

  // Held in a ref so a caller passing a fresh arrow every render does not
  // change `upload`'s identity — the same mistake that re-armed the focus trap
  // on every keystroke in `overlay.tsx`.
  const onQueued = useRef(options.onQueued);
  onQueued.current = options.onQueued;

  const reset = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setState(IDLE);
  }, []);

  const cancel = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setState((current) => ({ ...current, phase: 'idle', progress: 0 }));
  }, []);

  const upload = useCallback(
    async (file: File): Promise<string | null> => {
      const problem = validateVideoFile(file);
      if (problem) {
        setState({ ...IDLE, phase: 'error', fileName: file.name, error: problem });
        return null;
      }

      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;

      setState({
        phase: 'preparing',
        progress: 0,
        fileName: file.name,
        sizeBytes: file.size,
        videoId: null,
        error: null,
      });

      try {
        const init = await api.post<InitResponse>(
          'videos/uploads/init',
          {
            lessonId,
            filename: file.name,
            contentType: file.type,
            sizeBytes: file.size,
          },
          { signal: abort.signal },
        );

        // Kept even if a later step fails: the Video row exists from here on,
        // so the panel can still show what became of it.
        setState((current) => ({
          ...current,
          phase: 'uploading',
          videoId: init.videoId,
        }));

        await putToStorage(
          file,
          init,
          (progress) => setState((current) => ({ ...current, progress })),
          abort.signal,
        );

        setState((current) => ({ ...current, phase: 'finishing', progress: 100 }));

        // The API verifies the object is really in the bucket before queueing,
        // so a "successful" PUT that stored nothing fails here rather than
        // minutes later in the worker.
        await api.post<CompleteResponse>(
          `videos/${init.videoId}/complete`,
          undefined,
          { signal: abort.signal },
        );

        setState((current) => ({ ...current, phase: 'queued' }));
        onQueued.current?.(init.videoId);

        return init.videoId;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          setState(IDLE);
          return null;
        }

        setState((current) => ({
          ...current,
          phase: 'error',
          // An ApiError came from our own backend and `messageFor` knows how
          // to present it. Anything else came from `putToStorage`, which
          // writes its own readable messages — `messageFor` would flatten
          // those to "Something went wrong" and lose the CORS hint.
          error:
            error instanceof ApiError
              ? messageFor(error)
              : error instanceof Error
                ? error.message
                : messageFor(error),
        }));
        return null;
      } finally {
        controller.current = null;
      }
    },
    [lessonId],
  );

  return {
    ...state,
    upload,
    cancel,
    reset,
    isBusy:
      state.phase === 'preparing' ||
      state.phase === 'uploading' ||
      state.phase === 'finishing',
  };
}
