# PO Staging Phase 2b — Staging Workflow UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship the operator-facing staging workflow — a Staging worklist screen, a "Place from Staging" dialog (move staged qty onto an existing or inline-created rack/crate, with split), an item/book-detail placements breakdown, and a `LocationsService.list()` kind-filter so system locations stop cluttering other pickers — closing the loop that Phase 2a's backend enforces (received stock lands in Staging and isn't pickable until placed).

**Architecture:** Reuse the LIVE Phase 2a backend: `transfer_stock(item, from=Staging, to=dest, qty)` (net-zero two-table move, guards over-place) for the Place commit, and `InventoryService.placements(itemId)` for the breakdown. New work is a thin server data method (staged worklist), an extension to location creation (rack/crate fields), a Place server action, and three React surfaces following existing patterns (the inventory list page + `stock-transfer-dialog.tsx`).

**Tech Stack:** Next.js 16 App Router (RSC + server actions, `'use client'` islands), TypeScript, Vitest, Supabase (RLS-scoped `this.ctx.supabase`), `@stockpilot/core` Zod schemas + the module registry for nav.

## Spec corrections (discovered while researching current code)
- **Location creation does NOT support placement fields yet.** `createLocationSchema` / `LocationsService.create()` / `createLocationAction` only accept `name/type/parentId/notes`. Inline rack/crate creation (Task 4) must extend them to accept `kind`, `warehouseId`, `rackNumber`, `rackRow`, `crateColor`, `crateNumber`, `parentId`. The `locations` table already has every column (mig 0188).
- **Place dialog source is fixed.** Unlike the generic Transfer dialog, the Place source is always the item's warehouse Staging location — hard-wire `fromLocationId` to it (do NOT use `transferableHoldings`, which excludes staging).
- **Warehouse filter is a cookie**, read server-side via `getActiveWarehouseFilter()`, not a query param. Other filters (books-vs-items) are URL query params.
- **Nav lives in the module registry**, not a sidebar component: `packages/core/src/modules/registry.ts`, the `inventory` module's `placements` array; the `iconName` must be registered in `apps/web/src/components/dashboard/icons.ts`.

## Global Constraints
- Web-first (Next.js). Mobile staging screen is Phase 3 (separate plan).
- RSC/'use client' boundary: NEVER import a server-only module (`InventoryService`, `requireOrgContext`, the Supabase server client) from a `'use client'` file — split outer page (server) / inner section (server) / table (`'use client'`). This is a known crash class in this repo.
- All new reads FAIL-CLOSED: a query error returns `[]`/empty, never throws into a render. Belt-and-suspenders `.eq('organization_id', this.ctx.organizationId)` on every query.
- The Place commit goes through the existing `transfer_stock` RPC (do NOT mutate `item_stock_levels`/`quantity_on_hand` directly). Placing/creating-locations requires a manage-level permission (`items:create`); the worklist requires `items:read`.
- Vitest for service/action logic; `tsc --noEmit` + eslint clean for components. Run `pnpm --filter @stockpilot/web test <file>` and `pnpm --filter @stockpilot/web exec tsc --noEmit`.
- Pre-commit hook runs — NEVER `--no-verify` (blocked). No `Co-Authored-By: Claude/Anthropic` trailer. Verify amends with `git show <sha>:file`, not just the working tree.
- No DB migration is required (Phase 2a backend is live). If any task thinks it needs one, stop and escalate.

## File Structure
- `apps/web/src/server/services/inventory.ts` — add `stagedWorklist(opts)` (staged stock grouped by item + source/age).
- `apps/web/src/server/services/locations.ts` — add `excludeSystem?` to `list()`; extend `create()` for placement fields.
- `packages/core/src/...` (the locations schema module) — extend `createLocationSchema`.
- `apps/web/src/server/actions/locations.ts` (or wherever `createLocationAction` lives) — forward the new fields.
- `apps/web/src/server/actions/inventory.ts` — add `placeStockAction`.
- `apps/web/src/app/(dashboard)/dashboard/inventory/staging/page.tsx` — the worklist screen (server).
- `apps/web/src/components/inventory/staging-table.tsx` — `'use client'` worklist table + Place trigger.
- `apps/web/src/components/inventory/place-from-staging-dialog.tsx` — `'use client'` Place dialog.
- `apps/web/src/components/inventory/placements-breakdown.tsx` — `'use client'` per-location breakdown (item/book detail).
- `packages/core/src/modules/registry.ts` + `apps/web/src/components/dashboard/icons.ts` — nav link + icon.
- The 13 user-facing pickers that call `LocationsService.list()` — pass `excludeSystem: true`.
- Tests: `inventory.stagedWorklist.test.ts`, `locations.kindFilter.test.ts`, `locations.createPlacement.test.ts`, `inventory.placeStock.test.ts`.

---

### Task 1: `InventoryService.stagedWorklist()` — staged stock grouped by item with source + age

**Files:**
- Modify: `apps/web/src/server/services/inventory.ts`
- Test: `apps/web/src/server/services/inventory.stagedWorklist.test.ts`

**Interfaces:**
- Produces: `stagedWorklist(opts?: { itemType?: 'book' | 'non-book'; warehouseId?: string | null }): Promise<StagedRow[]>` where
  `StagedRow = { itemId: string; name: string; sku: string; itemType: string; warehouseId: string | null; stagingLocationId: string; stagedQuantity: number; sourceReceiptId: string | null; sourcePoNumber: string | null; receiptNumber: string | null; receivedAt: string | null; ageDays: number | null }`.

- [ ] **Step 1: Write the failing unit test** (pure helper for grouping + age; the DB query is integration-covered by tsc + manual)

```ts
// apps/web/src/server/services/inventory.stagedWorklist.test.ts
import { describe, expect, it } from 'vitest';
import { deriveAgeDays } from './inventory';

describe('deriveAgeDays', () => {
  it('returns whole days since the earliest staged movement', () => {
    const now = new Date('2026-06-25T00:00:00Z').getTime();
    expect(deriveAgeDays('2026-06-22T00:00:00Z', now)).toBe(3);
  });
  it('returns 0 for same-day', () => {
    const now = new Date('2026-06-25T06:00:00Z').getTime();
    expect(deriveAgeDays('2026-06-25T00:00:00Z', now)).toBe(0);
  });
  it('returns null when no received timestamp', () => {
    expect(deriveAgeDays(null, Date.now())).toBeNull();
  });
});
```

- [ ] **Step 2: Run it** — `pnpm --filter @stockpilot/web test inventory.stagedWorklist` → FAIL (`deriveAgeDays` not exported).

- [ ] **Step 3: Add the helper + the method.** Near the top of `inventory.ts`:

```ts
/** Whole days between an ISO timestamp and `nowMs` (floor). Null if no timestamp. */
export function deriveAgeDays(receivedAtIso: string | null, nowMs: number): number | null {
  if (!receivedAtIso) return null;
  const then = new Date(receivedAtIso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((nowMs - then) / 86_400_000));
}
```

Add the method on `InventoryService` (mirror the fail-closed pattern in `placements()`):

```ts
async stagedWorklist(
  opts: { itemType?: 'book' | 'non-book'; warehouseId?: string | null } = {},
): Promise<Array<{
  itemId: string; name: string; sku: string; itemType: string; warehouseId: string | null;
  stagingLocationId: string; stagedQuantity: number;
  sourceReceiptId: string | null; sourcePoNumber: string | null; receiptNumber: string | null;
  receivedAt: string | null; ageDays: number | null;
}>> {
  // 1. Staged levels (qty>0) joined to item + staging location.
  let q = this.ctx.supabase
    .from('item_stock_levels')
    .select('item_id, location_id, quantity, locations!inner(id, kind, warehouse_id), inventory_items!inner(id, name, sku, item_type, deleted_at)')
    .eq('organization_id', this.ctx.organizationId)
    .eq('locations.kind', 'staging')
    .gt('quantity', 0);
  if (opts.warehouseId) q = q.eq('locations.warehouse_id', opts.warehouseId);
  if (opts.itemType === 'book') q = q.eq('inventory_items.item_type', 'book');
  if (opts.itemType === 'non-book') q = q.neq('inventory_items.item_type', 'book');
  const { data: levels, error } = await q;
  if (error || !levels) return [];

  const rows = (levels as Array<Record<string, any>>).filter(
    (r) => r.inventory_items && r.inventory_items.deleted_at == null,
  );
  if (rows.length === 0) return [];
  const itemIds = rows.map((r) => r.item_id);

  // 2. Earliest receive_po-into-staging movement per item (for age + source).
  const sourceByItem = new Map<string, { receivedAt: string; receiptId: string | null }>();
  const { data: moves } = await this.ctx.supabase
    .from('stock_movements')
    .select('item_id, created_at, reference_id, reference_type, movement_type')
    .eq('organization_id', this.ctx.organizationId)
    .eq('movement_type', 'receive_po')
    .in('item_id', itemIds)
    .order('created_at', { ascending: true });
  for (const m of (moves ?? []) as Array<Record<string, any>>) {
    if (!sourceByItem.has(m.item_id)) {
      sourceByItem.set(m.item_id, { receivedAt: m.created_at, receiptId: m.reference_id ?? null });
    }
  }

  // 3. Resolve receipt -> PO number / receipt number for the sources we have.
  const receiptIds = [...new Set([...sourceByItem.values()].map((s) => s.receiptId).filter(Boolean))] as string[];
  const receiptMeta = new Map<string, { poNumber: string | null; receiptNumber: string | null }>();
  if (receiptIds.length > 0) {
    const { data: receipts } = await this.ctx.supabase
      .from('receipts')
      .select('id, receipt_number, purchase_orders(po_number)')
      .eq('organization_id', this.ctx.organizationId)
      .in('id', receiptIds);
    for (const r of (receipts ?? []) as Array<Record<string, any>>) {
      receiptMeta.set(r.id, {
        poNumber: r.purchase_orders?.po_number ?? null,
        receiptNumber: r.receipt_number ?? null,
      });
    }
  }

  const nowMs = Date.now();
  return rows.map((r) => {
    const src = sourceByItem.get(r.item_id) ?? null;
    const meta = src?.receiptId ? receiptMeta.get(src.receiptId) : undefined;
    return {
      itemId: r.item_id,
      name: r.inventory_items.name,
      sku: r.inventory_items.sku,
      itemType: r.inventory_items.item_type,
      warehouseId: r.locations.warehouse_id ?? null,
      stagingLocationId: r.location_id,
      stagedQuantity: Number(r.quantity),
      sourceReceiptId: src?.receiptId ?? null,
      sourcePoNumber: meta?.poNumber ?? null,
      receiptNumber: meta?.receiptNumber ?? null,
      receivedAt: src?.receivedAt ?? null,
      ageDays: deriveAgeDays(src?.receivedAt ?? null, nowMs),
    };
  });
}
```

> Implementer notes: (a) verify the `receipts` ⋈ `purchase_orders` embed alias name against the real FK (the research file `p2b-data.md` documents `receipts.purchase_order_id → purchase_orders.po_number`; if PostgREST needs a different embed spelling, adapt). (b) If an item has multiple staging levels (org-level + warehouse), the query returns one row per level — that's fine for Phase 2b (each is a placeable bucket); group in the UI by item if desired. (c) Confirm `purchase_orders` has a `po_number` column (else use the right human-readable field).

- [ ] **Step 4: Run** `pnpm --filter @stockpilot/web test inventory.stagedWorklist` → PASS (3). Then `pnpm --filter @stockpilot/web exec tsc --noEmit` → clean.
- [ ] **Step 5: Commit** `git add apps/web/src/server/services/inventory.ts apps/web/src/server/services/inventory.stagedWorklist.test.ts && git commit -m "feat(staging): InventoryService.stagedWorklist (staged stock + source PO + age)"`

---

### Task 2: `LocationsService.list({ excludeSystem })` + thread it into user-facing pickers

**Files:**
- Modify: `apps/web/src/server/services/locations.ts`
- Test: `apps/web/src/server/services/locations.kindFilter.test.ts`
- Modify (pickers): the 13 callers (see Step 4)

**Interfaces:**
- Produces: `list(opts?: { includeArchived?: boolean; excludeSystem?: boolean }): Promise<LocationRow[]>` — when `excludeSystem` is true, rows with `kind in ('staging','unplaced')` are filtered out.

- [ ] **Step 1: Write the failing test** (pure filter on a row set — extract the predicate)

```ts
// apps/web/src/server/services/locations.kindFilter.test.ts
import { describe, expect, it } from 'vitest';
import { isUserFacingLocation } from './locations';

describe('isUserFacingLocation', () => {
  it('excludes staging and unplaced', () => {
    expect(isUserFacingLocation({ kind: 'staging' })).toBe(false);
    expect(isUserFacingLocation({ kind: 'unplaced' })).toBe(false);
  });
  it('keeps rack/crate/bin/null-kind', () => {
    for (const kind of ['rack', 'crate', 'bin', null]) {
      expect(isUserFacingLocation({ kind })).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run** → FAIL (`isUserFacingLocation` not exported).
- [ ] **Step 3: Implement.** In `locations.ts`:

```ts
/** A location an operator should pick as a normal bin (not a system bucket). */
export function isUserFacingLocation(loc: { kind: string | null }): boolean {
  return loc.kind !== 'staging' && loc.kind !== 'unplaced';
}
```

Add `kind` to the `list()` select if not already present, and apply the filter:

```ts
async list(opts: { includeArchived?: boolean; excludeSystem?: boolean } = {}): Promise<LocationRow[]> {
  // ... existing query (select includes `kind`) ...
  const { data, error } = await query;
  if (error || !data) return [];
  const rows = data as LocationRow[];
  return opts.excludeSystem ? rows.filter(isUserFacingLocation) : rows;
}
```

- [ ] **Step 4: Run the test** → PASS (2). Then update the 13 user-facing pickers to pass `excludeSystem: true` to their `locationsSvc.list(...)` call (do NOT touch the admin `dashboard/locations/page` or the PDF label route — those want all kinds). The callers (from research): `dashboard/inventory/page`, `inventory/new`, `inventory/[id]/edit`, `books/page`, `books/new`, `books/[id]/edit`, `purchase-orders/new`, `purchase-orders/[id]`, `purchase-orders/[id]/edit`, `purchase-orders/recurring`, `purchase-orders/imports/[id]`, `rentals/items/page`, `rentals/items/new`. For each: change `.list()` → `.list({ excludeSystem: true })` (preserve any existing `includeArchived`). Then `pnpm --filter @stockpilot/web exec tsc --noEmit` → clean.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(staging): LocationsService excludeSystem filter; hide staging/unplaced from user pickers"`

---

### Task 3: Extend location creation to accept placement (rack/crate) fields

**Files:**
- Modify: the `createLocationSchema` in `@stockpilot/core` (find via `grep -rn createLocationSchema packages/core apps/web`)
- Modify: `apps/web/src/server/services/locations.ts` (`create()`)
- Modify: `createLocationAction` (find via `grep -rn createLocationAction apps/web/src`)
- Test: `apps/web/src/server/services/locations.createPlacement.test.ts`

**Interfaces:**
- Produces: `createLocationSchema` accepts optional `kind ('area'|'rack'|'crate')`, `warehouseId`, `rackNumber`, `rackRow`, `crateColor`, `crateNumber`, `parentId`. `LocationsService.create(input)` persists them. `createLocationAction` returns `ok({ id })` (already does).

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/server/services/locations.createPlacement.test.ts
import { describe, expect, it } from 'vitest';
import { createLocationSchema } from '@stockpilot/core';

describe('createLocationSchema placement fields', () => {
  it('accepts a rack with number + row + warehouse', () => {
    const r = createLocationSchema.safeParse({
      name: '41-B', type: 'shelf', kind: 'rack', warehouseId: 'w1', rackNumber: '41', rackRow: 'B',
    });
    expect(r.success).toBe(true);
  });
  it('accepts a crate with color + number + parent rack', () => {
    const r = createLocationSchema.safeParse({
      name: 'Blue #3', type: 'bin', kind: 'crate', warehouseId: 'w1',
      crateColor: 'Blue', crateNumber: '3', parentId: 'rack-1',
    });
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run** → FAIL (schema rejects unknown keys).
- [ ] **Step 3: Extend the schema** (add the optional fields, matching the existing schema's style):

```ts
// in createLocationSchema (packages/core ...)
kind: z.enum(['area', 'rack', 'crate']).optional(),
warehouseId: z.string().uuid().nullable().optional(),
rackNumber: z.string().max(64).nullable().optional(),
rackRow: z.string().max(64).nullable().optional(),
crateColor: z.string().max(64).nullable().optional(),
crateNumber: z.string().max(64).nullable().optional(),
parentId: z.string().uuid().nullable().optional(),  // if not already present
```

In `LocationsService.create()`, include the new columns in the insert (snake_case): `kind, warehouse_id, rack_number, rack_row, crate_color, crate_number, parent_id`. In `createLocationAction`, forward the new fields from the validated input. Keep org-scoping (`organization_id = ctx.organizationId`).

- [ ] **Step 4: Run the test** → PASS (2). `tsc --noEmit` clean.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(staging): location creation accepts rack/crate placement fields"`

---

### Task 4: `placeStockAction` — move staged qty to an existing or inline-created location

**Files:**
- Modify: `apps/web/src/server/actions/inventory.ts`
- Test: `apps/web/src/server/actions/inventory.placeStock.test.ts`

**Interfaces:**
- Consumes: `transferStockAction`/`transfer_stock` RPC (Task interfaces above), `LocationsService.create()` (Task 3).
- Produces: `placeStockAction(input)` where
  `input = { itemId: string; fromLocationId: string; quantity: number; notes?: string; destination: { existingLocationId: string } | { newRack: { warehouseId: string; rackNumber: string; rackRow?: string; crateColor?: string; crateNumber?: string; parentId?: string } } }`.
  Returns `ActionResult<{ toLocationId: string }>`. It (a) resolves the destination location id — creating a `kind='rack'` (or `kind='crate'` when crate fields are present) location via the Task-3 create path if `newRack` is given — then (b) calls `transfer_stock(itemId, fromLocationId, toLocationId, quantity, notes)`.

- [ ] **Step 1: Write the failing test** (mock the supabase rpc + the create path; assert it transfers to an existing id, and creates-then-transfers for a new rack)

```ts
// apps/web/src/server/actions/inventory.placeStock.test.ts
import { describe, expect, it, vi } from 'vitest';
// Use the existing action-test harness in this repo (see po-imports.create-items.test.ts
// for the stub style). Assert:
//  1. destination.existingLocationId -> transfer_stock called with that toLocationId, quantity.
//  2. destination.newRack -> a kind='rack' location is created, then transfer_stock uses the new id.
//  3. quantity<=0 or missing destination -> validation error, no transfer.
it('places to an existing location via transfer_stock', async () => { /* implementer fills using the repo's action stub */ });
it('creates a rack then places to it', async () => { /* ... */ });
it('rejects non-positive quantity', async () => { /* ... */ });
```

> Implementer: build these three on the repo's existing server-action test harness (copy the stub pattern from `apps/web/src/server/actions/po-imports.create-items.test.ts`). Do NOT ship `it(() => {})` empty bodies — assert real behavior (transfer args, create-then-transfer ordering, validation).

- [ ] **Step 2: Run** → FAIL (`placeStockAction` not defined).
- [ ] **Step 3: Implement** `placeStockAction` (mirror the existing action style in `inventory.ts` — `withContext`/permission assert, zod-validate, `ok`/`err`):

```ts
// validate input (zod), assert items:create permission, then:
let toLocationId: string;
if ('existingLocationId' in input.destination) {
  toLocationId = input.destination.existingLocationId;
} else {
  const n = input.destination.newRack;
  const created = await locationsSvc.create({
    name: deriveLocationName(n),                 // e.g. `${rackNumber}-${rackRow}` or `${color} #${number}`
    type: n.crateColor ? 'bin' : 'shelf',
    kind: n.crateColor ? 'crate' : 'rack',
    warehouseId: n.warehouseId,
    rackNumber: n.rackNumber, rackRow: n.rackRow ?? null,
    crateColor: n.crateColor ?? null, crateNumber: n.crateNumber ?? null,
    parentId: n.parentId ?? null,
  });
  toLocationId = created.id;
}
const res = await transferStock({ itemId: input.itemId, fromLocationId: input.fromLocationId, toLocationId, quantity: input.quantity, notes: input.notes });
// surface insufficient_stock as a friendly "more than is staged" error
if (!res.ok) return res;
revalidatePath('/dashboard/inventory/staging');
return ok({ toLocationId });
```

Add a small `deriveLocationName(n)` helper. `transfer_stock`'s `insufficient_stock` guard already prevents placing more than is staged — map it to a friendly message in the action or surface `res.error.message` in the dialog.

- [ ] **Step 4: Run the test** → PASS (3). `tsc --noEmit` clean.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(staging): placeStockAction (Staging -> rack/crate via transfer_stock, inline-create)"`

---

### Task 5: Staging worklist screen (`/dashboard/inventory/staging`) + nav

**Files:**
- Create: `apps/web/src/app/(dashboard)/dashboard/inventory/staging/page.tsx`
- Create: `apps/web/src/components/inventory/staging-table.tsx` (`'use client'`)
- Modify: `packages/core/src/modules/registry.ts` (nav link), `apps/web/src/components/dashboard/icons.ts` (icon)

**Interfaces:**
- Consumes: `InventoryService.stagedWorklist()` (Task 1). Renders `<PlaceFromStagingDialog>` (Task 6) per row.

- [ ] **Step 1: Build the screen** mirroring the inventory list page pattern (research `p2b-route.md`): an outer **server** `page.tsx` that awaits `searchParams`, resolves `requireOrgContext()`, checks `items:read`, reads the warehouse cookie via `getActiveWarehouseFilter()`, and renders a `<Suspense>` inner **server** section that calls `InventoryService.forCurrentUser().stagedWorklist({ itemType, warehouseId })` and passes the rows + `canPlace = hasPermission(ctx.role, 'items:create')` into the `'use client'` `<StagingTable>`. Do NOT import the service from the client component.
- [ ] **Step 2: Build `staging-table.tsx`** (`'use client'`): a table of staged rows — columns: item (name/sku), staged qty, source PO/receipt, received date, **age** (with a **stale badge** when `ageDays > 7`), warehouse; a books-vs-items filter (URL query param via `router.push`); and a **Place** button per row (rendered only when `canPlace`) that opens `<PlaceFromStagingDialog>` with the row's `itemId`, `itemType`, `stagingLocationId`, `warehouseId`, `stagedQuantity`. Mirror the styling/skeleton of `inventory-table.tsx`. Empty state: "Nothing staged — received stock will appear here to place."
- [ ] **Step 3: Nav + icon.** Register a `LayoutList` (or similar existing) icon in `apps/web/src/components/dashboard/icons.ts` if not present, then add to the `inventory` module's `placements` array in `packages/core/src/modules/registry.ts`: `{ surface: 'web_sidebar', section: 'inventory', label: 'Staging', href: '/dashboard/inventory/staging', iconName: '<icon>', defaultSortOrder: 5, requires: 'items:read' }`.
- [ ] **Step 4: Gate** `pnpm --filter @stockpilot/web exec tsc --noEmit` clean; `pnpm --filter @stockpilot/web exec eslint apps/web/src/app/(dashboard)/dashboard/inventory/staging/page.tsx apps/web/src/components/inventory/staging-table.tsx` → 0 errors. (No unit test for the presentational screen unless the repo has a component-test setup; the data layer is tested in Task 1. State this in the report.)
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(staging): Staging worklist screen + nav link"`

---

### Task 6: Place-from-Staging dialog

**Files:**
- Create: `apps/web/src/components/inventory/place-from-staging-dialog.tsx` (`'use client'`)

**Interfaces:**
- Consumes: `placeStockAction` (Task 4), `LocationsService` placement-location list for the destination picker (passed as a prop from the server, filtered to `kind in ('rack','crate')` for the row's warehouse), `placements(itemId)` optional for showing current placement.
- Props: `{ itemId, itemName, itemType, stagingLocationId, warehouseId, stagedQuantity, destinations: { id: string; name: string; kind: string }[], trigger? }`.

- [ ] **Step 1: Build the dialog** mirroring `stock-transfer-dialog.tsx` (same Dialog/Select/Input/Button/Label/sonner imports). Differences:
  - **Source is fixed** to `stagingLocationId` (show "From: Staging", not a picker).
  - **Destination**: a Select of `destinations` (existing racks/crates in the row's warehouse) PLUS a "+ New rack/crate" option that reveals inline inputs — rack number + row (always), and for `itemType === 'book'` also crate color + number. (Books place into a crate; items into a rack.)
  - **Quantity**: numeric, default = `stagedQuantity`, max = `stagedQuantity` (support **split** — placing part now). Validate `0 < qty <= stagedQuantity`.
  - **Commit**: call `placeStockAction({ itemId, fromLocationId: stagingLocationId, quantity, notes, destination })` where `destination` is either `{ existingLocationId }` or `{ newRack: { warehouseId, rackNumber, rackRow, crateColor?, crateNumber? } }`. On success: `toast.success(\`Placed ${qty}\`)`, `setOpen(false)`, `router.refresh()`. On error: `toast.error(res.error.message)` (the `insufficient_stock`/over-place case surfaces here).
- [ ] **Step 2: Gate** `tsc --noEmit` clean; `eslint` 0 on the new file. Confirm it's a `'use client'` file that imports only client-safe modules + the server action (server actions are callable from client).
- [ ] **Step 3: Commit** `git add -A && git commit -m "feat(staging): Place-from-Staging dialog (existing/new rack-crate, split)"`

---

### Task 7: Item / book detail placements breakdown

**Files:**
- Create: `apps/web/src/components/inventory/placements-breakdown.tsx` (`'use client'`)
- Modify: the item-detail page/tabs to render it (find via `grep -rn placements\|item-detail apps/web/src`)

**Interfaces:**
- Consumes: `InventoryService.placements(itemId)` (LIVE) — fetched server-side and passed in as `placements: { locationId, name, kind, quantity }[]`.

- [ ] **Step 1: Build `placements-breakdown.tsx`** (`'use client'`, presentational): given the `placements` prop, render a compact per-location list — e.g. "39 in 41‑B · 90 in 50‑A · 12 staged", with the `kind='staging'` entry labeled "Staging" and visually distinct. If empty, render nothing. Format via the existing `formatNumber` helper.
- [ ] **Step 2: Wire it** into the item-detail page: fetch `placements` server-side (it's already a method) and pass the array to `<PlacementsBreakdown>`. Mirror how other detail sub-sections are wired. Do this for both the item and book detail surfaces if they differ.
- [ ] **Step 3: Gate** `tsc --noEmit` clean; `eslint` 0. `pnpm --filter @stockpilot/web test` full suite green.
- [ ] **Step 4: Commit** `git add -A && git commit -m "feat(staging): item/book detail placements breakdown"`

---

## Final gate (after all tasks)
- [ ] `pnpm --filter @stockpilot/web test` green; `pnpm --filter @stockpilot/web exec tsc --noEmit` clean; eslint clean on all new/changed files.
- [ ] Manual smoke (or note it for the owner): receive a PO → item appears in `/dashboard/inventory/staging` with age/source → Place part of it to a new rack (split) → the rack now holds it, staging drops, the item becomes pickable; `Σlevels = on_hand` unchanged (net-zero).
- [ ] Adversarial review IF any task touched a money/stock path beyond the read+transfer_stock wrapper (Place action). The Place commit goes through the already-reviewed `transfer_stock`, so a lighter review is acceptable; still sweep the new action for permission gating + the inline-create org-scoping (a created rack/crate must be in the caller's org + the row's warehouse).
- [ ] No DB migration shipped (confirm `git diff --stat main..HEAD` shows no `supabase/migrations/*`). Deploy is a normal web deploy (Vercel) — no `supabase db push` needed.

## Self-review
**Spec coverage:** §5.1 worklist → Tasks 1,5. §5.2 Place (existing/new, split, transfer_stock) → Tasks 3,4,6. §5.3 placements breakdown → Task 7. §5.4 LocationsService kind-filter → Task 2. §6 edge cases (over-place guard) → Task 4 (transfer_stock's `insufficient_stock`). Books-vs-items crate → Task 6.
**Placeholder scan:** Task 4's test bodies are described with the exact assertions + the harness to copy (po-imports.create-items.test.ts) — the implementer writes them; the no-empty-`it` rule is stated. Task 1's age helper has complete code + tests; the query has complete code with two named verify-points (the receipts↔PO embed alias, po_number column) the implementer confirms against the live schema. UI tasks 5–7 carry structure + the named mirror files (inventory list page, stock-transfer-dialog) rather than full component transcription, per "follow established patterns" — each ends gated by tsc+eslint.
**Type consistency:** `stagedWorklist` row fields (Task 1) feed `StagingTable` (Task 5) + the dialog props (Task 6). `placeStockAction` input shape (Task 4) is exactly what the dialog builds (Task 6). `excludeSystem`/`isUserFacingLocation` (Task 2) consistent. `placements()` (live) feeds Task 7.

## Execution Handoff
1. **Subagent-Driven (recommended)** — fresh subagent per task + two-stage review.
2. **Inline Execution** — batch with checkpoints.
Phase 3 (mobile staging/Place screen) gets its own plan once Phase 2b's web surfaces settle.
