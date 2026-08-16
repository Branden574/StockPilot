import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const refreshMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: refreshMock, back: vi.fn() }),
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock('sonner', () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: (...a: unknown[]) => toastSuccess(...a) },
}));

type ActionResult = { ok: true } | { ok: false; error: { message: string } };
const updateSettings = vi.fn(async (..._args: unknown[]): Promise<ActionResult> => ({ ok: true }));
vi.mock('@/server/actions/maintenance-settings', () => ({
  updateMaintenanceSettingsAction: (...args: unknown[]) => updateSettings(...args),
}));

import { MaintenanceSettingsPanel } from './maintenance-settings-panel';

const MEMBERS = [
  { userId: 'u-1', name: 'Jane Smith' },
  { userId: 'u-2', name: 'Andrew Rosas' },
];

function renderPanel(overrides: Partial<React.ComponentProps<typeof MaintenanceSettingsPanel>> = {}) {
  return render(
    <MaintenanceSettingsPanel
      initialCategories={['Facilities', 'Electrical']}
      initialIncludeShareLinksInEmail={true}
      initialNotifyAudience={{}}
      members={MEMBERS}
      {...overrides}
    />,
  );
}

// Matches detail-client.test.tsx / maintenance/page.test.tsx's exact word
// list (brief section 20 — the accurate-status-language ban). Task 14's
// lesson: Radix portals (Select, Dialog) unmount their content from the DOM
// while closed, so a sweep that never opens them proves nothing — the tests
// below open the per-member Select before sweeping document.body.
const FORBIDDEN = [
  'Ticket created',
  'Request submitted to Zendesk',
  'DC4 notified',
  'Andrew notified',
  'Ticket assigned',
  'Email sent',
  'Zendesk comment',
];

function sweep() {
  for (const banned of FORBIDDEN) {
    expect(document.body.textContent).not.toContain(banned);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  updateSettings.mockResolvedValue({ ok: true });
});

describe('MaintenanceSettingsPanel — categories', () => {
  it('renders the initial categories', () => {
    renderPanel();
    expect(screen.getByText('Facilities')).toBeInTheDocument();
    expect(screen.getByText('Electrical')).toBeInTheDocument();
  });

  it('adds a new category typed into the input', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(screen.getByPlaceholderText('Add a category'), 'Vehicle');
    await user.click(screen.getByRole('button', { name: /add/i }));
    expect(screen.getByText('Vehicle')).toBeInTheDocument();
  });

  it('removes a category when more than one remains', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Remove Electrical' }));
    expect(screen.queryByText('Electrical')).not.toBeInTheDocument();
    expect(screen.getByText('Facilities')).toBeInTheDocument();
  });

  it('refuses to remove the last remaining category', async () => {
    const user = userEvent.setup();
    renderPanel({ initialCategories: ['Facilities'] });
    await user.click(screen.getByRole('button', { name: 'Remove Facilities' }));
    expect(screen.getByText('Facilities')).toBeInTheDocument();
    expect(toastError).toHaveBeenCalledWith('Keep at least one category.');
  });
});

describe('MaintenanceSettingsPanel — photo links in email', () => {
  it('shows the exact helper copy for the off state', () => {
    renderPanel();
    expect(
      screen.getByText('When off, the email lists the photo count but carries no link.'),
    ).toBeInTheDocument();
  });

  it('toggling the checkbox flips local state (unchecked -> checked reflected in the DOM)', async () => {
    const user = userEvent.setup();
    renderPanel({ initialIncludeShareLinksInEmail: false });
    const box = screen.getByRole('checkbox', { name: /secure photo link/i });
    expect(box).not.toBeChecked();
    await user.click(box);
    expect(box).toBeChecked();
  });
});

describe('MaintenanceSettingsPanel — notification audience', () => {
  it('renders one audience selector per member, defaulting to None', () => {
    renderPanel();
    expect(screen.getByRole('combobox', { name: 'Notification audience for Jane Smith' })).toHaveTextContent(
      'None',
    );
    expect(
      screen.getByRole('combobox', { name: 'Notification audience for Andrew Rosas' }),
    ).toHaveTextContent('None');
  });

  it('reflects an initial notifyAudience value', () => {
    renderPanel({ initialNotifyAudience: { 'u-2': 'urgent_only' } });
    expect(
      screen.getByRole('combobox', { name: 'Notification audience for Andrew Rosas' }),
    ).toHaveTextContent('Urgent only');
  });

  it('picking a value updates the selector (open the portalled listbox, pick, verify)', async () => {
    const user = userEvent.setup();
    renderPanel();
    const combo = screen.getByRole('combobox', { name: 'Notification audience for Jane Smith' });
    await user.click(combo);
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByRole('option', { name: 'All new requests' }));
    expect(combo).toHaveTextContent('All new requests');
  });
});

describe('MaintenanceSettingsPanel — recipients pin (mutation self-check 3)', () => {
  it('no compiled tenant mailbox is printed; the card links to the per-org Email routing page instead', () => {
    // Per-org email routing (migration 0337): this card used to print
    // L4L's compiled mailboxes to EVERY org's admins with "Recipients are
    // fixed in this release. Contact support to change them." — that
    // support path now exists, so the fixed display is gone.
    const { container } = renderPanel();
    expect(container.textContent).not.toContain('dc4@learn4life.org');
    expect(container.textContent).not.toContain('arosas@cvwest.org');
    expect(container.textContent).not.toContain('fixed in this release');
    const link = screen.getByRole('link', { name: /Configure email routing/i });
    expect(link).toHaveAttribute('href', '/dashboard/settings/email-routing');
  });

  it('PIN: no textbox/input anywhere in the panel carries a recipient email — recipients are never editable client input', () => {
    renderPanel();
    const editable = [
      ...screen.queryAllByRole('textbox'),
      ...(document.querySelectorAll('input[type="text"], input:not([type]), textarea') as unknown as HTMLInputElement[]),
    ] as HTMLInputElement[];
    for (const el of editable) {
      expect(el.value ?? '').not.toContain('@');
    }
  });
});

describe('MaintenanceSettingsPanel — save', () => {
  it('Save sends categories + includeShareLinksInEmail + the full notifyAudience map in one patch', async () => {
    const user = userEvent.setup();
    renderPanel({ initialNotifyAudience: { 'u-2': 'all' } });
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(updateSettings).toHaveBeenCalledWith({
      categories: ['Facilities', 'Electrical'],
      includeShareLinksInEmail: true,
      notifyAudience: { 'u-2': 'all' },
    });
    expect(toastSuccess).toHaveBeenCalled();
    expect(refreshMock).toHaveBeenCalled();
  });

  it('shows an error toast and does not refresh on failure', async () => {
    updateSettings.mockResolvedValueOnce({ ok: false, error: { message: 'Nope.' } });
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(toastError).toHaveBeenCalledWith('Nope.');
    expect(refreshMock).not.toHaveBeenCalled();
  });
});

describe('MaintenanceSettingsPanel — link to the existing per-user override system (binding constraint 2, not a parallel UI)', () => {
  it('renders a prominent link to /dashboard/settings/roles with the exact label', () => {
    renderPanel();
    const link = screen.getByRole('link', { name: 'Manage who can view or manage all requests' });
    expect(link).toHaveAttribute('href', '/dashboard/settings/roles');
  });
});

describe('MaintenanceSettingsPanel — vocabulary sweep (mutation self-check 4, Tasks 14/15 lesson)', () => {
  it('the default render never contains forbidden ticket/notification vocabulary', () => {
    renderPanel();
    sweep();
  });

  it('the OPEN per-member audience listbox (portalled to document.body) never contains forbidden vocabulary', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('combobox', { name: 'Notification audience for Jane Smith' }));
    await screen.findByRole('listbox');
    sweep();
  });

  it('after adding a category and toggling the checkbox, still no forbidden vocabulary', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(screen.getByPlaceholderText('Add a category'), 'Security');
    await user.click(screen.getByRole('button', { name: /add/i }));
    await user.click(screen.getByRole('checkbox', { name: /secure photo link/i }));
    sweep();
  });
});
