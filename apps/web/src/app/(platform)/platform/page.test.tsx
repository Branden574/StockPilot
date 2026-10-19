import { render, screen, within } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Organizations directory, redesigned (P5.3). What is pinned is what the
 * console must keep doing: the in-page gate runs before the cross-org reads,
 * the seven exact platform totals, the GET search with its Clear link, the
 * directory's columns and billing words, the disclosed 500 cap, the empty and
 * no-match words, and the two layout promises of the redesign: the table
 * scrolls inside its own keyboard-reachable card (it used to be clipped by an
 * overflow-hidden wrapper on a phone), and an org link never prefetches,
 * because rendering an org's Overview writes a viewed_org audit row.
 */

const h = vi.hoisted(() => ({
  order: [] as string[],
  listOrgsForPlatform: vi.fn(),
  getPlatformMetrics: vi.fn(),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    prefetch,
    children,
    ...rest
  }: {
    href: string;
    prefetch?: boolean | null;
    children?: ReactNode;
  } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} data-prefetch={String(prefetch)} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/auth/platform-admin', () => ({
  requirePlatformAdmin: vi.fn(async () => {
    h.order.push('gate');
  }),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { org_deletion_passphrase_hash: 'x' } }) }),
      }),
    }),
  }),
}));
vi.mock('@/server/services/platform/orgs', () => ({
  listOrgsForPlatform: (...a: unknown[]) => {
    h.order.push('list');
    return h.listOrgsForPlatform(...a);
  },
  getPlatformMetrics: (...a: unknown[]) => {
    h.order.push('metrics');
    return h.getPlatformMetrics(...a);
  },
}));
vi.mock('@/components/platform/deletion-passphrase-form', () => ({
  DeletionPassphraseForm: ({ isConfigured }: { isConfigured: boolean }) => (
    <div data-testid="passphrase-form">{String(isConfigured)}</div>
  ),
}));

import PlatformOrgsPage from './page';

function org(n: number, over: Record<string, unknown> = {}) {
  return {
    id: `org-${n}`,
    name: `Org ${n}`,
    slug: `org-${n}`,
    industry: n === 1 ? 'Education' : null,
    createdAt: '2026-01-01T00:00:00Z',
    effective: { tier: 'pro', source: 'manual', trialDaysRemaining: null },
    billingArrangement: 'standard',
    memberCount: 3 * n,
    itemCount: 10 * n,
    ...over,
  };
}

async function renderPage(q?: string) {
  const tree = await PlatformOrgsPage({ searchParams: Promise.resolve(q ? { q } : {}) });
  return render(tree);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.order = [];
  h.listOrgsForPlatform.mockResolvedValue({ orgs: [org(1), org(2)], capped: false });
  h.getPlatformMetrics.mockResolvedValue({
    totalOrgs: 1234,
    totalUsers: 56,
    totalItems: 7890,
    totalInventoryValue: 12345.67,
    totalPurchaseOrders: 11,
    totalOrders: 22,
    totalMovements: 33,
  });
});

describe('platform Organizations directory', () => {
  it('gates in the page before any cross-org read', async () => {
    await renderPage();
    expect(h.order[0]).toBe('gate');
    expect(h.order).toEqual(expect.arrayContaining(['list', 'metrics']));
  });

  it('keeps the heading, its sentence and the seven exact platform totals', async () => {
    await renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Organizations' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Every organization on the platform. Click one to view its data, manage billing, or act as it.',
      ),
    ).toBeInTheDocument();
    const totals = screen.getByLabelText('Platform totals');
    for (const [label, value] of [
      ['Organizations', '1,234'],
      ['Users', '56'],
      ['Items', '7,890'],
      ['Inventory value', '$12,346'],
      ['Purchase orders', '11'],
      ['Orders', '22'],
      ['Movements', '33'],
    ] as const) {
      const cell = within(totals).getByText(label).parentElement!;
      expect(cell).toHaveTextContent(value);
    }
  });

  it('searches by GET on ?q= and offers Clear only while a search is active', async () => {
    const { unmount } = await renderPage();
    const box = screen.getByPlaceholderText('Search by name or slug…');
    expect(box).toHaveAttribute('name', 'q');
    expect(box.closest('form')).toHaveAttribute('method', 'GET');
    expect(screen.getByRole('button', { name: 'Search' })).toHaveAttribute('type', 'submit');
    expect(screen.queryByRole('link', { name: 'Clear' })).toBeNull();
    unmount();

    await renderPage('acme');
    expect(h.listOrgsForPlatform).toHaveBeenLastCalledWith('acme');
    expect(screen.getByPlaceholderText('Search by name or slug…')).toHaveValue('acme');
    expect(screen.getByRole('link', { name: 'Clear' })).toHaveAttribute('href', '/platform');
  });

  it('keeps the directory columns and puts the table in a keyboard-reachable scroll region', async () => {
    await renderPage();
    const region = screen.getByRole('region', { name: 'Organizations' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region.className).not.toMatch(/overflow-hidden/);
    expect(region.className).toMatch(/overflow-x-auto/);
    expect(
      within(region)
        .getAllByRole('columnheader')
        .map((n) => n.textContent),
    ).toEqual(['Organization', 'Billing', 'Members', 'Items', 'Created']);
    const row = within(region).getByText('Org 1').closest('tr')!;
    expect(row).toHaveTextContent('org-1 · Education');
    expect(row).toHaveTextContent('3');
    expect(row).toHaveTextContent('10');
  });

  it('links each org to its page with prefetch off (opening it writes an audit row)', async () => {
    await renderPage();
    const link = screen.getByRole('link', { name: /Org 1/ });
    expect(link).toHaveAttribute('href', '/platform/orgs/org-1');
    expect(link).toHaveAttribute('data-prefetch', 'false');
  });

  it('labels billing with the same words', async () => {
    h.listOrgsForPlatform.mockResolvedValue({
      capped: false,
      orgs: [
        org(1, {
          billingArrangement: 'comped',
          effective: { tier: 'enterprise', source: 'manual', trialDaysRemaining: null },
        }),
        org(2, { effective: { tier: 'business', source: 'trial', trialDaysRemaining: 9 } }),
        org(3, { effective: { tier: 'pro', source: 'stripe', trialDaysRemaining: null } }),
        org(4, { billingArrangement: 'custom' }),
        org(5),
      ],
    });
    await renderPage();
    for (const words of [
      'Enterprise · Comped',
      'Business · Trial — 9d left',
      'Pro · Stripe',
      'Pro · Custom',
    ]) {
      expect(screen.getByText(words)).toBeInTheDocument();
    }
    expect(screen.getAllByText('Pro').length).toBeGreaterThan(0);
  });

  it('discloses the 500 cap, or states the count', async () => {
    const { unmount } = await renderPage();
    expect(screen.getByText('2 organizations.')).toBeInTheDocument();
    unmount();

    h.listOrgsForPlatform.mockResolvedValue({ orgs: [org(1)], capped: true });
    await renderPage();
    expect(
      screen.getByText(
        'Showing the first 500 organizations. Narrow with search to find a specific one.',
      ),
    ).toBeInTheDocument();
  });

  it('keeps the empty and no-match words', async () => {
    h.listOrgsForPlatform.mockResolvedValue({ orgs: [], capped: false });
    const { unmount } = await renderPage();
    expect(screen.getByText('No organizations yet.')).toBeInTheDocument();
    unmount();

    await renderPage('zzz');
    const line = screen.getByText('No organizations match “zzz”.');
    expect(line.closest('[data-state-kind]')).toHaveAttribute('data-state-kind', 'no-match');
  });

  it('keeps the deletion passphrase form, told whether one is configured', async () => {
    await renderPage();
    expect(screen.getByTestId('passphrase-form')).toHaveTextContent('true');
  });
});
