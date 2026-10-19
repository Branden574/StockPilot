import { cleanup, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { effectivePermissions, type Role } from '@stockpilot/core';

/**
 * The New bundle page in the redesign (P4.D2, matrix W-CA-13): the shared page
 * header with today's back link, title and subline, and the manage gate's
 * redirect. The form itself is tested in components/bundles.
 */

const ctx: { role: Role; permissions: ReadonlySet<string> } = {
  role: 'owner',
  permissions: effectivePermissions('owner'),
};
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
vi.mock('@/components/bundles/bundle-form', () => ({
  BundleForm: (props: unknown) => {
    formProps(props);
    return <form aria-label="bundle form" />;
  },
}));

import NewBundlePage from './page';

function as(role: Role) {
  ctx.role = role;
  ctx.permissions = effectivePermissions(role);
}

beforeEach(() => {
  cleanup();
  as('owner');
  formProps.mockReset();
});

describe('New bundle page', () => {
  it('draws the header with the back link, the title and its subline, then the empty form', async () => {
    render(await NewBundlePage());
    expect(screen.getByRole('link', { name: '← Back to bundles' })).toHaveAttribute(
      'href',
      '/dashboard/bundles',
    );
    expect(screen.getByRole('heading', { level: 1, name: 'New bundle' })).toBeTruthy();
    expect(
      screen.getByText(
        'Define a reusable kit. Choose components and per-kit quantities. Optionally enable pre-assembly to box kits ahead of distribution.',
      ),
    ).toBeTruthy();
    expect(formProps).toHaveBeenCalledWith({});
  });

  it('without bundles:manage it redirects to the list', async () => {
    as('staff');
    await expect(NewBundlePage()).rejects.toThrow('redirect:/dashboard/bundles');
  });
});
