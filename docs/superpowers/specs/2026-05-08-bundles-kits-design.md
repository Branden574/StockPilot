# Bundles & Kits — Design Spec

**Date:** 2026-05-08
**Status:** Approved, ready for implementation plan
**Branch target:** `main`

## 1. Problem

L4L Fresno (and any future org doing book distributions, kit fulfillment, or grouped sales) needs to track "things we give out together" without manually decrementing five inventory items every time. Today, every distribution is N separate stock-adjust operations and there's no template to repeat the bundle. We need first-class support for bundles/kits with two modes:

- **Virtual recipes** — pick from individual stock at distribution time. No upfront work; the bundle is just a saved list.
- **Pre-assembled** — physically pre-box N kits ahead of time, decrement components, hold the assembled kits as their own stock until distribution.

Both modes coexist per-bundle (toggle on the bundle).

## 2. Goals

- Save reusable bundle definitions (name, SKU, components with per-bundle quantities, optional flag per component)
- Support optional pre-assembly: building N kits up-front decrements components and increments a phantom inventory item
- One-click distribution: pick a bundle + qty + warehouse, get a preview of what will be drawn (phantom vs components), confirm, ship it
- Allow distribution with shortage when components are insufficient — log missing units as `bundle_shortage` movements with `reason='no_stock'` for accounting integrity
- Tie distributions optionally to `schedule_events` so a school visit can auto-distribute its bundle on completion
- Keep bundles out of dead-stock / velocity-class reports (`is_bundle` filter)
- Add bundle-activity and bundle-shortages reports

## 3. Non-goals (v1)

- Cross-warehouse component picking during a single distribution (v2)
- Auto-rebalancing pre-assembled stock between warehouses
- Bundle hierarchies (a bundle that contains another bundle as a component)
- Variable-quantity components ("3 to 5 reading books, picker's choice")
- Pricing/discount rules at the bundle level
- AI tool to *execute* a distribution (`executeBundleDistribution`) — preview only in v1

## 4. Data model

```sql
-- supabase/migrations/0040_bundles.sql

create table bundles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  sku text,
  description text,
  is_active bool not null default true,
  preassembly_enabled bool not null default false,
  phantom_item_id uuid references inventory_items(id) on delete set null,
  archived_at timestamptz,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index bundles_org_active_idx on bundles(organization_id) where is_active and archived_at is null;
create unique index bundles_org_sku_idx on bundles(organization_id, sku) where sku is not null;

create table bundle_components (
  bundle_id uuid not null references bundles(id) on delete cascade,
  item_id uuid not null references inventory_items(id) on delete restrict,
  quantity int not null check (quantity > 0),
  is_optional bool not null default false,
  primary key (bundle_id, item_id)
);
create index bundle_components_bundle_idx on bundle_components(bundle_id);
create index bundle_components_item_idx on bundle_components(item_id);

create table bundle_distributions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  bundle_id uuid not null references bundles(id) on delete restrict,
  warehouse_id uuid not null references warehouses(id) on delete restrict,
  quantity int not null check (quantity > 0),
  schedule_event_id uuid references schedule_events(id) on delete set null,
  notes text,
  shortage_recorded bool not null default false,
  distributed_by uuid references profiles(id),
  distributed_at timestamptz not null default now()
);
create index bundle_distributions_org_distributed_at_idx
  on bundle_distributions(organization_id, distributed_at desc);
create index bundle_distributions_bundle_idx on bundle_distributions(bundle_id);

-- inventory_items
alter table inventory_items add column is_bundle bool not null default false;
create index inventory_items_is_bundle_idx
  on inventory_items(organization_id) where is_bundle;

-- stock_movements.reason — new enum values
-- 'bundle_assembly' | 'bundle_distribution' | 'bundle_shortage' | 'no_stock'
-- (existing reasons remain. 'no_stock' is a generic marker reused here.)
```

RLS policies on the three new tables mirror `inventory_items`: select/insert/update/delete restricted to rows where `organization_id = current_org_id()`. `bundle_components` enforces org via join through `bundles`.

### 4.1 Stored function

```sql
create or replace function distribute_bundle(
  p_bundle_id uuid,
  p_quantity int,
  p_warehouse_id uuid,
  p_allow_shortage bool,
  p_schedule_event_id uuid default null,
  p_notes text default null
) returns uuid
language plpgsql security definer as $$
declare
  v_distribution_id uuid;
  v_phantom_id uuid;
  v_phantom_qty int;
  v_use_phantom int;
  v_use_virtual int;
  v_shortage bool := false;
begin
  -- Lock bundle row, components, and phantom item
  -- Compute draws, write stock_movements, write bundle_distribution
  -- Return new distribution id
  -- (full body in implementation)
end;
$$;
```

The function holds the only writes for distribution so concurrent runs cannot oversell the same kit. Service layer calls it via `supabase.rpc('distribute_bundle', ...)`.

## 5. Service layer

`apps/web/src/server/services/bundles.ts`

```ts
export class BundlesService {
  static async forCurrentUser(): Promise<BundlesService> { ... }

  // Read
  list(opts?: { search?: string; includeInactive?: boolean }): Promise<BundleSummary[]>
  get(id: string): Promise<BundleDetail>
  preview(id: string, quantity: number, warehouseId: string): Promise<DistributionPreview>
  recentDistributions(opts?: { bundleId?: string; limit?: number }): Promise<BundleDistribution[]>

  // Write — definitions (requires bundles:manage)
  create(input: CreateBundleInput): Promise<BundleDetail>
  update(id: string, patch: UpdateBundleInput): Promise<BundleDetail>
  setActive(id: string, isActive: boolean): Promise<void>
  archive(id: string): Promise<void>

  // Write — pre-assembly (requires bundles:manage)
  assemble(id: string, quantity: number, warehouseId: string, notes?: string): Promise<void>

  // Write — distribution (requires bundles:distribute)
  distribute(id: string, input: DistributeInput): Promise<BundleDistribution>
}
```

Permission constants added to `packages/core/src/constants/permissions.ts`:

- `bundles:manage` — Owner, Admin, Manager
- `bundles:distribute` — Owner, Admin, Manager, Staff

Audit events added to `apps/web/src/server/services/audit.ts`:

- `bundle.created`, `bundle.updated`, `bundle.archived`
- `bundle.assembled` (entityType=bundle, after={ quantity, warehouseId })
- `bundle.distributed` (entityType=bundle_distribution, after={ bundleId, quantity, warehouseId, scheduleEventId, shortageRecorded })

## 6. Server actions

`apps/web/src/server/actions/bundles.ts` — zod-validated wrappers around service methods, returned as `ActionResult<T>`:

- `createBundleAction`, `updateBundleAction`, `archiveBundleAction`, `setBundleActiveAction`
- `assembleBundleAction({ id, quantity, warehouseId, notes? })`
- `distributeBundleAction({ id, quantity, warehouseId, allowShortage, scheduleEventId?, notes? })`

All actions call `assertPermission(ctx, ...)` first; surface `permission_denied`, `validation_error`, `not_found`, `insufficient_stock` (when `allowShortage=false` and shortage exists).

## 7. UI surfaces

### 7.1 List page — `/dashboard/bundles/page.tsx`

- Table: name, SKU, components count, pre-assembled qty (sum across warehouses; only if `preassembly_enabled`), active toggle, last-distributed-at, row click → detail
- Filter chips: active / archived / all
- Search box (debounced, name + sku)
- "New bundle" button (Manager+)

### 7.2 Detail page — `/dashboard/bundles/[id]/page.tsx`

- Header: name, SKU, status badges, edit/archive actions (Manager+)
- Components card: table of items + per-kit qty + optional flag, "Add component" picker (Manager+)
- Pre-assembly card (only if enabled):
  - Phantom qty by warehouse
  - "Assemble more" button → modal (Manager+)
- "Distribute" button (Staff+) → `<DistributeBundleModal>`
- Recent distributions table (last 20, link to event if linked)

### 7.3 Distribute modal — `<DistributeBundleModal>`

State: `quantity`, `warehouseId`, `scheduleEventId?`, `notes?`, debounced preview.

- Quantity + warehouse inputs (required)
- Optional schedule_event picker (filtered to upcoming/today events)
- Live preview block populated from `bundles.preview()`:
  - Green: "{N} kits draw from pre-assembled stock"
  - Yellow: "{M} kits draw from components: {item} ×{qty}, {item} ×{qty}, …"
  - Red (if shortage): "⚠ {item} ×{shortQty} short. Distribution will record {shortQty} units as a shortage marker. Confirm to proceed."
- Submit button: "Distribute {N} kits" → flips to "Distribute with shortage" when red
- On submit, calls `distributeBundleAction` with `allowShortage = (preview had shortage)`

### 7.4 Create / edit form — `/dashboard/bundles/new` and `/dashboard/bundles/[id]/edit`

- Name (required), SKU (optional), description (optional)
- "Enable pre-assembly" toggle with helper text
- Components builder: item search picker → adds row → qty input + optional checkbox + remove. Min 1 component required.
- Save (Manager+)

### 7.5 Schedule events integration

`supabase/migrations/0041_schedule_events_bundle.sql`:

```sql
alter table schedule_events
  add column bundle_id uuid references bundles(id) on delete set null,
  add column bundle_quantity int check (bundle_quantity is null or bundle_quantity > 0);
```

Schedule event detail page:
- New section: "Linked bundle" with picker (Manager+)
- "Mark complete" button now also calls `bundles.distribute()` if `bundle_id` set
- Audit event: `schedule_event.completed_with_bundle`

### 7.6 Topbar nav

Add "Bundles" link in the sidebar between "Inventory" and "Cycle counts".

## 8. AI tools (chat)

Added to `apps/web/src/lib/ai/tools.ts`:

- `listBundles({ search?, includeInactive? })` — returns array of `{ id, name, sku, componentCount, preassembledQty?, isActive }`
- `previewBundleDistribution({ bundleId, quantity, warehouseId })` — returns the preview shape so the assistant can answer "if I give out 20 reading kits today, what would I draw?" without writing anything

System prompt addendum in `apps/web/src/lib/ai/chat.ts`:

```
- Bundles / kits:
    - Use listBundles to find a bundle by name; resolve UUIDs.
    - Use previewBundleDistribution for "if I give out X kits…" questions.
    - There is NO execute tool for distributions in v1 — direct the user
      to the bundle page to confirm.
    - For pre-assembled bundles, the phantom item has is_bundle=true and
      should NOT be confused with a regular SKU.
```

## 9. Reports

### 9.1 Bundle activity — `/dashboard/reports/bundle-activity`

- Range picker: 30 / 60 / 90 / 180 / 365 days
- Summary cards: total runs, total kits out, total component cost out
- Table: bundle name, runs, kits out, component cost out, top warehouse
- CSV export via `/api/reports/bundle-activity/csv`

### 9.2 Bundle shortages — `/dashboard/reports/bundle-shortages`

- Range picker (same)
- Lists every `bundle_shortage` movement in window, grouped by component item
- Columns: item name + sku, total short units, # of distributions affected, last shortage date
- CSV export

### 9.3 Existing report filters

- Velocity-class report: filter `where is_bundle = false` so phantoms don't appear
- Dead-stock report: same filter
- Inventory valuation: include phantoms but tag them as bundles in the row

## 10. Edge cases

| Case | Behavior |
|------|----------|
| Editing `preassembly_enabled` while `phantom.qty > 0` | Blocked. UI message: "Disassemble or distribute remaining N kits first." |
| Component item deleted | Bundle shows row as "Deleted item"; distribution blocked until row removed/replaced. No cascade. |
| Component item archived | Same as deleted (soft block). |
| Bundle with 0 components | Save rejected by zod and DB check via service-side validation. |
| Distribute 0 kits | Rejected at schema level. |
| Concurrent distributions | `distribute_bundle()` SQL function holds row locks; serializes correctly. |
| Cross-warehouse components | v1 single-warehouse only. Future v2. |
| Bundle archived | Hidden from distribute pickers, historical distributions remain readable. |

## 11. Implementation file list

**Migrations**
- `supabase/migrations/0040_bundles.sql` — tables, indexes, RLS, function, enum values, `is_bundle` column
- `supabase/migrations/0041_schedule_events_bundle.sql` — bundle linkage on events

**Server**
- `apps/web/src/server/services/bundles.ts` — new service
- `apps/web/src/server/actions/bundles.ts` — new actions
- `apps/web/src/server/services/audit.ts` — new audit event types
- `apps/web/src/server/services/reports.ts` — `bundleActivity()`, `bundleShortages()`, `is_bundle` filter on velocity/dead-stock
- `apps/web/src/server/services/schedule.ts` — `markComplete` triggers bundle distribution when `bundle_id` set
- `packages/core/src/constants/permissions.ts` — new permission keys

**Routes**
- `apps/web/src/app/api/reports/bundle-activity/csv/route.ts`
- `apps/web/src/app/api/reports/bundle-shortages/csv/route.ts`

**Pages**
- `apps/web/src/app/(dashboard)/dashboard/bundles/page.tsx`
- `apps/web/src/app/(dashboard)/dashboard/bundles/new/page.tsx`
- `apps/web/src/app/(dashboard)/dashboard/bundles/[id]/page.tsx`
- `apps/web/src/app/(dashboard)/dashboard/bundles/[id]/edit/page.tsx`
- `apps/web/src/app/(dashboard)/dashboard/reports/bundle-activity/page.tsx`
- `apps/web/src/app/(dashboard)/dashboard/reports/bundle-shortages/page.tsx`
- `apps/web/src/app/(dashboard)/dashboard/reports/page.tsx` (add 2 entries)

**Components**
- `apps/web/src/components/bundles/bundle-list-table.tsx`
- `apps/web/src/components/bundles/bundle-form.tsx`
- `apps/web/src/components/bundles/components-builder.tsx`
- `apps/web/src/components/bundles/distribute-bundle-modal.tsx`
- `apps/web/src/components/bundles/assemble-bundle-modal.tsx`
- `apps/web/src/components/dashboard/topbar.tsx` (add nav link)

**AI**
- `apps/web/src/lib/ai/tools.ts` — `listBundles`, `previewBundleDistribution`
- `apps/web/src/lib/ai/chat.ts` — system prompt addendum

## 12. Testing

- Unit: shortage math in `bundles.preview()` (component qty × kits = draw; clamp to available; emit shortage rows)
- Unit: pre-assembly phantom math (assemble decrements components / increments phantom; distribute drains phantom first)
- Integration: full distribute flow including audit log + stock_movements records + concurrency via two parallel `distribute_bundle()` calls
- E2E (Playwright): create bundle → assemble 5 → distribute 7 (5 phantom + 2 virtual) → verify component qty after

## 13. Rollout

Two migrations, two-step rollout per `feedback_pause_for_migrations.md`:

1. Push code + `0040_bundles.sql`. Wait for user to apply 0040.
2. Push `0041_schedule_events_bundle.sql` + schedule integration code. Wait for user to apply 0041.
3. Verify on production: create one test bundle, run a 1-kit distribution end to end.

No feature flag needed — feature is gated by permissions and the new nav link is the only entry point.
