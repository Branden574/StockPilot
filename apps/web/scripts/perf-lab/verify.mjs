#!/usr/bin/env node
/**
 * READ-ONLY census of the Perf Lab organization: prints the distribution that
 * was actually achieved next to the targets it was built for, and exits
 * non-zero when a target is missed.
 *
 * It measures the STORED objects, not the plan: every master and thumbnail is
 * probed with a ranged GET (first 64 KB / 64 bytes), its pixel size is parsed
 * from the file header, its full size is read from Content-Range, and the
 * Cache-Control and Content-Type the storage API serves are tallied. That is the
 * same ruler the 2026-09-18 production census used (thumb-census.mjs), so
 * "p50 310 KB" means the same thing for the customer's photos and for these.
 *
 * COUNTS ARE COMPARED EXACTLY; only byte percentiles carry a tolerance (see
 * dataset.mjs TARGETS). It also re-checks the safety properties the seed
 * promised (modules, muted preferences, no push tokens, no MFA, who can see
 * which warehouse), because a benchmark organization that drifted into emailing
 * someone is a worse failure than one whose p95 is off.
 *
 * NO CHECK MAY PASS BECAUSE ITS READ FAILED. Every read either goes through a
 * helper that stops the run on an error or an absent count (must, exactCount,
 * orgScope().count, fetchAll), or turns the failure into a MISS. "0" in this
 * report always means a zero that was read.
 *
 * WHO WROTE EACH ROW is measured too (dataset.mjs, the three writers): a
 * thumbnail's real format is read from its MAGIC BYTES, never from its name or
 * its Content-Type, because every thumbnail is named -thumb.webp and served as
 * image/webp, including the 67 that are PNG files.
 *
 * Writes nothing: no rows, no objects, no sessions, no magic links. The one RPC
 * it calls is sent as a GET, which PostgREST runs in a READ-ONLY transaction, so
 * "writes nothing" does not rest on having read that function's body correctly.
 *
 *   node apps/web/scripts/perf-lab/verify.mjs --target=local
 */
import {
  buildPlan,
  CENSUS_SHARES,
  ENABLED_MODULE_IDS,
  planSummary,
  TARGETS,
  TOLERANCES,
} from './dataset.mjs';
import {
  assertBypassesRls,
  assertPinnedOnProduction,
  createAdminClient,
  die,
  exactCount,
  fetchAll,
  findPerfLabOrg,
  findPerfLabProfiles,
  imageDims,
  isPerfLabAccountEmail,
  ITEM_IMAGES_BUCKET,
  listObjectsUnderOrg,
  log,
  must,
  orgScope,
  parseArgs,
  percentile,
  PERF_LAB_SLUG,
  progressPrinter,
  readAuthAccount,
  readOrgMembers,
  readOrgOutsiders,
  readServiceKey,
  resolveTarget,
  runPool,
} from './lib.mjs';

const USAGE = `
Perf Lab verify. Read-only census of the organization "${PERF_LAB_SLUG}" against its targets.

  --target=local|production         required; there is no default
  --concurrency=N                   ranged reads in flight, 1-8 (default 4)
  --allow-no-orders                 do not fail when order requests were deliberately skipped
  --org-id=<uuid>                   pin the Perf Lab organization's id. REQUIRED on production.
  --i-am-authorized-by-the-owner    required for production, with PERF_LAB_CONFIRM=${PERF_LAB_SLUG}

Exit code 0 when every check passes, 1 when any target is missed, 2 when a safety rail refused.
`;

const KB = 1024;
const kb = (n) => (n == null ? 'n/a' : `${Math.round(n / KB)} KB`);
const pct = (x) => `${(x * 100).toFixed(1)}%`;
/** 0.12 => 12. Rounded because 0.03 * 100 is 3.0000000000000004 in binary floating point. */
const whole = (x) => Math.round(x * 100);

const checks = [];
function check(group, name, target, achieved, pass, tolerance = 'exact') {
  checks.push({ group, name, target: String(target), achieved: String(achieved), tolerance, pass });
}
/** A count the plan fixes. `of` adds the share, so the census percentage stays readable. */
function exact(group, name, target, achieved, of = null) {
  const show = (v) => (of ? `${v} (${pct(v / of)})` : v);
  check(group, name, show(target), show(achieved), achieved === target);
}
/** A byte percentile, the only kind of value that carries a tolerance. */
function bytes(group, name, target, achieved, rel) {
  const pass = achieved != null && Math.abs(achieved - target) <= target * rel;
  check(group, name, kb(target), kb(achieved), pass, `+/- ${whole(rel)}%`);
}
/** Two sets of names that must be equal, shown as sorted lists. */
function sameSet(group, name, expected, actual) {
  const a = [...expected].sort().join(', ') || 'none';
  const b = [...actual].sort().join(', ') || 'none';
  check(group, name, a, b, a === b);
}

/**
 * First bytes of one stored object + the headers that decide browser caching.
 *
 * NEVER ASKS PAST THE END OF THE FILE. Found the hard way on dataset v2, whose
 * smallest masters are 16 KB: the local storage server (file backend) does not
 * answer `Range: bytes=0-65535` for a 40 KB object, it HANGS until the gateway
 * cuts the connection a minute later (measured: the same object answers
 * bytes=0-1023 in 2 ms). So the probe first reads 64 bytes, which every image
 * has and which already carries the WebP and PNG dimensions and, in
 * Content-Range, the true size; only a JPEG needs more (its size marker sits
 * after the quantisation tables), and that second read is clamped to the size
 * just learned. A timeout turns a hang into an unreadable object, which is a
 * MISS in the report, instead of into a crashed census.
 */
async function probe(url, key, path, wanted) {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const read = async (length) => {
    const res = await fetch(
      `${url}/storage/v1/object/authenticated/${ITEM_IMAGES_BUCKET}/${encoded}`,
      {
        headers: { apikey: key, Authorization: `Bearer ${key}`, Range: `bytes=0-${length - 1}` },
        redirect: 'error', // a redirect would forward the key to another host
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!res.ok && res.status !== 206) return { res, buf: null };
    return { res, buf: Buffer.from(await res.arrayBuffer()) };
  };
  try {
    let { res, buf } = await read(64);
    if (!buf) return { status: res.status, cacheControl: '(unread)' };
    const total =
      Number((res.headers.get('content-range') ?? '').split('/')[1]) ||
      Number(res.headers.get('content-length')) ||
      null;
    let dims = imageDims(buf);
    if (!dims && total && wanted > 64) {
      ({ res, buf } = await read(Math.min(wanted, total)));
      if (!buf) return { status: res.status, cacheControl: '(unread)' };
      dims = imageDims(buf);
    }
    return {
      status: res.status,
      dims,
      total,
      // An ABSENT header is its own value, never folded into "no-cache": the
      // production census kept it apart too, and found the literal header served.
      cacheControl: res.headers.get('cache-control') ?? '(none)',
      type: res.headers.get('content-type') ?? '(none)',
    };
  } catch {
    return { status: 'network', cacheControl: '(unread)' };
  }
}

const tally = (list, f) => list.reduce((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});
const longSide = (d) => (d ? Math.max(d.w, d.h) : null);

async function main() {
  const args = parseArgs(process.argv.slice(2), { '--allow-no-orders': 'boolean' });
  if (args.help) {
    log(USAGE);
    return;
  }
  if (args.dryRun) log('(--dry-run has no effect here: verify never writes.)');
  const { target, url } = resolveTarget(args);
  const key = readServiceKey();
  const admin = createAdminClient(url, key);
  await assertBypassesRls(admin);

  // findPerfLabOrg refuses a row without the exact name and the provenance
  // marker, so verify cannot be pointed at an organization the seed did not make.
  const org = await findPerfLabOrg(admin, args.expectedOrgId);
  if (!org) die(`no organization with slug "${PERF_LAB_SLUG}" on this target. Seed it first.`);
  const orgMembers = await readOrgMembers(admin, org);
  assertPinnedOnProduction({
    target,
    org,
    expectedOrgId: args.expectedOrgId,
    memberCount: orgMembers.length,
  });
  // dryRun: true => the scope's write methods throw. This script has no business calling them.
  const scope = orgScope(admin, org, { dryRun: true });
  const plan = buildPlan();
  const planned = planSummary(plan);
  const allowNoOrders = args.raw['--allow-no-orders'] === true;
  log(`Perf Lab verify: target ${target}, organization ${org.id}, dataset ${plan.version}\n`);

  // ── Photos ────────────────────────────────────────────────────────────────
  const images = await fetchAll(() =>
    scope.select('item_images', 'id, item_id, storage_path, thumb_path, lqip').order('id'),
  );
  log(
    `Probing ${images.length} masters and ${images.filter((r) => r.thumb_path).length} thumbnails (ranged reads, ${args.concurrency} in flight)...`,
  );
  const rows = new Array(images.length);
  await runPool(
    images,
    args.concurrency,
    async (row, i) => {
      const lqipKind = /^data:image\/(png|webp);base64,/.exec(row.lqip ?? '')?.[1] ?? null;
      rows[i] = {
        itemId: row.item_id,
        lqip: Boolean(row.lqip),
        lqipKind: row.lqip ? (lqipKind ?? 'other') : null,
        master: await probe(url, key, row.storage_path, 65536),
        thumb: row.thumb_path ? await probe(url, key, row.thumb_path, 64) : null,
        thumbNamedWebp: row.thumb_path ? row.thumb_path.endsWith('-thumb.webp') : null,
      };
    },
    progressPrinter('probed', 100),
  );
  const masters = rows.map((r) => r.master);
  const thumbs = rows.filter((r) => r.thumb).map((r) => r.thumb);
  const read = (m) => m.status === 206 || m.status === 200;
  const n = masters.length;
  const kinds = tally(masters, (m) => m.dims?.kind ?? 'unknown');
  const types = tally(masters, (m) => m.type);
  const masterBytes = masters.map((m) => m.total);
  const thumbBytes = thumbs.map((t) => t.total);
  const bytesOf = (list) => list.map((r) => r.master.total);
  const maxOf = (list) => (list.length ? Math.max(...list) : null);

  // WHO WROTE THE ROW, from what is stored and nothing else: the thumbnail's
  // real format (magic bytes), the placeholder's MIME, the thumbnail's
  // Cache-Control. Exactly the three signatures census v2 found in production.
  const writerOf = (r) => {
    if (!r.thumb) return r.lqipKind ? 'unclassified' : 'no-thumb';
    const thumbKind = r.thumb.dims?.kind;
    const cc = r.thumb.cacheControl;
    if (thumbKind === 'webp' && !r.lqipKind && cc === 'max-age=3600') return 'backfill';
    if (thumbKind === 'webp' && r.lqipKind === 'webp' && cc === 'no-cache') return 'webp-browser';
    if (thumbKind === 'png' && r.lqipKind === 'png' && cc === 'no-cache') return 'webkit';
    return 'unclassified';
  };
  for (const r of rows) r.writer = writerOf(r);
  const byWriter = (w) => rows.filter((r) => r.writer === w);

  exact('photos', 'item photos', TARGETS.photos, n);
  exact(
    'photos',
    'objects that could not be read',
    0,
    [...masters, ...thumbs].filter((m) => !read(m)).length,
  );
  exact(
    'photos',
    'headers that could not be parsed',
    0,
    [...masters, ...thumbs].filter((m) => read(m) && !m.dims).length,
  );

  for (const w of ['backfill', 'webp-browser', 'webkit', 'no-thumb']) {
    exact('writers', `rows written by: ${w}`, TARGETS.writers[w], byWriter(w).length);
  }
  exact('writers', 'rows matching no writer signature', 0, byWriter('unclassified').length);

  exact(
    'masters',
    `served as image/jpeg (census ${pct(CENSUS_SHARES.masterJpeg)})`,
    TARGETS.masterJpeg,
    types['image/jpeg'] ?? 0,
    n,
  );
  exact(
    'masters',
    `served as image/webp (census ${pct(CENSUS_SHARES.masterWebp)})`,
    TARGETS.masterWebp,
    types['image/webp'] ?? 0,
    n,
  );
  exact('masters', 'served as image/png', TARGETS.masterPng, types['image/png'] ?? 0);
  exact('masters', 'JPEG by magic bytes', TARGETS.masterMagic.jpeg, kinds.jpeg ?? 0);
  exact('masters', 'WebP by magic bytes', TARGETS.masterMagic.webp, kinds.webp ?? 0);
  exact('masters', 'PNG by magic bytes', TARGETS.masterMagic.png, kinds.png ?? 0);
  exact(
    'masters',
    'PNG bytes served as image/webp',
    TARGETS.masterTypeDisagrees,
    masters.filter((m) => m.dims?.kind === 'png' && m.type === 'image/webp').length,
  );
  exact(
    'masters',
    'any other type/bytes disagreement',
    0,
    masters.filter(
      (m) =>
        m.dims &&
        m.type !== `image/${m.dims.kind}` &&
        !(m.dims.kind === 'png' && m.type === 'image/webp'),
    ).length,
  );
  bytes(
    'masters',
    'bytes p5 (designed, no census)',
    planned.masterP5Bytes,
    percentile(masterBytes, 5),
    TOLERANCES.smallMasterRel,
  );
  bytes(
    'masters',
    'bytes p50',
    TARGETS.masterP50Bytes,
    percentile(masterBytes, 50),
    TOLERANCES.masterP50Rel,
  );
  bytes(
    'masters',
    'bytes p95',
    TARGETS.masterP95Bytes,
    percentile(masterBytes, 95),
    TOLERANCES.masterP95Rel,
  );
  bytes(
    'masters',
    'bytes max',
    TARGETS.masterMaxBytes,
    maxOf(masterBytes),
    TOLERANCES.masterMaxRel,
  );
  exact(
    'masters',
    'multi-MB (> 2 MiB)',
    TARGETS.masterMultiMb,
    masterBytes.filter((b) => b > 2 * KB * KB).length,
  );
  exact(
    'masters',
    'long side > 2048 px',
    TARGETS.masterOver2048,
    masters.filter((m) => longSide(m.dims) > 2048).length,
  );
  exact(
    'masters',
    `long side < ${TARGETS.masterLongSideMin} px (browser classes only)`,
    planned.masterBelow1200,
    masters.filter((m) => m.dims && longSide(m.dims) < TARGETS.masterLongSideMin).length,
  );
  exact(
    'masters',
    `long side < ${TARGETS.masterLongSideMin} px among backfill / no-thumb`,
    0,
    rows.filter(
      (r) =>
        (r.writer === 'backfill' || r.writer === 'no-thumb') &&
        r.master.dims &&
        longSide(r.master.dims) < TARGETS.masterLongSideMin,
    ).length,
  );

  const wk = byWriter('webkit');
  const wb = byWriter('webp-browser');
  bytes(
    'webkit class',
    'master bytes p50',
    TARGETS.webkitMasterP50Bytes,
    percentile(bytesOf(wk), 50),
    TOLERANCES.classMasterRel,
  );
  bytes(
    'webkit class',
    'master bytes p95',
    TARGETS.webkitMasterP95Bytes,
    percentile(bytesOf(wk), 95),
    TOLERANCES.classMasterRel,
  );
  bytes(
    'webkit class',
    'master bytes max',
    TARGETS.masterMaxBytes,
    maxOf(bytesOf(wk)),
    TOLERANCES.masterMaxRel,
  );
  exact(
    'webkit class',
    'masters JPEG / PNG by magic bytes',
    '64 / 3',
    `${wk.filter((r) => r.master.dims?.kind === 'jpeg').length} / ${wk.filter((r) => r.master.dims?.kind === 'png').length}`,
  );
  exact(
    'webkit class',
    'masters over 2048 px',
    TARGETS.masterOver2048Webkit,
    wk.filter((r) => longSide(r.master.dims) > 2048).length,
  );
  bytes(
    'webp-browser class',
    'master bytes p50',
    TARGETS.webpBrowserMasterP50Bytes,
    percentile(bytesOf(wb), 50),
    TOLERANCES.smallMasterRel,
  );
  bytes(
    'webp-browser class',
    'master bytes p95',
    TARGETS.webpBrowserMasterP95Bytes,
    percentile(bytesOf(wb), 95),
    TOLERANCES.classMasterRel,
  );
  bytes(
    'webp-browser class',
    'master bytes max',
    TARGETS.webpBrowserMasterMaxBytes,
    maxOf(bytesOf(wb)),
    TOLERANCES.classMasterRel,
  );
  exact(
    'webp-browser class',
    'masters WebP / JPEG by magic bytes',
    '65 / 4',
    `${wb.filter((r) => r.master.dims?.kind === 'webp').length} / ${wb.filter((r) => r.master.dims?.kind === 'jpeg').length}`,
  );

  const pngThumbs = thumbs.filter((t) => t.dims?.kind === 'png');
  const webpThumbs = thumbs.filter((t) => t.dims?.kind === 'webp');
  exact('thumbnails', 'thumbnails stored', TARGETS.thumbs, thumbs.length);
  exact(
    'thumbnails',
    'photos with NO thumbnail (thumb_path null)',
    TARGETS.thumbMissing,
    rows.filter((r) => !r.thumb).length,
  );
  exact(
    'thumbnails',
    'named -thumb.webp',
    TARGETS.thumbs,
    rows.filter((r) => r.thumbNamedWebp === true).length,
  );
  exact(
    'thumbnails',
    'served as image/webp',
    TARGETS.thumbs,
    thumbs.filter((t) => t.type === 'image/webp').length,
  );
  exact('thumbnails', 'REALLY WebP (magic bytes)', TARGETS.thumbWebp, webpThumbs.length);
  exact('thumbnails', 'REALLY PNG (magic bytes)', TARGETS.thumbPng, pngThumbs.length);
  exact(
    'thumbnails',
    `long side > ${TARGETS.thumbMaxLongSide} px`,
    0,
    thumbs.filter((t) => longSide(t.dims) > TARGETS.thumbMaxLongSide).length,
  );
  bytes(
    'thumbnails',
    'bytes p50 (all)',
    TARGETS.thumbP50Bytes,
    percentile(thumbBytes, 50),
    TOLERANCES.thumbP50Rel,
  );
  bytes(
    'thumbnails',
    'bytes p95 (all)',
    TARGETS.thumbP95Bytes,
    percentile(thumbBytes, 95),
    TOLERANCES.thumbP95Rel,
  );
  bytes(
    'thumbnails',
    'WebP bytes p50',
    TARGETS.thumbWebpP50Bytes,
    percentile(
      webpThumbs.map((t) => t.total),
      50,
    ),
    TOLERANCES.thumbP50Rel,
  );
  bytes(
    'thumbnails',
    'WebP bytes max',
    TARGETS.thumbWebpMaxBytes,
    maxOf(webpThumbs.map((t) => t.total)),
    TOLERANCES.thumbWebpMaxRel,
  );
  bytes(
    'thumbnails',
    'PNG bytes p50',
    TARGETS.thumbPngP50Bytes,
    percentile(
      pngThumbs.map((t) => t.total),
      50,
    ),
    TOLERANCES.thumbPngRel,
  );
  bytes(
    'thumbnails',
    'PNG bytes p95',
    TARGETS.thumbPngP95Bytes,
    percentile(
      pngThumbs.map((t) => t.total),
      95,
    ),
    TOLERANCES.thumbPngRel,
  );
  bytes(
    'thumbnails',
    'PNG bytes max',
    TARGETS.thumbPngMaxBytes,
    maxOf(pngThumbs.map((t) => t.total)),
    TOLERANCES.thumbPngRel,
  );
  exact(
    'thumbnails',
    'thumbnails of 30 KB or more that are NOT PNG',
    0,
    thumbs.filter((t) => t.total >= 30 * KB && t.dims?.kind !== 'png').length,
  );

  exact(
    'LQIP',
    `rows with a blur placeholder (census ${pct(CENSUS_SHARES.lqipPresent)})`,
    TARGETS.lqipPresent,
    rows.filter((r) => r.lqip).length,
    n,
  );
  exact(
    'LQIP',
    'data:image/webp placeholders',
    TARGETS.lqipWebp,
    rows.filter((r) => r.lqipKind === 'webp').length,
  );
  exact(
    'LQIP',
    'data:image/png placeholders',
    TARGETS.lqipPng,
    rows.filter((r) => r.lqipKind === 'png').length,
  );

  // Tallied on the header AS SERVED. Nothing is folded: a missing header is
  // "(none)", a failed probe is "(unread)", and either lands in the last check.
  const masterCc = tally(masters, (m) => m.cacheControl);
  for (const [label, count] of Object.entries(TARGETS.masterCache)) {
    exact(
      'Cache-Control',
      `masters ${label} (census ${pct(CENSUS_SHARES.masterCache[label])})`,
      count,
      masterCc[label] ?? 0,
      n,
    );
  }
  const thumbCc = tally(thumbs, (t) => t.cacheControl);
  for (const [label, count] of Object.entries(TARGETS.thumbCache)) {
    exact(
      'Cache-Control',
      `thumbnails ${label} (census ${pct(CENSUS_SHARES.thumbCache[label])})`,
      count,
      thumbCc[label] ?? 0,
      thumbs.length,
    );
  }
  sameSet(
    'Cache-Control',
    'values served outside the three groups',
    [],
    Object.keys({ ...masterCc, ...thumbCc }).filter((k) => !(k in TARGETS.masterCache)),
  );

  // ── Catalog ───────────────────────────────────────────────────────────────
  const items = await fetchAll(() =>
    scope
      .select(
        'inventory_items',
        'id, item_type, quantity_on_hand, reorder_point, warehouse_id, category_id, status, deleted_at',
      )
      .order('id'),
  );
  const live = items.filter((i) => !i.deleted_at);
  const qty = (i) => Number(i.quantity_on_hand);
  const warehouses = await must(scope.select('warehouses', 'id, code'), 'read warehouses');
  const codeById = new Map(warehouses.map((w) => [w.id, w.code]));
  exact('catalog', 'items', TARGETS.items, live.length);
  // A photo census can pass while the photos sit on the wrong items: two rows on
  // one item and none on another still counts 443. And an archived item never
  // reaches a list page at all. So the pairing is checked, not only the totals.
  const liveIds = new Set(live.map((i) => i.id));
  const imagesPerItem = tally(rows, (r) => r.itemId);
  exact(
    'catalog',
    "items whose status is not 'active'",
    0,
    live.filter((i) => i.status !== 'active').length,
  );
  exact(
    'catalog',
    'live items with exactly one photo row',
    TARGETS.items,
    live.filter((i) => imagesPerItem[i.id] === 1).length,
  );
  exact(
    'catalog',
    'photo rows whose item is not a live item',
    0,
    rows.filter((r) => !liveIds.has(r.itemId)).length,
  );
  // What is actually IN the bucket under this organization: an object with no row
  // pointing at it is invisible to every check above, and is still downloaded by
  // nobody and paid for by somebody.
  const stored = await listObjectsUnderOrg(admin, ITEM_IMAGES_BUCKET, org.id, args.concurrency);
  exact(
    'catalog',
    `objects stored under <orgId>/ in ${ITEM_IMAGES_BUCKET}`,
    TARGETS.photos + TARGETS.thumbs,
    stored.length,
  );
  exact(
    'catalog',
    "items of type 'book'",
    TARGETS.books,
    live.filter((i) => i.item_type === 'book').length,
  );
  exact(
    'catalog',
    'product categories in use',
    TARGETS.productCategories,
    new Set(live.filter((i) => i.item_type !== 'book').map((i) => i.category_id)).size,
  );
  exact('catalog', 'warehouses', TARGETS.warehouses, warehouses.length);
  for (const [code, count] of Object.entries(planned.byWarehouse)) {
    exact(
      'catalog',
      `items in warehouse ${code}`,
      count,
      live.filter((i) => codeById.get(i.warehouse_id) === code).length,
    );
  }
  exact(
    'catalog',
    'items with no warehouse (invisible under RLS)',
    0,
    live.filter((i) => !i.warehouse_id).length,
  );
  exact(
    'catalog',
    'items out of stock',
    planned.zeroStock,
    live.filter((i) => qty(i) === 0).length,
  );
  exact(
    'catalog',
    'items at or below reorder point',
    planned.atOrBelowReorder,
    live.filter((i) => qty(i) > 0 && qty(i) <= Number(i.reorder_point)).length,
  );

  // Orders WITH their lines: an order header whose lines never arrived (a seed
  // that died between the two statements and was not re-run) renders as an
  // empty order on a measured page, and a header count alone cannot see it.
  const orders = await fetchAll(() =>
    scope.select('order_requests', 'id, status, lines:order_request_lines(id)').order('id'),
  );
  const orderStatuses = tally(orders, (o) => o.status);
  if (orders.length === 0 && allowNoOrders) {
    check('catalog', 'order requests', `${TARGETS.orders} (or 0 with --allow-no-orders)`, 0, true);
  } else {
    exact('catalog', 'order requests', TARGETS.orders, orders.length);
    exact(
      'catalog',
      'order lines',
      planned.orderLines,
      orders.reduce((s, o) => s + (o.lines ?? []).length, 0),
    );
    exact(
      'catalog',
      'orders with no lines',
      0,
      orders.filter((o) => (o.lines ?? []).length === 0).length,
    );
    const show = (t) =>
      Object.entries(t)
        .sort()
        .map(([k, v]) => `${k} ${v}`);
    sameSet('catalog', 'orders per status', show(planned.orderStatuses), show(orderStatuses));
  }

  // ── Accounts and the role matrix ──────────────────────────────────────────
  const profiles = await findPerfLabProfiles(admin);
  const assignments = await must(
    scope.select('user_warehouse_assignments', 'user_id, warehouse_id'),
    'read assignments',
  );
  exact('accounts', 'Perf Lab accounts', TARGETS.accounts, profiles.size);
  // The auth-side truth about each account, read once: the stamp that says this
  // tool made it, and its MFA factors (checked further down, under "silence").
  const accountIds = [...profiles.values()].map((p) => p.id);
  let factors = 0;
  let stamped = 0;
  for (const id of accountIds) {
    const auth = await readAuthAccount(admin, id); // stops the run if the read fails
    factors += auth.factors;
    if (auth.stamped && isPerfLabAccountEmail(auth.email)) stamped++;
  }
  exact(
    'accounts',
    'accounts carrying the Perf Lab stamp (made by this tool)',
    TARGETS.accounts,
    stamped,
  );
  // People attached to the organization without being members of it (lib.mjs
  // readOrgOutsiders). Seed and teardown REFUSE on these; the census reports them.
  const outsiders = await readOrgOutsiders(admin, org);
  exact('accounts', 'pending invitations', 0, outsiders.pendingInvites);
  exact('accounts', 'customer-portal logins', 0, outsiders.portalLogins);
  exact('accounts', 'members of the organization', TARGETS.accounts, orgMembers.length);
  exact(
    'accounts',
    'members that are NOT one of the six Perf Lab accounts',
    0,
    orgMembers.filter((m) => !isPerfLabAccountEmail(m.email)).length,
  );
  const allCodes = warehouses.map((w) => w.code);
  const roleLines = [];
  for (const account of plan.accounts) {
    const profile = profiles.get(account.key);
    const member = profile && orgMembers.find((m) => m.user_id === profile.id);
    const held = member?.accepted_at
      ? member.role
      : member
        ? `${member.role} (not accepted)`
        : 'MISSING';
    check('accounts', `${account.key}: role`, account.role, held, held === account.role);
    if (!profile) continue;

    // Scoped roles see what their assignment ROWS say; manager and above see
    // everything by role and should hold no rows at all.
    const assigned = assignments
      .filter((a) => a.user_id === profile.id)
      .map((a) => codeById.get(a.warehouse_id));
    sameSet('accounts', `${account.key}: warehouse assignments`, account.warehouseCodes, assigned);
    if (member) {
      check(
        'accounts',
        `${account.key}: all_warehouses flag`,
        String(account.allWarehouses),
        String(member.all_warehouses),
        member.all_warehouses === account.allWarehouses,
      );
    }

    // And what the DATABASE answers, not what the rows imply:
    // user_can_access_warehouse() is the SQL gate (latest body: migration 0310).
    // If the gate cannot be called, that is a MISS, never a silent fallback.
    const expected = account.warehouseCodes.length === 0 ? allCodes : account.warehouseCodes;
    const readable = [];
    let gateError = null;
    for (const w of warehouses) {
      // { get: true }: PostgREST runs a GET rpc in a READ-ONLY transaction. If this
      // function ever tried to write, the database would refuse and the error
      // lands in the MISS branch below, instead of verify having written.
      const { data, error } = await admin.rpc(
        'user_can_access_warehouse',
        { p_user_id: profile.id, p_warehouse_id: w.id, p_op: 'read' },
        { get: true },
      );
      if (error) {
        gateError = error.code || error.message || 'error';
        break;
      }
      if (data === true) readable.push(w.code);
    }
    if (gateError) {
      check(
        'accounts',
        `${account.key}: can read (SQL gate)`,
        [...expected].sort().join(', '),
        `gate not callable: ${gateError}`,
        false,
      );
    } else {
      sameSet('accounts', `${account.key}: can read (SQL gate)`, expected, readable);
    }
    roleLines.push(
      `    ${account.key.padEnd(17)} role ${held.padEnd(8)} reads ${readable.sort().join(', ') || 'NOTHING'}${account.warehouseCodes.length === 0 ? '  (by role)' : '  (by assignment)'}`,
    );
  }

  // ── Nothing can reach these accounts ──────────────────────────────────────
  const ids = [...profiles.values()].map((p) => p.id);
  const prefs = ids.length
    ? await must(
        admin.from('notification_preferences').select('*').in('user_id', ids),
        'read preferences',
      )
    : [];
  exact('silence', 'accounts with a preferences row', TARGETS.accounts, prefs.length);
  exact(
    'silence',
    'notification/email preferences still ON',
    0,
    prefs.reduce((s, row) => s + Object.values(row).filter((v) => v === true).length, 0),
  );
  exact(
    'silence',
    'accounts opted in to the weekly digest',
    0,
    [...profiles.values()].filter((p) => p.email_digest_optin !== false).length,
  );
  const tokens = ids.length
    ? await exactCount(
        admin.from('push_tokens').select('id', { count: 'exact' }).in('user_id', ids),
        'count push tokens',
      )
    : 0;
  exact('silence', 'registered push tokens', 0, tokens);
  exact('silence', 'enrolled MFA factors', 0, factors);
  // scope.count() answers null ONLY when the table is absent on this target.
  // That is not a zero: the question could not be asked, so the check fails.
  for (const [table, label] of [
    ['notifications', 'notification rows in the organization'],
    ['schedule_events', 'schedule events (the reminder cron emails on these)'],
  ]) {
    const count = await scope.count(table);
    check(
      'silence',
      label,
      0,
      count === null ? 'table not readable on this target' : count,
      count === 0,
    );
  }

  // ── Nothing runs on its own ───────────────────────────────────────────────
  const modules = await must(
    scope.select('organization_modules', 'module_id, enabled'),
    'read modules',
  );
  sameSet(
    'automation',
    'modules switched ON',
    ENABLED_MODULE_IDS,
    modules.filter((m) => m.enabled).map((m) => m.module_id),
  );
  check(
    'automation',
    'all_modules_comp',
    'false',
    String(org.all_modules_comp),
    org.all_modules_comp === false,
  );
  check('automation', 'plan', 'free', org.plan, org.plan === 'free');
  check('automation', 'mfa_policy', 'optional', org.mfa_policy, org.mfa_policy === 'optional');

  // ── Report ────────────────────────────────────────────────────────────────
  const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 3)}...` : text);
  for (const c of checks) {
    c.target = clip(c.target, 30);
    c.achieved = clip(c.achieved, 30);
  }
  const w = {
    name: Math.max(...checks.map((c) => c.name.length)),
    target: Math.max(6, ...checks.map((c) => c.target.length)),
    achieved: Math.max(8, ...checks.map((c) => c.achieved.length)),
    tol: Math.max(9, ...checks.map((c) => c.tolerance.length)),
  };
  let heading = '';
  log(
    `\n  ${'check'.padEnd(w.name)}  ${'target'.padEnd(w.target)}  ${'achieved'.padEnd(w.achieved)}  ${'tolerance'.padEnd(w.tol)}  result`,
  );
  for (const c of checks) {
    if (c.group !== heading) {
      heading = c.group;
      log(heading);
    }
    log(
      `  ${c.name.padEnd(w.name)}  ${c.target.padEnd(w.target)}  ${c.achieved.padEnd(w.achieved)}  ${c.tolerance.padEnd(w.tol)}  ${c.pass ? 'ok' : 'MISS'}`,
    );
  }
  log('\n  accounts:');
  for (const line of roleLines) log(line);
  log(`\n  master formats          ${JSON.stringify(kinds)}`);
  log(`  master Cache-Control    ${JSON.stringify(masterCc)}`);
  log(`  thumbnail Cache-Control ${JSON.stringify(thumbCc)}`);
  log(`  thumbnail bytes max     ${kb(thumbBytes.length ? Math.max(...thumbBytes) : null)}`);
  log(`  order statuses          ${JSON.stringify(orderStatuses)}`);
  log(
    `  stored bytes            masters ${(masterBytes.reduce((s, b) => s + (b ?? 0), 0) / 1048576).toFixed(1)} MiB, thumbnails ${(thumbBytes.reduce((s, b) => s + (b ?? 0), 0) / 1048576).toFixed(1)} MiB`,
  );

  const misses = checks.filter((c) => !c.pass);
  if (misses.length > 0) {
    log(`\n${misses.length} of ${checks.length} checks MISSED their target.`);
    process.exit(1);
  }
  log(`\nAll ${checks.length} checks passed.`);
}

main().catch((err) => die(err?.message ?? String(err)));
