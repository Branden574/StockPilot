# Orders "Place an Order" Storefront Redesign — Implementation Plan

> **For agentic workers:** execute stage-by-stage; after each stage run tsc + eslint, and at the end the full gate (tests, build, demo-org Playwright visual pass vs the prototype). The spec is `design_handoff_storefront_order_page/README.md` (in repo root) + the reference implementation in `design_handoff_storefront_order_page/design/` — **the prototype CSS/JSX is the source of truth for exact values.** Owner approved: follow PROMPT.md exactly.

**Goal:** replace the UI of `/dashboard/orders/new` with the storefront design (setup bar, flow indicator, sticky toolbar, frequently-ordered carousel, category-grouped product grid + compact list, sticky Order Cart, quick-view drawer, review modal → success) — keeping the existing app shell and ALL existing functionality/API contracts.

## Locked decisions
1. **New component dir** `apps/web/src/components/orders/storefront/` — the old `v2/` components stay untouched (they're shared by the PUBLIC portal `public-v2/public-orders-v2.tsx` and `rentals/rental-create-form.tsx`, which are OUT of scope).
2. **Reuse `v2/cart-context.tsx` + `v2/types.ts` verbatim** (CartProvider, cartReducer, draft persistence, `initialCartState`). Storefront components are new presentational skins over the same state.
3. **Submit contract unchanged:** `createOrderRequestAction({ warehouseId, notes, fulfillmentType, requesterPhone: null, deliveryCharterId, pickupLocationNotes: null, onBehalfOf, lines })` then `clearCartDraft(warehouseId)` + `router.push('/dashboard/orders/'+id)`. In the new flow, submission happens from the **review modal**; the success state shows the returned order ref with "View order" linking to it (do NOT auto-navigate — navigate on "View order"; "Done" clears cart + closes).
4. **Page loader** `(dashboard)/dashboard/orders/new/page.tsx` keeps its exact data fetching (warehouses, items→CatalogItem[], aisles, chartersForWarehouse, viewerRole) and swaps `<OrdersNewV2>` → `<OrdersStorefront>`; ALSO pass `viewerName`/`viewerEmail` (from ctx/user_profiles) for the "Requesting for → Myself" cell.
5. **Design tokens scoped, not global:** all CSS lives in `storefront/storefront.css` with every rule under `.sp-storefront` (page wrapper). Import from the storefront root component (App Router allows global CSS imports from components). Tokens = CSS vars per README §Design Tokens. Do NOT touch the app's global theme.
6. **Data mappings:** "site" (Deliver to) = charter (`chartersForWarehouse`, sets `charterId`); availability per item = `quantityOnHand - reservedQuantity` (match v2's math — check `item-card.tsx` for the exact available calc + low threshold = `reorderPoint`); status: out = avail<=0, low = avail<=reorderPoint (nonzero), ok otherwise. Frequently-ordered = existing `/api/orders/freq` (shape in `v2/quick-add.tsx`); thumbnails = existing `useCatalogThumbnails` hook merge in the root (copy the pattern from `v2/orders-new-v2.tsx`).
7. **"Requesting for" people picker:** design shows org-people search. Keep v2's free-form `{name,email}` onBehalfOf contract; UI = popover with "Myself" row (viewer name/email hint) + name/email inputs styled per spec. (No new people API in this phase.)
8. **No tweaks panel.** Ship: grid view default, 4 columns, grouped-by-category, green accent, dark theme tokens.
9. "Add full kit" pill: on the section whose category name matches /new hire/i (mirrors prototype) — adds 1 of each in-stock item in that category.
10. Item 4 from the media audit (memoized cards) gets folded INTO this build: new cards are `React.memo` + qty-as-prop from a parent Map, and search input uses `useDeferredValue`.

## Stages (commit after each green stage)
- [x] S0: handoff folder copied into repo root; plan committed.
- [x] S1: `storefront.css` tokens + shell; `OrdersStorefront` root (CartProvider wrap, thumbnails merge, 2-col layout, page head + flow indicator); page.tsx wired. (`2c1e1a51`)
- [x] S2: Order setup bar (warehouse popover, requesting-for popover, Pickup/Delivery segmented, deliver-to/pickup cell). (`2c1e1a51`)
- [x] S3: Sticky catalog toolbar: search (clear ×, focus ring), availability popover (+count badge), sort popover, grid/list toggle, category pills row, active filter chips + clear-all. (`2c1e1a51`)
- [x] S4: Product card (grid) + category sections (collapsible, view-all, Add-full-kit) + compact list view + skeletons + empty results. Cards: photo 4:3 + LQIP/glyph placeholder, availability pill, quick-view eye, Add→stepper, out-of-stock, React.memo+qty prop. (`2c1e1a51`)
- [x] S5: Frequently-ordered carousel (rank chips, scroll-snap, arrows, mask fade, mini add/stepper) via /api/orders/freq. (`2c1e1a51`)
- [x] S6: Order Cart rail (header + pulse badge + clear-all, context strip, empty state + suggestions, line items + entrance + trash + mini stepper + stock warnings, collapsible manager notes, footer totals + Submit) + <1280px stacking + floating Cart FAB. (`2c1e1a51`)
- [x] S7: Quick-view drawer (430px, spec grid, add/stepper). (`2c1e1a51`)
- [x] S8: Review modal (summary grid, lines, notes echo, keep browsing / confirm & submit) + success state (springy check, order ref, View order / Done). Submit wiring per decision 3. (`2c1e1a51`)
- [x] S9: Responsive pass + a11y (focus traps in popovers/modal via existing primitives where possible, aria-live cart announcements — copy v2 pattern) + unit tests (filter/sort/status derivation + full-kit) + `pnpm build`. (`2c1e1a51`, 16 tests in storefront-logic.test.ts)
- [x] S10: Demo-org Playwright visual pass vs prototype (open `design_handoff_storefront_order_page/design/StockPilot Storefront - Place an Order.html` side-by-side; compare region by region per PROMPT.md; fix diffs; screenshot evidence). Ship + OTA n/a (web only). Teach owner. (verified live 2026-07-01: all regions render, add→stepper→cart→review→success flow works E2E in demo org; SO ref shown; order created)

## Verification gates
- Every stage: `pnpm exec tsc --noEmit` + eslint on touched files.
- S9: vitest (new tests + `v2/cart-context.test.ts` still green), full `pnpm build`.
- S10: REQUIRED live demo-org walkthrough (per standing rule): add→stepper→cart→review→submit an order end-to-end as demo@stockpilotusa.com; screenshot the grid, cart, review, success; confirm order lands in /dashboard/orders.

## Reference file map (consult per stage)
- Tokens/app shell: `design/styles.css`
- Component styles (authoritative values): `design/storefront.css`
- Markup structure: `design/storefront-components.jsx`; page assembly/state: `design/storefront-page.jsx`
- Icons: lucide-react equivalents (search, filter, arrow-up-down, eye, layout-grid, list, plus, minus, trash-2, shopping-cart, sparkles, package, truck, map, users, pencil-line, check, chevrons, alert-triangle)
- Existing contracts: `v2/types.ts`, `v2/cart-context.tsx`, `v2/cart-rail.tsx` (submit), `v2/orders-new-v2.tsx` (thumbnail merge), `v2/quick-add.tsx` (freq API), `lib/use-catalog-thumbnails.ts`
