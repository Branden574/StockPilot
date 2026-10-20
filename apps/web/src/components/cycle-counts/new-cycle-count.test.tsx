// @vitest-environment happy-dom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCountSelection } from '@/lib/cycle-counts/use-count-selection';

import { NewCycleCount } from './new-cycle-count';

// The Start a count screen's scope switch (redesign M6 / P-FORM): the same two
// scopes with the same words, now a segmented switch that says which one is
// chosen. The scopes themselves are their own components; here they are stubs.

vi.mock('./selection-confirm', () => ({
  SelectionConfirm: (props: { canAssign: boolean; sportsEnabled?: boolean }) => (
    <p data-testid="selection-scope">
      selection canAssign={String(props.canAssign)} sports={String(props.sportsEnabled)}
    </p>
  ),
}));
vi.mock('./start-cycle-count-form', () => ({
  StartCycleCountForm: () => <p data-testid="warehouse-scope">warehouse</p>,
}));

const WAREHOUSES = [{ id: 'w1', name: 'Main DC' }];

function renderShell() {
  return render(<NewCycleCount warehouses={WAREHOUSES} members={[]} canAssign sportsEnabled />);
}

beforeEach(() => {
  useCountSelection.getState().clear();
});

describe('NewCycleCount scope switch', () => {
  it('opens on Whole warehouse when nothing is picked, and says so', () => {
    renderShell();
    const scope = screen.getByRole('group', { name: 'Scope' });
    expect(within(scope).getByRole('button', { name: 'Whole warehouse' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(scope).getByRole('button', { name: 'Selected items' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByTestId('warehouse-scope')).toBeInTheDocument();
  });

  it('opens on Selected items with the count when the shared store holds picks', () => {
    useCountSelection.getState().add([
      { id: 'a', sku: 'SP-A', name: 'Alpha', itemType: 'product' },
      { id: 'b', sku: 'BK-1', name: 'Algebra I', itemType: 'book' },
    ]);
    renderShell();
    const scope = screen.getByRole('group', { name: 'Scope' });
    expect(within(scope).getByRole('button', { name: 'Selected items (2)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('selection-scope')).toHaveTextContent(
      'selection canAssign=true sports=true',
    );
  });

  it('switches scope on a press, both ways', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByRole('button', { name: 'Selected items' }));
    expect(screen.getByTestId('selection-scope')).toBeInTheDocument();
    expect(screen.queryByTestId('warehouse-scope')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Whole warehouse' }));
    expect(screen.getByTestId('warehouse-scope')).toBeInTheDocument();
  });
});
