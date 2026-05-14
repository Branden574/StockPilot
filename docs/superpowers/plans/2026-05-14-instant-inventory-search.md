# Instant Inventory Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make typing in the Inventory and Books search input feel instant (sub-100ms perceived) by combining client-side local filtering with a dedicated `/api/items/search` endpoint backed by Postgres trigram indexes, instead of triggering a full page re-render on every keystroke.

**Architecture:** Three layers in series — (1) a SQL migration adding `pg_trgm` GIN indexes that make `ilike` queries 10-50× faster, (2) a thin Next.js API route `GET /api/items/search` that wraps `InventoryService.list` and adds primary-image signed URLs, (3) a refactor of `InventoryTable` to filter rendered items locally on every keystroke (zero latency) while a debounced 150ms background fetch hits the new API for cross-page matches. The URL is updated via `window.history.replaceState` to avoid Next.js App Router's automatic server re-render.

**Tech Stack:** Next.js 16 App Router · Supabase Postgres + supabase-js · React 19 + useEffect/useMemo/AbortController · Postgres pg_trgm extension · TypeScript strict.

**Source spec:** [docs/superpowers/specs/2026-05-14-instant-inventory-search-design.md](../specs/2026-05-14-instant-inventory-search-design.md)

---

## File Structure

**Created:**
- `supabase/migrations/0095_search_trigram_indexes.sql` — pg_trgm extension + 5 GIN indexes.
- `apps/web/src/app/api/items/search/route.ts` — new GET endpoint.
- `apps/web/src/app/api/items/search/route.test.ts` — Vitest tests for the endpoint.

**Modified:**
- `apps/web/src/components/inventory/inventory-table.tsx` — local filter + debounced server fetch + `history.replaceState`.

**Untouched (consumers verify but don't edit):**
- `apps/web/src/server/services/inventory.ts` — `InventoryService.list` already supports the `q` filter.
- `apps/web/src/server/services/item-images.ts` — `primaryImagesForItems` already exists.
- `apps/web/src/lib/auth/api-context.ts` — `withApiContext` already exists.
- `apps/web/src/app/(dashboard)/dashboard/inventory/page.tsx` and `.../books/page.tsx` — unchanged; the URL update from `history.replaceState` doesn't trigger their server re-render.

---

## PR 1 — Postgres trigram indexes (migration 0095)

### Task 1.1: Write the migration file

**Files:**
- Create: `supabase/migrations/0095_search_trigram_indexes.sql`

- [ ] **Step 1: Create the file with the migration content**

```sql
-- 0095_search_trigram_indexes.sql
-- pg_trgm GIN indexes for fast ilike on items / POs / suppliers.
-- Speeds up:
--   • the /api/items/search endpoint added alongside this migration
--   • the existing /api/search command-palette route (passively)
--   • InventoryService.list's `q` filter when called from page.tsx
--
-- All indexes are partial (only live rows) so they stay small. Wrap
-- the values in `lower(...)` to match the ilike pattern PostgREST
-- generates ("ilike" is already case-insensitive but indexes built
-- on lower(column) + gin_trgm_ops are the standard idiom and let the
-- planner pick the index reliably).

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

- [ ] **Step 2: Verify the file parses as valid SQL locally (syntax sanity check)**

Run: `cat supabase/migrations/0095_search_trigram_indexes.sql | head -20`
Expected: prints the header — confirms the file was written.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0095_search_trigram_indexes.sql
git commit -m "feat(db): pg_trgm GIN indexes for ilike search (0095)

Five partial GIN indexes on lower(column) + gin_trgm_ops for the
columns hit by both /api/items/search and the existing
command-palette /api/search:

- inventory_items.name / .sku / .barcode (where deleted_at is null)
- purchase_orders.po_number
- suppliers.name (where deleted_at is null)

Without these, ilike '%foo%' is a seq scan. With them, it's a
sub-10ms index probe on tables up to ~10M rows. Purely additive —
no data changes, no behavior changes; the planner just picks the
index when the cost beats a seq scan.

Migration is idempotent (create extension / index if not exists).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Push and PAUSE for the user to apply**

```bash
git push
```

Per the project's pause-after-each-migration rule, stop here. The user applies `0095` in the Supabase SQL editor before continuing. They will confirm by saying "0095 good" or similar.

---

## PR 2 — `/api/items/search` endpoint

### Task 2.1: Write the failing test for the search route

**Files:**
- Create: `apps/web/src/app/api/items/search/route.test.ts`

The endpoint is a thin wrapper around `InventoryService.list` that also batches in primary-image signed URLs. The test exercises both: that the service is called with the parsed query params, and that the response shape matches the spec.

- [ ] **Step 1: Write the failing test file**

```ts
// apps/web/src/app/api/items/search/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const withApiContextMock = vi.fn();
const inventoryListMock = vi.fn();
const primaryImagesMock = vi.fn();

vi.mock('@/lib/auth/api-context', () => ({
  withApiContext: withApiContextMock,
}));
vi.mock('@/server/services/inventory', () => ({
  InventoryService: class {
    constructor() {}
    list = inventoryListMock;
  },
}));
vi.mock('@/server/services/item-images', () => ({
  ItemImagesService: class {
    constructor() {}
    primaryImagesForItems = primaryImagesMock;
  },
}));

import { GET } from './route';

function makeReq(qs: string): Request {
  return new Request(`https://example.com/api/items/search?${qs}`);
}

describe('GET /api/items/search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withApiContextMock.mockResolvedValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: {} as any,
      organizationId: 'org-1',
      userId: 'u-1',
      email: 'a@b.c',
      role: 'admin',
    });
    primaryImagesMock.mockResolvedValue(new Map());
  });

  it('returns 401 when unauthenticated', async () => {
    withApiContextMock.mockResolvedValueOnce(null);
    const res = await GET(makeReq('q=shir'));
    expect(res.status).toBe(401);
  });

  it('returns empty when q < 2 chars', async () => {
    const res = await GET(makeReq('q=a'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ items: [], total: 0 });
    expect(inventoryListMock).not.toHaveBeenCalled();
  });

  it('forwards filters to InventoryService.list', async () => {
    inventoryListMock.mockResolvedValueOnce({
      items: [
        {
          id: 'i1',
          sku: 'SP-1',
          barcode: null,
          name: 'Black T-Shirt',
          quantity_on_hand: 5,
          reorder_point: 0,
          unit_cost: 4,
          retail_price: 12,
          status: 'active',
          category_id: 'c1',
          primary_location_id: null,
          warehouse_id: 'w1',
          item_type: 'product',
          custom_fields: null,
          updated_at: '2026-05-14T00:00:00Z',
        },
      ],
      total: 1,
    });

    const res = await GET(
      makeReq(
        'q=shir&type=product&status=active&stock=low&sort=name_asc' +
          '&cat=c1&cat=c2&loc=l1&rack=20-A&limit=10&offset=20',
      ),
    );
    expect(res.status).toBe(200);
    expect(inventoryListMock).toHaveBeenCalledWith({
      q: 'shir',
      itemType: 'product',
      status: 'active',
      lowStock: true,
      outOfStock: false,
      sort: 'name_asc',
      categoryIds: ['c1', 'c2'],
      locationIds: ['l1'],
      rack: '20-A',
      limit: 10,
      offset: 20,
    });
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('i1');
    expect(body.total).toBe(1);
  });

  it('attaches signed image URLs', async () => {
    inventoryListMock.mockResolvedValueOnce({
      items: [
        {
          id: 'i1',
          sku: 'SP-1',
          barcode: null,
          name: 'X',
          quantity_on_hand: 0,
          reorder_point: 0,
          unit_cost: 0,
          retail_price: 0,
          status: 'active',
          category_id: null,
          primary_location_id: null,
          warehouse_id: null,
          item_type: 'product',
          custom_fields: null,
          updated_at: '2026-05-14T00:00:00Z',
        },
      ],
      total: 1,
    });
    primaryImagesMock.mockResolvedValueOnce(
      new Map([['i1', 'https://signed.example/i1.jpg']]),
    );

    const res = await GET(makeReq('q=shir'));
    const body = await res.json();
    expect(body.items[0].image_url).toBe('https://signed.example/i1.jpg');
  });

  it('falls back to custom_fields.thumbnail_url when no item_images row', async () => {
    inventoryListMock.mockResolvedValueOnce({
      items: [
        {
          id: 'i1',
          sku: 'SP-1',
          barcode: null,
          name: 'X',
          quantity_on_hand: 0,
          reorder_point: 0,
          unit_cost: 0,
          retail_price: 0,
          status: 'active',
          category_id: null,
          primary_location_id: null,
          warehouse_id: null,
          item_type: 'product',
          custom_fields: { thumbnail_url: 'https://cf.example/i1.jpg' },
          updated_at: '2026-05-14T00:00:00Z',
        },
      ],
      total: 1,
    });
    primaryImagesMock.mockResolvedValueOnce(new Map());

    const res = await GET(makeReq('q=shir'));
    const body = await res.json();
    expect(body.items[0].image_url).toBe('https://cf.example/i1.jpg');
  });

  it('caps limit at 200 and offset at 10000', async () => {
    inventoryListMock.mockResolvedValueOnce({ items: [], total: 0 });
    await GET(makeReq('q=shir&limit=9999&offset=99999'));
    expect(inventoryListMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 200, offset: 10000 }),
    );
  });

  it('defaults itemType when not supplied', async () => {
    inventoryListMock.mockResolvedValueOnce({ items: [], total: 0 });
    await GET(makeReq('q=shir'));
    // No type param → service call gets itemType: undefined → service
    // applies its own default ('product'). The endpoint should NOT
    // force a value; just forward what came in.
    expect(inventoryListMock).toHaveBeenCalledWith(
      expect.objectContaining({ itemType: undefined }),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @stockpilot/web exec vitest run src/app/api/items/search/route.test.ts`
Expected: FAIL — file `./route.ts` does not exist (Cannot find module).

### Task 2.2: Implement the route

**Files:**
- Create: `apps/web/src/app/api/items/search/route.ts`

- [ ] **Step 1: Write the route implementation**

```ts
// apps/web/src/app/api/items/search/route.ts
import { NextResponse } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { InventoryService, type ItemListSort } from '@/server/services/inventory';
import { ItemImagesService } from '@/server/services/item-images';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_TYPES = new Set([
  'product',
  'book',
  'asset',
  'consumable',
  'all',
]);
const VALID_STATUSES = new Set([
  'active',
  'archived',
  'discontinued',
  'all',
]);
const VALID_SORTS = new Set<ItemListSort>([
  'updated_desc',
  'updated_asc',
  'name_asc',
  'name_desc',
  'sku_asc',
  'sku_desc',
  'qty_desc',
  'qty_asc',
  'created_desc',
  'created_asc',
]);

/**
 * Dedicated search endpoint used by the InventoryTable's instant-search
 * client flow. A thin wrapper around InventoryService.list that also
 * batches primary-image signed URLs so the response is drop-in
 * compatible with what the table renders today.
 *
 * Separate from /api/search (the command-palette endpoint) because that
 * one searches across items + POs + suppliers + warehouses and caps at
 * 5 per group. This one is items-only and supports the full filter set
 * the inventory page exposes.
 */
export async function GET(req: Request): Promise<Response> {
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const params = url.searchParams;
  const raw = (params.get('q') ?? '').trim();
  if (raw.length < 2) {
    return NextResponse.json({ items: [], total: 0 });
  }

  const rawType = params.get('type');
  const itemType =
    rawType && VALID_TYPES.has(rawType)
      ? (rawType as 'product' | 'book' | 'asset' | 'consumable' | 'all')
      : undefined;

  const rawStatus = params.get('status');
  const status =
    rawStatus && VALID_STATUSES.has(rawStatus)
      ? (rawStatus as 'active' | 'archived' | 'discontinued' | 'all')
      : undefined;

  const stock = params.get('stock');
  const lowStock = stock === 'low';
  const outOfStock = stock === 'out';

  const rawSort = params.get('sort');
  const sort =
    rawSort && VALID_SORTS.has(rawSort as ItemListSort)
      ? (rawSort as ItemListSort)
      : undefined;

  const categoryIds = params.getAll('cat').filter(Boolean);
  const locationIds = params.getAll('loc').filter(Boolean);
  const rack = params.get('rack') ?? undefined;

  // Clamp ranges so a hostile caller can't request 1M-row pages or
  // skip to offset 10^9. InventoryService.list also clamps but we
  // catch obvious garbage at the boundary.
  const limit = Math.min(200, Math.max(1, Number(params.get('limit')) || 50));
  const offset = Math.min(10_000, Math.max(0, Number(params.get('offset')) || 0));

  const inventorySvc = new InventoryService(ctx);
  const result = await inventorySvc.list({
    q: raw,
    itemType,
    status,
    lowStock,
    outOfStock,
    sort,
    categoryIds,
    locationIds,
    rack,
    limit,
    offset,
  });

  // Attach signed image URLs in batch. Mirrors what page.tsx does for
  // the SSR render so the client-side swap is visually consistent.
  const imagesSvc = new ItemImagesService(ctx);
  const imagesById = await imagesSvc.primaryImagesForItems(
    result.items.map((i) => i.id as string),
  );

  const items = result.items.map((i) => {
    const cf = (i as { custom_fields?: Record<string, unknown> | null })
      .custom_fields;
    const cfThumb =
      cf && typeof cf === 'object' && typeof cf.thumbnail_url === 'string'
        ? (cf.thumbnail_url as string)
        : null;
    return {
      id: i.id as string,
      sku: i.sku as string,
      barcode: (i as { barcode?: string | null }).barcode ?? null,
      name: i.name as string,
      quantity_on_hand: Number(i.quantity_on_hand) || 0,
      reorder_point: Number(i.reorder_point) || 0,
      unit_cost: Number(i.unit_cost) || 0,
      retail_price: Number(i.retail_price) || 0,
      status: i.status as 'active' | 'archived' | 'discontinued',
      category_id: (i as { category_id?: string | null }).category_id ?? null,
      primary_location_id:
        (i as { primary_location_id?: string | null }).primary_location_id ??
        null,
      warehouse_id: (i as { warehouse_id?: string | null }).warehouse_id ?? null,
      item_type: i.item_type as 'product' | 'book' | 'asset' | 'consumable',
      custom_fields: cf ?? null,
      updated_at: i.updated_at as string,
      image_url:
        imagesById.get(i.id as string) ?? cfThumb ?? null,
    };
  });

  return NextResponse.json({ items, total: result.total });
}
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `pnpm --filter @stockpilot/web exec vitest run src/app/api/items/search/route.test.ts`
Expected: PASS — all 7 tests green.

- [ ] **Step 3: Run the full test suite to confirm no regressions**

Run: `pnpm --filter @stockpilot/web exec vitest run`
Expected: 43 files passing, 337 tests (330 previous + 7 new).

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @stockpilot/web exec tsc --noEmit`
Expected: clean exit (0).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/api/items/search/route.ts \
        apps/web/src/app/api/items/search/route.test.ts
git commit -m "feat(items): GET /api/items/search endpoint

Thin wrapper around InventoryService.list that also batches in
primary-image signed URLs so the response is drop-in compatible with
what InventoryTable already renders. Powers the upcoming
instant-search client flow.

Auth via withApiContext (matches /api/search). Returns 401 for
unauthenticated, empty result for q < 2 chars. Forwards type /
status / stock / sort / cat / loc / rack / limit / offset filters
verbatim. Limit clamped 1-200, offset clamped 0-10000.

Image URLs use the same fall-back chain page.tsx does:
item_images bucket → custom_fields.thumbnail_url → null.

Tests cover auth, short query, filter forwarding, image lookup,
custom_fields fallback, range clamping, and itemType default.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## PR 3 — InventoryTable instant-search refactor

### Task 3.1: Add local-filter state + memo

**Files:**
- Modify: `apps/web/src/components/inventory/inventory-table.tsx`

This is the typing-feedback layer. No network, no debounce — runs synchronously inside the component on every keystroke.

- [ ] **Step 1: Locate the existing `[q, setQ]` state in `InventoryTable`**

Run: `grep -n "const \[q, setQ\] = React.useState" apps/web/src/components/inventory/inventory-table.tsx`
Expected output: one match (around line 263).

- [ ] **Step 2: Add the new state declarations immediately after `setQ`**

In `apps/web/src/components/inventory/inventory-table.tsx`, find:

```ts
  const [q, setQ] = React.useState(initialQuery);
```

Insert the following two lines directly after it:

```ts
  // Server-authoritative search hits — populated after a debounced
  // fetch to /api/items/search. `null` means "no server result yet,
  // fall back to localMatches"; an empty array means "server says
  // zero matches". Cleared when q goes back to empty.
  const [serverHits, setServerHits] = React.useState<Item[] | null>(null);
  const [serverLoading, setServerLoading] = React.useState(false);
```

- [ ] **Step 3: Add the `localMatches` memo right after the new state**

Same file, immediately after the `serverLoading` declaration:

```ts
  // Instant local filter on every keystroke. Substring match against
  // name / sku / barcode of the rows already on this page. Renders
  // before the server fetch comes back so the user gets immediate
  // feedback; the server result then supersedes via `displayed` below.
  const localMatches = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((i) => {
      const name = (i.name ?? '').toLowerCase();
      const sku = (i.sku ?? '').toLowerCase();
      const barcode = (
        (i as { barcode?: string | null }).barcode ?? ''
      ).toLowerCase();
      return (
        name.includes(needle) || sku.includes(needle) || barcode.includes(needle)
      );
    });
  }, [items, q]);
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @stockpilot/web exec tsc --noEmit`
Expected: clean exit. (We've added unused state — fine; will use it in subsequent tasks.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/inventory/inventory-table.tsx
git commit -m "feat(inventory): add localMatches memo + serverHits state

Foundation for the instant-search flow. localMatches is a pure
function of (items, q) — no effects, no network — so typing
produces table updates within the same render. serverHits is
unused for now; the next commit wires the debounced fetch into it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 3.2: Add the debounced server fetch effect

**Files:**
- Modify: `apps/web/src/components/inventory/inventory-table.tsx`

- [ ] **Step 1: Locate the existing debounced URL-update effect**

Run: `grep -n "setTimeout(() => {" apps/web/src/components/inventory/inventory-table.tsx | head -3`
Expected: the existing 250ms debounce effect around line 332 that does `router.replace`.

- [ ] **Step 2: Replace the existing effect with the new debounced fetch**

In `apps/web/src/components/inventory/inventory-table.tsx`, find this block:

```ts
  React.useEffect(() => {
    const t = setTimeout(() => {
      const next = new URLSearchParams(params.toString());
      if (q.trim()) next.set('q', q.trim());
      else next.delete('q');
      // Search changes the result set — staying on page 5 isn't right
      // if the new query has fewer pages.
      next.delete('page');
      const qs = next.toString();
      router.replace(qs ? `${basePath}?${qs}` : basePath);
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
```

Replace the whole block with:

```ts
  // Instant-search flow. On every q change:
  //   1. localMatches has already updated synchronously (see useMemo
  //      above) — the table is already showing the user's typed-filter
  //      view.
  //   2. After 150ms of no further typing, fetch /api/items/search
  //      with q + the page's current URL filters so we catch matches
  //      on other pages.
  //   3. Update the URL via history.replaceState (NOT router.replace)
  //      so Next.js App Router doesn't re-execute the parent server
  //      component and re-fetch all 8 page queries — that's the bug
  //      this whole effort is escaping.
  //
  // AbortController cancels in-flight requests on rapid typing. On
  // any error we silently fall back to localMatches (which is still
  // mounted) — no toast, no UX disruption.
  React.useEffect(() => {
    const needle = q.trim();
    if (!needle) {
      setServerHits(null);
      setServerLoading(false);
      // Clear the q param from the URL when the user empties the box.
      const next = new URLSearchParams(params.toString());
      if (next.has('q') || next.has('page')) {
        next.delete('q');
        next.delete('page');
        const qs = next.toString();
        const newUrl = qs
          ? `${basePath}?${qs}`
          : basePath;
        window.history.replaceState(null, '', newUrl);
      }
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setServerLoading(true);
      try {
        const url = new URL('/api/items/search', window.location.origin);
        url.searchParams.set('q', needle);
        for (const k of ['type', 'status', 'stock', 'sort', 'rack']) {
          const v = params.get(k);
          if (v) url.searchParams.set(k, v);
        }
        for (const v of params.getAll('cat')) url.searchParams.append('cat', v);
        for (const v of params.getAll('loc')) url.searchParams.append('loc', v);
        url.searchParams.set('limit', String(pageSize));

        const res = await fetch(url.toString(), { signal: ctrl.signal });
        if (!res.ok) throw new Error(`search failed: ${res.status}`);
        const data = (await res.json()) as { items: Item[]; total: number };
        setServerHits(data.items);

        // URL update LAST. history.replaceState updates the address
        // bar without invoking Next.js's router, so the page-level
        // server component doesn't re-execute. router.replace would
        // — and that's exactly the page-reload-per-keystroke we're
        // escaping.
        const next = new URLSearchParams(params.toString());
        next.set('q', needle);
        next.delete('page');
        const newUrl = `${basePath}?${next.toString()}`;
        window.history.replaceState(null, '', newUrl);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          // Silent fall-back to localMatches. Don't toast — the user
          // already has results on screen; a toast would imply
          // something is broken when it isn't.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
```

Notes on the diff:
- The previous effect used `router.replace` — gone.
- The new effect references `pageSize` and `basePath`, which are already in scope as props (`pageSize = 50` default, `basePath = '/dashboard/inventory'` default).
- The `Item` type is the local interface declared near the top of the file (line ~28) — already in scope.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @stockpilot/web exec tsc --noEmit`
Expected: clean exit.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/inventory/inventory-table.tsx
git commit -m "feat(inventory): wire debounced fetch to /api/items/search

Replaces the 250ms router.replace effect with a 150ms fetch effect.
Two key differences from the old flow:

- Calls /api/items/search instead of triggering a server-component
  re-render. Only inventory rows refetch; categories / locations /
  suppliers / tags / savedViews / racks stay cached in the page
  shell.
- URL update via history.replaceState so Next.js App Router
  DOESN'T re-execute the parent server component. router.replace
  would, which is the root-cause page-reload-per-keystroke we're
  escaping.

AbortController on every keystroke. Silent fall-back to local
matches on network or 5xx errors (the user already has results
on screen — no toast). Empty query clears serverHits and the
?q= URL param.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 3.3: Render server hits + loading hint

**Files:**
- Modify: `apps/web/src/components/inventory/inventory-table.tsx`

- [ ] **Step 1: Locate the rendered items array**

Run: `grep -n "items.map\|items\." apps/web/src/components/inventory/inventory-table.tsx | head -10`

Find where the table body iterates `items` (typically `{items.map((item) => ...)}`). There may be more than one `.map`. The one we care about is the `<tbody>` row iteration — search for `<tbody>` and read 5-10 lines below.

- [ ] **Step 2: Compute the displayed list**

Insert this just before the JSX return — right after the existing `useMemo`s but before the `function toggleAll`:

```ts
  // What the table actually renders. Priority: server-authoritative
  // result if we have one (covers cross-page matches), else the
  // synchronous local filter (covers in-page matches with zero
  // latency). On no search, both reduce to `items`.
  const displayed = serverHits ?? localMatches;
```

- [ ] **Step 3: Swap the table body iteration to use `displayed`**

Find the `<tbody>` block. Locate the iteration line (typically `{items.map(`). Change `items.map` to `displayed.map`.

If the file has multiple `items.map` calls, ONLY change the one inside `<tbody>` for the main rows table. (Mobile-card variants and filter dropdowns reference their own data, not the row list.)

To narrow the change: search for the line near `<tbody>` that maps over `items` to render `<tr>` elements.

- [ ] **Step 4: Update the empty-state and header counts**

Find the "Showing X of Y" text or equivalent count display. Currently the count uses `total` directly. Update to show the right value depending on whether a search is active.

Search for "Showing" or the existing count rendering. Replace its computation with:

```tsx
{/* Header count — adapts to local vs server vs no-search */}
{(() => {
  const needle = q.trim();
  if (!needle) {
    // No search active — keep the existing total/pagination display
    return <>Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}</>;
  }
  const shown = displayed.length;
  const totalForSearch = serverHits ? shown : `${shown}${shown < items.length ? '' : '+'}`;
  return (
    <>
      Showing {shown} matching &ldquo;{needle}&rdquo;
      {serverLoading ? ' (searching…)' : null}
    </>
  );
})()}
```

If the existing JSX for the count is structured differently, adapt this snippet to match the surrounding component shape — the goal is just to swap `total` for `displayed.length` when a search is active, and append `(searching…)` while `serverLoading` is true.

- [ ] **Step 5: Hide pagination when a search is active**

The local + server search result doesn't paginate the same way the unfiltered list does. Find the pagination JSX (Next/Prev buttons or "Page X of Y" indicator) and wrap it with `{!q.trim() && (` … `)}` so it disappears during search.

Search hint: `grep -n "Prev\|Page \|setPage\|page=\\?" apps/web/src/components/inventory/inventory-table.tsx | head -5`

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @stockpilot/web exec tsc --noEmit`
Expected: clean exit.

- [ ] **Step 7: Run the full test suite**

Run: `pnpm --filter @stockpilot/web exec vitest run`
Expected: 43 files passing, 337 tests green.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/inventory/inventory-table.tsx
git commit -m "feat(inventory): render server hits + (searching…) hint

displayed = serverHits ?? localMatches. Header count switches to
'Showing N matching X' during search, appends '(searching…)' while
the debounced fetch is in flight. Pagination is hidden during
search (the server response delivers the full filtered set; pages
recompose once the user clears the box).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## PR 4 — Smoke verification + push

### Task 4.1: Build + manual smoke

**Files:**
- (no edits; verification only)

- [ ] **Step 1: Production build to catch any TS / lint surprise**

Run: `pnpm --filter @stockpilot/web exec next build`
Expected: build completes, no error rows in the routes manifest. The two new files (`api/items/search/route.ts` + `components/inventory/inventory-table.tsx`) should be in the output.

- [ ] **Step 2: Start dev server**

```bash
cd apps/web && pnpm dev > /tmp/dev.log 2>&1 &
sleep 10
tail -10 /tmp/dev.log
```

Expected: `Ready in <ms>` line, no compile errors.

- [ ] **Step 3: Curl the new endpoint as a sanity check**

```bash
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/api/items/search?q=shir"
```

Expected: `401` (no auth cookie). Confirms the route is registered and the auth gate fires.

- [ ] **Step 4: Stop the dev server**

```bash
kill $(pgrep -f 'next dev')
```

- [ ] **Step 5: Final push of all branches**

```bash
git push
```

The user reloads `/dashboard/inventory` in the browser, types in the search box, and confirms typing feels instant. If anything regresses, the fallback path (silent local-only filter) means the user still has a working table.

---

## Self-Review

**Spec coverage:**

| Spec section | Implementing task |
|---|---|
| pg_trgm + 5 indexes (Architecture §1) | Task 1.1 |
| `/api/items/search` shape + auth (Architecture §2) | Task 2.1 (test) + 2.2 (impl) |
| `localMatches` instant filter (Architecture §3, behaviour §2) | Task 3.1 |
| `serverHits` debounced fetch + AbortController (Architecture §3, behaviour §3-5) | Task 3.2 |
| `history.replaceState` URL update (User-visible §5) | Task 3.2 |
| Header "Showing N matching X (searching…)" (User-visible §2-4) | Task 3.3 |
| Pagination hidden during search | Task 3.3 |
| Silent fall-back on API failure (Error handling) | Task 3.2 |
| Migration safety / idempotency (Migration safety) | Task 1.1 |
| Trends fall back to flat-line (out of scope per spec) | n/a — no code change needed; existing fallback handles missing trends per row |

**Placeholder scan:** every code block is complete. No TBD / TODO / "similar to". The header-count and pagination edits in Task 3.3 reference existing JSX patterns that vary by file state — those steps include `grep` commands so the engineer can locate the right anchor.

**Type consistency:**
- `Item` interface is defined locally in `inventory-table.tsx` and reused throughout. Tasks 3.1-3.3 use this same name.
- `ItemListSort` imported from `@/server/services/inventory` in both the route and the route test. Matches.
- `serverHits: Item[] | null` in Task 3.1; consumed as same shape in Task 3.2 (`setServerHits(data.items)` where `data.items` is typed `Item[]`).
- The API route's response shape (Task 2.2) matches the `data: { items: Item[]; total: number }` shape consumed in Task 3.2.

**One ambiguity I'm leaving on purpose:** Task 3.3 step 4 (header count rewrite) intentionally describes shape rather than line-by-line because the existing count JSX varies depending on what other commits have touched the file recently. The engineer has the `grep` anchor + a concrete target snippet — applying it is mechanical.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-14-instant-inventory-search.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
