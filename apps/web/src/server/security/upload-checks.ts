import 'server-only';

import { headers as currentHeaders } from 'next/headers';

import { THREAT_MESSAGES, type DocumentThreatCode } from '@/lib/document-threat-scan';
import { sniffNeedsMoreBytes } from '@/lib/image-signature';
import {
  fetchObjectWhole,
  fetchObjectWindow,
  type PrefixCapableBucket,
  type StorageReadTimedOut,
} from '@/lib/storage-object-prefix';
import {
  inspectUpload,
  inspectUploadPrefix,
  type UploadInspection,
  type UploadInspectOptions,
  type UploadKind,
  type UploadRefusalCode,
  type UploadRefusalFamily,
} from '@/lib/upload-inspect';

import { audit } from '@/server/services/audit';
import type { ServiceContext } from '@/server/services/context';

import { recordSecurityEvent, type SecurityEventHeaders } from './events';

/**
 * EVERY UPLOAD PATH'S ONE CHECK (part 6 of the security tools, stage 6a).
 *
 * A file that comes in, through our server or straight to storage and then
 * through a finalize, is read here by the app's own file checks
 * (lib/upload-inspect.ts: the sniffers, the scanner, the container and text
 * rules). On a refusal this module records ONE security event and hands back
 * the plain sentence for the person:
 *   - category malware, outcome blocked;
 *   - the reason is the verdict's family, one of four, each written out as a
 *     literal below: upload_wrong_type, upload_active_content,
 *     upload_hidden_file, upload_could_not_check; or, for a stored object a
 *     record the organization already has still points at (so it is kept),
 *     upload_refused_in_use, outcome flagged: the file is refused, and is
 *     still there;
 *   - the organization of the caller's server-built context when there is one
 *     (each call site's source of it is pinned by
 *     upload-checks.registry.guard.test.ts: never a value a request carried);
 *   - the source: the phone when the request came with a bearer token, else
 *     the website;
 *   - NEVER a file name, a path, a byte of the file, or the scanner's operator
 *     detail: the record has no column for them, and nothing here passes one.
 *
 * A RECORDER FAILURE CHANGES NO ANSWER. The verdict is reached before anything
 * is recorded, the recording is inside its own try, and a clean file records
 * nothing at all: so a failed record can neither accept a refused file nor
 * refuse a clean one.
 *
 * A FILE NOBODY SENT is not an upload: a cover picture the server fetched
 * itself is checked the same way and left out when refused, with nothing
 * recorded (`notRecorded: 'server_fetched_cover'`, which only books-import.ts
 * passes: the registry guard pins it).
 *
 * A CLEAN FILE BEHAVES EXACTLY AS BEFORE. Nothing here changes a byte that is
 * stored; the callers keep every permission check, limit and sentence they
 * had, and pass their own sentence for a file of the wrong type.
 *
 * Server code only: `import 'server-only'` and never 'use server'
 * (server/security/events.guard.test.ts lists these functions).
 */

/** Which upload path is asking: for the registry and for reading the code, never recorded. */
export type UploadSurface =
  | 'item_photo'
  | 'item_photo_thumb'
  | 'book_cover'
  | 'avatar'
  | 'org_logo'
  | 'support_screenshot'
  | 'maintenance_photo'
  | 'exception_evidence'
  | 'procedure_video'
  | 'procedure_poster'
  | 'po_import_file'
  | 'po_scan'
  | 'po_attachment'
  | 'order_attachment'
  | 'cycle_count_scan'
  | 'size_count_scan'
  | 'size_count_training'
  | 'identify_photo'
  | 'isbn_file'
  | 'order_signature';

export interface UploadCheckInput extends UploadInspectOptions {
  surface: UploadSurface;
  /**
   * The organization of the caller's server-built context (ctx.organizationId,
   * or the order a signature link resolved to on the server), or null.
   */
  organizationId: string | null;
  /** The request's headers, when the caller has them; else the request's own are read. */
  headers?: SecurityEventHeaders | null;
  /** The path's own sentence for a file of the wrong type, as it always answered. */
  wrongTypeMessage?: string;
  /**
   * Set only for a file no person sent (a cover picture the server fetched
   * itself): a refusal is answered as usual and recorded nowhere.
   */
  notRecorded?: 'server_fetched_cover';
}

export type UploadCheckResult =
  | { ok: true; kind: UploadKind; mime: string; width: number | null; height: number | null }
  | { ok: false; family: UploadRefusalFamily; message: string };

/** The sentence for a file of the wrong type when a path has none of its own. */
export const UPLOAD_WRONG_TYPE_MESSAGE =
  'This file could not be uploaded because it failed our security checks.';

/** A Word or Excel file with a part that can run code. Says what to do, not what was looked at. */
export const UPLOAD_OFFICE_MACRO_MESSAGE =
  'This file contains macros or controls that run code, which we do not accept. Save a copy without them and upload that.';

/** The sentence for a refusal of a family, for this path. */
function messageFor(code: UploadRefusalCode, family: UploadRefusalFamily, input: UploadCheckInput): string {
  if (Object.prototype.hasOwnProperty.call(THREAT_MESSAGES, code)) {
    return THREAT_MESSAGES[code as DocumentThreatCode];
  }
  if (code === 'office_macro') return UPLOAD_OFFICE_MACRO_MESSAGE;
  if (family === 'could_not_check') return THREAT_MESSAGES.scan_budget;
  return input.wrongTypeMessage ?? UPLOAD_WRONG_TYPE_MESSAGE;
}

async function headersOfThisRequest(): Promise<SecurityEventHeaders | null> {
  try {
    return await currentHeaders();
  } catch {
    return null;
  }
}

/** The phone app sends its own bearer token; the website sends none. */
function sourceOf(headers: SecurityEventHeaders | null): 'web' | 'phone' {
  const auth = headers?.get('authorization') ?? '';
  return /^Bearer\s+\S/i.test(auth) ? 'phone' : 'web';
}

/**
 * The one event of a refusal. Never throws; never awaited past the buffer
 * (recordSecurityEvent returns once the event is in it).
 */
async function recordRefusal(
  family: UploadRefusalFamily | 'in_use',
  organizationId: string | null,
  given: SecurityEventHeaders | null | undefined,
): Promise<void> {
  try {
    const headers = given ?? (await headersOfThisRequest());
    const source = sourceOf(headers);
    if (family === 'in_use') {
      // Refused, and kept: a record the organization already has still points
      // at this object. Flagged, not blocked: the file is still there.
      await recordSecurityEvent(
        { category: 'malware', outcome: 'flagged', reason: 'upload_refused_in_use', source, organizationId },
        headers,
      );
    } else if (family === 'wrong_type') {
      await recordSecurityEvent(
        { category: 'malware', outcome: 'blocked', reason: 'upload_wrong_type', source, organizationId },
        headers,
      );
    } else if (family === 'active_content') {
      await recordSecurityEvent(
        { category: 'malware', outcome: 'blocked', reason: 'upload_active_content', source, organizationId },
        headers,
      );
    } else if (family === 'hidden_file') {
      await recordSecurityEvent(
        { category: 'malware', outcome: 'blocked', reason: 'upload_hidden_file', source, organizationId },
        headers,
      );
    } else {
      await recordSecurityEvent(
        { category: 'malware', outcome: 'blocked', reason: 'upload_could_not_check', source, organizationId },
        headers,
      );
    }
  } catch {
    // Never the caller's problem: the refusal stands whether or not it was counted.
  }
}

/** The answer to a verdict, with nothing recorded yet. */
function judged(inspection: UploadInspection, input: UploadCheckInput): UploadCheckResult {
  if (inspection.ok) {
    return {
      ok: true,
      kind: inspection.kind,
      mime: inspection.mime,
      width: inspection.width,
      height: inspection.height,
    };
  }
  return {
    ok: false,
    family: inspection.family,
    message: messageFor(inspection.code, inspection.family, input),
  };
}

async function answer(inspection: UploadInspection, input: UploadCheckInput): Promise<UploadCheckResult> {
  const result = judged(inspection, input);
  if (!result.ok && input.notRecorded !== 'server_fetched_cover') {
    await recordRefusal(result.family, input.organizationId, input.headers);
  }
  return result;
}

/**
 * The check of a WHOLE file whose bytes are in hand (a multipart body, a
 * base64 body, a download, a fetched cover): its kind from its bytes, and the
 * check that kind has. One event on a refusal.
 */
export async function checkUploadBytes(
  bytes: Uint8Array,
  input: UploadCheckInput,
): Promise<UploadCheckResult> {
  return answer(inspectUpload(bytes, input), input);
}

/**
 * The first look at a file's LEADING bytes, before a finalize reads it whole
 * (images, PDF, video containers): a fake is refused before a large read.
 * One event on a refusal. A file that passes still needs checkUploadBytes on
 * the whole, except a video, whose check is its signature.
 */
export async function checkUploadPrefix(
  prefix: Uint8Array,
  input: UploadCheckInput,
): Promise<UploadCheckResult> {
  return answer(inspectUploadPrefix(prefix, input), input);
}

/** The storage calls a stored-object check makes, stated structurally. */
export type StoredUploadBucket = PrefixCapableBucket & {
  remove(paths: string[]): Promise<unknown>;
};

export type StoredUploadResult =
  | {
      ok: true;
      kind: UploadKind;
      mime: string;
      width: number | null;
      height: number | null;
      /** The whole object as it was checked (a video: its leading window). */
      bytes: Uint8Array;
    }
  /**
   * `family` null: nothing was judged or recorded (the object could not be
   * read, or it is over the path's size ceiling). `absent`: it could not be
   * read at all (never uploaded, or already gone), so nothing was removed
   * either; a path whose object is optional (an item photo's thumbnail) reads
   * that as "none".
   */
  | { ok: false; family: UploadRefusalFamily | null; message: string; absent?: true };

/**
 * Why a refused upload's objects were removed, for the audit line: the
 * check's family, an object over its path's ceiling, or a refusal of the
 * path's own (a limit, a cap, a failed re-encode).
 */
export type UploadRemovalWhy = UploadRefusalFamily | 'too_large' | 'empty' | 'path_refusal';

/** Who a removal is written to the audit log as: the caller's own context. */
export interface UploadRemovedBy {
  organizationId: string;
  userId: string;
}

export interface StoredUploadInput extends UploadCheckInput {
  /**
   * The largest object this path takes, in bytes (its bucket's own cap,
   * lib/upload-size-limits.ts). A larger one is refused from the size storage
   * states, before any of its body is read, and nothing past this is ever
   * read.
   */
  maxBytes: number;
  /** The path's own sentence for an object over `maxBytes`. */
  tooLargeMessage?: string;
  /** Every object of this upload to remove on a refusal (the file, and its thumbnail or poster). */
  removeOnRefusal: readonly string[];
  /**
   * Asked before anything is removed: true when a record (this one recorded
   * already, or another) still names one of these objects. Then nothing is
   * removed. A look that fails keeps them too.
   */
  stillNamed: (paths: readonly string[]) => Promise<boolean>;
  /** Who removed it: every removal writes one audit line. */
  removedBy: UploadRemovedBy;
  /** The path's own sentence for an object that could not be read. */
  unreadableMessage: string;
}

/** The sentence for an object over its path's ceiling, when the path has none of its own. */
export const UPLOAD_TOO_LARGE_MESSAGE = 'This file is too large to upload. Pick a smaller one.';

/**
 * The sentence for a file that could not be checked (lab walk 5): a storage
 * read past its time limit, or a file the check could not finish. Refused;
 * the person is told to try again.
 */
export const UPLOAD_NOT_CHECKED_MESSAGE =
  'We could not check this file just now, so it was not added. Try again in a moment. If it happens again, save a new copy of the file and upload that.';

/** The sentence for an empty file (lab walk 5, F1): refused from its size, at once. */
export const UPLOAD_EMPTY_MESSAGE = 'This file is empty. Choose the file again and upload it.';

/**
 * A storage read past its time limit (lib/storage-object-prefix.ts). Checked
 * by shape here, not with that module's own function, so that the many tests
 * that stand in for that module need not stand in for this too.
 */
function readTimedOut(value: unknown): value is StorageReadTimedOut {
  return typeof value === 'object' && value !== null && (value as { timedOut?: unknown }).timedOut === true;
}

/**
 * The answer when storage did not answer in time: refused as "could not be
 * checked". Nothing was judged, so nothing is removed and no event is
 * recorded (a slow storage is not a file anyone sent); the object stays as
 * an upload that never finished.
 */
function notChecked(): StoredUploadResult {
  return { ok: false, family: null, message: UPLOAD_NOT_CHECKED_MESSAGE };
}

/**
 * An empty object, refused from its size before anything else (lab walk 5,
 * F1): removed like one over the ceiling, with its audit line, and no event
 * (an empty file carries nothing).
 */
async function refuseEmpty(store: StoredUploadBucket, input: StoredUploadInput): Promise<StoredUploadResult> {
  await removeRefused(store, input, 'empty');
  return { ok: false, family: null, message: UPLOAD_EMPTY_MESSAGE };
}

/**
 * What became of a refused upload's objects: removed (storage listed them as
 * deleted), kept (a record still names one, or that look failed), or a
 * removal storage did not confirm (its error's code, or "nothing_removed"
 * when it answered with no object deleted).
 */
export type UploadRemovalOutcome =
  | { done: 'removed'; objects: number }
  | { done: 'kept'; objects: number; because: 'still_named' | 'look_failed' }
  | { done: 'removal_failed'; objects: number; code: string };

/** A storage error's own code, as a short token (never its message, which can name the object). */
function storageErrorCode(error: unknown): string {
  const e = (error ?? {}) as { statusCode?: unknown; status?: unknown; name?: unknown };
  const raw =
    typeof e.statusCode === 'string' && e.statusCode
      ? e.statusCode
      : typeof e.status === 'number'
        ? String(e.status)
        : typeof e.name === 'string'
          ? e.name
          : '';
  return /^[A-Za-z0-9_.-]{1,40}$/.test(raw) ? raw : 'storage_error';
}

/**
 * Removes the objects and writes the one audit line of what storage
 * answered: "removed" only when storage lists the objects it deleted (an
 * answer with none, as a storage rule that matches nothing gives, or an
 * error, is a removal that failed). Best-effort on purpose (the rule of
 * upload-verification.ts): a failed cleanup must not turn "this file was
 * refused" into an internal error.
 */
export async function removeAndAudit(
  store: { remove(paths: string[]): Promise<unknown> },
  paths: readonly string[],
  surface: UploadSurface,
  why: UploadRemovalWhy,
  by: UploadRemovedBy,
): Promise<UploadRemovalOutcome> {
  let outcome: UploadRemovalOutcome;
  try {
    const answered = (await store.remove([...paths])) as { data?: unknown; error?: unknown } | null | undefined;
    if (answered?.error) {
      outcome = { done: 'removal_failed', objects: paths.length, code: storageErrorCode(answered.error) };
    } else if (Array.isArray(answered?.data) && answered.data.length > 0) {
      outcome = { done: 'removed', objects: answered.data.length };
    } else {
      outcome = { done: 'removal_failed', objects: paths.length, code: 'nothing_removed' };
    }
  } catch (e) {
    outcome = { done: 'removal_failed', objects: paths.length, code: storageErrorCode(e) };
  }
  await auditRemoval(surface, why, outcome, by);
  return outcome;
}

/**
 * The removal of a refused upload's objects. Never while a record names one
 * of them (the look first; a failed look keeps them), always with one audit
 * line naming who, why and what was done (never a path or a name).
 */
async function removeRefused(
  store: StoredUploadBucket,
  input: StoredUploadInput,
  why: UploadRemovalWhy,
): Promise<UploadRemovalOutcome | null> {
  return removeUnlessNamed(store, input.removeOnRefusal, input.stillNamed, input.surface, why, input.removedBy);
}

/**
 * The same removal for a path that refuses a file on a rule of its own
 * (the logo's pixel limit): the look first, then the removal, and one audit
 * line either way. Null when there was nothing to remove.
 */
export async function removeUnlessNamed(
  store: { remove(paths: string[]): Promise<unknown> },
  objects: readonly string[],
  stillNamed: (paths: readonly string[]) => Promise<boolean>,
  surface: UploadSurface,
  why: UploadRemovalWhy,
  by: UploadRemovedBy,
): Promise<UploadRemovalOutcome | null> {
  const paths = [...new Set(objects)];
  if (paths.length === 0) return null;
  let because: 'still_named' | 'look_failed' | null;
  try {
    because = (await stillNamed(paths)) ? 'still_named' : null;
  } catch {
    because = 'look_failed';
  }
  if (because) {
    const kept: UploadRemovalOutcome = { done: 'kept', objects: paths.length, because };
    await auditRemoval(surface, why, kept, by);
    return kept;
  }
  return removeAndAudit(store, paths, surface, why, by);
}

/**
 * The one audit line of what was done with a refused upload's objects: the
 * surface, the kind of refusal, how many objects, and why they were kept or
 * the storage error's code. Never a path or a name.
 */
export async function auditRemoval(
  surface: UploadSurface,
  why: UploadRemovalWhy,
  outcome: UploadRemovalOutcome,
  by: UploadRemovedBy,
): Promise<void> {
  try {
    const ctx = { organizationId: by.organizationId, userId: by.userId } as ServiceContext;
    if (outcome.done === 'removed') {
      await audit(
        {
          event: 'security.upload_refused_removed',
          entityType: 'upload',
          entityId: null,
          extra: { surface, why, objects: outcome.objects },
        },
        ctx,
      );
    } else if (outcome.done === 'kept') {
      await audit(
        {
          event: 'security.upload_refused_kept',
          entityType: 'upload',
          entityId: null,
          extra: { surface, why, objects: outcome.objects, because: outcome.because },
        },
        ctx,
      );
    } else {
      await audit(
        {
          event: 'security.upload_refused_removal_failed',
          entityType: 'upload',
          entityId: null,
          extra: { surface, why, objects: outcome.objects, code: outcome.code },
        },
        ctx,
      );
    }
  } catch {
    // audit() never rejects; this is belt and braces.
  }
}

/**
 * A refusal of a stored upload's verdict: the look and the removal first,
 * then its one event, in the words of what was done (a file a record still
 * points at is kept, and its event says so).
 */
async function refuseStored(
  store: StoredUploadBucket,
  input: StoredUploadInput,
  inspection: Extract<UploadInspection, { ok: false }>,
): Promise<StoredUploadResult> {
  const outcome = await removeRefused(store, input, inspection.family);
  const inUse = outcome?.done === 'kept' && outcome.because === 'still_named';
  await recordRefusal(inUse ? 'in_use' : inspection.family, input.organizationId, input.headers);
  return {
    ok: false,
    family: inspection.family,
    message: messageFor(inspection.code, inspection.family, input),
  };
}

/** A window an image sniff cannot decide (a JPEG whose frame header sits past it). */
function windowUndecided(head: { prefix: Uint8Array; totalSize: number }): boolean {
  return head.totalSize > head.prefix.byteLength && sniffNeedsMoreBytes(head.prefix);
}

/**
 * THE FINALIZE CHECK of an object a client put in storage. The leading
 * window first, with the size storage states: an object over the path's
 * ceiling is refused and removed before any of its body is read, and a fake
 * is refused from the window when the window decides. Then the whole object,
 * at most the ceiling and exactly the stated size (a short or failed read is
 * "could not be read": nothing judged, recorded or removed). On a refusal the
 * upload's objects are removed (never while a record names one) and one event
 * is recorded. An empty object is refused from its size at once (removed, no
 * event), and a storage read past its time limit is "could not be checked"
 * (refused; nothing judged, removed or recorded).
 */
export async function checkStoredUpload(
  store: StoredUploadBucket,
  path: string,
  input: StoredUploadInput,
): Promise<StoredUploadResult> {
  const head = await fetchObjectWindow(store, path, fetch, { maxTotalBytes: input.maxBytes });
  if (readTimedOut(head)) return notChecked();
  if (!head) return { ok: false, family: null, message: input.unreadableMessage, absent: true };
  if (head.overLimit) {
    await removeRefused(store, input, 'too_large');
    return { ok: false, family: null, message: input.tooLargeMessage ?? UPLOAD_TOO_LARGE_MESSAGE };
  }
  if (head.totalSize === 0) return refuseEmpty(store, input);
  const prefixKinds = input.accept.filter((k) => k !== 'text' && k !== 'docx' && k !== 'xlsx');
  if (prefixKinds.length === input.accept.length && !windowUndecided(head)) {
    const first = inspectUploadPrefix(head.prefix, input);
    if (!first.ok) return refuseStored(store, input, first);
  }
  const whole =
    head.totalSize > head.prefix.byteLength
      ? await fetchObjectWhole(store, path, head.totalSize)
      : head.prefix;
  if (readTimedOut(whole)) return notChecked();
  if (!whole || whole.byteLength !== head.totalSize) {
    // Readable a moment ago, not now: nothing judged, so nothing removed or
    // recorded. The person is asked to try again.
    return { ok: false, family: null, message: input.unreadableMessage };
  }
  const verdict = inspectUpload(whole, input);
  if (!verdict.ok) return refuseStored(store, input, verdict);
  const clean = judged(verdict, input);
  return clean.ok ? { ...clean, bytes: whole } : clean;
}

/**
 * THE FINALIZE CHECK of a stored video: its size from storage and its
 * container's signature from the leading window only (never widened, never
 * read whole: a video may be a gigabyte). Over the ceiling, or a wrong
 * signature, removes the upload's objects (never while a record names one)
 * and, for a wrong signature, records one event.
 */
export async function checkStoredUploadSignature(
  store: StoredUploadBucket,
  path: string,
  input: StoredUploadInput,
): Promise<StoredUploadResult> {
  const head = await fetchObjectWindow(store, path, fetch, { maxTotalBytes: input.maxBytes });
  if (readTimedOut(head)) return notChecked();
  if (!head) return { ok: false, family: null, message: input.unreadableMessage, absent: true };
  if (head.overLimit) {
    await removeRefused(store, input, 'too_large');
    return { ok: false, family: null, message: input.tooLargeMessage ?? UPLOAD_TOO_LARGE_MESSAGE };
  }
  if (head.totalSize === 0) return refuseEmpty(store, input);
  const verdict = inspectUploadPrefix(head.prefix, input);
  if (!verdict.ok) return refuseStored(store, input, verdict);
  const clean = judged(verdict, input);
  return clean.ok ? { ...clean, bytes: head.prefix } : clean;
}
