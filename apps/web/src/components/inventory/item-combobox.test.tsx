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

// Two records can share a SKU and a name (a SKU family across warehouses).
// Mutation caught: both rows carried the same cmdk value ("sku name"), so they
// lit up together and Enter could only ever pick the first one.
describe('ItemCombobox with two records that share a SKU and a name', () => {
  const TWINS: ComboboxItem[] = [
    { id: 'dc4', sku: 'POLO-M', name: 'Polo shirt', detail: '12 on hand' },
    { id: 'cvw', sku: 'POLO-M', name: 'Polo shirt', detail: '3 on hand' },
  ];

  it('keeps them two rows: one lit at a time, and the keyboard reaches the second', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ItemCombobox items={TWINS} value={null} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /pick item/i }));
    const options = () => screen.getAllByRole('option');
    expect(options()).toHaveLength(2);
    expect(options().filter((o) => o.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    await user.keyboard('{ArrowDown}');
    const lit = options().filter((o) => o.getAttribute('aria-selected') === 'true');
    expect(lit).toHaveLength(1);
    expect(lit[0]).toHaveTextContent('3 on hand');
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('cvw');
  });

  it('still finds both by SKU or name, and never by the detail text', async () => {
    const user = userEvent.setup();
    render(<ItemCombobox items={TWINS} value={null} onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /pick item/i }));
    await user.type(screen.getByPlaceholderText(/search by sku or name/i), 'polo-m');
    expect(screen.getAllByRole('option')).toHaveLength(2);
    await user.clear(screen.getByPlaceholderText(/search by sku or name/i));
    await user.type(screen.getByPlaceholderText(/search by sku or name/i), '12 on hand');
    expect(screen.getByText(/no matches/i)).toBeInTheDocument();
  });
});

// P2.4c (re-checked on P2.2's restyled primitives): the picker is a form field
// that sits beside Select fields and the outline Create button on the PO
// import review, so its trigger takes their recipe (DESIGN-SPEC 2.4 item 3):
// the stronger --line2 border on the card fill and a visible, offset focus
// ring, never the faint hairline alone.
describe('ItemCombobox trigger', () => {
  it('is drawn as a form field, like the Select trigger beside it', () => {
    render(<ItemCombobox items={ITEMS} value={null} onChange={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: /pick item/i });
    expect(trigger).toHaveClass(
      'border',
      'border-[var(--ed-line-strong)]',
      'bg-card',
      'focus-visible:ring-2',
      'focus-visible:ring-offset-2',
      'text-[13px]',
    );
    expect(trigger).not.toHaveClass('border-border');
  });

  // An approved or canceled import shows its final mapping in a disabled
  // picker (po-import-detail.tsx), so the fade stays at 60%: the Select's 50%
  // would put the item name under 4.5:1 on the card.
  it('keeps a read-only mapping readable when disabled', () => {
    render(<ItemCombobox items={ITEMS} value={ITEMS[0]!.id} onChange={vi.fn()} disabled />);
    const trigger = screen.getByRole('button');
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveClass('disabled:opacity-60');
    expect(trigger).not.toHaveClass('disabled:opacity-50');
  });
});
