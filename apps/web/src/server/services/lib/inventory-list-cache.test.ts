// @vitest-environment node
// FIRST: Next builds its request storages from this global when they load.
import '@/test/next-als';

import { revalidateTag } from 'next/cache';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runRouteThroughNext } from '@/test/next-route-harness';

// setup.ts stubs the never-throwing wrapper for every other file; run the real one.
vi.mock('@/server/services/lib/inventory-list-cache', async (importOriginal) => importOriginal());

import { invalidateInventoryListAfterWrite, runStreamedStockWrites } from './inventory-list-cache';

/**
 * What these prove, through Next's real App Route module (not a mocked
 * revalidateTag): which inventory-list tags a deployment would actually
 * expire, and when.
 *
 * The CONTROL cases pin the two Next behaviours runStreamedStockWrites exists
 * for. If an upgrade makes either of them start expiring the tag, the control
 * fails, and the scope (and the chat route's use of it) can be revisited
 * rather than kept on faith.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const enc = new TextEncoder();
const post = () => new Request('https://test.local/api/test', { method: 'POST' });

/** A route whose stock "write" happens inside its streamed body, after the
 *  handler returned, the way the AI chat route runs its write tools. */
function streamedRoute(body: () => Promise<void>) {
  return {
    POST: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            await tick(); // the handler has returned by now
            await body();
            controller.enqueue(enc.encode('{"type":"done"}\n'));
            controller.close();
          },
        }),
      ),
  };
}

const inventoryExpiries = (expired: Awaited<ReturnType<typeof runRouteThroughNext>>['expired']) =>
  expired.filter((e) => e.tags.some((t) => t.startsWith('inventory-list-')));

afterEach(() => vi.restoreAllMocks());

describe('invalidating the Items/Books cache from a Route Handler', () => {
  it('CONTROL: a write before the handler returns is expired by Next (before the body closes)', async () => {
    const { expired } = await runRouteThroughNext(
      {
        POST: async () => {
          invalidateInventoryListAfterWrite('org-a', 'test.write');
          return Response.json({ ok: true });
        },
      },
      post(),
    );
    expect(inventoryExpiries(expired)).toEqual([
      { tags: ['inventory-list-org-a'], durations: { expire: 0 }, phase: 'before-close' },
    ]);
  });

  it('CONTROL: the same call from inside a streamed body is DROPPED by Next, silently', async () => {
    const warn = vi.spyOn(console, 'warn');
    const { body, expired } = await runRouteThroughNext(
      streamedRoute(async () => invalidateInventoryListAfterWrite('org-a', 'test.write')),
      post(),
    );
    expect(body).toContain('"done"');
    // Recorded on the work store after resolvePendingRevalidations already
    // ran: nothing reaches the cache, and nothing throws or logs.
    expect(inventoryExpiries(expired)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('CONTROL: recording the tag in the stream and again from after() is dropped too', async () => {
    // Why the scope queues orgs instead of letting the write record the tag:
    // after() flushes only tags new since its callbacks started, compared by
    // tag + profile, so the second record matches the dead first one.
    const { after } = await import('next/server');
    const { expired } = await runRouteThroughNext(
      {
        POST: async () => {
          after(() => revalidateTag('inventory-list-org-a', { expire: 0 }));
          return streamedRoute(async () =>
            invalidateInventoryListAfterWrite('org-a', 'test.write'),
          ).POST();
        },
      },
      post(),
    );
    expect(inventoryExpiries(expired)).toEqual([]);
  });

  it('runStreamedStockWrites makes the in-stream write take effect once the stream closes', async () => {
    const { body, expired } = await runRouteThroughNext(
      streamedRoute(() =>
        runStreamedStockWrites('test.stream', async () => {
          await tick();
          invalidateInventoryListAfterWrite('org-a', 'test.write');
          await tick();
          invalidateInventoryListAfterWrite('org-a', 'test.write.again');
          invalidateInventoryListAfterWrite('org-b', 'test.write.other_org');
        }),
      ),
      post(),
    );
    expect(body).toContain('"done"');
    expect(inventoryExpiries(expired)).toEqual([
      {
        tags: ['inventory-list-org-a', 'inventory-list-org-b'],
        durations: { expire: 0 },
        phase: 'after-close',
      },
    ]);
  });

  it('expires nothing when the scoped body wrote nothing', async () => {
    const { expired } = await runRouteThroughNext(
      streamedRoute(() => runStreamedStockWrites('test.stream', async () => undefined)),
      post(),
    );
    expect(inventoryExpiries(expired)).toEqual([]);
  });

  it('still flushes when the scoped body throws after its write committed', async () => {
    const { expired } = await runRouteThroughNext(
      streamedRoute(async () => {
        await runStreamedStockWrites('test.stream', async () => {
          invalidateInventoryListAfterWrite('org-a', 'test.write');
          throw new Error('model provider failed mid-turn');
        }).catch(() => undefined);
      }),
      post(),
    );
    expect(inventoryExpiries(expired)).toEqual([
      { tags: ['inventory-list-org-a'], durations: { expire: 0 }, phase: 'after-close' },
    ]);
  });

  it('waits for a write that commits after the client already went away', async () => {
    // The response closes as soon as the body is drained; this body keeps
    // running (a tool call finishing after a disconnect) and writes later.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = runRouteThroughNext(
      {
        POST: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(enc.encode('partial\n'));
                controller.close();
                void runStreamedStockWrites('test.stream', async () => {
                  await gate;
                  invalidateInventoryListAfterWrite('org-a', 'test.late_write');
                });
              },
            }),
          ),
      },
      post(),
    );
    await tick();
    release();
    const { expired } = await run;
    expect(inventoryExpiries(expired)).toEqual([
      { tags: ['inventory-list-org-a'], durations: { expire: 0 }, phase: 'after-close' },
    ]);
  });

  it('outside any request scope the body runs unscoped and the write invalidates inline', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const out = await runStreamedStockWrites('test.script', async () => {
      invalidateInventoryListAfterWrite('org-a', 'test.write');
      return 42;
    });
    expect(out).toBe(42);
    // Inline, exactly as without the scope: no work store, so Next refuses and
    // the never-throwing wrapper logs it.
    expect(warn).toHaveBeenCalledWith(
      '[inventory-list] invalidation skipped after test.write:',
      expect.stringContaining('static generation store missing'),
    );
  });
});
