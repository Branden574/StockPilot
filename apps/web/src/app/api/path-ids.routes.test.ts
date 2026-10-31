import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A malformed record id in an API path answers 400 before anything is read
 * (B63). These routes handed the path id straight to a service, whose uuid
 * filter made PostgREST answer with an error: 500 (a report filed by the five
 * document routes), or 403 from the item barcode. Fourteen more checked the
 * id with /^[0-9a-f-]{36}$/i, which 36 hyphens pass, and reached the same
 * 500. Each now checks the id with the strict uuid check:
 *   - after authentication, so a signed-out caller still gets 401 whatever
 *     the id (nine of these read params before they authenticated);
 *   - before the id is used, the shared export budget is spent or the AI
 *     limiter is counted, and before a permission check that follows the 401.
 * The phone's order mutations keep their per-user limiter ahead of the check,
 * as the submission routes do (`limiterFirst`).
 *
 * The static half (every dynamic route, the first use of each id) is
 * app/path-ids.guard.test.ts.
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/export-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/export-rate-limit')>()),
  exportRateLimited: vi.fn(async () => null),
}));
vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: vi.fn(async () => ({
    allowed: true,
    remaining: 100,
    resetAt: Date.now() + 60_000,
  })),
}));
vi.mock('@/lib/error-reporter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/error-reporter')>()),
  reportError: vi.fn(async () => {}),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    throw new Error('the admin client is not expected on these paths');
  },
}));

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { exportRateLimited } from '@/lib/export-rate-limit';
import { checkRateLimit } from '@/lib/rate-limit';
import { makeServiceContext } from '@/test/supabase-mock';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type Handler = (
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

const GOOD = '0a000000-0000-4000-8000-000000000b63';
/** Ids that are not uuids: a word, and two of 36 characters the loose
 *  pattern let through. */
const MALFORMED = ['not-a-uuid', '-'.repeat(36), 'f'.repeat(36)];

const ORDER = { error: 'validation_error', message: 'That order id is not valid.' };
const PO = { error: 'validation_error', message: 'That purchase order id is not valid.' };
const PO_IMPORT = { error: 'validation_error', message: 'That PO import id is not valid.' };
const CYCLE_COUNT = { error: 'validation_error', message: 'That cycle count id is not valid.' };
const INVALID_ID = { error: 'invalid_id' };

interface Row {
  name: string;
  load: () => Promise<Record<string, unknown>>;
  method: Method;
  /** The path params; `bad` names the one given a malformed id. */
  params: Record<string, string>;
  bad: string;
  /** Builds the request path for a params set. */
  path: (p: Record<string, string>) => string;
  body?: unknown;
  /** The 400's JSON body, or its text for the barcode's plain-text answers. */
  json?: Record<string, unknown>;
  text?: string;
  headers?: Record<string, string>;
  /** The per-user limiter runs before the check, by design. */
  limiterFirst?: boolean;
}

const order = (
  name: string,
  file: string,
  load: Row['load'],
  method: Method,
  extra: Partial<Row> = {},
): Row => ({
  name: `${name} (${file})`,
  load,
  method,
  params: { id: GOOD },
  bad: 'id',
  path: (p) => `/api/${file.replace('[id]', p.id!)}`,
  json: ORDER,
  ...extra,
});

/** The 18 route files (20 handlers) that used the id unchecked. */
const UNCHECKED: Row[] = [
  order(
    'pick slip',
    'orders/[id]/pick-slip.pdf',
    () => import('./orders/[id]/pick-slip.pdf/route'),
    'GET',
  ),
  order(
    'customer packing slip',
    'orders/[id]/packing-slip-customer.pdf',
    () => import('./orders/[id]/packing-slip-customer.pdf/route'),
    'GET',
  ),
  order(
    'warehouse packing slip',
    'orders/[id]/packing-slip-warehouse.pdf',
    () => import('./orders/[id]/packing-slip-warehouse.pdf/route'),
    'GET',
  ),
  order(
    'signature',
    'orders/[id]/signature',
    () => import('./orders/[id]/signature/route'),
    'GET',
    {
      headers: { 'cache-control': 'private, no-store' },
    },
  ),
  order(
    "signature, the phone's alias",
    'v1/orders/[id]/signature',
    () => import('./v1/orders/[id]/signature/route'),
    'GET',
    {
      headers: { 'cache-control': 'private, no-store' },
    },
  ),
  {
    name: 'purchase order PDF (purchase-orders/[id]/pdf)',
    load: () => import('./purchase-orders/[id]/pdf/route'),
    method: 'GET',
    params: { id: GOOD },
    bad: 'id',
    path: (p) => `/api/purchase-orders/${p.id}/pdf`,
    json: PO,
  },
  {
    name: 'purchase order attachments zip (purchase-orders/[id]/attachments.zip)',
    load: () => import('./purchase-orders/[id]/attachments.zip/route'),
    method: 'GET',
    params: { id: GOOD },
    bad: 'id',
    path: (p) => `/api/purchase-orders/${p.id}/attachments.zip`,
    json: PO,
  },
  {
    name: 'PO import CSV (po-imports/[id]/export.csv)',
    load: () => import('./po-imports/[id]/export.csv/route'),
    method: 'GET',
    params: { id: GOOD },
    bad: 'id',
    path: (p) => `/api/po-imports/${p.id}/export.csv`,
    json: PO_IMPORT,
  },
  {
    name: 'cycle count PDF (cycle-counts/[id]/pdf)',
    load: () => import('./cycle-counts/[id]/pdf/route'),
    method: 'GET',
    params: { id: GOOD },
    bad: 'id',
    path: (p) => `/api/cycle-counts/${p.id}/pdf`,
    json: CYCLE_COUNT,
  },
  {
    name: 'AI shelf scan (cycle-counts/[id]/ai-scan)',
    load: () => import('./cycle-counts/[id]/ai-scan/route'),
    method: 'POST',
    params: { id: GOOD },
    bad: 'id',
    path: (p) => `/api/cycle-counts/${p.id}/ai-scan`,
    json: CYCLE_COUNT,
  },
  {
    name: 'item barcode (v1/items/[id]/barcode)',
    load: () => import('./v1/items/[id]/barcode/route'),
    method: 'GET',
    params: { id: GOOD },
    bad: 'id',
    path: (p) => `/api/v1/items/${p.id}/barcode`,
    text: 'That item id is not valid.',
  },
  order('order detail', 'v1/orders/[id]', () => import('./v1/orders/[id]/route'), 'GET'),
  order(
    'transition',
    'v1/orders/[id]/transition',
    () => import('./v1/orders/[id]/transition/route'),
    'POST',
    {
      body: { action: 'approve' },
      limiterFirst: true,
    },
  ),
  order('add lines', 'v1/orders/[id]/lines', () => import('./v1/orders/[id]/lines/route'), 'POST', {
    body: { lines: [{ itemId: GOOD, quantity: 1 }] },
    limiterFirst: true,
  }),
  order(
    'change a line',
    'v1/orders/[id]/lines',
    () => import('./v1/orders/[id]/lines/route'),
    'PATCH',
    {
      body: { lineId: GOOD, quantity: 2 },
      limiterFirst: true,
    },
  ),
  order(
    'remove a line',
    'v1/orders/[id]/lines',
    () => import('./v1/orders/[id]/lines/route'),
    'DELETE',
    {
      path: (p) => `/api/v1/orders/${p.id}/lines?lineId=${GOOD}`,
      limiterFirst: true,
    },
  ),
  order(
    'pick a line',
    'v1/orders/[id]/pick-line',
    () => import('./v1/orders/[id]/pick-line/route'),
    'POST',
    {
      body: { lineId: GOOD, quantity: 1 },
      limiterFirst: true,
    },
  ),
  order(
    'shipment',
    'v1/orders/[id]/shipping',
    () => import('./v1/orders/[id]/shipping/route'),
    'GET',
  ),
  order(
    'buy a label',
    'v1/orders/[id]/shipping/label',
    () => import('./v1/orders/[id]/shipping/label/route'),
    'POST',
    {
      body: { rateId: 'rate_example' },
    },
  ),
  order(
    'shop rates',
    'v1/orders/[id]/shipping/rates',
    () => import('./v1/orders/[id]/shipping/rates/route'),
    'POST',
    {
      body: { parcel: { weight_oz: 8, length_in: 6, width_in: 4, height_in: 2 } },
      limiterFirst: true,
    },
  ),
  order(
    'reconcile a stuck shipment',
    'v1/orders/[id]/shipping/reconcile',
    () => import('./v1/orders/[id]/shipping/reconcile/route'),
    'POST',
  ),
];

const swap = (
  name: string,
  file: string,
  load: Row['load'],
  method: Method,
  extra: Partial<Row> = {},
): Row => ({
  name: `${name} (${file})`,
  load,
  method,
  params: { id: GOOD },
  bad: 'id',
  path: (p) => `/api/${Object.entries(p).reduce((f, [k, v]) => f.replace(`[${k}]`, v), file)}`,
  json: INVALID_ID,
  ...extra,
});

/** The 14 route files whose loose 36-character pattern became the strict check (same answers). */
const LOOSE: Row[] = [
  swap(
    'confirm an AI scan',
    'cycle-counts/[id]/ai-scan/[scanId]/confirm',
    () => import('./cycle-counts/[id]/ai-scan/[scanId]/confirm/route'),
    'POST',
    {
      params: { id: GOOD, scanId: GOOD },
      bad: 'scanId',
    },
  ),
  swap(
    'distribute a bundle',
    'v1/bundles/[id]/distribute',
    () => import('./v1/bundles/[id]/distribute/route'),
    'POST',
  ),
  swap(
    'clear a count line (count id)',
    'v1/cycle-counts/[id]/lines/[lineId]/clear',
    () => import('./v1/cycle-counts/[id]/lines/[lineId]/clear/route'),
    'POST',
    {
      params: { id: GOOD, lineId: GOOD },
    },
  ),
  swap(
    'clear a count line (line id)',
    'v1/cycle-counts/[id]/lines/[lineId]/clear',
    () => import('./v1/cycle-counts/[id]/lines/[lineId]/clear/route'),
    'POST',
    {
      params: { id: GOOD, lineId: GOOD },
      bad: 'lineId',
    },
  ),
  swap(
    'record a count line (count id)',
    'v1/cycle-counts/[id]/lines/[lineId]/record',
    () => import('./v1/cycle-counts/[id]/lines/[lineId]/record/route'),
    'POST',
    {
      params: { id: GOOD, lineId: GOOD },
    },
  ),
  swap(
    'record a count line (line id)',
    'v1/cycle-counts/[id]/lines/[lineId]/record',
    () => import('./v1/cycle-counts/[id]/lines/[lineId]/record/route'),
    'POST',
    {
      params: { id: GOOD, lineId: GOOD },
      bad: 'lineId',
    },
  ),
  swap(
    'post a count',
    'v1/cycle-counts/[id]/post',
    () => import('./v1/cycle-counts/[id]/post/route'),
    'POST',
  ),
  swap(
    'reassign a count',
    'v1/cycle-counts/[id]/reassign',
    () => import('./v1/cycle-counts/[id]/reassign/route'),
    'POST',
  ),
  swap(
    'release a count',
    'v1/cycle-counts/[id]/release',
    () => import('./v1/cycle-counts/[id]/release/route'),
    'POST',
  ),
  swap(
    'receive a PO line',
    'v1/po/[id]/receive-line',
    () => import('./v1/po/[id]/receive-line/route'),
    'POST',
    {
      json: { error: 'invalid_po_id' },
    },
  ),
  swap(
    "a group's variants",
    'v1/product-groups/[id]/variants',
    () => import('./v1/product-groups/[id]/variants/route'),
    'GET',
    {
      limiterFirst: true,
    },
  ),
  swap(
    'complete a size count',
    'v1/size-counts/[id]/complete',
    () => import('./v1/size-counts/[id]/complete/route'),
    'POST',
  ),
  swap(
    'size count events',
    'v1/size-counts/[id]/events',
    () => import('./v1/size-counts/[id]/events/route'),
    'POST',
  ),
  swap('a size count', 'v1/size-counts/[id]', () => import('./v1/size-counts/[id]/route'), 'GET'),
  swap(
    'scan a size sticker',
    'v1/size-counts/[id]/scan',
    () => import('./v1/size-counts/[id]/scan/route'),
    'POST',
  ),
  swap(
    'delete a training sample',
    'v1/size-counts/training/samples/[id]',
    () => import('./v1/size-counts/training/samples/[id]/route'),
    'DELETE',
  ),
];

/** Every property read of the database client: none is expected. */
const clientReads: string[] = [];
const untouchableClient = new Proxy(
  {},
  {
    get(_target, prop) {
      clientReads.push(String(prop));
      throw new Error(`the database client was used: ${String(prop)}`);
    },
  },
);

function signIn() {
  vi.mocked(withApiContext).mockResolvedValue(
    makeServiceContext(untouchableClient, { role: 'owner' }) as never,
  );
}

async function call(row: Row, params: Record<string, string>) {
  const mod = await row.load();
  const handler = mod[row.method] as Handler;
  expect(typeof handler, `${row.name} exports ${row.method}`).toBe('function');
  const req = new NextRequest(`https://test.local${row.path(params)}`, {
    method: row.method,
    ...(row.body !== undefined
      ? { body: JSON.stringify(row.body), headers: { 'content-type': 'application/json' } }
      : {}),
  });
  return handler(req, { params: Promise.resolve(params) });
}

beforeEach(() => {
  vi.clearAllMocks();
  clientReads.length = 0;
  process.env.NEXT_PUBLIC_APP_URL = 'https://test.local';
});

const ALL = [...UNCHECKED, ...LOOSE];

describe('a malformed record id in an API path answers 400 before anything is read (B63)', () => {
  it('covers the 18 route files that used the id unchecked and the 14 with the loose pattern', async () => {
    const files = (rows: Row[]) => new Set(rows.map((r) => r.name.replace(/^.*\((.*)\)$/, '$1')));
    // The signature alias re-exports the same handler: 18 files plus the alias.
    expect(files(UNCHECKED).size).toBe(19);
    expect(files(LOOSE).size).toBe(14);
  });

  it.each(ALL.map((r) => [r.name, r] as const))(
    '%s: signed out with a malformed id is still 401',
    async (_n, row) => {
      vi.mocked(withApiContext).mockResolvedValue(null);
      const res = await call(row, { ...row.params, [row.bad]: 'not-a-uuid' });
      expect(res.status).toBe(401);
      expect(clientReads).toEqual([]);
    },
  );

  it.each(ALL.map((r) => [r.name, r] as const))(
    '%s: signed in, a malformed id is 400 with nothing read, spent or reported',
    async (_n, row) => {
      for (const bad of MALFORMED) {
        signIn();
        vi.mocked(checkRateLimit).mockClear();
        const res = await call(row, { ...row.params, [row.bad]: bad });
        expect([bad, res.status]).toEqual([bad, 400]);
        if (row.text !== undefined) {
          expect(await res.text()).toBe(row.text);
        } else {
          expect([bad, await res.json()]).toEqual([bad, row.json]);
        }
        for (const [name, value] of Object.entries(row.headers ?? {})) {
          expect(res.headers.get(name)).toBe(value);
        }
        expect([bad, clientReads]).toEqual([bad, []]);
        expect(exportRateLimited).not.toHaveBeenCalled();
        expect(reportError).not.toHaveBeenCalled();
        if (!row.limiterFirst) expect(checkRateLimit).not.toHaveBeenCalled();
      }
    },
  );
});
