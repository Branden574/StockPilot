-- 0464_retry_keys_match_their_record.sql
--
-- A retry answers only the record its key was written with (docket S96, part
-- one). A receipt post or a kit hand-out sent again with the same retry key
-- gets back the receipt or distribution that key's first call made, and only
-- when that record is the one this call describes; anything else is refused
-- with the conflict an edited retry already gets. DB-only. No stored row is
-- deleted, rewritten or bulk-changed, and no column is dropped or retyped.
--
-- ── WHAT ──────────────────────────────────────────────────────────────────
-- 0. Preflight: refuse (55000, hint s96_preflight, nothing applied) unless
--    both bodies below are the live text they were built from (md5(prosrc)
--    and posture), bundle_distributions has no idempotency_key column yet,
--    and anon, authenticated and service_role each hold the eight table
--    privileges 0402 granted on idempotency_keys, with no column grant and
--    nothing for PUBLIC.
-- 1. ledger.post_receipt_v2 and ledger.distribute_bundle (SECURITY INVOKER,
--    the ledger bodies behind the 0359 wrappers) are restated from their live
--    pg_get_functiondef text with lines added, each ending in '-- 0464';
--    nothing else in either body changes (the post-condition after each
--    proves it: the body minus its '-- 0464' lines is the live body, md5).
--    Name, arguments, defaults, return type, SECURITY INVOKER, search_path,
--    owner, comment and grants stay (CREATE OR REPLACE keeps them). The
--    receipt body keeps 0366's kit-stock refusal (its own post-condition is
--    re-run here). The two public wrappers are not touched.
--    * Receipts: a stored key with the same request hash answers its receipt
--      only when that receipt is of this organization, purchase order and
--      warehouse, carries this key, was received by the caller (auth.uid())
--      and carries this request's immutable hash; otherwise 55000
--      idempotency_conflict, the same refusal as an edited retry.
--    * Kits: a completed stored key with the same request hash answers its
--      distribution only when that distribution is of this organization, kit
--      and warehouse, has this quantity at the column's scale
--      (round(p_quantity, 4); the column is numeric(14,4)), was handed out by
--      the caller, and carries this key. A distribution written before this
--      file carries no key; it matches when its distributed_at equals the key
--      row's created_at, because the body writes both rows in one transaction
--      and both take now() (the transaction's start time). Otherwise 55000
--      idempotency_conflict.
--    * Kits: a keyed send stores its key on the distribution (new column,
--      step 3). A keyless send writes no key row and stores no key, as before.
--    * Both: the body raises the transaction flag stockpilot.idempotency_write
--      (the transaction id, local to the transaction) around each of its own
--      writes to idempotency_keys and then puts the previous value back
--      (allowlist M in security_invariants.test.sql).
-- 2. The lock prelude (LOCKS below).
-- 3. bundle_distributions gains idempotency_key text: nullable, no default,
--    no index (a replay reads the distribution by its id). Existing rows are
--    not touched: they read as null, which step 1's kit match handles. The
--    table is written only inside distribute_bundle's body (0415's ledger
--    guard), so the stored key is the ledger's.
-- 4. Grants on public.idempotency_keys:
--      anon          nothing (REVOKE ALL; no path uses it)
--      authenticated SELECT, INSERT, UPDATE kept (the two INVOKER bodies
--                    read the table with FOR UPDATE and write it as the
--                    caller); DELETE, TRUNCATE, REFERENCES, TRIGGER and
--                    MAINTAIN revoked (no function deletes a key row)
--      service_role  unchanged (all eight)
--    No policy changes. Grants on every other object stay as they were:
--    bundle_distributions keeps its table grants (the new column follows
--    them; no column grant), and both functions keep EXECUTE for
--    authenticated and service_role only.
-- 5. Post-conditions: the new md5s, the grants and the column.
--
-- ── LOCKS ─────────────────────────────────────────────────────────────────
-- The preflight reads catalogs only. CREATE OR REPLACE FUNCTION (plpgsql,
-- which resolves names at run time), and REVOKE on idempotency_keys take no
-- table lock. ALTER TABLE ... ADD COLUMN takes ACCESS EXCLUSIVE on
-- bundle_distributions (catalog only: no rewrite, no scan). A keyed kit
-- hand-out in flight writes idempotency_keys first and bundle_distributions
-- later; this file takes no lock on idempotency_keys, so the two cannot wait
-- on each other in a cycle. The prelude takes the one lock NOWAIT, inside a
-- subtransaction that retries up to 40 times with a 50 to 150 ms pause
-- holding nothing (the 0390, 0415 and 0421 pattern), and no later statement
-- takes a new table lock: the file never waits while holding one. From the
-- prelude to the commit (milliseconds) reads and writes of
-- bundle_distributions wait for the hold. lock_timeout 900ms bounds anything
-- unforeseen (a REVOKE waits for another session's uncommitted DDL on the
-- same table). scripts/db-concurrency/0464_migration_lock_footprint.sh
-- measures all of this.
--
-- ── ERRORS ────────────────────────────────────────────────────────────────
-- The bodies raise 55000 idempotency_conflict, the message every caller
-- already matches (the web receiving and bundles services, the phone's
-- receipt error map). The push raises 55000 hint s96_preflight (drift or a
-- second run; nothing applied) or 55P03 (busy; nothing applied, run it
-- again). Never 40001 or 40P01 (PostgREST retries those, 0367).
--
-- ── ORDER ─────────────────────────────────────────────────────────────────
-- After every lower number. A queued migration that restates either body or
-- changes the grants on idempotency_keys must be rebuilt on this one; the
-- preflight's md5 pins stop the push of whichever goes second if it was not.

set lock_timeout = '900ms';

-- ═══ 0. Preflight ═══════════════════════════════════════════════════════════
do $pre_s96$
declare
  v_bad text := '';
  v_got text;
  r record;
begin
  for r in
    select v.sig, v.want_src, v.want_cfg, p.oid as poid,
           md5(p.prosrc) as got_src, p.prosecdef as got_secdef, p.provolatile::text as got_vol,
           coalesce(array_to_string(p.proconfig, ';'), '') as got_cfg,
           pg_get_userbyid(p.proowner) as got_owner,
           p.proisstrict as got_strict, p.proleakproof as got_leak, p.proparallel::text as got_par
      from (values
        ('ledger.post_receipt_v2(uuid,uuid,jsonb,text,text,text)',             'f044c3a1ea7b125a094a42f736db77c8', 'search_path=public, extensions'),
        ('ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)', 'ebe22d594c11813464c7d50accae54a7', 'search_path=public')
      ) v(sig, want_src, want_cfg)
      left join pg_proc p on p.oid = to_regprocedure(v.sig)
  loop
    if r.poid is null then
      v_bad := v_bad || format(' %s missing;', r.sig);
    elsif r.got_src <> r.want_src or r.got_secdef or r.got_vol <> 'v'
          or r.got_cfg <> r.want_cfg or r.got_owner <> 'postgres'
          or r.got_strict or r.got_leak or r.got_par <> 'u' then
      v_bad := v_bad || format(' %s drifted (md5 %s, definer %s, volatility %s, %s, owner %s, strict %s, leakproof %s, parallel %s);',
                               r.sig, r.got_src, r.got_secdef, r.got_vol, r.got_cfg, r.got_owner,
                               r.got_strict, r.got_leak, r.got_par);
    end if;
  end loop;

  if exists (select 1 from pg_attribute a
              where a.attrelid = 'public.bundle_distributions'::regclass
                and a.attname = 'idempotency_key' and not a.attisdropped) then
    v_bad := v_bad || ' bundle_distributions.idempotency_key already exists;';
  end if;

  for r in
    select g.rolname,
           coalesce((select string_agg(x.privilege_type || case when x.is_grantable then '*' else '' end, ',' order by x.privilege_type)
                       from pg_class c, aclexplode(c.relacl) x
                      where c.oid = 'public.idempotency_keys'::regclass
                        and x.grantee = case when g.rolname = 'PUBLIC' then 0::oid
                                             else (select o.oid from pg_roles o where o.rolname = g.rolname) end), '') as got,
           g.want
      from (values
        ('anon',          'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
        ('authenticated', 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
        ('service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
        ('PUBLIC',        '')
      ) g(rolname, want)
  loop
    if r.got <> r.want then
      v_bad := v_bad || format(' idempotency_keys grants of %s drifted (%s);', r.rolname, r.got);
    end if;
  end loop;
  select string_agg(a.attname, ',' order by a.attname) into v_got
    from pg_attribute a
   where a.attrelid = 'public.idempotency_keys'::regclass and a.attnum > 0 and a.attacl is not null;
  if v_got is not null then
    v_bad := v_bad || format(' idempotency_keys has column grants (%s);', v_got);
  end if;

  if v_bad <> '' then
    raise exception 's96_preflight:%', v_bad
      using errcode = '55000', hint = 's96_preflight';
  end if;
end
$pre_s96$;

-- ═══ 1. Functions (plpgsql only: no table lock is taken here) ═══════════════
-- 1a. ledger.post_receipt_v2: restated from its live text (0349's body, moved
-- to ledger by 0359, with 0366's kit-stock block and 0367's SQLSTATE);
-- md5(prosrc) f044c3a1ea7b125a094a42f736db77c8 -> ecd99069fa482371ac5bafeb3363b248.
-- The 0464 lines match a replay to its receipt and raise the key flag around
-- the key insert.
CREATE OR REPLACE FUNCTION ledger.post_receipt_v2(p_purchase_order_id uuid, p_warehouse_id uuid, p_lines jsonb, p_idempotency_key text, p_request_hash text, p_notes text DEFAULT NULL::text)
 RETURNS receipts
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_receipt       public.receipts%rowtype;
  v_existing      public.idempotency_keys%rowtype;
  v_line          record;
  v_po            public.purchase_orders%rowtype;
  v_org           uuid;
  v_item_id       uuid;
  v_tracking      text;
  v_inserted_line uuid;
  v_lot           record;
  v_serial        text;
  v_lot_sum       numeric;
  v_serial_count  int;
  v_po_line       record;
  v_staging       uuid;
  v_idem_prev     text := current_setting('stockpilot.idempotency_write', true); -- 0464
begin
  select * into v_po from public.purchase_orders where id = p_purchase_order_id for update;
  if not found then raise exception 'po_not_found' using errcode = 'P0002'; end if;
  v_org := v_po.organization_id;

  select * into v_existing
    from public.idempotency_keys
    where organization_id = v_org
      and scope = 'receipt'
      and key = p_idempotency_key
    for update;
  if found then
    if v_existing.request_hash = p_request_hash then
      select * into v_receipt from public.receipts where id = v_existing.resource_id;
      -- 0464: the stored key answers only the receipt it was written with.
      if not coalesce(v_receipt.organization_id = v_org -- 0464
                      and v_receipt.purchase_order_id = v_po.id -- 0464
                      and v_receipt.warehouse_id = p_warehouse_id -- 0464
                      and v_receipt.idempotency_key = p_idempotency_key -- 0464
                      and v_receipt.received_by = auth.uid() -- 0464
                      and v_receipt.immutable_hash = encode(digest(p_request_hash, 'sha256'), 'hex'), false) then -- 0464
        raise exception 'idempotency_conflict' using errcode = '55000'; -- 0464
      end if; -- 0464
      return v_receipt;
    else
      raise exception 'idempotency_conflict' using errcode = '55000';
    end if;
  end if;

  if not public.has_org_role(v_org, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- 0349: a DRAFT is not receivable. It is not closed either — it has not been
  -- ORDERED, and ordering is the transition that must clear the PO approval
  -- threshold. Distinct error so the operator is told the right next step.
  if v_po.status = 'draft' then
    raise exception 'po_not_ordered' using errcode = '22023';
  end if;
  if v_po.status not in ('expected_inbound','ordered','partially_received') then
    raise exception 'po_already_closed' using errcode = '22023';
  end if;

  -- Resolve (creating if needed) the warehouse Staging location.
  perform public.ensure_warehouse_placement_locations(p_warehouse_id);
  select id into v_staging from public.locations
    where warehouse_id = p_warehouse_id and kind = 'staging' and deleted_at is null
    limit 1;

  insert into public.receipts(
    organization_id, purchase_order_id, warehouse_id, receipt_number,
    received_by, idempotency_key, immutable_hash, notes
  ) values (
    v_org, v_po.id, p_warehouse_id,
    'R-' || to_char(now(),'YYYYMMDD-HH24MISS') || '-' || substr(gen_random_uuid()::text, 1, 6),
    auth.uid(), p_idempotency_key,
    encode(digest(p_request_hash, 'sha256'), 'hex'),
    p_notes
  ) returning * into v_receipt;

  for v_line in select * from jsonb_to_recordset(p_lines) as x(
    po_line_id uuid, qty_received numeric, qty_accepted numeric,
    qty_rejected numeric, unit_cost numeric, notes text,
    lots jsonb, serials jsonb
  ) loop
    -- Quantity sanity: per-line quantities must be non-negative. Over-receipt
    -- (accepted + already-received > ordered) is ALLOWED (owner decision
    -- 2026-07-21) — vendors over-ship; the receipt Notes record why.
    if coalesce(v_line.qty_received, 0) < 0
       or coalesce(v_line.qty_accepted, 0) < 0
       or coalesce(v_line.qty_rejected, 0) < 0 then
      raise exception 'negative_quantity' using errcode = '23514';
    end if;

    select id, item_id, quantity_received, quantity_ordered
      into v_po_line
      from public.purchase_order_items
      where id = v_line.po_line_id
        and purchase_order_id = v_po.id
      for update;
    if not found then
      raise exception 'po_line_not_found' using errcode = 'P0002';
    end if;
    v_item_id := v_po_line.item_id;

    -- 0366: kit stock is never received. A line for a kit's pre-assembled
    -- stock (is_bundle) would add kits with no component drawn. Read past RLS
    -- through po_line_items_not_orderable (the caller is a manager, checked
    -- above). A 0 on the line still posts, and a DELETED item's line stays
    -- receivable: its goods arrived, and nothing restores a deleted item.
    if coalesce(v_line.qty_accepted, 0) > 0
       and exists (select 1
                     from public.po_line_items_not_orderable(v_org, array[v_item_id]) as r
                    where r.refusal = 'po_line_bundle') then
      raise exception '% is a pre-assembled kit, so it can''t be received: receiving it would add kits without using any of their components. Leave this line at 0 and receive the rest; kits are built from their components.',
        coalesce('"' || (select nullif(btrim(it.name), '')
                           from public.inventory_items it
                          where it.id = v_item_id and it.organization_id = v_org) || '"',
                 'An item on this purchase order')
        using errcode = '22023', hint = 'po_line_bundle';
    end if;

    -- (over-receive guard removed 2026-07-21 — see migration 0285 header)

    select tracking_type into v_tracking
      from public.inventory_items where id = v_item_id;

    -- Validate tracking-type-specific inputs BEFORE doing any writes.
    if v_tracking = 'lot' then
      if v_line.qty_accepted > 0 then
        if v_line.lots is null or jsonb_array_length(v_line.lots) = 0 then
          raise exception 'lot_required' using errcode = '23514';
        end if;
        select coalesce(sum((elem->>'qty_base')::numeric), 0) into v_lot_sum
          from jsonb_array_elements(v_line.lots) elem;
        if abs(v_lot_sum - v_line.qty_accepted) > 0.0001 then
          raise exception 'lot_qty_mismatch' using errcode = '23514';
        end if;
      end if;
    elsif v_tracking = 'serial' then
      if v_line.qty_accepted > 0 then
        if v_line.serials is null then
          raise exception 'serials_required' using errcode = '23514';
        end if;
        v_serial_count := jsonb_array_length(v_line.serials);
        if v_serial_count <> v_line.qty_accepted::int then
          raise exception 'serial_count_mismatch' using errcode = '23514';
        end if;
      end if;
    elsif v_tracking = 'serial_optional' then
      -- 0296. Serials are WELCOME, never required. A null/absent array
      -- and an empty array are both a legitimate pure-quantity receipt -- this
      -- is the branch that makes fake placeholder serials unnecessary.
      -- The only failure is claiming MORE tagged units than actually arrived,
      -- which would double-count against the quantity posted below.
      if v_line.qty_accepted > 0 and v_line.serials is not null then
        v_serial_count := jsonb_array_length(v_line.serials);
        if v_serial_count > v_line.qty_accepted::int then
          raise exception 'serial_count_exceeds_quantity' using errcode = '23514';
        end if;
      end if;
    end if;

    if v_line.qty_accepted > 0 then
      perform public.adjust_stock(
        v_item_id,
        v_line.qty_accepted,
        'receive_po',
        v_staging,       -- route accepted qty into the warehouse Staging location
        'PO ' || coalesce(v_po.po_number, 'receipt'),
        v_receipt.id::text
      );
    end if;

    insert into public.receipt_lines(
      receipt_id, purchase_order_line_id, item_id,
      qty_received_base, qty_accepted_base, qty_rejected_base,
      unit_cost, notes
    ) values (
      v_receipt.id, v_line.po_line_id, v_item_id,
      v_line.qty_received, v_line.qty_accepted, coalesce(v_line.qty_rejected, 0),
      coalesce(v_line.unit_cost, 0), v_line.notes
    ) returning id into v_inserted_line;

    -- Persist lot rows (only when tracking_type='lot' and qty_accepted > 0)
    if v_tracking = 'lot' and v_line.qty_accepted > 0 then
      for v_lot in select * from jsonb_to_recordset(v_line.lots) as x(
        lot_number text, expiration_date date, qty_base numeric
      ) loop
        insert into public.receipt_line_lots(
          receipt_line_id, lot_number, expiration_date, qty_base
        ) values (
          v_inserted_line, v_lot.lot_number, v_lot.expiration_date, v_lot.qty_base
        );
      end loop;
    end if;

    -- Serial persistence. 'serial' is unchanged (its validation block already
    -- guarantees a non-null array whenever qty_accepted > 0). 'serial_optional'
    -- joins it, guarded on a non-null array so the common no-serials case does
    -- no work.
    if v_tracking in ('serial', 'serial_optional')
       and v_line.qty_accepted > 0
       and v_line.serials is not null then
      for v_serial in select * from jsonb_array_elements_text(v_line.serials) loop
        insert into public.serial_registry(
          organization_id, item_id, serial_number, warehouse_id, receipt_line_id
        ) values (
          v_org, v_item_id, v_serial, p_warehouse_id, v_inserted_line
        );
      end loop;
    end if;

    update public.purchase_order_items
      set quantity_received = quantity_received + v_line.qty_accepted
      where id = v_line.po_line_id;
  end loop;

  perform public.recompute_po_status(v_po.id);

  perform set_config('stockpilot.idempotency_write', pg_current_xact_id()::text, true); -- 0464
  insert into public.idempotency_keys(
    organization_id, scope, key, request_hash, status, resource_type, resource_id
  ) values (
    v_org, 'receipt', p_idempotency_key, p_request_hash, 'completed',
    'receipt', v_receipt.id
  );
  perform set_config('stockpilot.idempotency_write', coalesce(v_idem_prev, ''), true); -- 0464

  return v_receipt;
end;
$function$;

-- 1b. ledger.distribute_bundle: restated from its live text (0415's body);
-- md5(prosrc) ebe22d594c11813464c7d50accae54a7 -> f0fac64fbdabf5870422e7b8fc3f7df3.
-- The 0464 lines match a replay to its distribution, store the key on the
-- distribution and raise the key flag around the two key writes.
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
  v_idem_prev text := current_setting('stockpilot.idempotency_write', true); -- 0464
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
         -- 0464: and only for the distribution it was written with.
         and exists (select 1 from public.bundle_distributions d -- 0464
                      where d.id = v_existing.resource_id -- 0464
                        and d.organization_id = v_org -- 0464
                        and d.bundle_id = p_bundle_id -- 0464
                        and d.warehouse_id = p_warehouse_id -- 0464
                        and d.quantity = round(p_quantity, 4) -- 0464
                        and d.distributed_by = v_user -- 0464
                        and (d.idempotency_key = p_idempotency_key -- 0464
                             or (d.idempotency_key is null and d.distributed_at = v_existing.created_at))) -- 0464
         and v_existing.resource_id is not null then
        return v_existing.resource_id;
      end if;
      raise exception 'idempotency_conflict' using errcode = '55000';
    end if;
    perform set_config('stockpilot.idempotency_write', pg_current_xact_id()::text, true); -- 0464
    insert into public.idempotency_keys
      (organization_id, scope, key, request_hash, status, resource_type)
    values
      (v_org, 'bundle_distribution', p_idempotency_key, v_request_hash, 'in_progress', 'bundle_distribution');
    perform set_config('stockpilot.idempotency_write', coalesce(v_idem_prev, ''), true); -- 0464
  end if;

  -- Phantom allocation
  if v_bundle.phantom_item_id is not null then
    select quantity_on_hand, warehouse_id, deleted_at
      into v_phantom_qty, v_phantom_wh, v_phantom_deleted
    from public.inventory_items
    where id = v_bundle.phantom_item_id for update;
    -- 0404: the kit's item is this kit's own: a kit item of its organization no other bundle names.
    if not public.item_in_org(v_bundle.phantom_item_id, v_org)  -- 0404
       or exists (select 1 from public.inventory_items i  -- 0404
                   where i.id = v_bundle.phantom_item_id and not i.is_bundle)  -- 0404
       or exists (select 1 from public.bundles x  -- 0404
                   where x.organization_id = v_org and x.phantom_item_id = v_bundle.phantom_item_id and x.id <> p_bundle_id) then  -- 0404
      raise exception 'phantom_not_kit_item' using errcode = 'P0001';  -- 0404
    end if;  -- 0404
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
      -- 0404: and never the kit's own item.
      if v_component.item_id = v_bundle.phantom_item_id then  -- 0404
        raise exception 'component_is_kit_item' using errcode = 'P0001';  -- 0404
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
    , idempotency_key -- 0464
  ) values (
    v_org, p_bundle_id, p_warehouse_id, p_quantity,
    p_schedule_event_id, p_notes, v_shortage, v_user
    , p_idempotency_key -- 0464
  )
  returning id into v_distribution_id;

  if p_idempotency_key is not null then
    perform set_config('stockpilot.idempotency_write', pg_current_xact_id()::text, true); -- 0464
    update public.idempotency_keys
       set status = 'completed', resource_id = v_distribution_id, updated_at = now()
     where organization_id = v_org
       and scope = 'bundle_distribution'
       and key = p_idempotency_key;
    perform set_config('stockpilot.idempotency_write', coalesce(v_idem_prev, ''), true); -- 0464
  end if;

  return v_distribution_id;
end;
$function$;

-- 1c. Post-conditions of step 1: each body is its live text plus the 0464
-- lines and nothing else, and the receipt body still carries 0366's check.
do $post_s96_fn$
declare
  r record;
begin
  for r in
    select v.sig, v.want_new, v.want_old, md5(p.prosrc) as got_new,
           md5(regexp_replace(p.prosrc, '\n[^\n]*-- 0464[^\n]*', '', 'g')) as got_old,
           p.prosecdef, coalesce(array_to_string(p.proconfig, ';'), '') as cfg, v.want_cfg,
           pg_get_userbyid(p.proowner) as owner,
           has_function_privilege('anon', p.oid, 'execute') as anon_x,
           has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
           has_function_privilege('service_role', p.oid, 'execute') as svc_x
      from (values
        ('ledger.post_receipt_v2(uuid,uuid,jsonb,text,text,text)',             'ecd99069fa482371ac5bafeb3363b248', 'f044c3a1ea7b125a094a42f736db77c8', 'search_path=public, extensions'),
        ('ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)', 'f0fac64fbdabf5870422e7b8fc3f7df3', 'ebe22d594c11813464c7d50accae54a7', 'search_path=public')
      ) v(sig, want_new, want_old, want_cfg)
      join pg_proc p on p.oid = v.sig::regprocedure
  loop
    if r.got_new <> r.want_new or r.got_old <> r.want_old or r.prosecdef or r.cfg <> r.want_cfg
       or r.owner <> 'postgres' or r.anon_x or not r.auth_x or not r.svc_x then
      raise exception 's96: % did not take its restatement (md5 %, without the 0464 lines %, definer %, %, owner %, execute anon %, authenticated %, service_role %)',
        r.sig, r.got_new, r.got_old, r.prosecdef, r.cfg, r.owner, r.anon_x, r.auth_x, r.svc_x
        using errcode = '55000', hint = 's96_postcondition';
    end if;
  end loop;
  if (select position('po_line_items_not_orderable(v_org, array[v_item_id])' in p.prosrc) = 0
        from pg_proc p where p.oid = 'ledger.post_receipt_v2(uuid,uuid,jsonb,text,text,text)'::regprocedure) then
    raise exception 's96: ledger.post_receipt_v2 lost the kit-stock check (0366)'
      using errcode = '55000', hint = 's96_postcondition';
  end if;
end
$post_s96_fn$;

-- ═══ 2. The lock prelude (see LOCKS above) ═══════════════════════════════════
-- The one table lock the file takes: ACCESS EXCLUSIVE on bundle_distributions
-- for ADD COLUMN. Inside DO because the CLI batch is not a transaction block
-- (a top-level LOCK TABLE refuses there, 0373); the lock lasts until the
-- batch commits. A busy table fails the attempt at once; the rollback
-- releases what it took and the next attempt starts after 50 to 150 ms
-- holding no table lock. After the 40th busy attempt the 55P03 is raised as
-- it is (never 40001/40P01) and nothing in the file is applied.
do $lock_s96$
declare
  v_try integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.bundle_distributions in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if v_try >= 40 then
        raise;
      end if;
    end;
    perform pg_sleep(0.05 + random() * 0.1);
  end loop;
end $lock_s96$;

-- ═══ 3. The key on the distribution ═════════════════════════════════════════
alter table public.bundle_distributions add column idempotency_key text;

comment on column public.bundle_distributions.idempotency_key is
  'The retry key of the call that made this distribution (0464), set by ledger.distribute_bundle; null for a call without one and for a distribution made before 0464.';

-- ═══ 4. Grants on idempotency_keys ══════════════════════════════════════════
-- anon: nothing. authenticated: SELECT, INSERT and UPDATE stay (the INVOKER
-- bodies above read and write as the caller). service_role: unchanged.
revoke all on table public.idempotency_keys from anon;
revoke delete, truncate, references, trigger, maintain on table public.idempotency_keys from authenticated;

-- ═══ 5. Post-conditions ═════════════════════════════════════════════════════
do $post_s96$
declare
  v_bad text := '';
  r record;
begin
  for r in
    select g.rolname,
           coalesce((select string_agg(x.privilege_type || case when x.is_grantable then '*' else '' end, ',' order by x.privilege_type)
                       from pg_class c, aclexplode(c.relacl) x
                      where c.oid = 'public.idempotency_keys'::regclass
                        and x.grantee = case when g.rolname = 'PUBLIC' then 0::oid
                                             else (select o.oid from pg_roles o where o.rolname = g.rolname) end), '') as got,
           g.want
      from (values
        ('anon',          ''),
        ('authenticated', 'INSERT,SELECT,UPDATE'),
        ('service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
        ('PUBLIC',        '')
      ) g(rolname, want)
  loop
    if r.got <> r.want then
      v_bad := v_bad || format(' idempotency_keys grants of %s are %s;', r.rolname, r.got);
    end if;
  end loop;
  if not exists (select 1 from pg_attribute a
                  where a.attrelid = 'public.bundle_distributions'::regclass
                    and a.attname = 'idempotency_key' and not a.attisdropped
                    and a.atttypid = 'text'::regtype and not a.attnotnull and not a.atthasdef
                    and a.attacl is null) then
    v_bad := v_bad || ' bundle_distributions.idempotency_key is not a plain nullable text column;';
  end if;
  if v_bad <> '' then
    raise exception 's96:%', v_bad using errcode = '55000', hint = 's96_postcondition';
  end if;
end
$post_s96$;

reset lock_timeout;
