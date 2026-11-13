import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GUARD (table-driven): a module state the API context could not read is never
 * answered as a success or as the caller's own fault (docket S81).
 *
 * The real withApiContext runs on its legacy reads with the organization's
 * module rows unreadable, and the real route runs behind it. Every route in
 * the table must answer one of exactly three ways:
 *   - '5xx': a server error the phone retries, never a 2xx and never a 4xx;
 *   - 'marker': the API context gate's 503 marked as refused before any write
 *     (the two routes the phone cannot send twice), with no table read past
 *     the context;
 *   - 'no-ai': the barcode lookup still answers, with the paid AI description
 *     closed (the one route where the module only gates an optional extra).
 *
 * WHY A TABLE, NOT A SOURCE SCAN. The error is thrown deep inside services,
 * wherever a module is asked about, so which catch receives it is a question
 * of the call graph, not of the catch's own text. A scan of catch clauses
 * would flag every catch-all and still miss one that only some service path
 * reaches. The table names the routes whose catches were reviewed for it; a
 * catch found later is added here.
 */

const refs = vi.hoisted(() => ({
  client: null as unknown,
  /** Made-up values: the client double ignores them, and no model is called. */
  projectUrl: 'https://example.supabase.co',
  publicValue: 'test-public-value',
  modelValue: 'test-model-value',
}));

vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: refs.projectUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: refs.publicValue,
    GEMINI_API_KEY: refs.modelValue,
  },
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => refs.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => refs.client }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, resetAt: Date.now() + 60_000 })),
}));
vi.mock('@/server/loaders/inventory-list', () => ({ revalidateInventoryList: vi.fn() }));
vi.mock('@/lib/upc-lookup', () => ({
  lookupUpc: vi.fn(async () => ({
    source: 'upcitemdb',
    enrichment: {
      name: 'Sample Widget',
      description: null,
      brand: 'Sample Brand',
      modelNumber: null,
      imageUrl: null,
    },
  })),
  buildAiDescriptionPrompt: vi.fn(() => 'prompt'),
}));

import { contextUnavailableBody, isRefusedBeforeAnyWrite } from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';
import { ModulesUnavailableError } from '@/lib/modules/module-state';
import { lookupUpc } from '@/lib/upc-lookup';
import {
  legacyContextClient,
  legacyContextWorld,
  legacyPhoneHeaders,
  routeWork,
  type LegacyContextWorld,
} from '@/test/legacy-api-context';

import { POST as scanPOST } from './po-imports/scan/route';
import { POST as escalatePOST } from './v1/exceptions/[id]/escalate/route';
import { GET as upcGET } from './v1/items/upc-lookup/route';
import { GET as announcementsGET } from './v1/me/announcements/route';
import { GET as snapshotGET } from './v1/mobile/snapshot/route';
import { POST as receiveLinePOST } from './v1/po/[id]/receive-line/route';
import { GET as borrowersGET } from './v1/rentals/borrowers/route';
import { POST as rentalsPOST } from './v1/rentals/route';

const WAREHOUSE = '11111111-0000-4000-8000-000000000003';
const ITEM = '22222222-0000-4000-8000-000000000004';
const PO = '33333333-0000-4000-8000-000000000005';
const PO_LINE = '44444444-0000-4000-8000-000000000006';
const KEY = '55555555-0000-4000-8000-000000000007';
const OCCURRENCE = '66666666-0000-4000-8000-000000000008';
const ORIGIN = 'https://app.example.test';

let world: LegacyContextWorld;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  world = legacyContextWorld({ role: 'admin', moduleRowsFail: true });
  refs.client = legacyContextClient(world);
});

function json(path: string, body: unknown): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: legacyPhoneHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

function get(path: string): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, { headers: legacyPhoneHeaders() });
}

function scan(mode: 'separate' | 'combined'): Request {
  const fd = new FormData();
  fd.append('file', new File([new Uint8Array(16)], 'first.pdf', { type: 'application/pdf' }));
  fd.append('file', new File([new Uint8Array(16)], 'second.pdf', { type: 'application/pdf' }));
  if (mode === 'separate') fd.append('mode', 'separate');
  return new Request(`${ORIGIN}/api/po-imports/scan`, {
    method: 'POST',
    headers: legacyPhoneHeaders(),
    body: fd,
  });
}

type Expected = '5xx' | 'marker' | 'no-ai';

const ROUTES: Array<[string, Expected, () => Promise<Response>]> = [
  ['GET /api/v1/mobile/snapshot', '5xx', () => snapshotGET(get('/api/v1/mobile/snapshot'))],
  [
    'POST /api/v1/rentals (checkout)',
    'marker',
    () =>
      rentalsPOST(
        json('/api/v1/rentals', {
          warehouseId: WAREHOUSE,
          borrowerName: 'Sample Borrower',
          expectedReturnAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          lines: [{ itemId: ITEM, quantity: 1 }],
        }),
      ),
  ],
  [
    'POST /api/v1/exceptions/[id]/escalate',
    'marker',
    () =>
      escalatePOST(
        json(`/api/v1/exceptions/${OCCURRENCE}/escalate`, {
          subject: 'Sample subject',
          description: 'Sample description.',
        }),
        { params: Promise.resolve({ id: OCCURRENCE }) },
      ),
  ],
  [
    'POST /api/v1/po/[id]/receive-line',
    '5xx',
    () => {
      world.singles.purchase_orders = {
        id: PO,
        status: 'ordered',
        destination_location_id: null,
        supplier_id: null,
      };
      world.lists.purchase_order_items = [
        { id: PO_LINE, item_id: ITEM, quantity_ordered: 5, quantity_received: 0, unit_cost: 2 },
      ];
      return receiveLinePOST(
        json(`/api/v1/po/${PO}/receive-line`, {
          itemId: ITEM,
          qty: 1,
          warehouseId: WAREHOUSE,
          idempotencyKey: KEY,
        }),
        { params: Promise.resolve({ id: PO }) },
      );
    },
  ],
  ['GET /api/v1/rentals/borrowers', '5xx', () => borrowersGET(get('/api/v1/rentals/borrowers'))],
  ['GET /api/v1/me/announcements', '5xx', () => announcementsGET(get('/api/v1/me/announcements'))],
  ['POST /api/po-imports/scan (separate)', '5xx', () => scanPOST(scan('separate'))],
  ['POST /api/po-imports/scan (combined)', '5xx', () => scanPOST(scan('combined'))],
  [
    'GET /api/v1/items/upc-lookup',
    'no-ai',
    () => upcGET(get('/api/v1/items/upc-lookup?upc=012345678905')),
  ],
];

describe('routes with the module state unreadable', () => {
  it.each(ROUTES)('%s answers %s', async (_route, expected, send) => {
    const res = await send();
    if (expected === '5xx') {
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(res.status).toBeLessThan(600);
      // The refusal is this one, not some other failure of the double.
      expect(
        vi.mocked(reportError).mock.calls.some(([e]) => e instanceof ModulesUnavailableError),
      ).toBe(true);
      return;
    }
    if (expected === 'marker') {
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error?: unknown; details?: unknown };
      expect(body).toEqual(contextUnavailableBody());
      expect(
        isRefusedBeforeAnyWrite({ status: 503, code: body.error, details: body.details }),
      ).toBe(true);
      expect(routeWork(world)).toEqual([]);
      return;
    }
    // no-ai: the lookup answers, and the paid AI description is closed.
    expect(res.status).toBe(200);
    expect(vi.mocked(lookupUpc)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(lookupUpc).mock.calls[0]![1]).toEqual(
      expect.objectContaining({ enableAiFallback: false, describeWithAi: undefined }),
    );
  });

  it('the barcode lookup with the AI module on still offers the AI description (control)', async () => {
    world.moduleRowsFail = false;
    world.moduleRows = ['ai'];
    const res = await upcGET(get('/api/v1/items/upc-lookup?upc=012345678905'));
    expect(res.status).toBe(200);
    expect(vi.mocked(lookupUpc).mock.calls[0]![1]).toEqual(
      expect.objectContaining({ enableAiFallback: true }),
    );
  });
});
