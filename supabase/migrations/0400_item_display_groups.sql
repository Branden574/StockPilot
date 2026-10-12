-- 0400_item_display_groups.sql
--
-- GROUP SELECTED (slice G2 of the one grouping contract; owner brief
-- 2026-10-11, Phase 1): let someone who can edit items pick records on Items
-- or Books and show them together as one group, without copying a SKU onto
-- each of them, changing a charter or a rack, or touching stock. The number
-- is a placeholder (production is at 0398; Ungroup takes 0399): it is fixed
-- at the PR stage to the next free number, and no function body names it, so
-- no fingerprint recorded here changes when the file is renumbered.
--
-- Design: stockpilot-work/grouping-visibility-push/design-merged.md, sections
-- 2 (data model), 3 (server contract: 3.1 preview, 3.2 apply steps and lock
-- order, 3.3 membership rules), 7 (books and families) and 10 (invariants).
-- Owner decisions taken on the design's recommended defaults (recorded in
-- stockpilot-work/group-selected/G2-NOTES.md for the owner to overrule):
--   * a new placement of a grouped record's SKU stays OUTSIDE the group (the
--     lists offer "Add to group"); nothing joins a group by itself;
--   * kits are excluded (not_groupable, reason kit), and so are rentals (the
--     Items and Books lists never show them);
--   * a display group is NEVER a certified product family: group_id,
--     variant_key and product_groups are never read to decide a membership
--     and never written; a group is never a kit, a substitute, or an
--     identity for exchange eligibility, PO matching, Book Order Totals,
--     reports or exports (none of those reads these tables).
--
-- ── WHAT IT ADDS ───────────────────────────────────────────────────────────
-- No existing row, function, policy, trigger, index or grant changes, and no
-- column is added to inventory_items: a membership change never writes an
-- item row, so updated_at, the "Recently updated" order, realtime and the
-- item triggers are untouched (critique D1).
--   1. item_display_groups: a group's header (organization, item type, name,
--      version, closed_at). It owns no quantity and claims no identity.
--   2. item_display_group_members: one row per record (the primary key is the
--      item id, so a record is in at most one group). A trigger keeps a row
--      consistent: the record is live, the group is open, both are in the
--      row's organization and of the same item type.
--   3. RLS (SELECT only, to authenticated): a membership is readable exactly
--      when its record is (the inventory_items SELECT policy, run as the
--      caller); a group is readable exactly when at least one LIVE member
--      record is. Hidden records, their memberships and a group none of whose
--      records the caller can read never reach the caller. No INSERT, UPDATE
--      or DELETE privilege or policy for any API role: only the functions
--      below write, as the tables' owner. service_role may SELECT (the
--      manager's cached list loader reads with it; managers read every
--      record).
--   4. item_grouping_preview(request): what the review dialog shows, read as
--      the caller (SECURITY INVOKER, STABLE): the readable selected records,
--      their current group, their product family, whether the caller can
--      edit each, how many selected ids are unavailable, the readable
--      same-SKU records not selected, candidate groups, and the target
--      group's readable members. It never names item_stock_levels (INV-33):
--      racks and quantities per rack come from the app's RLS-scoped holdings
--      read.
--   5. _display_grouping_request (shape) and _display_grouping_apply
--      (records, locks, rules, writes, audit): private steps, no API EXECUTE.
--      (Named outside 0399's _item_grouping_ prefix, whose pgTAP pins that
--      family's exact members.)
--   6. apply_item_grouping(request, key): the entry point for the actions
--      group, remove and rename. SECURITY DEFINER, EXECUTE to authenticated
--      only. Ungroup keeps its own entry point (split_item_sku, 0399); both
--      use 0399's _item_grouping_claim / _item_grouping_record and its
--      item_grouping_requests table, whose action check already admits these
--      three actions: one key space, and the hash covers the action, so a
--      key spent on one action never replays as another.
--
-- ── apply_item_grouping(p_request jsonb, p_key text) ───────────────────────
-- p_request (snake_case, built by core toGroupingRpcRequest): action,
-- organization_id, actor_user_id, surface ('web' | 'app'), and per action:
--   group:  item_ids (1 to 100 distinct uuids; at least 2 for a new group),
--           target {kind 'new', name} | {kind 'existing', group_id,
--           expected_version}, expected_groups {item id: the group id the
--           caller saw, or null} (exactly the item ids), move_item_ids
--           (selected records the caller explicitly agreed to move out of
--           another group; default none), acknowledge_product_family
--           (boolean; default false).
--   remove: item_ids (1 to 100), expected_groups {item id: group id}.
--   rename: group_id, expected_version, name.
-- A name is trimmed and 1 to 120 characters.
-- Steps, in this order (design 3.2):
--   1. Identity: signed in (42501 unauthenticated); actor_user_id is the
--      caller (42501 actor_mismatch); a member (42501 not_member).
--   2. Key: present and uuid-shaped (22023 idempotency_key_required,
--      idempotency_key_invalid).
--   3. Shape (pure): 22023 grouping_invalid with the field as detail.
--   4. The request hash: md5 of a scope tag and the canonical jsonb text.
--   5. The organization's grouping lock and 6. replay: 0399's
--      _item_grouping_claim (the stored outcome with replay true; another
--      action or hash under the key is P0001 idempotency_conflict). Every
--      grouping write in an organization (group, remove, rename and Ungroup's
--      split) runs under this one lock, one at a time.
--   7. Permission: has_permission(items:update), else 42501 permission.
--   8. Records (group, remove): a missing, deleted, other-organization or
--      unreadable id is P0002 item_not_found (one answer for each; the detail
--      lists only ids the caller sent); one the caller cannot write is 42501
--      item_not_writable (caller_can_write_item, 0399).
--   9. Locks, never waiting on a row: the selected records in ONE id-ordered
--      SELECT ... FOR SHARE NOWAIT (it holds off an edit, a delete or a scope
--      move of a checked record until commit, and lets order lines and other
--      key-share references through), then every group the request touches
--      in ONE id-ordered SELECT ... FOR UPDATE NOWAIT. A held row is 55P03
--      busy at once. Under the locks: a record deleted since, moved to
--      another organization, or out of the caller's write scope is P0001
--      item_changed.
--  10. Rules (design 3.3):
--      group: a kit or a rental is P0001 not_groupable (reason kit |
--        rental); records of more than one item type, or of another type than
--        the target group, are P0001 mixed_item_types; a target group that is
--        missing, closed, in another organization or has no live member the
--        caller can read is P0002 group_not_found (the same answer for each);
--        a target whose version is not expected_version is P0001
--        group_changed. NO-OP: every record already in the target group, or
--        (target new, no move asked) every record already in one same group
--        G: nothing is written, the answer names that group, and no second
--        group is ever made by a repeat. Then a record whose group is not the
--        one the caller saw is P0001 membership_changed. A record in ANOTHER group
--        that is not in move_item_ids is P0001 membership_conflict (never a
--        silent move); a product-family member (group_id set) without
--        acknowledge_product_family is P0001 product_family_conflict (its
--        family is not changed either way); more than 200 live records in
--        the target afterwards is P0001 group_too_large.
--      remove: a record no longer in any group is left as it is; one in
--        another group than the caller saw is P0001 membership_changed.
--      rename: the group as above (group_not_found, group_changed); only a
--        manager, or someone who can edit every live record in the group, may
--        rename it (42501 rename_not_permitted, worded "Only a manager can
--        rename this group", which says nothing about hidden records); the
--        same name is a no-op.
--  11. Writes, set-based, to these two tables only: a new group row; one
--      upsert of the changing memberships; one delete of the removed ones;
--      every group that lost or gained a record gets version + 1, and a group
--      left with no live record is closed (closed_at) and its remaining rows
--      (records deleted earlier) are dropped, so a closed group is empty.
--      Never an item row, a SKU, barcode/ISBN, name, category, price, charter,
--      rack, warehouse, stock, reservation, order, return or product_groups
--      row; no fan-out.
--  12. Audit in the same transaction (no ip or user agent: SQL-written rows,
--      the 0345 precedent, design R9): inventory.group.created (the group),
--      inventory.group.members_added (one per record that joined or moved,
--      with the group it left, if any), inventory.group.members_removed (one
--      per record that left, with whether the group closed),
--      inventory.group.renamed (the group, before and after). Item rows carry
--      entity_type inventory_item and the record id, so each record's
--      Activity shows them.
--  13. Record the outcome under the key (0399's _item_grouping_record) and
--      answer it: {action, outcome 'applied' | 'noop', group {id, name,
--      version, item_type, closed} | null, changes [{item_id, from_group_id,
--      to_group_id}] (id order), closed_group_ids, created, replay}.
--
-- ── LOCK ORDER ─────────────────────────────────────────────────────────────
-- The organization's grouping advisory lock (0399), then the selected item
-- rows (FOR SHARE NOWAIT, id order), then the group rows (FOR UPDATE NOWAIT,
-- id order). Inserting a membership takes FOR KEY SHARE on its item through
-- the foreign key; that may wait behind a stock function's FOR UPDATE, which
-- never waits on a grouping lock, so there is no cycle, and the entry point's
-- lock_timeout (5 s) answers 55P03 if it ever lasts. Nothing here waits on an
-- item row lock otherwise.
--
-- ── ERRORS ─────────────────────────────────────────────────────────────────
--   42501 unauthenticated, actor_mismatch, not_member, permission,
--         item_not_writable, rename_not_permitted
--   22023 grouping_invalid (detail: the field), idempotency_key_required,
--         idempotency_key_invalid
--   P0002 item_not_found, group_not_found
--   P0001 idempotency_conflict, item_changed, not_groupable,
--         mixed_item_types, group_changed, membership_changed,
--         membership_conflict, product_family_conflict, group_too_large
--   55P03 busy (a held row), or the lock_timeout of the advisory lock
--   23514 item_display_group_member_inconsistent (the trigger; unreachable
--         through apply, which checks the same first)
-- Item-level refusals carry detail {"itemIds": [...]} (not_groupable adds
-- "reason"). No function here raises the two classes PostgREST would re-run
-- forever (0367). The app maps by hint (core grouping-contract.ts).
--
-- ── LOCK FOOTPRINT OF THIS FILE ────────────────────────────────────────────
-- The foreign keys add RI triggers to organizations and inventory_items
-- (SHARE ROW EXCLUSIVE on both, to commit: a write to inventory_items waits
-- for the push's few milliseconds). On this platform CREATE POLICY run by
-- postgres also takes ACCESS EXCLUSIVE, to commit, on every table
-- supautils.policy_grants lists for the role (0390 and 0391 have the
-- evidence). Every function here is plpgsql, so creating one reads no table.
-- So one prelude (0391's) takes every table lock the file needs at once, all
-- NOWAIT, in a bounded retry; no later statement takes a new lock on an
-- existing table, so the file never waits while holding one.

set lock_timeout = '5s';

-- ═══ 0. Preflight ══════════════════════════════════════════════════════════
-- The predicates and the 0399 steps this file relies on must be the bodies it
-- was written against (production head 0398, read 2026-10-12; 0399 as on the
-- Ungroup branch at efa2447f5), and every new name must be free. Anything
-- else is drift: stop before changing anything.
do $preflight$
declare
  v_bad text := '';
  r record;
begin
  for r in
    select v.sig, v.want_src, v.want_secdef, p.oid as poid, md5(p.prosrc) as got_src, p.prosecdef as got_secdef,
           pg_get_userbyid(p.proowner) as got_owner
      from (values
        ('public.caller_can_read_item(uuid)',                         '80523d2cc0fafe7fc6b3599903d7f014', true),
        ('public.caller_can_write_item(uuid)',                        'd139595a73d9f56b450d37fd79196321', true),
        ('public.has_permission(uuid,text)',                          'cc0accdad7e2fdf4f88aa82aa887e85f', true),
        ('public.has_org_role(uuid,text)',                            '10422b29a6e15acd003d4f11ed28e90c', true),
        ('public.is_org_member(uuid)',                                '76492a6556e9f6a7c33d942aa9726f9f', true),
        ('public.rls_member_org_ids()',                               '68860888450deeef2bbf628712c5b971', true),
        ('public._item_grouping_claim(uuid,uuid,uuid,text,text)',     '269e064638f7fbf5748f1e2856d9d562', false),
        ('public._item_grouping_record(uuid,uuid,uuid,text,text,jsonb)', '0cc49d61623ef64d873b534dc9560d8f', false)
      ) v(sig, want_src, want_secdef)
      left join pg_proc p on p.oid = to_regprocedure(v.sig)
  loop
    if r.poid is null then
      v_bad := v_bad || format(' %s missing;', r.sig);
    elsif r.got_src <> r.want_src or r.got_secdef <> r.want_secdef or r.got_owner <> 'postgres' then
      v_bad := v_bad || format(' %s drifted (md5 %s, definer %s, owner %s);', r.sig, r.got_src, r.got_secdef, r.got_owner);
    end if;
  end loop;

  -- 0399's request log must admit this file's three actions.
  if to_regclass('public.item_grouping_requests') is null
     or not exists (select 1 from pg_constraint c
                     where c.conrelid = 'public.item_grouping_requests'::regclass and c.contype = 'c'
                       and pg_get_constraintdef(c.oid) = 'CHECK ((action = ANY (ARRAY[''group''::text, ''remove''::text, ''rename''::text, ''split_sku''::text])))') then
    v_bad := v_bad || ' item_grouping_requests is missing or its action check changed;';
  end if;

  if to_regclass('public.item_display_groups') is not null
     or to_regclass('public.item_display_group_members') is not null
     or to_regprocedure('public.apply_item_grouping(jsonb,text)') is not null
     or to_regprocedure('public.item_grouping_preview(jsonb)') is not null
     or exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
                   and (p.proname like '\_display\_grouping\_%' or p.proname like '%display\_group%')) then
    v_bad := v_bad || ' the display group objects already exist;';
  end if;

  if v_bad <> '' then
    raise exception 'display_groups_preflight: %', v_bad
      using errcode = '55000', hint = 'display_groups_preflight';
  end if;
end
$preflight$;

-- ═══ 1. The lock prelude (see LOCK FOOTPRINT) ═════════════════════════════
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
      lock table only public.organizations, public.inventory_items in share row exclusive mode nowait;
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

set lock_timeout = '900ms';

-- ═══ 2. item_display_groups ═══════════════════════════════════════════════
create table public.item_display_groups (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- The item_type domain (0020): a group holds records of one type, so Items
  -- and Books never share a group.
  item_type       text not null check (item_type in ('product', 'book', 'asset', 'consumable')),
  name            text not null check (name = btrim(name) and char_length(name) between 1 and 120),
  version         integer not null default 1 check (version >= 1),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- Set when the last live record leaves; a closed group is empty and never
  -- reopened.
  closed_at       timestamptz,
  constraint item_display_groups_org_id_key unique (organization_id, id)
);
create index item_display_groups_org_open_idx
  on public.item_display_groups (organization_id, item_type, updated_at desc) where closed_at is null;

comment on table public.item_display_groups is
  'Group selected (0400): a group that shows records together on Items/Books. Display only: it owns no quantity, '
  'claims no identity, and is never a product family, a kit, a substitute, or a key for exchange eligibility, PO '
  'matching, Book Order Totals, reports or exports. Readable when at least one live member record is readable; '
  'written only by apply_item_grouping. Who changed it is in audit_logs (inventory.group.*).';

-- ═══ 3. item_display_group_members ════════════════════════════════════════
create table public.item_display_group_members (
  -- The primary key: a record is in at most one group.
  item_id         uuid primary key references public.inventory_items(id) on delete cascade,
  organization_id uuid not null,
  group_id        uuid not null,
  added_at        timestamptz not null default now(),
  constraint item_display_group_members_group_fk foreign key (organization_id, group_id)
    references public.item_display_groups (organization_id, id) on delete cascade
);
create index item_display_group_members_group_idx on public.item_display_group_members (group_id);
create index item_display_group_members_org_idx on public.item_display_group_members (organization_id);

comment on table public.item_display_group_members is
  'Group selected (0400): one row per record in a display group (the primary key is the item id). Readable exactly '
  'when the record is; written only by apply_item_grouping. Kept consistent by '
  'trg_item_display_group_members_consistency.';

-- The record and the group must be live/open, in the row's organization and
-- of one item type. inventory_items has no (organization_id, id) key, so a
-- composite foreign key cannot say this (the FK-org class, 0201-0206).
create or replace function public.tg_item_display_group_members_consistency()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if not exists (
       select 1
         from public.inventory_items i
         join public.item_display_groups g on g.id = new.group_id
        where i.id = new.item_id
          and i.organization_id = new.organization_id
          and g.organization_id = new.organization_id
          and i.item_type = g.item_type
          and i.deleted_at is null
          and g.closed_at is null) then
    raise exception 'item_display_group_member_inconsistent' using errcode = '23514',
      hint = 'item_display_group_member_inconsistent';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_item_display_group_members_consistency() from public, anon, authenticated, service_role;

create trigger trg_item_display_group_members_consistency
  before insert or update on public.item_display_group_members
  for each row execute function public.tg_item_display_group_members_consistency();

-- ═══ 4. Privileges and RLS ════════════════════════════════════════════════
alter table public.item_display_groups enable row level security;
alter table public.item_display_group_members enable row level security;
-- Supabase's default privileges grant every new public table to anon,
-- authenticated and service_role: take them all back, then grant SELECT only.
revoke all on table public.item_display_groups, public.item_display_group_members
  from public, anon, authenticated, service_role;
grant select on table public.item_display_groups, public.item_display_group_members to authenticated, service_role;

-- A membership is readable exactly when its record is: the EXISTS runs the
-- inventory_items SELECT policy as the caller. rls_member_org_ids excludes a
-- disabled account and an expired impersonation (0310).
create policy item_display_group_members_select on public.item_display_group_members
  for select to authenticated
  using (organization_id in (select public.rls_member_org_ids())
         and exists (select 1 from public.inventory_items i
                      where i.id = item_display_group_members.item_id
                        and i.organization_id = item_display_group_members.organization_id));

-- A group is readable exactly when at least one LIVE member record is (the
-- members policy and the inventory_items policy run inside the EXISTS). So a
-- group made only of records the caller cannot read, its name included, never
-- reaches the caller.
create policy item_display_groups_select on public.item_display_groups
  for select to authenticated
  using (organization_id in (select public.rls_member_org_ids())
         and exists (select 1
                       from public.item_display_group_members m
                       join public.inventory_items i on i.id = m.item_id
                      where m.group_id = item_display_groups.id
                        and i.deleted_at is null));

-- ═══ 5. The request's shape ═══════════════════════════════════════════════
create or replace function public._display_grouping_request(p_request jsonb)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = public, pg_temp
as $$
declare
  c_uuid     constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_action   text := case when jsonb_typeof(p_request->'action') = 'string' then p_request->>'action' end;
  v_ids      jsonb := p_request->'item_ids';
  v_exp      jsonb := p_request->'expected_groups';
  v_target   jsonb := p_request->'target';
  v_move     jsonb := p_request->'move_item_ids';
  v_ack      jsonb := p_request->'acknowledge_product_family';
  v_id_list  text[];
  v_move_list text[];
  v_expected jsonb;
  v_name     text;
  v_kind     text;
  v_gid      text;
  v_ver      jsonb;
  v_canon_target jsonb;
begin
  if v_action is null or v_action not in ('group', 'remove', 'rename') then
    raise exception 'grouping_invalid' using errcode = '22023', hint = 'grouping_invalid', detail = 'action';
  end if;

  if v_action = 'rename' then
    v_gid := case when jsonb_typeof(p_request->'group_id') = 'string' then p_request->>'group_id' end;
    if v_gid is null or v_gid !~ c_uuid then
      raise exception 'grouping_invalid' using errcode = '22023', hint = 'grouping_invalid', detail = 'group_id';
    end if;
    v_ver := p_request->'expected_version';
    -- CASE, so the numeric casts run only on a number.
    if (case when v_ver is null or jsonb_typeof(v_ver) <> 'number' then true
             else (v_ver #>> '{}')::numeric <> trunc((v_ver #>> '{}')::numeric)
                  or (v_ver #>> '{}')::numeric < 1 or (v_ver #>> '{}')::numeric > 2147483647 end) then
      raise exception 'grouping_invalid' using errcode = '22023', hint = 'grouping_invalid', detail = 'expected_version';
    end if;
    v_name := case when jsonb_typeof(p_request->'name') = 'string' then btrim(p_request->>'name') end;
    if v_name is null or char_length(v_name) < 1 or char_length(v_name) > 120 then
      raise exception 'grouping_invalid' using errcode = '22023', hint = 'grouping_invalid', detail = 'name';
    end if;
    return jsonb_build_object('action', 'rename', 'group_id', lower(v_gid),
                              'expected_version', (v_ver #>> '{}')::integer, 'name', v_name);
  end if;

  -- item_ids: 1 to 100 distinct uuid strings.
  if v_ids is null or jsonb_typeof(v_ids) <> 'array'
     or jsonb_array_length(v_ids) < 1 or jsonb_array_length(v_ids) > 100
     or exists (select 1 from jsonb_array_elements(v_ids) e(v)
                 where case when jsonb_typeof(v) <> 'string' then true else (v #>> '{}') !~ c_uuid end) then
    raise exception 'grouping_invalid' using errcode = '22023', hint = 'grouping_invalid', detail = 'item_ids';
  end if;
  select array_agg(lower(v #>> '{}') order by lower(v #>> '{}')) into v_id_list
    from jsonb_array_elements(v_ids) e(v);
  if (select count(distinct x) from unnest(v_id_list) x) <> cardinality(v_id_list) then
    raise exception 'grouping_invalid' using errcode = '22023', hint = 'grouping_invalid', detail = 'item_ids';
  end if;

  -- expected_groups: exactly one entry per item id, keyed by the id; the
  -- value is a group id (or, for group, null: not in a group).
  if v_exp is null or jsonb_typeof(v_exp) <> 'object'
     or exists (select 1 from jsonb_each(v_exp) e(k, v)
                 where k !~ c_uuid
                    or case when jsonb_typeof(v) = 'null' then v_action <> 'group'
                            when jsonb_typeof(v) = 'string' then (v #>> '{}') !~ c_uuid
                            else true end) then
    raise exception 'grouping_invalid' using errcode = '22023', hint = 'grouping_invalid', detail = 'expected_groups';
  end if;
  select jsonb_object_agg(lower(e.k), case when jsonb_typeof(e.v) = 'null' then 'null'::jsonb
                                           else to_jsonb(lower(e.v #>> '{}')) end)
    into v_expected
    from jsonb_each(v_exp) e(k, v);
  if (select count(*) from jsonb_object_keys(v_exp)) <> cardinality(v_id_list)
     or (select count(*) from jsonb_object_keys(coalesce(v_expected, '{}'::jsonb))) <> cardinality(v_id_list)
     or exists (select 1 from unnest(v_id_list) x where not (coalesce(v_expected, '{}'::jsonb) ? x)) then
    raise exception 'grouping_invalid' using errcode = '22023', hint = 'grouping_invalid', detail = 'expected_groups';
  end if;

  if v_action = 'remove' then
    return jsonb_build_object('action', 'remove', 'item_ids', to_jsonb(v_id_list), 'expected_groups', v_expected);
  end if;

  -- group: the target.
  if v_target is null or jsonb_typeof(v_target) <> 'object' then
    raise exception 'grouping_invalid' using errcode = '22023', hint = 'grouping_invalid', detail = 'target';
  end if;
  v_kind := case when jsonb_typeof(v_target->'kind') = 'string' then v_target->>'kind' end;
  if v_kind = 'new' then
    v_name := case when jsonb_typeof(v_target->'name') = 'string' then btrim(v_target->>'name') end;
    if v_name is null or char_length(v_name) < 1 or char_length(v_name) > 120 then
      raise exception 'grouping_invalid' using errcode = '22023', hint = 'grouping_invalid', detail = 'name';
    end if;
    -- A new group starts with at least two records.
    if cardinality(v_id_list) < 2 then
      raise exception 'grouping_invalid' using errcode = '22023', hint = 'grouping_invalid', detail = 'item_ids';
    end if;
    v_canon_target := jsonb_build_object('kind', 'new', 'name', v_name);
  elsif v_kind = 'existing' then
    v_gid := case when jsonb_typeof(v_target->'group_id') = 'string' then v_target->>'group_id' end;
    if v_gid is null or v_gid !~ c_uuid then
      raise exception 'grouping_invalid' using errcode = '22023', hint = 'grouping_invalid', detail = 'target';
    end if;
    v_ver := v_target->'expected_version';
    if (case when v_ver is null or jsonb_typeof(v_ver) <> 'number' then true
             else (v_ver #>> '{}')::numeric <> trunc((v_ver #>> '{}')::numeric)
                  or (v_ver #>> '{}')::numeric < 1 or (v_ver #>> '{}')::numeric > 2147483647 end) then
      raise exception 'grouping_invalid' using errcode = '22023', hint = 'grouping_invalid', detail = 'expected_version';
    end if;
    v_canon_target := jsonb_build_object('kind', 'existing', 'group_id', lower(v_gid),
                                         'expected_version', (v_ver #>> '{}')::integer);
  else
    raise exception 'grouping_invalid' using errcode = '22023', hint = 'grouping_invalid', detail = 'target';
  end if;

  -- move_item_ids: absent or null is none; otherwise distinct selected ids.
  if v_move is null or jsonb_typeof(v_move) = 'null' then
    v_move_list := '{}';
  else
    if jsonb_typeof(v_move) <> 'array' or jsonb_array_length(v_move) > 100
       or exists (select 1 from jsonb_array_elements(v_move) e(v)
                   where case when jsonb_typeof(v) <> 'string' then true else (v #>> '{}') !~ c_uuid end) then
      raise exception 'grouping_invalid' using errcode = '22023', hint = 'grouping_invalid', detail = 'move_item_ids';
    end if;
    select coalesce(array_agg(lower(v #>> '{}') order by lower(v #>> '{}')), '{}') into v_move_list
      from jsonb_array_elements(v_move) e(v);
    if (select count(distinct x) from unnest(v_move_list) x) <> cardinality(v_move_list)
       or exists (select 1 from unnest(v_move_list) x where not (x = any (v_id_list))) then
      raise exception 'grouping_invalid' using errcode = '22023', hint = 'grouping_invalid', detail = 'move_item_ids';
    end if;
  end if;

  if v_ack is not null and jsonb_typeof(v_ack) not in ('boolean', 'null') then
    raise exception 'grouping_invalid' using errcode = '22023', hint = 'grouping_invalid', detail = 'acknowledge_product_family';
  end if;

  return jsonb_build_object('action', 'group',
                            'item_ids', to_jsonb(v_id_list),
                            'target', v_canon_target,
                            'expected_groups', v_expected,
                            'move_item_ids', to_jsonb(v_move_list),
                            'acknowledge_product_family', coalesce(v_ack = 'true'::jsonb, false));
end;
$$;

revoke all on function public._display_grouping_request(jsonb) from public, anon, authenticated, service_role;

comment on function public._display_grouping_request(jsonb) is
  'The group/remove/rename request''s shape (0400), pure: answers the canonical form (ids lower case and sorted, the '
  'name trimmed, the flags defaulted) or raises 22023 grouping_invalid with the field as detail. No API EXECUTE.';

-- ═══ 6. The records, locks, rules, writes and audit ═══════════════════════
create or replace function public._display_grouping_apply(
  p_org uuid, p_uid uuid, p_req jsonb, p_key uuid, p_hash text, p_surface text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_action    text := p_req->>'action';
  v_ids       uuid[];
  v_expected  jsonb := coalesce(p_req->'expected_groups', '{}'::jsonb);
  v_move      uuid[];
  v_ack       boolean := coalesce((p_req->>'acknowledge_product_family')::boolean, false);
  v_bad       jsonb;
  v_cur       jsonb;
  v_type      text;
  v_ntypes    integer;
  v_target_id uuid;
  v_new       boolean;
  v_target    public.item_display_groups%rowtype;
  v_gids      uuid[];
  v_change    uuid[];
  v_src       uuid[];
  v_closed    uuid[];
  v_live      integer;
  v_noop_gid  uuid;
  v_name      text;
  v_old_name  text;
  v_names     jsonb;
  v_outcome   jsonb;
  v_changes   jsonb;
begin
  -- ── rename ───────────────────────────────────────────────────────────────
  if v_action = 'rename' then
    v_target_id := (p_req->>'group_id')::uuid;
    v_name := p_req->>'name';
    -- The group: in this organization, open, with a live record the caller
    -- can read. Every other case is the same answer.
    if not exists (select 1 from public.item_display_groups g
                    where g.id = v_target_id and g.organization_id = p_org and g.closed_at is null)
       or not exists (select 1 from public.item_display_group_members m
                        join public.inventory_items i on i.id = m.item_id
                       where m.group_id = v_target_id and i.deleted_at is null
                         and public.caller_can_read_item(i.id)) then
      raise exception 'group_not_found' using errcode = 'P0002', hint = 'group_not_found';
    end if;
    begin
      select g.* into v_target from public.item_display_groups g where g.id = v_target_id for update nowait;
    exception when lock_not_available then
      raise exception 'busy' using errcode = '55P03', hint = 'busy';
    end;
    if v_target.closed_at is not null then
      raise exception 'group_not_found' using errcode = 'P0002', hint = 'group_not_found';
    end if;
    if v_target.version <> (p_req->>'expected_version')::integer then
      raise exception 'group_changed' using errcode = 'P0001', hint = 'group_changed';
    end if;
    -- A manager, or someone who can edit every live record in the group.
    if not public.has_org_role(p_org, 'manager')
       and exists (select 1 from public.item_display_group_members m
                     join public.inventory_items i on i.id = m.item_id
                    where m.group_id = v_target_id and i.deleted_at is null
                      and not public.caller_can_write_item(i.id)) then
      raise exception 'rename_not_permitted' using errcode = '42501', hint = 'rename_not_permitted';
    end if;
    if v_target.name = v_name then
      return jsonb_build_object('action', 'rename', 'outcome', 'noop',
               'group', jsonb_build_object('id', v_target.id, 'name', v_target.name, 'version', v_target.version,
                                           'item_type', v_target.item_type, 'closed', false),
               'changes', '[]'::jsonb, 'closed_group_ids', '[]'::jsonb, 'created', false);
    end if;
    v_old_name := v_target.name;
    update public.item_display_groups g
       set name = v_name, version = g.version + 1, updated_at = now()
     where g.id = v_target_id
    returning g.* into v_target;
    insert into public.audit_logs (organization_id, user_id, event, metadata)
    values (p_org, p_uid, 'inventory.group.renamed',
            jsonb_build_object(
              'entity_type',  'item_display_group',
              'entity_id',    v_target.id,
              'warehouse_id', null,
              'before',       jsonb_build_object('name', v_old_name),
              'after',        jsonb_build_object('name', v_target.name),
              'reason',       null,
              'changed_keys', jsonb_build_array('name'),
              'item_type',    v_target.item_type,
              'request_key',  p_key,
              'request_hash', p_hash,
              'surface',      p_surface,
              'source',       'apply_item_grouping'));
    return jsonb_build_object('action', 'rename', 'outcome', 'applied',
             'group', jsonb_build_object('id', v_target.id, 'name', v_target.name, 'version', v_target.version,
                                         'item_type', v_target.item_type, 'closed', false),
             'changes', '[]'::jsonb, 'closed_group_ids', '[]'::jsonb, 'created', false);
  end if;

  -- ── group and remove: 8. Records ─────────────────────────────────────────
  v_ids := array(select (jsonb_array_elements_text(p_req->'item_ids'))::uuid);
  -- Missing, deleted, in another organization or unreadable: one answer.
  select jsonb_agg(u.id order by u.id) into v_bad
    from unnest(v_ids) u(id)
   where not exists (select 1 from public.inventory_items i
                      where i.id = u.id and i.organization_id = p_org and i.deleted_at is null)
      or not public.caller_can_read_item(u.id);
  if v_bad is not null then
    raise exception 'item_not_found' using errcode = 'P0002', hint = 'item_not_found',
      detail = jsonb_build_object('itemIds', v_bad)::text;
  end if;
  select jsonb_agg(u.id order by u.id) into v_bad
    from unnest(v_ids) u(id)
   where not public.caller_can_write_item(u.id);
  if v_bad is not null then
    raise exception 'item_not_writable' using errcode = '42501', hint = 'item_not_writable',
      detail = jsonb_build_object('itemIds', v_bad)::text;
  end if;

  -- ── 9. Locks: the records, then the groups; never wait on a row ──────────
  begin
    perform 1 from public.inventory_items i where i.id = any (v_ids) order by i.id for share nowait;
  exception when lock_not_available then
    raise exception 'busy' using errcode = '55P03', hint = 'busy';
  end;
  -- Under the record locks (a new statement: it sees what committed before
  -- it). The checks above ran before the lock, each in its own snapshot.
  select jsonb_agg(i.id order by i.id) into v_bad
    from public.inventory_items i
   where i.id = any (v_ids)
     and (i.deleted_at is not null or i.organization_id <> p_org or not public.caller_can_write_item(i.id));
  if v_bad is not null then
    raise exception 'item_changed' using errcode = 'P0001', hint = 'item_changed',
      detail = jsonb_build_object('itemIds', v_bad)::text;
  end if;

  -- The current memberships. Every writer of them holds the organization's
  -- grouping lock (taken in step 5), so they cannot change before commit.
  select jsonb_object_agg(u.id::text, m.group_id) into v_cur
    from unnest(v_ids) u(id)
    left join public.item_display_group_members m on m.item_id = u.id;

  if v_action = 'group' then
    v_new := (p_req #>> '{target,kind}') = 'new';
    v_target_id := case when v_new then null else (p_req #>> '{target,group_id}')::uuid end;
  end if;

  -- Every group the request touches: the target, and the groups the records
  -- are in now. One id-ordered statement.
  v_gids := array(select distinct g from (
                    select (e.value #>> '{}')::uuid as g from jsonb_each(v_cur) e where jsonb_typeof(e.value) = 'string'
                    union all select v_target_id) s
                  where g is not null order by g);
  begin
    perform 1 from public.item_display_groups g
     where g.id = any (v_gids) and g.organization_id = p_org
     order by g.id for update nowait;
  exception when lock_not_available then
    raise exception 'busy' using errcode = '55P03', hint = 'busy';
  end;

  -- ── 10. Rules: remove ────────────────────────────────────────────────────
  if v_action = 'remove' then
    select jsonb_agg(u.id order by u.id) into v_bad
      from unnest(v_ids) u(id)
     where jsonb_typeof(v_cur -> u.id::text) = 'string'
       and (v_cur ->> u.id::text) is distinct from (v_expected ->> u.id::text);
    if v_bad is not null then
      raise exception 'membership_changed' using errcode = 'P0001', hint = 'membership_changed',
        detail = jsonb_build_object('itemIds', v_bad)::text;
    end if;
    v_change := array(select u.id from unnest(v_ids) u(id)
                       where jsonb_typeof(v_cur -> u.id::text) = 'string' order by u.id);
    if cardinality(v_change) = 0 then
      return jsonb_build_object('action', 'remove', 'outcome', 'noop', 'group', null,
                                'changes', '[]'::jsonb, 'closed_group_ids', '[]'::jsonb, 'created', false);
    end if;
    v_src := array(select distinct (v_cur ->> c.id::text)::uuid from unnest(v_change) c(id) order by 1);
    select jsonb_object_agg(g.id::text, g.name) into v_names from public.item_display_groups g where g.id = any (v_src);

    -- ── 11. Writes ─────────────────────────────────────────────────────────
    delete from public.item_display_group_members m where m.item_id = any (v_change);
    update public.item_display_groups g
       set version = g.version + 1,
           updated_at = now(),
           closed_at = case when exists (select 1 from public.item_display_group_members m
                                           join public.inventory_items i on i.id = m.item_id
                                          where m.group_id = g.id and i.deleted_at is null)
                            then null else now() end
     where g.id = any (v_src);
    v_closed := array(select g.id from public.item_display_groups g
                       where g.id = any (v_src) and g.closed_at is not null order by g.id);
    -- A closed group is empty: drop the rows of records deleted earlier.
    delete from public.item_display_group_members m where m.group_id = any (v_closed);

    -- ── 12. Audit, one row per record that left ────────────────────────────
    insert into public.audit_logs (organization_id, user_id, event, metadata)
    select p_org, p_uid, 'inventory.group.members_removed',
           jsonb_build_object(
             'entity_type',  'inventory_item',
             'entity_id',    i.id,
             'warehouse_id', i.warehouse_id,
             'before',       jsonb_build_object('display_group_id', v_cur ->> i.id::text,
                                                'display_group_name', v_names ->> (v_cur ->> i.id::text)),
             'after',        jsonb_build_object('display_group_id', null, 'display_group_name', null),
             'reason',       null,
             'changed_keys', jsonb_build_array('display_group'),
             'group_id',     v_cur ->> i.id::text,
             'group_closed', (v_cur ->> i.id::text)::uuid = any (v_closed),
             'request_key',  p_key,
             'request_hash', p_hash,
             'surface',      p_surface,
             'source',       'apply_item_grouping')
      from public.inventory_items i
     where i.id = any (v_change)
     order by i.id;

    select coalesce(jsonb_agg(jsonb_build_object('item_id', c.id, 'from_group_id', v_cur -> c.id::text,
                                                 'to_group_id', null) order by c.id), '[]'::jsonb)
      into v_changes from unnest(v_change) c(id);
    return jsonb_build_object('action', 'remove', 'outcome', 'applied', 'group', null,
                              'changes', v_changes, 'closed_group_ids', to_jsonb(v_closed), 'created', false);
  end if;

  -- ── 10. Rules: group ─────────────────────────────────────────────────────
  v_move := array(select (jsonb_array_elements_text(p_req->'move_item_ids'))::uuid);

  select jsonb_agg(i.id order by i.id) into v_bad
    from public.inventory_items i where i.id = any (v_ids) and coalesce(i.is_bundle, false);
  if v_bad is not null then
    raise exception 'not_groupable' using errcode = 'P0001', hint = 'not_groupable',
      detail = jsonb_build_object('reason', 'kit', 'itemIds', v_bad)::text;
  end if;
  select jsonb_agg(i.id order by i.id) into v_bad
    from public.inventory_items i where i.id = any (v_ids) and coalesce(i.is_rental, false);
  if v_bad is not null then
    raise exception 'not_groupable' using errcode = 'P0001', hint = 'not_groupable',
      detail = jsonb_build_object('reason', 'rental', 'itemIds', v_bad)::text;
  end if;
  select count(distinct i.item_type), min(i.item_type) into v_ntypes, v_type
    from public.inventory_items i where i.id = any (v_ids);
  if v_ntypes <> 1 then
    raise exception 'mixed_item_types' using errcode = 'P0001', hint = 'mixed_item_types';
  end if;

  if not v_new then
    -- In this organization, open, with a live record the caller can read:
    -- every other case is the same answer.
    select g.* into v_target from public.item_display_groups g
     where g.id = v_target_id and g.organization_id = p_org;
    if not found or v_target.closed_at is not null
       or not exists (select 1 from public.item_display_group_members m
                        join public.inventory_items i on i.id = m.item_id
                       where m.group_id = v_target_id and i.deleted_at is null
                         and public.caller_can_read_item(i.id)) then
      raise exception 'group_not_found' using errcode = 'P0002', hint = 'group_not_found';
    end if;
    if v_target.item_type <> v_type then
      raise exception 'mixed_item_types' using errcode = 'P0001', hint = 'mixed_item_types';
    end if;
    if v_target.version <> (p_req #>> '{target,expected_version}')::integer then
      raise exception 'group_changed' using errcode = 'P0001', hint = 'group_changed';
    end if;
  end if;

  -- NO-OP: every record already in the target, or (a new group, no move
  -- asked) every record already in one same group. A repeat (a double tap, a
  -- second tab, a retry with a new key after a refresh) never makes a second
  -- group, and answers the group the records are in.
  if not v_new then
    if not exists (select 1 from unnest(v_ids) u(id) where (v_cur ->> u.id::text) is distinct from v_target_id::text) then
      v_noop_gid := v_target_id;
    end if;
  elsif cardinality(v_move) = 0 then
    select (min(v_cur ->> u.id::text))::uuid into v_noop_gid
      from unnest(v_ids) u(id)
    having count(*) filter (where jsonb_typeof(v_cur -> u.id::text) = 'string') = cardinality(v_ids)
       and count(distinct v_cur ->> u.id::text) = 1;
  end if;
  if v_noop_gid is not null then
    select jsonb_build_object('action', 'group', 'outcome', 'noop',
             'group', jsonb_build_object('id', g.id, 'name', g.name, 'version', g.version,
                                         'item_type', g.item_type, 'closed', false),
             'changes', '[]'::jsonb, 'closed_group_ids', '[]'::jsonb, 'created', false)
      into v_outcome
      from public.item_display_groups g where g.id = v_noop_gid;
    return v_outcome;
  end if;

  -- The screen saw another membership than there is now (checked after the
  -- no-op: a repeat whose end state already holds answers that state).
  select jsonb_agg(u.id order by u.id) into v_bad
    from unnest(v_ids) u(id)
   where (v_cur ->> u.id::text) is distinct from (v_expected ->> u.id::text);
  if v_bad is not null then
    raise exception 'membership_changed' using errcode = 'P0001', hint = 'membership_changed',
      detail = jsonb_build_object('itemIds', v_bad)::text;
  end if;

  -- The records that change: all of them for a new group; those not already
  -- in the target otherwise.
  v_change := array(select u.id from unnest(v_ids) u(id)
                     where v_new or (v_cur ->> u.id::text) is distinct from v_target_id::text
                     order by u.id);
  -- A record in another group moves only when the request says so, per record.
  select jsonb_agg(c.id order by c.id) into v_bad
    from unnest(v_change) c(id)
   where jsonb_typeof(v_cur -> c.id::text) = 'string' and not (c.id = any (v_move));
  if v_bad is not null then
    raise exception 'membership_conflict' using errcode = 'P0001', hint = 'membership_conflict',
      detail = jsonb_build_object('itemIds', v_bad)::text;
  end if;
  -- A product-family member joins only with the acknowledgement. Its family
  -- (group_id, variant_key) is never changed.
  if not v_ack then
    select jsonb_agg(i.id order by i.id) into v_bad
      from public.inventory_items i where i.id = any (v_change) and i.group_id is not null;
    if v_bad is not null then
      raise exception 'product_family_conflict' using errcode = 'P0001', hint = 'product_family_conflict',
        detail = jsonb_build_object('itemIds', v_bad)::text;
    end if;
  end if;
  -- One list unit is never cut across pages, so a group is bounded.
  if not v_new then
    select count(*) into v_live
      from public.item_display_group_members m
      join public.inventory_items i on i.id = m.item_id
     where m.group_id = v_target_id and i.deleted_at is null;
    if v_live + cardinality(v_change) > 200 then
      raise exception 'group_too_large' using errcode = 'P0001', hint = 'group_too_large';
    end if;
  end if;

  -- ── 11. Writes ───────────────────────────────────────────────────────────
  v_src := array(select distinct (v_cur ->> c.id::text)::uuid from unnest(v_change) c(id)
                  where jsonb_typeof(v_cur -> c.id::text) = 'string' order by 1);
  select coalesce(jsonb_object_agg(g.id::text, g.name), '{}'::jsonb) into v_names
    from public.item_display_groups g where g.id = any (v_src);
  if v_new then
    insert into public.item_display_groups (organization_id, item_type, name)
    values (p_org, v_type, p_req #>> '{target,name}')
    returning * into v_target;
    v_target_id := v_target.id;
  end if;

  insert into public.item_display_group_members (item_id, organization_id, group_id)
  select c.id, p_org, v_target_id from unnest(v_change) c(id)
  on conflict (item_id) do update
     set group_id = excluded.group_id, organization_id = excluded.organization_id, added_at = now();

  if not v_new then
    update public.item_display_groups g
       set version = g.version + 1, updated_at = now()
     where g.id = v_target_id
    returning g.* into v_target;
  end if;
  if cardinality(v_src) > 0 then
    update public.item_display_groups g
       set version = g.version + 1,
           updated_at = now(),
           closed_at = case when exists (select 1 from public.item_display_group_members m
                                           join public.inventory_items i on i.id = m.item_id
                                          where m.group_id = g.id and i.deleted_at is null)
                            then null else now() end
     where g.id = any (v_src);
    v_closed := array(select g.id from public.item_display_groups g
                       where g.id = any (v_src) and g.closed_at is not null order by g.id);
    delete from public.item_display_group_members m where m.group_id = any (v_closed);
  else
    v_closed := '{}';
  end if;

  -- ── 12. Audit ────────────────────────────────────────────────────────────
  if v_new then
    insert into public.audit_logs (organization_id, user_id, event, metadata)
    values (p_org, p_uid, 'inventory.group.created',
            jsonb_build_object(
              'entity_type',     'item_display_group',
              'entity_id',       v_target.id,
              'warehouse_id',    null,
              'before',          null,
              'after',           jsonb_build_object('name', v_target.name, 'item_type', v_target.item_type),
              'reason',          null,
              'member_item_ids', to_jsonb(v_change),
              'request_key',     p_key,
              'request_hash',    p_hash,
              'surface',         p_surface,
              'source',          'apply_item_grouping'));
  end if;
  insert into public.audit_logs (organization_id, user_id, event, metadata)
  select p_org, p_uid, 'inventory.group.members_added',
         jsonb_build_object(
           'entity_type',           'inventory_item',
           'entity_id',             i.id,
           'warehouse_id',          i.warehouse_id,
           'before',                jsonb_build_object('display_group_id', v_cur ->> i.id::text,
                                                       'display_group_name', v_names ->> (v_cur ->> i.id::text)),
           'after',                 jsonb_build_object('display_group_id', v_target.id,
                                                       'display_group_name', v_target.name),
           'reason',                null,
           'changed_keys',          jsonb_build_array('display_group'),
           'group_id',              v_target.id,
           'previous_group_id',     v_cur ->> i.id::text,
           'previous_group_closed', coalesce((v_cur ->> i.id::text)::uuid = any (v_closed), false),
           'request_key',           p_key,
           'request_hash',          p_hash,
           'surface',               p_surface,
           'source',                'apply_item_grouping')
    from public.inventory_items i
   where i.id = any (v_change)
   order by i.id;

  -- ── 13. The outcome ──────────────────────────────────────────────────────
  select coalesce(jsonb_agg(jsonb_build_object('item_id', c.id, 'from_group_id', v_cur -> c.id::text,
                                               'to_group_id', v_target.id) order by c.id), '[]'::jsonb)
    into v_changes from unnest(v_change) c(id);
  return jsonb_build_object('action', 'group', 'outcome', 'applied',
           'group', jsonb_build_object('id', v_target.id, 'name', v_target.name, 'version', v_target.version,
                                       'item_type', v_target.item_type, 'closed', false),
           'changes', v_changes, 'closed_group_ids', to_jsonb(v_closed), 'created', v_new);
end;
$$;

revoke all on function public._display_grouping_apply(uuid, uuid, jsonb, uuid, text, text) from public, anon, authenticated, service_role;

comment on function public._display_grouping_apply(uuid, uuid, jsonb, uuid, text, text) is
  'Group selected''s steps 8 to 12 (0400) for group, remove and rename: records (P0002 item_not_found, 42501 '
  'item_not_writable), the records FOR SHARE NOWAIT and the groups FOR UPDATE NOWAIT in id order (55P03 busy), '
  'item_changed under the lock, the membership rules, set-based writes to item_display_groups and '
  'item_display_group_members only, inventory.group.* audit rows. No API EXECUTE.';

-- ═══ 7. apply_item_grouping ═══════════════════════════════════════════════
create or replace function public.apply_item_grouping(p_request jsonb, p_key text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  c_uuid     constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_uid      uuid := auth.uid();
  v_org      uuid;
  v_key_text text := nullif(btrim(coalesce(p_key, '')), '');
  v_key      uuid;
  v_surface  text;
  v_req      jsonb;
  v_action   text;
  v_hash     text;
  v_prev     jsonb;
  v_outcome  jsonb;
begin
  -- ── 1. Identity ──────────────────────────────────────────────────────────
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
  end if;
  -- Compared as text, so a malformed actor is a mismatch, never a cast error.
  if lower(coalesce(p_request->>'actor_user_id', '')) is distinct from v_uid::text then
    raise exception 'actor_mismatch' using errcode = '42501', hint = 'actor_mismatch';
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

  -- ── 3. Shape ─────────────────────────────────────────────────────────────
  v_surface := case when jsonb_typeof(p_request->'surface') = 'string' then p_request->>'surface' end;
  if v_surface is null or v_surface not in ('web', 'app') then
    raise exception 'grouping_invalid' using errcode = '22023', hint = 'grouping_invalid', detail = 'surface';
  end if;
  v_req := public._display_grouping_request(p_request);
  v_action := v_req->>'action';

  -- ── 4. The request hash (jsonb's text form is canonical) ─────────────────
  v_hash := md5('item_grouping:' || v_action || ':v1|'
                || jsonb_build_object('uid', v_uid, 'org', v_org, 'request', v_req)::text);

  -- ── 5 and 6. The organization's grouping lock, then replay (0399) ────────
  v_prev := public._item_grouping_claim(v_org, v_uid, v_key, v_action, v_hash);
  if v_prev is not null then
    return v_prev;
  end if;

  -- ── 7. Permission (has_permission: the role floor is not enough, V5) ─────
  if not public.has_permission(v_org, 'items:update') then
    raise exception 'permission' using errcode = '42501', hint = 'permission';
  end if;

  -- ── 8 to 12 ──────────────────────────────────────────────────────────────
  v_outcome := public._display_grouping_apply(v_org, v_uid, v_req, v_key, v_hash, v_surface);

  -- ── 13. Record and answer ────────────────────────────────────────────────
  perform public._item_grouping_record(v_org, v_uid, v_key, v_action, v_hash, v_outcome);
  return v_outcome || jsonb_build_object('replay', false);
end;
$$;

revoke all on function public.apply_item_grouping(jsonb, text) from public, anon, authenticated, service_role;
grant execute on function public.apply_item_grouping(jsonb, text) to authenticated;

comment on function public.apply_item_grouping(jsonb, text) is
  'Group selected (0400, design section 3): group (a new or an existing display group), remove (records leave '
  'their group) and rename. SECURITY DEFINER, lock_timeout 5s, EXECUTE to authenticated only. Steps: 1 identity '
  '(42501 unauthenticated, actor_mismatch, not_member); 2 the key (22023 idempotency_key_required, '
  'idempotency_key_invalid); 3 shape (22023 grouping_invalid); 4 hash; 5 the organization''s grouping lock and 6 '
  'replay or P0001 idempotency_conflict (0399''s _item_grouping_claim); 7 has_permission items:update (42501 '
  'permission); 8 to 12 _display_grouping_apply; 13 record (0399''s _item_grouping_record) and answer {action, '
  'outcome, group, changes, closed_group_ids, created, replay}. Writes only item_display_groups, '
  'item_display_group_members, audit_logs and item_grouping_requests. Never waits on a row lock (55P03 busy) and '
  'never raises 40001/40P01.';

-- ═══ 8. item_grouping_preview ═════════════════════════════════════════════
create or replace function public.item_grouping_preview(p_request jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  c_uuid     constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_ids_j    jsonb := p_request->'item_ids';
  v_org      uuid;
  v_ids      uuid[];
  v_gid      uuid;
  v_records  jsonb;
  v_types    text[];
  v_skus     text[];
  v_found    integer;
  v_siblings jsonb;
  v_cands    jsonb;
  v_target   jsonb;
begin
  -- Everything below reads as the caller (RLS): a record, membership or
  -- group the caller cannot read is never returned or counted, except as the
  -- number of selected ids that were not readable (ids the caller sent).
  if (select auth.uid()) is null then
    raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
  end if;
  if coalesce(p_request->>'organization_id', '') !~ c_uuid then
    raise exception 'grouping_invalid' using errcode = '22023', hint = 'grouping_invalid', detail = 'organization_id';
  end if;
  v_org := (p_request->>'organization_id')::uuid;
  if v_ids_j is null or jsonb_typeof(v_ids_j) <> 'array'
     or jsonb_array_length(v_ids_j) < 1 or jsonb_array_length(v_ids_j) > 100
     or exists (select 1 from jsonb_array_elements(v_ids_j) e(v)
                 where case when jsonb_typeof(v) <> 'string' then true else (v #>> '{}') !~ c_uuid end) then
    raise exception 'grouping_invalid' using errcode = '22023', hint = 'grouping_invalid', detail = 'item_ids';
  end if;
  v_ids := array(select distinct lower(v #>> '{}')::uuid from jsonb_array_elements(v_ids_j) e(v));
  if jsonb_typeof(p_request->'group_id') = 'string' then
    if (p_request->>'group_id') !~ c_uuid then
      raise exception 'grouping_invalid' using errcode = '22023', hint = 'grouping_invalid', detail = 'group_id';
    end if;
    v_gid := (p_request->>'group_id')::uuid;
  elsif p_request ? 'group_id' and jsonb_typeof(p_request->'group_id') <> 'null' then
    raise exception 'grouping_invalid' using errcode = '22023', hint = 'grouping_invalid', detail = 'group_id';
  end if;

  -- The readable selected records, oldest first.
  select coalesce(jsonb_agg(jsonb_build_object(
           'id',                 i.id,
           'name',               i.name,
           'sku',                i.sku,
           'barcode',            i.barcode,
           'isbn_fields',        jsonb_build_object('isbn',   i.custom_fields->>'isbn',
                                                    'isbn13', i.custom_fields->>'isbn13',
                                                    'isbn10', i.custom_fields->>'isbn10'),
           'item_type',          i.item_type,
           'is_bundle',          coalesce(i.is_bundle, false),
           'is_rental',          coalesce(i.is_rental, false),
           'product_group_id',   i.group_id,
           'product_group_name', pg.name,
           'variant_size',       i.variant_size,
           'charter_id',         i.charter_id,
           'warehouse_id',       i.warehouse_id,
           'bin_location',       i.bin_location,
           -- The stored rack keys a book carries (book_rack and its kin):
           -- the review names a record's rack the way the lists do.
           'custom_fields',      i.custom_fields,
           'quantity_on_hand',   i.quantity_on_hand,
           'created_at',         i.created_at,
           'display_group',      case when dg.id is null then null
                                      else jsonb_build_object('id', dg.id, 'name', dg.name, 'version', dg.version) end,
           'writable',           public.caller_can_write_item(i.id))
           order by i.created_at, i.id), '[]'::jsonb),
         count(*),
         array_agg(distinct i.item_type),
         array_agg(distinct i.sku) filter (where btrim(coalesce(i.sku, '')) <> '')
    into v_records, v_found, v_types, v_skus
    from public.inventory_items i
    left join public.product_groups pg on pg.id = i.group_id
    left join public.item_display_group_members m on m.item_id = i.id
    left join public.item_display_groups dg on dg.id = m.group_id
   where i.id = any (v_ids) and i.organization_id = v_org and i.deleted_at is null;

  -- Readable live records that share a selected record's raw SKU and are
  -- not selected ("Add them to the selection"). At most 50.
  select coalesce(jsonb_agg(s.j order by s.created_at, s.id), '[]'::jsonb) into v_siblings
    from (select i.id, i.created_at,
                 jsonb_build_object('id', i.id, 'name', i.name, 'sku', i.sku, 'item_type', i.item_type,
                                    'display_group_id', m.group_id) as j
            from public.inventory_items i
            left join public.item_display_group_members m on m.item_id = i.id
           where i.organization_id = v_org and i.deleted_at is null
             and i.sku = any (coalesce(v_skus, '{}'))
             and not (i.id = any (v_ids))
           order by i.created_at, i.id
           limit 50) s;

  -- Candidate groups: readable open groups of the selected records' item
  -- type, those holding a selected record first, then the most recently
  -- changed. At most 20. Suggestions only: never chosen by a name match.
  select coalesce(jsonb_agg(c.j order by c.holds desc, c.updated_at desc, c.id), '[]'::jsonb) into v_cands
    from (select g.id, g.updated_at,
                 exists (select 1 from public.item_display_group_members m
                          where m.group_id = g.id and m.item_id = any (v_ids)) as holds,
                 jsonb_build_object(
                   'id', g.id, 'name', g.name, 'version', g.version, 'item_type', g.item_type,
                   'member_count', (select count(*) from public.item_display_group_members m
                                      join public.inventory_items i on i.id = m.item_id
                                     where m.group_id = g.id and i.deleted_at is null),
                   'holds_selected', exists (select 1 from public.item_display_group_members m
                                              where m.group_id = g.id and m.item_id = any (v_ids))) as j
            from public.item_display_groups g
           where g.organization_id = v_org and g.closed_at is null
             and g.item_type = any (coalesce(v_types, '{}'))
           order by 3 desc, g.updated_at desc, g.id
           limit 20) c;

  -- The target group, when one is named: its readable live members.
  if v_gid is not null then
    select jsonb_build_object(
             'id', g.id, 'name', g.name, 'version', g.version, 'item_type', g.item_type,
             'members', coalesce((select jsonb_agg(jsonb_build_object(
                                          'id', i.id, 'name', i.name, 'sku', i.sku,
                                          'quantity_on_hand', i.quantity_on_hand) order by i.created_at, i.id)
                                    from (select i.* from public.item_display_group_members m
                                            join public.inventory_items i on i.id = m.item_id
                                           where m.group_id = g.id and i.deleted_at is null
                                           order by i.created_at, i.id limit 200) i), '[]'::jsonb))
      into v_target
      from public.item_display_groups g
     where g.id = v_gid and g.organization_id = v_org and g.closed_at is null;
  end if;

  return jsonb_build_object(
           'records',           v_records,
           'unavailable_count', cardinality(v_ids) - coalesce(v_found, 0),
           'same_sku_siblings', v_siblings,
           'candidate_groups',  v_cands,
           'target_group',      v_target);
end;
$$;

revoke all on function public.item_grouping_preview(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.item_grouping_preview(jsonb) to authenticated;

comment on function public.item_grouping_preview(jsonb) is
  'Group selected''s review (0400, design 3.1): SECURITY INVOKER and STABLE, so every read is the caller''s own '
  '(RLS); it writes nothing, so Cancel writes nothing. Answers {records (readable selected records with their '
  'current group, product family and whether the caller can edit each), unavailable_count, same_sku_siblings (at '
  'most 50), candidate_groups (at most 20), target_group (its readable live members, at most 200)}. Never names '
  'item_stock_levels (INV-33): racks come from the app''s RLS-scoped holdings read. EXECUTE to authenticated only.';

-- Make the new tables and functions visible to PostgREST at once.
notify pgrst, 'reload schema';

reset lock_timeout;
