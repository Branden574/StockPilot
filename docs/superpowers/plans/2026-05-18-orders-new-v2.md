# Orders — New v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **HARD CONSTRAINT:** never modify any file under `apps/web/src/server/services/order-requests.ts`, `apps/web/src/server/actions/order-requests.ts`, `apps/web/src/app/(dashboard)/dashboard/orders/[id]/`, `apps/web/src/app/api/orders/[id]/`, `apps/web/src/components/orders/order-timeline.tsx`, `apps/web/src/components/orders/manager-actions-panel.tsx`, `apps/web/src/components/orders/digital-pick.tsx`, `apps/web/src/components/orders/signature-collector.tsx`, `apps/web/src/app/orders/sign/`, `apps/web/src/app/api/orders/sign/`, `apps/web/src/lib/pdf/packing-slip-shared.tsx`, `packages/core/src/order-state-machine.ts`. **These power the warehouse-team flow and the requester signing flow and must not change.**

**Goal:** Replace `/dashboard/orders/new` with a card-grid aisle-catalog picker. Backend unchanged; submit still calls `createOrderRequestAction`.

**Architecture:** New top-level component `OrdersNewV2` mounted on the existing page. Cart state lives in a Context + reducer with localStorage persistence. Catalog data is loaded server-side and passed in. Categories drive the aisle bar. One new RPC + one GET endpoint power the quick-add row.

**Tech Stack:** Next.js 16 App Router · React 19 · Tailwind · shadcn/ui · Supabase · zod · vitest. No new deps required (Context + reducer is React-native; debounce is a 3-line hook).

**Spec:** `docs/superpowers/specs/2026-05-18-orders-new-v2-design.md`

---

## File structure

### Create
- `supabase/migrations/0127_order_request_top_skus.sql` — RPC
- `apps/web/src/app/api/orders/freq/route.ts` — GET handler
- `apps/web/src/components/orders/v2/cart-context.tsx` — reducer + Context + hooks
- `apps/web/src/components/orders/v2/cart-context.test.ts` — reducer unit tests
- `apps/web/src/components/orders/v2/orders-new-v2.tsx` — root component
- `apps/web/src/components/orders/v2/setup-strip.tsx`
- `apps/web/src/components/orders/v2/aisle-bar.tsx`
- `apps/web/src/components/orders/v2/toolbar.tsx`
- `apps/web/src/components/orders/v2/quick-add.tsx`
- `apps/web/src/components/orders/v2/catalog-grid.tsx`
- `apps/web/src/components/orders/v2/item-card.tsx`
- `apps/web/src/components/orders/v2/cart-rail.tsx`
- `apps/web/src/components/orders/v2/types.ts` — shared types

### Modify
- `apps/web/src/app/(dashboard)/dashboard/orders/new/page.tsx` — swap legacy form for `OrdersNewV2`; add categories load.

---

## Task 1: Migration — `order_request_top_skus_for_warehouse` RPC

**Files:** Create `supabase/migrations/0127_order_request_top_skus.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0127_order_request_top_skus.sql
--
-- Powers the Quick-add row + "Most ordered" sort on the new orders/new
-- v2 picker. Returns the top-N item_ids by order_request_lines count
-- for a given warehouse in the last N days, excluding orders that
-- never produced fulfillment (denied / cancelled).
--
-- Aggregation key: order_request_lines.item_id (NOT sku). SKUs are no
-- longer globally unique within an org after migration 0126; counting
-- by item_id is correct and FK-safe.

create or replace function public.order_request_top_skus_for_warehouse(
  p_warehouse_id uuid,
  p_days         int,
  p_limit        int
) returns table (
  item_id       uuid,
  request_count bigint
)
language sql
stable
security invoker
as $$
  select orl.item_id,
         count(*)::bigint as request_count
  from public.order_request_lines orl
  join public.order_requests req on req.id = orl.order_request_id
  where req.warehouse_id = p_warehouse_id
    and req.created_at >= now() - (greatest(p_days, 1) || ' days')::interval
    and req.status not in ('denied', 'cancelled')
  group by orl.item_id
  order by request_count desc
  limit greatest(p_limit, 1);
$$;

revoke all on function public.order_request_top_skus_for_warehouse(uuid, int, int) from public;
revoke all on function public.order_request_top_skus_for_warehouse(uuid, int, int) from anon;
grant execute on function public.order_request_top_skus_for_warehouse(uuid, int, int) to authenticated;
```

- [ ] **Step 2: Commit + push (user applies migration)**

```bash
git add supabase/migrations/0127_order_request_top_skus.sql
git commit -m "feat(db): order_request_top_skus_for_warehouse RPC

Powers Quick-add row on the new orders/new v2 picker. Returns the
top-N item_ids by order_request_lines count for a given warehouse,
excluding denied/cancelled orders. RLS-scoped via security invoker.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push
```

- [ ] **Step 3: Pause and ask user to apply 0127 in Supabase**

Per project policy.

---

## Task 2: GET /api/orders/freq endpoint

**Files:** Create `apps/web/src/app/api/orders/freq/route.ts`

- [ ] **Step 1: Write the route handler**

```typescript
// apps/web/src/app/api/orders/freq/route.ts
import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { ItemImagesService } from '@/server/services/item-images';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_DAYS = 30;
const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 12;

export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const url = new URL(req.url);
  const warehouseId = url.searchParams.get('warehouseId');
  if (!warehouseId) {
    return NextResponse.json({ error: 'warehouseId is required' }, { status: 400 });
  }
  const days = Math.min(Math.max(Number.parseInt(url.searchParams.get('days') ?? '', 10) || DEFAULT_DAYS, 1), 365);
  const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') ?? '', 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  // RLS on order_requests already scopes the RPC; if the warehouseId
  // isn't readable to this user the RPC returns an empty set (RLS-safe).
  const { data: topRows, error: rpcErr } = await ctx.supabase.rpc(
    'order_request_top_skus_for_warehouse',
    { p_warehouse_id: warehouseId, p_days: days, p_limit: limit },
  );
  if (rpcErr) {
    return NextResponse.json({ error: 'internal_error', message: rpcErr.message }, { status: 500 });
  }
  const top = (topRows ?? []) as Array<{ item_id: string; request_count: number }>;
  if (top.length === 0) return NextResponse.json({ items: [] }, { status: 200 });

  const itemIds = top.map((r) => r.item_id);

  // Fetch render-ready item rows + reservations in parallel.
  const [itemsRes, resvRes] = await Promise.all([
    ctx.supabase
      .from('inventory_items')
      .select('id, sku, name, quantity_on_hand, category_id, item_type')
      .eq('organization_id', ctx.organizationId)
      .in('id', itemIds)
      .is('deleted_at', null)
      .eq('status', 'active'),
    ctx.supabase
      .from('stock_reservations')
      .select('item_id, quantity')
      .eq('organization_id', ctx.organizationId)
      .in('item_id', itemIds)
      .is('released_at', null),
  ]);

  type ItemRow = {
    id: string;
    sku: string;
    name: string;
    quantity_on_hand: number;
    category_id: string | null;
    item_type: string | null;
  };
  const items = (itemsRes.data ?? []) as ItemRow[];

  const reservedByItem = new Map<string, number>();
  for (const r of (resvRes.data ?? []) as Array<{ item_id: string; quantity: number }>) {
    reservedByItem.set(r.item_id, (reservedByItem.get(r.item_id) ?? 0) + Number(r.quantity));
  }

  const categoryIds = [...new Set(items.map((i) => i.category_id).filter((v): v is string => Boolean(v)))];
  const categoryNameById = new Map<string, string>();
  if (categoryIds.length > 0) {
    const { data: cats } = await ctx.supabase
      .from('categories')
      .select('id, name')
      .eq('organization_id', ctx.organizationId)
      .in('id', categoryIds);
    for (const c of (cats ?? []) as Array<{ id: string; name: string }>) {
      categoryNameById.set(c.id, c.name);
    }
  }

  const imagesSvc = new ItemImagesService(ctx);
  const imageUrlByItem = await imagesSvc.primaryImagesForPdfRendering(itemIds, 200);

  // Preserve the RPC's count-desc ordering by walking `top` (not items).
  const out = top
    .map((row) => {
      const it = items.find((i) => i.id === row.item_id);
      if (!it) return null;
      const reserved = reservedByItem.get(it.id) ?? 0;
      const available = Math.max(0, Number(it.quantity_on_hand) - reserved);
      return {
        itemId: it.id,
        sku: it.sku,
        name: it.name,
        categoryName: it.category_id ? categoryNameById.get(it.category_id) ?? null : null,
        imageUrl: imageUrlByItem.get(it.id) ?? null,
        available,
        quantityOnHand: Number(it.quantity_on_hand),
        count: Number(row.request_count),
      };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null);

  return NextResponse.json({ items: out }, { status: 200 });
}
```

- [ ] **Step 2: Verify build**

```bash
cd "/Users/brandenvincent-walker/Desktop/Inventory System App/apps/web"
pnpm typecheck   # must be clean
pnpm lint        # 0 errors on new file
```

- [ ] **Step 3: Commit + push**

```bash
git add apps/web/src/app/api/orders/freq/route.ts
git commit -m "feat(orders): GET /api/orders/freq endpoint

Returns the top-N most-frequently-ordered items for a warehouse over
the last N days. Joins inventory_items + categories + reservations
and resolves a fast thumbnail URL per item so the Quick-add row
renders without follow-up round trips.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push
```

---

## Task 3: Cart reducer + Context (TDD)

**Files:**
- Create `apps/web/src/components/orders/v2/types.ts`
- Create `apps/web/src/components/orders/v2/cart-context.tsx`
- Create `apps/web/src/components/orders/v2/cart-context.test.ts`

- [ ] **Step 1: Write `types.ts`**

```typescript
// apps/web/src/components/orders/v2/types.ts

export interface CatalogItem {
  id: string;
  sku: string;
  name: string;
  warehouseId: string;
  quantityOnHand: number;
  reservedQuantity: number;
  itemType: string | null;
  categoryId: string | null;
  categoryName: string | null;
  rackLabel: string | null;
  imageUrl: string | null;
  /** retail_price preferred, else unit_cost, else null. */
  price: number | null;
  reorderPoint: number;
}

export interface AisleSummary {
  id: string | null; // null = synthetic "Uncategorized" bucket
  name: string;
  itemCount: number;
}

export interface CartLineState {
  itemId: string;
  quantity: number;
}

export interface CartState {
  warehouseId: string;
  charterId: string | null;
  fulfillmentType: 'pickup' | 'delivery';
  onBehalfOf: { name: string; email: string } | null;
  notes: string;
  lines: CartLineState[];
}

export type CartAction =
  | { type: 'hydrate'; state: CartState }
  | { type: 'add'; itemId: string; quantity?: number }
  | { type: 'inc'; itemId: string }
  | { type: 'dec'; itemId: string }
  | { type: 'remove'; itemId: string }
  | { type: 'clear' }
  | {
      type: 'set-setup';
      patch: Partial<Pick<CartState, 'charterId' | 'fulfillmentType' | 'onBehalfOf'>>;
    }
  | { type: 'set-notes'; value: string }
  | { type: 'set-warehouse'; warehouseId: string };
```

- [ ] **Step 2: Write the failing reducer test**

```typescript
// apps/web/src/components/orders/v2/cart-context.test.ts
import { describe, it, expect } from 'vitest';

import { cartReducer, initialCartState } from './cart-context';

describe('cartReducer', () => {
  const seed = initialCartState({
    warehouseId: 'wh-1',
    fulfillmentType: 'pickup',
  });

  it('add appends a new line at quantity 1 by default', () => {
    const next = cartReducer(seed, { type: 'add', itemId: 'i-1' });
    expect(next.lines).toEqual([{ itemId: 'i-1', quantity: 1 }]);
  });

  it('add on an existing item increments instead of duplicating', () => {
    let s = cartReducer(seed, { type: 'add', itemId: 'i-1' });
    s = cartReducer(s, { type: 'add', itemId: 'i-1', quantity: 2 });
    expect(s.lines).toEqual([{ itemId: 'i-1', quantity: 3 }]);
  });

  it('inc and dec adjust quantity; dec at 1 removes the line', () => {
    let s = cartReducer(seed, { type: 'add', itemId: 'i-1' });
    s = cartReducer(s, { type: 'inc', itemId: 'i-1' });
    expect(s.lines[0]!.quantity).toBe(2);
    s = cartReducer(s, { type: 'dec', itemId: 'i-1' });
    s = cartReducer(s, { type: 'dec', itemId: 'i-1' });
    expect(s.lines).toEqual([]);
  });

  it('remove drops the line regardless of quantity', () => {
    let s = cartReducer(seed, { type: 'add', itemId: 'i-1', quantity: 7 });
    s = cartReducer(s, { type: 'remove', itemId: 'i-1' });
    expect(s.lines).toEqual([]);
  });

  it('clear empties lines but keeps setup', () => {
    let s = cartReducer(seed, { type: 'add', itemId: 'i-1' });
    s = cartReducer(s, { type: 'set-notes', value: 'rush' });
    const cleared = cartReducer(s, { type: 'clear' });
    expect(cleared.lines).toEqual([]);
    expect(cleared.notes).toBe('rush');
    expect(cleared.warehouseId).toBe('wh-1');
  });

  it('set-warehouse changes the id and clears lines', () => {
    let s = cartReducer(seed, { type: 'add', itemId: 'i-1' });
    s = cartReducer(s, { type: 'set-warehouse', warehouseId: 'wh-2' });
    expect(s.warehouseId).toBe('wh-2');
    expect(s.lines).toEqual([]);
  });

  it('set-setup patches only specified keys', () => {
    const s = cartReducer(seed, {
      type: 'set-setup',
      patch: { charterId: 'c-1' },
    });
    expect(s.charterId).toBe('c-1');
    expect(s.fulfillmentType).toBe('pickup');
  });

  it('hydrate replaces state wholesale', () => {
    const restored = cartReducer(seed, {
      type: 'hydrate',
      state: {
        ...seed,
        notes: 'from storage',
        lines: [{ itemId: 'i-9', quantity: 4 }],
      },
    });
    expect(restored.notes).toBe('from storage');
    expect(restored.lines[0]!.itemId).toBe('i-9');
  });
});
```

- [ ] **Step 3: Run failing test**

```bash
cd "/Users/brandenvincent-walker/Desktop/Inventory System App/apps/web"
pnpm test src/components/orders/v2/cart-context.test.ts
# Expected: FAIL — cart-context.tsx doesn't exist yet
```

- [ ] **Step 4: Write `cart-context.tsx`**

```typescript
// apps/web/src/components/orders/v2/cart-context.tsx
'use client';

import * as React from 'react';

import type { CartAction, CartState } from './types';

const STORAGE_PREFIX = 'order-draft:';
const SAVE_DEBOUNCE_MS = 250;

export function initialCartState(
  init: Pick<CartState, 'warehouseId' | 'fulfillmentType'> &
    Partial<Pick<CartState, 'charterId' | 'onBehalfOf' | 'notes'>>,
): CartState {
  return {
    warehouseId: init.warehouseId,
    charterId: init.charterId ?? null,
    fulfillmentType: init.fulfillmentType,
    onBehalfOf: init.onBehalfOf ?? null,
    notes: init.notes ?? '',
    lines: [],
  };
}

export function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case 'hydrate':
      return action.state;
    case 'add': {
      const delta = action.quantity ?? 1;
      const existing = state.lines.find((l) => l.itemId === action.itemId);
      if (existing) {
        return {
          ...state,
          lines: state.lines.map((l) =>
            l.itemId === action.itemId
              ? { ...l, quantity: l.quantity + delta }
              : l,
          ),
        };
      }
      return { ...state, lines: [...state.lines, { itemId: action.itemId, quantity: delta }] };
    }
    case 'inc':
      return {
        ...state,
        lines: state.lines.map((l) =>
          l.itemId === action.itemId ? { ...l, quantity: l.quantity + 1 } : l,
        ),
      };
    case 'dec':
      return {
        ...state,
        lines: state.lines.flatMap((l) => {
          if (l.itemId !== action.itemId) return [l];
          if (l.quantity <= 1) return [];
          return [{ ...l, quantity: l.quantity - 1 }];
        }),
      };
    case 'remove':
      return { ...state, lines: state.lines.filter((l) => l.itemId !== action.itemId) };
    case 'clear':
      return { ...state, lines: [] };
    case 'set-setup':
      return { ...state, ...action.patch };
    case 'set-notes':
      return { ...state, notes: action.value };
    case 'set-warehouse':
      return { ...state, warehouseId: action.warehouseId, lines: [] };
    default:
      return state;
  }
}

interface CartContextValue {
  state: CartState;
  dispatch: React.Dispatch<CartAction>;
}

const CartContext = React.createContext<CartContextValue | null>(null);

export function CartProvider({
  initial,
  children,
}: {
  initial: CartState;
  children: React.ReactNode;
}) {
  const [state, dispatch] = React.useReducer(cartReducer, initial);

  // Hydrate from localStorage on mount (after initial render so SSR
  // doesn't see device-specific cart state).
  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(`${STORAGE_PREFIX}${initial.warehouseId}`);
      if (!raw) return;
      const parsed = JSON.parse(raw) as CartState;
      // Only hydrate if the persisted warehouse matches the active one —
      // protects against stale drafts after a warehouse switch.
      if (parsed && parsed.warehouseId === initial.warehouseId) {
        dispatch({ type: 'hydrate', state: parsed });
      }
    } catch {
      /* corrupted draft = ignore */
    }
     
  }, []);

  // Debounced save on every change.
  React.useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(
          `${STORAGE_PREFIX}${state.warehouseId}`,
          JSON.stringify(state),
        );
      } catch {
        /* quota exceeded — silent fail */
      }
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [state]);

  return (
    <CartContext.Provider value={{ state, dispatch }}>
      {children}
    </CartContext.Provider>
  );
}

export function useCart() {
  const ctx = React.useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used inside <CartProvider>');
  return ctx;
}

export function clearCartDraft(warehouseId: string) {
  try {
    localStorage.removeItem(`${STORAGE_PREFIX}${warehouseId}`);
  } catch {
    /* noop */
  }
}
```

- [ ] **Step 5: Run tests, expect 8/8 PASS**

```bash
pnpm test src/components/orders/v2/cart-context.test.ts
```

- [ ] **Step 6: Commit + push**

```bash
git add apps/web/src/components/orders/v2/types.ts \
        apps/web/src/components/orders/v2/cart-context.tsx \
        apps/web/src/components/orders/v2/cart-context.test.ts
git commit -m "feat(orders): cart reducer + Context for new orders/new v2 picker

8 actions covering add/inc/dec/remove/clear, setup patch, notes,
warehouse switch (clears lines), and hydrate-from-storage.
Debounced localStorage write on every state change so cart drafts
survive a refresh. Unit-tested.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push
```

---

## Task 4: Page server component — categories + freq fallback

**Files:** Modify `apps/web/src/app/(dashboard)/dashboard/orders/new/page.tsx`

- [ ] **Step 1: Extend `loadOrderableItems` to also return category, price, reorderPoint**

In the existing select column list and the return shape, add:
- Select columns: `retail_price, unit_cost, reorder_point, category_id`
- Result fields: `categoryId`, `categoryName` (null for now — joined below), `price` (retail_price ?? unit_cost ?? null), `reorderPoint`

- [ ] **Step 2: Add `loadCategoriesForWarehouse` server helper**

In the same page file, add below `loadOrderableItems`:

```typescript
async function loadCategoriesForWarehouse(
  organizationId: string,
  items: ReadonlyArray<{ categoryId: string | null }>,
): Promise<Array<{ id: string; name: string }>> {
  const ids = [...new Set(items.map((i) => i.categoryId).filter((v): v is string => Boolean(v)))];
  if (ids.length === 0) return [];
  const supabase = await createClient();
  const { data } = await supabase
    .from('categories')
    .select('id, name')
    .eq('organization_id', organizationId)
    .in('id', ids)
    .order('name', { ascending: true });
  return ((data ?? []) as Array<{ id: string; name: string }>).map((c) => ({ id: c.id, name: c.name }));
}
```

- [ ] **Step 3: Join category names back into items**

In `loadOrderableItems`'s final map, hydrate `categoryName` by looking up `category_id` against the categories result. Actually simpler: do the categories load INSIDE `loadOrderableItems` so the map can use it directly.

- [ ] **Step 4: Replace the legacy form mount with `OrdersNewV2`**

Locate the `return (...)` block in the page. Replace `<OrderRequestForm ... />` with `<OrdersNewV2 ... />` and pass the new props (warehouses, items, categories, charters, initialWarehouseId, role).

- [ ] **Step 5: Verify build + commit + push**

```bash
cd "/Users/brandenvincent-walker/Desktop/Inventory System App/apps/web"
pnpm typecheck
pnpm lint
```

Commit only after typecheck + lint clean.

---

## Task 5: Component tree (one subagent, big task)

**Files:**
- Create `apps/web/src/components/orders/v2/orders-new-v2.tsx`
- Create `apps/web/src/components/orders/v2/setup-strip.tsx`
- Create `apps/web/src/components/orders/v2/aisle-bar.tsx`
- Create `apps/web/src/components/orders/v2/toolbar.tsx`
- Create `apps/web/src/components/orders/v2/quick-add.tsx`
- Create `apps/web/src/components/orders/v2/catalog-grid.tsx`
- Create `apps/web/src/components/orders/v2/item-card.tsx`
- Create `apps/web/src/components/orders/v2/cart-rail.tsx`

This task is large enough that it gets its own subagent dispatch. The subagent will receive the full spec doc plus the implementation hints below.

### Implementation hints (for the subagent)

**`orders-new-v2.tsx` (root)** — Wraps everything in `<CartProvider>`. Owns UI-only state: `activeAisleId` (string | 'all'), `searchQuery`, `availabilityFilter` ('any' | 'in-stock' | 'low' | 'out'), `sortKey` ('name' | 'most-ordered' | 'least-stock'), `prefs` (cols, groupByAisle, showQuickAdd) hydrated from localStorage `order-new-v2-prefs:{userId}`. Filters/sorts items based on these. Renders SetupStrip + AisleBar + Toolbar + QuickAdd + CatalogGrid + CartRail.

**`setup-strip.tsx`** — 4 dropdowns. Warehouse uses native `<Select>` from shadcn/ui. On warehouse change, calls `router.push('?warehouseId=...')` (server reload) AFTER confirm if cart has lines. Deliver-to uses charter list. Pickup/Delivery is a 2-button toggle. The "Requested by" affordance opens a Dialog for the onBehalfOf entry — only visible to manager+.

**`aisle-bar.tsx`** — `<nav aria-label="Aisles">` with `<button>` pills. `aria-current="page"` on the active one. Sticky `top-14` (matches existing topbar offset; mirror item-detail.tsx:151's `sticky top-0` pattern but adjust for parent layout). Pills: "All" + one per category name + "Uncategorized" if any items have null category. Each pill shows its item count.

**`toolbar.tsx`** — Search input (debounced 150 ms via a small inline hook), Availability popover (radio: Any / In stock / Low / Out), Sort popover (radio: Name A→Z / Most ordered / Least stock first), Clear button (resets all toolbar state).

**`quick-add.tsx`** — Fetches `/api/orders/freq?warehouseId=...&limit=6` on mount via `fetch()`. While loading: skeleton row. On error: hides itself. On success: 6 mini-cards (just thumbnail + name + Add). Clicking Add dispatches `add` (which the reducer increments correctly if already in cart). Only renders when `activeAisleId === 'all'` AND prefs.showQuickAdd.

**`catalog-grid.tsx`** — Receives the filtered+sorted items. When `groupByAisle && activeAisleId === 'all'`: groups by `categoryName` and renders a section header per aisle. Otherwise: flat grid. Grid is `grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4` (cols pref overrides). Empty state when 0 items match the filter (with a "Clear filters" CTA).

**`item-card.tsx`** — Per spec §03. Use a CSS pseudo-element triangle for the notched price tag (no SVG). `backdrop-blur-md` on the stock pill (Tailwind). When in cart: replace `<Button>Add</Button>` with a stepper `[–] N [+]` — both use the same fixed width (e.g. `min-w-[5.5rem]`) so the surrounding row layout doesn't shift. The `× N` badge on the thumb is `absolute bottom-1 right-1`.

**`cart-rail.tsx`** — Sticky `top-14 lg:sticky lg:self-start`. Lists cart lines with item name + qty + remove. Notes `<Textarea>`. Total qty + estimated value. Submit `<Button>` calls `createOrderRequestAction` with the cart state mapped to the action's input shape. On success: `clearCartDraft(warehouseId)` + `router.push('/dashboard/orders/${id}')`. The aria-live region lives inside the rail, screen-reader-only (`sr-only`), and announces cart changes ("Added Beats Solo 3. 4 items in cart.").

### Subagent dispatch checklist

- [ ] **Step 1: Dispatch implementer subagent** (see prompt structure below)
- [ ] **Step 2: Implementer reports DONE**
- [ ] **Step 3: Run typecheck + lint + test from controller** (per memory `feedback_subagent_typecheck_gate.md`)
- [ ] **Step 4: Spec-compliance review subagent**
- [ ] **Step 5: Code-quality review subagent**
- [ ] **Step 6: Fix any reviewer findings**
- [ ] **Step 7: Commit + push**

#### Implementer prompt outline

The controller will assemble a prompt that includes:
- The spec doc (read by the subagent)
- The 8 file paths to create
- The implementation hints above
- A note: HARD CONSTRAINT — do not modify any file outside `apps/web/src/components/orders/v2/`. The page wiring (Task 4) is already done.
- Run typecheck + lint + test before reporting DONE.

---

## Task 6: Manual E2E — submit unchanged behavior

**No files modified.** Verifies the constraint that the warehouse flow is untouched.

- [ ] **Step 1: Boot dev server**

`pnpm -F @stockpilot/web dev`

- [ ] **Step 2: Place an order via the new picker**

- Open `/dashboard/orders/new`. Should see the new aisle-catalog UI.
- Select warehouse, deliver-to, pickup/delivery.
- Add 2-3 items via card Add + 1 via Quick-add.
- Add notes.
- Submit.

Expected: redirect to `/dashboard/orders/{id}`.

- [ ] **Step 3: Confirm the row was created identically**

- The new order detail page shows the same fields it always did.
- Check `order_requests` columns: `requester_*`, `warehouse_id`, `delivery_charter_id`, `fulfillment_type`, `notes`, `status='requested'`.
- Check `order_request_lines` count + quantities.
- The manager-approve flow works as before (approve → pick → stage → in_transit → sign).

- [ ] **Step 4: Confirm the warehouse-side packing slip PDFs render correctly**

Hit `/api/orders/{id}/packing-slip-warehouse.pdf` — should be byte-identical in structure to a slip generated from an order placed via the OLD form. (Spot-check a few items rendered with correct name/SKU/rack.)

- [ ] **Step 5: Cart persistence**

- Place items in cart, refresh the page, items should still be there.
- Switch warehouse, accept the confirm, cart clears.

- [ ] **Step 6: Mark task complete after a green pass**

---

## Task 7: Lint, typecheck, final push

- [ ] **Step 1: Full test sweep**

```bash
cd "/Users/brandenvincent-walker/Desktop/Inventory System App/apps/web"
pnpm test
pnpm typecheck
pnpm lint
```

All must be clean.

- [ ] **Step 2: Check pnpm-lock.yaml**

```bash
git status pnpm-lock.yaml
```

Expected: unchanged (no new deps).

- [ ] **Step 3: Wait for Vercel CI on the previous task's push**

Confirm GitHub Actions / Vercel deploy is green for the latest commits.

- [ ] **Step 4: Final commit if anything left**

Otherwise this task is just a verification gate.

---

## Self-Review Notes

**Spec coverage:**
- Aisle bar → Task 5 (`aisle-bar.tsx`)
- Catalog card anatomy → Task 5 (`item-card.tsx`)
- Setup strip → Task 5 (`setup-strip.tsx`)
- Quick-add row → Task 5 + Task 2 endpoint
- Cart rail + reducer → Task 3 + Task 5 (`cart-rail.tsx`)
- localStorage persistence → Task 3 (cart) + Task 5 (UI prefs)
- Edge cases → spread across Tasks 3, 5

**Risks:**
- Visual design fidelity is best-effort: we don't have the actual HTML/JSX prototype to compare pixels against (URL too large to fetch). Will iterate on user feedback.
- Performance with 500+ items: shipping without virtualization in v1. Will add if observably slow.
- shadcn/ui primitives required (Dialog, Select, Popover, Textarea, Button, Input): all already in repo per existing imports.

**Hard constraint reminder for every task:** the warehouse-team flow + signature flow do NOT change. If a subagent reports needing to modify any file in the "do not touch" list at the top of this plan, that's an immediate STOP — re-scope the task.
