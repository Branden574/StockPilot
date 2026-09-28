#!/usr/bin/env node
/**
 * ONE FIXTURE, TWO ENGINES (F2 plan 3.6).
 *
 * packages/core/src/orders/readiness-parity-cases.json describes small orders
 * and the stock around them. This file is the ONE derivation of what those
 * cases mean, used by both engines:
 *
 *   caseFacts(case, n)   the facts order_readiness_facts returns for case n.
 *                        Core's parity test (readiness.parity.test.ts) feeds
 *                        them to assessOrderReadiness; pgTAP checks the real
 *                        function returns them.
 *   renderParitySql(fx)  the data block of supabase/tests/0377_order_readiness_facts.test.sql:
 *                        the rows to build, the facts to expect, and what the
 *                        FROZEN RPCs must do (each call rolled back).
 *
 * Usage:
 *   node scripts/gen-readiness-parity-sql.mjs          rewrite the block
 *   node scripts/gen-readiness-parity-sql.mjs --check  exit 1 if it is stale
 *
 * A vitest guard (packages/core/src/orders/readiness.parity.test.ts) fails
 * while the checked-in block differs from what this renders.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE_PATH = path.join(ROOT, 'packages/core/src/orders/readiness-parity-cases.json');
export const TEST_SQL_PATH = path.join(ROOT, 'supabase/tests/0377_order_readiness_facts.test.sql');

export const BEGIN_MARKER =
  '-- BEGIN GENERATED: scripts/gen-readiness-parity-sql.mjs from packages/core/src/orders/readiness-parity-cases.json. Do not edit by hand.';
export const END_MARKER = '-- END GENERATED';

/** Fixed ids of the parity org (namespace 0377a). */
export const PARITY = {
  org: '0377a000-0000-4000-8000-00000000000a',
  manager: '0377a000-0000-4000-8000-0000000000a1',
  home: '0377a000-0000-4000-8000-0000000000d1',
  other: '0377a000-0000-4000-8000-0000000000d2',
  observedAt: '2026-01-01T12:00:00.000Z',
};

const HEX2 = (n) => n.toString(16).padStart(2, '0');
const PAD12 = (n) => n.toString(16).padStart(12, '0');

/** Ids for case n (1-based): t 1 order, 2 holder order, 3 item, 4 line, 5 holder line. */
export function caseId(n, t, i = 0) {
  if (n < 1 || n > 255) throw new Error(`case number ${n} out of range`);
  return `0377a${HEX2(n)}${t}-0000-4000-8000-${PAD12(i)}`;
}

const TO_PICK = ['pending_approval', 'approved', 'pick_slip_generated', 'picking_in_progress', 'backordered'];
const PICKED = ['picking_complete', 'packing_slip_generated', 'staged_for_pickup', 'staged_for_delivery', 'in_transit'];

function phaseOf(status) {
  if (TO_PICK.includes(status)) return 'to_pick';
  if (PICKED.includes(status)) return 'picked';
  return 'closed';
}

const KINDS = ['rack', 'crate', 'site', 'unplaced', 'staging'];
const WAREHOUSES = ['home', 'other', 'org'];

function lineCreatedAt(k) {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, k)).toISOString();
}

function itemKeys(c) {
  return Object.keys(c.items);
}

function validate(c) {
  for (const [key, it] of Object.entries(c.items)) {
    for (const h of it.holdings ?? []) {
      if (!KINDS.includes(h[0]) || !WAREHOUSES.includes(h[1]) || !(h[2] > 0)) {
        throw new Error(`${c.id} item ${key}: bad holding ${JSON.stringify(h)}`);
      }
    }
  }
  for (const l of c.lines) {
    if (!(l.item in c.items)) throw new Error(`${c.id} line ${l.id}: unknown item ${l.item}`);
  }
}

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

/** The facts order_readiness_facts returns for case n, as the parity manager
 *  (an approver: pendingOthers is an object; the purchase_orders module is
 *  on, with no POs: inbound and drafts are empty). */
export function caseFacts(c, n) {
  validate(c);
  const keys = itemKeys(c);
  const itemId = (key) => caseId(n, 3, keys.indexOf(key) + 1);
  const items = keys.map((key) => {
    const it = c.items[key];
    const hs = it.holdings ?? [];
    const at = (pred) => round4(hs.filter(pred).reduce((s, h) => s + h[2], 0));
    const here = (h) => h[1] === 'home' || h[1] === 'org';
    const total = at(() => true);
    const hereStaging = at((h) => here(h) && h[0] === 'staging');
    return {
      itemId: itemId(key),
      visible: true,
      name: `Parity ${c.id} ${key}`,
      sku: `P-${c.id}-${key}`,
      supplierId: null,
      itemWarehouseId: it.moved ? PARITY.other : PARITY.home,
      deleted: Boolean(it.deleted),
      archived: false,
      isBundle: Boolean(it.bundle),
      onHand: it.onHand ?? total,
      heldOwn: it.holds?.own ?? 0,
      heldOtherOrders: it.holds?.otherOrder ?? 0,
      heldRentals: it.holds?.rental ?? 0,
      here: {
        rack: at((h) => here(h) && (h[0] === 'rack' || h[0] === 'crate')),
        site: at((h) => here(h) && h[0] === 'site'),
        unplaced: at((h) => here(h) && h[0] === 'unplaced'),
        staging: hereStaging,
      },
      elsewhere: {
        pickable: at((h) => !here(h) && h[0] !== 'staging'),
        staging: at((h) => !here(h) && h[0] === 'staging'),
      },
      // Location ids are the database's own; the assessment reads quantities only.
      stagingSources: hereStaging > 0 ? [{ locationId: 'staging-here', quantity: hereStaging }] : [],
      stagingHiddenQty: 0,
      pendingOthers: { orders: 0, units: 0 },
      committedOtherShortfall: 0,
      inbound: { rows: [], hiddenRemaining: 0, truncated: false, truncatedRemaining: 0 },
      drafts: { rows: [], hiddenRemaining: 0, truncated: false, truncatedRemaining: 0 },
    };
  });
  return {
    v: 1,
    observedAt: PARITY.observedAt,
    phase: phaseOf(c.status),
    linesCapped: false,
    order: {
      id: caseId(n, 1),
      orderNumber: n,
      status: c.status,
      warehouseId: PARITY.home,
      neededBy: null,
      fulfillmentType: 'pickup',
    },
    lines: c.lines.map((l, k) => ({
      lineId: caseId(n, 4, k + 1),
      itemId: itemId(l.item),
      requested: l.requested,
      fulfilled: l.fulfilled ?? 0,
      picked: l.picked ?? null,
      createdAt: lineCreatedAt(k + 1),
    })),
    items,
  };
}

/** The ids of case n's items and lines, by fixture key. */
export function caseKeyIds(c, n) {
  const keys = itemKeys(c);
  return {
    items: Object.fromEntries(keys.map((k, j) => [k, caseId(n, 3, j + 1)])),
    lines: Object.fromEntries(c.lines.map((l, k) => [l.id, caseId(n, 4, k + 1)])),
  };
}

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const num = (x) => (x === null || x === undefined ? 'null' : String(x));
const js = (o) => (o === null || o === undefined ? 'null' : `${lit(JSON.stringify(o))}::jsonb`);

/** What each frozen RPC must answer for a case, keyed by the database ids. */
function expectations(c, n) {
  const e = c.expect ?? {};
  const ids = caseKeyIds(c, n);
  const holds = (m) =>
    Object.fromEntries(itemKeys(c).map((k) => [ids.items[k], m?.[k] ?? 0]));
  const approve =
    e.approveSucceeds === undefined
      ? null
      : e.approveSucceeds
        ? { ok: true }
        : { error: e.approveError ?? 'insufficient_stock' };
  const approvePartial = e.approvePartialError
    ? { error: e.approvePartialError }
    : e.approvePartialHolds
      ? { holds: holds(e.approvePartialHolds) }
      : null;
  const resume = e.resumeError ? { error: e.resumeError } : e.resumeHolds ? { holds: holds(e.resumeHolds) } : null;
  let complete = null;
  if (e.completeFails === true) complete = { error: e.completeError ?? 'insufficient_placed_stock' };
  else if (e.projectedPicked) {
    complete = {
      picked: Object.fromEntries(c.lines.map((l) => [ids.lines[l.id], e.projectedPicked[l.id] ?? 0])),
    };
  }
  return { approve, approvePartial, resume, complete };
}

/** The subset of each item's facts pgTAP compares with the real answer. */
export function comparedItemFacts(f) {
  return {
    onHand: f.onHand,
    heldOwn: f.heldOwn,
    heldOtherOrders: f.heldOtherOrders,
    heldRentals: f.heldRentals,
    here: f.here,
    elsewhere: f.elsewhere,
    stagingHiddenQty: f.stagingHiddenQty,
    stagingSourcesTotal: round4(f.stagingSources.reduce((s, x) => s + x.quantity, 0)),
    committedOtherShortfall: f.committedOtherShortfall,
    pendingOthers: f.pendingOthers,
    inbound: f.inbound,
    drafts: f.drafts,
    deleted: f.deleted,
    isBundle: f.isBundle,
    itemWarehouseId: f.itemWarehouseId,
    visible: f.visible,
  };
}

export function renderParitySql(fixture) {
  const cases = fixture.cases;
  const seen = new Set();
  const rows = { case: [], item: [], holding: [], hold: [], line: [], facts: [], expect: [] };
  cases.forEach((c, i) => {
    const n = i + 1;
    if (seen.has(c.id)) throw new Error(`duplicate case id ${c.id}`);
    seen.add(c.id);
    const facts = caseFacts(c, n);
    const ids = caseKeyIds(c, n);
    rows.case.push(`(${n}, ${lit(c.id)}, ${lit(c.status)}, ${lit(caseId(n, 1))}, ${lit(caseId(n, 2))})`);
    for (const [key, it] of Object.entries(c.items)) {
      const f = facts.items.find((x) => x.itemId === ids.items[key]);
      rows.item.push(
        `(${n}, ${lit(key)}, ${lit(ids.items[key])}, ${lit(f.name)}, ${lit(f.sku)}, ${num(f.onHand)}, ${lit(it.moved ? 'other' : 'home')}, ${it.deleted ? 'true' : 'false'}, ${it.bundle ? 'true' : 'false'})`,
      );
      for (const h of it.holdings ?? []) {
        rows.holding.push(`(${lit(ids.items[key])}, ${lit(h[0])}, ${lit(h[1])}, ${num(h[2])})`);
      }
      for (const holder of ['own', 'otherOrder', 'rental']) {
        const q = it.holds?.[holder];
        if (q) rows.hold.push(`(${n}, ${lit(ids.items[key])}, ${lit(holder)}, ${num(q)})`);
      }
      rows.facts.push(`(${n}, ${lit(key)}, ${lit(ids.items[key])}, ${js(comparedItemFacts(f))})`);
    }
    c.lines.forEach((l, k) => {
      rows.line.push(
        `(${n}, ${lit(l.id)}, ${lit(ids.lines[l.id])}, ${lit(ids.items[l.item])}, ${num(l.requested)}, ${num(l.fulfilled ?? 0)}, ${num(l.picked ?? null)}, ${lit(lineCreatedAt(k + 1))})`,
      );
    });
    const e = expectations(c, n);
    rows.expect.push(
      `(${n}, ${lit(facts.phase)}, ${js(facts.lines.map(({ createdAt: _c, ...rest }) => rest))}, ${js(e.approve)}, ${js(e.approvePartial)}, ${js(e.resume)}, ${js(e.complete)})`,
    );
  });
  const block = (table, cols, list) =>
    list.length === 0 ? '' : `insert into ${table} (${cols}) values\n  ${list.join(',\n  ')};\n`;
  return [
    BEGIN_MARKER,
    `-- ${cases.length} cases: ${cases.map((c) => c.id).join(', ')}.`,
    block('rp_case', 'case_no, case_id, status, order_id, holder_id', rows.case),
    block('rp_item', 'case_no, item_key, item_id, name, sku, on_hand, item_wh, deleted, is_bundle', rows.item),
    block('rp_holding', 'item_id, kind, wh, qty', rows.holding),
    block('rp_hold', 'case_no, item_id, holder, qty', rows.hold),
    block('rp_line', 'case_no, line_key, line_id, item_id, requested, fulfilled, picked, created_at', rows.line),
    block('rp_expect_item', 'case_no, item_key, item_id, facts', rows.facts),
    block(
      'rp_expect',
      'case_no, phase, lines, approve, approve_partial, resume, complete',
      rows.expect,
    ),
    END_MARKER,
  ].join('\n');
}

export function loadFixture() {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
}

/** The block as checked in (markers included), or null when absent. */
export function checkedInBlock(sql) {
  const start = sql.indexOf(BEGIN_MARKER);
  const end = sql.indexOf(END_MARKER, start);
  if (start < 0 || end < 0) return null;
  return sql.slice(start, end + END_MARKER.length);
}

function main() {
  const check = process.argv.includes('--check');
  const sql = readFileSync(TEST_SQL_PATH, 'utf8');
  const current = checkedInBlock(sql);
  if (current === null) {
    console.error(`markers not found in ${TEST_SQL_PATH}`);
    process.exit(2);
  }
  const next = renderParitySql(loadFixture());
  if (current === next) {
    console.log('readiness parity block is up to date');
    return;
  }
  if (check) {
    console.error('readiness parity block is stale: run node scripts/gen-readiness-parity-sql.mjs');
    process.exit(1);
  }
  writeFileSync(TEST_SQL_PATH, sql.replace(current, () => next));
  console.log('readiness parity block rewritten');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
