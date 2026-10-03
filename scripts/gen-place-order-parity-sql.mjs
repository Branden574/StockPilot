#!/usr/bin/env node
/**
 * ONE FIXTURE, TWO ENGINES (phone ordering plan 3.2 step 3, graft 3).
 *
 * packages/core/src/orders/place-order-parity-cases.json lists create bodies
 * and what each engine must answer for their shape. This file is the ONE
 * expansion of those cases, used by both engines:
 *
 *   caseBody(fx, c, n)     the create body of case n (camelCase, as a client
 *                          sends it). Core's parity test
 *                          (place-order.parity.test.ts) reads it with
 *                          parseOrderCreateRequest and checks `core`.
 *   caseSqlRequest(fx, c, n)
 *                          the p_request the service builds from that body
 *                          (snake_case), plus the case's `sqlPatch`.
 *   caseSqlKey(fx, c, n)   the p_key: the body's key, or the case's `sqlKey`.
 *   renderPlaceOrderParitySql(fx)
 *                          the data block of the M1 pgTAP file
 *                          (supabase/tests/<M1>_place_order_request.test.sql,
 *                          added in PO-2): one row per case the database can
 *                          see, with what place_order_request must answer.
 *
 * Usage:
 *   node scripts/gen-place-order-parity-sql.mjs          rewrite the block in
 *                                                        the M1 pgTAP file (or,
 *                                                        before PO-2 adds it,
 *                                                        print the block)
 *   node scripts/gen-place-order-parity-sql.mjs --check  exit 1 if the block is
 *                                                        stale, 2 if the file or
 *                                                        its markers are wrong;
 *                                                        before PO-2, validate
 *                                                        and render only
 *
 * The M1 file is found by name (`*_place_order_request.test.sql`), because its
 * number is taken when it is pushed (plan section 1). A vitest guard in core
 * (place-order.parity.test.ts) also fails while the block is stale.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE_PATH = path.join(
  ROOT,
  'packages/core/src/orders/place-order-parity-cases.json',
);
export const PGTAP_DIR = path.join(ROOT, 'supabase/tests');
export const CONSUMER_SUFFIX = '_place_order_request.test.sql';

export const BEGIN_MARKER =
  '-- BEGIN GENERATED: scripts/gen-place-order-parity-sql.mjs from packages/core/src/orders/place-order-parity-cases.json. Do not edit by hand.';
export const END_MARKER = '-- END GENERATED';

const CORE_REASONS = [
  'invalid',
  'too_many_lines',
  'too_many_units',
  'quantity_not_whole',
  'notes_too_long',
  'on_behalf_invalid',
  'delivery_needs_site',
  'needed_by_invalid_time',
];
const SQL_HINTS = {
  22023: [
    'order_invalid',
    'delivery_needs_site',
    'idempotency_key_required',
    'idempotency_key_invalid',
  ],
  42501: ['placer_mismatch'],
};
/** The fields an order_invalid refusal may name (its detail). Core's
 *  orderShapeRefusalFromSql answers each one. */
export const SQL_FIELDS = [
  'lines',
  'quantity',
  'total',
  'notes',
  'on_behalf',
  'needed_by',
  'surface',
  'fulfillment_type',
  'warehouse',
  'site',
];

export function loadFixture() {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
}

const PAD12 = (n) => n.toString(16).padStart(12, '0');

/** Item k's id. */
export function itemId(fx, k) {
  if (!Number.isInteger(k) || k < 1) throw new Error(`item ${k} is not a positive whole number`);
  return `${fx.ids.itemPrefix}${PAD12(k)}`;
}

/** Case n's key (1-based). */
export function caseKey(fx, n) {
  return `${fx.ids.keyPrefix}${PAD12(n)}`;
}

/** A fixture value as the body holds it: placeholders, repeats and lines. */
function expand(fx, value) {
  if (value === '$site') return fx.ids.site;
  if (value === '$bundle') return fx.ids.bundle;
  if (value === '$other') return fx.ids.other;
  if (Array.isArray(value)) return value.map((v) => expand(fx, v));
  if (value && typeof value === 'object') {
    if ('$repeat' in value) {
      return `${value.prefix ?? ''}${String(value.$repeat).repeat(value.times)}${value.suffix ?? ''}`;
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(fx, v)]));
  }
  return value;
}

function expandLines(fx, lines) {
  if (lines && !Array.isArray(lines) && typeof lines === 'object' && 'repeat' in lines) {
    // n distinct items, or n lines of one item when `item` is given.
    return Array.from({ length: lines.repeat }, (_, i) => ({
      itemId: itemId(fx, 'item' in lines ? lines.item : i + 1),
      quantity: lines.quantity,
    }));
  }
  if (!Array.isArray(lines)) return expand(fx, lines);
  return lines.map((l) => {
    if (!l || typeof l !== 'object' || !('item' in l)) return expand(fx, l);
    const { item, ...rest } = l;
    return { itemId: itemId(fx, item), ...expand(fx, rest) };
  });
}

/** The create body of case n (1-based), as a client sends it. */
export function caseBody(fx, c, n) {
  const out = {
    idempotencyKey: caseKey(fx, n),
    placerUserId: fx.ids.placer,
    warehouseId: fx.ids.warehouse,
  };
  const patched = { ...fx.base, ...(c.body ?? {}) };
  for (const [k, v] of Object.entries(patched)) {
    if (v === '$delete') {
      delete out[k];
      continue;
    }
    out[k] = k === 'lines' ? expandLines(fx, v) : expand(fx, v);
  }
  return out;
}

/** The p_request the service builds from case n's body (plan 3.2), plus the
 *  case's sqlPatch. Values pass through as the body holds them, so the
 *  database's own trimming and checks are what is tested. */
export function caseSqlRequest(fx, c, n) {
  const b = caseBody(fx, c, n);
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const req = {
    organization_id: fx.ids.org,
    placer_user_id: has('placerUserId') ? b.placerUserId : null,
    surface: 'app',
    warehouse_id: has('warehouseId') ? b.warehouseId : null,
    fulfillment_type: has('fulfillmentType') ? b.fulfillmentType : null,
    delivery_charter_id: b.deliveryCharterId ?? null,
    on_behalf_name: b.onBehalfOf?.name ?? null,
    on_behalf_email: b.onBehalfOf?.email ?? null,
    notes: b.notes ?? null,
    // The parity organization is in UTC: the instant is the wall clock with Z.
    needed_by: typeof b.neededByLocal === 'string' ? `${b.neededByLocal}:00Z` : null,
    lines: Array.isArray(b.lines)
      ? b.lines.map((l) => ({ item_id: l?.itemId ?? null, quantity: l?.quantity ?? null }))
      : (b.lines ?? null),
  };
  return { ...req, ...expand(fx, c.sqlPatch ?? {}) };
}

/** Case n's p_key. */
export function caseSqlKey(fx, c, n) {
  if (Object.prototype.hasOwnProperty.call(c, 'sqlKey')) return c.sqlKey;
  const b = caseBody(fx, c, n);
  return b.idempotencyKey ?? null;
}

/** Throws on a fixture that does not say what each engine must answer. */
export function validateFixture(fx) {
  const seen = new Set();
  if (!Array.isArray(fx.cases) || fx.cases.length === 0) throw new Error('no cases');
  fx.cases.forEach((c, i) => {
    const where = `${c.id ?? `case ${i + 1}`}`;
    if (typeof c.id !== 'string' || c.id === '') throw new Error(`case ${i + 1} has no id`);
    if (seen.has(c.id)) throw new Error(`duplicate case id ${c.id}`);
    seen.add(c.id);
    if (typeof c.title !== 'string' || c.title === '') throw new Error(`${where} has no title`);
    if (c.core !== 'accept') {
      if (!c.core || !CORE_REASONS.includes(c.core.reason))
        throw new Error(`${where}: core must be "accept" or a known reason`);
      if (c.core.reason === 'invalid' && typeof c.core.field !== 'string')
        throw new Error(`${where}: an invalid refusal names its field`);
    }
    if (c.sql !== 'accept' && c.sql !== 'unreachable') {
      const hints = c.sql && SQL_HINTS[c.sql.sqlstate];
      if (!hints || !hints.includes(c.sql.hint))
        throw new Error(
          `${where}: sql must be "accept", "unreachable" or a known sqlstate and hint`,
        );
      if (c.sql.hint === 'order_invalid' && !SQL_FIELDS.includes(c.sql.field))
        throw new Error(`${where}: order_invalid names a known field`);
    }
    if (c.sql === 'unreachable' && c.core === 'accept') {
      throw new Error(
        `${where}: a body core accepts reaches the database, so it cannot be unreachable`,
      );
    }
    caseBody(fx, c, i + 1);
  });
}

const lit = (s) => (s === null || s === undefined ? 'null' : `'${String(s).replace(/'/g, "''")}'`);

/** JSON text with every character outside printable ASCII as a \uXXXX escape
 *  (a surrogate pair as two). jsonb reads it back to the same value, and no
 *  invisible character (a no-break space, a line separator) sits in the .sql
 *  file where an editor could change it. */
const asciiJson = (v) =>
  JSON.stringify(v).replace(
    /[^\x20-\x7e]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

/** The data block of the M1 pgTAP file, markers included. */
export function renderPlaceOrderParitySql(fx) {
  validateFixture(fx);
  const rows = [];
  const skipped = [];
  fx.cases.forEach((c, i) => {
    const n = i + 1;
    if (c.sql === 'unreachable') {
      skipped.push(c.id);
      return;
    }
    const req = asciiJson(caseSqlRequest(fx, c, n));
    const accept = c.sql === 'accept';
    rows.push(
      `(${n}, ${lit(c.id)}, ${lit(req)}::jsonb, ${lit(caseSqlKey(fx, c, n))}, ${accept ? 'null' : lit(c.sql.sqlstate)}, ${accept ? 'null' : lit(c.sql.hint)}, ${accept ? 'null' : lit(c.sql.field ?? null)})`,
    );
  });
  return [
    BEGIN_MARKER,
    `-- ${rows.length} cases the database sees (${fx.cases.length} in the fixture; core alone checks ${skipped.length === 0 ? 'none' : skipped.join(', ')}).`,
    `-- Accepted (expect_sqlstate null): place_order_request gets past step 3 (no 22023). Refused: it raises exactly expect_sqlstate with hint expect_hint (and, for order_invalid, detail expect_field), writing nothing.`,
    `-- placer_user_id is the parity placer (${fx.ids.placer}); the pgTAP file signs in as that member of the parity organization (${fx.ids.org}).`,
    `insert into pop_case (case_no, case_id, request, p_key, expect_sqlstate, expect_hint, expect_field) values\n  ${rows.join(',\n  ')};`,
    END_MARKER,
  ].join('\n');
}

/** The block as checked in (markers included), or null when absent. */
export function checkedInBlock(sql) {
  const start = sql.indexOf(BEGIN_MARKER);
  const stop = start < 0 ? -1 : sql.indexOf(END_MARKER, start);
  if (start < 0 || stop < 0) return null;
  return sql.slice(start, stop + END_MARKER.length);
}

/** The M1 pgTAP files (PO-2 adds exactly one), by name. */
export function consumerFiles() {
  return readdirSync(PGTAP_DIR)
    .filter((f) => f.endsWith(CONSUMER_SUFFIX))
    .map((f) => path.join(PGTAP_DIR, f));
}

function main() {
  const check = process.argv.includes('--check');
  const fx = loadFixture();
  let next;
  try {
    next = renderPlaceOrderParitySql(fx);
  } catch (e) {
    console.error(`place-order parity fixture: ${e.message}`);
    process.exit(2);
  }
  const files = consumerFiles();
  if (files.length > 1) {
    console.error(
      `more than one ${CONSUMER_SUFFIX}: ${files.map((f) => path.basename(f)).join(', ')}`,
    );
    process.exit(2);
  }
  if (files.length === 0) {
    const counted = fx.cases.length;
    if (check) {
      console.log(
        `place-order parity fixture is valid (${counted} cases); no *${CONSUMER_SUFFIX} yet (PO-2 adds it)`,
      );
      return;
    }
    console.log(
      `No *${CONSUMER_SUFFIX} yet (PO-2 adds it). Put this block, markers included, in that file:\n`,
    );
    console.log(next);
    return;
  }
  const file = files[0];
  const sql = readFileSync(file, 'utf8');
  const current = checkedInBlock(sql);
  if (current === null) {
    console.error(`markers not found in ${path.relative(ROOT, file)}`);
    process.exit(2);
  }
  if (current === next) {
    console.log('place-order parity block is up to date');
    return;
  }
  if (check) {
    console.error(
      'place-order parity block is stale: run node scripts/gen-place-order-parity-sql.mjs',
    );
    process.exit(1);
  }
  writeFileSync(
    file,
    sql.replace(current, () => next),
  );
  console.log('place-order parity block rewritten');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
