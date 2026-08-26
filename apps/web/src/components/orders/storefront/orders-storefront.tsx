'use client';

// Storefront root for /dashboard/orders/new. Owns catalog UI state,
// the order-setup bar, the sticky toolbar, category sections, the
// frequently-ordered carousel, and the review → submit → success flow.
// Cart state + draft persistence come from the shared v2 cart
// context (components/orders/v2/cart-context.tsx).
//
// STREAMING: the page passes the catalog as an un-awaited promise so
// the frame (head, flow indicator, setup bar) flushes immediately;
// only the grid + cart rail suspend behind <Suspense> with a skeleton
// grid while the 353-item payload resolves and streams in.

import {
  ArrowUpDown,
  Boxes,
  Check,
  ChevronDown,
  ChevronLeft,
  Filter,
  LayoutGrid,
  List,
  MapPin,
  Package,
  Search,
  Truck,
  Users,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { createOrderRequestAction } from '@/server/actions/order-requests';

import { isManagerOrAbove, type OrgEmailRoutingRecipientsDto } from '@stockpilot/core';

import { CartProvider, clearCartDraft, initialCartState, useCart } from '../v2/cart-context';
import {
  partitionPrefillAgainstCatalog,
  takeOrderPrefill,
} from '@/lib/orders/start-order-prefill';
import type { AisleSummary, CatalogItem, StorefrontCharter } from '../v2/types';

import {
  CategorySection,
  CompactRow,
  EmptyResults,
  FreqCarousel,
  ProductCard,
  type FreqEntry,
} from './storefront-cards';
import { CartFab, CartRail, type CartContextInfo } from './storefront-cart';
import { CatalogSkeleton } from './storefront-skeleton';
import {
  AVAILABILITY_LABELS,
  SORT_OPTIONS,
  availableOf,
  buildQtyMap,
  cartTotals,
  filterCatalog,
  fullKitLines,
  isBrowsingAll,
  sortCatalog,
  statusOf,
  type CategoryFilter,
  type ItemStatus,
  type SortKey,
  type ViewMode,
} from './storefront-logic';
import { QuickViewDrawer, ReviewModal, SfPopover } from './storefront-overlays';

import './storefront.css';
import { PageTour } from '@/components/onboarding/page-tour';
import { ORDER_CREATE_TOUR } from '@/lib/onboarding/tours';

const GRID_PREVIEW = 4;
const LIST_PREVIEW = 6;
const NEW_HIRE_RE = /new hire/i;

/** Resolved catalog payload streamed in behind the page frame. */
export interface StorefrontCatalogData {
  items: CatalogItem[];
  aisles: AisleSummary[];
}

export interface OrdersStorefrontProps {
  warehouses: Array<{ id: string; name: string }>;
  warehouseId: string;
  /** Un-awaited on the server so the shell streams ahead of the grid. */
  catalogPromise: Promise<StorefrontCatalogData>;
  chartersForWarehouse: StorefrontCharter[];
  viewerRole: string;
  viewerName: string | null;
  viewerEmail: string;
  /**
   * `organizations.timezone`, resolved server-side via `getCachedOrgTimezone`
   * and never empty — the delivery-request draft prints the needed-by date in
   * it, and a blank value would render an empty "()" after the date.
   */
  orgTimezone: string;
  /**
   * The org's delivery-request email routing, resolved server-side
   * (`getOrgEmailRouting` + core's fallback matrix) as plain strings, or
   * null when the org has no valid routing — the success overlay then
   * renders NO email action (fail closed; never another tenant's
   * mailboxes). The client re-brands through the validating factory at its
   * own seam.
   */
  deliveryRecipients: OrgEmailRoutingRecipientsDto | null;
}

type ReviewStage = null | 'review' | 'success';
type SubmittedOrder = { id: string; orderNumber: number | null; unitCount: number } | null;

export function OrdersStorefront(props: OrdersStorefrontProps) {
  const initial = initialCartState({
    warehouseId: props.warehouseId,
    fulfillmentType: 'pickup',
  });

  return (
    <CartProvider initial={initial}>
      <StorefrontShell {...props} />
    </CartProvider>
  );
}

/* ---- frequently-ordered fetch (GET /api/orders/freq) -------------------- */

interface FreqApiItem {
  itemId: string;
  sku: string;
  name: string;
  categoryName: string | null;
  imageUrl: string | null;
  available: number;
  quantityOnHand: number;
  count: number;
}

function useFreqItems(warehouseId: string): { items: FreqApiItem[]; loading: boolean } {
  const [items, setItems] = React.useState<FreqApiItem[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch lifecycle
    setLoading(true);
    setItems([]);

    fetch(`/api/orders/freq?warehouseId=${encodeURIComponent(warehouseId)}&limit=10`)
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as { items: FreqApiItem[] };
        if (!cancelled) setItems(body.items ?? []);
      })
      .catch(() => {
        /* carousel simply hides on failure */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [warehouseId]);

  return { items, loading };
}

/* ---- flow indicator ------------------------------------------------------ */

type FlowStage = 'browse' | 'cart' | 'review' | 'submit';
const FLOW_STEPS: Array<{ id: FlowStage; label: string }> = [
  { id: 'browse', label: 'Browse' },
  { id: 'cart', label: 'Cart' },
  { id: 'review', label: 'Review' },
  { id: 'submit', label: 'Submit' },
];

function FlowIndicator({ stage }: { stage: FlowStage }) {
  const idx = FLOW_STEPS.findIndex((s) => s.id === stage);
  return (
    <div className="sf-flow" aria-label="Order progress">
      {FLOW_STEPS.map((s, i) => (
        <React.Fragment key={s.id}>
          {i > 0 && <span className="sf-flow-sep" />}
          <span
            className="sf-flow-step"
            data-state={i < idx ? 'done' : i === idx ? 'active' : 'todo'}
          >
            <span className="fdot">
              {i < idx ? <Check size={10} strokeWidth={2.2} /> : null}
            </span>
            <span className="flabel">{s.label}</span>
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

/* ---- shell: head + setup bar render immediately --------------------------- */
/* (CatalogSkeleton lives in storefront-skeleton.tsx, shared with the
   route-level loading.tsx so the two loading states can't drift.) */

function StorefrontShell({
  warehouses,
  warehouseId,
  catalogPromise,
  chartersForWarehouse,
  viewerRole,
  viewerName,
  viewerEmail,
  orgTimezone,
  deliveryRecipients,
}: OrdersStorefrontProps) {
  const router = useRouter();
  const { state, dispatch } = useCart();

  const [openPop, setOpenPop] = React.useState<null | 'wh' | 'person' | 'site'>(null);
  const [pendingName, setPendingName] = React.useState('');
  const [pendingEmail, setPendingEmail] = React.useState('');

  // Review stage lives up here (not in the streamed catalog) so the
  // flow indicator in the always-visible head can reflect it.
  const [reviewStage, setReviewStage] = React.useState<ReviewStage>(null);
  const [submitted, setSubmitted] = React.useState<SubmittedOrder>(null);

  const warehouseName =
    warehouses.find((w) => w.id === warehouseId)?.name ?? warehouseId;
  const charter = chartersForWarehouse.find((c) => c.id === state.charterId) ?? null;
  const canActOnBehalf = isManagerOrAbove(
    viewerRole as Parameters<typeof isManagerOrAbove>[0],
  );
  const viewerLabel = viewerName?.trim() || viewerEmail;

  const { unitCount } = cartTotals(state.lines);
  const flowStage: FlowStage =
    reviewStage === 'success'
      ? 'submit'
      : reviewStage === 'review'
        ? 'review'
        : unitCount > 0
          ? 'cart'
          : 'browse';

  return (
    <div className="sp-storefront">
      <div className="sf-page">
        {/* ---------- Page head ---------- */}
        <div className="sf-head">
          <div>
            <Link href="/dashboard/orders" className="sf-back">
              <ChevronLeft size={12} /> Back to orders
            </Link>
            <h1 className="sf-title">Place an Order</h1>
            <div className="sf-sub">
              Browse available inventory, add items to your cart, and submit for
              approval.
            </div>
            <div className="mt-2"><PageTour tour={ORDER_CREATE_TOUR} /></div>
          </div>
          <FlowIndicator stage={flowStage} />
        </div>

        {/* ---------- Order setup bar ---------- */}
        <div className="sf-setup">
          {/* Warehouse */}
          <div
            className="sf-setup-cell"
            role="button"
            tabIndex={0}
            aria-haspopup="dialog"
            aria-expanded={openPop === 'wh'}
            onClick={() => setOpenPop(openPop === 'wh' ? null : 'wh')}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setOpenPop(openPop === 'wh' ? null : 'wh');
              }
            }}
          >
            <span className="sf-setup-ic">
              <Boxes size={15} />
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="lb">Warehouse</div>
              <div className="vl">
                {warehouseName}{' '}
                <span className="icon">
                  <ChevronDown size={11} />
                </span>
              </div>
            </div>
            <SfPopover open={openPop === 'wh'} onClose={() => setOpenPop(null)}>
              <div className="sf-pop-label">Ship from</div>
              {warehouses.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  className="sf-opt"
                  data-on={w.id === warehouseId}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenPop(null);
                    if (w.id !== warehouseId) {
                      router.push(
                        `/dashboard/orders/new?warehouseId=${encodeURIComponent(w.id)}`,
                      );
                    }
                  }}
                >
                  <span className="nm">{w.name}</span>
                  <span className="tick">
                    <Check size={14} />
                  </span>
                </button>
              ))}
            </SfPopover>
          </div>

          {/* Requesting for */}
          <div
            className="sf-setup-cell"
            role="button"
            tabIndex={0}
            aria-haspopup="dialog"
            aria-expanded={openPop === 'person'}
            onClick={() => {
              if (openPop === 'person') {
                setOpenPop(null);
              } else {
                setPendingName(state.onBehalfOf?.name ?? '');
                setPendingEmail(state.onBehalfOf?.email ?? '');
                setOpenPop('person');
              }
            }}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setOpenPop(openPop === 'person' ? null : 'person');
              }
            }}
          >
            <span className="sf-setup-ic">
              <Users size={15} />
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="lb">Requesting for</div>
              <div className="vl">
                {state.onBehalfOf ? state.onBehalfOf.name : 'Myself'}{' '}
                <span className="icon">
                  <ChevronDown size={11} />
                </span>
              </div>
              <div className="hint">
                {state.onBehalfOf
                  ? `On behalf · ${state.onBehalfOf.email}`
                  : viewerLabel}
              </div>
            </div>
            <SfPopover open={openPop === 'person'} onClose={() => setOpenPop(null)}>
              <button
                type="button"
                className="sf-opt"
                data-on={state.onBehalfOf === null}
                onClick={(e) => {
                  e.stopPropagation();
                  dispatch({ type: 'set-setup', patch: { onBehalfOf: null } });
                  setOpenPop(null);
                }}
              >
                <span style={{ minWidth: 0 }}>
                  <span className="nm" style={{ display: 'block' }}>
                    Myself
                  </span>
                  <span className="sb" style={{ display: 'block' }}>
                    {viewerLabel}
                    {viewerName ? ` · ${viewerEmail}` : ''}
                  </span>
                </span>
                <span className="tick">
                  <Check size={14} />
                </span>
              </button>
              {canActOnBehalf && (
                <>
                  <div className="sf-pop-label">On behalf of someone else</div>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                      padding: '0 2px 2px',
                    }}
                  >
                    <input
                      className="plain-input"
                      placeholder="Their name"
                      value={pendingName}
                      maxLength={120}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setPendingName(e.target.value)}
                    />
                    <input
                      className="plain-input"
                      type="email"
                      placeholder="their.email@example.com"
                      value={pendingEmail}
                      maxLength={254}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setPendingEmail(e.target.value)}
                    />
                    <button
                      type="button"
                      className="sf-btn-go"
                      style={{ justifyContent: 'center' }}
                      disabled={!pendingName.trim() || !pendingEmail.trim()}
                      onClick={(e) => {
                        e.stopPropagation();
                        dispatch({
                          type: 'set-setup',
                          patch: {
                            onBehalfOf: {
                              name: pendingName.trim(),
                              email: pendingEmail.trim(),
                            },
                          },
                        });
                        setOpenPop(null);
                      }}
                    >
                      <Check size={14} /> Set requester
                    </button>
                  </div>
                </>
              )}
            </SfPopover>
          </div>

          {/* Fulfillment segmented control */}
          <div className="sf-seg-wrap">
            <div>
              <div className="lb">Fulfillment</div>
              <div className="sf-seg" role="radiogroup" aria-label="Fulfillment type">
                <button
                  type="button"
                  data-active={state.fulfillmentType === 'pickup'}
                  aria-pressed={state.fulfillmentType === 'pickup'}
                  onClick={() =>
                    dispatch({
                      type: 'set-setup',
                      patch: { fulfillmentType: 'pickup', charterId: null },
                    })
                  }
                >
                  <Package size={13} /> Pickup
                </button>
                <button
                  type="button"
                  data-active={state.fulfillmentType === 'delivery'}
                  aria-pressed={state.fulfillmentType === 'delivery'}
                  onClick={() =>
                    dispatch({
                      type: 'set-setup',
                      patch: { fulfillmentType: 'delivery' },
                    })
                  }
                >
                  <Truck size={13} /> Delivery
                </button>
              </div>
            </div>
          </div>

          {/* Pick up at / Deliver to */}
          {state.fulfillmentType === 'pickup' ? (
            <div className="sf-setup-cell static">
              <span className="sf-setup-ic">
                <MapPin size={15} />
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="lb">Pick up at</div>
                <div className="vl">{warehouseName} will-call desk</div>
                <div className="hint">Ready within 1 business day of approval</div>
              </div>
            </div>
          ) : (
            <div
              className="sf-setup-cell"
              role="button"
              tabIndex={0}
              aria-haspopup="dialog"
              aria-expanded={openPop === 'site'}
              onClick={() => setOpenPop(openPop === 'site' ? null : 'site')}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setOpenPop(openPop === 'site' ? null : 'site');
                }
              }}
            >
              <span className="sf-setup-ic">
                <MapPin size={15} />
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="lb">Deliver to</div>
                <div className="vl">
                  {charter?.name ?? 'Choose a site…'}{' '}
                  <span className="icon">
                    <ChevronDown size={11} />
                  </span>
                </div>
                <div className="hint">{charter?.code ?? 'Delivery site'}</div>
              </div>
              <SfPopover
                open={openPop === 'site'}
                onClose={() => setOpenPop(null)}
                right
              >
                <div className="sf-pop-label">Delivery site</div>
                {chartersForWarehouse.length === 0 && (
                  <div className="sf-opt" style={{ cursor: 'default' }}>
                    <span className="sb">No delivery sites for this warehouse.</span>
                  </div>
                )}
                {chartersForWarehouse.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="sf-opt"
                    data-on={c.id === state.charterId}
                    onClick={(e) => {
                      e.stopPropagation();
                      dispatch({ type: 'set-setup', patch: { charterId: c.id } });
                      setOpenPop(null);
                    }}
                  >
                    <span style={{ minWidth: 0 }}>
                      <span className="nm" style={{ display: 'block' }}>
                        {c.name}
                      </span>
                      {c.code && (
                        <span className="sb" style={{ display: 'block' }}>
                          {c.code}
                        </span>
                      )}
                    </span>
                    <span className="tick">
                      <Check size={14} />
                    </span>
                  </button>
                ))}
              </SfPopover>
            </div>
          )}
        </div>

        {/* ---------- Catalog + cart: stream in behind the frame ---------- */}
        <React.Suspense fallback={<CatalogSkeleton />}>
          <StorefrontCatalog
            catalogPromise={catalogPromise}
            warehouseId={warehouseId}
            warehouseName={warehouseName}
            chartersForWarehouse={chartersForWarehouse}
            viewerLabel={viewerLabel}
            viewerEmail={viewerEmail}
            reviewStage={reviewStage}
            setReviewStage={setReviewStage}
            submitted={submitted}
            setSubmitted={setSubmitted}
            orgTimezone={orgTimezone}
            deliveryRecipients={deliveryRecipients}
          />
        </React.Suspense>
      </div>
    </div>
  );
}

/* ---- catalog body (suspends on the streamed items payload) ---------------- */

interface StorefrontCatalogProps {
  catalogPromise: Promise<StorefrontCatalogData>;
  warehouseId: string;
  warehouseName: string;
  chartersForWarehouse: StorefrontCharter[];
  viewerLabel: string;
  /** The viewer's own email — the `requesterEmail` fallback when nobody is set on-behalf-of. */
  viewerEmail: string;
  reviewStage: ReviewStage;
  setReviewStage: React.Dispatch<React.SetStateAction<ReviewStage>>;
  submitted: SubmittedOrder;
  setSubmitted: React.Dispatch<React.SetStateAction<SubmittedOrder>>;
  orgTimezone: string;
  /** See OrdersStorefrontProps.deliveryRecipients. */
  deliveryRecipients: OrgEmailRoutingRecipientsDto | null;
}

function StorefrontCatalog({
  catalogPromise,
  warehouseId,
  warehouseName,
  chartersForWarehouse,
  viewerLabel,
  viewerEmail,
  reviewStage,
  setReviewStage,
  submitted,
  setSubmitted,
  orgTimezone,
  deliveryRecipients,
}: StorefrontCatalogProps) {
  // Suspends until the server streams the catalog payload.
  const { items, aisles } = React.use(catalogPromise);

  const router = useRouter();
  const { state, dispatch, hydrated } = useCart();

  const itemMap = React.useMemo(
    () => new Map(items.map((it) => [it.id, it])),
    [items],
  );

  // ═══ "Start an order from Items" one-shot prefill ═══
  //
  // The Inventory bulk-action bar drops a { warehouseId, itemIds } blob in
  // sessionStorage and navigates here with ?warehouseId=<that>. Consume it
  // exactly once, AFTER cart hydration has settled (so the added lines sit on
  // top of any restored draft rather than being clobbered by a late hydrate),
  // and gate every id on the resolved catalog — the authority on what is
  // orderable in this warehouse. Skipped ids (out of stock, bundle, rental,
  // wrong warehouse, restricted category) are counted, not silently dropped.
  const prefillDone = React.useRef(false);
  React.useEffect(() => {
    if (prefillDone.current || !hydrated) return;
    prefillDone.current = true; // one attempt regardless of outcome
    const prefill = takeOrderPrefill(warehouseId);
    if (!prefill || prefill.itemIds.length === 0) return;

    const { addable, skipped } = partitionPrefillAgainstCatalog(prefill.itemIds, items);
    for (const itemId of addable) {
      // Default quantity 1 — the requester adjusts in the cart. `add` dedupes
      // by item, so re-adding an item already in a restored draft tops it up.
      dispatch({ type: 'add', itemId, quantity: 1 });
    }

    if (addable.length === 0) {
      toast.error(
        skipped === 1
          ? "That item isn't orderable from this warehouse right now."
          : "None of those items are orderable from this warehouse right now.",
      );
    } else {
      const added = `Added ${addable.length} item${addable.length === 1 ? '' : 's'} to your cart.`;
      const left =
        skipped > 0
          ? ` ${skipped} weren’t available here and were skipped.`
          : '';
      toast.success(added + left);
    }
    // Run once when hydration settles; deps are intentionally minimal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  /* --- frequently ordered --- */
  const { items: freqApiItems, loading: freqLoading } = useFreqItems(warehouseId);
  const freqEntries = React.useMemo<FreqEntry[]>(
    () =>
      freqApiItems.flatMap((f) => {
        const item = itemMap.get(f.itemId);
        if (!item) return [];
        // The freq endpoint signs its own 200px thumbnails — fall back
        // to them when the catalog row has no resolved URL so items
        // with photos never show a letter glyph in the carousel.
        return [
          { item: { ...item, imageUrl: item.imageUrl ?? f.imageUrl }, count: f.count },
        ];
      }),
    [freqApiItems, itemMap],
  );
  const freqByItemId = React.useMemo(
    () => new Map(freqApiItems.map((f) => [f.itemId, f.count])),
    [freqApiItems],
  );
  const suggestions = React.useMemo(
    () =>
      freqEntries
        .filter((e) => availableOf(e.item) > 0)
        .slice(0, 3)
        .map((e) => ({ itemId: e.item.id, name: e.item.name })),
    [freqEntries],
  );

  /* --- catalog UI state --- */
  const [category, setCategory] = React.useState<CategoryFilter>('all');
  const [searchInput, setSearchInput] = React.useState('');
  const deferredSearch = React.useDeferredValue(searchInput);
  const [availability, setAvailability] = React.useState<ReadonlySet<ItemStatus>>(
    () => new Set<ItemStatus>(),
  );
  const [sort, setSort] = React.useState<SortKey>('featured');
  const [view, setView] = React.useState<ViewMode>('grid');
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [toolPop, setToolPop] = React.useState<null | 'avail' | 'sort'>(null);

  /* --- overlays --- */
  const [quickId, setQuickId] = React.useState<string | null>(null);
  const [isPending, startTransition] = React.useTransition();

  /* --- cart callbacks (stable so React.memo cards actually skip) --- */
  const linesRef = React.useRef(state.lines);
  React.useEffect(() => {
    linesRef.current = state.lines;
  }, [state.lines]);

  const handleAdd = React.useCallback(
    (itemId: string) => {
      const item = itemMap.get(itemId);
      if (!item) return;
      const avail = availableOf(item);
      const qty = linesRef.current.find((l) => l.itemId === itemId)?.quantity ?? 0;
      if (avail <= 0 || qty >= avail) return;
      dispatch({ type: 'add', itemId });
    },
    [itemMap, dispatch],
  );
  const handleDec = React.useCallback(
    (itemId: string) => dispatch({ type: 'dec', itemId }),
    [dispatch],
  );
  // Typed quantities arrive pre-clamped by QtyField (0..available);
  // set-qty at ≤0 removes the line.
  const handleSetQty = React.useCallback(
    (itemId: string, quantity: number) => dispatch({ type: 'set-qty', itemId, quantity }),
    [dispatch],
  );
  const handleQuickView = React.useCallback((itemId: string) => setQuickId(itemId), []);
  // Stabilized so ReviewModal's own focus-management effects (keyed in part
  // on `onClose`) don't churn on every unrelated re-render of this component
  // — an inline `() => setReviewStage(null)` here would be a brand-new
  // function every render, forcing the modal's keydown-listener effect to
  // tear down and rebind constantly while it is open.
  const handleReviewClose = React.useCallback(() => setReviewStage(null), [setReviewStage]);

  const handleAddKit = React.useCallback(
    (kitItems: CatalogItem[]) => {
      for (const line of fullKitLines(kitItems)) {
        const item = itemMap.get(line.itemId);
        if (!item) continue;
        const qty = linesRef.current.find((l) => l.itemId === line.itemId)?.quantity ?? 0;
        if (qty < availableOf(item)) {
          dispatch({ type: 'add', itemId: line.itemId, quantity: line.quantity });
        }
      }
    },
    [itemMap, dispatch],
  );

  /* --- filtering + grouping --- */
  const filterInput = React.useMemo(
    () => ({ category, search: deferredSearch, availability }),
    [category, deferredSearch, availability],
  );
  const filtered = React.useMemo(
    () => sortCatalog(filterCatalog(items, filterInput), sort, freqByItemId),
    [items, filterInput, sort, freqByItemId],
  );
  const browsingAll = isBrowsingAll(filterInput);

  const statusCounts = React.useMemo(() => {
    const counts: Record<ItemStatus, number> = { ok: 0, low: 0, out: 0 };
    for (const it of items) counts[statusOf(it)] += 1;
    return counts;
  }, [items]);

  const grouped = React.useMemo(() => {
    if (!browsingAll) return null;
    return aisles
      .map((a) => {
        const key = a.id ?? 'uncategorized';
        return {
          key,
          name: a.name,
          items: filtered.filter((it) => (it.categoryId ?? 'uncategorized') === key),
        };
      })
      .filter((g) => g.items.length > 0);
  }, [aisles, filtered, browsingAll]);

  const qtyMap = React.useMemo(() => buildQtyMap(state.lines), [state.lines]);
  const { unitCount } = cartTotals(state.lines);

  const charter = chartersForWarehouse.find((c) => c.id === state.charterId) ?? null;

  const cartContext: CartContextInfo = {
    warehouseName,
    method: state.fulfillmentType,
    siteName: charter?.name ?? null,
    requesterLabel: state.onBehalfOf
      ? `For ${state.onBehalfOf.name.split(/\s+/)[0]}`
      : 'For you',
  };

  const railRef = React.useRef<HTMLDivElement>(null);

  /* --- submit (createOrderRequestAction payload + validation) --- */
  function handleConfirmSubmit() {
    const lines = state.lines;
    if (lines.length === 0) {
      toast.error('Add at least one item to your cart before submitting.');
      return;
    }
    if (state.fulfillmentType === 'delivery' && !state.charterId) {
      toast.error('Select a delivery site in the setup bar above.');
      return;
    }
    if (state.onBehalfOf) {
      if (!state.onBehalfOf.name.trim() || !state.onBehalfOf.email.trim()) {
        toast.error("Complete the requester's name and email above.");
        return;
      }
    }

    startTransition(async () => {
      const res = await createOrderRequestAction({
        warehouseId: state.warehouseId,
        notes: state.notes.trim() || null,
        // datetime-local has no offset; Date() interprets it in the user's
        // zone, toISOString() normalizes to UTC for the zod .datetime check.
        neededBy: state.neededBy ? new Date(state.neededBy).toISOString() : null,
        fulfillmentType: state.fulfillmentType,
        requesterPhone: null,
        deliveryCharterId:
          state.fulfillmentType === 'delivery' ? (state.charterId ?? null) : null,
        pickupLocationNotes: null,
        onBehalfOf: state.onBehalfOf
          ? {
              name: state.onBehalfOf.name.trim(),
              email: state.onBehalfOf.email.trim(),
            }
          : null,
        lines: lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
      });

      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }

      // Clear the persisted draft right away so a reload doesn't
      // resurrect the just-submitted cart. In-memory lines stay until
      // "Done" so the success screen can still show them.
      clearCartDraft(warehouseId);
      setSubmitted({
        id: res.data.id,
        orderNumber: res.data.orderNumber,
        unitCount: lines.reduce((s, l) => s + l.quantity, 0),
      });
      setReviewStage('success');
    });
  }

  function handleDone() {
    // ONE `reset`, not clear + set-notes. Those two emptied the basket and the
    // notes and left everything else standing, so the finished order's
    // requester (and its needed-by date) opened the NEXT order pre-filled with
    // the last person's name and email — the 2026-08-19 report. `reset` returns
    // the whole cart to what a fresh page load builds.
    //
    // clearCartDraft still runs, and now it holds: the debounced writer
    // recognises a pristine cart and removes the key rather than re-persisting
    // the state this dispatch just cleaned.
    clearCartDraft(warehouseId);
    dispatch({ type: 'reset' });
    setReviewStage(null);
    setSubmitted(null);
  }

  function handleViewOrder() {
    if (submitted) router.push(`/dashboard/orders/${submitted.id}`);
  }

  /* --- small helpers --- */
  const toggleAvailability = (status: ItemStatus) => {
    setAvailability((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  const clearAllFilters = () => {
    setSearchInput('');
    setAvailability(new Set<ItemStatus>());
    setCategory('all');
  };

  const activeCategoryName =
    category === 'all'
      ? 'All products'
      : (aisles.find((a) => (a.id ?? 'uncategorized') === category)?.name ??
        'Category');

  const renderItems = (list: CatalogItem[]) =>
    view === 'grid' ? (
      <div className="sf-grid">
        {list.map((it) => (
          <ProductCard
            key={it.id}
            item={it}
            qty={qtyMap.get(it.id) ?? 0}
            onAdd={handleAdd}
            onDec={handleDec}
            onSetQty={handleSetQty}
            onQuickView={handleQuickView}
          />
        ))}
      </div>
    ) : (
      <div className="sf-rows">
        {list.map((it) => (
          <CompactRow
            key={it.id}
            item={it}
            qty={qtyMap.get(it.id) ?? 0}
            onAdd={handleAdd}
            onDec={handleDec}
            onSetQty={handleSetQty}
            onQuickView={handleQuickView}
          />
        ))}
      </div>
    );

  const previewCount = view === 'grid' ? GRID_PREVIEW : LIST_PREVIEW;
  const quickItem = quickId ? (itemMap.get(quickId) ?? null) : null;
  const hasFilterChips = searchInput.trim() !== '' || availability.size > 0;

  return (
    <>
      <div className="sf-shell">
        <div style={{ minWidth: 0 }}>
          {/* Sticky toolbar */}
          <div className="sf-sticky">
            <div className="sf-tools">
              <div className="sf-search">
                <span className="icon">
                  <Search size={15} />
                </span>
                <input
                  placeholder="Search products, SKU, category…"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  aria-label="Search catalog"
                />
                {searchInput !== '' && (
                  <button
                    type="button"
                    className="clear"
                    onClick={() => setSearchInput('')}
                    aria-label="Clear search"
                  >
                    <X size={11} />
                  </button>
                )}
              </div>

              <div className="sf-popwrap">
                <button
                  type="button"
                  className="sf-tool-btn"
                  data-on={availability.size > 0}
                  onClick={() => setToolPop(toolPop === 'avail' ? null : 'avail')}
                  aria-haspopup="dialog"
                  aria-expanded={toolPop === 'avail'}
                >
                  <Filter size={13} /> Availability
                  {availability.size > 0 && (
                    <span className="bdg">{availability.size}</span>
                  )}
                  <ChevronDown size={11} />
                </button>
                <SfPopover
                  open={toolPop === 'avail'}
                  onClose={() => setToolPop(null)}
                  width={216}
                >
                  {(['ok', 'low', 'out'] as const).map((id) => (
                    <button
                      key={id}
                      type="button"
                      className="sf-opt"
                      data-on={availability.has(id)}
                      onClick={() => toggleAvailability(id)}
                    >
                      <span className="sf-cb" data-checked={availability.has(id)} />
                      <span className="nm" style={{ fontWeight: 400 }}>
                        {AVAILABILITY_LABELS[id]}
                      </span>
                      <span className="ct">{statusCounts[id]}</span>
                    </button>
                  ))}
                </SfPopover>
              </div>

              <div className="sf-popwrap">
                <button
                  type="button"
                  className="sf-tool-btn"
                  onClick={() => setToolPop(toolPop === 'sort' ? null : 'sort')}
                  aria-haspopup="dialog"
                  aria-expanded={toolPop === 'sort'}
                >
                  <ArrowUpDown size={13} />{' '}
                  {SORT_OPTIONS.find((s) => s.id === sort)?.label ?? 'Featured'}
                  <ChevronDown size={11} />
                </button>
                <SfPopover
                  open={toolPop === 'sort'}
                  onClose={() => setToolPop(null)}
                  right
                  width={210}
                >
                  {SORT_OPTIONS.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="sf-opt"
                      data-on={s.id === sort}
                      onClick={() => {
                        setSort(s.id);
                        setToolPop(null);
                      }}
                    >
                      <span className="nm" style={{ fontWeight: 400 }}>
                        {s.label}
                      </span>
                      <span className="tick">
                        <Check size={14} />
                      </span>
                    </button>
                  ))}
                </SfPopover>
              </div>

              <div className="sf-viewseg">
                <button
                  type="button"
                  data-active={view === 'grid'}
                  title="Grid view"
                  aria-label="Grid view"
                  onClick={() => setView('grid')}
                >
                  <LayoutGrid size={14} />
                </button>
                <button
                  type="button"
                  data-active={view === 'compact'}
                  title="Compact view"
                  aria-label="Compact view"
                  onClick={() => setView('compact')}
                >
                  <List size={14} />
                </button>
              </div>
            </div>

            {/* Category pills */}
            <div className="sf-pills">
              <button
                type="button"
                className="sf-pill"
                data-active={category === 'all'}
                onClick={() => setCategory('all')}
              >
                All <span className="ct">{items.length}</span>
              </button>
              {aisles.map((a) => {
                const key = a.id ?? 'uncategorized';
                return (
                  <button
                    key={key}
                    type="button"
                    className="sf-pill"
                    data-active={category === key}
                    onClick={() => setCategory(category === key ? 'all' : key)}
                  >
                    <span className="icon">
                      <Package size={13} />
                    </span>
                    {a.name} <span className="ct">{a.itemCount}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Active filter chips */}
          {hasFilterChips && (
            <div className="sf-chips">
              {searchInput.trim() !== '' && (
                <span className="sf-chip">
                  “{searchInput.trim()}”
                  <button
                    type="button"
                    onClick={() => setSearchInput('')}
                    aria-label="Clear search filter"
                  >
                    <X size={10} />
                  </button>
                </span>
              )}
              {[...availability].map((a) => (
                <span className="sf-chip" key={a}>
                  {AVAILABILITY_LABELS[a]}
                  <button
                    type="button"
                    onClick={() => toggleAvailability(a)}
                    aria-label={`Remove ${AVAILABILITY_LABELS[a]} filter`}
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
              <button type="button" className="clear-all" onClick={clearAllFilters}>
                Clear all
              </button>
            </div>
          )}

          {/* Frequently ordered (unfiltered All view only) */}
          {browsingAll && (
            <FreqCarousel
              entries={freqEntries}
              qtyByItemId={qtyMap}
              loading={freqLoading}
              onAdd={handleAdd}
              onDec={handleDec}
              onSetQty={handleSetQty}
              onQuickView={handleQuickView}
            />
          )}

          {/* Catalog: grouped sections or flat filtered grid */}
          {grouped && grouped.length > 0 ? (
            grouped.map((g) => (
              <CategorySection
                key={g.key}
                name={g.name}
                itemCount={g.items.length}
                open={!collapsed.has(g.key)}
                onToggle={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(g.key)) next.delete(g.key);
                    else next.add(g.key);
                    return next;
                  })
                }
                shownCount={previewCount}
                onViewAll={() => setCategory(g.key)}
                showKitButton={NEW_HIRE_RE.test(g.name)}
                onAddKit={() => handleAddKit(g.items)}
                icon={<Package size={15} />}
              >
                {renderItems(g.items.slice(0, previewCount))}
              </CategorySection>
            ))
          ) : (
            <>
              <div className="sf-result-line">
                <span className="n">{activeCategoryName}</span>
                <span className="m">
                  {filtered.length} {filtered.length === 1 ? 'item' : 'items'}
                  {deferredSearch.trim() ? ' matching' : ''}
                </span>
              </div>
              {filtered.length === 0 ? (
                <EmptyResults
                  query={deferredSearch.trim()}
                  onClear={clearAllFilters}
                />
              ) : (
                renderItems(filtered)
              )}
            </>
          )}
        </div>

        {/* Cart rail */}
        <div className="sf-rail" ref={railRef}>
          <CartRail
            itemMap={itemMap}
            suggestions={suggestions}
            context={cartContext}
            onAdd={handleAdd}
            onDec={handleDec}
            onSetQty={handleSetQty}
            onReview={() => setReviewStage('review')}
          />
        </div>
      </div>

      {/* Floating cart FAB (stacked layout) */}
      <CartFab
        unitCount={unitCount}
        onClick={() =>
          railRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      />

      {/* Quick view drawer */}
      <QuickViewDrawer
        item={quickItem}
        qty={quickItem ? (qtyMap.get(quickItem.id) ?? 0) : 0}
        onAdd={handleAdd}
        onDec={handleDec}
        onSetQty={handleSetQty}
        onClose={() => setQuickId(null)}
      />

      {/* Review → success modal */}
      <ReviewModal
        stage={reviewStage}
        lines={state.lines}
        itemMap={itemMap}
        notes={state.notes}
        summary={{
          warehouseName,
          method: state.fulfillmentType,
          deliverTo:
            state.fulfillmentType === 'pickup'
              ? `${warehouseName} will-call desk`
              : (charter?.name ?? 'Select a site'),
          requestedFor: state.onBehalfOf?.name ?? viewerLabel,
          requesterEmail: state.onBehalfOf?.email ?? viewerEmail,
          orgTimezone,
        }}
        neededBy={state.neededBy}
        destination={state.fulfillmentType === 'delivery' ? charter : null}
        deliveryRecipients={deliveryRecipients}
        submitting={isPending}
        submitted={submitted}
        onClose={handleReviewClose}
        onConfirm={handleConfirmSubmit}
        onViewOrder={handleViewOrder}
        onDone={handleDone}
      />
    </>
  );
}
