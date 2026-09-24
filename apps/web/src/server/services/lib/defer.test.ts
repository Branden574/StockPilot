import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { after } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { defer } from './defer';

/**
 * The one after()/fire-and-forget helper (see defer.ts).
 *
 *   - inside a request, the work is REGISTERED with after() and not run yet;
 *   - outside one (after() throws: a script, a cron worker, vitest), it runs
 *     at once instead of failing the caller;
 *   - a rejection never escapes, on either branch;
 *   - no second copy: `after` is imported only by defer.ts and the reviewed
 *     direct call sites below.
 */

vi.mock('next/server', () => ({ after: vi.fn() }));

const afterMock = vi.mocked(after);

beforeEach(() => {
  afterMock.mockReset();
});

describe('defer', () => {
  // Mutation caught: calling fn() directly (the SP-092 shape, where the
  // platform may freeze the instance before the promise settles).
  it('inside a request: registers the work with after() and does not run it yet', async () => {
    const registered: Array<() => unknown> = [];
    afterMock.mockImplementation((task) => {
      registered.push(task as () => unknown);
    });
    const fn = vi.fn(async () => undefined);

    defer(fn);

    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(fn).not.toHaveBeenCalled();
    await registered[0]!();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // Mutation caught: dropping the try/catch, which turns every service call
  // from a script or test into a thrown "called outside a request scope".
  it('outside a request: runs the work at once instead of throwing', () => {
    afterMock.mockImplementation(() => {
      throw new Error('`after` was called outside a request scope.');
    });
    const fn = vi.fn(async () => undefined);

    expect(() => defer(fn)).not.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // Mutation caught: dropping `.catch(() => {})`, so a failed email rejects
  // inside after() (an unhandled rejection on the flush) or, on the fallback
  // branch, as a floating promise.
  it('a rejection never escapes, inside a request', async () => {
    const registered: Array<() => unknown> = [];
    afterMock.mockImplementation((task) => {
      registered.push(task as () => unknown);
    });

    defer(() => Promise.reject(new Error('resend down')));

    await expect(Promise.resolve(registered[0]!())).resolves.toBeUndefined();
  });

  it('a rejection never escapes, outside a request', async () => {
    afterMock.mockImplementation(() => {
      throw new Error('`after` was called outside a request scope.');
    });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      defer(() => Promise.reject(new Error('resend down')));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

// ── One copy ────────────────────────────────────────────────────────────────
//
// order-requests.ts and rentals.ts each carried a private copy of this helper,
// the rentals one under another name. inventory-list-invalidation.guard.test.ts
// finds stock writes inside `after(...)` and `defer(...)` callbacks BY CALLEE
// NAME, so a wrapper under any other name hides its callbacks from that check,
// and a fix to one copy leaves the other stale (recurring pattern #26).
//
// Every non-test source that imports `after` from next/server is listed here
// with the reason it calls after() itself. Self-checking: an entry that stops
// importing it fails too. A new service that needs tail work imports defer.

const SRC = path.resolve(__dirname, '../../..');

const AFTER_IMPORTERS: Record<string, string> = {
  // The helper itself.
  'server/services/lib/defer.ts': 'the one wrapper',
  // A direct after() call in a server action, which is always in request
  // scope; the guard sees `after(...)` callbacks by name.
  'server/actions/auth.ts': 'new-device sign-in alert',
  // Not tail work: a scope that holds tag invalidations until the streamed
  // body settles, with its own unscoped fallback.
  'server/services/lib/inventory-list-cache.ts': 'runStreamedStockWrites',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const IMPORTS_AFTER =
  /import\s*\{[^}]*\b(?:unstable_)?after\b[^}]*\}\s*from\s*['"]next\/server['"]/;

describe('one after() wrapper', () => {
  it('resolves src/ (the scan below would pass vacuously on a wrong path)', () => {
    expect(existsSync(path.join(SRC, 'server/services/lib/defer.ts'))).toBe(true);
    expect(sourceFiles(SRC).length).toBeGreaterThan(500);
  });

  // Mutation caught: a service growing its own after() wrapper again (the
  // rentals copy this replaced imported `after` directly).
  it('only defer.ts and the reviewed direct callers import after from next/server', () => {
    const importers = sourceFiles(SRC)
      .filter((file) => IMPORTS_AFTER.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file).split(path.sep).join('/'))
      .sort();
    expect(importers).toEqual(Object.keys(AFTER_IMPORTERS).sort());
  });
});
