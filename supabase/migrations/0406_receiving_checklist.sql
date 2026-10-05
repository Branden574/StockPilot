-- 0398_receiving_checklist.sql
--
-- Receiving checklist, slice F4-1 (owner-approved lean scope, blanket go
-- 2026-09-27; plan stockpilot-work/six/f4-plan.md sections 3 and 4 F4-1, with
-- the 2026-09-30 refresh's corrections). Written as 0398; the number is fixed
-- at push time. Nothing in a function body names the number, so renumbering
-- moves no md5 pin.
--
-- A manager publishes a short checklist for deliveries. After a receipt posts,
-- or later from its receipt card, a manager records a run of it: what a person
-- checked for that receipt (Pass, Fail or Not applicable, a count, a short
-- text, notes). It is optional: posting or reversing a receipt never fails
-- because of it (a post can wait a moment for a checklist start on the same
-- purchase order to commit, a reversal for one on that receipt; see LOCKS),
-- and it records observations only. It writes no stock, no receipt, no
-- purchase order, no exception, no hold and no email.
--
-- ── WHAT IT ADDS ───────────────────────────────────────────────────────────
--   1. checklist_versions: one frozen version per publish. The steps are
--      normalised by the server (keys s1..sN by position, known fields only).
--      A version never changes except to be retired; at most one is live per
--      organization and binding (checklist_versions_one_live).
--   2. checklist_runs: at most one run per receipt (UNIQUE receipt_id). The
--      purchase order and warehouse are copied from the receipt; a run keeps
--      the version it started with. revision counts saves; last_save_id makes
--      a resent save a replay.
--   3. Six functions. Two private asserts and two private normalisers
--      (no EXECUTE for any API role), and four SECURITY DEFINER RPCs with
--      EXECUTE to authenticated only:
--        checklist_publish, checklist_retire   (the publisher)
--        receiving_check_start, checklist_run_save (the recorder)
--      checklist_publish answers {version, created} and checklist_run_save
--      {run, saved}, receiving_check_start {runId, created, versionNumber}:
--      whether THIS call wrote the row (false for a replay of an earlier
--      call), decided here rather than by comparing clocks, so the app
--      writes one audit row per real write.
--   4. SELECT for signed-in users only: versions to members, a run only when
--      its purchase order is visible to the caller (purchase_orders_select:
--      membership, purchase_orders:read and, below manager, the warehouse
--      scope). No API role may insert, update or delete either table.
--   5. The "Deleted user" marker (the 0393 pattern, A3 rule for a new person
--      column): every person key is ON DELETE SET NULL, each table carries
--      deleted_users jsonb and the zzz_deleted_users_ins/_upd pair running
--      tg_mark_deleted_users with its person columns, and the columns always
--      set by the functions (published_by, started_by) carry the exactly-one
--      CHECK; the retire and completion pairs accept a stamp in place of the
--      person.
--
-- ── WHO MAY DO WHAT (each RPC checks, in this order) ───────────────────────
-- Publish and turn off (checklist_publish, checklist_retire):
--   signed in                                            42501 not_authenticated
--   a member of the organization                         42501 not_member
--   the receiving module on                              P0001 module_disabled
--   manager or above with purchase_orders:manage         42501 not_publisher
-- Start and save a run (receiving_check_start, checklist_run_save):
--   signed in                                            42501 not_authenticated
--   the receipt (run) exists and the caller is a member
--   of its organization (the organization comes from
--   the row, never from the client)                      P0002 receipt_not_found
--                                                              | checklist_run_not_found
--   the receiving module on                              P0001 module_disabled
--   manager or above with stock:adjust and
--   purchase_orders:read (the receipt post floor plus
--   reading the purchase order)                          42501 not_recorder
-- has_org_role and has_permission already require an accepted, not-disabled,
-- unexpired membership. A recorder is a manager, so the run's purchase order
-- is always visible to them (purchase_orders_select's manager arm).
--
-- ── THE RULES ──────────────────────────────────────────────────────────────
-- Steps: 1 to 20; kind check, count or text (photo is refused here: F4-2);
-- label 1 to 120 characters, help up to 300, required true or false (absent
-- is false). Title 1 to 80. An optional procedure link must be live in the
-- organization. Results: every key is a step of the run's own version; a
-- check answers pass, fail or na; a count is a whole number 0 to 1,000,000; a
-- text up to 500 characters; a photo step carries no value; a note of up to
-- 300 characters on any step; the run note up to 1,000. Text is trimmed of
-- spaces, tabs and line breaks, and a blank answer or note is no answer.
-- Completing needs every required step answered (not applicable is an
-- answer) and a note on every failed check; otherwise 22023
-- checklist_incomplete with the detail {missing, failedWithoutNote,
-- photoStepsWithoutPhoto} (step keys). core receiving-checklist.ts holds the
-- same rules and the pgTAP case markers tie the two together.
--
-- ── WHAT IT WRITES ─────────────────────────────────────────────────────────
-- Only its own two tables, through the four RPCs. No function here touches a
-- ledger table, the ledger flag, receipts, purchase orders or stock.
-- post_receipt_v2, reverse_receipt (public and ledger), recompute_po_status,
-- the receipt tables and their guards, po_attachments and its bucket are not
-- changed. The new foreign keys to receipts, purchase_orders, warehouses,
-- organizations, procedures and user_profiles add RI triggers on those tables
-- that fire only when a referenced key changes or a row is deleted.
--
-- ── LOCKS ──────────────────────────────────────────────────────────────────
-- One NOWAIT prelude (the 0390/0393/0394 pattern) takes every lock the file
-- needs before any other statement: SHARE ROW EXCLUSIVE on organizations,
-- receipts, purchase_orders, warehouses, procedures and user_profiles (the
-- new keys add RI triggers there) and ACCESS EXCLUSIVE on every table
-- supautils.policy_grants lists for this role (supautils takes those on any
-- CREATE POLICY by postgres). A busy table fails one attempt, its
-- subtransaction releases what it took, and the next attempt starts after 50
-- to 150 ms holding nothing, up to 40 attempts; then 55P03 and nothing is
-- applied. SHARE ROW EXCLUSIVE lets plain reads through but makes writes to
-- those six tables wait for the commit (milliseconds); the policy_grants
-- tables (auth sessions among them) wait too. Push off-peak.
-- scripts/db-concurrency/0398_migration_lock_footprint.sh.
-- At run time: checklist_publish and checklist_retire take a transaction
-- advisory lock per organization and binding, then the live version FOR NO
-- KEY UPDATE (a start inserting a run that references it only takes KEY
-- SHARE, so it never waits on a publish); checklist_run_save takes the run
-- FOR UPDATE; receiving_check_start inserts ON CONFLICT (receipt_id) DO
-- NOTHING and reads the winner. Until it commits, its new run's keys hold
-- KEY SHARE on the receipt and the purchase order, and the frozen ledger
-- bodies begin with FOR UPDATE on the purchase order (post_receipt_v2) and
-- on the receipt (reverse_receipt): a post on that purchase order, or a
-- reversal of that receipt, waits those milliseconds and then goes through.
-- Neither ever fails because of the checklist, and no lock order between
-- them can deadlock (the start takes the receipt, then the purchase order;
-- a post never needs an older receipt). The race script's sections 7 to 9
-- prove it. lock_timeout 5s on every function, below the API roles' 8 s
-- statement timeout.
--
-- ── ERRORS ─────────────────────────────────────────────────────────────────
-- 42501, P0002, 22023 and P0001 only, each with a stable hint the app maps
-- (never by message text): not_authenticated, not_member, not_publisher,
-- not_recorder; receipt_not_found, checklist_run_not_found; checklist_invalid
-- (detail JSON naming the field, step or key and the reason),
-- checklist_incomplete (detail JSON of step keys); module_disabled,
-- checklist_changed, receipt_not_checkable, no_checklist,
-- checklist_run_changed, checklist_run_completed. A wait past lock_timeout
-- is 55P03. Never 40001 or 40P01 (PostgREST retries those forever; 0367).
--
-- ── DATA SAFETY ────────────────────────────────────────────────────────────
-- Additive only: two new tables, six functions, four triggers on the new
-- tables, two policies, grants and comments. No existing row is inserted,
-- updated or deleted; no existing table, column, constraint, policy, trigger
-- or function is altered or dropped. Proven locally by
-- stockpilot-work/six/data-safety-0398.sh.

-- PLAIN `set`, not `set local`: the CLI batch is atomic but is not a
-- transaction block.
set lock_timeout = '5s';

-- ═══ 1. The lock prelude (see LOCKS) ══════════════════════════════════════
-- Inside DO because the CLI batch is not a transaction block (a top-level
-- LOCK TABLE refuses there, as 0373 found); the locks last until the batch
-- commits.
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
      lock table only public.organizations, public.receipts, public.purchase_orders,
                      public.warehouses, public.procedures, public.user_profiles
        in share row exclusive mode nowait;
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

-- Every lock the rest needs is held; nothing below may wait.
set lock_timeout = '900ms';

-- ═══ 2. Tables ════════════════════════════════════════════════════════════

create table public.checklist_versions (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   uuid        not null references public.organizations(id) on delete cascade,
  binding           text        not null,
  version_number    integer     not null,
  title             text        not null,
  steps             jsonb       not null,
  procedure_id      uuid        references public.procedures(id) on delete set null,
  client_publish_id uuid,
  published_by      uuid        references public.user_profiles(id) on delete set null,
  published_at      timestamptz not null default clock_timestamp(),
  retired_at        timestamptz,
  retired_by        uuid        references public.user_profiles(id) on delete set null,
  deleted_users     jsonb,
  constraint checklist_versions_binding_chk check (binding in ('receiving')),
  constraint checklist_versions_number_chk check (version_number > 0),
  constraint checklist_versions_number_uniq unique (organization_id, binding, version_number),
  constraint checklist_versions_title_chk
    check (char_length(title) between 1 and 80 and title = btrim(title, E' \t\n\r\f' || chr(11))),
  constraint checklist_versions_steps_chk
    check (case when jsonb_typeof(steps) = 'array' then jsonb_array_length(steps) between 1 and 20 else false end),
  constraint checklist_versions_window_chk check (retired_at is null or retired_at >= published_at),
  constraint checklist_versions_published_by_deleted_chk
    check ((published_by is not null) <> coalesce(deleted_users ? 'published_by', false)),
  constraint checklist_versions_retired_chk check (
    (retired_at is null and retired_by is null)
    or (retired_at is not null and (retired_by is not null or coalesce(deleted_users ? 'retired_by', false))))
);

create unique index checklist_versions_one_live
  on public.checklist_versions (organization_id, binding) where retired_at is null;
create unique index checklist_versions_client_publish_uniq
  on public.checklist_versions (organization_id, client_publish_id) where client_publish_id is not null;
create index checklist_versions_procedure_idx
  on public.checklist_versions (procedure_id) where procedure_id is not null;

create table public.checklist_runs (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   uuid        not null references public.organizations(id) on delete cascade,
  binding           text        not null,
  -- NO ACTION (not RESTRICT): checked at the end of the statement, so an
  -- organization deletion that cascades to both tables stays clean. Nothing
  -- else deletes a version.
  version_id        uuid        not null references public.checklist_versions(id),
  receipt_id        uuid        references public.receipts(id) on delete cascade,
  purchase_order_id uuid        not null references public.purchase_orders(id) on delete cascade,
  warehouse_id      uuid        not null references public.warehouses(id),
  status            text        not null default 'in_progress',
  results           jsonb       not null default '{}'::jsonb,
  note              text,
  revision          integer     not null default 0,
  last_save_id      uuid,
  started_by        uuid        references public.user_profiles(id) on delete set null,
  started_at        timestamptz not null default clock_timestamp(),
  updated_at        timestamptz not null default clock_timestamp(),
  completed_by      uuid        references public.user_profiles(id) on delete set null,
  completed_at      timestamptz,
  deleted_users     jsonb,
  constraint checklist_runs_binding_chk check (binding in ('receiving')),
  constraint checklist_runs_receipt_chk check ((binding = 'receiving') = (receipt_id is not null)),
  constraint checklist_runs_receipt_uniq unique (receipt_id),
  constraint checklist_runs_status_chk check (status in ('in_progress', 'completed')),
  constraint checklist_runs_completion_chk check ((status = 'completed') = (completed_at is not null)),
  constraint checklist_runs_completed_by_chk check (
    (completed_at is null and completed_by is null)
    or (completed_at is not null and (completed_by is not null or coalesce(deleted_users ? 'completed_by', false)))),
  constraint checklist_runs_results_chk check (jsonb_typeof(results) = 'object'),
  constraint checklist_runs_note_chk check (note is null or char_length(note) between 1 and 1000),
  constraint checklist_runs_revision_chk check (revision >= 0),
  constraint checklist_runs_started_by_deleted_chk
    check ((started_by is not null) <> coalesce(deleted_users ? 'started_by', false))
);

create index checklist_runs_purchase_order_idx on public.checklist_runs (purchase_order_id);
create index checklist_runs_version_idx on public.checklist_runs (version_id);

-- The "Deleted user" marker (0393): a person column nulled by an account
-- deletion is stamped {column: when}; an ordinary write never calls the
-- function (WHEN clauses). The arguments are each table's SET NULL person
-- columns, in name order, as 0393's census reads them.
create trigger zzz_deleted_users_ins before insert on public.checklist_versions
  for each row when (new.deleted_users is not null)
  execute function public.tg_mark_deleted_users('published_by', 'retired_by');
create trigger zzz_deleted_users_upd before update on public.checklist_versions
  for each row when (old.deleted_users is not null or new.deleted_users is not null
                     or (old.published_by is not null and new.published_by is null)
                     or (old.retired_by is not null and new.retired_by is null))
  execute function public.tg_mark_deleted_users('published_by', 'retired_by');

create trigger zzz_deleted_users_ins before insert on public.checklist_runs
  for each row when (new.deleted_users is not null)
  execute function public.tg_mark_deleted_users('completed_by', 'started_by');
create trigger zzz_deleted_users_upd before update on public.checklist_runs
  for each row when (old.deleted_users is not null or new.deleted_users is not null
                     or (old.completed_by is not null and new.completed_by is null)
                     or (old.started_by is not null and new.started_by is null))
  execute function public.tg_mark_deleted_users('completed_by', 'started_by');

-- ═══ 3. Private helpers (no EXECUTE for any API role) ═════════════════════

create or replace function public._checklist_assert_recorder(p_org uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501', hint = 'not_authenticated';
  end if;
  if p_org is null or not public.is_org_member(p_org) then
    raise exception 'forbidden' using errcode = '42501', hint = 'not_member';
  end if;
  if not public.module_enabled(p_org, 'receiving') then
    raise exception 'module_disabled' using errcode = 'P0001', hint = 'module_disabled';
  end if;
  if not (public.has_org_role(p_org, 'manager')
          and public.has_permission(p_org, 'stock:adjust')
          and public.has_permission(p_org, 'purchase_orders:read')) then
    raise exception 'forbidden' using errcode = '42501', hint = 'not_recorder';
  end if;
end;
$$;

create or replace function public._checklist_assert_publisher(p_org uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501', hint = 'not_authenticated';
  end if;
  if p_org is null or not public.is_org_member(p_org) then
    raise exception 'forbidden' using errcode = '42501', hint = 'not_member';
  end if;
  if not public.module_enabled(p_org, 'receiving') then
    raise exception 'module_disabled' using errcode = 'P0001', hint = 'module_disabled';
  end if;
  if not (public.has_org_role(p_org, 'manager')
          and public.has_permission(p_org, 'purchase_orders:manage')) then
    raise exception 'forbidden' using errcode = '42501', hint = 'not_publisher';
  end if;
end;
$$;

-- Steps as the server stores them: keys s1..sN by position, only kind,
-- label, help and required, text trimmed. Client keys and unknown fields are
-- dropped. Refusals: 22023 checklist_invalid, detail {field, step, reason}.
create or replace function public._checklist_normalize_steps(p_steps jsonb, p_allow_photo boolean)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_ws    constant text := E' \t\n\r\f' || chr(11);
  v_out   jsonb := '[]'::jsonb;
  v_n     integer;
  v_i     integer;
  v_step  jsonb;
  v_kind  text;
  v_label text;
  v_help  text;
  v_req   boolean;
begin
  if p_steps is null or jsonb_typeof(p_steps) <> 'array' then
    raise exception 'checklist_invalid' using errcode = '22023', hint = 'checklist_invalid',
      detail = jsonb_build_object('field', 'steps', 'reason', 'not_a_list')::text;
  end if;
  v_n := jsonb_array_length(p_steps);
  if v_n < 1 or v_n > 20 then
    raise exception 'checklist_invalid' using errcode = '22023', hint = 'checklist_invalid',
      detail = jsonb_build_object('field', 'steps', 'reason', 'step_count')::text;
  end if;
  for v_i in 0 .. v_n - 1 loop
    v_step := p_steps -> v_i;
    if jsonb_typeof(v_step) is distinct from 'object' then
      raise exception 'checklist_invalid' using errcode = '22023', hint = 'checklist_invalid',
        detail = jsonb_build_object('field', 'steps', 'step', v_i + 1, 'reason', 'not_an_object')::text;
    end if;
    if jsonb_typeof(v_step -> 'kind') is distinct from 'string'
       or (v_step ->> 'kind') not in ('check', 'count', 'text', 'photo') then
      raise exception 'checklist_invalid' using errcode = '22023', hint = 'checklist_invalid',
        detail = jsonb_build_object('field', 'steps', 'step', v_i + 1, 'reason', 'unknown_kind')::text;
    end if;
    v_kind := v_step ->> 'kind';
    if v_kind = 'photo' and not coalesce(p_allow_photo, false) then
      raise exception 'checklist_invalid' using errcode = '22023', hint = 'checklist_invalid',
        detail = jsonb_build_object('field', 'steps', 'step', v_i + 1, 'reason', 'photo_not_available')::text;
    end if;
    if jsonb_typeof(v_step -> 'label') is distinct from 'string' then
      raise exception 'checklist_invalid' using errcode = '22023', hint = 'checklist_invalid',
        detail = jsonb_build_object('field', 'steps', 'step', v_i + 1, 'reason', 'label_required')::text;
    end if;
    v_label := btrim(v_step ->> 'label', v_ws);
    if char_length(v_label) = 0 then
      raise exception 'checklist_invalid' using errcode = '22023', hint = 'checklist_invalid',
        detail = jsonb_build_object('field', 'steps', 'step', v_i + 1, 'reason', 'label_required')::text;
    end if;
    if char_length(v_label) > 120 then
      raise exception 'checklist_invalid' using errcode = '22023', hint = 'checklist_invalid',
        detail = jsonb_build_object('field', 'steps', 'step', v_i + 1, 'reason', 'label_too_long')::text;
    end if;
    v_help := null;
    if jsonb_typeof(v_step -> 'help') = 'string' then
      v_help := nullif(btrim(v_step ->> 'help', v_ws), '');
      if char_length(v_help) > 300 then
        raise exception 'checklist_invalid' using errcode = '22023', hint = 'checklist_invalid',
          detail = jsonb_build_object('field', 'steps', 'step', v_i + 1, 'reason', 'help_too_long')::text;
      end if;
    elsif coalesce(jsonb_typeof(v_step -> 'help'), 'null') <> 'null' then
      raise exception 'checklist_invalid' using errcode = '22023', hint = 'checklist_invalid',
        detail = jsonb_build_object('field', 'steps', 'step', v_i + 1, 'reason', 'help_not_text')::text;
    end if;
    v_req := false;
    if jsonb_typeof(v_step -> 'required') = 'boolean' then
      v_req := (v_step -> 'required')::boolean;
    elsif coalesce(jsonb_typeof(v_step -> 'required'), 'null') <> 'null' then
      raise exception 'checklist_invalid' using errcode = '22023', hint = 'checklist_invalid',
        detail = jsonb_build_object('field', 'steps', 'step', v_i + 1, 'reason', 'required_not_boolean')::text;
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'key', 's' || (v_i + 1), 'kind', v_kind, 'label', v_label, 'help', v_help, 'required', v_req));
  end loop;
  return v_out;
end;
$$;

-- Results as the server stores them: per answered step {value?, note?},
-- trimmed, a blank answer or note left out, a step with neither left out.
-- Refusals: 22023 checklist_invalid, detail {field, key, reason}.
create or replace function public._checklist_validate_results(p_steps jsonb, p_results jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_ws     constant text := E' \t\n\r\f' || chr(11);
  v_out    jsonb := '{}'::jsonb;
  v_key    text;
  v_answer jsonb;
  v_step   jsonb;
  v_kind   text;
  v_value  jsonb;
  v_num    numeric;
  v_text   text;
  v_note   text;
  v_clean  jsonb;
begin
  if p_results is null or jsonb_typeof(p_results) <> 'object' then
    raise exception 'checklist_invalid' using errcode = '22023', hint = 'checklist_invalid',
      detail = jsonb_build_object('field', 'results', 'reason', 'not_an_object')::text;
  end if;
  for v_key, v_answer in select e.key, e.value from jsonb_each(p_results) e order by e.key loop
    v_step := null;
    v_text := null;
    v_note := null;
    v_clean := '{}'::jsonb;
    select s.step into v_step
      from jsonb_array_elements(p_steps) as s(step)
     where s.step ->> 'key' = v_key;
    if v_step is null then
      raise exception 'checklist_invalid' using errcode = '22023', hint = 'checklist_invalid',
        detail = jsonb_build_object('field', 'results', 'key', v_key, 'reason', 'unknown_step')::text;
    end if;
    if jsonb_typeof(v_answer) <> 'object' then
      raise exception 'checklist_invalid' using errcode = '22023', hint = 'checklist_invalid',
        detail = jsonb_build_object('field', 'results', 'key', v_key, 'reason', 'answer_not_an_object')::text;
    end if;
    v_kind := v_step ->> 'kind';
    v_value := v_answer -> 'value';
    if jsonb_typeof(v_value) = 'null' then
      v_value := null;
    end if;
    if v_value is not null then
      if v_kind = 'check' then
        if jsonb_typeof(v_value) <> 'string' or (v_value #>> '{}') not in ('pass', 'fail', 'na') then
          raise exception 'checklist_invalid' using errcode = '22023', hint = 'checklist_invalid',
            detail = jsonb_build_object('field', 'results', 'key', v_key, 'reason', 'not_a_check_answer')::text;
        end if;
        v_clean := jsonb_build_object('value', v_value #>> '{}');
      elsif v_kind = 'count' then
        if jsonb_typeof(v_value) <> 'number' then
          raise exception 'checklist_invalid' using errcode = '22023', hint = 'checklist_invalid',
            detail = jsonb_build_object('field', 'results', 'key', v_key, 'reason', 'not_a_whole_number')::text;
        end if;
        v_num := (v_value #>> '{}')::numeric;
        if v_num <> trunc(v_num) then
          raise exception 'checklist_invalid' using errcode = '22023', hint = 'checklist_invalid',
            detail = jsonb_build_object('field', 'results', 'key', v_key, 'reason', 'not_a_whole_number')::text;
        end if;
        if v_num < 0 or v_num > 1000000 then
          raise exception 'checklist_invalid' using errcode = '22023', hint = 'checklist_invalid',
            detail = jsonb_build_object('field', 'results', 'key', v_key, 'reason', 'count_out_of_range')::text;
        end if;
        v_clean := jsonb_build_object('value', v_num::bigint);
      elsif v_kind = 'text' then
        if jsonb_typeof(v_value) <> 'string' then
          raise exception 'checklist_invalid' using errcode = '22023', hint = 'checklist_invalid',
            detail = jsonb_build_object('field', 'results', 'key', v_key, 'reason', 'text_not_text')::text;
        end if;
        v_text := nullif(btrim(v_value #>> '{}', v_ws), '');
        if char_length(v_text) > 500 then
          raise exception 'checklist_invalid' using errcode = '22023', hint = 'checklist_invalid',
            detail = jsonb_build_object('field', 'results', 'key', v_key, 'reason', 'text_too_long')::text;
        end if;
        if v_text is not null then
          v_clean := jsonb_build_object('value', v_text);
        end if;
      else
        raise exception 'checklist_invalid' using errcode = '22023', hint = 'checklist_invalid',
          detail = jsonb_build_object('field', 'results', 'key', v_key, 'reason', 'photo_takes_no_value')::text;
      end if;
    end if;
    if jsonb_typeof(v_answer -> 'note') = 'string' then
      v_note := nullif(btrim(v_answer ->> 'note', v_ws), '');
      if char_length(v_note) > 300 then
        raise exception 'checklist_invalid' using errcode = '22023', hint = 'checklist_invalid',
          detail = jsonb_build_object('field', 'results', 'key', v_key, 'reason', 'note_too_long')::text;
      end if;
      if v_note is not null then
        v_clean := v_clean || jsonb_build_object('note', v_note);
      end if;
    elsif coalesce(jsonb_typeof(v_answer -> 'note'), 'null') <> 'null' then
      raise exception 'checklist_invalid' using errcode = '22023', hint = 'checklist_invalid',
        detail = jsonb_build_object('field', 'results', 'key', v_key, 'reason', 'note_not_text')::text;
    end if;
    if v_clean <> '{}'::jsonb then
      v_out := v_out || jsonb_build_object(v_key, v_clean);
    end if;
  end loop;
  return v_out;
end;
$$;

-- ═══ 4. The publisher's RPCs ══════════════════════════════════════════════

create or replace function public.checklist_publish(
  p_org uuid,
  p_binding text,
  p_title text,
  p_steps jsonb,
  p_procedure_id uuid,
  p_expected_current uuid,
  p_client_publish_id uuid,
  out version public.checklist_versions,
  out created boolean)
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_ws     constant text := E' \t\n\r\f' || chr(11);
  v_row    public.checklist_versions;
  v_live   public.checklist_versions;
  v_title  text;
  v_steps  jsonb;
  v_number integer;
  v_now    timestamptz;
begin
  perform public._checklist_assert_publisher(p_org);
  if p_binding is distinct from 'receiving' then
    raise exception 'checklist_invalid' using errcode = '22023', hint = 'checklist_invalid',
      detail = jsonb_build_object('field', 'binding', 'reason', 'unknown_binding')::text;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('checklist:' || p_org::text || ':' || p_binding, 0));

  -- A retried publish (same client id) answers the version it made, and says
  -- this call made nothing.
  if p_client_publish_id is not null then
    select * into v_row
      from public.checklist_versions
     where organization_id = p_org and client_publish_id = p_client_publish_id;
    if v_row.id is not null then
      version := v_row;
      created := false;
      return;
    end if;
  end if;

  select * into v_live
    from public.checklist_versions
   where organization_id = p_org and binding = p_binding and retired_at is null
   for no key update;
  if v_live.id is distinct from p_expected_current then
    raise exception 'checklist_changed' using errcode = 'P0001', hint = 'checklist_changed';
  end if;

  v_title := btrim(coalesce(p_title, ''), v_ws);
  if char_length(v_title) = 0 then
    raise exception 'checklist_invalid' using errcode = '22023', hint = 'checklist_invalid',
      detail = jsonb_build_object('field', 'title', 'reason', 'title_required')::text;
  end if;
  if char_length(v_title) > 80 then
    raise exception 'checklist_invalid' using errcode = '22023', hint = 'checklist_invalid',
      detail = jsonb_build_object('field', 'title', 'reason', 'title_too_long')::text;
  end if;
  v_steps := public._checklist_normalize_steps(p_steps, false);
  if p_procedure_id is not null and not exists (
       select 1 from public.procedures pr
        where pr.id = p_procedure_id and pr.organization_id = p_org and pr.archived_at is null) then
    raise exception 'checklist_invalid' using errcode = '22023', hint = 'checklist_invalid',
      detail = jsonb_build_object('field', 'procedure', 'reason', 'procedure_not_available')::text;
  end if;

  -- One instant for both edges, so the live windows meet with no gap.
  v_now := clock_timestamp();
  if v_live.id is not null then
    update public.checklist_versions
       set retired_at = v_now, retired_by = auth.uid()
     where id = v_live.id;
  end if;
  select coalesce(max(v.version_number), 0) + 1 into v_number
    from public.checklist_versions v
   where v.organization_id = p_org and v.binding = p_binding;
  insert into public.checklist_versions
    (organization_id, binding, version_number, title, steps, procedure_id, client_publish_id,
     published_by, published_at)
  values (p_org, p_binding, v_number, v_title, v_steps, p_procedure_id, p_client_publish_id,
          auth.uid(), v_now)
  returning * into v_row;
  version := v_row;
  created := true;
end;
$$;

create or replace function public.checklist_retire(p_org uuid, p_binding text, p_version_id uuid)
returns public.checklist_versions
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_row public.checklist_versions;
begin
  perform public._checklist_assert_publisher(p_org);
  if p_binding is distinct from 'receiving' then
    raise exception 'checklist_invalid' using errcode = '22023', hint = 'checklist_invalid',
      detail = jsonb_build_object('field', 'binding', 'reason', 'unknown_binding')::text;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('checklist:' || p_org::text || ':' || p_binding, 0));
  select * into v_row
    from public.checklist_versions
   where organization_id = p_org and binding = p_binding and retired_at is null
   for no key update;
  if v_row.id is null or v_row.id is distinct from p_version_id then
    raise exception 'checklist_changed' using errcode = 'P0001', hint = 'checklist_changed';
  end if;
  update public.checklist_versions
     set retired_at = clock_timestamp(), retired_by = auth.uid()
   where id = v_row.id
  returning * into v_row;
  return v_row;
end;
$$;

-- ═══ 5. The recorder's RPCs ═══════════════════════════════════════════════

create or replace function public.receiving_check_start(p_receipt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_receipt public.receipts;
  v_run     public.checklist_runs;
  v_version public.checklist_versions;
  v_id      uuid;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501', hint = 'not_authenticated';
  end if;
  select * into v_receipt from public.receipts where id = p_receipt_id;
  if v_receipt.id is null or not public.is_org_member(v_receipt.organization_id) then
    raise exception 'receipt_not_found' using errcode = 'P0002', hint = 'receipt_not_found';
  end if;
  perform public._checklist_assert_recorder(v_receipt.organization_id);

  -- A receipt's run is answered whatever its version, its state or whether a
  -- checklist is live now: a retried start never fails after a turn-off.
  select * into v_run from public.checklist_runs where receipt_id = v_receipt.id;
  if v_run.id is not null then
    return jsonb_build_object(
      'runId', v_run.id, 'created', false,
      'versionNumber', (select v.version_number from public.checklist_versions v where v.id = v_run.version_id));
  end if;

  if v_receipt.status not in ('posted', 'reversed') then
    raise exception 'receipt_not_checkable' using errcode = 'P0001', hint = 'receipt_not_checkable';
  end if;
  select * into v_version
    from public.checklist_versions
   where organization_id = v_receipt.organization_id and binding = 'receiving' and retired_at is null;
  if v_version.id is null then
    raise exception 'no_checklist' using errcode = 'P0001', hint = 'no_checklist';
  end if;

  insert into public.checklist_runs
    (organization_id, binding, version_id, receipt_id, purchase_order_id, warehouse_id, started_by)
  values (v_receipt.organization_id, 'receiving', v_version.id, v_receipt.id,
          v_receipt.purchase_order_id, v_receipt.warehouse_id, auth.uid())
  on conflict (receipt_id) do nothing
  returning id into v_id;
  if v_id is null then
    -- Another start for this receipt committed first: answer its run.
    select * into v_run from public.checklist_runs where receipt_id = v_receipt.id;
    return jsonb_build_object(
      'runId', v_run.id, 'created', false,
      'versionNumber', (select v.version_number from public.checklist_versions v where v.id = v_run.version_id));
  end if;
  return jsonb_build_object('runId', v_id, 'created', true, 'versionNumber', v_version.version_number);
end;
$$;

create or replace function public.checklist_run_save(
  p_run_id uuid,
  p_results jsonb,
  p_note text,
  p_expected_revision integer,
  p_save_id uuid,
  p_complete boolean,
  out run public.checklist_runs,
  out saved boolean)
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_ws       constant text := E' \t\n\r\f' || chr(11);
  v_run      public.checklist_runs;
  v_steps    jsonb;
  v_results  jsonb;
  v_note     text;
  v_missing  jsonb;
  v_failed   jsonb;
  v_photo    jsonb;
  v_complete boolean := coalesce(p_complete, false);
  v_now      timestamptz;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501', hint = 'not_authenticated';
  end if;
  if p_save_id is null then
    raise exception 'checklist_invalid' using errcode = '22023', hint = 'checklist_invalid',
      detail = jsonb_build_object('field', 'saveId', 'reason', 'required')::text;
  end if;
  if p_expected_revision is null then
    raise exception 'checklist_invalid' using errcode = '22023', hint = 'checklist_invalid',
      detail = jsonb_build_object('field', 'expectedRevision', 'reason', 'required')::text;
  end if;
  select * into v_run from public.checklist_runs where id = p_run_id for update;
  if v_run.id is null or not public.is_org_member(v_run.organization_id) then
    raise exception 'checklist_run_not_found' using errcode = 'P0002', hint = 'checklist_run_not_found';
  end if;
  perform public._checklist_assert_recorder(v_run.organization_id);

  -- A resent save (its answer was lost) answers the row as it stands, and
  -- says this call wrote nothing.
  if v_run.last_save_id = p_save_id then
    run := v_run;
    saved := false;
    return;
  end if;
  if v_run.status = 'completed' then
    raise exception 'checklist_run_completed' using errcode = 'P0001', hint = 'checklist_run_completed';
  end if;
  if v_run.revision <> p_expected_revision then
    raise exception 'checklist_run_changed' using errcode = 'P0001', hint = 'checklist_run_changed';
  end if;

  select v.steps into v_steps from public.checklist_versions v where v.id = v_run.version_id;
  v_results := public._checklist_validate_results(v_steps, coalesce(p_results, '{}'::jsonb));
  v_note := nullif(btrim(coalesce(p_note, ''), v_ws), '');
  if char_length(v_note) > 1000 then
    raise exception 'checklist_invalid' using errcode = '22023', hint = 'checklist_invalid',
      detail = jsonb_build_object('field', 'note', 'reason', 'run_note_too_long')::text;
  end if;

  if v_complete then
    select coalesce(jsonb_agg(s.step ->> 'key' order by s.n), '[]'::jsonb) into v_missing
      from jsonb_array_elements(v_steps) with ordinality as s(step, n)
     where coalesce((s.step ->> 'required')::boolean, false)
       and s.step ->> 'kind' <> 'photo'
       and v_results -> (s.step ->> 'key') -> 'value' is null;
    select coalesce(jsonb_agg(s.step ->> 'key' order by s.n), '[]'::jsonb) into v_failed
      from jsonb_array_elements(v_steps) with ordinality as s(step, n)
     where s.step ->> 'kind' = 'check'
       and v_results -> (s.step ->> 'key') ->> 'value' = 'fail'
       and v_results -> (s.step ->> 'key') -> 'note' is null;
    -- No photo can be linked before F4-2, so a required photo step has none.
    select coalesce(jsonb_agg(s.step ->> 'key' order by s.n), '[]'::jsonb) into v_photo
      from jsonb_array_elements(v_steps) with ordinality as s(step, n)
     where coalesce((s.step ->> 'required')::boolean, false)
       and s.step ->> 'kind' = 'photo';
    if jsonb_array_length(v_missing) > 0 or jsonb_array_length(v_failed) > 0
       or jsonb_array_length(v_photo) > 0 then
      raise exception 'checklist_incomplete' using errcode = '22023', hint = 'checklist_incomplete',
        detail = jsonb_build_object('missing', v_missing, 'failedWithoutNote', v_failed,
                                    'photoStepsWithoutPhoto', v_photo)::text;
    end if;
  end if;

  v_now := clock_timestamp();
  update public.checklist_runs
     set results = v_results,
         note = v_note,
         revision = revision + 1,
         last_save_id = p_save_id,
         updated_at = v_now,
         status = case when v_complete then 'completed' else status end,
         completed_by = case when v_complete then auth.uid() else completed_by end,
         completed_at = case when v_complete then v_now else completed_at end
   where id = v_run.id
  returning * into v_run;
  run := v_run;
  saved := true;
end;
$$;

-- ═══ 6. Grants and RLS ════════════════════════════════════════════════════

alter table public.checklist_versions enable row level security;
alter table public.checklist_runs enable row level security;

-- The default ACL grants every privilege (TRUNCATE, REFERENCES and TRIGGER
-- included) to anon, authenticated and service_role: take all of it back,
-- then give back reading only.
revoke all on table public.checklist_versions, public.checklist_runs from public, anon, authenticated, service_role;
grant select on table public.checklist_versions, public.checklist_runs to authenticated, service_role;

create policy checklist_versions_select on public.checklist_versions
  for select to authenticated
  using ((select public.is_org_member(checklist_versions.organization_id)));

-- The EXISTS runs under the caller's own purchase_orders_select, so a run is
-- visible exactly when its purchase order is (membership,
-- purchase_orders:read and, below manager, the warehouse scope).
create policy checklist_runs_select on public.checklist_runs
  for select to authenticated
  using ((select public.is_org_member(checklist_runs.organization_id))
         and exists (select 1 from public.purchase_orders po
                      where po.id = checklist_runs.purchase_order_id));

-- Functions: the default ACL grants EXECUTE to PUBLIC, anon, authenticated
-- and service_role directly.
revoke all on function public._checklist_assert_recorder(uuid) from public, anon, authenticated, service_role;
revoke all on function public._checklist_assert_publisher(uuid) from public, anon, authenticated, service_role;
revoke all on function public._checklist_normalize_steps(jsonb, boolean) from public, anon, authenticated, service_role;
revoke all on function public._checklist_validate_results(jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.checklist_publish(uuid, text, text, jsonb, uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.checklist_retire(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.receiving_check_start(uuid) from public, anon, authenticated, service_role;
revoke all on function public.checklist_run_save(uuid, jsonb, text, integer, uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.checklist_publish(uuid, text, text, jsonb, uuid, uuid, uuid) to authenticated;
grant execute on function public.checklist_retire(uuid, text, uuid) to authenticated;
grant execute on function public.receiving_check_start(uuid) to authenticated;
grant execute on function public.checklist_run_save(uuid, jsonb, text, integer, uuid, boolean) to authenticated;

-- ═══ 7. Comments ══════════════════════════════════════════════════════════

comment on table public.checklist_versions is
  'Receiving checklist (F4-1): one frozen version per publish. steps are the server''s normalised list (keys s1..sN, kind check|count|text, label, help, required). Written only by checklist_publish and checklist_retire; a version never changes except to be retired. At most one live per organization and binding. Members read; nobody writes through the API.';
comment on table public.checklist_runs is
  'Receiving checklist (F4-1): what a person checked for one receipt, on the version it started with. One per receipt. Written only by receiving_check_start and checklist_run_save; visible exactly when its purchase order is (checklist_runs_select). Records observations only: no stock, receipt or purchase order is written.';
comment on column public.checklist_versions.deleted_users is
  'The "Deleted user" marker (the 0393 pattern): {person column: when} once that person deleted their account and the key nulled the column. Written only by tg_mark_deleted_users.';
comment on column public.checklist_runs.deleted_users is
  'The "Deleted user" marker (the 0393 pattern): {person column: when} once that person deleted their account and the key nulled the column. Written only by tg_mark_deleted_users.';
comment on column public.checklist_runs.results is
  'Answers by step key: {value?, note?}. check: pass | fail | na; count: a whole number 0 to 1,000,000; text: up to 500 characters; note: up to 300. Validated against the run''s own version by checklist_run_save.';
comment on column public.checklist_runs.revision is
  'Incremented by every save; a save names the revision it was made on (checklist_run_changed otherwise).';
comment on constraint checklist_versions_published_by_deleted_chk on public.checklist_versions is
  'Exactly one (the 0393 rule): the version names who published it, or records that they deleted their account.';
comment on constraint checklist_runs_started_by_deleted_chk on public.checklist_runs is
  'Exactly one (the 0393 rule): the run names who started it, or records that they deleted their account.';
comment on function public._checklist_assert_recorder(uuid) is
  'Receiving checklist (F4-1): signed in (42501 not_authenticated), a member (42501 not_member), receiving on (P0001 module_disabled), manager or above with stock:adjust and purchase_orders:read (42501 not_recorder). SECURITY DEFINER, no EXECUTE for any API role.';
comment on function public._checklist_assert_publisher(uuid) is
  'Receiving checklist (F4-1): signed in (42501 not_authenticated), a member (42501 not_member), receiving on (P0001 module_disabled), manager or above with purchase_orders:manage (42501 not_publisher). SECURITY DEFINER, no EXECUTE for any API role.';
comment on function public._checklist_normalize_steps(jsonb, boolean) is
  'Receiving checklist (F4-1): steps as stored (keys s1..sN by position, kind, trimmed label 1-120, help up to 300 or null, required); photo only when allowed. 22023 checklist_invalid with detail {field, step, reason}. No EXECUTE for any API role.';
comment on function public._checklist_validate_results(jsonb, jsonb) is
  'Receiving checklist (F4-1): results as stored, checked against the version''s steps (known keys, the value of the step''s kind, notes up to 300), blank answers left out. 22023 checklist_invalid with detail {field, key, reason}. No EXECUTE for any API role.';
comment on function public.checklist_publish(uuid, text, text, jsonb, uuid, uuid, uuid) is
  'Receiving checklist (F4-1): publish version N+1 and retire the live one in the same transaction, answering {version, created}. Gate: _checklist_assert_publisher. A known p_client_publish_id answers its version with created false (a retry); p_expected_current must be the live version id or null when none is (P0001 checklist_changed); steps, title and procedure as _checklist_normalize_steps and the procedure live in the organization (22023 checklist_invalid). SECURITY DEFINER, EXECUTE to authenticated only.';
comment on function public.checklist_retire(uuid, text, uuid) is
  'Receiving checklist (F4-1): turn off the live version (only the live id; P0001 checklist_changed otherwise). Gate: _checklist_assert_publisher. Recorded runs stay. SECURITY DEFINER, EXECUTE to authenticated only.';
comment on function public.receiving_check_start(uuid) is
  'Receiving checklist (F4-1): the run for a receipt, made on the live version when there is none ({runId, created, versionNumber}). The organization comes from the receipt (P0002 receipt_not_found for a missing receipt or a non-member); gate _checklist_assert_recorder; an existing run is answered whatever its state; a new one needs a posted or reversed receipt (P0001 receipt_not_checkable) and a live version (P0001 no_checklist). SECURITY DEFINER, EXECUTE to authenticated only.';
comment on function public.checklist_run_save(uuid, jsonb, text, integer, uuid, boolean) is
  'Receiving checklist (F4-1): save a run''s answers and note, and optionally complete it. The run FOR UPDATE (P0002 checklist_run_not_found); gate _checklist_assert_recorder; answers {run, saved}; a resent p_save_id answers the row unchanged with saved false; a completed run is final (P0001 checklist_run_completed); p_expected_revision must match (P0001 checklist_run_changed); answers as _checklist_validate_results; completing needs every required step answered and a note on every failed check (22023 checklist_incomplete, detail {missing, failedWithoutNote, photoStepsWithoutPhoto}). SECURITY DEFINER, EXECUTE to authenticated only.';
comment on policy checklist_versions_select on public.checklist_versions is
  'Receiving checklist (F4-1): members read every version of their organization.';
comment on policy checklist_runs_select on public.checklist_runs is
  'Receiving checklist (F4-1): a run is visible exactly when its purchase order is to the caller (the EXISTS runs under purchase_orders_select).';

reset lock_timeout;
