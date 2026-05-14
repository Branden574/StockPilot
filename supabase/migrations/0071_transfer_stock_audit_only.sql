-- 0071_transfer_stock_audit_only.sql
-- Per user decision: `transfer_stock` becomes audit-only. The
-- previous implementation wrote to `item_stock_levels` only (NOT
-- `quantity_on_hand`), but every consumer in the app reads
-- `quantity_on_hand` — so transfers were silently invisible to the
-- dashboard, low-stock count, and exports. Half-built feature.
--
-- This version logs the transfer intent to `stock_movements` (so
-- the audit trail records who moved what when), validates basic
-- constraints, but does NOT mutate any stock totals. A future
-- per-location-quantity feature can replace this with the full
-- two-table mutation.
--
-- Behavior change: callers that were relying on item_stock_levels
-- to reflect their transfers will see those rows stop updating.
-- (Nothing in the StockPilot codebase reads item_stock_levels, so
-- this is a no-op for end users.)

create or replace function public.transfer_stock(
  p_item_id           uuid,
  p_from_location_id  uuid,
  p_to_location_id    uuid,
  p_quantity          numeric,
  p_notes             text default null
)
returns public.inventory_items
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_item public.inventory_items%rowtype;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity_must_be_positive' using errcode = '22023';
  end if;
  if p_from_location_id = p_to_location_id then
    raise exception 'same_location' using errcode = '22023';
  end if;

  select * into v_item
    from public.inventory_items
    where id = p_item_id
    for update;
  if not found then raise exception 'item_not_found' using errcode = 'P0002'; end if;
  if v_item.deleted_at is not null then
    raise exception 'item_deleted' using errcode = 'P0002';
  end if;
  if not public.has_org_role(v_item.organization_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Audit-only: log the transfer intent. Stock totals stay untouched
  -- because the rest of the app reads `quantity_on_hand` and the old
  -- item_stock_levels write was dead-data divergence.
  insert into public.stock_movements (
    organization_id, item_id, movement_type,
    quantity_change, previous_quantity, new_quantity,
    from_location_id, to_location_id, notes, user_id
  ) values (
    v_item.organization_id, v_item.id, 'transfer',
    0, v_item.quantity_on_hand, v_item.quantity_on_hand,
    p_from_location_id, p_to_location_id, p_notes, auth.uid()
  );

  return v_item;
end;
$$;
