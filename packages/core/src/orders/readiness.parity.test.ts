/**
 * ONE FIXTURE, TWO ENGINES (F2 plan 3.6), the core side.
 *
 * readiness-parity-cases.json is run by BOTH engines:
 *   - here, core (assessOrderReadiness, readinessStockFlags,
 *     projectCompletePicking) on the facts the generator derives for each
 *     case;
 *   - in pgTAP (supabase/tests/0377_order_readiness_facts.test.sql, section P),
 *     the real order_readiness_facts, which must return those same facts, and
 *     the FROZEN RPCs, which must do what `expect` says.
 * Both check the same `expect`, so core and the RPCs agree case by case.
 *
 * The facts derivation and the SQL block live in
 * scripts/gen-readiness-parity-sql.mjs; the last test here fails while the
 * checked-in SQL block is stale.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import fixture from './readiness-parity-cases.json';
import {
  assessOrderReadiness,
  parseOrderReadinessFacts,
  projectCompletePicking,
  readinessStockFlags,
  type OrderReadinessAssessment,
} from './readiness';

// The fixture is exhaustive and CI runs about 4x slower than a laptop.
const TIMEOUT = 30_000;

type Holding = Array<string | number>;
interface ParityItem {
  holdings?: Holding[];
  holds?: { own?: number; otherOrder?: number; rental?: number };
  onHand?: number;
  moved?: boolean;
  deleted?: boolean;
  bundle?: boolean;
}
interface ParityLineExpect {
  state: string;
  ready?: number;
  noRack?: number;
  putAway?: number;
  gap?: number;
  awaiting?: number;
  short?: number;
  hold?: string;
}
interface ParityCase {
  id: string;
  title: string;
  status: string;
  items: Record<string, ParityItem>;
  lines: Array<{ id: string; item: string; requested: number; fulfilled?: number; picked?: number | null }>;
  expect: {
    lines: Record<string, ParityLineExpect>;
    flags?: { isShortStock?: boolean; hasFulfillableStock?: boolean; itemMoved?: boolean };
    approveSucceeds?: boolean;
    approveError?: string;
    approvePartialHolds?: Record<string, number>;
    approvePartialError?: string;
    resumeHolds?: Record<string, number>;
    resumeError?: string;
    projectedPicked?: Record<string, number>;
    completeFails?: boolean;
    completeError?: string;
    /** Core only (the RPC raises one error either way): what the projection
     *  says to put away, and what is on record that no location holds. */
    completeNeedPutAway?: Record<string, number>;
    completeUnaccounted?: Record<string, number>;
    draftable: Record<string, number>;
  };
}

/** F2-5 (0385): a case's facts with only what drafting reads changed. */
interface DraftableCase {
  id: string;
  base: string;
  title: string;
  supply?: Record<
    string,
    {
      inbound?: number[];
      drafts?: number[];
      hiddenInbound?: number;
      truncatedInbound?: number;
      hiddenDrafts?: number;
      committedOtherShortfall?: number;
    }
  >;
  hidden?: string[];
  deleted?: string[];
  poModule?: boolean;
  draftable: Record<string, number>;
}

interface Generator {
  caseFacts(c: ParityCase, n: number): unknown;
  caseKeyIds(c: ParityCase, n: number): { items: Record<string, string>; lines: Record<string, string> };
  renderParitySql(fx: unknown): string;
  checkedInBlock(sql: string, begin?: string, end?: string): string | null;
  draftableCaseFacts(fx: unknown, dc: DraftableCase, k: number): unknown;
  renderDraftableSql(fx: unknown): string;
  TEST_SQL_PATH: string;
  DRAFTABLE_SQL_PATH: string;
  DRAFTABLE_BEGIN_MARKER: string;
  DRAFTABLE_END_MARKER: string;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
let gen: Generator;

beforeAll(async () => {
  // A computed path: the generator is plain JavaScript outside this package.
  const url = pathToFileURL(path.join(ROOT, 'scripts/gen-readiness-parity-sql.mjs')).href;
  gen = (await import(/* @vite-ignore */ url)) as Generator;
});

const cases = (fixture as unknown as { cases: ParityCase[] }).cases;
const draftableCases = (fixture as unknown as { draftableCases: DraftableCase[] }).draftableCases;
const NOW = '2026-01-01T12:00:00.000Z';

function assess(c: ParityCase, n: number) {
  // Through JSON and the parser, exactly as the web server and the phone
  // receive the facts.
  const facts = parseOrderReadinessFacts(JSON.parse(JSON.stringify(gen.caseFacts(c, n))));
  const a = assessOrderReadiness(facts, { now: NOW });
  if (a.phase !== 'to_pick') throw new Error(`${c.id}: expected the to_pick phase`);
  return { a, ids: gen.caseKeyIds(c, n) };
}

type ToPick = Extract<OrderReadinessAssessment, { phase: 'to_pick' }>;

function qn(a: ToPick, itemId: string) {
  const q = a.items.find((i) => i.itemId === itemId)?.quantities;
  if (!q) throw new Error(`no quantities for ${itemId}`);
  return q;
}

describe('the parity fixture', () => {
  it('is well formed: unique ids, every case expects something, no duplicate-item lines in a picking case', () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) {
      expect(Object.keys(c.expect.lines).sort(), c.id).toEqual(c.lines.map((l) => l.id).sort());
      expect(Object.keys(c.expect.draftable).sort(), c.id).toEqual(Object.keys(c.items).sort());
      if (['pick_slip_generated', 'picking_in_progress'].includes(c.status)) {
        const items = c.lines.map((l) => l.item);
        expect(new Set(items).size, `${c.id}: duplicates are excluded from the completion claim`).toBe(items.length);
      }
    }
    // The plan's C1..C8 are all here.
    expect(cases.map((c) => c.id)).toEqual(
      expect.arrayContaining(['C1a', 'C1b', 'C2', 'C3', 'C4', 'C5', 'C6', 'C6b', 'C6c', 'C7', 'C8']),
    );
  });
});

describe.each(cases.map((c, i) => [c.id, c, i + 1] as const))('%s', (_id, c, n) => {
  it(`line states and quantities: ${c.title}`, { timeout: TIMEOUT }, () => {
    const { a, ids } = assess(c, n);
    for (const l of c.lines) {
      const got = a.lines.find((x) => x.lineId === ids.lines[l.id]);
      const want = c.expect.lines[l.id]!;
      expect(got, `${c.id} ${l.id}`).toBeDefined();
      expect(got!.state, `${c.id} ${l.id} state`).toBe(want.state);
      const units = got!.units!;
      for (const k of ['ready', 'noRack', 'putAway', 'gap', 'awaiting', 'short'] as const) {
        expect(units[k], `${c.id} ${l.id} ${k}`).toBe(want[k] ?? 0);
      }
      if (want.hold) expect(got!.hold?.state, `${c.id} ${l.id} hold`).toBe(want.hold);
      else expect(got!.hold, `${c.id} ${l.id} hold`).toBeNull();
    }
    for (const [key, d] of Object.entries(c.expect.draftable)) {
      expect(qn(a, ids.items[key]!).draftable, `${c.id} ${key} draftable`).toBe(d);
    }
  });

  it('the stock flags and what approve, approve_partial and resume_fulfillment do', { timeout: TIMEOUT }, () => {
    const { a, ids } = assess(c, n);
    const flags = readinessStockFlags({ state: 'ok', assessment: a });
    const e = c.expect;
    if (e.flags) expect(flags, c.id).toMatchObject({ state: 'ok', ...e.flags });
    const okFlags = flags.state === 'ok' ? flags : null;
    const moved = a.items.some((i) => i.facts && i.facts.itemWarehouseId !== a.order.warehouseId);
    if (e.approveSucceeds !== undefined) {
      expect(okFlags, c.id).not.toBeNull();
      // approve_order_request refuses a short item (insufficient_stock) or a
      // moved one (item_warehouse_mismatch).
      expect(!okFlags!.isShortStock && !moved, `${c.id} approve`).toBe(e.approveSucceeds);
      if (!e.approveSucceeds) {
        expect(moved ? 'item_warehouse_mismatch' : 'insufficient_stock', c.id).toBe(e.approveError);
      }
    }
    if (e.approvePartialHolds) {
      // approve_partial holds min(requested, on hand less every hold) per item.
      for (const [key, want] of Object.entries(e.approvePartialHolds)) {
        const q = qn(a, ids.items[key]!);
        expect(Math.min(q.requested, q.approveAvailable), `${c.id} ${key} approve_partial`).toBe(want);
      }
    }
    if (e.approvePartialError) expect(moved, c.id).toBe(true);
    if (e.resumeHolds || e.resumeError) {
      // resume_fulfillment holds min(owed, on hand less every hold) per item,
      // and refuses when that is nothing at all.
      const holds = Object.fromEntries(
        Object.entries(ids.items).map(([key, id]) => {
          const q = qn(a, id);
          return [key, Math.min(q.demand, q.approveAvailable)];
        }),
      );
      const total = Object.values(holds).reduce((s, x) => s + x, 0);
      if (e.resumeError) {
        expect(total, c.id).toBe(0);
        expect(okFlags?.hasFulfillableStock, c.id).toBe(false);
      } else {
        expect(holds, c.id).toEqual(e.resumeHolds);
        expect(okFlags?.hasFulfillableStock, c.id).toBe(true);
      }
    }
  });

  it('what complete_picking does', { timeout: TIMEOUT }, () => {
    const e = c.expect;
    if (e.projectedPicked === undefined && e.completeFails === undefined) return;
    const { a, ids } = assess(c, n);
    const p = projectCompletePicking(a);
    expect(p, c.id).not.toBeNull();
    expect(p!.applicable, c.id).toBe(true);
    expect(p!.unknownItemIds, c.id).toEqual([]);
    expect(p!.willFail, `${c.id} willFail`).toBe(e.completeFails ?? false);
    if (e.completeFails) {
      expect(p!.failingItems.map((f) => f.reason), c.id).toEqual([e.completeError ?? 'insufficient_placed_stock']);
    }
    for (const [key, want] of Object.entries(e.completeNeedPutAway ?? {})) {
      expect(p!.failingItems.find((f) => f.itemId === ids.items[key])?.needPutAway, `${c.id} ${key} needPutAway`).toBe(want);
    }
    for (const [key, want] of Object.entries(e.completeUnaccounted ?? {})) {
      expect(p!.failingItems.find((f) => f.itemId === ids.items[key])?.unaccounted, `${c.id} ${key} unaccounted`).toBe(want);
    }
    if (e.projectedPicked) {
      const got = Object.fromEntries(
        c.lines.map((l) => [l.id, p!.lines.find((x) => x.lineId === ids.lines[l.id])?.batch]),
      );
      expect(got, c.id).toEqual(e.projectedPicked);
    }
  });
});

/**
 * F2-5 (migration 0385): what may be drafted for an order's shortfall. The
 * database recomputes it (order_shortfall_draftable) inside
 * draft_order_shortfall_pos after the reorder lock and refuses anything above
 * it, so the dialog's numbers and the refusal must be the same arithmetic.
 * These cases change only what drafting reads (open-PO and draft remaining,
 * units on POs the reader can't open or past the row cap, other orders'
 * committed shortfall, hidden and deleted items, the purchase_orders module);
 * pgTAP 0385 section P runs order_shortfall_draftable over the same facts,
 * and over every case above (its expect.draftable).
 */
describe('draftable (F2-5): core and order_shortfall_draftable agree', () => {
  it('every draftable case names a real base case and every one of its items', () => {
    expect(draftableCases.length).toBeGreaterThanOrEqual(13);
    expect(new Set(draftableCases.map((c) => c.id)).size).toBe(draftableCases.length);
    for (const dc of draftableCases) {
      const base = cases.find((c) => c.id === dc.base);
      expect(base, dc.id).toBeDefined();
      expect(Object.keys(dc.draftable).sort(), dc.id).toEqual(Object.keys(base!.items).sort());
    }
  });

  it.each(draftableCases.map((dc, j) => [dc.id, dc, j + 1] as const))(
    '%s',
    { timeout: TIMEOUT },
    (_id, dc, k) => {
      const n = cases.findIndex((c) => c.id === dc.base) + 1;
      const ids = gen.caseKeyIds(cases[n - 1]!, n);
      const facts = parseOrderReadinessFacts(JSON.parse(JSON.stringify(gen.draftableCaseFacts(fixture, dc, k))));
      const a = assessOrderReadiness(facts, { now: NOW });
      if (a.phase !== 'to_pick') throw new Error(`${dc.id}: expected the to_pick phase`);
      for (const [key, want] of Object.entries(dc.draftable)) {
        const item = a.items.find((i) => i.itemId === ids.items[key]);
        expect(item, `${dc.id} ${key}`).toBeDefined();
        // A hidden item has no numbers at all: nothing is draftable.
        expect(item!.quantities?.draftable ?? 0, `${dc.id} ${key} draftable (${dc.title})`).toBe(want);
        if ((dc.hidden ?? []).includes(key)) expect(item!.quantities, `${dc.id} ${key}`).toBeNull();
      }
    },
  );
});

describe('the pgTAP blocks', () => {
  it('matches the fixture (run node scripts/gen-readiness-parity-sql.mjs after editing it)', { timeout: TIMEOUT }, () => {
    const sql = readFileSync(gen.TEST_SQL_PATH, 'utf8');
    const block = gen.checkedInBlock(sql);
    expect(block).not.toBeNull();
    expect(block).toBe(gen.renderParitySql(fixture));
  });

  it('the 0385 draftable block matches the fixture too', { timeout: TIMEOUT }, () => {
    const sql = readFileSync(gen.DRAFTABLE_SQL_PATH, 'utf8');
    const block = gen.checkedInBlock(sql, gen.DRAFTABLE_BEGIN_MARKER, gen.DRAFTABLE_END_MARKER);
    expect(block).not.toBeNull();
    expect(block).toBe(gen.renderDraftableSql(fixture));
  });
});
