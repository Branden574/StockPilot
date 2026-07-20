-- 0277_expected_items_visibility.sql
-- Expected-items visibility, Unit 1 (DB). Plan:
-- docs/superpowers/plans/2026-07-20-expected-items-visibility.md
--
-- OWNER REPORT (2026-07-20, screenshots): items auto-created from
-- expected/inbound POs (PD 8/7 Lanyard, PD 8/7 Sticker, Clear Backpack via
-- the CVW vendor-feed POs) show on the Items list as "Out of stock" and on
-- ordering surfaces before anything has arrived — people see the SKU and
-- think "oh, it got delivered." Established items that are merely out of
-- stock (Dell XPS) must remain visible.
--
-- OWNER DECISIONS:
--   1. Hidden ONLY until FIRST receipt: the moment ANY units arrive (even
--      into staging), the item appears everywhere. Clearing is a DB trigger
--      (below), not app code, so every stock-arrival path — PO receive,
--      manual adjust, cycle count, transfer-in — clears the flag with zero
--      app-code cooperation.
--   2. While hidden, admins reach these items via an "Expected" filter chip
--      on Items (like Archived), and they are excluded from ordering
--      surfaces (order create, storefront, B2B portal, public catalogs —
--      the last enforced here via public_link_eligible_items).
--
-- AUTO-ARCHIVE (0266) NON-INTERACTION: phantoms are created AT zero and have
-- never crossed >0 → <=0, so their zero_since is NULL and the 0266 daily
-- cron — which only scans rows `where zero_since is not null` (see
-- inventory_items_auto_archive_idx) — ignores them entirely. No interplay.
--
-- SETTING the flag is app-layer (Unit 2): createItemsFromPoLines (PO-import
-- approve) + vendor-feed/integration item creation. Manual creation and CSV
-- import do NOT set it. This migration adds the column, the clearing
-- trigger, a one-time backfill for the existing phantoms, and the
-- public-catalog exclusion.

-- ── 1. Column ───────────────────────────────────────────────────────────────
alter table public.inventory_items
  add column if not exists awaiting_first_receipt boolean not null default false;

comment on column public.inventory_items.awaiting_first_receipt is
  'True while an item auto-created from an inbound PO has never received any stock. Set by PO-driven item-creation paths (app layer); cleared by _clear_awaiting_first_receipt the moment quantity_on_hand rises above 0 by ANY path. While true the item is hidden from default lists and all ordering surfaces (shown under the Items "Expected" chip).';

-- ── 2. Partial index for the Expected chip / count-badge queries ────────────
-- Flagged rows are a tiny, transient slice; the chip count and the Expected
-- list both filter `where awaiting_first_receipt` per org.
create index if not exists inventory_items_awaiting_first_receipt_idx
  on public.inventory_items (organization_id)
  where awaiting_first_receipt;

-- ── 3. Clearing trigger ─────────────────────────────────────────────────────
-- Mirrors 0266's _track_zero_since: BEFORE UPDATE OF quantity_on_hand, pure
-- NEW mutation (no status change → never touches the 0184/0268 status
-- triggers, cannot recurse). REMEMBER the column-trigger gotcha: `OF
-- quantity_on_hand` fires on SET-LIST PRESENCE, not on value change — the
-- Edit Item form submits quantity_on_hand unchanged on every ordinary save —
-- so the guard is on the VALUE (`new.quantity_on_hand > 0`), never on mere
-- presence. An update that includes quantity_on_hand still <= 0 must NOT
-- clear the flag.
create or replace function public._clear_awaiting_first_receipt()
returns trigger
language plpgsql
as $$
begin
  if old.awaiting_first_receipt and new.quantity_on_hand > 0 then
    new.awaiting_first_receipt := false;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_inventory_clear_awaiting_first_receipt on public.inventory_items;
create trigger trg_inventory_clear_awaiting_first_receipt
  before update of quantity_on_hand on public.inventory_items
  for each row execute function public._clear_awaiting_first_receipt();

-- ── 4. One-time backfill: flag the existing phantoms ────────────────────────
-- WHY this predicate is precise:
--   * PO-created phantoms are inserted at quantity 0 and have never had any
--     stock event, so they have ZERO stock_movements rows. Established
--     out-of-stock items always got to zero THROUGH movements (receive /
--     remove / adjust / initial), so movement history cleanly separates the
--     two populations.
--   * Requiring an OPEN inbound PO line (purchase_order_items joined to a
--     purchase_orders row still in draft / ordered / expected_inbound /
--     partially_received — the full status set is 0011's check constraint:
--     those four plus terminal received / cancelled) ties the flag to items
--     something is genuinely still inbound for. A zero-quantity,
--     zero-movement item with no open PO line (e.g. a manually created shell
--     nobody ordered) is left alone.
update public.inventory_items i
   set awaiting_first_receipt = true
 where i.quantity_on_hand <= 0
   and not exists (
     select 1 from public.stock_movements m
      where m.item_id = i.id
   )
   and exists (
     select 1
       from public.purchase_order_items poi
       join public.purchase_orders po on po.id = poi.purchase_order_id
      where poi.item_id = i.id
        and po.status in ('draft', 'ordered', 'expected_inbound', 'partially_received')
   );

-- ── 5. Public catalogs: exclude expected items ──────────────────────────────
-- public_link_eligible_items (0261) is THE single public-visibility
-- predicate — both the /r/<token> catalog render and the public submit
-- endpoint resolve through it, so adding the condition HERE covers both.
-- Identical to 0261's definition except for the single added
-- `not i.awaiting_first_receipt` condition; signature, STABLE, SECURITY
-- DEFINER and search_path unchanged (CREATE OR REPLACE preserves the 0261
-- grants; they are re-asserted below anyway).
create or replace function public.public_link_eligible_items(
  p_link_id uuid,
  p_warehouse_id uuid
)
returns table (item_id uuid, max_qty integer)
language sql
stable
security definer
set search_path = public
as $$
  select i.id as item_id,
         coalesce(e.max_qty_per_request, l.default_max_qty) as max_qty
  from public.public_request_links l
  join public.inventory_items i
    on i.organization_id = l.organization_id
  join public.warehouses w
    on w.id = i.warehouse_id
   and w.organization_id = l.organization_id
  left join public.categories c
    on c.id = i.category_id
  left join public.public_link_catalog_entries e
    on e.link_id = l.id
   and e.item_id = i.id
  where l.id = p_link_id
    and l.active
    and (l.expires_at is null or l.expires_at > now())
    and (l.available_from is null or l.available_from <= now())
    and (l.available_until is null or l.available_until >= now())
    and i.warehouse_id = p_warehouse_id
    and w.is_public_orderable
    and i.status = 'active'
    and i.deleted_at is null
    and i.public_visibility <> 'hidden'
    and not i.awaiting_first_receipt
    and (   (i.item_type =  'book' and l.books_enabled)
         or (i.item_type <> 'book' and l.items_enabled) )
    and (
      e.item_id is not null
      or (
        l.include_public_pool
        and i.public_visibility = 'public'
        and (i.category_id is null or c.public_visibility = 'public')
      )
    )
$$;

-- Re-assert the 0261 security posture (service-role only).
revoke all on function public.public_link_eligible_items(uuid, uuid) from public;
revoke all on function public.public_link_eligible_items(uuid, uuid) from anon;
revoke all on function public.public_link_eligible_items(uuid, uuid) from authenticated;
grant execute on function public.public_link_eligible_items(uuid, uuid) to service_role;
