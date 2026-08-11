/**
 * PUT one procedure-video master to its presigned URL with HONEST progress.
 *
 * This is the seam between the two video upload flows (the edit page's
 * immediate uploader and the create page's staged batch) and
 * `lib/upload-with-progress`, which is XHR on purpose — `fetch()` exposes no
 * upload-progress signal, so any percentage built on it could only ever be
 * invented (see that module's doc comment).
 *
 * 1 GB files are the normal case here, so the file is handed to XHR as the
 * Blob it already is: `xhr.send(File)` streams from disk and never requires
 * the file's bytes in JS memory. Never `arrayBuffer()` a video.
 *
 * Progress honesty (same rules the item-image uploader encodes):
 *   * `fraction`/`percent` only ever reflect bytes the transport says were
 *     sent — never synthesised, never optimistic.
 *   * Monotonic and clamped via `BatchProgress` — a re-reported smaller
 *     `loaded` can't rewind the bar.
 *   * `percent` holds at 99 until the request actually SUCCEEDED; a failed
 *     upload keeps the fraction it genuinely reached and can never read 100.
 */

import {
  BatchProgress,
  uploadWithProgress,
  type UploadResult,
} from '@/lib/upload-with-progress';

export interface VideoUploadProgress {
  /** Monotonic clamped 0..1 fraction of transported bytes; 1 only on success. */
  fraction: number;
  /** Whole percent, floored and held at 99 until the PUT succeeded. */
  percent: number;
}

const MASTER_KEY = 'master';

export async function uploadVideoMaster({
  signedUrl,
  file,
  contentType,
  onProgress,
}: {
  signedUrl: string;
  /** The File/Blob itself — passed straight to XHR, never buffered. */
  file: Blob;
  contentType: string;
  onProgress?: (progress: VideoUploadProgress) => void;
}): Promise<UploadResult> {
  const tracker = new BatchProgress([{ key: MASTER_KEY, weight: file.size }]);
  let lastPercent = -1;
  const publish = () => {
    const percent = tracker.percent;
    // Emit only on whole-percent movement — a 1 GB PUT fires thousands of
    // progress events and re-rendering per event would jank the page.
    if (percent === lastPercent) return;
    lastPercent = percent;
    onProgress?.({ fraction: tracker.fraction, percent });
  };

  const result = await uploadWithProgress({
    url: signedUrl,
    body: file,
    contentType,
    // The SDK upload this replaced set cacheControl: '3600'; the presigned
    // PUT carries the same object metadata via the header form.
    headers: { 'cache-control': 'max-age=3600' },
    onProgress: ({ loaded, total }) => {
      tracker.set(MASTER_KEY, total > 0 ? loaded / total : 0);
      publish();
    },
  });

  // Settle honestly: only a 2xx claims 100%. A failure leaves the fraction
  // where the transport genuinely stopped.
  tracker.settle(MASTER_KEY, result.ok);
  publish();
  return result;
}
