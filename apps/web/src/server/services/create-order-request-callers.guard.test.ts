import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ONE CREATE PATH (phone ordering PO-2, migration 0391). Every order request
 * is created through OrderRequestsService.create, which calls
 * place_order_request, which calls the frozen create_order_request. Nothing
 * else in product code may call create_order_request (or insert an order row
 * through a client): a second caller would skip the submission key, the
 * recorded refusals and the placer check. This scans every product source
 * file of the web app, the phone and core (tests excluded) for the function's
 * name as a string, and for a client insert into order_requests.
 */

const REPO = path.resolve(__dirname, '../../../../..');
const ROOTS = ['apps/web/src', 'apps/mobile/src', 'apps/mobile/app', 'packages/core/src'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const FILES = ROOTS.flatMap((r) => sourceFiles(path.join(REPO, r)));

describe('nothing in product code creates an order but the one path', () => {
  it('scans a real tree', () => {
    expect(FILES.length).toBeGreaterThan(500);
    expect(FILES.some((f) => f.endsWith('apps/web/src/server/services/order-requests.ts'))).toBe(
      true,
    );
  });

  it('no product file names create_order_request as a string (an rpc call)', () => {
    const callers = FILES.filter((f) =>
      /['"`]create_order_request['"`]/.test(readFileSync(f, 'utf8')),
    );
    expect(callers.map((f) => path.relative(REPO, f))).toEqual([]);
  });

  it('the service calls place_order_request, once', () => {
    const svc = readFileSync(
      path.join(REPO, 'apps/web/src/server/services/order-requests.ts'),
      'utf8',
    );
    expect(svc.match(/rpc\('place_order_request'/g)).toHaveLength(1);
  });

  it("no product file inserts into order_requests through a client (from('order_requests').insert)", () => {
    const inserters = FILES.filter((f) =>
      /from\(\s*['"`]order_requests['"`]\s*\)\s*\.insert\(/.test(readFileSync(f, 'utf8')),
    );
    // The public order link (no account) and the B2B portal create orders of
    // their own sources through their own paths, reviewed separately; listed
    // by name so a new inserter fails here.
    expect(inserters.map((f) => path.relative(REPO, f)).sort()).toEqual(KNOWN_INSERTERS);
  });
});

const KNOWN_INSERTERS: string[] = [
  // The public order link: source public_link, created by the admin client
  // for a person with no account (its own confirmation flow).
  'apps/web/src/app/api/v1/public/order-requests/route.ts',
  // The B2B customer portal: source portal (a customer principal, never an
  // org member).
  'apps/web/src/server/services/portal.ts',
];
