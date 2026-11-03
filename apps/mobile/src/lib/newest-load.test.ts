import { describe, expect, it } from 'vitest';

import { createNewestLoads } from './newest-load';

/**
 * The order screen's loads (review of the S2 follow-up, finding F2). Only the
 * newest load started may change the screen, and a caller that waits for its
 * load (an action's reload, a pull to refresh, Try again) waits for what the
 * screen then shows: when a newer load started meanwhile, its own load
 * stopped at a check and showed nothing, so it waits for the newer one too.
 *
 * Each load below is shaped like the screen's: it takes its number before
 * its first await (or none, as the offline load does), and after its read it
 * shows what it read only while it is still the newest.
 */

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A screen with one value on it and the loads that may change it. */
function screen() {
  const loads = createNewestLoads();
  const state = { shown: 'nothing yet' };
  /** A load that reads `answer` and shows it if it is still the newest. */
  function loadOf(label: string, read: Promise<void>) {
    return async () => {
      const seq = loads.next();
      await read;
      if (!loads.isCurrent(seq)) return;
      state.shown = label;
    };
  }
  /** A load that takes no number and reads nothing (offline). */
  const offlineLoad = async () => undefined;
  return { loads, state, loadOf, offlineLoad };
}

/** Lets every promise that can settle now settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createNewestLoads', () => {
  it('is a sequence guard: only the newest number is current', () => {
    const loads = createNewestLoads();
    const first = loads.next();
    expect(loads.isCurrent(first)).toBe(true);
    const second = loads.next();
    expect(loads.isCurrent(first)).toBe(false);
    expect(loads.isCurrent(second)).toBe(true);
  });

  it('one load: run resolves once it has shown what it read', async () => {
    const s = screen();
    const read = deferred();
    let done = false;
    const run = s.loads.run(s.loadOf('the order', read.promise)).then(() => {
      done = true;
    });
    await flush();
    expect(done).toBe(false);
    read.resolve();
    await run;
    expect(s.state.shown).toBe('the order');
  });

  // F2: an action's reload that a newer load overtook used to resolve as
  // soon as it stopped at its check, over the order from before the action.
  it('a newer load started meanwhile: run resolves only once the newer one has shown its result (mutation: return when the own load ends)', async () => {
    const s = screen();
    const actionRead = deferred();
    const focusRead = deferred();
    let actionReloadDone = false;
    const actionReload = s.loads.run(s.loadOf('the reload', actionRead.promise)).then(() => {
      actionReloadDone = true;
    });
    const focusLoad = s.loads.run(s.loadOf('the newer load', focusRead.promise));
    actionRead.resolve();
    await flush();
    // The reload stopped at its check: it shows nothing and does not return.
    expect(s.state.shown).toBe('nothing yet');
    expect(actionReloadDone).toBe(false);
    focusRead.resolve();
    await actionReload;
    expect(s.state.shown).toBe('the newer load');
    await focusLoad;
  });

  it('follows every newer load, however many start while it waits', async () => {
    const s = screen();
    const reads = [deferred(), deferred(), deferred()];
    let firstDone = false;
    const first = s.loads.run(s.loadOf('load 1', reads[0]!.promise)).then(() => {
      firstDone = true;
    });
    const second = s.loads.run(s.loadOf('load 2', reads[1]!.promise));
    reads[0]!.resolve();
    await flush();
    // Load 1 stopped at its check and its caller waits for load 2; a third
    // load starts before load 2 has read, so load 2 stops too.
    const third = s.loads.run(s.loadOf('load 3', reads[2]!.promise));
    reads[1]!.resolve();
    await flush();
    expect(s.state.shown).toBe('nothing yet');
    expect(firstDone).toBe(false);
    reads[2]!.resolve();
    await Promise.all([first, second, third]);
    expect(firstDone).toBe(true);
    expect(s.state.shown).toBe('load 3');
  });

  it('a load that ended before a newer one started is not held by it', async () => {
    const s = screen();
    await s.loads.run(s.loadOf('first', Promise.resolve()));
    expect(s.state.shown).toBe('first');
    const later = deferred();
    const pending = s.loads.run(s.loadOf('later', later.promise));
    // Nothing waits: the first caller was answered when its load showed.
    later.resolve();
    await pending;
    expect(s.state.shown).toBe('later');
  });

  it('a load that takes no number (offline) never counts as the newest, and waits for one that does', async () => {
    const s = screen();
    const read = deferred();
    let numberedDone = false;
    const numbered = s.loads.run(s.loadOf('the order', read.promise)).then(() => {
      numberedDone = true;
    });
    let offlineDone = false;
    const offline = s.loads.run(s.offlineLoad).then(() => {
      offlineDone = true;
    });
    await flush();
    // The offline load overtook nothing, and its caller waits for the load
    // still on its way, which still shows what it read.
    expect(offlineDone).toBe(false);
    expect(numberedDone).toBe(false);
    read.resolve();
    await Promise.all([numbered, offline]);
    expect(s.state.shown).toBe('the order');
  });

  it('a newer load that fails still ends the wait; its failure reaches only its own caller (mutation: a wait that never ends)', async () => {
    const s = screen();
    const older = deferred();
    const newer = deferred();
    const first = s.loads.run(s.loadOf('older', older.promise));
    const second = s.loads.run(s.loadOf('newer', newer.promise)).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    older.resolve();
    newer.reject(new Error('the read threw'));
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBe('the read threw');
    expect(s.state.shown).toBe('nothing yet');
  });

  // F1: a handler made in one render reloads after an await; by then a newer
  // render (new permissions, role or connection) may have kept a newer load.
  it('reload runs the load kept last, not the one kept when its caller was made (mutation: reload runs the first load kept)', async () => {
    const s = screen();
    const ran: string[] = [];
    const loadOf = (label: string) => async () => {
      ran.push(label);
      const seq = s.loads.next();
      await Promise.resolve();
      if (s.loads.isCurrent(seq)) s.state.shown = label;
    };
    s.loads.keep(loadOf('the load at the tap'));
    // The caller (an action's continuation) is made now, and runs later.
    const afterTheAction = () => s.loads.reload();
    s.loads.keep(loadOf('the load after a grant'));
    await afterTheAction();
    expect(ran).toEqual(['the load after a grant']);
    expect(s.state.shown).toBe('the load after a grant');
  });

  it('reload with nothing kept starts nothing and waits for the newest load', async () => {
    const s = screen();
    const read = deferred();
    const focus = s.loads.run(s.loadOf('the order', read.promise));
    let reloaded = false;
    const pending = s.loads.reload().then(() => {
      reloaded = true;
    });
    await flush();
    expect(reloaded).toBe(false);
    read.resolve();
    await Promise.all([focus, pending]);
    expect(s.state.shown).toBe('the order');
  });

  it('its own failure reaches its caller, after the newest load has ended', async () => {
    const s = screen();
    const own = deferred();
    const newer = deferred();
    const order: string[] = [];
    const first = s.loads.run(s.loadOf('own', own.promise)).catch((e: Error) => {
      order.push(`caller: ${e.message}`);
    });
    const second = s.loads.run(s.loadOf('newer', newer.promise)).then(() => {
      order.push('newer shown');
    });
    own.reject(new Error('own read threw'));
    await flush();
    expect(order).toEqual([]);
    newer.resolve();
    await Promise.all([first, second]);
    expect(order).toContain('caller: own read threw');
    expect(s.state.shown).toBe('newer');
  });
});
