import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  forbiddenRequesterKeys,
  REQUESTER_EXCHANGE_LINE_KEYS,
  REQUESTER_EXCHANGE_OPTION_KEYS,
  REQUESTER_EXCHANGE_OPTIONS_ANSWER_KEYS,
  REQUESTER_PHOTO_KEYS,
  REQUESTER_RETURN_SHEET_KEYS,
  REQUESTER_RETURNABLE_LINE_KEYS,
  REQUESTER_TRACKING_EXCHANGE_KEYS,
  REQUESTER_TRACKING_ITEM_KEYS,
  REQUESTER_TRACKING_LINE_KEYS,
  REQUESTER_TRACKING_RETURN_KEYS,
} from '@stockpilot/core';

import { inFilters, makeSupabaseStub, servedLikePostgrest, type MockCall } from '@/test/supabase-mock';

vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined), insertAuditRowReported: vi.fn(async () => true) }));
vi.mock('./returns-notify', () => ({
  notifyStaffNewReturnRequest: vi.fn(async () => undefined),
  notifyRequesterReturnEvent: vi.fn(async () => undefined),
}));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => undefined) }));
const reportError = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => undefined));
vi.mock('@/lib/error-reporter', () => ({ reportError }));

// The signer itself (ItemImagesService) is tested on its own, chunking at
// 1,000 paths included (item-images.test.ts L17). Here: WHO is signed, under
// which organization, and that a failure never blocks.
const imagesCalls = vi.hoisted(() => [] as Array<{ ctx: { organizationId: string; supabase: unknown }; ids: string[] }>);
const imagesAnswer = vi.hoisted(() => ({
  fn: (ids: string[]): Map<string, { url: string; thumbUrl: string | null; lqip: string | null }> =>
    new Map(ids.map((id) => [id, { url: `https://signed.example/${id}/master`, thumbUrl: `https://signed.example/${id}/thumb`, lqip: 'data:x' }])),
  fail: false,
}));
vi.mock('./item-images', () => ({
  ItemImagesService: vi.fn(function (this: unknown, ctx: { organizationId: string; supabase: unknown }) {
    return {
      primaryImagesWithThumbsForItems: async (ids: string[]) => {
        imagesCalls.push({ ctx, ids: [...ids] });
        if (imagesAnswer.fail) throw new Error('storage down');
        return imagesAnswer.fn(ids);
      },
    };
  }),
}));

import {
  exchangeOptionsForMember,
  exchangeOptionsForOrder,
  exchangeOptionsForPortal,
  exchangeOptionsForToken,
  loadMemberReturnSheet,
  loadRequesterReturnSheet,
  trackingForOrder,
  trackingRowsForOrders,
} from './returns-requester';

/**
 * The requester's reads (returns RX-3): the sizes a returned line may be
 * exchanged for, the sheet, and the requester's own requests. What leaves the
 * server is pinned key by key (core's lists); the free count, SKUs, racks,
 * dispositions, notes and reasons never do; round trips stay constant; and
 * photos are signed only for the order's own items and its sizes.
 */

const TOKEN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const ORG = 'org-1';
const USER = 'member-1';
const LINE_A = '22222222-2222-4222-8222-22222222222a';
const LINE_B = '22222222-2222-4222-8222-22222222222b';
const RET_1 = '55555555-5555-4555-8555-555555555551';
const RET_2 = '55555555-5555-4555-8555-555555555552';

const ITEMS = [
  { id: 'item-m', organization_id: ORG, name: 'New Hire Shirt', variant_size: 'M', variant_width: null, variant_color: null, jersey_number: null, sku: 'NHS-M', unit_cost: 9 },
  { id: 'item-s', organization_id: ORG, name: 'New Hire Shirt', variant_size: 'S', variant_width: null, variant_color: null, jersey_number: null, sku: 'NHS-S', unit_cost: 9 },
  { id: 'item-l', organization_id: ORG, name: 'New Hire Shirt', variant_size: 'L', variant_width: null, variant_color: null, jersey_number: null, sku: 'NHS-L', unit_cost: 9 },
  { id: 'item-xl', organization_id: ORG, name: 'New Hire Shirt', variant_size: 'XL', variant_width: null, variant_color: null, jersey_number: null, sku: 'NHS-XL', unit_cost: 9 },
  { id: 'item-nb', organization_id: ORG, name: 'Notebook', variant_size: null, variant_width: null, variant_color: null, jersey_number: null, sku: 'NB', unit_cost: 2 },
  { id: 'item-foreign', organization_id: 'org-other', name: 'Foreign', variant_size: 'L', variant_width: null, variant_color: null, jersey_number: null, sku: 'F', unit_cost: 1 },
];

const ORDER = {
  id: ORDER_ID,
  organization_id: ORG,
  status: 'completed',
  order_number: 103,
  requester_email: 'pat@example.com',
  requester_name: 'Pat Lee',
  requester_user_id: USER,
  customer_id: null,
  source: 'internal',
};

const OPTIONS_RPC = [
  {
    orderRequestLineId: LINE_A,
    returnedItemId: 'item-m',
    // Out of size order and with free counts the requester must never see.
    options: [
      { itemId: 'item-xl', variantKey: 'size:xl', free: 0 },
      { itemId: 'item-s', variantKey: 'size:s', free: 3 },
      { itemId: 'item-l', variantKey: 'size:l', free: 14 },
    ],
  },
];

function stubFor(overrides: Record<string, unknown> = {}) {
  return makeSupabaseStub({
    'order_request_secrets.select': { data: [{ order_request_id: ORDER_ID }], error: null },
    'order_requests.select': servedLikePostgrest([ORDER]),
    'organization_modules.select': { data: [{ module_id: 'returns' }], error: null },
    'order_request_lines.select': {
      data: [
        { id: LINE_A, item_id: 'item-m', quantity_fulfilled: 2, returned_quantity: 0, item: { id: 'item-m', name: 'New Hire Shirt', sku: 'NHS-M' } },
        { id: LINE_B, item_id: 'item-nb', quantity_fulfilled: 3, returned_quantity: 3, item: { id: 'item-nb', name: 'Notebook', sku: 'NB' } },
      ],
      error: null,
    },
    'return_lines.select': { data: [], error: null },
    'rpc:return_exchange_options': { data: OPTIONS_RPC, error: null },
    'inventory_items.select': servedLikePostgrest(ITEMS),
    'return_overview.select': servedLikePostgrest([]),
    ...overrides,
  } as never);
}

function keysOf(o: unknown): string[] {
  return Object.keys(o as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
  imagesCalls.length = 0;
  imagesAnswer.fail = false;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('exchange options (plan 3.6.10 through return_exchange_options)', () => {
  it('asks the predicate with the resolved order alone, sorts by the stored size, and never sends a free count', async () => {
    const stub = stubFor();
    const answer = await exchangeOptionsForOrder(stub.client, { orderRequestId: ORDER_ID, organizationId: ORG });
    expect(stub.rpcCalls).toEqual([{ name: 'return_exchange_options', args: { p_order_id: ORDER_ID } }]);
    expect(answer.exchangesEnabled).toBe(true);
    expect(answer.lines).toHaveLength(1);
    const [line] = answer.lines;
    expect(line!.orderRequestLineId).toBe(LINE_A);
    expect(line!.options.map((o) => o.sizeLabel)).toEqual(['Size S', 'Size L', 'Size XL']);
    expect(line!.options.map((o) => o.availability)).toEqual(['available', 'available', 'not_in_stock']);
    expect(line!.options[0]).toEqual({
      itemId: 'item-s',
      name: 'New Hire Shirt',
      sizeLabel: 'Size S',
      availability: 'available',
      photo: { url: 'https://signed.example/item-s/master', thumbUrl: 'https://signed.example/item-s/thumb' },
    });
    // The count, the SKU, the cost and the variant key never leave.
    const json = JSON.stringify(answer);
    expect(json).not.toMatch(/"free"|NHS-|unit_cost|variantKey|size:/);
    expect(forbiddenRequesterKeys(answer)).toEqual([]);
  });

  it('payload pin: every object carries exactly core key list', async () => {
    const answer = await exchangeOptionsForOrder(stubFor().client, { orderRequestId: ORDER_ID, organizationId: ORG });
    expect(keysOf(answer)).toEqual([...REQUESTER_EXCHANGE_OPTIONS_ANSWER_KEYS]);
    for (const line of answer.lines) {
      expect(keysOf(line)).toEqual([...REQUESTER_EXCHANGE_LINE_KEYS]);
      for (const o of line.options) {
        expect(keysOf(o)).toEqual([...REQUESTER_EXCHANGE_OPTION_KEYS]);
        if (o.photo) expect(keysOf(o.photo)).toEqual([...REQUESTER_PHOTO_KEYS]);
      }
    }
  });

  it('signs photos only for the sizes offered, under the order organization, with the service-role client', async () => {
    const stub = stubFor();
    await exchangeOptionsForOrder(stub.client, { orderRequestId: ORDER_ID, organizationId: ORG });
    expect(imagesCalls).toHaveLength(1);
    expect(imagesCalls[0]!.ctx.organizationId).toBe(ORG);
    expect(imagesCalls[0]!.ctx.supabase).toBe(stub.client);
    expect([...imagesCalls[0]!.ids].sort()).toEqual(['item-l', 'item-s', 'item-xl']);
    // The labels too: the organization and exactly those ids.
    const labelRead = stub.chainArgsAll.get('inventory_items.select')!;
    expect(labelRead).toHaveLength(1);
    expect(labelRead[0]).toContainEqual(['organization_id', ORG]);
  });

  it('constant round trips whatever the line count: one predicate call, one item read, one photo read', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      orderRequestLineId: `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`,
      returnedItemId: 'item-m',
      options: [
        { itemId: 'item-s', variantKey: 'size:s', free: 1 },
        { itemId: 'item-l', variantKey: 'size:l', free: 1 },
        { itemId: 'item-xl', variantKey: 'size:xl', free: 1 },
      ],
    }));
    const stub = stubFor({ 'rpc:return_exchange_options': { data: many, error: null } });
    const answer = await exchangeOptionsForOrder(stub.client, { orderRequestId: ORDER_ID, organizationId: ORG });
    expect(answer.lines).toHaveLength(12);
    expect(stub.rpcCalls).toHaveLength(1);
    expect(stub.fromCalls.filter((t) => t === 'inventory_items')).toHaveLength(1);
    expect(imagesCalls).toHaveLength(1);
  });

  it('a photo that cannot be signed is a missing photo, reported, never an error (brief 27)', async () => {
    imagesAnswer.fail = true;
    const answer = await exchangeOptionsForOrder(stubFor().client, { orderRequestId: ORDER_ID, organizationId: ORG });
    expect(answer.lines[0]!.options.every((o) => o.photo === null)).toBe(true);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ tag: 'returns.requester.photos' }));
  });

  it('an option the item read cannot name (not in the organization) is not offered', async () => {
    const stub = stubFor({
      'rpc:return_exchange_options': {
        data: [{ orderRequestLineId: LINE_A, returnedItemId: 'item-m', options: [{ itemId: 'item-foreign', free: 5 }, { itemId: 'item-l', free: 1 }] }],
        error: null,
      },
    });
    const answer = await exchangeOptionsForOrder(stub.client, { orderRequestId: ORDER_ID, organizationId: ORG });
    expect(answer.lines[0]!.options.map((o) => o.itemId)).toEqual(['item-l']);
  });

  it('a line with nothing to offer is left out (its exchange is "warehouse will review")', async () => {
    const stub = stubFor({ 'rpc:return_exchange_options': { data: [], error: null } });
    const answer = await exchangeOptionsForOrder(stub.client, { orderRequestId: ORDER_ID, organizationId: ORG });
    expect(answer).toEqual({ exchangesEnabled: true, lines: [] });
    expect(stub.fromCalls).not.toContain('inventory_items');
    expect(imagesCalls).toHaveLength(0);
  });

  it('the kill switch: nothing is read and Exchange is hidden', async () => {
    vi.stubEnv('RETURNS_EXCHANGE_CREATE', 'off');
    const stub = stubFor();
    expect(await exchangeOptionsForOrder(stub.client, { orderRequestId: ORDER_ID, organizationId: ORG })).toEqual({
      exchangesEnabled: false,
      lines: [],
    });
    expect(stub.rpcCalls).toEqual([]);
  });

  it('a failed predicate is an internal error (the screen offers Try again), never an empty list', async () => {
    const stub = stubFor({ 'rpc:return_exchange_options': { data: null, error: { message: 'permission denied' } } });
    await expect(exchangeOptionsForOrder(stub.client, { orderRequestId: ORDER_ID, organizationId: ORG })).rejects.toMatchObject({
      code: 'internal_error',
    });
  });
});

describe('who may ask: the token, the portal principal, the member', () => {
  it('the token resolves its one order through the side table and is never handed to the database function', async () => {
    const stub = stubFor();
    const answer = await exchangeOptionsForToken(stub.client, TOKEN);
    expect(answer?.lines).toHaveLength(1);
    expect(stub.chainArgsAll.get('order_request_secrets.select')?.[0]).toContainEqual(['return_token', TOKEN]);
    expect(JSON.stringify(stub.rpcCalls)).not.toContain(TOKEN);
    // The order row's own token column is never asked.
    expect(JSON.stringify(stub.chainArgsAll.get('order_requests.select'))).not.toContain('return_token');
  });

  it.each([
    ['an unknown token', { 'order_request_secrets.select': { data: [], error: null } }],
    ['an order not handed over', { 'order_requests.select': servedLikePostgrest([{ ...ORDER, status: 'in_transit' }]) }],
    ['the returns module off', { 'organization_modules.select': { data: [], error: null } }],
  ])('%s is the closed door (null) and the predicate never runs', async (_label, overrides) => {
    const stub = stubFor(overrides);
    expect(await exchangeOptionsForToken(stub.client, TOKEN)).toBeNull();
    expect(stub.rpcCalls).toEqual([]);
  });

  it('a malformed token never reaches the database', async () => {
    const stub = stubFor();
    expect(await exchangeOptionsForToken(stub.client, 'not-a-token')).toBeNull();
    expect(stub.fromCalls).toEqual([]);
  });

  it("a member: their own order only (requester, organization), never another member's, never a portal order", async () => {
    const stub = stubFor();
    const answer = await exchangeOptionsForMember(stub.client, { organizationId: ORG, userId: USER, orderRequestId: ORDER_ID });
    expect(answer?.lines).toHaveLength(1);
    const read = stub.chainArgsAll.get('order_requests.select')![0]!;
    expect(read).toContainEqual(['requester_user_id', USER]);
    expect(read).toContainEqual(['organization_id', ORG]);

    const other = stubFor();
    expect(await exchangeOptionsForMember(other.client, { organizationId: ORG, userId: 'someone-else', orderRequestId: ORDER_ID })).toBeNull();
    expect(other.rpcCalls).toEqual([]);

    const foreignOrg = stubFor();
    expect(await exchangeOptionsForMember(foreignOrg.client, { organizationId: 'org-other', userId: USER, orderRequestId: ORDER_ID })).toBeNull();

    const portal = stubFor({ 'order_requests.select': servedLikePostgrest([{ ...ORDER, source: 'portal', customer_id: 'c-1' }]) });
    expect(await exchangeOptionsForMember(portal.client, { organizationId: ORG, userId: USER, orderRequestId: ORDER_ID })).toBeNull();
    expect(portal.rpcCalls).toEqual([]);
  });

  it("a portal customer: their own customer's order only", async () => {
    const order = { ...ORDER, source: 'portal', customer_id: 'c-1' };
    const stub = stubFor({ 'order_requests.select': servedLikePostgrest([order]) });
    const answer = await exchangeOptionsForPortal(stub.client, { organizationId: ORG, customerId: 'c-1', orderRequestId: ORDER_ID });
    expect(answer?.lines).toHaveLength(1);
    expect(stub.chainArgsAll.get('order_requests.select')![0]).toContainEqual(['customer_id', 'c-1']);
    const other = stubFor({ 'order_requests.select': servedLikePostgrest([order]) });
    expect(await exchangeOptionsForPortal(other.client, { organizationId: ORG, customerId: 'c-2', orderRequestId: ORDER_ID })).toBeNull();
    expect(other.rpcCalls).toEqual([]);
  });
});

// ── Tracking ────────────────────────────────────────────────────────────────

const OVERVIEW = [
  {
    id: RET_1,
    organization_id: ORG,
    order_request_id: ORDER_ID,
    source: 'requester',
    return_number: 'RMA-20261011-AAA111',
    status: 'received',
    created_at: '2026-10-01T10:00:00Z',
    exchange_status: 'ready_for_pickup',
    exchange_lines: [
      // Asked for L, the warehouse approved XL: substituted.
      { return_line_id: 'rl-1', status: 'approved', requested_item_id: 'item-l', requested_quantity: 1, approved_item_id: 'item-xl', approved_quantity: 1 },
    ],
    lines: [
      { line_id: 'rl-1', item_id: 'item-m', quantity: 1, disposition: 'restock', applied: false },
      { line_id: 'rl-2', item_id: 'item-nb', quantity: 2, disposition: 'scrap', applied: false },
    ],
    replacement_order_number: 104,
    replacement_status: 'staged_for_pickup',
    replacement_owed: 1,
    // Columns the tracking never asks for, served anyway by a careless select:
    requester_email: 'pat@example.com',
    requested_by: 'member-1',
  },
  {
    id: RET_2,
    organization_id: ORG,
    order_request_id: ORDER_ID,
    source: 'requester',
    return_number: 'RMA-20261011-BBB222',
    status: 'requested',
    created_at: '2026-10-05T10:00:00Z',
    exchange_status: 'requested',
    // "Warehouse will review": a note, no item.
    exchange_lines: [{ return_line_id: 'rl-3', status: 'requested', requested_item_id: null, requested_quantity: 1, approved_item_id: null, approved_quantity: null }],
    lines: [{ line_id: 'rl-3', item_id: 'item-m', quantity: 1, disposition: 'restock', applied: false }],
    replacement_order_number: null,
    replacement_status: null,
    replacement_owed: null,
  },
  // A return staff created: never on the requester's page (D15).
  {
    id: '55555555-5555-4555-8555-555555555553',
    organization_id: ORG,
    order_request_id: ORDER_ID,
    source: 'internal',
    return_number: 'RMA-STAFF',
    status: 'approved',
    created_at: '2026-10-06T10:00:00Z',
    exchange_status: 'none',
    exchange_lines: [],
    lines: [{ line_id: 'rl-9', item_id: 'item-m', quantity: 1, disposition: 'scrap', applied: false }],
    replacement_order_number: null,
    replacement_status: null,
    replacement_owed: null,
  },
];

describe("tracking: the requester's own requests (brief 28, D15)", () => {
  it('reads the overview for requester-made RMAs of these orders in the organization, never the disposition, email or reasons', async () => {
    const stub = stubFor({ 'return_overview.select': servedLikePostgrest(OVERVIEW) });
    const rows = await trackingRowsForOrders(stub.client, ORG, [ORDER_ID]);
    expect(rows.map((r) => r.tracking.returnNumber)).toEqual(['RMA-20261011-BBB222', 'RMA-20261011-AAA111']);
    const args = stub.chainArgsAll.get('return_overview.select')![0]!;
    expect(args).toContainEqual(['organization_id', ORG]);
    expect(args).toContainEqual(['source', 'requester']);
    const select = String(args[0]![0]);
    expect(select).not.toMatch(/disposition|requester_email|requested_by|notes|reason|deleted_users|warehouse|counter|released/);
  });

  it('per line: what goes back, what comes instead, "changed by the warehouse", and the warehouse-review request', async () => {
    const stub = stubFor({ 'return_overview.select': servedLikePostgrest(OVERVIEW) });
    const tracking = await trackingForOrder(stub.client, ORG, ORDER_ID);
    const [newer, older] = tracking;
    expect(older).toEqual({
      returnNumber: 'RMA-20261011-AAA111',
      createdAt: '2026-10-01T10:00:00Z',
      returnStatus: 'received',
      exchangeStatus: 'ready_for_pickup',
      sentences: ['Return received.', 'Replacement ready for pickup.'],
      replacementOrderNumber: 'SO-000104',
      lines: [
        {
          returning: { name: 'New Hire Shirt', sizeLabel: 'Size M', quantity: 1 },
          exchange: { state: 'approved', replacement: { name: 'New Hire Shirt', sizeLabel: 'Size XL', quantity: 1 }, substituted: true },
        },
        { returning: { name: 'Notebook', sizeLabel: null, quantity: 2 }, exchange: null },
      ],
    });
    expect(newer).toMatchObject({
      returnStatus: 'requested',
      exchangeStatus: 'requested',
      sentences: ['Exchange requested. The warehouse will review it.'],
      replacementOrderNumber: null,
      lines: [{ returning: { name: 'New Hire Shirt', sizeLabel: 'Size M', quantity: 1 }, exchange: { state: 'requested', replacement: null, substituted: false } }],
    });
  });

  it('payload pin and redaction: core key lists, no rack, Staging, disposition, stock count, note, reason or person', async () => {
    const stub = stubFor({ 'return_overview.select': servedLikePostgrest(OVERVIEW) });
    const tracking = await trackingForOrder(stub.client, ORG, ORDER_ID);
    for (const t of tracking) {
      expect(keysOf(t)).toEqual([...REQUESTER_TRACKING_RETURN_KEYS]);
      for (const l of t.lines) {
        expect(keysOf(l)).toEqual([...REQUESTER_TRACKING_LINE_KEYS]);
        expect(keysOf(l.returning)).toEqual([...REQUESTER_TRACKING_ITEM_KEYS]);
        if (l.exchange) {
          expect(keysOf(l.exchange)).toEqual([...REQUESTER_TRACKING_EXCHANGE_KEYS]);
          if (l.exchange.replacement) expect(keysOf(l.exchange.replacement)).toEqual([...REQUESTER_TRACKING_ITEM_KEYS]);
        }
      }
    }
    expect(forbiddenRequesterKeys(tracking)).toEqual([]);
    const json = JSON.stringify(tracking);
    expect(json).not.toMatch(/restock|scrap|disposition|staging|pat@example\.com|member-1|RMA-STAFF|NHS-/i);
  });

  it('a cancelled replacement has no SO on the page; a cancelled line still shows the item it had', async () => {
    const rows = [
      {
        ...OVERVIEW[0]!,
        exchange_status: 'replacement_cancelled',
        exchange_lines: [{ return_line_id: 'rl-1', status: 'cancelled', requested_item_id: 'item-l', requested_quantity: 1, approved_item_id: 'item-l', approved_quantity: 1 }],
        replacement_status: 'cancelled',
      },
    ];
    const stub = stubFor({ 'return_overview.select': servedLikePostgrest(rows) });
    const [t] = await trackingForOrder(stub.client, ORG, ORDER_ID);
    expect(t!.replacementOrderNumber).toBeNull();
    expect(t!.sentences).toEqual(['Return received.', 'Your replacement was cancelled. The warehouse will follow up.']);
    expect(t!.lines[0]!.exchange).toEqual({ state: 'cancelled', replacement: { name: 'New Hire Shirt', sizeLabel: 'Size L', quantity: 1 }, substituted: false });
  });

  it('one overview read and one item read for many orders; a failed read shows nothing, reported (fails closed)', async () => {
    const stub = stubFor({ 'return_overview.select': servedLikePostgrest(OVERVIEW) });
    await trackingRowsForOrders(stub.client, ORG, [ORDER_ID, '11111111-1111-4111-8111-111111111112', '11111111-1111-4111-8111-111111111113']);
    expect(stub.fromCalls.filter((t) => t === 'return_overview')).toHaveLength(1);
    expect(stub.fromCalls.filter((t) => t === 'inventory_items')).toHaveLength(1);
    const ov = stub.chainsAll.get('return_overview.select')![0]!;
    expect(ov).toContain('in');

    const broken = stubFor({ 'return_overview.select': { data: null, error: { message: 'relation does not exist' } } });
    expect(await trackingRowsForOrders(broken.client, ORG, [ORDER_ID])).toEqual([]);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ tag: 'returns.requester.tracking' }));
  });
});

describe('the sheet (token page, member, portal)', () => {
  it("the token page's sheet: the returnable lines with names, sizes and photos (no SKU), the switch, the tracking", async () => {
    const stub = stubFor({ 'return_overview.select': servedLikePostgrest(OVERVIEW) });
    const sheet = await loadRequesterReturnSheet(stub.client, TOKEN);
    expect(sheet).not.toBeNull();
    expect(keysOf(sheet)).toEqual([...REQUESTER_RETURN_SHEET_KEYS]);
    expect(sheet!.orderNumber).toBe('SO-000103');
    expect(sheet!.requesterName).toBe('Pat Lee');
    expect(sheet!.exchangesEnabled).toBe(true);
    // The fully returned notebook line is not returnable.
    expect(sheet!.lines).toEqual([
      {
        orderRequestLineId: LINE_A,
        name: 'New Hire Shirt',
        sizeLabel: 'Size M',
        photo: { url: 'https://signed.example/item-m/master', thumbUrl: 'https://signed.example/item-m/thumb' },
        quantityFulfilled: 2,
        quantityRemaining: 2,
      },
    ]);
    for (const l of sheet!.lines) expect(keysOf(l)).toEqual([...REQUESTER_RETURNABLE_LINE_KEYS]);
    expect(sheet!.tracking).toHaveLength(2);
    expect(forbiddenRequesterKeys(sheet)).toEqual([]);
    expect(JSON.stringify(sheet)).not.toMatch(/NHS-|"sku"|itemSku|"itemId"/);
    // Photos: the returnable items only (not the returned-in-full notebook).
    expect(imagesCalls.map((c) => c.ids)).toEqual([['item-m']]);
  });

  it('the kill switch reaches the sheet; a closed door is null', async () => {
    vi.stubEnv('RETURNS_EXCHANGE_CREATE', 'off');
    expect((await loadRequesterReturnSheet(stubFor().client, TOKEN))?.exchangesEnabled).toBe(false);
    expect(await loadRequesterReturnSheet(stubFor({ 'order_request_secrets.select': { data: [], error: null } }).client, TOKEN)).toBeNull();
  });

  it("a member's own order's sheet; another member's order is null", async () => {
    const own = await loadMemberReturnSheet(stubFor().client, { organizationId: ORG, userId: USER, orderRequestId: ORDER_ID });
    expect(own?.lines).toHaveLength(1);
    expect(await loadMemberReturnSheet(stubFor().client, { organizationId: ORG, userId: 'someone-else', orderRequestId: ORDER_ID })).toBeNull();
  });

  it('labels that cannot be read still give a sheet (the order line names stand in), reported', async () => {
    const stub = stubFor({
      'inventory_items.select': (call: MockCall) => {
        const ids = inFilters(call)[0]?.[1] ?? [];
        return ids.includes('item-m') && !ids.includes('item-l') ? { data: null, error: { message: 'boom' } } : servedLikePostgrest(ITEMS)(call);
      },
    });
    const sheet = await loadRequesterReturnSheet(stub.client, TOKEN);
    expect(sheet!.lines[0]).toMatchObject({ name: 'New Hire Shirt', sizeLabel: null });
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ tag: 'returns.requester.sheet_labels' }));
  });
});
