-- Portal Place order: placed once, however many times it is sent.
--
-- The B2B customer portal places an order through the service role
-- (customers have no table grants): portalSubmitOrder checks the cart
-- against the customer's catalog, then calls insert_order_request_with_lines
-- (0413), which writes a new order on every call. When the answer to Place
-- order is lost and the customer presses again, the same cart becomes a
-- second order. The staff New order page and the phone send a submission
-- key (0391: place_order_request and order_submissions); the portal sent
-- none.
--
-- ── WHAT THIS DOES ─────────────────────────────────────────────────────────
-- It gives the portal 0391's key, on 0391's table. No parallel table.
--   1. order_submissions.surface also accepts 'portal' (the CHECK is restated
--      wider; every existing row passes it, no row changes).
--   2. _portal_order_request_hash(header, lines): the portal request's hash,
--      md5 of 'portal_order_create:v1|' and the canonical jsonb text of the
--      organization, customer, requester, notes and the lines summed per
--      item in item order. Its own scope tag: a portal key never replays a
--      staff answer, nor the other way round.
--   3. portal_order_submission_status(header, lines, key): a read, no lock.
--      none, or placed (a replay) with the order id; a key that holds
--      another cart, another customer's order or a staff submission is
--      P0001 idempotency_conflict with NO detail (no order is named).
--      The service asks it before the catalog checks, so a resend after the
--      catalog changed still answers the first order (0391's replay first).
--   4. place_portal_order_request(header, lines, key): the portal's keyed
--      write. The status again under 0391's key lock (the same namespace as
--      place_order_request, so one key is decided once), then
--      insert_order_request_with_lines unchanged, as the service role (the
--      rights and triggers the portal has today), then one placed row.
--   5. _record_portal_order_submission(...): the one row's writer, SECURITY
--      DEFINER (service_role holds no INSERT on order_submissions, by 0391's
--      design, and keeps none). It writes only while
--      stockpilot.portal_order_submit holds THIS transaction's id (the 0359
--      carrier pattern), raised inline by place_portal_order_request alone,
--      and only for a portal order of that organization by that requester.
--      0391's flag (stockpilot.order_submit) and its census are untouched.
--
-- ── DEPLOY ORDER ───────────────────────────────────────────────────────────
-- This file adds the functions only; nothing calls them yet. The web change
-- that sends the portal's key ships after this is live: a web build that
-- calls them against a database without them would refuse every portal
-- order. The current web keeps working against this file unchanged.
--
-- ── SCOPE OF A KEY ─────────────────────────────────────────────────────────
-- The row is (organization, user, key), as 0391's: the customer's own auth
-- account is the user (every account has its user_profiles row, so 0393's
-- key holds, and a deleted account takes its rows). The customer is in the
-- hash and is checked on the order, so the same user under another customer
-- of the organization gets a conflict, never the order. Another user, or
-- another organization, never finds the row at all.
--
-- ── GRANTS ─────────────────────────────────────────────────────────────────
-- Each new function: REVOKE ALL from PUBLIC, anon, authenticated and
-- service_role, then EXECUTE to service_role only (the portal's only caller
-- is the server's admin client). order_submissions' grants do not change.
--
-- ── LOCK FOOTPRINT ─────────────────────────────────────────────────────────
-- Restating the CHECK takes ACCESS EXCLUSIVE on order_submissions (and scans
-- it once). One prelude takes it NOWAIT in a bounded retry before anything
-- else, so the file never waits while holding a lock; the comments below run
-- on the same table. Creating plpgsql functions reads no table.
-- lock_timeout 900ms bounds any other wait.
--
-- ERRORS raised by the new functions: 42501, 22023, P0001 and 55P03 (past
-- lock_timeout 5s; nothing written, send again with the same key). Never
-- 40001 or 40P01 (0367).

set lock_timeout = '900ms';

-- ═══ 0. The lock prelude ══════════════════════════════════════════════════
do $lock$
declare
  v_try integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.order_submissions in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if v_try >= 40 then
        raise;
      end if;
    end;
    perform pg_sleep(0.05 + random() * 0.1);
  end loop;
end $lock$;

-- ═══ 1. surface: web, app or portal ═══════════════════════════════════════
alter table public.order_submissions
  drop constraint order_submissions_surface_check,
  add constraint order_submissions_surface_check check (surface in ('web', 'app', 'portal'));

comment on column public.order_submissions.surface is
  'Where the submission came from: web (the New order page), app (POST /api/v1/orders) or portal (the B2B '
  'customer portal''s Place order, recorded by _record_portal_order_submission).';
comment on table public.order_submissions is
  'One private record per order submission key (0391): (organization, placer, key) -> placed (with the '
  'order), refused (with the reason) or withdrawn, decided under the key''s advisory lock in the '
  'transaction that creates the order. Rows never change (no UPDATE or DELETE policy). Each member reads '
  'only their own rows. INSERT only while stockpilot.order_submit holds this transaction''s id, raised '
  'inline by place_order_request and withdraw_order_submission alone; a portal row (surface portal, the '
  'customer''s own account as placer) is written only by _record_portal_order_submission, while '
  'stockpilot.portal_order_submit holds this transaction''s id, raised inline by place_portal_order_request '
  'alone. The placer''s rows go with their account (0393, ON DELETE CASCADE: never blocks a deletion); the '
  'organization and the order cascade.';

-- ═══ 2. _portal_order_request_hash ════════════════════════════════════════
-- Called only after portal_order_submission_status has checked the shape
-- (uuid strings, whole quantities), so every cast here is safe.
create function public._portal_order_request_hash(p_header jsonb, p_lines jsonb)
returns text
language sql
immutable
security invoker
set search_path = public, pg_temp
as $$
  select md5('portal_order_create:v1|' || jsonb_build_object(
    'org', lower(p_header->>'organization_id'),
    'customer', lower(p_header->>'customer_id'),
    'user', lower(p_header->>'requester_user_id'),
    'notes', p_header->>'notes',
    'lines', (select jsonb_agg(jsonb_build_array(s.item, s.q) order by s.item)
                from (select lower(l->>'item_id') as item, trim_scale(sum((l->>'quantity_requested')::numeric)) as q
                        from jsonb_array_elements(p_lines) as e(l)
                       group by 1) s)
  )::text)
$$;

revoke all on function public._portal_order_request_hash(jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public._portal_order_request_hash(jsonb, jsonb) to service_role;

comment on function public._portal_order_request_hash(jsonb, jsonb) is
  'The hash of a portal order request: md5 of ''portal_order_create:v1|'' and the canonical jsonb text of the '
  'organization, customer, requester, notes (as sent) and the lines summed per item in item order (item_id, '
  'quantity_requested; prices and costs are not part of the cart). Its own scope tag, so a portal key never '
  'matches a staff hash (0391''s order_request_create:v1). IMMUTABLE, pure; EXECUTE to service_role only.';

-- ═══ 3. portal_order_submission_status ════════════════════════════════════
create function public.portal_order_submission_status(p_header jsonb, p_lines jsonb, p_key text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  c_uuid     constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_key_text text := nullif(btrim(coalesce(p_key, '')), '');
  v_org      uuid;
  v_customer uuid;
  v_user     uuid;
  v_prev     public.order_submissions%rowtype;
begin
  -- ── The header names a portal order: organization, customer, requester ──
  if p_header is null or jsonb_typeof(p_header) <> 'object'
     or coalesce(p_header->>'source', '') <> 'portal'
     or jsonb_typeof(p_header->'organization_id') is distinct from 'string'
     or jsonb_typeof(p_header->'customer_id') is distinct from 'string'
     or jsonb_typeof(p_header->'requester_user_id') is distinct from 'string' then
    raise exception 'order_request_invalid' using errcode = '22023', hint = 'order_request_invalid', detail = 'header';
  end if;
  if (p_header->>'organization_id') !~ c_uuid or (p_header->>'customer_id') !~ c_uuid
     or (p_header->>'requester_user_id') !~ c_uuid then
    raise exception 'order_request_invalid' using errcode = '22023', hint = 'order_request_invalid', detail = 'header';
  end if;
  if p_header->'notes' is not null and jsonb_typeof(p_header->'notes') not in ('string', 'null') then
    raise exception 'order_request_invalid' using errcode = '22023', hint = 'order_request_invalid', detail = 'header';
  end if;
  v_org := (p_header->>'organization_id')::uuid;
  v_customer := (p_header->>'customer_id')::uuid;
  v_user := (p_header->>'requester_user_id')::uuid;

  -- ── The key ─────────────────────────────────────────────────────────────
  if v_key_text is null then
    raise exception 'idempotency_key_required' using errcode = '22023', hint = 'idempotency_key_required';
  end if;
  if v_key_text !~ c_uuid then
    raise exception 'idempotency_key_invalid' using errcode = '22023', hint = 'idempotency_key_invalid';
  end if;

  -- ── The lines: 1 to 100, each {item_id: uuid string, quantity_requested:
  -- a whole number of 1 or more} (each cast behind its type test) ──────────
  if p_lines is null or jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) < 1 or jsonb_array_length(p_lines) > 100
     or exists (select 1 from jsonb_array_elements(p_lines) as e(l)
                 where case
                         when jsonb_typeof(l) <> 'object' then true
                         when jsonb_typeof(l->'item_id') is distinct from 'string' then true
                         when (l->>'item_id') !~ c_uuid then true
                         when jsonb_typeof(l->'quantity_requested') is distinct from 'number' then true
                         else (l->>'quantity_requested')::numeric < 1
                              or (l->>'quantity_requested')::numeric <> trunc((l->>'quantity_requested')::numeric)
                       end) then
    raise exception 'order_request_invalid' using errcode = '22023', hint = 'order_request_invalid', detail = 'lines';
  end if;

  -- ── Lookup: (organization, user, key), as 0391 ──────────────────────────
  select s.* into v_prev
    from public.order_submissions s
   where s.organization_id = v_org and s.user_id = v_user and s.key = v_key_text::uuid;
  if not found then
    return jsonb_build_object('outcome', 'none');
  end if;
  -- Only this customer's own portal order for this cart is answered. Any
  -- other row under the key (another cart, another customer of the
  -- organization, a staff submission, a withdrawn key) is a conflict that
  -- names nothing.
  if v_prev.surface <> 'portal' or v_prev.outcome <> 'placed'
     or v_prev.request_hash is distinct from public._portal_order_request_hash(p_header, p_lines)
     or not exists (select 1 from public.order_requests o
                     where o.id = v_prev.order_request_id
                       and o.organization_id = v_org
                       and o.customer_id = v_customer
                       and o.source = 'portal') then
    raise exception 'idempotency_conflict' using errcode = 'P0001', hint = 'idempotency_conflict';
  end if;
  return jsonb_build_object('outcome', 'placed', 'replay', true, 'order_id', v_prev.order_request_id);
end;
$$;

revoke all on function public.portal_order_submission_status(jsonb, jsonb, text) from public, anon, authenticated, service_role;
grant execute on function public.portal_order_submission_status(jsonb, jsonb, text) to service_role;

comment on function public.portal_order_submission_status(jsonb, jsonb, text) is
  'The portal''s submission key, read (no lock): {outcome: none} or {outcome: placed, replay: true, order_id}. '
  'The header (as the portal service builds it) must be source portal with uuid organization_id, customer_id and '
  'requester_user_id (22023 order_request_invalid, detail header); the key present and uuid-shaped (22023 '
  'idempotency_key_required, idempotency_key_invalid); 1 to 100 whole lines (detail lines). A row under the key '
  'that is not this customer''s placed portal order for this cart is P0001 idempotency_conflict with no detail. '
  'none means only that nothing has committed under the key yet. STABLE INVOKER, EXECUTE to service_role only.';

-- ═══ 4. _record_portal_order_submission ═══════════════════════════════════
create function public._record_portal_order_submission(p_org uuid, p_user uuid, p_key uuid, p_hash text, p_order uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(current_setting('stockpilot.portal_order_submit', true), '') is distinct from pg_current_xact_id()::text then
    raise exception 'portal_order_submission_not_open' using errcode = '42501', hint = 'portal_order_submission_not_open';
  end if;
  if p_org is null or p_user is null or p_key is null
     or not exists (select 1 from public.order_requests o
                     where o.id = p_order
                       and o.organization_id = p_org
                       and o.source = 'portal'
                       and o.customer_id is not null
                       and o.requester_user_id = p_user) then
    raise exception 'portal_order_submission_invalid' using errcode = '22023', hint = 'portal_order_submission_invalid';
  end if;
  insert into public.order_submissions
    (organization_id, user_id, key, request_hash, outcome, order_request_id, refusal, surface)
  values (p_org, p_user, p_key, p_hash, 'placed', p_order, null, 'portal');
end;
$$;

revoke all on function public._record_portal_order_submission(uuid, uuid, uuid, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public._record_portal_order_submission(uuid, uuid, uuid, text, uuid) to service_role;

comment on function public._record_portal_order_submission(uuid, uuid, uuid, text, uuid) is
  'Writes the one placed row of a portal submission (surface portal). SECURITY DEFINER because service_role holds '
  'no INSERT on order_submissions; it writes only while stockpilot.portal_order_submit holds this transaction''s id '
  '(42501 portal_order_submission_not_open otherwise), raised inline by place_portal_order_request alone and not '
  'reachable through PostgREST, and only for a portal order of that organization placed by that requester (22023 '
  'portal_order_submission_invalid). One row per order (order_submissions_order_request_uidx). EXECUTE to '
  'service_role only.';

-- ═══ 5. place_portal_order_request ════════════════════════════════════════
create function public.place_portal_order_request(p_header jsonb, p_lines jsonb, p_key text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_status jsonb;
  v_org    uuid;
  v_user   uuid;
  v_key    uuid;
  v_row    jsonb;
  v_flag   text;
begin
  -- Shape, key and identity: the status read's own checks (it raises).
  v_status := public.portal_order_submission_status(p_header, p_lines, p_key);
  v_org := (p_header->>'organization_id')::uuid;
  v_user := (p_header->>'requester_user_id')::uuid;
  v_key := btrim(p_key)::uuid;

  -- 0391's key lock, held to commit: a portal call and a staff call with one
  -- key wait for each other, and two portal calls with one key are decided
  -- once.
  perform pg_advisory_xact_lock(
    hashtextextended('order_submission:' || v_org::text || ':' || v_user::text || ':' || v_key::text, 0));

  -- A new statement after the lock: it sees what an earlier holder committed.
  v_status := public.portal_order_submission_status(p_header, p_lines, p_key);
  if v_status->>'outcome' = 'placed' then
    return v_status;
  end if;

  -- The order, unchanged: header and lines in one call, as the service role.
  v_row := public.insert_order_request_with_lines(p_header, p_lines);

  -- The one placed row (the flag raised inline, restored at once).
  v_flag := current_setting('stockpilot.portal_order_submit', true);
  perform set_config('stockpilot.portal_order_submit', pg_current_xact_id()::text, true);
  perform public._record_portal_order_submission(
    v_org, v_user, v_key, public._portal_order_request_hash(p_header, p_lines), (v_row->>'id')::uuid);
  perform set_config('stockpilot.portal_order_submit', coalesce(v_flag, ''), true);

  return jsonb_build_object('outcome', 'placed', 'replay', false, 'order_id', v_row->>'id');
end;
$$;

revoke all on function public.place_portal_order_request(jsonb, jsonb, text) from public, anon, authenticated, service_role;
grant execute on function public.place_portal_order_request(jsonb, jsonb, text) to service_role;

comment on function public.place_portal_order_request(jsonb, jsonb, text) is
  'The B2B portal''s Place order, placed once per key: portal_order_submission_status (shape, key, identity), '
  '0391''s key advisory lock on (organization, requester, key) (55P03 past lock_timeout 5s: nothing written, send '
  'again with the same key), the status again (a replay answers the first order and writes nothing; another cart, '
  'customer or path is P0001 idempotency_conflict with no detail), then insert_order_request_with_lines unchanged '
  'and one placed row through _record_portal_order_submission. Answers {outcome: placed, replay, order_id}. '
  'SECURITY INVOKER, EXECUTE to service_role only. Never 40001/40P01.';

reset lock_timeout;
