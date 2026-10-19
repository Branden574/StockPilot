import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Review product families page in the redesign (P4.A1, matrix W-IT-09):
// the shared page header saying nothing is linked until Link is pressed, the
// way back, the review cards (or its empty state) and the gates of Product
// groups.

const ctxHolder = vi.hoisted(() => ({
  current: { role: 'manager' as 'owner' | 'manager' | 'staff' },
  moduleOn: true,
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u-1',
    role: ctxHolder.current.role,
  })),
}));
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: ctxHolder.moduleOn, canManage: true })),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('@/server/services/context', () => ({ withContext: vi.fn(async () => ({})) }));
const { suggestFamilies, listForPicker, reviewProps } = vi.hoisted(() => ({
  suggestFamilies: vi.fn(),
  listForPicker: vi.fn(async () => ({ groups: [{ id: 'g-1', name: 'Pegasus' }], truncated: true })),
  reviewProps: vi.fn(),
}));
vi.mock('@/server/services/product-group-linking', () => ({ suggestFamilies }));
vi.mock('@/server/services/product-groups', () => ({
  ProductGroupsService: class {
    listForPicker = listForPicker;
  },
}));
vi.mock('@/components/inventory/group-linking-review', () => ({
  GroupLinkingReview: (props: Record<string, unknown>) => {
    reviewProps(props);
    return <p data-testid="review" />;
  },
}));
vi.mock('@/components/dashboard/module-not-enabled', () => ({
  ModuleNotEnabled: ({ moduleId }: { moduleId: string }) => <h1>{`${moduleId} is off`}</h1>,
}));

import ProductGroupLinkPage, { metadata } from './page';

beforeEach(() => {
  vi.clearAllMocks();
  ctxHolder.current = { role: 'manager' };
  ctxHolder.moduleOn = true;
  suggestFamilies.mockResolvedValue([
    { styleKey: 's-1', baseName: 'Pegasus', members: [], caveats: [], confidence: 'medium' },
  ]);
});

describe('Review product families page', () => {
  it('keeps its tab title', () => {
    expect(metadata.title).toBe('Review product families');
  });

  it('says nothing is linked until Link is pressed, keeps the way back and the review', async () => {
    render(await ProductGroupLinkPage());
    expect(
      screen.getByRole('heading', { level: 1, name: 'Review product families' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Nothing is linked until you press\s+Link on a family\./),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to product groups' })).toHaveAttribute(
      'href',
      '/dashboard/product-groups',
    );
    expect(reviewProps).toHaveBeenCalledWith(
      expect.objectContaining({
        groupsTruncated: true,
        existingGroups: [{ id: 'g-1', name: 'Pegasus' }],
      }),
    );
  });

  it('shows its empty state when there is nothing to review', async () => {
    suggestFamilies.mockResolvedValue([]);
    render(await ProductGroupLinkPage());
    expect(screen.getByText('No families to review')).toBeInTheDocument();
    expect(screen.queryByTestId('review')).not.toBeInTheDocument();
  });

  it('keeps both gates: the module, then sports:manage', async () => {
    ctxHolder.moduleOn = false;
    render(await ProductGroupLinkPage());
    expect(screen.getByRole('heading', { name: 'sports is off' })).toBeInTheDocument();
    ctxHolder.moduleOn = true;
    ctxHolder.current = { role: 'staff' };
    await expect(ProductGroupLinkPage()).rejects.toThrow('redirect:/dashboard');
  });
});
