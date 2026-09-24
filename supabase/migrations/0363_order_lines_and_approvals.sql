-- 0363_order_lines_and_approvals.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Two direct-write gaps outside the stock tables. Every rule here is one the
-- app already follows; no app change.
--
-- 1. order_request_lines. The INSERT policy lets the order's requester (or a
--    manager / orders:approve holder) add a line, but it lost the status gate
--    0049 had (0078), and it checks no column. So a requester could:
--      * add lines to an order that has shipped, completed, been denied or
--        been cancelled (loadEditableOrderHeader refuses exactly these);
--      * insert a line with quantity_fulfilled / quantity_picked /
--        returned_quantity already set: a line "fulfilled" that never
--        shipped, which the return flow will then restock (stock minted);
--      * set unit_cost_at_request or unit_price_at_request to anything.
--    The policy gets the service's status gate back (NOT 0049's
--    = 'pending_approval', which would break adding items at nine statuses the
--    app allows), and a guard makes an API-role line start unfulfilled, with
--    its cost snapshot taken from the item. UPDATE and DELETE policies are
--    already false; the grants follow. The SECURITY DEFINER order RPCs and the
--    service role (public order route, portal, line merges) are unaffected.
--
-- 2. approvals. Nothing reads or writes this table (no app code, no SQL
--    function, no cron), yet approvals_insert (TO public) lets any member
--    insert a row, including one already 'approved', and approvals_admin_decide
--    lets an admin rewrite any row. Writes are closed; the SELECT policy stays.

-- ── 1. order_request_lines ──────────────────────────────────────────────────

alter policy order_request_lines_insert on public.order_request_lines
  with check (
    exists (
      select 1
        from public.order_requests r
        join public.inventory_items ii
          on ii.id = order_request_lines.item_id
         and ii.organization_id = r.organization_id
       where r.id = order_request_lines.order_request_id
         and ((r.requester_user_id = (select auth.uid()))
              or (select public.has_org_role(r.organization_id, 'manager'))
              or (select public.has_permission(r.organization_id, 'orders:approve')))
         and ii.warehouse_id = r.warehouse_id
         -- 0363: the service's ship gate (loadEditableOrderHeader).
         and r.status not in ('in_transit', 'completed', 'denied', 'cancelled')
    )
  );

create or replace function public.tg_order_request_lines_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if coalesce(new.quantity_fulfilled, 0) <> 0
     or coalesce(new.returned_quantity, 0) <> 0
     or new.quantity_picked is not null or new.picked_at is not null or new.picked_by is not null
     or new.quantity_packed is not null or new.packed_at is not null or new.packed_by is not null
     or new.unit_price_at_request is not null then
    raise exception 'A new order line starts unfulfilled; picking, packing, fulfilment and pricing are recorded by the order workflow.'
      using errcode = '42501';
  end if;
  -- The cost snapshot is the item's cost, as the service records it.
  new.unit_cost_at_request := coalesce(
    (select ii.unit_cost from public.inventory_items ii where ii.id = new.item_id), 0);
  return new;
end;
$$;

comment on function public.tg_order_request_lines_guard() is
  'BEFORE INSERT guard (0363): an API-role order line starts unfulfilled and '
  'unpriced, with its cost snapshot taken from the item.';

drop trigger if exists trg_zz_order_request_lines_guard on public.order_request_lines;
create trigger trg_zz_order_request_lines_guard
  before insert on public.order_request_lines
  for each row execute function public.tg_order_request_lines_guard();

revoke all on function public.tg_order_request_lines_guard() from public, anon, authenticated;
revoke update, delete, truncate, trigger, references on public.order_request_lines from authenticated, anon;
revoke insert on public.order_request_lines from anon;

-- ── 2. approvals ────────────────────────────────────────────────────────────

drop policy if exists approvals_insert on public.approvals;
drop policy if exists approvals_admin_decide on public.approvals;
revoke insert, update, delete, truncate, trigger, references on public.approvals from authenticated, anon;
