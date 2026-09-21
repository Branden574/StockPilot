#!/usr/bin/env node
/**
 * Seed (or finish seeding) the Perf Lab organization: slug `stockpilot-perf-lab`,
 * 443 synthetic items with photos shaped like the customer's MEASURED
 * distribution, ~60 order requests, and one account per role.
 *
 * IDEMPOTENT AND RESUMABLE. Every step is "find, then create only what is
 * missing": the organization by slug, accounts by email, warehouses by code,
 * items by SKU (PERF-0001...), a photo by "this item has an item_images row",
 * orders by order number. Run it again after a crash, a Ctrl-C or a network
 * drop and it picks up where it stopped; run it on a finished organization and
 * it changes nothing (the summary prints all zeros).
 *
 * IT NEVER UPDATES AN EXISTING ITEM OR ORDER. Both tables have UPDATE triggers
 * that write notifications (low-stock on `UPDATE OF quantity_on_hand`, status
 * pings on order status changes) and the low-stock one ignores preferences.
 * INSERT is the only statement whose side effects were audited; see README.
 *
 * IT NEVER ADOPTS AN ORGANIZATION ON THE STRENGTH OF ITS SLUG. A person can create
 * an organization whose name slugifies to `stockpilot-perf-lab` through the
 * product. An existing row is written into only when it carries the exact name
 * and the provenance marker this script stamps at creation, every member is one
 * of the six Perf Lab accounts, and (on production) the run is pinned with
 * --org-id. All of that is checked before the first write, and in a dry run.
 *
 * Safety rails live in lib.mjs. Usage:
 *   node apps/web/scripts/perf-lab/seed.mjs --target=local --dry-run
 *   node apps/web/scripts/perf-lab/seed.mjs --target=local
 *   node apps/web/scripts/perf-lab/seed.mjs --target=local --fingerprint   (no network; hashes the 443 masters)
 * Production: see README.md, "Production operating procedure".
 */
import { createHash } from 'node:crypto';

import { buildPlan, ENABLED_MODULE_IDS, MODULES, planSummary } from './dataset.mjs';
import { BYTE_TOLERANCE, encoderVersions, generatePhoto } from './images.mjs';
import {
  ACCOUNT_STAMP,
  accountTiesElsewhere,
  assertBypassesRls,
  assertLive,
  assertPerfLabOrgIsOurs,
  createAdminClient,
  die,
  exactCount,
  fetchAll,
  findPerfLabOrg,
  findPerfLabProfiles,
  isPerfLabAccountEmail,
  ITEM_IMAGES_BUCKET,
  log,
  must,
  noteWritesBegun,
  ORG_COLUMNS,
  orgScope,
  parseArgs,
  PERF_LAB_BILLING_NOTE,
  PERF_LAB_NAME,
  PERF_LAB_SLUG,
  productionCountdown,
  progressPrinter,
  readAuthAccount,
  readServiceKey,
  reassertPerfLabOrg,
  refuse,
  refuseEarly,
  resolveTarget,
  runPool,
  throwawayPassword,
} from './lib.mjs';

const USAGE = `
Perf Lab seed. Creates or completes the organization "${PERF_LAB_SLUG}".

  --target=local|production         required; there is no default
  --dry-run                         print what would be created (counts only); write nothing
  --concurrency=N                   photo uploads in flight, 1-8 (default 4)
  --skip-orders                     do not seed order requests
  --org-id=<uuid>                   pin the Perf Lab organization's id (refuses on mismatch).
                                    REQUIRED on production once the organization exists.
  --fingerprint                     generate all 443 masters, print one hash, touch no network
  --expect-fingerprint=<hash>       with --fingerprint: exit 1 unless the hash matches
  --i-am-authorized-by-the-owner    required for production, with PERF_LAB_CONFIRM=${PERF_LAB_SLUG}

Environment: SUPABASE_SERVICE_ROLE_KEY (required), SUPABASE_URL (local only; default http://127.0.0.1:54321).
`;

const ok = (error, what) => {
  if (error) die(`${what}: ${error.message ?? error.code ?? 'unknown error'}`);
};
/** The row a `.single()` promised. No error AND no row is an answer that never arrived, not an empty one. */
const row = ({ data, error }, what) => {
  ok(error, what);
  if (!data || typeof data !== 'object') die(`${what}: the server answered without a row.`);
  return data;
};

// ── --fingerprint: what THIS machine generates, as one hash, without a database ─
// The plan (which item gets which format, size, cache group) is identical
// everywhere. The BYTES are identical only on the same sharp/libvips build with
// the same installed fonts, because librsvg draws the label text with system
// fonts. This is how that condition is checked instead of assumed: record the
// hash when the dataset is first seeded, and compare it before seeding again.
async function fingerprint(plan, concurrency, expected) {
  log(
    `Generating ${plan.items.length} masters to fingerprint dataset ${plan.version} (no network, nothing stored)...`,
  );
  const hashes = new Array(plan.items.length);
  let bytes = 0;
  await runPool(
    plan.items,
    concurrency,
    async (item, i) => {
      const photo = await generatePhoto(item);
      hashes[i] =
        `${photo.sha256}:${photo.thumb ? createHash('sha256').update(photo.thumb).digest('hex') : '-'}:${photo.lqip ? createHash('sha256').update(photo.lqip).digest('hex') : '-'}`;
      bytes += photo.master.length + (photo.thumb?.length ?? 0);
    },
    progressPrinter('generated', 50),
  );
  log(`\ndataset      ${plan.version}`);
  log(`encoder      ${encoderVersions()}`);
  log(
    `files        ${plan.items.length} masters + thumbnails + LQIPs, ${(bytes / 1048576).toFixed(1)} MiB`,
  );
  const value = createHash('sha256').update(hashes.join('\n')).digest('hex');
  log(`fingerprint  ${value}`);
  if (expected !== undefined) {
    if (value === expected.toLowerCase()) {
      log('matches the expected fingerprint: this machine generates the same bytes.');
    } else {
      die(
        'the fingerprint does NOT match the expected value. This machine (sharp build or fonts) ' +
          'generates different bytes from the machine that produced that value. Runs measured against ' +
          'the two datasets are not like for like; see README, "Same dataset, same bytes".',
      );
    }
  }
}

// ── Reading what already exists ─────────────────────────────────────────────
async function readState(admin, scope) {
  const state = {
    modules: new Map(),
    members: new Map(),
    warehouses: new Map(),
    locations: [],
    categories: new Map(),
    suppliers: new Map(),
    items: new Map(),
    itemsWithPhoto: new Set(),
    orders: new Map(),
    assignments: [],
  };
  if (!scope) return state;

  const one = async (table, columns) => {
    const rows = await fetchAll(() =>
      scope.select(table, columns).order(columns.split(',')[0].trim()),
    );
    return rows;
  };
  for (const r of await one('organization_modules', 'module_id, enabled, tier'))
    state.modules.set(r.module_id, r);
  for (const r of await one('organization_members', 'user_id, role, accepted_at, all_warehouses'))
    state.members.set(r.user_id, r);
  for (const r of await one('warehouses', 'id, code, name')) state.warehouses.set(r.code, r);
  state.locations = (
    await one('locations', 'id, name, kind, type, warehouse_id, deleted_at')
  ).filter((l) => !l.deleted_at);
  for (const r of await one('categories', 'id, name, deleted_at'))
    if (!r.deleted_at) state.categories.set(r.name, r);
  for (const r of await one('suppliers', 'id, name, deleted_at'))
    if (!r.deleted_at) state.suppliers.set(r.name, r);
  for (const r of await one('inventory_items', 'id, sku, deleted_at'))
    if (!r.deleted_at) state.items.set(r.sku, r);
  // `id` first: one() orders by the first column, and item_id is unique only by
  // convention. Paging on a key that can repeat can skip or repeat a row.
  for (const r of await one('item_images', 'id, item_id')) state.itemsWithPhoto.add(r.item_id);
  for (const r of await one('order_requests', 'id, order_number, lines:order_request_lines(id)'))
    state.orders.set(Number(r.order_number), r);
  state.assignments = await one(
    'user_warehouse_assignments',
    'id, user_id, warehouse_id, charter_id, is_primary',
  );
  return state;
}

/** What a run would create, as counts. The same numbers a dry run prints. */
function pending(plan, state, profiles, skipOrders) {
  const rackCount = plan.warehouses.reduce((s, w) => s + w.racks.length + 1, 0);
  const haveLocation = (w, name) => {
    const wh = state.warehouses.get(w.code);
    return wh && state.locations.some((l) => l.warehouse_id === wh.id && l.name === name);
  };
  const missingLocations = plan.warehouses.reduce(
    (s, w) => s + [w.site, ...w.racks].filter((name) => !haveLocation(w, name)).length,
    0,
  );
  const moduleChanges =
    MODULES.filter(([id, , on]) => state.modules.get(id)?.enabled !== on).length +
    [...state.modules.values()].filter(
      (m) => m.enabled && !MODULES.some(([id]) => id === m.module_id),
    ).length;
  const missingItems = plan.items.filter((it) => !state.items.has(it.sku));
  const missingPhotos = plan.items.filter((it) => {
    const row = state.items.get(it.sku);
    return !row || !state.itemsWithPhoto.has(row.id);
  });
  const missingOrders = skipOrders
    ? []
    : plan.orders.filter((o) => !state.orders.has(o.orderNumber));
  const ordersNeedingLines = skipOrders
    ? []
    : plan.orders.filter(
        (o) =>
          state.orders.has(o.orderNumber) &&
          (state.orders.get(o.orderNumber).lines ?? []).length === 0,
      );
  return {
    accounts: plan.accounts.filter((a) => !profiles.has(a.key)).length,
    memberships: plan.accounts.filter(
      (a) => !profiles.has(a.key) || !state.members.has(profiles.get(a.key).id),
    ).length,
    moduleChanges,
    warehouses: plan.warehouses.filter((w) => !state.warehouses.has(w.code)).length,
    locations: missingLocations,
    locationsPlanned: rackCount,
    categories: plan.categories.filter((c) => !state.categories.has(c.name)).length,
    suppliers: plan.suppliers.filter((s) => !state.suppliers.has(s)).length,
    items: missingItems.length,
    photos: missingPhotos.length,
    masterBytes: missingPhotos.reduce((s, it) => s + it.photo.targetBytes, 0),
    thumbs: missingPhotos.filter((it) => it.photo.hasThumb).length,
    orders: missingOrders.length,
    orderLines: [...missingOrders, ...ordersNeedingLines].reduce((s, o) => s + o.lines.length, 0),
  };
}

function printPending(title, p, orgExists) {
  log(`\n${title}`);
  log(`  organization        ${orgExists ? 0 : 1}`);
  log(
    `  module rows changed ${orgExists ? p.moduleChanges : `${MODULES.length} pinned (${ENABLED_MODULE_IDS.length} on)`}`,
  );
  log(`  auth accounts       ${p.accounts}`);
  log(`  memberships         ${p.memberships}`);
  log(`  warehouses          ${p.warehouses}`);
  log(
    `  locations           ${p.locations}   (plus Staging + Unplaced per new warehouse, made by a trigger)`,
  );
  log(`  categories          ${p.categories}`);
  log(`  suppliers           ${p.suppliers}`);
  log(`  items               ${p.items}`);
  log(`  photos (masters)    ${p.photos}   about ${(p.masterBytes / 1048576).toFixed(0)} MiB`);
  log(`  thumbnails          ${p.thumbs}`);
  log(`  order requests      ${p.orders}   (${p.orderLines} lines)`);
}

// ── Steps ───────────────────────────────────────────────────────────────────
async function ensureOrg(admin, dryRun) {
  // Explicit columns, no spread of anything external:
  //   plan 'free'        the default tier. Keeps the plan-gated automation
  //                      (auto-reorder, recurring POs, restore points) off, and
  //                      its limits (10k items, 100 members) are far above this.
  //   mfa_policy optional  the column default is 'admins_required', which puts
  //                      a "set up MFA" banner above every page for owner and
  //                      admin. These accounts have no MFA by design (sign-in is
  //                      an admin-minted magic link), and a banner that only two
  //                      of six roles see is a layout confounder in a role matrix.
  //   all_modules_comp   left false: see dataset.mjs MODULES.
  //   billing_notes      the provenance marker (lib.mjs PERF_LAB_MARKER), in the
  //                      SAME statement that creates the row, so there is no
  //                      moment at which our organization exists without it. No
  //                      tenant can write this column (0218), so a row that has
  //                      it was made here or vouched for in the platform console.
  assertLive(dryRun, 'insert into organizations');
  const created = await admin
    .from('organizations')
    .insert({
      name: PERF_LAB_NAME,
      slug: PERF_LAB_SLUG,
      plan: 'free',
      timezone: 'America/Los_Angeles',
      currency: 'USD',
      domain_pack: 'charter_school',
      mfa_policy: 'optional',
      all_modules_comp: false,
      billing_notes: PERF_LAB_BILLING_NOTE,
    })
    .select(ORG_COLUMNS)
    .single();
  const org = row(created, 'create organization');
  // From here on a failed rail is not a refusal any more (lib.mjs refuse()).
  noteWritesBegun('the seed had already created the organization');
  return org;
}

/**
 * Pins EVERY module row to the explicit state in dataset.mjs, immediately after
 * the organization exists. seed_org_modules() has just switched 26 modules on,
 * `ai` among them; this is the step that stops a seeded organization from
 * starting automation. Rows the plan does not know (a module added by a future
 * migration) are switched off too, so "on" always equals "measured".
 */
async function ensureModules(scope, state) {
  let changed = 0;
  for (const [moduleId, tier, enabled] of MODULES) {
    const row = state.modules.get(moduleId);
    if (!row) {
      const { error } = await scope.insert('organization_modules', {
        organization_id: scope.orgId,
        module_id: moduleId,
        tier,
        enabled,
      });
      ok(error, `module ${moduleId}`);
      changed++;
    } else if (row.enabled !== enabled) {
      const { error } = await scope
        .update('organization_modules', { enabled })
        .eq('module_id', moduleId);
      ok(error, `module ${moduleId}`);
      changed++;
    }
  }
  // Only ids the plan does NOT list. Known ids were settled by the loop above;
  // matching them again here wrote each one twice and doubled the reported count.
  const known = new Set(MODULES.map(([id]) => id));
  for (const row of state.modules.values()) {
    if (row.enabled && !known.has(row.module_id)) {
      const { error } = await scope
        .update('organization_modules', { enabled: false })
        .eq('module_id', row.module_id);
      ok(error, `module ${row.module_id}`);
      changed++;
    }
  }
  return changed;
}

/**
 * Switches off every notification and email preference THAT EXISTS for one
 * account. The column list is discovered from the row itself rather than
 * written down here: a preference added by a later migration defaults to TRUE,
 * and a hard-coded list would silently leave it on.
 */
async function muteAccount(admin, userId, dryRun) {
  const existing = await admin
    .from('notification_preferences')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  ok(existing.error, 'read notification preferences');
  let prefs = existing.data;
  if (!prefs) {
    assertLive(dryRun, 'insert into notification_preferences');
    prefs = row(
      await admin.from('notification_preferences').insert({ user_id: userId }).select('*').single(),
      'create notification preferences',
    );
  }
  const patch = {};
  for (const [column, value] of Object.entries(prefs)) if (value === true) patch[column] = false;
  if (Object.keys(patch).length === 0) return 0;
  assertLive(dryRun, 'update notification_preferences');
  const { error } = await admin
    .from('notification_preferences')
    .update(patch)
    .eq('user_id', userId);
  ok(error, 'mute notification preferences');
  return Object.keys(patch).length;
}

async function ensureAccounts(admin, scope, plan, state, profiles) {
  const created = { accounts: 0, memberships: 0, muted: 0 };
  const now = new Date().toISOString();
  for (const account of plan.accounts) {
    let profile = profiles.get(account.key);
    if (!profile) {
      // email_confirm: true => GoTrue sends NOTHING (no confirmation, no invite).
      // The password satisfies the policy and is dropped on the floor: it is
      // not returned, stored or printed, and nobody signs in with it.
      assertLive(scope.dryRun, 'auth.admin.createUser');
      // app_metadata carries the stamp (lib.mjs ACCOUNT_STAMP). A signed-in user
      // cannot write app_metadata, so it marks an account THIS TOOL made: the seed
      // adopts, and teardown deletes, only an account that carries it.
      const { data, error } = await admin.auth.admin.createUser({
        email: account.email,
        password: throwawayPassword(),
        email_confirm: true,
        user_metadata: { full_name: account.fullName },
        app_metadata: { ...ACCOUNT_STAMP },
      });
      ok(error, `create account ${account.key}`);
      if (!data?.user?.id)
        die(`create account ${account.key}: the server answered without a user.`);
      profile = { id: data.user.id, email: account.email };
      profiles.set(account.key, profile);
      created.accounts++;
    } else {
      // Backstop for preflightAccounts(), which already checked this before any
      // write. Reached only if something changed in between. This is MID-RUN: the
      // organization exists by now, so refuse() exits 1 (not 2) and says what is
      // already there; see lib.mjs.
      const ties = await accountTiesElsewhere(admin, profile.id, scope.orgId);
      const auth = await readAuthAccount(admin, profile.id);
      if (ties.any || !auth.stamped || auth.email !== account.email)
        refuse(
          `account ${account.key} changed while the seed was running: it now belongs to something ` +
            'outside the Perf Lab, or is no longer the account this tool created.',
        );
    }

    if (!state.members.has(profile.id)) {
      // Service role => auth.uid() is null => the 0220 owner-row guard lets the
      // first owner through, exactly as org provisioning does.
      const { error } = await scope.insert('organization_members', {
        organization_id: scope.orgId,
        user_id: profile.id,
        role: account.role,
        invited_at: now,
        accepted_at: now,
        all_warehouses: account.allWarehouses,
      });
      ok(error, `membership ${account.key}`);
      created.memberships++;
    }

    // Land in the Perf Lab on sign-in, and restate the digest opt-out. The
    // weekly-digest cron mails ONLY profiles with email_digest_optin = true;
    // false is the default, written anyway so it is a fact and not a default.
    // The digest_section_* flags default to TRUE; they are inert while the
    // opt-in is false, and are switched off so "every preference is off" holds
    // literally. Discovered from the row, like muteAccount(), for the same reason.
    const current = row(
      await admin
        .from('user_profiles')
        .select('*')
        .eq('id', profile.id)
        .eq('email', account.email)
        .single(),
      `read profile ${account.key}`,
    );
    const profilePatch = {};
    if (current.default_organization_id !== scope.orgId)
      profilePatch.default_organization_id = scope.orgId;
    if (current.email_digest_optin !== false) profilePatch.email_digest_optin = false;
    for (const [column, value] of Object.entries(current)) {
      if (column.startsWith('digest_section_') && value === true) profilePatch[column] = false;
    }
    // Only when something differs, so a re-run of a finished seed writes nothing.
    if (Object.keys(profilePatch).length > 0) {
      assertLive(scope.dryRun, 'update user_profiles');
      const { error: profileError } = await admin
        .from('user_profiles')
        .update(profilePatch)
        .eq('id', profile.id)
        .eq('email', account.email);
      ok(profileError, `profile ${account.key}`);
      created.muted += Object.keys(profilePatch).filter(
        (c) => c !== 'default_organization_id',
      ).length;
    }

    created.muted += await muteAccount(admin, profile.id, scope.dryRun);
  }
  return created;
}

async function ensureWarehouses(scope, plan, state, ownerId) {
  let created = 0;
  for (const w of plan.warehouses) {
    if (state.warehouses.has(w.code)) continue;
    // Two triggers fire here, both wanted: 0188 adds the warehouse's Staging and
    // Unplaced locations, 0280 grants it to members flagged all_warehouses.
    const { data, error } = await scope
      .insert('warehouses', {
        organization_id: scope.orgId,
        code: w.code,
        name: w.name,
        status: 'active',
        created_by: ownerId,
      })
      .select('id, code, name')
      .single();
    ok(error, `warehouse ${w.code}`);
    if (!data?.id) die(`warehouse ${w.code}: the server answered without a row.`);
    state.warehouses.set(w.code, data);
    created++;
  }
  return created;
}

/**
 * staff and viewer are warehouse-scoped: what they can see is decided by the
 * EXISTENCE of user_warehouse_assignments rows (RLS, migration 0229) and read
 * the same way by getWarehouseAccess (lib/auth/warehouse.ts). The restricted
 * account gets one row, for one warehouse, and all_warehouses = false.
 */
async function ensureAssignments(scope, plan, state, profiles, ownerId) {
  let created = 0;
  for (const account of plan.accounts) {
    const userId = profiles.get(account.key).id;
    for (const code of account.warehouseCodes) {
      const warehouseId = state.warehouses.get(code).id;
      const primary = code === plan.warehouses[0].code;
      const row = state.assignments.find(
        (a) => a.user_id === userId && a.warehouse_id === warehouseId && a.charter_id === null,
      );
      if (!row) {
        const { error } = await scope.insert('user_warehouse_assignments', {
          organization_id: scope.orgId,
          user_id: userId,
          warehouse_id: warehouseId,
          charter_id: null,
          is_primary: primary,
          assigned_by: ownerId,
        });
        // 23505: the 0280 trigger granted it a moment ago (all_warehouses members).
        if (error && error.code !== '23505') ok(error, `assignment ${account.key}/${code}`);
        if (!error) created++;
      }
      if (!row || row.is_primary !== primary) {
        const { error } = await scope
          .update('user_warehouse_assignments', { is_primary: primary })
          .eq('user_id', userId)
          .eq('warehouse_id', warehouseId);
        ok(error, `assignment primary ${account.key}/${code}`);
      }
    }
  }
  return created;
}

async function ensureLocations(scope, plan, state) {
  let created = 0;
  for (const w of plan.warehouses) {
    const warehouseId = state.warehouses.get(w.code).id;
    const wanted = [
      // kind NULL + a site-ish type IS how a Site is encoded; never give it a kind.
      { name: w.site, type: 'warehouse', kind: null, rack_number: null, rack_row: null },
      // Racks the way planNewLocation() stores them: "10-A" => number 10, row A.
      ...w.racks.map((name) => ({
        name,
        type: 'shelf',
        kind: 'rack',
        rack_number: name.split('-')[0],
        rack_row: name.split('-')[1],
      })),
    ];
    for (const loc of wanted) {
      if (state.locations.some((l) => l.warehouse_id === warehouseId && l.name === loc.name))
        continue;
      const { data, error } = await scope
        .insert('locations', { organization_id: scope.orgId, warehouse_id: warehouseId, ...loc })
        .select('id, name, kind, type, warehouse_id')
        .single();
      ok(error, `location ${loc.name}`);
      state.locations.push(data);
      created++;
    }
  }
  return created;
}

async function ensureNamed(scope, table, wanted, have, toRow) {
  let created = 0;
  for (const entry of wanted) {
    const name = typeof entry === 'string' ? entry : entry.name;
    if (have.has(name)) continue;
    const { data, error } = await scope
      .insert(table, { organization_id: scope.orgId, ...toRow(entry) })
      .select('id, name')
      .single();
    ok(error, `${table} ${name}`);
    have.set(name, data);
    created++;
  }
  return created;
}

async function ensureItems(scope, plan, state, ownerId) {
  const missing = plan.items.filter((it) => !state.items.has(it.sku));
  const rows = missing.map((it) => {
    const warehouseId = state.warehouses.get(it.warehouseCode).id;
    const rack = state.locations.find((l) => l.warehouse_id === warehouseId && l.name === it.rack);
    return {
      organization_id: scope.orgId,
      sku: it.sku,
      name: it.name,
      barcode: it.barcode,
      item_type: it.itemType,
      category_id: state.categories.get(it.category).id,
      supplier_id: state.suppliers.get(it.supplier).id,
      // warehouse_id is REQUIRED for visibility: the 0229 select policy hides
      // every item whose warehouse_id is null from everyone.
      warehouse_id: warehouseId,
      primary_location_id: rack.id,
      bin_location: it.rack,
      quantity_on_hand: it.quantity,
      reorder_point: it.reorderPoint,
      reorder_quantity: it.reorderQuantity,
      unit_cost: it.unitCost,
      retail_price: it.retailPrice,
      unit_of_measure: 'unit',
      status: 'active',
      custom_fields: it.customFields,
      created_by: ownerId,
      updated_by: ownerId,
    };
  });
  // Batches of 50: one statement each, so a crash leaves whole batches behind
  // and the next run's "find by SKU" skips exactly those.
  for (let from = 0; from < rows.length; from += 50) {
    const batch = rows.slice(from, from + 50);
    const { data, error } = await scope.insert('inventory_items', batch).select('id, sku');
    ok(error, 'insert items');
    for (const r of data) state.items.set(r.sku, r);
    log(`  items: ${Math.min(from + 50, rows.length)}/${rows.length}`);
  }
  return rows.length;
}

/**
 * Uploads one object so that the stored Cache-Control matches its group.
 *
 *   max-age=3600 / max-age=604800   supabase-js upload() with `cacheControl`,
 *                                   which sends `cache-control: max-age=<n>`.
 *   no-cache                        what the web uploader really does: a signed
 *                                   upload URL and a raw PUT that carries a
 *                                   content-type and NO cache-control header.
 *                                   The storage API then records `no-cache`,
 *                                   and serves exactly that (verified locally;
 *                                   verify.mjs tallies it).
 * upsert everywhere: the path is deterministic, so re-uploading after a crash
 * overwrites the same object, with the same bytes when the re-run happens on the
 * same sharp build and fonts (see README, "Same dataset, same bytes").
 */
async function putObject(admin, dryRun, path, body, contentType, cacheControl) {
  assertLive(dryRun, 'storage upload');
  const bucket = admin.storage.from(ITEM_IMAGES_BUCKET);
  if (cacheControl === 'no-cache') {
    const signed = await bucket.createSignedUploadUrl(path, { upsert: true });
    if (signed.error) throw new Error(`sign upload: ${signed.error.message}`);
    let res;
    try {
      res = await fetch(signed.data.signedUrl, {
        method: 'PUT',
        headers: { 'content-type': contentType, 'x-upsert': 'true' },
        body,
        redirect: 'error',
      });
    } catch {
      // The URL carries an upload token; never echo it.
      throw new Error('raw PUT failed (network). Details withheld: the URL carries a token.');
    }
    if (!res.ok) throw new Error(`raw PUT answered HTTP ${res.status}`);
    return;
  }
  const seconds = cacheControl.replace('max-age=', '');
  const { error } = await bucket.upload(path, body, {
    contentType,
    cacheControl: seconds,
    upsert: true,
  });
  if (error) throw new Error(`upload: ${error.message}`);
}

async function ensurePhotos(admin, scope, plan, state, concurrency) {
  const todo = plan.items.filter((it) => !state.itemsWithPhoto.has(state.items.get(it.sku).id));
  if (todo.length === 0) return { photos: 0, thumbs: 0, bytes: 0, offTarget: 0 };
  const totals = { photos: 0, thumbs: 0, bytes: 0, offTarget: 0 };
  await runPool(
    todo,
    concurrency,
    async (item) => {
      const itemId = state.items.get(item.sku).id;
      const photo = await generatePhoto(item);
      // The path shapes ItemImagesService.createUploadUrl mints, so
      // isSignableItemImagePath and the 0323 CHECKs accept them.
      const dir = `${scope.orgId}/items/${itemId}`;
      const storagePath = `${dir}/${item.photo.fileUuid}.${item.photo.ext}`;
      const thumbPath = photo.thumb ? `${dir}/${item.photo.fileUuid}-thumb.webp` : null;

      await putObject(
        admin,
        scope.dryRun,
        storagePath,
        photo.master,
        item.photo.contentType,
        item.photo.cacheControl,
      );
      if (photo.thumb)
        // 'image/webp' whatever the bytes are: it is the type the uploader sends for every
        // thumbnail, including the PNG ones WebKit hands it (dataset.mjs, the webkit writer).
        await putObject(
          admin,
          scope.dryRun,
          thumbPath,
          photo.thumb,
          'image/webp',
          item.photo.thumbCacheControl,
        );

      // The row is the commit marker: written last, so "has a row" always means
      // "both objects are up". A crash before this line re-does only this item.
      const { error } = await scope.insert('item_images', {
        organization_id: scope.orgId,
        item_id: itemId,
        storage_path: storagePath,
        thumb_path: thumbPath,
        lqip: photo.lqip,
        alt: item.name,
        is_primary: true,
        sort_order: 0,
      });
      if (error) throw new Error(`item_images: ${error.message}`);
      totals.photos++;
      // The grain search returns the CLOSEST file when a target is out of reach.
      // On the machine this was tuned on that never happens; on one with another
      // sharp build or fonts it could, and it should not happen silently.
      if (photo.miss > BYTE_TOLERANCE) totals.offTarget++;
      totals.bytes += photo.master.length + (photo.thumb?.length ?? 0);
      if (photo.thumb) totals.thumbs++;
    },
    progressPrinter('photos', 20),
  );
  return totals;
}

/**
 * Orders fire ONE database side effect on INSERT: trg_order_requests_notify
 * writes an in-app notification for every owner/admin/manager whose
 * push_order_request_created is not false, and each notification fans out to
 * that person's push tokens. So orders are seeded only when it is PROVEN that
 * this cannot reach anyone: every notify-eligible member is a Perf Lab account,
 * has that preference off, and has no push token. Otherwise this step is
 * skipped, loudly, and everything else is still seeded.
 */
async function ordersAreSilent(admin, scope, profiles) {
  const ours = new Set([...profiles.values()].map((p) => p.id));
  const members = await must(
    scope.select('organization_members', 'user_id, role, accepted_at'),
    'read members',
  );
  const eligible = members.filter(
    (m) => m.accepted_at && ['owner', 'admin', 'manager'].includes(m.role),
  );
  if (eligible.some((m) => !ours.has(m.user_id)))
    return 'a member who is not a Perf Lab account would be notified';
  const ids = eligible.map((m) => m.user_id);
  const prefs = await must(
    admin
      .from('notification_preferences')
      .select('user_id, push_order_request_created')
      .in('user_id', ids),
    'read preferences',
  );
  for (const id of ids) {
    const pref = prefs.find((p) => p.user_id === id);
    if (!pref || pref.push_order_request_created !== false)
      return 'an account still has the new-order notification switched on';
  }
  const tokens = await exactCount(
    admin
      .from('push_tokens')
      .select('id', { count: 'exact' })
      .in('user_id', [...ours]),
    'count push tokens',
  );
  if (tokens > 0) return 'a Perf Lab account has a registered push token';
  return null;
}

async function ensureOrders(admin, scope, plan, state, profiles) {
  const blocked = await ordersAreSilent(admin, scope, profiles);
  if (blocked) {
    log(`  SKIPPED order requests: ${blocked}. Nothing was inserted.`);
    return { orders: 0, lines: 0, skipped: true };
  }
  // The post-condition below compares two counts. scope.count() answers null when
  // the table cannot be read on this target, and null === null would "prove" that
  // nothing was notified. So: no readable count, no orders. Checked BEFORE the
  // first insert, because afterwards is too late to decline.
  const before = await scope.count('notifications');
  if (before === null) {
    die(
      'the notifications table is not readable on this target, so "no notification appeared" could not be checked. No order was inserted.',
    );
  }
  let orders = 0;
  let lines = 0;
  for (const o of plan.orders) {
    let header = state.orders.get(o.orderNumber);
    if (!header) {
      const { data, error } = await scope
        .insert('order_requests', {
          organization_id: scope.orgId,
          warehouse_id: state.warehouses.get(o.warehouseCode).id,
          order_number: o.orderNumber, // explicit => the numbering trigger passes it through
          status: o.status, // INSERT is not bound by the transition guard (BEFORE UPDATE OF status)
          source: 'internal',
          requester_user_id: profiles.get(o.requester).id, // order_requests_identity_chk
          fulfillment_type: 'pickup',
          delivery_charter_id: null, // must be null for pickup (order_requests_delivery_target_chk)
          notes: o.notes,
          denied_reason: o.deniedReason,
          approved_at: o.approvedAt,
          approved_by: o.approvedAt ? profiles.get('manager').id : null,
          completed_at: o.completedAt,
          cancelled_at: o.cancelledAt,
          created_at: o.createdAt,
          updated_at: o.updatedAt,
        })
        .select('id, order_number')
        .single();
      ok(error, `order ${o.orderNumber}`);
      if (!data?.id) die(`order ${o.orderNumber}: the server answered without a row.`);
      header = { ...data, lines: [] };
      state.orders.set(o.orderNumber, header);
      orders++;
    }
    if ((header.lines ?? []).length === 0) {
      // A header with no lines is a run that died between the two statements.
      const rows = o.lines.map((l) => ({
        order_request_id: header.id,
        item_id: state.items.get(l.sku).id,
        quantity_requested: l.quantityRequested,
        quantity_fulfilled: l.quantityFulfilled,
        unit_cost_at_request: l.unitCost,
        created_at: l.createdAt,
      }));
      // order_request_lines has no organization_id; it is scoped through its
      // parent, which was found or created under the Perf Lab id just above.
      assertLive(scope.dryRun, 'insert into order_request_lines');
      const { error } = await admin.from('order_request_lines').insert(rows);
      ok(error, `order ${o.orderNumber} lines`);
      lines += rows.length;
    }
  }
  // Post-condition, not an assumption: the insert must not have notified anyone.
  const after = await scope.count('notifications');
  if (after === null)
    die('the notifications table stopped being readable while orders were being seeded.');
  if (after !== before) {
    log(
      `  WARNING: ${after - before} notification row(s) appeared while seeding orders. Removing them.`,
    );
    const { error } = await scope.delete('notifications').eq('type', 'order_request.created');
    ok(error, 'remove notifications');
  }
  return { orders, lines, skipped: false };
}

/**
 * Everything that can REFUSE a run, checked before the first write and before a
 * dry run reports "would create". Found the hard way: this check used to live
 * only inside the account loop, so a live run created the organization, pinned
 * its modules and created the owner account, and THEN refused on the admin
 * account. Recoverable with teardown, but a refusal that could have been known
 * up front has no business arriving after the writes have begun, least of all
 * after a production countdown.
 *
 * The rule: a Perf Lab address that already exists must belong to the Perf Lab
 * and to nothing else. If it is a member of any other organization, or a B2B
 * portal login of some customer, a person reused the address, and adopting it
 * would hand the Perf Lab a real account (and teardown would later delete it).
 *
 * The organization-side half of "is this ours" (name, marker, members, the
 * production pin) is assertPerfLabOrgIsOurs() in lib.mjs, called from main()
 * just before this.
 */
async function preflightAccounts(admin, profiles, org) {
  const busy = [];
  const unstamped = [];
  for (const [key, profile] of profiles) {
    const ties = await accountTiesElsewhere(admin, profile.id, org?.id ?? null);
    if (ties.any) busy.push(key);
    // The address alone is not enough to ADOPT an account: anyone can register
    // perf-lab+owner@... by hand. Only an account carrying the stamp this tool
    // writes into app_metadata (which a user cannot write) is ours.
    const auth = await readAuthAccount(admin, profile.id);
    if (!auth.stamped || !isPerfLabAccountEmail(auth.email)) unstamped.push(key);
  }
  if (busy.length > 0) {
    refuse(
      `Perf Lab account(s) ${busy.join(', ')} already exist and belong to something outside the Perf Lab ` +
        '(another organization, or a customer portal login). Someone reused the address. Stop and investigate.',
    );
  }
  if (unstamped.length > 0) {
    refuse(
      `account(s) ${unstamped.join(', ')} exist at a Perf Lab address but were not created by this tool ` +
        '(no Perf Lab stamp in their auth app_metadata). The seed will not adopt an account it did not ' +
        'make. Remove them in the platform console, or find out who made them.',
    );
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2), {
    '--skip-orders': 'boolean',
    '--fingerprint': 'boolean',
    '--expect-fingerprint': 'value',
  });
  if (args.help) {
    log(USAGE);
    return;
  }
  const plan = buildPlan();
  const expectedFingerprint = args.raw['--expect-fingerprint'];
  if (expectedFingerprint !== undefined && !/^[0-9a-fA-F]{64}$/.test(expectedFingerprint)) {
    refuseEarly('--expect-fingerprint takes the 64 hex characters that --fingerprint prints.');
  }
  if (expectedFingerprint !== undefined && !args.raw['--fingerprint']) {
    refuseEarly('--expect-fingerprint only makes sense together with --fingerprint.');
  }
  if (args.raw['--fingerprint']) {
    await fingerprint(plan, args.concurrency, expectedFingerprint);
    return;
  }
  const skipOrders = args.raw['--skip-orders'] === true;

  const { target, url } = resolveTarget(args);
  const admin = createAdminClient(url, readServiceKey());
  await assertBypassesRls(admin);

  log(
    `Perf Lab seed: target ${target}${args.dryRun ? ', DRY RUN (nothing will be written)' : ''}, dataset ${plan.version}`,
  );
  // The image bytes depend on these two versions (and on the installed fonts).
  log(`  encoder: ${encoderVersions()}`);
  let org = await findPerfLabOrg(admin, args.expectedOrgId);
  // An organization that already holds the slug is written into only if it is
  // provably the Perf Lab. Before the dry-run report, before the countdown.
  if (org) {
    await assertPerfLabOrgIsOurs({
      admin,
      target,
      org,
      expectedOrgId: args.expectedOrgId,
      verb: 'write into',
    });
  }
  const readScope = org ? orgScope(admin, org, { dryRun: true }) : null;
  const state = await readState(admin, readScope);
  const profiles = await findPerfLabProfiles(admin);
  await preflightAccounts(admin, profiles, org);
  const todo = pending(plan, state, profiles, skipOrders);

  const summary = planSummary(plan);
  log(`  organization "${PERF_LAB_SLUG}": ${org ? 'exists' : 'does not exist yet'}`);
  log(
    `  plan: ${summary.items} items (${summary.books} books), ${summary.masters} photos, ${summary.orders} orders, ${plan.accounts.length} accounts`,
  );
  printPending(args.dryRun ? 'Would create:' : 'To create:', todo, Boolean(org));

  if (args.dryRun) {
    log('\nDry run complete. Nothing was written.');
    return;
  }

  await productionCountdown(target, [
    `Create or complete the organization "${PERF_LAB_NAME}" (slug ${PERF_LAB_SLUG}).`,
    `Create up to ${todo.accounts} sign-in accounts (perf-lab+<role>@stockpilotusa.com), with every notification off.`,
    `Insert up to ${todo.items} items and ${todo.orders} order requests, all inside that organization.`,
    `Upload up to ${todo.photos} photos (about ${(todo.masterBytes / 1048576).toFixed(0)} MiB) under <that organization's id>/ in the ${ITEM_IMAGES_BUCKET} bucket.`,
    'No email is sent. No other organization is read or written.',
  ]);

  // OWNERSHIP AGAIN, now that time has passed. Everything above was checked
  // before a ten-second countdown in which a person can join the organization,
  // be invited to it, or create one under the slug. Still only reads: a failure
  // here is a refusal (exit 2), and nothing has been written.
  if (org) {
    org = await reassertPerfLabOrg({
      admin,
      target,
      org,
      expectedOrgId: args.expectedOrgId,
      verb: 'write into',
    });
    await preflightAccounts(admin, profiles, org);
  } else if (await findPerfLabOrg(admin, null)) {
    refuse(
      `an organization holding slug "${PERF_LAB_SLUG}" appeared while this run was waiting to start. ` +
        'This run did not create it.',
    );
  }

  const made = { org: 0 };
  if (!org) {
    org = await ensureOrg(admin, args.dryRun);
    made.org = 1;
    // Printed NOW, not only at the end: if this run dies later, the retry on
    // production must be pinned with --org-id, and this is where the id comes from.
    log(`  organization created: id ${org.id}   (pin every later run with --org-id=${org.id})`);
  }
  // From the flag, never a literal: if a refactor ever lets a dry run reach this
  // line, the scope's write methods and assertLive() throw instead of writing.
  const scope = orgScope(admin, org, { dryRun: args.dryRun });
  noteWritesBegun('the seed had already started writing into the Perf Lab organization');
  // Re-read after creation: the insert trigger has just written the module rows.
  const live = made.org ? await readState(admin, scope) : state;

  made.modules = await ensureModules(scope, live);
  log(`  modules pinned (${made.modules} changed; on: ${ENABLED_MODULE_IDS.join(', ')})`);

  const accounts = await ensureAccounts(admin, scope, plan, live, profiles);
  log(
    `  accounts: ${accounts.accounts} created, ${accounts.memberships} memberships, ${accounts.muted} preference(s) switched off`,
  );
  const ownerId = profiles.get('owner').id;

  made.warehouses = await ensureWarehouses(scope, plan, live, ownerId);
  // The warehouse triggers wrote locations and assignments; read them back.
  const afterWarehouses = made.warehouses ? await readState(admin, scope) : live;
  made.assignments = await ensureAssignments(scope, plan, afterWarehouses, profiles, ownerId);
  made.locations = await ensureLocations(scope, plan, afterWarehouses);
  made.categories = await ensureNamed(
    scope,
    'categories',
    plan.categories,
    afterWarehouses.categories,
    (c) => ({ name: c.name, color: c.color }),
  );
  made.suppliers = await ensureNamed(
    scope,
    'suppliers',
    plan.suppliers,
    afterWarehouses.suppliers,
    (name) => ({ name }),
  );
  log(
    `  warehouses ${made.warehouses}, assignments ${made.assignments}, locations ${made.locations}, categories ${made.categories}, suppliers ${made.suppliers}`,
  );

  made.items = await ensureItems(scope, plan, afterWarehouses, ownerId);
  log(`  items created: ${made.items}`);

  const photos = await ensurePhotos(admin, scope, plan, afterWarehouses, args.concurrency);
  log(
    `  photos uploaded: ${photos.photos} masters, ${photos.thumbs} thumbnails, ${(photos.bytes / 1048576).toFixed(1)} MiB`,
  );
  if (photos.offTarget > 0) {
    log(
      `  WARNING: ${photos.offTarget} master(s) landed more than ${(BYTE_TOLERANCE * 100).toFixed(1)}% from their byte target. ` +
        'This machine renders differently from the one the dataset was tuned on; compare --fingerprint.',
    );
  }

  const orders = skipOrders
    ? { orders: 0, lines: 0, skipped: true }
    : await ensureOrders(admin, scope, plan, afterWarehouses, profiles);
  if (!orders.skipped) log(`  order requests created: ${orders.orders} (${orders.lines} lines)`);

  log('\nSeed complete.');
  log(`  organization id: ${org.id}   (pass it back as --org-id=${org.id} to pin later runs)`);
  log(
    `  created this run: organization ${made.org}, accounts ${accounts.accounts}, items ${made.items}, photos ${photos.photos}, orders ${orders.orders}`,
  );
  // The command as it must actually be typed: on production, verify without the
  // authorization flag and the pin is refused, and a hint that gets refused is
  // worse than no hint. The flag is NOT a secret; PERF_LAB_CONFIRM and the key
  // stay in the environment where the procedure put them.
  log(
    target === 'production'
      ? `  next: node apps/web/scripts/perf-lab/verify.mjs --target=production --i-am-authorized-by-the-owner --org-id=${org.id}`
      : '  next: node apps/web/scripts/perf-lab/verify.mjs --target=local',
  );
}

main().catch((err) => die(err?.message ?? String(err)));
