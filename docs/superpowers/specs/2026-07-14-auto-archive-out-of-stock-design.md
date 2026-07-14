# Auto-Archive Inventory Items When Out of Stock — Design

**Status:** Approved (owner chose: 7-day dwell, auto-restore on restock, full mobile UI) — 2026-07-14
**Scope:** One shippable feature, web + mobile. Independent of the Movement/Activity audit overhaul.

## Goal

A per-organization toggle: when an inventory item has been out of stock
(`quantity_on_hand <= 0`) continuously for a configurable grace period
(default 7 days), the system archives it. Restocking auto-restores items the
system archived. Default **off** (opt-in); admin-gated. Never touches
manually-archived or discontinued items.

## Owner decisions (locked)

1. **Timing:** grace period, default **7 days** at zero, org-configurable (not instant).
2. **Reversal:** restocking **auto-restores** — but only items the system auto-archived.
3. **Mobile:** ship the **full mobile archived + restore UI** in this cut (no silent vanish).

## Key facts about the existing system (from context map)

- **Archive = `inventory_items.status`** (text, check-constrained `active|archived|discontinued`). There is no `is_archived` boolean. `InventoryService.archive()` sets `status='archived'`. Restore = `status='active'` (via `bulkUpdate({op:{kind:'unarchive'}})`).
- **`archived_at` is auto-managed** by BEFORE trigger `tg_inventory_set_archived_at` (mig 0184): stamped on transition to archived, cleared on transition away. It is the clock for the existing auto-delete-archived retention cron. **Never write `archived_at` directly.**
- **Out of stock = `quantity_on_hand <= 0`** — a materialized total on `inventory_items` (NOT a live sum of `item_stock_levels`). This is the same number every other surface uses (dashboard, low-stock trigger 0091).
- **Per-org settings live in `organization_modules.settings` jsonb** under `module_id='inventory'` (the `autoDeleteArchived` toggle already lives here). No schema migration needed for the setting itself.
- **`transfer_stock` is net-zero on `quantity_on_hand`** (moves between `item_stock_levels` only) — rack-to-rack relocation correctly must NOT trip auto-archive.
- **Stock RPCs (`adjust_stock`, etc.) are `grant execute ... to authenticated`** — any client can call them, so an app-layer TypeScript guard is bypassable. A DB trigger is not.

## Architecture

Three cooperating pieces. Because of the dwell requirement, **archiving happens
in a daily cron**, while two lightweight triggers maintain the state the cron
reads and provide instant restore.

### 1. Data model (migration `02NN_auto_archive_out_of_stock.sql`)

Add to `inventory_items`:
- `zero_since timestamptz` — when on-hand last crossed to `<= 0`. `NULL` when in stock.
- `auto_archived boolean not null default false` — true only when the system auto-archived this row.

Index for the cron scan (partial, tiny):
```sql
create index inventory_items_auto_archive_idx
  on public.inventory_items (organization_id, zero_since)
  where status = 'active' and auto_archived = false and zero_since is not null;
```

Per-org setting (stored in `organization_modules.settings`, no column):
```jsonc
"autoArchiveOnZeroStock": { "enabled": false, "dwellDays": 7 }
```

### 2. Trigger A — `BEFORE UPDATE OF quantity_on_hand` — maintain `zero_since`

Pure `NEW` mutation, no status change (so it never interacts with the 0184
`archived_at` trigger, and never recurses):
```sql
if old.quantity_on_hand > 0 and new.quantity_on_hand <= 0 then
  new.zero_since := now();
elsif old.quantity_on_hand <= 0 and new.quantity_on_hand > 0 then
  new.zero_since := null;
end if;
-- otherwise leave zero_since unchanged (staying at/below zero keeps the clock)
```
Runs for every org (cheap, unconditional). **Elegant consequence:** a brand-new
item created at `quantity_on_hand = 0` never had a positive→zero *crossing*, so
its `zero_since` stays `NULL` and it is naturally excluded from auto-archive.

### 3. Trigger B — `AFTER UPDATE OF quantity_on_hand` — instant restore on restock

On a crossing back above zero, revive only system-archived items via a guarded
self-`UPDATE` (an AFTER trigger can't mutate `NEW`):
```sql
if old.quantity_on_hand <= 0 and new.quantity_on_hand > 0 then
  update public.inventory_items
     set status = 'active', auto_archived = false
   where id = new.id and status = 'archived' and auto_archived = true;
end if;
```
The self-`UPDATE` changes `status` (not `quantity_on_hand`), so it does NOT
re-fire Trigger A/B or the low-stock trigger (their column lists are
`quantity_on_hand`/`reorder_point` only), and it DOES fire 0184 which clears
`archived_at`. Restore is **not** gated on the org toggle — reviving a restocked
item is the safe direction and prevents stranding if the toggle was later turned off.

### 4. Cron — `/api/cron/auto-archive-zero-stock` (daily)

Mirrors the proven `auto-delete-archived` cron (CRON_SECRET route, `buildSystemContext`
owner/admin attribution, per-org fail-open, batch limit + truncated flag). For each
org with `autoArchiveOnZeroStock.enabled = true`, archive items where ALL hold:
- `status = 'active'` and `auto_archived = false`
- `quantity_on_hand <= 0`
- `zero_since is not null and zero_since < now() - (dwellDays || ' days')::interval`
- `item_type <> 'rental'` (rentals legitimately sit at zero while checked out)
- **no active reservations**: `not exists (select 1 from stock_reservations r where r.item_id = i.id and r.released_at is null)`

Action per eligible item: `update ... set status='archived', auto_archived=true`
(0184 stamps `archived_at`; retention cron then applies as usual). Audit
`inventory.item.archived` with `extra.reason = 'auto_zero_stock'`. Emit one
per-user-muteable notification (0265 pattern, single AFTER-INSERT broadcast path).
Batch-capped; log truncation.

## Per-org setting: read / write / UI

- **Read** (cron + settings page): `organization_modules.settings #>> '{autoArchiveOnZeroStock,enabled}'` with a tolerant zod parse falling back to `{enabled:false, dwellDays:7}` (mirror `parseAutoDeleteArchivedSettings` in `archive-cleanup.ts`).
- **Write:** a server action mirroring `inventory-cleanup-settings.ts` — `withContext` → MFA gate (fail closed) → permission gate `items:update` (archive is reversible, unlike delete) → module-enabled gate → **merge** into settings jsonb (`{ ...prev, autoArchiveOnZeroStock: next }`, never clobber sibling keys) → audit → `revalidatePath`. Fail closed on a 0-row update.
- **Web UI:** a new panel beside `ArchiveCleanupPanel` on `/dashboard/settings/inventory-cleanup`: an on/off switch + a "days at zero" number input (min 1). Optional nicety: show a live "N items are currently eligible" preview count.

## Web surfacing (mostly exists)

- Archived view (`?status=archived`), bulk Restore, and edit-form status field already work — no change.
- **Add:** an "Auto-archived" badge + filter in the Archived view so owners can tell system vs manual archives (reads `auto_archived`).
- **Add:** the notification above.
- **Small adjacent fixes** (in scope): the bulk `unarchive` path logs a generic `inventory.item.updated` instead of `inventory.item.restored`; add the 'restored' icon to the item Activity feed; update the stale Items-list "restore by editing status" copy to point at Restore.

## Mobile (blocking parity — build in this cut)

Today mobile hardcodes `.eq('status','active')` on the Items and Books tabs and the
offline snapshot, and item detail shows no archived state. Add:
1. **Archived filter/toggle** on mobile Items + Books tabs (show archived on demand).
2. **"Archived" / "Auto-archived" badge** on `app/item/[id].tsx`.
3. **Restore action** calling the existing `bulkUpdateInventoryAction` `unarchive` path via the Bearer `/api/v1` layer (1-element id array — no new service method).

Ship via `pnpm release:ota`; boot the iOS simulator and hand-test archive→restore; walk Demo Co web + mobile.

## Edge cases handled

- **New never-stocked item at 0** → `zero_since` NULL → excluded (no crossing).
- **Reserved-but-unfulfilled** (approved-unpicked order / open rental) → reservation EXISTS check blocks archive.
- **Transient/racy zero** (two independent `adjust_stock`, restock-PO in flight) → the dwell window absorbs it; transfers are net-zero and never fire.
- **Discontinued** items → guard is `status='active'` only.
- **Cycle-count mass-zero** (dozens of SKUs in one `post_cycle_count`) → contained by dwell + reservation/`zero_since` guards; cron is batch-capped.
- **Recursion/self-fire** → status-only self-UPDATE can't re-fire the `OF quantity_on_hand` triggers.
- **First deploy** → no retroactive mass-archive: only items that cross to zero *after* the trigger ships (and dwell) become eligible; items already at zero have `zero_since` NULL until they next cross.

## Testing

- **pgTAP** for both triggers (zero_since set/clear on crossings; instant restore only for `auto_archived=true`; no restore of manual archives; net-zero transfer doesn't set zero_since) and the cron eligibility predicate (reservation block, rental exclusion, dwell boundary, discontinued left alone).
- **Unit test** the cron eligibility query/predicate in isolation.
- **Live Demo Co**: enable toggle; take an item to zero; fast-forward `zero_since` to simulate dwell; run the cron route; confirm archived + audit + notification; restock and confirm instant restore; confirm a manually-archived item is untouched by restock; mobile restore round-trip.

## Rollout

Apply migration via `supabase db push --linked` (before deploying web that reads
the new columns/settings — pending migs crash pages). Deploy web. Register the
cron in `vercel.json`. OTA mobile. Verify in Demo Co (71b27a4a-…) web + mobile.

## Resolved decisions (owner, 2026-07-14)

1. **Tighten the existing receipt auto-unarchive** — `receiving.ts` `maybeAutoUnarchive` currently revives ANY archived item on receipt. In scope for this feature: change it to only revive rows where `auto_archived = true`, so a stray receipt can't un-retire a deliberately-archived SKU. Consistent with the "system-archived only" reversal.
2. **One notification per auto-archived item** (not a digest). Per-user muteable (0265 pattern), via the single AFTER-INSERT broadcast path.
3. **Permission gate = `items:update`** ("edit items") — archive is reversible, so this is the correct gate (not `items:delete`).
