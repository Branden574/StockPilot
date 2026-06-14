# Automatic Reordering — Design

**Date:** 2026-06-14
**Status:** Approved (brainstorm), implementation in phases
**Tier gate:** Pro and above (Free excluded), on the EFFECTIVE plan.

## Goal

When an item drops to/below its reorder point, StockPilot automatically creates a purchase order to replenish it — either as a draft for review or auto-sent — on a daily schedule, without anyone having to watch stock levels. Built for "set it and forget it" replenishment (the watermelon-seeds case: below 50 → order 100).

## Decisions (from brainstorm)

- **Per-org choice:** off by default; mode = `draft` (create draft PO + notify) or `send` (create + mark ordered). Optional **auto-send $ cap** — a supplier PO over the cap falls back to a draft even in send mode.
- **Daily** scheduled scan (not hourly/real-time).
- **Tier-gated: Pro+** — Free tier cannot enable it (checked on the effective plan, so Comped/override orgs qualify).
- **Dedup is mandatory:** an item already on an OPEN PO (draft or ordered) is skipped, so a daily run never double-orders.
- Respects the existing **PO approval thresholds** — a PO over the approval limit stays pending approval rather than auto-sending.

## Data model

No new tables. Two additions:

1. **`PlanLimits.autoReorder: boolean`** (packages/core/src/constants/plans.ts) — `false` for free, `true` for pro/business/enterprise. The entitlement flag.
2. **Per-org settings** in `organization_modules.settings` for the `purchase_orders` module (jsonb, no migration — same pattern as planning-settings):
   ```
   autoReorder: {
     enabled: boolean,            // default false
     mode: 'draft' | 'send',      // default 'draft'
     maxAutoSendCents: number|null // optional cap; over it → draft
   }
   ```

## Components

- **Settings action** `apps/web/src/server/actions/auto-reorder-settings.ts` — validate → withContext → MFA fail-closed gate → manage gate (`purchase_orders:manage`) → module-enabled gate → **plan gate** (effective tier's `autoReorder` flag; else `plan_limit_exceeded` "Upgrade to Pro") → merge into `organization_modules.settings` → audit → revalidate. (Mirrors planning-settings.ts exactly.)
- **Engine** — a new `PurchaseOrdersService.runAutoReorder()` that:
  1. recomputes the below-par set (reuses the `createDraftsFromReorderForecast` math: active, non-deleted, non-rental, reorder_point > 0, qty ≤ reorder point, paginated);
  2. **excludes items already on an open PO** — load `purchase_order_lines` for POs with status in (`draft`,`ordered`) for the org, build a `Set<itemId>`, skip those (the dedup);
  3. groups remaining by supplier; **skips no-supplier items** for auto-send;
  4. creates one PO per supplier; in `send` mode + under cap + under approval threshold → transitions to `ordered` (publishes the existing `purchase_order.ordered` outbox event); else leaves draft;
  5. returns a summary (created, sent, drafted, skippedDuplicate, skippedNoSupplier).
- **Cron** `apps/web/src/app/api/cron/auto-reorder/route.ts` — CRON_SECRET-gated; iterates orgs with the `purchase_orders` module enabled AND `autoReorder.enabled` AND effective plan ≥ pro; runs the engine per org in a USER-equivalent service context (service-role admin client scoped per org, like the drainer); fires a notification + integration event per org that reordered; fail-open per org (one org's error never blocks the rest). Daily schedule added to the Vercel cron config.
- **Settings UI** — a panel on the Reorder Planning page: Pro+ orgs see the On/Off + mode + cap controls; Free orgs see an "Upgrade to Pro to enable automatic reordering" notice.
- **Notification** — reuse the existing notification/integration-event engine: a `po.auto_created` style alert ("Auto-reorder created N POs across M suppliers").

## Build phases (each shippable + committed)

- **Phase 1 — entitlement + settings:** `PlanLimits.autoReorder` flag (+ tests), settings action (plan/module/perm gated), settings UI panel on Reorder Planning.
- **Phase 2 — dedup engine:** `runAutoReorder()` with open-PO dedup + supplier grouping + mode/cap/threshold logic + unit tests for dedup and mode/cap.
- **Phase 3 — cron + notifications:** daily cron endpoint, per-org iteration (tier+enabled filter), notification/event on reorder, Vercel cron schedule.

## Testing / safety bar

- Plan gate: a Free-tier org cannot enable auto-reorder (action returns upgrade error) and is skipped by the cron.
- Dedup: an item already on an open draft/ordered PO is never re-ordered on the next run (the core no-double-order guarantee).
- Mode/cap: `send` over the cap or over the approval threshold falls back to draft/pending, never silently auto-sends.
- No-supplier items are skipped for auto-send and disclosed in the summary.
- Cron is CRON_SECRET-gated and fail-open per org.
- tsc + eslint clean; full web + core suites green.
