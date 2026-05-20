# UPC Lookup + Model Number Field — Design

**Date:** 2026-05-20
**Status:** Draft (awaiting user review)
**Owner:** Branden

## Problem

Today the mobile scanner only enriches **books** (ISBN → title/author/cover via Google Books → Open Library → ISBNDB). For any non-book item — electronics, supplies, swag, tools — scanning a UPC/EAN barcode dead-ends with "not in inventory" because we have no enrichment chain for those codes.

This forces staff to hand-type every new non-book item. Slow + error-prone.

Separately, the spec calls for a **Model Number** field on items (e.g., Beats Solo 3 model `MX432LL/A`). Model number is per-SKU (same for every unit of the same product) and useful for warranty lookups, reordering, and vendor cross-referencing. Cleaner concept than per-unit Serial Number.

## Goals

- Add a `model_number` text field to `inventory_items`. Visible on the item form + detail page; searchable.
- Scan a UPC on the mobile app → if not in our DB, fetch product info (name, description, model number, image) from an external chain → one-tap add to inventory with the form pre-filled.
- Desktop item form: a "Lookup by barcode" button that runs the same enrichment chain and pre-fills the form.
- Optional AI fallback: if external lookup returns thin data, ask Gemini to flesh out the description.

## Non-goals

- Per-unit serial number tracking (rejected by user; model number is the right granularity)
- Bulk-enrichment of existing items (manual, one-by-one going forward)
- Paid lookup services (start with free UPCitemdb; can swap to Barcodelookup later if coverage gaps hurt)
- Multi-source disambiguation UI (if two sources return different titles, take the first hit and let the user edit)

## Design

### Lookup chain (in order)

1. **Local DB** — check `inventory_items.barcode = <code>` first. If a row exists, return it (current behavior).
2. **UPCitemdb** — free tier (100 req/day, ~3000/month for a school's volume is plenty). Returns title, brand, manufacturer, model number, description, image URLs.
3. **Gemini AI fallback** — if UPCitemdb has no match OR returns thin data (no description), ask Gemini to write a 2-sentence description from the title + brand. Only writes description; never guesses model numbers (would hallucinate).

If everything fails → return `not_found`. Mobile + desktop both show "Couldn't find — please fill in manually" with the barcode pre-populated.

### Schema change

```sql
alter table public.inventory_items
  add column if not exists model_number text;

-- Index for search.
create index if not exists inventory_items_model_number_idx
  on public.inventory_items(organization_id, model_number)
  where model_number is not null and deleted_at is null;
```

No backfill — column is nullable; existing rows stay NULL.

### API endpoint

`GET /api/v1/items/upc-lookup?upc=<code>`

Response shape (success):

```typescript
{
  source: 'local' | 'upcitemdb' | 'ai-fallback',
  existsInInventory: boolean,
  itemId?: string,           // when source = 'local'
  enrichment: {
    name: string,
    description: string | null,
    modelNumber: string | null,
    brand: string | null,
    imageUrl: string | null,
  }
}
```

Response (no match): `{ error: 'not_found' }` with HTTP 404.

### UPCitemdb integration

- Free tier: no API key needed for the `trial` endpoint, capped at 100/day per IP.
- Free trial endpoint: `GET https://api.upcitemdb.com/prod/trial/lookup?upc=<code>` returns JSON with `items: [...]`.
- We extract: `title` → name, `description`, `model` → modelNumber, `brand`, `images[0]` → imageUrl.
- Rate-limit handling: 429 response → log + fall through to AI fallback.

If/when we exceed the trial cap, we add a paid `UPCITEMDB_API_KEY` env var. The code path supports both.

### Gemini — DESCRIPTION ONLY

**Strict rule:** Gemini is ONLY used to write or enhance a description. It is NEVER asked to:
- Guess a name, title, or product
- Guess a model number
- Guess a brand
- Identify a UPC

The risk we're avoiding: AI models hallucinate identifying details. A wrong description is annoying; a wrong model number under warranty paperwork is a real problem.

Used when:
- UPCitemdb returned a `name` + `brand` but `description` is empty/null → AI fills the description gap
- OR User has manually typed a `name` and clicks "Enhance description" → AI expands the 2-3 sentence write-up

Prompt template: *"Write a 2-sentence inventory description for: '{name}' by {brand}. Focus on practical attributes useful to a warehouse manager (size, color, key features). Do not invent product specs."*

If UPCitemdb returns NOTHING (no name + no brand), Gemini is NOT called — there's nothing for it to describe. The user gets a "couldn't find" message and types it manually.

### UI surfaces

#### Mobile scan flow (apps/mobile/app/(drawer)/(tabs)/scan.tsx)

Current flow:
1. Camera reads barcode
2. POST to `/api/v1/items/lookup?code=<barcode>`
3. If found → show item card
4. If not found → "Not in inventory"

New flow:
1. Camera reads barcode
2. POST to `/api/v1/items/lookup?code=<barcode>`
3. If found → show item card (unchanged)
4. If not found → POST to `/api/v1/items/upc-lookup?upc=<barcode>`
5. If lookup succeeds → show `AddItemCard` (parallel to `AddBookCard`) with name/description/modelNumber/image pre-filled, one tap to save
6. If lookup fails → show manual "Add item" form with the barcode pre-populated

#### Desktop item form (apps/web/src/components/inventory/item-form.tsx)

- New text input "Model number" between SKU and Description fields
- "Lookup by barcode" button next to the Barcode field — when clicked, runs `/api/v1/items/upc-lookup` and pre-fills name + description + modelNumber + image (the existing image-upload accepts a remote URL → downloads → re-compresses).

#### Inventory list

- Add model number as a search target (alongside name, sku, barcode in the `q` filter).
- Optional column toggle (defer unless requested) — not on by default since most items won't have it.

## Files to add

- `supabase/migrations/0133_inventory_model_number.sql` — column + index
- `apps/web/src/lib/upc-lookup.ts` — chain implementation (UPCitemdb + Gemini)
- `apps/web/src/app/api/v1/items/upc-lookup/route.ts` — endpoint
- `apps/web/src/lib/upc-lookup.test.ts` — unit tests for the chain
- `apps/mobile/src/components/AddItemCard.tsx` — parallel to AddBookCard

## Files to modify

- `packages/core/src/schemas/inventory.ts` — add `modelNumber: z.string().max(120).nullable().optional()` to `createItemSchema` + `updateItemSchema`
- `apps/web/src/server/services/inventory.ts` — thread `model_number` through `create` + `update`
- `apps/web/src/components/inventory/item-form.tsx` — new field + Lookup button
- `apps/web/src/components/inventory/item-detail.tsx` — show model number in the details panel
- `apps/web/src/server/services/inventory.ts` — extend `list()` `q` filter to also match model_number
- `apps/mobile/app/(drawer)/(tabs)/scan.tsx` — wire the fallback lookup flow

## Open questions (locked)

- ~~Per-unit serial tracking~~ — Rejected. Model number only.
- ~~Free vs paid lookup~~ — Free UPCitemdb trial to start. Path to paid via env var if needed.
- ~~Backfill existing items~~ — No; nullable column, fill going forward.

## Acceptance criteria

1. New `model_number` field visible on item form + detail page.
2. Existing items work unchanged (`model_number` is NULL on all current rows).
3. Mobile: scan a UPC for a known consumer product (e.g., a brand-name pair of headphones with a real UPC) → lookup succeeds → AddItemCard shows pre-filled name + description + model number + image. One-tap save creates the item.
4. Desktop: type a UPC into the barcode field, click "Lookup by barcode" → form auto-fills.
5. Lookup failures (random/fake UPC) → graceful "couldn't find" message, manual entry still works.
6. UPCitemdb rate-limited (429) → AI fallback engages; description still useful.
7. Search "Beats Solo" returns items where model number is `MX432LL/A` AND items where name contains "Beats Solo." Search by partial model number works.

## Edge cases

| Case | Behavior |
| --- | --- |
| UPC returns multiple hits | Take the first; user can edit before saving. |
| UPCitemdb is down | 5-second timeout → fall through to AI fallback (description only). |
| AI fallback returns garbage | User edits before saving. Worst case = same as today (manual entry). |
| Barcode is an ISBN (book) | Existing ISBN flow takes priority (already in `/api/v1/items/lookup`). |
| Barcode is a vendor SKU not a UPC | UPCitemdb returns no match → AI fallback may try, usually fails → manual entry. |
| User scans the same UPC twice | Local DB check finds the existing row → shows the existing item card (current behavior). |

## Audit + privacy

- UPC lookups don't transmit any org-specific data to UPCitemdb (just the barcode).
- No new audit events needed (created item still emits `inventory.item.created`).

## Out of scope (future)

- Per-unit SN tracking (`inventory_units` table) — defer
- Bulk-enrichment of existing items — defer
- Vendor catalog cross-referencing (e.g., Amazon ASIN lookup) — defer
- Image-based recognition (point camera at item without a barcode, AI identifies it) — defer
- Warranty lookup integration — defer
