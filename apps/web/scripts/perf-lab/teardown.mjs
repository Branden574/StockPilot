#!/usr/bin/env node
/**
 * Remove the Perf Lab: the ONE organization with slug `stockpilot-perf-lab`,
 * everything under it, its stored objects, and its sign-in accounts.
 *
 * ORDER, and why it is this order:
 *   1. Storage objects under `<orgId>/`, in every bucket. Storage is not
 *      relational: no cascade reaches it, and once the organization row is gone
 *      the prefix is the only handle left. So objects go FIRST.
 *   2. Rows, children before parents, each statement filtered by the Perf Lab
 *      organization id. Almost everything hangs off organizations(id) ON DELETE
 *      CASCADE (90 foreign keys at this commit), but a few sibling tables ALSO
 *      hold ON DELETE RESTRICT keys onto warehouses and items:
 *          order_requests.warehouse_id        -> warehouses   RESTRICT (0044)
 *          order_request_lines.item_id        -> inventory_items RESTRICT (0044)
 *          receipts / shipments / rentals / bundles / bins / putaway_moves /
 *          serial_registry / lot_pick_events  -> warehouses or items RESTRICT
 *      TESTED on the local stack, because the first draft of this comment got the
 *      mechanism wrong by reasoning instead of trying it:
 *        - fully seeded (60 orders, 192 lines): a bare organization delete is
 *          REFUSED, 23503 on order_request_lines_item_id_fkey. The cascade reaches
 *          inventory_items while order lines still point at them.
 *        - organization + warehouse + one order with NO lines: the bare delete
 *          SUCCEEDS. So it is the order LINE that blocks, not the order, and
 *          order_requests.warehouse_id did not bite in that shape.
 *      Which RESTRICT key fires depends on the order Postgres runs its referential
 *      triggers, so teardown does not reason about it: children are deleted first,
 *      explicitly, in an order that is correct under any firing order and is
 *      proven on the full dataset.
 *   3. The organization row itself; its cascade sweeps whatever the app wrote
 *      while the org was in use (audit logs, saved views, notifications, ...).
 *   4. The accounts, last. An account is deleted only when ALL of these hold:
 *        - its email is one of the six EXACT addresses the seed creates (not a
 *          pattern: a seventh perf-lab+<name> login is a person, and is refused
 *          as a stranger below, never deleted);
 *        - it was a member of this organization, or belongs to no organization
 *          at all (what an interrupted seed or teardown leaves behind);
 *        - it is tied to nothing else: no other membership, no customer-portal
 *          login. That is checked when the plan is made AND AGAIN immediately
 *          before each delete, because between the two sit a countdown, ~880
 *          object removals and ~25 table deletes, and an account that gained a
 *          tie in that window must be kept. platform-admin.ts re-verifies at the
 *          same point for the same reason.
 *      Deleting the auth user cascades its profile, preferences, onboarding and
 *      release state.
 *
 * REFUSES, before anything is deleted and in a dry run too, unless the row that
 * holds the slug is provably the Perf Lab: exact name, the provenance marker the
 * seed stamped, every member one of the six accounts, and on production the
 * --org-id pin (lib.mjs, assertIsPerfLabOrg and assertPerfLabOrgIsOurs).
 *
 * OWNERSHIP IS RE-ASSERTED, not assumed to hold: once before anything (dry run
 * too), again right after the production countdown, and again immediately before
 * the membership rows and the organization row are deleted, minutes later. A
 * failure after deletes have begun exits 1 and says what was already removed.
 *
 * EXIT CODES: 0 everything is gone. 1 a runtime error (run the same command
 * again). 2 a rail refused and only reads were run. 3 the teardown finished its
 * work but something was deliberately KEPT or could only be REPORTED (an account
 * tied to something else or not made by this tool; objects in a bucket this tool
 * does not write to): re-running will not change that, a person has to look.
 *
 * RE-RUNNABLE AT EVERY POINT, WITH THE SAME COMMAND. Each step re-reads what is
 * there. In particular, a run interrupted AFTER the organization delete leaves
 * accounts and no organization; running the identical command again, `--org-id`
 * included, finds no row under the slug, CHECKS that no organization row holds
 * the pinned id either (if one does, under another slug, it refuses), sweeps the
 * leftover accounts, and looks under `<that id>/` in every bucket for objects an
 * upload may have added after the first pass.
 * (An earlier version refused that re-run because `--org-id` named a row that no
 * longer existed, which made the documented production command unable to finish.)
 *
 *   node apps/web/scripts/perf-lab/teardown.mjs --target=local --dry-run
 *   node apps/web/scripts/perf-lab/teardown.mjs --target=local
 */
import {
  ACCOUNT_KEYS,
  accountTiesElsewhere,
  assertBypassesRls,
  assertLive,
  assertNotForbiddenOrgId,
  assertPerfLabOrgIsOurs,
  createAdminClient,
  die,
  exactCount,
  findOrgRowById,
  findPerfLabOrg,
  findPerfLabProfiles,
  isPerfLabAccountEmail,
  isRemovableOrgObjectPath,
  ITEM_IMAGES_BUCKET,
  listObjectsUnderOrg,
  log,
  must,
  noteWritesBegun,
  orgScope,
  parseArgs,
  PERF_LAB_SLUG,
  productionCountdown,
  readAuthAccount,
  readServiceKey,
  reassertPerfLabOrg,
  refuse,
  resolveTarget,
} from './lib.mjs';

const USAGE = `
Perf Lab teardown. Deletes the organization "${PERF_LAB_SLUG}" and everything under it.

  --target=local|production         required; there is no default
  --dry-run                         print what would be deleted (counts only); delete nothing
  --org-id=<uuid>                   pin the Perf Lab organization's id (refuses on mismatch).
                                    REQUIRED on production while the organization exists.
  --i-am-authorized-by-the-owner    required for production, with PERF_LAB_CONFIRM=${PERF_LAB_SLUG}

Environment: SUPABASE_SERVICE_ROLE_KEY (required), SUPABASE_URL (local only).
Exit codes: 0 gone, 1 error (re-run), 2 refused (only reads), 3 finished but something was kept or only reported.
`;

/**
 * Org-scoped tables purged explicitly, children first. Every name here has an
 * `organization_id` column; a table missing on this target is skipped.
 * order_request_lines has no organization_id: it goes with its order
 * (order_request_id ON DELETE CASCADE), which is why order_requests sits above
 * inventory_items. Tables not listed are left to the organization's cascade.
 *
 * Read from the migrations, not assumed: receipt_lines, rental_lines and
 * bundle_components CASCADE from their parent, so only the parents are listed;
 * bundle_distributions holds a RESTRICT key onto bundles, so it comes first;
 * receipt_lines holds one onto purchase_order_items, so receipts come before it.
 *
 * KNOWN EDGE: receipts.reversed_receipt_id is a self-referencing RESTRICT. A Perf
 * Lab in which someone posted AND reversed a receipt could refuse the single
 * `delete from receipts`. Unreachable while purchase_orders is off (dataset.mjs);
 * if it ever happens the error names the constraint, nothing else is harmed, and
 * deleting the reversing receipt by hand lets the next run through.
 */
const PURGE_ORDER = [
  // Holders of RESTRICT keys onto warehouses / items. The seed writes only
  // order_requests; the rest are here so a Perf Lab that somebody USED (made a
  // shipment, a rental, a receipt) still tears down instead of aborting.
  'stock_reservations',
  'order_requests',
  'shipment_lines',
  'shipments',
  'rentals',
  'receipts',
  'lot_pick_events',
  'serial_registry',
  'putaway_moves',
  'inventory_stock',
  'bins',
  'bundle_distributions',
  'bundles',
  'purchase_order_items',
  'purchase_orders',
  // What the seed wrote, leaf to root.
  'notifications',
  'item_images',
  'item_stock_levels',
  'stock_movements',
  'inventory_items',
  'user_warehouse_assignments',
  'locations',
  'warehouses',
  'categories',
  'suppliers',
  'organization_modules',
  'organization_members',
];

const ok = (error, what) => {
  if (error) die(`${what}: ${error.message ?? error.code ?? 'unknown error'}`);
};

/** The seed's own object names: <org>/items/<item uuid>/<uuid>.<ext> and <uuid>-thumb.webp. Nothing else is ever assumed to be ours. */
const SEED_OBJECT_RE =
  /^[0-9a-f-]{36}\/items\/[0-9a-f-]{36}\/[0-9a-f-]{36}(?:-thumb)?\.(?:jpg|webp|png)$/;

/**
 * storage.remove(), behind every guard there is: not a dry run; every path is
 * under the organization's uuid prefix with no empty, '.' or '..' segment. The
 * paths were BUILT from that prefix by listObjectsUnderOrg(), so a bare
 * startsWith() proves nothing; what is tested is what a listing could actually
 * smuggle in, a hostile entry name.
 */
async function removeObjects(admin, dryRun, bucket, paths, orgId) {
  assertLive(dryRun, 'storage.remove');
  for (let from = 0; from < paths.length; from += 100) {
    const page = paths.slice(from, from + 100);
    if (!page.every((path) => isRemovableOrgObjectPath(path, orgId)))
      die('BUG: a storage path that is not strictly under the organization prefix.');
    const { error } = await admin.storage.from(bucket).remove(page);
    ok(error, `remove objects from ${bucket}`);
  }
}

/** Every bucket's objects under `<orgId>/`. Map of bucket id -> paths, only for buckets that hold any. */
async function listAllBuckets(admin, orgId, concurrency) {
  const buckets = await admin.storage.listBuckets();
  ok(buckets.error, 'list buckets');
  if (!Array.isArray(buckets.data)) die('list buckets: the server answered without a list.');
  const found = new Map();
  for (const bucket of buckets.data) {
    const paths = await listObjectsUnderOrg(admin, bucket.id, orgId, concurrency);
    if (paths.length > 0) found.set(bucket.id, paths);
  }
  return found;
}
const countObjects = (found) => [...found.values()].reduce((sum, paths) => sum + paths.length, 0);

/**
 * May this account be deleted? Asked when the plan is made and asked AGAIN, from
 * scratch, immediately before each auth.admin.deleteUser:
 *   - the auth user's CURRENT email (not the one captured earlier from
 *     user_profiles) is one of the six exact addresses;
 *   - it carries the stamp the seed writes into app_metadata, which a user cannot
 *     write: an account somebody registered by hand at a Perf Lab address is not
 *     ours to delete;
 *   - nothing ties it to anything else (another membership, a portal login).
 * Any read that fails stops the run. Returns a reason to KEEP it, or null.
 */
async function reasonToKeep(admin, userId, exceptOrgId) {
  const auth = await readAuthAccount(admin, userId);
  if (!isPerfLabAccountEmail(auth.email)) return 'its current email is not a Perf Lab address';
  if (!auth.stamped) return 'it was not created by this tool (no Perf Lab stamp)';
  const ties = await accountTiesElsewhere(admin, userId, exceptOrgId);
  if (ties.any)
    return `it is tied to something else (${ties.organizations} membership(s), ${ties.portals} portal login(s))`;
  return null;
}

async function splitAccounts(admin, accounts, exceptOrgId) {
  const removable = [];
  const kept = [];
  for (const account of accounts) {
    const why = await reasonToKeep(admin, account.id, exceptOrgId);
    if (why) kept.push({ ...account, why });
    else removable.push(account);
  }
  return { removable, kept };
}

/** By the time this runs the Perf Lab's own membership rows are gone, so ANY membership is a tie: exceptOrgId is null. */
async function deleteAccounts(admin, dryRun, users) {
  let deleted = 0;
  const keptLate = [];
  for (const user of users) {
    assertLive(dryRun, 'auth.admin.deleteUser');
    const why = await reasonToKeep(admin, user.id, null);
    if (why) {
      keptLate.push(why);
      log(`  account KEPT at the last check: ${why}.`);
      continue;
    }
    const { error } = await admin.auth.admin.deleteUser(user.id);
    ok(error, 'delete account');
    deleted++;
  }
  return { deleted, keptLate: keptLate.length };
}

function reportKept(kept) {
  const reasons = new Map();
  for (const k of kept) reasons.set(k.why, (reasons.get(k.why) ?? 0) + 1);
  for (const [why, n] of reasons) log(`  account(s) KEPT: ${n}, because ${why}.`);
}

/**
 * No organization holds the slug. Either nothing was ever seeded here, or a
 * teardown was interrupted after the organization delete, or somebody removed
 * the organization another way. What can still be left: accounts, and objects.
 *
 * With --org-id, NOTHING is said about that id until it has been looked up:
 *   - a row with that id under ANOTHER slug means the pinned organization still
 *     exists and was renamed. Refuse; that is somebody's organization now.
 *   - the id of a USER is refused too. `user-avatars` stores under `<user id>/`,
 *     so listing "<id>/" for a mistyped id could find, and offer to delete, a
 *     person's avatar.
 *   - only when no organization row and no user holds the id are objects under
 *     `<id>/` orphans. In item-images, files with exactly the seed's own names are
 *     removed (after the countdown, and after proving again that no row holds the
 *     id). Anything else, in any bucket, is REPORTED and left: this tool did not
 *     write it and will not guess.
 */
async function sweepWithoutOrganization(admin, args, target) {
  let orphanObjects = new Map();
  let pinnedIdIsFree = false;
  if (args.expectedOrgId) {
    const holder = await findOrgRowById(admin, args.expectedOrgId);
    if (holder) {
      refuse(
        'the organization pinned with --org-id still exists, under a different slug. Teardown deletes ' +
          `only the row that holds "${PERF_LAB_SLUG}". Find out who renamed it and why.`,
      );
    }
    const asUser = await must(
      admin.from('user_profiles').select('id').eq('id', args.expectedOrgId).limit(1),
      'id lookup',
    );
    if (asUser.length > 0)
      refuse('the id given with --org-id belongs to a user, not an organization.');
    pinnedIdIsFree = true;
    log(
      `No organization holds the slug "${PERF_LAB_SLUG}", and no organization row has the id given with --org-id.`,
    );
    orphanObjects = await listAllBuckets(admin, args.expectedOrgId, args.concurrency);
  } else {
    log(`No organization holds the slug "${PERF_LAB_SLUG}".`);
  }

  const profiles = [...(await findPerfLabProfiles(admin)).values()].map((p) => ({
    id: p.id,
    email: String(p.email).toLowerCase(),
  }));
  const { removable, kept } = await splitAccounts(admin, profiles, null);

  const ours = (orphanObjects.get(ITEM_IMAGES_BUCKET) ?? []).filter((path) =>
    SEED_OBJECT_RE.test(path),
  );
  const foreign = countObjects(orphanObjects) - ours.length;
  if (profiles.length === 0 && countObjects(orphanObjects) === 0) {
    // Say only what was looked at: without --org-id no bucket was listed.
    log(
      pinnedIdIsFree
        ? 'No Perf Lab accounts and no leftover objects. Nothing to tear down.'
        : 'No Perf Lab accounts. Leftover objects were NOT looked for: without --org-id there is no prefix to look under.',
    );
    return 0;
  }
  log(
    `  Perf Lab accounts left behind        ${profiles.length} (${removable.length} removable, ${kept.length} kept)`,
  );
  reportKept(kept);
  if (pinnedIdIsFree) {
    log(
      `  leftover objects under <that id>/    ${ours.length} with the seed's own names in ${ITEM_IMAGES_BUCKET} (removable)`,
    );
    if (foreign > 0) {
      log(
        `  leftover objects NOT written by seed ${foreign} (reported only; this tool did not write them and leaves them):`,
      );
      for (const [bucket, paths] of orphanObjects) {
        const n = bucket === ITEM_IMAGES_BUCKET ? paths.length - ours.length : paths.length;
        if (n > 0) log(`      ${bucket}: ${n}`);
      }
    }
  } else {
    log(
      '  leftover objects                     not looked for: without --org-id there is no prefix to look under.',
    );
  }
  if (args.dryRun) {
    log('\nDry run complete. Nothing was deleted.');
    return kept.length > 0 || foreign > 0 ? 3 : 0;
  }

  if (removable.length + ours.length > 0) {
    await productionCountdown(target, [
      `Delete ${removable.length} leftover Perf Lab sign-in account(s) and ${ours.length} leftover object(s). The organization itself is already gone.`,
    ]);
    if (ours.length > 0) {
      // The proof the deletion rests on, taken again after the wait.
      if (await findOrgRowById(admin, args.expectedOrgId))
        refuse('an organization row with the pinned id appeared during the countdown.');
      noteWritesBegun('teardown had started removing leftover objects');
      await removeObjects(admin, args.dryRun, ITEM_IMAGES_BUCKET, ours, args.expectedOrgId);
      log(`  storage ${ITEM_IMAGES_BUCKET}: ${ours.length} leftover object(s) removed`);
    }
    noteWritesBegun('teardown had started deleting leftover accounts');
    const result = await deleteAccounts(admin, args.dryRun, removable);
    log(
      `  accounts deleted: ${result.deleted}${result.keptLate ? `, kept at the last check: ${result.keptLate}` : ''}`,
    );
    kept.push(...Array(result.keptLate).fill({}));
  }
  const left = (await findPerfLabProfiles(admin)).size;
  const objectsLeft = pinnedIdIsFree
    ? countObjects(await listAllBuckets(admin, args.expectedOrgId, args.concurrency))
    : 0;
  log(
    `  Perf Lab accounts remaining: ${left}${pinnedIdIsFree ? `   leftover objects remaining: ${objectsLeft}` : ''}`,
  );
  if (left > kept.length)
    die('an account that should have been deleted is still there. Run teardown again.');
  if (objectsLeft > foreign)
    die('an object that should have been removed is still there. Run teardown again.');
  if (kept.length > 0 || foreign > 0) {
    log(
      '\nFinished, but NOT clean: see what was kept or only reported above. Re-running will not change it.',
    );
    return 3;
  }
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    log(USAGE);
    return 0;
  }
  const { target, url } = resolveTarget(args);
  const admin = createAdminClient(url, readServiceKey());
  await assertBypassesRls(admin);

  log(
    `Perf Lab teardown: target ${target}${args.dryRun ? ', DRY RUN (nothing will be deleted)' : ''}`,
  );
  // missingOk: teardown is the one script for which "the organization is not
  // there" is an expected state and not a contradiction (see lib.mjs).
  const found = await findPerfLabOrg(admin, args.expectedOrgId, { missingOk: true });
  if (!found) return sweepWithoutOrganization(admin, args, target);
  let org = found;
  assertNotForbiddenOrgId(org.id, { seenInDatabase: true });

  // ── Whose is it, and who is in it ─────────────────────────────────────────
  // Name, marker, exact-six members, no invitees, no portal logins, production
  // pin: the same test the seed applies before it writes.
  const ownership = { admin, target, expectedOrgId: args.expectedOrgId, verb: 'delete' };
  const members = await assertPerfLabOrgIsOurs({ ...ownership, org });
  const readScope = orgScope(admin, org, { dryRun: true });
  const memberAccounts = members.map((m) => ({ id: m.user_id, email: m.email }));
  // A seed that died between "create account" and "add membership" leaves one of
  // the six addresses belonging to NO organization. (findPerfLabProfiles looks up
  // the six exact addresses only.)
  const memberIds = new Set(members.map((m) => m.user_id));
  const strays = [...(await findPerfLabProfiles(admin)).values()]
    .filter((p) => !memberIds.has(p.id))
    .map((p) => ({ id: p.id, email: String(p.email).toLowerCase() }));
  const fromMembers = await splitAccounts(admin, memberAccounts, org.id);
  const fromStrays = await splitAccounts(admin, strays, null);
  const removable = [...fromMembers.removable, ...fromStrays.removable];
  const keptAtPlan = [...fromMembers.kept, ...fromStrays.kept];

  // ── What is in it ─────────────────────────────────────────────────────────
  const objects = await listAllBuckets(admin, org.id, args.concurrency);
  const counts = new Map();
  for (const table of PURGE_ORDER) {
    const n = await readScope.count(table);
    if (n) counts.set(table, n);
  }

  log(`\n${args.dryRun ? 'Would delete' : 'To delete'} (organization ${org.id}):`);
  for (const [bucket, paths] of objects)
    log(`  storage ${bucket.padEnd(28)} ${paths.length} object(s) under <orgId>/`);
  if (objects.size === 0) log('  storage                              0 objects');
  for (const [table, n] of counts) log(`  rows    ${table.padEnd(28)} ${n}`);
  log('  rows    (everything else org-scoped)  by ON DELETE CASCADE from the organization');
  log(`  organization                         1`);
  log(
    `  accounts                             ${removable.length} of ${ACCOUNT_KEYS.length} (${keptAtPlan.length} kept)`,
  );
  reportKept(keptAtPlan);

  if (args.dryRun) {
    log('\nDry run complete. Nothing was deleted.');
    return keptAtPlan.length > 0 ? 3 : 0;
  }

  await productionCountdown(target, [
    `DELETE the organization with slug ${PERF_LAB_SLUG} and every row under it.`,
    `DELETE ${countObjects(objects)} stored object(s) under that organization's id.`,
    `DELETE ${removable.length} Perf Lab sign-in account(s).`,
    'This cannot be undone. Re-seeding recreates the same dataset (byte-identical on the same sharp build and fonts; compare seed.mjs --fingerprint).',
  ]);
  // OWNERSHIP AGAIN: ten seconds have passed. Still only reads, so a failure here
  // is a refusal and nothing has been deleted.
  org = await reassertPerfLabOrg({ ...ownership, org });
  // From the flag, never a literal (see seed.mjs).
  const scope = orgScope(admin, org, { dryRun: args.dryRun });

  // 1. Storage. remove() takes a list; 100 per call keeps each request small.
  for (const [bucket, paths] of objects) {
    noteWritesBegun('teardown had already started removing stored objects');
    await removeObjects(admin, args.dryRun, bucket, paths, org.id);
    log(`  storage ${bucket}: ${paths.length} removed`);
  }

  // 2. Rows, children first. Only tables that actually hold rows are touched.
  for (const table of PURGE_ORDER) {
    if (!counts.has(table)) continue;
    // AND AGAIN, before the rows whose loss cannot be recovered from: minutes may
    // have passed removing objects. After this the organization has no members,
    // which the ownership test allows (it is also the crash-resume state).
    if (table === 'organization_members') org = await reassertPerfLabOrg({ ...ownership, org });
    noteWritesBegun('teardown had already removed stored objects and rows');
    const { error } = await scope.delete(table);
    ok(error, `delete ${table}`);
    log(`  rows ${table}: ${counts.get(table)} deleted`);
  }

  // 3. The organization. Re-asserted once more; then filtered by id AND slug, so
  //    even a wrong id in hand could not match another organization's row.
  org = await reassertPerfLabOrg({ ...ownership, org });
  assertLive(args.dryRun, 'delete from organizations');
  const gone = await admin
    .from('organizations')
    .delete()
    .eq('id', org.id)
    .eq('slug', PERF_LAB_SLUG)
    .select('id');
  ok(
    gone.error,
    'delete organization (if this names a foreign key, that table needs adding to PURGE_ORDER)',
  );
  if (!Array.isArray(gone.data) || gone.data.length !== 1)
    die('the organization row was not deleted.');
  log('  organization: deleted');

  // 3b. Storage once more, while the validated id is still in hand. An upload that
  //     landed during steps 1-3 (the web app was open, the harness was running)
  //     left objects behind, and after this process exits nothing in the database
  //     points at them any more. No organization row holds the id now, by the
  //     delete above, so everything under it is an orphan.
  const late = await listAllBuckets(admin, org.id, args.concurrency);
  for (const [bucket, paths] of late) {
    await removeObjects(admin, args.dryRun, bucket, paths, org.id);
    log(`  storage ${bucket}: ${paths.length} more removed (uploaded while teardown was running)`);
  }

  // 4. Accounts.
  const accounts = await deleteAccounts(admin, args.dryRun, removable);
  log(
    `  accounts: ${accounts.deleted} deleted${accounts.keptLate ? `, ${accounts.keptLate} kept at the last check` : ''}`,
  );

  // ── Proof ────────────────────────────────────────────────────────────────
  const orgAfter = await must(
    admin.from('organizations').select('id').eq('slug', PERF_LAB_SLUG),
    'final organization check',
  );
  const objectsAfter = countObjects(await listAllBuckets(admin, org.id, args.concurrency));
  const itemsAfter = await exactCount(
    admin.from('inventory_items').select('id', { count: 'exact' }).eq('organization_id', org.id),
    'final item check',
  );
  const profilesAfter = await findPerfLabProfiles(admin);
  const keptTotal = keptAtPlan.length + accounts.keptLate;
  log('\nAfter teardown:');
  log(`  organizations with the Perf Lab slug  ${orgAfter.length}`);
  log(`  items under the organization id       ${itemsAfter}`);
  log(`  stored objects under <orgId>/         ${objectsAfter}`);
  log(
    `  Perf Lab accounts remaining           ${profilesAfter.size}${keptTotal ? `   (${keptTotal} kept on purpose)` : ''}`,
  );
  const remaining = [];
  if (orgAfter.length) remaining.push('the organization row');
  if (itemsAfter) remaining.push(`${itemsAfter} item row(s)`);
  if (objectsAfter) remaining.push(`${objectsAfter} stored object(s)`);
  if (profilesAfter.size > keptTotal)
    remaining.push(`${profilesAfter.size - keptTotal} account(s) that should have been deleted`);
  if (remaining.length > 0) {
    die(
      `teardown finished but something is still there: ${remaining.join(', ')}. Run the SAME command again, ` +
        `--org-id=${org.id} included: with the organization row gone, that id is the only handle left on ` +
        'stored objects, and a run without it cannot see them.',
    );
  }
  if (keptTotal > 0) {
    log(
      '\nTeardown finished, but NOT clean: account(s) were kept on purpose (see above). Re-running will not change that.',
    );
    return 3;
  }
  log('Teardown complete.');
  return 0;
}

main()
  .then((code) => {
    if (code) process.exit(code);
  })
  .catch((err) => die(err?.message ?? String(err)));
