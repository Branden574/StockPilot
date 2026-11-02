-- 0423_po_write_scope.sql
--
-- Purchase order reads go by purchase_orders_select alone, and purchase order
-- writes stay inside the writer's warehouses and need 'View purchase orders'
-- (docket S46). DB-only: no row is written, no table, view or sequence is
-- created, and every table grant stays as it is.
--
-- ── WHAT WAS WRONG ─────────────────────────────────────────────────────────
--   1. purchase_orders_write (0140, FOR ALL to authenticated; USING and WITH
--      CHECK last set by 0208) admitted a manager or anyone holding
--      purchase_orders:manage, with no warehouse term and no read term. A FOR
--      ALL policy's USING also answers SELECT, and permissive policies OR
--      together, so it widened purchase_orders_select (0322: membership AND
--      purchase_orders:read AND, below manager, the destination's warehouse)
--      for everyone it admitted:
--        * staff and viewers holding purchase_orders:manage read every
--          warehouse's purchase orders (the phone's Purchase orders list and
--          POs tab, and the Data API) and, through the Data API, created
--          drafts for any warehouse and cancelled, placed (under the approval
--          threshold), sent back to draft, renamed, re-noted or redirected
--          any warehouse's purchase order;
--        * a manager or admin whose purchase_orders:read was revoked still
--          read every purchase order (the phone's POs tab) and received them
--          (post_receipt_v2 reads its purchase order through this policy);
--        * anyone holding manage without read read and wrote them all.
--      The web refused all of these: it applies the read permission and the
--      warehouse rule itself. The security invariants carried it as a known
--      gap (allowlist G of INV-35, "deferred to 0372").
--   2. purchase_order_items_write had the same FOR ALL shape and floor. It
--      widened no read (purchase_order_items_select is member-wide), and
--      tg_purchase_order_items_guard (0366) already refuses a line update
--      outside the receipt functions and a line under another organization's
--      purchase order. What was left: adding lines to, or removing lines
--      from, another warehouse's draft through the Data API.
--   3. next_po_number (0350, SECURITY INVOKER) counts the purchase orders the
--      caller can read. Narrowing the reads alone would make a writer limited
--      to some warehouses draw a number already in use, and their create
--      would fail on purchase_orders_org_ponumber_active_key (23505).
--
-- ── WHAT THIS MIGRATION DOES ───────────────────────────────────────────────
--   1. next_po_number becomes plpgsql, STABLE, SECURITY DEFINER (search_path
--      public), so it counts every purchase order of the organization
--      whatever the caller may read, and answers the same number as before:
--      'PO-' || year || '-' || (count + 1) padded to four digits. Its own
--      gate: a signed-in caller must be a manager or hold
--      purchase_orders:manage, else 42501, so the count tells an outsider
--      nothing; the service role (no auth.uid(): the crons) passes. The gate
--      is manager OR manage, not read, so an approver of a PO import (still
--      manage-gated, see below) draws a real number. EXECUTE stays with
--      authenticated and service_role only. It comes first and takes no table
--      lock, so numbering never sees narrowed reads without the definer
--      count.
--   2. purchase_orders_write is replaced by purchase_orders_insert (WITH
--      CHECK) and purchase_orders_update (USING and WITH CHECK). Each needs:
--        * a manager or purchase_orders:manage (0208's floor);
--        * purchase_orders:read in the organization (the
--          rls_orgs_with_permission term purchase_orders_select uses), so a
--          writer who may not read is refused instead of writing blind, and a
--          revoke of it binds managers and admins (owners always hold it);
--        * 0322's warehouse rule, copied from purchase_orders_select: a
--          manager, or no destination, or a destination in no warehouse or in
--          one of the caller's (my_warehouse_ids), so a writer changes exactly
--          the purchase orders they can read. On UPDATE the WITH CHECK applies
--          it to the new row too, so a purchase order cannot be redirected out
--          of the writer's warehouses. A purchase order with no warehouse
--          stays readable and writable below manager, as 0322 reads it;
--        * in each WITH CHECK, 0208's organization checks (location_in_org,
--          charter_in_org, supplier_in_org), unchanged.
--      No FOR ALL and no DELETE policy: DELETE is revoked from authenticated
--      (0360), and with no permissive DELETE policy even a future grant fails
--      closed. purchase_orders_select is untouched and is the only read gate.
--   3. purchase_order_items_write is replaced by purchase_order_items_insert,
--      _update and _delete: the same floor, and the parent purchase order
--      readable by the caller (an EXISTS that reads purchase_orders under the
--      caller's row security, so exactly purchase_orders_select; no
--      warehouse logic is repeated). The line guard keeps the draft, item and
--      amount rules; the UPDATE policy matters only to the receipt functions,
--      which update lines as the caller under the ledger flag.
--      purchase_order_items_select is untouched (docket S10 5.1).
--   4. A comment on each of the five policies and on the function. When the
--      receiving checklist (0419) is in, checklist_runs_select's comment is
--      restated: a run follows purchase_orders_select alone now.
--
-- WHO CHANGES: staff and viewers holding purchase_orders:manage read and
-- write only their own warehouses' purchase orders and those with no
-- warehouse; members whose purchase_orders:read is revoked (managers and
-- admins included) read, change, receive and draft none. The web already
-- refused them every one of these; the phone's lists change at the push, with
-- no app update. Owners, managers and admins holding read, and the crons, are
-- unchanged. The PR's kit notes carry the read-only counts that size it.
--
-- WHAT THIS DOES NOT CLOSE:
--   * approve_po_import_commit (0360, SECURITY DEFINER; gate: member, the
--     po_imports module and purchase_orders:manage; the destination checked
--     only with location_in_org) still creates a receivable purchase order
--     for any warehouse of the organization, for anyone holding manage, with
--     or without read. pgTAP IMP1 pins it so its fix (docket S46b) flips it on
--     purpose.
--   * The reorder de-duplication (save_purchase_order_draft's open-PO skip,
--     0366, and the app's open-PO read) reads under the caller's row
--     security, so a writer limited to some warehouses drafting from
--     suggestions no longer sees another warehouse's open purchase orders and
--     may draft those items again (drafts only; someone must still place
--     them). The daily auto-reorder runs as the service role and still sees
--     all. Also docket S46b.
--
-- STALE TEXT IN APPLIED FILES (an applied file is never edited): the 0366
-- header (save_purchase_order_draft is SECURITY INVOKER "on purpose:
-- purchase_orders_write, purchase_order_items_write and the ... guards")
-- and the 0385 header and body comments (the caller is a manager, "whom
-- purchase_orders_write lets read every PO of the org") name a policy that no
-- longer exists: read them as the policies above (a manager without
-- purchase_orders:read now reads none, and the draft's insert refuses them).
-- If the receiving checklist (0419) is applied before this file, its header
-- (item 4) still describes the FOR ALL read; its policy comment is restated
-- below.
--
-- ── LOCKS ──────────────────────────────────────────────────────────────────
-- The preflight reads catalogs only (pg_proc and pg_policy, no deparse), and
-- the function, its grants and its comment lock no table (plpgsql resolves
-- names when it runs), so they come first. DROP POLICY, CREATE POLICY and
-- COMMENT ON POLICY take ACCESS EXCLUSIVE on the policy's table and, on this
-- image (supautils 3.4.0), supautils also takes ACCESS EXCLUSIVE on every
-- table supautils.policy_grants lists for the role (auth, storage, realtime;
-- measured for COMMENT ON POLICY too). The new policy expressions read
-- locations while they are parsed (ACCESS SHARE). The app reads
-- purchase_order_items and then purchase_orders (the open-PO read, the
-- cancel keep-checks, the reports), and a raw line write takes FOR SHARE on
-- its purchase order after the line, so a file that waited for one of these
-- tables while holding the other could deadlock with a person's request. As
-- in 0390, 0395 and 0415, one prelude takes every lock at once, NOWAIT,
-- inside a subtransaction that retries up to 40 times with a 50-150 ms pause
-- holding nothing; no statement after it takes a new table lock, so the file
-- never waits while holding one
-- (scripts/db-concurrency/0423_migration_lock_footprint.sh, whose control
-- reproduces the 40P01 without the prelude). lock_timeout 900ms (below
-- deadlock_timeout) bounds anything unforeseen. Purchase order reads and
-- writes, and sign-ins (the supautils tables), queue for the few
-- milliseconds the file holds the locks.
--
-- ── ERRORS ─────────────────────────────────────────────────────────────────
-- next_po_number raises 42501 with a sentence. The policies refuse an insert,
-- or an update's new row, with 42501 and match 0 rows on an update or delete
-- the caller may not make. The push raises 55000 (drift: nothing applied) or
-- 55P03 (busy: nothing applied). Never 40001 or 40P01 (PostgREST retries
-- those forever, 0367).

set lock_timeout = '900ms';

-- ═══ 0. Preflight: catalogs only, nothing applied on drift ═══════════════════
-- The function must be the 0350 text and posture, and the two tables must
-- carry exactly the four policies this file replaces or keeps, by name and
-- command (pg_policy, no deparse, so no table lock; the rollout kit also pins
-- each policy's text in a block that is always undone). Anything else is drift
-- (or a second run): stop before changing anything.
do $pre46$
declare
  v_bad text := '';
  v_set text;
  r     record;
begin
  select md5(p.prosrc) as src, p.prosecdef as sd, l.lanname as lang,
         coalesce(array_to_string(p.proconfig, ';'), '') as cfg,
         pg_get_userbyid(p.proowner) as own
    into r
    from pg_proc p join pg_language l on l.oid = p.prolang
   where p.oid = to_regprocedure('public.next_po_number(uuid)');
  if not found then
    v_bad := v_bad || ' next_po_number missing;';
  elsif r.src <> 'b6bebc9ae8b1ec3a9ba6d89b73e39d91' or r.sd or r.lang <> 'sql'
        or r.cfg <> 'search_path=public' or r.own <> 'postgres' then
    v_bad := v_bad || format(' next_po_number drifted (md5 %s, definer %s, %s, %s, owner %s);',
                             r.src, r.sd, r.lang, r.cfg, r.own);
  end if;

  select string_agg(c.relname || '.' || pol.polname || ':' || pol.polcmd::text, ','
                    order by c.relname collate "C", pol.polname collate "C")
    into v_set
    from pg_policy pol join pg_class c on c.oid = pol.polrelid
   where pol.polrelid in ('public.purchase_orders'::regclass, 'public.purchase_order_items'::regclass);
  if v_set is distinct from
     'purchase_order_items.purchase_order_items_select:r,purchase_order_items.purchase_order_items_write:*,'
     || 'purchase_orders.purchase_orders_select:r,purchase_orders.purchase_orders_write:*' then
    v_bad := v_bad || format(' purchase order policies drifted (%s);', coalesce(v_set, 'none'));
  end if;

  if v_bad <> '' then
    raise exception 's46_preflight:%', v_bad using errcode = '55000', hint = 's46_preflight';
  end if;
end
$pre46$;

-- ═══ 1. next_po_number (no table lock) ═══════════════════════════════════════
create or replace function public.next_po_number(p_org_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null
     and not (public.has_org_role(p_org_id, 'manager')
              or public.has_permission(p_org_id, 'purchase_orders:manage')) then
    raise exception 'You cannot manage purchase orders in this organization.'
      using errcode = '42501';
  end if;
  return 'PO-' || to_char(now(), 'YYYY') || '-' || lpad(((
    select count(*) from public.purchase_orders where organization_id = p_org_id
  ) + 1)::text, 4, '0');
end;
$$;

revoke all on function public.next_po_number(uuid) from public, anon;
grant execute on function public.next_po_number(uuid) to authenticated, service_role;

comment on function public.next_po_number(uuid) is
  'Per-org sequential PO number (PO-YYYY-NNNN), count of the organization''s purchase orders + 1 (0005). SECURITY DEFINER since S46: the count no longer depends on which purchase orders the caller may read, so a PO writer limited to some warehouses draws the same next number as a manager. Gate: signed-in callers must be a manager (has_org_role) or hold purchase_orders:manage (42501 otherwise); the service role (no auth.uid()) passes. EXECUTE to authenticated and service_role only.';

-- ═══ 2. The lock prelude ═════════════════════════════════════════════════════
-- Every table lock the statements below take, at once and without waiting.
-- Inside DO because the CLI batch is not a transaction block (a top-level
-- LOCK TABLE refuses there, as 0373 found); the locks last until the batch
-- commits.
--   * locations: ACCESS SHARE (read by the purchase_orders policy expressions);
--   * checklist_runs, when 0419 is in: ACCESS EXCLUSIVE (COMMENT ON POLICY: as
--     measured on the scratch stack, supautils takes ACCESS EXCLUSIVE on the
--     policy's own table and on every policy_grants table for it too);
--   * purchase_orders, purchase_order_items: ACCESS EXCLUSIVE (DROP/CREATE POLICY);
--   * every existing table supautils.policy_grants lists for this role:
--     ACCESS EXCLUSIVE (supautils takes it on any policy statement), ONLY the
--     parent of a partitioned table (realtime.messages), as supautils does.
-- A busy table fails the attempt at once; its subtransaction releases what it
-- took and the next attempt starts 50-150 ms later holding nothing; after 40
-- busy attempts the 55P03 is raised and nothing in the file is applied.
do $lock46$
declare
  v_grants text := nullif(current_setting('supautils.policy_grants', true), '');
  v_name   text;
  v_rel    regclass;
  v_try    integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.locations in access share mode nowait;
      if to_regclass('public.checklist_runs') is not null then
        execute 'lock table only public.checklist_runs in access exclusive mode nowait';
      end if;
      lock table only public.purchase_orders, public.purchase_order_items in access exclusive mode nowait;
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
end
$lock46$;

-- ═══ 3. purchase_orders: INSERT and UPDATE, no FOR ALL ══════════════════════
-- The last conjunct is purchase_orders_select's third (0322), copied as it is:
-- both sides of the EXISTS comparison are qualified (pattern #25).
drop policy purchase_orders_write on public.purchase_orders;

create policy purchase_orders_insert on public.purchase_orders
  for insert to authenticated
  with check (
    ( ( select public.has_org_role(purchase_orders.organization_id, 'manager') )
      or ( select public.has_permission(purchase_orders.organization_id, 'purchase_orders:manage') ) )
    and purchase_orders.organization_id in
          (select public.rls_orgs_with_permission('purchase_orders:read'))
    and ( select public.location_in_org(purchase_orders.destination_location_id, purchase_orders.organization_id) )
    and ( select public.charter_in_org(purchase_orders.charter_id, purchase_orders.organization_id) )
    and ( select public.supplier_in_org(purchase_orders.supplier_id, purchase_orders.organization_id) )
    and (
      ( select public.has_org_role(purchase_orders.organization_id, 'manager') )
      or purchase_orders.destination_location_id is null
      or exists (
        select 1
          from public.locations l
         where l.id = purchase_orders.destination_location_id
           and (
             l.warehouse_id is null
             or l.warehouse_id in (select mw.warehouse_id from public.my_warehouse_ids() mw)
           )
      )
    )
  );

create policy purchase_orders_update on public.purchase_orders
  for update to authenticated
  using (
    ( ( select public.has_org_role(purchase_orders.organization_id, 'manager') )
      or ( select public.has_permission(purchase_orders.organization_id, 'purchase_orders:manage') ) )
    and purchase_orders.organization_id in
          (select public.rls_orgs_with_permission('purchase_orders:read'))
    and (
      ( select public.has_org_role(purchase_orders.organization_id, 'manager') )
      or purchase_orders.destination_location_id is null
      or exists (
        select 1
          from public.locations l
         where l.id = purchase_orders.destination_location_id
           and (
             l.warehouse_id is null
             or l.warehouse_id in (select mw.warehouse_id from public.my_warehouse_ids() mw)
           )
      )
    )
  )
  with check (
    ( ( select public.has_org_role(purchase_orders.organization_id, 'manager') )
      or ( select public.has_permission(purchase_orders.organization_id, 'purchase_orders:manage') ) )
    and purchase_orders.organization_id in
          (select public.rls_orgs_with_permission('purchase_orders:read'))
    and ( select public.location_in_org(purchase_orders.destination_location_id, purchase_orders.organization_id) )
    and ( select public.charter_in_org(purchase_orders.charter_id, purchase_orders.organization_id) )
    and ( select public.supplier_in_org(purchase_orders.supplier_id, purchase_orders.organization_id) )
    and (
      ( select public.has_org_role(purchase_orders.organization_id, 'manager') )
      or purchase_orders.destination_location_id is null
      or exists (
        select 1
          from public.locations l
         where l.id = purchase_orders.destination_location_id
           and (
             l.warehouse_id is null
             or l.warehouse_id in (select mw.warehouse_id from public.my_warehouse_ids() mw)
           )
      )
    )
  );

-- ═══ 4. purchase_order_items: INSERT, UPDATE, DELETE ════════════════════════
-- The EXISTS reads purchase_orders under the caller's row security, so a line
-- may be written exactly when its purchase order may be read.
drop policy purchase_order_items_write on public.purchase_order_items;

create policy purchase_order_items_insert on public.purchase_order_items
  for insert to authenticated
  with check (
    ( ( select public.has_org_role(purchase_order_items.organization_id, 'manager') )
      or ( select public.has_permission(purchase_order_items.organization_id, 'purchase_orders:manage') ) )
    and exists (
      select 1 from public.purchase_orders p
       where p.id = purchase_order_items.purchase_order_id
         and p.organization_id = purchase_order_items.organization_id
    )
  );

create policy purchase_order_items_update on public.purchase_order_items
  for update to authenticated
  using (
    ( ( select public.has_org_role(purchase_order_items.organization_id, 'manager') )
      or ( select public.has_permission(purchase_order_items.organization_id, 'purchase_orders:manage') ) )
    and exists (
      select 1 from public.purchase_orders p
       where p.id = purchase_order_items.purchase_order_id
         and p.organization_id = purchase_order_items.organization_id
    )
  )
  with check (
    ( ( select public.has_org_role(purchase_order_items.organization_id, 'manager') )
      or ( select public.has_permission(purchase_order_items.organization_id, 'purchase_orders:manage') ) )
    and exists (
      select 1 from public.purchase_orders p
       where p.id = purchase_order_items.purchase_order_id
         and p.organization_id = purchase_order_items.organization_id
    )
  );

create policy purchase_order_items_delete on public.purchase_order_items
  for delete to authenticated
  using (
    ( ( select public.has_org_role(purchase_order_items.organization_id, 'manager') )
      or ( select public.has_permission(purchase_order_items.organization_id, 'purchase_orders:manage') ) )
    and exists (
      select 1 from public.purchase_orders p
       where p.id = purchase_order_items.purchase_order_id
         and p.organization_id = purchase_order_items.organization_id
    )
  );

-- ═══ 5. Comments ════════════════════════════════════════════════════════════
comment on policy purchase_orders_insert on public.purchase_orders is
  'S46: a new purchase order needs a manager or purchase_orders:manage, purchase_orders:read in the organization, the destination inside the caller''s warehouses below manager (none, or a place with no warehouse, also passes, as in purchase_orders_select), and the 0203-0205 organization checks. Reads go by purchase_orders_select alone.';
comment on policy purchase_orders_update on public.purchase_orders is
  'S46: the same rule as purchase_orders_insert on the row before (USING) and after (WITH CHECK) the change. No FOR ALL policy: none widens purchase_orders_select. DELETE is revoked (0360).';
comment on policy purchase_order_items_insert on public.purchase_order_items is
  'S46: a manager or purchase_orders:manage, and the parent purchase order readable by the caller (the EXISTS reads purchase_orders under the caller''s RLS). tg_purchase_order_items_guard adds the draft, item and amount rules.';
comment on policy purchase_order_items_update on public.purchase_order_items is
  'S46: as purchase_order_items_insert. The guard refuses every API-role line update outside the receipt functions'' ledger flag.';
comment on policy purchase_order_items_delete on public.purchase_order_items is
  'S46: as purchase_order_items_insert. The guard allows removing lines only from a draft.';

-- The receiving checklist's run policy (0419), when it is in: its comment
-- named the FOR ALL read this file removes.
do $c46$
begin
  if to_regclass('public.checklist_runs') is not null
     and exists (select 1 from pg_policy pol
                  where pol.polrelid = to_regclass('public.checklist_runs')
                    and pol.polname = 'checklist_runs_select') then
    execute $q$comment on policy checklist_runs_select on public.checklist_runs is 'Receiving checklist (F4-1): a run is visible exactly when its purchase order is to the caller. The EXISTS reads purchase_orders under the caller''s RLS, which since S46 is purchase_orders_select alone (membership, purchase_orders:read and, below manager, the warehouse scope).'$q$;
  end if;
end
$c46$;

reset lock_timeout;
