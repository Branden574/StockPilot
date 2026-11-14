-- Cycle count rows are read by members who hold a count permission, and the
-- Exception Center reads its recount facts through one function (docket S93).
--
-- ── THE RULE ───────────────────────────────────────────────────────────────
-- "Counts" = rls_orgs_with_permission('cycle_counts:read') or
-- rls_orgs_with_permission('stock:adjust'): the organizations where the
-- caller holds either count permission (has_permission: owner always, else
-- the member's override, else the role's override, else the role default;
-- an accepted, unexpired seat on an account that is not disabled). Both are
-- sets the planner hashes once per statement (0279), never a call per row.
--   count  0452's rule AND its organization is in "counts"
--   line   0452's rule AND its count's organization is in "counts"
-- Role defaults: owner, admin, manager and staff hold both; a viewer holds
-- neither until granted one (an auditor gets cycle_counts:read). The web's
-- count pages, the count PDF and the phone sync ask the same pair
-- (apps/web/src/server/services/cycle-counts.ts listPage, the count page,
-- api/v1/mobile/snapshot).
--
-- cycle_count_line_progress (SECURITY DEFINER) restates the line rule, so it
-- gains the same term (its parity with the table read is tested for every
-- persona). cycle_counts_page, cycle_count_summary, cycle_count_lines_page
-- and cycle_count_line_rechecks are SECURITY INVOKER and follow the rules.
-- item_verification_summaries (the item page's Physical count card, read by
-- anyone who may read the item) is unchanged: the card is a designed
-- feature for every item reader.
--
-- exception_recount_facts(p_org uuid, p_exception_ids uuid[]) is new,
-- gated as item_verification_summaries is (a signed-in, accepted, enabled
-- member of p_org; only p_org's rows): for each exception of p_org the
-- caller may see (_exc_occurrence_visible, the rule
-- exception_occurrences_select states as sets, 0370), the counts it names
-- (its open recount, the counts its timeline names, the count that confirmed
-- it) with their number, status and completed time; for its open recount and
-- its closed recounts, the line of the exception's own item (counted, on
-- record, whether it re-checks the item, 0372); for an open recount, the
-- lines counted of the lines the caller's warehouses hold (what the progress
-- shows today). Never another item's line, never another count. At most 500
-- ids (22023 too_many_exceptions); no signed-in user, or not a member of
-- p_org: no rows. Its gate states _exc_occurrence_visible term by term in a
-- form computed once per call (the manager role asked once, the item and
-- holding terms as the set helpers), and an open recount's progress is
-- computed once per count however many exceptions name it: 500 exceptions
-- on one 20,000-line count answer in one pass over that count's lines.
--
-- ── WHAT THIS MIGRATION DOES ───────────────────────────────────────────────
--   0. Preflight: the policy texts on both tables, the bodies this file
--      builds on or restates, their owners and security modes are the ones it
--      was proven against (as 0452 left them); the new name is free.
--   1. One lock prelude.
--   2. exception_recount_facts created: STABLE SECURITY DEFINER, search_path
--      '', owner postgres, EXECUTE revoked from PUBLIC and anon, granted to
--      authenticated and service_role.
--   3. cycle_count_line_progress restated (same signature, result, STABLE,
--      SECURITY DEFINER, search_path public, owner and grants).
--   4. cycle_counts_select and cycle_count_lines_select recreated: 0452's
--      bodies with the permission term added.
--   5. notify pgrst, 'reload schema' (PostgREST learns the new function at
--      commit).
-- Applied as one transaction (the CLI runs each migration file as one). No
-- row is written, changed or removed; no table, column, view or sequence is
-- created, dropped or changed. Tier A.
--
-- ── LOCKS ──────────────────────────────────────────────────────────────────
-- DROP POLICY and CREATE POLICY take ACCESS EXCLUSIVE on their table and,
-- through supautils, on every table supautils.policy_grants lists for this
-- role. The SQL function and the line rule read cycle_counts,
-- cycle_count_lines and inventory_items when created (ACCESS SHARE). One
-- prelude takes all of them at once, NOWAIT, retrying up to 40 times 50-150
-- ms apart holding nothing between attempts (0390, 0420, 0452); after it no
-- statement takes a new table lock. From the prelude to commit
-- (milliseconds), count reads and writes, sign-ins, token refreshes and
-- storage reads wait. lock_timeout 900ms bounds anything unforeseen.
--
-- ── ERRORS ─────────────────────────────────────────────────────────────────
-- The push raises 55000 hint cc_perm_preflight (drift or a second run:
-- nothing applied) or 55P03 (busy after 40 attempts: nothing applied, run it
-- again). Never 40001 or 40P01. Reads answer fewer rows and never raise.
--
-- ── ROLLBACK (the owner's call only) ───────────────────────────────────────
-- A forward migration: recreate cycle_counts_select and
-- cycle_count_lines_select from 0452_cycle_count_warehouse_scope.sql,
-- restate cycle_count_line_progress from the same file, and drop
-- exception_recount_facts (the web reads the recount facts directly when the
-- function is missing). The migration stays recorded as applied, and the
-- digest pin test (digest_reader_policies) then fails until the digest's
-- copy of the rules is reverted with it.

set lock_timeout = '900ms';

-- ═══ 0. Preflight ══════════════════════════════════════════════════════════
do $pre_s93$
declare
  v_bad text := '';
  r     record;
begin
  for r in
    select v.sig, v.want, v.want_alt, v.definer, p.oid as poid, md5(p.prosrc) as got, p.prosecdef,
           pg_get_userbyid(p.proowner) as owner
      from (values
        ('public.cycle_count_line_progress(uuid,uuid[])',            '351b3ca33d573ff628430a8cd180be16',      null::text, true),
        ('public.rls_orgs_with_permission(text)',                    'c346a5c3447b75be554030c0e505a497',      null, true),
        ('public.has_permission(uuid,text)',                         'cc0accdad7e2fdf4f88aa82aa887e85f',       null, true),
        ('public.rls_member_org_ids()',                              '68860888450deeef2bbf628712c5b971', null, true),
        ('public.rls_manager_org_ids()',                             '7414b7d514144687e01ec6b41cb407dd', null, true),
        ('public.rls_all_warehouses_org_ids()',                      'e8bc60dd3c17cb4b039fdd6f280b9447',         null, true),
        ('public.rls_cc_unheaded_count_ids()',                       '56b7a792996568124e836d63c5b0d0a0',      null, true),
        -- 0310's body, or docket S47's (the same body with one expiry term).
        ('public.my_warehouse_ids()',                                '7129bb768bce52a1ec1271be95afdffc',
                                                                     'eacc28d3bd2d1ebd09242f61b8a094ad', true),
        ('public._exc_occurrence_visible(uuid,uuid,uuid)',           '62662f8300373203ad06b7a64d147c0c',        null, true),
        -- its item term, stated inline by exception_recount_facts
        ('public.caller_can_read_item(uuid)',                        '80523d2cc0fafe7fc6b3599903d7f014',       null, true),
        ('public.cycle_count_line_rechecks(public.cycle_count_lines)', 'd9b450a79b8b516c891fa79db1a021e7',    null, false),
        ('public.rls_inv_read_full_warehouse_ids()',                 '740c1d4753a3a67b8f8cae850c4c6a0e',       null, true),
        ('public.rls_inv_read_assigned_warehouse_ids()',             'b4f82ab8aa1d63be4da042966c205014',   null, true),
        ('public.rls_inv_read_warehouse_charter_ids()',              '673be48e784a59e56785391b9ec1fd5f',    null, true),
        ('public.rls_cat_unrestricted_org_ids()',                    '21ed57ccaa86b958fccbb08a621baf97',        null, true),
        ('public.rls_cat_allowed_category_ids()',                    'c907f373f976df4586d340e9dbac6308',    null, true)
      ) v(sig, want, want_alt, definer)
      left join pg_proc p on p.oid = to_regprocedure(v.sig)
  loop
    if r.poid is null then
      v_bad := v_bad || format(' %s missing;', r.sig);
    elsif (r.got <> r.want and r.got is distinct from r.want_alt) or r.owner <> 'postgres'
          or r.prosecdef <> r.definer then
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
          ('public.cycle_counts',          'cycle_counts_select',           '926f1c972a2d8b733f61c47182028480'),
          ('public.cycle_counts',          'cycle_counts_insert',           'a06c0c759a2235e7aafe46d5e0be4f57'),
          ('public.cycle_counts',          'cycle_counts_update',           '4680800e8ae02cb9310346b37e9c1ef3'),
          ('public.cycle_count_lines',     'cycle_count_lines_select',      'bf814de36bcaf045b7136f4925e85a72'),
          ('public.cycle_count_lines',     'cycle_count_lines_insert',      'a8e50cfddc3f3bf6008b3c283f80d680'),
          ('public.cycle_count_lines',     'cycle_count_lines_update',      'f14d02d1d22e696b247141921025fe84'),
          ('public.cycle_count_lines',     'cycle_count_lines_delete',      'e16b06816c71f498a1657a2987c916c1'),
          -- restated inside the two functions below
          ('public.inventory_items',       'inventory_items_select',        '50f899e6c521707f652fa4c90c2886e1'),
          -- the rule _exc_occurrence_visible states row by row
          ('public.exception_occurrences', 'exception_occurrences_select',  '13762dab256fc22d5ec985d3eaab36f0')
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
           where c.oid in ('public.cycle_counts'::regclass, 'public.cycle_count_lines'::regclass)
              or (c.oid = 'public.inventory_items'::regclass and pol.polname = 'inventory_items_select')
              or (c.oid = 'public.exception_occurrences'::regclass and pol.polname = 'exception_occurrences_select')
        ) g on g.tbl = v.tbl and g.pol = v.pol
    loop
      if r.want is null then
        v_bad := v_bad || format(' unexpected policy %s on %s;', r.pol, r.tbl);
      elsif r.got is distinct from r.want then
        v_bad := v_bad || format(' policy %s on %s drifted (%s);', r.pol, r.tbl, coalesce(r.got, 'missing'));
      end if;
    end loop;
    raise exception using errcode = 'XXS93', message = 'undo';
  exception when sqlstate 'XXS93' then
    null;
  end;

  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
               and p.proname = 'exception_recount_facts') then
    v_bad := v_bad || ' exception_recount_facts already exists;';
  end if;

  if v_bad <> '' then
    raise exception 'cc_perm_preflight:%', v_bad using errcode = '55000', hint = 'cc_perm_preflight';
  end if;
end
$pre_s93$;

-- ═══ 1. The lock prelude ═══════════════════════════════════════════════════
do $lock_s93$
declare
  v_grants text := nullif(current_setting('supautils.policy_grants', true), '');
  v_name   text;
  v_rel    regclass;
  v_try    integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.cycle_counts, public.cycle_count_lines in access exclusive mode nowait;
      lock table only public.inventory_items in access share mode nowait;
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
end $lock_s93$;

-- ═══ 2. exception_recount_facts ════════════════════════════════════════════
create function public.exception_recount_facts(p_org uuid, p_exception_ids uuid[])
returns table (
  exception_id      uuid,
  cycle_count_id    uuid,
  is_active_recount boolean,
  is_closed_recount boolean,
  count_number      bigint,
  status            text,
  completed_at      timestamptz,
  line_total        bigint,
  line_counted      bigint,
  line_found        boolean,
  counted_quantity  numeric,
  expected_quantity numeric,
  rechecks          boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_manager boolean;
begin
  -- Gate 1: a signed-in caller, arguments present, at most 500 ids.
  if auth.uid() is null or p_org is null or p_exception_ids is null then
    return;
  end if;
  if cardinality(p_exception_ids) > 500 then
    raise exception 'too_many_exceptions' using errcode = '22023', hint = 'too_many_exceptions';
  end if;
  -- Gate 2: an accepted, enabled member of the organization asked about.
  if not public.is_org_member(p_org) then
    return;
  end if;
  -- The same for every exception of p_org: asked once.
  v_manager := public.has_org_role(p_org, 'manager');

  return query
  with occ as materialized (
    -- Gate 3, per exception: of p_org, and the caller may see it:
    -- _exc_occurrence_visible(o.organization_id, o.item_id, o.location_id)
    -- (0370), term by term, each in a form computed once per call:
    --   is_org_member(p_org)            Gate 2 (o.organization_id = p_org)
    --   caller_can_read_item(o.item_id)  its body (0361): a signed-in caller
    --                                    (Gate 1) and the item under the five
    --                                    set helpers
    --   has_org_role(p_org, 'manager')   v_manager
    --   the holding's location           its body
    select o.id, o.organization_id, o.item_id, o.recount_cycle_count_id, o.confirmed_cycle_count_id
      from public.exception_occurrences o
     where o.id = any (p_exception_ids)
       and o.organization_id = p_org
       and exists (
         select 1
           from public.inventory_items it
          where it.id = o.item_id
            and (it.warehouse_id in (select public.rls_inv_read_full_warehouse_ids())
                 or (it.charter_id is null
                     and it.warehouse_id in (select public.rls_inv_read_assigned_warehouse_ids()))
                 or (it.warehouse_id, it.charter_id) in
                    (select r.warehouse_id, r.charter_id from public.rls_inv_read_warehouse_charter_ids() r))
            and (it.organization_id in (select public.rls_cat_unrestricted_org_ids())
                 or (it.organization_id, it.category_id) in
                    (select c.organization_id, c.category_id from public.rls_cat_allowed_category_ids() c))
       )
       and (o.location_id is null
            or v_manager
            or exists (
                 select 1
                   from public.locations l
                  where l.id = o.location_id
                    and (l.warehouse_id is null
                         or l.warehouse_id in (select mw.warehouse_id from public.my_warehouse_ids() mw))))
  ),
  named as (
    -- The counts the exception names: its open recount, the count that
    -- confirmed it, and every count its timeline names.
    select n.exception_id, n.cycle_count_id, bool_or(n.active) as active, bool_or(n.closed) as closed
      from (
        select x.id as exception_id, x.recount_cycle_count_id as cycle_count_id, true as active, false as closed
          from occ x
         where x.recount_cycle_count_id is not null
        union all
        select x.id, x.confirmed_cycle_count_id, false, false
          from occ x
         where x.confirmed_cycle_count_id is not null
        union all
        select x.id, e.cycle_count_id, false, e.kind = 'recount_closed'
          from occ x
          join public.exception_occurrence_events e
            on e.occurrence_id = x.id
           and e.organization_id = x.organization_id
         where e.cycle_count_id is not null
      ) n
     group by n.exception_id, n.cycle_count_id
  ),
  prog as (
    -- An open recount's progress, once per count however many exceptions
    -- name it: the lines the caller's warehouses hold whose item they may
    -- read (a manager: every line), as 0452's line rule reads them; 0 of 0
    -- when none.
    select pc.id as cycle_count_id,
           count(pl.id)::bigint as line_total,
           count(pl.id) filter (where pl.counted_quantity is not null)::bigint as line_counted
      from (select distinct d.cycle_count_id from named d where d.active or d.closed) dc
      join public.cycle_counts pc
        on pc.id = dc.cycle_count_id
       and pc.organization_id = p_org
       and pc.status::text = 'in_progress'
      left join public.cycle_count_lines pl
        on pl.cycle_count_id = pc.id
       and (
         pc.organization_id in (select public.rls_manager_org_ids())
         or (
           pl.warehouse_id in (select mw.warehouse_id from public.my_warehouse_ids() mw)
           and exists (
             select 1 from public.inventory_items i
              where i.id = pl.item_id
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
     group by pc.id
  )
  select nm.exception_id,
         c.id,
         nm.active,
         nm.closed,
         c.count_number::bigint,
         c.status::text,
         c.completed_at,
         pr.line_total,
         pr.line_counted,
         case when wl.with_line then l.id is not null end,
         case when wl.with_line then l.counted_quantity::numeric end,
         case when wl.with_line then l.expected_quantity::numeric end,
         case when wl.with_line and l.id is not null then public.cycle_count_line_rechecks(l) end
    from named nm
    join occ x on x.id = nm.exception_id
    join public.cycle_counts c
      on c.id = nm.cycle_count_id
     and c.organization_id = x.organization_id
    -- The item's line, for a recount that is open or posted (what the
    -- outcome words read).
    cross join lateral (
      select (nm.active or nm.closed) and c.status::text in ('in_progress', 'completed') as with_line
    ) wl
    left join public.cycle_count_lines l
      on wl.with_line
     and l.cycle_count_id = c.id
     and l.item_id = x.item_id
    -- An open recount's progress (prog, once per count).
    left join prog pr
      on pr.cycle_count_id = c.id
     and (nm.active or nm.closed)
     and c.status::text = 'in_progress'
   order by nm.exception_id, c.id;
end;
$$;

alter function public.exception_recount_facts(uuid, uuid[]) owner to postgres;
revoke all on function public.exception_recount_facts(uuid, uuid[]) from public, anon;
grant execute on function public.exception_recount_facts(uuid, uuid[]) to authenticated, service_role;

comment on function public.exception_recount_facts(uuid, uuid[]) is
  'S93. The recount facts the Exception Center shows, for up to 500 exceptions of p_org the caller may see '
  '(is_org_member(p_org), then _exc_occurrence_visible, 0370, stated as sets): per count the exception names (its open recount, the counts its timeline '
  'names, the count that confirmed it) the number, status and completed time; for its open and closed recounts, '
  'the line of the exception''s own item (counted, on record, cycle_count_line_rechecks); for an open recount, the '
  'lines counted of the lines in the caller''s warehouses (every line for a manager), once per count. Never another item''s line, '
  'never another count. No signed-in user: no rows; over 500 ids: 22023 too_many_exceptions. STABLE SECURITY '
  'DEFINER, search_path empty; EXECUTE to authenticated and service_role.';

-- ═══ 3. Line progress (0358, 0452) counts lines only for count readers ═══
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
    -- S93: only for a caller who holds a count permission there.
    and (
      p_organization_id in (select public.rls_orgs_with_permission('cycle_counts:read'))
      or p_organization_id in (select public.rls_orgs_with_permission('stock:adjust'))
    )
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
  'to skip per-line RLS; gated in the body on is_org_member(p_organization_id), restricted to that org''s counts, '
  'since S93 answered only to a caller holding cycle_counts:read or stock:adjust there, and since S48 counting only '
  'the lines the caller may read: it restates cycle_count_lines_select, the non-manager arms of cycle_counts_select '
  'and inventory_items_select (0229). The parity is tested; change it with any of those policies. authenticated may '
  'execute.';

-- ═══ 4. The two read rules ════════════════════════════════════════════════
-- 0452's bodies, each with the count permission term.
drop policy if exists cycle_counts_select on public.cycle_counts;
create policy cycle_counts_select on public.cycle_counts
  for select to authenticated
  using (
    cycle_counts.organization_id in (select public.rls_member_org_ids())
    and (
      cycle_counts.organization_id in (select public.rls_orgs_with_permission('cycle_counts:read'))
      or cycle_counts.organization_id in (select public.rls_orgs_with_permission('stock:adjust'))
    )
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
           cc.organization_id in (select public.rls_orgs_with_permission('cycle_counts:read'))
           or cc.organization_id in (select public.rls_orgs_with_permission('stock:adjust'))
         )
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

-- Make exception_recount_facts visible to PostgREST at commit.
notify pgrst, 'reload schema';

reset lock_timeout;
