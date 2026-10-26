import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MODULE_IDS,
  ORDER_ITEMS_AAL2_REQUIRED_COPY,
  ORDER_ITEMS_BUSY_COPY,
  ORDER_ITEMS_FEATURE_DISABLED_COPY,
  ORDER_ITEMS_FORBIDDEN_COPY,
  ORDER_ITEMS_INVALID_COPY,
  ORDER_ITEMS_ITEMS_UNAVAILABLE_COPY,
  ORDER_ITEMS_MFA_REQUIRED_COPY,
  ORDER_ITEMS_MODULE_DISABLED_COPY,
  parseOrderCatalogManageQuery,
  type ModuleId,
} from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * Manage order items (ordering visibility, 0413; design 4.1, 4.2, 7.2 item 4,
 * 10.2): the gates, the management list and family reads through the caller's
 * own client, and Show or Hide through set_order_catalog_visibility with its
 * refusals mapped by hint, then the catalog tags expired with { expire: 0 }.
 * Nothing is prewarmed from the write path (the no-request-path-prewarm
 * guard): after() is never asked for anything.
 */

const {
  revalidateTag,
  checkRateLimit,
  expireOrgPublicCatalogs,
  afterCallbacks,
  photosMock,
  reportError,
} = vi.hoisted(() => ({
  revalidateTag: vi.fn(),
  checkRateLimit: vi.fn(async (_k: string, _l: number, windowMs: number) => ({
    allowed: true,
    count: 1,
    resetAt: Date.now() + windowMs,
  })),
  expireOrgPublicCatalogs: vi.fn(async (_org: string) => 2),
  afterCallbacks: [] as Array<() => unknown>,
  photosMock: vi.fn(async (_ids: string[]) => new Map<string, { url: string; thumbUrl: string | null; lqip: null }>()),
  reportError: vi.fn(async () => {}),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidateTag, unstable_cache: vi.fn((fn: unknown) => fn) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit }));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('./public-catalog', () => ({ expireOrgPublicCatalogs }));
vi.mock('next/server', () => ({ after: (cb: () => unknown) => afterCallbacks.push(cb) }));
vi.mock('./item-images', () => ({
  ItemImagesService: class {
    primaryImagesWithThumbsForItems = photosMock;
  },
}));

import {
  canManageOrderItems,
  OrderCatalogVisibilityService,
  orderItemsManageEnabled,
} from './order-catalog-visibility';

const ORG = '0a0a0a0a-0000-4000-8000-000000000001';
const WH_A = '0b0b0b0b-0000-4000-8000-00000000000a';
const WH_B = '0b0b0b0b-0000-4000-8000-00000000000b';
const OP = '0c0c0c0c-0000-4000-8000-000000000001';
const FAMILY = '0d0d0d0d-0000-4000-8000-000000000001';
const item = (n: number) => `0e0e0e0e-0000-4000-8000-${String(n).padStart(12, '0')}`;
const MANAGE = 'orders:manage_catalog_visibility';

type Over = {
  role?: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';
  permissions?: string[];
  modules?: ModuleId[];
  mfaRequired?: boolean;
  mfaSatisfied?: boolean;
  mfaEnrolled?: boolean;
};

function serviceWith(results: Parameters<typeof makeSupabaseStub>[0] = {}, over: Over = {}) {
  const stub = makeSupabaseStub(results);
  const ctx = {
    ...makeServiceContext(stub.client, {
      organizationId: ORG,
      userId: 'user-1',
      role: over.role ?? 'manager',
      permissions: new Set(over.permissions ?? ['orders:request', MANAGE]),
      enabledModules: new Set(over.modules ?? DEFAULT_MODULE_IDS),
      mfaRequired: over.mfaRequired ?? false,
      mfaSatisfied: over.mfaSatisfied ?? true,
    }),
    mfaEnrolled: over.mfaEnrolled ?? false,
  };
  return { stub, ctx, service: new OrderCatalogVisibilityService(ctx as never) };
}

function row(n: number, over: Record<string, unknown> = {}) {
  return {
    id: item(n),
    name: `Example item ${n}`,
    sku: `SKU-${n}`,
    barcode: null,
    item_type: 'product',
    variant_size: null,
    warehouse_id: WH_A,
    category_id: null,
    group_id: null,
    order_catalog_visible: true,
    order_catalog_visibility_changed_at: null,
    awaiting_first_receipt: false,
    author: null,
    cover: null,
    warehouse: { name: 'Main' },
    category: null,
    family: null,
    ...over,
  };
}

/** The recorded chain of the first inventory_items read, as [method, args]. */
function itemChain(stub: ReturnType<typeof makeSupabaseStub>) {
  const methods = stub.chainsAll.get('inventory_items.select')?.[0] ?? [];
  const args = stub.chainArgsAll.get('inventory_items.select')?.[0] ?? [];
  return methods.map((m, i) => [m, args[i]] as [string, unknown[]]);
}

beforeEach(() => {
  vi.clearAllMocks();
  afterCallbacks.length = 0;
  vi.stubEnv('ORDER_ITEMS_MANAGE_ORGS', '*');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── What the service may write ─────────────────────────────────────────────

describe('the service writes through the one function only', () => {
  it('never names public_visibility, and writes no table directly (design 11.1 row 6)', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const src = readFileSync(path.resolve(__dirname, 'order-catalog-visibility.ts'), 'utf8');
    expect(src).not.toMatch(/public_visibility/);
    expect(src).not.toMatch(/\.(insert|update|upsert|delete)\s*\(/);
    expect(src.match(/\.rpc\(/g)).toHaveLength(1);
    expect(src).toContain("rpc('set_order_catalog_visibility'");
  });
});

// ─── The rollout switch ─────────────────────────────────────────────────────

describe('orderItemsManageEnabled (ORDER_ITEMS_MANAGE_ORGS)', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['   ', false],
    ['*', true],
    [` ${ORG.toUpperCase()} `, true],
    [`other-org,${ORG}`, true],
    ['other-org', false],
    [',', false],
  ])('%j -> %s', (value, on) => {
    if (value === undefined) vi.stubEnv('ORDER_ITEMS_MANAGE_ORGS', undefined as never);
    else vi.stubEnv('ORDER_ITEMS_MANAGE_ORGS', value);
    expect(orderItemsManageEnabled(ORG)).toBe(on);
  });

  it('canManageOrderItems: the Orders module, the switch and the effective permission', () => {
    const base = { organizationId: ORG, role: 'staff' as const, enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS) };
    expect(canManageOrderItems({ ...base, permissions: new Set([MANAGE]) } as never)).toBe(true);
    expect(canManageOrderItems({ ...base, permissions: new Set([]) } as never)).toBe(false);
    // The role default alone never proves a platform-managed key.
    expect(canManageOrderItems({ ...base, role: 'manager' } as never)).toBe(false);
    expect(
      canManageOrderItems({
        ...base,
        permissions: new Set([MANAGE]),
        enabledModules: new Set<ModuleId>(['inventory']),
      } as never),
    ).toBe(false);
    vi.stubEnv('ORDER_ITEMS_MANAGE_ORGS', '');
    expect(canManageOrderItems({ ...base, permissions: new Set([MANAGE]) } as never)).toBe(false);
  });
});

// ─── Gates ──────────────────────────────────────────────────────────────────

describe('the gates come first, in order, before anything is read or written', () => {
  const cases: Array<[string, Over, string | undefined, string, string, string]> = [
    ['the Orders module off', { modules: ['inventory'] }, '*', 'module_disabled', 'module_disabled', ORDER_ITEMS_MODULE_DISABLED_COPY],
    ['the switch off', {}, '', 'forbidden', 'feature_disabled', ORDER_ITEMS_FEATURE_DISABLED_COPY],
    ['an enrolled factor not used this session', { mfaRequired: true, mfaSatisfied: false, mfaEnrolled: true }, '*', 'forbidden', 'aal2_required', ORDER_ITEMS_AAL2_REQUIRED_COPY],
    ['a policy that requires a factor not set up', { mfaRequired: true, mfaSatisfied: false }, '*', 'forbidden', 'mfa_required', ORDER_ITEMS_MFA_REQUIRED_COPY],
    ['no capability (denied by StockPilot)', { permissions: ['orders:request'] }, '*', 'forbidden', 'forbidden', ORDER_ITEMS_FORBIDDEN_COPY],
  ];

  it.each(cases)('%s', async (_label, over, switchValue, code, reason, message) => {
    vi.stubEnv('ORDER_ITEMS_MANAGE_ORGS', switchValue ?? '');
    for (const call of ['list', 'family', 'set'] as const) {
      const { stub, service } = serviceWith({}, over);
      const run =
        call === 'list'
          ? service.list(parseOrderCatalogManageQuery({}))
          : call === 'family'
            ? service.familyMembers(FAMILY)
            : service.setVisibility({ itemIds: [item(1)], visible: false, operationId: OP, surface: 'web' });
      await expect(run).rejects.toMatchObject({ code, message, details: { reason } });
      expect(stub.fromCalls).toEqual([]);
      expect(stub.rpcCalls).toEqual([]);
    }
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it('the module comes before the switch, and the switch before MFA', async () => {
    vi.stubEnv('ORDER_ITEMS_MANAGE_ORGS', '');
    const both = serviceWith({}, { modules: ['inventory'], mfaRequired: true, mfaSatisfied: false });
    await expect(both.service.list(parseOrderCatalogManageQuery({}))).rejects.toMatchObject({
      details: { reason: 'module_disabled' },
    });
    const switchAndMfa = serviceWith({}, { mfaRequired: true, mfaSatisfied: false });
    await expect(switchAndMfa.service.list(parseOrderCatalogManageQuery({}))).rejects.toMatchObject({
      details: { reason: 'feature_disabled' },
    });
  });
});

// ─── The management list ────────────────────────────────────────────────────

describe('list: one page of what the caller can read, through their own client', () => {
  it('base filters, name then id, 25 a page, exact count', async () => {
    const { stub, service } = serviceWith({
      'inventory_items.select': { data: [row(1)], error: null, count: 61 } as never,
    });
    const out = await service.list(parseOrderCatalogManageQuery({ page: '3' }));

    const chain = itemChain(stub);
    expect(chain[0]![0]).toBe('select');
    expect(chain[0]![1]![1]).toEqual({ count: 'exact' });
    const select = chain[0]![1]![0] as string;
    for (const col of [
      'order_catalog_visible',
      'order_catalog_visibility_changed_at',
      'awaiting_first_receipt',
      'author:custom_fields->>author',
      'warehouse:warehouses!warehouse_id (name)',
      'category:categories!category_id (name)',
      'family:product_groups!group_id (name)',
    ]) {
      expect(select).toContain(col);
    }
    expect(chain).toEqual(
      expect.arrayContaining([
        ['eq', ['organization_id', ORG]],
        ['is', ['deleted_at', null]],
        ['eq', ['status', 'active']],
        ['eq', ['is_rental', false]],
        ['or', ['is_bundle.is.null,is_bundle.eq.false']],
        ['order', ['name', { ascending: true }]],
        ['order', ['id', { ascending: true }]],
        ['range', [50, 74]],
      ]),
    );
    // Expected items are listed; nothing narrows to shown or awaiting.
    expect(chain.find(([m, a]) => m === 'eq' && a[0] === 'awaiting_first_receipt')).toBeUndefined();
    expect(chain.find(([m, a]) => m === 'eq' && a[0] === 'order_catalog_visible')).toBeUndefined();
    expect(out).toMatchObject({ organizationId: ORG, viewer: { canManage: true }, page: 3, pageSize: 25, total: 61 });
    // The caller's own client: no admin read.
    expect(stub.fromCalls).toEqual(['inventory_items']);
  });

  it('filters: hidden, books, a warehouse, a category, and a search with the ISBN forms', async () => {
    const CAT = '0f0f0f0f-0000-4000-8000-000000000001';
    const { stub, service } = serviceWith({ 'inventory_items.select': { data: [], error: null, count: 0 } as never });
    await service.list(
      parseOrderCatalogManageQuery({
        visibility: 'hidden',
        type: 'books',
        warehouseId: WH_B,
        categoryId: CAT,
        q: '0-14-240733-0',
      }),
    );
    const chain = itemChain(stub);
    expect(chain).toEqual(
      expect.arrayContaining([
        ['eq', ['order_catalog_visible', false]],
        ['eq', ['item_type', 'book']],
        ['eq', ['warehouse_id', WH_B]],
        ['eq', ['category_id', CAT]],
      ]),
    );
    const search = chain.filter(([m]) => m === 'or').map(([, a]) => a[0] as string);
    expect(search).toContainEqual(
      'name.ilike.%0-14-240733-0%,sku.ilike.%0-14-240733-0%,barcode.ilike.%0-14-240733-0%,model_number.ilike.%0-14-240733-0%,barcode.in.("0142407330","9780142407332")',
    );
  });

  it('items means every type but books; shown means order_catalog_visible', async () => {
    const { stub, service } = serviceWith({ 'inventory_items.select': { data: [], error: null, count: 0 } as never });
    await service.list(parseOrderCatalogManageQuery({ visibility: 'shown', type: 'items', q: 'tee' }));
    const chain = itemChain(stub);
    expect(chain).toContainEqual(['eq', ['order_catalog_visible', true]]);
    expect(chain).toContainEqual(['or', ['item_type.is.null,item_type.neq.book']]);
    // A plain word adds no ISBN form.
    expect(chain).toContainEqual([
      'or',
      ['name.ilike.%tee%,sku.ilike.%tee%,barcode.ilike.%tee%,model_number.ilike.%tee%'],
    ]);
  });

  it('rows: size or author, identifier, family, expected, hidden since, and one batched photo read', async () => {
    photosMock.mockResolvedValueOnce(
      new Map([
        [item(1), { url: 'https://signed/master-1', thumbUrl: 'https://signed/thumb-1', lqip: null }],
        [item(2), { url: 'https://signed/master-2', thumbUrl: null, lqip: null }],
      ]),
    );
    const { service } = serviceWith({
      'inventory_items.select': {
        data: [
          row(1, { variant_size: 'M', group_id: FAMILY, family: { name: 'Example Tee' }, barcode: '0001' }),
          row(2, { awaiting_first_receipt: true }),
          row(3, {
            item_type: 'book',
            author: 'A. Writer',
            barcode: '9780142407332',
            cover: 'https://covers.example/3.jpg',
            order_catalog_visible: false,
            order_catalog_visibility_changed_at: '2026-10-26T12:00:00.000Z',
          }),
          row(4, { item_type: 'book', cover: 'javascript:alert(1)' }),
        ],
        error: null,
        count: 4,
      } as never,
    });
    const out = await service.list(parseOrderCatalogManageQuery({}));
    expect(photosMock).toHaveBeenCalledTimes(1);
    expect(photosMock).toHaveBeenCalledWith([item(1), item(2), item(3), item(4)]);
    expect(out.rows).toEqual([
      {
        id: item(1),
        name: 'Example item 1',
        sku: 'SKU-1',
        identifier: '0001',
        itemType: 'item',
        sizeOrEdition: 'M',
        warehouseId: WH_A,
        warehouseName: 'Main',
        categoryName: null,
        familyId: FAMILY,
        familyName: 'Example Tee',
        expected: false,
        visible: true,
        hiddenSince: null,
        thumbUrl: 'https://signed/thumb-1',
      },
      expect.objectContaining({ id: item(2), expected: true, thumbUrl: 'https://signed/master-2' }),
      expect.objectContaining({
        id: item(3),
        itemType: 'book',
        sizeOrEdition: 'A. Writer',
        identifier: '9780142407332',
        visible: false,
        hiddenSince: '2026-10-26T12:00:00.000Z',
        thumbUrl: 'https://covers.example/3.jpg',
      }),
      // A stored cover that is not an http(s) URL is never sent.
      expect.objectContaining({ id: item(4), thumbUrl: null }),
    ]);
  });

  it('a failed photo read still answers the page, without photos, reported', async () => {
    photosMock.mockRejectedValueOnce(new Error('sign failed'));
    const { service } = serviceWith({
      'inventory_items.select': { data: [row(1)], error: null, count: 1 } as never,
    });
    const out = await service.list(parseOrderCatalogManageQuery({}));
    expect(out.rows[0]!.thumbUrl).toBeNull();
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('a failed list read is an internal error, never an empty list', async () => {
    const { service } = serviceWith({
      'inventory_items.select': { data: null, error: { message: 'canceling statement', code: '57014' } },
    });
    await expect(service.list(parseOrderCatalogManageQuery({}))).rejects.toMatchObject({
      code: 'internal_error',
      internalDetail: expect.stringContaining('57014'),
    });
  });
});

// ─── The family disclosure ──────────────────────────────────────────────────

describe('familyMembers: the readable records of one product family, at most 200', () => {
  it('reads by group_id with the base filters, up to one past the cap', async () => {
    const { stub, service } = serviceWith({
      'inventory_items.select': {
        data: [row(1, { group_id: FAMILY, family: { name: 'Example Tee' } }), row(2, { group_id: FAMILY })],
        error: null,
      },
    });
    const out = await service.familyMembers(FAMILY.toUpperCase());
    expect(itemChain(stub)).toEqual(
      expect.arrayContaining([
        ['eq', ['organization_id', ORG]],
        ['eq', ['group_id', FAMILY]],
        ['eq', ['is_rental', false]],
        ['range', [0, 200]],
      ]),
    );
    expect(out).toMatchObject({ organizationId: ORG, familyId: FAMILY, familyName: 'Example Tee', truncated: false });
    expect(out.rows.map((r) => r.id)).toEqual([item(1), item(2)]);
    // Never the display groups.
    expect(stub.fromCalls).not.toContain('display_groups');
  });

  it('201 readable records: 200 listed, truncated', async () => {
    const rows = Array.from({ length: 201 }, (_, i) => row(i, { group_id: FAMILY }));
    const { service } = serviceWith({ 'inventory_items.select': { data: rows, error: null } });
    const out = await service.familyMembers(FAMILY);
    expect(out.rows).toHaveLength(200);
    expect(out.truncated).toBe(true);
  });

  it('an id that is not a uuid is refused before any read', async () => {
    const { stub, service } = serviceWith();
    await expect(service.familyMembers('not-a-uuid')).rejects.toMatchObject({
      code: 'validation_error',
      message: ORDER_ITEMS_INVALID_COPY,
      details: { reason: 'invalid', field: 'groupId' },
    });
    expect(stub.fromCalls).toEqual([]);
  });
});

// ─── Show and Hide ──────────────────────────────────────────────────────────

const answerFor = (changed: string[], unchanged: string[], visible = false) => ({
  organizationId: ORG,
  operationId: OP,
  visible,
  changed,
  unchanged,
});

describe('setVisibility: the one write path', () => {
  it('sends the distinct ids in id order, lower case, as the caller, with the surface', async () => {
    const { stub, service } = serviceWith({
      'rpc:set_order_catalog_visibility': { data: answerFor([item(1)], [item(2)]), error: null },
    });
    const out = await service.setVisibility({
      itemIds: [item(2), item(1).toUpperCase(), item(2)],
      visible: false,
      operationId: OP.toUpperCase(),
      surface: 'app',
    });
    expect(stub.rpcCalls).toEqual([
      {
        name: 'set_order_catalog_visibility',
        args: {
          p_organization_id: ORG,
          p_item_ids: [item(1), item(2)],
          p_visible: false,
          p_operation_id: OP,
          p_surface: 'app',
        },
      },
    ]);
    expect(out).toEqual(answerFor([item(1)], [item(2)]));
    expect(checkRateLimit).toHaveBeenCalledWith('order-catalog-visibility:user-1', 60, 60_000);
  });

  it.each([
    ['no ids', { itemIds: [] }, 'itemIds'],
    ['not a list', { itemIds: item(1) }, 'itemIds'],
    ['a malformed id', { itemIds: ['x'] }, 'itemIds'],
    ['501 ids', { itemIds: Array.from({ length: 501 }, (_, i) => item(i)) }, 'itemIds'],
    ['visible not a boolean', { visible: 'false' }, 'visible'],
    ['no operation id', { operationId: undefined }, 'operationId'],
  ])('refuses %s before the call', async (_label, over, field) => {
    const { stub, service } = serviceWith();
    await expect(
      service.setVisibility({
        itemIds: [item(1)],
        visible: true,
        operationId: OP,
        surface: 'web',
        ...(over as object),
      }),
    ).rejects.toMatchObject({
      code: 'validation_error',
      message: ORDER_ITEMS_INVALID_COPY,
      details: { reason: 'invalid', field },
    });
    expect(stub.rpcCalls).toEqual([]);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it('500 ids, the most one call takes, are accepted', async () => {
    const ids = Array.from({ length: 500 }, (_, i) => item(i));
    const { stub, service } = serviceWith({
      'rpc:set_order_catalog_visibility': { data: answerFor([], ids, true), error: null },
    });
    await service.setVisibility({ itemIds: ids, visible: true, operationId: OP, surface: 'web' });
    expect((stub.rpcCalls[0]!.args as { p_item_ids: string[] }).p_item_ids).toHaveLength(500);
  });

  it('over the rate limit: refused as retryable, nothing sent', async () => {
    checkRateLimit.mockResolvedValueOnce({ allowed: false, count: 61, resetAt: Date.now() + 30_000 });
    const { stub, service } = serviceWith();
    await expect(
      service.setVisibility({ itemIds: [item(1)], visible: false, operationId: OP, surface: 'web' }),
    ).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'rate_limited', retryable: true, retryAfterSeconds: expect.any(Number) },
    });
    expect(stub.rpcCalls).toEqual([]);
  });

  const refusals: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    [
      'order_catalog_forbidden',
      { code: '42501', hint: 'order_catalog_forbidden', message: 'You do not have access to manage order items.' },
      { code: 'forbidden', message: ORDER_ITEMS_FORBIDDEN_COPY, details: { reason: 'forbidden' } },
    ],
    [
      'unauthenticated',
      { code: '42501', hint: 'unauthenticated', message: 'unauthenticated' },
      { code: 'forbidden', details: { reason: 'forbidden' } },
    ],
    [
      'module_disabled',
      { code: '42501', hint: 'module_disabled', message: 'module_disabled' },
      { code: 'module_disabled', message: ORDER_ITEMS_MODULE_DISABLED_COPY, details: { reason: 'module_disabled' } },
    ],
    [
      'aal2_required (a session that lost AAL2 after the gate)',
      { code: '42501', hint: 'aal2_required', message: 'x' },
      { code: 'forbidden', message: ORDER_ITEMS_AAL2_REQUIRED_COPY, details: { reason: 'aal2_required' } },
    ],
    [
      'mfa_required',
      { code: '42501', hint: 'mfa_required', message: 'x' },
      { code: 'forbidden', message: ORDER_ITEMS_MFA_REQUIRED_COPY, details: { reason: 'mfa_required' } },
    ],
    [
      'order_catalog_items_unavailable: only the ids this call sent',
      {
        code: 'P0002',
        hint: 'order_catalog_items_unavailable',
        message: 'Some selected items are no longer available to you. Nothing was changed.',
        details: JSON.stringify([item(2), '99999999-0000-4000-8000-000000000000']),
      },
      {
        code: 'conflict',
        message: ORDER_ITEMS_ITEMS_UNAVAILABLE_COPY,
        details: { reason: 'items_unavailable', itemIds: [item(2)] },
      },
    ],
    [
      'order_catalog_invalid',
      { code: '22023', hint: 'order_catalog_invalid', message: 'order_catalog_invalid', details: 'itemIds' },
      { code: 'validation_error', message: ORDER_ITEMS_INVALID_COPY, details: { reason: 'invalid', field: 'itemIds' } },
    ],
    [
      '55P03 (rows held by another change)',
      { code: '55P03', message: 'canceling statement due to lock timeout' },
      { code: 'conflict', message: ORDER_ITEMS_BUSY_COPY, details: { reason: 'busy', retryable: true, operationId: OP } },
    ],
    [
      '57014',
      { code: '57014', message: 'canceling statement due to statement timeout' },
      { code: 'conflict', details: { reason: 'busy', retryable: true } },
    ],
    [
      'anything else',
      { code: 'XX000', message: 'relation secret does not exist' },
      { code: 'internal_error', internalDetail: expect.stringContaining('relation secret') },
    ],
  ];

  it.each(refusals)('%s', async (_label, error, expected) => {
    const { service } = serviceWith({ 'rpc:set_order_catalog_visibility': { data: null, error: error as never } });
    const run = service.setVisibility({ itemIds: [item(1), item(2)], visible: false, operationId: OP, surface: 'web' });
    await expect(run).rejects.toMatchObject(expected);
    await run.catch((e: Error) => expect(e.message).not.toContain('relation secret'));
    // A refusal changed nothing: nothing to expire.
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});

describe('setVisibility: freshness after a write (design 7.2 item 4)', () => {
  it("expires this organization's catalog and its public links with expire 0, never 'max' or the global tag", async () => {
    const { service } = serviceWith({
      'rpc:set_order_catalog_visibility': { data: answerFor([item(1)], []), error: null },
    });
    await service.setVisibility({ itemIds: [item(1)], visible: false, operationId: OP, surface: 'web' });
    expect(revalidateTag.mock.calls).toEqual([[`orders-new-v2-catalog:${ORG}`, { expire: 0 }]]);
    expect(expireOrgPublicCatalogs).toHaveBeenCalledWith(ORG);
    // No warming from the write path (no-request-path-prewarm guard).
    expect(afterCallbacks).toHaveLength(0);
  });

  it('a no-op (every id already in that state) still expires the tags', async () => {
    const { service } = serviceWith({
      'rpc:set_order_catalog_visibility': { data: answerFor([], [item(1)]), error: null },
    });
    const out = await service.setVisibility({ itemIds: [item(1)], visible: false, operationId: OP, surface: 'web' });
    expect(out.changed).toEqual([]);
    expect(revalidateTag).toHaveBeenCalledTimes(1);
    expect(expireOrgPublicCatalogs).toHaveBeenCalledTimes(1);
  });

  it('a failed public link expiry is logged; the answer still stands', async () => {
    expireOrgPublicCatalogs.mockRejectedValueOnce(new Error('links read failed'));
    const { service } = serviceWith({
      'rpc:set_order_catalog_visibility': { data: answerFor([], [item(1)]), error: null },
    });
    await expect(
      service.setVisibility({ itemIds: [item(1)], visible: false, operationId: OP, surface: 'web' }),
    ).resolves.toMatchObject({ unchanged: [item(1)] });
    expect(console.warn).toHaveBeenCalled();
  });

  it('an answer for another organization, operation or state is an internal error, after refreshing', async () => {
    for (const data of [
      { ...answerFor([item(1)], []), organizationId: 'other-org' },
      { ...answerFor([item(1)], []), operationId: '0c0c0c0c-0000-4000-8000-000000000009' },
      { ...answerFor([item(1)], []), visible: true },
      { ...answerFor([item(1)], []), changed: 'x' },
      null,
    ]) {
      revalidateTag.mockClear();
      const { service } = serviceWith({ 'rpc:set_order_catalog_visibility': { data, error: null } });
      await expect(
        service.setVisibility({ itemIds: [item(1)], visible: false, operationId: OP, surface: 'web' }),
      ).rejects.toMatchObject({ code: 'internal_error' });
      // The call returned, so whatever it changed committed: refreshed anyway.
      expect(revalidateTag).toHaveBeenCalledTimes(1);
    }
  });
});
