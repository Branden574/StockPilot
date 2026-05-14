-- ============================================================================
-- 0076_order_request_status_transition_guard.sql
--
-- C4 from the Orders hunter report: the order_requests UPDATE RLS policy
-- (tightened in 0045) only restricts WHO can write, not WHICH status
-- transitions are valid. A manager (or a privileged client running raw
-- SQL through the service-role admin client) could in principle:
--
--   • Flip a 'denied' row back to 'pending_approval' (re-arming the
--     approve flow without auditable cancel/approve events)
--   • Flip a 'delivered' row back to 'approved' (un-decrementing stock
--     in the application logic's mental model, while the underlying
--     stock_movements row stays)
--   • Skip statuses entirely (pending_approval → delivered) without
--     ever creating the stock_reservations that the approve RPC inserts
--
-- The SECURITY DEFINER RPCs (approve / deliver / cancel) enforce their
-- own valid-previous-status checks, but `setStatus` in the TS service
-- writes directly to the table for the packaging / ready_for_delivery
-- legs — and any future direct-update path would also bypass the RPCs.
--
-- This trigger fires for every UPDATE on order_requests and rejects any
-- non-whitelisted status transition. The legal transitions match the
-- state machine documented in
-- docs/superpowers/specs/2026-05-08-order-requests-design.md.
--
-- Allowed transitions (old → new):
--   pending_approval  → approved, denied, cancelled
--   approved          → packaging, ready_for_delivery, delivered, cancelled
--   packaging         → ready_for_delivery, delivered, cancelled
--   ready_for_delivery→ delivered, cancelled
--   delivered         → (none — terminal)
--   denied            → (none — terminal)
--   cancelled         → (none — terminal)
--
-- NB:
--   • Same-status updates (status NOT changed) are always allowed —
--     this trigger only fires when status actually changes.
--   • The function name is underscore-prefixed (`_validate_…`) to mark
--     it as a private helper, matching the existing `_notify_*` helpers.
--   • SECURITY INVOKER (the default) is correct here — the trigger
--     just inspects OLD and NEW; it doesn't read anything that needs
--     elevated privileges.
-- ============================================================================

create or replace function public._validate_order_request_status_transition()
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
  -- Same status → nothing to validate. Even if the status column was
  -- listed in the UPDATE SET clause, an unchanged value passes through.
  if v_old is not distinct from v_new then
    return new;
  end if;

  v_ok := case v_old
    when 'pending_approval'   then v_new in ('approved', 'denied', 'cancelled')
    when 'approved'           then v_new in ('packaging', 'ready_for_delivery', 'delivered', 'cancelled')
    when 'packaging'          then v_new in ('ready_for_delivery', 'delivered', 'cancelled')
    when 'ready_for_delivery' then v_new in ('delivered', 'cancelled')
    when 'delivered'          then false
    when 'denied'             then false
    when 'cancelled'          then false
    else false
  end;

  if not v_ok then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001',
            detail  = format('Cannot move order_request from %s to %s', v_old, v_new);
  end if;

  return new;
end;
$$;

-- BEFORE UPDATE so we reject before any other side-effects (notification
-- writer trigger, _set_updated_at, etc.) fire on a doomed transition.
drop trigger if exists trg_order_requests_validate_transition on public.order_requests;
create trigger trg_order_requests_validate_transition
  before update of status on public.order_requests
  for each row
  execute function public._validate_order_request_status_transition();
