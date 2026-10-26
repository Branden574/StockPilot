-- 0413_order_catalog_visibility.sql
--
-- ORDERING VISIBILITY (owner brief 2026-10-26): people who may manage it
-- choose exactly which items and books appear in Place an Order and which are
-- hidden from NEW ordering, per record. Managers, admins and owners hold the
-- capability by default; only StockPilot support (the platform console, as
-- the service role) may allow it to, deny it to, or reset it for one member.
-- Design: stockpilot-work/order-visibility-2026-10-26/DESIGN.md, sections 2,
-- 3.3-3.5, 6.2-6.6 (database halves).
--
-- Hiding never deletes, archives, re-charters, moves or recounts anything,
-- never touches public_visibility, and never changes an order already placed.
-- Showing again restores only what each channel's own rules already admit.
--
-- ── WHAT IT ADDS ───────────────────────────────────────────────────────────
--   1. inventory_items.order_catalog_visible boolean NOT NULL DEFAULT true and
--      inventory_items.order_catalog_visibility_changed_at timestamptz (null
--      until first changed), plus a partial index of the hidden rows.
--      organizations.order_catalog_last_hide_at timestamptz (null until the
--      first hide), carried by get_request_context().
--   2. tg_inventory_items_order_visibility_guard: an UPDATE that changes
--      either column is refused (42501 order_visibility_managed) unless it
--      runs as postgres or supabase_admin, i.e. inside the one SECURITY
--      DEFINER writer below (or operator SQL). service_role is NOT exempt.
--      An INSERT may carry any value; the stamp is set by the trigger.
--   3. orders:manage_catalog_visibility: seeded for admin and manager (the
--      owner holds every key); _platform_managed_permissions() lists the keys
--      only StockPilot support may grant per user; can_manage_order_catalog
--      (org) applies explicit deny, explicit allow, then the role default for
--      every role, the owner included, for that key.
--   4. tg_platform_managed_permission_guard on user_permission_overrides,
--      role_permission_overrides and role_default_permissions: any write of a
--      platform-managed key is refused (42501 permission_platform_managed)
--      unless it runs as postgres or supabase_admin (the platform function,
--      migrations, FK cascades). Org admins, owners, Act-as seats and every
--      service-role code path are refused in the database.
--   5. set_order_catalog_visibility(org, item_ids, visible, operation_id,
--      surface): the one write path (SECURITY DEFINER, EXECUTE to
--      authenticated). Below.
--   6. platform_set_permission_exception(org, user, permission, state,
--      expected_state, actor, actor_email): the platform console's one write
--      path for the exception (service_role EXECUTE only). Compare-and-set,
--      audited twice in the same transaction. platform_admin_audit's action
--      CHECK gains permission_exception_changed (every older value restated).
--   7. The new-demand gate, tg_order_request_lines_order_visibility, BEFORE
--      INSERT, and BEFORE UPDATE OF quantity_requested, item_id when the
--      quantity rises or the item changes, on order_request_lines: a line for
--      an item with order_catalog_visible = false is refused (P0001
--      order_item_hidden, detail = the item id) for EVERY writer (no role
--      skip), except an exchange replacement order (approved commitments).
--      It reads the item FOR KEY SHARE (the lock the line's own FK check
--      takes), so it serializes with a hide's FOR UPDATE: an order accepted
--      before the hide is history, a write after the hide commits fails.
--      Lowering, removing, notes, approval, picking, returns: untouched.
--   8. place_order_request: step 8 also reports hidden items as
--      item_not_orderable {itemId: 'hidden_from_orders'} (existing reasons
--      keep priority), and the create's catch records the gate's refusal the
--      same way (a hide between step 8 and the insert). Nothing else changes.
--   9. add_order_request_lines(order, lines) and _order_request_line_top_up(
--      order, item, delta): Add items in ONE transaction (top-ups and new
--      lines, in item-id order), replacing the service's separately committed
--      top-ups (no partial change).
--  10. public_link_eligible_items: and i.order_catalog_visible (page and
--      submit of public links share it).
--  11. Exchanges, new selections only: _return_exchange_requester_options and
--      return_exchange_candidates offer no hidden item;
--      _return_exchange_item_ok(staff) refuses a hidden item unless an
--      earlier transaction approved it for a return of this order (re-issue
--      and unchanged lines of a change keep working).
--  12. duplicate_inventory_item copies the source's choice (a copy of a
--      hidden item is hidden). get_request_context() carries the org's
--      order_catalog_last_hide_at.
--
-- WHO CHANGES AT PUSH: nobody. Every existing row reads shown (true), which
-- is today's behaviour; no permission row is written for any member; the two
-- seed rows give admins and managers a capability no shipped UI exposes.
--
-- ── set_order_catalog_visibility ───────────────────────────────────────────
--   1. Signed in (42501 unauthenticated).
--   2. The Orders module (42501 module_disabled) and the capability
--      can_manage_order_catalog (42501 order_catalog_forbidden; it also
--      refuses non-members, expired Act-as seats and disabled accounts).
--   3. MFA, the app's resolveMfaState rule: required when the org's
--      mfa_policy is all_required (an unknown value counts as all_required),
--      or admins_required and the caller is owner or admin, or the caller has
--      a verified factor. Required and no verified factor: 42501
--      mfa_required. Required, enrolled, and the token's aal is not aal2:
--      42501 aal2_required.
--   4. Input: visible and operation_id not null, surface 'web' or 'app',
--      1 to 500 distinct non-null ids (22023 order_catalog_invalid, detail
--      the field).
--   5. Locks first: lock_timeout 3s, the org's rows among the ids FOR UPDATE
--      in id order (a foreign id never locks another org's row). A timeout
--      is 55P03 with nothing changed.
--   6. Scope of the locked rows, one set-based query: the inventory_items
--      SELECT policy's predicate (read scope), not deleted, not a rental, not
--      a kit. Any id that is missing, foreign, unreadable or ineligible:
--      P0002 order_catalog_items_unavailable, detail = the JSON array of
--      those ids (the caller's own input only); nothing applied.
--   7. Write the two columns of the rows whose value differs, under
--      stockpilot.derived_write (updated_at does not move).
--   8. A hide that changed a row stamps organizations.order_catalog_last_
--      hide_at (after the item stamps).
--   9. One audit_logs row per changed item (item.order_visibility_changed).
--  10. Answer {organizationId, operationId, visible, changed, unchanged}.
-- A retry finds every row in its target state: no write, no audit row, every
-- id unchanged. All or nothing: one statement, one transaction.
--
-- ── LOCK ORDER ─────────────────────────────────────────────────────────────
-- A hide: item rows (FOR UPDATE, id order), then the organization row. A
-- submission: its own advisory key lock (place_order_request), then item rows
-- FOR KEY SHARE, one line at a time, in item-id order (place_order_request,
-- add_order_request_lines). Approvals and adjust_stock lock items FOR UPDATE
-- in id order. No cycle among these.
--
-- ── ERRORS ─────────────────────────────────────────────────────────────────
--   42501 unauthenticated, module_disabled, order_catalog_forbidden,
--         mfa_required, aal2_required, order_visibility_managed (the item
--         guard), permission_platform_managed (the permission guard),
--         order_edit_forbidden, warehouse_read, replacement_lines_fixed,
--         not_member
--   22023 order_catalog_invalid, order_lines_invalid,
--         permission_exception_invalid, permission_not_platform_managed
--   P0002 order_catalog_items_unavailable (detail: JSON array of the
--         caller's ids), order_not_found, member_not_found,
--         order_line_not_found
--   P0001 order_item_hidden (detail: the item id), order_item_not_addable
--         (detail: {"itemId", "reason"}), order_closed (detail: the status),
--         permission_exception_changed (detail: the current state)
--   55P03 busy (lock_timeout)
-- No function here raises 40001 or 40P01 (PostgREST re-runs those; 0367).
--
-- ── ROLLBACK ───────────────────────────────────────────────────────────────
-- No down-migration: dropping the columns would make every hidden item
-- orderable again. A defect in the gate is fixed forward with CREATE OR
-- REPLACE of its function. Disabling the gate's triggers re-opens hidden
-- items to ordering and needs the owner's explicit decision. The seed rows
-- may stay. Exceptions are reset from the platform console.
--
-- ── LOCK FOOTPRINT OF THIS FILE ────────────────────────────────────────────
-- ADD COLUMN takes ACCESS EXCLUSIVE on inventory_items and on organizations
-- until commit (reads wait too; every request's context read touches
-- organizations); the partial index build and the trigger creation run under
-- it. The CHECK re-add takes ACCESS EXCLUSIVE on platform_admin_audit. The
-- new triggers take SHARE ROW EXCLUSIVE on order_request_lines and the three
-- permission tables. The SQL-language functions read their tables when they
-- are created (ACCESS SHARE). One prelude takes every table lock the file
-- needs at once, all NOWAIT, in a bounded retry (40 attempts, 50 to 150 ms
-- apart, holding nothing between attempts; the last busy attempt raises 55P03
-- and nothing is applied). No later statement takes a new lock on an
-- existing table. lock_timeout 900ms bounds any other wait.
--
-- ── PROD PUSH NOTE ─────────────────────────────────────────────────────────
-- Push in a low-traffic window, after a data dump (protect-production
-- checklist). Nothing is hidden on purpose until the web build with the
-- filtered catalog has been current for 12 hours (DESIGN.md 10.2 step 2a).

set lock_timeout = '5s';

-- ═══ 0. Preflight ══════════════════════════════════════════════════════════
-- Every body this file replaces or relies on must be the text it was written
-- against (origin/main 0c80a7e5a, read from a fresh local reset), and every
-- new name must be free. Anything else is drift: stop before changing
-- anything.
do $preflight$
declare
  v_bad text := '';
  r record;
begin
  for r in
    select v.sig, v.want_src, v.want_secdef, p.oid as poid, md5(p.prosrc) as got_src, p.prosecdef as got_secdef,
           pg_get_userbyid(p.proowner) as got_owner
      from (values
        -- Replaced here.
        ('public.place_order_request(jsonb,text)',                      '99cf095eba310bd1bd7197d0642a6fb7', false),
        ('public.public_link_eligible_items(uuid,uuid)',                'e7a58716ce09c017418a02b64cc0b09c', true),
        ('public.duplicate_inventory_item(uuid,jsonb)',                 'ebb850a79025768e2c746098e0a2fcaf', false),
        ('public._return_exchange_item_ok(uuid,uuid,text,uuid)',        '60a9e392712860018a5c3d814aa285eb', false),
        ('public._return_exchange_requester_options(uuid,boolean)',     'c9a8b3ff98fa7e53e1befaeb39b52c55', false),
        ('public.return_exchange_candidates(uuid,uuid,text,integer)',   'b98658cd28a15784b2f947be11258e7f', false),
        ('public.get_request_context()',                                '4d9636cbee703d719743450ca22d26e5', false),
        -- Relied on, unchanged.
        ('public.has_permission(uuid,text)',                            'cc0accdad7e2fdf4f88aa82aa887e85f', true),
        ('public.caller_can_read_item(uuid)',                           '80523d2cc0fafe7fc6b3599903d7f014', true),
        ('public.order_items_orderable(uuid,uuid[])',                   'b4df95d74e32850923a430769f96f246', false),
        ('public.tg_inventory_items_set_updated_at()',                  '484ecb7d18e0961f0d929aa3fd666dcc', false),
        ('public.tg_order_request_lines_guard()',                       'd899924c0f8fc1dfae4e8be7bd4c5cad', false),
        ('public.tg_order_request_lines_replacement_guard()',           '63027b8532d411eb1b4f03cc2d1fde9d', false),
        ('public.user_can_access_warehouse(uuid,uuid,text)',            '76b4170f3d393e8a1f293ca3d4895955', true),
        ('public.create_order_request(jsonb,jsonb)',                    '4d65cef6c569a8c2c699fd9d5c8b77d5', false),
        ('public.is_org_member(uuid)',                                  '76492a6556e9f6a7c33d942aa9726f9f', true),
        ('public.module_enabled(uuid,text)',                            'df3260cbcd15f986798e5377d1e95dce', true),
        -- The read-scope helpers the visibility write's scope query calls.
        ('public.rls_inv_read_full_warehouse_ids()',                    '740c1d4753a3a67b8f8cae850c4c6a0e', true),
        ('public.rls_inv_read_assigned_warehouse_ids()',                'b4f82ab8aa1d63be4da042966c205014', true),
        ('public.rls_inv_read_warehouse_charter_ids()',                 '673be48e784a59e56785391b9ec1fd5f', true),
        ('public.rls_cat_unrestricted_org_ids()',                       '21ed57ccaa86b958fccbb08a621baf97', true),
        ('public.rls_cat_allowed_category_ids()',                       'c907f373f976df4586d340e9dbac6308', true)
      ) v(sig, want_src, want_secdef)
      left join pg_proc p on p.oid = to_regprocedure(v.sig)
  loop
    if r.poid is null then
      v_bad := v_bad || format(' %s missing;', r.sig);
    elsif r.got_src <> r.want_src or r.got_secdef <> r.want_secdef or r.got_owner <> 'postgres' then
      v_bad := v_bad || format(' %s drifted (md5 %s, definer %s, owner %s);', r.sig, r.got_src, r.got_secdef, r.got_owner);
    end if;
  end loop;

  -- The two policies copied here: inventory_items_select (the visibility
  -- write's scope query) and order_request_lines_insert (Add items inserts
  -- as the caller under it; the top-up helper restates its rules).
  for r in
    select v.pol, v.want, (select md5(coalesce(pg_get_expr(p.polqual, p.polrelid), '') || '|'
                                      || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''))
                             from pg_policy p
                            where p.polname = v.pol and p.polrelid = to_regclass(v.tbl)) as got
      from (values
        ('inventory_items_select',     'public.inventory_items',     '2596e419ad1bbf05b3af382e8543afa0'),
        ('order_request_lines_insert', 'public.order_request_lines', '1148ba4defc9bcae9e744bd8a04dd82c')
      ) v(pol, tbl, want)
  loop
    if r.got is distinct from r.want then
      v_bad := v_bad || format(' policy %s drifted (md5 %s);', r.pol, coalesce(r.got, 'missing'));
    end if;
  end loop;

  -- The action CHECK this file restates, as 0308 left it.
  if (select md5(pg_get_constraintdef(c.oid)) from pg_constraint c
       where c.conrelid = 'public.platform_admin_audit'::regclass and c.conname = 'platform_admin_audit_action_check')
     is distinct from '0361eb4e9b1a8445b7b6df15eac9e7e6' then
    v_bad := v_bad || ' platform_admin_audit_action_check drifted;';
  end if;

  -- The MFA check reads enrolled factors from the definer.
  if to_regclass('auth.mfa_factors') is null or not has_table_privilege('auth.mfa_factors', 'select') then
    v_bad := v_bad || ' auth.mfa_factors is not readable;';
  end if;

  -- Already applied (or half applied by hand): every new name must be free.
  if exists (select 1 from information_schema.columns
              where table_schema = 'public'
                and ((table_name = 'inventory_items'
                      and column_name in ('order_catalog_visible', 'order_catalog_visibility_changed_at'))
                  or (table_name = 'organizations' and column_name = 'order_catalog_last_hide_at')))
     or to_regclass('public.inventory_items_order_hidden_idx') is not null
     or exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
                   and p.proname in ('set_order_catalog_visibility', 'can_manage_order_catalog',
                                     '_platform_managed_permissions', 'platform_set_permission_exception',
                                     '_order_items_hidden_from_orders', 'add_order_request_lines',
                                     '_order_request_line_top_up', 'tg_inventory_items_order_visibility_guard',
                                     'tg_platform_managed_permission_guard',
                                     'tg_order_request_lines_order_visibility'))
     or exists (select 1 from public.role_default_permissions where permission = 'orders:manage_catalog_visibility')
     or exists (select 1 from public.role_permission_overrides where permission = 'orders:manage_catalog_visibility')
     or exists (select 1 from public.user_permission_overrides where permission = 'orders:manage_catalog_visibility') then
    v_bad := v_bad || ' the ordering-visibility objects already exist;';
  end if;

  if v_bad <> '' then
    raise exception 'order_visibility_preflight: %', v_bad
      using errcode = '55000', hint = 'order_visibility_preflight';
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
      lock table only public.inventory_items, public.organizations, public.platform_admin_audit
        in access exclusive mode nowait;
      lock table only public.order_request_lines, public.user_permission_overrides,
                      public.role_permission_overrides, public.role_default_permissions
        in share row exclusive mode nowait;
      -- Read when the SQL-language functions below are created (their bodies
      -- are checked then): ACCESS SHARE, which only a schema change conflicts
      -- with, taken here so no later statement can wait.
      lock table only public.organization_members, public.organization_modules, public.user_profiles,
                      public.public_request_links, public.public_link_catalog_entries,
                      public.warehouses, public.categories
        in access share mode nowait;
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

-- ═══ 2. The columns ═══════════════════════════════════════════════════════
-- NOT NULL DEFAULT true is a catalog-only change (no rewrite, no backfill):
-- every existing row reads shown, today's behaviour.
alter table public.inventory_items
  add column order_catalog_visible boolean not null default true,
  add column order_catalog_visibility_changed_at timestamptz;

-- Serves the catalog freshness overlay ("hidden since the cached read") and
-- the management list's hidden filter. No row matches at push time.
create index inventory_items_order_hidden_idx
  on public.inventory_items (organization_id, warehouse_id, order_catalog_visibility_changed_at)
  where order_catalog_visible = false;

alter table public.organizations add column order_catalog_last_hide_at timestamptz;

comment on column public.inventory_items.order_catalog_visible is
  'Ordering visibility (0413): true = may appear in Place an Order and be ordered, subject to every existing '
  'channel, access, lifecycle and availability rule; false = hidden from NEW ordering (internal web and phone, '
  'public links, the portal, new exchange selections), and refused for any new line or raised quantity. Never '
  'derived from public_visibility; hiding never touches stock, status, charter, rack or history. Written only by '
  'set_order_catalog_visibility (UPDATE is refused for every other writer, service_role included).';
comment on column public.inventory_items.order_catalog_visibility_changed_at is
  'When order_catalog_visible last changed (0413), stamped with clock_timestamp() by set_order_catalog_visibility, '
  'or at insert when a record is created hidden. Null = never changed. Feeds the catalog freshness overlay.';
comment on column public.organizations.order_catalog_last_hide_at is
  'The last time anyone in this organization hid an item from ordering (0413), stamped by '
  'set_order_catalog_visibility after its item stamps. Carried by get_request_context() so catalog loads skip the '
  'freshness query when nothing was hidden since their cached read. Null = never.';

-- ═══ 3. The item guard ════════════════════════════════════════════════════
create function public.tg_inventory_items_order_visibility_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    -- Any value may be inserted (a new hidden record reveals and hides
    -- nothing that exists, and duplicate_inventory_item copies a hidden
    -- source as the caller); the stamp is the database's.
    new.order_catalog_visibility_changed_at :=
      case when new.order_catalog_visible then null else clock_timestamp() end;
    return new;
  end if;
  if (new.order_catalog_visible is distinct from old.order_catalog_visible
      or new.order_catalog_visibility_changed_at is distinct from old.order_catalog_visibility_changed_at)
     and current_user not in ('postgres', 'supabase_admin') then
    raise exception 'Ordering visibility is changed only through Manage order items.'
      using errcode = '42501', hint = 'order_visibility_managed';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_inventory_items_order_visibility_guard() from public, anon, authenticated, service_role;

-- Sorts after trg_zz_inventory_items_guard (same-timing triggers fire in
-- name order). Not named *_guard: 0359's test 20 pins the ledger guards by
-- that pattern, and this is not one of them.
create trigger trg_zz_inventory_items_order_visibility
  before insert or update of order_catalog_visible, order_catalog_visibility_changed_at
  on public.inventory_items
  for each row execute function public.tg_inventory_items_order_visibility_guard();

comment on function public.tg_inventory_items_order_visibility_guard() is
  'Ordering visibility guard (0413). UPDATE: a change of order_catalog_visible or its stamp is refused (42501 '
  'order_visibility_managed) unless current_user is postgres or supabase_admin, which inside a SECURITY DEFINER '
  'function owned by postgres is the owner: so only set_order_catalog_visibility (and operator SQL) writes it; '
  'service_role is NOT exempt. INSERT: any value; the stamp is clock_timestamp() for a hidden row, null for a '
  'shown one. SECURITY INVOKER (current_user is the writer).';

-- ═══ 4. The permission ════════════════════════════════════════════════════
-- The keys only StockPilot support may grant or deny per user. Core keeps
-- PLATFORM_MANAGED_PERMISSIONS equal (a parity test).
create function public._platform_managed_permissions()
returns text[]
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select array['orders:manage_catalog_visibility']::text[]
$$;

revoke all on function public._platform_managed_permissions() from public, anon, authenticated, service_role;
-- The guard below is SECURITY INVOKER, so each role that can reach a write
-- of the three permission tables calls this as itself.
grant execute on function public._platform_managed_permissions() to anon, authenticated, service_role;

comment on function public._platform_managed_permissions() is
  'The permission keys only StockPilot support may grant, deny or reset per member (0413): '
  'orders:manage_catalog_visibility. Core PLATFORM_MANAGED_PERMISSIONS is kept equal by a parity test. A constant; '
  'IMMUTABLE.';

-- Defaults: admin and manager (the owner short-circuits to every key and is
-- never seeded, 0207); staff and viewer do not hold it.
insert into public.role_default_permissions (role, permission) values
  ('admin',   'orders:manage_catalog_visibility'),
  ('manager', 'orders:manage_catalog_visibility')
on conflict (role, permission) do nothing;

-- Explicit deny, then explicit allow, then the role default, for every role,
-- the owner included, for this one key. has_permission applies the user
-- override for every role but the owner (0310 short-circuits the owner); the
-- second clause applies an explicit deny to the owner too.
create function public.can_manage_order_catalog(p_organization_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select public.has_permission(p_organization_id, 'orders:manage_catalog_visibility')
     and not exists (select 1 from public.user_permission_overrides o
                      where o.organization_id = p_organization_id
                        and o.user_id = auth.uid()
                        and o.permission = 'orders:manage_catalog_visibility'
                        and o.granted = false)
$$;

revoke all on function public.can_manage_order_catalog(uuid) from public, anon, authenticated, service_role;
grant execute on function public.can_manage_order_catalog(uuid) to authenticated;

comment on function public.can_manage_order_catalog(uuid) is
  'Whether the caller may manage ordering visibility in the organization (0413): has_permission(org, '
  'orders:manage_catalog_visibility) and no explicit deny, so the deny holds for the owner too. False for '
  'non-members, expired Act-as seats and disabled accounts (has_permission). SECURITY INVOKER (a member reads '
  'their own override rows); EXECUTE to authenticated only.';

-- ═══ 5. The permission guard ══════════════════════════════════════════════
create function public.tg_platform_managed_permission_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if current_user not in ('postgres', 'supabase_admin')
     and ((tg_op in ('INSERT', 'UPDATE') and new.permission = any (public._platform_managed_permissions()))
          or (tg_op in ('UPDATE', 'DELETE') and old.permission = any (public._platform_managed_permissions()))) then
    raise exception 'This permission is managed by StockPilot support.'
      using errcode = '42501', hint = 'permission_platform_managed';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.tg_platform_managed_permission_guard() from public, anon, authenticated, service_role;

create trigger trg_zz_platform_managed_permission_guard
  before insert or update or delete on public.user_permission_overrides
  for each row execute function public.tg_platform_managed_permission_guard();
create trigger trg_zz_platform_managed_permission_guard
  before insert or update or delete on public.role_permission_overrides
  for each row execute function public.tg_platform_managed_permission_guard();
create trigger trg_zz_platform_managed_permission_guard
  before insert or update or delete on public.role_default_permissions
  for each row execute function public.tg_platform_managed_permission_guard();

comment on function public.tg_platform_managed_permission_guard() is
  'Platform-managed permission guard (0413) on user_permission_overrides, role_permission_overrides and '
  'role_default_permissions: an INSERT, UPDATE or DELETE whose old or new permission is in '
  '_platform_managed_permissions() is refused (42501 permission_platform_managed) unless current_user is postgres or '
  'supabase_admin: platform_set_permission_exception (definer), migrations, operator SQL and FK cascades pass; '
  'org admins and owners (Roles page, PostgREST), Act-as seats and every service_role path are refused. Role rows '
  'for the key are refused for everyone (one would grant every member of a role).';

-- ═══ 6. The platform audit vocabulary ═════════════════════════════════════
-- The re-add MUST restate every accepted value (0308's warning; the eleven
-- below were read back with pg_get_constraintdef and pinned by the preflight).
alter table public.platform_admin_audit
  drop constraint platform_admin_audit_action_check;
alter table public.platform_admin_audit
  add constraint platform_admin_audit_action_check
  check (action in (
    'viewed_org', 'acted_as_start', 'acted_as_end',
    'billing_changed', 'password_reset_sent',
    'org_provisioned', 'ticket_updated',
    'deletion_passphrase_set', 'org_deleted',
    'user_disabled', 'user_reenabled',
    'permission_exception_changed'
  ));

-- ═══ 7. set_order_catalog_visibility ══════════════════════════════════════
create function public.set_order_catalog_visibility(
  p_organization_id uuid,
  p_item_ids        uuid[],
  p_visible         boolean,
  p_operation_id    uuid,
  p_surface         text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid       uuid := auth.uid();
  v_role      text;
  v_policy    text;
  v_enrolled  boolean;
  v_required  boolean;
  v_ids       uuid[];
  v_locked    uuid[];
  v_bad       uuid[];
  v_changed   uuid[];
  v_dw        text;
  v_acting    boolean;
begin
  -- ── 1. Identity ──────────────────────────────────────────────────────────
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
  end if;

  -- ── 2. Module and capability (the capability refuses non-members,
  -- expired Act-as seats and disabled accounts) ────────────────────────────
  if p_organization_id is null or not public.can_manage_order_catalog(p_organization_id) then
    raise exception 'You do not have access to manage order items.'
      using errcode = '42501', hint = 'order_catalog_forbidden';
  end if;
  if not public.module_enabled(p_organization_id, 'orders') then
    raise exception 'module_disabled' using errcode = '42501', hint = 'module_disabled';
  end if;

  -- ── 3. MFA: the app's resolveMfaState rule, for a direct RPC call ────────
  select m.role into v_role
    from public.organization_members m
   where m.organization_id = p_organization_id and m.user_id = v_uid and m.accepted_at is not null
     and (m.impersonation_expires_at is null or m.impersonation_expires_at > now())
   limit 1;
  select o.mfa_policy::text into v_policy from public.organizations o where o.id = p_organization_id;
  if v_policy is null or v_policy not in ('optional', 'admins_required', 'all_required') then
    v_policy := 'all_required';
  end if;
  v_enrolled := exists (select 1 from auth.mfa_factors f where f.user_id = v_uid and f.status = 'verified');
  v_required := v_policy = 'all_required'
                or (v_policy = 'admins_required' and v_role in ('owner', 'admin'))
                or v_enrolled;
  if v_required then
    if not v_enrolled then
      raise exception 'Multi-factor authentication required. Enroll in MFA before performing this action.'
        using errcode = '42501', hint = 'mfa_required';
    end if;
    if coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then
      raise exception 'Re-authenticate with MFA before performing this action.'
        using errcode = '42501', hint = 'aal2_required';
    end if;
  end if;

  -- ── 4. Input ─────────────────────────────────────────────────────────────
  if p_visible is null then
    raise exception 'order_catalog_invalid' using errcode = '22023', hint = 'order_catalog_invalid', detail = 'visible';
  end if;
  if p_operation_id is null then
    raise exception 'order_catalog_invalid' using errcode = '22023', hint = 'order_catalog_invalid', detail = 'operationId';
  end if;
  if p_surface is null or p_surface not in ('web', 'app') then
    raise exception 'order_catalog_invalid' using errcode = '22023', hint = 'order_catalog_invalid', detail = 'surface';
  end if;
  v_ids := array(select distinct u.id from unnest(coalesce(p_item_ids, '{}'::uuid[])) as u(id)
                  where u.id is not null order by u.id);
  if cardinality(v_ids) < 1 or cardinality(v_ids) > 500 then
    raise exception 'order_catalog_invalid' using errcode = '22023', hint = 'order_catalog_invalid', detail = 'itemIds';
  end if;

  -- ── 5. Locks first (id order; this org's rows only) ──────────────────────
  -- FOR UPDATE: the one lock the order gate's FOR KEY SHARE waits for.
  perform set_config('lock_timeout', '3s', true);
  v_locked := array(select ii.id from public.inventory_items ii
                     where ii.id = any (v_ids) and ii.organization_id = p_organization_id
                     order by ii.id
                     for update);

  -- ── 6. Read scope of the locked rows, set-based (inventory_items_select's
  -- predicate, each helper set read once) ─────────────────────────────────
  with full_wh as materialized (select x.id from public.rls_inv_read_full_warehouse_ids() as x(id)),
       asg_wh  as materialized (select x.id from public.rls_inv_read_assigned_warehouse_ids() as x(id)),
       wh_ch   as materialized (select r.warehouse_id, r.charter_id from public.rls_inv_read_warehouse_charter_ids() r),
       cat_unr as materialized (select x.id from public.rls_cat_unrestricted_org_ids() as x(id)),
       cat_ok  as materialized (select c.organization_id, c.category_id from public.rls_cat_allowed_category_ids() c),
       ok as (
         select it.id
           from public.inventory_items it
          where it.id = any (v_locked)
            and it.deleted_at is null
            and not coalesce(it.is_rental, false)
            and not coalesce(it.is_bundle, false)
            and (it.warehouse_id in (select f.id from full_wh f)
                 or (it.charter_id is null and it.warehouse_id in (select a.id from asg_wh a))
                 or (it.warehouse_id, it.charter_id) in (select w.warehouse_id, w.charter_id from wh_ch w))
            and (it.organization_id in (select u.id from cat_unr u)
                 or (it.organization_id, it.category_id) in (select c.organization_id, c.category_id from cat_ok c)))
  select array(select u.id from unnest(v_ids) as u(id)
                where not exists (select 1 from ok where ok.id = u.id)
                order by u.id)
    into v_bad;
  if cardinality(v_bad) > 0 then
    raise exception 'Some selected items are no longer available to you. Nothing was changed.'
      using errcode = 'P0002', hint = 'order_catalog_items_unavailable', detail = to_jsonb(v_bad)::text;
  end if;

  -- ── 7. Write (updated_at kept: a derived write) ──────────────────────────
  v_dw := current_setting('stockpilot.derived_write', true);
  perform set_config('stockpilot.derived_write', 'on', true);
  with upd as (
    update public.inventory_items ii
       set order_catalog_visible = p_visible,
           order_catalog_visibility_changed_at = clock_timestamp()
     where ii.id = any (v_ids)
       and ii.organization_id = p_organization_id
       and ii.order_catalog_visible is distinct from p_visible
    returning ii.id)
  select array(select upd.id from upd order by upd.id) into v_changed;
  perform set_config('stockpilot.derived_write', coalesce(v_dw, ''), true);

  -- ── 8. The organization's hide mark (after the item stamps) ──────────────
  if not p_visible and cardinality(v_changed) > 0 then
    update public.organizations o
       set order_catalog_last_hide_at = clock_timestamp()
     where o.id = p_organization_id;
  end if;

  -- ── 9. Audit: one row per changed item, none for unchanged ids ───────────
  if cardinality(v_changed) > 0 then
    v_acting := exists (select 1 from public.organization_members m
                         where m.organization_id = p_organization_id and m.user_id = v_uid
                           and m.impersonation_expires_at is not null);
    insert into public.audit_logs (organization_id, user_id, event, metadata)
    select p_organization_id, v_uid, 'item.order_visibility_changed',
           jsonb_build_object(
             'entity_type',        'inventory_item',
             'entity_id',          ii.id,
             'warehouse_id',       ii.warehouse_id,
             'before',             jsonb_build_object('order_catalog_visible', not p_visible),
             'after',              jsonb_build_object('order_catalog_visible', p_visible),
             'reason',             null,
             'operation_id',       p_operation_id,
             'operation_size',     cardinality(v_ids),
             'surface',            p_surface,
             'acting_as_platform', v_acting)
      from public.inventory_items ii
     where ii.id = any (v_changed)
     order by ii.id;
  end if;

  -- ── 10. Answer ───────────────────────────────────────────────────────────
  return jsonb_build_object(
    'organizationId', p_organization_id,
    'operationId',    p_operation_id,
    'visible',        p_visible,
    'changed',        to_jsonb(v_changed),
    'unchanged',      to_jsonb(array(select u.id from unnest(v_ids) as u(id)
                                      where u.id <> all (v_changed) order by u.id)));
end;
$$;

revoke all on function public.set_order_catalog_visibility(uuid, uuid[], boolean, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.set_order_catalog_visibility(uuid, uuid[], boolean, uuid, text) to authenticated;

comment on function public.set_order_catalog_visibility(uuid, uuid[], boolean, uuid, text) is
  'The one write path of ordering visibility (0413): Show in Orders / Hide from Orders for 1 to 500 explicitly '
  'selected records. SECURITY DEFINER, EXECUTE to authenticated only; the actor is auth.uid(). Gates: signed in, '
  'can_manage_order_catalog (42501 order_catalog_forbidden), the Orders module, MFA as the app requires it (42501 '
  'mfa_required, aal2_required). Locks the org''s rows FOR UPDATE in id order (lock_timeout 3s, 55P03), then checks '
  'read scope set-based (P0002 order_catalog_items_unavailable, detail = the caller''s failing ids; nothing '
  'applied). Writes only order_catalog_visible and its stamp (updated_at kept), stamps the org hide mark on a hide, '
  'and one audit_logs row per changed item (item.order_visibility_changed). A retry is a no-op with no audit row. '
  'Never 40001/40P01.';

-- ═══ 8. platform_set_permission_exception ═════════════════════════════════
create function public.platform_set_permission_exception(
  p_organization_id uuid,
  p_user_id         uuid,
  p_permission      text,
  p_state           text,
  p_expected_state  text,
  p_actor_user_id   uuid,
  p_actor_email     text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_role    text;
  v_granted boolean;
  v_before  text;
  v_email   text := nullif(btrim(coalesce(p_actor_email, '')), '');
begin
  -- Service role only (no API EXECUTE); the server verified the platform
  -- admin and their step-up before calling. auth.uid() is null here, which is
  -- why the actor is passed and recorded explicitly.
  if p_permission is null or not (p_permission = any (public._platform_managed_permissions())) then
    raise exception 'permission_not_platform_managed'
      using errcode = '22023', hint = 'permission_not_platform_managed';
  end if;
  if p_state is null or p_state not in ('default', 'allow', 'deny') then
    raise exception 'permission_exception_invalid' using errcode = '22023', hint = 'permission_exception_invalid', detail = 'state';
  end if;
  if p_expected_state is null or p_expected_state not in ('default', 'allow', 'deny') then
    raise exception 'permission_exception_invalid' using errcode = '22023', hint = 'permission_exception_invalid', detail = 'expectedState';
  end if;
  if p_organization_id is null or p_user_id is null or p_actor_user_id is null or v_email is null then
    raise exception 'permission_exception_invalid' using errcode = '22023', hint = 'permission_exception_invalid', detail = 'target';
  end if;

  -- The target: an accepted member with no Act-as seat (as the console's
  -- Users tab lists them). The owner is a valid target.
  select m.role into v_role
    from public.organization_members m
   where m.organization_id = p_organization_id and m.user_id = p_user_id
     and m.accepted_at is not null and m.impersonation_expires_at is null
   limit 1;
  if v_role is null then
    raise exception 'member_not_found' using errcode = 'P0002', hint = 'member_not_found';
  end if;

  -- One decision at a time per (organization, member, key), absent row
  -- included; then the row itself.
  perform set_config('lock_timeout', '3s', true);
  perform pg_advisory_xact_lock(hashtextextended(
    'platform_permission_exception:' || p_organization_id::text || ':' || p_user_id::text || ':' || p_permission, 0));
  select o.granted into v_granted
    from public.user_permission_overrides o
   where o.organization_id = p_organization_id and o.user_id = p_user_id and o.permission = p_permission
   for update;
  v_before := case when v_granted is null then 'default' when v_granted then 'allow' else 'deny' end;

  -- Compare-and-set: a stale console row is a conflict, never "not allowed".
  if v_before <> p_expected_state then
    raise exception 'permission_exception_changed'
      using errcode = 'P0001', hint = 'permission_exception_changed', detail = v_before;
  end if;

  if v_before = p_state then
    return jsonb_build_object('before', v_before, 'after', p_state, 'targetRole', v_role, 'changed', false);
  end if;

  if p_state = 'default' then
    delete from public.user_permission_overrides o
     where o.organization_id = p_organization_id and o.user_id = p_user_id and o.permission = p_permission;
  else
    insert into public.user_permission_overrides (organization_id, user_id, permission, granted, updated_by, updated_at)
    values (p_organization_id, p_user_id, p_permission, p_state = 'allow', p_actor_user_id, now())
    on conflict (organization_id, user_id, permission)
    do update set granted = excluded.granted, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  end if;

  insert into public.platform_admin_audit (actor_user_id, actor_email, action, target_organization_id, target_user_id, detail)
  values (p_actor_user_id, v_email, 'permission_exception_changed', p_organization_id, p_user_id,
          jsonb_build_object('permission', p_permission, 'before', v_before, 'after', p_state, 'target_role', v_role));

  insert into public.audit_logs (organization_id, user_id, event, metadata)
  values (p_organization_id, p_actor_user_id, 'permissions.platform_exception_changed',
          jsonb_build_object(
            'entity_type',          'user',
            'entity_id',            p_user_id,
            'permission',           p_permission,
            'before',               v_before,
            'after',                p_state,
            'target_role',          v_role,
            'platform_admin_email', v_email));

  return jsonb_build_object('before', v_before, 'after', p_state, 'targetRole', v_role, 'changed', true);
end;
$$;

revoke all on function public.platform_set_permission_exception(uuid, uuid, text, text, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.platform_set_permission_exception(uuid, uuid, text, text, text, uuid, text) to service_role;

comment on function public.platform_set_permission_exception(uuid, uuid, text, text, text, uuid, text) is
  'StockPilot support''s one write path for a platform-managed permission exception (0413): state default '
  '(delete the user override), allow or deny, for an accepted member without an Act-as seat (P0002 '
  'member_not_found), compare-and-set on expected_state (P0001 permission_exception_changed, detail = the current '
  'state; nothing written). Serialized per (org, member, key). Writes platform_admin_audit '
  '(permission_exception_changed) and audit_logs (permissions.platform_exception_changed) in the same transaction; '
  'a repeat of the current state writes nothing. SECURITY DEFINER (passes the permission guard as postgres); '
  'EXECUTE to service_role only: the server verifies the platform admin and step-up first.';

-- ═══ 9. Hidden items for an order request ═════════════════════════════════
create function public._order_items_hidden_from_orders(p_item_ids uuid[])
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_object_agg(ii.id::text, 'hidden_from_orders'), '{}'::jsonb)
    from public.inventory_items ii
   where ii.id = any (coalesce(p_item_ids, '{}'::uuid[]))
     and ii.order_catalog_visible = false
$$;

revoke all on function public._order_items_hidden_from_orders(uuid[]) from public, anon, authenticated, service_role;
-- place_order_request is SECURITY INVOKER and calls this as the caller.
grant execute on function public._order_items_hidden_from_orders(uuid[]) to authenticated;

comment on function public._order_items_hidden_from_orders(uuid[]) is
  '{itemId: ''hidden_from_orders''} for the given items the caller can read whose order_catalog_visible is false '
  '(0413). SECURITY INVOKER (read under the caller''s RLS, so an unreadable item is never named); place_order_request '
  'merges it under order_items_orderable''s reasons. EXECUTE to authenticated (the invoker caller needs it).';

-- ═══ 10. place_order_request (step 8 and the create's catch) ══════════════
CREATE OR REPLACE FUNCTION public.place_order_request(p_request jsonb, p_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET lock_timeout TO '5s'
AS $function$
declare
  -- Exactly the characters JavaScript's String.prototype.trim removes, so a
  -- trimmed value and a cap mean the same thing in core and here.
  c_ws    constant text := E'\u0009\u000A\u000B\u000C\u000D                  　﻿';
  c_uuid  constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  -- zod 3's .email() pattern (core place-order.ts EMAIL_RE), read with ~*.
  c_email constant text := '^(?!\.)(?!.*\.\.)([A-Z0-9_''+\-.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9-]*\.)+[A-Z]{2,}$';
  -- An instant with an explicit zone; a zone-less text would be read in the
  -- session's zone, and words like 'tomorrow' are valid timestamptz input.
  c_iso   constant text := '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}(:?\d{2})?)$';
  v_uid       uuid := auth.uid();
  v_org       uuid;
  v_key       uuid;
  v_key_text  text := nullif(btrim(coalesce(p_key, '')), '');
  v_surface   text;
  v_wh        uuid;
  v_method    text;
  v_site      uuid;
  v_lines_in  jsonb;
  v_lines     jsonb;
  v_item_ids  uuid[];
  v_total     numeric;
  v_max_sum   numeric;
  v_notes     text;
  v_name      text;
  v_email     text;
  v_on_behalf boolean;
  v_needed    timestamptz;
  v_hash      text;
  v_prev      public.order_submissions%rowtype;
  v_order     jsonb;
  v_refusal   jsonb;
  v_bad       jsonb;
  v_site_st   text;
  v_row       public.order_requests%rowtype;
  v_msg       text;
  v_flag      text;
begin
  -- ── 1. Identity ──────────────────────────────────────────────────────────
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
  end if;
  -- Compared as text, so a malformed placer is a mismatch, never a cast error.
  if lower(coalesce(p_request->>'placer_user_id', '')) is distinct from v_uid::text then
    raise exception 'placer_mismatch' using errcode = '42501', hint = 'placer_mismatch';
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

  -- ── 3. Shape (pure; each cast behind its type test, CASE not OR) ─────────
  if jsonb_typeof(p_request->'warehouse_id') is distinct from 'string'
     or (p_request->>'warehouse_id') !~ c_uuid then
    raise exception 'order_invalid' using errcode = '22023', hint = 'order_invalid', detail = 'warehouse';
  end if;
  v_wh := (p_request->>'warehouse_id')::uuid;

  v_method := case when jsonb_typeof(p_request->'fulfillment_type') = 'string'
                   then p_request->>'fulfillment_type' end;
  if v_method is null or v_method not in ('pickup', 'delivery') then
    raise exception 'order_invalid' using errcode = '22023', hint = 'order_invalid', detail = 'fulfillment_type';
  end if;

  if v_method = 'delivery' then
    if p_request->'delivery_charter_id' is null or jsonb_typeof(p_request->'delivery_charter_id') = 'null' then
      raise exception 'delivery_needs_site' using errcode = '22023', hint = 'delivery_needs_site';
    end if;
    if jsonb_typeof(p_request->'delivery_charter_id') <> 'string'
       or (p_request->>'delivery_charter_id') !~ c_uuid then
      raise exception 'order_invalid' using errcode = '22023', hint = 'order_invalid', detail = 'site';
    end if;
    v_site := (p_request->>'delivery_charter_id')::uuid;
  else
    -- A pickup has no site: whatever was sent is dropped.
    v_site := null;
  end if;

  v_lines_in := p_request->'lines';
  if v_lines_in is null or jsonb_typeof(v_lines_in) <> 'array'
     or jsonb_array_length(v_lines_in) < 1 or jsonb_array_length(v_lines_in) > 100 then
    raise exception 'order_invalid' using errcode = '22023', hint = 'order_invalid', detail = 'lines';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_lines_in) as e(l)
     where case
             when jsonb_typeof(l) <> 'object' then true
             when jsonb_typeof(l->'item_id') is distinct from 'string' then true
             else (l->>'item_id') !~ c_uuid
           end
  ) then
    raise exception 'order_invalid' using errcode = '22023', hint = 'order_invalid', detail = 'lines';
  end if;
  -- Each line whole and at least 1 BEFORE lines of one item are summed.
  if exists (
    select 1 from jsonb_array_elements(v_lines_in) as e(l)
     where case
             when jsonb_typeof(l->'quantity') is distinct from 'number' then true
             else (l->>'quantity')::numeric < 1
                  or (l->>'quantity')::numeric <> trunc((l->>'quantity')::numeric)
           end
  ) then
    raise exception 'order_invalid' using errcode = '22023', hint = 'order_invalid', detail = 'quantity';
  end if;
  -- Per item first, then the total (numeric throughout: no integer overflow).
  select max(s.q), sum(s.q) into v_max_sum, v_total
    from (select (l->>'item_id')::uuid as item, sum((l->>'quantity')::numeric) as q
            from jsonb_array_elements(v_lines_in) as e(l) group by 1) s;
  if v_max_sum > 10000 then
    raise exception 'order_invalid' using errcode = '22023', hint = 'order_invalid', detail = 'quantity';
  end if;
  if v_total > 10000 then
    raise exception 'order_invalid' using errcode = '22023', hint = 'order_invalid', detail = 'total';
  end if;
  -- One line per item, summed, in item order.
  select jsonb_agg(jsonb_build_object('item_id', s.item, 'quantity', s.q) order by s.item),
         array_agg(s.item order by s.item)
    into v_lines, v_item_ids
    from (select (l->>'item_id')::uuid as item, sum((l->>'quantity')::numeric)::integer as q
            from jsonb_array_elements(v_lines_in) as e(l) group by 1) s;

  if p_request->'notes' is not null and jsonb_typeof(p_request->'notes') not in ('string', 'null') then
    raise exception 'order_invalid' using errcode = '22023', hint = 'order_invalid', detail = 'notes';
  end if;
  v_notes := nullif(btrim(coalesce(p_request->>'notes', ''), c_ws), '');
  if length(v_notes) > 2000 then
    raise exception 'order_invalid' using errcode = '22023', hint = 'order_invalid', detail = 'notes';
  end if;

  -- On behalf: a name and an email, both or neither.
  if coalesce(jsonb_typeof(p_request->'on_behalf_name'), 'null') = 'null'
     and coalesce(jsonb_typeof(p_request->'on_behalf_email'), 'null') = 'null' then
    v_on_behalf := false;
  else
    if jsonb_typeof(p_request->'on_behalf_name') is distinct from 'string'
       or jsonb_typeof(p_request->'on_behalf_email') is distinct from 'string' then
      raise exception 'order_invalid' using errcode = '22023', hint = 'order_invalid', detail = 'on_behalf';
    end if;
    v_name := btrim(p_request->>'on_behalf_name', c_ws);
    v_email := btrim(p_request->>'on_behalf_email', c_ws);
    if length(v_name) < 1 or length(v_name) > 120
       or length(v_email) > 254 or v_email !~* c_email then
      raise exception 'order_invalid' using errcode = '22023', hint = 'order_invalid', detail = 'on_behalf';
    end if;
    v_on_behalf := true;
  end if;

  if coalesce(jsonb_typeof(p_request->'needed_by'), 'null') = 'null' then
    v_needed := null;
  elsif jsonb_typeof(p_request->'needed_by') = 'string'
        and (p_request->>'needed_by') ~ c_iso
        and pg_input_is_valid(p_request->>'needed_by', 'timestamptz') then
    v_needed := (p_request->>'needed_by')::timestamptz;
  else
    raise exception 'order_invalid' using errcode = '22023', hint = 'order_invalid', detail = 'needed_by';
  end if;

  v_surface := case when jsonb_typeof(p_request->'surface') = 'string' then p_request->>'surface' end;
  if v_surface is null or v_surface not in ('web', 'app') then
    raise exception 'order_invalid' using errcode = '22023', hint = 'order_invalid', detail = 'surface';
  end if;

  -- ── 4. The request hash (jsonb's text form is canonical) ─────────────────
  v_hash := md5('order_request_create:v1|' || jsonb_build_object(
    'uid', v_uid,
    'org', v_org,
    'warehouse', v_wh,
    'method', v_method,
    'site', v_site,
    'name', v_name,
    'email', lower(v_email),
    'notes', v_notes,
    'needed_by', to_char(v_needed at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'lines', (select jsonb_agg(jsonb_build_array(l->>'item_id', (l->>'quantity')::integer) order by l->>'item_id')
                from jsonb_array_elements(v_lines) as e(l))
  )::text);

  -- ── 5. The key's lock, held to commit ────────────────────────────────────
  perform pg_advisory_xact_lock(
    hashtextextended('order_submission:' || v_org::text || ':' || v_uid::text || ':' || v_key::text, 0));

  -- ── 6. Lookup (a new statement: it sees what an earlier holder committed) ─
  select s.* into v_prev
    from public.order_submissions s
   where s.organization_id = v_org and s.user_id = v_uid and s.key = v_key;
  if found then
    if v_prev.outcome = 'withdrawn' then
      return jsonb_build_object('outcome', 'withdrawn');
    end if;
    if v_prev.request_hash is distinct from v_hash then
      if v_prev.outcome = 'placed' then
        v_order := public._order_submission_summary(v_prev.order_request_id);
        raise exception 'idempotency_conflict' using errcode = 'P0001', hint = 'idempotency_conflict',
          detail = jsonb_build_object('orderId', v_prev.order_request_id,
                                      'orderNumber', v_order->'order_number')::text;
      end if;
      raise exception 'idempotency_conflict' using errcode = 'P0001', hint = 'idempotency_conflict';
    end if;
    if v_prev.outcome = 'refused' then
      return jsonb_build_object('outcome', 'refused', 'replay', true, 'refusal', v_prev.refusal);
    end if;
    v_order := public._order_submission_summary(v_prev.order_request_id);
    if v_order is null then
      raise exception 'place_order_request_internal: the placed order could not be read'
        using errcode = 'P0001', hint = 'place_order_request_internal';
    end if;
    return jsonb_build_object('outcome', 'placed', 'replay', true, 'order', v_order);
  end if;

  -- ── 7 and 8. Floors, then time and state (recorded under the key) ────────
  <<checks>>
  begin
    if not public.module_enabled(v_org, 'orders') then
      v_refusal := jsonb_build_object('reason', 'module_disabled', 'detail', null);
      exit checks;
    end if;
    if not public.has_permission(v_org, 'orders:request') then
      v_refusal := jsonb_build_object('reason', 'permission', 'detail', null);
      exit checks;
    end if;
    -- Under the caller's RLS (warehouses_select: a manager, or read access to
    -- this warehouse).
    perform 1 from public.warehouses w
     where w.id = v_wh and w.organization_id = v_org and w.status <> 'archived';
    if not found then
      v_refusal := jsonb_build_object('reason', 'warehouse_not_available', 'detail', null);
      exit checks;
    end if;
    if v_on_behalf and not public.has_permission(v_org, 'orders:approve') then
      v_refusal := jsonb_build_object('reason', 'on_behalf_not_permitted', 'detail', null);
      exit checks;
    end if;

    if v_needed is not null and v_needed <= now() then
      v_refusal := jsonb_build_object('reason', 'needed_by_past', 'detail', null);
      exit checks;
    end if;
    if v_needed is not null and v_needed > now() + interval '5 years' then
      v_refusal := jsonb_build_object('reason', 'needed_by_out_of_range', 'detail', null);
      exit checks;
    end if;
    if v_method = 'delivery' then
      select c.status into v_site_st
        from public.warehouse_charters wc
        join public.charters c on c.id = wc.charter_id
       where wc.warehouse_id = v_wh and wc.charter_id = v_site and wc.organization_id = v_org;
      if not found then
        v_refusal := jsonb_build_object('reason', 'site_not_available', 'detail', 'not_serviced');
        exit checks;
      end if;
      if v_site_st is distinct from 'active' then
        v_refusal := jsonb_build_object('reason', 'site_not_available', 'detail', 'inactive');
        exit checks;
      end if;
    end if;
    -- 0413: an item hidden from ordering is item_not_orderable with the
    -- reason hidden_from_orders; order_items_orderable's reasons (the right
    -- side of ||) keep priority, so an item the caller cannot read is still
    -- not_visible.
    v_bad := public._order_items_hidden_from_orders(v_item_ids) || public.order_items_orderable(v_wh, v_item_ids);
    if v_bad <> '{}'::jsonb then
      v_refusal := jsonb_build_object('reason', 'item_not_orderable', 'detail', v_bad);
      exit checks;
    end if;

    -- ── 9. Create, through the frozen function ─────────────────────────────
    begin
      v_row := public.create_order_request(
        jsonb_build_object(
          'organization_id', v_org,
          'warehouse_id', v_wh,
          'requester_user_id', case when v_on_behalf then null else v_uid end,
          'requester_name', case when v_on_behalf then v_name end,
          'requester_email', case when v_on_behalf then v_email end,
          'notes', v_notes,
          'needed_by', v_needed,
          'fulfillment_type', v_method,
          'requester_phone', null,
          'delivery_charter_id', v_site,
          'pickup_location_notes', null),
        v_lines);
    exception
      when sqlstate '42501' then
        get stacked diagnostics v_msg = message_text;
        if v_msg = 'That item cannot be ordered: it is deleted, a rental item, or not received yet.' then
          -- A new statement: names the item that changed since step 8.
          v_refusal := jsonb_build_object('reason', 'item_not_orderable',
                                          'detail', public.order_items_orderable(v_wh, v_item_ids));
        else
          raise;
        end if;
      when sqlstate 'P0001' then
        -- 0413: the order-visibility gate on order_request_lines (a hide that
        -- committed after step 8). A new statement: names what changed.
        get stacked diagnostics v_msg = pg_exception_hint;
        if v_msg = 'order_item_hidden' then
          v_refusal := jsonb_build_object('reason', 'item_not_orderable',
                                          'detail', public._order_items_hidden_from_orders(v_item_ids)
                                                    || public.order_items_orderable(v_wh, v_item_ids));
        else
          raise;
        end if;
      when sqlstate '23514' then
        get stacked diagnostics v_msg = message_text;
        if v_msg = 'A line needs a real quantity.' then
          v_refusal := jsonb_build_object('reason', 'invalid', 'detail', null);
        else
          raise;
        end if;
    end;
  end checks;

  -- ── 10. Record the outcome (the flag raised inline, restored at once) ────
  v_flag := current_setting('stockpilot.order_submit', true);
  perform set_config('stockpilot.order_submit', pg_current_xact_id()::text, true);
  if v_refusal is not null then
    insert into public.order_submissions
      (organization_id, user_id, key, request_hash, outcome, order_request_id, refusal, surface)
    values (v_org, v_uid, v_key, v_hash, 'refused', null, v_refusal, v_surface);
  else
    insert into public.order_submissions
      (organization_id, user_id, key, request_hash, outcome, order_request_id, refusal, surface)
    values (v_org, v_uid, v_key, v_hash, 'placed', v_row.id, null, v_surface);
  end if;
  perform set_config('stockpilot.order_submit', coalesce(v_flag, ''), true);

  if v_refusal is not null then
    return jsonb_build_object('outcome', 'refused', 'replay', false, 'refusal', v_refusal);
  end if;
  return jsonb_build_object('outcome', 'placed', 'replay', false,
                            'order', public._order_submission_summary(v_row.id));
end;
$function$;

revoke all on function public.place_order_request(jsonb, text) from public, anon, authenticated, service_role;
grant execute on function public.place_order_request(jsonb, text) to authenticated;

-- ═══ 11. The new-demand gate on order_request_lines ═══════════════════════
create function public.tg_order_request_lines_order_visibility()
returns trigger
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_visible   boolean;
  v_item_org  uuid;
  v_order_org uuid;
begin
  -- Exchange replacement orders carry approved commitments; new replacement
  -- selections are gated where they are chosen (_return_exchange_item_ok).
  -- Only definer code can create such a header or its lines.
  if exists (select 1 from public.order_requests o
              where o.id = new.order_request_id and o.replacement_for_return_id is not null) then
    return new;
  end if;
  -- FOR KEY SHARE: the lock the line's own FK check already takes on this
  -- row, taken at read time so the read and the lock are one step. It waits
  -- for a hide's FOR UPDATE and then reads the committed value.
  select ii.order_catalog_visible, ii.organization_id into v_visible, v_item_org
    from public.inventory_items ii
   where ii.id = new.item_id
     for key share;
  if v_visible is false then
    -- An API-role writer learns "hidden" only for an item it may read in the
    -- order's organization; anything else falls through to the RLS WITH
    -- CHECK of order_request_lines_insert, which refuses it with the 42501
    -- any unreadable or foreign item gets (BEFORE ROW triggers run first).
    -- The API role is read from the role setting: in this SECURITY DEFINER
    -- body current_user is the owner, but the setting PostgREST (or a SET
    -- ROLE) made still names the caller's role.
    if coalesce(current_setting('role', true), 'none') in ('authenticated', 'anon') then
      select o.organization_id into v_order_org
        from public.order_requests o where o.id = new.order_request_id;
      if v_order_org is distinct from v_item_org or not coalesce(public.caller_can_read_item(new.item_id), false) then
        return new;
      end if;
    end if;
    raise exception 'This item is no longer available for new orders.'
      using errcode = 'P0001', hint = 'order_item_hidden', detail = new.item_id::text;
  end if;
  return new;
end;
$$;

revoke all on function public.tg_order_request_lines_order_visibility() from public, anon, authenticated, service_role;

-- Names sort after trg_zz_order_request_lines_guard and
-- trg_zz_order_request_lines_replacement_guard, so their refusals come first
-- and the item lock is taken last.
create trigger trg_zz_order_request_lines_zz_order_visibility
  before insert on public.order_request_lines
  for each row execute function public.tg_order_request_lines_order_visibility();
create trigger trg_zz_order_request_lines_zz_order_visibility_upd
  before update of quantity_requested, item_id on public.order_request_lines
  for each row
  when (new.quantity_requested > old.quantity_requested or new.item_id is distinct from old.item_id)
  execute function public.tg_order_request_lines_order_visibility();

comment on function public.tg_order_request_lines_order_visibility() is
  'The new-demand gate (0413): a new order line, or a raised quantity or changed item, for an item hidden from '
  'ordering is refused (P0001 order_item_hidden, detail = the item id) for every writer: place_order_request, '
  'create_order_request, direct inserts, Add items, top-ups, quantity raises, public links and the portal (no role '
  'skip). Exchange replacement orders are exempt (approved commitments). Reads the item FOR KEY SHARE (the FK '
  'check''s own lock), so it serializes with a hide''s FOR UPDATE. To an API role the refusal is raised only for an '
  'item it may read in the order''s organization; otherwise the insert policy refuses as it does today. SECURITY '
  'DEFINER so the locking read is not narrowed by the writer''s policies.';

-- ═══ 12. Add items in one transaction ═════════════════════════════════════
-- The top-up of a line already on the order. Lines have no UPDATE grant or
-- policy for API roles (0363, 0119), so this is definer code; it re-checks
-- everything Add items checks, because it can be called directly.
create function public._order_request_line_top_up(p_order_id uuid, p_item_id uuid, p_delta integer)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  v_hdr  record;
  v_item record;
  v_line uuid;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
  end if;
  if p_delta is null or p_delta < 1 or p_delta > 20000000 then
    raise exception 'order_lines_invalid' using errcode = '22023', hint = 'order_lines_invalid', detail = 'quantity';
  end if;
  select o.id, o.organization_id, o.warehouse_id, o.status, o.requester_user_id, o.replacement_for_return_id
    into v_hdr
    from public.order_requests o where o.id = p_order_id;
  if v_hdr.id is null or not public.is_org_member(v_hdr.organization_id) then
    raise exception 'order_not_found' using errcode = 'P0002', hint = 'order_not_found';
  end if;
  if v_hdr.replacement_for_return_id is not null then
    raise exception 'replacement_lines_fixed' using errcode = '42501', hint = 'replacement_lines_fixed';
  end if;
  if v_hdr.status in ('in_transit', 'completed', 'denied', 'cancelled') then
    raise exception 'order_closed' using errcode = 'P0001', hint = 'order_closed', detail = v_hdr.status;
  end if;
  if not (v_hdr.requester_user_id is not null and v_hdr.requester_user_id = v_uid)
     and not public.has_permission(v_hdr.organization_id, 'orders:approve') then
    raise exception 'order_edit_forbidden' using errcode = '42501', hint = 'order_edit_forbidden';
  end if;
  if not public.user_can_access_warehouse(v_uid, v_hdr.warehouse_id, 'read') then
    raise exception 'warehouse_read' using errcode = '42501', hint = 'warehouse_read';
  end if;
  select ii.id, ii.organization_id, ii.warehouse_id, ii.deleted_at, ii.awaiting_first_receipt, ii.is_rental, ii.is_bundle
    into v_item
    from public.inventory_items ii where ii.id = p_item_id;
  if v_item.id is null or v_item.organization_id <> v_hdr.organization_id
     or not coalesce(public.caller_can_read_item(p_item_id), false) then
    raise exception 'order_item_not_addable' using errcode = 'P0001', hint = 'order_item_not_addable',
      detail = jsonb_build_object('itemId', p_item_id, 'reason', 'not_found')::text;
  end if;
  if v_item.warehouse_id is distinct from v_hdr.warehouse_id then
    raise exception 'order_item_not_addable' using errcode = 'P0001', hint = 'order_item_not_addable',
      detail = jsonb_build_object('itemId', p_item_id, 'reason', 'other_warehouse')::text;
  end if;
  if v_item.deleted_at is not null then
    raise exception 'order_item_not_addable' using errcode = 'P0001', hint = 'order_item_not_addable',
      detail = jsonb_build_object('itemId', p_item_id, 'reason', 'deleted')::text;
  end if;
  if coalesce(v_item.awaiting_first_receipt, false) then
    raise exception 'order_item_not_addable' using errcode = 'P0001', hint = 'order_item_not_addable',
      detail = jsonb_build_object('itemId', p_item_id, 'reason', 'awaiting_first_receipt')::text;
  end if;
  if coalesce(v_item.is_rental, false) then
    raise exception 'order_item_not_addable' using errcode = 'P0001', hint = 'order_item_not_addable',
      detail = jsonb_build_object('itemId', p_item_id, 'reason', 'rental')::text;
  end if;
  if coalesce(v_item.is_bundle, false) then
    raise exception 'order_item_not_addable' using errcode = 'P0001', hint = 'order_item_not_addable',
      detail = jsonb_build_object('itemId', p_item_id, 'reason', 'kit')::text;
  end if;
  -- One line per item is what Add items writes; should an older order hold
  -- two, the oldest is topped up (deterministic).
  select l.id into v_line
    from public.order_request_lines l
   where l.order_request_id = p_order_id and l.item_id = p_item_id
   order by l.created_at, l.id
   limit 1;
  if v_line is null then
    raise exception 'order_line_not_found' using errcode = 'P0002', hint = 'order_line_not_found';
  end if;
  -- The gate's UPDATE trigger fires here (no role skip): a hidden item is
  -- refused with order_item_hidden.
  update public.order_request_lines l
     set quantity_requested = l.quantity_requested + p_delta
   where l.id = v_line;
end;
$$;

revoke all on function public._order_request_line_top_up(uuid, uuid, integer) from public, anon, authenticated, service_role;
-- add_order_request_lines is SECURITY INVOKER and calls this as the caller.
grant execute on function public._order_request_line_top_up(uuid, uuid, integer) to authenticated;

comment on function public._order_request_line_top_up(uuid, uuid, integer) is
  'Add items'' top-up of a line already on the order (0413), called by add_order_request_lines in the same '
  'transaction. SECURITY DEFINER (lines have no UPDATE grant for API roles), so it re-checks everything itself: '
  'signed in, a member, the order not a replacement (replacement_lines_fixed) and not shipped or closed '
  '(order_closed), the caller its requester or holding orders:approve (order_edit_forbidden), read access to its '
  'warehouse (warehouse_read), the item readable, in the order''s warehouse, not deleted, Expected, a rental or a kit '
  '(order_item_not_addable), delta 1 to 20,000,000. The order-visibility gate fires on its UPDATE. EXECUTE to '
  'authenticated only.';

create function public.add_order_request_lines(p_order_id uuid, p_lines jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  c_uuid    constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_uid     uuid := auth.uid();
  v_hdr     record;
  v_wanted  jsonb;
  v_ids     uuid[];
  v_missing uuid;
  v_item    uuid;
  v_existing uuid[];
  v_added   uuid[] := '{}';
  v_merged  uuid[] := '{}';
  r         record;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
  end if;

  -- ── Shape: 1 to 200 entries, each {itemId: uuid, quantity: whole 1 to
  -- 100,000}; entries of one item are summed (the service's rule) ─────────
  if p_lines is null or jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) < 1 or jsonb_array_length(p_lines) > 200 then
    raise exception 'order_lines_invalid' using errcode = '22023', hint = 'order_lines_invalid', detail = 'lines';
  end if;
  if exists (select 1 from jsonb_array_elements(p_lines) as e(l)
              where case
                      when jsonb_typeof(l) <> 'object' then true
                      when jsonb_typeof(l->'itemId') is distinct from 'string' then true
                      else (l->>'itemId') !~ c_uuid
                    end) then
    raise exception 'order_lines_invalid' using errcode = '22023', hint = 'order_lines_invalid', detail = 'lines';
  end if;
  if exists (select 1 from jsonb_array_elements(p_lines) as e(l)
              where case
                      when jsonb_typeof(l->'quantity') is distinct from 'number' then true
                      else (l->>'quantity')::numeric < 1 or (l->>'quantity')::numeric > 100000
                           or (l->>'quantity')::numeric <> trunc((l->>'quantity')::numeric)
                    end) then
    raise exception 'order_lines_invalid' using errcode = '22023', hint = 'order_lines_invalid', detail = 'quantity';
  end if;
  select jsonb_object_agg(s.item::text, s.q), array_agg(s.item order by s.item)
    into v_wanted, v_ids
    from (select (l->>'itemId')::uuid as item, sum((l->>'quantity')::numeric)::integer as q
            from jsonb_array_elements(p_lines) as e(l) group by 1) s;

  -- ── The order, under the caller's RLS (loadEditableOrderHeader's rules) ──
  select o.id, o.organization_id, o.warehouse_id, o.status, o.requester_user_id, o.replacement_for_return_id
    into v_hdr
    from public.order_requests o where o.id = p_order_id;
  if v_hdr.id is null then
    raise exception 'order_not_found' using errcode = 'P0002', hint = 'order_not_found';
  end if;
  if v_hdr.replacement_for_return_id is not null then
    raise exception 'replacement_lines_fixed' using errcode = '42501', hint = 'replacement_lines_fixed';
  end if;
  if not public.module_enabled(v_hdr.organization_id, 'orders') then
    raise exception 'module_disabled' using errcode = '42501', hint = 'module_disabled';
  end if;
  if v_hdr.status in ('in_transit', 'completed', 'denied', 'cancelled') then
    raise exception 'order_closed' using errcode = 'P0001', hint = 'order_closed', detail = v_hdr.status;
  end if;
  if not (v_hdr.requester_user_id is not null and v_hdr.requester_user_id = v_uid)
     and not public.has_permission(v_hdr.organization_id, 'orders:approve') then
    raise exception 'order_edit_forbidden' using errcode = '42501', hint = 'order_edit_forbidden';
  end if;
  if not public.user_can_access_warehouse(v_uid, v_hdr.warehouse_id, 'read') then
    raise exception 'warehouse_read' using errcode = '42501', hint = 'warehouse_read';
  end if;

  -- ── Every item, under the caller's RLS, before anything is written ───────
  select u.id into v_missing
    from unnest(v_ids) as u(id)
   where not exists (select 1 from public.inventory_items ii
                      where ii.id = u.id and ii.organization_id = v_hdr.organization_id)
   order by u.id
   limit 1;
  if v_missing is not null then
    raise exception 'order_item_not_addable' using errcode = 'P0001', hint = 'order_item_not_addable',
      detail = jsonb_build_object('itemId', v_missing, 'reason', 'not_found')::text;
  end if;
  for r in
    select ii.id, ii.warehouse_id, ii.deleted_at, ii.awaiting_first_receipt, ii.is_rental, ii.is_bundle,
           ii.order_catalog_visible
      from public.inventory_items ii
     where ii.id = any (v_ids)
     order by ii.id
  loop
    if r.warehouse_id is distinct from v_hdr.warehouse_id then
      raise exception 'order_item_not_addable' using errcode = 'P0001', hint = 'order_item_not_addable',
        detail = jsonb_build_object('itemId', r.id, 'reason', 'other_warehouse')::text;
    end if;
    if r.deleted_at is not null then
      raise exception 'order_item_not_addable' using errcode = 'P0001', hint = 'order_item_not_addable',
        detail = jsonb_build_object('itemId', r.id, 'reason', 'deleted')::text;
    end if;
    if coalesce(r.awaiting_first_receipt, false) then
      raise exception 'order_item_not_addable' using errcode = 'P0001', hint = 'order_item_not_addable',
        detail = jsonb_build_object('itemId', r.id, 'reason', 'awaiting_first_receipt')::text;
    end if;
    if coalesce(r.is_rental, false) then
      raise exception 'order_item_not_addable' using errcode = 'P0001', hint = 'order_item_not_addable',
        detail = jsonb_build_object('itemId', r.id, 'reason', 'rental')::text;
    end if;
    if coalesce(r.is_bundle, false) then
      raise exception 'order_item_not_addable' using errcode = 'P0001', hint = 'order_item_not_addable',
        detail = jsonb_build_object('itemId', r.id, 'reason', 'kit')::text;
    end if;
    if not r.order_catalog_visible then
      raise exception 'This item is no longer available for new orders.'
        using errcode = 'P0001', hint = 'order_item_hidden', detail = r.id::text;
    end if;
  end loop;

  -- ── Writes, one item at a time in id order (the gate fires in each) ──────
  v_existing := array(select distinct l.item_id from public.order_request_lines l
                       where l.order_request_id = p_order_id);
  foreach v_item in array v_ids loop
    if v_item = any (v_existing) then
      perform public._order_request_line_top_up(p_order_id, v_item, (v_wanted->>v_item::text)::integer);
      v_merged := v_merged || v_item;
    else
      insert into public.order_request_lines (order_request_id, item_id, quantity_requested, unit_cost_at_request)
      select p_order_id, ii.id, (v_wanted->>v_item::text)::integer, coalesce(ii.unit_cost, 0)
        from public.inventory_items ii where ii.id = v_item;
      v_added := v_added || v_item;
    end if;
  end loop;

  return jsonb_build_object('orderId', p_order_id, 'added', to_jsonb(v_added), 'merged', to_jsonb(v_merged));
end;
$$;

revoke all on function public.add_order_request_lines(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.add_order_request_lines(uuid, jsonb) to authenticated;

comment on function public.add_order_request_lines(uuid, jsonb) is
  'Add items to an existing order in ONE transaction (0413). p_lines [{itemId, quantity}], 1 to 200 entries, whole '
  'quantities 1 to 100,000, entries of one item summed (22023 order_lines_invalid, detail the field). The order read '
  'under the caller''s RLS: P0002 order_not_found, 42501 replacement_lines_fixed, module_disabled, P0001 order_closed '
  '(detail the status), 42501 order_edit_forbidden (requester or orders:approve), warehouse_read. Every item read '
  'under the caller''s RLS first: P0001 order_item_not_addable (detail {itemId, reason: not_found | other_warehouse | '
  'deleted | awaiting_first_receipt | rental | kit}) or order_item_hidden (detail the id). Then item-id order: a top-up '
  'through _order_request_line_top_up, or an insert as the caller (the insert policy and every line guard apply). The '
  'gate refuses a hide that committed meanwhile, and the whole call rolls back: nothing partial. Answers {orderId, '
  'added, merged}. SECURITY INVOKER, lock_timeout 5s (55P03 busy, nothing written); EXECUTE to authenticated only.';

-- ═══ 13. Public links: hidden items are not eligible ══════════════════════
CREATE OR REPLACE FUNCTION public.public_link_eligible_items(p_link_id uuid, p_warehouse_id uuid)
 RETURNS TABLE(item_id uuid, max_qty integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select i.id as item_id,
         coalesce(e.max_qty_per_request, l.default_max_qty) as max_qty
  from public.public_request_links l
  join public.inventory_items i
    on i.organization_id = l.organization_id
  join public.warehouses w
    on w.id = i.warehouse_id
   and w.organization_id = l.organization_id
  left join public.categories c
    on c.id = i.category_id
  left join public.public_link_catalog_entries e
    on e.link_id = l.id
   and e.item_id = i.id
  where l.id = p_link_id
    and l.active
    and (l.expires_at is null or l.expires_at > now())
    and (l.available_from is null or l.available_from <= now())
    and (l.available_until is null or l.available_until >= now())
    and i.warehouse_id = p_warehouse_id
    and w.is_public_orderable
    and i.status = 'active'
    and i.deleted_at is null
    and i.public_visibility <> 'hidden'
    and not i.awaiting_first_receipt
    -- 0413: an item hidden from ordering is on no public link (page or submit).
    and i.order_catalog_visible
    and (   (i.item_type =  'book' and l.books_enabled)
         or (i.item_type <> 'book' and l.items_enabled) )
    and (
      e.item_id is not null
      or (
        l.include_public_pool
        and i.public_visibility = 'public'
        and (i.category_id is null or c.public_visibility = 'public')
      )
    )
$function$;

revoke all on function public.public_link_eligible_items(uuid, uuid) from public, anon, authenticated;
grant execute on function public.public_link_eligible_items(uuid, uuid) to service_role;

-- ═══ 14. Exchanges: new selections follow ordering visibility ═════════════
CREATE OR REPLACE FUNCTION public._return_exchange_requester_options(p_order_id uuid, p_check_budget boolean)
 RETURNS TABLE(order_request_line_id uuid, returned_item_id uuid, item_id uuid, variant_key text, free numeric)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_org      uuid;
  v_wh       uuid;
  v_status   text;
  v_source   text;
  v_customer uuid;
  v_portal   boolean := false;
begin
  select o.organization_id, o.warehouse_id, o.status, o.source, o.customer_id
    into v_org, v_wh, v_status, v_source, v_customer
    from public.order_requests o where o.id = p_order_id;
  if v_org is null or v_status not in ('completed', 'delivered') then
    return;
  end if;
  if v_source = 'portal' then
    if v_customer is null or not exists (select 1 from public.customers c
                                          where c.id = v_customer and c.organization_id = v_org and c.status = 'active') then
      return;
    end if;
    v_portal := true;
  end if;

  return query
  with src as (
    select l.id as line_id, ri.id as rid, ri.group_id, ri.variant_key as rkey, ri.charter_id as rcharter
      from public.order_request_lines l
      join public.inventory_items ri on ri.id = l.item_id
      join public.product_groups g on g.id = ri.group_id
     where l.order_request_id = p_order_id
       and g.organization_id = v_org and g.deleted_at is null and g.status = 'active'
       and (not p_check_budget
            or coalesce(l.quantity_fulfilled, 0) - coalesce(l.returned_quantity, 0)
               - coalesce((select sum(rl.quantity) from public.return_lines rl
                             join public.returns r on r.id = rl.return_id
                            where rl.order_request_line_id = l.id and not rl.applied
                              and r.status not in ('cancelled', 'denied')), 0) > 0)
  ), cand as (
    select s.line_id, s.rid, c.id as cid, c.variant_key as ckey,
           c.quantity_on_hand - coalesce((select sum(sr.quantity) from public.stock_reservations sr
                                           where sr.item_id = c.id and sr.released_at is null), 0) as cfree
      from src s
      join public.inventory_items c on c.group_id = s.group_id
     where c.organization_id = v_org
       and c.id <> s.rid
       and c.variant_key is distinct from s.rkey
       and c.warehouse_id = v_wh
       and c.charter_id is not distinct from s.rcharter
       and c.deleted_at is null
       and c.status = 'active'
       and not coalesce(c.awaiting_first_receipt, false)
       and not coalesce(c.is_rental, false)
       and not coalesce(c.is_bundle, false)
       and c.public_visibility <> 'hidden'
       -- 0413: an item hidden from ordering is no new selection (applied
       -- before the per-variant representative is chosen).
       and c.order_catalog_visible
       and (not v_portal or exists (select 1 from public.customer_catalog cc
                                     where cc.customer_id = v_customer and cc.item_id = c.id))
  )
  select distinct on (cand.line_id, coalesce(cand.ckey, cand.cid::text))
         cand.line_id, cand.rid, cand.cid, cand.ckey, cand.cfree
    from cand
   order by cand.line_id, coalesce(cand.ckey, cand.cid::text), cand.cfree desc, cand.cid;
end;
$function$;

CREATE OR REPLACE FUNCTION public._return_exchange_item_ok(p_order_id uuid, p_item_id uuid, p_tier text, p_order_line_id uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_org uuid;
  v_wh  uuid;
begin
  if p_order_id is null or p_item_id is null then
    return false;
  end if;
  select o.organization_id, o.warehouse_id into v_org, v_wh
    from public.order_requests o where o.id = p_order_id;
  if v_org is null then
    return false;
  end if;
  if p_tier = 'staff' then
    if not exists (select 1 from public.inventory_items ii where ii.id = p_item_id and ii.organization_id = v_org) then
      return false;
    end if;
    if public.order_items_orderable(v_wh, array[p_item_id]) <> '{}'::jsonb then
      return false;
    end if;
    -- 0413: an item hidden from ordering is no new staff selection. An item
    -- an EARLIER transaction approved for a return of this order (a re-issue,
    -- or an unchanged line of a change) is an existing commitment and passes.
    if not exists (select 1 from public.inventory_items ii
                    where ii.id = p_item_id and ii.order_catalog_visible)
       and not exists (select 1 from public.return_exchange_lines xl
                         join public.returns r on r.id = xl.return_id
                        where r.order_request_id = p_order_id
                          and xl.approved_item_id = p_item_id
                          and xl.status in ('approved', 'cancelled')
                          and xl.approved_at < now()) then
      return false;
    end if;
    return coalesce(public.caller_can_read_item(p_item_id), false);
  elsif p_tier = 'requester' then
    return p_order_line_id is not null and exists (
      select 1 from public._return_exchange_requester_options(p_order_id, false) o
       where o.order_request_line_id = p_order_line_id and o.item_id = p_item_id);
  end if;
  return false;
end;
$function$;

CREATE OR REPLACE FUNCTION public.return_exchange_candidates(p_order_id uuid, p_order_request_line_id uuid, p_query text DEFAULT NULL::text, p_limit integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_user    uuid := auth.uid();
  v_org     uuid;
  v_wh      uuid;
  v_item    uuid;
  v_group   uuid;
  v_q       text := nullif(btrim(coalesce(p_query, '')), '');
  v_like    text;
  v_limit   integer := least(greatest(coalesce(p_limit, 30), 1), 30);
  v_sib     jsonb;
  v_hits    jsonb := '[]'::jsonb;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
  end if;
  select o.organization_id, o.warehouse_id into v_org, v_wh from public.order_requests o where o.id = p_order_id;
  if v_org is null then
    raise exception 'order_not_found' using errcode = 'P0002', hint = 'order_not_found';
  end if;
  if not public.has_permission(v_org, 'returns:manage') then
    raise exception 'returns_manage' using errcode = '42501', hint = 'returns_manage';
  end if;
  select l.item_id into v_item
    from public.order_request_lines l
   where l.id = p_order_request_line_id and l.order_request_id = p_order_id;
  if v_item is null then
    raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'orderRequestLineId';
  end if;
  select ii.group_id into v_group
    from public.inventory_items ii
    join public.product_groups g on g.id = ii.group_id
   where ii.id = v_item and g.organization_id = v_org and g.deleted_at is null and g.status = 'active';

  with c as (
    select ii.id, ii.name, ii.sku, ii.variant_size, ii.variant_key, ii.group_id, ii.quantity_on_hand,
           coalesce((select sum(sr.quantity) from public.stock_reservations sr
                      where sr.item_id = ii.id and sr.released_at is null), 0) as held
      from public.inventory_items ii
     where v_group is not null and ii.group_id = v_group and ii.organization_id = v_org
       and ii.warehouse_id = v_wh and ii.deleted_at is null and ii.status = 'active'
       and not coalesce(ii.is_rental, false) and not coalesce(ii.awaiting_first_receipt, false)
       and not coalesce(ii.is_bundle, false)
       and ii.order_catalog_visible  -- 0413: hidden from ordering is no new selection
     order by ii.variant_size nulls last, ii.name, ii.id
     limit 60)
  select coalesce(jsonb_agg(jsonb_build_object(
           'itemId', c.id, 'name', c.name, 'sku', c.sku, 'variantSize', c.variant_size, 'variantKey', c.variant_key,
           'groupId', c.group_id, 'sibling', true, 'isReturnedItem', c.id = v_item,
           'onHand', trim_scale(c.quantity_on_hand), 'held', trim_scale(c.held),
           'free', trim_scale(greatest(c.quantity_on_hand - c.held, 0)))), '[]'::jsonb)
    into v_sib
    from c;

  if v_q is not null and length(v_q) >= 2 then
    v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    with c as (
      select ii.id, ii.name, ii.sku, ii.variant_size, ii.variant_key, ii.group_id, ii.quantity_on_hand,
             coalesce((select sum(sr.quantity) from public.stock_reservations sr
                        where sr.item_id = ii.id and sr.released_at is null), 0) as held
        from public.inventory_items ii
       where ii.organization_id = v_org and ii.warehouse_id = v_wh
         and ii.deleted_at is null and ii.status = 'active'
         and not coalesce(ii.is_rental, false) and not coalesce(ii.awaiting_first_receipt, false)
         and not coalesce(ii.is_bundle, false)
         and ii.order_catalog_visible  -- 0413: hidden from ordering is no new selection
         and (ii.name ilike v_like or ii.sku ilike v_like)
         and (v_group is null or ii.group_id is distinct from v_group)
       order by ii.name, ii.id
       limit v_limit)
    select coalesce(jsonb_agg(jsonb_build_object(
             'itemId', c.id, 'name', c.name, 'sku', c.sku, 'variantSize', c.variant_size, 'variantKey', c.variant_key,
             'groupId', c.group_id, 'sibling', false, 'isReturnedItem', c.id = v_item,
             'onHand', trim_scale(c.quantity_on_hand), 'held', trim_scale(c.held),
             'free', trim_scale(greatest(c.quantity_on_hand - c.held, 0)))), '[]'::jsonb)
      into v_hits
      from c;
  end if;

  return jsonb_build_object('orderId', p_order_id, 'orderRequestLineId', p_order_request_line_id,
                            'returnedItemId', v_item, 'groupId', v_group,
                            'siblings', v_sib, 'matches', v_hits);
end;
$function$;

revoke all on function public._return_exchange_requester_options(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public._return_exchange_item_ok(uuid, uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.return_exchange_candidates(uuid, uuid, text, integer) from public, anon, authenticated, service_role;
grant execute on function public.return_exchange_candidates(uuid, uuid, text, integer) to authenticated;

-- ═══ 15. Duplicate keeps the source's choice ══════════════════════════════
CREATE OR REPLACE FUNCTION public.duplicate_inventory_item(p_original_id uuid, p_overrides jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_new_id uuid := gen_random_uuid();
  v_original public.inventory_items%rowtype;
  v_qty numeric := coalesce((p_overrides->>'quantity')::numeric, 0);
  v_new_sku text := nullif(p_overrides->>'sku', '');
  v_new_bin text := nullif(p_overrides->>'bin_location', '');
  v_new_cf jsonb;
  v_uid uuid := auth.uid();
  v_variant_size text;
  v_variant_size_original text;
  v_variant_size_system text;
  v_variant_width text;
  v_variant_fit text;
  v_variant_color text;
  v_jersey_number text;
  v_player_name text;
  v_variant_key text;
begin
  -- Defense-in-depth: function is only granted to `authenticated`, but
  -- a service_role/anomalous context would silently produce a NULL
  -- audit trail otherwise. Surface a clear error instead.
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  -- Load + lock the original row. RLS scopes this to the caller's
  -- accessible warehouses, so a cross-warehouse caller hits not-found
  -- here rather than ever reading the source row.
  select * into v_original
  from public.inventory_items
  where id = p_original_id and deleted_at is null
  for share;

  if not found then
    raise exception 'original_not_found' using errcode = 'P0002';
  end if;
  if v_new_sku is null then
    raise exception 'sku_required' using errcode = '22023';
  end if;

  -- LEDGER GUARD (added in the final whole-branch review). This RPC is granted
  -- to `authenticated`, so it is reachable DIRECTLY at
  -- POST /rest/v1/rpc/duplicate_inventory_item with a hand-written p_overrides —
  -- the service layer is the only SANCTIONED caller, not the only POSSIBLE one
  -- (see the note under the grants at the foot of this file).
  --
  -- A negative quantity breaks the app's central invariant. The INSERT below
  -- writes quantity_on_hand = v_qty unconditionally, but the stock_movements row
  -- is only written `if v_qty > 0`, so p_overrides = {"quantity": -5} produces an
  -- item at -5 on hand with an EMPTY ledger:
  -- SUM(stock_movements.quantity_change) = 0 <> quantity_on_hand = -5. Nothing
  -- else stops it — quantity_on_hand is `numeric(14,4) not null default 0` with
  -- no CHECK (0002:95), and the 0125 original had the same hole.
  --
  -- Refuse rather than clamp: silently turning -5 into 0 would hand back an id
  -- for a row the caller did not ask for. Zero is still allowed — a duplicate
  -- with no stock is the normal case and writes no movement row, which balances.
  if v_qty < 0 then
    raise exception 'quantity_must_not_be_negative' using errcode = '22023';
  end if;

  -- Variant attributes: an override wins, otherwise inherit the original.
  -- Keyed on `p_overrides ? 'key'` rather than coalesce so an explicit JSON
  -- null CLEARS the field instead of silently inheriting it.
  v_variant_size := case when p_overrides ? 'variant_size'
    then nullif(p_overrides->>'variant_size', '') else v_original.variant_size end;
  v_variant_size_original := case when p_overrides ? 'variant_size_original'
    then nullif(p_overrides->>'variant_size_original', '')
    else v_original.variant_size_original end;
  v_variant_size_system := case when p_overrides ? 'variant_size_system'
    then nullif(p_overrides->>'variant_size_system', '')
    else v_original.variant_size_system end;
  v_variant_width := case when p_overrides ? 'variant_width'
    then nullif(p_overrides->>'variant_width', '') else v_original.variant_width end;
  v_variant_fit := case when p_overrides ? 'variant_fit'
    then nullif(p_overrides->>'variant_fit', '') else v_original.variant_fit end;
  v_variant_color := case when p_overrides ? 'variant_color'
    then nullif(p_overrides->>'variant_color', '') else v_original.variant_color end;
  v_jersey_number := case when p_overrides ? 'jersey_number'
    then nullif(p_overrides->>'jersey_number', '') else v_original.jersey_number end;
  v_player_name := case when p_overrides ? 'player_name'
    then nullif(p_overrides->>'player_name', '') else v_original.player_name end;
  -- Never read variant_key from p_overrides (client-forgeable identity).
  v_variant_key := case
    when p_overrides ?| array['variant_size','variant_size_system','variant_width',
                              'variant_fit','variant_color','jersey_number']
      then null
    else v_original.variant_key
  end;

  -- Compose custom_fields: copy original blob, then overwrite the
  -- location keys (items vs books branch).
  v_new_cf := coalesce(v_original.custom_fields, '{}'::jsonb);
  if v_original.item_type = 'book' then
    v_new_cf := (v_new_cf
                 - 'book_rack_number'
                 - 'book_rack_row'
                 - 'book_crate_color'
                 - 'book_crate_number')
                || jsonb_strip_nulls(jsonb_build_object(
                     'book_rack_number',  p_overrides->>'book_rack_number',
                     'book_rack_row',     p_overrides->>'book_rack_row',
                     'book_crate_color',  p_overrides->>'book_crate_color',
                     'book_crate_number', p_overrides->>'book_crate_number'
                   ));
  else
    v_new_cf := (v_new_cf - 'rack_number' - 'rack_row')
                || jsonb_strip_nulls(jsonb_build_object(
                     'rack_number', p_overrides->>'rack_number',
                     'rack_row',    p_overrides->>'rack_row'
                   ));
  end if;

  -- Keep custom_fields.size in step with the first-class column during the
  -- dual-write window (migration 0302 backfills variant_size FROM this key):
  --   * a resolved size writes the key;
  --   * an EXPLICIT clear (p_overrides carries "variant_size": null) removes
  --     it, so the copy never keeps a size the column says it does not have;
  --   * a legacy row - no override, column already null - is LEFT ALONE, so a
  --     pre-0302 item whose only size lives in custom_fields.size does not
  --     lose it on duplicate.
  if v_variant_size is not null then
    v_new_cf := v_new_cf || jsonb_build_object('size', v_variant_size);
  elsif p_overrides ? 'variant_size' then
    v_new_cf := v_new_cf - 'size';
  end if;

  insert into public.inventory_items (
    id, organization_id, warehouse_id, charter_id, sku, barcode,
    name, description, category_id, supplier_id, primary_location_id,
    unit_cost, retail_price, quantity_on_hand, reorder_point,
    reorder_quantity, unit_of_measure, bin_location, tracking_type,
    item_type, custom_fields, status, created_by, updated_by,
    -- Pre-existing gaps closed by this migration:
    model_number, is_rental, shelf_life_days, expiry_policy,
    -- Phase 3 variant columns:
    group_id, variant_size, variant_size_original, variant_size_system,
    variant_width, variant_fit, variant_color, jersey_number, player_name,
    variant_key,
    -- 0413: the copy keeps the source's ordering visibility (a copy of a
    -- hidden item is hidden; public_visibility is still not copied).
    order_catalog_visible
  ) values (
    v_new_id, v_original.organization_id, v_original.warehouse_id,
    v_original.charter_id, v_new_sku, v_original.barcode,
    v_original.name, v_original.description, v_original.category_id,
    v_original.supplier_id, v_original.primary_location_id,
    v_original.unit_cost, v_original.retail_price, v_qty,
    v_original.reorder_point, v_original.reorder_quantity,
    v_original.unit_of_measure, v_new_bin, v_original.tracking_type,
    v_original.item_type, v_new_cf, v_original.status, v_uid, v_uid,
    v_original.model_number, v_original.is_rental,
    v_original.shelf_life_days, v_original.expiry_policy,
    v_original.group_id, v_variant_size, v_variant_size_original,
    v_variant_size_system, v_variant_width, v_variant_fit, v_variant_color,
    v_jersey_number, v_player_name, v_variant_key,
    v_original.order_catalog_visible
  );

  -- item_tags: parallel rows for every original tag.
  insert into public.item_tags (item_id, tag_id)
  select v_new_id, tag_id
  from public.item_tags
  where item_id = p_original_id;

  -- item_images: parallel rows pointing at the SAME storage_path / thumb.
  insert into public.item_images (
    organization_id, item_id, storage_path, thumb_path, lqip,
    alt, sort_order, is_primary
  )
  select v_original.organization_id, v_new_id, storage_path, thumb_path,
         lqip, alt, sort_order, is_primary
  from public.item_images
  where item_id = p_original_id;

  -- Initial stock movement when qty > 0 so the ledger + dashboard
  -- sparklines see the new on-hand value.
  if v_qty > 0 then
    insert into public.stock_movements (
      organization_id, item_id, movement_type, quantity_change,
      previous_quantity, new_quantity, user_id, to_location_id, reason,
      reference_type, reference_id
    ) values (
      v_original.organization_id, v_new_id, 'initial', v_qty,
      0, v_qty, v_uid, v_original.primary_location_id,
      'duplicate_initial_count',
      'duplicate', p_original_id
    );
  end if;

  return v_new_id;
end;
$function$;

revoke all on function public.duplicate_inventory_item(uuid, jsonb) from public;
revoke all on function public.duplicate_inventory_item(uuid, jsonb) from anon;
grant execute on function public.duplicate_inventory_item(uuid, jsonb) to authenticated;

-- ═══ 16. The request context carries the hide mark ════════════════════════
CREATE OR REPLACE FUNCTION public.get_request_context()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select jsonb_build_object(
    'user_id', auth.uid(),
    'profile', (
      select jsonb_build_object(
               'id', p.id,
               'email', p.email,
               'full_name', p.full_name,
               'avatar_url', p.avatar_url,
               'default_organization_id', p.default_organization_id,
               'disabled_at', p.disabled_at)
        from public.user_profiles p
       where p.id = auth.uid()
    ),
    'memberships', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'organization_id', m.organization_id,
                 'role', m.role,
                 'organization', (
                   select jsonb_build_object(
                            'id', o.id,
                            'name', o.name,
                            'logo_url', o.logo_url,
                            'terminology', o.terminology,
                            'mfa_policy', o.mfa_policy,
                            'timezone', o.timezone,
                            'nav_overrides', o.nav_overrides,
                            'dashboard_layout', o.dashboard_layout,
                            'order_status_config', o.order_status_config,
                            'all_modules_comp', o.all_modules_comp,
                            -- 0413: lets catalog loads skip the freshness query.
                            'order_catalog_last_hide_at', o.order_catalog_last_hide_at)
                     from public.organizations o
                    where o.id = m.organization_id),
                 'role_overrides', coalesce((
                   select jsonb_agg(jsonb_build_object('permission', r.permission, 'granted', r.granted)
                                    order by r.permission)
                     from public.role_permission_overrides r
                    where r.organization_id = m.organization_id
                      and r.role = m.role), '[]'::jsonb),
                 'user_overrides', coalesce((
                   select jsonb_agg(jsonb_build_object('permission', u.permission, 'granted', u.granted)
                                    order by u.permission)
                     from public.user_permission_overrides u
                    where u.organization_id = m.organization_id
                      and u.user_id = m.user_id), '[]'::jsonb),
                 'enabled_modules', coalesce((
                   select jsonb_agg(om.module_id order by om.module_id)
                     from public.organization_modules om
                    where om.organization_id = m.organization_id
                      and om.enabled), '[]'::jsonb)
               )
               order by m.created_at, m.organization_id)
        from public.organization_members m
       where m.user_id = auth.uid()
         and m.accepted_at is not null
    ), '[]'::jsonb)
  );
$function$;

revoke all on function public.get_request_context() from public;
revoke all on function public.get_request_context() from anon;
grant execute on function public.get_request_context() to authenticated;
grant execute on function public.get_request_context() to service_role;
