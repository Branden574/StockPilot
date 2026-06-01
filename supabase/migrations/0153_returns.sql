-- ============================================================================
-- 0153_returns.sql — Returns/RMA foundation (Phase A).
--
-- Adds the RMA header + line tables and the disposition RPC that pushes
-- inventory back (restock) or writes it off (scrap) when a return is received.
--
-- Inventory correctness is paramount. The CORRECT inventory model:
--
--   Order fulfilment ALREADY decremented inventory_items.quantity_on_hand by
--   order_request_lines.quantity_fulfilled (complete_picking, 0xxx; proof:
--   cancel_order_request 0137 RESTORES quantity_fulfilled>0 lines with a 'return'
--   movement). So a returned unit is a unit that already LEFT on-hand. Therefore:
--     • RESTOCK = adjust the on-hand by +qty as a 'return' movement — the unit
--       re-enters sellable stock (net vs the fulfilment decrement = back to
--       original). CORRECT.
--     • SCRAP   = NET-ZERO on quantity_on_hand. The unit was already decremented
--       at fulfilment and is now destroyed, so it must NOT be decremented AGAIN
--       (a bare -qty 'loss' would be a DOUBLE-DECREMENT bug). We record it as
--       received-then-written-off: +qty 'return' THEN -qty 'loss' (net 0, full
--       audit trail) so on-hand is conserved.
--
--   DURABLE BUDGET (the over-return cap):
--     • order_request_lines.returned_quantity (numeric not null default 0) is the
--       running total of units already returned against that source line, ACROSS
--       BOTH dispositions (you cannot return the same fulfilled unit twice whether
--       restocked or scrapped). It is incremented at APPLY-TIME inside
--       process_return_disposition (idempotent via the per-line `applied` latch),
--       so the budget lives on the IMMUTABLE source line, not on the mutable
--       return rows. Flipping or deleting a return header can therefore NEVER free
--       budget that was already consumed.
--     • The amount a source line can still be returned = quantity_fulfilled
--       - returned_quantity. The INSERT cap trigger
--       (return_lines_enforce_fulfilled_cap) rejects any new/updated line that
--       would push (returned_quantity + the still-pending unapplied live lines for
--       that source line) over quantity_fulfilled — NOT a status-dependent SUM
--       over all return rows (that aggregate is freed by a cancel/delete and was
--       the inflation hole). The per-line UNIQUE only stops a duplicate inside ONE
--       return; the budget bounds the cross-return aggregate. quantity > 0 (CHECK)
--       is the floor.
--   • ITEM IDENTITY — return_lines.item_id MUST equal the referenced
--     order_request_line's item_id. Enforced in the same cap/validation trigger
--     (raise 'return_item_mismatch' on mismatch) so no path can restock a
--     different item than the one fulfilled on that source line.
--   • NEVER apply a disposition twice — return_lines.applied is a one-way latch
--     flipped inside process_return_disposition; the RPC skips already-applied
--     lines, so re-running it (idempotent) is a no-op for settled lines.
--   • Inventory only moves for a RECEIVED return — process_return_disposition
--     guards v_return.status = 'received' and flips it to 'closed' in the same
--     transaction as the inventory write, so an unapproved/unreceived/denied/
--     cancelled return can never push stock (mirrors cancel_order_request's
--     invalid_status_transition guard in 0137).
--
-- Stock semantics (confirmed seam):
--   RESTOCK = +quantity, movement_type 'return'
--   SCRAP   = +quantity 'return' THEN -quantity 'loss' (NET-ZERO)
--   Every movement is stamped reference_type='return', reference_id=<return id>.
--
-- process_return_disposition mirrors cancel_order_request (0137): SECURITY
-- DEFINER, locks the header row, loops lines in a stable order, performs the
-- atomic on-hand change + ledger write inline (so it can stamp the reference
-- columns — adjust_stock takes no reference args), and is callable by any
-- authenticated user whose org-role passes the in-function manager check. The
-- service layer additionally gates on the 'returns' module + 'returns:manage'
-- permission.
--
-- search_path = public, extensions: the inline stock write lives in the same
-- transaction as the rest of the order/inventory RPCs which rely on pgcrypto in
-- `extensions` (same trap called out in 0022 / 0134 / 0137).
--
-- RLS / convention re-use (verbatim from 0146):
--   is_org_member(org_id) / has_org_role(org_id, min_role) wrapped in (SELECT …)
--   per the InitPlan convention (0140); `drop policy if exists` idempotency
--   guard (0144); tg_set_updated_at trigger (0001). return_lines carries its own
--   organization_id so it is gated directly, same as the header.
--
-- The 'returns' module is grandfathered OFF for every existing org (mirrors the
-- 0147 'integrations' seed): brand-new functionality, explicit opt-in.
-- ============================================================================

-- 0. Durable per-source-line return budget. ----------------------------------
-- order_request_lines.returned_quantity is the running total of units already
-- returned against that line (across BOTH dispositions). Incremented at
-- apply-time in process_return_disposition (idempotent via the line `applied`
-- latch); read by the INSERT cap trigger and createFromOrder as
-- (quantity_fulfilled - returned_quantity). Lives on the immutable source line
-- so flipping/deleting a return header cannot free already-consumed budget.
alter table public.order_request_lines
  add column if not exists returned_quantity numeric(14,4) not null default 0;

-- 1. returns — RMA header. ---------------------------------------------------
create table if not exists public.returns (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  order_request_id  uuid not null references public.order_requests(id) on delete cascade,
  return_number     text,
  status            text not null default 'requested'
                      check (status in ('requested','approved','received','closed','denied','cancelled')),
  source            text not null default 'internal'
                      check (source in ('internal','requester')),
  reason_code       text
                      check (reason_code in ('damaged','wrong_item','end_of_year','overage','other')),
  notes             text,
  requested_by      uuid references public.user_profiles(id),
  requester_email   citext,
  requester_name    text,
  approved_by       uuid references public.user_profiles(id),
  approved_at       timestamptz,
  received_by       uuid references public.user_profiles(id),
  received_at       timestamptz,
  closed_by         uuid references public.user_profiles(id),
  closed_at         timestamptz,
  denied_by         uuid references public.user_profiles(id),
  denied_at         timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists returns_org_order_idx
  on public.returns (organization_id, order_request_id);
create index if not exists returns_org_status_idx
  on public.returns (organization_id, status);

drop trigger if exists returns_set_updated_at on public.returns;
create trigger returns_set_updated_at
  before update on public.returns
  for each row execute function public.tg_set_updated_at();

-- 2. return_lines — one per returned order line. -----------------------------
-- Carries organization_id so RLS gates it directly (same as the header) rather
-- than joining through the parent return.
create table if not exists public.return_lines (
  id                    uuid primary key default gen_random_uuid(),
  return_id             uuid not null references public.returns(id) on delete cascade,
  organization_id       uuid not null references public.organizations(id) on delete cascade,
  order_request_line_id uuid not null references public.order_request_lines(id),
  item_id               uuid not null references public.inventory_items(id),
  quantity              numeric(14,4) not null check (quantity > 0),
  disposition           text not null check (disposition in ('restock','scrap')),
  applied               boolean not null default false,
  created_at            timestamptz not null default now(),
  unique (return_id, order_request_line_id)
);

create index if not exists return_lines_return_idx
  on public.return_lines (return_id);

-- Index supporting the cross-return aggregate cap below (sum by source line).
create index if not exists return_lines_order_request_line_idx
  on public.return_lines (order_request_line_id);

-- 2a. Fulfilled cap + item identity — DB-level guard against inventory ------
--     inflation and item substitution.
--
-- DURABLE-BUDGET cap (NOT a status-dependent SUM). The amount a source line can
-- still be returned is (quantity_fulfilled - returned_quantity), where
-- returned_quantity is the running total ALREADY APPLIED (incremented inside
-- process_return_disposition). On top of that durable consumption, the still-
-- PENDING (unapplied, live) return_lines for the same source line are committed
-- demand that has not yet consumed budget; they must also fit. So this trigger
-- rejects any new/updated line that would push
--   returned_quantity + SUM(pending unapplied live return_lines)  >  quantity_fulfilled.
-- Because returned_quantity is incremented exactly as a line flips
-- unapplied→applied, returned_quantity + pending_sum is conserved across an
-- apply — the cap is invariant under disposition. Crucially the budget lives on
-- the IMMUTABLE source line, so flipping a return to cancelled/denied or DELETEing
-- it (blocked in 0154, but defence in depth) can only ever REMOVE pending demand,
-- never reclaim already-consumed (applied) budget. The old SUM-over-all-live-rows
-- aggregate was the inflation hole: a cancel→revive freed budget that stock had
-- already moved against.
--
-- ITEM IDENTITY: return_lines.item_id MUST equal the source order_request_line's
-- item_id — otherwise a return could restock a DIFFERENT item than the one that
-- was fulfilled (inventory fabrication). We re-check it here against the locked
-- source line so neither the service nor the raw data API can substitute.
--
-- We lock the parent order_request_lines row FOR UPDATE first so concurrent
-- inserts for the same source line serialize (otherwise two transactions could
-- each pass the check and jointly exceed the cap). Defined as a CONSTRAINT
-- TRIGGER so it reads as an integrity rule; it fires AFTER ROW with the lock
-- taken inside, so NEW is already visible to the pending sum.
create or replace function public.tg_return_lines_enforce_fulfilled_cap()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_fulfilled numeric(14,4);
  v_returned  numeric(14,4);
  v_item      uuid;
  v_pending   numeric(14,4);
begin
  -- Lock the source line so concurrent inserts for the same line serialize, and
  -- read both halves of the durable budget plus the canonical fulfilled item.
  select orl.quantity_fulfilled, orl.returned_quantity, orl.item_id
    into v_fulfilled, v_returned, v_item
  from public.order_request_lines orl
  where orl.id = new.order_request_line_id
  for update;

  if not found then
    raise exception 'order_request_line_not_found'
      using errcode = 'P0002', detail = new.order_request_line_id::text;
  end if;

  -- Item identity: the returned item must be the one fulfilled on this line.
  if new.item_id <> v_item then
    raise exception 'return_item_mismatch'
      using errcode = 'P0001',
            detail = format(
              'order_request_line %s fulfilled item %s, return line claims %s',
              new.order_request_line_id, v_item, new.item_id
            );
  end if;

  -- Pending (unapplied) demand for this source line across all live (not
  -- cancelled/denied) returns. Applied lines already consumed returned_quantity,
  -- so they are EXCLUDED here to avoid double-counting. The row being
  -- inserted/updated is already visible to this AFTER trigger and is unapplied at
  -- insert time, so NEW is included via the predicate — do not add it again.
  select coalesce(sum(rl.quantity), 0)
    into v_pending
  from public.return_lines rl
  join public.returns r on r.id = rl.return_id
  where rl.order_request_line_id = new.order_request_line_id
    and rl.applied = false
    and r.status not in ('cancelled', 'denied');

  if v_returned + v_pending > v_fulfilled then
    raise exception 'return_exceeds_fulfilled'
      using errcode = 'P0001',
            detail = format(
              'order_request_line %s: returned %s + pending %s exceeds fulfilled %s',
              new.order_request_line_id, v_returned, v_pending, v_fulfilled
            );
  end if;

  return new;
end;
$$;

revoke all on function public.tg_return_lines_enforce_fulfilled_cap() from public, anon;

drop trigger if exists return_lines_enforce_fulfilled_cap on public.return_lines;
create constraint trigger return_lines_enforce_fulfilled_cap
  after insert or update of quantity, order_request_line_id, item_id on public.return_lines
  for each row execute function public.tg_return_lines_enforce_fulfilled_cap();

-- RLS -----------------------------------------------------------------------
alter table public.returns      enable row level security;
alter table public.return_lines enable row level security;

-- returns: member read, manager INSERT + UPDATE. We DELIBERATELY do NOT grant
-- DELETE — split the write into separate `for insert` + `for update` policies
-- (the 0119 order_requests pattern) rather than a blanket `for all`, which
-- includes DELETE. With no permissive DELETE policy, RLS denies DELETE by
-- default; 0154 adds an explicit `for delete using(false)` on top as
-- self-documenting insurance. Returns are state-managed (cancel flips
-- status='cancelled'); deleting a live return would silently drop its pending
-- return_lines and let a fresh full return be opened, re-inflating inventory.
drop policy if exists returns_select on public.returns;
create policy returns_select on public.returns
  for select to authenticated using ((select public.is_org_member(organization_id)));

-- Drop the legacy blanket policy name in case an earlier draft created it.
drop policy if exists returns_write on public.returns;

drop policy if exists returns_insert on public.returns;
create policy returns_insert on public.returns
  for insert to authenticated
  with check ((select public.has_org_role(organization_id, 'manager')));

drop policy if exists returns_update on public.returns;
create policy returns_update on public.returns
  for update to authenticated
  using ((select public.has_org_role(organization_id, 'manager')))
  with check ((select public.has_org_role(organization_id, 'manager')));

-- return_lines: member read, manager INSERT + UPDATE (gated by its own
-- organization_id). Same split — no DELETE grant.
drop policy if exists return_lines_select on public.return_lines;
create policy return_lines_select on public.return_lines
  for select to authenticated using ((select public.is_org_member(organization_id)));

drop policy if exists return_lines_write on public.return_lines;

drop policy if exists return_lines_insert on public.return_lines;
create policy return_lines_insert on public.return_lines
  for insert to authenticated
  with check ((select public.has_org_role(organization_id, 'manager')));

drop policy if exists return_lines_update on public.return_lines;
create policy return_lines_update on public.return_lines
  for update to authenticated
  using ((select public.has_org_role(organization_id, 'manager')))
  with check ((select public.has_org_role(organization_id, 'manager')));

grant select, insert, update, delete on public.returns      to authenticated;
grant select, insert, update, delete on public.return_lines to authenticated;

-- 3. process_return_disposition — apply restock/scrap per line. --------------
-- Mirrors cancel_order_request (0137): lock the header, authorize against the
-- header org, GUARD status='received' (invalid_status_transition otherwise),
-- loop unapplied lines in a stable order, mutate inventory + ledger inline
-- (stamping the reference columns adjust_stock can't), increment the source
-- line's returned_quantity, latch applied, then flip the return to 'closed'
-- (closed_by/closed_at) in the same transaction so the received->closed move is
-- atomic with the inventory write. Idempotent on the line latch: already-applied
-- lines are skipped; a second call is rejected by the status guard once the
-- return is 'closed'.
--
-- Inventory model (see header): both dispositions begin from the fact that the
-- unit ALREADY left on-hand at fulfilment.
--   RESTOCK → +qty 'return' (unit re-enters sellable stock).
--   SCRAP   → +qty 'return' THEN -qty 'loss' (NET-ZERO: receive-then-write-off,
--             so on-hand is conserved and we do NOT double-decrement).
-- Every applied line ALSO increments order_request_lines.returned_quantity by
-- the line quantity — the durable budget the cap trigger reads.
create or replace function public.process_return_disposition(p_return_id uuid)
returns public.returns
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_return  public.returns%rowtype;
  v_user    uuid := auth.uid();
  v_line    record;
  v_item    public.inventory_items%rowtype;
  v_prev    numeric;
  v_new     numeric;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  -- Lock the header so concurrent receive/close calls on the same return
  -- serialize; the applied latch on each line is the per-line guard.
  select * into v_return from public.returns where id = p_return_id for update;
  if not found then
    raise exception 'return_not_found' using errcode = 'P0002';
  end if;

  if not public.has_org_role(v_return.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Status gate: inventory only moves for a return that has actually been
  -- received. A return still in 'requested'/'approved' (never received) or in
  -- 'denied'/'cancelled' must never push stock — that would let a manager skip
  -- the approval/receipt workflow. 'closed' is already settled (this RPC moved
  -- it there); re-calling on a closed return is a no-op because every line's
  -- applied latch is true, but we still reject the transition explicitly so the
  -- received->closed move is the only path that mutates inventory. Mirrors
  -- cancel_order_request's invalid_status_transition guard (0137).
  if v_return.status <> 'received' then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_return.status;
  end if;

  -- order by item_id keeps the per-item row-lock order stable across concurrent
  -- calls touching the same item (matches complete_picking / cancel_order_request).
  for v_line in
    select rl.id as line_id, rl.item_id, rl.quantity, rl.disposition,
           rl.order_request_line_id
    from public.return_lines rl
    where rl.return_id = p_return_id
      and rl.applied = false
    order by rl.item_id
  loop
    -- Lock the item once for the whole (possibly two-movement) disposition.
    select * into v_item
    from public.inventory_items
    where id = v_line.item_id
    for update;
    if not found then
      raise exception 'item_not_found' using errcode = 'P0002';
    end if;

    -- Defence in depth: the line's item must belong to the return's org.
    if v_item.organization_id <> v_return.organization_id then
      raise exception 'cross_org_item' using errcode = '42501';
    end if;

    -- INVENTORY MODEL: the returned unit already left on-hand at fulfilment.
    --   RESTOCK → +qty 'return' (re-enters sellable stock; net vs fulfilment = 0).
    --   SCRAP   → +qty 'return' THEN -qty 'loss' (NET-ZERO receive-then-write-off;
    --             a bare -qty would DOUBLE-DECREMENT a unit already gone).
    -- Both record the receive leg as a 'return' movement first.
    v_prev := v_item.quantity_on_hand;
    v_new  := v_prev + v_line.quantity;
    update public.inventory_items
      set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
    where id = v_line.item_id;
    insert into public.stock_movements (
      organization_id, item_id, movement_type,
      quantity_change, previous_quantity, new_quantity,
      reason, reference_type, reference_id, user_id
    ) values (
      v_return.organization_id, v_line.item_id, 'return',
      v_line.quantity, v_prev, v_new,
      'Return ' || v_line.disposition || ' (return ' || p_return_id::text || ')',
      'return', p_return_id, v_user
    );

    -- SCRAP: immediately write the received unit off as a 'loss' so the net
    -- effect on on-hand is zero (the unit is destroyed, it was never sellable).
    if v_line.disposition = 'scrap' then
      v_prev := v_new;
      v_new  := v_prev - v_line.quantity;
      if v_new < 0 then
        raise exception 'insufficient_stock' using errcode = 'P0001';
      end if;
      update public.inventory_items
        set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
      where id = v_line.item_id;
      insert into public.stock_movements (
        organization_id, item_id, movement_type,
        quantity_change, previous_quantity, new_quantity,
        reason, reference_type, reference_id, user_id
      ) values (
        v_return.organization_id, v_line.item_id, 'loss',
        -v_line.quantity, v_prev, v_new,
        'Return scrap write-off (return ' || p_return_id::text || ')',
        'return', p_return_id, v_user
      );
    end if;

    -- Consume the durable budget: this many units of the source line are now
    -- permanently returned. The cap trigger reads (quantity_fulfilled -
    -- returned_quantity); incrementing here (and only here) means a later
    -- cancel/delete of any return header can never reclaim this.
    update public.order_request_lines
      set returned_quantity = returned_quantity + v_line.quantity
    where id = v_line.order_request_line_id;

    -- One-way latch: never apply a disposition twice.
    update public.return_lines
      set applied = true
      where id = v_line.line_id;
  end loop;

  -- Make the received->closed transition atomic with the inventory write: once
  -- stock has moved the return is settled, so close it in the same transaction.
  -- (The status guard above ensures we only ever reach here from 'received'.)
  update public.returns
    set status    = 'closed',
        closed_by = v_user,
        closed_at = now()
  where id = p_return_id;

  select * into v_return from public.returns where id = p_return_id;
  return v_return;
end;
$$;

-- The in-function manager check is the real gate (mirrors cancel_order_request,
-- granted to authenticated). Defensively strip the implicit PUBLIC grant + anon
-- per the SECURITY DEFINER hardening convention (0146).
revoke all on function public.process_return_disposition(uuid) from public, anon;
grant execute on function public.process_return_disposition(uuid) to authenticated;

-- 4. Grandfather: 'returns' module OFF for every existing org (mirrors 0147). -
insert into public.organization_modules (organization_id, module_id, enabled, tier, enabled_at)
select o.id, 'returns', false, 'optional', now()
from public.organizations o
on conflict (organization_id, module_id) do nothing;
