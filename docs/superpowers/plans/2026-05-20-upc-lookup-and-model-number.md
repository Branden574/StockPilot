# UPC Lookup + Model Number — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. After every subagent reports DONE, controller MUST run `pnpm typecheck && pnpm lint && pnpm test` from `apps/web` per project memory.

**Goal:** Add `model_number` field to inventory items + UPC enrichment flow (UPCitemdb free + Gemini for description only) wired into the desktop item form and mobile scanner.

**Spec:** `docs/superpowers/specs/2026-05-20-upc-lookup-and-model-number-design.md`

**Architecture recap:**
- Lookup chain: local DB → UPCitemdb free trial → Gemini (description-only fallback)
- New endpoint: `GET /api/v1/items/upc-lookup?upc=<code>`
- New column: `inventory_items.model_number text null`
- Desktop: new field + "Lookup by barcode" button
- Mobile: scan → not found → tries enrichment → AddItemCard for one-tap save

---

## Task 1: Migration 0133 — model_number column

**Files:** Create `supabase/migrations/0133_inventory_model_number.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0133_inventory_model_number.sql
--
-- Adds inventory_items.model_number — the manufacturer's per-SKU
-- model identifier (e.g. Beats Solo 3 = MX432LL/A). Distinct from
-- SKU (org's internal code) and barcode (UPC/EAN). Per-SKU not
-- per-unit so it's a column on inventory_items, not a separate
-- inventory_units table.
--
-- Backed by the UPC-lookup chain (UPCitemdb → AI description) so
-- the field can be autofilled when scanning a new product. Existing
-- rows stay NULL — fill going forward only.

alter table public.inventory_items
  add column if not exists model_number text;

-- Search support. Partial index — most items won't have a model
-- number so the where-clause keeps the index lean.
create index if not exists inventory_items_model_number_idx
  on public.inventory_items(organization_id, model_number)
  where model_number is not null and deleted_at is null;
```

- [ ] **Step 2: Commit + push, pause for user to apply**

---

## Task 2: Zod schemas + InventoryService thread-through

**Files:**
- Modify `packages/core/src/schemas/inventory.ts`
- Modify `apps/web/src/server/services/inventory.ts`

- [ ] **Step 1: Add modelNumber to createItemSchema + updateItemSchema**

```typescript
modelNumber: z.string().trim().max(120).nullable().optional(),
```

- [ ] **Step 2: Thread through InventoryService.create**

In the insert payload, add `model_number: input.modelNumber ?? null`.

- [ ] **Step 3: Thread through InventoryService.update**

In the update patch, add `if (patch.modelNumber !== undefined) updates.model_number = patch.modelNumber ?? null;`.

- [ ] **Step 4: Extend the search filter in InventoryService.list**

Find the existing `q` filter block (around line 200). Add `model_number.ilike.%${term}%` to the `.or(...)` clause so search hits model number too:

```typescript
query = query.or(
  `name.ilike.%${term}%,sku.ilike.%${term}%,barcode.ilike.%${term}%,model_number.ilike.%${term}%`,
);
```

- [ ] **Step 5: Verify build**

```bash
cd "/Users/brandenvincent-walker/Desktop/Inventory System App/apps/web"
pnpm typecheck && pnpm lint && pnpm test
```

- [ ] **Step 6: Commit + push**

---

## Task 3: UPC lookup library (TDD)

**Files:**
- Create `apps/web/src/lib/upc-lookup.ts`
- Create `apps/web/src/lib/upc-lookup.test.ts`

The library exports one function:

```typescript
export async function lookupUpc(upc: string): Promise<UpcLookupResult>;

export interface UpcLookupResult {
  source: 'upcitemdb' | 'ai-fallback' | 'none';
  enrichment: {
    name: string | null;
    description: string | null;
    modelNumber: string | null;
    brand: string | null;
    imageUrl: string | null;
  };
}
```

- [ ] **Step 1: Write failing tests**

Cases to cover:
- UPCitemdb returns a clean hit → `source='upcitemdb'`, all fields filled
- UPCitemdb returns 200 with empty items array → falls through, `source='none'`
- UPCitemdb returns 429 (rate-limited) → falls through, `source='none'` (no name to feed AI)
- UPCitemdb hit with empty description → AI is called to fill description → `source='ai-fallback'`, name/brand/model from UPCitemdb, description from AI
- UPCitemdb hit with description present → AI is NOT called → `source='upcitemdb'`
- UPCitemdb returns hit, AI is mocked to fail → returns UPCitemdb data with `description: null`, NOT an error
- Empty/null UPC string → throws or returns `none` immediately (no network call)

Mock `fetch` for UPCitemdb and the Gemini SDK for the AI part.

- [ ] **Step 2: Run tests, expect FAIL**

- [ ] **Step 3: Implement `upc-lookup.ts`**

Structure:

```typescript
import 'server-only';

const UPCITEMDB_URL = 'https://api.upcitemdb.com/prod/trial/lookup';
const FETCH_TIMEOUT_MS = 5000;

export async function lookupUpc(upc: string): Promise<UpcLookupResult> {
  // 1. UPCitemdb
  const upcdb = await tryUpcitemdb(upc);

  // 2. If UPCitemdb returned a name+brand but no description,
  //    ask AI to fill the description ONLY.
  if (upcdb && upcdb.name && !upcdb.description) {
    const aiDesc = await tryAiDescription(upcdb.name, upcdb.brand);
    return {
      source: aiDesc ? 'ai-fallback' : 'upcitemdb',
      enrichment: { ...upcdb, description: aiDesc },
    };
  }

  if (upcdb) {
    return { source: 'upcitemdb', enrichment: upcdb };
  }

  return {
    source: 'none',
    enrichment: { name: null, description: null, modelNumber: null, brand: null, imageUrl: null },
  };
}

async function tryUpcitemdb(upc: string): Promise<Enrichment | null> { ... }
async function tryAiDescription(name: string, brand: string | null): Promise<string | null> { ... }
```

Per the spec: AI is NEVER called to invent name / model / brand. Only description, only when there's already a name + brand to anchor it.

- [ ] **Step 4: Run tests, expect PASS**

- [ ] **Step 5: Commit + push**

---

## Task 4: UPC lookup endpoint

**Files:** Create `apps/web/src/app/api/v1/items/upc-lookup/route.ts`

- [ ] **Step 1: Write the endpoint**

```typescript
import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { lookupUpc } from '@/lib/upc-lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const url = new URL(req.url);
  const raw = (url.searchParams.get('upc') ?? '').trim();
  if (!raw) {
    return NextResponse.json({ error: 'upc is required' }, { status: 400 });
  }
  // Defensive — UPC/EAN codes are digits-only, 8-14 chars.
  if (!/^\d{8,14}$/.test(raw)) {
    return NextResponse.json({ error: 'invalid_upc' }, { status: 400 });
  }

  // 1. Check our own DB first so we don't burn an upstream API call
  //    on something we already track.
  const { data: existing } = await ctx.supabase
    .from('inventory_items')
    .select('id, sku, name, model_number, quantity_on_hand')
    .eq('organization_id', ctx.organizationId)
    .eq('barcode', raw)
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle();

  if (existing) {
    const row = existing as { id: string; sku: string; name: string; model_number: string | null; quantity_on_hand: number };
    return NextResponse.json({
      source: 'local',
      existsInInventory: true,
      itemId: row.id,
      enrichment: {
        name: row.name,
        description: null,
        modelNumber: row.model_number,
        brand: null,
        imageUrl: null,
      },
    });
  }

  // 2. External lookup chain (UPCitemdb → AI).
  const result = await lookupUpc(raw);

  if (result.source === 'none') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  return NextResponse.json({
    source: result.source,
    existsInInventory: false,
    enrichment: result.enrichment,
  });
}
```

- [ ] **Step 2: Verify build + commit**

---

## Task 5: Desktop item form — model number field + lookup button

**Files:** Modify `apps/web/src/components/inventory/item-form.tsx`

- [ ] **Step 1: Add the input field**

Find the existing barcode field (likely after SKU). Add a model number input below it:

```tsx
<div className="space-y-1.5">
  <Label htmlFor="item-model-number">
    Model number
    <span className="ml-1 text-xs font-normal text-muted-foreground">(optional)</span>
  </Label>
  <Input
    id="item-model-number"
    value={modelNumber}
    onChange={(e) => setModelNumber(e.target.value)}
    placeholder="e.g. MX432LL/A"
    maxLength={120}
  />
</div>
```

- [ ] **Step 2: Add a "Lookup by barcode" button**

Next to the barcode input, add a button that fires the UPC lookup:

```tsx
<Button
  type="button"
  variant="outline"
  size="sm"
  disabled={!barcode.trim() || lookupBusy}
  onClick={runUpcLookup}
>
  {lookupBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
  Lookup
</Button>
```

`runUpcLookup` calls `/api/v1/items/upc-lookup?upc=<barcode>`. On success, pre-fills name (if empty), description (if empty), model number, and optionally the image (download → existing image-upload pipeline).

DO NOT overwrite fields the user has already typed — only fill empties.

- [ ] **Step 3: Wire modelNumber into the submit payload**

The existing `submit` function builds an input object passed to `createItemAction` / `updateItemAction`. Add `modelNumber: modelNumber.trim() || null` to that object.

- [ ] **Step 4: Verify build + commit**

---

## Task 6: Item detail — show model number

**Files:** Modify `apps/web/src/components/inventory/item-detail.tsx`

- [ ] **Step 1: Add to the details panel**

Find the existing details/specs section (around the SKU + barcode display). Add a row that renders `item.model_number` when non-null:

```tsx
{item.model_number && (
  <div className="flex justify-between gap-3">
    <dt className="text-muted-foreground">Model</dt>
    <dd className="break-all text-right font-mono text-xs">
      {item.model_number}
    </dd>
  </div>
)}
```

- [ ] **Step 2: Verify build + commit**

---

## Task 7: Mobile AddItemCard component

**Files:** Create `apps/mobile/src/components/AddItemCard.tsx`

Parallel to the existing `AddBookCard.tsx`. Props:

```typescript
interface Props {
  upc: string;
  enrichment: {
    name: string | null;
    description: string | null;
    modelNumber: string | null;
    brand: string | null;
    imageUrl: string | null;
  };
  source: 'upcitemdb' | 'ai-fallback';
  warehouseId: string;
  onSaved: (item: { id: string; name: string }) => void;
  onCancel: () => void;
}
```

Renders:
- Title from enrichment.name (editable)
- Description (editable, multi-line)
- Model number (editable)
- Brand (read-only display)
- Image preview (when imageUrl present)
- Quantity input (default 1)
- "Add to inventory" button → calls `createItemAction` with the data

If `source === 'ai-fallback'`, show a small badge "AI-written description — please review" so the user knows to verify before saving.

- [ ] **Step 1: Implement the component, mirroring AddBookCard.tsx layout**

- [ ] **Step 2: Commit + push**

---

## Task 8: Mobile scanner — wire the fallback flow

**Files:** Modify `apps/mobile/app/(drawer)/(tabs)/scan.tsx`

- [ ] **Step 1: Update the scan-handler**

After the existing `/api/v1/items/lookup` returns 404 (not in inventory):

1. Currently: shows "not in inventory" + ISBN-add option if applicable
2. New: if barcode is digits-only AND length 8-14 (looks like UPC/EAN), call `/api/v1/items/upc-lookup`
3. If lookup returns enrichment: show `<AddItemCard>`
4. If lookup returns 404: fall through to manual "Add item" flow

ISBN-add still wins for 13-digit codes starting with 978/979 (book ISBNs). Keep that branch first.

- [ ] **Step 2: Commit + push**

---

## Task 9: Final E2E + verification

- [ ] **Step 1: Manual test on prod (after deploy)**

1. Scan a real consumer UPC (e.g., a brand-new pair of headphones at home that aren't in inventory).
2. Verify the AddItemCard pops with name/description/model/image pre-filled.
3. Save → confirm new row in `/dashboard/inventory` with model number populated.
4. On desktop: type the same UPC into the barcode field of a new item, click Lookup, verify the same autofill behavior.
5. Search "MX432" (partial model number) in `/dashboard/inventory` → confirms the search filter picks it up.
6. Try a fake UPC like `99999999999` → graceful "couldn't find" message.

- [ ] **Step 2: Final test + lint sweep**

```bash
cd apps/web && pnpm typecheck && pnpm lint && pnpm test
```

- [ ] **Step 3: Final commit if any cleanup needed**

---

## Self-review

**Coverage:**
- Migration → Task 1
- Schema + service threading → Task 2
- Lookup library + tests → Task 3
- Endpoint → Task 4
- Desktop UI → Task 5
- Detail display → Task 6
- Mobile UI → Tasks 7-8
- Verification → Task 9

**Risk areas:**
- UPCitemdb free trial uses a public endpoint with IP-based 100/day cap. If you're on a NAT'd corporate network sharing the IP with many users, the cap may exhaust faster than expected. Mitigation: the AI fallback still kicks in for descriptions; just won't have title/brand for new products.
- Image-pipeline downloading a remote UPCitemdb image URL needs to handle redirects + size caps. Reuse the existing image-uploader's pipeline rather than building a parallel one.

**Hard-fail conditions:**
- AI invents a model number or product name (must never happen — strict prompt + tests).
- Existing item create/edit flow breaks for items that don't have a model number (model_number defaults to null; no required state).
