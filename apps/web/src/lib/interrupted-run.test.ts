// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  finishRun,
  INTERRUPTED_RUN_PREFIX,
  INTERRUPTED_RUN_TTL_MS,
  leaveRunUnfinished,
  recordRun,
  takeInterruptedRun,
} from './interrupted-run';

/**
 * A flow that saves something and then keeps sending Server Actions (the New
 * procedure form's video batch, the Sage 50 wizard's chunks) holds what it has
 * done in memory. When the session ends partway through, the next action is
 * answered with a redirect, the browser loads sign-in, and that memory is
 * gone. The record below is what the page the person comes back to reads
 * instead.
 */

const KIND = 'test-run';
const ME = { userId: 'user-1', organizationId: 'org-1' };
const KEY = `${INTERRUPTED_RUN_PREFIX}${KIND}`;

function parseId(value: unknown): { id: string } | null {
  const id = (value as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? { id } : null;
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  // A run a test leaves going in this page would hide the next test's record.
  finishRun(KIND);
  finishRun('other-run');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('interrupted run record', () => {
  it('is handed once to the page the person comes back to when a redirect cut the run short', () => {
    recordRun(KIND, ME, { id: 'p-1' });
    leaveRunUnfinished(KIND);

    expect(takeInterruptedRun(KIND, ME, parseId)).toEqual({ id: 'p-1' });
    expect(takeInterruptedRun(KIND, ME, parseId)).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('survives a page load: the next page finds it with no live run in it', async () => {
    recordRun(KIND, ME, { id: 'p-1' });

    // A reload, or the browser going to sign-in, starts every module afresh.
    vi.resetModules();
    const nextPage = await import('./interrupted-run');

    expect(nextPage.takeInterruptedRun(KIND, ME, parseId)).toEqual({ id: 'p-1' });
  });

  it('is not handed out while the run is still going in this page, and is kept', () => {
    recordRun(KIND, ME, { id: 'p-1' });

    expect(takeInterruptedRun(KIND, ME, parseId)).toBeNull();
    expect(sessionStorage.getItem(KEY)).not.toBeNull();
  });

  it('is removed when the run ends on the page', () => {
    recordRun(KIND, ME, { id: 'p-1' });
    finishRun(KIND);

    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(takeInterruptedRun(KIND, ME, parseId)).toBeNull();
  });

  it('holds the latest step: each step rewrites it and restarts its day', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    recordRun(KIND, ME, { id: 'p-1' });
    // A long batch: the next step comes almost a day later.
    now.mockReturnValue(1_000_000 + INTERRUPTED_RUN_TTL_MS - 1);
    recordRun(KIND, ME, { id: 'p-2' });
    leaveRunUnfinished(KIND);
    now.mockReturnValue(1_000_000 + INTERRUPTED_RUN_TTL_MS + 60_000);

    expect(takeInterruptedRun(KIND, ME, parseId)).toEqual({ id: 'p-2' });
  });

  it('is dropped, never shown, once it is more than a day old', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    recordRun(KIND, ME, { id: 'p-1' });
    leaveRunUnfinished(KIND);
    now.mockReturnValue(1_000_000 + INTERRUPTED_RUN_TTL_MS + 1);

    expect(takeInterruptedRun(KIND, ME, parseId)).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('is never handed to another account signed in on this tab, and is dropped', () => {
    const others = [
      { userId: 'user-2', organizationId: 'org-1' },
      { userId: 'user-1', organizationId: 'org-2' },
    ];
    for (const other of others) {
      recordRun(KIND, ME, { id: 'p-1' });
      leaveRunUnfinished(KIND);

      expect(takeInterruptedRun(KIND, other, parseId)).toBeNull();
      // Dropped: the first account does not get it later either.
      expect(takeInterruptedRun(KIND, ME, parseId)).toBeNull();
    }
  });

  it('drops a record it cannot use: unreadable, another version, or a payload the page refuses', () => {
    const at = Date.now();
    const stored = [
      '{not json',
      JSON.stringify({ v: 2, ...ME, at, payload: { id: 'p-1' } }),
      JSON.stringify({ v: 1, ...ME, at: 'yesterday', payload: { id: 'p-1' } }),
      JSON.stringify({ v: 1, ...ME, at, payload: { id: 42 } }),
      JSON.stringify(null),
    ];
    for (const raw of stored) {
      sessionStorage.setItem(KEY, raw);

      expect(takeInterruptedRun(KIND, ME, parseId)).toBeNull();
      expect(sessionStorage.getItem(KEY)).toBeNull();
    }
  });

  it('keeps each kind of run apart', () => {
    recordRun(KIND, ME, { id: 'p-1' });
    recordRun('other-run', ME, { id: 'p-2' });
    leaveRunUnfinished(KIND);

    // The other run is still going here; this one was cut short.
    expect(takeInterruptedRun('other-run', ME, parseId)).toBeNull();
    expect(takeInterruptedRun(KIND, ME, parseId)).toEqual({ id: 'p-1' });
  });

  it('never throws when the browser refuses storage, and hands nothing out', () => {
    const refusing = {
      length: 0,
      key: () => null,
      getItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
      removeItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    };
    vi.stubGlobal('sessionStorage', refusing);

    expect(() => recordRun(KIND, ME, { id: 'p-1' })).not.toThrow();
    expect(() => leaveRunUnfinished(KIND)).not.toThrow();
    expect(takeInterruptedRun(KIND, ME, parseId)).toBeNull();
    expect(() => finishRun(KIND)).not.toThrow();
  });

  it('never throws when reading sessionStorage itself throws (site data blocked)', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    try {
      expect(() => recordRun(KIND, ME, { id: 'p-1' })).not.toThrow();
      expect(() => leaveRunUnfinished(KIND)).not.toThrow();
      expect(takeInterruptedRun(KIND, ME, parseId)).toBeNull();
      expect(() => finishRun(KIND)).not.toThrow();
    } finally {
      if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
      else delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
    }
  });
});
