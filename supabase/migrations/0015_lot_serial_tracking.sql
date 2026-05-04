-- 0015_lot_serial_tracking.sql
-- ─────────────────────────────────────────────────────────────────────
-- Lot + serial tracking on receipts.
--
-- inventory_items.tracking_type:
--   'none'    — default; receipt accepts a quantity, no extra metadata
--   'lot'     — receipt requires one or more lot numbers; sum of lot
--               quantities must equal qty_accepted_base
--   'serial'  — receipt requires N distinct serial numbers (N = qty_accepted)
--               and the (org, item, serial) tuple must be unique forever
--
-- Extends post_receipt_v2 RPC to validate + persist the lot/serial inputs
-- transactionally with the receipt itself.
-- ─────────────────────────────────────────────────────────────────────

set check_function_bodies = off;

-- ─────────────────────────────────────────────────────────────────────
-- inventory_items.tracking_type
-- ─────────────────────────────────────────────────────────────────────
alter table public.inventory_items
  add column if not exists tracking_type text not null default 'none'
    check (tracking_type in ('none', 'lot', 'serial'));

create index if not exists inventory_items_tracking_type_idx
  on public.inventory_items(tracking_type)
  where tracking_type <> 'none';

-- ─────────────────────────────────────────────────────────────────────
-- receipt_line_lots
-- One receipt line for a lot-tracked item produces N rows here, one per
-- distinct lot number captured at receive time. Sum of qty_base must equal
-- the receipt_line's qty_accepted_base (enforced by post_receipt_v2 RPC).
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.receipt_line_lots (
  id              uuid primary key default gen_random_uuid(),
  receipt_line_id uuid not null references public.receipt_lines(id) on delete cascade,
  lot_number      text not null,
  expiration_date date,
  qty_base        numeric(18,4) not null check (qty_base > 0),
  created_at      timestamptz not null default now()
);

create index if not exists receipt_line_lots_line_idx
  on public.receipt_line_lots(receipt_line_id);
create index if not exists receipt_line_lots_lot_idx
  on public.receipt_line_lots(lot_number);

alter table public.receipt_line_lots enable row level security;

drop policy if exists receipt_line_lots_select on public.receipt_line_lots;
create policy receipt_line_lots_select on public.receipt_line_lots
  for select using (
    exists (
      select 1
      from public.receipt_lines rl
      join public.receipts r on r.id = rl.receipt_id
      where rl.id = receipt_line_lots.receipt_line_id
        and exists (
          select 1 from public.organization_members m
          where m.user_id = auth.uid()
            and m.organization_id = r.organization_id
            and m.accepted_at is not null
        )
    )
  );

drop policy if exists receipt_line_lots_write on public.receipt_line_lots;
create policy receipt_line_lots_write on public.receipt_line_lots
  for all using (
    exists (
      select 1
      from public.receipt_lines rl
      join public.receipts r on r.id = rl.receipt_id
      where rl.id = receipt_line_lots.receipt_line_id
        and public.has_org_role(r.organization_id, 'manager')
    )
  );

-- ─────────────────────────────────────────────────────────────────────
-- serial_registry
-- (organization_id, item_id, serial_number) globally unique. Receiving the
-- same serial twice is rejected with code 23505 → service maps to
-- 'duplicate serial'.
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.serial_registry (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  item_id          uuid not null references public.inventory_items(id) on delete restrict,
  serial_number    text not null,
  warehouse_id     uuid not null references public.warehouses(id) on delete restrict,
  current_status   text not null default 'available'
                     check (current_status in ('available','reserved','damaged','rejected','sold','rma')),
  receipt_line_id  uuid references public.receipt_lines(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, item_id, serial_number)
);

create index if not exists serial_registry_item_idx
  on public.serial_registry(organization_id, item_id);
create index if not exists serial_registry_warehouse_idx
  on public.serial_registry(warehouse_id);

create trigger serial_registry_updated_at
  before update on public.serial_registry
  for each row execute function public.tg_set_updated_at();

alter table public.serial_registry enable row level security;

drop policy if exists serial_registry_select on public.serial_registry;
create policy serial_registry_select on public.serial_registry
  for select using (
    exists (
      select 1 from public.organization_members m
      where m.user_id = auth.uid()
        and m.organization_id = serial_registry.organization_id
        and m.accepted_at is not null
    )
  );

drop policy if exists serial_registry_write on public.serial_registry;
create policy serial_registry_write on public.serial_registry
  for all using (public.has_org_role(organization_id, 'manager'));

-- ─────────────────────────────────────────────────────────────────────
-- post_receipt_v2 — extended with lots[] / serials[] per line
--
-- New per-line jsonb fields:
--   lots     — array of {lot_number, expiration_date?, qty_base}
--   serials  — array of strings (one per accepted unit)
--
-- Validation:
--   item.tracking_type='none'   → lots/serials ignored
--   item.tracking_type='lot'    → require at least one lot, sum equals qty_accepted
--   item.tracking_type='serial' → require qty_accepted distinct serials, all unique
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.post_receipt_v2(
  p_purchase_order_id uuid,
  p_warehouse_id      uuid,
  p_lines             jsonb,
  p_idempotency_key   text,
  p_request_hash      text,
  p_notes             text default null
)
returns public.receipts
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_receipt   public.receipts%rowtype;
  v_existing  public.idempotency_keys%rowtype;
  v_line      record;
  v_po        public.purchase_orders%rowtype;
  v_org       uuid;
  v_item_id   uuid;
  v_tracking  text;
  v_inserted_line uuid;
  v_lot       record;
  v_serial    text;
  v_lot_sum   numeric;
  v_serial_count int;
begin
  select * into v_po from public.purchase_orders where id = p_purchase_order_id for update;
  if not found then raise exception 'po_not_found' using errcode = 'P0002'; end if;
  v_org := v_po.organization_id;

  select * into v_existing
    from public.idempotency_keys
    where organization_id = v_org
      and scope = 'receipt'
      and key = p_idempotency_key
    for update;
  if found then
    if v_existing.request_hash = p_request_hash then
      select * into v_receipt from public.receipts where id = v_existing.resource_id;
      return v_receipt;
    else
      raise exception 'idempotency_conflict' using errcode = '40001';
    end if;
  end if;

  if not public.has_org_role(v_org, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_po.status not in ('draft','expected_inbound','ordered','partially_received') then
    raise exception 'po_already_closed' using errcode = '22023';
  end if;

  insert into public.receipts(
    organization_id, purchase_order_id, warehouse_id, receipt_number,
    received_by, idempotency_key, immutable_hash, notes
  ) values (
    v_org, v_po.id, p_warehouse_id,
    'R-' || to_char(now(),'YYYYMMDD-HH24MISS') || '-' || substr(gen_random_uuid()::text, 1, 6),
    auth.uid(), p_idempotency_key,
    encode(digest(p_request_hash, 'sha256'), 'hex'),
    p_notes
  ) returning * into v_receipt;

  for v_line in select * from jsonb_to_recordset(p_lines) as x(
    po_line_id uuid, qty_received numeric, qty_accepted numeric,
    qty_rejected numeric, unit_cost numeric, notes text,
    lots jsonb, serials jsonb
  ) loop
    select item_id into v_item_id
      from public.purchase_order_items
      where id = v_line.po_line_id
        and purchase_order_id = v_po.id
      for update;
    if not found then
      raise exception 'po_line_not_found' using errcode = 'P0002';
    end if;

    select tracking_type into v_tracking
      from public.inventory_items where id = v_item_id;

    -- Validate tracking-type-specific inputs BEFORE doing any writes.
    if v_tracking = 'lot' then
      if v_line.qty_accepted > 0 then
        if v_line.lots is null or jsonb_array_length(v_line.lots) = 0 then
          raise exception 'lot_required' using errcode = '23514';
        end if;
        select coalesce(sum((elem->>'qty_base')::numeric), 0) into v_lot_sum
          from jsonb_array_elements(v_line.lots) elem;
        if abs(v_lot_sum - v_line.qty_accepted) > 0.0001 then
          raise exception 'lot_qty_mismatch' using errcode = '23514';
        end if;
      end if;
    elsif v_tracking = 'serial' then
      if v_line.qty_accepted > 0 then
        if v_line.serials is null then
          raise exception 'serials_required' using errcode = '23514';
        end if;
        v_serial_count := jsonb_array_length(v_line.serials);
        if v_serial_count <> v_line.qty_accepted::int then
          raise exception 'serial_count_mismatch' using errcode = '23514';
        end if;
      end if;
    end if;

    if v_line.qty_accepted > 0 then
      perform public.adjust_stock(
        v_item_id,
        v_line.qty_accepted,
        'receive_po',
        null,
        'receipt_line',
        v_receipt.id::text
      );
    end if;

    insert into public.receipt_lines(
      receipt_id, purchase_order_line_id, item_id,
      qty_received_base, qty_accepted_base, qty_rejected_base,
      unit_cost, notes
    ) values (
      v_receipt.id, v_line.po_line_id, v_item_id,
      v_line.qty_received, v_line.qty_accepted, coalesce(v_line.qty_rejected, 0),
      coalesce(v_line.unit_cost, 0), v_line.notes
    ) returning id into v_inserted_line;

    -- Persist lot rows (only when tracking_type='lot' and qty_accepted > 0)
    if v_tracking = 'lot' and v_line.qty_accepted > 0 then
      for v_lot in select * from jsonb_to_recordset(v_line.lots) as x(
        lot_number text, expiration_date date, qty_base numeric
      ) loop
        insert into public.receipt_line_lots(
          receipt_line_id, lot_number, expiration_date, qty_base
        ) values (
          v_inserted_line, v_lot.lot_number, v_lot.expiration_date, v_lot.qty_base
        );
      end loop;
    end if;

    -- Persist serials. Unique constraint will reject duplicates with errcode 23505.
    if v_tracking = 'serial' and v_line.qty_accepted > 0 then
      for v_serial in select * from jsonb_array_elements_text(v_line.serials) loop
        insert into public.serial_registry(
          organization_id, item_id, serial_number, warehouse_id, receipt_line_id
        ) values (
          v_org, v_item_id, v_serial, p_warehouse_id, v_inserted_line
        );
      end loop;
    end if;

    update public.purchase_order_items
      set quantity_received = quantity_received + v_line.qty_accepted
      where id = v_line.po_line_id;
  end loop;

  perform public.recompute_po_status(v_po.id);

  insert into public.idempotency_keys(
    organization_id, scope, key, request_hash, status, resource_type, resource_id
  ) values (
    v_org, 'receipt', p_idempotency_key, p_request_hash, 'completed',
    'receipt', v_receipt.id
  );

  return v_receipt;
end$$;
