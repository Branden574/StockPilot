/**
 * Regression test pinning the fail-closed MFA/auth gate computed by
 * `withContext()` (via `resolveMfaState`). The exact `mfaRequired` /
 * `mfaSatisfied` outcome for every case is SECURITY-CRITICAL and MUST
 * stay byte-for-byte identical across refactors. See the matrix below.
 *
 * Cases:
 *  (a) policy required + NO verified factor  -> required=true,  satisfied=false (fail-closed)
 *  (b) policy required + verified + AAL2     -> required=true,  satisfied=true
 *  (c) policy required + verified + AAL1     -> required=true,  satisfied=false
 *  (d) policy NOT required                   -> required=false, satisfied=true
 *  (e) org lookup throws                      -> required=true,  satisfied=false (fail-closed)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

// ── Mocks ──────────────────────────────────────────────────────────────
// requireOrgContext: identity + role only (MFA state is computed in withContext).
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(),
}));

// Request-cached helpers the refactor sources its inputs from.
vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: vi.fn(),
  getMfaFactorsForRequest: vi.fn(),
  getModulesForRequest: vi.fn(),
}));

// createClient: a per-test stub. The stub is configured (via the
// module-level `supabasePolicy` / `aalLevel`) so this test ALSO exercises
// the CURRENT implementation — which sources `mfa_policy` from a direct
// `supabase.from('organizations')` SELECT and always calls AAL — capturing a
// faithful baseline. After the refactor the same inputs flow through the
// request-cached helpers; the outcomes are identical, so the test is
// unchanged across the refactor.
let aalLevel: 'aal1' | 'aal2' = 'aal1';
let aalCalls = 0;
let supabasePolicy: OrgRow['mfa_policy'] = 'optional';
let supabaseOrgThrows = false;
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => {
    const stub = makeSupabaseStub({
      'organizations.select': () => {
        if (supabaseOrgThrows) throw new Error('org lookup failed');
        return { data: [{ mfa_policy: supabasePolicy }], error: null };
      },
      'organization_modules.select': { data: [{ module_id: 'orders' }], error: null },
    });
    stub.client.auth.mfa.getAuthenticatorAssuranceLevel = vi.fn(async () => {
      aalCalls += 1;
      return { data: { currentLevel: aalLevel }, error: null };
    });
    return stub.client;
  }),
}));

import { requireOrgContext } from '@/lib/auth/session';
import {
  getMfaFactorsForRequest,
  getModulesForRequest,
  getOrgRowForRequest,
} from '@/lib/dashboard/request-cache';
import { withContext } from './context';

import type { OrgRow } from '@/lib/dashboard/request-cache';
import type { ModuleId } from '@stockpilot/core';

const orgRow = (
  mfaPolicy: OrgRow['mfa_policy'],
): OrgRow => ({
  terminology: null,
  mfa_policy: mfaPolicy,
  logo_url: null,
  timezone: null,
  nav_overrides: null,
  dashboard_layout: null,
  order_status_config: null,
});

// `withContext` is wrapped in React.cache; outside a request scope cache()
// behaves as a process-level memo keyed on (no) args. Use a UNIQUE orgId
// per case so each invocation is a distinct cache entry and we never read a
// stale memoized result from a prior case.
let orgSeq = 0;
function arrange(opts: {
  policy: OrgRow['mfa_policy'];
  verifiedFactor: boolean;
  aal: 'aal1' | 'aal2';
  role?: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';
  orgRowThrows?: boolean;
}): string {
  const organizationId = `org-${++orgSeq}`;
  aalLevel = opts.aal;
  supabasePolicy = opts.policy;
  supabaseOrgThrows = opts.orgRowThrows ?? false;
  vi.mocked(requireOrgContext).mockResolvedValue({
    userId: 'u-1',
    email: 'u@example.com',
    fullName: null,
    avatarUrl: null,
    defaultOrganizationId: organizationId,
    organizationId,
    organizationName: 'Acme',
    role: opts.role ?? 'admin',
  });
  vi.mocked(getOrgRowForRequest).mockImplementation(async () => {
    if (opts.orgRowThrows) throw new Error('org lookup failed');
    return orgRow(opts.policy);
  });
  vi.mocked(getMfaFactorsForRequest).mockResolvedValue(
    opts.verifiedFactor ? [{ status: 'verified' }] : [{ status: 'unverified' }],
  );
  vi.mocked(getModulesForRequest).mockResolvedValue(new Set<ModuleId>(['orders']));
  return organizationId;
}

describe('withContext / resolveMfaState — fail-closed MFA gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    aalCalls = 0;
    supabaseOrgThrows = false;
  });

  it('(a) policy required + NO verified factor -> required=true, satisfied=false (fail-closed)', async () => {
    arrange({ policy: 'all_required', verifiedFactor: false, aal: 'aal1' });
    const ctx = await withContext();
    expect(ctx.mfaRequired).toBe(true);
    expect(ctx.mfaSatisfied).toBe(false);
  });

  it('(a2) short-circuit: NO AAL round-trip when policy requires MFA but there is no verified factor', async () => {
    arrange({ policy: 'all_required', verifiedFactor: false, aal: 'aal1' });
    const ctx = await withContext();
    // Same fail-closed outcome as (a)...
    expect(ctx.mfaRequired).toBe(true);
    expect(ctx.mfaSatisfied).toBe(false);
    // ...reached WITHOUT spending the auth.mfa AAL round-trip.
    expect(aalCalls).toBe(0);
  });

  it('(b2) AAL round-trip IS made when a verified factor exists', async () => {
    arrange({ policy: 'all_required', verifiedFactor: true, aal: 'aal2' });
    await withContext();
    expect(aalCalls).toBe(1);
  });

  it('(b) policy required + verified factor + AAL2 -> required=true, satisfied=true', async () => {
    arrange({ policy: 'all_required', verifiedFactor: true, aal: 'aal2' });
    const ctx = await withContext();
    expect(ctx.mfaRequired).toBe(true);
    expect(ctx.mfaSatisfied).toBe(true);
  });

  it('(c) policy required + verified factor + AAL1 -> required=true, satisfied=false', async () => {
    arrange({ policy: 'all_required', verifiedFactor: true, aal: 'aal1' });
    const ctx = await withContext();
    expect(ctx.mfaRequired).toBe(true);
    expect(ctx.mfaSatisfied).toBe(false);
  });

  it('(d) policy NOT required (optional) -> required=false, satisfied=true', async () => {
    arrange({ policy: 'optional', verifiedFactor: false, aal: 'aal1' });
    const ctx = await withContext();
    expect(ctx.mfaRequired).toBe(false);
    expect(ctx.mfaSatisfied).toBe(true);
  });

  it('(d2) admins_required + non-admin role -> required=false, satisfied=true', async () => {
    arrange({ policy: 'admins_required', verifiedFactor: false, aal: 'aal1', role: 'staff' });
    const ctx = await withContext();
    expect(ctx.mfaRequired).toBe(false);
    expect(ctx.mfaSatisfied).toBe(true);
  });

  it('(d3) admins_required + admin role + no factor -> required=true, satisfied=false (fail-closed)', async () => {
    arrange({ policy: 'admins_required', verifiedFactor: false, aal: 'aal1', role: 'admin' });
    const ctx = await withContext();
    expect(ctx.mfaRequired).toBe(true);
    expect(ctx.mfaSatisfied).toBe(false);
  });

  it('(e) org lookup throws -> required=true, satisfied=false (fail CLOSED)', async () => {
    arrange({ policy: 'all_required', verifiedFactor: true, aal: 'aal2', orgRowThrows: true });
    const ctx = await withContext();
    expect(ctx.mfaRequired).toBe(true);
    expect(ctx.mfaSatisfied).toBe(false);
  });
});
