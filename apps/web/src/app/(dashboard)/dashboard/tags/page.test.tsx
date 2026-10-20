// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Tags page (W-BK-11). Kept: the items:update gate (anyone without it is
 * sent to the Overview before a tag is read), the rows with their usage
 * counts, New tag and the tab title. Added by the redesign (PLAN rule 10):
 * the h1 follows a Settings > Navigation rename of the Tags sidebar entry, as
 * the sidebar and the crumb already do, and keeps "Tags" when there is no
 * rename or the lookup fails.
 */

const h = vi.hoisted(() => ({
  ctx: { organizationId: 'org-1', userId: 'u-1', role: 'manager', permissions: null } as Record<
    string,
    unknown
  >,
  listWithCounts: vi.fn(),
  effectiveNavLabel: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw Object.assign(new Error(`NEXT_REDIRECT ${to}`), {
      digest: `NEXT_REDIRECT;replace;${to}`,
    });
  }),
}));

vi.mock('next/navigation', () => ({
  redirect: (to: string) => h.redirect(to),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/tags',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/auth/session', () => ({ requireOrgContext: vi.fn(async () => h.ctx) }));
vi.mock('@/lib/nav-labels', () => ({
  effectiveNavLabel: (...args: unknown[]) => h.effectiveNavLabel(...args),
}));
vi.mock('@/server/services/tags', () => ({
  TagsService: { forCurrentUser: vi.fn(async () => ({ listWithCounts: h.listWithCounts })) },
}));
vi.mock('@/server/actions/tags', () => ({
  createTagAction: vi.fn(),
  deleteTagAction: vi.fn(),
  updateTagAction: vi.fn(),
}));

import TagsPage, { metadata } from './page';

beforeEach(() => {
  vi.clearAllMocks();
  h.ctx = { organizationId: 'org-1', userId: 'u-1', role: 'manager', permissions: null };
  h.listWithCounts.mockResolvedValue([
    { id: 't-1', name: 'Fragile', color: '#f97316', usage_count: 3 },
  ]);
  h.effectiveNavLabel.mockImplementation(async (_href: string, fallback: string) => fallback);
});

describe('Tags page', () => {
  it('names the tab Tags (CONFLICTS D16)', () => {
    expect(metadata).toEqual({ title: 'Tags' });
  });

  it('draws the h1, New tag and every row with its usage count', async () => {
    render(await TagsPage());
    expect(screen.getByRole('heading', { level: 1, name: 'Tags' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New tag/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fragile' })).toBeInTheDocument();
    expect(screen.getByText('3 items')).toBeInTheDocument();
    expect(h.effectiveNavLabel).toHaveBeenCalledWith('/dashboard/tags', 'Tags');
  });

  it('the h1 follows a Settings > Navigation rename of the sidebar entry (PLAN rule 10)', async () => {
    h.effectiveNavLabel.mockResolvedValue('Labels');
    render(await TagsPage());
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Labels');
    expect(screen.queryByRole('heading', { level: 1, name: 'Tags' })).not.toBeInTheDocument();
  });

  it('a failed lookup keeps "Tags" instead of failing the page', async () => {
    h.effectiveNavLabel.mockRejectedValue(new Error('org row unreadable'));
    render(await TagsPage());
    expect(screen.getByRole('heading', { level: 1, name: 'Tags' })).toBeInTheDocument();
  });

  it('a reader without items:update goes to the Overview before any tag is read', async () => {
    h.ctx = { organizationId: 'org-1', userId: 'u-2', role: 'viewer', permissions: null };
    await expect(TagsPage()).rejects.toThrow('NEXT_REDIRECT /dashboard');
    expect(h.redirect).toHaveBeenCalledWith('/dashboard');
    expect(h.listWithCounts).not.toHaveBeenCalled();
  });
});
