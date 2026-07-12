'use client';

// Root component for the public order link (/r/<token>) — P4 restyle onto
// the internal storefront's design system (owner request: the public page
// must look like /dashboard/orders/new). Reuses the sf-* visual system
// (setup bar, sticky toolbar, category pills, product grid, cart rail,
// green accent) via storefront.css + the sfp-* public additions, while
// keeping the anonymous flow intact: warehouse picker with cart-clear
// confirm, pickup/delivery + charter picker, honeypot, POST
// /api/v1/public/order-requests, and the double-opt-in success panel.
//
// Renders the narrow PublicCatalogItem schema directly — there is no
// sku/price/charter/location anywhere in the props chain.

import {
  ArrowUpDown,
  Boxes,
  Check,
  ChevronDown,
  Filter,
  MailCheck,
  MapPin,
  Package,
  PackageOpen,
  Search,
  Truck,
  X,
} from 'lucide-react';
import * as React from 'react';

import { useCatalogThumbnails } from '@/lib/use-catalog-thumbnails';

import {
  CartProvider,
  initialCartState,
  useCart,
} from '@/components/orders/v2/cart-context';

import { CategorySection } from '../storefront/storefront-cards';
import { CartFab } from '../storefront/storefront-cart';
import { buildQtyMap, cartTotals } from '../storefront/storefront-logic';
import { SfPopover } from '../storefront/storefront-overlays';

import { PublicCartRail } from './public-cart-rail';
import type { SubmittedState } from './public-cart-rail';
import { PublicItemCard } from './public-item-card';
import {
  PUBLIC_STATUS_LABELS,
  isUnavailable,
  publicCapOf,
  publicStatusOf,
  type PublicItemStatus,
} from './public-logic';
import { PublicYourInfoCard } from './public-your-info-card';
import type { PublicAvailabilityDisplay, PublicCatalogItem } from './types';

const GRID_PREVIEW = 4;

type PublicSortKey = 'name-asc' | 'name-desc' | 'stock-desc' | 'stock-asc';

export interface PublicOrdersV2Props {
  token: string;
  orgName: string;
  warehouses: Array<{ id: string; name: string }>;
  initialWarehouseId: string;
  items: PublicCatalogItem[];
  /** The link's availability display mode — drives which stock filters
   *  and sorts the toolbar offers ('none' offers neither). */
  availabilityDisplay: PublicAvailabilityDisplay;
  chartersForWarehouse: Array<{ id: string; name: string; code: string | null }>;
}

export function PublicOrdersV2(props: PublicOrdersV2Props) {
  // Prefix the warehouseId in localStorage to avoid colliding with the
  // staff draft for the same warehouse when both share a browser.
  const publicWarehouseId = `public:${props.initialWarehouseId}`;
  const initial = initialCartState({
    warehouseId: publicWarehouseId,
    fulfillmentType: 'pickup',
  });

  return (
    <CartProvider initial={initial}>
      <PublicOrdersV2Inner {...props} publicWarehouseId={publicWarehouseId} />
    </CartProvider>
  );
}

function PublicOrdersV2Inner({
  token,
  orgName,
  warehouses,
  items: rawItems,
  initialWarehouseId,
  availabilityDisplay,
  chartersForWarehouse,
  publicWarehouseId,
}: PublicOrdersV2Props & { publicWarehouseId: string }) {
  const { state: cartState, dispatch } = useCart();

  // Requester info — owned here and passed down to card + rail
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [pickupNotes, setPickupNotes] = React.useState('');
  const [hp, setHp] = React.useState('');

  // Success state (double-opt-in "Check your inbox" panel)
  const [submitted, setSubmitted] = React.useState<SubmittedState | null>(null);

  // Warehouse-switch confirm state. A styled sf-modal replaces
  // window.confirm(), which iOS Safari blocks in webviews.
  const [pendingSwitchTo, setPendingSwitchTo] = React.useState<string | null>(null);

  // Setup-bar + toolbar popovers
  const [openPop, setOpenPop] = React.useState<null | 'wh' | 'site' | 'avail' | 'sort'>(
    null,
  );

  // Catalog UI state
  const [category, setCategory] = React.useState<'all' | 'uncategorized' | string>('all');
  const [searchInput, setSearchInput] = React.useState('');
  const deferredSearch = React.useDeferredValue(searchInput);
  const [availability, setAvailability] = React.useState<ReadonlySet<PublicItemStatus>>(
    () => new Set<PublicItemStatus>(),
  );
  const [sort, setSort] = React.useState<PublicSortKey>('name-asc');
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  const warehouseName =
    warehouses.find((w) => w.id === initialWarehouseId)?.name ?? initialWarehouseId;
  const charter = chartersForWarehouse.find((c) => c.id === cartState.charterId) ?? null;

  function commitWarehouseSwitch(v: string) {
    // Hard reload on purpose — the server re-fetches the new warehouse's
    // catalog + charters, and the cart draft key is per-warehouse.
    const url = new URL(window.location.href);
    url.searchParams.set('w', v);
    window.location.assign(url.toString());
  }

  // Deferred thumbnail URLs — fetched after first paint, token-gated. The
  // hook retries with backoff so one blip doesn't blank the whole session.
  const thumbUrls = useCatalogThumbnails(
    `/api/v1/public/catalog-thumbnails?token=${encodeURIComponent(token)}&warehouseId=${encodeURIComponent(initialWarehouseId)}`,
  );

  // Merge fetched thumbnail URLs onto the server-rendered items. The
  // deferred fetch only FILLS items with no server-provided image (signed
  // product photos); it never overrides an SSR cover. Covers ship in the
  // initial payload already downsized — letting the deferred fetch replace
  // one with the raw (larger) fallback URL would re-download the image and
  // flicker for zero benefit.
  const items = React.useMemo<PublicCatalogItem[]>(() => {
    if (Object.keys(thumbUrls).length === 0) return rawItems;
    return rawItems.map((it) =>
      !it.imageUrl && thumbUrls[it.id] ? { ...it, imageUrl: thumbUrls[it.id]! } : it,
    );
  }, [rawItems, thumbUrls]);

  const itemMap = React.useMemo(
    () => new Map(items.map((it) => [it.id, it])),
    [items],
  );

  /* --- cart callbacks (stable so React.memo cards actually skip) --- */
  const linesRef = React.useRef(cartState.lines);
  React.useEffect(() => {
    linesRef.current = cartState.lines;
  }, [cartState.lines]);

  const handleAdd = React.useCallback(
    (itemId: string) => {
      const item = itemMap.get(itemId);
      if (!item || isUnavailable(item)) return;
      const cap = publicCapOf(item);
      const qty = linesRef.current.find((l) => l.itemId === itemId)?.quantity ?? 0;
      if (qty >= cap) return;
      dispatch({ type: 'add', itemId });
    },
    [itemMap, dispatch],
  );
  const handleDec = React.useCallback(
    (itemId: string) => dispatch({ type: 'dec', itemId }),
    [dispatch],
  );
  // Typed quantities arrive pre-clamped by QtyField (0..cap); ≤0 removes.
  const handleSetQty = React.useCallback(
    (itemId: string, quantity: number) => dispatch({ type: 'set-qty', itemId, quantity }),
    [dispatch],
  );

  /* --- aisles (derived client-side from the catalog payload) --- */
  const aisles = React.useMemo(() => {
    const byId = new Map<string, { name: string; count: number }>();
    let uncategorized = 0;
    for (const it of items) {
      if (!it.categoryId) {
        uncategorized += 1;
        continue;
      }
      const prev = byId.get(it.categoryId);
      if (prev) prev.count += 1;
      else byId.set(it.categoryId, { name: it.categoryLabel ?? 'Category', count: 1 });
    }
    const named: Array<{ id: string | null; name: string; count: number }> = [
      ...byId.entries(),
    ]
      .map(([id, v]) => ({ id: id as string | null, name: v.name, count: v.count }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (uncategorized > 0) {
      named.push({ id: null, name: 'Uncategorized', count: uncategorized });
    }
    return named;
  }, [items]);

  /* --- filter + sort pipeline --- */
  const filtered = React.useMemo(() => {
    let result = items;

    if (category !== 'all') {
      result =
        category === 'uncategorized'
          ? result.filter((it) => it.categoryId === null)
          : result.filter((it) => it.categoryId === category);
    }

    const tokens = deferredSearch.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length > 0) {
      result = result.filter((it) => {
        const hay =
          `${it.displayName} ${it.categoryLabel ?? ''} ${it.publicDescription ?? ''}`.toLowerCase();
        return tokens.every((t) => hay.includes(t));
      });
    }

    if (availability.size > 0) {
      result = result.filter((it) => {
        const s = publicStatusOf(it.availability);
        return s !== null && availability.has(s);
      });
    }

    const exactCount = (it: PublicCatalogItem) =>
      it.availability.kind === 'exact' ? it.availability.count : 0;
    const out = result.slice();
    switch (sort) {
      case 'name-desc':
        out.sort((a, b) => b.displayName.localeCompare(a.displayName));
        break;
      case 'stock-desc':
        out.sort((a, b) => exactCount(b) - exactCount(a));
        break;
      case 'stock-asc':
        out.sort((a, b) => exactCount(a) - exactCount(b));
        break;
      case 'name-asc':
      default:
        out.sort((a, b) => a.displayName.localeCompare(b.displayName));
        break;
    }
    return out;
  }, [items, category, deferredSearch, availability, sort]);

  const browsingAll =
    category === 'all' && deferredSearch.trim() === '' && availability.size === 0;

  const statusCounts = React.useMemo(() => {
    const counts: Record<PublicItemStatus, number> = { ok: 0, low: 0, out: 0 };
    for (const it of items) {
      const s = publicStatusOf(it.availability);
      if (s) counts[s] += 1;
    }
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

  const qtyMap = React.useMemo(() => buildQtyMap(cartState.lines), [cartState.lines]);
  const { unitCount } = cartTotals(cartState.lines);

  const railRef = React.useRef<HTMLDivElement>(null);

  const statusLabels =
    availabilityDisplay === 'bucket' ? PUBLIC_STATUS_LABELS.bucket : PUBLIC_STATUS_LABELS.exact;

  const sortOptions: ReadonlyArray<{ id: PublicSortKey; label: string }> = [
    { id: 'name-asc', label: 'Name · A–Z' },
    { id: 'name-desc', label: 'Name · Z–A' },
    ...(availabilityDisplay === 'exact'
      ? ([
          { id: 'stock-desc', label: 'Most available' },
          { id: 'stock-asc', label: 'Least available' },
        ] as const)
      : []),
  ];

  const toggleAvailability = (status: PublicItemStatus) => {
    setAvailability((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  const clearAllFilters = () => {
    setSearchInput('');
    setAvailability(new Set<PublicItemStatus>());
    setCategory('all');
  };

  const hasFilterChips = searchInput.trim() !== '' || availability.size > 0;
  const activeCategoryName =
    category === 'all'
      ? 'All items'
      : (aisles.find((a) => (a.id ?? 'uncategorized') === category)?.name ?? 'Category');

  const renderItems = (list: PublicCatalogItem[]) => (
    <div className="sf-grid">
      {list.map((it, i) => (
        <PublicItemCard
          key={it.id}
          item={it}
          qty={qtyMap.get(it.id) ?? 0}
          onAdd={handleAdd}
          onDec={handleDec}
          onSetQty={handleSetQty}
          // First row of the first render is above the fold — load those
          // covers eagerly at high priority for a fast LCP.
          priority={i < 6}
        />
      ))}
    </div>
  );

  /* --- success panel (double-opt-in) --- */
  if (submitted) {
    return (
      <div className="sfp-success-card">
        <div className="sf-success" role="status">
          <div className="ok">
            <MailCheck size={28} />
          </div>
          <h3>Check your inbox</h3>
          <div className="ref">Request ID: {submitted.id}</div>
          <p>
            We&apos;ve emailed <strong>{submitted.email}</strong> a link to confirm
            this order request. Once you click the link, {orgName}&apos;s team will
            review it — until then, the request stays on hold and is not visible to
            anyone else.
          </p>
          <p>
            Didn&apos;t get it? Check your spam folder, or try again with a
            different email address. The confirmation link expires in 24 hours.
          </p>
          <div className="acts">
            <a className="sf-btn-go" href={submitted.trackUrl}>
              Track this order
            </a>
          </div>
        </div>
      </div>
    );
  }

  /* --- setup bar (warehouse / fulfillment / destination) --- */
  const setupBar = (
    <div className="sf-setup">
      {/* Warehouse */}
      {warehouses.length > 1 ? (
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
            <div className="lb">Location</div>
            <div className="vl">
              {warehouseName}{' '}
              <span className="icon">
                <ChevronDown size={11} />
              </span>
            </div>
          </div>
          <SfPopover open={openPop === 'wh'} onClose={() => setOpenPop(null)}>
            <div className="sf-pop-label">Order from</div>
            {warehouses.map((w) => (
              <button
                key={w.id}
                type="button"
                className="sf-opt"
                data-on={w.id === initialWarehouseId}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenPop(null);
                  if (w.id === initialWarehouseId) return;
                  if (cartState.lines.length > 0) {
                    setPendingSwitchTo(w.id);
                    return;
                  }
                  commitWarehouseSwitch(w.id);
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
      ) : (
        <div className="sf-setup-cell static">
          <span className="sf-setup-ic">
            <Boxes size={15} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="lb">Location</div>
            <div className="vl">{warehouseName}</div>
          </div>
        </div>
      )}

      {/* Fulfillment segmented control */}
      <div className="sf-seg-wrap">
        <div>
          <div className="lb">Fulfillment</div>
          <div className="sf-seg" role="radiogroup" aria-label="Fulfillment type">
            <button
              type="button"
              data-active={cartState.fulfillmentType === 'pickup'}
              aria-pressed={cartState.fulfillmentType === 'pickup'}
              onClick={() =>
                dispatch({ type: 'set-setup', patch: { fulfillmentType: 'pickup' } })
              }
            >
              <Package size={13} /> Pickup
            </button>
            <button
              type="button"
              data-active={cartState.fulfillmentType === 'delivery'}
              aria-pressed={cartState.fulfillmentType === 'delivery'}
              onClick={() =>
                dispatch({ type: 'set-setup', patch: { fulfillmentType: 'delivery' } })
              }
            >
              <Truck size={13} /> Delivery
            </button>
          </div>
        </div>
      </div>

      {/* Pick up at / Deliver to */}
      {cartState.fulfillmentType === 'pickup' ? (
        <div className="sf-setup-cell static">
          <span className="sf-setup-ic">
            <MapPin size={15} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="lb">Pick up at</div>
            <div className="vl">{warehouseName}</div>
            <div className="hint">We&apos;ll email you when it&apos;s ready</div>
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
          <SfPopover open={openPop === 'site'} onClose={() => setOpenPop(null)} right>
            <div className="sf-pop-label">Delivery site</div>
            {chartersForWarehouse.length === 0 && (
              <div className="sf-opt" style={{ cursor: 'default' }}>
                <span className="sb">
                  No delivery sites available — choose Pickup instead.
                </span>
              </div>
            )}
            {chartersForWarehouse.map((c) => (
              <button
                key={c.id}
                type="button"
                className="sf-opt"
                data-on={c.id === cartState.charterId}
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
  );

  /* --- empty catalog: the spec's message instead of a blank grid --- */
  if (rawItems.length === 0) {
    return (
      <>
        {warehouses.length > 1 ? setupBar : null}
        <div className="sf-empty sfp-closed" role="status">
          <div className="big">
            <PackageOpen size={24} />
          </div>
          <h4>No items available</h4>
          <p>
            There are currently no items available through this request form.
            Please contact your organization for assistance.
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      {setupBar}

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
                  placeholder="Search the catalog…"
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

              {/* Stock filter — hidden entirely when the link ships no
                  availability signal. */}
              {availabilityDisplay !== 'none' && (
                <div className="sf-popwrap">
                  <button
                    type="button"
                    className="sf-tool-btn"
                    data-on={availability.size > 0}
                    onClick={() => setOpenPop(openPop === 'avail' ? null : 'avail')}
                    aria-haspopup="dialog"
                    aria-expanded={openPop === 'avail'}
                  >
                    <Filter size={13} /> Availability
                    {availability.size > 0 && <span className="bdg">{availability.size}</span>}
                    <ChevronDown size={11} />
                  </button>
                  <SfPopover
                    open={openPop === 'avail'}
                    onClose={() => setOpenPop(null)}
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
                          {statusLabels[id]}
                        </span>
                        <span className="ct">{statusCounts[id]}</span>
                      </button>
                    ))}
                  </SfPopover>
                </div>
              )}

              <div className="sf-popwrap">
                <button
                  type="button"
                  className="sf-tool-btn"
                  onClick={() => setOpenPop(openPop === 'sort' ? null : 'sort')}
                  aria-haspopup="dialog"
                  aria-expanded={openPop === 'sort'}
                >
                  <ArrowUpDown size={13} />{' '}
                  {sortOptions.find((s) => s.id === sort)?.label ?? 'Name · A–Z'}
                  <ChevronDown size={11} />
                </button>
                <SfPopover
                  open={openPop === 'sort'}
                  onClose={() => setOpenPop(null)}
                  right
                  width={210}
                >
                  {sortOptions.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="sf-opt"
                      data-on={s.id === sort}
                      onClick={() => {
                        setSort(s.id);
                        setOpenPop(null);
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
                    {a.name} <span className="ct">{a.count}</span>
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
                  {statusLabels[a]}
                  <button
                    type="button"
                    onClick={() => toggleAvailability(a)}
                    aria-label={`Remove ${statusLabels[a]} filter`}
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
                shownCount={GRID_PREVIEW}
                onViewAll={() => setCategory(g.key)}
                showKitButton={false}
                onAddKit={() => undefined}
                icon={<Package size={15} />}
              >
                {renderItems(g.items.slice(0, GRID_PREVIEW))}
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
                <div className="sf-empty">
                  <div className="big">
                    <Search size={24} />
                  </div>
                  <h4>
                    Nothing matches
                    {deferredSearch.trim() ? ` “${deferredSearch.trim()}”` : ' those filters'}
                  </h4>
                  <p>Try a different name or category — or clear your filters.</p>
                  <button type="button" className="sf-btn-ghost" onClick={clearAllFilters}>
                    Clear search &amp; filters
                  </button>
                </div>
              ) : (
                renderItems(filtered)
              )}
            </>
          )}
        </div>

        {/* Request rail — your details + cart, sticky on desktop */}
        <div className="sf-rail" ref={railRef}>
          <PublicYourInfoCard
            name={name}
            onNameChange={setName}
            email={email}
            onEmailChange={setEmail}
            phone={phone}
            onPhoneChange={setPhone}
            pickupNotes={pickupNotes}
            onPickupNotesChange={setPickupNotes}
            hp={hp}
            onHpChange={setHp}
          />
          <PublicCartRail
            token={token}
            warehouseId={initialWarehouseId}
            draftKey={publicWarehouseId}
            warehouseName={warehouseName}
            itemMap={itemMap}
            name={name}
            email={email}
            phone={phone}
            pickupNotes={pickupNotes}
            honeypot={hp}
            onSubmitted={setSubmitted}
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

      {/* Warehouse-switch confirm */}
      {pendingSwitchTo !== null && (
        <div className="sf-modal-bk" onClick={() => setPendingSwitchTo(null)}>
          <div
            className="sf-modal"
            style={{ width: 'min(420px, 100%)' }}
            role="dialog"
            aria-modal="true"
            aria-label="Switch location?"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sf-modal-head">
              <h3>Switch location?</h3>
              <button
                type="button"
                className="sf-icon-btn x"
                onClick={() => setPendingSwitchTo(null)}
                aria-label="Close"
              >
                <X size={15} />
              </button>
            </div>
            <div className="sf-modal-body">
              <p style={{ margin: 0, fontSize: '12.5px', color: 'var(--sf-ink-3)' }}>
                Your cart has items in it. Switching locations will clear them so the
                new location&apos;s catalog can load.
              </p>
            </div>
            <div className="sf-modal-foot">
              <span className="grow2" />
              <button
                type="button"
                className="sf-btn-ghost"
                onClick={() => setPendingSwitchTo(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="sf-btn-go"
                onClick={() => {
                  const target = pendingSwitchTo;
                  setPendingSwitchTo(null);
                  if (target) commitWarehouseSwitch(target);
                }}
              >
                Switch and clear cart
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
