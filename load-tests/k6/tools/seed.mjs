#!/usr/bin/env node
// Seeds a throwaway load-test organization on the LOCAL Supabase stack.
//
//   node load-tests/k6/tools/seed.mjs --items 1000 --users-per-role 20 --out <manifest.json>
//
// Needs (from the environment, never printed):
//   LOADTEST_DB_URL                      postgresql://...@127.0.0.1:<port>/postgres
//   LOADTEST_SUPABASE_URL                http://127.0.0.1:<port>
//   LOADTEST_SUPABASE_SERVICE_ROLE_KEY   the local stack's service key
// Refuses any address that is not this machine.
//
// What it makes, all made up:
//   - one organization (enterprise plan, every module on, authenticator
//     policy optional so no synthetic account is asked for a code)
//   - accounts per role: owner, admin, manager, staff, viewer, and staff
//     limited to the first warehouse ("staff_one_warehouse"), each with a
//     password derived from the service key (accountPassword below)
//   - warehouses (the first gets 70% of the items), categories, suppliers
//   - N items with stock; the item insert trigger (tg_seed_initial_level)
//     creates each item's holding in its warehouse's Unplaced location, and an
//     'initial' stock movement is written beside it, as the app's create does
//   - open purchase orders with very large lines, so receive tests never
//     close them
// Every write batch is at most ~36k rows in one transaction (items, their
// holdings and their opening movements, 12k items a batch). ANALYZE at the end.
//
// The manifest (no keys, no tokens) lists the organization, the accounts and
// the id pools the k6 workload draws from. teardown.mjs removes all of it.
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { authAdmin, lit, localSupabase, parseArgs, pool, psql, psqlJson } from './local.mjs';

export const ROLES = ['owner', 'admin', 'manager', 'staff', 'viewer', 'staff_one_warehouse'];
const ITEM_BATCH = 12000;
const EMAIL_DOMAIN = 'example.com';

const ADJECTIVES = [
  'Blue',
  'Red',
  'Green',
  'Black',
  'White',
  'Large',
  'Small',
  'Heavy',
  'Light',
  'Clear',
  'Yellow',
  'Gray',
];
const NOUNS = [
  'Cable Ties',
  'Notebook',
  'Marker',
  'Stapler',
  'Binder',
  'Folder',
  'Pencil',
  'Eraser',
  'Scissors',
  'Ruler',
  'Glue Stick',
  'Calculator',
  'Backpack',
  'Lunch Box',
  'Water Bottle',
  'Crayons',
  'Paint Set',
  'Brush',
  'Tape Roll',
  'Label Pack',
  'Battery Pack',
  'Extension Cord',
  'Headphones',
  'Mouse',
  'Keyboard',
  'Charger',
  'Clipboard',
  'Whiteboard',
  'Sticky Notes',
  'Index Cards',
  'Paper Ream',
  'Envelope',
  'Box Cutter',
  'Gloves',
  'Safety Glasses',
  'Hand Sanitizer',
  'Tissue Box',
  'Paper Towel',
  'Trash Bags',
  'Mop Head',
];
const CATEGORIES = [
  'Office Supplies',
  'Classroom',
  'Art',
  'Technology',
  'Cleaning',
  'Safety',
  'Furniture',
  'Books',
  'Sports',
  'Kitchen',
  'Electrical',
  'Paper',
];

/**
 * Each account's password: derived from the local service key and the email,
 * never stored. k6 setup() derives the same one to sign in (lib/auth.js
 * accountPassword); the wrapping meets the stack's rule of lower, upper and digits.
 */
export function accountPassword(serviceKey, email) {
  return `Lt9x${createHmac('sha256', serviceKey).update(`stockpilot-loadtest:${email}`).digest('hex').slice(0, 32)}Q`;
}

function emailFor(runId, role, n) {
  return `loadtest+${runId}-${role.replace(/_/g, '-')}-${n}@${EMAIL_DOMAIN}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const items = Number(args.items ?? 1000);
  const usersPerRole = Number(args['users-per-role'] ?? 20);
  const warehouseCount = Math.max(2, Number(args.warehouses ?? 2));
  const poCount = Number(args.pos ?? 8);
  const linesPerPo = Number(args['lines-per-po'] ?? 25);
  const out = args.out;
  if (!out) throw new Error('--out <manifest.json> is required');
  if (!Number.isInteger(items) || items < 100 || items > 200000)
    throw new Error('--items must be 100..200000');
  if (!Number.isInteger(usersPerRole) || usersPerRole < 1 || usersPerRole > 200) {
    throw new Error('--users-per-role must be 1..200');
  }

  // Both checked before anything connects (localSupabase and psql refuse a
  // non-loopback address).
  const sb = localSupabase();
  psql('select 1;');

  const runId = String(args['run-id'] ?? randomUUID().slice(0, 8))
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
  // teardown.mjs --all recognises a load-test organization by this shape.
  if (!/^[a-z0-9]{4,16}$/.test(runId)) throw new Error('--run-id must be 4-16 letters or digits');
  const orgId = randomUUID();
  const t0 = Date.now();
  const log = (m) => console.log(`[seed ${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

  // ── Accounts (GoTrue admin API, so each account is a complete auth user) ──
  const wanted = [];
  for (const role of ROLES) for (let n = 1; n <= usersPerRole; n++) wanted.push({ role, n });
  const users = await pool(wanted, 8, async ({ role, n }) => {
    const email = emailFor(runId, role, n);
    const u = await authAdmin(sb, 'POST', '/admin/users', {
      email,
      password: accountPassword(sb.serviceKey, email),
      email_confirm: true,
      user_metadata: { full_name: `Load ${role.replace(/_/g, ' ')} ${n}` },
    });
    return { role, n, email, id: u.id };
  });
  log(`${users.length} accounts`);

  const owner = users.find((u) => u.role === 'owner');
  const whIds = Array.from({ length: warehouseCount }, () => randomUUID());
  const catIds = CATEGORIES.map(() => randomUUID());
  const supIds = [randomUUID(), randomUUID(), randomUUID()];

  // ── Organization, members, warehouses, categories, suppliers ──
  const memberRows = users
    .map((u) => {
      const role = u.role === 'staff_one_warehouse' ? 'staff' : u.role;
      return `(${lit(orgId)}, ${lit(u.id)}, ${lit(role)}, now(), false)`;
    })
    .join(',\n');
  const assignRows = [];
  for (const u of users) {
    if (!['staff', 'viewer', 'staff_one_warehouse'].includes(u.role)) continue;
    const whs = u.role === 'staff_one_warehouse' ? [whIds[0]] : whIds;
    whs.forEach((w, i) => assignRows.push(`(${lit(orgId)}, ${lit(u.id)}, ${lit(w)}, ${i === 0})`));
  }
  psql(`
begin;
insert into public.organizations (id, name, slug, plan, mfa_policy, all_modules_comp, timezone, domain_pack)
values (${lit(orgId)}, ${lit(`Load Test Org ${runId}`)}, ${lit(`loadtest-${runId}`)}, 'enterprise', 'optional', true,
        'America/Los_Angeles', 'charter_school');
insert into public.organization_members (organization_id, user_id, role, accepted_at, all_warehouses)
values ${memberRows};
update public.user_profiles p set default_organization_id = ${lit(orgId)},
  full_name = coalesce(p.full_name, 'Load account')
 where p.id in (${users.map((u) => lit(u.id)).join(',')});
insert into public.warehouses (id, organization_id, name, code, status)
values ${whIds.map((w, i) => `(${lit(w)}, ${lit(orgId)}, ${lit(i === 0 ? 'Main Warehouse' : `Annex ${i}`)}, ${lit(`LT-W${i + 1}`)}, 'active')`).join(',\n')};
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary)
values ${assignRows.join(',\n')};
insert into public.categories (id, organization_id, name)
values ${CATEGORIES.map((c, i) => `(${lit(catIds[i])}, ${lit(orgId)}, ${lit(c)})`).join(',\n')};
insert into public.suppliers (id, organization_id, name)
values ${supIds.map((s, i) => `(${lit(s)}, ${lit(orgId)}, ${lit(`Sample Supplier ${i + 1}`)})`).join(',\n')};
${whIds.map((w) => `select public.ensure_warehouse_placement_locations(${lit(w)});`).join('\n')}
commit;
`);
  log(`organization ${orgId} (slug loadtest-${runId}), ${warehouseCount} warehouses`);

  // ── Items: the insert trigger makes the holding; the opening movement beside it ──
  const whArr = `array[${whIds.map(lit).join(',')}]::uuid[]`;
  const catArr = `array[${catIds.map(lit).join(',')}]::uuid[]`;
  const adjArr = `array[${ADJECTIVES.map(lit).join(',')}]`;
  const nounArr = `array[${NOUNS.map(lit).join(',')}]`;
  // Warehouse of item g: the first warehouse for 7 in 10, the rest share 3 in 10.
  const whExpr = `case when g % 10 < 7 then 1 else 2 + (g % 10 - 7) % ${warehouseCount - 1} end`;
  for (let start = 1; start <= items; start += ITEM_BATCH) {
    const end = Math.min(items, start + ITEM_BATCH - 1);
    psql(`
begin;
set local stockpilot.derived_write = 'on';
with ins as (
  insert into public.inventory_items (
    organization_id, warehouse_id, category_id, sku, barcode, name, unit_cost, retail_price,
    quantity_on_hand, reorder_point, reorder_quantity, status, order_catalog_visible, created_by)
  select ${lit(orgId)},
         (${whArr})[${whExpr}],
         (${catArr})[1 + g % ${CATEGORIES.length}],
         'LT-W' || (${whExpr}) || '-' || lpad(g::text, 6, '0'),
         'LTB' || lpad(g::text, 9, '0'),
         (${adjArr})[1 + g % ${ADJECTIVES.length}] || ' ' || (${nounArr})[1 + (g / ${ADJECTIVES.length}) % ${NOUNS.length}] || ' ' || (g % 97),
         round((1 + (g * 7919) % 5000 / 100.0)::numeric, 2),
         round((2 + (g * 7919) % 9000 / 100.0)::numeric, 2),
         case when g % 50 = 0 then 0 when g % 13 = 0 then 0 when g % 7 = 0 then 2 + g % 6 else 40 + (g * 37) % 460 end,
         case when g % 5 = 0 then 10 + g % 20 else 0 end,
         case when g % 5 = 0 then 50 else 0 end,
         case when g % 50 = 0 then 'archived' else 'active' end,
         g % 5 <> 1,
         ${lit(owner.id)}
    from generate_series(${start}, ${end}) g
  returning id, organization_id, quantity_on_hand
)
insert into public.stock_movements (organization_id, item_id, movement_type, quantity_change,
                                    previous_quantity, new_quantity, user_id, reason)
select organization_id, id, 'initial', quantity_on_hand, 0, quantity_on_hand, ${lit(owner.id)}, 'Opening stock'
  from ins where quantity_on_hand > 0;
commit;
`);
    log(`items ${start}..${end}`);
  }

  // ── Open purchase orders with very large lines, on first-warehouse items ──
  const poIds = Array.from({ length: poCount }, () => randomUUID());
  psql(`
begin;
insert into public.purchase_orders (id, organization_id, po_number, supplier_id, status, ordered_at, created_by)
values ${poIds
    .map(
      (p, i) =>
        `(${lit(p)}, ${lit(orgId)}, ${lit(`LT-${runId}-PO-${String(i + 1).padStart(3, '0')}`)}, ${lit(supIds[i % supIds.length])}, 'ordered', now(), ${lit(owner.id)})`,
    )
    .join(',\n')};
insert into public.purchase_order_items (organization_id, purchase_order_id, item_id, quantity_ordered, unit_cost)
select ${lit(orgId)}, (array[${poIds.map(lit).join(',')}]::uuid[])[1 + (rn - 1) / ${linesPerPo}], id, 1000000, unit_cost
  from (select id, unit_cost, row_number() over (order by sku) rn
          from public.inventory_items
         where organization_id = ${lit(orgId)} and warehouse_id = ${lit(whIds[0])}
           and status = 'active' and item_type = 'product') s
 where rn <= ${poCount * linesPerPo};
commit;
`);
  log(`${poCount} purchase orders x ${linesPerPo} lines`);

  psql(`analyze public.inventory_items; analyze public.item_stock_levels; analyze public.stock_movements;
analyze public.purchase_orders; analyze public.purchase_order_items; analyze public.organization_members;
analyze public.user_warehouse_assignments; analyze public.locations;`);
  log('analyzed');

  // ── Pools for the workload ──
  const pools = psqlJson(`
select json_build_object(
  'read', (select coalesce(json_agg(r), '[]') from (
      select id, sku, barcode, warehouse_id as "warehouseId", name from public.inventory_items
       where organization_id = ${lit(orgId)} and status = 'active' order by md5(id::text) limit 2000) r),
  'w1Read', (select coalesce(json_agg(r), '[]') from (
      select id, sku, barcode, name from public.inventory_items
       where organization_id = ${lit(orgId)} and status = 'active' and warehouse_id = ${lit(whIds[0])}
       order by md5(id::text) limit 2000) r),
  'otherWarehouse', (select coalesce(json_agg(r), '[]') from (
      select id, sku, barcode, warehouse_id as "warehouseId" from public.inventory_items
       where organization_id = ${lit(orgId)} and status = 'active' and warehouse_id <> ${lit(whIds[0])}
       order by md5(id::text) limit 300) r),
  'order', (select coalesce(json_agg(r), '[]') from (
      select id, warehouse_id as "warehouseId" from public.inventory_items
       where organization_id = ${lit(orgId)} and status = 'active' and order_catalog_visible
         and warehouse_id = ${lit(whIds[0])} and quantity_on_hand >= 40
       order by md5(id::text) limit 500) r),
  'adjust', (select coalesce(json_agg(r), '[]') from (
      select i.id from public.inventory_items i
       where i.organization_id = ${lit(orgId)} and i.status = 'active' and i.warehouse_id = ${lit(whIds[0])}
         and i.quantity_on_hand >= 40
         and not exists (select 1 from public.purchase_order_items l where l.item_id = i.id)
       order by md5(i.id::text) limit 500) r),
  'receive', (select coalesce(json_agg(r), '[]') from (
      select l.purchase_order_id as "poId", l.item_id as "itemId", ${lit(whIds[0])} as "warehouseId"
        from public.purchase_order_items l where l.organization_id = ${lit(orgId)}
       order by l.purchase_order_id, l.item_id) r)
);`);

  const manifest = {
    kind: 'stockpilot-loadtest-manifest',
    version: 1,
    runId,
    createdAt: new Date().toISOString(),
    organizationId: orgId,
    slug: `loadtest-${runId}`,
    scale: { items, usersPerRole, warehouses: warehouseCount, purchaseOrders: poCount, linesPerPo },
    warehouses: whIds.map((id, i) => ({ id, code: `LT-W${i + 1}` })),
    users: Object.fromEntries(
      ROLES.map((r) => [
        r,
        users.filter((u) => u.role === r).map((u) => ({ id: u.id, email: u.email })),
      ]),
    ),
    searchTerms: [...NOUNS.map((n) => n.split(' ')[0].toLowerCase()), 'LT-W1-00', 'LTB000'],
    otherWarehouseTerm: 'LT-W2-',
    pools,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(manifest, null, 1));
  log(`manifest ${out}`);
}

main().catch((e) => {
  console.error(`[seed] ${e.message}`);
  process.exit(1);
});
