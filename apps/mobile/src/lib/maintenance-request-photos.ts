import { MAINTENANCE_MAX_PHOTOS } from '@stockpilot/core';

import { checkPhotoCap } from './maintenance-upload';

/**
 * Pure decision helpers behind the maintenance DETAIL screen's request-photo
 * card (app/maintenance/[id].tsx) — the native counterpart of web's
 * `MaintenancePhotosPanel` (apps/web/src/components/maintenance/
 * maintenance-photos-panel.tsx).
 *
 * WHY THIS MODULE EXISTS AT ALL: until now a phone could only attach photos
 * to a maintenance request during the post-create step of
 * app/maintenance/new.tsx (gated behind `createdId`), and there was no route
 * back to that step. Once a request existed, the device standing in front of
 * the broken thing had no way to add a photo to it. The detail screen's only
 * pickers uploaded `kind: 'resolution'` — close-out PROOF photos, manage-only
 * and semantically different. This module carries every DECISION the new
 * request-photo card makes so it can be tested for real: this repo's vitest
 * cannot render `app/` screens (they import native modules at module load —
 * see vitest.config.ts), the same "source-pin honesty" posture
 * maintenance-filters.ts / maintenance-actions.ts established.
 *
 * TRANSPORT IS NOT REDEFINED HERE. The upload itself stays
 * `uploadMaintenancePhoto` (maintenance-upload.ts): resize/HEIC-transcode ->
 * mint -> native `FileSystem.createUploadTask` PUT -> finalize. That native
 * file read is load-bearing (`fetch(uri).blob()` uploads 0 bytes on Expo, and
 * expo/fetch refuses RN's `{uri,name,type}` FormData convention) and the cap
 * check (`checkPhotoCap`) and stale-attempt guard (`createPhotoAttemptGuard`)
 * already live there too. This module only decides WHEN the affordance shows,
 * WHAT it counts against the cap, and WHICH copy it says.
 */

/**
 * One queued upload attempt on the detail screen. Shared by BOTH photo
 * queues on that screen — the new request-photo card (`kind: 'requester'`)
 * and the close-out card's proof-photo picker (`kind: 'resolution'`) — so the
 * two never drift into separate hand-typed shapes.
 *
 * `attachmentId` is only ever set from `uploadMaintenancePhoto`'s OWN return
 * value (the finalize row id). It is what `reconcileRequestPhotoQueue` below
 * matches against the server's photo list, so a finished row is retired
 * exactly when the grid can actually show it — never on a hopeful timer, and
 * never before the server confirms the row exists.
 */
export interface MaintenancePhotoQueueEntry {
  key: string;
  uri: string;
  fileName?: string;
  status: 'uploading' | 'done' | 'error';
  progress: number;
  message?: string;
  attachmentId?: string;
}

/** Web parity: `MaintenancePhotosPanel`'s per-photo failure copy is whatever
 *  the server/transport said; this is only the last-resort fallback for a
 *  non-Error throw, passed to `mapActionError` (maintenance-actions.ts) so
 *  the real reason is never blurred into a generic sentence. */
export const PHOTO_UPLOAD_GENERIC_ERROR = 'Photo upload failed. Try again.';

/** Verbatim from web's detail page (page.tsx) closed-request branch. */
export const REQUEST_PHOTOS_CLOSED_NOTICE =
  'This request is closed. Photos can no longer be added or removed.';

/** Verbatim from web's detail page closed-and-empty branch. */
export const REQUEST_PHOTOS_EMPTY_CLOSED = 'No photos were added to this request.';

/**
 * Native counterpart of the web panel's empty hint ("Drag photos here, or use
 * your camera. HEIC photos are converted automatically."). The drag half has
 * no meaning on a phone, so it names the two real sources instead; the HEIC
 * sentence is kept word-for-word because it describes a real, shared
 * behavior — `resizeForUpload` transcodes iOS HEIC before anything is sent.
 */
export const REQUEST_PHOTOS_EMPTY_EDITABLE =
  'Take a photo or choose one from your library. HEIC photos are converted automatically.';

/** Section label above the camera/library pair, matching the web panel's
 *  "Add photos" button label (and this screen's own RESOLVE_ADD_PHOTO_LABEL
 *  idiom for the proof-photo picker). */
export const REQUEST_PHOTOS_ADD_LABEL = 'Add photos';

/**
 * Shown when a photo uploaded successfully but the follow-up read of the
 * request could not refresh the grid. Deliberately does NOT claim the upload
 * failed — it succeeded, the server holds it, only this screen's copy of the
 * list is stale. The queue row stays visible (status 'done') underneath, so
 * the photo is never silently unaccounted for.
 */
export const REQUEST_PHOTOS_REFRESH_ERROR =
  'The photo was saved. This list could not refresh just now — reopen the request to see it.';

export interface RequestPhotoEditability {
  /** True when the camera/library affordance should render. */
  canAdd: boolean;
  /** Non-null only when the request is closed, carrying the exact sentence
   *  web shows in that state. */
  closedNotice: string | null;
}

/**
 * Add-affordance visibility, matching the WEB PANEL'S OWN GATE and nothing
 * more (page.tsx: `closed = Boolean(detail.archivedAt || detail.cancelledAt ||
 * detail.resolvedAt)`; closed renders a read-only grid plus
 * REQUEST_PHOTOS_CLOSED_NOTICE, open renders the editable panel).
 *
 * NO EXTRA CLIENT-SIDE AUTHORIZATION RULE IS INVENTED HERE. The real write
 * boundary is the server's (`MaintenanceAttachmentsService`.
 * assertParentOwnedAndOpen: module enabled, `maintenance_requests:submit`,
 * and requester-owned OR `maintenance_requests:manage`), re-enforced at BOTH
 * mint and finalize. Web shows the panel to every viewer who can open the
 * page and lets that server rule speak; mobile does the same, and a refusal
 * surfaces as the server's own message on the failed photo row (never a
 * silent no-op, never a fabricated local rule that could hide the affordance
 * from someone the server would have allowed).
 */
export function requestPhotosEditability(d: {
  archivedAt: string | null;
  cancelledAt: string | null;
  resolvedAt: string | null;
}): RequestPhotoEditability {
  const closed = Boolean(d.archivedAt || d.cancelledAt || d.resolvedAt);
  return {
    canAdd: !closed,
    closedNotice: closed ? REQUEST_PHOTOS_CLOSED_NOTICE : null,
  };
}

/**
 * Card heading, e.g. `PHOTOS · 2/8`. Mirrors the web panel's own
 * "Photos (n/MAINTENANCE_MAX_PHOTOS)" counter — a running count against the
 * cap, not a bare total — rendered in this screen's Eyebrow/Mono voice. The
 * cap comes from the shared constant, never a hand-typed 8.
 */
export function requestPhotosHeading(count: number): string {
  return `PHOTOS · ${count}/${MAINTENANCE_MAX_PHOTOS}`;
}

/**
 * Empty-state copy, or null when the card has something to show. `queued`
 * counts rows still visible in the upload queue: web hides its empty hint the
 * moment an upload is in flight (`photos.length > 0 ? grid : uploads.length
 * === 0 ? hint : null`), and so does this.
 */
export function requestPhotosEmptyCopy(args: {
  photoCount: number;
  queued: number;
  canAdd: boolean;
}): string | null {
  if (args.photoCount > 0 || args.queued > 0) return null;
  return args.canAdd ? REQUEST_PHOTOS_EMPTY_EDITABLE : REQUEST_PHOTOS_EMPTY_CLOSED;
}

/**
 * Cap arithmetic for a new selection, mirroring the web panel's
 * "existing + already-queued + incoming > cap" refusal and reusing the SAME
 * tested `checkPhotoCap` (maintenance-upload.ts) so both platforms and both
 * mobile screens share one message.
 *
 * The subtle part is what "existing" means on a screen that ALSO holds server
 * truth: a row that has finished uploading is real on the server but is not
 * yet in `serverPhotoCount` until the next read lands, so it is counted here
 * — and `reconcileRequestPhotoQueue` retires it the instant the read includes
 * it, so the same photo is never counted twice. Getting this wrong in either
 * direction is a real bug: double-counting refuses a legal 8th photo, and
 * dropping the finished rows lets a burst mint past the cap before the server
 * re-refuses it.
 */
export function requestPhotoCapCheck(args: {
  serverPhotoCount: number;
  entries: readonly Pick<MaintenancePhotoQueueEntry, 'status'>[];
  incoming: number;
}): { ok: true } | { ok: false; message: string } {
  const uploaded = args.entries.filter((e) => e.status === 'done').length;
  const pending = args.entries.filter((e) => e.status === 'uploading').length;
  return checkPhotoCap({
    existing: args.serverPhotoCount + uploaded,
    pending,
    incoming: args.incoming,
  });
}

/**
 * Retires finished queue rows once the server's own photo list can show them,
 * which is how the grid stays the single source of truth for what is attached
 * (web does the same thing by dropping the upload row and refetching on
 * success).
 *
 * A 'done' row is dropped ONLY when its `attachmentId` is actually present in
 * `serverPhotoIds`. A finished row whose id has not appeared yet — a refresh
 * that failed, or a read that raced the insert — is deliberately KEPT: it is
 * the only remaining on-screen evidence that those bytes were saved, and
 * dropping it would make a successful upload vanish from the screen entirely.
 * 'uploading' and 'error' rows are never touched here; only the user's own
 * Retry or a completed attempt moves those.
 */
export function reconcileRequestPhotoQueue<
  T extends Pick<MaintenancePhotoQueueEntry, 'status' | 'attachmentId'>,
>(entries: readonly T[], serverPhotoIds: readonly string[]): T[] {
  const known = new Set(serverPhotoIds);
  return entries.filter(
    (e) => !(e.status === 'done' && e.attachmentId !== undefined && known.has(e.attachmentId)),
  );
}

export interface PhotoPermissionDenial {
  title: string;
  message: string;
}

/**
 * Denial copy for a refused camera / photo-library permission, keyed on
 * expo-image-picker's `canAskAgain`. The distinction is the whole point: when
 * the OS will still prompt, the fix is "allow it in the prompt"; once it will
 * not, the ONLY fix is the Settings app, and saying "allow in the prompt"
 * there sends someone to a prompt that will never appear again.
 *
 * app/maintenance/new.tsx already draws this distinction for the camera; its
 * library branch shows one flat sentence regardless. Both sources go through
 * this one function now, so neither can be actionable while the other is not.
 */
export function photoPermissionDenial(
  source: 'camera' | 'library',
  canAskAgain: boolean,
): PhotoPermissionDenial {
  if (source === 'camera') {
    return {
      title: 'Camera access needed',
      message: canAskAgain
        ? 'Allow camera in the prompt to take photos.'
        : 'Camera permission is denied. Enable it in Settings, under StockPilot.',
    };
  }
  return {
    title: 'Photo access needed',
    message: canAskAgain
      ? 'Allow photo library access in the prompt to attach images.'
      : 'Photo library permission is denied. Enable it in Settings, under StockPilot.',
  };
}
