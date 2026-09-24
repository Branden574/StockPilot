-- 0360_purchase_order_guards.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Stock-ledger lockdown, purchase orders (prepare step). Safe to apply before
-- the matching web deploy: every rule here is one the app already follows.
-- The two rules that need the deploy first (API-role PO inserts must be
-- drafts; PO lines may be added only to a draft) ship in the enforcement
-- migration, once PO-import approval has moved onto approve_po_import_commit.
--
-- THE PROBLEM. purchase_orders, purchase_order_items and
-- purchase_order_charges are FOR ALL for a manager or a purchase_orders:manage
-- holder, and nothing below the app checks what they write:
--   * status can be PATCHed straight to 'ordered', 'received' or back from
--     'cancelled', skipping the org's approval threshold and the lifecycle;
--   * a PO's supplier, charter and amounts can be rewritten after ordering;
--   * quantity_received can be PATCHed (a PO marked received with no receipt);
--   * a line can be filed under another org's PO id (the write policy checks
--     the row's organization_id only) and recompute_po_status would count it;
--   * a PO can be hard-deleted, cascading its lines, charges and attachments.
--
-- THE APPROACH. Guards on the one UPDATE the app already sends, applying the
-- rules the service applies, rather than moving each transition into its own
-- RPC. The legitimate writers pass unchanged:
--   * PurchaseOrdersService create / update (drafts), renamePoNumber,
--     updateNotes, setPoDestinationWarehouse and updateStatus (draft ->
--     ordered, anything but received -> cancelled, ordered -> draft with
--     nothing received);
--   * the receipt RPCs, which run with stockpilot.ledger on (0359) and so may
--     set the receiving statuses, received_at and quantity_received;
--   * the recurring-PO and auto-reorder crons, which are service_role;
--   * PO-import approval, which moves onto approve_po_import_commit here.
-- Only API roles are checked (see tg_ledger_only_guard, 0359).
--
-- THE APPROVAL THRESHOLD, IN SQL. updateStatus checks the threshold against
-- purchase_orders.total, a column a draft's editor controls. The guard checks
-- the greater of that and the PO's real value, so a manager cannot zero the
-- total and then place a large order. The real value counts every line and
-- charge that ADDS spend and nothing that subtracts: an API-role line must be
-- positive (quantity > 0, cost >= 0, as the PO form requires), and a negative
-- line or charge could otherwise offset a large one.
--
-- Sections:
--   1. Helpers.
--   2. purchase_orders guard.
--   3. purchase_order_items guard.
--   4. approve_po_import_commit: PO-import approval in one transaction.
--   5. Grants.

-- Short table locks for the triggers below; fail fast (see 0358).
set lock_timeout = '5s';

-- ── 1. Helpers ──────────────────────────────────────────────────────────────

-- The PO's status, only when it belongs to p_org_id and the caller is a member
-- (null otherwise). SECURITY DEFINER so the INVOKER guards can see a parent PO
-- the caller's RLS scope hides.
create or replace function public.po_status_in_org(p_po_id uuid, p_org_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.status
    from public.purchase_orders p
   where p.id = p_po_id
     and p.organization_id = p_org_id
     and (auth.uid() is null or public.is_org_member(p_org_id));
$$;

-- The org's configured approval threshold: settings.approvalThresholdAmount of
-- the purchase_orders module, when it is a positive number (the service's
-- Number()/isFinite/> 0 reading). Internal: no API role executes it.
create or replace function public._po_approval_threshold(p_org_id uuid)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v   jsonb;
  v_n numeric;
begin
  select m.settings -> 'approvalThresholdAmount' into v
    from public.organization_modules m
   where m.organization_id = p_org_id
     and m.module_id = 'purchase_orders';
  if v is null then
    return null;
  end if;
  begin
    v_n := case jsonb_typeof(v)
             when 'number' then (v #>> '{}')::numeric
             when 'string' then nullif(btrim(v #>> '{}'), '')::numeric
             else null
           end;
  exception when others then
    return null;
  end;
  return case when v_n > 0 then v_n else null end;
end;
$$;

-- Whether placing this PO needs an owner or admin: the caller is below admin,
-- the org has a threshold, and the greater of p_total and the PO's spend (its
-- own org's lines and charges, each counted only when positive) reaches it. A
-- boolean, so no amount leaks.
create or replace function public.po_over_approval_threshold(p_po_id uuid, p_total numeric)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org       uuid;
  v_threshold numeric;
  v_value     numeric;
begin
  select organization_id into v_org from public.purchase_orders where id = p_po_id;
  if v_org is null then
    return false;
  end if;
  if auth.uid() is not null and not public.is_org_member(v_org) then
    return false;
  end if;
  if public.has_org_role(v_org, 'admin') then
    return false;
  end if;
  v_threshold := public._po_approval_threshold(v_org);
  if v_threshold is null then
    return false;
  end if;
  v_value := coalesce((select sum(greatest(i.quantity_ordered * i.unit_cost, 0))
                         from public.purchase_order_items i
                        where i.purchase_order_id = p_po_id
                          and i.organization_id = v_org), 0)
           + coalesce((select sum(greatest(c.amount, 0))
                         from public.purchase_order_charges c
                        where c.purchase_order_id = p_po_id
                          and c.organization_id = v_org), 0);
  return greatest(coalesce(p_total, 0), v_value) >= v_threshold;
end;
$$;

-- ── 2. purchase_orders guard ────────────────────────────────────────────────

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
    -- The draft-only INSERT rule lands with the enforcement migration.
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
  'BEFORE INSERT OR UPDATE guard (0360): API-role status changes follow the '
  'PO lifecycle and the approval threshold; amounts freeze after draft; '
  'receiving statuses and dates only through the receipt RPCs.';

create or replace trigger trg_zz_purchase_orders_guard
  before insert or update on public.purchase_orders
  for each row execute function public.tg_purchase_orders_guard();

-- ── 3. purchase_order_items guard ───────────────────────────────────────────

create or replace function public.tg_purchase_order_items_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
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
    if public.po_status_in_org(old.purchase_order_id, old.organization_id) is distinct from 'draft' then
      raise exception 'Lines can be removed only from a draft purchase order.'
        using errcode = '42501';
    end if;
    return old;
  end if;

  -- INSERT. The parent must be this org's PO (the write policy checks the
  -- row's organization_id only), the item this org's, and nothing received.
  if public.po_status_in_org(new.purchase_order_id, new.organization_id) is null then
    raise exception 'That purchase order is not part of this organization.'
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
  'BEFORE INSERT OR UPDATE OR DELETE guard (0360): API-role lines join only '
  'their own org''s PO and item, start unreceived, are never updated directly '
  '(receiving does that under the ledger flag), leave only drafts, and are '
  'positive (quantity > 0, cost >= 0).';

create or replace trigger trg_zz_purchase_order_items_guard
  before insert or update or delete on public.purchase_order_items
  for each row execute function public.tg_purchase_order_items_guard();

-- ── 4. approve_po_import_commit ─────────────────────────────────────────────
-- PoImportsService.approve claimed the import, inserted the PO, its lines, its
-- charges and the import's approved_po_id as five separate requests: a failure
-- after the PO insert left a PO with no lines (the claim deliberately stays, so
-- the import could not be approved again). This does all of it in one
-- transaction; any failure rolls the claim back too.
--
-- The AMOUNTS come from po_import_lines, not from the call. p_lines carries
-- only the reviewer's decisions for each kept line (its final item and line
-- type); quantity, unit cost and line total are read from the stored import
-- line, and the charges are built from the non-inventory lines exactly as
-- buildPoCharges (lib/po-imports/charges.ts) builds them, float rounding
-- included, so the PO total matches what the service audits.
--
-- THE THRESHOLD counts spend and never subtracts: goods at the greater of the
-- stored line totals and quantity x unit cost (the PO lines this creates are
-- worth the latter), plus every positive charge. Discounts and credits still
-- reduce the PO's total, but not the value the gate sees, because the
-- reviewer chooses each line's type and could otherwise re-type a line as a
-- discount to net a large order below the gate. The stored import lines are
-- editable by the same approver in review; an edited amount is also what the
-- PO then carries, so the gate and the PO stay consistent. Inventory lines
-- must be positive (quantity > 0, cost and total >= 0). No org had a
-- threshold configured when this shipped (preflight 2026-09-24).
--
-- p_lines: [{ "line_id": uuid, "item_id": uuid|null, "line_type": text }], in
-- review order, for the lines that are NOT skipped.

create or replace function public.approve_po_import_commit(
  p_import_id uuid,
  p_po_number text,
  p_supplier_id uuid,
  p_destination_location_id uuid,
  p_charter_id uuid,
  p_expected_at timestamptz,
  p_notes text,
  p_lines jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_org       uuid;
  v_status    text;
  v_po        uuid;
  v_subtotal  numeric;
  v_goods     numeric;
  v_charges   numeric;
  v_spend_charges numeric;
  v_threshold numeric;
begin
  if v_uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select i.organization_id, i.status into v_org, v_status
    from public.po_imports i
   where i.id = p_import_id
     for update;
  if v_org is null or not public.is_org_member(v_org) then
    raise exception 'po_import_not_found' using errcode = 'P0002';
  end if;
  if not public.module_enabled(v_org, 'po_imports')
     or not public.has_permission(v_org, 'purchase_orders:manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_status not in ('parsed', 'needs_review') then
    raise exception 'po_import_not_claimable' using errcode = 'P0001';
  end if;

  if p_po_number is null or btrim(p_po_number) = '' then
    raise exception 'po_number_required' using errcode = '22023';
  end if;
  if p_destination_location_id is null
     or not public.location_in_org(p_destination_location_id, v_org) then
    raise exception 'destination_invalid' using errcode = '22023';
  end if;
  if not public.supplier_in_org(p_supplier_id, v_org)
     or not public.charter_in_org(p_charter_id, v_org) then
    raise exception 'header_reference_invalid' using errcode = '22023';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'lines_invalid' using errcode = '22023';
  end if;

  -- Every decision names a distinct line of THIS import, with a known type,
  -- and every inventory line maps to a live item of this org.
  if exists (
       with d as (
         select e.value ->> 'line_id' as line_id
           from jsonb_array_elements(p_lines) e
       )
       select 1 from d
        where d.line_id is null
           or not exists (select 1 from public.po_import_lines l
                           where l.id::text = d.line_id and l.po_import_id = p_import_id)
     )
     or (select count(*) from jsonb_array_elements(p_lines))
        <> (select count(distinct e.value ->> 'line_id') from jsonb_array_elements(p_lines) e)
     or exists (
       select 1 from jsonb_array_elements(p_lines) e
        where coalesce(e.value ->> 'line_type', '') not in
              ('inventory', 'tax', 'freight', 'service', 'fee', 'discount', 'unknown')
     ) then
    raise exception 'lines_invalid' using errcode = '22023';
  end if;
  if exists (
       select 1 from jsonb_array_elements(p_lines) e
        where e.value ->> 'line_type' = 'inventory'
          and (nullif(e.value ->> 'item_id', '') is null
               or not exists (select 1 from public.inventory_items it
                               where it.id::text = e.value ->> 'item_id'
                                 and it.organization_id = v_org
                                 and it.deleted_at is null))
     ) then
    raise exception 'line_item_invalid' using errcode = '22023';
  end if;

  if exists (
       select 1 from jsonb_array_elements(p_lines) e
         join public.po_import_lines l on l.id = (e.value ->> 'line_id')::uuid
        where e.value ->> 'line_type' = 'inventory'
          and (coalesce(l.qty_ordered_original, 1) <= 0
               or coalesce(l.unit_cost, 0) < 0
               or coalesce(l.line_total, 0) < 0)) then
    raise exception 'line_amount_invalid' using errcode = '22023';
  end if;

  -- Amounts, from the stored lines.
  select coalesce(sum(coalesce(l.line_total, 0)), 0),
         coalesce(sum(coalesce(l.qty_ordered_original, 1) * coalesce(l.unit_cost, 0)), 0)
    into v_subtotal, v_goods
    from jsonb_array_elements(p_lines) e
    join public.po_import_lines l on l.id = (e.value ->> 'line_id')::uuid
   where e.value ->> 'line_type' = 'inventory';

  -- buildPoCharges: a discount always reduces the total; every other type
  -- keeps the parser's sign; Math.round(signed * 100) / 100 on doubles, which
  -- float8 reproduces bit for bit (a numeric half-up would differ by a cent on
  -- values like 1.005). v_charges is the PO's charge total; v_spend_charges
  -- is the part the threshold counts (positive charges only).
  select coalesce(sum(c.amount), 0), coalesce(sum(greatest(c.amount, 0)), 0)
    into v_charges, v_spend_charges
    from (
      select (floor((case when e.value ->> 'line_type' = 'discount'
                          then -abs(coalesce(l.line_total, 0))
                          else coalesce(l.line_total, 0) end)::float8 * 100 + 0.5) / 100)::numeric as amount
        from jsonb_array_elements(p_lines) e
        join public.po_import_lines l on l.id = (e.value ->> 'line_id')::uuid
       where e.value ->> 'line_type' <> 'inventory'
    ) c;

  if not public.has_org_role(v_org, 'admin') then
    v_threshold := public._po_approval_threshold(v_org);
    if v_threshold is not null and greatest(v_subtotal, v_goods) + v_spend_charges >= v_threshold then
      raise exception 'po_over_approval_threshold' using errcode = '42501';
    end if;
  end if;

  -- The claim, then the PO and everything under it.
  update public.po_imports
     set status = 'approved', approved_at = now(), approved_by = v_uid
   where id = p_import_id;

  insert into public.purchase_orders (
    organization_id, po_number, supplier_id, destination_location_id, charter_id,
    expected_at, notes, subtotal, total, status, created_by, updated_by)
  values (
    v_org, btrim(p_po_number), p_supplier_id, p_destination_location_id, p_charter_id,
    p_expected_at, p_notes, v_subtotal, v_subtotal + v_charges, 'expected_inbound', v_uid, v_uid)
  returning id into v_po;

  insert into public.purchase_order_items (
    organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost)
  select v_org, v_po, (e.value ->> 'item_id')::uuid,
         coalesce(l.qty_ordered_original, 1), 0, coalesce(l.unit_cost, 0)
    from jsonb_array_elements(p_lines) with ordinality e(value, ord)
    join public.po_import_lines l on l.id = (e.value ->> 'line_id')::uuid
   where e.value ->> 'line_type' = 'inventory'
   order by e.ord;

  insert into public.purchase_order_charges (
    organization_id, purchase_order_id, charge_type, label, quantity, unit_cost,
    amount, source_line_number, sort_order)
  select v_org, v_po,
         case when c.line_type in ('tax', 'freight', 'service', 'fee', 'discount')
              then c.line_type else 'other' end,
         -- JS trim(): any surrounding whitespace, not just spaces.
         case when c.description is not null
               and regexp_replace(c.description, '^\s+|\s+$', '', 'g') <> ''
              then c.description else null end,
         case when c.qty is not null and c.qty <> 1 then c.qty else null end,
         case when c.qty is not null and c.qty <> 1 then c.unit_cost else null end,
         (floor((case when c.line_type = 'discount'
                     then -abs(coalesce(c.line_total, 0))
                     else coalesce(c.line_total, 0) end)::float8 * 100 + 0.5) / 100)::numeric,
         c.line_number,
         (row_number() over (order by c.ord) - 1)::int
    from (
      select e.ord, e.value ->> 'line_type' as line_type, l.description,
             l.qty_ordered_original as qty, l.unit_cost, l.line_total, l.line_number
        from jsonb_array_elements(p_lines) with ordinality e(value, ord)
        join public.po_import_lines l on l.id = (e.value ->> 'line_id')::uuid
       where e.value ->> 'line_type' <> 'inventory'
    ) c;

  update public.po_imports
     set approved_po_id = v_po
   where id = p_import_id;

  return v_po;
end;
$$;

comment on function public.approve_po_import_commit(uuid, text, uuid, uuid, uuid, timestamptz, text, jsonb) is
  'PO-import approval in one transaction (0360): claim, PO, lines, charges, '
  'link. Amounts come from po_import_lines; the caller supplies only the '
  'reviewed item and type per kept line. Threshold on goods + positive charges.';

-- ── 5. Grants ───────────────────────────────────────────────────────────────

revoke all on function public.po_status_in_org(uuid, uuid) from public, anon;
grant execute on function public.po_status_in_org(uuid, uuid) to authenticated, service_role;
revoke all on function public._po_approval_threshold(uuid) from public, anon, authenticated;
grant execute on function public._po_approval_threshold(uuid) to service_role;
revoke all on function public.po_over_approval_threshold(uuid, numeric) from public, anon;
grant execute on function public.po_over_approval_threshold(uuid, numeric) to authenticated, service_role;
revoke all on function public.approve_po_import_commit(uuid, text, uuid, uuid, uuid, timestamptz, text, jsonb) from public, anon;
grant execute on function public.approve_po_import_commit(uuid, text, uuid, uuid, uuid, timestamptz, text, jsonb) to authenticated, service_role;
revoke all on function public.tg_purchase_orders_guard() from public, anon, authenticated;
revoke all on function public.tg_purchase_order_items_guard() from public, anon, authenticated;

-- Nothing in the app hard-deletes a PO (cancel is the lifecycle end), and a
-- delete cascades its lines, charges and attachments. Charges are written
-- only by approve_po_import_commit; their INSERT closes with the enforcement
-- migration, once the old approve path is gone.
revoke delete on public.purchase_orders from authenticated;
revoke update, delete on public.purchase_order_charges from authenticated;
revoke truncate, trigger, references on
  public.purchase_orders, public.purchase_order_items, public.purchase_order_charges
  from authenticated, anon;
revoke insert, update, delete on
  public.purchase_orders, public.purchase_order_items, public.purchase_order_charges
  from anon;

reset lock_timeout;
