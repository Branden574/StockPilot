-- 0399_ungroup_shared_sku.sql
--
-- UNGROUP (slice G1 of the one grouping contract; owner bug 2026-10-05): give
-- a record that shares its SKU with other records a SKU of its own, changing
-- that record only. The number is a placeholder (returns RX-4 takes 0397 and
-- 0398 first); it is fixed at the PR stage to the next free number, and no
-- function body names it, so no fingerprint recorded here changes when the
-- file is renumbered.
--
-- Design: stockpilot-work/grouping-visibility-push/design-merged.md, sections
-- 2 (the idempotency table, caller_can_write_item, the fresh-SKU helper), 3.2
-- (apply steps and lock order) and 6 (split_sku). Owner decisions taken on
-- the recommended defaults: when every record of a SKU the caller can see is
-- selected, one of them keeps the SKU (the caller's choice, else the oldest
-- by created_at then id) and the others get fresh SKUs; the barcode/ISBN is
-- KEPT on a split record; kits are excluded.
--
-- ── WHY ────────────────────────────────────────────────────────────────────
-- InventoryService.update() fans every shared product field, the SKU among
-- them, out to every other live row with the same original SKU (Model B). So
-- editing one record's SKU, or pressing Auto, re-keys the whole group and a
-- group can never be split. Production 2026-10-05: the owner changed one of
-- two mouse-pad records three times and both moved each time.
--
-- ── WHAT IT ADDS ───────────────────────────────────────────────────────────
-- No existing row, function, policy, trigger, index or grant changes. No
-- column is added to inventory_items.
--   1. item_grouping_requests: one private record per (organization, user,
--      key) and the outcome it produced. RLS on, no policy, and no privilege
--      for anon, authenticated or service_role: only the functions below (as
--      their owner) read or write it. Its action check already admits the
--      actions slice G2 will add (group, remove, rename), so G2 only adds
--      rows. The organization and the person's account cascade (0393: a
--      person's own logs go with their account; a cascade never blocks a
--      deletion).
--   2. caller_can_write_item(item): the caller can read the item
--      (caller_can_read_item), it is live, the caller HOLDS items:update
--      (has_permission: inventory_items_update's role floor lets a staff
--      member whose items:update is revoked through, design V5), and can
--      write its warehouse (a manager, no warehouse, or write access).
--      EXECUTE to authenticated, like caller_can_read_item.
--   3. _item_grouping_new_sku(org, count): fresh SKUs in generateSku's shape
--      (SP-<last 5 of the millisecond clock in base 36>-<7 base-36
--      characters>), distinct from each other and from every live AND
--      deleted row of the organization (a deleted row can be restored), in
--      at most 5 rounds, else P0001 sku_generation_failed. No API EXECUTE.
--      (0004's generate_sku is not reused: its shape is a hex epoch and an
--      md5 tail, it ignores deleted rows' SKUs only by accident of not
--      filtering them, and after five collisions it returns a colliding
--      candidate instead of refusing.)
--   4. _item_grouping_claim / _item_grouping_record: the shared idempotency
--      steps (the organization's grouping lock, replay or conflict, record).
--      No API EXECUTE.
--   5. _item_grouping_split_request (shape) and _item_grouping_split_apply
--      (records, rules, lock, write, audit). No API EXECUTE.
--   6. split_item_sku(request, key): the entry point. SECURITY DEFINER,
--      EXECUTE to authenticated only.
--
-- ── WHY A DEDICATED ENTRY POINT (not apply_item_grouping) ──────────────────
-- G2 adds group, remove and rename. Had G1 shipped apply_item_grouping
-- restricted to split_sku, G2 would have to replace its body to add the other
-- branches, restating the split, moving its fingerprint and re-proving it.
-- Here the split lives in its own entry point and its own private steps, and
-- the steps every action shares (claim, record, the table) are separate
-- functions. G2 adds its own entry point (or an apply_item_grouping that
-- calls _item_grouping_split_request and _item_grouping_split_apply for
-- split_sku) and reuses the claim and the record without changing one G1
-- body: a purely additive migration. One table holds every action's keys, so
-- a key spent on a split can never be replayed as a group (the hash covers
-- the action).
--
-- ── split_item_sku(p_request jsonb, p_key text) ────────────────────────────
-- p_request (snake_case, built by core toSplitSkuRpcRequest): action
-- 'split_sku', organization_id, actor_user_id, surface ('web' | 'app'),
-- item_ids (1 to 100 distinct uuids), expected_skus ({item id: the SKU the
-- caller saw}, exactly the item ids), anchor_item_ids (optional: selected
-- records that keep their SKU; at most one per SKU).
-- Steps, in this order (design 3.2):
--   1. Identity: signed in (42501 unauthenticated); actor_user_id is the
--      caller (42501 actor_mismatch: a retry another account left on a shared
--      device never applies under this one); a member (42501 not_member).
--   2. Key: present and uuid-shaped (22023 idempotency_key_required,
--      idempotency_key_invalid).
--   3. Shape (pure): 22023 grouping_invalid, the field as detail.
--   4. The request hash: md5 of a scope tag and the canonical jsonb text.
--   5. The organization's grouping lock: pg_advisory_xact_lock on
--      'item_grouping:<org>'. It serializes every grouping write in one
--      organization. Past lock_timeout (5 s): 55P03.
--   6. Replay: the caller's row for the key. The same hash answers the stored
--      outcome (replay true, nothing written); another hash or action is
--      P0001 idempotency_conflict. BEFORE anything that changes with time, so
--      a retry after a lost answer replays instead of meeting item_changed.
--   7. Permission: has_permission(items:update), else 42501 permission.
--   8. Records: a missing, deleted, other-organization or unreadable id is
--      P0002 item_not_found (the same answer for each; the detail lists only
--      ids the caller sent); one the caller cannot write is 42501
--      item_not_writable.
--   9. Lock the selected rows in ONE id-ordered SELECT ... FOR UPDATE NOWAIT.
--      A row someone else holds is 55P03 busy at once: the function never
--      waits on an inventory_items row lock, so it cannot sit in a deadlock
--      cycle with update()'s separate fan-out statement (design 3.2, critique
--      D2). Then, under the lock: a SKU that is not the one the caller saw (or
--      a record deleted since) is P0001 item_changed; a kit is P0001
--      not_groupable (detail reason kit); a product-family member (group_id
--      set) is P0001 family_member_sku.
--  10. Visible siblings decide (caller_can_read_item over the live rows of
--      each selected SKU, one statement): a SKU no other readable live record
--      carries is P0001 not_shared. When every readable record of a SKU is
--      selected, the anchor (the caller's choice, else the oldest by
--      created_at then id) keeps the SKU and the others get fresh SKUs;
--      otherwise every selected record of it gets a fresh SKU. An anchor
--      named for a SKU that still has unselected readable records is P0001
--      sku_siblings_changed (the screen was out of date; never silently
--      ignored). Hidden records never change an answer: a member who cannot
--      see a sibling cannot split from it; a manager can (design R6).
--  11. Write: one UPDATE of sku and updated_by on the changing rows only. No
--      fan-out, no stock call, no barcode, name, cost or category change;
--      explicit membership (G2) is untouched. The fresh SKU is unused in the
--      organization, so 0234 (organization, sku, charter, bin) cannot be
--      violated. The row triggers do what they do on any SKU edit
--      (updated_at, the search vector); the API guard exempts the owner.
--  12. Audit: one inventory.item.ungrouped row per changed record, in the
--      same transaction: before/after SKU, left_sku, anchor_item_id (the
--      record that kept the SKU, or null), barcode_kept, changed_keys, the
--      request key and hash, the surface. No ip or user agent (SQL-written
--      audit rows have none, the 0345 precedent; design R9).
--  13. Record the outcome under the key and answer it:
--      {action: 'split_sku', items: [{id, before_sku, after_sku, kept,
--      anchor_item_id}] in id order, replay}.
--
-- ── LOCK ORDER ─────────────────────────────────────────────────────────────
-- The organization's grouping advisory lock, then the selected item rows (one
-- NOWAIT statement, id order). The audit and request inserts take only key
-- share locks on organizations and user_profiles through their foreign keys.
-- Nothing here waits on an item row, so there is no cycle with update(), the
-- stock functions or another split (which waits on the advisory lock first).
--
-- ── ERRORS ─────────────────────────────────────────────────────────────────
--   42501 unauthenticated, actor_mismatch, not_member, permission,
--         item_not_writable
--   22023 grouping_invalid (detail: the field), idempotency_key_required,
--         idempotency_key_invalid
--   P0002 item_not_found
--   P0001 idempotency_conflict, item_changed, not_shared, family_member_sku,
--         not_groupable, sku_siblings_changed, sku_generation_failed
--   55P03 busy (a held row), or the lock_timeout of the advisory lock
-- Item-level refusals carry detail {"itemIds": [...]} (not_groupable adds
-- "reason"). No function here raises the two classes PostgREST would re-run
-- forever (0367). The app maps by hint (core grouping-contract.ts).
--
-- ── LOCK FOOTPRINT OF THIS FILE ────────────────────────────────────────────
-- The table's two foreign keys add RI triggers to organizations and
-- user_profiles (SHARE ROW EXCLUSIVE on both, to commit); creating the
-- SQL-language caller_can_write_item reads inventory_items (ACCESS SHARE).
-- No policy is created, so supautils takes no lock on auth tables. One NOWAIT
-- prelude (0390's pattern) takes all three at once in a bounded retry; no
-- later statement locks an existing table, so the file never waits while
-- holding a lock.

set lock_timeout = '5s';

-- ═══ 0. Preflight ══════════════════════════════════════════════════════════
-- The predicates the split relies on must be the bodies this file was written
-- against (production head 0396, read 2026-10-11), the guard must still exempt
-- the owner, 0234 must be the index the fresh SKU is unique for, and every new
-- name must be free. Anything else is drift: stop before changing anything.
do $preflight$
declare
  v_bad text := '';
  r record;
begin
  for r in
    select v.sig, v.want_src, v.want_secdef, p.oid as poid, md5(p.prosrc) as got_src, p.prosecdef as got_secdef,
           pg_get_userbyid(p.proowner) as got_owner
      from (values
        ('public.caller_can_read_item(uuid)',                      '80523d2cc0fafe7fc6b3599903d7f014', true),
        ('public.has_permission(uuid,text)',                       'cc0accdad7e2fdf4f88aa82aa887e85f', true),
        ('public.has_org_role(uuid,text)',                         '10422b29a6e15acd003d4f11ed28e90c', true),
        ('public.is_org_member(uuid)',                             '76492a6556e9f6a7c33d942aa9726f9f', true),
        ('public.user_can_access_warehouse(uuid,uuid,text)',       '76b4170f3d393e8a1f293ca3d4895955', true),
        ('public.tg_inventory_items_guard()',                      '0b41f8f3e41197d79b0af640e4dacf04', false)
      ) v(sig, want_src, want_secdef)
      left join pg_proc p on p.oid = to_regprocedure(v.sig)
  loop
    if r.poid is null then
      v_bad := v_bad || format(' %s missing;', r.sig);
    elsif r.got_src <> r.want_src or r.got_secdef <> r.want_secdef or r.got_owner <> 'postgres' then
      v_bad := v_bad || format(' %s drifted (md5 %s, definer %s, owner %s);', r.sig, r.got_src, r.got_secdef, r.got_owner);
    end if;
  end loop;

  if to_regclass('public.inventory_items_org_sku_charter_bin_unique') is null
     or pg_get_indexdef('public.inventory_items_org_sku_charter_bin_unique'::regclass)
        is distinct from 'CREATE UNIQUE INDEX inventory_items_org_sku_charter_bin_unique ON public.inventory_items '
                         'USING btree (organization_id, sku, charter_id, bin_location) NULLS NOT DISTINCT '
                         'WHERE (deleted_at IS NULL)' then
    v_bad := v_bad || ' the 0234 index drifted;';
  end if;

  if to_regclass('public.item_grouping_requests') is not null
     or to_regprocedure('public.caller_can_write_item(uuid)') is not null
     or to_regprocedure('public.split_item_sku(jsonb,text)') is not null
     or exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
                   and p.proname like '\_item\_grouping\_%') then
    v_bad := v_bad || ' the ungroup objects already exist;';
  end if;

  if v_bad <> '' then
    raise exception 'ungroup_preflight: %', v_bad
      using errcode = '55000', hint = 'ungroup_preflight';
  end if;
end
$preflight$;

-- ═══ 1. The lock prelude (see LOCK FOOTPRINT) ═════════════════════════════
-- Inside DO because the CLI batch is not a transaction block (a top-level
-- LOCK TABLE refuses there, as 0373 found); the locks last until the batch
-- commits.
do $lock$
declare
  v_try integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.organizations, public.user_profiles in share row exclusive mode nowait;
      lock table only public.inventory_items in access share mode nowait;
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

-- ═══ 2. item_grouping_requests ════════════════════════════════════════════
create table public.item_grouping_requests (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references public.user_profiles(id) on delete cascade,
  key             uuid not null,
  action          text not null check (action in ('group', 'remove', 'rename', 'split_sku')),
  request_hash    text not null check (request_hash ~ '^[0-9a-f]{32}$'),
  outcome         jsonb not null check (jsonb_typeof(outcome) = 'object'),
  created_at      timestamptz not null default now(),
  primary key (organization_id, user_id, key)
);

alter table public.item_grouping_requests enable row level security;
-- Supabase's default privileges grant every new public table to anon,
-- authenticated and service_role: take them all back. Only the functions
-- below, as the table's owner, read or write it.
revoke all on table public.item_grouping_requests from public, anon, authenticated, service_role;

comment on table public.item_grouping_requests is
  'One private record per grouping request key (0399, the 0391 pattern): (organization, user, key) -> the '
  'action, the request hash and the outcome it produced, written in the transaction that applied it. RLS on, '
  'no policy and no API privilege: only split_item_sku''s steps (and G2''s grouping functions) read or write '
  'it, as its owner. The action check admits every grouping action (group, remove, rename, split_sku) so a '
  'later slice only adds rows. The organization and the person''s account cascade (0393).';
comment on column public.item_grouping_requests.request_hash is
  'md5 of ''item_grouping:<action>:v1|'' and the canonical jsonb text of the request (0399).';
comment on column public.item_grouping_requests.outcome is
  'The answer the request produced, replayed as is (with replay true) for the same key and hash (0399).';

-- ═══ 3. caller_can_write_item ═════════════════════════════════════════════
create or replace function public.caller_can_write_item(p_item_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- Readable (inventory_items_select, through caller_can_read_item), live,
  -- the items:update PERMISSION (not inventory_items_update's role floor,
  -- which lets a staff member whose override denies it through) and the
  -- policy's warehouse rule.
  select (select auth.uid()) is not null
     and public.caller_can_read_item(p_item_id)
     and exists (
       select 1
         from public.inventory_items it
        where it.id = p_item_id
          and it.deleted_at is null
          and public.has_permission(it.organization_id, 'items:update')
          and (public.has_org_role(it.organization_id, 'manager')
               or it.warehouse_id is null
               or public.user_can_access_warehouse(auth.uid(), it.warehouse_id, 'write'))
     );
$$;

revoke all on function public.caller_can_write_item(uuid) from public, anon, authenticated, service_role;
grant execute on function public.caller_can_write_item(uuid) to authenticated;

comment on function public.caller_can_write_item(uuid) is
  'True when the caller may change this item''s identity (0399): caller_can_read_item, the item is live, the '
  'caller holds items:update (has_permission; inventory_items_update''s staff-role floor would let a denied '
  'override through), and a manager, no warehouse, or write access to its warehouse. For SECURITY DEFINER '
  'grouping paths. Answers only for auth.uid().';

-- ═══ 4. _item_grouping_new_sku ════════════════════════════════════════════
create or replace function public._item_grouping_new_sku(p_org uuid, p_count integer)
returns text[]
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  c_alpha constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  v_out   text[] := '{}';
  v_cand  text[];
  v_keep  text[];
  v_need  integer;
  v_round integer := 0;
  v_ms    bigint;
  v_stamp text;
  v_tail  text;
  v_bytes bytea;
  v_b     integer;
begin
  if p_org is null or p_count is null or p_count < 1 or p_count > 100 then
    raise exception 'grouping_invalid' using errcode = '22023', hint = 'grouping_invalid', detail = 'count';
  end if;
  loop
    v_need := p_count - cardinality(v_out);
    exit when v_need = 0;
    v_round := v_round + 1;
    if v_round > 5 then
      raise exception 'sku_generation_failed' using errcode = 'P0001', hint = 'sku_generation_failed';
    end if;
    -- generateSku's stamp: the millisecond clock in base 36, its last five
    -- characters, upper case.
    v_ms := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
    v_stamp := '';
    while v_ms > 0 loop
      v_stamp := substr(c_alpha, (v_ms % 36)::integer + 1, 1) || v_stamp;
      v_ms := v_ms / 36;
    end loop;
    v_stamp := right(v_stamp, 5);
    v_cand := '{}';
    for i in 1 .. v_need loop
      -- Seven base-36 characters from a v4 uuid's random bytes (not bytes 6
      -- and 8, which carry the version and variant bits).
      v_bytes := uuid_send(gen_random_uuid());
      v_tail := '';
      foreach v_b in array array[0, 1, 2, 3, 4, 5, 7] loop
        v_tail := v_tail || substr(c_alpha, get_byte(v_bytes, v_b) % 36 + 1, 1);
      end loop;
      v_cand := array_append(v_cand, 'SP-' || v_stamp || '-' || v_tail);
    end loop;
    -- Keep a candidate only when it is new among the candidates, not already
    -- taken this call, and on no row of the organization, live or deleted.
    -- One statement for the batch (sku indexes are all partial on live rows).
    select coalesce(array_agg(d.c order by d.ord), '{}')
      into v_keep
      from (select distinct on (u.c) u.c, u.ord
              from unnest(v_cand) with ordinality as u(c, ord)
             order by u.c, u.ord) d
     where not (d.c = any (v_out))
       and d.c not in (select i.sku
                         from public.inventory_items i
                        where i.organization_id = p_org
                          and i.sku = any (v_cand));
    v_out := v_out || v_keep[1:v_need];
  end loop;
  return v_out;
end;
$$;

revoke all on function public._item_grouping_new_sku(uuid, integer) from public, anon, authenticated, service_role;

comment on function public._item_grouping_new_sku(uuid, integer) is
  'p_count (1 to 100) fresh SKUs in generateSku''s shape SP-XXXXX-XXXXXXX (0399): the millisecond stamp''s last '
  'five base-36 characters and seven random base-36 characters; distinct from each other and from every live '
  'AND deleted row of the organization; at most 5 rounds, then P0001 sku_generation_failed. No API EXECUTE: '
  'split_item_sku''s steps call it as their owner.';

-- ═══ 5. The shared idempotency steps ══════════════════════════════════════
create or replace function public._item_grouping_claim(p_org uuid, p_uid uuid, p_key uuid, p_action text, p_hash text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_prev public.item_grouping_requests%rowtype;
begin
  -- Every grouping write in one organization, one at a time (design 3.2 step
  -- 5). Held to commit; past lock_timeout, 55P03.
  perform pg_advisory_xact_lock(hashtextextended('item_grouping:' || p_org::text, 0));
  -- A new statement: it sees what an earlier holder committed.
  select r.* into v_prev
    from public.item_grouping_requests r
   where r.organization_id = p_org and r.user_id = p_uid and r.key = p_key;
  if not found then
    return null;
  end if;
  if v_prev.action is distinct from p_action or v_prev.request_hash is distinct from p_hash then
    raise exception 'idempotency_conflict' using errcode = 'P0001', hint = 'idempotency_conflict';
  end if;
  return v_prev.outcome || jsonb_build_object('replay', true);
end;
$$;

revoke all on function public._item_grouping_claim(uuid, uuid, uuid, text, text) from public, anon, authenticated, service_role;

comment on function public._item_grouping_claim(uuid, uuid, uuid, text, text) is
  'The shared grouping claim (0399): takes the organization''s grouping advisory lock, then answers the stored '
  'outcome with replay true for the caller''s key and the same action and hash, null when the key is new, or '
  'raises P0001 idempotency_conflict for another action or hash. No API EXECUTE.';

create or replace function public._item_grouping_record(p_org uuid, p_uid uuid, p_key uuid, p_action text, p_hash text, p_outcome jsonb)
returns void
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
begin
  insert into public.item_grouping_requests (organization_id, user_id, key, action, request_hash, outcome)
  values (p_org, p_uid, p_key, p_action, p_hash, p_outcome);
end;
$$;

revoke all on function public._item_grouping_record(uuid, uuid, uuid, text, text, jsonb) from public, anon, authenticated, service_role;

comment on function public._item_grouping_record(uuid, uuid, uuid, text, text, jsonb) is
  'Records a grouping request''s outcome under its key (0399), in the transaction that applied it, after '
  '_item_grouping_claim found no row under the organization''s grouping lock. No API EXECUTE.';

-- ═══ 6. The split's shape ═════════════════════════════════════════════════
create or replace function public._item_grouping_split_request(p_request jsonb)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = public, pg_temp
as $$
declare
  c_uuid     constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_ids      jsonb := p_request->'item_ids';
  v_exp      jsonb := p_request->'expected_skus';
  v_anc      jsonb := p_request->'anchor_item_ids';
  v_id_list  text[];
  v_anc_list text[];
  v_expected jsonb;
begin
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

  -- expected_skus: exactly one non-blank string (at most 255 characters) per
  -- item id, keyed by the id.
  if v_exp is null or jsonb_typeof(v_exp) <> 'object'
     or exists (select 1 from jsonb_each(v_exp) e(k, v)
                 where case when jsonb_typeof(v) <> 'string' then true
                            else (v #>> '{}') ~ '^\s*$' or length(v #>> '{}') > 255
                                 or k !~ c_uuid end) then
    raise exception 'grouping_invalid' using errcode = '22023', hint = 'grouping_invalid', detail = 'expected_skus';
  end if;
  select jsonb_object_agg(lower(e.k), e.v) into v_expected from jsonb_each(v_exp) e(k, v);
  if (select count(*) from jsonb_object_keys(v_exp)) <> cardinality(v_id_list)
     or (select count(*) from jsonb_object_keys(v_expected)) <> cardinality(v_id_list)
     or exists (select 1 from unnest(v_id_list) x where not (v_expected ? x)) then
    raise exception 'grouping_invalid' using errcode = '22023', hint = 'grouping_invalid', detail = 'expected_skus';
  end if;

  -- anchor_item_ids: absent or null is none; otherwise distinct selected ids,
  -- at most one per SKU the caller saw.
  if v_anc is null or jsonb_typeof(v_anc) = 'null' then
    v_anc_list := '{}';
  else
    if jsonb_typeof(v_anc) <> 'array' or jsonb_array_length(v_anc) > 100
       or exists (select 1 from jsonb_array_elements(v_anc) e(v)
                   where case when jsonb_typeof(v) <> 'string' then true else (v #>> '{}') !~ c_uuid end) then
      raise exception 'grouping_invalid' using errcode = '22023', hint = 'grouping_invalid', detail = 'anchor_item_ids';
    end if;
    select coalesce(array_agg(lower(v #>> '{}') order by lower(v #>> '{}')), '{}') into v_anc_list
      from jsonb_array_elements(v_anc) e(v);
    if (select count(distinct x) from unnest(v_anc_list) x) <> cardinality(v_anc_list)
       or exists (select 1 from unnest(v_anc_list) x where not (x = any (v_id_list)))
       or (select count(distinct v_expected ->> x) from unnest(v_anc_list) x) <> cardinality(v_anc_list) then
      raise exception 'grouping_invalid' using errcode = '22023', hint = 'grouping_invalid', detail = 'anchor_item_ids';
    end if;
  end if;

  return jsonb_build_object('item_ids', to_jsonb(v_id_list),
                            'expected_skus', v_expected,
                            'anchor_item_ids', to_jsonb(v_anc_list));
end;
$$;

revoke all on function public._item_grouping_split_request(jsonb) from public, anon, authenticated, service_role;

comment on function public._item_grouping_split_request(jsonb) is
  'The split request''s shape (0399), pure: item_ids 1 to 100 distinct uuids; expected_skus exactly one '
  'non-blank SKU (at most 255 characters) per item id; anchor_item_ids optional, distinct, selected, at most '
  'one per expected SKU. Answers the canonical form (ids lower case and sorted) or raises 22023 '
  'grouping_invalid with the field as detail. No API EXECUTE.';

-- ═══ 7. The split's records, rules, lock, write and audit ══════════════════
create or replace function public._item_grouping_split_apply(
  p_org uuid, p_uid uuid, p_split jsonb, p_key uuid, p_hash text, p_surface text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_ids      uuid[] := array(select (jsonb_array_elements_text(p_split->'item_ids'))::uuid);
  v_expected jsonb  := p_split->'expected_skus';
  v_anchors  uuid[] := array(select (jsonb_array_elements_text(p_split->'anchor_item_ids'))::uuid);
  v_bad      jsonb;
  v_plan     jsonb;
  v_keep     jsonb;
  v_keep_ids uuid[];
  v_change   uuid[];
  v_new      text[];
  v_rows     integer;
  v_outcome  jsonb;
begin
  -- ── 8. Records ───────────────────────────────────────────────────────────
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

  -- ── 9. Lock, in ONE id-ordered statement; never wait on a row ────────────
  begin
    perform 1 from public.inventory_items i where i.id = any (v_ids) order by i.id for update nowait;
  exception when lock_not_available then
    raise exception 'busy' using errcode = '55P03', hint = 'busy';
  end;

  -- Under the lock (a new statement: it sees what committed before it).
  select jsonb_agg(i.id order by i.id) into v_bad
    from public.inventory_items i
   where i.id = any (v_ids)
     and (i.deleted_at is not null or i.sku is distinct from (v_expected ->> i.id::text));
  if v_bad is not null then
    raise exception 'item_changed' using errcode = 'P0001', hint = 'item_changed',
      detail = jsonb_build_object('itemIds', v_bad)::text;
  end if;
  select jsonb_agg(i.id order by i.id) into v_bad
    from public.inventory_items i
   where i.id = any (v_ids) and coalesce(i.is_bundle, false);
  if v_bad is not null then
    raise exception 'not_groupable' using errcode = 'P0001', hint = 'not_groupable',
      detail = jsonb_build_object('reason', 'kit', 'itemIds', v_bad)::text;
  end if;
  select jsonb_agg(i.id order by i.id) into v_bad
    from public.inventory_items i
   where i.id = any (v_ids) and i.group_id is not null;
  if v_bad is not null then
    raise exception 'family_member_sku' using errcode = 'P0001', hint = 'family_member_sku',
      detail = jsonb_build_object('itemIds', v_bad)::text;
  end if;

  -- ── 10. Visible siblings decide (one statement) ──────────────────────────
  -- For each selected record: how many live records of its SKU the caller can
  -- read, how many of those are selected, and the oldest of them.
  with sel as (
    select i.id, i.sku from public.inventory_items i where i.id = any (v_ids)
  ), vis as (
    select i.id, i.sku, i.created_at
      from public.inventory_items i
     where i.organization_id = p_org
       and i.deleted_at is null
       and i.sku in (select s.sku from sel s)
       and public.caller_can_read_item(i.id)
  ), per_sku as (
    select v.sku,
           count(*) as n_vis,
           count(*) filter (where v.id = any (v_ids)) as n_sel,
           (array_agg(v.id order by v.created_at, v.id))[1] as oldest
      from vis v
     group by v.sku
  )
  select jsonb_agg(jsonb_build_object('id', s.id, 'sku', s.sku,
                                      'n_vis', coalesce(p.n_vis, 0), 'n_sel', coalesce(p.n_sel, 0),
                                      'oldest', p.oldest) order by s.id)
    into v_plan
    from sel s left join per_sku p on p.sku = s.sku;

  select jsonb_agg((e->>'id')::uuid order by (e->>'id')) into v_bad
    from jsonb_array_elements(v_plan) e
   where (e->>'n_vis')::integer < 2 or btrim(e->>'sku') = '';
  if v_bad is not null then
    raise exception 'not_shared' using errcode = 'P0001', hint = 'not_shared',
      detail = jsonb_build_object('itemIds', v_bad)::text;
  end if;
  select jsonb_agg((e->>'id')::uuid order by (e->>'id')) into v_bad
    from jsonb_array_elements(v_plan) e
   where (e->>'id')::uuid = any (v_anchors) and (e->>'n_vis')::integer <> (e->>'n_sel')::integer;
  if v_bad is not null then
    raise exception 'sku_siblings_changed' using errcode = 'P0001', hint = 'sku_siblings_changed',
      detail = jsonb_build_object('itemIds', v_bad)::text;
  end if;

  -- Each SKU whose every readable record is selected keeps it on one record:
  -- the caller's anchor, else the oldest.
  select coalesce(jsonb_object_agg(k.sku, k.keep_id), '{}'::jsonb)
    into v_keep
    from (select e->>'sku' as sku,
                 coalesce((array_agg((e->>'id')::uuid) filter (where (e->>'id')::uuid = any (v_anchors)))[1],
                          min(e->>'oldest')::uuid) as keep_id
            from jsonb_array_elements(v_plan) e
           where (e->>'n_vis')::integer = (e->>'n_sel')::integer
           group by e->>'sku') k;
  v_keep_ids := array(select (v #>> '{}')::uuid from jsonb_each(v_keep) e(k, v));
  v_change := array(select u.id from unnest(v_ids) u(id) where not (u.id = any (v_keep_ids)) order by u.id);
  if cardinality(v_change) < 1 then
    raise exception 'split_item_sku_internal: nothing to change' using errcode = 'P0001', hint = 'split_item_sku_internal';
  end if;

  -- ── 11. Write: sku and updated_by, the changing rows only ────────────────
  v_new := public._item_grouping_new_sku(p_org, cardinality(v_change));
  update public.inventory_items i
     set sku = m.new_sku,
         updated_by = p_uid
    from unnest(v_change, v_new) as m(id, new_sku)
   where i.id = m.id;
  get diagnostics v_rows = row_count;
  if v_rows <> cardinality(v_change) then
    raise exception 'split_item_sku_internal: % of % rows written', v_rows, cardinality(v_change)
      using errcode = 'P0001', hint = 'split_item_sku_internal';
  end if;

  -- ── 12. Audit, one row per changed record, same transaction ──────────────
  insert into public.audit_logs (organization_id, user_id, event, metadata)
  select p_org, p_uid, 'inventory.item.ungrouped',
         jsonb_build_object(
           'entity_type',    'inventory_item',
           'entity_id',      i.id,
           'warehouse_id',   i.warehouse_id,
           'before',         jsonb_build_object('sku', v_expected ->> i.id::text),
           'after',          jsonb_build_object('sku', i.sku),
           'reason',         null,
           'changed_keys',   jsonb_build_array('sku'),
           'left_sku',       v_expected ->> i.id::text,
           'anchor_item_id', v_keep -> (v_expected ->> i.id::text),
           'barcode_kept',   btrim(coalesce(i.barcode, '')) <> '',
           'request_key',    p_key,
           'request_hash',   p_hash,
           'surface',        p_surface,
           'source',         'split_item_sku')
    from public.inventory_items i
   where i.id = any (v_change)
   order by i.id;

  -- ── 13. The outcome ──────────────────────────────────────────────────────
  select jsonb_build_object(
           'action', 'split_sku',
           'items', jsonb_agg(jsonb_build_object(
                      'id',             i.id,
                      'before_sku',     v_expected ->> i.id::text,
                      'after_sku',      i.sku,
                      'kept',           i.id = any (v_keep_ids),
                      'anchor_item_id', v_keep -> (v_expected ->> i.id::text))
                    order by i.id))
    into v_outcome
    from public.inventory_items i
   where i.id = any (v_ids);
  return v_outcome;
end;
$$;

revoke all on function public._item_grouping_split_apply(uuid, uuid, jsonb, uuid, text, text) from public, anon, authenticated, service_role;

comment on function public._item_grouping_split_apply(uuid, uuid, jsonb, uuid, text, text) is
  'The split''s steps 8 to 12 (0399): records (P0002 item_not_found, 42501 item_not_writable), the selected '
  'rows locked in one id-ordered FOR UPDATE NOWAIT (55P03 busy), item_changed, not_groupable (kit), '
  'family_member_sku, then visible siblings decide (caller_can_read_item): not_shared, sku_siblings_changed, '
  'the anchor (the caller''s, else the oldest) keeps a fully selected SKU; one UPDATE of sku and updated_by on '
  'the changing rows; one inventory.item.ungrouped audit row per changed record. Answers {action, items}. No '
  'API EXECUTE.';

-- ═══ 8. split_item_sku ════════════════════════════════════════════════════
create or replace function public.split_item_sku(p_request jsonb, p_key text)
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
  v_split    jsonb;
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
  if jsonb_typeof(p_request->'action') is distinct from 'string' or p_request->>'action' <> 'split_sku' then
    raise exception 'grouping_invalid' using errcode = '22023', hint = 'grouping_invalid', detail = 'action';
  end if;
  v_surface := case when jsonb_typeof(p_request->'surface') = 'string' then p_request->>'surface' end;
  if v_surface is null or v_surface not in ('web', 'app') then
    raise exception 'grouping_invalid' using errcode = '22023', hint = 'grouping_invalid', detail = 'surface';
  end if;
  v_split := public._item_grouping_split_request(p_request);

  -- ── 4. The request hash (jsonb's text form is canonical) ─────────────────
  v_hash := md5('item_grouping:split_sku:v1|'
                || jsonb_build_object('uid', v_uid, 'org', v_org, 'split', v_split)::text);

  -- ── 5 and 6. The organization's grouping lock, then replay ───────────────
  v_prev := public._item_grouping_claim(v_org, v_uid, v_key, 'split_sku', v_hash);
  if v_prev is not null then
    return v_prev;
  end if;

  -- ── 7. Permission (has_permission: the role floor is not enough, V5) ─────
  if not public.has_permission(v_org, 'items:update') then
    raise exception 'permission' using errcode = '42501', hint = 'permission';
  end if;

  -- ── 8 to 12 ──────────────────────────────────────────────────────────────
  v_outcome := public._item_grouping_split_apply(v_org, v_uid, v_split, v_key, v_hash, v_surface);

  -- ── 13. Record and answer ────────────────────────────────────────────────
  perform public._item_grouping_record(v_org, v_uid, v_key, 'split_sku', v_hash, v_outcome);
  return v_outcome || jsonb_build_object('replay', false);
end;
$$;

revoke all on function public.split_item_sku(jsonb, text) from public, anon, authenticated, service_role;
grant execute on function public.split_item_sku(jsonb, text) to authenticated;

comment on function public.split_item_sku(jsonb, text) is
  'Ungroup (0399, design section 6): give each selected record that shares its SKU a fresh SKU of its own, '
  'changing that record only. SECURITY DEFINER, lock_timeout 5s, EXECUTE to authenticated only. Steps: 1 '
  'identity (42501 unauthenticated, actor_mismatch, not_member); 2 the key (22023 idempotency_key_required, '
  'idempotency_key_invalid); 3 shape (22023 grouping_invalid); 4 hash; 5 the organization''s grouping lock; 6 '
  'replay (the stored outcome) or P0001 idempotency_conflict; 7 has_permission items:update (42501 '
  'permission); 8 to 12 _item_grouping_split_apply; 13 record and answer {action, items, replay}. Never waits '
  'on an item row lock (55P03 busy) and never raises 40001/40P01.';

reset lock_timeout;
