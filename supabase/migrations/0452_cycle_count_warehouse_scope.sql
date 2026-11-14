-- Cycle counts, count lines, AI shelf scans and scan photos follow what the
-- member may see, in the database (docket items S48 and S52).
--
-- Cycle counts are read by warehouse, as items (0229), holdings (0331, 0371),
-- movements (0321), purchase orders (0322) and item photos (0381) are. Count
-- lines also follow the item they count, as movements do. AI shelf scans are
-- read by the person who took them and by owners, admins and managers, and
-- scan photos are read through a member's own token by owners, admins and
-- managers only; the app uploads and signs them with the service role, which
-- is the only writer of the bucket.
--
-- ── THE RULE ───────────────────────────────────────────────────────────────
-- "Mine" = my_warehouse_ids(). "Manager" = rls_manager_org_ids() (owner,
-- admin, manager). "Every warehouse" = rls_all_warehouses_org_ids() (a
-- manager, or the 0280 all-warehouses flag: the web's hasAllAccess).
--   count  a member of its organization AND (every warehouse
--            OR its header warehouse is mine
--            OR (no header warehouse AND (assigned to me
--                OR at least one of its lines is in a warehouse of mine)))
--   line   its count is readable AND (manager
--            OR (the line's warehouse is mine AND I may read its item,
--                inventory_items_select nested, as in 0321))
--          A line with no warehouse is read by managers only.
--   scan   its count is readable AND (I took it OR manager)
--   photo  read: the count named by the path's second folder exists in the
--            path's organization AND I am a manager there; insert, update
--            and delete: no rule for an API role (the service role only).
-- Staff and viewers read the counts of their warehouses alike; writing stays
-- as 0368 has it (a line update needs write access to the line's warehouse,
-- a header update and line insert or delete need a manager). A read-only
-- auditor who needs every warehouse gets the all-warehouses flag.
--
-- cycle_count_line_progress (SECURITY DEFINER, kept) restates the line rule
-- and the count rule's non-manager arms in its body (parity tested for every
-- persona). cycle_counts_page, cycle_count_summary and cycle_count_lines_page
-- are SECURITY INVOKER and follow the table rules; cycle_counts_page's
-- p_scope_warehouse_ids only narrows further. The line UPDATE rule's scan
-- link (0368) now asks cc_ai_scan_in_count, which does not read the scan
-- through row level security, so recounting or clearing a line another
-- person recorded from an AI scan keeps working.
--
-- KNOWN EDGE. cycle_count_line_rechecks (0372, SECURITY INVOKER) answers
-- within the caller's view: for a scoped member, a later posted count of the
-- same item in a warehouse they cannot read is not seen. Managers and
-- _exc_link_recount (SECURITY DEFINER) are unaffected.
--
-- ── WHAT THIS MIGRATION DOES ───────────────────────────────────────────────
--   0. Preflight: the bodies, owners and security modes this file builds on,
--      every policy on the three tables and the bucket, and
--      inventory_items_select (restated inside progress) are the ones it was
--      proven against; the three new names are free. my_warehouse_ids may be
--      either the 0310 body or docket S47's (one added expiry term): the rule
--      is the same for every live membership, and the membership arm refuses
--      an expired seat either way.
--   1. One lock prelude.
--   2. Three new STABLE SECURITY DEFINER helpers, search_path public, EXECUTE
--      for authenticated and service_role only: rls_all_warehouses_org_ids(),
--      rls_cc_unheaded_count_ids(), cc_ai_scan_in_count(uuid, uuid).
--   3. cycle_count_line_progress restated (same signature, result, STABLE,
--      SECURITY DEFINER, search_path, owner and grants), and its comment and
--      cycle_counts_page's comment updated.
--   4. ALTER POLICY cycle_count_lines_update WITH CHECK: the scan link only;
--      its USING clause is untouched.
--   5. The three table read rules (cycle_counts_select,
--      cycle_count_lines_select, cc_ai_scans_select), recreated.
--   6. LAST (the storage-policy-order guard): the bucket's read rule
--      recreated, and its write and delete rules dropped (S52).
-- No row is written, changed or removed; no table, column, view or sequence
-- is created, dropped or changed.
--
-- ── LOCKS ──────────────────────────────────────────────────────────────────
-- Every policy statement takes ACCESS EXCLUSIVE on its table and, through
-- supautils, on every table supautils.policy_grants lists for this role
-- (locally: auth.users, auth.sessions, storage.objects and more). The SQL
-- functions and the line rule read inventory_items and organization_members
-- when created (ACCESS SHARE). One prelude takes all of them at once,
-- NOWAIT, retrying up to 40 times 50-150 ms apart holding nothing between
-- attempts (0390, 0395, 0420); after it no statement takes a new table lock.
-- From the prelude to commit (milliseconds), count reads and writes,
-- sign-ins, token refreshes and storage reads wait. lock_timeout 900ms bounds
-- anything unforeseen.
--
-- ── ERRORS ─────────────────────────────────────────────────────────────────
-- The push raises 55000 hint cc_scope_preflight (drift or a second run:
-- nothing applied) or 55P03 (busy after 40 attempts: nothing applied, run it
-- again). Never 40001 or 40P01. Reads answer fewer rows and never raise; an
-- AI scan row filed against a count the caller cannot read, and a scan photo
-- upload or removal by an API role, are refused with 42501.
--
-- ── ROLLBACK (the owner's call only) ───────────────────────────────────────
-- A forward migration: recreate the four read policies from
-- 0140_rls_initplan_wrap.sql (cycle_counts_select, cycle_count_lines_select,
-- cc_ai_scans_select, 'cycle-count-scans org read') and the two bucket write
-- policies from the same file, restate cycle_count_line_progress from
-- 0358_cycle_count_numbers.sql and the line update WITH CHECK from
-- 0368_count_line_column_grants.sql, and drop the three helpers.

set lock_timeout = '900ms';

-- ═══ 0. Preflight ══════════════════════════════════════════════════════════
do $pre_s48$
declare
  v_bad text := '';
  r     record;
begin
  for r in
    select v.sig, v.want, v.want_alt, p.oid as poid, md5(p.prosrc) as got, p.prosecdef,
           pg_get_userbyid(p.proowner) as owner
      from (values
        ('public.cycle_count_line_progress(uuid,uuid[])', 'e544f854d8acb3e03e33dd6d65e598db', null),
        ('public.rls_member_org_ids()',                   '68860888450deeef2bbf628712c5b971', null),
        ('public.rls_manager_org_ids()',                  '7414b7d514144687e01ec6b41cb407dd', null),
        -- 0310's body, or docket S47's (the same body with one expiry term).
        ('public.my_warehouse_ids()',                     '7129bb768bce52a1ec1271be95afdffc',
                                                          'eacc28d3bd2d1ebd09242f61b8a094ad'),
        ('public.account_is_disabled(uuid)',              '16e89ccc9f3755879e39a96351e4efc3', null),
        ('public.is_org_member(uuid)',                    '76492a6556e9f6a7c33d942aa9726f9f', null),
        ('public.cycle_counts_page(uuid,bigint,text,text,uuid,uuid,boolean,timestamptz,uuid[],integer,integer)',
                                                          '9d90e3a1530ce9680b48da67796f4451', null)
      ) v(sig, want, want_alt)
      left join pg_proc p on p.oid = to_regprocedure(v.sig)
  loop
    if r.poid is null then
      v_bad := v_bad || format(' %s missing;', r.sig);
    elsif (r.got <> r.want and r.got is distinct from r.want_alt) or r.owner <> 'postgres'
          or r.prosecdef <> (r.sig not like 'public.cycle_counts_page(%') then
      v_bad := v_bad || format(' %s drifted (md5 %s, definer %s, owner %s);', r.sig, r.got, r.prosecdef, r.owner);
    end if;
  end loop;

  -- Policy texts print with the session's search_path; compare them under a
  -- fixed one, inside a block whose effects are undone.
  begin
    perform set_config('search_path', 'public, extensions', true);
    for r in
      select coalesce(v.tbl, g.tbl) as tbl, coalesce(v.pol, g.pol) as pol, v.want, g.got
        from (values
          ('public.cycle_counts',         'cycle_counts_select',              'c7ab74fba867c9c516bc65d1f2cf362b'),
          ('public.cycle_counts',         'cycle_counts_insert',              'a06c0c759a2235e7aafe46d5e0be4f57'),
          ('public.cycle_counts',         'cycle_counts_update',              '4680800e8ae02cb9310346b37e9c1ef3'),
          ('public.cycle_count_lines',    'cycle_count_lines_select',         '88fd14a57e964fb53187fb634b4b8489'),
          ('public.cycle_count_lines',    'cycle_count_lines_insert',         'a8e50cfddc3f3bf6008b3c283f80d680'),
          ('public.cycle_count_lines',    'cycle_count_lines_update',         'cc5fc9d2a56ff734f4bc1516d98d6724'),
          ('public.cycle_count_lines',    'cycle_count_lines_delete',         'e16b06816c71f498a1657a2987c916c1'),
          ('public.cycle_count_ai_scans', 'cc_ai_scans_select',               'f8471b1532738e6d3afecfe79874e0e1'),
          ('public.cycle_count_ai_scans', 'cc_ai_scans_insert',               '355ff0ebc22eca8d2ee453936a3bd802'),
          ('public.cycle_count_ai_scans', 'cc_ai_scans_update',               '4d0f80b4c78e93a5e7316a2a3c0b5d3c'),
          ('public.cycle_count_ai_scans', 'cc_ai_scans_no_delete',            'dd01d4b0c45e8cfbe330f9e4607388bf'),
          ('storage.objects',             'cycle-count-scans org read',       'b9ff122f5441353bdeca89937127bd6a'),
          ('storage.objects',             'cycle-count-scans org write',      'cfc9791f6d007ea7f2f9d5fbb0f0dfd9'),
          ('storage.objects',             'cycle-count-scans manager delete', '793f9b0255f4ed656692368ce8d1ee7b'),
          -- restated inside cycle_count_line_progress below
          ('public.inventory_items',      'inventory_items_select',           '50f899e6c521707f652fa4c90c2886e1')
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
           where c.oid in ('public.cycle_counts'::regclass, 'public.cycle_count_lines'::regclass,
                           'public.cycle_count_ai_scans'::regclass)
              or (c.oid = 'storage.objects'::regclass and pol.polname like 'cycle-count-scans%')
              or (c.oid = 'public.inventory_items'::regclass and pol.polname = 'inventory_items_select')
        ) g on g.tbl = v.tbl and g.pol = v.pol
    loop
      if r.want is null then
        v_bad := v_bad || format(' unexpected policy %s on %s;', r.pol, r.tbl);
      elsif r.got is distinct from r.want then
        v_bad := v_bad || format(' policy %s on %s drifted (%s);', r.pol, r.tbl, coalesce(r.got, 'missing'));
      end if;
    end loop;
    raise exception using errcode = 'XXS48', message = 'undo';
  exception when sqlstate 'XXS48' then
    null;
  end;

  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
               and p.proname in ('rls_all_warehouses_org_ids', 'rls_cc_unheaded_count_ids', 'cc_ai_scan_in_count')) then
    v_bad := v_bad || ' a helper this file creates already exists;';
  end if;

  if v_bad <> '' then
    raise exception 'cc_scope_preflight:%', v_bad using errcode = '55000', hint = 'cc_scope_preflight';
  end if;
end
$pre_s48$;

-- ═══ 1. The lock prelude ═══════════════════════════════════════════════════
do $lock_s48$
declare
  v_grants text := nullif(current_setting('supautils.policy_grants', true), '');
  v_name   text;
  v_rel    regclass;
  v_try    integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.cycle_counts, public.cycle_count_lines, public.cycle_count_ai_scans, storage.objects
        in access exclusive mode nowait;
      lock table only public.organization_members, public.inventory_items in access share mode nowait;
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
end $lock_s48$;

-- ═══ 2. Helpers ════════════════════════════════════════════════════════════
create function public.rls_all_warehouses_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.organization_id
  from public.organization_members m
  where m.user_id = auth.uid()
    and m.accepted_at is not null
    and (m.impersonation_expires_at is null or m.impersonation_expires_at > now())
    and (m.role in ('owner', 'admin', 'manager') or m.all_warehouses)
    and not public.account_is_disabled(auth.uid());
$$;

revoke all on function public.rls_all_warehouses_org_ids() from public, anon;
grant execute on function public.rls_all_warehouses_org_ids() to authenticated, service_role;

comment on function public.rls_all_warehouses_org_ids() is
  'S48. The organizations where the caller reads every warehouse''s cycle counts: owner, admin or manager, or the '
  '0280 all_warehouses flag (the web''s hasAllAccess); accepted, not an expired Act-as seat, account not disabled. '
  'A set for RLS (col IN (SELECT ...), hashed once per statement).';

create function public.rls_cc_unheaded_count_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select c.id
  from public.cycle_counts c
  where auth.uid() is not null
    and c.organization_id in (select public.rls_member_org_ids())
    and c.warehouse_id is null
    and exists (
      select 1 from public.cycle_count_lines l
       where l.cycle_count_id = c.id
         and l.warehouse_id in (select mw.warehouse_id from public.my_warehouse_ids() mw)
    );
$$;

revoke all on function public.rls_cc_unheaded_count_ids() from public, anon;
grant execute on function public.rls_cc_unheaded_count_ids() to authenticated, service_role;

comment on function public.rls_cc_unheaded_count_ids() is
  'S48. Ids of the caller''s organizations'' cycle counts with no header warehouse that have a line in one of the '
  'caller''s warehouses (my_warehouse_ids). For cycle_counts_select and cycle_count_line_progress only; a set, '
  'hashed once per statement. SECURITY DEFINER so the count rule can ask about lines without recursing into the '
  'line rule.';

create function public.cc_ai_scan_in_count(p_scan_id uuid, p_cycle_count_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
     and exists (
       select 1 from public.cycle_count_ai_scans s
        where s.id = p_scan_id
          and s.cycle_count_id = p_cycle_count_id
          and s.organization_id in (select public.rls_member_org_ids())
     );
$$;

revoke all on function public.cc_ai_scan_in_count(uuid, uuid) from public, anon;
grant execute on function public.cc_ai_scan_in_count(uuid, uuid) to authenticated, service_role;

comment on function public.cc_ai_scan_in_count(uuid, uuid) is
  'S48. True when the AI scan belongs to the cycle count, whoever may read the scan. For the line UPDATE rule''s '
  'link check only (0368), so a counter can recount or clear a line another person recorded from an AI scan they '
  'may not read. Answers only inside the caller''s own organizations (no cross-organization oracle, '
  'docs/security/data-classification.md), about two ids the caller already holds.';

-- ═══ 3. Line progress (0358) counts the lines the caller may read ═════════
create or replace function public.cycle_count_line_progress(
  p_organization_id uuid,
  p_count_ids       uuid[]
)
returns table (cycle_count_id uuid, line_total bigint, line_counted bigint)
language sql
stable
security definer
set search_path = public
as $$
  select
    l.cycle_count_id,
    count(*)::bigint as line_total,
    count(*) filter (where l.counted_quantity is not null)::bigint as line_counted
  from public.cycle_counts c
  join public.cycle_count_lines l on l.cycle_count_id = c.id
  where public.is_org_member(p_organization_id)
    and cardinality(p_count_ids) <= 100
    and c.organization_id = p_organization_id
    and c.id = any(p_count_ids)
    -- S48: only the lines the caller may read. Restates
    -- cycle_count_lines_select (a manager reads every line; anyone else a
    -- line in one of their warehouses whose item inventory_items_select lets
    -- them read) and the non-manager arms of cycle_counts_select.
    and (
      p_organization_id in (select public.rls_manager_org_ids())
      or (
        l.warehouse_id in (select mw.warehouse_id from public.my_warehouse_ids() mw)
        and (
          p_organization_id in (select public.rls_all_warehouses_org_ids())
          or c.warehouse_id in (select mw.warehouse_id from public.my_warehouse_ids() mw)
          or (c.warehouse_id is null
              and (c.assigned_to = auth.uid()
                   or c.id in (select public.rls_cc_unheaded_count_ids())))
        )
        and exists (
          select 1 from public.inventory_items i
           where i.id = l.item_id
             and (
               i.warehouse_id in (select public.rls_inv_read_full_warehouse_ids())
               or (i.charter_id is null
                   and i.warehouse_id in (select public.rls_inv_read_assigned_warehouse_ids()))
               or (i.warehouse_id, i.charter_id) in (select * from public.rls_inv_read_warehouse_charter_ids())
             )
             and (
               i.organization_id in (select public.rls_cat_unrestricted_org_ids())
               or (i.organization_id, i.category_id) in (select * from public.rls_cat_allowed_category_ids())
             )
        )
      )
    )
  group by l.cycle_count_id
$$;

comment on function public.cycle_count_line_progress(uuid, uuid[]) is
  'Line totals and counted lines for up to 100 cycle counts of one org, for the history list. SECURITY DEFINER only '
  'to skip per-line RLS; gated in the body on is_org_member(p_organization_id), restricted to that org''s counts, and '
  'since S48 counting only the lines the caller may read: it restates cycle_count_lines_select, the non-manager arms '
  'of cycle_counts_select and inventory_items_select (0229). The parity is tested; change it with any of those '
  'policies. authenticated may execute.';

comment on function public.cycle_counts_page(uuid, bigint, text, text, uuid, uuid, boolean, timestamptz, uuid[], integer, integer) is
  'One page of an org''s cycle-count history, newest first (started_at desc, id desc): exact count_number lookup or '
  'literal notes/warehouse-name search, status/warehouse/assignee/started-from filters, optional warehouse-scope '
  'narrowing, total_count and effective_page (clamped) from the same filtered set, and per-count line progress for '
  'the returned page only. SECURITY INVOKER: since S48 cycle_counts_select limits it to the counts of the caller''s '
  'warehouses (every count for owner, admin, manager or an all-warehouses member; a count with no header warehouse '
  'when assigned to the caller or touching one of their warehouses). p_scope_warehouse_ids only narrows that '
  'further (null: no narrowing; empty: only the caller''s own null-warehouse assignments). authenticated may '
  'execute; anon/public revoked.';

-- ═══ 4. The line UPDATE rule's scan link asks cc_ai_scan_in_count ═════════
-- The USING clause is untouched; the WITH CHECK is 0368's with its last arm
-- changed from a read of cycle_count_ai_scans under the caller's RLS.
alter policy cycle_count_lines_update on public.cycle_count_lines
  with check (
    exists (
      select 1 from public.cycle_counts cc
       where cc.id = cycle_count_lines.cycle_count_id
         and (select public.has_org_role(cc.organization_id, 'staff'))
         and cc.status = 'in_progress'
         and (
           cc.assigned_to = (select auth.uid())
           or cc.assigned_to is null
           or (select public.has_org_role(cc.organization_id, 'manager'))
         )
         and (select public.has_permission(cc.organization_id, 'stock:adjust'))
         and (
           (cycle_count_lines.warehouse_id is null
              and (select public.has_org_role(cc.organization_id, 'manager')))
           or public.user_can_access_warehouse((select auth.uid()), cycle_count_lines.warehouse_id, 'write')
         )
    )
    and (counted_by is null or counted_by = (select auth.uid()))
    and (
      ai_scan_id is null
      or public.cc_ai_scan_in_count(cycle_count_lines.ai_scan_id, cycle_count_lines.cycle_count_id)
    )
  );

-- ═══ 5. The three table read rules ═════════════════════════════════════════
drop policy if exists cycle_counts_select on public.cycle_counts;
create policy cycle_counts_select on public.cycle_counts
  for select to authenticated
  using (
    cycle_counts.organization_id in (select public.rls_member_org_ids())
    and (
      cycle_counts.organization_id in (select public.rls_all_warehouses_org_ids())
      or cycle_counts.warehouse_id in (select mw.warehouse_id from public.my_warehouse_ids() mw)
      or (cycle_counts.warehouse_id is null
          and (cycle_counts.assigned_to = (select auth.uid())
               or cycle_counts.id in (select public.rls_cc_unheaded_count_ids())))
    )
  );

-- The count is read under cycle_counts_select (nested RLS), and the item
-- under inventory_items_select, as stock_movements_select reads it (0321).
drop policy if exists cycle_count_lines_select on public.cycle_count_lines;
create policy cycle_count_lines_select on public.cycle_count_lines
  for select to authenticated
  using (
    exists (
      select 1 from public.cycle_counts cc
       where cc.id = cycle_count_lines.cycle_count_id
         and (
           cc.organization_id in (select public.rls_manager_org_ids())
           or (
             cycle_count_lines.warehouse_id in (select mw.warehouse_id from public.my_warehouse_ids() mw)
             and exists (
               select 1 from public.inventory_items i
                where i.id = cycle_count_lines.item_id
             )
           )
         )
    )
  );

drop policy if exists cc_ai_scans_select on public.cycle_count_ai_scans;
create policy cc_ai_scans_select on public.cycle_count_ai_scans
  for select to authenticated
  using (
    (
      cycle_count_ai_scans.created_by = (select auth.uid())
      or cycle_count_ai_scans.organization_id in (select public.rls_manager_org_ids())
    )
    and exists (
      select 1 from public.cycle_counts cc
       where cc.id = cycle_count_ai_scans.cycle_count_id
         and cc.organization_id = cycle_count_ai_scans.organization_id
    )
  );

-- ═══ 6. LAST: the bucket's policies (storage-policy-order guard) ══════════
-- The path is {org}/{count}/{uuid}.{ext} (the ai-scan route). A second folder
-- that is not a uuid matches no count (no cast error); the path must start
-- with the count's own organization. No COMMENT ON POLICY: storage.objects
-- belongs to the storage admin (0381). The route uploads and signs with the
-- service role, so no API role writes or removes a scan photo (S52).
drop policy if exists "cycle-count-scans org read" on storage.objects;
create policy "cycle-count-scans org read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'cycle-count-scans'
    and exists (
      select 1 from public.cycle_counts cc
       where cc.id = (case when split_part(objects.name, '/', 2)
                                ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                           then split_part(objects.name, '/', 2)::uuid end)
         and starts_with(objects.name, cc.organization_id::text || '/')
         and cc.organization_id in (select public.rls_manager_org_ids())
    )
  );

drop policy if exists "cycle-count-scans org write" on storage.objects;
drop policy if exists "cycle-count-scans manager delete" on storage.objects;

reset lock_timeout;
