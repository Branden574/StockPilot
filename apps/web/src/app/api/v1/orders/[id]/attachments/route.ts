import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { isBoundarySafeStoragePath } from '@/lib/storage-path';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { OrderAttachmentsService } from '@/server/services/order-attachments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Bearer twin of `addOrderAttachmentAction` — the FINALIZE step for delivery
 * proof uploaded client-direct from the phone (SP-018).
 *
 * WHY THIS ROUTE EXISTS. Mobile used to PUT the photo into the
 * `order-attachments` bucket and then insert the `order_request_attachments`
 * row itself via PostgREST. `OrderAttachmentsService.add()` — the path every
 * web surface takes — runs `verifyStoredDocumentOrDelete()`, which sniffs the
 * object's REAL magic bytes and scans the body for active content, deleting
 * the object and refusing the row on either failure. Proof-of-delivery
 * attachments are later signed and RENDERED for the whole org, so an
 * unverified one is a payload host on our own storage origin; from a phone,
 * nothing verified them at all.
 *
 * The route mints no new authority: the service owns the manager floor, the
 * order-belongs-to-this-org check, the attachable-status rule, the
 * `{org}/{orderId}/{file}` positive path shape (HI-8) and the byte
 * verification. This is Bearer auth, input shape and error mapping.
 *
 * DELIBERATELY NOT DONE HERE: the `authenticated` INSERT policy on
 * `order_request_attachments` stays, because binaries already in the field
 * still insert directly. Revoking it is a later migration, once that OTA
 * audience has moved.
 */
const bodySchema = z.object({
  // Edge guard only (traversal / encoded traversal / absolute paths / bucket
  // hops). It cannot know this org or this order — the load-bearing pin is
  // the service's `orderAttachmentPathShape`, which knows both ids.
  storagePath: z
    .string()
    .min(1)
    .max(500)
    .refine(isBoundarySafeStoragePath, 'Invalid storage path.'),
  fileName: z.string().max(300).nullable().optional(),
  // Ignored downstream on purpose: `add()` records the SNIFFED mime.
  contentType: z.string().max(150).nullable().optional(),
  sizeBytes: z.number().int().nonnegative().nullable().optional(),
  // Same enum and same default as the web action, so a photo attached from
  // the phone and one attached from the browser land identically.
  kind: z.enum(['signature', 'dropoff_photo', 'location', 'other']).default('other'),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json(
      { error: 'validation_error', message: 'That order id is not valid.' },
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
    const res = await new OrderAttachmentsService(ctx).add({
      orderRequestId: id,
      storagePath: parsed.data.storagePath,
      // Explicit nulls — see the PO twin: `undefined` would be dropped from
      // the insert payload instead of stored as NULL.
      fileName: parsed.data.fileName ?? null,
      contentType: parsed.data.contentType ?? null,
      sizeBytes: parsed.data.sizeBytes ?? null,
      kind: parsed.data.kind,
    });
    return NextResponse.json(res);
  } catch (e) {
    if (e instanceof ServiceError) {
      // Mapped, never swallowed: a refused file must not read to the client
      // as "the server is broken, retry".
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    void reportError(e, {
      tag: 'api.v1.orders.attachments',
      organizationId: ctx.organizationId,
    });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
