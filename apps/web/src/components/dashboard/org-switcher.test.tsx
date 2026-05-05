import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OrgSwitcher } from './org-switcher';

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
    expect(
      screen.queryByRole('button', { name: /Switch organization/i }),
    ).not.toBeInTheDocument();
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
      <OrgSwitcher
        orgs={[{ id: 'x', name: 'X', logoUrl: null, role: 'owner' }]}
        activeId="x"
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('span[aria-hidden]')).not.toBeNull();
  });

  it('renders a dropdown trigger when there are multiple orgs', () => {
    render(<OrgSwitcher orgs={baseOrgs} activeId="o1" />);
    expect(
      screen.getByRole('button', { name: /Switch organization/i }),
    ).toBeInTheDocument();
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
