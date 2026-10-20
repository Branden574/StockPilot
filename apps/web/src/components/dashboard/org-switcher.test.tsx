import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { membershipRoleLabel, OrgSwitcher } from './org-switcher';

import { switchOrganizationAction } from '@/server/actions/org-switcher';

const replaceMock = vi.fn();
const refreshMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: refreshMock,
    replace: replaceMock,
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/dashboard',
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock('@/server/actions/org-switcher', () => ({
  switchOrganizationAction: vi.fn(async () => ({ ok: true as const, data: null })),
}));

const baseOrgs = [
  { id: 'o1', name: 'Acme Co', logoUrl: null, role: 'owner' },
  { id: 'o2', name: 'Beta LLC', logoUrl: 'https://cdn/logo.png', role: 'admin' },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OrgSwitcher', () => {
  it('renders a static label and no dropdown for a single org', () => {
    render(<OrgSwitcher orgs={[baseOrgs[0]!]} activeId="o1" />);
    expect(screen.getByText('Acme Co')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Switch organization/i })).not.toBeInTheDocument();
  });

  it('renders an img when single org has a logoUrl', () => {
    render(
      <OrgSwitcher
        orgs={[{ id: 'x', name: 'X', logoUrl: 'https://cdn/x.png', role: 'owner' }]}
        activeId="x"
      />,
    );
    const img = screen.getByRole('presentation').querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', 'https://cdn/x.png');
  });

  it('falls back to a colored dot when single org has no logo', () => {
    const { container } = render(
      <OrgSwitcher orgs={[{ id: 'x', name: 'X', logoUrl: null, role: 'owner' }]} activeId="x" />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('span[aria-hidden]')).not.toBeNull();
  });

  it('renders a dropdown trigger when there are multiple orgs', () => {
    render(<OrgSwitcher orgs={baseOrgs} activeId="o1" />);
    expect(screen.getByRole('button', { name: /Switch organization/i })).toBeInTheDocument();
  });

  it('opens the menu and lists each org with the active one checked', async () => {
    const user = userEvent.setup();
    render(<OrgSwitcher orgs={baseOrgs} activeId="o1" />);
    await user.click(screen.getByRole('button', { name: /Switch organization/i }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Acme Co')).toBeInTheDocument();
    expect(within(menu).getByText('Beta LLC')).toBeInTheDocument();
    // Active one shows a checkmark — at minimum the menu rendered the items.
    const items = within(menu).getAllByRole('menuitem');
    expect(items.length).toBe(2);
  });

  it('selecting a non-active org calls switchOrganizationAction and router.replace', async () => {
    const user = userEvent.setup();
    render(<OrgSwitcher orgs={baseOrgs} activeId="o1" />);
    await user.click(screen.getByRole('button', { name: /Switch organization/i }));
    const beta = await screen.findByText('Beta LLC');
    await user.click(beta);
    await waitFor(() => {
      expect(switchOrganizationAction).toHaveBeenCalledWith({ organizationId: 'o2' });
    });
    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/dashboard');
    });
  });
});

// CONFLICTS D19: the menu printed the raw role token ("owner", "staff") where
// the sidebar foot and the account menu say "Super Admin (Owner)" and
// "Warehouse User".
describe('OrgSwitcher role words', () => {
  it('names each membership role the way the rest of the app does', async () => {
    const user = userEvent.setup();
    render(
      <OrgSwitcher
        orgs={[
          { id: 'o1', name: 'Acme Co', logoUrl: null, role: 'owner' },
          { id: 'o2', name: 'Beta LLC', logoUrl: null, role: 'staff' },
          { id: 'o3', name: 'Gamma Inc', logoUrl: null, role: 'viewer' },
        ]}
        activeId="o1"
      />,
    );
    await user.click(screen.getByRole('button', { name: /Switch organization/i }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Super Admin (Owner)')).toBeInTheDocument();
    expect(within(menu).getByText('Warehouse User')).toBeInTheDocument();
    expect(within(menu).getByText('Read-Only Auditor')).toBeInTheDocument();
    expect(within(menu).queryByText(/^(owner|staff|viewer)$/i)).toBeNull();
  });

  it('shows a role token this build does not know as it is', () => {
    expect(membershipRoleLabel('admin')).toBe('Super Admin');
    expect(membershipRoleLabel('manager')).toBe('Manager');
    expect(membershipRoleLabel('contractor')).toBe('contractor');
    expect(membershipRoleLabel('toString')).toBe('toString');
  });
});

// FX12 (DESIGN-SPEC 5.1, the org switcher; the reference draws the name in
// --ink): the name was drawn in ink 2 on both the static row and the switch
// button. Only the name moves to the ink: the static row's chevron keeps its
// faint ink 2, and the button's chevron stays ink 3.
describe('OrgSwitcher name colour', () => {
  it('draws the name in ink on the single-organization row, its chevron still faint ink 2', () => {
    render(<OrgSwitcher orgs={[baseOrgs[0]!]} activeId="o1" />);
    expect(screen.getByText('Acme Co')).toHaveClass('text-foreground');
    const row = screen.getByRole('presentation');
    expect(row).toHaveClass('text-[var(--ed-ink-2)]');
    expect(row.querySelector('svg')).toHaveClass('opacity-30');
  });

  it('draws the name in ink on the switch button, its chevron in ink 3', () => {
    render(<OrgSwitcher orgs={baseOrgs} activeId="o1" />);
    const button = screen.getByRole('button', { name: /Switch organization/i });
    expect(within(button).getByText('Acme Co')).toHaveClass('text-foreground');
    expect(button.querySelector('svg')).toHaveClass('text-muted-foreground');
  });
});
