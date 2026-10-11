import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Returns RX-3 guards over the requester's code paths (the token page and
 * its two public routes, the member routes, the portal actions, and the
 * requester half of the returns service):
 *
 *   • none of them reads the staff-only decision log (reasons, racks, staff
 *     names) or the restock options (racks and Staging), nor the staff
 *     replacement search (any orderable item), plan RX-3 tests;
 *   • none of them signs a storage path itself or runs inside a cached
 *     function: photos go through ItemImagesService (chunked at 1,000
 *     paths, the per-path cache its own), pattern 13;
 *   • none reads the order row's own token column (tokens live in
 *     order_request_secrets, read only by the resolver), sec-orders 0392.
 *
 * Comments are stripped first, so a comment may name what the code never
 * does.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../..');

function code(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** The requester half of returns.ts: from its section marker to the end. */
function requesterHalfOfReturnsService(): string {
  const text = readFileSync(join(SRC, 'server/services/returns.ts'), 'utf8');
  const at = text.indexOf('// ── Requester-initiated returns');
  expect(at).toBeGreaterThan(0);
  return text
    .slice(at)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const REQUESTER_FILES = [
  'server/services/returns-requester.ts',
  'app/api/v1/public/returns/route.ts',
  'app/api/v1/public/returns/options/route.ts',
  'app/api/v1/orders/[id]/return-request/route.ts',
  'app/api/v1/orders/[id]/return-request/options/route.ts',
  'app/api/v1/orders/[id]/return-request/http.ts',
  'server/actions/portal.ts',
  'app/returns/request/[token]/page.tsx',
];

describe('the requester code paths (returns RX-3)', () => {
  const sources: Array<[string, string]> = [
    ...REQUESTER_FILES.map((f) => [f, code(f)] as [string, string]),
    ['server/services/returns.ts (requester half)', requesterHalfOfReturnsService()],
  ];

  it.each(sources)('%s never reads the decision log, the restock options or the staff search', (_file, text) => {
    expect(text).not.toMatch(/return_decisions|return_restock_options|restockOptions|return_exchange_candidates|candidatesForOrder/);
  });

  it.each(sources)('%s never signs a path itself and never caches', (_file, text) => {
    expect(text).not.toMatch(/createSignedUrls?\b|unstable_cache|'use cache'/);
  });

  it.each(sources)("%s never reads the order row's own token column", (_file, text) => {
    expect(text).not.toMatch(/return_token|public_track_token/);
  });

  it('the requester service reads the overview without the staff columns', () => {
    const text = code('server/services/returns-requester.ts');
    const select = /TRACKING_COLUMNS\s*=\s*'([^']+)'/.exec(text)?.[1] ?? '';
    expect(select).toContain('exchange_status');
    for (const col of select.split(',').map((c) => c.trim())) {
      expect(col).not.toMatch(/disposition|requester_email|requester_name|requested_by|deleted_users|warehouse_id|reason|notes|released_early|counter/);
    }
  });
});
