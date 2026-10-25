import { INTERRUPTED_RUN_PREFIX } from '@/lib/interrupted-run';

/**
 * Test helpers for the records lib/interrupted-run keeps in this tab's
 * sessionStorage, used by the tests that check a sign-out removes them first.
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
