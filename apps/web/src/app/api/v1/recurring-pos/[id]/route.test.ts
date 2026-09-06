import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { ModuleId, Permission } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { RecurringPoTemplatesService } from '@/server/services/recurring-pos';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { DELETE, PATCH } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/server/services/recurring-pos', () => ({ RecurringPoTemplatesService: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

const TPL = '11111111-1111-1111-1111-111111111111';

const setEnabled = vi.fn();
const remove = vi.fn();

function buildCtx(
  opts: {
    plan?: string | null;
    orgRow?: Record<string, unknown> | null;
    permissions?: Permission[];
    modules?: ModuleId[];
    mfaRequired?: boolean;
    mfaSatisfied?: boolean;
  } = {},
) {
  const orgRow =
    opts.orgRow !== undefined
      ? opts.orgRow
      : {
          plan: opts.plan === undefined ? 'pro' : opts.plan,
          access_tier: null,
          billing_arrangement: null,
          stripe_subscription_id: 'sub_1',
          trial_ends_at: null,
          trial_tier: null,
        };
  const stub = makeSupabaseStub({ 'organizations.select': { data: orgRow, error: null } });
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'manager' as const,
    permissions: new Set<Permission>(opts.permissions ?? (['purchase_orders:manage'] as Permission[])),
    supabase: stub.client as never,
    mfaRequired: opts.mfaRequired ?? false,
    mfaSatisfied: opts.mfaSatisfied ?? true,
    mfaEnrolled: false,
    enabledModules: new Set<ModuleId>(opts.modules ?? (['purchase_orders'] as ModuleId[])),
  };
}

const patchReq = (body: unknown) =>
  new NextRequest('http://localhost/api/v1/recurring-pos/x', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
const deleteReq = () =>
  new NextRequest('http://localhost/api/v1/recurring-pos/x', { method: 'DELETE' });
const params = (id = TPL) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  setEnabled.mockResolvedValue({ id: TPL });
  remove.mockResolvedValue(undefined);
  vi.mocked(RecurringPoTemplatesService).mockImplementation(
    () => ({ setEnabled, remove }) as never,
  );
});

describe('PATCH /api/v1/recurring-pos/[id]', () => {
  it('routes the toggle through the SERVICE, which is what writes the audit row', async () => {
    // SP-122: the mobile screen used to PATCH `recurring_po_templates`
    // straight through PostgREST. That write is RLS-legal but writes no
    // audit_logs row (audit is app-code only, service-role client, no DB
    // trigger) — so the phone could silently pause an org's recurring POs.
    const ctx = buildCtx();
    vi.mocked(withApiContext).mockResolvedValue(ctx as never);

    const res = await PATCH(patchReq({ enabled: false }), params());

    expect(res.status).toBe(200);
    expect(setEnabled).toHaveBeenCalledWith(TPL, false);
    // The BEARER ctx must be the one the service audits with: audit() falls
    // back to withContext() when no ctx is passed, which throws NEXT_REDIRECT
    // inside a route handler and drops the event (bug pattern #23).
    expect(vi.mocked(RecurringPoTemplatesService).mock.calls[0]?.[0]).toBe(ctx);
  });

  it('enables when the org is entitled', async () => {
    vi.mocked(withApiContext).mockResolvedValue(buildCtx({ plan: 'pro' }) as never);
    const res = await PATCH(patchReq({ enabled: true }), params());
    expect(res.status).toBe(200);
    expect(setEnabled).toHaveBeenCalledWith(TPL, true);
  });

  it('refuses to ENABLE below Pro, mirroring the web action plan gate', async () => {
    vi.mocked(withApiContext).mockResolvedValue(buildCtx({ plan: 'free' }) as never);
    const res = await PATCH(patchReq({ enabled: true }), params());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'plan_limit_exceeded' });
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it('still lets a lapsed org turn a template OFF', async () => {
    vi.mocked(withApiContext).mockResolvedValue(buildCtx({ plan: 'free' }) as never);
    const res = await PATCH(patchReq({ enabled: false }), params());
    expect(res.status).toBe(200);
    expect(setEnabled).toHaveBeenCalledWith(TPL, false);
  });

  it('fails CLOSED when the org row is missing', async () => {
    vi.mocked(withApiContext).mockResolvedValue(buildCtx({ orgRow: null }) as never);
    const res = await PATCH(patchReq({ enabled: true }), params());
    expect(res.status).toBe(409);
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it('403s without purchase_orders:manage — before the plan is ever consulted', async () => {
    vi.mocked(withApiContext).mockResolvedValue(
      buildCtx({ permissions: [] }) as never,
    );
    const res = await PATCH(patchReq({ enabled: true }), params());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'forbidden' });
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it('403s when the purchase_orders module is off', async () => {
    vi.mocked(withApiContext).mockResolvedValue(buildCtx({ modules: [] }) as never);
    const res = await PATCH(patchReq({ enabled: false }), params());
    expect(res.status).toBe(403);
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it('403s an AAL1 session when MFA is required', async () => {
    vi.mocked(withApiContext).mockResolvedValue(
      buildCtx({ mfaRequired: true, mfaSatisfied: false }) as never,
    );
    const res = await PATCH(patchReq({ enabled: false }), params());
    expect(res.status).toBe(403);
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it('401s without a bearer context', async () => {
    vi.mocked(withApiContext).mockResolvedValue(null as never);
    const res = await PATCH(patchReq({ enabled: false }), params());
    expect(res.status).toBe(401);
  });

  it('400s a malformed id instead of leaking a Postgres cast error', async () => {
    vi.mocked(withApiContext).mockResolvedValue(buildCtx() as never);
    const res = await PATCH(patchReq({ enabled: false }), params('not-a-uuid'));
    expect(res.status).toBe(400);
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it('400s a body that is not { enabled: boolean }', async () => {
    vi.mocked(withApiContext).mockResolvedValue(buildCtx() as never);
    const res = await PATCH(patchReq({ enabled: 'yes' }), params());
    expect(res.status).toBe(400);
    expect(setEnabled).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/v1/recurring-pos/[id]', () => {
  it('routes the delete through the SERVICE so the deletion is audited', async () => {
    const ctx = buildCtx();
    vi.mocked(withApiContext).mockResolvedValue(ctx as never);

    const res = await DELETE(deleteReq(), params());

    expect(res.status).toBe(200);
    expect(remove).toHaveBeenCalledWith(TPL);
    expect(vi.mocked(RecurringPoTemplatesService).mock.calls[0]?.[0]).toBe(ctx);
  });

  it('needs no plan entitlement — a lapsed org can still clean up', async () => {
    vi.mocked(withApiContext).mockResolvedValue(buildCtx({ plan: 'free' }) as never);
    const res = await DELETE(deleteReq(), params());
    expect(res.status).toBe(200);
    expect(remove).toHaveBeenCalledWith(TPL);
  });

  it('403s without purchase_orders:manage', async () => {
    vi.mocked(withApiContext).mockResolvedValue(buildCtx({ permissions: [] }) as never);
    const res = await DELETE(deleteReq(), params());
    expect(res.status).toBe(403);
    expect(remove).not.toHaveBeenCalled();
  });

  it('401s without a bearer context', async () => {
    vi.mocked(withApiContext).mockResolvedValue(null as never);
    expect((await DELETE(deleteReq(), params())).status).toBe(401);
  });

  it('400s a malformed id', async () => {
    vi.mocked(withApiContext).mockResolvedValue(buildCtx() as never);
    expect((await DELETE(deleteReq(), params('nope'))).status).toBe(400);
    expect(remove).not.toHaveBeenCalled();
  });
});
