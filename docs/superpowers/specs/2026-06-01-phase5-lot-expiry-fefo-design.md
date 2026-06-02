# Phase 5 v1 — Food lot / expiry / FEFO (web-only) — design

**Date:** 2026-06-01
**Program:** [Platform Feature Program](../../strategy/2026-06-01-platform-feature-program.md) — Phase 5 (vertical-proof modules), leading with the **food** vertical.
**Status:** approved (owner, 2026-06-01).

## Goal

Prove the multi-industry platform story with a **food warehousing** vertical: lot tracking, expiry dates / shelf life, FEFO (first-expiry-first-out) picking guidance, and recall/aging reporting — all gated behind an off-by-default `lot_serial` premium module so the same platform "becomes a food-warehouse app" when the module is toggled on (investor demo vector #1/#2).

This is a **LIGHT** model by deliberate design: **no per-lot stock balances.** The aggregate `quantity_on_hand` + `adjust_stock` ledger + cycle-count + returns invariants are untouched. Lots are captured at receive time and surfaced for expiry/recall/FEFO *guidance*; picking is advisory + audited, never a stock mutation.

## What already exists (reuse — do NOT rebuild)

- `inventory_items.tracking_type` `('none'|'lot'|'serial')` — migration 0015.
- `receipt_line_lots` (`receipt_line_id`, `lot_number`, `expiration_date`, `qty_base`, `created_at`) + `serial_registry` — migration 0015, RLS in place.
- `post_receipt_v2` RPC validates + persists `lots[]`/`serials[]` per line transactionally (0015, 0069, 0134).
- Web receiving capture UI: [`po-receive-dialog.tsx`](../../../apps/web/src/components/po/po-receive-dialog.tsx) `LotCapture` (lot#/expiry/qty, sum-equals-accepted) + `SerialCapture`.
- `lot_serial` **premium** module stub in [`packages/core/src/modules/registry.ts`](../../../packages/core/src/modules/registry.ts) (line ~545): `tier:'premium'`, `dependsOn:['inventory']`, `surfaces:['web','mobile']`, `minPlan:'business'`, `defaultOnFor:['agriculture_food']`, `placements:[]`, `ownsTables:['lots','serials']`.
- `assertModuleEnabled(ctx, moduleId)` — [`context.ts:158`](../../../apps/web/src/server/services/context.ts); `checkModuleAccess(moduleId)` page guard — [`module-gate.ts:18`](../../../apps/web/src/lib/modules/module-gate.ts).
- `applyIndustryPackAction` uses `modulesForPack(pack)` (incl. premium `defaultOnFor`), so applying the **agriculture_food** pack already enables `lot_serial`. **No pack-provisioning change needed.**
- Reports list pattern: hardcoded `REPORTS[]` array in [`reports/page.tsx`](../../../apps/web/src/app/(dashboard)/dashboard/reports/page.tsx) + one page dir per slug.
- Order fulfillment / pick surface: [`orders/[id]/pick/page.tsx`](../../../apps/web/src/app/(dashboard)/dashboard/orders/[id]/pick/page.tsx) + [`digital-pick.tsx`](../../../apps/web/src/components/orders/digital-pick.tsx).

## Scope (locked)

**IN (Phase 5 v1, web only):**
1. `lot_serial` module gate — grandfathered OFF for existing orgs (migration 0162); on for agriculture_food on new orgs / pack apply (already wired).
2. Per-item **shelf life** + **expiry policy** (default `warn`) columns + a tracking-type/shelf-life UI control on the item form, gated by the module.
3. **FEFO picking hint** — advisory earliest-expiry-first suggestion on the order pick surface for lot-tracked lines + a "record picked lots" action writing a `lot_pick_events` audit row. No stock impact.
4. **Reports** (module-gated): **Aging & expiry** + **Recall / lot trace**.

**OUT (explicit follow-ons, not this pass):**
- Apparel variants (color + per-variant barcode).
- Mobile lot capture / iOS OTA.
- Full per-lot stock balances (scout-rejected — breaks aggregate invariants).
- Ag harvest-lot traceability (Phase 5 v2).

## Data model — migration `0162_lot_serial_module_expiry.sql`

1. **Grandfather the premium module OFF** for every existing org (mirrors 0161/0147 pattern, tier `'premium'`):
   ```sql
   insert into public.organization_modules (organization_id, module_id, enabled, tier, enabled_at)
   select o.id, 'lot_serial', false, 'premium', now()
   from public.organizations o
   on conflict (organization_id, module_id) do nothing;
   ```
2. **New-org seed** — redefine `seed_org_modules()` byte-identical to 0161 plus one appended premium row `('lot_serial','premium', false)`. Pack-driven default-on for `agriculture_food` is applied by `applyIndustryPackAction`, not the base trigger.
3. **Item expiry columns:**
   ```sql
   alter table public.inventory_items
     add column if not exists shelf_life_days integer
       check (shelf_life_days is null or shelf_life_days > 0),
     add column if not exists expiry_policy text not null default 'warn'
       check (expiry_policy in ('none','warn','block'));
   ```
   `expiry_policy` semantics (v1): `none` = track only; `warn` (default) = flag near-expiry/expired in receiving, reports, FEFO hint, never block; `block` = reject recording a FEFO pick of an **expired** lot (the only hard stop in v1).
4. **`lot_pick_events` audit table** (FEFO traceability; **no stock impact**), org-scoped RLS, manager write:
   ```sql
   create table if not exists public.lot_pick_events (
     id                    uuid primary key default gen_random_uuid(),
     organization_id       uuid not null references public.organizations(id) on delete cascade,
     order_request_id      uuid references public.order_requests(id) on delete set null,
     order_request_line_id uuid references public.order_request_lines(id) on delete set null,
     item_id               uuid not null references public.inventory_items(id) on delete restrict,
     lot_number            text not null,
     expiration_date       date,
     qty                   numeric(18,4) not null check (qty > 0),
     picked_by             uuid references auth.users(id),
     picked_at             timestamptz not null default now()
   );
   ```
   Indexes: `(organization_id, item_id, lot_number)`, `(order_request_line_id)`. RLS: select for org members; write for `has_org_role(organization_id,'manager')`.

   **Reconcile registry `ownsTables`:** change `lot_serial.ownsTables` from the placeholder `['lots','serials']` to the real tables `['receipt_line_lots','serial_registry','lot_pick_events']`.

## Components & boundaries

### Core (`packages/core`) — pure, unit-tested
`packages/core/src/lots/expiry.ts` (+ barrel export):
- `computeLotExpiry({ expirationDate, receivedAt }, { shelfLifeDays })` → `Date | null`: explicit `expirationDate` if set; else, if `shelfLifeDays` set, `receivedAt + shelfLifeDays` (the service passes `receipt_line_lots.created_at` as `receivedAt`); else `null`.
- `expiryBucket(expiry, now)` → `'expired' | 'le7' | 'le30' | 'le90' | 'ok' | 'unknown'`.
- `sortLotsFefo(lots)` → ascending by effective expiry; `null`/unknown expiry sort **last** (can't FEFO what has no date).
- No DB, no I/O. ~100% covered by unit tests.

### Service `apps/web/src/server/services/lots.ts` — all gated `assertModuleEnabled(ctx,'lot_serial')`
- `getAgingInventory(ctx, opts?)`: aggregate `receipt_line_lots` (joined through `receipt_lines`→`receipts` for the org + item) by `(item_id, lot_number)`; **net out** recorded picks from `lot_pick_events` for the same `(item, lot)` → approximate `remaining = receivedQty − pickedQty` (floored at 0). Compute effective expiry + bucket per row. Returns rows with `remaining > 0`, sorted FEFO, plus per-bucket rollups. **Honesty note (in code + report UI):** remaining is exact only when picks are recorded via the FEFO action; without recorded picks it reflects received qty. Documented as a known v1 limitation.
- `traceLot(ctx, lotNumber)`: exact + prefix match on `lot_number`; returns every receipt occurrence (receipt#, PO#, supplier, received date, qty, expiry, warehouse) + every `lot_pick_events` row (order#, qty, picked_by, picked_at). The recall surface.
- `getFefoSuggestion(ctx, itemId)`: lots for the item with `remaining > 0`, FEFO-sorted, each flagged `expired`/`nearExpiry` per the item's `expiry_policy`.
- `recordLotPicks(ctx, { orderRequestId, orderRequestLineId, itemId, picks: [{lotNumber, qty, expirationDate}] })`: insert `lot_pick_events`. If item `expiry_policy='block'` and any picked lot is expired → `ServiceError('validation_error', ...)`. No `adjust_stock` call.

### Item form — [`item-form.tsx`](../../../apps/web/src/components/inventory/item-form.tsx) + item action
- Add a **Lot & expiry** section, rendered only when `lot_serial` is enabled (pass an `lotSerialEnabled` prop derived server-side): tracking-type `Select` (None / Lot / Serial), and when `lot` → `shelf_life_days` number input + `expiry_policy` select.
- Server action (`createItemAction`/`updateItemAction`) **rejects** `tracking_type ≠ 'none'` (and any shelf-life/expiry-policy write) when the module is disabled — fail closed, server-authoritative. Mirror the existing custom-fields gate style.

### FEFO hint — pick surface
- On [`orders/[id]/pick`](../../../apps/web/src/app/(dashboard)/dashboard/orders/[id]/pick/page.tsx) (server) gate on `checkModuleAccess('lot_serial')`; for each lot-tracked line, render a `FefoLotHint` client component fed by `getFefoSuggestion`: a "Pick earliest-expiry first" list (lot#, expiry, bucket badge, suggested qty) + a "Record picked lots" form posting to a `recordLotPicksAction` server action. Expired lots badged red; if `expiry_policy='block'`, the record button disables for expired selections.
- **No change** to existing pick/fulfill logic (`partial_pick_line`, `quantity_fulfilled`, `adjust_stock`). The hint is additive and isolated.

### Reports (web, module-gated)
- `getAgingInventory`-backed page `reports/lot-expiry/page.tsx` ("Aging & expiry"): table grouped by bucket (Expired / ≤7d / ≤30d / ≤90d / OK), warn-highlighted, per item+lot with remaining qty + days-to-expiry.
- `traceLot`-backed page `reports/lot-trace/page.tsx` ("Recall / lot trace"): a lot-number search input → receipt occurrences + pick trace.
- Both pages `await checkModuleAccess('lot_serial')` and render the existing `ModuleNotEnabled` page when off.
- `reports/page.tsx`: append the two report entries to `REPORTS[]` **conditionally** — only when `lot_serial` is enabled for the org (read once at the top of the server component). Keeps the reports index clean for non-food orgs.

## Error handling
- All service methods throw `ServiceError` with existing codes; actions return `ActionResult` via `ok`/`err`.
- Module gate failures: services throw (caught → `err('forbidden', ...)`); pages render `ModuleNotEnabled`.
- `expiry_policy='block'` expired-pick rejection → `err('validation_error', 'Lot <n> is expired and this item blocks picking expired stock.')`.
- DB read failures fail closed (empty report + surfaced error), matching the reports/module-settings precedent.

## Testing
- **Core:** `expiry.test.ts` — `computeLotExpiry` (explicit / shelf-life fallback / null), `expiryBucket` boundaries, `sortLotsFefo` (incl. nulls-last + ties).
- **Service:** `lots.test.ts` — module gate (throws when disabled), aging math (received − picks, floor 0), trace (receipt + pick rows), FEFO sort + flags, `recordLotPicks` (writes; `block` rejects expired; `warn` allows).
- **Action:** item-form action gate (tracking_type rejected when module off); `recordLotPicksAction` happy + block path.
- **Migration:** the 0162 grandfather is verified by the existing module-resolver tests (off row → `module_enabled` false) + a seed-trigger assertion if a harness exists.
- Target: tsc clean (web + core), all new tests green, no regression in existing suites.

## Ship
Merge to `main` → Vercel (web). **No mobile changes → no OTA.** Migration 0162 is a human/controller PROD step (like 0158–0161); all reads fail closed (module off → defaults / ModuleNotEnabled), so the deploy is safe before the migration is applied. Update memory (`project_platform_program_progress`) on ship.

## Out-of-scope follow-ons (tracked, not built)
1. Apparel variants (color + per-variant barcode) — Phase 5b.
2. Mobile lot capture + iOS OTA.
3. Ag harvest-lot traceability — Phase 5 v2.
4. Per-lot stock balances — only if a vertical demands true lot-level inventory (would need a per-lot ledger; revisit the aggregate-invariant tradeoff then).
