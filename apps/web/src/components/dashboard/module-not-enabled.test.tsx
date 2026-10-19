import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Permission, Role } from '@stockpilot/core';

const session = vi.hoisted(() => ({
  ctx: null as null | { role: Role; permissions: ReadonlySet<Permission> },
}));

vi.mock('@/lib/auth/session', () => ({ requireOrgContext: async () => session.ctx }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import PoImportsLayout from '@/app/(dashboard)/dashboard/purchase-orders/imports/layout';
import { PoAccessDenied } from '@/components/po/po-access-denied';

import { ModuleNotEnabled } from './module-not-enabled';

/**
 * The three cards a page shows in place of its content when the person cannot
 * use it (W-SH-10, W-SH-16). The redesign changes their look only: each keeps
 * its own words, its one h1 (tours and the page title rule read `main h1`),
 * and its next step.
 */
describe('ModuleNotEnabled', () => {
  it('names the module, says it is off, and offers Settings to someone who can enable it', () => {
    render(<ModuleNotEnabled moduleId="rentals" canManage />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(
      screen.getByRole('heading', { level: 1, name: "Rentals isn't enabled" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("This module isn't turned on for your organization."),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Enable in Settings → Modules' })).toHaveAttribute(
      'href',
      '/dashboard/settings/modules',
    );
    expect(screen.queryByText('Ask an owner or admin to enable it.')).toBeNull();
  });

  it('tells everyone else who can enable it, with no link', () => {
    render(<ModuleNotEnabled moduleId="rentals" canManage={false} />);
    expect(screen.getByText('Ask an owner or admin to enable it.')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('PoAccessDenied', () => {
  it('keeps its words and its one h1', () => {
    render(<PoAccessDenied />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(
      screen.getByRole('heading', { level: 1, name: "You don't have access to purchase orders" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Viewing purchase orders needs the “View purchase orders” permission, which isn't enabled for your account\./,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Ask an owner or admin to enable it from Settings → Roles & permissions.'),
    ).toBeInTheDocument();
  });
});

const READ_ONLY = new Set<Permission>(['purchase_orders:read']);
const MANAGE = new Set<Permission>(['purchase_orders:read', 'purchase_orders:manage']);

async function renderImportsGate(permissions: ReadonlySet<Permission>) {
  session.ctx = { role: 'viewer', permissions };
  return render(await PoImportsLayout({ children: <p>The imports page</p> }));
}

beforeEach(() => {
  session.ctx = null;
});

// The gate had no test of its own: which people it stops, and what it says.
describe('the PO imports gate (purchase-orders/imports/layout.tsx)', () => {
  it('tells someone without "Manage purchase orders" who can run the import, in its own words', async () => {
    await renderImportsGate(READ_ONLY);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(
      screen.getByRole('heading', { level: 1, name: 'PO imports are manager-only' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Uploading and processing purchase-order imports needs the “Manage purchase orders” permission. Your role has view-only access.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Ask an owner, admin, or manager to run the import.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('The imports page')).toBeNull();
  });

  it('opens the imports pages for someone who holds it, with no card', async () => {
    await renderImportsGate(MANAGE);
    expect(screen.getByText('The imports page')).toBeInTheDocument();
    expect(screen.queryByRole('heading')).toBeNull();
  });
});

/**
 * ONE STATE LOOK (PLAN P2.6, "One owner per pattern"). All three are P2.6's
 * StatePanel at page size, with the panel's title as the page's only h1 and
 * the next step inside the panel; the shell keeps no state card of its own
 * (the interim AccessStateCard is gone). Mutation caught: any of the three
 * drawing its own card again, or the wrong kind.
 */
describe('the three access states are the shared state panel', () => {
  it.each([
    [
      'ModuleNotEnabled',
      async () => render(<ModuleNotEnabled moduleId="rentals" canManage />),
      'module-off',
      'Enable in Settings → Modules',
    ],
    [
      'PoAccessDenied',
      async () => render(<PoAccessDenied />),
      'forbidden',
      'Ask an owner or admin',
    ],
    [
      'the PO imports gate',
      () => renderImportsGate(READ_ONLY),
      'forbidden',
      'Ask an owner, admin, or manager',
    ],
  ] as const)('%s', async (_name, show, kind, nextStep) => {
    const { container } = await show();
    const panels = container.querySelectorAll<HTMLElement>('[data-slot="state-panel"]');
    expect(panels).toHaveLength(1);
    const panel = panels[0]!;
    expect(panel).toHaveAttribute('data-state-kind', kind);
    // Page size on the card surface.
    expect(panel.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['max-w-2xl', 'min-h-[280px]', 'rounded-lg', 'border', 'bg-card']),
    );
    // The h1 and the next step are the panel's own.
    expect(within(panel).getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(within(panel).getByText(new RegExp(`^${nextStep}`))).toBeInTheDocument();
    // The page's gutters around it (the shell's main has no padding).
    expect(panel.parentElement!.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['w-full', 'px-4', 'py-16', 'sm:px-8', 'sm:py-24']),
    );
  });

  it('a module that is off shows the switch-off glyph; a missing permission shows the lock', async () => {
    const glyph = (container: HTMLElement) =>
      container
        .querySelector('[data-slot="state-panel-icon"] svg')
        ?.getAttribute('class')
        ?.split(/\s+/) ?? [];
    const off = render(<ModuleNotEnabled moduleId="rentals" canManage={false} />);
    expect(glyph(off.container)).toContain('lucide-toggle-left');
    off.unmount();
    const denied = render(<PoAccessDenied />);
    expect(glyph(denied.container)).toContain('lucide-lock');
  });
});
