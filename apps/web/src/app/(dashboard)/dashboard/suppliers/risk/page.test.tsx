import { render, screen } from '@testing-library/react';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTHENTICATOR_SET_UP_URL } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

/**
 * Security invariant: the vendor risk register (/dashboard/suppliers/risk),
 * owners and admins only.
 *   - Asked before anything is read: the Suppliers module (off: the module
 *     card), then the authenticator step (set-up, or the code page and back),
 *     then the role: a manager, staff member or viewer gets Page not found
 *     and nothing is read.
 *   - A register that could not be read (0481 not live, a failed read) says
 *     so and is never shown as empty; an empty one says there is nothing.
 *   - Every row: result, risk left, open items, next review, overdue first;
 *     names in <bdi>, typed text rendered as text, never as markup.
 */

const h = vi.hoisted(() => ({
  ctx: null as unknown,
  moduleAccess: { enabled: true } as { enabled: boolean },
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock('next/link', async () => {
  const R = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
      R.createElement('a', { href, ...rest }, children),
  };
});
vi.mock('@/lib/modules/module-gate', () => ({ checkModuleAccess: async () => h.moduleAccess }));
vi.mock('@/components/dashboard/module-unavailable', async () => {
  const R = await import('react');
  return { ModuleUnavailable: () => R.createElement('p', null, 'MODULE OFF') };
});
vi.mock('@/server/services/context', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/services/context')>();
  return { ...real, withContext: async () => h.ctx };
});
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: async () => ({ timezone: 'America/Los_Angeles' }),
}));

import SupplierRiskRegisterPage from './page';

const ORG = '0f1e2d3c-4b5a-4968-8776-655443322110';

function registerRow(n: number, over: Record<string, unknown> = {}) {
  return {
    supplier_id: `5a5a5a5a-0000-4000-8000-${String(n).padStart(12, '0')}`,
    supplier_name: `Example Supply Co ${n}`,
    supplier_state: 'active',
    review_id: `e1e1e1e1-0000-4000-8000-${String(n).padStart(12, '0')}`,
    version: 1,
    data_level: 'staff',
    result: 'approve',
    computed_result: 'approve',
    residual_risk: 'low',
    hard_stops: [],
    reviewer_name: 'Avery Example',
    next_review_on: '2027-11-27',
    review_due: 'scheduled',
    open_items: 0,
    ...over,
  };
}

function useRegister(answer: QueryResult, over: Parameters<typeof makeServiceContext>[1] = {}) {
  const stub = makeSupabaseStub({ 'rpc:supplier_risk_register': answer });
  h.ctx = makeServiceContext(stub.client, { organizationId: ORG, role: 'admin', ...over });
  return stub;
}

async function page() {
  return render(await SupplierRiskRegisterPage());
}

async function thrown(): Promise<string> {
  try {
    await SupplierRiskRegisterPage();
  } catch (e) {
    return (e as Error).message;
  }
  return 'rendered';
}

beforeEach(() => {
  h.moduleAccess = { enabled: true };
});

describe('who may open it, asked before anything is read', () => {
  it('the Suppliers module off shows the module card and reads nothing', async () => {
    h.moduleAccess = { enabled: false };
    const stub = useRegister({ data: [], error: null });
    await page();
    expect(screen.getByText('MODULE OFF')).toBeTruthy();
    expect(stub.rpcCalls).toEqual([]);
  });

  for (const role of ['manager', 'staff', 'viewer'] as const) {
    it(`a ${role} gets Page not found and nothing is read`, async () => {
      const stub = useRegister({ data: [registerRow(1)], error: null }, { role });
      expect(await thrown()).toBe('NOT_FOUND');
      expect(stub.rpcCalls).toEqual([]);
    });
  }

  it('an owner who owes the authenticator set-up is sent to it, nothing read', async () => {
    const stub = useRegister(
      { data: [], error: null },
      { role: 'owner', mfaRequired: true, mfaSatisfied: false },
    );
    expect(await thrown()).toBe(`REDIRECT ${AUTHENTICATOR_SET_UP_URL}`);
    expect(stub.rpcCalls).toEqual([]);
  });

  it('an enrolled admin who owes the code is sent to the code page and back here', async () => {
    useRegister({ data: [], error: null }, { mfaRequired: true, mfaSatisfied: false });
    (h.ctx as Record<string, unknown>).mfaEnrolled = true;
    expect(await thrown()).toBe(
      `REDIRECT /signin/mfa?redirect=${encodeURIComponent('/dashboard/suppliers/risk')}`,
    );
  });

  it('a refusal from the database itself is Page not found too', async () => {
    useRegister({
      data: null,
      error: { message: 'x', code: '42501', hint: 'supplier_risk_not_allowed' },
    });
    expect(await thrown()).toBe('NOT_FOUND');
  });
});

describe('what an owner or admin sees', () => {
  it('could not check is said, never an empty register', async () => {
    useRegister({ data: null, error: { message: 'gone', code: 'PGRST202' } });
    await page();
    expect(
      screen.getByText('Vendor reviews could not be checked just now. Try again in a minute.'),
    ).toBeTruthy();
    expect(screen.getByText(/not the same as no reviews/)).toBeTruthy();
    expect(screen.queryByText('No suppliers to review yet')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('button', { name: /CSV/ })).toBeNull();
  });

  it('an empty register says there is nothing yet', async () => {
    useRegister({ data: [], error: null });
    await page();
    expect(screen.getByText('No suppliers to review yet')).toBeTruthy();
  });

  it('rows overdue first, with result, risk left and the review link', async () => {
    useRegister({
      data: [
        registerRow(1),
        registerRow(2, {
          review_due: 'overdue',
          next_review_on: '2026-10-01',
          open_items: 2,
          top_open_severity: 'high',
        }),
        registerRow(3, {
          review_id: null,
          result: null,
          review_due: 'not_reviewed',
          next_review_on: null,
        }),
      ],
      error: null,
    });
    const { container } = await page();
    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows.map((r) => r.querySelector('bdi')?.textContent)).toEqual([
      'Example Supply Co 2',
      'Example Supply Co 3',
      'Example Supply Co 1',
    ]);
    expect(rows[0]?.textContent).toMatch(/Overdue/);
    expect(rows[1]?.textContent).toMatch(/Not reviewed/);
    const link = screen.getByRole('link', { name: /Example Supply Co 2/ });
    expect(link.getAttribute('href')).toBe(
      '/dashboard/suppliers/5a5a5a5a-0000-4000-8000-000000000002/risk',
    );
    expect(screen.getByRole('button', { name: /CSV/ })).toBeTruthy();
  });

  it('a renamed supplier says "Reviewed as" its reviewed name, in <bdi>; typed text stays text', async () => {
    useRegister({
      data: [
        registerRow(1, {
          supplier_name: '<img src=x onerror=alert(1)>',
          reviewed_as_name: 'Old \u202eName',
          name_changed: true,
        }),
      ],
      error: null,
    });
    const { container } = await page();
    expect(container.querySelector('tbody img')).toBeNull();
    const names = Array.from(container.querySelectorAll('tbody bdi')).map((b) => b.textContent);
    expect(names).toEqual(['<img src=x onerror=alert(1)>', 'Old \u202eName']);
    expect(container.textContent).toMatch(/Reviewed as/);
  });

  it("the review link's label names the supplier cleaned of line breaks and direction marks (S4)", async () => {
    useRegister({
      data: [registerRow(1, { supplier_name: 'Example\nSupply \u202eCo\u0007' })],
      error: null,
    });
    const { container } = await page();
    const link = container.querySelector('tbody a')!;
    expect(link.getAttribute('aria-label')).toBe('Open the vendor review of Example Supply Co');
    // On screen the name is shown as typed, isolated in <bdi>.
    expect(container.querySelector('tbody bdi')?.textContent).toBe('Example\nSupply \u202eCo\u0007');
  });
});
