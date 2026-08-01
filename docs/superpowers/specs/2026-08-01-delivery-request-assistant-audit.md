# Delivery Request Assistant — pre-implementation audit

**Date:** 2026-08-01
**Status:** READ-ONLY audit. No code changed, no commits, no DDL/DML. Production project
`xizpqmhhslgzbuqtjubv` queried with SELECT / `information_schema` / `pg_catalog` only.
**Audience:** the implementation planner. Every claim below carries `file:line` or a prod SQL query.

**Feature under audit:** after an employee places an order, the order-success surface offers a
prefilled Outlook compose deep link to `dc4@learn4life.org` (which becomes a Zendesk ticket via
*email intake*, not the Zendesk API), prefilling requester, destination, requested date and every
line item; falls back to `mailto:` then clipboard; never auto-sends; never claims a ticket exists.

---

## 1. The existing order-success component

**A distinct order-success surface EXISTS — but it is a modal STAGE, not a route.**

The internal storefront at `/dashboard/orders/new` does **not** redirect after submit. On success it
sets local state and swaps the modal body in place:

- `apps/web/src/components/orders/storefront/orders-storefront.tsx:785-789` —
  `clearCartDraft(warehouseId); setSubmitted({ id: res.data.id, unitCount }); setReviewStage('success');`
- The user stays on `/dashboard/orders/new`. Navigation to the order detail page happens *only* if
  they click "View order" (`orders-storefront.tsx:801-803` → `router.push('/dashboard/orders/' + submitted.id)`).

**Exact names (do not guess):**

| Thing | Value |
| --- | --- |
| Route | `/dashboard/orders/new` |
| Page file / component | `apps/web/src/app/(dashboard)/dashboard/orders/new/page.tsx` → `NewOrderPage` |
| Root client component | `OrdersStorefront` / `StorefrontShell` — `apps/web/src/components/orders/storefront/orders-storefront.tsx` |
| Success component | `ReviewModal`, `stage === 'success'` — `apps/web/src/components/orders/storefront/storefront-overlays.tsx:208` (export), success branch `:343-366` |
| Modal render site | `orders-storefront.tsx:1146-1166` |
| Insertion point | the `<div className="acts">` row at `storefront-overlays.tsx:358-365`, currently holding exactly two buttons: "View order" (`sf-btn-ghost`) and "Done" (`sf-btn-go`) |

**Two structural properties that constrain the design:**

1. **It is React state, not a route.** There is no `/dashboard/orders/new/success`, no
   `/dashboard/orders/[id]/confirmation`. `reviewStage` is component state, so the surface is
   destroyed by any refresh or navigation. An affordance that lives *only* here is unrecoverable if
   the employee closes the modal. **The durable second home is the order detail page**
   (`apps/web/src/app/(dashboard)/dashboard/orders/[id]/page.tsx:70`), which already has the full
   server-side DTO.
2. **It is NOT built on the shadcn kit.** `ReviewModal` is a hand-rolled overlay: plain
   `div.sf-modal-bk` / `div.sf-modal` with manual `role="dialog" aria-modal="true"` and a
   hand-written `document` keydown Escape listener — **no focus trap, no focus restore**
   (`storefront-overlays.tsx:222-248`). Buttons are `sf-btn-ghost` / `sf-btn-go` CSS classes from
   `storefront.css`, not `@/components/ui/button`. Dropping shadcn markup in will look and behave
   inconsistently.

**Other order-creation surfaces (context, and why they are out of scope):**

- **B2B portal** `/portal` — no success screen, an inline green banner
  (`apps/web/src/components/portal/portal-shop.tsx:133-140`). Same `ActionResult<{id}>` shape.
- **Public link** `/r/[token]` — full-page success panel
  (`apps/web/src/components/orders/public-v2/public-orders-v2.tsx:352-378`), but it is a
  double-opt-in flow that creates the row at `status='pending_confirmation'`
  (`apps/web/src/app/api/v1/public/order-requests/route.ts:108`) — managers cannot even see the order
  yet. Emailing DC4 about one would be actively wrong.
- **Mobile — ABSENT.** `apps/mobile` has no order-creation path at all. `apps/mobile/src/lib/orders-api.ts`
  exposes only `transitionOrder`, `claimPicking`, `releasePicking`, `assignPicking`, `createOrderReturn`,
  `listOrderDrivers`, `getOrderDetail`, `recordPickedLine`. The standing "web features default to
  mobile too" rule has **no surface to attach to** here.

Prod confirms scope: L4L North Region has 64 orders, **100% `source='internal'`** — zero portal, zero
public_link. Build for the internal storefront only.

---

## 2. Order data already available to that component

At the moment `stage === 'success'`, `ReviewModal` already holds, with **zero extra queries**:

| Datum | Where it comes from | Evidence |
| --- | --- | --- |
| Order UUID | `submitted.id` | `orders-storefront.tsx:785-788` |
| Unit count | `submitted.unitCount` | same |
| Every cart line `{itemId, quantity}` | `state.lines` (deliberately kept in memory) | `orders-storefront.tsx:1148` |
| Full item record per line | `itemMap: ReadonlyMap<string, CatalogItem>` — `id, sku, name, categoryName, charterName/charterCode, rackLabel, price, quantityOnHand, reservedQuantity, itemType, imageUrl, reorderPoint` | `orders-storefront.tsx:1149`; type at `apps/web/src/components/orders/v2/types.ts:3-32` |
| Requester's free-text notes | `state.notes` | `orders-storefront.tsx:1150` |
| Warehouse (origin) name | `summary.warehouseName` | `orders-storefront.tsx:1152` |
| Fulfillment method | `summary.method` (`'pickup' \| 'delivery'`) | `orders-storefront.tsx:1153` |
| Destination **label** | `summary.deliverTo` — `` `${warehouseName} will-call desk` `` for pickup, else `charter?.name ?? 'Select a site'` | `orders-storefront.tsx:1154-1157` |
| Requester **label** | `summary.requestedFor` = `state.onBehalfOf?.name ?? viewerLabel`, where `viewerLabel = viewerName?.trim() \|\| viewerEmail` | `orders-storefront.tsx:1158`, `:218`; props from `ctx` at `new/page.tsx:100-107` |

**Critical invariant to preserve:** `handleConfirmSubmit` clears the *persisted* draft immediately but
deliberately leaves `state.lines` in memory — comment at `orders-storefront.tsx:781-783`:
*"In-memory lines stay until 'Done' so the success screen can still show them."* `handleDone`
(`:793-799`) is what dispatches `{type:'clear'}`. **Do not move that dispatch earlier.**

---

## 3. Additional data that must be fetched — and via which existing path

Three gaps. All are **plumbing widenings of existing code paths**; only one needs a new server read.

### 3a. The real order number — ABSENT from the client, and today's display is FABRICATED

`createOrderRequestAction` is typed `Promise<ActionResult<{ id: string }>>`
(`apps/web/src/server/actions/order-requests.ts:83-85`) and its success path is literally
`return ok({ id: row.id })` (`:122`) — it **discards** everything else. But
`OrderRequestsService.create()` already returns the full `OrderRequestRow` from an
`.insert(...).select('*').single()`, which includes `order_number`.

Because the number is unavailable, the success screen fabricates a different handle:

```ts
// apps/web/src/components/orders/storefront/storefront-logic.ts:209-216
export function orderRef(orderId: string, warehouseName: string, unitCount: number): string {
  const id8 = orderId.replace(/-/g, '').slice(0, 8).toUpperCase();
  return `SO-${id8} · ${warehouseName} · ${unitCount} ${unitCount === 1 ? 'unit' : 'units'}`;
}
```

Rendered at `storefront-overlays.tsx:348-352`. This produces e.g. `SO-1A2B3C4D · DC4 · 7 units`, which
**looks exactly like** the canonical `formatOrderNumber(49) → 'SO-000049'`
(`packages/core/src/orders/order-number.ts:6-9`, exported via `@stockpilot/core`) but is a completely
different identifier that appears **nowhere else in the product** — not the orders list
(`apps/web/src/app/(dashboard)/dashboard/orders/page.tsx:266` renders `formatOrderNumber(r.orderNumber)`),
not the detail page, not the emails, not the pick/packing slips.

**If the prefilled email quotes what is on screen, DC4 staff will search for an order number that does
not exist.** Fix at the source: widen `createOrderRequestAction`'s return to
`ActionResult<{ id: string; orderNumber: number }>` and render `formatOrderNumber`. Two lines. Strictly
better than any workaround.

### 3b. Requested date — ABSENT from the modal's props

`state.neededBy` exists on `CartState` as a `datetime-local` string
(`apps/web/src/components/orders/v2/types.ts:52`) and is submitted at
`orders-storefront.tsx:761`. But `ReviewModalProps` (`storefront-overlays.tsx:193-206`) has **no
`neededBy` field** and `orders-storefront.tsx:1146-1166` never passes it. Pure prop-drilling fix.

### 3c. Destination address — needs a real server read

`loadChartersForWarehouse` selects only `id, name, code, status`:

```ts
// apps/web/src/server/loaders/orders-new-catalog.ts:237-263
.select('charter:charters!inner (id, name, code, status)')
// returns Array<{ id: string; name: string; code: string | null }>
```

`charters.address` (jsonb), `contact_name`, `contact_email`, `contact_phone` exist and are partly
populated in prod, but never reach the client. `OrderRequestsService.get()` does **not** join the
delivery charter either — its only charters embed is per-LINE item ownership
(`apps/web/src/server/services/order-requests.ts:692-695`). `list()` embeds
`charter:charters!delivery_charter_id (name, code)` (`:546`) — name/code only, still no address.

**Two options, both existing paths:**

- **(i)** Widen `loadChartersForWarehouseCached` to select `address` and return it. ⚠️ This is a
  documented do-not-regress perf surface — a 5-minute `unstable_cache` keyed `orders-new-v2-charters-v1`
  (`orders-new-catalog.ts:261-262`). Bump the cache key if the shape changes.
- **(ii)** Assemble the whole email body **server-side** from `OrderRequestsService.get(id)` and add the
  charter join there. This is the reuse-preferred path — see §4.

### 3d. What to reuse, never re-map

**The canonical order DTO is `OrderRequestDetail`** from `OrderRequestsService.get(id)`
(`apps/web/src/server/services/order-requests.ts:215-253` interface, `:673` method), already exposed
over REST at `GET /api/v1/orders/[id]` (`apps/web/src/app/api/v1/orders/[id]/route.ts:19-31`). It carries
`request`, `lines: OrderRequestLineWithItem[]`, `reservations`, `warehouseName`, `requesterDisplay`,
`requesterName`, `requesterEmail`, `assignedPickerName`, `pickSlipStale`.
**Do not define a second order-shaped type.**

**The canonical requester fallback already exists** — replicating it wrongly is a known trap because
on-behalf-of and public orders null out `requester_user_id` by design:

```ts
// apps/web/src/server/services/order-requests.ts:780-783
// free-text column wins, else the joined profile, else null.
// `||` (not `??`) so an empty-string column also falls through.
const requesterName  = ((h.requester_name  as string|null) ?? null) || profile?.fullName?.trim() || null;
const requesterEmail = ((h.requester_email as string|null) ?? null) || profile?.email?.trim()    || null;
```

The list-page equivalent is `summaryRequesterLabel(r)` at
`apps/web/src/components/orders/requester-label.ts:11-19` (deliberately kept out of the `'use client'`
module so it is server-safe).

---

## 4. The utility that builds the email

**Recommendation: a pure, React-free builder — `buildDeliveryRequestDraft(input) → { subject, body }`
— placed in `apps/web/src/components/orders/storefront/storefront-logic.ts`.**

Why there:

- That file's own header declares its purpose: *"No React — everything in here is unit-testable with
  plain data"* (`storefront-logic.ts:1-4`). It already holds `orderRef`, `cartTotals`,
  `availabilityLabel`, `filterCatalog`.
- It has a sibling test file `storefront-logic.test.ts` (363 lines) with an established
  `makeItem()` fixture factory — the seam a new pure builder slots into with zero setup.
- Vitest runs `src/lib/**` in **node** and only switches to `happy-dom` for `src/components/**` /
  `src/app/**` (`apps/web/vitest.config.ts:20-24`). A builder under `src/components/**` gets a DOM for
  free if it ever needs one; a pure one does not care either way.

**Alternative if the body must be assembled server-side** (which §3c option (ii) and §RISK argue for):
put the pure builder in `packages/core/src/orders/` next to `order-number.ts`. `packages/core` has 41
colocated `src/**/*.test.ts` files and no vitest config (defaults), so pure logic is testable with zero
DOM and is shared by web + mobile. Choose this if the planner takes the server-assembly route.

**Do NOT inline the builder in the modal.**

**What is greenfield (all three legs of the open/fallback/copy chain):**

- **ABSENT: any Outlook Web / OWA compose deep link.** `grep -rniE "outlook\.office|outlook\.live|owa/\?path|deeplink=compose"` over `apps/web/src apps/mobile packages` → **zero hits**. (The only "Outlook" matches anywhere are dark-mode CSS hacks in `apps/web/src/lib/email/es/components.ts`.)
- **ABSENT: any shared mailto builder.** Every `mailto:` in the repo is a static href on a marketing/contact page. The *only* parameterised one is `apps/web/src/components/admin/support-triage.tsx:188`:
  `` href={`mailto:${ticket.email}?subject=Re: ${encodeURIComponent(ticket.subject)}`} `` — subject only, no `?body=`, no length guard, no encoding helper.
- **ABSENT: any clipboard helper, hook or `<CopyButton>`.** Six inline call sites with inconsistent error handling: `settings/public-link-editor.tsx:151` (try/catch + user-visible fallback — the best pattern to copy), `settings/public-links-manager.tsx:64`, `settings/mfa-recovery-codes.tsx:60`, `settings/api-keys-panel.tsx:109`, `settings/webhooks-panel.tsx:170` (fire-and-forget `void navigator.clipboard?.writeText`), `team/team-manager.tsx:606`.
- **ABSENT: a canonical absolute-URL helper.** No `absoluteUrl()`/`getAppUrl()`/`getBaseUrl()`. The value is `env.NEXT_PUBLIC_APP_URL`, normalised by `cleanUrl` in `apps/web/src/lib/env.ts:18-32`; ~30 sites string-concatenate it, several re-applying `.replace(/\/$/, '')` and several falling back to the literal `'https://stockpilotusa.com'` (e.g. `api/v1/public/order-requests/route.ts:635`). `SITE_URL = 'https://stockpilotusa.com'` is exported from `apps/web/src/lib/site.ts:18`.
- **ABSENT: an exported plain-text normaliser.** `sanitizePlainText(s) => s.replace(/[\r\n]+/g,' ').trim()` exists but is **module-private** (no `export`) inside `apps/web/src/lib/email/order-requests.ts:1247`.

**Destination-mailbox config — where `NEXT_PUBLIC_DELIVERY_REQUEST_EMAIL` would go.** If the address is
env-driven it must be added in **three code places plus `.env.example` plus Vercel**:
`apps/web/src/lib/env.ts` serverSchema (`:36-162`), `lib/env.ts` clientSchema (`:164-176`), and
`apps/web/src/lib/env.client.ts` as a **literal** `process.env.NEXT_PUBLIC_*` access — that file's
header (`:13-14`) states a dynamic `process.env[name]` would **not** be inlined by Next. Importing
`lib/env.ts` from a client component is a deliberate build error (`lib/env.ts:1-14`, `import 'server-only'`).
If hard-coded instead, `apps/web/src/lib/site.ts` is the documented "one source of truth" neighbour.

---

## 5. The UI component that displays the delivery action

**Recommendation: a new client component, e.g.
`apps/web/src/components/orders/storefront/delivery-request-action.tsx`, rendered inside the
`.acts` row of the success branch (`storefront-overlays.tsx:358-365`).**

**It must compose the storefront's own `sf-*` CSS classes, not the shadcn kit** — see §1. Existing
classes: `sf-btn-ghost`, `sf-btn-go`, `sf-icon-btn`, `sf-modal-*`, `sf-success`, `sf-rev-*`, defined in
`apps/web/src/components/orders/storefront/storefront.css`. Icons come from `lucide-react`
(`apps/web/package.json:41`, declared as the shadcn `iconLibrary` in `apps/web/components.json`).
`storefront-overlays.tsx` already imports `Check`, `X`, `Loader2`, `ClipboardList` from it.

**Primitives available if any part moves onto the kit** (`apps/web/src/components/ui/`, 34 files):
`dialog.tsx` (Radix — supplies the focus trap the sf-modal lacks), `button.tsx` (CVA; supports
`asChild` via Radix Slot, so it can wrap an `<a href>` — `button.tsx:34-38`), `badge.tsx` (has `success`
and `warning` variants, suitable for a "Draft — not sent" pill), `card.tsx`, `dropdown-menu.tsx`,
`popover.tsx`, `sheet.tsx`, `empty-state.tsx`, `destructive-confirm.tsx`.

**Toasts:** import `{ toast }` from `'sonner'` directly — that IS the convention (162 files). The
`<Toaster/>` is mounted once in `apps/web/src/app/layout.tsx:119`; there is **no** app-specific toast
wrapper module. Convention: `toast.success('Sentence.')` / `toast.error(res.error.message)`.

**ABSENT: an `Alert` component.** There is no `apps/web/src/components/ui/alert.tsx` and zero imports of
`@/components/ui/alert`. The "this does not create a ticket" notice must reuse the hand-rolled inline
banner pattern (28 occurrences of `bg-destructive/10` / `border-destructive/40` on plain divs, e.g.
`dashboard/orders/[id]/page.tsx:855-861`) or introduce the first `Alert`.

**ABSENT: a tooltip primitive.** No `ui/tooltip.tsx`; `@radix-ui/react-tooltip` is not a dependency. The
nearest hint affordance is `apps/web/src/components/onboarding/help-tip.tsx`.

**Date rendering:** use `formatOrgDateTime` / `formatOrgDate` from `apps/web/src/lib/timezone.ts:25-55`
(pins `Intl` to `organizations.timezone`, `ORG_TIMEZONE_DEFAULT = 'America/Los_Angeles'`, returns `'—'`
on invalid). **ABSENT: any shared formatter for `needed_by` today** — it is rendered ad hoc with raw
`new Date(x).toLocaleString('en-US', {...})` at three unrelated call sites
(`dashboard/orders/[id]/page.tsx:890-899`, `components/orders/manager-actions-panel.tsx:1130-1140`,
`lib/email/order-requests.ts:335-341` private `fmtDate`).

**Analytics (optional):** `capture(event, props)` from `apps/web/src/lib/analytics.ts:20-55` (PostHog,
client-only, ships dark when `NEXT_PUBLIC_POSTHOG_KEY` is unset). Event names are snake_case
past-tense, e.g. `capture('purchase_order_ordered', { po_id })`.

**Permission gates:** none new needed. `/dashboard/orders/new` already redirects to `/dashboard` if
`!can(ctx, 'orders:request')` (`new/page.tsx:27-29`) and the service asserts the `orders` module +
`orders:request` + warehouse read access (`order-requests.ts:834-841`). A mailto button inherits all of
this for free.

---

## 6. Test files added or updated

Framework facts (`apps/web/vitest.config.ts`):
- **Vitest, not Jest.** `include: ['src/**/*.test.{ts,tsx}']`, `exclude: ['tests/e2e/**']` (`:17-19`).
- Node environment by default; `happy-dom` only for `src/components/**` and `src/app/**` (`:20-24`).
- Single setup file `apps/web/src/test/setup.ts` — imports `@testing-library/jest-dom/vitest`, **globally
  `vi.mock`s `@/server/services/audit` to a no-op** (`:13-16`), polyfills ResizeObserver / matchMedia /
  scrollIntoView, and runs `cleanup()` + `vi.restoreAllMocks()` after each test (`:51-54`). A test that
  *asserts* on audit must declare its own per-file `vi.mock`.
- `server-only` is aliased to a test mock (`vitest.config.ts:8-14`).

| File | Add / Update | Covers |
| --- | --- | --- |
| `apps/web/src/components/orders/storefront/storefront-logic.test.ts` | **UPDATE** | The pure `buildDeliveryRequestDraft` — subject/body shape, pickup vs delivery, missing `neededBy`, missing charter address, zero/one/many lines, plain-text escaping, no `internal_notes` leakage. Existing `makeItem()` factory at `:22-44`. |
| `apps/web/src/components/orders/storefront/storefront-overlays.test.tsx` | **ADD** (does not exist today) | `ReviewModal stage='success'` renders the action; click → `window.open` called with the Outlook URL; popup-blocked (`open` returns `null`) → `mailto` fallback; `mailto` failure → clipboard; copy → toast. |
| `packages/core/src/orders/delivery-request.test.ts` | **ADD, only if** the builder lands in `packages/core` per §4's alternative | Same pure cases; zero DOM. |
| `apps/web/tests/e2e/*.spec.ts` | **Probably none** | See below. |

**House mocking idioms to reuse:**
- `navigator.clipboard`: the ONLY established pattern is
  `Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true })`
  inside the test body, asserted via `waitFor(...)` — `apps/web/src/components/settings/mfa-recovery-codes.test.tsx:60-88`.
  Not a shared helper; it is copy-pasted per test.
- Non-DOM globals: `vi.stubGlobal('fetch', spy)` / `vi.stubGlobal('confirm', spy)` —
  `apps/web/src/components/platform/user-actions-menu.test.tsx:433,444`;
  `apps/web/src/components/orders/add-items-dialog.test.tsx:85`. `vi.stubGlobal('open', openSpy)` fits.
- Component tests: `@testing-library/react` + `user-event`, with `vi.mock` for `next/link`,
  `next/navigation` (`useRouter: () => ({ refresh: vi.fn(), push: vi.fn() })`), `sonner`'s `toast`, and
  every server action the component imports — `apps/web/src/components/orders/manager-actions-panel.test.tsx:1-46`.

**Existing `window.open` call sites — note there is no popup-blocked pattern to copy.** Only two
production components use it, both with an explicit feature string and **neither null-checks the
return value**: `apps/web/src/components/orders/manager-actions-panel.tsx:457,461,465,473`
(`window.open('/orders/sign/...', '_blank', 'noopener,noreferrer')`) and
`apps/web/src/components/inventory/barcode-display.tsx:236`. The fallback chain is genuinely new.

**Playwright:** `apps/web/tests/e2e/` holds exactly five read-only smoke specs
(`dashboard`, `inventory`, `movements`, `settings`, `landing-intro`); none creates data, and they
`test.skip(true, '…requires seeded data')` when the org is empty. `auth.setup.ts:15-48` **skips** when
`TEST_USER_EMAIL`/`TEST_USER_PASSWORD` are unset and **throws** if the account has MFA. **Playwright is
NOT run in CI** (`.github/workflows/ci.yml:34-38,70-92` runs `pnpm typecheck` + `pnpm test` + build +
pgTAP only). An e2e that places a real order would break house style — recommend skipping it.

---

## 7. Is a database migration necessary?

**Recommendation: NO migration. Do not add one.**

Reasoning, in order of strength:

1. **The feature persists nothing new.** It composes a draft and hands it to the user's mail client.
   Nothing about the draft needs to survive the click.
2. **The audit system already represents "an employee drafted a delivery request", with no schema
   change.** `audit_logs` has only `id, organization_id, user_id, event (text), metadata (jsonb), ip,
   user_agent, created_at` — **no entity column**; entity identity lives inside `metadata` as
   `entity_type` / `entity_id` (`apps/web/src/server/services/audit.ts:325-340`). Prod
   `pg_constraint` for `public.audit_logs` returns only `audit_logs_pkey` and two FKs — **no CHECK
   constraint and no enum on `event`**. So adding `'order.delivery_request_drafted'` is a **pure
   TypeScript union edit** to `export type AuditEvent`
   (`apps/web/src/server/services/audit.ts:9`), in the existing `order.*` group (`:139-159`, which
   already runs `order.pick_slip_generated` … `order.completed`, `order.picking_reopened`,
   `order.closed_partial`). House convention: a rationale comment block above the new group.
   It then renders for free in `<OrderTimeline orderId organizationId />` on the order detail page
   (`dashboard/orders/[id]/page.tsx:880`).
   ⚠️ **Gotcha documented in the file:** `audit()` is best-effort and never throws, but API-route /
   Bearer callers must pass their `ServiceContext` explicitly — the `withContext()` fallback throws
   `NEXT_REDIRECT` outside a page request and the event is **silently dropped**
   (`audit.ts:294-350`).
3. **The two gaps that look like schema gaps are not.** The order number and the requested date both
   already exist in the DB (`order_requests.order_number bigint NOT NULL`,
   `order_requests.needed_by timestamptz` — both confirmed in prod); they are missing from the
   *client*, which is a return-type widening and a prop, not DDL.

**Migrations you might be tempted to write, and the honest counter-argument:**

- *A destination-mailbox config column.* There is genuinely nowhere to put `dc4@learn4life.org` today
  (see §OPEN QUESTIONS). But an env var or a `lib/site.ts` constant solves it with zero DDL, and the
  brief says avoid migrations unless the schema cannot represent the data. **Defer; ask the owner.**
- *A `delivery_instructions` / `building` / `room` column.* These fields do not exist (see FIELD
  REALITY). Adding them is a **product decision about data capture**, not a requirement of a
  draft-an-email feature. If the owner wants them captured, that is a separate spec — the assistant
  must not invent them into the email body meanwhile.

---

## FIELD REALITY TABLE

Every field the brief's email template wants → the real column/join, or **ABSENT**.
Prod counts from `xizpqmhhslgzbuqtjubv` (78 order_requests, 150 order_request_lines, 16 charters).

| Brief field | Real source | Reality |
| --- | --- | --- |
| **Order handle** | `order_requests.order_number` (bigint NOT NULL, per-org sequential, assigned by BEFORE-INSERT trigger `assign_order_request_number` under `pg_advisory_xact_lock`; `supabase/migrations/0254_order_request_numbers.sql:9,41-67`) → `formatOrderNumber()` → `SO-000049` | **EXISTS in DB; ABSENT on the client.** The success screen prints a *different, fabricated* `SO-<uuid8>` string. See §3a. **Highest-risk item in this audit.** |
| **Order link** | `${NEXT_PUBLIC_APP_URL}/dashboard/orders/<uuid>` | EXISTS. Route is `/dashboard/orders/[id]` keyed by **UUID**, not by SO number (`dashboard/orders/[id]/page.tsx:70`). There is **no route that resolves an order by its SO number** — the SO number can only be display text. |
| **Requester name** | `order_requests.requester_name` (free text) **else** join `requester_user_id → user_profiles.full_name` | EXISTS. For internal self-submit, `requester_name`/`requester_email` are **NULL** and identity lives only in `requester_user_id` (`order-requests.ts:919-921`). Reuse `OrderRequestDetail.requesterName` (`:780-783`), never re-derive. |
| **Requester email** | `order_requests.requester_email` else `user_profiles.email` | EXISTS, same fallback. |
| **Requester phone** | `order_requests.requester_phone` | **EXISTS but effectively dead on this path.** The internal storefront hardcodes `requesterPhone: null` (`orders-storefront.tsx:763`). Only 10/78 prod rows have one (all from the public-link path). |
| **Fulfillment method** | `order_requests.fulfillment_type text NOT NULL DEFAULT 'delivery'`, CHECK `order_requests_fulfillment_type_chk` ∈ `{'pickup','delivery'}` | **EXISTS and is reliable.** ⚠️ DB default is `'delivery'` but the server action's zod default is `'pickup'` (`actions/order-requests.ts:52`) — a rolling-deploy safety for old clients. Do not assume they agree. |
| **Delivery destination (site)** | `order_requests.delivery_charter_id` → `charters.id` (FK `order_requests_delivery_charter_id_fkey`, ON DELETE RESTRICT). UI calls a charter a **"site"**. | **EXISTS — but see the constraint hole below.** Guarded by `order_requests_delivery_target_chk`: `(delivery AND charter NOT NULL) OR (pickup AND charter NULL)`. |
| — destination **street/city/state/zip** | `charters.address` **jsonb**, keys `line1`, `line2`, `city`, `region`, `postalCode`, `country` (camelCase; **`region`, not `state`**) | **EXISTS in DB, ABSENT everywhere the feature can currently see it.** 12/16 charters have an address; 4 have `null`. Not in `loadChartersForWarehouse` (`orders-new-catalog.ts:240-263`), not in `OrderRequestsService.get()`. Verified prod sample: `CVW Clovis → {"city":"Fresno","line1":"1295 Shaw Ave","region":"California","country":"United States","postalCode":"93612"}`. ⚠️ Data quality is imperfect — `KVA Tulare` has `"region":"Calfornia"` (sic) and `"city":"Fresno"` for a Tulare address. |
| — destination **building** | — | **ABSENT.** No `building` field on `charters.address`, on `order_requests`, or anywhere in the public schema. |
| — destination **room** | — | **ABSENT.** Same. If DC4 needs "deliver to Room 214, B Wing" there is nowhere to put it except `order_requests.notes` free text. |
| — destination **contact name** | `charters.contact_name` | **Schema-present, DATA-ABSENT: 0 of 16 charters populated.** Will render blank. |
| — destination **contact email** | `charters.contact_email` (citext) | **Schema-present, DATA-ABSENT: 0 of 16.** |
| — destination **contact phone** | `charters.contact_phone` | **Schema-present, near-empty: 1 of 16** (`CVW-Mendota → +18773605327`). |
| **Pickup destination** | `order_requests.pickup_location_notes` (text) | **Schema-present, DATA-ABSENT: 0 of 78 prod rows.** The storefront hardcodes `pickupLocationNotes: null` (`orders-storefront.tsx:766`) and instead renders a synthetic label `` `${warehouseName} will-call desk` `` (`:1155-1157`). A real pickup address would have to come from `warehouses.address` (jsonb) via `warehouse_id`. |
| **Origin warehouse** | `order_requests.warehouse_id` NOT NULL → `warehouses` (`name`, `code`, `address` jsonb, `contact_name`, `contact_email`, `contact_phone`) | EXISTS and always resolvable. `OrderRequestDetail.warehouseName` already resolves the name. |
| **Requested date** | `order_requests.needed_by` **`timestamp with time zone`**, nullable | **EXISTS in DB, ABSENT from the modal's props.** Only **8 of 78** prod rows have one — "no requested date" is the common case, and the UI labels it "Needed by — Optional" (`storefront-cart.tsx:258-260`). **Good news: it is timestamptz + captured via `<input type="datetime-local">` (`storefront-cart.tsx:261-268`) normalised through `new Date(...).toISOString()` (`orders-storefront.tsx:761`), so it carries a real instant — the brief's date-only day-shift risk does not apply here.** Render with `formatOrgDateTime`. |
| **Line: item name** | `order_request_lines.item_id` → `inventory_items.name` (NOT NULL) | EXISTS. Client-side, `itemMap.get(line.itemId).name`. |
| **Line: SKU** | `inventory_items.sku` (NOT NULL) | EXISTS, same. |
| **Line: quantity** | `order_request_lines.quantity_requested` (numeric NOT NULL, CHECK > 0) | EXISTS. ⚠️ Use **`quantity_requested`** — `quantity_fulfilled` = SHIPPED and `quantity_picked` = staged; both are 0 at success time. |
| **Line: unit of measure** | `inventory_items.unit_of_measure` text NOT NULL | **EXISTS but not selected by the order path** (absent from the `get()` item embed at `order-requests.ts:692-695`) **and the data is messy free text, not an enum**: `unit` (446), `each` (12), `''` empty string (11), `ea` (11), `pair` (8), `Pack of 2` (1), `Pack of 72` (1). Skip empty strings if surfaced. |
| **Line: size / colour / variant** | `inventory_items.variant_size`, `variant_width`, `variant_fit`, `variant_color`, `variant_key`, `player_name`, `jersey_number`, `group_id` → `product_groups` | **EXIST but absent from the order path's item embed.** Surfacing them means widening `order-requests.ts:692-695`. Reuse the existing formatters in `packages/core/src/sports/` (`size-order.ts`, `size-count-labels.ts`, `variant-keys.ts`) — do not write a new one. |
| **Line: per-line note** | `order_request_lines.notes` (text) | **Schema-present, DEAD on this path.** The storefront maps only `{itemId, quantity}` (`orders-storefront.tsx:773`) and **0 of 150** prod line rows have a note. |
| **Line: bundle expansion** | — | **ABSENT.** `order_request_lines` has no `bundle_id` / `parent_line_id` / component expansion. A bundle appears as one line whose `item_id` points at an `inventory_items.is_bundle = true` row. Expanding it requires an explicit `bundle_components` join. |
| **Order notes / message** | `order_requests.notes` (text, zod max 2000) | EXISTS, 32 of 78 populated. This is the requester-facing message and is safe to include. |
| **Internal notes** | `order_requests.internal_notes` (text) | EXISTS — **staff-only. MUST NOT appear in an outbound email to `dc4@learn4life.org`.** Written by manager actions at `order-requests.ts:1874,2963`. |
| **Order status at send time** | `order_requests.status` | EXISTS. A freshly placed internal order is inserted as **`'pending_approval'`** (`order-requests.ts:931`) — **not approved, not scheduled.** The full CHECK enum is 14 values: `pending_confirmation, pending_approval, approved, pick_slip_generated, picking_in_progress, picking_complete, packing_slip_generated, staged_for_pickup, staged_for_delivery, in_transit, backordered, completed, denied, cancelled`. |
| **Priority / urgency / rush** | — | **ABSENT.** `order_requests` has no `priority`, `urgency`, `rush`, or `is_expedited` column. The only `priority` column in the entire public schema is `support_tickets.priority`. **The brief's priority field does not exist for orders.** |
| **Delivery instructions** | — | **ABSENT.** No `delivery_instructions` / `dropoff_instructions` / `ship_to` column. A schema-wide scan for `instruction\|dropoff\|drop_off\|ship_to\|deliver_to` matched only `public_request_links.instructions` (unrelated — public-link page copy). |
| **Destination address snapshot** | — | **ABSENT.** Unlike `unit_cost_at_request` (which snapshots price at request time), no address or contact is copied onto `order_requests`. Editing a charter's address retroactively changes what every historical order "was shipped to". |
| **`dc4@learn4life.org`** | — | **ABSENT from code AND DB.** Zero hits for `dc4@` or `learn4life.org` in `apps/web/src`, `apps/mobile`, `packages`, `docs` (only match is an unrelated Zendesk subdomain placeholder at `components/zendesk/zendesk-quick-access.tsx:71`). `public.organizations` has 33 columns and none is an ops/settings email; there is **no `organization_settings` table**. `warehouses.contact_email` for L4L's DC4 holds `arosas@cvwest.org` — **not** the DC4 intake address. |

### The honest substitute for "delivery destination"

The brief imagines a destination with an address, a building, a room and a contact. **What actually
exists is a charter (a "site") with a name, a code, and — for 12 of 16 sites — a `line1/city/region/postalCode`
jsonb blob with no contact and no sub-address granularity.**

The honest substitute, in descending order of confidence:

1. **Site name + code** (`charters.name`, `charters.code`) — always present, already on the success screen
   as `summary.deliverTo`. This is what DC4 staff already recognise.
2. **Street address** from `charters.address` — present 12/16, requires the plumbing in §3c, and carries
   at least one known typo. Render it as a best-effort line, never as an authoritative ship-to.
3. **Contact** — omit entirely. 0/16 sites have a name or email; printing an empty "Contact:" line is
   worse than printing nothing. The requester's own name/email (which *are* reliable) is the honest
   person to contact.
4. **Building / room / instructions** — omit. There is no field, and inventing labelled-but-empty rows
   in the email implies the system captured something it did not.

For **pickup** orders there is no destination at all in the data — only the synthetic
`"<warehouse> will-call desk"` string the UI makes up client-side. See the eligibility question below.

---

## OPEN QUESTIONS FOR THE OWNER

*Not decided here. Each one is a place where the brief assumes something the codebase contradicts.*

1. **Where does `dc4@learn4life.org` live?** It exists nowhere in code or DB, and there is no org-level
   or warehouse-level config field to hold it (`organizations` has no settings/ops email column; there
   is no `organization_settings` table; `warehouses.contact_email` for DC4 is `arosas@cvwest.org`).
   Three options: (a) hard-code next to `SITE_URL` in `apps/web/src/lib/site.ts`; (b)
   `NEXT_PUBLIC_DELIVERY_REQUEST_EMAIL` env var — requires edits in **three** code locations plus
   `.env.example` plus Vercel (§4); (c) a new config column — the only option needing a migration.
   **Which, and is this L4L-only or a product feature every org gets?**

2. **Pickup vs delivery eligibility — Option A (hide) or Option B (secondary action)?**
   *What the code supports:* `summary.method` is already on the success screen
   (`orders-storefront.tsx:1153`), so **both options are trivially implementable — this is purely a
   business decision.** What the code *tells us*: for a pickup order the destination is a **synthetic
   client-side string** (`"<warehouse> will-call desk"`), `delivery_charter_id` is NULL **by CHECK
   constraint**, and `pickup_location_notes` is NULL on all 78 prod rows. So a pickup-order email would
   have literally no destination to state. That argues for Option A, **but** it is possible DC4 still
   wants a heads-up ticket for will-call staging. **Needed to decide: does DC4 want a ticket for
   pickup/will-call orders at all, or only for orders they physically deliver?**

3. **What is the real intake contract for the Zendesk email?** The brief says the mailbox becomes a
   ticket via email intake. Nothing in this repo touches email intake — the Zendesk integration here is
   an OAuth/API connector plus a managed-org SSO shell. **Does DC4's intake need a specific subject
   prefix, a ticket-form token, or a structured body block to route correctly?** Getting this wrong
   produces untriaged tickets and we cannot detect it from the app side.

4. **Priority, delivery instructions, and building/room do not exist as data.** The brief's template
   leans on them. **Omit them, or open a separate spec to capture them at order time?** The assistant
   must not print labelled-but-empty rows that imply the system asked.

5. **Should the SO number fix ship as part of this feature or ahead of it?** The success screen's
   `SO-<uuid8>` handle is wrong *today*, independent of this feature (§3a). It is a two-line fix. **Fold
   it in, or ship it separately first so it can be verified on its own?**

6. **Does the assistant need a durable second home?** The success surface is React state in a modal and
   dies on refresh. The order detail page `/dashboard/orders/[id]` already has the full
   `OrderRequestDetail` server-side and would host a "Compose delivery request" action naturally.
   **Success-screen only, or both?** (Both is more code but far more usable.)

7. **Is the address worth the perf risk?** Getting `charters.address` to the client means widening a
   documented do-not-regress 5-minute cached loader (`orders-new-v2-charters-v1`), or moving body
   assembly server-side. **Is a site name + code sufficient for DC4, given they already know their own
   sites and 4 of 16 have no address anyway?**

8. **Who may draft one?** Today anyone with `orders:request` reaches the success screen. **Should the
   delivery-request action be limited to a role, or is every requester allowed to email DC4 directly?**

---

## RISK NOTES

**R1 — The fabricated order number (highest risk, and it is pre-existing).**
`orderRef()` (`storefront-logic.ts:209-216`) renders `SO-` + the first 8 hex chars of the UUID, which is
visually indistinguishable from the canonical `SO-000049` but exists **nowhere else in the system**. If
the prefilled email quotes what is on screen, DC4 staff will search the orders list for a number that
does not exist and the ticket becomes unresolvable. **Do not work around this — widen
`createOrderRequestAction` (`actions/order-requests.ts:83,122`) to return `order_number` and use
`formatOrderNumber`.**

**R2 — The date-only timezone trap (mitigated here, but the pattern is live in the repo).**
`needed_by` is **`timestamptz`** and is captured via `<input type="datetime-local">` normalised through
`toISOString()`, so it carries a real instant — the classic "date-only string parsed as UTC midnight
shifts a day westward" bug **does not apply**. But: there is **no date-only-safe formatter anywhere in
the repo** (no `formatDateOnly`, `parseDateOnly`, or `timeZone:'UTC'` formatter in `apps/web/src` or
`packages/core`), and the inverse trap is live —
`apps/web/src/app/(dashboard)/dashboard/purchase-orders/[id]/edit/page.tsx:82` does
`new Date(storedExpectedAt).toISOString().slice(0,10)` to seed a date input, which shifts the day for
any local time after 16:00 PT. **Use `formatOrgDateTime` from `lib/timezone.ts`. Never introduce a
`slice(0,10)`-on-ISO pattern. Never send raw ISO to DC4** — a UTC string reads as the wrong wall clock
to a California DC.

**R3 — Popup blocking.** `window.open` from a non-user-gesture context, or a second `open` in the same
tick, returns `null` in Chrome/Safari. **There is no existing popup-blocked pattern to copy** — both
production `window.open` call sites
(`manager-actions-panel.tsx:457,461,465,473`; `barcode-display.tsx:236`) ignore the return value. The
open must be **directly inside the click handler** (no `await` before it), and the `null` return must
drive the `mailto:` fallback. Safari additionally treats a `mailto:` navigation with no handler as a
silent no-op — clipboard is the only genuinely reliable terminal fallback, so surface it explicitly
rather than as a hidden last resort.

**R4 — URL length.** Outlook Web compose deep links and `mailto:` both carry the body in the query
string. Practical browser/OWA limits land around 2,000 characters for `mailto:` (IE/Edge historically
~2,048; Outlook desktop truncates silently) and OWA has its own cap. An order with 100 lines — the zod
max (`actions/order-requests.ts:76`) — will blow past that, and **truncation is silent**: the mail
client opens with a half-written body and the employee sends it. **Measure the encoded length and,
above a conservative threshold, degrade deliberately** (short body + "full details:" order link, or
push the user straight to the clipboard path with an explanation). There is **no existing length guard
or email-encoding helper** to reuse.

**R5 — Non-claim honesty, in two directions.** (a) The order is `pending_approval` at this moment
(`order-requests.ts:931`) — the copy must not imply approved, scheduled, or reserved. (b) The brief's
"never claim a ticket was created" is achievable because **nothing in the Zendesk integration touches
email intake** — there is no code path that could accidentally assert it. The success copy is
hand-written JSX under our control (`storefront-overlays.tsx:343-366`). Keep it to *"opens a draft
you still have to send"*. Note the existing paragraph at `:353-357` already says *"Your manager has
been notified"* — verify that claim is still true and does not contradict the new copy.

**R6 — Accessibility regression.** `ReviewModal` has `role="dialog" aria-modal="true"` but **no focus
trap and no focus restore** (`storefront-overlays.tsx:222-248`). Adding a third button (and possibly a
disclosure or a copy-confirmation) to a modal that already fails to trap focus makes the gap more
visible. The storefront does have a live-region idiom to reuse for the copy confirmation:
`<div aria-live="polite" aria-atomic="true" className="sf-sr-only">` at `storefront-cart.tsx:93`.
**ABSENT: an `Alert` component** for the "this does not create a ticket" notice — reuse the inline
`bg-destructive/10` banner pattern.

**R7 — Leaking staff-only data.** `order_requests.internal_notes` must never reach the outbound body.
So must nothing from `reservations`, `assignedPickerName`, or `unit_cost_at_request` /
`unit_price_at_request` unless the owner explicitly wants cost visible to DC4. Building the body from
`OrderRequestDetail` makes this an **explicit allow-list decision** — do not spread the whole DTO into
a template.

**R8 — The 5 orphaned delivery orders.** `order_requests_delivery_target_chk` is declared **`NOT VALID`**,
so pre-existing rows were never checked: **5 of 41 prod delivery orders have `delivery_charter_id = NULL`.**
Any code that assumes "delivery ⇒ destination exists" will produce an email addressed to nowhere. The
builder must handle it. (New orders cannot hit this — both the action at
`actions/order-requests.ts:91-93` and the client at `orders-storefront.tsx:744-747` refuse a
delivery without a site — but the durable order-detail entry point of Open Question 6 would.)

**R9 — Cache-key discipline.** If `loadChartersForWarehouseCached` is widened to carry `address`, the
`unstable_cache` key `orders-new-v2-charters-v1` (`orders-new-catalog.ts:261`) **must be bumped** or
5-minute-stale entries without the field will linger post-deploy and the address will silently be
missing for the first users after a deploy. The file's own thumbmap loader documents exactly this
pattern at `:227-229`.

**R10 — Env plumbing is a three-file change with a silent failure mode.** If the address is env-driven:
`lib/env.ts` serverSchema, `lib/env.ts` clientSchema, **and** `lib/env.client.ts` as a **literal**
`process.env.NEXT_PUBLIC_*` access. A dynamic lookup compiles but is **not inlined** by Next, so the
value is `undefined` in the browser at runtime with no build error — the button would compose an email
to an empty address. `env.client.ts:24-32` returns `''` and `console.error`s on a missing prod value
rather than crashing, so this fails quietly.

**R11 — Scope drift to mobile.** The standing "web features default to mobile too" rule does not apply:
`apps/mobile` has **no order-creation flow** and therefore no success screen. Also **ABSENT**:
`expo-clipboard` and any mail-composer dependency (`apps/mobile/package.json` has `expo-linking ~7.1.7`
only), so a native twin would need a new dependency. Do not spend the parity budget here.
