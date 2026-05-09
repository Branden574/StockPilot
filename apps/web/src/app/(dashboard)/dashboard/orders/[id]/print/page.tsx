import { notFound } from 'next/navigation';

import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { OrderRequestsService } from '@/server/services/order-requests';
import { formatNumber } from '@/lib/utils';

export default async function OrderPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requireOrgContext();

  const svc = await OrderRequestsService.forCurrentUser();
  let detail;
  try {
    detail = await svc.get(id);
  } catch {
    notFound();
  }

  const { request, lines, warehouseName, requesterDisplay } = detail;
  const itemIds = lines.map((l) => l.item?.id).filter((x): x is string => Boolean(x));

  // bin_location lives on inventory_items but isn't in the service detail
  // payload — fetch a small map so the pick list reads as a real walking
  // path through the warehouse.
  const supabase = await createClient();
  const { data: binData } = await supabase
    .from('inventory_items')
    .select('id, bin_location')
    .eq('organization_id', ctx.organizationId)
    .in('id', itemIds.length ? itemIds : ['00000000-0000-0000-0000-000000000000']);

  const binByItem = new Map<string, string | null>();
  for (const r of (binData ?? []) as Array<{ id: string; bin_location: string | null }>) {
    binByItem.set(r.id, r.bin_location ?? null);
  }

  const sortedLines = [...lines].sort((a, b) => {
    const ba = (a.item ? (binByItem.get(a.item.id) ?? '') : '').toLowerCase();
    const bb = (b.item ? (binByItem.get(b.item.id) ?? '') : '').toLowerCase();
    if (ba && bb) return ba.localeCompare(bb);
    if (ba) return -1;
    if (bb) return 1;
    return (a.item?.name ?? '').localeCompare(b.item?.name ?? '');
  });

  const totalQty = lines.reduce(
    (s, l) => s + (Number(l.quantity_requested) || 0),
    0,
  );

  return (
    <div className="print-page mx-auto max-w-3xl px-6 py-8">
      <style>{`
        @media print {
          [data-dashboard-shell] header,
          [data-dashboard-shell] aside,
          [data-dashboard-shell] nav { display: none !important; }
          body { background: white !important; color: black !important; }
          .print-page { color: black; }
          .print-page table { color: black; }
          .print-page th, .print-page td { border-color: black !important; }
        }
        @page { margin: 0.5in; }
      `}</style>

      <header className="border-b border-black/30 pb-3">
        <h1 className="text-xl font-semibold">Pick list</h1>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Order</dt>
          <dd className="font-mono">{request.id}</dd>
          <dt className="text-muted-foreground">Warehouse</dt>
          <dd>{warehouseName ?? '—'}</dd>
          <dt className="text-muted-foreground">Requester</dt>
          <dd>{requesterDisplay}</dd>
          <dt className="text-muted-foreground">Status</dt>
          <dd className="capitalize">{request.status.replace(/_/g, ' ')}</dd>
          <dt className="text-muted-foreground">Total qty</dt>
          <dd className="tabular-nums">{formatNumber(totalQty)}</dd>
        </dl>
      </header>

      <table className="mt-4 w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-black/40 text-left">
            <th className="py-2 pr-3">Bin</th>
            <th className="py-2 pr-3">Item</th>
            <th className="py-2 pr-3">SKU</th>
            <th className="py-2 pr-3 text-right">Qty</th>
            <th className="py-2 pr-3">Picked</th>
          </tr>
        </thead>
        <tbody>
          {sortedLines.length === 0 && (
            <tr>
              <td colSpan={5} className="text-muted-foreground py-4 text-center">
                No lines.
              </td>
            </tr>
          )}
          {sortedLines.map((l) => (
            <tr key={l.id} className="border-b border-black/15 align-top">
              <td className="py-2 pr-3 font-mono text-xs">
                {l.item ? (binByItem.get(l.item.id) ?? '—') : '—'}
              </td>
              <td className="py-2 pr-3">{l.item?.name ?? 'Deleted item'}</td>
              <td className="py-2 pr-3 font-mono text-xs">{l.item?.sku ?? '—'}</td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {formatNumber(l.quantity_requested)}
              </td>
              <td className="py-2 pr-3">
                <span className="inline-block h-4 w-4 border border-black/60 align-middle" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {request.notes && (
        <section className="mt-6">
          <h2 className="text-xs font-semibold uppercase tracking-wide">Notes</h2>
          <p className="mt-1 whitespace-pre-wrap text-sm">{request.notes}</p>
        </section>
      )}
    </div>
  );
}
