// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StartCycleCountForm } from './start-cycle-count-form';

// The Whole warehouse scope: snapshot one warehouse or every active item, with
// optional notes; the toast states how many items the snapshot covers and the
// new count opens. Its fields are named by their visible labels (the labels
// were not tied to the fields before the redesign).

const { routerMock, startActionMock } = vi.hoisted(() => ({
  routerMock: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() },
  startActionMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => routerMock }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock('@/server/actions/cycle-counts', () => ({ startCycleCountAction: startActionMock }));

const WAREHOUSES = [{ id: 'w1', name: 'Main DC' }];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('StartCycleCountForm', () => {
  it('names its fields by their labels', () => {
    render(<StartCycleCountForm warehouses={WAREHOUSES} />);
    expect(screen.getByRole('combobox', { name: 'Warehouse' })).toHaveTextContent('All warehouses');
    expect(screen.getByRole('textbox', { name: 'Notes (optional)' })).toHaveAttribute(
      'placeholder',
      'e.g. Quarterly count · DC4 · Q2 2026',
    );
  });

  it('starts a whole-org count with the notes, says how many items, and opens it', async () => {
    const user = userEvent.setup();
    startActionMock.mockResolvedValue({ ok: true, data: { id: 'cc-7', lineCount: 3 } });
    render(<StartCycleCountForm warehouses={WAREHOUSES} />);
    await user.type(screen.getByRole('textbox', { name: 'Notes (optional)' }), '  Spring count  ');
    await user.click(screen.getByRole('button', { name: 'Start count' }));
    expect(startActionMock).toHaveBeenCalledWith({ warehouseId: null, notes: 'Spring count' });
    await vi.waitFor(() => {
      expect(routerMock.push).toHaveBeenCalledWith('/dashboard/cycle-counts/cc-7');
    });
    expect(toast.success).toHaveBeenCalledWith('Cycle count started. Snapshot covers 3 items.');
  });

  it('a refused start says why and stays on the form', async () => {
    const user = userEvent.setup();
    startActionMock.mockResolvedValue({
      ok: false,
      error: { code: 'forbidden', message: 'Only a manager can start a count.' },
    });
    render(<StartCycleCountForm warehouses={WAREHOUSES} />);
    await user.click(screen.getByRole('button', { name: 'Start count' }));
    await vi.waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Only a manager can start a count.');
    });
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Start count' })).toBeEnabled();
  });
});
