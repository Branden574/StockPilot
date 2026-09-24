-- 0364_ledger_lockdown_enforce.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Stock-ledger lockdown, step 2 of 2 ("enforce"). Step 1 (0359-0363, #243) is
-- live and moved every app write these rules close onto a ledger RPC or a
-- SECURITY DEFINER function. A census of the whole codebase and 31 days of
-- production traffic (2026-09-24) found no current writer these rules refuse:
-- phones write these tables only through /api/v1 and the adjust_stock wrapper.
--
-- What it closes, for the API roles (authenticated, anon) only. SECURITY
-- DEFINER bodies, the service role and FK referential actions are exempt, as
-- in 0359:
--   1. inventory_items: quantity_on_hand changes only inside a ledger RPC. An
--      insert may still open with stock (see section 1).
--   2. item_stock_levels: written only inside a ledger RPC. DELETE is revoked,
--      and so is DELETE on locations and warehouses, whose FK cascades would
--      otherwise remove holdings with no movement.
--   3. purchase_orders: an insert is a draft, with no ordered or received
--      date; the database records who created it and when. A PO with no
--      lines cannot be placed.
--   4. purchase_order_items: lines are added only to a draft, and a line
--      write holds the PO until it commits, so "Mark as ordered" and its
--      approval threshold always see the lines.
--   5. purchase_order_charges: written only by approve_po_import_commit.
--   6. rentals, rental_lines: written only by create_rental, return_rental
--      and cancel_rental.
--
-- Every guard body below is the live 0359/0360 text plus the new rule, so no
-- rule step 1 enforces is lost.
--
-- Do not deploy a web build older than #243 (234962bb) after this: its item
-- rollback, PO-import approval and rental code wrote these tables directly.
--
-- Rollback: a follow-up migration that restores tg_inventory_items_guard from
-- 0359 and the two PO guards from 0360, drops trg_zz_item_stock_levels_guard
-- and po_status_for_line_write, re-grants DELETE on item_stock_levels,
-- locations and warehouses and the writes on the charge and rental tables,
-- and re-creates the dropped policies. 0359-0363 stay.

set lock_timeout = '5s';

-- ── 1. inventory_items: on-hand moves only through the ledger ───────────────
-- An UPDATE that changes quantity_on_hand needs ledger.active(), so on-hand
-- never moves without the movement row the RPC writes in the same transaction.
-- The column is compared, not the statement: the placement RPCs
-- (inventory_set_rack and friends) update other columns of the row as the
-- user and keep working.
--
-- An INSERT may still carry opening stock. Every item create in the last 30
-- days did (61 of 61): the services insert the item with its quantity and
-- write the 'initial' movement next. Refusing it needs item creation on one
-- ledger function first; until then, compensate_opening_stock undoes a create
-- whose movement fails.

create or replace function public.tg_inventory_items_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_cost_changed      boolean := new.unit_cost is distinct from old.unit_cost;
  v_charter_changed   boolean := new.charter_id is distinct from old.charter_id;
  v_warehouse_changed boolean := new.warehouse_id is distinct from old.warehouse_id;
begin
  -- See tg_ledger_only_guard for why only the API roles are checked.
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  -- Who created an item and when are the database's to record. The
  -- failed-create rollback (compensate_opening_stock) trusts both.
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
    return new;
  end if;

  if new.organization_id is distinct from old.organization_id then
    raise exception 'An item cannot be moved to another organization.'
      using errcode = '42501';
  end if;
  if new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'An item''s creator and creation time cannot be changed.'
      using errcode = '42501';
  end if;

  -- On-hand moves only with its movement (0364).
  if new.quantity_on_hand is distinct from old.quantity_on_hand and not ledger.active() then
    raise exception 'On-hand changes only through a stock movement: adjust, transfer, receive or count.'
      using errcode = '42501';
  end if;

  if not (v_cost_changed or v_charter_changed or v_warehouse_changed) then
    return new;
  end if;

  if not public.has_permission(new.organization_id, 'items:update') then
    if not (v_charter_changed
            and not v_cost_changed
            and not v_warehouse_changed
            and old.quantity_on_hand = 0
            and public.has_permission(new.organization_id, 'purchase_orders:manage')) then
      raise exception 'You do not have permission to change this item''s cost, charter or warehouse.'
        using errcode = '42501';
    end if;
  end if;

  if v_cost_changed and new.unit_cost < 0 then
    raise exception 'Unit cost must be 0 or more.'
      using errcode = '23514';
  end if;

  if v_warehouse_changed then
    if new.warehouse_id is null then
      raise exception 'Item must remain assigned to a warehouse.'
        using errcode = '23514';
    end if;
    if not public.warehouse_in_org(new.warehouse_id, new.organization_id) then
      raise exception 'That warehouse is not part of this organization.'
        using errcode = '42501';
    end if;
    if public.caller_is_warehouse_scoped(new.organization_id) then
      raise exception 'Warehouse-scoped users cannot move items to another warehouse.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.tg_inventory_items_guard() is
  'BEFORE INSERT OR UPDATE guard (0359, on-hand rule 0364): API-role inserts get '
  'created_by and created_at from the database; updates cannot change '
  'organization_id or the creator, change quantity_on_hand only inside a ledger '
  'RPC, and change cost/charter/warehouse by the item-edit rules. SECURITY '
  'INVOKER on purpose (a DEFINER trigger sees postgres and never enforces).';

revoke all on function public.tg_inventory_items_guard() from public, anon, authenticated;

-- ── 2. item_stock_levels: ledger-only ───────────────────────────────────────
-- The write policy and the INSERT/UPDATE grants stay: ledger.adjust_stock and
-- ledger.transfer_stock write holdings as the user, with the flag on. No
-- ledger body deletes a holdings row (the only SQL DELETE is
-- _dedup_rack_locations, executable by postgres alone), so DELETE goes.
--
-- Holdings also disappear by cascade: deleting a location deletes its rows
-- (item_stock_levels_location_id_fkey ON DELETE CASCADE, run as the owner, so
-- no guard sees it) and nulls the locations on its movements; deleting a
-- warehouse takes its locations, holds and item assignments with it. The apps
-- only ever archive locations and warehouses (deleted_at / status), and no
-- function the API roles run deletes either, so DELETE goes on both. Hard
-- deletes stay available to the service role.

create or replace trigger trg_zz_item_stock_levels_guard
  before insert or update or delete on public.item_stock_levels
  for each row execute function public.tg_ledger_only_guard();

revoke delete on public.item_stock_levels from authenticated, anon;
revoke delete on public.locations, public.warehouses from authenticated, anon;

-- ── 3. purchase_orders: an API-role insert is a draft ───────────────────────
-- 0360's guard with its INSERT branch filled in. The PO form and the recurring
-- and import paths all create drafts or run as postgres/service_role; a PO is
-- then placed by "Mark as ordered", which carries the approval threshold.

create or replace function public.tg_purchase_orders_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  -- recompute_po_status inside the receipt RPCs (0359 raises the flag).
  if ledger.active() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    -- A new PO starts as a draft; ordering it goes through the lifecycle
    -- below (and the approval threshold), receiving through the receipts.
    if new.status is distinct from 'draft' then
      raise exception 'A new purchase order starts as a draft.'
        using errcode = '42501';
    end if;
    if new.ordered_at is not null or new.received_at is not null then
      raise exception 'A new purchase order has no ordered or received date.'
        using errcode = '42501';
    end if;
    -- Who created it and when are the database's to record (0360 keeps both
    -- fixed afterwards, so a supplied value would stand forever).
    new.created_by := auth.uid();
    new.updated_by := auth.uid();
    new.created_at := now();
    return new;
  end if;

  if new.organization_id is distinct from old.organization_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'A purchase order''s organization and creator cannot be changed.'
      using errcode = '42501';
  end if;
  if new.received_at is distinct from old.received_at then
    raise exception 'Received dates are set by posting receipts.'
      using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    if old.status = 'cancelled' then
      raise exception 'This purchase order was cancelled and cannot be reopened. Create a new one instead.'
        using errcode = '42501';
    elsif new.status = 'cancelled' then
      if old.status = 'received' then
        raise exception 'A fully received purchase order cannot be cancelled.'
          using errcode = '42501';
      end if;
    elsif new.status = 'ordered' then
      if old.status <> 'draft' then
        raise exception 'Only a draft purchase order can be marked as ordered.'
          using errcode = '42501';
      end if;
      -- An order with nothing on it is never meant (none exists), and it is
      -- what a PO edit racing this transition would leave behind.
      if not exists (select 1 from public.purchase_order_items i
                      where i.purchase_order_id = new.id
                        and i.organization_id = new.organization_id) then
        raise exception 'Add at least one line before marking this purchase order as ordered.'
          using errcode = '23514';
      end if;
      if public.po_over_approval_threshold(new.id, new.total) then
        raise exception 'This purchase order meets the approval threshold. Ask an owner or admin to place it.'
          using errcode = '42501';
      end if;
      new.ordered_at := now();
    elsif new.status = 'draft' then
      if old.status <> 'ordered'
         or exists (select 1 from public.purchase_order_items i
                     where i.purchase_order_id = new.id
                       and i.organization_id = new.organization_id
                       and i.quantity_received <> 0) then
        raise exception 'Only an ordered purchase order with nothing received can go back to draft.'
          using errcode = '42501';
      end if;
    else
      raise exception 'Receiving statuses are set by posting receipts.'
        using errcode = '42501';
    end if;
  elsif new.ordered_at is distinct from old.ordered_at then
    raise exception 'The ordered date is set by marking the purchase order as ordered.'
      using errcode = '42501';
  end if;

  if old.status <> 'draft'
     and (new.supplier_id, new.charter_id, new.subtotal, new.tax, new.shipping, new.total)
         is distinct from
         (old.supplier_id, old.charter_id, old.subtotal, old.tax, old.shipping, old.total) then
    raise exception 'Only a draft purchase order''s supplier, charter and amounts can be edited.'
      using errcode = '42501';
  end if;

  new.updated_by := auth.uid();
  return new;
end;
$$;

comment on function public.tg_purchase_orders_guard() is
  'BEFORE INSERT OR UPDATE guard (0360, insert rules 0364): API-role inserts are '
  'drafts with no ordered/received date and a database-recorded creator; status '
  'changes follow the PO lifecycle and the approval threshold, and a PO with no '
  'lines is never placed; amounts freeze after draft; receiving statuses and '
  'dates only through the receipt RPCs.';

revoke all on function public.tg_purchase_orders_guard() from public, anon, authenticated;

-- ── 4. purchase_order_items: lines only into a draft ────────────────────────
-- 0360's guard with the draft rule on INSERT. The PO editor adds lines only to
-- a draft it has just claimed with `status = 'draft'`, and receiving writes
-- quantity_received under the flag.
--
-- The parent's status is read with FOR SHARE and held to the end of the
-- line's transaction. "Mark as ordered" locks the PO row FOR NO KEY UPDATE,
-- which conflicts, so it waits for an in-flight line write and then checks
-- the threshold with that line committed; a line write that arrives after the
-- PO was placed re-reads 'ordered' and is refused. With a plain read, a line
-- inserted beside a concurrent "Mark as ordered" escaped both the draft rule
-- and the approval threshold. The lock needs a VOLATILE function (a STABLE
-- one may not lock rows), and SECURITY DEFINER so RLS on purchase_orders has
-- no say in which rows it can hold; it answers only for the caller's org.

create or replace function public.po_status_for_line_write(p_po_id uuid, p_org_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  if auth.uid() is not null and not public.is_org_member(p_org_id) then
    return null;
  end if;
  select p.status into v_status
    from public.purchase_orders p
   where p.id = p_po_id
     and p.organization_id = p_org_id
     for share;
  return v_status;
end;
$$;

comment on function public.po_status_for_line_write(uuid, uuid) is
  'The PO''s status, read FOR SHARE so the calling line write holds the PO until '
  'it commits (0364). Null for another org''s PO or a non-member.';

revoke all on function public.po_status_for_line_write(uuid, uuid) from public, anon;
grant execute on function public.po_status_for_line_write(uuid, uuid) to authenticated, service_role;

create or replace function public.tg_purchase_order_items_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_status text;
begin
  if current_user not in ('authenticated', 'anon') then
    return coalesce(new, old);
  end if;
  -- The receipt RPCs update quantity_received with the flag on.
  if ledger.active() then
    return coalesce(new, old);
  end if;

  if tg_op = 'UPDATE' then
    raise exception 'Purchase order lines change through the PO editor or by receiving.'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    if public.po_status_for_line_write(old.purchase_order_id, old.organization_id) is distinct from 'draft' then
      raise exception 'Lines can be removed only from a draft purchase order.'
        using errcode = '42501';
    end if;
    return old;
  end if;

  -- INSERT. The parent must be this org's PO (the write policy checks the
  -- row's organization_id only) and still a draft, the item this org's, and
  -- nothing received.
  v_status := public.po_status_for_line_write(new.purchase_order_id, new.organization_id);
  if v_status is null then
    raise exception 'That purchase order is not part of this organization.'
      using errcode = '42501';
  end if;
  if v_status <> 'draft' then
    raise exception 'Lines can be added only to a draft purchase order.'
      using errcode = '42501';
  end if;
  if new.item_id is null or not public.item_in_org(new.item_id, new.organization_id) then
    raise exception 'That item is not part of this organization.'
      using errcode = '42501';
  end if;
  if coalesce(new.quantity_received, 0) <> 0 then
    raise exception 'A new purchase order line starts with nothing received.'
      using errcode = '42501';
  end if;
  -- The PO form's own rule (quantity > 0, cost >= 0). A negative line would
  -- offset a real one in the approval threshold and in received-vs-ordered.
  if new.quantity_ordered is null or new.quantity_ordered <= 0
     or new.unit_cost is null or new.unit_cost < 0 then
    raise exception 'A purchase order line needs a quantity above 0 and a cost of 0 or more.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.tg_purchase_order_items_guard() is
  'BEFORE INSERT OR UPDATE OR DELETE guard (0360, draft rule 0364): API-role '
  'lines join only a draft PO of their own org (held FOR SHARE to commit) and an item of their own org, '
  'start unreceived, are positive (quantity > 0, cost >= 0), are never updated '
  'directly (receiving does that under the ledger flag), and leave only drafts.';

revoke all on function public.tg_purchase_order_items_guard() from public, anon, authenticated;

-- ── 5. purchase_order_charges: only approve_po_import_commit ────────────────
-- Every charge row in production came from import approval, which runs as
-- postgres. The SELECT policy and grant stay (the PO PDF reads them).

drop policy if exists purchase_order_charges_write on public.purchase_order_charges;
revoke insert, update, delete on public.purchase_order_charges from authenticated, anon;

-- ── 6. rentals, rental_lines: only the rental functions ─────────────────────
-- create_rental, return_rental and cancel_rental (0361) are SECURITY DEFINER;
-- the overdue cron uses the service role. Installed 1.4.0 phones check out
-- through /api/v1. Builds before 1.4.0 inserted a header-only rental directly
-- and now get "permission denied"; none has been active in 30 days. The
-- SELECT policies and grants stay (lists, realtime).

drop policy if exists rentals_insert on public.rentals;
drop policy if exists rentals_update on public.rentals;
drop policy if exists rentals_delete on public.rentals;
drop policy if exists rental_lines_insert on public.rental_lines;
drop policy if exists rental_lines_update on public.rental_lines;
drop policy if exists rental_lines_delete on public.rental_lines;
revoke insert, update, delete on public.rentals, public.rental_lines from authenticated, anon;

reset lock_timeout;
