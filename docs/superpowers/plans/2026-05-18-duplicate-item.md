# Duplicate Item / Book Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click Duplicate button on the item-detail page that copies an item/book to a new physical location (rack + crate), preserving everything else.

**Architecture:** New Postgres RPC `duplicate_inventory_item(uuid, jsonb)` runs the atomic copy (item row + tags + image rows + optional initial stock movement). New `InventoryService.duplicateItem()` wraps the RPC, emits audit. New server action + zod schemas drive a new `DuplicateItemDialog` modal mounted next to the existing Edit button on item-detail. Item-picker option label on order-new page gains a `· Rack X · N on hand` suffix so duplicates are distinguishable.

**Tech Stack:** Postgres 15 + Supabase, Next.js 16 App Router, Server Actions, zod, shadcn/ui Dialog, vitest, @stockpilot/core monorepo package.

**Spec:** `docs/superpowers/specs/2026-05-18-duplicate-item-design.md`

---

## File Structure

### Create
- `supabase/migrations/0125_duplicate_inventory_item.sql` — RPC + grant
- `packages/core/src/schemas/duplicate-item.ts` — zod schemas (items + books variants)
- `apps/web/src/server/services/inventory.duplicate.test.ts` — unit/integration tests
- `apps/web/src/server/actions/duplicate-item.ts` — server action
- `apps/web/src/components/inventory/duplicate-item-dialog.tsx` — modal component

### Modify
- `packages/core/src/schemas/index.ts` — re-export duplicate-item schemas
- `apps/web/src/server/services/inventory.ts` — add `duplicateItem(originalId, overrides)`
- `apps/web/src/components/inventory/item-detail.tsx` — add Duplicate button next to Edit
- `apps/web/src/app/(dashboard)/dashboard/orders/new/page.tsx` — extend `loadOrderableItems` to also fetch `custom_fields` so the rack label can be shown
- `apps/web/src/components/orders/order-request-form.tsx` — extend `OrderItemOption` with `rackLabel`, render `· Rack X` after SKU

---

## Task 1: Migration — `duplicate_inventory_item` RPC

**Files:**
- Create: `supabase/migrations/0125_duplicate_inventory_item.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0125_duplicate_inventory_item.sql
-- Adds duplicate_inventory_item(p_original_id uuid, p_overrides jsonb)
-- which clones an inventory_items row to a new physical location.
--
-- Overrides JSON shape:
--   {
--     "sku":              text,         -- pre-computed by caller (suffixed)
--     "quantity":         numeric,      -- default 0
--     "rack_number":      text,         -- items branch
--     "rack_row":         text|null,    -- items branch (optional)
--     "book_rack_number": text,         -- books branch
--     "book_rack_row":    text|null,    -- books branch (optional)
--     "book_crate_color": text,         -- books branch
--     "book_crate_number":text,         -- books branch
--     "bin_location":     text          -- pre-rendered label
--   }
--
-- Returns: the new item's id.
--
-- Atomicity: item insert + item_tags copy + item_images copy + optional
-- stock_movements row all run inside the implicit RPC transaction. Any
-- failure rolls back. SKU uniqueness is enforced by the existing
-- (organization_id, sku) constraint; we surface 23505 as a friendly
-- error code so the action layer can translate it.

create or replace function public.duplicate_inventory_item(
  p_original_id uuid,
  p_overrides   jsonb
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_new_id uuid := gen_random_uuid();
  v_original public.inventory_items%rowtype;
  v_qty numeric := coalesce((p_overrides->>'quantity')::numeric, 0);
  v_new_sku text := nullif(p_overrides->>'sku', '');
  v_new_bin text := nullif(p_overrides->>'bin_location', '');
  v_new_cf jsonb;
  v_uid uuid := auth.uid();
begin
  -- Load + lock the original row. RLS scopes this to the caller's
  -- accessible warehouses, so a cross-warehouse caller hits not-found
  -- here rather than ever reading the source row.
  select * into v_original
  from public.inventory_items
  where id = p_original_id and deleted_at is null
  for share;

  if not found then
    raise exception 'original_not_found' using errcode = 'P0002';
  end if;
  if v_new_sku is null then
    raise exception 'sku_required' using errcode = '22023';
  end if;

  -- Compose custom_fields: copy original blob, then overwrite the
  -- location keys (items vs books branch).
  v_new_cf := coalesce(v_original.custom_fields, '{}'::jsonb);
  if v_original.item_type = 'book' then
    v_new_cf := (v_new_cf
                 - 'book_rack_number'
                 - 'book_rack_row'
                 - 'book_crate_color'
                 - 'book_crate_number')
                || jsonb_strip_nulls(jsonb_build_object(
                     'book_rack_number',  p_overrides->>'book_rack_number',
                     'book_rack_row',     p_overrides->>'book_rack_row',
                     'book_crate_color',  p_overrides->>'book_crate_color',
                     'book_crate_number', p_overrides->>'book_crate_number'
                   ));
  else
    v_new_cf := (v_new_cf - 'rack_number' - 'rack_row')
                || jsonb_strip_nulls(jsonb_build_object(
                     'rack_number', p_overrides->>'rack_number',
                     'rack_row',    p_overrides->>'rack_row'
                   ));
  end if;

  insert into public.inventory_items (
    id, organization_id, warehouse_id, charter_id, sku, barcode,
    name, description, category_id, supplier_id, primary_location_id,
    unit_cost, retail_price, quantity_on_hand, reorder_point,
    reorder_quantity, unit_of_measure, bin_location, tracking_type,
    item_type, custom_fields, status, created_by, updated_by
  ) values (
    v_new_id, v_original.organization_id, v_original.warehouse_id,
    v_original.charter_id, v_new_sku, v_original.barcode,
    v_original.name, v_original.description, v_original.category_id,
    v_original.supplier_id, v_original.primary_location_id,
    v_original.unit_cost, v_original.retail_price, v_qty,
    v_original.reorder_point, v_original.reorder_quantity,
    v_original.unit_of_measure, v_new_bin, v_original.tracking_type,
    v_original.item_type, v_new_cf, v_original.status, v_uid, v_uid
  );

  -- item_tags: parallel rows for every original tag.
  insert into public.item_tags (item_id, tag_id)
  select v_new_id, tag_id
  from public.item_tags
  where item_id = p_original_id;

  -- item_images: parallel rows pointing at the SAME storage_path / thumb.
  insert into public.item_images (
    organization_id, item_id, storage_path, thumb_path, lqip,
    alt, sort_order, is_primary
  )
  select v_original.organization_id, v_new_id, storage_path, thumb_path,
         lqip, alt, sort_order, is_primary
  from public.item_images
  where item_id = p_original_id;

  -- Initial stock movement when qty > 0 so the ledger + dashboard
  -- sparklines see the new on-hand value.
  if v_qty > 0 then
    insert into public.stock_movements (
      organization_id, item_id, movement_type, quantity_change,
      previous_quantity, new_quantity, user_id, to_location_id, reason
    ) values (
      v_original.organization_id, v_new_id, 'initial', v_qty,
      0, v_qty, v_uid, v_original.primary_location_id,
      'duplicate_initial_count'
    );
  end if;

  return v_new_id;
end;
$$;

revoke all on function public.duplicate_inventory_item(uuid, jsonb) from public;
revoke all on function public.duplicate_inventory_item(uuid, jsonb) from anon;
grant execute on function public.duplicate_inventory_item(uuid, jsonb) to authenticated;
```

- [ ] **Step 2: Apply the migration locally**

Run: `supabase db reset` (or `supabase migration up` if you don't want a full reset)
Expected: migration applied, no errors.

- [ ] **Step 3: Sanity-check the function exists**

Run:
```bash
supabase db diff --schema public --linked | grep duplicate_inventory_item || echo "ok: not in diff"
psql "$(supabase status -o env | awk -F= '/^DB_URL/{print $2}' | tr -d '\"')" -c "\df public.duplicate_inventory_item"
```
Expected: function listed.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0125_duplicate_inventory_item.sql
git commit -m "feat(db): duplicate_inventory_item RPC

Clones an inventory_items row to a new physical location (rack + crate)
in a single transaction. Copies item row + item_tags + item_images (same
storage_path — no bytes duplicated). Optional initial stock_movements
row when qty > 0."
```

---

## Task 2: Zod schemas in `@stockpilot/core`

**Files:**
- Create: `packages/core/src/schemas/duplicate-item.ts`
- Modify: `packages/core/src/schemas/index.ts`

- [ ] **Step 1: Write the schema file**

```typescript
// packages/core/src/schemas/duplicate-item.ts
import { z } from 'zod';

const trimmedNonEmpty = z
  .string()
  .trim()
  .min(1, 'Required')
  .max(40, 'Too long');

const optionalTrimmed = z
  .string()
  .trim()
  .max(40, 'Too long')
  .optional()
  .nullable();

const quantitySchema = z
  .number()
  .int('Whole numbers only')
  .min(0, 'Must be 0 or more')
  .max(1_000_000, 'Too large');

export const duplicateItemAsProductSchema = z.object({
  originalId: z.string().uuid(),
  itemType: z.literal('product'),
  rackNumber: trimmedNonEmpty,
  rackRow: optionalTrimmed,
  quantity: quantitySchema,
});

export const duplicateItemAsBookSchema = z.object({
  originalId: z.string().uuid(),
  itemType: z.literal('book'),
  rackNumber: trimmedNonEmpty,
  rackRow: optionalTrimmed,
  crateColor: trimmedNonEmpty,
  crateNumber: trimmedNonEmpty,
  quantity: quantitySchema,
});

export const duplicateItemSchema = z.discriminatedUnion('itemType', [
  duplicateItemAsProductSchema,
  duplicateItemAsBookSchema,
]);

export type DuplicateItemInput = z.infer<typeof duplicateItemSchema>;
export type DuplicateItemProductInput = z.infer<typeof duplicateItemAsProductSchema>;
export type DuplicateItemBookInput = z.infer<typeof duplicateItemAsBookSchema>;
```

- [ ] **Step 2: Re-export from the schemas index**

Open `packages/core/src/schemas/index.ts`. At the end of the file add:

```typescript
export * from './duplicate-item';
```

- [ ] **Step 3: Verify compile + exports**

Run: `pnpm -F @stockpilot/core build`
Expected: build succeeds. If the package uses tsc + tsup or similar, both pass.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/schemas/duplicate-item.ts packages/core/src/schemas/index.ts
git commit -m "feat(core): duplicateItem zod schemas (product + book variants)"
```

---

## Task 3: `InventoryService.duplicateItem` — failing test first

**Files:**
- Create: `apps/web/src/server/services/inventory.duplicate.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/src/server/services/inventory.duplicate.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./context', () => ({
  withContext: vi.fn(),
  ServiceError: class extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  },
  assertPermission: vi.fn(),
  assertPlanLimit: vi.fn(),
}));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [] })),
  forcedWarehouseId: vi.fn(async () => null),
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class extends Error {},
}));
vi.mock('./audit', () => ({
  audit: vi.fn(async () => undefined),
}));

import { InventoryService } from './inventory';

function makeCtx(rpcImpl: (name: string, args: Record<string, unknown>) => unknown, opts?: {
  existingSkus?: Set<string>;
  originalSku?: string;
}) {
  const existingSkus = opts?.existingSkus ?? new Set<string>();
  const originalSku = opts?.originalSku ?? 'SP-ABC';
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const supabase = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      const data = await rpcImpl(name, args);
      return { data, error: null };
    }),
    from(table: string) {
      if (table === 'inventory_items') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { sku: originalSku }, error: null }),
                in: (_col: string, skus: string[]) => ({
                  then: (cb: (v: { data: Array<{ sku: string }>; error: null }) => void) =>
                    cb({
                      data: skus.filter((s) => existingSkus.has(s)).map((s) => ({ sku: s })),
                      error: null,
                    }),
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown;
  return {
    ctx: {
      supabase,
      organizationId: 'org-1',
      userId: 'user-1',
      role: 'admin',
    } as unknown as ConstructorParameters<typeof InventoryService>[0],
    rpcCalls,
  };
}

describe('InventoryService.duplicateItem', () => {
  beforeEach(() => vi.clearAllMocks());

  it('suffixes the SKU and calls duplicate_inventory_item RPC', async () => {
    const { ctx, rpcCalls } = makeCtx(async () => 'new-item-id', {
      existingSkus: new Set(),
      originalSku: 'SP-ABC',
    });
    const svc = new InventoryService(ctx);
    const newId = await svc.duplicateItem({
      originalId: '00000000-0000-0000-0000-000000000001',
      itemType: 'product',
      rackNumber: '38',
      rackRow: 'A',
      quantity: 5,
    });
    expect(newId).toBe('new-item-id');
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].name).toBe('duplicate_inventory_item');
    expect(rpcCalls[0].args.p_original_id).toBe('00000000-0000-0000-0000-000000000001');
    const overrides = rpcCalls[0].args.p_overrides as Record<string, unknown>;
    expect(overrides.sku).toBe('SP-ABC-2');
    expect(overrides.quantity).toBe(5);
    expect(overrides.rack_number).toBe('38');
    expect(overrides.rack_row).toBe('A');
    expect(overrides.bin_location).toBe('38-A');
  });

  it('bumps suffix past collisions until -99, then throws', async () => {
    // -2 and -3 are taken; -4 should be chosen.
    const { ctx, rpcCalls } = makeCtx(async () => 'new-id', {
      existingSkus: new Set(['SP-ABC-2', 'SP-ABC-3']),
      originalSku: 'SP-ABC',
    });
    const svc = new InventoryService(ctx);
    await svc.duplicateItem({
      originalId: '00000000-0000-0000-0000-000000000001',
      itemType: 'product',
      rackNumber: '38',
      rackRow: null,
      quantity: 0,
    });
    expect((rpcCalls[0].args.p_overrides as { sku: string }).sku).toBe('SP-ABC-4');
  });

  it('throws too_many_duplicates when -2..-99 are all taken', async () => {
    const all = new Set<string>();
    for (let i = 2; i <= 99; i += 1) all.add(`SP-ABC-${i}`);
    const { ctx } = makeCtx(async () => 'new-id', {
      existingSkus: all,
      originalSku: 'SP-ABC',
    });
    const svc = new InventoryService(ctx);
    await expect(
      svc.duplicateItem({
        originalId: '00000000-0000-0000-0000-000000000001',
        itemType: 'product',
        rackNumber: '38',
        rackRow: null,
        quantity: 0,
      }),
    ).rejects.toThrow(/too_many_duplicates|conflict/);
  });

  it('book branch sends crate fields and book_ bin label', async () => {
    const { ctx, rpcCalls } = makeCtx(async () => 'new-id', {
      existingSkus: new Set(),
      originalSku: 'BK-XYZ',
    });
    const svc = new InventoryService(ctx);
    await svc.duplicateItem({
      originalId: '00000000-0000-0000-0000-000000000002',
      itemType: 'book',
      rackNumber: '12',
      rackRow: 'C',
      crateColor: 'red',
      crateNumber: '4',
      quantity: 0,
    });
    const overrides = rpcCalls[0].args.p_overrides as Record<string, unknown>;
    expect(overrides.book_rack_number).toBe('12');
    expect(overrides.book_rack_row).toBe('C');
    expect(overrides.book_crate_color).toBe('red');
    expect(overrides.book_crate_number).toBe('4');
    expect(overrides.bin_location).toBe('12-C · red4');
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `pnpm -F @stockpilot/web vitest run apps/web/src/server/services/inventory.duplicate.test.ts`
Expected: FAIL with "svc.duplicateItem is not a function".

- [ ] **Step 3: Commit failing test**

```bash
git add apps/web/src/server/services/inventory.duplicate.test.ts
git commit -m "test(inventory): failing tests for duplicateItem service method"
```

---

## Task 4: Implement `InventoryService.duplicateItem`

**Files:**
- Modify: `apps/web/src/server/services/inventory.ts`

- [ ] **Step 1: Import the schema types at the top of the file**

Find the existing `@stockpilot/core` import in `apps/web/src/server/services/inventory.ts` (around lines 1–30). Add to the named-import list:

```typescript
import type { DuplicateItemInput } from '@stockpilot/core';
```

(If `@stockpilot/core` is already imported with a destructured type list, add `DuplicateItemInput` to that list rather than adding a second import.)

- [ ] **Step 2: Add the `duplicateItem` method to `InventoryService`**

Inside the `InventoryService` class (defined at `inventory.ts:132`), immediately after the `async create(...)` method (which ends around line 589), insert:

```typescript
  /**
   * Clone an existing item to a new physical location. Pre-computes a
   * unique SKU by suffixing the original (-2, -3, …, -99), then calls
   * the duplicate_inventory_item RPC which atomically inserts the item
   * row + tag rows + image rows + optional initial movement.
   *
   * Why we compute the SKU here (vs in-RPC):
   *   - We already scope to organization_id via Supabase client, so the
   *     collision query is RLS-safe.
   *   - Keeping retry logic in TS lets us throw a typed ServiceError
   *     ('too_many_duplicates') instead of a generic 23505.
   */
  async duplicateItem(input: DuplicateItemInput): Promise<string> {
    assertPermission(this.ctx, 'items:create');

    // Load the original SKU so we can compute the suffix.
    const { data: original, error: origErr } = await this.ctx.supabase
      .from('inventory_items')
      .select('sku')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', input.originalId)
      .maybeSingle();
    if (origErr || !original) {
      throw new ServiceError('not_found', 'Original item no longer exists.');
    }

    // Build candidate suffix list -2 through -99.
    const baseSku = (original as { sku: string }).sku;
    const candidates: string[] = [];
    for (let i = 2; i <= 99; i += 1) candidates.push(`${baseSku}-${i}`);

    // Single round-trip: pull any taken candidates.
    const { data: taken } = await this.ctx.supabase
      .from('inventory_items')
      .select('sku')
      .eq('organization_id', this.ctx.organizationId)
      .in('sku', candidates);
    const takenSet = new Set(((taken ?? []) as Array<{ sku: string }>).map((r) => r.sku));
    const newSku = candidates.find((c) => !takenSet.has(c));
    if (!newSku) {
      throw new ServiceError(
        'too_many_duplicates',
        'Too many duplicates of this SKU — please rename the original.',
      );
    }

    // Compose bin_location label + RPC overrides per branch.
    const overrides: Record<string, unknown> = {
      sku: newSku,
      quantity: input.quantity,
    };
    if (input.itemType === 'book') {
      const rackLabel = input.rackRow
        ? `${input.rackNumber}-${input.rackRow}`
        : input.rackNumber;
      overrides.book_rack_number = input.rackNumber;
      overrides.book_rack_row = input.rackRow ?? null;
      overrides.book_crate_color = input.crateColor;
      overrides.book_crate_number = input.crateNumber;
      overrides.bin_location = `${rackLabel} · ${input.crateColor}${input.crateNumber}`;
    } else {
      const rackLabel = input.rackRow
        ? `${input.rackNumber}-${input.rackRow}`
        : input.rackNumber;
      overrides.rack_number = input.rackNumber;
      overrides.rack_row = input.rackRow ?? null;
      overrides.bin_location = rackLabel;
    }

    const { data: newId, error: rpcErr } = await this.ctx.supabase.rpc(
      'duplicate_inventory_item',
      { p_original_id: input.originalId, p_overrides: overrides },
    );
    if (rpcErr) {
      if (rpcErr.code === 'P0002') {
        throw new ServiceError('not_found', 'Original item no longer exists.');
      }
      if (rpcErr.code === '23505') {
        throw new ServiceError(
          'conflict',
          'A different request just used that SKU — please retry.',
        );
      }
      throw new ServiceError('internal_error', rpcErr.message);
    }

    void audit(
      {
        event: 'inventory.item.duplicated',
        entityType: 'inventory_item',
        entityId: newId as string,
        extra: { source_item_id: input.originalId, sku_suffix_used: newSku },
      },
      this.ctx,
    );

    return newId as string;
  }
```

- [ ] **Step 3: Run the tests**

Run: `pnpm -F @stockpilot/web vitest run apps/web/src/server/services/inventory.duplicate.test.ts`
Expected: all 4 tests PASS.

- [ ] **Step 4: Run the broader inventory test suite to make sure nothing else broke**

Run: `pnpm -F @stockpilot/web vitest run apps/web/src/server/services/inventory`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/services/inventory.ts
git commit -m "feat(inventory): InventoryService.duplicateItem

Pre-computes a -N suffixed SKU (up to -99), then calls the
duplicate_inventory_item RPC. Emits inventory.item.duplicated audit
event with source_item_id + new sku for traceability."
```

---

## Task 5: Server action

**Files:**
- Create: `apps/web/src/server/actions/duplicate-item.ts`

- [ ] **Step 1: Write the action**

```typescript
// apps/web/src/server/actions/duplicate-item.ts
'use server';

import { revalidatePath } from 'next/cache';

import { ServiceError } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';

import {
  duplicateItemSchema,
  err,
  ok,
  type ActionResult,
  type DuplicateItemInput,
} from '@stockpilot/core';

export async function duplicateItemAction(
  input: DuplicateItemInput,
): Promise<ActionResult<{ id: string }>> {
  const parsed = duplicateItemSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await InventoryService.forCurrentUser();
    const id = await svc.duplicateItem(parsed.data);
    revalidatePath('/dashboard');
    revalidatePath('/dashboard/inventory');
    revalidatePath('/dashboard/books');
    revalidatePath(`/dashboard/inventory/${parsed.data.originalId}`);
    return ok({ id });
  } catch (error) {
    if (error instanceof ServiceError) {
      return err(error.code, error.message);
    }
    console.error(error);
    return err('internal_error', error instanceof Error ? error.message : 'Unknown error');
  }
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `pnpm -F @stockpilot/web tsc --noEmit --pretty false 2>&1 | grep "duplicate-item" || echo "ok"`
Expected: `ok` (no type errors in the new file).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/server/actions/duplicate-item.ts
git commit -m "feat(inventory): duplicateItemAction server action"
```

---

## Task 6: `DuplicateItemDialog` component

**Files:**
- Create: `apps/web/src/components/inventory/duplicate-item-dialog.tsx`

- [ ] **Step 1: Write the component**

```typescript
// apps/web/src/components/inventory/duplicate-item-dialog.tsx
'use client';

import { Copy } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { duplicateItemAction } from '@/server/actions/duplicate-item';

interface Props {
  itemId: string;
  itemName: string;
  itemType: 'book' | 'product' | string | null;
}

/**
 * Modal launched by the "Duplicate" button on item-detail.
 * Pre-fills nothing visible (everything is inherited from the
 * original); user only enters the new physical location. On success,
 * redirects to the new item's detail page.
 */
export function DuplicateItemDialog({ itemId, itemName, itemType }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const isBook = itemType === 'book';

  const [rackNumber, setRackNumber] = useState('');
  const [rackRow, setRackRow] = useState('');
  const [crateColor, setCrateColor] = useState('');
  const [crateNumber, setCrateNumber] = useState('');
  const [quantity, setQuantity] = useState('0');

  function reset() {
    setRackNumber('');
    setRackRow('');
    setCrateColor('');
    setCrateNumber('');
    setQuantity('0');
  }

  function submit() {
    const qty = Number.parseInt(quantity, 10);
    if (Number.isNaN(qty) || qty < 0) {
      toast.error('Quantity must be 0 or more.');
      return;
    }
    if (!rackNumber.trim()) {
      toast.error('Rack number is required.');
      return;
    }
    if (isBook && (!crateColor.trim() || !crateNumber.trim())) {
      toast.error('Crate color and number are required for books.');
      return;
    }

    startTransition(async () => {
      const input = isBook
        ? {
            originalId: itemId,
            itemType: 'book' as const,
            rackNumber: rackNumber.trim(),
            rackRow: rackRow.trim() || null,
            crateColor: crateColor.trim(),
            crateNumber: crateNumber.trim(),
            quantity: qty,
          }
        : {
            originalId: itemId,
            itemType: 'product' as const,
            rackNumber: rackNumber.trim(),
            rackRow: rackRow.trim() || null,
            quantity: qty,
          };
      const result = await duplicateItemAction(input);
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      toast.success(`Duplicated "${itemName}"`);
      setOpen(false);
      reset();
      router.push(`/dashboard/inventory/${result.data.id}`);
      router.refresh();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="sm:size-auto">
          <Copy className="h-4 w-4" /> Duplicate
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Duplicate {isBook ? 'book' : 'item'}</DialogTitle>
          <DialogDescription>
            Creates a second row of &ldquo;{itemName}&rdquo; at a new physical
            location. Everything else (name, SKU base, cost, photo, tags,
            category) is copied automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="dup-rack-number">Rack number</Label>
              <Input
                id="dup-rack-number"
                value={rackNumber}
                onChange={(e) => setRackNumber(e.target.value)}
                placeholder="38"
                disabled={pending}
                autoFocus
              />
            </div>
            <div>
              <Label htmlFor="dup-rack-row">Row (optional)</Label>
              <Input
                id="dup-rack-row"
                value={rackRow}
                onChange={(e) => setRackRow(e.target.value)}
                placeholder="A"
                disabled={pending}
              />
            </div>
          </div>

          {isBook && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="dup-crate-color">Crate color</Label>
                <Input
                  id="dup-crate-color"
                  value={crateColor}
                  onChange={(e) => setCrateColor(e.target.value)}
                  placeholder="red"
                  disabled={pending}
                />
              </div>
              <div>
                <Label htmlFor="dup-crate-number">Crate number</Label>
                <Input
                  id="dup-crate-number"
                  value={crateNumber}
                  onChange={(e) => setCrateNumber(e.target.value)}
                  placeholder="4"
                  disabled={pending}
                />
              </div>
            </div>
          )}

          <div>
            <Label htmlFor="dup-quantity">Quantity at this rack</Label>
            <Input
              id="dup-quantity"
              type="number"
              inputMode="numeric"
              min={0}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              disabled={pending}
            />
            <p className="text-muted-foreground mt-1 text-xs">
              Defaults to 0. Set the actual on-hand count at the new rack.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? 'Duplicating…' : 'Duplicate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Verify the imports resolve**

Run: `pnpm -F @stockpilot/web tsc --noEmit --pretty false 2>&1 | grep "duplicate-item-dialog" || echo "ok"`
Expected: `ok`.

If a UI primitive (`Dialog`, `Input`, `Label`) isn't where the imports point, replace each path with the project's actual one — they all live under `@/components/ui/`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/inventory/duplicate-item-dialog.tsx
git commit -m "feat(inventory): DuplicateItemDialog modal component"
```

---

## Task 7: Wire the Duplicate button into item-detail

**Files:**
- Modify: `apps/web/src/components/inventory/item-detail.tsx`

- [ ] **Step 1: Add the import**

At the top of `apps/web/src/components/inventory/item-detail.tsx`, with the other component imports, add:

```typescript
import { DuplicateItemDialog } from '@/components/inventory/duplicate-item-dialog';
```

- [ ] **Step 2: Add the permission flag**

Near the existing `canEditItem` declaration (around line 137), add a new line:

```typescript
const canDuplicateItem = hasPermission(ctx.role, 'items:create');
```

- [ ] **Step 3: Add the button next to Edit**

Find the existing Edit button block (around lines 186–198 in `item-detail.tsx`). Immediately AFTER the closing `})()}` of the Edit button block, insert:

```typescript
              {canDuplicateItem && (
                <DuplicateItemDialog
                  itemId={id}
                  itemName={item.name as string}
                  itemType={(item.item_type as string | null) ?? null}
                />
              )}
```

- [ ] **Step 4: Visual smoke test in the dev server**

Run: `pnpm -F @stockpilot/web dev` (in another terminal)
Open `/dashboard/inventory/<any-item-id>`.
Expected: a "Duplicate" button appears next to "Edit". Click it; dialog opens. Cancel; dialog closes.

(If you can't run the dev server in this environment, skip the visual check — type-check is sufficient.)

- [ ] **Step 5: Run a full type-check**

Run: `pnpm -F @stockpilot/web tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/inventory/item-detail.tsx
git commit -m "feat(inventory): mount Duplicate button on item-detail toolbar"
```

---

## Task 8: End-to-end manual test against local Supabase

**No files modified.** This task verifies the full feature against real Postgres.

- [ ] **Step 1: Reset local Supabase**

Run: `supabase db reset`
Expected: migrations apply cleanly, including 0125.

- [ ] **Step 2: Open dev server**

Run: `pnpm -F @stockpilot/web dev`
Then visit `/dashboard/inventory` and pick any item with a photo.

- [ ] **Step 3: Duplicate a product item**

- Click Duplicate
- Enter rack number `99`, row `Z`, quantity `3`
- Click Duplicate
- Expected:
  - Redirect to the new item's detail page
  - SKU shown is `<original-sku>-2` (or next free `-N`)
  - Quantity shown is `3`
  - Bin location shown as `99-Z`
  - Photo identical to original (same storage_path)
  - Tags identical to original

- [ ] **Step 4: Duplicate a book**

- Open a book from `/dashboard/books`
- Click Duplicate
- Enter rack `12`, row `C`, crate color `red`, crate `4`, quantity `0`
- Expected:
  - Bin location shown as `12-C · red4`
  - `custom_fields.book_rack_*` + `book_crate_*` populated correctly (verify in DB if curious)

- [ ] **Step 5: Verify ledger entry**

Run:
```bash
psql "$(supabase status -o env | awk -F= '/^DB_URL/{print $2}' | tr -d '\"')" \
  -c "select item_id, movement_type, quantity_change, reason from stock_movements where reason = 'duplicate_initial_count' order by created_at desc limit 5;"
```
Expected: one row per non-zero-quantity duplicate.

- [ ] **Step 6: Stop the dev server, no commit needed**

---

## Task 9: Show rack label on order-new item picker — failing inspection

**Files:**
- Modify: `apps/web/src/components/orders/order-request-form.tsx`
- Modify: `apps/web/src/app/(dashboard)/dashboard/orders/new/page.tsx`

- [ ] **Step 1: Extend `OrderItemOption` in the form**

In `apps/web/src/components/orders/order-request-form.tsx`, extend the interface at line 33:

```typescript
export interface OrderItemOption {
  id: string;
  name: string;
  sku: string;
  warehouseId: string;
  quantityOnHand: number;
  reservedQuantity: number;
  itemType: string | null;
  /** Pre-rendered rack label (e.g. "38-A" or "12-C · red4"). null when
      the item has no rack assigned — duplicates with rack info will show
      this in the picker so the user can pick the right one. */
  rackLabel: string | null;
}
```

- [ ] **Step 2: Render the rack label in the option row**

Find the option row around lines 502–508 (the `<div>` containing `it.name` and `it.sku`). Replace the inner SKU `<div>` with one that conditionally appends the rack label:

```typescript
                      <div className="text-muted-foreground truncate font-mono text-[11px]">
                        {it.sku}
                        {it.rackLabel ? (
                          <span className="ml-2 inline-block font-sans text-muted-foreground">
                            · Rack {it.rackLabel}
                          </span>
                        ) : null}
                      </div>
```

- [ ] **Step 3: Populate `rackLabel` from the page loader**

Open `apps/web/src/app/(dashboard)/dashboard/orders/new/page.tsx`. Find the `loadOrderableItems` function (starts at line 117). Make two edits:

1. Extend the `.select(...)` column list at line 129 to include `custom_fields, bin_location`:

```typescript
    .select('id, name, sku, quantity_on_hand, warehouse_id, item_type, is_bundle, custom_fields, bin_location')
```

2. Extend the typed-array cast at lines 138–145 and the final map at lines 167–175. The casts and map should read:

```typescript
  const items = (itemsData ?? []) as Array<{
    id: string;
    name: string;
    sku: string;
    quantity_on_hand: number;
    warehouse_id: string;
    item_type: string | null;
    custom_fields: Record<string, unknown> | null;
    bin_location: string | null;
  }>;
  if (items.length === 0) return [];

  // ... existing reservation lookup unchanged ...

  function rackLabelFor(it: typeof items[number]): string | null {
    // bin_location is the authoritative pre-rendered label set on save.
    if (it.bin_location && it.bin_location.trim()) return it.bin_location.trim();
    const cf = it.custom_fields ?? {};
    const num = (it.item_type === 'book'
      ? (cf as { book_rack_number?: unknown }).book_rack_number
      : (cf as { rack_number?: unknown }).rack_number) as string | undefined;
    const row = (it.item_type === 'book'
      ? (cf as { book_rack_row?: unknown }).book_rack_row
      : (cf as { rack_row?: unknown }).rack_row) as string | undefined;
    if (!num) return null;
    return row ? `${num}-${row}` : String(num);
  }

  return items.map((it) => ({
    id: it.id,
    name: it.name,
    sku: it.sku,
    warehouseId: it.warehouse_id,
    quantityOnHand: Number(it.quantity_on_hand) || 0,
    reservedQuantity: reservedByItem.get(it.id) ?? 0,
    itemType: it.item_type ?? null,
    rackLabel: rackLabelFor(it),
  }));
```

- [ ] **Step 4: Type-check + run vitest**

Run: `pnpm -F @stockpilot/web tsc --noEmit`
Expected: no errors.

Run: `pnpm -F @stockpilot/web vitest run`
Expected: all green (no existing test exercises the picker option label, so this is just a regression sweep).

- [ ] **Step 5: Manual smoke test**

Boot the dev server, visit `/dashboard/orders/new`, pick a warehouse that has at least one duplicated item, and confirm the picker shows two rows for the same SKU — each with its own `· Rack X` suffix.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/orders/order-request-form.tsx apps/web/src/app/\(dashboard\)/dashboard/orders/new/page.tsx
git commit -m "feat(orders): show rack label in item picker for disambiguation

Duplicated items share name + SKU base but differ by rack. The picker
now surfaces each row's bin_location (or derived rack label from
custom_fields) so the requester can pick the right physical row."
```

---

## Task 10: Final verification + push

- [ ] **Step 1: Run the full test suite**

Run: `pnpm -F @stockpilot/web vitest run`
Expected: all green.

- [ ] **Step 2: Run lint + type-check**

Run: `pnpm -F @stockpilot/web lint && pnpm -F @stockpilot/web tsc --noEmit`
Expected: no errors, no warnings on the new files.

- [ ] **Step 3: Check pnpm-lock.yaml is unchanged**

Run: `git status pnpm-lock.yaml`
Expected: clean (we added no dependencies).

- [ ] **Step 4: Push**

Run: `git push`
Expected: clean push to `main`.

- [ ] **Step 5: Apply the migration to production**

The user applies migrations manually. Notify them:
> "Migration 0125 (duplicate_inventory_item) is ready to apply in the Supabase dashboard SQL editor or via `supabase db push`."

---

## Self-Review Notes

**Spec coverage:**
- UX → Task 6 (modal) + Task 7 (mount)
- SKU auto-suffix → Task 4
- Items/books field split → Task 2 (schemas), Task 4 (service), Task 6 (modal)
- Custom_fields merge → Task 1 (RPC)
- item_tags + item_images copy → Task 1
- Atomic transaction → Task 1
- Initial stock movement → Task 1
- Audit emit → Task 4
- Permission gate (`items:create`) → Task 4 + Task 7
- Order picker rack label → Task 9
- Edge cases (original deleted, SKU exhausted) → Tasks 3 + 4
- Manual E2E → Task 8

**Note on books "crate color" allowed values:** the schema uses a free-text validated string (max 40 chars). If the codebase has a canonical enum for crate color elsewhere, the implementer should swap `trimmedNonEmpty` for that enum and import it in `duplicate-item.ts`. This is a minor refinement, not a blocker.

**Note on soft warning for same-rack duplicate:** spec says "soft inline warning if rack already has same SKU." This is **deferred** out of the plan — it requires either a live lookup as the user types (extra query) or pre-loading rack inventory into the dialog. Ship the modal first; add the warning as a follow-up if the user finds duplicates landing on the wrong rack in practice.
