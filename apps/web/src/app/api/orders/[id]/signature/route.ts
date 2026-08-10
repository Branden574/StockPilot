import { NextResponse, type NextRequest } from 'next/server';

import { can } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { exportRateLimited } from '@/lib/export-rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ctx = await withApiContext(req);
  const limited = ctx && (await exportRateLimited(ctx.userId, ctx.organizationId));
  if (limited) return limited;
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
  // the signature dialog) renders: can(orders:approve) OR the assigned driver.
  // Reuses the assigned-driver predicate from OrderRequestsService.markInTransit
  // (assigned_delivery_user_id is non-null AND equals the caller).
  const isAssignedDriver =
    row?.assigned_delivery_user_id != null &&
    row.assigned_delivery_user_id === ctx.userId;
  if (!can(ctx, 'orders:approve') && !isAssignedDriver) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  return NextResponse.json({
    signatureDataUrl: row?.signature_data_url ?? null,
  });
}
