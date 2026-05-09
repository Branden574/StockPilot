-- ============================================================================
-- 0044_order_requests.sql — Internal + public order-request system
-- ============================================================================
-- Adds three tables:
--   • order_requests           — header rows (one per submitted request)
--   • order_request_lines      — items + quantities per request
--   • stock_reservations       — soft holds against inventory created on
--                                approval, released on delivery or cancel
-- Plus columns on organizations + warehouses for the persistent public
-- link feature, and three SQL functions that enforce the state machine
-- atomically (approve / deliver / cancel).
--
-- See docs/superpowers/specs/2026-05-08-order-requests-design.md for
-- the full design rationale.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- order_requests
-- ----------------------------------------------------------------------------
create table public.order_requests (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id) on delete cascade,
  warehouse_id         uuid not null references public.warehouses(id) on delete restrict,
  status               text not null default 'pending_approval'
                         check (status in (
                           'pending_approval','approved','packaging',
                           'ready_for_delivery','delivered',
                           'denied','cancelled'
                         )),

  -- Identity. Internal request → user_id; public link → email.
  requester_user_id    uuid references public.user_profiles(id) on delete set null,
  requester_email      text,
  requester_name       text,
  requester_org_label  text,

  -- Approval audit
  approved_by          uuid references public.user_profiles(id) on delete set null,
  approved_at          timestamptz,
  denied_reason        text,

  -- Status timestamps
  packaging_at         timestamptz,
  ready_at             timestamptz,
  delivered_at         timestamptz,
  cancelled_at         timestamptz,
  cancelled_by         uuid references public.user_profiles(id) on delete set null,

  notes                text,           -- requester's note
  internal_notes       text,           -- manager-only

  source               text not null default 'internal'
                         check (source in ('internal','public_link')),

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  -- Exactly one identity path is set for the source.
  constraint order_requests_identity_chk check (
    (source = 'internal' and requester_user_id is not null) or
    (source = 'public_link' and requester_email is not null)
  )
);

create trigger order_requests_set_updated_at
  before update on public.order_requests
  for each row execute function public.tg_set_updated_at();

create index order_requests_org_status_idx
  on public.order_requests(organization_id, status, created_at desc);
create index order_requests_requester_idx
  on public.order_requests(requester_user_id)
  where requester_user_id is not null;
create index order_requests_pending_idx
  on public.order_requests(organization_id)
  where status = 'pending_approval';
create index order_requests_warehouse_idx
  on public.order_requests(warehouse_id);

-- ----------------------------------------------------------------------------
-- order_request_lines
-- ----------------------------------------------------------------------------
create table public.order_request_lines (
  id                   uuid primary key default gen_random_uuid(),
  order_request_id     uuid not null references public.order_requests(id) on delete cascade,
  item_id              uuid not null references public.inventory_items(id) on delete restrict,
  quantity_requested   numeric(14,4) not null check (quantity_requested > 0),
  quantity_fulfilled   numeric(14,4) not null default 0,
  unit_cost_at_request numeric(14,4) not null default 0,
  notes                text,
  created_at           timestamptz not null default now()
);

create index order_request_lines_order_idx on public.order_request_lines(order_request_id);
create index order_request_lines_item_idx  on public.order_request_lines(item_id);

-- ----------------------------------------------------------------------------
-- stock_reservations — soft holds released on delivery / cancel
-- ----------------------------------------------------------------------------
create table public.stock_reservations (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id) on delete cascade,
  item_id              uuid not null references public.inventory_items(id) on delete cascade,
  warehouse_id         uuid not null references public.warehouses(id) on delete cascade,
  order_request_id     uuid references public.order_requests(id) on delete cascade,
  quantity             numeric(14,4) not null check (quantity > 0),
  released_at          timestamptz,
  released_reason      text,
  created_at           timestamptz not null default now()
);

create index stock_reservations_active_idx
  on public.stock_reservations(organization_id, item_id)
  where released_at is null;
create index stock_reservations_order_idx
  on public.stock_reservations(order_request_id);

-- ----------------------------------------------------------------------------
-- organizations + warehouses additions
-- ----------------------------------------------------------------------------
alter table public.organizations
  add column if not exists public_request_token text,
  add column if not exists public_request_token_rotated_at timestamptz,
  add column if not exists public_request_blurb text;

create unique index if not exists organizations_public_request_token_idx
  on public.organizations(public_request_token)
  where public_request_token is not null;

alter table public.warehouses
  add column if not exists is_public_orderable boolean not null default false;

-- ============================================================================
-- RLS — read by org members; insert by member; update by member (service
-- enforces field-level + status-transition rules; SQL functions are the
-- only writers for stock_reservations + the SQL stock-mutation paths).
-- ============================================================================
alter table public.order_requests       enable row level security;
alter table public.order_request_lines  enable row level security;
alter table public.stock_reservations   enable row level security;

create policy order_requests_select on public.order_requests
  for select to authenticated
  using (public.is_org_member(organization_id));

create policy order_requests_insert on public.order_requests
  for insert to authenticated
  with check (
    public.is_org_member(organization_id)
    and source = 'internal'
    and requester_user_id = auth.uid()
  );

create policy order_requests_update on public.order_requests
  for update to authenticated
  using (public.is_org_member(organization_id));

create policy order_request_lines_select on public.order_request_lines
  for select to authenticated
  using (
    exists (
      select 1 from public.order_requests r
      where r.id = order_request_lines.order_request_id
        and public.is_org_member(r.organization_id)
    )
  );

create policy order_request_lines_insert on public.order_request_lines
  for insert to authenticated
  with check (
    exists (
      select 1 from public.order_requests r
      where r.id = order_request_lines.order_request_id
        and r.requester_user_id = auth.uid()
    )
  );

create policy stock_reservations_select on public.stock_reservations
  for select to authenticated
  using (public.is_org_member(organization_id));

-- No insert/update policies for stock_reservations — only SECURITY DEFINER
-- SQL functions touch this table, so the public role has zero direct write
-- access. Public-link inserts also go through the admin client.

-- ============================================================================
-- approve_order_request — atomic approval with availability check
-- ============================================================================
create or replace function public.approve_order_request(p_id uuid)
returns public.order_requests
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_req public.order_requests%rowtype;
  v_line record;
  v_active_reserved numeric(14,4);
  v_user uuid := auth.uid();
begin
  select * into v_req from public.order_requests where id = p_id for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;
  if not public.has_org_role(v_req.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_req.status <> 'pending_approval' then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;

  for v_line in
    select l.id as line_id, l.item_id, l.quantity_requested,
           ii.quantity_on_hand, ii.warehouse_id as item_warehouse
    from public.order_request_lines l
    join public.inventory_items ii on ii.id = l.item_id
    where l.order_request_id = p_id
    order by l.item_id
    for update of ii
  loop
    if v_line.item_warehouse is distinct from v_req.warehouse_id then
      raise exception 'item_warehouse_mismatch'
        using errcode = 'P0001', detail = v_line.item_id::text;
    end if;
    select coalesce(sum(quantity), 0) into v_active_reserved
    from public.stock_reservations
    where item_id = v_line.item_id and released_at is null;
    if v_line.quantity_requested >
       greatest(0, v_line.quantity_on_hand - v_active_reserved) then
      raise exception 'insufficient_stock'
        using errcode = 'P0001', detail = v_line.item_id::text;
    end if;
  end loop;

  insert into public.stock_reservations (
    organization_id, item_id, warehouse_id, order_request_id, quantity
  )
  select v_req.organization_id, l.item_id, v_req.warehouse_id, p_id, l.quantity_requested
  from public.order_request_lines l
  where l.order_request_id = p_id;

  update public.order_requests
    set status='approved',
        approved_by = v_user,
        approved_at = now()
    where id = p_id;

  return (select * from public.order_requests where id = p_id);
end;
$$;

-- ============================================================================
-- deliver_order_request — fires stock_movements, releases reservations
-- ============================================================================
create or replace function public.deliver_order_request(p_id uuid)
returns public.order_requests
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_req public.order_requests%rowtype;
  v_line record;
  v_user uuid := auth.uid();
  v_prev numeric(14,4);
  v_new  numeric(14,4);
begin
  select * into v_req from public.order_requests where id = p_id for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;
  if not public.has_org_role(v_req.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_req.status not in ('approved','packaging','ready_for_delivery') then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;

  for v_line in
    select l.id as line_id, l.item_id, l.quantity_requested,
           ii.quantity_on_hand
    from public.order_request_lines l
    join public.inventory_items ii on ii.id = l.item_id
    where l.order_request_id = p_id
    order by l.item_id
    for update of ii
  loop
    if v_line.quantity_requested > v_line.quantity_on_hand then
      raise exception 'insufficient_stock'
        using errcode = 'P0001', detail = v_line.item_id::text;
    end if;
    v_prev := v_line.quantity_on_hand;
    v_new  := v_prev - v_line.quantity_requested;
    update public.inventory_items
      set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
      where id = v_line.item_id;
    insert into public.stock_movements (
      organization_id, item_id, movement_type,
      quantity_change, previous_quantity, new_quantity,
      reason, reference_type, reference_id, user_id
    ) values (
      v_req.organization_id, v_line.item_id, 'remove',
      -v_line.quantity_requested, v_prev, v_new,
      'order_delivered', 'order_request', p_id, v_user
    );
    update public.order_request_lines
      set quantity_fulfilled = v_line.quantity_requested
      where id = v_line.line_id;
  end loop;

  update public.stock_reservations
    set released_at = now(), released_reason = 'delivered'
    where order_request_id = p_id and released_at is null;

  update public.order_requests
    set status='delivered', delivered_at = now()
    where id = p_id;

  return (select * from public.order_requests where id = p_id);
end;
$$;

-- ============================================================================
-- cancel_order_request — caller-aware cancel; releases reservations
-- ============================================================================
create or replace function public.cancel_order_request(
  p_id uuid,
  p_reason text default null
)
returns public.order_requests
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_req public.order_requests%rowtype;
  v_user uuid := auth.uid();
  v_is_manager boolean;
  v_is_owner boolean;
begin
  select * into v_req from public.order_requests where id = p_id for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;
  if v_req.status in ('delivered','denied','cancelled') then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;

  v_is_manager := public.has_org_role(v_req.organization_id, 'manager');
  v_is_owner   := v_req.requester_user_id = v_user;
  if not v_is_manager and not v_is_owner then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.stock_reservations
    set released_at = now(), released_reason = 'cancelled'
    where order_request_id = p_id and released_at is null;

  update public.order_requests
    set status = 'cancelled',
        cancelled_at = now(),
        cancelled_by = v_user,
        denied_reason = coalesce(p_reason, denied_reason)
    where id = p_id;

  return (select * from public.order_requests where id = p_id);
end;
$$;

-- ============================================================================
-- Notification writer — fires bell + push for managers (on new request) and
-- requester (on every other transition). Email is sent from the TS service.
-- ============================================================================
create or replace function public._notify_order_request_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link text;
  v_title text;
  v_body text;
  v_recipient uuid;
  v_recipients_loop record;
  v_metadata jsonb;
begin
  v_link := '/dashboard/orders/' || new.id::text;
  v_metadata := jsonb_build_object(
    'order_request_id', new.id,
    'warehouse_id', new.warehouse_id,
    'source', new.source,
    'requester_user_id', new.requester_user_id,
    'requester_email', new.requester_email
  );

  if (tg_op = 'INSERT') then
    -- New request → ping every notify-eligible org member.
    v_title := 'New order request' ||
               case when new.requester_name is not null
                    then ' from ' || new.requester_name else '' end;
    v_body := 'A request is waiting for approval.';
    for v_recipients_loop in
      select user_id from public._notify_recipients(new.organization_id)
    loop
      insert into public.notifications (
        organization_id, user_id, type, title, body, link, metadata
      ) values (
        new.organization_id, v_recipients_loop.user_id,
        'order_request.created', v_title, v_body, v_link, v_metadata
      );
    end loop;
    return new;
  end if;

  if (tg_op = 'UPDATE') then
    -- Status transitions only.
    if old.status is not distinct from new.status then
      return new;
    end if;

    -- Cancel-after-approval by the requester → notify managers, not the
    -- requester (they did it).
    if new.status = 'cancelled'
       and old.status in ('approved','packaging','ready_for_delivery')
       and new.cancelled_by is not null
       and not public.has_org_role(new.organization_id, 'manager')
    then
      v_title := 'Order request cancelled after approval';
      v_body := 'Reservation was released. Stop packaging if you started.';
      for v_recipients_loop in
        select user_id from public._notify_recipients(new.organization_id)
      loop
        insert into public.notifications (
          organization_id, user_id, type, title, body, link, metadata
        ) values (
          new.organization_id, v_recipients_loop.user_id,
          'order_request.cancelled_after_approval',
          v_title, v_body, v_link, v_metadata
        );
      end loop;
      return new;
    end if;

    -- Notify the requester on transitions they care about.
    -- (Public-link requesters get email-only; bell only fires when
    -- there's a real user_id.)
    v_recipient := new.requester_user_id;
    if v_recipient is null then
      return new;
    end if;

    case new.status
      when 'approved' then
        v_title := 'Your order request was approved';
        v_body := 'Stock has been reserved.';
      when 'denied' then
        v_title := 'Your order request was denied';
        v_body := coalesce(new.denied_reason, 'See the order page for details.');
      when 'packaging' then
        v_title := 'Your order is being packaged';
        v_body := 'Items are being pulled now.';
      when 'ready_for_delivery' then
        v_title := 'Your order is ready';
        v_body := 'Pickup or delivery is queued.';
      when 'delivered' then
        v_title := 'Your order was delivered';
        v_body := 'Inventory was updated.';
      when 'cancelled' then
        v_title := 'Your order was cancelled';
        v_body := coalesce(new.denied_reason, 'See the order page for details.');
      else
        return new;
    end case;

    insert into public.notifications (
      organization_id, user_id, type, title, body, link, metadata
    ) values (
      new.organization_id, v_recipient,
      'order_request.' || new.status,
      v_title, v_body, v_link, v_metadata
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_order_requests_notify on public.order_requests;
create trigger trg_order_requests_notify
  after insert or update on public.order_requests
  for each row execute function public._notify_order_request_changes();

grant execute on function public.approve_order_request(uuid) to authenticated;
grant execute on function public.deliver_order_request(uuid) to authenticated;
grant execute on function public.cancel_order_request(uuid, text) to authenticated;

-- Surface order_requests to realtime so the queue UI updates without
-- manual refresh (same pattern as 0024 + 0043).
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  begin
    alter publication supabase_realtime add table public.order_requests;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.stock_reservations;
  exception when duplicate_object then null;
  end;
end$$;
