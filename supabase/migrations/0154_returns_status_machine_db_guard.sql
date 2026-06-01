-- ============================================================================
-- 0154_returns_status_machine_db_guard.sql — close the cancel/revive
-- inventory-inflation hole in the Returns/RMA module (0153).
--
-- A2 review (BLOCKING / high). 0153 enforced the RMA state machine ONLY in the
-- application service (ALLOWED_RETURN_TRANSITIONS in returns.ts). At the DB:
--   • the returns.status CHECK admits all 6 values with NO transition matrix,
--   • there was NO transition trigger on `returns`, and
--   • write was manager-gated but unconstrained as to WHICH status move is legal
--     (0153 now splits write into for-insert + for-update so DELETE has no
--     permissive grant; this migration adds the transition trigger + restrictive
--     DELETE deny on top).
-- The fulfilled-cap constraint trigger (return_lines_enforce_fulfilled_cap)
-- only fires on INSERT/UPDATE of return_lines (quantity, order_request_line_id,
-- item_id); it NEVER re-evaluates when a `returns` row changes status.
--
-- The DURABLE BUDGET (0153) already closes the original SUM-based inflation hole
-- at its root: order_request_lines.returned_quantity is incremented at apply-time
-- and the cap reads (quantity_fulfilled - returned_quantity), so a cancel→revive
-- can no longer reclaim budget that stock already moved against. This migration
-- keeps the remaining state-machine defences below — they bound which status
-- moves are even legal and keep PENDING (unapplied) demand from being forged past
-- the workflow. Historical exploit the transition guard closes (PATCH via the raw
-- PostgREST data API — PATCH /rest/v1/returns): a manager skipping approve/receive
-- (PATCH 'requested' → 'received', then close) or reviving a terminal return.
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
--   (2) process_return_disposition RE-ASSERTS the durable budget immediately
--       before moving stock: for every line it locks the source order line and
--       refuses if (returned_quantity + this line's quantity) would exceed
--       quantity_fulfilled. So the RPC itself will not inflate inventory even if
--       a header status were somehow forged past layer (1). It also applies the
--       NET-ZERO scrap (+qty 'return' then -qty 'loss') and increments
--       returned_quantity at apply-time, identical to the 0153 definition this
--       supersedes (this redefinition only ADDS the layer-2 backstop check).
--
--   (3) RLS: RESTRICTIVE deny DELETE on returns + return_lines. 0153 already
--       split write into separate for-insert + for-update policies (no
--       permissive DELETE grant — the 0119 pattern), so DELETE is denied by
--       default; a RESTRICTIVE `using(false)` policy makes the deny BIND even if
--       a future migration adds a permissive DELETE policy. UPDATE stays
--       manager-gated, but the transition trigger (1) is the authoritative guard
--       on *which* status moves are legal, so a manager can no longer forge an
--       arbitrary transition.
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
-- 2. RLS RESTRICTIVE deny DELETE (mirrors 0119 order_requests intent).
-- ─────────────────────────────────────────────────────────────────────
-- Returns are state-managed via the transition trigger above; deletion is
-- never part of the workflow (cancel flips status='cancelled' instead). 0153
-- splits write into separate for-insert + for-update policies (no permissive
-- DELETE grant), so DELETE is already denied by default. Add RESTRICTIVE
-- `using(false)` DELETE policies on top so the deny BINDS unconditionally: a
-- restrictive policy is AND-ed with any permissive policy, so even a future
-- migration that accidentally adds a permissive DELETE policy cannot let a
-- manager DELETE a live return (which would silently drop its pending
-- return_lines and let a fresh full return be opened against the freed pending
-- budget). SECURITY DEFINER RPCs bypass RLS and never delete anyway.
drop policy if exists returns_no_delete on public.returns;
create policy returns_no_delete on public.returns
  as restrictive
  for delete to authenticated
  using (false);

drop policy if exists return_lines_no_delete on public.return_lines;
create policy return_lines_no_delete on public.return_lines
  as restrictive
  for delete to authenticated
  using (false);

-- ─────────────────────────────────────────────────────────────────────
-- 3. process_return_disposition — re-assert the durable budget before stock.
-- ─────────────────────────────────────────────────────────────────────
-- Identical to the 0153 definition (NET-ZERO scrap, returned_quantity
-- increment) EXCEPT: before moving each line's stock, lock the source order line
-- FOR UPDATE and refuse if (returned_quantity + this line's quantity) would
-- exceed quantity_fulfilled. This makes the RPC the final, self-contained
-- backstop: even if a header status were forged past the transition trigger, the
-- RPC will not consume more budget than was fulfilled. Reading the durable
-- returned_quantity (already-applied units) rather than a SUM over mutable return
-- rows means a cancel→revive cannot trick the backstop — applied budget is never
-- reclaimed. Locking the source line FOR UPDATE serialises concurrent
-- dispositions for the same line, so two separately-live returns for one line can
-- no longer jointly inflate inventory.
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
    -- ── Layer-2 backstop (0154): re-assert the DURABLE budget for this source
    -- line BEFORE moving any stock. Lock the source line FOR UPDATE so concurrent
    -- dispositions for the same line serialise, then refuse if consuming this
    -- line's quantity would push returned_quantity past quantity_fulfilled. If it
    -- would, a header status was forged past the transition trigger / INSERT cap
    -- (e.g. a cancel→revive). Reading the durable returned_quantity (not a SUM
    -- over mutable return rows) means a revive cannot trick this check. Applies to
    -- scrap lines too — over-claiming a line at all is inconsistent, reject
    -- regardless of disposition.
    select orl.quantity_fulfilled, orl.returned_quantity
      into v_fulfilled, v_returned
    from public.order_request_lines orl
    where orl.id = v_line.order_request_line_id
    for update;
    if not found then
      raise exception 'order_request_line_not_found'
        using errcode = 'P0002', detail = v_line.order_request_line_id::text;
    end if;

    if v_returned + v_line.quantity > v_fulfilled then
      raise exception 'return_exceeds_fulfilled'
        using errcode = 'P0001',
              detail = format(
                'order_request_line %s: returned %s + %s exceeds fulfilled %s',
                v_line.order_request_line_id, v_returned, v_line.quantity, v_fulfilled
              );
    end if;

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

    -- Consume the durable budget (idempotent via the applied latch below).
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
