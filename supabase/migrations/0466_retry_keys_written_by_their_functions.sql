-- 0466_retry_keys_written_by_their_functions.sql
--
-- A row of idempotency_keys is written by the function that uses it (docket
-- S96, part two). An API role (authenticated, anon) inserts or updates a key
-- row only inside one of the four SECURITY INVOKER functions that keep retry
-- keys, and only around their own key write; the SECURITY DEFINER return
-- functions, the service role and the table owner are not held. Each function
-- also answers a replay only with the record its key stands for. DB-only. No
-- stored row is deleted, rewritten or bulk-changed, and no column is dropped
-- or retyped. Builds on 0464.
--
-- ── WHAT ──────────────────────────────────────────────────────────────────
-- 0. Preflight: refuse (55000, hint s96b_preflight, nothing applied) unless
--    the four bodies below are the live text they were built from (md5(prosrc)
--    and posture), the guard function and trigger do not exist,
--    idempotency_keys has exactly its one updated_at trigger, and its grants
--    are 0464's (anon nothing; authenticated SELECT, INSERT, UPDATE;
--    service_role all eight).
-- 1. Four SECURITY INVOKER bodies, restated from their live pg_get_functiondef
--    text with lines added, each ending in '-- 0466'; nothing else changes
--    (the post-condition proves it: each body minus its '-- 0466' lines is the
--    live body, md5). Name, arguments, defaults, return type, SECURITY
--    INVOKER, SET clauses, owner, comment and grants stay (CREATE OR REPLACE
--    keeps them).
--    * ledger.post_receipt_v2 (0464's body, its '-- 0464' lines kept): a key
--      that no key row holds is new only when no receipt of this purchase
--      order carries it; otherwise 55000 idempotency_conflict, the refusal a
--      retry with other details gets. Checked after the role check, read
--      through receipts_po_idx.
--    * ledger.distribute_bundle (0464's body, its '-- 0464' lines kept): the
--      same for a keyed hand-out: no distribution of this kit may carry the
--      key already (bundle_distributions_bundle_idx); otherwise 55000.
--    * public.start_targeted_recount (0372's body): raises the flag around its
--      key insert and its key update; a replay whose stored answer names
--      another count than the key row is refused P0001 idempotency_conflict
--      (the existing refusal, message and hint). The match reads only the
--      key row: no table read through the caller's row rules.
--    * public.draft_order_shortfall_pos (0385's body): raises the flag around
--      its key insert and its key update; a replay is answered only for this
--      order (the key row's resource and the stored orderId), and only when
--      every stored draft the caller can read is of this organization and was
--      made by the caller; otherwise P0001 idempotency_conflict, the message
--      and hint the web caller matches. A stored draft that cannot be read
--      keeps its existing answer.
--    In each body the flag is stockpilot.idempotency_write set to the
--    transaction id (local to the transaction) right before each key write
--    and set back to the value it had on entry right after it (allowlist M in
--    security_invariants.test.sql). 0464 did the same in the receipt and kit
--    bodies, so all four writers raise it.
-- 2. public.tg_idempotency_keys_guard() (SECURITY INVOKER, search_path
--    public; no role gets EXECUTE, as a trigger function fires without it):
--    for current_user authenticated or anon, an insert, update or delete of a
--    key row needs the flag equal to pg_current_xact_id(); otherwise 42501
--    idempotency_key_through_rpc. A value left by another transaction, or the
--    empty value a function leaves after its call, never matches.
-- 3. The lock prelude (LOCKS below).
-- 4. trg_zz_idempotency_keys_guard: BEFORE INSERT OR UPDATE OR DELETE, FOR
--    EACH ROW (CREATE OR REPLACE TRIGGER; 'zz' sorts it after
--    idempotency_keys_updated_at, and the guard only raises).
-- 5. Post-conditions: the new md5s, the guard, the trigger and the grants.
--
-- Grants: no grant changes. idempotency_keys keeps 0464's (anon nothing;
-- authenticated SELECT, INSERT, UPDATE; service_role all eight); the four
-- functions keep theirs; the guard function holds no EXECUTE for PUBLIC,
-- anon, authenticated or service_role. No policy changes.
--
-- ── LOCKS ─────────────────────────────────────────────────────────────────
-- The preflight reads catalogs only. CREATE OR REPLACE FUNCTION (plpgsql),
-- the guard function's REVOKE and the COMMENTs take no table lock. CREATE OR
-- REPLACE TRIGGER takes SHARE ROW EXCLUSIVE on idempotency_keys, which waits
-- for every open transaction that has written a key row. The file takes that
-- one lock in a NOWAIT prelude that retries up to 40 times with a 50 to 150
-- ms pause holding nothing (the 0390, 0415, 0421 and 0464 pattern), and no
-- later statement takes a new table lock: the file never waits while holding
-- one, so it cannot deadlock with a call that holds a key row and then
-- writes another table. From the prelude to the commit (milliseconds) key
-- writes wait for the hold; reads do not. lock_timeout 900ms bounds anything
-- unforeseen. scripts/db-concurrency/0466_migration_lock_footprint.sh
-- measures all of this.
--
-- ── A CALL IN FLIGHT DURING THE PUSH ──────────────────────────────────────
-- A recount or shortfall call that started under its earlier body and makes
-- its first key write after this file commits runs that earlier body, which
-- raises no flag: the guard refuses it (42501 idempotency_key_through_rpc)
-- and the whole call rolls back, so nothing is written. Sent again (the same
-- key), it runs the new body and goes through. Receipt posts and kit
-- hand-outs already raise the flag (0464), so they are not affected.
--
-- ── ERRORS ────────────────────────────────────────────────────────────────
-- The bodies raise 55000 idempotency_conflict (receipts, kits) and P0001
-- idempotency_conflict with hint idempotency_conflict (recounts, shortfall
-- drafts), the answers each caller already matches. The guard raises 42501
-- idempotency_key_through_rpc. The push raises 55000 hint s96b_preflight
-- (drift or a second run; nothing applied) or 55P03 (busy; nothing applied,
-- run it again). Never 40001 or 40P01 (PostgREST retries those, 0367).
--
-- ── ORDER ─────────────────────────────────────────────────────────────────
-- After 0464 (its bodies and grants are this file's starting point). A
-- queued migration that restates one of the four bodies or adds a writer of
-- idempotency_keys must be rebuilt on this one; the preflight's md5 pins stop
-- the push of whichever goes second if it was not.

set lock_timeout = '900ms';

-- ═══ 0. Preflight ═══════════════════════════════════════════════════════════
do $pre_s96b$
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
        ('ledger.post_receipt_v2(uuid,uuid,jsonb,text,text,text)',             'ecd99069fa482371ac5bafeb3363b248', 'search_path=public, extensions'),
        ('ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)', 'f0fac64fbdabf5870422e7b8fc3f7df3', 'search_path=public'),
        ('public.start_targeted_recount(uuid,uuid[],uuid[],text,text)',        'b22850a25b3b92d9a5f1ed02aa717aad', 'search_path=public;lock_timeout=5s'),
        ('public.draft_order_shortfall_pos(uuid,jsonb,text)',                  '1cf3a02ed7cb4b231ccc5f1e54ba0277', 'search_path=public, pg_temp;lock_timeout=5s')
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

  if to_regprocedure('public.tg_idempotency_keys_guard()') is not null then
    v_bad := v_bad || ' public.tg_idempotency_keys_guard() already exists;';
  end if;
  select string_agg(t.tgname, ',' order by t.tgname) into v_got
    from pg_trigger t where t.tgrelid = 'public.idempotency_keys'::regclass and not t.tgisinternal;
  if v_got is distinct from 'idempotency_keys_updated_at' then
    v_bad := v_bad || format(' idempotency_keys triggers are %s;', coalesce(v_got, 'none'));
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
        ('anon',          ''),
        ('authenticated', 'INSERT,SELECT,UPDATE'),
        ('service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
        ('PUBLIC',        '')
      ) g(rolname, want)
  loop
    if r.got <> r.want then
      v_bad := v_bad || format(' idempotency_keys grants of %s drifted (%s);', r.rolname, r.got);
    end if;
  end loop;

  if v_bad <> '' then
    raise exception 's96b_preflight:%', v_bad
      using errcode = '55000', hint = 's96b_preflight';
  end if;
end
$pre_s96b$;

-- ═══ 1. Functions (plpgsql only: no table lock is taken here) ═══════════════
-- 1a. ledger.post_receipt_v2: restated from its live text (0464's body);
-- md5(prosrc) ecd99069fa482371ac5bafeb3363b248 -> 43d8753704c547012befef950747b965.
-- The 0466 lines refuse a key that no key row holds when a receipt of this
-- purchase order already carries it.
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
  -- 0466: a key with no key row is new only when no receipt of this purchase order carries it.
  if exists (select 1 from public.receipts r -- 0466
              where r.purchase_order_id = v_po.id -- 0466
                and r.organization_id = v_org -- 0466
                and r.idempotency_key = p_idempotency_key) then -- 0466
    raise exception 'idempotency_conflict' using errcode = '55000'; -- 0466
  end if; -- 0466
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

-- 1b. ledger.distribute_bundle: restated from its live text (0464's body);
-- md5(prosrc) f0fac64fbdabf5870422e7b8fc3f7df3 -> 52aa32489d62af5c89355b67f6493ea3.
-- The 0466 lines refuse a key that no key row holds when a distribution of
-- this kit already carries it.
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
    -- 0466: a key with no key row is new only when no distribution of this kit carries it.
    if exists (select 1 from public.bundle_distributions d -- 0466
                where d.bundle_id = p_bundle_id -- 0466
                  and d.organization_id = v_org -- 0466
                  and d.idempotency_key = p_idempotency_key) then -- 0466
      raise exception 'idempotency_conflict' using errcode = '55000'; -- 0466
    end if; -- 0466
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

-- 1c. public.start_targeted_recount: restated from its live text (0372's
-- body); md5(prosrc) b22850a25b3b92d9a5f1ed02aa717aad -> 5096548529d92d7a7e8aec2b4791e305.
-- The 0466 lines raise the key flag around the key insert and the key update
-- and match a replay's stored answer to the key row's count.
CREATE OR REPLACE FUNCTION public.start_targeted_recount(p_org uuid, p_occurrence_ids uuid[] DEFAULT NULL::uuid[], p_item_ids uuid[] DEFAULT NULL::uuid[], p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
 SET lock_timeout TO '5s'
AS $function$
declare
  c_max_items   constant integer := 200;
  c_recountable constant text[]  := array['count_variance', 'over_reserved'];
  v_key         text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_notes       text := nullif(btrim(coalesce(p_notes, '')), '');
  v_occ_ids     uuid[];
  v_item_in     uuid[];
  v_hash        text;
  v_key_id      uuid;
  v_prev        record;
  v_n           integer;
  v_occ         jsonb := '[]'::jsonb;
  v_items       uuid[];
  v_lock_key    bigint;
  v_plan        jsonb;
  v_new_items   uuid[];
  v_header_wh   uuid;
  v_cc          uuid;
  v_cc_number   bigint;
  v_lines       integer := 0;
  v_targets     jsonb;
  v_t           record;
  v_linked      jsonb;
  v_existing    jsonb;
  v_skipped     jsonb;
  v_result      jsonb;
  v_idem_prev   text := current_setting('stockpilot.idempotency_write', true); -- 0466
begin
  -- ── 1. Floors ────────────────────────────────────────────────────────────
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_org is null then
    raise exception 'invalid_argument' using errcode = '22023', hint = 'invalid_argument';
  end if;
  if not public.has_org_role(p_org, 'manager')
     or not public.has_permission(p_org, 'cycle_counts:assign')
     or not public.has_permission(p_org, 'stock:adjust') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- ── 2. Arguments ─────────────────────────────────────────────────────────
  if array_position(p_occurrence_ids, null) is not null
     or array_position(p_item_ids, null) is not null then
    raise exception 'invalid_argument' using errcode = '22023', hint = 'invalid_argument';
  end if;
  v_occ_ids := array(select distinct x from unnest(coalesce(p_occurrence_ids, '{}'::uuid[])) x order by x);
  v_item_in := array(select distinct x from unnest(coalesce(p_item_ids, '{}'::uuid[])) x order by x);
  if cardinality(v_occ_ids) = 0 and cardinality(v_item_in) = 0 then
    raise exception 'recount_nothing_selected' using errcode = '22023', hint = 'recount_nothing_selected';
  end if;
  if cardinality(v_occ_ids) > c_max_items or cardinality(v_item_in) > c_max_items then
    raise exception 'recount_too_many_items' using errcode = '22023', hint = 'recount_too_many_items';
  end if;
  if char_length(v_notes) > 500 then
    raise exception 'notes_too_long' using errcode = '22023', hint = 'notes_too_long';
  end if;
  if char_length(v_key) > 200 then
    raise exception 'idempotency_key_too_long' using errcode = '22023', hint = 'idempotency_key_too_long';
  end if;

  -- ── 3. Idempotency (0347 pattern, scope targeted_recount) ────────────────
  -- ON CONFLICT DO NOTHING waits for a concurrent holder of the same key to
  -- finish; afterwards its committed row is read (a new statement, a new
  -- snapshot). A committed key is always 'completed': the key row and the
  -- count commit or roll back together.
  if v_key is not null then
    v_hash := md5('targeted_recount|o:' || array_to_string(v_occ_ids, ',')
                  || '|i:' || array_to_string(v_item_in, ','));
    perform set_config('stockpilot.idempotency_write', pg_current_xact_id()::text, true); -- 0466
    insert into public.idempotency_keys as k
      (organization_id, scope, key, request_hash, status, resource_type)
    values
      (p_org, 'targeted_recount', v_key, v_hash, 'in_progress', 'cycle_count')
    on conflict (organization_id, scope, key) do nothing
    returning k.id into v_key_id;
    perform set_config('stockpilot.idempotency_write', coalesce(v_idem_prev, ''), true); -- 0466

    if v_key_id is null then
      select k.request_hash, k.status, k.resource_id, k.response into v_prev
        from public.idempotency_keys k
       where k.organization_id = p_org
         and k.scope = 'targeted_recount'
         and k.key = v_key;
      if not found
         or v_prev.request_hash is distinct from v_hash
         or v_prev.status is distinct from 'completed' then
        raise exception 'idempotency_conflict' using errcode = 'P0001', hint = 'idempotency_conflict';
      end if;
      -- 0466: the stored answer names the count the key stands for.
      if jsonb_typeof(v_prev.response) = 'object' -- 0466
         and (v_prev.response->>'cycleCountId') is distinct from v_prev.resource_id::text then -- 0466
        raise exception 'idempotency_conflict' using errcode = 'P0001', hint = 'idempotency_conflict'; -- 0466
      end if; -- 0466
      -- The first answer, as it was: the same count, links and skips. The
      -- count and its number come from the key row itself (resource_id is
      -- what the key stands for). A key stored without an answer (none is
      -- written without one) answers with the count alone.
      return coalesce(
               case when jsonb_typeof(v_prev.response) = 'object' then v_prev.response end,
               jsonb_build_object('lineCount', null, 'linked', '[]'::jsonb,
                                  'linkedExisting', '[]'::jsonb, 'skipped', '[]'::jsonb))
             || jsonb_build_object(
                  'cycleCountId', v_prev.resource_id,
                  'countNumber',  (select c.count_number from public.cycle_counts c where c.id = v_prev.resource_id),
                  'created',      false,
                  'replay',       true);
    end if;
  end if;

  -- ── 4. Occurrences and explicit items, under the caller's RLS ────────────
  if cardinality(v_occ_ids) > 0 then
    -- Same key as exceptions_sync: no sync runs while these rows are read and
    -- linked (see the header: row-lock order, and no resolve in between).
    perform pg_advisory_xact_lock(hashtextextended('exc_sync:' || p_org::text, 0));

    select coalesce(jsonb_agg(jsonb_build_object(
             'id',      o.id,
             'itemId',  o.item_id,
             'rule',    o.rule,
             'open',    o.resolved_at is null,
             'pointer', o.recount_cycle_count_id) order by o.id), '[]'::jsonb),
           count(*)
      into v_occ, v_n
      from public.exception_occurrences o
     where o.id = any (v_occ_ids)
       and o.organization_id = p_org;
    if v_n <> cardinality(v_occ_ids) then
      raise exception 'occurrence_not_found' using errcode = 'P0002';
    end if;
  end if;

  if cardinality(v_item_in) > 0 then
    select count(*) into v_n
      from public.inventory_items i
     where i.id = any (v_item_in)
       and i.organization_id = p_org;
    if v_n <> cardinality(v_item_in) then
      raise exception 'item_not_found' using errcode = 'P0002';
    end if;
  end if;

  -- ── 5. The item set, capped, and one advisory lock per item ──────────────
  v_items := array(
    select s.x
      from (select (e->>'itemId')::uuid as x
              from jsonb_array_elements(v_occ) e
             where (e->>'open')::boolean
               and (e->>'rule') = any (c_recountable)
            union
            select unnest(v_item_in)) s
     order by s.x);
  if cardinality(v_items) > c_max_items then
    raise exception 'recount_too_many_items' using errcode = '22023', hint = 'recount_too_many_items';
  end if;

  -- Sorted by the lock key itself: every caller takes any two keys in the
  -- same order, so two starts never wait on each other crosswise.
  for v_lock_key in
    select distinct hashtextextended('sp:recount:' || x::text, 0) as k
      from unnest(v_items) x
     order by k
  loop
    perform pg_advisory_xact_lock(v_lock_key);
  end loop;

  -- ── 6. Classify, against a stable set of open counts ─────────────────────
  perform 1
     from public.cycle_counts c
    where c.organization_id = p_org
      and c.status = 'in_progress'
      and exists (select 1 from public.cycle_count_lines l
                   where l.cycle_count_id = c.id
                     and l.item_id = any (v_items))
    order by c.id
      for share of c;

  with it as (
    select i.id,
           i.warehouse_id,
           -- start_cycle_count's own predicate (0369, D8).
           (i.deleted_at is null and i.status = 'active' and not i.is_rental and not i.is_bundle) as countable
      from public.inventory_items i
     where i.id = any (v_items)
  ),
  ptr as (
    select distinct (e->>'pointer')::uuid as cc_id, (e->>'itemId')::uuid as item_id
      from jsonb_array_elements(v_occ) e
     where e->>'pointer' is not null
  ),
  -- An open count counts as "already counting" the item only when its line
  -- can still re-check it: uncounted, or counted no earlier than every posted
  -- count of the item. A line counted before the difference was found would
  -- post nothing (or be refused as superseded) and leave the exception open.
  ex as (
    select distinct on (l.item_id) l.item_id, c.id as cc_id
      from public.cycle_count_lines l
      join public.cycle_counts c on c.id = l.cycle_count_id
     where l.item_id = any (v_items)
       and c.organization_id = p_org
       and c.status = 'in_progress'
       and public.cycle_count_line_rechecks(l)
     order by l.item_id,
              exists (select 1 from ptr where ptr.cc_id = c.id and ptr.item_id = l.item_id) desc,
              c.started_at desc,
              c.id desc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'itemId',      it.id,
           'warehouseId', it.warehouse_id,
           'countable',   it.countable,
           'existing',    case when it.countable then ex.cc_id end) order by it.id), '[]'::jsonb)
    into v_plan
    from it
    left join ex on ex.item_id = it.id;

  -- ── 7. One new count for the items no open count holds ───────────────────
  v_new_items := array(
    select (e->>'itemId')::uuid
      from jsonb_array_elements(v_plan) e
     where (e->>'countable')::boolean
       and e->>'existing' is null
     order by 1);

  if cardinality(v_new_items) > 0 then
    select case when count(*) filter (where s.wh is null) = 0 and count(distinct s.wh) = 1
                then (array_agg(s.wh))[1] end
      into v_header_wh
      from (select (e->>'warehouseId')::uuid as wh
              from jsonb_array_elements(v_plan) e
             where (e->>'itemId')::uuid = any (v_new_items)) s;

    select s.cycle_count_id, s.line_count
      into v_cc, v_lines
      from public.start_cycle_count(p_org, 'selection', v_header_wh, null, v_new_items, v_notes) s;

    if v_cc is null or v_lines is distinct from cardinality(v_new_items) then
      raise exception 'recount_items_changed: % of % items could be counted',
        coalesce(v_lines, 0), cardinality(v_new_items)
        using errcode = 'P0001', hint = 'recount_items_changed';
    end if;

    select c.count_number into v_cc_number
      from public.cycle_counts c
     where c.id = v_cc;
  end if;

  -- ── 8. Link the occurrences ──────────────────────────────────────────────
  select coalesce(jsonb_agg(jsonb_build_object(
           'occurrenceId', o.occ_id,
           'itemId',       o.item_id,
           'target', case
             when not pl.countable then null
             when o.pointer is not null and exists (
                    select 1
                      from public.cycle_counts c
                      join public.cycle_count_lines l
                        on l.cycle_count_id = c.id and l.item_id = o.item_id
                     where c.id = o.pointer
                       and c.organization_id = p_org
                       and c.status = 'in_progress'
                       and public.cycle_count_line_rechecks(l))
               then o.pointer
             else coalesce(pl.existing, v_cc)
           end) order by o.occ_id), '[]'::jsonb)
    into v_targets
    from (select (e->>'id')::uuid as occ_id,
                 (e->>'itemId')::uuid as item_id,
                 (e->>'pointer')::uuid as pointer
            from jsonb_array_elements(v_occ) e
           where (e->>'open')::boolean
             and (e->>'rule') = any (c_recountable)) o
    join (select (e->>'itemId')::uuid as item_id,
                 (e->>'countable')::boolean as countable,
                 (e->>'existing')::uuid as existing
            from jsonb_array_elements(v_plan) e) pl
      on pl.item_id = o.item_id;

  for v_t in
    select (e->>'occurrenceId')::uuid as occ_id, (e->>'target')::uuid as target
      from jsonb_array_elements(v_targets) e
     where e->>'target' is not null
     order by 1
  loop
    perform public._exc_link_recount(v_t.occ_id, v_t.target);
  end loop;

  -- ── Result ───────────────────────────────────────────────────────────────
  select coalesce(jsonb_agg(e->'occurrenceId' order by e->>'occurrenceId'), '[]'::jsonb)
    into v_linked
    from jsonb_array_elements(v_targets) e
   where v_cc is not null
     and (e->>'target')::uuid = v_cc;

  with occ_t as (
    select (e->>'target')::uuid as cc_id, (e->>'itemId')::uuid as item_id, (e->>'occurrenceId')::uuid as occ_id
      from jsonb_array_elements(v_targets) e
     where e->>'target' is not null
       and (v_cc is null or (e->>'target')::uuid <> v_cc)
  ),
  item_t as (
    select (e->>'existing')::uuid as cc_id, (e->>'itemId')::uuid as item_id, null::uuid as occ_id
      from jsonb_array_elements(v_plan) e
     where e->>'existing' is not null
  ),
  g as (
    select p.cc_id,
           jsonb_agg(distinct p.item_id) as item_ids,
           coalesce(jsonb_agg(distinct p.occ_id) filter (where p.occ_id is not null), '[]'::jsonb) as occ_ids
      from (select * from occ_t union all select * from item_t) p
     group by p.cc_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'cycleCountId',  c.id,
           'countNumber',   c.count_number,
           'assignedTo',    c.assigned_to,
           'startedAt',     c.started_at,
           'itemIds',       g.item_ids,
           'occurrenceIds', g.occ_ids) order by c.count_number), '[]'::jsonb)
    into v_existing
    from g
    join public.cycle_counts c on c.id = g.cc_id;

  with occ as (
    select (e->>'id')::uuid as occ_id,
           (e->>'itemId')::uuid as item_id,
           e->>'rule' as rule,
           (e->>'open')::boolean as is_open
      from jsonb_array_elements(v_occ) e
  ),
  pl as (
    select (e->>'itemId')::uuid as item_id, (e->>'countable')::boolean as countable
      from jsonb_array_elements(v_plan) e
  ),
  s as (
    select o.occ_id, o.item_id,
           case when not o.is_open then 'resolved'
                when o.rule <> all (c_recountable) then 'not_recountable'
                when not pl.countable then 'not_countable'
           end as reason
      from occ o
      left join pl on pl.item_id = o.item_id
    union all
    select null::uuid, pl.item_id, 'not_countable'
      from pl
     where not pl.countable
       and pl.item_id = any (v_item_in)
       and not exists (select 1 from occ o
                        where o.item_id = pl.item_id
                          and o.is_open
                          and o.rule = any (c_recountable))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'occurrenceId', s.occ_id,
           'itemId',       s.item_id,
           'reason',       s.reason) order by s.reason, s.item_id, s.occ_id), '[]'::jsonb)
    into v_skipped
    from s
   where s.reason is not null;

  v_result := jsonb_build_object(
    'cycleCountId',   v_cc,
    'countNumber',    v_cc_number,
    'lineCount',      v_lines,
    'created',        v_cc is not null,
    'replay',         false,
    'linked',         v_linked,
    'linkedExisting', v_existing,
    'skipped',        v_skipped);

  -- ── 9. The key answers with this call's answer from now on ───────────────
  if v_key is not null then
    perform set_config('stockpilot.idempotency_write', pg_current_xact_id()::text, true); -- 0466
    update public.idempotency_keys
       set status      = 'completed',
           resource_id = v_cc,
           response    = v_result,
           updated_at  = now()
     where organization_id = p_org
       and scope = 'targeted_recount'
       and key = v_key;
    get diagnostics v_n = row_count;
    perform set_config('stockpilot.idempotency_write', coalesce(v_idem_prev, ''), true); -- 0466
    if v_n <> 1 then
      raise exception 'targeted_recount_internal: idempotency key not recorded'
        using errcode = 'P0001', hint = 'targeted_recount_internal';
    end if;
  end if;

  return v_result;
end;
$function$;

-- 1d. public.draft_order_shortfall_pos: restated from its live text (0385's
-- body); md5(prosrc) 1cf3a02ed7cb4b231ccc5f1e54ba0277 -> 7434557682c40aa984ef27d90fa77e22.
-- The 0466 lines raise the key flag around the key insert and the key update
-- and match a replay to this order and the caller's own drafts.
CREATE OR REPLACE FUNCTION public.draft_order_shortfall_pos(p_order_id uuid, p_lines jsonb, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET lock_timeout TO '5s'
AS $function$
declare
  c_scope     constant text    := 'order_shortfall_po';
  c_max_lines constant integer := 200;
  v_uid       uuid := auth.uid();
  v_key       text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_org       uuid;
  v_wh        uuid;
  v_order_no  bigint;
  v_lines     jsonb;
  v_n         integer;
  v_hash      text;
  v_key_id    uuid;
  v_prev      record;
  v_facts     jsonb;
  v_calc      jsonb;
  v_bad       text;
  v_detail    jsonb;
  v_items     jsonb;
  v_so        text;
  v_notes     text;
  v_group     record;
  v_no        text;
  v_saved     jsonb;
  v_created   jsonb := '[]'::jsonb;
  v_result    jsonb;
  v_stored    jsonb;
  v_found     integer;
  v_total     integer;
  v_no_parts  text[];
  v_no_seq    bigint;
  v_no_width  integer;
  v_no_steps  integer;
  v_idem_prev text := current_setting('stockpilot.idempotency_write', true); -- 0466
begin
  -- ── 1. Floors ────────────────────────────────────────────────────────────
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  -- Read under the caller's RLS (order_requests_select: members). A missing
  -- order and another org's order read the same.
  select o.organization_id, o.warehouse_id, o.order_number
    into v_org, v_wh, v_order_no
    from public.order_requests o
   where o.id = p_order_id;
  if v_org is null or not public.is_org_member(v_org) then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;

  if not public.module_enabled(v_org, 'orders') then
    raise exception 'module_disabled' using errcode = 'P0001', hint = 'module_disabled', detail = 'orders';
  end if;
  if not public.module_enabled(v_org, 'purchase_orders') then
    raise exception 'module_disabled' using errcode = 'P0001', hint = 'module_disabled', detail = 'purchase_orders';
  end if;

  if not public.has_org_role(v_org, 'manager') then
    raise exception 'forbidden' using errcode = '42501', hint = 'manager_required';
  end if;
  if not public.has_permission(v_org, 'purchase_orders:manage') then
    raise exception 'forbidden' using errcode = '42501', hint = 'purchase_orders_manage';
  end if;
  if not public.user_can_access_inventory(v_uid, v_wh, null, 'write') then
    raise exception 'forbidden' using errcode = '42501', hint = 'warehouse_write';
  end if;

  -- ── 2. Arguments ─────────────────────────────────────────────────────────
  if v_key is null then
    raise exception 'idempotency_key_required' using errcode = '22023', hint = 'idempotency_key_required';
  end if;
  if char_length(v_key) > 200 then
    raise exception 'idempotency_key_too_long' using errcode = '22023', hint = 'idempotency_key_too_long';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) < 1 or jsonb_array_length(p_lines) > c_max_lines then
    raise exception 'line_invalid' using errcode = '22023', hint = 'line_invalid';
  end if;
  -- Shape first, each cast behind its type test (CASE, not OR: OR does not
  -- promise evaluation order).
  if exists (
    select 1
      from jsonb_array_elements(p_lines) as e(l)
     where case
             when jsonb_typeof(l) <> 'object' then true
             when jsonb_typeof(l->'item_id') is distinct from 'string'
               or (l->>'item_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then true
             when jsonb_typeof(l->'quantity') is distinct from 'number' then true
             else round((l->>'quantity')::numeric, 4) <= 0
           end
  ) then
    raise exception 'line_invalid' using errcode = '22023', hint = 'line_invalid';
  end if;

  -- One line per item, in item order, each quantity on the columns' grid.
  select coalesce(jsonb_agg(jsonb_build_object('item_id', x.item_id, 'quantity', x.qty) order by x.item_id), '[]'::jsonb),
         count(distinct x.item_id)
    into v_lines, v_n
    from (select (l->>'item_id')::uuid as item_id,
                 trim_scale(round((l->>'quantity')::numeric, 4)) as qty
            from jsonb_array_elements(p_lines) as e(l)) x;
  if v_n <> jsonb_array_length(p_lines) then
    raise exception 'line_invalid' using errcode = '22023', hint = 'line_invalid';
  end if;

  -- ── 3. Idempotency (the 0372 pattern) ────────────────────────────────────
  select md5(c_scope || '|' || p_order_id::text || '|'
             || string_agg((l->>'item_id') || ':' || (l->>'quantity'), ',' order by l->>'item_id'))
    into v_hash
    from jsonb_array_elements(v_lines) as e(l);

  perform set_config('stockpilot.idempotency_write', pg_current_xact_id()::text, true); -- 0466
  insert into public.idempotency_keys as k
    (organization_id, scope, key, request_hash, status, resource_type, resource_id)
  values
    (v_org, c_scope, v_key, v_hash, 'in_progress', 'order_request', p_order_id)
  on conflict (organization_id, scope, key) do nothing
  returning k.id into v_key_id;
  perform set_config('stockpilot.idempotency_write', coalesce(v_idem_prev, ''), true); -- 0466

  if v_key_id is null then
    -- A new statement: it sees the row the other call committed.
    select k.request_hash, k.status, k.response
      into v_prev
      from public.idempotency_keys k
     where k.organization_id = v_org
       and k.scope = c_scope
       and k.key = v_key;
    if not found
       or v_prev.request_hash is distinct from v_hash
       or v_prev.status is distinct from 'completed'
       or jsonb_typeof(v_prev.response) is distinct from 'object'
       or jsonb_typeof(v_prev.response->'created') is distinct from 'array' then
      raise exception 'idempotency_conflict' using errcode = 'P0001', hint = 'idempotency_conflict';
    end if;
    -- 0466: and only for this order, with drafts the caller made in this organization.
    if (select k.resource_id from public.idempotency_keys k -- 0466
         where k.organization_id = v_org and k.scope = c_scope and k.key = v_key) is distinct from p_order_id -- 0466
       or (v_prev.response->>'orderId') is distinct from p_order_id::text -- 0466
       or exists (select 1 -- 0466
                    from jsonb_array_elements(v_prev.response->'created') as e(c) -- 0466
                    join public.purchase_orders p on p.id::text = e.c->>'purchaseOrderId' -- 0466
                   where p.organization_id is distinct from v_org -- 0466
                      or p.created_by is distinct from v_uid) then -- 0466
      raise exception 'idempotency_conflict' using errcode = 'P0001', hint = 'idempotency_conflict'; -- 0466
    end if; -- 0466
    -- The key names each draft by id only (see the header): its number and
    -- supplier are read now, from the PO, as the caller may see them.
    select coalesce(jsonb_agg(c || jsonb_build_object('poNumber', p.po_number, 'supplierId', p.supplier_id)
                              order by e.o), '[]'::jsonb),
           count(p.id),
           count(*)
      into v_created, v_found, v_total
      from jsonb_array_elements(v_prev.response->'created') with ordinality as e(c, o)
      left join public.purchase_orders p
        on p.id = (e.c->>'purchaseOrderId')::uuid
       and p.organization_id = v_org;
    if v_found <> v_total then
      raise exception 'draft_order_shortfall_pos_internal: a stored draft could not be read'
        using errcode = 'P0001', hint = 'shortfall_po_internal';
    end if;
    return (v_prev.response - 'created')
           || jsonb_build_object('created', v_created, 'replay', true);
  end if;

  -- ── 4. The reorder drafts' lock (0366), held to commit ───────────────────
  perform pg_advisory_xact_lock(
    hashtextextended('save_purchase_order_draft:reorder:' || v_org::text, 0));

  -- ── 5. Recompute, after the lock ─────────────────────────────────────────
  v_facts := public.order_readiness_facts(p_order_id);

  if v_facts->>'phase' is distinct from 'to_pick' or (v_facts->'linesCapped') = 'true'::jsonb then
    raise exception 'readiness_not_applicable'
      using errcode = 'P0001', hint = 'readiness_not_applicable',
            detail = coalesce(v_facts->'order'->>'status', '');
  end if;

  select l->>'item_id'
    into v_bad
    from jsonb_array_elements(v_lines) as e(l)
   where not exists (select 1
                       from jsonb_array_elements(v_facts->'lines') as f(fl)
                      where (fl->>'itemId')::uuid = (l->>'item_id')::uuid)
   order by 1
   limit 1;
  if v_bad is not null then
    raise exception 'line_not_on_order' using errcode = '22023', hint = 'line_not_on_order', detail = v_bad;
  end if;

  v_calc := public.order_shortfall_draftable(v_facts);

  if exists (select 1 from jsonb_array_elements(v_lines) as e(l)
              where v_calc->(l->>'item_id')->>'refusal' = 'po_module_off') then
    raise exception 'module_disabled' using errcode = 'P0001', hint = 'module_disabled', detail = 'purchase_orders';
  end if;

  select jsonb_object_agg(l->>'item_id', coalesce(v_calc->(l->>'item_id')->>'refusal', 'not_visible'))
    into v_detail
    from jsonb_array_elements(v_lines) as e(l)
   where (v_calc->(l->>'item_id')->>'refusal') is not null
      or (v_calc->(l->>'item_id')) is null;
  if v_detail is not null then
    raise exception 'item_not_draftable'
      using errcode = 'P0001', hint = 'item_not_draftable', detail = v_detail::text;
  end if;

  -- Over the limit: refused with the current numbers, never clamped.
  if exists (select 1 from jsonb_array_elements(v_lines) as e(l)
              where (l->>'quantity')::numeric > (v_calc->(l->>'item_id')->>'draftable')::numeric) then
    select coalesce(jsonb_object_agg(c.key, c.value->'draftable'), '{}'::jsonb)
      into v_detail
      from jsonb_each(v_calc) c
     where c.value->>'refusal' is distinct from 'not_visible';
    raise exception 'shortfall_changed'
      using errcode = 'P0001', hint = 'shortfall_changed', detail = v_detail::text;
  end if;

  -- ── 6. The drafts ────────────────────────────────────────────────────────
  -- Each item's supplier and cost, under the caller's RLS, in one statement.
  select coalesce(jsonb_object_agg(i.id::text, jsonb_build_object(
           'supplierId', i.supplier_id, 'unitCost', coalesce(i.unit_cost, 0))), '{}'::jsonb)
    into v_items
    from public.inventory_items i
   where i.organization_id = v_org
     and i.id in (select (l->>'item_id')::uuid from jsonb_array_elements(v_lines) as e(l));

  select jsonb_object_agg(l->>'item_id', 'not_visible')
    into v_detail
    from jsonb_array_elements(v_lines) as e(l)
   where (v_items->(l->>'item_id')) is null;
  if v_detail is not null then
    raise exception 'item_not_draftable'
      using errcode = 'P0001', hint = 'item_not_draftable', detail = v_detail::text;
  end if;

  -- The order's handle as core prints it (formatOrderNumber: at least six
  -- digits, never cut; the id's first 8 characters when it has no number).
  v_so := case
            when coalesce(v_order_no, 0) > 0
              then 'SO-' || case when char_length(v_order_no::text) >= 6 then v_order_no::text
                                 else lpad(v_order_no::text, 6, '0') end
            else upper(left(p_order_id::text, 8))
          end;
  v_notes := 'Short on ' || v_so || ' when drafted';

  for v_group in
    select g.supplier_id,
           jsonb_agg(jsonb_build_object(
             'item_id',          g.item_id,
             'quantity_ordered', g.qty,
             'unit_cost',        g.unit_cost) order by g.item_id) as save_lines,
           jsonb_agg(jsonb_build_object('itemId', g.item_id, 'quantity', g.qty) order by g.item_id) as out_lines,
           count(*)::integer as line_count,
           trim_scale(sum(g.qty)) as units
      from (select (l->>'item_id')::uuid as item_id,
                   (l->>'quantity')::numeric as qty,
                   (v_items->(l->>'item_id')->>'supplierId')::uuid as supplier_id,
                   (v_items->(l->>'item_id')->>'unitCost')::numeric as unit_cost
              from jsonb_array_elements(v_lines) as e(l)) g
     group by g.supplier_id
     order by g.supplier_id nulls last
  loop
    -- A new statement per draft: it counts the draft made just before.
    v_no := public.next_po_number(v_org);
    -- Past every number a live PO already carries (a number typed ahead of
    -- the count would otherwise be given to every draft: see the header).
    -- The caller is a manager (the floors), who reads every PO of the org.
    v_no_parts := regexp_match(v_no, '^(.*[^0-9])([0-9]+)$');
    if v_no_parts is not null then
      v_no_seq   := v_no_parts[2]::bigint;
      v_no_width := char_length(v_no_parts[2]);
      v_no_steps := 0;
      while v_no_steps < 1000
            and exists (select 1
                          from public.purchase_orders p
                         where p.organization_id = v_org
                           and p.po_number = v_no
                           and p.status <> 'cancelled') loop
        v_no_steps := v_no_steps + 1;
        v_no_seq   := v_no_seq + 1;
        v_no := v_no_parts[1] || lpad(v_no_seq::text, greatest(v_no_width, char_length(v_no_seq::text)), '0');
      end loop;
    end if;
    v_saved := public.save_purchase_order_draft(
      v_org, null, v_no, v_group.supplier_id, null, null, null, v_notes,
      v_group.save_lines, '{}'::uuid[], null, false);
    if v_saved->>'id' is null then
      raise exception 'draft_order_shortfall_pos_internal: no purchase order was written'
        using errcode = 'P0001', hint = 'shortfall_po_internal';
    end if;
    v_created := v_created || jsonb_build_array(jsonb_build_object(
      'purchaseOrderId', v_saved->>'id',
      'poNumber',        v_no,
      'supplierId',      v_group.supplier_id,
      'lineCount',       v_group.line_count,
      'units',           v_group.units,
      'lines',           v_group.out_lines));
  end loop;

  -- ── 7. The key answers with this call's answer from now on ───────────────
  v_result := jsonb_build_object(
    'orderId',     p_order_id,
    'orderNumber', v_order_no,
    'created',     v_created);
  -- Stored with each draft named by its id only (see the header).
  select jsonb_build_object(
           'orderId',     p_order_id,
           'orderNumber', v_order_no,
           'created',     coalesce(jsonb_agg(c - 'poNumber' - 'supplierId' order by o), '[]'::jsonb))
    into v_stored
    from jsonb_array_elements(v_created) with ordinality as e(c, o);

  perform set_config('stockpilot.idempotency_write', pg_current_xact_id()::text, true); -- 0466
  update public.idempotency_keys
     set status      = 'completed',
         response    = v_stored,
         resource_id = p_order_id,
         updated_at  = now()
   where organization_id = v_org
     and scope = c_scope
     and key = v_key;
  get diagnostics v_n = row_count;
  perform set_config('stockpilot.idempotency_write', coalesce(v_idem_prev, ''), true); -- 0466
  if v_n <> 1 then
    raise exception 'draft_order_shortfall_pos_internal: idempotency key not recorded'
      using errcode = 'P0001', hint = 'shortfall_po_internal';
  end if;

  return v_result || jsonb_build_object('replay', false);
end;
$function$;

-- 1e. The guard's function (step 2 of the header).
create function public.tg_idempotency_keys_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if current_user in ('authenticated', 'anon')
     and coalesce(current_setting('stockpilot.idempotency_write', true), '') <> pg_current_xact_id()::text then
    raise exception 'idempotency_key_through_rpc'
      using errcode = '42501', hint = 'idempotency_key_through_rpc';
  end if;
  return coalesce(new, old);
end
$$;

revoke all on function public.tg_idempotency_keys_guard() from public, anon, authenticated, service_role;

comment on function public.tg_idempotency_keys_guard() is
  'BEFORE INSERT OR UPDATE OR DELETE guard of idempotency_keys (0466): an API role (authenticated, anon) writes a key row '
  'only while stockpilot.idempotency_write equals pg_current_xact_id(), which the four retry key functions set around '
  'their own key writes; otherwise 42501 idempotency_key_through_rpc. The owner, foreign key actions and service_role are '
  'not held. No role holds EXECUTE (a trigger function fires without it).';

-- 1f. Post-conditions of step 1: each body is its live text plus the 0466
-- lines and nothing else; the receipt body keeps 0366's check.
do $post_s96b_fn$
declare
  r record;
begin
  for r in
    select v.sig, v.want_new, v.want_old, md5(p.prosrc) as got_new,
           md5(regexp_replace(p.prosrc, '\n[^\n]*-- 0466[^\n]*', '', 'g')) as got_old,
           p.prosecdef, coalesce(array_to_string(p.proconfig, ';'), '') as cfg, v.want_cfg,
           pg_get_userbyid(p.proowner) as owner,
           has_function_privilege('anon', p.oid, 'execute') as anon_x,
           has_function_privilege('authenticated', p.oid, 'execute') as auth_x
      from (values
        ('ledger.post_receipt_v2(uuid,uuid,jsonb,text,text,text)',             '43d8753704c547012befef950747b965', 'ecd99069fa482371ac5bafeb3363b248', 'search_path=public, extensions'),
        ('ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)', '52aa32489d62af5c89355b67f6493ea3', 'f0fac64fbdabf5870422e7b8fc3f7df3', 'search_path=public'),
        ('public.start_targeted_recount(uuid,uuid[],uuid[],text,text)',        '5096548529d92d7a7e8aec2b4791e305', 'b22850a25b3b92d9a5f1ed02aa717aad', 'search_path=public;lock_timeout=5s'),
        ('public.draft_order_shortfall_pos(uuid,jsonb,text)',                  '7434557682c40aa984ef27d90fa77e22', '1cf3a02ed7cb4b231ccc5f1e54ba0277', 'search_path=public, pg_temp;lock_timeout=5s')
      ) v(sig, want_new, want_old, want_cfg)
      join pg_proc p on p.oid = v.sig::regprocedure
  loop
    if r.got_new <> r.want_new or r.got_old <> r.want_old or r.prosecdef or r.cfg <> r.want_cfg
       or r.owner <> 'postgres' or r.anon_x or not r.auth_x then
      raise exception 's96b: % did not take its restatement (md5 %, without the 0466 lines %, definer %, %, owner %, execute anon %, authenticated %)',
        r.sig, r.got_new, r.got_old, r.prosecdef, r.cfg, r.owner, r.anon_x, r.auth_x
        using errcode = '55000', hint = 's96b_postcondition';
    end if;
  end loop;
  if (select position('po_line_items_not_orderable(v_org, array[v_item_id])' in p.prosrc) = 0
        from pg_proc p where p.oid = 'ledger.post_receipt_v2(uuid,uuid,jsonb,text,text,text)'::regprocedure) then
    raise exception 's96b: ledger.post_receipt_v2 lost the kit-stock check (0366)'
      using errcode = '55000', hint = 's96b_postcondition';
  end if;
  if exists (select 1 from pg_proc p
              where p.oid = 'public.tg_idempotency_keys_guard()'::regprocedure
                and (p.prosecdef or pg_get_userbyid(p.proowner) <> 'postgres'
                     or has_function_privilege('anon', p.oid, 'execute')
                     or has_function_privilege('authenticated', p.oid, 'execute')
                     or has_function_privilege('service_role', p.oid, 'execute'))) then
    raise exception 's96b: public.tg_idempotency_keys_guard() posture'
      using errcode = '55000', hint = 's96b_postcondition';
  end if;
end
$post_s96b_fn$;

-- ═══ 3. The lock prelude (see LOCKS above) ═══════════════════════════════════
-- The one table lock the file takes: SHARE ROW EXCLUSIVE on idempotency_keys
-- for CREATE TRIGGER. Inside DO because the CLI batch is not a transaction
-- block (a top-level LOCK TABLE refuses there, 0373); the lock lasts until the
-- batch commits. A busy table fails the attempt at once; the rollback
-- releases what it took and the next attempt starts after 50 to 150 ms
-- holding no table lock. After the 40th busy attempt the 55P03 is raised as
-- it is (never 40001/40P01) and nothing in the file is applied.
do $lock_s96b$
declare
  v_try integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.idempotency_keys in share row exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if v_try >= 40 then
        raise;
      end if;
    end;
    perform pg_sleep(0.05 + random() * 0.1);
  end loop;
end $lock_s96b$;

-- ═══ 4. The guard ═══════════════════════════════════════════════════════════
create or replace trigger trg_zz_idempotency_keys_guard
  before insert or update or delete on public.idempotency_keys
  for each row execute function public.tg_idempotency_keys_guard();

-- ═══ 5. Post-conditions ═════════════════════════════════════════════════════
do $post_s96b$
declare
  v_bad text := '';
  r record;
begin
  if not exists (select 1 from pg_trigger t
                  where t.tgrelid = 'public.idempotency_keys'::regclass
                    and t.tgname = 'trg_zz_idempotency_keys_guard'
                    and t.tgfoid = 'public.tg_idempotency_keys_guard()'::regprocedure
                    and t.tgenabled = 'O'
                    and t.tgtype = (1 | 2 | 4 | 8 | 16)::int2) then
    v_bad := v_bad || ' trg_zz_idempotency_keys_guard is not a BEFORE INSERT OR UPDATE OR DELETE row trigger;';
  end if;
  for r in
    select g.rolname,
           coalesce((select string_agg(x.privilege_type, ',' order by x.privilege_type)
                       from pg_class c, aclexplode(c.relacl) x
                      where c.oid = 'public.idempotency_keys'::regclass
                        and x.grantee = (select o.oid from pg_roles o where o.rolname = g.rolname)), '') as got,
           g.want
      from (values
        ('anon',          ''),
        ('authenticated', 'INSERT,SELECT,UPDATE'),
        ('service_role',  'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE')
      ) g(rolname, want)
  loop
    if r.got <> r.want then
      v_bad := v_bad || format(' idempotency_keys grants of %s are %s;', r.rolname, r.got);
    end if;
  end loop;
  if v_bad <> '' then
    raise exception 's96b:%', v_bad using errcode = '55000', hint = 's96b_postcondition';
  end if;
end
$post_s96b$;

reset lock_timeout;
