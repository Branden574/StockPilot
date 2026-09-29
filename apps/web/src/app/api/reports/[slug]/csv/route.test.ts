import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

/**
 * Security invariant (2026-09-28): the report CSV dispatcher checks the
 * caller BEFORE it spends the shared export budget, and answers every
 * refusal with its real status.
 *
 * Before: the export rate limit ran first, so a caller WITHOUT reports:export
 * (or with an unknown slug) spent the shared 40/hour budget on refused
 * requests, tripped the security.export_rate_limited alert and was then told
 * 429 instead of 403; reports:read and the report's modules were never
 * checked here at all (reports:export alone let a caller export a report
 * they cannot open); the check ignored the MFA step-up; and every
 * ServiceError (forbidden, not_found, validation_error, module_disabled)
 * came back as 500.
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/export-rate-limit', () => ({ exportRateLimited: vi.fn(async () => null) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    throw new Error('the CSV path must not use the service-role client');
  },
}));

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { exportRateLimited } from '@/lib/export-rate-limit';
import { ServiceError } from '@/server/services/context';
import { ReportsService } from '@/server/services/reports';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { GET } from './route';

const ITEM = '11111111-2222-4333-8444-555555555555';

function stub() {
  return makeSupabaseStub({
    'rpc:report_movement_type_summary': {
      data: [{ movement_type: 'add', movement_count: 2, total_qty: 5 }],
      error: null,
    },
    'rpc:report_top_movers': {
      data: [{ item_id: 'i1', sku: 'SKU-1', name: 'Item 1', total_in: 5, total_out: 0, movement_count: 2 }],
      error: null,
    },
    'rpc:report_bundle_activity': { data: [], error: null },
    'rpc:report_bundle_component_value': { data: [], error: null },
    'inventory_items.select': { data: { id: ITEM }, error: null },
    'purchase_order_items.select': { data: [], error: null },
    'receipt_lines.select': { data: [], error: null },
  });
}

type Overrides = Parameters<typeof makeServiceContext>[1] & { mfaEnrolled?: boolean };
function signIn(overrides: Overrides = {}) {
  const s = stub();
  const { mfaEnrolled, ...rest } = overrides;
  const ctx = { ...makeServiceContext(s.client, { role: 'manager', ...rest }), mfaEnrolled };
  vi.mocked(withApiContext).mockResolvedValue(ctx as never);
  return s;
}

async function get(slug: string, qs = '') {
  const res = await GET(new Request(`https://test.local/api/reports/${slug}/csv${qs}`), {
    params: Promise.resolve({ slug }),
  });
  let body: Record<string, unknown> | null = null;
  const text = await res.text();
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = null;
  }
  return { status: res.status, body, text, cacheControl: res.headers.get('cache-control') };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.mocked(exportRateLimited).mockResolvedValue(null);
});

describe('GET /api/reports/[slug]/csv: the caller is checked before the export budget', () => {
  it('no session: 401, the budget untouched', async () => {
    vi.mocked(withApiContext).mockResolvedValue(null);
    const r = await get('stock-movements', '?days=30');
    expect(r.status).toBe(401);
    expect(exportRateLimited).not.toHaveBeenCalled();
  });

  it('no reports:export: 403, and the refused request spends no export budget', async () => {
    signIn({ role: 'staff' });
    const r = await get('stock-movements', '?days=30');
    expect(r.status).toBe(403);
    expect(r.body?.error).toBe('forbidden');
    expect(exportRateLimited).not.toHaveBeenCalled();
  });

  it('reports:export without reports:read: 403 (an export is still a read of the report)', async () => {
    const s = signIn({ role: 'viewer', permissions: new Set(['reports:export']) });
    const r = await get('stock-movements', '?days=30');
    expect(r.status).toBe(403);
    expect(r.body?.message).toMatch(/reports:read/);
    expect(exportRateLimited).not.toHaveBeenCalled();
    expect(s.rpcCalls).toEqual([]);
  });

  it('an enrolled AAL1 session: 403 aal2_required (the MFA step-up), budget untouched', async () => {
    signIn({ role: 'owner', mfaRequired: true, mfaSatisfied: false, mfaEnrolled: true });
    const r = await get('stock-movements', '?days=30');
    expect(r.status).toBe(403);
    expect((r.body?.details as { reason?: string } | undefined)?.reason).toBe('aal2_required');
    expect(exportRateLimited).not.toHaveBeenCalled();
  });

  it('the bundles module off: bundle-activity is 403 module_disabled, budget untouched', async () => {
    signIn({ enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS.filter((m) => m !== 'bundles')) });
    const r = await get('bundle-activity', '?days=90');
    expect(r.status).toBe(403);
    expect(r.body?.error).toBe('module_disabled');
    expect(exportRateLimited).not.toHaveBeenCalled();
  });

  it('an unknown report: 404, budget untouched', async () => {
    signIn();
    const r = await get('everything', '');
    expect(r.status).toBe(404);
    expect(exportRateLimited).not.toHaveBeenCalled();
  });

  it('an unknown report: 404 in the shared shape, never cached', async () => {
    signIn();
    const r = await get('everything', '');
    expect(r.body).toEqual({ error: 'not_found', message: 'Unknown report' });
    expect(r.cacheControl).toBe('no-store');
  });

  it.each([
    ['', 'itemId is required'],
    ['?itemId=not-a-uuid', 'Choose an item.'],
  ])('item-cost-history with %j: 400, budget untouched', async (qs, message) => {
    signIn();
    const r = await get('item-cost-history', qs);
    expect(r.status).toBe(400);
    expect(r.body?.error).toBe('validation_error');
    expect(r.body?.message).toBe(message);
    expect(exportRateLimited).not.toHaveBeenCalled();
  });

  // Review finding (2026-09-29): a charterId that is not a uuid went to
  // PostgREST, which answered 22P02, and the export answered 500 (reported
  // to the error tracker) after spending the budget.
  it('inventory-valuation with a charterId that is not a uuid: 400, budget untouched, nothing read', async () => {
    const s = signIn();
    const r = await get('inventory-valuation', '?charterId=not-a-uuid');
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'validation_error', message: 'Choose a charter.' });
    expect(exportRateLimited).not.toHaveBeenCalled();
    expect(s.fromCalls).toEqual([]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('a permitted caller over the limit: 429 from the limiter, after the checks', async () => {
    const s = signIn();
    vi.mocked(exportRateLimited).mockResolvedValue(
      new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 }) as never,
    );
    const r = await get('stock-movements', '?days=30');
    expect(r.status).toBe(429);
    expect(exportRateLimited).toHaveBeenCalledTimes(1);
    expect(s.rpcCalls).toEqual([]);
  });

  it('a permitted caller: 200 CSV, read with the caller\'s client', async () => {
    const s = signIn();
    const r = await get('stock-movements', '?days=30');
    expect(r.status).toBe(200);
    expect(r.text).toContain('SKU-1');
    expect(s.rpcCalls.map((c) => c.name).sort()).toEqual([
      'report_movement_type_summary',
      'report_top_movers',
    ]);
  });
});

describe('GET /api/reports/[slug]/csv: a ServiceError keeps its real status', () => {
  it.each([
    ['not_found', 404],
    ['validation_error', 400],
    ['forbidden', 403],
    ['module_disabled', 403],
    ['unauthenticated', 401],
    ['conflict', 409],
  ] as const)('%s -> %i, with its own message, not reported as an error', async (code, status) => {
    signIn();
    vi.spyOn(ReportsService.prototype, 'movementSummary').mockRejectedValue(
      new ServiceError(code, `refused: ${code}`),
    );
    const r = await get('stock-movements', '?days=30');
    expect(r.status).toBe(status);
    expect(r.body).toMatchObject({ error: code, message: `refused: ${code}` });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('an item the caller cannot read: 404 (was a CSV of its suppliers and unit costs)', async () => {
    const s = signIn();
    s.client.from = makeSupabaseStub({ 'inventory_items.select': { data: null, error: null } }).client.from;
    const r = await get('item-cost-history', `?itemId=${ITEM}`);
    expect(r.status).toBe(404);
    expect(r.body?.error).toBe('not_found');
  });

  it('an internal error: 500 with a generic message, reported, raw text never sent', async () => {
    signIn();
    vi.spyOn(ReportsService.prototype, 'movementSummary').mockRejectedValue(
      new ServiceError('internal_error', 'relation "stock_movements" permission denied'),
    );
    const r = await get('stock-movements', '?days=30');
    expect(r.status).toBe(500);
    expect(r.text).not.toMatch(/stock_movements|permission denied/);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('an unexpected throw: 500, reported', async () => {
    signIn();
    vi.spyOn(ReportsService.prototype, 'movementSummary').mockRejectedValue(new Error('boom'));
    const r = await get('stock-movements', '?days=30');
    expect(r.status).toBe(500);
    expect(r.text).not.toMatch(/boom/);
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
