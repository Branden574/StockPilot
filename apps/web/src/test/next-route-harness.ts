/**
 * Run a Route Handler through Next's REAL App Route module, and report which
 * cache tags Next actually expired.
 *
 * WHY THIS EXISTS: a test that mocks next/cache#revalidateTag proves only that
 * the call was MADE. revalidateTag itself does nothing but push the tag onto
 * the request's work store (next/dist/server/web/spec-extension/revalidate.js,
 * `store.pendingRevalidatedTags.push`); Next expires it later, at points it
 * chooses:
 *   - a Route Handler: ONCE, when the handler returns its Response
 *     (route-modules/app-route/module.js, resolvePendingRevalidations right
 *     after `res = await ...run(requestStore, handler, ...)`);
 *   - an after() callback: when the callbacks run, and only for tags that
 *     are NEW relative to the store as it stood when they started
 *     (after/after-context.js runCallbacks -> revalidation-utils.js
 *     withExecuteRevalidates / diffRevalidationState).
 * A tag recorded outside those windows (for example from inside a streamed
 * body, after the handler already returned) sits in the array and is never
 * sent anywhere. Nothing throws and nothing is logged. The AI chat route
 * dropped every write tool's invalidation this way.
 *
 * This harness drives `AppRouteRouteModule.handle` with the same renderOpts
 * shape build/templates/app-route.js gives it in production (waitUntil,
 * onClose, incrementalCache), drains the body the way sendResponse would,
 * fires onClose the way `res.on('close')` does, and waits for everything
 * handed to waitUntil. The incremental cache is a recorder: its revalidateTag
 * is the call Next makes to actually expire a tag (revalidation-utils.js
 * revalidateTags), so `expired` is exactly what a real deployment would have
 * invalidated. It depends on Next internals on purpose: if an upgrade changes
 * when revalidates run, these tests should fail, not keep passing on a mock.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { workAsyncStorage } from 'next/dist/server/app-render/work-async-storage.external';
import { AppRouteRouteModule } from 'next/dist/server/route-modules/app-route/module';
import { NextRequest } from 'next/server';

export interface ExpiredTags {
  tags: string[];
  durations: unknown;
  /** 'before-close' = while the body was still streaming or earlier. */
  phase: 'before-close' | 'after-close';
}

export interface RouteRunResult {
  status: number;
  body: string;
  expired: ExpiredTags[];
}

type Handler = (
  req: Request,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

export async function runRouteThroughNext(
  userland: { POST?: Handler; GET?: Handler; dynamic?: string },
  request: Request,
  opts: { page?: string; params?: Record<string, string> } = {},
): Promise<RouteRunResult> {
  if (!(workAsyncStorage instanceof AsyncLocalStorage)) {
    throw new Error(
      "Next's request storages are fakes in this file: import '@/test/next-als' before anything that loads next/*.",
    );
  }
  const page = opts.page ?? '/api/test/route';
  const expired: ExpiredTags[] = [];
  let closed = false;
  const incrementalCache = {
    revalidateTag: async (tags: string | string[], durations?: unknown) => {
      expired.push({
        tags: Array.isArray(tags) ? tags : [tags],
        durations,
        phase: closed ? 'after-close' : 'before-close',
      });
    },
    resetRequestCache: () => undefined,
  };
  const waitUntil: Promise<unknown>[] = [];
  const onCloseCallbacks: Array<() => void> = [];

  const mod = new AppRouteRouteModule({
    definition: {
      kind: 'APP_ROUTE',
      page,
      pathname: page.replace(/\/route$/, ''),
      filename: 'route',
      bundlePath: `app${page}`,
    },
    // A factory, as build/templates/app-route.js passes it (`userland: () => require(...)`).
    userland: () => userland,
    distDir: '.next',
    relativeProjectDir: '',
    resolvedPagePath: `src/app${page}.ts`,
    nextConfigOutput: undefined,
  } as unknown as ConstructorParameters<typeof AppRouteRouteModule>[0]);

  const context = {
    params: opts.params,
    previewProps: undefined,
    renderOpts: {
      experimental: { authInterrupts: false },
      cacheComponents: false,
      supportsDynamicResponse: true,
      incrementalCache,
      cacheLifeProfiles: {},
      waitUntil: (p: Promise<unknown>) => {
        waitUntil.push(p);
      },
      onClose: (cb: () => void) => {
        onCloseCallbacks.push(cb);
      },
      onAfterTaskError: undefined,
    } as Record<string, unknown>,
    sharedContext: { buildId: 'test' },
  };

  const res = await mod.handle(
    new NextRequest(request),
    context as unknown as Parameters<AppRouteRouteModule['handle']>[1],
  );
  // build/templates/app-route.js hands renderOpts.pendingWaitUntil (the
  // handler-return revalidation) to ctx.waitUntil.
  const pending = context.renderOpts.pendingWaitUntil as Promise<unknown> | undefined;
  if (pending) waitUntil.push(pending);

  const body = await res.text();
  closed = true;
  for (const cb of onCloseCallbacks) cb();
  // waitUntil can grow while it drains (after() registers its runner lazily).
  for (let seen = 0; seen < waitUntil.length;) {
    const batch = waitUntil.slice(seen);
    seen = waitUntil.length;
    await Promise.allSettled(batch);
  }
  return { status: res.status, body, expired };
}
