# Phase 3 — UoM Conversions + Lot/Serial Tracking Implementation Plan

> **For agentic workers:** Architecture-level. Expand each task to TDD step-by-step detail before execution.

**Goal:** Make receiving correctly handle vendor pack/box/carton UoMs (e.g. `1 PK = 24 EA`) and track lot/serial numbers per receipt line so receiving a `lot`-tracked or `serial`-tracked item requires the operator to capture the lot/serial.

**Architecture:**
- New `uom_conversions` table: per-item conversion factors. `(item_id, from_uom, to_uom)` with a numerator/denominator (rational, no floats). Admin UI to manage.
- New `inventory_items.tracking_type` enum: `none | lot | serial`. Default `none`. Admin UI to set.
- New `receipt_line_lots` (lot-tracked) and `serial_registry` (serial-tracked) tables. Tied to `receipt_lines.id`.
- Receiving form expands: when a receipt line's item has `tracking_type='lot'`, show lot-number + expiry inputs (one or more rows summing to qty_accepted). When `tracking_type='serial'`, show serial-number inputs (one per accepted unit).
- `post_receipt_v2` RPC extended to also insert `receipt_line_lots` and `serial_registry` rows transactionally, with validation.
- Vendor item mappings extended: `pack_qty` and `vendor_uom` already exist on `vendor_item_mappings` (Phase 1, table created). Phase 3 wires these into the receiving conversion path so receiving a PO line in `PK` automatically suggests `qty_accepted_base = qty_accepted * pack_qty`.

**Tech Stack:** Same as Phases 1-2. Adds rational-number arithmetic for conversion (avoid float drift via integer math + decimal columns).

---

## File structure

### New files

```
supabase/migrations/
  0014_uom_conversions.sql        # uom_conversions table + RPC convert_uom
  0015_lot_serial_tracking.sql    # tracking_type, receipt_line_lots, serial_registry

packages/core/src/schemas/
  uom-conversions.ts              # createUomConversionSchema + types
  lot-serial.ts                   # lotEntrySchema, serialEntrySchema

apps/web/src/lib/uom/
  convert.ts                      # convert(qty, from, to, conversions): { qtyBase } pure function
  convert.test.ts

apps/web/src/server/services/
  uom-conversions.ts              # UomConversionsService: list, upsert, delete
  uom-conversions.test.ts

apps/web/src/server/actions/
  uom-conversions.ts

apps/web/src/components/receiving/
  lot-capture.tsx                 # row repeater for lots
  serial-capture.tsx              # row repeater for serials

apps/web/src/components/admin/
  uom-conversions-manager.tsx
  item-tracking-editor.tsx        # popover on item edit page to set tracking_type

apps/web/src/app/(dashboard)/dashboard/admin/
  uom-conversions/
    page.tsx
```

### Modified files

```
supabase/setup/full-schema.sql                                  # bundle 0014 + 0015
apps/web/src/server/services/audit.ts                           # +uom_conversion.upserted, item.tracking_type.changed
apps/web/src/server/services/receiving.ts                       # accept lots[]/serials[] in postReceipt input
apps/web/src/components/receiving/receipt-form.tsx              # render lot-capture or serial-capture per line
apps/web/src/components/inventory/item-form.tsx                 # +tracking_type field
packages/core/src/schemas/inventory.ts                          # +trackingType enum on createItemSchema
```

---

## Task list (architecture-level)

### Task 1: Migration 0014 — `uom_conversions`

```sql
create table if not exists public.uom_conversions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  item_id         uuid not null references public.inventory_items(id) on delete cascade,
  from_uom        text not null,
  to_uom          text not null,
  numerator       integer not null check (numerator > 0),     -- 24 in "1 PK = 24 EA"
  denominator     integer not null default 1 check (denominator > 0),
  rounding_rule   text not null default 'exact'
                    check (rounding_rule in ('exact','floor','ceil','round')),
  created_by      uuid references public.user_profiles(id),
  approved_by     uuid references public.user_profiles(id),
  approved_at     timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, item_id, from_uom, to_uom)
);
```

- RLS: org members read; manager+ write.
- Helper RPC `convert_uom(p_org_id, p_item_id, p_qty numeric, p_from text, p_to text) returns numeric` — looks up conversion, applies rounding rule, raises `conversion_missing` if absent.

### Task 2: Pure conversion helper + tests

```typescript
// apps/web/src/lib/uom/convert.ts
export interface UomConversion {
  itemId: string;
  fromUom: string;
  toUom: string;
  numerator: number;
  denominator: number;
  roundingRule: 'exact' | 'floor' | 'ceil' | 'round';
}

export interface ConvertInput {
  qty: number;
  fromUom: string;
  toUom: string;
  itemId: string;
  conversions: UomConversion[];
}

export type ConvertResult =
  | { ok: true; qtyBase: number; conversionUsed: UomConversion | null }
  | { ok: false; reason: 'conversion_missing' | 'no_path' };

export function convert(input: ConvertInput): ConvertResult { /* ... */ }
```

Tests cover: identity (`EA → EA`), forward (`PK → EA` with `1 PK = 24 EA`), backward (`EA → PK` reversed), rounding rules, missing conversion → `conversion_missing`, transitive paths (`CT → PK → EA`) — explicitly NOT supported in v1, return `no_path`.

### Task 3: `UomConversionsService` + admin UI

CRUD service + manager screen at `/dashboard/admin/uom-conversions`. Lists by item, lets admin add `1 PK = 24 EA` style rows.

### Task 4: Migration 0015 — tracking + lots + serials

```sql
alter table public.inventory_items
  add column if not exists tracking_type text not null default 'none'
    check (tracking_type in ('none','lot','serial'));

create table if not exists public.receipt_line_lots (
  id              uuid primary key default gen_random_uuid(),
  receipt_line_id uuid not null references public.receipt_lines(id) on delete cascade,
  lot_number      text not null,
  expiration_date date,
  qty_base        numeric(18,4) not null check (qty_base > 0),
  created_at      timestamptz not null default now()
);

create table if not exists public.serial_registry (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  item_id          uuid not null references public.inventory_items(id) on delete restrict,
  serial_number    text not null,
  warehouse_id     uuid not null references public.warehouses(id) on delete restrict,
  current_status   text not null default 'available'
                     check (current_status in ('available','reserved','damaged','rejected','sold','rma')),
  receipt_line_id  uuid references public.receipt_lines(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, item_id, serial_number)
);
```

### Task 5: Extend `post_receipt_v2` RPC

The v2 RPC accepts the `lines` jsonb with optional `lots` (array of `{lot_number, expiration_date?, qty_base}`) and `serials` (array of strings). Logic:
- If item.tracking_type = 'lot':
  - require at least one lot
  - sum(lots.qty_base) must equal qty_accepted_base
  - insert each lot into receipt_line_lots
- If item.tracking_type = 'serial':
  - require qty_accepted_base distinct serials
  - insert each into serial_registry (unique constraint enforces no duplicate org-wide)
  - any duplicate raises 23505 → service maps to `ServiceError('conflict', 'duplicate serial')`

### Task 6: Receiving form lot/serial UI

When a receipt-line's item has `tracking_type !== 'none'`, the form expands to include either:
- **Lot**: a row repeater (lot number, expiry date, qty). Total qty must match qty_accepted; live validation.
- **Serial**: an array of inputs (one per accepted unit). Live count: "5 of 5 serials entered". Auto-pop the next input on Enter.

### Task 7: Wire vendor mapping pack_qty → conversion

When a PO import line has `vendor_uom='PK'` and a matching vendor_item_mapping with `pack_qty=24`, the receiving form pre-fills the conversion as `1 PK = 24 EA` (in-memory, no DB write) and shows the resulting base qty. Admin can save the conversion to `uom_conversions` from the form to make it permanent.

### Task 8: Tests

1. `convert(1, 'PK', 'EA', conversions=[{1 PK = 24 EA}])` → `{qtyBase: 24}`
2. Missing conversion → service raises `conversion_missing`
3. Lot-tracked item without lot → 400
4. Lot-tracked item with sum(lots) ≠ qty_accepted → 400
5. Serial-tracked item with too few serials → 400
6. Duplicate serial across receipts → 409 conflict
7. `tracking_type='none'` item ignores lot/serial inputs (server discards if sent)

### Task 9: Done criteria

- [ ] Migrations 0014 + 0015 applied
- [ ] Admin can define `1 PK = 24 EA` for AA batteries
- [ ] Receiving 1 PK of AA batteries increases stock by 24 EA
- [ ] An item flagged `tracking_type=lot` cannot be received without a lot number
- [ ] An item flagged `tracking_type=serial` rejects duplicate serial numbers
