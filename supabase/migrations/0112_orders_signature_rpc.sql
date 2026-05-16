-- 0112_orders_signature_rpc.sql
--
-- Phase 4 of the orders workflow refactor: introduces the atomic
-- signature-confirmation RPC consumed by /orders/sign/<token> in
-- phase 5. The signature_token column itself was added in 0109 and
-- is minted in this phase when packing slips are generated; this
-- migration adds the partial unique index on the column (so a
-- collision is impossible) and the RPC that the public signature
-- page calls.
--
-- The RPC pattern (atomic state flip + replay protection inside the
-- WHERE clause) mirrors confirm_public_order_request from 0108.

begin;

-- ────────────────────────────────────────────────────────────────────
-- 1. Partial unique index on signature_token.
--
-- Migration 0109 already adds `order_requests_signature_token_idx`
-- as a partial unique index; this is a no-op restate via
-- `create unique index if not exists` to make the migration
-- idempotent if anyone re-runs it during testing.
-- ────────────────────────────────────────────────────────────────────
create unique index if not exists order_requests_signature_token_idx
  on public.order_requests(signature_token)
  where signature_token is not null;

-- ────────────────────────────────────────────────────────────────────
-- 2. confirm_order_signature — public signature submission endpoint.
--
-- Called from /orders/sign/<token> in phase 5. Validates the token,
-- ensures the order is in a signable status, atomically flips it to
-- 'completed' and writes the signature fields. Replay protection is
-- the `signed_at IS NULL` guard inside the WHERE — a second click
-- after success returns zero rows and the caller renders the
-- "already used / invalid" panel.
-- ────────────────────────────────────────────────────────────────────
create or replace function public.confirm_order_signature(
  p_id                uuid,
  p_signature_token   text,
  p_signer_name       text,
  p_signer_email      text,
  p_signature_data_url text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  if p_id is null
     or coalesce(length(p_signature_token), 0) = 0
     or coalesce(length(trim(p_signer_name)), 0) = 0
     or coalesce(length(trim(p_signer_email)), 0) = 0
     or coalesce(length(p_signature_data_url), 0) = 0
  then
    return null;
  end if;

  update public.order_requests
     set status              = 'completed',
         signed_by_name      = p_signer_name,
         signed_by_email     = p_signer_email,
         signature_data_url  = p_signature_data_url,
         signed_at           = now(),
         completed_at        = now(),
         completed_by        = null
   where id = p_id
     and signature_token = p_signature_token
     and signed_at is null
     and status in ('staged_for_pickup', 'in_transit', 'signature_requested')
     and (
       signature_token_expires_at is null
       or signature_token_expires_at > now()
     )
   returning organization_id into v_org;

  return v_org;
end;
$$;

revoke all on function public.confirm_order_signature(uuid, text, text, text, text)
  from public, anon, authenticated;

grant execute on function public.confirm_order_signature(uuid, text, text, text, text)
  to service_role;

comment on function public.confirm_order_signature(uuid, text, text, text, text) is
  'Validates a signature token + signer details and atomically promotes the '
  'order from staged_for_pickup / in_transit / signature_requested to '
  'completed. Service-role only — phase 5 public page hashes the URL token '
  'before calling. The signed_at IS NULL clause inside WHERE guarantees '
  'no double-completion on replay clicks.';

commit;
