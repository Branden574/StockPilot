// @vitest-environment node
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * CONTRACT WITH THE INSTALLED NEXT.JS.
 *
 * The realtime listener no longer calls router.refresh() after a successful
 * revalidateInventoryViewAction(): the action's own response is the refresh.
 * That rests on one line of next/dist/server/web/spec-extension/revalidate.js:
 * revalidateTag(tag, { expire: 0 }) sets workStore.pathWasRevalidated, so the
 * action handler re-renders the page into the response. Next marks that line
 * "TODO: only revalidate if the path matches", i.e. provisional. If an upgrade
 * changes it, live stock updates would silently stop re-rendering, and every
 * other test mocks either the action or revalidateTag. This runs the real one.
 */

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;

async function runInActionStore(fn: (revalidateTag: typeof import('next/cache').revalidateTag) => void) {
  const { workAsyncStorage } = await import('next/dist/server/app-render/work-async-storage.external');
  const { revalidateTag } = await import('next/cache');
  const store = {
    incrementalCache: {},
    route: '/dashboard/inventory',
    page: '/(dashboard)/dashboard/inventory/page',
    cacheLifeProfiles: {},
  } as unknown as Parameters<typeof workAsyncStorage.run>[0];
  workAsyncStorage.run(store, () => fn(revalidateTag));
  return store as unknown as { pathWasRevalidated?: unknown };
}

describe('revalidateTag inside a Server Action re-renders the page (installed Next)', () => {
  it('{ expire: 0 } marks the path revalidated — the render live updates rely on', async () => {
    const store = await runInActionStore((revalidateTag) =>
      revalidateTag('inventory-list-contract', { expire: 0 }),
    );
    expect(store.pathWasRevalidated).toBeTruthy();
  });

  it("the 'max' profile does NOT (stale-while-revalidate), so the test above can fail", async () => {
    const store = await runInActionStore((revalidateTag) => revalidateTag('inventory-list-contract', 'max'));
    expect(store.pathWasRevalidated).toBeFalsy();
  });

  it('our loader invalidates with exactly { expire: 0 }', () => {
    const loader = readFileSync(path.resolve(__dirname, '../loaders/inventory-list.ts'), 'utf8');
    expect(loader).toMatch(/revalidateTag\(\s*inventoryListTag\([^)]*\)\s*,\s*\{\s*expire:\s*0\s*\}\s*\)/);
  });
});
