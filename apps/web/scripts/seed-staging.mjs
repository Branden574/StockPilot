#!/usr/bin/env node
/**
 * Seed a STAGING Supabase project with a throwaway org + admin user + inventory
 * items + an open purchase order, for the authenticated k6 load test
 * (see load-tests/README.md). Prints a ready-to-source `.env.local.loadtest`
 * block with TEST_EMAIL/TEST_PASSWORD, ITEM_IDS, PO_ID, PO_LINE_ITEM_ID, etc.
 *
 * NEVER run this against production — it creates data. The script refuses to
 * run against the known prod project ref and requires an explicit
 * `--confirm-staging` flag.
 *
 * Lives under apps/web/scripts/ so Node resolves @supabase/supabase-js from
 * apps/web/node_modules. Run from anywhere:
 *   node apps/web/scripts/seed-staging.mjs --confirm-staging
 *
 * Reads (process.env wins, then load-tests/.env.local.loadtest, then apps/web/.env.local):
 *   NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL)            — the STAGING project URL
 *   SUPABASE_SERVICE_ROLE_KEY                             — staging service-role key (bypasses RLS)
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY (or SUPABASE_ANON_KEY)  — staging anon key (to mint a JWT)
 */

import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// StockPilot PRODUCTION project ref — the script hard-refuses to touch it.
const PROD_PROJECT_REF = 'xizpqmhhslgzbuqtjubv';

function loadEnv() {
  const out = { ...process.env };
  const files = [
    resolve(__dirname, '..', '..', '..', 'load-tests', '.env.local.loadtest'),
    resolve(__dirname, '..', '.env.local'),
  ];
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i === -1) continue;
      const key = line.slice(0, i).trim();
      let val = line.slice(i + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) out[key] = val; // real process.env always wins
    }
  }
  return out;
}

function die(message, err) {
  console.error(`\n✗ ${message}${err ? `: ${err.message ?? err}` : ''}`);
  process.exit(1);
}

const env = loadEnv();
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  die('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (set them in load-tests/.env.local.loadtest or the environment)');
}
if (SUPABASE_URL.includes(PROD_PROJECT_REF)) {
  die(`REFUSING: ${SUPABASE_URL} is the PRODUCTION project. This script creates data — point it at a STAGING project only.`);
}
if (!process.argv.includes('--confirm-staging')) {
  die(
    `This creates a throwaway org + user + items + PO in:\n    ${SUPABASE_URL}\n` +
      `  Re-run with --confirm-staging once you've confirmed this is a STAGING project (not prod).`,
  );
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// Unique-per-run suffix so the script is re-runnable without collisions.
const stamp = Date.now().toString(36);
const slug = `loadtest-${stamp}`;
const email = `loadtest+${stamp}@stockpilot.dev`;
// Strong password that satisfies the project's policy (8+, mixed case + digit):
// the 'Lt9' prefix guarantees upper+lower+digit; base64url adds entropy.
const password = `Lt9${randomBytes(15).toString('base64url')}`;
const nowIso = new Date().toISOString();

// 1) Organization (Pro plan so all features are available to the load test).
const { data: org, error: orgErr } = await admin
  .from('organizations')
  .insert({ name: 'Load Test Org', slug, plan: 'pro', currency: 'USD', timezone: 'UTC' })
  .select('id')
  .single();
if (orgErr) die('create organization', orgErr);
const orgId = org.id;

// 2) Confirmed auth user + profile row.
const { data: createdUser, error: userErr } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  user_metadata: { full_name: 'Load Test Admin' },
});
if (userErr || !createdUser?.user) die('create auth user', userErr);
const userId = createdUser.user.id;
const { error: profErr } = await admin
  .from('user_profiles')
  .upsert({ id: userId, email, full_name: 'Load Test Admin' }, { onConflict: 'id' });
if (profErr) die('upsert user_profile', profErr);

// 3) Org membership as admin (admins get implicit full-warehouse access — no
//    charter/warehouse assignment rows needed).
const { error: memErr } = await admin.from('organization_members').insert({
  organization_id: orgId,
  user_id: userId,
  role: 'admin',
  accepted_at: nowIso,
});
if (memErr) die('create organization_member', memErr);

// 4) Warehouse (inventory_items.warehouse_id -> warehouses.id).
const { data: warehouse, error: whErr } = await admin
  .from('warehouses')
  .insert({ organization_id: orgId, name: 'Main Warehouse', code: 'MAIN', status: 'active' })
  .select('id')
  .single();
if (whErr) die('create warehouse', whErr);
const warehouseId = warehouse.id;

// 5) A few inventory items (charter_id null = generic stock, usable by all).
const itemRows = [1, 2, 3].map((n) => ({
  organization_id: orgId,
  warehouse_id: warehouseId,
  sku: `LOAD-TEST-${String(n).padStart(3, '0')}`,
  name: `Load Test Item ${n}`,
  item_type: 'product',
  status: 'active',
  quantity_on_hand: 100,
  unit_cost: 5,
  retail_price: 10,
  reorder_point: 10,
  reorder_quantity: 50,
  unit_of_measure: 'unit',
}));
const { data: items, error: itemErr } = await admin
  .from('inventory_items')
  .insert(itemRows)
  .select('id');
if (itemErr) die('create inventory_items', itemErr);
const itemIds = items.map((i) => i.id);

// 6) One OPEN purchase order ('ordered' so the receive-line write scenario works)
//    with a line item per inventory item. line_total is a generated column — never set it.
const { data: po, error: poErr } = await admin
  .from('purchase_orders')
  .insert({
    organization_id: orgId,
    po_number: `PO-LOADTEST-${stamp}`,
    status: 'ordered',
    subtotal: 750,
    tax: 0,
    shipping: 0,
    total: 750,
    ordered_at: nowIso,
  })
  .select('id')
  .single();
if (poErr) die('create purchase_order', poErr);
const poId = po.id;
const { data: lines, error: lineErr } = await admin
  .from('purchase_order_items')
  .insert(
    itemIds.map((itemId) => ({
      organization_id: orgId,
      purchase_order_id: poId,
      item_id: itemId,
      quantity_ordered: 50,
      quantity_received: 0,
      unit_cost: 5,
    })),
  )
  .select('id');
if (lineErr) die('create purchase_order_items', lineErr);
const poLineItemId = lines[0].id;

// 7) Mint a JWT by signing in (best-effort; the env block falls back to a note).
let accessToken = '';
if (ANON_KEY) {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
      body: JSON.stringify({ email, password }),
    });
    if (res.ok) {
      const json = await res.json();
      accessToken = json.access_token || '';
    }
  } catch {
    /* non-fatal — operator can sign in manually */
  }
}

// 8) Print a ready-to-source env block.
console.log(`
✓ Seeded staging org "${slug}" (${orgId})
  user:      ${email}
  warehouse: ${warehouseId}
  items:     ${itemIds.length}
  PO:        ${poId} (status=ordered)

# ---- paste into load-tests/.env.local.loadtest ----
export BASE_URL='https://<your-staging-vercel-preview>.vercel.app'
export SUPABASE_URL='${SUPABASE_URL}'
export SUPABASE_ANON_KEY='${ANON_KEY || '<staging-anon-key>'}'
export TEST_EMAIL='${email}'
export TEST_PASSWORD='${password}'
export SUPABASE_ACCESS_TOKEN='${accessToken || '<sign in to obtain; JWTs expire ~1h>'}'
export ITEM_IDS='${itemIds.join(',')}'
export PO_ID='${poId}'
export PO_LINE_ITEM_ID='${poLineItemId}'
export ENABLE_WRITES=1
# SUPABASE_AUTH_COOKIE (SSR scenarios 03/05/07) must be copied from a browser
# session against BASE_URL — see load-tests/README.md.
`);
