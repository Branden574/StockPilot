import { type Href, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { useNetworkState } from 'expo-network';
import {
  ArrowLeft,
  Camera,
  ImagePlus,
  Landmark,
  PenLine,
  Trash2,
  Truck,
  WifiOff,
  X,
} from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ApprovePartialSheet } from '@/components/approve-partial-sheet';
import { DigitalPick } from '@/components/digital-pick';
import { OrderLineReadiness } from '@/components/order-line-readiness';
import { OrderNeededByCard } from '@/components/order-needed-by-card';
import { OrderReadinessSummary } from '@/components/order-readiness-summary';
import { ReviseNeededBySheet } from '@/components/revise-needed-by-sheet';
import { DraftShortfallPoSheet } from '@/components/draft-shortfall-po-sheet';
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
  orderLineShortFix,
  orderShortfallNotice,
  orderShortLinesFinalNote,
  type EditableOrderLine,
  type LineQuantityResult,
  type LineRemovedResult,
} from '@/components/edit-order-line';

import { CachedImage } from '@/components/ui/cached-image';
import { Card } from '@/components/ui/card';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { resizeForUpload } from '@/lib/image-resize';
import { profileFromEmbed, resolveRequesterLabel } from '@/lib/requester-label';
import { signerEmailDefault } from '@/lib/deleted-user-labels';
import {
  claimPicking,
  commitPartialFulfilment,
  createOrderReturn,
  holdOrderStock,
  listOrderDrivers,
  releasePicking,
  transitionOrder,
  type OrderAction,
  type OrderDriver,
} from '@/lib/orders-api';
import { mintReturnKey } from '@/lib/returns-api';
import {
  buildReturnPayload,
  describeLineFulfilment,
  describeReturnLine,
  describeReturnMeta,
  formatOrderReturnSummary,
  initialReturnDraft,
  ORDER_RETURN_SUMMARY_NOTE,
  ORDER_RETURNS_SELECT,
  orderReturnSummary,
  parseOrderReturns,
  pendingReturnQuantities,
  RETURN_REASONS,
  returnableLines,
  returnHandle,
  returnLineItemName,
  returnStatusLabel,
  shouldLoadOrderReturns,
  shouldShowReturnsSection,
  type OrderReturnView,
  type RawOrderReturnRow,
  type ReturnDraftLine,
  type ReturnReasonCode,
} from '@/lib/order-returns';
import { extractApiErrorMessage } from '@/lib/po-import-approve';
import { fetchOrderSignatureImage } from '@/lib/order-signature-image';
import {
  ORDER_OFFLINE_NOTHING_LOADED_COPY,
  orderReadinessAudience,
  orderStockCheckFor,
  orderViewAsOf,
  readOrderReadiness,
  readOrgTimeZone,
  readinessPermissionsFor,
  recalledOrderView,
  reconcileReadiness,
  rememberOrderView,
  shouldReadReadiness,
} from '@/lib/order-readiness';
import {
  canOfferNeededByChange,
  neededByCardValue,
  neededBySheetOpening,
  needsNeededByZoneRead,
  showNeededByCard,
} from '@/lib/order-needed-by';
import { readDestinationWarehouseScope } from '@/lib/holdings-elsewhere';
import {
  readShortfallSupplierNames,
  shortfallPoOffer,
  shortfallSheetOpening,
  type ShortfallDraftRoute,
  type ShortfallSupplierNameMap,
} from '@/lib/order-shortfall-po';
import { partialSheetView, runPartialFulfilment } from '@/lib/order-partial';
import { orderPutAwayView, putAwayAccessFor, stagingPutAwayRoute } from '@/lib/order-put-away';
import { isOfflineState } from '@/lib/exceptions-api';
import { departureConfirmButtons, orderDepartureRisk } from '@/lib/order-departure';
import { focusScrollY, orderScreenFocus } from '@/lib/order-focus';
import { orderManagerActions } from '@/lib/order-manager-actions';
import {
  describeHoldError,
  HOLD_REFUSED_TITLE,
  holdTopUpNotice,
  withHoldNotice,
} from '@/lib/order-hold';
import { readErrorMessage } from '@/lib/id-batches';
import { orderItemsEyebrow } from '@/lib/order-items-eyebrow';
import { orderHeaderEyebrow } from '@/lib/orders-list';
import { useEnabledModules } from '@/lib/enabled-modules';
import {
  BLOCKED_HEADLINE as DR_BLOCKED_HEADLINE,
  BLOCKED_RETRY_MESSAGE as DR_BLOCKED_RETRY,
  COPY_HELPER_TEXT as DR_COPY_HELPER,
  DUPLICATE_WARNING as DR_DUPLICATE_WARNING,
  HONESTY_NOTICE as DR_HONESTY_NOTICE,
  OVERSIZED_MESSAGE as DR_OVERSIZED,
  canRequestDelivery,
  deliveryRoutingFromOrgRow,
  deliverySuccessMessageFor,
  isMissingEmailRoutingColumn,
  needsDeliveryRequestData,
  openDeliveryRequestDraft,
  parseCharterAddress,
  prepareOrderDeliveryRequest,
  recipientsHelperText,
  shouldConfirmBeforeOpening,
  shouldShowBlockedNotice,
  shouldShowCondensedNotice,
  shouldWarnDuplicateDrafts,
  type DeliveryOpenResult,
  type DeliveryRequestOrderData,
} from '@/lib/delivery-request-actions';
import { nativeOutlookAvailable, type OutlookPlatform } from '@/lib/outlook-transport';
import {
  approveShortNotice,
  availableOrderActions,
  can,
  condensedNoticeText,
  deliveryRecipientsForRouting,
  describeHoldResult,
  formatOrderNumber,
  derivePickingStatus,
  HOLD_AVAILABLE_STOCK_LABEL,
  orderLineItemName,
  orderReadinessPhase,
  orderStockGates,
  PARTIAL_ACTION_TITLE,
  previewPartialFulfilment,
  READINESS_NEEDS_CONNECTION_COPY,
  RETURNS_COPY,
  readinessOfflineCopy,
  shouldOfferHoldStock,
  UNPICKED_SHORTFALL_TITLE,
  type DepartureAction,
  type FulfillmentType,
  type OrderReadinessResult,
  type PartialAction,
  type PartialPreview,
  type OrderStatus,
  type ShortfallPoView,
  missingShortfallSupplierIds,
  shortfallSupplierIds,
  type OrgEmailRoutingReadState,
  type Role,
} from '@stockpilot/core';
import { getOrderShipment, type OrderShipment } from '@/lib/shipping-api';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { UploadBatchProgress, uploadFileToBucket } from '@/lib/storage-upload';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/use-workspace';
import { ACCENT, capTo, FONT, TYPE_CEILING } from '@/lib/theme';
import { MIN_TAP } from '@/components/item-verification-card';
import { shouldStackRow } from '@/lib/dynamic-type-layout';
import { exceptionSheetLayout } from '@/lib/exception-sheet-layout';
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

/**
 * The only actions that still work offline (every other one needs a
 * connection): copying the delivery request text changes nothing anywhere.
 */
const WORKS_OFFLINE = new Set(['delivery-copy']);

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
  /** order_requests.requester_deleted_at (0388): the requester deleted their
   *  account, so their kept address is never the signer default (A3). */
  requesterDeletedAt: string | null;
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
  /**
   * The org's resolved delivery-request email routing (per-org email
   * routing, migration 0337), read off the same `organizations` row as the
   * timezone. `{ state: 'unset' }` when the row was never read (pickup /
   * terminal orders) — the gate is already false there. 'fallback' ONLY when
   * the `email_routing` column does not exist yet (pre-migration deploy
   * window: compiled constants, byte-identical to pre-feature behavior).
   */
  deliveryRouting: OrgEmailRoutingReadState;
  /** Line roll-ups for the backorder progress card. requested = ordered,
   *  fulfilled = provided to the customer (shipped at hand-over). */
  totalRequested: number;
  totalFulfilled: number;
  /** ORDER READINESS (F2-1): core's assessment of order_readiness_facts,
   *  read alongside this order at a to_pick status for the readiness
   *  audience, and for a manager (Approve partial and Resume are gated on
   *  it). Null: not read. A failed read is `{ state: 'failed' }`, never an
   *  empty or green answer, and core orderStockGates turns it into what the
   *  stock-dependent actions render (see lib/order-readiness.ts). */
  readiness: OrderReadinessResult | null;
  /** When the phone received this view (ISO): the offline banner's time when
   *  readiness was not read. */
  receivedAt: string;
  /** The order's returns (RMAs) with their lines — the reverse of the returns
   *  page's "Against order" link. Empty on any non-returnable status (never
   *  read there) and when nothing was ever returned. Decisions about what they
   *  mean live in lib/order-returns (shared with web through core). */
  returns: OrderReturnView[];
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

/** What the screen last showed of an order, kept in memory for the app
 *  session (lib/order-readiness.ts rememberOrderView) so that offline it can
 *  show how the order looked, with its time, instead of an error. */
interface RememberedOrder {
  order: OrderHeader;
  attachments: Attachment[];
  attachmentsError: string | null;
  shipment: OrderShipment | null;
}

export default function OrderDetail() {
  const { id, focus } = useLocalSearchParams<{ id: string; focus?: string }>();
  // "Review and approve" from the storefront's success screen (PO-4) opens
  // this screen at its actions section, once (lib/order-focus.ts).
  const scrollRef = React.useRef<ScrollView | null>(null);
  const focusDone = React.useRef(false);
  const onActionsLayout = React.useCallback(
    (e: LayoutChangeEvent) => {
      if (focusDone.current || orderScreenFocus(focus) !== 'actions') return;
      const y = focusScrollY(e.nativeEvent.layout.y);
      if (y === null) return;
      focusDone.current = true;
      scrollRef.current?.scrollTo({ y, animated: true });
    },
    [focus],
  );
  const router = useRouter();
  const { user } = useAuth();
  const { c, mode } = useTheme();

  const { activeOrgId: orgId, activeRole: role } = useWorkspace();
  const [loadedOrder, setOrder] = React.useState<OrderHeader | null>(null);
  // Why the order did not load. The header or the lines read FAILED, which is
  // not "Order not found." and not an order with no items: an empty lines list
  // would show "This order has no items yet.", zero totals, and still offer
  // Add items, pick slips, the delivery request email and returns built from
  // nothing. Set (or cleared) by EVERY load that completes.
  const [loadErrorState, setLoadError] = React.useState<string | null>(null);
  // A reload started from a "Try again" button, so the button can be disabled
  // while it runs (a failing read retries for several seconds before its
  // error shows).
  const [retrying, setRetrying] = React.useState(false);
  const [loadedAttachments, setAttachments] = React.useState<Attachment[]>([]);
  const [loadedAttachmentsError, setAttachmentsError] = React.useState<string | null>(null);
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
  const [loadedShipment, setShipment] = React.useState<OrderShipment | null>(null);

  // OFFLINE (F2-1): the live network state (expo-network, the rule sync.ts
  // applies: only a definite "not connected" counts). Offline nothing is
  // asked, and the view is DERIVED, never fetched: the order on screen stays
  // under a banner naming when it was loaded; a screen opened offline (or
  // whose last read failed) shows what this session last loaded of it
  // (memory only, lib/order-readiness.ts), or says it needs a connection.
  // Every action is disabled with "Needs a connection.".
  const offline = isOfflineState(useNetworkState());
  const userId = user?.id ?? null;
  const recalled = React.useMemo(
    () =>
      offline && loadedOrder === null
        ? recalledOrderView<RememberedOrder>(userId, orgId, id ?? null)
        : null,
    [offline, loadedOrder, userId, orgId, id],
  );
  const order = loadedOrder ?? recalled?.view.order ?? null;
  const attachments = recalled ? recalled.view.attachments : loadedAttachments;
  const attachmentsError = recalled ? recalled.view.attachmentsError : loadedAttachmentsError;
  const shipment = recalled ? recalled.view.shipment : loadedShipment;
  // Why the order is not shown. Offline with nothing to show, it says so
  // (never "Order not found." and never a stale read error).
  const loadError =
    offline && order === null ? ORDER_OFFLINE_NOTHING_LOADED_COPY : loadErrorState;

  // Create-return sheet state (staff parity with the web CreateReturnDialog).
  const [returnOpen, setReturnOpen] = React.useState(false);
  // The sheet's size at any text size (returns review, AX5 walk): bounded by
  // the screen with its header and Submit pinned and the rest scrolling, the
  // line rows stacked at large text (the exception sheets' layout).
  const { height: windowHeight, fontScale } = useWindowDimensions();
  const sheetInsets = useSafeAreaInsets();
  const returnSheetLayout = exceptionSheetLayout({ windowHeight, availableHeight: null, topInset: sheetInsets.top });
  const returnRowsStacked = shouldStackRow(fontScale);
  const [returnDraft, setReturnDraft] = React.useState<Record<string, ReturnDraftLine>>({});
  const [returnReason, setReturnReason] = React.useState<ReturnReasonCode | null>(null);
  const [returnNotes, setReturnNotes] = React.useState('');
  const [returnSubmitting, setReturnSubmitting] = React.useState(false);
  const [returnError, setReturnError] = React.useState<string | null>(null);
  // Returns RX-1: one idempotency key per opened sheet (a resend replays the
  // same RMA), and "The item is here", off by default.
  const [returnKey, setReturnKey] = React.useState<string | null>(null);
  const [returnItemIsHere, setReturnItemIsHere] = React.useState(false);

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
  // F2-3: the approve-partial / resume sheet, with the preview it opened on.
  // Frozen at open: the result is compared with what the reader looked at,
  // and a reload under the open sheet (the commit reads the order again)
  // never swaps the numbers in front of them.
  const [partial, setPartial] = React.useState<{
    action: PartialAction;
    preview: PartialPreview;
  } | null>(null);
  const [signatureModalVisible, setSignatureModalVisible] = React.useState(false);
  // F2-4: the needed-by sheet, with what it opened on: the order, the org's
  // zone (checked when it opened) and the needed-by EXACTLY as read, the
  // value the save's stale check compares. Frozen at open: a reload behind
  // the sheet never moves the value it is replacing.
  const [neededBySheet, setNeededBySheet] = React.useState<{
    orderId: string;
    orderLabel: string | null;
    timeZone: string;
    startNeededBy: string | null;
    orderStatus: string;
  } | null>(null);
  // F2-5: the draft-PO sheet, with what it opened on: the short items from
  // the readiness the screen showed (frozen: a reload behind the sheet never
  // swaps the rows in front of the person) and the suppliers' names.
  const [shortfallSheet, setShortfallSheet] = React.useState<{
    orderId: string;
    orderLabel: string | null;
    view: ShortfallPoView;
    notice: string | null;
    supplierNames: ShortfallSupplierNameMap;
    timeZone: string | null;
  } | null>(null);

  // Role rank. Since slice D (0390) it decides only what the server still
  // decides by role: attachments, the shortfall PO drafter, picking overrides
  // and the paper signature. Approval-class actions follow the effective
  // orders:approve (rpApprove, managerActions below).
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

  // The viewer's readiness permissions, as three booleans `load` depends on:
  // they change only when an override changes what this viewer sees (the
  // effective set loads after the first render, and with the static
  // defaults it normally agrees), and then the order is read again.
  const {
    canApproveOrders: rpApprove,
    canUpdateItems: rpItems,
    canManagePurchaseOrders: rpBuy,
  } = readinessPermissionsFor(role, permissions);

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
            // The server's remaining: pending (unapplied, live) returns count.
            pendingReturnQuantities(order.returns),
          )
        : [],
    [order],
  );
  const canReadReturns =
    role !== null &&
    enabledModules.has('returns') &&
    (can({ role: role as Role, permissions }, 'returns:read') ||
      can({ role: role as Role, permissions }, 'returns:manage'));
  const showCreateReturn =
    canManageReturns && enabledModules.has('returns') && orderReturnable.length > 0;
  // Order-level returned roll-up (SO-000085) — null when nothing was ever
  // returned, so the summary card renders nothing and the screen is unchanged.
  // The per-line number is `returned_quantity` (the durable 0153 budget the
  // create-return math above already reads); the shared helper only sums it.
  const returnSummary = React.useMemo(
    () =>
      order
        ? orderReturnSummary(
            order.lines.map((l) => ({ fulfilled: l.fulfilled, returned: l.returned })),
          )
        : null,
    [order],
  );

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
    // Per-org email routing (migration 0337): unset/invalid routing hides
    // the action entirely — same cell of the fallback matrix as the web
    // order page, decided in the tested lib, not here.
    routing: order?.deliveryRouting ?? { state: 'unset' },
  });
  // The branded recipients the draft will compose with — null exactly when
  // the gate above refuses for routing reasons. The compiled constants are
  // reachable ONLY through the pre-migration 'fallback' state.
  const deliveryRecipients = React.useMemo(
    () => (order ? deliveryRecipientsForRouting(order.deliveryRouting) : null),
    [order],
  );
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
      deliveryOrderData && showDeliveryRequest && deliveryRecipients
        ? prepareOrderDeliveryRequest(deliveryOrderData, deliveryRecipients, nativeOutlook)
        : null,
    [deliveryOrderData, showDeliveryRequest, deliveryRecipients, nativeOutlook],
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
    // F2-2: what the automatic hold did for the added items, core's words; a
    // failed hold says so and points to Hold available stock (never dropped).
    Alert.alert('Items added', withHoldNotice(addedSummary(res), holdTopUpNotice(res.hold, 'added')));
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
    // F2-2: a raise is held like an add (null for a lowering: nothing said).
    void afterLineEdit(
      res.pickSlipStale,
      'Quantity updated',
      withHoldNotice(lineQuantitySummary(line, res), holdTopUpNotice(res.hold, 'raised')),
    );
  }

  /**
   * F2-2: the departure confirm's "Fix the order" points to the first short
   * line, where its fixes are (decision D18). Opens that line's sheet when
   * the viewer may change lines and the line is on screen; false otherwise
   * (the confirm then simply closes). The digital pick's completion confirm
   * does not come here: its Review focuses the line's pick quantity, as on
   * the web.
   */
  function openShortLine(lineId: string | null): boolean {
    if (!lineId || !canEditItems || offline || !order) return false;
    if (!order.lines.some((l) => l.orderRequestLineId === lineId)) return false;
    setEditLineId(lineId);
    return true;
  }

  /**
   * F2-2 (the SO-000100 slice): before the order is staged, sent out for
   * delivery or signed for, say which lines are not fully picked (core
   * describeDepartureRisk, the web page's words). "Fix the order" opens the
   * first short line; "Send it anyway" (or its staging and signature twins)
   * goes ahead. With nothing short the step runs at once, as before. UI only:
   * the server stays permissive (shipping short is the backorder model).
   */
  function confirmDeparture(action: DepartureAction, proceed: () => void) {
    const risk = order ? orderDepartureRisk(order, action) : null;
    if (!risk) {
      proceed();
      return;
    }
    Alert.alert(
      risk.title,
      risk.message,
      departureConfirmButtons(risk, { onFix: openShortLine, onProceed: proceed }),
    );
  }

  /**
   * F2-2 "Hold available stock": tops the order's holds up to what its lines
   * still owe, as far as free stock allows (hold_order_stock, 0378). Says
   * what was held and what is still short (core describeHoldResult), or why
   * nothing was (the server's sentence, never raw text), then reads the order
   * again so each line's hold is current.
   */
  async function holdStock() {
    if (!id || acting !== null) return;
    setActing('hold');
    try {
      const result = await holdOrderStock(id);
      Alert.alert(HOLD_AVAILABLE_STOCK_LABEL, describeHoldResult(result));
    } catch (e) {
      Alert.alert(HOLD_REFUSED_TITLE, describeHoldError(e));
    } finally {
      setActing(null);
    }
    await load();
  }

  /**
   * F2-3: Approve partial and Resume fulfillment open a preview first (core
   * previewPartialFulfilment over the readiness this screen shows: per item,
   * never per line), frozen when the sheet opens.
   */
  function openPartialSheet(action: PartialAction) {
    if (acting !== null || !order) return;
    setPartial({ action, preview: previewPartialFulfilment(order.readiness, action) });
  }

  /**
   * F2-3: the sheet's confirm. The existing transition, unchanged; then
   * readiness read again beside the screen's own reload, and the message
   * computed from THAT read (the order's own holds now), never from the
   * preview (lib/order-partial.ts runPartialFulfilment). A refusal rejects:
   * the sheet says it in place and stays open.
   */
  async function confirmPartial(): Promise<void> {
    if (!id || !partial) return;
    const { action, preview } = partial;
    setActing(action === 'approve_partial' ? 'approve-partial' : 'resume');
    try {
      const result = await runPartialFulfilment(
        {
          commit: commitPartialFulfilment,
          reread: (orderId) => readOrderReadiness(supabase, orderId),
          reload: load,
        },
        id,
        action,
        preview,
      );
      setPartial(null);
      Alert.alert(PARTIAL_ACTION_TITLE[action], result.text);
    } finally {
      setActing(null);
    }
  }

  /**
   * F2-3: "Put away" (a readiness line, or "Put away N items" on the card)
   * opens the Staging tab filtered to those items, naming this order. The
   * screen reads its readiness again when it is back in focus.
   */
  function openPutAway(itemIds: readonly string[]) {
    if (!order || offline || itemIds.length === 0) return;
    router.push(stagingPutAwayRoute(order.id, itemIds));
  }

  /**
   * F2-4 "Change" beside the needed-by: reads the org's zone (unless this
   * load already has it) and the viewer's writable warehouses together, then
   * opens the sheet, or says in core's words why it cannot (the zone could
   * not be read, or no write access to the order's warehouse). Nothing is
   * written here, and nothing here opens an email.
   */
  async function openNeededBySheet() {
    if (!order || !orgId || offline || acting !== null) return;
    setActing('needed-by');
    try {
      const [rawZone, scope] = await Promise.all([
        order.orgTimezone ?? readOrgTimeZone(supabase, orgId),
        readDestinationWarehouseScope(supabase, { role, organizationId: orgId, userId }),
      ]);
      const opening = neededBySheetOpening({ rawZone, scope, warehouseId: order.warehouseId });
      if (!opening.ok) {
        Alert.alert(opening.title, opening.message);
        return;
      }
      setNeededBySheet({
        orderId: order.id,
        orderLabel: order.orderNumber ? formatOrderNumber(order.orderNumber) : null,
        timeZone: opening.timeZone,
        startNeededBy: order.neededBy,
        orderStatus: order.status,
      });
    } finally {
      setActing(null);
    }
  }

  /**
   * F2-5 "Draft PO for what is short": reads readiness again and the names of
   * the suppliers the shown rows name (by id, archived ones included) together
   * (the web dialog's reads on open; one round trip, never serial), then
   * opens the sheet on the fresh rows, saying so when they moved (the screen
   * reloads behind it then). A supplier the fresh rows name beyond those is
   * read after (rare). A failed readiness read opens on the rows the screen
   * shows; a failed names read says "couldn't be loaded" (core). Nothing is
   * written here, and nothing opens an email.
   */
  async function openShortfallSheet() {
    if (!order || !orgId || offline || acting !== null) return;
    const shown = shortfallSheetOpening(order.readiness, null);
    if (!shown) return;
    setActing('shortfall-po');
    try {
      const [fresh, firstNames] = await Promise.all([
        readOrderReadiness(supabase, order.id),
        readShortfallSupplierNames(supabase, { organizationId: orgId, supplierIds: shortfallSupplierIds(shown.view) }),
      ]);
      const opening = shortfallSheetOpening(order.readiness, fresh);
      if (!opening) return;
      let supplierNames = firstNames;
      const more = supplierNames ? missingShortfallSupplierIds(opening.view, supplierNames) : [];
      if (supplierNames && more.length > 0) {
        const extra = await readShortfallSupplierNames(supabase, { organizationId: orgId, supplierIds: more });
        supplierNames = extra ? new Map([...supplierNames, ...extra]) : null;
      }
      setShortfallSheet({
        orderId: order.id,
        orderLabel: opening.view.orderNumber,
        view: opening.view,
        notice: opening.notice,
        supplierNames,
        timeZone: order.orgTimezone,
      });
      if (opening.changed) void load();
    } finally {
      setActing(null);
    }
  }

  /** F2-5: a created draft opens on the phone's PO screen (read-only for a draft). */
  function openShortfallDraft(route: ShortfallDraftRoute) {
    setShortfallSheet(null);
    router.push(route);
  }

  /** F2-4: the server changed (or kept) the date: say what it did, read the order again. */
  async function handleNeededBySaved(title: string, message: string) {
    setNeededBySheet(null);
    Alert.alert(title, message);
    await load();
  }

  function handleLineRemoved(line: EditableOrderLine, res: LineRemovedResult) {
    void afterLineEdit(res.pickSlipStale, 'Item removed', lineRemovedSummary(line, res));
  }

  function openReturnSheet() {
    setReturnDraft(initialReturnDraft(orderReturnable));
    setReturnReason(null);
    setReturnNotes('');
    setReturnError(null);
    setReturnKey(mintReturnKey());
    setReturnItemIsHere(false);
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
    if (!id || returnSubmitting || offline) return;
    const payload = buildReturnPayload({
      lines: orderReturnable,
      draft: returnDraft,
      reasonCode: returnReason,
      notes: returnNotes,
      idempotencyKey: returnKey,
      itemIsHere: returnItemIsHere,
    });
    if (!payload.ok) {
      setReturnError(payload.error);
      return;
    }
    setReturnSubmitting(true);
    setReturnError(null);
    try {
      const created = await createOrderReturn(id, payload.body);
      setReturnOpen(false);
      if (canReadReturns) {
        // The RMA's workbench is where it is approved (and, with "The item
        // is here", approved and received at once).
        router.push(`/returns/${created.id}` as Href);
      } else {
        Alert.alert('Return created', 'Return created — pending approval.');
      }
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


  // Returns what it set, so `load` can remember the whole view for offline.
  const loadAttachments = React.useCallback(async (): Promise<{
    attachments: Attachment[];
    error: string | null;
  } | null> => {
    if (!orgId || !id) return null;
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
    const next: Attachment[] = rows.map((r) => ({
      id: r.id as string,
      storagePath: r.storage_path as string,
      kind: (r.kind as string | null) ?? 'other',
      contentType: (r.content_type as string | null) ?? null,
      fileName: (r.file_name as string | null) ?? null,
      url: signed.get(r.storage_path as string) ?? null,
      createdAt: r.created_at as string,
    }));
    setAttachments(next);
    return { attachments: next, error: error ? error.message : null };
  }, [orgId, id]);

  const load = React.useCallback(async () => {
    if (!orgId || !id) return;
    if (offline) {
      // OFFLINE: nothing is asked. Every read would fail, and a failed header
      // read would replace the order on screen with an error. The view is
      // derived in render (see `recalled`); it loads again on reconnect
      // (`offline` is a dependency, so the focus effect re-runs). `loading`
      // is left as it is: a screen opened offline stays "loading" underneath
      // (the render shows the remembered order or the offline sentence), so
      // on reconnect it shows the spinner until the order arrives, never a
      // flash of "Order not found.".
      return;
    }
    const { data, error: headerError, status: headerStatus } = await supabase
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
         requester_deleted_at, signed_by_name, signed_at, created_at, warehouse_id, pick_slip_generated_at,
         assigned_delivery_user_id, assigned_picker_id, fulfillment_type, signature_token,
         needed_by, notes, delivery_charter_id,
         warehouse:warehouses!warehouse_id (name),
         requester:user_profiles!requester_user_id (full_name, email),
         picker:user_profiles!assigned_picker_id (full_name, email)`,
      )
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle();
    // ORDER READINESS (F2-1). Started as soon as the header says the order's
    // status and requester, so it runs alongside the lines read and every
    // read after it; awaited below, where the stock check used to be. Only
    // at a to_pick status, and only for someone who sees it or a manager
    // (shouldReadReadiness); everyone else makes no read. Neither read ever
    // throws: a failure is `{ state: 'failed' }` and an unread zone is null.
    const headerForReadiness = data as Record<string, unknown> | null;
    const readinessRead =
      headerForReadiness &&
      shouldReadReadiness({
        status: (headerForReadiness.status as string | null) ?? null,
        audience: orderReadinessAudience(
          { canApproveOrders: rpApprove, canUpdateItems: rpItems, canManagePurchaseOrders: rpBuy },
          userId,
          (headerForReadiness.requester_user_id as string | null) ?? null,
        ),
        role,
      })
        ? Promise.all([readOrderReadiness(supabase, id), readOrgTimeZone(supabase, orgId)])
        : null;
    // F2-4: the needed-by card prints the date in the org's zone. Read beside
    // the lines (no serial round trip) when the order has a needed-by and no
    // other read of this load brings the zone: readiness above, or a live
    // delivery order's org-row read below (the same predicate as there). An
    // order with no needed-by reads nothing. Never throws: unread is null.
    const neededByZoneRead =
      headerForReadiness &&
      needsNeededByZoneRead({
        neededBy: (headerForReadiness.needed_by as string | null) ?? null,
        readinessReadsZone: readinessRead !== null,
        deliveryReadsZone: needsDeliveryRequestData({
          status: (headerForReadiness.status as string | null) ?? null,
          fulfillmentType: (headerForReadiness.fulfillment_type as string | null) ?? null,
        }),
      })
        ? readOrgTimeZone(supabase, orgId)
        : null;
    // Order lines — both the per-line ITEMS list (a manager must SEE what's
    // being ordered before approving) and the backorder roll-ups. In
    // (created_at, id) order: readiness numbers its lines the same way, and
    // an unordered read shuffled the list after a line was edited.
    const { data: lineRows, error: linesError, status: linesStatus } = await supabase
      .from('order_request_lines')
      .select(
        // quantity_picked is read for the line-edit floors: it is what a picker
        // has STAGED but not yet handed over, and lowering a request beneath it
        // (or removing the line) would strand that physical stock.
        'id, item_id, created_at, quantity_requested, quantity_fulfilled, quantity_picked, returned_quantity, item:inventory_items(name, sku, charter_id, charter:charters!charter_id(name, code))',
      )
      .eq('order_request_id', id)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    // FAIL CLOSED on either read. The header used to fall through to "Order
    // not found." and the lines to an order with no items; both are claims
    // about the order made from an error. Nothing below runs on a failure:
    // the screen shows the error and a Try again instead of the order.
    // readErrorMessage: an empty error body (a gateway 502) has an empty
    // message, which would otherwise fall through to "Order not found.".
    const readFailure = headerError
      ? readErrorMessage(headerError, headerStatus)
      : linesError
        ? readErrorMessage(linesError, linesStatus)
        : null;
    if (readFailure !== null) {
      console.warn('order load', readFailure);
      setOrder(null);
      setLoadError(readFailure);
      setLoading(false);
      return;
    }
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

    // The order's RETURNS (owner report, SO-000085: a delivered order with a
    // closed RMA read as a clean 1/1/1 with nothing about the return). Same
    // read the web order page performs — returns + embedded return_lines,
    // RLS-scoped (returns_select / return_lines_select = is_org_member), so
    // every org member sees the order's own history regardless of the returns
    // module switch or returns:read (those only gate the returns SCREENS,
    // which the phone does not have — this list renders inline). Gated on the
    // status only: nothing but a completed / legacy-delivered order can carry
    // a return (cancel refuses completed, 0155). A failed read leaves []: a
    // returns hiccup must never blank the order.
    let orderReturns: OrderReturnView[] = [];
    const headerStatusForReturns =
      ((data as Record<string, unknown> | null)?.status as string | null) ?? null;
    if (shouldLoadOrderReturns(headerStatusForReturns)) {
      const { data: returnRows } = await supabase
        .from('returns')
        .select(ORDER_RETURNS_SELECT)
        .eq('organization_id', orgId)
        .eq('order_request_id', id)
        .order('created_at', { ascending: true });
      orderReturns = parseOrderReturns((returnRows ?? []) as unknown as RawOrderReturnRow[]);
    }

    // NOTE (2026-07-22): the per-order stock_reservations read that used to sit
    // here is GONE. It existed only to mirror removeLine's reservation refusal,
    // and that refusal was the production defect: a reservation is a soft hold
    // minted for every line at APPROVAL, so it blocked removal on orders where
    // nothing had been picked. The service now re-syncs the hold instead of
    // refusing, nothing else on this screen read the result, and the query
    // silently discarded its own error — so it is deleted rather than kept as a
    // round trip nobody consumes.
    //
    // The readiness read started above lands here, where the stock check used
    // to be (lib/order-stock-check.ts, deleted: its own on-hand and
    // reservation reads and its copy of the stock flags). Readiness now feeds
    // Approve partial and Resume through core (readinessStockFlags, then
    // orderStockGates, the web page's own gates). The answer must describe
    // the order on screen: a status or line set that moved between the reads
    // is `failed` (reconcileReadiness), never a mix of two orders.
    const readinessAnswer = readinessRead ? await readinessRead : null;
    const readiness: OrderReadinessResult | null = readinessAnswer
      ? reconcileReadiness(readinessAnswer[0], {
          status: ((data as Record<string, unknown> | null)?.status as string | null) ?? '',
          lineIds: rows.map((l) => l.id),
        })
      : null;
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
    // Never read -> 'unset': the display gate is false for these rows anyway
    // (needsDeliveryRequestData is the first check), so no compose surface
    // ever consumes this default.
    let deliveryRouting: OrgEmailRoutingReadState = { state: 'unset' };
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
      const [charterRes, orgResFirst] = await Promise.all([
        charterId
          ? supabase
              .from('charters')
              .select('id, name, code, address')
              .eq('organization_id', orgId)
              .eq('id', charterId)
              .maybeSingle()
          : Promise.resolve({ data: null }),
        // Per-org email routing (migration 0337) rides the same org-row read
        // as the timezone — one more column, zero extra round trips, RLS
        // member read (the TO/CC are printed in the email UI; not secrets).
        supabase.from('organizations').select('timezone, email_routing').eq('id', orgId).maybeSingle(),
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
      let orgRow = (orgResFirst.data as Record<string, unknown> | null) ?? null;
      if (orgResFirst.error && isMissingEmailRoutingColumn(orgResFirst.error)) {
        // DEPLOY-ORDER SAFETY: the `email_routing` column does not exist yet
        // (this OTA reached the phone before migration 0337 reached the
        // database). FAIL OPEN to pre-feature behavior — retry the read
        // without the column and record 'fallback', which
        // deliveryRecipientsForRouting maps to the compiled constants,
        // byte-identical to what shipped before the feature. This is the
        // ONLY path that ever selects them; the 42703 decision itself lives
        // in the tested lib (isMissingEmailRoutingColumn).
        const retry = await supabase
          .from('organizations')
          .select('timezone')
          .eq('id', orgId)
          .maybeSingle();
        orgRow = (retry.data as Record<string, unknown> | null) ?? null;
        deliveryRouting = { state: 'fallback' };
      } else {
        // Any other read failure leaves a null row, which the tested parser
        // resolves to 'unset' — the action hides rather than composing mail
        // against recipients nothing validated (never the constants).
        deliveryRouting = deliveryRoutingFromOrgRow(
          orgRow as { email_routing?: unknown } | null,
        );
      }
      orgTimezone = (orgRow?.timezone as string | null) ?? null;
    }
    // Readiness read the zone too ("Checked at" and PO dates name the org's
    // clock and day, as the web page does), and so does the needed-by read
    // (F2-4). Any of the reads may supply it.
    orgTimezone =
      orgTimezone ?? readinessAnswer?.[1] ?? (neededByZoneRead ? await neededByZoneRead : null);

    let shown: OrderHeader | null = null;
    setLoadError(null);
    if (!data) setOrder(null);
    if (data) {
      const r = data as Record<string, unknown>;
      const wh = r.warehouse as { name: string | null } | { name: string | null }[] | null;
      const whObj = Array.isArray(wh) ? wh[0] : wh;
      const pk = r.picker as
        | { full_name: string | null; email: string | null }
        | { full_name: string | null; email: string | null }[]
        | null;
      const pkObj = Array.isArray(pk) ? pk[0] : pk;
      shown = {
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
        requesterDeletedAt: (r.requester_deleted_at as string | null) ?? null,
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
        deliveryRouting,
        totalRequested,
        totalFulfilled,
        readiness,
        receivedAt: new Date().toISOString(),
        returns: orderReturns,
        lines: rows.map((l) => {
          const itemObj = Array.isArray(l.item) ? l.item[0] : l.item;
          const charterObj = Array.isArray(itemObj?.charter)
            ? itemObj?.charter[0]
            : itemObj?.charter;
          return {
            orderRequestLineId: l.id ?? null,
            itemId: l.item_id ?? null,
            createdAt: l.created_at ?? null,
            // Core's label when the viewer's access hides the item (a line's
            // item cannot be deleted); the web order page says the same.
            name: orderLineItemName(itemObj),
            sku: itemObj?.sku ?? null,
            requested: Number(l.quantity_requested) || 0,
            fulfilled: Number(l.quantity_fulfilled) || 0,
            picked: Number(l.quantity_picked) || 0,
            returned: Number(l.returned_quantity) || 0,
            charterName: charterObj?.name ?? null,
            charterCode: charterObj?.code ?? null,
          };
        }),
      };
      setOrder(shown);
    }
    const attachmentsRead = await loadAttachments();
    // Read-only carrier tracking. The wrapper soft-gates: if the shipping
    // module is off, the member lacks access, or there is simply no shipment,
    // it returns null and the section below stays hidden.
    const shipmentRead = await getOrderShipment(id);
    setShipment(shipmentRead);
    // Kept in memory for this app session only (never written to the
    // device), so the screen can show how the order looked if the phone goes
    // offline and the order is opened again.
    if (shown) {
      rememberOrderView<RememberedOrder>(userId, orgId, id, {
        order: shown,
        attachments: attachmentsRead?.attachments ?? [],
        attachmentsError: attachmentsRead?.error ?? null,
        shipment: shipmentRead,
      });
    }
    setLoading(false);
  }, [orgId, id, loadAttachments, offline, userId, role, rpApprove, rpItems, rpBuy]);

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
        // Through the gated route (0389), never the order row: an approver
        // or the assigned driver gets the image; anyone else, and any
        // failure, gets null and the dialog's name-and-time empty state.
        const url = await fetchOrderSignatureImage((path) => api(path, { orgId }), id);
        if (!cancelled) setSigUrl(url);
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

  // "Try again" on a failed order or stock check. Guarded, and the buttons
  // are disabled while it runs, so repeated taps do not stack reloads.
  async function retryLoad() {
    if (retrying) return;
    setRetrying(true);
    try {
      await load();
    } finally {
      setRetrying(false);
    }
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

  function promptPhysicalSignature() {
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
    );
  }

  const ft = order?.fulfillmentType;
  const st = order?.status;

  // What the stock-dependent actions render (Approve partial, Resume), from
  // readiness through core: the web page's own gates. A failed, missing or
  // capped check disables them and explains; see lib/order-readiness.ts.
  const stockCheck = orderStockCheckFor(st, order?.readiness ?? null);
  const stockGates = orderStockGates(st ?? '', stockCheck);
  // "2 lines ask for more than is available now, so Approve will be refused.
  // ..." under Approve.
  const approveNotice = approveShortNotice(stockCheck);

  // READINESS (F2-1). Who sees it (core readinessAudience: the full panel for
  // approvers, pickers and buyers, one sentence for the requester, nothing
  // for anyone else), and each line's assessment for the full panel.
  const readinessAudienceNow = orderReadinessAudience(
    { canApproveOrders: rpApprove, canUpdateItems: rpItems, canManagePurchaseOrders: rpBuy },
    userId,
    order?.requesterUserId ?? null,
  );
  const readinessShown =
    order !== null &&
    order.readiness !== null &&
    readinessAudienceNow !== 'none' &&
    orderReadinessPhase(order.status) === 'to_pick';
  const readinessByLine = React.useMemo(() => {
    const r = order?.readiness;
    if (!r || r.state !== 'ok' || r.assessment.phase !== 'to_pick') return null;
    const items = new Map(r.assessment.items.map((it) => [it.itemId, it]));
    return new Map(
      r.assessment.lines.map((l) => [l.lineId, { line: l, item: items.get(l.itemId) ?? null }]),
    );
  }, [order]);
  const showLineReadiness = readinessShown && readinessAudienceNow === 'full';

  // F2-3 "Put away" on the full panel: a line with units in this warehouse's
  // Staging, and "Put away N items" on the card (core put-away.ts). The gate
  // is stock:transfer (the permission Place asserts) and items:read (the
  // Staging route's), read as the server reads them; without them, the card
  // says core's sentence once, naming what is missing, and the lines offer
  // nothing (the web page's layout).
  const { canTransfer, canReadItems } = putAwayAccessFor(role, permissions);
  const putAway = React.useMemo(
    () =>
      orderPutAwayView({
        readiness: order?.readiness ?? null,
        fullPanel: showLineReadiness,
        access: { canTransfer, canReadItems },
      }),
    [order, showLineReadiness, canTransfer, canReadItems],
  );

  // F2-2 "Hold available stock" on the readiness card: core's rule, the web
  // strip's own (approvers, hold statuses, some line not or partly held).
  const offerHold =
    readinessShown &&
    shouldOfferHoldStock({
      assessment: order?.readiness?.state === 'ok' ? order.readiness.assessment : null,
      canApproveOrders: rpApprove,
    });

  // F2-5 "Draft PO for what is short" on the readiness card, when something
  // on the order may be drafted: the button for a manager holding
  // purchase_orders:manage with Orders and Purchase orders on; core's
  // sentence for anyone else on the full panel. The server re-checks all of
  // it (and write access to the order's warehouse, which every manager has).
  const shownReadiness = readinessShown ? (order?.readiness ?? null) : null;
  const ordersModuleOn = enabledModules.has('orders');
  const purchaseOrdersModuleOn = enabledModules.has('purchase_orders');
  const shortfallOffer = React.useMemo(
    () =>
      shortfallPoOffer({
        readiness: shownReadiness,
        fullPanel: showLineReadiness,
        isManager,
        canManagePurchaseOrders: rpBuy,
        ordersModule: ordersModuleOn,
        purchaseOrdersModule: purchaseOrdersModuleOn,
      }),
    [shownReadiness, showLineReadiness, isManager, rpBuy, ordersModuleOn, purchaseOrdersModuleOn],
  );

  // F2-4 "Change" beside the needed-by: approvers (the effective
  // orders:approve; since 0390 the database has no manager-by-role exception)
  // on an open order where Orders is on. Warehouse write
  // access is checked when the sheet opens; the server re-checks all of it.
  const canChangeNeededBy =
    order !== null &&
    canOfferNeededByChange({
      status: order.status,
      role,
      canApproveOrders: rpApprove,
      ordersModuleEnabled: enabledModules.has('orders'),
    });

  // F2-2: the fixes the line being edited offers when it is short (core
  // shortLineActions): before picking from its readiness (the full panel
  // only), after picking from the line alone.
  const editLineShortFix = React.useMemo(() => {
    if (!editLine || !order || editLine.orderRequestLineId === null) return null;
    const lineId = editLine.orderRequestLineId;
    return orderLineShortFix({
      status: order.status,
      line: editLine,
      position: order.lines.findIndex((l) => l.orderRequestLineId === lineId) + 1,
      totalLines: order.lines.length,
      readinessLine: showLineReadiness ? (readinessByLine?.get(lineId)?.line ?? null) : null,
    });
  }, [editLine, order, showLineReadiness, readinessByLine]);

  // Every action needs a connection; this is the reason shown with them.
  const connectionNotice = offline ? (
    <Body size={12} color={c.ink3}>
      {READINESS_NEEDS_CONNECTION_COPY}
    </Body>
  ) : null;
  const stockNotice = stockGates.notice ? (
    <View style={{ gap: 8 }}>
      <Body size={12} color={ACCENT.warn}>
        {stockGates.notice}
      </Body>
      {stockGates.canRetry ? (
        <Pressable
          onPress={() => void retryLoad()}
          disabled={retrying}
          accessibilityRole="button"
          accessibilityState={{ disabled: retrying }}
          style={[
            styles.addBtn,
            { borderWidth: 1, borderColor: c.hair, opacity: retrying ? 0.5 : 1 },
          ]}
        >
          {retrying ? (
            <ActivityIndicator color={c.ink} />
          ) : (
            <Mono size={13} color={c.ink}>
              Try again
            </Mono>
          )}
        </Pressable>
      ) : null}
    </View>
  ) : null;

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
  // F2-2: out for delivery the lines are final (the line sheet does not
  // open), so the card names the short lines and says what happens to their
  // units (core's order-level note, never the row's "this line").
  const shortLinesFinalNote = order ? orderShortLinesFinalNote(order.lines, order.status) : null;

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
          // 0390: approval-class actions follow the effective permission.
          canApproveOrders: rpApprove,
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
          // 0390: reopen_picking asks orders:approve, so a granted staff
          // member is offered it and a revoked manager is not (as on the web).
          canApproveOrders: rpApprove,
        }).includes('reopen_picking')
      : false;
  // Slice D (0390): the MANAGER ACTIONS section and each button in it follow
  // the rule the server applies to that action (the effective orders:approve
  // for approval-class actions, orders:assign_delivery for the driver, a
  // manager or the driver for a paper signature), as the web page's
  // showActionsPanel does; no longer role rank. Never an approval-class
  // action for a viewer: the app refuses every write for one. The picking
  // phase keeps its own section below. Old bundles still show these by role.
  const managerActions = orderManagerActions({
    status: st,
    fulfillmentType: ft,
    canApproveOrders: rpApprove,
    canAssignDelivery: role !== null && can({ role: role as Role, permissions }, 'orders:assign_delivery'),
    isManagerByRole: isManager,
    isAssignedDriver: !!order?.assignedDeliveryUserId && order.assignedDeliveryUserId === user?.id,
    hasAssignedDriver: !!order?.assignedDeliveryUserId,
    machineOffersReopen: canReopenPicking,
    isViewerRole: role === 'viewer',
  });
  const hasPipelineActions = managerActions.showSection;
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
    disabledByCaller = false,
    disabledReason: string | null = null,
  ) => {
    const isBusy = acting === busyKey;
    // Offline every action is disabled ("Needs a connection." shows with
    // them), except the few that change nothing anywhere (WORKS_OFFLINE).
    const disabled = disabledByCaller || (offline && !WORKS_OFFLINE.has(busyKey));
    // A disabled button says why in its own hint, as the web links its reason
    // with aria-describedby: the reason shown under the actions is otherwise
    // read only later, after the other buttons.
    const hint = disabledByCaller
      ? (disabledReason ?? undefined)
      : offline && !WORKS_OFFLINE.has(busyKey)
        ? READINESS_NEEDS_CONNECTION_COPY
        : undefined;
    const bg = tone === 'primary' ? c.ink : tone === 'danger' ? '#b42318' : 'transparent';
    const fg = tone === 'default' ? c.ink : tone === 'danger' ? '#fff' : c.paper;
    return (
      <Pressable
        key={label}
        onPress={onPress}
        disabled={acting !== null || disabled}
        accessibilityRole="button"
        accessibilityState={{ disabled: acting !== null || disabled }}
        accessibilityHint={hint}
        style={[
          styles.addBtn,
          {
            backgroundColor: bg,
            borderWidth: 1,
            borderColor: tone === 'default' ? c.hair : 'transparent',
            opacity: disabled || (acting !== null && !isBusy) ? 0.5 : 1,
          },
        ]}
      >
        {isBusy ? <ActivityIndicator color={fg} /> : <Mono size={13} color={fg}>{label}</Mono>}
      </Pressable>
    );
  };

  // Uploads ONE asset (resize → storage → SERVER finalize, which records the
  // row). Returns success/failure WITHOUT touching the shared `uploading`
  // flag or refetching, so the single and batch flows can share it. Per-file
  // storage rollback on a refused finalize is preserved so we never leave an
  // orphaned object behind. The
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
      // ═══ FINALIZE ON THE SERVER, NEVER STRAIGHT INTO POSTGREST (SP-018) ═══
      //
      // This used to insert the order_request_attachments row itself. That
      // skipped OrderAttachmentsService.add() → verifyStoredDocumentOrDelete(),
      // the ONLY place the uploaded object's real magic bytes are sniffed and
      // its body scanned for active content — so a file attached from a phone
      // was never checked, and the row recorded whatever content_type the
      // client claimed, which is the value the web panel and every download
      // path then trust. The route below runs the same service the web panel
      // does, so both surfaces are verified identically and the row records
      // the SNIFFED mime.
      //
      // The storage rollback is kept deliberately: the server deletes the
      // object itself when the SNIFF fails, but every other refusal
      // (permission, a non-attachable order status, a wrong path shape) would
      // otherwise leave orphaned bytes in the bucket. Rolling back twice is
      // harmless; not rolling back is a leak.
      try {
        await api(`/api/v1/orders/${id}/attachments`, {
          method: 'POST',
          body: {
            storagePath: path,
            fileName: null,
            contentType: mimeForExt(resized.ext),
            kind,
          },
        });
      } catch (e) {
        await supabase.storage.from(BUCKET).remove([path]);
        return { ok: false, error: extractApiErrorMessage(e, 'Could not attach that photo.') };
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
            accessibilityLabel="Back"
            minTap
          />
        </View>
      </SafeAreaView>

      {loading && !order && !offline ? (
        <ActivityIndicator color={c.ink} style={{ marginTop: 40 }} />
      ) : !order && loadError !== null ? (
        <View style={styles.center}>
          <Display size={18}>Could not load this <Em>order.</Em></Display>
          <Body muted style={{ marginTop: 6, textAlign: 'center' }}>
            {loadError}
          </Body>
          <Pressable
            onPress={() => void retryLoad()}
            disabled={retrying}
            accessibilityRole="button"
            accessibilityState={{ disabled: retrying }}
            style={[
              styles.addBtn,
              { marginTop: 16, borderWidth: 1, borderColor: c.hair, opacity: retrying ? 0.5 : 1 },
            ]}
          >
            {retrying ? <ActivityIndicator color={c.ink} /> : <Mono size={13} color={c.ink}>Try again</Mono>}
          </Pressable>
        </View>
      ) : !order ? (
        <View style={styles.center}>
          <Display size={18}>Order not <Em>found.</Em></Display>
        </View>
      ) : (
        // A focused field low on the screen (a pick quantity) sat under the
        // iPad's docked keyboard: the same wrapper as the form screens keeps
        // the list above it. (The list inside keeps its indentation, so this
        // file's other open branches merge cleanly.)
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1 }}
        >
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 60, gap: 16 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.ink} />}
        >
          <View style={{ paddingTop: 1 }}>
            <Eyebrow>{orderHeaderEyebrow(order.orderNumber, order.status)}</Eyebrow>
            <Display size={30} style={{ marginTop: 10 }}>
              {order.requester ?? 'Order'}
            </Display>
            <Mono size={11.5} tracking={0.04} color={c.ink4} style={{ marginTop: 4 }}>
              {[order.orgLabel, order.warehouseName].filter(Boolean).join(' · ') || '—'}
            </Mono>
          </View>

          {/* OFFLINE: the order as it was last loaded, and when. Every action
              below is disabled and says it needs a connection. */}
          {offline ? (
            <Card padding={14}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                <View style={{ paddingTop: 3 }}>
                  <WifiOff size={16} color={ACCENT.warn} strokeWidth={1.8} />
                </View>
                <Body size={13.5} color={c.ink} accessibilityRole="alert" style={{ flex: 1 }}>
                  {readinessOfflineCopy(orderViewAsOf(order.readiness, order.receivedAt), {
                    timeZone: order.orgTimezone ?? undefined,
                  })}
                </Body>
              </View>
            </Card>
          ) : null}

          {/* F2-4: the needed-by in the org's zone (the web page's Dates
              card), and Change for approvers. The sheet it opens sends no
              email and opens none. */}
          {showNeededByCard(order.neededBy, canChangeNeededBy) ? (
            <OrderNeededByCard
              value={neededByCardValue(order.neededBy, order.orgTimezone)}
              canChange={canChangeNeededBy}
              busy={acting === 'needed-by'}
              disabled={acting !== null}
              offline={offline}
              onChange={() => void openNeededBySheet()}
            />
          ) : null}

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
              {shortLinesFinalNote ? (
                <Body size={12} color="#b45309" style={{ marginTop: 6 }}>
                  {shortLinesFinalNote}
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
              {shortLinesFinalNote ? (
                <Mono size={11} color={ACCENT.warn} style={{ marginTop: 6 }}>
                  {shortLinesFinalNote}
                </Mono>
              ) : null}
            </Card>
          ) : null}

          {/* READINESS (F2-1): the roll-up above the lines (the full panel),
              or one sentence for the requester. A failed check says so. */}
          {readinessShown && order.readiness ? (
            <OrderReadinessSummary
              result={order.readiness}
              audience={readinessAudienceNow}
              timeZone={order.orgTimezone}
              offline={offline}
              checking={retrying}
              onCheckAgain={() => void retryLoad()}
              hold={
                offerHold
                  ? {
                      busy: acting === 'hold',
                      disabled: acting !== null,
                      onPress: () => void holdStock(),
                    }
                  : null
              }
              putAway={
                putAway.strip.kind !== 'none'
                  ? { offer: putAway.strip, disabled: acting !== null, onPress: openPutAway }
                  : null
              }
              shortfallPo={
                shortfallOffer.kind !== 'none'
                  ? {
                      offer: shortfallOffer,
                      disabled: acting !== null,
                      onPress: () => void openShortfallSheet(),
                    }
                  : null
              }
            />
          ) : null}

          {order.lines.length > 0 || canAddItems ? (
            <View style={{ gap: 10 }}>
              <Eyebrow>{orderItemsEyebrow(order.lines.length, totalRequested)}</Eyebrow>
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
              {/* Returned units, stated as a LATER event beside the shipped
                  total (SO-000085). Neutral, not the amber of the owed card:
                  nothing needs attention, the order is simply not the clean
                  "everything delivered and kept" it would otherwise read as.
                  The net figure is arithmetic on records; its caveat is
                  printed with it because it can be wrong for an in-person
                  swap recorded only in a return's notes — those notes are in
                  the RETURNS section below. Renders nothing when nothing was
                  returned. */}
              {returnSummary ? (
                <Card padding={14}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <Body size={13} color={c.ink}>
                      Returns
                    </Body>
                    <Mono size={11} color={c.ink} style={{ flexShrink: 1 }} numberOfLines={2}>
                      {formatOrderReturnSummary(returnSummary)}
                    </Mono>
                  </View>
                  <Mono size={10.5} color={c.ink4} style={{ marginTop: 6 }}>
                    {ORDER_RETURN_SUMMARY_NOTE}
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
                    // Offline an edit could not be sent: the row is not
                    // tappable, and "Needs a connection." shows below.
                    const editable = canEditItems && l.orderRequestLineId !== null && !offline;
                    // A row that could be edited with a connection: offline
                    // VoiceOver says it is disabled, and why.
                    const editBlockedOffline = canEditItems && l.orderRequestLineId !== null && offline;
                    const lineSubline = describeLineFulfilment({
                      requested: l.requested,
                      fulfilled: l.fulfilled,
                      returned: l.returned,
                    });
                    // The line's readiness, under it (full panel only). A
                    // SIBLING of the row, never inside it: the row is a
                    // button, and a button folds everything in it into one
                    // VoiceOver element.
                    const lineReadiness =
                      showLineReadiness && l.orderRequestLineId
                        ? (readinessByLine?.get(l.orderRequestLineId) ?? null)
                        : null;
                    // F2-3: the line's "Put away" (units in Staging), for
                    // stock:transfer only; none otherwise (the card says
                    // core's permission sentence once, as the web page does).
                    const lineOffer =
                      lineReadiness && l.orderRequestLineId
                        ? (putAway.lines.get(l.orderRequestLineId) ?? null)
                        : null;
                    return (
                      <View
                        key={l.orderRequestLineId ?? `${l.sku ?? l.name}-${i}`}
                        style={{ borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.hair }}
                      >
                        <Pressable
                          onPress={
                            editable ? () => setEditLineId(l.orderRequestLineId) : undefined
                          }
                          // 'none', never undefined. React Native keeps a
                          // view's previous traits when its role is removed
                          // (AccessibilityProps.cpp: no role value keeps
                          // sourceProps.accessibilityTraits), so a row that
                          // was editable online stayed a Button offline (F2-1
                          // phone walk, D1). A removed hint or label resets.
                          accessibilityRole={editable ? 'button' : 'none'}
                          accessibilityState={{ disabled: editBlockedOffline }}
                          accessibilityHint={editBlockedOffline ? READINESS_NEEDS_CONNECTION_COPY : undefined}
                          accessibilityLabel={
                            editable ? `Edit ${l.name}, quantity ${l.requested}` : undefined
                          }
                          style={({ pressed }) => ({
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 12,
                            paddingHorizontal: 14,
                            paddingVertical: 12,
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
                            {/* The sub-line comes from the shared describer so
                                web and the phone say the same thing about the
                                same line: "1 provided · 2 owed", "fulfilled",
                                and — after a return — "fulfilled · 1 returned".
                                Fulfilled is the shipped count and is never
                                rewritten; the returned figure is appended as a
                                later event. Amber only while units are OWED. */}
                            {lineSubline ? (
                              <Mono
                                size={10.5}
                                color={l.fulfilled > 0 && l.fulfilled < l.requested ? '#b45309' : c.ink4}
                                style={{ marginTop: 2 }}
                              >
                                {lineSubline}
                              </Mono>
                            ) : null}
                            {editable ? (
                              <Mono size={10} tracking={0.08} upper color={c.ink4} style={{ marginTop: 3 }}>
                                Edit
                              </Mono>
                            ) : null}
                          </View>
                        </Pressable>
                        {lineReadiness ? (
                          <OrderLineReadiness
                            line={lineReadiness.line}
                            item={lineReadiness.item}
                            position={i + 1}
                            timeZone={order.orgTimezone}
                            onOpenItem={(itemId) => router.push(`/item/${itemId}`)}
                            putAway={
                              lineOffer
                                ? {
                                    offer: lineOffer,
                                    disabled: offline || acting !== null,
                                    offline,
                                    onPress: openPutAway,
                                  }
                                : null
                            }
                          />
                        ) : null}
                      </View>
                    );
                  })}
                </Card>
              )}
              {canEditItems && order.lines.length > 0 && !offline ? (
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
              {canEditItems || canAddItems ? connectionNotice : null}
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
                  offline={offline}
                  // F2-2: the completion confirm projects what the picker
                  // entered against this order's readiness; its "Review short
                  // lines" focuses that line's quantity in the pick.
                  readiness={order.readiness}
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
              {canClaimPick || canReleasePick ? connectionNotice : null}

              <Mono size={10.5} color={c.ink4}>
                Same actions as the web dashboard — changes sync instantly.
              </Mono>
            </View>
          ) : null}

          {hasPipelineActions ? (
            <View style={{ gap: 8 }} onLayout={onActionsLayout}>
              {/* A granted staff member or an assigned driver sees this too
                  (slice D): it is not only a manager's section any more. */}
              <Eyebrow>{isManager ? 'MANAGER ACTIONS' : 'ORDER ACTIONS'}</Eyebrow>
              {managerActions.approve ? (
                <>
                  {actionBtn('Approve', 'approve', () => void act({ action: 'approve' }, 'approve'))}
                  {/* A strict Approve would be refused: say so before the tap
                      (core approveShortNotice, the web page's words). */}
                  {approveNotice ? (
                    <Body size={12} color={ACCENT.warn}>
                      {approveNotice}
                    </Body>
                  ) : null}
                  {managerActions.approvePartial && stockGates.approvePartial !== 'hidden'
                    ? actionBtn(
                        'Approve partial',
                        'approve-partial',
                        () => openPartialSheet('approve_partial'),
                        'default',
                        stockGates.approvePartial === 'disabled',
                        stockGates.notice,
                      )
                    : null}
                  {managerActions.deny
                    ? actionBtn('Deny', 'deny', () => setDenyOpen(true), 'danger')
                    : null}
                  {stockNotice}
                </>
              ) : null}
              {managerActions.generatePickSlip
                ? actionBtn('Generate pick slip', 'gps', () =>
                    void act({ action: 'generate_pick_slip' }, 'gps'),
                  )
                : null}
              {managerActions.generatePackingSlips
                ? actionBtn('Generate packing slips', 'gpk', () =>
                    void act({ action: 'generate_packing_slips' }, 'gpk'),
                  )
                : null}
              {order.status === 'picking_complete' && managerActions.reopenPicking
                ? actionBtn('Reopen picking', 'reopen', () => setReopenOpen(true), 'danger')
                : null}
              {managerActions.stageForPickup
                ? actionBtn('Mark staged for pickup', 'stage', () =>
                    confirmDeparture('stage', () =>
                      void act({ action: 'stage', target: 'staged_for_pickup' }, 'stage'),
                    ),
                  )
                : null}
              {managerActions.stageForDelivery
                ? actionBtn('Mark staged for delivery', 'stage', () =>
                    confirmDeparture('stage', () =>
                      void act({ action: 'stage', target: 'staged_for_delivery' }, 'stage'),
                    ),
                  )
                : null}
              {order.status === 'packing_slip_generated' && managerActions.reopenPicking
                ? actionBtn('Reopen picking', 'reopen', () => setReopenOpen(true), 'danger')
                : null}
              {managerActions.assignDelivery
                ? actionBtn(
                    order.assignedDeliveryUserId ? 'Reassign delivery' : 'Assign delivery',
                    'assign',
                    () => void openDriverPicker(),
                    'default',
                  )
                : null}
              {managerActions.markInTransit
                ? actionBtn('Mark in transit', 'transit', () =>
                    confirmDeparture('in_transit', () =>
                      void act({ action: 'mark_in_transit' }, 'transit'),
                    ),
                  )
                : null}
              {managerActions.digitalSignature
                ? actionBtn('Collect signature', 'sig', () =>
                    confirmDeparture('signature', collectSignature),
                  )
                : null}
              {managerActions.physicalSignature
                ? actionBtn(
                    'Physical signature',
                    'physicalsig',
                    () => confirmDeparture('signature', promptPhysicalSignature),
                    'default',
                  )
                : null}
              {managerActions.backorderedActions ? (
                <>
                  {stockGates.resume === 'waiting' ? (
                    <Body size={12} color={c.ink4}>
                      Resume unlocks when owed items are back in stock.
                    </Body>
                  ) : (
                    actionBtn(
                      'Resume fulfillment',
                      'resume',
                      () => openPartialSheet('resume'),
                      'primary',
                      stockGates.resume === 'disabled',
                      stockGates.notice,
                    )
                  )}
                  {stockNotice}
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
              {connectionNotice}
              <Mono size={10.5} color={c.ink4}>
                Same actions as the web dashboard — changes sync instantly.
              </Mono>
            </View>
          ) : null}

          {showDeliveryRequest && deliveryPrepared && deliveryRecipients ? (
            <View style={{ gap: 8 }}>
              <Eyebrow>DELIVERY REQUEST</Eyebrow>
              {actionBtn('Email delivery request', 'delivery-request', handleDeliveryRequestPress)}
              {connectionNotice}
              {/* Interpolated from the SAME resolved recipients the draft was
                  composed with (per-org email routing), so this sentence can
                  never name mailboxes the mail does not go to. */}
              <Mono size={10.5} color={c.ink4}>
                {recipientsHelperText(deliveryRecipients)}
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
                      no clipboard module in this binary, so this selectable,
                      read-only textarea IS the copy affordance — and ONE TAP
                      selects the whole message (selectTextOnFocus), matching
                      the maintenance twin (app/maintenance/[id].tsx) verbatim
                      rather than the long-press-and-drag a plain Body text
                      demanded here before. */}
                  <TextInput
                    multiline
                    editable={false}
                    selectTextOnFocus
                    value={deliveryPrepared.clipboardText}
                    style={[styles.copyBox, { color: c.ink, borderColor: c.hair }]}
                    accessibilityLabel="Delivery request text to copy manually"
                  />
                  <Body size={11.5} muted style={{ marginTop: 6 }}>
                    {DR_COPY_HELPER}
                  </Body>
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

          {/* The order's returns — number, status, what came back and how it
              was dispositioned, and the NOTES. The notes are where an
              in-person swap is recorded today (SO-000085: "Size S … swapped
              out for Ladies size M" — the replacement is on no order line), so
              they must be readable where a human looks at the order. Listed
              for every viewer (RLS decided what came back). There is no native
              returns screen to navigate to, so each RMA renders inline.

              RENDER DEBT — READ BEFORE TRUSTING THE GREEN SUITE. Mobile vitest
              cannot reach this .tsx: the decisions the cards print are pinned
              in src/lib/order-returns.view.test.ts, and the web suite scans
              this file for the helper CALLS, but nothing automated proves the
              cards actually RENDER the notes / status / lines. Deleting the
              `r.notes` block below leaves every suite green. What is owed:
              a simulator hand-test on Demo Co (71b27a4a-…, fenced from L4L —
              never fixture on the live org): complete an order, create a
              return against it, approve / receive / close it with a note,
              then open the order and check (1) the line reads "fulfilled ·
              1 returned", (2) the Returns card reads "N provided · 1 returned
              · net …" with the caveat beneath, (3) the RMA card shows number,
              status word, reason · date, "1 × item — Restock · applied" and
              the note verbatim. Demo Co held no such order at ship time; the
              read-only smoke suite (scripts/smoke) cannot create one. */}
          {shouldShowReturnsSection({
            returnsCount: order.returns.length,
            canCreateReturn: showCreateReturn,
          }) ? (
            <View style={{ gap: 8 }}>
              <Eyebrow>
                {`RETURNS${order.returns.length > 0 ? ` · ${order.returns.length}` : ''}`}
              </Eyebrow>
              {order.returns.map((r) => (
                <Pressable
                  key={r.id}
                  disabled={!canReadReturns}
                  onPress={() => router.push(`/returns/${r.id}` as Href)}
                  accessibilityRole={canReadReturns ? 'link' : undefined}
                  accessibilityLabel={canReadReturns ? `Open ${returnHandle(r)}, ${returnStatusLabel(r.status)}` : undefined}
                  style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
                >
                <Card padding={14}>
                  <View
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <Mono size={12} color={c.ink} numberOfLines={1} style={{ flexShrink: 1 }}>
                      {returnHandle(r)}
                    </Mono>
                    <Mono size={10} tracking={0.08} upper color={c.ink4}>
                      {returnStatusLabel(r.status)}
                    </Mono>
                  </View>
                  <Mono size={10.5} color={c.ink4} style={{ marginTop: 2 }}>
                    {describeReturnMeta(r)}
                  </Mono>
                  {r.lines.map((rl, i) => (
                    <Mono
                      key={`${r.id}-${rl.orderRequestLineId}-${i}`}
                      size={11}
                      color={c.ink}
                      style={{ marginTop: i === 0 ? 8 : 2 }}
                    >
                      {describeReturnLine({
                        quantity: rl.quantity,
                        itemName: returnLineItemName(rl, order.lines),
                        disposition: rl.disposition,
                        applied: rl.applied,
                      })}
                    </Mono>
                  ))}
                  {r.notes ? (
                    <Body size={13} color={c.ink} style={{ marginTop: 8 }}>
                      {r.notes}
                    </Body>
                  ) : null}
                  {canReadReturns ? (
                    <Mono size={10.5} color={c.ink4} style={{ marginTop: 8 }}>
                      Open the return →
                    </Mono>
                  ) : null}
                </Card>
                </Pressable>
              ))}
              {order.returns.length > 0 ? (
                <Mono size={10.5} color={c.ink4}>
                  A return is a later event — the shipped count above is never rewritten.
                </Mono>
              ) : null}
              {showCreateReturn ? (
                <>
                  {actionBtn('Create return', 'create-return', openReturnSheet)}
                  {connectionNotice}
                  <Mono size={10.5} color={c.ink4}>
                    {RETURNS_COPY.createReturnQueueNote}
                  </Mono>
                </>
              ) : null}
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
                    disabled={uploading || offline}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: uploading || offline }}
                    style={[
                      styles.addBtn,
                      { backgroundColor: c.ink, opacity: uploading || offline ? 0.6 : 1 },
                    ]}
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
                {connectionNotice}
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
                          <Pressable
                            onPress={() => void deleteAttachment(a)}
                            disabled={offline}
                            accessibilityRole="button"
                            accessibilityLabel="Delete attachment"
                            accessibilityState={{ disabled: offline }}
                            style={{ opacity: offline ? 0.4 : 1 }}
                            hitSlop={8}
                          >
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
        </KeyboardAvoidingView>
      )}

      <Modal visible={sigOpen} transparent animationType="fade" onRequestClose={() => setSigOpen(false)}>
        {/*
         * THE BACKDROP IS A SIBLING BEHIND THE DIALOG, NEVER ITS PARENT — the
         * same shape for this dialog and the Deny / Reopen dialogs below.
         *
         * Each card used to be a `Pressable onPress={() => undefined}` inside a
         * scrim Pressable, only to stop taps inside it from closing the dialog.
         * A Pressable is an accessibility element by default and iOS collapses
         * everything inside one into a single element, so VoiceOver read the
         * whole dialog as one label and could not reach the reason field or the
         * Cancel / Deny / Reopen buttons on their own; it also claims the touch
         * responder (see add-order-items-sheet.tsx).
         *
         * The scrim must dim the FULL screen, so it cannot sit inside the padded
         * layer (Yoga insets an absolute child by its parent's padding — see
         * notifications.tsx). The padding lives on a `pointerEvents="box-none"`
         * layer above it: taps beside the card fall through to the scrim and
         * close, while the card, a plain View, keeps its own touches.
         * accessibilityViewIsModal (iOS) keeps VoiceOver inside the dialog.
         *
         * onAccessibilityTap on the scrim: without it a VoiceOver double-tap
         * is a synthetic touch at the CENTRE of the scrim's frame, and the
         * centred card covers that point, so "Close" landed on the card and
         * the dialog stayed open. With it, iOS calls the handler directly.
         * onAccessibilityEscape on the container makes the two-finger scrub
         * close the dialog too.
         */}
        <View
          style={{ flex: 1 }}
          accessibilityViewIsModal
          onAccessibilityEscape={() => setSigOpen(false)}
        >
          <Pressable
            onPress={() => setSigOpen(false)}
            onAccessibilityTap={() => setSigOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)' },
            ]}
          />
          <View
            style={{ flex: 1, justifyContent: 'center', padding: 24 }}
            pointerEvents="box-none"
          >
            <View style={{ backgroundColor: c.card, borderRadius: 16, padding: 18, gap: 12 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>Customer signature</Body>
                <Pressable
                  onPress={() => setSigOpen(false)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Close"
                >
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
            </View>
          </View>
        </View>
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
        {/* Backdrop is a SIBLING behind the dialog, never its parent — see
            the Customer signature dialog above. */}
        <View style={{ flex: 1 }} accessibilityViewIsModal onAccessibilityEscape={dismissDenyModal}>
          <Pressable
            onPress={dismissDenyModal}
            onAccessibilityTap={dismissDenyModal}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)' },
            ]}
          />
          <View
            style={{ flex: 1, justifyContent: 'center', padding: 24 }}
            pointerEvents="box-none"
          >
            <View style={{ backgroundColor: c.card, borderRadius: 16, padding: 18, gap: 12 }}>
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
                  accessibilityRole="button"
                  style={[styles.addBtn, { backgroundColor: 'transparent', borderWidth: 1, borderColor: c.hair, paddingHorizontal: 18 }]}
                >
                  <Mono size={13} color={c.ink}>Cancel</Mono>
                </Pressable>
                <Pressable
                  onPress={() => void submitDeny()}
                  disabled={acting !== null}
                  accessibilityRole="button"
                  style={[
                    styles.addBtn,
                    { backgroundColor: '#b42318', paddingHorizontal: 18, opacity: acting !== null ? 0.5 : 1 },
                  ]}
                >
                  <Mono size={13} color="#fff">Deny</Mono>
                </Pressable>
              </View>
            </View>
          </View>
        </View>
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
        {/* Backdrop is a SIBLING behind the dialog, never its parent — see
            the Customer signature dialog above. */}
        <View style={{ flex: 1 }} accessibilityViewIsModal onAccessibilityEscape={dismissReopenModal}>
          <Pressable
            onPress={dismissReopenModal}
            onAccessibilityTap={dismissReopenModal}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)' },
            ]}
          />
          <View
            style={{ flex: 1, justifyContent: 'center', padding: 24 }}
            pointerEvents="box-none"
          >
            <View style={{ backgroundColor: c.card, borderRadius: 16, padding: 18, gap: 12 }}>
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
                  accessibilityRole="button"
                  style={[styles.addBtn, { backgroundColor: 'transparent', borderWidth: 1, borderColor: c.hair, paddingHorizontal: 18 }]}
                >
                  <Mono size={13} color={c.ink}>Cancel</Mono>
                </Pressable>
                <Pressable
                  onPress={() => void reopenPicking()}
                  disabled={!reopenReason.trim() || acting !== null}
                  accessibilityRole="button"
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
            </View>
          </View>
        </View>
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
              maxHeight: returnSheetLayout.sheetMaxHeight,
            }}
          >
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <Body
                size={15}
                color={c.ink}
                accessibilityRole="header"
                maxFontSizeMultiplier={capTo(15, TYPE_CEILING.display)}
                style={{ fontFamily: FONT.display, flex: 1 }}
              >
                Create return
              </Body>
              <Pressable
                onPress={() => {
                  if (!returnSubmitting) setReturnOpen(false);
                }}
                disabled={returnSubmitting}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Close"
                accessibilityState={{ disabled: returnSubmitting }}
                style={{ minWidth: MIN_TAP, minHeight: MIN_TAP, alignItems: 'flex-end', justifyContent: 'center' }}
              >
                <X size={18} color={c.ink4} />
              </Pressable>
            </View>

            <ScrollView
              // At large text the body takes all the room the bounded sheet
              // leaves (it shrinks to fit between the header and Submit).
              style={{ maxHeight: returnRowsStacked ? undefined : Math.max(returnSheetLayout.bodyMaxHeight, 380), flexShrink: 1 }}
              contentContainerStyle={{ gap: 12 }}
            >
              <Mono size={11} color={c.ink4}>
                {RETURNS_COPY.createReturnHelp}
              </Mono>
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
                    accessibilityRole="button"
                    accessibilityLabel={`${delta < 0 ? 'Return one fewer' : 'Return one more'} ${l.name}`}
                    accessibilityState={{ disabled }}
                    style={{
                      minWidth: MIN_TAP,
                      minHeight: MIN_TAP,
                      paddingHorizontal: 8,
                      borderRadius: 8,
                      borderWidth: 1,
                      borderColor: c.hair,
                      alignItems: 'center',
                      justifyContent: 'center',
                      opacity: disabled ? 0.35 : 1,
                    }}
                  >
                    <Mono size={15} color={c.ink} maxFontSizeMultiplier={capTo(15, TYPE_CEILING.control)}>
                      {label}
                    </Mono>
                  </Pressable>
                );
                return (
                  <View
                    key={l.orderRequestLineId}
                    style={{ gap: 8, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: c.hair }}
                  >
                    <View
                      style={{
                        flexDirection: returnRowsStacked ? 'column' : 'row',
                        alignItems: returnRowsStacked ? 'flex-start' : 'center',
                        gap: 12,
                      }}
                    >
                      <View style={returnRowsStacked ? { alignSelf: 'stretch' } : { flex: 1, minWidth: 0 }}>
                        <Body size={14} color={c.ink} numberOfLines={returnRowsStacked ? undefined : 2}>{l.name}</Body>
                        <Mono size={10.5} color={c.ink4} style={{ marginTop: 2 }}>
                          {`${l.sku ? `${l.sku} · ` : ''}${l.quantityRemaining} of ${l.quantityFulfilled} returnable`}
                        </Mono>
                      </View>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        {stepBtn('−', -1, d.quantity <= 0 || returnSubmitting)}
                        <Mono
                          size={15}
                          color={c.ink}
                          style={{ minWidth: 24, textAlign: 'center' }}
                          accessibilityLabel={`${d.quantity} ${l.name} returning`}
                          accessibilityLiveRegion="polite"
                        >
                          {d.quantity}
                        </Mono>
                        {stepBtn('+', 1, d.quantity >= l.quantityRemaining || returnSubmitting)}
                      </View>
                    </View>
                    <View
                      style={{ flexDirection: 'row', gap: 6 }}
                      accessibilityRole="radiogroup"
                      accessibilityLabel={`${RETURNS_COPY.returnDisposition} for ${l.name}`}
                    >
                      {(['restock', 'scrap'] as const).map((disp) => {
                        const on = d.disposition === disp;
                        return (
                          <Pressable
                            key={disp}
                            onPress={() => setReturnDisposition(l.orderRequestLineId, disp)}
                            disabled={returnSubmitting}
                            accessibilityRole="radio"
                            accessibilityLabel={disp === 'restock' ? RETURNS_COPY.restock : RETURNS_COPY.scrap}
                            accessibilityState={{ checked: on, disabled: returnSubmitting }}
                            style={{
                              paddingHorizontal: 10,
                              paddingVertical: 5,
                              borderRadius: 8,
                              borderWidth: 1,
                              borderColor: on ? c.ink : c.hair,
                              backgroundColor: on ? c.ink : 'transparent',
                            }}
                          >
                            <Mono size={10.5} color={on ? c.paper : c.ink3} maxFontSizeMultiplier={capTo(10.5, TYPE_CEILING.control)}>
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
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityRole="radiogroup" accessibilityLabel="Reason">
                  {RETURN_REASONS.map((r) => {
                    const on = returnReason === r.value;
                    return (
                      <Pressable
                        key={r.value}
                        // Reason is optional server-side — tapping the active
                        // chip again clears it.
                        onPress={() => setReturnReason(on ? null : r.value)}
                        disabled={returnSubmitting}
                        accessibilityRole="radio"
                        accessibilityLabel={r.label}
                        accessibilityState={{ checked: on, disabled: returnSubmitting }}
                        style={{
                          paddingHorizontal: 10,
                          paddingVertical: 6,
                          borderRadius: 8,
                          borderWidth: 1,
                          borderColor: on ? c.ink : c.hair,
                          backgroundColor: on ? c.ink : 'transparent',
                        }}
                      >
                        <Mono size={10.5} color={on ? c.paper : c.ink3} maxFontSizeMultiplier={capTo(10.5, TYPE_CEILING.control)}>
                          {r.label}
                        </Mono>
                      </Pressable>
                    );
                  })}
                </View>
              </View>

              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View style={{ flex: 1 }}>
                  <Body size={14} color={c.ink}>
                    {RETURNS_COPY.itemIsHere}
                  </Body>
                  <Body size={12} color={c.ink3}>
                    {RETURNS_COPY.itemIsHereHelp}
                  </Body>
                </View>
                <Switch
                  value={returnItemIsHere}
                  onValueChange={setReturnItemIsHere}
                  disabled={returnSubmitting}
                  accessibilityLabel={RETURNS_COPY.itemIsHere}
                  accessibilityHint={RETURNS_COPY.itemIsHereHelp}
                />
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
            {offline ? (
              <Body size={12} color={c.ink3}>
                {READINESS_NEEDS_CONNECTION_COPY}
              </Body>
            ) : null}

            <Pressable
              onPress={() => void submitReturn()}
              disabled={returnSubmitting || offline}
              accessibilityRole="button"
              accessibilityState={{ disabled: returnSubmitting || offline }}
              accessibilityHint={offline ? READINESS_NEEDS_CONNECTION_COPY : undefined}
              style={[
                styles.addBtn,
                // The box grows with its capped label (Dynamic Type policy: a
                // cap always comes with its box fix).
                { height: undefined, minHeight: 44, paddingVertical: 10 },
                { backgroundColor: c.ink, opacity: returnSubmitting || offline ? 0.6 : 1 },
              ]}
            >
              {returnSubmitting ? (
                <ActivityIndicator color={c.paper} />
              ) : (
                <Mono size={13} color={c.paper} maxFontSizeMultiplier={capTo(13, TYPE_CEILING.control)}>
                  Submit return
                </Mono>
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
          shortFix={editLineShortFix}
          onChanged={handleLineChanged}
          onRemoved={handleLineRemoved}
          onRequestReload={() => void load()}
        />
      ) : null}

      {/* F2-3: Approve partial / Resume fulfillment, with what would be held
          (mounted per open, so every session starts clean). Confirm runs the
          existing transition, then says what was actually held. */}
      {partial ? (
        <ApprovePartialSheet
          visible
          view={partialSheetView(partial.preview, {
            timeZone: order?.orgTimezone ?? undefined,
            // The order as the screen shows it now (it reloads after a
            // refusal): when it moved on, the sheet offers Close.
            orderStatus: order?.status ?? null,
          })}
          offline={offline}
          onClose={() => setPartial(null)}
          onConfirm={confirmPartial}
        />
      ) : null}

      {/* F2-4: change the needed-by (mounted per open, so every session
          starts from the order as it was). Save sends a wall clock in the
          org's zone; the server moves the Schedule entry with it and emails
          no one. */}
      {neededBySheet && orgId ? (
        <ReviseNeededBySheet
          visible
          orderId={neededBySheet.orderId}
          organizationId={orgId}
          orderLabel={neededBySheet.orderLabel}
          timeZone={neededBySheet.timeZone}
          startNeededBy={neededBySheet.startNeededBy}
          orderStatus={order?.status ?? neededBySheet.orderStatus}
          offline={offline}
          onClose={() => setNeededBySheet(null)}
          onSaved={(_outcome, title, message) => void handleNeededBySaved(title, message)}
          onRefresh={() => void load()}
        />
      ) : null}

      {/* F2-5: draft a PO for what the order is short (mounted per open, so
          every session starts from the order as the screen showed it). The
          drafts are not sent; nothing here emails anyone. */}
      {shortfallSheet ? (
        <DraftShortfallPoSheet
          visible
          orderId={shortfallSheet.orderId}
          orderLabel={shortfallSheet.orderLabel}
          startView={shortfallSheet.view}
          startNotice={shortfallSheet.notice}
          supplierNames={shortfallSheet.supplierNames}
          timeZone={shortfallSheet.timeZone}
          offline={offline}
          onClose={() => setShortfallSheet(null)}
          onDrafted={() => void load()}
          onOpenDraft={openShortfallDraft}
          onRefresh={() => void load()}
        />
      ) : null}

      {order?.signatureToken ? (
        <SignaturePadModal
          visible={signatureModalVisible}
          onClose={() => setSignatureModalVisible(false)}
          onSuccess={() => void load()}
          signatureToken={order.signatureToken}
          defaultName={order.requesterName ?? ''}
          defaultEmail={signerEmailDefault(order)}
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
  // The back chip's 44pt frame (IconChip minTap) is 3pt wider than the 38pt
  // chip on every side: the bar takes 3pt off its padding (12, 8) and the
  // order's heading 3pt off its top (4 -> 1), so both sit where they did.
  topbar: { paddingHorizontal: 9, paddingTop: 5, flexDirection: 'row' },
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
  // Copied VERBATIM from app/maintenance/[id].tsx `copyBox` — the two copy
  // affordances are twins, and mobile vitest cannot reach either .tsx, so
  // byte-for-byte parity with the hand-tested twin is the enforcement.
  copyBox: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 12.5,
    fontFamily: FONT.mono,
    minHeight: 140,
    textAlignVertical: 'top',
  },
  tile: { width: '31%', borderRadius: 10, borderWidth: 1, overflow: 'hidden' },
  tileImg: { width: '100%', height: 90 },
  tileFoot: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 6 },
});
