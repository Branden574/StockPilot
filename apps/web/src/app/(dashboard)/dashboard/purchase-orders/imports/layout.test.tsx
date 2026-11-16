import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Permission, Role } from '@stockpilot/core';

/**
 * The PO imports layout: the manager-only panel in place of the imports pages
 * for someone without "Manage purchase orders", and the pages for everyone
 * else. A member who must set up an authenticator first gets the page they
 * asked for, whose own rule (requireOrgContext()) sends them to set-up; the
 * layout itself never redirects (lib/auth/session.ts).
 */

const session = vi.hoisted(() => ({
  ctx: { role: 'viewer' as Role, permissions: new Set<Permission>() },
  setUpOwed: false,
}));
const requireOrgContextForLayout = vi.hoisted(() => vi.fn(async () => session.ctx));
const authenticatorSetUpOwedForLayout = vi.hoisted(() => vi.fn(async () => session.setUpOwed));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContextForLayout,
  authenticatorSetUpOwedForLayout,
}));

const redirect = vi.hoisted(() =>
  vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
);
vi.mock('next/navigation', () => ({ redirect, permanentRedirect: redirect }));

import PoImportsLayout from './layout';

const READ_ONLY = new Set<Permission>(['purchase_orders:read']);
const MANAGE = new Set<Permission>(['purchase_orders:read', 'purchase_orders:manage']);

function as(role: Role, permissions: Set<Permission>, setUpOwed = false) {
  session.ctx = { role, permissions };
  session.setUpOwed = setUpOwed;
}

const renderLayout = async () =>
  render(await PoImportsLayout({ children: <p>The imports page</p> }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the PO imports layout', () => {
  it('without "Manage purchase orders", and no set-up owed: the manager-only panel, not the page', async () => {
    as('viewer', READ_ONLY);
    await renderLayout();
    expect(
      screen.getByRole('heading', { level: 1, name: 'PO imports are manager-only' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('The imports page')).toBeNull();
    expect(authenticatorSetUpOwedForLayout).toHaveBeenCalledTimes(1);
  });

  it.each(['viewer', 'staff'] as const)(
    'a %s who must set up an authenticator first: the page, whose rule sends them to set-up',
    async (role) => {
      as(role, READ_ONLY, true);
      await renderLayout();
      expect(screen.getByText('The imports page')).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'PO imports are manager-only' })).toBeNull();
    },
  );

  it('with "Manage purchase orders": the page, and the set-up question is not asked here', async () => {
    for (const setUpOwed of [false, true]) {
      vi.clearAllMocks();
      as('manager', MANAGE, setUpOwed);
      const { unmount } = await renderLayout();
      expect(screen.getByText('The imports page')).toBeInTheDocument();
      expect(screen.queryByRole('heading')).toBeNull();
      expect(authenticatorSetUpOwedForLayout).not.toHaveBeenCalled();
      unmount();
    }
  });

  it('redirects nobody', async () => {
    for (const [permissions, setUpOwed] of [
      [READ_ONLY, false],
      [READ_ONLY, true],
      [MANAGE, false],
      [MANAGE, true],
    ] as const) {
      as('viewer', permissions, setUpOwed);
      const { unmount } = await renderLayout();
      unmount();
    }
    expect(redirect).not.toHaveBeenCalled();
  });
});
