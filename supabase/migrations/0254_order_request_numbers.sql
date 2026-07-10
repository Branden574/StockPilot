-- 0254: human-friendly per-org order numbers.
--
-- The orders list showed no identifier, so nobody could say "order #142"
-- on the phone or find one quickly. Adds order_requests.order_number:
-- sequential PER ORG (each tenant starts at 1), assigned by trigger at
-- insert under a per-org advisory xact lock (safe under concurrent
-- submits — two simultaneous orders can't draw the same number).
alter table public.order_requests
  add column if not exists order_number bigint;

-- Backfill existing orders in created_at order so history reads naturally.
-- The 0110 delivery-target check is NOT VALID (legacy rows grandfathered),
-- but any UPDATE re-evaluates it and pre-0110 rows (e.g. a denied delivery
-- order with no charter) would abort the backfill. Drop + re-add NOT VALID
-- around the backfill — semantics unchanged (new writes still checked,
-- legacy rows stay grandfathered).
alter table public.order_requests
  drop constraint if exists order_requests_delivery_target_chk;

with numbered as (
  select id,
         row_number() over (partition by organization_id order by created_at, id) as rn
  from public.order_requests
)
update public.order_requests o
set order_number = n.rn
from numbered n
where o.id = n.id
  and o.order_number is null;

alter table public.order_requests
  add constraint order_requests_delivery_target_chk
  check (
    (fulfillment_type = 'delivery' and delivery_charter_id is not null)
    or (fulfillment_type = 'pickup' and delivery_charter_id is null)
  ) not valid;

create or replace function public.assign_order_request_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.order_number is not null then
    return new; -- explicit numbers (imports/restores) pass through
  end if;
  -- Serialize number assignment per org for the duration of this txn.
  perform pg_advisory_xact_lock(hashtext('order_number:' || new.organization_id::text));
  select coalesce(max(order_number), 0) + 1
    into new.order_number
    from public.order_requests
   where organization_id = new.organization_id;
  return new;
end;
$$;

drop trigger if exists trg_assign_order_request_number on public.order_requests;
create trigger trg_assign_order_request_number
  before insert on public.order_requests
  for each row execute function public.assign_order_request_number();

alter table public.order_requests
  alter column order_number set not null;

create unique index if not exists order_requests_org_number_uniq
  on public.order_requests (organization_id, order_number);
