// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

/**
 * Security invariant: what the Suppliers list reads of the vendor reviews
 * (lib/supplier-risk/list-risk.ts). Never throws (the list opens for an
 * admin even when the reviews cannot be read).
 *   - Not an owner or admin: nothing is read and there is no view.
 *   - The authenticator step owed: nothing is read ("step_up").
 *   - The module off: no view.
 *   - A register that could not be read is "could_not_check", never empty.
 */

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));

import { loadSuppliersRiskView } from './list-risk';

const ORG = '0f1e2d3c-4b5a-4968-8776-655443322110';
const A = '5A5A5A5A-0000-4000-8000-00000000000A';

function ctxWith(register: QueryResult, over: Parameters<typeof makeServiceContext>[1] = {}) {
  const stub = makeSupabaseStub({
    'rpc:supplier_risk_register': register,
    'organization_members.select': { data: [{ impersonation_expires_at: null }], error: null },
  });
  return {
    stub,
    ctx: makeServiceContext(stub.client, { organizationId: ORG, role: 'admin', ...over }) as never,
  };
}

const ROW = {
  supplier_id: A,
  supplier_name: 'Example Supply Co',
  supplier_state: 'active',
  review_id: 'e1e1e1e1-0000-4000-8000-000000000001',
  result: 'approve',
  residual_risk: 'low',
  review_due: 'due_soon',
  next_review_on: '2026-12-20',
  draft_review_id: null,
};

describe('loadSuppliersRiskView', () => {
  for (const role of ['manager', 'staff', 'viewer'] as const) {
    it(`a ${role}: no view, nothing read`, async () => {
      const { stub, ctx } = ctxWith({ data: [ROW], error: null }, { role });
      expect(await loadSuppliersRiskView(ctx)).toBeNull();
      expect(stub.rpcCalls).toEqual([]);
      expect(stub.fromCalls).toEqual([]);
    });
  }

  it('the authenticator step owed: step_up, nothing read', async () => {
    const { stub, ctx } = ctxWith(
      { data: [ROW], error: null },
      { mfaRequired: true, mfaSatisfied: false },
    );
    expect(await loadSuppliersRiskView(ctx)).toEqual({ state: 'step_up' });
    expect(stub.rpcCalls).toEqual([]);
  });

  it('the Suppliers module off: no view', async () => {
    const { stub, ctx } = ctxWith(
      { data: [ROW], error: null },
      { enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS.filter((m) => m !== 'suppliers')) },
    );
    expect(await loadSuppliersRiskView(ctx)).toBeNull();
    expect(stub.rpcCalls).toEqual([]);
  });

  it('a missing function (0481 not live) is could_not_check', async () => {
    const { ctx } = ctxWith({ data: null, error: { message: 'gone', code: 'PGRST202' } });
    expect(await loadSuppliersRiskView(ctx)).toEqual({ state: 'could_not_check' });
  });

  it('the database owing the authenticator step is step_up; its other refusal is no view', async () => {
    const owed = ctxWith({
      data: null,
      error: { message: 'x', code: '42501', hint: 'aal2_required' },
    });
    expect(await loadSuppliersRiskView(owed.ctx)).toEqual({ state: 'step_up' });
    const refused = ctxWith({
      data: null,
      error: { message: 'x', code: '42501', hint: 'supplier_risk_not_allowed' },
    });
    expect(await loadSuppliersRiskView(refused.ctx)).toBeNull();
  });

  it('read: one cell per supplier, keyed by its id in lower case, with the seat', async () => {
    const { stub, ctx } = ctxWith({ data: [ROW], error: null }, { role: 'owner' });
    expect(await loadSuppliersRiskView(ctx)).toEqual({
      state: 'ok',
      seat: 'member',
      bySupplier: {
        [A.toLowerCase()]: {
          result: 'approve',
          residualRisk: 'low',
          reviewDue: 'due_soon',
          nextReviewOn: '2026-12-20',
          draft: false,
        },
      },
    });
    expect(stub.rpcCalls).toEqual([
      { name: 'supplier_risk_register', args: { p_organization_id: ORG } },
    ]);
  });
});
