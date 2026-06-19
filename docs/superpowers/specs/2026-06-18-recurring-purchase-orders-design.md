# Recurring Purchase Orders — Design

- **Date:** 2026-06-18
- **Status:** Draft (pending approval)
- **Surface:** Web dashboard (admin-facing). No mobile screen (desktop-admin surface, like auto-reorder/reorder-planning).

## Summary

Let an org define a **recurring PO template** — a supplier + line items + a cadence + a send rule — that a daily cron turns into a real purchase order each cycle. Draft-for-review by default, with opt-in auto-send bounded by a $ cap (mirroring the shipped **auto-reorder** money-safety pattern). A template can be **seeded from an existing PO** in one click. This is the time-based sibling of auto-reorder (which is stock-based): standing orders for things you buy on a schedule.

## Goals

- Admins create/edit/enable/disable recurring PO templates (supplier, destination, line items, cadence, send rule).
- A daily cron creates a PO from each **due** template, advancing the schedule.
- Money safety: draft by default; auto-send only when explicitly enabled AND the PO total is within the configured cap AND within the org's PO approval threshold (reuse the exact auto-reorder gating).
- Seed a template from an existing PO (copy supplier + lines).
- Pro+ gated (matches auto-reorder).

## Non-goals

- No per-line price syncing from supplier catalogs (prices are explicit on the template; editable).
- No mobile UI (desktop-admin surface).
- No stock-based triggering — that's auto-reorder. These compose but are separate.
- No approval workflow beyond the existing PO approval threshold.

## Decisions (chosen)

- **Model:** a new `recurring_po_templates` table (migration **0180**) — queryable, RLS-scoped, audit-friendly. Line items live in a `line_items` jsonb column (shape matches `CreatePoInput.lines`: `{itemId, quantityOrdered, unitCost}[]`), so the cron needs no join. (Mirrors how restore_points/auto-reorder model their data.)
- **Gating:** Pro+ via a new `PlanLimits.recurringPos` (true for pro/business/enterprise), resolved on the **effective** plan (`planAllowsRecurringPos`), exactly like `autoReorder`. Also requires the `purchase_orders` module enabled + `purchase_orders:manage` permission.
- **Send rule:** per-template `send_mode` (`'draft' | 'send'`) + nullable `max_auto_send_cents`. Auto-send fires only when `send_mode==='send'` AND `shouldAutoSend(total, capDollars, approvalThreshold)` (reuse auto-reorder's helper) AND the approval-threshold read succeeded (fail-closed to draft, like `runAutoReorder`).
- **Cadence:** `'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'custom'`; `custom_days int` for custom. Stored with `next_run_at timestamptz` (the schedule anchor) + `last_run_at`. `next_run_at` advancement is the dedup mechanism — a template fires only when `next_run_at <= now()`, then advances by the cadence, so a double cron tick can't double-fire.
- **Cron:** new `/api/cron/recurring-pos`, daily at `0 7 * * *` UTC. Same CRON_SECRET fail-closed auth + per-org fail-open loop + system-context pattern as `/api/cron/auto-reorder`. Notifies admins with a summary (created/sent/heldForReview/failures).

## Data model — migration 0180

```sql
create table public.recurring_po_templates (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations(id) on delete cascade,
  supplier_id             uuid references public.suppliers(id) on delete set null,
  destination_location_id uuid references public.locations(id) on delete set null,
  name                    text not null,
  enabled                 boolean not null default true,
  cadence                 text not null check (cadence in ('weekly','biweekly','monthly','quarterly','custom')),
  custom_days             integer check (custom_days is null or custom_days between 1 and 365),
  send_mode               text not null default 'draft' check (send_mode in ('draft','send')),
  max_auto_send_cents     numeric(14,4),
  line_items              jsonb not null default '[]'::jsonb,  -- [{itemId,quantityOrdered,unitCost}]
  last_run_at             timestamptz,
  next_run_at             timestamptz not null,
  notes                   text,
  created_by              uuid references public.user_profiles(id) on delete set null,
  updated_by              uuid references public.user_profiles(id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (organization_id, name)
);
create index recurring_po_templates_due_idx
  on public.recurring_po_templates(organization_id, next_run_at) where enabled;

alter table public.recurring_po_templates enable row level security;
-- READ: org members (so the list page works). WRITE: service-role only (via gated server actions / cron).
create policy recurring_po_templates_select on public.recurring_po_templates
  for select to authenticated using ((select public.is_org_member(organization_id)));
-- updated_at maintained by the existing tg_set_updated_at trigger convention (attach it).
```
(Writes go through the service-role client behind gated server actions — no authenticated write policy, same posture as restore_points.)

## Components / files

**Core (packages/core):**
- `PlanLimits.recurringPos: boolean` (plans.ts: free=false, pro/business/enterprise=true) + `planAllowsRecurringPos(org, now)` (effective-plan.ts), mirroring `autoReorder`.
- Pure cadence helper `nextRunAt(cadence, from, customDays?): Date` + `computeRecurringSendDecision(...)` reuse — unit-tested, deterministic (pass `from` in; no `Date.now()` in core).

**Service (apps/web/src/server/services/recurring-pos.ts):**
- `parseLineItems` / validation (zod), `RecurringPoTemplatesService`: `list()`, `create()`, `update()`, `setEnabled()`, `delete()`, `seedFromPo(poId)` (returns a draft template payload copied from a PO's supplier + lines), and `runDueTemplates(now)` for the cron. `runDueTemplates` reuses `PurchaseOrdersService.create()` + the approval-threshold read + `shouldAutoSend` exactly as `runAutoReorder` does.

**Actions (apps/web/src/server/actions/recurring-pos.ts):**
- CRUD actions: MFA-gate (fail-closed), `purchase_orders:manage` permission, `purchase_orders` module, Pro+ effective-plan gate, audit + revalidate — copied from the auto-reorder-settings action pattern.

**Cron (apps/web/src/app/api/cron/recurring-pos/route.ts):** + `apps/web/vercel.json` entry `{ "path": "/api/cron/recurring-pos", "schedule": "0 7 * * *" }`.

**UI:**
- New page `/dashboard/purchase-orders/recurring` — list templates (name, supplier, cadence, next run, send mode, enabled toggle) + create/edit form (supplier picker, line-item editor reusing PO line UX, cadence select, send-mode + cap). Pro+ gated with an upgrade prompt.
- A **"Make recurring"** button on the PO detail page (`/dashboard/purchase-orders/[id]`) → opens the create form pre-filled via `seedFromPo`.
- Nav: a "Recurring" link/sub-entry under Purchase orders.

## Money-safety invariants (the review will check these)

1. Auto-send never unbounded: `send_mode==='send'` requires a non-null cap AND total ≤ cap AND total < approval threshold; threshold-read failure ⇒ hold as draft (fail-closed).
2. No double-fire: a template only runs when `next_run_at <= now()`, then `next_run_at` advances immediately; `last_run_at` stamped. Cron is idempotent within a day.
3. Per-org fail-open in the cron: one org/template error is reported and skipped, never blocks others.
4. Pagination: the cron pages through due templates and through any multi-row reads (no 1000-row cap).
5. Tenant-scoped: every read/write filters `organization_id`; RLS read = org member, writes service-role-only.

## Testing

- Core: `nextRunAt` for each cadence + custom; send-decision gating (cap, threshold, fail-closed).
- Service: `runDueTemplates` creates a draft when send_mode='draft'; auto-sends within cap+threshold; holds when over cap / over threshold / threshold-read-fails; advances next_run_at; skips not-yet-due; `seedFromPo` copies supplier+lines.
- Action: plan-gate blocks Free; MFA-gate; permission-gate.
- Cron: CRON_SECRET fail-closed; per-org fail-open.

## Rollout

- Migration 0180 applied to prod after merge (per the migrations-are-my-job rule). Table is INERT until an org creates a template (no behavior change for existing orgs). Pro+ only.
