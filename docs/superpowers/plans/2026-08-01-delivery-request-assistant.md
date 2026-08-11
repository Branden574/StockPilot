# Delivery Request Assistant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After an employee places an internal order at `/dashboard/orders/new`, offer them a one-click assistant on the success screen that opens a fully prefilled, plain-text Outlook compose window addressed To `dc4@learn4life.org` and CC `arosas@cvwest.org` — carrying the canonical order number, the requester, the destination or pickup handoff, the needed-by date and every line item — falling back to `mailto:` then to the clipboard, never auto-sending, and never claiming a ticket was created.

**Architecture:** three layers, all client-side by necessity.

| Layer | Where | Why there |
|---|---|---|
| Data contract | `createOrderRequestAction` return + `ReviewModalProps` + `loadChartersForWarehouse` | The success screen is React state holding lines, the item map, notes, warehouse, method, destination label and requester with ZERO queries (audit §2). Three gaps — order number, `neededBy`, charter address — are plumbing widenings of paths that already exist. |
| Pure builder | `apps/web/src/components/orders/storefront/storefront-logic.ts` | The file's own header declares "No React — everything in here is unit-testable with plain data" and it has a 363-line sibling test file with a `makeItem()` factory. |
| Transport + UI | `delivery-request-action.tsx`, rendered in the `.acts` row of `storefront-overlays.tsx:358-365` | Composes the storefront's `sf-*` CSS, not the shadcn kit. |

**The decisive constraint that fixes the builder's home:** RISK R3 — `window.open` must run in the SAME TICK as the click, with no `await` before it, or Chrome and Safari return `null`. Server-side body assembly (audit §4's alternative, `packages/core/src/orders/`) would require awaiting a server action before the open and would be popup-blocked on every click. **The builder is therefore pure and client-side, in `storefront-logic.ts`.** The address it needs is plumbed through the existing charter loader instead (Task 3), not fetched inside the handler.

**Tech Stack:** TypeScript, Next.js 16 App Router (RSC + Server Actions), React 19, vitest + happy-dom + @testing-library/react + user-event, sonner toasts, lucide-react icons, Radix Dialog (`@/components/ui/dialog`), zod, `@stockpilot/core`.

---

## Global Constraints

Binding on every task. Copied in substance from the owner brief, `docs/superpowers/specs/2026-08-01-delivery-request-assistant-audit.md` ("Audit §n" / "R n") and `.superpowers/sdd/delivery-request-requirements-addendum.md` ("Addendum").

1. **Recipients are `To: dc4@learn4life.org` and `CC: arosas@cvwest.org`, defined ONCE as constants** (Task 2). Both addresses ride EVERY pathway: the Outlook URL, the mailto URL, the preview dialog and the clipboard text. Never both inside `to`. Never the CC in the body only.
2. **The recipients are NEVER overridable by any client-controlled input** — not URL query params, not localStorage, not order notes, not requester-entered form values, not API parameters, not destination-site data. The builder takes NO recipient argument; it reads the constant. Outlook owns the final draft after it opens; StockPilot must always GENERATE both correctly.
3. **StockPilot NEVER auto-sends and NEVER claims a ticket was created.** Allowed: "A copy will also be sent to arosas@cvwest.org." FORBIDDEN: "This ticket will be assigned to him", "Ticket created", "Ticket #", any claim of Zendesk assignment or receipt. The system records only that a DRAFT WAS OPENED.
4. **The order is already persisted before the assistant appears.** Nothing in this feature may create a second order, re-submit, or mutate the existing order. No writes to `order_requests` or `order_request_lines` at all. The only write of any kind is one best-effort `audit_logs` row (Task 10).
5. **Plain-text body only.** No HTML, no markdown, no emoji, no box-drawing characters. `\n` line breaks, `\r\n` never authored by us.
6. **Encode exactly once.** `URLSearchParams` for the Outlook query string and for the mailto query string; the mailto path segment carries the raw `to` address. Never `encodeURIComponent` a value that `URLSearchParams` will encode again.
7. **Open from a direct user action.** `window.open` is the FIRST statement in the click handler. No `await`, no `startTransition`, no state set, no analytics call before it. Everything else happens after (R3).
8. **NO MIGRATION.** `audit_logs` has no CHECK and no enum on `event` (prod-verified, Audit §7), so the new event is a TypeScript union edit. Do not write a `.sql` file. Do not run `supabase db push`.
9. **NO Playwright e2e** (Owner decision 3). Every path — open, popup-blocked, mailto, clipboard, duplicate draft, condensed — is covered by component tests. The deviation from brief section 34 is DOCUMENTED in the section 41 report under G (Task 12), never quietly omitted.
10. **Mobile is NOT in scope.** `apps/mobile` has no order-creation flow and no success screen, and lacks `expo-clipboard` and any mail composer (R11). The standing "web features default to mobile too" rule has no surface to attach to. Do not spend parity budget here; say so in the report.
11. **LOCAL COMMITS ONLY, on `feat/delivery-request-assistant`.** Never push, never merge to main, never open a PR, never deploy. Every task ends at a local commit.
12. **TDD with real numbers.** Write the failing test, run it, record the REAL failure text; implement; run it again, record the REAL pass. Never write "tests pass" without the command output in front of you.
13. **No emojis** anywhere — code, comments, copy, commit messages, docs, email body.
14. **No Claude/Anthropic co-author trailer** on any commit. History is `Branden574` only.
15. **`internal_notes` and every staff-only datum must never reach the body.** The builder takes an explicit allow-list of fields; it never spreads a DTO into a template. Nothing from reservations, assigned picker, `unit_cost_at_request` or `unit_price_at_request` appears (R7).
16. **Never send a raw ISO timestamp to DC4.** Dates render through `formatOrgDateTime` from `apps/web/src/lib/timezone.ts` with the timezone label appended. Never introduce a `slice(0, 10)`-on-ISO pattern (R2).
17. **Every surface prints the SAME order handle** — `formatOrderNumber(orderNumber)` from `@stockpilot/core`. The fabricated `SO-<uuid8>` is deleted, not worked around (Owner decision 2, R1).

### Owner decisions that override the brief

| # | Decision | Consequence in this plan |
|---|---|---|
| D1 | **Pickup orders get the assistant too.** "Someone from another site might be picking up an order and we'll still need the ticket for that as well." | The action renders for EVERY order regardless of `fulfillment_type`. The body adapts: delivery prints a DELIVERY DESTINATION block; pickup prints PICKUP FROM + COLLECTED BY and NO destination block. **Never emit an empty or invented destination.** (Task 4) |
| D2 | **Fix the fabricated order number as part of this feature.** | Task 1 widens `createOrderRequestAction` to return `orderNumber` and renders `formatOrderNumber` on the success screen and in the email. `orderRef()` is deleted. |
| D3 | **No Playwright e2e; strengthen component tests instead.** | Tasks 6-9 carry the coverage; Task 12 documents the deviation. |

### Regression assertions — every task keeps these four green

- **R1 — the existing order flow is untouched.** Browse, filter, add to cart, review, confirm, "View order", "Done" all behave exactly as before. `handleConfirmSubmit` still clears the persisted draft immediately and STILL leaves `state.lines` in memory until `handleDone` — the comment at `orders-storefront.tsx:781-783` is an invariant. **Never move the `dispatch({type:'clear'})` earlier.**
- **R2 — no duplicate order, no order mutation.** After any number of clicks on any of the new controls, `order_requests` and `order_request_lines` are byte-identical to their post-submit state.
- **R3 — both recipients survive every path.** To and CC appear exactly once each, correctly encoded, in the Outlook URL, the mailto URL, the preview and the clipboard text — including condensed mode, including when every optional field is missing.
- **R4 — no claim of a ticket.** No copy anywhere in the feature asserts a ticket exists, was created, was routed or was assigned.

### Open questions carried into implementation — FLAG, do not decide silently

1. **Subject format for pickup orders.** Brief section 10 demands ONE consistent subject for Zendesk routing. This plan's default (Owner decision 1's stated default): keep the single `Delivery Request — StockPilot Order SO-000049 — <site or warehouse>` format for both types, and let the body's "Fulfillment Method: Pickup" carry the distinction. A pickup-specific subject is a SECOND format and needs the owner's explicit sign-off.
2. **Is the recipient pair L4L-only or a product feature every org gets?** This plan hard-codes it (Task 2, with the reasoning). A per-org config column is the only option needing a migration and is explicitly deferred.
3. **Zendesk intake contract** — does DC4's email intake need a subject prefix, a form token or a structured block to route correctly? Nothing in this repo touches email intake; we cannot detect a mis-route from the app side.
4. **Durable second home.** The success surface is React state and dies on refresh. `/dashboard/orders/[id]` already has the full `OrderRequestDetail` server-side and would host the same action naturally. This plan ships the success screen ONLY; the order-detail entry point is recorded as the recommended next phase (Task 12, section I) because it needs R8 handling (5 of 41 prod delivery orders have a NULL charter under a `NOT VALID` CHECK).

### Gaps where the brief's sections 1-40 are not on disk

The owner's brief is a chat message; only its tail (criteria 20 to section 42) and the CC rules were captured in the addendum. Where a section 1-40 detail is needed and neither the addendum nor the audit records it, this plan states the gap rather than inventing the requirement. The four live gaps are listed in the "Unrecorded brief details" section at the end of this document and must be raised with the owner before the affected step is called done.

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `apps/web/src/server/actions/order-requests.ts` | `createOrderRequestAction` returns `{ id, orderNumber }` | 1 |
| `apps/web/src/components/orders/storefront/storefront-logic.ts` | `successRefLine` replaces `orderRef`; the pure draft builder; the three transport builders | 1, 4, 5 |
| `apps/web/src/components/orders/storefront/storefront-logic.test.ts` | Unit coverage for all of the above | 1, 4, 5 |
| `apps/web/src/lib/site.ts` | `DELIVERY_REQUEST_EMAIL` — the ONE recipient definition | 2 |
| `apps/web/src/lib/site.test.ts` | Recipient constants + override-prohibition assertions | 2 |
| `apps/web/src/server/loaders/orders-new-catalog.ts` | Charter loader carries `address`; cache key bumped to `-v2` | 3 |
| `apps/web/src/components/orders/v2/types.ts` | `CharterAddress`, `StorefrontCharter` | 3 |
| `apps/web/src/components/orders/storefront/orders-storefront.tsx` | Threads `orderNumber`, `neededBy`, the destination charter and the order URL into `ReviewModal` | 1, 3, 6 |
| `apps/web/src/app/(dashboard)/dashboard/orders/new/page.tsx` | Passes the widened charter list and the app URL | 3 |
| `apps/web/src/components/orders/storefront/storefront-overlays.tsx` | `ReviewModalProps` widened; renders the action in `.acts`; focus trap + restore | 1, 3, 6, 9 |
| `apps/web/src/components/orders/storefront/storefront-overlays.test.tsx` | NEW — success-stage component coverage | 6, 8, 9 |
| `apps/web/src/components/orders/storefront/delivery-request-action.tsx` | The button, the fallback chain, the preview dialog, the honesty affordances | 6, 7, 8 |
| `apps/web/src/components/orders/storefront/delivery-request-action.test.tsx` | NEW — the full transport matrix | 6, 7, 8, 9 |
| `apps/web/src/components/orders/storefront/storefront.css` | `sf-note`, `sf-recip` styles for the banner and preview | 7, 8 |
| `apps/web/src/server/services/audit.ts` | `order.delivery_request_drafted` union member | 10 |
| `apps/web/src/server/actions/delivery-request.ts` | `recordDeliveryRequestDraftedAction` — safe metadata only | 10 |
| `apps/web/src/server/actions/delivery-request.test.ts` | NEW — asserts the metadata allow-list | 10 |
| `docs/superpowers/reports/2026-08-01-delivery-request-assistant-verification.md` | Real gate output | 11 |
| `docs/superpowers/reports/2026-08-01-delivery-request-assistant-report.md` | Section 41 report, A through I | 12 |

---

# Phase 1 — The data contract

## Task 1: The canonical order number, end to end

`orderRef()` renders `SO-` plus the first 8 hex characters of the UUID. It is visually indistinguishable from the canonical `formatOrderNumber(49) -> 'SO-000049'` but exists NOWHERE else in the product — not the orders list, not the detail page, not any email, not the pick slip. An employee quoting it off the success screen quotes a number nobody can look up. This is the highest-risk item in the audit (R1) and it is wrong TODAY, independent of the assistant. Owner decision 2 folds the fix in here so the email and the screen agree before either is built.

**Files:**
- Modify: `apps/web/src/server/actions/order-requests.ts:83-85, :122`
- Modify: `apps/web/src/components/orders/storefront/storefront-logic.ts:204-216`
- Modify: `apps/web/src/components/orders/storefront/storefront-logic.test.ts`
- Modify: `apps/web/src/components/orders/storefront/orders-storefront.tsx:96, :785-789`
- Modify: `apps/web/src/components/orders/storefront/storefront-overlays.tsx:200-201, :348-352`

**Interfaces:**
- Produces for Tasks 4, 5, 6: `createOrderRequestAction(): Promise<ActionResult<{ id: string; orderNumber: number | null }>>`; `SubmittedOrder = { id: string; orderNumber: number | null; unitCount: number } | null`; `successRefLine(orderNumber: number | null, orderId: string, warehouseName: string, unitCount: number): string`.
- Consumes: `formatOrderNumber` from `@stockpilot/core` (`packages/core/src/orders/order-number.ts`), which returns `string | null` and returns `null` for `0`, `null` and `undefined`.
- Removes: `orderRef` — it must not survive anywhere.

**Steps:**

- [ ] **Step 1: Write the failing test.** In `apps/web/src/components/orders/storefront/storefront-logic.test.ts`, replace the `orderRef` import with `successRefLine` in the import block at the top of the file, and append this describe block at the end of the file (inside the outer scope, as a new top-level `describe`):

```ts
describe('successRefLine', () => {
  it('prints the CANONICAL order number, zero-padded, exactly as every other surface does', () => {
    expect(successRefLine(49, 'b3f1c2d4-0000-0000-0000-000000000000', 'DC4', 7)).toBe(
      'SO-000049 · DC4 · 7 units',
    );
  });

  it('singularizes one unit', () => {
    expect(successRefLine(49, 'b3f1c2d4-0000-0000-0000-000000000000', 'DC4', 1)).toBe(
      'SO-000049 · DC4 · 1 unit',
    );
  });

  it('NEVER fabricates an SO- handle from the uuid when the number is missing', () => {
    // The old orderRef() produced "SO-B3F1C2D4", which looks canonical and is
    // not. When the number is genuinely unavailable we fall back to a handle
    // that is visibly NOT an SO number, so nobody searches for it.
    const line = successRefLine(null, 'b3f1c2d4-0000-0000-0000-000000000000', 'DC4', 7);
    expect(line).toBe('Order b3f1c2d4 · DC4 · 7 units');
    expect(line).not.toContain('SO-');
  });

  it('treats 0 as missing — order_number is a 1-based sequence', () => {
    expect(successRefLine(0, 'b3f1c2d4-0000-0000-0000-000000000000', 'DC4', 2)).toBe(
      'Order b3f1c2d4 · DC4 · 2 units',
    );
  });

  it('pads a large number without truncating it', () => {
    expect(successRefLine(1234567, 'b3f1c2d4-0000-0000-0000-000000000000', 'DC4', 1)).toBe(
      'SO-1234567 · DC4 · 1 unit',
    );
  });
});

describe('the fabricated order handle is gone', () => {
  it('storefront-logic.ts no longer exports orderRef', async () => {
    const mod = await import('./storefront-logic');
    expect('orderRef' in mod).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `pnpm --filter @stockpilot/web test src/components/orders/storefront/storefront-logic.test.ts 2>&1 | tail -20`
Expected: FAIL — the import of `successRefLine` is undefined, reported as `No "successRefLine" export is defined on the "./storefront-logic" mock` or `successRefLine is not a function`. Record the real text.

- [ ] **Step 3: Replace `orderRef` with `successRefLine`.** In `apps/web/src/components/orders/storefront/storefront-logic.ts`, delete the whole `orderRef` block (lines 204-216, comment included) and put this in its place, adding `import { formatOrderNumber } from '@stockpilot/core';` beneath the existing `import type { CartLineState, CatalogItem } from '../v2/types';`:

```ts
/**
 * Success-state reference line, e.g. "SO-000049 · DC4 · 7 units".
 *
 * This used to be `orderRef()`, which rendered `SO-` plus the first 8 hex
 * characters of the order UUID. That string is visually indistinguishable from
 * the canonical `formatOrderNumber()` output but exists NOWHERE else in the
 * product — not in the orders list, not on the detail page, not in any email,
 * not on a pick or packing slip. An employee who quoted it (and, once the
 * delivery-request assistant ships, an employee who mails it to DC4) quoted a
 * number nobody can look up.
 *
 * The canonical number now reaches the client (createOrderRequestAction returns
 * it), so this renders the real handle. When it is genuinely absent — an old
 * client bundle, or a row the BEFORE-INSERT trigger somehow missed — the
 * fallback is deliberately NOT SO-shaped: a bare uuid prefix reads as an
 * internal id, which is honest, where a fake SO number reads as a searchable
 * order number, which is not.
 */
export function successRefLine(
  orderNumber: number | null,
  orderId: string,
  warehouseName: string,
  unitCount: number,
): string {
  const handle = formatOrderNumber(orderNumber) ?? `Order ${orderId.replace(/-/g, '').slice(0, 8)}`;
  const units = `${unitCount} ${unitCount === 1 ? 'unit' : 'units'}`;
  return `${handle} · ${warehouseName} · ${units}`;
}
```

- [ ] **Step 4: Widen the server action.** In `apps/web/src/server/actions/order-requests.ts`, change the signature at line 83-85 and the success return at line 122:

```ts
export async function createOrderRequestAction(
  input: z.input<typeof createSchema>,
): Promise<ActionResult<{ id: string; orderNumber: number | null }>> {
```

and

```ts
    revalidatePath('/dashboard/orders');
    revalidateOrdersCatalog();
    // `create()` already returns the full inserted row from
    // `.insert(...).select('*').single()`, and `order_number` is assigned by the
    // BEFORE-INSERT trigger `assign_order_request_number` (migration 0254) under
    // an advisory lock, so it is populated by the time we get here. Returning it
    // is what lets the success screen and the delivery-request email print the
    // SAME handle the orders list prints.
    return ok({ id: row.id, orderNumber: row.order_number ?? null });
```

- [ ] **Step 5: Thread the number through the storefront.** In `apps/web/src/components/orders/storefront/orders-storefront.tsx`, widen the type at line 96:

```ts
type SubmittedOrder = { id: string; orderNumber: number | null; unitCount: number } | null;
```

and the `setSubmitted` call inside `handleConfirmSubmit` (line 785-788):

```ts
      clearCartDraft(warehouseId);
      setSubmitted({
        id: res.data.id,
        orderNumber: res.data.orderNumber,
        unitCount: lines.reduce((s, l) => s + l.quantity, 0),
      });
      setReviewStage('success');
```

- [ ] **Step 6: Render it.** In `apps/web/src/components/orders/storefront/storefront-overlays.tsx`, change the `orderRef` import to `successRefLine` in the import block from `./storefront-logic`, widen the `submitted` prop type at line 200-201, and replace the `.ref` div at line 348-352:

```ts
  /** Set once the order is created — drives the success reference line. */
  submitted: { id: string; orderNumber: number | null; unitCount: number } | null;
```

```tsx
            <div className="ref">
              {submitted
                ? successRefLine(
                    submitted.orderNumber,
                    submitted.id,
                    summary.warehouseName,
                    submitted.unitCount,
                  )
                : ''}
            </div>
```

- [ ] **Step 7: Run the tests to verify they pass.**

Run: `pnpm --filter @stockpilot/web test src/components/orders/storefront/storefront-logic.test.ts 2>&1 | tail -20`
Expected: PASS — all pre-existing assertions plus the 6 new ones.

- [ ] **Step 8: Prove no `orderRef` call site survives.**

Run: `grep -rn "orderRef" apps/web/src apps/mobile packages`
Expected: no output (exit code 1).

- [ ] **Step 9: Typecheck.**

Run: `pnpm typecheck`
Expected: clean. Any other consumer of `createOrderRequestAction`'s return type surfaces here — `res.data.id` still narrows, so nothing should break; if something does, fix it in this task rather than deferring.

- [ ] **Step 10: Commit.**

```bash
git add apps/web/src/server/actions/order-requests.ts \
        apps/web/src/components/orders/storefront/storefront-logic.ts \
        apps/web/src/components/orders/storefront/storefront-logic.test.ts \
        apps/web/src/components/orders/storefront/orders-storefront.tsx \
        apps/web/src/components/orders/storefront/storefront-overlays.tsx
git commit -m "fix(orders): render the canonical order number on the success screen, not a fabricated SO- handle"
```

---

## Task 2: The locked recipient constants

The addendum's hardest security requirement: both addresses are defined ONCE and can never be influenced by anything a user types. This task creates the single definition and the tests that pin it, before any code that could be tempted to accept a recipient argument exists.

**Where it lives, and why not an env var.** `apps/web/src/lib/site.ts` — the file's own header calls itself "one source of truth" for cross-surface constants, it already holds `SITE_URL`, `SUPPORT_EMAIL` and friends, and critically it does NOT `import 'server-only'`, so a client component can read it. The env route (`NEXT_PUBLIC_DELIVERY_REQUEST_EMAIL`) needs edits in three code files plus `.env.example` plus Vercel, and it has a SILENT failure mode: `env.client.ts` returns `''` and `console.error`s on a missing production value rather than crashing, so a mis-plumbed variable would compose an email to an empty address with no build error (R10). For a two-address operational constant that must never be wrong, a compile-time literal beats a runtime lookup. Making it per-org configurable is owner open question 2 and is deliberately deferred.

**Files:**
- Modify: `apps/web/src/lib/site.ts`
- Create: `apps/web/src/lib/site.test.ts`

**Interfaces:**
- Produces for Tasks 4, 5, 6, 7, 8, 10: `DELIVERY_REQUEST_EMAIL: { readonly to: 'dc4@learn4life.org'; readonly cc: 'arosas@cvwest.org' }` and `DELIVERY_REQUEST_CC_NOTICE: string`.
- Consumes: nothing.

**Steps:**

- [ ] **Step 1: Write the failing test.** Create `apps/web/src/lib/site.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { DELIVERY_REQUEST_CC_NOTICE, DELIVERY_REQUEST_EMAIL } from './site';

/**
 * The recipient pair is an operational constant, not configuration. These
 * assertions exist because getting either address wrong sends warehouse work to
 * the wrong mailbox silently — Outlook opens, the employee sends, and nobody
 * finds out until a delivery is missed.
 */
describe('DELIVERY_REQUEST_EMAIL', () => {
  it('is the exact approved pair', () => {
    expect(DELIVERY_REQUEST_EMAIL.to).toBe('dc4@learn4life.org');
    expect(DELIVERY_REQUEST_EMAIL.cc).toBe('arosas@cvwest.org');
  });

  it('has exactly two recipient keys — no third address sneaks in', () => {
    expect(Object.keys(DELIVERY_REQUEST_EMAIL).sort()).toEqual(['cc', 'to']);
  });

  it('never concatenates the two addresses into one field', () => {
    expect(DELIVERY_REQUEST_EMAIL.to).not.toContain(',');
    expect(DELIVERY_REQUEST_EMAIL.to).not.toContain(';');
    expect(DELIVERY_REQUEST_EMAIL.to).not.toContain(DELIVERY_REQUEST_EMAIL.cc);
    expect(DELIVERY_REQUEST_EMAIL.cc).not.toContain(',');
    expect(DELIVERY_REQUEST_EMAIL.cc).not.toContain(';');
  });

  it('is frozen at runtime, so no caller can mutate the shared object', () => {
    expect(Object.isFrozen(DELIVERY_REQUEST_EMAIL)).toBe(true);
    expect(() => {
      (DELIVERY_REQUEST_EMAIL as unknown as Record<string, string>).cc = 'attacker@evil.test';
    }).toThrow();
    expect(DELIVERY_REQUEST_EMAIL.cc).toBe('arosas@cvwest.org');
  });
});

describe('DELIVERY_REQUEST_CC_NOTICE', () => {
  it('states what the CC does WITHOUT claiming Zendesk assignment', () => {
    expect(DELIVERY_REQUEST_CC_NOTICE).toBe(
      'The DC4 address creates the delivery-request ticket. A copy will also be sent to arosas@cvwest.org.',
    );
  });

  it('never claims a ticket was created, routed or assigned', () => {
    const copy = DELIVERY_REQUEST_CC_NOTICE.toLowerCase();
    for (const claim of ['assigned', 'has been created', 'was created', 'ticket #', 'submitted']) {
      expect(copy).not.toContain(claim);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `pnpm --filter @stockpilot/web test src/lib/site.test.ts 2>&1 | tail -20`
Expected: FAIL — `No "DELIVERY_REQUEST_EMAIL" export is defined on the "./site" module`. Record the real text.

- [ ] **Step 3: Add the constants.** Append to `apps/web/src/lib/site.ts`:

```ts
/**
 * Delivery-request assistant recipients — the ONE definition in the codebase.
 *
 * `to` is Learn4Life's DC4 intake mailbox: mail sent there becomes a Zendesk
 * ticket through Zendesk's EMAIL INTAKE, which is entirely outside this
 * application. Nothing in StockPilot talks to that intake, so StockPilot can
 * never confirm a ticket exists and must never say that it does.
 *
 * `cc` is Andrew Rosas, who receives a direct copy. Existing Zendesk rules MAY
 * use the CC to route or assign — but we cannot observe that, so no copy
 * anywhere may promise it. "A copy will also be sent to arosas@cvwest.org" is
 * the allowed sentence; "this ticket will be assigned to him" is not.
 *
 * SECURITY: these values are compile-time literals on purpose. They are never
 * read from a URL parameter, localStorage, order notes, a requester-entered
 * form value, a client-supplied API parameter, or destination-site data. The
 * draft builder takes NO recipient argument — it reads this object — so there
 * is no parameter for a caller to poison. Frozen so a stray assignment throws
 * in strict mode instead of silently redirecting warehouse mail.
 *
 * Not an env var deliberately: `env.client.ts` returns '' and console.errors on
 * a missing NEXT_PUBLIC value rather than crashing, so a mis-plumbed variable
 * would compose mail to an empty address with no build error. A literal cannot
 * fail that way.
 *
 * OPEN (owner): whether this becomes per-org configuration. That is the only
 * option that needs a migration and it is deliberately deferred.
 */
export const DELIVERY_REQUEST_EMAIL = Object.freeze({
  to: 'dc4@learn4life.org',
  cc: 'arosas@cvwest.org',
} as const);

/** Helper text shown wherever the recipients are displayed. Accuracy, not optimism. */
export const DELIVERY_REQUEST_CC_NOTICE =
  'The DC4 address creates the delivery-request ticket. A copy will also be sent to arosas@cvwest.org.';
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `pnpm --filter @stockpilot/web test src/lib/site.test.ts 2>&1 | tail -20`
Expected: PASS — 6 assertions.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/lib/site.ts apps/web/src/lib/site.test.ts
git commit -m "feat(orders): single locked definition of the delivery-request recipients"
```

---

## Task 3: The destination address reaches the client

The destination is `order_requests.delivery_charter_id -> charters`, and `charters.address` is a jsonb blob whose keys are `line1`, `line2`, `city`, `region`, `postalCode`, `country` — **`region`, NOT `state`**. 12 of 16 prod charters have one; 4 are null. `loadChartersForWarehouse` selects only `id, name, code, status`, so the address never reaches the client today.

This task takes audit §3c option (i) — widen the loader — rather than option (ii) — assemble the body server-side. The reason is Global Constraint 7: a server round-trip inside the click handler forces an `await` before `window.open`, which is a guaranteed popup block. Widening a 5-minute cached loader by one column is cheaper than losing the primary transport.

**R9 is mandatory here:** the `unstable_cache` key MUST be bumped from `orders-new-v2-charters-v1` to `-v2`. Without it, up to 5 minutes of post-deploy entries carry the old shape and the address is silently missing for the first users. The file documents exactly this pattern on its thumbmap loader.

**Files:**
- Modify: `apps/web/src/server/loaders/orders-new-catalog.ts:237-268`
- Modify: `apps/web/src/components/orders/v2/types.ts`
- Modify: `apps/web/src/components/orders/storefront/orders-storefront.tsx:89, :570`
- Modify: `apps/web/src/app/(dashboard)/dashboard/orders/new/page.tsx`
- Modify: `apps/web/src/components/orders/storefront/storefront-overlays.tsx:185-206`
- Modify: `apps/web/src/components/orders/storefront/storefront-logic.test.ts`

**Interfaces:**
- Produces for Tasks 4, 5, 6: `CharterAddress`, `StorefrontCharter`, `toPlainTextLine(value: string): string`, `formatSiteAddressLines(address: CharterAddress | null): string[]`; `ReviewModalProps` gains `neededBy: string`, `destination: StorefrontCharter | null`, `orderUrlBase: string`.
- Consumes from Task 1: nothing. From Task 2: nothing.
- Note for later tasks: `state.neededBy` is a `datetime-local` string (`'YYYY-MM-DDTHH:mm'`) or `''` on `CartState` (`v2/types.ts:52`). It is normalised to a real instant via `new Date(x).toISOString()` at submit time (`orders-storefront.tsx:761`). The modal receives the RAW `datetime-local` value and the builder does the same normalisation — never a `slice(0, 10)` on an ISO string (R2).

**Steps:**

- [ ] **Step 1: Write the failing test.** Append to `apps/web/src/components/orders/storefront/storefront-logic.test.ts`, and add `formatSiteAddressLines` to the import block from `./storefront-logic`:

```ts
describe('formatSiteAddressLines', () => {
  it('renders a full US address as street / city-region-postal / country', () => {
    expect(
      formatSiteAddressLines({
        line1: '1295 Shaw Ave',
        line2: null,
        city: 'Fresno',
        region: 'California',
        postalCode: '93612',
        country: 'United States',
      }),
    ).toEqual(['1295 Shaw Ave', 'Fresno, California 93612', 'United States']);
  });

  it('keeps line2 as its own line when present', () => {
    expect(
      formatSiteAddressLines({
        line1: '1295 Shaw Ave',
        line2: 'Suite 200',
        city: 'Fresno',
        region: 'California',
        postalCode: '93612',
        country: 'United States',
      }),
    ).toEqual(['1295 Shaw Ave', 'Suite 200', 'Fresno, California 93612', 'United States']);
  });

  it('returns NO lines at all for a null address — 4 of 16 sites have none', () => {
    expect(formatSiteAddressLines(null)).toEqual([]);
  });

  it('returns no lines for an all-blank address rather than blank lines', () => {
    expect(
      formatSiteAddressLines({ line1: '', line2: null, city: '  ', region: null, postalCode: '', country: null }),
    ).toEqual([]);
  });

  it('omits the city line entirely when city, region and postal are all missing', () => {
    expect(formatSiteAddressLines({ line1: '1295 Shaw Ave', country: 'United States' })).toEqual([
      '1295 Shaw Ave',
      'United States',
    ]);
  });

  it('reads `region`, never `state` — the jsonb key is region', () => {
    const lines = formatSiteAddressLines({
      line1: '1 Main St',
      city: 'Tulare',
      region: 'California',
      postalCode: '93274',
    } as never);
    expect(lines).toContain('Tulare, California 93274');
  });

  it('passes a typo through verbatim instead of guessing — KVA Tulare really says "Calfornia"', () => {
    // Data quality is the owner's to fix. Silently "correcting" a site address
    // in an outbound delivery instruction would be worse than reproducing it.
    expect(formatSiteAddressLines({ city: 'Fresno', region: 'Calfornia', postalCode: '93274' })).toEqual([
      'Fresno, Calfornia 93274',
    ]);
  });

  it('collapses newlines injected into an address field to a single space', () => {
    expect(formatSiteAddressLines({ line1: '1 Main St\nBcc: evil@evil.test' })).toEqual([
      '1 Main St Bcc: evil@evil.test',
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `pnpm --filter @stockpilot/web test src/components/orders/storefront/storefront-logic.test.ts 2>&1 | tail -20`
Expected: FAIL — `formatSiteAddressLines is not a function`. Record the real text.

- [ ] **Step 3: Add the shared types.** In `apps/web/src/components/orders/v2/types.ts`, append:

```ts
/**
 * `charters.address` is a jsonb blob, not a typed column set. Every key is
 * optional and any of them can be null or an empty string in prod.
 *
 * The regional key is **`region`**, NOT `state`. Reading `state` returns
 * undefined for every row in the database.
 */
export interface CharterAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

/**
 * A delivery site as the storefront sees it. The UI calls a charter a "site".
 * `address` is present for 12 of 16 prod charters; null for the rest, and the
 * renderer must print NOTHING rather than an empty labelled block when it is.
 */
export interface StorefrontCharter {
  id: string;
  name: string;
  code: string | null;
  address: CharterAddress | null;
}
```

- [ ] **Step 4: Add the pure formatter.** Append to `apps/web/src/components/orders/storefront/storefront-logic.ts`, and add `CharterAddress` to the existing type import from `../v2/types`:

```ts
/**
 * Collapse anything destined for a plain-text email line: CR, LF, tabs and any
 * other control character become a single space, and the result is trimmed.
 *
 * Two reasons, both real. (1) A newline inside a value would break the body's
 * block structure and could forge a header-looking line ("Bcc: ...") in a mail
 * client that parses the pasted text. (2) The repo already has this helper —
 * `sanitizePlainText` in lib/email/order-requests.ts:1247 — but it is
 * module-private and lives in a `server-only` module, so a client builder
 * cannot import it. This is the client-side twin, deliberately named
 * differently so nobody assumes the two are kept in sync.
 */
export function toPlainTextLine(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Render `charters.address` as zero or more plain-text lines.
 *
 * Returns an EMPTY array whenever there is nothing real to print. The caller
 * must then omit the whole block: 4 of 16 prod charters have `address = null`,
 * and printing "Address:" with nothing under it implies the system captured
 * something it did not.
 *
 * Values are reproduced verbatim, typos included (KVA Tulare's address really
 * says "Calfornia"). Silently correcting a site address inside a delivery
 * instruction would be a worse failure than reproducing the owner's data.
 */
export function formatSiteAddressLines(address: CharterAddress | null): string[] {
  if (!address) return [];
  const clean = (v: string | null | undefined): string =>
    typeof v === 'string' ? toPlainTextLine(v) : '';

  const lines: string[] = [];
  const line1 = clean(address.line1);
  const line2 = clean(address.line2);
  if (line1) lines.push(line1);
  if (line2) lines.push(line2);

  const city = clean(address.city);
  const region = clean(address.region);
  const postal = clean(address.postalCode);
  const cityRegion = [city, region].filter(Boolean).join(', ');
  const cityLine = [cityRegion, postal].filter(Boolean).join(' ');
  if (cityLine) lines.push(cityLine);

  const country = clean(address.country);
  if (country) lines.push(country);

  return lines;
}
```

- [ ] **Step 5: Widen the loader and BUMP THE CACHE KEY.** In `apps/web/src/server/loaders/orders-new-catalog.ts`, replace the `loadChartersForWarehouseCached` block and the exported wrapper (lines 236-268) with:

```ts
/**
 * Charters per warehouse change rarely — cache for 5 minutes. Same
 * admin-client + page-perimeter argument as the catalog cache.
 *
 * `address` (jsonb) rides along so the delivery-request assistant can print a
 * street address on the success screen WITHOUT a server round-trip inside the
 * click handler. That matters: window.open must run in the same tick as the
 * click or the browser blocks the popup, so any await before it is fatal.
 *
 * The key is v2 because the returned SHAPE changed. Leaving it at v1 would let
 * up-to-5-minute-old entries without `address` linger after the deploy, and the
 * address would silently be missing for the first users — the same trap the
 * thumbmap loader above documents.
 */
const loadChartersForWarehouseCached = unstable_cache(
  async (warehouseId: string): Promise<StorefrontCharter[]> => {
    const supabase = createAdminClient();
    const { data: pairs } = await supabase
      .from('warehouse_charters')
      .select('charter:charters!inner (id, name, code, status, address)')
      .eq('warehouse_id', warehouseId);
    return (pairs ?? []).flatMap((p) => {
      const c = Array.isArray((p as { charter?: unknown }).charter)
        ? ((p as { charter: unknown[] }).charter[0] as Record<string, unknown>)
        : ((p as { charter: unknown }).charter as Record<string, unknown> | null);
      if (!c || (c.status as string) !== 'active') return [];
      const raw = c.address;
      // jsonb: could be null, an object, or (defensively) a scalar. Anything
      // that is not a plain object is treated as "no address".
      const address =
        raw !== null && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as StorefrontCharter['address'])
          : null;
      return [
        {
          id: c.id as string,
          name: c.name as string,
          code: (c.code as string | null) ?? null,
          address,
        },
      ];
    });
  },
  ['orders-new-v2-charters-v2'],
  { revalidate: 300, tags: ['orders-new-v2-charters'] },
);

export async function loadChartersForWarehouse(
  warehouseId: string,
): Promise<StorefrontCharter[]> {
  return loadChartersForWarehouseCached(warehouseId);
}
```

Add the type import at the top of the file, alongside its existing imports:

```ts
import type { StorefrontCharter } from '@/components/orders/v2/types';
```

- [ ] **Step 6: Widen the prop types down the chain.** In `apps/web/src/components/orders/storefront/orders-storefront.tsx`, replace BOTH occurrences of the inline charter array type (line 89 in the outer props interface and line 570 in the inner shell props interface) with:

```ts
  chartersForWarehouse: StorefrontCharter[];
```

and add `StorefrontCharter` to the existing type import from `../v2/types`. Then, in `apps/web/src/app/(dashboard)/dashboard/orders/new/page.tsx`, confirm the value flows through unchanged — `loadChartersForWarehouse` already returns the new shape, so no edit is needed there unless the page annotates the type explicitly; if it does, widen the annotation to `StorefrontCharter[]`.

- [ ] **Step 7: Pass the three missing values into the modal.** In `apps/web/src/components/orders/storefront/storefront-overlays.tsx`, widen `ReviewModalProps` (lines 193-206) by adding these three fields after `summary`:

```ts
  /**
   * Raw `datetime-local` value from the cart ('YYYY-MM-DDTHH:mm') or ''. It has
   * never reached this modal before; the delivery-request draft needs it. It is
   * NOT an ISO instant — the builder normalises it the same way
   * handleConfirmSubmit does, with `new Date(v).toISOString()`.
   */
  neededBy: string;
  /**
   * The delivery site, when the order is a delivery. Null for pickup — and the
   * draft must then print no destination at all rather than an empty block.
   */
  destination: StorefrontCharter | null;
  /** Absolute origin for the order deep link, e.g. 'https://app.example.com'. */
  orderUrlBase: string;
```

destructure them in the `ReviewModal` signature alongside `summary`, and add `StorefrontCharter` to the type import from `../v2/types`.

In `apps/web/src/components/orders/storefront/orders-storefront.tsx`, pass them at the `<ReviewModal ... />` call site (lines 1146-1166), immediately after the `summary={{ ... }}` prop:

```tsx
        neededBy={state.neededBy}
        destination={state.fulfillmentType === 'delivery' ? charter : null}
        orderUrlBase={orderUrlBase}
```

and add `orderUrlBase: string;` to the shell props interface, threading it from the outer component, which reads it from a new prop on `OrdersStorefront` supplied by `new/page.tsx` as `env.NEXT_PUBLIC_APP_URL` with any trailing slash stripped. If the page cannot supply it, pass `SITE_URL` from `@/lib/site` — never let the value be an empty string, because a bare `/dashboard/orders/<uuid>` in an email is not clickable.

- [ ] **Step 8: Run the tests to verify they pass.**

Run: `pnpm --filter @stockpilot/web test src/components/orders/storefront/storefront-logic.test.ts 2>&1 | tail -20`
Expected: PASS — 8 new assertions plus everything from Task 1.

- [ ] **Step 9: Typecheck and confirm the cache key bump.**

Run: `pnpm typecheck && grep -n "orders-new-v2-charters" apps/web/src/server/loaders/orders-new-catalog.ts`
Expected: typecheck clean; the grep shows `['orders-new-v2-charters-v2']` and the unchanged `tags: ['orders-new-v2-charters']`. If `-v1` still appears anywhere, the deploy will serve stale shapes — fix before committing.

- [ ] **Step 10: Regression check (R1).** Run the existing storefront suite and confirm nothing about browsing, filtering or the review stage changed:

Run: `pnpm --filter @stockpilot/web test src/components/orders 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 11: Commit.**

```bash
git add apps/web/src/server/loaders/orders-new-catalog.ts \
        apps/web/src/components/orders/v2/types.ts \
        apps/web/src/components/orders/storefront/storefront-logic.ts \
        apps/web/src/components/orders/storefront/storefront-logic.test.ts \
        apps/web/src/components/orders/storefront/orders-storefront.tsx \
        apps/web/src/components/orders/storefront/storefront-overlays.tsx \
        "apps/web/src/app/(dashboard)/dashboard/orders/new/page.tsx"
git commit -m "feat(orders): carry the delivery site address and needed-by date to the success screen"
```

---

# Phase 2 — The pure builder

## Task 4: `buildDeliveryRequestDraft` — subject and plain-text body

The whole email, assembled from plain data with no React, no DOM, no network and no recipient argument. Everything downstream — the three transports, the preview, the clipboard text, the tests — reads this one result.

**The honesty rule this task enforces.** A third of the brief's email template describes data that does not exist. Stated plainly, from the audit's FIELD REALITY TABLE:

| Brief field | Reality | What the builder does |
|---|---|---|
| Destination building | **ABSENT** — no column on `charters.address`, `order_requests`, or anywhere in the public schema | Omit. No label, no blank line. |
| Destination room | **ABSENT** — same | Omit. |
| Delivery instructions | **ABSENT** — a schema-wide scan for `instruction\|dropoff\|drop_off\|ship_to\|deliver_to` matched only `public_request_links.instructions`, which is unrelated public-link page copy | Omit. Order notes are the nearest real field and are printed under their own honest heading. |
| Priority / urgency / rush | **ABSENT** — `order_requests` has no `priority`, `urgency`, `rush` or `is_expedited`; the only `priority` column in the whole schema is `support_tickets.priority` | Omit. |
| Destination contact name | Schema-present, **DATA-EMPTY: 0 of 16 charters** | Omit the entire contact block. |
| Destination contact email | Schema-present, **DATA-EMPTY: 0 of 16** | Omit. |
| Destination contact phone | Schema-present, **1 of 16** | Omit — one populated row out of sixteen is not a field, and a block that appears for one site and vanishes for fifteen reads as a bug. |
| Requester phone | Column exists, but the internal storefront hardcodes `requesterPhone: null` (`orders-storefront.tsx:763`) | Omit. |
| Per-line note | Column exists; the storefront maps only `{itemId, quantity}` and **0 of 150** prod line rows have one | Omit. |
| Unit of measure | Column exists but is not selected by the order path, and the data is messy free text (`unit` 446, `each` 12, `''` 11, `ea` 11, `pair` 8, `Pack of 2` 1) | Omit. Quantities read as bare counts, which is what the storefront itself shows. |

**The honest substitute for a destination**, in descending order of confidence: site name + code (always present, already on screen as `summary.deliverTo`, and what DC4 staff already recognise); then the street address when the site has one; then nothing. The requester — whose name and email ARE reliable — is the honest person for DC4 to contact, so the body names them instead of a site contact.

**Pickup (Owner decision D1).** A pickup order has no destination in the data at all: `delivery_charter_id` is NULL by CHECK constraint, and `pickup_location_notes` is NULL on all 78 prod rows. The body therefore prints PICKUP FROM (the origin warehouse) and COLLECTED BY (the requester) and NO destination block whatsoever.

**Files:**
- Modify: `apps/web/src/components/orders/storefront/storefront-logic.ts`
- Modify: `apps/web/src/components/orders/storefront/storefront-logic.test.ts`

**Interfaces:**
- Produces for Tasks 5, 6, 7, 8: `DeliveryRequestInput`, `DeliveryRequestDraft`, `buildDeliveryRequestDraft(input: DeliveryRequestInput, opts?: { condensed?: boolean }): DeliveryRequestDraft`.
- Consumes from Task 1: `formatOrderNumber`. From Task 2: `DELIVERY_REQUEST_EMAIL`. From Task 3: `StorefrontCharter`, `CharterAddress`, `formatSiteAddressLines`, `toPlainTextLine`.
- Also consumes: `formatOrgDateTime`, `ORG_TIMEZONE_DEFAULT` from `@/lib/timezone`; `CartLineState`, `CatalogItem` from `../v2/types`.

**Steps:**

- [ ] **Step 1: Write the failing test.** Append to `apps/web/src/components/orders/storefront/storefront-logic.test.ts`, adding `buildDeliveryRequestDraft` to the import block from `./storefront-logic` and `DELIVERY_REQUEST_EMAIL` from `@/lib/site`:

```ts
import { DELIVERY_REQUEST_EMAIL } from '@/lib/site';

import type { DeliveryRequestInput } from './storefront-logic';

/**
 * Fixture for the draft builder. Deliberately a DELIVERY order with every
 * optional field populated, so each test can strip exactly the one thing it is
 * about instead of building up from nothing.
 */
function makeDraftInput(overrides: Partial<DeliveryRequestInput> = {}): DeliveryRequestInput {
  const polo = makeItem({ id: 'i-1', sku: 'APP-POLO-W', name: "L4L Polo (Women's)" });
  const bottle = makeItem({ id: 'i-2', sku: 'GEN-BOTL', name: 'L4L Water Bottle' });
  return {
    orderId: 'b3f1c2d4-1111-2222-3333-444455556666',
    orderNumber: 49,
    orderUrlBase: 'https://app.stockpilotusa.com',
    fulfillmentType: 'delivery',
    warehouseName: 'DC4',
    destination: {
      id: 'ch-1',
      name: 'CVW Clovis',
      code: 'CVW-CLO',
      address: {
        line1: '1295 Shaw Ave',
        line2: null,
        city: 'Fresno',
        region: 'California',
        postalCode: '93612',
        country: 'United States',
      },
    },
    requestedFor: 'Branden Vincent-Walker',
    requesterEmail: 'branden@cvwest.org',
    neededByLocal: '2026-08-05T09:00',
    orgTimezone: 'America/Los_Angeles',
    notes: 'Please stage these by Friday.',
    lines: [
      { itemId: 'i-1', quantity: 5 },
      { itemId: 'i-2', quantity: 2 },
    ],
    itemMap: new Map([
      ['i-1', polo],
      ['i-2', bottle],
    ]),
    ...overrides,
  };
}

describe('buildDeliveryRequestDraft — recipients', () => {
  it('carries both recipients as explicit properties, read from the ONE constant', () => {
    const draft = buildDeliveryRequestDraft(makeDraftInput());
    expect(draft.to).toBe(DELIVERY_REQUEST_EMAIL.to);
    expect(draft.cc).toBe(DELIVERY_REQUEST_EMAIL.cc);
    expect(draft.to).toBe('dc4@learn4life.org');
    expect(draft.cc).toBe('arosas@cvwest.org');
  });

  it('never puts either recipient in the body — the CC is a real field, not prose', () => {
    const draft = buildDeliveryRequestDraft(makeDraftInput());
    expect(draft.body).not.toContain('dc4@learn4life.org');
    expect(draft.body).not.toContain('arosas@cvwest.org');
  });

  it('accepts NO recipient argument — there is no parameter for a caller to poison', () => {
    // Passing hostile values through every user-controlled field must not move
    // the recipients. This is the security invariant in executable form.
    const draft = buildDeliveryRequestDraft(
      makeDraftInput({
        notes: 'to=attacker@evil.test cc=attacker2@evil.test',
        requestedFor: 'attacker@evil.test',
        requesterEmail: 'attacker@evil.test',
        destination: {
          id: 'ch-x',
          name: 'attacker@evil.test',
          code: 'to=attacker@evil.test',
          address: { line1: 'cc: attacker@evil.test' },
        },
      }),
    );
    expect(draft.to).toBe('dc4@learn4life.org');
    expect(draft.cc).toBe('arosas@cvwest.org');
  });
});

describe('buildDeliveryRequestDraft — subject', () => {
  it('is ONE format carrying the canonical order number and the destination', () => {
    expect(buildDeliveryRequestDraft(makeDraftInput()).subject).toBe(
      'Delivery Request — StockPilot Order SO-000049 — CVW Clovis',
    );
  });

  it('uses the SAME format for pickup, with the warehouse as the location', () => {
    // Brief section 10 wants one subject shape so Zendesk routing stays
    // uniform; the body's Fulfillment Method line carries the distinction.
    // A pickup-specific subject would be a second format and needs owner
    // sign-off (see the plan's open questions).
    const draft = buildDeliveryRequestDraft(
      makeDraftInput({ fulfillmentType: 'pickup', destination: null }),
    );
    expect(draft.subject).toBe('Delivery Request — StockPilot Order SO-000049 — DC4');
  });

  it('falls back to the warehouse when a delivery order somehow has no site', () => {
    // R8: order_requests_delivery_target_chk is NOT VALID, so 5 of 41 prod
    // delivery rows have delivery_charter_id = NULL. New orders cannot reach
    // this state, but the builder must not print "undefined".
    const draft = buildDeliveryRequestDraft(makeDraftInput({ destination: null }));
    expect(draft.subject).toBe('Delivery Request — StockPilot Order SO-000049 — DC4');
    expect(draft.subject).not.toContain('undefined');
    expect(draft.subject).not.toContain('null');
  });

  it('degrades honestly when the order number is missing', () => {
    const draft = buildDeliveryRequestDraft(makeDraftInput({ orderNumber: null }));
    expect(draft.subject).toBe('Delivery Request — StockPilot Order b3f1c2d4 — CVW Clovis');
    expect(draft.subject).not.toContain('SO-');
  });

  it('is a single line — a newline in a subject is a header-injection shape', () => {
    const draft = buildDeliveryRequestDraft(
      makeDraftInput({
        destination: { id: 'x', name: 'Clovis\nBcc: evil@evil.test', code: null, address: null },
      }),
    );
    expect(draft.subject).not.toContain('\n');
    expect(draft.subject).not.toContain('\r');
  });
});

describe('buildDeliveryRequestDraft — delivery body', () => {
  it('states the method, the origin, the destination and the needed-by date', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput());
    expect(body).toContain('Fulfillment method: Delivery');
    expect(body).toContain('FROM (WAREHOUSE)\nDC4');
    expect(body).toContain('DELIVERY DESTINATION\nCVW Clovis (CVW-CLO)');
    expect(body).toContain('1295 Shaw Ave');
    expect(body).toContain('Fresno, California 93612');
  });

  it('renders needed-by in the ORG timezone with the zone named, never a raw ISO string', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput());
    expect(body).toContain('NEEDED BY');
    expect(body).toContain('America/Los_Angeles');
    expect(body).not.toContain('2026-08-05T');
    expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it('omits the NEEDED BY block entirely when none was given — 70 of 78 prod orders have none', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput({ neededByLocal: '' }));
    expect(body).not.toContain('NEEDED BY');
  });

  it('lists every line with name, SKU and quantity, and a counted heading', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput());
    expect(body).toContain('ITEMS (2 lines, 7 units)');
    expect(body).toContain("1. L4L Polo (Women's) — APP-POLO-W — qty 5");
    expect(body).toContain('2. L4L Water Bottle — GEN-BOTL — qty 2');
  });

  it('singularizes one line and one unit', () => {
    const { body } = buildDeliveryRequestDraft(
      makeDraftInput({ lines: [{ itemId: 'i-1', quantity: 1 }] }),
    );
    expect(body).toContain('ITEMS (1 line, 1 unit)');
  });

  it('falls back to the item id when the catalog map has no entry', () => {
    const { body } = buildDeliveryRequestDraft(
      makeDraftInput({ lines: [{ itemId: 'ghost', quantity: 3 }], itemMap: new Map() }),
    );
    expect(body).toContain('1. ghost — qty 3');
  });

  it('handles zero lines without emitting an empty ITEMS block', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput({ lines: [] }));
    expect(body).not.toContain('ITEMS (');
    expect(body).toContain('No line items were recorded on this order.');
  });

  it('prints the order notes under an honest heading, not as "delivery instructions"', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput());
    expect(body).toContain('ORDER NOTES\nPlease stage these by Friday.');
    expect(body).not.toContain('DELIVERY INSTRUCTIONS');
  });

  it('omits the notes block when there are none', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput({ notes: '   ' }));
    expect(body).not.toContain('ORDER NOTES');
  });

  it('includes an absolute, clickable order link', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput());
    expect(body).toContain(
      'Order link: https://app.stockpilotusa.com/dashboard/orders/b3f1c2d4-1111-2222-3333-444455556666',
    );
  });

  it('omits the link rather than emitting a relative path when no base is configured', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput({ orderUrlBase: '' }));
    expect(body).not.toContain('Order link:');
    expect(body).not.toContain('/dashboard/orders/');
  });

  it('states the real status — a fresh internal order is pending approval, not approved', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput());
    expect(body).toContain('Order status in StockPilot: Pending approval');
    for (const claim of ['approved', 'reserved', 'scheduled', 'ticket']) {
      expect(body.toLowerCase()).not.toContain(`is ${claim}`);
    }
  });

  it('closes with the non-claim footer', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput());
    expect(body).toContain(
      'Drafted in StockPilot. StockPilot did not send this message and has not created a ticket.',
    );
  });
});

describe('buildDeliveryRequestDraft — pickup body (owner decision: pickup gets the assistant)', () => {
  const pickup = () =>
    buildDeliveryRequestDraft(makeDraftInput({ fulfillmentType: 'pickup', destination: null }));

  it('states pickup as the method', () => {
    expect(pickup().body).toContain('Fulfillment method: Pickup / will-call');
  });

  it('names where to collect from and who is collecting', () => {
    const { body } = pickup();
    expect(body).toContain('PICKUP FROM\nDC4 will-call desk');
    expect(body).toContain('COLLECTED BY\nBranden Vincent-Walker (branden@cvwest.org)');
  });

  it('prints NO destination block and no empty or invented address', () => {
    const { body } = pickup();
    expect(body).not.toContain('DELIVERY DESTINATION');
    expect(body).not.toContain('1295 Shaw Ave');
    expect(body).not.toContain('Address:');
  });

  it('ignores a stray destination on a pickup order rather than printing it', () => {
    // fulfillment_type is the authority. A pickup order's charter is NULL by
    // CHECK constraint; if one ever arrives, printing it would invent a
    // destination the order does not have.
    const { body } = buildDeliveryRequestDraft(makeDraftInput({ fulfillmentType: 'pickup' }));
    expect(body).not.toContain('DELIVERY DESTINATION');
    expect(body).not.toContain('CVW Clovis');
  });
});

describe('buildDeliveryRequestDraft — fields that DO NOT EXIST are omitted, never stubbed', () => {
  it('never prints a labelled-but-empty row for building, room, instructions or priority', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput());
    for (const absent of [
      'Building',
      'Room',
      'Delivery instructions',
      'DELIVERY INSTRUCTIONS',
      'Priority',
      'PRIORITY',
      'Urgency',
      'Rush',
    ]) {
      expect(body).not.toContain(absent);
    }
  });

  it('never prints a site contact block — 0 of 16 charters have a name or email', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput());
    expect(body).not.toContain('Site contact');
    expect(body).not.toContain('CONTACT');
  });

  it('never prints a unit of measure or a per-line note', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput());
    expect(body).not.toContain('UOM');
    expect(body).not.toContain('Unit of measure');
    expect(body).not.toContain('Line note');
  });

  it('never prints cost, price or any staff-only figure', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput());
    for (const leak of ['$', 'cost', 'Cost', 'price', 'Price', 'internal', 'Internal', 'Picker']) {
      expect(body).not.toContain(leak);
    }
  });

  it('omits the address lines for a site that has none, keeping the name and code', () => {
    const { body } = buildDeliveryRequestDraft(
      makeDraftInput({
        destination: { id: 'ch-2', name: 'KVA Tulare', code: 'KVA-TUL', address: null },
      }),
    );
    expect(body).toContain('DELIVERY DESTINATION\nKVA Tulare (KVA-TUL)');
    expect(body).not.toContain('Address');
  });

  it('prints a site with no code without an empty parenthesis', () => {
    const { body } = buildDeliveryRequestDraft(
      makeDraftInput({ destination: { id: 'ch-3', name: 'Mendota', code: null, address: null } }),
    );
    expect(body).toContain('DELIVERY DESTINATION\nMendota');
    expect(body).not.toContain('Mendota ()');
  });
});

describe('buildDeliveryRequestDraft — plain text and safety', () => {
  it('is plain text: no HTML, no markdown emphasis, no CRLF', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput());
    expect(body).not.toMatch(/<[a-z/][^>]*>/i);
    expect(body).not.toContain('**');
    expect(body).not.toContain('\r');
  });

  it('collapses newlines inside user text so nothing can forge a header line', () => {
    const { body } = buildDeliveryRequestDraft(
      makeDraftInput({ notes: 'Line one\nBcc: evil@evil.test\nLine two' }),
    );
    expect(body).toContain('ORDER NOTES\nLine one Bcc: evil@evil.test Line two');
    expect(body).not.toContain('\nBcc:');
  });

  it('never emits three consecutive newlines', () => {
    expect(buildDeliveryRequestDraft(makeDraftInput()).body).not.toContain('\n\n\n');
  });

  it('reports condensed:false and a real character count for a normal order', () => {
    const draft = buildDeliveryRequestDraft(makeDraftInput());
    expect(draft.condensed).toBe(false);
    expect(draft.lineCount).toBe(2);
    expect(draft.unitCount).toBe(7);
  });
});

describe('buildDeliveryRequestDraft — condensed mode', () => {
  it('keeps both recipients, the subject, the counts and the link', () => {
    const draft = buildDeliveryRequestDraft(makeDraftInput(), { condensed: true });
    expect(draft.to).toBe('dc4@learn4life.org');
    expect(draft.cc).toBe('arosas@cvwest.org');
    expect(draft.subject).toBe('Delivery Request — StockPilot Order SO-000049 — CVW Clovis');
    expect(draft.condensed).toBe(true);
    expect(draft.body).toContain('ITEMS (2 lines, 7 units)');
    expect(draft.body).toContain(
      'Order link: https://app.stockpilotusa.com/dashboard/orders/b3f1c2d4-1111-2222-3333-444455556666',
    );
  });

  it('DISCLOSES the truncation in the body rather than silently dropping lines', () => {
    const draft = buildDeliveryRequestDraft(makeDraftInput(), { condensed: true });
    expect(draft.body).toContain(
      'This message was shortened because the full item list did not fit in a compose link. The complete order is at the link above.',
    );
  });

  it('drops the per-line list and the address, which is what makes it short', () => {
    const draft = buildDeliveryRequestDraft(makeDraftInput(), { condensed: true });
    expect(draft.body).not.toContain('APP-POLO-W');
    expect(draft.body).not.toContain('1295 Shaw Ave');
    expect(draft.body.length).toBeLessThan(
      buildDeliveryRequestDraft(makeDraftInput()).body.length,
    );
  });

  it('keeps the site name so DC4 still knows where it goes', () => {
    const draft = buildDeliveryRequestDraft(makeDraftInput(), { condensed: true });
    expect(draft.body).toContain('CVW Clovis');
  });

  it('still adapts to pickup', () => {
    const draft = buildDeliveryRequestDraft(
      makeDraftInput({ fulfillmentType: 'pickup', destination: null }),
      { condensed: true },
    );
    expect(draft.body).toContain('Pickup / will-call');
    expect(draft.body).not.toContain('DELIVERY DESTINATION');
  });
});

describe('buildDeliveryRequestDraft — a 100-line order (the zod maximum)', () => {
  const bigInput = () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({ itemId: `big-${i}`, quantity: 4 }));
    const itemMap = new Map(
      lines.map((l, i) => [
        l.itemId,
        makeItem({ id: l.itemId, sku: `SKU-BIG-${i}`, name: `Bulk Item Number ${i}` }),
      ]),
    );
    return makeDraftInput({ lines, itemMap });
  };

  it('renders all 100 lines in full mode', () => {
    const { body, lineCount, unitCount } = buildDeliveryRequestDraft(bigInput());
    expect(lineCount).toBe(100);
    expect(unitCount).toBe(400);
    expect(body).toContain('ITEMS (100 lines, 400 units)');
    expect(body).toContain('100. Bulk Item Number 99 — SKU-BIG-99 — qty 4');
  });

  it('keeps both recipients at that size', () => {
    const draft = buildDeliveryRequestDraft(bigInput(), { condensed: true });
    expect(draft.to).toBe('dc4@learn4life.org');
    expect(draft.cc).toBe('arosas@cvwest.org');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `pnpm --filter @stockpilot/web test src/components/orders/storefront/storefront-logic.test.ts 2>&1 | tail -20`
Expected: FAIL — `buildDeliveryRequestDraft is not a function`. Record the real text.

- [ ] **Step 3: Implement the builder.** Append to `apps/web/src/components/orders/storefront/storefront-logic.ts`, adding these imports at the top of the file alongside the existing ones:

```ts
import { DELIVERY_REQUEST_EMAIL } from '@/lib/site';
import { ORG_TIMEZONE_DEFAULT, formatOrgDateTime } from '@/lib/timezone';

import type { CharterAddress, StorefrontCharter } from '../v2/types';
```

then the builder itself:

```ts
/* ---- delivery-request assistant ------------------------------------------ */

/**
 * Everything the draft builder is allowed to see.
 *
 * This is an explicit ALLOW-LIST, not a DTO spread. `internal_notes`,
 * reservations, the assigned picker, `unit_cost_at_request` and
 * `unit_price_at_request` are all staff-only and must never reach a mailbox
 * outside the organisation — the way to guarantee that is for the builder to
 * have no way to reach them.
 *
 * Note what is NOT here, because the data does not exist anywhere in the
 * schema: destination building, room, delivery instructions, priority/urgency,
 * a site contact (0 of 16 charters have a name or email), a requester phone
 * (the internal storefront hardcodes null), a per-line note (0 of 150 prod
 * rows), and unit of measure (present but unselected and messy free text).
 * Adding any of them is a product decision about data CAPTURE and belongs in a
 * separate spec — the assistant must not print a labelled row that implies the
 * system asked a question it never asked.
 */
export interface DeliveryRequestInput {
  /** Order UUID. The detail route is keyed by UUID; there is no route that resolves an SO number. */
  orderId: string;
  /** `order_requests.order_number`, or null when it did not reach the client. */
  orderNumber: number | null;
  /** Absolute origin, no trailing slash, e.g. 'https://app.stockpilotusa.com'. '' disables the link. */
  orderUrlBase: string;
  fulfillmentType: 'pickup' | 'delivery';
  /** Origin warehouse display name. */
  warehouseName: string;
  /** The delivery site. Null for pickup, and null for the 5 legacy delivery rows with no charter. */
  destination: StorefrontCharter | null;
  /** Who the order is for — on-behalf-of name, else the viewer's name, else their email. */
  requestedFor: string;
  /** The requester's email when known. The one contact DC4 can actually reach. */
  requesterEmail: string | null;
  /** Raw `datetime-local` value ('YYYY-MM-DDTHH:mm') or ''. NOT an ISO instant. */
  neededByLocal: string;
  /** `organizations.timezone`; falls back to America/Los_Angeles. */
  orgTimezone: string;
  /** `order_requests.notes` — the requester-facing message. Safe to include. */
  notes: string;
  lines: readonly CartLineState[];
  itemMap: ReadonlyMap<string, CatalogItem>;
}

/**
 * The prepared draft. `to` and `cc` are EXPLICIT properties, not merely
 * embedded in a URL, so the preview, both URL builders, the clipboard fallback,
 * the a11y labels and the tests all read one source (addendum requirement 5).
 */
export interface DeliveryRequestDraft {
  to: string;
  cc: string;
  subject: string;
  body: string;
  /** True when the item list and address were dropped to fit a compose link. */
  condensed: boolean;
  lineCount: number;
  unitCount: number;
}

/** A fresh internal order is inserted as 'pending_approval' — never claim more. */
const DRAFT_STATUS_LABEL = 'Pending approval';

const NON_CLAIM_FOOTER =
  'Drafted in StockPilot. StockPilot did not send this message and has not created a ticket.';

const CONDENSED_DISCLOSURE =
  'This message was shortened because the full item list did not fit in a compose link. The complete order is at the link above.';

/** "SO-000049" when the number is real, else a visibly non-SO handle. */
function orderHandle(orderNumber: number | null, orderId: string): string {
  return formatOrderNumber(orderNumber) ?? orderId.replace(/-/g, '').slice(0, 8);
}

/** "CVW Clovis (CVW-CLO)" / "Mendota" — never "Mendota ()". */
function siteLabel(site: StorefrontCharter): string {
  const name = toPlainTextLine(site.name);
  const code = site.code ? toPlainTextLine(site.code) : '';
  return code ? `${name} (${code})` : name;
}

/**
 * The needed-by line, in the ORG's timezone with the zone named.
 *
 * The value arrives as a `datetime-local` string with no offset, exactly as the
 * cart holds it, and is interpreted in the viewer's zone by `new Date(...)` —
 * the same normalisation `handleConfirmSubmit` performs before submitting. The
 * zone name is printed because a California DC reading a bare time has no way
 * to know whose clock it is. Never `slice(0, 10)` an ISO string here: that
 * shifts the day for any local time after 16:00 PT.
 */
function neededByLine(neededByLocal: string, tz: string): string | null {
  const raw = neededByLocal.trim();
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  const formatted = formatOrgDateTime(
    d,
    { dateStyle: 'medium', timeStyle: 'short' },
    tz || ORG_TIMEZONE_DEFAULT,
  );
  if (formatted === '—') return null;
  return `${formatted} (${tz || ORG_TIMEZONE_DEFAULT})`;
}

/**
 * Build the delivery-request draft.
 *
 * Pure: no React, no DOM, no network, no clock beyond formatting the value it
 * was handed. It takes NO recipient argument — it reads DELIVERY_REQUEST_EMAIL
 * — so there is no parameter through which a URL parameter, a stored value, an
 * order note or a site name could redirect the mail.
 *
 * `condensed` exists for RISK R4: Outlook Web compose links and mailto: both
 * carry the body in the query string, practical limits land around 2,000
 * characters, and truncation is SILENT — the client opens with half a body and
 * the employee sends it. Condensed mode drops the per-line list and the street
 * address, keeps the counts, the site and the link, and SAYS SO in the body.
 */
export function buildDeliveryRequestDraft(
  input: DeliveryRequestInput,
  opts: { condensed?: boolean } = {},
): DeliveryRequestDraft {
  const condensed = opts.condensed === true;
  const isPickup = input.fulfillmentType === 'pickup';
  // fulfillment_type is the authority. A pickup order's charter is NULL by
  // CHECK constraint; ignoring a stray one keeps us from inventing a
  // destination the order does not have (owner decision D1).
  const site = isPickup ? null : input.destination;

  const { lineCount, unitCount } = cartTotals(input.lines);
  const handle = orderHandle(input.orderNumber, input.orderId);
  const warehouse = toPlainTextLine(input.warehouseName);
  const requester = toPlainTextLine(input.requestedFor);
  const requesterEmail = input.requesterEmail ? toPlainTextLine(input.requesterEmail) : '';
  const requesterLine = requesterEmail ? `${requester} (${requesterEmail})` : requester;

  const subjectLocation = site ? toPlainTextLine(site.name) : warehouse;
  const subject = toPlainTextLine(
    `Delivery Request — StockPilot Order ${handle} — ${subjectLocation}`,
  );

  const orderUrl = input.orderUrlBase
    ? `${input.orderUrlBase.replace(/\/+$/, '')}/dashboard/orders/${input.orderId}`
    : '';

  // Blocks are assembled as an array and joined with a blank line, so an
  // omitted block leaves no trace — no heading, no stray blank line, and never
  // three newlines in a row.
  const blocks: string[] = [];

  blocks.push(
    [
      'DELIVERY REQUEST — StockPilot',
      '',
      `Order: ${handle}`,
      `Requested by: ${requesterLine}`,
      `Fulfillment method: ${isPickup ? 'Pickup / will-call' : 'Delivery'}`,
      `Order status in StockPilot: ${DRAFT_STATUS_LABEL}`,
    ].join('\n'),
  );

  if (isPickup) {
    blocks.push(`PICKUP FROM\n${warehouse} will-call desk`);
    blocks.push(`COLLECTED BY\n${requesterLine}`);
  } else {
    blocks.push(`FROM (WAREHOUSE)\n${warehouse}`);
    if (site) {
      const addressLines = condensed ? [] : formatSiteAddressLines(site.address);
      blocks.push(['DELIVERY DESTINATION', siteLabel(site), ...addressLines].join('\n'));
    } else {
      // R8: 5 of 41 prod delivery orders have no charter because the CHECK is
      // NOT VALID. Say so plainly instead of printing an empty block.
      blocks.push(
        'DELIVERY DESTINATION\nNot recorded on this order. Please confirm the destination with the requester before delivering.',
      );
    }
  }

  const needed = neededByLine(input.neededByLocal, input.orgTimezone);
  if (needed) blocks.push(`NEEDED BY\n${needed}`);

  if (lineCount === 0) {
    blocks.push('No line items were recorded on this order.');
  } else {
    const heading = `ITEMS (${lineCount} ${lineCount === 1 ? 'line' : 'lines'}, ${unitCount} ${
      unitCount === 1 ? 'unit' : 'units'
    })`;
    if (condensed) {
      blocks.push(heading);
    } else {
      const rows = input.lines.map((line, i) => {
        const item = input.itemMap.get(line.itemId);
        const name = toPlainTextLine(item?.name ?? line.itemId);
        const sku = item?.sku ? toPlainTextLine(item.sku) : '';
        const label = sku ? `${name} — ${sku}` : name;
        return `${i + 1}. ${label} — qty ${line.quantity}`;
      });
      blocks.push([heading, ...rows].join('\n'));
    }
  }

  const notes = toPlainTextLine(input.notes);
  if (notes && !condensed) blocks.push(`ORDER NOTES\n${notes}`);

  if (orderUrl) blocks.push(`Order link: ${orderUrl}`);
  if (condensed) blocks.push(CONDENSED_DISCLOSURE);
  blocks.push(NON_CLAIM_FOOTER);

  return {
    to: DELIVERY_REQUEST_EMAIL.to,
    cc: DELIVERY_REQUEST_EMAIL.cc,
    subject,
    body: blocks.join('\n\n'),
    condensed,
    lineCount,
    unitCount,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `pnpm --filter @stockpilot/web test src/components/orders/storefront/storefront-logic.test.ts 2>&1 | tail -25`
Expected: PASS — every assertion in the new describe blocks plus everything from Tasks 1 and 3. If the `never prints cost, price or any staff-only figure` assertion fails on the word `Price`, the body has picked up a field it must not have; fix the body, never the assertion.

- [ ] **Step 5: Typecheck.**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Commit.**

```bash
git add apps/web/src/components/orders/storefront/storefront-logic.ts \
        apps/web/src/components/orders/storefront/storefront-logic.test.ts
git commit -m "feat(orders): pure delivery-request draft builder with pickup and delivery bodies"
```

---

## Task 5: The three transports — Outlook, mailto, clipboard

All three legs are greenfield: `grep -rniE "outlook\.office|outlook\.live|owa/\?path|deeplink=compose"` over `apps/web/src apps/mobile packages` returns zero hits, there is no shared `mailto:` builder (the only parameterised one, `admin/support-triage.tsx:188`, sets a subject and nothing else), and there is no clipboard helper, hook or `<CopyButton>` anywhere.

This task builds all three as pure functions plus the length-aware chooser, so the component in Task 6 does no string work at all.

**Files:**
- Modify: `apps/web/src/components/orders/storefront/storefront-logic.ts`
- Modify: `apps/web/src/components/orders/storefront/storefront-logic.test.ts`

**Interfaces:**
- Produces for Tasks 6, 7, 8: `OUTLOOK_COMPOSE_BASE`, `DRAFT_URL_LIMIT`, `buildOutlookComposeUrl(draft)`, `buildMailtoUrl(draft)`, `buildClipboardText(draft)`, `prepareDeliveryRequest(input): PreparedDeliveryRequest`, `PreparedDeliveryRequest`.
- Consumes from Task 4: `DeliveryRequestInput`, `DeliveryRequestDraft`, `buildDeliveryRequestDraft`.

**Steps:**

- [ ] **Step 1: Write the failing test.** Append to `apps/web/src/components/orders/storefront/storefront-logic.test.ts`, adding `buildClipboardText`, `buildMailtoUrl`, `buildOutlookComposeUrl`, `DRAFT_URL_LIMIT` and `prepareDeliveryRequest` to the import block:

```ts
describe('buildOutlookComposeUrl', () => {
  it('targets the OWA deep-link compose endpoint', () => {
    const url = new URL(buildOutlookComposeUrl(buildDeliveryRequestDraft(makeDraftInput())));
    expect(url.origin).toBe('https://outlook.office.com');
    expect(url.pathname).toBe('/mail/deeplink/compose');
  });

  it('carries to, cc, subject and body as REAL query parameters', () => {
    const draft = buildDeliveryRequestDraft(makeDraftInput());
    const url = new URL(buildOutlookComposeUrl(draft));
    expect(url.searchParams.get('to')).toBe('dc4@learn4life.org');
    expect(url.searchParams.get('cc')).toBe('arosas@cvwest.org');
    expect(url.searchParams.get('subject')).toBe(draft.subject);
    expect(url.searchParams.get('body')).toBe(draft.body);
  });

  it('carries the CC exactly ONCE', () => {
    const url = buildOutlookComposeUrl(buildDeliveryRequestDraft(makeDraftInput()));
    expect(url.match(/[?&]cc=/g)).toHaveLength(1);
    expect(new URL(url).searchParams.getAll('cc')).toEqual(['arosas@cvwest.org']);
  });

  it('never concatenates the CC into the to parameter', () => {
    const url = new URL(buildOutlookComposeUrl(buildDeliveryRequestDraft(makeDraftInput())));
    expect(url.searchParams.get('to')).not.toContain('arosas');
    expect(url.searchParams.get('to')).not.toContain(',');
  });

  it('encodes exactly once — a decoded body round-trips to the original', () => {
    const draft = buildDeliveryRequestDraft(
      makeDraftInput({ notes: 'Ampersand & plus + hash # question ? equals =' }),
    );
    const decoded = new URL(buildOutlookComposeUrl(draft)).searchParams.get('body');
    expect(decoded).toBe(draft.body);
    expect(decoded).toContain('Ampersand & plus + hash # question ? equals =');
    expect(decoded).not.toContain('%20');
    expect(decoded).not.toContain('%26');
  });

  it('keeps the CC when every optional field is missing', () => {
    const url = new URL(
      buildOutlookComposeUrl(
        buildDeliveryRequestDraft(
          makeDraftInput({
            orderNumber: null,
            destination: null,
            neededByLocal: '',
            notes: '',
            requesterEmail: null,
            orderUrlBase: '',
            lines: [],
            itemMap: new Map(),
          }),
        ),
      ),
    );
    expect(url.searchParams.get('to')).toBe('dc4@learn4life.org');
    expect(url.searchParams.get('cc')).toBe('arosas@cvwest.org');
  });

  it('keeps the CC in condensed mode', () => {
    const url = new URL(
      buildOutlookComposeUrl(buildDeliveryRequestDraft(makeDraftInput(), { condensed: true })),
    );
    expect(url.searchParams.get('cc')).toBe('arosas@cvwest.org');
  });
});

describe('buildMailtoUrl', () => {
  it('puts the To address in the PATH and the cc in the query string', () => {
    const url = buildMailtoUrl(buildDeliveryRequestDraft(makeDraftInput()));
    expect(url.startsWith('mailto:dc4@learn4life.org?')).toBe(true);
  });

  it('carries cc, subject and body, decodable back to the originals', () => {
    const draft = buildDeliveryRequestDraft(makeDraftInput());
    const url = buildMailtoUrl(draft);
    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    expect(params.get('cc')).toBe('arosas@cvwest.org');
    expect(params.get('subject')).toBe(draft.subject);
    expect(params.get('body')).toBe(draft.body);
  });

  it('carries the CC exactly once and never inside the To path segment', () => {
    const url = buildMailtoUrl(buildDeliveryRequestDraft(makeDraftInput()));
    expect(url.match(/[?&]cc=/g)).toHaveLength(1);
    expect(url.slice(0, url.indexOf('?'))).toBe('mailto:dc4@learn4life.org');
  });

  it('keeps the CC in condensed mode and with everything optional missing', () => {
    const bare = buildDeliveryRequestDraft(
      makeDraftInput({ destination: null, notes: '', neededByLocal: '', lines: [] }),
      { condensed: true },
    );
    const params = new URLSearchParams(buildMailtoUrl(bare).slice(buildMailtoUrl(bare).indexOf('?') + 1));
    expect(params.get('cc')).toBe('arosas@cvwest.org');
  });
});

describe('buildClipboardText', () => {
  it('emits labelled TO / CC / SUBJECT / MESSAGE blocks', () => {
    const draft = buildDeliveryRequestDraft(makeDraftInput());
    const text = buildClipboardText(draft);
    expect(text).toContain('TO: dc4@learn4life.org');
    expect(text).toContain('CC: arosas@cvwest.org');
    expect(text).toContain(`SUBJECT: ${draft.subject}`);
    expect(text).toContain('MESSAGE:');
    expect(text).toContain(draft.body);
  });

  it('orders the blocks TO, CC, SUBJECT, MESSAGE', () => {
    const text = buildClipboardText(buildDeliveryRequestDraft(makeDraftInput()));
    expect(text.indexOf('TO:')).toBeLessThan(text.indexOf('CC:'));
    expect(text.indexOf('CC:')).toBeLessThan(text.indexOf('SUBJECT:'));
    expect(text.indexOf('SUBJECT:')).toBeLessThan(text.indexOf('MESSAGE:'));
  });

  it('names BOTH recipients — copy instructions that omit the CC are non-compliant', () => {
    const text = buildClipboardText(buildDeliveryRequestDraft(makeDraftInput()));
    expect(text).toContain('dc4@learn4life.org');
    expect(text).toContain('arosas@cvwest.org');
  });

  it('keeps both recipients in condensed mode', () => {
    const text = buildClipboardText(buildDeliveryRequestDraft(makeDraftInput(), { condensed: true }));
    expect(text).toContain('TO: dc4@learn4life.org');
    expect(text).toContain('CC: arosas@cvwest.org');
  });
});

describe('prepareDeliveryRequest', () => {
  it('returns the full draft and both URLs for a normal order', () => {
    const prepared = prepareDeliveryRequest(makeDraftInput());
    expect(prepared.draft.condensed).toBe(false);
    expect(prepared.outlookUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
    expect(prepared.mailtoUrl.startsWith('mailto:dc4@learn4life.org?')).toBe(true);
    expect(prepared.clipboardText).toContain('CC: arosas@cvwest.org');
  });

  it('CONDENSES automatically when the full body would exceed the link limit', () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({ itemId: `big-${i}`, quantity: 4 }));
    const itemMap = new Map(
      lines.map((l, i) => [
        l.itemId,
        makeItem({ id: l.itemId, sku: `SKU-BIG-${i}`, name: `Bulk Item Number ${i}` }),
      ]),
    );
    const prepared = prepareDeliveryRequest(makeDraftInput({ lines, itemMap }));
    expect(prepared.draft.condensed).toBe(true);
    expect(prepared.outlookUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
    expect(prepared.draft.body).toContain(
      'This message was shortened because the full item list did not fit in a compose link.',
    );
  });

  it('the CLIPBOARD text is always the FULL body, even when the links are condensed', () => {
    // The clipboard has no URL-length limit, so degrading it too would lose
    // detail for no reason. This is the path that always carries everything.
    const lines = Array.from({ length: 100 }, (_, i) => ({ itemId: `big-${i}`, quantity: 4 }));
    const itemMap = new Map(
      lines.map((l, i) => [l.itemId, makeItem({ id: l.itemId, sku: `SKU-BIG-${i}`, name: `Bulk ${i}` })]),
    );
    const prepared = prepareDeliveryRequest(makeDraftInput({ lines, itemMap }));
    expect(prepared.draft.condensed).toBe(true);
    expect(prepared.clipboardText).toContain('SKU-BIG-99');
    expect(prepared.clipboardText).toContain('CC: arosas@cvwest.org');
  });

  it('keeps both recipients on a condensed 100-line order', () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({ itemId: `big-${i}`, quantity: 4 }));
    const itemMap = new Map(
      lines.map((l, i) => [l.itemId, makeItem({ id: l.itemId, sku: `SKU-BIG-${i}`, name: `Bulk ${i}` })]),
    );
    const prepared = prepareDeliveryRequest(makeDraftInput({ lines, itemMap }));
    const url = new URL(prepared.outlookUrl);
    expect(url.searchParams.get('to')).toBe('dc4@learn4life.org');
    expect(url.searchParams.get('cc')).toBe('arosas@cvwest.org');
  });

  it('no user-controlled field can move the recipients, at any size or mode', () => {
    const prepared = prepareDeliveryRequest(
      makeDraftInput({
        notes: '?cc=attacker@evil.test&to=attacker@evil.test',
        requestedFor: '"><script>x</script>attacker@evil.test',
        destination: { id: 'x', name: '&cc=attacker@evil.test', code: null, address: null },
      }),
    );
    const url = new URL(prepared.outlookUrl);
    expect(url.searchParams.getAll('to')).toEqual(['dc4@learn4life.org']);
    expect(url.searchParams.getAll('cc')).toEqual(['arosas@cvwest.org']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `pnpm --filter @stockpilot/web test src/components/orders/storefront/storefront-logic.test.ts 2>&1 | tail -20`
Expected: FAIL — `buildOutlookComposeUrl is not a function`. Record the real text.

- [ ] **Step 3: Implement the transports.** Append to `apps/web/src/components/orders/storefront/storefront-logic.ts`:

```ts
/**
 * Outlook Web compose deep link. Greenfield: the repo had no OWA link, no
 * shared mailto builder and no clipboard helper before this feature.
 *
 * The org runs managed Microsoft 365, so outlook.office.com is the work-account
 * host (outlook.live.com is the consumer one and would land a work user on the
 * wrong tenant).
 */
export const OUTLOOK_COMPOSE_BASE = 'https://outlook.office.com/mail/deeplink/compose';

/**
 * Conservative ceiling for a compose link, in characters.
 *
 * Outlook Web and mailto: both carry the body in the query string. Practical
 * limits land around 2,000 (IE/Edge historically ~2,048; Outlook desktop
 * truncates SILENTLY, which is the dangerous part — the client opens with half
 * a body and the employee sends it). 1,800 leaves headroom for the tenant's own
 * redirect wrapper, which appends to the URL.
 */
export const DRAFT_URL_LIMIT = 1800;

/**
 * Encoded EXACTLY ONCE. URLSearchParams performs the percent-encoding; nothing
 * is pre-encoded on the way in, and nothing is encoded again on the way out.
 * Double-encoding is the classic failure here — it produces a body full of
 * literal %20 that the recipient has to read through.
 */
export function buildOutlookComposeUrl(draft: DeliveryRequestDraft): string {
  const params = new URLSearchParams({
    to: draft.to,
    cc: draft.cc,
    subject: draft.subject,
    body: draft.body,
  });
  return `${OUTLOOK_COMPOSE_BASE}?${params.toString()}`;
}

/**
 * mailto: fallback for when the popup is blocked or OWA is not the user's
 * client. The To address is the PATH; cc, subject and body are query
 * parameters. Both recipients are still generated — a mailto that drops the CC
 * is non-compliant.
 */
export function buildMailtoUrl(draft: DeliveryRequestDraft): string {
  const params = new URLSearchParams({
    cc: draft.cc,
    subject: draft.subject,
    body: draft.body,
  });
  return `mailto:${draft.to}?${params.toString()}`;
}

/**
 * Terminal fallback. Safari treats a mailto: navigation with no registered
 * handler as a silent no-op, so the clipboard is the only genuinely reliable
 * path and it must be surfaced explicitly rather than hidden.
 *
 * Labelled blocks so the employee can build the message by hand, INCLUDING the
 * CC. Instructions that omit the CC are non-compliant.
 */
export function buildClipboardText(draft: DeliveryRequestDraft): string {
  return [
    `TO: ${draft.to}`,
    `CC: ${draft.cc}`,
    `SUBJECT: ${draft.subject}`,
    '',
    'MESSAGE:',
    draft.body,
  ].join('\n');
}

export interface PreparedDeliveryRequest {
  draft: DeliveryRequestDraft;
  outlookUrl: string;
  mailtoUrl: string;
  /** ALWAYS the full body — the clipboard has no URL-length limit. */
  clipboardText: string;
}

/**
 * Build everything the UI needs, choosing full or condensed by MEASURING the
 * encoded URL rather than guessing from the line count.
 *
 * Degrading deliberately is the whole point: silent truncation by the mail
 * client is invisible to us and to the employee, so we shorten the LINK, say so
 * in the body, and keep the complete detail on the clipboard path and behind
 * the order link.
 */
export function prepareDeliveryRequest(input: DeliveryRequestInput): PreparedDeliveryRequest {
  const full = buildDeliveryRequestDraft(input);
  const fullUrl = buildOutlookComposeUrl(full);
  const fullMailto = buildMailtoUrl(full);
  const fits = fullUrl.length <= DRAFT_URL_LIMIT && fullMailto.length <= DRAFT_URL_LIMIT;

  const draft = fits ? full : buildDeliveryRequestDraft(input, { condensed: true });

  return {
    draft,
    outlookUrl: fits ? fullUrl : buildOutlookComposeUrl(draft),
    mailtoUrl: fits ? fullMailto : buildMailtoUrl(draft),
    clipboardText: buildClipboardText(full),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `pnpm --filter @stockpilot/web test src/components/orders/storefront/storefront-logic.test.ts 2>&1 | tail -25`
Expected: PASS. Record the total assertion count — it is quoted in the Task 12 report under G.

- [ ] **Step 5: Prove there is no second recipient literal in the codebase.**

Run: `grep -rn "dc4@learn4life.org\|arosas@cvwest.org" apps/web/src apps/mobile packages --include=*.ts --include=*.tsx | grep -v "site.test.ts" | grep -v "storefront-logic.test.ts"`
Expected: exactly one line — the definition in `apps/web/src/lib/site.ts`. Any other production hit is a duplicated constant and must be removed.

- [ ] **Step 6: Commit.**

```bash
git add apps/web/src/components/orders/storefront/storefront-logic.ts \
        apps/web/src/components/orders/storefront/storefront-logic.test.ts
git commit -m "feat(orders): outlook, mailto and clipboard transports with a measured length guard"
```

---

# Phase 3 — The user interface

## Task 6: The action component and the open / mailto / clipboard chain

The button that lives in the success screen's `.acts` row, and the three-step fallback it drives. Nothing here builds a string — Task 5's `prepareDeliveryRequest` did that — so the click handler can open the window as its very first statement.

**RISK R3 governs this file.** `window.open` must be the FIRST statement in the handler, with no `await`, no `startTransition` and no state update before it. There is no popup-blocked pattern anywhere in the repo to copy: both production `window.open` call sites (`manager-actions-panel.tsx:457,461,465,473` and `barcode-display.tsx:236`) ignore the return value entirely. The `null` return is what drives the mailto step, and Safari's silent no-op on an unhandled `mailto:` is why the clipboard step is surfaced as a visible control rather than a hidden last resort.

**It composes `sf-*` CSS, not the shadcn kit.** The `.acts` row currently holds exactly two buttons — "View order" (`sf-btn-ghost`) and "Done" (`sf-btn-go`). Dropping `@/components/ui/button` markup beside them looks and behaves inconsistently (Audit §1).

**Files:**
- Create: `apps/web/src/components/orders/storefront/delivery-request-action.tsx`
- Create: `apps/web/src/components/orders/storefront/delivery-request-action.test.tsx`
- Modify: `apps/web/src/components/orders/storefront/storefront-overlays.tsx`
- Modify: `apps/web/src/components/orders/storefront/storefront.css`

**Interfaces:**
- Produces for Tasks 7, 8, 9: `DeliveryRequestAction` (default-exported React component) with props `{ input: DeliveryRequestInput }`.
- Consumes from Task 4: `DeliveryRequestInput`. From Task 5: `prepareDeliveryRequest`, `PreparedDeliveryRequest`. From Task 2: `DELIVERY_REQUEST_EMAIL`, `DELIVERY_REQUEST_CC_NOTICE`.
- Note: the audit event and the server action arrive in Task 10; this task leaves a single clearly-marked call site for them and nothing more.

**Steps:**

- [ ] **Step 1: Write the failing test.** Create `apps/web/src/components/orders/storefront/delivery-request-action.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeliveryRequestInput } from './storefront-logic';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

import DeliveryRequestAction from './delivery-request-action';

function makeInput(overrides: Partial<DeliveryRequestInput> = {}): DeliveryRequestInput {
  return {
    orderId: 'b3f1c2d4-1111-2222-3333-444455556666',
    orderNumber: 49,
    orderUrlBase: 'https://app.stockpilotusa.com',
    fulfillmentType: 'delivery',
    warehouseName: 'DC4',
    destination: {
      id: 'ch-1',
      name: 'CVW Clovis',
      code: 'CVW-CLO',
      address: {
        line1: '1295 Shaw Ave',
        city: 'Fresno',
        region: 'California',
        postalCode: '93612',
        country: 'United States',
      },
    },
    requestedFor: 'Branden Vincent-Walker',
    requesterEmail: 'branden@cvwest.org',
    neededByLocal: '2026-08-05T09:00',
    orgTimezone: 'America/Los_Angeles',
    notes: 'Please stage these by Friday.',
    lines: [{ itemId: 'i-1', quantity: 5 }],
    itemMap: new Map([
      [
        'i-1',
        {
          id: 'i-1',
          sku: 'APP-POLO-W',
          name: "L4L Polo (Women's)",
          warehouseId: 'wh-1',
          quantityOnHand: 10,
          reservedQuantity: 0,
          itemType: null,
          categoryId: null,
          categoryName: null,
          charterId: null,
          charterName: null,
          charterCode: null,
          rackLabel: null,
          imageUrl: null,
          lqip: null,
          price: null,
          reorderPoint: 0,
        },
      ],
    ]),
    ...overrides,
  };
}

/** A window.open spy that behaves like a successful open. */
function stubOpen(returns: unknown = { focus: vi.fn() }) {
  const open = vi.fn(() => returns);
  vi.stubGlobal('open', open);
  return open;
}

/** The house clipboard idiom — copied per test file, not shared (mfa-recovery-codes.test.tsx:60-88). */
function stubClipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  });
  return writeText;
}

/**
 * `window.location` is not writable in happy-dom and `vi.stubGlobal('location', ...)`
 * does not reliably replace it, so the same defineProperty idiom is used here.
 */
function stubLocationAssign(assign = vi.fn()) {
  Object.defineProperty(window, 'location', {
    value: { ...window.location, assign },
    configurable: true,
    writable: true,
  });
  return assign;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('DeliveryRequestAction — the primary Outlook path', () => {
  it('renders a button that says what it does without claiming a ticket', () => {
    render(<DeliveryRequestAction input={makeInput()} />);
    const btn = screen.getByRole('button', { name: /Email delivery request/i });
    expect(btn).toBeInTheDocument();
    expect(btn.textContent?.toLowerCase()).not.toContain('ticket');
    expect(btn.textContent?.toLowerCase()).not.toContain('send');
  });

  it('opens the Outlook compose URL with BOTH recipients on click', async () => {
    const user = userEvent.setup();
    const open = stubOpen();

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));

    expect(open).toHaveBeenCalledTimes(1);
    const url = new URL(open.mock.calls[0]![0] as string);
    expect(url.origin + url.pathname).toBe('https://outlook.office.com/mail/deeplink/compose');
    expect(url.searchParams.get('to')).toBe('dc4@learn4life.org');
    expect(url.searchParams.get('cc')).toBe('arosas@cvwest.org');
    expect(url.searchParams.get('subject')).toContain('SO-000049');
    expect(url.searchParams.get('body')).toContain('CVW Clovis');
  });

  it('opens in a new tab with noopener', async () => {
    const user = userEvent.setup();
    const open = stubOpen();

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));

    expect(open.mock.calls[0]![1]).toBe('_blank');
    expect(String(open.mock.calls[0]![2])).toContain('noopener');
  });

  it('confirms a DRAFT was opened, never that anything was sent', async () => {
    const user = userEvent.setup();
    stubOpen();

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    const msg = String(toastSuccess.mock.calls[0]![0]).toLowerCase();
    expect(msg).toContain('draft');
    expect(msg).not.toContain('sent');
    expect(msg).not.toContain('ticket');
  });
});

describe('DeliveryRequestAction — popup blocked', () => {
  it('falls back to mailto when window.open returns null', async () => {
    const user = userEvent.setup();
    const open = vi.fn(() => null);
    vi.stubGlobal('open', open);
    const assign = stubLocationAssign();

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));

    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    const mailto = String(assign.mock.calls[0]![0]);
    expect(mailto.startsWith('mailto:dc4@learn4life.org?')).toBe(true);
    const params = new URLSearchParams(mailto.slice(mailto.indexOf('?') + 1));
    expect(params.get('cc')).toBe('arosas@cvwest.org');
  });

  it('surfaces the copy fallback and NAMES BOTH recipients in the instructions', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('open', vi.fn(() => null));
    stubLocationAssign();

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));

    const fallback = await screen.findByTestId('delivery-request-fallback');
    expect(fallback).toHaveTextContent('dc4@learn4life.org');
    expect(fallback).toHaveTextContent('arosas@cvwest.org');
    expect(screen.getByRole('button', { name: /Copy the details/i })).toBeInTheDocument();
  });

  it('also falls back when window.open throws', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('open', vi.fn(() => {
      throw new Error('blocked');
    }));
    const assign = stubLocationAssign();

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));

    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(String(assign.mock.calls[0]![0]).startsWith('mailto:')).toBe(true);
  });
});

describe('DeliveryRequestAction — clipboard fallback', () => {
  it('copies TO, CC, SUBJECT and MESSAGE blocks', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('open', vi.fn(() => null));
    stubLocationAssign();
    const writeText = stubClipboard();

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));
    await user.click(await screen.findByRole('button', { name: /Copy the details/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = String(writeText.mock.calls[0]![0]);
    expect(copied).toContain('TO: dc4@learn4life.org');
    expect(copied).toContain('CC: arosas@cvwest.org');
    expect(copied).toContain('SUBJECT: Delivery Request — StockPilot Order SO-000049');
    expect(copied).toContain('MESSAGE:');
  });

  it('post-copy instructions name BOTH recipients', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('open', vi.fn(() => null));
    stubLocationAssign();
    stubClipboard();

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));
    await user.click(await screen.findByRole('button', { name: /Copy the details/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const msg = String(toastSuccess.mock.calls.at(-1)![0]);
    expect(msg).toBe(
      'Delivery request copied. Create a new email to dc4@learn4life.org, CC arosas@cvwest.org, and paste the copied details.',
    );
  });

  it('shows a SELECTABLE textarea carrying both recipients when the clipboard is denied', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('open', vi.fn(() => null));
    stubLocationAssign();
    stubClipboard(vi.fn().mockRejectedValue(new Error('denied')));

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));
    await user.click(await screen.findByRole('button', { name: /Copy the details/i }));

    const box = await screen.findByLabelText(/Delivery request text to copy manually/i);
    expect((box as HTMLTextAreaElement).value).toContain('TO: dc4@learn4life.org');
    expect((box as HTMLTextAreaElement).value).toContain('CC: arosas@cvwest.org');
    expect(toastError).toHaveBeenCalled();
  });

  it('handles a browser with no navigator.clipboard at all', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('open', vi.fn(() => null));
    stubLocationAssign();
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
      writable: true,
    });

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));
    await user.click(await screen.findByRole('button', { name: /Copy the details/i }));

    expect(await screen.findByLabelText(/Delivery request text to copy manually/i)).toBeInTheDocument();
  });
});

describe('DeliveryRequestAction — pickup orders (owner decision D1)', () => {
  it('renders for pickup orders too', () => {
    render(<DeliveryRequestAction input={makeInput({ fulfillmentType: 'pickup', destination: null })} />);
    expect(screen.getByRole('button', { name: /Email delivery request/i })).toBeInTheDocument();
  });

  it('opens a body with the pickup handoff and NO destination block', async () => {
    const user = userEvent.setup();
    const open = stubOpen();

    render(<DeliveryRequestAction input={makeInput({ fulfillmentType: 'pickup', destination: null })} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));

    const body = new URL(open.mock.calls[0]![0] as string).searchParams.get('body') ?? '';
    expect(body).toContain('Pickup / will-call');
    expect(body).toContain('PICKUP FROM');
    expect(body).toContain('COLLECTED BY');
    expect(body).not.toContain('DELIVERY DESTINATION');
  });
});

describe('DeliveryRequestAction — no duplicate order, ever', () => {
  it('never calls a create action — the order is already persisted', async () => {
    const user = userEvent.setup();
    stubOpen();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    render(<DeliveryRequestAction input={makeInput()} />);
    const btn = screen.getByRole('button', { name: /Email delivery request/i });
    await user.click(btn);
    await user.click(btn);
    await user.click(btn);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `pnpm --filter @stockpilot/web test src/components/orders/storefront/delivery-request-action.test.tsx 2>&1 | tail -20`
Expected: FAIL — `Failed to resolve import "./delivery-request-action"`. Record the real text.

- [ ] **Step 3: Create the component.** Create `apps/web/src/components/orders/storefront/delivery-request-action.tsx`:

```tsx
'use client';

import { Copy, Mail } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { DELIVERY_REQUEST_EMAIL } from '@/lib/site';

import { prepareDeliveryRequest, type DeliveryRequestInput } from './storefront-logic';

/**
 * The delivery-request assistant's entry point, rendered in the success
 * screen's `.acts` row.
 *
 * What it does: composes a plain-text delivery-request message and OPENS it in
 * the employee's mail client, prefilled. What it never does: send anything,
 * create anything, or claim that a ticket exists. The employee keeps final
 * review-and-send control inside Outlook.
 *
 * The fallback chain, in order, and why each step exists:
 *
 *   1. window.open(OWA compose) — the primary path. It is the FIRST statement
 *      in the click handler: an await, a setState or an analytics call before
 *      it makes the open asynchronous relative to the gesture and Chrome and
 *      Safari return null. There is no prior popup-blocked pattern in this
 *      repo to copy; both existing window.open call sites ignore the return.
 *   2. location.assign(mailto:) — when the open returns null or throws.
 *   3. Clipboard, offered as a VISIBLE control — because Safari treats a
 *      mailto: navigation with no registered handler as a silent no-op, so
 *      step 2 can fail with no signal at all. Hiding this behind another
 *      failure detection we cannot perform would strand the employee.
 *   4. A selectable textarea — when the clipboard API is absent or denied.
 *
 * Recipients are never props and never state. They come from
 * DELIVERY_REQUEST_EMAIL via the pure builder, so nothing a user typed can
 * redirect them.
 */
export default function DeliveryRequestAction({ input }: { input: DeliveryRequestInput }) {
  // Prepared once per render of the success screen. Doing this in a memo rather
  // than inside the handler keeps the handler's first statement the open call.
  const prepared = React.useMemo(() => prepareDeliveryRequest(input), [input]);

  const [showFallback, setShowFallback] = React.useState(false);
  const [manualText, setManualText] = React.useState<string | null>(null);

  function handleOpen() {
    // R3: nothing may precede this line.
    let opened: Window | null = null;
    try {
      opened = window.open(prepared.outlookUrl, '_blank', 'noopener,noreferrer');
    } catch {
      opened = null;
    }

    if (opened) {
      toast.success('Delivery request draft opened in Outlook. Review it and press Send yourself.');
      return;
    }

    // Popup blocked. Same-tab mailto: is the next best thing; it may still be
    // a silent no-op on Safari, so the copy path is surfaced regardless.
    setShowFallback(true);
    try {
      window.location.assign(prepared.mailtoUrl);
    } catch {
      // Ignored on purpose: the visible fallback below is the recovery.
    }
  }

  async function handleCopy() {
    const text = prepared.clipboardText;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setManualText(null);
      toast.success(
        `Delivery request copied. Create a new email to ${DELIVERY_REQUEST_EMAIL.to}, CC ${DELIVERY_REQUEST_EMAIL.cc}, and paste the copied details.`,
      );
    } catch {
      // The selectable box is the terminal fallback: it always shows both
      // recipients, so the employee can always complete the task by hand.
      setManualText(text);
      toast.error('Could not copy automatically. Select the text below and copy it manually.');
    }
  }

  return (
    <>
      <button type="button" className="sf-btn-ghost" onClick={handleOpen}>
        <Mail size={14} aria-hidden="true" />
        Email delivery request
      </button>

      {showFallback && (
        <div className="sf-fallback" data-testid="delivery-request-fallback">
          <p>
            Outlook did not open — your browser may have blocked the popup. Copy the details and
            create the email yourself: To {DELIVERY_REQUEST_EMAIL.to}, CC{' '}
            {DELIVERY_REQUEST_EMAIL.cc}.
          </p>
          <button type="button" className="sf-btn-ghost" onClick={handleCopy}>
            <Copy size={14} aria-hidden="true" />
            Copy the details
          </button>
          {manualText !== null && (
            <textarea
              className="sf-fallback-text"
              readOnly
              rows={8}
              value={manualText}
              aria-label="Delivery request text to copy manually"
              onFocus={(e) => e.currentTarget.select()}
            />
          )}
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 4: Render it in the success screen.** In `apps/web/src/components/orders/storefront/storefront-overlays.tsx`, import the component and insert it as the FIRST child of the `.acts` row (before "View order"), passing the input assembled from the props Task 3 added:

```tsx
import DeliveryRequestAction from './delivery-request-action';
```

```tsx
            <div className="acts">
              {submitted && (
                <DeliveryRequestAction
                  input={{
                    orderId: submitted.id,
                    orderNumber: submitted.orderNumber,
                    orderUrlBase,
                    fulfillmentType: summary.method,
                    warehouseName: summary.warehouseName,
                    destination,
                    requestedFor: summary.requestedFor,
                    requesterEmail: summary.requesterEmail,
                    neededByLocal: neededBy,
                    orgTimezone: summary.orgTimezone,
                    notes,
                    lines,
                    itemMap,
                  }}
                />
              )}
              <button type="button" className="sf-btn-ghost" onClick={onViewOrder}>
                View order
              </button>
              <button type="button" className="sf-btn-go" onClick={onDone}>
                Done
              </button>
            </div>
```

- [ ] **Step 5: Widen `ReviewSummary` for the two values the email needs.** In the same file, add to `ReviewSummary` (lines 185-191):

```ts
  /** The requester's email — the one contact DC4 can reliably reach. */
  requesterEmail: string | null;
  /** `organizations.timezone`; the draft renders needed-by in it. */
  orgTimezone: string;
```

and supply both at the `<ReviewModal summary={{ ... }} />` call site in `orders-storefront.tsx`:

```tsx
          requesterEmail: state.onBehalfOf?.email ?? viewerEmail,
          orgTimezone,
```

threading `orgTimezone: string` as a new prop on `OrdersStorefront` and its inner shell, supplied by `new/page.tsx` from the cached org timezone (`getCachedOrgTimezone`, `lib/dashboard/cached-org.ts`). If the page cannot supply it, pass `ORG_TIMEZONE_DEFAULT` from `@/lib/timezone` — never an empty string, which would print an empty parenthesis after the date.

- [ ] **Step 6: Add the fallback styles.** Append to `apps/web/src/components/orders/storefront/storefront.css`:

```css
/* Delivery-request assistant: the popup-blocked fallback panel. Lives inside
   the success screen's .acts row, so it spans the full width beneath the
   buttons rather than sitting in the flex line with them. */
.sp-storefront .sf-fallback {
  flex-basis: 100%;
  margin-top: 10px;
  padding: 10px 12px;
  border: 1px solid var(--sf-line, rgba(0, 0, 0, 0.12));
  border-radius: 8px;
  text-align: left;
  font-size: 13px;
  line-height: 1.5;
}

.sp-storefront .sf-fallback p {
  margin: 0 0 8px;
}

.sp-storefront .sf-fallback-text {
  width: 100%;
  margin-top: 8px;
  padding: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.45;
  border: 1px solid var(--sf-line, rgba(0, 0, 0, 0.12));
  border-radius: 6px;
  resize: vertical;
}
```

- [ ] **Step 7: Run the tests to verify they pass.**

Run: `pnpm --filter @stockpilot/web test src/components/orders/storefront/delivery-request-action.test.tsx 2>&1 | tail -25`
Expected: PASS — 15 assertions across 6 describe blocks.

- [ ] **Step 8: Typecheck and lint.**

Run: `pnpm typecheck && pnpm lint 2>&1 | tail -20`
Expected: both clean.

- [ ] **Step 9: Commit.**

```bash
git add apps/web/src/components/orders/storefront/delivery-request-action.tsx \
        apps/web/src/components/orders/storefront/delivery-request-action.test.tsx \
        apps/web/src/components/orders/storefront/storefront-overlays.tsx \
        apps/web/src/components/orders/storefront/storefront.css \
        apps/web/src/components/orders/storefront/orders-storefront.tsx \
        "apps/web/src/app/(dashboard)/dashboard/orders/new/page.tsx"
git commit -m "feat(orders): delivery-request action with outlook, mailto and clipboard fallbacks"
```

---

## Task 7: The preview dialog, with both recipients visible and non-editable

Addendum requirement 3: before opening anything, the employee can see exactly what will be composed, with both recipients displayed under an "EMAIL RECIPIENTS" heading and the helper text. The CC must not be hidden, and the fields must not look editable.

**Primitive decision, stated explicitly because the audit asks for it.** The preview is built on the Radix `Dialog` from `@/components/ui/dialog`, NOT on another hand-rolled `sf-modal`. Brief section 26 demands a focus trap and focus restore; `sf-modal` has `role="dialog" aria-modal="true"` and a hand-written `document` keydown listener but NEITHER (`storefront-overlays.tsx:222-248`). Radix supplies both, correctly, for free. The buttons INSIDE the dialog still use `sf-btn-ghost` / `sf-btn-go` so it reads as part of the storefront. Task 9 separately fixes `sf-modal`'s own trap, because adding controls to a non-trapping modal makes the pre-existing gap worse — the two are complementary, not alternatives.

**No Escape conflict.** The review modal's Escape listener is guarded by `closable = stage === 'review' && !submitting`, so at `stage === 'success'` it is inert. Radix's own Escape handling closes only the preview.

**Files:**
- Modify: `apps/web/src/components/orders/storefront/delivery-request-action.tsx`
- Modify: `apps/web/src/components/orders/storefront/delivery-request-action.test.tsx`
- Modify: `apps/web/src/components/orders/storefront/storefront.css`

**Interfaces:**
- Produces for Tasks 8, 9: the preview dialog, opened by a "Preview" control beside the primary button.
- Consumes from Task 2: `DELIVERY_REQUEST_EMAIL`, `DELIVERY_REQUEST_CC_NOTICE`. From Task 5: `prepared.draft`.

**Steps:**

- [ ] **Step 1: Write the failing test.** Append to `apps/web/src/components/orders/storefront/delivery-request-action.test.tsx`:

```tsx
describe('DeliveryRequestAction — preview dialog', () => {
  it('opens from a Preview control and shows the subject and body', async () => {
    const user = userEvent.setup();
    render(<DeliveryRequestAction input={makeInput()} />);

    await user.click(screen.getByRole('button', { name: /Preview/i }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Delivery Request — StockPilot Order SO-000049');
    expect(dialog).toHaveTextContent('CVW Clovis');
    expect(dialog).toHaveTextContent('1295 Shaw Ave');
  });

  it('shows BOTH recipients under an EMAIL RECIPIENTS heading', async () => {
    const user = userEvent.setup();
    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Preview/i }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('EMAIL RECIPIENTS');
    expect(dialog).toHaveTextContent('dc4@learn4life.org');
    expect(dialog).toHaveTextContent('arosas@cvwest.org');
  });

  it('carries the exact CC helper text and never claims assignment', async () => {
    const user = userEvent.setup();
    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Preview/i }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(
      'The DC4 address creates the delivery-request ticket. A copy will also be sent to arosas@cvwest.org.',
    );
    expect(dialog.textContent?.toLowerCase()).not.toContain('assigned to');
  });

  it('renders the recipients as TEXT — no input, no editable field, no way to change them', async () => {
    const user = userEvent.setup();
    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Preview/i }));

    const dialog = await screen.findByRole('dialog');
    // The only form control in the dialog is the read-only body preview.
    const editable = Array.from(dialog.querySelectorAll('input, select, [contenteditable="true"]'));
    expect(editable).toHaveLength(0);
    for (const ta of Array.from(dialog.querySelectorAll('textarea'))) {
      expect(ta).toHaveAttribute('readonly');
    }
  });

  it('opens Outlook from inside the dialog, with both recipients intact', async () => {
    const user = userEvent.setup();
    const open = stubOpen();

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Preview/i }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: /Open in Outlook/i }));

    const url = new URL(open.mock.calls[0]![0] as string);
    expect(url.searchParams.get('to')).toBe('dc4@learn4life.org');
    expect(url.searchParams.get('cc')).toBe('arosas@cvwest.org');
  });

  it('offers copy from inside the dialog, copying both recipients', async () => {
    const user = userEvent.setup();
    const writeText = stubClipboard();

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Preview/i }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: /Copy the details/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(String(writeText.mock.calls[0]![0])).toContain('CC: arosas@cvwest.org');
  });

  it('shows the pickup body for a pickup order, with no destination', async () => {
    const user = userEvent.setup();
    render(<DeliveryRequestAction input={makeInput({ fulfillmentType: 'pickup', destination: null })} />);
    await user.click(screen.getByRole('button', { name: /Preview/i }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('PICKUP FROM');
    expect(dialog).not.toHaveTextContent('DELIVERY DESTINATION');
  });

  it('discloses condensation in the preview when the order is large', async () => {
    const user = userEvent.setup();
    const lines = Array.from({ length: 100 }, (_, i) => ({ itemId: `b-${i}`, quantity: 4 }));
    const itemMap = new Map(
      lines.map((l, i) => [
        l.itemId,
        { ...makeInput().itemMap.get('i-1')!, id: l.itemId, sku: `SKU-${i}`, name: `Bulk Item ${i}` },
      ]),
    );

    render(<DeliveryRequestAction input={makeInput({ lines, itemMap })} />);
    await user.click(screen.getByRole('button', { name: /Preview/i }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('This message was shortened');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `pnpm --filter @stockpilot/web test src/components/orders/storefront/delivery-request-action.test.tsx 2>&1 | tail -20`
Expected: FAIL — `Unable to find an accessible element with the role "button" and name /Preview/i`. Record the real text.

- [ ] **Step 3: Add the preview.** In `apps/web/src/components/orders/storefront/delivery-request-action.tsx`, add these imports:

```tsx
import { Eye } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DELIVERY_REQUEST_CC_NOTICE, DELIVERY_REQUEST_EMAIL } from '@/lib/site';
```

add `const [previewOpen, setPreviewOpen] = React.useState(false);` beside the other state, add the Preview trigger immediately after the primary button, and render the dialog at the end of the fragment:

```tsx
      <button type="button" className="sf-btn-ghost" onClick={() => setPreviewOpen(true)}>
        <Eye size={14} aria-hidden="true" />
        Preview
      </button>
```

```tsx
      {/*
        Built on the Radix Dialog rather than a second hand-rolled sf-modal:
        brief section 26 requires a focus trap and focus restore, and the
        storefront's own sf-modal has neither. Radix supplies both correctly.
        The BUTTONS inside still use sf-* classes so it reads as part of the
        storefront. The review modal's Escape listener is inert at the success
        stage (its `closable` guard requires stage === 'review'), so there is no
        conflict between the two Escape handlers.
      */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Delivery request preview</DialogTitle>
            <DialogDescription>
              StockPilot will open this as a draft in your mail client. Nothing is sent until you
              press Send yourself, and no ticket exists yet.
            </DialogDescription>
          </DialogHeader>

          <div className="sf-recip">
            <div className="sf-recip-h">EMAIL RECIPIENTS</div>
            <dl>
              <div>
                <dt>To</dt>
                <dd>{DELIVERY_REQUEST_EMAIL.to}</dd>
              </div>
              <div>
                <dt>CC</dt>
                <dd>{DELIVERY_REQUEST_EMAIL.cc}</dd>
              </div>
            </dl>
            <p className="sf-recip-note">{DELIVERY_REQUEST_CC_NOTICE}</p>
          </div>

          <div className="sf-recip">
            <div className="sf-recip-h">SUBJECT</div>
            <p>{prepared.draft.subject}</p>
          </div>

          <textarea
            className="sf-fallback-text"
            readOnly
            rows={14}
            value={prepared.draft.body}
            aria-label="Delivery request message preview"
          />

          <div className="sf-modal-foot">
            <button type="button" className="sf-btn-ghost" onClick={handleCopy}>
              <Copy size={14} aria-hidden="true" />
              Copy the details
            </button>
            <button
              type="button"
              className="sf-btn-go"
              onClick={() => {
                // R3 still applies inside the dialog: the open is the first
                // statement, and the dialog is closed afterwards.
                handleOpen();
                setPreviewOpen(false);
              }}
            >
              <Mail size={14} aria-hidden="true" />
              Open in Outlook
            </button>
          </div>
        </DialogContent>
      </Dialog>
```

- [ ] **Step 4: Style the recipient block.** Append to `apps/web/src/components/orders/storefront/storefront.css`:

```css
/* Delivery-request preview: the recipient block. Rendered as a definition
   list, never as inputs — employees must not be able to edit either address,
   and a field that LOOKS editable invites the attempt. */
.sf-recip {
  margin-top: 12px;
}

.sf-recip-h {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  opacity: 0.7;
  margin-bottom: 6px;
}

.sf-recip dl {
  display: grid;
  grid-template-columns: 48px 1fr;
  gap: 4px 10px;
  margin: 0;
  font-size: 13px;
}

.sf-recip dl > div {
  display: contents;
}

.sf-recip dt {
  font-weight: 600;
  opacity: 0.75;
}

.sf-recip dd {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.sf-recip-note {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.5;
  opacity: 0.8;
}
```

Note: these rules are NOT scoped under `.sp-storefront` because the Radix dialog portals to `document.body`, outside the storefront wrapper. The `sf-fallback-text` and `sf-btn-*` rules used inside the dialog ARE scoped that way and will not apply there — add unscoped duplicates for the three classes the dialog uses (`sf-fallback-text`, `sf-btn-ghost`, `sf-btn-go`, `sf-modal-foot`) or give the `DialogContent` the `sp-storefront` class so the existing scoped rules apply. **Take the second option** — one `className="sp-storefront max-w-2xl"` on `DialogContent` — and verify visually in Step 6; it is one attribute instead of four duplicated rule blocks.

- [ ] **Step 5: Run the tests to verify they pass.**

Run: `pnpm --filter @stockpilot/web test src/components/orders/storefront/delivery-request-action.test.tsx 2>&1 | tail -25`
Expected: PASS — the 8 new assertions plus Task 6's 15.

- [ ] **Step 6: Verify the styling by eye.** Start the dev server, place a test order in Demo Co (`71b27a4a-7948-4638-bc3f-535974713bd2`, sign in as `demo@stockpilotusa.com` at `/signin`), open the preview, and confirm the dialog's buttons match the storefront's and the recipient block is legible in both light and dark. Record what you saw.

- [ ] **Step 7: Commit.**

```bash
git add apps/web/src/components/orders/storefront/delivery-request-action.tsx \
        apps/web/src/components/orders/storefront/delivery-request-action.test.tsx \
        apps/web/src/components/orders/storefront/storefront.css
git commit -m "feat(orders): delivery-request preview dialog with visible, non-editable recipients"
```

---

## Task 8: The honesty affordances — "this does not create a ticket"

The brief's hardest non-functional requirement and the one most easily lost: the UI must NEVER claim a ticket was submitted. This task makes that a property of the screen rather than a hope, and adds the two disclosures the acceptance criteria demand — repeated-click duplicate warning, and clear disclosure when a large order was shortened.

**Three specific honesty problems to fix, not invent:**

1. **There is no `Alert` component.** `apps/web/src/components/ui/alert.tsx` does not exist and there are zero imports of `@/components/ui/alert`. The notice reuses the repo's hand-rolled inline banner pattern (28 occurrences of `bg-destructive/10` / `border-destructive/40` on plain divs, e.g. `dashboard/orders/[id]/page.tsx:855-861`) — but rendered with an `sf-note` class inside the storefront so it does not import Tailwind semantics into hand-rolled CSS. Introducing the first `Alert` is out of scope for this feature.
2. **The existing success paragraph makes a claim of its own.** `storefront-overlays.tsx:353-357` says "Your manager has been notified. You'll get an email when it's approved and stock is reserved for delivery." Verify that claim is still true against the notification path before shipping copy beside it; if it is true, leave it, and make sure the new notice does not contradict it. A fresh internal order is inserted at `'pending_approval'` — not approved, not reserved, not scheduled.
3. **Repeated clicks.** Nothing prevents an employee pressing the button three times and sending DC4 three near-identical emails. We cannot detect a send, so we warn rather than block: the second and later opens are still allowed (the first draft may have been closed by accident) but the UI says a draft was already opened for this order.

**Files:**
- Modify: `apps/web/src/components/orders/storefront/delivery-request-action.tsx`
- Modify: `apps/web/src/components/orders/storefront/delivery-request-action.test.tsx`
- Create: `apps/web/src/components/orders/storefront/storefront-overlays.test.tsx`
- Modify: `apps/web/src/components/orders/storefront/storefront.css`

**Interfaces:**
- Produces for Tasks 9, 10: `draftCount` state (the number of times a draft was opened for this order) — Task 10's audit call reads nothing from it, but the analytics call records whether it was a repeat.
- Consumes from Tasks 6, 7: the action component and its preview.

**Steps:**

- [ ] **Step 1: Write the failing test.** Append to `apps/web/src/components/orders/storefront/delivery-request-action.test.tsx`:

```tsx
describe('DeliveryRequestAction — honesty', () => {
  it('states plainly that this does not create a ticket, before any click', () => {
    render(<DeliveryRequestAction input={makeInput()} />);
    const notice = screen.getByTestId('delivery-request-notice');
    expect(notice).toHaveTextContent(
      'This opens a draft email. StockPilot does not send it and does not create a ticket. Review the message and press Send in your mail app.',
    );
  });

  it('never uses ticket-created language anywhere in the rendered surface', () => {
    const { container } = render(<DeliveryRequestAction input={makeInput()} />);
    const text = (container.textContent ?? '').toLowerCase();
    for (const claim of [
      'ticket created',
      'ticket submitted',
      'ticket has been',
      'request submitted to dc4',
      'assigned to',
      'we have sent',
      'email sent',
    ]) {
      expect(text).not.toContain(claim);
    }
  });

  it('warns on a REPEATED draft without blocking it', async () => {
    const user = userEvent.setup();
    stubOpen();

    render(<DeliveryRequestAction input={makeInput()} />);
    const btn = screen.getByRole('button', { name: /Email delivery request/i });

    await user.click(btn);
    expect(screen.queryByTestId('delivery-request-repeat')).toBeNull();

    await user.click(btn);
    const repeat = await screen.findByTestId('delivery-request-repeat');
    expect(repeat).toHaveTextContent(
      'You have already opened a draft for this order. Sending more than one creates duplicate requests for DC4.',
    );
    // Still allowed — the first draft may have been closed by accident.
    expect(btn).toBeEnabled();
  });

  it('counts every draft, including ones opened from the preview dialog', async () => {
    const user = userEvent.setup();
    stubOpen();

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));
    await user.click(screen.getByRole('button', { name: /Preview/i }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: /Open in Outlook/i }));

    expect(await screen.findByTestId('delivery-request-repeat')).toBeInTheDocument();
  });

  it('DISCLOSES truncation on the surface when the order was too large for a link', () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({ itemId: `b-${i}`, quantity: 4 }));
    const base = makeInput().itemMap.get('i-1')!;
    const itemMap = new Map(
      lines.map((l, i) => [l.itemId, { ...base, id: l.itemId, sku: `SKU-${i}`, name: `Bulk Item ${i}` }]),
    );

    render(<DeliveryRequestAction input={makeInput({ lines, itemMap })} />);
    expect(screen.getByTestId('delivery-request-condensed')).toHaveTextContent(
      'This order is too large to fit in a compose link, so the draft carries a summary and a link to the full order. Copy the details instead to include every line.',
    );
  });

  it('shows no truncation disclosure for a normal order', () => {
    render(<DeliveryRequestAction input={makeInput()} />);
    expect(screen.queryByTestId('delivery-request-condensed')).toBeNull();
  });

  it('the repeat warning survives a re-render and does not reset the count', async () => {
    const user = userEvent.setup();
    stubOpen();

    const { rerender } = render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));
    rerender(<DeliveryRequestAction input={makeInput()} />);

    expect(await screen.findByTestId('delivery-request-repeat')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Write the success-screen test file.** Create `apps/web/src/components/orders/storefront/storefront-overlays.test.tsx` — it does not exist today:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CatalogItem } from '../v2/types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// SfPhoto / CharterTag pull next/image and the catalog card styling, neither of
// which this file is about.
vi.mock('./storefront-cards', () => ({
  SfPhoto: () => <div data-testid="sf-photo" />,
  CharterTag: () => <div data-testid="sf-charter-tag" />,
  SfAddControl: () => <div data-testid="sf-add-control" />,
}));

import { ReviewModal } from './storefront-overlays';

const ITEM: CatalogItem = {
  id: 'i-1',
  sku: 'APP-POLO-W',
  name: "L4L Polo (Women's)",
  warehouseId: 'wh-1',
  quantityOnHand: 10,
  reservedQuantity: 0,
  itemType: null,
  categoryId: null,
  categoryName: null,
  charterId: null,
  charterName: null,
  charterCode: null,
  rackLabel: null,
  imageUrl: null,
  lqip: null,
  price: null,
  reorderPoint: 0,
};

function renderSuccess(overrides: Record<string, unknown> = {}) {
  const props = {
    stage: 'success' as const,
    lines: [{ itemId: 'i-1', quantity: 5 }],
    itemMap: new Map([['i-1', ITEM]]),
    notes: 'Please stage these by Friday.',
    summary: {
      warehouseName: 'DC4',
      method: 'delivery' as const,
      deliverTo: 'CVW Clovis',
      requestedFor: 'Branden Vincent-Walker',
      requesterEmail: 'branden@cvwest.org',
      orgTimezone: 'America/Los_Angeles',
    },
    neededBy: '2026-08-05T09:00',
    destination: {
      id: 'ch-1',
      name: 'CVW Clovis',
      code: 'CVW-CLO',
      address: { line1: '1295 Shaw Ave', city: 'Fresno', region: 'California', postalCode: '93612' },
    },
    orderUrlBase: 'https://app.stockpilotusa.com',
    submitting: false,
    submitted: { id: 'b3f1c2d4-1111-2222-3333-444455556666', orderNumber: 49, unitCount: 5 },
    onClose: vi.fn(),
    onConfirm: vi.fn(),
    onViewOrder: vi.fn(),
    onDone: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<ReviewModal {...(props as never)} />) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('ReviewModal success stage', () => {
  it('prints the CANONICAL order number, never a uuid-derived SO- handle', () => {
    renderSuccess();
    expect(screen.getByText('SO-000049 · DC4 · 5 units')).toBeInTheDocument();
  });

  it('renders the delivery-request action alongside View order and Done', () => {
    renderSuccess();
    expect(screen.getByRole('button', { name: /Email delivery request/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /View order/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Done$/i })).toBeInTheDocument();
  });

  it('renders the action for a PICKUP order too (owner decision D1)', () => {
    renderSuccess({
      summary: {
        warehouseName: 'DC4',
        method: 'pickup',
        deliverTo: 'DC4 will-call desk',
        requestedFor: 'Branden Vincent-Walker',
        requesterEmail: 'branden@cvwest.org',
        orgTimezone: 'America/Los_Angeles',
      },
      destination: null,
    });
    expect(screen.getByRole('button', { name: /Email delivery request/i })).toBeInTheDocument();
  });

  it('never claims a ticket was created anywhere on the success screen', () => {
    const { container } = renderSuccess();
    const text = (container.textContent ?? '').toLowerCase();
    for (const claim of ['ticket created', 'ticket submitted', 'assigned to', 'email sent']) {
      expect(text).not.toContain(claim);
    }
  });

  it('the existing actions still work — R1', async () => {
    const user = userEvent.setup();
    const { props } = renderSuccess();

    await user.click(screen.getByRole('button', { name: /View order/i }));
    expect(props.onViewOrder).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /^Done$/i }));
    expect(props.onDone).toHaveBeenCalledTimes(1);
  });

  it('renders nothing at all when stage is null', () => {
    const { container } = render(
      <ReviewModal
        {...({
          stage: null,
          lines: [],
          itemMap: new Map(),
          notes: '',
          summary: {
            warehouseName: 'DC4',
            method: 'delivery',
            deliverTo: 'CVW Clovis',
            requestedFor: 'X',
            requesterEmail: null,
            orgTimezone: 'America/Los_Angeles',
          },
          neededBy: '',
          destination: null,
          orderUrlBase: '',
          submitting: false,
          submitted: null,
          onClose: vi.fn(),
          onConfirm: vi.fn(),
          onViewOrder: vi.fn(),
          onDone: vi.fn(),
        } as never)}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 3: Run both test files to verify they fail.**

Run: `pnpm --filter @stockpilot/web test src/components/orders/storefront 2>&1 | tail -25`
Expected: FAIL — `Unable to find an element by: [data-testid="delivery-request-notice"]` in the action file, and a missing `Email delivery request` button in the new overlays file if Task 6's wiring is incomplete. Record the real text.

- [ ] **Step 4: Add the affordances.** In `apps/web/src/components/orders/storefront/delivery-request-action.tsx`, add the draft counter beside the other state:

```tsx
  /**
   * How many drafts we have opened for THIS order in this session.
   *
   * We cannot detect a send — no integration observes the mailbox — so a repeat
   * is warned about, not blocked. Blocking would strand an employee whose first
   * draft was closed by accident, which is the more common case; sending two
   * near-identical requests to DC4 is the less common but noisier one, so it
   * gets a visible warning.
   */
  const [draftCount, setDraftCount] = React.useState(0);
```

increment it inside `handleOpen`, AFTER the open (never before — R3):

```tsx
    if (opened) {
      setDraftCount((n) => n + 1);
      toast.success('Delivery request draft opened in Outlook. Review it and press Send yourself.');
      return;
    }

    setDraftCount((n) => n + 1);
    setShowFallback(true);
```

and render the three notices, the first two immediately after the buttons and the third only when the draft was condensed:

```tsx
      <p className="sf-note" data-testid="delivery-request-notice">
        This opens a draft email. StockPilot does not send it and does not create a ticket. Review
        the message and press Send in your mail app.
      </p>

      {draftCount > 1 && (
        <p className="sf-note sf-note-warn" data-testid="delivery-request-repeat" role="status">
          You have already opened a draft for this order. Sending more than one creates duplicate
          requests for DC4.
        </p>
      )}

      {prepared.draft.condensed && (
        <p className="sf-note sf-note-warn" data-testid="delivery-request-condensed">
          This order is too large to fit in a compose link, so the draft carries a summary and a
          link to the full order. Copy the details instead to include every line.
        </p>
      )}
```

- [ ] **Step 5: Style the notices.** Append to `apps/web/src/components/orders/storefront/storefront.css`:

```css
/* Delivery-request assistant notices. There is no ui/alert.tsx in this repo
   (zero imports of @/components/ui/alert), so this reuses the house inline
   banner shape without importing Tailwind semantics into hand-rolled CSS. */
.sf-note {
  flex-basis: 100%;
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.5;
  text-align: left;
  opacity: 0.85;
}

.sf-note-warn {
  padding: 8px 10px;
  border: 1px solid rgba(180, 83, 9, 0.4);
  background: rgba(180, 83, 9, 0.08);
  border-radius: 6px;
  opacity: 1;
}
```

- [ ] **Step 6: Verify the pre-existing success paragraph.** Read `storefront-overlays.tsx:353-357` and confirm against the notification path that "Your manager has been notified" is still true for a `pending_approval` internal order. If it is, leave it and record the evidence in the Task 12 report under F. If it is NOT, this is a separate honesty bug — fix the sentence in this task and say so in the commit message.

- [ ] **Step 7: Run the tests to verify they pass.**

Run: `pnpm --filter @stockpilot/web test src/components/orders/storefront 2>&1 | tail -25`
Expected: PASS — the 7 new action assertions, the 6 new overlays assertions, and everything from Tasks 1 through 7.

- [ ] **Step 8: Commit.**

```bash
git add apps/web/src/components/orders/storefront/delivery-request-action.tsx \
        apps/web/src/components/orders/storefront/delivery-request-action.test.tsx \
        apps/web/src/components/orders/storefront/storefront-overlays.test.tsx \
        apps/web/src/components/orders/storefront/storefront.css
git commit -m "feat(orders): honesty affordances for the delivery request assistant"
```

---

## Task 9: Accessibility — the focus trap the success modal never had

`ReviewModal` sets `role="dialog" aria-modal="true"` and listens for Escape on `document`, but it has **no focus trap and no focus restore** (`storefront-overlays.tsx:222-248`). Tab walks straight out of the dialog into the page behind it, and closing the modal drops focus to `<body>`. Brief section 26 demands both. This task fixes the pre-existing gap, because Tasks 6-8 just added three more controls to that modal and made the gap larger and more visible.

Two things this task does NOT do: it does not migrate `ReviewModal` to Radix (that is a rewrite of a working surface, and the preview dialog already gets Radix's trap for free), and it does not touch the Escape guard (`closable` is deliberately false at the success stage so a submitted order cannot be dismissed by a stray keystroke).

**Files:**
- Modify: `apps/web/src/components/orders/storefront/storefront-overlays.tsx`
- Modify: `apps/web/src/components/orders/storefront/storefront-overlays.test.tsx`
- Modify: `apps/web/src/components/orders/storefront/delivery-request-action.tsx`
- Modify: `apps/web/src/components/orders/storefront/delivery-request-action.test.tsx`

**Interfaces:**
- Produces: no new exports. `ReviewModal` gains a focus trap, an initial focus target and focus restore.
- Consumes from Tasks 6-8: the three new controls that now live inside the modal.

**Steps:**

- [ ] **Step 1: Write the failing test.** Append to `apps/web/src/components/orders/storefront/storefront-overlays.test.tsx`:

```tsx
describe('ReviewModal accessibility', () => {
  it('moves focus INTO the dialog when it opens', async () => {
    renderSuccess();
    const dialog = screen.getByRole('dialog');
    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
  });

  it('traps Tab inside the dialog — the last control wraps to the first', async () => {
    const user = userEvent.setup();
    renderSuccess();
    const dialog = screen.getByRole('dialog');

    // Walk forward well past the number of controls; focus must never escape.
    for (let i = 0; i < 12; i += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('traps Shift+Tab too — the first control wraps to the last', async () => {
    const user = userEvent.setup();
    renderSuccess();
    const dialog = screen.getByRole('dialog');

    for (let i = 0; i < 12; i += 1) {
      await user.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('RESTORES focus to the element that was focused before it opened', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Review';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = render(
      <ReviewModal
        {...({
          stage: 'success',
          lines: [{ itemId: 'i-1', quantity: 5 }],
          itemMap: new Map([['i-1', ITEM]]),
          notes: '',
          summary: {
            warehouseName: 'DC4',
            method: 'delivery',
            deliverTo: 'CVW Clovis',
            requestedFor: 'Branden Vincent-Walker',
            requesterEmail: 'branden@cvwest.org',
            orgTimezone: 'America/Los_Angeles',
          },
          neededBy: '',
          destination: null,
          orderUrlBase: '',
          submitting: false,
          submitted: { id: 'b3f1c2d4-1111-2222-3333-444455556666', orderNumber: 49, unitCount: 5 },
          onClose: vi.fn(),
          onConfirm: vi.fn(),
          onViewOrder: vi.fn(),
          onDone: vi.fn(),
        } as never)}
      />,
    );

    await waitFor(() => expect(document.activeElement).not.toBe(trigger));
    unmount();
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    trigger.remove();
  });

  it('every new control is reachable by keyboard and has an accessible name', async () => {
    const user = userEvent.setup();
    renderSuccess();

    const names = ['Email delivery request', 'Preview', 'View order', 'Done'];
    const seen = new Set<string>();
    for (let i = 0; i < 12; i += 1) {
      await user.tab();
      const label = document.activeElement?.textContent?.trim() ?? '';
      for (const n of names) if (label.includes(n)) seen.add(n);
    }
    expect(Array.from(seen).sort()).toEqual([...names].sort());
  });
});
```

and append to `apps/web/src/components/orders/storefront/delivery-request-action.test.tsx`:

```tsx
describe('DeliveryRequestAction accessibility', () => {
  it('announces the copy result in a polite live region', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('open', vi.fn(() => null));
    stubLocationAssign();
    stubClipboard();

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));
    await user.click(await screen.findByRole('button', { name: /Copy the details/i }));

    const live = await screen.findByTestId('delivery-request-live');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveAttribute('aria-atomic', 'true');
    await waitFor(() =>
      expect(live).toHaveTextContent(
        'Delivery request copied. Create a new email to dc4@learn4life.org, CC arosas@cvwest.org, and paste the copied details.',
      ),
    );
  });

  it('is operable entirely from the keyboard', async () => {
    const user = userEvent.setup();
    const open = stubOpen();

    render(<DeliveryRequestAction input={makeInput()} />);
    screen.getByRole('button', { name: /Email delivery request/i }).focus();
    await user.keyboard('{Enter}');

    expect(open).toHaveBeenCalledTimes(1);
  });

  it('gives every icon aria-hidden so screen readers read the label once', () => {
    const { container } = render(<DeliveryRequestAction input={makeInput()} />);
    for (const svg of Array.from(container.querySelectorAll('svg'))) {
      expect(svg).toHaveAttribute('aria-hidden', 'true');
    }
  });
});
```

Add `waitFor` to the `@testing-library/react` import in the overlays test file.

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `pnpm --filter @stockpilot/web test src/components/orders/storefront 2>&1 | tail -25`
Expected: FAIL — the trap tests fail because focus escapes the dialog after the last control, and `delivery-request-live` is not found. Record the real text.

- [ ] **Step 3: Add the trap and restore.** In `apps/web/src/components/orders/storefront/storefront-overlays.tsx`, replace the existing keydown effect (lines 224-231) with the following, and attach `ref={dialogRef}` to the `div.sf-modal`:

```tsx
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const restoreRef = React.useRef<HTMLElement | null>(null);

  /**
   * Focus management for a hand-rolled dialog.
   *
   * This modal has always declared role="dialog" aria-modal="true" while doing
   * neither of the two things that declaration promises: Tab walked straight
   * out into the page behind it, and closing dropped focus to <body>. That was
   * survivable when the success screen held two buttons; it is not now that it
   * holds a mail action, a preview, a copy control and a fallback textarea.
   *
   * Deliberately NOT a migration to Radix Dialog: this is a working surface
   * with its own visual language, and the one place that genuinely needed
   * Radix — the preview dialog — already uses it.
   */
  React.useEffect(() => {
    if (!open) return;

    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusables = (): HTMLElement[] => {
      const root = dialogRef.current;
      if (!root) return [];
      return Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
    };

    // Initial focus: the first control in the dialog, else the dialog itself.
    const first = focusables()[0];
    if (first) first.focus();
    else dialogRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (closable) onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstItem = items[0]!;
      const lastItem = items[items.length - 1]!;
      const active = document.activeElement;

      if (e.shiftKey && (active === firstItem || !dialogRef.current?.contains(active))) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && (active === lastItem || !dialogRef.current?.contains(active))) {
        e.preventDefault();
        firstItem.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // Restore focus to whatever opened us, so a keyboard user is not dropped
      // at the top of the document.
      restoreRef.current?.focus();
    };
  }, [open, closable, onClose]);
```

and give the dialog container `tabIndex={-1}` so `dialogRef.current?.focus()` works when it holds no controls:

```tsx
      <div
        className="sf-modal"
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
```

- [ ] **Step 4: Add the live region.** In `apps/web/src/components/orders/storefront/delivery-request-action.tsx`, add announcement state and render the region. Reuse the storefront's own idiom — `<div aria-live="polite" aria-atomic="true" className="sf-sr-only">` at `storefront-cart.tsx:93`:

```tsx
  const [announcement, setAnnouncement] = React.useState('');
```

set it wherever a toast fires (`setAnnouncement(message)` with the same string), and render:

```tsx
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sf-sr-only"
        data-testid="delivery-request-live"
      >
        {announcement}
      </div>
```

- [ ] **Step 5: Run the tests to verify they pass.**

Run: `pnpm --filter @stockpilot/web test src/components/orders/storefront 2>&1 | tail -25`
Expected: PASS — 5 new overlays assertions, 3 new action assertions, plus everything prior.

- [ ] **Step 6: Regression check (R1).** Confirm the review stage still behaves: Escape closes it while `stage === 'review'` and `!submitting`, and does NOT close it at `stage === 'success'`.

Run: `pnpm --filter @stockpilot/web test src/components/orders 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 7: Hand-test with the keyboard.** In the browser, place a test order in Demo Co, then WITHOUT touching the mouse: Tab to every control on the success screen, open the preview with Enter, Tab inside it, close it with Escape, and confirm focus returns to the Preview button. Record what happened.

- [ ] **Step 8: Commit.**

```bash
git add apps/web/src/components/orders/storefront/storefront-overlays.tsx \
        apps/web/src/components/orders/storefront/storefront-overlays.test.tsx \
        apps/web/src/components/orders/storefront/delivery-request-action.tsx \
        apps/web/src/components/orders/storefront/delivery-request-action.test.tsx
git commit -m "fix(orders): trap and restore focus in the storefront review modal"
```

---

# Phase 4 — Record keeping, verification and the report

## Task 10: The audit event — a draft was OPENED, nothing more

**NO MIGRATION.** `audit_logs` has columns `id, organization_id, user_id, event (text), metadata (jsonb), ip, user_agent, created_at` and no entity column — entity identity lives inside `metadata` as `entity_type` / `entity_id` (`audit.ts:325-340`). Prod `pg_constraint` for `public.audit_logs` returns only `audit_logs_pkey` and two FKs: **no CHECK, no enum on `event`**. Adding `'order.delivery_request_drafted'` is a pure TypeScript union edit, and it then renders for free in `<OrderTimeline orderId organizationId />` on the order detail page (`dashboard/orders/[id]/page.tsx:880`).

**The metadata allow-list is a security boundary.** Safe: `orderId`, the actor (captured by `audit()` from the context, never passed by the client), `recipientType`, `includedCcRecipient`, `isCondensed`. **Never stored:** the compose URL, the message body, delivery instructions, the requester phone, the destination address, or the order notes. **Never recorded:** "ticket assigned to arosas@cvwest.org" — unconfirmable.

**`audit()` needs a page-request context here, and it has one.** The gotcha at `audit.ts:294-350` is that API-route and Bearer callers must pass their `ServiceContext` explicitly, because the `withContext()` fallback throws `NEXT_REDIRECT` outside a page request and the event is silently dropped. This is a Server Action invoked from a page, so the fallback works — but write it as a normal action, not an API route, and never move it.

**Files:**
- Modify: `apps/web/src/server/services/audit.ts:139-159`
- Create: `apps/web/src/server/actions/delivery-request.ts`
- Create: `apps/web/src/server/actions/delivery-request.test.ts`
- Modify: `apps/web/src/components/orders/storefront/delivery-request-action.tsx`
- Modify: `apps/web/src/components/orders/storefront/delivery-request-action.test.tsx`

**Interfaces:**
- Produces: `AuditEvent` gains `'order.delivery_request_drafted'`; `recordDeliveryRequestDraftedAction(input: { orderId: string; isCondensed: boolean }): Promise<void>`.
- Consumes from Tasks 6-8: the click handlers that fire it, always AFTER `window.open`.

**Steps:**

- [ ] **Step 1: Write the failing test.** Create `apps/web/src/server/actions/delivery-request.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The global test setup mocks @/server/services/audit to a no-op
 * (src/test/setup.ts:13-16), so a file that ASSERTS on audit must declare its
 * own per-file mock. This is that declaration.
 */
const auditSpy = vi.fn(async () => {});
vi.mock('@/server/services/audit', () => ({ audit: (...a: unknown[]) => auditSpy(...a) }));

import { recordDeliveryRequestDraftedAction } from './delivery-request';

const ORDER = 'b3f1c2d4-1111-2222-3333-444455556666';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recordDeliveryRequestDraftedAction', () => {
  it('records that a DRAFT was opened, under the order.* event group', async () => {
    await recordDeliveryRequestDraftedAction({ orderId: ORDER, isCondensed: false });

    expect(auditSpy).toHaveBeenCalledTimes(1);
    const payload = auditSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.event).toBe('order.delivery_request_drafted');
    expect(payload.entityType).toBe('order_request');
    expect(payload.entityId).toBe(ORDER);
  });

  it('stores ONLY the safe metadata allow-list', async () => {
    await recordDeliveryRequestDraftedAction({ orderId: ORDER, isCondensed: true });

    const payload = auditSpy.mock.calls[0]![0] as { extra: Record<string, unknown> };
    expect(payload.extra).toEqual({
      recipient_type: 'dc4-delivery-request',
      included_cc_recipient: true,
      is_condensed: true,
    });
  });

  it('never stores the body, the URL, the address, the notes or a phone number', async () => {
    await recordDeliveryRequestDraftedAction({ orderId: ORDER, isCondensed: false });

    const serialized = JSON.stringify(auditSpy.mock.calls[0]![0]);
    for (const forbidden of [
      'outlook.office.com',
      'mailto:',
      'DELIVERY REQUEST',
      'Shaw Ave',
      'body',
      'compose_url',
      'notes',
      'phone',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('never stores either email address — analytics and audit record the FACT, not the recipient', async () => {
    await recordDeliveryRequestDraftedAction({ orderId: ORDER, isCondensed: false });

    const serialized = JSON.stringify(auditSpy.mock.calls[0]![0]);
    expect(serialized).not.toContain('dc4@learn4life.org');
    expect(serialized).not.toContain('arosas@cvwest.org');
  });

  it('never claims a ticket was created or assigned', async () => {
    await recordDeliveryRequestDraftedAction({ orderId: ORDER, isCondensed: false });

    const serialized = JSON.stringify(auditSpy.mock.calls[0]![0]).toLowerCase();
    expect(serialized).not.toContain('ticket');
    expect(serialized).not.toContain('assigned');
    expect(serialized).not.toContain('sent');
  });

  it('rejects a non-uuid order id without calling audit', async () => {
    await recordDeliveryRequestDraftedAction({ orderId: 'not-a-uuid', isCondensed: false });
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('never throws, whatever audit does — a logging failure must not break the UI', async () => {
    auditSpy.mockRejectedValueOnce(new Error('audit exploded'));
    await expect(
      recordDeliveryRequestDraftedAction({ orderId: ORDER, isCondensed: false }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `pnpm --filter @stockpilot/web test src/server/actions/delivery-request.test.ts 2>&1 | tail -20`
Expected: FAIL — `Failed to resolve import "./delivery-request"`. Record the real text.

- [ ] **Step 3: Add the audit event.** In `apps/web/src/server/services/audit.ts`, add to the `order.*` group (after `'order.completed'`, before `'pdf.exported'`):

```ts
  /**
   * An employee opened a prefilled delivery-request DRAFT in their mail client
   * from the order-success screen. It records that a draft was OPENED and
   * nothing more: StockPilot cannot observe whether the employee pressed Send,
   * cannot confirm the message arrived, and cannot know whether a Zendesk
   * ticket was created — DC4's intake is email-based and entirely outside this
   * application. Never widen this event's meaning.
   *
   * No migration: audit_logs.event is plain text with no CHECK and no enum
   * (prod-verified), so this union member is the whole change. It renders in
   * OrderTimeline on the order detail page for free.
   */
  | 'order.delivery_request_drafted'
```

- [ ] **Step 4: Create the action.** Create `apps/web/src/server/actions/delivery-request.ts`:

```ts
'use server';

import { z } from 'zod';

import { audit } from '@/server/services/audit';

const schema = z.object({
  orderId: z.string().uuid(),
  isCondensed: z.boolean(),
});

/**
 * Record that a delivery-request draft was opened for an order.
 *
 * This writes ONE audit row and nothing else. It does not create an order, does
 * not mutate the order, does not send mail, and does not talk to Zendesk.
 *
 * The metadata is an explicit ALLOW-LIST. The compose URL, the message body,
 * the destination address, the order notes and the requester phone are all
 * deliberately excluded: an audit row is read by more people than the email is,
 * and none of that detail is needed to answer the only question this row
 * exists to answer — "did somebody draft a request for this order, and when".
 * The recipient ADDRESSES are excluded too; `recipient_type` and
 * `included_cc_recipient` record the fact without copying the addresses into a
 * second store.
 *
 * The actor and the organisation come from the audit service's own context, not
 * from the caller, so a client cannot attribute a draft to somebody else.
 *
 * Best-effort and never throws: it is called AFTER window.open, and a logging
 * failure must never surface as a broken action to an employee who has already
 * got their draft.
 */
export async function recordDeliveryRequestDraftedAction(input: {
  orderId: string;
  isCondensed: boolean;
}): Promise<void> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return;

  try {
    await audit({
      event: 'order.delivery_request_drafted',
      entityType: 'order_request',
      entityId: parsed.data.orderId,
      extra: {
        recipient_type: 'dc4-delivery-request',
        included_cc_recipient: true,
        is_condensed: parsed.data.isCondensed,
      },
    });
  } catch {
    // audit() is already best-effort; this is belt and braces so the client
    // promise never rejects.
  }
}
```

- [ ] **Step 5: Wire it into the component, AFTER the open.** In `apps/web/src/components/orders/storefront/delivery-request-action.tsx`, add the imports:

```tsx
import { capture } from '@/lib/analytics';
import { recordDeliveryRequestDraftedAction } from '@/server/actions/delivery-request';
```

and call both at the END of `handleOpen`, in the success branch and in the fallback branch, never before the `window.open` line:

```tsx
  /**
   * Fire-and-forget bookkeeping. Called only AFTER window.open has already run,
   * because anything awaited before the open makes it asynchronous relative to
   * the click gesture and the browser blocks the popup.
   *
   * Analytics records the FACT of a CC, never the address — the addresses do
   * not go to a third-party processor.
   */
  function recordDraft() {
    void recordDeliveryRequestDraftedAction({
      orderId: input.orderId,
      isCondensed: prepared.draft.condensed,
    });
    capture('delivery_request_drafted', {
      order_id: input.orderId,
      fulfillment_type: input.fulfillmentType,
      is_condensed: prepared.draft.condensed,
      included_cc_recipient: true,
      line_count: prepared.draft.lineCount,
    });
  }
```

calling `recordDraft()` immediately after each `setDraftCount((n) => n + 1)`.

- [ ] **Step 6: Assert the ordering in the component test.** Append to `apps/web/src/components/orders/storefront/delivery-request-action.test.tsx`:

```tsx
describe('DeliveryRequestAction — bookkeeping never precedes the open', () => {
  it('opens the window BEFORE recording anything', async () => {
    const user = userEvent.setup();
    const order: string[] = [];
    vi.stubGlobal('open', vi.fn(() => {
      order.push('open');
      return { focus: vi.fn() };
    }));

    recordDraftedSpy.mockImplementationOnce(async () => {
      order.push('record');
    });

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));

    await waitFor(() => expect(recordDraftedSpy).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['open', 'record']);
  });

  it('records only the safe fields', async () => {
    const user = userEvent.setup();
    stubOpen();

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));

    await waitFor(() => expect(recordDraftedSpy).toHaveBeenCalledTimes(1));
    expect(recordDraftedSpy.mock.calls[0]![0]).toEqual({
      orderId: 'b3f1c2d4-1111-2222-3333-444455556666',
      isCondensed: false,
    });
  });

  it('still opens the draft when the audit call rejects', async () => {
    const user = userEvent.setup();
    const open = stubOpen();
    recordDraftedSpy.mockRejectedValueOnce(new Error('offline'));

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));

    expect(open).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });
});
```

and add these mocks to the TOP of that file, beside the existing `sonner` mock:

```tsx
const recordDraftedSpy = vi.fn(async () => {});
vi.mock('@/server/actions/delivery-request', () => ({
  recordDeliveryRequestDraftedAction: (...a: unknown[]) => recordDraftedSpy(...a),
}));
const captureSpy = vi.fn();
vi.mock('@/lib/analytics', () => ({ capture: (...a: unknown[]) => captureSpy(...a) }));
```

- [ ] **Step 7: Run the tests to verify they pass.**

Run: `pnpm --filter @stockpilot/web test src/server/actions/delivery-request.test.ts src/components/orders/storefront 2>&1 | tail -25`
Expected: PASS — 7 action assertions plus 3 new component assertions plus everything prior.

- [ ] **Step 8: Confirm there is no migration in this branch.**

Run: `git diff --stat main -- supabase/`
Expected: no output. If a `.sql` file appears, delete it — the schema needs no change.

- [ ] **Step 9: Commit.**

```bash
git add apps/web/src/server/services/audit.ts \
        apps/web/src/server/actions/delivery-request.ts \
        apps/web/src/server/actions/delivery-request.test.ts \
        apps/web/src/components/orders/storefront/delivery-request-action.tsx \
        apps/web/src/components/orders/storefront/delivery-request-action.test.tsx
git commit -m "feat(orders): audit that a delivery-request draft was opened, with a safe metadata allow-list"
```

---

## Task 11: The verification gate, with real numbers

Nothing in this feature may be called done before this task's evidence exists. Every command's REAL output is recorded — the acceptance criteria demand that unit tests, component tests, typecheck, lint and the production build all pass, and a claim without output in front of you is not a result.

**Files:**
- Create: `docs/superpowers/reports/2026-08-01-delivery-request-assistant-verification.md`

**Interfaces:**
- Consumes: every prior task.
- Produces for Task 12: the real command output quoted in the report under G.

**Steps:**

- [ ] **Step 1: Run the four gates and record the REAL output of each.**

```bash
pnpm typecheck 2>&1 | tail -20
pnpm lint 2>&1 | tail -30
pnpm test 2>&1 | tail -40
pnpm --filter @stockpilot/web build 2>&1 | tail -40
```

Expected: all four clean. Record the vitest summary line verbatim — the test-file count and assertion count are quoted in Task 12.

- [ ] **Step 2: Confirm the branch discipline.**

```bash
git status -sb
git log --oneline main..HEAD
git branch -r --list 'origin/feat/delivery-request-assistant'
```

Expected: on `feat/delivery-request-assistant`, ten local commits (Tasks 1-10), and NO remote branch. If a remote branch exists, something was pushed — stop and tell the owner.

- [ ] **Step 3: Confirm no migration and no duplicate recipient literal.**

```bash
git diff --stat main -- supabase/
grep -rn "dc4@learn4life.org\|arosas@cvwest.org" apps/web/src apps/mobile packages --include=*.ts --include=*.tsx | grep -v ".test."
grep -rn "orderRef" apps/web/src apps/mobile packages
```

Expected: no migration diff; exactly one recipient definition (`apps/web/src/lib/site.ts`); zero `orderRef` hits.

- [ ] **Step 4: Walk the feature by hand in Demo Co.** Sign in as `demo@stockpilotusa.com` at `/signin` (NOT `/login`) — the password is held in the team secret manager under `stockpilot/demo-org-qa-login` and is deliberately NOT recorded in this repository. Org Demo Co `71b27a4a-7948-4638-bc3f-535974713bd2`. Run each line, recording pass or fail:
  1. **Delivery order.** Add two items, pick a delivery site, set a needed-by date, add notes, submit. The success screen prints a real `SO-` number — cross-check it against `/dashboard/orders` and confirm the SAME number appears there.
  2. **Preview.** Open the preview. Both recipients visible under EMAIL RECIPIENTS, the helper text present, no editable field, the body shows the site, the address, the date in org time with the zone named, and every line item.
  3. **Open.** Press Open in Outlook. A compose window opens with To, CC, subject and body prefilled. **Do not press Send.**
  4. **Popup blocked.** Block popups for the site in browser settings, click again, and confirm the mailto attempt plus the visible copy fallback naming both recipients.
  5. **Copy.** Press Copy the details. Paste into a scratch editor and confirm the TO / CC / SUBJECT / MESSAGE blocks and the full item list.
  6. **Repeat warning.** Click the primary button twice; the duplicate warning appears and the button stays enabled.
  7. **Pickup order.** Place a second order with fulfillment Pickup. The action still appears; the body says Pickup / will-call, names the will-call desk and who is collecting, and contains NO destination block and no address.
  8. **Large order.** Place an order with enough lines to exceed the limit. The condensed disclosure appears on screen AND in the body, the link still works, and the clipboard path still carries every line.
  9. **Audit.** Open `/dashboard/orders/<id>` for the first order and confirm the timeline shows the delivery-request-drafted entry. Confirm the row's metadata contains no body, no URL and no address.
  10. **No duplicate order.** Confirm `/dashboard/orders` shows exactly the orders you placed and no extras, and that neither order's status or contents changed (R2).
  11. **Keyboard.** Complete steps 2, 3 and 5 using only the keyboard, and confirm focus never leaves the dialog and returns to the trigger on close.
- [ ] **Step 5: Confirm the two things this feature CANNOT verify, and say so rather than guessing.** Whether Outlook Web honours the `cc` deep-link parameter in the org's managed Microsoft 365 tenant, on Edge and Chrome, and whether the default mail app honours it, is OWNER/ENVIRONMENT QA — it cannot be automated here. Record it as owed. **If a supported environment drops the CC, that is a bug to investigate in the compose-link structure with a safe fallback, never a recipient to silently omit.**
- [ ] **Step 6: Write `docs/superpowers/reports/2026-08-01-delivery-request-assistant-verification.md`** with the real output of the four gates, the pass/fail of every numbered line, and any line that failed. Do not omit a failure.
- [ ] **Step 7: Commit.**

```bash
git add docs/superpowers/reports/2026-08-01-delivery-request-assistant-verification.md
git commit -m "docs(orders): delivery request assistant verification results"
```

---

## Task 12: The section 41 final implementation report

A required deliverable, not optional, and it must be written from what the implementation ACTUALLY does rather than what it was meant to do. Sections A through I, in the brief's order.

**Files:**
- Create: `docs/superpowers/reports/2026-08-01-delivery-request-assistant-report.md`

**Interfaces:**
- Consumes: every prior task, plus Task 11's verification report.
- Produces: the final hand-off document.

**Steps:**

- [ ] **Step 1: Write section A — Summary.** The completed employee workflow in prose: employee builds a cart at `/dashboard/orders/new`, submits, and the order is persisted at `pending_approval` with a real `order_number`; the success stage of the review modal now offers "Email delivery request" and "Preview"; preview shows both recipients and the exact plain-text message; opening composes it in Outlook prefilled; the employee reviews and presses Send themselves; StockPilot records only that a draft was opened.
- [ ] **Step 2: Write section B — Repository inspection, the ACTUAL files.** One line each, with the path:
  - order creation: `apps/web/src/app/(dashboard)/dashboard/orders/new/page.tsx` -> `OrdersStorefront`
  - order submission logic: `handleConfirmSubmit` in `apps/web/src/components/orders/storefront/orders-storefront.tsx`, calling `createOrderRequestAction` (`apps/web/src/server/actions/order-requests.ts`) -> `OrderRequestsService.create`
  - order-success component: the `stage === 'success'` branch of `ReviewModal`, `apps/web/src/components/orders/storefront/storefront-overlays.tsx` — a MODAL STAGE, not a route
  - order detail query: `OrderRequestsService.get(id)` returning `OrderRequestDetail`, exposed at `GET /api/v1/orders/[id]` — reused for the durable second home in section I, NOT re-mapped here
  - requester profile source: `order_requests.requester_name/_email` falling back to the joined `user_profiles`, with `||` not `??` (`order-requests.ts:780-783`); the storefront's client-side twin is `state.onBehalfOf?.name ?? viewerLabel`
  - destination source: `order_requests.delivery_charter_id` -> `charters`, name/code/`address` jsonb via `loadChartersForWarehouse`
  - requested-date field: `order_requests.needed_by` (timestamptz), captured as a `datetime-local` on `CartState.neededBy`
  - order-item relationship: `order_request_lines.item_id` -> `inventory_items`, quantity in `quantity_requested`
  - UI components reused: the storefront's own `sf-*` classes, `lucide-react`, `sonner`, Radix `Dialog` for the preview only
  - test setup reused: vitest with `happy-dom` for `src/components/**`, `@testing-library/react` + `user-event`, the `Object.defineProperty(navigator, 'clipboard', ...)` idiom from `mfa-recovery-codes.test.tsx:60-88`, `vi.stubGlobal` for `open`, the `makeItem()` factory in `storefront-logic.test.ts`
- [ ] **Step 3: Write section C — Files changed,** every file with WHY, sourced from `git diff --stat main...HEAD`.
- [ ] **Step 4: Write section D — the data mapping table, in REAL StockPilot field names.** One row per brief field. It must state ABSENT plainly where the data does not exist:

| Brief field | Actual field / relationship |
|---|---|
| Order number | `order_requests.order_number` (bigint, per-org sequence, trigger `assign_order_request_number`, migration 0254) -> `formatOrderNumber` |
| Requester name | `order_requests.requester_name` else `requester_user_id` -> `user_profiles.full_name`; client-side, `onBehalfOf.name` else viewer name else viewer email |
| Requester site | **ABSENT** — the storefront captures no site for the requester; the only site on an order is the delivery charter |
| Destination site | `order_requests.delivery_charter_id` -> `charters.name` / `.code` / `.address` (jsonb: `line1`, `line2`, `city`, `region`, `postalCode`, `country` — `region`, not `state`) |
| Requested delivery date | `order_requests.needed_by` (timestamptz), from `CartState.neededBy` |
| Ordered items | `order_request_lines.item_id` -> `inventory_items.name` / `.sku`, `order_request_lines.quantity_requested` |
| Order notes | `order_requests.notes` |
| Delivery instructions | **ABSENT** — no `delivery_instructions` / `dropoff_instructions` / `ship_to` column anywhere in the public schema |

Add rows recording that destination building, room, priority/urgency, site contact (0 of 16 charters populated), requester phone (hardcoded null on this path), per-line notes (0 of 150 rows) and unit of measure (unselected, messy free text) are all omitted, and WHY omitting beats stubbing.
- [ ] **Step 5: Write section E — the Outlook strategy.** URL generation (`https://outlook.office.com/mail/deeplink/compose`, chosen over `outlook.live.com` because the org runs managed M365); encoding (`URLSearchParams`, exactly once, `to`/`cc`/`subject`/`body` as real parameters); plain-text formatting (blocks joined by a blank line, omitted blocks leave no trace, all user text passed through `toPlainTextLine` so no newline can forge a header); popup handling (`window.open` first statement in the handler, `null` or a throw drives the fallback); default-email fallback (`location.assign(mailto:)`, To in the path, cc in the query); clipboard fallback (labelled TO/CC/SUBJECT/MESSAGE, always the FULL body, plus a selectable textarea when the API is denied or absent); large-order handling (measured against `DRAFT_URL_LIMIT = 1800`, condensed variant, disclosed in the body AND on screen).
- [ ] **Step 6: Write section F — Status accuracy.** State explicitly: StockPilot records only that a DRAFT WAS OPENED (`order.delivery_request_drafted`), never that a ticket was submitted. Quote the audit metadata allow-list. State that the "Your manager has been notified" sentence at `storefront-overlays.tsx:353-357` was re-verified in Task 8 and record the finding.
- [ ] **Step 7: Write section G — Tests, each command and its REAL result,** copied from Task 11's verification report. **This section must also record the deviation from brief section 34:** no Playwright e2e was written, on the owner's explicit instruction (owner decision 3), because Playwright is not wired into CI (`.github/workflows/ci.yml:34-38,70-92` runs typecheck, vitest, build and pgTAP only), none of the five existing specs creates data, and `auth.setup.ts:15-48` skips without `TEST_USER_EMAIL`/`TEST_USER_PASSWORD` and throws on an MFA account. Name the component tests that carry the coverage instead — open, popup-blocked, mailto, clipboard, clipboard-denied, duplicate-draft, condensed, pickup, keyboard, and the CC on every path.
- [ ] **Step 8: Write section H — Limitations, plainly:** cannot confirm the employee pressed Send; cannot capture a Zendesk ticket number in this phase; attachments cannot be auto-added through a compose link; ticket status cannot sync without a future integration. Add the four this implementation found: the destination address is a best-effort render of owner-maintained data that contains at least one known typo (KVA Tulare says "Calfornia"); 4 of 16 sites have no address at all; whether Outlook Web honours the `cc` deep-link parameter in the org's tenant is unverified owner QA; and the success surface is React state, so the assistant is unreachable after a refresh.
- [ ] **Step 9: Write section I — ONE recommended next phase, recommend only, do not implement.** The recommendation is the **durable second home on `/dashboard/orders/[id]`**: that page already loads the full `OrderRequestDetail` server-side, it survives refresh and navigation, and it is where a manager or the requester goes when the first draft was lost. Note what it additionally requires: R8 handling for the 5 of 41 prod delivery orders whose `delivery_charter_id` is NULL under a `NOT VALID` CHECK, and a decision on who may draft one (owner open question 8). Mention the alternatives considered and rejected for now — persisting a Zendesk ticket number, a direct Zendesk API integration, Microsoft Graph, auto packing slip, delivery status sync — and say why the durable entry point beats all of them on value per unit of risk.
- [ ] **Step 10: Add the open questions section,** reproducing the four unresolved items from this plan's Global Constraints unchanged: the pickup subject format, whether the recipient pair is L4L-only or a product feature, the Zendesk intake contract, and the durable second home. None may be answered by an implementation detail.
- [ ] **Step 11: Commit.**

```bash
git add docs/superpowers/reports/2026-08-01-delivery-request-assistant-report.md
git commit -m "docs(orders): delivery request assistant final implementation report"
```

---

## Acceptance-criteria coverage

Every criterion the addendum records, and the task that satisfies it.

| Criterion | Task |
|---|---|
| Delivery instructions appear when available | 4 — the field does not exist; order notes are printed under an honest heading and the report says so |
| Order notes appear when available | 4 |
| An order link appears when a SAFE route exists | 4 — `/dashboard/orders/<uuid>`, omitted entirely when no absolute base is configured |
| The Outlook URL is properly encoded | 5 — `URLSearchParams`, once, round-trip asserted |
| Outlook opens from a DIRECT user action | 6 — `window.open` is the first statement; Task 10 asserts the ordering |
| Email is not sent automatically | 6, 8 — nothing sends; the copy says so |
| Popup-blocked fallback exists | 6 |
| Default-email fallback exists | 6 — `location.assign(mailto:)` |
| Copy fallback exists | 6 — plus a selectable textarea when the clipboard is denied or absent |
| Large-order handling exists AND its truncation is clearly disclosed | 5 (measured condensation), 8 (on-screen disclosure), 4 (in-body disclosure) |
| Repeated-click duplicate warning exists | 8 |
| The UI NEVER claims a ticket was submitted | 8, plus assertions in 6, 7 and 10 |
| Keyboard accessible | 9 |
| Works on mobile | 6, 7 — the storefront is responsive and the action is a plain button; the mobile APP is out of scope (Global Constraint 10) |
| No direct Zendesk integration added | Global Constraint 4; nothing in this plan touches the Zendesk connector |
| No Microsoft Graph integration added | Nothing in this plan adds an auth flow or a Graph dependency |
| No duplicate order created | Global Constraint 4, R2; asserted in Task 6 |
| Existing order actions still work | R1, asserted in Tasks 3, 8 and 9 |
| Unit / component tests pass | 4, 5 (unit), 6, 7, 8, 9, 10 (component); consolidated in 11 |
| e2e tests pass | **Deliberate deviation** — owner decision 3; documented in Task 12 section G |
| Typecheck passes | 11 |
| Lint passes | 11 |
| Production build passes | 11 |

### CC-specific coverage required by the addendum

| Required assertion | Task |
|---|---|
| `result.to` / `result.cc` exact | 4 |
| Decoded Outlook URL `searchParams.get('cc')` | 5 |
| Decoded mailto `cc` | 5 |
| CC appears exactly ONCE | 5 |
| CC not in the body | 4 |
| CC not concatenated into `to` | 4, 5 |
| Correctly encoded | 5 |
| Present in condensed mode | 4, 5 |
| Present when optional fields are missing | 5 |
| Present for very large orders | 4, 5 |
| Present in the clipboard fallback | 5, 6 |
| NO user-controlled field can override it | 4, 5 |
| Empty config falls back to the approved address | 2 — the config IS the literal; the frozen-object test is the equivalent guarantee |
| Preview shows both | 7 |
| Outlook click URL has the CC param | 6 |
| mailto click has it | 6 |
| Copy copies both | 6 |
| Popup-blocked instructions mention both | 6 |
| Employees cannot edit the CC | 7 |
| Missing order info does not drop it | 5 |
| Duplicate-draft handling preserves it | 8 |
| Condensed mode preserves it | 5, 7 |

---

## Unrecorded brief details — where sections 1-40 are not on disk

The owner's brief is a chat message; only its tail and the CC rules were captured. These four points needed a section 1-40 detail that neither the addendum nor the audit records. Each is resolved here with a stated default that must be confirmed, not assumed correct.

1. **The exact subject string.** Section 10 is known to demand ONE consistent format for Zendesk routing, but the format itself is not on disk. This plan uses `Delivery Request — StockPilot Order SO-000049 — <site or warehouse>` for both fulfillment types. If the brief specified different words, a different separator, or a routing prefix that DC4's intake filters on, the subject in Task 4 must change and the tests with it.
2. **The exact body template.** The audit establishes which FIELDS exist; the brief's actual headings, ordering and wording are not recorded. This plan's block order (header, method/status, from, destination or pickup, needed by, items, notes, link, footer) is a reasoned construction, not a transcription.
3. **Whether a "requester site" was required.** Section 41-D asks for a "requester site" mapping. No such datum exists on the internal storefront — the only site on an order is the delivery charter, and the requester's own site is not captured anywhere. The report records it as ABSENT. If the brief meant the requester's home charter, that is a new data-capture requirement and a separate spec.
4. **The precise on-screen copy** for the "does not create a ticket" notice, the duplicate warning and the truncation disclosure. The addendum fixes the post-copy sentence verbatim and this plan uses it exactly; the other three sentences are written to the brief's stated PRINCIPLE (accuracy over optimism, never claim a ticket) rather than to recorded strings. If the brief specified wording, replace them and update the assertions in Tasks 6 and 8.

---

## Open questions for the owner

None blocks starting this plan. Each blocks the thing it names.

1. **Pickup subject format.** Keep the single "Delivery Request" subject for pickup orders (this plan's default, which keeps Zendesk routing uniform), or introduce a second pickup-specific format? A second format needs explicit sign-off.
2. **Is the recipient pair L4L-only, or a product feature every org gets?** Hard-coded today. Per-org configuration is the only option that needs a migration.
3. **What is DC4's real Zendesk intake contract?** A required subject prefix, a ticket-form token or a structured body block would change Task 4's output. We cannot detect a mis-route from the app side.
4. **Should the assistant have a durable second home on `/dashboard/orders/[id]`?** Recommended as the next phase (Task 12 section I). It needs R8 handling for the 5 orphaned delivery orders and a decision on who may draft one.
5. **Who may draft a delivery request?** Today anyone with `orders:request` reaches the success screen and inherits the existing gate. Should it be narrowed to a role?
6. **Is the street address worth carrying at all?** This plan carries it (one column on an already-cached loader, cache key bumped). Given 4 of 16 sites have none and at least one has a typo, site name plus code alone may serve DC4 better.
