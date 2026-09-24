-- 0366_save_purchase_order_draft.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Saving a draft purchase order (create or edit) in ONE transaction.
--
-- PurchaseOrdersService.create() inserted the header and then the lines as two
-- separate requests, and update() claimed the header, created custom items,
-- deleted every line and inserted the new set as four. A failure partway left
-- an empty draft, or a draft whose supplier and total no longer matched its
-- lines (every edit that added a custom line while the org sat at its item
-- cap did exactly that). The 0364 guards only cover the API roles, so the
-- service-role crons (auto-reorder, recurring POs) had no backstop at all.
--
-- save_purchase_order_draft writes the header, replaces the lines and tags
-- the PO-born custom items in one call; any error rolls all of it back.
--
-- SECURITY INVOKER on purpose: purchase_orders_write, purchase_order_items
-- _write and the 0359/0360/0364 guards (a new PO is a draft, lines only into a
-- draft, the database records the creator) apply to a signed-in caller exactly
-- as they did to the direct writes this replaces. The service role (crons)
-- skips RLS and the guards as before; the checks below that do not depend on
-- the caller (line shape, items/supplier/location/charter in the org, draft
-- status) apply to every caller. It is not a SECURITY DEFINER function, so it
-- stays out of the 0346 gate class.
--
-- ── Parity with the TypeScript it replaces (apps/web/src/server/services/
--    purchase-orders.ts at 35aa39e0) ─────────────────────────────────────────
-- create(), purchase_orders INSERT:
--   organization_id  = ctx.organizationId              -> p_org_id
--   po_number        = supplied (trimmed) or next_po_number()  -> p_po_number
--   supplier_id      = input.supplierId ?? null        -> p_supplier_id
--   destination_location_id = input.destinationLocationId ?? null
--                                                      -> p_destination_location_id
--   charter_id       = resolveCharterId() (org-verified or null) -> p_charter_id
--   expected_at      = input.expectedAt ?? null        -> p_expected_at
--   notes            = input.notes ?? null             -> p_notes
--   subtotal         = sum(quantityOrdered * unitCost) over the lines (JS)
--                      -> the same sum over the same (unrounded) p_lines
--                      values, in exact numeric. Both are then rounded by
--                      the numeric(14,4) column, so the stored value is the
--                      same, except where JS floating-point error used to
--                      cross a 4th-decimal rounding boundary; there the
--                      exact sum wins.
--   total            = subtotal                        -> subtotal (a new PO has
--                      no charges)
--   status           = 'draft'                         -> 'draft'
--   created_by, updated_by = ctx.userId                -> coalesce(auth.uid(),
--                      p_actor); for a signed-in caller the 0364 guard stamps
--                      auth.uid() anyway, so p_actor can never override it.
--   tax, shipping, ordered_at, received_at, created_at, updated_at: not
--                      written (column defaults) -> not written.
-- update(), purchase_orders UPDATE (draft only):
--   supplier_id, destination_location_id, charter_id, expected_at, notes,
--   po_number        -> same parameters as above
--   subtotal         = sum(quantityOrdered * unitCost) -> same sum over p_lines
--   total            = subtotal -> subtotal + sum(purchase_order_charges.amount)
--                      of this PO. The TS wrote subtotal alone, which would
--                      drop the charges of a draft that carries any from its
--                      total. Charges come only from a PO-import approval
--                      (expected_inbound, and since 0360 such a PO can never
--                      reach draft), so no draft has any today and the value
--                      is identical; if one ever does, its total keeps them
--                      (the 0235 rule: total = subtotal + charges) instead of
--                      silently losing them. Never double-counted: subtotal is
--                      the lines only.
--   updated_by       = ctx.userId -> coalesce(auth.uid(), p_actor) (the 0360
--                      guard stamps auth.uid() for a signed-in caller)
--   updated_at       = new Date() -> now() via purchase_orders_set_updated_at
--                      (the trigger overwrote the TS value anyway)
--   tax, shipping, status, ordered_at, received_at, created_*: untouched.
-- purchase_order_items INSERT (both paths; update() first deleted every line
-- of the PO):
--   organization_id = p_org_id, purchase_order_id = the PO, item_id,
--   quantity_ordered, unit_cost from p_lines, in array order.
--   quantity_received defaults to 0; line_total is generated.
-- inventory_items UPDATE (custom "new item" lines, best-effort):
--   created_from_purchase_order_id = the PO, org-scoped, for p_custom_item_ids.
--   Now also limited to items on this PO's lines (a custom item always is).
--   Best-effort as before: RLS may filter rows (row count < ids) and an error
--   is caught; both are returned for the caller to report, never failing the
--   save.
--
-- Errors (message for people, errcode + hint for the service to map):
--   22023 po_invalid         no organization or PO number, or
--                            p_skip_items_on_open_po on an edit
--   42501 (no hint)          p_skip_items_on_open_po from a signed-in caller
--                            who is not a member of p_org_id
--   22023 po_lines_required  p_lines is not a non-empty array
--   22023 po_line_invalid    a line without a uuid item_id, a numeric quantity
--                            above 0 (after the column's 4-decimal rounding)
--                            or a numeric cost of 0 or more. JSON numbers only:
--                            NaN, Infinity and strings are refused.
--   P0002 po_not_found       edit: no such PO in this organization (or not
--                            visible/editable to the caller)
--   55000 po_not_draft       edit: the PO is no longer a draft
--                            (object_not_in_prerequisite_state). NEVER 40001:
--                            PostgREST before v16 re-runs a transaction that
--                            fails with 40001 without limit, so a deterministic
--                            40001 pins a pool connection and a backend in a
--                            retry loop forever (reproduced on v14.5 and
--                            v14.10, about 2,000 rollbacks a second, still
--                            looping after the client gave up). The service
--                            maps by hint, never by code.
--   42501 po_not_in_org      an item, supplier, destination or charter from
--                            another organization
--   22023 po_line_bundle     a line for a kit's pre-assembled stock (is_bundle,
--                            the hidden item assemble_bundle keeps kits in).
--                            A kit is built from its components, never bought
--                            as a kit: receiving one would add kit stock with
--                            no component drawn (owner decision, S3 N2)
--   22023 po_line_deleted    a line for a deleted item (deleted_at set).
--                            Checked before po_line_bundle. An ARCHIVED item
--                            (status 'archived', deleted_at null) is not
--                            refused, nor is a rental: a buyer may order
--                            either by choosing it. Both refusals name the
--                            first such line's item when the caller can see
--                            it, and apply to every caller, the crons too;
--                            the check reads through
--                            po_line_items_not_orderable (below), so an item
--                            hidden from the caller by RLS is refused as well
--   23505 (unique_violation) the PO number is taken (no hint; raised by
--                            purchase_orders_org_ponumber_active_key)
--   40P01 (deadlock)         not raised here, but reachable: an edit locks the
--                            header, then the lines. A direct API-role DELETE
--                            of the same draft's lines (the editor before this
--                            migration, still served to old tabs for up to 12 h
--                            by Vercel skew protection, or a raw PostgREST call)
--                            locks a line first and then, in the line guard,
--                            the header. One of the two is aborted. The whole
--                            call rolled back, so the service answers "changed
--                            at the same time, try again" (40P01 and 55P03).
--
-- ── Reorder drafts (p_skip_items_on_open_po) ────────────────────────────────
-- The reorder paths (the "Draft PO from suggestions" button, the AI tool and
-- the daily auto-reorder) never draft an item that is already on an open PO
-- (draft, expected_inbound, ordered, partially_received). The service checks
-- that before it groups the lines, but two runs at once (two buyers, two tabs,
-- a click during the cron) would both pass that check. With
-- p_skip_items_on_open_po, a create takes a per-organization transaction
-- advisory lock FIRST and then re-reads the open set in a fresh snapshot, so
-- the second run waits for the first to commit and sees its lines. Lines for
-- items already on an open PO are left off and returned as skipped_item_ids;
-- if every line is skipped, no purchase order is written and id is null.
-- Create only (an edit is refused). Only the reorder paths pass it: a
-- hand-made PO or an explicit Items selection may still order an item twice.
--
-- ── Kits and deleted items (po_line_bundle, po_line_deleted) ───────────────
-- The web filters both out of every path that picks items by itself (the
-- reorder reads, the Items selection, the recurring-PO cron), so a refusal
-- here is the backstop, and the one place a hand-made PO meets the rule. The
-- save is SECURITY INVOKER, and inventory_items RLS hides some items from
-- some callers (an item with no warehouse, or in a warehouse a staff member
-- with purchase_orders:manage is not assigned to). A read here under the
-- caller's RLS would pass those lines unchecked, so the check calls
-- po_line_items_not_orderable, a SECURITY DEFINER helper that sees every item
-- of p_org_id. It answers only the service role (no auth.uid(): the crons)
-- or a caller who may write this organization's purchase orders (the
-- purchase_orders_write rule: manager, or purchase_orders:manage), and it
-- returns only which of the CALLER'S OWN item ids are deleted or kit stock,
-- never a name. Anyone else gets 42501. anon and PUBLIC cannot execute it.
--
-- Deploy: this only adds functions, which the live web does not call, so it
-- ships BEFORE the web build that uses them. Rollback: revert the web first;
-- the unused functions are harmless and may then be dropped.

set lock_timeout = '5s';

create or replace function public.po_line_items_not_orderable(p_org_id uuid, p_item_ids uuid[])
returns table (item_id uuid, refusal text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  -- Gate: the service role (the crons; auth.uid() is null), or a caller who
  -- may write purchase orders in p_org_id (purchase_orders_write).
  if auth.uid() is not null
     and not (public.has_org_role(p_org_id, 'manager')
              or public.has_permission(p_org_id, 'purchase_orders:manage')) then
    raise exception 'You cannot manage purchase orders in this organization.'
      using errcode = '42501';
  end if;

  return query
    select i.id,
           case when i.deleted_at is not null then 'po_line_deleted' else 'po_line_bundle' end
      from public.inventory_items i
     where i.organization_id = p_org_id
       and i.id = any(p_item_ids)
       and (i.deleted_at is not null or i.is_bundle);
end;
$$;

comment on function public.po_line_items_not_orderable(uuid, uuid[]) is
  'Which of these item ids of p_org_id may not go on a purchase order: po_line_deleted (deleted) or po_line_bundle '
  '(a kit''s pre-assembled stock). Reads past RLS for save_purchase_order_draft (0366); service role or a PO writer only.';

revoke all on function public.po_line_items_not_orderable(uuid, uuid[]) from public, anon;
grant execute on function public.po_line_items_not_orderable(uuid, uuid[]) to authenticated, service_role;

create or replace function public.save_purchase_order_draft(
  p_org_id uuid,
  p_po_id uuid,
  p_po_number text,
  p_supplier_id uuid,
  p_destination_location_id uuid,
  p_charter_id uuid,
  p_expected_at timestamptz,
  p_notes text,
  p_lines jsonb,
  p_custom_item_ids uuid[] default '{}'::uuid[],
  p_actor uuid default null,
  p_skip_items_on_open_po boolean default false
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_actor        uuid := coalesce(auth.uid(), p_actor);
  v_id           uuid;
  v_status       text;
  v_rows         int;
  v_subtotal     numeric;
  v_charges      numeric := 0;
  v_stamped      int := 0;
  v_stamp_error  text;
  v_lines        jsonb;
  v_skipped      uuid[] := '{}'::uuid[];
  v_item_ids     uuid[];
  v_refused_item uuid;
  v_refusal      text;
  v_label        text;
begin
  if p_org_id is null or nullif(btrim(coalesce(p_po_number, '')), '') is null then
    raise exception 'A purchase order needs an organization and a PO number.'
      using errcode = '22023', hint = 'po_invalid';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Add at least one line item.'
      using errcode = '22023', hint = 'po_lines_required';
  end if;

  -- Shape first, so no cast below can fail on a malformed line. The CASEs keep
  -- each cast behind its type test (OR does not promise evaluation order).
  if exists (
    select 1
      from jsonb_array_elements(p_lines) as e(l)
     where case
             when jsonb_typeof(l) <> 'object' then true
             when jsonb_typeof(l->'item_id') is distinct from 'string'
               or (l->>'item_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then true
             when jsonb_typeof(l->'quantity_ordered') is distinct from 'number'
               or jsonb_typeof(l->'unit_cost') is distinct from 'number' then true
             else round((l->>'quantity_ordered')::numeric, 4) <= 0
                  or (l->>'unit_cost')::numeric < 0
           end
  ) then
    raise exception 'Each line needs an item, a quantity above 0 and a cost of 0 or more.'
      using errcode = '22023', hint = 'po_line_invalid';
  end if;

  v_lines := p_lines;

  if coalesce(p_skip_items_on_open_po, false) then
    if p_po_id is not null then
      raise exception 'Only a new purchase order can leave out items already on order.'
        using errcode = '22023', hint = 'po_invalid';
    end if;
    -- Who may take this organization's lock: a member (RLS decides the rest
    -- at the header insert below). Keeps an outsider from queueing behind or
    -- in front of another organization's reorder runs.
    if current_user in ('authenticated', 'anon') and not public.is_org_member(p_org_id) then
      raise exception 'You are not a member of this organization.'
        using errcode = '42501';
    end if;
    -- One reorder draft at a time per organization, held to commit. Every
    -- statement below runs in a snapshot taken after the lock is granted, so
    -- a run that waited here sees the lines the run before it committed.
    perform pg_advisory_xact_lock(
      hashtextextended('save_purchase_order_draft:reorder:' || p_org_id::text, 0));

    select coalesce(array_agg(distinct (e.l->>'item_id')::uuid), '{}'::uuid[])
      into v_skipped
      from jsonb_array_elements(v_lines) as e(l)
     where exists (
             select 1
               from public.purchase_order_items i
               join public.purchase_orders p on p.id = i.purchase_order_id
              where i.organization_id = p_org_id
                and p.organization_id = p_org_id
                and i.item_id = (e.l->>'item_id')::uuid
                and p.status in ('draft', 'expected_inbound', 'ordered', 'partially_received'));

    if cardinality(v_skipped) > 0 then
      select coalesce(jsonb_agg(e.l order by e.ord), '[]'::jsonb)
        into v_lines
        from jsonb_array_elements(v_lines) with ordinality as e(l, ord)
       where (e.l->>'item_id')::uuid <> all (v_skipped);
      if jsonb_array_length(v_lines) = 0 then
        -- Everything is already on order: write nothing.
        return jsonb_build_object('id', null, 'stamped', 0, 'stamp_error', null,
                                  'skipped_item_ids', to_jsonb(v_skipped));
      end if;
    end if;
  end if;

  select coalesce(sum((l->>'quantity_ordered')::numeric * (l->>'unit_cost')::numeric), 0)
    into v_subtotal
    from jsonb_array_elements(v_lines) as e(l);

  if p_po_id is null then
    -- Create. Under the API role, purchase_orders_write decides who may and
    -- the 0364 guard requires 'draft' and stamps the creator.
    insert into public.purchase_orders (
      organization_id, po_number, supplier_id, destination_location_id, charter_id,
      expected_at, notes, subtotal, total, status, created_by, updated_by)
    values (
      p_org_id, p_po_number, p_supplier_id, p_destination_location_id, p_charter_id,
      p_expected_at, p_notes, v_subtotal, v_subtotal, 'draft', v_actor, v_actor)
    returning id into v_id;
  else
    -- Edit. The row lock serialises this save against another save and
    -- against "Mark as ordered" (whose UPDATE waits here, then finds the new
    -- lines), and the status read after the lock is the draft gate that counts.
    select p.status into v_status
      from public.purchase_orders p
     where p.id = p_po_id
       and p.organization_id = p_org_id
       for update;
    if not found then
      raise exception 'Purchase order not found.'
        using errcode = 'P0002', hint = 'po_not_found';
    end if;
    if v_status is distinct from 'draft' then
      -- 55000, never 40001: see the header (PostgREST retries 40001 forever).
      raise exception 'This purchase order is no longer a draft (it may have just been ordered).'
        using errcode = '55000', hint = 'po_not_draft';
    end if;

    select coalesce(sum(c.amount), 0) into v_charges
      from public.purchase_order_charges c
     where c.purchase_order_id = p_po_id
       and c.organization_id = p_org_id;

    update public.purchase_orders
       set po_number = p_po_number,
           supplier_id = p_supplier_id,
           destination_location_id = p_destination_location_id,
           charter_id = p_charter_id,
           expected_at = p_expected_at,
           notes = p_notes,
           subtotal = v_subtotal,
           total = v_subtotal + v_charges,
           updated_by = v_actor
     where id = p_po_id
       and organization_id = p_org_id
       and status = 'draft';
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception 'Purchase order not found.'
        using errcode = 'P0002', hint = 'po_not_found';
    end if;

    -- A draft has no receipt lines (receipt_lines would RESTRICT this).
    delete from public.purchase_order_items
     where purchase_order_id = p_po_id
       and organization_id = p_org_id;
    v_id := p_po_id;
  end if;

  -- Everything the PO points at belongs to its organization. For a signed-in
  -- caller RLS and the line guard already refuse these; this covers the
  -- service role. Checked after the header write, so a caller who may not
  -- write in p_org_id learns nothing about which ids live there.
  if not public.supplier_in_org(p_supplier_id, p_org_id)
     or not public.location_in_org(p_destination_location_id, p_org_id)
     or not public.charter_in_org(p_charter_id, p_org_id)
     or exists (select 1 from jsonb_array_elements(v_lines) as e(l)
                 where not public.item_in_org((l->>'item_id')::uuid, p_org_id)) then
    raise exception 'An item, supplier, destination or charter on this purchase order is not part of this organization.'
      using errcode = '42501', hint = 'po_not_in_org';
  end if;

  -- No line for a deleted item or for a kit's pre-assembled stock (header,
  -- "Kits and deleted items"). After the org check, so an outsider learns
  -- nothing; through the definer helper, so RLS cannot hide one. The first
  -- such line in line order is named; a deleted kit counts as deleted.
  select coalesce(array_agg((l->>'item_id')::uuid order by ord), '{}'::uuid[])
    into v_item_ids
    from jsonb_array_elements(v_lines) with ordinality as e(l, ord);
  select r.item_id, r.refusal
    into v_refused_item, v_refusal
    from public.po_line_items_not_orderable(p_org_id, v_item_ids) as r
    join unnest(v_item_ids) with ordinality as u(id, ord) on u.id = r.item_id
   order by u.ord
   limit 1;
  if v_refusal is not null then
    -- The name only as the caller may read it (RLS); otherwise unnamed.
    select nullif(btrim(it.name), '') into v_label
      from public.inventory_items it
     where it.id = v_refused_item and it.organization_id = p_org_id;
    v_label := coalesce('"' || v_label || '"', 'An item on this purchase order');
    if v_refusal = 'po_line_deleted' then
      raise exception '% was deleted, so it can''t be ordered. Remove it from the purchase order and save again.', v_label
        using errcode = '22023', hint = 'po_line_deleted';
    end if;
    raise exception '% is a pre-assembled kit, and kits can''t be ordered on a purchase order: they are built from their components. Order the components instead.', v_label
      using errcode = '22023', hint = 'po_line_bundle';
  end if;

  insert into public.purchase_order_items (
    organization_id, purchase_order_id, item_id, quantity_ordered, unit_cost)
  select p_org_id, v_id, (l->>'item_id')::uuid,
         (l->>'quantity_ordered')::numeric, (l->>'unit_cost')::numeric
    from jsonb_array_elements(v_lines) with ordinality as e(l, ord)
   order by e.ord;

  -- Tag the custom items this save created with their PO, so cancelling it
  -- can archive the unused ones. Best-effort, as before: a shortfall or an
  -- error is returned for the caller to report and never fails the save.
  if coalesce(cardinality(p_custom_item_ids), 0) > 0 then
    begin
      update public.inventory_items it
         set created_from_purchase_order_id = v_id
       where it.organization_id = p_org_id
         and it.id = any(p_custom_item_ids)
         and exists (select 1 from jsonb_array_elements(v_lines) as e(l)
                      where (l->>'item_id')::uuid = it.id);
      get diagnostics v_stamped = row_count;
    exception when others then
      v_stamped := 0;
      v_stamp_error := sqlerrm;
    end;
  end if;

  return jsonb_build_object('id', v_id, 'stamped', v_stamped, 'stamp_error', v_stamp_error,
                            'skipped_item_ids', to_jsonb(v_skipped));
end;
$$;

comment on function public.save_purchase_order_draft(uuid, uuid, text, uuid, uuid, uuid, timestamptz, text, jsonb, uuid[], uuid, boolean) is
  'Create (p_po_id null) or edit a DRAFT purchase order: header, lines and custom-item tags in one transaction (0366). '
  'SECURITY INVOKER: RLS and the PO guards apply to signed-in callers as for direct writes.';

revoke all on function public.save_purchase_order_draft(uuid, uuid, text, uuid, uuid, uuid, timestamptz, text, jsonb, uuid[], uuid, boolean) from public, anon;
grant execute on function public.save_purchase_order_draft(uuid, uuid, text, uuid, uuid, uuid, timestamptz, text, jsonb, uuid[], uuid, boolean) to authenticated, service_role;

reset lock_timeout;
