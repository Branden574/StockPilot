import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { ArrowLeft, Camera, ImagePlus, Landmark, PenLine, Trash2, Truck, X } from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { DigitalPick } from '@/components/digital-pick';
import { SignaturePadModal } from '@/components/signature-pad-modal';
import { AddOrderItemsSheet } from '@/components/add-order-items-sheet';
import {
  addedSummary,
  canAddOrderItems,
  derivePickSlipStale,
  // The blocked-status gate now lives inside shouldShowStalePickSlip, which is
  // the only place this screen needed it.
  shouldShowStalePickSlip,
  type AddLinesResult,
} from '@/components/add-order-items';
import { EditOrderLineSheet } from '@/components/edit-order-line-sheet';
import {
  canEditOrderLines,
  lineQuantitySummary,
  lineRemovedSummary,
  orderShortfallNotice,
  type EditableOrderLine,
  type LineQuantityResult,
  type LineRemovedResult,
} from '@/components/edit-order-line';

import { CachedImage } from '@/components/ui/cached-image';
import { Card } from '@/components/ui/card';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import { resizeForUpload } from '@/lib/image-resize';
import { profileFromEmbed, resolveRequesterLabel } from '@/lib/requester-label';
import {
  claimPicking,
  createOrderReturn,
  listOrderDrivers,
  releasePicking,
  transitionOrder,
  type OrderAction,
  type OrderDriver,
} from '@/lib/orders-api';
import {
  buildReturnPayload,
  initialReturnDraft,
  RETURN_REASONS,
  returnableLines,
  type ReturnDraftLine,
  type ReturnReasonCode,
} from '@/lib/order-returns';
import { extractApiErrorMessage } from '@/lib/po-import-approve';
import { useEnabledModules } from '@/lib/enabled-modules';
import {
  BLOCKED_HEADLINE as DR_BLOCKED_HEADLINE,
  BLOCKED_RETRY_MESSAGE as DR_BLOCKED_RETRY,
  COPY_HELPER_TEXT as DR_COPY_HELPER,
  DUPLICATE_WARNING as DR_DUPLICATE_WARNING,
  HONESTY_NOTICE as DR_HONESTY_NOTICE,
  OVERSIZED_MESSAGE as DR_OVERSIZED,
  RECIPIENTS_HELPER_TEXT as DR_RECIPIENTS,
  canRequestDelivery,
  deliverySuccessMessageFor,
  needsDeliveryRequestData,
  openDeliveryRequestDraft,
  parseCharterAddress,
  prepareOrderDeliveryRequest,
  shouldConfirmBeforeOpening,
  shouldShowBlockedNotice,
  shouldShowCondensedNotice,
  shouldWarnDuplicateDrafts,
  type DeliveryOpenResult,
  type DeliveryRequestOrderData,
} from '@/lib/delivery-request-actions';
import { nativeOutlookAvailable, type OutlookPlatform } from '@/lib/outlook-transport';
import {
  availableOrderActions,
  can,
  condensedNoticeText,
  formatOrderNumber,
  derivePickingStatus,
  UNPICKED_SHORTFALL_TITLE,
  type FulfillmentType,
  type OrderStatus,
  type Role,
} from '@stockpilot/core';
import { getOrderShipment, type OrderShipment } from '@/lib/shipping-api';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { UploadBatchProgress, uploadFileToBucket } from '@/lib/storage-upload';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/use-workspace';
import { ACCENT, FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

const BUCKET = 'order-attachments';

const ATTACHABLE = [
  'staged_for_pickup',
  'staged_for_delivery',
  'in_transit',
  'signature_requested',
  'completed',
];

const KIND_LABELS: Record<string, string> = {
  signature: 'Wet signature',
  dropoff_photo: 'Items dropped off',
  location: 'Drop-off location',
  other: 'Other',
};
const KINDS = ['dropoff_photo', 'location', 'signature', 'other'] as const;
type Kind = (typeof KINDS)[number];

const SHIPMENT_STATUS_LABELS: Record<string, string> = {
  draft: 'Label not purchased',
  purchased: 'Label purchased',
  in_transit: 'In transit',
  delivered: 'Delivered',
  returned: 'Returned',
  failure: 'Delivery failed',
  cancelled: 'Cancelled',
};

function mimeForExt(ext: string): string {
  const e = ext.toLowerCase();
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  if (e === 'png') return 'image/png';
  if (e === 'heic') return 'image/heic';
  if (e === 'webp') return 'image/webp';
  return `image/${e}`;
}

interface OrderHeader {
  orderNumber: number | null;
  id: string;
  status: string;
  requester: string | null;
  requesterName: string | null;
  requesterEmail: string | null;
  /** Raw order_requests.requester_user_id. The add-items gate is
   *  requester-or-approver (OrderRequestsService.addLines), so the screen needs
   *  the id itself, not just the rendered label. */
  requesterUserId: string | null;
  orgLabel: string | null;
  warehouseName: string | null;
  /** The ORDER's warehouse. Added lines must be stocked HERE — not at the
   *  workspace's active warehouse — so the add-items picker filters on it. */
  warehouseId: string | null;
  /** Whether a pick slip printed earlier no longer matches the order (a line
   *  was added after it). Derived here because GET /api/v1/orders/[id] does not
   *  forward the service's own pickSlipStale. */
  pickSlipStale: boolean;
  /** order_requests.pick_slip_generated_at. Only a reprint moves it, which is
   *  what lets a merge-only add's staleness warning expire correctly. */
  pickSlipGeneratedAt: string | null;
  /** Whether a signature exists. The blob itself is fetched on modal-open,
   *  not shipped in the order payload to every viewer. */
  hasSignature: boolean;
  signedByName: string | null;
  signedAt: string | null;
  createdAt: string | null;
  assignedDeliveryUserId: string | null;
  /** The locked-in picker (null when unclaimed). Drives the picker chip. */
  assignedPickerId: string | null;
  /** Resolved display name of the assigned picker, when readable. */
  pickerName: string | null;
  fulfillmentType: string | null;
  signatureToken: string | null;
  /** The joined `user_profiles.email`. Kept ALONGSIDE the denormalized
   *  `requester_email` rather than folded into the display label, because the
   *  delivery request needs a real reply-to address and internal self-submits
   *  leave the denormalized column NULL — this is the only contact DC4 gets
   *  on those orders. Previously fetched and thrown away. */
  requesterProfileEmail: string | null;
  /** `order_requests.needed_by` (timestamptz ISO instant). Fed to the shared
   *  delivery-request builder, which localises it to the org zone. */
  neededBy: string | null;
  /** `order_requests.notes` — the requester-facing message, included in a
   *  full-size delivery request draft (the condensed rungs drop it). */
  notes: string | null;
  /** The delivery site (charters row), resolved for the delivery request.
   *  Null for pickup orders and for the legacy delivery rows with no charter. */
  destination: { id: string; name: string; code: string | null; address: ReturnType<typeof parseCharterAddress> } | null;
  /** `organizations.timezone`, or null when unread/unset — the builder then
   *  falls back to the documented default rather than printing a bare time. */
  orgTimezone: string | null;
  /** Line roll-ups for the backorder progress card. requested = ordered,
   *  fulfilled = provided to the customer (shipped at hand-over). */
  totalRequested: number;
  totalFulfilled: number;
  /** Whether a strict approve would fall short (drives "Approve partial"). */
  isShortStock: boolean;
  /** Whether any still-owed line has available stock (gates "Resume fulfillment"). */
  hasFulfillableStock: boolean;
  /** What's being ordered — name/sku/requested (+fulfilled once shipping starts). */
  lines: {
    /** order_request_lines.id — the return payload keys on it. */
    orderRequestLineId: string | null;
    /** inventory_items.id — lets the add-items picker mark rows that are
     *  already on the order (those are topped up, not duplicated). */
    itemId: string | null;
    /** order_request_lines.created_at — drives the pick-slip staleness rule. */
    createdAt: string | null;
    name: string;
    sku: string | null;
    requested: number;
    fulfilled: number;
    /** order_request_lines.quantity_picked — units STAGED by a picker but not
     *  yet handed over. NULL until a picker saves anything, normalised to 0.
     *  Both line-edit floors (lower-bound on a quantity change, and the removal
     *  refusal) are stated in terms of it. */
    picked: number;
    /** Units already applied against prior returns (durable budget, 0153). */
    returned: number;
    /** Item-ownership charter — which site this stock is earmarked for. */
    charterName: string | null;
    charterCode: string | null;
  }[];
}

interface Attachment {
  id: string;
  storagePath: string;
  kind: string;
  contentType: string | null;
  fileName: string | null;
  url: string | null;
  createdAt: string;
}

export default function OrderDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { c, mode } = useTheme();

  const { activeOrgId: orgId, activeRole: role } = useWorkspace();
  const [order, setOrder] = React.useState<OrderHeader | null>(null);
  const [attachments, setAttachments] = React.useState<Attachment[]>([]);
  const [attachmentsError, setAttachmentsError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  /** `percent` is the REAL transported percentage across the batch — floored,
   *  monotonic, held at 99 unless every file genuinely succeeded (see
   *  lib/storage-upload.ts UploadBatchProgress). Never synthesised. */
  const [uploadProgress, setUploadProgress] = React.useState<{
    done: number;
    total: number;
    percent: number;
  } | null>(null);
  const [kind, setKind] = React.useState<Kind>('dropoff_photo');
  const [sigOpen, setSigOpen] = React.useState(false);
  const [sigUrl, setSigUrl] = React.useState<string | null>(null);
  const [sigLoading, setSigLoading] = React.useState(false);
  const [viewerUrl, setViewerUrl] = React.useState<string | null>(null);
  const [shipment, setShipment] = React.useState<OrderShipment | null>(null);

  // Create-return sheet state (staff parity with the web CreateReturnDialog).
  const [returnOpen, setReturnOpen] = React.useState(false);
  const [returnDraft, setReturnDraft] = React.useState<Record<string, ReturnDraftLine>>({});
  const [returnReason, setReturnReason] = React.useState<ReturnReasonCode | null>(null);
  const [returnNotes, setReturnNotes] = React.useState('');
  const [returnSubmitting, setReturnSubmitting] = React.useState(false);
  const [returnError, setReturnError] = React.useState<string | null>(null);

  // Add-items sheet state (parity with the web add-items dialog).
  const [addOpen, setAddOpen] = React.useState(false);
  // Line-edit sheet state. The id, not the line object, is what's held: a
  // reload rebuilds `order.lines` wholesale, and a captured object would leave
  // the open sheet showing (and validating against) pre-reload numbers.
  const [editLineId, setEditLineId] = React.useState<string | null>(null);
  // Bumped after a successful add so DigitalPick re-fetches its lines: it loads
  // them once on mount, so a line added mid-pick would otherwise stay invisible
  // to the picker until they left and came back. Passed as `reloadToken`, not
  // as a `key` — a remount would discard the picker's typed-but-unsaved
  // quantities.
  const [linesVersion, setLinesVersion] = React.useState(0);
  // The pick_slip_generated_at value that was current when an add reported the
  // slip stale. A merge-only add moves no line's created_at, so the derived
  // rule cannot see it; this keeps the banner up until the slip is actually
  // regenerated (which is the only thing that moves that stamp).
  const [staleReportedForSlipAt, setStaleReportedForSlipAt] = React.useState<string | null>(
    null,
  );

  // Pipeline-action state (manager parity with the web ManagerActionsPanel).
  const [acting, setActing] = React.useState<string | null>(null);
  const [denyOpen, setDenyOpen] = React.useState(false);
  const [denyReason, setDenyReason] = React.useState('');
  // Manager override: reopen a picked/packed (pre-signature) order back to
  // picking to fix a miscount. Same reason-required pattern as deny.
  const [reopenOpen, setReopenOpen] = React.useState(false);
  const [reopenReason, setReopenReason] = React.useState('');
  const [driverOpen, setDriverOpen] = React.useState(false);
  const [drivers, setDrivers] = React.useState<OrderDriver[] | null>(null);
  const [signatureModalVisible, setSignatureModalVisible] = React.useState(false);

  const isManager = role !== null && ['owner', 'admin', 'manager'].includes(role);
  const canAttach = isManager && order !== null && ATTACHABLE.includes(order.status);

  // Effective permission set (org role/user overrides applied; static role
  // defaults while loading). Feeds `viewerCanPick` below.
  const permissions = useEffectivePermissions();
  // Whether THIS viewer can pick — manager+ OR holds items:update. Mobile can't
  // see warehouse assignments (the backend + assign_picking enforce warehouse),
  // so this at least keeps a `viewer` role from being offered Claim/Pick. `can`
  // falls back to the static role default when `permissions` hasn't loaded, so a
  // staffer sees pick affordances immediately and a viewer never does.
  const viewerCanPick =
    isManager || (role !== null && can({ role: role as Role, permissions }, 'items:update'));

  // Returns (RMA) — staff "Create return" parity with the web order page. The
  // affordance shows only when the viewer holds returns:manage (effective set,
  // static role fallback while loading), the org's `returns` module is on, the
  // order is completed (or legacy delivered) AND at least one line still has
  // returnable budget (fulfilled − returned > 0, mirroring web's
  // returnableLines). All of it is cosmetic — the server route re-asserts
  // module + permission + status + the durable budget on submit.
  const enabledModules = useEnabledModules();
  const canManageReturns =
    role !== null && can({ role: role as Role, permissions }, 'returns:manage');
  const orderReturnable = React.useMemo(
    () =>
      order
        ? returnableLines(
            order.status,
            order.lines.map((l) => ({
              orderRequestLineId: l.orderRequestLineId,
              name: l.name,
              sku: l.sku,
              quantityFulfilled: l.fulfilled,
              returnedQuantity: l.returned,
            })),
          )
        : [],
    [order],
  );
  const showCreateReturn =
    canManageReturns && enabledModules.has('returns') && orderReturnable.length > 0;

  // ── Delivery request ────────────────────────────────────────────────────
  // Mobile parity with the web order page's SendDeliveryRequestButton. Opens a
  // prefilled draft in the employee's mail app; sends nothing, creates nothing.
  //
  // Every decision below is imported from lib/delivery-request-actions — the
  // gate, the input mapping, the transport and every word of copy — because
  // this file is a .tsx under app/ and this repo's mobile vitest can reach
  // neither. A decision written inline here would be untestable.
  const showDeliveryRequest = canRequestDelivery({
    status: order?.status ?? null,
    fulfillmentType: order?.fulfillmentType ?? null,
    requesterUserId: order?.requesterUserId ?? null,
    viewerUserId: user?.id ?? null,
    ordersModuleEnabled: enabledModules.has('orders'),
  });
  const deliveryOrderData = React.useMemo<DeliveryRequestOrderData | null>(
    () =>
      order
        ? {
            id: order.id,
            orderNumber: order.orderNumber,
            warehouseName: order.warehouseName,
            requesterName: order.requesterName,
            requesterLabel: order.requester,
            requesterEmail: order.requesterEmail,
            requesterProfileEmail: order.requesterProfileEmail,
            neededBy: order.neededBy,
            notes: order.notes,
            destination: order.destination,
            orgTimezone: order.orgTimezone,
            lines: order.lines.map((l) => ({
              itemId: l.itemId,
              name: l.name,
              sku: l.sku,
              requested: l.requested,
            })),
          }
        : null,
    [order],
  );
  /**
   * Is the native Outlook app installed? Probed ONCE, held here, and fed to
   * `prepareOrderDeliveryRequest` — the ONLY consumer.
   *
   * It used to be handed to `openDeliveryRequestDraft` as well, so that the url
   * opened matched the url the item-row ladder measured. That pairing is no
   * longer this screen's to keep: the opener reads `transport` off the prepared
   * draft, so the value below cannot be passed to two places and cannot
   * disagree with itself. See `openDeliveryRequestDraft`.
   *
   * This is plumbing, not a decision: every rule about what `null` means and
   * which transport follows from it lives in `deliveryComposeTransport` in
   * lib/delivery-request-actions, where vitest can reach it. All this does is
   * turn one async answer into state.
   *
   * `null` until the probe resolves, which is the WORST-CASE budget (the long
   * https url) and also the url that would open during that window — so a tap
   * before it settles is consistent, merely carrying fewer item rows. The probe
   * opens nothing and costs no compose screen, but it is still gated on the
   * action being visible so ordinary order screens do not ask at all.
   */
  const [nativeOutlook, setNativeOutlook] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    if (!showDeliveryRequest) return;
    let alive = true;
    void nativeOutlookAvailable().then((available) => {
      if (alive) setNativeOutlook(available);
    });
    return () => {
      alive = false;
    };
  }, [showDeliveryRequest]);

  // Pure and deterministic (no clock, no DOM), so it is safe in a memo — the
  // same shape the maintenance screen uses for its own prepared draft. It
  // re-runs when the probe settles, which is what lets the phone carry the
  // extra rows the native url has room for.
  const deliveryPrepared = React.useMemo(
    () =>
      deliveryOrderData && showDeliveryRequest
        ? prepareOrderDeliveryRequest(deliveryOrderData, nativeOutlook)
        : null,
    [deliveryOrderData, showDeliveryRequest, nativeOutlook],
  );
  const [deliveryDraftCount, setDeliveryDraftCount] = React.useState(0);
  const [deliveryResult, setDeliveryResult] = React.useState<DeliveryOpenResult | null>(null);
  const [deliveryCopyOpen, setDeliveryCopyOpen] = React.useState(false);

  // Add items to an EXISTING order (owner request 2026-07-22) — cosmetic mirror
  // of OrderRequestsService.addLines: orders module on, the order has not
  // shipped or died, and the viewer is its requester or holds orders:approve.
  // `orders:request` alone is deliberately NOT enough to grow someone else's
  // order. The route re-asserts all of it, so this only decides what to show.
  const lineGate = {
    status: order?.status ?? null,
    requesterUserId: order?.requesterUserId ?? null,
    viewerUserId: user?.id ?? null,
    viewerRole: (role as Role | null) ?? null,
    permissions,
    ordersModuleEnabled: enabledModules.has('orders'),
  };
  const canAddItems = canAddOrderItems(lineGate);
  // Correcting a line rides the SAME gate — on the server all three line
  // mutations load the order through one helper (loadEditableOrderHeader), and
  // an order you can add to but cannot correct is exactly the bug the owner
  // reported.
  const canEditItems = canEditOrderLines(lineGate);
  const existingItemIds = React.useMemo(
    () => (order?.lines ?? []).map((l) => l.itemId).filter((x): x is string => x !== null),
    [order],
  );

  /**
   * Open the delivery-request draft.
   *
   * `Platform.OS` is read HERE and nowhere in src/lib — the transport decision
   * stays a pure, node-testable function that takes the platform as data
   * (react-native cannot be imported under this repo's vitest).
   *
   * `result.used` is the transport that ACTUALLY carried the draft, and it is
   * what the confirmation below is worded from — never the button that was
   * pressed, so the screen can never say "Outlook opened" about the default
   * mail app.
   */
  async function runDeliveryOpen() {
    if (!deliveryPrepared) return;
    setActing('delivery-request');
    const platform: OutlookPlatform = Platform.OS === 'android' ? 'android' : 'ios';
    const result = await openDeliveryRequestDraft(
      'outlook',
      // Which url opens is decided by THIS object's own `transport` field, the
      // one core's ladder stamped when it measured the body. There is no probe
      // answer to pass alongside it and therefore nothing here that can drift
      // out of step with what was measured.
      deliveryPrepared,
      platform,
      // Fires only after a real, successful open, so a blocked attempt is
      // never counted as a draft and cannot trigger the duplicate warning.
      () => setDeliveryDraftCount((n) => n + 1),
    );
    setActing(null);
    setDeliveryResult(result);
    // A blocked open surfaces the copy panel, which always carries the
    // complete uncondensed message — the one honest transport left.
    if (result.outcome === 'blocked') setDeliveryCopyOpen(true);
  }

  function handleDeliveryRequestPress() {
    // The draft is too long for any compose link. Nothing is opened — a mail
    // client would truncate it silently — so go straight to the copy panel.
    if (deliveryPrepared && !deliveryPrepared.linkFits) {
      setDeliveryCopyOpen(true);
      return;
    }
    if (shouldConfirmBeforeOpening(deliveryDraftCount)) {
      Alert.alert('Open another draft?', DR_DUPLICATE_WARNING, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Another Draft', onPress: () => void runDeliveryOpen() },
      ]);
      return;
    }
    void runDeliveryOpen();
  }

  /** Post-add: refresh the pick workspace, confirm what changed, then reload. */
  async function handleItemsAdded(res: AddLinesResult) {
    setAddOpen(false);
    setLinesVersion((v) => v + 1);
    // The route's own pickSlipStale is the only signal that survives a
    // merge-only add (it UPDATEs quantity_requested and inserts nothing, so no
    // line's created_at moves and derivePickSlipStale reads false on the very
    // next load). Pin it to the slip it was about so the banner clears when
    // that slip is reprinted, not one second later.
    if (res.pickSlipStale) setStaleReportedForSlipAt(order?.pickSlipGeneratedAt ?? null);
    Alert.alert('Items added', addedSummary(res));
    await load();
  }

  // The line the edit sheet is working on, resolved from the CURRENT order on
  // every render. Re-resolving (rather than storing the row) means a reload
  // that lands while the sheet is open re-seeds it with the server's numbers,
  // so the floors it enforces are never stale. A line that disappeared — some
  // one else removed it — resolves to null and the sheet closes itself.
  const editLine: EditableOrderLine | null = React.useMemo(() => {
    if (editLineId === null || !order) return null;
    const l = order.lines.find((x) => x.orderRequestLineId === editLineId);
    if (!l) return null;
    return {
      orderRequestLineId: l.orderRequestLineId,
      itemId: l.itemId,
      name: l.name,
      requested: l.requested,
      fulfilled: l.fulfilled,
      picked: l.picked,
      returned: l.returned,
    };
  }, [editLineId, order]);

  /** Shared post-edit refresh for both line mutations. */
  async function afterLineEdit(pickSlipStale: boolean, title: string, message: string) {
    setEditLineId(null);
    // Tell DigitalPick to re-fetch. reloadToken, NOT a remount: the picker's
    // typed-but-unsaved quantities live in its local state until Save/Complete,
    // and mergePickQuantities (lib/pick-quantities.ts) keeps every value they
    // have already entered while re-seeding only the lines that changed. A
    // remount would wipe them, and the following "Complete picking" would then
    // see no dirty lines and ship them at zero.
    setLinesVersion((v) => v + 1);
    // A quantity change moves no line's created_at and a removal moves none
    // either, so derivePickSlipStale cannot see them on the next load — the
    // route's own verdict is the only signal. Pin it to the slip it was about
    // so the banner clears when THAT slip is reprinted, not one second later.
    if (pickSlipStale) setStaleReportedForSlipAt(order?.pickSlipGeneratedAt ?? null);
    Alert.alert(title, message);
    await load();
  }

  function handleLineChanged(line: EditableOrderLine, res: LineQuantityResult) {
    void afterLineEdit(res.pickSlipStale, 'Quantity updated', lineQuantitySummary(line, res));
  }

  function handleLineRemoved(line: EditableOrderLine, res: LineRemovedResult) {
    void afterLineEdit(res.pickSlipStale, 'Item removed', lineRemovedSummary(line, res));
  }

  function openReturnSheet() {
    setReturnDraft(initialReturnDraft(orderReturnable));
    setReturnReason(null);
    setReturnNotes('');
    setReturnError(null);
    setReturnOpen(true);
  }

  /** Step one line's return quantity, clamped to [0, remaining]. */
  function stepReturnQty(lineId: string, delta: number, max: number) {
    setReturnDraft((prev) => {
      const existing = prev[lineId] ?? { quantity: 0, disposition: 'restock' as const };
      const next = Math.min(max, Math.max(0, existing.quantity + delta));
      return { ...prev, [lineId]: { ...existing, quantity: next } };
    });
    setReturnError(null);
  }

  function setReturnDisposition(lineId: string, disposition: ReturnDraftLine['disposition']) {
    setReturnDraft((prev) => {
      const existing = prev[lineId] ?? { quantity: 0, disposition: 'restock' as const };
      return { ...prev, [lineId]: { ...existing, disposition } };
    });
  }

  async function submitReturn() {
    // Double-submit guard: the button is disabled while submitting, and this
    // re-check covers a queued second tap racing the state update.
    if (!id || returnSubmitting) return;
    const payload = buildReturnPayload({
      lines: orderReturnable,
      draft: returnDraft,
      reasonCode: returnReason,
      notes: returnNotes,
    });
    if (!payload.ok) {
      setReturnError(payload.error);
      return;
    }
    setReturnSubmitting(true);
    setReturnError(null);
    try {
      await createOrderReturn(id, payload.body);
      setReturnOpen(false);
      Alert.alert('Return created', 'Return created — pending approval.');
      await load();
    } catch (e) {
      // 4xx (over-budget, module off, permission revoked mid-session…) —
      // surface the server's message inline in the sheet, not a dead toast.
      setReturnError(
        extractApiErrorMessage(e, 'Could not create the return. Please try again.'),
      );
    } finally {
      setReturnSubmitting(false);
    }
  }


  const loadAttachments = React.useCallback(async () => {
    if (!orgId || !id) return;
    const { data, error } = await supabase
      .from('order_request_attachments')
      .select('id, storage_path, kind, content_type, file_name, created_at')
      .eq('organization_id', orgId)
      .eq('order_request_id', id)
      .order('created_at', { ascending: false });
    // A failed read must NOT masquerade as "No attachments yet." — surface it
    // as an error state so a member seeing an empty gallery is distinguishable
    // from a member whose read actually failed (offline / RLS denial).
    setAttachmentsError(error ? error.message : null);
    const rows = (data ?? []) as Record<string, unknown>[];
    const paths = rows.map((r) => r.storage_path as string);
    const signed = new Map<string, string>();
    if (paths.length > 0) {
      const { data: urls } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 60 * 60);
      for (const u of (urls ?? []) as { path?: string | null; signedUrl: string }[]) {
        if (u.path) signed.set(u.path, u.signedUrl);
      }
    }
    setAttachments(
      rows.map((r) => ({
        id: r.id as string,
        storagePath: r.storage_path as string,
        kind: (r.kind as string | null) ?? 'other',
        contentType: (r.content_type as string | null) ?? null,
        fileName: (r.file_name as string | null) ?? null,
        url: signed.get(r.storage_path as string) ?? null,
        createdAt: r.created_at as string,
      })),
    );
  }, [orgId, id]);

  const load = React.useCallback(async () => {
    if (!orgId || !id) return;
    const { data } = await supabase
      .from('order_requests')
      .select(
        // `requester:user_profiles!requester_user_id` resolves the team-member
        // name that internal orders DON'T denormalize onto the row (else they
        // showed "Unknown requester"). RLS lets org members read each other.
        // `picker:user_profiles!assigned_picker_id` resolves the claimant's name
        // for the picker chip (assigned_picker_id FK → user_profiles.id, mig
        // 0109). RLS lets org members read each other, same as the requester join.
        // `needed_by`, `notes` and `delivery_charter_id` are FREE here — three
        // more columns on a row this screen already fetches — and they are what
        // let the delivery request draft say when the order is needed, carry the
        // requester's message, and name the destination site. Without them the
        // phone would compose a visibly thinner email than the web page does for
        // the same order.
        `id, order_number, status, requester_name, requester_email, requester_user_id, requester_org_label,
         signed_by_name, signed_at, created_at, warehouse_id, pick_slip_generated_at,
         assigned_delivery_user_id, assigned_picker_id, fulfillment_type, signature_token,
         needed_by, notes, delivery_charter_id,
         warehouse:warehouses!warehouse_id (name),
         requester:user_profiles!requester_user_id (full_name, email),
         picker:user_profiles!assigned_picker_id (full_name, email)`,
      )
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle();
    // Order lines — both the per-line ITEMS list (a manager must SEE what's
    // being ordered before approving) and the backorder roll-ups.
    const { data: lineRows } = await supabase
      .from('order_request_lines')
      .select(
        // quantity_picked is read for the line-edit floors: it is what a picker
        // has STAGED but not yet handed over, and lowering a request beneath it
        // (or removing the line) would strand that physical stock.
        'id, item_id, created_at, quantity_requested, quantity_fulfilled, quantity_picked, returned_quantity, item:inventory_items(name, sku, charter_id, charter:charters!charter_id(name, code))',
      )
      .eq('order_request_id', id);
    type LineItemEmbed = {
      name: string | null;
      sku: string | null;
      charter_id?: string | null;
      charter?: { name: string | null; code: string | null } | { name: string | null; code: string | null }[] | null;
    };
    const rows = (lineRows ?? []) as {
      id: string | null;
      item_id: string | null;
      created_at: string | null;
      quantity_requested: number | null;
      quantity_fulfilled: number | null;
      quantity_picked: number | null;
      returned_quantity: number | null;
      item: LineItemEmbed | LineItemEmbed[] | null;
    }[];
    const totalRequested = rows.reduce((s, l) => s + (Number(l.quantity_requested) || 0), 0);
    const totalFulfilled = rows.reduce((s, l) => s + (Number(l.quantity_fulfilled) || 0), 0);

    // NOTE (2026-07-22): the per-order stock_reservations read that used to sit
    // here is GONE. It existed only to mirror removeLine's reservation refusal,
    // and that refusal was the production defect: a reservation is a soft hold
    // minted for every line at APPROVAL, so it blocked removal on orders where
    // nothing had been picked. The service now re-syncs the hold instead of
    // refusing, nothing else on this screen read the result, and the query
    // silently discarded its own error — so it is deleted rather than kept as a
    // round trip nobody consumes. The reservation read below is a DIFFERENT one
    // (availability maths for Approve-partial / Resume-fulfillment) and stays.
    //
    // Stock-awareness, mirroring the web page loader:
    //  - pending_approval → isShortStock (drives "Approve partial"), judged on
    //    PER-ITEM demand (duplicate-item lines are summed first).
    //  - backordered → hasFulfillableStock (gates "Resume fulfillment").
    // Only computed on those two statuses to keep load() light.
    let isShortStock = false;
    let hasFulfillableStock = false;
    const stStatus = (data as Record<string, unknown> | null)?.status;
    if ((stStatus === 'pending_approval' || stStatus === 'backordered') && rows.length > 0) {
      const itemIds = [...new Set(rows.map((l) => l.item_id).filter((x): x is string => Boolean(x)))];
      if (itemIds.length > 0) {
        const [{ data: itemRows }, { data: resvRows }] = await Promise.all([
          supabase.from('inventory_items').select('id, quantity_on_hand').in('id', itemIds),
          supabase
            .from('stock_reservations')
            .select('item_id, quantity')
            .in('item_id', itemIds)
            .is('released_at', null),
        ]);
        const onHandById = new Map<string, number>();
        for (const it of (itemRows ?? []) as { id: string; quantity_on_hand: number | null }[]) {
          onHandById.set(it.id, Number(it.quantity_on_hand) || 0);
        }
        const reservedByItem = new Map<string, number>();
        for (const rv of (resvRows ?? []) as { item_id: string; quantity: number | null }[]) {
          reservedByItem.set(rv.item_id, (reservedByItem.get(rv.item_id) ?? 0) + (Number(rv.quantity) || 0));
        }
        const demandByItem = new Map<string, { requested: number; owed: number }>();
        for (const l of rows) {
          if (!l.item_id) continue;
          const entry = demandByItem.get(l.item_id) ?? { requested: 0, owed: 0 };
          entry.requested += Number(l.quantity_requested) || 0;
          entry.owed += Math.max(
            0,
            (Number(l.quantity_requested) || 0) - (Number(l.quantity_fulfilled) || 0),
          );
          demandByItem.set(l.item_id, entry);
        }
        for (const [itemId, d] of demandByItem) {
          const available = Math.max(0, (onHandById.get(itemId) ?? 0) - (reservedByItem.get(itemId) ?? 0));
          if (stStatus === 'pending_approval' && d.requested > available) isShortStock = true;
          if (stStatus === 'backordered' && d.owed > 0 && available > 0) hasFulfillableStock = true;
        }
      }
    }
    // Delivery-request inputs: the destination site and the org's timezone.
    //
    // Gated on ROW-DERIVED facts only — is this a live delivery order — and
    // never on the viewer, so `load` keeps its existing deps and does not
    // re-run when auth or module state settles. A pickup order, or a
    // completed/denied/cancelled one, pays nothing. The two reads share one
    // round trip.
    //
    // The org timezone cannot come from the workspace boot query the way web
    // gets it from an admin-client cache: mobile reads `organizations`
    // directly, which RLS permits for any org member (organizations_select →
    // is_org_member(id)). A null result is left null and the builder falls
    // back to the documented default rather than printing a time in no zone.
    let destination: OrderHeader['destination'] = null;
    let orgTimezone: string | null = null;
    const headerRow = data as Record<string, unknown> | null;
    // The SAME predicate the display gate is built from (see
    // needsDeliveryRequestData) — never a status list retyped here, which is how
    // a fetch gate ends up narrower than the button that depends on it.
    const isLiveDelivery =
      headerRow != null &&
      needsDeliveryRequestData({
        status: (headerRow.status as string | null) ?? null,
        fulfillmentType: (headerRow.fulfillment_type as string | null) ?? null,
      });
    if (isLiveDelivery) {
      const charterId = (headerRow.delivery_charter_id as string | null) ?? null;
      const [charterRes, orgRes] = await Promise.all([
        charterId
          ? supabase
              .from('charters')
              .select('id, name, code, address')
              .eq('organization_id', orgId)
              .eq('id', charterId)
              .maybeSingle()
          : Promise.resolve({ data: null }),
        supabase.from('organizations').select('timezone').eq('id', orgId).maybeSingle(),
      ]);
      const ch = charterRes.data as Record<string, unknown> | null;
      if (ch && typeof ch.id === 'string') {
        destination = {
          id: ch.id,
          name: (ch.name as string | null) ?? '',
          code: (ch.code as string | null) ?? null,
          // charters.address is jsonb — anything at all can be in there, so it
          // goes through the same defensive parse the web page uses.
          address: parseCharterAddress(ch.address),
        };
      }
      orgTimezone = ((orgRes.data as Record<string, unknown> | null)?.timezone as string | null) ?? null;
    }

    if (data) {
      const r = data as Record<string, unknown>;
      const wh = r.warehouse as { name: string | null } | { name: string | null }[] | null;
      const whObj = Array.isArray(wh) ? wh[0] : wh;
      const pk = r.picker as
        | { full_name: string | null; email: string | null }
        | { full_name: string | null; email: string | null }[]
        | null;
      const pkObj = Array.isArray(pk) ? pk[0] : pk;
      setOrder({
        id: r.id as string,
        orderNumber: (r.order_number as number | null) ?? null,
        status: r.status as string,
        requester: resolveRequesterLabel({
          requesterName: (r.requester_name as string | null) ?? null,
          requesterEmail: (r.requester_email as string | null) ?? null,
          requesterUserId: (r.requester_user_id as string | null) ?? null,
          profile: profileFromEmbed(r.requester),
        }),
        requesterName: (r.requester_name as string | null) ?? null,
        requesterEmail: (r.requester_email as string | null) ?? null,
        requesterUserId: (r.requester_user_id as string | null) ?? null,
        orgLabel: (r.requester_org_label as string | null) ?? null,
        warehouseName: whObj?.name ?? null,
        warehouseId: (r.warehouse_id as string | null) ?? null,
        // Derived with the SAME rule OrderRequestsService.get() applies for the
        // web page (any line created after the slip was printed), so a reprint
        // prompt can never drift out of sync with what web shows.
        pickSlipStale: derivePickSlipStale(
          (r.pick_slip_generated_at as string | null) ?? null,
          rows.map((l) => ({ createdAt: l.created_at ?? null })),
        ),
        // Kept alongside the derived flag so a merge-only add's warning can be
        // held until this stamp MOVES (i.e. the slip was actually reprinted).
        pickSlipGeneratedAt: (r.pick_slip_generated_at as string | null) ?? null,
        hasSignature: (r.signed_at as string | null) != null,
        signedByName: (r.signed_by_name as string | null) ?? null,
        signedAt: (r.signed_at as string | null) ?? null,
        createdAt: (r.created_at as string | null) ?? null,
        assignedDeliveryUserId: (r.assigned_delivery_user_id as string | null) ?? null,
        assignedPickerId: (r.assigned_picker_id as string | null) ?? null,
        pickerName: pkObj?.full_name?.trim() || pkObj?.email?.trim() || null,
        fulfillmentType: (r.fulfillment_type as string | null) ?? null,
        signatureToken: (r.signature_token as string | null) ?? null,
        // The joined profile email, kept as its own field. `profileFromEmbed`
        // already normalises the array-or-object embed shape PostgREST returns.
        requesterProfileEmail: profileFromEmbed(r.requester)?.email?.trim() || null,
        neededBy: (r.needed_by as string | null) ?? null,
        notes: (r.notes as string | null) ?? null,
        destination,
        orgTimezone,
        totalRequested,
        totalFulfilled,
        isShortStock,
        hasFulfillableStock,
        lines: rows.map((l) => {
          const itemObj = Array.isArray(l.item) ? l.item[0] : l.item;
          const charterObj = Array.isArray(itemObj?.charter)
            ? itemObj?.charter[0]
            : itemObj?.charter;
          return {
            orderRequestLineId: l.id ?? null,
            itemId: l.item_id ?? null,
            createdAt: l.created_at ?? null,
            name: itemObj?.name ?? 'Unknown item',
            sku: itemObj?.sku ?? null,
            requested: Number(l.quantity_requested) || 0,
            fulfilled: Number(l.quantity_fulfilled) || 0,
            picked: Number(l.quantity_picked) || 0,
            returned: Number(l.returned_quantity) || 0,
            charterName: charterObj?.name ?? null,
            charterCode: charterObj?.code ?? null,
          };
        }),
      });
    }
    await loadAttachments();
    // Read-only carrier tracking. The wrapper soft-gates: if the shipping
    // module is off, the member lacks access, or there is simply no shipment,
    // it returns null and the section below stays hidden.
    setShipment(await getOrderShipment(id));
    setLoading(false);
  }, [orgId, id, loadAttachments]);

  useFocusEffect(
    React.useCallback(() => {
      void load();
    }, [load]),
  );

  // Fetch the signature blob only when the viewer opens the dialog — it's an
  // image seen inside a closed-by-default modal, so shipping it in the order
  // payload to every viewer wasted bandwidth on every screen focus.
  React.useEffect(() => {
    // `sigLoading` must NOT be a dep — setting it below would re-run the
    // effect, whose cleanup cancels the in-flight query, hanging the spinner.
    if (!sigOpen || sigUrl || !orgId || !id) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-dialog-open: the sync set is the spinner flag (needed again on reopen after a failed fetch); the data set is post-await
    setSigLoading(true);
    void (async () => {
      try {
        const { data } = await supabase
          .from('order_requests')
          .select('signature_data_url')
          .eq('organization_id', orgId)
          .eq('id', id)
          .maybeSingle();
        if (!cancelled) {
          setSigUrl((data?.signature_data_url as string | null) ?? null);
        }
      } catch {
        /* leave null — modal shows nothing */
      } finally {
        if (!cancelled) setSigLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sigOpen, sigUrl, orgId, id]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  // Run any order mutation under a shared busy key, then reload. The server
  // enforces module + permission + status (and 409 on a claim race); we just
  // surface its message on failure. Returns whether the mutation succeeded so
  // the reason-capture flows below can decide whether to dismiss — every
  // other caller still just fires this with `void` and ignores the result,
  // exactly as before.
  async function runAction(busyKey: string, fn: () => Promise<void>): Promise<boolean> {
    setActing(busyKey);
    try {
      await fn();
      await load();
      return true;
    } catch (e) {
      Alert.alert('Could not update order', e instanceof Error ? e.message : 'Please try again.');
      return false;
    } finally {
      setActing(null);
    }
  }

  // Advance the order through the pipeline, then reload.
  async function act(body: OrderAction, busyKey: string): Promise<boolean> {
    if (!id) return false;
    return runAction(busyKey, () => transitionOrder(id, body));
  }

  // Single place that dismisses the deny modal WITHOUT submitting — Cancel,
  // the backdrop press, and Android's hardware back (onRequestClose) all
  // route here. The typed reason is wiped on every one of those paths so it
  // can never resurface pre-filled against a later, unrelated order — it's
  // an audit-logged field. submitDeny below is untouched and does NOT call
  // this: it already closes the modal and clears the reason on its own
  // (pre-existing, unrelated to this fix), so this function only covers the
  // dismiss-without-submit paths that used to leak the typed text.
  function dismissDenyModal() {
    setDenyOpen(false);
    setDenyReason('');
  }

  async function submitDeny() {
    if (acting !== null) return;
    const reason = denyReason.trim();
    if (!reason) {
      Alert.alert('Reason required', 'Enter a reason before denying.');
      return;
    }
    // Keep the modal open (with the typed reason) until the deny actually
    // goes through — act() swallows the error into an Alert rather than
    // rethrowing, so a `false` result means it failed and the reason must
    // stay put for the user to retry instead of vanishing with the modal.
    const ok = await act({ action: 'deny', reason }, 'deny');
    if (ok) {
      setDenyOpen(false);
      setDenyReason('');
    }
  }

  // Same single-dismiss-point pattern as dismissDenyModal above.
  function dismissReopenModal() {
    setReopenOpen(false);
    setReopenReason('');
  }

  async function reopenPicking() {
    if (acting !== null) return;
    const reason = reopenReason.trim();
    if (!reason) {
      Alert.alert('Reason required', 'Enter a reason before reopening picking.');
      return;
    }
    // Same rationale as submitDeny above: only dismiss + clear once the
    // reopen actually succeeds, so a failure leaves the typed reason intact.
    const ok = await act({ action: 'reopen_picking', reason }, 'reopen');
    if (ok) {
      setReopenOpen(false);
      setReopenReason('');
    }
  }

  async function openDriverPicker() {
    setDriverOpen(true);
    if (drivers === null && id) {
      try {
        setDrivers(await listOrderDrivers(id));
      } catch (e) {
        setDriverOpen(false);
        Alert.alert('Could not load drivers', e instanceof Error ? e.message : 'Please try again.');
      }
    }
  }

  function collectSignature() {
    if (!order?.signatureToken) {
      Alert.alert('No signature link', 'Generate the packing slip first to create a signature link.');
      return;
    }
    setSignatureModalVisible(true);
  }

  // Whether the current status exposes any manager action (so we don't render an
  // empty section at, e.g., a terminal status).
  const ft = order?.fulfillmentType;
  const st = order?.status;
  // NOTE: the picking phase (pick_slip_generated / picking_in_progress) is
  // intentionally NOT here — it has its own PICKING section below that renders
  // for staff pickers too, not just managers.
  const hasPipelineActions =
    isManager &&
    !!st &&
    (st === 'pending_approval' ||
      st === 'approved' ||
      st === 'picking_complete' ||
      (st === 'packing_slip_generated' && (ft === 'pickup' || ft === 'delivery')) ||
      st === 'staged_for_delivery' ||
      st === 'staged_for_pickup' ||
      st === 'in_transit' ||
      st === 'backordered');

  // Fulfilled = units PROVIDED to the customer (shipped at hand-over); owed =
  // the still-unfulfilled remainder. Drives the backorder progress card.
  const totalRequested = order?.totalRequested ?? 0;
  const totalFulfilled = order?.totalFulfilled ?? 0;
  const totalOwed = Math.max(0, totalRequested - totalFulfilled);
  // SO-000061: units neither handed over NOR staged — nobody has pulled them.
  // Derived, and only meaningful once picking is settled; the shared helper in
  // @stockpilot/core owns the arithmetic and the status set, so this card and
  // the web order page can never disagree about the number or the wording.
  const shortfallNotice = order ? orderShortfallNotice(order.lines, order.status) : null;

  // Picking claim/lock (owner decisions, enforced server-side). This section is
  // visible to ANY role in the picking phase — a staff picker must claim before
  // picking; the picker or a manager may release; a manager may pick directly.
  // Which buttons show is decided by the shared @stockpilot/core state machine
  // (the same source of truth the web order page reads); the server re-checks.
  const pickingStatus =
    order && st ? derivePickingStatus(st as OrderStatus, order.assignedPickerId) : null;
  const isPickingPhase =
    pickingStatus === 'unassigned' ||
    pickingStatus === 'assigned' ||
    pickingStatus === 'in_progress';
  const pickActions =
    isPickingPhase && order && role
      ? availableOrderActions({
          status: st as OrderStatus,
          fulfillmentType: (ft as FulfillmentType | null) ?? 'pickup',
          hasAssignedDelivery: order.assignedDeliveryUserId !== null,
          viewerRole: role as Role,
          viewerUserId: user?.id ?? '',
          assignedPickerId: order.assignedPickerId,
          assignedDeliveryUserId: order.assignedDeliveryUserId,
          viewerCanPick,
        })
      : [];
  const canClaimPick = pickActions.includes('claim_picking');
  const canDigitalPick = pickActions.includes('open_digital_pick');
  const canReleasePick = pickActions.includes('release_picking');
  // Reopen-picking gate: the same shared-state-machine call as `pickActions`
  // above, but WITHOUT the `isPickingPhase` guard — `isPickingPhase` is false
  // at exactly picking_complete/packing_slip_generated, the two statuses
  // reopen applies to, so reusing `pickActions` directly would hide the
  // button. Deriving from `availableOrderActions` (rather than re-checking
  // role + status inline) means mobile can never drift from web on who may
  // reopen picking or from which statuses.
  const canReopenPicking =
    order && role
      ? availableOrderActions({
          status: st as OrderStatus,
          fulfillmentType: (ft as FulfillmentType | null) ?? 'pickup',
          hasAssignedDelivery: order.assignedDeliveryUserId !== null,
          viewerRole: role as Role,
          viewerUserId: user?.id ?? '',
          assignedPickerId: order.assignedPickerId,
          assignedDeliveryUserId: order.assignedDeliveryUserId,
          viewerCanPick,
        }).includes('reopen_picking')
      : false;
  const pickerLabel =
    !order || order.assignedPickerId === null
      ? 'Unassigned'
      : order.assignedPickerId === user?.id
        ? 'Being picked by you'
        : order.pickerName
          ? `Being picked by ${order.pickerName}`
          : 'Being picked by another picker';

  const actionBtn = (
    label: string,
    busyKey: string,
    onPress: () => void,
    tone: 'primary' | 'danger' | 'default' = 'primary',
  ) => {
    const isBusy = acting === busyKey;
    const bg = tone === 'primary' ? c.ink : tone === 'danger' ? '#b42318' : 'transparent';
    const fg = tone === 'default' ? c.ink : tone === 'danger' ? '#fff' : c.paper;
    return (
      <Pressable
        key={label}
        onPress={onPress}
        disabled={acting !== null}
        style={[
          styles.addBtn,
          {
            backgroundColor: bg,
            borderWidth: 1,
            borderColor: tone === 'default' ? c.hair : 'transparent',
            opacity: acting !== null && !isBusy ? 0.5 : 1,
          },
        ]}
      >
        {isBusy ? <ActivityIndicator color={fg} /> : <Mono size={13} color={fg}>{label}</Mono>}
      </Pressable>
    );
  };

  // Uploads ONE asset (resize → storage → row). Returns success/failure
  // WITHOUT touching the shared `uploading` flag or refetching, so the single
  // and batch flows can share it. Per-file storage rollback on a row-insert
  // failure is preserved so we never leave an orphaned object behind. The
  // bytes stream straight off disk via lib/storage-upload's native
  // createUploadTask (signed-URL PUT, same RLS insert gate enforced at mint)
  // — which also retires this call site's fetch('file://').arrayBuffer() and
  // reports REAL transported progress through `onProgress`.
  async function uploadOne(
    uri: string,
    onProgress?: (fraction: number) => void,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!orgId || !id) return { ok: false, error: 'Not ready' };
    try {
      const resized = await resizeForUpload(uri);
      const path = `${orgId}/${id}/${Math.random().toString(36).slice(2, 14)}.${resized.ext}`;
      const up = await uploadFileToBucket({
        bucket: BUCKET,
        path,
        fileUri: resized.uri,
        contentType: mimeForExt(resized.ext),
        onProgress,
      });
      if (!up.ok) return { ok: false, error: up.error };
      const { error: rowErr } = await supabase.from('order_request_attachments').insert({
        organization_id: orgId,
        order_request_id: id,
        storage_path: path,
        file_name: null,
        content_type: mimeForExt(resized.ext),
        kind,
      });
      if (rowErr) {
        await supabase.storage.from(BUCKET).remove([path]);
        return { ok: false, error: rowErr.message };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Please try again.' };
    }
  }

  async function uploadAsset(uri: string) {
    setUploading(true);
    const batch = new UploadBatchProgress(['single']);
    setUploadProgress({ done: 0, total: 1, percent: 0 });
    try {
      const res = await uploadOne(uri, (fraction) => {
        batch.report('single', fraction);
        setUploadProgress({ done: 0, total: 1, percent: batch.percent });
      });
      // Honest settle: only a success may ever read 100%.
      batch.settle('single', res.ok);
      if (!res.ok) Alert.alert('Upload failed', res.error ?? 'Please try again.');
      await loadAttachments();
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  }

  // Multi-file upload: concurrency capped at 2 (peak memory during concurrent
  // resize on older iPhones), a live 'N/M + %' progress label, ONE refetch at
  // the end, and a SINGLE aggregated failure Alert (stacked concurrent Alerts
  // are unreliable on Android). Airplane-mode mid-batch → failures are
  // reported, the batch finishes, and no storage objects are orphaned. The
  // percent is count-weighted transported progress (UploadBatchProgress):
  // monotonic, and a failed file keeps only the fraction it truly reached, so
  // the label can never read 100% when an upload died.
  async function uploadAssets(uris: string[]) {
    if (uris.length === 0) return;
    if (uris.length === 1) {
      await uploadAsset(uris[0]!);
      return;
    }
    setUploading(true);
    setUploadProgress({ done: 0, total: uris.length, percent: 0 });
    const failures: string[] = [];
    let done = 0;
    // Keys are index-composited — the same uri picked twice must not share
    // one progress slot.
    const batch = new UploadBatchProgress(uris.map((_, i) => String(i)));
    const queue = uris.map((uri, i) => ({ uri, key: String(i) }));
    const worker = async () => {
      while (queue.length > 0) {
        const { uri, key } = queue.shift()!;
        const res = await uploadOne(uri, (fraction) => {
          batch.report(key, fraction);
          setUploadProgress({ done, total: uris.length, percent: batch.percent });
        });
        // Honest settle: a failed file keeps the fraction it reached.
        batch.settle(key, res.ok);
        if (!res.ok) failures.push(res.error ?? 'Upload failed');
        done += 1;
        setUploadProgress({ done, total: uris.length, percent: batch.percent });
      }
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(2, uris.length) }, () => worker()),
      );
      await loadAttachments();
      if (failures.length > 0) {
        Alert.alert(
          `${failures.length} of ${uris.length} uploads failed`,
          failures.slice(0, 3).join('\n'),
        );
      }
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  }

  async function fromCamera() {
    let perm = await ImagePicker.getCameraPermissionsAsync();
    if (!perm.granted) perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Camera access needed', 'Allow camera to capture proof photos.');
      return;
    }
    try {
      const result = await ImagePicker.launchCameraAsync({
        quality: 0.7,
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        cameraType: ImagePicker.CameraType.back,
      });
      if (result.canceled || !result.assets[0]) return;
      await uploadAsset(result.assets[0].uri);
    } catch (e) {
      Alert.alert('Camera unavailable', e instanceof Error ? e.message : 'Use Library instead.');
    }
  }

  async function fromLibrary() {
    let perm = await ImagePicker.getMediaLibraryPermissionsAsync();
    if (!perm.granted) perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Photo access needed', 'Allow photo library to attach images.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      quality: 0.7,
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      selectionLimit: 5,
    });
    if (result.canceled) return;
    await uploadAssets(result.assets.map((a) => a.uri));
  }

  function addProof() {
    Alert.alert('Add proof of delivery', `Saving as "${KIND_LABELS[kind]}"`, [
      { text: 'Take photo', onPress: () => void fromCamera() },
      { text: 'Choose from library', onPress: () => void fromLibrary() },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  async function deleteAttachment(att: Attachment) {
    await supabase.storage.from(BUCKET).remove([att.storagePath]);
    await supabase
      .from('order_request_attachments')
      .delete()
      .eq('organization_id', orgId)
      .eq('id', att.id);
    await loadAttachments();
  }

  function openAttachment(a: Attachment) {
    if (!a.url) {
      // Signed-URL minting failed (offline, or a storage-RLS denial) — say so
      // instead of a dead tap on the tile.
      Alert.alert(
        'Couldn’t open file',
        'No download link is available right now. Pull to refresh and try again.',
      );
      return;
    }
    // Images open in an in-app full-screen viewer; PDFs/other open in the
    // device's browser/viewer via the signed URL.
    if ((a.contentType ?? '').startsWith('image/')) {
      setViewerUrl(a.url);
    } else {
      Linking.openURL(a.url).catch(() =>
        Alert.alert('Could not open', 'Unable to open this file on your device.'),
      );
    }
  }

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip
            icon={ArrowLeft}
            onPress={() => {
              if (router.canGoBack()) router.back();
              else router.replace('/');
            }}
          />
        </View>
      </SafeAreaView>

      {loading ? (
        <ActivityIndicator color={c.ink} style={{ marginTop: 40 }} />
      ) : !order ? (
        <View style={styles.center}>
          <Display size={18}>Order not <Em>found.</Em></Display>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 60, gap: 16 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.ink} />}
        >
          <View style={{ paddingTop: 4 }}>
            <Eyebrow>{`ORDER${order.orderNumber ? ` ${formatOrderNumber(order.orderNumber)}` : ''} · ${order.status.replace(/_/g, ' ').toUpperCase()}`}</Eyebrow>
            <Display size={30} style={{ marginTop: 10 }}>
              {order.requester ?? 'Order'}
            </Display>
            <Mono size={11.5} tracking={0.04} color={c.ink4} style={{ marginTop: 4 }}>
              {[order.orgLabel, order.warehouseName].filter(Boolean).join(' · ') || '—'}
            </Mono>
          </View>

          {totalOwed > 0 && (totalFulfilled > 0 || order.status === 'backordered') ? (
            <Card padding={14}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Body size={13} color="#b45309">
                  {order.status === 'backordered' ? 'Backordered — awaiting stock' : 'Partially fulfilled'}
                </Body>
                <Mono size={11} color="#b45309">
                  {totalFulfilled} / {totalRequested} · {totalOwed} owed
                </Mono>
              </View>
              <View
                style={{
                  marginTop: 10,
                  height: 6,
                  borderRadius: 999,
                  backgroundColor: c.hair,
                  overflow: 'hidden',
                }}
              >
                <View
                  style={{
                    height: '100%',
                    borderRadius: 999,
                    backgroundColor: '#f59e0b',
                    width: `${totalRequested > 0 ? Math.round((totalFulfilled / totalRequested) * 100) : 0}%`,
                  }}
                />
              </View>
              {/* The owed count above says what the customer has not received.
                  It does not say whether anyone is pulling those units. This
                  sentence is the only one that names an action, so it rides
                  inside the same card rather than opening a second one. */}
              {shortfallNotice ? (
                <Body size={12} color="#b45309" style={{ marginTop: 10 }}>
                  {shortfallNotice}
                </Body>
              ) : null}
            </Card>
          ) : null}

          {/* Standalone only when the partial-fulfilment card above is NOT up —
              when it is, the same units are already counted there as "owed"
              and the instruction is appended inside it instead. */}
          {shortfallNotice != null &&
          !(totalOwed > 0 && (totalFulfilled > 0 || order.status === 'backordered')) ? (
            <Card padding={14}>
              <Body size={13} color={ACCENT.warn}>
                {UNPICKED_SHORTFALL_TITLE}
              </Body>
              <Mono size={11} color={ACCENT.warn} style={{ marginTop: 4 }}>
                {shortfallNotice}
              </Mono>
            </Card>
          ) : null}

          {order.lines.length > 0 || canAddItems ? (
            <View style={{ gap: 10 }}>
              <Eyebrow>
                {`ITEMS · ${order.lines.length} LINE${order.lines.length === 1 ? '' : 'S'} · ${totalRequested} UNITS`}
              </Eyebrow>
              {/* Visible to EVERY viewer, not just whoever can add items — the
                  picker holding a printed slip is the one who needs to know.
                  Suppressed once the order has shipped or died: a reprint is
                  then moot. */}
              {/* Suppressed while the shortfall card below is up: that card
                  already says to generate the slip again AND names how many
                  units are missing, which this one cannot know. Two warn-tone
                  cards giving the same instruction is the confusion the web
                  page avoids the same way. */}
              {shortfallNotice == null &&
              shouldShowStalePickSlip({
                derived: order.pickSlipStale,
                pickSlipGeneratedAt: order.pickSlipGeneratedAt,
                staleReportedForSlipAt,
                status: order.status,
              }) ? (
                <Card padding={14}>
                  <Body size={13} color={ACCENT.warn}>
                    Pick slip out of date
                  </Body>
                  <Mono size={11} color={ACCENT.warn} style={{ marginTop: 4 }}>
                    Items were added after it was printed. Generate the pick slip again before
                    picking.
                  </Mono>
                </Card>
              ) : null}
              {order.lines.length === 0 ? (
                <Mono size={11} color={c.ink4}>
                  This order has no items yet.
                </Mono>
              ) : (
                <Card padding={0}>
                  {order.lines.map((l, i) => {
                    // A line is tappable when the viewer may edit lines at all
                    // and the row actually carries its id — the PATCH/DELETE
                    // twins address the line by id, so a row without one has
                    // nothing to send.
                    const editable = canEditItems && l.orderRequestLineId !== null;
                    return (
                      <Pressable
                        key={`${l.sku ?? l.name}-${i}`}
                        onPress={
                          editable ? () => setEditLineId(l.orderRequestLineId) : undefined
                        }
                        accessibilityRole={editable ? 'button' : undefined}
                        accessibilityLabel={
                          editable ? `Edit ${l.name}, quantity ${l.requested}` : undefined
                        }
                        style={({ pressed }) => ({
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 12,
                          paddingHorizontal: 14,
                          paddingVertical: 12,
                          borderTopWidth: i === 0 ? 0 : 1,
                          borderTopColor: c.hair,
                          opacity: editable && pressed ? 0.6 : 1,
                        })}
                      >
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Body size={14} color={c.ink} numberOfLines={2}>
                            {l.name}
                          </Body>
                          {l.sku ? (
                            <Mono size={10.5} tracking={0.04} color={c.ink4} style={{ marginTop: 2 }}>
                              {l.sku}
                            </Mono>
                          ) : null}
                          {l.charterName ? (
                            <View
                              style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                alignSelf: 'flex-start',
                                // maxWidth + flexShrink below are BOTH required for
                                // numberOfLines to actually ellipsize in RN (default
                                // flexShrink is 0, and a flex-start chip is otherwise
                                // measured at max-content and overflows the column).
                                maxWidth: '100%',
                                gap: 3,
                                marginTop: 4,
                                paddingHorizontal: 6,
                                paddingVertical: 1,
                                borderRadius: 999,
                                backgroundColor: ACCENT.mintSoft,
                              }}
                            >
                              <Landmark
                                size={10}
                                color={mode === 'dark' ? ACCENT.mintInkDark : ACCENT.mintInk}
                              />
                              <Mono
                                size={10}
                                tracking={0.02}
                                color={mode === 'dark' ? ACCENT.mintInkDark : ACCENT.mintInk}
                                numberOfLines={1}
                                style={{ flexShrink: 1 }}
                              >
                                {l.charterCode ? `${l.charterName} (${l.charterCode})` : l.charterName}
                              </Mono>
                            </View>
                          ) : null}
                        </View>
                        <View style={{ alignItems: 'flex-end' }}>
                          <Mono size={13} color={c.ink}>
                            ×{l.requested}
                          </Mono>
                          {l.fulfilled > 0 && l.fulfilled < l.requested ? (
                            <Mono size={10.5} color="#b45309" style={{ marginTop: 2 }}>
                              {l.fulfilled} provided · {l.requested - l.fulfilled} owed
                            </Mono>
                          ) : l.fulfilled >= l.requested && l.requested > 0 ? (
                            <Mono size={10.5} color={c.ink4} style={{ marginTop: 2 }}>
                              fulfilled
                            </Mono>
                          ) : null}
                          {editable ? (
                            <Mono size={10} tracking={0.08} upper color={c.ink4} style={{ marginTop: 3 }}>
                              Edit
                            </Mono>
                          ) : null}
                        </View>
                      </Pressable>
                    );
                  })}
                </Card>
              )}
              {canEditItems && order.lines.length > 0 ? (
                <Mono size={10.5} color={c.ink4}>
                  Tap a line to change its quantity or take it off the order.
                </Mono>
              ) : null}
              {canAddItems ? (
                <>
                  {actionBtn('Add items', 'add-items', () => setAddOpen(true), 'default')}
                  <Mono size={10.5} color={c.ink4}>
                    Items already on this order are topped up rather than listed twice.
                  </Mono>
                </>
              ) : null}
            </View>
          ) : null}

          {isPickingPhase && order ? (
            <View style={{ gap: 10 }}>
              <Eyebrow>PICKING</Eyebrow>
              {/* Picker chip: unassigned, you, a named picker, or an anonymous
                  other (when only the id is readable). */}
              <View
                style={{
                  alignSelf: 'flex-start',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 7,
                  borderWidth: 1,
                  borderColor: c.hair,
                  borderRadius: 999,
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  backgroundColor: c.card,
                }}
              >
                <View
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 4,
                    backgroundColor: order.assignedPickerId ? '#16a34a' : c.ink4,
                  }}
                />
                <Mono size={11} color={c.ink}>{pickerLabel}</Mono>
              </View>

              {/* Unclaimed + viewer is staff → claim before picking. */}
              {canClaimPick
                ? actionBtn('Claim picking', 'claim', () =>
                    void runAction('claim', () => claimPicking(id!)),
                  )
                : null}

              {/* Assigned picker or a manager → the pick workspace. A non-manager
                  who is NOT the claimant sees a note instead (never the inputs). */}
              {canDigitalPick ? (
                <DigitalPick
                  // Merging refresh after an add, NOT a remount. Remounting
                  // (key={`pick-${linesVersion}`}) discarded every typed-but-
                  // unsaved quantity, because those live in DigitalPick's local
                  // state until Save/Complete — and a following "Complete
                  // picking" would then see no dirty lines and ship them at
                  // zero. reloadToken re-fetches and keeps the typed values.
                  reloadToken={linesVersion}
                  orderId={id!}
                  canPick
                  onCompleted={() => void load()}
                />
              ) : !canClaimPick &&
                order.assignedPickerId !== null &&
                order.assignedPickerId !== user?.id ? (
                <Mono size={11.5} color={c.ink4}>
                  This order is being picked by someone else.
                </Mono>
              ) : null}

              {/* Self-release by the picker, or a manager override/reassign
                  affordance (release, then re-claim / pick directly). */}
              {canReleasePick
                ? actionBtn(
                    'Release',
                    'release',
                    () => void runAction('release', () => releasePicking(id!)),
                    'default',
                  )
                : null}

              <Mono size={10.5} color={c.ink4}>
                Same actions as the web dashboard — changes sync instantly.
              </Mono>
            </View>
          ) : null}

          {hasPipelineActions ? (
            <View style={{ gap: 8 }}>
              <Eyebrow>MANAGER ACTIONS</Eyebrow>
              {order.status === 'pending_approval' ? (
                <>
                  {actionBtn('Approve', 'approve', () => void act({ action: 'approve' }, 'approve'))}
                  {order.isShortStock
                    ? actionBtn(
                        'Approve partial',
                        'approve-partial',
                        () => void act({ action: 'approve_partial' }, 'approve-partial'),
                        'default',
                      )
                    : null}
                  {actionBtn('Deny', 'deny', () => setDenyOpen(true), 'danger')}
                </>
              ) : null}
              {order.status === 'approved'
                ? actionBtn('Generate pick slip', 'gps', () =>
                    void act({ action: 'generate_pick_slip' }, 'gps'),
                  )
                : null}
              {order.status === 'picking_complete'
                ? actionBtn('Generate packing slips', 'gpk', () =>
                    void act({ action: 'generate_packing_slips' }, 'gpk'),
                  )
                : null}
              {order.status === 'picking_complete' && canReopenPicking
                ? actionBtn('Reopen picking', 'reopen', () => setReopenOpen(true), 'danger')
                : null}
              {order.status === 'packing_slip_generated' && order.fulfillmentType === 'pickup'
                ? actionBtn('Mark staged for pickup', 'stage', () =>
                    void act({ action: 'stage', target: 'staged_for_pickup' }, 'stage'),
                  )
                : null}
              {order.status === 'packing_slip_generated' && order.fulfillmentType === 'delivery'
                ? actionBtn('Mark staged for delivery', 'stage', () =>
                    void act({ action: 'stage', target: 'staged_for_delivery' }, 'stage'),
                  )
                : null}
              {order.status === 'packing_slip_generated' && canReopenPicking
                ? actionBtn('Reopen picking', 'reopen', () => setReopenOpen(true), 'danger')
                : null}
              {order.status === 'staged_for_delivery'
                ? actionBtn(
                    order.assignedDeliveryUserId ? 'Reassign delivery' : 'Assign delivery',
                    'assign',
                    () => void openDriverPicker(),
                    'default',
                  )
                : null}
              {order.status === 'staged_for_delivery' && order.assignedDeliveryUserId
                ? actionBtn('Mark in transit', 'transit', () =>
                    void act({ action: 'mark_in_transit' }, 'transit'),
                  )
                : null}
              {order.status === 'staged_for_pickup' || order.status === 'in_transit' ? (
                <>
                  {actionBtn('Collect signature', 'sig', collectSignature)}
                  {actionBtn(
                    'Physical signature',
                    'physicalsig',
                    () =>
                      Alert.prompt(
                        'Physical signature',
                        "Customer signed on paper? Enter the signer's name — this completes the hand-over exactly like the digital sign page (backordering any still-owed items).",
                        [
                          { text: 'Cancel', style: 'cancel' },
                          {
                            text: 'Record',
                            onPress: (name?: string) => {
                              const signer = (name ?? '').trim();
                              if (!signer) {
                                Alert.alert('Name required', 'Enter who signed the paper copy.');
                                return;
                              }
                              void act(
                                { action: 'confirm_physical_signature', signerName: signer },
                                'physicalsig',
                              );
                            },
                          },
                        ],
                        'plain-text',
                      ),
                    'default',
                  )}
                </>
              ) : null}
              {order.status === 'backordered' ? (
                <>
                  {order.hasFulfillableStock ? (
                    actionBtn('Resume fulfillment', 'resume', () =>
                      void act({ action: 'resume_fulfillment' }, 'resume'),
                    )
                  ) : (
                    <Body size={12} color={c.ink4}>
                      Resume unlocks when owed items are back in stock.
                    </Body>
                  )}
                  {actionBtn(
                    'Close as delivered-partial',
                    'closepartial',
                    () =>
                      Alert.alert(
                        'Close as delivered-partial?',
                        'This ends the order and keeps the record of what was delivered. The remaining backordered units will NOT be fulfilled.',
                        [
                          { text: 'Keep open', style: 'cancel' },
                          {
                            text: 'Close order',
                            onPress: () => void act({ action: 'close_partial' }, 'closepartial'),
                          },
                        ],
                      ),
                    'default',
                  )}
                  {actionBtn(
                    'Cancel order',
                    'cancelorder',
                    () =>
                      Alert.alert(
                        'Cancel this order?',
                        'The order is voided. Already-delivered items are NOT restocked; the hold on the remaining items is released.',
                        [
                          { text: 'Keep order', style: 'cancel' },
                          {
                            text: 'Cancel order',
                            style: 'destructive',
                            onPress: () => void act({ action: 'cancel' }, 'cancelorder'),
                          },
                        ],
                      ),
                    'danger',
                  )}
                </>
              ) : null}
              <Mono size={10.5} color={c.ink4}>
                Same actions as the web dashboard — changes sync instantly.
              </Mono>
            </View>
          ) : null}

          {showDeliveryRequest && deliveryPrepared ? (
            <View style={{ gap: 8 }}>
              <Eyebrow>DELIVERY REQUEST</Eyebrow>
              {actionBtn('Email delivery request', 'delivery-request', handleDeliveryRequestPress)}
              <Mono size={10.5} color={c.ink4}>
                {DR_RECIPIENTS}
              </Mono>
              <Mono size={10.5} color={c.ink4}>
                {DR_HONESTY_NOTICE}
              </Mono>

              {/* Two mutually exclusive length states, both sourced from the
                  shared builder so the phone and the web page describe the
                  same draft in the same words. */}
              {shouldShowCondensedNotice(deliveryPrepared) ? (
                <Mono size={10.5} color={c.ink4}>
                  {condensedNoticeText(deliveryPrepared.draft)}
                </Mono>
              ) : null}
              {!deliveryPrepared.linkFits ? (
                <Mono size={10.5} color={c.ink4}>
                  {DR_OVERSIZED}
                </Mono>
              ) : null}

              {/* Deliberately one behind the confirm dialog's threshold, which
                  is why it is a named function and not a `> 1` typed here: the
                  two thresholds are unreadable side by side from this file, and
                  an off-by-one between them is invisible on screen until
                  someone mails DC4 twice. Both live in the tested module. */}
              {shouldWarnDuplicateDrafts(deliveryDraftCount) ? (
                <Mono size={10.5} color={c.ink4}>
                  {DR_DUPLICATE_WARNING}
                </Mono>
              ) : null}

              {deliveryResult?.outcome === 'opened' ? (
                <Mono size={10.5} color={c.ink4}>
                  {deliverySuccessMessageFor(deliveryResult.used)}
                </Mono>
              ) : null}
              {/* A blocked open and an oversized draft are different failures
                  with different remedies — the retry this card offers is
                  useless advice for a draft no link can carry. The AND that
                  keeps them apart lives in the tested module, not here. */}
              {shouldShowBlockedNotice(deliveryPrepared, deliveryResult) ? (
                <>
                  <Mono size={10.5} color={c.ink4}>
                    {DR_BLOCKED_HEADLINE}
                  </Mono>
                  <Mono size={10.5} color={c.ink4}>
                    {DR_BLOCKED_RETRY}
                  </Mono>
                </>
              ) : null}

              {deliveryCopyOpen ? (
                <>
                  {/* The terminal transport. ALWAYS the full, uncondensed
                      message including both recipients, so the employee can
                      complete the task by hand no matter what failed. There is
                      no clipboard module in this binary, so the selectable box
                      IS the copy affordance. */}
                  <Mono size={10.5} color={c.ink4}>
                    {DR_COPY_HELPER}
                  </Mono>
                  <Card padding={14}>
                    <Body size={12} color={c.ink} selectable>
                      {deliveryPrepared.clipboardText}
                    </Body>
                  </Card>
                </>
              ) : (
                actionBtn(
                  'Copy details',
                  'delivery-copy',
                  () => setDeliveryCopyOpen(true),
                  'default',
                )
              )}
            </View>
          ) : null}

          {showCreateReturn ? (
            <View style={{ gap: 8 }}>
              <Eyebrow>RETURNS</Eyebrow>
              {actionBtn('Create return', 'create-return', openReturnSheet)}
              <Mono size={10.5} color={c.ink4}>
                Goes to the returns approval queue — stock moves only after it is approved and
                received.
              </Mono>
            </View>
          ) : null}

          {order.hasSignature ? (
            <Pressable onPress={() => setSigOpen(true)}>
              <Card padding={14}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <PenLine size={16} color={c.ink} strokeWidth={1.7} />
                  <View style={{ flex: 1 }}>
                    <Body size={14} color={c.ink}>View signature</Body>
                    <Mono size={11} color={c.ink4} style={{ marginTop: 2 }}>
                      {order.signedByName ?? 'Signed'}
                      {order.signedAt ? ` · ${new Date(order.signedAt).toLocaleDateString()}` : ''}
                    </Mono>
                  </View>
                </View>
              </Card>
            </Pressable>
          ) : null}

          {shipment ? (
            <View style={{ gap: 8 }}>
              <Eyebrow>SHIPPING</Eyebrow>
              <Card padding={14}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                  <Truck size={16} color={c.ink} strokeWidth={1.7} style={{ marginTop: 2 }} />
                  <View style={{ flex: 1, gap: 6 }}>
                    <Body size={14} color={c.ink}>
                      {[shipment.carrier, shipment.service].filter(Boolean).join(' · ') || 'Carrier'}
                    </Body>
                    <Mono size={11} color={c.ink4}>
                      {SHIPMENT_STATUS_LABELS[shipment.status] ??
                        shipment.status.replace(/_/g, ' ')}
                      {shipment.tracking_status ? ` · ${shipment.tracking_status}` : ''}
                    </Mono>
                    {shipment.tracking_code ? (
                      <Mono size={11} color={c.ink3}>{`Tracking ${shipment.tracking_code}`}</Mono>
                    ) : null}
                    {shipment.tracking_url ? (
                      <Pressable
                        onPress={() =>
                          Linking.openURL(shipment.tracking_url as string).catch(() =>
                            Alert.alert('Could not open', 'Unable to open the tracking page.'),
                          )
                        }
                        hitSlop={6}
                      >
                        <Mono size={11} color={c.ink} style={{ textDecorationLine: 'underline' }}>
                          Track package
                        </Mono>
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              </Card>
            </View>
          ) : null}

          <View style={{ gap: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Eyebrow>PROOF OF DELIVERY</Eyebrow>
            </View>

            {canAttach ? (
              <View style={{ gap: 10 }}>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {KINDS.map((k) => {
                    const on = kind === k;
                    return (
                      <Pressable
                        key={k}
                        onPress={() => setKind(k)}
                        style={{
                          paddingHorizontal: 10,
                          paddingVertical: 6,
                          borderRadius: 8,
                          borderWidth: 1,
                          borderColor: on ? c.ink : c.hair,
                          backgroundColor: on ? c.ink : 'transparent',
                        }}
                      >
                        <Mono size={10.5} color={on ? c.paper : c.ink3}>
                          {KIND_LABELS[k]}
                        </Mono>
                      </Pressable>
                    );
                  })}
                </View>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <Pressable
                    onPress={addProof}
                    disabled={uploading}
                    style={[styles.addBtn, { backgroundColor: c.ink, opacity: uploading ? 0.6 : 1 }]}
                  >
                    {uploading ? (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <ActivityIndicator color={c.paper} />
                        {uploadProgress ? (
                          <Mono size={13} color={c.paper}>
                            {uploadProgress.total > 1
                              ? `Uploading ${uploadProgress.done}/${uploadProgress.total} · ${uploadProgress.percent}%`
                              : `Uploading… ${uploadProgress.percent}%`}
                          </Mono>
                        ) : null}
                      </View>
                    ) : (
                      <>
                        <Camera size={16} color={c.paper} strokeWidth={1.8} />
                        <Mono size={13} color={c.paper}>Add proof</Mono>
                      </>
                    )}
                  </Pressable>
                </View>
              </View>
            ) : (
              <Mono size={11} color={c.ink4}>
                {isManager
                  ? 'Available once the order is out for delivery or completed.'
                  : 'Managers can add proof of delivery here.'}
              </Mono>
            )}

            {attachments.length === 0 && attachmentsError ? (
              <Pressable onPress={() => void loadAttachments()}>
                <Mono size={11} color="#b42318" style={{ marginTop: 4 }}>
                  {`Couldn’t load attachments — tap to retry. (${attachmentsError})`}
                </Mono>
              </Pressable>
            ) : attachments.length === 0 ? (
              <Mono size={11} color={c.ink4} style={{ marginTop: 4 }}>No attachments yet.</Mono>
            ) : (
              <View style={styles.grid}>
                {attachments.map((a) => {
                  const isImage = (a.contentType ?? '').startsWith('image/');
                  return (
                    <View key={a.id} style={[styles.tile, { borderColor: c.hair, backgroundColor: c.card }]}>
                      <Pressable onPress={() => openAttachment(a)}>
                        {isImage && a.url ? (
                          <CachedImage uri={a.url} style={styles.tileImg} recyclingKey={a.id} />
                        ) : (
                          <View style={[styles.tileImg, { alignItems: 'center', justifyContent: 'center', gap: 4 }]}>
                            <ImagePlus size={20} color={c.ink4} />
                            <Mono size={9} color={c.ink4}>Open</Mono>
                          </View>
                        )}
                      </Pressable>
                      <View style={styles.tileFoot}>
                        <Mono size={9.5} color={c.ink4} numberOfLines={1} style={{ flex: 1 }}>
                          {KIND_LABELS[a.kind] ?? 'Other'}
                        </Mono>
                        {isManager ? (
                          <Pressable onPress={() => void deleteAttachment(a)} hitSlop={8}>
                            <Trash2 size={14} color={c.ink4} />
                          </Pressable>
                        ) : null}
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
          </View>
        </ScrollView>
      )}

      <Modal visible={sigOpen} transparent animationType="fade" onRequestClose={() => setSigOpen(false)}>
        <Pressable
          onPress={() => setSigOpen(false)}
          style={{
            flex: 1,
            justifyContent: 'center',
            padding: 24,
            backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)',
          }}
        >
          <Pressable onPress={() => undefined} style={{ backgroundColor: c.card, borderRadius: 16, padding: 18, gap: 12 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>Customer signature</Body>
              <Pressable onPress={() => setSigOpen(false)} hitSlop={8}>
                <X size={18} color={c.ink4} />
              </Pressable>
            </View>
            {sigLoading ? (
              <View style={{ height: 180, alignItems: 'center', justifyContent: 'center' }}>
                <ActivityIndicator color={c.ink4} />
              </View>
            ) : sigUrl ? (
              <View style={{ backgroundColor: '#fff', borderRadius: 8, padding: 8 }}>
                <Image
                  source={{ uri: sigUrl }}
                  style={{ width: '100%', height: 180 }}
                  resizeMode="contain"
                />
              </View>
            ) : null}
            <Mono size={11} color={c.ink4}>
              {order?.signedByName ?? 'Signed'}
              {order?.signedAt ? ` · ${new Date(order.signedAt).toLocaleString()}` : ''}
            </Mono>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={!!viewerUrl}
        transparent
        animationType="fade"
        onRequestClose={() => setViewerUrl(null)}
      >
        <Pressable
          onPress={() => setViewerUrl(null)}
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            padding: 12,
            backgroundColor: 'rgba(0,0,0,0.92)',
          }}
        >
          {viewerUrl ? (
            <View
              style={{
                width: '100%',
                height: '82%',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {/* Spinner sits behind the image — visible only until the photo
                  paints, instead of a silent black gap. */}
              <ActivityIndicator
                color="rgba(255,255,255,0.8)"
                style={{ position: 'absolute' }}
              />
              {/* CachedImage shares the tile's disk cache (keyed by the
                  token-stripped storage path), so the full view opens
                  instantly from bytes expo-image already has — the old plain
                  RN Image re-downloaded them through its separate cache. */}
              <CachedImage
                uri={viewerUrl}
                style={{ width: '100%', height: '100%' }}
                contentFit="contain"
              />
            </View>
          ) : null}
          <Mono size={11} color="rgba(255,255,255,0.7)" style={{ marginTop: 16 }}>
            Tap anywhere to close
          </Mono>
        </Pressable>
      </Modal>

      {/* Deny-reason capture (the requester sees this reason). */}
      <Modal visible={denyOpen} transparent animationType="fade" onRequestClose={dismissDenyModal}>
        <Pressable
          onPress={dismissDenyModal}
          style={{
            flex: 1,
            justifyContent: 'center',
            padding: 24,
            backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)',
          }}
        >
          <Pressable onPress={() => undefined} style={{ backgroundColor: c.card, borderRadius: 16, padding: 18, gap: 12 }}>
            <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>Deny this request?</Body>
            <Mono size={11} color={c.ink4}>The requester is notified with the reason you provide.</Mono>
            <TextInput
              value={denyReason}
              onChangeText={setDenyReason}
              placeholder="Reason"
              placeholderTextColor={c.ink4}
              multiline
              style={{
                minHeight: 72,
                borderWidth: 1,
                borderColor: c.hair,
                borderRadius: 10,
                padding: 10,
                color: c.ink,
                fontFamily: FONT.mono,
                fontSize: 13,
                textAlignVertical: 'top',
              }}
            />
            <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'flex-end' }}>
              <Pressable
                onPress={dismissDenyModal}
                style={[styles.addBtn, { backgroundColor: 'transparent', borderWidth: 1, borderColor: c.hair, paddingHorizontal: 18 }]}
              >
                <Mono size={13} color={c.ink}>Cancel</Mono>
              </Pressable>
              <Pressable
                onPress={() => void submitDeny()}
                disabled={acting !== null}
                style={[
                  styles.addBtn,
                  { backgroundColor: '#b42318', paddingHorizontal: 18, opacity: acting !== null ? 0.5 : 1 },
                ]}
              >
                <Mono size={13} color="#fff">Deny</Mono>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Reopen-picking reason capture — manager override that sends a
          picked/packed (pre-signature) order back to picking_in_progress.
          Same reason-required pattern as the deny modal above; the confirm
          button additionally stays disabled until a reason is entered
          (Alert.prompt is iOS-only, so this can't be a native prompt). */}
      <Modal
        visible={reopenOpen}
        transparent
        animationType="fade"
        onRequestClose={dismissReopenModal}
      >
        <Pressable
          onPress={dismissReopenModal}
          style={{
            flex: 1,
            justifyContent: 'center',
            padding: 24,
            backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)',
          }}
        >
          <Pressable onPress={() => undefined} style={{ backgroundColor: c.card, borderRadius: 16, padding: 18, gap: 12 }}>
            <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>Reopen picking?</Body>
            <Mono size={11} color={c.ink4} style={{ lineHeight: 16 }}>
              Sends this order back to picking so the count can be corrected. The picked
              quantities and the assigned picker are kept, but the stock that was picked returns
              to Unplaced — not necessarily its original rack — and will need to be put away
              again before it can ship.
              {order?.status === 'packing_slip_generated'
                ? ' The already-generated packing slip will be voided; a new one must be printed after picking finishes.'
                : ''}{' '}
              A signed order can&apos;t be reopened. This is recorded in the audit log.
            </Mono>
            <TextInput
              value={reopenReason}
              onChangeText={setReopenReason}
              placeholder="Why is this being reopened? (e.g. miscount on line 3)"
              placeholderTextColor={c.ink4}
              multiline
              style={{
                minHeight: 72,
                borderWidth: 1,
                borderColor: c.hair,
                borderRadius: 10,
                padding: 10,
                color: c.ink,
                fontFamily: FONT.mono,
                fontSize: 13,
                textAlignVertical: 'top',
              }}
            />
            <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'flex-end' }}>
              <Pressable
                onPress={dismissReopenModal}
                style={[styles.addBtn, { backgroundColor: 'transparent', borderWidth: 1, borderColor: c.hair, paddingHorizontal: 18 }]}
              >
                <Mono size={13} color={c.ink}>Cancel</Mono>
              </Pressable>
              <Pressable
                onPress={() => void reopenPicking()}
                disabled={!reopenReason.trim() || acting !== null}
                style={[
                  styles.addBtn,
                  {
                    backgroundColor: '#b42318',
                    paddingHorizontal: 18,
                    opacity: reopenReason.trim() && acting === null ? 1 : 0.5,
                  },
                ]}
              >
                <Mono size={13} color="#fff">Reopen picking</Mono>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Create-return sheet (staff parity with web's CreateReturnDialog):
          per-line qty steppers capped at the remaining budget, per-line
          Restock/Scrap disposition, optional reason + notes. Submits to
          POST /api/v1/orders/[id]/returns; 4xx messages surface inline. */}
      <Modal
        visible={returnOpen}
        transparent
        animationType="slide"
        onRequestClose={() => {
          if (!returnSubmitting) setReturnOpen(false);
        }}
      >
        {/*
         * Backdrop is a SIBLING behind the sheet, not its parent. A Pressable
         * ancestor claims the touch on press-down and beats the ScrollView's
         * pan recogniser, so the return-lines list would not scroll until
         * something else took the responder first. Do not re-nest this card
         * inside the scrim. See add-order-items-sheet.tsx.
         */}
        <View style={{ flex: 1, justifyContent: 'flex-end' }}>
          <Pressable
            onPress={() => {
              if (!returnSubmitting) setReturnOpen(false);
            }}
            style={[
              StyleSheet.absoluteFill,
              {
                backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)',
              },
            ]}
          />
          <View
            style={{
              backgroundColor: c.card,
              borderTopLeftRadius: 18,
              borderTopRightRadius: 18,
              padding: 18,
              gap: 12,
            }}
          >
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>Create return</Body>
              <Pressable
                onPress={() => {
                  if (!returnSubmitting) setReturnOpen(false);
                }}
                hitSlop={8}
              >
                <X size={18} color={c.ink4} />
              </Pressable>
            </View>
            <Mono size={11} color={c.ink4}>
              Pick how many of each item is coming back. Restock adds it to inventory once the
              return is received; Scrap writes it off.
            </Mono>

            <ScrollView style={{ maxHeight: 380 }} contentContainerStyle={{ gap: 12 }}>
              {orderReturnable.map((l) => {
                const d = returnDraft[l.orderRequestLineId] ?? {
                  quantity: 0,
                  disposition: 'restock' as const,
                };
                const stepBtn = (label: string, delta: number, disabled: boolean) => (
                  <Pressable
                    onPress={() => stepReturnQty(l.orderRequestLineId, delta, l.quantityRemaining)}
                    disabled={disabled}
                    hitSlop={6}
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 8,
                      borderWidth: 1,
                      borderColor: c.hair,
                      alignItems: 'center',
                      justifyContent: 'center',
                      opacity: disabled ? 0.35 : 1,
                    }}
                  >
                    <Mono size={15} color={c.ink}>{label}</Mono>
                  </Pressable>
                );
                return (
                  <View
                    key={l.orderRequestLineId}
                    style={{ gap: 8, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: c.hair }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Body size={14} color={c.ink} numberOfLines={2}>{l.name}</Body>
                        <Mono size={10.5} color={c.ink4} style={{ marginTop: 2 }}>
                          {`${l.sku ? `${l.sku} · ` : ''}${l.quantityRemaining} of ${l.quantityFulfilled} returnable`}
                        </Mono>
                      </View>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        {stepBtn('−', -1, d.quantity <= 0 || returnSubmitting)}
                        <Mono size={15} color={c.ink} style={{ minWidth: 24, textAlign: 'center' }}>
                          {d.quantity}
                        </Mono>
                        {stepBtn('+', 1, d.quantity >= l.quantityRemaining || returnSubmitting)}
                      </View>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      {(['restock', 'scrap'] as const).map((disp) => {
                        const on = d.disposition === disp;
                        return (
                          <Pressable
                            key={disp}
                            onPress={() => setReturnDisposition(l.orderRequestLineId, disp)}
                            disabled={returnSubmitting}
                            style={{
                              paddingHorizontal: 10,
                              paddingVertical: 5,
                              borderRadius: 8,
                              borderWidth: 1,
                              borderColor: on ? c.ink : c.hair,
                              backgroundColor: on ? c.ink : 'transparent',
                            }}
                          >
                            <Mono size={10.5} color={on ? c.paper : c.ink3}>
                              {disp === 'restock' ? 'Restock' : 'Scrap'}
                            </Mono>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                );
              })}

              <View style={{ gap: 8 }}>
                <Eyebrow>REASON</Eyebrow>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {RETURN_REASONS.map((r) => {
                    const on = returnReason === r.value;
                    return (
                      <Pressable
                        key={r.value}
                        // Reason is optional server-side — tapping the active
                        // chip again clears it.
                        onPress={() => setReturnReason(on ? null : r.value)}
                        disabled={returnSubmitting}
                        style={{
                          paddingHorizontal: 10,
                          paddingVertical: 6,
                          borderRadius: 8,
                          borderWidth: 1,
                          borderColor: on ? c.ink : c.hair,
                          backgroundColor: on ? c.ink : 'transparent',
                        }}
                      >
                        <Mono size={10.5} color={on ? c.paper : c.ink3}>{r.label}</Mono>
                      </Pressable>
                    );
                  })}
                </View>
              </View>

              <View style={{ gap: 8 }}>
                <Eyebrow>NOTES</Eyebrow>
                <TextInput
                  value={returnNotes}
                  onChangeText={setReturnNotes}
                  placeholder="Optional notes for the approver"
                  placeholderTextColor={c.ink4}
                  multiline
                  editable={!returnSubmitting}
                  style={{
                    minHeight: 60,
                    borderWidth: 1,
                    borderColor: c.hair,
                    borderRadius: 10,
                    padding: 10,
                    color: c.ink,
                    fontFamily: FONT.mono,
                    fontSize: 13,
                    textAlignVertical: 'top',
                  }}
                />
              </View>
            </ScrollView>

            {returnError ? (
              <Mono size={11} color="#b42318">{returnError}</Mono>
            ) : null}

            <Pressable
              onPress={() => void submitReturn()}
              disabled={returnSubmitting}
              style={[styles.addBtn, { backgroundColor: c.ink, opacity: returnSubmitting ? 0.6 : 1 }]}
            >
              {returnSubmitting ? (
                <ActivityIndicator color={c.paper} />
              ) : (
                <Mono size={13} color={c.paper}>Submit return</Mono>
              )}
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Add-items sheet (parity with the web add-items dialog): warehouse-
          constrained item search with a per-item quantity, submitted to
          POST /api/v1/orders/[id]/lines. */}
      {order ? (
        <AddOrderItemsSheet
          visible={addOpen}
          onClose={() => setAddOpen(false)}
          orderId={order.id}
          organizationId={orgId}
          warehouseId={order.warehouseId}
          existingItemIds={existingItemIds}
          onAdded={(res) => void handleItemsAdded(res)}
          onRequestReload={() => void load()}
        />
      ) : null}

      {/* Line-edit sheet — the other half of adding: change a line's quantity
          or take it off the order entirely. Submits to the PATCH / DELETE
          twins on the same route, which re-assert every gate and every floor.
          `visible` is driven by whether the line still RESOLVES, so a line
          removed underneath us (or an order that reloaded without it) closes
          the sheet instead of leaving it addressing a row that is gone. */}
      {order ? (
        <EditOrderLineSheet
          visible={editLine !== null}
          onClose={() => setEditLineId(null)}
          orderId={order.id}
          line={editLine}
          orderStatus={order.status}
          totalLines={order.lines.length}
          onChanged={handleLineChanged}
          onRemoved={handleLineRemoved}
          onRequestReload={() => void load()}
        />
      ) : null}

      {order?.signatureToken ? (
        <SignaturePadModal
          visible={signatureModalVisible}
          onClose={() => setSignatureModalVisible(false)}
          onSuccess={() => void load()}
          signatureToken={order.signatureToken}
          defaultName={order.requesterName ?? ''}
          defaultEmail={order.requesterEmail ?? ''}
        />
      ) : null}

      {/* Driver picker for assign / reassign delivery. */}
      <Modal visible={driverOpen} transparent animationType="slide" onRequestClose={() => setDriverOpen(false)}>
        {/*
         * Backdrop is a SIBLING behind the sheet, not its parent. A Pressable
         * ancestor claims the touch on press-down and beats the ScrollView's
         * pan recogniser, so the driver list would not scroll until something
         * else took the responder first. Do not re-nest this card inside the
         * scrim. See add-order-items-sheet.tsx.
         */}
        <View style={{ flex: 1, justifyContent: 'flex-end' }}>
          <Pressable
            onPress={() => setDriverOpen(false)}
            style={[
              StyleSheet.absoluteFill,
              {
                backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)',
              },
            ]}
          />
          <View
            style={{ backgroundColor: c.card, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18, gap: 10 }}
          >
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>Assign delivery</Body>
              <Pressable onPress={() => setDriverOpen(false)} hitSlop={8}>
                <X size={18} color={c.ink4} />
              </Pressable>
            </View>
            {drivers === null ? (
              <ActivityIndicator color={c.ink} style={{ marginVertical: 24 }} />
            ) : drivers.length === 0 ? (
              <Mono size={12} color={c.ink4} style={{ paddingVertical: 16 }}>No team members found.</Mono>
            ) : (
              <ScrollView style={{ maxHeight: 360 }}>
                {drivers.map((d) => {
                  const current = d.id === order?.assignedDeliveryUserId;
                  return (
                    <Pressable
                      key={d.id}
                      onPress={() => {
                        setDriverOpen(false);
                        void act({ action: 'assign_delivery', deliveryUserId: d.id }, 'assign');
                      }}
                      style={{ paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.hair }}
                    >
                      <Body size={14} color={c.ink}>
                        {d.name}
                        {current ? '  · current' : ''}
                      </Body>
                      <Mono size={11} color={c.ink4}>{d.email}</Mono>
                    </Pressable>
                  );
                })}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topbar: { paddingHorizontal: 12, paddingTop: 8, flexDirection: 'row' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    height: 44,
    borderRadius: 10,
    justifyContent: 'center',
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 },
  tile: { width: '31%', borderRadius: 10, borderWidth: 1, overflow: 'hidden' },
  tileImg: { width: '100%', height: 90 },
  tileFoot: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 6 },
});
