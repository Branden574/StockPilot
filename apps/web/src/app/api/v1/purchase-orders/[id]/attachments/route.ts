import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { isBoundarySafeStoragePath } from '@/lib/storage-path';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { PoAttachmentsService } from '@/server/services/po-attachments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Bearer twin of `addPoAttachmentAction` — the FINALIZE step for a PO
 * attachment uploaded client-direct from the phone (SP-018).
 *
 * WHY THIS ROUTE EXISTS. Mobile used to PUT the object into the
 * `po-attachments` bucket and then insert the `po_attachments` row itself via
 * PostgREST. Every web surface goes through `PoAttachmentsService.add()`,
 * which runs `verifyStoredDocumentOrDelete()`: it sniffs the object's REAL
 * magic bytes (never the client's declared Content-Type) AND scans the whole
 * body for active content, deleting the object and refusing the row on either
 * failure. A genuine PDF carrying `/OpenAction /Launch` passes any
 * client-side magic-byte check, which is exactly why that scan lives on the
 * server — and a file attached from a phone was never scanned at all. The row
 * also recorded whatever `content_type` the client claimed, and that value is
 * what the web panel and `api/purchase-orders/[id]/attachments.zip` both
 * trust when they hand the file to a warehouse manager.
 *
 * This route MINTS NOTHING NEW: the service already owns the
 * `purchase_orders:manage` gate, the org-owns-the-PO check, the
 * `{org}/{poId}/{file}` positive path shape (HI-8) and the byte verification.
 * The route's whole job is Bearer auth, input shape, and error mapping.
 *
 * DELIBERATELY NOT DONE HERE: the `authenticated` INSERT policy on
 * `po_attachments` (0211) stays. Binaries already in the field still insert
 * directly, and revoking it before that OTA audience has moved would break
 * attaching for every one of them. Dropping it is a later migration.
 */
const bodySchema = z.object({
  // Boundary guard only — it cannot know this org or this PO, so it rejects
  // the obviously-hostile (traversal, encoded traversal, absolute paths,
  // bucket hops) at the edge with a clean validation_error. The LOAD-BEARING
  // check is still the service's `poAttachmentPathShape` pin, which knows
  // both ids; this is defence in depth, not a substitute (storage-path.ts).
  storagePath: z
    .string()
    .min(1)
    .max(500)
    .refine(isBoundarySafeStoragePath, 'Invalid storage path.'),
  fileName: z.string().max(300).nullable().optional(),
  // Accepted for shape parity with the web action, and ignored downstream on
  // purpose: `add()` records the SNIFFED mime, never the declared one.
  contentType: z.string().max(150).nullable().optional(),
  sizeBytes: z.number().int().nonnegative().nullable().optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json(
      { error: 'validation_error', message: 'That purchase order id is not valid.' },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid request' },
      { status: 400 },
    );
  }

  try {
    const res = await new PoAttachmentsService(ctx).add({
      purchaseOrderId: id,
      storagePath: parsed.data.storagePath,
      // Explicit nulls, not `undefined`: the service writes these columns
      // straight through, and an omitted key would insert `undefined`, which
      // supabase-js drops from the payload rather than storing NULL.
      fileName: parsed.data.fileName ?? null,
      contentType: parsed.data.contentType ?? null,
      sizeBytes: parsed.data.sizeBytes ?? null,
    });
    return NextResponse.json(res);
  } catch (e) {
    if (e instanceof ServiceError) {
      // Mapped, never swallowed: the mobile client shows `message` verbatim,
      // and a refused file must read as "the server refused this file", not
      // as "the server is broken, retry" — the outbox retries the latter.
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    void reportError(e, {
      tag: 'api.v1.purchase-orders.attachments',
      organizationId: ctx.organizationId,
    });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
