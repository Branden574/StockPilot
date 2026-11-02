-- 0423_po_write_scope.sql
--
-- Purchase order reads go by purchase_orders_select alone, and purchase order
-- writes stay inside the writer's warehouses and need 'View purchase orders'
-- (docket S46). DB-only: no row is written, no table, view or sequence is
-- created, and every table grant stays as it is. The review round
-- (2026-11-02, items 4-8 and 5-9 below) holds what hangs off a purchase order
-- to the same rule: receipt reversals, recurring templates, attachments and
-- their stored files, and the purchase order notifications.
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
--   The review round found what 1-3 left open or broke:
--   4. ledger.reverse_receipt (0195; ledger since 0359) is INVOKER: it gives
--      the PO line its units back and calls recompute_po_status as the
--      caller. With 1-3 in, a manager or admin whose purchase_orders:read was
--      revoked still reversed a receipt (the stock back out, the receipt
--      marked reversed) while the line and status updates matched no row in
--      silence: the line kept counting the units and the purchase order
--      stayed partially received or received.
--   5. recurring_po_templates' write policies (0206, 0249, 0273) asked the
--      writer floor and the organization checks only. The daily run turns a
--      due template into a purchase order as the owner and, in send mode under
--      its cap, places it, so staff or a viewer holding manage, and a manager
--      or admin without read, had the run create and place purchase orders for
--      any warehouse.
--   6. po_attachments (0211): any member read the rows; insert and delete
--      asked the floor and the purchase order's organization; the
--      po-attachments bucket asked membership (read) or the floor (write) of
--      the organization folder. So a member read, and a manage holder added,
--      replaced or removed, the files of purchase orders they may not read.
--   7. my_warehouse_ids lists a viewer's warehouses (a viewer reads there), so
--      a viewer holding manage created a purchase order or template for, or
--      redirected one into, a warehouse they only view; the web refuses a
--      viewer every warehouse write.
--   8. _notify_po_status (0092) and _notify_receipt_posted (0157) told the
--      creator and every owner, admin and manager (0313) whatever they may
--      read: a member without read, or staff outside the warehouse, got the
--      purchase order's number and status. po_status_in_org (0360) answered
--      any member the status of any purchase order of the organization;
--      nothing calls it since 0364 (the line guard uses
--      po_status_for_line_write).
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
--   The review round:
--   5. ledger.reverse_receipt is restated with three marked additions and
--      nothing else (pgTAP C9 takes them out and gets 0195's md5): right
--      after the receipt it locks the purchase order FOR UPDATE, read as the
--      caller, as post_receipt_v2 does (po_not_found, P0002, before anything
--      is written), and a PO line update that matches no row raises
--      po_line_not_found (P0002). The 0359 wrapper, INVOKER and the grants
--      stay.
--   6. recurring_po_templates_insert, _update and _delete get
--      purchase_orders_insert's rule: the floor, purchase_orders:read, 0273's
--      organization checks and 0322's warehouse rule (USING and WITH CHECK).
--      recurring_po_templates_select stays member-wide (docket S10 5.1).
--   7. po_attachments' three policies follow the purchase order (an EXISTS
--      under the caller's row security; the writes keep the floor), and the
--      bucket's four policies ask po_attachment_object_visible(name) (new,
--      INVOKER): the name is {organization}/{purchase order}/{file} and the
--      caller may read that purchase order. The writes keep 0211's floor.
--   8. tg_po_destination_write_guard (new, INVOKER) fires before an insert,
--      or an update of destination_location_id, on purchase_orders and
--      recurring_po_templates: for a Data API caller, a new or changed
--      destination in a warehouse must be one they may change
--      (user_can_access_warehouse 'write'), else 42501. A WITH CHECK could
--      not do it: it cannot tell a status change from a redirect, and a
--      viewer may still place or pause what they read. No destination, a
--      place with no warehouse, an unchanged destination, SECURITY DEFINER
--      functions and the service role are not asked.
--   9. _notify_po_status and _notify_receipt_posted are restated with one
--      more condition on who is told: _po_readable_by(purchase order, member)
--      (new, DEFINER, no API EXECUTE), purchase_orders_select's three rules
--      resolved for that member. EXECUTE on po_status_in_org is revoked from
--      authenticated (the service role keeps it).
--
-- WHO CHANGES: staff and viewers holding purchase_orders:manage read and
-- write only their own warehouses' purchase orders and those with no
-- warehouse; members whose purchase_orders:read is revoked (managers and
-- admins included) read, change, receive and draft none. The web already
-- refused them every one of these; the phone's lists change at the push, with
-- no app update. Owners, managers and admins holding read, and the crons, are
-- unchanged. The PR's kit notes carry the read-only counts that size it.
-- The review round: a manager or admin without read cannot reverse a
-- receipt (not found; the web already hid the purchase order from them);
-- recurring templates, attachment rows and stored files are written, and the
-- rows and files read, only by someone who may read the purchase order; a
-- viewer holding manage cannot send a purchase order or template to a
-- warehouse they only view; PO status and receipt notifications reach only
-- people who may read the purchase order (the creator included).
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
--   * Templates already written outside their writer's scope keep running
--     (the daily run is the owner); this file changes no row. The PR's kit
--     notes carry a read-only count of enabled templates last written by
--     staff or a viewer, for the owner to review.
--   * Template rows, purchase order lines and receipts stay readable by any
--     member (docket S10 5.1).
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
-- below. The 0211 header ("View = any org member") describes the attachment
-- reads before this file.
--
-- ── LOCKS ──────────────────────────────────────────────────────────────────
-- The preflight reads catalogs only (pg_proc, pg_policy and pg_trigger, no
-- deparse), and the functions, their grants and their comments lock no
-- table (plpgsql resolves names when it runs; the review round's functions
-- are all plpgsql for that reason), so they come first. DROP POLICY, CREATE
-- POLICY, ALTER POLICY and COMMENT ON POLICY take ACCESS EXCLUSIVE on the
-- policy's table (purchase_orders, purchase_order_items,
-- recurring_po_templates, po_attachments, storage.objects) and, on this
-- image (supautils 3.4.0), supautils also takes ACCESS EXCLUSIVE on every
-- table supautils.policy_grants lists for the role (auth, storage, realtime;
-- measured for COMMENT ON POLICY too). CREATE TRIGGER takes SHARE ROW
-- EXCLUSIVE on purchase_orders and recurring_po_templates (covered). The new
-- policy expressions read locations (ACCESS SHARE) and purchase_orders while
-- they are parsed. The app reads
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
-- deadlock_timeout) bounds anything unforeseen. Purchase order, template and
-- attachment reads and writes, storage requests and sign-ins (the supautils
-- tables) queue for the few milliseconds the file holds the locks.
--
-- The reversal's new purchase order lock (FOR UPDATE, after the receipt's)
-- comes before every other row it writes, as in post_receipt_v2, which locks
-- the purchase order first and never an existing receipt; two reversals of
-- one purchase order queue on it. Before, the reversal reached the purchase
-- order last (recompute_po_status), after the stock rows post_receipt_v2
-- takes after it.
--
-- ── ERRORS ─────────────────────────────────────────────────────────────────
-- next_po_number raises 42501 with a sentence. The policies refuse an insert,
-- or an update's new row, with 42501 and match 0 rows on an update or delete
-- the caller may not make; tg_po_destination_write_guard raises 42501 with a
-- sentence. ledger.reverse_receipt raises po_not_found or po_line_not_found
-- (P0002, as post_receipt_v2's po_not_found; the web maps both to not found).
-- The push raises 55000 (drift: nothing applied) or 55P03 (busy: nothing
-- applied). Never 40001 or 40P01 (PostgREST retries those forever, 0367).

set lock_timeout = '900ms';

-- ═══ 0. Preflight: catalogs only, nothing applied on drift ═══════════════════
-- The function must be the 0350 text and posture, and the two tables must
-- carry exactly the four policies this file replaces or keeps, by name and
-- command (pg_policy, no deparse, so no table lock; the rollout kit also pins
-- each policy's text in a block that is always undone). The review round adds
-- the three bodies it restates (md5, posture, owner), po_status_in_org, the
-- template, attachment-row and bucket policies it rewrites (by name and
-- command), and the absence of what it creates. Anything else is drift (or a
-- second run): stop before changing anything.
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

  -- The review round. The bodies it restates must be the text it was written
  -- against, and what it adds must not exist yet (a second run stops here).
  for r in
    select x.sig, x.want, p.oid as poid, md5(p.prosrc) as src, p.prosecdef as sd,
           coalesce(array_to_string(p.proconfig, ';'), '') as cfg,
           pg_get_userbyid(p.proowner) as own
      from (values ('ledger.reverse_receipt(uuid,text)',
                    '11a98ae96479445f86c303d85c9e0b8f|false|search_path=public, extensions'),
                   ('public._notify_po_status()',
                    'e80cc4f94048040e8a9d7daf83179f60|true|search_path=public'),
                   ('public._notify_receipt_posted()',
                    '6fe68d1a1461d9d08cf69497f10dd070|true|search_path=public')) x(sig, want)
      left join pg_proc p on p.oid = to_regprocedure(x.sig)
  loop
    if r.poid is null then
      v_bad := v_bad || format(' %s missing;', r.sig);
    elsif r.src || '|' || r.sd::text || '|' || r.cfg <> r.want or r.own <> 'postgres' then
      v_bad := v_bad || format(' %s drifted (%s, owner %s);', r.sig, r.src || '|' || r.sd::text || '|' || r.cfg, r.own);
    end if;
  end loop;
  if to_regprocedure('public.po_status_in_org(uuid,uuid)') is null then
    v_bad := v_bad || ' po_status_in_org missing;';
  end if;
  if to_regprocedure('public._po_readable_by(uuid,uuid)') is not null
     or to_regprocedure('public.po_attachment_object_visible(text)') is not null
     or to_regprocedure('public.tg_po_destination_write_guard()') is not null
     or exists (select 1 from pg_trigger t where t.tgname = 'trg_po_destination_write_guard') then
    v_bad := v_bad || ' a function or trigger this file adds already exists;';
  end if;

  select string_agg(n.nspname || '.' || c.relname || '.' || pol.polname || ':' || pol.polcmd::text, ','
                    order by n.nspname collate "C", c.relname collate "C", pol.polname collate "C")
    into v_set
    from pg_policy pol
    join pg_class c on c.oid = pol.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where pol.polrelid in ('public.recurring_po_templates'::regclass, 'public.po_attachments'::regclass)
      or (pol.polrelid = 'storage.objects'::regclass and pol.polname like 'po-attachments %');
  if v_set is distinct from
     'public.po_attachments.po_attachments manage delete:d,public.po_attachments.po_attachments manage insert:a,'
     || 'public.po_attachments.po_attachments read:r,public.recurring_po_templates.recurring_po_templates_delete:d,'
     || 'public.recurring_po_templates.recurring_po_templates_insert:a,public.recurring_po_templates.recurring_po_templates_select:r,'
     || 'public.recurring_po_templates.recurring_po_templates_update:w,storage.objects.po-attachments manage delete:d,'
     || 'storage.objects.po-attachments manage update:w,storage.objects.po-attachments manage write:a,'
     || 'storage.objects.po-attachments read:r' then
    v_bad := v_bad || format(' template or attachment policies drifted (%s);', coalesce(v_set, 'none'));
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

-- ═══ 1b. The review round's functions (no table lock) ════════════════════════
-- All plpgsql (names resolve when they run), so, like next_po_number, they
-- take no table lock and come before the prelude.

-- ledger.reverse_receipt: restated from 0195 (moved to ledger by 0359);
-- md5(prosrc) 11a98ae96479445f86c303d85c9e0b8f, plus the three marked S46
-- additions and nothing else (pgTAP C9 takes them out and gets that md5).
-- INVOKER, search_path, owner and grants stay; the 0359 wrapper is untouched.
create or replace function ledger.reverse_receipt(p_receipt_id uuid, p_reason text)
returns public.receipts
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_orig    public.receipts%rowtype;
  v_rev     public.receipts%rowtype;
  v_line    public.receipt_lines%rowtype;
  v_n       integer;
begin
  select * into v_orig from public.receipts where id = p_receipt_id for update;
  if not found then raise exception 'receipt_not_found' using errcode = 'P0002'; end if;
  if v_orig.status <> 'posted' then
    raise exception 'receipt_already_reversed' using errcode = '22023';
  end if;
  if not public.has_org_role(v_orig.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- S46 (0423): the purchase order next, locked as post_receipt_v2 locks it
  -- and read as the caller. One the caller may not read (purchase_orders_select:
  -- membership, purchase_orders:read and, below manager, the warehouse rule)
  -- is po_not_found before anything is written, never a reversal that takes
  -- the stock back out but cannot give the line its units back or reopen
  -- the purchase order.
  perform 1 from public.purchase_orders where id = v_orig.purchase_order_id for update;
  if not found then raise exception 'po_not_found' using errcode = 'P0002'; end if;

  insert into public.receipts(
    organization_id, purchase_order_id, warehouse_id, receipt_number,
    status, reversed_receipt_id, reversal_reason,
    received_by, immutable_hash, notes
  ) values (
    v_orig.organization_id, v_orig.purchase_order_id, v_orig.warehouse_id,
    v_orig.receipt_number || '-REV',
    'reversal', v_orig.id, p_reason,
    auth.uid(),
    encode(digest('reversal:' || v_orig.id::text, 'sha256'), 'hex'),
    'Reversal of ' || v_orig.receipt_number
  ) returning * into v_rev;

  for v_line in select * from public.receipt_lines where receipt_id = v_orig.id loop
    -- adjust_stock raises 'insufficient_stock' if on-hand would go negative
    -- (stock already shipped/consumed) — that aborts the whole reversal BEFORE
    -- we delete any serials, so we only ever free provenance for stock that is
    -- still on hand.
    if v_line.qty_accepted_base > 0 then
      perform public.adjust_stock(
        v_line.item_id,
        -v_line.qty_accepted_base,
        'correction',
        null,
        'receipt_reversal',
        v_rev.id::text,
        'staging_first'
      );
    end if;

    insert into public.receipt_lines(
      receipt_id, purchase_order_line_id, item_id,
      qty_received_base, qty_accepted_base, qty_rejected_base,
      unit_cost, notes
    ) values (
      v_rev.id, v_line.purchase_order_line_id, v_line.item_id,
      -v_line.qty_received_base, -v_line.qty_accepted_base, -v_line.qty_rejected_base,
      v_line.unit_cost, 'Reversal of original receipt line'
    );

    -- Free lot/serial provenance attached to the ORIGINAL line. Reaching here
    -- means the accepted stock was still fully on hand (else adjust_stock above
    -- aborted), so deleting these is safe: it releases the unique(org,item,
    -- serial) lock so the corrected shipment can be re-received, and drops the
    -- now-meaningless lot/aging rows. The original receipt_line itself is kept
    -- (status='reversed') for audit.
    delete from public.serial_registry where receipt_line_id = v_line.id;
    delete from public.receipt_line_lots where receipt_line_id = v_line.id;

    update public.purchase_order_items
      set quantity_received = greatest(0, quantity_received - v_line.qty_accepted_base)
      where id = v_line.purchase_order_line_id;
    -- S46 (0423): this update runs as the caller, so row security could
    -- match no row in silence; the line gets its units back or nothing does.
    get diagnostics v_n = row_count;
    if v_n <> 1 then raise exception 'po_line_not_found' using errcode = 'P0002'; end if;
  end loop;

  update public.receipts set status = 'reversed' where id = v_orig.id;

  perform public.recompute_po_status(v_orig.purchase_order_id);

  return v_rev;
end$$;

comment on function ledger.reverse_receipt(uuid, text) is
  'Receipt reversal body (0195; in ledger since 0359, run as the caller by public.reverse_receipt). S46 (0423): right after the receipt it locks the purchase order FOR UPDATE, read as the caller, as post_receipt_v2 does, so a caller who may not read it (purchase_orders_select) gets po_not_found (P0002) before anything is written; a PO line update that matches no row raises po_line_not_found (P0002). A reversal never half-applies.';

-- Whether a member may read a purchase order: purchase_orders_select's three
-- conjuncts resolved for p_user_id instead of auth.uid(). For the
-- notification writers (SECURITY DEFINER, so the caller's own row security
-- has no say); no API role executes it.
create or replace function public._po_readable_by(p_po_id uuid, p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org  uuid;
  v_dest uuid;
  v_role text;
  v_wh   uuid;
begin
  select p.organization_id, p.destination_location_id
    into v_org, v_dest
    from public.purchase_orders p
   where p.id = p_po_id;
  if not found or p_user_id is null then
    return false;
  end if;

  -- 1. is_org_member: an accepted, unexpired, not disabled membership.
  select m.role into v_role
    from public.organization_members m
   where m.organization_id = v_org
     and m.user_id = p_user_id
     and m.accepted_at is not null
     and (m.impersonation_expires_at is null or m.impersonation_expires_at > now())
     and not exists (select 1 from public.user_profiles up
                      where up.id = m.user_id and up.disabled_at is not null)
   limit 1;
  if v_role is null then
    return false;
  end if;

  -- 2. purchase_orders:read, resolved as has_permission (0310) resolves it:
  --    the owner always; else the member's override, the role's override,
  --    the role's default, in that order.
  if v_role <> 'owner' and not coalesce(
       (select upo.granted from public.user_permission_overrides upo
         where upo.organization_id = v_org and upo.user_id = p_user_id
           and upo.permission = 'purchase_orders:read'),
       (select rpo.granted from public.role_permission_overrides rpo
         where rpo.organization_id = v_org and rpo.role = v_role
           and rpo.permission = 'purchase_orders:read'),
       (select true from public.role_default_permissions rdp
         where rdp.role = v_role and rdp.permission = 'purchase_orders:read'),
       false) then
    return false;
  end if;

  -- 3. 0322's warehouse rule: owners, admins and managers read every purchase
  --    order; below them, one with no destination, one to a place with no
  --    warehouse, or one to a place in a warehouse they are assigned to
  --    (my_warehouse_ids for that member).
  if v_role in ('owner', 'admin', 'manager') or v_dest is null then
    return true;
  end if;
  select l.warehouse_id into v_wh from public.locations l where l.id = v_dest;
  if not found then
    return false;
  end if;
  return v_wh is null
      or exists (select 1 from public.user_warehouse_assignments uwa
                  where uwa.user_id = p_user_id
                    and uwa.organization_id = v_org
                    and uwa.warehouse_id = v_wh);
end;
$$;

revoke all on function public._po_readable_by(uuid, uuid) from public, anon, authenticated;
grant execute on function public._po_readable_by(uuid, uuid) to service_role;

comment on function public._po_readable_by(uuid, uuid) is
  'S46 (0423): true when member p_user_id may read purchase order p_po_id, by purchase_orders_select''s three rules resolved for that member (an accepted, unexpired, not disabled membership; purchase_orders:read through the has_permission chain; 0322''s warehouse rule). SECURITY DEFINER for the PO notification writers; no API role executes it.';

-- _notify_po_status: restated from 0092; md5(prosrc)
-- e80cc4f94048040e8a9d7daf83179f60, plus the marked S46 condition.
create or replace function public._notify_po_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  link_url text;
  notif_title text;
  notif_body text;
begin
  if old.status is null or new.status is null then
    return new;
  end if;
  if old.status = new.status then
    return new;
  end if;

  link_url := '/dashboard/purchase-orders/' || new.id::text;
  notif_title := 'PO ' || coalesce(new.po_number, new.id::text) ||
                 ' is now ' || new.status;
  notif_body := 'Status changed from ' || old.status || ' to ' || new.status || '.';

  for uid in
    select distinct u
    from (
      select new.created_by as u
      union
      select user_id from public._notify_recipients(new.organization_id)
    ) s
    where u is not null
      -- S46 (0423): only people who may read the purchase order.
      and public._po_readable_by(new.id, u)
  loop
    -- Honor the per-user push_po_status opt-out. Treat a missing prefs
    -- row as opt-in for backwards-compat with existing accounts that
    -- haven't touched the (currently unsurfaced) settings UI.
    if exists (
      select 1 from public.notification_preferences
      where user_id = uid and push_po_status = true
    ) or not exists (
      select 1 from public.notification_preferences where user_id = uid
    ) then
      insert into public.notifications (
        organization_id, user_id, type, title, body, link, metadata
      ) values (
        new.organization_id,
        uid,
        'purchase_order.status_changed',
        notif_title,
        notif_body,
        link_url,
        jsonb_build_object(
          'po_id', new.id,
          'po_number', new.po_number,
          'from_status', old.status,
          'to_status', new.status
        )
      );
    end if;
  end loop;
  return new;
end;
$$;

comment on function public._notify_po_status() is
  'AFTER UPDATE trigger on purchase_orders (0025, preference gate 0092, recipients 0313): a status change tells the purchase order''s creator and the organization''s owners, admins and managers who keep push_po_status on. S46 (0423): only those of them who may read the purchase order (_po_readable_by).';

-- _notify_receipt_posted: restated from 0157; md5(prosrc)
-- 6fe68d1a1461d9d08cf69497f10dd070, plus the marked S46 condition.
create or replace function public._notify_receipt_posted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  v_po record;
  link_url text;
  notif_title text;
  notif_body text;
begin
  -- Only act when the receipt becomes 'posted'. On INSERT that means the
  -- new row is posted; on UPDATE that means it crossed into posted.
  if new.status is distinct from 'posted' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status is not distinct from 'posted' then
    return new;
  end if;

  select id, po_number, created_by, organization_id
    into v_po
    from public.purchase_orders
    where id = new.purchase_order_id;

  if v_po.id is null then
    return new;
  end if;

  link_url := '/dashboard/purchase-orders/' || v_po.id::text;
  notif_title := 'Items received against PO ' ||
                 coalesce(v_po.po_number, v_po.id::text);
  notif_body := 'A receipt was posted against this purchase order.';

  for uid in
    select distinct u
    from (
      select v_po.created_by as u
      union
      select user_id from public._notify_recipients(new.organization_id)
    ) s
    where u is not null
      -- S46 (0423): only people who may read the purchase order.
      and public._po_readable_by(v_po.id, u)
  loop
    -- Honor push_po_status opt-out; missing prefs row => opt-in (legacy).
    if exists (
      select 1 from public.notification_preferences
      where user_id = uid and push_po_status = true
    ) or not exists (
      select 1 from public.notification_preferences where user_id = uid
    ) then
      insert into public.notifications (
        organization_id, user_id, type, title, body, link, metadata
      ) values (
        new.organization_id,
        uid,
        'po.received',
        notif_title,
        notif_body,
        link_url,
        jsonb_build_object(
          'po_id', v_po.id,
          'po_number', v_po.po_number,
          'receipt_id', new.id,
          'receipt_number', new.receipt_number
        )
      );
    end if;
  end loop;

  return new;
end;
$$;

comment on function public._notify_receipt_posted() is
  '0157: emits a po.received notification (PO creator + org notify-recipients, push_po_status default-on gate) when a receipt becomes posted. S46 (0423): only to those who may read the purchase order (_po_readable_by).';

-- po_status_in_org (0360) answered any member the status of any purchase
-- order of the organization. Nothing calls it since 0364 (the line guard uses
-- po_status_for_line_write); the service role keeps it.
revoke execute on function public.po_status_in_org(uuid, uuid) from authenticated;

-- The bucket policies' question: is this object in the folder of a purchase
-- order the caller may read? INVOKER, so purchase_orders_select decides.
create or replace function public.po_attachment_object_visible(p_name text)
returns boolean
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_part text[] := string_to_array(p_name, '/');
begin
  -- {organization id}/{purchase order id}/{file}, as every uploader mints it
  -- (0211); anything else is false, never a cast error.
  if coalesce(array_length(v_part, 1), 0) < 3
     or v_part[1] !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     or v_part[2] !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return false;
  end if;
  return exists (
    select 1
      from public.purchase_orders p
     where p.id = v_part[2]::uuid
       and p.organization_id = v_part[1]::uuid
  );
end;
$$;

revoke all on function public.po_attachment_object_visible(text) from public, anon;
grant execute on function public.po_attachment_object_visible(text) to authenticated, service_role;

comment on function public.po_attachment_object_visible(text) is
  'S46 (0423): true when a po-attachments object name is {organization}/{purchase order}/{file} and the caller may read that purchase order (purchase_orders read under the caller''s row security, so purchase_orders_select decides). Any other name is false, never a cast error. SECURITY INVOKER; the bucket''s four policies ask it.';

-- A Data API write may send a purchase order, or a recurring template, only
-- to a warehouse the writer may change. The write policies let a viewer write
-- where they read (my_warehouse_ids lists a viewer's warehouses); a WITH CHECK
-- cannot tell a status change from a redirect, so the destination is checked
-- here, when it is set or changed.
create or replace function public.tg_po_destination_write_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_wh uuid;
begin
  -- A request's own write only. SECURITY DEFINER functions (the PO-import
  -- approval, docket S46b), the crons and the service role keep their gates.
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  -- No destination, or the same one: nothing to decide here (placing,
  -- pausing or renaming stays the write policy's).
  if new.destination_location_id is null
     or (tg_op = 'UPDATE'
         and new.destination_location_id is not distinct from old.destination_location_id) then
    return new;
  end if;
  select l.warehouse_id into v_wh
    from public.locations l
   where l.id = new.destination_location_id;
  -- A place with no warehouse is open to every writer, as purchase_orders_select
  -- reads it; one the caller cannot see is the policy's location_in_org's.
  if v_wh is null then
    return new;
  end if;
  if not public.user_can_access_warehouse(auth.uid(), v_wh, 'write') then
    raise exception 'You cannot send purchase orders to that warehouse.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_po_destination_write_guard() from public, anon, authenticated;

comment on function public.tg_po_destination_write_guard() is
  'S46 (0423): BEFORE INSERT OR UPDATE OF destination_location_id on purchase_orders and recurring_po_templates. For a Data API caller, a new or changed destination in a warehouse must be one the caller may change (user_can_access_warehouse write: managers and above, or staff assigned to it), so a viewer holding purchase_orders:manage cannot create a purchase order or template for, or redirect one into, a warehouse they only view (42501). No destination, a place with no warehouse, an unchanged destination, SECURITY DEFINER functions and the service role pass.';

-- ═══ 2. The lock prelude ═════════════════════════════════════════════════════
-- Every table lock the statements below take, at once and without waiting.
-- Inside DO because the CLI batch is not a transaction block (a top-level
-- LOCK TABLE refuses there, as 0373 found); the locks last until the batch
-- commits.
--   * locations: ACCESS SHARE (read by the purchase_orders policy expressions);
--   * checklist_runs, when 0419 is in: ACCESS EXCLUSIVE (COMMENT ON POLICY: as
--     measured on the scratch stack, supautils takes ACCESS EXCLUSIVE on the
--     policy's own table and on every policy_grants table for it too);
--   * purchase_orders, purchase_order_items: ACCESS EXCLUSIVE (DROP/CREATE POLICY;
--     CREATE TRIGGER on purchase_orders);
--   * recurring_po_templates, po_attachments: ACCESS EXCLUSIVE (ALTER POLICY,
--     COMMENT ON POLICY; CREATE TRIGGER on recurring_po_templates);
--   * storage.objects: ACCESS EXCLUSIVE (DROP/CREATE POLICY on the bucket's
--     policies; also in supautils.policy_grants below, named here so the
--     file never waits for it whatever that setting holds);
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
      lock table only public.purchase_orders, public.purchase_order_items,
                      public.recurring_po_templates, public.po_attachments in access exclusive mode nowait;
      lock table only storage.objects in access exclusive mode nowait;
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


-- ═══ 6. recurring_po_templates: the purchase order write rule ════════════════
-- The daily run turns a due template into a purchase order as the owner and,
-- in send mode under its cap, places it, so a template is written under
-- purchase_orders_insert's rule: the floor, purchase_orders:read, the
-- organization checks (0273, all restated: ALTER POLICY replaces the whole
-- expression) and 0322's warehouse rule, on the row before and after. Reads
-- stay member-wide (recurring_po_templates_select; docket S10 5.1).
alter policy recurring_po_templates_insert on public.recurring_po_templates
  with check (
    ( ( select public.has_org_role(recurring_po_templates.organization_id, 'manager') )
      or ( select public.has_permission(recurring_po_templates.organization_id, 'purchase_orders:manage') ) )
    and recurring_po_templates.organization_id in
          (select public.rls_orgs_with_permission('purchase_orders:read'))
    and ( select public.location_in_org(recurring_po_templates.destination_location_id, recurring_po_templates.organization_id) )
    and ( select public.supplier_in_org(recurring_po_templates.supplier_id, recurring_po_templates.organization_id) )
    and (
      ( select public.has_org_role(recurring_po_templates.organization_id, 'manager') )
      or recurring_po_templates.destination_location_id is null
      or exists (
        select 1
          from public.locations l
         where l.id = recurring_po_templates.destination_location_id
           and (
             l.warehouse_id is null
             or l.warehouse_id in (select mw.warehouse_id from public.my_warehouse_ids() mw)
           )
      )
    )
  );

alter policy recurring_po_templates_update on public.recurring_po_templates
  using (
    ( ( select public.has_org_role(recurring_po_templates.organization_id, 'manager') )
      or ( select public.has_permission(recurring_po_templates.organization_id, 'purchase_orders:manage') ) )
    and recurring_po_templates.organization_id in
          (select public.rls_orgs_with_permission('purchase_orders:read'))
    and (
      ( select public.has_org_role(recurring_po_templates.organization_id, 'manager') )
      or recurring_po_templates.destination_location_id is null
      or exists (
        select 1
          from public.locations l
         where l.id = recurring_po_templates.destination_location_id
           and (
             l.warehouse_id is null
             or l.warehouse_id in (select mw.warehouse_id from public.my_warehouse_ids() mw)
           )
      )
    )
  )
  with check (
    ( ( select public.has_org_role(recurring_po_templates.organization_id, 'manager') )
      or ( select public.has_permission(recurring_po_templates.organization_id, 'purchase_orders:manage') ) )
    and recurring_po_templates.organization_id in
          (select public.rls_orgs_with_permission('purchase_orders:read'))
    and ( select public.location_in_org(recurring_po_templates.destination_location_id, recurring_po_templates.organization_id) )
    and ( select public.supplier_in_org(recurring_po_templates.supplier_id, recurring_po_templates.organization_id) )
    and (
      ( select public.has_org_role(recurring_po_templates.organization_id, 'manager') )
      or recurring_po_templates.destination_location_id is null
      or exists (
        select 1
          from public.locations l
         where l.id = recurring_po_templates.destination_location_id
           and (
             l.warehouse_id is null
             or l.warehouse_id in (select mw.warehouse_id from public.my_warehouse_ids() mw)
           )
      )
    )
  );

alter policy recurring_po_templates_delete on public.recurring_po_templates
  using (
    ( ( select public.has_org_role(recurring_po_templates.organization_id, 'manager') )
      or ( select public.has_permission(recurring_po_templates.organization_id, 'purchase_orders:manage') ) )
    and recurring_po_templates.organization_id in
          (select public.rls_orgs_with_permission('purchase_orders:read'))
    and (
      ( select public.has_org_role(recurring_po_templates.organization_id, 'manager') )
      or recurring_po_templates.destination_location_id is null
      or exists (
        select 1
          from public.locations l
         where l.id = recurring_po_templates.destination_location_id
           and (
             l.warehouse_id is null
             or l.warehouse_id in (select mw.warehouse_id from public.my_warehouse_ids() mw)
           )
      )
    )
  );

-- ═══ 7. po_attachments: the rows follow their purchase order ═════════════════
-- The EXISTS reads purchase_orders under the caller's row security (exactly
-- purchase_orders_select); it also carries 0211's organization check
-- (purchase_order_in_org), so that is not repeated.
alter policy "po_attachments read" on public.po_attachments
  using (
    exists (
      select 1 from public.purchase_orders p
       where p.id = po_attachments.purchase_order_id
         and p.organization_id = po_attachments.organization_id
    )
  );

alter policy "po_attachments manage insert" on public.po_attachments
  with check (
    ( ( select public.has_org_role(po_attachments.organization_id, 'manager') )
      or ( select public.has_permission(po_attachments.organization_id, 'purchase_orders:manage') ) )
    and exists (
      select 1 from public.purchase_orders p
       where p.id = po_attachments.purchase_order_id
         and p.organization_id = po_attachments.organization_id
    )
  );

alter policy "po_attachments manage delete" on public.po_attachments
  using (
    ( ( select public.has_org_role(po_attachments.organization_id, 'manager') )
      or ( select public.has_permission(po_attachments.organization_id, 'purchase_orders:manage') ) )
    and exists (
      select 1 from public.purchase_orders p
       where p.id = po_attachments.purchase_order_id
         and p.organization_id = po_attachments.organization_id
    )
  );

-- ═══ 8. The po-attachments bucket: the stored files follow it too ════════════
-- 0211's four policies, dropped and created again the way 0211 created them
-- (supautils lets this role manage policies on storage.objects). Each now asks
-- po_attachment_object_visible(name) first, so a name that is not a purchase
-- order's folder is refused before the floor's cast; the writes keep 0211's
-- floor on the organization folder.
drop policy "po-attachments read" on storage.objects;
drop policy "po-attachments manage write" on storage.objects;
drop policy "po-attachments manage update" on storage.objects;
drop policy "po-attachments manage delete" on storage.objects;

create policy "po-attachments read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'po-attachments'
    and public.po_attachment_object_visible(name)
  );

create policy "po-attachments manage write"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'po-attachments'
    and public.po_attachment_object_visible(name)
    and (
      ( select public.has_org_role((storage.foldername(name))[1]::uuid, 'manager') )
      or ( select public.has_permission((storage.foldername(name))[1]::uuid, 'purchase_orders:manage') )
    )
  );

create policy "po-attachments manage update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'po-attachments'
    and public.po_attachment_object_visible(name)
    and (
      ( select public.has_org_role((storage.foldername(name))[1]::uuid, 'manager') )
      or ( select public.has_permission((storage.foldername(name))[1]::uuid, 'purchase_orders:manage') )
    )
  )
  with check (
    bucket_id = 'po-attachments'
    and public.po_attachment_object_visible(name)
    and (
      ( select public.has_org_role((storage.foldername(name))[1]::uuid, 'manager') )
      or ( select public.has_permission((storage.foldername(name))[1]::uuid, 'purchase_orders:manage') )
    )
  );

create policy "po-attachments manage delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'po-attachments'
    and public.po_attachment_object_visible(name)
    and (
      ( select public.has_org_role((storage.foldername(name))[1]::uuid, 'manager') )
      or ( select public.has_permission((storage.foldername(name))[1]::uuid, 'purchase_orders:manage') )
    )
  );

-- ═══ 9. The destination guard on both tables ═════════════════════════════════
create trigger trg_po_destination_write_guard
  before insert or update of destination_location_id on public.purchase_orders
  for each row execute function public.tg_po_destination_write_guard();

create trigger trg_po_destination_write_guard
  before insert or update of destination_location_id on public.recurring_po_templates
  for each row execute function public.tg_po_destination_write_guard();

-- ═══ 10. Comments of the review round ════════════════════════════════════════
comment on policy recurring_po_templates_insert on public.recurring_po_templates is
  'S46 (0423): a template is a standing purchase order (the daily run creates and may place it as the owner), so it is written under purchase_orders_insert''s rule: a manager or purchase_orders:manage, purchase_orders:read, the destination inside the caller''s warehouses below manager (none, or a place with no warehouse, also passes), and the 0206/0273 organization checks. tg_po_destination_write_guard keeps a viewer out of warehouses they only view.';
comment on policy recurring_po_templates_update on public.recurring_po_templates is
  'S46 (0423): as recurring_po_templates_insert, on the row before (USING: the floor, read and the warehouse rule) and after (WITH CHECK) the change.';
comment on policy recurring_po_templates_delete on public.recurring_po_templates is
  'S46 (0423): the floor, purchase_orders:read and the warehouse rule, as recurring_po_templates_update''s USING.';
comment on policy "po_attachments read" on public.po_attachments is
  'S46 (0423): an attachment row is read exactly when its purchase order is (the EXISTS reads purchase_orders under the caller''s RLS, so purchase_orders_select decides; it was any member before).';
comment on policy "po_attachments manage insert" on public.po_attachments is
  'S46 (0423): a manager or purchase_orders:manage, and the purchase order readable by the caller (which also keeps it in the row''s organization, as purchase_order_in_org did).';
comment on policy "po_attachments manage delete" on public.po_attachments is
  'S46 (0423): as po_attachments manage insert.';

reset lock_timeout;
