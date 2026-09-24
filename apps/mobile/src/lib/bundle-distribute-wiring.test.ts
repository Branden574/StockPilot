import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * WIRING PINS for the bundle-distribute idempotency fix (0347).
 *
 * THE BUG THIS GUARDS: the Distribute screen enqueued the SAME distribution
 * on ANY error — including api()'s own 20 s timeout, which fires after the
 * server may already have committed — and the outbox replay carried no key,
 * so the server distributed AGAIN: components drawn twice, two distribution
 * rows. A 4xx refusal (shortage, permission, archived bundle) was queued too
 * and retried every minute forever while the operator was told it was saved.
 *
 * WHY SOURCE-LEVEL PINS: the screen lives under app/, which the mobile vitest
 * config excludes from collection, so nothing else can observe whether the
 * screen actually mints a key, sends it, and refuses to queue a 4xx. Same
 * idiom as multipart-screens-wiring.test.ts: read the real source, assert the
 * property. The server side is proven by supabase/tests/0347_*.test.sql and
 * the web route/service tests.
 */

const APP_DIR = path.resolve(__dirname, '../../app');
const screen = readFileSync(path.join(APP_DIR, 'bundles', '[id].tsx'), 'utf8');
const sync = readFileSync(path.join(__dirname, 'sync.ts'), 'utf8');

/** The distribute() function body: from its declaration to the next top-level `if (!bundle)`. */
function distributeBody(): string {
  const start = screen.indexOf('async function distribute()');
  const end = screen.indexOf('if (!bundle) {', start);
  expect(start, 'distribute() not found').toBeGreaterThan(-1);
  expect(end, 'end of distribute() not found').toBeGreaterThan(start);
  return screen.slice(start, end);
}

describe('bundles/[id].tsx distribute() — idempotency wiring (0347)', () => {
  it('mints ONE key before the first attempt and sends it on the direct request', () => {
    const body = distributeBody();
    const mint = body.indexOf('newIdempotencyKey()');
    const call = body.indexOf("api(`/api/v1/bundles/${bundle.id}/distribute`");
    expect(mint, 'key must be minted').toBeGreaterThan(-1);
    expect(call, 'direct api() call must exist').toBeGreaterThan(mint);
    // The key is in the direct body — the SAME value the outbox will replay.
    const directBody = body.slice(call, body.indexOf('});', call));
    expect(directBody).toMatch(/idempotencyKey/);
  });

  it('replays through the outbox with the SAME key, not a fresh one', () => {
    const body = distributeBody();
    const enq = body.indexOf("enqueue(");
    expect(enq).toBeGreaterThan(-1);
    const enqCall = body.slice(enq, body.indexOf(');', enq));
    expect(enqCall).toMatch(/'distribute_bundle'/);
    expect(enqCall).toMatch(/\{\s*idempotencyKey\s*\}/);
  });

  it('does NOT queue a 4xx refusal — the server said no, replaying it is not "saving it"', () => {
    const body = distributeBody();
    const catchAt = body.indexOf('catch (e)');
    const enq = body.indexOf('enqueue(', catchAt);
    const guard = body.slice(catchAt, enq);
    expect(guard).toMatch(/e instanceof ApiError/);
    expect(guard).toMatch(/e\.status >= 400 && e\.status < 500/);
    // The refusal path returns before enqueue is reached.
    expect(guard).toMatch(/return;/);
  });

  it('the screen imports ApiError and newIdempotencyKey from their real homes', () => {
    expect(screen).toMatch(/import \{ api, ApiError \} from '@\/lib\/api'/);
    expect(screen).toMatch(/import \{ enqueue, newIdempotencyKey \} from '@\/lib\/queue'/);
  });
});

describe('sync.ts sendOne — distribute_bundle replay (0347)', () => {
  it('sends the row key in the replay body', () => {
    const at = sync.indexOf("case 'distribute_bundle':");
    expect(at).toBeGreaterThan(-1);
    const branch = sync.slice(at, sync.indexOf('return;', at));
    expect(branch).toMatch(/body:\s*\{\s*\.\.\.payload,\s*idempotencyKey\s*\}/);
  });
});

/**
 * WIRING PINS for the warehouse-aware preview (0365).
 *
 * distribute_bundle() now draws components and pre-assembled kits only from
 * the warehouse the kit is handed out at. The rule itself is unit-tested in
 * bundle-distribute-preview.test.ts; these pins prove the screen actually uses
 * it: it passes the CHOSEN warehouse and each row's warehouse into the rule,
 * recomputes when the warehouse changes, and no longer does its own math over
 * every component's on-hand and every pre-assembled kit wherever they sit.
 */
describe('bundles/[id].tsx preview: warehouse-aware (0365)', () => {
  /** The preview useMemo: from its declaration to its dependency list. */
  function previewBody(): string {
    const start = screen.indexOf('const preview: DistributionPreview | null = React.useMemo(');
    expect(start, 'preview useMemo not found').toBeGreaterThan(-1);
    const end = screen.indexOf(']);', start);
    expect(end).toBeGreaterThan(start);
    return screen.slice(start, end + 3);
  }

  it('imports the rule from its lib home', () => {
    expect(screen).toMatch(
      /import \{\s*computeDistributionPreview,\s*defaultDistributeWarehouseId,\s*type DistributionPreview,\s*\} from '@\/lib\/bundle-distribute-preview'/,
    );
  });

  it('computes the preview with the rule, for the chosen warehouse', () => {
    const body = previewBody();
    expect(body).toMatch(/return computeDistributionPreview\(\{/);
    expect(body).toMatch(/\n\s+warehouseId,\n/);
  });

  it("hands the rule each row's warehouse: the kit phantom and every component item", () => {
    const body = previewBody();
    expect(body).toMatch(
      /phantom: \{ quantityOnHand: bundle\.phantomQty, warehouseId: bundle\.phantomWarehouseId \}/,
    );
    expect(body).toMatch(/warehouseId: item\.warehouseId/);
    expect(body).toMatch(/quantityOnHand: item\.quantityOnHand/);
  });

  it('recomputes when the warehouse changes', () => {
    expect(previewBody()).toMatch(/\}, \[bundle, components, items, qty, warehouseId\]\);$/);
  });

  it('no longer counts stock wherever it sits', () => {
    // The pre-0365 math: every kit and every component's on-hand, regardless
    // of the chosen warehouse.
    expect(screen).not.toMatch(/Math\.min\(n, bundle\.phantomQty\)/);
    expect(screen).not.toMatch(/Math\.max\(0, item\?\.quantityOnHand \?\? 0\)/);
  });

  it('starts on the warehouse the kit can be handed out from', () => {
    expect(screen).not.toMatch(/setWarehouseId\(b\.phantomWarehouseId \?\? whs\[0\]/);
    const at = screen.indexOf('defaultDistributeWarehouseId({');
    expect(at).toBeGreaterThan(-1);
    const call = screen.slice(at, screen.indexOf('}),', at));
    expect(call).toMatch(/phantomWarehouseId: b\.phantomWarehouseId/);
    expect(call).toMatch(
      /componentWarehouseIds: comps\.map\(\(c\) => itemMap\.get\(c\.itemId\)\?\.warehouseId\)/,
    );
    expect(call).toMatch(/warehouseIds: whs\.map\(\(w\) => w\.id\)/);
  });
});
