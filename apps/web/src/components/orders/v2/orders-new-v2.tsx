'use client';

import * as React from 'react';

import { CartProvider, initialCartState } from './cart-context';
import { AisleBar } from './aisle-bar';
import { CartRail } from './cart-rail';
import { CatalogGrid } from './catalog-grid';
import { QuickAdd } from './quick-add';
import { SetupStrip } from './setup-strip';
import { Toolbar } from './toolbar';
import type { AvailabilityFilter, SortKey } from './toolbar';
import type { AisleSummary, CatalogItem } from './types';

const PREFS_KEY = 'order-new-v2-prefs';

interface Prefs {
  cols: 2 | 3 | 4;
  groupByAisle: boolean;
  showQuickAdd: boolean;
}

const DEFAULT_PREFS: Prefs = {
  cols: 4,
  groupByAisle: true,
  showQuickAdd: true,
};

export interface OrdersNewV2Props {
  warehouses: Array<{ id: string; name: string }>;
  warehouseId: string;
  items: CatalogItem[];
  aisles: AisleSummary[];
  chartersForWarehouse: Array<{ id: string; name: string; code: string | null }>;
  viewerRole: string;
}

export function OrdersNewV2(props: OrdersNewV2Props) {
  const initial = initialCartState({
    warehouseId: props.warehouseId,
    fulfillmentType: 'pickup',
  });

  return (
    <CartProvider initial={initial}>
      <OrdersNewV2Inner {...props} />
    </CartProvider>
  );
}

function OrdersNewV2Inner({
  warehouses,
  warehouseId,
  items: rawItems,
  aisles,
  chartersForWarehouse,
  viewerRole,
}: OrdersNewV2Props) {
  // UI state
  const [activeAisleId, setActiveAisleId] = React.useState<string | 'all'>('all');
  const [searchQuery, setSearchQuery] = React.useState('');
  const [availabilityFilter, setAvailabilityFilter] = React.useState<AvailabilityFilter>('any');
  const [sortKey, setSortKey] = React.useState<SortKey>('name');

  // Deferred thumbnail URLs — fetched client-side after first paint
  // so the page renders instantly instead of waiting on Supabase's
  // signed-URL service for hundreds of items. While the map is
  // empty, cards render with their placeholder; once URLs arrive,
  // the same cards swap to real thumbnails.
  const [thumbUrls, setThumbUrls] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/orders/catalog-thumbnails?warehouseId=${encodeURIComponent(warehouseId)}`,
          { credentials: 'same-origin' },
        );
        if (!res.ok) return;
        const data = (await res.json()) as { urls?: Record<string, string> };
        if (!cancelled && data.urls) setThumbUrls(data.urls);
      } catch {
        /* network blip — placeholders stay; not blocking */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [warehouseId]);

  // Merge fetched thumbnail URLs onto the server-rendered items.
  const items = React.useMemo<CatalogItem[]>(() => {
    if (Object.keys(thumbUrls).length === 0) return rawItems;
    return rawItems.map((it) =>
      thumbUrls[it.id] ? { ...it, imageUrl: thumbUrls[it.id]! } : it,
    );
  }, [rawItems, thumbUrls]);

  // Persisted prefs (hydrated from localStorage after mount)
  const [prefs, setPrefs] = React.useState<Prefs>(DEFAULT_PREFS);

  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Prefs>;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot localStorage hydration on mount
        setPrefs({
          cols: parsed.cols ?? DEFAULT_PREFS.cols,
          groupByAisle: parsed.groupByAisle ?? DEFAULT_PREFS.groupByAisle,
          showQuickAdd: parsed.showQuickAdd ?? DEFAULT_PREFS.showQuickAdd,
        });
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Debounced prefs save
  React.useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
      } catch {
        /* quota */
      }
    }, 250);
    return () => clearTimeout(t);
  }, [prefs]);

  // Build item map for CartRail thumbnail + name lookups
  const itemMap = React.useMemo(
    () => new Map(items.map((it) => [it.id, it])),
    [items],
  );

  // Derived availability per item (used in filter + card)
  const availByItem = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const it of items) {
      map.set(it.id, Math.max(0, it.quantityOnHand - it.reservedQuantity));
    }
    return map;
  }, [items]);

  // --- Filter pipeline ---
  const filteredItems = React.useMemo(() => {
    let result = items;

    // 1. Aisle filter
    if (activeAisleId !== 'all') {
      if (activeAisleId === 'uncategorized') {
        result = result.filter((it) => it.categoryId === null);
      } else {
        result = result.filter((it) => it.categoryId === activeAisleId);
      }
    }

    // 2. Search
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      result = result.filter(
        (it) =>
          it.name.toLowerCase().includes(q) ||
          it.sku.toLowerCase().includes(q),
      );
    }

    // 3. Availability
    if (availabilityFilter !== 'any') {
      result = result.filter((it) => {
        const avail = availByItem.get(it.id) ?? 0;
        if (availabilityFilter === 'in-stock') return avail >= it.reorderPoint;
        if (availabilityFilter === 'low')
          return avail > 0 && avail < it.reorderPoint;
        if (availabilityFilter === 'out') return avail === 0;
        return true;
      });
    }

    // 4. Sort
    if (sortKey === 'name') {
      result = [...result].sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortKey === 'least-stock') {
      result = [...result].sort(
        (a, b) => (availByItem.get(a.id) ?? 0) - (availByItem.get(b.id) ?? 0),
      );
    }
    // 'most-ordered' = no-op in v1 (freq counts not available client-side for full catalog)

    return result;
  }, [items, activeAisleId, searchQuery, availabilityFilter, sortKey, availByItem]);

  const hasActiveFilters =
    searchQuery !== '' ||
    availabilityFilter !== 'any' ||
    sortKey !== 'name' ||
    activeAisleId !== 'all';

  function clearFilters() {
    setActiveAisleId('all');
    setSearchQuery('');
    setAvailabilityFilter('any');
    setSortKey('name');
  }

  const totalItemCount = items.length;

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      {/* Main column */}
      <div className="flex-1 min-w-0 space-y-4">
        {/* Setup strip */}
        <SetupStrip
          warehouses={warehouses}
          warehouseId={warehouseId}
          chartersForWarehouse={chartersForWarehouse}
          viewerRole={viewerRole}
        />

        {/* Aisle bar (sticky) */}
        <AisleBar
          aisles={aisles}
          totalItemCount={totalItemCount}
          activeAisleId={activeAisleId}
          onSelect={setActiveAisleId}
        />

        {/* Toolbar */}
        <Toolbar
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          availabilityFilter={availabilityFilter}
          onAvailabilityChange={setAvailabilityFilter}
          sortKey={sortKey}
          onSortChange={setSortKey}
          onClear={clearFilters}
          hasActiveFilters={hasActiveFilters}
        />

        {/* Quick-add row (All view only + pref-gated) */}
        {activeAisleId === 'all' && prefs.showQuickAdd && (
          <QuickAdd warehouseId={warehouseId} />
        )}

        {/* Catalog grid */}
        <CatalogGrid
          items={filteredItems}
          aisles={aisles}
          activeAisleId={activeAisleId}
          groupByAisle={prefs.groupByAisle}
          cols={prefs.cols}
          onClearFilters={clearFilters}
        />
      </div>

      {/* Cart rail */}
      <CartRail itemMap={itemMap} warehouseId={warehouseId} />
    </div>
  );
}
