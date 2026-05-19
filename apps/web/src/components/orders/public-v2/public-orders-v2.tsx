'use client';

import * as React from 'react';

import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AisleBar } from '@/components/orders/v2/aisle-bar';
import {
  CartProvider,
  initialCartState,
  useCart,
} from '@/components/orders/v2/cart-context';
import { CatalogGrid } from '@/components/orders/v2/catalog-grid';
import { Toolbar } from '@/components/orders/v2/toolbar';
import type { AvailabilityFilter, SortKey } from '@/components/orders/v2/toolbar';
import type { AisleSummary, CatalogItem } from '@/components/orders/v2/types';

import { PublicCartRail } from './public-cart-rail';
import type { SubmittedState } from './public-cart-rail';
import { PublicYourInfoCard } from './public-your-info-card';

export interface PublicOrdersV2Props {
  token: string;
  orgName: string;
  warehouses: Array<{ id: string; name: string }>;
  initialWarehouseId: string;
  items: CatalogItem[];
  aisles: AisleSummary[];
  chartersForWarehouse: Array<{ id: string; name: string; code: string | null }>;
}

/**
 * Root component for the public order link v2 picker.
 *
 * Wraps the shared CartProvider (prefixed `public:` in the warehouseId to
 * avoid localStorage key collision with the staff picker), mounts the
 * YourInfo card above the catalog, and shows a "Check your inbox" success
 * panel after a successful submit.
 */
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
  aisles,
  initialWarehouseId,
  chartersForWarehouse,
}: PublicOrdersV2Props & { publicWarehouseId: string }) {
  const { state: cartState } = useCart();
  // Requester info — owned here and passed down to card + rail
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [pickupNotes, setPickupNotes] = React.useState('');
  const [hp, setHp] = React.useState('');

  // Success state
  const [submitted, setSubmitted] = React.useState<SubmittedState | null>(null);

  // Catalog UI state
  const [activeAisleId, setActiveAisleId] = React.useState<string | 'all'>('all');
  const [searchQuery, setSearchQuery] = React.useState('');
  const [availabilityFilter, setAvailabilityFilter] = React.useState<AvailabilityFilter>('any');
  const [sortKey, setSortKey] = React.useState<SortKey>('name');

  // Deferred thumbnail URLs — fetched after first paint, token-gated
  const [thumbUrls, setThumbUrls] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/v1/public/catalog-thumbnails?token=${encodeURIComponent(token)}&warehouseId=${encodeURIComponent(initialWarehouseId)}`,
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
  }, [token, initialWarehouseId]);

  // Merge fetched thumbnail URLs onto the server-rendered items
  const items = React.useMemo<CatalogItem[]>(() => {
    if (Object.keys(thumbUrls).length === 0) return rawItems;
    return rawItems.map((it) =>
      thumbUrls[it.id] ? { ...it, imageUrl: thumbUrls[it.id]! } : it,
    );
  }, [rawItems, thumbUrls]);

  // Item map for CartRail thumbnail + name lookups
  const itemMap = React.useMemo(
    () => new Map(items.map((it) => [it.id, it])),
    [items],
  );

  // Availability per item
  const availByItem = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const it of items) {
      map.set(it.id, Math.max(0, it.quantityOnHand - it.reservedQuantity));
    }
    return map;
  }, [items]);

  // Filter pipeline (mirrors staff v2)
  const filteredItems = React.useMemo(() => {
    let result = items;

    if (activeAisleId !== 'all') {
      if (activeAisleId === 'uncategorized') {
        result = result.filter((it) => it.categoryId === null);
      } else {
        result = result.filter((it) => it.categoryId === activeAisleId);
      }
    }

    const q = searchQuery.trim().toLowerCase();
    if (q) {
      result = result.filter(
        (it) =>
          it.name.toLowerCase().includes(q) ||
          it.sku.toLowerCase().includes(q),
      );
    }

    if (availabilityFilter !== 'any') {
      result = result.filter((it) => {
        const avail = availByItem.get(it.id) ?? 0;
        if (availabilityFilter === 'in-stock') return avail >= it.reorderPoint;
        if (availabilityFilter === 'low') return avail > 0 && avail < it.reorderPoint;
        if (availabilityFilter === 'out') return avail === 0;
        return true;
      });
    }

    if (sortKey === 'name') {
      result = [...result].sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortKey === 'least-stock') {
      result = [...result].sort(
        (a, b) => (availByItem.get(a.id) ?? 0) - (availByItem.get(b.id) ?? 0),
      );
    }

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

  // Success panel — mirrors legacy PublicOrderForm submitted state
  if (submitted) {
    return (
      <div className="border-border bg-card mt-2 rounded-2xl border p-6 text-center">
        <h2 className="font-display text-xl">Check your inbox</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          We&apos;ve emailed{' '}
          <span className="text-foreground font-medium">{submitted.email}</span>{' '}
          a link to confirm this order request. Once you click the link,{' '}
          {orgName}&apos;s team will review it — until then, the request stays on
          hold and is not visible to anyone else.
        </p>
        <p className="text-muted-foreground mt-3 text-xs">
          Didn&apos;t get it? Check your spam folder, or try again with a different
          email address. The confirmation link expires in 24 hours.
        </p>
        <p className="text-muted-foreground mt-4 text-xs">
          Request ID: <span className="font-mono">{submitted.id}</span>
        </p>
        <a
          href={submitted.trackUrl}
          className="mt-6 inline-block text-sm underline"
        >
          Track this order
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      {/* Main column */}
      <div className="flex-1 min-w-0 space-y-4">
        {/* Your info card — above the aisle bar (required to submit) */}
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
          chartersForWarehouse={chartersForWarehouse}
        />

        {/* Multi-warehouse picker — only when more than one warehouse
            is publicly orderable. Switching reloads the page so the
            server re-fetches the right book catalog for the new
            warehouse. Confirms first when the cart has items (matches
            the staff-side warehouse-switch behavior). */}
        {warehouses.length > 1 ? (
          <section className="bg-card space-y-2 rounded-2xl border p-4">
            <Label htmlFor="public-warehouse">Pickup location</Label>
            <Select
              value={initialWarehouseId}
              onValueChange={(v) => {
                if (v === initialWarehouseId) return;
                if (cartState.lines.length > 0) {
                  if (
                    !window.confirm(
                      'Switching locations will clear your cart. Continue?',
                    )
                  ) {
                    return;
                  }
                }
                const params = new URLSearchParams(window.location.search);
                params.set('w', v);
                window.location.search = params.toString();
              }}
            >
              <SelectTrigger id="public-warehouse">
                <SelectValue placeholder="Pick a location" />
              </SelectTrigger>
              <SelectContent>
                {warehouses.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </section>
        ) : null}

        {/* Aisle bar (sticky) */}
        <AisleBar
          aisles={aisles}
          totalItemCount={items.length}
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

        {/* Catalog grid */}
        <CatalogGrid
          items={filteredItems}
          aisles={aisles}
          activeAisleId={activeAisleId}
          groupByAisle={true}
          cols={3}
          onClearFilters={clearFilters}
        />
      </div>

      {/* Cart rail */}
      <PublicCartRail
        token={token}
        warehouseId={initialWarehouseId}
        itemMap={itemMap}
        name={name}
        email={email}
        phone={phone}
        pickupNotes={pickupNotes}
        honeypot={hp}
        onSubmitted={setSubmitted}
      />
    </div>
  );
}
