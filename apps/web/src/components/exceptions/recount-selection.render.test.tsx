// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * A tick re-renders only the row whose box changed (P4.A3). The selection is
 * a store the rows subscribe to one by one; when it was a context holding the
 * Set, every tick re-rendered every checkbox on the list, and 201 ticks took
 * 30 s in recount-selection.test.tsx (the Open list can hold 1,000 rows).
 */

const renders = vi.hoisted(() => new Map<string, number>());
vi.mock('@/components/ui/checkbox', () => ({
  Checkbox: (props: { checked: boolean; label: string; onCheckedChange: () => void }) => {
    renders.set(props.label, (renders.get(props.label) ?? 0) + 1);
    return (
      <button
        type="button"
        role="checkbox"
        aria-checked={props.checked}
        aria-label={props.label}
        onClick={props.onCheckedChange}
      />
    );
  },
}));
vi.mock('@/components/exceptions/recount-dialog', () => ({ RecountDialog: () => null }));
vi.mock('@/server/actions/exceptions', () => ({}));

import { RecountCheckbox, RecountSelectionProvider } from './recount-selection';

describe('RecountSelectionProvider re-renders', () => {
  it('ticking one row re-renders that row only', () => {
    const ids = ['a', 'b', 'c', 'd'];
    render(
      <RecountSelectionProvider enabled timeZone="UTC">
        {ids.map((id) => (
          <RecountCheckbox key={id} occurrenceId={id} label={id} />
        ))}
      </RecountSelectionProvider>,
    );
    const before = new Map(renders);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select b to recount' }));
    expect(screen.getByRole('checkbox', { name: 'Select b to recount' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    for (const id of ['a', 'c', 'd']) {
      const name = `Select ${id} to recount`;
      expect(renders.get(name), name).toBe(before.get(name));
    }
    expect(renders.get('Select b to recount')).toBeGreaterThan(before.get('Select b to recount')!);
    expect(screen.getByTestId('recount-selection-bar')).toHaveTextContent('1 selected');
  });
});
