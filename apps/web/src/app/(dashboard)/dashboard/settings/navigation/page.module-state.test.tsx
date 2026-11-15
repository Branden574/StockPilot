import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UnreadableModuleSet } from '@/lib/modules/module-state';
import type { ModuleId } from '@stockpilot/core';

/**
 * Settings > Navigation lists the menu items of the modules that are on, for
 * an administrator to hide, rename or reorder. When the organization's module
 * state could not be read that list is not known: the page shows no editor
 * (a core-only list would be edited and saved as if it were the whole menu)
 * and says the modules could not be checked, with Try again.
 */

const state = vi.hoisted(() => ({
  modules: null as unknown,
  editor: null as null | { baseSections: Array<{ items: Array<{ moduleId?: string }> }> },
  refresh: (() => undefined) as () => void,
}));

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
  useRouter: () => ({ refresh: () => state.refresh() }),
  usePathname: () => '/dashboard/settings/navigation',
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: async () => ({
    organizationId: 'org-1',
    userId: 'user-1',
    role: 'owner',
    permissions: new Set(['organization:update']),
  }),
}));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getModulesForRequest: async () => state.modules,
  getOrgRowForRequest: async () => ({ nav_overrides: null }),
}));
vi.mock('@/components/settings/settings-nav', () => ({
  SettingsPage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/onboarding/page-tour', () => ({ PageTour: () => null }));
vi.mock('@/components/settings/nav-customizer', () => ({
  NavCustomizer: (props: { baseSections: Array<{ items: Array<{ moduleId?: string }> }> }) => {
    state.editor = props;
    return <div data-testid="editor" />;
  },
}));

import NavigationSettingsPage from './page';

beforeEach(() => {
  state.editor = null;
  state.refresh = () => undefined;
});

describe('Settings > Navigation', () => {
  it('a module state that was read: the editor, with the items of the modules that are on', async () => {
    state.modules = new Set<ModuleId>(['rentals']);
    render(await NavigationSettingsPage());
    expect(screen.getByTestId('editor')).toBeInTheDocument();
    const moduleIds = state.editor!.baseSections.flatMap((s) => s.items.map((i) => i.moduleId));
    expect(moduleIds).toContain('rentals');
    expect(moduleIds).not.toContain('purchase_orders');
    expect(screen.queryByText("We couldn't check which modules are on")).toBeNull();
  });

  it('a module state that could not be read: no editor, the page says so, and Try again asks the server again', async () => {
    state.modules = new UnreadableModuleSet([]);
    const refresh = vi.fn();
    state.refresh = refresh;
    render(await NavigationSettingsPage());
    expect(screen.queryByTestId('editor')).toBeNull();
    expect(state.editor).toBeNull();
    // Nothing on the page saves the menu.
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(
      screen.getByRole('heading', { name: "We couldn't check which modules are on" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The menu can't be edited until they are read. This is usually temporary. Try again in a moment.",
      ),
    ).toBeInTheDocument();
    screen.getByRole('button', { name: 'Try again' }).click();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
