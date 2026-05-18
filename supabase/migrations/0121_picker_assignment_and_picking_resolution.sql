-- ============================================================================
-- 0121_picker_assignment_and_picking_resolution.sql
-- ============================================================================
-- Three related correctness fixes flagged by the workflow audit:
--
-- 1. assigned_picker_id is always set to the approver in 0111. Lines
--    track the real picker via picked_by, but the order header is
--    misleading: "who picked this?" reads the wrong user. Move the
--    assignment to a lazy COALESCE inside partial_pick_line and
--    complete_picking so the FIRST staffer who actually pulls stock
--    becomes the assigned picker. The approver is still preserved
--    in approved_by / audit_logs for audit purposes.
--
-- 2. complete_picking strict mode (i.e. partial_pick_line ran on at
--    least one line) leaves NULL quantity_picked on lines that were
--    never touched by the picker. v_effective coalesces NULL to 0 in
--    the loop and skips the stock-movement path, but the line ROW is
--    not updated to record the resolved state. That means stageOrder
--    later sees lines in three valid states: positive (picked),
--    zero (picker explicitly skipped), or NULL (picker neglected).
--    Codify the "picker neglected" case to 0 + fulfilled=0 so every
--    line at staging time has a defined quantity_picked.
--
-- 3. delivery_charter_id CHECK from 0110 was added as NOT VALID to
--    skip legacy rows. Try to VALIDATE it now. If legacy rows still
--    exist, log them via NOTICE and leave the constraint NOT VALID
--    so this migration stays idempotent.
-- ============================================================================

begin;

-- ─────────────────────────────────────────────────────────────────────
-- 1. approve_order_request — stop writing assigned_picker_id.
--    The approver path now leaves the column NULL for the first real
--    picker (via partial_pick_line) or the bulk-complete RPC to fill.
--    Everything else in the function body is verbatim from 0111.
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.approve_order_request(p_id uuid)
returns public.order_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req public.order_requests%rowtype;
  v_line record;
  v_active_reserved numeric(14,4);
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
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
    set status              = 'approved',
        approved_by         = v_user,
        approved_at         = now()
    where id = p_id;

  select * into v_req from public.order_requests where id = p_id;
  return v_req;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────
-- 2. partial_pick_line — lazy-set assigned_picker_id from auth.uid()
--    on the first non-zero pick. COALESCE preserves any prior value
--    (a manager who completes picking later won't overwrite the real
--    picker).
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.partial_pick_line(
  p_line_id uuid,
  p_qty     numeric
)
returns public.order_request_lines
language plpgsql
security definer
set search_path = public
as $$
declare
  v_line public.order_request_lines%rowtype;
  v_req  public.order_requests%rowtype;
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if p_qty is null or p_qty < 0 then
    raise exception 'invalid_quantity' using errcode = 'P0001';
  end if;

  select * into v_line from public.order_request_lines where id = p_line_id for update;
  if not found then
    raise exception 'order_request_line_not_found' using errcode = 'P0002';
  end if;
  select * into v_req from public.order_requests where id = v_line.order_request_id for update;

  if not public.has_org_role(v_req.organization_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_req.status not in ('pick_slip_generated', 'picking_in_progress') then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;
  if p_qty > v_line.quantity_requested then
    raise exception 'over_pick' using errcode = 'P0001',
      detail = format('Picked %s exceeds requested %s', p_qty, v_line.quantity_requested);
  end if;

  update public.order_request_lines
    set quantity_picked = p_qty,
        picked_at       = now(),
        picked_by       = v_user
    where id = p_line_id;

  -- First non-zero pick flips the order to picking_in_progress AND
  -- assigns this user as the order's assigned picker (only if it
  -- hasn't already been set — preserves a manager-reassignment).
  if v_req.status = 'pick_slip_generated' and p_qty > 0 then
    update public.order_requests
      set status             = 'picking_in_progress',
          assigned_picker_id = coalesce(assigned_picker_id, v_user)
      where id = v_req.id;
  elsif p_qty > 0 and v_req.assigned_picker_id is null then
    update public.order_requests
      set assigned_picker_id = v_user
      where id = v_req.id;
  end if;

  select * into v_line from public.order_request_lines where id = p_line_id;
  return v_line;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────
-- 3. complete_picking — preserve picker lazy-assignment + codify the
--    "picker neglected" state. Body is identical to 0118 except:
--      • the final UPDATE writes assigned_picker_id = COALESCE
--      • in strict mode (not v_all_null), any line that still has
--        quantity_picked IS NULL is set to 0 + quantity_fulfilled=0
--        so stageOrder never sees ambiguous state.
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.complete_picking(p_order_id uuid)
returns public.order_requests
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_req       public.order_requests%rowtype;
  v_line      record;
  v_user      uuid := auth.uid();
  v_all_null  boolean;
  v_effective numeric(14,4);
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  select * into v_req from public.order_requests where id = p_order_id for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;
  if not public.has_org_role(v_req.organization_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_req.status not in ('pick_slip_generated', 'picking_in_progress') then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;

  select bool_and(quantity_picked is null)
    into v_all_null
    from public.order_request_lines
    where order_request_id = p_order_id;
  v_all_null := coalesce(v_all_null, true);

  for v_line in
    select l.id          as line_id,
           l.item_id     as item_id,
           l.quantity_picked    as picked,
           l.quantity_requested as requested
    from public.order_request_lines l
    where l.order_request_id = p_order_id
    order by l.item_id
  loop
    if v_all_null then
      v_effective := coalesce(v_line.requested, 0);
    else
      v_effective := coalesce(v_line.picked, 0);
    end if;

    if v_effective > 0 then
      perform public.adjust_stock(
        v_line.item_id,
        -v_effective,
        'transfer',
        null,
        'Order pick (order_request ' || p_order_id::text || ')',
        null
      );
      update public.order_request_lines
        set quantity_fulfilled = v_effective,
            quantity_picked    = v_effective
        where id = v_line.line_id;
    elsif not v_all_null and v_line.picked is null then
      -- Strict mode "picker neglected" case: codify the row to 0/0
      -- so stageOrder never sees an ambiguous NULL quantity_picked.
      update public.order_request_lines
        set quantity_fulfilled = 0,
            quantity_picked    = 0
        where id = v_line.line_id;
    end if;
  end loop;

  update public.stock_reservations
    set released_at = now()
    where order_request_id = p_order_id
      and released_at is null;

  update public.order_requests
    set status               = 'picking_complete',
        picking_completed_at = now(),
        picking_completed_by = v_user,
        assigned_picker_id   = coalesce(assigned_picker_id, v_user)
    where id = p_order_id;

  select * into v_req from public.order_requests where id = p_order_id;
  return v_req;
end;
$$;

grant execute on function public.complete_picking(uuid) to authenticated;

comment on function public.complete_picking(uuid) is
  'Atomic stock decrement + reservation release + flip to '
  'picking_complete. If every line has quantity_picked IS NULL '
  '(manager one-click flow), falls back to quantity_requested per line; '
  'otherwise honors quantity_picked exactly (digital pick UI flow). '
  'In strict mode, any remaining NULL quantity_picked lines are '
  'codified to 0 so the staging gate never sees ambiguous state. '
  'Also lazy-sets assigned_picker_id from auth.uid() if unset.';

-- ─────────────────────────────────────────────────────────────────────
-- 4. Try to VALIDATE the delivery_charter_id coherence constraint
--    that 0110 added as NOT VALID. If the table has legacy rows that
--    don't satisfy it, log them and leave the constraint NOT VALID.
--
-- Bug history: the original version of this DO block referenced the
-- constraint as "order_requests_delivery_charter_chk", but 0110
-- actually named it "order_requests_delivery_target_chk". On prod the
-- v_offenders > 0 branch hid the bug; on a fresh-DB replay (no rows
-- means v_offenders = 0) the wrong name surfaced as a hard error.
-- Fix: use the correct name + guard with an existence check so any
-- future name drift can't crash a fresh-DB boot.
-- ─────────────────────────────────────────────────────────────────────
do $$
declare
  v_offenders int;
  v_has_constraint boolean;
begin
  select exists (
    select 1
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
     where t.relname = 'order_requests'
       and c.conname = 'order_requests_delivery_target_chk'
  ) into v_has_constraint;

  if not v_has_constraint then
    raise notice
      'Skipping VALIDATE: constraint order_requests_delivery_target_chk '
      'is not present (fresh DB without 0110, or constraint was renamed). '
      'Re-run after 0110 establishes the constraint.';
    return;
  end if;

  select count(*) into v_offenders
    from public.order_requests
   where fulfillment_type = 'delivery'
     and delivery_charter_id is null;

  if v_offenders = 0 then
    -- No bad rows — promote the constraint to fully validated.
    alter table public.order_requests
      validate constraint order_requests_delivery_target_chk;
    raise notice 'delivery_charter_id constraint validated successfully.';
  else
    raise notice
      'Skipping VALIDATE on order_requests_delivery_target_chk: % legacy '
      'delivery row(s) still have delivery_charter_id IS NULL. Backfill '
      'or demote them to fulfillment_type=''pickup'' and re-run this DO '
      'block (or just re-run this migration after 0121) to promote the '
      'constraint.',
      v_offenders;
  end if;
end$$;

commit;
