-- 0013_idempotency.sql
-- ─────────────────────────────────────────────────────────────────────
-- Idempotency keys for receipt posting (and future write paths).
--
-- Same key + same payload → return original resource (replay).
-- Same key + different payload → reject with conflict.
-- Different key → fresh request.
--
-- Plus: post_receipt_v2 RPC that does idempotency-aware receipt posting
-- transactionally, including line creation, stock adjustment, PO status
-- recomputation, and audit trail.
-- ─────────────────────────────────────────────────────────────────────

set check_function_bodies = off;

-- ─────────────────────────────────────────────────────────────────────
-- idempotency_keys
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.idempotency_keys (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  scope           text not null,            -- e.g. 'receipt'
  key             text not null,            -- caller-supplied UUID
  request_hash    text not null,            -- sha256 of normalized payload
  response_hash   text,
  status          text not null default 'in_progress'
                    check (status in ('in_progress','completed','failed')),
  resource_type   text,
  resource_id     uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, scope, key)
);

create index if not exists idempotency_keys_resource_idx
  on public.idempotency_keys(resource_type, resource_id);

create trigger idempotency_keys_updated_at
  before update on public.idempotency_keys
  for each row execute function public.tg_set_updated_at();

alter table public.idempotency_keys enable row level security;

-- Members of the org can read their own org's keys (for debugging/replays);
-- managers+ can write.
drop policy if exists idempotency_keys_select on public.idempotency_keys;
create policy idempotency_keys_select on public.idempotency_keys
  for select using (
    exists (
      select 1 from public.organization_members m
      where m.user_id = auth.uid()
        and m.organization_id = idempotency_keys.organization_id
        and m.accepted_at is not null
    )
  );

drop policy if exists idempotency_keys_write on public.idempotency_keys;
create policy idempotency_keys_write on public.idempotency_keys
  for all using (public.has_org_role(organization_id, 'manager'));

-- ─────────────────────────────────────────────────────────────────────
-- post_receipt_v2 — atomic, idempotent receipt posting.
--
-- p_lines is jsonb array of:
--   { po_line_id uuid, qty_received numeric, qty_accepted numeric,
--     qty_rejected numeric, unit_cost numeric, notes text }
--
-- Returns the inserted (or replayed) receipt row.
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
begin
  -- Lock + load PO first so we can derive organization_id and validate access.
  select * into v_po from public.purchase_orders where id = p_purchase_order_id for update;
  if not found then raise exception 'po_not_found' using errcode = 'P0002'; end if;
  v_org := v_po.organization_id;

  -- Idempotency check.
  select * into v_existing
    from public.idempotency_keys
    where organization_id = v_org
      and scope = 'receipt'
      and key = p_idempotency_key
    for update;
  if found then
    if v_existing.request_hash = p_request_hash then
      -- Replay: return the original receipt unchanged.
      select * into v_receipt from public.receipts where id = v_existing.resource_id;
      return v_receipt;
    else
      raise exception 'idempotency_conflict' using errcode = '40001';
    end if;
  end if;

  -- Authorization: managers+ can post receipts.
  if not public.has_org_role(v_org, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_po.status not in ('draft','expected_inbound','ordered','partially_received') then
    raise exception 'po_already_closed' using errcode = '22023';
  end if;

  -- Insert receipt header.
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

  -- For each line: insert receipt_line, bump stock for accepted qty,
  -- update PO line received total.
  for v_line in select * from jsonb_to_recordset(p_lines) as x(
    po_line_id uuid, qty_received numeric, qty_accepted numeric,
    qty_rejected numeric, unit_cost numeric, notes text
  ) loop
    -- Fetch the matching PO line to get item_id.
    select item_id into v_item_id
      from public.purchase_order_items
      where id = v_line.po_line_id
        and purchase_order_id = v_po.id
      for update;
    if not found then
      raise exception 'po_line_not_found' using errcode = 'P0002';
    end if;

    -- Bump stock only for accepted units. Damaged/rejected don't enter inventory.
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
    );

    update public.purchase_order_items
      set quantity_received = quantity_received + v_line.qty_accepted
      where id = v_line.po_line_id;
  end loop;

  -- Roll PO status forward.
  perform public.recompute_po_status(v_po.id);

  -- Record idempotency completion.
  insert into public.idempotency_keys(
    organization_id, scope, key, request_hash, status, resource_type, resource_id
  ) values (
    v_org, 'receipt', p_idempotency_key, p_request_hash, 'completed',
    'receipt', v_receipt.id
  );

  return v_receipt;
end$$;

grant execute on function public.post_receipt_v2(uuid, uuid, jsonb, text, text, text)
  to authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- reverse_receipt — sibling row + negative ledger entries
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.reverse_receipt(
  p_receipt_id uuid,
  p_reason     text
)
returns public.receipts
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_orig    public.receipts%rowtype;
  v_rev     public.receipts%rowtype;
  v_line    public.receipt_lines%rowtype;
begin
  select * into v_orig from public.receipts where id = p_receipt_id for update;
  if not found then raise exception 'receipt_not_found' using errcode = 'P0002'; end if;
  if v_orig.status <> 'posted' then
    raise exception 'receipt_already_reversed' using errcode = '22023';
  end if;
  if not public.has_org_role(v_orig.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into public.receipts(
    organization_id, purchase_order_id, warehouse_id, receipt_number,
    status, reversed_receipt_id, reversal_reason,
    received_by, immutable_hash, notes
  ) values (
    v_orig.organization_id, v_orig.purchase_order_id, v_orig.warehouse_id,
    v_orig.receipt_number || '-REV',
    'reversal', v_orig.id, p_reason,
    auth.uid(),
    encode(digest('reversal:' || v_orig.id::text, 'sha256'), 'hex'),
    'Reversal of ' || v_orig.receipt_number
  ) returning * into v_rev;

  -- For each line on the original, write a negative ledger entry and
  -- decrement the PO line's quantity_received.
  for v_line in select * from public.receipt_lines where receipt_id = v_orig.id loop
    if v_line.qty_accepted_base > 0 then
      perform public.adjust_stock(
        v_line.item_id,
        -v_line.qty_accepted_base,
        'correction',
        null,
        'receipt_reversal',
        v_rev.id::text
      );
    end if;

    insert into public.receipt_lines(
      receipt_id, purchase_order_line_id, item_id,
      qty_received_base, qty_accepted_base, qty_rejected_base,
      unit_cost, notes
    ) values (
      v_rev.id, v_line.purchase_order_line_id, v_line.item_id,
      -v_line.qty_received_base, -v_line.qty_accepted_base, -v_line.qty_rejected_base,
      v_line.unit_cost, 'Reversal of original receipt line'
    );

    update public.purchase_order_items
      set quantity_received = greatest(0, quantity_received - v_line.qty_accepted_base)
      where id = v_line.purchase_order_line_id;
  end loop;

  -- Mark the original as reversed.
  update public.receipts set status = 'reversed' where id = v_orig.id;

  perform public.recompute_po_status(v_orig.purchase_order_id);

  return v_rev;
end$$;

grant execute on function public.reverse_receipt(uuid, text) to authenticated;
