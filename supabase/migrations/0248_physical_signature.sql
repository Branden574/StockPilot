-- Physical (paper) signature at hand-over.
--
-- The digital path (confirm_order_signature, token-gated, public sign page)
-- stays untouched in behavior; this adds:
--   1. order_requests.signature_method ('digital' | 'physical') so the order
--      record says HOW the signature was captured. Backfilled 'digital' for
--      every already-signed row; the digital RPC now stamps it going forward.
--   2. confirm_physical_signature(p_id, p_signer_name): the in-app sibling for
--      when the customer signed on PAPER. Same guards (unsigned, hand-over
--      status) and the exact same partial-fulfillment fork as the digital RPC
--      (ship staged batch → owed>0 ? backordered : completed), but authorized
--      by ROLE (manager+ or the assigned delivery driver) instead of a token,
--      and with no signature image (signature_data_url stays NULL).

-- 1. signature_method column + backfill.
alter table public.order_requests
  add column if not exists signature_method text
  check (signature_method in ('digital', 'physical'));

update public.order_requests
  set signature_method = 'digital'
  where signed_at is not null and signature_method is null;

comment on column public.order_requests.signature_method is
  'How the hand-over signature was captured: digital (sign page) or physical (paper, recorded via confirm_physical_signature). NULL = not signed yet.';

-- 2. Digital RPC stamps signature_method going forward (same body as 0244,
--    plus the one new column).
create or replace function public.confirm_order_signature(
  p_id uuid,
  p_signature_token text,
  p_signer_name text,
  p_signer_email text,
  p_signature_data_url text
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_org        uuid;
  v_owed       numeric(14,4);
  v_new_status text;
begin
  if p_id is null
     or coalesce(length(p_signature_token), 0) = 0
     or coalesce(length(trim(p_signer_name)), 0) = 0
     or coalesce(length(trim(p_signer_email)), 0) = 0
     or coalesce(length(p_signature_data_url), 0) = 0
  then
    return null;
  end if;

  select organization_id
    into v_org
    from public.order_requests
    where id = p_id
      and signature_token = p_signature_token
      and signed_at is null
      and status in ('staged_for_pickup', 'in_transit')
      and (signature_token_expires_at is null or signature_token_expires_at > now())
    for update;

  if v_org is null then
    return null;
  end if;

  update public.order_request_lines
    set quantity_fulfilled = coalesce(quantity_fulfilled, 0) + coalesce(quantity_picked, 0),
        quantity_picked    = null
    where order_request_id = p_id;

  select coalesce(sum(greatest(coalesce(quantity_requested, 0) - coalesce(quantity_fulfilled, 0), 0)), 0)
    into v_owed
    from public.order_request_lines
    where order_request_id = p_id;

  v_new_status := case when v_owed > 0 then 'backordered' else 'completed' end;

  update public.order_requests
     set status              = v_new_status,
         signed_by_name      = p_signer_name,
         signed_by_email     = p_signer_email,
         signature_data_url  = p_signature_data_url,
         signature_method    = 'digital',
         signed_at           = now(),
         completed_at        = case when v_new_status = 'completed' then now() else null end,
         completed_by        = null
   where id = p_id;

  return v_org;
end;
$$;

-- 3. The physical sibling: role-authorized, no token, no image.
create or replace function public.confirm_physical_signature(
  p_id uuid,
  p_signer_name text
)
returns order_requests
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_req        public.order_requests%rowtype;
  v_user       uuid := auth.uid();
  v_owed       numeric(14,4);
  v_new_status text;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if coalesce(length(trim(p_signer_name)), 0) = 0 then
    raise exception 'signer_name_required' using errcode = 'P0001';
  end if;

  select * into v_req from public.order_requests where id = p_id for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;

  -- Who may record a paper signature: manager+ (same floor as the other order
  -- actions) OR the assigned delivery driver (they're the one holding the pen
  -- at the door). Mirrors who the UI shows Collect-signature to.
  if not public.has_org_role(v_req.organization_id, 'manager')
     and (v_req.assigned_delivery_user_id is null or v_req.assigned_delivery_user_id <> v_user) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_req.signed_at is not null then
    raise exception 'already_signed' using errcode = 'P0001';
  end if;
  if v_req.status not in ('staged_for_pickup', 'in_transit') then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;

  -- Identical hand-over accounting to the digital RPC: ship the staged batch…
  update public.order_request_lines
    set quantity_fulfilled = coalesce(quantity_fulfilled, 0) + coalesce(quantity_picked, 0),
        quantity_picked    = null
    where order_request_id = p_id;

  -- …then fork on what's still owed.
  select coalesce(sum(greatest(coalesce(quantity_requested, 0) - coalesce(quantity_fulfilled, 0), 0)), 0)
    into v_owed
    from public.order_request_lines
    where order_request_id = p_id;

  v_new_status := case when v_owed > 0 then 'backordered' else 'completed' end;

  update public.order_requests
     set status              = v_new_status,
         signed_by_name      = trim(p_signer_name),
         signed_by_email     = null,
         signature_data_url  = null,
         signature_method    = 'physical',
         signed_at           = now(),
         completed_at        = case when v_new_status = 'completed' then now() else null end,
         completed_by        = v_user
   where id = p_id;

  select * into v_req from public.order_requests where id = p_id;
  return v_req;
end;
$$;

grant execute on function public.confirm_physical_signature(uuid, text) to authenticated, service_role;
