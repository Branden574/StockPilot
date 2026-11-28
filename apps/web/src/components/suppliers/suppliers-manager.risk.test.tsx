/**
 * Security invariant: the Suppliers list's vendor review column (security
 * tools part 7), for owners and admins only.
 *   - No risk view (everyone else): no Risk column, no Review link, no Risk
 *     register link.
 *   - A register that could not be read: every cell says "Could not check",
 *     never "Not reviewed".
 *   - The authenticator step owed: nothing was read, so no column; the page
 *     points to the register, which asks for it.
 *   - Read: the result, the risk left and the next review date, or "Not
 *     reviewed"; a Review link per supplier the review page will open.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/suppliers',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href, ...rest }, children),
  };
});
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/suppliers', () => ({
  archiveSupplierAction: vi.fn(),
  restoreSupplierAction: vi.fn(),
  createSupplierAction: vi.fn(),
  updateSupplierAction: vi.fn(),
}));

import type { SuppliersRiskView } from '@/lib/supplier-risk/list-risk';

import { SuppliersManager } from './suppliers-manager';

const A = '5a5a5a5a-0000-4000-8000-00000000000a';
const B = '5a5a5a5a-0000-4000-8000-00000000000b';

const row = (id: string, name: string) => ({
  id,
  name,
  contact_name: null,
  email: null,
  phone: null,
  website: null,
  notes: null,
});
const ROWS = [row(A, 'Example Supply Co'), row(B, 'Sample Paper Ltd')];

const OK: SuppliersRiskView = {
  state: 'ok',
  seat: 'member',
  bySupplier: {
    [A]: {
      result: 'approve_with_conditions',
      residualRisk: 'moderate',
      reviewDue: 'overdue',
      nextReviewOn: '2026-10-01',
      draft: false,
    },
    [B]: {
      result: null,
      residualRisk: null,
      reviewDue: 'not_reviewed',
      nextReviewOn: null,
      draft: true,
    },
  },
};

describe('the Risk column and the Review link', () => {
  it('no risk view (not an owner or admin): no column, no Review, no register link', () => {
    render(<SuppliersManager initial={ROWS} view="active" canManage risk={null} />);
    expect(screen.queryByRole('columnheader', { name: 'Risk' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Vendor review of/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /Risk register/ })).toBeNull();
  });

  it('read: the result, the risk left, the next review; Not reviewed; a Review link each', () => {
    render(<SuppliersManager initial={ROWS} view="active" canManage risk={OK} />);
    expect(screen.getByRole('columnheader', { name: 'Risk' })).toBeTruthy();
    const [first, second] = screen.getAllByRole('row').slice(1);
    const a = within(first!).getByText('Approve with conditions').closest('td')!;
    expect(a.textContent).toMatch(/Risk left: Moderate/);
    expect(a.textContent).toMatch(/Next review: October 1, 2026/);
    expect(a.textContent).toMatch(/Overdue/);
    expect(
      within(second!)
        .getByText(/Not reviewed/)
        .closest('td')?.textContent,
    ).toMatch(/A draft is open/);
    expect(
      screen.getByRole('link', { name: 'Vendor review of Example Supply Co' }).getAttribute('href'),
    ).toBe(`/dashboard/suppliers/${A}/risk`);
    expect(screen.getByRole('link', { name: /Risk register/ }).getAttribute('href')).toBe(
      '/dashboard/suppliers/risk',
    );
  });

  it('could not check: every cell says so, never Not reviewed', () => {
    render(
      <SuppliersManager
        initial={ROWS}
        view="active"
        canManage
        risk={{ state: 'could_not_check' }}
      />,
    );
    const cells = Array.from(document.querySelectorAll('[data-slot="supplier-risk-cell"]'));
    expect(cells.map((c) => c.textContent)).toEqual(['Could not check', 'Could not check']);
    expect(screen.queryByText('Not reviewed')).toBeNull();
    expect(screen.getByText(/This is not the same as not reviewed/)).toBeTruthy();
  });

  it('the authenticator step owed: no column, the register link, a note', () => {
    render(<SuppliersManager initial={ROWS} view="active" canManage risk={{ state: 'step_up' }} />);
    expect(screen.queryByRole('columnheader', { name: 'Risk' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Vendor review of/ })).toBeNull();
    expect(screen.getByRole('link', { name: /Risk register/ })).toBeTruthy();
    expect(screen.getByText(/need your authenticator step/)).toBeTruthy();
  });

  it('archived view: a Review link only for a supplier the register lists', () => {
    render(
      <SuppliersManager
        initial={ROWS}
        view="archived"
        canManage
        risk={{
          state: 'ok',
          seat: 'member',
          bySupplier: { [A]: OK.state === 'ok' ? OK.bySupplier[A]! : null! },
        }}
      />,
    );
    expect(screen.getByRole('link', { name: 'Vendor review of Example Supply Co' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Vendor review of Sample Paper Ltd' })).toBeNull();
  });

  it("the Review link's label names the supplier cleaned of line breaks and direction marks (S4)", () => {
    render(
      <SuppliersManager
        initial={[row(A, 'Example\r\nSupply \u202eCo')]}
        view="active"
        canManage
        risk={OK}
      />,
    );
    expect(
      screen.getByRole('link', { name: 'Vendor review of Example Supply Co' }).getAttribute('href'),
    ).toBe(`/dashboard/suppliers/${A}/risk`);
  });
});
