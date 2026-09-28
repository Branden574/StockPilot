import 'server-only';

import {
  EXCEPTION_EVIDENCE_CAP_COPY,
  EXCEPTION_EVIDENCE_CAPTURE_SKEW_MS,
  EXCEPTION_EVIDENCE_EXTENSIONS,
  EXCEPTION_EVIDENCE_FINALIZE_LIMIT_COPY,
  EXCEPTION_EVIDENCE_MAX_PHOTO_BYTES,
  EXCEPTION_EVIDENCE_MAX_PHOTOS,
  EXCEPTION_EVIDENCE_NO_PERMISSION_COPY,
  EXCEPTION_EVIDENCE_NOTE_MAX,
  EXCEPTION_EVIDENCE_NOTE_TOO_LONG_COPY,
  EXCEPTION_EVIDENCE_REASON_TOO_LONG_COPY,
  EXCEPTION_EVIDENCE_REJECTED_COPY,
  EXCEPTION_EVIDENCE_REMOVE_NOT_ALLOWED_COPY,
  EXCEPTION_EVIDENCE_RESOLVED_COPY,
  EXCEPTION_EVIDENCE_UPLOAD_LIMIT_COPY,
  exceptionEvidenceTypeForExtension,
  isManagerOrAbove,
  type ExceptionEvidenceContentType,
} from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';
import { reencodeWithoutMetadata } from '@/lib/image-reencode';
import { isSniffedKindAllowedInBucket, MIME_FOR_KIND, sniffImage } from '@/lib/image-signature';
import { checkRateLimit } from '@/lib/rate-limit';
import {
  exceptionEvidencePathShape,
  exceptionEvidenceThumbPath,
  exceptionEvidenceUploadNames,
  isValidStoragePath,
} from '@/lib/storage-path';
import { createAdminClient } from '@/lib/supabase/admin';

import { audit } from './audit';
import { assertPermission, ServiceError, type ServiceContext } from './context';
import { ExceptionOccurrencesService, type ActableOccurrence } from './exception-occurrences';
import { EXCEPTION_EVIDENCE_BUCKET } from './lib/exception-evidence-read';
import { postgrestErrorText } from './lib/postgrest-error';

/**
 * PHOTO EVIDENCE on exception occurrences (F1-4, migration 0375). Built like
 * MaintenanceAttachmentsService: the client never talks to Storage without a
 * server mint, and nothing is recorded until the server has looked at the
 * bytes.
 *
 *   1. createUploadUrl: the act gate, the occurrence open, an allowed
 *      extension, the per-user upload limit (60 an hour, and REFUSING when the
 *      limiter itself fails), and the live cap; then one signed upload URL for
 *      `{org}/{occurrence}/{uuid}.{ext}`, signed with the caller's session
 *      (the bucket's INSERT policy is the floor).
 *   2. The client PUTs the photo.
 *   3. finalize: the STRICT path shape before anything else; the per-person
 *      finalize limit (30 a minute, REFUSING when the limiter fails: each
 *      finalize downloads and re-encodes up to 10 MB); the same gate; the
 *      whole object read and sniffed against the declared type, within the
 *      size cap; then the whole object is re-encoded WITHOUT its metadata
 *      (EXIF, GPS) and written back over itself, with a thumbnail the server
 *      makes and names under a FRESH uuid of its own; then
 *      exception_evidence_record (service role) re-checks everything under a
 *      lock and writes the row and the timeline event.
 *
 *      A REFUSAL deletes the upload (still the original, GPS included) and
 *      this finalize's own thumbnail, and records nothing, WHEREVER it comes
 *      from after the path check: the gate, a resolved occurrence, the note,
 *      the capture time, the cap, the bytes, the write-back or the database.
 *      Every deletion goes through refuseUpload, which first asks whether a
 *      photo is recorded at that path: if one is (a racing or earlier
 *      finalize of the same upload), its file is never deleted and the answer
 *      is "already recorded"; if the question cannot be answered, nothing is
 *      deleted. The thumbnail's fresh name means no finalize can ever reach
 *      another photo's thumbnail (review findings 2026-09-27). Two things are
 *      NOT deleted: an upload the limiter refused (the same finalize can be
 *      sent again), and anything after a database fault (a retry may still
 *      record it).
 *   4. remove: the uploader or a manager, through the same gate, while the
 *      occurrence is open; a SOFT remove through exception_evidence_remove as
 *      the user. The file is kept.
 *
 * Photos need a connection (owner decision F1 Q6): there is no offline
 * queue, so nothing here is idempotent across a lost network the way the
 * act route's clientEventId is. A retry starts again from the mint.
 *
 * Gates match the other exception routes: no module gate (the Exception
 * Center rides items:read), items:read + stock:adjust + write access to the
 * occurrence's warehouse (ExceptionOccurrencesService.requireActable, the one
 * app-side copy of the gate). No new push notifications.
 */

/** Uploads a user may start in UPLOAD_LIMIT_WINDOW_MS. */
export const EVIDENCE_UPLOAD_LIMIT = 60;
export const EVIDENCE_UPLOAD_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/** Finalizes a user may send in FINALIZE_LIMIT_WINDOW_MS. Checked in the
 *  service, so the /api/v1 route and the web action share it, and CLOSED:
 *  when the limiter cannot answer, nothing is downloaded or re-encoded. */
export const EVIDENCE_FINALIZE_LIMIT = 30;
export const EVIDENCE_FINALIZE_LIMIT_WINDOW_MS = 60 * 1000;

const ALLOWED_EXTS: ReadonlySet<string> = new Set(EXCEPTION_EVIDENCE_EXTENSIONS);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EvidenceUploadTicket {
  /** Where the photo goes; send it back to finalize unchanged. */
  path: string;
  signedUrl: string;
  token: string;
  /** The type the PUT must declare, from the extension. */
  contentType: ExceptionEvidenceContentType;
  maxBytes: number;
}

export interface EvidenceFinalizeInput {
  path: string;
  /** The type the client declared for its PUT; the bytes must agree. */
  declaredMime: string;
  /** The device's capture time (ISO 8601), if it knows it. */
  capturedAt?: string | null;
  note?: string | null;
}

export interface RecordedEvidence {
  id: string;
  contentType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  capturedAt: string | null;
  uploadedAt: string;
}

export interface RemovedEvidence {
  id: string;
  removedAt: string;
}

type EvidenceRpcRow = {
  id: string;
  storage_path?: string;
  thumbnail_path?: string | null;
  content_type: string;
  byte_size: number | string;
  captured_at: string | null;
  created_at: string;
  removed_at: string | null;
};

type AdminStore = ReturnType<ReturnType<typeof createAdminClient>['storage']['from']>;

export class ExceptionEvidenceService {
  constructor(private readonly ctx: ServiceContext) {}

  /** The act gate on an OPEN occurrence (photos cannot change once it is
   *  resolved). */
  private async requireOpenActable(occurrenceId: string): Promise<ActableOccurrence> {
    const occ = await new ExceptionOccurrencesService(this.ctx).requireActable(occurrenceId);
    if (occ.resolvedAt !== null) throw resolvedError();
    return occ;
  }

  /** Live photos on the occurrence, through the caller's client. A failed
   *  count THROWS: an unknown count is never read as room to spare. */
  private async liveCount(occurrenceId: string): Promise<number> {
    const { count, error } = await this.ctx.supabase
      .from('exception_evidence')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', this.ctx.organizationId)
      .eq('occurrence_id', occurrenceId)
      .is('removed_at', null);
    if (error) throw new ServiceError('internal_error', postgrestErrorText(error));
    if (typeof count !== 'number')
      throw new ServiceError('internal_error', 'exception_evidence count missing');
    return count;
  }

  async createUploadUrl(
    occurrenceId: string,
    args: { fileExt: string },
  ): Promise<EvidenceUploadTicket> {
    const occ = await this.requireOpenActable(occurrenceId);

    const ext = String(args.fileExt ?? '')
      .replace(/[^a-z0-9]/gi, '')
      .toLowerCase();
    const contentType = exceptionEvidenceTypeForExtension(ext);
    if (!ALLOWED_EXTS.has(ext) || !contentType) {
      throw new ServiceError(
        'validation_error',
        'Photos must be JPEG, PNG or WEBP. HEIC is converted on your device before upload.',
        { reason: 'invalid_extension' },
      );
    }

    // 'closed': when the limiter cannot answer, no upload starts.
    const limit = await checkRateLimit(
      `exceptions:evidence:upload:${this.ctx.userId}`,
      EVIDENCE_UPLOAD_LIMIT,
      EVIDENCE_UPLOAD_LIMIT_WINDOW_MS,
      'closed',
    );
    if (!limit.allowed) {
      throw new ServiceError('conflict', EXCEPTION_EVIDENCE_UPLOAD_LIMIT_COPY, {
        reason: 'rate_limited',
      });
    }

    if ((await this.liveCount(occ.id)) >= EXCEPTION_EVIDENCE_MAX_PHOTOS) throw capError();

    const path = `${this.ctx.organizationId}/${occ.id}/${crypto.randomUUID()}.${ext}`;
    const { data, error } = await this.ctx.supabase.storage
      .from(EXCEPTION_EVIDENCE_BUCKET)
      .createSignedUploadUrl(path);
    if (error || !data)
      throw new ServiceError('internal_error', error?.message ?? 'Could not start the upload.');
    return {
      path,
      signedUrl: data.signedUrl,
      token: data.token,
      contentType,
      maxBytes: EXCEPTION_EVIDENCE_MAX_PHOTO_BYTES,
    };
  }

  async finalize(occurrenceId: string, input: EvidenceFinalizeInput): Promise<RecordedEvidence> {
    if (!UUID.test(occurrenceId)) throw new ServiceError('not_found', 'Exception not found.');

    // STRICT shape FIRST, against the occurrence in the request
    // (maintenance-attachments.ts's validateFinalizePath: a prefix check alone
    // is escapable with `..`). Nothing is read, written or deleted for a path
    // of the wrong shape; every later refusal can then clean up this path.
    const path = String(input.path ?? '');
    if (
      !isValidStoragePath(path, exceptionEvidencePathShape(this.ctx.organizationId, occurrenceId))
    ) {
      throw new ServiceError('forbidden', 'Invalid upload path.', { reason: 'invalid_path' });
    }

    // The per-person limit, CLOSED (see EVIDENCE_FINALIZE_LIMIT). Refused
    // here, the upload is kept: the same finalize can be sent again.
    const limit = await checkRateLimit(
      `exceptions:evidence:finalize:${this.ctx.userId}`,
      EVIDENCE_FINALIZE_LIMIT,
      EVIDENCE_FINALIZE_LIMIT_WINDOW_MS,
      'closed',
    );
    if (!limit.allowed) {
      throw new ServiceError('conflict', EXCEPTION_EVIDENCE_FINALIZE_LIMIT_COPY, {
        reason: 'rate_limited',
        retryAt: limit.resetAt,
      });
    }

    const admin = createAdminClient();
    const store = admin.storage.from(EXCEPTION_EVIDENCE_BUCKET);
    // The thumbnail THIS finalize wrote, once it has written one.
    let thumbPath: string | null = null;
    const refuse = (err: ServiceError, recordedWins = true) =>
      this.refuseUpload(err, admin, store, path, thumbPath, recordedWins);

    // The gate. A definite refusal cleans up; a database fault leaves the
    // upload for a retry of this finalize. A resolved occurrence is refused
    // only after the gate passed, so for it (and only then) a recorded upload
    // answers "already recorded" (a lost answer, then the sync resolved it).
    let occ: ActableOccurrence;
    try {
      occ = await this.requireOpenActable(occurrenceId);
    } catch (e) {
      if (e instanceof ServiceError && e.code !== 'internal_error') {
        throw await refuse(e, e.details?.reason === 'occurrence_resolved');
      }
      throw e;
    }

    const note = (input.note ?? '').trim() || null;
    if (note !== null && Array.from(note).length > EXCEPTION_EVIDENCE_NOTE_MAX) {
      throw await refuse(
        new ServiceError('validation_error', EXCEPTION_EVIDENCE_NOTE_TOO_LONG_COPY, {
          reason: 'note_too_long',
        }),
      );
    }
    let capturedAt: string | null;
    try {
      capturedAt = normalizeCapturedAt(input.capturedAt);
    } catch (e) {
      if (e instanceof ServiceError) throw await refuse(e);
      throw e;
    }
    const ext = path.slice(path.lastIndexOf('.') + 1);

    // 0. Nothing is written to storage for an upload that is already
    //    recorded. The steps below write the re-encoded photo back over the
    //    upload, so without this a second finalize of a recorded photo would
    //    replace its file (and a lossy re-encode of a re-encode is not the
    //    photo that was recorded). ONE UPLOAD NAME, ONE PHOTO (0375): another
    //    extension of a recorded upload's uuid is not this upload, and none of
    //    that photo's files is touched. A failed look throws, deleting nothing.
    const recorded = await this.findRecorded(admin, path);
    if (recorded) {
      if (recorded.storage_path === path) throw alreadyRecordedError();
      throw await refuse(
        new ServiceError('forbidden', 'Invalid upload path.', { reason: 'invalid_path' }),
      );
    }

    const reject = async (): Promise<never> => {
      throw await refuse(
        new ServiceError('validation_error', EXCEPTION_EVIDENCE_REJECTED_COPY, {
          reason: 'invalid_image',
        }),
      );
    };

    // The cap, before the expensive part (the bucket's INSERT policy lets a
    // member put objects in their org's folder without a mint, so a finalize
    // is not proof that the mint's own cap check ran). The database re-checks
    // under its lock.
    if ((await this.liveCount(occ.id)) >= EXCEPTION_EVIDENCE_MAX_PHOTOS) {
      throw await refuse(capError());
    }

    // 1. The declared type must be the extension's, and the bytes must be
    //    what both say (never the client's word alone).
    //
    //    The WHOLE object is read, not a 4 KB range as maintenance finalize
    //    does: step 2 re-encodes all of it anyway, and the bucket caps it at
    //    10 MB. It also sidesteps a storage-api fault seen locally
    //    (v1.58.1): a range that runs past the end of an object under 4 KB
    //    is answered 206 with a Content-Length it never sends, so the read
    //    hangs until the socket dies. A failed read means the object was never
    //    uploaded or cannot be checked: refused, and removed.
    if (exceptionEvidenceTypeForExtension(ext) !== input.declaredMime) return reject();
    const whole = await downloadWhole(store, path);
    if (!whole || whole.byteLength === 0 || whole.byteLength > EXCEPTION_EVIDENCE_MAX_PHOTO_BYTES)
      return reject();
    const sniffed = sniffImage(whole);
    if (
      !sniffed ||
      MIME_FOR_KIND[sniffed.kind] !== input.declaredMime ||
      !isSniffedKindAllowedInBucket(sniffed.kind, 'exception-evidence')
    ) {
      return reject();
    }
    const kind = sniffed.kind as 'jpeg' | 'png' | 'webp';

    // 2. Re-encoded without its metadata (EXIF, GPS), with a thumbnail made
    //    from the same pixels (lib/image-reencode.ts).
    const clean = await reencodeWithoutMetadata(whole, kind);
    if (
      !clean ||
      clean.master.byteLength === 0 ||
      clean.master.byteLength > EXCEPTION_EVIDENCE_MAX_PHOTO_BYTES
    ) {
      return reject();
    }
    const cleanKind = sniffImage(clean.master);
    if (!cleanKind || MIME_FOR_KIND[cleanKind.kind] !== clean.contentType) return reject();

    // 3. Written back over the upload (the service role; the bucket has no
    //    UPDATE policy, so the uploader cannot replace it afterwards), and the
    //    thumbnail under its own fresh name, never over an existing object.
    thumbPath = exceptionEvidenceThumbPath(this.ctx.organizationId, occ.id);
    const [masterPut, thumbPut] = await Promise.all([
      store.upload(path, clean.master, { contentType: clean.contentType, upsert: true }),
      store.upload(thumbPath, clean.thumb, { contentType: 'image/webp', upsert: false }),
    ]);
    if (masterPut.error || thumbPut.error) {
      throw await refuse(new ServiceError('internal_error', 'Could not save the photo.'));
    }

    // 4. Recorded by the database, which re-checks the gate for this uploader
    //    under a lock on the occurrence, and answers 23505 already_recorded
    //    before any other refusal when this upload is already recorded.
    const { data, error } = await admin.rpc('exception_evidence_record', {
      p_occurrence_id: occ.id,
      p_uploaded_by: this.ctx.userId,
      p_storage_path: path,
      p_thumbnail_path: thumbPath,
      p_content_type: clean.contentType,
      p_byte_size: clean.master.byteLength,
      p_captured_at: capturedAt,
      p_note: note,
    });

    let row = (data as EvidenceRpcRow | null) ?? null;
    if (error) {
      // A refusal. Whichever it is, refuseUpload looks first: a row for this
      // path (a racing finalize of the same upload won) keeps its file and
      // answers "already recorded"; otherwise the upload goes. A 23505 with
      // no row for this path is another name colliding: not "already added".
      const mapped =
        error.code === '23505'
          ? new ServiceError('internal_error', 'The photo could not be recorded.')
          : mapRecordError(error);
      if (mapped) throw await refuse(mapped);
    }
    if (error || !row?.id) {
      // An answer we do not recognise (a dropped connection, a timeout), or
      // no error and no row (pattern #2): the row may have been written
      // before the answer was lost. Look before deleting, so a recorded photo
      // never loses its file; a failed look deletes nothing.
      const found = await this.findRecorded(admin, path);
      if (found && found.storage_path === path && found.thumbnail_path === thumbPath) {
        row = found;
      } else {
        throw await refuse(
          new ServiceError(
            'internal_error',
            error ? postgrestErrorText(error) : 'The photo could not be recorded.',
          ),
        );
      }
    }
    if (!row?.id) throw new ServiceError('internal_error', 'The photo could not be recorded.');

    await audit(
      {
        event: 'exception.evidence_added',
        entityType: 'exception_occurrence',
        entityId: occ.id,
        after: {
          evidence_id: row.id,
          byte_size: Number(row.byte_size),
          content_type: row.content_type,
        },
      },
      this.ctx,
    );

    return {
      id: row.id,
      contentType: row.content_type,
      byteSize: Number(row.byte_size),
      width: clean.width,
      height: clean.height,
      capturedAt: row.captured_at,
      uploadedAt: row.created_at,
    };
  }

  /**
   * THE cleanup for a refused finalize. Deletes what this finalize put in
   * storage and nothing a recorded photo owns:
   *   - no photo recorded at `path`: the upload and this finalize's
   *     thumbnail are deleted;
   *   - a photo recorded at `path` (a racing or earlier finalize of the same
   *     upload): its file is kept, only this finalize's own thumbnail goes
   *     (it is never that row's), and, when `recordedWins`, the answer is
   *     "already recorded" (the caller's photo IS recorded);
   *   - the look fails: nothing is deleted (an orphan is safer than a
   *     recorded photo with no file) and the refusal stands.
   * Returns the error to throw.
   */
  private async refuseUpload(
    err: ServiceError,
    admin: ReturnType<typeof createAdminClient>,
    store: AdminStore,
    path: string,
    thumb: string | null,
    recordedWins: boolean,
  ): Promise<ServiceError> {
    let row: EvidenceRpcRow | null;
    try {
      row = await this.findRecorded(admin, path);
    } catch {
      return err;
    }
    if (row && row.storage_path === path) {
      if (thumb && row.thumbnail_path !== thumb) await removeQuietly(store, [thumb]);
      return recordedWins ? alreadyRecordedError() : err;
    }
    await removeQuietly(store, thumb ? [path, thumb] : [path]);
    return err;
  }

  /**
   * The photo recorded under this upload's NAME (its uuid, any extension:
   * 0375 records one uuid once), or null. The caller compares storage_path
   * with its own path. A failed look is not "no": the failure is reported and
   * THROWN, so nothing is deleted on the strength of it.
   */
  private async findRecorded(
    admin: ReturnType<typeof createAdminClient>,
    path: string,
  ): Promise<EvidenceRpcRow | null> {
    const { data, error } = await admin
      .from('exception_evidence')
      .select(
        'id, storage_path, thumbnail_path, content_type, byte_size, captured_at, created_at, removed_at',
      )
      .eq('organization_id', this.ctx.organizationId)
      // in-list-bound: the four extensions of one upload name (jpg, jpeg, png, webp)
      .in('storage_path', exceptionEvidenceUploadNames(path))
      .maybeSingle();
    if (error) {
      void reportError(new Error('Evidence record check failed; upload kept'), {
        tag: 'exceptions.evidence_record_unknown',
        organizationId: this.ctx.organizationId,
        extra: { detail: postgrestErrorText(error) },
      });
      throw new ServiceError('internal_error', postgrestErrorText(error));
    }
    return (data as EvidenceRpcRow | null) ?? null;
  }

  async remove(
    occurrenceId: string,
    evidenceId: string,
    reasonInput?: string | null,
  ): Promise<RemovedEvidence> {
    assertPermission(this.ctx, 'items:read');
    assertPermission(this.ctx, 'stock:adjust');
    if (!UUID.test(evidenceId)) throw new ServiceError('not_found', 'Photo not found.');
    const reason = (reasonInput ?? '').trim() || null;
    if (reason !== null && Array.from(reason).length > EXCEPTION_EVIDENCE_NOTE_MAX) {
      throw new ServiceError('validation_error', EXCEPTION_EVIDENCE_REASON_TOO_LONG_COPY, {
        reason: 'reason_too_long',
      });
    }

    const occ = await new ExceptionOccurrencesService(this.ctx).requireActable(occurrenceId);

    const { data: ev, error: evError } = await this.ctx.supabase
      .from('exception_evidence')
      .select('id, occurrence_id, uploaded_by, removed_at')
      .eq('organization_id', this.ctx.organizationId)
      .eq('occurrence_id', occ.id)
      .eq('id', evidenceId)
      .maybeSingle();
    if (evError) throw new ServiceError('internal_error', postgrestErrorText(evError));
    const photo = ev as {
      id: string;
      uploaded_by: string | null;
      removed_at: string | null;
    } | null;
    if (!photo) throw new ServiceError('not_found', 'Photo not found.');
    if (photo.uploaded_by !== this.ctx.userId && !isManagerOrAbove(this.ctx.role)) {
      throw new ServiceError('forbidden', EXCEPTION_EVIDENCE_REMOVE_NOT_ALLOWED_COPY);
    }
    if (photo.removed_at === null && occ.resolvedAt !== null) throw resolvedError();

    const { data, error } = await this.ctx.supabase.rpc('exception_evidence_remove', {
      p_id: evidenceId,
      p_reason: reason,
    });
    if (error) throw mapRemoveError(error);
    const removed = data as { id?: string; removed_at?: string | null } | null;
    // The write is confirmed by what it returned (pattern #2): a row, removed.
    if (!removed?.id || !removed.removed_at) {
      throw new ServiceError('internal_error', 'The photo could not be removed.');
    }

    if (photo.removed_at === null) {
      await audit(
        {
          event: 'exception.evidence_removed',
          entityType: 'exception_occurrence',
          entityId: occ.id,
          after: { evidence_id: evidenceId, reason },
        },
        this.ctx,
      );
    }
    return { id: removed.id, removedAt: removed.removed_at };
  }
}

/**
 * The device's capture time: an ISO time, or null. A time the server cannot
 * read is refused (a client bug, said plainly). A time more than the allowed
 * skew AHEAD of the server's clock is dropped rather than stored: it cannot
 * be when the photo was taken, the upload still stands, and the timeline then
 * says the device did not say (never a made-up time).
 */
export function normalizeCapturedAt(
  value: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (value === null || value === undefined || value === '') return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) {
    throw new ServiceError('validation_error', 'The photo time is not a valid date.', {
      reason: 'invalid_captured_at',
    });
  }
  if (at > now + EXCEPTION_EVIDENCE_CAPTURE_SKEW_MS) return null;
  return new Date(at).toISOString();
}

async function downloadWhole(store: AdminStore, path: string): Promise<Uint8Array | null> {
  try {
    const { data, error } = await store.download(path);
    if (error || !data) return null;
    return new Uint8Array(await data.arrayBuffer());
  } catch {
    return null;
  }
}

/** Best-effort on purpose: a failed cleanup must not turn a clear refusal
 *  into an internal error (upload-verification.ts's removeQuietly). */
async function removeQuietly(store: AdminStore, paths: string[]): Promise<void> {
  try {
    await store.remove(paths);
  } catch {
    // Deliberately swallowed.
  }
}

/** The refusals web and phone both word from core (review finding
 *  2026-09-27: the service had its own sentences). */
function resolvedError(): ServiceError {
  return new ServiceError('conflict', EXCEPTION_EVIDENCE_RESOLVED_COPY, {
    reason: 'occurrence_resolved',
  });
}

function capError(): ServiceError {
  return new ServiceError('conflict', EXCEPTION_EVIDENCE_CAP_COPY, {
    reason: 'evidence_limit_reached',
  });
}

/** This upload is already recorded: the clients read it as success. */
function alreadyRecordedError(): ServiceError {
  return new ServiceError('conflict', 'This photo was already added.', {
    reason: 'already_recorded',
  });
}

/** exception_evidence_record's refusals, by SQLSTATE and hint (pattern #28).
 *  Null for anything else: the caller then checks before deleting. */
function mapRecordError(error: {
  code?: string;
  message: string;
  hint?: string | null;
}): ServiceError | null {
  switch (error.code) {
    case '42501':
      return new ServiceError('forbidden', EXCEPTION_EVIDENCE_NO_PERMISSION_COPY);
    case 'P0002':
      return new ServiceError('not_found', 'Exception not found.');
    case 'P0001':
      if (error.hint === 'occurrence_resolved') return resolvedError();
      if (error.hint === 'evidence_limit_reached') return capError();
      return null;
    case '22023':
      return new ServiceError('validation_error', EXCEPTION_EVIDENCE_REJECTED_COPY, {
        reason: error.hint ?? 'invalid_argument',
      });
    case '55P03':
      // The occurrence was locked past lock_timeout: nothing was written.
      return new ServiceError('conflict', 'This exception is busy. Please add the photo again.', {
        reason: 'busy',
        retryable: true,
      });
    default:
      return null;
  }
}

/** exception_evidence_remove's refusals, by SQLSTATE and hint. */
function mapRemoveError(error: {
  code?: string;
  message: string;
  hint?: string | null;
}): ServiceError {
  switch (error.code) {
    case '42501':
      return new ServiceError('forbidden', EXCEPTION_EVIDENCE_REMOVE_NOT_ALLOWED_COPY);
    case 'P0002':
      return new ServiceError('not_found', 'Photo not found.');
    case 'P0001':
      if (error.hint === 'occurrence_resolved') return resolvedError();
      break;
    case '22023':
      if (error.hint === 'reason_too_long') {
        return new ServiceError('validation_error', EXCEPTION_EVIDENCE_REASON_TOO_LONG_COPY, {
          reason: 'reason_too_long',
        });
      }
      break;
    case '55P03':
      return new ServiceError('conflict', 'This exception is busy. Please try again.', {
        reason: 'busy',
        retryable: true,
      });
  }
  return new ServiceError('internal_error', postgrestErrorText(error));
}
