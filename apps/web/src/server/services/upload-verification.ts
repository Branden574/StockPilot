import 'server-only';

import {
  DOCUMENT_BUCKET_MIME_ALLOWLISTS,
  type DocumentBucket,
  type SniffedFile,
} from '@/lib/file-signature';
import { uploadKindsForMimes } from '@/lib/upload-inspect';
import { createAdminClient } from '@/lib/supabase/admin';
import type { SecurityEventHeaders } from '@/server/security/events';
import {
  ORDER_ATTACHMENT_MAX_BYTES,
  PO_ATTACHMENT_MAX_BYTES,
  SUPPORT_SCREENSHOT_MAX_BYTES,
} from '@/lib/upload-size-limits';
import { checkStoredUpload, type UploadSurface } from '@/server/security/upload-checks';

import { ServiceError, type ServiceContext } from './context';
import { uploadObjectsStillNamed } from './upload-still-named';

const SURFACE_OF_BUCKET: Readonly<Record<DocumentBucket, UploadSurface>> = {
  'po-attachments': 'po_attachment',
  'order-attachments': 'order_attachment',
  'support-attachments': 'support_screenshot',
};

/** Each bucket's own cap (part 6): nothing past it is read. */
const MAX_BYTES_OF_BUCKET: Readonly<Record<DocumentBucket, number>> = {
  'po-attachments': PO_ATTACHMENT_MAX_BYTES,
  'order-attachments': ORDER_ATTACHMENT_MAX_BYTES,
  'support-attachments': SUPPORT_SCREENSHOT_MAX_BYTES,
};

/** The table and column whose rows name an object of each bucket (part 6). */
const RECORDS_OF_BUCKET: Readonly<Record<DocumentBucket, { table: string; columns: readonly string[] }>> = {
  'po-attachments': { table: 'po_attachments', columns: ['storage_path'] },
  'order-attachments': { table: 'order_request_attachments', columns: ['storage_path'] },
  'support-attachments': { table: 'support_tickets', columns: ['attachment_path'] },
};

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
  ctx: Pick<ServiceContext, 'organizationId' | 'userId'>,
  bucket: DocumentBucket,
  storagePath: string,
  opts: { unreadableMessage?: string; headers?: SecurityEventHeaders | null } = {},
): Promise<SniffedFile> {
  const store = createAdminClient().storage.from(bucket);

  // Both questions, in the order above, are asked by the one upload check
  // (server/security/upload-checks.ts, part 6), which also records a refusal
  // as a security event in this organization. The prefix read doubles as the
  // existence check, so a finalize never preceded by a real PUT writes no
  // phantom row; an object readable a moment ago and unreadable now is
  // refused and kept (we have not inspected it, so it gets no row, and the
  // person is asked to try again). An object over the bucket's cap is refused
  // from the size storage states, before any of it is read.
  const checked = await checkStoredUpload(store, storagePath, {
    surface: SURFACE_OF_BUCKET[bucket],
    accept: uploadKindsForMimes(DOCUMENT_BUCKET_MIME_ALLOWLISTS[bucket]),
    organizationId: ctx.organizationId,
    maxBytes: MAX_BYTES_OF_BUCKET[bucket],
    removeOnRefusal: [storagePath],
    // A second finalize of a recorded path, or a ticket that already holds
    // this screenshot: refused, never removed.
    stillNamed: (paths) =>
      uploadObjectsStillNamed(RECORDS_OF_BUCKET[bucket].table, RECORDS_OF_BUCKET[bucket].columns, paths),
    removedBy: { organizationId: ctx.organizationId, userId: ctx.userId },
    unreadableMessage: opts.unreadableMessage ?? 'This file could not be verified.',
    headers: opts.headers ?? null,
    wrongTypeMessage: 'This file could not be uploaded because it failed our security checks.',
  });
  if (!checked.ok) {
    // The specific message for a verdict, not the generic one. The uploader
    // is a warehouse manager holding a real invoice they need attached, and
    // "failed our security checks" with no route forward is a support ticket.
    // Every verdict's sentence names the problem and the way out.
    throw new ServiceError('validation_error', checked.message);
  }
  return { kind: checked.kind, mime: checked.mime } as SniffedFile;
}
