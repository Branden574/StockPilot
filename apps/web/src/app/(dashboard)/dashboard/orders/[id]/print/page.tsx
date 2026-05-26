import { notFound } from 'next/navigation';

import { AutoPrint } from '@/components/orders/auto-print';
import { requireOrgContext } from '@/lib/auth/session';
import { getCachedOrgTimezone } from '@/lib/dashboard/cached-org';
import { createClient } from '@/lib/supabase/server';
import { OrderRequestsService } from '@/server/services/order-requests';
import { formatNumber } from '@/lib/utils';

interface WarehouseAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
}

function shortId(id: string) {
  return id.split('-')[0]?.toUpperCase() ?? id.slice(0, 8).toUpperCase();
}

function formatDateLong(iso: string, timeZone: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    timeZone,
  });
}

function formatAddressLines(addr: WarehouseAddress | null | undefined): string[] {
  if (!addr) return [];
  const lines: string[] = [];
  if (addr.line1) lines.push(addr.line1);
  if (addr.line2) lines.push(addr.line2);
  const cityState = [addr.city, addr.state].filter(Boolean).join(', ');
  const cityLine = [cityState, addr.postal_code].filter(Boolean).join(' ');
  if (cityLine) lines.push(cityLine);
  if (addr.country) lines.push(addr.country);
  return lines;
}

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

  const supabase = await createClient();
  const orgTimezone = await getCachedOrgTimezone(ctx.organizationId);

  const [orgRes, whRes, binRes] = await Promise.all([
    supabase
      .from('organizations')
      .select('name, logo_url')
      .eq('id', ctx.organizationId)
      .maybeSingle(),
    supabase
      .from('warehouses')
      .select('name, code, address, contact_name, contact_email, contact_phone')
      .eq('id', request.warehouse_id)
      .maybeSingle(),
    supabase
      .from('inventory_items')
      .select('id, bin_location')
      .eq('organization_id', ctx.organizationId)
      .in('id', itemIds.length ? itemIds : ['00000000-0000-0000-0000-000000000000']),
  ]);

  const org = orgRes.data as { name: string; logo_url: string | null } | null;
  const warehouse = whRes.data as
    | {
        name: string;
        code: string;
        address: WarehouseAddress | null;
        contact_name: string | null;
        contact_email: string | null;
        contact_phone: string | null;
      }
    | null;
  const whAddressLines = formatAddressLines(warehouse?.address);

  const binByItem = new Map<string, string | null>();
  for (const r of (binRes.data ?? []) as Array<{ id: string; bin_location: string | null }>) {
    binByItem.set(r.id, r.bin_location ?? null);
  }

  // Pick order: bin_location alphabetical first (so the picker walks the
  // warehouse in a single sweep), then item name as a tiebreaker.
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

  const statusLabel = request.status.replace(/_/g, ' ');

  return (
    <>
      <AutoPrint />
      <style>{`
        @media print {
          /* Browsers hide these by default, but we override display
             below to strip the shell's flex constraints — that override
             would otherwise make <script>'s source text render as
             visible content on the printed page. Force them back to
             none. */
          script, style, link, noscript, template { display: none !important; }

          /* Hide dashboard chrome — Sidebar renders as <aside>, Topbar
             as <header>, plus the keyboard skip link. */
          aside, header { display: none !important; }
          a[href="#main-content"] { display: none !important; }

          /* Reset document-level paint. */
          html, body {
            background: white !important;
            color: black !important;
            height: auto !important;
            overflow: visible !important;
          }

          /* Strip the dashboard shell's flex / h-dvh / overflow-hidden
             constraints so the print page flows naturally onto paper.
             We target the wrapper chain explicitly instead of body > *
             so we don't accidentally hit <script> / <style> tags Next
             inlines as body children. */
          body > div,
          body > div > div,
          main,
          main > div {
            display: block !important;
            height: auto !important;
            max-height: none !important;
            overflow: visible !important;
            background: white !important;
            color: black !important;
          }

          .print-slip { box-shadow: none !important; border: none !important; }
          .print-slip table { color: black !important; }
          .print-slip th, .print-slip td { border-color: #000 !important; }
        }
        @page { margin: 0.5in; }
      `}</style>

      <div className="print-slip mx-auto max-w-3xl bg-white px-6 py-6 text-black print:px-0 print:py-0">
        {/* ── HEADER: logo + org on left, slip metadata on right ────── */}
        <header className="flex items-start justify-between gap-6 border-b-2 border-black pb-4">
          <div className="flex items-start gap-3">
            {org?.logo_url ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={org.logo_url}
                alt={org.name}
                className="h-14 w-14 rounded-sm object-contain"
              />
            ) : null}
            <div>
              <div className="text-lg font-semibold leading-tight">
                {org?.name ?? 'Workspace'}
              </div>
              <div className="text-xs text-neutral-700">
                Order #{shortId(request.id)}
              </div>
            </div>
          </div>

          <div className="text-right">
            <div className="text-xl font-bold uppercase tracking-wide">
              Packing Slip
            </div>
            <dl className="mt-2 grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-xs">
              <dt className="text-neutral-600">Status</dt>
              <dd className="text-right capitalize">{statusLabel}</dd>
              <dt className="text-neutral-600">Issued</dt>
              <dd className="text-right">{formatDateLong(request.created_at, orgTimezone)}</dd>
              {request.approved_at && (
                <>
                  <dt className="text-neutral-600">Approved</dt>
                  <dd className="text-right">{formatDateLong(request.approved_at, orgTimezone)}</dd>
                </>
              )}
              <dt className="text-neutral-600">Lines</dt>
              <dd className="text-right tabular-nums">{lines.length}</dd>
              <dt className="text-neutral-600">Total qty</dt>
              <dd className="text-right tabular-nums">{formatNumber(totalQty)}</dd>
            </dl>
          </div>
        </header>

        {/* ── FROM / TO blocks ─────────────────────────────────────── */}
        <section className="mt-4 grid grid-cols-2 gap-6">
          <div>
            <h2 className="text-[10px] font-semibold uppercase tracking-wider text-neutral-600">
              Ship From
            </h2>
            <div className="mt-1 text-sm font-semibold">
              {warehouse?.name ?? warehouseName ?? '—'}
              {warehouse?.code && (
                <span className="ml-2 font-mono text-xs font-normal text-neutral-700">
                  {warehouse.code}
                </span>
              )}
            </div>
            {whAddressLines.map((line, i) => (
              <div key={i} className="text-xs text-neutral-800">
                {line}
              </div>
            ))}
            {warehouse?.contact_name && (
              <div className="mt-1 text-xs text-neutral-800">
                {warehouse.contact_name}
              </div>
            )}
            {warehouse?.contact_phone && (
              <div className="text-xs text-neutral-800">{warehouse.contact_phone}</div>
            )}
            {warehouse?.contact_email && (
              <div className="text-xs text-neutral-800">{warehouse.contact_email}</div>
            )}
          </div>

          <div>
            <h2 className="text-[10px] font-semibold uppercase tracking-wider text-neutral-600">
              Ship To
            </h2>
            <div className="mt-1 text-sm font-semibold">{requesterDisplay}</div>
            {request.requester_org_label && (
              <div className="text-xs text-neutral-800">
                {request.requester_org_label}
              </div>
            )}
            {request.requester_email && (
              <div className="text-xs text-neutral-800">{request.requester_email}</div>
            )}
            <div className="mt-1 text-xs uppercase tracking-wider text-neutral-600">
              {request.source === 'public_link' ? 'External request' : 'Internal request'}
            </div>
          </div>
        </section>

        {/* ── LINE TABLE ──────────────────────────────────────────── */}
        <table className="mt-6 w-full border-collapse text-sm">
          <thead>
            <tr className="border-y-2 border-black text-left">
              <th className="py-2 pr-3 text-[10px] font-semibold uppercase tracking-wider">
                Bin
              </th>
              <th className="py-2 pr-3 text-[10px] font-semibold uppercase tracking-wider">
                Item
              </th>
              <th className="py-2 pr-3 text-[10px] font-semibold uppercase tracking-wider">
                SKU
              </th>
              <th className="py-2 pr-3 text-right text-[10px] font-semibold uppercase tracking-wider">
                Qty
              </th>
              <th className="w-10 py-2 pr-0 text-center text-[10px] font-semibold uppercase tracking-wider">
                ✓
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedLines.length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-neutral-600">
                  No lines on this order.
                </td>
              </tr>
            )}
            {sortedLines.map((l) => (
              <tr
                key={l.id}
                className="break-inside-avoid border-b border-neutral-400 align-top"
              >
                <td className="py-2 pr-3 font-mono text-xs">
                  {l.item ? (binByItem.get(l.item.id) ?? '—') : '—'}
                </td>
                <td className="py-2 pr-3">{l.item?.name ?? 'Deleted item'}</td>
                <td className="py-2 pr-3 font-mono text-xs">{l.item?.sku ?? '—'}</td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {formatNumber(l.quantity_requested)}
                </td>
                <td className="py-2 text-center">
                  <span className="inline-block h-4 w-4 border border-black align-middle" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* ── NOTES ───────────────────────────────────────────────── */}
        {request.notes && (
          <section className="mt-5 break-inside-avoid border border-neutral-400 p-3">
            <h2 className="text-[10px] font-semibold uppercase tracking-wider text-neutral-600">
              Notes from requester
            </h2>
            <p className="mt-1 whitespace-pre-wrap text-sm">{request.notes}</p>
          </section>
        )}

        {/* ── SIGNATURE BLOCK ─────────────────────────────────────── */}
        <section className="mt-10 break-inside-avoid">
          <div className="grid grid-cols-2 gap-8">
            <div>
              <div className="border-b border-black pb-1 text-xs text-neutral-600">
                Picked by (sign + print)
              </div>
              <div className="mt-1 h-10" />
              <div className="border-b border-black pb-1 text-xs text-neutral-600">
                Date
              </div>
              <div className="mt-1 h-8" />
            </div>
            <div>
              <div className="border-b border-black pb-1 text-xs text-neutral-600">
                Received by (sign + print)
              </div>
              <div className="mt-1 h-10" />
              <div className="border-b border-black pb-1 text-xs text-neutral-600">
                Date
              </div>
              <div className="mt-1 h-8" />
            </div>
          </div>
          <p className="mt-6 text-center text-[10px] text-neutral-600">
            Generated by {org?.name ?? 'StockPilot'} · Order #{shortId(request.id)}
          </p>
        </section>
      </div>
    </>
  );
}
