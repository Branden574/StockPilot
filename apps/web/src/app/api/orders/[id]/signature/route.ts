import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { exportRateLimited } from '@/lib/export-rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';
import { isHandOverEntitled, readOrderSecrets } from '@/server/lib/order-secrets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A customer's signature is never kept by a shared or browser cache (review finding 7). */
const NO_STORE = { 'cache-control': 'private, no-store' } as const;

/**
 * Lazily returns the captured signature (data-URL PNG) for one order. The
 * order-detail page used to serialize this base64 blob into the RSC flight
 * payload on every render for manager/driver viewers, even though it's only
 * ever seen inside a closed-by-default dialog. Fetching it on dialog-open
 * keeps the blob out of the initial payload.
 *
 * Auth: the user-scoped client scopes the row to the caller's org, but that is
 * NOT sufficient on its own — `order_requests_select` is a MEMBER-level RLS
 * policy (is_org_member), so every role including viewer passes it. Without an
 * app-layer gate any member could enumerate order ids and harvest customers'
 * captured signature PNGs (PII). So we mirror the order-detail page's
 * `showActionsPanel` gate exactly: an order approver (orders:approve) OR the
 * order's assigned delivery driver may read the signature; everyone else 403s.
 * A shared export throttle matches the sibling order-document routes so the
 * endpoint can't be scripted to exfiltrate signatures in bulk.
 *
 * The phone reads it through the alias /api/v1/orders/[id]/signature (the
 * Vercel firewall bypass covers /api/v1*), since migration 0389; it used to
 * select the image straight from the table. The image is read from
 * order_request_secrets first (slice C moves stored images there, off the
 * member-readable order row), then from the order column.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { data, error } = await ctx.supabase
    .from('order_requests')
    .select('signature_data_url, assigned_delivery_user_id')
    .eq('organization_id', ctx.organizationId)
    .eq('id', id)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
  const row = data as
    | { signature_data_url: string | null; assigned_delivery_user_id: string | null }
    | null;

  // Same gate the page uses to decide whether the actions panel (and therefore
  // the signature dialog) renders: can(orders:approve) OR the assigned driver
  // (assigned_delivery_user_id is non-null AND equals the caller;
  // isHandOverEntitled in server/lib/order-secrets).
  if (!isHandOverEntitled(ctx, { assigned_delivery_user_id: row?.assigned_delivery_user_id ?? null })) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  // The throttle counts only reads the caller may make (a refused caller must
  // not spend the shared export budget or trip the abuse alert).
  const limited = await exportRateLimited(ctx.userId, ctx.organizationId);
  if (limited) return limited;
  if (!row) return NextResponse.json({ signatureDataUrl: null }, { headers: NO_STORE });

  // Side table first (an order of this organization: the row above was read
  // with the caller's own client, scoped to ctx.organizationId). A failed side
  // read falls back to the column, which holds every image until slice C.
  let side: Awaited<ReturnType<typeof readOrderSecrets>>;
  try {
    side = await readOrderSecrets(createAdminClient(), id);
  } catch {
    side = { ok: false };
  }
  return NextResponse.json(
    { signatureDataUrl: (side.ok ? side.secrets?.signatureDataUrl : null) ?? row.signature_data_url ?? null },
    { headers: NO_STORE },
  );
}
