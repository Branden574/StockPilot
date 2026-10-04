-- supabase/tests/0393_order_signature_images.test.sql
-- pgTAP proof for migration 0393 (slice C step 4, owner decision O1): the
-- captured signature image leaves the member-readable order row.
--
-- R. The replay: the migration's own lock prelude and data block, read back
--    from supabase_migrations.schema_migrations, run again on fixtures (R0:
--    each recorded once; R1: EXCLUSIVE, never ACCESS EXCLUSIVE, on
--    order_requests and order_request_secrets).
-- X. Each abort-on-mismatch check raises on a planted mismatch, in a
--    self-undoing subtransaction before the real replay: an image longer than
--    the side CHECK (the row CHECK dropped and the capture trigger disabled
--    for the test), a different image
--    already in the side table, a copy altered or skipped on the way in, a
--    null-out skipped or undone, an updated_at re-stamped, another order's
--    side image moved, (test stage) a side image changed after its row was
--    nulled. Every one of the data block's 10 raise sites is covered: 9 by a
--    planted mismatch here, the trigger-state check (which cannot be planted
--    without editing the block) by the mutation driver (mutate-0392.py I7).
--    X0: the fixtures are byte for byte as before.
-- D. The move: every image lands in the side table byte for byte (an order
--    with no side row, one whose side row holds link tokens, one whose side
--    row already holds the same image), the rows are null, every other
--    column (updated_at included) is unchanged, an order without an image
--    and a side image of an order without one on its row are untouched, the
--    updated_at trigger is on again, no notification is written.
-- C. The capture trigger: confirm_order_signature (frozen, service_role) on
--    a 0389-minted order completes it and the image lands in the side table,
--    never on the row (a viewer reads null); resume_fulfillment clears the
--    side copy with the hand-over; confirm_physical_signature writes no side
--    image; a notes save does not touch the side table (UPDATE OF columns);
--    the admin client (service_role) writing an image directly is moved too.
-- P. Posture: the capture function's body, SECURITY INVOKER, search_path,
--    owner, no EXECUTE for anyone; its trigger is BEFORE UPDATE OF
--    signature_data_url, signed_at FOR EACH ROW and enabled; it raises
--    nothing; comments; the data block raises P0001 only and logs nothing;
--    the frozen bodies keep their md5.
--
-- Mutation table (sec-orders/mutate-0392.py --db, the 0393 rows):
--   I1 the capture trigger without its reset branch          -> C3
--   I2 the capture trigger leaves the image on the row        -> C1, C2
--   I3 the capture trigger SECURITY DEFINER                  -> P1
--   I4 the move nulls the rows before the byte check          -> X3 (no raise: the check is gone)
--   I5 the updated_at trigger left enabled during the move    -> R2 (other_columns_changed raises; nothing applied)
--
-- Roles: fixtures as the test superuser; attempts through pg_temp.attempt
-- (undone) or pg_temp.call_as (kept). begin/rollback. Namespace 03930000.

begin;

select plan(30);

\set orgA   '\'03930000-0000-0000-0000-00000000000a\''
\set mgr    '\'03930000-0000-0000-0000-0000000000a1\''
\set req    '\'03930000-0000-0000-0000-0000000000a2\''
\set vwr    '\'03930000-0000-0000-0000-0000000000a6\''
\set whA    '\'03930000-0000-0000-0000-0000000000d1\''
\set itR    '\'03930000-0000-0000-0000-0000000000f1\''
\set iDone1   '\'03930000-0000-0000-0000-000000000101\''
\set iDone2   '\'03930000-0000-0000-0000-000000000102\''
\set iSame    '\'03930000-0000-0000-0000-000000000103\''
\set iNone    '\'03930000-0000-0000-0000-000000000104\''
\set iSideOnly '\'03930000-0000-0000-0000-000000000105\''
\set iSign    '\'03930000-0000-0000-0000-000000000201\''
\set iResume  '\'03930000-0000-0000-0000-000000000202\''
\set iPhys    '\'03930000-0000-0000-0000-000000000203\''
\set iSvc     '\'03930000-0000-0000-0000-000000000204\''
\set lResume  '\'03930000-0000-0000-0000-000000000302\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:mgr, '0393-mgr@test.local', '{}'::jsonb),
  (:req, '0393-req@test.local', '{}'::jsonb),
  (:vwr, '0393-vwr@test.local', '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values (:orgA, '0393 Images A', '0393-images-a');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :mgr, 'manager', now()),
  (:orgA, :req, 'staff',   now()),
  (:orgA, :vwr, 'viewer',  now());
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :orgA, '0393 Main', 'WH-0393A', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :req, :whA, true),
  (:orgA, :vwr, :whA, true);
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type) values
  (:itR, :orgA, :whA, '0393-R', 'Images resume', 30, 'active', 'none');

create temp table img (n text primary key, v text not null);
insert into img values
  ('I1', 'data:image/png;base64,' || repeat('A1', 600)),
  ('I2', 'data:image/png;base64,' || repeat('B2', 900)),
  ('I3', 'data:image/png;base64,' || repeat('C3', 300)),
  ('IS', 'data:image/png;base64,' || repeat('D4', 200)),
  ('IR', 'data:image/png;base64,' || repeat('E5', 100)),
  ('POST', 'data:image/png;base64,' || repeat('F6', 150));
create function pg_temp.img(p text) returns text language sql stable as $$ select v from img where n = p $$;
create function pg_temp.sha(p text) returns text language sql immutable as $$
  select encode(extensions.digest(p, 'sha256'), 'hex')
$$;

insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type,
   approved_by, approved_at, signed_at, signed_by_name, signature_method, signature_data_url,
   signature_token, signature_token_expires_at, internal_notes, updated_at) values
  (:iDone1,    :orgA, :whA, 'completed',         'internal', :req, 'pickup', :mgr, now(), now(), 'Ann', 'digital', pg_temp.img('I1'),
   null, null, null, now() - interval '5 days'),
  (:iDone2,    :orgA, :whA, 'completed',         'internal', :req, 'pickup', :mgr, now(), now(), 'Bo',  'digital', pg_temp.img('I2'),
   null, null, null, now() - interval '5 days'),
  (:iSame,     :orgA, :whA, 'completed',         'internal', :req, 'pickup', :mgr, now(), now(), 'Cy',  'digital', pg_temp.img('I3'),
   null, null, null, now() - interval '5 days'),
  (:iNone,     :orgA, :whA, 'approved',          'internal', :req, 'pickup', :mgr, now(), null,  null,  null,      null,
   null, null, 'untouched', now() - interval '5 days'),
  (:iSideOnly, :orgA, :whA, 'completed',         'internal', :req, 'pickup', :mgr, now(), now(), 'Di',  'digital', null,
   null, null, null, now() - interval '5 days'),
  (:iSign,     :orgA, :whA, 'staged_for_pickup', 'internal', :req, 'pickup', :mgr, now(), null,  null,  null,      null,
   pg_temp.sha(repeat('9e', 32)), now() + interval '1 day', null, now() - interval '5 days'),
  (:iResume,   :orgA, :whA, 'backordered',       'internal', :req, 'pickup', :mgr, now(), now(), 'Ed',  'digital', null,
   null, null, null, now() - interval '5 days'),
  (:iPhys,     :orgA, :whA, 'staged_for_pickup', 'internal', :req, 'pickup', :mgr, now(), null,  null,  null,      null,
   null, null, null, now() - interval '5 days'),
  (:iSvc,      :orgA, :whA, 'completed',         'internal', :req, 'pickup', :mgr, now(), now(), 'Fay', 'digital', null,
   null, null, null, now() - interval '5 days');
insert into public.order_request_lines
  (id, order_request_id, item_id, quantity_requested, quantity_fulfilled, quantity_picked) values
  (:lResume, :iResume, :itR, 10, 5, null);
-- The side rows earlier slices left: link tokens moved by 0392 (iDone2), the
-- same image already copied (iSame), an image of an order whose row holds
-- none (iSideOnly), a 0389 mint (iSign), the image of a backordered
-- hand-over (iResume).
insert into public.order_request_secrets
  (order_request_id, organization_id, signature_token, return_token, signature_data_url) values
  (:iDone2,    :orgA, null,               gen_random_uuid(), null),
  (:iSame,     :orgA, null,               null,              pg_temp.img('I3')),
  (:iSideOnly, :orgA, null,               null,              pg_temp.img('IS')),
  (:iSign,     :orgA, repeat('9e', 32),   null,              null),
  (:iResume,   :orgA, null,               null,              pg_temp.img('IR'));

create temp table data_ids (id uuid primary key);
insert into data_ids values (:iDone1), (:iDone2), (:iSame), (:iNone), (:iSideOnly);

-- ══ Helpers (the 0387 shapes) ═════════════════════════════════════════════
create function pg_temp.hint(p_hint text) returns text language sql immutable as $$
  select case when p_hint is null or p_hint = ''
                or p_hint like 'Grant the required privileges to the current role with:%'
              then '-' else p_hint end
$$;
create function pg_temp.attempt(p_as text, p_sub uuid, p_sql text, p_prep text default null, p_check text default null)
returns text language plpgsql as $$
declare v_state text; v_msg text; v_hint text; v_n bigint; v_seen text;
begin
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', p_as, true);
    perform set_config('role', p_as, true);
    execute p_sql;
    get diagnostics v_n = row_count;
    perform set_config('role', 'none', true);
    if p_check is not null then
      execute p_check into v_seen;
    end if;
    raise exception using errcode = 'XX393', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_state = 'XX393' then
    return 'ok:' || v_n::text || coalesce(':' || v_seen, '');
  end if;
  return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
end $$;
create function pg_temp.call_as(p_as text, p_sub uuid, p_sql text, p_check text default null)
returns text language plpgsql as $$
declare v_state text; v_msg text; v_hint text; v text; v_seen text;
begin
  begin
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', p_as, true);
    perform set_config('role', p_as, true);
    execute p_sql into v;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claim.role', '', true);
    if p_check is not null then
      execute p_check into v_seen;
    end if;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
    return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
  end;
  return coalesce(v, 'null') || coalesce('|' || v_seen, '');
end $$;
create function pg_temp.mig(p_version text, p_tag text) returns text language sql stable as $$
  select coalesce(string_agg(st, E';\n'), '')
    from supabase_migrations.schema_migrations m, unnest(m.statements) st
   where m.version = p_version and position(p_tag in st) > 0
$$;
create function pg_temp.mig_count(p_version text, p_tag text) returns bigint language sql stable as $$
  select count(*)
    from supabase_migrations.schema_migrations m, unnest(m.statements) st
   where m.version = p_version and position(p_tag in st) > 0
$$;
create function pg_temp.try_move(p_prep text) returns text language plpgsql as $$
declare v_state text; v_msg text;
begin
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    execute pg_temp.mig('0393', '$c393_move$');
    raise exception using errcode = 'XX393', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  if v_state = 'XX393' then
    return 'ok';
  end if;
  return v_state || ':' || v_msg;
end $$;
create function pg_temp.try_move_d(p_prep text) returns text language plpgsql as $$
declare v_state text; v_msg text; v_detail text;
begin
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    execute pg_temp.mig('0393', '$c393_move$');
    raise exception using errcode = 'XX393', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_detail = pg_exception_detail;
  end;
  if v_state = 'XX393' then
    return 'ok';
  end if;
  return v_state || ':' || v_msg || ':' || coalesce(v_detail, '');
end $$;
create function pg_temp.fixture_state() returns text language sql stable as $$
  select md5(coalesce((select string_agg(to_jsonb(o)::text, E'\n' order by o.id)
                         from public.order_requests o where o.organization_id = '03930000-0000-0000-0000-00000000000a'), ''))
         || md5(coalesce((select string_agg(to_jsonb(s)::text, E'\n' order by s.order_request_id)
                            from public.order_request_secrets s where s.organization_id = '03930000-0000-0000-0000-00000000000a'), ''))
$$;

create schema zz_probe_0393;
create function zz_probe_0393.side_before() returns trigger language plpgsql as $$
begin
  if tg_argv[0] = 'alter' and new.signature_data_url is not null then
    new.signature_data_url := new.signature_data_url || 'x';
  elsif tg_argv[0] = 'skip' and new.signature_data_url is not null then
    return null;
  end if;
  return new;
end $$;
create function zz_probe_0393.side_after() returns trigger language plpgsql as $$
begin
  update public.order_request_secrets
     set signature_data_url = signature_data_url || 'x'
   where order_request_id = tg_argv[0]::uuid;
  return null;
end $$;
create function zz_probe_0393.order_before() returns trigger language plpgsql as $$
begin
  if tg_argv[0] = 'skip_null_out' and old.signature_data_url is not null and new.signature_data_url is null then
    return null;
  elsif tg_argv[0] = 'keep' and old.signature_data_url is not null and new.signature_data_url is null then
    new.signature_data_url := old.signature_data_url;
  elsif tg_argv[0] = 'bump_updated' then
    new.updated_at := old.updated_at + interval '1 second';
  end if;
  return new;
end $$;

create function zz_probe_0393.order_after() returns trigger language plpgsql as $$
begin
  if old.signature_data_url is not null and new.signature_data_url is null then
    update public.order_request_secrets set signature_data_url = signature_data_url || 'x' where order_request_id = new.id;
  end if;
  return null;
end $$;

create temp table snap (k text primary key, v text);
insert into snap values ('fixtures', pg_temp.fixture_state());
insert into snap values ('notifications', (select count(*)::text from public.notifications where organization_id = :orgA));
create temp table other_before as
select o.id, (to_jsonb(o) - 'signature_data_url') as other, to_jsonb(o) as whole, o.signature_data_url as image
  from public.order_requests o where o.id in (select id from data_ids);

-- ══ R / X ═════════════════════════════════════════════════════════════════
select is(
  pg_temp.mig_count('0393', '$c393_lock$')::text || '/' || pg_temp.mig_count('0393', '$c393_move$')::text,
  '1/1',
  'R0: the CLI recorded the lock prelude and the data block of 0393 exactly once each (this suite replays that text)');
select is(
  pg_temp.try_move(format($q$do $p$ begin
                               -- The capture trigger (0393 is applied) would move the image to the side
                               -- table, whose own CHECK raises 23514 first: keep it on the row for this
                               -- planted mismatch (desk check F2; the subtransaction undoes both).
                               alter table public.order_requests disable trigger trg_order_requests_signature_image_capture;
                               alter table public.order_requests drop constraint order_requests_signature_data_url_len_chk;
                               update public.order_requests set signature_data_url = repeat('Z', 524289) where id = %L;
                             end $p$$q$, :iDone1)),
  'P0001:order_secrets_images_too_long',
  'X1: an image longer than the side table''s CHECK (the row CHECK dropped and the capture trigger disabled for the test): refused before any write');
select is(
  pg_temp.try_move(format('update public.order_request_secrets set signature_data_url = %L where order_request_id = %L',
                          pg_temp.img('IS'), :iSame)),
  'P0001:order_secrets_images_conflict',
  'X2: a side table already holding a DIFFERENT image for the order: refused before any write');
select is(
  pg_temp.try_move('create trigger zz_probe_0393_side before insert or update on public.order_request_secrets
                      for each row execute function zz_probe_0393.side_before(''alter'')'),
  'P0001:order_secrets_images_copy_mismatch',
  'X3: a side copy that is not byte-identical: raises BEFORE any row is nulled');
select is(
  pg_temp.try_move('create trigger zz_probe_0393_side before insert or update on public.order_request_secrets
                      for each row execute function zz_probe_0393.side_before(''skip'')'),
  'P0001:order_secrets_images_count',
  'X4: a side copy that never lands: rows copied <> images');
select is(
  pg_temp.try_move('create trigger zz_probe_0393_order before update on public.order_requests
                      for each row execute function zz_probe_0393.order_before(''skip_null_out'')'),
  'P0001:order_secrets_images_count',
  'X5: a row that is not nulled: rows nulled <> images');
select is(
  pg_temp.try_move('create trigger zz_probe_0393_order before update on public.order_requests
                      for each row execute function zz_probe_0393.order_before(''keep'')'),
  'P0001:order_secrets_images_left',
  'X6: an image still on the row after the null-out: raises');
select is(
  pg_temp.try_move('create trigger zz_probe_0393_order before update on public.order_requests
                      for each row execute function zz_probe_0393.order_before(''bump_updated'')'),
  'P0001:order_secrets_images_other_columns_changed',
  'X7: an updated_at re-stamped by the move: raises');
select is(
  pg_temp.try_move(format('create trigger zz_probe_0393_after after insert on public.order_request_secrets
                             for each row execute function zz_probe_0393.side_after(%L)', :iSideOnly)),
  'P0001:order_secrets_images_copy_mismatch',
  'X8: a side image of an order that held none on its row, moved during the copy: raises');
select matches(
  pg_temp.try_move_d('create trigger zz_probe_0393_oafter after update on public.order_requests
                        for each row execute function zz_probe_0393.order_after()'),
  '^P0001:order_secrets_images_copy_mismatch:The side table does not hold the \d+ images the rows held',
  'X9: a side image changed after its row was nulled (after the byte check): the image checksum raises');
select is(
  pg_temp.fixture_state(),
  (select v from snap where k = 'fixtures'),
  'X0: after the 9 refused runs every fixture order and side row is byte for byte as before');

select lives_ok(pg_temp.mig('0393', '$c393_lock$'), 'R1a: the lock prelude replays');
select is(
  (select string_agg(c.relname || '=' || l.mode, ',' order by c.relname)
     from pg_locks l join pg_class c on c.oid = l.relation
    where l.pid = pg_backend_pid() and l.granted and l.locktype = 'relation'
      and c.relname in ('order_requests', 'order_request_secrets') and l.mode = 'ExclusiveLock')
  || '|' || (select count(*)::text
               from pg_locks l join pg_class c on c.oid = l.relation
              where l.pid = pg_backend_pid() and l.granted and l.locktype = 'relation'
                and c.relname in ('order_requests', 'order_request_secrets') and l.mode = 'AccessExclusiveLock'),
  'order_request_secrets=ExclusiveLock,order_requests=ExclusiveLock|0',
  'R1: the prelude holds EXCLUSIVE on order_requests and order_request_secrets and no ACCESS EXCLUSIVE');
select lives_ok(pg_temp.mig('0393', '$c393_move$'), 'R2: the data block runs on every fixture shape without raising');

-- ══ D. The move ═══════════════════════════════════════════════════════════
select is(
  (select string_agg((s.signature_data_url = b.image and length(s.signature_data_url) = length(b.image)
                      and md5(s.signature_data_url) = md5(b.image) and o.signature_data_url is null)::text, ',' order by b.id)
     from other_before b
     join public.order_requests o on o.id = b.id
     left join public.order_request_secrets s on s.order_request_id = b.id
    where b.image is not null),
  'true,true,true',
  'D1: every stored image is in the side table byte for byte (no side row before; a side row holding link tokens; the same image already there) and its row is null');
select is(
  (select (s.return_token is not null)::text from public.order_request_secrets s where s.order_request_id = :iDone2)
  || '/' || (select (s.signature_data_url = pg_temp.img('IS'))::text from public.order_request_secrets s where s.order_request_id = :iSideOnly),
  'true/true',
  'D2: the side row''s link token is kept, and a side image of an order with none on its row is untouched');
select is(
  (select count(*)::text from other_before b join public.order_requests o on o.id = b.id
    where (to_jsonb(o) - 'signature_data_url') is distinct from b.other),
  '0',
  'D3: every other column of every fixture order, updated_at included, is unchanged');
select is(
  (select (to_jsonb(o) = b.whole)::text from other_before b join public.order_requests o on o.id = b.id where b.id = :iNone),
  'true',
  'D4: an order without an image is byte for byte untouched');
select is(
  (select t.tgenabled::text from pg_trigger t
    where t.tgrelid = 'public.order_requests'::regclass and t.tgname = 'order_requests_set_updated_at')
  || '/' || (select count(*)::text from public.notifications where organization_id = :orgA),
  'O/' || (select v from snap where k = 'notifications'),
  'D5: the updated_at trigger is enabled again, and the move wrote no notification');

-- ══ C. The capture trigger ════════════════════════════════════════════════
select is(
  pg_temp.call_as('service_role', null,
    format($q$select coalesce(public.confirm_order_signature(%L, %L, 'Pat Signer', 'pat@example.com', %L)::text, 'null')$q$,
           :iSign, pg_temp.sha(repeat('9e', 32)), pg_temp.img('POST')),
    format($q$select o.status || '/' || o.signature_method || '/' || (o.signed_at is not null)::text || '/' || (o.signature_data_url is null)::text
                     || '/' || (s.signature_data_url = %L)::text || '/' || (s.signature_token = repeat('9e', 32))::text
                from public.order_requests o join public.order_request_secrets s on s.order_request_id = o.id where o.id = %L$q$,
           pg_temp.img('POST'), :iSign)),
  :orgA || '|completed/digital/true/true/true/true',
  'C1: confirm_order_signature (frozen, service_role) completes a 0389-minted order; the image lands in the side table (its token kept), never on the row');
select is(
  pg_temp.call_as('authenticated', :vwr,
    format('select coalesce(signature_data_url, ''null'') from public.order_requests where id = %L', :iSign)),
  'null',
  'C2: a member (a viewer) reads no image on the order row');
select is(
  pg_temp.call_as('authenticated', :mgr, format('select r.status from public.resume_fulfillment(%L) r', :iResume),
    format($q$select (o.signed_at is null)::text || '/' || coalesce(s.signature_data_url, 'null')
                from public.order_requests o join public.order_request_secrets s on s.order_request_id = o.id where o.id = %L$q$, :iResume)),
  'pick_slip_generated|true/null',
  'C3: resume_fulfillment (frozen) resets the hand-over and the side image goes with it');
select is(
  pg_temp.call_as('authenticated', :mgr, format($q$select r.status from public.confirm_physical_signature(%L, 'Paper Signer') r$q$, :iPhys),
    format($q$select o.signature_method || '/' || coalesce((select (s.signature_data_url is null)::text
                                                              from public.order_request_secrets s where s.order_request_id = o.id), 'no side row')
                from public.order_requests o where o.id = %L$q$, :iPhys)),
  'completed|physical/no side row',
  'C4: confirm_physical_signature (frozen) records a paper hand-over and writes no side image');
select is(
  pg_temp.attempt('authenticated', :mgr, format('update public.order_requests set signature_data_url = %L where id = %L', pg_temp.img('POST'), :iDone1))
  || ' / ' ||
  pg_temp.attempt('authenticated', :mgr, format('update public.order_requests set signed_at = null where id = %L', :iDone1)),
  '42501:-:permission denied for table order_requests / 42501:-:permission denied for table order_requests',
  'C5: a signed-in caller can name neither column (0387 revoked both), so it never fires the trigger');
select is(
  pg_temp.attempt('service_role', null,
    format('update public.order_requests set signature_data_url = %L where id = %L', pg_temp.img('POST'), :iSvc),
    null,
    format($q$select (o.signature_data_url is null)::text || '/' || (s.signature_data_url = %L)::text
                from public.order_requests o join public.order_request_secrets s on s.order_request_id = o.id where o.id = %L$q$,
           pg_temp.img('POST'), :iSvc)),
  'ok:1:true/true',
  'C6: an image the admin client writes directly is moved too (the trigger is SECURITY INVOKER and service_role may write the side table)');

-- ══ P. Posture ════════════════════════════════════════════════════════════
select is(
  (select md5(p.prosrc) || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '') || '|' || pg_get_userbyid(p.proowner) || '|'
          || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text || '|'
          || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || '|'
          || coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a)::text, 'false')
     from pg_proc p where p.oid = to_regprocedure('public.tg_order_requests_signature_image_capture()')),
  '22161ed6caf46236d6e4e93002f448bb|false|{"search_path=public, pg_temp"}|postgres|false|false|false|false',
  'P1: the capture function is 0393''s body, SECURITY INVOKER, search_path pinned, owned by postgres, executable by nobody (a trigger needs no EXECUTE)');
select is(
  (select t.tgenabled::text || '|' || (pg_get_triggerdef(t.oid) ~ 'BEFORE UPDATE OF signature_data_url, signed_at ON public\.order_requests FOR EACH ROW')::text
     from pg_trigger t where t.tgrelid = 'public.order_requests'::regclass and t.tgname = 'trg_order_requests_signature_image_capture'),
  'O|true',
  'P2: the trigger is BEFORE UPDATE OF signature_data_url, signed_at FOR EACH ROW, and enabled');
select is(
  (select (p.prosrc !~* 'raise')::text from pg_proc p where p.oid = 'public.tg_order_requests_signature_image_capture()'::regprocedure)
  || '/' || (pg_temp.mig('0393', '$c393_move$') !~* '40001|40p01|serialization_failure|deadlock_detected')::text
  || '/' || (pg_temp.mig('0393', '$c393_move$') !~* 'raise\s+(notice|info|log|warning|debug)')::text
  || '/' || (select string_agg(distinct m[1], ',') from regexp_matches(pg_temp.mig('0393', '$c393_move$'), $re$errcode\s*=\s*'([^']+)'$re$, 'g') m),
  'true/true/true/P0001',
  'P3: the trigger raises nothing of its own; the data block raises P0001 only (never 40001 or 40P01) and logs nothing');
select is(
  (coalesce(obj_description('public.tg_order_requests_signature_image_capture()'::regprocedure, 'pg_proc'), '') ~ '0393')::text || ','
  || (coalesce(col_description('public.order_requests'::regclass,
                 (select a.attnum from pg_attribute a where a.attrelid = 'public.order_requests'::regclass and a.attname = 'signature_data_url')), '')
      ~ '0393')::text,
  'true,true',
  'P4: the capture function and order_requests.signature_data_url say in their comments what 0393 does');
select is(
  (select string_agg(p.oid::regprocedure::text || '|' || md5(p.prosrc), E'\n' order by p.oid::regprocedure::text collate "C")
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('confirm_order_signature', 'confirm_physical_signature', 'resume_fulfillment', 'reopen_picking')),
  E'confirm_order_signature(uuid,text,text,text,text)|8afdbb68f11dd4e8dcff3283b42f3b13\n'
  'confirm_physical_signature(uuid,text)|f7a14a46d2c70f635c3da844c786ce67\n'
  'reopen_picking(uuid,text)|293ce0e76d195bb13105cfd1c067de82\n'
  'resume_fulfillment(uuid)|2e2d5aab1db5392250879bfa9ff4bccd',
  'P5: the frozen hand-over and reset bodies keep their md5 (the trigger does the move; no body changed)');

select * from finish();
rollback;
