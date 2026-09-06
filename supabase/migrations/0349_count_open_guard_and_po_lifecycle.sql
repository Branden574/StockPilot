-- 0349_count_open_guard_and_po_lifecycle.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Three verified defects, all of them in the RPCs that move stock and PO
-- lifecycle state. Each section is independent; they share a migration only
-- because they are the same wave.
--
--   1. SP-087  A count recorded WHILE post_cycle_count is looping is posted at
--              its OLD value, and the line keeps the new one.
--   2. SP-128  Fully reversing the only receipt on an IMPORT-created PO
--              demotes it from 'expected_inbound' to 'ordered'.
--   3. SP-063  post_receipt_v2 accepts DRAFT purchase orders, so receiving is
--              the one transition out of draft that never meets the PO
--              approval threshold.
--
-- Migrations are append-only: 0343, 0183 and 0296 are NOT edited. Each
-- function below is re-created in full from the LIVE body, dumped with
-- pg_get_functiondef() off the 0347 head and diffed against the migration
-- that last defined it — both were byte-identical apart from the leading /
-- trailing newline pg_get_functiondef adds, so no drift had accumulated.
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. SP-087 — A CLOSED COUNT MUST REFUSE LINE WRITES, AND THE REFUSAL MUST
--    WAIT FOR THE POST THAT IS CLOSING IT.
--
-- WHAT WENT WRONG. post_cycle_count (0343:56) iterates the lines with a plain
-- `for v_line in select l.* from public.cycle_count_lines l ...` — no row lock.
-- It locks only the header (`... from cycle_counts where id = $1 for update`)
-- and each item. The concurrent writer is a plain RLS UPDATE:
-- CycleCountsService.recordCount / clearCount, which is exactly what the
-- mobile outbox drains through POST /api/v1/cycle-counts/[id]/lines/[id]/record.
-- The gate that should have refused it — the 0282 line-UPDATE policy — tests
-- `cc.status = 'in_progress'` in a NON-LOCKING subselect, which under READ
-- COMMITTED does not wait on the header's FOR UPDATE. So:
--
--   * the record commits mid-loop; the loop's snapshot was taken at loop start,
--     so the adjust movement and the new on-hand are written from the OLD
--     counted_quantity, the header flips to 'completed', and the line is left
--     reading counted=<new> on a count nobody can edit any more — the ledger
--     and the count record disagree, and the physical correction is silently
--     discarded;
--   * a record that lands AFTER the loop but before the post commits is
--     dropped entirely.
--
-- WHY A TRIGGER AND NOT `for update of l` IN THE LOOP. Locking the lines in
-- the post loop would create a genuine deadlock cycle: an UPDATE takes the
-- LINE's row lock before its BEFORE triggers run, so the writer would hold the
-- line and wait for the header while the post holds the header and waits for
-- the line. One trigger that locks the HEADER from the line-write side gives a
-- single, consistent lock order (header, then line) and closes the post-loop
-- window too. Do NOT add a line lock to post_cycle_count.
--
-- FOR KEY SHARE is the right strength: it conflicts with the FOR UPDATE that
-- post_cycle_count / assign / release / force_reassign take, so a line write
-- during any of those blocks until they commit and then re-reads the COMMITTED
-- row version — 'completed', and refused. It does NOT conflict with itself, so
-- concurrent counters still write in parallel.
--
-- SECURITY DEFINER for the same reason 0339's rebase trigger is: under RLS,
-- `SELECT ... FOR KEY SHARE` requires the row to pass the table's UPDATE
-- policy as well as its SELECT policy, and cycle_counts UPDATE is manager-only
-- — a staff counter would be refused the lock on a count they are legitimately
-- counting. As definer the lock is taken as the owner. EXECUTE stays revoked
-- (0329 trigger-fn posture: firing does not need it).
--
-- THE SERVICE PATH IS UNCHANGED (0331/0341/0346 gate shape). auth.uid() IS
-- NULL means a service_role / postgres connection: it still takes the lock, so
-- it can never read a torn header, but it is not REFUSED — migration backfills
-- and post_cycle_count's own definer helpers must keep working. No
-- service-role writer to cycle_count_lines exists today (the only two writers
-- in the app are recordCount and clearCount, both on the user client), so this
-- exemption does not reopen the race.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.tg_cycle_count_line_assert_open()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  -- FOR KEY SHARE is the whole fix: it makes this write WAIT for an in-flight
  -- post/assign (which hold the header FOR UPDATE) instead of racing it, and
  -- the re-read after the wait sees the committed status.
  select cc.status into v_status
    from public.cycle_counts cc
   where cc.id = new.cycle_count_id
   for key share;

  if not found then
    raise exception 'cycle_count_not_found' using errcode = 'P0002';
  end if;

  -- Service path unchanged — see header.
  if auth.uid() is not null and v_status <> 'in_progress' then
    -- Same string + SQLSTATE post_cycle_count uses for the same condition
    -- (0343:49), so one mapping in the service layer covers both.
    raise exception 'cycle_count_not_open' using errcode = '22023';
  end if;

  return new;
end;
$$;

comment on function public.tg_cycle_count_line_assert_open() is
  '0349. BEFORE UPDATE on cycle_count_lines: locks the parent cycle_counts row FOR KEY SHARE so a line write serializes behind post_cycle_count / assign / release (all of which hold it FOR UPDATE), then refuses the write when the count is no longer in_progress. Closes the race where a count recorded mid-post was posted at its old value. SECURITY DEFINER because FOR KEY SHARE under RLS also demands the UPDATE policy, which staff counters do not hold; auth.uid() null (service_role/postgres) still takes the lock but is not refused.';

revoke execute on function public.tg_cycle_count_line_assert_open() from public, anon, authenticated;

-- Trigger name sorts BEFORE cycle_count_lines_rebase_expected (0339) and
-- cycle_count_lines_updated_at (0023) — same-timing triggers fire in name
-- order, so the closed-count refusal happens before any rebase work.
drop trigger if exists cycle_count_lines_assert_open on public.cycle_count_lines;
create trigger cycle_count_lines_assert_open
  before update on public.cycle_count_lines
  for each row execute function public.tg_cycle_count_line_assert_open();


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. SP-128 — A FULL REVERSAL MUST RESTORE THE PO'S PRE-RECEIPT OPEN STATE,
--    NOT A CONSTANT.
--
-- recompute_po_status (0183:53) rolls a PO backwards to the literal 'ordered'
-- whenever nothing is received any more. That was written for POs that WERE
-- ordered. Imports never are: PoImportsService.approve inserts the PO as
-- 'expected_inbound' with ordered_at NULL (po-imports.ts ~1663), and the only
-- thing that stamps ordered_at is updateStatus('ordered'). So reversing the
-- only receipt on an imported PO — a manager action on the PO page — silently
-- moves it from 'In transit' to 'Ordered', relabels the badge, and fans out a
-- 'received -> ordered' notification for a state it was never in.
--
-- Nothing functional breaks today (an 'ordered' PO is still receivable and
-- still counted in the inbound stats), which is why this is a P3 — but the
-- audit trail and the tab a receiver looks in are both wrong.
--
-- THE RESTORED STATE IS DERIVED, NOT REMEMBERED. `ordered_at is null` alone
-- would be too broad, so the branch also requires an import that actually
-- created this PO (po_imports.approved_po_id). Both conjuncts are needed:
--   * ordered_at not null  => somebody explicitly ordered it, even if it began
--                             as an import — it goes back to 'ordered';
--   * no import row        => an ordinary PO, which is only ever 'draft' until
--                             updateStatus stamps ordered_at — 'ordered'.
--
-- The po_imports probe runs under the CALLER's RLS (this function is, and
-- stays, SECURITY INVOKER). Every caller is a manager+ member of the org
-- (post_receipt_v2 and reverse_receipt both gate on has_org_role manager) or
-- service_role, and org members can read po_imports (0010) — but if a future
-- caller could not, exists() is false and the branch falls back to exactly the
-- pre-0349 behaviour. Fail-safe, not fail-open.
--
-- The forward branches are untouched, and so is the "never touch draft or
-- cancelled" guard.
-- ═══════════════════════════════════════════════════════════════════════════

-- The <= 0 branch is rare (full reversal), but po-imports.ts also filters
-- imports by approved_po_id in the list/lineage reads. Partial: most rows are
-- unapproved and never probed by po id.
create index if not exists po_imports_approved_po_idx
  on public.po_imports (approved_po_id)
  where approved_po_id is not null;

create or replace function public.recompute_po_status(p_po_id uuid)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_total_ordered  numeric;
  v_total_received numeric;
  v_status         text;
begin
  select coalesce(sum(quantity_ordered), 0),
         coalesce(sum(quantity_received), 0)
    into v_total_ordered, v_total_received
    from public.purchase_order_items
    where purchase_order_id = p_po_id;

  if v_total_received <= 0 then
    -- Nothing received (or fully reversed): roll back to the OPEN state this
    -- PO had before the receipt — 'expected_inbound' for a never-ordered
    -- import-created PO (0349), 'ordered' for everything else — and clear
    -- received_at so the PO can accept fresh receipts again. Never touch
    -- draft/cancelled POs.
    update public.purchase_orders p
      set status = case
                     when p.ordered_at is null
                      and exists (
                        select 1 from public.po_imports i
                         where i.approved_po_id = p.id
                      ) then 'expected_inbound'
                     else 'ordered'
                   end,
          received_at = null
      where p.id = p_po_id and p.status not in ('draft', 'cancelled')
      returning p.status into v_status;
    -- No row matched (draft/cancelled/missing): report the same constant the
    -- pre-0349 function did, so callers see no new shape.
    return coalesce(v_status, 'ordered');
  elsif v_total_received >= v_total_ordered then
    update public.purchase_orders
      set status = 'received', received_at = coalesce(received_at, now())
      where id = p_po_id and status not in ('cancelled');
    return 'received';
  else
    -- Partially received: clear any stale full-receipt timestamp (e.g. after a
    -- reversal dropped it below complete).
    update public.purchase_orders
      set status = 'partially_received', received_at = null
      where id = p_po_id and status not in ('cancelled');
    return 'partially_received';
  end if;
end$$;

-- Re-stated verbatim from 0183 (create-or-replace keeps the ACL, but the
-- grant is restated so the file is self-describing).
grant execute on function public.recompute_po_status(uuid) to authenticated;

comment on function public.recompute_po_status(uuid) is
  'Rolls a PO''s status to match Σ quantity_received. Backward from a full reversal restores the PO''s pre-receipt OPEN state: expected_inbound for an import-created PO that was never explicitly ordered (ordered_at null + a po_imports row), ordered otherwise (0349).';


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. SP-063 — RECEIVING IS NOT A BACK DOOR OUT OF DRAFT.
--
-- SEVENTH full-body rewrite of post_receipt_v2 (0013, 0015, 0069, 0190, 0231,
-- 0285, 0296). The body below is 0296's, verbatim — dumped live with
-- pg_get_functiondef() on the 0347 head and diffed against 0296 (identical) —
-- with ONE hunk applied: the accepted status set loses 'draft'.
--
-- WHAT WENT WRONG. 0296:91 read
--   `if v_po.status not in ('draft','expected_inbound','ordered',
--    'partially_received') then raise 'po_already_closed'`
-- so a DRAFT was receivable at the database, gated only by has_org_role
-- 'manager'. recompute_po_status then flips it to partially_received/received
-- (its forward branches exclude only 'cancelled'), with ordered_at still null.
--
-- PurchaseOrdersService documents that every transition out of draft is a
-- spend-committing act that must clear assertPoApprovalThreshold — which binds
-- managers, exactly the role this RPC admits. Receiving was the one transition
-- that never evaluated it. The web PO page hides Receive for drafts, but that
-- is UI only: the mobile PO screen loads any PO by id and its postReceipt()
-- never reads header.status, and POST /api/v1/po/[id]/receive-line rejects
-- only 'received' and 'cancelled'. So a manager could turn a $40k draft into a
-- 'received' PO without the owner/admin approval gate ever running, and
-- without the 'purchase_order.ordered' outbox event a real order fires.
--
-- A DISTINCT ERROR, NOT 'po_already_closed'. A draft is not closed — it is not
-- open YET, and the operator's next step is different ("mark it as ordered
-- first" vs "this PO is finished"). 'po_not_ordered' / 22023 gives the service
-- layer something specific to map (recurring pattern #28b: enumerate every
-- raise string, map each one, specific before general).
--
-- Stock already posted against an existing draft is untouched; only NEW
-- receipts are refused.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.post_receipt_v2(
  p_purchase_order_id uuid,
  p_warehouse_id uuid,
  p_lines jsonb,
  p_idempotency_key text,
  p_request_hash text,
  p_notes text default null::text
)
returns receipts
language plpgsql
set search_path to 'public', 'extensions'
as $function$
declare
  v_receipt       public.receipts%rowtype;
  v_existing      public.idempotency_keys%rowtype;
  v_line          record;
  v_po            public.purchase_orders%rowtype;
  v_org           uuid;
  v_item_id       uuid;
  v_tracking      text;
  v_inserted_line uuid;
  v_lot           record;
  v_serial        text;
  v_lot_sum       numeric;
  v_serial_count  int;
  v_po_line       record;
  v_staging       uuid;
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
  -- 0349: a DRAFT is not receivable. It is not closed either — it has not been
  -- ORDERED, and ordering is the transition that must clear the PO approval
  -- threshold. Distinct error so the operator is told the right next step.
  if v_po.status = 'draft' then
    raise exception 'po_not_ordered' using errcode = '22023';
  end if;
  if v_po.status not in ('expected_inbound','ordered','partially_received') then
    raise exception 'po_already_closed' using errcode = '22023';
  end if;

  -- Resolve (creating if needed) the warehouse Staging location.
  perform public.ensure_warehouse_placement_locations(p_warehouse_id);
  select id into v_staging from public.locations
    where warehouse_id = p_warehouse_id and kind = 'staging' and deleted_at is null
    limit 1;

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
    -- Quantity sanity: per-line quantities must be non-negative. Over-receipt
    -- (accepted + already-received > ordered) is ALLOWED (owner decision
    -- 2026-07-21) — vendors over-ship; the receipt Notes record why.
    if coalesce(v_line.qty_received, 0) < 0
       or coalesce(v_line.qty_accepted, 0) < 0
       or coalesce(v_line.qty_rejected, 0) < 0 then
      raise exception 'negative_quantity' using errcode = '23514';
    end if;

    select id, item_id, quantity_received, quantity_ordered
      into v_po_line
      from public.purchase_order_items
      where id = v_line.po_line_id
        and purchase_order_id = v_po.id
      for update;
    if not found then
      raise exception 'po_line_not_found' using errcode = 'P0002';
    end if;
    v_item_id := v_po_line.item_id;

    -- (over-receive guard removed 2026-07-21 — see migration 0285 header)

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
    elsif v_tracking = 'serial_optional' then
      -- 0296. Serials are WELCOME, never required. A null/absent array
      -- and an empty array are both a legitimate pure-quantity receipt -- this
      -- is the branch that makes fake placeholder serials unnecessary.
      -- The only failure is claiming MORE tagged units than actually arrived,
      -- which would double-count against the quantity posted below.
      if v_line.qty_accepted > 0 and v_line.serials is not null then
        v_serial_count := jsonb_array_length(v_line.serials);
        if v_serial_count > v_line.qty_accepted::int then
          raise exception 'serial_count_exceeds_quantity' using errcode = '23514';
        end if;
      end if;
    end if;

    if v_line.qty_accepted > 0 then
      perform public.adjust_stock(
        v_item_id,
        v_line.qty_accepted,
        'receive_po',
        v_staging,       -- route accepted qty into the warehouse Staging location
        'PO ' || coalesce(v_po.po_number, 'receipt'),
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

    -- Serial persistence. 'serial' is unchanged (its validation block already
    -- guarantees a non-null array whenever qty_accepted > 0). 'serial_optional'
    -- joins it, guarded on a non-null array so the common no-serials case does
    -- no work.
    if v_tracking in ('serial', 'serial_optional')
       and v_line.qty_accepted > 0
       and v_line.serials is not null then
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
end;
$function$;

-- Re-stated from 0013/0190/0231 (the grant survives create-or-replace; the
-- pgTAP file asserts it either way).
grant execute on function public.post_receipt_v2(uuid, uuid, jsonb, text, text, text)
  to authenticated;

comment on function public.post_receipt_v2(uuid, uuid, jsonb, text, text, text) is
  'Posts a PO receipt into warehouse Staging (idempotent by key+hash). Manager+ only. Refuses a DRAFT PO with po_not_ordered (0349): ordering is the transition that must clear the PO approval threshold, and receiving must not bypass it.';
