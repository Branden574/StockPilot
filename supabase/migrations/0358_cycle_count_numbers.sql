-- 0358_cycle_count_numbers.sql
--
-- Cycle counts get a permanent, human reference: CC-000042.
--
-- Until now a count had only its uuid, so nobody could say "count 42" out loud
-- or find an old count again: the web list stopped at the newest 200 and the
-- phone at 50, with no search. This migration adds the number and the one
-- server-side list/search function both apps page through.
--
-- ── WHAT IT ADDS ───────────────────────────────────────────────────────────
--   1. cycle_counts.count_number (bigint, NOT NULL, > 0), unique per org.
--      The apps render it as CC- + at least six digits
--      (packages/core/src/cycle-counts/cycle-count-number.ts); SQL renders the
--      same string only for notification text (format_cycle_count_number).
--   2. cycle_count_number_counters: ONE row per organization holding the last
--      number handed out. A BEFORE INSERT trigger on cycle_counts takes the
--      next value with INSERT ... ON CONFLICT DO UPDATE ... RETURNING, which
--      row-locks that org's counter until the creating transaction ends, so
--      two concurrent creations can never draw the same number. It is not
--      MAX(count_number) + 1: the counter only ever goes up, so a number is
--      never handed out twice, even if a count row were ever removed. If the
--      creating transaction rolls back (an empty scope raises inside
--      start_cycle_count), the increment rolls back with it. Gaps are allowed
--      (an INSERT ... ON CONFLICT DO NOTHING that finds its row already there
--      still fires the BEFORE trigger and spends a number); reuse is not.
--   3. A BEFORE UPDATE guard: count_number and organization_id never change
--      once set. Assignment, notes, posting, cancellation and sync cannot
--      change the number because nothing can.
--   4. cycle_counts_page(): one page of the history list, searched and
--      filtered server-side, with the filtered total and the effective page
--      computed from the SAME filtered set as the rows.
--   5. The assignment notification names the count by its reference.
--
-- ── WHO CAN SET THE NUMBER ─────────────────────────────────────────────────
-- Only the trigger. It OVERWRITES any count_number an INSERT supplies, so a
-- client (a manager can insert a header directly under the 0023/0203 policy)
-- cannot choose, reuse or skip ahead in the series; the UPDATE guard refuses
-- any change after that. The counter table has RLS on, no policies, and every
-- privilege revoked from the API roles, so it cannot be read or reset over
-- PostgREST. The allocator is a trigger function: it cannot be called as an
-- RPC, and EXECUTE is revoked anyway (0329 posture; a trigger fires regardless
-- of the invoking role's EXECUTE grant).
--
-- ── EVERY CREATION PATH IS COVERED ─────────────────────────────────────────
-- Allocation is a row trigger on cycle_counts itself, so every path that
-- creates a count gets a number with no caller change: start_cycle_count
-- (warehouse and selection counts, and group-by-variant counts, which reach it
-- as a selection) behind the web action and POST /api/v1/cycle-counts from the
-- phone, plus any direct insert. A request that creates no count draws no
-- number that survives.
--
-- ── CONCURRENCY COST ───────────────────────────────────────────────────────
-- start_cycle_count inserts the header first and then snapshots the lines in
-- the same transaction, so the org's counter row stays locked for the length
-- of that snapshot. Two counts STARTED at the same moment in the same org run
-- one after the other; nothing else waits (reads, counting, posting and other
-- orgs never touch the counter).
--
-- ── BACKFILL ───────────────────────────────────────────────────────────────
-- Existing counts are numbered per organization, oldest first, by
-- started_at ASC, id ASC (the uuid breaks timestamp ties deterministically).
-- A number a row already carries is kept and numbering continues above the
-- org's highest one. The backfill touches ONLY count_number:
--   • no count is recreated, and no uuid, date, status, line or stock changes;
--   • trg_cycle_counts_assigned is AFTER UPDATE OF assigned_to, so a SET of
--     count_number alone never fires it (no notifications, and the table is
--     in no realtime publication);
--   • cycle_counts_updated_at is disabled for the backfill statement only and
--     re-enabled right after (the 0109/0120 pattern), so no count looks as if
--     someone edited it today. Nothing else is disabled: RLS, constraints,
--     foreign keys and every other trigger stay on.
-- The Supabase CLI applies this file as one atomic batch, and ADD COLUMN takes
-- an ACCESS EXCLUSIVE lock on cycle_counts first, held until the file commits,
-- so no count can be created (or read) between the backfill, the counter
-- initialisation and the trigger going live. The backfill lives in a no-grant
-- helper so its pgTAP file can re-run the real statements against legacy rows.
--
-- PROD PUSH NOTE: that lock closes cycle_counts to every session, reads
-- included, for the length of this file. The backfill is one UPDATE over an
-- org's handful-to-thousands of headers, so the window is short, and
-- lock_timeout makes the push fail fast instead of queueing behind a long
-- transaction (retry is the remedy).

-- PLAIN `set`, not `set local`: see 0303 (the CLI batch is atomic but is not a
-- transaction block, so `set local` would be discarded). Reset at the end.
set lock_timeout = '5s';

-- ── 1. Column ──────────────────────────────────────────────────────────────
alter table public.cycle_counts
  add column if not exists count_number bigint;

comment on column public.cycle_counts.count_number is
  'Permanent per-organization reference, shown as CC-000042. Assigned by '
  'trg_cycle_counts_assign_number from cycle_count_number_counters; never '
  'set by clients, never changed once set, never reused.';

-- ── 2. Counter table ───────────────────────────────────────────────────────
create table if not exists public.cycle_count_number_counters (
  organization_id uuid primary key
    references public.organizations(id) on delete cascade,
  last_number     bigint not null check (last_number >= 0),
  updated_at      timestamptz not null default now()
);

comment on table public.cycle_count_number_counters is
  'Last cycle-count number handed out per organization (0358). Written only '
  'by trg_cycle_counts_assign_number and the 0358 backfill; no API role can '
  'read or write it.';

alter table public.cycle_count_number_counters enable row level security;
revoke all on table public.cycle_count_number_counters from public, anon, authenticated;

-- ── 3. Backfill + counter initialisation ───────────────────────────────────
-- Numbers every count that has none, then raises each org's counter to at
-- least its highest number. Idempotent: a second run numbers nothing and
-- leaves every counter where it is. Returns how many counts it numbered.
create or replace function public._backfill_cycle_count_numbers()
returns bigint
language plpgsql
set search_path = public
as $fn$
declare
  v_numbered bigint;
begin
  -- updated_at is the time a PERSON last changed the count. Assigning a
  -- reference is not that, so the bump is suppressed for this statement only.
  alter table public.cycle_counts disable trigger cycle_counts_updated_at;

  with base as (
    select c.organization_id, coalesce(max(c.count_number), 0) as last_number
    from public.cycle_counts c
    group by c.organization_id
  ),
  numbered as (
    select
      c.id,
      b.last_number
        + row_number() over (
            partition by c.organization_id
            order by c.started_at asc, c.id asc
          ) as n
    from public.cycle_counts c
    join base b on b.organization_id = c.organization_id
    where c.count_number is null
  )
  update public.cycle_counts c
  set count_number = numbered.n
  from numbered
  where c.id = numbered.id;

  get diagnostics v_numbered = row_count;

  alter table public.cycle_counts enable trigger cycle_counts_updated_at;

  insert into public.cycle_count_number_counters (organization_id, last_number)
  select c.organization_id, max(c.count_number)
  from public.cycle_counts c
  where c.count_number is not null
  group by c.organization_id
  on conflict (organization_id) do update
    set last_number = greatest(cycle_count_number_counters.last_number, excluded.last_number),
        updated_at  = now();

  return v_numbered;
end;
$fn$;

-- One-shot maintenance helper: no runtime caller, so no grants.
revoke all on function public._backfill_cycle_count_numbers() from public, anon, authenticated, service_role;

select public._backfill_cycle_count_numbers();

-- ── 4. Validate before the column goes live ────────────────────────────────
alter table public.cycle_counts
  alter column count_number set not null;

alter table public.cycle_counts
  add constraint cycle_counts_count_number_positive check (count_number > 0);

-- Built AFTER the backfill (0303): with the index in place first, every
-- backfill UPDATE would have had to maintain it. This is also the index an
-- exact reference lookup uses.
create unique index if not exists cycle_counts_org_count_number_uniq
  on public.cycle_counts (organization_id, count_number);

-- The history list's order: newest first, uuid as the tie-breaker. The
-- existing (organization_id, status, started_at desc) index keeps serving the
-- status-filtered views.
create index if not exists cycle_counts_org_started_id_idx
  on public.cycle_counts (organization_id, started_at desc, id desc);

-- ── 5. Allocation trigger ──────────────────────────────────────────────────
create or replace function public.tg_cycle_counts_assign_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next bigint;
begin
  -- The first count an org ever creates seeds its counter from any numbers
  -- already on that org's counts (never below them), so a missing counter row
  -- cannot restart the series at 1 and collide. Every later count increments
  -- the existing row, and that row lock is what serializes concurrent
  -- creations in the org until this transaction ends.
  insert into public.cycle_count_number_counters as c (organization_id, last_number)
  values (
    new.organization_id,
    coalesce(
      (select max(cc.count_number)
         from public.cycle_counts cc
        where cc.organization_id = new.organization_id),
      0
    ) + 1
  )
  on conflict (organization_id) do update
    set last_number = c.last_number + 1,
        updated_at  = now()
  returning c.last_number into v_next;

  -- Always the server's number: whatever the INSERT supplied is replaced.
  new.count_number := v_next;
  return new;
end;
$$;

revoke all on function public.tg_cycle_counts_assign_number() from public, anon, authenticated;

comment on function public.tg_cycle_counts_assign_number() is
  'BEFORE INSERT on cycle_counts: takes the org''s next number from '
  'cycle_count_number_counters (row-locked, never reused) and overwrites any '
  'client-supplied count_number. SECURITY DEFINER only to write the locked '
  'counter table; it is a trigger function and cannot be called directly.';

drop trigger if exists trg_cycle_counts_assign_number on public.cycle_counts;
create trigger trg_cycle_counts_assign_number
  before insert on public.cycle_counts
  for each row execute function public.tg_cycle_counts_assign_number();

-- ── 6. Immutability guard ──────────────────────────────────────────────────
create or replace function public.tg_cycle_counts_number_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- A count keeps the number it was given. The one permitted transition is a
  -- row that has none receiving one (the backfill above); NOT NULL means no
  -- live row can take that path.
  if old.count_number is not null
     and new.count_number is distinct from old.count_number then
    raise exception 'cycle_count_number_immutable'
      using errcode = '42501',
            hint = 'A cycle count keeps the reference it was created with.';
  end if;
  -- The number belongs to its organization's series; moving the count to
  -- another org would carry a number from the wrong series.
  if new.organization_id is distinct from old.organization_id then
    raise exception 'cycle_count_org_immutable'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_cycle_counts_number_immutable() from public, anon, authenticated;

drop trigger if exists trg_cycle_counts_number_immutable on public.cycle_counts;
create trigger trg_cycle_counts_number_immutable
  before update of count_number, organization_id on public.cycle_counts
  for each row execute function public.tg_cycle_counts_number_immutable();

-- ── 7. SQL twin of formatCycleCountNumber (notification text only) ─────────
-- 42 -> 'CC-000042'; 1234567 -> 'CC-1234567'. lpad() alone would TRUNCATE a
-- seven-digit number to six, so longer numbers pass through whole. The pgTAP
-- file pins this against the TypeScript helper's boundary cases.
create or replace function public.format_cycle_count_number(p_number bigint)
returns text
language sql
immutable
strict
set search_path = public
as $$
  select case
    when p_number <= 0 then null
    when length(p_number::text) >= 6 then 'CC-' || p_number::text
    else 'CC-' || lpad(p_number::text, 6, '0')
  end
$$;

comment on function public.format_cycle_count_number(bigint) is
  'CC-000042 display form of cycle_counts.count_number (at least six digits, '
  'never truncated). Mirrors formatCycleCountNumber in packages/core.';

-- ── 8. Assignment notification names the count ─────────────────────────────
-- Unchanged from 0042 except the label: the reference leads, then the notes
-- when there are any (the old "Cycle count from Mon DD" fallback is replaced
-- by the reference itself), and metadata carries count_number. Rows already
-- in people's inboxes are not rewritten.
create or replace function public._notify_cycle_count_assigned()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  link_url text;
  notif_title text;
  cc_label text;
  prev_assignee uuid;
  new_assignee uuid;
begin
  prev_assignee := old.assigned_to;
  new_assignee  := new.assigned_to;
  if prev_assignee is not distinct from new_assignee then
    return new;
  end if;

  link_url := '/dashboard/cycle-counts/' || new.id::text;
  cc_label := coalesce(
    public.format_cycle_count_number(new.count_number),
    'Cycle count from ' || to_char(new.started_at, 'Mon DD')
  ) || coalesce(' · ' || nullif(trim(new.notes), ''), '');

  -- Notify the new assignee (if any), respecting their push preference.
  if new_assignee is not null then
    notif_title := 'Cycle count assigned to you: ' || cc_label;
    if exists (
      select 1 from public.notification_preferences
      where user_id = new_assignee and push_cycle_count = true
    ) or not exists (
      select 1 from public.notification_preferences where user_id = new_assignee
    ) then
      insert into public.notifications (
        organization_id, user_id, type, title, body, link, metadata
      ) values (
        new.organization_id,
        new_assignee,
        'cycle_count.assigned',
        notif_title,
        'Tap to start the count.',
        link_url,
        jsonb_build_object(
          'cycle_count_id', new.id,
          'count_number', new.count_number,
          'previous_assignee', prev_assignee,
          'warehouse_id', new.warehouse_id
        )
      );
    end if;
  end if;
  return new;
end;
$function$;

-- ── 9. The history list ────────────────────────────────────────────────────
-- One page of an org's cycle counts, newest first (started_at DESC, id DESC).
--
-- ONE filtered set feeds the rows, the total and the effective page, so the
-- footer can never count something the rows exclude, or the reverse.
--
-- Search: p_number is an exact count_number lookup (the apps parse
-- "CC-000042", "cc-42", "000042" and "42" to 42 before calling); p_text is
-- matched LITERALLY against the notes and the warehouse name, with \ % and _
-- escaped before the ILIKE pattern is built (0226/0227 convention). Neither is
-- ever spliced into SQL or a PostgREST filter string.
--
-- Scope: SECURITY INVOKER, so cycle_counts RLS (org member), warehouses RLS
-- (readable warehouses only) and user_profiles RLS (org-mates) all apply, and
-- this can never return more than a direct select could. p_scope_warehouse_ids
-- NARROWS it further to the web service's visibility rule for a
-- warehouse-restricted member: counts in those warehouses, plus a count with no
-- header warehouse that is assigned to the caller (auth.uid(), never a
-- parameter). NULL means the caller may see every warehouse's counts; an EMPTY
-- array means only their own null-warehouse assignments.
--
-- p_started_from keeps counts started at or after an instant; the apps pass
-- the start of the workspace's current day for a "started today" total.
--
-- Paging: p_page is clamped to the last real page (page 1 when nothing
-- matches) inside the query, so a stale ?page= link gets rows, and the page
-- they came from, in the same round trip. p_page_size is bounded to 1..100.
--
-- Progress: line_total / line_counted are aggregated for the returned page
-- only (at most p_page_size counts), set-based, so no client downloads a
-- count's lines to draw a progress bar.
create or replace function public.cycle_counts_page(
  p_organization_id     uuid,
  p_number              bigint  default null,
  p_text                text    default null,
  p_status              text    default null,
  p_warehouse_id        uuid    default null,
  p_assigned_to         uuid    default null,
  p_unassigned          boolean default false,
  p_started_from        timestamptz default null,
  p_scope_warehouse_ids uuid[]  default null,
  p_page                integer default 1,
  p_page_size           integer default 25
)
returns table (
  id              uuid,
  count_number    bigint,
  organization_id uuid,
  warehouse_id    uuid,
  warehouse_name  text,
  scope           text,
  status          text,
  notes           text,
  started_by      uuid,
  started_by_name text,
  started_at      timestamptz,
  completed_by    uuid,
  completed_at    timestamptz,
  canceled_by     uuid,
  canceled_at     timestamptz,
  assigned_to     uuid,
  assignee_name   text,
  line_total      bigint,
  line_counted    bigint,
  total_count     bigint,
  effective_page  integer
)
language sql
stable
security invoker
set search_path = public
as $$
  with params as (
    select
      case
        when p_text is null or btrim(p_text) = '' then null
        else '%' || replace(replace(replace(btrim(p_text), '\', '\\'), '%', '\%'), '_', '\_') || '%'
      end as pat,
      least(greatest(coalesce(p_page_size, 25), 1), 100) as size
  ),
  filtered as (
    select c.id, c.started_at
    from public.cycle_counts c
    cross join params
    left join public.warehouses w on w.id = c.warehouse_id
    where c.organization_id = p_organization_id
      and (
        p_scope_warehouse_ids is null
        or c.warehouse_id = any(p_scope_warehouse_ids)
        or (c.warehouse_id is null and c.assigned_to = (select auth.uid()))
      )
      and (p_status is null or c.status = p_status)
      and (p_warehouse_id is null or c.warehouse_id = p_warehouse_id)
      and (not coalesce(p_unassigned, false) or c.assigned_to is null)
      and (p_assigned_to is null or c.assigned_to = p_assigned_to)
      and (p_started_from is null or c.started_at >= p_started_from)
      and (p_number is null or c.count_number = p_number)
      and (
        params.pat is null
        or c.notes ilike params.pat
        or w.name ilike params.pat
      )
  ),
  paging as (
    select
      t.n as total_count,
      case
        when t.n = 0 then 1
        else least(
          greatest(coalesce(p_page, 1), 1),
          ceil(t.n::numeric / params.size)::integer
        )
      end as effective_page,
      params.size
    from (select count(*)::bigint as n from filtered) t
    cross join params
  ),
  page_ids as (
    select f.id
    from filtered f
    order by f.started_at desc, f.id desc
    offset (select (effective_page - 1) * size from paging)
    limit (select size from paging)
  )
  select
    c.id,
    c.count_number,
    c.organization_id,
    c.warehouse_id,
    w.name as warehouse_name,
    c.scope,
    c.status,
    c.notes,
    c.started_by,
    coalesce(nullif(btrim(sb.full_name), ''), sb.email) as started_by_name,
    c.started_at,
    c.completed_by,
    c.completed_at,
    c.canceled_by,
    c.canceled_at,
    c.assigned_to,
    coalesce(nullif(btrim(u.full_name), ''), u.email) as assignee_name,
    coalesce(prog.line_total, 0)::bigint as line_total,
    coalesce(prog.line_counted, 0)::bigint as line_counted,
    paging.total_count,
    paging.effective_page
  from page_ids p
  join public.cycle_counts c on c.id = p.id
  left join public.warehouses w on w.id = c.warehouse_id
  left join public.user_profiles u on u.id = c.assigned_to
  left join public.user_profiles sb on sb.id = c.started_by
  left join lateral (
    select
      count(*) as line_total,
      count(*) filter (where l.counted_quantity is not null) as line_counted
    from public.cycle_count_lines l
    where l.cycle_count_id = c.id
  ) prog on true
  cross join paging
  order by c.started_at desc, c.id desc
$$;

revoke all on function public.cycle_counts_page(uuid, bigint, text, text, uuid, uuid, boolean, timestamptz, uuid[], integer, integer) from public;
revoke all on function public.cycle_counts_page(uuid, bigint, text, text, uuid, uuid, boolean, timestamptz, uuid[], integer, integer) from anon;
grant execute on function public.cycle_counts_page(uuid, bigint, text, text, uuid, uuid, boolean, timestamptz, uuid[], integer, integer) to authenticated;

comment on function public.cycle_counts_page(uuid, bigint, text, text, uuid, uuid, boolean, timestamptz, uuid[], integer, integer) is
  'One page of an org''s cycle-count history, newest first (started_at desc, '
  'id desc): exact count_number lookup or literal notes/warehouse-name search, '
  'status/warehouse/assignee/started-from filters, optional warehouse-scope '
  'narrowing, '
  'total_count and effective_page (clamped) from the same filtered set, and '
  'per-count line progress for the returned page only. SECURITY INVOKER: '
  'org-member RLS applies. authenticated may execute; anon/public revoked.';

reset lock_timeout;
