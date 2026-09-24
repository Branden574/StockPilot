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
--   22023 po_invalid         no organization or PO number
--   22023 po_lines_required  p_lines is not a non-empty array
--   22023 po_line_invalid    a line without a uuid item_id, a numeric quantity
--                            above 0 (after the column's 4-decimal rounding)
--                            or a numeric cost of 0 or more. JSON numbers only:
--                            NaN, Infinity and strings are refused.
--   P0002 po_not_found       edit: no such PO in this organization (or not
--                            visible/editable to the caller)
--   40001 po_not_draft       edit: the PO is no longer a draft
--   42501 po_not_in_org      an item, supplier, destination or charter from
--                            another organization
--   23505 (unique_violation) the PO number is taken (no hint; raised by
--                            purchase_orders_org_ponumber_active_key)
--
-- Deploy: this only adds a function, which the live web does not call, so it
-- ships BEFORE the web build that uses it. Rollback: revert the web first;
-- the unused function is harmless and may then be dropped.

set lock_timeout = '5s';

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
  p_actor uuid default null
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

  select coalesce(sum((l->>'quantity_ordered')::numeric * (l->>'unit_cost')::numeric), 0)
    into v_subtotal
    from jsonb_array_elements(p_lines) as e(l);

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
      raise exception 'This purchase order is no longer a draft (it may have just been ordered).'
        using errcode = '40001', hint = 'po_not_draft';
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
     or exists (select 1 from jsonb_array_elements(p_lines) as e(l)
                 where not public.item_in_org((l->>'item_id')::uuid, p_org_id)) then
    raise exception 'An item, supplier, destination or charter on this purchase order is not part of this organization.'
      using errcode = '42501', hint = 'po_not_in_org';
  end if;

  insert into public.purchase_order_items (
    organization_id, purchase_order_id, item_id, quantity_ordered, unit_cost)
  select p_org_id, v_id, (l->>'item_id')::uuid,
         (l->>'quantity_ordered')::numeric, (l->>'unit_cost')::numeric
    from jsonb_array_elements(p_lines) with ordinality as e(l, ord)
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
         and exists (select 1 from jsonb_array_elements(p_lines) as e(l)
                      where (l->>'item_id')::uuid = it.id);
      get diagnostics v_stamped = row_count;
    exception when others then
      v_stamped := 0;
      v_stamp_error := sqlerrm;
    end;
  end if;

  return jsonb_build_object('id', v_id, 'stamped', v_stamped, 'stamp_error', v_stamp_error);
end;
$$;

comment on function public.save_purchase_order_draft(uuid, uuid, text, uuid, uuid, uuid, timestamptz, text, jsonb, uuid[], uuid) is
  'Create (p_po_id null) or edit a DRAFT purchase order: header, lines and custom-item tags in one transaction (0366). '
  'SECURITY INVOKER: RLS and the PO guards apply to signed-in callers as for direct writes.';

revoke all on function public.save_purchase_order_draft(uuid, uuid, text, uuid, uuid, uuid, timestamptz, text, jsonb, uuid[], uuid) from public, anon;
grant execute on function public.save_purchase_order_draft(uuid, uuid, text, uuid, uuid, uuid, timestamptz, text, jsonb, uuid[], uuid) to authenticated, service_role;

reset lock_timeout;
