-- 0060_fix_low_stock_notification_link.sql
-- Bug fix: the low-stock notification's `link` column used to point at
-- the item-detail page (`/dashboard/inventory/<uuid>`), but users
-- clicking the notification expected to land on the filtered list of
-- everything that's currently at or below reorder point. The dashboard
-- tile already routes to `/dashboard/inventory?stock=low&type=all` (and
-- `?stock=out&type=all` for out-of-stock); align the notification link
-- with the same filter so the click consistently surfaces the rows the
-- user needs to act on.
--
-- This is an `or replace` on an existing function — existing grants and
-- the trigger binding from 0025 persist; no extra grant statements
-- needed.

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
begin
  -- Only act on the crossing edge: previously >= reorder, now < reorder.
  if new.reorder_point is null or new.reorder_point <= 0 then
    return new;
  end if;
  if old.quantity_on_hand >= new.reorder_point then
    if new.quantity_on_hand < new.reorder_point then
      if new.quantity_on_hand <= 0 then
        link_url := '/dashboard/inventory?stock=out&type=all';
        notif_title := new.name || ' is out of stock';
        notif_body := 'Quantity dropped to 0. Consider restocking.';
      else
        link_url := '/dashboard/inventory?stock=low&type=all';
        notif_title := new.name || ' is below reorder point';
        notif_body := 'On hand ' || new.quantity_on_hand::text ||
                      ' / reorder at ' || new.reorder_point::text || '.';
      end if;
      for rec in select user_id from public._notify_recipients(new.organization_id) loop
        insert into public.notifications (
          organization_id, user_id, type, title, body, link, metadata
        ) values (
          new.organization_id,
          rec.user_id,
          case when new.quantity_on_hand <= 0 then 'inventory.out_of_stock'
               else 'inventory.low_stock' end,
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
    end if;
  end if;
  return new;
end;
$$;
