-- 0306: pick movements name the ORDER, not the row's uuid.
--
-- THE DEFECT. Every order pick since migration 0111 has written
--
--     Order pick (order_request b3c7390a-b114-4839-a100-a008d3f3fde0)
--
-- into stock_movements.reason. The uuid resolves correctly — that one is
-- SO-000060 — but it is the machine's identifier, not the operator's, and it
-- is sitting in the field a human reads. The reason it looks like this is
-- chronological: order_requests.order_number only arrived in migration 0254,
-- four years of migrations after 0111 wrote this string, so at the time there
-- was nothing else to point at.
--
-- WHAT CHANGES, AND ONLY THIS:
--   1. The reason now reads `Order pick (SO-000060)`, zero-padded to AT LEAST
--      six to match formatOrderNumber() in
--      packages/core/src/orders/order-number.ts — `padStart(6, '0')` pads a
--      short number and leaves a long one alone, so the SQL pads to
--      greatest(6, length) rather than lpad(…, 6) (a bare lpad TRUNCATES:
--      order 1,000,000 would print as SO-100000 and collide, permanently and
--      in an append-only ledger, with the label order 100,000 already owns).
--      A movement note, the orders list and the mobile order screen therefore
--      cannot disagree about how an order is spelled. order_number is NOT NULL
--      since 0254, but a null/non-positive value still falls back to the
--      ORIGINAL text rather than emitting a broken `Order pick (SO-)`.
--   2. The machine link moves into the columns built for it:
--      reference_type='order_request', reference_id=p_order_id. Those columns
--      are what every other RPC that references a record already writes (see
--      0153/0197 returns, 0040 bundles, 0079 cycle counts), and what the
--      web/mobile activity feeds already read to render a clickable source.
--      Pick movements were the outlier that stuffed the link into prose.
--
-- WHAT DOES NOT CHANGE. This function carries the picking claim-lock (0237 /
-- 0238) and the backorder fulfillment accounting (0244 / 0247). The body below
-- was diffed against pg_get_functiondef() of the live function before editing;
-- every guard, the one-click availability clamp, the reservation release and
-- the status/stamp update are byte-identical to 0247. The only edits are the
-- reason string, the variable that holds it, and the reference stamp.
--
-- WHY THE STAMP IS A SEPARATE UPDATE, AND HOW IT KNOWS WHICH ROWS ARE ITS OWN.
-- adjust_stock() is the shared writer for every stock change in the schema. It
-- has no reference parameters and it returns the ITEM, not the ledger row it
-- just wrote. Giving it parameters would mean DROPping and recreating the
-- hottest function in the database (Postgres cannot add parameters via CREATE
-- OR REPLACE — it would create a second overload and make every existing
-- 6-argument call ambiguous), and, since it is security INVOKER and callable as
-- an RPC, it would also hand every authenticated caller the ability to stamp a
-- reference of their choosing onto a movement. So the stamp stays here — and
-- each row it touches is CAPTURED BY ID as it is created: after every
-- adjust_stock call the row that call inserted is probed for and appended to
-- v_mv_ids, and the UPDATE at the end matches `id = any(v_mv_ids)`, nothing
-- else.
--
-- THE CAPTURE IS A DIFF, NOT A TIMESTAMP MATCH — and the distinction is the
-- whole point. `created_at` is the column's own DEFAULT, now(), i.e. the
-- TRANSACTION timestamp: it narrows the probe onto the (item_id, created_at)
-- index, but it identifies nothing, because EVERY row written anywhere in this
-- transaction carries that same value. A movement written earlier in this same
-- transaction — a manual rack-to-rack transfer_stock (0231) by the same
-- operator on one of these items — matches the org, the timestamp, the
-- movement_type, the user, the null reference and the item set all at once.
-- The first draft of this migration stamped exactly such a row, writing a false
-- link into a ledger that is append-only and can never take it back. So every
-- row that already matches is collected into v_seen_ids BEFORE the first draw,
-- each captured row is added to it, and the probe therefore returns only what
-- appeared during the adjust_stock call it follows.
--
-- WHAT THE PREDICATE GUARANTEES, EXACTLY: the UPDATE stamps a row only if a
-- probe run immediately after one of this call's own adjust_stock calls found
-- that row, and ONLY that row, newly present. If a probe ever comes back with
-- anything other than exactly one row, nothing is stamped for that line: a
-- movement with no machine link still names its order in the reason and stays
-- resolvable, whereas a movement carrying the WRONG link is a false audit
-- record. The loop additionally holds `for update of ii` on every item
-- involved, so a concurrent writer cannot interleave a movement for an item
-- this call has already reached.
--
-- HISTORY IS NOT REWRITTEN. The ~99 rows already carrying the uuid form are
-- left exactly as they are: stock_movements is an append-only ledger and the
-- Movements page tells the user so. Those rows are resolved at DISPLAY time
-- instead — packages/core/src/inventory/movement-order-ref.ts parses the id
-- out of the legacy reason and the surfaces batch-resolve it to SO-000060.

-- ---------------------------------------------------------------------------
-- complete_picking — human order number in the reason, machine link in the
-- reference columns. Everything else verbatim from 0247.
-- ---------------------------------------------------------------------------
create or replace function public.complete_picking(p_order_id uuid)
returns order_requests
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_req            public.order_requests%rowtype;
  v_line           record;
  v_user           uuid := auth.uid();
  v_all_null       boolean;
  v_owed           numeric(14,4);
  v_batch          numeric(14,4);
  v_other_reserved numeric(14,4);
  v_available      numeric(14,4);
  v_reason         text;
  -- Ledger rows that are NOT this call's: everything that already matched the
  -- probe before the first draw, plus every row this call has since claimed.
  v_seen_ids       uuid[];
  v_item_ids       uuid[];
  -- The rows this call created, captured one at a time. Only these get stamped.
  v_mv_ids         uuid[] := '{}'::uuid[];
  v_new_ids        uuid[];
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  select * into v_req from public.order_requests where id = p_order_id for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;
  if not public.user_can_access_inventory(v_user, v_req.warehouse_id, null, 'write') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not public.has_org_role(v_req.organization_id, 'manager')
     and v_req.assigned_picker_id is not null
     and v_req.assigned_picker_id <> v_user then
    raise exception 'not_assigned_picker' using errcode = '42501';
  end if;
  if v_req.status not in ('pick_slip_generated', 'picking_in_progress') then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;

  -- The words a human reads. Mirrors formatOrderNumber() exactly: 'SO-' plus
  -- the number zero-padded to AT LEAST six. greatest(6, length(...)) is what
  -- makes it padStart() and not truncation — `lpad(n, 6, '0')` would cut
  -- order 1,000,000 down to SO-100000, the label order 100,000 already owns,
  -- in a ledger that cannot be corrected afterwards. A null or non-positive
  -- number gets no label at all and falls back to the pre-0306 text, so the
  -- row stays traceable rather than being labelled 'SO-'.
  v_reason := case
    when coalesce(v_req.order_number, 0) > 0
      then 'Order pick (SO-'
           || lpad(v_req.order_number::text,
                   greatest(6, length(v_req.order_number::text)),
                   '0')
           || ')'
    else 'Order pick (order_request ' || p_order_id::text || ')'
  end;

  select bool_and(quantity_picked is null)
    into v_all_null
    from public.order_request_lines
    where order_request_id = p_order_id;
  v_all_null := coalesce(v_all_null, true);

  -- Every ledger row for this order's items that ALREADY answers to the probe
  -- below. None of them were written by this call — the transaction may have
  -- written a manual transfer for one of these items a statement ago, and it
  -- carries this same transaction timestamp — so they are remembered by id and
  -- excluded. The item ids are materialised into an array first because a
  -- `in (select …)` semi-join costs the planner the (organization_id,
  -- created_at) index and turns a bounded lookup into a seq scan of the whole
  -- ledger; with the array it is an index cond on org + this transaction's
  -- timestamp, which normally matches nothing at all.
  select coalesce(array_agg(item_id), '{}'::uuid[])
    into v_item_ids
    from public.order_request_lines
   where order_request_id = p_order_id;

  select coalesce(array_agg(m.id), '{}'::uuid[])
    into v_seen_ids
    from public.stock_movements m
   where m.organization_id = v_req.organization_id
     and m.created_at      = now()
     and m.item_id         = any(v_item_ids);

  for v_line in
    select l.id                  as line_id,
           l.item_id             as item_id,
           l.quantity_picked     as picked,
           l.quantity_requested  as requested,
           l.quantity_fulfilled  as fulfilled,
           ii.quantity_on_hand   as on_hand
    from public.order_request_lines l
    join public.inventory_items ii on ii.id = l.item_id
    where l.order_request_id = p_order_id
    order by l.item_id
    for update of ii
  loop
    v_owed := greatest(coalesce(v_line.requested, 0) - coalesce(v_line.fulfilled, 0), 0);

    if v_all_null then
      -- One-click: stage what's actually available so a short order backorders
      -- the remainder instead of crashing adjust_stock. available = on_hand net
      -- of OTHER orders' active holds (this order's own reservation is its to
      -- draw). Explicit per-line picks (else branch) trust the keyed qty.
      select coalesce(sum(quantity), 0) into v_other_reserved
        from public.stock_reservations
        where item_id = v_line.item_id
          and released_at is null
          and order_request_id <> p_order_id;
      v_available := greatest(0, coalesce(v_line.on_hand, 0) - v_other_reserved);
      v_batch := least(v_owed, v_available);
    else
      v_batch := least(coalesce(v_line.picked, 0), v_owed);
    end if;

    if v_batch > 0 then
      perform public.adjust_stock(
        v_line.item_id,
        -v_batch,
        'transfer',
        null,
        v_reason,
        null
      );

      -- Capture the ledger row that call just inserted, BY ID. Every column
      -- tested here is a property adjust_stock gives the row it writes (this
      -- item, this transaction's timestamp, 'transfer', auth.uid(), no
      -- reference yet), so the probe can never miss our own row; v_seen_ids is
      -- what turns it from "rows that look like mine" into "the row that was
      -- not there a moment ago".
      select coalesce(array_agg(m.id), '{}'::uuid[])
        into v_new_ids
        from public.stock_movements m
       where m.organization_id = v_req.organization_id
         and m.item_id         = v_line.item_id
         and m.created_at      = now()
         and m.movement_type   = 'transfer'
         and m.user_id         = v_user
         and m.reference_type is null
         and not (m.id = any(v_seen_ids));

      v_seen_ids := v_seen_ids || v_new_ids;
      -- Exactly one new row is the only outcome that identifies OUR row.
      -- Anything else leaves this line unstamped rather than guessing — see
      -- the header.
      if coalesce(array_length(v_new_ids, 1), 0) = 1 then
        v_mv_ids := v_mv_ids || v_new_ids;
      end if;
    end if;

    update public.order_request_lines
      set quantity_picked = v_batch
      where id = v_line.line_id;
  end loop;

  -- Stamp the machine link on exactly the rows captured above, BY ID — the one
  -- predicate that cannot reach a row this call did not write. An empty array
  -- (nothing drawn, or a probe that could not identify its row) matches
  -- nothing. See the header for why this is an UPDATE rather than an
  -- adjust_stock argument.
  update public.stock_movements
     set reference_type = 'order_request',
         reference_id   = p_order_id
   where id = any(v_mv_ids)
     and organization_id = v_req.organization_id;

  update public.stock_reservations
    set released_at = now()
    where order_request_id = p_order_id
      and released_at is null;

  update public.order_requests
    set status               = 'picking_complete',
        picking_completed_at = now(),
        picking_completed_by = v_user,
        assigned_picker_id   = coalesce(assigned_picker_id, v_user)
    where id = p_order_id;

  select * into v_req from public.order_requests where id = p_order_id;
  return v_req;
end;
$function$;
