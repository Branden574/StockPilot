-- 0091_low_stock_out_of_stock_crossing.sql
-- Bug fix (Notifications hunter, finding C1):
--
-- The low-stock writer from 0025 + 0060 only fires on the crossing edge
-- where old.quantity_on_hand was >= reorder_point and the new value is
-- < reorder_point. That misses one important real-world case:
--
--   Item is ALREADY below reorder (e.g. on hand 3, reorder 5). Two more
--   units leave the warehouse — on hand drops to 1. We don't re-notify
--   (good, we already pinged). Then the LAST unit ships — on hand drops
--   from 1 to 0. The user expects an "out of stock" alert and a fresh
--   notification, but the trigger silently returns because old (1) was
--   already below reorder (5).
--
-- This migration adds a second guard arm: if the row transitions from
-- > 0 to <= 0, fire an `inventory.out_of_stock` notification regardless
-- of where reorder_point sits (so items with no reorder_point set also
-- emit on going to zero). The original `inventory.low_stock` crossing
-- arm is preserved.
--
-- Idempotency: only the first crossing of each edge fires. Re-running an
-- update that doesn't change the boundary (e.g. 0 -> 0) is a no-op.

create or replace function public._notify_low_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
  link_url text;
  notif_title text;
  notif_body text;
  notif_type text;
  fire boolean := false;
begin
  -- Arm 1: low-stock crossing.
  --   reorder_point is set (> 0)
  --   AND previously at or above reorder
  --   AND now below reorder
  if new.reorder_point is not null
     and new.reorder_point > 0
     and old.quantity_on_hand >= new.reorder_point
     and new.quantity_on_hand <  new.reorder_point then
    fire := true;
    if new.quantity_on_hand <= 0 then
      notif_type  := 'inventory.out_of_stock';
      link_url    := '/dashboard/inventory?stock=out&type=all';
      notif_title := new.name || ' is out of stock';
      notif_body  := 'Quantity dropped to 0. Consider restocking.';
    else
      notif_type  := 'inventory.low_stock';
      link_url    := '/dashboard/inventory?stock=low&type=all';
      notif_title := new.name || ' is below reorder point';
      notif_body  := 'On hand ' || new.quantity_on_hand::text ||
                     ' / reorder at ' || new.reorder_point::text || '.';
    end if;
  -- Arm 2: out-of-stock crossing while already below reorder (or with
  -- no reorder_point set). Fires when on-hand transitions strictly
  -- positive -> zero or negative.
  elsif old.quantity_on_hand > 0
     and new.quantity_on_hand <= 0 then
    fire := true;
    notif_type  := 'inventory.out_of_stock';
    link_url    := '/dashboard/inventory?stock=out&type=all';
    notif_title := new.name || ' is out of stock';
    notif_body  := 'Quantity dropped to 0. Consider restocking.';
  end if;

  if not fire then
    return new;
  end if;

  for rec in select user_id from public._notify_recipients(new.organization_id) loop
    insert into public.notifications (
      organization_id, user_id, type, title, body, link, metadata
    ) values (
      new.organization_id,
      rec.user_id,
      notif_type,
      notif_title,
      notif_body,
      link_url,
      jsonb_build_object(
        'item_id', new.id,
        'sku', new.sku,
        'quantity_on_hand', new.quantity_on_hand,
        'reorder_point', new.reorder_point
      )
    );
  end loop;
  return new;
end;
$$;
