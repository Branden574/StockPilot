// @vitest-environment happy-dom
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useCountPicks, useCountSelection } from './use-count-selection';

function Probe() {
  const picks = useCountPicks();
  return <div data-testid="n">{picks.length}</div>;
}

describe('useCountPicks', () => {
  beforeEach(() => {
    useCountSelection.getState().clear();
  });

  it('renders without an infinite loop (regression for React #185)', () => {
    // The previous selector returned `Object.values(picks)` — a fresh
    // array every call — which made useSyncExternalStore loop forever and
    // React throw "Maximum update depth exceeded" (#185). If that pattern
    // ever comes back, this render hangs / throws instead of passing.
    render(<Probe />);
    expect(screen.getByTestId('n').textContent).toBe('0');
  });

  it('reflects store mutations and stays stable', () => {
    render(<Probe />);
    act(() => {
      useCountSelection.getState().add([
        { id: 'a', sku: 'A', name: 'Item A', itemType: 'product' },
        { id: 'b', sku: 'B', name: 'Book B', itemType: 'book' },
      ]);
    });
    expect(screen.getByTestId('n').textContent).toBe('2');

    act(() => {
      useCountSelection.getState().remove('a');
    });
    expect(screen.getByTestId('n').textContent).toBe('1');
  });
});
