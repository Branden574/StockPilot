import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const updatePoNotesAction = vi.fn();
const refresh = vi.fn();

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/purchase-orders', () => ({
  updatePoNotesAction: (...args: unknown[]) => updatePoNotesAction(...args),
}));

import { PoNotesEditor } from './po-notes-editor';

/**
 * The notes row of the PO's Summary keeps its words: "Notes", Add or Edit,
 * "No notes yet.", the dialog's title, sentence, counter and Save.
 */

beforeEach(() => {
  vi.clearAllMocks();
  updatePoNotesAction.mockResolvedValue({ ok: true, data: null });
});

describe('PoNotesEditor', () => {
  it('without notes: "No notes yet." and Add, which opens Add notes', async () => {
    const user = userEvent.setup();
    render(<PoNotesEditor poId="po-1" currentNotes={null} />);
    expect(screen.getByText('Notes')).toBeInTheDocument();
    expect(screen.getByText('No notes yet.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add notes' });
    expect(
      within(dialog).getByText(
        'Notes can be updated at any time, even after the order is received.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('0/2000')).toBeInTheDocument();
  });

  it('with notes: shows them and Edit, and Save posts the new words', async () => {
    const user = userEvent.setup();
    render(<PoNotesEditor poId="po-1" currentNotes={'Dock 2\nAfter 3 PM'} />);
    expect(screen.getByText(/Dock 2/)).toHaveTextContent('Dock 2 After 3 PM');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit notes' });
    const box = within(dialog).getByRole('textbox');
    await user.clear(box);
    await user.type(box, 'Dock 4');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(updatePoNotesAction).toHaveBeenCalledWith('po-1', 'Dock 4');
  });
});
