/**
 * Import this FIRST in a test that runs code through Next's request storages
 * (src/test/next-route-harness.ts).
 *
 * Next creates workAsyncStorage / workUnitAsyncStorage when their modules
 * first load, from globalThis.AsyncLocalStorage, and falls back to a fake
 * whose getStore() is always undefined and whose run() throws
 * (next/dist/server/app-render/async-local-storage.js). The server entry sets
 * that global before anything else loads
 * (next/dist/server/node-environment-baseline.js); vitest does not. Without
 * this import every revalidateTag and after() in a test sees "no request
 * scope", which is not how the code behaves in production.
 */
import 'next/dist/server/node-environment-baseline';
