# Cycle Count by Selection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users pick specific items + books from the Inventory/Books lists and run a cycle count over only those, on web and mobile.

**Architecture:** Add a `scope` column to `cycle_counts` (`'warehouse'|'selection'`); `scope='selection'` snapshots only chosen items with `warehouse_id=null` at the header but per-line warehouse snapshots (so `post_cycle_count` is unchanged). A client "count selection" store persists picks across the Inventory↔Books tabs; a reworked New page confirms + starts. Mobile gets a matching store, select mode, confirm screen, and a new `POST /api/v1/cycle-counts` create endpoint.

**Tech Stack:** Next.js 16 / React 19 / Supabase (Postgres + RLS) / zustand / Expo React Native / Vitest.

**Spec:** `docs/superpowers/specs/2026-05-28-cycle-count-selection-design.md`

**Already shipped (Phase 0):** `withApiContext(req)` auth fix — commit `c280a2c`.

---

## File Structure

**Create:**
- `supabase/migrations/0141_cycle_count_scope.sql` — scope column.
- `apps/web/src/lib/cycle-counts/use-count-selection.ts` — web zustand selection store.
- `apps/web/src/components/cycle-counts/new-cycle-count.tsx` — client two-mode New screen (selection | warehouse).
- `apps/web/src/components/cycle-counts/selection-confirm.tsx` — the selection-mode confirm UI (picked list + notes + assignee).
- `apps/web/src/app/api/v1/cycle-counts/route.ts` — mobile create endpoint.
- `apps/mobile/src/lib/use-count-selection.ts` — mobile selection store (no new dep).
- `apps/mobile/app/cycle-count/new.tsx` — mobile confirm screen.

**Modify:**
- `apps/web/src/server/services/cycle-counts.ts` — `start()` selection path + `itemsInScopeCount()`.
- `apps/web/src/server/actions/cycle-counts.ts` — `startCycleCountAction` schema.
- `apps/web/src/app/(dashboard)/dashboard/cycle-counts/new/page.tsx` — load members, render `<NewCycleCount>`.
- `apps/web/src/components/inventory/bulk-actions.tsx` — "Cycle count selected" action.
- `apps/web/src/components/inventory/inventory-table.tsx` — pass selected items to store on action.
- `apps/web/src/components/books/books-inventory-table.tsx` — add checkbox selection + bulk bar.
- `apps/mobile/app/(drawer)/(tabs)/inventory.tsx` + `books.tsx` — select mode.
- `apps/mobile/app/(drawer)/(tabs)/cycle-counts.tsx` — wire the `＋` button.

---

## Phase 1 — Backend (DB + service + action + API)

### Task 1: Migration — `scope` column

**Files:**
- Create: `supabase/migrations/0141_cycle_count_scope.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0141_cycle_count_scope.sql
-- Distinguishes a hand-picked "selection" cycle count from the existing
-- warehouse/org-wide count. A selection count stores warehouse_id=null at
-- the header (it may span warehouses) but each cycle_count_lines row keeps
-- its own warehouse_id snapshot, which is all post_cycle_count needs.
alter table public.cycle_counts
  add column if not exists scope text not null default 'warehouse'
    check (scope in ('warehouse', 'selection'));

comment on column public.cycle_counts.scope is
  'warehouse = snapshot of all active items in warehouse/org (default); '
  'selection = an explicit hand-picked item set. Selection counts set '
  'warehouse_id=null and rely on per-line warehouse_id for posting scope.';
```

- [ ] **Step 2: Apply locally and verify**

Run: `pnpm db:migrate` (or `supabase migration up`)
Expected: migration applies; `\d public.cycle_counts` shows `scope text not null default 'warehouse'`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0141_cycle_count_scope.sql
git commit -m "feat(cycle-counts): add scope column for selection counts"
```

Note: `packages/core/src/types/database.ts` is an intentional `any` stub — **no type regen needed**.

---

### Task 2: Service — `start()` selection path + `itemsInScopeCount()`

**Files:**
- Modify: `apps/web/src/server/services/cycle-counts.ts`
- Test: `apps/web/src/server/services/cycle-counts.selection.test.ts` (create)

- [ ] **Step 1: Write failing tests**

Create `apps/web/src/server/services/cycle-counts.selection.test.ts`. Mirror the mocking style of `apps/web/src/server/services/inventory.test.ts` (mock the supabase client + context). Cover:

```ts
// 1. start({scope:'selection', itemIds}) inserts a count with scope='selection',
//    warehouse_id=null, and one line per VALID item (active, in-org, not deleted),
//    each line carrying that item's warehouse_id + quantity_on_hand snapshot.
// 2. itemIds that are archived/deleted/other-org are dropped; empty result throws
//    ServiceError('validation_error').
// 3. start() asserts WRITE access to each distinct warehouse in the selection
//    (assertWarehouseAccess called per warehouse).
// 4. when assignedTo is set, assign() is invoked after insert (separate update).
// 5. itemsInScopeCount() returns 0 when the count's scope='selection'.
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd apps/web && npx vitest run src/server/services/cycle-counts.selection.test.ts`
Expected: FAIL (start() doesn't accept `scope`/`itemIds` yet).

- [ ] **Step 3: Extend the `start()` signature + add the selection branch**

In `cycle-counts.ts`, replace the `start()` signature/body. New signature:

```ts
async start(input: {
  scope?: 'warehouse' | 'selection';
  warehouseId: string | null;
  itemIds?: string[];
  notes?: string | null;
  assignedTo?: string | null;
}): Promise<{ id: string; lineCount: number; skipped: number }> {
  assertPermission(this.ctx, 'stock:adjust');
  const scope = input.scope ?? 'warehouse';

  let items: Array<{ id: string; quantity_on_hand: number; warehouse_id: string | null }>;

  if (scope === 'selection') {
    const ids = Array.from(new Set(input.itemIds ?? []));
    if (ids.length === 0) {
      throw new ServiceError('validation_error', 'Pick at least one item to count.');
    }
    const { data, error } = await this.ctx.supabase
      .from('inventory_items')
      .select('id, quantity_on_hand, warehouse_id')
      .eq('organization_id', this.ctx.organizationId)
      .is('deleted_at', null)
      .eq('status', 'active')
      .in('id', ids);
    if (error) throw new ServiceError('internal_error', error.message);
    items = (data ?? []) as typeof items;
    if (items.length === 0) {
      throw new ServiceError(
        'validation_error',
        'None of the selected items are still active. Refresh and try again.',
      );
    }
    // Write-access gate: every distinct warehouse represented must be writable.
    // Items with a null warehouse require full (manager+) access.
    const distinctWh = new Set<string>();
    let hasNullWh = false;
    for (const it of items) {
      if (it.warehouse_id) distinctWh.add(it.warehouse_id);
      else hasNullWh = true;
    }
    if (hasNullWh) {
      const access = await getWarehouseAccess(this.ctx);
      if (!access.hasAllAccess) {
        throw new ForbiddenError('You cannot count items that have no warehouse.');
      }
    }
    for (const wh of distinctWh) {
      await assertWarehouseAccess(wh, 'write', this.ctx);
    }
  } else {
    // existing warehouse/org path
    if (input.warehouseId) {
      await assertWarehouseAccess(input.warehouseId, 'write', this.ctx);
    }
    let itemQuery = this.ctx.supabase
      .from('inventory_items')
      .select('id, quantity_on_hand, warehouse_id')
      .eq('organization_id', this.ctx.organizationId)
      .is('deleted_at', null)
      .eq('status', 'active');
    if (input.warehouseId) itemQuery = itemQuery.eq('warehouse_id', input.warehouseId);
    const { data, error } = await itemQuery;
    if (error) throw new ServiceError('internal_error', error.message);
    items = (data ?? []) as typeof items;
    if (items.length === 0) {
      const where = input.warehouseId ? 'this warehouse' : 'your organization';
      throw new ServiceError('validation_error',
        `No active items found in ${where}. Add items first, or pick a different warehouse.`);
    }
  }

  const requested = scope === 'selection' ? (input.itemIds?.length ?? 0) : items.length;

  const { data: cc, error: ccErr } = await this.ctx.supabase
    .from('cycle_counts')
    .insert({
      organization_id: this.ctx.organizationId,
      warehouse_id: scope === 'selection' ? null : input.warehouseId,
      scope,
      status: 'in_progress',
      notes: input.notes ?? null,
      started_by: this.ctx.userId,
    })
    .select('id')
    .single();
  if (ccErr) throw new ServiceError('internal_error', ccErr.message);

  const linesPayload = items.map((it) => ({
    cycle_count_id: cc.id as string,
    item_id: it.id,
    warehouse_id: it.warehouse_id ?? null,
    expected_quantity: Number(it.quantity_on_hand) || 0,
  }));
  const { error: linesErr } = await this.ctx.supabase
    .from('cycle_count_lines')
    .insert(linesPayload);
  if (linesErr) throw new ServiceError('internal_error', linesErr.message);

  // Assign as a SEPARATE update so trg_cycle_counts_assigned fires and the
  // assignee is notified (the insert above wouldn't trip the UPDATE trigger).
  if (input.assignedTo) {
    try {
      await this.assign(cc.id as string, input.assignedTo);
    } catch {
      // Non-fatal: the count exists; assignment just didn't stick.
    }
  }

  await audit(
    { event: 'cycle_count.started', entityType: 'cycle_count', entityId: cc.id as string,
      after: { scope, warehouseId: scope === 'selection' ? null : input.warehouseId,
               lineCount: linesPayload.length } },
    this.ctx,
  );

  return { id: cc.id as string, lineCount: linesPayload.length, skipped: requested - linesPayload.length };
}
```

Also add the missing import at top: `import { assertWarehouseAccess, ForbiddenError, getWarehouseAccess } from '@/lib/auth/warehouse';` (file already imports `assertWarehouseAccess, ForbiddenError, getWarehouseAccess`).

- [ ] **Step 4: Make `itemsInScopeCount()` selection-aware**

In `itemsInScopeCount()`, after loading `header` (which selects `warehouse_id, status`), also select `scope` and short-circuit:

```ts
.select('warehouse_id, status, scope')
// ...
const h = header as { warehouse_id: string | null; status: CycleCountStatus; scope?: string };
if (h.status !== 'in_progress') return 0;
if (h.scope === 'selection') return 0; // fixed set — no "new items" concept
```

- [ ] **Step 5: Run tests, verify pass**

Run: `cd apps/web && npx vitest run src/server/services/cycle-counts.selection.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/services/cycle-counts.ts apps/web/src/server/services/cycle-counts.selection.test.ts
git commit -m "feat(cycle-counts): selection-scoped start() with per-warehouse write gate"
```

---

### Task 3: Action — accept selection input

**Files:**
- Modify: `apps/web/src/server/actions/cycle-counts.ts`

- [ ] **Step 1: Update the Zod schema + action**

Replace `startSchema` and `startCycleCountAction`:

```ts
const startSchema = z.object({
  scope: z.enum(['warehouse', 'selection']).default('warehouse'),
  warehouseId: z.string().uuid().nullable(),
  itemIds: z.array(z.string().uuid()).max(1000).optional(),
  notes: z.string().max(2000).optional().nullable(),
  assignedTo: z.string().uuid().nullable().optional(),
}).refine((v) => v.scope !== 'selection' || (v.itemIds?.length ?? 0) > 0, {
  message: 'Pick at least one item.', path: ['itemIds'],
});

export async function startCycleCountAction(input: {
  scope?: 'warehouse' | 'selection';
  warehouseId: string | null;
  itemIds?: string[];
  notes?: string | null;
  assignedTo?: string | null;
}): Promise<ActionResult<{ id: string; lineCount: number; skipped: number }>> {
  const parsed = startSchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await CycleCountsService.forCurrentUser();
    const result = await svc.start(parsed.data);
    revalidatePath('/dashboard/cycle-counts');
    return ok(result);
  } catch (e) {
    return toResult(e);
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/server/actions/cycle-counts.ts
git commit -m "feat(cycle-counts): startCycleCountAction accepts selection input"
```

---

### Task 4: Mobile create endpoint `POST /api/v1/cycle-counts`

**Files:**
- Create: `apps/web/src/app/api/v1/cycle-counts/route.ts`
- Test: `apps/web/src/app/api/v1/cycle-counts/route.test.ts` (create)

- [ ] **Step 1: Write failing test** — 401 without bearer; success path returns `{id,lineCount}`. Mirror `apps/web/src/app/api/v1/items/[id]/barcode/route.test.ts` mocking of `withApiContext`.

- [ ] **Step 2: Run, verify fail.** `cd apps/web && npx vitest run src/app/api/v1/cycle-counts/route.test.ts` → FAIL.

- [ ] **Step 3: Implement the route**

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { ForbiddenError } from '@/lib/auth/warehouse';
import { ServiceError } from '@/server/services/context';
import { CycleCountsService } from '@/server/services/cycle-counts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  scope: z.enum(['warehouse', 'selection']).default('selection'),
  warehouseId: z.string().uuid().nullable().optional(),
  itemIds: z.array(z.string().uuid()).max(1000).optional(),
  notes: z.string().max(2000).optional().nullable(),
  assignedTo: z.string().uuid().nullable().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const ctx = await withApiContext(req);
    if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    const json = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation_error', message: parsed.error.issues[0]?.message }, { status: 400 });
    }
    const svc = new CycleCountsService(ctx);
    const result = await svc.start({
      scope: parsed.data.scope,
      warehouseId: parsed.data.warehouseId ?? null,
      itemIds: parsed.data.itemIds,
      notes: parsed.data.notes ?? null,
      assignedTo: parsed.data.assignedTo ?? null,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof ServiceError) {
      const status = e.code === 'not_found' ? 404 : e.code === 'validation_error' ? 400 : 500;
      return NextResponse.json({ error: e.code, message: e.message }, { status });
    }
    if (e instanceof ForbiddenError) return NextResponse.json({ error: 'forbidden', message: e.message }, { status: 403 });
    void reportError(e, { tag: 'api.v1.cycle_counts.create' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run test, verify pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/api/v1/cycle-counts/route.ts apps/web/src/app/api/v1/cycle-counts/route.test.ts
git commit -m "feat(api): POST /api/v1/cycle-counts mobile create endpoint"
```

---

## Phase 2 — Web UI

### Task 5: Web count-selection store

**Files:**
- Create: `apps/web/src/lib/cycle-counts/use-count-selection.ts`

- [ ] **Step 1: Implement the zustand store (sessionStorage-persisted)**

```ts
'use client';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface CountPick {
  id: string;
  sku: string;
  name: string;
  itemType: 'book' | 'product' | string;
}

interface CountSelectionState {
  picks: Record<string, CountPick>;
  add: (items: CountPick[]) => void;
  remove: (id: string) => void;
  clear: () => void;
}

export const useCountSelection = create<CountSelectionState>()(
  persist(
    (set) => ({
      picks: {},
      add: (items) =>
        set((s) => {
          const next = { ...s.picks };
          for (const it of items) next[it.id] = it;
          return { picks: next };
        }),
      remove: (id) => set((s) => {
        const next = { ...s.picks };
        delete next[id];
        return { picks: next };
      }),
      clear: () => set({ picks: {} }),
    }),
    { name: 'sp-count-selection', storage: createJSONStorage(() => sessionStorage) },
  ),
);

export const selectCountList = (s: CountSelectionState) => Object.values(s.picks);
```

- [ ] **Step 2: Typecheck.** `cd apps/web && npx tsc --noEmit` → no errors.

- [ ] **Step 3: Commit.** `git add apps/web/src/lib/cycle-counts/use-count-selection.ts && git commit -m "feat(cycle-counts): web count-selection store"`

---

### Task 6: Books table selection + bulk bar

**Files:**
- Modify: `apps/web/src/components/books/books-inventory-table.tsx`

- [ ] **Step 1:** Read the file. Add a `selected: Set<string>` state mirroring `inventory-table.tsx:321` (header select-all checkbox, per-row `<Checkbox>` cell, row highlight). Reuse the same `Checkbox` component pattern (copy the small `Checkbox` from inventory-table or import a shared one).

- [ ] **Step 2:** When `selected.size > 0`, render a slim bar above the table with `{n} selected` + a **"Cycle count selected"** button and **Clear**. The button:

```tsx
const addToCount = useCountSelection((s) => s.add);
const router = useRouter();
function startCount() {
  addToCount(books.filter((b) => selected.has(b.id)).map((b) => ({
    id: b.id, sku: b.sku, name: b.name, itemType: 'book',
  })));
  setSelected(new Set());
  router.push('/dashboard/cycle-counts/new');
}
```

- [ ] **Step 3:** Typecheck + manual: tick a few books → bar shows → button routes to New with store populated.

- [ ] **Step 4: Commit.** `git commit -m "feat(books): row selection + cycle-count-selected action"`

---

### Task 7: Inventory "Cycle count selected" action

**Files:**
- Modify: `apps/web/src/components/inventory/bulk-actions.tsx`
- Modify: `apps/web/src/components/inventory/inventory-table.tsx`

- [ ] **Step 1:** In `bulk-actions.tsx`, add a new toolbar entry next to "Print labels" (~line 191). It needs the picked rows' metadata, so add a prop `onCycleCount: () => void` to `BulkActionsProps` and render:

```tsx
<span className="text-[var(--ed-ink-4)]">·</span>
<button type="button" onClick={onCycleCount}
  className="inline-flex items-center gap-1 text-[var(--ed-ink-2)] hover:text-foreground">
  <ClipboardCheck className="h-3 w-3" /> Cycle count
</button>
```

(import `ClipboardCheck` from `lucide-react`.)

- [ ] **Step 2:** In `inventory-table.tsx` where `<BulkActions ... />` is rendered (~line 691), pass:

```tsx
onCycleCount={() => {
  addToCount(items.filter((i) => selected.has(i.id)).map((i) => ({
    id: i.id, sku: i.sku, name: i.name, itemType: i.item_type ?? 'product',
  })));
  setSelected(new Set());
  router.push('/dashboard/cycle-counts/new');
}}
```

Add `const addToCount = useCountSelection((s) => s.add);` near the other hooks; `useRouter` is already imported. Confirm `items` rows expose `sku`, `name`, `item_type` (they do — used elsewhere in the table).

- [ ] **Step 3:** Typecheck + manual: select items → "Cycle count" → New page populated.

- [ ] **Step 4: Commit.** `git commit -m "feat(inventory): Cycle count selected bulk action"`

---

### Task 8: Two-mode New cycle count page

**Files:**
- Create: `apps/web/src/components/cycle-counts/new-cycle-count.tsx`
- Create: `apps/web/src/components/cycle-counts/selection-confirm.tsx`
- Modify: `apps/web/src/app/(dashboard)/dashboard/cycle-counts/new/page.tsx`

- [ ] **Step 1: Server page** — load `warehouses`, plus `members` + `canAssign` (copy the member-loading block from `cycle-counts/[id]/page.tsx:55-89`). Render `<NewCycleCount warehouses={...} members={members} canAssign={canAssign} />` instead of `<StartCycleCountForm>` directly. Keep the `hasPermission(ctx.role,'stock:adjust')` redirect guard.

- [ ] **Step 2: `new-cycle-count.tsx` (client)** — reads `useCountSelection`. If `picks` non-empty, default to selection mode and render `<SelectionConfirm picks notes assignee members canAssign />`; otherwise render `<StartCycleCountForm warehouses />`. Provide a small mode toggle ("Selected items (N)" | "Whole warehouse") so users can switch.

- [ ] **Step 3: `selection-confirm.tsx` (client)** — list picks (group by `itemType`: Products / Books), each row removable (`remove(id)`), an "Add more items" link to `/dashboard/inventory`, a `Textarea` for notes, and (when `canAssign`) a member `Select` for assignee. "Start count" calls:

```tsx
const r = await startCycleCountAction({
  scope: 'selection',
  warehouseId: null,
  itemIds: list.map((p) => p.id),
  notes: notes.trim() || null,
  assignedTo: assignee === '__unassigned' ? null : assignee,
});
if (!r.ok) { toast.error(r.error.message); return; }
if (r.data.skipped > 0) toast.message(`Started with ${r.data.lineCount} item(s); ${r.data.skipped} were archived/removed.`);
clear();
router.push(`/dashboard/cycle-counts/${r.data.id}`);
```

- [ ] **Step 4:** Typecheck + manual end-to-end: mix products+books → confirm → start → land on live count with only those lines; assignee notified.

- [ ] **Step 5: Commit.** `git commit -m "feat(cycle-counts): two-mode New page with selection confirm"`

---

## Phase 3 — Mobile UI (ships via new EAS build)

### Task 9: Mobile count-selection store

**Files:**
- Create: `apps/mobile/src/lib/use-count-selection.ts`

- [ ] **Step 1:** Implement a tiny external store with `useSyncExternalStore` (no new dep): module-level `Map`, `add(items)`, `remove(id)`, `clear()`, `useCountSelection()` hook returning the list + actions, `useCountSelectionCount()` for the badge. Shape `{ id, sku, name, itemType }`.

- [ ] **Step 2:** Typecheck. `cd apps/mobile && npx tsc --noEmit` (or the repo's mobile typecheck) → no errors.

- [ ] **Step 3: Commit.** `git commit -m "feat(mobile): count-selection store"`

---

### Task 10: Select mode on Items + Books tabs

**Files:**
- Modify: `apps/mobile/app/(drawer)/(tabs)/inventory.tsx`
- Modify: `apps/mobile/app/(drawer)/(tabs)/books.tsx`

- [ ] **Step 1:** Add a "Select" toggle in each tab's top bar. In select mode, tapping a row toggles its membership in the store (show a check overlay on `Thumb`/row instead of navigating). Keep `React.memo` props stable (per `reference_mobile_items_perf_solved` — pass stable `onToggle(id)` callbacks, build the inline closure per row).
- [ ] **Step 2:** When the store is non-empty, show a bottom action bar: "N selected → Review" → `router.push('/cycle-count/new')` plus Clear.
- [ ] **Step 3:** Manual on simulator: select items + books across tabs, bar persists.
- [ ] **Step 4: Commit.** `git commit -m "feat(mobile): select mode on Items + Books"`

---

### Task 11: Mobile confirm screen → create via API

**Files:**
- Create: `apps/mobile/app/cycle-count/new.tsx`

- [ ] **Step 1:** Screen reads the store, lists picks (grouped), each removable, a notes field, optional assignee (load org members via supabase, manager+ only — reuse the two-step members fetch pattern from the team screen). "Start count" POSTs to `/api/v1/cycle-counts`:

```ts
const { data: { session } } = await supabase.auth.getSession();
const res = await fetch(`${API_BASE}/api/v1/cycle-counts`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
  body: JSON.stringify({ scope: 'selection', itemIds: list.map((p) => p.id), notes, assignedTo }),
});
```

On 201, `clear()` and `router.replace('/cycle-count/' + (await res.json()).id)`. Use the existing mobile `API_BASE` + Bearer pattern (see `apps/mobile/app/ai/chat.tsx` / `scan-po`).

- [ ] **Step 2:** Manual: create a scoped count on device → appears in Cycle counts list → countable.
- [ ] **Step 3: Commit.** `git commit -m "feat(mobile): scoped cycle-count confirm + create"`

---

### Task 12: Wire the `＋` button

**Files:**
- Modify: `apps/mobile/app/(drawer)/(tabs)/cycle-counts.tsx:199`

- [ ] **Step 1:** Give the `＋` `IconChip` an `onPress` that opens a small sheet/menu: "Pick items to count" (→ routes to Items tab in select mode) and "Count a whole warehouse" (→ a simple warehouse picker that POSTs `{scope:'warehouse', warehouseId}`). Update the empty-state copy ("Start a cycle count from the web") to mention you can now start one here.
- [ ] **Step 2:** Manual.
- [ ] **Step 3: Commit.** `git commit -m "feat(mobile): start cycle count from the Counts tab"`

---

## Phase 4 — Verify & ship

- [ ] Web: `cd apps/web && npx tsc --noEmit && npx vitest run && npx eslint .`
- [ ] Manual web acceptance per spec criteria 1–4 and 6.
- [ ] Mobile: typecheck; run on simulator for criteria 5; then `eas build` + `eas submit` (Xcode-26 image, Node pinned per `reference_eas_build_xcode26_sharp_gotchas`).
- [ ] `git push origin main`.

---

## Self-review

- **Spec coverage:** data model (T1), service+security+notify (T2), action (T3), mobile API (T4), web store (T5), books selection (T6), inventory action (T7), confirm page (T8), mobile store/select/confirm/＋ (T9–T12), verification (P4). PDF fix shipped (Phase 0). ✓
- **Type consistency:** `start()` returns `{id,lineCount,skipped}` (T2) and action/route/UI all consume `skipped` (T3,T4,T8). Store `CountPick` shape `{id,sku,name,itemType}` consistent across T5–T11. ✓
- **Placeholders:** UI tasks (T6–T12) modify large existing files; steps give exact files, insert anchors, and the key code rather than reproducing whole components — acceptable for modifications. ✓
