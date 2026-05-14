-- ============================================================================
-- 0077_cancel_order_request_clear_denied_reason.sql
--
-- I1 from the Orders hunter report: cancel_order_request's denied_reason
-- update was set back to `coalesce(p_reason, denied_reason)` when 0055
-- rebuilt the function body. The fix from 0045 (L2) — clear-or-replace,
-- never preserve the prior denial reason on a later cancel — was lost
-- in that rewrite.
--
-- The leak surfaces on the public track page: when a request is denied,
-- then later cancelled (e.g. manager cancels-after-deny), the public
-- track endpoint shows the old denial reason as the cancel reason. Even
-- after 0076's status-transition guard tightens up most of the bad
-- paths, the legitimate cancel-from-denied flow is still allowed for
-- managers and the wrong reason text still appears.
--
-- Fix: replace the trailing UPDATE in cancel_order_request with the
-- 0045 semantics (`denied_reason = p_reason`, not coalesce). The rest
-- of the function body — lock, status check, role gate, reservation
-- release — is unchanged from 0055, copied verbatim so this file is a
-- standalone, idempotent replacement.
-- ============================================================================

create or replace function public.cancel_order_request(
  p_id uuid,
  p_reason text default null
)
returns public.order_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req public.order_requests%rowtype;
  v_user uuid := auth.uid();
  v_is_manager boolean;
  v_is_owner boolean;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  select * into v_req from public.order_requests where id = p_id for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;
  if v_req.status in ('delivered', 'denied', 'cancelled') then
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

  -- I1: clear-or-replace. NEVER preserve a prior `denied_reason` when a
  -- later cancel arrives without its own reason — the prior text is
  -- leaked via the public track endpoint otherwise.
  update public.order_requests
    set status = 'cancelled',
        cancelled_at = now(),
        cancelled_by = v_user,
        denied_reason = p_reason
    where id = p_id;

  select * into v_req from public.order_requests where id = p_id;
  return v_req;
end;
$$;
