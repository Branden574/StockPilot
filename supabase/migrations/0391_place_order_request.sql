-- 0391_place_order_request.sql
--
-- Phone ordering PO-2: one create path for every order request, and no
-- duplicate order from a retry, a double tap or a lost answer. A table, its
-- index and two policies, six functions, their grants and their comments.
-- No existing row is written; no existing function, policy or grant changes.
--
-- ── WHY ────────────────────────────────────────────────────────────────────
-- The web's New order page called create_order_request directly. When its
-- answer was lost (a slow network, a closed tab, a dashboard error page), the
-- person pressed Submit again and placed a second order: production holds
-- order pairs 52 to 282 seconds apart. The phone (PO-4) will place orders
-- too, over a network that loses answers more often.
--
-- ── WHAT IT ADDS ───────────────────────────────────────────────────────────
--   1. order_submissions: one private record per (organization, placer, key).
--      Its outcome is decided in the same transaction as the order: placed
--      (with the order), refused (with the reason) or withdrawn. Rows never
--      change. A member reads only their own rows; an insert is accepted only
--      while the transaction-bound flag stockpilot.order_submit holds THIS
--      transaction's id (the 0359 carrier pattern), and the flag is raised
--      only inline, around the one insert, inside place_order_request and
--      withdraw_order_submission. No helper writes the table.
--   2. place_order_request(request, key): the one create path. Below.
--   3. withdraw_order_submission(org, key, surface): "Don't send it". Takes
--      the key's lock, so its answer is final: withdrawn (the key can never
--      place), or the outcome already recorded.
--   4. order_submission_status(org, key): a read, no lock. `none` means only
--      that nothing has committed under the key yet.
--   5. order_items_orderable(warehouse, items): the one implementation of
--      "orderable here" (the storefront catalog's own filter).
--   6. order_recent_requesters(org): on-behalf requesters of the last year,
--      for the phone's picker (PO-4); [] unless the caller holds
--      orders:approve (security slice D: on-behalf ordering follows that
--      permission).
--   7. _order_submission_summary(order): the order an answer names, read
--      under the caller's RLS (one definition for the three answers).
--
-- ── place_order_request ────────────────────────────────────────────────────
-- p_request (the service builds it, snake_case): organization_id,
-- placer_user_id, surface ('web' | 'app'), warehouse_id, fulfillment_type,
-- delivery_charter_id, on_behalf_name, on_behalf_email, notes, needed_by (an
-- ISO instant with a zone, or null), lines [{item_id, quantity}].
-- Steps, in this order:
--   1. Identity: signed in (42501 unauthenticated); placer_user_id is the
--      caller (42501 placer_mismatch: a pending send another account left on a
--      shared browser is never placed under this one); an accepted, enabled
--      member (42501 not_member). Raised: nothing recorded.
--   2. Key: present and uuid-shaped (22023 idempotency_key_required,
--      idempotency_key_invalid).
--   3. Shape (pure): 22023 hint order_invalid with the field in the detail
--      (warehouse, fulfillment_type, site, lines, quantity, total, notes,
--      on_behalf, needed_by, surface), or 22023 delivery_needs_site. 1 to 100
--      lines as sent, each {item_id: uuid string, quantity: JSON number}; each
--      quantity whole and at least 1 BEFORE lines of one item are summed; each
--      item's sum at most 10,000, then the total at most 10,000. Notes and the
--      on-behalf name and email trimmed of exactly what JavaScript's trim
--      removes; notes at most 2,000 characters (empty is none); the name 1 to
--      120 characters and the email at most 254 with zod 3's .email() pattern,
--      both or neither. A pickup's site is dropped. The parity fixture
--      (packages/core/src/orders/place-order-parity-cases.json) holds this
--      equal to core's schema. Raised: nothing recorded.
--   4. The request hash: md5 of a scope tag and the canonical jsonb text of
--      the request (caller, org, warehouse, method, site, name, lower-case
--      email, notes, needed-by in UTC, lines summed and in item order).
--   5. The key's lock: pg_advisory_xact_lock on (org, caller, key). Past
--      lock_timeout (5 s): 55P03, nothing written, retry with the same key.
--   6. Lookup, BEFORE anything that changes with time: the caller's row for
--      the key. placed with the same hash: the order (replay); refused with
--      the same hash: the stored refusal (replay); withdrawn: withdrawn; any
--      other hash: P0001 idempotency_conflict (detail {orderId, orderNumber}
--      when the key placed an order).
--   7. Floors, recorded under the key and RETURNED (not raised), so a late
--      original gets the same answer: module_disabled, permission
--      (orders:request), warehouse_not_available (the warehouse read under the
--      caller's RLS, in the org, not archived), on_behalf_not_permitted
--      (orders:approve, the order_requests_insert policy's rule since 0390).
--   8. Time and state, recorded and returned: needed_by_past,
--      needed_by_out_of_range (more than 5 years ahead), site_not_available
--      (detail not_serviced | inactive), item_not_orderable (detail
--      {itemId: reason}, order_items_orderable).
--   9. create_order_request(header, lines), unchanged. A self-submit carries
--      no requester name or email (the A2 follow-up F1 / O-A2-7: the order's
--      status emails go to the placer's own account); on behalf, the name and
--      email and no requester. Only the line guard's two sentences are caught
--      (by SQLSTATE and exact text) and recorded as item_not_orderable and
--      invalid; every other error rolls the whole call back: no order, no
--      record.
--  10. Record placed (flag up, one insert, flag restored) and answer the
--      order.
-- Answers: {outcome: 'placed', replay, order} | {outcome: 'refused', replay,
-- refusal: {reason, detail}} | {outcome: 'withdrawn'}.
--
-- LOCK ORDER: the key's advisory lock, then the per-organization numbering
-- lock inside the frozen BEFORE INSERT trigger, then row locks. The withdraw
-- takes only the key's lock. There is no cycle.
--
-- ── LOCK FOOTPRINT OF THIS FILE ────────────────────────────────────────────
-- The push runs this file as one transaction. The table's two foreign keys
-- add RI triggers to organizations and order_requests (SHARE ROW EXCLUSIVE on
-- both, to commit); creating the SQL-language functions reads inventory_items
-- and order_request_lines (ACCESS SHARE). On this platform CREATE POLICY and COMMENT ON POLICY run
-- by postgres also take ACCESS EXCLUSIVE, to commit, on every table
-- supautils.policy_grants lists for the role (supautils 3.4.0 in image
-- 17.6.1.166; 0390's prelude has the evidence): auth, storage and realtime
-- tables that a sign-in or an account deletion writes, the latter together
-- with order_requests. So, as in 0390, one prelude takes every table lock the
-- file needs at once, all NOWAIT, in a bounded retry (a busy table fails the
-- attempt, its subtransaction releases what it took, and the next attempt
-- starts after 50 to 150 ms holding no table lock; the 40th busy attempt
-- raises 55P03 and nothing is applied). No later statement takes a new lock
-- on an existing table, so the file never waits while holding one. The locks
-- are held from the successful attempt to commit, a few milliseconds.
-- lock_timeout 900ms (below deadlock_timeout) bounds any other wait.
--
-- ERRORS: 42501, 22023, P0001 and 55P03 (and 57014 from the role's statement
-- timeout). No function here raises 40001 or 40P01 (PostgREST retries those
-- forever; 0367).

set lock_timeout = '900ms';

-- ═══ 0. The lock prelude (see LOCK FOOTPRINT) ═════════════════════════════
-- Inside DO because the CLI batch is not a transaction block (a top-level
-- LOCK TABLE refuses there, as 0373 found); the locks last until the batch
-- commits. Only the parent of a partitioned table, and only tables that
-- exist, as supautils does.
do $lock$
declare
  v_grants text := nullif(current_setting('supautils.policy_grants', true), '');
  v_name   text;
  v_rel    regclass;
  v_try    integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.organizations, public.order_requests in share row exclusive mode nowait;
      -- Read when the SQL-language functions below are created (their bodies
      -- are checked then): ACCESS SHARE, which only a schema change conflicts
      -- with, taken here so no later statement can wait.
      lock table only public.inventory_items, public.order_request_lines in access share mode nowait;
      if v_grants is not null then
        for v_name in
          select jsonb_array_elements_text(coalesce(v_grants::jsonb -> current_user::text, '[]'::jsonb))
        loop
          v_rel := to_regclass(v_name);
          if v_rel is not null then
            execute format('lock table only %s in access exclusive mode nowait', v_rel);
          end if;
        end loop;
      end if;
      exit;
    exception when lock_not_available then
      if v_try >= 40 then
        raise;
      end if;
    end;
    perform pg_sleep(0.05 + random() * 0.1);
  end loop;
end $lock$;

-- ═══ 1. order_submissions ═════════════════════════════════════════════════
-- user_id has NO foreign key: account deletion hard-deletes the auth user
-- (apps/web/src/app/api/v1/account/delete/route.ts), and a RESTRICT or NO
-- ACTION key would make every deletion fail for anyone who ever placed an
-- order; it cannot be SET NULL (it is part of the key). The row keeps only
-- ids and a hash, like audit_logs.user_id. The organization and the order
-- cascade.
create table public.order_submissions (
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  user_id          uuid not null,
  key              uuid not null,
  request_hash     text check (request_hash ~ '^[0-9a-f]{32}$'),
  outcome          text not null check (outcome in ('placed', 'refused', 'withdrawn')),
  order_request_id uuid references public.order_requests(id) on delete cascade,
  refusal          jsonb check (refusal is null or (jsonb_typeof(refusal) = 'object' and jsonb_typeof(refusal->'reason') = 'string')),
  surface          text not null check (surface in ('web', 'app')),
  created_at       timestamptz not null default clock_timestamp(),
  primary key (organization_id, user_id, key),
  constraint order_submissions_placed_chk check ((outcome = 'placed') = (order_request_id is not null)),
  constraint order_submissions_refused_chk check ((outcome = 'refused') = (refusal is not null)),
  constraint order_submissions_hash_chk check (request_hash is not null or outcome = 'withdrawn')
);
create unique index order_submissions_order_request_uidx
  on public.order_submissions (order_request_id) where order_request_id is not null;

alter table public.order_submissions enable row level security;
-- Supabase's default privileges grant every new public table to anon,
-- authenticated and service_role: take them back. authenticated reads its
-- own rows and inserts only under the flag; service_role (the admin client)
-- may read for support, never write (it bypasses RLS, so it could record any
-- outcome without the flag).
revoke all on table public.order_submissions from public, anon, authenticated, service_role;
grant select, insert on table public.order_submissions to authenticated;
grant select on table public.order_submissions to service_role;

create policy order_submissions_select on public.order_submissions
  for select to authenticated
  using (user_id = (select auth.uid()) and (select public.is_org_member(organization_id)));

create policy order_submissions_insert on public.order_submissions
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (select public.is_org_member(organization_id))
    and coalesce(current_setting('stockpilot.order_submit', true), '') = pg_current_xact_id()::text
  );

comment on table public.order_submissions is
  'One private record per order submission key (0391): (organization, placer, key) -> placed (with the '
  'order), refused (with the reason) or withdrawn, decided under the key''s advisory lock in the '
  'transaction that creates the order. Rows never change (no UPDATE or DELETE policy). Each member reads '
  'only their own rows. INSERT only while stockpilot.order_submit holds this transaction''s id, raised '
  'inline by place_order_request and withdraw_order_submission alone. No foreign key on user_id, so '
  'account deletion is never blocked; the organization and the order cascade.';
comment on column public.order_submissions.request_hash is
  'md5 of ''order_request_create:v1|'' and the canonical jsonb text of the request (0391). Null only on a '
  'withdrawn row created by withdraw_order_submission.';
comment on column public.order_submissions.refusal is
  '{reason, detail} of a recorded refusal (0391): module_disabled, permission, warehouse_not_available, '
  'on_behalf_not_permitted, needed_by_past, needed_by_out_of_range, site_not_available (detail '
  'not_serviced | inactive), item_not_orderable (detail {itemId: reason}), invalid.';
comment on column public.order_submissions.surface is
  'Where the submission came from (0391): web (the New order page) or app (POST /api/v1/orders).';
comment on policy order_submissions_insert on public.order_submissions is
  'Flag-gated (0391, the 0359 carrier pattern): only place_order_request and withdraw_order_submission '
  'raise stockpilot.order_submit, inline around their one insert. A value left in a pooled session never '
  'matches a later transaction''s id; set_config is not reachable through PostgREST.';

-- ═══ 2. order_items_orderable ═════════════════════════════════════════════
create or replace function public.order_items_orderable(p_warehouse uuid, p_item_ids uuid[])
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_object_agg(x.id::text, x.reason), '{}'::jsonb)
    from (
      select ids.id,
             case
               when ii.id is null then 'not_visible'
               when ii.deleted_at is not null then 'deleted'
               when ii.warehouse_id is distinct from p_warehouse then 'other_warehouse'
               when ii.status is distinct from 'active' then 'archived'
               when coalesce(ii.is_rental, false) then 'rental'
               when coalesce(ii.awaiting_first_receipt, false) then 'awaiting_first_receipt'
               when coalesce(ii.is_bundle, false) then 'kit_stock'
             end as reason
        from (select distinct u.id from unnest(coalesce(p_item_ids, '{}'::uuid[])) as u(id) where u.id is not null) ids
        left join public.inventory_items ii on ii.id = ids.id
    ) x
   where x.reason is not null
$$;

revoke all on function public.order_items_orderable(uuid, uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.order_items_orderable(uuid, uuid[]) to authenticated;

comment on function public.order_items_orderable(uuid, uuid[]) is
  'The one "orderable here" rule (0391): {itemId: reason} for the items that fail, {} when all pass. '
  'SECURITY INVOKER: inventory_items is read under the caller''s RLS, so an item the caller cannot read '
  '(category or charter scope included) is not_visible, the same answer as a missing id. Reasons, first '
  'match wins: not_visible, deleted, other_warehouse, archived (any status but active), rental, '
  'awaiting_first_receipt, kit_stock: the storefront catalog''s own filter. STABLE, EXECUTE to '
  'authenticated only, never 40001/40P01.';

-- ═══ 3. _order_submission_summary ═════════════════════════════════════════
create or replace function public._order_submission_summary(p_order uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
           'id', o.id,
           'order_number', o.order_number,
           'status', o.status,
           'warehouse_id', o.warehouse_id,
           'fulfillment_type', o.fulfillment_type,
           'delivery_charter_id', o.delivery_charter_id,
           'needed_by', o.needed_by,
           'created_at', o.created_at,
           'requester_user_id', o.requester_user_id,
           'requester_name', o.requester_name,
           'requester_email', o.requester_email,
           'line_count', (select count(*) from public.order_request_lines l where l.order_request_id = o.id),
           'unit_count', (select coalesce(trim_scale(sum(l.quantity_requested)), 0)
                            from public.order_request_lines l where l.order_request_id = o.id))
    from public.order_requests o
   where o.id = p_order
$$;

revoke all on function public._order_submission_summary(uuid) from public, anon, authenticated, service_role;
grant execute on function public._order_submission_summary(uuid) to authenticated;

comment on function public._order_submission_summary(uuid) is
  'The order a submission answer names (0391), read under the caller''s RLS (order_requests_select: '
  'members): id, number, status, warehouse, method, site, needed-by, created, requester, line count and '
  'unit total. No secret column (tokens, signature) is read. STABLE INVOKER, EXECUTE to authenticated only.';

-- ═══ 4. place_order_request ═══════════════════════════════════════════════
create or replace function public.place_order_request(p_request jsonb, p_key text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  -- Exactly the characters JavaScript's String.prototype.trim removes, so a
  -- trimmed value and a cap mean the same thing in core and here.
  c_ws    constant text := E'\u0009\u000A\u000B\u000C\u000D                  　﻿';
  c_uuid  constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  -- zod 3's .email() pattern (core place-order.ts EMAIL_RE), read with ~*.
  c_email constant text := '^(?!\.)(?!.*\.\.)([A-Z0-9_''+\-.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9-]*\.)+[A-Z]{2,}$';
  -- An instant with an explicit zone; a zone-less text would be read in the
  -- session's zone, and words like 'tomorrow' are valid timestamptz input.
  c_iso   constant text := '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}(:?\d{2})?)$';
  v_uid       uuid := auth.uid();
  v_org       uuid;
  v_key       uuid;
  v_key_text  text := nullif(btrim(coalesce(p_key, '')), '');
  v_surface   text;
  v_wh        uuid;
  v_method    text;
  v_site      uuid;
  v_lines_in  jsonb;
  v_lines     jsonb;
  v_item_ids  uuid[];
  v_total     numeric;
  v_max_sum   numeric;
  v_notes     text;
  v_name      text;
  v_email     text;
  v_on_behalf boolean;
  v_needed    timestamptz;
  v_hash      text;
  v_prev      public.order_submissions%rowtype;
  v_order     jsonb;
  v_refusal   jsonb;
  v_bad       jsonb;
  v_site_st   text;
  v_row       public.order_requests%rowtype;
  v_msg       text;
  v_flag      text;
begin
  -- ── 1. Identity ──────────────────────────────────────────────────────────
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
  end if;
  -- Compared as text, so a malformed placer is a mismatch, never a cast error.
  if lower(coalesce(p_request->>'placer_user_id', '')) is distinct from v_uid::text then
    raise exception 'placer_mismatch' using errcode = '42501', hint = 'placer_mismatch';
  end if;
  if coalesce(p_request->>'organization_id', '') !~ c_uuid then
    raise exception 'not_member' using errcode = '42501', hint = 'not_member';
  end if;
  v_org := (p_request->>'organization_id')::uuid;
  if not public.is_org_member(v_org) then
    raise exception 'not_member' using errcode = '42501', hint = 'not_member';
  end if;

  -- ── 2. Key ───────────────────────────────────────────────────────────────
  if v_key_text is null then
    raise exception 'idempotency_key_required' using errcode = '22023', hint = 'idempotency_key_required';
  end if;
  if v_key_text !~ c_uuid then
    raise exception 'idempotency_key_invalid' using errcode = '22023', hint = 'idempotency_key_invalid';
  end if;
  v_key := v_key_text::uuid;

  -- ── 3. Shape (pure; each cast behind its type test, CASE not OR) ─────────
  if jsonb_typeof(p_request->'warehouse_id') is distinct from 'string'
     or (p_request->>'warehouse_id') !~ c_uuid then
    raise exception 'order_invalid' using errcode = '22023', hint = 'order_invalid', detail = 'warehouse';
  end if;
  v_wh := (p_request->>'warehouse_id')::uuid;

  v_method := case when jsonb_typeof(p_request->'fulfillment_type') = 'string'
                   then p_request->>'fulfillment_type' end;
  if v_method is null or v_method not in ('pickup', 'delivery') then
    raise exception 'order_invalid' using errcode = '22023', hint = 'order_invalid', detail = 'fulfillment_type';
  end if;

  if v_method = 'delivery' then
    if p_request->'delivery_charter_id' is null or jsonb_typeof(p_request->'delivery_charter_id') = 'null' then
      raise exception 'delivery_needs_site' using errcode = '22023', hint = 'delivery_needs_site';
    end if;
    if jsonb_typeof(p_request->'delivery_charter_id') <> 'string'
       or (p_request->>'delivery_charter_id') !~ c_uuid then
      raise exception 'order_invalid' using errcode = '22023', hint = 'order_invalid', detail = 'site';
    end if;
    v_site := (p_request->>'delivery_charter_id')::uuid;
  else
    -- A pickup has no site: whatever was sent is dropped.
    v_site := null;
  end if;

  v_lines_in := p_request->'lines';
  if v_lines_in is null or jsonb_typeof(v_lines_in) <> 'array'
     or jsonb_array_length(v_lines_in) < 1 or jsonb_array_length(v_lines_in) > 100 then
    raise exception 'order_invalid' using errcode = '22023', hint = 'order_invalid', detail = 'lines';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_lines_in) as e(l)
     where case
             when jsonb_typeof(l) <> 'object' then true
             when jsonb_typeof(l->'item_id') is distinct from 'string' then true
             else (l->>'item_id') !~ c_uuid
           end
  ) then
    raise exception 'order_invalid' using errcode = '22023', hint = 'order_invalid', detail = 'lines';
  end if;
  -- Each line whole and at least 1 BEFORE lines of one item are summed.
  if exists (
    select 1 from jsonb_array_elements(v_lines_in) as e(l)
     where case
             when jsonb_typeof(l->'quantity') is distinct from 'number' then true
             else (l->>'quantity')::numeric < 1
                  or (l->>'quantity')::numeric <> trunc((l->>'quantity')::numeric)
           end
  ) then
    raise exception 'order_invalid' using errcode = '22023', hint = 'order_invalid', detail = 'quantity';
  end if;
  -- Per item first, then the total (numeric throughout: no integer overflow).
  select max(s.q), sum(s.q) into v_max_sum, v_total
    from (select (l->>'item_id')::uuid as item, sum((l->>'quantity')::numeric) as q
            from jsonb_array_elements(v_lines_in) as e(l) group by 1) s;
  if v_max_sum > 10000 then
    raise exception 'order_invalid' using errcode = '22023', hint = 'order_invalid', detail = 'quantity';
  end if;
  if v_total > 10000 then
    raise exception 'order_invalid' using errcode = '22023', hint = 'order_invalid', detail = 'total';
  end if;
  -- One line per item, summed, in item order.
  select jsonb_agg(jsonb_build_object('item_id', s.item, 'quantity', s.q) order by s.item),
         array_agg(s.item order by s.item)
    into v_lines, v_item_ids
    from (select (l->>'item_id')::uuid as item, sum((l->>'quantity')::numeric)::integer as q
            from jsonb_array_elements(v_lines_in) as e(l) group by 1) s;

  if p_request->'notes' is not null and jsonb_typeof(p_request->'notes') not in ('string', 'null') then
    raise exception 'order_invalid' using errcode = '22023', hint = 'order_invalid', detail = 'notes';
  end if;
  v_notes := nullif(btrim(coalesce(p_request->>'notes', ''), c_ws), '');
  if length(v_notes) > 2000 then
    raise exception 'order_invalid' using errcode = '22023', hint = 'order_invalid', detail = 'notes';
  end if;

  -- On behalf: a name and an email, both or neither.
  if coalesce(jsonb_typeof(p_request->'on_behalf_name'), 'null') = 'null'
     and coalesce(jsonb_typeof(p_request->'on_behalf_email'), 'null') = 'null' then
    v_on_behalf := false;
  else
    if jsonb_typeof(p_request->'on_behalf_name') is distinct from 'string'
       or jsonb_typeof(p_request->'on_behalf_email') is distinct from 'string' then
      raise exception 'order_invalid' using errcode = '22023', hint = 'order_invalid', detail = 'on_behalf';
    end if;
    v_name := btrim(p_request->>'on_behalf_name', c_ws);
    v_email := btrim(p_request->>'on_behalf_email', c_ws);
    if length(v_name) < 1 or length(v_name) > 120
       or length(v_email) > 254 or v_email !~* c_email then
      raise exception 'order_invalid' using errcode = '22023', hint = 'order_invalid', detail = 'on_behalf';
    end if;
    v_on_behalf := true;
  end if;

  if coalesce(jsonb_typeof(p_request->'needed_by'), 'null') = 'null' then
    v_needed := null;
  elsif jsonb_typeof(p_request->'needed_by') = 'string'
        and (p_request->>'needed_by') ~ c_iso
        and pg_input_is_valid(p_request->>'needed_by', 'timestamptz') then
    v_needed := (p_request->>'needed_by')::timestamptz;
  else
    raise exception 'order_invalid' using errcode = '22023', hint = 'order_invalid', detail = 'needed_by';
  end if;

  v_surface := case when jsonb_typeof(p_request->'surface') = 'string' then p_request->>'surface' end;
  if v_surface is null or v_surface not in ('web', 'app') then
    raise exception 'order_invalid' using errcode = '22023', hint = 'order_invalid', detail = 'surface';
  end if;

  -- ── 4. The request hash (jsonb's text form is canonical) ─────────────────
  v_hash := md5('order_request_create:v1|' || jsonb_build_object(
    'uid', v_uid,
    'org', v_org,
    'warehouse', v_wh,
    'method', v_method,
    'site', v_site,
    'name', v_name,
    'email', lower(v_email),
    'notes', v_notes,
    'needed_by', to_char(v_needed at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'lines', (select jsonb_agg(jsonb_build_array(l->>'item_id', (l->>'quantity')::integer) order by l->>'item_id')
                from jsonb_array_elements(v_lines) as e(l))
  )::text);

  -- ── 5. The key's lock, held to commit ────────────────────────────────────
  perform pg_advisory_xact_lock(
    hashtextextended('order_submission:' || v_org::text || ':' || v_uid::text || ':' || v_key::text, 0));

  -- ── 6. Lookup (a new statement: it sees what an earlier holder committed) ─
  select s.* into v_prev
    from public.order_submissions s
   where s.organization_id = v_org and s.user_id = v_uid and s.key = v_key;
  if found then
    if v_prev.outcome = 'withdrawn' then
      return jsonb_build_object('outcome', 'withdrawn');
    end if;
    if v_prev.request_hash is distinct from v_hash then
      if v_prev.outcome = 'placed' then
        v_order := public._order_submission_summary(v_prev.order_request_id);
        raise exception 'idempotency_conflict' using errcode = 'P0001', hint = 'idempotency_conflict',
          detail = jsonb_build_object('orderId', v_prev.order_request_id,
                                      'orderNumber', v_order->'order_number')::text;
      end if;
      raise exception 'idempotency_conflict' using errcode = 'P0001', hint = 'idempotency_conflict';
    end if;
    if v_prev.outcome = 'refused' then
      return jsonb_build_object('outcome', 'refused', 'replay', true, 'refusal', v_prev.refusal);
    end if;
    v_order := public._order_submission_summary(v_prev.order_request_id);
    if v_order is null then
      raise exception 'place_order_request_internal: the placed order could not be read'
        using errcode = 'P0001', hint = 'place_order_request_internal';
    end if;
    return jsonb_build_object('outcome', 'placed', 'replay', true, 'order', v_order);
  end if;

  -- ── 7 and 8. Floors, then time and state (recorded under the key) ────────
  <<checks>>
  begin
    if not public.module_enabled(v_org, 'orders') then
      v_refusal := jsonb_build_object('reason', 'module_disabled', 'detail', null);
      exit checks;
    end if;
    if not public.has_permission(v_org, 'orders:request') then
      v_refusal := jsonb_build_object('reason', 'permission', 'detail', null);
      exit checks;
    end if;
    -- Under the caller's RLS (warehouses_select: a manager, or read access to
    -- this warehouse).
    perform 1 from public.warehouses w
     where w.id = v_wh and w.organization_id = v_org and w.status <> 'archived';
    if not found then
      v_refusal := jsonb_build_object('reason', 'warehouse_not_available', 'detail', null);
      exit checks;
    end if;
    if v_on_behalf and not public.has_permission(v_org, 'orders:approve') then
      v_refusal := jsonb_build_object('reason', 'on_behalf_not_permitted', 'detail', null);
      exit checks;
    end if;

    if v_needed is not null and v_needed <= now() then
      v_refusal := jsonb_build_object('reason', 'needed_by_past', 'detail', null);
      exit checks;
    end if;
    if v_needed is not null and v_needed > now() + interval '5 years' then
      v_refusal := jsonb_build_object('reason', 'needed_by_out_of_range', 'detail', null);
      exit checks;
    end if;
    if v_method = 'delivery' then
      select c.status into v_site_st
        from public.warehouse_charters wc
        join public.charters c on c.id = wc.charter_id
       where wc.warehouse_id = v_wh and wc.charter_id = v_site and wc.organization_id = v_org;
      if not found then
        v_refusal := jsonb_build_object('reason', 'site_not_available', 'detail', 'not_serviced');
        exit checks;
      end if;
      if v_site_st is distinct from 'active' then
        v_refusal := jsonb_build_object('reason', 'site_not_available', 'detail', 'inactive');
        exit checks;
      end if;
    end if;
    v_bad := public.order_items_orderable(v_wh, v_item_ids);
    if v_bad <> '{}'::jsonb then
      v_refusal := jsonb_build_object('reason', 'item_not_orderable', 'detail', v_bad);
      exit checks;
    end if;

    -- ── 9. Create, through the frozen function ─────────────────────────────
    begin
      v_row := public.create_order_request(
        jsonb_build_object(
          'organization_id', v_org,
          'warehouse_id', v_wh,
          'requester_user_id', case when v_on_behalf then null else v_uid end,
          'requester_name', case when v_on_behalf then v_name end,
          'requester_email', case when v_on_behalf then v_email end,
          'notes', v_notes,
          'needed_by', v_needed,
          'fulfillment_type', v_method,
          'requester_phone', null,
          'delivery_charter_id', v_site,
          'pickup_location_notes', null),
        v_lines);
    exception
      when sqlstate '42501' then
        get stacked diagnostics v_msg = message_text;
        if v_msg = 'That item cannot be ordered: it is deleted, a rental item, or not received yet.' then
          -- A new statement: names the item that changed since step 8.
          v_refusal := jsonb_build_object('reason', 'item_not_orderable',
                                          'detail', public.order_items_orderable(v_wh, v_item_ids));
        else
          raise;
        end if;
      when sqlstate '23514' then
        get stacked diagnostics v_msg = message_text;
        if v_msg = 'A line needs a real quantity.' then
          v_refusal := jsonb_build_object('reason', 'invalid', 'detail', null);
        else
          raise;
        end if;
    end;
  end checks;

  -- ── 10. Record the outcome (the flag raised inline, restored at once) ────
  v_flag := current_setting('stockpilot.order_submit', true);
  perform set_config('stockpilot.order_submit', pg_current_xact_id()::text, true);
  if v_refusal is not null then
    insert into public.order_submissions
      (organization_id, user_id, key, request_hash, outcome, order_request_id, refusal, surface)
    values (v_org, v_uid, v_key, v_hash, 'refused', null, v_refusal, v_surface);
  else
    insert into public.order_submissions
      (organization_id, user_id, key, request_hash, outcome, order_request_id, refusal, surface)
    values (v_org, v_uid, v_key, v_hash, 'placed', v_row.id, null, v_surface);
  end if;
  perform set_config('stockpilot.order_submit', coalesce(v_flag, ''), true);

  if v_refusal is not null then
    return jsonb_build_object('outcome', 'refused', 'replay', false, 'refusal', v_refusal);
  end if;
  return jsonb_build_object('outcome', 'placed', 'replay', false,
                            'order', public._order_submission_summary(v_row.id));
end;
$$;

revoke all on function public.place_order_request(jsonb, text) from public, anon, authenticated, service_role;
grant execute on function public.place_order_request(jsonb, text) to authenticated;

comment on function public.place_order_request(jsonb, text) is
  'The one create path for an internal order request (0391), from the web and the phone. SECURITY '
  'INVOKER: create_order_request and every policy and trigger apply as the caller. Steps: 1 identity '
  '(42501 unauthenticated, placer_mismatch, not_member; raised, nothing recorded); 2 the key (22023 '
  'idempotency_key_required, idempotency_key_invalid); 3 shape (22023 order_invalid with the field as '
  'detail, delivery_needs_site; raised, nothing recorded; the parity fixture holds it equal to core); 4 '
  'the request hash; 5 the key''s advisory lock (55P03 past lock_timeout 5s, retry with the same key); 6 '
  'lookup BEFORE anything that changes with time (placed or refused replay; withdrawn; P0001 '
  'idempotency_conflict for another body); 7 floors and 8 time and state, RECORDED under the key and '
  'returned: module_disabled, permission, warehouse_not_available, on_behalf_not_permitted (orders:approve), '
  'needed_by_past, needed_by_out_of_range, site_not_available, item_not_orderable; 9 create_order_request '
  'unchanged (a self-submit carries no requester name or email), catching only the line guard''s two '
  'sentences; 10 record placed. The flag stockpilot.order_submit is raised inline around the one insert '
  'and restored at once; no helper writes order_submissions. Never 40001/40P01. EXECUTE to authenticated only.';

-- ═══ 5. withdraw_order_submission ═════════════════════════════════════════
create or replace function public.withdraw_order_submission(p_org uuid, p_key text, p_surface text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  c_uuid     constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_uid      uuid := auth.uid();
  v_key_text text := nullif(btrim(coalesce(p_key, '')), '');
  v_key      uuid;
  v_prev     public.order_submissions%rowtype;
  v_order    jsonb;
  v_flag     text;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
  end if;
  if p_org is null or not public.is_org_member(p_org) then
    raise exception 'not_member' using errcode = '42501', hint = 'not_member';
  end if;
  if v_key_text is null then
    raise exception 'idempotency_key_required' using errcode = '22023', hint = 'idempotency_key_required';
  end if;
  if v_key_text !~ c_uuid then
    raise exception 'idempotency_key_invalid' using errcode = '22023', hint = 'idempotency_key_invalid';
  end if;
  v_key := v_key_text::uuid;
  if p_surface is null or p_surface not in ('web', 'app') then
    raise exception 'order_invalid' using errcode = '22023', hint = 'order_invalid', detail = 'surface';
  end if;

  -- The same lock as a placement: whichever commits first decides.
  perform pg_advisory_xact_lock(
    hashtextextended('order_submission:' || p_org::text || ':' || v_uid::text || ':' || v_key::text, 0));

  select s.* into v_prev
    from public.order_submissions s
   where s.organization_id = p_org and s.user_id = v_uid and s.key = v_key;
  if found then
    if v_prev.outcome = 'placed' then
      v_order := public._order_submission_summary(v_prev.order_request_id);
      if v_order is null then
        raise exception 'withdraw_order_submission_internal: the placed order could not be read'
          using errcode = 'P0001', hint = 'withdraw_order_submission_internal';
      end if;
      return jsonb_build_object('outcome', 'placed', 'order', v_order);
    end if;
    if v_prev.outcome = 'refused' then
      return jsonb_build_object('outcome', 'refused', 'refusal', v_prev.refusal);
    end if;
    return jsonb_build_object('outcome', 'withdrawn');
  end if;

  v_flag := current_setting('stockpilot.order_submit', true);
  perform set_config('stockpilot.order_submit', pg_current_xact_id()::text, true);
  insert into public.order_submissions
    (organization_id, user_id, key, request_hash, outcome, order_request_id, refusal, surface)
  values (p_org, v_uid, v_key, null, 'withdrawn', null, null, p_surface);
  perform set_config('stockpilot.order_submit', coalesce(v_flag, ''), true);
  return jsonb_build_object('outcome', 'withdrawn');
end;
$$;

revoke all on function public.withdraw_order_submission(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.withdraw_order_submission(uuid, text, text) to authenticated;

comment on function public.withdraw_order_submission(uuid, text, text) is
  '"Don''t send it" (0391): settles the caller''s key for good. Membership only (no module, permission or '
  'MFA gate: settling your own key never depends on them). 42501 unauthenticated, not_member; 22023 '
  'idempotency_key_required, idempotency_key_invalid, order_invalid (surface). Takes the key''s advisory lock '
  '(the same as place_order_request; 55P03 past 5s), then: no row records withdrawn (the key can never '
  'place) and answers withdrawn; a row answers its outcome (placed with the order, refused with the '
  'refusal, withdrawn) and writes nothing. The flag stockpilot.order_submit is raised inline around the '
  'one insert and restored at once. Never 40001/40P01. EXECUTE to authenticated only.';

-- ═══ 6. order_submission_status ═══════════════════════════════════════════
create or replace function public.order_submission_status(p_org uuid, p_key text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  c_uuid     constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_uid      uuid := auth.uid();
  v_key_text text := nullif(btrim(coalesce(p_key, '')), '');
  v_prev     public.order_submissions%rowtype;
  v_order    jsonb;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
  end if;
  if p_org is null or not public.is_org_member(p_org) then
    raise exception 'not_member' using errcode = '42501', hint = 'not_member';
  end if;
  if v_key_text is null then
    raise exception 'idempotency_key_required' using errcode = '22023', hint = 'idempotency_key_required';
  end if;
  if v_key_text !~ c_uuid then
    raise exception 'idempotency_key_invalid' using errcode = '22023', hint = 'idempotency_key_invalid';
  end if;

  select s.* into v_prev
    from public.order_submissions s
   where s.organization_id = p_org and s.user_id = v_uid and s.key = v_key_text::uuid;
  if not found then
    return jsonb_build_object('outcome', 'none');
  end if;
  if v_prev.outcome = 'placed' then
    v_order := public._order_submission_summary(v_prev.order_request_id);
    if v_order is null then
      raise exception 'order_submission_status_internal: the placed order could not be read'
        using errcode = 'P0001', hint = 'order_submission_status_internal';
    end if;
    return jsonb_build_object('outcome', 'placed', 'order', v_order);
  end if;
  if v_prev.outcome = 'refused' then
    return jsonb_build_object('outcome', 'refused', 'refusal', v_prev.refusal);
  end if;
  return jsonb_build_object('outcome', 'withdrawn');
end;
$$;

revoke all on function public.order_submission_status(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.order_submission_status(uuid, text) to authenticated;

comment on function public.order_submission_status(uuid, text) is
  'The caller''s own key (0391): none, placed (with the order), refused (with the refusal) or withdrawn. '
  'Membership only. STABLE and takes NO lock, so none means only that nothing has committed under the key '
  'yet; it never means "not placed" (only withdraw_order_submission settles an unknown send). 42501 '
  'unauthenticated, not_member; 22023 idempotency_key_required, idempotency_key_invalid. Never '
  '40001/40P01. EXECUTE to authenticated only.';

-- ═══ 7. order_recent_requesters ═══════════════════════════════════════════
create or replace function public.order_recent_requesters(p_org uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with allowed as (
    select public.is_org_member(p_org) and public.has_permission(p_org, 'orders:approve') as ok
  ), recent as (
    select lower(btrim(o.requester_email)) as k, o.requester_name, btrim(o.requester_email) as email,
           o.created_at, o.fulfillment_type, o.delivery_charter_id
      from public.order_requests o, allowed a
     where a.ok
       and o.organization_id = p_org
       and o.source = 'internal'
       and o.requester_user_id is null
       and o.requester_email is not null
       and btrim(o.requester_email) <> ''
       and o.created_at > now() - interval '365 days'
  ), latest as (
    select distinct on (r.k) r.k, r.requester_name, r.email, r.created_at, r.fulfillment_type
      from recent r
     order by r.k, r.created_at desc
  ), top as (
    select l.* from latest l order by l.created_at desc, l.k limit 50
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'name', t.requester_name,
           'email', t.email,
           'lastOrderedAt', t.created_at,
           'orders', (select count(*) from recent r where r.k = t.k),
           'lastFulfillment', t.fulfillment_type,
           'lastSiteId', (select r.delivery_charter_id from recent r
                           where r.k = t.k and r.fulfillment_type = 'delivery' and r.delivery_charter_id is not null
                           order by r.created_at desc limit 1))
         order by t.created_at desc, t.k), '[]'::jsonb)
    from top t
$$;

revoke all on function public.order_recent_requesters(uuid) from public, anon, authenticated, service_role;
grant execute on function public.order_recent_requesters(uuid) to authenticated;

comment on function public.order_recent_requesters(uuid) is
  'The people orders were placed for in the last 365 days (0391), for the phone''s on-behalf picker: one '
  'row per requester email (ignoring case and surrounding spaces), newest first, at most 50, each with the '
  'latest name, last order time, order count, last method and last delivery site. [] unless the caller is '
  'a member holding orders:approve (on-behalf ordering follows it since 0390). Read under the caller''s RLS. '
  'STABLE INVOKER, EXECUTE to authenticated only, never 40001/40P01.';

reset lock_timeout;
