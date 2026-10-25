import { vi } from 'vitest';

import { INTERRUPTED_RUN_CHANNEL, INTERRUPTED_RUN_PREFIX } from '@/lib/interrupted-run';

/**
 * Test helpers for the records lib/interrupted-run keeps in this tab's
 * sessionStorage, used by the tests that check a sign-out removes them first,
 * and a stand-in BroadcastChannel for the tests of a sign-out reaching the
 * browser's other tabs.
 */

/** A key in this tab that is not an interrupted run's: a purge leaves it. */
export const UNRELATED_KEY = 'sp:unrelated';

const PROCEDURE_ID = '00000000-0000-4000-8000-000000000001';

/**
 * Puts a record of each kind in this tab, as the New procedure form and the
 * Sage 50 wizard write them, and one unrelated key.
 */
export function seedInterruptedRuns(
  account: { userId: string; organizationId: string } = {
    userId: 'user-1',
    organizationId: 'org-1',
  },
): void {
  const at = Date.now();
  sessionStorage.setItem(
    `${INTERRUPTED_RUN_PREFIX}procedure-video-batch`,
    JSON.stringify({ v: 1, ...account, at, payload: { procedureId: PROCEDURE_ID } }),
  );
  sessionStorage.setItem(
    `${INTERRUPTED_RUN_PREFIX}sage50-import`,
    JSON.stringify({
      v: 1,
      ...account,
      at,
      payload: {
        processed: 250,
        fileTotal: 251,
        summary: {
          items: {
            total: 250,
            created: 249,
            failed: 1,
            errors: [{ row: 7, sku: 'SKU-7', message: 'SKU already exists' }],
          },
          suppliers: {
            total: 0,
            created: 0,
            reused: 0,
            failed: 0,
            skipped: true,
            skippedReason: null,
          },
        },
      },
    }),
  );
  sessionStorage.setItem(UNRELATED_KEY, 'kept');
}

/** The interrupted-run keys in this tab right now, sorted. */
export function interruptedRunKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < sessionStorage.length; i += 1) {
    const key = sessionStorage.key(i);
    if (key !== null && key.startsWith(INTERRUPTED_RUN_PREFIX)) keys.push(key);
  }
  return keys.sort();
}

/**
 * Makes reading `sessionStorage` itself throw, as a browser with site data
 * blocked does, until the returned function puts it back.
 */
export function blockSessionStorage(): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    get() {
      throw new DOMException('blocked', 'SecurityError');
    },
  });
  return () => {
    if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
    else delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
  };
}

/** One tab's end of the stand-in BroadcastChannel below. */
export interface FakeChannelEnd {
  /** What this end received, in the order it arrived. */
  readonly received: unknown[];
  postMessage(data: unknown): void;
  close(): void;
}

/**
 * Stands in for the browser's BroadcastChannel (through vi.stubGlobal: undo it
 * with vi.unstubAllGlobals()), for the tests of a purge reaching the other tabs
 * of the browser. Every channel object is one tab's end. A message goes to
 * every other end open on the same name when it is sent, never back to the end
 * that sent it, and arrives when the test calls deliver(), as a browser
 * delivers it a moment later; an end closed by then does not get it.
 */
export function fakeBroadcastChannels() {
  const ends = new Set<FakeEnd>();
  const pending: Array<() => void> = [];
  const sentHere: unknown[] = [];

  class FakeEnd implements FakeChannelEnd {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    readonly received: unknown[] = [];
    private closed = false;

    constructor(
      readonly name: string,
      /** An end the test opened for another tab, not one this page's code opened. */
      readonly otherTab = false,
    ) {
      ends.add(this);
    }

    postMessage(data: unknown): void {
      if (this.closed) throw new DOMException('The channel is closed.', 'InvalidStateError');
      const message: unknown = structuredClone(data);
      if (!this.otherTab && this.name === INTERRUPTED_RUN_CHANNEL) sentHere.push(message);
      for (const end of ends) {
        if (end === this || end.name !== this.name) continue;
        pending.push(() => {
          if (end.closed) return;
          end.received.push(message);
          end.onmessage?.({ data: message });
        });
      }
    }

    close(): void {
      this.closed = true;
      ends.delete(this);
    }
  }

  vi.stubGlobal('BroadcastChannel', FakeEnd);

  return {
    /** Another tab of this browser with the app open: its end of the channel. */
    otherTab: (): FakeChannelEnd => new FakeEnd(INTERRUPTED_RUN_CHANNEL, true),
    /** Every message this page's code has sent on the channel so far, delivered or not. */
    sent: (): unknown[] => [...sentHere],
    /** Delivers every message sent so far, and any sent while delivering. */
    deliver: (): void => {
      for (let n = 0; pending.length > 0; n += 1) {
        if (n > 100) throw new Error('Messages keep coming: a tab passes the purge on.');
        pending.shift()!();
      }
    },
    /** How many ends this page's code holds open on the channel. */
    openHere: (): number =>
      [...ends].filter((end) => !end.otherTab && end.name === INTERRUPTED_RUN_CHANNEL).length,
  };
}
