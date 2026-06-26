#!/usr/bin/env node
/**
 * Seed (or refresh) the "StockPilot Demo Co" organization in PRODUCTION with a
 * realistic mixed-retail catalog + clean product photos, for App Store
 * screenshots and future testing on the mobile app.
 *
 * Photos: product shots come from DummyJSON's CDN (clean white-background
 * e-commerce images, no watermark) chosen to MATCH each item name; book covers
 * come from OpenLibrary (real covers). A Picsum seed is the last-resort fallback
 * so a row is never blank. Images are downloaded and re-uploaded into the org's
 * own `item-images` bucket, so they're durable once seeded.
 *
 * SAFETY:
 *   - Targets prod intentionally (the App Store build reads prod). It ONLY ever
 *     creates / touches the org with slug `stockpilot-demo`. Every read + write
 *     is filtered by that org's id. It never reads or modifies any other org.
 *   - Aborts if the service key does not actually bypass RLS (wrong/anon key),
 *     and refuses to operate on the real org id.
 *   - Re-runnable: find-or-create by slug; items upserted by SKU; photos only
 *     uploaded if missing. `--reset` deletes the demo org's catalog and reseeds.
 *
 * Usage:
 *   node apps/web/scripts/seed-demo-org.mjs           # create/refresh
 *   node apps/web/scripts/seed-demo-org.mjs --reset   # wipe demo data + reseed
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESET = process.argv.includes('--reset');

// ── Config ──────────────────────────────────────────────────────────────────
const PROD_URL = 'https://xizpqmhhslgzbuqtjubv.supabase.co';
const REAL_ORG_ID = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a'; // never touch this one
const OWNER_USER_ID = '270ed6d2-af71-49b7-a4be-a82f21685a7f'; // branden574@gmail.com
const DEMO = {
  name: 'StockPilot Demo Co',
  slug: 'stockpilot-demo',
  plan: 'pro',
  domain_pack: 'charter_school',
  timezone: 'America/Los_Angeles',
  currency: 'USD',
};
const BUCKET = 'item-images';
const DJ = 'https://cdn.dummyjson.com/product-images/';
const bookCover = (title, bg, fg) =>
  `https://placehold.co/600x800/${bg}/${fg}/png?text=${encodeURIComponent(title).replace(/%20/g, '+')}&font=playfair-display`;

function readServiceKey() {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY;
  const env = readFileSync(resolve(__dirname, '../.env.local'), 'utf8');
  const m = env.match(/^\s*SUPABASE_SERVICE_ROLE_KEY\s*=\s*"?([^"\n]+)"?/m);
  if (!m) die('SUPABASE_SERVICE_ROLE_KEY not found in env or apps/web/.env.local');
  return m[1].trim();
}

const admin = createClient(PROD_URL, readServiceKey(), { auth: { persistSession: false } });
const die = (m) => { console.error(`\n✗ ${m}\n`); process.exit(1); };
const log = (m) => console.log(m);

// ── Helpers ─────────────────────────────────────────────────────────────────
async function findOne(table, match, cols = 'id') {
  let q = admin.from(table).select(cols);
  for (const [k, v] of Object.entries(match)) q = v === null ? q.is(k, null) : q.eq(k, v);
  const { data, error } = await q.limit(1).maybeSingle();
  if (error) die(`select ${table}: ${error.message}`);
  return data;
}
async function findOrCreate(table, match, row) {
  const found = await findOne(table, match);
  if (found) return found.id;
  const { data, error } = await admin.from(table).insert({ ...match, ...row }).select('id').single();
  if (error) die(`insert ${table}: ${error.message}`);
  return data.id;
}

async function uploadPhoto(orgId, itemId, sources) {
  for (const url of sources) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
      if (!res.ok) continue;
      const ct = res.headers.get('content-type') || '';
      if (!ct.startsWith('image/')) continue;
      const buf = new Uint8Array(await res.arrayBuffer()); // arrayBuffer, NOT blob (0-byte gotcha)
      if (buf.byteLength < 2000) continue;
      const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
      const path = `${orgId}/${itemId}/photo.${ext}`;
      const { error } = await admin.storage
        .from(BUCKET)
        .upload(path, buf, { contentType: ct, upsert: true, cacheControl: '604800' });
      if (error) throw new Error(error.message);
      return path;
    } catch { /* next source */ }
  }
  return null;
}

// ── Catalog ─────────────────────────────────────────────────────────────────
const CATEGORIES = ['Electronics', 'Apparel', 'Accessories', 'Fragrances', 'Sports', 'Home & Kitchen', 'Books'];
const SUPPLIERS = ['TechSource Distributors', 'Summit Apparel Co.', 'Premier Brands', 'Global Goods Ltd.', 'Scholastic Inc.'];
const LOCATIONS = [
  { name: 'Main Distribution Center', type: 'warehouse' },
  { name: 'Receiving Dock', type: 'room' },
  { name: 'Aisle A — Shelf 1', type: 'shelf' },
  { name: 'Aisle B — Shelf 2', type: 'shelf' },
  { name: 'Returns Bin', type: 'bin' },
];
const CHARTERS = ['North Campus', 'South Campus'];

// [name, category, supplier, kind(p/b), qty, reorder, cost, price, bin, imageUrl]
const ITEMS = [
  // Electronics
  ['MacBook Pro 14"', 'Electronics', 'TechSource Distributors', 'p', 34, 10, 1600, 1999, 'D1', DJ + 'laptops/apple-macbook-pro-14-inch-space-grey/1.webp'],
  ['Dell XPS 13 Laptop', 'Electronics', 'TechSource Distributors', 'p', 0, 8, 900, 1299, 'D2', DJ + 'laptops/new-dell-xps-13-9300-laptop/1.webp'],
  ['iPad Mini', 'Electronics', 'TechSource Distributors', 'p', 56, 15, 400, 499, 'D3', DJ + 'tablets/ipad-mini-2021-starlight/1.webp'],
  ['Apple AirPods', 'Electronics', 'TechSource Distributors', 'p', 120, 25, 110, 169, 'D4', DJ + 'mobile-accessories/apple-airpods/1.webp'],
  ['AirPods Max Headphones', 'Electronics', 'TechSource Distributors', 'p', 9, 12, 400, 549, 'D5', DJ + 'mobile-accessories/apple-airpods-max-silver/1.webp'],
  ['USB-C Wall Charger', 'Electronics', 'TechSource Distributors', 'p', 240, 40, 12, 29, 'D6', DJ + 'mobile-accessories/apple-iphone-charger/1.webp'],
  ['Smart Speaker', 'Electronics', 'TechSource Distributors', 'p', 70, 20, 60, 99, 'D7', DJ + 'mobile-accessories/amazon-echo-plus/1.webp'],
  // Apparel
  ["Men's Check Shirt", 'Apparel', 'Summit Apparel Co.', 'p', 180, 30, 14, 39, 'A1', DJ + 'mens-shirts/men-check-shirt/1.webp'],
  ['Plaid Flannel Shirt', 'Apparel', 'Summit Apparel Co.', 'p', 12, 25, 16, 44, 'A2', DJ + 'mens-shirts/man-plaid-shirt/1.webp'],
  ['Short-Sleeve Shirt', 'Apparel', 'Summit Apparel Co.', 'p', 95, 20, 10, 29, 'A3', DJ + 'mens-shirts/man-short-sleeve-shirt/1.webp'],
  ['Graphic Tee', 'Apparel', 'Summit Apparel Co.', 'p', 320, 50, 6, 19, 'A4', DJ + 'mens-shirts/gigabyte-aorus-men-tshirt/1.webp'],
  ['Summer Dress', 'Apparel', 'Summit Apparel Co.', 'p', 64, 15, 18, 49, 'A5', DJ + 'tops/girl-summer-dress/1.webp'],
  ['Gray Knit Dress', 'Apparel', 'Summit Apparel Co.', 'p', 41, 12, 22, 59, 'A6', DJ + 'tops/gray-dress/1.webp'],
  ['Air Jordan 1 Sneakers', 'Apparel', 'Summit Apparel Co.', 'p', 28, 10, 90, 179, 'A7', DJ + 'mens-shoes/nike-air-jordan-1-red-and-black/1.webp'],
  ['Puma Trainers', 'Apparel', 'Summit Apparel Co.', 'p', 0, 12, 45, 89, 'A8', DJ + 'mens-shoes/puma-future-rider-trainers/1.webp'],
  // Accessories
  ['Classic Sunglasses', 'Accessories', 'Premier Brands', 'p', 150, 30, 8, 24, 'E1', DJ + 'sunglasses/classic-sun-glasses/1.webp'],
  ['Black Sunglasses', 'Accessories', 'Premier Brands', 'p', 88, 20, 7, 19, 'E2', DJ + 'sunglasses/black-sun-glasses/1.webp'],
  ['Leather Strap Watch', 'Accessories', 'Premier Brands', 'p', 47, 12, 50, 129, 'E3', DJ + 'mens-watches/brown-leather-belt-watch/1.webp'],
  ['Submariner Dive Watch', 'Accessories', 'Premier Brands', 'p', 6, 8, 800, 1499, 'E4', DJ + 'mens-watches/rolex-submariner-watch/1.webp'],
  ['Leather Backpack', 'Accessories', 'Premier Brands', 'p', 76, 20, 30, 79, 'E5', DJ + 'womens-bags/white-faux-leather-backpack/1.webp'],
  ['Black Handbag', 'Accessories', 'Premier Brands', 'p', 52, 15, 40, 99, 'E6', DJ + 'womens-bags/women-handbag-black/1.webp'],
  // Fragrances
  ['CK One Cologne', 'Fragrances', 'Premier Brands', 'p', 200, 40, 30, 69, 'G1', DJ + 'fragrances/calvin-klein-ck-one/1.webp'],
  ['Gucci Bloom Perfume', 'Fragrances', 'Premier Brands', 'p', 18, 20, 70, 149, 'G2', DJ + 'fragrances/gucci-bloom-eau-de/1.webp'],
  // Sports
  ['Basketball', 'Sports', 'Global Goods Ltd.', 'p', 130, 30, 12, 29, 'S1', DJ + 'sports-accessories/basketball/1.webp'],
  ['American Football', 'Sports', 'Global Goods Ltd.', 'p', 90, 25, 14, 34, 'S2', DJ + 'sports-accessories/american-football/1.webp'],
  ['Baseball Glove', 'Sports', 'Global Goods Ltd.', 'p', 0, 10, 25, 59, 'S3', DJ + 'sports-accessories/baseball-glove/1.webp'],
  // Home & Kitchen
  ['Countertop Blender', 'Home & Kitchen', 'Global Goods Ltd.', 'p', 44, 12, 35, 89, 'K1', DJ + 'kitchen-accessories/boxed-blender/1.webp'],
  ['Bamboo Chopping Board', 'Home & Kitchen', 'Global Goods Ltd.', 'p', 160, 30, 8, 19, 'K2', DJ + 'kitchen-accessories/chopping-board/1.webp'],
  // Books (item_type=book → Books tab) — clean title-rendered minimalist covers
  // (OpenLibrary/Google covers proved unreliable: broken 302s / missing imageLinks).
  ['To Kill a Mockingbird', 'Books', 'Scholastic Inc.', 'b', 120, 30, 12, 0, 'F1', bookCover('To Kill a Mockingbird', '1f2a44', 'e8e2d0')],
  ['The Great Gatsby', 'Books', 'Scholastic Inc.', 'b', 60, 20, 11, 0, 'F2', bookCover('The Great Gatsby', '24222c', 'd4af37')],
  ['Pride and Prejudice', 'Books', 'Scholastic Inc.', 'b', 0, 15, 10, 0, 'F3', bookCover('Pride and Prejudice', '4a2c3a', 'f0e6d2')],
  ['The Catcher in the Rye', 'Books', 'Scholastic Inc.', 'b', 18, 20, 13, 0, 'F4', bookCover('The Catcher in the Rye', '8a2b2b', 'f0e6d2')],
  ['Lord of the Flies', 'Books', 'Scholastic Inc.', 'b', 210, 40, 9, 0, 'F5', bookCover('Lord of the Flies', '1e3a2f', 'e8e2d0')],
];

const PURCHASE_ORDERS = [
  { po: 'PO-DEMO-001', supplier: 'Premier Brands', status: 'draft', lines: ['Classic Sunglasses', 'Leather Strap Watch', 'CK One Cologne'] },
  { po: 'PO-DEMO-002', supplier: 'TechSource Distributors', status: 'ordered', lines: ['MacBook Pro 14"', 'Apple AirPods', 'USB-C Wall Charger'] },
  { po: 'PO-DEMO-003', supplier: 'Summit Apparel Co.', status: 'received', lines: ["Men's Check Shirt", 'Graphic Tee', 'Air Jordan 1 Sneakers'] },
];

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const { data: probe, error: probeErr } = await admin.from('organizations').select('id').limit(1);
  if (probeErr) die(`probe failed: ${probeErr.message}`);
  if (!probe || probe.length === 0) die('key does not bypass RLS — not a service-role key. Aborting.');

  log(`\n▶ Seeding demo org "${DEMO.name}" (slug ${DEMO.slug}) on PROD …`);

  let org = await findOne('organizations', { slug: DEMO.slug });
  if (!org) {
    const { data, error } = await admin.from('organizations').insert(DEMO).select('id').single();
    if (error) die(`create org: ${error.message}`);
    org = data;
    log('  ✓ created org (+ 25 modules via trigger)');
  } else {
    log('  • org exists — refreshing');
  }
  const orgId = org.id;
  if (orgId === REAL_ORG_ID) die('refusing to operate on the real org');

  await findOrCreate('organization_members', { organization_id: orgId, user_id: OWNER_USER_ID }, {
    role: 'owner', invited_at: new Date().toISOString(), accepted_at: new Date().toISOString(),
  });
  log('  ✓ owner membership');

  if (RESET) {
    log('  ⟲ --reset: wiping demo catalog (this org only) …');
    const { data: items } = await admin.from('inventory_items').select('id').eq('organization_id', orgId);
    for (const it of items ?? []) {
      const { data: list } = await admin.storage.from(BUCKET).list(`${orgId}/${it.id}`);
      if (list?.length) await admin.storage.from(BUCKET).remove(list.map((f) => `${orgId}/${it.id}/${f.name}`));
    }
    await admin.from('purchase_order_items').delete().eq('organization_id', orgId);
    await admin.from('purchase_orders').delete().eq('organization_id', orgId);
    await admin.from('item_images').delete().eq('organization_id', orgId);
    await admin.from('inventory_items').delete().eq('organization_id', orgId);
    // Clear now-unreferenced categories + suppliers so the lists match the catalog.
    await admin.from('categories').delete().eq('organization_id', orgId);
    await admin.from('suppliers').delete().eq('organization_id', orgId);
    log('  ✓ wiped');
  }

  const catId = {};
  for (const name of CATEGORIES) catId[name] = await findOrCreate('categories', { organization_id: orgId, name }, {});
  const supId = {};
  for (const name of SUPPLIERS) supId[name] = await findOrCreate('suppliers', { organization_id: orgId, name }, {});
  const locIds = [];
  for (const l of LOCATIONS) locIds.push(await findOrCreate('locations', { organization_id: orgId, name: l.name }, { type: l.type }));
  for (const name of CHARTERS) await findOrCreate('charters', { organization_id: orgId, name }, { status: 'active' });
  await findOrCreate('warehouses', { organization_id: orgId, code: 'DEMO' }, { name: 'Demo Distribution Center' });
  log(`  ✓ ${CATEGORIES.length} categories, ${SUPPLIERS.length} suppliers, ${LOCATIONS.length} locations, ${CHARTERS.length} charters, 1 warehouse`);

  let photoCount = 0;
  const itemIdByName = {};
  for (let i = 0; i < ITEMS.length; i++) {
    const [name, cat, sup, kind, qty, reorder, cost, price, bin, img] = ITEMS[i];
    const sku = `DEMO-${String(i + 1).padStart(3, '0')}`;
    const row = {
      organization_id: orgId, sku, name,
      barcode: kind === 'b' ? `978${String(1000000000 + i).slice(-10)}` : null,
      category_id: catId[cat], supplier_id: supId[sup], primary_location_id: locIds[i % locIds.length],
      item_type: kind === 'b' ? 'book' : 'product',
      quantity_on_hand: qty, reorder_point: reorder, reorder_quantity: Math.max(reorder * 2, 50),
      unit_cost: cost, retail_price: price, unit_of_measure: 'unit', bin_location: bin, status: 'active',
      created_by: OWNER_USER_ID, updated_by: OWNER_USER_ID,
    };
    const existing = await findOne('inventory_items', { organization_id: orgId, sku });
    let itemId;
    if (existing) { await admin.from('inventory_items').update(row).eq('id', existing.id); itemId = existing.id; }
    else {
      const { data, error } = await admin.from('inventory_items').insert(row).select('id').single();
      if (error) die(`insert item ${sku}: ${error.message}`);
      itemId = data.id;
    }
    itemIdByName[name] = itemId;

    const hasImg = await findOne('item_images', { item_id: itemId });
    if (!hasImg) {
      const path = await uploadPhoto(orgId, itemId, [img, `https://picsum.photos/seed/${sku}/600/600`]);
      if (path) {
        await admin.from('item_images').insert({ organization_id: orgId, item_id: itemId, storage_path: path, is_primary: true, sort_order: 0 });
        photoCount++; process.stdout.write('.');
      } else process.stdout.write('x');
    }
  }
  log(`\n  ✓ ${ITEMS.length} items (${photoCount} new photos uploaded)`);

  for (const po of PURCHASE_ORDERS) {
    const existing = await findOne('purchase_orders', { organization_id: orgId, po_number: po.po });
    const poRow = {
      organization_id: orgId, po_number: po.po, supplier_id: supId[po.supplier], destination_location_id: locIds[0],
      status: po.status,
      ordered_at: po.status !== 'draft' ? new Date(Date.now() - 6 * 864e5).toISOString() : null,
      received_at: po.status === 'received' ? new Date(Date.now() - 1 * 864e5).toISOString() : null,
      created_by: OWNER_USER_ID, updated_by: OWNER_USER_ID,
    };
    let poId;
    if (existing) { await admin.from('purchase_orders').update(poRow).eq('id', existing.id); poId = existing.id; await admin.from('purchase_order_items').delete().eq('purchase_order_id', poId); }
    else {
      const { data, error } = await admin.from('purchase_orders').insert(poRow).select('id').single();
      if (error) die(`insert PO ${po.po}: ${error.message}`); poId = data.id;
    }
    let subtotal = 0;
    for (const lineName of po.lines) {
      const meta = ITEMS.find((r) => r[0] === lineName);
      const unitCost = meta[6]; const qtyOrdered = 50; subtotal += qtyOrdered * unitCost;
      const { error } = await admin.from('purchase_order_items').insert({
        organization_id: orgId, purchase_order_id: poId, item_id: itemIdByName[lineName],
        quantity_ordered: qtyOrdered, quantity_received: po.status === 'received' ? qtyOrdered : 0, unit_cost: unitCost,
      });
      if (error) die(`insert PO line: ${error.message}`);
    }
    await admin.from('purchase_orders').update({ subtotal, total: subtotal }).eq('id', poId);
  }
  log(`  ✓ ${PURCHASE_ORDERS.length} purchase orders`);

  log(`\n✓ Demo org ready.`);
  log(`  org id: ${orgId}`);
  log(`  On the phone: open the drawer → workspace switcher → "${DEMO.name}", then screenshot.`);
  log(`  Re-run anytime; pass --reset to wipe + reseed this org's data.\n`);
}

main().catch((e) => die(e?.stack || String(e)));
