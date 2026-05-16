-- ============================================================================
-- 0115_orders_workflow_cleanup.sql
--
-- SQL cleanup from the orders-workflow-refactor debug pass:
--
--   1. Drop the orphaned deliver_order_request RPC. The TS layer
--      that called it (markDelivered + markOrderRequestDeliveredAction)
--      was removed in commit fd6f87d; the function targeted retired
--      status values ('packaging','ready_for_delivery','delivered')
--      and would 500 on any future call. Better to remove the surface
--      entirely than leave a footgun.
--   2. Update cancel_order_request's terminal-status guard to use
--      'completed' (the new terminal) instead of 'delivered' (which
--      0109 removed from the enum). The DB trigger from 0109 already
--      protects against completed → cancelled via the state machine,
--      but the function's own early-exit message is misleading
--      without this fix. Body is otherwise copied verbatim from 0077
--      so this file is a standalone, idempotent replacement.
--   3. Add a CHECK constraint capping signature_data_url at 512 KB.
--      The TS action layer enforces 500K via Zod, but the column
--      itself has no size guard — if the Zod check is ever loosened
--      or bypassed, an oversized PNG could land in the table and
--      bloat the realtime publication.
--
-- One transaction.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Drop deliver_order_request (orphaned in TS layer).
-- ----------------------------------------------------------------------------

drop function if exists public.deliver_order_request(uuid);

-- ----------------------------------------------------------------------------
-- 2. cancel_order_request: rewrite the terminal-status guard.
--
-- Body is the verbatim 0077 definition with one swap:
--   `v_req.status in ('delivered', ...)` → `v_req.status in ('completed', ...)`
-- ----------------------------------------------------------------------------

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
  if v_req.status in ('completed', 'denied', 'cancelled') then
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

  -- I1 from 0077: clear-or-replace. NEVER preserve a prior `denied_reason`
  -- when a later cancel arrives without its own reason — the prior text
  -- is leaked via the public track endpoint otherwise.
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

-- ----------------------------------------------------------------------------
-- 3. Cap signature_data_url at 512 KB. Existing rows have either NULL
--    or a Zod-clamped value under the limit, so NOT VALID is unnecessary.
-- ----------------------------------------------------------------------------

alter table public.order_requests
  drop constraint if exists order_requests_signature_data_url_len_chk;

alter table public.order_requests
  add constraint order_requests_signature_data_url_len_chk
  check (
    signature_data_url is null
    or length(signature_data_url) <= 524288
  );

commit;

comment on constraint order_requests_signature_data_url_len_chk on public.order_requests is
  'Defense-in-depth: TS layer caps the signature payload at 500K chars '
  '(zod). This DB constraint guarantees no >512KB blob ever lands in the '
  'column, regardless of how the row got written.';
