# Instant Inventory Search

**Date:** 2026-05-14
**Status:** Approved (proceeding to implementation plan)
**Owner:** Branden Vincent-Walker

## Goal

Typing in the search box on `/dashboard/inventory` and `/dashboard/books` should feel instant — sub-100ms perceived response on every keystroke, no full-page reload, no spinner-then-jump UX. Cross-page matches (items not on the rendered page) should appear within ~200ms after the user pauses typing.

## Why

Current behavior: each keystroke (after a 250ms debounce) calls `router.replace('?q=…')`, which Next.js handles by re-rendering the entire `/dashboard/inventory` server component. That triggers a fresh `Promise.all` of eight independent queries — `inventory.list`, `categories.list`, `locations.list`, `suppliers.list`, `tags.list`, `savedViews.list`, `listDistinctRacks`, then `getItemTrends` + `primaryImagesForItems` sequentially after. On a cold Vercel function this stack can take 1–1.5s. The user sees the search input freeze (debounce window) → spinner-ish nothing → page jump.

The categories/locations/suppliers/tags/savedViews/racks queries don't change when only `q` changes. We're paying for them every keystroke.

## Scope

- **In:** the search input rendered by `InventoryTable` (used on both Items and Books pages).
- **Out:** sort, multi-filter (category/location), pagination, archive toggle, scanner button. These continue to use the existing `router.replace` flow.
- **Out:** the command-palette (Cmd+K) — its existing `/api/search` flow stays. It does inherit the pg_trgm index speed-up for free.

## User-visible behavior

1. User types `s-h-i-r` in the inventory search box.
2. On EVERY keystroke (zero debounce), the 50 currently-rendered items are filtered in memory and the table updates instantly. Header text shows "Showing 7 matching 'shir' (searching…)".
3. 150ms after the user pauses typing, a background fetch hits `/api/items/search?q=shir&…` with all the other filter params forwarded.
4. When that fetch returns, the table swaps to the server-authoritative result set (potentially more rows than the local 50 had matched). Header text drops the "(searching…)" suffix and shows `Showing N matching 'shir'`.
5. The URL updates via `window.history.replaceState`, so the back button works and the URL is shareable. We deliberately avoid `router.replace` here: in Next.js App Router, `router.replace` re-executes server components for the new URL, which is exactly the page-reload-on-every-keystroke behavior we're escaping. `history.replaceState` updates the address bar without notifying the Next.js router, so the parent server component stays put and only the InventoryTable's local state changes.
6. Clearing the search restores the original prop-driven list with no network call.
7. If the user types again before the in-flight fetch resolves, an `AbortController` cancels it. Only the most recent query lands.

## Architecture

Three pieces:

### 1. Postgres trigram indexes (migration 0095)

Most of the inventory page's slow query path is `ilike` against `name`, `sku`, `barcode`. Without a supporting index, `ilike '%shirt%'` does a sequential scan. With `pg_trgm` + a GIN index on `gin_trgm_ops`, the same query becomes a fast index probe.

```sql
create extension if not exists pg_trgm with schema extensions;

create index if not exists inventory_items_name_trgm_idx
  on public.inventory_items
  using gin (lower(name) extensions.gin_trgm_ops)
  where deleted_at is null;

create index if not exists inventory_items_sku_trgm_idx
  on public.inventory_items
  using gin (lower(sku) extensions.gin_trgm_ops)
  where deleted_at is null;

create index if not exists inventory_items_barcode_trgm_idx
  on public.inventory_items
  using gin (lower(barcode) extensions.gin_trgm_ops)
  where deleted_at is null and barcode is not null;

create index if not exists purchase_orders_po_number_trgm_idx
  on public.purchase_orders
  using gin (lower(po_number) extensions.gin_trgm_ops);

create index if not exists suppliers_name_trgm_idx
  on public.suppliers
  using gin (lower(name) extensions.gin_trgm_ops)
  where deleted_at is null;
```

Side effects:
- Speeds up the command-palette `/api/search` route too (same ilike pattern).
- Indexes are partial on `deleted_at is null` so they only cover live rows; size stays small.
- One-time cost on creation is proportional to row count; for the current scale (~150 items, a few hundred POs/suppliers) it's instant.

Risk: zero behavior change — `ilike` semantics are identical; the planner just picks the index instead of a seq scan.

### 2. New API route: `GET /api/items/search`

A thin server-side wrapper around `InventoryService.list` that returns just the inventory list (items + total), no other lookups. Accepts the same query parameters as the inventory page reads from URL search params.

**Query parameters (all optional except as noted):**

| Param            | Type                                                                | Notes                                                          |
| ---------------- | ------------------------------------------------------------------- | -------------------------------------------------------------- |
| `q`              | string                                                              | The search term. Required; <2 chars returns empty result.      |
| `type`           | `'product' \| 'book' \| 'asset' \| 'consumable' \| 'all'`           | Defaults to `'product'` for Items page, must pass `'book'` for Books page. |
| `status`         | `'active' \| 'archived' \| 'discontinued' \| 'all'`                 | Defaults to `'active'`.                                        |
| `stock`          | `'low' \| 'out'`                                                    | Optional bucket filter.                                        |
| `cat`            | repeating string                                                    | Category UUIDs (multi-select).                                 |
| `loc`            | repeating string                                                    | Location UUIDs (multi-select).                                 |
| `rack`           | string                                                              | Rack filter (e.g. "20-A").                                     |
| `sort`           | `ItemListSort`                                                      | Defaults to `updated_desc`.                                    |
| `limit`          | int 1-200                                                           | Defaults to 50.                                                |
| `offset`         | int                                                                 | Defaults to 0.                                                 |
| `warehouseId`    | UUID                                                                | Optional warehouse scope (managers only — staff get forced).   |

**Auth:** `withApiContext()` (same pattern as `/api/search`). Returns 401 if unauthenticated.

**RLS / warehouse access:** Inherited from `InventoryService.list`, which already filters by `getWarehouseAccess(ctx).readableIds` for warehouse-scoped users. No new access surface.

**Response shape:**

```ts
{
  items: Array<{
    id: string;
    sku: string;
    barcode: string | null;
    name: string;
    quantity_on_hand: number;
    reorder_point: number;
    unit_cost: number;
    retail_price: number;
    status: 'active' | 'archived' | 'discontinued';
    category_id: string | null;
    primary_location_id: string | null;
    warehouse_id: string | null;
    item_type: 'product' | 'book' | 'asset' | 'consumable';
    custom_fields: Record<string, unknown> | null;
    updated_at: string;
    image_url: string | null;  // signed URL, populated for the search response
  }>;
  total: number;
}
```

The `image_url` field is populated by calling `ItemImagesService.primaryImagesForItems` on the matched items in the same request, so the search response is drop-in compatible with what the table renders today. Trends are NOT included in the search response — sparklines fall back to the flat-line placeholder for non-rendered rows (acceptable: search results are transient).

### 3. `InventoryTable` component changes

Three new pieces of state:

```ts
const [q, setQ] = useState(initialQuery);                  // existing
const [serverHits, setServerHits] = useState<Item[] | null>(null);  // NEW
const [serverLoading, setServerLoading] = useState(false);          // NEW
```

**Local filter (instant feedback):**

```ts
const localMatches = useMemo(() => {
  const needle = q.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((i) =>
    i.name.toLowerCase().includes(needle) ||
    i.sku.toLowerCase().includes(needle) ||
    (i.barcode ?? '').toLowerCase().includes(needle),
  );
}, [items, q]);
```

**Debounced server fetch (catch cross-page hits):**

```ts
useEffect(() => {
  const needle = q.trim();
  if (!needle) {
    setServerHits(null);
    setServerLoading(false);
    return;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(async () => {
    setServerLoading(true);
    try {
      const url = new URL('/api/items/search', window.location.origin);
      url.searchParams.set('q', needle);
      // forward all current URL filter params verbatim so the API
      // returns a result set consistent with the page's other filters
      for (const k of ['type', 'status', 'stock', 'sort', 'rack']) {
        const v = params.get(k);
        if (v) url.searchParams.set(k, v);
      }
      for (const v of params.getAll('cat')) url.searchParams.append('cat', v);
      for (const v of params.getAll('loc')) url.searchParams.append('loc', v);

      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error('search failed');
      const data = (await res.json()) as { items: Item[]; total: number };
      setServerHits(data.items);

      // URL update LAST, via raw history API so Next.js doesn't
      // re-execute server components (router.replace would).
      const next = new URLSearchParams(params.toString());
      next.set('q', needle);
      next.delete('page');
      const newUrl = `${window.location.pathname}?${next.toString()}`;
      window.history.replaceState(null, '', newUrl);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        // silent fall-back: keep local results, no toast
        setServerHits(null);
      }
    } finally {
      setServerLoading(false);
    }
  }, 150);
  return () => {
    ctrl.abort();
    clearTimeout(timer);
  };
}, [q]);
```

**Rendered rows:**

```ts
const displayed = serverHits ?? localMatches;
```

**Header text:**

```ts
const totalForHeader =
  q.trim() === '' ? total : (serverHits?.length ?? localMatches.length);
const headerSuffix = q.trim() && serverLoading ? ' (searching…)' : '';
```

The header swaps from `Showing 1–50 of 59` (no search) to `Showing 7 matching 'shir' (searching…)` then to `Showing 7 matching 'shir'`.

**No change to:** sort buttons, filter dropdowns, pagination, scanner, bulk-actions, saved-views chips. Those still go through `router.replace`, which the page-level server component handles by re-fetching everything — appropriate when the user explicitly changes a filter.

## Data flow

```
keystroke
  │
  ├──► setQ(value)              [synchronous]
  │       │
  │       └──► useMemo recomputes localMatches → table re-renders   [~0ms]
  │
  └──► debounced effect (150ms)
          │
          └──► fetch /api/items/search?q=…&type=…&…
                  │
                  └──► server: InventoryService.list({ q, … })
                          │
                          └──► PostgREST uses trigram index for ilike   [~5ms DB]
                                  │
                                  └──► response → setServerHits(items)   [~50–150ms total round-trip]
                                          │
                                          └──► history.replaceState (no Next.js re-render)
```

## Error handling

| Scenario                                      | Behavior                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| Network failure during background fetch       | Silently fall back to `localMatches`. No toast.                          |
| API returns 5xx                                | Same: silent fall-back. The local result is still useful.                |
| API returns 401 (session expired)              | Toast "Session expired — sign in again", let the auth middleware redirect on next nav. |
| User types a 1-char query                      | Local filter still runs; server fetch is skipped (q.trim().length < 2).  |
| AbortError on rapid typing                     | Swallowed silently. Normal flow.                                         |
| Concurrent change to sort/filter while typing  | Both apply correctly. The next `q` change picks up the new URL params.   |

## Testing

**Unit tests:**

- `inventory.search.test.ts` (new) — exercises the new API route with mock supabase. Verifies:
  - 401 when unauthenticated
  - empty result when q < 2 chars
  - delegates to `InventoryService.list` with correct filters
  - forwards `type`, `cat`, `loc`, etc. correctly
  - includes `image_url` in each item (mocked image service)

**Manual smoke tests (post-deploy):**

- Type slowly on `/dashboard/inventory` — header updates instantly, no spinner.
- Type fast → only the final keystroke's results land (AbortController works).
- Search for a known item, switch to Books page, search again — works for both pages.
- Clear search → see full list immediately.
- Hard-reload with `?q=foo` in URL → page renders with search applied (server-side path still works because `InventoryService.list({ q })` continues to be called from `page.tsx`).
- Switch to a viewer role / warehouse-scoped staff role → search respects warehouse access.

## Migration safety

`0095_search_trigram_indexes.sql` is purely additive:
- `create extension if not exists pg_trgm` — Supabase Pro has pg_trgm available; idempotent.
- `create index if not exists` on five indexes — idempotent. No data rewrite. No locks held longer than index creation.
- No column adds, no row updates, no policy changes.

Re-running the migration is a safe no-op.

## What's NOT changing

- `InventoryService.list` API surface (it already supports the `q` filter).
- The `q` sanitization regex (strips `,()%*` before interpolation) — stays in place inside the service.
- Warehouse access enforcement, RLS, soft-delete filtering, archived/active distinction.
- Sort, pagination, multi-select filters, scanner button, saved views, bulk actions.
- The command-palette flow (it benefits passively from trigram indexes).
- The books page's specific routing — `InventoryTable` is shared, so the fix applies to both.

## Open questions

None. All decisions made in the brainstorm:
- ✅ Approach C (instant local + dedicated API + trigram).
- ✅ 150ms debounce for server fetch.
- ✅ Silent fall-back on server failure (no toast).
- ✅ URL update is the LAST step (so abort doesn't leave a dangling `?q=`).
- ✅ image_url is computed server-side on /api/items/search results.
- ✅ Trends fall back to flat-line for search results (not worth the extra round trip).
