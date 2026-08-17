# Repair: book crate labels erased by plain-rack put-away (2026-08-17)

## What happened

Between 17:50 and 18:28 UTC on 2026-08-17 the staging put-away in L4L North
Region moved books from Staging onto the plain racks "38-B" and "38-C". The
placement reconciliation (`syncBookCratePlacement`, migration 0336 writer)
derived the crate half of each book's summary from the destination row — a
rack row, which has no crate columns — and wrote `book_crate_color = NULL,
book_crate_number = NULL`. Those crates existed ONLY as the item's label (no
`locations` row), so the label was the only record.

Fixed in code by `fix(placement): a crate erasure needs permission` (the
reconciliation now KEEPS a recorded crate on a plain-rack move unless the
operator was shown the clear and agreed) and by the put-away dialogs placing
INTO the recorded crate-on-rack by default.

The reconciliation's own audit rows (`inventory.item.updated`,
`metadata.placement = 'book_crate'`) carry the exact `before` pair, so the
erased labels are recoverable.

## Part 1 — READ-ONLY preview (run first; safe)

```sql
with erasures as (
  select a.id as audit_id, a.organization_id, a.created_at,
         (a.metadata->>'entity_id')::uuid as item_id,
         a.metadata->'before'->>'book_crate_color'  as before_color,
         a.metadata->'before'->>'book_crate_number' as before_number,
         a.metadata->>'to_location_id' as to_location_id
  from audit_logs a
  where a.event = 'inventory.item.updated'
    and a.metadata->>'placement' = 'book_crate'
    and (a.metadata->'before'->>'book_crate_color'  is not null
      or a.metadata->'before'->>'book_crate_number' is not null)
    and a.metadata->'after'->>'book_crate_color'  is null
    and a.metadata->'after'->>'book_crate_number' is null
    and exists (select 1 from audit_logs t
                 where t.event = 'stock.transferred'
                   and t.metadata->>'entity_id' = a.metadata->>'entity_id'
                   and t.created_at between a.created_at - interval '3 seconds' and a.created_at)
),
-- the LATEST erasure per item wins
latest as (
  select distinct on (item_id) * from erasures order by item_id, created_at desc
)
select l.item_id, i.name, o.name as org, l.before_color, l.before_number,
       i.custom_fields->>'book_crate_color'  as current_color,
       i.custom_fields->>'book_crate_number' as current_number,
       case
         when i.custom_fields->>'book_crate_color' is null and i.custom_fields->>'book_crate_number' is null
           then 'REPAIR'                       -- still empty: safe to restore
         when lower(coalesce(i.custom_fields->>'book_crate_color',''))  = lower(coalesce(l.before_color,''))
          and lower(coalesce(i.custom_fields->>'book_crate_number','')) = lower(coalesce(l.before_number,''))
           then 'ALREADY_RESTORED_SAME'        -- owner re-set to the audited value
         else 'RESET_BY_HAND_DIFFERENT'        -- owner re-set to something else: DO NOT TOUCH, list for reconciliation
       end as disposition,
       l.created_at as erased_at, l.audit_id, l.to_location_id
from latest l
join inventory_items i on i.id = l.item_id and i.deleted_at is null and i.item_type = 'book'
join organizations o on o.id = l.organization_id
order by l.created_at;
```

### Preview result (prod, read-only via MCP, 2026-08-17 ~12:25 PT)

All seven rows are L4L North Region. Destinations: `3b2d8dcb…` = rack "38-B",
`38e832a2…` = rack "38-C" (both `kind = rack`, no crate columns).

| erased_at (UTC) | item | before (audit) | current | disposition |
| --- | --- | --- | --- | --- |
| 17:50:52.780 | Maus I, My Father Bleeds History `9c481921-db94-42fe-8189-24a7c47a3937` | yellow / 6 | orange / 6 | RESET_BY_HAND_DIFFERENT |
| 18:08:59.819 | The Joy Luck Club `658c697c-93e4-460f-b9a2-ad60719c2e57` | red / 4 | pink / 4 | RESET_BY_HAND_DIFFERENT |
| 18:13:55.888 | To Kill a Mockingbird `1ba536ef-5ed7-4ee4-8bc0-32bbae50fb76` | green / 10 | green / 10 | ALREADY_RESTORED_SAME |
| 18:19:02.126 | The Great Gatsby `a2922f1b-a468-4ff8-8fcf-9470d9d286ec` | green / 7 | green / 7 | ALREADY_RESTORED_SAME |
| 18:22:27.648 | Of Mice and Men `8fcdc1e2-7dd1-4a3f-8104-70f83df0e7f7` | purple / 9 | NULL / NULL | **REPAIR** |
| 18:25:53.402 | Into the wild `d7e13e20-a280-44b7-ba16-e290f18f723c` | yellow / 15 | yellow / 15 | ALREADY_RESTORED_SAME |
| 18:27:38.749 | George Orwell - 1984 `4e25a733-5bc7-4e20-a866-058d7da0f70b` | yellow / 8 | orange / 8 | RESET_BY_HAND_DIFFERENT |

- **REPAIR set = 1 row**: Of Mice and Men — Part 2 would restore `purple / 9`.
- **Owner must reconcile by hand (3 rows)** — the audit says one colour, the
  owner typed another; the script deliberately does not touch these:
  - Maus I: audit `yellow 6`, now `orange 6`
  - The Joy Luck Club: audit `red 4`, now `pink 4`
  - George Orwell - 1984: audit `yellow 8`, now `orange 8`
- Already restored to the audited value (3 rows, nothing to do): To Kill a
  Mockingbird, The Great Gatsby, Into the wild.

## Part 2 — THE UPDATE (NOT RUN; owner authorises)

Restores ONLY rows whose disposition is `REPAIR` (both crate keys still null).
Rows the owner already re-set are excluded by construction. Merge idiom is
the 0334/0336 one: strip the two keys, re-add the non-null ones. Plain UPDATE,
not the RPC — under service role RLS is bypassed, so the predicate is tight
in FOUR independent ways (belt and braces, any one of which alone confines
the write):

1. the explicit `IN` list of REPAIR ids copied from Part 1, verbatim;
2. the explicit `organization_id` — L4L North Region,
   `63c13e64-92a6-4ea4-9936-6a2c26a85b4a` (every Part 1 row was this org;
   a wrong id here writes ZERO rows rather than the wrong org's rows);
3. `latest.organization_id = i.organization_id` — the erasure audit row and
   the item must belong to the same org, so a cross-org id collision (or a
   pasted id from another tenant) matches nothing;
4. both crate keys still null on the item at write time — the owner re-typing
   a label between Part 1 and Part 2 excludes the row by construction.

Every restored item also gets its OWN `inventory.item.updated` audit row, in
the SAME shape the reconciliation writes (`metadata.placement = 'book_crate'`,
`before`/`after` with all four placement keys, `changed_keys`), so the repair
sits beside the erasure in the item's Activity feed and the audit log, and a
reviewer can read erasure -> repair as two rows of one story. The repair row
additionally carries `repair_of_audit_id` (the erasure row it reverses),
`erased_at`, `runbook`, and a `reason`. `user_id` is NULL: no human made this
write; the runbook did, under service role — the reason text names it.

Run as ONE transaction. The two `select`s at the end are the check: the count
of restored rows must equal the count of repair audit rows must equal the
size of the REPAIR set from the fresh Part 1 run (1, as of the last preview).
COMMIT only when all three agree; ROLLBACK otherwise.

```sql
-- begin;
--
-- with erasures as (
--   select a.id as audit_id, a.organization_id, a.created_at,
--          (a.metadata->>'entity_id')::uuid as item_id,
--          a.metadata->'before'->>'book_crate_color'  as before_color,
--          a.metadata->'before'->>'book_crate_number' as before_number,
--          a.metadata->>'to_location_id' as to_location_id
--   from audit_logs a
--   where a.event = 'inventory.item.updated'
--     and a.metadata->>'placement' = 'book_crate'
--     and (a.metadata->'before'->>'book_crate_color'  is not null
--       or a.metadata->'before'->>'book_crate_number' is not null)
--     and a.metadata->'after'->>'book_crate_color'  is null
--     and a.metadata->'after'->>'book_crate_number' is null
--     and exists (select 1 from audit_logs t
--                  where t.event = 'stock.transferred'
--                    and t.metadata->>'entity_id' = a.metadata->>'entity_id'
--                    and t.created_at between a.created_at - interval '3 seconds' and a.created_at)
-- ),
-- latest as (
--   select distinct on (item_id) * from erasures order by item_id, created_at desc
-- ),
-- repaired as (
--   update inventory_items i
--      set custom_fields = (coalesce(i.custom_fields,'{}'::jsonb) - 'book_crate_color' - 'book_crate_number')
--                          || jsonb_strip_nulls(jsonb_build_object(
--                               'book_crate_color',  nullif(btrim(coalesce(l.before_color,'')),''),
--                               'book_crate_number', nullif(btrim(coalesce(l.before_number,'')),''))),
--          updated_at = now()
--     from latest l
--    where i.id = l.item_id
--      -- (1) the REPAIR ids from Part 1, verbatim
--      and i.id in ('8fcdc1e2-7dd1-4a3f-8104-70f83df0e7f7')
--      -- (2) the org, explicitly — L4L North Region
--      and i.organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a'
--      -- (3) the erasure row and the item are the same org's
--      and l.organization_id = i.organization_id
--      -- (4) still erased at write time
--      and i.deleted_at is null and i.item_type = 'book'
--      and i.custom_fields->>'book_crate_color'  is null
--      and i.custom_fields->>'book_crate_number' is null
--   returning i.id, i.organization_id, i.custom_fields,
--             l.audit_id as erasure_audit_id, l.created_at as erased_at,
--             l.before_color, l.before_number, l.to_location_id
-- ),
-- audited as (
--   insert into audit_logs (organization_id, user_id, event, ip, user_agent, metadata)
--   select r.organization_id,
--          null,                                   -- no human actor: the runbook, under service role
--          'inventory.item.updated',
--          null, null,
--          jsonb_build_object(
--            'entity_type', 'inventory_item',
--            'entity_id',   r.id,
--            'warehouse_id', null,
--            -- BEFORE is the erased state (both crate keys null — predicate (4)
--            -- guarantees it) with the rack pair as it stands, which this
--            -- repair does not touch.
--            'before', jsonb_build_object(
--              'book_crate_color',  null,
--              'book_crate_number', null,
--              'book_rack_number',  r.custom_fields->>'book_rack_number',
--              'book_rack_row',     r.custom_fields->>'book_rack_row'),
--            -- AFTER is the row as written: the audited pair restored, rack unchanged.
--            'after', jsonb_build_object(
--              'book_crate_color',  r.custom_fields->>'book_crate_color',
--              'book_crate_number', r.custom_fields->>'book_crate_number',
--              'book_rack_number',  r.custom_fields->>'book_rack_number',
--              'book_rack_row',     r.custom_fields->>'book_rack_row'),
--            'reason', 'Repair: crate label erased by plain-rack put-away on 2026-08-17 (reconciliation derived no-crate from a rack row); restored from the erasure audit row''s before pair. docs/runbooks/2026-08-17-erased-crate-labels-repair.md, Part 2.',
--            'placement', 'book_crate',
--            'changed_keys', jsonb_build_array('book_crate_color', 'book_crate_number'),
--            'repair_of_audit_id', r.erasure_audit_id,
--            'erased_at', r.erased_at,
--            'erased_to_location_id', r.to_location_id,
--            'runbook', 'docs/runbooks/2026-08-17-erased-crate-labels-repair.md#part-2')
--   from repaired r
--   returning id, (metadata->>'entity_id')::uuid as item_id
-- )
-- select (select count(*) from repaired) as restored,
--        (select count(*) from audited)  as audit_rows,
--        (select string_agg(item_id::text, ', ') from audited) as items;
--
-- -- restored = audit_rows = size of the REPAIR set from the fresh Part 1 run
-- -- (1 as of the last preview) -> commit; anything else -> rollback.
-- -- commit;
```

Re-run Part 1 immediately before Part 2: the REPAIR set changes whenever the
owner re-types a label by hand, and Part 2 must never overwrite one of those.
If the fresh Part 1 REPAIR set differs from the `IN` list above, update the
list first (predicate (1)); predicates (2)-(4) still confine the write if a
wrong id is pasted.

### Part 2 authoring notes (2026-08-17, ~13:30 PT; SELECT-only re-check)

- The one REPAIR row is unchanged: Of Mice and Men
  `8fcdc1e2-7dd1-4a3f-8104-70f83df0e7f7`, org
  `63c13e64-92a6-4ea4-9936-6a2c26a85b4a`, both crate keys still NULL, live,
  `item_type = 'book'`.
- The audit row shape mirrors `syncBookCratePlacement`'s own write
  (apps/web/src/server/services/inventory.ts, `placement: 'book_crate'`,
  all four placement keys in `before`/`after`, `changed_keys`), so the
  Activity feed and the audit log render it with the same reader. The extra
  `repair_of_audit_id` / `erased_at` / `runbook` keys are additive metadata;
  `audit_logs.metadata` is un-checked jsonb and `event` is un-checked text.
- LOCAL REHEARSAL (rolled back, local Supabase only, never prod): the exact
  statement above was run inside `begin … rollback` against a fixture that
  mirrors the prod shape — the L4L org id, the REPAIR item id with both crate
  keys null and rack 38-C, its `stock.transferred` + erasure audit rows, plus
  a DECOY erasure (same shape, other org, other item). Result: `restored 1 |
  audit_rows 1 | items 8fcdc1e2-…`; the item read back `purple / 9`, rack 38
  and `author` intact (merge, not replace); the decoy stayed NULL; exactly one
  repair audit row, `before` {null,null,38,C} -> `after` {purple,9,38,C},
  `repair_of_audit_id` pointing at the erasure row. Then ROLLBACK.
- NOT RUN in prod. Owner authorises; coordinator (or owner) runs under service
  role.
