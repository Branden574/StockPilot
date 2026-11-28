// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  VENDOR_RISK_ACT_AS_REFUSAL,
  VENDOR_RISK_ACT_AS_REFUSAL_WORDS,
  VENDOR_RISK_REFUSAL_WORDS,
} from '@stockpilot/core';

import {
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
  type QueryResult,
} from '@/test/supabase-mock';

/**
 * Security invariant: the four vendor review writes and the one read of the
 * newest versions (server/actions/supplier-risk.ts); the read is gated the
 * same way and answers "could not check", never "no other version".
 *   - Each argument is checked with zod before anything is asked: a refused
 *     one answers one fixed sentence, and no context is built and nothing is
 *     read or sent.
 *   - Then the service's gate in its order (the module, the authenticator
 *     step, owners and admins), the support seat, core's checks and the
 *     database's function. A refusal keeps its words and its reason (the
 *     page reads mfa_required, aal2_required, the act-as seat and
 *     draft_moved); any other failure is the shared fixed sentence.
 */

const h = vi.hoisted(() => ({
  ctx: null as null | Record<string, unknown>,
  ctxCalls: 0,
  revalidate: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => h.revalidate(...a) }));
vi.mock('@/server/services/context', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/services/context')>();
  return {
    ...real,
    withContext: async () => {
      h.ctxCalls += 1;
      return h.ctx;
    },
  };
});
vi.mock('@/server/services/audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));

import {
  SUPPLIER_RISK_COULD_NOT_CHECK,
  SUPPLIER_RISK_FORBIDDEN,
  SUPPLIER_RISK_INVALID_REQUEST,
  SUPPLIER_RISK_NOTHING_SAVED,
} from '@/server/services/supplier-risk';

import {
  discardSupplierRiskDraftAction,
  finishSupplierRiskReviewAction,
  loadSupplierRiskLatestAction,
  saveSupplierRiskDraftAction,
  updateSupplierRiskItemAction,
} from './supplier-risk';

const ORG = '0f1e2d3c-4b5a-4968-8776-655443322110';
const SUPPLIER = '5a5a5a5a-0000-4000-8000-000000000001';
const REVIEW = 'e1e1e1e1-0000-4000-8000-000000000001';
const ITEM = '17e17e17-0000-4000-8000-000000000001';

type Results = Record<string, QueryResult | ((call: MockCall) => QueryResult)>;

function useContext(
  results: Results = {},
  over: Parameters<typeof makeServiceContext>[1] = {},
  impersonation: string | null = null,
) {
  const stub = makeSupabaseStub({
    'organization_members.select': {
      data: [{ impersonation_expires_at: impersonation }],
      error: null,
    },
    ...results,
  });
  h.ctx = makeServiceContext(stub.client, { organizationId: ORG, role: 'admin', ...over }) as never;
  return stub;
}

const draft = { supplierId: SUPPLIER, dataLevel: 'staff', answers: {} };
const discard = { supplierId: SUPPLIER };
const item = {
  reviewId: REVIEW,
  itemId: ITEM,
  status: 'in_progress',
  ownerUserId: null,
  dueOn: null,
  action: null,
  reason: null,
};
const finish = {
  supplierId: SUPPLIER,
  dataLevel: 'none',
  answers: {},
  nextReviewOn: null,
  overrideResult: null,
  overrideReason: null,
  items: [],
  draftUpdatedAt: null,
};

const ACTIONS: Array<[string, (i: unknown) => Promise<{ ok: boolean }>, Record<string, unknown>]> =
  [
    ['save draft', saveSupplierRiskDraftAction, draft],
    ['finish', finishSupplierRiskReviewAction, finish],
    ['discard', discardSupplierRiskDraftAction, discard],
    ['item', updateSupplierRiskItemAction, item],
  ];

beforeEach(() => {
  h.ctx = null;
  h.ctxCalls = 0;
  h.revalidate.mockClear();
});

describe('zod first: a request the schema refuses asks nothing', () => {
  const BAD: Array<[string, unknown]> = [
    ['nothing', undefined],
    ['a string', 'supplier'],
    ['an array', []],
  ];

  it.each(ACTIONS)(
    '%s: refused shapes answer one fixed sentence, no context built',
    async (_n, action, good) => {
      const stub = useContext();
      const shapes: unknown[] = [
        ...BAD.map(([, v]) => v),
        { ...good, extra: 'field' },
        { ...good, supplierId: 'not-a-uuid', reviewId: 'not-a-uuid' },
        { ...good, organizationId: '99999999-9999-4999-8999-999999999999' },
      ];
      for (const input of shapes) {
        const res = await action(input);
        expect(res).toEqual({
          ok: false,
          error: { code: 'validation_error', message: SUPPLIER_RISK_INVALID_REQUEST },
        });
      }
      expect(h.ctxCalls).toBe(0);
      expect(stub.rpcCalls).toEqual([]);
      expect(stub.fromCalls).toEqual([]);
    },
  );

  it('finish: more items than questions is refused by the schema', async () => {
    useContext();
    const one = {
      questionKey: 'breach_notice',
      finding: 'x',
      action: 'y',
      ownerUserId: null,
      dueOn: null,
    };
    const res = await finishSupplierRiskReviewAction({
      ...finish,
      items: Array.from({ length: 15 }, () => one),
    });
    expect(res).toMatchObject({ ok: false, error: { code: 'validation_error' } });
    expect(h.ctxCalls).toBe(0);
  });

  it('a date that is not a day is refused by the schema', async () => {
    useContext();
    expect(await updateSupplierRiskItemAction({ ...item, dueOn: '2026-02-30' })).toMatchObject({
      ok: false,
    });
    expect(await updateSupplierRiskItemAction({ ...item, dueOn: 'tomorrow' })).toMatchObject({
      ok: false,
    });
    expect(h.ctxCalls).toBe(0);
  });
});

describe('the gate answers through the action with its words and its reason', () => {
  for (const role of ['manager', 'staff', 'viewer'] as const) {
    it.each(ACTIONS)(`%s: a ${role} is refused, nothing sent`, async (_n, action, good) => {
      const stub = useContext({}, { role });
      expect(await action(good)).toEqual({
        ok: false,
        error: { code: 'forbidden', message: SUPPLIER_RISK_FORBIDDEN },
      });
      expect(stub.rpcCalls).toEqual([]);
    });
  }

  it.each(ACTIONS)(
    '%s: the authenticator step owed keeps its reason for the page',
    async (_n, action, good) => {
      const stub = useContext({}, { mfaRequired: true, mfaSatisfied: false });
      expect(await action(good)).toMatchObject({
        ok: false,
        error: { code: 'forbidden', details: { reason: 'mfa_required' } },
      });
      expect(stub.rpcCalls).toEqual([]);
    },
  );

  it.each(ACTIONS)(
    '%s: a support seat is refused with the act-as words',
    async (_n, action, good) => {
      const stub = useContext({}, {}, '2026-11-27T12:00:00Z');
      expect(await action(good)).toEqual({
        ok: false,
        error: {
          code: 'forbidden',
          message: VENDOR_RISK_ACT_AS_REFUSAL_WORDS,
          details: { reason: VENDOR_RISK_ACT_AS_REFUSAL },
        },
      });
      expect(stub.rpcCalls).toEqual([]);
    },
  );

  it("the database's refusal word answers core's words", async () => {
    useContext({
      'rpc:supplier_risk_draft_discard': {
        data: null,
        error: { message: 'raw text', code: '22023', hint: 'supplier_archived' },
      },
    });
    expect(await discardSupplierRiskDraftAction(discard)).toMatchObject({
      ok: false,
      error: { code: 'validation_error', message: VENDOR_RISK_REFUSAL_WORDS.supplier_archived },
    });
  });

  it('a missing function says nothing was saved, to retry', async () => {
    useContext({
      'rpc:supplier_risk_draft_discard': {
        data: null,
        error: { message: 'gone', code: 'PGRST202' },
      },
    });
    expect(await discardSupplierRiskDraftAction(discard)).toMatchObject({
      ok: false,
      error: {
        code: 'conflict',
        message: SUPPLIER_RISK_NOTHING_SAVED,
        details: { reason: 'could_not_check' },
      },
    });
  });

  it("any other failure is the shared fixed sentence, never the database's text", async () => {
    useContext({
      'rpc:supplier_risk_draft_discard': {
        data: null,
        error: { message: 'relation "hidden_table" does not exist', code: 'XX000' },
      },
    });
    const res = await discardSupplierRiskDraftAction(discard);
    expect(res).toMatchObject({ ok: false, error: { code: 'internal_error' } });
    expect(JSON.stringify(res)).not.toContain('hidden_table');
    expect(JSON.stringify(res)).not.toContain('supplier_risk_draft_discard');
  });
});

describe('a write that went through', () => {
  it('a draft saved refreshes the review page, the register and the suppliers list', async () => {
    const stub = useContext({
      'rpc:supplier_risk_draft_save': {
        data: { review_id: REVIEW, version: 1, updated_at: '2026-11-27T10:00:00+00:00' },
        error: null,
      },
    });
    expect(await saveSupplierRiskDraftAction(draft)).toEqual({
      ok: true,
      data: { reviewId: REVIEW, updatedAt: '2026-11-27T10:00:00+00:00' },
    });
    expect(stub.rpcCalls).toEqual([
      {
        name: 'supplier_risk_draft_save',
        args: {
          p_organization_id: ORG,
          p_supplier_id: SUPPLIER,
          p_data_level: 'staff',
          p_answers: {},
        },
      },
    ]);
    expect(h.revalidate.mock.calls.map((c) => c[0])).toEqual([
      `/dashboard/suppliers/${SUPPLIER}/risk`,
      '/dashboard/suppliers/risk',
      '/dashboard/suppliers',
    ]);
  });
});

describe('the read of the newest version (the finish panel, when another admin got there first)', () => {
  it('zod first: refused shapes answer one fixed sentence, no context built', async () => {
    const stub = useContext();
    for (const input of [
      undefined,
      'x',
      [],
      { supplierId: 'not-a-uuid' },
      { supplierId: SUPPLIER, extra: 1 },
      { supplierId: SUPPLIER, organizationId: ORG },
    ]) {
      expect(await loadSupplierRiskLatestAction(input)).toEqual({
        ok: false,
        error: { code: 'validation_error', message: SUPPLIER_RISK_INVALID_REQUEST },
      });
    }
    expect(h.ctxCalls).toBe(0);
    expect(stub.rpcCalls).toEqual([]);
  });

  for (const role of ['manager', 'staff', 'viewer'] as const) {
    it(`a ${role} is refused, nothing read`, async () => {
      const stub = useContext({}, { role });
      expect(await loadSupplierRiskLatestAction({ supplierId: SUPPLIER })).toEqual({
        ok: false,
        error: { code: 'forbidden', message: SUPPLIER_RISK_FORBIDDEN },
      });
      expect(stub.rpcCalls).toEqual([]);
    });
  }

  it('a version that could not be read says so: never "no other version"', async () => {
    useContext({
      'rpc:supplier_risk_history': { data: null, error: { message: 'x', code: 'PGRST202' } },
    });
    expect(await loadSupplierRiskLatestAction({ supplierId: SUPPLIER })).toEqual({
      ok: false,
      error: {
        code: 'conflict',
        message: SUPPLIER_RISK_COULD_NOT_CHECK,
        details: { reason: 'could_not_check', retryable: true },
      },
    });
  });

  it('an owner or admin gets the open draft and the current review; nothing is revalidated', async () => {
    useContext({
      'rpc:supplier_risk_history': {
        data: [
          {
            review_id: REVIEW,
            version: 2,
            status: 'draft',
            is_current: false,
            updated_at: '2026-11-27T11:00:00+00:00',
          },
        ],
        error: null,
      },
      'rpc:supplier_risk_review': {
        data: {
          id: REVIEW,
          supplier_id: SUPPLIER,
          version: 2,
          status: 'draft',
          is_current: false,
          data_level: 'none',
          answers: {},
          updated_at: '2026-11-27T11:00:00+00:00',
          items: [],
        },
        error: null,
      },
    });
    const res = await loadSupplierRiskLatestAction({ supplierId: SUPPLIER });
    expect(res).toMatchObject({
      ok: true,
      data: { draft: { reviewId: REVIEW, updatedAt: '2026-11-27T11:00:00+00:00' }, current: null },
    });
    expect(h.revalidate).not.toHaveBeenCalled();
  });
});
