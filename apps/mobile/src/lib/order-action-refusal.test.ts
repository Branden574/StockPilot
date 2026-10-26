import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import { parseTsx, readSource } from './__fixtures__/jsx-touch-audit';
import { screenFunction } from './__fixtures__/screen-functions';
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

/**
 * The same rule for the order screen's two return sheets (docket B10 review):
 * "Release replacement before return is received" and Create return each
 * caught a refusal, said it in the sheet, and kept the order they had. The
 * server answers the release 409 return_changed when the replacement was
 * substituted, re-issued, picked or sent on another device, and the return
 * 409 when another device already returned those units: with the old order
 * kept, the screen behind the sheet still offered the release, or the old
 * returnable budget, and the next tap was refused the same way. Each handler
 * is RUN here from the screen's source (screen-functions.ts).
 */
describe("the order screen's return sheets read the order again after a refusal", () => {
  const SCREEN = 'app/order/[id].tsx';
  const RETURN_CHANGED = 'Another person changed this return. Review it again.';

  /** Everything the handler does, in order. The read settles a tick later. */
  function recorder(read: () => Promise<void> = async () => undefined) {
    const log: unknown[][] = [];
    return {
      log,
      load: vi.fn(async () => {
        log.push(['load']);
        await new Promise((resolve) => setTimeout(resolve, 0));
        await read();
        log.push(['loaded']);
      }),
      set: (name: string) => (value: unknown) => log.push([name, value]),
    };
  }

  const shared = {
    reloadAfterFailedOrderAction,
    // The screen's own sentence picker is not under test here.
    extractApiErrorMessage: (e: unknown, fallback: string) =>
      e instanceof Error && e.message ? e.message : fallback,
  };

  function release(fail: unknown, read?: () => Promise<void>) {
    const r = recorder(read);
    const run = screenFunction<(reason: string) => Promise<void>>(SCREEN, 'releaseReplacement', {
      ...shared,
      order: { id: 'o1', replacement: { returnId: 'r1' } },
      releaseBusy: false,
      offline: false,
      setReleaseBusy: r.set('busy'),
      setReleaseError: r.set('error'),
      setReleaseOpen: r.set('open'),
      releaseReturnReplacement: vi.fn(async () => {
        if (fail) throw fail;
        return { answer: { changed: true } };
      }),
      Alert: { alert: vi.fn() },
      RETURNS_COPY: { releaseBeforeReturn: 'Release replacement before return is received' },
      releaseOutcomeLine: () => 'Released.',
      load: r.load,
    });
    return { run, ...r };
  }

  function createReturn(fail: unknown, read?: () => Promise<void>) {
    const r = recorder(read);
    const run = screenFunction<() => Promise<void>>(SCREEN, 'submitReturn', {
      ...shared,
      id: 'o1',
      returnSubmitting: false,
      offline: false,
      buildReturnPayload: () => ({ ok: true, body: { lines: [] } }),
      orderReturnable: [],
      returnDraft: {},
      returnReason: null,
      returnNotes: '',
      returnKey: 'k1',
      returnItemIsHere: false,
      setReturnError: r.set('error'),
      setReturnSubmitting: r.set('busy'),
      setReturnOpen: r.set('open'),
      createOrderReturn: vi.fn(async () => {
        if (fail) throw fail;
        return { id: 'rma1' };
      }),
      canReadReturns: false,
      router: { push: vi.fn() },
      Alert: { alert: vi.fn() },
      load: r.load,
    });
    return { run, ...r };
  }

  it('a refused release is said in the sheet, then the order is read again before the sheet is free', async () => {
    const { run, log, load } = release(refusal(409, RETURN_CHANGED));
    await run('Swap at delivery.');
    expect(load).toHaveBeenCalledTimes(1);
    expect(log).toEqual([
      ['busy', true],
      ['error', null],
      ['error', RETURN_CHANGED],
      ['load'],
      ['loaded'],
      ['busy', false],
    ]);
  });

  it('a refused return is said in the sheet, then the order is read again before the sheet is free', async () => {
    const overBudget = 'Only 1 of these can still be returned.';
    const { run, log, load } = createReturn(refusal(409, overBudget));
    await run();
    expect(load).toHaveBeenCalledTimes(1);
    expect(log).toEqual([
      ['busy', true],
      ['error', null],
      ['error', overBudget],
      ['load'],
      ['loaded'],
      ['busy', false],
    ]);
  });

  it('no answer (a timeout) leaves the order as shown, in both sheets', async () => {
    const timeout = new Error(REQUEST_TIMED_OUT_COPY);
    for (const { run, load, log } of [release(timeout), createReturn(timeout)]) {
      await (run as (reason?: string) => Promise<void>)('r');
      expect(load).not.toHaveBeenCalled();
      expect(log).toContainEqual(['error', REQUEST_TIMED_OUT_COPY]);
      expect(log.at(-1)).toEqual(['busy', false]);
    }
  });

  it('a read that fails never turns the refusal into a throw, and the sheet is freed', async () => {
    const failingRead = async () => {
      throw new Error('read failed');
    };
    for (const { run, log } of [
      release(refusal(409, RETURN_CHANGED), failingRead),
      createReturn(refusal(409, RETURN_CHANGED), failingRead),
    ]) {
      await expect((run as (reason?: string) => Promise<void>)('r')).resolves.toBeUndefined();
      expect(log).toContainEqual(['error', RETURN_CHANGED]);
      expect(log.at(-1)).toEqual(['busy', false]);
    }
  });

  it('a success still closes the sheet and reads the order once', async () => {
    for (const { run, load, log } of [release(null), createReturn(null)]) {
      await (run as (reason?: string) => Promise<void>)('r');
      expect(load).toHaveBeenCalledTimes(1);
      expect(log).toContainEqual(['open', false]);
      expect(log.at(-1)).toEqual(['busy', false]);
    }
  });
});

describe('the release sheet outlives the read behind it', () => {
  // The read after a refused release replaces the order. When the
  // replacement block's own read fails, it comes back null, and a sheet
  // mounted only on `order?.replacement` vanished with the refusal's sentence
  // unread (docket B10 review). It stays mounted while it is open.
  const file = 'app/order/[id].tsx';
  const src = readSource(path.resolve(__dirname, '../..', file));

  it('is mounted while the order has a replacement block or the sheet is open', () => {
    expect(src).toMatch(/\{order\?\.replacement \|\| releaseOpen \? \(\s*<ReleaseReplacementSheet/);
  });
});
