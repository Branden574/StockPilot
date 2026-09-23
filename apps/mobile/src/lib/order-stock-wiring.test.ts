import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * WIRING PINS for the order screen's load and its stock-dependent actions.
 * The screen imports native modules, so vitest cannot render it; the decisions
 * live in lib/order-stock-check.ts (tested there) and these pins keep the
 * screen wired to them.
 */

const screen = readFileSync(path.resolve(__dirname, '../../app/order/[id].tsx'), 'utf8');

/** The body of the screen's `load` callback. */
function loadBody(): string {
  const start = screen.indexOf('const load = React.useCallback(async () => {');
  expect(start).toBeGreaterThan(-1);
  const end = screen.indexOf('}, [orgId, id, loadAttachments]);', start);
  expect(end).toBeGreaterThan(start);
  return screen.slice(start, end);
}

describe('order screen: a failed header or lines read is a load error, not an order', () => {
  it('binds both errors and stops before building an order from them', () => {
    const body = loadBody();
    expect(body).toContain('const { data, error: headerError } = await supabase');
    expect(body).toContain('const { data: lineRows, error: linesError } = await supabase');
    // EITHER error is a failure (the lines one is the one that used to show
    // "This order has no items yet." with every action still offered).
    expect(body).toContain('const readFailure = headerError?.message ?? linesError?.message ?? null;');
    const failure = body.indexOf('if (readFailure !== null) {');
    expect(failure).toBeGreaterThan(-1);
    // Nothing is read after the failure is noticed (no stock check, no
    // returns, no attachments): the branch sets the error and returns.
    const branch = body.slice(failure, body.indexOf('return;\n    }', failure));
    expect(branch).toContain('setOrder(null);');
    expect(branch).toContain('setLoadError(readFailure);');
    expect(branch).not.toContain('await ');
    // Before any other read.
    expect(failure).toBeLessThan(body.indexOf("from('returns')"));
    expect(failure).toBeLessThan(body.indexOf('loadOrderStockCheck('));
  });

  it('every load that completes sets the error flag: cleared on success, so it never sticks', () => {
    // Cleared at the END of a successful load, not the start: clearing first
    // would flash "Order not found." over the error screen while a retry runs.
    const body = loadBody();
    expect(body).toMatch(/setLoadError\(null\);\s*if \(!data\) setOrder\(null\);\s*if \(data\) \{/);
  });

  it('renders the error with a guarded Try again instead of "Order not found."', () => {
    expect(screen).toMatch(/\) : !order && loadError \? \(/);
    expect(screen).toContain('Could not load this <Em>order.</Em>');
    // The error branch comes BEFORE the not-found branch.
    expect(screen.indexOf('!order && loadError ?')).toBeLessThan(screen.indexOf('Order not <Em>found.</Em>'));
    expect(screen).toMatch(/async function retryLoad\(\) \{\s*if \(retrying\) return;/);
    const tries = screen.match(/onPress=\{\(\) => void retryLoad\(\)\}\s*disabled=\{retrying\}/g) ?? [];
    expect(tries.length).toBe(2); // the load error and the stock-check notice
  });
});

describe('order screen: Approve partial and Resume come from the stock gates', () => {
  it('reads stock through the batched, fail-closed loader, never an unbatched in()', () => {
    expect(loadBody()).toContain('await loadOrderStockCheck(');
    expect(screen).not.toContain(".in('id', itemIds)");
    expect(screen).not.toContain(".from('stock_reservations')");
    expect(screen).not.toContain('order.isShortStock');
    expect(screen).not.toContain('order.hasFulfillableStock');
  });

  it('gates both actions on orderStockGates, disabled (not hidden, not zeroed) when the check failed', () => {
    expect(screen).toContain("const stockGates = orderStockGates(st ?? '', order?.stockCheck ?? { state: 'not_needed' });");
    expect(screen).toMatch(
      /stockGates\.approvePartial !== 'hidden'\s*\? actionBtn\(\s*'Approve partial',[\s\S]*?stockGates\.approvePartial === 'disabled',\s*\)/,
    );
    expect(screen).toMatch(
      /stockGates\.resume === 'waiting' \? \(\s*<Body[^>]*>\s*Resume unlocks when owed items are back in stock\./,
    );
    expect(screen).toMatch(/'Resume fulfillment',[\s\S]*?stockGates\.resume === 'disabled',\s*\)/);
    // The notice renders in both branches.
    expect(screen.match(/\{stockNotice\}/g)?.length).toBe(2);
  });

  it('a disabled action button really is disabled', () => {
    expect(screen).toContain('disabled={acting !== null || disabled}');
  });
});
