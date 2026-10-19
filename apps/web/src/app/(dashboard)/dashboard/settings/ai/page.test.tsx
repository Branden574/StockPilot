import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The AI settings page under the shared page header: the Settings / AI crumb
// sits in the header's back slot as plain text and a link. The topbar already
// renders the one navigation landmark named "Breadcrumb", so the page must not
// add a second one with the same name (axe landmark-unique).

const ctxHolder = vi.hoisted(() => ({
  current: { role: 'owner' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer' },
}));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'user-1',
    role: ctxHolder.current.role,
  })),
}));

function countQuery(count: number) {
  const q: Record<string, unknown> = {};
  q.eq = () => q;
  q.is = () => q;
  q.then = (resolve: (v: { count: number }) => unknown) => resolve({ count });
  return q;
}

const counts = vi.hoisted(() => ({ calls: 0 }));

vi.mock('@/server/services/context', () => ({
  withContext: vi.fn(async () => ({
    organizationId: 'org-1',
    supabase: {
      from: () => ({
        select: () => {
          counts.calls += 1;
          // First read: items still without an embedding; second: all items.
          return countQuery(counts.calls % 2 === 1 ? 3 : 10);
        },
      }),
    },
  })),
}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
}));

const panelProps = vi.fn();
vi.mock('@/components/settings/embeddings-backfill-panel', () => ({
  EmbeddingsBackfillPanel: (props: Record<string, unknown>) => {
    panelProps(props);
    return <div data-testid="embeddings-backfill-panel" />;
  },
}));

import AiSettingsPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  counts.calls = 0;
  ctxHolder.current = { role: 'owner' };
});

describe('AI settings page', () => {
  it('keeps the Settings crumb link to /dashboard/settings', async () => {
    render(await AiSettingsPage());
    expect(screen.getByRole('heading', { level: 1, name: 'AI' })).toBeInTheDocument();
    const crumb = screen.getByRole('link', { name: 'Settings' });
    expect(crumb).toHaveAttribute('href', '/dashboard/settings');
    // The crumb's trail names the page beside the link.
    expect(within(crumb.parentElement as HTMLElement).getByText('AI')).toBeInTheDocument();
  });

  it('adds no navigation landmark named Breadcrumb (the topbar owns that one)', async () => {
    render(await AiSettingsPage());
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
    expect(screen.queryAllByRole('navigation')).toHaveLength(0);
  });

  it('passes the first-paint counts to the backfill panel', async () => {
    render(await AiSettingsPage());
    expect(screen.getByTestId('embeddings-backfill-panel')).toBeInTheDocument();
    expect(panelProps).toHaveBeenCalledWith(
      expect.objectContaining({ initialRemaining: 3, initialTotal: 10 }),
    );
  });

  it('is not found for a role without ai:manage', async () => {
    ctxHolder.current = { role: 'staff' };
    await expect(AiSettingsPage()).rejects.toThrow('notFound');
  });
});
