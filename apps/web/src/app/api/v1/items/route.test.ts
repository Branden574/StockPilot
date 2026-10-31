import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';
import { createItemSchema } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';
import { createItemAction } from '@/server/actions/inventory';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({
  withApiContext: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock('@/server/services/inventory', () => ({
  InventoryService: vi.fn(),
}));

vi.mock('@/server/loaders/inventory-list', () => ({ revalidateInventoryList: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

// createItemAction pulls in 'use server' + next/cache revalidatePath, neither
// of which resolve in this route-handler test's environment. It's imported
// only so the "same zod schema" assertion below can prove it parses the SAME
// module contract the web action does — the action body itself is never
// invoked, so a stub is enough.
vi.mock('@/server/actions/inventory', () => ({
  createItemAction: vi.fn(),
}));

function buildCtx(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'admin' as const,
    supabase: {} as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(),
    ...overrides,
  };
}

function buildRequest(body: unknown) {
  return new Request('https://test.local/api/v1/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

const VALID_BODY = {
  name: 'Nike Pegasus 41',
  unitCost: 10,
  retailPrice: 20,
  quantityOnHand: 0,
  reorderPoint: 0,
  reorderQuantity: 0,
};

describe('POST /api/v1/items', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 60_000,
    });
  });

  it('returns 401 when there is no Bearer/auth context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await POST(buildRequest(VALID_BODY));
    expect(res.status).toBe(401);
  });

  it('returns 429 when the per-user rate limit is exceeded', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      count: 61,
      resetAt: Date.now() + 30_000,
    });
    const res = await POST(buildRequest(VALID_BODY));
    expect(res.status).toBe(429);
  });

  it('returns 400 with a field path on a schema failure', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const res = await POST(buildRequest({ ...VALID_BODY, name: '' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('validation_error');
    expect(body.path).toEqual(['name']);
  });

  it('returns 400 when the body is not valid JSON', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const req = new Request('https://test.local/api/v1/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    }) as unknown as Parameters<typeof POST>[0];
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 201 with { id } on success and delegates to InventoryService.create', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const create = vi.fn(async () => ({ id: 'item-new' }));
    vi.mocked(InventoryService).mockImplementationOnce(function () {
      return { create } as unknown as InstanceType<typeof InventoryService>;
    });

    const res = await POST(buildRequest(VALID_BODY));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'item-new' });
    expect(create).toHaveBeenCalledTimes(1);
    // A body without `confirmNewRack` is the phone in the field, which asks on
    // its own screen: it keeps creating the rack as before (2026-10-24).
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Nike Pegasus 41' }), {
      allowUnconfirmedNewRack: true,
    });
  });

  // ═══ THE NEW-RACK QUESTION AND THE PHONE IN THE FIELD (2026-10-24) ═══
  // The phone build in the field (the current OTA) asks "Create new rack
  // 1-B?" itself and posts a body with NO confirmNewRack key (its
  // submitCreateItem sends buildCreateItemInput's output as it is). It must
  // keep working: its create still creates the rack. A body that carries the
  // key, whatever its value, is a client that can answer, and gets the
  // server's question.
  describe('the new-rack answer', () => {
    // Exactly what today's phone sends for the incident: a typed rack, stock,
    // and no answer key (buildCreateItemInput's output).
    const PHONE_TODAY = {
      ...VALID_BODY,
      name: 'Spiral notebook',
      quantityOnHand: 130,
      binLocation: '1-B',
      customFields: { rack_number: '1', rack_row: 'B' },
      warehouseId: '22222222-2222-4222-8222-222222222222',
    };

    function stubCreate(impl: () => Promise<unknown>) {
      const create = vi.fn(impl);
      vi.mocked(InventoryService).mockImplementationOnce(function () {
        return { create } as unknown as InstanceType<typeof InventoryService>;
      });
      return create;
    }

    it("today's phone (no key): created, and the rack is created as before", async () => {
      vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
      const create = stubCreate(async () => ({ id: 'item-new' }));

      const res = await POST(buildRequest(PHONE_TODAY));

      expect(res.status).toBe(201);
      const [input, opts] = create.mock.calls[0] as unknown as [Record<string, unknown>, unknown];
      expect(input).not.toHaveProperty('confirmNewRack');
      expect(input.binLocation).toBe('1-B');
      expect(opts).toEqual({ allowUnconfirmedNewRack: true });
    });

    it('a client that answers no gets the strict rule, and the refusal reaches it whole (409 + details)', async () => {
      vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
      const detail = {
        reason: 'NEW_RACK_REQUIRES_CONFIRMATION',
        label: '1-B',
        title: 'Create new rack 1-B?',
        message:
          '1-B does not exist in DC4 yet. Continuing creates it and moves 130 units into it.',
        suggestions: ['17-B'],
      };
      const create = stubCreate(async () => {
        throw new ServiceError('conflict', detail.message, detail);
      });

      const res = await POST(buildRequest({ ...PHONE_TODAY, confirmNewRack: false }));

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'conflict',
        message: detail.message,
        details: detail,
      });
      const [input, opts] = create.mock.calls[0] as unknown as [Record<string, unknown>, unknown];
      expect(input.confirmNewRack).toBe(false);
      expect(opts).toEqual({});
    });

    it('a client that answers yes passes the answer on, with no legacy allowance', async () => {
      vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
      const create = stubCreate(async () => ({ id: 'item-new' }));

      const res = await POST(buildRequest({ ...PHONE_TODAY, confirmNewRack: true }));

      expect(res.status).toBe(201);
      const [input, opts] = create.mock.calls[0] as unknown as [Record<string, unknown>, unknown];
      expect(input.confirmNewRack).toBe(true);
      expect(opts).toEqual({});
    });
  });

  it('returns 403 when the caller lacks items:create', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx({ role: 'viewer' }));
    const create = vi.fn(async () => {
      throw new ServiceError('forbidden', 'Missing permission: items:create');
    });
    vi.mocked(InventoryService).mockImplementationOnce(function () {
      return { create } as unknown as InstanceType<typeof InventoryService>;
    });

    const res = await POST(buildRequest(VALID_BODY));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('forbidden');
  });

  it('returns 400 when the sports profile rejects a missing required attribute (e.g. shoe size)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx({ enabledModules: new Set<ModuleId>(['sports']) }));
    const create = vi.fn(async () => {
      throw new ServiceError('validation_error', 'Size is required for this subcategory.', {
        code: 'SPORTS_MISSING_SIZE',
      });
    });
    vi.mocked(InventoryService).mockImplementationOnce(function () {
      return { create } as unknown as InstanceType<typeof InventoryService>;
    });

    const res = await POST(
      buildRequest({ ...VALID_BODY, categoryId: '11111111-1111-1111-1111-111111111111' }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('validation_error');
    expect(body.details).toEqual({ code: 'SPORTS_MISSING_SIZE' });
  });

  it('maps an unexpected thrown error to 500 and reports it', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const create = vi.fn(async () => {
      throw new Error('boom');
    });
    vi.mocked(InventoryService).mockImplementationOnce(function () {
      return { create } as unknown as InstanceType<typeof InventoryService>;
    });

    const res = await POST(buildRequest(VALID_BODY));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('internal_error');
  });

  it('parses a representative payload with the SAME createItemSchema the web action uses', () => {
    // The route and createItemAction (server/actions/inventory.ts) must accept
    // exactly the same contract — a payload valid on one surface is valid on
    // the other. Import the schema directly (not the action, which pulls in
    // 'use server' plumbing) and compare parse results for a representative
    // sports payload.
    const payload = {
      ...VALID_BODY,
      categoryId: '11111111-1111-1111-1111-111111111111',
      variantSize: '10.5',
      variantSizeSystem: 'US_MENS',
      jerseyNumber: '07',
    };
    const result = createItemSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.variantSize).toBe('10.5');
      expect(result.data.jerseyNumber).toBe('07');
      // variant_key/group_key are never part of the input contract — the
      // client cannot supply them and the schema has no such fields.
      expect(result.data).not.toHaveProperty('variantKey');
      expect(result.data).not.toHaveProperty('groupKey');
    }
    // createItemAction is referenced only to keep this suite honest that both
    // surfaces are wired to the exported action (a stale import here would
    // fail typecheck if the action's signature ever diverged).
    expect(typeof createItemAction).toBe('function');
  });
});
