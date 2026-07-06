import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { MultiSelectFilter } from './inventory-table';

// REGRESSION SUITE for the owner's "I had to click the filter boxes 3-4
// times" report: the option row used to nest the <button> Checkbox inside
// the row <button>, so a click landing directly ON the checkmark box fired
// both toggle handlers — a self-cancelling double-toggle React batched into
// visual nothing. The row is now the single interactive element and the box
// is a non-interactive glyph; one click = exactly one toggle, wherever it
// lands.

const OPTIONS = [
  { id: 'c1', name: 'Community Events' },
  { id: 'c2', name: 'CTE' },
];

function Harness({ onToggle }: { onToggle: (ids: Set<string>) => void }) {
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  return (
    <MultiSelectFilter
      label="Category"
      options={OPTIONS}
      selected={selected}
      onChange={(ids) => {
        onToggle(ids);
        setSelected(ids);
      }}
    />
  );
}

async function openPopover(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /filter by category/i }));
  return screen.findByRole('checkbox', { name: 'Community Events' });
}

describe('MultiSelectFilter — single-click toggling', () => {
  it('a click directly on the checkmark box toggles exactly once', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness onToggle={spy} />);
    const row = await openPopover(user);

    // The glyph is the exact pixel target the owner was aiming at.
    const glyph = row.querySelector('span[aria-hidden]');
    expect(glyph).not.toBeNull();
    await user.click(glyph as HTMLElement);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith(new Set(['c1']));
    expect(row).toHaveAttribute('aria-checked', 'true');

    // And a second click on the same box unchecks — again exactly once.
    await user.click(glyph as HTMLElement);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith(new Set());
    expect(row).toHaveAttribute('aria-checked', 'false');
  });

  it('a click on the label text toggles exactly once too', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness onToggle={spy} />);
    const row = await openPopover(user);

    await user.click(screen.getByText('Community Events'));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith(new Set(['c1']));
    expect(row).toHaveAttribute('aria-checked', 'true');
  });

  it('applies every toggle immediately (no commit-on-close) and Clear empties in one change', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness onToggle={spy} />);
    await openPopover(user);

    await user.click(screen.getByRole('checkbox', { name: 'Community Events' }));
    await user.click(screen.getByRole('checkbox', { name: 'CTE' }));
    // Both picks reported live, while the popover is STILL OPEN.
    expect(spy).toHaveBeenNthCalledWith(1, new Set(['c1']));
    expect(spy).toHaveBeenNthCalledWith(2, new Set(['c1', 'c2']));

    // Trigger badge mirrors the live selection count.
    expect(
      screen.getByRole('button', { name: /filter by category/i }),
    ).toHaveTextContent('2');

    await user.click(screen.getByRole('button', { name: /clear category/i }));
    expect(spy).toHaveBeenLastCalledWith(new Set());
  });
});
