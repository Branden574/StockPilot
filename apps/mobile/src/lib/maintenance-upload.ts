/**
 * Multi-photo upload for a maintenance request (Task 19). Mirrors the WEB
 * upload sequence step-for-step (maintenance-photos-panel.tsx's `uploadOne`):
 * resize/transcode -> mint -> PUT master (+ best-effort PUT thumb) ->
 * finalize. The platform difference is HOW bytes reach Storage — web PUTs a
 * File/Blob directly with `fetch()`; the documented RN landmine is that
 * `fetch(uri).blob()` on Expo silently uploads a 0-byte object (see
 * item-create.ts's `uploadPhotosFor`, which works around it with
 * `fetch(uri).arrayBuffer()` before a direct `supabase.storage.upload()`
 * call). This route sidesteps that landmine differently: `expo-file-system`'s
 * native `createUploadTask` reads the file straight off disk itself and never
 * constructs a JS Blob at all, which is also the only route that reports live
 * upload progress — a plain `supabase-js` `.upload()` call cannot.
 *
 * `uploadMaintenancePhoto` is the WHOLE orchestration for ONE photo, and it
 * is intentionally stateless/idempotent: calling it again for the same asset
 * (a Retry tap) is a complete, independent attempt with no leftover state
 * from a failed one. `createPhotoAttemptGuard` is what the SCREEN uses to
 * decide whether an in-flight attempt's progress/result is still the one it
 * should apply to visible state — see its own doc comment.
 */
import * as FileSystem from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';

import { MAINTENANCE_MAX_PHOTOS } from '@stockpilot/core';

import { ApiError } from './api';
import { resizeForUpload } from './image-resize';
import { finalizePhoto, mintPhotoUpload } from './maintenance-api';

/**
 * Typed upload failure so the screen can render accurate, per-kind copy
 * instead of one generic "something went wrong" (binding constraint: never
 * claim an upload succeeded when it didn't, and never blur a network problem
 * with a server refusal — they call for different user actions):
 *
 *   - 'upload_failed': the PUT itself failed (network drop, expired signed
 *     URL, timeout). The server never received any bytes, so there is no
 *     orphan row and no cleanup needed — just retry.
 *   - 'rejected': the server SAW the object and refused to record it
 *     (finalize's magic-byte sniff failed, the request closed mid-upload,
 *     the live photo cap was hit at finalize). A different photo, or a
 *     different moment, may work — "retry the same bytes" may not.
 *   - 'rate_limited': the MINT step's own rate limiter tripped. Route
 *     contract (maintenance-attachments.ts `createUploadUrl`): this is a
 *     409, never a 429. Distinguished from 'rejected' because the fix is
 *     "wait a bit", not "pick a different photo".
 */
export class UploadError extends Error {
  constructor(
    public kind: 'upload_failed' | 'rejected' | 'rate_limited',
    message: string,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/**
 * Extension -> the three MIME types finalize's magic-byte sniff actually
 * recognizes (image-signature.ts: png/jpeg/webp — GIF is not one of them,
 * and mint's own ALLOWED_EXTS already refuses it with a clear message before
 * finalize is ever reached, so no entry is needed for it here).
 *
 * `resizeForUpload` does NOT always force JPEG: an already-small source that
 * is already web-safe (a PNG screenshot, a WEBP image) comes back UNCHANGED,
 * ext included (image-resize.ts). Hardcoding 'jpg'/'image/jpeg' regardless of
 * what came back would declare the wrong MIME for a real PNG/WEBP upload, and
 * finalize's sniffed-bytes-vs-declared-MIME check
 * (maintenance-attachments.ts: `MIME_FOR_KIND[sniffed.kind] ===
 * args.declaredMime`) would reject every one of them as 'invalid_image' even
 * though the bytes are a perfectly valid photo.
 */
const DECLARED_MIME_FOR_EXT: Record<string, 'image/jpeg' | 'image/png' | 'image/webp'> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export async function uploadMaintenancePhoto(
  requestId: string,
  asset: { uri: string; fileName?: string },
  onProgress: (fraction: number) => void,
): Promise<{ id: string }> {
  // 1) Resize + transcode. HEIC never reaches the server: resizeForUpload
  // either downsizes to JPEG (anything over 1600px on its long edge) or, for
  // an already-small source, transcodes any non-web-safe format (HEIC/HEIF)
  // to JPEG too. Mint's own ALLOWED_EXTS rejects HEIC outright with "HEIC is
  // converted on your device before upload" — this is that conversion.
  const resized = await resizeForUpload(asset.uri);
  const ext = resized.ext === 'jpeg' ? 'jpg' : resized.ext;
  const declaredMime = DECLARED_MIME_FOR_EXT[ext] ?? 'image/jpeg';
  const name = asset.fileName?.replace(/\.[a-z0-9]+$/i, '') || 'photo';
  const originalFilename = `${name}.${ext}`;

  // 2) Server mint (rate-limited, entity-checked).
  const mint = await mintPhotoUpload(requestId, { fileExt: ext, originalFilename }).catch((err) => {
    // Route contract (maintenance-attachments.ts `createUploadUrl`): 409,
    // NEVER 429, on rate-limit. The server's own message is already the
    // right copy ("Too many uploads in the last hour...") — forward it
    // verbatim instead of replacing it with something generic, and tag the
    // kind so the screen can show it differently than a plain retry-now
    // failure (binding constraint: map 409 to human copy, not a generic
    // failure).
    if (err instanceof ApiError && err.status === 409) {
      throw new UploadError('rate_limited', err.message);
    }
    throw err;
  });

  // 3) PUT master via createUploadTask — the OTA-safe, progress-reporting
  // route. Unlike `fetch(uri).blob()`, this is a NATIVE file read, so the RN
  // Blob landmine never applies here in the first place (see module doc).
  const task = FileSystem.createUploadTask(
    mint.signedUrl,
    resized.uri,
    {
      httpMethod: 'PUT',
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: { 'Content-Type': declaredMime },
    },
    (progress) => {
      if (progress.totalBytesExpectedToSend > 0) {
        onProgress(progress.totalBytesSent / progress.totalBytesExpectedToSend);
      }
    },
  );
  const result = await task.uploadAsync();
  if (!result || result.status < 200 || result.status >= 300) {
    // The server never saw these bytes — finalize must NEVER be called past
    // this point (an orphan mint with no matching row is harmless, but a
    // finalize call against an object that was never actually PUT would
    // just fail its own download step for the same reason).
    throw new UploadError('upload_failed', 'Photo upload failed. Check your connection and retry.');
  }

  // 4) Thumb (best-effort): 400px JPEG via ImageManipulator, PUT without
  // progress. A missing/failed thumb must never fail the whole upload — the
  // master IS the photo; the thumb is a rendering nicety the detail view
  // already falls back off of when absent (maintenance-attachments.ts's own
  // fallback for a failed thumb sign).
  try {
    const thumb = await ImageManipulator.manipulateAsync(resized.uri, [{ resize: { width: 400 } }], {
      compress: 0.8,
      format: ImageManipulator.SaveFormat.JPEG,
    });
    await FileSystem.uploadAsync(mint.thumbSignedUrl, thumb.uri, {
      httpMethod: 'PUT',
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: { 'Content-Type': 'image/jpeg' },
    });
  } catch {
    // Deliberately swallowed — see doc comment above.
  }

  // 5) Finalize: the server downloads + magic-byte-verifies before ever
  // recording a row, so a failure here means it REFUSED the file, not that
  // the network dropped — a different failure than step 3's, and the screen
  // should say so rather than repeating "check your connection".
  return await finalizePhoto(requestId, {
    path: mint.path,
    thumbPath: mint.thumbPath,
    originalFilename,
    declaredMime,
  }).catch(() => {
    throw new UploadError('rejected', 'That photo was refused by the server.');
  });
}

/**
 * Pure cap check mirroring the web panel's (maintenance-photos-panel.tsx
 * `handleFiles`) "existing + already-queued + incoming > cap" arithmetic and
 * its exact copy. The server re-enforces this LIVE regardless, at both mint
 * and finalize (maintenance-attachments.ts, IMPORTANT 3) — this exists so
 * the screen can refuse an obviously-too-many selection BEFORE spending a
 * mint call on photo #9, with the same accurate message web already shows.
 */
export function checkPhotoCap(args: {
  existing: number;
  pending: number;
  incoming: number;
  max?: number;
}): { ok: true } | { ok: false; message: string } {
  const max = args.max ?? MAINTENANCE_MAX_PHOTOS;
  if (args.existing + args.pending + args.incoming > max) {
    return { ok: false, message: `A request can carry at most ${max} photos.` };
  }
  return { ok: true };
}

/**
 * Per-photo generalization of `createSequenceGuard` (debounced-list-load.ts)
 * — ONE independent attempt counter per photo key instead of one shared
 * counter for a whole screen. The new-request screen calls `start(key)`
 * right before calling `uploadMaintenancePhoto` — on the first add AND on
 * every Retry tap — and gates every progress/success/failure report through
 * `isCurrent` before applying it to visible state.
 *
 * Why a photo needs its OWN guard where the maintenance list screen's single
 * shared one does not: a Retry tap starts a SECOND `uploadMaintenancePhoto`
 * call for the same photo while the first one may still be in flight (a slow
 * PUT that has not yet timed out). If the FIRST attempt's failure lands
 * AFTER the retry already succeeded, applying it would flip a 'done' row
 * back to 'error' for bytes that were, in fact, saved. The reverse case — a
 * stale SUCCESS landing after a genuine retry failure — is worse: it would
 * claim an upload succeeded when it didn't, which this feature must never
 * do. Every OTHER photo in the same batch uploads independently of this one,
 * so the guard is keyed per photo rather than shared across the whole queue.
 */
export interface PhotoAttemptGuard {
  /** Starts a new attempt for `key`, invalidating whatever attempt was
   *  previously in flight for that same key. Returns the token this call
   *  now owns — pass it to every later progress/result report for this
   *  attempt. */
  start(key: string): number;
  /** True when `token` is still the CURRENT attempt for `key`. False means a
   *  newer attempt (a later Retry) has since started for the same photo, so
   *  this attempt's report — success OR failure — is stale and must be
   *  dropped, never applied to visible state. */
  isCurrent(key: string, token: number): boolean;
}

export function createPhotoAttemptGuard(): PhotoAttemptGuard {
  const tokens = new Map<string, number>();
  return {
    start(key) {
      const next = (tokens.get(key) ?? 0) + 1;
      tokens.set(key, next);
      return next;
    },
    isCurrent(key, token) {
      return tokens.get(key) === token;
    },
  };
}
