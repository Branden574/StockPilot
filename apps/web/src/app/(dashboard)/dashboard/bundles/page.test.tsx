import { cleanup, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { effectivePermissions, type Role } from '@stockpilot/core';

/**
 * The bundle list in the redesign (P4.D2, matrix W-CA-10): the shared page
 * header, the Active / Archived toggle and the GET search in one filter row,
 * the table card, and the empty and no-match states, each with today's words,
 * links and gates. Bundles are kits, not product groups: the list has no row
 * selection and no Group selected / Ungroup.
 */

const state: {
  role: Role;
  permissions: ReadonlySet<string>;
  moduleEnabled: boolean;
  rows: unknown[];
} = {
  role: 'owner',
  permissions: effectivePermissions('owner'),
  moduleEnabled: true,
  rows: [],
};
const list = vi.fn(async () => state.rows);

vi.mock('next/navigation', () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
  usePathname: () => '/dashboard/bundles',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: state.moduleEnabled, canManage: true })),
}));
vi.mock('@/components/dashboard/module-not-enabled', () => ({
  ModuleNotEnabled: ({ moduleId }: { moduleId: string }) => <p>module off: {moduleId}</p>,
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u-1',
    role: state.role,
    permissions: state.permissions,
  })),
}));
vi.mock('@/server/services/bundles', () => ({
  BundlesService: { forCurrentUser: vi.fn(async () => ({ list })) },
}));
vi.mock('@/server/actions/bundles', () => ({ restoreBundleAction: vi.fn() }));

import BundlesListPage from './page';

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'b-1',
    name: 'Science Starter Kit',
    sku: 'KIT-SCI-01',
    componentCount: 4,
    preassemblyEnabled: true,
    preassembledQty: 3,
    isActive: true,
    archivedAt: null,
    lastDistributedAt: null,
    ...over,
  };
}

async function renderPage(params: { q?: string; view?: string } = {}) {
  return render(await BundlesListPage({ searchParams: Promise.resolve(params) }));
}

function as(role: Role) {
  state.role = role;
  state.permissions = effectivePermissions(role);
}

beforeEach(() => {
  cleanup();
  as('owner');
  state.moduleEnabled = true;
  state.rows = [];
  list.mockClear();
});

describe('bundle list: header, search and views', () => {
  it('draws the page header with the title, the active subline and + New bundle for a manager', async () => {
    state.rows = [row()];
    await renderPage();
    const header = document.querySelector('[data-slot="page-header"]')!;
    expect(
      within(header as HTMLElement).getByRole('heading', { level: 1, name: 'Bundles' }),
    ).toBeTruthy();
    expect(header).toHaveTextContent(
      'Reusable kits + book packs. Pre-assemble ahead of time, or draw components at distribution.',
    );
    expect(screen.getByRole('link', { name: '+ New bundle' })).toHaveAttribute(
      'href',
      '/dashboard/bundles/new',
    );
  });

  it('staff see the list without + New bundle', async () => {
    as('staff');
    state.rows = [row()];
    await renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Bundles' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: '+ New bundle' })).toBeNull();
  });

  it('the search is a GET form to the list with q, its placeholder, and the archived view carried', async () => {
    await renderPage({ view: 'archived', q: 'sci' });
    const input = screen.getByPlaceholderText('Search by name or SKU') as HTMLInputElement;
    expect(input.name).toBe('q');
    expect(input.defaultValue).toBe('sci');
    const form = input.closest('form')!;
    expect(form.getAttribute('action')).toBe('/dashboard/bundles');
    expect(form.getAttribute('method')).toBeNull();
    const hidden = form.querySelector('input[type="hidden"][name="view"]') as HTMLInputElement;
    expect(hidden.value).toBe('archived');
    expect(list).toHaveBeenCalledWith({ search: 'sci', includeArchived: true });
  });

  it('the active view carries no hidden view field, and the toggle offers Active and Archived', async () => {
    await renderPage();
    const form = screen.getByPlaceholderText('Search by name or SKU').closest('form')!;
    expect(form.querySelector('input[name="view"]')).toBeNull();
    const toggle = screen.getByRole('tablist', { name: 'View filter' });
    expect(within(toggle).getByRole('tab', { name: 'Active' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(toggle).getByRole('tab', { name: 'Archived' })).toHaveAttribute(
      'href',
      '/dashboard/bundles?view=archived',
    );
  });

  it('the archived view has its own subline and no + New bundle', async () => {
    await renderPage({ view: 'archived' });
    expect(
      screen.getByText('Bundles you archived. Restore one to put it back in rotation.'),
    ).toBeTruthy();
    expect(screen.queryByRole('link', { name: '+ New bundle' })).toBeNull();
  });
});

describe('bundle list: the table', () => {
  it('keeps every column and value, and links the name to the bundle', async () => {
    state.rows = [
      row(),
      row({
        id: 'b-2',
        name: 'Classroom Supply Kit',
        sku: null,
        preassemblyEnabled: false,
        isActive: false,
      }),
    ];
    await renderPage();
    const table = screen.getByRole('table');
    for (const head of [
      'Name',
      'SKU',
      'Components',
      'Pre-assembled',
      'Status',
      'Last distributed',
    ]) {
      expect(within(table).getByRole('columnheader', { name: head })).toBeTruthy();
    }
    expect(within(table).getByRole('link', { name: 'Science Starter Kit' })).toHaveAttribute(
      'href',
      '/dashboard/bundles/b-1',
    );
    const [first, second] = within(table).getAllByRole('row').slice(1);
    expect(first).toHaveTextContent('KIT-SCI-01');
    expect(first).toHaveTextContent('Active');
    expect(first).toHaveTextContent('Never');
    expect(within(first!).getAllByRole('cell')[3]).toHaveTextContent('3');
    // Pre-assembly off prints a dash; no web control sets Inactive, but the word stays.
    expect(within(second!).getAllByRole('cell')[1]).toHaveTextContent('—');
    expect(within(second!).getAllByRole('cell')[3]).toHaveTextContent('—');
    expect(second).toHaveTextContent('Inactive');
  });

  it('bundles are not product groups: no row checkboxes, no Group selected or Ungroup', async () => {
    state.rows = [row(), row({ id: 'b-2', name: 'Other kit' })];
    await renderPage();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByText(/Group selected/i)).toBeNull();
    expect(screen.queryByText(/Ungroup/i)).toBeNull();
  });

  it('the archived view swaps Last distributed for Actions with Restore for a manager', async () => {
    state.rows = [row({ archivedAt: '2026-10-01T00:00:00Z', isActive: true })];
    await renderPage({ view: 'archived' });
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Actions' })).toBeTruthy();
    expect(within(table).queryByRole('columnheader', { name: 'Last distributed' })).toBeNull();
    expect(within(table).getByText('Archived')).toBeTruthy();
    expect(within(table).getByRole('button', { name: 'Restore' })).toBeTruthy();
  });

  it('a member without bundles:manage gets a dash instead of Restore', async () => {
    as('staff');
    state.rows = [row({ archivedAt: '2026-10-01T00:00:00Z' })];
    await renderPage({ view: 'archived' });
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
  });
});

describe('bundle list: empty, no match, module off, forbidden', () => {
  it('no bundles: the empty state with Create your first bundle for a manager', async () => {
    await renderPage();
    const panel = document.querySelector('[data-slot="state-panel"]')!;
    expect(panel).toHaveAttribute('data-state-kind', 'empty');
    expect(screen.getByRole('heading', { name: 'No bundles yet' })).toBeTruthy();
    expect(
      screen.getByText(
        'Create a bundle to ship grouped sets of items in one click — useful for school packs, kits, or recurring drop-offs.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Create your first bundle' })).toHaveAttribute(
      'href',
      '/dashboard/bundles/new',
    );
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('no bundles for staff: the empty state without the create link', async () => {
    as('staff');
    await renderPage();
    expect(screen.getByRole('heading', { name: 'No bundles yet' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Create your first bundle' })).toBeNull();
  });

  it('no archived bundles: its own words', async () => {
    await renderPage({ view: 'archived' });
    expect(screen.getByRole('heading', { name: 'No archived bundles' })).toBeTruthy();
    expect(
      screen.getByText('Bundles you archive show up here so you can restore them later.'),
    ).toBeTruthy();
  });

  it('a search with no hits: the no-match state and Clear search back to the same view', async () => {
    await renderPage({ q: 'zz' });
    const panel = document.querySelector('[data-slot="state-panel"]')!;
    expect(panel).toHaveAttribute('data-state-kind', 'no-match');
    expect(screen.getByRole('heading', { name: 'No bundles match this search' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Clear search' })).toHaveAttribute(
      'href',
      '/dashboard/bundles',
    );
    cleanup();
    await renderPage({ q: 'zz', view: 'archived' });
    expect(screen.getByRole('link', { name: 'Clear search' })).toHaveAttribute(
      'href',
      '/dashboard/bundles?view=archived',
    );
  });

  it('module off renders the module page and reads nothing', async () => {
    state.moduleEnabled = false;
    await renderPage();
    expect(screen.getByText('module off: bundles')).toBeTruthy();
    expect(list).not.toHaveBeenCalled();
  });

  it('a member with neither bundles:read nor bundles:distribute is sent to the dashboard', async () => {
    state.role = 'viewer';
    state.permissions = new Set(['items:read']);
    await expect(BundlesListPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'redirect:/dashboard',
    );
  });
});
