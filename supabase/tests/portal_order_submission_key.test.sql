-- supabase/tests/portal_order_submission_key.test.sql
-- pgTAP proof that a B2B portal Place order is placed once, however many
-- times it is sent: the portal's submission key on 0391's order_submissions.
--
-- Personas: cuA, a customer user of customer A in organization X (also
-- invited to customer A2 of X); cuC, customer C's user in X; cuB, customer
-- B's user in organization Y. The portal writes as service_role (customers
-- have no table grants), so every call below is a real service_role call.
--
-- G.  Shape and grants: the four functions' posture (INVOKER except the one
--     recorder; EXECUTE to service_role only), the widened surface CHECK,
--     order_submissions' own grants unchanged, the flag census (only
--     place_portal_order_request raises stockpilot.portal_order_submit;
--     0391's flag is still raised by its two writers only), no dynamic SQL,
--     the order written only through insert_order_request_with_lines, under
--     0391's lock.
-- A.  authenticated and anon call none of them.
-- P.  Place: one order and one placed row (surface portal); the same key and
--     cart replays the first order with nothing new (no order, line, row or
--     notification), in any line order or split; the status read answers
--     none, then the order.
-- C.  The same key with another cart (a quantity, the notes) is
--     idempotency_conflict with no detail, and writes nothing.
-- X.  Scope: the same key from another customer of X, from customer B in
--     organization Y, places that customer's own order; the same user under
--     another customer of X is a conflict naming nothing; another user never
--     finds cuA's order; a key the staff path holds is a conflict.
-- RF. Replay first: an item hidden after the first call still replays; a new
--     key is refused by the hide.
-- K.  The key and the header: required, uuid-shaped, a portal header with its
--     organization, customer and requester; nothing written.
-- F.  The recorder: refused without the flag, with 'on', with another
--     transaction's id, for an order that is not this requester's portal
--     order in this organization, and for an order that already has a row.
--
-- Fixtures as the test superuser. begin/rollback: nothing leaks. Namespace
-- a7e10000.

begin;

select plan(30);

\set orgX  '\'a7e10000-0000-4000-8000-00000000000a\''
\set orgY  '\'a7e10000-0000-4000-8000-00000000000b\''
\set cuA   '\'a7e10000-0000-4000-8000-0000000000a1\''
\set cuC   '\'a7e10000-0000-4000-8000-0000000000a2\''
\set cuB   '\'a7e10000-0000-4000-8000-0000000000b1\''
\set ownX  '\'a7e10000-0000-4000-8000-0000000000a9\''
\set ownY  '\'a7e10000-0000-4000-8000-0000000000b9\''
\set custA  '\'a7e10000-0000-4000-8000-0000000000c1\''
\set custA2 '\'a7e10000-0000-4000-8000-0000000000c2\''
\set custC  '\'a7e10000-0000-4000-8000-0000000000c3\''
\set custB  '\'a7e10000-0000-4000-8000-0000000000c4\''
\set whX   '\'a7e10000-0000-4000-8000-0000000000d1\''
\set whY   '\'a7e10000-0000-4000-8000-0000000000d2\''
\set iX1   '\'a7e10000-0000-4000-8000-000000000f01\''
\set iX2   '\'a7e10000-0000-4000-8000-000000000f02\''
\set iY1   '\'a7e10000-0000-4000-8000-000000000f03\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:cuA,  'portal-key-cua@test.local',  '{}'::jsonb),
  (:cuC,  'portal-key-cuc@test.local',  '{}'::jsonb),
  (:cuB,  'portal-key-cub@test.local',  '{}'::jsonb),
  (:ownX, 'portal-key-ownx@test.local', '{}'::jsonb),
  (:ownY, 'portal-key-owny@test.local', '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:orgX, 'Portal key X', 'portal-key-x'),
  (:orgY, 'Portal key Y', 'portal-key-y');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgX, :ownX, 'owner', now()),
  (:orgY, :ownY, 'owner', now());
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whX, :orgX, 'Portal key X main', 'WH-PKX', 'active'),
  (:whY, :orgY, 'Portal key Y main', 'WH-PKY', 'active');
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status) values
  (:iX1, :orgX, :whX, 'PK-X1', 'Composition notebook', 40, 'active'),
  (:iX2, :orgX, :whX, 'PK-X2', 'Pencil box',           40, 'active'),
  (:iY1, :orgY, :whY, 'PK-Y1', 'Glue sticks',          40, 'active');
insert into public.customers (id, organization_id, name) values
  (:custA,  :orgX, 'Harbor Elementary'),
  (:custA2, :orgX, 'Harbor Middle'),
  (:custC,  :orgX, 'Lakeside Academy'),
  (:custB,  :orgY, 'Hillcrest School');
insert into public.customer_users (customer_id, user_id, email, accepted_at) values
  (:custA,  :cuA, 'portal-key-cua@test.local', now()),
  (:custA2, :cuA, 'portal-key-cua@test.local', now()),
  (:custC,  :cuC, 'portal-key-cuc@test.local', now()),
  (:custB,  :cuB, 'portal-key-cub@test.local', now());

-- One call as a role and a user. Answers the result as text, or
-- ERR:<sqlstate>:<hint>:<detail> (a failed call's subtransaction is rolled
-- back, so it wrote nothing; its set_config calls are undone with it).
create function pg_temp.run(p_as text, p_sub uuid, p_sql text) returns text language plpgsql as $$
declare v_state text; v_hint text; v_detail text; v text;
begin
  begin
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('role', p_as, true);
    execute p_sql into v;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint, v_detail = pg_exception_detail;
    return 'ERR:' || v_state || ':' || coalesce(v_hint, '') || ':' || coalesce(v_detail, '');
  end;
  return coalesce(v, 'null');
end $$;
-- The header the portal service builds.
create function pg_temp.hdr(p_org uuid, p_wh uuid, p_customer uuid, p_user uuid, p_notes text default null)
returns jsonb language sql as $$
  select jsonb_build_object(
    'organization_id', p_org, 'warehouse_id', p_wh, 'status', 'pending_approval', 'source', 'portal',
    'customer_id', p_customer, 'requester_user_id', p_user, 'requester_email', 'buyer@example.org',
    'requester_name', 'School office', 'notes', p_notes, 'fulfillment_type', 'pickup')
$$;
-- A line as the service sends it: the cost and the customer's price ride along.
create function pg_temp.ln(p_item uuid, p_qty integer) returns jsonb language sql as $$
  select jsonb_build_object('item_id', p_item, 'quantity_requested', p_qty, 'unit_cost_at_request', 2, 'unit_price_at_request', null)
$$;
create function pg_temp.k(p_n integer) returns text language sql as $$
  select 'a7e19000-0000-4000-8000-' || lpad(to_hex(p_n), 12, '0')
$$;
create function pg_temp.place(p_header jsonb, p_lines jsonb, p_key text, p_as text default 'service_role') returns text language sql as $$
  select pg_temp.run(p_as, null, format('select public.place_portal_order_request(%L::jsonb, %L::jsonb, %L)::text', p_header, p_lines, p_key))
$$;
create function pg_temp.status(p_header jsonb, p_lines jsonb, p_key text) returns text language sql as $$
  select pg_temp.run('service_role', null, format('select public.portal_order_submission_status(%L::jsonb, %L::jsonb, %L)::text', p_header, p_lines, p_key))
$$;
-- outcome/replay/order of an answer (or the ERR text as it is).
create function pg_temp.brief(p text) returns text language sql as $$
  select case when p like 'ERR:%' then p
    else concat_ws('/', p::jsonb->>'outcome', coalesce(p::jsonb->>'replay', '-'), coalesce(p::jsonb->>'order_id', '-')) end
$$;
-- Orders, lines, submissions and notifications in the two organizations.
create function pg_temp.counts() returns text language sql as $$
  select (select count(*) from public.order_requests where organization_id in ('a7e10000-0000-4000-8000-00000000000a', 'a7e10000-0000-4000-8000-00000000000b'))::text || '|'
      || (select count(*) from public.order_request_lines l join public.order_requests o on o.id = l.order_request_id
           where o.organization_id in ('a7e10000-0000-4000-8000-00000000000a', 'a7e10000-0000-4000-8000-00000000000b'))::text || '|'
      || (select count(*) from public.order_submissions where organization_id in ('a7e10000-0000-4000-8000-00000000000a', 'a7e10000-0000-4000-8000-00000000000b'))::text || '|'
      || (select count(*) from public.notifications where organization_id in ('a7e10000-0000-4000-8000-00000000000a', 'a7e10000-0000-4000-8000-00000000000b'))::text
$$;
create temp table ans (tag text primary key, r text);

-- ═══ G. Shape and grants ══════════════════════════════════════════════════
select is(
  (select string_agg(p.proname || '=' || p.provolatile::text || '/' || p.prosecdef || '/' || coalesce(p.proconfig::text, '')
                     || '/' || has_function_privilege('authenticated', p.oid, 'EXECUTE')
                     || '/' || has_function_privilege('service_role', p.oid, 'EXECUTE')
                     || '/' || has_function_privilege('anon', p.oid, 'EXECUTE')
                     || '/' || exists (select 1 from unnest(p.proacl) a where a::text like '=%')
                     || '/' || pg_get_userbyid(p.proowner), E'\n' order by p.proname)
     from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('_portal_order_request_hash', '_record_portal_order_submission',
                        'place_portal_order_request', 'portal_order_submission_status')),
  E'_portal_order_request_hash=i/false/{"search_path=public, pg_temp"}/false/true/false/false/postgres\n'
  '_record_portal_order_submission=v/true/{"search_path=public, pg_temp"}/false/true/false/false/postgres\n'
  'place_portal_order_request=v/false/{"search_path=public, pg_temp",lock_timeout=5s}/false/true/false/false/postgres\n'
  'portal_order_submission_status=s/false/{"search_path=public, pg_temp"}/false/true/false/false/postgres',
  'G1: the four portal key functions exist once each; INVOKER except the one recorder, search_path pinned, lock_timeout 5s on the writer, EXECUTE to service_role only (not authenticated, anon or PUBLIC), owned by postgres');
select is(
  (select pg_get_constraintdef(c.oid) from pg_constraint c
    where c.conrelid = 'public.order_submissions'::regclass and c.conname = 'order_submissions_surface_check'),
  'CHECK ((surface = ANY (ARRAY[''web''::text, ''app''::text, ''portal''::text])))',
  'G2: a submission''s surface is web, app or portal');
select is(
  (select string_agg(r.r || '=' || coalesce((select string_agg(p.p, ',' order by p.p)
                                              from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p(p)
                                             where has_table_privilege(r.r, 'public.order_submissions', p.p)), '-'), ' ' order by r.r)
     from unnest(array['anon', 'authenticated', 'service_role']) r(r)),
  'anon=- authenticated=INSERT,SELECT service_role=SELECT',
  'G3: order_submissions'' own grants are unchanged: service_role still reads only (it writes nothing but through the flag-gated recorder)');
select is(
  (select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'storage', 'graphql_public', 'ledger', 'extensions')
      and p.prosrc ~* '(set_config|set\s+(local\s+)?)[^;]*stockpilot\.portal_order_submit')
  || '|' || (select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'storage', 'graphql_public', 'ledger', 'extensions')
      and p.prosrc ~ 'stockpilot\.portal_order_submit')
  || '|' || (select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'storage', 'graphql_public', 'ledger', 'extensions')
      and p.prosrc ~* '(set_config|set\s+(local\s+)?)[^;]*stockpilot\.order_submit'),
  'place_portal_order_request|_record_portal_order_submission,place_portal_order_request|place_order_request,withdraw_order_submission',
  'G4: census: only place_portal_order_request raises stockpilot.portal_order_submit and only the recorder reads it; 0391''s flag is still raised by its two writers only');
select is(
  (select string_agg(p.proname || ':' || (regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '\mexecute\M')::text
                     || ':' || (p.prosrc ~* '(insert\s+into|update|delete\s+from|merge\s+into)\s+(only\s+)?("?public"?\s*\.\s*)?"?order_requests\M')::text
                     || ':' || (p.prosrc ~* '(insert\s+into)\s+(only\s+)?("?public"?\s*\.\s*)?"?order_submissions\M')::text
                     || ':' || (p.prosrc ~* $re$errcode\s*=\s*'(40001|40p01|serialization_failure|deadlock_detected)'$re$)::text,
                     ',' order by p.proname)
     from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('_portal_order_request_hash', '_record_portal_order_submission',
                        'place_portal_order_request', 'portal_order_submission_status')),
  '_portal_order_request_hash:false:false:false:false,_record_portal_order_submission:false:false:true:false,'
  'place_portal_order_request:false:false:false:false,portal_order_submission_status:false:false:false:false',
  'G5: no dynamic SQL, no direct write of order_requests, only the recorder inserts a submission row, never 40001/40P01');
select ok(
  (select p.prosrc ~ 'public\.insert_order_request_with_lines\(p_header, p_lines\)'
          and p.prosrc ~ $re$pg_advisory_xact_lock\(\s*hashtextextended\('order_submission:' \|\| v_org::text \|\| ':' \|\| v_user::text \|\| ':' \|\| v_key::text, 0\)\)$re$
          and p.prosrc ~ 'public\.portal_order_submission_status\(p_header, p_lines, p_key\)'
     from pg_proc p where p.oid = 'public.place_portal_order_request(jsonb, jsonb, text)'::regprocedure)
  and (select p.prosrc ~ $re$hashtextextended\('order_submission:' \|\| v_org::text \|\| ':' \|\| v_uid::text \|\| ':' \|\| v_key::text, 0\)$re$
         from pg_proc p where p.oid = 'public.place_order_request(jsonb, text)'::regprocedure),
  'G6: the portal writer takes 0391''s key lock (the same namespace as place_order_request), asks the status under it, and creates through insert_order_request_with_lines');

-- ═══ A. Only the service role ═════════════════════════════════════════════
select is(
  pg_temp.place(pg_temp.hdr(:orgX, :whX, :custA, :cuA), jsonb_build_array(pg_temp.ln(:iX1, 1)), pg_temp.k(1), 'authenticated')
  || ' ' || pg_temp.place(pg_temp.hdr(:orgX, :whX, :custA, :cuA), jsonb_build_array(pg_temp.ln(:iX1, 1)), pg_temp.k(1), 'anon')
  || ' ' || pg_temp.run('authenticated', :cuA, format('select public.portal_order_submission_status(%L::jsonb, %L::jsonb, %L)::text',
                        pg_temp.hdr(:orgX, :whX, :custA, :cuA), jsonb_build_array(pg_temp.ln(:iX1, 1)), pg_temp.k(1)))
  || ' ' || pg_temp.run('authenticated', :cuA, format('select public._record_portal_order_submission(%L, %L, %L, %L, %L)::text',
                        :orgX, :cuA, pg_temp.k(1), md5('x'), :orgX))
  || ' ' || pg_temp.run('anon', null, format('select public._portal_order_request_hash(%L::jsonb, %L::jsonb)',
                        pg_temp.hdr(:orgX, :whX, :custA, :cuA), jsonb_build_array(pg_temp.ln(:iX1, 1))))
  || ' ' || pg_temp.counts(),
  'ERR:42501:: ERR:42501:: ERR:42501:: ERR:42501:: ERR:42501:: 0|0|0|0',
  'A1: a signed-in user (the customer included) and anon call none of the four, and nothing is written');

-- ═══ P. Place, then replay ════════════════════════════════════════════════
insert into ans values ('P1', pg_temp.place(pg_temp.hdr(:orgX, :whX, :custA, :cuA, 'Leave at the front desk'),
  jsonb_build_array(pg_temp.ln(:iX1, 2), pg_temp.ln(:iX2, 1)), pg_temp.k(1)));
select is(
  (select (a.r::jsonb->>'outcome') || '/' || (a.r::jsonb->>'replay') || '/'
          || o.source || '/' || o.status || '/' || (o.customer_id = :custA)::text || '/' || (o.requester_user_id = :cuA)::text
          || '/' || o.notes || '/'
          || (select string_agg(right(l.item_id::text, 2) || '=' || trim_scale(l.quantity_requested)::text, ',' order by l.item_id)
                from public.order_request_lines l where l.order_request_id = o.id)
     from ans a join public.order_requests o on o.id = (a.r::jsonb->>'order_id')::uuid where a.tag = 'P1'),
  'placed/false/portal/pending_approval/true/true/Leave at the front desk/01=2,02=1',
  'P1: the first call places one portal order pending approval for customer A, its lines as sent');
select is(
  (select s.outcome || '|' || s.surface || '|' || (s.user_id = :cuA)::text || '|' || (s.organization_id = :orgX)::text
          || '|' || (s.order_request_id = (a.r::jsonb->>'order_id')::uuid)::text || '|' || (s.request_hash ~ '^[0-9a-f]{32}$')::text
          || '|' || coalesce(s.refusal::text, 'null')
     from public.order_submissions s, ans a where a.tag = 'P1' and s.key = pg_temp.k(1)::uuid),
  'placed|portal|true|true|true|true|null',
  'P2: one placed row for the key: organization X, the customer''s user, the order, a hash, surface portal');
select pg_temp.counts() as "c1" \gset
insert into ans values ('P3', pg_temp.place(pg_temp.hdr(:orgX, :whX, :custA, :cuA, 'Leave at the front desk'),
  jsonb_build_array(pg_temp.ln(:iX1, 2), pg_temp.ln(:iX2, 1)), pg_temp.k(1)));
select is(
  (select pg_temp.brief(a.r) from ans a where a.tag = 'P3') || '|' || pg_temp.counts(),
  'placed/true/' || (select a.r::jsonb->>'order_id' from ans a where a.tag = 'P1') || '|' || :'c1',
  'P3: the same key and cart again (the answer was lost) answers the FIRST order as a replay: no new order, line, row or notification');
select is(
  pg_temp.brief(pg_temp.place(pg_temp.hdr(:orgX, :whX, :custA, :cuA, 'Leave at the front desk'),
    jsonb_build_array(pg_temp.ln(:iX2, 1), pg_temp.ln(:iX1, 1), pg_temp.ln(:iX1, 1)), pg_temp.k(1)))
  || '|' || pg_temp.counts(),
  'placed/true/' || (select a.r::jsonb->>'order_id' from ans a where a.tag = 'P1') || '|' || :'c1',
  'P4: the same cart in another line order, one item split in two lines, is the same cart: a replay, nothing written');
select is(
  pg_temp.brief(pg_temp.status(pg_temp.hdr(:orgX, :whX, :custA, :cuA, 'Leave at the front desk'),
    jsonb_build_array(pg_temp.ln(:iX1, 2), pg_temp.ln(:iX2, 1)), pg_temp.k(1)))
  || ' ' || pg_temp.brief(pg_temp.status(pg_temp.hdr(:orgX, :whX, :custA, :cuA, 'Leave at the front desk'),
    jsonb_build_array(pg_temp.ln(:iX1, 2), pg_temp.ln(:iX2, 1)), pg_temp.k(99)))
  || '|' || pg_temp.counts(),
  'placed/true/' || (select a.r::jsonb->>'order_id' from ans a where a.tag = 'P1') || ' none/-/-|' || :'c1',
  'P5: the status read answers the placed order for the key, none for an unused key, and writes nothing');

-- ═══ C. Another cart under the same key ═══════════════════════════════════
select is(
  pg_temp.place(pg_temp.hdr(:orgX, :whX, :custA, :cuA, 'Leave at the front desk'),
    jsonb_build_array(pg_temp.ln(:iX1, 3), pg_temp.ln(:iX2, 1)), pg_temp.k(1))
  || ' ' || pg_temp.place(pg_temp.hdr(:orgX, :whX, :custA, :cuA, 'Ring the bell'),
    jsonb_build_array(pg_temp.ln(:iX1, 2), pg_temp.ln(:iX2, 1)), pg_temp.k(1))
  || ' ' || pg_temp.status(pg_temp.hdr(:orgX, :whX, :custA, :cuA),
    jsonb_build_array(pg_temp.ln(:iX1, 2), pg_temp.ln(:iX2, 1)), pg_temp.k(1))
  || '|' || pg_temp.counts(),
  'ERR:P0001:idempotency_conflict: ERR:P0001:idempotency_conflict: ERR:P0001:idempotency_conflict:|' || :'c1',
  'C1: the key with another quantity, other notes or no notes is idempotency_conflict with no detail (no order named), and nothing is written');

-- ═══ X. Scope: organization, user, customer, path ═════════════════════════
insert into ans values ('X1', pg_temp.place(pg_temp.hdr(:orgX, :whX, :custC, :cuC, 'Leave at the front desk'),
  jsonb_build_array(pg_temp.ln(:iX1, 2), pg_temp.ln(:iX2, 1)), pg_temp.k(1)));
select is(
  (select (a.r::jsonb->>'outcome') || '/' || (a.r::jsonb->>'replay') || '/'
          || ((a.r::jsonb->>'order_id') <> (select p.r::jsonb->>'order_id' from ans p where p.tag = 'P1'))::text || '/'
          || (o.customer_id = :custC)::text || '/' || (o.requester_user_id = :cuC)::text
     from ans a join public.order_requests o on o.id = (a.r::jsonb->>'order_id')::uuid where a.tag = 'X1')
  || '|' || (select count(*) from public.order_submissions where key = pg_temp.k(1)::uuid)::text,
  'placed/false/true/true/true|2',
  'X1: another customer''s user in the same organization sending the same key and cart places customer C''s own order; it never answers customer A''s');
select is(
  pg_temp.place(pg_temp.hdr(:orgX, :whX, :custA2, :cuA, 'Leave at the front desk'),
    jsonb_build_array(pg_temp.ln(:iX1, 2), pg_temp.ln(:iX2, 1)), pg_temp.k(1))
  || ' ' || pg_temp.status(pg_temp.hdr(:orgX, :whX, :custA2, :cuA, 'Leave at the front desk'),
    jsonb_build_array(pg_temp.ln(:iX1, 2), pg_temp.ln(:iX2, 1)), pg_temp.k(1))
  || '|' || (select count(*) from public.order_requests where customer_id = :custA2)::text,
  'ERR:P0001:idempotency_conflict: ERR:P0001:idempotency_conflict:|0',
  'X2: the same user under another customer of the organization, with the same key and cart, is a conflict naming no order, and places nothing');
insert into ans values ('X3', pg_temp.place(pg_temp.hdr(:orgY, :whY, :custB, :cuB, 'Leave at the front desk'),
  jsonb_build_array(pg_temp.ln(:iY1, 2)), pg_temp.k(1)));
select is(
  (select (a.r::jsonb->>'outcome') || '/' || (a.r::jsonb->>'replay') || '/'
          || (o.organization_id = :orgY)::text || '/' || (o.customer_id = :custB)::text
     from ans a join public.order_requests o on o.id = (a.r::jsonb->>'order_id')::uuid where a.tag = 'X3')
  || '|' || (select count(*) from public.order_submissions where key = pg_temp.k(1)::uuid)::text,
  'placed/false/true/true|3',
  'X3: a customer of another organization sending the same key places its own order in its own organization');
select is(
  pg_temp.brief(pg_temp.status(pg_temp.hdr(:orgX, :whX, :custA, :cuB, 'Leave at the front desk'),
    jsonb_build_array(pg_temp.ln(:iX1, 2), pg_temp.ln(:iX2, 1)), pg_temp.k(1)))
  || ' ' || pg_temp.brief(pg_temp.status(pg_temp.hdr(:orgY, :whY, :custB, :cuA, 'Leave at the front desk'),
    jsonb_build_array(pg_temp.ln(:iX1, 2), pg_temp.ln(:iX2, 1)), pg_temp.k(1))),
  'none/-/- none/-/-',
  'X4: a header naming customer A with another user, or customer A''s user in another organization, never finds customer A''s order under the key');
-- A key the staff path already holds for this user (a withdrawn web key).
insert into public.order_submissions (organization_id, user_id, key, request_hash, outcome, order_request_id, refusal, surface)
values (:orgX, :cuA, pg_temp.k(6)::uuid, null, 'withdrawn', null, null, 'web');
select pg_temp.counts() as "c2" \gset
select is(
  pg_temp.place(pg_temp.hdr(:orgX, :whX, :custA, :cuA), jsonb_build_array(pg_temp.ln(:iX1, 1)), pg_temp.k(6))
  || '|' || pg_temp.counts(),
  'ERR:P0001:idempotency_conflict:|' || :'c2',
  'X5: a key that holds a staff submission is a conflict on the portal path, and nothing is written');

-- ═══ RF. Replay first ═════════════════════════════════════════════════════
update public.inventory_items set order_catalog_visible = false where id = :iX1;
select is(
  pg_temp.brief(pg_temp.place(pg_temp.hdr(:orgX, :whX, :custA, :cuA, 'Leave at the front desk'),
    jsonb_build_array(pg_temp.ln(:iX1, 2), pg_temp.ln(:iX2, 1)), pg_temp.k(1)))
  || ' ' || pg_temp.place(pg_temp.hdr(:orgX, :whX, :custA, :cuA, 'Leave at the front desk'),
    jsonb_build_array(pg_temp.ln(:iX1, 2), pg_temp.ln(:iX2, 1)), pg_temp.k(2))
  || '|' || pg_temp.counts(),
  'placed/true/' || (select a.r::jsonb->>'order_id' from ans a where a.tag = 'P1')
  || ' ERR:P0001:order_item_hidden:' || :iX1 || '|' || :'c2',
  'RF1: an item hidden after the first call: the same key still answers the first order (looked up before the write); a new key is refused by the hide and writes nothing');
update public.inventory_items set order_catalog_visible = true where id = :iX1;

-- ═══ K. The key and the header ════════════════════════════════════════════
select is(
  pg_temp.place(pg_temp.hdr(:orgX, :whX, :custA, :cuA), jsonb_build_array(pg_temp.ln(:iX1, 1)), null)
  || ' ' || pg_temp.place(pg_temp.hdr(:orgX, :whX, :custA, :cuA), jsonb_build_array(pg_temp.ln(:iX1, 1)), '  ')
  || ' ' || pg_temp.place(pg_temp.hdr(:orgX, :whX, :custA, :cuA), jsonb_build_array(pg_temp.ln(:iX1, 1)), 'not-a-key')
  || ' ' || pg_temp.status(pg_temp.hdr(:orgX, :whX, :custA, :cuA), jsonb_build_array(pg_temp.ln(:iX1, 1)), null)
  || '|' || pg_temp.counts(),
  'ERR:22023:idempotency_key_required: ERR:22023:idempotency_key_required: ERR:22023:idempotency_key_invalid: ERR:22023:idempotency_key_required:|' || :'c2',
  'K1: a missing, blank or malformed key is refused before anything is read or written');
select is(
  pg_temp.place(pg_temp.hdr(:orgX, :whX, :custA, :cuA) || '{"source": "public_link", "status": "pending_confirmation"}', jsonb_build_array(pg_temp.ln(:iX1, 1)), pg_temp.k(3))
  || ' ' || pg_temp.place(pg_temp.hdr(:orgX, :whX, :custA, :cuA) - 'customer_id', jsonb_build_array(pg_temp.ln(:iX1, 1)), pg_temp.k(3))
  || ' ' || pg_temp.place(pg_temp.hdr(:orgX, :whX, :custA, :cuA) || '{"requester_user_id": null}', jsonb_build_array(pg_temp.ln(:iX1, 1)), pg_temp.k(3))
  || ' ' || pg_temp.place(pg_temp.hdr(:orgX, :whX, :custA, :cuA) || '{"organization_id": "x"}', jsonb_build_array(pg_temp.ln(:iX1, 1)), pg_temp.k(3))
  || ' ' || pg_temp.place(pg_temp.hdr(:orgX, :whX, :custA, :cuA), '[]', pg_temp.k(3))
  || ' ' || pg_temp.place(pg_temp.hdr(:orgX, :whX, :custA, :cuA), jsonb_build_array(jsonb_build_object('item_id', :iX1, 'quantity_requested', 1.5)), pg_temp.k(3))
  || ' ' || pg_temp.place(pg_temp.hdr(:orgX, :whX, :custA, :cuA), jsonb_build_array(jsonb_build_object('item_id', 'nope', 'quantity_requested', 1)), pg_temp.k(3))
  || '|' || pg_temp.counts(),
  'ERR:22023:order_request_invalid:header ERR:22023:order_request_invalid:header ERR:22023:order_request_invalid:header '
  'ERR:22023:order_request_invalid:header ERR:22023:order_request_invalid:lines ERR:22023:order_request_invalid:lines '
  'ERR:22023:order_request_invalid:lines|' || :'c2',
  'K2: only a portal header naming its organization, customer and requester, with 1 to 100 whole lines, is keyed; nothing is written otherwise');
insert into ans values ('K3a', pg_temp.place(pg_temp.hdr(:orgX, :whX, :custA, :cuA), jsonb_build_array(pg_temp.ln(:iX2, 1)), upper(' ' || pg_temp.k(4) || ' ')));
insert into ans values ('K3b', pg_temp.place(pg_temp.hdr(:orgX, :whX, :custA, :cuA), jsonb_build_array(pg_temp.ln(:iX2, 1)), pg_temp.k(4)));
select is(
  (select pg_temp.brief(a.r) from ans a where a.tag = 'K3a')
  || '|' || (select pg_temp.brief(a.r) from ans a where a.tag = 'K3b')
  || '|' || (select count(*) from public.order_submissions where key = pg_temp.k(4)::uuid)::text,
  (select 'placed/false/' || s.order_request_id || '|placed/true/' || s.order_request_id || '|1'
     from public.order_submissions s where s.key = pg_temp.k(4)::uuid),
  'K3: the key is read as a uuid: upper case with spaces around it is the same key');

-- ═══ F. The recorder ══════════════════════════════════════════════════════
select pg_temp.counts() as "c3" \gset
select is(
  pg_temp.run('service_role', null, format('select public._record_portal_order_submission(%L, %L, %L, %L, %L)::text',
    :orgX, :cuA, pg_temp.k(7), md5('f1'), (select a.r::jsonb->>'order_id' from ans a where a.tag = 'P1')))
  || ' ' || pg_temp.run('service_role', null, format($q$with f as (select set_config('stockpilot.portal_order_submit', 'on', true) as v)
    select public._record_portal_order_submission(%L, %L, %L, %L, %L)::text from f$q$,
    :orgX, :cuA, pg_temp.k(7), md5('f1'), (select a.r::jsonb->>'order_id' from ans a where a.tag = 'P1')))
  || ' ' || pg_temp.run('service_role', null, format($q$with f as (select set_config('stockpilot.portal_order_submit', (pg_current_xact_id()::text::bigint - 1)::text, true) as v)
    select public._record_portal_order_submission(%L, %L, %L, %L, %L)::text from f$q$,
    :orgX, :cuA, pg_temp.k(7), md5('f1'), (select a.r::jsonb->>'order_id' from ans a where a.tag = 'P1')))
  || '|' || pg_temp.counts(),
  'ERR:42501:portal_order_submission_not_open: ERR:42501:portal_order_submission_not_open: ERR:42501:portal_order_submission_not_open:|' || :'c3',
  'F1: called directly, with the flag ''on'' or with another transaction''s id, the recorder refuses and writes nothing');
select is(
  pg_temp.run('service_role', null, format($q$with f as (select set_config('stockpilot.portal_order_submit', pg_current_xact_id()::text, true) as v)
    select public._record_portal_order_submission(%L, %L, %L, %L, %L)::text from f$q$,
    :orgX, :cuC, pg_temp.k(7), md5('f2'), (select a.r::jsonb->>'order_id' from ans a where a.tag = 'P1')))
  || ' ' || pg_temp.run('service_role', null, format($q$with f as (select set_config('stockpilot.portal_order_submit', pg_current_xact_id()::text, true) as v)
    select public._record_portal_order_submission(%L, %L, %L, %L, %L)::text from f$q$,
    :orgX, :cuB, pg_temp.k(7), md5('f2'), (select a.r::jsonb->>'order_id' from ans a where a.tag = 'X3')))
  || ' ' || pg_temp.run('service_role', null, format($q$with f as (select set_config('stockpilot.portal_order_submit', pg_current_xact_id()::text, true) as v)
    select public._record_portal_order_submission(%L, %L, %L, %L, %L)::text from f$q$,
    :orgX, :cuA, pg_temp.k(7), md5('f2'), :orgX))
  || '|' || pg_temp.counts(),
  'ERR:22023:portal_order_submission_invalid: ERR:22023:portal_order_submission_invalid: ERR:22023:portal_order_submission_invalid:|' || :'c3',
  'F2: with the flag up, the recorder still refuses another requester''s order, an order of another organization and an id that is no order');
select is(
  split_part(pg_temp.run('service_role', null, format($q$with f as (select set_config('stockpilot.portal_order_submit', pg_current_xact_id()::text, true) as v)
    select public._record_portal_order_submission(%L, %L, %L, %L, %L)::text from f$q$,
    :orgX, :cuA, pg_temp.k(7), md5('f3'), (select a.r::jsonb->>'order_id' from ans a where a.tag = 'P1'))), ':', 2)
  || '|' || pg_temp.counts(),
  '23505|' || :'c3',
  'F3: an order that already has a submission row gets no second one (order_submissions_order_request_uidx)');

-- ═══ D. Lifetime ══════════════════════════════════════════════════════════
select is(
  (select count(*) from public.order_submissions where organization_id = :orgX and user_id = :cuA and surface = 'portal')::text,
  '2',
  'D1: the customer''s keys stay (k1 and k4): rows never change, so a late resend of either still replays');

-- ═══ Z. Unchanged ═════════════════════════════════════════════════════════
select is(
  (select p.prosecdef::text || '|' || coalesce(p.proconfig::text, '') || '|' || has_function_privilege('service_role', p.oid, 'EXECUTE')::text
          || '|' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
     from pg_proc p where p.oid = 'public.insert_order_request_with_lines(jsonb, jsonb, text)'::regprocedure),
  'false|{"search_path=public, pg_temp"}|true|false',
  'Z1: insert_order_request_with_lines keeps its posture: INVOKER, service_role only (the portal writer calls it as the service role, with the triggers and rights the portal had)');
select is(
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
      and p.proname in ('place_order_request', 'withdraw_order_submission', 'order_submission_status')
      and has_function_privilege('service_role', p.oid, 'EXECUTE'))::text,
  '0',
  'Z2: 0391''s member functions stay closed to the service role');
select is(
  (select string_agg(pol.polname, ',' order by pol.polname) from pg_policy pol where pol.polrelid = 'public.order_submissions'::regclass),
  'order_submissions_insert,order_submissions_select',
  'Z3: order_submissions keeps 0391''s two policies, and gets no new one');
select is(
  (select count(*) from pg_trigger t where t.tgrelid = 'public.order_submissions'::regclass and not t.tgisinternal)::text,
  '0',
  'Z4: order_submissions has no trigger');

select * from finish();
rollback;
