import { Printer } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import type { DriverOption } from '@/components/orders/assign-delivery-dialog';
import { CancelOrderButton } from '@/components/orders/cancel-order-button';
import { ManagerActionsPanel } from '@/components/orders/manager-actions-panel';
import { OrderStatusBadge } from '@/components/orders/status-badge';
import { GeneratePackingSlipDialog } from '@/components/shipments/generate-packing-slip-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { hasPermission } from '@stockpilot/core';
import { requireOrgContext } from '@/lib/auth/session';
import { getWarehouseAccess } from '@/lib/auth/warehouse';
import { createClient } from '@/lib/supabase/server';
import { ChartersService } from '@/server/services/charters';
import {
  OrderRequestsService,
  type OrderRequestRow,
} from '@/server/services/order-requests';
import { WarehouseChartersService } from '@/server/services/warehouse-charters';
import { WarehousesService } from '@/server/services/warehouses';
import { formatNumber, formatRelative } from '@/lib/utils';

const TIMELINE_FIELDS: Array<{
  key: keyof OrderRequestRow;
  label: string;
}> = [
  { key: 'created_at', label: 'Submitted' },
  { key: 'approved_at', label: 'Approved' },
  { key: 'packaging_at', label: 'Packaging' },
  { key: 'ready_at', label: 'Ready for delivery' },
  { key: 'delivered_at', label: 'Delivered' },
  { key: 'cancelled_at', label: 'Cancelled' },
];

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requireOrgContext();
  const canApprove = hasPermission(ctx.role, 'orders:approve');

  const svc = await OrderRequestsService.forCurrentUser();
  let detail;
  try {
    detail = await svc.get(id);
  } catch {
    notFound();
  }

  const { request, lines, reservations, warehouseName, requesterDisplay } = detail;
  const isOwnRequest =
    request.requester_user_id !== null && request.requester_user_id === ctx.userId;

  // Phase 2A — packing slip generation. Manager+ only, and only while the
  // request still has unfulfilled lines that could ship.
  const canPack =
    canApprove &&
    ['approved', 'packing_slip_generated', 'staged_for_delivery'].includes(request.status);
  const remainingToShip = lines.reduce(
    (s, l) =>
      s +
      Math.max(
        0,
        (Number(l.quantity_requested) || 0) - (Number(l.quantity_fulfilled) || 0),
      ),
    0,
  );
  let writableSourceWarehouses: Array<{ id: string; name: string }> = [];
  let packingSlipCharters: Array<{ id: string; name: string; code: string | null }> = [];
  let warehouseCharterPairs: Array<{ warehouse_id: string; charter_id: string }> = [];
  if (canPack && remainingToShip > 0) {
    const [access, whSvc, chSvc, whChSvc] = await Promise.all([
      getWarehouseAccess(),
      WarehousesService.forCurrentUser(),
      ChartersService.forCurrentUser(),
      WarehouseChartersService.forCurrentUser(),
    ]);
    const [allWarehouses, allCharters, pairs] = await Promise.all([
      whSvc.list(),
      chSvc.list(),
      whChSvc.listPairs(),
    ]);
    writableSourceWarehouses = (
      access.hasAllAccess
        ? allWarehouses
        : allWarehouses.filter((w) => access.writableIds.includes(w.id))
    ).map((w) => ({ id: w.id, name: w.name }));
    packingSlipCharters = allCharters
      .filter((c) => c.status === 'active')
      .map((c) => ({ id: c.id, name: c.name, code: c.code }));
    warehouseCharterPairs = pairs;
  }
  const totalQty = lines.reduce(
    (s, l) => s + (Number(l.quantity_requested) || 0),
    0,
  );
  const reservedTotal = reservations.reduce(
    (s, r) => s + (Number(r.quantity) || 0),
    0,
  );

  // Phase 4 — load active org members as candidate drivers for the
  // AssignDeliveryDialog. Only fetched when the viewer can act on the
  // panel (manager+), since staff/viewers never see the assign button.
  let drivers: DriverOption[] = [];
  if (canApprove) {
    const supabase = await createClient();
    const { data: members } = await supabase
      .from('organization_members')
      .select('user_id, user:user_profiles!user_id (id, full_name, email)')
      .eq('organization_id', ctx.organizationId)
      .not('accepted_at', 'is', null);
    type MemberRow = {
      user_id: string;
      user:
        | { id: string; full_name: string | null; email: string }
        | { id: string; full_name: string | null; email: string }[]
        | null;
    };
    drivers = ((members ?? []) as MemberRow[])
      .flatMap((m) => {
        const u = Array.isArray(m.user) ? m.user[0] : m.user;
        if (!u || typeof u.email !== 'string') return [];
        return [
          {
            userId: u.id,
            fullName: u.full_name ?? null,
            email: u.email,
          },
        ];
      })
      .sort((a, b) =>
        (a.fullName ?? a.email).localeCompare(b.fullName ?? b.email),
      );
  }

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/orders"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to orders
        </Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-2xl font-semibold tracking-tight">
                Order request
              </h1>
              <OrderStatusBadge status={request.status} />
              {request.source === 'public_link' && (
                <Badge variant="outline">Public</Badge>
              )}
            </div>
            <p className="text-muted-foreground mt-1 text-sm">
              From <span className="text-foreground font-medium">{requesterDisplay}</span>
              {warehouseName ? <> · {warehouseName}</> : null}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link href={`/dashboard/orders/${id}/print`}>
                <Printer className="h-3.5 w-3.5" />
                Print pick list
              </Link>
            </Button>
            {canPack && remainingToShip > 0 && (
              <GeneratePackingSlipDialog
                orderRequestId={id}
                sourceWarehouses={writableSourceWarehouses}
                charters={packingSlipCharters}
                warehouseCharterPairs={warehouseCharterPairs}
              />
            )}
            {(canApprove || isOwnRequest) && (
              <CancelOrderButton orderId={id} status={request.status} />
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <section className="bg-card rounded-xl border">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="text-sm font-medium">Lines ({lines.length})</h2>
              <p className="text-muted-foreground text-xs tabular-nums">
                Total qty {formatNumber(totalQty)}
              </p>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Requested</TableHead>
                  <TableHead className="text-right">Fulfilled</TableHead>
                  <TableHead className="text-right">On hand</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-muted-foreground py-6 text-center text-sm">
                      No lines on this request.
                    </TableCell>
                  </TableRow>
                )}
                {lines.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell>
                      {l.item ? (
                        <Link
                          href={`/dashboard/inventory/${l.item.id}`}
                          className="hover:underline"
                        >
                          <div className="font-medium">{l.item.name}</div>
                          <div className="text-muted-foreground font-mono text-[11px]">
                            {l.item.sku}
                          </div>
                        </Link>
                      ) : (
                        <span className="text-muted-foreground italic">Deleted item</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(l.quantity_requested)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {formatNumber(l.quantity_fulfilled)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {l.item ? formatNumber(l.item.quantity_on_hand) : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>

          {reservations.length > 0 && (
            <section className="bg-card rounded-xl border p-4 text-xs">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium">Active reservations</h2>
                <span className="text-muted-foreground tabular-nums">
                  {formatNumber(reservedTotal)} reserved
                </span>
              </div>
              <p className="text-muted-foreground mt-1 text-[11.5px]">
                Stock is held until this request is delivered or cancelled.
              </p>
            </section>
          )}

          {request.notes && (
            <section className="bg-card rounded-xl border p-4">
              <h2 className="text-muted-foreground text-[10.5px] uppercase tracking-[0.08em]">
                Requester note
              </h2>
              <p className="mt-1.5 whitespace-pre-wrap text-sm">{request.notes}</p>
            </section>
          )}

          {canApprove && (
            <ManagerActionsPanel
              orderId={id}
              status={request.status}
              internalNotes={request.internal_notes}
              fulfillmentType={request.fulfillment_type}
              assignedDeliveryUserId={request.assigned_delivery_user_id}
              signatureToken={request.signature_token}
              drivers={drivers}
            />
          )}

          {request.denied_reason && request.status === 'denied' && (
            <section className="bg-card border-destructive/40 rounded-xl border p-4">
              <h2 className="text-destructive text-sm font-medium">Denied</h2>
              <p className="mt-1 whitespace-pre-wrap text-sm">
                {request.denied_reason}
              </p>
            </section>
          )}
        </div>

        <aside className="space-y-4">
          <section className="bg-card rounded-xl border p-4 text-xs">
            <h2 className="text-muted-foreground mb-2 text-[10.5px] uppercase tracking-[0.08em]">
              Timeline
            </h2>
            <dl className="space-y-1.5 text-[11.5px]">
              {TIMELINE_FIELDS.map(({ key, label }) => {
                const v = request[key] as string | null;
                if (!v) return null;
                return (
                  <div key={String(key)} className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="tabular-nums text-right">{formatRelative(v)}</dd>
                  </div>
                );
              })}
            </dl>
          </section>

          <section className="bg-card rounded-xl border p-4 text-xs">
            <h2 className="text-muted-foreground mb-2 text-[10.5px] uppercase tracking-[0.08em]">
              Details
            </h2>
            <dl className="space-y-1.5 text-[11.5px]">
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Requester</dt>
                <dd className="text-right">{requesterDisplay}</dd>
              </div>
              {request.requester_email && (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Email</dt>
                  <dd className="truncate text-right">{request.requester_email}</dd>
                </div>
              )}
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Source</dt>
                <dd className="text-right capitalize">
                  {request.source === 'public_link' ? 'Public link' : 'Internal'}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Warehouse</dt>
                <dd className="text-right">{warehouseName ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Updated</dt>
                <dd className="tabular-nums text-right">
                  {formatRelative(request.updated_at)}
                </dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>
    </div>
  );
}
