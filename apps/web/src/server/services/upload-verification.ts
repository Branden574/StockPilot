import 'server-only';

import { scanDocumentBytes, THREAT_MESSAGES } from '@/lib/document-threat-scan';
import {
  isSniffedFileAllowedInBucket,
  sniffFile,
  type DocumentBucket,
  type SniffedFile,
} from '@/lib/file-signature';
import { fetchObjectPrefix } from '@/lib/storage-object-prefix';
import { createAdminClient } from '@/lib/supabase/admin';

import { ServiceError } from './context';

/**
 * The finalize-time gate for client-direct uploads into the DOCUMENT buckets.
 *
 * ═══ WHY THIS IS ONE FUNCTION AND NOT TWO COPIES ═══
 *
 * `PoAttachmentsService.add` and `OrderAttachmentsService.add` had the same
 * fifteen lines of verify-or-delete, arrived at independently and kept in step
 * by hand. Recurring bug pattern #26 in the reference notes is exactly this:
 * a fix applied to one copy of a duplicated function is not a fix. Adding a
 * SECOND check to both copies is how you find out which one someone forgets,
 * so the pair collapses into this before the second check goes in.
 *
 * ═══ THE TWO QUESTIONS, IN ORDER ═══
 *
 *   1. ARE THESE BYTES WHAT THEY CLAIM TO BE?  `sniffFile`, on the leading
 *      window. The bucket's own `allowed_mime_types` only ever saw the
 *      Content-Type the browser attached to its PUT, so this is the first
 *      time anything has looked at the actual file.
 *
 *   2. IS WHAT THEY ARE SAFE TO OPEN?  `scanDocumentBytes`, on the WHOLE
 *      object. A file can be a flawless PDF whose entire purpose is to run
 *      something on the machine of the person who opens it, and question 1
 *      has nothing to say about that.
 *
 * Both failures do the same thing: REMOVE the object and write no row. Never
 * leave an unverified object behind with a row pointing at it, and never leave
 * one behind without a row either — an orphan in a bucket is still an object
 * that can be signed and served.
 *
 * ═══ WHY THE WHOLE OBJECT, WHEN THE SNIFF NEEDS 4 KB ═══
 *
 * Active content lives anywhere in a PDF, and by convention much of it lives
 * near the END — the catalog and its `/OpenAction` are typically written last.
 * Scanning a prefix would produce a confident "clean" on a file that was never
 * examined, which is worse than not scanning: it would be believed.
 *
 * The re-read is skipped when the prefix already IS the whole object (small
 * files, and the widened read `fetchObjectPrefix` performs for a metadata-heavy
 * JPEG), so it costs nothing in the common small-document case. These two
 * buckets take roughly two dozen uploads a month between them; the read is not
 * worth optimising further, and a size-conditional shortcut would be a place
 * for a file to hide.
 */
export async function verifyStoredDocumentOrDelete(
  bucket: DocumentBucket,
  storagePath: string,
): Promise<SniffedFile> {
  const admin = createAdminClient();
  const store = admin.storage.from(bucket);

  // The prefix read doubles as the existence check, so a finalize never
  // preceded by a real PUT writes no phantom row.
  const head = await fetchObjectPrefix(store, storagePath);
  if (!head) {
    throw new ServiceError('validation_error', 'This file could not be verified.');
  }

  const sniffed = sniffFile(head.prefix);
  if (!sniffed || !isSniffedFileAllowedInBucket(sniffed, bucket)) {
    await removeQuietly(store, storagePath);
    throw new ServiceError(
      'validation_error',
      'This file could not be uploaded because it failed our security checks.',
    );
  }

  const whole =
    head.totalSize > head.prefix.byteLength
      ? await downloadWhole(store, storagePath)
      : head.prefix;
  if (!whole) {
    // Readable a moment ago, unreadable now. Fail closed: we have not
    // inspected this object, so it does not get a row.
    await removeQuietly(store, storagePath);
    throw new ServiceError('validation_error', 'This file could not be verified.');
  }

  const threat = scanDocumentBytes(whole, sniffed.kind);
  if (threat) {
    await removeQuietly(store, storagePath);
    // The specific message, not the generic one. The uploader is a warehouse
    // manager holding a real invoice they need attached, and "failed our
    // security checks" with no route forward is a support ticket. Every one of
    // these names the problem and the way out.
    throw new ServiceError('validation_error', THREAT_MESSAGES[threat.code]);
  }

  return sniffed;
}

type StoreApi = ReturnType<ReturnType<typeof createAdminClient>['storage']['from']>;

async function downloadWhole(store: StoreApi, path: string): Promise<Uint8Array | null> {
  const { data, error } = await store.download(path);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}

/**
 * The delete is best-effort ON PURPOSE, and the refusal is not.
 *
 * If the remove fails we still refuse the upload — the row is what makes an
 * object reachable through the app, and there is no row. Letting a failed
 * cleanup throw would replace a clear "this file was rejected" with an
 * internal error, and would leave the caller unable to tell a rejected upload
 * from a broken one.
 */
async function removeQuietly(store: StoreApi, path: string): Promise<void> {
  try {
    await store.remove([path]);
  } catch {
    // Deliberately swallowed — see above.
  }
}
