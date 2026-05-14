# Inventory Upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three Inventory/Books features in sequence: scan-to-search on Books, rack filter on both pages, size variants for category-flagged items.

**Architecture:** Three PRs from one spec. Each PR is self-contained and deployable. Server changes go through `InventoryService` + new `CategoriesService` fields. UI changes thread through `InventoryTable`, `CategoriesManager`, and `ItemForm`. Two SQL migrations (rack indexes + supports_sizes column) plus one form-time bulk-create transaction.

**Tech Stack:** Next.js 16 App Router · Supabase Postgres (via supabase-js) · React 19 + react-hook-form · zod · vitest + Testing Library · @zxing/browser (for the existing scanner).

**Source spec:** [docs/superpowers/specs/2026-05-13-inventory-upgrades-design.md](../specs/2026-05-13-inventory-upgrades-design.md)

---

## PR 1 — Scan-to-search on Books

### Task 1.1: Extend ItemListFilters with exact-match `barcode`

**Files:**
- Modify: `apps/web/src/server/services/inventory.ts:30-63` (filter interface)
- Modify: `apps/web/src/server/services/inventory.ts:134-139` (`q` filter block — add barcode after it)
- Create: `apps/web/src/server/services/inventory.barcode-filter.test.ts`

The current `q` filter does `ilike` across name/sku/barcode, which over-matches for ISBN scanning ("978" prefix would match every ISBN). Scan-to-search wants exact equality on `barcode`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/server/services/inventory.barcode-filter.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./context', () => ({
  withContext: vi.fn(),
  ServiceError: class extends Error {
    constructor(public code: string, message: string) { super(message); }
  },
  assertPermission: vi.fn(),
  assertPlanLimit: vi.fn(),
}));

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [] })),
}));

import { InventoryService } from './inventory';

function buildSupabaseStub(rows: Array<{ id: string; barcode: string }>) {
  const eqCalls: Array<[string, unknown]> = [];
  const chain: any = {
    select: () => chain,
    eq: (col: string, val: unknown) => { eqCalls.push([col, val]); return chain; },
    is: () => chain,
    order: () => chain,
    range: () => chain,
    in: () => chain,
    or: () => chain,
    then: (cb: (r: { data: unknown; count: number; error: null }) => unknown) =>
      cb({ data: rows, count: rows.length, error: null }),
  };
  return { from: () => chain, _eqCalls: eqCalls };
}

describe('InventoryService.list barcode filter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('adds a barcode .eq filter when filters.barcode is set', async () => {
    const stub = buildSupabaseStub([{ id: 'i1', barcode: '9780140449136' }]);
    const svc = new InventoryService({
      supabase: stub as any,
      organizationId: 'org-1',
      userId: 'u1',
      email: 'a@b.c',
      role: 'admin',
    } as any);

    await svc.list({ barcode: '9780140449136' });

    expect(stub._eqCalls).toContainEqual(['barcode', '9780140449136']);
  });

  it('does not add the barcode filter when omitted', async () => {
    const stub = buildSupabaseStub([]);
    const svc = new InventoryService({
      supabase: stub as any,
      organizationId: 'org-1',
      userId: 'u1',
      email: 'a@b.c',
      role: 'admin',
    } as any);

    await svc.list({});
    expect(stub._eqCalls.find((c) => c[0] === 'barcode')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stockpilot/web exec vitest run src/server/services/inventory.barcode-filter.test.ts`
Expected: FAIL — `filters.barcode` not recognized.

- [ ] **Step 3: Add the filter field to ItemListFilters**

In `apps/web/src/server/services/inventory.ts`, locate the `ItemListFilters` interface (around line 30-63). Add this field after `q?: string;`:

```ts
  /**
   * Exact-match filter on inventory_items.barcode. Used by the
   * scan-to-search flow on /dashboard/books — the scanner emits the
   * ISBN and we want a single deterministic match, not the prefix
   * ilike that `q` would do.
   */
  barcode?: string;
```

- [ ] **Step 4: Apply the filter in `list()`**

In `apps/web/src/server/services/inventory.ts`, after the existing `q` block (~line 139), add:

```ts
    if (filters.barcode && filters.barcode.trim()) {
      query = query.eq('barcode', filters.barcode.trim());
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @stockpilot/web exec vitest run src/server/services/inventory.barcode-filter.test.ts`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/services/inventory.ts apps/web/src/server/services/inventory.barcode-filter.test.ts
git commit -m "feat(inventory): add exact-match barcode filter to InventoryService.list"
```

---

### Task 1.2: Add `onScanRequest` + camera icon to InventoryTable search

**Files:**
- Modify: `apps/web/src/components/inventory/inventory-table.tsx` (props interface, search-input render)

The search input lives inside `InventoryTable`. Add an optional `onScanRequest` callback; when set, render a small camera button inside the search input on the right edge. The component does NOT own the scanner modal — it just emits a click.

- [ ] **Step 1: Add the prop to the interface**

In `apps/web/src/components/inventory/inventory-table.tsx`, locate `interface InventoryTableProps` (~line 51). Add after `canCreate?: boolean;`:

```ts
  /**
   * When provided, renders a small camera button inside the search
   * input on the right edge. Click invokes the callback so the
   * parent can open its own scanner modal + handle the result. The
   * table never imports IsbnScanner itself — keeps the dependency
   * direction one-way.
   */
  onScanRequest?: () => void;
```

- [ ] **Step 2: Destructure the prop**

In the function signature (`export function InventoryTable({...`), add `onScanRequest,` to the destructured params (next to `canCreate = true,`).

- [ ] **Step 3: Find the search input and add the camera button**

Grep for the existing search `<Input` inside InventoryTable (around the toolbar — search for `placeholder="Search` or `value={q}`):

```bash
grep -n 'value={q}' apps/web/src/components/inventory/inventory-table.tsx
```

Locate the wrapping `<div>` that holds the search input. Inside that wrapper, after the `<Input>`, add (the import for `ScanLine` from `lucide-react` needs to be at the top — `ScanLine` is already used by IsbnScanner so add it to the existing `lucide-react` import line at the top of this file):

```tsx
        {onScanRequest && (
          <button
            type="button"
            onClick={onScanRequest}
            className="text-muted-foreground hover:text-foreground absolute right-2 top-1/2 -translate-y-1/2 rounded p-1"
            aria-label="Scan barcode"
          >
            <ScanLine className="h-4 w-4" />
          </button>
        )}
```

The wrapping `<div>` may need `relative` added to its className so the absolute positioning anchors correctly.

- [ ] **Step 4: Build the app to verify the prop typechecks**

Run: `pnpm --filter @stockpilot/web exec tsc --noEmit`
Expected: clean exit, no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/inventory/inventory-table.tsx
git commit -m "feat(inventory): InventoryTable accepts optional onScanRequest with camera icon"
```

---

### Task 1.3: Books page wires scanner modal + post-detect routing

**Files:**
- Modify: `apps/web/src/app/(dashboard)/dashboard/books/page.tsx` (convert relevant section to client-bound, OR add a new client wrapper)
- Create: `apps/web/src/components/books/books-scan-shortcut.tsx`

The books page is a server component. We need a small client component that owns the scanner modal state and the search-result navigation. The page passes the existing list parameters; the client component captures the scan, hits a server action to look up the ISBN, and navigates.

- [ ] **Step 1: Create the lookup server action**

Create `apps/web/src/server/actions/books-lookup.ts`:

```ts
'use server';

import { z } from 'zod';

import { InventoryService } from '@/server/services/inventory';
import { ServiceError } from '@/server/services/context';

import { err, ok, type ActionResult } from '@stockpilot/core';

const schema = z.object({
  isbn: z.string().min(8).max(20).regex(/^[0-9Xx-]+$/, 'Invalid ISBN'),
});

export async function lookupBookByIsbnAction(
  input: z.input<typeof schema>,
): Promise<ActionResult<{ matches: Array<{ id: string; name: string }> }>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid ISBN');
  const isbn = parsed.data.isbn.replace(/[^0-9Xx]/g, '');
  try {
    const svc = await InventoryService.forCurrentUser();
    const result = await svc.list({
      barcode: isbn,
      itemType: 'book',
      status: 'active',
      limit: 5,
    });
    return ok({
      matches: result.items.map((i) => ({
        id: i.id as string,
        name: i.name as string,
      })),
    });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
```

- [ ] **Step 2: Create the BooksScanShortcut client component**

Create `apps/web/src/components/books/books-scan-shortcut.tsx`:

```tsx
'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { IsbnScanner } from '@/components/inventory/isbn-scanner';
import { lookupBookByIsbnAction } from '@/server/actions/books-lookup';

/**
 * Stateful client wrapper that owns the scanner modal + the post-
 * detect navigation logic. Rendered alongside the Books page; the
 * InventoryTable's onScanRequest fires `open()` via a ref.
 */
export interface BooksScanShortcutHandle {
  open: () => void;
}

export const BooksScanShortcut = React.forwardRef<BooksScanShortcutHandle, unknown>(
  function BooksScanShortcut(_, ref) {
    const router = useRouter();
    const [open, setOpen] = React.useState(false);
    const [busy, setBusy] = React.useState(false);

    React.useImperativeHandle(ref, () => ({ open: () => setOpen(true) }), []);

    async function handleDetected(isbn: string) {
      if (busy) return;
      setBusy(true);
      const res = await lookupBookByIsbnAction({ isbn });
      setBusy(false);
      setOpen(false);
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      const matches = res.data.matches;
      if (matches.length === 1) {
        router.push(`/dashboard/books/${matches[0].id}`);
        return;
      }
      if (matches.length === 0) {
        toast.error(`No book found for ISBN ${isbn}`, {
          action: {
            label: 'Create new book',
            onClick: () => router.push(`/dashboard/books/new?isbn=${isbn}`),
          },
        });
        return;
      }
      // >1 matches: drop ISBN into the books page search.
      router.push(`/dashboard/books?q=${encodeURIComponent(isbn)}`);
    }

    return (
      <IsbnScanner
        open={open}
        onOpenChange={setOpen}
        onDetected={handleDetected}
        mode="isbn"
      />
    );
  },
);
```

- [ ] **Step 3: Create a client wrapper that ties InventoryTable scan to BooksScanShortcut**

Create `apps/web/src/components/books/books-inventory-table.tsx`:

```tsx
'use client';

import * as React from 'react';

import {
  BooksScanShortcut,
  type BooksScanShortcutHandle,
} from '@/components/books/books-scan-shortcut';
import {
  InventoryTable,
  type InventoryTableProps,
} from '@/components/inventory/inventory-table';

/**
 * Books-page wrapper that bolts the scan-to-search shortcut onto the
 * shared InventoryTable. Keeps the table component generic — the
 * scanner + routing logic lives in BooksScanShortcut, this just
 * threads the open() callback through onScanRequest.
 */
export function BooksInventoryTable(props: Omit<InventoryTableProps, 'onScanRequest'>) {
  const scanRef = React.useRef<BooksScanShortcutHandle>(null);
  return (
    <>
      <InventoryTable {...props} onScanRequest={() => scanRef.current?.open()} />
      <BooksScanShortcut ref={scanRef} />
    </>
  );
}
```

You may need to export `InventoryTableProps` from `inventory-table.tsx` if it's not already exported. If the interface is currently un-exported, add `export` to the line that begins `interface InventoryTableProps {`.

- [ ] **Step 4: Swap InventoryTable for BooksInventoryTable in the books page**

In `apps/web/src/app/(dashboard)/dashboard/books/page.tsx`:

Find: `import { InventoryTable } from '@/components/inventory/inventory-table';`
Replace with:
```ts
import { BooksInventoryTable } from '@/components/books/books-inventory-table';
```

Find: `<InventoryTable` (around line 223)
Replace with: `<BooksInventoryTable` — and the closing tag too if needed.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @stockpilot/web exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit + push PR 1**

```bash
git add apps/web/src/server/actions/books-lookup.ts \
  apps/web/src/components/books/books-scan-shortcut.tsx \
  apps/web/src/components/books/books-inventory-table.tsx \
  apps/web/src/components/inventory/inventory-table.tsx \
  apps/web/src/app/\(dashboard\)/dashboard/books/page.tsx
git commit -m "$(cat <<'MSG'
feat(books): scan-to-search shortcut on the Books page

Camera icon inside the search input opens the existing IsbnScanner.
Detected ISBN -> server action -> InventoryService.list({ barcode, type: 'book' }).
- 1 match: router.push to detail
- 0 matches: toast with 'Create new book' action -> /dashboard/books/new?isbn=
- multiple matches: drop ISBN into the search box

No DB change. InventoryTable gains an optional onScanRequest prop;
BooksInventoryTable wraps the shared table + a BooksScanShortcut
client component that owns the modal + routing.
MSG
)"
git push
```

---

## PR 2 — Rack filter on Books + Items

### Task 2.1: Migration — indexes for rack filtering

**Files:**
- Create: `supabase/migrations/0060_rack_filter_indexes.sql`

- [ ] **Step 1: Create the migration**

```sql
-- 0060_rack_filter_indexes.sql
-- Indexes backing the new rack/bin filter on the Inventory and Books
-- list pages. Both filters are org-scoped and case-insensitive prefix
-- matches; without these indexes the filter does a full org scan.

create index if not exists inventory_items_org_bin_idx
  on public.inventory_items (organization_id, lower(bin_location))
  where bin_location is not null;

create index if not exists inventory_items_org_book_rack_idx
  on public.inventory_items (
    organization_id,
    (custom_fields->>'book_rack_number')
  )
  where custom_fields->>'book_rack_number' is not null;
```

- [ ] **Step 2: Verify SQL syntax locally**

Run: `cat supabase/migrations/0060_rack_filter_indexes.sql`
Expected: file prints. No commands to run — the user applies it manually in Supabase SQL editor after this PR ships.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0060_rack_filter_indexes.sql
git commit -m "feat(db): indexes for rack/bin filter on inventory + books"
```

---

### Task 2.2: Extend ItemListFilters with `rack`

**Files:**
- Modify: `apps/web/src/server/services/inventory.ts` (filter interface, `list` query)
- Create: `apps/web/src/server/services/inventory.rack-filter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/server/services/inventory.rack-filter.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./context', () => ({
  withContext: vi.fn(),
  ServiceError: class extends Error {
    constructor(public code: string, message: string) { super(message); }
  },
  assertPermission: vi.fn(),
  assertPlanLimit: vi.fn(),
}));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [] })),
}));

import { InventoryService } from './inventory';

function makeStub() {
  const eqCalls: Array<[string, unknown]> = [];
  const filterCalls: Array<[string, string, unknown]> = [];
  const chain: any = {
    select: () => chain,
    eq: (c: string, v: unknown) => { eqCalls.push([c, v]); return chain; },
    filter: (c: string, op: string, v: unknown) => { filterCalls.push([c, op, v]); return chain; },
    is: () => chain,
    order: () => chain,
    range: () => chain,
    in: () => chain,
    or: () => chain,
    then: (cb: any) => cb({ data: [], count: 0, error: null }),
  };
  return { from: () => chain, _eqCalls: eqCalls, _filterCalls: filterCalls };
}

describe('InventoryService.list rack filter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('matches bin_location case-insensitively for non-book items', async () => {
    const stub = makeStub();
    const svc = new InventoryService({
      supabase: stub as any,
      organizationId: 'org-1',
      userId: 'u1', email: 'a@b.c', role: 'admin',
    } as any);
    await svc.list({ rack: '20-A', itemType: 'product' });
    expect(stub._filterCalls).toContainEqual(['bin_location', 'ilike', '20-A']);
  });

  it('matches book_rack_number on custom_fields for books', async () => {
    const stub = makeStub();
    const svc = new InventoryService({
      supabase: stub as any,
      organizationId: 'org-1',
      userId: 'u1', email: 'a@b.c', role: 'admin',
    } as any);
    await svc.list({ rack: '38', itemType: 'book' });
    expect(stub._filterCalls.find(c => c[0] === 'custom_fields->>book_rack_number')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @stockpilot/web exec vitest run src/server/services/inventory.rack-filter.test.ts`
Expected: FAIL — rack filter not implemented.

- [ ] **Step 3: Add the `rack` field to ItemListFilters**

In `apps/web/src/server/services/inventory.ts`, after the existing `barcode?` field:

```ts
  /**
   * Rack / bin filter. Dispatched per item-type:
   *   - itemType === 'book'  → matches custom_fields->>'book_rack_number'
   *                            (case-insensitive prefix), or the full
   *                            "{number}-{row}" label.
   *   - otherwise             → matches inventory_items.bin_location
   *                            (case-insensitive equality).
   * "Any rack" is signaled by omitting the filter entirely.
   */
  rack?: string;
```

- [ ] **Step 4: Apply the filter in `list()`**

After the `barcode` filter block, add:

```ts
    if (filters.rack && filters.rack.trim()) {
      const rack = filters.rack.trim();
      if (filters.itemType === 'book') {
        // Books store rack as custom_fields.book_rack_number + book_rack_row.
        // For a value like "38-A" we split and match both halves; for a bare
        // "38" we match just the number.
        const [num, row] = rack.split('-');
        if (num) {
          query = query.filter(
            'custom_fields->>book_rack_number',
            'eq',
            num,
          );
        }
        if (row) {
          query = query.filter(
            'custom_fields->>book_rack_row',
            'eq',
            row,
          );
        }
      } else {
        query = query.filter('bin_location', 'ilike', rack);
      }
    }
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @stockpilot/web exec vitest run src/server/services/inventory.rack-filter.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/services/inventory.ts apps/web/src/server/services/inventory.rack-filter.test.ts
git commit -m "feat(inventory): rack filter on InventoryService.list"
```

---

### Task 2.3: `listDistinctRacks` service method

**Files:**
- Modify: `apps/web/src/server/services/inventory.ts` (new method on the class)
- Create: `apps/web/src/server/services/inventory.distinct-racks.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/server/services/inventory.distinct-racks.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('./context', () => ({
  withContext: vi.fn(),
  ServiceError: class extends Error {
    constructor(public code: string, message: string) { super(message); }
  },
  assertPermission: vi.fn(),
  assertPlanLimit: vi.fn(),
}));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [] })),
}));

import { InventoryService } from './inventory';

describe('InventoryService.listDistinctRacks', () => {
  it('returns dedup + sorted bin_locations for items scope', async () => {
    const rows = [
      { bin_location: '20-A' },
      { bin_location: '5-B' },
      { bin_location: '20-A' },
      { bin_location: null },
    ];
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      not: () => chain,
      then: (cb: any) => cb({ data: rows, error: null }),
    };
    const svc = new InventoryService({
      supabase: { from: () => chain } as any,
      organizationId: 'org-1',
      userId: 'u1', email: 'a@b.c', role: 'admin',
    } as any);
    const out = await svc.listDistinctRacks({ scope: 'items' });
    expect(out).toEqual(['20-A', '5-B'].sort());
  });

  it('returns combined "{number}-{row}" labels for books scope', async () => {
    const rows = [
      { custom_fields: { book_rack_number: '38', book_rack_row: 'A' } },
      { custom_fields: { book_rack_number: '38', book_rack_row: 'A' } },
      { custom_fields: { book_rack_number: '12' } },
      { custom_fields: {} },
    ];
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      not: () => chain,
      then: (cb: any) => cb({ data: rows, error: null }),
    };
    const svc = new InventoryService({
      supabase: { from: () => chain } as any,
      organizationId: 'org-1',
      userId: 'u1', email: 'a@b.c', role: 'admin',
    } as any);
    const out = await svc.listDistinctRacks({ scope: 'books' });
    expect(out).toEqual(['12', '38-A']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @stockpilot/web exec vitest run src/server/services/inventory.distinct-racks.test.ts`
Expected: FAIL — method not defined.

- [ ] **Step 3: Implement the method on InventoryService**

Add this method to the `InventoryService` class (anywhere after `list`):

```ts
  /**
   * Distinct rack / bin-location values for the rack-filter dropdown.
   * Scope picks which column to read:
   *   - 'items' → distinct lower(bin_location) where non-null, non-book items.
   *   - 'books' → distinct {book_rack_number}{-book_rack_row?} composed
   *     from custom_fields on book items.
   * Returns sorted, de-duplicated strings; empty array when nothing
   * has a rack set yet.
   */
  async listDistinctRacks(opts: { scope: 'items' | 'books' }): Promise<string[]> {
    if (opts.scope === 'items') {
      const { data, error } = await this.ctx.supabase
        .from('inventory_items')
        .select('bin_location')
        .eq('organization_id', this.ctx.organizationId)
        .is('deleted_at', null)
        .not('bin_location', 'is', null)
        .not('item_type', 'eq', 'book');
      if (error) throw new ServiceError('internal_error', error.message);
      const set = new Set<string>();
      for (const r of (data ?? []) as Array<{ bin_location: string | null }>) {
        const v = (r.bin_location ?? '').trim();
        if (v) set.add(v);
      }
      return Array.from(set).sort();
    }

    const { data, error } = await this.ctx.supabase
      .from('inventory_items')
      .select('custom_fields')
      .eq('organization_id', this.ctx.organizationId)
      .is('deleted_at', null)
      .eq('item_type', 'book');
    if (error) throw new ServiceError('internal_error', error.message);
    const set = new Set<string>();
    for (const r of (data ?? []) as Array<{ custom_fields: Record<string, unknown> | null }>) {
      const cf = r.custom_fields ?? {};
      const num = typeof cf.book_rack_number === 'string' ? cf.book_rack_number.trim() : '';
      const row = typeof cf.book_rack_row === 'string' ? cf.book_rack_row.trim() : '';
      if (!num) continue;
      set.add(row ? `${num}-${row}` : num);
    }
    return Array.from(set).sort();
  }
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @stockpilot/web exec vitest run src/server/services/inventory.distinct-racks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/services/inventory.ts apps/web/src/server/services/inventory.distinct-racks.test.ts
git commit -m "feat(inventory): listDistinctRacks for the rack-filter dropdown"
```

---

### Task 2.4: RackFilterDropdown component

**Files:**
- Create: `apps/web/src/components/inventory/rack-filter-dropdown.tsx`

- [ ] **Step 1: Create the component**

```tsx
'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import * as React from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Per-page rack filter. The page passes the distinct rack list it
 * computed server-side via InventoryService.listDistinctRacks. The
 * dropdown reads / writes the `?rack=` URL param and preserves all
 * other params (search, status, category, ...).
 */
export function RackFilterDropdown({ racks }: { racks: string[] }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const current = params.get('rack') ?? '';

  function buildHref(rack: string | null): string {
    const sp = new URLSearchParams(params.toString());
    if (rack) sp.set('rack', rack);
    else sp.delete('rack');
    sp.delete('page'); // reset paging when changing filter
    const q = sp.toString();
    return q ? `${pathname}?${q}` : (pathname ?? '/');
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          Rack: {current || 'Any'}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
        <DropdownMenuItem asChild>
          <Link href={buildHref(null)} className={cn(!current && 'font-semibold')}>
            Any rack
          </Link>
        </DropdownMenuItem>
        {racks.length === 0 ? (
          <DropdownMenuItem disabled>No racks set yet</DropdownMenuItem>
        ) : (
          racks.map((r) => (
            <DropdownMenuItem key={r} asChild>
              <Link
                href={buildHref(r)}
                className={cn(current === r && 'font-semibold')}
              >
                {r}
              </Link>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @stockpilot/web exec tsc --noEmit`
Expected: clean (verify `DropdownMenu` import path matches; if the project uses a different shadcn dropdown location, adjust).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/inventory/rack-filter-dropdown.tsx
git commit -m "feat(inventory): RackFilterDropdown component"
```

---

### Task 2.5: Wire rack filter on Books page

**Files:**
- Modify: `apps/web/src/app/(dashboard)/dashboard/books/page.tsx`

- [ ] **Step 1: Add imports + fetch racks**

In `apps/web/src/app/(dashboard)/dashboard/books/page.tsx`, add the import at the top:

```ts
import { RackFilterDropdown } from '@/components/inventory/rack-filter-dropdown';
```

Locate where `inventory` is fetched (the `inventorySvc.list(...)` call around line 96+). Right after that block (around line 100), add a parallel fetch for racks:

```ts
const racks = await inventorySvc.listDistinctRacks({ scope: 'books' });
```

- [ ] **Step 2: Read `?rack=` from params**

In the same file, find where the search params are parsed (look for `params.q`). Add:

```ts
const rack = typeof params.rack === 'string' ? params.rack : undefined;
```

Then thread it into the list call:

```ts
// in the inventorySvc.list({...}) call near line 96:
rack,
```

- [ ] **Step 3: Render the dropdown in the header**

Find the page header's flex row (the one with the Active/Archived toggle from the previous PR — `ArchiveViewToggle paramName="status"`). Insert the rack dropdown next to it:

```tsx
        <div className="flex flex-wrap items-center gap-2">
          <ArchiveViewToggle
            paramName="status"
            view={lifecycleStatus === 'archived' ? 'archived' : 'active'}
          />
          <RackFilterDropdown racks={racks} />
          {/* ...existing create buttons... */}
```

- [ ] **Step 4: Update searchParams type if needed**

In the `BooksPage({ searchParams }: ...)` signature, ensure `rack?: string` is included in the searchParams type. If the type is `Promise<{ ... }>`, add `rack?: string;` to the inner object.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @stockpilot/web exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/\(dashboard\)/dashboard/books/page.tsx
git commit -m "feat(books): RackFilterDropdown in page header"
```

---

### Task 2.6: Wire rack filter on Inventory page

**Files:**
- Modify: `apps/web/src/app/(dashboard)/dashboard/inventory/page.tsx`

- [ ] **Step 1: Same edits as Task 2.5 but on the inventory page**

Add `RackFilterDropdown` import.
Fetch racks: `const racks = await inventorySvc.listDistinctRacks({ scope: 'items' });`
Read `?rack=` from params, thread into list call.
Render `<RackFilterDropdown racks={racks} />` next to the Archived toggle in the header.
Update searchParams type to include `rack?: string`.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @stockpilot/web exec tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit + push PR 2**

```bash
git add apps/web/src/app/\(dashboard\)/dashboard/inventory/page.tsx
git commit -m "feat(inventory): RackFilterDropdown in page header"
git push
```

---

## PR 3 — Size variants for variant-bearing categories

### Task 3.1: Migration — categories.supports_sizes column

**Files:**
- Create: `supabase/migrations/0061_categories_supports_sizes.sql`

- [ ] **Step 1: Create the migration**

```sql
-- 0061_categories_supports_sizes.sql
-- New column on categories. When true, items whose category has this
-- flag get a Sizes selector on the item form, and saving creates one
-- inventory row per selected size (variant model). Default false so
-- existing categories are unchanged.
--
-- Per memory rule: this is a column add, not a new table, so no new
-- GRANT statement is required — categories already has the table-level
-- grants from its original migration.

alter table public.categories
  add column if not exists supports_sizes boolean not null default false;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/0061_categories_supports_sizes.sql
git commit -m "feat(db): categories.supports_sizes flag for variant trigger"
```

---

### Task 3.2: Categories schemas + service support `supportsSizes`

**Files:**
- Modify: `apps/web/src/server/services/categories.ts` (zod schemas, list select, create/update bodies)

- [ ] **Step 1: Extend the zod schemas**

In `apps/web/src/server/services/categories.ts`, locate `createCategorySchema` and add `supportsSizes`:

```ts
export const createCategorySchema = z.object({
  name: z.string().min(1).max(120).trim(),
  description: z.string().max(2000).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex color like #6366f1')
    .optional(),
  parentId: z.string().uuid().nullable().optional(),
  supportsSizes: z.boolean().optional(),
});
```

- [ ] **Step 2: Extend `list()` to select the new column**

Update the select string from:
```
'id, parent_id, name, description, color, icon, deleted_at, created_at, updated_at'
```
to:
```
'id, parent_id, name, description, color, icon, supports_sizes, deleted_at, created_at, updated_at'
```

- [ ] **Step 3: Extend `create()` and `update()` to write the column**

In `create()`, in the `.insert({...})` call, add:
```ts
        supports_sizes: input.supportsSizes ?? false,
```

In `update()`, in the conditional updates block, add:
```ts
    if (patch.supportsSizes !== undefined) updates.supports_sizes = patch.supportsSizes;
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @stockpilot/web exec tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/services/categories.ts
git commit -m "feat(categories): supportsSizes flag in schemas + service"
```

---

### Task 3.3: CategoriesManager checkbox in create/edit dialog

**Files:**
- Modify: `apps/web/src/components/categories/categories-manager.tsx` (CategoryRow type, dialog form)

- [ ] **Step 1: Add `supportsSizes` to CategoryRow + form values**

Find `interface CategoryRow` in the file. Add:
```ts
  supports_sizes: boolean;
```

Find the form `FormValues` interface or zod schema. Add:
```ts
  supportsSizes: boolean;
```

- [ ] **Step 2: Default the field in the form's useForm reset / defaultValues**

In the form's `defaultValues` (or the `reset` call when opening edit), include:
```ts
  supportsSizes: editing?.supports_sizes ?? false,
```

- [ ] **Step 3: Render the checkbox**

In the dialog body, after the existing color picker / description fields, add:

```tsx
        <div className="flex items-start gap-3 rounded-md border border-border p-3">
          <input
            id="cat-supports-sizes"
            type="checkbox"
            className="mt-0.5 h-4 w-4"
            {...register('supportsSizes')}
          />
          <div className="space-y-0.5">
            <label htmlFor="cat-supports-sizes" className="text-sm font-medium">
              Has size variants (S, M, L, XL…)
            </label>
            <p className="text-muted-foreground text-xs">
              When on, items in this category get a Sizes selector in the
              item form, and saving creates one variant per chosen size.
            </p>
          </div>
        </div>
```

- [ ] **Step 4: Pass `supportsSizes` through to the action call**

Find where the form submit calls `createCategoryAction` or `updateCategoryAction`. Add `supportsSizes: values.supportsSizes` to the input.

- [ ] **Step 5: Update the page's row mapping**

In `apps/web/src/app/(dashboard)/dashboard/categories/page.tsx`, find the `rows.map((r) => ({...}))` block. Add:
```ts
          supports_sizes: Boolean(r.supports_sizes),
```

- [ ] **Step 6: Update action schemas if needed**

In `apps/web/src/server/actions/categories.ts` (or wherever the actions live), add `supportsSizes: z.boolean().optional()` to the zod input schema for both create and update.

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @stockpilot/web exec tsc --noEmit`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/categories/categories-manager.tsx \
  apps/web/src/app/\(dashboard\)/dashboard/categories/page.tsx \
  apps/web/src/server/actions/categories.ts
git commit -m "feat(categories): 'Has size variants' checkbox in manager dialog"
```

---

### Task 3.4: Bulk-create service method

**Files:**
- Modify: `apps/web/src/server/services/inventory.ts` (new method)
- Create: `apps/web/src/server/services/inventory.bulk-create-sized.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/server/services/inventory.bulk-create-sized.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./context', () => ({
  withContext: vi.fn(),
  ServiceError: class extends Error {
    constructor(public code: string, message: string) { super(message); }
  },
  assertPermission: vi.fn(),
  assertPlanLimit: vi.fn(),
}));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [] })),
}));

import { InventoryService } from './inventory';

describe('InventoryService.bulkCreateSizedVariants', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts one row per size with name + sku + custom_fields.size suffixed', async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const chain: any = {
      insert: (rows: Array<Record<string, unknown>>) => {
        inserted.push(...rows);
        return { select: () => ({ then: (cb: any) => cb({ data: rows.map((r, i) => ({ ...r, id: `i-${i}` })), error: null }) }) };
      },
    };
    const svc = new InventoryService({
      supabase: { from: () => chain } as any,
      organizationId: 'org-1',
      userId: 'u1', email: 'a@b.c', role: 'admin',
    } as any);

    const res = await svc.bulkCreateSizedVariants({
      baseName: 'L4L Black T-Shirt',
      baseSku: 'SP-OKX68-UAA',
      baseBarcode: null,
      description: null,
      categoryId: 'cat-1',
      supplierId: null,
      warehouseId: 'wh-1',
      primaryLocationId: null,
      binLocation: '20-A',
      retailPrice: 12,
      unitCost: 4,
      reorderPoint: 0,
      reorderQuantity: 0,
      variants: [
        { size: 'S', quantity: 3 },
        { size: 'M', quantity: 5 },
      ],
    });

    expect(inserted).toHaveLength(2);
    expect(inserted[0].name).toBe('L4L Black T-Shirt - S');
    expect(inserted[0].sku).toBe('SP-OKX68-UAA-S');
    expect(inserted[0].quantity_on_hand).toBe(3);
    expect((inserted[0].custom_fields as Record<string, unknown>).size).toBe('S');
    expect(inserted[1].name).toBe('L4L Black T-Shirt - M');
    expect(inserted[1].sku).toBe('SP-OKX68-UAA-M');
    expect(res).toHaveLength(2);
  });

  it('throws when variants is empty', async () => {
    const svc = new InventoryService({
      supabase: {} as any,
      organizationId: 'org-1',
      userId: 'u1', email: 'a@b.c', role: 'admin',
    } as any);
    await expect(
      svc.bulkCreateSizedVariants({
        baseName: 'Test',
        baseSku: 'A',
        baseBarcode: null,
        description: null,
        categoryId: 'c',
        supplierId: null,
        warehouseId: 'w',
        primaryLocationId: null,
        binLocation: null,
        retailPrice: 0,
        unitCost: 0,
        reorderPoint: 0,
        reorderQuantity: 0,
        variants: [],
      }),
    ).rejects.toThrow(/at least one size/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @stockpilot/web exec vitest run src/server/services/inventory.bulk-create-sized.test.ts`
Expected: FAIL — method doesn't exist.

- [ ] **Step 3: Implement the service method**

Add to `InventoryService` (anywhere in the class):

```ts
  /**
   * Bulk-creates one inventory_items row per selected size in a single
   * transaction. Used by the Items form when the selected category has
   * supports_sizes = true. Name + SKU + custom_fields.size are
   * computed per variant; all other fields are copied verbatim.
   *
   * Plan-limit check runs ONCE against the total variant count so a
   * 7-size submit doesn't burn through the limit row-by-row.
   */
  async bulkCreateSizedVariants(input: {
    baseName: string;
    baseSku: string | null;
    baseBarcode: string | null;
    description: string | null;
    categoryId: string;
    supplierId: string | null;
    warehouseId: string;
    primaryLocationId: string | null;
    binLocation: string | null;
    retailPrice: number;
    unitCost: number;
    reorderPoint: number;
    reorderQuantity: number;
    variants: Array<{
      size: 'S' | 'M' | 'L' | 'XL' | 'XXL' | 'XXXL' | 'XXXXL';
      quantity: number;
    }>;
  }): Promise<Array<{ id: string; name: string; sku: string }>> {
    assertPermission(this.ctx, 'items:create');
    if (input.variants.length === 0) {
      throw new ServiceError(
        'validation_error',
        'Pick at least one size or change the category.',
      );
    }
    await assertPlanLimit(this.ctx, 'items', input.variants.length);

    const rows = input.variants.map((v) => ({
      organization_id: this.ctx.organizationId,
      name: `${input.baseName} - ${v.size}`,
      sku: input.baseSku ? `${input.baseSku}-${v.size}` : null,
      barcode: input.baseBarcode,
      description: input.description,
      category_id: input.categoryId,
      supplier_id: input.supplierId,
      warehouse_id: input.warehouseId,
      primary_location_id: input.primaryLocationId,
      bin_location: input.binLocation,
      retail_price: input.retailPrice,
      unit_cost: input.unitCost,
      reorder_point: input.reorderPoint,
      reorder_quantity: input.reorderQuantity,
      quantity_on_hand: v.quantity,
      item_type: 'product',
      status: 'active',
      tracking_type: 'standard',
      custom_fields: { size: v.size },
      created_by: this.ctx.userId,
      updated_by: this.ctx.userId,
    }));

    const { data, error } = await this.ctx.supabase
      .from('inventory_items')
      .insert(rows)
      .select('id, name, sku');
    if (error) {
      // 23505 = unique_violation — typically SKU collision.
      if ((error as { code?: string }).code === '23505') {
        throw new ServiceError(
          'conflict',
          'One or more variant SKUs already exist. Pick a different base SKU.',
        );
      }
      throw new ServiceError('internal_error', error.message);
    }
    return (data ?? []) as Array<{ id: string; name: string; sku: string }>;
  }
```

You may need to extend `assertPlanLimit` to accept a count argument; if its current signature is `assertPlanLimit(ctx, 'items')` and only checks one slot, either:
- Call it in a loop `for (let i = 0; i < input.variants.length; i++) await assertPlanLimit(...)`, OR
- Modify `assertPlanLimit` in `context.ts` to accept an optional `addCount: number` (default 1).

Pick whichever is less invasive. If unsure, use the loop — it's correct, just chatty.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @stockpilot/web exec vitest run src/server/services/inventory.bulk-create-sized.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/services/inventory.ts apps/web/src/server/services/inventory.bulk-create-sized.test.ts
git commit -m "feat(inventory): bulkCreateSizedVariants service method"
```

---

### Task 3.5: Server action wrapping the bulk-create

**Files:**
- Modify: `apps/web/src/server/actions/inventory.ts` (or wherever item-create actions live)

- [ ] **Step 1: Add the action**

Find the existing `createItemAction` in the inventory actions file. Add this below it:

```ts
const bulkCreateSizedSchema = z.object({
  baseName: z.string().min(1).max(200),
  baseSku: z.string().max(120).nullable(),
  baseBarcode: z.string().max(120).nullable(),
  description: z.string().max(2000).nullable(),
  categoryId: z.string().uuid(),
  supplierId: z.string().uuid().nullable(),
  warehouseId: z.string().uuid(),
  primaryLocationId: z.string().uuid().nullable(),
  binLocation: z.string().max(120).nullable(),
  retailPrice: z.coerce.number().min(0),
  unitCost: z.coerce.number().min(0),
  reorderPoint: z.coerce.number().int().min(0),
  reorderQuantity: z.coerce.number().int().min(0),
  variants: z
    .array(
      z.object({
        size: z.enum(['S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL']),
        quantity: z.coerce.number().int().min(0),
      }),
    )
    .min(1)
    .max(7),
});

export async function bulkCreateSizedVariantsAction(
  input: z.input<typeof bulkCreateSizedSchema>,
): Promise<ActionResult<{ created: number; ids: string[] }>> {
  const parsed = bulkCreateSizedSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await InventoryService.forCurrentUser();
    const rows = await svc.bulkCreateSizedVariants(parsed.data);
    revalidatePath('/dashboard/inventory');
    revalidatePath('/dashboard/books');
    return ok({ created: rows.length, ids: rows.map((r) => r.id) });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
```

Imports needed at the top of the file (if not already present):
```ts
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { InventoryService } from '@/server/services/inventory';
import { ServiceError } from '@/server/services/context';
import { err, ok, type ActionResult } from '@stockpilot/core';
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @stockpilot/web exec tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/server/actions/inventory.ts
git commit -m "feat(inventory): bulkCreateSizedVariantsAction server action"
```

---

### Task 3.6: ItemForm renders the Sizes chip group when category supports sizes

**Files:**
- Modify: `apps/web/src/components/inventory/item-form.tsx` (categories prop, render the Sizes section, dispatch bulk vs single on submit)

- [ ] **Step 1: Extend the ItemForm categories prop to include `supports_sizes`**

Find the categories prop type (often `categories: Array<{ id: string; name: string }>`). Extend it to:

```ts
categories: Array<{ id: string; name: string; supports_sizes?: boolean }>;
```

- [ ] **Step 2: Update callers to pass `supports_sizes`**

In `apps/web/src/app/(dashboard)/dashboard/inventory/new/page.tsx` (and any other page that passes `categories` to ItemForm), update the mapping:

```ts
categories: categories.map((c) => ({
  id: c.id as string,
  name: c.name as string,
  supports_sizes: Boolean(c.supports_sizes),
})),
```

- [ ] **Step 3: Compute `supportsSizes` from the selected category in the form**

In `item-form.tsx`, inside the component body where the form state is set up:

```ts
const selectedCategory = categories.find(
  (c) => c.id === watch('categoryId'),
);
const categorySupportsSizes = Boolean(selectedCategory?.supports_sizes);
```

- [ ] **Step 4: Add size state**

```ts
const [selectedSizes, setSelectedSizes] = React.useState<Array<{ size: SizeCode; quantity: number }>>([]);

type SizeCode = 'S' | 'M' | 'L' | 'XL' | 'XXL' | 'XXXL' | 'XXXXL';
const ALL_SIZES: SizeCode[] = ['S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL'];
```

- [ ] **Step 5: Render the Sizes section in the Classification block**

Find the existing supplier `<SelectField label="Supplier" ... />` block (around line 604). Replace the `<div />` placeholder next to it with the Sizes section, conditional on `categorySupportsSizes` and the form being in CREATE mode (not edit — edit is one-row scope per spec):

```tsx
        <div className="grid grid-cols-2 gap-3">
          <SelectField
            label="Supplier"
            value={watch('supplierId') ?? ''}
            onChange={(v) => setValue('supplierId', v || null)}
            options={suppliers}
            placeholder="None"
            optional
          />
          {categorySupportsSizes && isCreating ? (
            <Field label="Sizes" optional>
              <div className="flex flex-wrap gap-1.5">
                {ALL_SIZES.map((s) => {
                  const picked = selectedSizes.some((x) => x.size === s);
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() =>
                        setSelectedSizes((prev) =>
                          picked
                            ? prev.filter((x) => x.size !== s)
                            : [...prev, { size: s, quantity: 0 }],
                        )
                      }
                      className={cn(
                        'rounded border border-border px-2 py-1 text-xs',
                        picked && 'bg-foreground text-background',
                      )}
                    >
                      {s}
                    </button>
                  );
                })}
              </div>
              {selectedSizes.length > 0 && (
                <div className="mt-3 space-y-1.5">
                  {selectedSizes.map((entry, i) => (
                    <div key={entry.size} className="flex items-center gap-2">
                      <span className="w-10 text-xs font-medium">{entry.size}</span>
                      <Input
                        type="number"
                        min={0}
                        value={entry.quantity}
                        onChange={(e) =>
                          setSelectedSizes((prev) => {
                            const next = [...prev];
                            next[i] = { ...entry, quantity: Number(e.target.value) || 0 };
                            return next;
                          })
                        }
                        className="h-8 w-24"
                      />
                    </div>
                  ))}
                </div>
              )}
            </Field>
          ) : (
            <div />
          )}
        </div>
```

`isCreating` is whatever local boolean indicates "this is a new-item form, not an edit form". If the component doesn't have one yet, derive it: `const isCreating = !initialValues?.id;` or similar based on the existing pattern.

- [ ] **Step 6: Hide the single Qty input when sizes are selected**

Find the existing `quantityOnHand` input in the form. Wrap its containing block:

```tsx
{!(categorySupportsSizes && isCreating && selectedSizes.length > 0) && (
  <Field label="On hand">
    {/* existing quantity input */}
  </Field>
)}
```

- [ ] **Step 7: Dispatch bulk-create on submit when sizes are selected**

Find the form's `onSubmit` handler. Wrap the existing single-item create call:

```ts
async function onSubmit(values: FormValues) {
  if (categorySupportsSizes && isCreating && selectedSizes.length > 0) {
    const res = await bulkCreateSizedVariantsAction({
      baseName: values.name,
      baseSku: values.sku || null,
      baseBarcode: values.barcode || null,
      description: values.description || null,
      categoryId: values.categoryId!, // categorySupportsSizes implies a selected category
      supplierId: values.supplierId,
      warehouseId: values.warehouseId,
      primaryLocationId: values.primaryLocationId,
      binLocation: values.binLocation || null,
      retailPrice: values.retailPrice,
      unitCost: values.unitCost,
      reorderPoint: values.reorderPoint,
      reorderQuantity: values.reorderQuantity,
      variants: selectedSizes,
    });
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(`Created ${res.data.created} variant${res.data.created === 1 ? '' : 's'}.`);
    router.push('/dashboard/inventory');
    return;
  }
  // ...existing single-item create flow stays unchanged below
}
```

Imports needed:
```ts
import { bulkCreateSizedVariantsAction } from '@/server/actions/inventory';
```

- [ ] **Step 8: Typecheck**

Run: `pnpm --filter @stockpilot/web exec tsc --noEmit`
Expected: clean.

- [ ] **Step 9: Commit + push PR 3**

```bash
git add apps/web/src/components/inventory/item-form.tsx \
  apps/web/src/app/\(dashboard\)/dashboard/inventory/new/page.tsx
git commit -m "$(cat <<'MSG'
feat(items): Sizes chip group + bulk-variant create on category-flagged items

When the selected category has supports_sizes = true (e.g. Swag), the
item form reveals a S/M/L/XL/XXL/XXXL/XXXXL chip group next to Supplier
with per-size qty inputs. The single Qty input hides while at least one
size is picked. Submitting routes to bulkCreateSizedVariantsAction
which inserts one inventory_items row per size in a single
transaction. Names get '- {Size}' suffix; SKUs get '-{Size}' suffix;
custom_fields.size carries the size code.

Edit path unchanged — each variant edits as a normal single row.
MSG
)"
git push
```

---

## Self-Review

**Spec coverage:** Every section of the spec has at least one task:
- §2 Scan-to-search → Tasks 1.1, 1.2, 1.3
- §3 Rack filter → Tasks 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
- §4 Size variants → Tasks 3.1, 3.2, 3.3, 3.4, 3.5, 3.6

**Placeholder scan:** All code blocks contain real implementation. The one place I leaned on the engineer to make a local judgment — extending `assertPlanLimit` to accept a count vs. calling it in a loop — has both paths spelled out with a recommendation.

**Type consistency:**
- `SizeCode` defined the same in spec, service (Task 3.4), action (Task 3.5), and form (Task 3.6).
- `BulkCreateSizedVariantsInput` shape matches between the service method signature and the action zod schema.
- `supports_sizes` (DB) ↔ `supportsSizes` (TS) naming consistent: DB column is snake_case, TS field is camelCase, schemas map between them in the service.

**Ambiguity resolved inline:**
- Books page "rack" matching splits `38-A` on `-` and matches both halves of `custom_fields`.
- Auto SKU generation when `baseSku` is null is deferred (the service emits `null` in that case and lets the DB-level auto-gen trigger fire); if there is no such trigger, the action should be updated to generate the base SKU once before calling the service.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-13-inventory-upgrades.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
