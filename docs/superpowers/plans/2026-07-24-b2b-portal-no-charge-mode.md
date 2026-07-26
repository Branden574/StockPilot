# B2B Portal — No-Charge Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an organisation that does not charge its customers actually use the B2B portal, by making price display an org-level mode — and apply the three display decisions the owner made on 2026-07-24.

**Architecture:** The portal is already built and live (tables, RLS, invites, `/dashboard/customers`, `/portal`, checkout, history, returns). This plan does NOT rebuild any of it. It adds one org-level setting (`pricingMode`, stored in the existing `organization_modules.settings` jsonb for `b2b_portal`, defaulting to `no_charge`) and threads it through the single function that already gates everything — `portalCatalog()` in `apps/web/src/server/services/portal.ts`. Because checkout (`portalSubmitOrder`) re-validates every line against `portalCatalog()`'s exact return, changing that one function keeps read and write consistent by construction.

**Tech Stack:** TypeScript, Next.js 16 App Router (server actions, RSC), React, Supabase Postgres, vitest.

## Why this plan exists (read before starting)

The spec's original P1-P4 described building the portal from scratch. **That work is already shipped.** Verified 2026-07-24 in production: all five tables exist, `b2b_portal` is ENABLED for `L4L North Region` and `StockPilot Demo Co`, and Demo Co has a live customer, customer user and price list.

The blocker is one line — `apps/web/src/server/services/portal.ts`:

```ts
export async function portalCatalog(ctx: PortalContext): Promise<PortalCatalogItem[]> {
  if (!ctx.priceListId) return [];
```

L4L does not charge, so it has no price list, so its portal renders an empty catalog. That is why the module is switched on and unused.

## Global Constraints

- **Do NOT rebuild anything that exists.** Tables, RLS, invites, the portal shell, checkout, history and portal returns are shipped and working. This plan only changes price/quantity display and adds the org mode.
- **`portalCatalog()` is the single source of truth.** `portalSubmitOrder` re-validates against its exact return set (`portal.ts:275`). Any change to what the catalog exposes MUST leave checkout consistent — never widen the read without the write following automatically.
- **Never leak org-internal fields.** The module's contract (`portal.ts:39-41`) is that only name/sku/image/price/availability leave it — never cost, bin, or anything org-internal. Showing real quantity is now permitted; cost and bin are still forbidden.
- **`no_charge` is the DEFAULT.** An org with no explicit setting must behave as no-charge, so a misconfigured org can never accidentally display prices.
- **The public `/r/[token]` request link is out of scope and must not change.** It stays anonymous and price-free; it is a separate path for people without accounts, and both paths create ordinary `order_requests`.
- Settings live in `organization_modules.settings` jsonb keyed per module — the same pattern as `autoArchiveOnZeroStock` (see `apps/web/src/server/services/auto-archive.ts:12-17`).
- Cost price is NEVER exposed in either mode.
- No emojis in code, copy, or commit messages. No Claude co-author trailer.
- Live verification in production against **L4L North Region** (the org this unblocks) and **StockPilot Demo Co** (the org with an existing price list, to prove no regression in `priced` mode).

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/core/src/b2b/pricing-mode.ts` | The `PortalPricingMode` type + the pure resolver that reads the mode out of a settings jsonb, defaulting to `no_charge` | 1 |
| `packages/core/src/b2b/pricing-mode.test.ts` | Unit tests for the resolver | 1 |
| `apps/web/src/server/services/portal.ts` | Thread the mode into `portalCatalog()`; expose it on `PortalContext`; real quantity; unpriced-as-quotable | 2 |
| `apps/web/src/server/services/portal.pricing-mode.test.ts` | Catalog behaviour per mode, and the checkout-consistency guarantee | 2 |
| `apps/web/src/app/portal/page.tsx` + its catalog component | Hide prices/totals in `no_charge`; render "request quote" for unpriced in `priced`; show real quantity | 3 |
| `apps/web/src/server/actions/customers.ts` | Server action to read/write the org's `pricingMode` | 4 |
| `apps/web/src/app/(dashboard)/dashboard/customers/page.tsx` | The mode selector, and the "Customers" -> "Accounts" heading rename | 4 |
| `packages/core/src/modules/registry.ts:575` | Module title/nav label rename to "Accounts" | 4 |

---

## Task 1: The pricing-mode type and resolver

**Files:**
- Create: `packages/core/src/b2b/pricing-mode.ts`
- Create: `packages/core/src/b2b/pricing-mode.test.ts`
- Modify: `packages/core/src/index.ts` (export the new module alongside the other `b2b`/orders exports)

**Interfaces:**
- Consumes: nothing.
- Produces: `type PortalPricingMode = 'no_charge' | 'priced'` and `resolvePortalPricingMode(settings: unknown): PortalPricingMode`. Task 2 imports both from `@stockpilot/core`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { resolvePortalPricingMode } from './pricing-mode';

describe('resolvePortalPricingMode', () => {
  it('defaults to no_charge when there is no setting at all', () => {
    expect(resolvePortalPricingMode(null)).toBe('no_charge');
    expect(resolvePortalPricingMode(undefined)).toBe('no_charge');
    expect(resolvePortalPricingMode({})).toBe('no_charge');
  });

  it('reads an explicit mode', () => {
    expect(resolvePortalPricingMode({ pricingMode: 'priced' })).toBe('priced');
    expect(resolvePortalPricingMode({ pricingMode: 'no_charge' })).toBe('no_charge');
  });

  it('falls back to no_charge for an unrecognised value, never to priced', () => {
    expect(resolvePortalPricingMode({ pricingMode: 'PRICED' })).toBe('no_charge');
    expect(resolvePortalPricingMode({ pricingMode: 42 })).toBe('no_charge');
    expect(resolvePortalPricingMode('priced')).toBe('no_charge');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @stockpilot/core test -- --run pricing-mode`
Expected: FAIL — cannot resolve `./pricing-mode`.

- [ ] **Step 3: Implement**

```ts
/**
 * How an organisation's B2B portal treats money. Some orgs sell to their
 * customers; others (L4L North Region distributing to its schools) hand stock
 * out at no cost, where a price column, a request-quote action and an order
 * total are all meaningless.
 *
 * Stored per org in organization_modules.settings jsonb under `pricingMode`
 * for the b2b_portal module — the same per-module settings pattern as
 * autoArchiveOnZeroStock.
 */
export type PortalPricingMode = 'no_charge' | 'priced';

const MODES: readonly string[] = ['no_charge', 'priced'];

/**
 * Read the mode out of a module settings jsonb. Anything absent, malformed or
 * unrecognised resolves to `no_charge` — the safe direction, because a
 * misconfigured org must never accidentally display prices to a customer.
 */
export function resolvePortalPricingMode(settings: unknown): PortalPricingMode {
  if (!settings || typeof settings !== 'object') return 'no_charge';
  const raw = (settings as Record<string, unknown>).pricingMode;
  return typeof raw === 'string' && MODES.includes(raw) ? (raw as PortalPricingMode) : 'no_charge';
}
```

- [ ] **Step 4: Export it from the package index**

Add to `packages/core/src/index.ts`, beside the existing order/inventory exports:

```ts
export * from './b2b/pricing-mode';
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `pnpm --filter @stockpilot/core test -- --run pricing-mode && pnpm typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/b2b/pricing-mode.ts packages/core/src/b2b/pricing-mode.test.ts packages/core/src/index.ts
git commit -m "feat(b2b): org-level portal pricing mode, defaulting to no charge"
```

---

## Task 2: Honour the mode in the catalog

**Files:**
- Modify: `apps/web/src/server/services/portal.ts` (`PortalContext` ~:53, `resolvePortalContext` ~:97, `portalCatalog` ~:193-250)
- Create: `apps/web/src/server/services/portal.pricing-mode.test.ts`

**Interfaces:**
- Consumes: `PortalPricingMode`, `resolvePortalPricingMode` from `@stockpilot/core`.
- Produces: `PortalContext.pricingMode: PortalPricingMode`; `PortalCatalogItem` gains `quantityAvailable: number` and `quotable: boolean`. Task 3 renders both.

**What changes, precisely:**

| Mode | Which items appear | `unitPrice` | `quotable` |
|---|---|---|---|
| `no_charge` | Every allowlisted item (the price list is ignored entirely, and a missing price list is NOT an empty portal) | `null` | `false` |
| `priced` | Every allowlisted item — priced ones AND unpriced ones (previously unpriced were hidden) | the price, or `null` when unpriced | `true` when unpriced |

`quantityAvailable` carries the real `quantity_on_hand` in both modes (owner decision; replaces the in-stock badge).

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/server/services/portal.pricing-mode.test.ts`. Mock the admin client the same way the existing `apps/web/src/server/actions/portal.test.ts` does — read that file first and mirror its harness rather than inventing one.

```ts
describe('portalCatalog — pricing modes', () => {
  it('no_charge: returns every allowlisted item even with NO price list', async () => {
    // ctx.priceListId = null, allowlist = [itemA, itemB]
    const rows = await portalCatalog(ctxNoCharge);
    expect(rows.map((r) => r.itemId).sort()).toEqual([ITEM_A, ITEM_B]);
    expect(rows.every((r) => r.unitPrice === null)).toBe(true);
    expect(rows.every((r) => r.quotable === false)).toBe(true);
  });

  it('no_charge: ignores the price list entirely when one happens to exist', async () => {
    const rows = await portalCatalog(ctxNoChargeWithPriceList);
    expect(rows.every((r) => r.unitPrice === null)).toBe(true);
  });

  it('priced: shows unpriced allowlisted items as quotable rather than hiding them', async () => {
    // allowlist = [itemA (priced 12.5), itemB (no price entry)]
    const rows = await portalCatalog(ctxPriced);
    const a = rows.find((r) => r.itemId === ITEM_A);
    const b = rows.find((r) => r.itemId === ITEM_B);
    expect(a?.unitPrice).toBe(12.5);
    expect(a?.quotable).toBe(false);
    expect(b).toBeDefined();          // the old behaviour hid it
    expect(b?.unitPrice).toBeNull();
    expect(b?.quotable).toBe(true);
  });

  it('exposes the real on-hand quantity in both modes', async () => {
    expect((await portalCatalog(ctxNoCharge))[0]?.quantityAvailable).toBe(28);
    expect((await portalCatalog(ctxPriced))[0]?.quantityAvailable).toBe(28);
  });

  it('still excludes inactive, deleted and awaiting-first-receipt items in both modes', async () => {
    expect((await portalCatalog(ctxNoCharge)).map((r) => r.itemId)).not.toContain(ITEM_INACTIVE);
    expect((await portalCatalog(ctxNoCharge)).map((r) => r.itemId)).not.toContain(ITEM_EXPECTED);
  });

  it('still returns nothing when the allowlist is empty, in either mode', async () => {
    expect(await portalCatalog(ctxNoChargeEmptyAllowlist)).toEqual([]);
  });

  it('checkout accepts exactly what the catalog showed, in no_charge mode', async () => {
    const rows = await portalCatalog(ctxNoCharge);
    await expect(
      portalSubmitOrder(ctxNoCharge, [{ itemId: rows[0]!.itemId, quantity: 1 }]),
    ).resolves.toBeTruthy();
  });

  it('checkout still rejects an item that is not on the allowlist', async () => {
    await expect(
      portalSubmitOrder(ctxNoCharge, [{ itemId: ITEM_NOT_ALLOWED, quantity: 1 }]),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm --filter @stockpilot/web test -- --run portal.pricing-mode`
Expected: FAIL — `quotable`/`quantityAvailable` do not exist, and `no_charge` returns `[]`.

- [ ] **Step 3: Add the mode to the context**

In `portal.ts`, extend `PortalContext` with `pricingMode: PortalPricingMode`, and populate it in `resolvePortalContext()` by reading the org's `b2b_portal` row:

```ts
const { data: mod } = await admin
  .from('organization_modules')
  .select('settings')
  .eq('organization_id', customer.organization_id)
  .eq('module_id', 'b2b_portal')
  .maybeSingle();
const pricingMode = resolvePortalPricingMode((mod as { settings?: unknown } | null)?.settings);
```

Return `pricingMode` alongside `priceListId` in the context object.

- [ ] **Step 4: Rewrite the catalog gate**

Replace the `if (!ctx.priceListId) return [];` early return and the `prices.has(id)` intersection. The allowlist alone decides membership; the mode decides pricing:

```ts
  const admin = createAdminClient();
  const noCharge = ctx.pricingMode === 'no_charge';

  // In no_charge the price list is irrelevant — an org that does not charge has
  // no price list, and requiring one is what left its portal empty.
  const [catalogRows, priceRows] = await Promise.all([
    fetchAllAdmin<{ item_id: string }>((from, to) =>
      admin
        .from('customer_catalog')
        .select('item_id')
        .eq('customer_id', ctx.customerId)
        .order('item_id', { ascending: true })
        .range(from, to),
    ),
    noCharge || !ctx.priceListId
      ? Promise.resolve([] as Array<{ item_id: string; unit_price: number }>)
      : fetchAllAdmin<{ item_id: string; unit_price: number }>((from, to) =>
          admin
            .from('price_list_items')
            .select('item_id, unit_price')
            .eq('price_list_id', ctx.priceListId as string)
            .order('item_id', { ascending: true })
            .range(from, to),
        ),
  ]);

  const prices = new Map(priceRows.map((r) => [r.item_id, Number(r.unit_price) || 0]));
  // The ALLOWLIST alone decides what a customer can see. Previously an unpriced
  // item was filtered out here; the owner's 2026-07-24 decision is to show it
  // with a request-quote action instead.
  const ids = catalogRows.map((r) => r.item_id);
  if (ids.length === 0) return [];
```

Then in the mapping, replace the price and availability projections:

```ts
    unitPrice: noCharge ? null : (prices.get(i.id as string) ?? null),
    // Quotable = a priced org has no price for this item yet, so the customer
    // asks rather than buys. Never true in no_charge, where nothing is sold.
    quotable: !noCharge && !prices.has(i.id as string),
    // Real on-hand (owner decision 2026-07-24, replacing the in-stock badge).
    // Still never cost or bin — those remain org-internal.
    quantityAvailable: Number(i.quantity_on_hand) || 0,
```

Update the `PortalCatalogItem` type so `unitPrice` is `number | null` and the two new fields exist. Fix any resulting type errors at the call sites — `portalSubmitOrder`'s `unit_price_at_request` must write `0` when `unitPrice` is null (`byId.get(l.itemId)?.unitPrice ?? 0` already handles this; confirm it still compiles and behaves).

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @stockpilot/web test -- --run portal && pnpm typecheck`
Expected: the new file passes, the existing `portal.test.ts` still passes, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/services/portal.ts apps/web/src/server/services/portal.pricing-mode.test.ts
git commit -m "feat(b2b): catalog follows the org's pricing mode

A no-charge org has no price list, and requiring one is what left its portal
empty. The allowlist alone now decides what a customer sees; the mode decides
whether a price is shown. In a priced org an item with no price entry is shown
as quotable rather than hidden, and the real on-hand quantity is exposed in
both modes. Cost and bin stay org-internal."
```

---

## Task 3: Render it in the portal

**Files:**
- Modify: `apps/web/src/components/portal/portal-shop.tsx` (price at :168, in-stock badge at :159, per-order total at :245, cart total at :324, empty-state copy at :145, cart sum at :85-86)
- Modify: `apps/web/src/app/portal/page.tsx:63` (pass `pricingMode` into `PortalShop`)
- Create: `apps/web/src/components/portal/portal-shop.test.tsx` (no test file exists for this component yet)

**Interfaces:**
- Consumes: `PortalCatalogItem.unitPrice: number | null`, `.quotable: boolean`, `.quantityAvailable: number`, and `PortalContext.pricingMode`.
- Produces: nothing consumed by later tasks.

**THREE LANDMINES in the current component — all must be handled or the page crashes:**

1. `:168` renders `${item.unitPrice.toFixed(2)}`. `unitPrice` is now `number | null`, so this throws `Cannot read properties of null` the moment a no-charge or quotable item renders. This is the highest-risk line in the task.
2. `:85-86` sums the cart with `(byId.get(id)?.unitPrice ?? 0)` — already null-safe, but in `no_charge` the resulting total must not be RENDERED at all (`:324`), not merely rendered as `$0.00`.
3. `:145` currently reads "Your catalog is empty right now — your supplier hasn't priced…". That copy is exactly what L4L sees today and becomes wrong once a no-charge org has a populated catalog. In `no_charge` the empty state must instead say the supplier has not added items to this account's catalog yet.

Also note the component consumes `item.inStock` (a boolean) at `:159`. Task 2 replaces that projection with `quantityAvailable`; keep `inStock` on the type only if something else still reads it, otherwise remove it in the same change so there is one availability concept, not two.

**Required behaviour:**
- `no_charge`: no price on any row, no per-order total, no cart total anywhere. The cart still shows quantities and submits normally.
- `priced`, item priced: unchanged from today.
- `priced`, item quotable: show "Request quote" in place of the price. Still orderable — the line simply carries no price, which the existing `unit_price_at_request ?? 0` fallback already records.
- Both modes: show the real available quantity instead of the in-stock badge.

- [ ] **Step 1: Write the failing component test**

Create `apps/web/src/components/portal/portal-shop.test.tsx`. Mirror the render/mock conventions of `apps/web/src/components/orders/manager-actions-panel.test.tsx` (same app, same testing-library setup) — read it first for the `next/navigation` and server-action mocks.

```tsx
const ITEM = {
  itemId: 'i-1',
  name: 'Composition Notebook',
  sku: 'NB-001',
  imageUrl: null,
  quantityAvailable: 28,
};

function renderShop(over: Partial<React.ComponentProps<typeof PortalShop>>) {
  return render(
    <PortalShop catalog={[]} orders={[]} returnsEnabled={false} pricingMode="no_charge" {...over} />,
  );
}

describe('PortalShop — no_charge', () => {
  it('renders no price, and does not crash on a null unitPrice', () => {
    renderShop({ catalog: [{ ...ITEM, unitPrice: null, quotable: false }] });
    expect(screen.getByText('Composition Notebook')).toBeInTheDocument();
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });

  it('shows the real available quantity instead of an in-stock badge', () => {
    renderShop({ catalog: [{ ...ITEM, unitPrice: null, quotable: false }] });
    expect(screen.getByText(/28/)).toBeInTheDocument();
    expect(screen.queryByText(/Backorder/i)).not.toBeInTheDocument();
  });

  it('renders no cart total once an item is added', async () => {
    const user = userEvent.setup();
    renderShop({ catalog: [{ ...ITEM, unitPrice: null, quotable: false }] });
    await user.click(screen.getByRole('button', { name: /Add one Composition Notebook/i }));
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });

  it('the empty state does not blame pricing', () => {
    renderShop({ catalog: [] });
    expect(screen.queryByText(/priced/i)).not.toBeInTheDocument();
  });
});

describe('PortalShop — priced', () => {
  it('renders the price for a priced item', () => {
    renderShop({ pricingMode: 'priced', catalog: [{ ...ITEM, unitPrice: 12.5, quotable: false }] });
    expect(screen.getByText('$12.50')).toBeInTheDocument();
  });

  it('offers a quote instead of a price for an unpriced item, and still allows ordering', () => {
    renderShop({ pricingMode: 'priced', catalog: [{ ...ITEM, unitPrice: null, quotable: true }] });
    expect(screen.getByText(/Request quote/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add one Composition Notebook/i })).toBeEnabled();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @stockpilot/web test -- --run portal-shop`
Expected: FAIL — `pricingMode` is not a prop, and the priced-null case throws on `.toFixed`.

- [ ] **Step 3: Implement the conditional rendering**

Add `pricingMode: PortalPricingMode` to `PortalShop`'s props and pass it from `page.tsx:63` (`<PortalShop … pricingMode={ctx.pricingMode} />`). Do not re-derive the mode inside a child. Then guard each of the four money sites (`:168`, `:245`, `:324`, and the `:85-86` sum's rendering) and swap the `:159` badge for the quantity. Suggested shape for the row price:

```tsx
{pricingMode === 'no_charge' ? null : item.quotable ? (
  <p className="text-muted-foreground shrink-0 text-sm">Request quote</p>
) : (
  <p className="shrink-0 font-mono text-sm">${(item.unitPrice ?? 0).toFixed(2)}</p>
)}
```

- [ ] **Step 4: Run the tests, typecheck and lint**

Run: `pnpm --filter @stockpilot/web test -- --run portal && pnpm typecheck && pnpm --filter @stockpilot/web lint`
Expected: all green, including the pre-existing `portal.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/portal apps/web/src/app/portal
git commit -m "feat(b2b): portal hides prices in a no-charge org and offers quotes for unpriced items"
```

---

## Task 4: The org setting, and the Accounts rename

**Files:**
- Modify: `apps/web/src/server/actions/customers.ts` (add the mode read/write action)
- Modify: `apps/web/src/app/(dashboard)/dashboard/customers/page.tsx` (mode selector; heading rename)
- Modify: `packages/core/src/modules/registry.ts:575` (module `title`)

**Interfaces:**
- Consumes: `PortalPricingMode`, `resolvePortalPricingMode`.
- Produces: nothing.

- [ ] **Step 1: Write the failing action test**

Create `apps/web/src/server/actions/customers.pricing-mode.test.ts`. Mirror the mocking style of the existing action tests in that directory (they mock the service layer and the auth context; read one first).

```ts
describe('setPortalPricingModeAction', () => {
  it('rejects a value outside the two modes', async () => {
    const res = await setPortalPricingModeAction('free' as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('validation_error');
  });

  it('accepts no_charge and priced', async () => {
    expect((await setPortalPricingModeAction('no_charge')).ok).toBe(true);
    expect((await setPortalPricingModeAction('priced')).ok).toBe(true);
  });

  it('MERGES into the existing settings jsonb rather than replacing it', async () => {
    // existing settings on the b2b_portal row: { someOtherFlag: true }
    await setPortalPricingModeAction('priced');
    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: { someOtherFlag: true, pricingMode: 'priced' },
      }),
      expect.anything(),
    );
  });

  it('surfaces a permission failure rather than writing', async () => {
    permissionSpy.mockImplementationOnce(() => {
      throw new ServiceError('forbidden', 'Missing permission');
    });
    const res = await setPortalPricingModeAction('priced');
    expect(res.ok).toBe(false);
    expect(upsertSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @stockpilot/web test -- --run customers.pricing-mode`
Expected: FAIL — `setPortalPricingModeAction` is not exported.

- [ ] **Step 3: Implement the action**

Add to `apps/web/src/server/actions/customers.ts`, following that file's existing shape exactly (`ActionResult`, `err`/`ok`, `toResult`, the same service-resolution helper the sibling actions use at `:44`):

```ts
const pricingModeSchema = z.enum(['no_charge', 'priced']);

/**
 * Set how this org's portal treats money. Merges into the b2b_portal module's
 * settings jsonb — a replace would wipe any other setting stored there.
 */
export async function setPortalPricingModeAction(
  mode: PortalPricingMode,
): Promise<ActionResult<void>> {
  const parsed = pricingModeSchema.safeParse(mode);
  if (!parsed.success) return err('validation_error', 'Invalid pricing mode');
  const { svc, error } = await resolveCustomersService();
  if (error || !svc) return error as ActionResult<never>;
  try {
    await svc.setPricingMode(parsed.data);
    revalidatePath('/dashboard/customers');
    revalidatePath('/portal');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}
```

Add the matching `setPricingMode(mode)` to `CustomersService` in `apps/web/src/server/services/customers.ts`, asserting `customers:manage` the same way its siblings do at `:54-55`, reading the current `settings`, spreading it, and writing back.

- [ ] **Step 4: Add the selector and rename**

On `apps/web/src/app/(dashboard)/dashboard/customers/page.tsx`, add a two-option control wired to the action:

- "This organisation does not charge its customers" — with helper text: "The portal shows no prices and no order totals."
- "Customers are charged from a price list" — with helper text: "Each account's price list sets what it pays. Items with no price show a request-quote option."

Rename the page heading to **Accounts**, and set the module `title` at `packages/core/src/modules/registry.ts:575` to `'Accounts'` so the nav label follows. Leave the table names, the route `/dashboard/customers`, and the `customers:manage` permission id unchanged — this is a label-only rename.

- [ ] **Step 5: Run the full web suite, typecheck and lint**

Run: `pnpm --filter @stockpilot/web test -- --run && pnpm typecheck && pnpm --filter @stockpilot/web lint`
Expected: all green. A stale test asserting the "Customers" heading may need updating — update it, do not delete it.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/actions/customers.ts "apps/web/src/app/(dashboard)/dashboard/customers/page.tsx" packages/core/src/modules/registry.ts
git commit -m "feat(b2b): per-org pricing mode setting, and rename the nav to Accounts"
```

---

## Task 5: Live verification and L4L setup

**Files:** none — this task is verification against production.

- [ ] **Step 1: Prove no regression in a priced org**

In **StockPilot Demo Co** (which has a live customer, customer user and price list, and must remain in `priced` mode): open the portal as that customer, confirm prices still render for priced items, confirm a previously-hidden unpriced allowlisted item now appears as "Request quote", and confirm the real quantity shows.

- [ ] **Step 2: Set L4L to no-charge and create a real Account**

In **L4L North Region**: set the mode to no-charge, create an Account for one school, add a handful of items to its catalog, and invite a user. Confirm the invite email arrives through the existing `generateLink` + Resend path (NEVER `inviteUserByEmail`).

- [ ] **Step 3: Walk the customer flow end to end**

Accept the invite, sign in to the portal, confirm the catalog is NOT empty (the bug this plan fixes), confirm no price or total appears anywhere, place an order, and confirm it lands in L4L's normal approval queue as an ordinary `order_request` alongside internal requests.

- [ ] **Step 4: Confirm the public link is untouched**

Load L4L's existing `/r/[token]` page and confirm it still works exactly as before, with no prices. Both external paths must coexist.

- [ ] **Step 5: Record the outcome**

Append the verified results to the SDD ledger, and update the outstanding-tasks memory — the entry claiming the portal "needs owner review before P1" is stale and must be replaced with what is actually shipped.

---

## Out of scope

Anything requiring a charging customer org: per-customer price list assignment UI beyond what exists, quote workflows beyond the display affordance, payments or invoicing. The public `/r/[token]` link. Mobile parity for Accounts management (the portal itself is web-first by design; revisit once L4L is actually using it).

## Risks

1. **Checkout drift.** `portalSubmitOrder` re-validates against `portalCatalog()`'s exact return. The plan changes what that set contains, which is intentional and keeps the two consistent — but Task 2's last two tests exist specifically to prove the widened catalog did not widen what checkout accepts beyond the allowlist.
2. **A priced org silently flipping to no-charge.** The default is `no_charge`, so an org that DOES charge and has no explicit setting would stop showing prices. Demo Co is exactly this case — Step 1 of Task 5 must set it to `priced` explicitly before verifying, and the implementer should check for any other org with a non-empty `price_lists` before shipping.
3. **Real quantities are now visible to customers.** An accepted owner tradeoff, recorded in the spec. It is a display-layer change and reversible.
