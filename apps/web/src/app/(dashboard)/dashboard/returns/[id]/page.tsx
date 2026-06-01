import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { ReturnActionsPanel } from '@/components/returns/return-actions-panel';
import {
  ReturnStatusBadge,
  returnReasonLabel,
} from '@/components/returns/return-status-badge';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { requireOrgContext } from '@/lib/auth/session';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { createClient } from '@/lib/supabase/server';
import { formatNumber, formatRelative } from '@/lib/utils';
import { RMAService } from '@/server/services/returns';
import { ShippingService, type CarrierShipmentRow } from '@/server/services/shipping';

import { hasPermission } from '@stockpilot/core';

export default async function ReturnDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const moduleAccess = await checkModuleAccess('returns');
  if (!moduleAccess.enabled) {
    return <ModuleNotEnabled moduleId="returns" canManage={moduleAccess.canManage} />;
  }
  const ctx = await requireOrgContext();
  if (!hasPermission(ctx.role, 'returns:manage')) {
    redirect('/dashboard');
  }

  const svc = await RMAService.forCurrentUser();
  let detail;
  try {
    detail = await svc.get(id);
  } catch {
    notFound();
  }

  // Resolve item name/sku for each line. Items are org-scoped under RLS, so
  // this read can only return items in the caller's org.
  const itemIds = Array.from(new Set(detail.lines.map((l) => l.item_id)));
  const itemMap = new Map<string, { name: string; sku: string | null }>();
  if (itemIds.length > 0) {
    const supabase = await createClient();
    const { data: items } = await supabase
      .from('inventory_items')
      .select('id, name, sku')
      .eq('organization_id', ctx.organizationId)
      .in('id', itemIds);
    for (const it of (items ?? []) as Array<{
      id: string;
      name: string;
      sku: string | null;
    }>) {
      itemMap.set(it.id, { name: it.name, sku: it.sku });
    }
  }

  const totalQty = detail.lines.reduce((s, l) => s + (Number(l.quantity) || 0), 0);

  // Shipping (reverse-label) affordance: gated on the shipping module being
  // enabled AND the viewer holding shipping:manage (owner/admin). Independent of
  // the returns gate above. Shown only once a return is approved/received.
  const shippingAccess = await checkModuleAccess('shipping');
  const canManageShipping =
    shippingAccess.enabled && hasPermission(ctx.role, 'shipping:manage');
  let returnLabel: CarrierShipmentRow | null = null;
  if (shippingAccess.enabled) {
    try {
      const shippingSvc = await ShippingService.forCurrentUser();
      returnLabel = await shippingSvc.getReturnLabel(detail.id);
    } catch {
      returnLabel = null;
    }
  }

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/returns"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to returns
        </Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-2xl font-semibold tracking-tight">
                {detail.return_number ?? 'Return'}
              </h1>
              <ReturnStatusBadge status={detail.status} />
              <Badge variant="outline" className="capitalize">
                {detail.source}
              </Badge>
            </div>
            <p className="text-muted-foreground mt-1 text-sm">
              Against{' '}
              <Link
                href={`/dashboard/orders/${detail.order_request_id}`}
                className="text-foreground font-medium hover:underline"
              >
                order {detail.order_request_id.slice(0, 8)}
              </Link>
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <section className="bg-card rounded-xl border">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="text-sm font-medium">Lines ({detail.lines.length})</h2>
              <p className="text-muted-foreground text-xs tabular-nums">
                Total qty {formatNumber(totalQty)}
              </p>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead>Disposition</TableHead>
                  <TableHead>Applied</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.lines.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className="text-muted-foreground py-6 text-center text-sm"
                    >
                      No lines on this return.
                    </TableCell>
                  </TableRow>
                )}
                {detail.lines.map((l) => {
                  const item = itemMap.get(l.item_id);
                  return (
                    <TableRow key={l.id}>
                      <TableCell>
                        {item ? (
                          <Link
                            href={`/dashboard/inventory/${l.item_id}`}
                            className="hover:underline"
                          >
                            <div className="font-medium">{item.name}</div>
                            {item.sku && (
                              <div className="text-muted-foreground font-mono text-[11px]">
                                {item.sku}
                              </div>
                            )}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground italic">Deleted item</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(l.quantity)}
                      </TableCell>
                      <TableCell>
                        {l.disposition === 'restock' ? (
                          <Badge variant="success">Restock</Badge>
                        ) : (
                          <Badge variant="destructive">Scrap</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {l.applied ? 'Yes' : '—'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </section>

          {detail.notes && (
            <section className="bg-card rounded-xl border p-4">
              <h2 className="text-muted-foreground text-[10.5px] uppercase tracking-[0.08em]">
                Notes
              </h2>
              <p className="mt-1.5 whitespace-pre-wrap text-sm">{detail.notes}</p>
            </section>
          )}

          {detail.denial_reason && detail.status === 'denied' && (
            <section className="bg-card border-destructive/40 rounded-xl border p-4">
              <h2 className="text-destructive text-sm font-medium">Denied</h2>
              <p className="mt-1 whitespace-pre-wrap text-sm">{detail.denial_reason}</p>
            </section>
          )}

          <ReturnActionsPanel
            returnId={detail.id}
            status={detail.status}
            canManageShipping={canManageShipping}
            returnLabel={
              returnLabel
                ? {
                    status: returnLabel.status,
                    carrier: returnLabel.carrier,
                    service: returnLabel.service,
                    rate_cents: returnLabel.rate_cents,
                    currency: returnLabel.currency,
                    tracking_code: returnLabel.tracking_code,
                    tracking_url: returnLabel.tracking_url,
                    label_url: returnLabel.label_url,
                  }
                : null
            }
          />
        </div>

        <aside className="space-y-4">
          <section className="bg-card rounded-xl border p-4 text-xs">
            <h2 className="text-muted-foreground mb-2 text-[10.5px] uppercase tracking-[0.08em]">
              Details
            </h2>
            <dl className="space-y-1.5 text-[11.5px]">
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Reason</dt>
                <dd className="text-right">{returnReasonLabel(detail.reason_code)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Source</dt>
                <dd className="text-right capitalize">{detail.source}</dd>
              </div>
              {detail.requester_name && (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Requester</dt>
                  <dd className="text-right">{detail.requester_name}</dd>
                </div>
              )}
              {detail.requester_email && (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Email</dt>
                  <dd className="truncate text-right">{detail.requester_email}</dd>
                </div>
              )}
            </dl>
          </section>

          <section className="bg-card rounded-xl border p-4 text-xs">
            <h2 className="text-muted-foreground mb-2 text-[10.5px] uppercase tracking-[0.08em]">
              Timeline
            </h2>
            <dl className="space-y-1.5 text-[11.5px]">
              <TimelineRow label="Created" value={detail.created_at} />
              <TimelineRow label="Approved" value={detail.approved_at} />
              <TimelineRow label="Received" value={detail.received_at} />
              <TimelineRow label="Closed" value={detail.closed_at} />
              <TimelineRow label="Denied" value={detail.denied_at} />
            </dl>
          </section>
        </aside>
      </div>
    </div>
  );
}

function TimelineRow({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums text-right">{formatRelative(value)}</dd>
    </div>
  );
}
