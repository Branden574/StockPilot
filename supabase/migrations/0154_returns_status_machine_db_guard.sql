-- ============================================================================
-- 0154_returns_status_machine_db_guard.sql — close the cancel/revive
-- inventory-inflation hole in the Returns/RMA module (0153).
--
-- A2 review (BLOCKING / high). 0153 enforced the RMA state machine ONLY in the
-- application service (ALLOWED_RETURN_TRANSITIONS in returns.ts). At the DB:
--   • the returns.status CHECK admits all 6 values with NO transition matrix,
--   • there was NO transition trigger on `returns`, and
--   • returns_write is a blanket `for all to authenticated` gated only by
--     has_org_role(...,'manager').
-- The fulfilled-cap constraint trigger (return_lines_enforce_fulfilled_cap)
-- only fires on INSERT/UPDATE of return_lines (quantity, order_request_line_id);
-- it NEVER re-evaluates when a `returns` row changes status.
--
-- Exploit (any manager via the raw PostgREST data API — PATCH /rest/v1/returns):
--   order line fulfilled = 10.
--   1. Create Return A (line 10) → live.            cap SUM(live)=10  OK
--   2. Cancel A.                                      SUM(live)=0
--   3. Create Return B (line 10) → live.            cap SUM(live)=10  OK (A excluded)
--   4. PATCH A.status back to 'received' directly.   NO cap trigger fires,
--                                                     NO app guard runs.
--      Now SUM(live)=A(10)+B(10)=20 > fulfilled 10, never re-checked.
--   5. close(A) and close(B) each pass the status='received' guard and
--      restock +10 each ⇒ quantity_on_hand inflated by 10 beyond fulfilled.
-- The same raw-API path also lets a manager skip approve/receive entirely
-- (PATCH 'requested' → 'received', then close).
--
-- The order_requests workflow already defends against exactly this with a DB
-- transition trigger (_validate_order_request_status_transition, 0076) plus
-- deny-by-default direct UPDATE/DELETE RLS (0119). Returns omitted both. This
-- migration brings returns up to that bar — defence in depth, three layers:
--
--   (1) BEFORE UPDATE transition trigger on public.returns that rejects any
--       status change not in the documented matrix. This closes the revive
--       edge (cancelled/denied → any live state is illegal) and the skip edge
--       (e.g. requested → received), independent of which client issues the
--       UPDATE (service OR raw data API). Mirrors 0076.
--
--   (2) process_return_disposition RE-ASSERTS the per-source-line fulfilled cap
--       immediately before moving stock: for every restock line it sums the
--       quantity of all live (non-cancelled/denied) return_lines for that
--       source line and refuses if the total exceeds quantity_fulfilled. So the
--       RPC itself will not inflate inventory even if a header status were
--       somehow forged past layer (1). The source line is locked FOR UPDATE so
--       concurrent dispositions for the same line serialise.
--
--   (3) RLS: explicit deny-by-default DELETE on returns + return_lines (mirrors
--       0119 order_requests). UPDATE stays manager-gated, but the transition
--       trigger (1) is now the authoritative guard on *which* status moves are
--       legal, so a manager can no longer forge an arbitrary transition.
--
-- search_path = public, extensions: process_return_disposition's inline stock
-- write needs pgcrypto in `extensions` (same trap as 0153 / 0137 / 0134).
--
-- Also (A2 review, low): deny() wrote its reason into `notes`, clobbering any
-- creation-time notes from createFromOrder. Add a dedicated `denial_reason`
-- column (mirrors order_requests.denied_reason) so the denial reason and the
-- original notes coexist; the service writes the reason there going forward.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────
-- 0. Dedicated denial reason column (stop clobbering returns.notes).
-- ─────────────────────────────────────────────────────────────────────
alter table public.returns add column if not exists denial_reason text;

-- ─────────────────────────────────────────────────────────────────────
-- 1. Transition trigger — reject any status move outside the RMA matrix.
-- ─────────────────────────────────────────────────────────────────────
-- Allowed transitions (old → new), verbatim from ALLOWED_RETURN_TRANSITIONS
-- in apps/web/src/server/services/returns.ts:
--   requested → approved, denied, cancelled
--   approved  → received, cancelled
--   received  → closed
--   closed    → (none — terminal)
--   denied    → (none — terminal)
--   cancelled → (none — terminal)
-- Notably: NO edge INTO a live state (requested/approved/received) from a
-- terminal state (closed/denied/cancelled), and no jump that skips
-- approved/received. SECURITY INVOKER — it only inspects OLD/NEW (mirrors 0076).
create or replace function public._validate_return_status_transition()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_old text := old.status;
  v_new text := new.status;
  v_ok  boolean := false;
begin
  -- Same status → nothing to validate (an unchanged value in the SET clause
  -- passes through). This trigger only matters when status actually changes.
  if v_old is not distinct from v_new then
    return new;
  end if;

  v_ok := case v_old
    when 'requested' then v_new in ('approved', 'denied', 'cancelled')
    when 'approved'  then v_new in ('received', 'cancelled')
    when 'received'  then v_new = 'closed'
    when 'closed'    then false
    when 'denied'    then false
    when 'cancelled' then false
    else false
  end;

  if not v_ok then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001',
            detail  = format('Cannot move return from %s to %s', v_old, v_new);
  end if;

  return new;
end;
$$;

-- BEFORE UPDATE OF status so a doomed transition is rejected before
-- tg_set_updated_at (and any future side-effect trigger) fires. Mirrors 0076.
drop trigger if exists trg_returns_validate_transition on public.returns;
create trigger trg_returns_validate_transition
  before update of status on public.returns
  for each row
  execute function public._validate_return_status_transition();

-- ─────────────────────────────────────────────────────────────────────
-- 2. RLS deny-by-default DELETE (mirrors 0119 order_requests).
-- ─────────────────────────────────────────────────────────────────────
-- Returns are state-managed via the transition trigger above; deletion is
-- never part of the workflow (cancel flips status='cancelled' instead).
-- The 0153 returns_write / return_lines_write policies are `for all`, which
-- includes DELETE — make the deny explicit so a manager cannot DELETE a live
-- return row (which would, e.g., re-open the cross-return cap for a new full
-- return after the deleted one's lines vanish). SECURITY DEFINER RPCs are
-- unaffected (they bypass RLS); none of them delete anyway.
drop policy if exists returns_no_delete on public.returns;
create policy returns_no_delete on public.returns
  for delete to authenticated
  using (false);

drop policy if exists return_lines_no_delete on public.return_lines;
create policy return_lines_no_delete on public.return_lines
  for delete to authenticated
  using (false);

-- ─────────────────────────────────────────────────────────────────────
-- 3. process_return_disposition — re-assert the fulfilled cap before stock.
-- ─────────────────────────────────────────────────────────────────────
-- Identical to 0153 EXCEPT: before restocking each line, re-run the
-- per-source-line cap (SUM of live return_lines.quantity <= quantity_fulfilled)
-- with the source line locked FOR UPDATE. This makes the RPC the final,
-- self-contained backstop: even if a header status were forged past the
-- transition trigger, the RPC refuses to push stock that would exceed what was
-- fulfilled. The check counts ALL live return_lines for the source line
-- (across every non-cancelled/denied return) — the same aggregate the INSERT
-- cap trigger enforces — so two separately-live returns for one line can no
-- longer jointly inflate inventory.
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
  v_delta   numeric;
  v_movement text;
  v_fulfilled numeric(14,4);
  v_returned  numeric(14,4);
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
    -- ── Layer-3 backstop (0154): re-assert the cross-return fulfilled cap for
    -- this source line BEFORE moving any stock. Lock the source line FOR UPDATE
    -- so concurrent dispositions for the same line serialise, then sum the
    -- quantity of EVERY live (non-cancelled/denied) return_line for it. If that
    -- exceeds quantity_fulfilled the headers were forged past the transition
    -- trigger / INSERT cap (e.g. a cancel→revive); refuse to inflate inventory.
    -- This applies to scrap lines too — over-claiming a line at all means the
    -- aggregate is inconsistent, so we reject regardless of disposition.
    select orl.quantity_fulfilled
      into v_fulfilled
    from public.order_request_lines orl
    where orl.id = v_line.order_request_line_id
    for update;
    if not found then
      raise exception 'order_request_line_not_found'
        using errcode = 'P0002', detail = v_line.order_request_line_id::text;
    end if;

    select coalesce(sum(rl.quantity), 0)
      into v_returned
    from public.return_lines rl
    join public.returns r on r.id = rl.return_id
    where rl.order_request_line_id = v_line.order_request_line_id
      and r.status not in ('cancelled', 'denied');

    if v_returned > v_fulfilled then
      raise exception 'return_exceeds_fulfilled'
        using errcode = 'P0001',
              detail = format(
                'order_request_line %s: returned %s exceeds fulfilled %s',
                v_line.order_request_line_id, v_returned, v_fulfilled
              );
    end if;

    -- RESTOCK = +qty 'return'; SCRAP = -qty 'loss'.
    if v_line.disposition = 'restock' then
      v_delta    := v_line.quantity;
      v_movement := 'return';
    else
      v_delta    := -v_line.quantity;
      v_movement := 'loss';
    end if;

    -- Atomic on-hand change (mirrors adjust_stock's body so we can also stamp
    -- reference_type/reference_id on the ledger row).
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

    v_prev := v_item.quantity_on_hand;
    v_new  := v_prev + v_delta;
    if v_new < 0 then
      raise exception 'insufficient_stock' using errcode = 'P0001';
    end if;

    update public.inventory_items
      set quantity_on_hand = v_new,
          updated_at       = now(),
          updated_by       = v_user
    where id = v_line.item_id;

    insert into public.stock_movements (
      organization_id, item_id, movement_type,
      quantity_change, previous_quantity, new_quantity,
      reason, reference_type, reference_id, user_id
    ) values (
      v_return.organization_id, v_line.item_id, v_movement,
      v_delta, v_prev, v_new,
      'Return ' || v_line.disposition || ' (return ' || p_return_id::text || ')',
      'return', p_return_id, v_user
    );

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
