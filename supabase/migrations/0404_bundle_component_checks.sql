-- 0404_bundle_component_checks.sql
--
-- Kits are made only from their own organization's items, never from nothing,
-- and only by the people the app lets make or hand them out (docket S4, with
-- the bundle component organization check moved here from S9). DB-only: no
-- row is written, no table, view or sequence is created, and every grant
-- stays as it is.
--
-- ── WHAT WAS WRONG ─────────────────────────────────────────────────────────
--   1. assemble_bundle and distribute_bundle never refused a bundle with no
--      required component. The loop over the components simply drew nothing,
--      and the kit count went up anyway: a rolled-back probe on 2026-10-05
--      made 5 kits from an empty bundle with every component's stock
--      unchanged. A bundle can be left that way by a raw REST delete, a
--      create whose components failed, or a save that marks every component
--      Optional.
--   2. bundle_components_write (0140) checked only that the caller manages
--      the BUNDLE's organization, never the component ITEM's: a raw insert
--      could name another organization's item (rolled-back probe 2026-10-05).
--      The kit functions never drew such a component, but only because of
--      facts outside them: another organization's item sits in that
--      organization's warehouse, where this organization never builds a kit,
--      and an item with no warehouse is hidden by row security. For a member
--      of both organizations the kit still went out: assembled without the
--      component when it was optional, handed out with it recorded as short
--      when it was required (pgTAP M3).
--   3. distribute_bundle had no permission gate (0395 left it out because the
--      Schedule's completion path calls it behind schedule:manage), so a
--      manager whose bundles:distribute is revoked still handed out kits by
--      calling it directly. Its p_schedule_event_id was not checked either:
--      a call could name another organization's event and take the one
--      distribution slot bundle_distributions_event_uniq keeps for it (that
--      organization's own completion then hit 23505, which the Schedule
--      service reads as "already distributed", and handed out nothing). The
--      table itself took a raw insert from any staff member, so a
--      distribution could be recorded with no stock drawn at all.
--   4. The bundle write policies follow the manager role only, so a manager
--      whose bundles:manage is revoked could still create, rename, archive
--      or delete bundles and change their components through REST, which the
--      app refuses (it asserts bundles:manage before every one of those
--      writes).
--
-- ── WHAT THIS MIGRATION DOES ───────────────────────────────────────────────
--   1. ledger.assemble_bundle and ledger.distribute_bundle (SECURITY INVOKER,
--      search_path public, the ledger bodies behind the 0359 wrappers) are
--      restated from their live text (0373; md5(prosrc) a2967a28 and
--      d78bf6b0) with these lines added, each ending in '-- 0404':
--        * inside the component loop, before anything of the component is
--          read or drawn: refuse (42501 component_not_in_org) a component
--          that is not an item of the kit's organization
--          (public.item_in_org, SECURITY DEFINER, so the answer does not
--          depend on what the caller can read), and count the required
--          components the loop meets;
--        * after the loop: refuse (P0001 bundle_no_required_components) when
--          it met none. The count is taken by the loop's own statement, so
--          it is the set this call actually drew from: a component deleted or
--          made optional by another session between an earlier check and the
--          loop cannot let a kit through with nothing in it. A refusal after
--          optional components were drawn undoes them with the call (pgTAP
--          X3 and X4). In distribute_bundle the loop and the refusal belong to
--          the part built from components only: pre-assembled kits already
--          exist and are still handed out from a bundle with no required
--          component (pgTAP X8);
--        * distribute_bundle, after the warehouse check and before the
--          idempotency key: a named event must belong to the kit's
--          organization, else P0002 schedule_event_not_found (read under the
--          caller's row security; a manager reads every event of their
--          organization).
--   2. public.distribute_bundle (the 0359 wrapper, SECURITY INVOKER) gets the
--      0395 L8 gate, lines tagged '-- 0404': an API role's direct call
--      (current_user authenticated or anon, not inside another ledger call of
--      the same transaction) is refused with 42501 forbidden, hint permission,
--      unless the caller holds bundles:distribute (what the Bundles page, the
--      phone and the API assert first), or, for the Schedule's own completion
--      of an event that hands out this kit, holds schedule:manage with the
--      Schedule module on and names an event of the kit's organization that
--      is completed and links this kit, quantity and warehouse (what
--      ScheduleService.update sends, after it has saved the completion). A
--      kit the caller cannot read is left to the body, which answers as
--      before. service_role is not held.
--      The docket line says "after bundles:manage is revoked". The permission
--      that decides distribution is bundles:distribute: it is the one the app
--      asserts before every distribution, staff hold it without
--      bundles:manage by design (constants/permissions.ts: staff+ run
--      distributions), and a manager whose bundles:manage alone is revoked
--      still distributes in the app. Gating on bundles:manage would refuse
--      that manager and still let one whose bundles:distribute is revoked
--      through, so the gate names bundles:distribute (pgTAP K1-K6).
--   3. bundle_components_write: WITH CHECK also requires the component's item
--      to belong to the bundle's organization (public.item_in_org), and USING
--      and WITH CHECK both require bundles:manage. USING keeps no item term,
--      so a component row that already names another organization's item can
--      still be deleted by a manager (and only deleted: any update of it must
--      pass WITH CHECK).
--   4. bundles_insert and bundles_update (WITH CHECK) and bundles_delete
--      (USING) also require bundles:manage. bundles_update USING is left on
--      the manager role on purpose: distribute_bundle reads its bundle with
--      SELECT ... FOR UPDATE, which Postgres filters with the UPDATE policy's
--      USING clause, so a bundles:manage term there would make a kit
--      invisible to a manager who may distribute it but not edit it (pgTAP
--      K1 holds that case; M9 shows the other choice failing it).
--   5. bundle_distributions gets 0359's ledger-only guard
--      (trg_zz_bundle_distributions_guard, tg_ledger_only_guard): a signed-in
--      user's insert, update or delete is refused (42501 ledger_only) unless
--      it runs inside a ledger RPC, which only distribute_bundle's body does.
--      Its insert policy stays, because that body writes the row as the user.
--
-- Every role floor stays: the bodies still require a manager, the policies
-- still require a manager (an admin to delete a bundle), and each permission
-- term is added with AND, so nothing the app refuses today is let through and
-- nothing it allows is refused (the app checks the same permissions first).
--
-- WHO CHANGES TODAY: production was not read for this file (the authoring
-- agent may not reach it). Before the push, run the read-only counts in the
-- PR's release steps: bundles with no required component (they can no longer
-- be assembled or handed out from components), component rows naming another
-- organization's item (they now refuse their kit until removed),
-- distributions naming another organization's event, and permission overrides
-- that revoke bundles:distribute or bundles:manage.
--
-- ── LOCKS ──────────────────────────────────────────────────────────────────
-- The preflight (its policy read undone, see there), the functions (plpgsql,
-- which resolves names at run time) and the comment lock no table, so they
-- come first. ALTER POLICY takes ACCESS EXCLUSIVE on
-- its table (bundles, bundle_components) and, on this image, supautils 3.4.0
-- takes ACCESS EXCLUSIVE on every table supautils.policy_grants lists for the
-- role (auth, storage, realtime); CREATE TRIGGER takes SHARE ROW EXCLUSIVE on
-- bundle_distributions. A running distribution holds the bundle row, then
-- reads bundle_components and inserts into bundle_distributions, so waiting
-- for one of these while holding another could deadlock. As in 0390 and 0395,
-- one prelude takes them all at once, NOWAIT, inside a subtransaction that
-- retries up to 40 times with a 50-150 ms pause holding nothing; after it no
-- statement takes a new table lock, so the file never waits while holding
-- one. lock_timeout 900ms (below deadlock_timeout) bounds anything
-- unforeseen. Kit and bundle reads and writes queue for the few milliseconds
-- the file holds the locks; sign-ins queue for the same window (the supautils
-- tables). Push off-peak.
--
-- ── ERRORS ─────────────────────────────────────────────────────────────────
-- The functions raise 42501 (forbidden hint permission, component_not_in_org),
-- P0001 (bundle_no_required_components) and P0002 (schedule_event_not_found);
-- the guard raises 42501 ledger_only; the policies refuse with 42501. The push
-- raises 55000 (drift: nothing applied) or 55P03 (busy: nothing applied).
-- Never 40001 or 40P01 (PostgREST retries those forever, 0367).

set lock_timeout = '900ms';

-- ═══ 0. Preflight ══════════════════════════════════════════════════════════
-- Every body restated below must be the exact live text and header it was
-- built from, the two helpers it relies on must be the ones it was written
-- against, and the four policies must be the 0140 text. Anything else is
-- drift (or a second run): stop before changing anything.
do $pre404$
declare
  v_bad text := '';
  r record;
begin
  for r in
    select v.sig, v.want_src, v.want_secdef, v.want_vol, v.want_cfg, p.oid as poid,
           md5(p.prosrc) as got_src, p.prosecdef as got_secdef, p.provolatile::text as got_vol,
           coalesce(array_to_string(p.proconfig, ';'), '') as got_cfg,
           pg_get_userbyid(p.proowner) as got_owner,
           p.proisstrict as got_strict, p.proleakproof as got_leak, p.proparallel::text as got_par
      from (values
        ('ledger.assemble_bundle(uuid,numeric,uuid,text)',                       'a2967a282fbdf76c10c2808f35760973', false, 'v', 'search_path=public'),
        ('ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)',   'd78bf6b0471c49981b6a8df064e6b895', false, 'v', 'search_path=public'),
        ('public.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)',   'f0ef2bde4103221457cf632769ce36c7', false, 'v', 'search_path=public'),
        ('public.item_in_org(uuid,uuid)',                                        '28a1ed8cd1c2adec840215fd94ed5db1', true,  's', 'search_path=public'),
        ('public.tg_ledger_only_guard()',                                        '17b5b1303f86319f8500b1e9b5cec211', false, 'v', 'search_path=public')
      ) v(sig, want_src, want_secdef, want_vol, want_cfg)
      left join pg_proc p on p.oid = to_regprocedure(v.sig)
  loop
    if r.poid is null then
      v_bad := v_bad || format(' %s missing;', r.sig);
    elsif r.got_src <> r.want_src or r.got_secdef <> r.want_secdef or r.got_vol <> r.want_vol
          or r.got_cfg <> r.want_cfg or r.got_owner <> 'postgres'
          or r.got_strict or r.got_leak or r.got_par <> 'u' then
      v_bad := v_bad || format(' %s drifted (md5 %s, definer %s, volatility %s, %s, owner %s, strict %s, leakproof %s, parallel %s);',
                               r.sig, r.got_src, r.got_secdef, r.got_vol, r.got_cfg, r.got_owner,
                               r.got_strict, r.got_leak, r.got_par);
    end if;
  end loop;

  -- The policy text is read in a block that is always undone. pg_policies
  -- deparses each expression, and deparsing bundle_components_write (whose
  -- subquery reads bundles) takes ACCESS SHARE on bundles until the
  -- transaction ends. Undoing the block lets that lock go, so the file holds
  -- no table lock before the prelude, nor while the prelude pauses between
  -- attempts (scripts/db-concurrency/0404_migration_lock_footprint.sh). The
  -- names it finds stay in v_bad: a variable is not undone with the block.
  begin
    for r in
      select v.tbl, v.pol, v.want, md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) as got
        from (values
          ('bundle_components', 'bundle_components_write', '763552ccd32e21275e74618a486d6f83'),
          ('bundles',           'bundles_insert',          '5bf8f45dd3f3f608400463bb6de47f6a'),
          ('bundles',           'bundles_update',          'f982d95de1ed9a7b122fe7d5b5c4b868'),
          ('bundles',           'bundles_delete',          '3192bd31fbdda403d4b2fb399e636615')
        ) v(tbl, pol, want)
        left join pg_policies p on p.schemaname = 'public' and p.tablename = v.tbl and p.policyname = v.pol
    loop
      if r.got is distinct from r.want then
        v_bad := v_bad || format(' policy %s.%s drifted (%s);', r.tbl, r.pol, coalesce(r.got, 'missing'));
      end if;
    end loop;
    raise exception using errcode = 'XX404', message = 'undo';
  exception when sqlstate 'XX404' then
    null;
  end;

  if exists (select 1 from pg_trigger t
              where t.tgrelid = 'public.bundle_distributions'::regclass
                and t.tgname = 'trg_zz_bundle_distributions_guard') then
    v_bad := v_bad || ' trg_zz_bundle_distributions_guard already exists;';
  end if;

  if v_bad <> '' then
    raise exception 'bundle_checks_preflight:%', v_bad
      using errcode = '55000', hint = 'bundle_checks_preflight';
  end if;
end
$pre404$;

-- ═══ 1. Functions (plpgsql only: no table lock is taken here) ═════════════
-- 1a. ledger.assemble_bundle: restated from 0373_draw_provenance.sql; md5(prosrc)
-- a2967a282fbdf76c10c2808f35760973 -> e19c6fcd92ee9edd4846f9fc12ab60f5. The
-- 0404 lines refuse a component of another organization and a kit with no
-- required component.
CREATE OR REPLACE FUNCTION ledger.assemble_bundle(p_bundle_id uuid, p_quantity numeric, p_warehouse_id uuid, p_notes text DEFAULT NULL::text)
 RETURNS TABLE(phantom_item_id uuid, phantom_qty numeric)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_bundle    public.bundles%rowtype;
  v_org       uuid;
  v_phantom   public.inventory_items%rowtype;
  v_user      uuid := auth.uid();
  v_phantom_sku text;
  v_component record;
  v_needed    numeric(14,4);
  v_prev      numeric(14,4);
  v_new       numeric(14,4);
  v_prov      public.stock_draw;  -- 0373
  v_required  integer := 0;  -- 0404
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity_must_be_positive' using errcode = '22023';
  end if;

  select * into v_bundle
  from public.bundles where id = p_bundle_id for update;
  if not found then raise exception 'bundle_not_found' using errcode = 'P0002'; end if;
  if not v_bundle.is_active or v_bundle.archived_at is not null then
    raise exception 'bundle_not_active' using errcode = 'P0001';
  end if;
  if not v_bundle.preassembly_enabled then
    raise exception 'preassembly_disabled' using errcode = 'P0001';
  end if;
  v_org := v_bundle.organization_id;

  -- C9: tightened from 'staff' to 'manager' to match service gate
  -- `bundles:manage`. The service layer's assertWarehouseAccess adds
  -- warehouse-scope; this assert is the org-role floor.
  if not public.has_org_role(v_org, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Verify warehouse belongs to org
  if not exists (
    select 1 from public.warehouses
    where id = p_warehouse_id and organization_id = v_org
  ) then
    raise exception 'warehouse_not_found' using errcode = 'P0002';
  end if;

  -- Lock or create phantom
  if v_bundle.phantom_item_id is not null then
    select * into v_phantom
    from public.inventory_items
    where id = v_bundle.phantom_item_id for update;
    if v_phantom.warehouse_id is not null and v_phantom.warehouse_id <> p_warehouse_id then
      raise exception 'phantom_warehouse_mismatch' using errcode = 'P0001';
    end if;
    -- 0365: never add kits to a deleted kit item.
    if v_phantom.deleted_at is not null then
      raise exception 'phantom_deleted' using errcode = 'P0001';
    end if;
  else
    -- SKU is internal, never user-facing. Truncated UUID guarantees
    -- uniqueness without colliding with any real SKU pattern.
    v_phantom_sku := '__BUNDLE__' || substr(p_bundle_id::text, 1, 8);
    insert into public.inventory_items (
      organization_id, sku, name, description, status,
      quantity_on_hand, warehouse_id, is_bundle,
      created_by, updated_by
    ) values (
      v_org, v_phantom_sku, v_bundle.name,
      'Pre-assembled bundle stock for ' || v_bundle.name,
      'active', 0, p_warehouse_id, true, v_user, v_user
    )
    returning * into v_phantom;

    update public.bundles
      set phantom_item_id = v_phantom.id, updated_at = now()
      where id = p_bundle_id;
  end if;

  -- Decrement components in deterministic order to avoid deadlocks
  -- between concurrent assemble/distribute calls.
  -- 0365: every required component must be one the caller can see. The loop
  -- below reads components under the caller's RLS (these bodies are INVOKER);
  -- one it could not see (an item with no warehouse, or outside a category
  -- grant) was skipped silently and the kit went out without it.
  if exists (select 1 from public.bundle_components bc
              where bc.bundle_id = p_bundle_id and not bc.is_optional
                and not exists (select 1 from public.inventory_items ii where ii.id = bc.item_id)) then
    raise exception 'component_not_visible' using errcode = 'P0001';
  end if;
  for v_component in
    select bc.item_id, bc.quantity, bc.is_optional, ii.quantity_on_hand, ii.id as ii_id,
           ii.warehouse_id as item_wh, ii.deleted_at
    from public.bundle_components bc
    join public.inventory_items ii on ii.id = bc.item_id
    where bc.bundle_id = p_bundle_id
    order by bc.item_id
    for update of ii
  loop
    -- 0404: every component is an item of the kit's own organization.
    if not public.item_in_org(v_component.item_id, v_org) then  -- 0404
      raise exception 'component_not_in_org' using errcode = '42501';  -- 0404
    end if;  -- 0404
    if not v_component.is_optional then  -- 0404
      v_required := v_required + 1;  -- 0404
    end if;  -- 0404
    v_needed := v_component.quantity * p_quantity;
    -- 0365: a kit built here uses this warehouse's components (or ones with
    -- no warehouse), never a deleted item's. Said as such, not as a stock
    -- shortage the bundle page would contradict.
    if v_component.deleted_at is not null
       or coalesce(v_component.item_wh, p_warehouse_id) <> p_warehouse_id then
      if not v_component.is_optional then
        raise exception 'component_not_in_warehouse'
          using errcode = 'P0001', detail = v_component.item_id::text;
      end if;
      continue;
    end if;
    if v_component.quantity_on_hand < v_needed then
      if not v_component.is_optional then
        raise exception 'insufficient_stock' using detail = v_component.item_id::text;
      else
        continue;
      end if;
    end if;

    v_prev := v_component.quantity_on_hand;
    v_new  := v_prev - v_needed;
    update public.inventory_items
      set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
      where id = v_component.item_id;
    -- Maintain levels: consume from placed locations (rack/area/crate).
    -- Raises insufficient_placed_stock if component stock is only in Staging.
    v_prov := ledger.apply_level_delta_for(v_component.item_id, v_new - v_prev, 'placed', true, v_user);  -- 0373

    insert into public.stock_movements (
      draw,  -- 0373
      organization_id, item_id, movement_type, quantity_change,
      previous_quantity, new_quantity, reason, reference_type,
      reference_id, user_id, notes
    ) values (
      v_prov,  -- 0373
      v_org, v_component.item_id, 'bundle_assembly', -v_needed,
      v_prev, v_new, 'bundle_assembly', 'bundle',
      p_bundle_id, v_user, p_notes
    );
  end loop;
  -- 0404: no kit without a required component (counted by the loop above).
  if v_required = 0 then  -- 0404
    raise exception 'bundle_no_required_components' using errcode = 'P0001';  -- 0404
  end if;  -- 0404

  -- Increment phantom
  v_prev := v_phantom.quantity_on_hand;
  v_new  := v_prev + p_quantity;
  update public.inventory_items
    set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
    where id = v_phantom.id;
  -- Maintain levels: assembled kit lands in Staging.
  v_prov := ledger.apply_level_delta_for(v_phantom.id, v_new - v_prev, 'staging', true, v_user);  -- 0373

  insert into public.stock_movements (
    draw,  -- 0373
    organization_id, item_id, movement_type, quantity_change,
    previous_quantity, new_quantity, reason, reference_type,
    reference_id, user_id, notes
  ) values (
    v_prov,  -- 0373
    v_org, v_phantom.id, 'bundle_assembly', p_quantity,
    v_prev, v_new, 'bundle_assembly', 'bundle',
    p_bundle_id, v_user, p_notes
  );

  return query select v_phantom.id, v_new;
end;
$function$;

-- 1b. ledger.distribute_bundle: restated from 0373_draw_provenance.sql;
-- md5(prosrc) d78bf6b0471c49981b6a8df064e6b895 -> 71515ab72a12abc128b82fe2bf684d5c.
-- The 0404 lines refuse an event of another organization, a component of
-- another organization and kits made from components with no required one.
CREATE OR REPLACE FUNCTION ledger.distribute_bundle(p_bundle_id uuid, p_quantity numeric, p_warehouse_id uuid, p_allow_shortage boolean, p_schedule_event_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_bundle    public.bundles%rowtype;
  v_org       uuid;
  v_distribution_id uuid;
  v_phantom_qty numeric(14,4) := 0;
  v_phantom_wh uuid;
  v_phantom_deleted timestamptz;
  v_use_phantom numeric(14,4) := 0;
  v_use_virtual numeric(14,4);
  v_shortage  boolean := false;
  v_user      uuid := auth.uid();
  v_component record;
  v_needed    numeric(14,4);
  v_have      numeric(14,4);
  v_draw      numeric(14,4);
  v_short     numeric(14,4);
  v_prev      numeric(14,4);
  v_new       numeric(14,4);
  v_existing  public.idempotency_keys%rowtype;
  v_request_hash text;
  v_prov      public.stock_draw;  -- 0373
  v_required  integer := 0;  -- 0404
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity_must_be_positive' using errcode = '22023';
  end if;

  select * into v_bundle
  from public.bundles where id = p_bundle_id for update;
  if not found then raise exception 'bundle_not_found' using errcode = 'P0002'; end if;
  if not v_bundle.is_active or v_bundle.archived_at is not null then
    raise exception 'bundle_not_active' using errcode = 'P0001';
  end if;
  v_org := v_bundle.organization_id;

  -- C9: tightened from 'staff' to 'manager' to match service gate
  -- `bundles:distribute`. The service layer's assertWarehouseAccess
  -- adds warehouse-scope; this assert is the org-role floor.
  if not public.has_org_role(v_org, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Verify warehouse belongs to org
  if not exists (
    select 1 from public.warehouses
    where id = p_warehouse_id and organization_id = v_org
  ) then
    raise exception 'warehouse_not_found' using errcode = 'P0002';
  end if;
  -- 0404: the event named, if any, belongs to the kit's own organization.
  if p_schedule_event_id is not null  -- 0404
     and not exists (select 1 from public.schedule_events e  -- 0404
                      where e.id = p_schedule_event_id and e.organization_id = v_org) then  -- 0404
    raise exception 'schedule_event_not_found' using errcode = 'P0002';  -- 0404
  end if;  -- 0404

  -- *** 0347 idempotency — see header. Runs after the role/warehouse checks so
  -- a refused caller cannot probe keys, and before any stock write so the
  -- replay short-circuits with nothing touched. ***
  if p_idempotency_key is not null then
    v_request_hash := md5(
      p_bundle_id::text || '|' || p_quantity::text || '|' || p_warehouse_id::text
      || '|' || coalesce(p_allow_shortage, false)::text
      || '|' || coalesce(p_schedule_event_id::text, '')
    );
    select * into v_existing
      from public.idempotency_keys
     where organization_id = v_org
       and scope = 'bundle_distribution'
       and key = p_idempotency_key
       for update;
    if found then
      if v_existing.request_hash = v_request_hash
         and v_existing.status = 'completed'
         and v_existing.resource_id is not null then
        return v_existing.resource_id;
      end if;
      raise exception 'idempotency_conflict' using errcode = '55000';
    end if;
    insert into public.idempotency_keys
      (organization_id, scope, key, request_hash, status, resource_type)
    values
      (v_org, 'bundle_distribution', p_idempotency_key, v_request_hash, 'in_progress', 'bundle_distribution');
  end if;

  -- Phantom allocation
  if v_bundle.phantom_item_id is not null then
    select quantity_on_hand, warehouse_id, deleted_at
      into v_phantom_qty, v_phantom_wh, v_phantom_deleted
    from public.inventory_items
    where id = v_bundle.phantom_item_id for update;
    v_phantom_qty := greatest(0, coalesce(v_phantom_qty, 0));
    -- 0365: pre-assembled kits in another warehouse (or on a deleted kit item)
    -- are not here. They are left alone and this distribution is built from
    -- this warehouse's components (assemble_bundle already refuses to build
    -- into another warehouse).
    if v_phantom_deleted is not null
       or (v_phantom_wh is not null and v_phantom_wh <> p_warehouse_id) then
      v_phantom_qty := 0;
    end if;
  end if;

  v_use_phantom := least(p_quantity, v_phantom_qty);
  v_use_virtual := p_quantity - v_use_phantom;

  -- Drain phantom
  if v_use_phantom > 0 then
    v_prev := v_phantom_qty;
    v_new  := v_prev - v_use_phantom;
    update public.inventory_items
      set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
      where id = v_bundle.phantom_item_id;
    -- Maintain levels: pre-assembled stock sat in Staging; drain it there first.
    v_prov := ledger.apply_level_delta_for(v_bundle.phantom_item_id, v_new - v_prev, 'staging_first', true, v_user);  -- 0373

    insert into public.stock_movements (
      draw,  -- 0373
      organization_id, item_id, movement_type, quantity_change,
      previous_quantity, new_quantity, reason, reference_type,
      reference_id, user_id, notes
    ) values (
      v_prov,  -- 0373
      v_org, v_bundle.phantom_item_id, 'bundle_distribution', -v_use_phantom,
      v_prev, v_new, 'bundle_distribution', 'bundle',
      p_bundle_id, v_user, p_notes
    );
  end if;

  -- Component allocation for the virtual portion
  if v_use_virtual > 0 then
    -- 0365: every required component must be one the caller can see. The loop
    -- below reads components under the caller's RLS (these bodies are INVOKER);
    -- one it could not see (an item with no warehouse, or outside a category
    -- grant) was skipped silently and the kit went out without it.
    if exists (select 1 from public.bundle_components bc
                where bc.bundle_id = p_bundle_id and not bc.is_optional
                  and not exists (select 1 from public.inventory_items ii where ii.id = bc.item_id)) then
      raise exception 'component_not_visible' using errcode = 'P0001';
    end if;
    for v_component in
      select bc.item_id, bc.quantity, bc.is_optional, ii.quantity_on_hand,
             ii.warehouse_id as item_wh, ii.deleted_at
      from public.bundle_components bc
      join public.inventory_items ii on ii.id = bc.item_id
      where bc.bundle_id = p_bundle_id
      order by bc.item_id
      for update of ii
    loop
      -- 0404: every component is an item of the kit's own organization.
      if not public.item_in_org(v_component.item_id, v_org) then  -- 0404
        raise exception 'component_not_in_org' using errcode = '42501';  -- 0404
      end if;  -- 0404
      if not v_component.is_optional then  -- 0404
        v_required := v_required + 1;  -- 0404
      end if;  -- 0404
      v_needed := v_component.quantity * v_use_virtual;
      -- 0365: only this warehouse's stock (or a component with no warehouse)
      -- is drawn, and never a deleted item. 0101 dropped 0070's scope, so a
      -- distribution drained the component from whichever building held it
      -- while the preview reported a shortage.
      v_have   := case when v_component.deleted_at is null
                        and coalesce(v_component.item_wh, p_warehouse_id) = p_warehouse_id
                       then greatest(0, v_component.quantity_on_hand) else 0 end;
      v_draw   := least(v_needed, v_have);
      v_short  := v_needed - v_draw;

      if v_draw > 0 then
        v_prev := v_component.quantity_on_hand;
        v_new  := v_prev - v_draw;
        update public.inventory_items
          set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
          where id = v_component.item_id;
        -- Maintain levels: virtual-portion consumption draws from placed stock.
        v_prov := ledger.apply_level_delta_for(v_component.item_id, v_new - v_prev, 'placed', true, v_user);  -- 0373

        insert into public.stock_movements (
          draw,  -- 0373
          organization_id, item_id, movement_type, quantity_change,
          previous_quantity, new_quantity, reason, reference_type,
          reference_id, user_id, notes
        ) values (
          v_prov,  -- 0373
          v_org, v_component.item_id, 'bundle_distribution', -v_draw,
          v_prev, v_new, 'bundle_distribution', 'bundle',
          p_bundle_id, v_user, p_notes
        );
      end if;

      if v_short > 0 then
        if not p_allow_shortage and not v_component.is_optional then
          raise exception 'insufficient_stock' using detail = v_component.item_id::text;
        end if;
        if not v_component.is_optional then
          v_shortage := true;
        end if;
        -- 0365: the zero-quantity shortage row goes on the item only when the
        -- item is stocked here; one kept in another warehouse (or deleted) was
        -- not short, it was not here, and its history should not say so. The
        -- distribution itself still records the shortage.
        if not v_component.is_optional
           and v_component.deleted_at is null
           and coalesce(v_component.item_wh, p_warehouse_id) = p_warehouse_id then
          insert into public.stock_movements (
            organization_id, item_id, movement_type, quantity_change,
            previous_quantity, new_quantity, reason, reference_type,
            reference_id, user_id, notes
          ) values (
            v_org, v_component.item_id, 'bundle_shortage', 0,
            v_component.quantity_on_hand, v_component.quantity_on_hand,
            'no_stock', 'bundle', p_bundle_id, v_user,
            'short ' || v_short::text || ' units during bundle distribution'
          );
        end if;
      end if;
    end loop;
    -- 0404: no kit from components without a required component.
    if v_required = 0 then  -- 0404
      raise exception 'bundle_no_required_components' using errcode = 'P0001';  -- 0404
    end if;  -- 0404
  end if;

  insert into public.bundle_distributions (
    organization_id, bundle_id, warehouse_id, quantity,
    schedule_event_id, notes, shortage_recorded, distributed_by
  ) values (
    v_org, p_bundle_id, p_warehouse_id, p_quantity,
    p_schedule_event_id, p_notes, v_shortage, v_user
  )
  returning id into v_distribution_id;

  if p_idempotency_key is not null then
    update public.idempotency_keys
       set status = 'completed', resource_id = v_distribution_id, updated_at = now()
     where organization_id = v_org
       and scope = 'bundle_distribution'
       and key = p_idempotency_key;
  end if;

  return v_distribution_id;
end;
$function$;

-- 1c. public.distribute_bundle (the 0359 wrapper): restated from
-- 0359_ledger_flag_carriers.sql; md5(prosrc) f0ef2bde4103221457cf632769ce36c7 ->
-- 4b731f8a78341906009971d042f5ed56. The 0404 lines are the permission gate.
-- Name, arguments, defaults, return type, SECURITY INVOKER, search_path, owner
-- and grants are unchanged (CREATE OR REPLACE keeps the owner and the grants):
-- installed phones reach it through the API, never by name, but the frozen
-- contract (0359) stands.
CREATE OR REPLACE FUNCTION public.distribute_bundle(p_bundle_id uuid, p_quantity numeric, p_warehouse_id uuid, p_allow_shortage boolean, p_schedule_event_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_prev text := current_setting('stockpilot.ledger', true);
  v_id   uuid;
begin
  -- 0404: a direct call needs bundles:distribute, or the Schedule's completion of this kit's event.
  if current_user in ('authenticated', 'anon')  -- 0404
     and not ledger.active()  -- 0404
     and exists (select 1  -- 0404
                   from public.bundles x  -- 0404
                  where x.id = p_bundle_id  -- 0404
                    and not public.has_permission(x.organization_id, 'bundles:distribute')  -- 0404
                    and not (public.has_permission(x.organization_id, 'schedule:manage')  -- 0404
                             and public.module_enabled(x.organization_id, 'schedule')  -- 0404
                             and exists (select 1  -- 0404
                                           from public.schedule_events e  -- 0404
                                          where e.id = p_schedule_event_id  -- 0404
                                            and e.organization_id = x.organization_id  -- 0404
                                            and e.status = 'completed'  -- 0404
                                            and e.bundle_id = x.id  -- 0404
                                            and e.bundle_quantity = p_quantity  -- 0404
                                            and e.bundle_warehouse_id = p_warehouse_id))) then  -- 0404
    raise exception 'forbidden'  -- 0404
      using errcode = '42501',  -- 0404
            hint    = 'permission',  -- 0404
            detail  = 'Distributing a kit needs the bundles:distribute permission.';  -- 0404
  end if;  -- 0404
  perform set_config('stockpilot.ledger', pg_current_xact_id()::text, true);
  v_id := ledger.distribute_bundle(
    p_bundle_id, p_quantity, p_warehouse_id, p_allow_shortage,
    p_schedule_event_id, p_notes, p_idempotency_key);
  perform set_config('stockpilot.ledger', coalesce(v_prev, ''), true);
  return v_id;
end;
$function$;

comment on function public.distribute_bundle(uuid, numeric, uuid, boolean, uuid, text, text) is
  'Stock-ledger RPC (0359 wrapper): raises stockpilot.ledger for the call, runs ledger.distribute_bundle as the caller, then restores the previous value. Name, signature, return type, INVOKER and grants are frozen: installed phones call it. Since 0404 an API role''s direct call needs bundles:distribute, or, for the Schedule''s completion of an event that hands out this kit, schedule:manage with the Schedule module on and a completed event naming this kit, quantity and warehouse (42501 forbidden, hint permission); a call made inside another ledger call of the same transaction is not asked again.';

-- ═══ 2. The lock prelude (see LOCKS above) ═══════════════════════════════
-- Every table lock the four ALTER POLICY statements and the trigger take, at
-- once and without waiting. Inside DO because the CLI batch is not a
-- transaction block (a top-level LOCK TABLE refuses there, 0373); the locks
-- last until the batch commits.
--   * bundles and bundle_components: ACCESS EXCLUSIVE (ALTER POLICY; the
--     component policy's expression also reads bundles).
--   * bundle_distributions: SHARE ROW EXCLUSIVE (CREATE TRIGGER).
--   * every existing table supautils.policy_grants lists for this role, the
--     parent only of a partitioned one (supautils 3.4.0 takes ACCESS EXCLUSIVE
--     on each whenever this role runs ALTER POLICY).
-- A busy table fails the attempt at once; the rollback releases what it took
-- and the next attempt starts after 50 to 150 ms holding no table lock. After
-- the 40th busy attempt the 55P03 is raised as it is (never 40001/40P01) and
-- nothing in the file is applied.
do $lock404$
declare
  v_grants text := nullif(current_setting('supautils.policy_grants', true), '');
  v_name   text;
  v_rel    regclass;
  v_try    integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.bundles, public.bundle_components in access exclusive mode nowait;
      lock table only public.bundle_distributions in share row exclusive mode nowait;
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
end $lock404$;

-- ═══ 3. bundle_components_write: the item's organization, and bundles:manage ═══
-- 0140's text with two terms added. USING gets the permission only, so a row
-- that already names another organization's item can still be deleted.
alter policy bundle_components_write on public.bundle_components
  using (
    exists (
      select 1 from public.bundles b
      where b.id = bundle_components.bundle_id
        and (SELECT public.has_org_role(b.organization_id, 'manager'))
        -- 0404: the permission the app asserts before every component write.
        and (SELECT public.has_permission(b.organization_id, 'bundles:manage'))
    )
  )
  with check (
    exists (
      select 1 from public.bundles b
      where b.id = bundle_components.bundle_id
        and (SELECT public.has_org_role(b.organization_id, 'manager'))
        -- 0404: the permission the app asserts before every component write.
        and (SELECT public.has_permission(b.organization_id, 'bundles:manage'))
        -- 0404: the component is an item of the bundle's own organization.
        and (SELECT public.item_in_org(bundle_components.item_id, b.organization_id))
    )
  );

-- ═══ 4. bundles: insert, update and delete follow bundles:manage ═══════════
-- 0140's text with the permission added. bundles_update keeps its USING
-- (distribute_bundle's SELECT ... FOR UPDATE is filtered by it; see the
-- header), so only the row an update writes must pass the permission.
alter policy bundles_insert on public.bundles
  with check (
    (SELECT public.has_org_role(organization_id, 'manager'))
    and (SELECT public.has_permission(organization_id, 'bundles:manage'))
  );

alter policy bundles_update on public.bundles
  with check (
    (SELECT public.has_org_role(organization_id, 'manager'))
    and (SELECT public.has_permission(organization_id, 'bundles:manage'))
  );

alter policy bundles_delete on public.bundles
  using (
    (SELECT public.has_org_role(organization_id, 'admin'))
    and (SELECT public.has_permission(organization_id, 'bundles:manage'))
  );

-- ═══ 5. bundle_distributions: written only by distribute_bundle ═══════════
-- 0359's guard: an API role's write needs ledger.active(), which only the
-- ledger wrappers raise. The owner (FK actions, the organization and account
-- deletions) and service_role are not held.
create or replace trigger trg_zz_bundle_distributions_guard
  before insert or update or delete on public.bundle_distributions
  for each row execute function public.tg_ledger_only_guard();

reset lock_timeout;
