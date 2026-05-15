-- 0108_public_order_requests_confirm.sql
--
-- Public-order-request anti-spam: introduce a 'pending_confirmation'
-- status so a stranger filling out the public form does NOT spam the
-- target org's manager queue OR third-party emails routed through our
-- Resend account until the listed `requesterEmail` clicks a one-time
-- confirmation link.
--
-- The flow becomes:
--   1. POST /api/v1/public/order-requests
--      → row inserted with status='pending_confirmation',
--        confirmation_token_hash set, expires in 24h.
--      → "click to confirm" email sent to requester_email.
--      → Managers DO NOT see this row yet (it's not pending_approval).
--   2. Recipient clicks `/r/confirm?id=…&t=…`
--      → RPC validates the token + expiry, transitions to
--        'pending_approval'.
--      → Existing notify-on-status-change branch emits the
--        manager-side "new request" notification (we route it through
--        the UPDATE branch below).
--   3. Unconfirmed rows past `confirmation_token_expires_at` get
--      reaped by `cleanup_expired_unconfirmed_order_requests()`.
--
-- This narrows the spam-via-Resend window from "anyone with the public
-- token can send one email to any address per request" to "anyone with
-- the public token AND the target's address can prompt the target with
-- one click-to-confirm email" — the target then never confirms, the
-- row dies, and no manager-side noise ever happens.

-- ────────────────────────────────────────────────────────────────────
-- 1. Status enum: add 'pending_confirmation'
-- ────────────────────────────────────────────────────────────────────
alter table public.order_requests
  drop constraint if exists order_requests_status_check;

alter table public.order_requests
  add constraint order_requests_status_check
  check (status in (
    'pending_confirmation',
    'pending_approval','approved','packaging',
    'ready_for_delivery','delivered',
    'denied','cancelled'
  ));

-- ────────────────────────────────────────────────────────────────────
-- 2. Token columns
-- ────────────────────────────────────────────────────────────────────
alter table public.order_requests
  add column if not exists confirmation_token_hash       text,
  add column if not exists confirmation_token_expires_at timestamptz;

-- Fast lookup on the (id, hash, status) triple used by the confirm RPC.
-- Partial — only rows still awaiting confirmation have a non-null hash,
-- and they're the only ones we ever index-probe.
create unique index if not exists order_requests_confirm_token_hash_idx
  on public.order_requests(confirmation_token_hash)
  where confirmation_token_hash is not null;

-- ────────────────────────────────────────────────────────────────────
-- 3. Status-transition guard: pending_confirmation may go to
--    pending_approval (the confirm click) or cancelled (TTL expiry
--    cleanup, or future "user cancelled" path). Nothing else.
-- ────────────────────────────────────────────────────────────────────
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
  if v_old is not distinct from v_new then
    return new;
  end if;

  v_ok := case v_old
    when 'pending_confirmation' then v_new in ('pending_approval', 'cancelled')
    when 'pending_approval'     then v_new in ('approved', 'denied', 'cancelled')
    when 'approved'             then v_new in ('packaging', 'ready_for_delivery', 'delivered', 'cancelled')
    when 'packaging'            then v_new in ('ready_for_delivery', 'delivered', 'cancelled')
    when 'ready_for_delivery'   then v_new in ('delivered', 'cancelled')
    when 'delivered'            then false
    when 'denied'               then false
    when 'cancelled'            then false
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

-- ────────────────────────────────────────────────────────────────────
-- 4. Notification trigger: when a row is INSERTed at
--    'pending_confirmation' we MUST NOT ping every manager — that's
--    the whole spam path we're closing. The existing function pings on
--    every INSERT, so wrap that branch with a status guard. Promotion
--    to pending_approval happens via UPDATE, which we route through a
--    new "treat-as-new" branch so managers DO get the bell + push when
--    the requester confirms.
-- ────────────────────────────────────────────────────────────────────
create or replace function public._notify_order_request_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link text;
  v_title text;
  v_body text;
  v_recipient uuid;
  v_recipients_loop record;
  v_metadata jsonb;
begin
  v_link := '/dashboard/orders/' || new.id::text;
  v_metadata := jsonb_build_object(
    'order_request_id', new.id,
    'warehouse_id', new.warehouse_id,
    'source', new.source,
    'requester_user_id', new.requester_user_id,
    'requester_email', new.requester_email
  );

  if (tg_op = 'INSERT') then
    -- pending_confirmation rows are invisible to managers until the
    -- public requester confirms via email — DO NOT broadcast them.
    if new.status = 'pending_confirmation' then
      return new;
    end if;
    v_title := 'New order request' ||
               case when new.requester_name is not null
                    then ' from ' || new.requester_name else '' end;
    v_body := 'A request is waiting for approval.';
    for v_recipients_loop in
      select user_id from public._notify_recipients(new.organization_id)
    loop
      insert into public.notifications (
        organization_id, user_id, type, title, body, link, metadata
      ) values (
        new.organization_id, v_recipients_loop.user_id,
        'order_request.created', v_title, v_body, v_link, v_metadata
      );
    end loop;
    return new;
  end if;

  if (tg_op = 'UPDATE') then
    if old.status is not distinct from new.status then
      return new;
    end if;

    -- pending_confirmation → pending_approval is essentially the
    -- "real" creation from the manager's perspective. Emit the same
    -- broadcast the original INSERT branch used to send.
    if old.status = 'pending_confirmation' and new.status = 'pending_approval' then
      v_title := 'New order request' ||
                 case when new.requester_name is not null
                      then ' from ' || new.requester_name else '' end;
      v_body := 'A request is waiting for approval.';
      for v_recipients_loop in
        select user_id from public._notify_recipients(new.organization_id)
      loop
        insert into public.notifications (
          organization_id, user_id, type, title, body, link, metadata
        ) values (
          new.organization_id, v_recipients_loop.user_id,
          'order_request.created', v_title, v_body, v_link, v_metadata
        );
      end loop;
      return new;
    end if;

    if new.status = 'cancelled'
       and old.status in ('approved','packaging','ready_for_delivery')
       and new.cancelled_by is not null
       and not public.has_org_role(new.organization_id, 'manager')
    then
      v_title := 'Order request cancelled after approval';
      v_body := 'Reservation was released. Stop packaging if you started.';
      for v_recipients_loop in
        select user_id from public._notify_recipients(new.organization_id)
      loop
        insert into public.notifications (
          organization_id, user_id, type, title, body, link, metadata
        ) values (
          new.organization_id, v_recipients_loop.user_id,
          'order_request.cancelled_after_approval',
          v_title, v_body, v_link, v_metadata
        );
      end loop;
      return new;
    end if;

    v_recipient := new.requester_user_id;
    if v_recipient is null then
      return new;
    end if;

    case new.status
      when 'approved' then
        v_title := 'Your order request was approved';
        v_body := 'Stock has been reserved.';
      when 'denied' then
        v_title := 'Your order request was denied';
        v_body := coalesce(new.denied_reason, 'See the order page for details.');
      when 'packaging' then
        v_title := 'Your order is being packaged';
        v_body := 'Items are being pulled now.';
      when 'ready_for_delivery' then
        v_title := 'Your order is ready';
        v_body := 'Pickup or delivery is queued.';
      when 'delivered' then
        v_title := 'Your order was delivered';
        v_body := 'Inventory was updated.';
      when 'cancelled' then
        v_title := 'Your order was cancelled';
        v_body := coalesce(new.denied_reason, 'See the order page for details.');
      else
        return new;
    end case;

    insert into public.notifications (
      organization_id, user_id, type, title, body, link, metadata
    ) values (
      new.organization_id, v_recipient,
      'order_request.' || new.status,
      v_title, v_body, v_link, v_metadata
    );
  end if;
  return new;
end;
$$;

-- ────────────────────────────────────────────────────────────────────
-- 5. Confirm RPC. SECURITY DEFINER so RLS doesn't bite — the row
--    is org-scoped but the caller is anonymous. The function checks
--    every guard internally:
--      - row exists with that id
--      - hash matches the supplied (already-hashed) token
--      - status is still pending_confirmation
--      - expiry has not passed
--    Returns the organization_id on success (the caller uses it to
--    revalidate the manager dashboard), null otherwise.
-- ────────────────────────────────────────────────────────────────────
create or replace function public.confirm_public_order_request(
  p_id         uuid,
  p_token_hash text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  if p_id is null or coalesce(length(p_token_hash), 0) = 0 then
    return null;
  end if;

  update public.order_requests
     set status                       = 'pending_approval',
         confirmation_token_hash      = null,
         confirmation_token_expires_at = null
   where id = p_id
     and status = 'pending_confirmation'
     and confirmation_token_hash = p_token_hash
     and confirmation_token_expires_at is not null
     and confirmation_token_expires_at > now()
   returning organization_id into v_org;

  return v_org;
end;
$$;

revoke all on function public.confirm_public_order_request(uuid, text)
  from public, anon, authenticated;
grant execute on function public.confirm_public_order_request(uuid, text)
  to service_role;

comment on function public.confirm_public_order_request(uuid, text) is
  'Validates an emailed confirmation token for a public order request '
  'and atomically promotes the row from pending_confirmation to '
  'pending_approval. Service-role only; the caller has already hashed '
  'the plaintext token from the URL.';

-- ────────────────────────────────────────────────────────────────────
-- 6. Cleanup function for expired unconfirmed rows. Cheap to call on
--    every public submit so the table doesn't accumulate junk.
-- ────────────────────────────────────────────────────────────────────
create or replace function public.cleanup_expired_unconfirmed_order_requests()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  delete from public.order_requests
   where status = 'pending_confirmation'
     and confirmation_token_expires_at is not null
     and confirmation_token_expires_at < now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.cleanup_expired_unconfirmed_order_requests()
  from public, anon, authenticated;
grant execute on function public.cleanup_expired_unconfirmed_order_requests()
  to service_role;

comment on function public.cleanup_expired_unconfirmed_order_requests() is
  'Hard-deletes order_requests rows stuck in pending_confirmation past '
  'their expiry. Returns the number purged. Safe to call on every '
  'public submit (cheap when there is nothing to clean).';
