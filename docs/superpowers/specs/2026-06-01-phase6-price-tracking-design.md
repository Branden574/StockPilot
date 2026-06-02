# Phase 6 v1 — Google Books price monitoring — design

**Date:** 2026-06-01
**Program:** [Platform Feature Program](../../strategy/2026-06-01-platform-feature-program.md) — Phase 6, sub-project **price-monitoring connector** (leading Phase 6 because it delivers real external data on items the org already has).
**Status:** approved (owner, 2026-06-01).

## Goal

Pull **real** market data (list/retail price + rich metadata) for an org's **book** items from the free **Google Books API**, matched by ISBN (stored in `inventory_items.barcode`), gated behind an off-by-default `price_tracking` module. Both **on-demand** (per-item + bulk buttons, usable immediately) and an **automated daily cron** (builds price history over time). Books-only, web-only v1.

This is the external-data counterpart to Phase 1's own-data supplier cost-history. It rides the module registry (the platform on/off story) but deliberately stays LIGHT: no per-org OAuth/Vault connection (Google Books is free/keyless); observations live in their own table and never mutate `inventory_items`.

## Decisions (locked)
- **Source:** Google Books `GET /books/v1/volumes?q=isbn:{isbn}&country=US` (+ optional `&key=` from a platform-level `GOOGLE_BOOKS_API_KEY` env var to raise quota; works keyless for low volume). Books-only.
- **Automation:** on-demand (per-item "Refresh market price" + Books-page "Refresh book prices" bulk) **and** a daily cron.
- **Connection model:** module-gated only — NO per-org connection row / Vault secret (free source). Keepa-later (paid, per-org key) would use the full connector+Vault path; out of scope here.

## What exists (reuse)
- `inventory_items.barcode` (indexed) holds book ISBNs; `item_type='book'`.
- Module framework: `ModuleId` union + `MODULE_REGISTRY` + `seed_org_modules()` grandfather pattern (see 0161/0162); `assertModuleEnabled(ctx,id)` + `checkModuleAccess(id)`.
- Cron framework: `apps/web/vercel.json` `crons[]`; route pattern `cron/drain-outbox` (`env.CRON_SECRET` + `secretsEqual` fail-closed; `createAdminClient()` service-role to iterate orgs; per-org module gate).
- `createAdminClient()` (`@/lib/supabase/admin`), `env` (`@/lib/env`), `reportError`.

## Data model — migration `0163_price_tracking_module_observations.sql`
1. **Module grandfather** (mirrors 0161/0162): insert `price_tracking` **optional**, enabled=false for every existing org `on conflict do nothing`; redefine `seed_org_modules()` byte-identical to 0162 plus an appended `('price_tracking','optional', false)` row.
2. **`item_price_observations`** (append-only history):
   ```sql
   create table if not exists public.item_price_observations (
     id               uuid primary key default gen_random_uuid(),
     organization_id  uuid not null references public.organizations(id) on delete cascade,
     item_id          uuid not null references public.inventory_items(id) on delete cascade,
     source           text not null default 'google_books',
     isbn             text,
     list_price       numeric(12,2),
     retail_price     numeric(12,2),
     currency         text,
     title            text,
     authors          text,
     average_rating   numeric(3,2),
     ratings_count    integer,
     categories       text,
     thumbnail_url    text,
     info_link        text,
     saleability      text,
     observed_at      timestamptz not null default now()
   );
   create index if not exists item_price_observations_item_idx
     on public.item_price_observations (organization_id, item_id, observed_at desc);
   ```
   RLS: select = accepted org members; write = `has_org_role(organization_id,'manager')` (on-demand action is manager+; the cron uses the service-role admin client which bypasses RLS).

   **`ModuleDefinition.ownsTables`** for `price_tracking` = `['item_price_observations']`.

## Components & boundaries

### Core (`packages/core`, pure, unit-tested)
`packages/core/src/pricing/google-books.ts` (+ barrel export):
- `isLikelyIsbn(barcode: string | null): boolean` — strip spaces/hyphens; true iff 10 or 13 digits (no checksum requirement in v1; cheap pre-filter so we don't query Google for non-ISBN barcodes).
- `parseGoogleBooksVolume(json: unknown): ParsedBookObservation | null` — take a Google Books `volumes` response, read `items[0]`, return `{ listPrice, retailPrice, currency, title, authors, averageRating, ratingsCount, categories, thumbnailUrl, infoLink, saleability }` (all nullable); `null` if no items. No I/O.

### Google Books client (`apps/web/src/server/pricing/google-books-client.ts`)
- `fetchVolumeByIsbn(isbn: string): Promise<unknown | null>` — raw `fetch` to the volumes endpoint with `country=US` + optional `env.GOOGLE_BOOKS_API_KEY`; returns parsed JSON or `null` on non-200 (incl. 429 — logged, treated as "no data this run", never throws). Stateless.

### Shared fetch+store (`apps/web/src/server/services/price-tracking.ts`)
- `async function recordBookObservation(supabase, orgId, item, client): Promise<boolean>` — if `isLikelyIsbn(item.barcode)`, fetch the volume, `parseGoogleBooksVolume`, insert one `item_price_observations` row; returns whether an observation was written. Works with EITHER a user-scoped client (on-demand, RLS) or the admin client (cron). The single source of fetch+persist truth.
- `class PriceTrackingService` (gated `assertModuleEnabled(ctx,'price_tracking')` + `assertPermission(ctx,'items:update')`):
  - `fetchItemPrice(itemId)` — load the item (org-scoped), call `recordBookObservation(ctx.supabase,…)`, return the latest observation (or a "no ISBN / no data" result).
  - `refreshOrgBookPrices(opts?: { limit?: number })` — page active book items with an ISBN-ish barcode, **skip any observed in the last ~20h**, throttle (small delay between calls), cap at `limit` (default ~300) per run to respect Google's quota; returns `{ scanned, written, skipped }`.
  - `getLatestObservation(itemId)` — newest row for the item-detail panel.

### Cron (`apps/web/src/app/api/cron/price-pull/route.ts`)
- `nodejs` runtime, `maxDuration = 60`, `env.CRON_SECRET` + `secretsEqual` fail-closed (copy drain-outbox).
- `createAdminClient()` → select org ids from `organization_modules` where `module_id='price_tracking'` and `enabled=true`. For each, run the batch refresh via the admin client + the shared `recordBookObservation` loop (cap per org). Fail-OPEN per org (report + continue). Add `{ "path": "/api/cron/price-pull", "schedule": "0 9 * * *" }` to `apps/web/vercel.json`.

### Actions (`apps/web/src/server/actions/price-tracking.ts`)
- `fetchItemPriceAction(itemId)` + `refreshBookPricesAction()` → delegate to `PriceTrackingService`, `revalidatePath` the item/books pages, return `ActionResult`.

### UI (web, module-gated)
- **Item detail** (`inventory/[id]/page.tsx`): a **"Market price (Google Books)"** panel (client island with a Refresh button) — shows latest list/retail price + currency, the org's own retail/cost for comparison, rating, cover thumbnail, "View on Google Books" link, observed date; or a "No market data yet — Refresh" empty state. Rendered only when `price_tracking` is enabled AND the item has an ISBN-ish barcode.
- **Books page** (`books/page.tsx`): a "Refresh book prices" button (calls `refreshBookPricesAction`, toasts the `{scanned,written,skipped}` summary). Module + manager gated.

## Error handling
- Client/network/429 → `null`, logged, never throws (a pull miss is not a failure).
- Service module-gate / permission → `ServiceError` → actions return `err(...)`; pages gate with `checkModuleAccess`.
- Cron: per-org try/catch, `reportError`, continue; CRON_SECRET fail-closed.

## Testing
- **Core:** `google-books.test.ts` — `isLikelyIsbn` (10/13 digit, hyphens, non-ISBN, null) + `parseGoogleBooksVolume` (priced fixture, no-saleInfo fixture, empty `items`).
- **Service:** `price-tracking.test.ts` — module gate throws when disabled; `recordBookObservation` writes when ISBN + data present, skips non-ISBN; `refreshOrgBookPrices` skip-recent + cap logic (mock the client). Use `makeServiceContext`/`makeSupabaseStub`.
- **Action:** gate + delegation happy path.
- Target: tsc clean (core + web), all new tests green, no regression.

## Ship
Merge to `main` → push (Vercel web). **No mobile changes → no OTA.** **Apply migration 0163 to prod via `supabase db push --linked` immediately after merge** (agent's job now — see project memory). All reads fail closed (module off → panel hidden / cron skips), so the deploy is safe before the migration; the on-demand/cron writes are module-gated so they never touch `item_price_observations` until an org opts in (and 0163 is applied first).

## Out of scope (follow-ons)
1. Keepa/Amazon (paid, products + price history) via the full connector+Vault path.
2. A price-trend report/chart (the append-only history table supports it later).
3. Price-drop notifications.
4. Non-book identifier matching (UPC/EAN product lookups).
