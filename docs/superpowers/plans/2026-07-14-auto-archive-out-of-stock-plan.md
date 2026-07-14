# Auto-Archive When Out of Stock — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-org toggle that archives an inventory item after it has been out of stock (`quantity_on_hand <= 0`) for a configurable grace period (default 7 days), and auto-restores it when restocked.

**Architecture:** A BEFORE trigger stamps `inventory_items.zero_since` on the positive→zero crossing and clears it on the reverse; an AFTER trigger instantly restores system-archived items on restock; a daily cron archives items past the dwell window (per-org opt-in, reservation/rental guards). Setting lives in `organization_modules.settings.autoArchiveOnZeroStock`. Full web + mobile archived/restore UI.

**Tech Stack:** Supabase Postgres (SQL triggers + pgTAP), Next.js App Router (cron route + server action + RSC/client settings panel), Expo/React Native (mobile), vitest.

## Global Constraints

- Migrations applied to prod via `supabase db push --linked` AFTER merge, BEFORE deploying web that reads the new columns (pending migs crash pages).
- Every web feature also ships to mobile (parity).
- **NO Claude/Anthropic co-author trailer** on commits.
- pgTAP for the migration (triggers).
- Live Demo Co verification (org `71b27a4a-7948-4638-bc3f-535974713bd2`) web + mobile before "done".
- **Never write `archived_at` directly** — the 0184 BEFORE trigger `tg_inventory_set_archived_at` owns it (stamps on →archived, clears on →active).
- `status` is THE archive flag: `active | archived | discontinued`. Restore = `status='active'`.
- Out of stock = `quantity_on_hand <= 0`, detected as a crossing (`old > 0 AND new <= 0`). `quantity_on_hand` is `numeric(14,4)` — compare with `<= 0`, not `= 0`.
- The restore trigger is NOT gated on the org toggle (reviving a restocked item is the safe direction).
- New-at-zero items are excluded automatically: `zero_since` is only set on a positive→zero crossing, so a create-at-0 item has `zero_since = NULL` and is never eligible.
- OTA mobile only via `pnpm release:ota` from `apps/mobile` (never raw `eas update`).

---

## File Structure

- `supabase/migrations/02NN_auto_archive_out_of_stock.sql` — columns `zero_since`, `auto_archived`; partial index; triggers `_track_zero_since` (BEFORE) + `_auto_restock_restore` (AFTER).
- `supabase/migrations/02NN_auto_archive_out_of_stock.pgtap.sql` (or the repo's pgTAP location) — trigger tests.
- `apps/web/src/server/services/auto-archive.ts` — settings schema/parse + `archiveExpiredZeroStockItems(ctx, dwellDays)` service (mirrors `archive-cleanup.ts`).
- `apps/web/src/server/services/auto-archive.test.ts` — service unit tests.
- `apps/web/src/app/api/cron/auto-archive-zero-stock/route.ts` — daily cron (mirrors `auto-delete-archived/route.ts`).
- `apps/web/src/server/actions/auto-archive-settings.ts` — per-org settings write action (mirrors `inventory-cleanup-settings.ts`).
- `apps/web/src/components/settings/auto-archive-panel.tsx` — settings panel (mirrors `archive-cleanup-panel.tsx`).
- `apps/web/src/app/(dashboard)/dashboard/settings/inventory-cleanup/page.tsx` — mount the new panel + pass initial settings.
- `apps/web/src/lib/notification-prefs.ts` + `notification-preferences-form.tsx` — new `push_item_auto_archived` pref key + toggle.
- `supabase/migrations/02NN+1_item_auto_archived_pref.sql` — `notification_preferences.push_item_auto_archived` column.
- `apps/web/src/server/services/receiving.ts` — tighten `maybeAutoUnarchive` to `auto_archived = true` only.
- `apps/web/src/server/services/inventory.ts` + bulk-actions / Archived view — `auto_archived` badge + filter + audit label fix.
- `apps/mobile/app/(drawer)/(tabs)/inventory.tsx` + `books.tsx` + `app/item/[id].tsx` + a mobile restore call — mobile archived UI.
- `vercel.json` — cron schedule.

---

## PHASE 1 — Data model + triggers

### Task 1: Migration — columns, index, and the two triggers

**Files:**
- Create: `supabase/migrations/02NN_auto_archive_out_of_stock.sql` (use the next free number; today's highest is 0265)

**Interfaces:**
- Produces: `inventory_items.zero_since timestamptz`, `inventory_items.auto_archived boolean not null default false`; functions `public._track_zero_since()`, `public._auto_restock_restore()`.

- [ ] **Step 1: Write the migration**

```sql
-- 02NN_auto_archive_out_of_stock.sql
-- Per-org auto-archive of items that stay out of stock (quantity_on_hand<=0)
-- past a grace period. This migration adds the state columns + the two triggers
-- that maintain them; the daily cron (app-layer) does the actual archiving.

alter table public.inventory_items
  add column if not exists zero_since    timestamptz,
  add column if not exists auto_archived boolean not null default false;

comment on column public.inventory_items.zero_since is
  'When quantity_on_hand last crossed from >0 to <=0. NULL while in stock. Set/cleared by _track_zero_since; the dwell clock for auto-archive.';
comment on column public.inventory_items.auto_archived is
  'True only when the system auto-archived this item on zero-stock. Cleared on restore. Distinguishes system vs manual archives; gates auto-restore-on-restock.';

-- Cron scan index: only active, never-auto-archived, currently-at-zero rows.
create index if not exists inventory_items_auto_archive_idx
  on public.inventory_items (organization_id, zero_since)
  where status = 'active' and auto_archived = false and zero_since is not null;

-- BEFORE trigger: maintain zero_since. Pure NEW mutation, no status change, so
-- it never touches the 0184 archived_at trigger and cannot recurse.
create or replace function public._track_zero_since()
returns trigger
language plpgsql
as $$
begin
  if old.quantity_on_hand > 0 and new.quantity_on_hand <= 0 then
    new.zero_since := now();
  elsif old.quantity_on_hand <= 0 and new.quantity_on_hand > 0 then
    new.zero_since := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_inventory_track_zero_since on public.inventory_items;
create trigger trg_inventory_track_zero_since
  before update of quantity_on_hand on public.inventory_items
  for each row execute function public._track_zero_since();

-- AFTER trigger: instant restore of SYSTEM-archived items on restock. Guarded
-- self-UPDATE (AFTER can't mutate NEW). The self-UPDATE changes status only, so
-- it does NOT re-fire the OF quantity_on_hand triggers (this one, _track_zero_since,
-- or the 0091 low-stock trigger) and DOES fire 0184 to clear archived_at.
-- NOT gated on the org toggle: restoring a restocked item is always safe.
create or replace function public._auto_restock_restore()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.quantity_on_hand <= 0 and new.quantity_on_hand > 0 then
    update public.inventory_items
       set status = 'active', auto_archived = false, updated_by = new.updated_by
     where id = new.id and status = 'archived' and auto_archived = true;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_inventory_auto_restock_restore on public.inventory_items;
create trigger trg_inventory_auto_restock_restore
  after update of quantity_on_hand on public.inventory_items
  for each row execute function public._auto_restock_restore();
```

- [ ] **Step 2: Confirm no trigger-name / column collision**

Run: `grep -rn "trg_inventory_track_zero_since\|trg_inventory_auto_restock_restore\|zero_since\|auto_archived" supabase/migrations | grep -v "02NN"`
Expected: no pre-existing definitions (empty).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/02NN_auto_archive_out_of_stock.sql
git commit -m "feat(inventory): zero_since + auto_archived columns and triggers for auto-archive"
```

### Task 2: pgTAP for the triggers

**Files:**
- Create: `supabase/tests/auto_archive.sql` (match the repo's pgTAP dir — check `supabase/tests/` or wherever `0259/0260` pgTAP live; if none, create `supabase/tests/`)

**Interfaces:**
- Consumes: the two triggers from Task 1.

- [ ] **Step 1: Write the pgTAP tests** (seed one active item; assert each behavior)

```sql
begin;
select plan(6);

-- Fixture: an org + a warehouse + one active item at qty 10.
-- (Use the smallest valid inserts; reuse existing seed helpers if the repo has them.)
insert into public.organizations (id, name) values ('00000000-0000-0000-0000-0000000000a1','pgtap-org')
  on conflict do nothing;
insert into public.inventory_items (id, organization_id, name, quantity_on_hand, status)
  values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000a1','pgtap-item',10,'active');

-- 1. Crossing to zero stamps zero_since.
update public.inventory_items set quantity_on_hand = 0 where id='00000000-0000-0000-0000-0000000000b1';
select isnt((select zero_since from public.inventory_items where id='00000000-0000-0000-0000-0000000000b1'), null,
  'zero_since is set when qty crosses to 0');

-- 2. Staying at/below zero keeps the original zero_since (does not reset).
update public.inventory_items set zero_since = now() - interval '10 days' where id='00000000-0000-0000-0000-0000000000b1';
update public.inventory_items set quantity_on_hand = -1 where id='00000000-0000-0000-0000-0000000000b1';
select cmp_ok((select zero_since from public.inventory_items where id='00000000-0000-0000-0000-0000000000b1'), '<',
  now() - interval '1 day', 'zero_since is preserved while still <= 0');

-- 3. A system-archived item at zero, when restocked, is auto-restored.
update public.inventory_items set status='archived', auto_archived=true where id='00000000-0000-0000-0000-0000000000b1';
update public.inventory_items set quantity_on_hand = 5 where id='00000000-0000-0000-0000-0000000000b1';
select is((select status from public.inventory_items where id='00000000-0000-0000-0000-0000000000b1'), 'active',
  'restock auto-restores a system-archived item');
select is((select auto_archived from public.inventory_items where id='00000000-0000-0000-0000-0000000000b1'), false,
  'restore clears auto_archived');
select is((select zero_since from public.inventory_items where id='00000000-0000-0000-0000-0000000000b1'), null,
  'restock clears zero_since');

-- 4. A MANUALLY archived item (auto_archived=false) is NOT restored on restock.
update public.inventory_items set quantity_on_hand=0 where id='00000000-0000-0000-0000-0000000000b1';
update public.inventory_items set status='archived', auto_archived=false where id='00000000-0000-0000-0000-0000000000b1';
update public.inventory_items set quantity_on_hand=8 where id='00000000-0000-0000-0000-0000000000b1';
select is((select status from public.inventory_items where id='00000000-0000-0000-0000-0000000000b1'), 'archived',
  'restock does NOT revive a manually-archived item');

select * from finish();
rollback;
```

- [ ] **Step 2: Run pgTAP** (mirror how the repo runs 0259/0260 pgTAP — likely `supabase test db` or a psql pg_prove). Expected: 6/6 pass.
- [ ] **Step 3: Commit** (`test(inventory): pgTAP for zero_since + auto-restore triggers`)

### Task 3: Apply Phase-1 migration to prod + verify

- [ ] **Step 1:** `supabase migration list --linked` → confirm only the new mig is pending.
- [ ] **Step 2:** `supabase db push --linked` → applies the new migration.
- [ ] **Step 3: Verify on prod** (Supabase MCP execute_sql):

```sql
select
  (select count(*) from information_schema.columns where table_name='inventory_items' and column_name in ('zero_since','auto_archived')) as cols,
  (select count(*) from pg_trigger where tgname in ('trg_inventory_track_zero_since','trg_inventory_auto_restock_restore')) as triggers;
```
Expected: `cols=2, triggers=2`.

- [ ] **Step 4:** Live crossing check in Demo Co inside a rollback DO-block (like the 0265 verification): set an item to 0 → assert zero_since set; archive+auto_archived → restock → assert status='active'; then `raise exception` to roll back. Confirm zero residue.

---

## PHASE 2 — Daily cron

### Task 4: `auto-archive.ts` service (settings schema + archive query)

**Files:**
- Create: `apps/web/src/server/services/auto-archive.ts`
- Test: `apps/web/src/server/services/auto-archive.test.ts`

**Interfaces:**
- Produces: `autoArchiveSettingsSchema`, `parseAutoArchiveSettings(raw): {enabled, dwellDays}`, `archiveExpiredZeroStockItems(ctx, dwellDays, opts?): Promise<{archived: number; ids: string[]; items: {id,name}[]; truncated: boolean}>`.

- [ ] **Step 1: Write the service** (mirror `archive-cleanup.ts` exactly; the reservation + rental exclusion are the only new bits)

```ts
import 'server-only';
import { z } from 'zod';
import { audit } from './audit';
import { ServiceError, type ServiceContext } from './context';

export const AUTO_ARCHIVE_MIN_DAYS = 1;
export const AUTO_ARCHIVE_MAX_DAYS = 365;

export const autoArchiveSettingsSchema = z.object({
  enabled: z.boolean(),
  dwellDays: z.number().int().min(AUTO_ARCHIVE_MIN_DAYS).max(AUTO_ARCHIVE_MAX_DAYS),
});
export type AutoArchiveSettings = z.infer<typeof autoArchiveSettingsSchema>;
const DEFAULTS: AutoArchiveSettings = { enabled: false, dwellDays: 7 };

export function parseAutoArchiveSettings(raw: unknown): AutoArchiveSettings {
  const parsed = autoArchiveSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULTS;
}

const ARCHIVE_BATCH_LIMIT = 500; // matches bulkUpdate's hard cap

export async function archiveExpiredZeroStockItems(
  ctx: ServiceContext,
  dwellDays: number,
  opts: { limit?: number } = {},
): Promise<{ archived: number; ids: string[]; items: Array<{ id: string; name: string }>; truncated: boolean }> {
  const limit = opts.limit ?? ARCHIVE_BATCH_LIMIT;
  const cutoff = new Date(Date.now() - dwellDays * 86_400_000).toISOString();

  // Candidates: active, never-auto-archived, at/below zero, at-zero longer than
  // the dwell window, and NOT a rental (rentals sit at zero while checked out).
  // zero_since NOT NULL naturally excludes never-stocked create-at-0 items.
  const { data: cand, error: selErr } = await ctx.supabase
    .from('inventory_items')
    .select('id, name')
    .eq('organization_id', ctx.organizationId)
    .eq('status', 'active')
    .eq('auto_archived', false)
    .lte('quantity_on_hand', 0)
    .not('zero_since', 'is', null)
    .lte('zero_since', cutoff)
    .neq('item_type', 'rental') // P2/step-0 confirms 'rental' is the correct exclusion token
    .order('zero_since', { ascending: true })
    .limit(limit);
  if (selErr) throw new ServiceError('internal_error', selErr.message);
  const rows = (cand ?? []) as Array<{ id: string; name: string }>;
  const truncated = rows.length === limit;
  if (rows.length === 0) return { archived: 0, ids: [], items: [], truncated: false };

  // Exclude items with active reservations (approved-unpicked order / open rental).
  const { data: resv, error: resvErr } = await ctx.supabase
    .from('stock_reservations')
    .select('item_id')
    .in('item_id', rows.map((r) => r.id))
    .is('released_at', null);
  if (resvErr) throw new ServiceError('internal_error', resvErr.message);
  const reserved = new Set((resv ?? []).map((r) => (r as { item_id: string }).item_id));
  const eligible = rows.filter((r) => !reserved.has(r.id));
  if (eligible.length === 0) return { archived: 0, ids: [], items: [], truncated };

  const { data: done, error: updErr } = await ctx.supabase
    .from('inventory_items')
    .update({ status: 'archived', auto_archived: true, updated_by: ctx.userId })
    .eq('organization_id', ctx.organizationId)
    .in('id', eligible.map((r) => r.id))
    .eq('status', 'active') // race guard
    .eq('auto_archived', false)
    .lte('quantity_on_hand', 0) // race guard: don't archive one restocked mid-run
    .select('id, name');
  if (updErr) throw new ServiceError('internal_error', updErr.message);
  const archived = (done ?? []) as Array<{ id: string; name: string }>;

  for (const item of archived) {
    await audit(
      {
        event: 'inventory.item.archived',
        entityType: 'inventory_item',
        entityId: item.id,
        after: { status: 'archived' },
        extra: { reason: 'auto_zero_stock', dwellDays, itemName: item.name },
      },
      ctx,
    );
  }
  return { archived: archived.length, ids: archived.map((d) => d.id), items: archived, truncated };
}
```

- [ ] **Step 2: Write tests** — with a mocked `ctx.supabase` (mirror `archive-cleanup.test.ts`): asserts the candidate filter chain (status/auto_archived/qty/zero_since/item_type), reservation exclusion, race-guarded update, and per-item audit. Also: empty candidates → `{archived:0}`; all reserved → `{archived:0, truncated}`.
- [ ] **Step 3: Run** `pnpm --filter @stockpilot/web test src/server/services/auto-archive.test.ts` → PASS.
- [ ] **Step 0 (do first): confirm the rental token** — `grep -rn "item_type" supabase/migrations/0002_inventory.sql packages/core/src | grep -iE "rental|check"`. If rentals are represented differently (separate table / different flag), adjust the `.neq('item_type','rental')` predicate to the real exclusion and note it in the commit.
- [ ] **Step 4: Commit** (`feat(inventory): archiveExpiredZeroStockItems service`)

### Task 5: The cron route + notification

**Files:**
- Create: `apps/web/src/app/api/cron/auto-archive-zero-stock/route.ts` (copy `auto-delete-archived/route.ts` structure verbatim; swap the service + settings key)
- Create migration `02NN+1_item_auto_archived_pref.sql`: `alter table public.notification_preferences add column if not exists push_item_auto_archived boolean not null default true;`
- Modify: `apps/web/src/lib/notification-prefs.ts` (add `'push_item_auto_archived'` to `NOTIFICATION_PREF_KEYS`)
- Modify: `apps/web/src/components/settings/notification-preferences-form.tsx` (add a `push` TOGGLE_DEF: key `push_item_auto_archived`, label "Items auto-archived", hint "In-app alert when an out-of-stock item is auto-archived.")
- Modify: `vercel.json` (add `{ "path": "/api/cron/auto-archive-zero-stock", "schedule": "0 8 * * *" }` — daily 08:00 UTC; confirm the exact cron array shape already in the file)

**Interfaces:**
- Consumes: `parseAutoArchiveSettings`, `archiveExpiredZeroStockItems` (Task 4); `buildSystemContext` pattern (copy from auto-delete cron).

- [ ] **Step 1:** Copy the auto-delete cron → new route: same CRON_SECRET gate, `fetchAllRows` over `organization_modules` `module_id='inventory'`, parse `settings.autoArchiveOnZeroStock` with `parseAutoArchiveSettings`, keep only `enabled`, `buildSystemContext(admin, orgId)`, call `archiveExpiredZeroStockItems(ctx, settings.dwellDays)`, `revalidateInventoryList(orgId)` when `archived>0`, truncated → `reportError`. Return `{orgsProcessed, itemsArchived, orgsTruncated, candidates}`.
- [ ] **Step 2: Notification** — after archiving an org's items, load owner/admin/manager members + their `push_item_auto_archived` pref; for each recipient NOT opted out, insert one notification per archived item via `createNotification` (`type: 'inventory.item.auto_archived'`, `title: 'Item auto-archived'`, `body: item.name`, `link: '/dashboard/inventory/<id>'`, `metadata: {item_id}`). The 0028 AFTER-INSERT trigger pushes it — do NOT call notifyUser (see [[reference_realtime_permission_push_broadcast]]).
- [ ] **Step 3: Apply the pref migration to prod** (`supabase db push --linked`) BEFORE deploying — the settings form selects `NOTIFICATION_PREF_KEYS` columns, so a missing column crashes the notifications page.
- [ ] **Step 4: Verify** the notification path in a Demo Co rollback DO-block (opted-out recipient gets 0, opted-in gets 1) like the 0265 test.
- [ ] **Step 5: Commit** (`feat(inventory): daily auto-archive cron + per-user muteable notice`)

---

## PHASE 3 — Web settings + surfacing + receiving tighten

### Task 6: Settings write action

**Files:**
- Create: `apps/web/src/server/actions/auto-archive-settings.ts` (copy `inventory-cleanup-settings.ts`; change: `autoArchiveSettingsSchema`, key `autoArchiveOnZeroStock`, gate `can(ctx, 'items:update')` — archive is reversible, audit event `auto_archive_settings.updated`).

- [ ] **Step 1:** Write `setAutoArchiveSettingsAction(input): ActionResult<{settings}>` — validate → withContext → MFA gate (fail closed) → `items:update` gate → `enabledModules.has('inventory')` → merge `{ ...prev, autoArchiveOnZeroStock: settings }` → 0-row fail-closed → audit → `revalidatePath('/dashboard/settings/inventory-cleanup')`.
- [ ] **Step 2: Typecheck + lint.** Commit (`feat(inventory): auto-archive settings action`).

### Task 7: Settings panel + page wiring

**Files:**
- Create: `apps/web/src/components/settings/auto-archive-panel.tsx` (mirror `archive-cleanup-panel.tsx`: an on/off Switch + a "days at zero" number input min 1; calls `setAutoArchiveSettingsAction`; inline error on failure).
- Modify: `apps/web/src/app/(dashboard)/dashboard/settings/inventory-cleanup/page.tsx` — read `organization_modules.settings.autoArchiveOnZeroStock` via `parseAutoArchiveSettings`, render `<AutoArchivePanel initial={...} />` below the existing cleanup panel.

- [ ] **Step 1:** Build the panel (copy the cleanup panel; swap labels/action/fields). Copy: "Automatically archive items that stay out of stock. Restocking brings them back."
- [ ] **Step 2: Verify live in Demo Co** — panel renders, toggle on + set 3 days persists (reload), SQL confirms `settings.autoArchiveOnZeroStock`. Commit.

### Task 8: Auto-archived badge + filter + audit-label fixes

**Files:**
- Modify: the web Archived view list (where `?status=archived` renders) — add an "Auto-archived" badge when `auto_archived` and a filter chip to show only auto-archived; the inventory loader must select `auto_archived`.
- Modify: `apps/web/src/server/services/inventory.ts` bulk `unarchive` path — emit `inventory.item.restored` (not the generic `inventory.item.updated`); add the 'restored' icon to the item Activity feed component.

- [ ] **Step 1:** Add `auto_archived` to the archived-list select + the badge + filter. Test: an auto-archived item shows the badge; filter narrows to auto-archived only.
- [ ] **Step 2:** Fix the bulk-unarchive audit event + Activity 'restored' icon. Commit.

### Task 9: Tighten receiving auto-unarchive

**Files:**
- Modify: `apps/web/src/server/services/receiving.ts` (`maybeAutoUnarchive`)

- [ ] **Step 1: Write/adjust a test** asserting a receipt revives an `auto_archived=true` item but NOT a manually-archived (`auto_archived=false`) one.
- [ ] **Step 2:** Add `auto_archived === true` to the revive condition/predicate. Run test → PASS. Commit (`fix(inventory): receipt only revives system-archived items`).

### Task 10: Deploy web + verify

- [ ] Push (Vercel auto-deploys). Confirm the cron is registered. Live Demo Co: enable toggle; take an item to zero; simulate dwell (set `zero_since` back) + hit the cron route with the CRON_SECRET; confirm archived + audit + notification; restock → instant restore; manual-archive untouched by restock.

---

## PHASE 4 — Mobile parity + OTA

### Task 11: Mobile archived filter + badge

**Files:**
- Modify: `apps/mobile/app/(drawer)/(tabs)/inventory.tsx` (~line 217 hardcodes `.eq('status','active')`) + `books.tsx` — add an "Archived" filter toggle; when on, query `status='archived'` instead of `active`.
- Modify: `apps/mobile/app/item/[id].tsx` — show an "Archived" / "Auto-archived" badge (read `status` + `auto_archived`).

- [ ] **Step 1:** Add the archived filter to Items + Books tabs (mirror an existing filter chip). Step 2: badge on item detail. Commit.

### Task 12: Mobile restore action

**Files:**
- Modify: `apps/mobile/app/item/[id].tsx` — a "Restore" button on an archived item calling the Bearer `/api/v1` bulk-update `unarchive` (1-element id array; no new service method). Confirm the endpoint exists (`grep -rn "bulkUpdate\|unarchive" apps/mobile/src apps/web/src/app/api/v1`).

- [ ] **Step 1:** Wire Restore → API → optimistic status flip. Step 2: Commit.

### Task 13: OTA + simulator + Demo Co

- [ ] `pnpm typecheck` + lint (mobile). `pnpm release:ota` from `apps/mobile`. Boot iOS simulator; hand-test: archived filter shows archived items, badge renders, Restore round-trips. Walk Demo Co mobile. (Note: the local dev-client may be stale on native modules — if so, verify on a real device that pulls the OTA.)

---

## Self-Review notes

- **Spec coverage:** every spec section maps to a task — data model+triggers (T1), pgTAP (T2), cron+dwell+guards+notification (T4/T5), settings action+panel (T6/T7), web badge/filter+audit fixes (T8), receiving tighten (T9), mobile (T11-13). ✅
- **Migration numbering:** `02NN` placeholders — resolve to the next free numbers at execution (two migrations: columns+triggers, then the notification-pref column).
- **Unconfirmed token:** the rental exclusion (`item_type = 'rental'`) is verified in Task 4 Step 0 before use — the only deliberately-deferred lookup.
- **Notification volume:** "one ping per item" per the owner; if a cron run archives many items for an org, that is many notices — acceptable per the decision, but T5 could cap/summarize if it proves noisy (out of scope now).
