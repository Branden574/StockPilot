import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { parseTsx, readSource } from './__fixtures__/jsx-touch-audit';
import { REQUEST_TIMED_OUT_COPY } from './connection-copy';
import { reloadAfterFailedOrderAction } from './order-action-refusal';

/**
 * After a refused order action the phone's order screen reads the order again.
 *
 * THE DEFECT (docket B10; small fixes slice 2 simulator walk, 2026-10-05).
 * runAction (app/order/[id].tsx) read the order again only after a SUCCESS. A
 * refusal (the order was approved by someone else, a pending order was no
 * longer the requester's to cancel) showed "Could not update order" with the
 * server's reason and left the old status and the old buttons on screen until
 * a pull to refresh, so the next tap was refused the same way.
 */

/** An error shaped as api()'s ApiError: the server's sentence and its status. */
function refusal(status: number, message: string): Error {
  return Object.assign(new Error(message), { name: 'ApiError', status });
}

describe('reloadAfterFailedOrderAction', () => {
  it.each([400, 403, 404, 409, 500])(
    'a %i is the server answering: read the order again',
    (status) => {
      expect(
        reloadAfterFailedOrderAction(refusal(status, 'Only a pending order can be cancelled.')),
      ).toBe(true);
    },
  );

  it('no answer (a timeout, a dropped connection) leaves the order as shown', () => {
    expect(reloadAfterFailedOrderAction(new Error(REQUEST_TIMED_OUT_COPY))).toBe(false);
    expect(reloadAfterFailedOrderAction(new TypeError('Network request failed'))).toBe(false);
    expect(reloadAfterFailedOrderAction(null)).toBe(false);
    expect(reloadAfterFailedOrderAction('refused')).toBe(false);
  });
});

describe("the order screen's runAction reads the order again after a refusal", () => {
  const file = 'app/order/[id].tsx';
  const sf = parseTsx(readSource(path.resolve(__dirname, '../..', file)), file);

  function runAction(): ts.FunctionDeclaration {
    let found: ts.FunctionDeclaration | null = null;
    const visit = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === 'runAction') found = n;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    if (!found) throw new Error('runAction not found');
    return found;
  }

  const fn = runAction();
  const tryStatement = fn.body!.statements.find(ts.isTryStatement);
  const flat = (node: ts.Node) =>
    node
      .getText(sf)
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\s+/g, ' ');

  it('a success still reads the order again', () => {
    expect(tryStatement).toBeDefined();
    expect(flat(tryStatement!.tryBlock)).toContain('await fn(); await load(); return true;');
  });

  it('a failure says why, reads the order again when the server answered, and reports the failure', () => {
    const handler = flat(tryStatement!.catchClause!.block);
    expect(handler).toContain("Alert.alert('Could not update order'");
    expect(handler).toContain(
      'if (reloadAfterFailedOrderAction(e)) await load().catch(() => undefined);',
    );
    expect(handler).toMatch(/await load\(\)\.catch\(\(\) => undefined\);[^]*return false;/);
  });

  it('the screen imports the rule rather than deciding inline', () => {
    expect(sf.getFullText()).toContain(
      "import { reloadAfterFailedOrderAction } from '@/lib/order-action-refusal';",
    );
  });

  it('the reload is the one the rest of the screen uses, under the same busy key', () => {
    // The busy key is cleared in `finally`, after the reload: the buttons stay
    // disabled while the order is read again, so a second tap cannot land on
    // the stale order.
    expect(flat(tryStatement!.finallyBlock!)).toContain('setActing(null);');
  });
});
