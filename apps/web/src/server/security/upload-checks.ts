import 'server-only';

import { headers as currentHeaders } from 'next/headers';

import { THREAT_MESSAGES, type DocumentThreatCode } from '@/lib/document-threat-scan';
import {
  fetchObjectPrefix,
  fetchObjectWindow,
  type PrefixCapableBucket,
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
 *     upload_hidden_file, upload_could_not_check;
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
  family: UploadRefusalFamily,
  organizationId: string | null,
  given: SecurityEventHeaders | null | undefined,
): Promise<void> {
  try {
    const headers = given ?? (await headersOfThisRequest());
    const source = sourceOf(headers);
    if (family === 'wrong_type') {
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

async function answer(inspection: UploadInspection, input: UploadCheckInput): Promise<UploadCheckResult> {
  if (inspection.ok) {
    return {
      ok: true,
      kind: inspection.kind,
      mime: inspection.mime,
      width: inspection.width,
      height: inspection.height,
    };
  }
  await recordRefusal(inspection.family, input.organizationId, input.headers);
  return {
    ok: false,
    family: inspection.family,
    message: messageFor(inspection.code, inspection.family, input),
  };
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
  download(path: string): Promise<{ data: Blob | null; error: { message: string } | null }>;
  remove(paths: string[]): Promise<unknown>;
};

export type StoredUploadResult =
  | {
      ok: true;
      kind: UploadKind;
      mime: string;
      width: number | null;
      height: number | null;
      /** The whole object as it was checked. */
      bytes: Uint8Array;
    }
  /**
   * `family` null: the object could not be read, so nothing was judged or
   * recorded. `absent`: it could not be read at all (never uploaded, or
   * already gone), so nothing was removed either; a path whose object is
   * optional (an item photo's thumbnail) reads that as "none".
   */
  | { ok: false; family: UploadRefusalFamily | null; message: string; absent?: true };

export interface StoredUploadInput extends UploadCheckInput {
  /** Every object of this upload to remove on a refusal (the file, and its thumbnail or poster). */
  removeOnRefusal: readonly string[];
  /** The path's own sentence for an object that could not be read. */
  unreadableMessage: string;
}

/**
 * The delete is best-effort on purpose and the refusal is not (the rule of
 * upload-verification.ts): a failed cleanup must not turn "this file was
 * refused" into an internal error.
 */
async function removeQuietly(store: StoredUploadBucket, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    await store.remove([...paths]);
  } catch {
    // Deliberately swallowed: no row points at the object.
  }
}

async function downloadWhole(store: StoredUploadBucket, path: string): Promise<Uint8Array | null> {
  try {
    const { data, error } = await store.download(path);
    if (error || !data) return null;
    return new Uint8Array(await data.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * THE FINALIZE CHECK of an object a client put in storage: the leading bytes
 * first (a fake is refused before it is read whole), then the whole object.
 * On a refusal every object of the upload is removed and one event is
 * recorded. An object that cannot be read is refused with the path's own
 * sentence, records nothing (nothing was judged), and is removed only when it
 * was readable a moment before (the rule of verify-or-delete: an object that
 * was never uploaded has nothing to remove).
 */
export async function checkStoredUpload(
  store: StoredUploadBucket,
  path: string,
  input: StoredUploadInput,
): Promise<StoredUploadResult> {
  const head = await fetchObjectPrefix(store, path);
  if (!head) return { ok: false, family: null, message: input.unreadableMessage, absent: true };
  const prefixKinds = input.accept.filter((k) => k !== 'text' && k !== 'docx' && k !== 'xlsx');
  if (prefixKinds.length === input.accept.length) {
    const first = await checkUploadPrefix(head.prefix, input);
    if (!first.ok) {
      await removeQuietly(store, input.removeOnRefusal);
      return first;
    }
  }
  const whole =
    head.totalSize > head.prefix.byteLength ? await downloadWhole(store, path) : head.prefix;
  if (!whole) {
    // Readable a moment ago, unreadable now: fail closed, nothing judged.
    await removeQuietly(store, input.removeOnRefusal);
    return { ok: false, family: null, message: input.unreadableMessage };
  }
  const verdict = await checkUploadBytes(whole, input);
  if (!verdict.ok) {
    await removeQuietly(store, input.removeOnRefusal);
    return verdict;
  }
  return { ...verdict, bytes: whole };
}

/**
 * THE FINALIZE CHECK of a stored video: its container's signature, from the
 * leading window only (never widened, never read whole: a video may be a
 * gigabyte). On a refusal every object of the upload is removed and one
 * event is recorded. What the video carries is not inspected.
 */
export async function checkStoredUploadSignature(
  store: StoredUploadBucket,
  path: string,
  input: StoredUploadInput,
): Promise<StoredUploadResult> {
  const head = await fetchObjectWindow(store, path);
  if (!head) return { ok: false, family: null, message: input.unreadableMessage, absent: true };
  const verdict = await checkUploadPrefix(head.prefix, input);
  if (!verdict.ok) {
    await removeQuietly(store, input.removeOnRefusal);
    return verdict;
  }
  return { ...verdict, bytes: head.prefix };
}
