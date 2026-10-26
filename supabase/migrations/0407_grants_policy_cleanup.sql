-- 0407_grants_policy_cleanup.sql
--
-- Database permission clean-up (small fixes slice 4, docket S9). Nothing a
-- person does in the web app or on the phone changes: every privilege and
-- policy taken away here is one no app path uses, which each section below
-- proves. No row of any table changes; the one storage row deleted is an
-- empty, unused bucket, and the file refuses to run if it holds anything.
--
-- ── WHAT, BY SECTION ──────────────────────────────────────────────────────
-- 0. Preflight: refuse (55000, nothing applied) unless every object this file
--    restates, drops or replaces is exactly what it was written against, and
--    unless the data it assumes is there: item_attachments holds no row, the
--    item-attachments bucket holds no object and no upload, and item_images
--    is small enough to index inside the push (see 7).
-- 1. The six report_* functions (4.2): 0380 kept a branch that answered a
--    call with no user when the calling role was service_role, and kept
--    service_role's EXECUTE, so that 0380 could be pushed before the web code
--    that calls them with the caller's own client (#293). That code has been
--    live since 2026-09-29. Every caller is ReportsService through
--    this.ctx.supabase (apps/web/src/server/services/reports.ts:617, 621,
--    780, 1366, 1489, 1587, 1591), whose context is built by withContext or
--    withApiContext from the caller's cookie or bearer token; no cron job,
--    database function or other server code calls them. So the branch goes
--    (each body is 0380's, md5 below, with only those lines removed) and
--    service_role loses EXECUTE. A call with no user is now refused for every
--    role with 42501 unauthenticated.
-- 2. Table privileges named one by one:
--    4.1 shipments and shipment_lines: anon held every privilege on both,
--        and neither table has a policy for anon, so RLS answered anon with
--        no rows. No app code reads or writes either table (the shipping
--        service uses carrier_shipments), so anon loses them all.
--    4.4 idempotency_keys: anon loses everything; authenticated loses DELETE
--        (no API path deletes a key; see 6).
--    4.5 maintenance_request_attachments: INSERT goes from anon and
--        authenticated. The only writer is the finalize step
--        (apps/web/src/server/services/maintenance-attachments.ts:679),
--        which inserts with the service-role client after its own checks
--        since #325 (2026-10-05); the phone has only ever used the API
--        (apps/mobile/src/lib/maintenance-api.ts).
-- 3. TRUNCATE, REFERENCES, TRIGGER and MAINTAIN (4.3): anon and authenticated
--    lose all four on every relation in public (the GENERATED REVOKES block,
--    one statement per relation that holds any of them). TRUNCATE skips row
--    level security altogether; the other three serve only DDL, maintenance
--    and LOCK TABLE. No app or script code, and no function or trigger in
--    public or ledger, truncates, locks, refreshes or maintains a table
--    (catalog census of every body on the migration scratch stack,
--    2026-10-25), and foreign key checks run as the table owner, so no API
--    path uses any of the four. service_role keeps them (it is the server's
--    own role and bypasses RLS anyway).
-- 4. The same four leave the postgres role's default privileges in public,
--    so a table, view or materialized view a later migration creates never
--    gets them for anon or authenticated. Supabase's 2026-10-30 change takes
--    SELECT, INSERT, UPDATE and DELETE out of the same defaults and leaves
--    these four in (0402's header); after this file they are out on every
--    stack too. The same revoke is made database-wide: Postgres adds the
--    database-wide defaults to every schema's, so a revoke in public alone
--    could not take away a database-wide grant. No stack has one (the
--    preflight file reads production's), so there it changes nothing. Only
--    public is ours: our migrations create no relation in another schema.
--    (The postgres role's defaults in storage, from Supabase's own setup,
--    hold the four too; storage's tables belong to Supabase's storage admin
--    role, and the other schemas' defaults to its other admin roles.)
-- 5. The lock prelude for the policy statements (LOCKS below).
-- 6. Policies:
--    4.4 idempotency_keys: the FOR ALL write policy becomes an INSERT and an
--        UPDATE policy with the same manager floor, and SELECT goes from any
--        member to managers. Every API writer of keys is SECURITY INVOKER and
--        refuses anyone below manager before it records a key
--        (ledger.post_receipt_v2, ledger.distribute_bundle,
--        draft_order_shortfall_pos, start_targeted_recount); the returns
--        functions are SECURITY DEFINER and the weekly digest writes with the
--        service role, so neither meets these policies. No app code reads the
--        table. UPDATE keeps today's scope on purpose: post_receipt_v2 reads a
--        committed key with SELECT ... FOR UPDATE, which RLS filters through
--        the UPDATE policy too, so a narrower UPDATE would turn a receipt
--        replay into a second receipt attempt. With no DELETE policy and no
--        DELETE privilege, no API role can remove a key.
--    4.5 maintenance_request_attachments_insert (0317) goes: with INSERT
--        revoked in 2 it could only mislead a reader.
--    4.6 item_attachments: the table has no reader or writer anywhere in the
--        apps and holds no row (preflight), so its two policies go and RLS
--        refuses every API role. The two item-attachments storage policies on
--        storage.objects go too.
-- 7. The item-attachments bucket is deleted (4.6). It has never had an app
--    writer (0325) and must be empty: the file counts its objects and
--    multipart uploads again under the prelude's lock on storage.objects and
--    refuses (55000) on any; nothing in it is ever deleted. Storage's
--    protect_delete trigger refuses a direct DELETE unless
--    storage.allow_delete_query is true, so the file turns it on for that one
--    statement only and off again. supabase/config.toml no longer declares
--    the bucket, so local and CI stacks stop re-creating it.
-- 8. Three plain indexes on item_images (4.8): storage_path and thumb_path
--    for the 0381 photo checks that look a path up in either column
--    (item_image_row_path_ok's EXISTS, which the planner answers with a
--    BitmapOr of the two, and objectsNamedByOtherImageRows in
--    apps/web/src/server/services/lib/item-image-shared-objects.ts), and
--    organization_id for rls_item_image_shared_paths. Measured on the
--    migration scratch stack (synthetic rows, 2026-10-25): 1,200 photos
--    build in 1.8, 1.7 and 0.7 ms; 12,000 in 15.5, 15.5 and 3.9 ms; 60,000
--    in 100, 179 and 18 ms. The path probe went from a sequential scan
--    (1.60 ms at 12,000) to the BitmapOr (0.18 ms); with only the
--    storage_path and organization_id indexes it stayed a sequential scan
--    (1.45 ms), hence the thumb_path index. CREATE INDEX holds SHARE on
--    item_images (writes wait, reads do not) for the build, so inside the
--    push is right at today's size; the preflight refuses above 250,000
--    rows, where the build belongs in an ops step with CREATE INDEX
--    CONCURRENTLY instead.
--
-- ── WHO CHANGES AT PUSH ───────────────────────────────────────────────────
-- Nobody, in anything the apps do. What a direct Data API call gets changes
-- in four places: an anon read of shipments or shipment_lines is refused
-- (42501) where it returned no rows; a staff member's or viewer's read of
-- idempotency_keys returns no rows where it returned the organization's keys;
-- an insert into maintenance_request_attachments with a user's token is
-- refused by privilege instead of by policy; item_attachments answers no rows
-- to everyone.
--
-- ── LOCKS ─────────────────────────────────────────────────────────────────
-- Measured on the migration scratch stack (Postgres 17.6, supautils with
-- policy_grants set as on the hosted image), 2026-10-25:
--   * the preflight reads catalogs, and reads policy text and row counts in a
--     block it always undoes, so it ends holding no table lock;
--   * CREATE OR REPLACE FUNCTION, GRANT, REVOKE and ALTER DEFAULT PRIVILEGES
--     take no table lock (each GRANT or REVOKE rewrites the relation's
--     pg_class row, so it waits for another session's uncommitted DDL on that
--     relation; lock_timeout caps that wait);
--   * every policy statement takes ACCESS EXCLUSIVE on its table and, through
--     supautils, on every existing table supautils.policy_grants lists for
--     this role (auth, realtime and storage tables, auth.users and
--     auth.sessions among them);
--   * the bucket delete takes ROW EXCLUSIVE on storage.buckets and its foreign
--     key check reads storage.objects and the upload tables;
--   * each CREATE INDEX takes SHARE on item_images.
-- So the prelude (5) takes all of those at once, NOWAIT, retrying up to 40
-- times with a 50 to 150 ms pause that holds nothing (the 0390, 0395 and 0404
-- pattern), and after it no statement takes a new table lock: the file never
-- waits while holding one, so it cannot deadlock. From the prelude to the
-- commit (policies, the bucket, three index builds: milliseconds at today's
-- size), sign-ins, token refreshes, storage reads and writes, and writes to
-- item_images wait. lock_timeout 900ms (below deadlock_timeout) bounds
-- anything unforeseen. Push off-peak.
--
-- ── ERRORS ────────────────────────────────────────────────────────────────
-- The push raises 55000 with hint grants_cleanup_preflight (drift, or a
-- second run: nothing applied), item_attachments_not_empty,
-- item_attachments_bucket_not_empty or item_images_too_large (data the file
-- does not expect: nothing applied), or 55P03 (busy after 40 attempts:
-- nothing applied, run it again). The report functions raise 42501
-- unauthenticated or forbidden and P0001 module_disabled, as before. Never
-- 40001 or 40P01 (PostgREST retries those forever, 0367).
--
-- ── ORDER ─────────────────────────────────────────────────────────────────
-- After 0402 (live): 0402 restates every grant production held on
-- 2026-10-24, these four privileges included, so applied after this file it
-- would grant them back. After 0403-0406: none of them replaces an object
-- this file replaces, and the two tables 0406 creates revoke everything first,
-- so the GENERATED REVOKES block is the same with or without them (checked:
-- the generator's --revokes --check against a scratch database at 0406).
-- ledger.distribute_bundle, which 0404 restates, records its key as a manager
-- under these policies either way. The web and phone code need no change and
-- can deploy before or after.

set lock_timeout = '900ms';

-- ═══ 0. Preflight ═══════════════════════════════════════════════════════════
do $pre407$
declare
  v_bad     text := '';
  v_data    text := '';
  v_hint    text := '';
  v_n       bigint;
  r         record;
begin
  -- The six report bodies are 0380's (no migration since has replaced them).
  for r in
    select v.sig, v.want_src, p.oid as poid, md5(p.prosrc) as got_src, p.prosecdef,
           p.provolatile::text as vol, coalesce(array_to_string(p.proconfig, ';'), '') as cfg,
           pg_get_userbyid(p.proowner) as owner
      from (values
        ('public.report_movement_type_summary(uuid,timestamptz)',  '7d50dddc01096b9bc208b015a9f4cd35'),
        ('public.report_top_movers(uuid,timestamptz,integer)',     'f3d8bba356ad4c1e48669a9a731acc76'),
        ('public.report_shrinkage_totals(uuid,timestamptz)',       'fbf62dadf66cb40cab38f5b212a90b39'),
        ('public.report_item_out_movements(uuid,timestamptz)',     'b38826c35b6cbe86ddd1873762cdfc8c'),
        ('public.report_bundle_activity(uuid,timestamptz)',        'ad3c6125ad6e28e37779f1fc5d341ad9'),
        ('public.report_bundle_component_value(uuid,timestamptz)', '04d4cc9d05131878368de19f8a197f02')
      ) v(sig, want_src)
      left join pg_proc p on p.oid = to_regprocedure(v.sig)
  loop
    if r.poid is null then
      v_bad := v_bad || format(' %s missing;', r.sig);
    elsif r.got_src <> r.want_src or r.prosecdef or r.vol <> 's'
          or r.cfg <> 'search_path=public;plan_cache_mode=force_custom_plan'
          or r.owner <> 'postgres' then
      v_bad := v_bad || format(' %s drifted (md5 %s, definer %s, volatility %s, %s, owner %s);',
                               r.sig, r.got_src, r.prosecdef, r.vol, r.cfg, r.owner);
    end if;
  end loop;

  -- The policies to replace or drop, and nothing else on the three tables
  -- (or under the item-attachments name on storage.objects). Deparsing a
  -- policy whose expression reads another table takes ACCESS SHARE on it
  -- until the transaction ends, and the counts below read the tables, so all
  -- of it runs in a block that is always undone: the file holds no table lock
  -- before the prelude. search_path is pinned inside the block (undone with
  -- it) so the deparsed text does not depend on the session's. Variables
  -- keep their values when the block is undone.
  begin
    perform set_config('search_path', 'public, extensions', true);
    for r in
      select coalesce(v.tbl, g.tbl) as tbl, coalesce(v.pol, g.pol) as pol, v.want, g.got
        from (values
          ('public.idempotency_keys', 'idempotency_keys_select', '36baf21e48668b1df3d95008d5838e06'),
          ('public.idempotency_keys', 'idempotency_keys_write',  '6a61b2aaec42db59a969ed5b8ce9fdcd'),
          ('public.item_attachments', 'item_attachments_select', 'e23f20304c80151dea9cb85103a6db0b'),
          ('public.item_attachments', 'item_attachments_write',  '7754050e3e966cc6b4abe64102972878'),
          ('public.maintenance_request_attachments', 'maintenance_request_attachments_delete', '6e383450d002e37135f244d78ded7541'),
          ('public.maintenance_request_attachments', 'maintenance_request_attachments_insert', 'a916a3f7c10dc0492498410ffe1e8e73'),
          ('public.maintenance_request_attachments', 'maintenance_request_attachments_select', '134aff974013e863cd0f54480724d3e3'),
          ('storage.objects', 'item-attachments authenticated read', '51c1865f428bc9d5945971a794b21ca8'),
          ('storage.objects', 'item-attachments staff write',        '41986b84c66a582dd7b2827093223a93')
        ) v(tbl, pol, want)
        full join (
          select n.nspname || '.' || c.relname as tbl, pol.polname as pol,
                 md5(pol.polcmd::text || '|' || pol.polpermissive::text || '|'
                     || (select string_agg(case x when 0 then 'public' else x::regrole::text end, ',' order by 1)
                           from unnest(pol.polroles) x)
                     || '|' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '')
                     || '|' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')) as got
            from pg_policy pol join pg_class c on c.oid = pol.polrelid
            join pg_namespace n on n.oid = c.relnamespace
           where c.oid in ('public.idempotency_keys'::regclass, 'public.item_attachments'::regclass,
                           'public.maintenance_request_attachments'::regclass)
              or (c.oid = 'storage.objects'::regclass and pol.polname like 'item-attachments%')
        ) g on g.tbl = v.tbl and g.pol = v.pol
    loop
      if r.want is null then
        v_bad := v_bad || format(' unexpected policy %s on %s;', r.pol, r.tbl);
      elsif r.got is distinct from r.want then
        v_bad := v_bad || format(' policy %s on %s drifted (%s);', r.pol, r.tbl, coalesce(r.got, 'missing'));
      end if;
    end loop;

    -- The data this file assumes.
    select count(*) into v_n from public.item_attachments;
    if v_n <> 0 then
      v_data := v_data || format(' item_attachments holds %s rows;', v_n);
      v_hint := 'item_attachments_not_empty';
    end if;
    select count(*) into v_n from storage.objects where bucket_id = 'item-attachments';
    if v_n <> 0 then
      v_data := v_data || format(' the item-attachments bucket holds %s objects;', v_n);
      v_hint := 'item_attachments_bucket_not_empty';
    end if;
    if to_regclass('storage.s3_multipart_uploads') is not null then
      execute 'select count(*) from storage.s3_multipart_uploads where bucket_id = $1'
        into v_n using 'item-attachments';
      if v_n <> 0 then
        v_data := v_data || format(' the item-attachments bucket holds %s multipart uploads;', v_n);
        v_hint := 'item_attachments_bucket_not_empty';
      end if;
    end if;
    select count(*) into v_n from public.item_images;
    if v_n > 250000 then
      v_data := v_data || format(' item_images holds %s rows (index it with CREATE INDEX CONCURRENTLY outside the push);', v_n);
      v_hint := 'item_images_too_large';
    end if;
    raise exception using errcode = 'XX407', message = 'undo';
  exception when sqlstate 'XX407' then
    null;
  end;

  -- Names this file creates must be free.
  if exists (select 1 from pg_policy pol
              where pol.polrelid = 'public.idempotency_keys'::regclass
                and pol.polname in ('idempotency_keys_insert', 'idempotency_keys_update')) then
    v_bad := v_bad || ' idempotency_keys_insert or idempotency_keys_update already exists;';
  end if;
  if to_regclass('public.item_images_storage_path_idx') is not null
     or to_regclass('public.item_images_thumb_path_idx') is not null
     or to_regclass('public.item_images_organization_id_idx') is not null then
    v_bad := v_bad || ' an item_images index this file creates already exists;';
  end if;

  if v_bad <> '' then
    raise exception 'grants_cleanup_preflight:%', v_bad
      using errcode = '55000', hint = 'grants_cleanup_preflight';
  end if;
  if v_data <> '' then
    raise exception 'grants_cleanup_data:%', v_data
      using errcode = '55000', hint = v_hint;
  end if;
end
$pre407$;

-- ═══ 1. The report functions answer only for a signed-in caller (4.2) ═════
-- Each body is 0380's (md5 in the preflight) with its service-role test taken
-- out: the `if current_user <> 'service_role'` and `end if` around the
-- unauthenticated raise, which let a call with no user through for
-- service_role. Header, owner, comment and the authenticated grant are kept;
-- plpgsql takes no table lock here.

-- report_movement_type_summary
create or replace function public.report_movement_type_summary(
  p_organization_id uuid,
  p_since timestamptz
)
returns table (
  movement_type text,
  movement_count bigint,
  total_qty numeric
)
language plpgsql
stable
security invoker
set search_path = public
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
begin
  if (select auth.uid()) is null then
    raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
  elsif not public.is_org_member(p_organization_id)
     or not public.has_permission(p_organization_id, 'reports:read') then
    raise exception 'forbidden' using errcode = '42501', hint = 'forbidden';
  end if;

  return query
  select
    sm.movement_type,
    count(*)::bigint as movement_count,
    coalesce(sum(abs(coalesce(sm.quantity_change, 0))), 0)::numeric as total_qty
  from public.stock_movements sm
  where sm.organization_id = p_organization_id
    and sm.created_at >= p_since
  group by sm.movement_type;
end $$;

-- report_top_movers
create or replace function public.report_top_movers(
  p_organization_id uuid,
  p_since timestamptz,
  p_limit int default 50
)
returns table (
  item_id uuid,
  sku text,
  name text,
  total_in numeric,
  total_out numeric,
  movement_count bigint
)
language plpgsql
stable
security invoker
set search_path = public
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
begin
  if (select auth.uid()) is null then
    raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
  elsif not public.is_org_member(p_organization_id)
     or not public.has_permission(p_organization_id, 'reports:read') then
    raise exception 'forbidden' using errcode = '42501', hint = 'forbidden';
  end if;

  return query
  select
    sm.item_id,
    i.sku,
    i.name,
    coalesce(sum(case when sm.quantity_change >= 0 then sm.quantity_change else 0 end), 0)::numeric as total_in,
    coalesce(sum(case when sm.quantity_change < 0 then -sm.quantity_change else 0 end), 0)::numeric as total_out,
    count(*)::bigint as movement_count
  from public.stock_movements sm
  join public.inventory_items i on i.id = sm.item_id
  where sm.organization_id = p_organization_id
    and sm.created_at >= p_since
  group by sm.item_id, i.sku, i.name
  order by (
    coalesce(sum(case when sm.quantity_change >= 0 then sm.quantity_change else 0 end), 0)
    + coalesce(sum(case when sm.quantity_change < 0 then -sm.quantity_change else 0 end), 0)
  ) desc, sm.item_id asc
  limit greatest(p_limit, 0);
end $$;

-- report_shrinkage_totals
create or replace function public.report_shrinkage_totals(
  p_organization_id uuid,
  p_since timestamptz
)
returns table (
  total_units numeric,
  total_cost numeric
)
language plpgsql
stable
security invoker
set search_path = public
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
begin
  if (select auth.uid()) is null then
    raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
  elsif not public.is_org_member(p_organization_id)
     or not public.has_permission(p_organization_id, 'reports:read') then
    raise exception 'forbidden' using errcode = '42501', hint = 'forbidden';
  end if;

  return query
  select
    coalesce(sum(abs(sm.quantity_change)), 0)::numeric as total_units,
    coalesce(sum(abs(sm.quantity_change) * coalesce(i.unit_cost, 0)), 0)::numeric as total_cost
  from public.stock_movements sm
  join public.inventory_items i on i.id = sm.item_id
  where sm.organization_id = p_organization_id
    and sm.movement_type = 'adjust'
    and sm.quantity_change < 0
    and sm.created_at >= p_since;
end $$;

-- report_item_out_movements
create or replace function public.report_item_out_movements(
  p_organization_id uuid,
  p_since timestamptz
)
returns table (
  item_id uuid,
  units_out numeric,
  last_out_at timestamptz
)
language plpgsql
stable
security invoker
set search_path = public
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
begin
  if (select auth.uid()) is null then
    raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
  elsif not public.is_org_member(p_organization_id)
     or not public.has_permission(p_organization_id, 'reports:read') then
    raise exception 'forbidden' using errcode = '42501', hint = 'forbidden';
  end if;

  return query
  select
    sm.item_id,
    coalesce(sum(abs(coalesce(sm.quantity_change, 0))), 0)::numeric as units_out,
    max(sm.created_at) as last_out_at
  from public.stock_movements sm
  where sm.organization_id = p_organization_id
    and sm.created_at >= p_since
    and sm.quantity_change < 0
  group by sm.item_id;
end $$;

-- report_bundle_activity
create or replace function public.report_bundle_activity(
  p_organization_id uuid,
  p_since timestamptz
)
returns table (
  bundle_id uuid,
  bundle_name text,
  bundle_sku text,
  runs bigint,
  kits_out numeric,
  last_run_at timestamptz,
  top_warehouse_name text
)
language plpgsql
stable
security invoker
set search_path = public
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
begin
  if (select auth.uid()) is null then
    raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
  elsif not public.is_org_member(p_organization_id)
     or not public.has_permission(p_organization_id, 'reports:read') then
    raise exception 'forbidden' using errcode = '42501', hint = 'forbidden';
  elsif not public.module_enabled(p_organization_id, 'bundles') then
    raise exception 'module disabled' using errcode = 'P0001', hint = 'module_disabled';
  end if;

  return query
  with dist as (
    select bd.bundle_id, bd.warehouse_id, bd.quantity, bd.distributed_at
    from public.bundle_distributions bd
    where bd.organization_id = p_organization_id
      and bd.distributed_at >= p_since
  ),
  wh_runs as (
    select bundle_id, warehouse_id, count(*) as wruns
    from dist
    group by bundle_id, warehouse_id
  ),
  top_wh as (
    select distinct on (bundle_id) bundle_id, warehouse_id
    from wh_runs
    order by bundle_id, wruns desc, warehouse_id asc
  )
  select
    d.bundle_id,
    b.name as bundle_name,
    b.sku as bundle_sku,
    count(*)::bigint as runs,
    coalesce(sum(d.quantity), 0)::numeric as kits_out,
    max(d.distributed_at) as last_run_at,
    w.name as top_warehouse_name
  from dist d
  join public.bundles b on b.id = d.bundle_id
  left join top_wh tw on tw.bundle_id = d.bundle_id
  left join public.warehouses w on w.id = tw.warehouse_id
  group by d.bundle_id, b.name, b.sku, w.name;
end $$;

-- report_bundle_component_value
create or replace function public.report_bundle_component_value(
  p_organization_id uuid,
  p_since timestamptz
)
returns table (
  bundle_id uuid,
  component_value_out numeric
)
language plpgsql
stable
security invoker
set search_path = public
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
begin
  if (select auth.uid()) is null then
    raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
  elsif not public.is_org_member(p_organization_id)
     or not public.has_permission(p_organization_id, 'reports:read') then
    raise exception 'forbidden' using errcode = '42501', hint = 'forbidden';
  elsif not public.module_enabled(p_organization_id, 'bundles') then
    raise exception 'module disabled' using errcode = 'P0001', hint = 'module_disabled';
  end if;

  return query
  select
    sm.reference_id as bundle_id,
    coalesce(sum(abs(sm.quantity_change) * coalesce(i.unit_cost, 0)), 0)::numeric as component_value_out
  from public.stock_movements sm
  join public.inventory_items i on i.id = sm.item_id
  where sm.organization_id = p_organization_id
    and sm.reference_type = 'bundle'
    and sm.movement_type = 'bundle_distribution'
    and sm.quantity_change < 0
    and sm.created_at >= p_since
  group by sm.reference_id;
end $$;

revoke execute on function public.report_movement_type_summary(uuid, timestamptz) from service_role;
revoke execute on function public.report_top_movers(uuid, timestamptz, integer) from service_role;
revoke execute on function public.report_shrinkage_totals(uuid, timestamptz) from service_role;
revoke execute on function public.report_item_out_movements(uuid, timestamptz) from service_role;
revoke execute on function public.report_bundle_activity(uuid, timestamptz) from service_role;
revoke execute on function public.report_bundle_component_value(uuid, timestamptz) from service_role;

-- ═══ 2. Table privileges named one by one (4.1, 4.4, 4.5) ═════════════════
revoke all on table public.shipments, public.shipment_lines from anon;
revoke all on table public.idempotency_keys from anon;
revoke delete on table public.idempotency_keys from authenticated;
revoke insert on table public.maintenance_request_attachments from anon, authenticated;

-- ═══ 3. TRUNCATE, REFERENCES, TRIGGER and MAINTAIN, relation by relation (4.3)
-- From a census of the relations in public (scripts/explicit-grants/census.sql)
-- by `node scripts/gen-explicit-grants-sql.mjs --revokes`; before the push,
-- run it with --check against a fresh production census (usage at the top of
-- that script). Revoking a privilege a role does not hold changes nothing, so
-- the block can be applied twice.
-- BEGIN GENERATED REVOKES: scripts/gen-explicit-grants-sql.mjs --revokes from a census (scripts/explicit-grants/census.sql). Do not edit by hand.
-- 122 relations in public on which anon or authenticated hold TRUNCATE, REFERENCES, TRIGGER or MAINTAIN;
-- 871 such privileges in all, table-level and column-level.
revoke truncate, references, trigger, maintain
  on table public.activity_logs from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.ai_chat_messages from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.ai_chat_sessions from anon, authenticated;
revoke truncate, references, trigger, maintain on table public.api_keys from anon, authenticated;
revoke truncate, references, trigger, maintain on table public.approvals from anon, authenticated;
revoke truncate, references, trigger, maintain on table public.audit_logs from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.billing_events from anon, authenticated;
revoke truncate, references, trigger, maintain on table public.bins from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.book_metadata_cache from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.bundle_components from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.bundle_distributions from anon, authenticated;
revoke truncate, references, trigger, maintain on table public.bundles from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.carrier_shipments from anon, authenticated;
revoke truncate, references, trigger, maintain on table public.categories from anon, authenticated;
revoke truncate, references, trigger, maintain on table public.charters from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.connection_mappings from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.connection_sync_log from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.custom_field_definitions from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.customer_catalog from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.customer_users from anon, authenticated;
revoke truncate, references, trigger, maintain on table public.customers from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.cycle_count_ai_scans from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.cycle_count_lines from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.cycle_counts from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.delivery_locations from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.export_presets from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.idempotency_keys from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.import_job_errors from anon, authenticated;
revoke truncate, references, trigger, maintain on table public.import_jobs from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.integration_deliveries from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.integration_endpoints from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.inventory_items from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.inventory_stock from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.item_attachments from anon, authenticated;
revoke truncate, references, trigger, maintain on table public.item_images from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.item_import_batches from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.item_price_observations from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.item_stock_levels from anon, authenticated;
revoke truncate, references, trigger, maintain on table public.item_tags from anon, authenticated;
revoke truncate, references, trigger, maintain on table public.locations from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.lot_pick_events from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.maintenance_request_attachments from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.maintenance_request_notes from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.maintenance_request_share_links from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.maintenance_requests from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.mfa_recovery_codes from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.notification_preferences from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.notifications from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.order_request_attachments from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.order_request_lines from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.org_connections from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.org_daily_movement_stats from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.org_daily_stats from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.organization_invites from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.organization_members from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.organization_modules from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.organizations from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.outbox_events from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.platform_admin_audit from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.platform_impersonation_sessions from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.platform_settings from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.po_attachments from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.po_import_lines from anon, authenticated;
revoke truncate, references, trigger, maintain on table public.po_imports from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.price_list_items from anon, authenticated;
revoke truncate, references, trigger, maintain on table public.price_lists from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.procedure_categories from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.procedure_comments from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.procedure_videos from anon, authenticated;
revoke truncate, references, trigger, maintain on table public.procedures from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.product_group_rollups from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.product_groups from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.public_link_catalog_entries from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.public_request_links from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.purchase_order_charges from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.purchase_order_items from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.purchase_orders from anon, authenticated;
revoke truncate, references, trigger, maintain on table public.push_tokens from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.putaway_moves from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.rate_limit_buckets from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.receipt_line_lots from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.receipt_lines from anon, authenticated;
revoke truncate, references, trigger, maintain on table public.receipts from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.recurring_po_templates from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.rental_lines from anon, authenticated;
revoke truncate, references, trigger, maintain on table public.rentals from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.restore_points from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.role_default_permissions from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.role_permission_overrides from anon, authenticated;
revoke truncate, references, trigger, maintain on table public.saved_views from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.schedule_events from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.serial_registry from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.shipment_lines from anon, authenticated;
revoke truncate, references, trigger, maintain on table public.shipments from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.size_count_adjustments from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.size_count_events from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.size_count_sessions from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.size_count_training_samples from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.size_scale_values from anon, authenticated;
revoke truncate, references, trigger, maintain on table public.size_scales from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.stock_movements from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.stock_reservations from anon, authenticated;
revoke truncate, references, trigger, maintain on table public.suppliers from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.support_tickets from anon, authenticated;
revoke truncate, references, trigger, maintain on table public.tags from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.tolerance_profiles from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.uom_conversions from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.user_category_assignments from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.user_login_devices from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.user_onboarding from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.user_permission_overrides from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.user_profiles from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.user_release_state from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.user_warehouse_assignments from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.vendor_item_mappings from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.vw_inventory_valuation_by_category from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.vw_inventory_valuation_by_warehouse from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.vw_po_reconciliation from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.vw_vendor_performance from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.vw_warehouse_inbound from anon, authenticated;
revoke truncate, references, trigger, maintain
  on table public.warehouse_charters from anon, authenticated;
revoke truncate, references, trigger, maintain on table public.warehouses from anon, authenticated;
-- END GENERATED REVOKES

-- ═══ 4. ...and out of the postgres role's default privileges ══════════════
alter default privileges for role postgres in schema public
  revoke truncate, references, trigger, maintain on tables from anon, authenticated;
-- Database-wide: a no-op unless such a default exists (see 4 above).
alter default privileges for role postgres
  revoke truncate, references, trigger, maintain on tables from anon, authenticated;

-- ═══ 5. The lock prelude (see LOCKS above) ═══════════════════════════════
-- Every table lock the statements below take, at once and without waiting.
-- Inside DO because the CLI batch is not a transaction block (a top-level
-- LOCK TABLE refuses there, 0373); the locks last until the batch commits.
--   * idempotency_keys, maintenance_request_attachments, item_attachments and
--     storage.objects: ACCESS EXCLUSIVE (their policy statements);
--   * item_images: SHARE (CREATE INDEX);
--   * every existing table supautils.policy_grants lists for this role, the
--     parent only of a partitioned one: ACCESS EXCLUSIVE (supautils takes it
--     whenever this role runs a policy statement). storage.buckets is one of
--     them, which covers the bucket delete.
-- A busy table fails the attempt at once; the rollback releases what it took
-- and the next attempt starts after 50 to 150 ms holding no table lock. After
-- the 40th busy attempt the 55P03 is raised as it is (never 40001/40P01) and
-- nothing in the file is applied.
do $lock407$
declare
  v_grants text := nullif(current_setting('supautils.policy_grants', true), '');
  v_name   text;
  v_rel    regclass;
  v_try    integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.idempotency_keys, public.maintenance_request_attachments,
                      public.item_attachments, storage.objects
        in access exclusive mode nowait;
      lock table only public.item_images in share mode nowait;
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
end $lock407$;

-- ═══ 6. Policies ═══════════════════════════════════════════════════════════
-- 4.4 idempotency_keys: managers read, insert and update their organization's
-- keys, as every API writer requires; nobody below manager reads them, and no
-- API role deletes one.
drop policy if exists idempotency_keys_write on public.idempotency_keys;
drop policy if exists idempotency_keys_select on public.idempotency_keys;
create policy idempotency_keys_select on public.idempotency_keys
  for select to authenticated
  using ((select public.has_org_role(organization_id, 'manager')));
create policy idempotency_keys_insert on public.idempotency_keys
  for insert to authenticated
  with check ((select public.has_org_role(organization_id, 'manager')));
create policy idempotency_keys_update on public.idempotency_keys
  for update to authenticated
  using ((select public.has_org_role(organization_id, 'manager')))
  with check ((select public.has_org_role(organization_id, 'manager')));

-- 4.5 maintenance attachments: only the service role inserts (finalize).
drop policy if exists maintenance_request_attachments_insert on public.maintenance_request_attachments;

-- 4.6 item attachments: no reader, no writer, no row.
drop policy if exists item_attachments_select on public.item_attachments;
drop policy if exists item_attachments_write on public.item_attachments;
drop policy if exists "item-attachments authenticated read" on storage.objects;
drop policy if exists "item-attachments staff write" on storage.objects;

-- ═══ 7. The empty item-attachments bucket (4.6) ═══════════════════════════
-- Counted again under the prelude's ACCESS EXCLUSIVE on storage.objects, so
-- nothing can be uploaded between the count and the delete; the foreign keys
-- from storage.objects and the upload tables (NO ACTION) would refuse a
-- non-empty bucket as well. Never deletes an object.
do $bucket407$
declare
  v_objects bigint := 0;
  v_uploads bigint := 0;
begin
  if not exists (select 1 from storage.buckets where id = 'item-attachments') then
    return;
  end if;
  select count(*) into v_objects from storage.objects where bucket_id = 'item-attachments';
  if to_regclass('storage.s3_multipart_uploads') is not null then
    execute 'select count(*) from storage.s3_multipart_uploads where bucket_id = $1'
      into v_uploads using 'item-attachments';
  end if;
  if v_objects + v_uploads <> 0 then
    raise exception 'grants_cleanup_data: the item-attachments bucket holds % objects and % multipart uploads',
      v_objects, v_uploads
      using errcode = '55000', hint = 'item_attachments_bucket_not_empty';
  end if;
  perform set_config('storage.allow_delete_query', 'true', true);
  delete from storage.buckets where id = 'item-attachments';
  perform set_config('storage.allow_delete_query', 'false', true);
end
$bucket407$;

-- ═══ 8. item_images indexes (4.8) ══════════════════════════════════════════
create index if not exists item_images_storage_path_idx on public.item_images (storage_path);
create index if not exists item_images_thumb_path_idx on public.item_images (thumb_path);
create index if not exists item_images_organization_id_idx on public.item_images (organization_id);

-- ═══ Comments ═══════════════════════════════════════════════════════════════
comment on policy idempotency_keys_select on public.idempotency_keys is
  'Managers of the organization read its keys: every API writer (post_receipt_v2, distribute_bundle, draft_order_shortfall_pos, start_targeted_recount) requires a manager (0407; was any member).';
comment on policy idempotency_keys_insert on public.idempotency_keys is
  'Managers of the organization record keys (0407; split from the FOR ALL idempotency_keys_write, same floor). No API role deletes a key.';
comment on policy idempotency_keys_update on public.idempotency_keys is
  'Managers of the organization update its keys (0407; split from idempotency_keys_write, same floor). Kept at that scope: post_receipt_v2 reads a committed key with SELECT ... FOR UPDATE, which this policy also filters.';

reset lock_timeout;
