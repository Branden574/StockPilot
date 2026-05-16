import { notFound } from 'next/navigation';

import { SignatureCollector } from '@/components/orders/signature-collector';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Sign for order · StockPilot',
  robots: { index: false, follow: false },
};

const TOKEN_RE = /^[0-9a-f]{64}$/i;

/**
 * Order summary surfaced to the public signature page. Stays minimal —
 * only enough context for the recipient to confirm "yes this is my
 * order" before signing. We deliberately do NOT expose internal IDs,
 * stock quantities, or warehouse staff names beyond what's needed for
 * confirmation.
 */
export interface OrderSignSummary {
  id: string;
  status: string;
  requesterName: string | null;
  requesterEmail: string | null;
  fulfillmentType: 'pickup' | 'delivery';
  warehouseName: string | null;
  charterName: string | null;
  lines: Array<{
    itemName: string;
    quantityPicked: number;
    quantityRequested: number;
  }>;
}

export default async function OrderSignPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!TOKEN_RE.test(token)) notFound();

  const admin = createAdminClient();

  const { data: orderRow } = await admin
    .from('order_requests')
    .select(
      'id, status, requester_name, requester_email, requester_user_id, ' +
        'fulfillment_type, warehouse_id, delivery_charter_id, ' +
        'signature_token_expires_at, signed_at',
    )
    .eq('signature_token', token)
    .maybeSingle();

  if (!orderRow) notFound();
  const order = orderRow as unknown as {
    id: string;
    status: string;
    requester_name: string | null;
    requester_email: string | null;
    requester_user_id: string | null;
    fulfillment_type: 'pickup' | 'delivery';
    warehouse_id: string;
    delivery_charter_id: string | null;
    signature_token_expires_at: string | null;
    signed_at: string | null;
  };

  const expired =
    order.signature_token_expires_at !== null &&
    new Date(order.signature_token_expires_at).getTime() < Date.now();
  const wrongStatus = !['staged_for_pickup', 'in_transit', 'signature_requested'].includes(
    order.status,
  );
  const alreadySigned = order.signed_at !== null;

  if (expired || wrongStatus || alreadySigned) {
    return <InvalidPanel reason={alreadySigned ? 'already' : 'invalid'} />;
  }

  // Internal-user orders carry name/email in user_profiles, not on the
  // row — so when requester_user_id is set and the row columns are
  // blank, hydrate from the profile so the signature page can pre-fill.
  let resolvedRequesterName = order.requester_name;
  let resolvedRequesterEmail = order.requester_email;

  if (order.requester_user_id && (!resolvedRequesterName || !resolvedRequesterEmail)) {
    const { data: profile } = await admin
      .from('user_profiles')
      .select('full_name, email')
      .eq('id', order.requester_user_id)
      .maybeSingle();
    const p = profile as { full_name?: string | null; email?: string | null } | null;
    if (!resolvedRequesterName && p?.full_name) resolvedRequesterName = p.full_name;
    if (!resolvedRequesterEmail && p?.email) resolvedRequesterEmail = p.email;
  }

  // Parallel: warehouse name + charter name + lines.
  const [whRes, charterRes, linesRes] = await Promise.all([
    admin.from('warehouses').select('name').eq('id', order.warehouse_id).maybeSingle(),
    order.delivery_charter_id
      ? admin
          .from('charters')
          .select('name')
          .eq('id', order.delivery_charter_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    admin
      .from('order_request_lines')
      .select(
        `quantity_picked, quantity_requested,
         item:inventory_items!item_id (name)`,
      )
      .eq('order_request_id', order.id),
  ]);

  type LineRow = {
    quantity_picked: number | null;
    quantity_requested: number;
    item: { name?: string } | { name?: string }[] | null;
  };
  const lines = ((linesRes.data ?? []) as LineRow[]).map((row) => {
    const itemField = row.item;
    const item = Array.isArray(itemField) ? itemField[0] ?? null : itemField;
    return {
      itemName: item?.name ?? '—',
      quantityPicked: Number(row.quantity_picked ?? 0),
      quantityRequested: Number(row.quantity_requested),
    };
  });

  const summary: OrderSignSummary = {
    id: order.id,
    status: order.status,
    requesterName: resolvedRequesterName,
    requesterEmail: resolvedRequesterEmail,
    fulfillmentType: order.fulfillment_type,
    warehouseName: (whRes.data as { name?: string } | null)?.name ?? null,
    charterName: (charterRes.data as { name?: string } | null)?.name ?? null,
    lines,
  };

  return (
    <div className="space-y-6">
      <header className="text-center">
        <p className="text-muted-foreground text-[11px] font-medium uppercase tracking-[0.12em]">
          StockPilot
        </p>
        <h1 className="font-display mt-1 text-[26px] font-medium leading-tight tracking-[-0.025em]">
          Sign for your order
        </h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Order #{summary.id.slice(0, 8).toUpperCase()}
        </p>
      </header>
      <SignatureCollector token={token} summary={summary} />
    </div>
  );
}

/**
 * Ambiguous-failure panel — we deliberately don't tell the signer which
 * check failed (expired vs wrong status vs invalid token) so a bad
 * actor probing tokens learns nothing from response variation. The
 * "already signed" branch is its own message because that's the only
 * benign case where the signer might rationally expect a different
 * outcome.
 */
function InvalidPanel({ reason }: { reason: 'invalid' | 'already' }) {
  return (
    <div className="text-center">
      <header className="space-y-2">
        <p className="text-muted-foreground text-[11px] font-medium uppercase tracking-[0.12em]">
          StockPilot
        </p>
        <h1 className="font-display text-[26px] font-medium leading-tight tracking-[-0.025em]">
          {reason === 'already' ? 'This order is already signed' : "We can't sign this order"}
        </h1>
        <p className="text-muted-foreground mt-3 text-sm">
          {reason === 'already'
            ? 'Thanks — looks like this order was already completed. Check your inbox for the confirmation email.'
            : "This link is invalid, expired, or the order is no longer awaiting a signature. If you think this is wrong, get in touch with the warehouse."}
        </p>
      </header>
    </div>
  );
}
