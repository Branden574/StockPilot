import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

// The Add more sizes dialog from an edit page (P4.A1, matrix W-IT-03): its
// size chips are the form's chips, 44 px on a phone and with the shared chip's
// touch area on a coarse pointer (P2.2 hand-off), and picking a size still
// adds its own On hand box.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/server/actions/inventory', () => ({
  bulkCreateSizedVariantsAction: vi.fn(),
}));

import { AddSizedVariantsButton } from './add-sized-variants-button';

const SOURCE = {
  name: 'Team Jersey - M',
  sku: 'JER-M',
  barcode: null,
  description: null,
  categoryId: 'cat-1',
  supplierId: null,
  warehouseId: 'wh-1',
  charterId: null,
  primaryLocationId: null,
  binLocation: null,
  retailPrice: 0,
  unitCost: 0,
  reorderPoint: 0,
  reorderQuantity: 0,
};

describe('AddSizedVariantsButton: the size chips on a touch screen', () => {
  it('are 44 px on a phone, carry the shared touch area on a coarse pointer, and still pick a size', async () => {
    const user = userEvent.setup();
    render(<AddSizedVariantsButton source={SOURCE} />);
    await user.click(screen.getByRole('button', { name: 'Add more sizes' }));
    const dialog = await screen.findByRole('dialog');
    const group = within(dialog).getByRole('group', { name: 'Sizes' });
    expect((group.getAttribute('class') ?? '').split(/\s+/)).toContain('gap-2');
    const large = within(group).getByRole('button', { name: 'L' });
    expect((large.getAttribute('class') ?? '').split(/\s+/)).toEqual(
      expect.arrayContaining([
        'relative',
        'before:min-h-11',
        'before:min-w-11',
        "max-sm:before:content-['']",
        "pointer-coarse:before:content-['']",
        'max-sm:h-11',
        'max-sm:min-w-11',
      ]),
    );
    expect(large).toHaveAttribute('aria-pressed', 'false');
    await user.click(large);
    expect(large).toHaveAttribute('aria-pressed', 'true');
    expect(
      within(dialog).getByRole('spinbutton', { name: 'On hand for size L' }),
    ).toBeInTheDocument();
  });
});
