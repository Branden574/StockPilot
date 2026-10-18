import { render, screen } from '@testing-library/react';
import { Boxes } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { StatePanel, type StateKind } from './state-panel';

const KINDS: StateKind[] = ['empty', 'no-match', 'forbidden', 'module-off', 'failed', 'offline'];

describe('StatePanel', () => {
  it.each(KINDS)('renders the %s state with the page`s own words and nothing invented', (kind) => {
    const { container } = render(
      <StatePanel kind={kind} title="No items match your search" description="Try another SKU." />,
    );
    const panel = container.querySelector('[data-slot="state-panel"]')!;
    expect(panel).toHaveAttribute('data-state-kind', kind);
    expect(
      screen.getByRole('heading', { level: 2, name: 'No items match your search' }),
    ).toBeInTheDocument();
    expect(panel.textContent).toBe('No items match your searchTry another SKU.');
    expect(container.querySelector('[data-slot="state-panel-icon"]')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });

  it('is the page`s h1 when it replaces the whole page', () => {
    render(
      <StatePanel kind="module-off" size="page" headingLevel={1} title="Rentals isn't enabled" />,
    );
    expect(
      screen.getByRole('heading', { level: 1, name: "Rentals isn't enabled" }),
    ).toBeInTheDocument();
  });

  it('renders the page`s action as given', () => {
    render(
      <StatePanel
        kind="no-match"
        title="No items match your search"
        action={<button type="button">Clear search</button>}
      />,
    );
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeInTheDocument();
  });

  it('adds no live role unless the page asks, then status (polite) or alert (assertive)', () => {
    const { container, rerender } = render(<StatePanel kind="failed" title="Couldn't load" />);
    const panel = () => container.querySelector('[data-slot="state-panel"]')!;
    expect(panel()).not.toHaveAttribute('role');
    rerender(<StatePanel kind="offline" title="You're offline" live="polite" />);
    expect(screen.getByRole('status')).toBe(panel());
    rerender(<StatePanel kind="failed" title="Couldn't load" live="assertive" />);
    expect(screen.getByRole('alert')).toBe(panel());
  });

  it('takes another icon, or none for a plain line inside a table', () => {
    const { container, rerender } = render(
      <StatePanel kind="empty" icon={Boxes} title="No items yet" />,
    );
    expect(container.querySelector('[data-slot="state-panel-icon"] svg')).not.toBeNull();
    rerender(
      <StatePanel
        kind="no-match"
        icon={null}
        surface="plain"
        title="No items match your filters."
      />,
    );
    expect(container.querySelector('[data-slot="state-panel-icon"]')).toBeNull();
    expect(container.querySelector('[data-slot="state-panel"]')).not.toHaveClass('border');
  });

  it('draws the quiet card by default, and nothing around it when plain', () => {
    const { container, rerender } = render(<StatePanel kind="empty" title="No items yet" />);
    const panel = () => container.querySelector('[data-slot="state-panel"]')!;
    expect(panel()).toHaveClass('border', 'rounded-lg', 'bg-card');
    rerender(<StatePanel kind="empty" title="No items yet" surface="plain" />);
    expect(panel()).not.toHaveClass('bg-card');
  });
});
