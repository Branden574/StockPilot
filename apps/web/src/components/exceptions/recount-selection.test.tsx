// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Multi-select "Recount selected (n)" on the Exceptions list, one exception's
 * Recount button, and "Count this item" (F1-2). The dialog itself is tested
 * in recount-dialog.test.tsx; here, what each entry point hands it:
 *   - the list offers checkboxes only inside an ENABLED selection (the
 *     server's canRecount), and the bar opens the dialog with exactly the
 *     ticked exceptions; past 200 it refuses;
 *   - Count this item names the item and the item's recountable open
 *     exceptions (so the count is linked to them); a failed read still lets
 *     the item be counted and says it will not be linked; a server "no"
 *     blocks with the manager-only reason.
 */

const dialogProps = vi.fn();
vi.mock('@/components/exceptions/recount-dialog', () => ({
  RecountDialog: (props: Record<string, unknown>) => {
    dialogProps(props);
    return props.open ? <div data-testid="dialog">{String(props.title)}</div> : null;
  },
}));
const listItemRecountTargetsAction = vi.fn();
vi.mock('@/server/actions/exceptions', () => ({
  listItemRecountTargetsAction: (...args: unknown[]) => listItemRecountTargetsAction(...args),
}));

import { CountThisItemButton } from './count-this-item-button';
import { RecountButton, RecountCheckbox, RecountSelectionProvider } from './recount-selection';

const A = '11111111-1111-4111-8111-111111111111';
const B = '33333333-3333-4333-8333-333333333333';
const ITEM = '22222222-2222-4222-8222-222222222222';

function lastDialog(): Record<string, unknown> {
  const calls = dialogProps.mock.calls;
  return calls[calls.length - 1]![0] as Record<string, unknown>;
}

beforeEach(() => vi.clearAllMocks());

describe('RecountSelectionProvider', () => {
  it('disabled: no checkboxes, no bar, no dialog', () => {
    render(
      <RecountSelectionProvider enabled={false} timeZone="UTC">
        <RecountCheckbox occurrenceId={A} label="EX-000001" />
      </RecountSelectionProvider>,
    );
    expect(screen.queryByTestId('recount-checkbox')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recount-selection-bar')).not.toBeInTheDocument();
    expect(dialogProps).not.toHaveBeenCalled();
  });

  it('a checkbox outside any selection renders nothing', () => {
    render(<RecountCheckbox occurrenceId={A} label="EX-000001" />);
    expect(screen.queryByTestId('recount-checkbox')).not.toBeInTheDocument();
  });

  it('ticking rows shows "Recount selected (n)", which opens the dialog with exactly those', async () => {
    render(
      <RecountSelectionProvider enabled timeZone="America/Los_Angeles">
        <RecountCheckbox occurrenceId={A} label="EX-000001" />
        <RecountCheckbox occurrenceId={B} label="EX-000002" />
      </RecountSelectionProvider>,
    );
    expect(screen.queryByTestId('recount-selection-bar')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Select EX-000001 to recount'));
    fireEvent.click(screen.getByLabelText('Select EX-000002 to recount'));
    fireEvent.click(screen.getByLabelText('Select EX-000002 to recount'));
    expect(screen.getByTestId('recount-selection-bar')).toHaveTextContent('1 selected');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Recount selected (1)' }));
    });
    expect(screen.getByTestId('dialog')).toHaveTextContent('Recount 1 exception');
    expect(lastDialog().occurrenceIds).toEqual([A]);
    expect(lastDialog().timeZone).toBe('America/Los_Angeles');
    // Clear empties it.
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByTestId('recount-selection-bar')).not.toBeInTheDocument();
  });

  it('refuses more than 200 at once', () => {
    const ids = Array.from({ length: 201 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    render(
      <RecountSelectionProvider enabled timeZone="UTC">
        {ids.map((id) => (
          <RecountCheckbox key={id} occurrenceId={id} label={id} />
        ))}
      </RecountSelectionProvider>,
    );
    for (const id of ids) fireEvent.click(screen.getByLabelText(`Select ${id} to recount`));
    expect(screen.getByRole('button', { name: 'Recount selected (201)' })).toBeDisabled();
    expect(screen.getByTestId('recount-selection-bar')).toHaveTextContent('at most 200');
  });
});

describe('RecountButton', () => {
  it('opens the dialog for that one exception', () => {
    render(<RecountButton occurrenceId={A} reference="EX-000042" timeZone="UTC" />);
    fireEvent.click(screen.getByTestId('recount-button'));
    expect(screen.getByTestId('dialog')).toHaveTextContent('Recount for EX-000042');
    expect(lastDialog().occurrenceIds).toEqual([A]);
  });
});

describe('CountThisItemButton', () => {
  it('names the item and its recountable open exceptions', async () => {
    listItemRecountTargetsAction.mockResolvedValue({ ok: true, canRecount: true, occurrenceIds: [A, B] });
    render(<CountThisItemButton itemId={ITEM} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('count-this-item'));
    });
    expect(listItemRecountTargetsAction).toHaveBeenCalledWith(ITEM);
    const p = lastDialog();
    expect(p.itemIds).toEqual([ITEM]);
    expect(p.occurrenceIds).toEqual([A, B]);
    expect(p.preparing).toBe(false);
    expect(p.blocked).toBeNull();
    expect(p.note).toBe('The count will be linked to this item’s 2 open exceptions.');
  });

  it('while the exceptions are read, Start waits', async () => {
    let resolve: (v: unknown) => void = () => {};
    listItemRecountTargetsAction.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<CountThisItemButton itemId={ITEM} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('count-this-item'));
    });
    expect(lastDialog().preparing).toBe(true);
    expect(lastDialog().occurrenceIds).toEqual([]);
    await act(async () => {
      resolve({ ok: true, canRecount: true, occurrenceIds: [] });
    });
    expect(lastDialog().preparing).toBe(false);
    expect(lastDialog().note).toBeNull();
  });

  it('a failed read still counts the item, and says it will not be linked', async () => {
    listItemRecountTargetsAction.mockResolvedValue({ error: { message: 'x', reason: null } });
    render(<CountThisItemButton itemId={ITEM} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('count-this-item'));
    });
    const p = lastDialog();
    expect(p.itemIds).toEqual([ITEM]);
    expect(p.occurrenceIds).toEqual([]);
    expect(p.blocked).toBeNull();
    expect(String(p.note)).toMatch(/could not be read, so the count will not be linked/);
  });

  it('the server saying this reader cannot recount blocks it with the reason', async () => {
    listItemRecountTargetsAction.mockResolvedValue({ ok: true, canRecount: false, occurrenceIds: [] });
    render(<CountThisItemButton itemId={ITEM} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('count-this-item'));
    });
    expect(String(lastDialog().blocked)).toMatch(/Only a manager/);
  });
});
