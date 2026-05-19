# Orders — New v2 (Aisle Catalog Picker) Design

**Date:** 2026-05-18
**Status:** Draft (awaiting user review)
**Owner:** Branden

## Problem

The existing `/dashboard/orders/new` is a dense list with one row per item. It works but doesn't scale visually past ~50 items and gives no affordance for browsing by category or surfacing what the warehouse typically orders. A new aisle-catalog design (cards in a grid, sticky aisle bar, quick-add of frequent SKUs, cart rail with persistent draft) replaces it.

## Hard constraint

**The warehouse-team flow (approve → pick → stage → in_transit → sign → complete) does NOT change.** This redesign only replaces the requester-side picker UI. The submit endpoint is still `createOrderRequestAction`, which writes the same `order_requests` + `order_request_lines` rows the existing workflow consumes downstream. All downstream pages (`/dashboard/orders`, `/dashboard/orders/[id]`, packing slip PDFs, the `/orders/sign/[token]` signature flow) are untouched.

## Goals

- Card-grid catalog with thumbnails, aisle grouping, sticky aisle pill nav
- Quick-add row of the top-N most-ordered SKUs in the active warehouse
- Cart rail (sticky right column) with notes + totals + persistent draft (localStorage)
- Setup strip: warehouse · requested-by · deliver-to-site · pickup/delivery
- Keyboard nav, aria-live updates, AA contrast in both themes

## Non-goals

- Changing what the submit creates (still calls `createOrderRequestAction`)
- Server-side cart-draft persistence (spec marked optional; v1 = localStorage only)
- A new `user_prefs` DB table (decision: localStorage)
- Touching warehouse-side or signature flows
- Mobile redesign (responsive collapse only, no separate mobile UI)

## Key mapping decisions

| New design concept | Backend mapping |
| --- | --- |
| Aisle | `categories` table (org-defined, joined via `inventory_items.category_id`). Includes a synthetic "Uncategorized" pseudo-aisle for items with `category_id = NULL`. |
| Site (deliver-to) | `warehouse_charters` → `charters.name` (current `delivery_charter_id` column) |
| Stock pill | `quantity_on_hand - active reservations` (current `availableToPromise` logic) |
| Item price tag | `inventory_items.retail_price` if non-null, else `unit_cost` (configurable later), else `—` |
| On-behalf-of | Existing `onBehalfOf` field on `createOrderRequestAction`. Manager+ gated. |
| Quick-add freq | NEW `order_request_top_skus_for_warehouse(p_warehouse_id uuid, p_days int, p_limit int)` RPC backed by `order_request_lines` join `order_requests` filtered by created_at + warehouse |
| User prefs (cols, groupByAisle, showQuickAdd) | localStorage, key `order-new-v2-prefs:{userId}` |
| Cart draft | localStorage, key `order-draft:{warehouseId}` (existing convention) |
| Default warehouse | Today: `forcedWarehouseId(ctx)` for scoped roles, else last-used from localStorage `order-last-warehouse:{userId}`. No new DB column. |

## Layout

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Eyebrow • H1 "Place an order" • subtitle                  [Save draft] [×] │
├────────────────────────────────────────────────────────────────────────────┤
│ SETUP STRIP                                                                 │
│ [Warehouse ▾] [Requested by ▾] [Deliver to ▾] [● Pickup ○ Delivery]         │
├──────────────────────────────────────────────────────┬──────────────────────┤
│ AISLE BAR (sticky)                                   │  CART RAIL (sticky)  │
│ ┌──┐┌─────┐┌─────┐┌──────┐┌─────┐                    │  ┌────────────────┐  │
│ │All││Books││Apprl││Sppls││Equip│                    │  │ Cart (3)       │  │
│ └──┘└─────┘└─────┘└──────┘└─────┘                    │  ├────────────────┤  │
│                                                      │  │ Item 1   × 2   │  │
│ TOOLBAR                                              │  │ Item 2   × 1   │  │
│ [🔍 Search…] [Avail ▾] [Sort ▾]              [Clear] │  ├────────────────┤  │
│                                                      │  │ Notes…         │  │
│ QUICK-ADD (All view only)                            │  │ Total: $—      │  │
│ [SKU1] [SKU2] [SKU3] [SKU4] [SKU5] [SKU6]            │  │ [ Submit ]     │  │
│                                                      │  └────────────────┘  │
│ CATALOG GRID (4-up, grouped by aisle on All)         │                      │
│ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐                  │                      │
│ │ Card │ │ Card │ │ Card │ │ Card │                  │                      │
│ └──────┘ └──────┘ └──────┘ └──────┘                  │                      │
└──────────────────────────────────────────────────────┴──────────────────────┘
```

Stacks below 1280px: cart rail moves above grid (sticky disabled).

## The catalog card

Per the user's spec §03, verbatim:

- Square 1:1 thumbnail. Show item primary photo (signed thumbnail URL, same fast-path as the existing picker); placeholder = serif-glyph over CSS pinstripes when no image.
- Ink price tag (dark) top-right with a notched left edge via CSS pseudo-element triangle. Renders `formatCurrency(price)` or `—` if null.
- Glass-blur (backdrop-blur-md) stock pill bottom-left with color-coded dot:
  - green: `available ≥ reorder_point`
  - orange: `0 < available < reorder_point`
  - red: `available === 0`, label `Out`
- Body: H4 name (2-line clamp), then `{sku} · {categoryName}` in mono small text.
- Divider, then foot: `📍 {bin_location}` + Add button. Add transforms in-place into a stepper `[–] N [+]` when the item is in the cart — no layout shift (same width via min-width).
- In-cart styling: `inset 0 0 0 1px var(--accent-green)` + `border-color: var(--accent-green)` + a small `× N` chip on the thumbnail bottom-right.

## Data wiring (adapted to the codebase)

| Element | Where it comes from |
| --- | --- |
| Warehouses dropdown | Existing `WarehousesService.list()` (already on page) |
| Sites (charters) dropdown | Existing `loadChartersForWarehouse()` (already on page) |
| Catalog items | Existing `loadOrderableItems(orgId, warehouseId)` — already returns photos + rack labels |
| Categories (aisles) | NEW: `loadCategoriesForWarehouse()` — categories that any item in the active warehouse references; plus synthetic "Uncategorized" if any items have null category. |
| Reorder frequency | NEW: `GET /api/orders/freq?warehouseId={id}&days=30&limit=6` → calls `order_request_top_skus_for_warehouse` RPC. |
| Cart draft (local) | localStorage `order-draft:{warehouseId}`, debounced 250 ms on write. |
| Submit | Existing `createOrderRequestAction` server action. UNCHANGED. |

## Cart reducer

Lives at `apps/web/src/components/orders/v2/cart-context.tsx`. Per the spec §05:

```typescript
export type CartState = {
  warehouseId: string;
  charterId: string | null;
  fulfillmentType: 'pickup' | 'delivery';
  onBehalfOf: { name: string; email: string } | null;
  notes: string;
  lines: Array<{ itemId: string; quantity: number }>;
};

export type CartAction =
  | { type: 'hydrate'; state: CartState }
  | { type: 'add'; itemId: string; quantity?: number }
  | { type: 'inc'; itemId: string }
  | { type: 'dec'; itemId: string }
  | { type: 'remove'; itemId: string }
  | { type: 'clear' }
  | { type: 'set-setup'; patch: Partial<Pick<CartState, 'charterId' | 'fulfillmentType' | 'onBehalfOf'>> }
  | { type: 'set-notes'; value: string }
  | { type: 'set-warehouse'; warehouseId: string };  // also clears lines
```

On mount: read localStorage `order-draft:{warehouseId}` → dispatch `hydrate`.
On every state change: debounced 250 ms write back.
On `set-warehouse`: confirm prompt if `lines.length > 0`.

## State sources of truth

- Cart state → CartContext (the reducer above).
- UI state (active aisle, search query, sort, availability filter, group-by-aisle toggle, cols, showQuickAdd) → local `useState` in the page root.
- Persisted UI prefs (cols, groupByAisle, showQuickAdd) → localStorage `order-new-v2-prefs:{userId}`.

## RPC + endpoint

```sql
-- supabase/migrations/0127_order_request_top_skus.sql

create or replace function public.order_request_top_skus_for_warehouse(
  p_warehouse_id uuid,
  p_days         int,
  p_limit        int
) returns table (
  item_id uuid,
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
    and req.created_at >= now() - (p_days || ' days')::interval
    and req.status <> 'denied'
    and req.status <> 'cancelled'
  group by orl.item_id
  order by request_count desc
  limit greatest(p_limit, 1);
$$;
```

Endpoint:

```
GET /api/orders/freq?warehouseId=<uuid>&days=30&limit=6
→ 200 { items: [{ itemId, sku, name, categoryName, imageUrl, available, quantityOnHand, count }] }
→ 401 if unauthenticated
→ 403 if user can't read that warehouse
→ 400 if missing warehouseId
```

Joins inventory_items + categories + reservations + primary image in the same handler so the client gets render-ready rows. Reuses `ItemImagesService.primaryImagesForPdfRendering(itemIds, 200)` for the fast thumbnail path.

## File structure

### Add
- `supabase/migrations/0127_order_request_top_skus.sql` — RPC + grant
- `apps/web/src/app/api/orders/freq/route.ts` — GET handler
- `apps/web/src/components/orders/v2/cart-context.tsx` — Context + reducer
- `apps/web/src/components/orders/v2/orders-new-v2.tsx` — page root
- `apps/web/src/components/orders/v2/setup-strip.tsx`
- `apps/web/src/components/orders/v2/aisle-bar.tsx`
- `apps/web/src/components/orders/v2/toolbar.tsx`
- `apps/web/src/components/orders/v2/quick-add.tsx`
- `apps/web/src/components/orders/v2/catalog-grid.tsx`
- `apps/web/src/components/orders/v2/item-card.tsx`
- `apps/web/src/components/orders/v2/cart-rail.tsx`

### Modify
- `apps/web/src/app/(dashboard)/dashboard/orders/new/page.tsx` — swap `OrderRequestForm` → `OrdersNewV2`; add categories + freq loads.

### Untouched (explicit non-goals)
- `apps/web/src/components/orders/order-request-form.tsx` — left alone; this is the legacy form. Could be deleted once v2 is verified in prod for a week.
- `apps/web/src/server/services/order-requests.ts` — submit signature unchanged.
- `apps/web/src/server/actions/order-requests.ts` — unchanged.
- All warehouse-side pages, picking, packing slips, signature, etc.

## Edge cases (verbatim from spec, with codebase notes)

| Case | Handling |
| --- | --- |
| `item.price === null` | Price tag renders `—`. Excluded from cart estimated-value total. |
| `item.stock === 0` | Stock pill = red `Out`. Add button disabled. `+` inside stepper disabled at qty = stock. |
| Quick-add tap on item already in cart | `inc`, not `add` (handled by reducer's add semantics: `add` increments if present). |
| Long name | 2-line clamp + native `title` attribute for full text. |
| Long location | Truncate + `title`. |
| Warehouse with zero items | Empty state card with "Switch warehouse" CTA. |
| `/api/orders/freq` 404 / 500 | Quick-add row hides silently. No error toast. |
| Double-click on Submit | Button locks `disabled` until response returns. |
| Switch warehouse with items in cart | `window.confirm("Switch warehouse? Cart will be cleared.")`. |
| Aisle pills keyboard nav | Arrow keys move focus; Enter activates; Escape closes popovers. |
| Cart updates | `<div aria-live="polite">` near the rail summarizes "1 item added, 3 in cart". |

## Performance budget

- Initial paint < 1.5 s with 500-item catalog. (Current order page already loads ~272 items in < 1 s with the just-shipped fast thumb fix.)
- Virtualize the catalog grid IF item count > 250. Use `react-window` or equivalent; if it's not already in deps, decision: ship without virtualization in v1 and revisit. Adds the next bullet:
- **Virtualization deferred to follow-up.** Acceptable risk: rendering 500 cards is ~10MB DOM but the recent Vercel-grade Next.js handles it. If it noticeably degrades, add `react-window` then.

## Testing

- Unit: cart reducer (all 8 actions, including warehouse-change-clears-lines).
- Unit: aisle grouping logic (uncategorized synthetic bucket).
- Integration: freq route returns the expected shape, scopes by warehouse, respects RLS.
- E2E (manual): submit a cart from this UI; confirm an `order_requests` row appears identically to what the old form produced and the manager-side approve/pick flow proceeds unchanged.

## Open questions

None — the four mapping decisions are locked above.

## Out of scope (future)

- Server-side cart-draft persistence (spec marked optional v1).
- `user_prefs` DB table for cross-device pref sync.
- Card-grid virtualization (revisit if >250 items observably slow).
- Mobile-first layout overhaul.
- Bundles in the picker (currently filtered out as `is_bundle = true`).
