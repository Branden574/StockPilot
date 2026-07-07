import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ItemCombobox, type ComboboxItem } from './item-combobox';

const ITEMS: ComboboxItem[] = [
  // detail deliberately set to an on-hand-style string: it must render as
  // display metadata but NEVER participate in search matching.
  { id: 'i1', sku: 'BK-001', name: 'Blue Widget', detail: '250 on hand' },
  { id: 'i2', sku: 'BK-250', name: 'Red Widget', detail: null },
];

async function openCombobox() {
  const user = userEvent.setup();
  render(<ItemCombobox items={ITEMS} value={null} onChange={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: /pick item/i }));
  return user;
}

describe('ItemCombobox search haystack (issue: on-hand counts polluted matching)', () => {
  it('matches by SKU and by name', async () => {
    const user = await openCombobox();
    await user.type(screen.getByPlaceholderText(/search by sku or name/i), 'Blue');
    expect(screen.getByText('Blue Widget')).toBeInTheDocument();
    expect(screen.queryByText('Red Widget')).not.toBeInTheDocument();
  });

  it('does NOT match against the detail text — typing "250" only hits the SKU that contains it', async () => {
    const user = await openCombobox();
    await user.type(screen.getByPlaceholderText(/search by sku or name/i), '250');
    // BK-250 matches via its SKU; Blue Widget's "250 on hand" detail must NOT match.
    expect(screen.getByText('Red Widget')).toBeInTheDocument();
    expect(screen.queryByText('Blue Widget')).not.toBeInTheDocument();
  });

  it('a query that only exists in detail text yields no matches', async () => {
    const user = await openCombobox();
    await user.type(screen.getByPlaceholderText(/search by sku or name/i), 'on hand');
    expect(screen.getByText(/no matches/i)).toBeInTheDocument();
  });
});
