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
    // their own sources through insert_order_request_with_lines (0413 review
    // fix round), one transaction, so no client insert remains anywhere.
    expect(inserters.map((f) => path.relative(REPO, f)).sort()).toEqual([]);
  });

  it('the public link and the portal each write an order in one insert_order_request_with_lines call', () => {
    const callers = FILES.flatMap((f) => {
      const hits = readFileSync(f, 'utf8').match(/rpc\(\s*['"`]insert_order_request_with_lines['"`]/g);
      return hits ? hits.map(() => path.relative(REPO, f)) : [];
    });
    expect(callers.sort()).toEqual(KNOWN_ONE_WRITE_CALLERS);
    // The track token's side row goes in inside that call, never as a client
    // insert after the header (a failed second call used to strand a header).
    const sideRowInserters = FILES.filter((f) =>
      /from\(\s*['"`]order_request_secrets['"`]\s*\)\s*\.insert\(/.test(readFileSync(f, 'utf8')),
    );
    expect(sideRowInserters).toEqual([]);
  });
});

const KNOWN_ONE_WRITE_CALLERS: string[] = [
  // The public order link: source public_link, for a person with no account
  // (its own confirmation flow); the header, track token row and lines.
  'apps/web/src/app/api/v1/public/order-requests/route.ts',
  // The B2B customer portal: source portal (a customer principal, never an
  // org member); the header and lines.
  'apps/web/src/server/services/portal.ts',
];

/**
 * NEW DEMAND (ordering visibility, 0413). Every client write of
 * order_request_lines in product code, by kind. Each is gated in the database
 * (the order-visibility trigger fires on INSERT and on a raised quantity, for
 * every role, the service role included), and each is listed so a new writer
 * fails here and gets reviewed. Add items is NOT a client write any more: it
 * is one add_order_request_lines call (one transaction), so no service-role
 * top-up remains; nor are the portal's and the public link's new orders.
 */
const LINE_WRITE = /from\(\s*['"`]order_request_lines['"`]\s*\)\s*\.(insert|update|upsert|delete)\(/g;

function lineWriters(): string[] {
  const out: string[] = [];
  for (const f of FILES) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(LINE_WRITE)) out.push(`${path.relative(REPO, f)}#${m[1]}`);
  }
  return out.sort();
}

const KNOWN_LINE_WRITERS: string[] = [
  // The public order link's and the portal's lines are no client write: they
  // go in inside insert_order_request_with_lines (above), where the gate's
  // refusal rolls the whole order back.
  // OrderRequestsService.updateLineQuantity (service role: lines have no
  // UPDATE policy). A raise is gated; lowering never is.
  'apps/web/src/server/services/order-requests.ts#update',
  // OrderRequestsService.removeLine (service role). Removal is never new demand.
  'apps/web/src/server/services/order-requests.ts#delete',
];

describe('every client write of order_request_lines is a known, gated writer (0413)', () => {
  it('lists exactly the known writers', () => {
    expect(lineWriters()).toEqual([...KNOWN_LINE_WRITERS].sort());
  });

  it('Add items is one add_order_request_lines call in the service', () => {
    const svc = readFileSync(
      path.join(REPO, 'apps/web/src/server/services/order-requests.ts'),
      'utf8',
    );
    expect(svc.match(/rpc\('add_order_request_lines'/g)).toHaveLength(1);
    // The top-up helper is reached only from inside the database function.
    const callers = FILES.filter((f) =>
      /['"`]_order_request_line_top_up['"`]/.test(readFileSync(f, 'utf8')),
    );
    expect(callers).toEqual([]);
    // The partial-change path is gone: nothing names its refusal or words, and
    // the one order-requests.ts UPDATE above is updateLineQuantity's (Add
    // items writes no line with the admin client any more).
    const partial = FILES.filter((f) =>
      /\baddLinesPartialRefusal\b|\bADD_LINES_PARTIAL_COPY\b|\bfailAfterWrite\b/.test(readFileSync(f, 'utf8')),
    );
    expect(partial).toEqual([]);
  });

  it('control: the census sees a multi-line builder chain', () => {
    const sample = "await admin\n  .from('order_request_lines')\n  .update({ quantity_requested: 2 })";
    expect([...sample.matchAll(LINE_WRITE)].map((m) => m[1])).toEqual(['update']);
  });
});
