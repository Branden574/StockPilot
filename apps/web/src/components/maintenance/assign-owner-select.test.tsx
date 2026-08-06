import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const refreshMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: refreshMock, back: vi.fn() }),
}));

const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() },
}));

type ActionResult = { ok: true } | { error: { message: string } };
const assignOwner = vi.fn(async (..._args: unknown[]): Promise<ActionResult> => ({ ok: true }));
vi.mock('@/server/actions/maintenance-requests', () => ({
  assignMaintenanceOwnerAction: (...args: unknown[]) => assignOwner(...args),
}));

import { AssignOwnerSelect } from './assign-owner-select';

const MEMBERS = [
  { userId: 'u-1', name: 'Jane Smith' },
  { userId: 'u-2', name: 'Andrew Rosas' },
];

beforeEach(() => vi.clearAllMocks());

describe('AssignOwnerSelect', () => {
  it("labels the control 'StockPilot owner' with the non-Zendesk helper text (brief §5)", () => {
    render(<AssignOwnerSelect requestId="r1" currentOwnerUserId={null} members={MEMBERS} />);
    expect(screen.getByText('StockPilot owner')).toBeInTheDocument();
    expect(
      screen.getByText('Internal coordinator inside StockPilot. This is not a Zendesk assignment.'),
    ).toBeInTheDocument();
  });

  it('starts on Unassigned when there is no current owner', () => {
    render(<AssignOwnerSelect requestId="r1" currentOwnerUserId={null} members={MEMBERS} />);
    expect(screen.getByRole('combobox')).toHaveTextContent('Unassigned');
  });

  it('picking a member calls assignMaintenanceOwnerAction with the userId and refreshes on success', async () => {
    const user = userEvent.setup();
    render(<AssignOwnerSelect requestId="r1" currentOwnerUserId={null} members={MEMBERS} />);
    await user.click(screen.getByRole('combobox'));
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByRole('option', { name: 'Andrew Rosas' }));
    expect(assignOwner).toHaveBeenCalledWith('r1', 'u-2');
    expect(refreshMock).toHaveBeenCalled();
  });

  it('picking Unassigned sends null (unassigning), not the sentinel value', async () => {
    const user = userEvent.setup();
    render(<AssignOwnerSelect requestId="r1" currentOwnerUserId="u-1" members={MEMBERS} />);
    await user.click(screen.getByRole('combobox'));
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByRole('option', { name: 'Unassigned' }));
    expect(assignOwner).toHaveBeenCalledWith('r1', null);
  });

  it('reverts to the previous value and toasts on a failed assignment', async () => {
    assignOwner.mockResolvedValueOnce({ error: { message: 'That user is not an active member of this organization.' } });
    const user = userEvent.setup();
    render(<AssignOwnerSelect requestId="r1" currentOwnerUserId={null} members={MEMBERS} />);
    await user.click(screen.getByRole('combobox'));
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByRole('option', { name: 'Jane Smith' }));
    expect(toastError).toHaveBeenCalledWith('That user is not an active member of this organization.');
    expect(screen.getByRole('combobox')).toHaveTextContent('Unassigned');
  });
});
