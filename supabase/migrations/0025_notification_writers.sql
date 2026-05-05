-- 0025_notification_writers.sql
-- Pipeline that fans state-change events into rows in public.notifications.
-- This makes the "Notification history" tab on the dashboard come alive
-- without any client-side polling. RLS already restricts each user to their
-- own rows, so there's no extra access work here.

-- ─────────────────────────────────────────────────────────────────────
-- Helper: who should receive an org-level notification.
-- For now: every member with role in (owner, admin, manager). Future
-- iterations can scope to warehouse assignments when we have a clean
-- "alerting role" concept.
-- ─────────────────────────────────────────────────────────────────────

create or replace function public._notify_recipients(p_org uuid)
returns table(user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select om.user_id
  from public.organization_members om
  where om.organization_id = p_org
    and om.accepted_at is not null
    and om.role in ('owner', 'admin', 'manager');
$$;

-- ─────────────────────────────────────────────────────────────────────
-- Low-stock writer: fires after an inventory_items update if the row
-- crossed below its reorder_point. Idempotent on the same crossing
-- (won't re-spam if quantity dips/rises within the danger zone) — we
-- only fire on the *crossing* edge.
-- ─────────────────────────────────────────────────────────────────────

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
      link_url := '/dashboard/inventory/' || new.id::text;
      if new.quantity_on_hand <= 0 then
        notif_title := new.name || ' is out of stock';
        notif_body := 'Quantity dropped to 0. Consider restocking.';
      else
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

drop trigger if exists trg_inventory_items_low_stock on public.inventory_items;
create trigger trg_inventory_items_low_stock
  after update of quantity_on_hand, reorder_point on public.inventory_items
  for each row execute function public._notify_low_stock();

-- ─────────────────────────────────────────────────────────────────────
-- PO status writer: fires when status changes. Sends a notification
-- to the PO creator + the org's notification recipients.
-- ─────────────────────────────────────────────────────────────────────

create or replace function public._notify_po_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  link_url text;
  notif_title text;
  notif_body text;
begin
  if old.status is null or new.status is null then
    return new;
  end if;
  if old.status = new.status then
    return new;
  end if;

  link_url := '/dashboard/purchase-orders/' || new.id::text;
  notif_title := 'PO ' || coalesce(new.po_number, new.id::text) ||
                 ' is now ' || new.status;
  notif_body := 'Status changed from ' || old.status || ' to ' || new.status || '.';

  -- Recipients: creator (always) + every notify-eligible org member.
  for uid in
    select distinct u
    from (
      select new.created_by as u
      union
      select user_id from public._notify_recipients(new.organization_id)
    ) s
    where u is not null
  loop
    insert into public.notifications (
      organization_id, user_id, type, title, body, link, metadata
    ) values (
      new.organization_id,
      uid,
      'purchase_order.status_changed',
      notif_title,
      notif_body,
      link_url,
      jsonb_build_object(
        'po_id', new.id,
        'po_number', new.po_number,
        'from_status', old.status,
        'to_status', new.status
      )
    );
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_purchase_orders_status on public.purchase_orders;
create trigger trg_purchase_orders_status
  after update of status on public.purchase_orders
  for each row execute function public._notify_po_status();

grant execute on function public._notify_recipients(uuid) to authenticated;
