import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const reportError = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));

import { buildReturnChainEvents, handOverOf, type ChainDecision } from './return-history';

/**
 * D-H1 (the audit of the RX-4 Demo Co walk): the history shows a hand-over at
 * the order's signature (order_requests.signed_at), never at its completion.
 * Both signature RPCs stamp signed_at at every hand-over and set completed_at
 * to the same now() only when nothing is still owed (0395
 * confirm_physical_signature, 0248 confirm_order_signature). A part hand-over
 * leaves the order backordered with no completed_at; Close the rest (0397) and
 * the RMA's cancel (0396) close it later through close_partial, which stamps
 * completed_at in the close's own transaction, the one that also writes the
 * close's decision. The walk's RMA (RMA-20261012-D36F7F) read "Rest of
 * replacement SO-000033 closed" and then "Replacement handed over (SO-000033)"
 * at the close, and before the close it showed no hand-over at all.
 */

// The walk's times (production, read 2026-10-12 05:19Z), as PostgREST sends them.
const SO32_SIGNED = '2026-10-12T04:00:01.952199+00:00'; // the original, signed and completed at once
const PROCESSED = '2026-10-12T04:06:17.99933+00:00';
const REPL_PICKED = '2026-10-12T04:12:17.841855+00:00';
const SO33_SIGNED = '2026-10-12T04:13:50.37339+00:00'; // 1 of 2 handed over (paper)
const REST_CLOSED = '2026-10-12T04:28:45.798289+00:00'; // completed_at = the decision's created_at

const REPL = 'o-33';

const decision = (d: Pick<ChainDecision, 'seq' | 'kind' | 'createdAt'> & Partial<ChainDecision>): ChainDecision => ({
  channel: 'staff',
  revision: null,
  disposition: null,
  restockTarget: null,
  locationName: null,
  reason: null,
  actorName: 'StockPilot Demo',
  actorKind: 'staff',
  ...d,
});

const replacementPick = (at: string, quantity = 1) => ({
  at,
  itemName: 'Walk Exchange Tee L',
  quantity,
  racks: [{ name: '31-B', quantity }],
});

function chain(over: Partial<Parameters<typeof buildReturnChainEvents>[0]> = {}) {
  return buildReturnChainEvents({
    orderNumber: 32,
    signedAt: SO32_SIGNED,
    completedAt: SO32_SIGNED,
    picks: [],
    decisions: [],
    movements: [],
    itemNames: new Map(),
    exchangeNames: { items: new Map(), orders: new Map([[REPL, 33]]) },
    replacementPicks: [],
    replacement: null,
    ...over,
  });
}

const labels = (events: ReturnType<typeof chain>) => events.map((e) => e.label);
const handOvers = (events: ReturnType<typeof chain>, kind: 'handed_over' | 'replacement_handed_over') =>
  events.filter((e) => e.kind === kind);

describe('handOverOf', () => {
  it('is the signature, whole only when that signature completed the order; a row with no signature falls back to its completion', () => {
    expect(handOverOf({ signedAt: SO32_SIGNED, completedAt: SO32_SIGNED })).toEqual({ at: SO32_SIGNED, whole: true });
    expect(handOverOf({ signedAt: SO33_SIGNED, completedAt: null })).toEqual({ at: SO33_SIGNED, whole: false });
    expect(handOverOf({ signedAt: SO33_SIGNED, completedAt: REST_CLOSED })).toEqual({ at: SO33_SIGNED, whole: false });
    expect(handOverOf({ signedAt: null, completedAt: REST_CLOSED })).toEqual({ at: REST_CLOSED, whole: true });
    expect(handOverOf({ signedAt: null, completedAt: null })).toBeNull();
  });
});

describe('buildReturnChainEvents: the replacement hand-over (D-H1)', () => {
  it('Close the rest (the walk): the part handed over reads at its signature, before the line that closed the rest', () => {
    const events = chain({
      decisions: [
        decision({ seq: 37, kind: 'closed', createdAt: PROCESSED }),
        decision({ seq: 38, kind: 'replacement_closed', createdAt: REST_CLOSED, reason: 'Demo walk: close the rest', orderRequestId: REPL }),
      ],
      replacementPicks: [replacementPick(REPL_PICKED)],
      replacement: { orderNumber: 33, signedAt: SO33_SIGNED, completedAt: REST_CLOSED },
    });
    expect(labels(events).slice(-3)).toEqual([
      'Replacement picked: Walk Exchange Tee L ×1 from 31-B ×1 (SO-000033)',
      'Replacement partly handed over (SO-000033)',
      'Rest of replacement SO-000033 closed: Demo walk: close the rest',
    ]);
    expect(handOvers(events, 'replacement_handed_over')).toEqual([
      { at: SO33_SIGNED, kind: 'replacement_handed_over', label: 'Replacement partly handed over (SO-000033)', actorName: null },
    ]);
    expect(labels(events)).not.toContain('Replacement handed over (SO-000033)');
  });

  it('the rest still on backorder: the part handed over is listed at its signature (it was missing)', () => {
    const events = chain({
      decisions: [decision({ seq: 37, kind: 'closed', createdAt: PROCESSED })],
      replacementPicks: [replacementPick(REPL_PICKED)],
      replacement: { orderNumber: 33, signedAt: SO33_SIGNED, completedAt: null },
    });
    expect(handOvers(events, 'replacement_handed_over')).toEqual([
      { at: SO33_SIGNED, kind: 'replacement_handed_over', label: 'Replacement partly handed over (SO-000033)', actorName: null },
    ]);
    expect(events.at(-1)!.label).toBe('Replacement partly handed over (SO-000033)');
  });

  it('handed over in full: "Replacement handed over" at the signature, as before', () => {
    const events = chain({
      replacementPicks: [replacementPick(REPL_PICKED)],
      replacement: { orderNumber: 33, signedAt: SO33_SIGNED, completedAt: SO33_SIGNED },
    });
    expect(handOvers(events, 'replacement_handed_over')).toEqual([
      { at: SO33_SIGNED, kind: 'replacement_handed_over', label: 'Replacement handed over (SO-000033)', actorName: null },
    ]);
  });

  it("the RMA's cancel closed the rest: the part handed over reads at its signature, before the cancel", () => {
    const CANCELLED = '2026-10-12T05:02:09.114+00:00';
    const events = chain({
      decisions: [
        decision({ seq: 4, kind: 'replacement_issued', revision: 1, createdAt: '2026-10-12T04:01:30.5+00:00', orderRequestId: REPL }),
        decision({ seq: 5, kind: 'released_early', createdAt: '2026-10-12T04:02:00.25+00:00', reason: 'Starts today', orderRequestId: REPL }),
        // cancel_return closes the backorder and writes this in one transaction (0394, 0396).
        decision({ seq: 6, kind: 'cancelled', revision: 2, createdAt: CANCELLED, reason: 'Customer moved' }),
      ],
      replacementPicks: [replacementPick(REPL_PICKED)],
      replacement: { orderNumber: 33, signedAt: SO33_SIGNED, completedAt: CANCELLED },
    });
    expect(labels(events).slice(-3)).toEqual([
      'Replacement picked: Walk Exchange Tee L ×1 from 31-B ×1 (SO-000033)',
      'Replacement partly handed over (SO-000033)',
      'Cancelled: Customer moved',
    ]);
    expect(handOvers(events, 'replacement_handed_over').map((e) => e.at)).toEqual([SO33_SIGNED]);
  });

  it('a second, later hand-over that completes it: one line, at that signature (the row keeps only the latest)', () => {
    // Handed over 1 of 2, resumed (resume_fulfillment clears the signature),
    // picked again and handed over in full: the earlier hand-over is on no
    // row, so it is not listed (a durable record of each would need a
    // migration; owner question 1).
    const SECOND = '2026-10-13T16:40:12.5+00:00';
    const events = chain({
      replacementPicks: [replacementPick(REPL_PICKED), replacementPick('2026-10-13T16:31:00.75+00:00')],
      replacement: { orderNumber: 33, signedAt: SECOND, completedAt: SECOND },
    });
    expect(handOvers(events, 'replacement_handed_over')).toEqual([
      { at: SECOND, kind: 'replacement_handed_over', label: 'Replacement handed over (SO-000033)', actorName: null },
    ]);
    expect(events.at(-1)!.kind).toBe('replacement_handed_over');
  });

  it('a second, later hand-over in part again, then Close the rest: "partly" at that signature, before the close', () => {
    const SECOND = '2026-10-13T16:40:12.5+00:00';
    const CLOSED = '2026-10-13T17:05:44.031+00:00';
    const events = chain({
      decisions: [decision({ seq: 41, kind: 'replacement_closed', createdAt: CLOSED, reason: 'No more coming', orderRequestId: REPL })],
      replacementPicks: [replacementPick(REPL_PICKED), replacementPick('2026-10-13T16:31:00.75+00:00')],
      replacement: { orderNumber: 33, signedAt: SECOND, completedAt: CLOSED },
    });
    expect(labels(events).slice(-2)).toEqual([
      'Replacement partly handed over (SO-000033)',
      'Rest of replacement SO-000033 closed: No more coming',
    ]);
    expect(handOvers(events, 'replacement_handed_over').map((e) => e.at)).toEqual([SECOND]);
  });

  it('a resumed rest not yet signed for lists its picks and no hand-over (known limit: the row no longer has one)', () => {
    const events = chain({
      replacementPicks: [replacementPick(REPL_PICKED), replacementPick('2026-10-13T16:31:00.75+00:00')],
      replacement: { orderNumber: 33, signedAt: null, completedAt: null },
    });
    expect(handOvers(events, 'replacement_handed_over')).toEqual([]);
    expect(events.filter((e) => e.kind === 'replacement_picked')).toHaveLength(2);
  });
});

describe("buildReturnChainEvents: the original order's hand-over", () => {
  it('an original handed over in part and closed later reads "Handed over" at its signature, not at the close', () => {
    const SIGNED = '2026-10-10T16:00:00.5+00:00';
    const CLOSED_PARTIAL = '2026-10-10T18:30:00.25+00:00';
    const events = chain({
      signedAt: SIGNED,
      completedAt: CLOSED_PARTIAL,
      picks: [{ at: '2026-10-10T15:40:00.125+00:00', itemName: 'Walk Exchange Tee M', quantity: 2, racks: [{ name: '31-B', quantity: 2 }] }],
      decisions: [decision({ seq: 1, kind: 'created', channel: 'counter', createdAt: '2026-10-11T09:00:00.5+00:00' })],
    });
    expect(handOvers(events, 'handed_over')).toEqual([{ at: SIGNED, kind: 'handed_over', label: 'Handed over (SO-000032)', actorName: null }]);
    expect(labels(events)).toEqual([
      'Picked: Walk Exchange Tee M ×2 from 31-B ×2 (SO-000032)',
      'Handed over (SO-000032)',
      'Return created by staff at the counter',
    ]);
  });

  it('a row completed with no signature (legacy) keeps "Handed over" at its completion; neither stamp, no line', () => {
    const COMPLETED = '2026-05-12T18:05:31.5+00:00';
    expect(handOvers(chain({ signedAt: null, completedAt: COMPLETED }), 'handed_over')).toEqual([
      { at: COMPLETED, kind: 'handed_over', label: 'Handed over (SO-000032)', actorName: null },
    ]);
    expect(handOvers(chain({ signedAt: null, completedAt: null }), 'handed_over')).toEqual([]);
  });
});

/**
 * B22: the RMA's history has one builder in use, buildReturnWorkbench
 * (returns-workbench.ts). Every surface reads it: the web RMA page, the web
 * actions and every /api/v1/returns write route return the workbench, and the
 * phone reads GET /api/v1/returns/[id]. The standalone ReturnHistoryService.chain
 * (plan RX-1) had no caller from the day it was added (dab3a07d2, #322, where
 * the workbench already built the chain from the reads it had made), and it
 * was never given the RX-2 exchange inputs: it read no item, quantity or order
 * of an exchange decision and passed no replacement, so for an exchange it
 * said "warehouse will review" for a chosen size, named no replacement order
 * and left out the replacement's pick and hand-over. It was removed, not wired.
 */
describe('the RMA history has one builder in use (B22)', () => {
  const WEB_SRC = path.resolve(__dirname, '../..');

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
  }

  it('return-history exports no standalone chain reader', async () => {
    const mod = await import('./return-history');
    expect(Object.keys(mod)).not.toContain('ReturnHistoryService');
  });

  it('only the workbench builds the chain, with the exchange names, the replacement and its picks', () => {
    const files = sourceFiles(WEB_SRC);
    expect(files.length).toBeGreaterThan(500);
    const callsBuilder = (f: string) =>
      /\bbuildReturnChainEvents\(/.test(
        readFileSync(f, 'utf8').replace(/export function buildReturnChainEvents\(/g, ''),
      );
    const callers = files.filter(callsBuilder).map((f) => path.relative(WEB_SRC, f));
    expect(callers).toEqual(['server/services/returns-workbench.ts']);
    const workbench = readFileSync(
      path.join(WEB_SRC, 'server/services/returns-workbench.ts'),
      'utf8',
    );
    const call = workbench.slice(workbench.indexOf('buildReturnChainEvents({'));
    const args = call.slice(0, call.indexOf('});'));
    expect(args).toMatch(/\bexchangeNames:/);
    expect(args).toMatch(/\breplacementPicks\b/);
    expect(args).toMatch(/\breplacement:/);
  });
});
