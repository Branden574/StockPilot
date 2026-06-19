# Recurring Purchase Orders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let an org define recurring PO templates (supplier + line items + cadence + send rule) that a daily cron turns into purchase orders — draft by default, opt-in auto-send bounded by a $ cap and the org's PO approval threshold.

**Architecture:** A new `recurring_po_templates` table (RLS-scoped, line items in jsonb) + a `RecurringPoTemplatesService` (CRUD + `seedFromPo` + `runDueTemplates`) that **mirrors the shipped auto-reorder feature** almost exactly. A daily cron drives it. Pro+ gated via a new `PlanLimits.recurringPos`. The feature is the time-based sibling of auto-reorder (stock-based).

**Tech Stack:** Next.js App Router, TypeScript, Supabase/Postgres + RLS, Zod, Vitest, Tailwind.

**Spec:** docs/superpowers/specs/2026-06-18-recurring-purchase-orders-design.md (read it first).

## Global Constraints

- **Mirror auto-reorder exactly** where the pattern matches. Reference implementations (study before writing):
  - Settings/gating/money-safety: `apps/web/src/server/services/auto-reorder.ts` (`shouldAutoSend` lines 124-133, fail-closed parsing).
  - PO-creation loop + approval-threshold read + send decision: `apps/web/src/server/services/purchase-orders.ts` `runAutoReorder()` (lines 672-806) — `RecurringPoTemplatesService.runDueTemplates` follows the same per-supplier create→maybe-send→fail-closed shape.
  - Settings server action (gates): `apps/web/src/server/actions/auto-reorder-settings.ts` (MFA fail-closed, `purchase_orders:manage`, module gate, Pro+ effective-plan gate, audit + revalidate).
  - Cron: `apps/web/src/app/api/cron/auto-reorder/route.ts` (CRON_SECRET timing-safe fail-closed, paginated module fetch, per-org system context `role:'owner' mfaSatisfied:true`, per-org fail-open, admin notification).
  - Plan gating: `packages/core/src/constants/plans.ts` (`autoReorder` Pro+) + `packages/core/src/constants/effective-plan.ts` (`planAllowsAutoReorder`).
  - RLS for a new tenant table: `supabase/migrations/0178_restore_points.sql` (admin/member read, service-role write).
- **Money-safety invariants** (the final review enforces these): auto-send requires `send_mode==='send'` AND a non-null cap AND `total <= cap` AND `total < approvalThreshold`; a failed approval-threshold read ⇒ hold as draft (fail-closed). A template fires only when `next_run_at <= now()`, then `next_run_at` advances atomically (no double-fire). Per-org/per-template fail-open in the cron. Paginate every multi-row read. Every query filters `organization_id`.
- **PO line shape** for creation: `{ itemId, quantityOrdered, unitCost }` (see `CreatePoInput` in purchase-orders.ts lines 19-32). `purchase_order_items.line_total` is a GENERATED column — never insert it.
- Next migration number = **0180**. Apply to prod via `supabase db push --linked` after merge.
- No new dependencies. Plain Conventional Commits, **NO `Co-Authored-By` trailer of any kind**.
- Commands from `apps/web`: `pnpm typecheck`, `pnpm lint`, `pnpm test <path>`. Core tests: `pnpm --filter @stockpilot/core test` (or vitest in packages/core).

---

### Task 1: Migration 0180 — recurring_po_templates table

**Files:** Create `supabase/migrations/0180_recurring_po_templates.sql`

**Interfaces:** Produces table `public.recurring_po_templates` (columns per spec) with RLS (member read, service-role write) + the `tg_set_updated_at` trigger.

- [ ] **Step 1: Write the migration**

```sql
-- Recurring purchase-order templates: a supplier + line items + cadence + send
-- rule that the daily /api/cron/recurring-pos turns into a PO each cycle.
create table if not exists public.recurring_po_templates (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations(id) on delete cascade,
  supplier_id             uuid references public.suppliers(id) on delete set null,
  destination_location_id uuid references public.locations(id) on delete set null,
  name                    text not null,
  enabled                 boolean not null default true,
  cadence                 text not null check (cadence in ('weekly','biweekly','monthly','quarterly','custom')),
  custom_days             integer check (custom_days is null or (custom_days between 1 and 365)),
  send_mode               text not null default 'draft' check (send_mode in ('draft','send')),
  max_auto_send_cents     numeric(14,4),
  line_items              jsonb not null default '[]'::jsonb,
  notes                   text,
  last_run_at             timestamptz,
  next_run_at             timestamptz not null,
  created_by              uuid references public.user_profiles(id) on delete set null,
  updated_by              uuid references public.user_profiles(id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (organization_id, name)
);

create index if not exists recurring_po_templates_due_idx
  on public.recurring_po_templates(organization_id, next_run_at) where enabled;

create trigger recurring_po_templates_set_updated_at
  before update on public.recurring_po_templates
  for each row execute function public.tg_set_updated_at();

alter table public.recurring_po_templates enable row level security;

-- READ: any org member (list page). WRITE: service-role only (gated actions + cron).
create policy recurring_po_templates_select on public.recurring_po_templates
  for select to authenticated
  using ((select public.is_org_member(organization_id)));

grant select on public.recurring_po_templates to authenticated;
```

(Confirm the trigger function is named `public.tg_set_updated_at` — check a recent migration that attaches it, e.g. 0007/0178; match the exact name/signature. Confirm `public.is_org_member(uuid)` is the helper used by other RLS select policies.)

- [ ] **Step 2: Validate locally**

Run: `cd /Users/brandenvincent-walker/Developer/InventorySystem && supabase db reset` is heavy — instead, validate SQL by applying against the local stack if available (`supabase db push --local`) OR review against 0178's structure. Expected: no syntax error; table + policy + index + trigger created.
(If the local Docker stack isn't running, note that and rely on the pgTAP/review gate; do NOT push to prod here — that happens post-merge.)

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0180_recurring_po_templates.sql
git commit -m "feat(recurring-pos): migration 0180 — recurring_po_templates table + RLS"
```

---

### Task 2: Core — plan gating + pure cadence helpers

**Files:**
- Modify: `packages/core/src/constants/plans.ts` (+ the PlanLimits interface) and `packages/core/src/constants/effective-plan.ts`
- Create: `packages/core/src/purchasing/recurring.ts`
- Test: `packages/core/src/purchasing/recurring.test.ts`

**Interfaces:**
- Produces: `PlanLimits.recurringPos: boolean`; `planAllowsRecurringPos(org, now?): boolean`; `nextRunAt(cadence: Cadence, from: Date, customDays?: number): Date` where `Cadence = 'weekly'|'biweekly'|'monthly'|'quarterly'|'custom'`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/purchasing/recurring.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { nextRunAt } from './recurring';

const base = new Date('2026-06-18T07:00:00.000Z');

describe('nextRunAt', () => {
  it('weekly = +7 days', () => {
    expect(nextRunAt('weekly', base).toISOString()).toBe('2026-06-25T07:00:00.000Z');
  });
  it('biweekly = +14 days', () => {
    expect(nextRunAt('biweekly', base).toISOString()).toBe('2026-07-02T07:00:00.000Z');
  });
  it('monthly = +1 month', () => {
    expect(nextRunAt('monthly', base).toISOString()).toBe('2026-07-18T07:00:00.000Z');
  });
  it('quarterly = +3 months', () => {
    expect(nextRunAt('quarterly', base).toISOString()).toBe('2026-09-18T07:00:00.000Z');
  });
  it('custom uses customDays', () => {
    expect(nextRunAt('custom', base, 10).toISOString()).toBe('2026-06-28T07:00:00.000Z');
  });
  it('custom falls back to weekly when customDays missing/invalid', () => {
    expect(nextRunAt('custom', base).toISOString()).toBe('2026-06-25T07:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run it — verify it fails** — `cd apps/web && npx vitest run ../../packages/core/src/purchasing/recurring.test.ts` (or the core test runner). Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

Create `packages/core/src/purchasing/recurring.ts`:

```ts
export type RecurringCadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'custom';

/** Compute the next run timestamp from a base date. Pure (no Date.now). */
export function nextRunAt(cadence: RecurringCadence, from: Date, customDays?: number): Date {
  const d = new Date(from.getTime());
  switch (cadence) {
    case 'weekly':
      d.setUTCDate(d.getUTCDate() + 7);
      return d;
    case 'biweekly':
      d.setUTCDate(d.getUTCDate() + 14);
      return d;
    case 'monthly':
      d.setUTCMonth(d.getUTCMonth() + 1);
      return d;
    case 'quarterly':
      d.setUTCMonth(d.getUTCMonth() + 3);
      return d;
    case 'custom': {
      const days = Number.isInteger(customDays) && (customDays as number) >= 1 ? (customDays as number) : 7;
      d.setUTCDate(d.getUTCDate() + days);
      return d;
    }
  }
}
```

Export it from the core package index if the package uses a barrel (`packages/core/src/index.ts`) — follow how `effective-plan`/auto-reorder helpers are exported.

- [ ] **Step 4: Add the plan limit**

In `packages/core/src/constants/plans.ts`: add `recurringPos: boolean;` to the `PlanLimits` interface and set it per tier exactly like `autoReorder` (free=false, pro/business/enterprise=true). In `packages/core/src/constants/effective-plan.ts`: add `planAllowsRecurringPos(org, now?)` mirroring `planAllowsAutoReorder` (return `PLANS[resolveEffectivePlan(org, now).tier].limits.recurringPos`). Add a test mirroring the existing effective-plan tests (free=false, pro=true).

- [ ] **Step 5: Run tests — verify pass.** `nextRunAt` (6 tests) + the plan-limit test green.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/purchasing/recurring.ts packages/core/src/purchasing/recurring.test.ts packages/core/src/constants/plans.ts packages/core/src/constants/effective-plan.ts packages/core/src/index.ts
git commit -m "feat(recurring-pos): core plan limit + nextRunAt cadence helper"
```

---

### Task 3: Service — RecurringPoTemplatesService

**Files:**
- Create: `apps/web/src/server/services/recurring-pos.ts`
- Test: `apps/web/src/server/services/recurring-pos.test.ts`

**Interfaces:**
- Consumes: `nextRunAt`, `planAllowsRecurringPos` (Task 2); `PurchaseOrdersService.create()` + the approval-threshold read + `shouldAutoSend` (purchase-orders.ts / auto-reorder.ts).
- Produces: `RecurringPoTemplatesService` with `list()`, `create(input)`, `update(id,input)`, `setEnabled(id,enabled)`, `remove(id)`, `seedFromPo(poId)`, and `runDueTemplates(now: Date)`. A Zod schema `recurringTemplateSchema` validating `{ name, supplierId?, destinationLocationId?, cadence, customDays?, sendMode, maxAutoSendCents?, lineItems: {itemId,quantityOrdered,unitCost}[], notes?, enabled? }`.

- [ ] **Step 1: Write failing tests** (cover the money-safety + scheduling logic):

```ts
// recurring-pos.test.ts — focus on runDueTemplates decisions + seedFromPo.
// Mirror the style of auto-reorder/runAutoReorder tests if present.
// Cases:
//  - a due template (next_run_at <= now) in send_mode 'draft' → creates a PO left as draft; next_run_at advanced; last_run_at stamped.
//  - send_mode 'send', total <= cap AND < approvalThreshold → PO sent (ordered).
//  - send_mode 'send', total > cap → held as draft.
//  - send_mode 'send', total >= approvalThreshold → held as draft.
//  - approval-threshold read fails → held as draft (fail-closed).
//  - not-yet-due template (next_run_at > now) → skipped, not created, next_run_at unchanged.
//  - seedFromPo copies supplier_id + lines ({itemId,quantityOrdered,unitCost}) from an existing PO.
// Use the existing service test harness/mocks (see purchase-orders / auto-reorder tests for the ctx + supabase mock pattern).
```
Write concrete tests following the repo's existing service-test mock pattern (study `auto-reorder` / `purchase-orders` tests for how `ServiceContext` + the supabase client are mocked).

- [ ] **Step 2: Run — verify fail** (module missing).

- [ ] **Step 3: Implement** `recurring-pos.ts`:
  - `list()`: paginated select of templates for the org (RLS-scoped), gated `purchase_orders` module + `purchase_orders:manage`.
  - `create/update/setEnabled/remove`: validate with Zod; on create compute initial `next_run_at = nextRunAt(cadence, now, customDays)` (or accept a startAt); write via the **ctx client** (RLS). Gate module + permission. `created_by/updated_by` stamped.
  - `seedFromPo(poId)`: read the PO + its items (org-scoped, fail-closed), return a template draft payload `{ supplierId, destinationLocationId, lineItems: items.map(i => ({itemId:i.item_id, quantityOrdered:i.quantity_ordered, unitCost:i.unit_cost})) }` (does NOT persist — the UI opens the create form pre-filled).
  - `runDueTemplates(now)`: paginated select of `enabled && next_run_at <= now` for the org; for each: build `CreatePoInput` from `line_items`, call `new PurchaseOrdersService(ctx).create(...)`, then read the approval threshold (same as `runAutoReorder` lines 750-771; fail-closed `sendBlocked=true` on read error), and if `send_mode==='send' && shouldAutoSend(total, capDollars, threshold) && !sendBlocked` call `updateStatus(po.id,'ordered')`; advance `next_run_at = nextRunAt(cadence, next_run_at, customDays)` and stamp `last_run_at`; return a summary `{created, sent, heldForReview, failures}`. Per-template try/catch (fail-open).

- [ ] **Step 4: Run tests — verify pass** (all decision cases green).

- [ ] **Step 5: typecheck + lint + commit**

```bash
git add apps/web/src/server/services/recurring-pos.ts apps/web/src/server/services/recurring-pos.test.ts
git commit -m "feat(recurring-pos): RecurringPoTemplatesService (CRUD + seedFromPo + runDueTemplates)"
```

---

### Task 4: Server actions (gated CRUD)

**Files:**
- Create: `apps/web/src/server/actions/recurring-pos.ts`
- Test: `apps/web/src/server/actions/recurring-pos.test.ts`

**Interfaces:**
- Consumes: `RecurringPoTemplatesService` (Task 3), `planAllowsRecurringPos` (Task 2).
- Produces: `createRecurringTemplateAction`, `updateRecurringTemplateAction`, `setRecurringTemplateEnabledAction`, `deleteRecurringTemplateAction`, `seedRecurringTemplateFromPoAction`.

- [ ] **Step 1: Write failing tests** — mirror `auto-reorder-settings.test.ts`: plan-gate blocks Free (return an error result, no write); MFA-gate fail-closed; permission-gate (`purchase_orders:manage`); happy path calls the service + revalidates. Use the existing action-test harness.

- [ ] **Step 2: Run — verify fail.**

- [ ] **Step 3: Implement** — copy the gating sequence from `auto-reorder-settings.ts` verbatim (MFA → permission → module → Pro+ effective-plan via `planAllowsRecurringPos`), call the service, `audit(...)`, `revalidatePath('/dashboard/purchase-orders/recurring')`. Return the repo's standard action result shape (`ok/err`).

- [ ] **Step 4: Run tests — pass.**

- [ ] **Step 5: typecheck + lint + commit**

```bash
git add apps/web/src/server/actions/recurring-pos.ts apps/web/src/server/actions/recurring-pos.test.ts
git commit -m "feat(recurring-pos): gated server actions for template CRUD"
```

---

### Task 5: Daily cron

**Files:**
- Create: `apps/web/src/app/api/cron/recurring-pos/route.ts`
- Modify: `apps/web/vercel.json`

**Interfaces:** Consumes `RecurringPoTemplatesService.runDueTemplates` (Task 3).

- [ ] **Step 1: Implement the route** — copy `auto-reorder/route.ts` structure exactly: `runtime='nodejs'`, `dynamic='force-dynamic'`, `maxDuration=60`; timing-safe `CRON_SECRET` Bearer check (fail-closed → 401); paginated fetch of orgs with `purchase_orders` module enabled; per-org Pro+ filter via `planAllowsRecurringPos`; per-org system context (`role:'owner', mfaSatisfied:true`, service-role client + enabled modules); call `new RecurringPoTemplatesService(ctx).runDueTemplates(new Date())`; per-org try/catch + `reportError`; aggregate + admin notification (mirror auto-reorder's notify). Return JSON summary.

- [ ] **Step 2: Register in vercel.json** — add `{ "path": "/api/cron/recurring-pos", "schedule": "0 7 * * *" }` to the `crons` array (valid JSON; 07:00 UTC, before auto-reorder's 08:00).

- [ ] **Step 3: typecheck + lint** — green. (Cron route logic is covered by the service tests in Task 3; the route is thin glue.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/api/cron/recurring-pos/route.ts apps/web/vercel.json
git commit -m "feat(recurring-pos): daily cron to create POs from due templates"
```

---

### Task 6: UI — management page + "Make recurring" + nav

**Files:**
- Create: `apps/web/src/app/(dashboard)/dashboard/purchase-orders/recurring/page.tsx` + a client form/list component under `apps/web/src/components/po/` (e.g. `recurring-templates-panel.tsx`).
- Modify: the PO detail page (`apps/web/src/app/(dashboard)/dashboard/purchase-orders/[id]/page.tsx`) to add a "Make recurring" button (calls `seedRecurringTemplateFromPoAction` → navigates to the recurring page with the seed prefilled). Add a nav entry (study how the Reorder Planning / purchase-orders nav links are registered).

- [ ] **Step 1: Page (server component)** — Pro+ gate (read effective plan via the same helper the planning page uses; show an upgrade prompt if not allowed), load templates via the service, render the client panel. Mirror `apps/web/src/app/(dashboard)/dashboard/planning/page.tsx` for the gate + data-load shape.

- [ ] **Step 2: Client panel** — list templates (name, supplier, cadence, next run, send mode, enabled toggle) + a create/edit form (supplier picker, line-item editor — reuse the PO line UX, cadence select, send-mode + cap input). Wire to the Task 4 actions. Follow `auto-reorder-panel.tsx` for the form/gate style.

- [ ] **Step 3: "Make recurring" button** on the PO detail page → server action seed → open the form prefilled.

- [ ] **Step 4: Nav entry** for "Recurring" under Purchase orders.

- [ ] **Step 5: typecheck + lint + a focused render/interaction test** for the panel (toggle enabled calls the action; form submit validates). Then **full suite** `pnpm test` once — green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/(dashboard)/dashboard/purchase-orders/recurring apps/web/src/components/po "apps/web/src/app/(dashboard)/dashboard/purchase-orders/[id]/page.tsx" <nav file>
git commit -m "feat(recurring-pos): management page, Make-recurring button, nav"
```

---

### Task 7: Full verification + money-safety review

- [ ] **Step 1:** `cd apps/web && pnpm typecheck && pnpm lint && pnpm test` and the core package tests — all green, pristine.
- [ ] **Step 2:** `pnpm build` — succeeds (new route + page compile).
- [ ] **Step 3:** A dedicated **money-safety review** (separate reviewer) over the whole branch, enforcing the spec's invariants: auto-send bounded by cap AND approval threshold; threshold-read failure ⇒ draft; no double-fire (`next_run_at` advances atomically, only fires when due); per-org/template fail-open; pagination on all reads; tenant-scoping on every query; RLS write-restricted to service-role. Fix any Critical/Important findings, re-review.
- [ ] **Step 4:** Apply migration **0180** to prod (`supabase db push --linked`) AFTER merge, then finish the branch.

## Self-Review

- **Spec coverage:** table+RLS (T1), Pro+ gating + cadence (T2), service incl. seedFromPo + runDueTemplates money-safety (T3), gated actions (T4), cron (T5), UI + Make-recurring + nav (T6), verification + money-safety review + migration (T7). ✓
- **Placeholder scan:** novel code (migration SQL, nextRunAt, table) is concrete; mirror-parts reference exact auto-reorder file:line (legitimate "follow existing patterns" in an existing codebase, not placeholders). Implementers must read the referenced precedent.
- **Type consistency:** `RecurringCadence`, `nextRunAt`, `planAllowsRecurringPos`, `runDueTemplates`, `seedFromPo`, line shape `{itemId,quantityOrdered,unitCost}`, `send_mode`/`max_auto_send_cents` used consistently across tasks.
