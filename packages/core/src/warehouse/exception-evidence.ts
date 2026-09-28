/**
 * Photo evidence on exception occurrences (F1-4, migration 0375).
 *
 * ONE source for the web app and the phone: the limits the server and the
 * database enforce, and every sentence the photo panel and the timeline show.
 *
 * TWO CLOCKS, NAMED AS SUCH. A photo carries two times and they come from
 * different clocks:
 *   - `capturedAt`: when the photo was taken, by the DEVICE's clock, as the
 *     client reported it. A phone's clock can be wrong, so the copy always
 *     says whose clock it is.
 *   - `uploadedAt`: when the server recorded it (exception_evidence.created_at),
 *     by the SERVER's clock.
 *
 * ONLINE ONLY (owner decision F1 Q6). There is no offline photo queue, so the
 * offline copy says plainly that nothing is saved for later.
 */
import { formatOrgDateTime, resolveOrgTimezone } from '../time/org-timezone';

import { describeOccurrenceEvent } from './exceptions';

// ── Limits (the database is the authority; these match 0375) ──────────────

/** Live photos per occurrence (exception_evidence_record refuses the 9th).
 *  Removing a photo frees its slot. */
export const EXCEPTION_EVIDENCE_MAX_PHOTOS = 8;

/** Largest photo, in bytes: the exception-evidence bucket's file_size_limit. */
export const EXCEPTION_EVIDENCE_MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** A photo's note, and a removal's reason, in characters. */
export const EXCEPTION_EVIDENCE_NOTE_MAX = 500;

/** The types the bucket accepts. HEIC is converted to JPEG on the device. */
export const EXCEPTION_EVIDENCE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type ExceptionEvidenceContentType = (typeof EXCEPTION_EVIDENCE_CONTENT_TYPES)[number];

/** File extensions an upload may be minted for. */
export const EXCEPTION_EVIDENCE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'] as const;
export type ExceptionEvidenceExtension = (typeof EXCEPTION_EVIDENCE_EXTENSIONS)[number];

/** How far ahead of the server a device's capture time may run and still be
 *  recorded (the database refuses more; the server drops it instead). */
export const EXCEPTION_EVIDENCE_CAPTURE_SKEW_MS = 5 * 60 * 1000;

/** The type an extension stands for. */
export function exceptionEvidenceTypeForExtension(
  ext: string,
): ExceptionEvidenceContentType | null {
  switch (ext.toLowerCase()) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    default:
      return null;
  }
}

// ── Panel copy ─────────────────────────────────────────────────────────────

/** Why Add photo is disabled while offline. Nothing is queued. */
export const EXCEPTION_EVIDENCE_OFFLINE_COPY =
  'Adding photos needs a connection. Photos are not saved offline; add them once you are back online.';

/** Why Add photo is not offered to this reader. */
export const EXCEPTION_EVIDENCE_NOT_PERMITTED_COPY =
  "You can view these photos. Adding one needs permission to adjust stock in this exception's warehouse.";

/** Why photos can no longer change on a resolved occurrence. */
export const EXCEPTION_EVIDENCE_RESOLVED_COPY =
  'This exception is resolved, so its photos can no longer be added or removed.';

/** Why Add photo is disabled at the cap. */
export const EXCEPTION_EVIDENCE_CAP_COPY = `An exception can hold at most ${EXCEPTION_EVIDENCE_MAX_PHOTOS} photos. Remove one to add another.`;

/** A failed photo read. Never shown as "no photos". */
export const EXCEPTION_EVIDENCE_UNAVAILABLE_COPY = 'Photos could not be loaded right now.';

/** Shown when there are none (only after a successful read). */
export const EXCEPTION_EVIDENCE_NONE_COPY = 'No photos yet.';

/** The server refused the file (wrong type, not an image, too large). */
export const EXCEPTION_EVIDENCE_REJECTED_COPY =
  'That file could not be added. Use a JPEG, PNG or WEBP photo up to 10 MB.';

/** What the panel says about location data, so nobody has to wonder. */
export const EXCEPTION_EVIDENCE_PRIVACY_COPY =
  'Location and camera details are removed from each photo when it is saved.';

/** The limits, stated where photos are added (the database enforces them). */
export const EXCEPTION_EVIDENCE_LIMITS_COPY = `Up to ${EXCEPTION_EVIDENCE_MAX_PHOTOS} photos on an exception, each a JPEG, PNG or WEBP of up to ${EXCEPTION_EVIDENCE_MAX_PHOTO_BYTES / (1024 * 1024)} MB.`;

/** A note longer than the limit (the server's words and the phone's). */
export const EXCEPTION_EVIDENCE_NOTE_TOO_LONG_COPY = `Notes can be at most ${EXCEPTION_EVIDENCE_NOTE_MAX} characters.`;

/** A removal reason longer than the limit. */
export const EXCEPTION_EVIDENCE_REASON_TOO_LONG_COPY = `A reason can be at most ${EXCEPTION_EVIDENCE_NOTE_MAX} characters.`;

/** The server refused an upload for this reader (the act gate). */
export const EXCEPTION_EVIDENCE_NO_PERMISSION_COPY =
  'You do not have permission to add photos to this exception.';

/** The server refused a removal: neither the uploader nor a manager. */
export const EXCEPTION_EVIDENCE_REMOVE_NOT_ALLOWED_COPY =
  'Only the person who added a photo, or a manager, can remove it.';

/** The per-person upload limit (60 an hour) was reached. */
export const EXCEPTION_EVIDENCE_UPLOAD_LIMIT_COPY =
  'Too many photo uploads in the last hour. Please try again later.';

/** The per-person limit on recording photos (a burst of finalizes) was
 *  reached. The upload is kept: Retry records the same one. */
export const EXCEPTION_EVIDENCE_FINALIZE_LIMIT_COPY =
  'Too many photos are being added right now. Wait a moment, then Retry.';

/** The photo reached the server, but its answer did not come back, so it may
 *  or may not be recorded. Retry records THAT upload (never a second copy).
 *  Shown after "Not confirmed." on web and phone. */
export const EXCEPTION_EVIDENCE_UNCONFIRMED_COPY =
  'The photo was sent, but the server did not confirm it. Retry to finish adding it.';

/** Why Remove is disabled offline (removing needs a connection too). */
export const EXCEPTION_EVIDENCE_REMOVE_OFFLINE_COPY =
  'You are offline. Removing a photo needs a connection.';

/** One photo that did not load (its link expired, or the file could not be
 *  read). Never a blank space where a photo should be. */
export const EXCEPTION_EVIDENCE_PHOTO_FAILED_COPY =
  'This photo could not be loaded. Try again to get a fresh link.';

/** What removing a photo does, said before it is done (exception_evidence_remove
 *  is a soft remove: the row and the stored file are kept, and an
 *  evidence_removed event records who removed it and why). */
export const EXCEPTION_EVIDENCE_REMOVE_COPY =
  'The photo will no longer show on this exception. It is not deleted: the file is kept, and the timeline records who removed it, with your reason if you give one.';

/** "Photos (3 of 8)". */
export function exceptionEvidenceCountLabel(liveCount: number): string {
  const n = Math.max(0, Math.floor(liveCount));
  return `Photos (${n} of ${EXCEPTION_EVIDENCE_MAX_PHOTOS})`;
}

/** Who added a photo, under the photo: "Added by Maria Lopez". The label is
 *  the one the service gives (a name, else an email, else "Former member"). */
export function exceptionEvidenceAddedByCopy(uploaderLabel: string | null | undefined): string {
  const who = uploaderLabel?.trim();
  return who ? `Added by ${who}` : 'Added by a former member';
}

/**
 * Why Add photo is unavailable, or null when it is available. `canAct` is the
 * server's hint for this reader (the database re-checks every upload). The
 * order is exceptionActDisabledReason's: a resolved row and a reader without
 * permission are told so even offline, because reconnecting would not change
 * their answer; the cap comes last, since removing a photo (online) frees it.
 */
export function exceptionEvidenceAddDisabledReason(input: {
  resolved: boolean;
  canAct: boolean;
  online: boolean;
  liveCount: number;
}): string | null {
  if (input.resolved) return EXCEPTION_EVIDENCE_RESOLVED_COPY;
  if (!input.canAct) return EXCEPTION_EVIDENCE_NOT_PERMITTED_COPY;
  if (!input.online) return EXCEPTION_EVIDENCE_OFFLINE_COPY;
  if (input.liveCount >= EXCEPTION_EVIDENCE_MAX_PHOTOS) return EXCEPTION_EVIDENCE_CAP_COPY;
  return null;
}

/**
 * Whether Remove is offered on one photo: the database's rule as a display
 * hint (exception_evidence_remove re-checks it). The reader passes the act
 * gate (`canAct`), and it is their own photo or they are a manager; the
 * occurrence is open; the photo is live.
 */
export function canRemoveExceptionEvidence(input: {
  resolved: boolean;
  canAct: boolean;
  removed: boolean;
  viewerIsUploader: boolean;
  viewerIsManager: boolean;
}): boolean {
  if (input.resolved || input.removed || !input.canAct) return false;
  return input.viewerIsUploader || input.viewerIsManager;
}

// ── Timeline copy ──────────────────────────────────────────────────────────

const DATE_OPTS: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
const TIME_OPTS: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
const DAY_TIME_OPTS: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

function validIso(value: string | null | undefined): string | null {
  if (!value) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * The two times of one photo, each named by its clock:
 *   "Taken 10:02 AM (device's clock) · uploaded 10:40 AM (server's clock)"
 * Dates are added when the two fall on different days in the org's zone.
 * With no capture time: "Uploaded Sep 27, 10:40 AM (server's clock). The
 * device did not say when it was taken."
 */
export function exceptionEvidenceTimesCopy(
  photo: { capturedAt: string | null | undefined; uploadedAt: string | null | undefined },
  timeZone?: string | null,
): string {
  const tz = resolveOrgTimezone(timeZone);
  const captured = validIso(photo.capturedAt);
  const uploaded = validIso(photo.uploadedAt);
  if (!uploaded) {
    return captured
      ? `Taken ${formatOrgDateTime(captured, DAY_TIME_OPTS, tz)} (device's clock). Upload time not available.`
      : 'Upload time not available.';
  }
  if (!captured) {
    return `Uploaded ${formatOrgDateTime(uploaded, DAY_TIME_OPTS, tz)} (server's clock). The device did not say when it was taken.`;
  }
  const sameDay =
    formatOrgDateTime(captured, DATE_OPTS, tz) === formatOrgDateTime(uploaded, DATE_OPTS, tz);
  const opts = sameDay ? TIME_OPTS : DAY_TIME_OPTS;
  return `Taken ${formatOrgDateTime(captured, opts, tz)} (device's clock) · uploaded ${formatOrgDateTime(uploaded, opts, tz)} (server's clock)`;
}

/**
 * One evidence event in the timeline: the headline ("Photo added by Maria",
 * "Photo removed by Maria", from describeOccurrenceEvent), the detail line
 * (the photo's two times, for an added photo), and the note (the photo's
 * note, or the reason it was removed), each rendered by the screen as it
 * renders other events.
 */
export function describeEvidenceEvent(event: {
  kind: 'evidence_added' | 'evidence_removed';
  actorLabel: string | null;
  capturedAt?: string | null;
  uploadedAt?: string | null;
  note?: string | null;
  timeZone?: string | null;
}): { headline: string; detail: string | null; note: string | null } {
  const headline = describeOccurrenceEvent({ kind: event.kind, actorLabel: event.actorLabel });
  const note = event.note?.trim() || null;
  if (event.kind === 'evidence_removed') {
    return { headline, detail: null, note: note ? `Reason: ${note}` : null };
  }
  return {
    headline,
    detail: exceptionEvidenceTimesCopy(
      { capturedAt: event.capturedAt ?? null, uploadedAt: event.uploadedAt ?? null },
      event.timeZone,
    ),
    note,
  };
}
