-- 0230_dashboard_snapshot_rollups.sql
--
-- DASHBOARD SNAPSHOT ROLLUPS: the overview at ANY org size reads ~90 tiny
-- precomputed rows instead of recomputing 90 days from raw stock_movements
-- per render.
--
-- ── WHY (measured on prod-scale, 50k items / 1.2M movements, authenticated) ──
-- After the 0228 event-based rewrite + 0229 hashed-set RLS, the dashboard RPCs
-- still cost ~4s (dashboard_history_series, 90d) + 791ms
-- (dashboard_movement_metrics) PER RENDER: both re-derive the whole window
-- from raw stock_movements/inventory_items every time. That work is identical
-- render-to-render for every closed day — only "today" changes. Target after
-- this migration: <100ms each (closed days = an index-range read of ≤120
-- snapshot rows; today = one indexed org pass).
--
-- ══════════════════════════════════════════════════════════════════════════
-- THE SEMANTIC UPGRADE (deliberate — read this before comparing outputs)
-- ══════════════════════════════════════════════════════════════════════════
-- OLD (0224/0228): every day bucket was a ROLLING 24-hour window anchored at
-- now() — "day 0" = [now−N·24h, now−(N−1)·24h) — and every day's numbers were
-- RECONSTRUCTED backward from current state (current qty minus later
-- movement deltas, valued at current unit_cost). Two consequences: the same
-- calendar day's number changed with the hour you loaded the dashboard, and
-- history silently rewrote itself when items were deleted or costs edited.
--
-- NEW (this migration): closed days are OBSERVED UTC-calendar-day closes —
-- the nightly cron (00:10 UTC) snapshots each org's actual state minutes
-- after the day closes and the row NEVER changes again (observed history
-- does not rewrite). TODAY — and only today — is computed live from current
-- state. This is more truthful (a real observation at each midnight instead
-- of a reconstruction that decays with cost drift/deletions) and is exactly
-- what makes precompute possible. Deltas a caller can notice:
--   • day boundaries are UTC midnights, not now()-anchored 24h marks;
--   • a closed day's number no longer drifts when unit_cost is edited or an
--     item is deleted after the fact;
--   • org_daily_movement_stats counts EVERY movement in the day slice —
--     including movements whose item was later soft-deleted/archived (the
--     old function retroactively dropped deleted items' movements). Note
--     this is not a data-exposure change: stock_movements SELECT RLS is
--     org-membership-only (0229), so org members could always read these.
-- Return SHAPE and row counts are UNCHANGED (history: one row per day_index
-- 0..N−1 oldest→newest, same columns; metrics: sparse (day_index, type,
-- count) rows) so movements.ts mappers need zero changes.
--
-- ── READ-PATH DECISION TREE (both public functions) ─────────────────────────
--   p_warehouse_id IS NOT NULL → snapshots are ORG-WIDE, so delegate the
--       whole call to the *_reconstructed function (old math, RLS-scoped).
--       Warehouse-scoped snapshot rows are out of scope for this migration.
--   any closed day in the window missing from org_daily_stats → delegate the
--       whole window to *_reconstructed (correct-but-slower; keeps the
--       dashboard working before backfill/cron catch up, for orgs created
--       after this migration, and for every caller whose RLS view of
--       org_daily_stats is empty: authenticated non-members — preserving the
--       all-zero cross-org behavior 0224 pinned — AND warehouse/category-
--       restricted members, whom the manager+ SELECT policy blocks entirely
--       (see the ACCESS-SCOPE note)). org_daily_stats is the completeness
--       sentinel for BOTH functions: the two tables are written by the same
--       refresh, and org_daily_movement_stats alone cannot distinguish "zero
--       movements that day" from "never snapshotted".
--   otherwise → closed days from the snapshot tables (RLS scopes to the
--       caller's orgs) + the TODAY row computed live (history: one indexed
--       pass over inventory_items under RLS; metrics: today's
--       stock_movements slice grouped by type).
--
-- ── ACCESS-SCOPE NOTE (deliberate, decided) ─────────────────────────────────
-- Two tiers, mirroring the app's canUseSharedInventoryCaches philosophy
-- (manager+ share org-wide artifacts; restricted members always compute their
-- own scoped view):
--   • MANAGER+ (owner/admin/manager — exactly the population 0229 grants
--     full item visibility): may SELECT org_daily_stats and take the
--     snapshot fast path. Their series is org-wide END TO END — closed days
--     are org-wide observations and their TODAY row aggregates the whole
--     org (their inventory_items RLS view IS the org). No scope mixing.
--   • RESTRICTED members (staff/viewer, scoped per warehouse/category by
--     0229): the manager+ SELECT policy (rls_manager_org_ids) shows them
--     ZERO org_daily_stats rows, so the read functions' completeness
--     sentinel counts 0 < v_days−1 and sends the WHOLE window down the
--     reconstructed path — fully caller-RLS-scoped, exactly the pre-0230
--     behavior. A member-wide policy here would have (a) let them read
--     org-wide valuation aggregates straight off PostgREST — the exposure
--     0224 explicitly rejected — and (b) mixed org-wide closed days with a
--     restricted TODAY row in one series (a fake overnight collapse).
-- org_daily_movement_stats stays MEMBER-readable (rls_member_org_ids):
-- stock_movements SELECT RLS is already org-wide for every member (0229), so
-- per-day type counts expose nothing new. Its read function still sentinels
-- on org_daily_stats, so a restricted member's metrics call also falls back
-- to the reconstructed (caller-scoped) math. The dashboard passes
-- p_warehouse_id for warehouse-filtered views, which always takes the fully
-- RLS-scoped reconstructed path regardless of role.
--
-- ── PIECES ──────────────────────────────────────────────────────────────────
--   1. org_daily_stats / org_daily_movement_stats  (snapshot tables + RLS)
--   2. dashboard_history_series_reconstructed      (0228 body, rename-copy)
--      dashboard_movement_metrics_reconstructed    (0224 body, rename-copy)
--   3. refresh_org_daily_stats(p_org, p_days_back) (SECURITY DEFINER upsert)
--   4. pg_cron nightly job at 00:10 UTC            (tolerant if unavailable)
--   5. dashboard_history_series / dashboard_movement_metrics REPLACED with
--      snapshot-first read paths (same signature/returns/INVOKER/grants)
--   6. one-time backfill: refresh_org_daily_stats(null, 120)

-- ────────────────────────────────────────────────────────────────────────────
-- 1) Snapshot tables.
--    One row per (org, closed UTC day) — ~90 rows per dashboard window.
--    Writes are service/cron only: RLS is enabled with tiered SELECT
--    policies (org_daily_stats: manager+ only; org_daily_movement_stats:
--    every member — see the ACCESS-SCOPE note) and NO insert/update/delete
--    policies, so authenticated writes are blocked by default-deny
--    (service_role and the table owner bypass RLS).
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.org_daily_stats (
  organization_id uuid        not null references public.organizations(id) on delete cascade,
  day             date        not null,
  item_count      int         not null default 0,
  inventory_value numeric     not null default 0,
  low_out_count   int         not null default 0,
  computed_at     timestamptz not null default now(),
  primary key (organization_id, day)
);

comment on table public.org_daily_stats is
  'Observed close-of-UTC-day dashboard snapshot per org (0230): active item '
  'count, cost-basis inventory value, low/out-of-stock count. Written only by '
  'refresh_org_daily_stats (nightly pg_cron 00:10 UTC + gap self-heal). '
  'Closed-day rows are observations — never rewritten by later edits. SELECT '
  'is MANAGER+ only (rls_manager_org_ids): rows are org-wide valuation '
  'aggregates, which warehouse/category-restricted members must not read.';

create table if not exists public.org_daily_movement_stats (
  organization_id uuid   not null references public.organizations(id) on delete cascade,
  day             date   not null,
  movement_type   text   not null,
  move_count      bigint not null default 0,
  primary key (organization_id, day, movement_type)
);

comment on table public.org_daily_movement_stats is
  'Per (org, UTC day, movement_type) movement counts (0230). Counts every '
  'movement in the day slice — history does not rewrite when items are later '
  'deleted/archived. Days with zero movements have no rows; completeness is '
  'sentinelled by org_daily_stats (same refresh writes both).';

alter table public.org_daily_stats enable row level security;
alter table public.org_daily_movement_stats enable row level security;

-- Manager+ org set for the org_daily_stats policy below: orgs where the
-- caller holds an accepted, unexpired owner/admin/manager membership.
-- Body = rls_member_org_ids (0229) — including its impersonation-expiry
-- guard — plus the role filter; same zero-arg / STABLE / SECURITY DEFINER /
-- pinned-search_path shape so the policy's IN-subquery hash-materializes it
-- once per statement.
create or replace function public.rls_manager_org_ids()
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
    and m.role in ('owner', 'admin', 'manager');
$$;

comment on function public.rls_manager_org_ids() is
  'RLS helper (0230): every org where auth.uid() is an accepted, unexpired MANAGER+ (owner/admin/manager) member — rls_member_org_ids (0229) with a role floor, for hashed IN probes on org-wide aggregate tables.';

revoke all on function public.rls_manager_org_ids() from public, anon;
grant execute on function public.rls_manager_org_ids() to authenticated;

-- SELECT policies via the 0229 hashed-set pattern: the helper's result
-- materializes once per statement and every row costs one hash probe.
-- TIERED by sensitivity (see the ACCESS-SCOPE note): org_daily_stats holds
-- org-wide valuation aggregates → manager+ only; org_daily_movement_stats
-- holds counts every member can already derive from stock_movements (RLS is
-- org-wide for members, 0229) → every member.
create policy org_daily_stats_select on public.org_daily_stats
  for select to authenticated
  using (organization_id in (select public.rls_manager_org_ids()));

create policy org_daily_movement_stats_select on public.org_daily_movement_stats
  for select to authenticated
  using (organization_id in (select public.rls_member_org_ids()));

-- No INSERT/UPDATE/DELETE policies: RLS default-deny blocks authenticated
-- writes. Belt-and-braces: strip the write privileges Supabase's default
-- grants hand out, so even an RLS regression can't open a write path.
revoke insert, update, delete, truncate on public.org_daily_stats          from anon, authenticated;
revoke insert, update, delete, truncate on public.org_daily_movement_stats from anon, authenticated;

-- Explicit read/write grants (don't rely on environment default privileges):
-- authenticated reads through the SELECT policy; service_role (RLS-bypassing)
-- and the owner write via refresh_org_daily_stats.
grant select on public.org_daily_stats          to authenticated;
grant select on public.org_daily_movement_stats to authenticated;
grant select, insert, update, delete on public.org_daily_stats          to service_role;
grant select, insert, update, delete on public.org_daily_movement_stats to service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 2) The reconstructed (pre-snapshot) computations, kept under new names.
--
--    dashboard_history_series_reconstructed  = migration 0228's
--    dashboard_history_series body VERBATIM (event-based low/out, rolling
--    now()-anchored 24h buckets, backward reconstruction from current state).
--    dashboard_movement_metrics_reconstructed = migration 0224's
--    dashboard_movement_metrics body VERBATIM.
--
--    They serve three callers:
--      a. refresh_org_daily_stats derives closed-day snapshots from the
--         history series (runs as the SECURITY DEFINER owner → RLS bypassed
--         → org-wide numbers, exactly what the snapshot should hold);
--      b. the replaced public read functions delegate to them for the
--         warehouse-scoped and missing-snapshot fallback paths;
--      c. nothing else — apps never call them directly.
--
--    EXECUTE: revoked from public/anon; granted to service_role AND to
--    authenticated. The authenticated grant is REQUIRED, not a convenience:
--    the public read functions stay SECURITY INVOKER (the whole 0224 security
--    design — RLS must bind the caller), so when an authenticated dashboard
--    call takes a fallback path the EXECUTE check on the inner function runs
--    against the AUTHENTICATED role. This exposes nothing new: the identical
--    body was already granted to authenticated as dashboard_history_series /
--    dashboard_movement_metrics before this migration, it is SECURITY INVOKER,
--    and RLS on inventory_items/stock_movements scopes every row it reads
--    (cross-org calls return zero rows).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.dashboard_history_series_reconstructed(
  p_organization_id uuid,
  p_warehouse_id uuid default null,
  p_days int default 30
)
returns table (
  day_index int,
  item_count int,
  inventory_value numeric,
  low_out_count int
)
language sql
stable
security invoker
set search_path = public
as $$
  with params as (
    select
      greatest(p_days, 1)                                    as days,
      greatest(p_days, 1) - 1                                as last_idx,
      now() - greatest(p_days, 1) * interval '24 hours'      as start_at
  ),
  -- Active, non-deleted, optionally warehouse-scoped items. RLS on
  -- inventory_items applies (SECURITY INVOKER) → per-warehouse/category scope.
  -- (Verbatim from 0224.)
  scope_items as (
    select
      it.id,
      coalesce(it.quantity_on_hand, 0)::numeric as qty,
      coalesce(it.unit_cost, 0)::numeric        as cost,
      coalesce(it.reorder_point, 0)::numeric    as reorder,
      it.created_at
    from public.inventory_items it
    where it.organization_id = p_organization_id
      and it.status = 'active'
      and it.deleted_at is null
      and (p_warehouse_id is null or it.warehouse_id = p_warehouse_id)
  ),
  totals as (
    select coalesce(sum(qty * cost), 0)::numeric as value_today
    from scope_items
  ),
  -- The day spine: one row per index 0..last_idx (days with no movement still
  -- need a series point). Everything below left-joins onto this.
  days as (
    select gs.d as day_index
    from params
    cross join generate_series(0, (select last_idx from params)) as gs(d)
  ),
  -- Per (item, day-bucket) net quantity_change, scope items only + in-window.
  -- Scope predicate + day-bucket clamp are VERBATIM from 0224.
  mov as (
    select
      sm.item_id,
      least(
        (select last_idx from params),
        greatest(
          0,
          (floor(extract(epoch from (sm.created_at - (select start_at from params))) / 86400))::int
        )
      ) as day_index,
      sum(coalesce(sm.quantity_change, 0))::numeric as qty_delta
    from public.stock_movements sm
    join scope_items si on si.id = sm.item_id
    where sm.organization_id = p_organization_id
      and sm.created_at >= (select start_at from params)
    group by 1, 2
  ),
  -- ── inventory value series (verbatim from 0224) ───────────────────────────
  day_value_delta as (
    select m.day_index, sum(m.qty_delta * si.cost)::numeric as value_delta
    from mov m
    join scope_items si on si.id = m.item_id
    group by m.day_index
  ),
  value_spine as (
    select d.day_index, coalesce(dvd.value_delta, 0)::numeric as value_delta
    from days d
    left join day_value_delta dvd on dvd.day_index = d.day_index
  ),
  value_series as (
    select
      vs.day_index,
      (
        (select value_today from totals)
        - coalesce(
            sum(vs.value_delta) over (
              order by vs.day_index desc
              rows between unbounded preceding and 1 preceding
            ),
            0
          )
      )::numeric as inventory_value
    from value_spine vs
  ),
  -- ── item count series (created_at forward sweep, verbatim from 0224) ──────
  -- First day index at which an item is counted (created_at ≤ start+(d+1)·24h).
  -- Items created before the window (x ≤ 0) land at day 0; every item is
  -- ≤ now() = start+days·24h so its bucket ≤ last_idx.
  item_bucket as (
    select greatest(
             0,
             ceil(extract(epoch from (si.created_at - (select start_at from params))) / 86400 - 1)::int
           ) as b
    from scope_items si
  ),
  item_bucket_counts as (
    select b as day_index, count(*)::int as c
    from item_bucket
    group by b
  ),
  item_count_series as (
    select
      d.day_index,
      coalesce(
        sum(ibc.c) over (order by d.day_index rows between unbounded preceding and current row),
        0
      )::int as item_count
    from days d
    left join item_bucket_counts ibc on ibc.day_index = d.day_index
  ),
  -- ── low / out-of-stock series (EVENT-BASED — the 0228 rewrite) ────────────
  -- Total in-window Δ per mover (nonmovers simply have no row → 0 below).
  mover_totals as (
    select m.item_id, sum(m.qty_delta)::numeric as total_delta
    from mov m
    group by m.item_id
  ),
  -- Window-start baseline: EVERY scope item's status at
  --   qty_i(before any in-window delta) = currentQty − total in-window Δ
  -- (0224's qty_i(d) formula evaluated below the item's first delta day; for
  -- nonmovers this is just currentQty — their constant status). Note: NO
  -- created_at filter, matching 0224 exactly (mid-window-created items count
  -- from day 0 with their reconstructed qty).
  base_lowout as (
    select count(*)::int as c
    from scope_items si
    left join mover_totals mt on mt.item_id = si.id
    where (si.qty - coalesce(mt.total_delta, 0))
          <= (case when si.reorder > 0 then si.reorder else 0 end)
  ),
  -- Per (mover, delta-day) suffix sum over the item's OWN delta rows (~k rows
  -- per item — never the day spine): delta_after = Σ Δ on the item's LATER
  -- delta days. The window runs over mov ALONE (narrow sort payload — joining
  -- scope_items here would drag qty/reorder through the big sort and spill);
  -- item qty/threshold join in afterwards, purely additively:
  --   qty_after  = currentQty − delta_after        (end-of-day qty from this
  --                delta day until the item's next delta day)
  --   qty_before = qty_after − Δ(this day)         (qty on the previous
  --                segment — telescopes to the baseline below the first day)
  mover_seg as (
    select
      m.item_id,
      m.day_index,
      m.qty_delta,
      coalesce(
        sum(m.qty_delta) over (
          partition by m.item_id
          order by m.day_index desc
          rows between unbounded preceding and 1 preceding
        ),
        0
      )::numeric as delta_after
    from mov m
  ),
  -- ±1 status-flip events, aggregated per day. Zero-net delta days (rows whose
  -- Δ sums to 0) yield qty_before = qty_after → event 0 → filtered out.
  day_status_delta as (
    select
      e.day_index,
      sum(e.status_change)::int as status_delta
    from (
      select
        ms.day_index,
        ((si.qty - ms.delta_after)
           <= (case when si.reorder > 0 then si.reorder else 0 end))::int
        - ((si.qty - ms.delta_after - ms.qty_delta)
           <= (case when si.reorder > 0 then si.reorder else 0 end))::int as status_change
      from mover_seg ms
      join scope_items si on si.id = ms.item_id
    ) e
    where e.status_change <> 0
    group by e.day_index
  ),
  -- Cumulative sum over the ~days-row spine: baseline + all events ≤ day d
  -- (events on day d take effect on day d — end-of-day, same as 0224).
  low_out_series as (
    select
      d.day_index,
      (
        (select c from base_lowout)
        + coalesce(
            sum(dsd.status_delta) over (
              order by d.day_index
              rows between unbounded preceding and current row
            ),
            0
          )
      )::int as low_out_count
    from days d
    left join day_status_delta dsd on dsd.day_index = d.day_index
  )
  select
    d.day_index,
    ics.item_count,
    vsr.inventory_value,
    los.low_out_count
  from days d
  join item_count_series ics on ics.day_index = d.day_index
  join value_series vsr       on vsr.day_index = d.day_index
  join low_out_series los     on los.day_index = d.day_index
  order by d.day_index
$$;

comment on function public.dashboard_history_series_reconstructed(uuid, uuid, int) is
  'Migration 0228''s dashboard_history_series body, verbatim (0230 rename-copy): '
  'rolling now()-anchored 24h buckets, event-based low/out, backward '
  'reconstruction from current state. Internal: feeds refresh_org_daily_stats '
  'and the warehouse/missing-snapshot fallback paths of the public read '
  'function. SECURITY INVOKER — RLS binds the caller; authenticated may '
  'execute (required: the INVOKER read function delegates here under the '
  'caller''s role — identical exposure to the pre-0230 public function).';

create or replace function public.dashboard_movement_metrics_reconstructed(
  p_organization_id uuid,
  p_warehouse_id uuid default null,
  p_days int default 30
)
returns table (
  day_index int,
  movement_type text,
  move_count bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with params as (
    select
      greatest(p_days, 1) - 1                            as last_idx,
      now() - greatest(p_days, 1) * interval '24 hours'  as start_at
  ),
  -- Non-deleted (any status), optionally warehouse-scoped items. RLS applies.
  metric_items as (
    select it.id
    from public.inventory_items it
    where it.organization_id = p_organization_id
      and it.deleted_at is null
      and (p_warehouse_id is null or it.warehouse_id = p_warehouse_id)
  )
  select
    least(
      (select last_idx from params),
      greatest(
        0,
        (floor(extract(epoch from (sm.created_at - (select start_at from params))) / 86400))::int
      )
    ) as day_index,
    sm.movement_type,
    count(*)::bigint as move_count
  from public.stock_movements sm
  join metric_items mi on mi.id = sm.item_id
  where sm.organization_id = p_organization_id
    and sm.created_at >= (select start_at from params)
  group by 1, 2
$$;

comment on function public.dashboard_movement_metrics_reconstructed(uuid, uuid, int) is
  'Migration 0224''s dashboard_movement_metrics body, verbatim (0230 '
  'rename-copy): rolling 24h buckets over the raw stock_movements window, '
  'item scope = deleted_at IS NULL. Internal: fallback callee of the public '
  'read function (warehouse-scoped / missing-snapshot paths). SECURITY '
  'INVOKER — RLS binds the caller; authenticated may execute (required by the '
  'INVOKER delegation — identical exposure to the pre-0230 public function).';

revoke all on function public.dashboard_history_series_reconstructed(uuid, uuid, int)  from public;
revoke all on function public.dashboard_history_series_reconstructed(uuid, uuid, int)  from anon;
revoke all on function public.dashboard_movement_metrics_reconstructed(uuid, uuid, int) from public;
revoke all on function public.dashboard_movement_metrics_reconstructed(uuid, uuid, int) from anon;
grant execute on function public.dashboard_history_series_reconstructed(uuid, uuid, int)   to authenticated, service_role;
grant execute on function public.dashboard_movement_metrics_reconstructed(uuid, uuid, int) to authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 3) Maintenance: refresh_org_daily_stats(p_org, p_days_back)
--
--    For each org (p_org null → every org), upsert the last p_days_back
--    CLOSED UTC days into both snapshot tables.
--
--    HOW A CLOSED DAY IS OBSERVED — you cannot observe the past from current
--    state, so:
--      • YESTERDAY at the 00:10 UTC cron: current state IS the observed
--        close (off by minutes). The reconstructed series' LAST row equals
--        current state exactly (value = value_today; low/out telescopes to
--        the current status count; item_count = all scope items), so taking
--        row day_index = p_days_back−1 as yesterday implements "snapshot
--        CURRENT state as yesterday's close" verbatim — and it is refreshed
--        with DO UPDATE so the freshest observation always wins.
--      • OLDER missed days (gap self-heal after a skipped night, and the
--        one-time backfill): derived from the event-based reconstruction
--        (dashboard_history_series_reconstructed row d ≈ the close of
--        v_today − (p_days_back − d); exact at 00:1x UTC, approximate at
--        other hours — documented reconstruction drift, same approximation
--        the old dashboard showed on every render). These are written with
--        ON CONFLICT ... WHERE s.day = yesterday, i.e. DO NOTHING for any
--        already-present older day: a previously OBSERVED close is never
--        overwritten by a reconstruction.
--    Movement stats: one grouped query over the whole lookback slice of
--    stock_movements ((org, created_at) indexed). Movement history is
--    immutable, so recounting any closed day is exact → plain DO UPDATE.
--
--    SECURITY: SECURITY DEFINER (it must see and write ALL orgs — the owner
--    bypasses RLS on the snapshot tables and inside the INVOKER reconstructed
--    function), search_path pinned, EXECUTE revoked from public/anon/
--    authenticated; only cron (runs as the migration owner), postgres and
--    service_role may call it.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.refresh_org_daily_stats(
  p_org uuid default null,
  p_days_back int default 3
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'utc')::date;
  v_back  int  := greatest(coalesce(p_days_back, 3), 1);
  v_org   uuid;
begin
  for v_org in
    select o.id from public.organizations o
    where p_org is null or o.id = p_org
  loop
    -- History stats: reconstructed series row d ↦ closed day
    -- v_today − (v_back − d); d = v_back−1 is yesterday = current state.
    -- Conflicts only update yesterday (freshest observation wins); older
    -- existing observations are left untouched (gap-fill only).
    insert into public.org_daily_stats as s
      (organization_id, day, item_count, inventory_value, low_out_count, computed_at)
    select
      v_org,
      v_today - (v_back - r.day_index),
      r.item_count,
      r.inventory_value,
      r.low_out_count,
      now()
    from public.dashboard_history_series_reconstructed(v_org, null, v_back) r
    on conflict (organization_id, day) do update
      set item_count      = excluded.item_count,
          inventory_value = excluded.inventory_value,
          low_out_count   = excluded.low_out_count,
          computed_at     = excluded.computed_at
      where s.day = v_today - 1;

    -- Movement stats: exact per-(UTC day, type) counts over the lookback
    -- slice. Immutable history → safe to overwrite on every run.
    insert into public.org_daily_movement_stats as ms
      (organization_id, day, movement_type, move_count)
    select
      v_org,
      (sm.created_at at time zone 'utc')::date,
      sm.movement_type,
      count(*)::bigint
    from public.stock_movements sm
    where sm.organization_id = v_org
      and sm.created_at >= ((v_today - v_back)::timestamp at time zone 'utc')
      and sm.created_at <  (v_today::timestamp at time zone 'utc')
    group by 2, 3
    on conflict (organization_id, day, movement_type) do update
      set move_count = excluded.move_count;
  end loop;
end;
$$;

comment on function public.refresh_org_daily_stats(uuid, int) is
  'Upserts the last p_days_back closed UTC days into org_daily_stats + '
  'org_daily_movement_stats for one org (or all orgs when p_org is null). '
  'Yesterday = current-state snapshot (DO UPDATE); older missed days = '
  'event-based reconstruction gap-fill (never overwrites an observed close). '
  'Runs nightly via pg_cron at 00:10 UTC with a 3-day lookback (self-heals a '
  'missed night). SECURITY DEFINER, service/cron only — EXECUTE revoked from '
  'public/anon/authenticated.';

revoke all on function public.refresh_org_daily_stats(uuid, int) from public;
revoke all on function public.refresh_org_daily_stats(uuid, int) from anon;
revoke all on function public.refresh_org_daily_stats(uuid, int) from authenticated;
grant execute on function public.refresh_org_daily_stats(uuid, int) to service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 4) pg_cron: nightly refresh at 00:10 UTC (3-day lookback = missed-night
--    self-heal). Idempotent: unschedule-if-exists, then schedule. Tolerant:
--    if pg_cron cannot be created in this environment (some local stacks),
--    the migration still succeeds and the read path simply keeps falling
--    back to the reconstructed functions — the coordinator verifies the job
--    exists on prod after applying.
-- ────────────────────────────────────────────────────────────────────────────

do $$
begin
  create extension if not exists pg_cron;
exception when others then
  raise notice '0230: pg_cron extension unavailable (%) — schedule the nightly refresh manually on prod', sqlerrm;
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- unschedule-if-exists (cron.schedule(name, …) also upserts by name, but
    -- be explicit so a schedule change never leaves a duplicate).
    perform cron.unschedule(jobid)
      from cron.job
     where jobname = 'refresh-org-daily-stats';
    perform cron.schedule(
      'refresh-org-daily-stats',
      '10 0 * * *',
      $job$select public.refresh_org_daily_stats(null, 3);$job$
    );
  else
    raise notice '0230: pg_cron not installed — nightly refresh-org-daily-stats NOT scheduled';
  end if;
exception when others then
  raise notice '0230: scheduling refresh-org-daily-stats failed (%) — verify cron.job on prod', sqlerrm;
end;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 5) Read path: REPLACE the two public dashboard functions with
--    snapshot-first bodies. Signature, return columns, SECURITY INVOKER,
--    pinned search_path and the grant matrix are all UNCHANGED from
--    0224/0228 — movements.ts needs zero changes. See the decision tree in
--    the header.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.dashboard_history_series(
  p_organization_id uuid,
  p_warehouse_id uuid default null,
  p_days int default 30
)
returns table (
  day_index int,
  item_count int,
  inventory_value numeric,
  low_out_count int
)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_days  int  := greatest(p_days, 1);
  v_today date := (now() at time zone 'utc')::date;
  v_have  int;
begin
  -- Snapshots are org-wide: a warehouse-scoped request takes the fully
  -- RLS-scoped reconstructed path (out of scope to snapshot per-warehouse).
  if p_warehouse_id is not null then
    return query
      select * from public.dashboard_history_series_reconstructed(
        p_organization_id, p_warehouse_id, p_days);
    return;
  end if;

  -- Completeness gate: all v_days−1 closed UTC days must be present UNDER
  -- THE CALLER'S RLS VIEW of org_daily_stats (SECURITY INVOKER). Two
  -- populations therefore ALWAYS count zero and take the reconstructed
  -- path: authenticated non-members (whose reconstruction RLS-zeroes —
  -- preserving 0224's all-zero cross-org contract) and warehouse/category-
  -- restricted members (staff/viewer — blocked by the manager+ snapshot
  -- policy; their reconstruction is fully caller-scoped, the pre-0230
  -- behavior). Degenerate v_days = 1 skips the gate (0 < 0 is false), but
  -- the snapshot branch then holds no closed days at all — only the live
  -- TODAY row, itself computed under the caller's RLS.
  select count(*) into v_have
  from public.org_daily_stats s
  where s.organization_id = p_organization_id
    and s.day >= v_today - (v_days - 1)
    and s.day <  v_today;

  if v_have < v_days - 1 then
    return query
      select * from public.dashboard_history_series_reconstructed(
        p_organization_id, null, p_days);
    return;
  end if;

  -- Snapshot hit: closed days from org_daily_stats (day D ↦ index
  -- v_days−1−(v_today−D)) + TODAY computed live from current item state
  -- (same aggregate the old function's last row reduced to). One row per
  -- day_index 0..v_days−1, oldest → newest — shape identical to 0224/0228.
  return query
  (
    select
      (v_days - 1 - (v_today - s.day))::int,
      s.item_count,
      s.inventory_value,
      s.low_out_count
    from public.org_daily_stats s
    where s.organization_id = p_organization_id
      and s.day >= v_today - (v_days - 1)
      and s.day <  v_today
    union all
    select
      v_days - 1,
      count(*)::int,
      coalesce(sum(coalesce(it.quantity_on_hand, 0)::numeric
                   * coalesce(it.unit_cost, 0)::numeric), 0)::numeric,
      count(*) filter (
        where coalesce(it.quantity_on_hand, 0)::numeric
              <= (case when coalesce(it.reorder_point, 0)::numeric > 0
                       then coalesce(it.reorder_point, 0)::numeric
                       else 0 end)
      )::int
    from public.inventory_items it
    where it.organization_id = p_organization_id
      and it.status = 'active'
      and it.deleted_at is null
  )
  order by 1;
end;
$$;

revoke all on function public.dashboard_history_series(uuid, uuid, int) from public;
revoke all on function public.dashboard_history_series(uuid, uuid, int) from anon;
-- authenticated MUST execute: this is SECURITY INVOKER and the dashboard calls
-- it via the user client. RLS (snapshot table: manager+ membership; fallback:
-- org + warehouse + category) binds inside, so an authenticated caller can
-- only ever aggregate rows it may already read.
grant execute on function public.dashboard_history_series(uuid, uuid, int) to authenticated;

comment on function public.dashboard_history_series(uuid, uuid, int) is
  'Per-day dashboard overview series (item_count, inventory_value cost-basis, '
  'low_out_count) over a p_days window, day_index 0..N-1 oldest→newest. Since '
  'mig 0230: closed days are OBSERVED UTC-day closes read from org_daily_stats '
  '(~N tiny rows, manager+ RLS); TODAY is computed live. Falls back to '
  'dashboard_history_series_reconstructed (0228 math) when p_warehouse_id is '
  'set or any closed day is missing from the CALLER''S RLS view — so '
  'warehouse/category-restricted members (staff/viewer) always reconstruct, '
  'fully caller-scoped. SECURITY INVOKER — called via the USER client, never '
  'service-role; authenticated may execute (cross-org calls return zero rows '
  'via RLS); anon/public revoked.';

create or replace function public.dashboard_movement_metrics(
  p_organization_id uuid,
  p_warehouse_id uuid default null,
  p_days int default 30
)
returns table (
  day_index int,
  movement_type text,
  move_count bigint
)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_days  int  := greatest(p_days, 1);
  v_today date := (now() at time zone 'utc')::date;
  v_have  int;
begin
  if p_warehouse_id is not null then
    return query
      select * from public.dashboard_movement_metrics_reconstructed(
        p_organization_id, p_warehouse_id, p_days);
    return;
  end if;

  -- Completeness sentinel = org_daily_stats (both snapshot tables are written
  -- by the same refresh); org_daily_movement_stats itself cannot distinguish
  -- "zero movements that day" from "never snapshotted". org_daily_stats is
  -- manager+-readable only, so warehouse/category-restricted members
  -- (staff/viewer) always count zero here and take the reconstructed path —
  -- caller-scoped via stock_movements + inventory_items RLS, the pre-0230
  -- behavior.
  select count(*) into v_have
  from public.org_daily_stats s
  where s.organization_id = p_organization_id
    and s.day >= v_today - (v_days - 1)
    and s.day <  v_today;

  if v_have < v_days - 1 then
    return query
      select * from public.dashboard_movement_metrics_reconstructed(
        p_organization_id, null, p_days);
    return;
  end if;

  -- Snapshot hit: closed days from org_daily_movement_stats + TODAY's slice
  -- counted live (created_at >= today's UTC midnight; future-dated clock-skew
  -- rows land in today's bucket, matching the old clamp). Sparse rows —
  -- days/types with zero movements emit nothing, exactly like 0224.
  return query
  (
    select
      (v_days - 1 - (v_today - s.day))::int,
      s.movement_type,
      s.move_count
    from public.org_daily_movement_stats s
    where s.organization_id = p_organization_id
      and s.day >= v_today - (v_days - 1)
      and s.day <  v_today
    union all
    select
      v_days - 1,
      sm.movement_type,
      count(*)::bigint
    from public.stock_movements sm
    where sm.organization_id = p_organization_id
      and sm.created_at >= (v_today::timestamp at time zone 'utc')
    group by sm.movement_type
  )
  order by 1, 2;
end;
$$;

revoke all on function public.dashboard_movement_metrics(uuid, uuid, int) from public;
revoke all on function public.dashboard_movement_metrics(uuid, uuid, int) from anon;
grant execute on function public.dashboard_movement_metrics(uuid, uuid, int) to authenticated;

comment on function public.dashboard_movement_metrics(uuid, uuid, int) is
  'Per (day-bucket, movement_type) movement counts over a p_days window. '
  'Since mig 0230: closed days are OBSERVED UTC-day counts read from '
  'org_daily_movement_stats (every movement in the day slice — history does '
  'not rewrite on later item deletion); TODAY''s slice is counted live. Falls '
  'back to dashboard_movement_metrics_reconstructed (0224 math) when '
  'p_warehouse_id is set or any closed day is missing from the caller''s RLS '
  'view of org_daily_stats (manager+ only — restricted members always '
  'reconstruct). SECURITY INVOKER — called via the USER client; authenticated '
  'may execute; anon/public revoked.';

-- ────────────────────────────────────────────────────────────────────────────
-- 6) One-time backfill: give every EXISTING org its last 120 closed days so
--    the snapshot path is hot from the first post-deploy render. Runs the
--    exact machinery the nightly job uses (reconstruction gap-fill + one
--    grouped movement query per org over the 120-day slice) — at current
--    prod scale (a few hundred items/movements per real org) this is
--    milliseconds; the one seeded 50k/1.2M perf org pays a single 0228-cost
--    pass (~1.2s) once, inside the migration. Orgs created AFTER this
--    migration simply take the reconstructed fallback (fast at day-1 size)
--    until their snapshot history accumulates.
-- ────────────────────────────────────────────────────────────────────────────

select public.refresh_org_daily_stats(null, 120);
