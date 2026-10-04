import { Landmark, Printer } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import * as React from 'react';

import { AddItemsDialog } from '@/components/orders/add-items-dialog';
import type { DriverOption } from '@/components/orders/assign-delivery-dialog';
import { CancelOrderButton } from '@/components/orders/cancel-order-button';
import { DraftShortfallPoDialog } from '@/components/orders/draft-shortfall-po-dialog';
import { orderLineAnchorId } from '@/components/orders/focus-order-line';
import { ManagerActionsPanel } from '@/components/orders/manager-actions-panel';
import { OrderLineActions, ShortLineFixes } from '@/components/orders/order-line-actions';
import { DeliveryLocationShare } from '@/components/orders/delivery-location-share';
import { ReportProblemButton } from '@/components/maintenance/report-problem-button';
import { CreateReturnDialog } from '@/components/returns/create-return-dialog';
import { ReturnStatusBadge, returnReasonLabel } from '@/components/returns/return-status-badge';
import { OrderAttachmentsPanel } from '@/components/orders/order-attachments-panel';
import { OrderRealtimeRefresh } from '@/components/orders/order-realtime-refresh';
import { OrderTimeline } from '@/components/orders/order-timeline';
import { ReadinessLineCell } from '@/components/orders/readiness-line-cell';
import { ReadinessStrip } from '@/components/orders/readiness-strip';
import { NeededByChangeButton, ReviseNeededByDialog } from '@/components/orders/revise-needed-by-dialog';
import { bookReportReturnPath } from '@/components/reports/book-order-totals/return-path';
import {
  readinessLinePutAwayHref,
  readinessStripPutAway,
  readinessStripShortfallPo,
  readinessStripView,
} from '@/components/orders/readiness-view';
import {
  SendDeliveryRequestButton,
  type DeliveryRequestLine,
} from '@/components/orders/send-delivery-request-button';
import type { StorefrontCharter } from '@/components/orders/v2/types';
import { ShippingPanel } from '@/components/orders/shipping-panel';
import { OrderStatusBadge } from '@/components/orders/status-badge';
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
import {
  approveShortNotice,
  assessPickedLine,
  BOOK_REPORT_BACK_TO_REPORT,
  can,
  canDraftShortfallPo,
  deliveryRecipientsForRouting,
  describeCompletionConfirm,
  describeLineReturnRefs,
  describeReturnLine,
  describeUnpickedShortfall,
  formatOrderNumber,
  formatOrderReturnSummary,
  isManagerOrAbove,
  isNeededByRevisable,
  isPickingSettled,
  lineOwedUnits,
  ORDER_LINE_HIDDEN_ITEM_NAME,
  ORDER_RETURN_SUMMARY_NOTE,
  orderLineItemName,
  orderReadinessPhase,
  orderReturnSummary,
  orderStockGates,
  previewPartialFulfilment,
  projectCompletePicking,
  putAwayTargets,
  readinessAudience,
  readinessStockFlags,
  reconcileReadiness,
  resolveOrgTimezone,
  returnedFragment,
  returnHandle,
  returnRefsByLine,
  shortfallPoView,
  shortLineActions,
  shouldOfferHoldStock,
  UNPICKED_SHORTFALL_TITLE,
  type DepartureLine,
  type OrderReadinessResult,
  type OrderReturnView,
  type OrderStockCheck,
  type OrgEmailRoutingReadState,
  type PartialPreview,
  type Role,
  type ShortLineActions,
} from '@stockpilot/core';
import { requireOrgContext } from '@/lib/auth/session';
import { isNextControlFlowError, reportError } from '@/lib/error-reporter';
import { isModuleEnabled, ServiceError, withContext } from '@/server/services/context';
import { canStartCount } from '@/server/services/lib/count-start-preflight';
import { getWarehouseAccess, roleSeesEveryWarehouse } from '@/lib/auth/warehouse';
import { getCachedOrgTimezone, getOrgEmailRouting } from '@/lib/dashboard/cached-org';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import {
  handOverAllowed,
  handOverLinkWanted,
  handOverMfaBlock,
  handOverMfaPanelMessage,
  hasCapturedSignature,
  resolveReturnToken,
  signatureLinkToken,
} from '@/server/lib/order-secrets';
import {
  ATTACHABLE_ORDER_STATUSES,
  OrderAttachmentsService,
} from '@/server/services/order-attachments';
import { OrderReadinessService } from '@/server/services/order-readiness';
import {
  OrderRequestsService,
  type OrderRequestRow,
  type OrderRequestStatus,
} from '@/server/services/order-requests';
import {
  loadOrderReturns,
  RMAService,
  type ReturnableLine,
  type ReturnStatus,
} from '@/server/services/returns';
import { formatNeededBy } from '@/lib/orders/needed-by-format';
import { neededByChangeView } from '@/lib/orders/needed-by-change';
import type { ShortfallPoOffer } from '@/lib/orders/shortfall-po';
import { cn, formatNumber, formatRelative } from '@/lib/utils';
import { PageTour } from '@/components/onboarding/page-tour';
import { ORDER_DETAIL_TOUR } from '@/lib/onboarding/tours';
import { HelpTip } from '@/components/onboarding/help-tip';

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
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /** `return`: the Book Order Totals view this order was opened from (plan
   *  D17). Accepted only through bookReportReturnPath. */
  searchParams?: Promise<{ return?: string | string[] }>;
}) {
  // The service context starts now, beside the request context, not after
  // it: the order and attachment reads below go through withContext, which
  // asks GoTrue for the MFA factors while the context RPC runs. Started only
  // after requireOrgContext had answered, that request waited for the RPC's
  // round trip, one Supabase level more on every open of an order. Both are
  // request-cached; observed here in case the order read fails first.
  const contextStarted = withContext();
  contextStarted.catch(() => {});
  const [{ id }, ctx] = await Promise.all([params, requireOrgContext()]);
  const canApprove = can(ctx, 'orders:approve');

  // ORDER READINESS (F2-1) starts HERE, beside the order read, not after it.
  // It needs only the order id. Whether the page shows it (the order's phase,
  // the viewer's audience, whether the order has lines: `readinessGate`
  // below) is known only once the order is read, so it runs alongside that
  // read and an answer the page does not show is dropped unread. Started
  // after the order read, it was a Supabase round trip of its own on the
  // page's longest chain wherever nothing else was read after the order
  // (approved and the picking statuses): the local walk (2026-09-28,
  // production build) measured +11 ms to the lines table on an approved
  // order and +18 ms on a pending one.
  //
  // What starting it early costs: one read on an order the page then shows no
  // readiness for. It never waits on anything and nothing waits on it, and
  // for an order past picking or closed the function reads only the order
  // and its lines (0377, gate 5). It answers any member of the order's org,
  // who could call it directly, so a dropped answer discloses nothing.
  //
  // `result` never rejects (a failed read is `{ state: 'failed' }`, reported
  // by the service); the service itself can fail to start (its context), and
  // that is observed here so a dropped read never becomes an unhandled
  // rejection. Where the page uses the answer, below, it is awaited again and
  // handled there.
  const readinessRead = OrderReadinessService.forCurrentUser().then((svc) => svc.result(id));
  readinessRead.catch(() => {});

  // CHANGE THE NEEDED-BY (F2-4) is offered to an approver with write access
  // to the order's warehouse, the gate the save asserts. For a manager or
  // above the role decides (roleSeesEveryWarehouse) and nothing is read. For
  // anyone else who approves (staff with an orders:approve grant) their
  // warehouse access is read HERE, beside the order read, for the same reason
  // readiness is: started after it, it would be a level of its own on the
  // page's longest chain. It is the request-cached read the picking statuses
  // already pay (getWarehouseAccess is React.cache'd), so a picking order
  // reads it once. Observed at once: an order the viewer cannot see drops it.
  const approverWarehouseAccess =
    canApprove && !roleSeesEveryWarehouse(ctx.role) ? getWarehouseAccess(ctx) : null;
  approverWarehouseAccess?.catch(() => {});

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
    // Only a MISSING order is "not found". A failed read (a gateway stall, a
    // timeout) used to become the 404 page too, telling the person the order
    // did not exist; it now reaches the error boundary, which offers a retry.
    // Anything else (including a redirect thrown by the auth context, which
    // this branch used to swallow as a 404) propagates as itself.
    const reason: unknown = detailRes.reason;
    if (!(reason instanceof ServiceError && reason.code === 'not_found')) throw reason;
    notFound();
  }
  const detail = detailRes.value;
  const attachments =
    attachmentsRes.status === 'fulfilled' ? attachmentsRes.value : [];

  const { request, lines, reservations, warehouseName, requesterDisplay } = detail;

  // ---- Sync gates (no I/O). Every boolean the Tier-2 batch below needs to
  // decide WHICH round trips to fire is derived here, purely from ctx +
  // request/lines — none of it depends on anything async, so computing it
  // up front costs nothing and lets every independent read be dispatched in
  // one Promise.all instead of one-at-a-time. ----

  // Proof-of-delivery attachments. Managers+ can upload/delete once the order
  // is out for delivery / completed; everyone with order access can view.
  const canManageAttachments = isManagerOrAbove(ctx.role);
  const canAttach =
    canManageAttachments &&
    (ATTACHABLE_ORDER_STATUSES as readonly string[]).includes(request.status);
  const isOwnRequest =
    request.requester_user_id !== null && request.requester_user_id === ctx.userId;
  // Add-items entry point. Mirrors OrderRequestsService.addLines one-for-one:
  // requester-or-approver, and only before the order ships or dies. Gating here
  // rather than letting the server 409 means nobody opens the picker, stages
  // five items and only then learns the order already left the building.
  // Not mirrored: the service's assertWarehouseAccess(warehouse_id,'read').
  // order_requests are readable org-wide, so a warehouse-scoped member can open
  // an order for a warehouse they aren't assigned to and would still see the
  // button; paying getWarehouseAccess on EVERY render (today it is paid only on
  // picking statuses) to pre-empt that rare case isn't worth it — the action
  // returns a clean forbidden with the dialog left open.
  const ADD_LINES_BLOCKED: OrderRequestStatus[] = [
    'in_transit',
    'completed',
    'denied',
    'cancelled',
  ];
  const canAddLines =
    (canApprove || isOwnRequest) && !ADD_LINES_BLOCKED.includes(request.status);
  // Correcting a line is the same act as adding one — addLines,
  // updateLineQuantity and removeLine all run the SAME
  // loadEditableOrderHeader gate (ship gate + requester-or-approver +
  // warehouse access), so the row controls appear exactly when the Add items
  // button does. Re-deriving a second condition here is how add and edit
  // would drift apart, which is the bug the owner already hit once.
  const canEditLines = canAddLines;
  // No per-item reservation lookup here any more. The row controls used to be
  // handed a hasActiveReservation flag derived from `reservations`, mirroring
  // removeLine's old R4 refusal — but approval mints a hold for every line, so
  // that flag was true for every row of every approved order and hid Remove
  // exactly when people need it. removeLine now re-syncs the hold instead of
  // refusing, so nothing on a row depends on reservations. `reservations` is
  // still read below for the Active reservations panel and its total.
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
  const showActionsPanel =
    request.status !== 'pending_confirmation' &&
    (canApprove ||
      isPickingStatus ||
      (isAssignedDriver &&
        ['staged_for_delivery', 'in_transit'].includes(request.status)));

  // ORDER READINESS (F2-1): per-line readiness and a roll-up while the order
  // is still to be picked (core orderReadinessPhase 'to_pick': pending,
  // approved, the picking statuses, backordered). Who sees it is core
  // readinessAudience: the full panel for anyone who approves orders, picks
  // (items:update) or buys (purchase_orders:manage); one sentence for the
  // requester; nothing for anyone else (the read started beside the order
  // read is dropped unread). It also feeds the two stock-dependent actions
  // (Approve partial, Resume): an approver always gets the full panel, so the
  // read that used to be the page's own on-hand-minus-reservations check is
  // this one.
  const viewerReadinessAudience = readinessAudience({
    canApproveOrders: canApprove,
    canUpdateItems: can(ctx, 'items:update'),
    canManagePurchaseOrders: can(ctx, 'purchase_orders:manage'),
    isOwnRequest,
  });
  const readinessGate =
    orderReadinessPhase(request.status) === 'to_pick' &&
    viewerReadinessAudience !== 'none' &&
    lines.length > 0;

  // Live tracking: the assigned driver can stream location only while in transit.
  const liveTrackingGate =
    isAssignedDriver &&
    request.fulfillment_type === 'delivery' &&
    request.status === 'in_transit';

  // Phase 4 — candidate drivers for the AssignDeliveryDialog only need
  // loading when the dialog can actually render: a canApprove viewer on a
  // staged_for_delivery order. Every other status skips the round-trip.
  const driversGate = canApprove && request.status === 'staged_for_delivery';

  // Carrier shipping (EasyPost). showShippingPanel needs no round trip — the
  // panel renders (and self-hides via its own GET when no shipment exists)
  // for anyone on a shippable delivery order. Only canBuyLabel needs the
  // module-enabled check, and only for a manager who could act on it.
  const SHIPPABLE_STATUSES: OrderRequestStatus[] = [
    'staged_for_delivery',
    'in_transit',
    'completed',
  ];
  const showShippingPanel =
    request.fulfillment_type === 'delivery' &&
    Boolean(request.delivery_charter_id) &&
    SHIPPABLE_STATUSES.includes(request.status);
  const shippingModuleGate = showShippingPanel && can(ctx, 'shipping:manage');

  // Returns (RMA). 'completed' is the live terminal status; 'delivered' is a
  // legacy value some older rows still carry (compared as a raw string since
  // it's no longer in the OrderRequestStatus union). The off-by-default
  // `returns` module is only checked for a viewer who could act on it either
  // way — staff with returns:manage (the CreateReturnDialog) or the requester
  // themselves (the self-service return-portal link) — or who could OPEN a
  // return (returns:read): the returns panel below links each RMA to its
  // detail page, and that page redirects unless the module is on and the
  // viewer holds read or manage, so the link renders only when both are
  // known true. Cancel refuses completed orders (0155), so a return can only
  // ever exist against a returnable order — `orderIsReturnable` is therefore
  // also the gate for READING the order's returns at all.
  const orderIsReturnable =
    request.status === 'completed' || (request.status as string) === 'delivered';
  const canReadReturns = can(ctx, 'returns:read') || can(ctx, 'returns:manage');
  const returnsModuleGate = orderIsReturnable && (canReadReturns || isOwnRequest);

  // "Report a problem" launch point (Task 17, master brief §8) — always
  // available regardless of order status; the module RPC is only paid for a
  // viewer who actually holds the submit permission.
  const maintenanceGate = can(ctx, 'maintenance_requests:submit');

  // Delivery-request assistant re-entry (owner ask 2026-08-12). The
  // assistant (PR #51) had exactly one entry point: the post-placement
  // success dialog's "Email delivery request". Dismiss that dialog and there
  // was no way back — this is the way back. Gating mirrors the dialog's:
  //   * Same principal — the success screen renders only for whoever just
  //     SUBMITTED the order, so the re-entry belongs to the requester
  //     (isOwnRequest), not to canApprove. The detail page itself is
  //     readable org-wide; the button is not.
  //   * Delivery orders only — the draft is a DELIVERY request to the DC.
  //     (The success dialog technically renders for pickups too, but its
  //     builder drops the destination for them; on this page a pickup order
  //     has no delivery to request, so it gets no button.)
  //   * Not on terminal statuses — a completed / denied / cancelled order
  //     has nothing left to deliver.
  const DELIVERY_REQUEST_BLOCKED: OrderRequestStatus[] = [
    'completed',
    'denied',
    'cancelled',
  ];
  const showDeliveryRequest =
    isOwnRequest &&
    request.fulfillment_type === 'delivery' &&
    !DELIVERY_REQUEST_BLOCKED.includes(request.status);

  // Whether this page prints a time in the ORG's zone: the Dates card's
  // needed-by, and the approval panel's needed-by chip or its AI-suggested
  // deadline (pending, for an approver, from the requester's note).
  const neededBy = (request as { needed_by?: string | null }).needed_by ?? null;
  // F2-4: whether "Change" beside the needed-by may be offered (an approver,
  // an open order). Write access and the org's zone are decided after the
  // batch below, from reads already in flight.
  const neededByChangeGate = canApprove && isNeededByRevisable(request.status);
  const printsOrgTime =
    Boolean(neededBy) ||
    (showActionsPanel &&
      canApprove &&
      request.status === 'pending_approval' &&
      Boolean(request.notes?.trim()));

  // ---- Tier 2: every independent round trip the render might need, fired
  // together instead of one-at-a-time. Each slot is gated by a sync boolean
  // above and resolves to a cheap placeholder when its gate is false, so a
  // status that needs none of this pays nothing extra — no gate here was
  // loosened into an unconditional ("speculative") fetch; every one of them
  // fires exactly when the original sequential code would have fired it.
  // None of these promises reads another's result — the one read that
  // genuinely depends on a result from this batch (returnable lines, gated on
  // returnsModuleEnabled) stays a separate awaited step below, after this
  // batch resolves. Same authorization decisions in the same relative order;
  // only the wall-clock dispatch changed from sequential to concurrent. ----
  const [
    warehouseAccess,
    readiness,
    liveTrackingAccess,
    drivers,
    pickerResult,
    shippingAccess,
    returnsAccess,
    maintenanceAccess,
    deliveryRequestCharter,
    deliveryRequestTimezone,
    deliveryRequestRouting,
    orderReturns,
    zoneFacts,
    neededByWarehouseAccess,
  ] = await Promise.all([
    // Picking claim/lock — whether THIS viewer can actually pick THIS order.
    // Only the picking phase reads it, so the extra warehouse-access query is
    // paid there only (it's cheap + request-cached via React.cache()).
    isPickingStatus ? getWarehouseAccess(ctx) : Promise.resolve(null),

    // Order readiness: one read of the order's facts (order_readiness_facts,
    // SECURITY DEFINER, gated in its body, answering for THIS reader), judged
    // by core exactly as the phone judges it. Already in flight since the
    // order read (readinessRead, above): awaited here only when the page
    // shows it, and never a level of its own. A failure is a result
    // ('failed'), rendered in the strip as "Couldn't check readiness" and
    // turned into disabled actions with the reason: never a page-level throw,
    // and never "nothing reserved".
    readinessGate
      ? readinessRead.catch((e: unknown): OrderReadinessResult => {
          if (isNextControlFlowError(e)) throw e;
          void reportError(e, {
            tag: 'orders.readiness_failed',
            level: 'warning',
            organizationId: ctx.organizationId,
          });
          return { state: 'failed', message: 'Could not check readiness.' };
        })
      : Promise.resolve<OrderReadinessResult | null>(null),

    liveTrackingGate ? checkModuleAccess('live_tracking') : Promise.resolve(null),

    // Phase 4 — active org members as candidate drivers for the
    // AssignDeliveryDialog.
    driversGate
      ? (async () => {
          const supabase = await createClient();
          const { data: members } = await supabase
            .from('organization_members')
            .select('user_id, is_delivery_driver, user:user_profiles!user_id (id, full_name, email)')
            .eq('organization_id', ctx.organizationId)
            .not('accepted_at', 'is', null);
          type MemberRow = {
            user_id: string;
            is_delivery_driver: boolean | null;
            user:
              | { id: string; full_name: string | null; email: string }
              | { id: string; full_name: string | null; email: string }[]
              | null;
          };
          const allStaff = ((members ?? []) as MemberRow[]).flatMap((m) => {
            const u = Array.isArray(m.user) ? m.user[0] : m.user;
            if (!u || typeof u.email !== 'string') return [];
            return [
              {
                userId: u.id,
                fullName: u.full_name ?? null,
                email: u.email,
                isDriver: Boolean(m.is_delivery_driver),
              },
            ];
          });
          // Only members MARKED as delivery drivers (Team page toggle). Fallback to
          // all staff while an org has nobody marked yet, so the dialog never
          // renders an empty picker on day one.
          const marked = allStaff.filter((m) => m.isDriver);
          return (marked.length > 0 ? marked : allStaff)
            .map(({ userId, fullName, email }) => ({ userId, fullName, email }))
            .sort((a, b) => (a.fullName ?? a.email).localeCompare(b.fullName ?? b.email));
        })()
      : Promise.resolve<DriverOption[]>([]),

    // Picking claim/lock — candidate pickers for the AssignPickerDialog
    // (manager+ reassign only) plus the assigned picker's display name for
    // the chip. Same active-members list as `drivers`; only paid on orders in
    // the picking phase.
    isPickingStatus
      ? (async () => {
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
            const pickers = rawMembers
              .filter((m) => isManagerOrAbove(m.role) || assignedUserIds.has(m.userId))
              .map((m) => ({ userId: m.userId, fullName: m.fullName, email: m.email }))
              .sort((a, b) =>
                (a.fullName ?? a.email).localeCompare(b.fullName ?? b.email),
              );
            let assignedPickerName: string | null = null;
            if (request.assigned_picker_id) {
              const match = rawMembers.find((m) => m.userId === request.assigned_picker_id);
              assignedPickerName = match ? (match.fullName ?? match.email) : null;
            }
            return { pickers, assignedPickerName };
          }
          if (request.assigned_picker_id) {
            // Non-manager viewer (the assigned picker or a bystander) only needs the
            // picker's name for the chip, not the full candidate roster.
            const { data: pk } = await supabase
              .from('user_profiles')
              .select('full_name, email')
              .eq('id', request.assigned_picker_id)
              .maybeSingle();
            const assignedPickerName = pk
              ? (pk.full_name as string | null)?.trim() ||
                (pk.email as string | null) ||
                null
              : null;
            return { pickers: [] as DriverOption[], assignedPickerName };
          }
          return { pickers: [] as DriverOption[], assignedPickerName: null as string | null };
        })()
      : Promise.resolve({ pickers: [] as DriverOption[], assignedPickerName: null as string | null }),

    shippingModuleGate ? checkModuleAccess('shipping') : Promise.resolve(null),

    returnsModuleGate ? checkModuleAccess('returns') : Promise.resolve(null),

    maintenanceGate ? checkModuleAccess('maintenance_requests') : Promise.resolve(null),

    // Delivery-request re-entry: the destination site for the draft body.
    // Same source of truth the storefront's charter loader reads (charters
    // id/name/code + jsonb address), fetched only when the button will
    // actually render for an order that HAS a charter. A missing/failed row
    // degrades to null — the assistant already tolerates the 5 legacy
    // delivery rows with no charter.
    showDeliveryRequest && request.delivery_charter_id
      ? (async (): Promise<StorefrontCharter | null> => {
          const supabase = await createClient();
          const { data } = await supabase
            .from('charters')
            .select('id, name, code, address')
            .eq('id', request.delivery_charter_id as string)
            .maybeSingle();
          const c = data as
            | { id: string; name: string; code: string | null; address: unknown }
            | null;
          if (!c || typeof c.id !== 'string') return null;
          const raw = c.address;
          // jsonb: null, an object, or (defensively) a scalar — anything
          // that is not a plain object is "no address", mirroring the
          // storefront charter loader's mapping.
          const address =
            raw !== null && typeof raw === 'object' && !Array.isArray(raw)
              ? (raw as StorefrontCharter['address'])
              : null;
          return { id: c.id, name: c.name, code: c.code ?? null, address };
        })()
      : Promise.resolve<StorefrontCharter | null>(null),

    // The org timezone the draft's needed-by line is printed in — the same
    // getCachedOrgTimezone call the storefront page makes for the dialog.
    // Readiness does not need it: its facts carry the org's zone (0377
    // order.timeZone), read in the same statement as the rest.
    showDeliveryRequest
      ? getCachedOrgTimezone(ctx.organizationId)
      : Promise.resolve<string | null>(null),

    // Per-org delivery-request email routing (migration 0337). The compose
    // button renders only when this resolves to a routable pair — unset or
    // invalid routing HIDES it (fail closed; never the compiled L4L
    // constants, which only the pre-migration 'fallback' state may supply).
    showDeliveryRequest
      ? getOrgEmailRouting(ctx.organizationId, 'delivery_request')
      : Promise.resolve<OrgEmailRoutingReadState | null>(null),

    // The order's RETURNS — the reverse of the returns page's "Against order
    // SO-…" link (owner report, SO-000085: a delivered order with a closed
    // RMA read as a clean 1/1/1 with nothing about the return). One RLS-scoped
    // read of `returns` + embedded `return_lines`, fired only on a returnable
    // order (nothing else can carry one) and for EVERY viewer — a return that
    // happened is part of the order's history, and RLS (is_org_member) is
    // the authority on who reads it, not the returns module switch or the
    // returns:read permission (those only decide whether the RMA number is a
    // LINK). Ungated helper on purpose: RMAService.gateRead would hide the
    // history whenever the module is off. Degrades to [] on any error so a
    // returns hiccup never takes the order page down.
    orderIsReturnable
      ? (async (): Promise<OrderReturnView[]> => {
          try {
            const supabase = await createClient();
            return await loadOrderReturns(supabase, ctx.organizationId, id);
          } catch {
            return [];
          }
        })()
      : Promise.resolve<OrderReturnView[]>([]),

    // The org's zone for a page that prints a needed-by but shows no
    // readiness: the readiness read already in flight since the order read
    // carries it (0377 order.timeZone, organizations.timezone) for any member
    // of the order's org, in every phase, so no organizations read is added.
    // Only the zone is used: the answer discloses nothing the member could
    // not read directly. Formatting only, so a failure is silent here and
    // degrades to the documented default zone below. F2-4's Change needs the
    // zone too (an approver on an open order past picking, or with no lines,
    // where no strip is shown): the same read, never a guessed zone (a failed
    // read offers no Change, below).
    !readinessGate && (printsOrgTime || neededByChangeGate)
      ? readinessRead.catch((): OrderReadinessResult | null => null)
      : Promise.resolve<OrderReadinessResult | null>(null),

    // F2-4: the warehouse access of an approver whose role does not decide it,
    // started beside the order read (above); joined here, never awaited on
    // its own. A failed read is no access (no Change), never a guess.
    neededByChangeGate && approverWarehouseAccess
      ? approverWarehouseAccess.catch(() => null)
      : Promise.resolve(null),
  ]);

  let viewerCanPick = true;
  if (isPickingStatus) {
    // Fail CLOSED if the batched access read is ever absent for a picking
    // order: a pick-authorization hint must not default to permissive just
    // because slot 1's gate drifted from this consumer (review finding).
    // Today warehouseAccess is always non-null when isPickingStatus, so this
    // is behavior-identical; the backend re-checks on assign regardless.
    const hasWhWrite = warehouseAccess
      ? warehouseAccess.hasAllAccess || warehouseAccess.writableIds.includes(request.warehouse_id)
      : false;
    viewerCanPick =
      (isManagerOrAbove(ctx.role) || can(ctx, 'items:update')) && hasWhWrite;
  }
  // Fold the routing read into the delivery-request gate: the button needs a
  // routable pair, and `deliveryRecipientsForRouting` is the whole fallback
  // matrix — compiled constants ONLY for the pre-migration 'fallback' state,
  // the stored pair for 'valid', null (button hidden) for 'unset'/'invalid'.
  // The branded value is flattened to plain strings for the RSC boundary;
  // the client re-brands at its own seam.
  const deliveryRequestRecipientsValue = deliveryRequestRouting
    ? deliveryRecipientsForRouting(deliveryRequestRouting)
    : null;
  const deliveryRequestRecipientsDto = deliveryRequestRecipientsValue
    ? {
        to: deliveryRequestRecipientsValue.to,
        cc: deliveryRequestRecipientsValue.cc,
        toName: deliveryRequestRecipientsValue.toName,
        ccName: deliveryRequestRecipientsValue.ccName,
      }
    : null;

  // Readiness, as the page shows it. The stock-dependent actions come from
  // the same result (core readinessStockFlags + orderStockGates, the phone's
  // gates): a failed read, an item this viewer cannot read, or an order past
  // the line cap DISABLES Approve partial / Resume with the reason, never
  // flags defaulted to false.
  //
  // The order (Tier 1) and its facts (Tier 2) are read a moment apart. If the
  // order moved in between (another status, a line added or removed), the
  // facts describe a different order than the header and table above:
  // core reconcileReadiness makes that `failed` ("The order changed while it
  // was being checked."), exactly as the phone does, never a strip for one
  // order above the lines of another.
  const readinessNow = readiness
    ? reconcileReadiness(readiness, { status: request.status, lineIds: lines.map((l) => l.id) })
    : null;
  // THE ORG'S ZONE for every time this page prints: readiness' times and
  // days ("Checked at", the needed-by day, a count's day), the Dates card's
  // needed-by and the approval panel's. It is the zone the readiness facts
  // carry (0377 order.timeZone, organizations.timezone), the zone core reads
  // the needed-by day in, so the strip, the signal and the card can never use
  // two zones: from the read the page shows, else from the same read in
  // flight (zoneFacts). A failed read shows no readiness time; a needed-by it
  // prints in the delivery request's zone when that was read, else in core's
  // documented default (resolveOrgTimezone), never in the server's zone.
  const factsTimeZone = (r: OrderReadinessResult | null): string | null =>
    r?.state === 'ok' ? (r.assessment.order.timeZone ?? null) : null;
  const orgTimeZone = resolveOrgTimezone(
    factsTimeZone(readinessGate ? readiness : zoneFacts) ?? deliveryRequestTimezone,
  );
  const readinessStrip = readinessNow
    ? readinessStripView(readinessNow, viewerReadinessAudience, { timeZone: orgTimeZone })
    : null;
  // ── F2-4: change the needed-by. "Change" beside the date, for an approver
  // with write access to the order's warehouse, on an open order, once the
  // org's zone is READ (the facts' organizations.timezone, the column the
  // save converts in; lib/orders/needed-by-change.ts says why a guessed zone
  // offers no Change). On the readiness strip where the full strip is shown
  // (to pick); in the Dates card otherwise (past picking, or no lines), so
  // every open order has one way to it, never two. The button sits there; the
  // dialog is mounted once at the top of the page (a refresh that moves or
  // removes the button keeps an open dialog and what was typed in it).
  const neededByChange = neededByChangeGate
    ? neededByChangeView({
        orderId: request.id,
        status: request.status,
        neededBy,
        warehouseId: request.warehouse_id,
        canApprove,
        role: ctx.role,
        roleSeesEveryWarehouse: roleSeesEveryWarehouse(ctx.role),
        access: neededByWarehouseAccess,
        zoneFacts: readinessGate ? readiness : zoneFacts,
      })
    : null;
  const neededByChangeOnStrip = neededByChange !== null && readinessStrip?.mode === 'full';
  const neededByChangeInDates = neededByChange !== null && !neededByChangeOnStrip;
  const readinessAssessment =
    readinessNow?.state === 'ok' &&
    readinessNow.assessment.phase === 'to_pick' &&
    !readinessNow.assessment.linesCapped &&
    viewerReadinessAudience === 'full'
      ? readinessNow.assessment
      : null;
  const readinessLineById = new Map(readinessAssessment?.lines.map((l) => [l.lineId, l] as const));
  const readinessItemById = new Map(readinessAssessment?.items.map((it) => [it.itemId, it] as const));
  // ── F2-3: put away from the order. From the readiness result above, no
  // read of its own. The lines with units in this warehouse's Staging (core
  // putAwayTargets: whatever the line's state, since the state is the worst
  // bucket a line touches) link to the Staging list filtered to their items,
  // from this order; "Put away N items" on the strip links to all of them.
  // The gate is stock:transfer (the permission Place asserts) and items:read
  // (the Staging page's own gate: it answers 404 without it); anyone else is
  // told once, on the strip, which one is missing. The order's own id (the
  // database's lower-case form) names it in the link.
  const putAwayLinkOpts = {
    orderId: request.id,
    access: { canTransfer: can(ctx, 'stock:transfer'), canReadItems: can(ctx, 'items:read') },
  };
  const readinessPutAway = readinessStripPutAway(putAwayTargets(readinessAssessment), putAwayLinkOpts);
  // "Count this item" on a line where on record and the locations disagree:
  // the item page's rule (a manager who can start a count; an item a count
  // can include). The service context is the one every read above already
  // used (request-cached), so this costs no round trip.
  const viewerCanStartCount = readinessAssessment
    ? await contextStarted.then(canStartCount, () => false)
    : false;
  // A line's readiness, its item's, and whether this viewer may count that
  // item from the line (start_cycle_count's predicate as far as the facts
  // carry it: not deleted, archived or a kit; items on orders are never
  // rental equipment).
  const readinessCellFor = (lineId: string) => {
    const line = readinessLineById.get(lineId) ?? null;
    const item = line ? (readinessItemById.get(line.itemId) ?? null) : null;
    const f = item?.facts ?? null;
    return {
      line,
      item,
      canCountItem: viewerCanStartCount && f !== null && !f.deleted && !f.archived && !f.isBundle,
      putAwayHref: readinessLinePutAwayHref(line, putAwayLinkOpts),
    };
  };
  // ── F2-5: draft a PO for what is short. From the readiness result above
  // (core shortfallPoView: per short item, what may be drafted and what
  // already covers it), no read of its own. Offered on the strip when
  // something may be drafted: the button to a viewer who may draft (core
  // canDraftShortfallPo, the database's floors: a manager holding
  // purchase_orders:manage, the orders and purchase_orders modules on, the
  // modules read from the service context every read above already used, so
  // no round trip), core's sentence to anyone on the full strip who is not a
  // manager holding purchase_orders:manage. The dialog is mounted once at the
  // top of the page with the page's view, so it opens at once; supplier names
  // are read only when it opens.
  const shortfallView = readinessAssessment ? shortfallPoView(readinessAssessment) : null;
  const shortfallDrafterRole = isManagerOrAbove(ctx.role) && can(ctx, 'purchase_orders:manage');
  const viewerCanDraftShortfall =
    shortfallView !== null && shortfallView.draftableCount > 0 && shortfallDrafterRole
      ? await contextStarted
          .then((svcCtx) =>
            canDraftShortfallPo({
              isManager: true,
              canManagePurchaseOrders: true,
              ordersModule: isModuleEnabled(svcCtx, 'orders'),
              purchaseOrdersModule: isModuleEnabled(svcCtx, 'purchase_orders'),
            }),
          )
          .catch(() => false)
      : false;
  const readinessShortfallPo = readinessStripShortfallPo(shortfallView, {
    orderId: request.id,
    canDraft: viewerCanDraftShortfall,
    drafterRole: shortfallDrafterRole,
  });
  const shortfallPoOffer: ShortfallPoOffer | null =
    viewerCanDraftShortfall && shortfallView
      ? { orderId: request.id, view: shortfallView, timeZone: orgTimeZone }
      : null;
  const stockCheck: OrderStockCheck = readinessNow
    ? readinessStockFlags(readinessNow)
    : { state: 'not_needed' };
  const stockGates = orderStockGates(request.status, stockCheck);
  const approveNotice = approveShortNotice(stockCheck);
  // F2-3: what "Approve partial" (pending) or "Resume fulfillment"
  // (backordered) would hold now, per item (core previewPartialFulfilment,
  // the frozen RPCs' twin), from the SAME readiness result as the strip and
  // the gates above: no read of its own. The panel's buttons open it in a
  // dialog; the confirm calls the existing action, and what was held is read
  // again after it. Approvers only (the numbers are stock numbers). A missing
  // read is `unavailable` (read_failed), never zeros.
  const partialAction =
    request.status === 'pending_approval'
      ? ('approve_partial' as const)
      : request.status === 'backordered'
        ? ('resume' as const)
        : null;
  const partialPreview: PartialPreview | null =
    canApprove && partialAction ? previewPartialFulfilment(readinessNow, partialAction) : null;

  // ── F2-2: held, and caught before it leaves. Everything below is computed
  // from what the page already read (the order, its lines, the readiness
  // result above): no read of its own and no round trip.

  // "Hold available stock" on the strip (core shouldOfferHoldStock): an
  // approver, a hold status, some line not held or partly held. For lines
  // added before holds were topped up, or by someone who may not approve.
  const holdOrderId = shouldOfferHoldStock({
    assessment: readinessAssessment,
    canApproveOrders: canApprove,
  })
    ? id
    : null;

  // The confirm before "Mark picking complete" (the SO-000100 button): core
  // projectCompletePicking over the same readiness result, worded by core
  // describeCompletionConfirm. Only for a viewer who can pick (the button is
  // theirs alone; its numbers are stock numbers). A failed or missing read is
  // a confirm too ("Stock couldn't be checked"): never skipped for want of
  // facts.
  const completionProjection =
    isPickingStatus && readinessNow?.state === 'ok'
      ? projectCompletePicking(readinessNow.assessment)
      : null;
  const completionConfirm =
    isPickingStatus && viewerCanPick
      ? describeCompletionConfirm(completionProjection, completionProjection === null)
      : null;

  // The lines as the departure confirm reads them (core describeDepartureRisk
  // in the actions panel): staging, "Mark in transit" and both signatures stop
  // for a confirm when a line is not fully picked. Lines only, so the same
  // numbers the table shows; only where picking is settled (where the confirm
  // can speak).
  const departureLines: DepartureLine[] = isPickingSettled(request.status)
    ? lines.map((l) => ({
        lineId: l.id,
        itemName: orderLineItemName(l.item),
        quantityRequested: l.quantity_requested,
        quantityFulfilled: l.quantity_fulfilled,
        quantityPicked: l.quantity_picked,
      }))
    : [];

  // One-tap fixes on a short line (core shortLineActions, decision D18): to
  // pick, a line readiness calls Short; after picking, a line not fully picked
  // (judged from the line alone, core assessPickedLine). Offered to the people
  // who may edit the lines (the row controls' gate); out for delivery the
  // lines are final and the note says what happens instead, shown to the
  // people who could have edited them before.
  const pickedPhase = isPickingSettled(request.status);
  const showShortLineFixes =
    canEditLines || (request.status === 'in_transit' && (canApprove || isOwnRequest));
  const shortFixesFor = (lineId: string, rowIndex: number): ShortLineActions | null => {
    if (!showShortLineFixes) return null;
    const isOnlyLine = lines.length === 1;
    let fixes: ShortLineActions | null = null;
    if (readinessAssessment) {
      const line = readinessLineById.get(lineId);
      fixes = line ? shortLineActions({ phase: 'to_pick', line, isOnlyLine }) : null;
    } else if (pickedPhase) {
      const l = lines.find((x) => x.id === lineId);
      fixes = l
        ? shortLineActions({
            phase: 'picked',
            status: request.status,
            line: assessPickedLine({
              lineId: l.id,
              itemId: l.item_id,
              position: rowIndex + 1,
              requested: Number(l.quantity_requested) || 0,
              fulfilled: Number(l.quantity_fulfilled) || 0,
              picked: l.quantity_picked === null ? null : Number(l.quantity_picked) || 0,
            }),
            isOnlyLine,
          })
        : null;
    }
    // A line that is not short has no fix and nothing to say.
    return fixes && (fixes.actions.length > 0 || fixes.note) ? fixes : null;
  };
  const showLiveTrackingShare = liveTrackingGate && (liveTrackingAccess?.enabled ?? false);
  const { pickers, assignedPickerName } = pickerResult;
  const canBuyLabel = shippingModuleGate && (shippingAccess?.enabled ?? false);
  const returnsModuleEnabled = returnsModuleGate && (returnsAccess?.enabled ?? false);
  const maintenanceModuleEnabled = maintenanceAccess?.enabled ?? false;
  // The RMA number links to /dashboard/returns/[id] only when that page will
  // actually open for this viewer (module on + returns:read or manage); for
  // everyone else it is plain text — the panel itself renders regardless.
  const returnsLinkable = returnsModuleEnabled && canReadReturns;
  // Per-line WHICH-RMA join and the order-level roll-up. The returned NUMBER
  // per line is `returned_quantity` (0153, bumped only at apply-time in the
  // same transaction that latches return_lines.applied); the join supplies
  // the RMA numbers for the hover/aria text. Null summary = no returned units
  // = nothing extra renders, so an order with no returns is unchanged.
  const returnRefs = returnRefsByLine(orderReturns);
  const returnSummary = orderReturnSummary(
    lines.map((l) => ({ fulfilled: l.quantity_fulfilled, returned: l.returned_quantity })),
  );
  const lineById = new Map(lines.map((l) => [l.id, l] as const));

  // Tier 3 — the returnable-lines read genuinely depends on the Tier-2
  // module check above (returnsModuleEnabled), so it can't join that batch:
  // it stays a separate awaited step. This is the one query in the whole page
  // that could have been fetched speculatively (dropping the dependency and
  // firing it alongside Tier 2, gating only the render) — decided AGAINST,
  // because the `returns` module defaults OFF, so on the common org a
  // speculative fetch here would add a round trip to every returnable order
  // to save one only on orders where returns happens to be on AND the module
  // check also passes. Kept conditional, in the smallest tier where its
  // condition (returnsModuleEnabled) is actually known.
  let returnableLines: ReturnableLine[] = [];
  if (can(ctx, 'returns:manage') && orderIsReturnable && returnsModuleEnabled) {
    try {
      const rmaSvc = await RMAService.forCurrentUser();
      returnableLines = await rmaSvc.returnableLinesForOrder(id);
    } catch {
      returnableLines = [];
    }
  }
  const canCreateReturn = returnableLines.length > 0;

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
  // SO-000061: units that are neither handed over NOR staged — nobody has
  // pulled them. Derived (no column), and only meaningful once picking is
  // finished; the shared helper owns both the arithmetic and the status set so
  // web and mobile cannot drift. Wording is a single string from core.
  const shortfallNotice = describeUnpickedShortfall(
    lines.map((l) => ({
      quantityRequested: l.quantity_requested,
      quantityFulfilled: l.quantity_fulfilled,
      quantityPicked: l.quantity_picked,
    })),
    request.status,
  );
  const reservedTotal = reservations.reduce(
    (s, r) => s + (Number(r.quantity) || 0),
    0,
  );

  // Returns-access Unit A: the REQUESTER'S own self-service affordance. A
  // requester without returns:manage never sees the staff CreateReturnDialog,
  // so on their own completed order with fulfilled items we link the same
  // public return portal their return-prompt email points at
  // (/returns/request/<return_token>, minted at completion when the module is
  // on). returns:manage viewers are excluded — they get the staff dialog, so
  // there are never two return buttons.
  const totalFulfilledForReturns = lines.reduce(
    (sum, l) => sum + (Number(l.quantity_fulfilled) || 0),
    0,
  );
  const requesterReturnEligible =
    isOwnRequest &&
    !can(ctx, 'returns:manage') &&
    orderIsReturnable &&
    returnsModuleEnabled &&
    totalFulfilledForReturns > 0;

  // ORDER SECRETS (migration 0389). The raw tokens live in
  // order_request_secrets, which only the admin client reads; the order row
  // every member reads holds the signature token's sha256 (for tokens minted
  // since 0389). Read only for the viewer who gets the link:
  //   - the requester's own return link: the side table first, then the
  //     legacy column (an older token may already be in their inbox);
  //   - the panel's "Collect signature" link: only while the order can be
  //     signed (staged for pickup, in transit) and only for someone who may
  //     hand it over (orders:approve, with write access to the order's
  //     warehouse below manager rank, or the assigned driver). The raw token
  //     when its digest is the column, else a raw column minted before 0389;
  //     never a digest (the sign page would then ask for a session). Not
  //     while the viewer owes an MFA step-up (F2): the link completes the
  //     hand-over with no session, so it follows assertPermission's rule, and
  //     the panel says what to do instead. The MFA state is the service
  //     context's (every read above already used it, request-cached, so no
  //     round trip); a context that failed holds the link back too.
  const handOverMfaState = await contextStarted.then(
    (svcCtx) => ({ known: true as const, block: handOverMfaBlock(svcCtx) }),
    () => ({ known: false as const, block: null }),
  );
  const handOverMfa = handOverMfaState.block;
  // Who may hand it over is the mint's rule too (review finding 1): below
  // manager rank an approver needs write access to the order's warehouse.
  // Their access is the read started beside the order read for F2-4
  // (approverWarehouseAccess: an approver whose role does not decide it),
  // request-cached, so no round trip of its own; a failed read is no access.
  const handOverWarehouseAccess =
    approverWarehouseAccess && !isAssignedDriver ? await approverWarehouseAccess.catch(() => null) : null;
  const wantsHandOverLink = handOverLinkWanted({
    showActionsPanel,
    viewerMayHandOver: handOverAllowed(ctx, request, handOverWarehouseAccess),
    mfaBlocked: !handOverMfaState.known || handOverMfa !== null,
    status: request.status,
    signatureTokenColumn: request.signature_token,
  });
  // Without a service-role key (a misconfigured preview) the page renders
  // with no return link and no hand-over link rather than failing.
  let secretsAdmin: ReturnType<typeof createAdminClient> | null = null;
  if (requesterReturnEligible || wantsHandOverLink) {
    try {
      secretsAdmin = createAdminClient();
    } catch {
      secretsAdmin = null;
    }
  }
  const [requesterReturnToken, handOverLink] = await Promise.all([
    requesterReturnEligible && secretsAdmin
      ? resolveReturnToken(secretsAdmin, id, request.return_token)
      : Promise.resolve(null),
    wantsHandOverLink && secretsAdmin
      ? signatureLinkToken(secretsAdmin, id, request.signature_token)
      : Promise.resolve(null),
  ]);
  const requesterReturnPath = requesterReturnToken ? `/returns/request/${requesterReturnToken}` : null;

  // Item-level summary for the add-items picker: it labels a pick that would
  // TOP UP an existing line instead of creating one. Summed PER ITEM because an
  // order can legitimately carry two lines of the same item (see the grouped
  // demand calc above) and addLines tops up against the item, not the line.
  //
  // The dialog phrases this as the ITEM total for the same reason: addLines
  // builds its existingByItem Map over the line rows, so with two lines of one
  // item only the LAST row is topped up. A per-line promise would name a number
  // that appears on no line; the item total is true whichever row it picks.
  // The assistant's draft wants the same shape the storefront cart handed
  // the success dialog: requested quantity per line + name/sku for the item
  // list. Lines whose item row was deleted are dropped — the draft cannot
  // name them, and the cart flow could never have produced them.
  const deliveryRequestLines: DeliveryRequestLine[] = showDeliveryRequest
    ? lines.flatMap((l) =>
        l.item
          ? [
              {
                itemId: l.item.id,
                quantity: Number(l.quantity_requested) || 0,
                name: l.item.name,
                sku: l.item.sku,
              },
            ]
          : [],
      )
    : [];

  const existingLineSummary = canAddLines
    ? [
        ...lines
          .reduce((m, l) => {
            const itemId = l.item?.id;
            if (!itemId) return m;
            const prior = m.get(itemId);
            m.set(itemId, {
              itemId,
              name: l.item?.name ?? '',
              quantity: (prior?.quantity ?? 0) + (Number(l.quantity_requested) || 0),
            });
            return m;
          }, new Map<string, { itemId: string; name: string; quantity: number }>())
          .values(),
      ]
    : [];

  // Opened from Book Order Totals' View orders: the way back to that exact
  // view, only when `return` passes safeReturnPath AND is the report's own
  // path (anything else keeps "Back to orders").
  const backToReport = bookReportReturnPath((await searchParams)?.return);

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <OrderRealtimeRefresh orderId={id} />
      <ReviseNeededByDialog change={neededByChange} trigger={false} />
      <DraftShortfallPoDialog offer={shortfallPoOffer} />
      <div className="mb-6">
        <Link
          href={backToReport ?? '/dashboard/orders'}
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← {backToReport ? BOOK_REPORT_BACK_TO_REPORT : 'Back to orders'}
        </Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          {/* basis-72: the title column asks for 18rem before the actions may
              share its line. With flex-1 alone (a 0 basis) the actions never
              wrapped and the title got what they left: "Or..." at 390 px,
              the order's number hidden. Now they wrap under it instead. */}
          <div className="min-w-0 flex-1 basis-72" data-testid="order-title-column">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-2xl font-semibold tracking-tight">
                Order request{' '}
                {formatOrderNumber((request as { order_number?: number | null }).order_number) ? (
                  <span className="text-muted-foreground font-mono tabular-nums">
                    {formatOrderNumber((request as { order_number?: number | null }).order_number)}
                  </span>
                ) : null}
              </h1>
              <OrderStatusBadge status={request.status} />
              <PageTour tour={ORDER_DETAIL_TOUR} />
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
            {requesterReturnPath && (
              <Button asChild variant="outline">
                <a href={requesterReturnPath}>Request a return</a>
              </Button>
            )}
            {showDeliveryRequest && deliveryRequestRecipientsDto && (
              <SendDeliveryRequestButton
                recipients={deliveryRequestRecipientsDto}
                orderId={id}
                orderNumber={
                  (request as { order_number?: number | null }).order_number ?? null
                }
                warehouseName={warehouseName ?? ''}
                destination={deliveryRequestCharter}
                requestedFor={detail.requesterName ?? requesterDisplay}
                requesterEmail={detail.requesterEmail}
                neededBy={neededBy ?? ''}
                // Through the shared resolver, never a second hardcoded zone.
                // This slot is null only when showDeliveryRequest is false (so
                // this button is not rendered at all), but a literal here was
                // one of the two copies of "the default org timezone" that let
                // web and mobile state different needed-by times for one order.
                orgTimezone={resolveOrgTimezone(deliveryRequestTimezone)}
                notes={request.notes ?? ''}
                lines={deliveryRequestLines}
              />
            )}
            {(canApprove || isOwnRequest) && (
              <CancelOrderButton orderId={id} status={request.status} />
            )}
            <ReportProblemButton
              moduleEnabled={maintenanceModuleEnabled}
              canSubmit={maintenanceGate}
              prefill={{ orderRequestId: id }}
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <section className="bg-card rounded-xl border">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="text-sm font-medium">Lines ({lines.length})</h2>
              <div className="flex items-center gap-3">
                <p className="text-muted-foreground text-xs tabular-nums">
                  Total qty {formatNumber(totalQty)}
                </p>
                {/* Adding items edits the CONTENTS of this collection, so the
                    affordance sits with the collection (and the Total qty
                    readout it changes) rather than in the header row, which
                    holds whole-order lifecycle actions. */}
                {canAddLines && (
                  <AddItemsDialog
                    orderId={id}
                    status={request.status}
                    warehouseId={request.warehouse_id}
                    warehouseName={warehouseName}
                    existingLines={existingLineSummary}
                  />
                )}
              </div>
            </div>
            {/* A pick slip printed BEFORE the last line was added no longer
                matches the order. Ungated by permission on purpose: the person
                who needs this is the picker holding the paper, not whoever
                clicked Add. Derived on the detail, so it self-clears on
                reprint.

                Gated on status because pickSlipStale never clears on its own:
                it is line.created_at > pick_slip_generated_at, and only a
                reprint moves that stamp. On a shipped, completed, denied or
                cancelled order there is nothing left to pick, so the prompt
                would sit there forever telling the viewer to do something that
                is no longer possible. Same status set the add affordance uses —
                once contents are frozen, a reprint is moot. (Mobile applies the
                identical gate via isAddLinesBlockedStatus.) */}
            {/* No longer suppressed by the shortfall notice. The original
                reason was that both opened with "generate the pick slip
                again" — but that instruction has been removed from the
                shortfall copy (it is impossible at five of the six statuses it
                fires at, since generatePickSlip requires 'approved'), so the
                two no longer duplicate each other. They answer different
                questions: this one says lines were ADDED after printing, which
                is derived from created_at and is the narrow case; the shortfall
                says how many units nobody has pulled. Both can be true at once,
                and each carries information the other cannot. */}
            {detail.pickSlipStale &&
              !ADD_LINES_BLOCKED.includes(request.status) && (
                <div className="border-b border-border bg-amber-50 px-4 py-2.5 dark:bg-amber-950/30">
                  <p className="flex items-start gap-2 text-xs font-medium text-amber-800 dark:text-amber-300">
                    <Printer className="mt-px size-3.5 shrink-0" />
                    <span>
                      Items were added after the pick slip was printed. Generate the
                      pick slip again so the sheet matches this order
                      {detail.assignedPickerName
                        ? `, and give the new copy to ${detail.assignedPickerName}`
                        : ''}
                      .
                    </span>
                  </p>
                </div>
              )}
            {/* Un-picked units, shown the moment they exist rather than at
                hand-over (SO-000061). Standalone only when the partial-
                fulfilment banner below is NOT up: when it is, the same units
                are already being counted there as "owed", and the instruction
                is appended INSIDE that banner instead (see below) so the card
                never stacks two amber boxes about one number.

                Same construction and tone as the two banners around it —
                border-b, amber-50 / amber-950-30, amber-800 / amber-300 text —
                because it is the same class of message: attention needed,
                nothing broken. */}
            {shortfallNotice != null &&
              !(totalOwed > 0 && (totalFulfilled > 0 || request.status === 'backordered')) && (
                <div className="border-b border-border bg-amber-50 px-4 py-2.5 dark:bg-amber-950/30">
                  <p className="flex items-start gap-2 text-xs font-medium text-amber-800 dark:text-amber-300">
                    <Printer className="mt-px size-3.5 shrink-0" />
                    <span>
                      <span className="font-semibold">{UNPICKED_SHORTFALL_TITLE}.</span>{' '}
                      {shortfallNotice}
                      {detail.assignedPickerName
                        ? ` Give the new copy to ${detail.assignedPickerName}.`
                        : ''}
                    </span>
                  </p>
                </div>
              )}
            {totalOwed > 0 && (totalFulfilled > 0 || request.status === 'backordered') && (
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
                {/* The owed count above says what the customer has NOT received.
                    It does not say whether anyone is pulling those units — on a
                    backorder they are waiting on stock, but after a raise past
                    picking they are waiting on a person. This sentence is the
                    only one that names an action, so it rides inside the same
                    banner rather than opening a second one. */}
                {shortfallNotice != null && (
                  <p className="mt-1.5 text-amber-800 dark:text-amber-300">{shortfallNotice}</p>
                )}
              </div>
            )}
            {/* Returned units, stated as a LATER event beside the shipped
                total (SO-000085). Neutral tone, not amber — nothing needs
                attention, the order is simply not the clean "everything
                delivered and kept" it would otherwise read as. The net figure
                is arithmetic on records (provided − returned across closed
                returns), and for an in-person swap recorded only in a
                return's notes it is factually WRONG (SO-000085: the records
                say net 2, Lillian holds 3). So the caveat is PRINTED in the
                strip — a reader who never hovers must not be misled — in the
                same words the phone prints beneath its Returns card
                (ORDER_RETURN_SUMMARY_NOTE, one constant, both surfaces). It
                also rides in the figure's title/aria so the figure carries
                its own qualification wherever it is read alone. The returns
                panel with the notes it points at sits directly beneath. */}
            {returnSummary && (
              <div
                className="border-b border-border bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground"
                data-testid="order-return-summary"
              >
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <span className="font-medium">Returns</span>
                  <span
                    className="tabular-nums"
                    title={ORDER_RETURN_SUMMARY_NOTE}
                    aria-label={`${formatOrderReturnSummary(returnSummary)}. ${ORDER_RETURN_SUMMARY_NOTE}`}
                  >
                    {formatOrderReturnSummary(returnSummary)}
                    {orderReturns.length > 0 && (
                      <>
                        {' · '}
                        <a href="#order-returns" className="underline-offset-2 hover:underline">
                          See returns
                        </a>
                      </>
                    )}
                  </span>
                </div>
                <p className="mt-1 text-[10.5px] leading-snug" data-testid="order-return-summary-note">
                  {ORDER_RETURN_SUMMARY_NOTE}
                </p>
              </div>
            )}
            {/* Readiness (F2-1), directly above the lines it describes; with
                "Hold available stock" for an approver when a line is not
                held (F2-2), "Put away N items" when items are in Staging
                (F2-3; the permission sentence instead without Transfer
                stock), and "Draft PO for what is short" when something may be
                drafted (F2-5; the permission sentence instead for anyone who
                may not draft). */}
            {readinessStrip && (
              <ReadinessStrip
                view={readinessStrip}
                holdOrderId={holdOrderId}
                putAway={readinessPutAway}
                neededByChange={neededByChangeOnStrip ? neededByChange : null}
                shortfallPo={readinessShortfallPo}
              />
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Requested</TableHead>
                  <TableHead className="text-right">
                    <span className="inline-flex items-center gap-1">
                      Fulfilled
                      <HelpTip label="Fulfilled vs Owed">
                        <p>
                          Fulfilled counts units actually handed over at
                          pickup/delivery — picked or staged units are not fulfilled
                          yet. Owed is requested minus fulfilled; a backordered order
                          stays live until owed reaches zero or a manager closes it.
                        </p>
                        <p>
                          Returned units are shown under Fulfilled; the shipped
                          count is never rewritten — a return is a later event,
                          listed under Returns below.
                        </p>
                      </HelpTip>
                    </span>
                  </TableHead>
                  <TableHead className="text-right">Owed</TableHead>
                  <TableHead className="text-right">On hand</TableHead>
                  {/* A trailing actions column rather than a click-the-number
                      affordance on Requested. The complaint that produced this
                      was "theres no way to" — a hover-to-reveal editor gives no
                      standing signal that editing exists at all, and removal
                      has no inline home on any of the four numeric columns.
                      One predictable column per row carries both verbs, keeps
                      the right-aligned numbers undisturbed, and gives a refused
                      removal somewhere to render as a disabled control with a
                      reason instead of vanishing. Header is sr-only because an
                      icon column needs no visible label. */}
                  {canEditLines && (
                    <TableHead className="w-px">
                      <span className="sr-only">Line actions</span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={canEditLines ? 6 : 5}
                      className="text-muted-foreground py-6 text-center text-sm"
                    >
                      No lines on this request.
                    </TableCell>
                  </TableRow>
                )}
                {lines.map((l, rowIndex) => {
                  const owed = lineOwedUnits({
                    quantityRequested: l.quantity_requested,
                    quantityFulfilled: l.quantity_fulfilled,
                  });
                  const shortFixes = shortFixesFor(l.id, rowIndex);
                  return (
                    // With readiness under the item name the row is taller:
                    // every cell starts at the top, so the numbers and the
                    // line's controls sit level with the item's name.
                    //
                    // The row is where the completion and departure confirms
                    // send someone ("Review short lines", "Fix the order",
                    // F2-2): it has an id and takes focus from script only.
                    <TableRow
                      key={l.id}
                      id={orderLineAnchorId(l.id)}
                      tabIndex={-1}
                      className={cn(
                        'scroll-mt-24 focus:outline-none data-[review=true]:bg-amber-50/70 dark:data-[review=true]:bg-amber-950/30',
                        readinessAssessment || shortFixes ? '[&>td]:align-top' : undefined,
                      )}
                    >
                      <TableCell>
                        {l.item ? (
                          <>
                            <Link
                              href={`/dashboard/inventory/${l.item.id}`}
                              className="hover:underline"
                            >
                              <div className="font-medium">{l.item.name}</div>
                              <div className="text-muted-foreground font-mono text-[11px]">
                                {l.item.sku}
                              </div>
                            </Link>
                            {l.item.charter_name && (
                              <div
                                className="mt-1 inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] text-emerald-700 dark:text-emerald-300"
                                title={`Earmarked for ${l.item.charter_name}${l.item.charter_code ? ` (${l.item.charter_code})` : ''}`}
                              >
                                <Landmark className="size-3" />
                                {l.item.charter_name}
                              </div>
                            )}
                          </>
                        ) : (
                          // A line's item cannot be deleted (ON DELETE
                          // RESTRICT): a missing item is one this viewer's
                          // access hides. Core's label, the phone's too.
                          <span className="text-muted-foreground italic">
                            {ORDER_LINE_HIDDEN_ITEM_NAME}
                          </span>
                        )}
                        {/* The line's readiness, under its item (F2-1): in
                            the Item cell, not a column of its own. A
                            Readiness column made the table wider than its
                            card at every width (705 px in 641 px) and pushed
                            each line's edit and remove buttons out of view. */}
                        {readinessAssessment && (
                          <div className="mt-2">
                            <ReadinessLineCell
                              {...readinessCellFor(l.id)}
                              timeZone={orgTimeZone}
                              position={rowIndex + 1}
                            />
                          </div>
                        )}
                        {/* The one-tap fix on a short line (F2-2): Lower or
                            Remove, under the line it fixes, in the Item cell
                            (a column of its own would push the row's edit
                            controls out of the card). */}
                        {shortFixes && (
                          <ShortLineFixes
                            orderId={id}
                            lineId={l.id}
                            itemName={orderLineItemName(l.item)}
                            quantityRequested={Number(l.quantity_requested) || 0}
                            fixes={shortFixes}
                          />
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(l.quantity_requested)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatNumber(l.quantity_fulfilled)}
                        {/* The shipped number stays the number. A return is
                            appended BENEATH it as its own labelled figure —
                            "1 / 1 returned" — never subtracted; the hover/aria
                            names the RMA(s) it came back on. Renders nothing
                            when nothing was returned, so a plain delivered
                            order's cell is byte-identical to before. */}
                        {returnedFragment(l.returned_quantity) && (
                          <div
                            className="text-[10.5px]"
                            data-testid="line-returned"
                            title={describeLineReturnRefs(l.returned_quantity, returnRefs.get(l.id)) ?? undefined}
                            aria-label={describeLineReturnRefs(l.returned_quantity, returnRefs.get(l.id)) ?? undefined}
                          >
                            {returnedFragment(l.returned_quantity)}
                          </div>
                        )}
                      </TableCell>
                      <TableCell
                        className={`text-right tabular-nums ${owed > 0 ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}
                      >
                        {formatNumber(owed)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {l.item ? formatNumber(l.item.quantity_on_hand) : '—'}
                      </TableCell>
                      {canEditLines && (
                        <TableCell className="py-1 pr-2 text-right align-middle">
                          {/* itemName is the same label the Item cell shows
                              (core orderLineItemName), so the confirmation
                              names what the viewer is looking at. */}
                          <OrderLineActions
                            orderId={id}
                            lineId={l.id}
                            itemName={orderLineItemName(l.item)}
                            quantityRequested={Number(l.quantity_requested) || 0}
                            quantityFulfilled={Number(l.quantity_fulfilled) || 0}
                            quantityPicked={l.quantity_picked}
                            orderStatus={request.status}
                            isOnlyLine={lines.length === 1}
                          />
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </section>

          {/* The order's returns — number, status, what came back and how it
              was dispositioned, and the NOTES. The notes are where an
              in-person swap is recorded today (SO-000085: "Size S … swapped
              out for Ladies size M" — the replacement is on no order line),
              so they must be readable where a human looks at the order.
              Rendered for every viewer (RLS decided what came back); the RMA
              number is a link only when the returns page would open for this
              viewer. Nothing renders when the order has no returns. */}
          {orderReturns.length > 0 && (
            <section id="order-returns" className="bg-card rounded-xl border" data-testid="order-returns">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <h2 className="text-sm font-medium">Returns ({orderReturns.length})</h2>
                <p className="text-muted-foreground text-xs">
                  A return is a later event — the shipped count above is never rewritten.
                </p>
              </div>
              <ul className="divide-y divide-border">
                {orderReturns.map((r) => (
                  <li key={r.id} className="px-4 py-3" data-testid="order-return">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      {returnsLinkable ? (
                        <Link
                          href={`/dashboard/returns/${r.id}`}
                          className="font-mono font-medium tabular-nums hover:underline"
                        >
                          {returnHandle(r)}
                        </Link>
                      ) : (
                        <span className="font-mono font-medium tabular-nums">{returnHandle(r)}</span>
                      )}
                      <ReturnStatusBadge status={r.status as ReturnStatus} />
                      <span className="text-muted-foreground text-xs">
                        {returnReasonLabel(r.reasonCode)} · {formatRelative(r.closedAt ?? r.createdAt)}
                      </span>
                    </div>
                    {r.lines.length > 0 && (
                      <ul className="text-muted-foreground mt-1.5 space-y-0.5 text-xs tabular-nums">
                        {r.lines.map((rl, i) => (
                          <li key={`${r.id}-${rl.orderRequestLineId}-${i}`}>
                            {describeReturnLine({
                              quantity: rl.quantity,
                              itemName:
                                lineById.get(rl.orderRequestLineId)?.item?.name ??
                                (rl.itemId ? `Item ${rl.itemId.slice(0, 8)}` : null),
                              disposition: rl.disposition,
                              applied: rl.applied,
                            })}
                          </li>
                        ))}
                      </ul>
                    )}
                    {r.notes && (
                      <p className="mt-1.5 whitespace-pre-wrap text-sm" data-testid="order-return-notes">
                        {r.notes}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {reservations.length > 0 && (
            <section className="bg-card rounded-xl border p-4 text-xs">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium">Active reservations</h2>
                <span className="text-muted-foreground tabular-nums">
                  {formatNumber(reservedTotal)} reserved
                </span>
              </div>
              <p className="text-muted-foreground mt-1 text-[11.5px]">
                Stock is held until this request is delivered or cancelled. Removing a
                line, or lowering its quantity, releases that line&rsquo;s share straight
                away.
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
              stockGates={stockGates}
              approveNotice={approveNotice}
              partialPreview={partialPreview}
              completionConfirm={completionConfirm}
              departureLines={departureLines}
              orderId={id}
              status={request.status}
              internalNotes={request.internal_notes}
              neededBy={neededBy}
              orgTimeZone={orgTimeZone}
              hasRequesterNote={Boolean(request.notes?.trim())}
              fulfillmentType={request.fulfillment_type}
              assignedDeliveryUserId={request.assigned_delivery_user_id}
              signatureToken={handOverLink?.token ?? null}
              handOverMfaMessage={handOverMfa ? handOverMfaPanelMessage(handOverMfa.reason) : null}
              hasSignature={hasCapturedSignature(request)}
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
              <OrderTimeline
                orderId={request.id}
                organizationId={ctx.organizationId}
                timeZone={orgTimeZone}
              />
            </React.Suspense>
          </section>
        </div>

        <aside className="space-y-4">
          <section className="bg-card rounded-xl border p-4 text-xs">
            <h2 className="text-muted-foreground mb-2 text-[10.5px] uppercase tracking-[0.08em]">
              Dates
            </h2>
            <dl className="space-y-1.5 text-[11.5px]">
              {(neededBy || neededByChangeInDates) && (
                <div className="flex justify-between gap-3" data-testid="dates-needed-by">
                  <dt className="text-muted-foreground">Needed by</dt>
                  {/* In the org's zone, not the server's (UTC on Vercel). The
                      rows below are relative ("2 hours ago"): a difference
                      from now, the same in every zone. F2-4: Change beside it
                      where the readiness strip does not carry it. */}
                  <dd className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-right font-medium">
                    <span>{neededBy ? formatNeededBy(neededBy, orgTimeZone) : '—'}</span>
                    {neededByChangeInDates && neededByChange && (
                      <NeededByChangeButton orderId={neededByChange.orderId} className="h-6 font-normal" />
                    )}
                  </dd>
                </div>
              )}
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
                  {request.source === 'public_link' ? 'Public link' : request.source === 'portal' ? 'Customer portal' : 'Internal'}
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
