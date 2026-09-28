/**
 * Multi-photo upload for a maintenance request (Task 19). Mirrors the WEB
 * upload sequence step-for-step (maintenance-photos-panel.tsx's `uploadOne`):
 * resize/transcode -> mint -> PUT master (+ best-effort PUT thumb) ->
 * finalize.
 *
 * THE STEPS LIVE IN signed-photo-upload.ts (F1-4). `uploadSignedPhoto` there
 * is the one orchestration (and it documents the native-PUT and
 * `expo-file-system/legacy` landmines); this module supplies the maintenance
 * endpoints and their error mapping, so `uploadMaintenancePhoto` is a thin
 * wrapper with the behaviour it always had. `UploadError` and
 * `createPhotoAttemptGuard` moved with it, and `checkPhotoCap` moved to
 * photo-cap.ts (no native imports, so pure modules can use it); all three are
 * re-exported here, so every existing import keeps working.
 *
 * `uploadMaintenancePhoto` is intentionally stateless/idempotent: calling it
 * again for the same asset (a Retry tap) is a complete, independent attempt
 * with no leftover state from a failed one.
 */
import { type MaintenanceAttachmentKind } from '@stockpilot/core';

import { ApiError } from './api';
import { finalizePhoto, mintPhotoUpload, type MintPayload } from './maintenance-api';
import { UploadError, uploadSignedPhoto } from './signed-photo-upload';

export { checkPhotoCap } from './photo-cap';
export { UploadError, createPhotoAttemptGuard, type PhotoAttemptGuard } from './signed-photo-upload';

/** The sentence for any finalize refusal (the server's reason is not shown
 *  here; the maintenance screens have always said this). */
const MAINTENANCE_FINALIZE_REFUSED_COPY = 'That photo was refused by the server.';

export async function uploadMaintenancePhoto(
  requestId: string,
  asset: { uri: string; fileName?: string },
  onProgress: (fraction: number) => void,
  options?: { kind?: MaintenanceAttachmentKind },
): Promise<{ id: string }> {
  // Task 10 (migration 0317/spec §2.2): defaults to 'requester', matching
  // web's `MaintenancePhotosPanel` (kind prop default 'requester') — and,
  // like that panel, ALWAYS sent explicitly on both calls below rather than
  // omitted for the default case. `optional` on this options bag (not a
  // required 4th positional arg) keeps every existing 3-arg call site
  // (app/maintenance/new.tsx's requester-photo flow) compiling unchanged.
  const kind: MaintenanceAttachmentKind = options?.kind ?? 'requester';

  return uploadSignedPhoto<MintPayload, { id: string }>(
    {
      // Server mint (rate-limited, entity-checked). `kind` threaded through
      // explicitly (Task 10): createUploadUrl scopes its per-kind rate-limit
      // count and manage-gate on this, not just the finalize step.
      mint: (photo) =>
        mintPhotoUpload(requestId, {
          fileExt: photo.ext,
          originalFilename: photo.originalFilename,
          kind,
        }),
      // Route contract (maintenance-attachments.ts `createUploadUrl`): 409,
      // NEVER 429, on rate-limit. The server's own message is already the
      // right copy ("Too many uploads in the last hour...") and is forwarded
      // verbatim. Anything else passes through untouched.
      mapMintError: (err) =>
        err instanceof ApiError && err.status === 409
          ? new UploadError('rate_limited', err.message)
          : err,
      // The maintenance server still takes a client-made 400px thumbnail.
      thumbUploadUrl: (ticket) => ticket.thumbSignedUrl,
      // Finalize downloads + magic-byte-verifies before recording a row, so a
      // failure is a refusal, not a dropped connection. `kind` threaded
      // through explicitly (Task 10): this IS the step that records the kind
      // on the row; a mint-only threading would record every proof photo as
      // 'requester'.
      finalize: (ticket, photo) =>
        finalizePhoto(requestId, {
          path: ticket.path,
          thumbPath: ticket.thumbPath,
          originalFilename: photo.originalFilename,
          declaredMime: photo.declaredMime,
          kind,
        }),
      mapFinalizeError: () => new UploadError('rejected', MAINTENANCE_FINALIZE_REFUSED_COPY),
    },
    asset,
    onProgress,
  );
}
