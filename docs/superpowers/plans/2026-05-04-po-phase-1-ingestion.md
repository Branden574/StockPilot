# Phase 1 — PO Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user can upload a PDF or CSV PO (Staples-format), the system parses it into structured staging rows, classifies tax/freight/inventory lines, suggests SKU matches via vendor item mappings, surfaces unmatched lines in an exception queue, and lets an admin approve the import — at which point a real `purchase_orders` row in `expected_inbound` status is created. Inventory stock is **not** changed at any point in this phase.

**Architecture:**
- Two new tables: `po_imports` (header + raw file) and `po_import_lines` (parsed lines with classification + match status). One support table: `vendor_item_mappings` (learned vendor-item-number → internal-item-id).
- File upload reuses the existing Supabase Storage presigned-URL pattern from `item-images.ts`. Bucket: `po-imports`.
- PDF parsing uses `pdf-parse` (battle-tested, no headless browser). CSV uses `papaparse`. The parser produces a normalized canonical-line shape that both PDF and CSV paths feed into.
- Approval converts `po_imports` + `po_import_lines` into a regular `purchase_orders` + `purchase_order_items` (status `ordered`, mapped to `expected_inbound` semantically — see migration 0010 status enum extension).
- Existing `receive_purchase_order` RPC stays untouched. Phase 2 replaces it.

**Tech Stack:** Next.js 16 server actions, Supabase Postgres + RLS + Storage, `@stockpilot/core` for shared zod schemas, Vitest for unit tests, react-hook-form for the upload form, `pdf-parse@1.1.1` (CommonJS — see Task 8 for ESM handling).

---

## File structure

### New files

```
supabase/migrations/
  0010_po_imports.sql                                  # po_imports + po_import_lines tables
  0011_vendor_item_mappings.sql                        # vendor_item_mappings + new PO status

packages/core/src/schemas/
  po-imports.ts                                        # zod schemas + types

apps/web/src/lib/po-parser/
  index.ts                                             # parsePoFile(buffer, mime) → CanonicalPo
  pdf.ts                                               # parsePdf(buffer) → CanonicalPo
  pdf.test.ts
  csv.ts                                               # parseCsv(text) → CanonicalPo
  csv.test.ts
  classify.ts                                          # classifyLine(description) → line_type
  classify.test.ts
  normalize.ts                                         # canonical line shape + helpers
  normalize.test.ts
  fixtures/
    po-cvsii-001824.txt                                # paste of pdf-parse output for tests
    po-cvsii-001824.csv                                # equivalent CSV fixture

apps/web/src/server/services/
  po-imports.ts                                        # PoImportsService: list, get, create, approve, cancel
  po-imports.test.ts                                   # service tests
  vendor-item-mappings.ts                              # VendorItemMappingsService: list, upsert, delete
  vendor-item-mappings.test.ts

apps/web/src/server/actions/
  po-imports.ts                                        # uploadPoFileAction, parsePoImportAction, approvePoImportAction, cancelPoImportAction
  vendor-item-mappings.ts                              # upsertVendorItemMappingAction, deleteVendorItemMappingAction

apps/web/src/app/(dashboard)/dashboard/purchase-orders/
  imports/
    page.tsx                                           # list of PO imports with status badges
    new/
      page.tsx                                         # upload form
    [id]/
      page.tsx                                         # parsed preview + line table + approve/cancel

apps/web/src/components/po-imports/
  po-upload-form.tsx                                   # client form, presigned PUT, kick parse
  po-import-line-row.tsx                               # one row in preview table
  po-import-status-badge.tsx
  exception-fixer.tsx                                  # popover for fixing match per line

apps/web/src/app/(dashboard)/dashboard/admin/
  vendor-mappings/
    page.tsx                                           # admin: vendor item mapping CRUD
```

### Modified files

```
supabase/setup/full-schema.sql                         # append migrations 0010 + 0011 contents
apps/web/src/server/services/audit.ts                  # +6 AuditEvent literals
apps/web/src/components/dashboard/nav.ts               # +"PO Imports" + "Vendor Mappings" links
packages/core/src/index.ts                             # re-export new schemas
apps/web/package.json                                  # +pdf-parse, +papaparse, +@types/papaparse
```

---

## Task 1: Migration 0010 — po_imports + po_import_lines

**Files:**
- Create: `supabase/migrations/0010_po_imports.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0010_po_imports.sql
-- Staging tables for uploaded purchase orders. A row in po_imports starts at
-- status='uploaded' when a file lands in storage, transitions through 'parsing'
-- → 'parsed' (or 'failed') by a server action, then 'approved' converts it
-- into a real purchase_orders row.

set check_function_bodies = off;

-- ─────────────────────────────────────────────────────────────────────
-- po_imports
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.po_imports (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  uploaded_by     uuid not null references public.user_profiles(id) on delete restrict,
  source_type     text not null check (source_type in ('pdf','csv','xlsx','manual')),
  vendor_id       uuid references public.suppliers(id) on delete set null,
  warehouse_id    uuid references public.warehouses(id) on delete set null,
  file_name       text not null,
  file_mime_type  text not null,
  file_size       bigint not null,
  storage_path    text not null,
  sha256          text not null,
  raw_text        text,
  parsed_json     jsonb,
  parse_error     text,
  status          text not null default 'uploaded'
                    check (status in (
                      'uploaded','parsing','parsed','needs_review',
                      'approved','failed','duplicate','canceled'
                    )),
  approved_po_id  uuid references public.purchase_orders(id) on delete set null,
  approved_at     timestamptz,
  approved_by     uuid references public.user_profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists po_imports_org_sha_uniq
  on public.po_imports(organization_id, sha256)
  where status not in ('failed','canceled','duplicate');

create index if not exists po_imports_org_status_idx
  on public.po_imports(organization_id, status, created_at desc);

create trigger po_imports_updated_at
  before update on public.po_imports
  for each row execute function public.tg_set_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- po_import_lines
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.po_import_lines (
  id                    uuid primary key default gen_random_uuid(),
  po_import_id          uuid not null references public.po_imports(id) on delete cascade,
  line_number           int not null,
  line_type             text not null default 'unknown'
                          check (line_type in (
                            'inventory','tax','freight','service',
                            'fee','discount','unknown'
                          )),
  qty_ordered_original  numeric(18,4),
  uom_original          text,
  description           text,
  unit_cost             numeric(18,4),
  line_total            numeric(18,4),
  vendor_item_number    text,
  vendor_product_number text,
  auxiliary_number      text,
  coa_code              text,
  -- Suggested / approved internal mapping
  item_id               uuid references public.inventory_items(id) on delete set null,
  match_status          text not null default 'needs_review'
                          check (match_status in (
                            'exact_match','mapped','suggested',
                            'needs_review','rejected','non_inventory'
                          )),
  match_confidence      numeric(4,3),
  exception_reason      text,
  parsed_json           jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (po_import_id, line_number)
);

create index if not exists po_import_lines_status_idx
  on public.po_import_lines(po_import_id, match_status);

create trigger po_import_lines_updated_at
  before update on public.po_import_lines
  for each row execute function public.tg_set_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- RLS — same model as purchase_orders
-- ─────────────────────────────────────────────────────────────────────
alter table public.po_imports enable row level security;
alter table public.po_import_lines enable row level security;

drop policy if exists po_imports_select on public.po_imports;
create policy po_imports_select on public.po_imports
  for select using (
    exists (
      select 1 from public.organization_members m
      where m.user_id = auth.uid()
        and m.organization_id = po_imports.organization_id
        and m.accepted_at is not null
    )
  );

drop policy if exists po_imports_insert on public.po_imports;
create policy po_imports_insert on public.po_imports
  for insert with check (
    public.has_org_role(organization_id, 'manager')
  );

drop policy if exists po_imports_update on public.po_imports;
create policy po_imports_update on public.po_imports
  for update
  using (public.has_org_role(organization_id, 'manager'))
  with check (public.has_org_role(organization_id, 'manager'));

drop policy if exists po_import_lines_select on public.po_import_lines;
create policy po_import_lines_select on public.po_import_lines
  for select using (
    exists (
      select 1 from public.po_imports i
      where i.id = po_import_lines.po_import_id
        and exists (
          select 1 from public.organization_members m
          where m.user_id = auth.uid()
            and m.organization_id = i.organization_id
            and m.accepted_at is not null
        )
    )
  );

drop policy if exists po_import_lines_write on public.po_import_lines;
create policy po_import_lines_write on public.po_import_lines
  for all using (
    exists (
      select 1 from public.po_imports i
      where i.id = po_import_lines.po_import_id
        and public.has_org_role(i.organization_id, 'manager')
    )
  );
```

- [ ] **Step 2: Append to setup bundle**

Open `supabase/setup/full-schema.sql`, find the `-- DONE` block, paste the entire migration contents above the DONE comment, save.

- [ ] **Step 3: Apply locally and verify**

```bash
supabase db reset
psql "$LOCAL_DATABASE_URL" -c "select count(*) from public.po_imports; select count(*) from public.po_import_lines;"
```
Expected: both return `count: 0` with no error.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0010_po_imports.sql supabase/setup/full-schema.sql
git commit -m "feat(db): po_imports + po_import_lines staging tables"
```

---

## Task 2: Migration 0011 — vendor_item_mappings + PO status extension

**Files:**
- Create: `supabase/migrations/0011_vendor_item_mappings.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0011_vendor_item_mappings.sql
-- Persistent vendor-item-number → internal-item-id mappings, plus extending
-- the purchase_orders status enum so an approved PO can sit in
-- 'expected_inbound' before any receipt has been posted.

set check_function_bodies = off;

-- ─────────────────────────────────────────────────────────────────────
-- vendor_item_mappings
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.vendor_item_mappings (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations(id) on delete cascade,
  vendor_id             uuid not null references public.suppliers(id) on delete cascade,
  item_id               uuid not null references public.inventory_items(id) on delete cascade,
  vendor_item_number    text,
  vendor_product_number text,
  auxiliary_number      text,
  vendor_description    text,
  vendor_uom            text,
  pack_qty              numeric(18,4),
  conversion_factor     numeric(18,4),
  confidence_score      numeric(4,3),
  match_source          text not null default 'manual'
                          check (match_source in ('manual','learned','imported')),
  approved_by           uuid references public.user_profiles(id) on delete set null,
  approved_at           timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- A vendor cannot have two mappings pointing to different items for the same vendor_item_number.
create unique index if not exists vim_vendor_itemnum_uniq
  on public.vendor_item_mappings(organization_id, vendor_id, lower(vendor_item_number))
  where vendor_item_number is not null;

create index if not exists vim_item_idx
  on public.vendor_item_mappings(item_id);

create trigger vendor_item_mappings_updated_at
  before update on public.vendor_item_mappings
  for each row execute function public.tg_set_updated_at();

alter table public.vendor_item_mappings enable row level security;

drop policy if exists vim_select on public.vendor_item_mappings;
create policy vim_select on public.vendor_item_mappings
  for select using (
    exists (
      select 1 from public.organization_members m
      where m.user_id = auth.uid()
        and m.organization_id = vendor_item_mappings.organization_id
        and m.accepted_at is not null
    )
  );

drop policy if exists vim_admin_write on public.vendor_item_mappings;
create policy vim_admin_write on public.vendor_item_mappings
  for all using (public.has_org_role(organization_id, 'manager'));

-- ─────────────────────────────────────────────────────────────────────
-- purchase_orders status: add 'expected_inbound'
-- The original CHECK is: status in ('draft','ordered','partially_received','received','cancelled')
-- We swap it for one that includes the new value AND keeps every old value
-- for backward compat. 'expected_inbound' is the post-approval state used by
-- imports; 'ordered' remains for manually-created POs.
-- ─────────────────────────────────────────────────────────────────────
alter table public.purchase_orders drop constraint if exists purchase_orders_status_check;
alter table public.purchase_orders
  add constraint purchase_orders_status_check
  check (status in (
    'draft',
    'expected_inbound',
    'ordered',
    'partially_received',
    'received',
    'cancelled'
  ));
```

- [ ] **Step 2: Append to setup bundle**

Same as Task 1 step 2 — paste above `-- DONE`.

- [ ] **Step 3: Apply locally and verify**

```bash
supabase db reset
psql "$LOCAL_DATABASE_URL" -c "select 'expected_inbound'::text in (select unnest(enum_range(null::text))) where false;"
psql "$LOCAL_DATABASE_URL" -c "insert into public.purchase_orders (organization_id, po_number, status) values ('00000000-0000-0000-0000-000000000000', 'TEST-1', 'expected_inbound');" 2>&1 | grep -v "violates foreign key" || true
```

Second command should fail with `violates foreign key` (good — table accepted the status, then rejected on FK), not with `violates check constraint`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0011_vendor_item_mappings.sql supabase/setup/full-schema.sql
git commit -m "feat(db): vendor_item_mappings + purchase_orders.status='expected_inbound'"
```

---

## Task 3: Add new audit events

**Files:**
- Modify: `apps/web/src/server/services/audit.ts:8-30`

- [ ] **Step 1: Open the file and locate `AuditEvent` union** (around line 8).

- [ ] **Step 2: Add 6 new event literals to the union**

```typescript
export type AuditEvent =
  | 'user.invited'
  | 'user.invite.accepted'
  | 'user.invite.revoked'
  | 'user.role.changed'
  | 'user.warehouse.changed'
  | 'user.deactivated'
  | 'user.reactivated'
  | 'inventory.item.created'
  | 'inventory.item.updated'
  | 'inventory.item.archived'
  | 'inventory.item.deleted'
  | 'stock.adjusted'
  | 'stock.received'
  | 'stock.transferred'
  | 'stock.removed'
  | 'warehouse.created'
  | 'warehouse.updated'
  | 'warehouse.archived'
  | 'warehouse_charters.updated'
  | 'charter.created'
  | 'charter.updated'
  | 'charter.archived'
  | 'report.exported'
  | 'po_import.uploaded'
  | 'po_import.parsed'
  | 'po_import.failed'
  | 'po_import.approved'
  | 'po_import.canceled'
  | 'vendor_item_mapping.upserted';
```

- [ ] **Step 3: Run typecheck**

```bash
cd "/Users/brandenvincent-walker/Desktop/Inventory System App" && pnpm typecheck
```
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/server/services/audit.ts
git commit -m "feat(audit): add po_import + vendor_item_mapping events"
```

---

## Task 4: Install runtime deps

**Files:**
- Modify: `apps/web/package.json`

- [ ] **Step 1: Install pdf-parse, papaparse, types**

```bash
cd "/Users/brandenvincent-walker/Desktop/Inventory System App" && pnpm --filter @stockpilot/web add pdf-parse@^1.1.1 papaparse@^5.4.1 && pnpm --filter @stockpilot/web add -D @types/papaparse@^5.3.14 @types/pdf-parse@^1.1.4
```
Expected: install succeeds; `apps/web/package.json` shows `"pdf-parse": "^1.1.1"`, `"papaparse": "^5.4.1"`.

- [ ] **Step 2: Verify typecheck still green**

```bash
pnpm typecheck
```
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml
git commit -m "chore(web): add pdf-parse + papaparse"
```

---

## Task 5: Core schemas in `@stockpilot/core`

**Files:**
- Create: `packages/core/src/schemas/po-imports.ts`
- Modify: `packages/core/src/schemas/index.ts` (add re-export)

- [ ] **Step 1: Write `po-imports.ts`**

```typescript
import { z } from 'zod';

export const poImportLineTypeSchema = z.enum([
  'inventory',
  'tax',
  'freight',
  'service',
  'fee',
  'discount',
  'unknown',
]);
export type PoImportLineType = z.infer<typeof poImportLineTypeSchema>;

export const poImportMatchStatusSchema = z.enum([
  'exact_match',
  'mapped',
  'suggested',
  'needs_review',
  'rejected',
  'non_inventory',
]);
export type PoImportMatchStatus = z.infer<typeof poImportMatchStatusSchema>;

export const poImportStatusSchema = z.enum([
  'uploaded',
  'parsing',
  'parsed',
  'needs_review',
  'approved',
  'failed',
  'duplicate',
  'canceled',
]);
export type PoImportStatus = z.infer<typeof poImportStatusSchema>;

/** Canonical parsed-line shape produced by the parser; mirrors po_import_lines columns. */
export const canonicalPoLineSchema = z.object({
  lineNumber: z.number().int().positive(),
  lineType: poImportLineTypeSchema,
  qtyOrderedOriginal: z.number().nonnegative().nullable(),
  uomOriginal: z.string().max(16).nullable(),
  description: z.string().max(500).nullable(),
  unitCost: z.number().nonnegative().nullable(),
  lineTotal: z.number().nullable(),
  vendorItemNumber: z.string().max(64).nullable(),
  vendorProductNumber: z.string().max(64).nullable(),
  auxiliaryNumber: z.string().max(64).nullable(),
  coaCode: z.string().max(32).nullable(),
});
export type CanonicalPoLine = z.infer<typeof canonicalPoLineSchema>;

export const canonicalPoSchema = z.object({
  poNumber: z.string().max(64).nullable(),
  vendorName: z.string().max(255).nullable(),
  poDate: z.string().max(32).nullable(),
  description: z.string().max(500).nullable(),
  preparedBy: z.string().max(120).nullable(),
  workflow: z.string().max(120).nullable(),
  reason: z.string().max(500).nullable(),
  comments: z.string().max(2000).nullable(),
  shippingAddress: z.string().max(500).nullable(),
  contactName: z.string().max(120).nullable(),
  contactPhone: z.string().max(40).nullable(),
  totalAmount: z.number().nullable(),
  lines: z.array(canonicalPoLineSchema),
});
export type CanonicalPo = z.infer<typeof canonicalPoSchema>;

export const upsertVendorItemMappingSchema = z.object({
  vendorId: z.string().uuid(),
  itemId: z.string().uuid(),
  vendorItemNumber: z.string().max(64).optional().nullable(),
  vendorProductNumber: z.string().max(64).optional().nullable(),
  auxiliaryNumber: z.string().max(64).optional().nullable(),
  vendorDescription: z.string().max(500).optional().nullable(),
  vendorUom: z.string().max(16).optional().nullable(),
  packQty: z.number().nonnegative().optional().nullable(),
  conversionFactor: z.number().nonnegative().optional().nullable(),
});
export type UpsertVendorItemMappingInput = z.infer<typeof upsertVendorItemMappingSchema>;

export const approvePoImportSchema = z.object({
  poImportId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  vendorId: z.string().uuid(),
  /** Per-line overrides: caller can change line item / classification before approval. */
  lineOverrides: z
    .array(
      z.object({
        lineId: z.string().uuid(),
        itemId: z.string().uuid().nullable().optional(),
        lineType: poImportLineTypeSchema.optional(),
        skip: z.boolean().optional(),
      }),
    )
    .default([]),
});
export type ApprovePoImportInput = z.infer<typeof approvePoImportSchema>;
```

- [ ] **Step 2: Re-export from index**

In `packages/core/src/schemas/index.ts`, add:

```typescript
export * from './po-imports';
```

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck
```
Expected: 0 errors across all 3 packages.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/schemas/po-imports.ts packages/core/src/schemas/index.ts
git commit -m "feat(core): zod schemas for po imports + canonical po shape"
```

---

## Task 6: Line classifier (TDD — pure function)

**Files:**
- Create: `apps/web/src/lib/po-parser/classify.ts`
- Create: `apps/web/src/lib/po-parser/classify.test.ts`

- [ ] **Step 1: Write the failing test first**

```typescript
// apps/web/src/lib/po-parser/classify.test.ts
import { describe, expect, it } from 'vitest';
import { classifyLine } from './classify';

describe('classifyLine', () => {
  it('classifies plain TAX line as tax', () => {
    expect(classifyLine('TAX')).toBe('tax');
  });

  it('classifies sales-tax description as tax', () => {
    expect(classifyLine('Sales Tax 8.25%')).toBe('tax');
  });

  it('classifies freight as freight', () => {
    expect(classifyLine('Freight charge')).toBe('freight');
    expect(classifyLine('Shipping')).toBe('freight');
  });

  it('classifies handling/processing fees as fee', () => {
    expect(classifyLine('Handling fee')).toBe('fee');
    expect(classifyLine('Processing surcharge')).toBe('fee');
  });

  it('classifies service / installation / warranty as service', () => {
    expect(classifyLine('Installation labor')).toBe('service');
    expect(classifyLine('Extended warranty')).toBe('service');
  });

  it('classifies discount/credit as discount', () => {
    expect(classifyLine('-50.00 discount')).toBe('discount');
    expect(classifyLine('Volume credit')).toBe('discount');
  });

  it('classifies a real product description as inventory', () => {
    expect(classifyLine('Duracell Coppertop AA Alkaline Batteries, 24/Pack')).toBe(
      'inventory',
    );
    expect(classifyLine('Logitech M330 Silent Plus Wireless Mouse')).toBe('inventory');
  });

  it('classifies empty / null / unknown garbage as unknown', () => {
    expect(classifyLine('')).toBe('unknown');
    expect(classifyLine(null)).toBe('unknown');
    expect(classifyLine('???')).toBe('unknown');
  });

  it('treats negative amounts with no other signal as discount', () => {
    expect(classifyLine('Adjustment', { signedAmount: -10 })).toBe('discount');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @stockpilot/web test classify
```
Expected: FAIL with "Cannot find module './classify'".

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/web/src/lib/po-parser/classify.ts
import type { PoImportLineType } from '@stockpilot/core';

export interface ClassifyContext {
  /** Signed line total (negative = credit). Optional secondary signal. */
  signedAmount?: number;
}

/**
 * Classifies a PO line by description (and optionally a signed amount) into
 * one of the line_type buckets. Pure function — no I/O, deterministic.
 *
 * Priority: explicit keyword in description > signed-amount fallback > inventory if
 * the string looks like a product name > unknown.
 */
export function classifyLine(
  description: string | null | undefined,
  ctx: ClassifyContext = {},
): PoImportLineType {
  const text = (description ?? '').trim().toLowerCase();
  if (!text) return 'unknown';

  // Order matters — most specific first.
  if (/\btax(es)?\b/.test(text)) return 'tax';
  if (/\b(freight|shipping|delivery|carrier)\b/.test(text)) return 'freight';
  if (/\b(handling|processing)\b/.test(text) && /\b(fee|surcharge|charge)\b/.test(text)) {
    return 'fee';
  }
  if (/\b(fee|surcharge)\b/.test(text)) return 'fee';
  if (/\b(installation|labor|warranty|service|repair|subscription)\b/.test(text)) {
    return 'service';
  }
  if (/\b(discount|credit|rebate)\b/.test(text)) return 'discount';
  if (typeof ctx.signedAmount === 'number' && ctx.signedAmount < 0) return 'discount';

  // If the string is gibberish (just punctuation or single-char noise), unknown.
  if (!/[a-z]{3,}/.test(text)) return 'unknown';

  return 'inventory';
}
```

- [ ] **Step 4: Run test to verify pass**

```bash
pnpm --filter @stockpilot/web test classify
```
Expected: 9 tests passed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/po-parser/classify.ts apps/web/src/lib/po-parser/classify.test.ts
git commit -m "feat(po-parser): line-type classifier with 9 unit tests"
```

---

## Task 7: Normalize helpers (TDD — pure)

**Files:**
- Create: `apps/web/src/lib/po-parser/normalize.ts`
- Create: `apps/web/src/lib/po-parser/normalize.test.ts`

- [ ] **Step 1: Test first**

```typescript
// apps/web/src/lib/po-parser/normalize.test.ts
import { describe, expect, it } from 'vitest';
import { normalizeUom, parseMoney, parseQty, sha256Hex } from './normalize';

describe('normalizeUom', () => {
  it('uppercases and trims', () => {
    expect(normalizeUom(' ea ')).toBe('EA');
    expect(normalizeUom('Pk')).toBe('PK');
  });
  it('returns null for empty/null', () => {
    expect(normalizeUom('')).toBeNull();
    expect(normalizeUom(null)).toBeNull();
    expect(normalizeUom(undefined)).toBeNull();
  });
});

describe('parseMoney', () => {
  it('strips $ , and parses', () => {
    expect(parseMoney('$1,234.56')).toBeCloseTo(1234.56);
    expect(parseMoney('299.53')).toBeCloseTo(299.53);
  });
  it('handles parens as negative (accounting style)', () => {
    expect(parseMoney('(50.00)')).toBeCloseTo(-50);
  });
  it('returns null for unparseable', () => {
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('N/A')).toBeNull();
    expect(parseMoney(null)).toBeNull();
  });
});

describe('parseQty', () => {
  it('parses integers and decimals', () => {
    expect(parseQty('1')).toBe(1);
    expect(parseQty('2.5')).toBe(2.5);
  });
  it('returns null for unparseable', () => {
    expect(parseQty('')).toBeNull();
    expect(parseQty('abc')).toBeNull();
  });
});

describe('sha256Hex', () => {
  it('returns deterministic 64-char hex for the same buffer', async () => {
    const buf = new TextEncoder().encode('hello world');
    const h1 = await sha256Hex(buf);
    const h2 = await sha256Hex(buf);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run test — should fail (module missing)**

```bash
pnpm --filter @stockpilot/web test normalize
```

- [ ] **Step 3: Implement**

```typescript
// apps/web/src/lib/po-parser/normalize.ts
import { createHash } from 'node:crypto';

export function normalizeUom(input: string | null | undefined): string | null {
  if (!input) return null;
  const t = input.trim().toUpperCase();
  return t.length === 0 ? null : t;
}

export function parseMoney(input: string | null | undefined): number | null {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;
  // Accounting style: (123.45) means -123.45
  const negative = /^\(.*\)$/.test(s);
  const cleaned = s.replace(/[()$,\s]/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

export function parseQty(input: string | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const s = String(input).trim().replace(/,/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export async function sha256Hex(buf: ArrayBuffer | Uint8Array): Promise<string> {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return createHash('sha256').update(u8).digest('hex');
}
```

- [ ] **Step 4: Run + pass**

```bash
pnpm --filter @stockpilot/web test normalize
```
Expected: 9 tests passed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/po-parser/normalize.ts apps/web/src/lib/po-parser/normalize.test.ts
git commit -m "feat(po-parser): normalize helpers (uom, money, qty, sha256)"
```

---

## Task 8: PDF parser (Staples format)

**Files:**
- Create: `apps/web/src/lib/po-parser/fixtures/po-cvsii-001824.txt`
- Create: `apps/web/src/lib/po-parser/pdf.ts`
- Create: `apps/web/src/lib/po-parser/pdf.test.ts`

- [ ] **Step 1: Capture the fixture**

Run `pdf-parse` against the real Staples PO once, save the `.text` output:

```bash
node -e "(async()=>{const f=await import('node:fs/promises');const p=(await import('pdf-parse')).default;const b=await f.readFile(process.argv[1]);const r=await p(b);console.log(r.text);})()" /path/to/PO-CVSII-001824.pdf > apps/web/src/lib/po-parser/fixtures/po-cvsii-001824.txt
```
Expected: file is created with the raw text dump from the PDF, including header rows, line items with item numbers, and the TAX line.

- [ ] **Step 2: Write the failing test**

```typescript
// apps/web/src/lib/po-parser/pdf.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePdfText } from './pdf';

const FIXTURE = readFileSync(
  join(__dirname, 'fixtures/po-cvsii-001824.txt'),
  'utf8',
);

describe('parsePdfText (Staples format)', () => {
  const po = parsePdfText(FIXTURE);

  it('extracts the PO number', () => {
    expect(po.poNumber).toBe('PO-CVSII-001824');
  });

  it('extracts the vendor', () => {
    expect(po.vendorName).toMatch(/Staples Advantage/i);
  });

  it('extracts the total amount', () => {
    expect(po.totalAmount).toBeCloseTo(299.53, 2);
  });

  it('extracts a Fresno shipping address', () => {
    expect(po.shippingAddress).toMatch(/Fresno/i);
  });

  it('produces at least 13 line rows', () => {
    expect(po.lines.length).toBeGreaterThanOrEqual(13);
  });

  it('classifies the TAX line as tax (not inventory)', () => {
    const tax = po.lines.find((l) => /tax/i.test(l.description ?? ''));
    expect(tax).toBeDefined();
    expect(tax!.lineType).toBe('tax');
    expect(tax!.unitCost).toBeCloseTo(23.11, 2);
  });

  it('captures vendor item number 867474 as Duracell AA batteries', () => {
    const aa = po.lines.find((l) => l.vendorItemNumber === '867474');
    expect(aa).toBeDefined();
    expect(aa!.lineType).toBe('inventory');
    expect(aa!.uomOriginal).toBe('PK');
    expect(aa!.qtyOrderedOriginal).toBe(1);
    expect(aa!.description).toMatch(/Duracell.*AA/i);
  });

  it('captures Logitech mouse with vendor item 2406183 (UOM EA, qty 1)', () => {
    const mouse = po.lines.find((l) => l.vendorItemNumber === '2406183');
    expect(mouse).toBeDefined();
    expect(mouse!.uomOriginal).toBe('EA');
    expect(mouse!.qtyOrderedOriginal).toBe(1);
  });

  it('captures Avery Note Cards qty 2 BX', () => {
    const avery = po.lines.find((l) => l.vendorItemNumber === '466029');
    expect(avery).toBeDefined();
    expect(avery!.qtyOrderedOriginal).toBe(2);
    expect(avery!.uomOriginal).toBe('BX');
  });

  it('every inventory line has a non-null line_total >= 0', () => {
    const inventory = po.lines.filter((l) => l.lineType === 'inventory');
    expect(inventory.length).toBeGreaterThan(0);
    for (const l of inventory) {
      expect(l.lineTotal).not.toBeNull();
      expect(l.lineTotal!).toBeGreaterThanOrEqual(0);
    }
  });
});
```

- [ ] **Step 3: Run — should fail (module missing)**

```bash
pnpm --filter @stockpilot/web test pdf
```

- [ ] **Step 4: Implement parser**

```typescript
// apps/web/src/lib/po-parser/pdf.ts
import type { CanonicalPo, CanonicalPoLine } from '@stockpilot/core';
import { classifyLine } from './classify';
import { normalizeUom, parseMoney, parseQty } from './normalize';

const PO_NUMBER_RE = /\bPO[\s\-]*([A-Z0-9\-]{6,})/i;
const TOTAL_RE = /\bTotal[:\s]+\$?\s*([0-9,]+\.\d{2})/i;
const VENDOR_HEADER_RE = /(Staples\s+Advantage|Vendor:\s*([^\n]+))/i;
const SHIPPING_RE =
  /Shipping\s*Address[:\s]+([\s\S]{1,300}?)(?:Contact|Phone|Total|Description|$)/i;

/**
 * Each Staples PO line in the pdf-parse text dump looks roughly like:
 *   <qty> <uom> <date> <description...> <unit_cost> <total>
 * Followed (sometimes on a continuation line) by:
 *   Item Number: <n>   Vendor Product No: <n>   Auxiliary No: <n>   COA #: <code>
 *
 * We split into "rows" by detecting the leading qty + uom token sequence and
 * then greedily pull the metadata block that follows.
 */
const LINE_HEAD_RE =
  /^(?<qty>\d+(?:\.\d+)?)\s+(?<uom>[A-Z]{2,4})\s+(?<rest>.*)$/;
const ITEM_NUM_RE = /Item\s*Number[:\s]+(?<num>[A-Z0-9\-]+)/i;
const VENDOR_PRODUCT_RE = /Vendor\s*Product\s*No[.:\s]+(?<num>[A-Z0-9\-]+)/i;
const AUX_NUM_RE = /Auxiliary\s*No[.:\s]+(?<num>[A-Z0-9\-]+)/i;
const COA_RE = /COA\s*#?[:\s]+(?<code>[A-Z0-9\-]+)/i;
// Trailing two money values on a head line are unit_cost and line_total
const TRAIL_MONEY_RE = /(?<unit>\(?\$?\s*-?\d[\d,]*\.\d{2}\)?)\s+(?<total>\(?\$?\s*-?\d[\d,]*\.\d{2}\)?)\s*$/;

export interface ParsePdfText {
  (rawText: string): CanonicalPo;
}

export const parsePdfText: ParsePdfText = (rawText) => {
  const lines = rawText.split(/\r?\n/);

  const poNumber = (rawText.match(PO_NUMBER_RE)?.[1] ?? null)
    ? `PO-${rawText.match(PO_NUMBER_RE)![1]}`.replace(/^PO-PO-/, 'PO-')
    : null;
  const totalAmount = parseMoney(rawText.match(TOTAL_RE)?.[1] ?? null);
  const vendorName = (() => {
    const m = rawText.match(VENDOR_HEADER_RE);
    if (!m) return null;
    return (m[2] ?? m[1] ?? '').trim() || null;
  })();
  const shippingAddress = (rawText.match(SHIPPING_RE)?.[1] ?? '')
    .replace(/\s+/g, ' ')
    .trim() || null;

  // Build (line, idx) tuples and also a "next 2 lines for metadata" peek.
  const out: CanonicalPoLine[] = [];
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].trim();
    const m = head.match(LINE_HEAD_RE);
    if (!m?.groups) continue;

    const qty = parseQty(m.groups.qty);
    const uom = normalizeUom(m.groups.uom);
    let rest = m.groups.rest ?? '';

    // Pull trailing two money values off rest if present.
    let unitCost: number | null = null;
    let lineTotal: number | null = null;
    const trail = rest.match(TRAIL_MONEY_RE);
    if (trail?.groups) {
      unitCost = parseMoney(trail.groups.unit);
      lineTotal = parseMoney(trail.groups.total);
      rest = rest.slice(0, trail.index!).trim();
    }

    // Description = rest, with optional date prefix stripped (MM/DD/YYYY).
    const description = rest.replace(/^\d{2}\/\d{2}\/\d{4}\s+/, '').trim() || null;

    // Peek metadata on the next 2 lines (some POs wrap onto 1 line, some 2).
    const peek = `${lines[i + 1] ?? ''} ${lines[i + 2] ?? ''}`;
    const vendorItemNumber = peek.match(ITEM_NUM_RE)?.groups?.num ?? null;
    const vendorProductNumber = peek.match(VENDOR_PRODUCT_RE)?.groups?.num ?? null;
    const auxiliaryNumber = peek.match(AUX_NUM_RE)?.groups?.num ?? null;
    const coaCode = peek.match(COA_RE)?.groups?.code ?? null;

    out.push({
      lineNumber: ++n,
      lineType: classifyLine(description, { signedAmount: lineTotal ?? undefined }),
      qtyOrderedOriginal: qty,
      uomOriginal: uom,
      description,
      unitCost,
      lineTotal,
      vendorItemNumber,
      vendorProductNumber,
      auxiliaryNumber,
      coaCode,
    });
  }

  return {
    poNumber,
    vendorName,
    poDate: null, // not parsed in v1; dates appear in line rows; header date varies
    description: null,
    preparedBy: null,
    workflow: null,
    reason: null,
    comments: null,
    shippingAddress,
    contactName: null,
    contactPhone: null,
    totalAmount,
    lines: out,
  };
};

/**
 * Streaming entry: takes a Buffer (the uploaded PDF) and returns a CanonicalPo.
 * Imports pdf-parse lazily so this file stays test-friendly with just the
 * text fixture in unit tests.
 */
export async function parsePdf(buffer: Buffer): Promise<CanonicalPo> {
  const { default: pdfParse } = (await import('pdf-parse')) as {
    default: (b: Buffer) => Promise<{ text: string }>;
  };
  const { text } = await pdfParse(buffer);
  return parsePdfText(text);
}
```

- [ ] **Step 5: Run + pass**

```bash
pnpm --filter @stockpilot/web test pdf
```
Expected: 9 tests passed.

If any single fixture-derived test fails, **do not weaken the assertion** — fix the regex in `parsePdfText`. The fixture is from a real Staples PO and the parser must match.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/po-parser/{pdf.ts,pdf.test.ts,fixtures}
git commit -m "feat(po-parser): pdf parser with Staples-format fixture (9 tests)"
```

---

## Task 9: CSV parser

**Files:**
- Create: `apps/web/src/lib/po-parser/fixtures/po-cvsii-001824.csv`
- Create: `apps/web/src/lib/po-parser/csv.ts`
- Create: `apps/web/src/lib/po-parser/csv.test.ts`

- [ ] **Step 1: Write the CSV fixture**

```csv
po_number,vendor,po_date,total
PO-CVSII-001824,Staples Advantage,2026-04-29,299.53
line_number,qty,uom,description,unit_cost,line_total,vendor_item_number,vendor_product_number,auxiliary_number,coa_code
1,1,EA,TAX,23.11,23.11,,,,
2,1,PK,"Duracell Coppertop AA Alkaline Batteries, 24/Pack",16.67,16.67,867474,867474,867474,62-00
3,1,PK,"Duracell Coppertop AAA Alkaline Batteries, 24/Pack",16.67,16.67,867473,867473,867473,62-00
4,2,BX,"Avery Note Cards, 60/Box",10.00,20.00,466029,466029,466029,62-00
```

- [ ] **Step 2: Test first**

```typescript
// apps/web/src/lib/po-parser/csv.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsvText } from './csv';

const FIXTURE = readFileSync(
  join(__dirname, 'fixtures/po-cvsii-001824.csv'),
  'utf8',
);

describe('parseCsvText', () => {
  const po = parseCsvText(FIXTURE);

  it('reads header from first 2 rows', () => {
    expect(po.poNumber).toBe('PO-CVSII-001824');
    expect(po.vendorName).toMatch(/Staples Advantage/);
    expect(po.totalAmount).toBeCloseTo(299.53, 2);
  });

  it('reads 4 line rows', () => {
    expect(po.lines.length).toBe(4);
  });

  it('classifies TAX line as tax', () => {
    const tax = po.lines.find((l) => l.description === 'TAX');
    expect(tax?.lineType).toBe('tax');
  });

  it('preserves vendor item number and qty for AA batteries', () => {
    const aa = po.lines.find((l) => l.vendorItemNumber === '867474');
    expect(aa?.qtyOrderedOriginal).toBe(1);
    expect(aa?.uomOriginal).toBe('PK');
  });
});
```

- [ ] **Step 3: Run — should fail (module missing)**

```bash
pnpm --filter @stockpilot/web test csv
```

- [ ] **Step 4: Implement**

```typescript
// apps/web/src/lib/po-parser/csv.ts
import Papa from 'papaparse';
import type { CanonicalPo, CanonicalPoLine } from '@stockpilot/core';
import { classifyLine } from './classify';
import { normalizeUom, parseMoney, parseQty } from './normalize';

interface RawLine {
  line_number?: string;
  qty?: string;
  uom?: string;
  description?: string;
  unit_cost?: string;
  line_total?: string;
  vendor_item_number?: string;
  vendor_product_number?: string;
  auxiliary_number?: string;
  coa_code?: string;
}

export function parseCsvText(input: string): CanonicalPo {
  const blocks = input.trim().split(/\r?\n\r?\n+/);
  // We expect a header CSV (2 rows: header row + value row) and then a lines CSV.
  // For tolerance we just split into "rows that look like the lines table" by
  // detecting the second header row.
  const all = Papa.parse<string[]>(input, { skipEmptyLines: true }).data;

  const headerRowIdx = all.findIndex(
    (r) => r.includes('po_number') || r.includes('PO Number'),
  );
  const lineHeaderIdx = all.findIndex((r) => r.includes('line_number'));

  let poNumber: string | null = null;
  let vendorName: string | null = null;
  let totalAmount: number | null = null;
  let poDate: string | null = null;

  if (headerRowIdx >= 0 && all[headerRowIdx + 1]) {
    const header = all[headerRowIdx];
    const value = all[headerRowIdx + 1];
    const at = (key: string) => {
      const i = header.indexOf(key);
      return i >= 0 ? value[i] : undefined;
    };
    poNumber = at('po_number') ?? null;
    vendorName = at('vendor') ?? null;
    poDate = at('po_date') ?? null;
    totalAmount = parseMoney(at('total') ?? null);
  }

  const lines: CanonicalPoLine[] = [];
  if (lineHeaderIdx >= 0) {
    const header = all[lineHeaderIdx];
    for (let i = lineHeaderIdx + 1; i < all.length; i++) {
      const row = all[i];
      if (row.every((c) => !c?.trim())) continue;
      const at = (key: keyof RawLine): string | undefined => {
        const idx = header.indexOf(key);
        return idx >= 0 ? row[idx] : undefined;
      };
      const description = at('description') ?? null;
      const lineTotal = parseMoney(at('line_total') ?? null);
      lines.push({
        lineNumber: Number(at('line_number')) || lines.length + 1,
        lineType: classifyLine(description, { signedAmount: lineTotal ?? undefined }),
        qtyOrderedOriginal: parseQty(at('qty')),
        uomOriginal: normalizeUom(at('uom')),
        description,
        unitCost: parseMoney(at('unit_cost') ?? null),
        lineTotal,
        vendorItemNumber: at('vendor_item_number') ?? null,
        vendorProductNumber: at('vendor_product_number') ?? null,
        auxiliaryNumber: at('auxiliary_number') ?? null,
        coaCode: at('coa_code') ?? null,
      });
    }
  }

  return {
    poNumber,
    vendorName,
    poDate,
    description: null,
    preparedBy: null,
    workflow: null,
    reason: null,
    comments: null,
    shippingAddress: null,
    contactName: null,
    contactPhone: null,
    totalAmount,
    lines,
  };
}

// Suppress unused-import lint until we use blocks elsewhere
void blocks;
```

> Remove the `let blocks ... void blocks;` lines if your linter is happy without them; they're for clarity only.

- [ ] **Step 5: Pass**

```bash
pnpm --filter @stockpilot/web test csv
```
Expected: 4 tests passed.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/po-parser/{csv.ts,csv.test.ts,fixtures/po-cvsii-001824.csv}
git commit -m "feat(po-parser): csv parser with Staples-shaped fixture (4 tests)"
```

---

## Task 10: Parser entry point

**Files:**
- Create: `apps/web/src/lib/po-parser/index.ts`

- [ ] **Step 1: Write**

```typescript
// apps/web/src/lib/po-parser/index.ts
import type { CanonicalPo } from '@stockpilot/core';
import { parsePdf } from './pdf';
import { parseCsvText } from './csv';

export type ParseSourceType = 'pdf' | 'csv';

export async function parsePoFile(
  buffer: Buffer,
  source: ParseSourceType,
): Promise<CanonicalPo> {
  if (source === 'pdf') return parsePdf(buffer);
  if (source === 'csv') return parseCsvText(buffer.toString('utf8'));
  throw new Error(`Unsupported source: ${source as string}`);
}

export { parsePdf, parsePdfText } from './pdf';
export { parseCsvText } from './csv';
export { classifyLine } from './classify';
export type { CanonicalPo, CanonicalPoLine } from '@stockpilot/core';
```

- [ ] **Step 2: Typecheck + commit**

```bash
pnpm typecheck
git add apps/web/src/lib/po-parser/index.ts
git commit -m "feat(po-parser): unified parsePoFile entry point"
```

---

## Task 11: VendorItemMappingsService (TDD)

**Files:**
- Create: `apps/web/src/server/services/vendor-item-mappings.ts`
- Create: `apps/web/src/server/services/vendor-item-mappings.test.ts`

- [ ] **Step 1: Test first** — focus on pure logic (`matchByVendorNumber`) since DB access requires fixtures.

```typescript
// apps/web/src/server/services/vendor-item-mappings.test.ts
import { describe, expect, it } from 'vitest';
import { matchByVendorNumber, type MappingRow } from './vendor-item-mappings';

const rows: MappingRow[] = [
  {
    id: 'm1',
    vendor_id: 'v1',
    item_id: 'i-aa',
    vendor_item_number: '867474',
    vendor_product_number: '867474',
    auxiliary_number: '867474',
  },
  {
    id: 'm2',
    vendor_id: 'v1',
    item_id: 'i-mouse',
    vendor_item_number: '2406183',
    vendor_product_number: null,
    auxiliary_number: null,
  },
];

describe('matchByVendorNumber', () => {
  it('returns mapped item_id on exact vendor_item_number', () => {
    expect(
      matchByVendorNumber(rows, {
        vendorItemNumber: '867474',
        vendorProductNumber: null,
        auxiliaryNumber: null,
      }),
    ).toEqual({ itemId: 'i-aa', source: 'vendor_item_number' });
  });
  it('falls back to vendor_product_number', () => {
    expect(
      matchByVendorNumber(rows, {
        vendorItemNumber: null,
        vendorProductNumber: '867474',
        auxiliaryNumber: null,
      }),
    ).toEqual({ itemId: 'i-aa', source: 'vendor_product_number' });
  });
  it('returns null when no fields match', () => {
    expect(
      matchByVendorNumber(rows, {
        vendorItemNumber: '999',
        vendorProductNumber: '999',
        auxiliaryNumber: '999',
      }),
    ).toBeNull();
  });
  it('is case-insensitive', () => {
    expect(
      matchByVendorNumber(
        [{ ...rows[0], vendor_item_number: 'abc-1' }],
        { vendorItemNumber: 'ABC-1', vendorProductNumber: null, auxiliaryNumber: null },
      ),
    ).toEqual({ itemId: 'i-aa', source: 'vendor_item_number' });
  });
});
```

- [ ] **Step 2: Run, fail**

```bash
pnpm --filter @stockpilot/web test vendor-item-mappings
```

- [ ] **Step 3: Implement service + match helper**

```typescript
// apps/web/src/server/services/vendor-item-mappings.ts
import 'server-only';

import { audit } from './audit';
import { assertPermission, ServiceError, withContext, type ServiceContext } from './context';

import type { UpsertVendorItemMappingInput } from '@stockpilot/core';

export interface MappingRow {
  id: string;
  vendor_id: string;
  item_id: string;
  vendor_item_number: string | null;
  vendor_product_number: string | null;
  auxiliary_number: string | null;
}

export interface MatchInput {
  vendorItemNumber: string | null;
  vendorProductNumber: string | null;
  auxiliaryNumber: string | null;
}

export type MatchSource =
  | 'vendor_item_number'
  | 'vendor_product_number'
  | 'auxiliary_number';

export interface MatchResult {
  itemId: string;
  source: MatchSource;
}

/**
 * Pure: priority-walks the mapping rows for a given vendor and returns the
 * first matching internal item_id. Case-insensitive exact compare.
 */
export function matchByVendorNumber(
  rows: MappingRow[],
  input: MatchInput,
): MatchResult | null {
  const eq = (a: string | null | undefined, b: string | null | undefined) =>
    !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

  for (const r of rows) {
    if (eq(r.vendor_item_number, input.vendorItemNumber)) {
      return { itemId: r.item_id, source: 'vendor_item_number' };
    }
  }
  for (const r of rows) {
    if (eq(r.vendor_product_number, input.vendorProductNumber)) {
      return { itemId: r.item_id, source: 'vendor_product_number' };
    }
  }
  for (const r of rows) {
    if (eq(r.auxiliary_number, input.auxiliaryNumber)) {
      return { itemId: r.item_id, source: 'auxiliary_number' };
    }
  }
  return null;
}

export class VendorItemMappingsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new VendorItemMappingsService(await withContext());
  }

  async listForVendor(vendorId: string): Promise<MappingRow[]> {
    const { data, error } = await this.ctx.supabase
      .from('vendor_item_mappings')
      .select('id, vendor_id, item_id, vendor_item_number, vendor_product_number, auxiliary_number')
      .eq('organization_id', this.ctx.organizationId)
      .eq('vendor_id', vendorId);
    if (error) throw new ServiceError('internal_error', error.message);
    return (data ?? []) as MappingRow[];
  }

  async upsert(input: UpsertVendorItemMappingInput) {
    assertPermission(this.ctx, 'purchase_orders:manage');
    const { data, error } = await this.ctx.supabase
      .from('vendor_item_mappings')
      .upsert(
        {
          organization_id: this.ctx.organizationId,
          vendor_id: input.vendorId,
          item_id: input.itemId,
          vendor_item_number: input.vendorItemNumber ?? null,
          vendor_product_number: input.vendorProductNumber ?? null,
          auxiliary_number: input.auxiliaryNumber ?? null,
          vendor_description: input.vendorDescription ?? null,
          vendor_uom: input.vendorUom ?? null,
          pack_qty: input.packQty ?? null,
          conversion_factor: input.conversionFactor ?? null,
          approved_by: this.ctx.userId,
          approved_at: new Date().toISOString(),
        },
        { onConflict: 'organization_id,vendor_id,vendor_item_number' },
      )
      .select('id')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    await audit({
      event: 'vendor_item_mapping.upserted',
      entityType: 'vendor_item_mapping',
      entityId: data.id as string,
      after: input,
    });
    return { id: data.id as string };
  }

  async delete(id: string) {
    assertPermission(this.ctx, 'purchase_orders:manage');
    const { error } = await this.ctx.supabase
      .from('vendor_item_mappings')
      .delete()
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
  }
}
```

- [ ] **Step 4: Run + pass**

```bash
pnpm --filter @stockpilot/web test vendor-item-mappings
pnpm typecheck
```
Expected: 4 tests passed; typecheck green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/services/{vendor-item-mappings.ts,vendor-item-mappings.test.ts}
git commit -m "feat(services): VendorItemMappingsService + pure matchByVendorNumber"
```

---

## Task 12: PoImportsService (creation + parse)

**Files:**
- Create: `apps/web/src/server/services/po-imports.ts`

- [ ] **Step 1: Write the service**

```typescript
// apps/web/src/server/services/po-imports.ts
import 'server-only';

import { createHash } from 'node:crypto';

import { audit } from './audit';
import {
  matchByVendorNumber,
  VendorItemMappingsService,
  type MappingRow,
} from './vendor-item-mappings';
import {
  assertPermission,
  ServiceError,
  withContext,
  type ServiceContext,
} from './context';
import { parsePoFile, type ParseSourceType } from '@/lib/po-parser';

import type {
  ApprovePoImportInput,
  CanonicalPo,
  PoImportLineType,
  PoImportMatchStatus,
  PoImportStatus,
} from '@stockpilot/core';

export interface PoImportRow {
  id: string;
  organization_id: string;
  uploaded_by: string;
  source_type: ParseSourceType | 'xlsx' | 'manual';
  vendor_id: string | null;
  warehouse_id: string | null;
  file_name: string;
  file_mime_type: string;
  file_size: number;
  storage_path: string;
  sha256: string;
  status: PoImportStatus;
  parse_error: string | null;
  approved_po_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PoImportLineRow {
  id: string;
  po_import_id: string;
  line_number: number;
  line_type: PoImportLineType;
  qty_ordered_original: number | null;
  uom_original: string | null;
  description: string | null;
  unit_cost: number | null;
  line_total: number | null;
  vendor_item_number: string | null;
  vendor_product_number: string | null;
  auxiliary_number: string | null;
  coa_code: string | null;
  item_id: string | null;
  match_status: PoImportMatchStatus;
  match_confidence: number | null;
  exception_reason: string | null;
}

export class PoImportsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new PoImportsService(await withContext());
  }

  async list(): Promise<PoImportRow[]> {
    const { data, error } = await this.ctx.supabase
      .from('po_imports')
      .select(
        `id, organization_id, uploaded_by, source_type, vendor_id, warehouse_id,
         file_name, file_mime_type, file_size, storage_path, sha256, status,
         parse_error, approved_po_id, created_at, updated_at`,
      )
      .eq('organization_id', this.ctx.organizationId)
      .order('created_at', { ascending: false });
    if (error) throw new ServiceError('internal_error', error.message);
    return (data ?? []) as PoImportRow[];
  }

  async get(id: string): Promise<{ header: PoImportRow; lines: PoImportLineRow[] }> {
    const { data: header, error: hErr } = await this.ctx.supabase
      .from('po_imports')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (hErr) throw new ServiceError('internal_error', hErr.message);
    if (!header) throw new ServiceError('not_found', 'PO import not found');
    const { data: lines, error: lErr } = await this.ctx.supabase
      .from('po_import_lines')
      .select('*')
      .eq('po_import_id', id)
      .order('line_number', { ascending: true });
    if (lErr) throw new ServiceError('internal_error', lErr.message);
    return {
      header: header as PoImportRow,
      lines: (lines ?? []) as PoImportLineRow[],
    };
  }

  /**
   * Caller has already PUT the file to Storage (presigned URL).
   * This persists the metadata row at status='uploaded' and computes the sha256
   * from the buffer the caller hands us — caller passes it during the same
   * server action so we don't have to read the object back from Storage.
   */
  async createFromUpload(input: {
    sourceType: ParseSourceType | 'xlsx' | 'manual';
    storagePath: string;
    fileName: string;
    fileMimeType: string;
    fileSize: number;
    sha256: string;
  }): Promise<{ id: string; duplicateOf: string | null }> {
    assertPermission(this.ctx, 'purchase_orders:manage');

    // Duplicate check: same org + same checksum + status not in failed/canceled.
    const { data: dup } = await this.ctx.supabase
      .from('po_imports')
      .select('id, status')
      .eq('organization_id', this.ctx.organizationId)
      .eq('sha256', input.sha256)
      .not('status', 'in', '(failed,canceled,duplicate)')
      .maybeSingle();
    if (dup) {
      return { id: dup.id as string, duplicateOf: dup.id as string };
    }

    const { data, error } = await this.ctx.supabase
      .from('po_imports')
      .insert({
        organization_id: this.ctx.organizationId,
        uploaded_by: this.ctx.userId,
        source_type: input.sourceType,
        file_name: input.fileName,
        file_mime_type: input.fileMimeType,
        file_size: input.fileSize,
        storage_path: input.storagePath,
        sha256: input.sha256,
        status: 'uploaded',
      })
      .select('id')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    await audit({
      event: 'po_import.uploaded',
      entityType: 'po_import',
      entityId: data.id as string,
      after: { fileName: input.fileName, sha256: input.sha256 },
    });
    return { id: data.id as string, duplicateOf: null };
  }

  /**
   * Parses an uploaded import: downloads the file from Storage, runs the
   * parser, persists header fields + lines + initial line classifications +
   * SKU match attempts, transitions status to 'parsed' or 'failed'.
   */
  async parseImport(id: string): Promise<void> {
    assertPermission(this.ctx, 'purchase_orders:manage');

    const { data: header, error: hErr } = await this.ctx.supabase
      .from('po_imports')
      .select('id, source_type, storage_path, vendor_id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (hErr) throw new ServiceError('internal_error', hErr.message);
    if (!header) throw new ServiceError('not_found', 'PO import not found');

    await this.ctx.supabase
      .from('po_imports')
      .update({ status: 'parsing' })
      .eq('id', id);

    let canonical: CanonicalPo;
    try {
      const { data: blob, error: dlErr } = await this.ctx.supabase.storage
        .from('po-imports')
        .download(header.storage_path as string);
      if (dlErr || !blob) {
        throw new Error(dlErr?.message ?? 'storage download failed');
      }
      const ab = await blob.arrayBuffer();
      const buffer = Buffer.from(ab);
      const sourceType = (header.source_type as string) === 'pdf' ? 'pdf' : 'csv';
      canonical = await parsePoFile(buffer, sourceType);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'parse error';
      await this.ctx.supabase
        .from('po_imports')
        .update({ status: 'failed', parse_error: msg })
        .eq('id', id);
      await audit({
        event: 'po_import.failed',
        entityType: 'po_import',
        entityId: id,
        after: { reason: msg },
      });
      return;
    }

    // Pull mappings to attempt SKU resolution for each inventory line.
    const vendorId = (header.vendor_id as string | null) ?? null;
    const mappings: MappingRow[] = vendorId
      ? await new VendorItemMappingsService(this.ctx).listForVendor(vendorId)
      : [];

    const linesPayload = canonical.lines.map((l) => {
      const isInventory = l.lineType === 'inventory';
      let item_id: string | null = null;
      let match_status: PoImportMatchStatus = isInventory ? 'needs_review' : 'non_inventory';
      let exception_reason: string | null = isInventory
        ? 'No mapping for vendor item number'
        : null;

      if (isInventory) {
        const m = matchByVendorNumber(mappings, {
          vendorItemNumber: l.vendorItemNumber,
          vendorProductNumber: l.vendorProductNumber,
          auxiliaryNumber: l.auxiliaryNumber,
        });
        if (m) {
          item_id = m.itemId;
          match_status = 'mapped';
          exception_reason = null;
        }
      }

      return {
        po_import_id: id,
        line_number: l.lineNumber,
        line_type: l.lineType,
        qty_ordered_original: l.qtyOrderedOriginal,
        uom_original: l.uomOriginal,
        description: l.description,
        unit_cost: l.unitCost,
        line_total: l.lineTotal,
        vendor_item_number: l.vendorItemNumber,
        vendor_product_number: l.vendorProductNumber,
        auxiliary_number: l.auxiliaryNumber,
        coa_code: l.coaCode,
        item_id,
        match_status,
        exception_reason,
        parsed_json: l,
      };
    });

    if (linesPayload.length > 0) {
      const { error: insErr } = await this.ctx.supabase
        .from('po_import_lines')
        .insert(linesPayload);
      if (insErr) throw new ServiceError('internal_error', insErr.message);
    }

    const hasOpenException = linesPayload.some(
      (l) => l.match_status === 'needs_review',
    );
    const newStatus: PoImportStatus = hasOpenException ? 'needs_review' : 'parsed';

    await this.ctx.supabase
      .from('po_imports')
      .update({
        status: newStatus,
        raw_text: null,
        parsed_json: canonical,
      })
      .eq('id', id);

    await audit({
      event: 'po_import.parsed',
      entityType: 'po_import',
      entityId: id,
      after: {
        lineCount: linesPayload.length,
        status: newStatus,
      },
    });
  }

  /**
   * Approves a parsed import: creates a real purchase_orders row in
   * status='expected_inbound' and copies inventory lines into
   * purchase_order_items. Tax / freight / service / non_inventory lines are
   * skipped. Inventory stock is NOT touched.
   */
  async approve(input: ApprovePoImportInput): Promise<{ poId: string }> {
    assertPermission(this.ctx, 'purchase_orders:manage');

    const { header, lines } = await this.get(input.poImportId);
    if (header.status !== 'parsed' && header.status !== 'needs_review') {
      throw new ServiceError(
        'conflict',
        `Cannot approve import in status '${header.status}'`,
      );
    }

    // Apply per-line overrides
    const overrideMap = new Map(input.lineOverrides.map((o) => [o.lineId, o]));
    const finalLines = lines
      .map((l) => {
        const o = overrideMap.get(l.id);
        return o
          ? {
              ...l,
              item_id: o.itemId !== undefined ? o.itemId : l.item_id,
              line_type: o.lineType ?? l.line_type,
              skip: o.skip === true,
            }
          : { ...l, skip: false };
      })
      .filter((l) => !l.skip);

    const inventoryLines = finalLines.filter(
      (l) => l.line_type === 'inventory' && l.item_id !== null,
    );
    const stillUnresolved = finalLines.find(
      (l) => l.line_type === 'inventory' && l.item_id === null,
    );
    if (stillUnresolved) {
      throw new ServiceError(
        'validation_error',
        `Line ${stillUnresolved.line_number} has no mapped item. Resolve in the exception queue or skip the line.`,
      );
    }

    // Generate PO number via existing RPC.
    const { data: nextNum } = await this.ctx.supabase.rpc('next_po_number', {
      p_org_id: this.ctx.organizationId,
    });
    const poNumber = (nextNum as string | null) ?? `PO-${Date.now()}`;

    const subtotal = inventoryLines.reduce(
      (sum, l) => sum + (l.line_total ?? 0),
      0,
    );

    const { data: po, error: poErr } = await this.ctx.supabase
      .from('purchase_orders')
      .insert({
        organization_id: this.ctx.organizationId,
        po_number: poNumber,
        supplier_id: input.vendorId,
        destination_location_id: null, // future: derive from warehouse default location
        notes: `Imported from PO file (po_import ${input.poImportId})`,
        subtotal,
        total: subtotal,
        status: 'expected_inbound',
        created_by: this.ctx.userId,
        updated_by: this.ctx.userId,
      })
      .select('id')
      .single();
    if (poErr) throw new ServiceError('internal_error', poErr.message);

    if (inventoryLines.length > 0) {
      const { error: lineErr } = await this.ctx.supabase
        .from('purchase_order_items')
        .insert(
          inventoryLines.map((l) => ({
            organization_id: this.ctx.organizationId,
            purchase_order_id: po.id as string,
            item_id: l.item_id!,
            quantity_ordered: l.qty_ordered_original ?? 1,
            quantity_received: 0,
            unit_cost: l.unit_cost ?? 0,
          })),
        );
      if (lineErr) throw new ServiceError('internal_error', lineErr.message);
    }

    await this.ctx.supabase
      .from('po_imports')
      .update({
        status: 'approved',
        approved_at: new Date().toISOString(),
        approved_by: this.ctx.userId,
        approved_po_id: po.id as string,
      })
      .eq('id', input.poImportId);

    await audit({
      event: 'po_import.approved',
      entityType: 'po_import',
      entityId: input.poImportId,
      after: {
        poId: po.id,
        lineCount: inventoryLines.length,
        warehouseId: input.warehouseId,
      },
    });

    return { poId: po.id as string };
  }

  async cancel(id: string): Promise<void> {
    assertPermission(this.ctx, 'purchase_orders:manage');
    const { error } = await this.ctx.supabase
      .from('po_imports')
      .update({ status: 'canceled' })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .not('status', 'in', '(approved,canceled)');
    if (error) throw new ServiceError('internal_error', error.message);
    await audit({
      event: 'po_import.canceled',
      entityType: 'po_import',
      entityId: id,
    });
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck
```
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/server/services/po-imports.ts
git commit -m "feat(services): PoImportsService — upload + parse + approve to expected_inbound"
```

---

## Task 13: Server actions

**Files:**
- Create: `apps/web/src/server/actions/po-imports.ts`
- Create: `apps/web/src/server/actions/vendor-item-mappings.ts`

- [ ] **Step 1: Write `po-imports.ts` action**

```typescript
// apps/web/src/server/actions/po-imports.ts
'use server';

import { revalidatePath } from 'next/cache';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { ServiceError } from '@/server/services/context';
import { PoImportsService } from '@/server/services/po-imports';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';

import {
  approvePoImportSchema,
  err,
  ok,
  type ActionResult,
} from '@stockpilot/core';

const ALLOWED_MIME = new Set(['application/pdf', 'text/csv', 'application/vnd.ms-excel']);
const MAX_BYTES = 25 * 1024 * 1024;

const presignSchema = z.object({
  fileName: z.string().min(1).max(255),
  fileMimeType: z.string().min(1),
  fileSize: z.number().int().positive().max(MAX_BYTES),
});

/**
 * Returns a presigned PUT url for the client to upload the PO file directly
 * to Supabase Storage. We don't accept the file through the server action
 * itself because Next.js server actions have a 1MB body limit by default.
 */
export async function presignPoUploadAction(input: {
  fileName: string;
  fileMimeType: string;
  fileSize: number;
}): Promise<ActionResult<{ uploadUrl: string; storagePath: string }>> {
  const parsed = presignSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid file metadata');
  if (!ALLOWED_MIME.has(parsed.data.fileMimeType)) {
    return err('validation_error', 'Only PDF or CSV files are allowed');
  }
  try {
    const ctx = await requireOrgContext();
    const supabase = await createClient();
    const ext = parsed.data.fileName.split('.').pop()?.toLowerCase() ?? 'bin';
    const storagePath = `${ctx.organizationId}/po-imports/${crypto.randomUUID()}.${ext}`;

    const { data, error } = await supabase.storage
      .from('po-imports')
      .createSignedUploadUrl(storagePath);
    if (error) throw new ServiceError('internal_error', error.message);

    return ok({ uploadUrl: data.signedUrl, storagePath });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

const recordSchema = z.object({
  storagePath: z.string().min(1),
  fileName: z.string().min(1),
  fileMimeType: z.string().min(1),
  fileSize: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sourceType: z.enum(['pdf', 'csv', 'xlsx', 'manual']),
});

export async function recordPoUploadAction(input: {
  storagePath: string;
  fileName: string;
  fileMimeType: string;
  fileSize: number;
  sha256: string;
  sourceType: 'pdf' | 'csv' | 'xlsx' | 'manual';
}): Promise<ActionResult<{ id: string; duplicateOf: string | null }>> {
  const parsed = recordSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid upload metadata');
  try {
    const svc = await PoImportsService.forCurrentUser();
    const result = await svc.createFromUpload(parsed.data);
    revalidatePath('/dashboard/purchase-orders/imports');
    return ok(result);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

export async function parsePoImportAction(id: string): Promise<ActionResult<void>> {
  try {
    const svc = await PoImportsService.forCurrentUser();
    await svc.parseImport(id);
    revalidatePath(`/dashboard/purchase-orders/imports/${id}`);
    revalidatePath('/dashboard/purchase-orders/imports');
    return ok(undefined);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

export async function approvePoImportAction(input: {
  poImportId: string;
  warehouseId: string;
  vendorId: string;
  lineOverrides?: Array<{
    lineId: string;
    itemId?: string | null;
    lineType?: 'inventory' | 'tax' | 'freight' | 'service' | 'fee' | 'discount' | 'unknown';
    skip?: boolean;
  }>;
}): Promise<ActionResult<{ poId: string }>> {
  const parsed = approvePoImportSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await PoImportsService.forCurrentUser();
    const result = await svc.approve(parsed.data);
    revalidatePath(`/dashboard/purchase-orders/imports/${input.poImportId}`);
    revalidatePath('/dashboard/purchase-orders');
    return ok(result);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

export async function cancelPoImportAction(id: string): Promise<ActionResult<void>> {
  try {
    const svc = await PoImportsService.forCurrentUser();
    await svc.cancel(id);
    revalidatePath(`/dashboard/purchase-orders/imports/${id}`);
    revalidatePath('/dashboard/purchase-orders/imports');
    return ok(undefined);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
```

- [ ] **Step 2: Write `vendor-item-mappings.ts` action**

```typescript
// apps/web/src/server/actions/vendor-item-mappings.ts
'use server';

import { revalidatePath } from 'next/cache';

import { ServiceError } from '@/server/services/context';
import { VendorItemMappingsService } from '@/server/services/vendor-item-mappings';

import {
  err,
  ok,
  upsertVendorItemMappingSchema,
  type ActionResult,
  type UpsertVendorItemMappingInput,
} from '@stockpilot/core';

export async function upsertVendorItemMappingAction(
  input: UpsertVendorItemMappingInput,
): Promise<ActionResult<{ id: string }>> {
  const parsed = upsertVendorItemMappingSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await VendorItemMappingsService.forCurrentUser();
    const result = await svc.upsert(parsed.data);
    revalidatePath('/dashboard/admin/vendor-mappings');
    return ok(result);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

export async function deleteVendorItemMappingAction(
  id: string,
): Promise<ActionResult<void>> {
  try {
    const svc = await VendorItemMappingsService.forCurrentUser();
    await svc.delete(id);
    revalidatePath('/dashboard/admin/vendor-mappings');
    return ok(undefined);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
```

- [ ] **Step 3: Typecheck + commit**

```bash
pnpm typecheck
git add apps/web/src/server/actions/{po-imports.ts,vendor-item-mappings.ts}
git commit -m "feat(actions): po-imports + vendor-item-mappings server actions"
```

---

## Task 14: Storage bucket — manual setup task

**Files:** None (Supabase dashboard + SQL editor)

- [ ] **Step 1: Create the bucket**

In Supabase dashboard → Storage → New bucket:
- Name: `po-imports`
- Public: **No** (private)
- File size limit: 25 MB
- Allowed MIME types: `application/pdf`, `text/csv`, `application/vnd.ms-excel`

- [ ] **Step 2: Add RLS policies via SQL editor**

```sql
-- Members of the org can read their org's PO imports.
create policy "po_imports_storage_select" on storage.objects
  for select using (
    bucket_id = 'po-imports'
    and (storage.foldername(name))[1]::uuid in (
      select organization_id from public.organization_members
      where user_id = auth.uid() and accepted_at is not null
    )
  );

-- Managers+ can insert into their org's folder.
create policy "po_imports_storage_insert" on storage.objects
  for insert with check (
    bucket_id = 'po-imports'
    and public.has_org_role(
      (storage.foldername(name))[1]::uuid,
      'manager'
    )
  );
```

- [ ] **Step 3: Note in DEPLOY.md**

Append a "Storage buckets" section to `/Users/brandenvincent-walker/Desktop/Inventory System App/DEPLOY.md` listing `po-imports` as a required bucket so a fresh project setup is reproducible.

```bash
git add DEPLOY.md
git commit -m "docs(deploy): note po-imports storage bucket as required"
```

---

## Task 15: Upload form (client)

**Files:**
- Create: `apps/web/src/components/po-imports/po-upload-form.tsx`

- [ ] **Step 1: Write**

```tsx
// apps/web/src/components/po-imports/po-upload-form.tsx
'use client';

import { Loader2, Upload as UploadIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  parsePoImportAction,
  presignPoUploadAction,
  recordPoUploadAction,
} from '@/server/actions/po-imports';

const MAX_BYTES = 25 * 1024 * 1024;
const ACCEPT = ['application/pdf', 'text/csv'];

export function PoUploadForm() {
  const router = useRouter();
  const [file, setFile] = React.useState<File | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      toast.error('Pick a PDF or CSV first');
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error('File is too large (25 MB max)');
      return;
    }
    if (!ACCEPT.includes(file.type)) {
      toast.error('Only PDF or CSV is supported');
      return;
    }
    setSubmitting(true);
    try {
      const presign = await presignPoUploadAction({
        fileName: file.name,
        fileMimeType: file.type,
        fileSize: file.size,
      });
      if (!presign.ok) {
        toast.error(presign.error.message);
        return;
      }

      // PUT the file directly to Supabase Storage
      const put = await fetch(presign.data.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type, 'x-upsert': 'true' },
        body: file,
      });
      if (!put.ok) {
        toast.error('Upload failed');
        return;
      }

      // Compute checksum
      const ab = await file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', ab);
      const sha256 = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      const sourceType: 'pdf' | 'csv' = file.type === 'application/pdf' ? 'pdf' : 'csv';
      const recorded = await recordPoUploadAction({
        storagePath: presign.data.storagePath,
        fileName: file.name,
        fileMimeType: file.type,
        fileSize: file.size,
        sha256,
        sourceType,
      });
      if (!recorded.ok) {
        toast.error(recorded.error.message);
        return;
      }
      if (recorded.data.duplicateOf) {
        toast.message('Duplicate file — opening existing import.');
        router.push(`/dashboard/purchase-orders/imports/${recorded.data.duplicateOf}`);
        return;
      }

      const parsed = await parsePoImportAction(recorded.data.id);
      if (!parsed.ok) {
        toast.error(parsed.error.message);
      }
      router.push(`/dashboard/purchase-orders/imports/${recorded.data.id}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="po-file">PO file (PDF or CSV)</Label>
        <Input
          id="po-file"
          type="file"
          accept={ACCEPT.join(',')}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <p className="text-[11px] text-muted-foreground">
          Max 25 MB. Inventory will not be updated by this upload — receiving
          posts the actual stock change in a separate step.
        </p>
      </div>
      <Button type="submit" disabled={!file || submitting} variant="gradient">
        {submitting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <UploadIcon className="h-4 w-4" />
        )}
        Upload &amp; parse
      </Button>
    </form>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
pnpm typecheck
git add apps/web/src/components/po-imports/po-upload-form.tsx
git commit -m "feat(po-imports): client upload form (presigned PUT + record + parse)"
```

---

## Task 16: List page

**Files:**
- Create: `apps/web/src/app/(dashboard)/dashboard/purchase-orders/imports/page.tsx`
- Create: `apps/web/src/app/(dashboard)/dashboard/purchase-orders/imports/new/page.tsx`
- Create: `apps/web/src/components/po-imports/po-import-status-badge.tsx`

- [ ] **Step 1: Status badge**

```tsx
// apps/web/src/components/po-imports/po-import-status-badge.tsx
import type { PoImportStatus } from '@stockpilot/core';

const COLORS: Record<PoImportStatus, string> = {
  uploaded: 'bg-muted text-muted-foreground',
  parsing: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  parsed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  needs_review: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  approved: 'bg-emerald-200 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  failed: 'bg-destructive/15 text-destructive',
  duplicate: 'bg-muted text-muted-foreground',
  canceled: 'bg-muted text-muted-foreground',
};

export function PoImportStatusBadge({ status }: { status: PoImportStatus }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] ${COLORS[status]}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}
```

- [ ] **Step 2: List page**

```tsx
// apps/web/src/app/(dashboard)/dashboard/purchase-orders/imports/page.tsx
import Link from 'next/link';

import { PoImportStatusBadge } from '@/components/po-imports/po-import-status-badge';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { PoImportsService } from '@/server/services/po-imports';
import { formatRelative } from '@/lib/utils';

export default async function PoImportsPage() {
  const svc = await PoImportsService.forCurrentUser();
  const imports = await svc.list();

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">PO imports</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Upload a vendor PO PDF or CSV to stage expected inbound. Inventory
            is not changed until you receive the items.
          </p>
        </div>
        <Button asChild variant="gradient">
          <Link href="/dashboard/purchase-orders/imports/new">+ New import</Link>
        </Button>
      </div>

      {imports.length === 0 ? (
        <p className="text-sm text-muted-foreground">No imports yet.</p>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Uploaded</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {imports.map((i) => (
                <TableRow key={i.id}>
                  <TableCell>
                    <Link href={`/dashboard/purchase-orders/imports/${i.id}`} className="font-medium hover:underline">
                      {i.file_name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{i.source_type}</TableCell>
                  <TableCell><PoImportStatusBadge status={i.status} /></TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {formatRelative(i.created_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: New import page**

```tsx
// apps/web/src/app/(dashboard)/dashboard/purchase-orders/imports/new/page.tsx
import Link from 'next/link';

import { PoUploadForm } from '@/components/po-imports/po-upload-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function NewPoImportPage() {
  return (
    <div className="container mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link href="/dashboard/purchase-orders/imports" className="text-sm text-muted-foreground hover:text-foreground">
          ← Back to imports
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">New PO import</h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upload</CardTitle>
        </CardHeader>
        <CardContent>
          <PoUploadForm />
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm typecheck
git add apps/web/src/app/\(dashboard\)/dashboard/purchase-orders/imports apps/web/src/components/po-imports/po-import-status-badge.tsx
git commit -m "feat(po-imports): list page + new-import page"
```

---

## Task 17: Detail page (parsed preview + approve)

**Files:**
- Create: `apps/web/src/app/(dashboard)/dashboard/purchase-orders/imports/[id]/page.tsx`
- Create: `apps/web/src/components/po-imports/po-import-detail.tsx`

- [ ] **Step 1: Detail page (server component)**

```tsx
// apps/web/src/app/(dashboard)/dashboard/purchase-orders/imports/[id]/page.tsx
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PoImportDetail } from '@/components/po-imports/po-import-detail';
import { ServiceError } from '@/server/services/context';
import { PoImportsService } from '@/server/services/po-imports';
import { SuppliersService } from '@/server/services/suppliers';
import { WarehousesService } from '@/server/services/warehouses';
import { InventoryService } from '@/server/services/inventory';

export default async function PoImportDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const svc = await PoImportsService.forCurrentUser();

  let header, lines;
  try {
    ({ header, lines } = await svc.get(id));
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'not_found') notFound();
    throw e;
  }

  const [suppliers, warehouses, items] = await Promise.all([
    (await SuppliersService.forCurrentUser()).list(),
    (await WarehousesService.forCurrentUser()).list(),
    (await InventoryService.forCurrentUser()).list({ limit: 200 }),
  ]);

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link href="/dashboard/purchase-orders/imports" className="text-sm text-muted-foreground hover:text-foreground">
          ← Back to imports
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{header.file_name}</h1>
      </div>
      <PoImportDetail
        header={header}
        lines={lines}
        suppliers={suppliers.map((s) => ({ id: s.id as string, name: s.name as string }))}
        warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
        items={items.items.map((i) => ({ id: i.id, sku: i.sku, name: i.name }))}
      />
    </div>
  );
}
```

- [ ] **Step 2: Detail client component**

```tsx
// apps/web/src/components/po-imports/po-import-detail.tsx
'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  approvePoImportAction,
  cancelPoImportAction,
  parsePoImportAction,
} from '@/server/actions/po-imports';
import { PoImportStatusBadge } from '@/components/po-imports/po-import-status-badge';

import type { PoImportLineRow, PoImportRow } from '@/server/services/po-imports';

interface Item {
  id: string;
  sku: string;
  name: string;
}

interface Props {
  header: PoImportRow;
  lines: PoImportLineRow[];
  suppliers: Array<{ id: string; name: string }>;
  warehouses: Array<{ id: string; name: string }>;
  items: Item[];
}

export function PoImportDetail({ header, lines, suppliers, warehouses, items }: Props) {
  const router = useRouter();
  const [vendorId, setVendorId] = React.useState<string>(header.vendor_id ?? '');
  const [warehouseId, setWarehouseId] = React.useState<string>(header.warehouse_id ?? '');
  const [overrides, setOverrides] = React.useState<Record<string, { itemId?: string | null; skip?: boolean }>>({});
  const [busy, setBusy] = React.useState(false);

  const itemMap = React.useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  function setLineItem(lineId: string, itemId: string | null) {
    setOverrides((m) => ({ ...m, [lineId]: { ...(m[lineId] ?? {}), itemId } }));
  }
  function setLineSkip(lineId: string, skip: boolean) {
    setOverrides((m) => ({ ...m, [lineId]: { ...(m[lineId] ?? {}), skip } }));
  }

  async function reparse() {
    setBusy(true);
    const r = await parsePoImportAction(header.id);
    setBusy(false);
    if (!r.ok) toast.error(r.error.message);
    else {
      toast.success('Re-parsed');
      router.refresh();
    }
  }
  async function cancel() {
    if (!confirm('Cancel this import? It will not delete the uploaded file.')) return;
    setBusy(true);
    const r = await cancelPoImportAction(header.id);
    setBusy(false);
    if (!r.ok) toast.error(r.error.message);
    else router.refresh();
  }
  async function approve() {
    if (!vendorId || !warehouseId) {
      toast.error('Pick a vendor and warehouse before approving');
      return;
    }
    setBusy(true);
    const r = await approvePoImportAction({
      poImportId: header.id,
      warehouseId,
      vendorId,
      lineOverrides: Object.entries(overrides).map(([lineId, o]) => ({
        lineId,
        itemId: o.itemId ?? null,
        skip: o.skip === true,
      })),
    });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    toast.success('Import approved — expected inbound PO created');
    router.push(`/dashboard/purchase-orders/${r.data.poId}`);
  }

  const canApprove =
    header.status === 'parsed' || header.status === 'needs_review';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm">
        <PoImportStatusBadge status={header.status} />
        <span className="text-muted-foreground">
          {header.source_type.toUpperCase()} · {(header.file_size / 1024).toFixed(1)} KB
        </span>
        {header.parse_error && (
          <span className="text-destructive">{header.parse_error}</span>
        )}
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={reparse} disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Re-parse'}
          </Button>
          {header.status !== 'approved' && header.status !== 'canceled' && (
            <Button variant="ghost" size="sm" onClick={cancel} disabled={busy}>
              Cancel import
            </Button>
          )}
        </div>
      </div>

      {canApprove && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-xs text-muted-foreground">Vendor</label>
            <Select value={vendorId} onValueChange={setVendorId}>
              <SelectTrigger><SelectValue placeholder="Pick vendor" /></SelectTrigger>
              <SelectContent>
                {suppliers.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Destination warehouse</label>
            <Select value={warehouseId} onValueChange={setWarehouseId}>
              <SelectTrigger><SelectValue placeholder="Pick warehouse" /></SelectTrigger>
              <SelectContent>
                {warehouses.map((w) => (
                  <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">#</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Vendor #</TableHead>
              <TableHead>Qty / UOM</TableHead>
              <TableHead>Cost</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Internal item</TableHead>
              <TableHead className="w-20 text-right">Skip</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l) => {
              const o = overrides[l.id] ?? {};
              const effectiveItemId =
                o.itemId !== undefined ? o.itemId : l.item_id;
              return (
                <TableRow key={l.id}>
                  <TableCell className="tabular-nums">{l.line_number}</TableCell>
                  <TableCell className="max-w-[280px] truncate">{l.description}</TableCell>
                  <TableCell className="font-mono text-xs">{l.vendor_item_number ?? '—'}</TableCell>
                  <TableCell className="tabular-nums">
                    {l.qty_ordered_original} {l.uom_original}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {l.line_total != null ? `$${l.line_total.toFixed(2)}` : '—'}
                  </TableCell>
                  <TableCell>
                    <span className="rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide">
                      {l.line_type}
                    </span>
                  </TableCell>
                  <TableCell>
                    {l.line_type === 'inventory' ? (
                      <Select
                        value={effectiveItemId ?? ''}
                        onValueChange={(v) => setLineItem(l.id, v || null)}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder="Pick item" />
                        </SelectTrigger>
                        <SelectContent>
                          {items.map((i) => (
                            <SelectItem key={i.id} value={i.id}>
                              {i.sku} — {i.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className="text-xs text-muted-foreground">non-inventory</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <input
                      type="checkbox"
                      checked={o.skip === true}
                      onChange={(e) => setLineSkip(l.id, e.target.checked)}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {canApprove && (
        <div className="flex justify-end">
          <Button onClick={approve} disabled={busy} variant="gradient">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Approve & create expected inbound PO'}
          </Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck + commit**

```bash
pnpm typecheck
git add apps/web/src/app/\(dashboard\)/dashboard/purchase-orders/imports/\[id\]/page.tsx apps/web/src/components/po-imports/po-import-detail.tsx
git commit -m "feat(po-imports): detail page with line overrides + approve"
```

---

## Task 18: Vendor mappings admin UI

**Files:**
- Create: `apps/web/src/app/(dashboard)/dashboard/admin/vendor-mappings/page.tsx`
- Create: `apps/web/src/components/admin/vendor-mappings-manager.tsx`

- [ ] **Step 1: Server page**

```tsx
// apps/web/src/app/(dashboard)/dashboard/admin/vendor-mappings/page.tsx
import { VendorMappingsManager } from '@/components/admin/vendor-mappings-manager';
import { InventoryService } from '@/server/services/inventory';
import { SuppliersService } from '@/server/services/suppliers';
import { createClient } from '@/lib/supabase/server';
import { requireOrgContext } from '@/lib/auth/session';

export default async function VendorMappingsPage() {
  const ctx = await requireOrgContext();
  const supabase = await createClient();

  const [suppliers, items, mappingsRes] = await Promise.all([
    (await SuppliersService.forCurrentUser()).list(),
    (await InventoryService.forCurrentUser()).list({ limit: 500 }),
    supabase
      .from('vendor_item_mappings')
      .select('id, vendor_id, item_id, vendor_item_number, vendor_product_number, auxiliary_number, vendor_description')
      .eq('organization_id', ctx.organizationId)
      .order('vendor_id'),
  ]);

  return (
    <div className="mx-auto w-full max-w-[1280px] px-8 pb-20 pt-7">
      <h1 className="font-display text-[28px] font-medium tracking-[-0.025em]">
        Vendor item mappings
      </h1>
      <p className="mt-1 text-[13.5px] text-muted-foreground">
        Map vendor product numbers (e.g. Staples #867474) to your internal items
        so future PO uploads auto-resolve.
      </p>
      <div className="mt-6">
        <VendorMappingsManager
          mappings={(mappingsRes.data ?? []) as Array<{
            id: string;
            vendor_id: string;
            item_id: string;
            vendor_item_number: string | null;
            vendor_product_number: string | null;
            auxiliary_number: string | null;
            vendor_description: string | null;
          }>}
          suppliers={suppliers.map((s) => ({ id: s.id as string, name: s.name as string }))}
          items={items.items.map((i) => ({ id: i.id, sku: i.sku, name: i.name }))}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Client component (CRUD)**

```tsx
// apps/web/src/components/admin/vendor-mappings-manager.tsx
'use client';

import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  deleteVendorItemMappingAction,
  upsertVendorItemMappingAction,
} from '@/server/actions/vendor-item-mappings';

interface Mapping {
  id: string;
  vendor_id: string;
  item_id: string;
  vendor_item_number: string | null;
  vendor_product_number: string | null;
  auxiliary_number: string | null;
  vendor_description: string | null;
}

export function VendorMappingsManager({
  mappings,
  suppliers,
  items,
}: {
  mappings: Mapping[];
  suppliers: Array<{ id: string; name: string }>;
  items: Array<{ id: string; sku: string; name: string }>;
}) {
  const router = useRouter();
  const [vendorId, setVendorId] = React.useState('');
  const [itemId, setItemId] = React.useState('');
  const [vendorItemNumber, setVendorItemNumber] = React.useState('');
  const [vendorDescription, setVendorDescription] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  async function add() {
    if (!vendorId || !itemId || !vendorItemNumber.trim()) {
      toast.error('Vendor, item, and vendor item number are required');
      return;
    }
    setBusy(true);
    const r = await upsertVendorItemMappingAction({
      vendorId,
      itemId,
      vendorItemNumber: vendorItemNumber.trim(),
      vendorDescription: vendorDescription.trim() || null,
    });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    setVendorItemNumber('');
    setVendorDescription('');
    toast.success('Mapping saved');
    router.refresh();
  }
  async function remove(id: string) {
    if (!confirm('Delete this mapping?')) return;
    const r = await deleteVendorItemMappingAction(id);
    if (!r.ok) toast.error(r.error.message);
    else router.refresh();
  }

  const vendorMap = new Map(suppliers.map((s) => [s.id, s.name]));
  const itemMap = new Map(items.map((i) => [i.id, `${i.sku} — ${i.name}`]));

  return (
    <div className="space-y-6">
      <div className="rounded-xl border bg-card p-4">
        <h2 className="text-sm font-semibold">Add mapping</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Vendor</Label>
            <Select value={vendorId} onValueChange={setVendorId}>
              <SelectTrigger><SelectValue placeholder="Pick vendor" /></SelectTrigger>
              <SelectContent>
                {suppliers.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Internal item</Label>
            <Select value={itemId} onValueChange={setItemId}>
              <SelectTrigger><SelectValue placeholder="Pick item" /></SelectTrigger>
              <SelectContent>
                {items.map((i) => (
                  <SelectItem key={i.id} value={i.id}>{i.sku} — {i.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Vendor item number</Label>
            <Input
              placeholder="867474"
              value={vendorItemNumber}
              onChange={(e) => setVendorItemNumber(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Vendor description (optional)</Label>
            <Input
              placeholder="Duracell Coppertop AA, 24/Pack"
              value={vendorDescription}
              onChange={(e) => setVendorDescription(e.target.value)}
            />
          </div>
        </div>
        <div className="mt-3 flex justify-end">
          <Button onClick={add} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Save
          </Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Vendor</TableHead>
              <TableHead>Vendor item #</TableHead>
              <TableHead>Internal item</TableHead>
              <TableHead className="w-16 text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {mappings.map((m) => (
              <TableRow key={m.id}>
                <TableCell>{vendorMap.get(m.vendor_id) ?? m.vendor_id}</TableCell>
                <TableCell className="font-mono text-xs">{m.vendor_item_number}</TableCell>
                <TableCell>{itemMap.get(m.item_id) ?? m.item_id}</TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="icon" onClick={() => remove(m.id)} aria-label="Delete">
                    <Trash2 className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck + commit**

```bash
pnpm typecheck
git add apps/web/src/app/\(dashboard\)/dashboard/admin/vendor-mappings/page.tsx apps/web/src/components/admin/vendor-mappings-manager.tsx
git commit -m "feat(admin): vendor item mappings manager"
```

---

## Task 19: Nav + admin links

**Files:**
- Modify: `apps/web/src/components/dashboard/nav.ts`

- [ ] **Step 1: Add 2 entries**

In the inventory section add a "PO imports" item, and in the admin section add a "Vendor mappings" item. Locate the inventory and admin section arrays in `nav.ts` and append:

```typescript
// inside the Inventory section items array
{ href: '/dashboard/purchase-orders/imports', label: 'PO imports', icon: Upload },
// inside ADMIN_NAV.items array
{ href: '/dashboard/admin/vendor-mappings', label: 'Vendor mappings', icon: BookOpen },
```

Make sure the icons are imported at the top of `nav.ts` (e.g. `import { ... Upload, BookOpen } from 'lucide-react';`).

- [ ] **Step 2: Update the test**

`apps/web/src/components/dashboard/nav.test.ts` — the route-warming test compares `DASHBOARD_NAV_HREFS` to the admin-superset. Run it; if it fails, the test is genuinely catching a missed route — confirm the new entries are in `DASHBOARD_NAV_HREFS` (it's derived automatically since it's `[...BASE_NAV.flatMap(...), ...ADMIN_NAV.items.map(...)]`).

```bash
pnpm --filter @stockpilot/web test nav
pnpm typecheck
```
Expected: 2 nav tests pass; typecheck green.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/dashboard/nav.ts
git commit -m "feat(nav): add PO imports + vendor mappings links"
```

---

## Task 20: End-to-end verification + push

- [ ] **Step 1: Full pipeline check locally**

```bash
pnpm install
pnpm typecheck
pnpm --filter @stockpilot/web test
pnpm build
```
Expected: typecheck 0 errors, all tests green (existing 13 + new ~30), build under 15s.

- [ ] **Step 2: Manual smoke (local dev server)**

1. `supabase start && supabase db reset` (applies all migrations including 0010 + 0011)
2. `pnpm dev`
3. Sign in as the seed admin
4. **Admin → Vendor mappings** → add a mapping for Staples + vendor item `867474` → existing AA-batteries item
5. **PO imports → New import** → upload `PO-CVSII-001824.pdf`
6. Detail page: confirm 13+ lines parsed, TAX line classified as `tax`, AA batteries line shows `mapped` to your item
7. Pick vendor + warehouse, click **Approve**
8. Lands on `/dashboard/purchase-orders/<new-po-id>` showing the new PO with status `expected_inbound`
9. Inventory dashboard: confirm stock has **not** changed for any item
10. Receive 1 PK on the PO (existing flow): stock should now go up by 1 (Phase 1 stops here — this confirms the existing receiving path still works)

- [ ] **Step 3: Apply migrations to hosted Supabase**

```bash
psql $PROD_DATABASE_URL -f supabase/migrations/0010_po_imports.sql
psql $PROD_DATABASE_URL -f supabase/migrations/0011_vendor_item_mappings.sql
```

Verify in Supabase dashboard: tables exist, `po_imports` row count = 0.

Manually create the `po-imports` Storage bucket (see Task 14) on the hosted project.

- [ ] **Step 4: Push**

```bash
git push origin main
```

Vercel will auto-redeploy. After green:
1. Visit `/dashboard/purchase-orders/imports` on production
2. Upload the same Staples PDF
3. Confirm parsed preview matches local
4. Approve → land on the new PO at status `expected_inbound`

- [ ] **Step 5: Update memory**

```bash
cat >> ~/.claude/projects/-Users-brandenvincent-walker-Desktop-Inventory-System-App/memory/project_phase_status.md <<'EOF'

## Phase 1 of PO Ingestion shipped (2026-05-XX)
- Migrations 0010 + 0011 applied
- Supabase `po-imports` bucket created
- New routes: /dashboard/purchase-orders/imports[/...], /dashboard/admin/vendor-mappings
- Phase 2 (hardened receiving + idempotency) is next.
EOF
```

---

## Self-review checklist

- [ ] Every task has at least one test or a verification command
- [ ] No "TBD"/"TODO"/"similar to Task N"
- [ ] Migration 0010 runs cleanly on a fresh `supabase db reset`
- [ ] All audit events declared in Task 3 are referenced by the service code in Tasks 11-12
- [ ] `purchase_orders.status='expected_inbound'` is accepted by the CHECK constraint after migration 0011
- [ ] Approve flow does NOT call `adjust_stock` or otherwise mutate `inventory_items.quantity_on_hand`
- [ ] Tax/freight/non-inventory lines are filtered out at approve time (`finalLines.filter(l => l.line_type === 'inventory')`)
- [ ] Storage bucket setup is documented in Task 14 (manual step, not skipped)
- [ ] Nav test still passes after adding new links

---

## Done when

- [ ] Local: upload Staples PDF → see 13+ parsed lines → TAX correctly classified → AA batteries auto-mapped (after vendor mapping created) → approve creates PO `expected_inbound` → inventory unchanged
- [ ] Production: same, on `https://stock-pilot-web-seven.vercel.app`
- [ ] Audit log: `po_import.uploaded`, `po_import.parsed`, `po_import.approved` all visible in `/dashboard/admin/audit`
- [ ] Phase 2 plan (`2026-05-04-po-phase-2-hardened-receiving.md`) is queued and ready to expand to full TDD detail
