/**
 * Focused tests for EditableMovementNote — the shared add/edit-note island.
 *
 * The gate is the point: the edit affordance (pencil / "Add note") must be
 * HIDDEN when canEdit is false and SHOWN when true, on both the Movements
 * table cell and the item Activity feed inline variant. Plus one success-path
 * interaction covering the optimistic update + action call.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEdit = vi.fn(async (_input: { movementId: string; note: string }) => ({
  ok: true as const,
  data: { note: 'saved note' },
}));

vi.mock('@/server/actions/movements', () => ({
  editMovementNoteAction: (input: { movementId: string; note: string }) => mockEdit(input),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

import { EditableMovementNote } from './editable-movement-note';

const MOVEMENT_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EditableMovementNote — permission gate', () => {
  it('read-only (canEdit=false) with a note shows the text but no edit affordance', () => {
    render(<EditableMovementNote movementId={MOVEMENT_ID} note="found extra in back" canEdit={false} />);

    expect(screen.getByText('found extra in back')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit note/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add note/i })).not.toBeInTheDocument();
  });

  it('read-only (canEdit=false) with no note shows an em dash and no affordance (cell)', () => {
    render(<EditableMovementNote movementId={MOVEMENT_ID} note={null} canEdit={false} />);

    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('editable (canEdit=true) with no note shows the "Add note" affordance', () => {
    render(<EditableMovementNote movementId={MOVEMENT_ID} note={null} canEdit />);

    expect(screen.getByRole('button', { name: /add note/i })).toBeInTheDocument();
  });

  it('editable (canEdit=true) with a note shows the "Edit note" pencil', () => {
    render(<EditableMovementNote movementId={MOVEMENT_ID} note="restock" canEdit />);

    expect(screen.getByText('restock')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit note/i })).toBeInTheDocument();
  });

  it('falls back to the read-only reason when there is no note (cell)', () => {
    render(
      <EditableMovementNote movementId={MOVEMENT_ID} note={null} reason="damaged" canEdit={false} />,
    );
    expect(screen.getByText('damaged')).toBeInTheDocument();
  });

  it('inline variant renders nothing when read-only and there is no note', () => {
    const { container } = render(
      <EditableMovementNote movementId={MOVEMENT_ID} note={null} canEdit={false} variant="inline" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('EditableMovementNote — edit flow', () => {
  it('adds a note: opens the editor, calls the action, and shows the saved text', async () => {
    render(<EditableMovementNote movementId={MOVEMENT_ID} note={null} canEdit />);

    fireEvent.click(screen.getByRole('button', { name: /add note/i }));
    const input = screen.getByRole('textbox', { name: /movement note/i });
    fireEvent.change(input, { target: { value: 'saved note' } });
    fireEvent.click(screen.getByRole('button', { name: /save note/i }));

    await waitFor(() => {
      expect(mockEdit).toHaveBeenCalledWith({ movementId: MOVEMENT_ID, note: 'saved note' });
    });
    // Optimistic display of the persisted value + the edit pencil now present.
    expect(await screen.findByText('saved note')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit note/i })).toBeInTheDocument();
  });
});

describe('EditableMovementNote — editor keyboard and limit', () => {
  it('Enter saves, Escape cancels, and the field takes at most 2,000 characters', async () => {
    render(<EditableMovementNote movementId={MOVEMENT_ID} note={null} canEdit />);

    fireEvent.click(screen.getByRole('button', { name: /add note/i }));
    let input = screen.getByRole('textbox', { name: /movement note/i });
    expect(input).toHaveAttribute('maxLength', '2000');
    fireEvent.change(input, { target: { value: 'not this one' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: /movement note/i })).not.toBeInTheDocument();
    expect(mockEdit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /add note/i }));
    input = screen.getByRole('textbox', { name: /movement note/i });
    fireEvent.change(input, { target: { value: 'saved note' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(mockEdit).toHaveBeenCalledWith({ movementId: MOVEMENT_ID, note: 'saved note' });
    });
  });
});

describe('EditableMovementNote — editor touch targets', () => {
  // Below sm and on a coarse pointer every Button grows an invisible 44 px
  // target around itself, and a later button's target paints over an earlier
  // one (components/ui/button.tsx). Save and Cancel sat 4 px apart, so on a
  // touch screen Cancel's target covered Save's right edge: a tap meant to
  // save closed the editor and dropped the typed note. They now sit 8 px apart,
  // enough for the 28 px feed buttons ((44 - 28) / 2) and the 32 px table ones
  // (6 px), and are 44 px buttons themselves on a phone.
  it.each(['cell', 'inline'] as const)(
    '%s editor: Save and Cancel sit 8 px apart and are 44 px on a phone',
    (variant) => {
      render(
        <EditableMovementNote movementId={MOVEMENT_ID} note="restock" canEdit variant={variant} />,
      );
      fireEvent.click(screen.getByRole('button', { name: /edit note/i }));

      const save = screen.getByRole('button', { name: /save note/i });
      const cancel = screen.getByRole('button', { name: /cancel edit/i });
      const row = save.parentElement as HTMLElement;
      expect(cancel.parentElement).toBe(row);
      expect(row).toHaveClass('gap-2');
      expect(row).not.toHaveClass('gap-1');
      expect(save).toHaveClass('max-sm:size-11');
      expect(cancel).toHaveClass('max-sm:size-11');
    },
  );
});

describe('EditableMovementNote — the table editor fits its column', () => {
  // The Movements Note column is about 240 px wide at 1280. A 224 px field
  // plus Save and Cancel pushed the table past its card, so the two buttons
  // scrolled out of sight; the table's field is 160 px, the feed's 192 px.
  it('the cell editor field is 160 px, the inline one keeps 192 px', () => {
    const { unmount } = render(
      <EditableMovementNote movementId={MOVEMENT_ID} note="restock" canEdit />,
    );
    fireEvent.click(screen.getByRole('button', { name: /edit note/i }));
    expect(screen.getByRole('textbox', { name: /movement note/i })).toHaveClass('w-40');
    unmount();

    render(
      <EditableMovementNote movementId={MOVEMENT_ID} note="restock" canEdit variant="inline" />,
    );
    fireEvent.click(screen.getByRole('button', { name: /edit note/i }));
    expect(screen.getByRole('textbox', { name: /movement note/i })).toHaveClass('w-48');
  });
});
