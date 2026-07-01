'use client';

import { Loader2, ShoppingCart, Minus, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { AisleBar } from '@/components/orders/v2/aisle-bar';
import {
  CartProvider,
  clearCartDraft,
  initialCartState,
  useCart,
} from '@/components/orders/v2/cart-context';
import { CatalogGrid } from '@/components/orders/v2/catalog-grid';
import { Toolbar } from '@/components/orders/v2/toolbar';
import type { AvailabilityFilter, SortKey } from '@/components/orders/v2/toolbar';
import type { AisleSummary, CatalogItem } from '@/components/orders/v2/types';
import { BorrowerPicker } from '@/components/rentals/borrower-picker';
import type { BorrowerValue } from '@/components/rentals/borrower-picker';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useCatalogThumbnails } from '@/lib/use-catalog-thumbnails';
import { createRentalAction } from '@/server/actions/rentals';

const RENTAL_PREFS_KEY = 'rental-new-prefs';

// Default expected return = now + 7 days, formatted for datetime-local
function defaultReturnAt(): string {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  // Format as YYYY-MM-DDTHH:mm
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface Member {
  userId: string;
  displayName: string;
  email: string | null;
}

export interface RentalCreateFormProps {
  warehouses: Array<{ id: string; name: string }>;
  warehouseId: string;
  items: CatalogItem[];
  aisles: AisleSummary[];
  members: Member[];
  viewerRole: string;
}

// Inner component that has access to CartContext
function RentalCreateFormInner({
  warehouses,
  warehouseId,
  items: rawItems,
  aisles,
  members,
}: RentalCreateFormProps) {
  const router = useRouter();
  const { state, dispatch } = useCart();

  // Picker UI state
  const [activeAisleId, setActiveAisleId] = React.useState<string | 'all'>('all');
  const [searchQuery, setSearchQuery] = React.useState('');
  const [availabilityFilter, setAvailabilityFilter] = React.useState<AvailabilityFilter>('any');
  const [sortKey, setSortKey] = React.useState<SortKey>('name');

  // Deferred thumbnail URLs (same pattern as orders v2) — the hook retries
  // with backoff so one blip doesn't blank the whole session.
  const thumbUrls = useCatalogThumbnails(
    `/api/orders/catalog-thumbnails?warehouseId=${encodeURIComponent(warehouseId)}&includeRentals=1`,
  );

  const items = React.useMemo<CatalogItem[]>(() => {
    if (Object.keys(thumbUrls).length === 0) return rawItems;
    return rawItems.map((it) =>
      thumbUrls[it.id] ? { ...it, imageUrl: thumbUrls[it.id]! } : it,
    );
  }, [rawItems, thumbUrls]);

  // Grid prefs from localStorage
  const [cols, setCols] = React.useState<2 | 3 | 4>(4);
  const [groupByAisle, setGroupByAisle] = React.useState(true);
  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(RENTAL_PREFS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { cols?: 2 | 3 | 4; groupByAisle?: boolean };
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot localStorage hydration on mount
        if (parsed.cols) setCols(parsed.cols);
        if (typeof parsed.groupByAisle === 'boolean') setGroupByAisle(parsed.groupByAisle);
      }
    } catch { /* ignore */ }
  }, []);

  // Setup form state
  const [borrower, setBorrower] = React.useState<BorrowerValue>({
    borrowerUserId: null,
    borrowerName: '',
    borrowerEmail: null,
  });
  const [expectedReturnAt, setExpectedReturnAt] = React.useState(defaultReturnAt());
  const [notes, setNotes] = React.useState('');
  const [selectedWarehouseId, setSelectedWarehouseId] = React.useState(warehouseId);

  const [isPending, startTransition] = React.useTransition();

  // Availability per item
  const availByItem = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const it of items) {
      map.set(it.id, Math.max(0, it.quantityOnHand - it.reservedQuantity));
    }
    return map;
  }, [items]);

  // Filter pipeline
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
    searchQuery !== '' || availabilityFilter !== 'any' || sortKey !== 'name' || activeAisleId !== 'all';

  function clearFilters() {
    setActiveAisleId('all');
    setSearchQuery('');
    setAvailabilityFilter('any');
    setSortKey('name');
  }

  const itemMap = React.useMemo(
    () => new Map(items.map((it) => [it.id, it])),
    [items],
  );

  const lines = state.lines;
  const totalQty = lines.reduce((s, l) => s + l.quantity, 0);

  function handleSubmit() {
    if (lines.length === 0) {
      toast.error('Add at least one item before checking out.');
      return;
    }
    if (!borrower.borrowerName.trim()) {
      toast.error('Enter a borrower name.');
      return;
    }
    if (!expectedReturnAt) {
      toast.error('Set an expected return date.');
      return;
    }
    const returnDate = new Date(expectedReturnAt);
    if (Number.isNaN(returnDate.getTime()) || returnDate <= new Date()) {
      toast.error('Expected return date must be in the future.');
      return;
    }

    startTransition(async () => {
      const res = await createRentalAction({
        warehouseId: selectedWarehouseId,
        borrowerUserId: borrower.borrowerUserId ?? null,
        borrowerName: borrower.borrowerName.trim(),
        borrowerEmail: borrower.borrowerEmail ?? null,
        expectedReturnAt: returnDate.toISOString(),
        notes: notes.trim() || null,
        lines: lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
      });

      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }

      clearCartDraft(selectedWarehouseId);
      toast.success('Rental checked out.');
      router.push(`/dashboard/rentals/${res.data.id}`);
    });
  }

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      {/* Main column */}
      <div className="flex-1 min-w-0 space-y-4">
        {/* Setup card */}
        <div className="rounded-xl border bg-card p-4 space-y-4">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Setup
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Warehouse */}
            <div className="space-y-1.5">
              <Label htmlFor="rental-warehouse">Warehouse</Label>
              <Select
                value={selectedWarehouseId}
                onValueChange={(v) => {
                  setSelectedWarehouseId(v);
                  dispatch({ type: 'set-warehouse', warehouseId: v });
                }}
              >
                <SelectTrigger id="rental-warehouse">
                  <SelectValue placeholder="Select warehouse" />
                </SelectTrigger>
                <SelectContent>
                  {warehouses.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Expected return date */}
            <div className="space-y-1.5">
              <Label htmlFor="rental-return-date">Expected return</Label>
              <input
                id="rental-return-date"
                type="datetime-local"
                value={expectedReturnAt}
                onChange={(e) => setExpectedReturnAt(e.target.value)}
                min={new Date().toISOString().slice(0, 16)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>
          </div>

          {/* Borrower picker */}
          <div className="space-y-1.5">
            <Label htmlFor="rental-borrower">Borrower</Label>
            <BorrowerPicker
              members={members}
              value={borrower}
              onChange={setBorrower}
              disabled={isPending}
            />
          </div>
        </div>

        {/* Aisle bar */}
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
          groupByAisle={groupByAisle}
          cols={cols}
          onClearFilters={clearFilters}
        />
      </div>

      {/* Cart / Checkout rail */}
      <aside
        className="lg:sticky lg:top-4 lg:self-start w-full lg:w-[360px] lg:flex-none"
        aria-label="Checkout cart"
      >
        <div className="rounded-xl border bg-card p-4 space-y-4">
          {/* Header */}
          <div className="flex items-center gap-2">
            <ShoppingCart className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">
              Checkout
              {totalQty > 0 && (
                <span className="ml-1.5 text-muted-foreground font-normal">({totalQty})</span>
              )}
            </h2>
          </div>

          {/* Lines */}
          {lines.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              Add items from the catalog.
            </p>
          ) : (
            <ul className="space-y-2">
              {lines.map((line) => {
                const it = itemMap.get(line.itemId);
                if (!it) return null;
                return (
                  <li
                    key={line.itemId}
                    className="flex items-center gap-2 rounded-md border p-2 text-sm"
                  >
                    <span className="flex-1 font-medium truncate min-w-0">{it.name}</span>
                    <div className="flex items-center border rounded-md overflow-hidden h-7 flex-none">
                      <button
                        type="button"
                        onClick={() => dispatch({ type: 'dec', itemId: line.itemId })}
                        className="flex items-center justify-center w-7 h-7 hover:bg-muted transition-colors text-muted-foreground"
                        aria-label="Decrease quantity"
                      >
                        <Minus className="h-3 w-3" />
                      </button>
                      <span className="w-7 text-center text-xs font-semibold tabular-nums">
                        {line.quantity}
                      </span>
                      <button
                        type="button"
                        onClick={() => dispatch({ type: 'inc', itemId: line.itemId })}
                        disabled={line.quantity >= it.quantityOnHand}
                        className="flex items-center justify-center w-7 h-7 hover:bg-muted transition-colors text-muted-foreground disabled:opacity-40"
                        aria-label="Increase quantity"
                      >
                        <Plus className="h-3 w-3" />
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => dispatch({ type: 'remove', itemId: line.itemId })}
                      className="text-muted-foreground hover:text-destructive transition-colors"
                      aria-label="Remove"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {/* Notes */}
          <div className="space-y-1.5">
            <Label htmlFor="rental-notes">Notes (optional)</Label>
            <Textarea
              id="rental-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Event date, pickup instructions, etc."
              rows={2}
              disabled={isPending}
            />
          </div>

          {/* Submit */}
          <Button
            className="w-full"
            onClick={handleSubmit}
            disabled={isPending || lines.length === 0}
          >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Check out
          </Button>
        </div>
      </aside>
    </div>
  );
}

export function RentalCreateForm(props: RentalCreateFormProps) {
  const initial = initialCartState({
    warehouseId: props.warehouseId,
    fulfillmentType: 'pickup',
  });

  return (
    <CartProvider initial={initial}>
      <RentalCreateFormInner {...props} />
    </CartProvider>
  );
}
