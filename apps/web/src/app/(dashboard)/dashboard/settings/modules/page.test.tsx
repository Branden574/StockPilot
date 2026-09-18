import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Settings > Modules reads the all-modules comp ONLY to decide what it says. It
 * must tell a comped organization the truth, and it must never take itself down
 * over that read: getOrgRowForRequest THROWS on a read error, and this page
 * rendered fine through one before it read the flag at all.
 */

const state = vi.hoisted(() => ({
  org: { all_modules_comp: false } as { all_modules_comp?: boolean | null } | null,
  orgThrows: false,
  toggles: null as null | { comped?: boolean; enabledIds: string[] },
}));

vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
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
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.then = (ok: (v: unknown) => unknown) =>
        Promise.resolve({ data: [{ module_id: 'rentals', enabled: true }], error: null }).then(ok);
      return q;
    },
  }),
}));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: async () => {
    if (state.orgThrows) throw new Error('getOrgRowForRequest: upstream timeout');
    return state.org;
  },
}));
vi.mock('@/components/settings/module-toggles', () => ({
  ModuleToggles: (props: { comped?: boolean; enabledIds: string[] }) => {
    state.toggles = props;
    return <div data-testid="toggles" />;
  },
}));

import ModulesSettingsPage from './page';

beforeEach(() => {
  state.org = { all_modules_comp: false };
  state.orgThrows = false;
  state.toggles = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('Settings > Modules', () => {
  it('says nothing special to an organization that is not comped', async () => {
    render(await ModulesSettingsPage());
    expect(screen.queryByRole('note')).toBeNull();
    expect(state.toggles).toMatchObject({ comped: false, enabledIds: ['rentals'] });
  });

  it('tells a COMPED organization what is true: included for the team, the switch governs the rest', async () => {
    state.org = { all_modules_comp: true };
    render(await ModulesSettingsPage());
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('Every module is included for your organization.');
    // The list must match what really stays on the explicit switch.
    for (const phrase of [
      /scheduled jobs/i,
      /exports to accounting/i,
      /public links/i,
      /customer portal/i,
    ])
      expect(note).toHaveTextContent(phrase);
    expect(note).not.toHaveTextContent(/webhook/i); // webhooks are governed per endpoint, not here
    expect(screen.getByRole('link', { name: 'Navigation' })).toHaveAttribute(
      'href',
      '/dashboard/settings/navigation',
    );
    expect(state.toggles).toMatchObject({ comped: true });
  });

  it('STILL RENDERS when the comp flag cannot be read, as not comped', async () => {
    state.orgThrows = true;
    render(await ModulesSettingsPage());
    expect(screen.getByTestId('toggles')).toBeInTheDocument();
    expect(screen.queryByRole('note')).toBeNull();
    expect(state.toggles).toMatchObject({ comped: false });
  });

  it('only an explicit true is a comp', async () => {
    state.org = { all_modules_comp: null };
    render(await ModulesSettingsPage());
    expect(state.toggles).toMatchObject({ comped: false });
  });
});
