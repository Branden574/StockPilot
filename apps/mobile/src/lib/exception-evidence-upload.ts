import {
  EXCEPTION_EVIDENCE_CAP_COPY,
  EXCEPTION_EVIDENCE_EXTENSIONS,
  EXCEPTION_EVIDENCE_REJECTED_COPY,
  EXCEPTION_EVIDENCE_RESOLVED_COPY,
  EXCEPTION_EVIDENCE_UNCONFIRMED_COPY,
  EXCEPTION_EVIDENCE_UPLOAD_LIMIT_COPY,
} from '@stockpilot/core';

import { CONNECTION_FAILURE_COPY } from './connection-copy';
import {
  EVIDENCE_NO_PERMISSION_COPY,
  EVIDENCE_NOT_AVAILABLE_COPY,
  EVIDENCE_SERVER_PROBLEM_COPY,
  EVIDENCE_TOO_MANY_COPY,
  EvidenceResponseError,
  finalizeEvidence,
  reasonOf,
  sentenceOf,
  startEvidenceUpload,
  statusOf,
  type EvidenceResume,
  type EvidenceUploadTicket,
  type RecordedEvidence,
} from './exception-evidence';
import { PHOTO_PUT_FAILED_COPY, UploadError, uploadSignedPhoto } from './signed-photo-upload';

/**
 * ONE attempt at adding one photo to an exception (F1-4), over the shared
 * signed-photo orchestration (signed-photo-upload.ts, the same steps as
 * maintenance photos): resize -> mint -> native PUT -> finalize. There is no
 * client thumbnail: the server makes it from the cleaned photo.
 *
 * Kept apart from exception-evidence.ts because this imports the native file
 * and image modules; the pure module (shapes, parsing, words, rows) is what
 * exceptions-api.ts and the node tests load.
 */

/**
 * What a failed attempt means for the row that shows it:
 *   - `retry: 'upload'`: nothing was recorded and trying again is sensible
 *     (a dropped connection, a busy server, a rate limit): send the photo
 *     again from the start;
 *   - `retry: 'record'`: the photo reached the server but its answer did not
 *     reach the phone, so it may or may not be recorded. The retry records
 *     THAT upload (`resume`) rather than sending a second copy;
 *   - `retry: null`: trying again would get the same answer (resolved, the
 *     cap, no permission, a file the server refused). The row offers only
 *     Discard.
 */
export class EvidenceUploadFailure extends Error {
  constructor(
    message: string,
    public readonly retry: 'upload' | 'record' | null,
    public readonly resume: EvidenceResume | null,
  ) {
    super(message);
    this.name = 'EvidenceUploadFailure';
  }
}

/** The photo reached the server but was not confirmed (core's words, the
 *  web's too). */
export const EVIDENCE_UNCONFIRMED_COPY = EXCEPTION_EVIDENCE_UNCONFIRMED_COPY;

/** The longest a photo's PUT may run before it is cancelled and the row
 *  offers Retry and Discard. A resized photo is about 1 MB, so this allows
 *  roughly 11 KB a second. */
export const EVIDENCE_PUT_TIMEOUT_MS = 90_000;

/** The photo could not be read or converted on the phone. */
export const EVIDENCE_PREPARE_FAILED_COPY =
  'This photo could not be prepared for upload. Try again or choose another photo.';

function isAlreadyRecorded(e: unknown): boolean {
  return statusOf(e) === 409 && reasonOf(e) === 'already_recorded';
}

/** The words for a refusal every step can meet, or null for anything else. */
function refusal(e: unknown): EvidenceUploadFailure | null {
  const status = statusOf(e);
  const reason = reasonOf(e);
  if (status === 409 && reason === 'evidence_limit_reached') {
    return new EvidenceUploadFailure(EXCEPTION_EVIDENCE_CAP_COPY, null, null);
  }
  if (status === 409 && reason === 'occurrence_resolved') {
    return new EvidenceUploadFailure(EXCEPTION_EVIDENCE_RESOLVED_COPY, null, null);
  }
  if (status === 403) return new EvidenceUploadFailure(sentenceOf(e) ?? EVIDENCE_NO_PERMISSION_COPY, null, null);
  if (status === 404) return new EvidenceUploadFailure(EVIDENCE_NOT_AVAILABLE_COPY, null, null);
  return null;
}

/** A failure before the bytes reached the server. */
function beforeUploadFailure(e: unknown, stage: 'prepare' | 'mint' | 'put'): EvidenceUploadFailure {
  if (stage === 'prepare') return new EvidenceUploadFailure(EVIDENCE_PREPARE_FAILED_COPY, 'upload', null);
  if (stage === 'put' || (e instanceof UploadError && e.kind === 'upload_failed')) {
    // The server never received the bytes: nothing to clean up.
    return new EvidenceUploadFailure(PHOTO_PUT_FAILED_COPY, 'upload', null);
  }
  // An answer the phone could not read: nothing was uploaded yet.
  if (e instanceof EvidenceResponseError) return new EvidenceUploadFailure(e.message, 'upload', null);
  const known = refusal(e);
  if (known) return known;
  const status = statusOf(e);
  if (status === 409 && reasonOf(e) === 'rate_limited') {
    return new EvidenceUploadFailure(
      sentenceOf(e) ?? EXCEPTION_EVIDENCE_UPLOAD_LIMIT_COPY,
      'upload',
      null,
    );
  }
  if (status === 400) {
    return new EvidenceUploadFailure(sentenceOf(e) ?? EXCEPTION_EVIDENCE_REJECTED_COPY, null, null);
  }
  if (status === 429) return new EvidenceUploadFailure(EVIDENCE_TOO_MANY_COPY, 'upload', null);
  if (status !== null && status >= 500) return new EvidenceUploadFailure(EVIDENCE_SERVER_PROBLEM_COPY, 'upload', null);
  if (status === null) return new EvidenceUploadFailure(CONNECTION_FAILURE_COPY, 'upload', null);
  return new EvidenceUploadFailure(sentenceOf(e) ?? 'The photo could not be added.', null, null);
}

/** A failure once the bytes were on the server (finalize). */
function recordFailure(e: unknown, resume: EvidenceResume): EvidenceUploadFailure {
  const known = refusal(e);
  if (known) return known;
  const status = statusOf(e);
  const reason = reasonOf(e);
  // The server checked the bytes and refused them, and removed the upload.
  if (status === 400 && reason === 'invalid_image') {
    return new EvidenceUploadFailure(EXCEPTION_EVIDENCE_REJECTED_COPY, null, null);
  }
  if (status === 400) {
    return new EvidenceUploadFailure(sentenceOf(e) ?? EXCEPTION_EVIDENCE_REJECTED_COPY, null, null);
  }
  // The database was busy: nothing was recorded and the upload was removed,
  // so the retry sends the photo again.
  if (status === 409 && reason === 'busy') {
    return new EvidenceUploadFailure(
      sentenceOf(e) ?? 'This exception is busy. Please add the photo again.',
      'upload',
      null,
    );
  }
  // Refused before the server looked at it (its per-person limit): the
  // upload is still there to record.
  if (status === 429) return new EvidenceUploadFailure(EVIDENCE_TOO_MANY_COPY, 'record', resume);
  // No answer (offline, a timeout, an answer the phone could not read) or a
  // server fault: the photo may or may not be recorded. Record THIS upload
  // again rather than sending a second copy.
  if (status === null || status >= 500) {
    return new EvidenceUploadFailure(EVIDENCE_UNCONFIRMED_COPY, 'record', resume);
  }
  return new EvidenceUploadFailure(sentenceOf(e) ?? 'The photo could not be added.', null, null);
}

export interface EvidenceAttemptInput {
  occurrenceId: string;
  asset: { uri: string; fileName?: string };
  /** The device's clock when it was taken (evidenceCapturedAt), or null. */
  capturedAt: string | null;
  note: string | null;
  /** An upload whose answer was lost, recorded first (see EvidenceResume). */
  resume: EvidenceResume | null;
  onProgress: (fraction: number) => void;
  /** The bytes are on the server: the point a retry resumes from. */
  onUploaded?: (resume: EvidenceResume) => void;
}

/** `evidenceId` is null only when the server said this upload was already
 *  recorded (by an earlier attempt whose answer was lost). */
export interface EvidenceAttemptResult {
  evidenceId: string | null;
}

/**
 * ONE attempt at adding one photo. Throws EvidenceUploadFailure, never
 * anything else, so the row always has words and a retry decision.
 *
 * With `resume`, the earlier upload is recorded first: recorded now (or
 * already) is success; an upload the server has since removed (it answers
 * invalid_image once the file is gone) falls through to a fresh upload; any
 * other answer is the failure.
 */
export async function runEvidenceAttempt(input: EvidenceAttemptInput): Promise<EvidenceAttemptResult> {
  const { occurrenceId, capturedAt, note } = input;
  if (input.resume) {
    try {
      const ev = await finalizeEvidence(occurrenceId, { ...input.resume, capturedAt, note });
      return { evidenceId: ev.id };
    } catch (e) {
      if (isAlreadyRecorded(e)) return { evidenceId: null };
      const gone = statusOf(e) === 400 && reasonOf(e) === 'invalid_image';
      if (!gone) throw recordFailure(e, input.resume);
      // The upload is gone: send the photo again below.
    }
  }

  const at: { stage: 'prepare' | 'mint' | 'put' | 'record'; uploaded: EvidenceResume | null } = {
    stage: 'prepare',
    uploaded: null,
  };
  try {
    const ev = await uploadSignedPhoto<EvidenceUploadTicket, RecordedEvidence>(
      {
        // HEIC is converted by the resize; anything else outside the bucket's
        // types (a small GIF) is converted to JPEG before the mint.
        acceptedExtensions: EXCEPTION_EVIDENCE_EXTENSIONS,
        // ONLINE ONLY: a foreground session (the default background one waits
        // for a connection and can finish later on its own) and a time limit,
        // so a stalled upload ends as a row with Retry and Discard.
        putOptions: { foreground: true, timeoutMs: EVIDENCE_PUT_TIMEOUT_MS },
        mint: async (photo) => {
          at.stage = 'mint';
          const ticket = await startEvidenceUpload(occurrenceId, photo.ext);
          at.stage = 'put';
          return ticket;
        },
        onUploaded: (ticket, photo) => {
          at.stage = 'record';
          at.uploaded = { path: ticket.path, declaredMime: photo.declaredMime };
          input.onUploaded?.(at.uploaded);
        },
        // No thumbUploadUrl: the server makes the thumbnail from the cleaned
        // photo, so a client could never show a different picture.
        finalize: (ticket, photo) =>
          finalizeEvidence(occurrenceId, {
            path: ticket.path,
            declaredMime: photo.declaredMime,
            capturedAt,
            note,
          }),
      },
      input.asset,
      input.onProgress,
    );
    return { evidenceId: ev.id };
  } catch (e) {
    if (at.stage === 'record' && at.uploaded) {
      if (isAlreadyRecorded(e)) return { evidenceId: null };
      throw recordFailure(e, at.uploaded);
    }
    throw beforeUploadFailure(e, at.stage === 'record' ? 'put' : at.stage);
  }
}

/** Any throw, as the failure a row shows (runEvidenceAttempt throws only
 *  EvidenceUploadFailure; this is the belt for anything else). */
export function asEvidenceFailure(e: unknown): EvidenceUploadFailure {
  return e instanceof EvidenceUploadFailure ? e : new EvidenceUploadFailure(CONNECTION_FAILURE_COPY, 'upload', null);
}
