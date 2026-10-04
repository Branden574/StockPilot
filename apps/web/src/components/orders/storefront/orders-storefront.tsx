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

import { usePerfUseful } from '@/components/perf/perf-useful';

import {
  CART_TITLE_COPY,
  kitNotEnoughCopy,
  mintOrderSubmissionKey,
  orderSubmissionLocked,
  orderUnconfirmedCopy,
  orderRefusalCopy,
  ORDER_WITHDRAWN_COPY,
  STOREFRONT_CHOOSE_SITE_COPY,
  STOREFRONT_DELIVER_TO_COPY,
  STOREFRONT_DELIVERY_SITE_COPY,
  STOREFRONT_FOR_COPY,
  STOREFRONT_MYSELF_COPY,
  STOREFRONT_NO_DELIVERY_SITES_COPY,
  STOREFRONT_ON_BEHALF_EMAIL_PLACEHOLDER_COPY,
  STOREFRONT_ON_BEHALF_NAME_PLACEHOLDER_COPY,
  STOREFRONT_PICK_UP_AT_COPY,
  STOREFRONT_PICKUP_OR_DELIVERY_COPY,
  STOREFRONT_SEARCH_PLACEHOLDER_COPY,
  STOREFRONT_SHIP_FROM_COPY,
  STOREFRONT_SOMEONE_NEW_COPY,
  STOREFRONT_TITLE_COPY,
  storefrontPickupHintCopy,
  storefrontWillCallDeskCopy,
  SUBMIT_NO_LINES_COPY,
  SUBMIT_NO_SITE_COPY,
  SUBMIT_ON_BEHALF_INCOMPLETE_COPY,
  SUBMIT_REMOVE_UNORDERABLE_COPY,
  type OrderCreateRequestInput,
  type OrgEmailRoutingRecipientsDto,
} from '@stockpilot/core';

import {
  CartProvider,
  clearCartDraft,
  initialCartState,
  ORDER_DRAFT_PREFIX,
  orderDraftPrefixFor,
  useCart,
} from '../v2/cart-context';
import { cartStateFromPendingBody, useOrderSubmission, type OrderSubmissionControl } from './order-submission';
import {
  partitionPrefillAgainstCatalog,
  takeOrderPrefill,
} from '@/lib/orders/start-order-prefill';
import type { AisleSummary, CatalogItem, StorefrontCharter } from '../v2/types';
import type { FrequentlyOrderedEntry } from '@/server/loaders/orders-frequently-ordered';

import {
  CategorySection,
  CompactRow,
  EmptyResults,
  FreqCarousel,
  ProductCard,
  type FreqEntry,
} from './storefront-cards';
import { CartFab, CartRail, type CartContextInfo } from './storefront-cart';
import {
  KitGrid,
  KitsErrorBoundary,
  KitsRow,
  KitsRowSkeleton,
  KitsUnavailable,
} from './storefront-kit-card';
import {
  componentItem,
  filterKits,
  kitsForAudit,
  planKitChange,
  type KitOffer,
  type KitsResult,
} from './storefront-kits';
import { settledOutcome, useSettled, watchSettled } from './settled-promise';
import { CatalogSkeleton } from './storefront-skeleton';
import {
  AVAILABILITY_LABELS,
  DEFAULT_SORT,
  SORT_OPTIONS,
  availableOf,
  buildQtyMap,
  cartTotals,
  filterCatalog,
  isBrowsingAll,
  sortCatalog,
  statusOf,
  type CategoryFilter,
  type ItemStatus,
  type SortKey,
  type ViewMode,
} from './storefront-logic';
import { QuickViewDrawer, ReviewModal, SfPopover } from './storefront-overlays';
import { toFreqEntries, useStreamed } from './frequently-ordered';

import './storefront.css';
import { PageTour } from '@/components/onboarding/page-tour';
import { ORDER_CREATE_TOUR } from '@/lib/onboarding/tours';

const GRID_PREVIEW = 4;
const NO_REFUSED_ITEMS: ReadonlyMap<string, string> = new Map();
const LIST_PREVIEW = 6;

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
  /**
   * Un-awaited too, and never rejects (`loadFrequentlyOrdered`). It used to be
   * a browser fetch that could only start after hydration, which is why the
   * first row of photos trailed the catalog by most of a second.
   */
  frequentlyOrderedPromise: Promise<FrequentlyOrderedEntry[]>;
  /**
   * The kits (bundles) this person can order here, un-awaited too and never
   * rejects (`loadOrderKits`). A failed read arrives as `{ status: 'error' }`.
   */
  kitsPromise: Promise<KitsResult>;
  /**
   * Whether the Bundles module is on for this organization, known when the
   * page renders (request-cached with the layout's own module read). It only
   * decides whether the Kits row's place is kept while the kits stream in; the
   * kits themselves always come from `kitsPromise`.
   */
  kitsEnabled: boolean;
  chartersForWarehouse: StorefrontCharter[];
  /**
   * Whether the viewer may order on someone else's behalf: the EFFECTIVE
   * orders:approve permission (overrides applied), computed by the server page
   * with can(ctx, ...), because this client component has no request context.
   * It is the rule the order_requests_insert policy's on-behalf branch applies
   * since 0390, and the one createOrderRequestAction re-checks.
   */
  canActOnBehalf: boolean;
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
  /**
   * The signed-in user (phone ordering PO-2): the cart draft and the pending
   * send are kept under this account only (judge X-1), and the create body
   * names it as the placer, which the database checks against the session.
   */
  viewerUserId: string;
  /** The organization the page was rendered for; part of the pending key. */
  organizationId: string;
  /**
   * Whether the success screen offers Review and approve: the effective
   * orders:approve, never for a viewer (security slice D, the order page's
   * approve gate), computed by the server page.
   */
  canApproveOrders: boolean;
}

type ReviewStage = null | 'review' | 'success';

export function OrdersStorefront(props: OrdersStorefrontProps) {
  const initial = initialCartState({
    warehouseId: props.warehouseId,
    fulfillmentType: 'pickup',
  });

  // ═══ ONE CART PER WAREHOUSE, KEYED ═══
  //
  // The warehouse control is a router.push to ?warehouseId=<new>, and Next keys
  // the page without its search params, so this component is NOT remounted: it
  // gets the new warehouse as a prop. The cart's reducer only reads `initial`
  // on mount, so it kept the first warehouse. The draft saved under the old
  // warehouse's key, Submit sent the old warehouse, and the server refused
  // every line with "Every line must be at the chosen warehouse" (local walk,
  // 2026-09-26). Keying the provider by warehouse mounts a fresh cart that
  // restores that warehouse's own draft, as the New rental page does.
  //
  // ONE ACCOUNT'S CART (phone ordering PO-2, judge X-1): the draft is saved
  // under the signed-in user, and a draft left under the old account-less key
  // is adopted once without its on-behalf name and email.
  return (
    <CartProvider
      key={props.warehouseId}
      initial={initial}
      draftPrefix={orderDraftPrefixFor(props.viewerUserId)}
      legacyDraftPrefix={ORDER_DRAFT_PREFIX}
    >
      <StorefrontShell {...props} />
    </CartProvider>
  );
}

/* ---- frequently ordered (streamed with the page) -------------------------- */

/** The strip, suspended on its own: the catalog grid never waits for it. */
function FrequentlyOrderedStrip({
  promise,
  itemMap,
  ...carousel
}: {
  promise: Promise<FrequentlyOrderedEntry[]>;
  itemMap: Map<string, CatalogItem>;
} & Omit<React.ComponentProps<typeof FreqCarousel>, 'entries' | 'loading'>) {
  const entries = toFreqEntries(React.use(promise), itemMap);
  return <FreqCarousel entries={entries} loading={false} {...carousel} />;
}

/* ---- flow indicator ------------------------------------------------------ */

type FlowStage = 'browse' | 'cart' | 'review' | 'submit';
const FLOW_STEPS: Array<{ id: FlowStage; label: string }> = [
  { id: 'browse', label: 'Browse' },
  { id: 'cart', label: CART_TITLE_COPY },
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
  frequentlyOrderedPromise,
  kitsPromise,
  kitsEnabled,
  chartersForWarehouse,
  canActOnBehalf,
  viewerName,
  viewerEmail,
  orgTimezone,
  deliveryRecipients,
  viewerUserId,
  organizationId,
  canApproveOrders,
}: OrdersStorefrontProps) {
  const router = useRouter();
  const { state, dispatch, hydrated, locked, setLocked } = useCart();

  const [openPop, setOpenPop] = React.useState<null | 'wh' | 'person' | 'site'>(null);
  const [pendingName, setPendingName] = React.useState('');
  const [pendingEmail, setPendingEmail] = React.useState('');

  // Review stage lives up here (not in the streamed catalog) so the
  // flow indicator in the always-visible head can reflect it.
  const [reviewStage, setReviewStage] = React.useState<ReviewStage>(null);

  // The submission key and its pending record (order-submission.ts). Read
  // here, above the streamed catalog, so a send left unsettled by a reload
  // locks the setup bar and the warehouse switch at once.
  const submission = useOrderSubmission({
    userId: viewerUserId,
    organizationId,
    warehouseId,
    hydrated,
    setLocked,
    onRestore: (body) =>
      dispatch({ type: 'hydrate', state: cartStateFromPendingBody(body, warehouseId) }),
  });
  // An unsettled send opens (and keeps) the review on its panel, a placed
  // order its success screen. Set while rendering when the phase changes (the
  // React pattern for state derived from a change), so a send that settles as
  // refused or withdrawn stays on screen until the person closes it.
  const phase = submission.state.phase;
  const [seenPhase, setSeenPhase] = React.useState(phase);
  if (phase !== seenPhase) {
    setSeenPhase(phase);
    if (phase === 'sending' || phase === 'unconfirmed' || phase === 'withdrawing') {
      setReviewStage('review');
    } else if (phase === 'placed') {
      setReviewStage('success');
    }
  }
  // Opening a popover on the setup bar does nothing while the cart is locked.
  const toggle = (pop: 'wh' | 'person' | 'site') =>
    setOpenPop((open) => (locked ? null : open === pop ? null : pop));

  const warehouseName =
    warehouses.find((w) => w.id === warehouseId)?.name ?? warehouseId;
  const charter = chartersForWarehouse.find((c) => c.id === state.charterId) ?? null;
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
            <h1 className="sf-title">{STOREFRONT_TITLE_COPY}</h1>
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
            aria-disabled={locked}
            onClick={() => toggle('wh')}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggle('wh');
              }
            }}
          >
            <span className="sf-setup-ic">
              <Boxes size={15} />
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="lb">{STOREFRONT_SHIP_FROM_COPY}</div>
              <div className="vl">
                {warehouseName}{' '}
                <span className="icon">
                  <ChevronDown size={11} />
                </span>
              </div>
            </div>
            <SfPopover open={openPop === 'wh' && !locked} onClose={() => setOpenPop(null)}>
              <div className="sf-pop-label">{STOREFRONT_SHIP_FROM_COPY}</div>
              {warehouses.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  className="sf-opt"
                  data-on={w.id === warehouseId}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenPop(null);
                    if (w.id !== warehouseId && !locked) {
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

          {/* For (who the order is for) */}
          <div
            className="sf-setup-cell"
            role="button"
            tabIndex={0}
            aria-haspopup="dialog"
            aria-expanded={openPop === 'person'}
            aria-disabled={locked}
            onClick={() => {
              if (openPop === 'person' || locked) {
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
                toggle('person');
              }
            }}
          >
            <span className="sf-setup-ic">
              <Users size={15} />
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="lb">{STOREFRONT_FOR_COPY}</div>
              <div className="vl">
                {state.onBehalfOf ? state.onBehalfOf.name : STOREFRONT_MYSELF_COPY}{' '}
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
            <SfPopover open={openPop === 'person' && !locked} onClose={() => setOpenPop(null)}>
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
                    {STOREFRONT_MYSELF_COPY}
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
                  <div className="sf-pop-label">{STOREFRONT_SOMEONE_NEW_COPY}</div>
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
                      placeholder={STOREFRONT_ON_BEHALF_NAME_PLACEHOLDER_COPY}
                      value={pendingName}
                      maxLength={120}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setPendingName(e.target.value)}
                    />
                    <input
                      className="plain-input"
                      type="email"
                      placeholder={STOREFRONT_ON_BEHALF_EMAIL_PLACEHOLDER_COPY}
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
              <div className="lb">{STOREFRONT_PICKUP_OR_DELIVERY_COPY}</div>
              <div className="sf-seg" role="radiogroup" aria-label="Fulfillment type">
                <button
                  type="button"
                  disabled={locked}
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
                  disabled={locked}
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
                <div className="lb">{STOREFRONT_PICK_UP_AT_COPY}</div>
                <div className="vl">{storefrontWillCallDeskCopy(warehouseName)}</div>
                <div className="hint">{storefrontPickupHintCopy(warehouseName)}</div>
              </div>
            </div>
          ) : (
            <div
              className="sf-setup-cell"
              role="button"
              tabIndex={0}
              aria-haspopup="dialog"
              aria-expanded={openPop === 'site'}
              aria-disabled={locked}
              onClick={() => toggle('site')}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggle('site');
                }
              }}
            >
              <span className="sf-setup-ic">
                <MapPin size={15} />
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="lb">{STOREFRONT_DELIVER_TO_COPY}</div>
                <div className="vl">
                  {charter?.name ?? STOREFRONT_CHOOSE_SITE_COPY}{' '}
                  <span className="icon">
                    <ChevronDown size={11} />
                  </span>
                </div>
                <div className="hint">{charter?.code ?? STOREFRONT_DELIVERY_SITE_COPY}</div>
              </div>
              <SfPopover
                open={openPop === 'site' && !locked}
                onClose={() => setOpenPop(null)}
                right
              >
                <div className="sf-pop-label">{STOREFRONT_DELIVERY_SITE_COPY}</div>
                {chartersForWarehouse.length === 0 && (
                  <div className="sf-opt" style={{ cursor: 'default' }}>
                    <span className="sb">{STOREFRONT_NO_DELIVERY_SITES_COPY}</span>
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
            frequentlyOrderedPromise={frequentlyOrderedPromise}
            kitsPromise={kitsPromise}
            kitsEnabled={kitsEnabled}
            warehouseId={warehouseId}
            warehouseName={warehouseName}
            chartersForWarehouse={chartersForWarehouse}
            viewerLabel={viewerLabel}
            viewerEmail={viewerEmail}
            reviewStage={reviewStage}
            setReviewStage={setReviewStage}
            orgTimezone={orgTimezone}
            deliveryRecipients={deliveryRecipients}
            submission={submission}
            viewerUserId={viewerUserId}
            canApproveOrders={canApproveOrders}
          />
        </React.Suspense>
      </div>
    </div>
  );
}

/* ---- a category, search or filtered view --------------------------------- */

type KitGridProps = Omit<React.ComponentProps<typeof KitGrid>, 'kits'>;

interface FlatResultsProps {
  title: string;
  itemCount: number;
  searching: boolean;
  kits: KitOffer[];
  /**
   * What is known about the kits: 'ok' when the read answered (`kits` is the
   * whole answer for this view), 'pending' while it streams, 'error' when it
   * failed. Only 'ok' may end in "Nothing matches": a kit read that failed or
   * has not answered is never shown as "no kits" (walk 2026-09-27, review F4).
   */
  kitsState: 'ok' | 'pending' | 'error';
  kitGridProps: KitGridProps;
  /** Shown when neither an item nor a kit matches. */
  empty: React.ReactNode;
  /** The matching items, already rendered (null when none match). */
  children: React.ReactNode;
}

/** The result line, the matching kits first, then the matching items. */
function FlatResults({
  title,
  itemCount,
  searching,
  kits,
  kitsState,
  kitGridProps,
  empty,
  children,
}: FlatResultsProps) {
  let rest: React.ReactNode = children;
  if (itemCount === 0 && kits.length === 0) {
    rest =
      kitsState === 'ok' ? (
        empty
      ) : kitsState === 'pending' ? (
        <p className="sf-kits-pending" role="status">
          Checking the kits…
        </p>
      ) : null; // 'error': KitsUnavailable above already says what happened
  }
  return (
    <>
      <div className="sf-result-line">
        <span className="n">{title}</span>
        <span className="m">
          {itemCount} {itemCount === 1 ? 'item' : 'items'}
          {kits.length > 0 ? ` · ${kits.length} ${kits.length === 1 ? 'kit' : 'kits'}` : ''}
          {searching ? ' matching' : ''}
        </span>
      </div>
      {kitsState === 'error' && <KitsUnavailable />}
      {kits.length > 0 && <KitGrid kits={kits} {...kitGridProps} />}
      {rest}
    </>
  );
}

/**
 * FlatResults with the kits that match the view. It does NOT suspend on the
 * kits: the search box is a deferred value, and a deferred render that
 * suspends is dropped, so while the kits read was out a search changed nothing
 * on screen. The items draw at once; the kits join them when they arrive, and
 * a read that failed (or a stream that broke) says so.
 */
function FlatResultsWithKits({
  promise,
  filterInput,
  ...rest
}: Omit<FlatResultsProps, 'kits' | 'kitsState'> & {
  promise: Promise<KitsResult>;
  filterInput: Parameters<typeof filterKits>[2];
}) {
  const outcome = useSettled(promise);
  const kitsState: FlatResultsProps['kitsState'] =
    outcome === undefined ? 'pending' : outcome.ok ? outcome.value.status : 'error';
  const offered = outcome?.ok && outcome.value.status === 'ok' ? outcome.value.kits : null;
  const kits = React.useMemo(
    () => (offered ? filterKits(offered, rest.kitGridProps.itemMap, filterInput) : []),
    [offered, rest.kitGridProps.itemMap, filterInput],
  );
  return <FlatResults kits={kits} kitsState={kitsState} {...rest} />;
}

/* ---- catalog body (suspends on the streamed items payload) ---------------- */

interface StorefrontCatalogProps {
  catalogPromise: Promise<StorefrontCatalogData>;
  frequentlyOrderedPromise: Promise<FrequentlyOrderedEntry[]>;
  kitsPromise: Promise<KitsResult>;
  kitsEnabled: boolean;
  warehouseId: string;
  warehouseName: string;
  chartersForWarehouse: StorefrontCharter[];
  viewerLabel: string;
  /** The viewer's own email — the `requesterEmail` fallback when nobody is set on-behalf-of. */
  viewerEmail: string;
  reviewStage: ReviewStage;
  setReviewStage: React.Dispatch<React.SetStateAction<ReviewStage>>;
  orgTimezone: string;
  /** See OrdersStorefrontProps.deliveryRecipients. */
  deliveryRecipients: OrgEmailRoutingRecipientsDto | null;
  /** The submission key (order-submission.ts), owned by the shell. */
  submission: OrderSubmissionControl;
  viewerUserId: string;
  canApproveOrders: boolean;
}

function StorefrontCatalog({
  catalogPromise,
  frequentlyOrderedPromise,
  kitsPromise,
  kitsEnabled,
  warehouseId,
  warehouseName,
  chartersForWarehouse,
  viewerLabel,
  viewerEmail,
  reviewStage,
  setReviewStage,
  orgTimezone,
  deliveryRecipients,
  submission,
  viewerUserId,
  canApproveOrders,
}: StorefrontCatalogProps) {
  // Suspends until the server streams the catalog payload.
  const { items, aisles } = React.use(catalogPromise);
  // Performance marker (lib/perf/marks.ts). AFTER use(), so it is part of the
  // render that has the catalog: this component only mounts (and the marker's
  // mount effect only runs) once the payload has arrived and the grid replaces
  // <CatalogSkeleton />. The frame above paints earlier and is not "useful".
  usePerfUseful();

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
  // null until the streamed list arrives. Nothing here waits for it: the sort
  // and the suggestions simply improve when it does.
  const frequentlyOrdered = useStreamed(frequentlyOrderedPromise);
  const freqEntries = React.useMemo<FreqEntry[]>(
    () => toFreqEntries(frequentlyOrdered ?? [], itemMap),
    [frequentlyOrdered, itemMap],
  );
  const freqByItemId = React.useMemo(
    () => new Map((frequentlyOrdered ?? []).map((f) => [f.itemId, f.count])),
    [frequentlyOrdered],
  );
  const suggestions = React.useMemo(
    () =>
      freqEntries
        .filter((e) => availableOf(e.item) > 0)
        .slice(0, 3)
        .map((e) => ({ itemId: e.item.id, name: e.item.name })),
    [freqEntries],
  );

  /* --- kits --- */
  // NOT read here. The kits promise is read only by the parts that draw kits
  // (the Kits row, and a category or search view's kit cards). Reading it here
  // with useStreamed re-rendered this whole component when it settled, which
  // delayed the grid's first useful frame by about 12 ms in a real browser
  // (local, 2026-09-27). Its outcome is only RECORDED here (no re-render), for
  // Submit and for a category or search view opened after it settled
  // (settled-promise.ts).
  React.useEffect(() => watchSettled(kitsPromise), [kitsPromise]);

  /* --- catalog UI state --- */
  const [category, setCategory] = React.useState<CategoryFilter>('all');
  const [searchInput, setSearchInput] = React.useState('');
  const deferredSearch = React.useDeferredValue(searchInput);
  const [availability, setAvailability] = React.useState<ReadonlySet<ItemStatus>>(
    () => new Set<ItemStatus>(),
  );
  const [sort, setSort] = React.useState<SortKey>(DEFAULT_SORT);
  const [view, setView] = React.useState<ViewMode>('grid');
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [toolPop, setToolPop] = React.useState<null | 'avail' | 'sort'>(null);

  /* --- overlays --- */
  const [quickId, setQuickId] = React.useState<string | null>(null);
  /** A cart that cannot be sent yet, said in the review before anything is
   *  sent (no key is minted for it). */
  const [preflightError, setPreflightError] = React.useState<string | null>(null);

  /* --- cart callbacks (stable so React.memo cards actually skip) --- */
  const linesRef = React.useRef(state.lines);
  React.useEffect(() => {
    linesRef.current = state.lines;
  }, [state.lines]);
  const kitSharesRef = React.useRef(state.kits);
  React.useEffect(() => {
    kitSharesRef.current = state.kits;
  }, [state.kits]);

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
  const handleReviewClose = React.useCallback(() => {
    setPreflightError(null);
    setReviewStage(null);
  }, [setReviewStage]);

  // A kit changes the cart in ONE step, or not at all (storefront-kits.ts):
  // every component tops up to the new count, or gives back one kit's worth
  // of the kit's own units per kit taken out. A component that cannot supply
  // its share changes nothing.
  const handleSetKits = React.useCallback(
    (kit: KitOffer, target: number) => {
      const qty = new Map(linesRef.current.map((l) => [l.itemId, l.quantity]));
      const plan = planKitChange(kit, target, itemMap, kitSharesRef.current[kit.bundleId], qty);
      if (!plan.ok) {
        const name = componentItem(plan.short, itemMap)?.name ?? 'one of its items';
        toast.error(kitNotEnoughCopy(name));
        return;
      }
      if (plan.changes.length > 0) {
        dispatch({ type: 'apply-kit', bundleId: kit.bundleId, changes: plan.changes });
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

  const kitGridProps = {
    itemMap,
    qtyByItemId: qtyMap,
    cartKits: state.kits,
    onSetKits: handleSetKits,
  };

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

  /* --- submit: one key per submission (order-submission.ts) --- */
  // The FIRST press mints the key and freezes the body; the record is written
  // before the action is called, and the cart locks until the key settles.
  // "Check and finish" resends the same body under the same key; "Don't send
  // it" withdraws. A refusal says what to fix, inline (role="alert"), and
  // marks the items it names from this cart.
  function handleConfirmSubmit() {
    setPreflightError(null);
    const lines = state.lines;
    if (lines.length === 0) {
      setPreflightError(SUBMIT_NO_LINES_COPY);
      return;
    }
    // `charter`, not `state.charterId`: a site this warehouse does not service
    // is no site. A draft saved while the cart could outlive a warehouse change
    // (fixed 2026-09-26) can carry the other warehouse's site; the setup bar
    // already shows Choose a site for it.
    if (state.fulfillmentType === 'delivery' && !charter) {
      setPreflightError(SUBMIT_NO_SITE_COPY);
      return;
    }
    if (state.onBehalfOf && (!state.onBehalfOf.name.trim() || !state.onBehalfOf.email.trim())) {
      setPreflightError(SUBMIT_ON_BEHALF_INCOMPLETE_COPY);
      return;
    }
    // The last send refused some of these items (item_not_orderable): they
    // are marked in the cart, and the order waits until they are removed.
    if (lines.some((l) => refusedItems.has(l.itemId))) {
      setPreflightError(SUBMIT_REMOVE_UNORDERABLE_COPY);
      return;
    }

    // The kits, for the audit note only, as far as they have ARRIVED: Submit
    // never waits for them (settled-promise.ts). Not settled yet, or failed:
    // an empty list. The note is optional; the lines are the order.
    const kitsOutcome = settledOutcome(kitsPromise);
    const offeredKits =
      kitsOutcome?.ok && kitsOutcome.value.status === 'ok' ? kitsOutcome.value.kits : [];
    const kits = kitsForAudit(offeredKits, state.kits, lines);
    const body: OrderCreateRequestInput = {
      idempotencyKey: mintOrderSubmissionKey(),
      placerUserId: viewerUserId,
      warehouseId: state.warehouseId,
      fulfillmentType: state.fulfillmentType,
      deliveryCharterId: state.fulfillmentType === 'delivery' ? (charter?.id ?? null) : null,
      onBehalfOf: state.onBehalfOf
        ? { name: state.onBehalfOf.name.trim(), email: state.onBehalfOf.email.trim() }
        : null,
      notes: state.notes.trim() || null,
      // The organization's wall clock, as the datetime-local field gives it;
      // the server reads it in the organization's zone.
      neededByLocal: state.neededBy || null,
      lines: lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
      // Which kits the lines came from, for the order's audit entry only;
      // approvers and pickers see the item lines as always.
      kits,
    };
    // The server reads the body with core's schema; a body it refuses on this
    // first send is final (nothing was placed) and its words show here.
    submission.send(body);
  }

  // A placed order: the persisted draft goes at once, so a reload does not
  // resurrect the submitted cart. In-memory lines stay until Done so the
  // success screen can still show them.
  const placedOrderId = submission.state.phase === 'placed' ? submission.state.order.id : null;
  React.useEffect(() => {
    if (placedOrderId) clearCartDraft(state.warehouseId, orderDraftPrefixFor(viewerUserId));
  }, [placedOrderId, state.warehouseId, viewerUserId]);

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
    clearCartDraft(state.warehouseId, orderDraftPrefixFor(viewerUserId));
    dispatch({ type: 'reset' });
    submission.dismiss();
    setPreflightError(null);
    setReviewStage(null);
  }

  function handleViewOrder() {
    if (submission.state.phase === 'placed') {
      router.push(`/dashboard/orders/${submission.state.order.id}`);
    }
  }

  /* --- what the submission says --- */
  const sub = submission.state;
  const itemName = React.useCallback(
    (id: string) => itemMap.get(id)?.name ?? null,
    [itemMap],
  );
  const wordsCtx = {
    surface: 'web' as const,
    itemName,
    warehouseName,
    bodyUnreadable:
      (sub.phase === 'unconfirmed' || sub.phase === 'withdrawing' || sub.phase === 'sending') &&
      sub.pending.bodyUnreadable === true,
  };
  const panelText =
    sub.phase === 'unconfirmed' || sub.phase === 'withdrawing'
      ? orderUnconfirmedCopy(sub.last, wordsCtx)
      : null;
  const refusalText =
    submission.deviceError ??
    preflightError ??
    (sub.phase === 'refused' ? orderRefusalCopy(sub.reason, sub.details, wordsCtx) : null);
  const noticeText = sub.phase === 'withdrawn' ? ORDER_WITHDRAWN_COPY : null;
  // Items an item_not_orderable refusal named, marked in the cart by name.
  const refusedItems: ReadonlyMap<string, string> =
    sub.phase === 'refused' && sub.reason === 'item_not_orderable'
      ? new Map(Object.entries(sub.details.items ?? {}))
      : NO_REFUSED_ITEMS;

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
                  placeholder={STOREFRONT_SEARCH_PLACEHOLDER_COPY}
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
                  {SORT_OPTIONS.find((s) => s.id === sort)?.label ?? SORT_OPTIONS[0]?.label}
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

          {/* Kits (unfiltered All view), above Frequently ordered */}
          {/* Its place is kept while it streams when the Bundles module is
              on, so a late row never pushes the grid down (review F9). */}
          {browsingAll && (
            <KitsErrorBoundary>
              <React.Suspense fallback={kitsEnabled ? <KitsRowSkeleton /> : null}>
                <KitsRow promise={kitsPromise} {...kitGridProps} />
              </React.Suspense>
            </KitsErrorBoundary>
          )}

          {/* Frequently ordered (unfiltered All view only) */}
          {browsingAll && (
            <React.Suspense
              fallback={
                <FreqCarousel
                  entries={[]}
                  qtyByItemId={qtyMap}
                  loading
                  onAdd={handleAdd}
                  onDec={handleDec}
                  onSetQty={handleSetQty}
                  onQuickView={handleQuickView}
                />
              }
            >
              <FrequentlyOrderedStrip
                promise={frequentlyOrderedPromise}
                itemMap={itemMap}
                qtyByItemId={qtyMap}
                onAdd={handleAdd}
                onDec={handleDec}
                onSetQty={handleSetQty}
                onQuickView={handleQuickView}
              />
            </React.Suspense>
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
                icon={<Package size={15} />}
              >
                {renderItems(g.items.slice(0, previewCount))}
              </CategorySection>
            ))
          ) : (
            // Kits lead a category view and show in search, filtered like the
            // items. The items draw at once; the kit cards join them when the
            // kits have arrived (long before anyone opens a category, as a
            // rule), and nothing here waits for them.
            <FlatResultsWithKits
              promise={kitsPromise}
              filterInput={filterInput}
              title={activeCategoryName}
              itemCount={filtered.length}
              searching={deferredSearch.trim() !== ''}
              kitGridProps={kitGridProps}
              empty={<EmptyResults query={deferredSearch.trim()} onClear={clearAllFilters} />}
            >
              {filtered.length > 0 ? renderItems(filtered) : null}
            </FlatResultsWithKits>
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
            orgTimezone={orgTimezone}
            refusedItems={refusedItems}
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
              ? storefrontWillCallDeskCopy(warehouseName)
              : (charter?.name ?? STOREFRONT_CHOOSE_SITE_COPY),
          requestedFor: state.onBehalfOf?.name ?? viewerLabel,
          requesterEmail: state.onBehalfOf?.email ?? viewerEmail,
          orgTimezone,
        }}
        neededBy={state.neededBy}
        destination={state.fulfillmentType === 'delivery' ? charter : null}
        deliveryRecipients={deliveryRecipients}
        submitting={submission.busy || sub.phase === 'sending' || sub.phase === 'withdrawing'}
        submitted={
          sub.phase === 'placed'
            ? { order: sub.order, replay: sub.replay, viaWithdraw: sub.viaWithdraw }
            : null
        }
        viewerLabel={viewerLabel}
        viewerEmail={viewerEmail}
        unsettled={orderSubmissionLocked(sub)}
        panelText={panelText}
        canResend={sub.phase === 'unconfirmed' && sub.pending.bodyUnreadable !== true}
        refusalText={refusalText}
        noticeText={noticeText}
        canApproveOrders={canApproveOrders}
        onCheckAndFinish={submission.resend}
        onDontSend={submission.withdraw}
        onClose={handleReviewClose}
        onConfirm={handleConfirmSubmit}
        onViewOrder={handleViewOrder}
        onDone={handleDone}
      />
    </>
  );
}
