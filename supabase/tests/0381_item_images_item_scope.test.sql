-- supabase/tests/0381_item_images_item_scope.test.sql
-- pgTAP proof for migration 0381: item photos (public.item_images rows and
-- the item-images bucket's objects) follow the item.
--
-- A storage signed URL, a download and a folder listing are all a SELECT on
-- storage.objects under the caller's role and claims (the Storage API runs
-- them exactly so), and an upload, overwrite or remove is an INSERT, UPDATE
-- or DELETE there, so these assertions are what the phone and the anon key
-- with a JWT can do.
--
-- R. Rows: each persona sees exactly the photo rows of the items it can read
--    (owner, admin, manager, all-warehouse auditor: all 7 of org A; staff of
--    warehouse A1: 5; charter-scoped staff: 4; category viewer: 4; warehouse
--    viewer: 5; staff of the annex only: 2; org B's manager: org B's 1;
--    disabled, pending, anon: 0), and never a row filed in another org naming
--    a readable item.
-- S. Objects, both path shapes ({org}/items/{item}/{file}, books import
--    {org}/{item}/{file}): each persona reads exactly the objects of items it
--    can read; a duplicated item's shared file is readable through the
--    duplicate's row even when its source item is not (charter-scoped
--    staff), master AND thumbnail, and not by a member who can read neither
--    the source nor the duplicate (the shared-file set answers per caller);
--    an object whose item no longer exists, a name in no photo shape and an
--    object in one org's folder naming another org's item are readable by
--    nobody's own client; the service role reads all.
-- W. Row writes: only for an item the caller can read and change, with paths
--    in the org's folder naming that item, or a path a photo row the caller
--    can read already carries (duplicate_inventory_item's shared file); never
--    a new path in another item's folder, another org's item or folder, an
--    unreadable item's object or a third shape; viewers (even one granted
--    items:update) never; update and delete of an unreadable item's row touch
--    0 rows; duplicate_inventory_item still copies photo rows, including a
--    duplicate of a duplicate whose source the caller cannot read or that is
--    gone, and such a row can still be reordered.
-- O. Object writes: upload, overwrite (the Storage API's upsert included) and
--    remove only in the folder of an item the caller can read and change, in
--    that item's own org folder, for both shapes; a name that is not a photo
--    shape (including a first folder that is not a uuid) is a plain refusal,
--    never a cast error.
-- C. Catalog: the policy set on both tables, no FOR ALL policy left on
--    item_images, the helpers are SECURITY INVOKER with a pinned search_path
--    and closed to anon, the path parser's answers, and the measured shapes
--    (pkey-probe org correlation, starts_with, the shared-file set scoped to
--    the caller's orgs with the read-scope sets inline, in step with
--    caller_can_read_item).
-- P. Cost: another org's shared-shape photo rows do not slow the caller's
--    reads (20,000 planted in org B; the per-row check made that ~4 s).
--
-- Fixtures as the test superuser; reads and writes as `authenticated` with
-- request.jwt.claim.sub. begin/rollback: nothing leaks. Namespace 03810000.

begin;

select plan(112);

\set orgA    03810000-0000-0000-0000-00000000000a
\set orgB    03810000-0000-0000-0000-00000000000b
\set own     03810000-0000-0000-0000-0000000000a0
\set adm     03810000-0000-0000-0000-0000000000a1
\set mgr     03810000-0000-0000-0000-0000000000a2
\set stf     03810000-0000-0000-0000-0000000000a3
\set stfC    03810000-0000-0000-0000-0000000000a4
\set vwrC    03810000-0000-0000-0000-0000000000a5
\set vwrW    03810000-0000-0000-0000-0000000000a6
\set aud     03810000-0000-0000-0000-0000000000a7
\set vwrUpd  03810000-0000-0000-0000-0000000000a8
\set dis     03810000-0000-0000-0000-0000000000a9
\set pend    03810000-0000-0000-0000-0000000000aa
\set stfA2   03810000-0000-0000-0000-0000000000ab
\set mgrB    03810000-0000-0000-0000-0000000000b1
\set whA1    03810000-0000-0000-0000-0000000000c1
\set whA2    03810000-0000-0000-0000-0000000000c2
\set whB     03810000-0000-0000-0000-0000000000c3
\set chA1    03810000-0000-0000-0000-0000000000d1
\set chA2    03810000-0000-0000-0000-0000000000d2
\set catIn   03810000-0000-0000-0000-000000000071
\set catOut  03810000-0000-0000-0000-000000000072
\set iIn     03810000-0000-0000-0000-000000000f01
\set iCat    03810000-0000-0000-0000-000000000f02
\set iWh     03810000-0000-0000-0000-000000000f03
\set iBook   03810000-0000-0000-0000-000000000f04
\set iBookIn 03810000-0000-0000-0000-000000000f05
\set iSrc    03810000-0000-0000-0000-000000000f06
\set iDup    03810000-0000-0000-0000-000000000f07
\set iB      03810000-0000-0000-0000-000000000f0b
\set iGhost  03810000-0000-0000-0000-000000000fee

-- ══ Helpers ══════════════════════════════════════════════════════════════
-- Run a query and return its single text value, or 'ERROR <sqlstate>' — so a
-- missing function on the pre-0381 schema is a red assertion, not an abort.
create function pg_temp.q(p_sql text) returns text language plpgsql as $$
declare r text;
begin
  execute p_sql into r;
  return r;
exception when others then
  return 'ERROR ' || sqlstate;
end $$;

-- Rows affected by a write, or 'ERROR <sqlstate>'.
create function pg_temp.n(p_sql text) returns text language plpgsql as $$
declare c int;
begin
  execute p_sql;
  get diagnostics c = row_count;
  return c::text;
exception when others then
  return 'ERROR ' || sqlstate;
end $$;

create function pg_temp.pa(p_org uuid, p_item uuid, p_file text) returns text language sql as $$
  select p_org::text || '/items/' || p_item::text || '/' || p_file $$;
create function pg_temp.pb(p_org uuid, p_item uuid) returns text language sql as $$
  select p_org::text || '/' || p_item::text || '/cover.png' $$;

-- Which fixture items' photo rows the current role sees, as a sorted list.
create function pg_temp.rows_seen() returns text language sql as $$
  select coalesce(string_agg(n, ' ' order by n), '(none)')
    from (select distinct case ii.item_id
                   when '03810000-0000-0000-0000-000000000f01' then 'in'
                   when '03810000-0000-0000-0000-000000000f02' then 'cat'
                   when '03810000-0000-0000-0000-000000000f03' then 'wh'
                   when '03810000-0000-0000-0000-000000000f04' then 'book'
                   when '03810000-0000-0000-0000-000000000f05' then 'bookin'
                   when '03810000-0000-0000-0000-000000000f06' then 'src'
                   when '03810000-0000-0000-0000-000000000f07' then 'dup'
                   when '03810000-0000-0000-0000-000000000f0b' then 'orgb'
                   else 'other' end as n
            from public.item_images ii
           where ii.item_id::text like '03810000-%') s $$;

-- Which fixture objects the current role can read (sign / download / list).
create function pg_temp.objects_seen() returns text language sql as $$
  select coalesce(string_agg(n, ' ' order by n), '(none)')
    from (select case
                   when o.name like '%/cover.png' and o.name like '%000000000f04/%' then 'book-cover'
                   when o.name like '%/cover.png' and o.name like '%000000000f05/%' then 'bookin-cover'
                   when o.name like '%/misc/%' then 'odd-shape'
                   when o.name like '%000000000fee/%' then 'ghost'
                   else regexp_replace(o.name, '^.*/', '') end as n
            from storage.objects o
           where o.bucket_id = 'item-images' and o.name like '0381%') s $$;

-- What the bucket read policy's SECURITY DEFINER shared-file set answers for
-- the current caller, as fixture file names ('ERROR <sqlstate>' if absent).
-- This is the one place in 0381 where RLS does not apply, so its per-caller
-- scope is pinned directly, not only through objects_seen().
create function pg_temp.shared_seen() returns text language plpgsql as $$
declare r text;
begin
  execute $q$select coalesce(string_agg(regexp_replace(x, '^.*/', ''), ' ' order by regexp_replace(x, '^.*/', '')), '(none)')
                from public.rls_item_image_shared_paths() x where x like '0381%'$q$ into r;
  return r;
exception when others then
  return 'ERROR ' || sqlstate;
end $$;

-- Wall-clock milliseconds a statement takes (its result is discarded); an
-- error counts as never finishing, so it is a red assertion, not an abort.
create function pg_temp.ms(p_sql text) returns int language plpgsql as $$
declare t0 timestamptz := clock_timestamp();
begin
  execute p_sql;
  return extract(epoch from (clock_timestamp() - t0)) * 1000;
exception when others then
  return 2147483647;
end $$;

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:'own', '0381-own@test.local', '{}'::jsonb),
  (:'adm', '0381-adm@test.local', '{}'::jsonb),
  (:'mgr', '0381-mgr@test.local', '{}'::jsonb),
  (:'stf', '0381-stf@test.local', '{}'::jsonb),
  (:'stfC', '0381-stfc@test.local', '{}'::jsonb),
  (:'vwrC', '0381-vwrc@test.local', '{}'::jsonb),
  (:'vwrW', '0381-vwrw@test.local', '{}'::jsonb),
  (:'aud', '0381-aud@test.local', '{}'::jsonb),
  (:'vwrUpd', '0381-vwrupd@test.local', '{}'::jsonb),
  (:'dis', '0381-dis@test.local', '{}'::jsonb),
  (:'pend', '0381-pend@test.local', '{}'::jsonb),
  (:'stfA2', '0381-stfa2@test.local', '{}'::jsonb),
  (:'mgrB', '0381-mgrb@test.local', '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:'orgA', '0381 Photos A', '0381-photos-a'),
  (:'orgB', '0381 Photos B', '0381-photos-b');
insert into public.organization_members (organization_id, user_id, role, accepted_at, all_warehouses) values
  (:'orgA', :'own',    'owner',   now(), false),
  (:'orgA', :'adm',    'admin',   now(), false),
  (:'orgA', :'mgr',    'manager', now(), false),
  (:'orgA', :'stf',    'staff',   now(), false),
  (:'orgA', :'stfC',   'staff',   now(), false),
  (:'orgA', :'vwrC',   'viewer',  now(), false),
  (:'orgA', :'vwrW',   'viewer',  now(), false),
  (:'orgA', :'aud',    'viewer',  now(), true),
  (:'orgA', :'vwrUpd', 'viewer',  now(), false),
  (:'orgA', :'dis',    'staff',   now(), false),
  (:'orgA', :'pend',   'staff',   null,  false),
  (:'orgA', :'stfA2',  'staff',   now(), false),
  (:'orgB', :'mgrB',   'manager', now(), false);
update public.user_profiles set disabled_at = now() where id = :'dis';
insert into public.warehouses (id, organization_id, name, code, status) values
  (:'whA1', :'orgA', '0381 Main',  'WH-0381A1', 'active'),
  (:'whA2', :'orgA', '0381 Annex', 'WH-0381A2', 'active'),
  (:'whB',  :'orgB', '0381 Other', 'WH-0381B',  'active');
insert into public.charters (id, organization_id, name) values
  (:'chA1', :'orgA', '0381 Charter One'),
  (:'chA2', :'orgA', '0381 Charter Two');
insert into public.warehouse_charters (organization_id, warehouse_id, charter_id) values
  (:'orgA', :'whA1', :'chA1'),
  (:'orgA', :'whA1', :'chA2')
  on conflict do nothing;
insert into public.categories (id, organization_id, name) values
  (:'catIn',  :'orgA', '0381 In'),
  (:'catOut', :'orgA', '0381 Out');
-- The all-warehouses trigger (0280) may already have assigned the auditor.
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary, charter_id)
select v.org, v.usr, v.wh, v.prim, v.ch
  from (values
    (:'orgA'::uuid, :'stf'::uuid,    :'whA1'::uuid, true,  null::uuid),
    (:'orgA'::uuid, :'stfC'::uuid,   :'whA1'::uuid, true,  :'chA1'::uuid),
    (:'orgA'::uuid, :'vwrC'::uuid,   :'whA1'::uuid, true,  null::uuid),
    (:'orgA'::uuid, :'vwrW'::uuid,   :'whA1'::uuid, true,  null::uuid),
    (:'orgA'::uuid, :'aud'::uuid,    :'whA1'::uuid, true,  null::uuid),
    (:'orgA'::uuid, :'aud'::uuid,    :'whA2'::uuid, false, null::uuid),
    (:'orgA'::uuid, :'vwrUpd'::uuid, :'whA1'::uuid, true,  null::uuid),
    (:'orgA'::uuid, :'dis'::uuid,    :'whA1'::uuid, true,  null::uuid),
    (:'orgA'::uuid, :'pend'::uuid,   :'whA1'::uuid, true,  null::uuid),
    (:'orgA'::uuid, :'stfA2'::uuid,  :'whA2'::uuid, true,  null::uuid)) v(org, usr, wh, prim, ch)
 where not exists (select 1 from public.user_warehouse_assignments u
                    where u.user_id = v.usr and u.warehouse_id = v.wh
                      and u.charter_id is not distinct from v.ch);
insert into public.user_category_assignments (organization_id, user_id, category_id) values
  (:'orgA', :'vwrC', :'catIn');
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:'orgA', :'vwrUpd', 'items:update', true);
insert into public.inventory_items (id, organization_id, warehouse_id, charter_id, category_id, sku, name, status, item_type) values
  (:'iIn',     :'orgA', :'whA1', null,     :'catIn',  '0381-IN',     '0381 in scope',          'active', 'product'),
  (:'iCat',    :'orgA', :'whA1', null,     :'catOut', '0381-CAT',    '0381 other category',    'active', 'product'),
  (:'iWh',     :'orgA', :'whA2', null,     :'catIn',  '0381-WH',     '0381 other warehouse',   'active', 'product'),
  (:'iBook',   :'orgA', :'whA2', null,     :'catIn',  '0381-BOOK',   '0381 book, annex',       'active', 'book'),
  (:'iBookIn', :'orgA', :'whA1', null,     :'catIn',  '0381-BOOKIN', '0381 book, main',        'active', 'book'),
  (:'iSrc',    :'orgA', :'whA1', :'chA2',  :'catIn',  '0381-SRC',    '0381 duplicate source',  'active', 'product'),
  (:'iDup',    :'orgA', :'whA1', :'chA1',  :'catIn',  '0381-DUP',    '0381 duplicate',         'active', 'product'),
  (:'iB',      :'orgB', :'whB',  null,     null,      '0381-B',      '0381 org B item',        'active', 'product');
insert into public.item_images (organization_id, item_id, storage_path, thumb_path, is_primary, sort_order) values
  (:'orgA', :'iIn',     pg_temp.pa(:'orgA', :'iIn',  'm1.png'), pg_temp.pa(:'orgA', :'iIn', 'm1-thumb.webp'), true, 0),
  (:'orgA', :'iCat',    pg_temp.pa(:'orgA', :'iCat', 'm2.png'), null, true, 0),
  (:'orgA', :'iWh',     pg_temp.pa(:'orgA', :'iWh',  'm3.png'), pg_temp.pa(:'orgA', :'iWh', 'm3-thumb.webp'), true, 0),
  (:'orgA', :'iBook',   pg_temp.pb(:'orgA', :'iBook'),   null, true, 0),
  (:'orgA', :'iBookIn', pg_temp.pb(:'orgA', :'iBookIn'), null, true, 0),
  (:'orgA', :'iSrc',    pg_temp.pa(:'orgA', :'iSrc', 'm6.png'), pg_temp.pa(:'orgA', :'iSrc', 'm6-thumb.webp'), true, 0),
  -- duplicate_inventory_item's shape: the copy names the SOURCE's files,
  -- master and thumbnail (it copies both columns).
  (:'orgA', :'iDup',    pg_temp.pa(:'orgA', :'iSrc', 'm6.png'), pg_temp.pa(:'orgA', :'iSrc', 'm6-thumb.webp'), true, 0),
  (:'orgB', :'iB',      pg_temp.pa(:'orgB', :'iB',   'm9.png'), null, true, 0),
  -- A row filed in org B naming org A's item (the pre-0381 write policy
  -- allowed it; nothing in the table forbids it): readable by nobody's own
  -- client, even one who reads iIn.
  (:'orgB', :'iIn',     pg_temp.pa(:'orgB', :'iIn',  'cross.png'), null, false, 0);
insert into storage.objects (bucket_id, name) values
  ('item-images', pg_temp.pa(:'orgA', :'iIn',  'm1.png')),
  ('item-images', pg_temp.pa(:'orgA', :'iIn',  'm1-thumb.webp')),
  ('item-images', pg_temp.pa(:'orgA', :'iCat', 'm2.png')),
  ('item-images', pg_temp.pa(:'orgA', :'iWh',  'm3.png')),
  ('item-images', pg_temp.pa(:'orgA', :'iWh',  'm3-thumb.webp')),
  ('item-images', pg_temp.pb(:'orgA', :'iBook')),
  ('item-images', pg_temp.pb(:'orgA', :'iBookIn')),
  ('item-images', pg_temp.pa(:'orgA', :'iSrc', 'm6.png')),
  ('item-images', pg_temp.pa(:'orgA', :'iSrc', 'm6-thumb.webp')),
  ('item-images', pg_temp.pa(:'orgB', :'iB',   'm9.png')),
  -- An object in org B's folder naming org A's item iIn: the path's org
  -- folder must be its item's org, for reads as for writes.
  ('item-images', pg_temp.pa(:'orgB', :'iIn',  'cross.png')),
  -- An object whose item was hard-deleted and that no row names, and a name
  -- in no photo shape: org members could read both before 0381.
  ('item-images', pg_temp.pa(:'orgA', :'iGhost', 'gone.png')),
  ('item-images', :'orgA' || '/misc/' || :'iIn' || '/odd.png');

-- ══ R + S: reads, per persona ═════════════════════════════════════════════
set local role authenticated;

set local "request.jwt.claim.sub" to :'own';
select is(pg_temp.rows_seen(), 'book bookin cat dup in src wh', 'R1: owner sees every photo row of org A (as before)');
select is(pg_temp.q(format($$select count(*)::text from public.item_images where organization_id = %L$$, :'orgB')), '0',
  'R15: a row filed in another org naming a readable item stays invisible (the org correlation holds)');
select is(pg_temp.objects_seen(), 'book-cover bookin-cover m1-thumb.webp m1.png m2.png m3-thumb.webp m3.png m6-thumb.webp m6.png',
  'S1: owner reads every photo object of org A, both shapes; not the ghost object or the odd-shaped name');

set local "request.jwt.claim.sub" to :'adm';
select is(pg_temp.rows_seen(), 'book bookin cat dup in src wh', 'R2: admin sees every photo row of org A');
select is(pg_temp.objects_seen(), 'book-cover bookin-cover m1-thumb.webp m1.png m2.png m3-thumb.webp m3.png m6-thumb.webp m6.png',
  'S2: admin reads every photo object of org A');

set local "request.jwt.claim.sub" to :'mgr';
select is(pg_temp.rows_seen(), 'book bookin cat dup in src wh', 'R3: manager sees every photo row of org A');
select is(pg_temp.objects_seen(), 'book-cover bookin-cover m1-thumb.webp m1.png m2.png m3-thumb.webp m3.png m6-thumb.webp m6.png',
  'S3: manager reads every photo object of org A');

set local "request.jwt.claim.sub" to :'aud';
select is(pg_temp.rows_seen(), 'book bookin cat dup in src wh', 'R4: an all-warehouse auditor (viewer) sees every photo row');
select is(pg_temp.objects_seen(), 'book-cover bookin-cover m1-thumb.webp m1.png m2.png m3-thumb.webp m3.png m6-thumb.webp m6.png',
  'S4: an all-warehouse auditor reads every photo object');

set local "request.jwt.claim.sub" to :'stf';
select is(pg_temp.rows_seen(), 'bookin cat dup in src', 'R5: staff of Main see Main''s photo rows only (not the annex item or book)');
select is(pg_temp.objects_seen(), 'bookin-cover m1-thumb.webp m1.png m2.png m6-thumb.webp m6.png',
  'S5: staff of Main read Main''s objects only, both shapes (not the annex photo, thumb or book cover)');
select is(pg_temp.q(format($$select count(*)::text from storage.objects where bucket_id = 'item-images' and name = %L$$,
                           pg_temp.pa(:'orgA', :'iWh', 'm3.png'))), '0',
  'S6: staff of Main cannot sign the annex item''s photo (the Storage API''s sign lookup finds no row)');
select is(pg_temp.q(format($$select count(*)::text from storage.objects where bucket_id = 'item-images' and name = %L$$,
                           pg_temp.pb(:'orgA', :'iBook'))), '0',
  'S7: staff of Main cannot sign the annex book''s cover (books-import shape)');

set local "request.jwt.claim.sub" to :'stfC';
select is(pg_temp.rows_seen(), 'bookin cat dup in', 'R6: charter-scoped staff see Main''s no-charter rows and their charter''s duplicate, not the other charter''s source');
select is(pg_temp.objects_seen(), 'bookin-cover m1-thumb.webp m1.png m2.png m6-thumb.webp m6.png',
  'S8: charter-scoped staff read the duplicate''s shared file, master AND thumbnail (named by a row they can read), though its source item is out of scope');
select is(pg_temp.shared_seen(), 'm6-thumb.webp m6.png',
  'S16: the shared-file set answers the duplicate''s master and thumbnail for charter-scoped staff');

set local "request.jwt.claim.sub" to :'stfA2';
select is(pg_temp.rows_seen(), 'book wh', 'R14: staff of the annex only see the annex rows (not the duplicate or its source)');
select is(pg_temp.objects_seen(), 'book-cover m3-thumb.webp m3.png',
  'S17: staff of the annex only read the annex objects: not the duplicate''s shared file, master or thumbnail');
select is(pg_temp.q(format($$select count(*)::text from storage.objects where bucket_id = 'item-images' and name in (%L, %L)$$,
                           pg_temp.pa(:'orgA', :'iSrc', 'm6.png'), pg_temp.pa(:'orgA', :'iSrc', 'm6-thumb.webp'))), '0',
  'S18: ... nor sign them (a member who reads neither the source nor the duplicate)');
select is(pg_temp.shared_seen(), '(none)',
  'S19: the shared-file set answers nothing for a member who reads neither the source nor the duplicate');

set local "request.jwt.claim.sub" to :'vwrC';
select is(pg_temp.rows_seen(), 'bookin dup in src', 'R7: a category-scoped viewer sees only their category''s rows');
select is(pg_temp.objects_seen(), 'bookin-cover m1-thumb.webp m1.png m6-thumb.webp m6.png',
  'S9: a category-scoped viewer reads only their category''s objects');

set local "request.jwt.claim.sub" to :'vwrW';
select is(pg_temp.rows_seen(), 'bookin cat dup in src', 'R8: a warehouse viewer sees their warehouse''s rows');
select is(pg_temp.objects_seen(), 'bookin-cover m1-thumb.webp m1.png m2.png m6-thumb.webp m6.png',
  'S10: a warehouse viewer reads their warehouse''s objects');

set local "request.jwt.claim.sub" to :'mgrB';
select is(pg_temp.rows_seen(), 'orgb', 'R9: another org''s manager sees only their own org''s row');
select is(pg_temp.objects_seen(), 'm9.png', 'S11: another org''s manager reads only their own org''s object (not an object in their folder naming org A''s item)');
select is(pg_temp.shared_seen(), '(none)', 'S20: the shared-file set answers nothing of org A for another org''s manager');

set local "request.jwt.claim.sub" to :'dis';
select is(pg_temp.rows_seen(), '(none)', 'R10: a disabled account sees no photo row');
select is(pg_temp.objects_seen(), '(none)', 'S12: a disabled account reads no object');

set local "request.jwt.claim.sub" to :'pend';
select is(pg_temp.rows_seen(), '(none)', 'R11: a pending invite sees no photo row');
select is(pg_temp.objects_seen(), '(none)', 'S13: a pending invite reads no object');

reset role;
set local role anon;
set local "request.jwt.claim.sub" to '';
select is(pg_temp.q($$select count(*)::text from public.item_images where item_id::text like '03810000-%'$$) in ('0', 'ERROR 42501'), true,
  'R12: anon reads no photo row');
select is(pg_temp.q($$select count(*)::text from storage.objects where bucket_id = 'item-images' and name like '0381%'$$) in ('0', 'ERROR 42501'), true,
  'S14: anon reads no object');
reset role;
set local role service_role;
select is(pg_temp.q($$select count(*)::text from storage.objects where bucket_id = 'item-images' and name like '0381%'$$), '13',
  'S15: the service role (web signing, /r, /p/items, exports) still reads every object');
select is(pg_temp.q($$select count(*)::text from public.item_images where item_id::text like '03810000-%'$$), '9',
  'R13: the service role still reads every photo row');
reset role;

-- ══ W: row writes ════════════════════════════════════════════════════════
set local role authenticated;
set local "request.jwt.claim.sub" to :'stf';
select is(pg_temp.n(format($$insert into public.item_images (organization_id, item_id, storage_path, thumb_path) values (%L, %L, %L, %L)$$,
                           :'orgA', :'iIn', pg_temp.pa(:'orgA', :'iIn', 'w1.jpg'), pg_temp.pa(:'orgA', :'iIn', 'w1-thumb.webp'))), '1',
  'W1: staff add a photo row (with thumb) to an item they can change');
select is(pg_temp.n(format($$insert into public.item_images (organization_id, item_id, storage_path) values (%L, %L, %L)$$,
                           :'orgA', :'iBookIn', pg_temp.pb(:'orgA', :'iBookIn'))), '1',
  'W2: staff add a books-import-shape row to an item they can change');
select is(pg_temp.n(format($$insert into public.item_images (organization_id, item_id, storage_path) values (%L, %L, %L)$$,
                           :'orgA', :'iIn', pg_temp.pa(:'orgA', :'iCat', 'm2.png'))), '1',
  'W3: a row may name a file a READABLE photo row of the org carries (duplicate_inventory_item''s shape)');
select is(pg_temp.n(format($$insert into public.item_images (organization_id, item_id, storage_path) values (%L, %L, %L)$$,
                           :'orgA', :'iIn', pg_temp.pa(:'orgA', :'iCat', 'future.png'))), 'ERROR 42501',
  'W28: ... but not a new name in another item''s folder, even a readable one''s (no alias to a file no row carries yet)');
select is(pg_temp.n(format($$insert into public.item_images (organization_id, item_id, storage_path) values (%L, %L, %L)$$,
                           :'orgA', :'iIn', :'orgA' || '/' || :'iBookIn' || '/cover.jpg')), 'ERROR 42501',
  'W29: ... nor a books-import cover name of another item that no row carries (rehostCover overwrites that name in place)');
select is(pg_temp.n(format($$insert into public.item_images (organization_id, item_id, storage_path) values (%L, %L, %L)$$,
                           :'orgA', :'iWh', pg_temp.pa(:'orgA', :'iWh', 'w4.jpg'))), 'ERROR 42501',
  'W4: staff cannot add a photo row to another warehouse''s item');
select is(pg_temp.n(format($$insert into public.item_images (organization_id, item_id, storage_path) values (%L, %L, %L)$$,
                           :'orgA', :'iIn', pg_temp.pa(:'orgA', :'iWh', 'm3.png'))), 'ERROR 42501',
  'W5: staff cannot point their own item''s row at another warehouse''s photo');
select is(pg_temp.n(format($$insert into public.item_images (organization_id, item_id, storage_path, thumb_path) values (%L, %L, %L, %L)$$,
                           :'orgA', :'iIn', pg_temp.pa(:'orgA', :'iIn', 'w6.jpg'), pg_temp.pa(:'orgA', :'iWh', 'm3-thumb.webp'))), 'ERROR 42501',
  'W6: ... nor its THUMB at another warehouse''s thumbnail');
select is(pg_temp.n(format($$insert into public.item_images (organization_id, item_id, storage_path) values (%L, %L, %L)$$,
                           :'orgA', :'iB', pg_temp.pa(:'orgB', :'iB', 'm9.png'))), 'ERROR 42501',
  'W7: staff cannot file a row in their org naming ANOTHER org''s item and object');
select is(pg_temp.n(format($$insert into public.item_images (organization_id, item_id, storage_path) values (%L, %L, %L)$$,
                           :'orgA', :'iIn', pg_temp.pa(:'orgB', :'iIn', 'w8.jpg'))), 'ERROR 42501',
  'W8: a row''s path must sit in the row''s own org folder');
select is(pg_temp.n(format($$insert into public.item_images (organization_id, item_id, storage_path) values (%L, %L, %L)$$,
                           :'orgA', :'iIn', :'orgA' || '/misc/' || :'iIn' || '/w9.jpg')), 'ERROR 42501',
  'W9: a path in no photo shape is refused');
select is(pg_temp.n(format($$update public.item_images set alt = 'x' where item_id = %L$$, :'iWh')), '0',
  'W10: staff update 0 rows of another warehouse''s item');
select is(pg_temp.n(format($$update public.item_images set storage_path = %L where item_id = %L$$,
                           pg_temp.pa(:'orgA', :'iWh', 'm3.png'), :'iIn')), 'ERROR 42501',
  'W11: staff cannot repoint their own item''s row at another warehouse''s photo');
select is(pg_temp.n(format($$update public.item_images set alt = 'mine', sort_order = 3 where item_id = %L$$, :'iCat')), '1',
  'W12: staff can reorder/edit a row of an item they can change');
select is(pg_temp.n(format($$delete from public.item_images where item_id = %L$$, :'iWh')), '0',
  'W13: staff delete 0 rows of another warehouse''s item');
select is(pg_temp.n(format($$delete from public.item_images where item_id = %L and storage_path = %L$$,
                           :'iIn', pg_temp.pa(:'orgA', :'iCat', 'm2.png'))), '1',
  'W14: staff can delete a row of an item they can change');
select is(pg_temp.q(format($$select public.duplicate_inventory_item(%L, '{"sku": "0381-IN-COPY"}'::jsonb) is not null$$, :'iIn')), 'true',
  'W15: duplicate_inventory_item (SECURITY INVOKER) still copies an item that has photos');
reset role;
select is((select count(*)::int from public.item_images ii join public.inventory_items i on i.id = ii.item_id
            where i.sku = '0381-IN-COPY' and ii.storage_path like '%' || :'iIn' || '/%'), 2,
  'W16: ... and its photo rows, naming the source''s files');
select is((select count(*)::int from public.item_images where item_id = :'iWh'), 1,
  'W17: the other warehouse''s row is untouched');

set local role authenticated;
set local "request.jwt.claim.sub" to :'stfC';
select is(pg_temp.n(format($$insert into public.item_images (organization_id, item_id, storage_path) values (%L, %L, %L)$$,
                           :'orgA', :'iDup', pg_temp.pa(:'orgA', :'iSrc', 'w18.png'))), 'ERROR 42501',
  'W18: charter-scoped staff cannot name a new file in the out-of-charter source''s folder (no readable row carries it)');
select is(pg_temp.n(format($$update public.item_images set sort_order = sort_order + 1, is_primary = true where item_id = %L$$, :'iDup')), '1',
  'W30: charter-scoped staff can reorder their duplicate''s row, whose files are the out-of-charter source''s');
select is(pg_temp.q(format($$select public.duplicate_inventory_item(%L, '{"sku": "0381-DUP-COPY"}'::jsonb) is not null$$, :'iDup')), 'true',
  'W31: charter-scoped staff can duplicate that duplicate (its rows carry the source''s files)');
select is(pg_temp.n(format($$insert into public.item_images (organization_id, item_id, storage_path, thumb_path) values (%L, %L, %L, %L)$$,
                           :'orgA', :'iDup', pg_temp.pa(:'orgA', :'iSrc', 'm6.png'), pg_temp.pa(:'orgA', :'iSrc', 'm6-thumb.webp'))), '1',
  'W32: ... and add a row naming the files a row they can read already carries (nothing they cannot already read)');
select is(pg_temp.n(format($$insert into public.item_images (organization_id, item_id, storage_path) values (%L, %L, %L)$$,
                           :'orgA', :'iSrc', pg_temp.pa(:'orgA', :'iSrc', 'w19.jpg'))), 'ERROR 42501',
  'W19: charter-scoped staff cannot add a row to another charter''s item');

reset role;
select is((select count(*)::int from public.item_images ii join public.inventory_items i on i.id = ii.item_id
            where i.sku = '0381-DUP-COPY'
              and ii.storage_path = pg_temp.pa(:'orgA', :'iSrc', 'm6.png')
              and ii.thumb_path = pg_temp.pa(:'orgA', :'iSrc', 'm6-thumb.webp')), 1,
  'W33: the duplicate''s copy carries the source''s master and thumbnail');

-- The source is gone (hard-deleted; its own row cascades): the duplicate's
-- row still carries the file, and duplicating the duplicate still works.
savepoint src_gone;
delete from public.inventory_items where id = :'iSrc';
set local role authenticated;
set local "request.jwt.claim.sub" to :'own';
select is(pg_temp.q(format($$select public.duplicate_inventory_item(%L, '{"sku": "0381-DUP-COPY-2"}'::jsonb) is not null$$, :'iDup')), 'true',
  'W34: the owner can duplicate a duplicate whose source item was deleted');
reset role;
rollback to savepoint src_gone;

set local role authenticated;
set local "request.jwt.claim.sub" to :'mgr';
select is(pg_temp.n(format($$insert into public.item_images (organization_id, item_id, storage_path) values (%L, %L, %L)$$,
                           :'orgA', :'iWh', pg_temp.pa(:'orgA', :'iWh', 'w20.jpg'))), '1',
  'W20: a manager adds photos to any item of the org');
select is(pg_temp.n(format($$update public.item_images set sort_order = 1 where item_id = %L and storage_path = %L$$,
                           :'iWh', pg_temp.pa(:'orgA', :'iWh', 'w20.jpg'))), '1',
  'W21: a manager edits any item''s rows');

set local "request.jwt.claim.sub" to :'vwrW';
select is(pg_temp.n(format($$insert into public.item_images (organization_id, item_id, storage_path) values (%L, %L, %L)$$,
                           :'orgA', :'iIn', pg_temp.pa(:'orgA', :'iIn', 'w22.jpg'))), 'ERROR 42501',
  'W22: a viewer cannot add photo rows, even to an item they can read');
select is(pg_temp.n(format($$delete from public.item_images where item_id = %L$$, :'iIn')), '0',
  'W23: a viewer deletes 0 rows');

set local "request.jwt.claim.sub" to :'vwrUpd';
select is(pg_temp.n(format($$insert into public.item_images (organization_id, item_id, storage_path) values (%L, %L, %L)$$,
                           :'orgA', :'iIn', pg_temp.pa(:'orgA', :'iIn', 'w24.jpg'))), 'ERROR 42501',
  'W24: a viewer granted items:update still cannot (no warehouse write access), as for the item itself');

set local "request.jwt.claim.sub" to :'mgrB';
select is(pg_temp.n(format($$insert into public.item_images (organization_id, item_id, storage_path) values (%L, %L, %L)$$,
                           :'orgA', :'iIn', pg_temp.pa(:'orgA', :'iIn', 'w25.jpg'))), 'ERROR 42501',
  'W25: another org''s manager cannot add rows to org A''s items');
select is(pg_temp.n(format($$insert into public.item_images (organization_id, item_id, storage_path) values (%L, %L, %L)$$,
                           :'orgB', :'iB', pg_temp.pa(:'orgA', :'iIn', 'm1.png'))), 'ERROR 42501',
  'W26: ... nor point their own item''s row at org A''s photo');

set local "request.jwt.claim.sub" to :'dis';
select is(pg_temp.n(format($$insert into public.item_images (organization_id, item_id, storage_path) values (%L, %L, %L)$$,
                           :'orgA', :'iIn', pg_temp.pa(:'orgA', :'iIn', 'w27.jpg'))), 'ERROR 42501',
  'W27: a disabled account cannot add rows');
reset role;

-- ══ O: object writes ═════════════════════════════════════════════════════
set local role authenticated;
set local "request.jwt.claim.sub" to :'stf';
select is(pg_temp.n(format($$insert into storage.objects (bucket_id, name) values ('item-images', %L)$$,
                           pg_temp.pa(:'orgA', :'iIn', 'o1.jpg'))), '1',
  'O1: staff upload into the folder of an item they can change (web presign and phone upload)');
select is(pg_temp.n(format($$insert into storage.objects (bucket_id, name) values ('item-images', %L)$$,
                           :'orgA' || '/' || :'iBookIn' || '/cover.jpg')), '1',
  'O2: ... and the books-import cover shape');
select is(pg_temp.n(format($$insert into storage.objects (bucket_id, name) values ('item-images', %L)$$,
                           pg_temp.pa(:'orgA', :'iWh', 'o3.jpg'))), 'ERROR 42501',
  'O3: staff cannot upload into another warehouse''s item folder');
select is(pg_temp.n(format($$insert into storage.objects (bucket_id, name) values ('item-images', %L)$$,
                           :'orgA' || '/' || :'iBook' || '/cover.jpg')), 'ERROR 42501',
  'O4: ... nor a books-shape cover for another warehouse''s book');
select is(pg_temp.n(format($$insert into storage.objects (bucket_id, name) values ('item-images', %L)$$,
                           pg_temp.pa(:'orgB', :'iB', 'o5.jpg'))), 'ERROR 42501',
  'O5: ... nor into another org''s folder');
select is(pg_temp.n(format($$insert into storage.objects (bucket_id, name) values ('item-images', %L)$$,
                           pg_temp.pa(:'orgA', :'iGhost', 'o6.jpg'))), 'ERROR 42501',
  'O6: ... nor into the folder of an item that does not exist');
select is(pg_temp.n(format($$insert into storage.objects (bucket_id, name) values ('item-images', %L)$$,
                           :'orgA' || '/items/' || :'iIn' || '/x/o7.jpg')), 'ERROR 42501',
  'O7: ... nor a nested folder under a writable item');
select is(pg_temp.n($$insert into storage.objects (bucket_id, name) values ('item-images', 'not-a-uuid/items/x/o8.jpg')$$), 'ERROR 42501',
  'O8: a first folder that is not a uuid is a plain refusal, not a cast error');
select is(pg_temp.n(format($$insert into storage.objects (bucket_id, name) values ('item-images', %L)$$,
                           upper(pg_temp.pa(:'orgA', :'iIn', 'o9.jpg')))), 'ERROR 42501',
  'O9: an uppercased path names no item');
select is(pg_temp.n(format($$update storage.objects set metadata = '{"x":1}'::jsonb where bucket_id = 'item-images' and name = %L$$,
                           pg_temp.pa(:'orgA', :'iWh', 'm3.png'))), '0',
  'O10: staff overwrite 0 objects of another warehouse''s item');
select is(pg_temp.n(format($$update storage.objects set metadata = '{"x":1}'::jsonb where bucket_id = 'item-images' and name = %L$$,
                           pg_temp.pa(:'orgA', :'iIn', 'm1.png'))), '1',
  'O11: staff overwrite their own item''s object (upsert)');
select is(pg_temp.n(format($$update storage.objects set name = %L where bucket_id = 'item-images' and name = %L$$,
                           pg_temp.pa(:'orgA', :'iWh', 'moved.png'), pg_temp.pa(:'orgA', :'iIn', 'o1.jpg'))), 'ERROR 42501',
  'O12: staff cannot move their own object into another warehouse''s item folder');
select is(pg_temp.n(format($$insert into storage.objects (bucket_id, name) values ('item-images', %L)$$,
                           pg_temp.pa(:'orgB', :'iIn', 'o21.jpg'))), 'ERROR 42501',
  'O21: staff cannot upload into ANOTHER org''s folder under their own writable item''s id');
select is(pg_temp.n(format($$insert into storage.objects (bucket_id, name) values ('item-images', %L)$$,
                           :'orgB' || '/' || :'iIn' || '/cover.jpg')), 'ERROR 42501',
  'O22: ... nor the books-import shape there');
select is(pg_temp.n(format($$update storage.objects set name = %L where bucket_id = 'item-images' and name = %L$$,
                           pg_temp.pa(:'orgB', :'iIn', 'moved.png'), pg_temp.pa(:'orgA', :'iIn', 'm1-thumb.webp'))), 'ERROR 42501',
  'O23: ... nor move their own object into another org''s folder');
select is(pg_temp.q(format($$insert into storage.objects (bucket_id, name) values ('item-images', %L)
                              on conflict (bucket_id, name) do update set metadata = '{"upsert":1}'::jsonb returning name$$,
                           pg_temp.pb(:'orgA', :'iBookIn'))), pg_temp.pb(:'orgA', :'iBookIn'),
  'O24: the books cover rehost''s upsert (INSERT .. ON CONFLICT DO UPDATE .. RETURNING) works for an item staff can change');
select is(pg_temp.q(format($$insert into storage.objects (bucket_id, name) values ('item-images', %L)
                              on conflict (bucket_id, name) do update set metadata = '{"upsert":1}'::jsonb returning name$$,
                           pg_temp.pb(:'orgA', :'iBook'))), 'ERROR 42501',
  'O25: ... and is refused for another warehouse''s book');
select set_config('storage.allow_delete_query', 'true', true);
select is(pg_temp.n(format($$delete from storage.objects where bucket_id = 'item-images' and name = %L$$,
                           pg_temp.pa(:'orgA', :'iWh', 'm3.png'))), '0',
  'O13: staff remove 0 objects of another warehouse''s item');
select is(pg_temp.n(format($$delete from storage.objects where bucket_id = 'item-images' and name = %L$$,
                           pg_temp.pb(:'orgA', :'iBook'))), '0',
  'O14: ... nor another warehouse''s book cover');
select is(pg_temp.n(format($$delete from storage.objects where bucket_id = 'item-images' and name = %L$$,
                           pg_temp.pa(:'orgA', :'iIn', 'o1.jpg'))), '1',
  'O15: staff remove their own item''s object (replace / delete photo)');
select set_config('storage.allow_delete_query', 'false', true);

set local "request.jwt.claim.sub" to :'vwrW';
select is(pg_temp.n(format($$insert into storage.objects (bucket_id, name) values ('item-images', %L)$$,
                           pg_temp.pa(:'orgA', :'iIn', 'o16.jpg'))), 'ERROR 42501',
  'O16: a viewer cannot upload, even into a readable item''s folder');

set local "request.jwt.claim.sub" to :'mgr';
select is(pg_temp.n(format($$insert into storage.objects (bucket_id, name) values ('item-images', %L)$$,
                           pg_temp.pa(:'orgA', :'iWh', 'o17.jpg'))), '1',
  'O17: a manager uploads into any item folder of the org');
select is(pg_temp.n(format($$insert into storage.objects (bucket_id, name) values ('item-images', %L)$$,
                           :'orgA' || '/' || :'iBook' || '/cover.jpg')), '1',
  'O18: ... including the books-import shape');

set local "request.jwt.claim.sub" to :'mgrB';
select is(pg_temp.n(format($$insert into storage.objects (bucket_id, name) values ('item-images', %L)$$,
                           pg_temp.pa(:'orgA', :'iIn', 'o19.jpg'))), 'ERROR 42501',
  'O19: another org''s manager cannot upload into org A''s folder');
select set_config('storage.allow_delete_query', 'true', true);
select is(pg_temp.n(format($$delete from storage.objects where bucket_id = 'item-images' and name = %L$$,
                           pg_temp.pa(:'orgA', :'iIn', 'm1.png'))), '0',
  'O20: ... nor remove org A''s objects');
select set_config('storage.allow_delete_query', 'false', true);
reset role;

-- ══ C: catalog ═══════════════════════════════════════════════════════════
select is(
  (select string_agg(policyname || ':' || cmd, ' ' order by policyname) from pg_policies
    where schemaname = 'public' and tablename = 'item_images'),
  'item_images_delete:DELETE item_images_insert:INSERT item_images_select:SELECT item_images_update:UPDATE',
  'C1: item_images has one policy per command and no FOR ALL policy (a FOR ALL USING also grants reads)');
select is(
  (select string_agg(policyname || ':' || cmd, ' ' order by policyname) from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and (coalesce(qual, '') || coalesce(with_check, '')) like '%item-images%'),
  'item-images authenticated read:SELECT item-images staff delete:DELETE item-images staff update:UPDATE item-images staff write:INSERT',
  'C2: the bucket keeps its four policies, by name');
select is(
  (select count(*)::int from pg_policies
    where (schemaname, tablename) in (('public', 'item_images'), ('storage', 'objects'))
      and (coalesce(qual, '') || coalesce(with_check, '')) ~ '(item_images|item-images)'
      and (coalesce(qual, '') || coalesce(with_check, '')) ~ 'is_org_member'),
  0,
  'C3: no item photo policy is org-member wide any more');
select is(
  (select count(*)::int from pg_policies
    where (schemaname, tablename) in (('public', 'item_images'), ('storage', 'objects'))
      and (coalesce(qual, '') || coalesce(with_check, '')) ~ '(item_images|item-images)'
      and not (roles = array['authenticated']::name[])),
  0,
  'C4: every item photo policy is TO authenticated only');
select is(
  pg_temp.q($$select string_agg(p.proname || ':' || p.prosecdef::text || ':' ||
                  coalesce((select c from unnest(p.proconfig) c where c like 'search_path=%'), 'unpinned') || ':' ||
                  has_function_privilege('anon', p.oid, 'execute')::text || ':' ||
                  has_function_privilege('authenticated', p.oid, 'execute')::text, ' ' order by p.proname)
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname like 'item\_image\_%'$$),
  'item_image_item_writable:false:search_path=public:false:true item_image_path_item_id:false:search_path=public:false:true '
  || 'item_image_path_org_id:false:search_path=public:false:true item_image_row_path_ok:false:search_path=public:false:true',
  'C5: the four helpers are SECURITY INVOKER, pin search_path, and are closed to anon');
select is(pg_temp.q(format($$select public.item_image_path_item_id(%L)::text$$, pg_temp.pa(:'orgA', :'iIn', 'a.png'))), :'iIn',
  'C6: parse {org}/items/{item}/{file}');
select is(pg_temp.q(format($$select public.item_image_path_item_id(%L)::text$$, pg_temp.pb(:'orgA', :'iBook'))), :'iBook',
  'C7: parse the books-import {org}/{item}/{file}');
select is(pg_temp.q(format($$select public.item_image_path_org_id(%L)::text$$, pg_temp.pb(:'orgA', :'iBook'))), :'orgA',
  'C8: the org of a valid photo path is its first folder');
select is(pg_temp.q(format($$select coalesce(public.item_image_path_item_id(%L)::text, 'null') || '|' ||
                                     coalesce(public.item_image_path_item_id(%L)::text, 'null') || '|' ||
                                     coalesce(public.item_image_path_item_id(%L)::text, 'null') || '|' ||
                                     coalesce(public.item_image_path_item_id(%L)::text, 'null') || '|' ||
                                     coalesce(public.item_image_path_item_id(null)::text, 'null') || '|' ||
                                     coalesce(public.item_image_path_org_id('x/y/z.png')::text, 'null')$$,
                           :'orgA' || '/items/' || :'iIn' || '/../' || :'iWh' || '/a.png',
                           :'orgA' || '/items/' || :'iIn' || '/sub/a.png',
                           :'orgA' || '/items/' || :'iIn' || '/a%2e.png',
                           :'orgA' || '/items/' || :'iIn' || '/')),
  'null|null|null|null|null|null',
  'C9: traversal, a nested folder, a percent sign, an empty file name, null and a non-uuid folder name no item');

select is(
  pg_temp.q($$select p.prosecdef::text || ':' ||
                  coalesce((select c from unnest(p.proconfig) c where c like 'search_path=%'), 'unpinned') || ':' ||
                  has_function_privilege('anon', p.oid, 'execute')::text || ':' ||
                  has_function_privilege('authenticated', p.oid, 'execute')::text
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'rls_item_image_shared_paths'$$),
  'true:search_path=public:false:true',
  'C10: the shared-file set is the one SECURITY DEFINER helper: pinned search_path, closed to anon (the policy needs authenticated)');
select is(
  pg_temp.q($$select (p.prosrc ~* 'materialized')::text || ':' ||
                     (p.prosrc ~ 'organization_id\s+in\s+\(select\s+public\.rls_member_org_ids\(\)\)')::text || ':' ||
                     (p.prosrc ~ 'auth\.uid\(\)')::text || ':' ||
                     (p.prosrc !~ 'caller_can_read_item')::text
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'rls_item_image_shared_paths'$$),
  'true:true:true:true',
  'C11: the shared-file set scans only the caller''s orgs'' rows behind a MATERIALIZED fence, answers only with auth.uid(), and makes no per-row SECURITY DEFINER call');
select is(
  pg_temp.q($$select coalesce(string_agg(f, ' ' order by f), '(none)')
                from (select distinct m[1] as f
                        from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
                             regexp_matches(p.prosrc, '(rls_(?:inv_read|cat)_[a-z_]+)', 'g') m
                       where n.nspname = 'public' and p.proname = 'caller_can_read_item') c
               where f not in (select m2[1]
                                 from pg_proc p2 join pg_namespace n2 on n2.oid = p2.pronamespace,
                                      regexp_matches(p2.prosrc, '(rls_(?:inv_read|cat)_[a-z_]+)', 'g') m2
                                where n2.nspname = 'public' and p2.proname = 'rls_item_image_shared_paths')$$),
  '(none)',
  'C12: the shared-file set applies every read-scope set caller_can_read_item (inventory_items_select''s DEFINER twin) applies');
select is(
  (select (qual ~ 'NOT \(i\.organization_id IS DISTINCT FROM item_images\.organization_id\)')::text
     from pg_policies where schemaname = 'public' and tablename = 'item_images' and policyname = 'item_images_select'),
  'true',
  'C13: item_images_select correlates the org with IS NOT DISTINCT FROM (one pkey probe per row, not a hashed scan of every readable item)');
select is(
  (select (qual ~ 'starts_with\(objects\.name' and qual ~ 'rls_member_org_ids\(\)' and qual ~ 'rls_item_image_shared_paths\(\)')::text
     from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'item-images authenticated read'),
  'true',
  'C14: the bucket read policy keeps starts_with for the org (a pkey probe) and gates the shared-file set on the caller''s orgs');

-- ══ P: another org's photo rows do not slow the caller ═══════════════════
-- 20,000 shared-shape rows (a path naming another item) planted in org B, as
-- any owner of any org can: row_path_ok accepted them from an owner with two
-- items, and nothing needs a stored object. With the set scanning every
-- tenant and checking each row's item per row (~190 us), a charter-scoped
-- member of org A waited ~4 s here; scoped to the caller's orgs it is a few
-- ms. The budget is generous so a busy machine never flakes it.
insert into public.item_images (organization_id, item_id, storage_path, is_primary, sort_order)
select :'orgB', :'iB', :'orgB' || '/items/03810000-0000-0000-0000-00000000f0f0/' || lpad(g::text, 8, '0') || '.png', false, 0
  from generate_series(1, 20000) g;
analyze public.item_images;
set local role authenticated;
set local "request.jwt.claim.sub" to :'stfC';
select is(pg_temp.q(format($$select count(*)::text from storage.objects where bucket_id = 'item-images' and name = %L$$,
                           pg_temp.pa(:'orgA', :'iSrc', 'm6.png'))), '1',
  'P1: with 20,000 foreign shared-shape rows, charter-scoped staff still read the duplicate''s shared file');
select cmp_ok(pg_temp.ms(format($$select count(*) from storage.objects where bucket_id = 'item-images' and name = %L$$,
                                pg_temp.pa(:'orgA', :'iSrc', 'm6.png'))), '<', 1000,
  'P2: ... in well under a second (another org''s rows are never scanned per row)');
select cmp_ok(pg_temp.ms(format($$select count(*) from storage.objects where bucket_id = 'item-images' and name = %L$$,
                                pg_temp.pa(:'orgA', :'iWh', 'm3.png'))), '<', 1000,
  'P3: ... and a refused own-org object is refused as fast');
select cmp_ok(pg_temp.ms($$select count(*) from public.rls_item_image_shared_paths()$$), '<', 1000,
  'P4: ... and so is a direct call of the shared-file set (authenticated can execute it)');
reset role;

select * from finish();
rollback;
