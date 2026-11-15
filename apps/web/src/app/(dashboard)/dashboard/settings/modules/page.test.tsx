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
  /** What the organization_modules read resolves to. */
  rows: { data: [{ module_id: 'rentals', enabled: true }], error: null } as {
    data: unknown;
    error: unknown;
  },
  refresh: (() => undefined) as () => void,
  toggles: null as null | { comped?: boolean; enabledIds: string[] },
}));

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: () => ({ refresh: () => state.refresh() }),
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
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.then = (ok: (v: unknown) => unknown) => Promise.resolve(state.rows).then(ok);
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
  state.rows = { data: [{ module_id: 'rentals', enabled: true }], error: null };
  state.refresh = () => undefined;
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

/**
 * The switches show what the organization's module rows say. Rows that could
 * not be read say nothing: the page then shows no switches (every one would
 * read "off") and says the modules could not be loaded, with Try again.
 */
describe('Settings > Modules: the module rows could not be read', () => {
  it.each([
    ['a failed read', { data: null, error: { message: 'upstream timeout', code: '57014' } }],
    ['an answer that is not a list of rows', { data: null, error: null }],
  ])('%s: no switches, the page says so, and Try again asks the server again', async (_n, rows) => {
    state.rows = rows;
    const refresh = vi.fn();
    state.refresh = refresh;
    render(await ModulesSettingsPage());
    expect(screen.queryByTestId('toggles')).toBeNull();
    expect(state.toggles).toBeNull();
    expect(screen.getByRole('heading', { name: "We couldn't load your modules" })).toBeInTheDocument();
    expect(
      screen.getByText('Nothing was changed. This is usually temporary. Try again in a moment.'),
    ).toBeInTheDocument();
    screen.getByRole('button', { name: 'Try again' }).click();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('an organization with no rows at all still gets its switches, all off', async () => {
    state.rows = { data: [], error: null };
    render(await ModulesSettingsPage());
    expect(screen.getByTestId('toggles')).toBeInTheDocument();
    expect(state.toggles).toMatchObject({ enabledIds: [] });
  });
});

