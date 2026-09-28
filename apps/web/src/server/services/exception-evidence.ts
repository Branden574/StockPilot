import 'server-only';

import {
  EXCEPTION_EVIDENCE_CAPTURE_SKEW_MS,
  EXCEPTION_EVIDENCE_EXTENSIONS,
  EXCEPTION_EVIDENCE_MAX_PHOTO_BYTES,
  EXCEPTION_EVIDENCE_MAX_PHOTOS,
  EXCEPTION_EVIDENCE_NOTE_MAX,
  EXCEPTION_EVIDENCE_REJECTED_COPY,
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
 *   3. finalize: the same gate; the STRICT path shape before any storage
 *      call; the whole object read and sniffed against the declared type,
 *      within the size cap;
 *      then the whole object is re-encoded WITHOUT its metadata (EXIF, GPS)
 *      and written back over itself, with a server-made thumbnail; then
 *      exception_evidence_record (service role) re-checks everything under a
 *      lock and writes the row and the timeline event. On any failure the
 *      uploaded file and the thumbnail are deleted and no row is written
 *      (one exception, below: a second finalize of an upload that is already
 *      recorded leaves the file alone, because it belongs to that row).
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
    if (occ.resolvedAt !== null) {
      throw new ServiceError(
        'conflict',
        'This exception is resolved, so its photos can no longer change.',
        {
          reason: 'occurrence_resolved',
        },
      );
    }
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
      throw new ServiceError(
        'conflict',
        'Too many photo uploads in the last hour. Please try again later.',
        {
          reason: 'rate_limited',
        },
      );
    }

    if ((await this.liveCount(occ.id)) >= EXCEPTION_EVIDENCE_MAX_PHOTOS) {
      throw new ServiceError(
        'conflict',
        `An exception can hold at most ${EXCEPTION_EVIDENCE_MAX_PHOTOS} photos. Remove one to add another.`,
        { reason: 'evidence_limit_reached' },
      );
    }

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
    const occ = await this.requireOpenActable(occurrenceId);

    const note = (input.note ?? '').trim() || null;
    if (note !== null && Array.from(note).length > EXCEPTION_EVIDENCE_NOTE_MAX) {
      throw new ServiceError(
        'validation_error',
        `Notes can be at most ${EXCEPTION_EVIDENCE_NOTE_MAX} characters.`,
        {
          reason: 'note_too_long',
        },
      );
    }
    const capturedAt = normalizeCapturedAt(input.capturedAt);

    // STRICT shape before any storage call (maintenance-attachments.ts's
    // validateFinalizePath: a prefix check alone is escapable with `..`).
    const path = String(input.path ?? '');
    if (!isValidStoragePath(path, exceptionEvidencePathShape(this.ctx.organizationId, occ.id))) {
      throw new ServiceError('forbidden', 'Invalid upload path.', { reason: 'invalid_path' });
    }
    // Never taken from the client: derived from the validated path.
    const thumbPath = exceptionEvidenceThumbPath(path);
    const ext = path.slice(path.lastIndexOf('.') + 1);

    const admin = createAdminClient();
    const store = admin.storage.from(EXCEPTION_EVIDENCE_BUCKET);

    // 0. Nothing is written to storage for a path that is already recorded.
    //    The steps below write the re-encoded photo back over the upload, so
    //    without this a second finalize of a recorded photo would replace its
    //    file (and a lossy re-encode of a re-encode is not the photo that was
    //    recorded). The database's unique path still settles a race.
    if (await this.findRecorded(admin, path)) {
      throw new ServiceError('conflict', 'This photo was already added.', {
        reason: 'already_recorded',
      });
    }

    const reject = async (): Promise<never> => {
      await removeQuietly(store, [path, thumbPath]);
      throw new ServiceError('validation_error', EXCEPTION_EVIDENCE_REJECTED_COPY, {
        reason: 'invalid_image',
      });
    };

    // The cap, before the expensive part (the bucket's INSERT policy lets a
    // member put objects in their org's folder without a mint, so a finalize
    // is not proof that the mint's own cap check ran). The database re-checks
    // under its lock.
    if ((await this.liveCount(occ.id)) >= EXCEPTION_EVIDENCE_MAX_PHOTOS) {
      await removeQuietly(store, [path, thumbPath]);
      throw new ServiceError(
        'conflict',
        `An exception can hold at most ${EXCEPTION_EVIDENCE_MAX_PHOTOS} photos. Remove one to add another.`,
        { reason: 'evidence_limit_reached' },
      );
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
    //    UPDATE policy, so the uploader cannot replace it afterwards).
    const [masterPut, thumbPut] = await Promise.all([
      store.upload(path, clean.master, { contentType: clean.contentType, upsert: true }),
      store.upload(thumbPath, clean.thumb, { contentType: 'image/webp', upsert: true }),
    ]);
    if (masterPut.error || thumbPut.error) {
      await removeQuietly(store, [path, thumbPath]);
      throw new ServiceError('internal_error', 'Could not save the photo.');
    }

    // 4. Recorded by the database, which re-checks the gate for this uploader
    //    under a lock on the occurrence.
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
      if (error.code === '23505') {
        // A second finalize of an upload that is already recorded: the file
        // belongs to that row, so it is left alone.
        throw new ServiceError('conflict', 'This photo was already added.', {
          reason: 'already_recorded',
        });
      }
      const mapped = mapRecordError(error);
      if (mapped) {
        await removeQuietly(store, [path, thumbPath]);
        throw mapped;
      }
      // An answer we do not recognise (a dropped connection, a timeout): the
      // row may have been written before the answer was lost. Look before
      // deleting, so a recorded photo never loses its file.
      row = await this.findRecorded(admin, path);
      if (!row) {
        await removeQuietly(store, [path, thumbPath]);
        throw new ServiceError('internal_error', postgrestErrorText(error));
      }
    }
    if (!row?.id) {
      // No error and no row is not a success (pattern #2).
      row = await this.findRecorded(admin, path);
      if (!row) {
        await removeQuietly(store, [path, thumbPath]);
        throw new ServiceError('internal_error', 'The photo could not be recorded.');
      }
    }

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
   * Is a row recorded for this path? For the lost-answer case only. A failed
   * look is not "no": the file is kept (an orphan is safer than a recorded
   * photo with no file), the failure reported, and the caller told it failed.
   */
  private async findRecorded(
    admin: ReturnType<typeof createAdminClient>,
    path: string,
  ): Promise<EvidenceRpcRow | null> {
    const { data, error } = await admin
      .from('exception_evidence')
      .select('id, content_type, byte_size, captured_at, created_at, removed_at')
      .eq('organization_id', this.ctx.organizationId)
      .eq('storage_path', path)
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
      throw new ServiceError(
        'validation_error',
        `A reason can be at most ${EXCEPTION_EVIDENCE_NOTE_MAX} characters.`,
        { reason: 'reason_too_long' },
      );
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
      throw new ServiceError(
        'forbidden',
        'Only the person who added a photo, or a manager, can remove it.',
      );
    }
    if (photo.removed_at === null && occ.resolvedAt !== null) {
      throw new ServiceError(
        'conflict',
        'This exception is resolved, so its photos can no longer change.',
        {
          reason: 'occurrence_resolved',
        },
      );
    }

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

/** exception_evidence_record's refusals, by SQLSTATE and hint (pattern #28).
 *  Null for anything else: the caller then checks before deleting. */
function mapRecordError(error: {
  code?: string;
  message: string;
  hint?: string | null;
}): ServiceError | null {
  switch (error.code) {
    case '42501':
      return new ServiceError(
        'forbidden',
        'You do not have permission to add photos to this exception.',
      );
    case 'P0002':
      return new ServiceError('not_found', 'Exception not found.');
    case 'P0001':
      if (error.hint === 'occurrence_resolved') {
        return new ServiceError(
          'conflict',
          'This exception is resolved, so its photos can no longer change.',
          {
            reason: 'occurrence_resolved',
          },
        );
      }
      if (error.hint === 'evidence_limit_reached') {
        return new ServiceError(
          'conflict',
          `An exception can hold at most ${EXCEPTION_EVIDENCE_MAX_PHOTOS} photos. Remove one to add another.`,
          { reason: 'evidence_limit_reached' },
        );
      }
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
      return new ServiceError(
        'forbidden',
        'Only the person who added a photo, or a manager, can remove it.',
      );
    case 'P0002':
      return new ServiceError('not_found', 'Photo not found.');
    case 'P0001':
      if (error.hint === 'occurrence_resolved') {
        return new ServiceError(
          'conflict',
          'This exception is resolved, so its photos can no longer change.',
          {
            reason: 'occurrence_resolved',
          },
        );
      }
      break;
    case '22023':
      if (error.hint === 'reason_too_long') {
        return new ServiceError(
          'validation_error',
          `A reason can be at most ${EXCEPTION_EVIDENCE_NOTE_MAX} characters.`,
          {
            reason: 'reason_too_long',
          },
        );
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
