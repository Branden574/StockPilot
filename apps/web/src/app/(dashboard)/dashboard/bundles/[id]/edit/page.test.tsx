import { cleanup, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { effectivePermissions, type Role } from '@stockpilot/core';

/**
 * The Edit bundle page in the redesign (P4.D2, matrix W-CA-12): the shared
 * page header with today's back link and title, the manage gate's redirect to
 * the bundle, and a 404 for a bundle that cannot be loaded. The form itself is
 * tested in components/bundles.
 */

const ctx: { role: Role; permissions: ReadonlySet<string> } = {
  role: 'owner',
  permissions: effectivePermissions('owner'),
};
const get = vi.fn();
const formProps = vi.fn();

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({ organizationId: 'org-1', userId: 'u-1', ...ctx })),
}));
vi.mock('@/server/services/bundles', () => ({
  BundlesService: { forCurrentUser: vi.fn(async () => ({ get })) },
}));
vi.mock('@/components/bundles/bundle-form', () => ({
  BundleForm: (props: unknown) => {
    formProps(props);
    return <form aria-label="bundle form" />;
  },
}));

import EditBundlePage from './page';

const BUNDLE_ID = '5eed0000-0000-4000-8000-0000000000b9';

function as(role: Role) {
  ctx.role = role;
  ctx.permissions = effectivePermissions(role);
}

beforeEach(() => {
  cleanup();
  as('owner');
  get.mockReset();
  formProps.mockReset();
});

describe('Edit bundle page', () => {
  const params = Promise.resolve({ id: BUNDLE_ID });

  it('draws the header with the back link to the bundle and passes the bundle to the form', async () => {
    get.mockResolvedValue({
      bundle: {
        id: BUNDLE_ID,
        name: 'Kit',
        sku: 'KIT-1',
        description: null,
        preassembly_enabled: true,
      },
      components: [
        { itemId: 'i-1', itemName: 'Pen', itemSku: 'PEN', quantity: 0.5, isOptional: true },
      ],
    });
    render(await EditBundlePage({ params }));
    expect(screen.getByRole('link', { name: '← Back to bundle' })).toHaveAttribute(
      'href',
      `/dashboard/bundles/${BUNDLE_ID}`,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Edit bundle' })).toBeTruthy();
    expect(formProps).toHaveBeenCalledWith({
      initial: {
        id: BUNDLE_ID,
        name: 'Kit',
        sku: 'KIT-1',
        description: null,
        preassemblyEnabled: true,
        components: [
          { itemId: 'i-1', itemName: 'Pen', itemSku: 'PEN', quantity: 0.5, isOptional: true },
        ],
      },
    });
  });

  it('without bundles:manage it redirects to the bundle', async () => {
    as('staff');
    await expect(EditBundlePage({ params })).rejects.toThrow(
      `redirect:/dashboard/bundles/${BUNDLE_ID}`,
    );
  });

  it('a bundle that cannot be loaded is a 404', async () => {
    get.mockRejectedValue(new Error('missing'));
    await expect(EditBundlePage({ params })).rejects.toThrow('notFound');
  });

  // B63: a mistyped or cut-off link is Page not found, ahead of the
  // bundles:manage redirect and before the bundle is read.
  it('an id that is not a uuid is a 404 with nothing read, even without bundles:manage', async () => {
    const { requireOrgContext } = await import('@/lib/auth/session');
    vi.mocked(requireOrgContext).mockClear();
    as('staff');
    for (const id of ['not-a-uuid', BUNDLE_ID.slice(0, -1)]) {
      await expect(EditBundlePage({ params: Promise.resolve({ id }) }), id).rejects.toThrow(
        'notFound',
      );
    }
    expect(requireOrgContext).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
});
