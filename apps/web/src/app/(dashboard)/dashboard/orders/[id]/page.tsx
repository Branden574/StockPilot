import Link from 'next/link';
import { notFound } from 'next/navigation';
import * as React from 'react';

import type { DriverOption } from '@/components/orders/assign-delivery-dialog';
import { CancelOrderButton } from '@/components/orders/cancel-order-button';
import { ManagerActionsPanel } from '@/components/orders/manager-actions-panel';
import { DeliveryLocationShare } from '@/components/orders/delivery-location-share';
import { CreateReturnDialog } from '@/components/returns/create-return-dialog';
import { OrderAttachmentsPanel } from '@/components/orders/order-attachments-panel';
import { OrderRealtimeRefresh } from '@/components/orders/order-realtime-refresh';
import { OrderTimeline } from '@/components/orders/order-timeline';
import { ShippingPanel } from '@/components/orders/shipping-panel';
import { OrderStatusBadge } from '@/components/orders/status-badge';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { can, isManagerOrAbove, type Role } from '@stockpilot/core';
import { requireOrgContext } from '@/lib/auth/session';
import { getWarehouseAccess } from '@/lib/auth/warehouse';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { createClient } from '@/lib/supabase/server';
import {
  ATTACHABLE_ORDER_STATUSES,
  OrderAttachmentsService,
} from '@/server/services/order-attachments';
import {
  OrderRequestsService,
  type OrderRequestRow,
  type OrderRequestStatus,
} from '@/server/services/order-requests';
import { RMAService, type ReturnableLine } from '@/server/services/returns';
import { formatNumber, formatRelative } from '@/lib/utils';

const TIMELINE_FIELDS: Array<{
  key: keyof OrderRequestRow;
  label: string;
}> = [
  { key: 'created_at', label: 'Submitted' },
  { key: 'approved_at', label: 'Approved' },
  { key: 'pick_slip_generated_at', label: 'Pick slip generated' },
  { key: 'picking_completed_at', label: 'Picking complete' },
  { key: 'packing_slip_generated_at', label: 'Packing slip generated' },
  { key: 'staged_at', label: 'Staged' },
  { key: 'in_transit_at', label: 'In transit' },
  { key: 'signed_at', label: 'Signed' },
  { key: 'completed_at', label: 'Completed' },
  { key: 'cancelled_at', label: 'Cancelled' },
];

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requireOrgContext();
  const canApprove = can(ctx, 'orders:approve');

  // The order fetch and the attachments fetch are independent (both need only
  // the route id) — run them together instead of serially. This page re-renders
  // on every realtime router.refresh() during a delivery, so the waterfall was
  // paid over and over. notFound() stays scoped to the order fetch: a missing
  // order 404s, a failed attachments read degrades to an empty panel.
  const [detailRes, attachmentsRes] = await Promise.allSettled([
    OrderRequestsService.forCurrentUser().then((svc) => svc.get(id)),
    OrderAttachmentsService.forCurrentUser().then((attSvc) => attSvc.list(id)),
  ]);
  if (detailRes.status === 'rejected') {
    notFound();
  }
  const detail = detailRes.value;
  const attachments =
    attachmentsRes.status === 'fulfilled' ? attachmentsRes.value : [];

  const { request, lines, reservations, warehouseName, requesterDisplay } = detail;

  // Proof-of-delivery attachments. Managers+ can upload/delete once the order
  // is out for delivery / completed; everyone with order access can view.
  const canManageAttachments = isManagerOrAbove(ctx.role);
  const canAttach =
    canManageAttachments &&
    (ATTACHABLE_ORDER_STATUSES as readonly string[]).includes(request.status);
  const isOwnRequest =
    request.requester_user_id !== null && request.requester_user_id === ctx.userId;
  // Phase 4 — the assigned delivery driver may be a staff user who lacks
  // orders:approve. They still need the actions panel on the statuses
  // where their permitted actions live (mark-in-transit, collect
  // signature). The panel's internal logic already filters which
  // buttons render based on assignedDeliveryUserId === viewerUserId, so
  // an assigned-driver staff user will only see their own affordances —
  // not Approve / Deny / Generate-pack-slip. We also suppress the panel
  // entirely on pending_confirmation since nothing in the panel applies.
  const isAssignedDriver =
    request.assigned_delivery_user_id !== null &&
    request.assigned_delivery_user_id === ctx.userId;
  // Picking phase — show the panel to ANY viewer with order access so a staff
  // picker can claim an unclaimed order (claim-before-pick). The shared state
  // machine narrows the actual buttons per role/assignment (unclaimed staff →
  // claim only; the claimant → pick/complete/release; a bystander → print only;
  // manager+ → pick/complete/reassign/release).
  const isPickingStatus =
    request.status === 'pick_slip_generated' ||
    request.status === 'picking_in_progress';

  // Picking claim/lock — whether THIS viewer can actually pick THIS order:
  // they hold the pick permission (manager+ or items:update) AND have write
  // access to the order's warehouse. Feeds the shared state machine so the
  // panel never advertises a Claim/Pick/Complete/Release the backend (which
  // checks both) would reject. Only the picking phase reads it, so the extra
  // warehouse-access query is paid there only (it's cheap + request-cached).
  let viewerCanPick = true;
  if (isPickingStatus) {
    const wa = await getWarehouseAccess(ctx);
    const hasWhWrite =
      wa.hasAllAccess || wa.writableIds.includes(request.warehouse_id);
    viewerCanPick =
      (isManagerOrAbove(ctx.role) || can(ctx, 'items:update')) && hasWhWrite;
  }
  const showActionsPanel =
    request.status !== 'pending_confirmation' &&
    (canApprove ||
      isPickingStatus ||
      (isAssignedDriver &&
        ['staged_for_delivery', 'in_transit'].includes(request.status)));

  // Whether a normal (strict) approve would fall short — drives the "Approve
  // partial" offer next to "Approve". Only meaningful at pending_approval for a
  // manager, so the extra reservations read is paid there only. available =
  // on_hand − Σ(active reservations); this order holds none yet at this status.
  let isShortStock = false;
  if (request.status === 'pending_approval' && canApprove && lines.length > 0) {
    const itemIds = lines
      .map((l) => l.item?.id)
      .filter((x): x is string => Boolean(x));
    if (itemIds.length > 0) {
      const supabase = await createClient();
      const { data: resvRows } = await supabase
        .from('stock_reservations')
        .select('item_id, quantity')
        .in('item_id', itemIds)
        .is('released_at', null);
      const reservedByItem = new Map<string, number>();
      for (const r of (resvRows ?? []) as { item_id: string; quantity: number }[]) {
        reservedByItem.set(r.item_id, (reservedByItem.get(r.item_id) ?? 0) + Number(r.quantity || 0));
      }
      isShortStock = lines.some((l) => {
        const onHand = Number(l.item?.quantity_on_hand ?? 0);
        const reserved = reservedByItem.get(l.item?.id ?? '') ?? 0;
        return Number(l.quantity_requested) > Math.max(0, onHand - reserved);
      });
    }
  }

  // Live tracking: the assigned driver can stream location only while in transit.
  const showLiveTrackingShare =
    isAssignedDriver &&
    request.fulfillment_type === 'delivery' &&
    request.status === 'in_transit' &&
    (await checkModuleAccess('live_tracking')).enabled;

  // Phase 2A — packing slip generation. Manager+ only, and only while the
  // request is at a status where the service actually accepts the call.
  const totalQty = lines.reduce(
    (s, l) => s + (Number(l.quantity_requested) || 0),
    0,
  );
  // Fulfilled = units PROVIDED to the customer (shipped at hand-over); owed =
  // the still-unfulfilled remainder. Drives the backorder progress line + the
  // per-line Owed column.
  const totalFulfilled = lines.reduce(
    (s, l) => s + (Number(l.quantity_fulfilled) || 0),
    0,
  );
  const totalOwed = Math.max(0, totalQty - totalFulfilled);
  const reservedTotal = reservations.reduce(
    (s, r) => s + (Number(r.quantity) || 0),
    0,
  );

  // Phase 4 — load active org members as candidate drivers for the
  // AssignDeliveryDialog. The dialog only renders when
  // status === 'staged_for_delivery' AND the viewer can act on the
  // panel (manager+). For every other status (the common case —
  // pending_approval / approved / pick / pack / pickup / completed /
  // etc.) we skip the round-trip entirely.
  let drivers: DriverOption[] = [];
  if (canApprove && request.status === 'staged_for_delivery') {
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

  // Picking claim/lock — candidate pickers for the AssignPickerDialog (manager+
  // reassign only) plus the assigned picker's display name for the chip. Same
  // active-members list as `drivers`; only paid on orders in the picking phase.
  let pickers: DriverOption[] = [];
  let assignedPickerName: string | null = null;
  if (isPickingStatus) {
    const supabase = await createClient();
    if (canApprove) {
      // Only offer pickers who can actually pick at THIS warehouse: managers+
      // (all-warehouse access) OR members explicitly assigned to
      // request.warehouse_id. Without this filter AssignPickerDialog could
      // propose an assignee the backend's assign_picking (which checks
      // warehouse write) would then reject — an authorize-then-reject UI.
      const [membersRes, assignmentsRes] = await Promise.all([
        supabase
          .from('organization_members')
          .select('user_id, role, user:user_profiles!user_id (id, full_name, email)')
          .eq('organization_id', ctx.organizationId)
          .not('accepted_at', 'is', null),
        supabase
          .from('user_warehouse_assignments')
          .select('user_id')
          .eq('organization_id', ctx.organizationId)
          .eq('warehouse_id', request.warehouse_id),
      ]);
      const assignedUserIds = new Set(
        ((assignmentsRes.data ?? []) as { user_id: string }[]).map((a) => a.user_id),
      );
      type MemberRow = {
        user_id: string;
        role: Role;
        user:
          | { id: string; full_name: string | null; email: string }
          | { id: string; full_name: string | null; email: string }[]
          | null;
      };
      // Resolve the full member list first so the assigned-picker chip name
      // stays correct even if that picker no longer qualifies for the roster
      // (e.g. their warehouse assignment was later removed).
      const rawMembers = ((membersRes.data ?? []) as MemberRow[]).flatMap((m) => {
        const u = Array.isArray(m.user) ? m.user[0] : m.user;
        if (!u || typeof u.email !== 'string') return [];
        return [{ userId: u.id, role: m.role, fullName: u.full_name ?? null, email: u.email }];
      });
      pickers = rawMembers
        .filter((m) => isManagerOrAbove(m.role) || assignedUserIds.has(m.userId))
        .map((m) => ({ userId: m.userId, fullName: m.fullName, email: m.email }))
        .sort((a, b) =>
          (a.fullName ?? a.email).localeCompare(b.fullName ?? b.email),
        );
      if (request.assigned_picker_id) {
        const match = rawMembers.find((m) => m.userId === request.assigned_picker_id);
        assignedPickerName = match ? (match.fullName ?? match.email) : null;
      }
    } else if (request.assigned_picker_id) {
      // Non-manager viewer (the assigned picker or a bystander) only needs the
      // picker's name for the chip, not the full candidate roster.
      const { data: pk } = await supabase
        .from('user_profiles')
        .select('full_name, email')
        .eq('id', request.assigned_picker_id)
        .maybeSingle();
      assignedPickerName = pk
        ? (pk.full_name as string | null)?.trim() ||
          (pk.email as string | null) ||
          null
        : null;
    }
  }

  // Carrier shipping (EasyPost). The Buy-label affordance only makes sense for
  // a delivery order that has reached staging, when the viewer can manage
  // shipping (owner/admin with the `shipping` module on). We only pay for the
  // module_enabled RPC + permission check on delivery orders at/after staging;
  // every other order skips the round-trip. The panel still renders a read-only
  // tracking section (via its own GET) whenever a shipment already exists, even
  // for non-managers — it self-hides when the GET returns nothing.
  const SHIPPABLE_STATUSES: OrderRequestStatus[] = [
    'staged_for_delivery',
    'in_transit',
    'completed',
  ];
  let canBuyLabel = false;
  let showShippingPanel = false;
  if (
    request.fulfillment_type === 'delivery' &&
    request.delivery_charter_id &&
    SHIPPABLE_STATUSES.includes(request.status)
  ) {
    showShippingPanel = true;
    if (can(ctx, 'shipping:manage')) {
      const shippingAccess = await checkModuleAccess('shipping');
      canBuyLabel = shippingAccess.enabled;
    }
  }

  // Returns (RMA). The "Create return" affordance only makes sense on a
  // returnable order (completed / legacy delivered) when the viewer can manage
  // returns AND the off-by-default `returns` module is on. We only pay for the
  // module-enabled RPC + the returnable-lines read on those orders; everything
  // else skips the round-trip. The dialog is hidden when no lines remain
  // returnable (already fully returned).
  // 'completed' is the live terminal status; 'delivered' is a legacy value
  // some older rows still carry (compared as a raw string since it's no longer
  // in the OrderRequestStatus union). The service is authoritative either way.
  const orderIsReturnable =
    request.status === 'completed' || (request.status as string) === 'delivered';
  let returnableLines: ReturnableLine[] = [];
  if (can(ctx, 'returns:manage') && orderIsReturnable) {
    const returnsAccess = await checkModuleAccess('returns');
    if (returnsAccess.enabled) {
      try {
        const rmaSvc = await RMAService.forCurrentUser();
        returnableLines = await rmaSvc.returnableLinesForOrder(id);
      } catch {
        returnableLines = [];
      }
    }
  }
  const canCreateReturn = returnableLines.length > 0;

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <OrderRealtimeRefresh orderId={id} />
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
            {canCreateReturn && <CreateReturnDialog orderId={id} lines={returnableLines} />}
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
            {totalOwed > 0 && (
              <div className="border-b border-border bg-amber-50 px-4 py-2.5 text-xs dark:bg-amber-950/30">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-amber-800 dark:text-amber-300">
                    {request.status === 'backordered'
                      ? 'Backordered — awaiting stock'
                      : 'Partially fulfilled'}
                  </span>
                  <span className="tabular-nums text-amber-800 dark:text-amber-300">
                    {formatNumber(totalFulfilled)} of {formatNumber(totalQty)} provided ·{' '}
                    {formatNumber(totalOwed)} owed
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-amber-200 dark:bg-amber-900">
                  <div
                    className="h-full rounded-full bg-amber-500"
                    style={{
                      width: `${totalQty > 0 ? Math.round((totalFulfilled / totalQty) * 100) : 0}%`,
                    }}
                  />
                </div>
              </div>
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Requested</TableHead>
                  <TableHead className="text-right">Fulfilled</TableHead>
                  <TableHead className="text-right">Owed</TableHead>
                  <TableHead className="text-right">On hand</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-muted-foreground py-6 text-center text-sm">
                      No lines on this request.
                    </TableCell>
                  </TableRow>
                )}
                {lines.map((l) => {
                  const owed = Math.max(
                    0,
                    (Number(l.quantity_requested) || 0) - (Number(l.quantity_fulfilled) || 0),
                  );
                  return (
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
                      <TableCell
                        className={`text-right tabular-nums ${owed > 0 ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}
                      >
                        {formatNumber(owed)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {l.item ? formatNumber(l.item.quantity_on_hand) : '—'}
                      </TableCell>
                    </TableRow>
                  );
                })}
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

          {showActionsPanel && (
            // canApprove drives the manage-only sections inside the
            // panel (Approve/Deny, AssignDelivery, Internal notes).
            // A staff driver who only sees the panel for in-transit
            // actions still gets MarkInTransit + CollectSignature but
            // none of the manager-only controls.
            <ManagerActionsPanel
              canApprove={canApprove}
              isShortStock={isShortStock}
              orderId={id}
              status={request.status}
              internalNotes={request.internal_notes}
              fulfillmentType={request.fulfillment_type}
              assignedDeliveryUserId={request.assigned_delivery_user_id}
              signatureToken={request.signature_token}
              hasSignature={Boolean(request.signature_data_url)}
              signedByName={request.signed_by_name}
              signedAt={request.signed_at}
              drivers={drivers}
              viewerRole={ctx.role}
              viewerUserId={ctx.userId}
              assignedPickerId={request.assigned_picker_id}
              assignedPickerName={assignedPickerName}
              pickers={pickers}
              viewerCanPick={viewerCanPick}
            />
          )}

          {showLiveTrackingShare && <DeliveryLocationShare orderId={id} />}

          {showShippingPanel && (
            <ShippingPanel
              orderId={id}
              canBuyLabel={canBuyLabel}
              charterSettingsHref="/dashboard/admin/charters"
            />
          )}

          {(canAttach || attachments.length > 0) && (
            <OrderAttachmentsPanel
              orderId={id}
              organizationId={ctx.organizationId}
              attachments={attachments}
              canManage={canManageAttachments}
              canAttach={canAttach}
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

          <section className="bg-card rounded-xl border p-4">
            <h2 className="font-display mb-3 text-base font-medium">Timeline</h2>
            {/* Async RSC (audit_logs + user_profiles) — Suspense lets the rest
                of the order page flush immediately and the timeline stream in,
                instead of its queries blocking every render (including each
                realtime router.refresh() during a delivery). */}
            <React.Suspense
              fallback={
                <div className="space-y-2" aria-hidden>
                  <div className="bg-muted h-4 w-2/3 animate-pulse rounded" />
                  <div className="bg-muted h-4 w-1/2 animate-pulse rounded" />
                  <div className="bg-muted h-4 w-3/5 animate-pulse rounded" />
                </div>
              }
            >
              <OrderTimeline orderId={request.id} organizationId={ctx.organizationId} />
            </React.Suspense>
          </section>
        </div>

        <aside className="space-y-4">
          <section className="bg-card rounded-xl border p-4 text-xs">
            <h2 className="text-muted-foreground mb-2 text-[10.5px] uppercase tracking-[0.08em]">
              Dates
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
              {request.signed_by_name && (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Signed by</dt>
                  <dd className="text-right">
                    {request.signed_by_name}
                    {/* Only call out "on behalf of" when the actual
                        signer is a DIFFERENT person from the requester.
                        Trim + lowercase comparison so trailing-space or
                        casing differences don't render a confusing
                        "John on behalf of John" row. */}
                    {request.requester_name &&
                    request.signed_by_name.trim().toLowerCase() !==
                      request.requester_name.trim().toLowerCase() ? (
                      <span className="text-muted-foreground block text-[10.5px]">
                        on behalf of {request.requester_name}
                      </span>
                    ) : null}
                  </dd>
                </div>
              )}
              {request.signed_by_email &&
                request.signed_by_email !== request.requester_email && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Signer email</dt>
                    <dd className="truncate text-right">{request.signed_by_email}</dd>
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
