-- LOCAL LAB ONLY: run with psql against the LOCAL stack (127.0.0.1:54322),
-- never against production. Production-shaped item history for the Perf Lab org.
-- Production 2026-09-22: movements/item p50 2, p90 5, max 28; audits/item
-- p50 2, p90 6, max 57. The 40 most recently updated items (the first rows,
-- the ones the harness opens) get the maximum; every other item gets p90.
begin;
do $$
declare
  org uuid := (select id from organizations where name = 'StockPilot Perf Lab');
  users uuid[] := array(select user_id from organization_members where organization_id = org and role in ('owner','admin','manager','staff'));
  locs uuid[] := array(select id from locations where organization_id = org limit 20);
  types text[] := array['initial','receive_po','transfer','add','remove','transfer','correction','adjust','transfer','return'];
  events text[] := array['inventory.item.updated','inventory.item.updated','stock.transferred','inventory.item.updated','order_request.created','pdf.exported','restore_point.created'];
  it record; k int; nm int; na int; q numeric; t timestamptz;
begin
  if org is null then
    raise exception 'Perf Lab organization not found: this seed is for the local lab copy only';
  end if;
  if exists (select 1 from stock_movements where organization_id = org) then
    raise notice 'already seeded'; return;
  end if;
  for it in select id, row_number() over (order by updated_at desc) rn from inventory_items where organization_id = org loop
    nm := case when it.rn <= 40 then 28 else 5 end;
    na := case when it.rn <= 40 then 57 else 6 end;
    q := 0;
    for k in 1..nm loop
      t := now() - ((nm - k) * interval '37 hours') - interval '1 hour';
      insert into stock_movements (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity,
        from_location_id, to_location_id, reason, user_id, notes, created_at)
      values (org, it.id, types[1 + (k - 1) % array_length(types, 1)], 5, q, q + 5,
        case when k % 3 = 0 then locs[1 + k % array_length(locs, 1)] end,
        locs[1 + (k + 1) % array_length(locs, 1)],
        case when k % 4 = 0 then 'Cycle count correction' end,
        users[1 + k % array_length(users, 1)],
        case when k % 5 = 0 then 'Lab seed note' end, t);
      q := q + 5;
    end loop;
    insert into audit_logs (organization_id, user_id, event, metadata, created_at)
    values (org, users[1], 'inventory.item.created', jsonb_build_object('entity_id', it.id::text, 'entity_type', 'inventory_item'), now() - interval '120 days');
    for k in 2..na loop
      insert into audit_logs (organization_id, user_id, event, metadata, created_at)
      values (org, users[1 + k % array_length(users, 1)], events[1 + k % array_length(events, 1)],
        jsonb_build_object('entity_id', it.id::text, 'entity_type', 'inventory_item', 'changes', jsonb_build_object('notes', 'lab')),
        now() - ((na - k) * interval '17 hours'));
    end loop;
  end loop;
end $$;
commit;
select (select count(*) from stock_movements) movements, (select count(*) from audit_logs where metadata ? 'entity_id') audits;
