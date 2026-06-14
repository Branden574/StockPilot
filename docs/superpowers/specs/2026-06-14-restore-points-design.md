# Restore Points (Inventory Backups) — Design

**Date:** 2026-06-14
**Status:** Approved (brainstorm), implementation in phases
**Tier gate:** Business and above (effective plan).

## Goal

Give an org point-in-time snapshots of its inventory it can roll back to after corruption, a bad bulk edit, or a hack. Snapshots are taken on demand and daily; restoring safely reconciles current inventory back to the snapshot, and is itself undoable.

## Decisions (from brainstorm)

- **Scope:** inventory + stock — items (name/sku/barcode/description/cost/price/on-hand qty/reorder point+qty/unit/status/type) + their category / supplier / location **by name** (so restore can re-create deleted ones). NOT orders/POs/movements.
- **Restore = safe reconcile:** reset items + quantities to the snapshot, re-create deleted items, **auto-snapshot current state first** (undoable), quantity changes post as **ledger movements** (audit stays correct), items absent from the snapshot are **flagged but never auto-deleted**. Owner/admin + **MFA step-up** + **typed-name confirmation**.
- **Tier:** Business+ (new `PlanLimits.restorePoints` flag; false free/pro, true business/enterprise), checked on the effective plan in the action, cron, and UI.

## Data model

Migration `0178_restore_points.sql`:
- `restorePoints` flag added to `PlanLimits` (packages/core).
- Table `public.restore_points`:
  - `id uuid pk`, `organization_id uuid not null fk`, `created_at timestamptz`, `created_by uuid fk null`,
  - `kind text` check in (`manual`,`auto`,`pre_restore`),
  - `label text` (optional note),
  - `item_count int not null`,
  - `capped boolean not null default false` (true when the snapshot hit the item cap),
  - `snapshot jsonb not null` — `{ version:1, items:[...], capturedAt }`,
  - index `(organization_id, created_at desc)`.
  - RLS ON: a SELECT policy for org members (`is_org_member`) on the metadata; all writes + the snapshot-blob restore read go through gated server actions (service-role). The list query never returns the `snapshot` blob (metadata only); only restore reads it.

**Disclosed cap:** `SNAPSHOT_ITEM_CAP = 50_000` items per snapshot; over it, `capped=true` and the UI says so.

## Components

- **`packages/core` flag + helper:** `PlanLimits.restorePoints` + `planAllowsRestorePoints(org)` (effective plan, mirrors `planAllowsAutoReorder`).
- **Service `server/services/restore-points.ts`:**
  - `createSnapshot(ctx, { kind, label? })` — gates (Business+, owner/admin, module), paginates all items + joins category/supplier/location names, builds the jsonb, inserts a `restore_points` row, prunes to retention. Returns the new id + counts.
  - `listSnapshots(ctx)` — metadata only (no blob).
  - `restoreSnapshot(ctx, id)` — the safe-reconcile (Phase 2).
  - `pruneSnapshots(admin, orgId)` — keep newest `RETENTION = 30`.
- **Actions `server/actions/restore-points.ts`:** `createRestorePointAction(label?)`, `restoreFromPointAction({ id, confirmName })` (MFA step-up + typed-name match).
- **Cron `app/api/cron/restore-points/route.ts`:** daily; for every Business+ org with the inventory module, take an `auto` snapshot + prune. CRON_SECRET-gated, fail-open per org, paginated org list.
- **UI:** Settings → **Backups & restore** (`/dashboard/settings/restore-points`, owner/admin): "Create restore point" button, snapshot list (date/kind/label/item count), per-row **Restore** with a preview + typed-name confirm dialog. Business-gated (Pro/Free see an upgrade notice).

## Restore (safe reconcile) — algorithm

1. Gate: Business+ + owner/admin + MFA AAL2 + `confirmName` equals the snapshot's display name.
2. **Auto-snapshot now** as `kind='pre_restore'` (so the restore is undoable).
3. Load the target snapshot blob.
4. Ensure referenced categories/suppliers/locations exist (create missing by name; map name→id).
5. For each snapshot item (keyed by `sku`): if it exists (incl. soft-deleted) → update fields to snapshot values, un-delete if needed, and **reset quantity by posting an adjustment movement** to the snapshot qty (ledger-correct). If absent → create it (movement-correct initial qty).
6. Items present now but NOT in the snapshot → **flagged in the result** (`extras`), never auto-deleted.
7. Return a summary: `updated`, `recreated`, `quantityAdjusted`, `extrasFlagged`, plus the `preRestoreId`.

## Build phases (each shippable + committed)

1. **Snapshot + list:** migration + plan flag, `createSnapshot`/`listSnapshots`/`pruneSnapshots`, create action, Backups page + list UI (Business-gated). 
2. **Restore:** `restoreSnapshot` safe-reconcile + restore action (MFA + typed confirm) + preview/confirm UI.
3. **Daily auto-snapshot cron** + retention + Vercel schedule.

## Testing / safety bar

- Tier gate: Free/Pro orgs cannot create/restore (action + cron + UI); Business+ can.
- Snapshot round-trips: capture → restore reproduces item fields + quantities; deleted items are re-created.
- Restore is undoable: a `pre_restore` snapshot is always written first.
- Quantity changes go through movements (no silent count edits); audit row per restore.
- Extras are never auto-deleted (reported only).
- Disclosed cap honored; retention prunes to 30.
- tsc + eslint clean; core + web suites green.
