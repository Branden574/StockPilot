import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Permission, Role } from '@stockpilot/core';

/**
 * The purchase orders layout: the access panel in place of every purchase
 * order page for someone without "View purchase orders", and the pages for
 * everyone else. A member who must set up an authenticator first gets the page
 * they asked for, whose own rule (requireOrgContext()) sends them to set-up;
 * the layout itself never redirects (lib/auth/session.ts). The layout reads no
 * module: the pages answer a module that is off themselves, so the module
 * state never changes what the layout renders.
 */

const session = vi.hoisted(() => ({
  ctx: { role: 'staff' as Role, permissions: new Set<Permission>() },
  setUpOwed: false,
}));
const requireOrgContextForLayout = vi.hoisted(() => vi.fn(async () => session.ctx));
const authenticatorSetUpOwedForLayout = vi.hoisted(() => vi.fn(async () => session.setUpOwed));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContextForLayout,
  authenticatorSetUpOwedForLayout,
}));

const modules = vi.hoisted(() => ({ purchaseOrdersOn: true }));
const checkModuleAccess = vi.hoisted(() =>
  vi.fn(async () => ({ enabled: modules.purchaseOrdersOn, canManage: false })),
);
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess,
  checkModuleAccessFor: checkModuleAccess,
}));

const redirect = vi.hoisted(() =>
  vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
);
vi.mock('next/navigation', () => ({ redirect, permanentRedirect: redirect }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import PurchaseOrdersLayout from './layout';

const PANEL = "You don't have access to purchase orders";
const NONE = new Set<Permission>();
const VIEW = new Set<Permission>(['purchase_orders:read']);

const renderLayout = async () =>
  render(await PurchaseOrdersLayout({ children: <p>The purchase orders page</p> }));

beforeEach(() => {
  vi.clearAllMocks();
});

// Every row of: View purchase orders held or not, set-up owed or not, the
// purchase orders module on or off. A member without the permission gets the
// panel, except one who owes set-up: for them the page runs (and sends the
// member to set-up).
const MATRIX = [
  { view: true, owed: false, shows: 'page' },
  { view: true, owed: true, shows: 'page' },
  { view: false, owed: false, shows: 'panel' },
  { view: false, owed: true, shows: 'page' },
].flatMap((row) => [true, false].map((moduleOn) => ({ ...row, moduleOn })));

describe('the purchase orders layout', () => {
  it.each(MATRIX)(
    'View purchase orders $view, set-up owed $owed, module on $moduleOn: the $shows',
    async ({ view, owed, moduleOn, shows }) => {
      session.ctx = { role: 'staff', permissions: view ? VIEW : NONE };
      session.setUpOwed = owed;
      modules.purchaseOrdersOn = moduleOn;
      await renderLayout();
      if (shows === 'page') {
        expect(screen.getByText('The purchase orders page')).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: PANEL })).toBeNull();
      } else {
        expect(screen.getByRole('heading', { level: 1, name: PANEL })).toBeInTheDocument();
        expect(screen.queryByText('The purchase orders page')).toBeNull();
      }
      // The set-up question is asked only of someone the panel would stop.
      expect(authenticatorSetUpOwedForLayout).toHaveBeenCalledTimes(view ? 0 : 1);
      expect(checkModuleAccess).not.toHaveBeenCalled();
      expect(redirect).not.toHaveBeenCalled();
    },
  );
});
