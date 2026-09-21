/**
 * The Perf Lab dataset, as a PLAN: what exists, in what proportions, with which
 * bytes. Pure and deterministic (no I/O, no clock, no Math.random), so
 *
 *   - seed.mjs can build it, diff it against the database, and create only what
 *     is missing (that diff is what makes the seed idempotent and resumable);
 *   - `--dry-run` can count what WOULD be created without generating an image;
 *   - verify.mjs checks the live organization against the same TARGETS the
 *     plan was built from, so "target" means one thing in both scripts.
 *
 * FROZEN: `DATASET_VERSION` is part of every PRNG seed. Changing any knob that
 * alters the plan or the image bytes must bump it, because a "before" run and
 * an "after" run are only comparable when they loaded the same dataset.
 */
import { ACCOUNT_KEYS, createRng, perfLabEmail } from './lib.mjs';

export const DATASET_VERSION = 'perf-lab-dataset-v2';

/**
 * Anchor for every seeded timestamp (order history). A constant, not `now()`:
 * the dataset must not drift depending on the day it was seeded.
 */
const DATASET_EPOCH_MS = Date.UTC(2026, 8, 18, 16, 0, 0);

// ── The measured distribution being reproduced ─────────────────────────────
// Two read-only production censuses of the customer's 443 item photos, counts
// only (stockpilot-perf-artifacts/): v1 of 2026-09-18 (sizes, served headers)
// and v2 of 2026-09-20 (what each file REALLY is, by magic bytes).
//
//   master, by served Content-Type   358 jpeg / 83 webp / 1 png / 1 unreadable
//   master bytes                     p50 310 KB, p95 612 KB, max 5797 KB
//   master > 2048 px                 7
//   master Cache-Control             286 max-age=3600 / 103 no-cache / 53 max-age=604800
//   thumbnails                       437, ALL <= 200 px, every one named -thumb.webp
//   thumbnail Cache-Control          301 max-age=3600 / 136 no-cache
//   no thumbnail                     6;   no LQIP 307 (so LQIP on 136)
//
// WHO WROTE EACH ROW (v2). v1 showed a heavy thumbnail tail (p95 75 KB) that a
// 200 px WebP cannot reach, and dataset v1 reproduced it by bytes without knowing
// the cause. The cause is now established: WebKit (Safari) cannot ENCODE WebP.
// Asked for image/webp by canvas.toBlob or OffscreenCanvas.convertToBlob, it
// returns image/png, on both of the uploader's code paths. So a Safari upload
// stores a PNG thumbnail under the -thumb.webp name with the Content-Type the
// uploader sends (image/webp), a data:image/png placeholder, and, because the
// PNG "WebP master" is never smaller than a JPEG source, the ORIGINAL file as the
// master, uncapped. Every thumbnail of 30 KB or more in production is one of
// those. Three writers, by exact count:
//
//   backfill       301  WebP thumb, max-age=3600, no placeholder. Rows uploaded
//                       with no thumbnail, given one later by
//                       backfill-item-thumbs.mjs (a 200x200 cover transform).
//   webp-browser    69  WebP thumb, no-cache, data:image/webp placeholder.
//                       Master: 65 WebP / 4 JPEG, p50 39 KB, p95 691, max 967.
//   webkit          67  PNG thumb (p50 71 KB, p95 84, max 99), no-cache,
//                       data:image/png placeholder. Master: the original upload,
//                       64 JPEG / 3 PNG by magic bytes, p50 276 KB, p95 4981,
//                       max 5797; 4 of the 7 masters over 2048 px are here.
//   no-thumb         6  no thumbnail, no placeholder.
//
// WHERE v1's TARGETS AND v2 CANNOT BOTH HOLD, v2 WINS, and it is said here:
//   - "1 PNG master" (v1, by Content-Type) and "3 PNG masters in the webkit class"
//     (v2, by magic bytes) are both true only if two PNG files are served under
//     another type. The uploader produces exactly that: a PNG SOURCE whose WebKit
//     re-encode comes out smaller is stored as PNG bytes in a .webp file typed
//     image/webp. So: 358 / 84 / 1 by Content-Type, 358 / 82 / 3 by magic bytes,
//     and exactly 2 masters whose type disagrees with their bytes. That reading
//     is INFERRED from the two counts; no census observed those two files.
//   - "2-3 multi-MB outliers" (the owner's brief) becomes 4: the webkit class p95
//     is 4981 KB of 67, so its top four masters are each about 5 MB or more.
//   - "every master between 1200 and 2048 px" (the brief) cannot hold for the
//     webp-browser class: a 39 KB median WebP is a small IMAGE, not a compressed
//     large one (v1 found 117 masters of 800 px or less). That class takes the
//     long side its bytes imply; the other classes keep the brief's rule, except
//     the one 401-800 px master v2 counted in the webkit class.
//
// NOT IN EITHER CENSUS, so assigned and labelled as such: how master
// Cache-Control splits across writers. Only a browser PUT stores no-cache, so all
// 103 no-cache masters are placed in the two browser classes (51 webkit + 52
// webp-browser, in proportion), their other 33 masters get max-age=3600, and the
// backfill and no-thumb rows share the remaining 254 max-age=3600 and all 53
// max-age=604800.
export const PHOTO_COUNT = 443;
const KB = 1024;

export const WRITERS = Object.freeze(['backfill', 'webp-browser', 'webkit', 'no-thumb']);

export const QUOTAS = Object.freeze({
  writers: Object.freeze({ backfill: 301, 'webp-browser': 69, webkit: 67, 'no-thumb': 6 }),
  // Masters by SERVED Content-Type (what census v1 tallied)...
  jpeg: 358,
  webp: 84,
  png: 1,
  // ...and by MAGIC BYTES (census v2). Two PNG files are typed image/webp.
  magic: Object.freeze({ jpeg: 358, webp: 82, png: 3 }),
  typeDisagreesWithBytes: 2,
  oversize: 7, // long side > 2048 px: 4 webkit originals + 3 backfill-class uploads
  belowBriefMinimum: null, // masters under 1200 px; derived from the plan, see planSummary()
  thumbMissing: 6,
  thumbPng: 67,
  thumbWebp: 370,
  lqipPresent: 136, // 69 data:image/webp + 67 data:image/png
  lqipWebp: 69,
  lqipPng: 67,
  masterCache: Object.freeze({ 'max-age=3600': 287, 'no-cache': 103, 'max-age=604800': 53 }),
  thumbCacheNoCache: 136, // of the 437 thumbnails; the rest are max-age=3600
  books: 40,
});

/** How each writer's masters are typed and cached. Counts, so they can be checked as counts. */
const CLASS_MASTER_CACHE = Object.freeze({
  webkit: { 'no-cache': 51, 'max-age=3600': 16 },
  'webp-browser': { 'no-cache': 52, 'max-age=3600': 17 },
  // backfill + no-thumb together (307 rows)
  rest: { 'max-age=3600': 254, 'max-age=604800': 53 },
});

/**
 * MASTER BYTES. Stratified, not sampled: within a class, item k of n gets the
 * (k + 0.5)/n quantile of a log-normal, so the achieved percentiles are the
 * designed ones rather than a lucky or unlucky draw. Each class is shaped to its
 * own census percentiles, and buildPlan() then CHECKS that the union lands on the
 * overall p50 310 KB / p95 612 KB, and throws if a later edit breaks that.
 */
const WEBKIT_HUGE = Object.freeze([
  // The class p95 (rank 64 of 67) is 4981 KB and its max 5797 KB: four originals
  // straight off a 12 MP phone. These are 4 of the 7 masters over 2048 px.
  { w: 4000, h: 3000, bytes: 4981 * KB },
  { w: 4032, h: 3024, bytes: 5250 * KB },
  { w: 3024, h: 4032, bytes: 5520 * KB },
  { w: 4032, h: 3024, bytes: 5797 * KB },
]);
/** The three PNG-by-magic masters of the webkit class. Lossless, so large for their size. */
const WEBKIT_PNG = Object.freeze([
  // An original PNG upload kept as it was: typed image/png, the ONE png by Content-Type.
  { w: 1200, h: 1200, bytes: 1400 * KB, ext: 'png', contentType: 'image/png' },
  // PNG sources whose WebKit re-encode was smaller: PNG bytes, .webp name, image/webp type.
  { w: 1280, h: 960, bytes: 1180 * KB, ext: 'webp', contentType: 'image/webp' },
  { w: 960, h: 1280, bytes: 1120 * KB, ext: 'webp', contentType: 'image/webp' },
]);
const WEBKIT_ORDINARY = Object.freeze({ count: 60, medianBytes: 261 * KB, logSigma: 0.375 });
/** v2: the webkit class holds 3 masters of 1601-2048 px and 1 of 401-800 px besides the 4 huge ones. */
const WEBKIT_LONG_SIDE_QUOTA = Object.freeze({ 1920: 2, 2048: 1, 800: 1 });
/** Thumbnail pixel count decides how heavy a PNG it can be, so the aspect mix of this class is a quota. */
const WEBKIT_ASPECT_QUOTA = Object.freeze({ square: 2, threeTwo: 5, landscape: 35, portrait: 18 });

/** The three backfill-class uploads over 2048 px (the other 3 of the 7). */
const REST_OVERSIZE = Object.freeze([
  { w: 3264, h: 2448, bytes: 1600 * KB },
  { w: 2448, h: 3264, bytes: 1300 * KB },
  { w: 2592, h: 1944, bytes: 1100 * KB },
]);
const REST_WEBP = 17; // 84 typed image/webp - 65 (webp-browser) - 2 (webkit PNG-as-webp)
/**
 * backfill + no-thumb ordinary masters. No census describes this class on its
 * own, so its median and sigma are the two free numbers, chosen by a grid search
 * so that the UNION of all classes lands on the overall p50 310 KB / p95 612 KB
 * (340 KB / 0.30 gives 310 / 613). assertPlanMatchesCensus() holds them there.
 */
const REST_ORDINARY = Object.freeze({ medianBytes: 340 * KB, logSigma: 0.3 });
const MASTER_MIN_BYTES = 115 * KB;
const MASTER_MAX_ORDINARY_BYTES = 1000 * KB;

/** webp-browser: 65 small WebP masters and 4 JPEG originals kept because their WebP came out larger. */
const WEBP_BROWSER_JPEG_TOP = Object.freeze([691 * KB, 780 * KB, 870 * KB, 967 * KB]);
const WEBP_BROWSER_BODY = Object.freeze({
  count: 65,
  medianBytes: 36.5 * KB,
  logSigma: 0.85,
  minBytes: 16 * KB,
});
/** Long sides a small web image comes in. The class picks the one its byte target implies (about 1 bit per pixel). */
const SMALL_LONG_SIDES = [400, 480, 640, 800, 1024, 1280, 1600];

/** Long side of an ordinary master, weighted. 1600 dominates, as phone "large" exports do. */
const LONG_SIDES = [
  [1200, 12],
  [1280, 12],
  [1440, 12],
  [1536, 12],
  [1600, 32],
  [1920, 8],
  [2048, 12],
];
/** [long : short] aspect, weighted: landscape 4:3, portrait 3:4, square, 3:2. */
const ASPECTS = [
  [{ ratio: 3 / 4, portrait: false }, 55],
  [{ ratio: 3 / 4, portrait: true }, 25],
  [{ ratio: 1, portrait: false }, 12],
  [{ ratio: 2 / 3, portrait: false }, 8],
];

/**
 * PNG THUMBNAIL BYTES (webkit class). Census v2: p50 71 KB, p95 84 KB, max 99 KB,
 * and the overall thumbnail p95 of 75 KB is rank 46 of these 67.
 *
 * MEASURED on this generator before choosing anything: with NO extra grain, a
 * 200 px PNG of one of these masters already weighs 54-73 KB at 4:3 (median 68),
 * about 60 KB at 3:2 and 82-94 KB when square, because the surface texture that
 * makes a WebP thumbnail 7 KB is nearly incompressible to PNG. That is the
 * census shape without help: a 4:3 population centred near 70 KB with a few
 * squares on top. So the curve below (rank -> KB, linear between knots) is
 * followed only ABOVE each file's natural weight, by adding grain at thumbnail
 * scale; a file whose natural weight is already above its target stays as it is.
 * Ranks go by thumbnail pixel count, and the class has exactly three square
 * thumbnails so that ranks 65-67 (89, 94, 99 KB) are files that can weigh that.
 * The file is a real PNG, sized the way the uploader sizes it (long side 200,
 * aspect kept). What is synthetic is only how noisy the heavier ones are.
 */
const PNG_THUMB_KNOTS = [
  [0, 60],
  [33, 71],
  [45, 75],
  [63, 84],
  [66, 99],
];

/**
 * What verify.mjs holds the stored organization to.
 *
 * COUNTS ARE EXACT. Every count below is fixed by the plan (a seeded shuffle
 * assigns exactly 67 webkit rows, exactly 136 placeholders, ...), so there is
 * nothing for a tolerance to absorb. Only BYTES carry a tolerance, because a
 * file's size is searched toward a target rather than set.
 */
const THUMBS = PHOTO_COUNT - QUOTAS.thumbMissing;
export const TARGETS = Object.freeze({
  photos: PHOTO_COUNT,
  items: PHOTO_COUNT,
  books: QUOTAS.books,
  warehouses: 2,
  productCategories: 8,
  orders: 60,
  accounts: ACCOUNT_KEYS.length,
  writers: QUOTAS.writers,
  masterJpeg: QUOTAS.jpeg,
  masterWebp: QUOTAS.webp,
  masterPng: QUOTAS.png,
  masterMagic: QUOTAS.magic,
  masterTypeDisagrees: QUOTAS.typeDisagreesWithBytes,
  masterOver2048: QUOTAS.oversize,
  masterOver2048Webkit: WEBKIT_HUGE.length,
  // The four webkit originals above 2 MiB. Nothing else in the plan is.
  masterMultiMb: WEBKIT_HUGE.length,
  masterLongSideMin: 1200,
  thumbs: THUMBS,
  thumbMissing: QUOTAS.thumbMissing,
  thumbMaxLongSide: 200,
  thumbPng: QUOTAS.thumbPng,
  thumbWebp: QUOTAS.thumbWebp,
  lqipPresent: QUOTAS.lqipPresent,
  lqipWebp: QUOTAS.lqipWebp,
  lqipPng: QUOTAS.lqipPng,
  masterCache: QUOTAS.masterCache,
  thumbCache: Object.freeze({
    'max-age=3600': THUMBS - QUOTAS.thumbCacheNoCache,
    'no-cache': QUOTAS.thumbCacheNoCache,
  }),
  // Overall (census v1).
  masterP5Bytes: null, // designed, not measured; filled from the plan by planSummary()
  masterP50Bytes: 310 * KB,
  masterP95Bytes: 612 * KB,
  masterMaxBytes: 5797 * KB,
  thumbP50Bytes: 8 * KB,
  thumbP95Bytes: 75 * KB,
  // Per writer (census v2).
  webkitMasterP50Bytes: 276 * KB,
  webkitMasterP95Bytes: 4981 * KB,
  webpBrowserMasterP50Bytes: 39 * KB,
  webpBrowserMasterP95Bytes: 691 * KB,
  webpBrowserMasterMaxBytes: 967 * KB,
  thumbWebpP50Bytes: 8 * KB,
  thumbWebpMaxBytes: 17 * KB,
  thumbPngP50Bytes: 71 * KB,
  thumbPngP95Bytes: 84 * KB,
  thumbPngMaxBytes: 99 * KB,
});

/** The customer census the quotas came from, as shares, for the report. */
export const CENSUS_SHARES = Object.freeze({
  masterJpeg: 0.81,
  masterWebp: 0.19,
  lqipPresent: 0.31,
  masterCache: { 'max-age=3600': 0.65, 'no-cache': 0.23, 'max-age=604800': 0.12 },
  thumbCache: { 'max-age=3600': 0.69, 'no-cache': 0.31 },
});

/** How far a BYTE percentile may sit from its target before verify.mjs exits non-zero. */
export const TOLERANCES = Object.freeze({
  masterP5Rel: 0.12,
  masterP50Rel: 0.1,
  masterP95Rel: 0.12,
  masterMaxRel: 0.1,
  classMasterRel: 0.12,
  // Small files are dominated by what the drawing itself costs, which the search cannot go under.
  smallMasterRel: 0.25,
  thumbP50Rel: 0.35, // the ordinary thumbnail's bytes are an OUTPUT of the app's own encoder settings
  thumbP95Rel: 0.15,
  thumbPngRel: 0.1,
  thumbWebpMaxRel: 0.6, // census max 17 KB; nothing here depends on it, it is reported for shape
});

// ── Modules ────────────────────────────────────────────────────────────────
/**
 * Owner rule: a seeded organization must not start automation. So this is an
 * EXPLICIT desired state for every module row seed_org_modules() writes
 * (latest body: migration 0314), not "whatever the trigger left on".
 *
 * ON, and why (the pages the harness measures, tests/perf/scenarios.ts):
 *   core modules   /dashboard, /dashboard/inventory, /dashboard/inventory/[id].
 *                  Core modules cannot be switched off; their rows stay true.
 *   books          /dashboard/books (checkModuleAccess('books')).
 *   orders         /dashboard/orders, /dashboard/orders/[id], and the
 *                  storefront /dashboard/orders/new. The storefront itself has
 *                  no module gate of its own (it checks orders:request), but
 *                  the sidebar entry and OrderRequestsService are gated on
 *                  'orders', and nothing else: it reads inventory_items,
 *                  item_images, stock_reservations and warehouse_charters.
 *
 * OFF, and why:
 *   ai               the daily-briefing cron selects every org whose 'ai' row
 *                    is enabled, calls the AI provider and writes notifications
 *                    to owners and admins. seed_org_modules() turns it ON by
 *                    default, so leaving it alone WOULD start a machine.
 *   purchase_orders  gate of the auto-reorder and recurring-pos crons (both
 *                    also need settings the seed never writes, and a paid
 *                    plan). receiving and po_imports depend on it.
 *   schedule         schedule-reminders is the one cron that EMAILS members;
 *                    it keys on schedule_events rows, which only appear through
 *                    this module (and through approving an order in the app).
 *   rentals          rental-overdue emails borrowers of overdue rentals.
 *   returns          return-prompt emails after a signed delivery.
 *   public_requests  faces outsiders (public request links).
 *   bundles, cycle_counts, procedures, suppliers
 *                    no background job, but no measured page needs them; off
 *                    keeps "what is on" equal to "what is measured". The
 *                    suppliers TABLE is still seeded, items still carry a
 *                    supplier_id; only the Suppliers screen is off.
 *   planning, lot_serial, price_tracking, live_tracking, zendesk, sports,
 *   maintenance_requests
 *                    already OFF by default; pinned off here so a future change
 *                    to the trigger cannot switch them on for this org.
 *
 * `organizations.all_modules_comp` stays FALSE: since migration 0354 a comp
 * wins over an explicit enabled = false for ACCESS, which would hand the
 * accounts every screen this list deliberately leaves out.
 */
export const MODULES = Object.freeze([
  ['overview', 'core', true],
  ['inventory', 'core', true],
  ['movements', 'core', true],
  ['categories', 'core', true],
  ['locations', 'core', true],
  ['reports', 'core', true],
  ['notifications', 'core', true],
  ['team', 'core', true],
  ['settings', 'core', true],
  ['admin_tools', 'core', true],
  ['charters', 'core', true],
  ['scan', 'core', true],
  ['books', 'optional', true],
  ['orders', 'optional', true],
  ['rentals', 'optional', false],
  ['bundles', 'optional', false],
  ['cycle_counts', 'optional', false],
  ['procedures', 'optional', false],
  ['purchase_orders', 'optional', false],
  ['receiving', 'optional', false],
  ['po_imports', 'optional', false],
  ['suppliers', 'optional', false],
  ['schedule', 'optional', false],
  ['ai', 'optional', false],
  ['public_requests', 'optional', false],
  ['returns', 'optional', false],
  ['planning', 'optional', false],
  ['lot_serial', 'premium', false],
  ['price_tracking', 'optional', false],
  ['live_tracking', 'optional', false],
  ['zendesk', 'optional', false],
  ['sports', 'premium', false],
  ['maintenance_requests', 'optional', false],
]);
export const ENABLED_MODULE_IDS = MODULES.filter(([, , on]) => on).map(([id]) => id);

// ── Accounts ───────────────────────────────────────────────────────────────
const ACCOUNT_ROLE = {
  owner: 'owner',
  admin: 'admin',
  manager: 'manager',
  staff: 'staff',
  viewer: 'viewer',
  'staff-restricted': 'staff',
};
const ACCOUNT_LABEL = {
  owner: 'Perf Lab Owner',
  admin: 'Perf Lab Admin',
  manager: 'Perf Lab Manager',
  staff: 'Perf Lab Staff',
  viewer: 'Perf Lab Viewer',
  'staff-restricted': 'Perf Lab Staff (North only)',
};

// ── Catalog vocabulary ─────────────────────────────────────────────────────
const WAREHOUSES = [
  {
    code: 'PLN',
    name: 'Perf Lab North DC',
    share: 0.8,
    racks: ['10-A', '10-B', '11-A', '11-B', '12-A', '12-B'],
    site: 'North DC Floor',
  },
  {
    code: 'PLS',
    name: 'Perf Lab South DC',
    share: 0.2,
    racks: ['20-A', '20-B', '21-A'],
    site: 'South DC Floor',
  },
];
/** The warehouse `staff-restricted` may see. The larger one, so the restricted role is measured at realistic volume. */
export const RESTRICTED_WAREHOUSE_CODE = 'PLN';

const PRODUCT_CATEGORIES = [
  {
    name: 'Apparel',
    color: '#6366f1',
    nouns: ['Crew Tee', 'Polo Shirt', 'Zip Hoodie', 'Rain Jacket', 'Knit Beanie', 'Work Apron'],
    variants: ['S', 'M', 'L', 'XL', 'Youth M'],
  },
  {
    name: 'Electronics',
    color: '#0ea5e9',
    nouns: ['USB-C Hub', 'Wireless Mouse', 'Headset', 'Webcam', 'Tablet Case', 'Charging Cart'],
    variants: ['Black', 'Grey', 'White', '2-pack'],
  },
  {
    name: 'Office Supplies',
    color: '#f97316',
    nouns: ['Stapler', 'Binder', 'Sticky Notes', 'Gel Pens', 'Laminating Pouches', 'Label Tape'],
    variants: ['Blue', 'Red', 'Assorted', 'Box of 12'],
  },
  {
    name: 'Classroom',
    color: '#10b981',
    nouns: [
      'Whiteboard Set',
      'Math Manipulatives',
      'Art Easel',
      'Globe',
      'Flash Cards',
      'Reading Rug',
    ],
    variants: ['Small', 'Large', 'Class Set'],
  },
  {
    name: 'Furniture',
    color: '#a855f7',
    nouns: ['Stack Chair', 'Folding Table', 'Book Cart', 'Storage Cubby', 'Standing Desk', 'Stool'],
    variants: ['Oak', 'Maple', 'Grey', 'Navy'],
  },
  {
    name: 'Janitorial',
    color: '#14b8a6',
    nouns: [
      'Floor Cleaner',
      'Paper Towels',
      'Trash Liners',
      'Hand Soap',
      'Microfiber Cloths',
      'Mop Head',
    ],
    variants: ['1 gal', 'Case', '6-pack'],
  },
  {
    name: 'Athletics',
    color: '#ef4444',
    nouns: [
      'Soccer Ball',
      'Cone Set',
      'Jump Rope',
      'Practice Jersey',
      'Ball Pump',
      'Agility Ladder',
    ],
    variants: ['Size 4', 'Size 5', 'Red', 'Blue'],
  },
  {
    name: 'Kitchen',
    color: '#eab308',
    nouns: [
      'Sheet Pan',
      'Food Container',
      'Serving Tongs',
      'Cutting Board',
      'Insulated Carrier',
      'Portion Scoop',
    ],
    variants: ['Half', 'Full', '4 qt', '8 qt'],
  },
];
const BOOK_CATEGORY = { name: 'Books', color: '#64748b' };
const ADJECTIVES = [
  'Heavy-Duty',
  'Compact',
  'Classic',
  'Premium',
  'Everyday',
  'Pro',
  'Eco',
  'Deluxe',
  'Standard',
  'Flex',
];
const SUPPLIERS = [
  'Northfield Supply Co.',
  'Harbor Educational',
  'Summit Wholesale',
  'Cedar & Pine Furnishings',
  'Brightline Books',
];
const BOOK_ADJ = [
  'Silent',
  'Hidden',
  'Last',
  'Golden',
  'Distant',
  'Paper',
  'Winter',
  'Wandering',
  'Bright',
  'Forgotten',
];
const BOOK_NOUN = [
  'River',
  'Orchard',
  'Lighthouse',
  'Atlas',
  'Garden',
  'Compass',
  'Harbor',
  'Meadow',
  'Lantern',
  'Bridge',
];
const AUTHORS = [
  'A. Moreno',
  'J. Whitfield',
  'S. Okafor',
  'L. Tran',
  'M. Castellanos',
  'R. Bennett',
  'K. Nakamura',
  'D. Alvarez',
];
const GRADES = ['K-2', '3-5', '6-8', '9-12'];

/** Order statuses seeded, with counts. 60 in total. See README for why two statuses are absent. */
const ORDER_STATUS_COUNTS = [
  ['pending_approval', 12],
  ['approved', 5],
  ['pick_slip_generated', 3],
  ['picking_in_progress', 4],
  ['picking_complete', 3],
  ['packing_slip_generated', 2],
  ['staged_for_pickup', 4],
  ['backordered', 3],
  ['completed', 17],
  ['denied', 3],
  ['cancelled', 4],
];

// Acklam's rational approximation of the inverse normal CDF. Accurate to about
// 1e-9 over (0, 1), far beyond what spacing file sizes needs.
function probit(p) {
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716,
    2.506628277459239,
  ];
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972,
    -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > 1 - lo) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** `count` true flags spread over `total` slots, order decided by the stream. */
function flags(rng, total, count) {
  const slots = Array.from({ length: total }, (_, i) => i < count);
  return rng.shuffle(slots);
}

/** Stratified log-normal byte targets, ascending. */
function lognormalTargets(count, medianBytes, logSigma, lo, hi) {
  return Array.from({ length: count }, (_, k) =>
    Math.round(clamp(medianBytes * Math.exp(logSigma * probit((k + 0.5) / count)), lo, hi)),
  );
}

/** Thumbnail size the uploader's fitWithin() gives: long side 200, aspect kept, never enlarged. */
function thumbSize(width, height) {
  const long = Math.max(width, height);
  if (long <= 200) return { w: width, h: height };
  return width >= height
    ? { w: 200, h: Math.round((height * 200) / width) }
    : { w: Math.round((width * 200) / height), h: 200 };
}

function frame(long, ratio, portrait) {
  const short = even(long * ratio);
  return portrait ? { width: short, height: long } : { width: long, height: short };
}

/** Piecewise-linear value at `rank` through [rank, value] knots. */
function alongKnots(knots, rank) {
  for (let k = 1; k < knots.length; k++) {
    const [r0, v0] = knots[k - 1];
    const [r1, v1] = knots[k];
    if (rank <= r1) return v0 + ((rank - r0) / (r1 - r0)) * (v1 - v0);
  }
  return knots[knots.length - 1][1];
}

/**
 * Hands ascending byte targets to frames in order of a JITTERED pixel count: a
 * 1000 KB target on a 1200x900 frame would need more grain than any camera
 * produces, and real photos are bigger when they have more pixels. Strongly, not
 * perfectly, correlated. The SET of byte values, and so every percentile, is
 * unchanged by who gets which.
 */
function dealBySize(indices, frames, sortedTargets, label) {
  const score = new Map(
    indices.map((i) => {
      const f = frames.get(i);
      const jitter = Math.exp(0.3 * createRng(DATASET_VERSION, label, i).normal());
      return [i, f.width * f.height * jitter];
    }),
  );
  return new Map(
    [...indices].sort((x, y) => score.get(x) - score.get(y)).map((i, k) => [i, sortedTargets[k]]),
  );
}

/**
 * The photo half of the plan: for each of the 443 items, which writer made its
 * row and exactly which files that writer would have stored. Every count is a
 * quota dealt out by a seeded shuffle, so the ACHIEVED counts equal the quotas;
 * only bytes (searched to a target) carry any tolerance.
 */
function planPhotos() {
  const rng = createRng(DATASET_VERSION, 'photo-quotas');
  const n = PHOTO_COUNT;
  const order = rng.shuffle(Array.from({ length: n }, (_, i) => i));
  let cursor = 0;
  const take = (count) => order.slice(cursor, (cursor += count));
  const webkit = take(QUOTAS.writers.webkit);
  const webpBrowser = take(QUOTAS.writers['webp-browser']);
  const noThumb = take(QUOTAS.writers['no-thumb']);
  const backfill = take(QUOTAS.writers.backfill);
  const master = new Map(); // index -> what the master file is

  // ── webkit: the ORIGINAL upload, uncapped ─────────────────────────────────
  const wkHuge = webkit.slice(0, WEBKIT_HUGE.length);
  const wkPng = webkit.slice(wkHuge.length, wkHuge.length + WEBKIT_PNG.length);
  const wkOrdinary = webkit.slice(wkHuge.length + wkPng.length);
  wkHuge.forEach((i, k) => {
    const h = WEBKIT_HUGE[k];
    master.set(i, {
      format: 'jpeg',
      ext: 'jpg',
      contentType: 'image/jpeg',
      width: h.w,
      height: h.h,
      targetBytes: h.bytes,
    });
  });
  wkPng.forEach((i, k) => {
    const g = WEBKIT_PNG[k];
    master.set(i, {
      format: 'png',
      ext: g.ext,
      contentType: g.contentType,
      width: g.w,
      height: g.h,
      targetBytes: g.bytes,
    });
  });
  {
    const longs = rng.shuffle([
      ...Object.entries(WEBKIT_LONG_SIDE_QUOTA).flatMap(([long, count]) =>
        Array(count).fill(Number(long)),
      ),
      ...Array.from(
        {
          length:
            wkOrdinary.length - Object.values(WEBKIT_LONG_SIDE_QUOTA).reduce((x, y) => x + y, 0),
        },
        () => rng.weighted(LONG_SIDES.filter(([long]) => long <= 1600)),
      ),
    ]);
    const aspects = rng.shuffle([
      ...Array(WEBKIT_ASPECT_QUOTA.square).fill({ ratio: 1, portrait: false }),
      ...Array(WEBKIT_ASPECT_QUOTA.threeTwo).fill({ ratio: 2 / 3, portrait: false }),
      ...Array(WEBKIT_ASPECT_QUOTA.landscape).fill({ ratio: 3 / 4, portrait: false }),
      ...Array(WEBKIT_ASPECT_QUOTA.portrait).fill({ ratio: 3 / 4, portrait: true }),
    ]);
    const frames = new Map(
      wkOrdinary.map((i, k) => [i, frame(longs[k], aspects[k].ratio, aspects[k].portrait)]),
    );
    const targets = lognormalTargets(
      wkOrdinary.length,
      WEBKIT_ORDINARY.medianBytes,
      WEBKIT_ORDINARY.logSigma,
      MASTER_MIN_BYTES,
      MASTER_MAX_ORDINARY_BYTES,
    );
    const dealt = dealBySize(wkOrdinary, frames, targets, 'webkit-deal');
    for (const i of wkOrdinary) {
      master.set(i, {
        format: 'jpeg',
        ext: 'jpg',
        contentType: 'image/jpeg',
        ...frames.get(i),
        targetBytes: dealt.get(i),
      });
    }
  }

  // ── webp-browser: small WebP masters, plus 4 JPEG originals kept ──────────
  {
    const body = lognormalTargets(
      WEBP_BROWSER_BODY.count,
      WEBP_BROWSER_BODY.medianBytes,
      WEBP_BROWSER_BODY.logSigma,
      WEBP_BROWSER_BODY.minBytes,
      MASTER_MAX_ORDINARY_BYTES,
    );
    webpBrowser.forEach((i, k) => {
      const own = createRng(DATASET_VERSION, 'webp-browser-frame', i);
      const aspect = own.weighted(ASPECTS);
      if (k < body.length) {
        // The long side a file this light implies, at about one bit per pixel.
        const pixels = (body[k] * 8) / 1.0;
        const ideal = Math.sqrt(pixels / aspect.ratio);
        const long = SMALL_LONG_SIDES.reduce((best, c) =>
          Math.abs(c - ideal) < Math.abs(best - ideal) ? c : best,
        );
        master.set(i, {
          format: 'webp',
          ext: 'webp',
          contentType: 'image/webp',
          ...frame(long, aspect.ratio, aspect.portrait),
          targetBytes: body[k],
        });
      } else {
        const long = own.pick([1600, 1920, 2048]);
        master.set(i, {
          format: 'jpeg',
          ext: 'jpg',
          contentType: 'image/jpeg',
          ...frame(long, aspect.ratio, aspect.portrait),
          targetBytes: WEBP_BROWSER_JPEG_TOP[k - body.length],
        });
      }
    });
  }

  // ── backfill + no-thumb: everything that was uploaded without a thumbnail ─
  {
    const rest = [...noThumb, ...backfill];
    const restOversize = backfill.slice(0, REST_OVERSIZE.length);
    const restWebp = new Set(
      backfill.slice(REST_OVERSIZE.length, REST_OVERSIZE.length + REST_WEBP),
    );
    restOversize.forEach((i, k) => {
      const o = REST_OVERSIZE[k];
      master.set(i, {
        format: 'jpeg',
        ext: 'jpg',
        contentType: 'image/jpeg',
        width: o.w,
        height: o.h,
        targetBytes: o.bytes,
      });
    });
    const ordinary = rest.filter((i) => !master.has(i));
    const frames = new Map(
      ordinary.map((i) => {
        const own = createRng(DATASET_VERSION, 'photo-dims', i);
        const aspect = own.weighted(ASPECTS);
        return [i, frame(own.weighted(LONG_SIDES), aspect.ratio, aspect.portrait)];
      }),
    );
    const targets = lognormalTargets(
      ordinary.length,
      REST_ORDINARY.medianBytes,
      REST_ORDINARY.logSigma,
      MASTER_MIN_BYTES,
      MASTER_MAX_ORDINARY_BYTES,
    );
    const dealt = dealBySize(ordinary, frames, targets, 'rest-deal');
    for (const i of ordinary) {
      const webp = restWebp.has(i);
      master.set(i, {
        format: webp ? 'webp' : 'jpeg',
        ext: webp ? 'webp' : 'jpg',
        contentType: webp ? 'image/webp' : 'image/jpeg',
        ...frames.get(i),
        targetBytes: dealt.get(i),
      });
    }
  }

  // ── master Cache-Control, per writer (see the header: this split is assigned) ─
  const masterCache = new Map();
  const dealLabels = (indices, quota) => {
    const labels = rng.shuffle(
      Object.entries(quota).flatMap(([label, count]) => Array(count).fill(label)),
    );
    if (labels.length !== indices.length)
      throw new Error('dataset: a Cache-Control quota does not cover its class');
    indices.forEach((i, k) => masterCache.set(i, labels[k]));
  };
  dealLabels(webkit, CLASS_MASTER_CACHE.webkit);
  dealLabels(webpBrowser, CLASS_MASTER_CACHE['webp-browser']);
  dealLabels([...noThumb, ...backfill], CLASS_MASTER_CACHE.rest);

  // ── PNG thumbnail byte targets: heavier targets to thumbnails with more pixels ─
  const thumbPixels = (i) => {
    const t = thumbSize(master.get(i).width, master.get(i).height);
    return t.w * t.h;
  };
  const pngThumbTarget = new Map(
    [...webkit]
      .sort((x, y) => thumbPixels(x) - thumbPixels(y) || x - y)
      .map((i, rank) => [i, Math.round(alongKnots(PNG_THUMB_KNOTS, rank) * KB)]),
  );

  const writerOf = new Map([
    ...webkit.map((i) => [i, 'webkit']),
    ...webpBrowser.map((i) => [i, 'webp-browser']),
    ...noThumb.map((i) => [i, 'no-thumb']),
    ...backfill.map((i) => [i, 'backfill']),
  ]);
  return Array.from({ length: n }, (_, i) => {
    const own = createRng(DATASET_VERSION, 'photo', i);
    const writer = writerOf.get(i);
    const hasThumb = writer !== 'no-thumb';
    return {
      writer,
      ...master.get(i),
      // A phone or an export dialog picks the JPEG quality, not the grain; the
      // grain is what the generator searches to land on `targetBytes`.
      jpegQuality: own.int(80, 92),
      cacheControl: masterCache.get(i),
      hasThumb,
      // What the thumbnail file IS. All three are stored as <uuid>-thumb.webp and
      // served as image/webp, because that is the name and the type every writer uses.
      //   webp-cover   backfill-item-thumbs.mjs: a 200x200 cover transform, WebP
      //   webp-inside  the uploader in a browser that can encode WebP
      //   png-inside   the uploader in WebKit: asked for WebP, got PNG
      thumbKind: {
        backfill: 'webp-cover',
        'webp-browser': 'webp-inside',
        webkit: 'png-inside',
        'no-thumb': null,
      }[writer],
      thumbTargetBytes: writer === 'webkit' ? pngThumbTarget.get(i) : null,
      thumbCacheControl: {
        backfill: 'max-age=3600',
        'webp-browser': 'no-cache',
        webkit: 'no-cache',
        'no-thumb': null,
      }[writer],
      // The placeholder is made by the same canvas call as the thumbnail, so it has the same fate.
      lqipKind: { backfill: null, 'webp-browser': 'webp', webkit: 'png', 'no-thumb': null }[writer],
      // Deterministic object name: a re-run after a crash writes the same path.
      fileUuid: own.uuid(),
      hue: own.int(0, 359),
      shape: own.pick(['box', 'bottle', 'tube', 'crate']),
    };
  });
}

/** Nearest-rank percentile, the census definition (lib.mjs has the same one for stored bytes). */
function planPercentile(values, p) {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/**
 * The plan checks ITSELF against the census before anything is generated. Every
 * class is shaped separately, so the overall percentiles are a consequence, not
 * an input, and an edit to one class can quietly move them. Throws, so neither a
 * seed nor a fingerprint can run on a plan that no longer matches its targets.
 */
function assertPlanMatchesCensus(photos) {
  const problems = [];
  const expectCount = (what, got, want) => {
    if (got !== want) problems.push(`${what}: ${got}, expected ${want}`);
  };
  const expectBytes = (what, got, want, rel) => {
    if (Math.abs(got - want) > want * rel)
      problems.push(`${what}: ${Math.round(got / KB)} KB, expected ${Math.round(want / KB)} KB`);
  };
  const count = (f) => photos.filter(f).length;
  for (const w of WRITERS)
    expectCount(
      `writer ${w}`,
      count((p) => p.writer === w),
      QUOTAS.writers[w],
    );
  for (const t of ['jpeg', 'webp', 'png']) {
    expectCount(
      `typed image/${t}`,
      count((p) => p.contentType === `image/${t}`),
      QUOTAS[t],
    );
    expectCount(
      `${t} by magic bytes`,
      count((p) => p.format === t),
      QUOTAS.magic[t],
    );
  }
  expectCount(
    'type disagrees with bytes',
    count((p) => p.contentType !== `image/${p.format}`),
    QUOTAS.typeDisagreesWithBytes,
  );
  expectCount(
    'over 2048 px',
    count((p) => Math.max(p.width, p.height) > 2048),
    QUOTAS.oversize,
  );
  for (const [label, want] of Object.entries(QUOTAS.masterCache))
    expectCount(
      `master ${label}`,
      count((p) => p.cacheControl === label),
      want,
    );
  expectCount(
    'thumbnail no-cache',
    count((p) => p.thumbCacheControl === 'no-cache'),
    QUOTAS.thumbCacheNoCache,
  );
  expectCount(
    'placeholders',
    count((p) => p.lqipKind),
    QUOTAS.lqipPresent,
  );
  const all = photos.map((p) => p.targetBytes);
  const of = (w) => photos.filter((p) => p.writer === w).map((p) => p.targetBytes);
  expectBytes('overall master p50', planPercentile(all, 50), TARGETS.masterP50Bytes, 0.03);
  expectBytes('overall master p95', planPercentile(all, 95), TARGETS.masterP95Bytes, 0.03);
  expectBytes('overall master max', Math.max(...all), TARGETS.masterMaxBytes, 0.001);
  expectBytes(
    'webkit master p50',
    planPercentile(of('webkit'), 50),
    TARGETS.webkitMasterP50Bytes,
    0.03,
  );
  expectBytes(
    'webkit master p95',
    planPercentile(of('webkit'), 95),
    TARGETS.webkitMasterP95Bytes,
    0.001,
  );
  expectBytes(
    'webp-browser master p50',
    planPercentile(of('webp-browser'), 50),
    TARGETS.webpBrowserMasterP50Bytes,
    0.05,
  );
  expectBytes(
    'webp-browser master p95',
    planPercentile(of('webp-browser'), 95),
    TARGETS.webpBrowserMasterP95Bytes,
    0.001,
  );
  const png = photos.filter((p) => p.thumbTargetBytes).map((p) => p.thumbTargetBytes);
  expectBytes('PNG thumbnail p50', planPercentile(png, 50), TARGETS.thumbPngP50Bytes, 0.01);
  expectBytes('PNG thumbnail p95', planPercentile(png, 95), TARGETS.thumbPngP95Bytes, 0.01);
  if (problems.length > 0)
    throw new Error(
      `dataset.mjs: the plan no longer matches the census:\n  ${problems.join('\n  ')}`,
    );
}

function planItems(photos) {
  const rng = createRng(DATASET_VERSION, 'items');
  const n = PHOTO_COUNT;
  const bookFlags = flags(rng, n, QUOTAS.books);
  // Stock shape: 8% out of stock, 17% at or below their reorder point, the rest healthy.
  const stockKinds = rng.shuffle(
    Array.from({ length: n }, (_, i) =>
      i < Math.round(n * 0.08) ? 'zero' : i < Math.round(n * 0.25) ? 'low' : 'ok',
    ),
  );
  const items = [];
  const usedNames = new Set();
  for (let i = 0; i < n; i++) {
    const own = createRng(DATASET_VERSION, 'item', i);
    const sku = `PERF-${String(i + 1).padStart(4, '0')}`;
    const warehouse = own.next() < WAREHOUSES[0].share ? WAREHOUSES[0] : WAREHOUSES[1];
    const rack = own.pick(warehouse.racks);
    const isBook = bookFlags[i];
    const reorderPoint = own.pick([5, 10, 12, 20, 25, 40]);
    const quantity =
      stockKinds[i] === 'zero'
        ? 0
        : stockKinds[i] === 'low'
          ? own.int(1, reorderPoint)
          : own.int(reorderPoint + 5, reorderPoint * 12);

    let name;
    let category;
    let customFields = {};
    let barcode = null;
    let unitCost;
    let retailPrice;
    if (isBook) {
      category = BOOK_CATEGORY.name;
      for (let attempt = 0; ; attempt++) {
        name = `The ${own.pick(BOOK_ADJ)} ${own.pick(BOOK_NOUN)}${attempt > 2 ? `, Vol. ${attempt - 1}` : ''}`;
        if (!usedNames.has(name)) break;
      }
      // ISBN-13 shaped (978 + 10 digits); synthetic, resolves to no real title.
      barcode = `978${String(1000000000 + i * 7919).slice(-10)}`;
      customFields = {
        author: own.pick(AUTHORS),
        publisher: 'Perf Lab Press',
        book_grade: own.pick(GRADES),
      };
      unitCost = own.int(6, 22) + 0.5;
      retailPrice = 0;
    } else {
      const cat = own.pick(PRODUCT_CATEGORIES);
      category = cat.name;
      for (let attempt = 0; ; attempt++) {
        name = `${own.pick(ADJECTIVES)} ${own.pick(cat.nouns)} - ${own.pick(cat.variants)}${attempt > 3 ? ` (${sku.slice(-3)})` : ''}`;
        if (!usedNames.has(name)) break;
      }
      unitCost = own.int(2, 180) + own.pick([0, 0.25, 0.5, 0.99]);
      retailPrice = Math.round(unitCost * own.range(1.3, 2.2) * 100) / 100;
    }
    usedNames.add(name);
    items.push({
      index: i,
      sku,
      name,
      barcode,
      itemType: isBook ? 'book' : 'product',
      category,
      supplier: isBook ? SUPPLIERS[4] : own.pick(SUPPLIERS.slice(0, 4)),
      warehouseCode: warehouse.code,
      rack,
      quantity,
      reorderPoint,
      reorderQuantity: reorderPoint * 3,
      unitCost,
      retailPrice,
      customFields,
      photo: photos[i],
    });
  }
  return items;
}

/**
 * ~60 order requests across statuses. All `pickup`: a delivery order needs a
 * charter (order_requests_delivery_target_chk, migration 0254), and the seed
 * creates no charters because inventory_items.charter_id is ON DELETE RESTRICT,
 * which would complicate the one-organization teardown for no measured benefit.
 * That is why `staged_for_delivery` and `in_transit` are absent.
 *
 * `order_number` is set explicitly (1..60): assign_order_request_number()
 * passes an explicit number through, and it doubles as the idempotency key.
 */
function planOrders(items) {
  const rng = createRng(DATASET_VERSION, 'orders');
  const statuses = rng.shuffle(
    ORDER_STATUS_COUNTS.flatMap(([status, count]) => Array(count).fill(status)),
  );
  const byWarehouse = new Map(
    WAREHOUSES.map((w) => [w.code, items.filter((it) => it.warehouseCode === w.code)]),
  );
  const requesters = ['staff', 'staff', 'manager', 'staff-restricted', 'admin'];
  return statuses.map((status, k) => {
    const own = createRng(DATASET_VERSION, 'order', k);
    // The restricted account only ever orders from the warehouse it can see.
    const requester = own.pick(requesters);
    const warehouseCode =
      requester === 'staff-restricted'
        ? RESTRICTED_WAREHOUSE_CODE
        : own.next() < 0.8
          ? 'PLN'
          : 'PLS';
    const pool = byWarehouse.get(warehouseCode);
    const lineCount = own.int(1, 6);
    const chosen = own.shuffle(pool).slice(0, lineCount);
    // Spread over the 75 days before the epoch, newest first by order number.
    const createdMs =
      DATASET_EPOCH_MS -
      Math.round(((statuses.length - k) / statuses.length) * 75 * 86400000) -
      own.int(0, 6 * 3600000);
    const created = new Date(createdMs).toISOString();
    const later = (hours) => new Date(createdMs + hours * 3600000).toISOString();
    const pastApproval =
      !['pending_approval', 'denied'].includes(status) &&
      !(status === 'cancelled' && own.next() < 0.5);
    const done = status === 'completed';
    return {
      orderNumber: k + 1,
      status,
      requester,
      warehouseCode,
      notes: own.pick([
        null,
        null,
        'Needed for Monday.',
        'Leave at the front office.',
        'Replacement for damaged stock.',
      ]),
      createdAt: created,
      updatedAt: later(done ? 72 : pastApproval ? 20 : 1),
      approvedAt: pastApproval ? later(6) : null,
      completedAt: done ? later(72) : null,
      cancelledAt: status === 'cancelled' ? later(10) : null,
      deniedReason: status === 'denied' ? 'Out of budget for this period.' : null,
      lines: chosen.map((it) => {
        const qty = own.int(1, 12);
        return {
          sku: it.sku,
          quantityRequested: qty,
          quantityFulfilled: done ? qty : 0,
          unitCost: it.unitCost,
          createdAt: created,
        };
      }),
    };
  });
}

let cachedPlan = null;
/** The whole plan. Built once per process; identical on every machine and every day. */
export function buildPlan() {
  if (cachedPlan) return cachedPlan;
  const photos = planPhotos();
  assertPlanMatchesCensus(photos);
  const items = planItems(photos);
  cachedPlan = Object.freeze({
    version: DATASET_VERSION,
    warehouses: WAREHOUSES,
    categories: [...PRODUCT_CATEGORIES.map(({ name, color }) => ({ name, color })), BOOK_CATEGORY],
    suppliers: SUPPLIERS,
    accounts: ACCOUNT_KEYS.map((key) => ({
      key,
      email: perfLabEmail(key),
      role: ACCOUNT_ROLE[key],
      fullName: ACCOUNT_LABEL[key],
      // staff and viewer are warehouse-SCOPED roles (lib/auth/warehouse.ts):
      // without assignment rows they see nothing. The two ordinary ones get
      // every warehouse; `staff-restricted` gets exactly one. Manager and above
      // have all warehouses by role and need no rows.
      warehouseCodes:
        key === 'staff-restricted'
          ? [RESTRICTED_WAREHOUSE_CODE]
          : key === 'staff' || key === 'viewer'
            ? WAREHOUSES.map((w) => w.code)
            : [],
      allWarehouses: key === 'staff' || key === 'viewer',
    })),
    items,
    orders: planOrders(items),
  });
  return cachedPlan;
}

/** Counts derived from the plan, for `--dry-run` and for the README's numbers. */
export function planSummary(plan = buildPlan()) {
  const photos = plan.items.map((it) => it.photo);
  const tally = (list, f) => list.reduce((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});
  const withThumb = photos.filter((p) => p.hasThumb);
  return {
    items: plan.items.length,
    books: plan.items.filter((it) => it.itemType === 'book').length,
    zeroStock: plan.items.filter((it) => it.quantity === 0).length,
    atOrBelowReorder: plan.items.filter((it) => it.quantity > 0 && it.quantity <= it.reorderPoint)
      .length,
    byWarehouse: tally(plan.items, (it) => it.warehouseCode),
    masters: photos.length,
    writers: tally(photos, (p) => p.writer),
    masterFormats: tally(photos, (p) => p.format),
    masterTypes: tally(photos, (p) => p.contentType),
    masterOver2048: photos.filter((p) => Math.max(p.width, p.height) > 2048).length,
    // Masters under the brief's 1200 px floor: the small web images of the
    // webp-browser class and the one 401-800 px webkit original (see the header).
    masterBelow1200: photos.filter((p) => Math.max(p.width, p.height) < 1200).length,
    masterBelow1200OutsideBrowserClasses: photos.filter(
      (p) =>
        Math.max(p.width, p.height) < 1200 && (p.writer === 'backfill' || p.writer === 'no-thumb'),
    ).length,
    masterP5Bytes: planPercentile(
      photos.map((p) => p.targetBytes),
      5,
    ),
    masterCache: tally(photos, (p) => p.cacheControl),
    thumbs: withThumb.length,
    thumbKinds: tally(withThumb, (p) => p.thumbKind),
    thumbCache: tally(withThumb, (p) => p.thumbCacheControl),
    lqip: photos.filter((p) => p.lqipKind).length,
    lqipKinds: tally(
      photos.filter((p) => p.lqipKind),
      (p) => p.lqipKind,
    ),
    plannedMasterBytes: photos.reduce((s, p) => s + p.targetBytes, 0),
    plannedPngThumbBytes: photos.reduce((s, p) => s + (p.thumbTargetBytes ?? 0), 0),
    orders: plan.orders.length,
    orderLines: plan.orders.reduce((s, o) => s + o.lines.length, 0),
    orderStatuses: tally(plan.orders, (o) => o.status),
  };
}
