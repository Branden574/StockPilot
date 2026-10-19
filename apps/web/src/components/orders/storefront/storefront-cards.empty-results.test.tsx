import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EmptyResults } from './storefront-cards';

// The search with no match is the shared no-match panel now (P2.6 StatePanel),
// with the storefront's own words and its one way out.
describe('EmptyResults', () => {
  it('is the shared no-match panel with the same words and the same button', () => {
    const onClear = vi.fn();
    const { container } = render(<EmptyResults query="polo" onClear={onClear} />);

    const panel = container.querySelector('[data-slot="state-panel"]');
    expect(panel?.getAttribute('data-state-kind')).toBe('no-match');
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Nothing matches “polo”');
    expect(
      screen.getByText('Try a different name, SKU or category — or clear your filters.'),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Clear search & filters' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('with no words typed, says nothing matches those filters', () => {
    render(<EmptyResults query="" onClear={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe(
      'Nothing matches those filters',
    );
  });
});
