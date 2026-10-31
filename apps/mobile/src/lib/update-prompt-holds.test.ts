import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The holds that keep the phone update pop-up away (B44): counted, released
 * once, handed over with no gap, and told to the controller only when the
 * answer changes. A fresh copy of the module per case: its counts are module
 * state, one per JavaScript runtime.
 */

type Holds = typeof import('./update-prompt-holds');

let holds: Holds;

beforeEach(async () => {
  vi.resetModules();
  holds = await import('./update-prompt-holds');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('holds', () => {
  it('are counted, and a release counts once however often it is called', () => {
    const a = holds.holdUpdatePrompt('sheet');
    const b = holds.holdUpdatePrompt('pick');
    expect(holds.isUpdatePromptHeld()).toBe(true);
    expect(holds.updatePromptHoldReasons()).toEqual(['pick', 'sheet']);
    a();
    a();
    expect(holds.isUpdatePromptHeld()).toBe(true);
    expect(holds.updatePromptHoldReasons()).toEqual(['pick']);
    b();
    expect(holds.isUpdatePromptHeld()).toBe(false);
    expect(holds.updatePromptHoldReasons()).toEqual([]);
  });

  it('tell subscribers only when held turns on or off', () => {
    const fn = vi.fn();
    const off = holds.subscribeUpdatePromptHolds(fn);
    const a = holds.holdUpdatePrompt('sheet');
    const b = holds.holdUpdatePrompt('alert');
    expect(fn).toHaveBeenCalledTimes(1);
    a();
    expect(fn).toHaveBeenCalledTimes(1);
    b();
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    holds.holdUpdatePrompt('sheet');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('whileUpdatePromptHeld', () => {
  it('holds from the call, before the work starts, until it resolves', async () => {
    const work = deferred<string>();
    let heldAtStart: boolean | null = null;
    const result = holds.whileUpdatePromptHeld(() => {
      heldAtStart = holds.isUpdatePromptHeld();
      return work.promise;
    });
    expect(heldAtStart).toBe(true);
    expect(holds.isUpdatePromptHeld()).toBe(true);
    work.resolve('done');
    await expect(result).resolves.toBe('done');
    expect(holds.isUpdatePromptHeld()).toBe(false);
  });

  it('releases when the work rejects, passing the error on', async () => {
    const error = new Error('picker failed');
    await expect(holds.whileUpdatePromptHeld(() => Promise.reject(error))).rejects.toBe(error);
    expect(holds.isUpdatePromptHeld()).toBe(false);
  });

  it('releases when the work throws before it returns a promise', async () => {
    const error = new Error('thrown');
    await expect(
      holds.whileUpdatePromptHeld(() => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(holds.isUpdatePromptHeld()).toBe(false);
  });
});

describe('holds until the next return', () => {
  it('end at releaseHoldsUntilReturn, or sooner by their own release', () => {
    const first = holds.holdUpdatePromptUntilReturn('notification-open');
    holds.holdUpdatePromptUntilReturn('notification-open');
    const plain = holds.holdUpdatePrompt('sheet');
    first();
    expect(holds.isUpdatePromptHeld()).toBe(true);
    holds.releaseHoldsUntilReturn();
    // The plain hold is not one of them.
    expect(holds.isUpdatePromptHeld()).toBe(true);
    plain();
    expect(holds.isUpdatePromptHeld()).toBe(false);
    // Nothing left to end, and a late release changes nothing.
    holds.releaseHoldsUntilReturn();
    first();
    expect(holds.isUpdatePromptHeld()).toBe(false);
  });
});

describe('writes in flight', () => {
  it('count until the promise settles, passing the result through', async () => {
    const write = deferred<number>();
    const tracked = holds.trackWrite(write.promise);
    expect(holds.writesInFlight()).toBe(1);
    expect(holds.isUpdatePromptHeld()).toBe(true);
    write.resolve(7);
    await expect(tracked).resolves.toBe(7);
    expect(holds.writesInFlight()).toBe(0);
    expect(holds.isUpdatePromptHeld()).toBe(false);
  });

  it('count until the promise rejects, passing the error through', async () => {
    const error = new Error('network');
    const tracked = holds.trackWrite(Promise.reject(error));
    expect(holds.writesInFlight()).toBe(1);
    await expect(tracked).rejects.toBe(error);
    expect(holds.writesInFlight()).toBe(0);
  });

  it('whenWritesSettled waits for every write in flight', async () => {
    await expect(holds.whenWritesSettled()).resolves.toBeUndefined();
    const a = deferred<void>();
    const b = deferred<void>();
    void holds.trackWrite(a.promise);
    void holds.trackWrite(b.promise);
    let settled = false;
    void holds.whenWritesSettled().then(() => {
      settled = true;
    });
    a.resolve();
    await a.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    b.resolve();
    await b.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(true);
  });
});

describe('writeTrackingFetch', () => {
  function stubFetch() {
    const pending: ReturnType<typeof deferred<Response>>[] = [];
    const fetchMock = vi.fn(() => {
      const d = deferred<Response>();
      pending.push(d);
      return d.promise;
    });
    vi.stubGlobal('fetch', fetchMock);
    return { fetchMock, pending };
  }

  it.each(['POST', 'PATCH', 'DELETE', 'put'])('counts a %s as a write', async (method) => {
    const { fetchMock, pending } = stubFetch();
    const request = holds.writeTrackingFetch('https://example.test/rest/v1/rows', { method });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(holds.writesInFlight()).toBe(1);
    pending[0]!.resolve(new Response(null, { status: 204 }));
    await request;
    expect(holds.writesInFlight()).toBe(0);
  });

  it.each([undefined, 'GET', 'HEAD'])('does not count a %s', async (method) => {
    const { pending } = stubFetch();
    const request = holds.writeTrackingFetch(
      'https://example.test/rest/v1/rows',
      method ? { method } : undefined,
    );
    expect(holds.writesInFlight()).toBe(0);
    pending[0]!.resolve(new Response('[]'));
    await request;
  });

  it('reads the method of a Request', async () => {
    const { pending } = stubFetch();
    const request = holds.writeTrackingFetch(
      new Request('https://example.test/rest/v1/rpc/f', { method: 'POST' }),
    );
    expect(holds.writesInFlight()).toBe(1);
    pending[0]!.resolve(new Response(null));
    await request;
    expect(holds.writesInFlight()).toBe(0);
  });

  it('reads the global fetch at each call', async () => {
    const first = stubFetch();
    void holds.writeTrackingFetch('https://example.test/a');
    const second = stubFetch();
    void holds.writeTrackingFetch('https://example.test/b');
    expect(first.fetchMock).toHaveBeenCalledTimes(1);
    expect(second.fetchMock).toHaveBeenCalledTimes(1);
    first.pending[0]!.resolve(new Response(null));
    second.pending[0]!.resolve(new Response(null));
  });
});
